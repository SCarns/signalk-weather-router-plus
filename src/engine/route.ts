/**
 * Route and Waypoint types plus GeoJSON / Signal K serialisation.
 * Everything on the wire is SI (m, m/s, s, degrees); clients convert.
 * Property names match the routePlanning server's GeoJSON so existing
 * consumers can read either.
 */

import { haversineBearing, haversineDistanceM } from '../geo/geodesy';

export type Mode = 'sailing' | 'motoring';

export interface Waypoint {
  lon: number;
  lat: number;
  time: Date;
  /** Speed over ground into this waypoint, m/s (0 at the start). */
  sogMs: number;
  /** Course over ground into this waypoint, degrees true. */
  cogDeg: number;
  mode: Mode;
  twaDeg?: number;
  windMs?: number;
  /** Wind direction FROM, degrees true. */
  windDirDeg?: number;
  swhM?: number;
  mwpS?: number;
  /** Wave direction FROM, degrees true. */
  mwdDeg?: number;
  currentUMs?: number;
  currentVMs?: number;
  currentMs?: number;
  /** Current set (flows TO), degrees true. */
  currentDirDeg?: number;
  leg?: string;
  role?: 'via';
  /**
   * Sailing and motoring seconds of the leg arriving here, set when the
   * shortcut smoother merged several legs into one (mixed modes); totals
   * use it in place of the binary `mode`.
   */
  arrivingSplit?: [number, number];
}

export interface RouteWarning {
  leg_index: number;
  violation: 'leg_crosses_land' | 'leg_too_shallow' | 'wind_over_limit' | 'waves_over_limit';
  from: [number, number];
  to: [number, number];
  repaired: boolean;
}

export interface FrontPoint {
  lon: number;
  lat: number;
  timeMs: number;
  /** Which goal (waypoint) the point is heading for; 0 before the first via. */
  viaCount: number;
}

export interface StageFront {
  /** Leg index for multi-leg routes (0 for a single leg). */
  leg: number;
  stage: number;
  totalStages: number;
  /** Sorted across the track within each viaCount. */
  points: FrontPoint[];
  /** The best candidate's path back to the start, [lon, lat] from the start. */
  best: [number, number][];
}

export interface Route {
  waypoints: Waypoint[];
  totalTimeS: number;
  totalDistanceM: number;
  motoringTimeS: number;
  sailingTimeS: number;
  warnings?: RouteWarning[];
  validated: boolean;
  /** Set by the caller when the route runs past the forecast's last step. */
  forecastHorizonExceededS?: number;
  /** The forecast's last valid step (ms since epoch), set by the caller; waypoints after it ran on held conditions. */
  forecastValidToMs?: number;
  /** Set by the caller when a wind or wave limit was in force on legs past the forecast's last step. */
  limitsBeyondForecast?: boolean;
  /** Forecast cycle used, ISO string, when any. */
  forecastCycle?: string;
  /** Names of the current sources that were stacked, when any. */
  currentSources?: string[];
  /** Coarse A* skeleton that guided the heading sweep, when one was found. */
  skeleton?: { lon: number; lat: number }[];
  /**
   * The front of every search stage (the candidates kept after pruning, each
   * with its own arrival time; not equal-time isochrones) and the best path
   * back to the start at that stage. For display only.
   */
  fronts?: StageFront[];
  /** Waypoints the shortcut smoother dropped (RDP thinning not counted, as in the parent). */
  smootherDrops?: number;
  /** Automatic vias the router placed at narrow passages (not waypoints). */
  autoVias?: { lon: number; lat: number; radiusM: number; widthM: number; name: string }[];
}

export function skeletonToGeoJSON(route: Route): Record<string, unknown> | null {
  if (!route.skeleton || route.skeleton.length < 2) return null;
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: route.skeleton.map(p => [p.lon, p.lat]) },
        properties: { kind: 'skeleton', points: route.skeleton.length },
      },
    ],
  };
}

/** Recompute cog / twa / sog on every waypoint from the final geometry. */
export function recomputePerWaypointMetadata(route: Route): void {
  const wps = route.waypoints;
  for (let k = 1; k < wps.length; k++) {
    const prev = wps[k - 1];
    const cur = wps[k];
    cur.cogDeg = haversineBearing(prev.lon, prev.lat, cur.lon, cur.lat);
    if (cur.windDirDeg !== undefined) {
      const raw = (((cur.cogDeg - cur.windDirDeg) % 360) + 360) % 360;
      cur.twaDeg = raw <= 180 ? raw : 360 - raw;
    }
    const dt = (cur.time.getTime() - prev.time.getTime()) / 1000;
    if (dt > 0) cur.sogMs = haversineDistanceM(prev.lon, prev.lat, cur.lon, cur.lat) / dt;
  }
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/**
 * Where the forecast ends relative to the route: its last valid step, how many
 * legs end after it (they ran on conditions held at that step) and by how much
 * the arrival is past it. Null when the caller gave no forecast end.
 */
export function forecastEnd(route: Route): { validTo: Date; legsBeyond: number; beyondS: number } | null {
  if (route.forecastValidToMs === undefined) return null;
  const validTo = new Date(route.forecastValidToMs);
  const wps = route.waypoints;
  let legsBeyond = 0;
  for (let i = 1; i < wps.length; i++) if (wps[i].time.getTime() > route.forecastValidToMs) legsBeyond++;
  const arrival = wps.length ? wps[wps.length - 1].time.getTime() : route.forecastValidToMs;
  return { validTo, legsBeyond, beyondS: Math.max(0, (arrival - route.forecastValidToMs) / 1000) };
}

function finite(v: number | undefined): v is number {
  return v !== undefined && Number.isFinite(v);
}

export function waypointProperties(wp: Waypoint): Record<string, unknown> {
  const d: Record<string, unknown> = {
    lon: round(wp.lon, 6),
    lat: round(wp.lat, 6),
    time: wp.time.toISOString(),
    sog_ms: round(wp.sogMs, 3),
    cog_deg: round(wp.cogDeg, 1),
    depth_m: null,
    mode: wp.mode,
  };
  if (finite(wp.twaDeg)) d.twa_deg = Math.round(wp.twaDeg);
  if (finite(wp.windMs)) d.wind_ms = round(wp.windMs, 3);
  if (finite(wp.windDirDeg)) d.wind_dir_deg = Math.round(wp.windDirDeg);
  if (finite(wp.swhM)) d.swh_m = round(wp.swhM, 2);
  if (finite(wp.mwpS)) d.mwp_s = round(wp.mwpS, 1);
  if (finite(wp.mwdDeg)) d.mwd_deg = Math.round(wp.mwdDeg);
  if (finite(wp.currentMs)) d.current_ms = round(wp.currentMs, 4);
  if (finite(wp.currentDirDeg)) d.current_dir_deg = Math.round(wp.currentDirDeg);
  if (finite(wp.currentUMs)) d.current_u_ms = round(wp.currentUMs, 4);
  if (finite(wp.currentVMs)) d.current_v_ms = round(wp.currentVMs, 4);
  if (wp.leg !== undefined) d.leg = wp.leg;
  if (wp.role !== undefined) d.role = wp.role;
  return d;
}

export function routeToGeoJSON(route: Route): Record<string, unknown> {
  const wps = route.waypoints;
  const props: Record<string, unknown> = {
    total_distance_m: round(route.totalDistanceM, 1),
    total_time_s: round(route.totalTimeS, 1),
    motoring_time_s: round(route.motoringTimeS, 1),
    sailing_time_s: round(route.sailingTimeS, 1),
    departure: wps.length ? wps[0].time.toISOString() : null,
    arrival: wps.length ? wps[wps.length - 1].time.toISOString() : null,
    waypoint_count: wps.length,
    validated: route.validated,
    repairs_applied: 0,
    smoother_drops: route.smootherDrops ?? 0,
  };
  if (route.forecastCycle) props.forecast_cycle = route.forecastCycle;
  if (route.autoVias && route.autoVias.length) {
    props.auto_vias = route.autoVias.map(v => ({
      name: v.name,
      lat: round(v.lat, 6),
      lon: round(v.lon, 6),
      width_m: Math.round(v.widthM),
      radius_m: Math.round(v.radiusM),
    }));
  }
  const fe = forecastEnd(route);
  if (fe) {
    props.forecast_valid_to = fe.validTo.toISOString();
    if (fe.legsBeyond > 0) {
      props.forecast_horizon_exceeded_s = round(route.forecastHorizonExceededS ?? fe.beyondS, 0);
      props.legs_beyond_forecast = fe.legsBeyond;
      props.forecast_horizon_note = `the route arrives after the last forecast step; the last ${fe.legsBeyond} leg${fe.legsBeyond === 1 ? '' : 's'} ran on conditions held at that step`;
      if (route.limitsBeyondForecast) props.limits_beyond_forecast = true;
    }
  }
  if (route.warnings && route.warnings.length) {
    props.warnings = route.warnings;
    const land = route.warnings.filter(w => w.violation === 'leg_crosses_land').length;
    if (land) {
      props.land_crossings = land;
      props.has_land_crossing = true;
    }
  }
  const swh = wps.map(w => w.swhM).filter(finite);
  if (swh.length) {
    props.max_swh_m = round(Math.max(...swh), 2);
    props.avg_swh_m = round(swh.reduce((a, b) => a + b, 0) / swh.length, 2);
  }
  const features: Record<string, unknown>[] = [
    {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: wps.map(w => [w.lon, w.lat]) },
      properties: props,
    },
  ];
  for (let i = 0; i < wps.length; i++) {
    const p = waypointProperties(wps[i]);
    if (fe && wps[i].time.getTime() > fe.validTo.getTime()) p.beyond_forecast = true;
    if (i + 1 < wps.length) {
      const nxt = wps[i + 1];
      p.leg_distance_m = round(haversineDistanceM(wps[i].lon, wps[i].lat, nxt.lon, nxt.lat), 1);
      const legS = (nxt.time.getTime() - wps[i].time.getTime()) / 1000;
      if (legS >= 0) p.leg_time_s = round(legS, 1);
    }
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [wps[i].lon, wps[i].lat] }, properties: p });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Signal K Resources API `routes` record. Coordinates stay strict
 * [lon, lat]; per-waypoint data rides in `properties.coordinatesMeta`,
 * a parallel array of the same length. The server's Route schema
 * requires each coordinatesMeta item to carry a `name` (string) and
 * allows additional properties, so every item is named "WP<n>" and
 * carries the SI waypoint fields alongside.
 */
export function routeToSignalKRoute(route: Route, name: string, description?: string): Record<string, unknown> {
  const wps = route.waypoints;
  const fe = forecastEnd(route);
  const beyondNote =
    fe && fe.legsBeyond > 0
      ? ` Forecast ends ${fe.validTo.toISOString().slice(0, 16).replace('T', ' ')} UTC; the last ${fe.legsBeyond} leg${fe.legsBeyond === 1 ? '' : 's'} ran on conditions held at that step.`
      : '';
  return {
    name,
    // Unit-free: the web app rewrites this (and each point's description) in the
    // user's display units once the route is published.
    description:
      description ??
      `Weather route: ${wps.length} waypoints, sailing ${route.totalTimeS > 0 ? Math.round((100 * route.sailingTimeS) / route.totalTimeS) : 0}% of the time.${beyondNote}`,
    distance: round(route.totalDistanceM, 1),
    start: wps.length ? wps[0].time.toISOString() : undefined,
    end: wps.length ? wps[wps.length - 1].time.toISOString() : undefined,
    feature: {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: wps.map(w => [w.lon, w.lat]) },
      properties: {
        source: 'signalk-weather-router-plus',
        total_time_s: round(route.totalTimeS, 1),
        motoring_time_s: round(route.motoringTimeS, 1),
        sailing_time_s: round(route.sailingTimeS, 1),
        departure: wps.length ? wps[0].time.toISOString() : null,
        arrival: wps.length ? wps[wps.length - 1].time.toISOString() : null,
        ...(fe ? { forecast_valid_to: fe.validTo.toISOString() } : {}),
        ...(fe && fe.legsBeyond > 0 ? { legs_beyond_forecast: fe.legsBeyond } : {}),
        coordinatesMeta: wps.map((w, i) => ({
          name: i === 0 ? 'Start' : i === wps.length - 1 ? 'End' : `WP${i}`,
          ...waypointProperties(w),
          ...(fe && w.time.getTime() > fe.validTo.getTime() ? { beyond_forecast: true } : {}),
        })),
      },
    },
  };
}
