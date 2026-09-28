import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForecastStore, type FieldGrid } from '../data/forecast';
import type { OverlayLand } from '../geo/landcache';
import { conditionsTilePoints, globalGridLonLats, sampleConditions, tileLatLonBounds, type OverlaySources } from './overlays';
import { parseHourT } from './api';

// Reference grids from the routing server's routing/routers/_tile.py
// (tile_latlon_bounds + global_grid_lonlats at res = max(0.02, 0.8/2^(z-6))),
// lon/lat rounded to 5 decimals as build_tile_points does.
const PY_TILES: Record<string, { bounds: number[]; lons: number[]; lats: number[] }> = {
  '5/9/11': { bounds: [-78.75, 40.97989806962013, -67.5, 48.92249926375824], lons: [-78.4, -76.8, -75.2, -73.6, -72.0, -70.4, -68.8], lats: [41.6, 43.2, 44.8, 46.4, 48.0] },
  '8/77/94': { bounds: [-71.71875, 42.03297433244139, -70.3125, 43.06888777416962], lons: [-71.6, -71.4, -71.2, -71.0, -70.8, -70.6, -70.4], lats: [42.2, 42.4, 42.6, 42.8, 43.0] },
  '11/619/758': { bounds: [-71.19140625, 42.163403424224, -71.015625, 42.29356419217008], lons: [-71.175, -71.15, -71.125, -71.1, -71.075, -71.05, -71.025], lats: [42.175, 42.2, 42.225, 42.25, 42.275] },
};

function store(): ForecastStore {
  const c = (v: number): FieldGrid => ({ lat0: 30, lon0: -90, dLat: 1, dLon: 1, nLat: 30, nLon: 40, values: new Float32Array(30 * 40).fill(v) });
  const t0 = Date.UTC(2026, 0, 1, 0);
  const steps = [0, 3].map((h) => ({ validMs: t0 + h * 3600_000, stepHours: h, fields: new Map([['10u', c(3)], ['10v', c(-4)], ['msl', c(101500)]]) }));
  return new ForecastStore(steps, { cycleTime: new Date(t0), bbox: { west: -90, south: 30, east: -51, north: 59 }, steps: [0, 3], params: ['10u', '10v', 'msl'], loadedAt: new Date() });
}

test('tile bounds and sample grid match the routing server', () => {
  for (const [k, ref] of Object.entries(PY_TILES)) {
    const [z, x, y] = k.split('/').map(Number);
    const b = tileLatLonBounds(z, x, y);
    for (let i = 0; i < 4; i++) assert.ok(Math.abs(b[i] - ref.bounds[i]) < 1e-12, `${k} bound ${i}`);
    const g = globalGridLonLats(b[0], b[1], b[2], b[3], Math.max(0.02, 0.8 / 2 ** (z - 6)));
    assert.deepEqual(g.lons.map((v) => Math.round(v * 1e5) / 1e5), ref.lons, k);
    assert.deepEqual(g.lats.map((v) => Math.round(v * 1e5) / 1e5), ref.lats, k);
  }
});

test('conditionsTilePoints: one point per sample, ConditionsRow names, land dropped, empty below z5', () => {
  const t = new Date(Date.UTC(2026, 0, 1, 1));
  const lookup = { isLand: (lon: number, _lat: number) => lon < -71.0 };
  const land: OverlayLand = { forBBox: () => lookup, isLandAt: lookup.isLand };
  const src: OverlaySources = { forecast: store(), currents: null, land };
  const pts = conditionsTilePoints(src, 8, 77, 94, t);
  // 7 lons x 5 lats, minus the lons west of -71.0 (-71.6, -71.4, -71.2) -> 4 x 5.
  assert.equal(pts.length, 20);
  assert.deepEqual([...new Set(pts.map((p) => p.lon))], [-71.0, -70.8, -70.6, -70.4]);
  assert.deepEqual([...new Set(pts.map((p) => p.lat))], [42.2, 42.4, 42.6, 42.8, 43.0]);
  const p = pts[0];
  assert.equal(p.wind_ms, 5);
  assert.equal(p.msl_pa, 101500);
  assert.ok('rh' in p && 'precip_rate_ms' in p && !('rh_pct' in p) && !('tprate_kg_m2_s' in p) && !('time' in p));
  const { time: _t, ...row } = sampleConditions(src, p.lon, p.lat, t);
  assert.deepEqual({ ...p, lon: undefined, lat: undefined }, { ...row, lon: undefined, lat: undefined });
  assert.deepEqual(conditionsTilePoints(src, 4, 4, 5, t), []);
  assert.throws(() => conditionsTilePoints(src, 8, 256, 94, t), /out of range/);
  assert.throws(() => conditionsTilePoints({ forecast: null, currents: null, land: null }, 8, 77, 94, t), /no forecast data loaded/);
});

test('parseHourT follows round_t_to_hour', () => {
  assert.equal(parseHourT('2026-01-01T05').toISOString(), '2026-01-01T05:00:00.000Z');
  assert.equal(parseHourT('2026-01-01T05:00:00Z').toISOString(), '2026-01-01T05:00:00.000Z');
  assert.throws(() => parseHourT('2026-01-01T05:30'), /minute=30/);
  assert.throws(() => parseHourT('2026-01-01T05:00:07Z'), /second=07/);
  assert.throws(() => parseHourT(''), /t is required/);
  assert.throws(() => parseHourT('2026-13-01T05'), /Bad t/);
});

test('forecast-derived layers report no data outside a cropped (non-global) store', async () => {
  const { ForecastStore } = await import('../data/forecast');
  const mk = (v: number) => ({ lat0: 40, lon0: -70, dLat: 1, dLon: 1, nLat: 3, nLon: 3, values: new Float32Array(9).fill(v) });
  const steps = [0, 3].map((h) => ({
    validMs: Date.UTC(2026, 8, 27) + h * 3600_000, stepHours: h,
    fields: new Map([['10u', mk(5)], ['10v', mk(0)], ['msl', mk(101000)]]),
  }));
  const store = new ForecastStore(steps, { cycleTime: new Date(Date.UTC(2026, 8, 27)), bbox: { west: -70, south: 40, east: -68, north: 42 }, steps: [0, 3], params: ['10u', '10v', 'msl'], loadedAt: new Date() });
  const { fieldGrid, windPoints, sampleConditions } = await import('./overlays');
  const src = { forecast: store, currents: null, land: null };
  const t = new Date(Date.UTC(2026, 8, 27, 1));
  const g = fieldGrid(src, 'wind', { west: -72, south: 39, east: -66, north: 43 }, t, 1);
  const col = (lon: number) => g.lons.indexOf(lon);
  const row = (lat: number) => g.lats.indexOf(lat);
  const speed = Object.values(g.fields)[0];
  assert.ok(speed[row(41)][col(-69)] !== null, 'inside has data');
  assert.equal(speed[row(41)][col(-66)], null, 'east of region');
  assert.equal(speed[row(39)][col(-69)], null, 'south of region');
  assert.equal(speed[row(43)][col(-72)], null, 'corner');
  const pts = windPoints(src, { west: -72, south: 39, east: -66, north: 43 }, t, 1);
  assert.ok(pts.length > 0 && pts.every((p) => p.lon >= -70 && p.lon <= -68 && p.lat >= 40 && p.lat <= 42));
  assert.equal(sampleConditions(src, -60, 41, t).wind_ms, null);
  assert.ok(sampleConditions(src, -69, 41, t).wind_ms !== null);
});

test('precip layer keeps small m/s rates (1 mm/h ≈ 2.78e-7 m/s) instead of rounding them to 0', async () => {
  const { ForecastStore } = await import('../data/forecast');
  const { fieldGrid } = await import('./overlays');
  const mk = (v: number) => ({ lat0: 40, lon0: -70, dLat: 1, dLon: 1, nLat: 3, nLon: 3, values: new Float32Array(9).fill(v) });
  const rate = 1 / 3600 / 1000; // 1 mm/h in m/s
  const steps = [0, 3].map((h) => ({ validMs: Date.UTC(2026, 8, 27) + h * 3600_000, stepHours: h, fields: new Map([['10u', mk(1)], ['10v', mk(0)], ['tprate', mk(rate)]]) }));
  const store = new ForecastStore(steps, { cycleTime: new Date(Date.UTC(2026, 8, 27)), bbox: { west: -70, south: 40, east: -68, north: 42 }, steps: [0, 3], params: ['10u', '10v', 'tprate'], loadedAt: new Date() });
  const g = fieldGrid({ forecast: store, currents: null, land: null }, 'precip', { west: -70, south: 40, east: -68, north: 42 }, new Date(Date.UTC(2026, 8, 27, 1)), 1);
  const v = g.fields.rate[1][1]!;
  assert.ok(Math.abs(v - Math.fround(rate)) / rate < 1e-4, `got ${v}`);
});
