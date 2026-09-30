/**
 * Land mask built from coastline polygons (GSHHG L1 or OSM land
 * polygons), rasterised over a route bounding box.
 *
 * Two query paths, mirroring the routing engine this is ported from:
 *  - `isLandBulk` / `legsCrossLandBulk`: raster lookup, O(1) per sample,
 *    used in the propagator's hot per-stage candidate filter.
 *  - `isLandExact`: even-odd point-in-polygon against the source
 *    polygons, used for endpoints and the final validation pass.
 *
 * The raster is conservative: a cell is land if its centre is inside a
 * polygon OR a polygon edge passes through it. That second rule stands
 * in for the buffered-polygon test in the original (peninsulas narrower
 * than a cell must still block a leg). `rasterStreamed` can also build a
 * centre-sampled raster (land iff the cell centre is inside a polygon),
 * used by the global water grid build.
 *
 * Local refinement: `refine(bbox, res)` rasterises a finer patch over a
 * small box (from the loaded polygons) that then answers `isLand` inside
 * it, so a passage the base resolution closes (a strait narrower than
 * two base cells) can be opened locally without a finer raster for the
 * whole route.
 */

import type { BBox } from './geodesy';
import { bboxHeight, bboxWidth, lonOffsetFromWest, slerpSamples, haversineDistanceM } from './geodesy';
import { pointInShape, readShapefilePolygons, type ShapePolygon } from './shapefile';

export interface SerializedLandRaster {
  bbox: BBox;
  resolutionDeg: number;
  raster: Uint8Array;
}

/** Finer raster over a small box that overrides the base raster inside it. */
export interface LandPatch {
  bbox: BBox;
  resolutionDeg: number;
  nx: number;
  ny: number;
  raster: Uint8Array;
}

export interface RasterStreamOptions {
  /** Also mark every cell a polygon edge passes through (default true: conservative). */
  edgeCells?: boolean;
  /** Explicit raster size (avoids ceil() rounding of width / res); must cover the bbox. */
  nx?: number;
  ny?: number;
}

export interface LandMaskOptions {
  /** Raster cell size in degrees. 0.002° ≈ 220 m at the equator. */
  resolutionDeg?: number;
  /** Degrees of margin loaded around the bbox so legs leaving it still see land. */
  bufferDeg?: number;
}

export class LandMask {
  readonly bbox: BBox;
  readonly resolutionDeg: number;
  readonly nx: number;
  readonly ny: number;
  /** 1 = land, 0 = water. Row 0 is the southernmost row. */
  readonly raster: Uint8Array;
  readonly shapes: ShapePolygon[];
  /** Finer local rasters (see refine()); checked before the base raster. */
  readonly patches: LandPatch[] = [];
  /** Mark cells crossed by polygon edges (conservative raster). */
  private edgeCells = true;

  private constructor(
    shapes: ShapePolygon[],
    bbox: BBox,
    resolutionDeg: number,
    raster?: Uint8Array,
    dims?: { nx?: number; ny?: number; edgeCells?: boolean }
  ) {
    this.shapes = shapes;
    this.bbox = bbox;
    this.resolutionDeg = resolutionDeg;
    this.nx = dims?.nx ?? Math.max(1, Math.ceil(bboxWidth(bbox) / resolutionDeg));
    this.ny = dims?.ny ?? Math.max(1, Math.ceil(bboxHeight(bbox) / resolutionDeg));
    if (dims?.edgeCells === false) this.edgeCells = false;
    const cells = this.nx * this.ny;
    if (cells > 400_000_000) {
      throw new Error(
        `LandMask raster of ${this.nx}x${this.ny} = ${(cells / 1e6).toFixed(0)}M cells is too large; ` +
          'use a coarser resolution or a smaller bbox'
      );
    }
    if (raster) {
      if (raster.length !== cells) throw new Error(`LandMask raster has ${raster.length} cells, expected ${cells}`);
      this.raster = raster;
    } else {
      this.raster = new Uint8Array(cells);
      this.rasterize();
    }
  }

  /** Structured-clone friendly raster form (no polygons; isLandExact is unavailable). */
  serializeRaster(): SerializedLandRaster {
    return { bbox: this.bbox, resolutionDeg: this.resolutionDeg, raster: this.raster };
  }

  static fromRaster(s: SerializedLandRaster): LandMask {
    return new LandMask([], s.bbox, s.resolutionDeg, s.raster);
  }

  /** True when polygon geometry is available for exact tests. */
  get hasPolygons(): boolean {
    return this.shapes.length > 0;
  }

  /**
   * Load every polygon from the given shapefiles that intersects `bbox`
   * (plus `bufferDeg` margin) and rasterise it.
   */
  static fromShapefiles(paths: string[], bbox: BBox, opts: LandMaskOptions = {}): LandMask {
    const resolutionDeg = opts.resolutionDeg ?? 0.002;
    const buffer = opts.bufferDeg ?? 0.1;
    if (!(resolutionDeg > 0)) throw new Error(`LandMask resolutionDeg must be > 0 (got ${resolutionDeg})`);
    const width = bboxWidth(bbox);
    const padded: BBox = {
      west: width + 2 * buffer >= 360 ? -180 : ((bbox.west - buffer + 540) % 360) - 180,
      east: width + 2 * buffer >= 360 ? 180 : ((bbox.east + buffer + 540) % 360) - 180,
      south: Math.max(-90, bbox.south - buffer),
      north: Math.min(90, bbox.north + buffer),
    };
    const shapes: ShapePolygon[] = [];
    for (const p of paths) shapes.push(...readShapefilePolygons(p, padded));
    return new LandMask(shapes, padded, resolutionDeg);
  }

  /**
   * Finest resolution from `candidates` whose raster over `bbox` (plus
   * buffer) stays within `maxCells`. Falls back to the coarsest candidate.
   */
  static chooseResolution(bbox: BBox, maxCells = 25_000_000, bufferDeg = 0.1, candidates = [0.0005, 0.001, 0.002, 0.005, 0.01]): number {
    const w = Math.min(360, bboxWidth(bbox) + 2 * bufferDeg);
    const h = Math.min(180, bboxHeight(bbox) + 2 * bufferDeg);
    const sorted = [...candidates].sort((a, b) => a - b);
    for (const r of sorted) {
      if (Math.ceil(w / r) * Math.ceil(h / r) <= maxCells) return r;
    }
    return sorted[sorted.length - 1];
  }

  /** Build from already-decoded polygons (tests). */
  static fromPolygons(shapes: ShapePolygon[], bbox: BBox, resolutionDeg = 0.002): LandMask {
    return new LandMask(shapes, bbox, resolutionDeg);
  }

  /**
   * Raster-only mask fed one polygon at a time: `feed` calls `add` for
   * each polygon, which is rasterised and can then be dropped, so memory
   * is bounded by the largest single polygon rather than all of them.
   * The raster equals fromPolygons(all, bbox, res).raster; no polygons
   * are kept (isLandExact is unavailable).
   */
  static rasterStreamed(
    bbox: BBox,
    resolutionDeg: number,
    feed: (add: (s: ShapePolygon) => void) => void,
    opts: RasterStreamOptions = {}
  ): LandMask {
    const m = new LandMask([], bbox, resolutionDeg, undefined, { nx: opts.nx, ny: opts.ny, edgeCells: opts.edgeCells });
    feed(s => m.rasterizeShape(s));
    return m;
  }

  // -------------------------------------------------------------------
  // Local refinement

  /**
   * Rasterise a finer conservative patch over `bbox` (clipped to the base
   * raster) from the loaded polygons; `isLand` then answers from it inside
   * the box. Needs polygons (a mask from fromShapefiles/fromPolygons).
   * Returns the patch, or null when the box is outside the base raster or
   * an equal-or-finer patch already covers it.
   */
  refine(bbox: BBox, resolutionDeg: number, maxCells = 4_000_000): LandPatch | null {
    if (!this.hasPolygons) throw new Error('LandMask.refine needs polygons (raster-only masks cannot be refined)');
    if (!(resolutionDeg > 0) || resolutionDeg >= this.resolutionDeg) return null;
    // Snap the box to base-cell boundaries inside the base raster.
    const res0 = this.resolutionDeg;
    const x0 = Math.max(0, Math.floor(lonOffsetFromWest(this.bbox, bbox.west) / res0));
    const w = bboxWidth(bbox);
    const x1 = Math.min(this.nx, Math.ceil((lonOffsetFromWest(this.bbox, bbox.west) + w) / res0));
    const y0 = Math.max(0, Math.floor((bbox.south - this.bbox.south) / res0));
    const y1 = Math.min(this.ny, Math.ceil((bbox.north - this.bbox.south) / res0));
    if (x1 <= x0 || y1 <= y0) return null;
    const west = this.bbox.west + x0 * res0;
    const south = this.bbox.south + y0 * res0;
    const k = Math.max(2, Math.round(res0 / resolutionDeg));
    const res = res0 / k;
    const nx = (x1 - x0) * k;
    const ny = (y1 - y0) * k;
    if (nx * ny > maxCells) throw new Error(`LandMask.refine: patch ${nx}x${ny} exceeds ${maxCells} cells`);
    const pb: BBox = {
      west: ((west + 540) % 360) - 180,
      south,
      east: ((west + (x1 - x0) * res0 + 540) % 360) - 180,
      north: south + (y1 - y0) * res0,
    };
    for (const p of this.patches) {
      if (p.resolutionDeg <= res * 1.0001 && bboxCovers(p.bbox, pb)) return null;
    }
    const m = new LandMask([], pb, res, undefined, { nx, ny });
    for (const s of this.shapes) {
      if (s.maxLat < pb.south || s.minLat > pb.north) continue;
      m.rasterizeShape(s);
    }
    const patch: LandPatch = { bbox: pb, resolutionDeg: res, nx, ny, raster: m.raster };
    // Finest first, so lookups hit the finest patch covering a point.
    this.patches.push(patch);
    this.patches.sort((a, b) => a.resolutionDeg - b.resolutionDeg);
    return patch;
  }

  /** Drop all local patches (a cached mask reused for another route). */
  clearPatches(): void {
    this.patches.length = 0;
  }

  /** Resolution that answers isLand at a position (finest patch covering it, else the base). */
  resolutionAt(lon: number, lat: number): number {
    for (const p of this.patches) {
      if (patchIndex(p, lon, lat) >= 0) return p.resolutionDeg;
    }
    return this.resolutionDeg;
  }

  /** Bytes held by the base raster and patches. */
  rasterBytes(): number {
    let b = this.raster.length;
    for (const p of this.patches) b += p.raster.length;
    return b;
  }

  // -------------------------------------------------------------------
  // Rasterisation

  private rasterize(): void {
    for (const shape of this.shapes) this.rasterizeShape(shape);
  }

  private rasterizeShape(shape: ShapePolygon): void {
    const { nx, ny, resolutionDeg: res, raster } = this;
    const width = bboxWidth(this.bbox);
    const south = this.bbox.south;

    // Row centre latitude and the row index range covering a lat span.
    const rowOfLat = (lat: number): number => Math.floor((lat - south) / res);

    {
      // Longitudes are converted to the offset frame (degrees east of
      // bbox.west). Rings crossing the frame seam are unwrapped so
      // consecutive vertices differ by < 180°, then processed in up to
      // three shifted copies (-360, 0, +360) so whichever copy overlaps
      // [0, width] gets filled.
      const rMinRow = Math.max(0, rowOfLat(shape.minLat));
      const rMaxRow = Math.min(ny - 1, rowOfLat(shape.maxLat));
      if (rMinRow > rMaxRow) return;

      const rings: Float64Array[] = [];
      for (const ring of shape.rings) {
        const c = ring.coords;
        const n = c.length / 2;
        const xs = new Float64Array(2 * n);
        let prev = lonOffsetFromWest(this.bbox, c[0]);
        xs[0] = prev;
        xs[1] = c[1];
        for (let i = 1; i < n; i++) {
          let x = lonOffsetFromWest(this.bbox, c[2 * i]);
          // Unwrap relative to the previous vertex.
          while (x - prev > 180) x -= 360;
          while (x - prev < -180) x += 360;
          xs[2 * i] = x;
          xs[2 * i + 1] = c[2 * i + 1];
          prev = x;
        }
        rings.push(xs);
      }

      for (const shift of [-360, 0, 360]) {
        // Does any ring overlap [0, width] after this shift?
        let overlaps = false;
        for (const xs of rings) {
          let mn = Infinity;
          let mx = -Infinity;
          for (let i = 0; i < xs.length; i += 2) {
            const x = xs[i] + shift;
            if (x < mn) mn = x;
            if (x > mx) mx = x;
          }
          if (mx >= 0 && mn <= width) {
            overlaps = true;
            break;
          }
        }
        if (!overlaps) continue;
        this.fillShape(rings, shift, rMinRow, rMaxRow, nx, res, south, raster, width);
      }
    }
  }

  /**
   * Scanline even-odd fill of one shape (all rings together) into the
   * raster, plus conservative marking of every cell an edge passes through.
   */
  private fillShape(
    rings: Float64Array[],
    shift: number,
    rowLo: number,
    rowHi: number,
    nx: number,
    res: number,
    south: number,
    raster: Uint8Array,
    width: number
  ): void {
    interface Edge {
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      rowStart: number;
      rowEnd: number;
    }
    const buckets = new Map<number, Edge[]>();
    let edgeCount = 0;
    for (const xs of rings) {
      const n = xs.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xa = xs[2 * j] + shift;
        const ya = xs[2 * j + 1];
        const xb = xs[2 * i] + shift;
        const yb = xs[2 * i + 1];
        // Conservative boundary marking: every cell the edge touches.
        if (this.edgeCells) this.markEdgeCells(xa, ya, xb, yb, nx, res, south, raster, width);
        if (ya === yb) continue; // horizontal edges do not cross scanlines
        const y0 = Math.min(ya, yb);
        const y1 = Math.max(ya, yb);
        // Scanline at row centre lat = south + (row + 0.5) * res crosses the
        // edge when y0 <= lat < y1 (half-open to avoid double counting).
        let rowStart = Math.ceil((y0 - south) / res - 0.5);
        let rowEnd = Math.ceil((y1 - south) / res - 0.5) - 1;
        if (rowStart < rowLo) rowStart = rowLo;
        if (rowEnd > rowHi) rowEnd = rowHi;
        if (rowStart > rowEnd) continue;
        const e: Edge = { x0: xa, y0: ya, x1: xb, y1: yb, rowStart, rowEnd };
        let b = buckets.get(rowStart);
        if (!b) buckets.set(rowStart, (b = []));
        b.push(e);
        edgeCount++;
      }
    }
    if (edgeCount === 0) return;

    let active: Edge[] = [];
    const xsRow: number[] = [];
    for (let row = rowLo; row <= rowHi; row++) {
      const incoming = buckets.get(row);
      if (incoming) active.push(...incoming);
      if (active.length === 0) continue;
      const lat = south + (row + 0.5) * res;
      xsRow.length = 0;
      let anyLeft = false;
      for (const e of active) {
        if (row > e.rowEnd) continue;
        anyLeft = true;
        const t = (lat - e.y0) / (e.y1 - e.y0);
        xsRow.push(e.x0 + t * (e.x1 - e.x0));
      }
      if (!anyLeft) {
        active = [];
        continue;
      }
      if (row % 64 === 0) active = active.filter(e => row <= e.rowEnd);
      xsRow.sort((a, b) => a - b);
      const base = row * nx;
      for (let k = 0; k + 1 < xsRow.length; k += 2) {
        // Cells whose centre lies in [xsRow[k], xsRow[k+1]).
        let jStart = Math.ceil(xsRow[k] / res - 0.5);
        let jEnd = Math.ceil(xsRow[k + 1] / res - 0.5) - 1;
        if (jStart < 0) jStart = 0;
        if (jEnd > nx - 1) jEnd = nx - 1;
        for (let j = jStart; j <= jEnd; j++) raster[base + j] = 1;
      }
    }
  }

  /**
   * Mark every raster cell an edge passes through: an exact supercover
   * walk (Amanatides–Woo), including the cells around a corner the edge
   * passes exactly through, so a cell left as water has no polygon
   * boundary inside it (isLandExact relies on this).
   */
  private markEdgeCells(
    xa: number,
    ya: number,
    xb: number,
    yb: number,
    nx: number,
    res: number,
    south: number,
    raster: Uint8Array,
    width: number
  ): void {
    const ny = this.ny;
    // Quick reject when the edge is entirely outside the raster.
    if (Math.max(xa, xb) < 0 || Math.min(xa, xb) > width) return;
    if (Math.max(ya, yb) < south || Math.min(ya, yb) > south + ny * res) return;
    const x1 = xa / res;
    const y1 = (ya - south) / res;
    const x2 = xb / res;
    const y2 = (yb - south) / res;
    const mark = (j: number, i: number): void => {
      if (i >= 0 && i < ny && j >= 0 && j < nx) raster[i * nx + j] = 1;
    };
    let cx = Math.floor(x1);
    let cy = Math.floor(y1);
    const ex = Math.floor(x2);
    const ey = Math.floor(y2);
    mark(cx, cy);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const sx = dx > 0 ? 1 : -1;
    const sy = dy > 0 ? 1 : -1;
    const tDx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tMaxX = dx !== 0 ? (sx > 0 ? cx + 1 - x1 : x1 - cx) * tDx : Infinity;
    let tMaxY = dy !== 0 ? (sy > 0 ? cy + 1 - y1 : y1 - cy) * tDy : Infinity;
    // A vertex exactly on a cell border also touches the neighbour.
    if (x1 === cx) mark(cx - 1, cy);
    if (y1 === cy) mark(cx, cy - 1);
    const steps = Math.abs(ex - cx) + Math.abs(ey - cy);
    for (let s = 0; s < steps && Math.min(tMaxX, tMaxY) <= 1; s++) {
      if (Math.abs(tMaxX - tMaxY) < 1e-12) {
        // Through a corner: all four cells around it.
        mark(cx + sx, cy);
        mark(cx, cy + sy);
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
      mark(cx, cy);
    }
    mark(ex, ey);
  }

  // -------------------------------------------------------------------
  // Queries

  /** Raster cell index for a position, or -1 when outside the raster. */
  cellIndex(lon: number, lat: number): number {
    const i = Math.floor((lat - this.bbox.south) / this.resolutionDeg);
    if (i < 0 || i >= this.ny) return -1;
    const j = Math.floor(lonOffsetFromWest(this.bbox, lon) / this.resolutionDeg);
    if (j < 0 || j >= this.nx) return -1;
    return i * this.nx + j;
  }

  /** Raster land test (finest patch first). Positions outside the raster are reported as water. */
  isLand(lon: number, lat: number): boolean {
    if (this.patches.length) {
      for (const p of this.patches) {
        const pi = patchIndex(p, lon, lat);
        if (pi >= 0) return p.raster[pi] === 1;
      }
    }
    const idx = this.cellIndex(lon, lat);
    return idx >= 0 && this.raster[idx] === 1;
  }

  /** Raster land test for arrays. */
  isLandBulk(lons: ArrayLike<number>, lats: ArrayLike<number>): Uint8Array {
    const n = lons.length;
    const out = new Uint8Array(n);
    for (let k = 0; k < n; k++) out[k] = this.isLand(lons[k], lats[k]) ? 1 : 0;
    return out;
  }

  /**
   * Exact even-odd polygon test against the loaded shapes. A point in a
   * water cell of the conservative raster (or of a patch) is water without
   * a polygon test: no polygon boundary passes through such a cell and its
   * centre is outside every polygon, so the whole cell is outside.
   */
  isLandExact(lon: number, lat: number): boolean {
    if (this.edgeCells && this.shapes.length) {
      for (const p of this.patches) {
        const pi = patchIndex(p, lon, lat);
        if (pi >= 0) {
          if (p.raster[pi] === 0) return false;
          break;
        }
      }
      const idx = this.cellIndex(lon, lat);
      if (idx >= 0 && this.raster[idx] === 0 && !this.inAnyPatch(lon, lat)) return false;
    }
    return this.isLandPolygons(lon, lat);
  }

  /** Point-in-polygon over every loaded shape (no raster shortcut). */
  isLandPolygons(lon: number, lat: number): boolean {
    for (const s of this.shapes) {
      if (pointInShape(s, lon, lat)) return true;
    }
    return false;
  }

  private inAnyPatch(lon: number, lat: number): boolean {
    for (const p of this.patches) if (patchIndex(p, lon, lat) >= 0) return true;
    return false;
  }

  /**
   * For each leg a→b, does its great-circle path touch land at any
   * sample spaced ≤ stepM apart (endpoints included)?
   */
  legsCrossLandBulk(
    lonsA: ArrayLike<number>,
    latsA: ArrayLike<number>,
    lonsB: ArrayLike<number>,
    latsB: ArrayLike<number>,
    stepM = 200
  ): Uint8Array {
    if (!(stepM > 0)) throw new Error(`legsCrossLandBulk: stepM must be > 0 (got ${stepM})`);
    const n = lonsA.length;
    const out = new Uint8Array(n);
    let maxSamples = 2;
    for (let k = 0; k < n; k++) {
      const d = haversineDistanceM(lonsA[k], latsA[k], lonsB[k], latsB[k]);
      const s = Math.max(2, Math.ceil(d / stepM) + 1);
      if (s > maxSamples) maxSamples = s;
    }
    const sLon = new Float64Array(maxSamples);
    const sLat = new Float64Array(maxSamples);
    for (let k = 0; k < n; k++) {
      const d = haversineDistanceM(lonsA[k], latsA[k], lonsB[k], latsB[k]);
      const s = Math.max(2, Math.ceil(d / stepM) + 1);
      slerpSamples(lonsA[k], latsA[k], lonsB[k], latsB[k], s, sLon, sLat, 0);
      for (let q = 0; q < s; q++) {
        if (this.isLand(sLon[q], sLat[q])) {
          out[k] = 1;
          break;
        }
      }
    }
    return out;
  }

  /** Exact-polygon variant of legsCrossLandBulk for the final validation pass. */
  legCrossesLandExact(lonA: number, latA: number, lonB: number, latB: number, stepM = 100): boolean {
    const d = haversineDistanceM(lonA, latA, lonB, latB);
    const s = Math.max(2, Math.ceil(d / stepM) + 1);
    const sLon = new Float64Array(s);
    const sLat = new Float64Array(s);
    slerpSamples(lonA, latA, lonB, latB, s, sLon, sLat, 0);
    for (let q = 0; q < s; q++) if (this.isLandExact(sLon[q], sLat[q])) return true;
    return false;
  }

  /** Fraction of raster cells that are land (diagnostics). */
  landFraction(): number {
    let c = 0;
    for (let i = 0; i < this.raster.length; i++) c += this.raster[i];
    return c / this.raster.length;
  }
}

/** Cell index of a position in a patch, or -1 outside it. */
function patchIndex(p: LandPatch, lon: number, lat: number): number {
  const i = Math.floor((lat - p.bbox.south) / p.resolutionDeg);
  if (i < 0 || i >= p.ny) return -1;
  const j = Math.floor(lonOffsetFromWest(p.bbox, lon) / p.resolutionDeg);
  if (j < 0 || j >= p.nx) return -1;
  return i * p.nx + j;
}

/** Does `outer` contain `inner` (antimeridian-aware)? */
function bboxCovers(outer: BBox, inner: BBox): boolean {
  const eps = 1e-9;
  if (inner.south < outer.south - eps || inner.north > outer.north + eps) return false;
  let off = lonOffsetFromWest(outer, inner.west);
  if (off > 360 - eps) off = 0;
  return off + bboxWidth(inner) <= bboxWidth(outer) + eps;
}
