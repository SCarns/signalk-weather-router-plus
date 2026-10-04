/**
 * Areas to avoid: circles the user marks on Signal K notes (a note with a
 * position and `properties.avoid.radius_m`), which the router treats like
 * land (LandMask.withAvoid). A note is any note in the Resources API, so a
 * note another plugin wrote (a passage briefing's area warning) can be
 * marked too.
 */

import { haversineDistanceM, slerpSamples } from './geodesy';

export interface AvoidArea {
  /** The note's id in the Resources API. */
  id: string;
  title: string;
  lon: number;
  lat: number;
  radiusM: number;
}

/** Largest radius taken (500 nautical miles): a larger one is a mistake, not an area. */
export const AVOID_MAX_RADIUS_M = 500 * 1852;

/** The avoid areas among a Resources API notes collection ({ id: note }). */
export function avoidAreasFromNotes(col: Record<string, unknown> | null | undefined): AvoidArea[] {
  const out: AvoidArea[] = [];
  for (const [id, raw] of Object.entries(col ?? {})) {
    const n = raw as {
      title?: unknown;
      name?: unknown;
      position?: { latitude?: unknown; longitude?: unknown };
      properties?: { avoid?: { radius_m?: unknown } };
    };
    const r = n?.properties?.avoid?.radius_m;
    const lat = n?.position?.latitude;
    const lon = n?.position?.longitude;
    if (typeof r !== 'number' || !(r > 0) || r > AVOID_MAX_RADIUS_M) continue;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90)
      continue;
    const title = typeof n.title === 'string' && n.title ? n.title : typeof n.name === 'string' && n.name ? n.name : 'note';
    out.push({ id, title, lon, lat, radiusM: r });
  }
  return out;
}

/** The first area a point lies in, or null. */
export function avoidAt(areas: readonly AvoidArea[], lon: number, lat: number): AvoidArea | null {
  for (const a of areas) if (haversineDistanceM(a.lon, a.lat, lon, lat) <= a.radiusM) return a;
  return null;
}

/** Longitude difference b − a the short way, degrees in (−180, 180]. */
function dLonDeg(a: number, b: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return d === -180 ? 180 : d;
}

/** Leg pieces are at most this long for the flat test (the projection is centred on the circle). */
const PIECE_M = 50_000;

/**
 * The first area a leg a→b passes through, or null. Each circle is tested in
 * a local flat projection centred on it, the leg split into pieces of at
 * most PIECE_M along its great circle, so long legs and large circles stay
 * close to the true geometry.
 */
export function legHitsAvoid(areas: readonly AvoidArea[], lonA: number, latA: number, lonB: number, latB: number): AvoidArea | null {
  if (!areas.length) return null;
  const legM = haversineDistanceM(lonA, latA, lonB, latB);
  const n = Math.max(1, Math.ceil(legM / PIECE_M));
  // The piece ends along the great circle a→b (not a lat/lon straight line).
  const lons = new Float64Array(n + 1);
  const lats = new Float64Array(n + 1);
  slerpSamples(lonA, latA, lonB, latB, n + 1, lons, lats, 0);
  for (const a of areas) {
    // Out of reach: neither end is closer than the circle's radius plus the leg's length.
    const dA = haversineDistanceM(a.lon, a.lat, lonA, latA);
    if (dA <= a.radiusM) return a;
    if (dA > a.radiusM + legM) continue;
    const kx = Math.cos((a.lat * Math.PI) / 180) * 111_320;
    const ky = 110_540;
    const px = (lon: number): number => dLonDeg(a.lon, lon) * kx;
    const py = (lat: number): number => (lat - a.lat) * ky;
    for (let i = 0; i < n; i++) {
      const x0 = px(lons[i]);
      const y0 = py(lats[i]);
      const x1 = px(lons[i + 1]);
      const y1 = py(lats[i + 1]);
      const vx = x1 - x0;
      const vy = y1 - y0;
      const len2 = vx * vx + vy * vy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, -(x0 * vx + y0 * vy) / len2)) : 0;
      if (Math.hypot(x0 + t * vx, y0 + t * vy) <= a.radiusM) return a;
    }
  }
  return null;
}
