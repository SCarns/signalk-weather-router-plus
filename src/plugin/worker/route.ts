/**
 * Route worker: one route request, leg by leg (corridor → propagator → smoothing), with its forecast and SMOC areas.
 *
 * Split from plugin/worker.ts (docs/plans/structural-cleanup.md, phase
 * 2.2): the same functions with the worker's state passed explicitly
 * instead of module-level variables.
 */

import { HOUR_S, NM_M } from '../../geo/units';
import { runLegPipeline, type LegPipelineInputs } from '../../engine/pipeline';
import * as path from 'node:path';
import { ForecastStore } from '../../data/forecast';
import { loadForecastForBBox, resolveCycle } from '../../data/loader';
import { type WindowOptions } from '../../data/decoded';
import { checkRouteForecastMemory } from '../memguard';
import { type BBox, bboxFromLonLat, bboxHeight, bboxWidth, haversineDistanceM } from '../../geo/geodesy';
import { LandMask } from '../../geo/landmask';
import { releaseMemory } from '../../util/gc';
import { NoCurrent } from '../../engine/environment';
import { RouteCancelled } from '../../engine/propagator';
import { nearestExactWater, waterAround } from '../../engine/corridor';
import { DEFAULT_PRECISION, legLabel, type LegPlan, routeMultiLeg, type Stop, validateLegOptions } from '../../engine/multileg';
import { type Route, routeToGeoJSON, routeToSignalKRoute, skeletonToGeoJSON, type StageFront, type StopSnap } from '../../engine/route';
import { PolarDiagram } from '../../vessel/polar';
import { loadPolarCached, resolvePolarPath } from '../polars';

import { routeVessel } from '../config';
import { type RouteRequest, type RouteSummary } from '../protocol';
import { requireInit } from './state';
import { extraParams, readWindow, releaseWindow } from './forecast';
import { landMaskFor } from './landgrid';
import { rebuildStack } from './currents';
import type { WorkerState } from './state';

export function validateRequest(r: RouteRequest): void {
  const pt = (p: { lat: number; lon: number } | undefined, name: string): void => {
    if (!p || typeof p.lat !== 'number' || typeof p.lon !== 'number' || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) {
      throw new Error(`${name} must be {lat, lon} numbers`);
    }
    if (p.lat < -90 || p.lat > 90 || p.lon < -180 || p.lon > 360) throw new Error(`${name} out of range`);
  };
  pt(r.start, 'start');
  pt(r.end, 'end');
  (r.waypoints ?? []).forEach((w, i) => pt(w, `waypoints[${i}]`));
  if (r.mode && !['sail_max', 'fastest', 'motor'].includes(r.mode))
    throw new Error(`mode must be sail_max, fastest or motor (got ${r.mode})`);
  if (r.departure && Number.isNaN(Date.parse(r.departure))) throw new Error(`departure "${r.departure}" is not an ISO 8601 date`);
  const legErr = validateLegOptions(r.precision, r.arrival_radius_m, r.waypoints);
  if (legErr) throw new Error(legErr);
}

/** A stage front as sent: points [lon, lat, timeMs, viaCount], best [lon, lat]. */
export function compactFront(f: StageFront): { stage: number; total: number; points: number[][]; best: number[][] } {
  return { stage: f.stage, total: f.totalStages, points: f.points.map(p => [p.lon, p.lat, p.timeMs, p.viaCount]), best: f.best };
}

/** Fields the engine samples: wind (at, atMany) and waves (wavesAt). */
const ROUTE_PARAMS = ['10u', '10v', 'swh', 'mwp', 'mwd'];

/**
 * Degrees added around the corridor box for the route's forecast area.
 * The engine can sample outside the land raster's box (outside it is
 * water to the land test); inside this margin every sample is exactly
 * the global forecast's value, beyond it the value of the area's edge.
 */
const ROUTE_FORECAST_MARGIN_DEG = 5;

export async function route(st: WorkerState, id: string, request: RouteRequest): Promise<void> {
  const { config: cfg, client: cl } = requireInit(st);
  Atomics.store(st.cancelFlag, 0, 0);
  const shouldCancel = (): boolean => Atomics.load(st.cancelFlag, 0) === 1;
  const progress = (stage: number, total: number, message: string): void => st.send({ type: 'progress', id, stage, total, message });
  try {
    validateRequest(request);
    const start: [number, number] = [request.start.lon, request.start.lat];
    const end: [number, number] = [request.end.lon, request.end.lat];
    // Waypoints are leg ends (engine/multileg.ts): each leg is its own route.
    const stops: Stop[] = [
      { lon: start[0], lat: start[1] },
      ...(request.waypoints ?? []).map(w => ({ lon: w.lon, lat: w.lat, radiusM: w.radius_m })),
      { lon: end[0], lat: end[1] },
    ];
    const multi = stops.length > 2;
    const stages = request.stages ?? cfg.routing.stages;
    // A point on land according to the exact coastline polygons (a drawn
    // point a few metres inside the shore, a pier), or closer than
    // SNAP_CLEAR_M to the shore, is moved to the nearest point with that
    // much water around it, within SNAP_MAX_M, and reported in the log and
    // in the route (the original stays beside the anchor). The clearance
    // matters: the search tests legs against a land raster whose finest
    // cell is 0.0005° (about 55 m), so a point 50 m off the shore sits in
    // a land cell and no final leg to it is ever clear (job 6ea0c875, the
    // East River: "boxed in … 0 km from the destination"). Further than
    // SNAP_MAX_M is an error that names the point.
    const snaps: StopSnap[] = [];
    {
      const SNAP_MAX_M = 1000;
      const SNAP_CLEAR_M = 150;
      const label = (i: number): string =>
        i === 0 ? 'the start point' : i === stops.length - 1 ? 'the destination' : `your point ${i + 1} of ${stops.length} (waypoint ${i})`;
      const bbox = bboxFromLonLat(
        stops.map(s => s.lon),
        stops.map(s => s.lat),
        0.05
      );
      // Polygons only matter here; a coarse raster keeps the build cheap.
      const land = LandMask.fromShapefiles(cfg.landShapefiles, bbox, { resolutionDeg: 0.05 });
      for (let i = 0; i < stops.length; i++) {
        const s = stops[i];
        if (!land.hasPolygons || waterAround(land, s.lon, s.lat, SNAP_CLEAR_M)) continue;
        const why = land.isLandExact(s.lon, s.lat) ? 'is on land' : `is within ${SNAP_CLEAR_M} m of the shore`;
        const near = nearestExactWater(land, s.lon, s.lat, SNAP_MAX_M, SNAP_CLEAR_M);
        if (!near) {
          throw new Error(
            `${label(i)}, at ${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}, ${why} according to the coastline data, with no open water (${SNAP_CLEAR_M} m clear of the shore) within ${SNAP_MAX_M} m; move it into open water`
          );
        }
        const d = haversineDistanceM(s.lon, s.lat, near[0], near[1]);
        snaps.push({ index: i, original: [s.lon, s.lat], anchor: [near[0], near[1]], distanceM: d });
        stops[i] = { ...s, lon: near[0], lat: near[1] };
        progress(
          0,
          0,
          `${label(i)} ${why} according to the coastline data; moved ${d.toFixed(0)} m to open water at ${near[1].toFixed(4)}, ${near[0].toFixed(4)} (route points keep ${SNAP_CLEAR_M} m of water around them)`
        );
      }
      if (snaps.length) {
        start[0] = stops[0].lon;
        start[1] = stops[0].lat;
        end[0] = stops[stops.length - 1].lon;
        end[1] = stops[stops.length - 1].lat;
      }
    }

    const vessel = routeVessel(cfg, request.vessel);
    // Per-route polar: a library token from GET /api/polars, else the configured default.
    let routePolar: PolarDiagram | null = st.polar;
    let polarLabel: string | null = cfg.polarFile ? path.basename(cfg.polarFile) : null;
    if (request.vessel?.polar) {
      const file = resolvePolarPath(
        { polarFile: cfg.polarFile, polarsDir: cfg.polarsDir, userDir: cfg.polarUserDir },
        request.vessel.polar
      );
      if (file) {
        routePolar = loadPolarCached(file);
        polarLabel = path.basename(file);
        st.log('info', `job ${id}: polar ${polarLabel} (${routePolar.twa.length} TWA × ${routePolar.tws.length} TWS)`);
      }
    }
    if (routePolar && vessel.polarPerformance !== 1) {
      routePolar = routePolar.scaled(vessel.polarPerformance);
      st.log('info', `job ${id}: polar performance ${(vessel.polarPerformance * 100).toFixed(0)}%`);
    }
    if (routePolar && cfg.routing.noGoMinAngleDeg > 0) {
      const floored = routePolar.withNoGoFloor(cfg.routing.noGoMinAngleDeg);
      if (floored !== routePolar) {
        routePolar = floored;
        progress(0, 0, `polar: rows closer than ${cfg.routing.noGoMinAngleDeg}° to the wind ignored (tightest sailable angle, Settings)`);
      }
    }
    const departureMs = request.departure ? Date.parse(request.departure) : Date.now();
    const useForecast = !request.no_forecast && request.mode !== 'motor';
    if (request.mode !== 'motor' && request.no_forecast) progress(0, 0, 'no_forecast set: routing with calm wind');
    let wind: ForecastStore | null = null;
    let cycleLabel: string | undefined;

    // Forecast area and SMOC area for a box, held until releaseAreas().
    const loadAreas = async (bbox: BBox, what: string): Promise<ForecastStore | null> => {
      if (useForecast) {
        // The route area of the forecast: the corridor box plus a margin, the
        // fields the engine reads, every step. Held only while this route runs.
        const area = expandBBox(bbox, ROUTE_FORECAST_MARGIN_DEG);
        if (st.run) {
          const opts: WindowOptions = { bbox: area, params: ROUTE_PARAMS, marginCells: 1 };
          const need = st.run.windowBytes(opts);
          const mem = checkRouteForecastMemory(need, cfg.forecast.memoryHeadroomBytes);
          if (!mem.ok) throw new Error(mem.message);
          const t0 = Date.now();
          const store = await readWindow(st, `job ${id} ${what}`, opts);
          st.routeWindow = store;
          st.send({ type: 'forecast-memory', memory: { ...st.forecastMemory } });
          progress(
            0,
            0,
            `forecast: read the ${what} (${bboxWidth(area).toFixed(1)}° × ${bboxHeight(area).toFixed(1)}°, ${store.steps.length} steps, ${store.meta.params.join('/')}) from the decoded run: ${(store.bytes() / 1e6).toFixed(1)} MB in ${Date.now() - t0} ms`
          );
          wind = store;
        } else {
          // No decoded run yet (first boot, the data worker is still decoding).
          progress(0, 0, 'no decoded forecast run yet; decoding a route-specific forecast crop from the GRIB disk cache');
          const cycle = (
            await resolveCycle(cl, cfg.forecast.horizonS, {
              extraAtmParams: extraParams(cfg),
              log: m => st.log('info', `job ${id} forecast: ${m}`),
            })
          ).cycle;
          const store = await loadForecastForBBox(cl, area, {
            horizonS: cfg.forecast.horizonS,
            cycle,
            extraAtmParams: extraParams(cfg),
            shouldCancel,
            log: m => st.log('debug', `job ${id} forecast: ${m}`),
          });
          st.forecastMemory.heldBytes += store.bytes();
          st.routeWindow = store;
          st.send({ type: 'forecast-memory', memory: { ...st.forecastMemory } });
          wind = store;
        }
        cycleLabel = wind.meta.cycleTime.toISOString();
      }
      if (st.smoc && !request.no_currents) {
        // SMOC for the box over the currents window from departure, if the resident area does not cover it.
        const src = st.smoc;
        const steps = src.stepsBetween(departureMs, Math.max(departureMs, Date.now() + src.settings.horizonS * 1000));
        if (steps.length) {
          progress(0, 0, `currents: checking CMEMS SMOC coverage of the ${what}`);
          try {
            await src.ensure(bbox, steps, { reason: `job ${id} ${what}`, shouldCancel });
          } catch (err) {
            if (shouldCancel()) throw new RouteCancelled();
            progress(
              0,
              0,
              `WARNING: CMEMS SMOC not loaded for the ${what} (${(err as Error).message}); lower-priority current sources are used there`
            );
          }
          rebuildStack(st);
        }
      }
      if (shouldCancel()) throw new RouteCancelled();
      return wind;
    };
    const releaseAreas = (): void => {
      if (st.routeWindow) {
        releaseWindow(st, st.routeWindow);
        st.routeWindow = null;
      }
      wind = null;
      if (st.smoc) st.smoc.trimOnDemand(0);
      rebuildStack(st);
      releaseMemory();
      st.send({ type: 'forecast-memory', memory: { ...st.forecastMemory } });
    };

    const legOne = async (plan: LegPlan, legStart: [number, number], legDeparture: Date): Promise<Route> => {
      try {
        return await legRoute(plan, legStart, legDeparture);
      } catch (err) {
        if (multi && err instanceof Error && !(err instanceof RouteCancelled) && !shouldCancel())
          err.message = `${legLabel(plan)}: ${err.message}`;
        throw err;
      }
    };
    let legCounter = 0;
    const pipeline: LegPipelineInputs = {
      waterGrid: st.waterGrid,
      allowCanals: cfg.routing.allowCanals,
      landFor: b => landMaskFor(st, b, cfg.routing.landRasterMaxCells, cfg.landShapefiles),
      stages,
      propagator: {
        subsectors: cfg.routing.subsectors,
        headings: cfg.routing.headings,
        headingIncrementDeg: cfg.routing.headingIncrementDeg,
      },
      vessel,
      polar: routePolar,
      sim: {
        modePolicy: request.mode ?? 'sail_max',
        sailThreshMs: request.sail_thresh_ms ?? cfg.routing.sailThreshMs,
        simStepM: cfg.routing.simStepM,
        maxWindMs: request.max_wind_ms ?? cfg.routing.maxWindMs ?? undefined,
        maxSwhM: request.max_swh_m ?? cfg.routing.maxSwhM ?? undefined,
      },
      simplifyM: request.simplify_m ?? cfg.routing.simplifyM,
      smoother: request.smoother ?? cfg.routing.smoother,
      smootherTolerance: request.smoother_tolerance ?? cfg.routing.smootherTolerance,
      loadAreas,
      releaseAreas,
      currents: () =>
        request.no_currents || st.stack.isEmpty
          ? { source: new NoCurrent(), names: null }
          : { source: st.stack, names: st.stack.sources.map(s => s.name) },
      multi,
      progress,
      shouldCancel,
      // Each stage's front, streamed for the web app's display (never stored with the job).
      onFrontier: (leg, front) => st.send({ type: 'frontier', id, leg, ...compactFront(front) }),
      log: m => st.log('info', `job ${id}: ${m}`),
    };
    const legRoute = (plan: LegPlan, legStart: [number, number], legDeparture: Date): Promise<Route> =>
      runLegPipeline(pipeline, plan, legCounter++, legStart, legDeparture);

    const t = Date.now();
    const result = await routeMultiLeg({
      stops,
      departureTime: new Date(departureMs),
      precision: request.precision,
      arrivalRadiusM: request.arrival_radius_m,
      runLeg: legOne,
      onProgress: m => progress(0, 0, m),
    });
    if (cycleLabel) result.forecastCycle = cycleLabel;
    if (snaps.length) result.snaps = snaps;
    if (!request.no_currents && !st.stack.isEmpty) result.currentSources = st.stack.sources.map(s => s.name);
    const name =
      request.name && request.name.trim()
        ? request.name.trim()
        : `${cfg.publish.routeNamePrefix} ${request.start.lat.toFixed(2)},${request.start.lon.toFixed(2)} → ${request.end.lat.toFixed(2)},${request.end.lon.toFixed(2)}`;
    const wps = result.waypoints;
    const summary: RouteSummary = {
      total_distance_m: result.totalDistanceM,
      total_time_s: result.totalTimeS,
      sailing_time_s: result.sailingTimeS,
      motoring_time_s: result.motoringTimeS,
      waypoint_count: wps.length,
      warnings: result.warnings?.length ?? 0,
      departure: wps[0].time.toISOString(),
      arrival: wps[wps.length - 1].time.toISOString(),
      forecast_cycle: cycleLabel,
      current_sources: result.currentSources,
      polar: polarLabel,
      polar_performance: routePolar ? vessel.polarPerformance : undefined,
      auto_vias: result.autoVias?.map(v => ({ name: v.name, width_m: Math.round(v.widthM) })),
    };
    if (multi) {
      summary.legs = stops.length - 1;
      summary.precision = request.precision ?? DEFAULT_PRECISION;
    }
    st.log(
      'info',
      `job ${id}: ${wps.length} waypoints, ${(result.totalDistanceM / NM_M).toFixed(1)} nm, ${(result.totalTimeS / HOUR_S).toFixed(1)} h, ${Date.now() - t} ms`
    );
    st.send({
      type: 'done',
      id,
      geojson: routeToGeoJSON(result),
      skRoute: routeToSignalKRoute(result, name),
      skeleton: skeletonToGeoJSON(result),
      fronts: result.fronts ? result.fronts.map(f => ({ leg: f.leg, ...compactFront(f) })) : null,
      summary,
    });
  } catch (err) {
    if (err instanceof RouteCancelled || shouldCancel()) st.send({ type: 'error', id, message: 'cancelled', cancelled: true });
    else st.send({ type: 'error', id, message: (err as Error).message });
  } finally {
    // The route's forecast area and its SMOC on-demand areas go with the route.
    if (st.routeWindow) {
      releaseWindow(st, st.routeWindow);
      st.routeWindow = null;
    }
    if (st.smoc) st.smoc.trimOnDemand(0);
    rebuildStack(st);
    releaseMemory();
    st.send({ type: 'forecast-memory', memory: { ...st.forecastMemory } });
  }
}

export function expandBBox(b: BBox, d: number): BBox {
  const width = bboxWidth(b);
  if (width + 2 * d >= 360) return { west: -180, east: 180, south: Math.max(-90, b.south - d), north: Math.min(90, b.north + d) };
  return { west: b.west - d, east: b.west + width + d, south: Math.max(-90, b.south - d), north: Math.min(90, b.north + d) };
}
