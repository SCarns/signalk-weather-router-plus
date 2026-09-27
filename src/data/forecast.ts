/**
 * In-memory forecast store: gridded wind (10u/10v), pressure (msl) and
 * waves (swh/mwp/mwd) cropped to a bounding box, with bilinear spatial
 * and linear temporal interpolation.
 *
 * Fields are decoded from global GRIB2 messages and only the bbox slice
 * is retained, so resident memory scales with the route area, not the
 * planet: a 10° × 10° box at 0.25° is 41 × 41 cells × 4 B ≈ 6.7 kB per
 * field per step.
 *
 * Wind direction is meteorological (FROM). Wave fields carry NaN over
 * land in the source; a limited nearest-neighbour fill (up to
 * `waveFillCells` cells) is applied so coastal waypoints still get a
 * value, matching the reference implementation's `_wave_nanfill_limited`.
 */

import type { Grib2Grid, Grib2Message } from '../grib/grib2';
import type { BBox } from '../geo/geodesy';
import { bboxWidth, lonOffsetFromWest } from '../geo/geodesy';
import type { WaveConditions, WindSource } from '../engine/environment';

export interface FieldGrid {
  /** Latitude of row 0 (southernmost), degrees. */
  lat0: number;
  /** Longitude of column 0, degrees (in -180..180 after wrap). */
  lon0: number;
  dLat: number;
  dLon: number;
  nLat: number;
  nLon: number;
  /** Row-major from the south, NaN = missing. */
  values: Float32Array;
}

export interface ForecastStep {
  /** Valid time (ms since epoch). */
  validMs: number;
  stepHours: number;
  fields: Map<string, FieldGrid>;
}

export interface ForecastMeta {
  cycleTime: Date;
  bbox: BBox;
  steps: number[];
  params: string[];
  loadedAt: Date;
}

/**
 * Crop a decoded global field to `bbox` (plus one cell of margin on
 * each side so bilinear interpolation at the edges has neighbours).
 * Handles the 0..360 longitude convention of ECMWF grids and boxes
 * crossing the antimeridian.
 */
export function cropField(grid: Grib2Grid, values: Float64Array, bbox: BBox, marginCells = 1): FieldGrid {
  if (!grid.iScansPositively) throw new Error('cropField: grids scanning west are not supported');
  const { ni, nj, di, dj } = grid;
  // Latitude rows in the message run from la1 towards la2.
  const latTop = grid.la1;
  const rowsSouthUp = grid.jScansPositively;
  const latAt = (row: number): number => (rowsSouthUp ? latTop + row * dj : latTop - row * dj);
  // Row indices covering [south, north].
  const rowIdxForLat = (lat: number): number => (rowsSouthUp ? (lat - latTop) / dj : (latTop - lat) / dj);
  let rA = Math.floor(Math.min(rowIdxForLat(bbox.south), rowIdxForLat(bbox.north))) - marginCells;
  let rB = Math.ceil(Math.max(rowIdxForLat(bbox.south), rowIdxForLat(bbox.north))) + marginCells;
  rA = Math.max(0, rA);
  rB = Math.min(nj - 1, rB);
  if (rA > rB) throw new Error('cropField: bbox has no latitude overlap with the grid');
  const nLat = rB - rA + 1;

  // Longitude columns: the grid covers lo1 .. lo1 + (ni-1)*di, possibly
  // the whole circle. Work in offsets east of lo1.
  const lo1 = grid.lo1;
  const globalWrap = Math.abs(ni * di - 360) < 1e-6;
  const offWest = ((bbox.west - lo1) % 360 + 360) % 360;
  const width = bboxWidth(bbox);
  let cA = Math.floor(offWest / di) - marginCells;
  let cB = Math.ceil((offWest + width) / di) + marginCells;
  if (!globalWrap) {
    cA = Math.max(0, cA);
    cB = Math.min(ni - 1, cB);
    if (cA > cB) throw new Error('cropField: bbox has no longitude overlap with the grid');
  }
  const nLon = cB - cA + 1;
  if (nLon > ni) throw new Error('cropField: bbox wider than the grid');

  const out = new Float32Array(nLat * nLon);
  // Output rows run south → north.
  for (let r = 0; r < nLat; r++) {
    const srcRow = rowsSouthUp ? rA + r : rB - r;
    for (let c = 0; c < nLon; c++) {
      let srcCol = cA + c;
      if (globalWrap) srcCol = ((srcCol % ni) + ni) % ni;
      out[r * nLon + c] = values[srcRow * ni + srcCol];
    }
  }
  const lat0 = rowsSouthUp ? latAt(rA) : latAt(rB);
  let lon0 = lo1 + cA * di;
  lon0 = ((lon0 + 180) % 360 + 360) % 360 - 180;
  return { lat0, lon0, dLat: dj, dLon: di, nLat, nLon, values: out };
}

/**
 * Limited nearest-neighbour fill of NaN cells, as in the reference
 * implementation's `_wave_nanfill_limited`: every NaN cell takes the
 * value of the nearest valid cell (Euclidean, in cells) scaled by
 * clip(1 - d / maxCells, 0, 1). Cells farther than `maxCells` from any
 * valid cell therefore become 0, not NaN. A grid with no valid cell at
 * all is returned unchanged.
 */
export function nanFillLimited(f: FieldGrid, maxCells: number): FieldGrid {
  const { nLat, nLon, values } = f;
  const out = new Float32Array(values);
  let anyValid = false;
  for (let i = 0; i < values.length && !anyValid; i++) if (!Number.isNaN(values[i])) anyValid = true;
  if (!anyValid) return f;
  // Ring search out to maxCells + 1 (Euclidean nearest can sit one
  // Chebyshev ring beyond the first hit); beyond that the fade is 0.
  const maxRing = Math.ceil(maxCells) + 1;
  for (let r = 0; r < nLat; r++) {
    for (let c = 0; c < nLon; c++) {
      const idx = r * nLon + c;
      if (!Number.isNaN(values[idx])) continue;
      let best = 0;
      let bestD = Infinity;
      for (let d = 1; d <= maxRing && d < bestD; d++) {
        for (let rr = r - d; rr <= r + d; rr++) {
          if (rr < 0 || rr >= nLat) continue;
          for (let cc = c - d; cc <= c + d; cc++) {
            if (cc < 0 || cc >= nLon) continue;
            if (Math.max(Math.abs(rr - r), Math.abs(cc - c)) !== d) continue;
            const v = values[rr * nLon + cc];
            if (!Number.isNaN(v)) {
              const dist = Math.hypot(rr - r, cc - c);
              if (dist < bestD) {
                bestD = dist;
                best = v;
              }
            }
          }
        }
      }
      out[idx] = bestD < Infinity ? best * Math.max(0, Math.min(1, 1 - bestD / maxCells)) : 0;
    }
  }
  return { ...f, values: out };
}

/**
 * Bilinear sample. Positions outside the cropped grid clamp to the
 * nearest edge cell (the source grid is global, so the crop margin is
 * the only reason a query can fall outside; extrapolating would invent
 * values).
 */
export function sampleField(f: FieldGrid, lon: number, lat: number): number {
  const { nLat, nLon } = f;
  const offLon = ((lon - f.lon0) % 360 + 360) % 360;
  // If the offset is closer going west (box near the seam), allow negative.
  let x = offLon > 180 ? (offLon - 360) / f.dLon : offLon / f.dLon;
  let y = (lat - f.lat0) / f.dLat;
  if (x < 0) x = 0;
  if (x > nLon - 1) x = nLon - 1;
  if (y < 0) y = 0;
  if (y > nLat - 1) y = nLat - 1;
  let c = Math.floor(x);
  let r = Math.floor(y);
  if (nLon === 1) c = 0;
  else c = Math.max(0, Math.min(nLon - 2, c));
  if (nLat === 1) r = 0;
  else r = Math.max(0, Math.min(nLat - 2, r));
  const tx = nLon === 1 ? 0 : x - c;
  const ty = nLat === 1 ? 0 : y - r;
  const v00 = f.values[r * nLon + c];
  const v01 = f.values[r * nLon + Math.min(nLon - 1, c + 1)];
  const v10 = f.values[Math.min(nLat - 1, r + 1) * nLon + c];
  const v11 = f.values[Math.min(nLat - 1, r + 1) * nLon + Math.min(nLon - 1, c + 1)];
  const a = v00 + tx * (v01 - v00);
  const b = v10 + tx * (v11 - v10);
  return a + ty * (b - a);
}

export class ForecastStore implements WindSource {
  readonly steps: ForecastStep[];
  readonly meta: ForecastMeta;
  readonly hasWaves: boolean;

  constructor(steps: ForecastStep[], meta: ForecastMeta) {
    if (steps.length === 0) throw new Error('ForecastStore needs at least one step');
    this.steps = [...steps].sort((a, b) => a.validMs - b.validMs);
    this.meta = meta;
    this.hasWaves = this.steps.every((s) => s.fields.has('swh') && s.fields.has('mwp') && s.fields.has('mwd'));
    for (const s of this.steps) {
      if (!s.fields.has('10u') || !s.fields.has('10v')) throw new Error(`step +${s.stepHours}h lacks 10u/10v`);
    }
  }

  /** Bracketing step indices and blend factor for a time. */
  timeBlend(time: Date): [number, number, number] {
    const n = this.steps.length;
    const t = time.getTime();
    if (n === 1 || t <= this.steps[0].validMs) return [0, 0, 0];
    if (t >= this.steps[n - 1].validMs) return [n - 1, n - 1, 0];
    let i = 1;
    while (i < n && this.steps[i].validMs <= t) i++;
    const t0 = this.steps[i - 1].validMs;
    const t1 = this.steps[i].validMs;
    const alpha = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    return [i - 1, i, alpha];
  }

  private blended(param: string, lon: number, lat: number, time: Date): number {
    const [i0, i1, a] = this.timeBlend(time);
    const f0 = this.steps[i0].fields.get(param);
    if (!f0) return NaN;
    const v0 = sampleField(f0, lon, lat);
    if (a === 0 || i0 === i1) return v0;
    const f1 = this.steps[i1].fields.get(param);
    if (!f1) return v0;
    return v0 * (1 - a) + sampleField(f1, lon, lat) * a;
  }

  /** Wind [speed m/s, direction FROM degrees]. */
  at(lon: number, lat: number, time: Date): [number, number] {
    const u = this.blended('10u', lon, lat, time);
    const v = this.blended('10v', lon, lat, time);
    return [Math.hypot(u, v), ((270 - Math.atan2(v, u) * 180 / Math.PI) % 360 + 360) % 360];
  }

  atMany(lons: Float64Array, lats: Float64Array, time: Date): { speed: Float64Array; dir: Float64Array } {
    const n = lons.length;
    const speed = new Float64Array(n);
    const dir = new Float64Array(n);
    const [i0, i1, a] = this.timeBlend(time);
    const u0 = this.steps[i0].fields.get('10u')!;
    const v0 = this.steps[i0].fields.get('10v')!;
    const u1 = this.steps[i1].fields.get('10u')!;
    const v1 = this.steps[i1].fields.get('10v')!;
    for (let k = 0; k < n; k++) {
      let u = sampleField(u0, lons[k], lats[k]);
      let v = sampleField(v0, lons[k], lats[k]);
      if (a !== 0 && i0 !== i1) {
        u = u * (1 - a) + sampleField(u1, lons[k], lats[k]) * a;
        v = v * (1 - a) + sampleField(v1, lons[k], lats[k]) * a;
      }
      speed[k] = Math.hypot(u, v);
      dir[k] = ((270 - Math.atan2(v, u) * 180 / Math.PI) % 360 + 360) % 360;
    }
    return { speed, dir };
  }

  wavesAt(lon: number, lat: number, time: Date): WaveConditions | null {
    if (!this.hasWaves) return null;
    const [i0, i1, a] = this.timeBlend(time);
    const g = (p: string, i: number): number => sampleField(this.steps[i].fields.get(p)!, lon, lat);
    let swh = g('swh', i0);
    let mwp = g('mwp', i0);
    let mwd: number;
    const d0 = g('mwd', i0) * Math.PI / 180;
    if (a === 0 || i0 === i1) {
      mwd = ((d0 * 180 / Math.PI) % 360 + 360) % 360;
    } else {
      swh = swh * (1 - a) + g('swh', i1) * a;
      mwp = mwp * (1 - a) + g('mwp', i1) * a;
      const d1 = g('mwd', i1) * Math.PI / 180;
      const sx = Math.sin(d0) * (1 - a) + Math.sin(d1) * a;
      const cx = Math.cos(d0) * (1 - a) + Math.cos(d1) * a;
      mwd = ((Math.atan2(sx, cx) * 180 / Math.PI) % 360 + 360) % 360;
    }
    if (!Number.isFinite(swh)) return null;
    return { swh, mwp, mwd };
  }

  /** Mean sea-level pressure in Pa, or NaN when not loaded. */
  mslAt(lon: number, lat: number, time: Date): number {
    return this.blended('msl', lon, lat, time);
  }

  /** Generic sampler for any loaded parameter (SI as in the GRIB). */
  paramAt(param: string, lon: number, lat: number, time: Date): number {
    return this.blended(param, lon, lat, time);
  }

  get validRange(): [Date, Date] {
    return [new Date(this.steps[0].validMs), new Date(this.steps[this.steps.length - 1].validMs)];
  }

  /** Does the store cover this position (within the cropped grid)? */
  covers(lon: number, lat: number): boolean {
    const f = this.steps[0].fields.get('10u')!;
    const off = lonOffsetFromWest({ west: f.lon0, east: f.lon0, south: 0, north: 0 }, lon);
    const x = off > 180 ? off - 360 : off;
    const y = lat - f.lat0;
    return x >= 0 && x <= (f.nLon - 1) * f.dLon && y >= 0 && y <= (f.nLat - 1) * f.dLat;
  }

  /** Approximate resident bytes of all fields. */
  bytes(): number {
    let b = 0;
    for (const s of this.steps) for (const f of s.fields.values()) b += f.values.byteLength;
    return b;
  }

  /** Structured-clone friendly form for crossing a worker boundary. */
  serialize(): SerializedForecast {
    return {
      steps: this.steps.map((s) => ({ validMs: s.validMs, stepHours: s.stepHours, fields: [...s.fields.entries()] })),
      meta: {
        cycleTimeMs: this.meta.cycleTime.getTime(),
        bbox: this.meta.bbox,
        steps: this.meta.steps,
        params: this.meta.params,
        loadedAtMs: this.meta.loadedAt.getTime(),
      },
    };
  }

  static deserialize(s: SerializedForecast): ForecastStore {
    return new ForecastStore(
      s.steps.map((st) => ({ validMs: st.validMs, stepHours: st.stepHours, fields: new Map(st.fields) })),
      { cycleTime: new Date(s.meta.cycleTimeMs), bbox: s.meta.bbox, steps: s.meta.steps, params: s.meta.params, loadedAt: new Date(s.meta.loadedAtMs) },
    );
  }

  /** Does this store's crop contain the whole box? */
  coversBBox(b: BBox): boolean {
    const f = this.steps[0].fields.get('10u')!;
    const spanLon = (f.nLon - 1) * f.dLon;
    const spanLat = (f.nLat - 1) * f.dLat;
    const west = lonOffsetFromWest({ west: f.lon0, east: f.lon0, south: 0, north: 0 }, b.west);
    const wStart = west > 180 ? west - 360 : west;
    return wStart >= 0 && wStart + bboxWidth(b) <= spanLon && b.south >= f.lat0 && b.north <= f.lat0 + spanLat;
  }
}

export interface SerializedForecast {
  steps: { validMs: number; stepHours: number; fields: [string, FieldGrid][] }[];
  meta: { cycleTimeMs: number; bbox: BBox; steps: number[]; params: string[]; loadedAtMs: number };
}

/**
 * Build a step from decoded messages. `messages` must all share the
 * same valid time; params are named by the caller.
 */
export function buildStep(
  named: { param: string; message: Grib2Message }[], bbox: BBox, waveFillCells = 3,
): ForecastStep {
  if (named.length === 0) throw new Error('buildStep: no messages');
  const first = named[0].message;
  const validMs = first.referenceTime.getTime() + first.product.forecastHours * 3600_000;
  const fields = new Map<string, FieldGrid>();
  for (const { param, message } of named) {
    const v = message.referenceTime.getTime() + message.product.forecastHours * 3600_000;
    if (v !== validMs) throw new Error(`buildStep: ${param} valid time differs from the first message`);
    let f = cropField(message.grid, message.decode(), bbox);
    if (param === 'swh' || param === 'mwp' || param === 'mwd') f = nanFillLimited(f, waveFillCells);
    fields.set(param, f);
  }
  return { validMs, stepHours: first.product.forecastHours, fields };
}
