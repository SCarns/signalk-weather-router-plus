/**
 * Golden samples: exact output of every bilinear / nearest sampler on
 * fixed grids at fixed points, stored under test-data/golden/samples.json.
 * Guards the sampler consolidation (docs/plans/structural-cleanup.md,
 * phases 1.2 and 3.2): the index arithmetic must stay bit-exact, so the
 * comparison is Object.is on every number (NaN equals NaN, -0 ≠ 0).
 *
 * Regenerate on purpose only:  GOLDEN_UPDATE=1 npm test
 *
 * Not covered: HarmonicCurrentSource.interp / pointAt (private, needs
 * tidal constituents); its own tests compare against the Python
 * reference.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sampleField, sampleFieldNearest, windowCovers, type FieldGrid } from './forecast';
import { bilinearCorners } from './arco';
import { bilinearFilled, bilinearFilledScalar, sampleFieldPairFilled, type PairGrid } from '../currents/coastfill';

const FIXTURE = path.join(__dirname, '..', '..', 'test-data', 'golden', 'samples.json');
const UPDATE = process.env.GOLDEN_UPDATE === '1';

/** Deterministic PRNG so the points are the same every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Smooth field with a few NaN holes, as Float32. */
function values(nLat: number, nLon: number, seed: number, holes: number): Float32Array {
  const r = rng(seed);
  const v = new Float32Array(nLat * nLon);
  for (let j = 0; j < nLat; j++) for (let i = 0; i < nLon; i++) v[j * nLon + i] = Math.fround(10 * Math.sin(i / 3) * Math.cos(j / 5) + r());
  for (let k = 0; k < holes; k++) v[Math.floor(r() * v.length)] = NaN;
  return v;
}

function grids(): Record<string, FieldGrid> {
  const global: FieldGrid = {
    lat0: -90,
    lon0: 0,
    dLat: 0.25,
    dLon: 0.25,
    nLat: 721,
    nLon: 1440,
    values: values(721, 1440, 1, 500),
    wrapLon: true,
  };
  const coarseGlobal: FieldGrid = {
    lat0: -89.5,
    lon0: -180,
    dLat: 1,
    dLon: 1,
    nLat: 180,
    nLon: 360,
    values: values(180, 360, 2, 40),
    wrapLon: true,
  };
  // Cropped box across the antimeridian, no wrap.
  const crop: FieldGrid = { lat0: 30, lon0: 170, dLat: 0.25, dLon: 0.25, nLat: 41, nLon: 81, values: values(41, 81, 3, 30) };
  // Cropped box across the Greenwich seam.
  const seam: FieldGrid = { lat0: 40, lon0: -5, dLat: 0.5, dLon: 0.5, nLat: 21, nLon: 31, values: values(21, 31, 4, 10) };
  // Degenerate single row / single column.
  const row: FieldGrid = { lat0: 10, lon0: 0, dLat: 1, dLon: 1, nLat: 1, nLon: 20, values: values(1, 20, 5, 0) };
  const col: FieldGrid = { lat0: 0, lon0: 7, dLat: 1, dLon: 1, nLat: 20, nLon: 1, values: values(20, 1, 6, 0) };
  // A window of the global grid (rows 300..420, columns 1400..39 wrapping past the seam).
  const w = { r0: 300, c0: 1400, nr: 121, nc: 80 };
  const win = new Float32Array(w.nr * w.nc);
  for (let lr = 0; lr < w.nr; lr++)
    for (let lc = 0; lc < w.nc; lc++) win[lr * w.nc + lc] = global.values[(w.r0 + lr) * 1440 + ((w.c0 + lc) % 1440)];
  const windowed: FieldGrid = { ...global, values: win, win: w };
  return { global, coarseGlobal, crop, seam, row, col, windowed };
}

/** Points: inside, on edges, outside, on the seams, far longitudes, poles. */
function points(seed: number, n: number): [number, number][] {
  const r = rng(seed);
  const out: [number, number][] = [];
  for (let k = 0; k < n; k++) out.push([-540 + r() * 1080, -95 + r() * 190]);
  out.push(
    [0, 0],
    [-180, 0],
    [180, 0],
    [359.999, 89.9],
    [-0.001, -90],
    [170, 30],
    [190, 40],
    [189.99, 39.99],
    [-5, 40],
    [10, 50],
    [10.25, 45.5]
  );
  return out;
}

function serializeNumber(x: number): string | number {
  if (Number.isNaN(x)) return 'NaN';
  if (Object.is(x, -0)) return '-0';
  if (!Number.isFinite(x)) return x > 0 ? 'Inf' : '-Inf';
  return x;
}

function run(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const g = grids();
  const pts = points(7, 200);
  for (const [name, f] of Object.entries(g)) {
    out[`sampleField:${name}`] = pts.map(([lon, lat]) => serializeNumber(sampleField(f, lon, lat)));
    out[`sampleFieldNearest:${name}`] = pts.map(([lon, lat]) => serializeNumber(sampleFieldNearest(f, lon, lat)));
    if (f.win) out[`windowCovers:${name}`] = pts.map(([lon, lat]) => windowCovers(f, f.win!, lon, lat));
  }
  // arco.bilinearCorners at fractional cell coordinates, wrapping and not.
  const r = rng(8);
  const cornersIn: [number, number, boolean, number, number][] = [];
  for (let k = 0; k < 150; k++) {
    const nRows = 1 + Math.floor(r() * 40);
    const nCols = 1 + Math.floor(r() * 90);
    const wrap = r() < 0.5;
    cornersIn.push([nRows, nCols, wrap, r() * (nCols + 0.5) - 0.25, r() * (nRows + 0.5) - 0.25]);
  }
  cornersIn.push([1, 1, false, 0, 0], [1, 1, true, 0.5, 0], [10, 10, true, 10, 9], [10, 10, false, 9, 9], [10, 10, true, 9.999, 0.001]);
  out['bilinearCorners'] = cornersIn.map(a => {
    const c = bilinearCorners(...a);
    return [a, Object.fromEntries(Object.entries(c).map(([k, v]) => [k, serializeNumber(v)]))];
  });
  // coastfill: a pair grid with a coast (NaN band) and the fill applied.
  const nRows = 30;
  const nCols = 50;
  const u = values(nRows, nCols, 9, 0);
  const v = values(nRows, nCols, 10, 0);
  for (let j = 0; j < nRows; j++)
    for (let i = 0; i < nCols; i++)
      if (i > 20 + j / 3 && i < 26 + j / 3) {
        u[j * nCols + i] = NaN;
        v[j * nCols + i] = NaN;
      }
  const pair: PairGrid = { nRows, nCols, wrap: false, u, v, offset: 0 };
  const pairWrap: PairGrid = { nRows, nCols, wrap: true, u, v, offset: 0 };
  const scalar = { nRows, nCols, wrap: false, v: u, offset: 0 };
  const q = rng(11);
  const cells: [number, number][] = [];
  for (let k = 0; k < 200; k++) cells.push([q() * (nCols - 1), q() * (nRows - 1)]);
  cells.push([0, 0], [nCols - 1, nRows - 1], [22.5, 10.5], [24, 3], [21, 29]);
  out['bilinearFilled'] = cells.map(([x, y]) => bilinearFilled(pair, x, y).map(serializeNumber));
  out['bilinearFilled:wrap'] = cells.map(([x, y]) => bilinearFilled(pairWrap, x, y).map(serializeNumber));
  out['bilinearFilledScalar'] = cells.map(([x, y]) => {
    const s = bilinearFilledScalar(scalar, x, y);
    return [serializeNumber(s.value), s.filled];
  });
  // sampleFieldPairFilled on FieldGrids built from the same arrays.
  const fu: FieldGrid = { lat0: 20, lon0: -30, dLat: 0.5, dLon: 0.5, nLat: nRows, nLon: nCols, values: u };
  const fv: FieldGrid = { ...fu, values: v };
  out['sampleFieldPairFilled'] = points(12, 120).map(([lon, lat]) =>
    sampleFieldPairFilled(fu, fv, -30 + ((lon + 540) % 30), 20 + ((lat + 95) % 16)).map(serializeNumber)
  );
  return out;
}

test('golden samples are bit-exact', () => {
  const out = run();
  if (UPDATE || !fs.existsSync(FIXTURE)) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, JSON.stringify(out) + '\n');
    if (!UPDATE) assert.fail(`golden fixture was missing and has been written to ${FIXTURE}; run the tests again`);
    return;
  }
  const want = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
  for (const k of Object.keys(out)) assert.deepStrictEqual(out[k], want[k], `${k} changed (GOLDEN_UPDATE=1 regenerates on purpose)`);
  assert.deepStrictEqual(Object.keys(out).sort(), Object.keys(want).sort(), 'golden sample list changed');
});
