/**
 * Pure tide computations on hourly series (SI: metres, seconds):
 * high / low water extraction with parabolic refinement, tidal range,
 * tendency, and the mean-sea-level offset that turns the model's
 * geoid-referenced total sea level into a level relative to local mean
 * sea level. No I/O; tides/sealevel.ts feeds these from the Copernicus
 * Marine hourly sea-level product.
 */

/** A regular series: value k at t0Ms + k·stepMs; NaN = no value. */
export interface RegularSeries {
  t0Ms: number;
  stepMs: number;
  values: ArrayLike<number>;
}

export interface TideExtremum {
  kind: 'high' | 'low';
  /** Instant of the extremum (parabolic refinement between samples), ms. */
  timeMs: number;
  /** Height at the extremum, m (same reference as the series). */
  height: number;
}

/**
 * Minimum height difference between a high water and the adjacent low
 * water for both to count (removes model wiggles and the 1 mm
 * quantisation of the product around slack water; keeps real double
 * high waters such as the Solent's, whose dip is ~0.1–0.3 m).
 */
export const MIN_PROMINENCE_M = 0.03;

/** |dh/dt| below this is "steady": 2 cm per hour, in m/s. */
export const STEADY_RATE_MS = 0.02 / 3600;

/**
 * Vertex of the parabola through (−1, hm), (0, h0), (+1, hp): offset in
 * samples (−0.5..0.5 for a true local extremum) and the height there.
 */
export function parabolicVertex(hm: number, h0: number, hp: number): { dt: number; h: number } {
  const denom = hm - 2 * h0 + hp;
  if (denom === 0) return { dt: 0, h: h0 };
  let dt = (hm - hp) / (2 * denom);
  if (dt > 0.5) dt = 0.5;
  if (dt < -0.5) dt = -0.5;
  const h = h0 - 0.25 * (hm - hp) * dt;
  return { dt, h };
}

/**
 * High and low waters of a series, in time order, alternating. A local
 * extremum is a sample (or a run of equal samples) above / below both
 * finite neighbours; a single-sample extremum is refined with a
 * parabola through it and its neighbours, a plateau takes its centre.
 * Extrema at the ends of the series (or next to a gap) are not
 * reported. Then adjacent high/low pairs closer than `minProminence`
 * are removed (smallest first) and consecutive extrema of the same kind
 * merged (the more extreme kept), until every adjacent pair differs by
 * at least `minProminence`.
 */
export function findExtrema(s: RegularSeries, minProminence = MIN_PROMINENCE_M): TideExtremum[] {
  const h = s.values;
  const n = h.length;
  const cand: TideExtremum[] = [];
  let i = 1;
  while (i < n - 1) {
    const v = h[i];
    if (!Number.isFinite(v)) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && h[j + 1] === v) j++;
    const left = h[i - 1];
    const right = j + 1 < n ? h[j + 1] : NaN;
    if (Number.isFinite(left) && Number.isFinite(right)) {
      const kind = v > left && v > right ? 'high' : v < left && v < right ? 'low' : null;
      if (kind) {
        if (j === i) {
          const p = parabolicVertex(left, v, right);
          cand.push({ kind, timeMs: s.t0Ms + (i + p.dt) * s.stepMs, height: p.h });
        } else {
          cand.push({ kind, timeMs: s.t0Ms + ((i + j) / 2) * s.stepMs, height: v });
        }
      }
    }
    i = j + 1;
  }
  const merge = (list: TideExtremum[]): TideExtremum[] => {
    const out: TideExtremum[] = [];
    for (const e of list) {
      const last = out[out.length - 1];
      if (last && last.kind === e.kind) {
        if ((e.kind === 'high' && e.height > last.height) || (e.kind === 'low' && e.height < last.height)) out[out.length - 1] = e;
      } else out.push(e);
    }
    return out;
  };
  let list = merge(cand);
  for (;;) {
    let best = -1;
    let bestD = Infinity;
    for (let k = 0; k + 1 < list.length; k++) {
      const d = Math.abs(list[k].height - list[k + 1].height);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best < 0 || bestD >= minProminence) break;
    list = merge([...list.slice(0, best), ...list.slice(best + 2)]);
  }
  return list;
}

/** Height differences between consecutive (alternating) high and low waters, m. */
export function tidalRanges(ext: TideExtremum[]): number[] {
  const out: number[] = [];
  for (let k = 0; k + 1 < ext.length; k++) {
    if (ext[k].kind !== ext[k + 1].kind) out.push(Math.abs(ext[k].height - ext[k + 1].height));
  }
  return out;
}

/** Value at `tMs`, linear between the bracketing samples; null outside the series or next to a missing sample. */
export function sampleSeries(s: RegularSeries, tMs: number): number | null {
  const q = (tMs - s.t0Ms) / s.stepMs;
  const n = s.values.length;
  if (!(q >= 0 && q <= n - 1)) return null;
  const k = Math.floor(q);
  const f = q - k;
  const a = s.values[k];
  if (f === 0) return Number.isFinite(a) ? a : null;
  const b = s.values[k + 1];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return a + f * (b - a);
}

/**
 * Rate of change at `tMs`, m/s: the slope between the samples one step
 * either side (central difference; one-sided at the ends). null when
 * those samples are missing.
 */
export function slopeAt(s: RegularSeries, tMs: number): number | null {
  const a = sampleSeries(s, tMs - s.stepMs);
  const b = sampleSeries(s, tMs + s.stepMs);
  const c = sampleSeries(s, tMs);
  if (a !== null && b !== null) return (b - a) / (2 * s.stepMs / 1000);
  if (c !== null && b !== null) return (b - c) / (s.stepMs / 1000);
  if (a !== null && c !== null) return (c - a) / (s.stepMs / 1000);
  return null;
}

export type Tendency = 'rising' | 'falling' | 'steady';

export function tendencyOf(rateMs: number | null): Tendency | null {
  if (rateMs === null || !Number.isFinite(rateMs)) return null;
  if (Math.abs(rateMs) < STEADY_RATE_MS) return 'steady';
  return rateMs > 0 ? 'rising' : 'falling';
}

/** Signal K TendencyKind for a rate of change (m/s). */
export function signalKTendency(rateMs: number | null): 'steady' | 'decreasing' | 'increasing' | 'not available' {
  const t = tendencyOf(rateMs);
  return t === null ? 'not available' : t === 'steady' ? 'steady' : t === 'rising' ? 'increasing' : 'decreasing';
}

/**
 * Mean-sea-level offset: the mean of (total − tide) over the samples
 * where both are finite, i.e. the local mean of the non-tidal level
 * above the geoid (mean dynamic topography + the mean dynamic anomaly,
 * inverse barometer and global steric / mass terms over the window).
 * Returns the offset and the number of samples used (NaN, 0 when none).
 */
export function mslOffset(total: ArrayLike<number>, tide: ArrayLike<number>): { offset: number; samples: number } {
  let s = 0;
  let n = 0;
  const len = Math.min(total.length, tide.length);
  for (let k = 0; k < len; k++) {
    const a = total[k];
    const b = tide[k];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    s += a - b;
    n++;
  }
  return n ? { offset: s / n, samples: n } : { offset: NaN, samples: 0 };
}

/**
 * Derived levels relative to local mean sea level, from one sample of
 * the model's tide (ocean_tide) and total sea level (above the geoid):
 *   tide        = ocean_tide
 *   surge       = total − tide − offset      (non-tidal residual)
 *   waterLevel  = total − offset = tide + surge
 */
export function derivedLevels(tide: number, total: number, offset: number): { tide: number; surge: number; waterLevel: number } {
  const surge = total - tide - offset;
  return { tide, surge, waterLevel: tide + surge };
}
