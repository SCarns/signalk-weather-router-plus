/**
 * Subsector isochrone propagator for open-water legs. Port of
 * routing/engine/ocean_propagator.py (Hagiwara 1989 / Chen & Mao 2024
 * IPO family) without the bathymetry gate.
 *
 * Per stage:
 *  1. From each retained parent, project (2m+1) candidates at evenly
 *     spaced headings around the bearing to the next skeleton target,
 *     one stage step away.
 *  2. Drop candidates whose great-circle leg touches land.
 *  3. Score survivors with the batched leg simulator (wind, current,
 *     polar, mode policy).
 *  4. Bin by cross-track offset from the start→end great circle into 2k
 *     subsectors; keep the cheapest (elapsed + remaining/cruise) per bin
 *     and per via-count.
 *  5. Stop early when a candidate is within one stage step (or the
 *     caller's arrival radius) of the destination.
 * Then a straight final leg to the destination, back-trace, enrich each
 * waypoint with wind/waves/current, and validate every leg against the
 * exact polygons.
 *
 * A skeleton (land-avoiding motor path) biases the heading sweep so
 * channels and around-island detours are found without widening the
 * sweep at every stage. The router passes a corridor from the global
 * water grid (engine/corridor.ts) with a width profile; without one, a
 * coarse A* on a raster of the route's land mask is used.
 *
 * Narrow passages (from the corridor's width profile):
 *  - a parent's stage step is limited so it never jumps past a point
 *    where the passage is narrower than step / STEP_PER_WIDTH: it may
 *    step up to that point, and inside the passage it steps at most
 *    STEP_PER_WIDTH × the local width (never below MIN_STEP_M); the stage
 *    budget grows by the stages this costs;
 *  - inside a stretch narrower than one subsector bin, candidates are
 *    binned by their offset across the passage (NARROW_BINS bins across
 *    the local width) instead of by the start→end offset, so several
 *    branches survive through the passage instead of one per bin.
 * Automatic vias (Via.auto) work like user vias but are never reported as
 * route waypoints.
 *
 * INTO_CIRCLE_NOTE (deviation from the reference): a parent whose next
 * user via's circle is closer than one stage step also gets one candidate
 * on the straight line to the via, ending just inside its circle (the
 * same hop the approximate final leg uses). Without it a branch reaches a
 * small circle only if a full stage step happens to cross it, which
 * fails where the course turns at the waypoint (Baja job 5e0abb0d,
 * docs/plans/waypoints-multi-leg.md).
 */

import {
  bboxFromLonLat,
  haversineBearing,
  haversineDistanceM,
  perpendicularOffsetM,
  alongTrackDistanceM,
  projectAlongBearing,
  segmentWithinDisc,
} from '../geo/geodesy';
import { buildCoarseGrid, type NavigabilityGrid } from '../geo/grid';
import type { LandMask } from '../geo/landmask';
import { astarRoute, AstarError } from './astar';
import { MIN_STEP_M, STEP_PER_WIDTH } from './corridor';
import { NoCurrent, NoWind, type CurrentSource, type WindSource } from './environment';
import { scoreCandidatesFromParent, simulateLegTime, type ModePolicy, type LegSimResult, type SimOptions } from './legsim';
import { recomputePerWaypointMetadata, type Route, type RouteWarning, type Waypoint, type StageFront } from './route';
import type { PolarDiagram } from '../vessel/polar';
import type { VesselParams } from '../vessel/vessel';

export interface PropagatorOptions {
  /** Number of isochrone stages spanning the great-circle distance. */
  stages?: number;
  /** Subsector half-count k (2k bins across the corridor). */
  subsectors?: number;
  /** Heading half-count m (2m+1 candidates per parent). */
  headings?: number;
  /** Heading spacing in degrees. */
  headingIncrementDeg?: number;
  /** Coarse skeleton grid resolution in degrees. */
  skeletonResolutionDeg?: number;
  /** Padding around the leg's bbox for the skeleton grid, degrees. */
  skeletonPaddingDeg?: number;
  /** Along-leg land sampling step, metres. */
  landStepM?: number;
}

export interface Via {
  lon: number;
  lat: number;
  /** Disc radius the polyline must pass through, metres (> 0). */
  radiusM: number;
  /** Inserted by the router at a narrow passage (not a user waypoint). */
  auto?: boolean;
  /** Passage name for progress messages (auto vias). */
  name?: string;
  /** Passage width, metres (auto vias). */
  widthM?: number;
}

/** Precomputed corridor (engine/corridor.ts). */
export interface CorridorInput {
  skeleton: { lon: number; lat: number }[];
  /** Across-track water width per skeleton point, metres (Infinity = open water). */
  widthM?: ArrayLike<number>;
}

/** Bins across a narrow passage. */
export const NARROW_BINS = 6;
/** Stages in a row without the front coming closer to the destination (after the planned stages) before the search is called boxed in. */
export const STALL_STAGES = 3;
/** Share of a stage's water candidates dead upwind from which the front counts as beating (stall detection waits for the hard stage ceiling). */
export const BEATING_SHARE = 0.1;

export interface ComputeRouteArgs {
  start: [number, number];
  end: [number, number];
  departureTime: Date;
  vessel: VesselParams;
  polar?: PolarDiagram | null;
  wind?: WindSource;
  current?: CurrentSource;
  modePolicy?: ModePolicy;
  sailThreshMs?: number;
  simStepM?: number;
  /**
   * Stop as soon as a candidate is within this distance of the end (the
   * reference's arrival_radius_m, rule (a)); the one-stage-step rule (b)
   * always applies as well.
   */
  arrivalRadiusM?: number;
  /**
   * true (default): the route ends exactly on `end` (a straight final leg
   * from the best candidate). false (an approximate intermediate
   * waypoint; needs arrivalRadiusM > 0): the route ends where it enters
   * the arrival circle: at the best candidate when it is inside the
   * circle, else at the point where the straight leg from it towards
   * `end` reaches the circle.
   */
  snapToExact?: boolean;
  vias?: Via[];
  /** Corridor from the global water grid; replaces the internal coarse A* skeleton. */
  corridor?: CorridorInput;
  /** Wind speed (m/s) and significant wave height (m) a leg must not exceed; candidates over them are not allowed. */
  maxWindMs?: number;
  maxSwhM?: number;
  /** The forecast's last valid step (ms); conditions after it are held at that step. Named in a boxed-in search's error. */
  forecastEndMs?: number;
  /** Called after every stage with its front and the best path so far (display only). */
  onFrontier?: (front: StageFront) => void;
  /** Progress callback; messages are short human-readable lines. */
  onProgress?: (stage: number, totalStages: number, message: string) => void;
  /** Return true to abort; a RouteCancelled error is thrown. */
  shouldCancel?: () => boolean;
}

/**
 * Nearest passable cell centre to `p` within `maxRadius` cells (ring
 * search); returns `p` unchanged when its own cell is passable or when
 * nothing is found.
 */
function snapToPassable(grid: NavigabilityGrid, p: [number, number], maxRadius: number): [number, number] {
  const [i0, j0] = grid.spec.lonlatToIJ(p[0], p[1]);
  if (grid.isPassable(i0, j0)) return p;
  for (let r = 1; r <= maxRadius; r++) {
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (let di = -r; di <= r; di++) {
      for (let dj = -r; dj <= r; dj++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = i0 + di;
        const j = j0 + dj;
        if (!grid.isPassable(i, j)) continue;
        const [lon, lat] = grid.spec.ijToLonLat(i, j);
        const d = haversineDistanceM(p[0], p[1], lon, lat);
        if (d < bestD) {
          bestD = d;
          best = [lon, lat];
        }
      }
    }
    if (best) return best;
  }
  return p;
}

function r4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

/** The path from the start to `cand` (in stage `stageIdx`), [lon, lat] per stage, start first. */
function traceBack(stages: Candidate[][], stageIdx: number, cand: Candidate): [number, number][] {
  const out: [number, number][] = [];
  let cur: Candidate | undefined = cand;
  let s = stageIdx;
  while (cur && s >= 0) {
    out.push([r4(cur.lon), r4(cur.lat)]);
    if (s === 0 || cur.parentIdx < 0) break;
    cur = stages[s - 1][cur.parentIdx];
    s--;
  }
  return out.reverse();
}

/** The candidate at the end of a simulated straight hop from `from` to (lon, lat). */
function hopCandidate(from: Candidate, lon: number, lat: number, sim: LegSimResult): Candidate {
  const d = haversineDistanceM(from.lon, from.lat, lon, lat);
  return {
    lon,
    lat,
    timeMs: from.timeMs + sim.seconds * 1000,
    elapsedS: from.elapsedS + sim.seconds,
    parentIdx: -1,
    sogMs: d / sim.seconds,
    cogDeg: haversineBearing(from.lon, from.lat, lon, lat),
    mode: sim.dominantMode === 'sailing' ? 'sailing' : 'motoring',
    sailingS: sim.sailingSeconds,
    motoringS: sim.motoringSeconds,
    viaCount: from.viaCount,
    viaIdxs: [],
  };
}

export class RouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteError';
  }
}

/** No branch went through every via (thrown so callers can retry without automatic vias). */
export class ViasNotCrossedError extends RouteError {
  constructor(message: string) {
    super(message);
    this.name = 'ViasNotCrossedError';
  }
}

export class RouteCancelled extends Error {
  constructor() {
    super('route computation cancelled');
    this.name = 'RouteCancelled';
  }
}

interface Candidate {
  lon: number;
  lat: number;
  timeMs: number;
  elapsedS: number;
  parentIdx: number;
  sogMs: number;
  cogDeg: number;
  mode: 'sailing' | 'motoring';
  sailingS: number;
  motoringS: number;
  viaCount: number;
  viaIdxs: number[];
}

export class OceanPropagator {
  readonly K: number;
  readonly k: number;
  readonly m: number;
  readonly deltaC: number;
  readonly skeletonResolutionDeg: number;
  readonly skeletonPaddingDeg: number;
  readonly landStepM: number;

  constructor(
    readonly landMask: LandMask,
    opts: PropagatorOptions = {}
  ) {
    this.K = Math.max(1, Math.floor(opts.stages ?? 20));
    this.k = Math.max(1, Math.floor(opts.subsectors ?? 30));
    this.m = Math.max(1, Math.floor(opts.headings ?? 30));
    this.deltaC = opts.headingIncrementDeg ?? 1.0;
    this.skeletonResolutionDeg = opts.skeletonResolutionDeg ?? 0.005;
    this.skeletonPaddingDeg = opts.skeletonPaddingDeg ?? 1.0;
    this.landStepM = opts.landStepM ?? 200;
  }

  /**
   * The final hop to windward as a beat: when the straight bearing from `from`
   * to the goal lies inside the polar's no-go angle for the wind there, two
   * close-hauled legs (TWA = the polar's tightest sailable angle plus a small
   * margin) on either tack, meeting at the tack point the laylines give, in
   * whichever order is faster and clear of land. Null when the straight hop
   * can be sailed (or motored, in motor mode), or no beat is possible.
   */
  private beatToWindward(
    from: Candidate,
    gLon: number,
    gLat: number,
    vessel: VesselParams,
    polar: PolarDiagram | null,
    wind: WindSource,
    current: CurrentSource,
    simOpts: SimOptions,
    modePolicy: ModePolicy,
    landStepM: number
  ): { tack: Candidate; final: Candidate; d1: number; d2: number } | null {
    if (!polar || modePolicy === 'motor') return null;
    const [ws, wd] = wind.at(from.lon, from.lat, new Date(from.timeMs));
    if (!Number.isFinite(ws) || ws <= 0 || !Number.isFinite(wd)) return null;
    const D = haversineDistanceM(from.lon, from.lat, gLon, gLat);
    if (D <= 0) return null;
    const theta = haversineBearing(from.lon, from.lat, gLon, gLat);
    let twa = (((theta - wd) % 360) + 360) % 360;
    if (twa > 180) twa = 360 - twa;
    const floor = polar.noGoFloor(ws);
    if (!(twa < floor)) return null; // the straight hop can be sailed
    const beta = Math.min(89, floor + 3);
    const rad = Math.PI / 180;
    const h1 = (((wd + beta) % 360) + 360) % 360;
    const h2 = (((wd - beta) % 360) + 360) % 360;
    const det = Math.sin((h1 - h2) * rad);
    if (Math.abs(det) < 1e-9) return null;
    const d1 = (D * Math.sin((theta - h2) * rad)) / det;
    const d2 = (D * Math.sin((h1 - theta) * rad)) / det;
    if (!(d1 > 0 && d2 > 0)) return null;
    const orders: { hFirst: number; dFirst: number; hSecond: number; dSecond: number }[] = [
      { hFirst: h1, dFirst: d1, hSecond: h2, dSecond: d2 },
      { hFirst: h2, dFirst: d2, hSecond: h1, dSecond: d1 },
    ];
    let best: { tack: Candidate; final: Candidate; d1: number; d2: number; total: number } | null = null;
    for (const o of orders) {
      const [tLon, tLat] = projectAlongBearing(from.lon, from.lat, o.hFirst, o.dFirst);
      const cross = this.landMask.legsCrossLandBulk(
        Float64Array.of(from.lon, tLon),
        Float64Array.of(from.lat, tLat),
        Float64Array.of(tLon, gLon),
        Float64Array.of(tLat, gLat),
        landStepM
      );
      if (cross[0] || cross[1]) continue;
      const s1 = simulateLegTime(from.lon, from.lat, new Date(from.timeMs), tLon, tLat, vessel, polar, wind, current, simOpts);
      if (!Number.isFinite(s1.seconds) || s1.seconds <= 0) continue;
      const tack = hopCandidate(from, tLon, tLat, s1);
      const s2 = simulateLegTime(tLon, tLat, new Date(tack.timeMs), gLon, gLat, vessel, polar, wind, current, simOpts);
      if (!Number.isFinite(s2.seconds) || s2.seconds <= 0) continue;
      const total = s1.seconds + s2.seconds;
      if (!best || total < best.total) best = { tack, final: hopCandidate(tack, gLon, gLat, s2), d1: o.dFirst, d2: o.dSecond, total };
    }
    return best;
  }

  computeRoute(args: ComputeRouteArgs): Route {
    const wind = args.wind ?? new NoWind();
    const current = args.current ?? new NoCurrent();
    const polar = args.polar ?? null;
    const vessel = args.vessel;
    const modePolicy = args.modePolicy ?? 'sail_max';
    const sailThreshMs = args.sailThreshMs ?? 2.5;
    const simStepM = args.simStepM ?? 200;
    const progress = args.onProgress ?? (() => undefined);
    const shouldCancel = args.shouldCancel ?? (() => false);
    const checkCancel = (): void => {
      if (shouldCancel()) throw new RouteCancelled();
    };
    const simOpts = { modePolicy, sailThreshMs, simStepM, maxWindMs: args.maxWindMs, maxSwhM: args.maxSwhM };
    const fronts: StageFront[] = [];
    const hasLimit = args.maxWindMs !== undefined || args.maxSwhM !== undefined;
    const limitNote = hasLimit ? ' or over the wind/wave limit' : '';
    // What happened to the candidates of the last proposal: how many were
    // tried, crossed land, were over the wind/wave limit, or were stuck for
    // another reason (no boat speed). For the progress line and the errors.
    const lastTry = { tried: 0, land: 0, limited: 0, noGo: 0, stuck: 0, latestMs: 0 };
    const resetTry = (parents: Candidate[]): void => {
      lastTry.tried = 0;
      lastTry.land = 0;
      lastTry.limited = 0;
      lastTry.noGo = 0;
      lastTry.stuck = 0;
      lastTry.latestMs = 0;
      for (const p of parents) lastTry.latestMs = Math.max(lastTry.latestMs, p.timeMs);
    };
    const tryNote = (): string => {
      const parts: string[] = [];
      if (lastTry.limited) parts.push(`${lastTry.limited} over the wind/wave limit`);
      if (lastTry.land) parts.push(`${lastTry.land} crossing land`);
      if (lastTry.noGo) parts.push(`${lastTry.noGo} dead upwind (in the polar's no-go angle)`);
      if (lastTry.stuck) parts.push(`${lastTry.stuck} stopped (no boat speed, or a foul current)`);
      return parts.length
        ? `of the last stage's ${lastTry.tried} candidates, ${parts.join(', ')}`
        : `the last stage tried ${lastTry.tried} candidates`;
    };
    const fmtUtc = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    const forecastNote = (): string => {
      if (args.forecastEndMs === undefined || lastTry.latestMs <= args.forecastEndMs) return '';
      return ` The forecast ends ${fmtUtc(args.forecastEndMs)} and the search is ${((lastTry.latestMs - args.forecastEndMs) / 3600_000).toFixed(0)} h past it, on conditions held at that last step: a longer forecast horizon (Settings) may open a way.`;
    };

    const [sLon, sLat] = args.start;
    const [eLon, eLat] = args.end;
    const snapToExact = args.snapToExact ?? true;
    if (!snapToExact && !(args.arrivalRadiusM !== undefined && args.arrivalRadiusM > 0)) {
      throw new RouteError('snapToExact=false needs arrivalRadiusM > 0');
    }

    // Pre-flight endpoint checks against the exact polygons.
    if (this.landMask.isLandExact(sLon, sLat)) {
      throw new RouteError(`start point (${sLat.toFixed(4)}, ${sLon.toFixed(4)}) is on land`);
    }
    if (this.landMask.isLandExact(eLon, eLat)) {
      throw new RouteError(`end point (${eLat.toFixed(4)}, ${eLon.toFixed(4)}) is on land`);
    }

    // Goal queue: vias then the end (radius 0).
    const goals: Via[] = [];
    if (args.vias) {
      args.vias.forEach((v, idx) => {
        if (!(v.radiusM > 0)) throw new RouteError(`via ${idx} arrival radius must be > 0 (got ${v.radiusM})`);
        if (this.landMask.isLandExact(v.lon, v.lat)) {
          throw new RouteError(`via ${idx} (${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}) is on land`);
        }
        goals.push({ ...v });
      });
    }
    goals.push({ lon: eLon, lat: eLat, radiusM: 0 });
    const nVias = goals.length - 1;
    let startViaCount = 0;
    while (startViaCount < nVias) {
      const g = goals[startViaCount];
      if (haversineDistanceM(sLon, sLat, g.lon, g.lat) <= g.radiusM) startViaCount++;
      else break;
    }

    // Distance budget.
    let chainDist = 0;
    let prev: [number, number] = [sLon, sLat];
    for (const g of goals) {
      chainDist += haversineDistanceM(prev[0], prev[1], g.lon, g.lat);
      prev = [g.lon, g.lat];
    }
    const totalDistM = Math.max(chainDist, haversineDistanceM(sLon, sLat, eLon, eLat));
    if (totalDistM <= 0) {
      const wp: Waypoint = { lon: sLon, lat: sLat, time: args.departureTime, sogMs: 0, cogDeg: 0, mode: 'motoring', leg: 'ocean' };
      return { waypoints: [wp], totalTimeS: 0, totalDistanceM: 0, motoringTimeS: 0, sailingTimeS: 0, validated: true };
    }
    const cruise = vessel.motorSpeedMs;
    if (!(cruise > 0)) throw new RouteError('vessel.motorSpeedMs must be > 0');
    // Stage budget. The reference implementation sizes K stages to the
    // straight-line distance; here the budget is re-sized to the coarse
    // skeleton's length once it is known (below), so a passage that must
    // detour around land still fits in K stages instead of running out
    // of stages short of the destination.
    let budgetDistM = totalDistM;
    let dtS = budgetDistM / cruise / this.K;
    let deltaD = budgetDistM / (2 * this.k);
    let candStepM = cruise * dtS;

    // ---- Coarse A* skeleton -------------------------------------------
    const chainEndpoints: [number, number][] = [
      [sLon, sLat],
      ...goals.slice(0, -1).map(g => [g.lon, g.lat] as [number, number]),
      [eLon, eLat],
    ];
    let skeleton: { lon: number; lat: number }[] | null = null;
    let skeletonCum: number[] | null = null;
    let widths: ArrayLike<number> | null = null;
    if (args.corridor && args.corridor.skeleton.length >= 2) {
      skeleton = args.corridor.skeleton.map(p => ({ lon: p.lon, lat: p.lat }));
      skeleton[0] = { lon: sLon, lat: sLat };
      skeleton[skeleton.length - 1] = { lon: eLon, lat: eLat };
      widths = args.corridor.widthM && args.corridor.widthM.length === skeleton.length ? args.corridor.widthM : null;
      skeletonCum = [0];
      for (let i = 1; i < skeleton.length; i++) {
        skeletonCum.push(
          skeletonCum[i - 1] + haversineDistanceM(skeleton[i - 1].lon, skeleton[i - 1].lat, skeleton[i].lon, skeleton[i].lat)
        );
      }
      const skLen = skeletonCum[skeletonCum.length - 1];
      progress(0, this.K, `skeleton: corridor from the global water grid, ${skeleton.length} points, ${(skLen / 1000).toFixed(1)} km`);
      if (skLen > budgetDistM) {
        budgetDistM = skLen;
        dtS = budgetDistM / cruise / this.K;
        deltaD = budgetDistM / (2 * this.k);
        candStepM = cruise * dtS;
      }
    } else
      try {
        const bbox = bboxFromLonLat(
          chainEndpoints.map(p => p[0]),
          chainEndpoints.map(p => p[1]),
          this.skeletonPaddingDeg
        );
        const t0 = Date.now();
        const coarse = buildCoarseGrid(this.landMask, bbox, this.skeletonResolutionDeg);
        progress(
          0,
          this.K,
          `skeleton grid ${coarse.spec.nx}x${coarse.spec.ny} at ${this.skeletonResolutionDeg}° built in ${((Date.now() - t0) / 1000).toFixed(1)} s`
        );
        checkCancel();
        const t1 = Date.now();
        // The skeleton is guidance only, so endpoints that fall on a land
        // cell of the coarse raster (a harbour narrower than a cell) are
        // snapped to the nearest passable cell centre for the search.
        const snapped = chainEndpoints.map(p => snapToPassable(coarse, p, 20));
        const chain: { lon: number; lat: number }[] = [];
        try {
          for (let s = 0; s + 1 < snapped.length; s++) {
            const seg = astarRoute(coarse, snapped[s], snapped[s + 1], cruise);
            if (chain.length) chain.push(...seg.path.slice(1));
            else chain.push(...seg.path);
          }
          skeleton = chain;
        } catch (err) {
          if (!(err instanceof AstarError)) throw err;
          progress(0, this.K, `skeleton chain A* failed (${err.message}); retrying start→end only`);
          skeleton = astarRoute(coarse, snapped[0], snapped[snapped.length - 1], cruise).path;
        }
        // Restore the exact endpoints on the skeleton.
        skeleton[0] = { lon: sLon, lat: sLat };
        skeleton[skeleton.length - 1] = { lon: eLon, lat: eLat };
        skeletonCum = [0];
        for (let i = 1; i < skeleton.length; i++) {
          skeletonCum.push(
            skeletonCum[i - 1] + haversineDistanceM(skeleton[i - 1].lon, skeleton[i - 1].lat, skeleton[i].lon, skeleton[i].lat)
          );
        }
        progress(
          0,
          this.K,
          `skeleton: ${skeleton.length} points, ${(skeletonCum[skeletonCum.length - 1] / 1000).toFixed(1)} km, A* ${((Date.now() - t1) / 1000).toFixed(1)} s`
        );
        const skLen = skeletonCum[skeletonCum.length - 1];
        if (skLen > budgetDistM) {
          budgetDistM = skLen;
          dtS = budgetDistM / cruise / this.K;
          deltaD = budgetDistM / (2 * this.k);
          candStepM = cruise * dtS;
        }
      } catch (err) {
        if (err instanceof RouteCancelled) throw err;
        progress(0, this.K, `skeleton unavailable (${(err as Error).message}); headings aim straight at the destination`);
        skeleton = null;
        skeletonCum = null;
      }

    // ---- Narrow passages: step limits, extra stages, narrow-bin zones ------
    const nSk = skeleton ? skeleton.length : 0;
    /** Largest step allowed from each skeleton point (≤ candStepM). */
    const stepAt = new Float64Array(nSk).fill(candStepM);
    const zones: { a: number; b: number; west: number; east: number; south: number; north: number }[] = [];
    let extraStages = 0;
    if (skeleton && skeletonCum && widths) {
      const cum = skeletonCum;
      const maxStep = new Float64Array(nSk);
      for (let i = 0; i < nSk; i++) {
        const w = widths[i];
        maxStep[i] = Number.isFinite(w) ? Math.max(MIN_STEP_M, STEP_PER_WIDTH * w) : Infinity;
      }
      for (let i = 0; i < nSk; i++) {
        let lim = candStepM;
        for (let j = i; j < nSk && cum[j] - cum[i] <= candStepM; j++) {
          const l = Math.max(cum[j] - cum[i], maxStep[j]);
          if (l < lim) lim = l;
        }
        stepAt[i] = Math.max(MIN_STEP_M, lim);
      }
      for (let i = 1; i < nSk; i++) {
        const seg = cum[i] - cum[i - 1];
        if (stepAt[i - 1] < candStepM) extraStages += seg / stepAt[i - 1] - seg / candStepM;
      }
      // Zones narrower than a subsector bin.
      let i = 0;
      while (i < nSk) {
        if (!(widths[i] < deltaD)) {
          i++;
          continue;
        }
        let j = i;
        let maxW = 0;
        while (j + 1 < nSk && widths[j + 1] < deltaD) j++;
        let west = Infinity;
        let east = -Infinity;
        let south = Infinity;
        let north = -Infinity;
        const ref = skeleton[i].lon;
        for (let q = i; q <= j; q++) {
          maxW = Math.max(maxW, widths[q]);
          let x = skeleton[q].lon;
          while (x - ref > 180) x -= 360;
          while (x - ref < -180) x += 360;
          west = Math.min(west, x);
          east = Math.max(east, x);
          south = Math.min(south, skeleton[q].lat);
          north = Math.max(north, skeleton[q].lat);
        }
        const padM = maxW + 2000;
        const padLat = padM / 111_195;
        const padLon = padLat / Math.max(0.05, Math.cos((((south + north) / 2) * Math.PI) / 180));
        zones.push({ a: i, b: j, west: west - padLon, east: east + padLon, south: south - padLat, north: north + padLat });
        i = j + 1;
      }
    }
    const kEff = this.K + (extraStages > 0 ? Math.ceil(extraStages) + 2 : 0);
    const maxStages = kEff + Math.ceil(this.K / 2);
    if (extraStages > 0) {
      let minStep = Infinity;
      for (let i = 0; i < nSk; i++) minStep = Math.min(minStep, stepAt[i]);
      progress(
        0,
        kEff,
        `narrow passages: stages shortened down to ${(minStep / 1000).toFixed(1)} km there; ${kEff} stages planned (${zones.length} narrow stretch${zones.length === 1 ? '' : 'es'} binned across the passage)`
      );
    }
    // Land sampling step: finer when the raster has fine local patches.
    let landStepM = this.landStepM;
    if (this.landMask.patches.length) {
      const finest = Math.min(...this.landMask.patches.map(p => p.resolutionDeg));
      landStepM = Math.min(landStepM, Math.max(20, 1.5 * finest * 111_195));
    }

    progress(
      0,
      kEff,
      `K=${this.K} stages, k=${this.k} subsectors, m=${this.m} headings, step ${(candStepM / 1000).toFixed(1)} km, budget ${(budgetDistM / 1000).toFixed(1)} km (straight ${(totalDistM / 1000).toFixed(1)} km)`
    );

    const nearestSkeleton = (pLon: number, pLat: number, from = 0, to = nSk - 1): number => {
      let bestI = from;
      let bestD = Infinity;
      for (let i = from; i <= to; i++) {
        const d = haversineDistanceM(pLon, pLat, skeleton![i].lon, skeleton![i].lat);
        if (d < bestD) {
          bestD = d;
          bestI = i;
        }
      }
      return bestI;
    };
    /** Step for a parent at a position (candStepM without a skeleton). */
    const stepFor = (pLon: number, pLat: number): { step: number; idx: number } => {
      if (!skeleton || !skeletonCum || nSk < 2) return { step: candStepM, idx: -1 };
      const idx = nearestSkeleton(pLon, pLat);
      return { step: stepAt[idx], idx };
    };
    const targetForParent = (idx: number, stepM: number): [number, number] => {
      if (!skeleton || !skeletonCum || nSk < 2 || idx < 0) return [eLon, eLat];
      const targetCum = skeletonCum[idx] + stepM;
      if (targetCum >= skeletonCum[skeletonCum.length - 1]) return [eLon, eLat];
      for (let i = idx + 1; i < nSk; i++) {
        if (skeletonCum[i] >= targetCum) return [skeleton[i].lon, skeleton[i].lat];
      }
      return [eLon, eLat];
    };
    /** Narrow-zone bin key for a candidate, or null outside every zone. */
    const zoneKey = (c: { lon: number; lat: number; viaCount: number }): string | null => {
      if (!zones.length || !skeleton || !widths) return null;
      for (let zi = 0; zi < zones.length; zi++) {
        const z = zones[zi];
        if (c.lat < z.south || c.lat > z.north) continue;
        let x = c.lon;
        const mid = (z.west + z.east) / 2;
        while (x - mid > 180) x -= 360;
        while (x - mid < -180) x += 360;
        if (x < z.west || x > z.east) continue;
        const i = nearestSkeleton(c.lon, c.lat, z.a, z.b);
        const i2 = i < nSk - 1 ? i + 1 : i - 1;
        const off = perpendicularOffsetM(
          skeleton[Math.min(i, i2)].lon,
          skeleton[Math.min(i, i2)].lat,
          skeleton[Math.max(i, i2)].lon,
          skeleton[Math.max(i, i2)].lat,
          c.lon,
          c.lat
        );
        const w = Math.max(200, Number.isFinite(widths[i]) ? widths[i] : deltaD);
        const binW = w / NARROW_BINS;
        let bin = Math.floor(off / binW);
        if (bin < -NARROW_BINS) bin = -NARROW_BINS;
        if (bin > NARROW_BINS - 1) bin = NARROW_BINS - 1;
        return `${c.viaCount}:z${zi}:${bin}`;
      }
      return null;
    };

    // ---- Candidate proposal ----------------------------------------------
    const propose = (parents: Candidate[], sweepM: number, sweepDc: number, stepFactor: number): Candidate[] => {
      const nH = 2 * sweepM + 1;
      const nP = parents.length;
      // Per parent: the heading sweep, plus one hop into the next user
      // waypoint's circle when that circle is closer than one step
      // (INTO_CIRCLE_NOTE). hopDist[p] = 0: no hop.
      const pStep = new Float64Array(nP);
      const pTgt: [number, number][] = [];
      const hopDist = new Float64Array(nP);
      const hopBrg = new Float64Array(nP);
      let total = 0;
      for (let p = 0; p < nP; p++) {
        const par = parents[p];
        const sf = stepFor(par.lon, par.lat);
        pStep[p] = sf.step * stepFactor;
        pTgt.push(targetForParent(sf.idx, sf.step));
        total += nH;
        if (par.viaCount < nVias) {
          const g = goals[par.viaCount];
          if (!g.auto) {
            const d = haversineDistanceM(par.lon, par.lat, g.lon, g.lat);
            const hop = d - g.radiusM + Math.min(1, 0.001 * g.radiusM);
            if (d > g.radiusM && hop < pStep[p]) {
              hopDist[p] = hop;
              hopBrg[p] = haversineBearing(par.lon, par.lat, g.lon, g.lat);
              total++;
            }
          }
        }
      }
      const pIdx = new Int32Array(total);
      const hdg = new Float64Array(total);
      const dist = new Float64Array(total);
      const cLon = new Float64Array(total);
      const cLat = new Float64Array(total);
      const pLon = new Float64Array(total);
      const pLat = new Float64Array(total);
      const pCount = new Int32Array(nP);
      let q = 0;
      const push = (p: number, b: number, d: number): void => {
        const par = parents[p];
        const [x, y] = projectAlongBearing(par.lon, par.lat, b, d);
        pIdx[q] = p;
        hdg[q] = b;
        dist[q] = d;
        cLon[q] = x;
        cLat[q] = y;
        pLon[q] = par.lon;
        pLat[q] = par.lat;
        q++;
      };
      for (let p = 0; p < nP; p++) {
        const par = parents[p];
        const tgt = pTgt[p];
        const b0 = haversineBearing(par.lon, par.lat, tgt[0], tgt[1]);
        for (let h = -sweepM; h <= sweepM; h++) push(p, (((b0 + h * sweepDc) % 360) + 360) % 360, pStep[p]);
        if (hopDist[p] > 0) push(p, hopBrg[p], hopDist[p]);
        pCount[p] = nH + (hopDist[p] > 0 ? 1 : 0);
      }
      const crosses = this.landMask.legsCrossLandBulk(pLon, pLat, cLon, cLat, landStepM);
      const out: Candidate[] = [];
      lastTry.tried += total;
      for (let i = 0; i < total; i++) if (crosses[i]) lastTry.land++;
      // Group survivors by parent for batched scoring.
      let start = 0;
      for (let p = 0; p < nP; p++) {
        const end = start + pCount[p];
        const keep: number[] = [];
        for (let i = start; i < end; i++) if (!crosses[i]) keep.push(i);
        start = end;
        if (keep.length === 0) continue;
        const par = parents[p];
        const bearings = new Float64Array(keep.map(i => hdg[i]));
        const dists = new Float64Array(keep.map(i => dist[i]));
        const sc = scoreCandidatesFromParent(
          par.lon,
          par.lat,
          new Date(par.timeMs),
          bearings,
          dists,
          vessel,
          polar,
          wind,
          current,
          simOpts
        );
        for (let c = 0; c < keep.length; c++) {
          const secs = sc.seconds[c];
          if (!Number.isFinite(secs) || secs <= 0) {
            if (sc.limited[c]) lastTry.limited++;
            else if (sc.noGo[c]) lastTry.noGo++;
            else lastTry.stuck++;
            continue;
          }
          const i = keep[c];
          const legDist = haversineDistanceM(par.lon, par.lat, cLon[i], cLat[i]);
          const cand: Candidate = {
            lon: cLon[i],
            lat: cLat[i],
            timeMs: par.timeMs + secs * 1000,
            elapsedS: par.elapsedS + secs,
            parentIdx: p,
            sogMs: legDist / secs,
            cogDeg: hdg[i],
            mode: sc.dominant[c] === 1 ? 'sailing' : 'motoring',
            sailingS: sc.sailing[c],
            motoringS: sc.motoring[c],
            viaCount: par.viaCount,
            viaIdxs: [],
          };
          while (cand.viaCount < nVias) {
            const g = goals[cand.viaCount];
            if (segmentWithinDisc(par.lon, par.lat, cand.lon, cand.lat, g.lon, g.lat, g.radiusM)) {
              cand.viaIdxs.push(cand.viaCount);
              cand.viaCount++;
            } else break;
          }
          out.push(cand);
        }
      }
      return out;
    };

    // ---- Stage loop --------------------------------------------------------
    const announced = new Set<number>();
    for (let gi = 0; gi < nVias; gi++) {
      const g = goals[gi];
      if (g.auto)
        progress(
          0,
          kEff,
          `auto via at ${g.name ?? 'a narrow passage'}, width ${((g.widthM ?? 0) / 1000).toFixed(1)} km (disc radius ${(g.radiusM / 1000).toFixed(1)} km)`
        );
    }
    const stages: Candidate[][] = [
      [
        {
          lon: sLon,
          lat: sLat,
          timeMs: args.departureTime.getTime(),
          elapsedS: 0,
          parentIdx: -1,
          sogMs: 0,
          cogDeg: 0,
          mode: 'motoring',
          sailingS: 0,
          motoringS: 0,
          viaCount: startViaCount,
          viaIdxs: [],
        },
      ],
    ];

    let bestEver = Infinity;
    let stagesWithoutGain = 0;
    let bestEverDeepest = -1;
    for (let stage = 0; stage < maxStages; stage++) {
      checkCancel();
      const tStage = Date.now();
      const parents = stages[stages.length - 1];
      if (parents.length === 0) {
        throw new RouteError(
          `stage ${stage} has no live waypoints: every candidate from the previous stage was blocked by land${limitNote} even after widening the heading sweep and halving the step (${tryNote()}).${forecastNote()}`
        );
      }
      resetTry(parents);
      let cands = propose(parents, this.m, this.deltaC, 1);
      // Fallback ladder, per parent (deviation from the reference, which
      // widened only when the whole stage's sweep was empty): a parent whose
      // primary sweep produced nothing (its headings in the polar's no-go
      // angle, on land, or over a limit) gets the wider sweeps on its own,
      // while its siblings keep their primary candidates. A parent facing
      // dead upwind can then tack at every stage instead of only on the
      // stages where every other parent was stuck too (the eastern
      // Mediterranean job 3bde5200: the front shuffled between 1 and 4
      // members, "tacking in place" 1,356–1,430 km from the goal).
      {
        const has = new Uint8Array(parents.length);
        for (const c of cands) has[c.parentIdx] = 1;
        let dead: number[] = [];
        for (let p = 0; p < parents.length; p++) if (!has[p]) dead.push(p);
        const ladder: [number, number, number, string][] = [
          [this.m * 2, this.deltaC * 2, 1, `widening to ±${this.m * 2 * this.deltaC * 2}°`],
          [this.m * 3, this.deltaC * 2, 0.5, `trying ±${this.m * 3 * this.deltaC * 2}° with half step`],
          // Beyond the reference: a full 360° sweep at a quarter step, for
          // parents boxed in by a coast whose exits are shorter than half a
          // stage step.
          [90, 2, 0.25, 'trying full 360° sweep with quarter step'],
        ];
        for (const [m, dc, sf, label] of ladder) {
          if (dead.length === 0) break;
          progress(
            stage + 1,
            Math.max(kEff, stage + 1),
            `${dead.length === parents.length ? 'primary sweep empty' : `${dead.length} of ${parents.length} parents with an empty sweep`}; ${label}`
          );
          const extra = propose(
            dead.map(p => parents[p]),
            m,
            dc,
            sf
          );
          const got = new Set<number>();
          for (const c of extra) {
            c.parentIdx = dead[c.parentIdx];
            got.add(c.parentIdx);
            cands.push(c);
          }
          dead = dead.filter(p => !got.has(p));
        }
      }
      if (cands.length === 0) {
        stages.push([]);
        continue;
      }

      // Subsector pruning.
      const best = new Map<string, number>();
      const cost = new Float64Array(cands.length);
      const remaining = new Float64Array(cands.length);
      for (let i = 0; i < cands.length; i++) {
        const c = cands[i];
        const g = goals[c.viaCount];
        remaining[i] = haversineDistanceM(c.lon, c.lat, g.lon, g.lat);
        cost[i] = c.elapsedS + remaining[i] / cruise;
        let key = zoneKey(c);
        if (key === null) {
          const off = perpendicularOffsetM(sLon, sLat, eLon, eLat, c.lon, c.lat);
          let bin = Math.floor(off / deltaD);
          if (bin < -this.k) bin = -this.k;
          if (bin > this.k - 1) bin = this.k - 1;
          key = `${c.viaCount}:${bin}`;
        }
        const cur = best.get(key);
        if (cur === undefined || cost[i] < cost[cur]) best.set(key, i);
      }
      // The leader survives (deviation from the reference): for each goal
      // the candidate nearest to it is kept whatever its bin. The bin cost
      // prices the remaining distance at cruise speed, which is optimistic
      // to windward, so a branch further back but earlier could take every
      // bin of the leading branch and the front fell back (job c14934c9:
      // best remaining 545 km → 762 km at stage 21). With the leader kept
      // the best remaining distance never increases.
      {
        const lead = new Map<number, number>();
        for (let i = 0; i < cands.length; i++) {
          const vc = cands[i].viaCount;
          const cur = lead.get(vc);
          if (cur === undefined || remaining[i] < remaining[cur]) lead.set(vc, i);
        }
        const kept = new Set(best.values());
        for (const [vc, i] of lead) if (!kept.has(i)) best.set(`lead:${vc}`, i);
      }
      const retained = [...best.values()].map(i => cands[i]);
      stages.push(retained);
      {
        // The stage's front for display: sorted across the track within each
        // goal, plus the best candidate's path back to the start.
        let bi = -1;
        for (const i of best.values()) if (bi < 0 || cost[i] < cost[bi]) bi = i;
        const pts = retained
          .map(c => ({ c, off: perpendicularOffsetM(sLon, sLat, eLon, eLat, c.lon, c.lat) }))
          .sort((a, b) => a.c.viaCount - b.c.viaCount || a.off - b.off)
          .map(({ c }) => ({ lon: r4(c.lon), lat: r4(c.lat), timeMs: c.timeMs, viaCount: c.viaCount }));
        const front: StageFront = {
          leg: 0,
          stage: stage + 1,
          totalStages: maxStages,
          points: pts,
          best: bi >= 0 ? traceBack(stages, stages.length - 1, cands[bi]) : [],
        };
        fronts.push(front);
        args.onFrontier?.(front);
      }

      let bestRemaining = Infinity;
      let bestAtMs = 0;
      for (const c of retained) {
        const d = haversineDistanceM(c.lon, c.lat, eLon, eLat);
        if (d < bestRemaining) {
          bestRemaining = d;
          bestAtMs = c.timeMs;
        }
      }
      const dropped: string[] = [];
      if (lastTry.limited) dropped.push(`${lastTry.limited} over the limit`);
      if (lastTry.land) dropped.push(`${lastTry.land} on land`);
      if (lastTry.noGo) dropped.push(`${lastTry.noGo} dead upwind`);
      progress(
        stage + 1,
        Math.max(kEff, stage + 1),
        `${parents.length} parents → ${cands.length} candidates → ${retained.length} retained${dropped.length ? ` (${dropped.join(', ')})` : ''}; best remaining ${(bestRemaining / 1000).toFixed(1)} km at ${fmtUtc(bestAtMs)}; ${((Date.now() - tStage) / 1000).toFixed(1)} s`
      );
      // Stall detector: once the planned stages are used up, a front that
      // has not come closer to the destination for a few stages in a row is
      // boxed in (by land, the wind/wave limit, or a forecast that no longer
      // changes); say so rather than running the budget out and failing on
      // the terminal hop from far away.
      // Progress is measured towards the deepest branch's own goal (the next
      // via, or the destination once every via is crossed), not towards the
      // destination: a branch can sit a few km from the destination with a
      // via still uncrossed (job 58b50b0d: east of Crete, the Kythira via
      // behind it) and must not count as progress. A gain under a twentieth
      // of the stage step is no gain.
      let deepest = 0;
      for (const c of retained) deepest = Math.max(deepest, c.viaCount);
      let goalRemaining = Infinity;
      for (const c of retained) {
        if (c.viaCount !== deepest) continue;
        goalRemaining = Math.min(goalRemaining, haversineDistanceM(c.lon, c.lat, goals[deepest].lon, goals[deepest].lat));
      }
      if (deepest > bestEverDeepest) {
        bestEverDeepest = deepest;
        bestEver = Infinity;
      }
      if (goalRemaining < bestEver - 0.05 * candStepM) {
        bestEver = goalRemaining;
        stagesWithoutGain = 0;
      } else {
        stagesWithoutGain++;
      }
      // A front that is beating (a fair share of its water candidates dead
      // upwind) sails well over the planned distance, so it gets the stages
      // up to the hard ceiling before a stall counts; otherwise the planned
      // stages are enough.
      const water = Math.max(1, lastTry.tried - lastTry.land);
      const beating = lastTry.noGo / water >= BEATING_SHARE;
      const stallFrom = beating ? maxStages - STALL_STAGES : kEff;
      if (stage + 1 >= stallFrom && stagesWithoutGain >= STALL_STAGES) {
        if (deepest < nVias) {
          // Boxed in before every via was crossed: the caller may retry
          // without the automatic vias (the corridor's guidance, not the
          // user's waypoints), as it does when the stages run out.
          const g = goals[deepest];
          throw new ViasNotCrossedError(
            `the search is boxed in before crossing all ${nVias} via(s): deepest branch crossed ${deepest}, and for ${stagesWithoutGain} stages no candidate came closer than ${(bestEver / 1000).toFixed(0)} km to the next via${g.name ? ` at ${g.name}` : ''}; ${tryNote()}.${forecastNote()}`
          );
        }
        throw new RouteError(
          `the search is boxed in: for ${stagesWithoutGain} stages no candidate came closer than ${(bestEver / 1000).toFixed(0)} km to the destination; ${tryNote()}.${forecastNote()}`
        );
      }
      for (const c of retained) {
        for (const vi of c.viaIdxs) {
          const g = goals[vi];
          if (g.auto && !announced.has(vi)) {
            announced.add(vi);
            progress(stage + 1, Math.max(kEff, stage + 1), `first branch through the auto via at ${g.name ?? 'a narrow passage'}`);
          }
        }
      }

      const eligible = retained.filter(c => c.viaCount === nVias);
      if (eligible.length) {
        let minDist = Infinity;
        for (const c of eligible) minDist = Math.min(minDist, haversineDistanceM(c.lon, c.lat, eLon, eLat));
        if (args.arrivalRadiusM !== undefined && minDist <= args.arrivalRadiusM) {
          progress(
            stage + 1,
            Math.max(kEff, stage + 1),
            `early termination: within arrival radius ${args.arrivalRadiusM.toFixed(0)} m (${minDist.toFixed(0)} m)`
          );
          break;
        }
        // Within one (local) stage step of the destination, with a land-free final leg.
        const near = eligible.filter(c => haversineDistanceM(c.lon, c.lat, eLon, eLat) <= stepFor(c.lon, c.lat).step);
        if (near.length) {
          const hop = this.landMask.legsCrossLandBulk(
            Float64Array.from(near.map(c => c.lon)),
            Float64Array.from(near.map(c => c.lat)),
            new Float64Array(near.length).fill(eLon),
            new Float64Array(near.length).fill(eLat),
            landStepM
          );
          const clear = near.filter((_c, i) => !hop[i]);
          if (clear.length) {
            let md = Infinity;
            for (const c of clear) md = Math.min(md, haversineDistanceM(c.lon, c.lat, eLon, eLat));
            progress(
              stage + 1,
              Math.max(kEff, stage + 1),
              `early termination: within one stage step of destination with a clear final leg (${(md / 1000).toFixed(1)} km)`
            );
            break;
          }
        }
        if (stage + 1 >= kEff && stage + 1 < maxStages)
          progress(stage + 1, Math.max(kEff, stage + 1), 'planned stages used without a clear final leg; continuing');
      } else if (nVias > 0) {
        const deepest = Math.max(...retained.map(c => c.viaCount));
        progress(stage + 1, Math.max(kEff, stage + 1), `via progress: deepest branch crossed ${deepest}/${nVias}`);
      }
    }

    const terminals = stages[stages.length - 1];
    if (terminals.length === 0) throw new RouteError('front went empty before reaching the destination; no path found');
    const score = (c: Candidate): [number, number] => [haversineDistanceM(c.lon, c.lat, eLon, eLat), c.elapsedS];
    const pool = nVias > 0 ? terminals.filter(c => c.viaCount === nVias) : terminals;
    if (pool.length === 0) {
      const deepest = Math.max(0, ...terminals.map(c => c.viaCount));
      throw new ViasNotCrossedError(
        `finished ${stages.length - 1} stages without any branch crossing all ${nVias} via(s); deepest branch crossed ${deepest}. Widen the via radius, add stages, or move the via.`
      );
    }
    // Prefer terminals whose straight final leg is land-free.
    const poolHop = this.landMask.legsCrossLandBulk(
      Float64Array.from(pool.map(c => c.lon)),
      Float64Array.from(pool.map(c => c.lat)),
      new Float64Array(pool.length).fill(eLon),
      new Float64Array(pool.length).fill(eLat),
      landStepM
    );
    const clearPool = pool.filter((_c, i) => !poolHop[i]);
    const choose = clearPool.length ? clearPool : pool;
    let bestC = choose[0];
    for (const c of choose) {
      const [d, t] = score(c);
      const [bd, bt] = score(bestC);
      if (d < bd || (d === bd && t < bt)) bestC = c;
    }
    const stageOfBest = stages.findIndex(st => st.includes(bestC));

    // Final straight leg: to the exact destination, or (approximate
    // intermediate waypoint) only as far as the arrival circle.
    checkCancel();
    const bestDist = haversineDistanceM(bestC.lon, bestC.lat, eLon, eLat);
    let hopEnd: [number, number] | null = [eLon, eLat];
    if (!snapToExact) {
      const r = args.arrivalRadiusM!;
      if (bestDist <= r) hopEnd = null;
      else
        hopEnd = projectAlongBearing(
          bestC.lon,
          bestC.lat,
          haversineBearing(bestC.lon, bestC.lat, eLon, eLat),
          bestDist - r + Math.min(1, 0.001 * r)
        );
    }
    let finalCand: Candidate | null = null;
    let tackCand: Candidate | null = null;
    if (hopEnd) {
      const [hLon, hLat] = hopEnd;
      const finalCross = this.landMask.legsCrossLandBulk(
        Float64Array.of(bestC.lon),
        Float64Array.of(bestC.lat),
        Float64Array.of(hLon),
        Float64Array.of(hLat),
        landStepM
      );
      if (finalCross[0]) {
        throw new RouteError(
          `terminal hop from (${bestC.lat.toFixed(4)}, ${bestC.lon.toFixed(4)}) to the destination crosses land; the propagation got close but the straight final leg is blocked. Try a via point or a closer endpoint.`
        );
      }
      // To windward: the straight hop lies inside the polar's no-go angle, so
      // beat to it on two close-hauled legs meeting at a tack point (the
      // laylines), in whichever order is faster and clear of land. Only a hop
      // that cannot be sailed at all is beaten; everything else stays straight.
      const beat = this.beatToWindward(bestC, hLon, hLat, vessel, polar, wind, current, simOpts, modePolicy, landStepM);
      if (beat) {
        tackCand = beat.tack;
        finalCand = beat.final;
        progress(
          Math.max(kEff, stages.length - 1),
          Math.max(kEff, stages.length - 1),
          `final approach is to windward: beating to the waypoint on two tacks, ${(beat.d1 / 1852).toFixed(1)} nm then ${(beat.d2 / 1852).toFixed(1)} nm`
        );
      } else {
        const simFinal = simulateLegTime(bestC.lon, bestC.lat, new Date(bestC.timeMs), hLon, hLat, vessel, polar, wind, current, simOpts);
        if (!Number.isFinite(simFinal.seconds) || simFinal.seconds <= 0) {
          // From far away (more than two stage steps) the straight hop was
          // never going to work: the search ran its budget out boxed in.
          if (bestDist > 2 * stepFor(bestC.lon, bestC.lat).step) {
            throw new RouteError(
              `the search ran out of stages ${(bestDist / 1000).toFixed(0)} km from the destination, boxed in; ${tryNote()}; the straight final leg from there is stuck under ${modePolicy}${limitNote}.${forecastNote()}`
            );
          }
          throw new RouteError(
            `terminal hop to the destination could not be simulated (stuck under ${modePolicy} given wind/current at the destination${limitNote})`
          );
        }
        const legDistFinal = haversineDistanceM(bestC.lon, bestC.lat, hLon, hLat);
        if (legDistFinal > 0) finalCand = hopCandidate(bestC, hLon, hLat, simFinal);
      }
    }
    if (!snapToExact) {
      const endAt = finalCand ?? bestC;
      progress(
        Math.max(kEff, stages.length - 1),
        Math.max(kEff, stages.length - 1),
        `leg ends inside the ${args.arrivalRadiusM!.toFixed(0)} m circle, ${haversineDistanceM(endAt.lon, endAt.lat, eLon, eLat).toFixed(0)} m from the waypoint${finalCand ? ' (straight hop from the last stage to the circle)' : ''}`
      );
    }

    // Back-trace.
    const chain: Candidate[] = [];
    let cur: Candidate | undefined = bestC;
    let curStage = stageOfBest;
    while (cur && curStage >= 0) {
      chain.push(cur);
      if (curStage === 0 || cur.parentIdx < 0) break;
      cur = stages[curStage - 1][cur.parentIdx];
      curStage--;
    }
    chain.reverse();
    if (tackCand) chain.push(tackCand);
    if (finalCand) chain.push(finalCand);

    // Build waypoints.
    const wps: Waypoint[] = [];
    let motorS = 0;
    let sailS = 0;
    let dist = 0;
    chain.forEach((c, i) => {
      // A user via crossed by a step that ends outside its circle: add a
      // waypoint on that step where it passes closest to the via (same
      // straight line, so the track is unchanged) and mark it, instead of
      // marking the step's end up to a stage step past the waypoint.
      let endIsVia = false;
      if (i > 0) {
        const par = chain[i - 1];
        const inserts: { at: number; lon: number; lat: number }[] = [];
        for (const vi of c.viaIdxs) {
          const g = goals[vi];
          if (g.auto) continue;
          if (haversineDistanceM(c.lon, c.lat, g.lon, g.lat) <= g.radiusM) {
            endIsVia = true;
            continue;
          }
          const legM = haversineDistanceM(par.lon, par.lat, c.lon, c.lat);
          const at = Math.min(legM, Math.max(0, alongTrackDistanceM(par.lon, par.lat, c.lon, c.lat, g.lon, g.lat)));
          if (at <= 0 || at >= legM) {
            endIsVia = true;
            continue;
          }
          const [lon, lat] = projectAlongBearing(par.lon, par.lat, haversineBearing(par.lon, par.lat, c.lon, c.lat), at);
          inserts.push({ at, lon, lat });
        }
        inserts.sort((x, y) => x.at - y.at);
        let prevWp = { lon: par.lon, lat: par.lat, timeMs: par.timeMs };
        for (const ins of inserts) {
          const sim = simulateLegTime(
            prevWp.lon,
            prevWp.lat,
            new Date(prevWp.timeMs),
            ins.lon,
            ins.lat,
            vessel,
            polar,
            wind,
            current,
            simOpts
          );
          const secs = Number.isFinite(sim.seconds) && sim.seconds > 0 ? sim.seconds : 0;
          const timeMs = Math.min(c.timeMs - 1, Math.max(prevWp.timeMs + 1, prevWp.timeMs + secs * 1000));
          wps.push({
            lon: ins.lon,
            lat: ins.lat,
            time: new Date(timeMs),
            sogMs: c.sogMs,
            cogDeg: c.cogDeg,
            mode: sim.dominantMode === 'sailing' ? 'sailing' : sim.dominantMode === 'motoring' ? 'motoring' : c.mode,
            leg: 'ocean',
            role: 'via',
          });
          prevWp = { lon: ins.lon, lat: ins.lat, timeMs };
        }
      }
      wps.push({
        lon: c.lon,
        lat: c.lat,
        time: new Date(c.timeMs),
        sogMs: i > 0 ? c.sogMs : 0,
        cogDeg: i > 0 ? c.cogDeg : 0,
        mode: i > 0 ? c.mode : 'motoring',
        leg: 'ocean',
        role: endIsVia ? 'via' : undefined,
      });
      if (i > 0) {
        motorS += c.motoringS;
        sailS += c.sailingS;
        dist += haversineDistanceM(chain[i - 1].lon, chain[i - 1].lat, c.lon, c.lat);
      }
    });

    enrichWaypoints(wps, wind, current);

    const route: Route = {
      waypoints: wps,
      totalTimeS: (wps[wps.length - 1].time.getTime() - wps[0].time.getTime()) / 1000,
      totalDistanceM: dist,
      motoringTimeS: motorS,
      sailingTimeS: sailS,
      validated: false,
      skeleton: skeleton ? skeleton.map(p => ({ lon: p.lon, lat: p.lat })) : undefined,
    };
    const autos = goals.slice(0, nVias).filter(g => g.auto);
    if (autos.length)
      route.autoVias = autos.map(g => ({ lon: g.lon, lat: g.lat, radiusM: g.radiusM, widthM: g.widthM ?? 0, name: g.name ?? '' }));
    route.fronts = fronts;
    recomputePerWaypointMetadata(route);

    // Final validation against the exact polygons.
    const warns: RouteWarning[] = [];
    for (let i = 0; i + 1 < wps.length; i++) {
      const a = wps[i];
      const b = wps[i + 1];
      if (this.landMask.legCrossesLandExact(a.lon, a.lat, b.lon, b.lat, 100)) {
        warns.push({ leg_index: i, violation: 'leg_crosses_land', from: [a.lon, a.lat], to: [b.lon, b.lat], repaired: false });
      }
    }
    // Legs over a wind or wave limit at their waypoints (the search tested
    // sub-steps; a difference at the waypoints is possible and should show).
    for (let i = 1; i < wps.length; i++) {
      const a = wps[i - 1];
      const b = wps[i];
      if (args.maxWindMs !== undefined && b.windMs !== undefined && b.windMs > args.maxWindMs)
        warns.push({ leg_index: i - 1, violation: 'wind_over_limit', from: [a.lon, a.lat], to: [b.lon, b.lat], repaired: false });
      if (args.maxSwhM !== undefined && b.swhM !== undefined && b.swhM > args.maxSwhM)
        warns.push({ leg_index: i - 1, violation: 'waves_over_limit', from: [a.lon, a.lat], to: [b.lon, b.lat], repaired: false });
    }
    route.validated = true;
    if (warns.length) {
      route.warnings = warns;
      progress(
        Math.max(kEff, stages.length - 1),
        Math.max(kEff, stages.length - 1),
        `WARNING: ${warns.length} leg(s) cross land in the exact polygon check`
      );
    }
    progress(
      Math.max(kEff, stages.length - 1),
      Math.max(kEff, stages.length - 1),
      `done: ${wps.length} waypoints, ${(dist / 1000).toFixed(1)} km, ${(route.totalTimeS / 3600).toFixed(1)} h`
    );
    return route;
  }
}

/** Wind, waves and current at each waypoint's position and time. */
export function enrichWaypoints(wps: Waypoint[], wind: WindSource, current: CurrentSource): void {
  for (const wp of wps) {
    const [ws, wd] = wind.at(wp.lon, wp.lat, wp.time);
    if (Number.isFinite(ws)) {
      wp.windMs = ws;
      wp.windDirDeg = wd;
    }
    if (wind.hasWaves) {
      const wv = wind.wavesAt(wp.lon, wp.lat, wp.time);
      if (wv) {
        wp.swhM = wv.swh;
        wp.mwpS = wv.mwp;
        wp.mwdDeg = wv.mwd;
      }
    }
    const [cu, cv] = current.at(wp.lon, wp.lat, wp.time);
    if (Number.isFinite(cu) && Number.isFinite(cv)) {
      wp.currentUMs = cu;
      wp.currentVMs = cv;
      const sp = Math.hypot(cu, cv);
      wp.currentMs = sp;
      if (sp > 1e-9) wp.currentDirDeg = (((90 - (Math.atan2(cv, cu) * 180) / Math.PI) % 360) + 360) % 360;
    }
  }
}
