/**
 * Angle and longitude arithmetic, each written once. The formulas are
 * the ones the code used inline (operation for operation), so results
 * are bit-identical to before; the golden sampler and route tests hold
 * that.
 */

/** Any angle in degrees → [0, 360). */
export function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Longitude → [-180, 180). */
export function wrapLon(lon: number): number {
  let x = ((((lon + 180) % 360) + 360) % 360) - 180;
  if (x === 180) x = -180;
  return x;
}

/** Eastward offset of `lon` from `lon0`, degrees in [0, 360). */
export function lonOffset(lon: number, lon0: number): number {
  return (((lon - lon0) % 360) + 360) % 360;
}

/** `lon` expressed within 180° of `ref` (same point, unwrapped across the seam). */
export function unwrapLonNear(lon: number, ref: number): number {
  let x = lon;
  while (x - ref > 180) x -= 360;
  while (x - ref < -180) x += 360;
  return x;
}

/** True wind angle in [0, 180] for a heading and a wind FROM direction, degrees true. */
export function twaFromHeading(headingDeg: number, windFromDeg: number): number {
  let twa = (((headingDeg - windFromDeg) % 360) + 360) % 360;
  if (twa > 180) twa = 360 - twa;
  return twa;
}

/** A signed or over-range true wind angle mirrored into [0, 180]. */
export function foldTwa(twaDeg: number): number {
  let twa = Math.abs(twaDeg) % 360;
  if (twa > 180) twa = 360 - twa;
  return twa;
}
