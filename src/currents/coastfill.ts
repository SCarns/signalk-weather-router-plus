/**
 * Coastal extension of a gridded current field, for display only.
 *
 * A ~9 km ocean model (CMEMS SMOC, RTOFS) leaves the cells next to the
 * coast empty, so a heatmap or arrow layer drawn from it stops one cell
 * (up to ~9 km) short of the shoreline. For the overlay endpoints, a
 * missing cell (u or v not finite) that has valid cells within
 * FILL_RADIUS_CELLS source-grid cells (Euclidean, in cells) takes the
 * inverse-distance-squared weighted mean of those valid cells (u and v
 * with the same weights, no fade); cells farther than that stay missing.
 * Valid cells are never changed. The page's screen-resolution land mask
 * then cuts the colour exactly at the coastline.
 *
 * Routing and the conditions popup never use this: they sample the raw
 * field (`at`), where a missing corner means "no data".
 */

import type { FieldGrid } from '../data/forecast';
import { lonOffset } from '../geo/angles';

export const FILL_RADIUS_CELLS = 2;

interface Offset {
  dr: number;
  dc: number;
  w: number;
}

/** Neighbour offsets within the radius (excluding the cell itself), with IDW² weights. */
const OFFSETS: Offset[] = (() => {
  const out: Offset[] = [];
  const R = FILL_RADIUS_CELLS;
  for (let dr = -R; dr <= R; dr++) {
    for (let dc = -R; dc <= R; dc++) {
      if (dr === 0 && dc === 0) continue;
      const d2 = dr * dr + dc * dc;
      if (d2 > R * R) continue;
      out.push({ dr, dc, w: 1 / d2 });
    }
  }
  return out;
})();

/**
 * A pair of co-located u/v grids as flat row-major arrays (row 0 at
 * the south), `offset` elements into `u` / `v` (one time step of a
 * multi-step block). `wrap` = columns span the full circle.
 */
export interface PairGrid {
  nRows: number;
  nCols: number;
  wrap: boolean;
  u: Float32Array;
  v: Float32Array;
  offset: number;
}

const out2: [number, number] = [NaN, NaN];

/**
 * Display value of cell (r, c): the raw value when valid, else the IDW²
 * mean of valid cells within FILL_RADIUS_CELLS, else NaN. Returns a
 * shared tuple (copy it before the next call).
 */
export function filledCell(g: PairGrid, r: number, c: number): [number, number] {
  const i = g.offset + r * g.nCols + c;
  const u0 = g.u[i];
  const v0 = g.v[i];
  if (Number.isFinite(u0) && Number.isFinite(v0)) {
    out2[0] = u0;
    out2[1] = v0;
    return out2;
  }
  let su = 0;
  let sv = 0;
  let sw = 0;
  for (const o of OFFSETS) {
    const rr = r + o.dr;
    if (rr < 0 || rr >= g.nRows) continue;
    let cc = c + o.dc;
    if (cc < 0 || cc >= g.nCols) {
      if (!g.wrap) continue;
      cc = ((cc % g.nCols) + g.nCols) % g.nCols;
    }
    const j = g.offset + rr * g.nCols + cc;
    const u = g.u[j];
    const v = g.v[j];
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
    su += o.w * u;
    sv += o.w * v;
    sw += o.w;
  }
  if (sw === 0) {
    out2[0] = NaN;
    out2[1] = NaN;
  } else {
    out2[0] = su / sw;
    out2[1] = sv / sw;
  }
  return out2;
}

/**
 * Bilinear sample of the display (filled) field at fractional cell
 * coordinates (x = column, y = row), both already inside the grid
 * (0 ≤ x ≤ nCols − 1, or < nCols when wrapping; 0 ≤ y ≤ nRows − 1).
 * NaN when a corner with a non-zero weight stays missing after the fill.
 */
export function bilinearFilled(g: PairGrid, x: number, y: number): [number, number] {
  let c = Math.floor(x);
  let r = Math.floor(y);
  if (g.wrap) {
    if (c >= g.nCols) c -= g.nCols;
  } else if (g.nCols === 1) c = 0;
  else c = Math.max(0, Math.min(g.nCols - 2, c));
  if (g.nRows === 1) r = 0;
  else r = Math.max(0, Math.min(g.nRows - 2, r));
  const tx = g.nCols === 1 ? 0 : x - (g.wrap ? Math.floor(x) : c);
  const ty = g.nRows === 1 ? 0 : y - r;
  const c1 = g.wrap ? (c + 1 === g.nCols ? 0 : c + 1) : Math.min(g.nCols - 1, c + 1);
  const r1 = Math.min(g.nRows - 1, r + 1);
  const [u00, v00] = filledCell(g, r, c);
  const [u01, v01] = filledCell(g, r, c1);
  const [u10, v10] = filledCell(g, r1, c);
  const [u11, v11] = filledCell(g, r1, c1);
  if (!(Number.isFinite(u00) && Number.isFinite(u01) && Number.isFinite(u10) && Number.isFinite(u11))) {
    // A corner stays missing: only corners with a non-zero weight count
    // (so a point exactly on a filled node or edge keeps its value).
    let su = 0;
    let sv = 0;
    const corners: [number, number, number][] = [
      [(1 - tx) * (1 - ty), u00, v00],
      [tx * (1 - ty), u01, v01],
      [(1 - tx) * ty, u10, v10],
      [tx * ty, u11, v11],
    ];
    for (const [w, cu, cv] of corners) {
      if (w === 0) continue;
      if (!Number.isFinite(cu)) return [NaN, NaN];
      su += w * cu;
      sv += w * cv;
    }
    return [su, sv];
  }
  const ua = u00 + tx * (u01 - u00);
  const ub = u10 + tx * (u11 - u10);
  const va = v00 + tx * (v01 - v00);
  const vb = v10 + tx * (v11 - v10);
  return [ua + ty * (ub - ua), va + ty * (vb - va)];
}

/**
 * Display sample of a u/v FieldGrid pair at (lon, lat), with the same
 * index arithmetic as forecast.ts sampleField (longitude offset from
 * lon0, edge clamping on a cropped grid, wrap on a full-circle grid).
 */
export function sampleFieldPairFilled(fu: FieldGrid, fv: FieldGrid, lon: number, lat: number): [number, number] {
  const { nLat, nLon } = fu;
  const g: PairGrid = { nRows: nLat, nCols: nLon, wrap: !!fu.wrapLon, u: fu.values, v: fv.values, offset: 0 };
  let x: number;
  if (fu.wrapLon) {
    x = lonOffset(lon, fu.lon0) / fu.dLon;
  } else {
    const offLon = lonOffset(lon, fu.lon0);
    x = offLon > 180 ? (offLon - 360) / fu.dLon : offLon / fu.dLon;
    if (x < 0) x = 0;
    if (x > nLon - 1) x = nLon - 1;
  }
  let y = (lat - fu.lat0) / fu.dLat;
  if (y < 0) y = 0;
  if (y > nLat - 1) y = nLat - 1;
  return bilinearFilled(g, x, y);
}

// ─────────── scalar fields (sea level) ───────────

/**
 * One scalar grid as a flat row-major array (row 0 at the south),
 * `offset` elements into `v` (one time step of a multi-step block).
 */
export interface ScalarGrid {
  nRows: number;
  nCols: number;
  wrap: boolean;
  v: Float32Array;
  offset: number;
}

/**
 * Display value of cell (r, c) of a scalar grid: the raw value when
 * valid, else the IDW² mean of valid cells within FILL_RADIUS_CELLS
 * (same rule and weights as filledCell), else NaN.
 */
export function filledScalarCell(g: ScalarGrid, r: number, c: number): number {
  const v0 = g.v[g.offset + r * g.nCols + c];
  if (Number.isFinite(v0)) return v0;
  let s = 0;
  let sw = 0;
  for (const o of OFFSETS) {
    const rr = r + o.dr;
    if (rr < 0 || rr >= g.nRows) continue;
    let cc = c + o.dc;
    if (cc < 0 || cc >= g.nCols) {
      if (!g.wrap) continue;
      cc = ((cc % g.nCols) + g.nCols) % g.nCols;
    }
    const x = g.v[g.offset + rr * g.nCols + cc];
    if (!Number.isFinite(x)) continue;
    s += o.w * x;
    sw += o.w;
  }
  return sw === 0 ? NaN : s / sw;
}

/**
 * Bilinear sample of a scalar grid at fractional cell coordinates
 * (x = column, y = row, inside the grid) with the coastal fill applied
 * to missing corners. `filled`: a corner with a non-zero weight was
 * missing and took the fill value (the result is an extrapolation).
 * `value` is NaN when such a corner stays missing after the fill.
 */
export function bilinearFilledScalar(g: ScalarGrid, x: number, y: number): { value: number; filled: boolean } {
  let c = Math.floor(x);
  let r = Math.floor(y);
  if (g.wrap) {
    if (c >= g.nCols) c -= g.nCols;
  } else if (g.nCols === 1) c = 0;
  else c = Math.max(0, Math.min(g.nCols - 2, c));
  if (g.nRows === 1) r = 0;
  else r = Math.max(0, Math.min(g.nRows - 2, r));
  const tx = g.nCols === 1 ? 0 : x - (g.wrap ? Math.floor(x) : c);
  const ty = g.nRows === 1 ? 0 : y - r;
  const c1 = g.wrap ? (c + 1 === g.nCols ? 0 : c + 1) : Math.min(g.nCols - 1, c + 1);
  const r1 = Math.min(g.nRows - 1, r + 1);
  const corners: [number, number, number][] = [
    [(1 - tx) * (1 - ty), r, c],
    [tx * (1 - ty), r, c1],
    [(1 - tx) * ty, r1, c],
    [tx * ty, r1, c1],
  ];
  let s = 0;
  let filled = false;
  for (const [w, rr, cc] of corners) {
    if (w === 0) continue;
    const raw = g.v[g.offset + rr * g.nCols + cc];
    let v = raw;
    if (!Number.isFinite(raw)) {
      v = filledScalarCell(g, rr, cc);
      if (!Number.isFinite(v)) return { value: NaN, filled: true };
      filled = true;
    }
    s += w * v;
  }
  return { value: s, filled };
}
