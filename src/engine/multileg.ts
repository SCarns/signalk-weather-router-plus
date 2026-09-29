/**
 * Waypoints as legs: port of the reference's compute_multi_leg_route
 * (routePlanning routing/engine/hybrid.py, from line 850).
 *
 * stops = [start, waypoint 1, …, end]. Each consecutive pair is routed as
 * its own route (its own corridor, search and retries), departing at the
 * previous leg's arrival so wind, current and tide advance across legs.
 * The legs are stitched: the duplicate junction point is dropped,
 * distances and sail/motor times are summed, and the junction point of
 * each waypoint gets role "via".
 *
 * Precision (routes.py lines 95–135):
 *  - precise (default): every leg ends exactly on its waypoint (the
 *    propagator's straight final leg to the exact point);
 *  - approximate: an intermediate leg is done as soon as the route enters
 *    the waypoint's circle (arrival radius, ocean_propagator.py lines
 *    1037–1075, snap_to_exact=False); the next leg starts from that point.
 *    The final destination is always exact.
 *
 * Difference from the reference: its next leg starts from the canonical
 * waypoint (hybrid.py: leg_start = stops_lonlat[leg_idx]) and the stitch
 * then trims the points inside the circle; here the next leg starts
 * where the previous one ended, so the stitched track is continuous and
 * the junction point is the circle entry itself. The reference's
 * collapse of consecutive approximate ocean legs into one propagator run
 * with via discs (hybrid.py ~1336) is not ported: that is the single
 * search with discs that failed here.
 */

import { haversineDistanceM } from '../geo/geodesy';
import { recomputePerWaypointMetadata, type Route, type RouteWarning } from './route';

export type Precision = 'precise' | 'approximate';

/** Reference defaults (routes.py): precision "precise", arrival_radius_m 200, range 0–5000. */
export const DEFAULT_PRECISION: Precision = 'precise';
export const DEFAULT_ARRIVAL_RADIUS_M = 200;
export const MAX_ARRIVAL_RADIUS_M = 5000;

export interface Stop {
  lon: number;
  lat: number;
  /** Per-waypoint arrival radius, metres; overrides the request's arrival radius (approximate mode). */
  radiusM?: number;
}

export interface LegPlan {
  /** 0-based leg index. */
  index: number;
  /** Number of legs. */
  count: number;
  /** The leg's target (the next stop). */
  end: [number, number];
  /** true: the leg ends exactly on `end`; false: on entering the circle of radius arrivalRadiusM. */
  snapToExact: boolean;
  /** Circle radius for an approximate leg (undefined when exact). */
  arrivalRadiusM?: number;
}

/**
 * Validate precision / radii the way the reference does: approximate needs
 * a radius > 0 (routes.py `_approximate_requires_positive_radius`).
 * Returns an error message or null.
 */
export function validateLegOptions(
  precision: unknown, arrivalRadiusM: unknown, waypoints: { radius_m?: unknown }[] | undefined,
): string | null {
  if (precision !== undefined && precision !== 'precise' && precision !== 'approximate') return 'precision must be "precise" or "approximate"';
  const radiusOk = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_ARRIVAL_RADIUS_M;
  if (arrivalRadiusM !== undefined && !radiusOk(arrivalRadiusM)) return `arrival_radius_m must be 0..${MAX_ARRIVAL_RADIUS_M}`;
  for (let i = 0; i < (waypoints ?? []).length; i++) {
    const r = waypoints![i].radius_m;
    if (r !== undefined && !radiusOk(r)) return `waypoints[${i}].radius_m must be 0..${MAX_ARRIVAL_RADIUS_M}`;
  }
  if (precision === 'approximate') {
    const def = (arrivalRadiusM as number | undefined) ?? DEFAULT_ARRIVAL_RADIUS_M;
    if (!(def > 0)) return 'arrival_radius_m must be > 0 when precision is "approximate" (use "precise" for exact waypoints)';
    for (let i = 0; i < (waypoints ?? []).length; i++) {
      const r = waypoints![i].radius_m;
      if (r !== undefined && !((r as number) > 0)) return `waypoints[${i}].radius_m must be > 0 when precision is "approximate"`;
    }
  }
  return null;
}

/**
 * One plan per leg. Precise: every leg exact. Approximate: every
 * intermediate leg ends on its waypoint's circle (the waypoint's own
 * radius, else `arrivalRadiusM`); the last leg is always exact.
 */
export function planLegs(stops: Stop[], precision: Precision = DEFAULT_PRECISION, arrivalRadiusM = DEFAULT_ARRIVAL_RADIUS_M): LegPlan[] {
  if (stops.length < 2) throw new Error(`at least start and end are needed (got ${stops.length} stops)`);
  const count = stops.length - 1;
  const out: LegPlan[] = [];
  for (let i = 0; i < count; i++) {
    const to = stops[i + 1];
    const last = i === count - 1;
    const r = to.radiusM ?? arrivalRadiusM;
    const approx = precision === 'approximate' && !last && r > 0;
    out.push({ index: i, count, end: [to.lon, to.lat], snapToExact: !approx, arrivalRadiusM: approx ? r : undefined });
  }
  return out;
}

/** Same point to within ~0.1 m. */
function samePoint(a: { lon: number; lat: number }, b: { lon: number; lat: number }): boolean {
  return Math.abs(a.lon - b.lon) < 1e-6 && Math.abs(a.lat - b.lat) < 1e-6;
}

/**
 * Stitch leg routes into one route (hybrid.py lines ~1731–1790): the
 * first point of each following leg duplicates the previous leg's last
 * point and is dropped; distances and sail/motor times are summed; the
 * junction point of each waypoint gets role "via"; warnings keep their
 * position (leg_index re-based on the stitched polyline); automatic vias
 * and skeletons are concatenated.
 */
export function stitchLegs(legs: Route[]): Route {
  if (legs.length === 0) throw new Error('no legs to stitch');
  if (legs.length === 1) return legs[0];
  const waypoints = legs[0].waypoints.map((w) => ({ ...w, role: undefined as 'via' | undefined }));
  let totalDistanceM = legs[0].totalDistanceM;
  let motoringTimeS = legs[0].motoringTimeS;
  let sailingTimeS = legs[0].sailingTimeS;
  const warnings: RouteWarning[] = (legs[0].warnings ?? []).map((w) => ({ ...w }));
  const autoVias = [...(legs[0].autoVias ?? [])];
  const skeleton = legs[0].skeleton ? [...legs[0].skeleton] : undefined;
  let validated = legs[0].validated;
  let horizon = legs[0].forecastHorizonExceededS ?? 0;
  let drops = legs[0].smootherDrops ?? 0;
  for (let li = 1; li < legs.length; li++) {
    const leg = legs[li];
    // The previous leg's end is this waypoint's junction.
    waypoints[waypoints.length - 1].role = 'via';
    let wps = leg.waypoints;
    let offset = waypoints.length - 1;
    if (wps.length && samePoint(waypoints[waypoints.length - 1], wps[0])) {
      wps = wps.slice(1);
    } else {
      // Not continuous (a caller that started the leg elsewhere): the jump stays as a segment.
      offset = waypoints.length;
      if (wps.length) {
        const a = waypoints[waypoints.length - 1];
        totalDistanceM += haversineDistanceM(a.lon, a.lat, wps[0].lon, wps[0].lat);
      }
    }
    for (const w of wps) waypoints.push({ ...w, role: undefined });
    for (const w of leg.warnings ?? []) warnings.push({ ...w, leg_index: w.leg_index + offset });
    totalDistanceM += leg.totalDistanceM;
    motoringTimeS += leg.motoringTimeS;
    sailingTimeS += leg.sailingTimeS;
    autoVias.push(...(leg.autoVias ?? []));
    if (skeleton && leg.skeleton) skeleton.push(...(samePoint(skeleton[skeleton.length - 1], leg.skeleton[0]) ? leg.skeleton.slice(1) : leg.skeleton));
    validated = validated && leg.validated;
    horizon = Math.max(horizon, leg.forecastHorizonExceededS ?? 0);
    drops += leg.smootherDrops ?? 0;
  }
  const route: Route = {
    waypoints,
    totalTimeS: (waypoints[waypoints.length - 1].time.getTime() - waypoints[0].time.getTime()) / 1000,
    totalDistanceM,
    motoringTimeS,
    sailingTimeS,
    validated,
  };
  if (warnings.length) route.warnings = warnings;
  if (autoVias.length) route.autoVias = autoVias;
  if (skeleton) route.skeleton = skeleton;
  if (horizon > 0) route.forecastHorizonExceededS = horizon;
  if (drops) route.smootherDrops = drops;
  recomputePerWaypointMetadata(route);
  return route;
}

export interface MultiLegArgs {
  stops: Stop[];
  departureTime: Date;
  precision?: Precision;
  arrivalRadiusM?: number;
  /**
   * Route one leg from `start` (the route start, or where the previous leg
   * ended) departing at `departure`.
   */
  runLeg: (leg: LegPlan, start: [number, number], departure: Date) => Promise<Route> | Route;
  /** Progress lines ("leg 2/4: …"). */
  onProgress?: (message: string) => void;
}

/**
 * Route stops[0] → … → stops[n-1] leg by leg and stitch. Each leg starts
 * where the previous one ended (the waypoint in precise mode, the circle
 * entry in approximate mode) at its arrival time.
 */
export async function routeMultiLeg(args: MultiLegArgs): Promise<Route> {
  const plans = planLegs(args.stops, args.precision ?? DEFAULT_PRECISION, args.arrivalRadiusM ?? DEFAULT_ARRIVAL_RADIUS_M);
  const progress = args.onProgress ?? (() => undefined);
  const legs: Route[] = [];
  let start: [number, number] = [args.stops[0].lon, args.stops[0].lat];
  let departure = args.departureTime;
  for (const plan of plans) {
    if (plans.length > 1) {
      progress(`leg ${plan.index + 1}/${plan.count}: (${start[1].toFixed(4)}, ${start[0].toFixed(4)}) → (${plan.end[1].toFixed(4)}, ${plan.end[0].toFixed(4)}), departing ${departure.toISOString()}${plan.snapToExact ? ', ends exactly on the point' : `, ends on entering the ${plan.arrivalRadiusM!.toFixed(0)} m circle`}`);
    }
    const r = await args.runLeg(plan, start, departure);
    if (!r.waypoints.length) throw new Error(`leg ${plan.index + 1}/${plan.count} returned no waypoints`);
    const last = r.waypoints[r.waypoints.length - 1];
    if (plans.length > 1) {
      const miss = haversineDistanceM(last.lon, last.lat, plan.end[0], plan.end[1]);
      progress(`leg ${plan.index + 1}/${plan.count} done: ${(r.totalDistanceM / 1852).toFixed(1)} nm, ${(r.totalTimeS / 3600).toFixed(1)} h, ends ${miss.toFixed(0)} m from the ${plan.index + 1 < plan.count ? 'waypoint' : 'destination'}`);
    }
    legs.push(r);
    start = [last.lon, last.lat];
    departure = last.time;
  }
  return stitchLegs(legs);
}
