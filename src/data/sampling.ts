/**
 * The one bilinear sampler: grid coordinates of a position, the four
 * corner cells with their weights, and the interpolation. Written with the
 * operations the samplers in forecast.ts, arco.ts and coastfill.ts used,
 * so results are bit-identical (held by src/data/sampling.golden.test.ts).
 *
 * Conventions: rows from the south, columns from `lon0` eastward; a
 * full-circle grid (`wrap`) blends the last column into the first, a
 * cropped grid clamps to its edge cells (extrapolating would invent
 * values); latitude always clamps.
 */

import { lonOffset } from '../geo/angles';

export interface GridGeometry {
  lat0: number;
  lon0: number;
  dLat: number;
  dLon: number;
  nLat: number;
  nLon: number;
  wrapLon?: boolean;
}

/**
 * Fractional grid coordinates (x = column, y = row) of a position: the
 * longitude as an eastward offset from the first column (going west when
 * that is shorter, on a cropped grid), clamped to the grid on a cropped
 * grid and unbounded on a wrapping one; the latitude always clamped.
 */
export function gridXY(f: GridGeometry, lon: number, lat: number): [number, number] {
  let x: number;
  if (f.wrapLon) {
    x = lonOffset(lon, f.lon0) / f.dLon;
  } else {
    const offLon = lonOffset(lon, f.lon0);
    x = offLon > 180 ? (offLon - 360) / f.dLon : offLon / f.dLon;
    if (x < 0) x = 0;
    if (x > f.nLon - 1) x = f.nLon - 1;
  }
  let y = (lat - f.lat0) / f.dLat;
  if (y < 0) y = 0;
  if (y > f.nLat - 1) y = f.nLat - 1;
  return [x, y];
}

export interface Corners {
  /** Lower-left corner cell (row, column) and the next row / column (wrapped or clamped). */
  r: number;
  c: number;
  r1: number;
  c1: number;
  /** Weights towards c1 and r1. */
  tx: number;
  ty: number;
  /** Flat row-major indices of the four corners. */
  i00: number;
  i01: number;
  i10: number;
  i11: number;
}

/**
 * The four corner cells and weights for fractional cell coordinates on an
 * nRows × nCols block (`wrap`: the columns span the full circle). A
 * single-row or single-column block collapses that axis.
 */
export function bilinearCorners(nRows: number, nCols: number, wrap: boolean, x: number, y: number): Corners {
  let c = Math.floor(x);
  let r = Math.floor(y);
  if (wrap) {
    if (c >= nCols) c -= nCols;
  } else if (nCols === 1) c = 0;
  else c = Math.max(0, Math.min(nCols - 2, c));
  if (nRows === 1) r = 0;
  else r = Math.max(0, Math.min(nRows - 2, r));
  const tx = nCols === 1 ? 0 : x - (wrap ? Math.floor(x) : c);
  const ty = nRows === 1 ? 0 : y - r;
  const c1 = wrap ? (c + 1 === nCols ? 0 : c + 1) : Math.min(nCols - 1, c + 1);
  const r1 = Math.min(nRows - 1, r + 1);
  return { r, c, r1, c1, tx, ty, i00: r * nCols + c, i01: r * nCols + c1, i10: r1 * nCols + c, i11: r1 * nCols + c1 };
}

/** Bilinear interpolation of the four corner values. */
export function lerp2(v00: number, v01: number, v10: number, v11: number, tx: number, ty: number): number {
  const a = v00 + tx * (v01 - v00);
  const b = v10 + tx * (v11 - v10);
  return a + ty * (b - a);
}
