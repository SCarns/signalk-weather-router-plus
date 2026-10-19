/**
 * The meteogram of a finished route (GET /api/routes/:id/meteogram): where
 * the boat is at each time step of the passage, and the conditions there
 * and then, as TimeZero's "weather along the route" graph shows them.
 *
 * The boat's track comes from the route's points (GeoJSON Point features,
 * in order, each with its `time`): between two points it sails the great
 * circle at the leg's even pace, so a sample `f` of the way through a
 * leg's time is `f` of the way along its distance. The values a point
 * carries describe the leg into it (routeformat.ts), so a sample on the
 * leg from point i to point i+1 takes its mode and speed from point i+1.
 * The data worker samples the forecast at each (position, time)
 * (worker/query.ts `track_conditions`), with the regional wind models the
 * route was computed with layered over ECMWF as the router layers them;
 * the angle of the wind to the course is worked out from that wind, not
 * the leg's.
 *
 * SI throughout: m/s, m, Pa, K, degrees for directions.
 */

import { haversineBearing, haversineDistanceM, projectAlongBearing } from '../geo/geodesy';
import { norm360, wrapLon } from '../geo/angles';
import type { TrackConditionsRow } from './protocol';

/** Step between samples, s: default, smallest and largest. */
export const METEOGRAM_STEP_S = { default: 3600, min: 600, max: 6 * 3600 };
/** At most this many samples; a longer passage takes a coarser step. */
export const METEOGRAM_MAX_SAMPLES = 1000;

/** One route point as the GeoJSON carries it (the fields this module reads). */
interface RoutePoint {
  lon: number;
  lat: number;
  tMs: number;
  mode: string | null;
  sogMs: number | null;
}

/** Where the boat is at one sample time. */
export interface TrackSample {
  time: string;
  tMs: number;
  lon: number;
  lat: number;
  /** Index of the leg (0 = from the start to the first point after it). */
  leg: number;
  /** sailing or motoring, as the route planned the leg. */
  mode: string | null;
  /** The leg's speed over ground, m/s (null at a zero-length passage). */
  sog_ms: number | null;
  /** Course over ground, degrees true: the great circle's bearing at the sample. */
  cog_deg: number | null;
}

/** A meteogram row: the track sample, the conditions there, and the wind relative to the course. */
export type MeteogramRow = TrackSample &
  TrackConditionsRow & {
    /** True wind angle, 0..180 degrees (0 = head to wind), from the sampled wind and the course. */
    twa_deg: number | null;
    /** The side the wind comes from: port or starboard (null head to wind, dead downwind or no wind). */
    tack: 'port' | 'starboard' | null;
    /** After the forecast's last step: the values are those held at that step. */
    beyond_forecast: boolean;
  };

export interface Meteogram {
  departure: string;
  arrival: string;
  step_s: number;
  /** The ECMWF run the rows were sampled from, and its last valid time. */
  forecast_cycle: string;
  forecast_valid_to: string;
  /** The regional wind runs layered over it where the route used them; each row's `wind_source` names the model that answered. */
  regional_wind: { name: string; cycle: string }[];
  /** Regional models the route used that have no decoded run now: ECMWF answers there instead. */
  regional_wind_missing: string[];
  /** The sample step was raised from the one asked for to keep the row count in bounds. */
  step_raised: boolean;
  rows: MeteogramRow[];
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The route's points in time order, from a route job's GeoJSON. Throws when there are fewer than two. */
export function routePoints(geojson: unknown): RoutePoint[] {
  const features = (geojson as { features?: unknown[] } | null)?.features;
  if (!Array.isArray(features)) throw new Error('route has no features');
  const out: RoutePoint[] = [];
  for (const f of features as { geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> }[]) {
    if (f?.geometry?.type !== 'Point') continue;
    const c = f.geometry.coordinates as number[];
    const p = f.properties ?? {};
    const tMs = Date.parse(String(p.time));
    const lon = num(c?.[0]);
    const lat = num(c?.[1]);
    if (lon === null || lat === null || !Number.isFinite(tMs)) continue;
    out.push({ lon, lat, tMs, mode: typeof p.mode === 'string' ? p.mode : null, sogMs: num(p.sog_ms) });
  }
  out.sort((a, b) => a.tMs - b.tMs);
  if (out.length < 2) throw new Error('route has fewer than two timed points');
  return out;
}

/**
 * The sample step actually used: the one asked for, raised (in whole
 * minutes) when the passage would need more than METEOGRAM_MAX_SAMPLES.
 */
export function sampleStep(durationS: number, stepS: number): { stepS: number; raised: boolean } {
  const need = Math.ceil(durationS / METEOGRAM_MAX_SAMPLES);
  if (stepS >= need) return { stepS, raised: false };
  return { stepS: Math.ceil(need / 60) * 60, raised: true };
}

/** The boat's position, leg and course at each step from departure to arrival (both included). */
export function trackSamples(points: RoutePoint[], stepS: number): TrackSample[] {
  const t0 = points[0].tMs;
  const tN = points[points.length - 1].tMs;
  const times: number[] = [];
  for (let t = t0; t < tN; t += stepS * 1000) times.push(t);
  times.push(tN);
  const out: TrackSample[] = [];
  let i = 0; // leg from points[i] to points[i + 1]
  for (const t of times) {
    while (i < points.length - 2 && points[i + 1].tMs <= t) i++;
    const a = points[i];
    const b = points[i + 1];
    const span = b.tMs - a.tMs;
    const f = span > 0 ? Math.min(1, Math.max(0, (t - a.tMs) / span)) : 1;
    const legM = haversineDistanceM(a.lon, a.lat, b.lon, b.lat);
    let lon = b.lon;
    let lat = b.lat;
    let cog: number | null = null;
    if (legM > 0) {
      const bearing = haversineBearing(a.lon, a.lat, b.lon, b.lat);
      [lon, lat] = f < 1 ? projectAlongBearing(a.lon, a.lat, bearing, f * legM) : [b.lon, b.lat];
      // The course at the sample: the bearing on from here (the great circle's, which turns along a long leg).
      cog = f < 1 ? haversineBearing(lon, lat, b.lon, b.lat) : norm360(haversineBearing(b.lon, b.lat, a.lon, a.lat) + 180);
    }
    out.push({
      time: new Date(t).toISOString(),
      tMs: t,
      lon: wrapLon(lon),
      lat,
      leg: i,
      mode: b.mode,
      sog_ms: b.sogMs,
      cog_deg: cog === null ? null : Math.round(norm360(cog) * 10) / 10,
    });
  }
  return out;
}

/** True wind angle (0..180) and the side it comes from, for a wind FROM `windDirDeg` on course `cogDeg`. */
export function trueWindAngle(windDirDeg: number | null, cogDeg: number | null): { twa: number | null; tack: 'port' | 'starboard' | null } {
  if (windDirDeg === null || cogDeg === null) return { twa: null, tack: null };
  // Signed: positive when the wind is on the starboard side.
  const rel = ((((windDirDeg - cogDeg) % 360) + 540) % 360) - 180;
  const twa = Math.abs(rel);
  const tack = twa < 0.5 || twa > 179.5 ? null : rel > 0 ? 'starboard' : 'port';
  return { twa: Math.round(twa), tack };
}

/** The rows of the meteogram: each track sample with the conditions sampled for it. */
export function meteogramRows(samples: TrackSample[], conditions: TrackConditionsRow[], validToMs: number | null): MeteogramRow[] {
  if (conditions.length !== samples.length) throw new Error(`expected ${samples.length} conditions rows, got ${conditions.length}`);
  return samples.map((s, k) => {
    const c = conditions[k];
    const { twa, tack } = trueWindAngle(c.wind_dir_deg, s.cog_deg);
    return {
      ...c,
      ...s,
      twa_deg: twa,
      tack,
      beyond_forecast: validToMs !== null && s.tMs > validToMs,
    };
  });
}
