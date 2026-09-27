/**
 * Spherical geodesy helpers. All distances in metres, angles in degrees
 * unless a name says otherwise. Longitudes are kept in [-180, 180).
 *
 * Earth radius matches the routing engine this is ported from
 * (6 371 008.8 m, the IUGG mean radius).
 */

export const R_EARTH_M = 6371008.8;
export const KTS_TO_MS = 1852 / 3600;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/** Wrap a longitude into [-180, 180). */
export function wrapLon(lon: number): number {
  let x = ((lon + 180) % 360 + 360) % 360 - 180;
  if (x === 180) x = -180;
  return x;
}

/** Great-circle distance in metres. */
export function haversineDistanceM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const la1 = lat1 * DEG;
  const la2 = lat2 * DEG;
  const dlat = la2 - la1;
  const dlon = (lon2 - lon1) * DEG;
  const a = Math.sin(dlat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.sqrt(Math.min(1, a)));
}

/** Initial bearing in degrees, 0 = north, 90 = east, in [0, 360). */
export function haversineBearing(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const la1 = lat1 * DEG;
  const la2 = lat2 * DEG;
  const dlon = (lon2 - lon1) * DEG;
  const x = Math.sin(dlon) * Math.cos(la2);
  const y = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dlon);
  return ((Math.atan2(x, y) * RAD) % 360 + 360) % 360;
}

/**
 * Advance (lon, lat) along a great circle by `distanceM` on `bearingDeg`.
 * Returns [lon, lat] with the longitude wrapped to [-180, 180).
 */
export function projectAlongBearing(
  lon: number, lat: number, bearingDeg: number, distanceM: number,
): [number, number] {
  const la1 = lat * DEG;
  const lo1 = lon * DEG;
  const brg = bearingDeg * DEG;
  const ang = distanceM / R_EARTH_M;
  const sinLat1 = Math.sin(la1);
  const cosLat1 = Math.cos(la1);
  const sinAng = Math.sin(ang);
  const cosAng = Math.cos(ang);
  const sinLat2 = Math.max(-1, Math.min(1, sinLat1 * cosAng + cosLat1 * sinAng * Math.cos(brg)));
  const lat2 = Math.asin(sinLat2);
  const y = Math.sin(brg) * sinAng * cosLat1;
  const x = cosAng - sinLat1 * sinLat2;
  let lon2 = lo1 + Math.atan2(y, x);
  lon2 = ((lon2 + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return [lon2 * RAD, lat2 * RAD];
}

/**
 * Signed cross-track offset of a point from the great circle through
 * (refStart → refEnd), metres. Negative = left of the track, positive =
 * right (the standard cross-track formula's sign). Only consistency
 * matters to the caller, which bins by this value.
 */
export function perpendicularOffsetM(
  sLon: number, sLat: number, eLon: number, eLat: number, lon: number, lat: number,
): number {
  const bearingRef = haversineBearing(sLon, sLat, eLon, eLat) * DEG;
  const sLatR = sLat * DEG;
  const sLonR = sLon * DEG;
  const pLatR = lat * DEG;
  const pLonR = lon * DEG;
  const dlat = pLatR - sLatR;
  const dlon = pLonR - sLonR;
  const aHav = Math.sin(dlat / 2) ** 2 + Math.cos(sLatR) * Math.cos(pLatR) * Math.sin(dlon / 2) ** 2;
  const d13 = 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, aHav))));
  const y = Math.sin(dlon) * Math.cos(pLatR);
  const x = Math.cos(sLatR) * Math.sin(pLatR) - Math.sin(sLatR) * Math.cos(pLatR) * Math.cos(dlon);
  const bearingToPt = Math.atan2(y, x);
  return R_EARTH_M * Math.asin(Math.max(-1, Math.min(1, Math.sin(d13) * Math.sin(bearingToPt - bearingRef))));
}

/**
 * Does the great-circle segment (lon1,lat1)→(lon2,lat2) come within `rM`
 * of (vLon, vLat)? Segment test, not endpoint test: cross-track plus
 * along-track, with the endpoints checked first.
 */
export function segmentWithinDisc(
  lon1: number, lat1: number, lon2: number, lat2: number, vLon: number, vLat: number, rM: number,
): boolean {
  const d1 = haversineDistanceM(lon1, lat1, vLon, vLat);
  if (d1 <= rM) return true;
  const d2 = haversineDistanceM(lon2, lat2, vLon, vLat);
  if (d2 <= rM) return true;
  const d12 = haversineDistanceM(lon1, lat1, lon2, lat2);
  if (d12 <= 0) return false;
  const brg12 = haversineBearing(lon1, lat1, lon2, lat2) * DEG;
  const brg1v = haversineBearing(lon1, lat1, vLon, vLat) * DEG;
  const d1vAng = d1 / R_EARTH_M;
  const sinXt = Math.max(-1, Math.min(1, Math.sin(d1vAng) * Math.sin(brg1v - brg12)));
  const dXt = Math.asin(sinXt) * R_EARTH_M;
  if (Math.abs(dXt) > rM) return false;
  if (Math.cos(brg1v - brg12) < 0) return false;
  const cosXtAng = Math.cos(dXt / R_EARTH_M);
  if (Math.abs(cosXtAng) < 1e-12) return false;
  const cosAt = Math.max(-1, Math.min(1, Math.cos(d1vAng) / cosXtAng));
  const dAt = Math.acos(cosAt) * R_EARTH_M;
  return dAt >= 0 && dAt <= d12;
}

/**
 * Sample `n` points along the great circle from a to b (inclusive of
 * both ends) by spherical linear interpolation. Writes into the
 * provided arrays starting at `offset`. Handles antimeridian crossing.
 */
export function slerpSamples(
  lon1: number, lat1: number, lon2: number, lat2: number, n: number,
  outLon: Float64Array, outLat: Float64Array, offset: number,
): void {
  const la1 = lat1 * DEG;
  const lo1 = lon1 * DEG;
  const la2 = lat2 * DEG;
  const lo2 = lon2 * DEG;
  const dlat = la2 - la1;
  const dlon = lo2 - lo1;
  const aHav = Math.sin(dlat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlon / 2) ** 2;
  const d = 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, aHav))));
  const sinD = Math.sin(d);
  const c1 = Math.cos(la1);
  const c2 = Math.cos(la2);
  const x1 = c1 * Math.cos(lo1);
  const y1 = c1 * Math.sin(lo1);
  const z1 = Math.sin(la1);
  const x2 = c2 * Math.cos(lo2);
  const y2 = c2 * Math.sin(lo2);
  const z2 = Math.sin(la2);
  for (let k = 0; k < n; k++) {
    const f = n === 1 ? 0 : k / (n - 1);
    let A: number;
    let B: number;
    if (sinD > 1e-12) {
      A = Math.sin((1 - f) * d) / sinD;
      B = Math.sin(f * d) / sinD;
    } else {
      A = 1;
      B = 0;
    }
    const x = A * x1 + B * x2;
    const y = A * y1 + B * y2;
    const z = A * z1 + B * z2;
    outLat[offset + k] = Math.atan2(z, Math.hypot(x, y)) * RAD;
    outLon[offset + k] = Math.atan2(y, x) * RAD;
  }
}

/** Axis-aligned lon/lat box. `west` may exceed `east` when crossing the antimeridian. */
export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Longitudinal width in degrees, taking the short way round if west > east. */
export function bboxWidth(b: BBox): number {
  const w = b.east - b.west;
  return w >= 0 ? w : w + 360;
}

export function bboxHeight(b: BBox): number {
  return b.north - b.south;
}

/** Offset of `lon` east of the box's west edge, in [0, 360). */
export function lonOffsetFromWest(b: BBox, lon: number): number {
  return ((lon - b.west) % 360 + 360) % 360;
}

export function bboxContains(b: BBox, lon: number, lat: number): boolean {
  if (lat < b.south || lat > b.north) return false;
  return lonOffsetFromWest(b, lon) <= bboxWidth(b);
}

/**
 * Enclosing box for a set of points, choosing the short way round the
 * antimeridian, with optional padding in degrees.
 */
export function bboxFromLonLat(lons: number[], lats: number[], padLon = 0, padLat = padLon): BBox {
  if (lons.length === 0 || lons.length !== lats.length) {
    throw new Error('bboxFromLonLat needs at least one point');
  }
  const ref = lons[0];
  let wmin = Infinity;
  let wmax = -Infinity;
  for (const L of lons) {
    const shifted = ((L - ref + 180) % 360 + 360) % 360 - 180 + ref;
    if (shifted < wmin) wmin = shifted;
    if (shifted > wmax) wmax = shifted;
  }
  wmin -= padLon;
  wmax += padLon;
  let south = Math.min(...lats) - padLat;
  let north = Math.max(...lats) + padLat;
  if (south < -90) south = -90;
  if (north > 90) north = 90;
  if (wmax - wmin >= 360) {
    return { west: -180, south, east: 180, north };
  }
  return { west: wrapLon(wmin), south, east: wrapLon(wmax), north };
}
