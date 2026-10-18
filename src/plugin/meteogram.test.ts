// The meteogram of a route (meteogram.ts, worker/query.ts track_conditions):
// the boat's track through the passage, the wind relative to its course,
// and the conditions read a chunk of the track at a time, which must equal
// sampling the whole run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { haversineDistanceM } from '../geo/geodesy';
import { ForecastStore, GLOBAL_BBOX, type FieldGrid, type ForecastStep } from '../data/forecast';
import { DecodedRunWriter, openDecodedRun } from '../data/decoded';
import { meteogramRows, METEOGRAM_MAX_SAMPLES, routePoints, sampleStep, trackSamples, trueWindAngle } from './meteogram';
import { sampleConditions, type ConditionsRow } from './overlays';
import { trackConditions } from './worker/query';
import type { WorkerState } from './worker/state';

const T0 = Date.UTC(2026, 10, 2, 6);
const H = 3600_000;

/** A route job's GeoJSON: the line, then one Point per route point (values of the leg into it). */
function routeGeoJSON(pts: { lon: number; lat: number; h: number; mode?: string; sog?: number }[]) {
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: pts.map(p => [p.lon, p.lat]) }, properties: {} },
      ...pts.map(p => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { time: new Date(T0 + p.h * H).toISOString(), mode: p.mode ?? 'sailing', sog_ms: p.sog ?? 3 },
      })),
    ],
  };
}

test('routePoints: the timed Points in time order; fewer than two is an error', () => {
  const g = routeGeoJSON([
    { lon: -9.4, lat: 38.7, h: 0, mode: 'motoring', sog: 0 },
    { lon: -10.4, lat: 38.2, h: 6 },
    { lon: -11.4, lat: 37.7, h: 12 },
  ]);
  // Out of order and a broken feature: sorted, skipped.
  g.features.push(g.features.splice(2, 1)[0]);
  g.features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { time: 'never' } } as never);
  const pts = routePoints(g);
  assert.deepEqual(
    pts.map(p => p.tMs),
    [T0, T0 + 6 * H, T0 + 12 * H]
  );
  assert.equal(pts[0].mode, 'motoring');
  assert.throws(() => routePoints(routeGeoJSON([{ lon: 0, lat: 0, h: 0 }])), /fewer than two/);
  assert.throws(() => routePoints({}), /no features/);
});

test('trackSamples: start and arrival included, even pace along each great-circle leg, the leg’s mode and speed', () => {
  const pts = routePoints(
    routeGeoJSON([
      { lon: 177, lat: -18, h: 0, mode: 'motoring', sog: 0 },
      { lon: 176, lat: -18.5, h: 6, mode: 'sailing', sog: 4 },
      { lon: 175, lat: -19, h: 10, mode: 'motoring', sog: 3 },
    ])
  );
  const s = trackSamples(pts, 3600);
  assert.equal(s.length, 11, 'hours 0..10');
  assert.equal(s[0].time, new Date(T0).toISOString());
  assert.deepEqual([s[0].lon, s[0].lat], [177, -18]);
  assert.deepEqual([s[10].lon, s[10].lat], [175, -19], 'arrival exactly at the last point');
  // Hour 3 is halfway through the first leg's time: halfway along its distance.
  const legM = haversineDistanceM(177, -18, 176, -18.5);
  assert.ok(Math.abs(haversineDistanceM(177, -18, s[3].lon, s[3].lat) - legM / 2) < 1, 'halfway');
  assert.ok(Math.abs(haversineDistanceM(s[3].lon, s[3].lat, 176, -18.5) - legM / 2) < 1);
  // The values of a point are the leg into it: the first leg sails at 4 m/s.
  assert.deepEqual(s.map(x => [x.leg, x.mode, x.sog_ms]).slice(0, 8), [
    [0, 'sailing', 4],
    [0, 'sailing', 4],
    [0, 'sailing', 4],
    [0, 'sailing', 4],
    [0, 'sailing', 4],
    [0, 'sailing', 4],
    [1, 'motoring', 3],
    [1, 'motoring', 3],
  ]);
  // Course: south-west-ish on both legs, the great circle's bearing at the sample.
  for (const x of s) assert.ok(x.cog_deg! > 230 && x.cog_deg! < 250, String(x.cog_deg));
  // A step that does not divide the passage still ends at the arrival.
  const t = trackSamples(pts, 4 * 3600);
  assert.deepEqual(
    t.map(x => (x.tMs - T0) / H),
    [0, 4, 8, 10]
  );
});

test('trackSamples across the antimeridian: longitudes wrapped, positions on the leg', () => {
  const pts = routePoints(
    routeGeoJSON([
      { lon: 179.5, lat: -17, h: 0 },
      { lon: -179.5, lat: -17, h: 2 },
    ])
  );
  const s = trackSamples(pts, 3600);
  assert.equal(s.length, 3);
  assert.ok(Math.abs(Math.abs(s[1].lon) - 180) < 0.01, `midway at the antimeridian (${s[1].lon})`);
  assert.ok(s.every(x => x.lon >= -180 && x.lon < 180));
  assert.ok(Math.abs(s[1].cog_deg! - 90) < 1);
});

test('sampleStep: the step asked for unless the passage would need too many rows', () => {
  assert.deepEqual(sampleStep(4 * 86400, 3600), { stepS: 3600, raised: false });
  const long = sampleStep(90 * 86400, 600);
  assert.equal(long.raised, true);
  assert.ok(Math.ceil((90 * 86400) / long.stepS) + 1 <= METEOGRAM_MAX_SAMPLES + 1);
  assert.equal(long.stepS % 60, 0, 'whole minutes');
});

test('trueWindAngle: 0 head to wind, 180 dead downwind, the side the wind comes from', () => {
  assert.deepEqual(trueWindAngle(0, 0), { twa: 0, tack: null });
  assert.deepEqual(trueWindAngle(90, 0), { twa: 90, tack: 'starboard' });
  assert.deepEqual(trueWindAngle(270, 0), { twa: 90, tack: 'port' });
  assert.deepEqual(trueWindAngle(180, 0), { twa: 180, tack: null });
  assert.deepEqual(trueWindAngle(10, 350), { twa: 20, tack: 'starboard' }, 'across north');
  assert.deepEqual(trueWindAngle(340, 20), { twa: 40, tack: 'port' });
  assert.deepEqual(trueWindAngle(null, 20), { twa: null, tack: null });
  assert.deepEqual(trueWindAngle(20, null), { twa: null, tack: null });
});

test('meteogramRows: each sample with its conditions, the wind angle from the sampled wind, rows past the forecast marked', () => {
  const pts = routePoints(
    routeGeoJSON([
      { lon: 10, lat: 0, h: 0 },
      { lon: 10, lat: 1, h: 4 },
    ])
  );
  const s = trackSamples(pts, 3600);
  const cond = s.map(x => ({ time: x.time, wind_ms: 5, wind_dir_deg: 90 }) as ConditionsRow);
  const rows = meteogramRows(s, cond, T0 + 2 * H);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].twa_deg, 90, 'course north, wind from the east');
  assert.equal(rows[0].tack, 'starboard');
  assert.equal(rows[0].wind_ms, 5);
  assert.equal(rows[0].lon, 10);
  assert.deepEqual(
    rows.map(r => r.beyond_forecast),
    [false, false, false, true, true]
  );
  assert.throws(() => meteogramRows(s, cond.slice(1), null), /expected 5/);
});

// ── The data worker's query against a decoded run on disk ──

const PARAMS = ['10u', '10v', 'msl', '10fg', 'swh', 'mwp', 'mwd'];

/** A global 2° run, 9 steps 3 h apart, smooth fields that change with time and place. */
function syntheticStore(): ForecastStore {
  const nLon = 180;
  const nLat = 91;
  const steps: ForecastStep[] = [];
  for (let k = 0; k < 9; k++) {
    const fields = new Map<string, FieldGrid>();
    PARAMS.forEach((p, pi) => {
      const v = new Float32Array(nLon * nLat);
      for (let r = 0; r < nLat; r++)
        for (let c = 0; c < nLon; c++) {
          const base = Math.sin((c + 7 * pi) * 0.11 + k * 0.4) * Math.cos((r - 45) * 0.07) * 8;
          v[r * nLon + c] =
            p === 'msl'
              ? 101300 + base * 120
              : p === 'mwd'
                ? (base * 40 + 360) % 360
                : p === 'swh' || p === 'mwp' || p === '10fg'
                  ? Math.abs(base) + 0.5
                  : base;
        }
      fields.set(p, { lat0: -90, lon0: -180, dLat: 2, dLon: 2, nLat, nLon, values: v, wrapLon: true });
    });
    steps.push({ validMs: T0 + k * 3 * H, stepHours: k * 3, fields });
  }
  return new ForecastStore(steps, {
    cycleTime: new Date(T0),
    bbox: GLOBAL_BBOX,
    steps: steps.map(s => s.stepHours),
    params: PARAMS,
    loadedAt: new Date(T0),
  });
}

test('track_conditions: read a chunk at a time, every row equals sampling the whole run (across the antimeridian too)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meteogram-'));
  try {
    const store = syntheticStore();
    const w = new DecodedRunWriter(root, '2026102022');
    for (const s of store.steps) w.writeStep(s);
    w.finish({ cycleTimeMs: T0, request: { horizonHours: 24, params: PARAMS }, stepHours: store.meta.steps, decodeMs: 1 });
    const { run, problem } = openDecodedRun(w.finalDir);
    assert.ok(run, problem ?? '');
    const st = {
      run,
      forecastMemory: { heldBytes: 0, last: null },
      stack: { isEmpty: true },
      overlayLand: null,
      tides: null,
    } as unknown as WorkerState;
    // 27 hours east across the antimeridian: 28 samples, three chunks.
    const pts = routePoints(
      routeGeoJSON([
        { lon: 175, lat: -18, h: 0 },
        { lon: -178, lat: -16, h: 15 },
        { lon: -172, lat: -14, h: 27 },
      ])
    );
    const samples = trackSamples(pts, 3600);
    assert.equal(samples.length, 28);
    const tc = await trackConditions(st, { points: samples.map(p => ({ lon: p.lon, lat: p.lat, tMs: p.tMs })) });
    assert.equal(tc.cycle, new Date(T0).toISOString());
    assert.equal(tc.validTo, new Date(T0 + 24 * H).toISOString());
    assert.equal(tc.rows.length, samples.length);
    const whole = { forecast: store, currents: null, land: null, tides: null };
    samples.forEach((p, k) => assert.deepEqual(tc.rows[k], sampleConditions(whole, p.lon, p.lat, new Date(p.tMs)), `row ${k}`));
    assert.ok(tc.rows.some(r => r.gust_ms !== null) && tc.rows.every(r => r.wind_ms !== null && r.swh_m !== null));
    assert.equal(st.forecastMemory.heldBytes, 0, 'every window released');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
