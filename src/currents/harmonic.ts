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
 */

import { readNpz, type NpyArray } from '../data/npz';
import { isSupportedConstituent, tidalArguments } from './tidal_arguments';
import { bboxContains, dateToMjd, type CurrentSourceLike, type SourceBBox } from './types';

const CM_S_TO_MS = 0.01;

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
  /** Amplitudes (cm/s) and phases (degrees), constituent-major, row-major (lat, lon). */
  private readonly eastAmp: Float64Array;
  private readonly eastPha: Float64Array;
  private readonly northAmp: Float64Array;
  private readonly northPha: Float64Array;
  private readonly latStep: number;
  private readonly lonStep: number;
  private readonly cache = new Map<number, { u: Float64Array; v: Float64Array }>();
  readonly cacheBinMinutes = 5;
  readonly cacheMaxEntries: number;

  constructor(filePath: string, opts: { cacheMaxEntries?: number } = {}) {
    const z = readNpz(filePath);
    this.lats = asFloat64(z.get('lats'), 'lats');
    this.lons = asFloat64(z.get('lons'), 'lons');
    const cons = z.get('constituents');
    if (!cons || cons.kind !== 'str') throw new Error(`${filePath}: constituents missing`);
    const allCons = cons.data.map((s) => String(s));
    const nLat = this.lats.length;
    const nLon = this.lons.length;
    if (nLat < 2 || nLon < 2) throw new Error(`${filePath}: grid too small`);
    const ea = asFloat64(z.get('east_amplitude'), 'east_amplitude');
    const ep = asFloat64(z.get('east_phase'), 'east_phase');
    const na = asFloat64(z.get('north_amplitude'), 'north_amplitude');
    const np_ = asFloat64(z.get('north_phase'), 'north_phase');
    const per = nLat * nLon;
    const expected = allCons.length * per;
    for (const [label, arr] of [['east_amplitude', ea], ['east_phase', ep], ['north_amplitude', na], ['north_phase', np_]] as const) {
      if (arr.length !== expected) throw new Error(`${filePath}: ${label} has ${arr.length} values, expected ${expected} (${allCons.length} constituents × ${nLat} × ${nLon})`);
    }

    // Drop constituents the argument port does not support, as the
    // reference drops those pyTMD rejects (e.g. la2).
    const keep: number[] = [];
    const dropped: string[] = [];
    allCons.forEach((c, i) => (isSupportedConstituent(c) ? keep.push(i) : dropped.push(c)));
    this.constituents = keep.map((i) => allCons[i]);
    this.dropped = dropped;
    const pick = (src: Float64Array): Float64Array => {
      const out = new Float64Array(keep.length * per);
      keep.forEach((ci, k) => out.set(src.subarray(ci * per, (ci + 1) * per), k * per));
      return out;
    };
    this.eastAmp = pick(ea);
    this.eastPha = pick(ep);
    this.northAmp = pick(na);
    this.northPha = pick(np_);

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
    this.cacheMaxEntries = Math.max(1, opts.cacheMaxEntries ?? 96);
  }

  contains(lon: number, lat: number): boolean {
    return bboxContains(this.bbox, lon, lat);
  }

  /** Predict u/v (cm/s) over the whole grid at an MJD. */
  predictGrid(mjd: number): { u: Float64Array; v: Float64Array } {
    const { pu, pf, G } = tidalArguments(mjd, this.constituents);
    const per = this.lats.length * this.lons.length;
    const u = new Float64Array(per);
    const v = new Float64Array(per);
    const DEG = Math.PI / 180;
    for (let c = 0; c < this.constituents.length; c++) {
      const theta = G[c] * DEG + pu[c];
      const f = pf[c];
      const base = c * per;
      for (let i = 0; i < per; i++) {
        u[i] += this.eastAmp[base + i] * f * Math.cos(theta - this.eastPha[base + i] * DEG);
        v[i] += this.northAmp[base + i] * f * Math.cos(theta - this.northPha[base + i] * DEG);
      }
    }
    return { u, v };
  }

  private cachedGrid(mjd: number): { u: Float64Array; v: Float64Array } {
    const bin = this.cacheBinMinutes / 1440;
    const key = Math.round(mjd / bin) * bin;
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
  private interp(grid: Float64Array, lon: number, lat: number): number {
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
    const g = this.cachedGrid(dateToMjd(time));
    const u = this.interp(g.u, lon, lat);
    const v = this.interp(g.v, lon, lat);
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
    const per = this.lats.length * this.lons.length * 8 * 2;
    return per * this.cache.size;
  }
}
