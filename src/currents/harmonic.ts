/**
 * Tidal currents predicted from harmonic constituents stored in the
 * routing project's `.npz` layout (FES2014 or NECOFS extracts):
 *
 *   lats, lons                      1-D, ascending
 *   constituents                    string array
 *   east_amplitude, east_phase      (nConst, nLat, nLon), cm/s and degrees
 *   north_amplitude, north_phase    (nConst, nLat, nLon)
 *   bbox                            [south, west, north, east]
 *   source_name, priority, resolution_m
 *
 * Prediction, per the reference implementation:
 *   u(cm/s) = Σ_c f_c · A_c · cos( G_c·π/180 + u_c − g_c·π/180 )
 * with (u_c, f_c, G_c) from pyTMD's `arguments(..., corrections="FES")`
 * (ported in tidal_arguments.ts). The whole grid is predicted once per
 * 5-minute time bin and cached; points are then bilinear on the grid,
 * with any NaN corner giving (0, 0) = no data.
 *
 * Memory: the constituent arrays are kept at the file's float32 precision
 * in ONE SharedArrayBuffer per file (a NECOFS GoM3 extract is 116 MB;
 * widening to float64 and loading it in each worker cost ~470 MB). The
 * data worker loads it and the route worker adopts the same memory via
 * serialize()/fromSerialized(). One large block is mmap'd and returned
 * to the OS when dropped (see FloatSlab in data/forecast.ts). The
 * prediction cache holds float32 grids and is capped by bytes.
 */

import { readNpz, type NpyArray } from '../data/npz';
import { DEG } from '../geo/units';
import { isSupportedConstituent, tidalArguments } from './tidal_arguments';
import { bboxContains, dateToMjd, type CurrentSourceLike, type SourceBBox } from './types';

const CM_S_TO_MS = 0.01;
/** Default byte cap for the per-source prediction cache (u and v float32 grids per 5-min bin). */
const CACHE_MAX_BYTES = 64e6;

/** A source's data in a structured-clone-friendly form; the constituent block stays shared. */
export interface SerializedHarmonic {
  name: string;
  priority: number;
  resolutionM: number;
  bbox: SourceBBox;
  lats: Float64Array;
  lons: Float64Array;
  constituents: string[];
  dropped: string[];
  /** eastAmp, eastPha, northAmp, northPha back to back, each constituents × lats × lons float32. */
  block: SharedArrayBuffer;
}

function asFloat64(a: NpyArray | undefined, name: string): Float64Array {
  if (!a) throw new Error(`harmonic .npz lacks ${name}`);
  if (a.kind === 'f32' || a.kind === 'f64') return Float64Array.from(a.data);
  throw new Error(`harmonic .npz ${name} has dtype ${a.kind}, expected float`);
}

function scalar(a: NpyArray | undefined): number | string | undefined {
  if (!a) return undefined;
  if (a.kind === 'str') return a.data[0];
  if (a.kind === 'i64') return Number(a.data[0]);
  return Number(a.data[0]);
}

export class HarmonicCurrentSource implements CurrentSourceLike {
  readonly name: string;
  readonly priority: number;
  readonly resolutionM: number;
  readonly bbox: SourceBBox;
  readonly lats: Float64Array;
  readonly lons: Float64Array;
  readonly constituents: string[];
  readonly dropped: string[];
  /** Amplitudes (cm/s) and phases (degrees), constituent-major, row-major (lat, lon), float32 views of `block`. */
  private readonly eastAmp: Float32Array;
  private readonly eastPha: Float32Array;
  private readonly northAmp: Float32Array;
  private readonly northPha: Float32Array;
  private readonly block: SharedArrayBuffer;
  private readonly latStep: number;
  private readonly lonStep: number;
  private readonly cache = new Map<number, { u: Float32Array; v: Float32Array }>();
  /** Tidal arguments per 5-min bin, for single-point predictions (tiny). */
  private readonly argCache = new Map<number, ReturnType<typeof tidalArguments>>();
  readonly cacheBinMinutes = 5;
  readonly cacheMaxEntries: number;

  /** Load from a `.npz` file (data worker). */
  constructor(filePath: string, opts?: { cacheMaxEntries?: number });
  /** Adopt another thread's loaded source (route worker): shares the constituent block. */
  constructor(serialized: SerializedHarmonic, opts?: { cacheMaxEntries?: number });
  constructor(src: string | SerializedHarmonic, opts: { cacheMaxEntries?: number } = {}) {
    if (typeof src !== 'string') {
      this.name = src.name;
      this.priority = src.priority;
      this.resolutionM = src.resolutionM;
      this.bbox = src.bbox;
      this.lats = src.lats;
      this.lons = src.lons;
      this.constituents = src.constituents;
      this.dropped = src.dropped;
      this.block = src.block;
      const n = this.constituents.length * this.lats.length * this.lons.length;
      [this.eastAmp, this.eastPha, this.northAmp, this.northPha] = [0, 1, 2, 3].map(k => new Float32Array(src.block, k * n * 4, n));
      this.latStep = this.lats[1] - this.lats[0];
      this.lonStep = this.lons[1] - this.lons[0];
      this.cacheMaxEntries = HarmonicCurrentSource.cacheEntries(opts.cacheMaxEntries, this.lats.length * this.lons.length);
      return;
    }
    const filePath = src;
    const z = readNpz(filePath);
    this.lats = asFloat64(z.get('lats'), 'lats');
    this.lons = asFloat64(z.get('lons'), 'lons');
    const cons = z.get('constituents');
    if (!cons || cons.kind !== 'str') throw new Error(`${filePath}: constituents missing`);
    const allCons = cons.data.map(s => String(s));
    const nLat = this.lats.length;
    const nLon = this.lons.length;
    if (nLat < 2 || nLon < 2) throw new Error(`${filePath}: grid too small`);
    const asF32 = (a: NpyArray | undefined, name: string): Float32Array | Float64Array => {
      if (!a) throw new Error(`harmonic .npz lacks ${name}`);
      if (a.kind === 'f32' || a.kind === 'f64') return a.data as Float32Array | Float64Array;
      throw new Error(`harmonic .npz ${name} has dtype ${a.kind}, expected float`);
    };
    const ea = asF32(z.get('east_amplitude'), 'east_amplitude');
    const ep = asF32(z.get('east_phase'), 'east_phase');
    const na = asF32(z.get('north_amplitude'), 'north_amplitude');
    const np_ = asF32(z.get('north_phase'), 'north_phase');
    const per = nLat * nLon;
    const expected = allCons.length * per;
    for (const [label, arr] of [
      ['east_amplitude', ea],
      ['east_phase', ep],
      ['north_amplitude', na],
      ['north_phase', np_],
    ] as const) {
      if (arr.length !== expected)
        throw new Error(
          `${filePath}: ${label} has ${arr.length} values, expected ${expected} (${allCons.length} constituents × ${nLat} × ${nLon})`
        );
    }

    // Drop constituents the argument port does not support, as the
    // reference drops those pyTMD rejects (e.g. la2).
    const keep: number[] = [];
    const dropped: string[] = [];
    allCons.forEach((c, i) => (isSupportedConstituent(c) ? keep.push(i) : dropped.push(c)));
    this.constituents = keep.map(i => allCons[i]);
    this.dropped = dropped;
    // One shared block for the four arrays (kept constituents only).
    const n = keep.length * per;
    this.block = new SharedArrayBuffer(4 * n * 4);
    const views = [0, 1, 2, 3].map(k => new Float32Array(this.block, k * n * 4, n));
    [ea, ep, na, np_].forEach((srcArr, a) => keep.forEach((ci, k) => views[a].set(srcArr.subarray(ci * per, (ci + 1) * per), k * per)));
    [this.eastAmp, this.eastPha, this.northAmp, this.northPha] = views;

    const bb = asFloat64(z.get('bbox'), 'bbox');
    this.bbox = { south: bb[0], west: bb[1], north: bb[2], east: bb[3] };
    const pr = scalar(z.get('priority'));
    this.priority = typeof pr === 'number' && Number.isFinite(pr) ? pr : 0;
    const rm = scalar(z.get('resolution_m'));
    this.resolutionM = typeof rm === 'number' && Number.isFinite(rm) ? rm : 5600;
    const nm = scalar(z.get('source_name'));
    this.name = typeof nm === 'string' && nm ? nm : filePath.replace(/^.*[\\/]/, '').replace(/\.npz$/, '');
    this.latStep = this.lats[1] - this.lats[0];
    this.lonStep = this.lons[1] - this.lons[0];
    this.cacheMaxEntries = HarmonicCurrentSource.cacheEntries(opts.cacheMaxEntries, per);
  }

  /** Cache entries: explicit, or as many 5-min grids (u + v float32) as fit in CACHE_MAX_BYTES (at least 4). */
  private static cacheEntries(explicit: number | undefined, cells: number): number {
    if (explicit !== undefined) return Math.max(1, explicit);
    return Math.max(4, Math.floor(CACHE_MAX_BYTES / (cells * 8)));
  }

  /** For relaying to another worker: small metadata plus the shared constituent block (not copied). */
  serialize(): SerializedHarmonic {
    return {
      name: this.name,
      priority: this.priority,
      resolutionM: this.resolutionM,
      bbox: this.bbox,
      lats: this.lats,
      lons: this.lons,
      constituents: this.constituents,
      dropped: this.dropped,
      block: this.block,
    };
  }

  /** Bytes of the constituent block (shared between workers). */
  blockBytes(): number {
    return this.block.byteLength;
  }

  contains(lon: number, lat: number): boolean {
    return bboxContains(this.bbox, lon, lat);
  }

  /** Predict u/v (cm/s) over the whole grid at an MJD. */
  predictGrid(mjd: number): { u: Float32Array; v: Float32Array } {
    const { pu, pf, G } = tidalArguments(mjd, this.constituents);
    const per = this.lats.length * this.lons.length;
    // Accumulate in double, store float32 (the constituents are float32).
    const ud = new Float64Array(per);
    const vd = new Float64Array(per);
    for (let c = 0; c < this.constituents.length; c++) {
      const theta = G[c] * DEG + pu[c];
      const f = pf[c];
      const base = c * per;
      for (let i = 0; i < per; i++) {
        ud[i] += this.eastAmp[base + i] * f * Math.cos(theta - this.eastPha[base + i] * DEG);
        vd[i] += this.northAmp[base + i] * f * Math.cos(theta - this.northPha[base + i] * DEG);
      }
    }
    return { u: Float32Array.from(ud), v: Float32Array.from(vd) };
  }

  private binKey(mjd: number): number {
    const bin = this.cacheBinMinutes / 1440;
    return Math.round(mjd / bin) * bin;
  }

  /**
   * The value predictGrid would store for one cell (float32), computed
   * for that cell alone: the same sum in the same order.
   */
  private predictCell(args: ReturnType<typeof tidalArguments>, cell: number): [number, number] {
    const { pu, pf, G } = args;
    const per = this.lats.length * this.lons.length;
    let ud = 0;
    let vd = 0;
    for (let c = 0; c < this.constituents.length; c++) {
      const theta = G[c] * DEG + pu[c];
      const f = pf[c];
      const i = c * per + cell;
      ud += this.eastAmp[i] * f * Math.cos(theta - this.eastPha[i] * DEG);
      vd += this.northAmp[i] * f * Math.cos(theta - this.northPha[i] * DEG);
    }
    return [Math.fround(ud), Math.fround(vd)];
  }

  /**
   * One point at a time with no cached grid (e.g. a 72-hour conditions
   * series): predict only the 4 cells around the point instead of the
   * whole grid (NECOFS-GOM3: 501×501 cells, ~230 ms per grid on a Pi 5).
   * Same result as interpolating the full grid.
   */
  private pointAt(key: number, lon: number, lat: number): [number, number] {
    let args = this.argCache.get(key);
    if (!args) {
      args = tidalArguments(key, this.constituents);
      this.argCache.set(key, args);
      while (this.argCache.size > 4096) this.argCache.delete(this.argCache.keys().next().value as number);
    }
    const nLat = this.lats.length;
    const nLon = this.lons.length;
    const latIdx = (lat - this.lats[0]) / this.latStep;
    const lonIdx = (lon - this.lons[0]) / this.lonStep;
    const i0 = Math.max(0, Math.min(Math.floor(latIdx), nLat - 2));
    const j0 = Math.max(0, Math.min(Math.floor(lonIdx), nLon - 2));
    const di = Math.max(0, Math.min(1, latIdx - i0));
    const dj = Math.max(0, Math.min(1, lonIdx - j0));
    const c00 = this.predictCell(args, i0 * nLon + j0);
    const c01 = this.predictCell(args, i0 * nLon + j0 + 1);
    const c10 = this.predictCell(args, (i0 + 1) * nLon + j0);
    const c11 = this.predictCell(args, (i0 + 1) * nLon + j0 + 1);
    const bil = (k: 0 | 1): number => c00[k] * (1 - di) * (1 - dj) + c01[k] * (1 - di) * dj + c10[k] * di * (1 - dj) + c11[k] * di * dj;
    return [bil(0), bil(1)];
  }

  private cachedGrid(mjd: number): { u: Float32Array; v: Float32Array } {
    const key = this.binKey(mjd);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const g = this.predictGrid(key);
    this.cache.set(key, g);
    while (this.cache.size > this.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value as number;
      this.cache.delete(oldest);
    }
    return g;
  }

  /**
   * Bilinear sample of a grid (cm/s); NaN if any corner is NaN. Indices
   * clamp to the edges. The reference computes the fractional index in
   * float32 (its lat/lon axes are float32 and numpy promotes the Python
   * scalar to float32); this port uses double, which differs from the
   * reference by up to ~1e-5 m/s on strong currents.
   */
  private interp(grid: Float32Array, lon: number, lat: number): number {
    const nLat = this.lats.length;
    const nLon = this.lons.length;
    const latIdx = (lat - this.lats[0]) / this.latStep;
    const lonIdx = (lon - this.lons[0]) / this.lonStep;
    let i0 = Math.floor(latIdx);
    let j0 = Math.floor(lonIdx);
    i0 = Math.max(0, Math.min(i0, nLat - 2));
    j0 = Math.max(0, Math.min(j0, nLon - 2));
    const di = Math.max(0, Math.min(1, latIdx - i0));
    const dj = Math.max(0, Math.min(1, lonIdx - j0));
    const v00 = grid[i0 * nLon + j0];
    const v01 = grid[i0 * nLon + j0 + 1];
    const v10 = grid[(i0 + 1) * nLon + j0];
    const v11 = grid[(i0 + 1) * nLon + j0 + 1];
    return v00 * (1 - di) * (1 - dj) + v01 * (1 - di) * dj + v10 * di * (1 - dj) + v11 * di * dj;
  }

  at(lon: number, lat: number, time: Date): [number, number] {
    if (!this.contains(lon, lat)) return [0, 0];
    // A grid already predicted for this time serves the point; otherwise
    // predict only this point (a whole grid for one point is wasted work).
    const key = this.binKey(dateToMjd(time));
    const g = this.cache.get(key);
    let u: number;
    let v: number;
    if (g) {
      u = this.interp(g.u, lon, lat);
      v = this.interp(g.v, lon, lat);
    } else {
      [u, v] = this.pointAt(key, lon, lat);
    }
    if (Number.isNaN(u) || Number.isNaN(v)) return [0, 0];
    return [u * CM_S_TO_MS, v * CM_S_TO_MS];
  }

  atMany(lons: Float64Array, lats: Float64Array, time: Date): { u: Float64Array; v: Float64Array } {
    const n = lons.length;
    const u = new Float64Array(n);
    const v = new Float64Array(n);
    if (n === 0) return { u, v };
    const g = this.cachedGrid(dateToMjd(time));
    for (let k = 0; k < n; k++) {
      if (!this.contains(lons[k], lats[k])) continue;
      const uu = this.interp(g.u, lons[k], lats[k]);
      const vv = this.interp(g.v, lons[k], lats[k]);
      if (Number.isNaN(uu) || Number.isNaN(vv)) continue;
      u[k] = uu * CM_S_TO_MS;
      v[k] = vv * CM_S_TO_MS;
    }
    return { u, v };
  }

  cacheBytes(): number {
    const per = this.lats.length * this.lons.length * 4 * 2;
    return per * this.cache.size;
  }
}
