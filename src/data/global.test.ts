/**
 * Global resident store: full-precision Float32 fields in
 * SharedArrayBuffers, longitude wrap (0/360 seam and antimeridian), and
 * sample-for-sample agreement with the cropped Float32 store it replaces.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { iterateGrib2, type Grib2Grid, type Grib2Message } from '../grib/grib2';
import {
  buildStep, cropField, globalField, nanFillLimited, sampleField, sampleFieldNearest, ForecastStore, GLOBAL_BBOX, type FieldGrid,
} from './forecast';

const fixture = path.join(__dirname, '..', '..', 'test-data', 'ecmwf_10u10v_3steps.grib2');

/** Real ECMWF 0.25° messages (10u/10v, 3 steps), grouped by step. */
function realSteps(): { param: string; message: Grib2Message }[][] {
  const msgs = [...iterateGrib2(new Uint8Array(fs.readFileSync(fixture)))];
  const byStep = new Map<number, { param: string; message: Grib2Message }[]>();
  for (const m of msgs) {
    const param = m.product.parameterNumber === 2 ? '10u' : '10v';
    const l = byStep.get(m.product.forecastHours) ?? [];
    l.push({ param, message: m });
    byStep.set(m.product.forecastHours, l);
  }
  return [...byStep.values()];
}

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('global store keeps every decoded value at Float32, bit for bit, in shared memory', () => {
  const steps = realSteps();
  const { message } = steps[0][0];
  const g = message.grid;
  assert.equal(g.ni, 1440);
  assert.equal(g.nj, 721);
  const decoded = message.decode();
  const f = globalField(g, decoded);
  assert.ok(f.values.buffer instanceof SharedArrayBuffer);
  assert.equal(f.wrapLon, true);
  assert.equal(f.lat0, -90);
  assert.equal(f.nLat, 721);
  assert.equal(f.nLon, 1440);
  // Row r of the store (from the south) is row nj-1-r of the message (from the north).
  for (let r = 0; r < g.nj; r++) {
    for (let c = 0; c < g.ni; c++) {
      const want = Math.fround(decoded[(g.nj - 1 - r) * g.ni + c]);
      const got: number = f.values[r * g.ni + c];
      if (!Object.is(got, want)) assert.fail(`cell r${r} c${c}: ${got} != ${want}`);
    }
  }
});

test('global store samples exactly like the cropped Float32 store (real ECMWF fields)', () => {
  const named = realSteps();
  const t0 = named[0][0].message.referenceTime.getTime();
  const globalSteps = named.map((n) => buildStep(n, null));
  const global = new ForecastStore(globalSteps, { cycleTime: new Date(t0), bbox: GLOBAL_BBOX, steps: [0, 3, 6], params: ['10u', '10v'], loadedAt: new Date() });
  assert.equal(global.global, true);
  assert.equal(global.shared, true);
  const boxes = [
    { west: -75, south: 36, east: -65, north: 45 }, // NW Atlantic
    { west: 170, south: -20, east: -170, north: 0 }, // across the antimeridian
    { west: -10, south: 45, east: 10, north: 60 }, // across the 0° seam of the 0..360 grid
    { west: 100, south: -70, east: 140, north: -40 },
  ];
  const rand = rng(42);
  let dyadicExact = 0;
  let randomChecked = 0;
  let randomExact = 0;
  let maxRel = 0;
  for (const bbox of boxes) {
    const cropSteps = named.map((n) => buildStep(n, bbox));
    const crop = new ForecastStore(cropSteps, { cycleTime: new Date(t0), bbox, steps: [0, 3, 6], params: ['10u', '10v'], loadedAt: new Date() });
    const width = ((bbox.east - bbox.west) % 360 + 360) % 360;
    const times = [t0, t0 + 3600_000, t0 + 4.5 * 3600_000, t0 + 6 * 3600_000].map((t) => new Date(t));
    // Dyadic positions (multiples of 1/64°): every step of the arithmetic is
    // exact in both stores, so the results must be bit-identical.
    for (let i = 0; i < 400; i++) {
      const lon = bbox.west + Math.floor(rand() * width * 64) / 64;
      const lat = bbox.south + Math.floor(rand() * (bbox.north - bbox.south) * 64) / 64;
      for (const t of times) {
        for (const p of ['10u', '10v']) {
          const a = crop.paramAt(p, lon, lat, t);
          const b = global.paramAt(p, lon, lat, t);
          if (!Object.is(a, b)) assert.fail(`${p} at ${lon},${lat} ${t.toISOString()}: crop ${a} global ${b}`);
          dyadicExact++;
        }
        const [sa, da] = crop.at(lon, lat, t);
        const [sb, db] = global.at(lon, lat, t);
        assert.ok(Object.is(sa, sb) && Object.is(da, db), `wind at ${lon},${lat}`);
      }
    }
    // Arbitrary positions and times: also required to be bit-identical.
    for (let i = 0; i < 2000; i++) {
      const lon = bbox.west + rand() * width;
      const lat = bbox.south + rand() * (bbox.north - bbox.south);
      const t = new Date(t0 + rand() * 6 * 3600_000);
      const a = crop.paramAt('10u', lon, lat, t);
      const b = global.paramAt('10u', lon, lat, t);
      const rel = Math.abs(a - b) / Math.max(1, Math.abs(a));
      if (rel > maxRel) maxRel = rel;
      if (a === b) randomExact++;
      randomChecked++;
      if (!Object.is(a, b)) assert.fail(`10u at ${lon},${lat} ${t.toISOString()}: crop ${a} global ${b}`);
    }
  }
  assert.ok(dyadicExact > 0 && randomChecked > 0);
  // Report the agreement (visible with --test-reporter=spec).
  console.log(`global vs crop: ${dyadicExact} dyadic samples bit-identical; ${randomExact}/${randomChecked} arbitrary samples bit-identical, max relative difference ${maxRel.toExponential(2)}`);
});

// A 1° global grid, 0..359 E, 90..-90 N, north→south like ECMWF.
function grid1(): { grid: Grib2Grid; values: Float64Array } {
  const ni = 360;
  const nj = 181;
  const grid: Grib2Grid = { ni, nj, la1: 90, lo1: 0, la2: -90, lo2: 359, di: 1, dj: 1, scanningMode: 0, jScansPositively: false, iScansPositively: true };
  const values = new Float64Array(ni * nj);
  for (let r = 0; r < nj; r++) for (let c = 0; c < ni; c++) values[r * ni + c] = (90 - r) * 1000 + c;
  return { grid, values };
}

test('antimeridian and 0° seam: sampling wraps with no seam', () => {
  const { grid, values } = grid1();
  const f = globalField(grid, values);
  // Across the 359°/0° seam: halfway between column 359 (value …359) and column 0 (…000).
  assert.equal(sampleField(f, 359.5, 10), 10 * 1000 + (359 + 0) / 2);
  assert.equal(sampleField(f, -0.5, 10), 10 * 1000 + (359 + 0) / 2);
  assert.equal(sampleField(f, 0, 10), 10 * 1000);
  assert.equal(sampleField(f, 360, 10), 10 * 1000);
  // Across the antimeridian (180° is an ordinary column of a 0..359 grid).
  assert.equal(sampleField(f, 180, 0), 180);
  assert.equal(sampleField(f, -180, 0), 180);
  assert.equal(sampleField(f, 179.5, 0), 179.5);
  assert.equal(sampleField(f, -179.5, 0), 180.5);
  // Continuity through both seams: a walk in 0.01° steps never jumps.
  for (const start of [179, -1]) {
    let prev = sampleField(f, start, 20);
    for (let i = 1; i <= 200; i++) {
      const v = sampleField(f, start + i * 0.01, 20);
      const jump = Math.abs(v - prev);
      assert.ok(jump < 359 * 0.011 + 1e-9, `jump ${jump} at ${start + i * 0.01}`);
      prev = v;
    }
  }
  // Nearest (ptype) wraps too: 359.6° is nearest to column 0.
  assert.equal(sampleFieldNearest(f, 359.6, 10), 10 * 1000);
  assert.equal(sampleFieldNearest(f, -179.6, 10), 10 * 1000 + 180);
  // Poles clamp in latitude.
  assert.equal(sampleField(f, 10, 90), 90 * 1000 + 10);
  assert.equal(sampleField(f, 10, -90), -90 * 1000 + 10);
  // Agrees with an antimeridian crop.
  const crop = cropField(grid, values, { west: 175, south: -5, east: -175, north: 5 }, 1);
  for (const lon of [175.25, 179.75, 180, -179.75, -175.5]) {
    for (const lat of [-4.5, 0, 3.25]) assert.equal(sampleField(f, lon, lat), sampleField(crop, lon, lat), `${lon},${lat}`);
  }
});

test('global store covers everywhere; a crop does not', () => {
  const { grid, values } = grid1();
  const ref = new Date('2026-09-27T00:00:00Z');
  const msg = (p: string) => ({ param: p, message: { grid, referenceTime: ref, product: { forecastHours: 0 }, decode: () => values } as unknown as Grib2Message });
  const step = buildStep([msg('10u'), msg('10v')], null);
  const store = new ForecastStore([step], { cycleTime: ref, bbox: GLOBAL_BBOX, steps: [0], params: ['10u', '10v'], loadedAt: new Date() });
  assert.equal(store.global, true);
  for (const [lon, lat] of [[0, 0], [180, 89.9], [-180, -90], [359.99, 45], [-73, 40]]) assert.ok(store.covers(lon, lat));
  assert.ok(store.coversBBox({ west: 170, south: -80, east: -170, north: 80 }));
  const cropStore = new ForecastStore([buildStep([msg('10u'), msg('10v')], { west: -75, south: 36, east: -65, north: 45 })], { cycleTime: ref, bbox: GLOBAL_BBOX, steps: [0], params: ['10u', '10v'], loadedAt: new Date() });
  assert.equal(cropStore.global, false);
  assert.equal(cropStore.covers(0, 0), false);
  // Memory: 360 × 181 cells × 4 B per field.
  assert.equal(store.bytes(), 2 * 360 * 181 * 4);
});

test('tprate ingest scaling is identical for global and cropped fields', () => {
  const { grid, values } = grid1();
  const ref = new Date('2026-09-27T00:00:00Z');
  const msg = (p: string) => ({ param: p, message: { grid, referenceTime: ref, product: { forecastHours: 3 }, decode: () => values } as unknown as Grib2Message });
  const bbox = { west: -75, south: 36, east: -65, north: 45 };
  const g = buildStep([msg('10u'), msg('10v'), msg('tprate')], null).fields.get('tprate')!;
  const c = buildStep([msg('10u'), msg('10v'), msg('tprate')], bbox).fields.get('tprate')!;
  for (let lat = 36; lat <= 45; lat += 0.5) {
    for (let lon = -75; lon <= -65; lon += 0.5) assert.ok(Object.is(sampleField(g, lon, lat), sampleField(c, lon, lat)), `${lon},${lat}`);
  }
});

/** The previous nanFillLimited, kept verbatim as the reference. */
function nanFillReference(f: FieldGrid, maxCells: number): FieldGrid {
  const { nLat, nLon, values } = f;
  const out = new Float32Array(values);
  let anyValid = false;
  for (let i = 0; i < values.length && !anyValid; i++) if (!Number.isNaN(values[i])) anyValid = true;
  if (!anyValid) return f;
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

test('pruned nanFillLimited equals the previous implementation on non-wrapping grids', () => {
  const rand = rng(7);
  for (let trial = 0; trial < 30; trial++) {
    const nLat = 5 + Math.floor(rand() * 40);
    const nLon = 5 + Math.floor(rand() * 40);
    const v = new Float32Array(nLat * nLon);
    const landFrac = rand();
    for (let i = 0; i < v.length; i++) v[i] = rand() < landFrac ? NaN : Math.round(rand() * 1000) / 10;
    const f: FieldGrid = { lat0: 0, lon0: 0, dLat: 1, dLon: 1, nLat, nLon, values: v };
    for (const maxCells of [1, 2, 3, 2.5]) {
      const a = nanFillReference(f, maxCells).values;
      const b = nanFillLimited(f, maxCells).values;
      for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) assert.fail(`trial ${trial} max ${maxCells} cell ${i}: ${a[i]} vs ${b[i]}`);
      const copy: FieldGrid = { ...f, values: new Float32Array(new SharedArrayBuffer(v.length * 4)) };
      copy.values.set(v);
      const c = nanFillLimited(copy, maxCells, { inPlace: true });
      assert.equal(c.values, copy.values, 'in place');
      for (let i = 0; i < a.length; i++) if (!Object.is(a[i], c.values[i])) assert.fail(`in-place trial ${trial} max ${maxCells} cell ${i}`);
    }
  }
});

test('nanFillLimited wraps across the seam on a full-circle grid and keeps shared memory', () => {
  const nLon = 20;
  const nLat = 3;
  const v = new Float32Array(new SharedArrayBuffer(nLon * nLat * 4)).fill(NaN);
  v[1 * nLon + 1] = 8; // valid cell at column 1
  const f: FieldGrid = { lat0: -1, lon0: 0, dLat: 1, dLon: 18, nLat, nLon, values: v, wrapLon: true };
  const g = nanFillLimited(f, 3);
  assert.ok(g.values.buffer instanceof SharedArrayBuffer);
  // Column 19 is 2 columns west of column 1 across the seam: 8 × (1 - 2/3).
  assert.ok(Math.abs(g.values[1 * nLon + 19] - 8 / 3) < 1e-6);
  // Without wrap it would be 18 columns away → 0.
  const h = nanFillLimited({ ...f, wrapLon: false }, 3);
  assert.equal(h.values[1 * nLon + 19], 0);
});

test('SharedArrayBuffer fields are shared, not copied, across a worker boundary', async () => {
  const { grid, values } = grid1();
  const ref = new Date('2026-09-27T00:00:00Z');
  const msg = (p: string) => ({ param: p, message: { grid, referenceTime: ref, product: { forecastHours: 0 }, decode: () => values } as unknown as Grib2Message });
  const store = new ForecastStore([buildStep([msg('10u'), msg('10v')], null)], { cycleTime: ref, bbox: GLOBAL_BBOX, steps: [0], params: ['10u', '10v'], loadedAt: new Date() });
  const u = store.steps[0].fields.get('10u')!;
  const before = u.values[5];
  // The worker reads a cell, then writes a marker into the field; if the
  // clone had copied the array the main thread would never see the write.
  const code = `
    const { parentPort } = require('node:worker_threads');
    parentPort.once('message', (ser) => {
      const fields = new Map(ser.steps[0].fields);
      const u = fields.get('10u');
      const seen = u.values[5];
      const shared = u.values.buffer instanceof SharedArrayBuffer;
      u.values[5] = -12345.5;
      parentPort.postMessage({ seen, shared, byteLength: u.values.byteLength });
    });`;
  const w = new Worker(code, { eval: true });
  try {
    const reply = await new Promise<{ seen: number; shared: boolean; byteLength: number }>((resolve, reject) => {
      w.once('message', resolve);
      w.once('error', reject);
      w.postMessage(store.serialize());
    });
    assert.equal(reply.seen, before);
    assert.equal(reply.shared, true);
    assert.equal(reply.byteLength, 360 * 181 * 4);
    assert.equal(u.values[5], -12345.5, 'write from the worker is visible here: the memory is shared');
    // The main-thread wrapper (deserialize) also aliases the same memory.
    const back = ForecastStore.deserialize(store.serialize());
    assert.equal(back.steps[0].fields.get('10u')!.values.buffer, u.values.buffer);
  } finally {
    await w.terminate();
  }
});

test('decode with reused scratch buffers returns exactly the fresh-buffer values', () => {
  const msgs = [...iterateGrib2(new Uint8Array(fs.readFileSync(fixture)))];
  const scratch = {};
  for (const m of msgs) {
    const fresh = m.decode();
    const reused = m.decode(scratch);
    assert.equal(reused.length, fresh.length);
    for (let i = 0; i < fresh.length; i++) if (!Object.is(fresh[i], reused[i])) assert.fail(`message ${m.offset} cell ${i}`);
  }
});
