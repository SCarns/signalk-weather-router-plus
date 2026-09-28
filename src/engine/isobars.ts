/**
 * Isobars and pressure centres from a regular MSL grid, ported from the
 * routing server's `routers/pressure.py`:
 *  - contour lines at `interval` hPa via marching squares with linear
 *    interpolation along cell edges (contourpy's `lines()` equivalent),
 *    bold every 20 hPa and at 1000 hPa;
 *  - one label every ~4° of path length (measured in degrees);
 *  - highs/lows: gaussian smooth (sigma 1), local max/min over a 9×9
 *    footprint, prominence ≥ 1 hPa against the 19×19 local mean, border
 *    cells excluded.
 * Input field is in hPa on ascending lat/lon axes.
 */

export interface IsobarFeature {
  type: 'Feature';
  geometry: { type: 'LineString'; coordinates: [number, number][] } | { type: 'Point'; coordinates: [number, number] };
  properties: Record<string, unknown>;
}

const BOLD_MULTIPLE = 20;
const LABEL_SPACING_DEG = 4.0;
const HL_PROMINENCE = 1.0;
const HL_FOOTPRINT = 9;

function r5(x: number): number {
  return Math.round(x * 1e5) / 1e5;
}

/** Separable gaussian blur with "nearest" edge handling, truncated at 4 sigma. */
export function gaussianFilter(src: Float64Array, ny: number, nx: number, sigma: number): Float64Array {
  const radius = Math.ceil(4 * sigma);
  const kernel: number[] = [];
  let sum = 0;
  for (let k = -radius; k <= radius; k++) {
    const w = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel.push(w);
    sum += w;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const tmp = new Float64Array(ny * nx);
  const out = new Float64Array(ny * nx);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.max(0, Math.min(nx - 1, x + k));
        acc += src[y * nx + xx] * kernel[k + radius];
      }
      tmp[y * nx + x] = acc;
    }
  }
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.max(0, Math.min(ny - 1, y + k));
        acc += tmp[yy * nx + x] * kernel[k + radius];
      }
      out[y * nx + x] = acc;
    }
  }
  return out;
}

function windowStat(src: Float64Array, ny: number, nx: number, size: number, op: 'max' | 'min' | 'mean'): Float64Array {
  const half = Math.floor(size / 2);
  const out = new Float64Array(ny * nx);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      let acc = op === 'max' ? -Infinity : op === 'min' ? Infinity : 0;
      let n = 0;
      for (let dy = -half; dy < size - half; dy++) {
        const yy = Math.max(0, Math.min(ny - 1, y + dy));
        for (let dx = -half; dx < size - half; dx++) {
          const xx = Math.max(0, Math.min(nx - 1, x + dx));
          const v = src[yy * nx + xx];
          if (op === 'max') acc = Math.max(acc, v);
          else if (op === 'min') acc = Math.min(acc, v);
          else {
            acc += v;
            n++;
          }
        }
      }
      out[y * nx + x] = op === 'mean' ? acc / n : acc;
    }
  }
  return out;
}

export function findExtrema(field: Float64Array, lons: Float64Array, lats: Float64Array): { highs: { lon: number; lat: number; hpa: number }[]; lows: { lon: number; lat: number; hpa: number }[] } {
  const ny = lats.length;
  const nx = lons.length;
  const sm = gaussianFilter(field, ny, nx, 1.0);
  const mx = windowStat(sm, ny, nx, HL_FOOTPRINT, 'max');
  const mn = windowStat(sm, ny, nx, HL_FOOTPRINT, 'min');
  const bg = windowStat(sm, ny, nx, HL_FOOTPRINT * 2 + 1, 'mean');
  const highs: { lon: number; lat: number; hpa: number }[] = [];
  const lows: { lon: number; lat: number; hpa: number }[] = [];
  for (let y = 1; y < ny - 1; y++) {
    for (let x = 1; x < nx - 1; x++) {
      const i = y * nx + x;
      if (sm[i] === mx[i] && sm[i] - bg[i] >= HL_PROMINENCE) highs.push({ lon: lons[x], lat: lats[y], hpa: Math.round(sm[i] * 10) / 10 });
      if (sm[i] === mn[i] && bg[i] - sm[i] >= HL_PROMINENCE) lows.push({ lon: lons[x], lat: lats[y], hpa: Math.round(sm[i] * 10) / 10 });
    }
  }
  return { highs, lows };
}

/**
 * Marching squares: polylines of `field == level`. Cells with a NaN
 * corner are skipped. Segments are joined into polylines by endpoint.
 */
export function contourLines(field: Float64Array, lons: Float64Array, lats: Float64Array, level: number): [number, number][][] {
  const ny = lats.length;
  const nx = lons.length;
  const segs: [number, number, number, number][] = [];
  const interp = (x0: number, y0: number, v0: number, x1: number, y1: number, v1: number): [number, number] => {
    const t = v1 === v0 ? 0.5 : (level - v0) / (v1 - v0);
    return [x0 + t * (x1 - x0), y0 + t * (y1 - y0)];
  };
  for (let y = 0; y + 1 < ny; y++) {
    for (let x = 0; x + 1 < nx; x++) {
      const v00 = field[y * nx + x];
      const v10 = field[y * nx + x + 1];
      const v01 = field[(y + 1) * nx + x];
      const v11 = field[(y + 1) * nx + x + 1];
      if (![v00, v10, v01, v11].every(Number.isFinite)) continue;
      const c = (v00 >= level ? 1 : 0) | (v10 >= level ? 2 : 0) | (v11 >= level ? 4 : 0) | (v01 >= level ? 8 : 0);
      if (c === 0 || c === 15) continue;
      const X0 = lons[x];
      const X1 = lons[x + 1];
      const Y0 = lats[y];
      const Y1 = lats[y + 1];
      const bottom = (): [number, number] => interp(X0, Y0, v00, X1, Y0, v10);
      const right = (): [number, number] => interp(X1, Y0, v10, X1, Y1, v11);
      const top = (): [number, number] => interp(X0, Y1, v01, X1, Y1, v11);
      const left = (): [number, number] => interp(X0, Y0, v00, X0, Y1, v01);
      const add = (a: [number, number], b: [number, number]): void => {
        segs.push([a[0], a[1], b[0], b[1]]);
      };
      switch (c) {
        case 1: case 14: add(left(), bottom()); break;
        case 2: case 13: add(bottom(), right()); break;
        case 3: case 12: add(left(), right()); break;
        case 4: case 11: add(right(), top()); break;
        case 6: case 9: add(bottom(), top()); break;
        case 7: case 8: add(left(), top()); break;
        case 5: {
          const centre = (v00 + v10 + v01 + v11) / 4;
          if (centre >= level) { add(left(), top()); add(bottom(), right()); } else { add(left(), bottom()); add(right(), top()); }
          break;
        }
        case 10: {
          const centre = (v00 + v10 + v01 + v11) / 4;
          if (centre >= level) { add(left(), bottom()); add(right(), top()); } else { add(left(), top()); add(bottom(), right()); }
          break;
        }
        default: break;
      }
    }
  }
  // Join segments into polylines.
  const key = (x: number, y: number): string => `${Math.round(x * 1e7)},${Math.round(y * 1e7)}`;
  const byStart = new Map<string, number[]>();
  const byEnd = new Map<string, number[]>();
  segs.forEach((s, i) => {
    const ks = key(s[0], s[1]);
    const ke = key(s[2], s[3]);
    (byStart.get(ks) ?? byStart.set(ks, []).get(ks)!).push(i);
    (byEnd.get(ke) ?? byEnd.set(ke, []).get(ke)!).push(i);
  });
  const used = new Uint8Array(segs.length);
  const lines: [number, number][][] = [];
  const take = (map: Map<string, number[]>, k: string): number => {
    const arr = map.get(k);
    if (!arr) return -1;
    while (arr.length) {
      const i = arr.pop()!;
      if (!used[i]) return i;
    }
    return -1;
  };
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const line: [number, number][] = [[segs[i][0], segs[i][1]], [segs[i][2], segs[i][3]]];
    // Extend forward.
    for (;;) {
      const last = line[line.length - 1];
      const j = take(byStart, key(last[0], last[1]));
      if (j < 0) {
        const jr = take(byEnd, key(last[0], last[1]));
        if (jr < 0) break;
        used[jr] = 1;
        line.push([segs[jr][0], segs[jr][1]]);
        continue;
      }
      used[j] = 1;
      line.push([segs[j][2], segs[j][3]]);
    }
    // Extend backward.
    for (;;) {
      const first = line[0];
      const j = take(byEnd, key(first[0], first[1]));
      if (j < 0) {
        const jf = take(byStart, key(first[0], first[1]));
        if (jf < 0) break;
        used[jf] = 1;
        line.unshift([segs[jf][2], segs[jf][3]]);
        continue;
      }
      used[j] = 1;
      line.unshift([segs[j][0], segs[j][1]]);
    }
    lines.push(line);
  }
  return lines;
}

function* labelPointsAlong(coords: [number, number][], spacingDeg: number): Generator<[number, number]> {
  if (coords.length < 2) return;
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]));
  const total = cum[cum.length - 1];
  if (total < spacingDeg * 0.5) return;
  const n = Math.max(1, Math.floor(total / spacingDeg));
  for (let k = 1; k <= n; k++) {
    const d = (k - 0.5) * (total / n);
    let i = 0;
    while (i + 1 < cum.length && cum[i + 1] <= d) i++;
    i = Math.max(0, Math.min(i, coords.length - 2));
    const seg = cum[i + 1] - cum[i];
    const a = seg > 0 ? (d - cum[i]) / seg : 0;
    yield [coords[i][0] * (1 - a) + coords[i + 1][0] * a, coords[i][1] * (1 - a) + coords[i + 1][1] * a];
  }
}

/**
 * Build the GeoJSON features: isobar LineStrings (`kind: "isobar"`,
 * `hpa`, `bold`), label Points (`kind: "label"`), and `high`/`low` Points.
 */
export function buildIsobarFeatures(fieldHpa: Float64Array, lons: Float64Array, lats: Float64Array, intervalHpa: number): IsobarFeature[] {
  let vmin = Infinity;
  let vmax = -Infinity;
  for (let i = 0; i < fieldHpa.length; i++) {
    const v = fieldHpa[i];
    if (!Number.isFinite(v)) continue;
    if (v < vmin) vmin = v;
    if (v > vmax) vmax = v;
  }
  const out: IsobarFeature[] = [];
  if (!Number.isFinite(vmin)) return out;
  const lo = Math.floor(vmin / intervalHpa) * intervalHpa;
  const hi = Math.ceil(vmax / intervalHpa) * intervalHpa;
  for (let level = lo; level <= hi + 1e-9; level += intervalHpa) {
    const hpaInt = Math.round(level);
    const bold = hpaInt % BOLD_MULTIPLE === 0 || hpaInt === 1000;
    for (const line of contourLines(fieldHpa, lons, lats, level)) {
      if (line.length < 2) continue;
      out.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line.map(([x, y]) => [r5(x), r5(y)]) }, properties: { kind: 'isobar', hpa: hpaInt, bold } });
      for (const [lon, lat] of labelPointsAlong(line, LABEL_SPACING_DEG)) {
        out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r5(lon), r5(lat)] }, properties: { kind: 'label', hpa: hpaInt } });
      }
    }
  }
  const { highs, lows } = findExtrema(fieldHpa, lons, lats);
  for (const h of highs) out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r5(h.lon), r5(h.lat)] }, properties: { kind: 'high', hpa: h.hpa } });
  for (const l of lows) out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r5(l.lon), r5(l.lat)] }, properties: { kind: 'low', hpa: l.hpa } });
  return out;
}
