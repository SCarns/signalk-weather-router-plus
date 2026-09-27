import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableSteps, cycleFor } from './ecmwf';
import { cropField, nanFillLimited, sampleField, ForecastStore, type FieldGrid } from './forecast';
import type { Grib2Grid } from '../grib/grib2';

test('cycle naming and stream selection', () => {
  const c00 = cycleFor(new Date('2026-09-27T00:00:00Z'));
  assert.equal(c00.yyyymmdd, '20260927');
  assert.equal(c00.hh, '00');
  assert.equal(c00.atmStream, 'oper');
  assert.equal(c00.waveStream, 'wave');
  const c06 = cycleFor(new Date('2026-09-27T06:00:00Z'));
  assert.equal(c06.atmStream, 'scda');
  assert.equal(c06.waveStream, 'scwv');
});

test('published step lists', () => {
  assert.deepEqual(availableSteps('oper', 12), [0, 3, 6, 9, 12]);
  const s = availableSteps('oper', 240);
  assert.equal(s[s.length - 1], 240);
  assert.ok(s.includes(144) && s.includes(150) && !s.includes(147));
  const sc = availableSteps('scda', 240);
  assert.equal(sc[sc.length - 1], 90);
});

// A tiny global-style grid: 0..359 by 1°, 90..-90 by 1°, scanning north→south like ECMWF.
function syntheticGrid(): { grid: Grib2Grid; values: Float64Array } {
  const ni = 360;
  const nj = 181;
  const grid: Grib2Grid = {
    ni, nj, la1: 90, lo1: 0, la2: -90, lo2: 359, di: 1, dj: 1, scanningMode: 0, jScansPositively: false, iScansPositively: true,
  };
  const values = new Float64Array(ni * nj);
  for (let r = 0; r < nj; r++) {
    for (let c = 0; c < ni; c++) {
      const lat = 90 - r;
      const lon = c;
      values[r * ni + c] = lat * 1000 + lon; // unique, linear in both axes
    }
  }
  return { grid, values };
}

test('cropField keeps the bbox slice with correct geo-referencing, including across the antimeridian', () => {
  const { grid, values } = syntheticGrid();
  const f = cropField(grid, values, { west: -75, south: 36, east: -65, north: 45 }, 1);
  // Rows run south → north in the crop.
  assert.equal(f.lat0, 35);
  assert.equal(f.dLat, 1);
  assert.equal(f.nLat, 12);
  assert.equal(f.lon0, -76);
  assert.equal(f.nLon, 13);
  // Value at (lat 40, lon -70): 40*1000 + 290 (lon -70 ≡ 290 in the 0..359 grid).
  assert.equal(sampleField(f, -70, 40), 40 * 1000 + 290);
  // Bilinear midpoint.
  assert.equal(sampleField(f, -70.5, 40.5), 40.5 * 1000 + 289.5);

  const g = cropField(grid, values, { west: 175, south: -5, east: -175, north: 5 }, 1);
  assert.equal(sampleField(g, 179, 0), 179);
  assert.equal(sampleField(g, -179, 0), 181);
  assert.equal(sampleField(g, 180, 2), 2 * 1000 + 180);
});

test('sampleField clamps outside the crop instead of extrapolating', () => {
  const f: FieldGrid = { lat0: 0, lon0: 0, dLat: 1, dLon: 1, nLat: 2, nLon: 2, values: Float32Array.from([0, 1, 2, 3]) };
  assert.equal(sampleField(f, 0.5, 0.5), 1.5);
  assert.equal(sampleField(f, 5, 5), 3);
  assert.equal(sampleField(f, -5, -5), 0);
});

test('nanFillLimited fills near valid cells and leaves distant NaN', () => {
  const v = new Float32Array(25).fill(NaN);
  v[12] = 10;
  const f: FieldGrid = { lat0: 0, lon0: 0, dLat: 1, dLon: 1, nLat: 5, nLon: 5, values: v };
  const g = nanFillLimited(f, 2);
  assert.equal(g.values[12], 10);
  assert.ok(Math.abs(g.values[13] - 5) < 1e-6); // distance 1 of max 2 → half weight
  assert.equal(g.values[0], 0); // corner: Euclidean 2.83 > 2 → fade 0 → 0, as in the reference
  assert.ok(Math.abs(g.values[6] - 10 * (1 - Math.SQRT2 / 2)) < 1e-6); // diagonal neighbour (row 1, col 1)
});

test('ForecastStore blends steps in time and reports wind FROM direction', () => {
  const mk = (u: number, v: number): FieldGrid => ({ lat0: 0, lon0: 0, dLat: 1, dLon: 1, nLat: 2, nLon: 2, values: Float32Array.from([u, u, u, u]) });
  const t0 = Date.UTC(2026, 0, 1, 0);
  const t1 = t0 + 3 * 3600_000;
  const steps = [
    { validMs: t0, stepHours: 0, fields: new Map([['10u', mk(0, 0)], ['10v', mk(-10, 0)]]) },
    { validMs: t1, stepHours: 3, fields: new Map([['10u', mk(10, 0)], ['10v', mk(0, 0)]]) },
  ];
  // Fix the v component grids: mk builds a constant field of its first arg.
  steps[0].fields.set('10v', { ...mk(-10, 0) });
  const store = new ForecastStore(steps, { cycleTime: new Date(t0), bbox: { west: 0, south: 0, east: 1, north: 1 }, steps: [0, 3], params: ['10u', '10v'], loadedAt: new Date() });
  // At t0: u=0, v=-10 → wind blowing south → FROM north (0°).
  const [s0, d0] = store.at(0.5, 0.5, new Date(t0));
  assert.ok(Math.abs(s0 - 10) < 1e-6);
  assert.ok(Math.abs(d0 - 0) < 1e-6);
  // At t1: u=10, v=0 → blowing east → FROM west (270°).
  const [s1, d1] = store.at(0.5, 0.5, new Date(t1));
  assert.ok(Math.abs(s1 - 10) < 1e-6);
  assert.ok(Math.abs(d1 - 270) < 1e-6);
  // Midway: components blend linearly → u=5, v=-5 → FROM 315°.
  const [sm, dm] = store.at(0.5, 0.5, new Date((t0 + t1) / 2));
  assert.ok(Math.abs(sm - Math.hypot(5, 5)) < 1e-6);
  assert.ok(Math.abs(dm - 315) < 1e-6);
  assert.equal(store.hasWaves, false);
  const ser = store.serialize();
  const back = ForecastStore.deserialize(ser);
  assert.equal(back.steps.length, 2);
  assert.ok(back.coversBBox({ west: 0, south: 0, east: 1, north: 1 }));
  assert.ok(!back.coversBBox({ west: 0, south: 0, east: 5, north: 1 }));
});
