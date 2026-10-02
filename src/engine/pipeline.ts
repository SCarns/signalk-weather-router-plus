/**
 * One leg of a route, from the request's parameters to the finished
 * waypoints: corridor from the global water grid (or the per-route
 * skeleton inside the box), land mask, the leg's forecast and current
 * areas, the isochrone search with its retry without automatic vias,
 * RDP simplification, the shortcut smoother, re-enrichment and
 * re-validation, the forecast-horizon warning. The route worker and the
 * CLI both run this; what differs between them (where the forecast comes
 * from, how progress is shown) comes in through `LegPipelineInputs`.
 *
 * Extracted from plugin/worker.ts (docs/plans/structural-cleanup.md,
 * phase 3.5); the progress messages are the worker's.
 */

import { HOUR_MS, HOUR_S, NM_M } from '../geo/units';
import { bboxFromLonLat, bboxHeight, bboxWidth, type BBox } from '../geo/geodesy';
import type { LandMask } from '../geo/landmask';
import type { WaterGrid } from '../geo/watergrid';
import type { PolarDiagram } from '../vessel/polar';
import type { VesselParams } from '../vessel/vessel';
import { CorridorError, mergeVias, planCorridor, type ChainVia, type Corridor } from './corridor';
import { NoWind, type CurrentSource, type WindSource } from './environment';
import type { ModePolicy } from './legsim';
import { legLabel, type LegPlan } from './multileg';
import { enrichWaypoints, OceanPropagator, RouteCancelled, ViasNotCrossedError, type PropagatorOptions } from './propagator';
import type { ProgressFn } from './progress';
import { recomputePerWaypointMetadata, type Route, type StageFront } from './route';
import { rdpSimplify, recomputeTotals, revalidateLand, shortcutSmoother } from './smoother';

/** A forecast for a leg: a wind source that knows the range of time it covers. */
export interface LegWind extends WindSource {
  validRange: [Date, Date];
}

export interface LegPipelineInputs {
  /** The global water grid for the corridor search, or null (per-route skeleton inside the box). */
  waterGrid: WaterGrid | null;
  allowCanals: boolean;
  /** The land mask for a box (the corridor's box, or the box around the leg's ends). */
  landFor: (bbox: BBox) => LandMask;
  stages: number;
  propagator: Omit<PropagatorOptions, 'stages'>;
  vessel: VesselParams;
  polar: PolarDiagram | null;
  sim: { modePolicy: ModePolicy; sailThreshMs: number; simStepM: number; maxWindMs?: number; maxSwhM?: number };
  /** RDP tolerance, metres (0 = off); the shortcut smoother and its time tolerance (ratio). */
  simplifyM: number;
  smoother: boolean;
  smootherTolerance: number;
  /** Load the leg's forecast (and current) areas for the box; the forecast for the leg, or null for calm wind. */
  loadAreas: (bbox: BBox, what: string) => Promise<LegWind | null>;
  /** After a leg of a multi-leg route: the areas go with the leg. */
  releaseAreas?: () => void;
  /** The current source for the leg (after loadAreas), with the names of the stacked sources, or null when there are none. */
  currents: () => { source: CurrentSource; names: string[] | null };
  multi: boolean;
  progress: ProgressFn;
  shouldCancel: () => boolean;
  /** Each stage's front, for display. */
  onFrontier?: (legIndex: number, front: StageFront) => void;
  /** The per-leg summary line of a multi-leg route. */
  log?: (message: string) => void;
}

export async function runLegPipeline(
  inp: LegPipelineInputs,
  plan: LegPlan,
  legIndex: number,
  legStart: [number, number],
  legDeparture: Date
): Promise<Route> {
  const { progress, shouldCancel, multi, stages } = inp;
  const legEnd = plan.end;
  // A collapsed approximate run passes through its waypoint circles (plan.vias).
  const chain: [number, number][] = [legStart, ...plan.vias.map(v => [v.lon, v.lat] as [number, number]), legEnd];
  const tag = multi ? `${legLabel(plan)} ` : '';
  // Corridor from the global water grid: its box (not the endpoints') sets
  // the land raster, SMOC area and forecast crop.
  let corridor: Corridor | null = null;
  let corridorFallback = false;
  if (inp.waterGrid) {
    inp.waterGrid.setCanalsAllowed(inp.allowCanals);
    progress(0, 0, `${tag}corridor: searching the global 0.02° water grid (canals ${inp.allowCanals ? 'allowed' : 'blocked'})`);
    try {
      corridor = planCorridor(inp.waterGrid, chain, {
        landFor: inp.landFor,
        stages,
        onProgress: (_s, _t, m) => progress(0, 0, `${tag}corridor: ${m}`),
        shouldCancel,
      });
      const cst = corridor.stats;
      progress(
        0,
        0,
        `${tag}corridor: ${(corridor.lengthM / NM_M).toFixed(1)} nm, A* ${cst.astarMs} ms (${cst.expanded} cells), ${cst.refines} local refinement(s), ${cst.reroutes} re-route(s)`
      );
      for (const v of corridor.autoVias) progress(0, 0, `${tag}corridor: auto via at ${v.name}, width ${(v.widthM / 1000).toFixed(1)} km`);
    } catch (err) {
      if (shouldCancel()) throw new RouteCancelled();
      if (!(err instanceof CorridorError) || err.fatal) throw err;
      progress(
        0,
        0,
        `WARNING: ${tag}corridor search failed (${err.message}); using the per-route skeleton inside the box around ${multi ? "the leg's ends" : 'start and end'}`
      );
      corridor = null;
      corridorFallback = true;
    }
  }
  let bbox: BBox;
  if (corridor) {
    bbox = corridor.bbox;
  } else {
    bbox = bboxFromLonLat(
      chain.map(p => p[0]),
      chain.map(p => p[1]),
      1.0
    );
    if (bboxWidth(bbox) > 120 || bboxHeight(bbox) > 90) throw new Error('route bounding box is too large (max 120° × 90°)');
  }
  const land = corridor ? corridor.land : inp.landFor(bbox);
  if (shouldCancel()) throw new RouteCancelled();
  // Forecast and SMOC areas per leg (measured on brain: the same time as
  // one area for all legs, and at most the same memory).
  const legWind = await inp.loadAreas(bbox, multi ? `${tag}area` : 'route area');
  const { source: current, names: currentNames } = inp.currents();
  if (currentNames && plan.index === 0) progress(0, 0, `currents: ${currentNames.join(' > ')}`);

  const prop = new OceanPropagator(land, { ...inp.propagator, stages });
  const t = Date.now();
  const vias: ChainVia[] = corridor ? mergeVias(plan.vias, corridor.autoVias) : plan.vias;
  const hasAuto = vias.some(v => v.auto);
  const legArgs = {
    start: legStart,
    end: legEnd,
    departureTime: legDeparture,
    vessel: inp.vessel,
    polar: inp.polar,
    wind: legWind ?? undefined,
    current,
    modePolicy: inp.sim.modePolicy,
    sailThreshMs: inp.sim.sailThreshMs,
    maxWindMs: inp.sim.maxWindMs,
    maxSwhM: inp.sim.maxSwhM,
    forecastEndMs: legWind ? legWind.validRange[1].getTime() : undefined,
    simStepM: inp.sim.simStepM,
    vias: vias.length ? vias : undefined,
    corridor: corridor ? { skeleton: corridor.skeleton, widthM: corridor.widthM } : undefined,
    arrivalRadiusM: plan.arrivalRadiusM,
    snapToExact: plan.snapToExact,
    onProgress: multi ? (st: number, tot: number, m: string) => progress(st, tot, `${tag}${m}`) : progress,
    // Each stage's front, streamed for the web app's display (never stored with the job).
    onFrontier: inp.onFrontier ? (front: StageFront) => inp.onFrontier!(legIndex, front) : undefined,
    shouldCancel,
  };
  let r: Route;
  try {
    r = prop.computeRoute(legArgs);
  } catch (err) {
    // The corridor's automatic vias are only guidance: when the search
    // finds another passage (e.g. The Race instead of the gap past
    // Gardiners Island) no branch crosses them. Retry without them,
    // keeping the waypoint circles of a collapsed run.
    if (!(err instanceof ViasNotCrossedError) || !hasAuto) throw err;
    progress(
      0,
      0,
      `${tag}no branch went through the auto via(s) at ${vias
        .filter(v => v.auto)
        .map(v => v.name ?? 'a narrow passage')
        .join(', ')}; routing again without them`
    );
    r = prop.computeRoute({ ...legArgs, vias: plan.vias.length ? plan.vias : undefined });
  }
  // Simplification (parent order: RDP, then the shortcut smoother).
  const nRdp = rdpSimplify(r, land, inp.simplifyM);
  if (nRdp) recomputeTotals(r);
  const nSm = inp.smoother
    ? shortcutSmoother(r, {
        land,
        vessel: inp.vessel,
        polar: inp.polar,
        wind: legWind ?? new NoWind(),
        current,
        sim: {
          modePolicy: legArgs.modePolicy,
          sailThreshMs: legArgs.sailThreshMs,
          simStepM: legArgs.simStepM,
          maxWindMs: legArgs.maxWindMs,
          maxSwhM: legArgs.maxSwhM,
        },
        tolerance: inp.smootherTolerance,
      })
    : 0;
  if (nSm) r.smootherDrops = nSm;
  if (nRdp || nSm) {
    enrichWaypoints(r.waypoints, legWind ?? new NoWind(), current);
    recomputePerWaypointMetadata(r);
    revalidateLand(r, land);
    progress(
      0,
      0,
      `${tag}simplified: ${nRdp} waypoint(s) within ${inp.simplifyM} m of a straight line, ${nSm} replaced by straight shortcuts; ${r.waypoints.length} left`
    );
  }
  if (legWind) {
    const lastValid = legWind.validRange[1].getTime();
    r.forecastValidToMs = lastValid;
    const arrival = r.waypoints[r.waypoints.length - 1].time.getTime();
    if (arrival > lastValid) {
      r.forecastHorizonExceededS = (arrival - lastValid) / 1000;
      const beyond = r.waypoints.filter(w => w.time.getTime() > lastValid).length;
      const limited = legArgs.maxWindMs !== undefined || legArgs.maxSwhM !== undefined;
      if (limited) r.limitsBeyondForecast = true;
      progress(
        0,
        0,
        `WARNING: ${multi ? `${legLabel(plan)} ` : ''}arrival is ${((arrival - lastValid) / HOUR_MS).toFixed(1)} h after the last forecast step (${legWind.validRange[1].toISOString().slice(0, 16).replace('T', ' ')} UTC); the last ${beyond} leg${beyond === 1 ? '' : 's'} ran on conditions held at that step${limited ? ', and the wind/wave limit was checked against those held conditions' : ''}. A longer forecast horizon (Settings) covers more of the passage`
      );
    }
  }
  if (currentNames) r.currentSources = currentNames;
  if (corridorFallback) r.corridorFallback = true;
  if (multi)
    inp.log?.(
      `${tag}${r.waypoints.length} waypoints, ${(r.totalDistanceM / NM_M).toFixed(1)} nm, ${(r.totalTimeS / HOUR_S).toFixed(1)} h, ${Date.now() - t} ms`
    );
  if (multi) inp.releaseAreas?.();
  return r;
}
