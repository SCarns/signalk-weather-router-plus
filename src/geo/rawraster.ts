/**
 * A land raster drawn straight from the coastline tiles' bytes (CoastTiles.forEachRaw), with no object per piece,
 * ring or edge: every array is a scratch kept per thread and reused.
 *
 * Decoding every piece into objects for a whole-world map view grew V8's young generation and the allocator's heap,
 * and Signal K's process kept that: +381 MB after one zoomed-out view, against +18 MB drawn from the bytes, the
 * rasters identical (brain, 2026-10-26, ~/memdiag/coastcut). Routes and the point test still decode their pieces
 * (CoastTiles.forEach): they need the polygons for the exact tests, and read a corridor, not the world.
 *
 * The arithmetic is LandMask.rasterizeShape's, fillShape's and markEdgeCells's, step for step, so the raster is the
 * one LandMask.rasterStreamed makes from the decoded pieces (landcache.test.ts compares them).
 */

import type { BBox } from './geodesy';
import { bboxHeight, bboxWidth, lonOffsetFromWest } from './geodesy';
import { unwrapLonNear } from './angles';
import { LandMask, type RasterStreamOptions } from './landmask';
import type { CoastTiles } from './coasttiles';

/** Per ring of the piece being drawn: where its points start in `xsScratch`, its vertex count, and where its parts are in the bytes. */
let ringStart: Int32Array = new Int32Array(64);
let ringN: Int32Array = new Int32Array(64);
let ringCoord: Int32Array = new Int32Array(64);
let ringShort: Int32Array = new Int32Array(64);
let ringWhole: Int32Array = new Int32Array(64);
let ringWholeEdges: Int32Array = new Int32Array(64);
let ringFlags: Int32Array = new Int32Array(64);
/** The piece's points in the offset frame (degrees east of the box's west), unwrapped along each ring. */
let xsScratch: Float64Array = new Float64Array(1 << 16);
/** The piece's edges that cross a scanline. */
let ex0: Float64Array = new Float64Array(1 << 14);
let ey0: Float64Array = new Float64Array(1 << 14);
let ex1: Float64Array = new Float64Array(1 << 14);
let ey1: Float64Array = new Float64Array(1 << 14);
let eRowStart: Int32Array = new Int32Array(1 << 14);
let eRowEnd: Int32Array = new Int32Array(1 << 14);
/** The edges by first row, the ones met so far, and one row's crossings. */
let order: Int32Array = new Int32Array(1 << 14);
let active: Int32Array = new Int32Array(1 << 14);
let xsRow: Float64Array = new Float64Array(1 << 12);
let rowCount: Int32Array = new Int32Array(1 << 12);
const SHIFTS = [-360, 0, 360];

/** `a`, or a larger array holding its first `keep` entries. */
function growF(a: Float64Array, n: number, keep = 0): Float64Array {
  if (a.length >= n) return a;
  const b = new Float64Array(Math.max(n, 2 * a.length));
  if (keep > 0) b.set(a.subarray(0, keep));
  return b;
}

function growI(a: Int32Array, n: number, keep = 0): Int32Array {
  if (a.length >= n) return a;
  const b = new Int32Array(Math.max(n, 2 * a.length));
  if (keep > 0) b.set(a.subarray(0, keep));
  return b;
}

function markCell(raster: Uint8Array, nx: number, ny: number, j: number, i: number): void {
  if (i >= 0 && i < ny && j >= 0 && j < nx) raster[i * nx + j] = 1;
}

/** LandMask.markEdgeCells, without the closure it makes per call. */
function markEdgeCells(
  xa: number,
  ya: number,
  xb: number,
  yb: number,
  nx: number,
  ny: number,
  res: number,
  south: number,
  raster: Uint8Array,
  width: number
): void {
  if (Math.max(xa, xb) < 0 || Math.min(xa, xb) > width) return;
  if (Math.max(ya, yb) < south || Math.min(ya, yb) > south + ny * res) return;
  const x1 = xa / res;
  const y1 = (ya - south) / res;
  const x2 = xb / res;
  const y2 = (yb - south) / res;
  let cx = Math.floor(x1);
  let cy = Math.floor(y1);
  const ex = Math.floor(x2);
  const ey = Math.floor(y2);
  markCell(raster, nx, ny, cx, cy);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const sx = dx > 0 ? 1 : -1;
  const sy = dy > 0 ? 1 : -1;
  const tDx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  let tMaxX = dx !== 0 ? (sx > 0 ? cx + 1 - x1 : x1 - cx) * tDx : Infinity;
  let tMaxY = dy !== 0 ? (sy > 0 ? cy + 1 - y1 : y1 - cy) * tDy : Infinity;
  if (x1 === cx) markCell(raster, nx, ny, cx - 1, cy);
  if (y1 === cy) markCell(raster, nx, ny, cx, cy - 1);
  const steps = Math.abs(ex - cx) + Math.abs(ey - cy);
  for (let s = 0; s < steps && Math.min(tMaxX, tMaxY) <= 1; s++) {
    if (Math.abs(tMaxX - tMaxY) < 1e-12) {
      markCell(raster, nx, ny, cx + sx, cy);
      markCell(raster, nx, ny, cx, cy + sy);
      cx += sx;
      cy += sy;
      tMaxX += tDx;
      tMaxY += tDy;
      s++;
    } else if (tMaxX < tMaxY) {
      cx += sx;
      tMaxX += tDx;
    } else {
      cy += sy;
      tMaxY += tDy;
    }
    markCell(raster, nx, ny, cx, cy);
  }
  markCell(raster, nx, ny, ex, ey);
}

/** Where edge j's whole coastline edge starts in the piece's doubles (ring r of the piece being drawn), or -1: wholeAt, on the bytes. */
function wholeIn(u32: Uint32Array, r: number, j: number): number {
  let lo = 0;
  let hi = ringShort[r] - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = u32[ringWholeEdges[r] + mid];
    if (e === j) return ringWhole[r] + 4 * mid;
    if (e < j) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * The land raster of `bbox` at `res` from the coastline's tiles, as LandMask.rasterStreamed makes it from the same
 * pieces: conservative (every cell a coastline edge passes through is land) unless `edgeCells` is false. A raster
 * only (no polygons). `pieces`: how many pieces were drawn (per pass).
 */
export function rasterFromTiles(
  coast: CoastTiles,
  bbox: BBox,
  res: number,
  opts: RasterStreamOptions = {}
): { mask: LandMask; pieces: number } {
  const nx = opts.nx ?? Math.max(1, Math.ceil(bboxWidth(bbox) / res));
  const ny = opts.ny ?? Math.max(1, Math.ceil(bboxHeight(bbox) / res));
  const raster = new Uint8Array(nx * ny);
  const width = bboxWidth(bbox);
  const south = bbox.south;
  let pieces = 0;
  for (const boundaryPass of opts.edgeCells !== false ? [false, true] : [false]) {
    pieces = coast.forEachRaw(bbox, (f64, u32, u8, p) => {
      const fillValue = u8[p + 4] % 2;
      const nRings = u32[(p + 12) >> 2];
      if (ringStart.length < nRings) {
        ringStart = growI(ringStart, nRings);
        ringN = growI(ringN, nRings);
        ringCoord = growI(ringCoord, nRings);
        ringShort = growI(ringShort, nRings);
        ringWhole = growI(ringWhole, nRings);
        ringWholeEdges = growI(ringWholeEdges, nRings);
        ringFlags = growI(ringFlags, nRings);
      }
      // The rings' parts in the bytes (encodePiece's layout) and the piece's latitude span.
      let o = p + 16;
      let minLat = Infinity;
      let maxLat = -Infinity;
      let need = 0;
      for (let r = 0; r < nRings; r++) {
        const n = u32[o >> 2];
        const nShort = u32[(o >> 2) + 1];
        const c0 = (o + 8) >> 3;
        for (let i = 0; i < n; i++) {
          const y = f64[c0 + 2 * i + 1];
          if (y < minLat) minLat = y;
          if (y > maxLat) maxLat = y;
        }
        ringCoord[r] = c0;
        ringN[r] = n;
        ringShort[r] = nShort;
        ringWhole[r] = c0 + 2 * n;
        ringWholeEdges[r] = (o + 8 + 16 * n + 32 * nShort) >> 2;
        ringFlags[r] = o + 8 + 16 * n + 32 * nShort + 4 * nShort;
        need += 2 * n;
        o = (ringFlags[r] + n + 7) & ~7;
      }
      const rowLo = Math.max(0, Math.floor((minLat - south) / res));
      const rowHi = Math.min(ny - 1, Math.floor((maxLat - south) / res));
      if (rowLo > rowHi) return;
      // rasterizeShape: the points in the offset frame, each ring unwrapped vertex to vertex.
      xsScratch = growF(xsScratch, need);
      let off = 0;
      for (let r = 0; r < nRings; r++) {
        const c0 = ringCoord[r];
        const n = ringN[r];
        ringStart[r] = off;
        let prev = lonOffsetFromWest(bbox, f64[c0]);
        xsScratch[off] = prev;
        xsScratch[off + 1] = f64[c0 + 1];
        for (let i = 1; i < n; i++) {
          const x = unwrapLonNear(lonOffsetFromWest(bbox, f64[c0 + 2 * i]), prev);
          xsScratch[off + 2 * i] = x;
          xsScratch[off + 2 * i + 1] = f64[c0 + 2 * i + 1];
          prev = x;
        }
        off += 2 * n;
      }
      for (const shift of SHIFTS) {
        let overlaps = false;
        for (let r = 0; r < nRings && !overlaps; r++) {
          let mn = Infinity;
          let mx = -Infinity;
          for (let i = 0; i < ringN[r]; i++) {
            const x = xsScratch[ringStart[r] + 2 * i] + shift;
            if (x < mn) mn = x;
            if (x > mx) mx = x;
          }
          if (mx >= 0 && mn <= width) overlaps = true;
        }
        if (!overlaps) continue;
        // fillShape: the coastline cells (boundary pass), or the edges crossing scanlines.
        let E = 0;
        for (let r = 0; r < nRings; r++) {
          const s0 = ringStart[r];
          const n = ringN[r];
          for (let i = 0, j = n - 1; i < n; j = i++) {
            const xa = xsScratch[s0 + 2 * j] + shift;
            const ya = xsScratch[s0 + 2 * j + 1];
            const xb = xsScratch[s0 + 2 * i] + shift;
            const yb = xsScratch[s0 + 2 * i + 1];
            if (boundaryPass) {
              const flag = u8[ringFlags[r] + j];
              const q = flag === 2 ? wholeIn(u32, r, j) : -1;
              if (q >= 0) {
                const wa = unwrapLonNear(lonOffsetFromWest(bbox, f64[q]), xsScratch[s0 + 2 * j]);
                const wb = unwrapLonNear(lonOffsetFromWest(bbox, f64[q + 2]), wa);
                markEdgeCells(wa + shift, f64[q + 1], wb + shift, f64[q + 3], nx, ny, res, south, raster, width);
              } else if (flag) markEdgeCells(xa, ya, xb, yb, nx, ny, res, south, raster, width);
              continue;
            }
            if (ya === yb) continue;
            const y0 = Math.min(ya, yb);
            const y1 = Math.max(ya, yb);
            let rowStart = Math.ceil((y0 - south) / res - 0.5);
            let rowEnd = Math.ceil((y1 - south) / res - 0.5) - 1;
            if (rowStart < rowLo) rowStart = rowLo;
            if (rowEnd > rowHi) rowEnd = rowHi;
            if (rowStart > rowEnd) continue;
            if (E >= ex0.length) {
              ex0 = growF(ex0, E + 1, E);
              ey0 = growF(ey0, E + 1, E);
              ex1 = growF(ex1, E + 1, E);
              ey1 = growF(ey1, E + 1, E);
              eRowStart = growI(eRowStart, E + 1, E);
              eRowEnd = growI(eRowEnd, E + 1, E);
            }
            ex0[E] = xa;
            ey0[E] = ya;
            ex1[E] = xb;
            ey1[E] = yb;
            eRowStart[E] = rowStart;
            eRowEnd[E] = rowEnd;
            E++;
          }
        }
        if (boundaryPass || E === 0) continue;
        // The edges in order of their first row (a counting sort).
        const rows = rowHi - rowLo + 2;
        rowCount = growI(rowCount, rows);
        rowCount.fill(0, 0, rows);
        for (let e = 0; e < E; e++) rowCount[eRowStart[e] - rowLo + 1]++;
        for (let k = 1; k < rows; k++) rowCount[k] += rowCount[k - 1];
        order = growI(order, E);
        for (let e = 0; e < E; e++) order[rowCount[eRowStart[e] - rowLo]++] = e;
        active = growI(active, E);
        xsRow = growF(xsRow, E);
        let nActive = 0;
        let next = 0;
        for (let row = rowLo; row <= rowHi; row++) {
          while (next < E && eRowStart[order[next]] === row) active[nActive++] = order[next++];
          if (nActive === 0) continue;
          const lat = south + (row + 0.5) * res;
          let nCross = 0;
          let anyLeft = false;
          for (let a = 0; a < nActive; a++) {
            const e = active[a];
            if (row > eRowEnd[e]) continue;
            anyLeft = true;
            const t = (lat - ey0[e]) / (ey1[e] - ey0[e]);
            xsRow[nCross++] = ex0[e] + t * (ex1[e] - ex0[e]);
          }
          if (!anyLeft) {
            nActive = 0;
            continue;
          }
          if (row % 64 === 0) {
            let w = 0;
            for (let a = 0; a < nActive; a++) if (row <= eRowEnd[active[a]]) active[w++] = active[a];
            nActive = w;
          }
          // Ascending, in place: a handful of crossings per row.
          for (let a = 1; a < nCross; a++) {
            const v = xsRow[a];
            let b = a - 1;
            while (b >= 0 && xsRow[b] > v) {
              xsRow[b + 1] = xsRow[b];
              b--;
            }
            xsRow[b + 1] = v;
          }
          const base = row * nx;
          for (let k = 0; k + 1 < nCross; k += 2) {
            let jStart = Math.ceil(xsRow[k] / res - 0.5);
            let jEnd = Math.ceil(xsRow[k + 1] / res - 0.5) - 1;
            if (jStart < 0) jStart = 0;
            if (jEnd > nx - 1) jEnd = nx - 1;
            for (let j = jStart; j <= jEnd; j++) raster[base + j] = fillValue;
          }
        }
      }
    });
  }
  return { mask: LandMask.fromRaster({ bbox, resolutionDeg: res, raster }, { nx, ny }), pieces };
}
