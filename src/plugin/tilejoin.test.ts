import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BBox } from '../geo/geodesy';

/** A varying wind / pressure field over 38–46 °N, 76–64 °W (1° grid). */
async function fixture() {
  const { ForecastStore } = await import('../data/forecast');
  const nLat = 9;
  const nLon = 13;
  const mk = (f: (i: number, j: number) => number) => {
    const values = new Float32Array(nLat * nLon);
    for (let j = 0; j < nLat; j++) for (let i = 0; i < nLon; i++) values[j * nLon + i] = f(i, j);
    return { lat0: 38, lon0: -76, dLat: 1, dLon: 1, nLat, nLon, values };
  };
  const t0 = Date.UTC(2026, 8, 27);
  const steps = [0, 3].map(h => ({
    validMs: t0 + h * 3600_000,
    stepHours: h,
    fields: new Map([
      ['10u', mk((i, j) => 3 + i * 0.7 - j * 0.3 + h)],
      ['10v', mk((i, j) => -2 + j * 0.5 + i * 0.1)],
      ['msl', mk((i, j) => 100_800 + i * 40 - j * 25 + (i - 6) ** 2 * 10)],
    ]),
  }));
  const store = new ForecastStore(steps, {
    cycleTime: new Date(t0),
    bbox: { west: -76, south: 38, east: -64, north: 46 },
    steps: [0, 3],
    params: ['10u', '10v', 'msl'],
    loadedAt: new Date(),
  });
  const overlays = await import('./overlays');
  const tiles = await import('./tiles');
  const src = { forecast: store, currents: null, land: null };
  // What the tile endpoint would answer, computed directly.
  const get = async (t: import('./tiles').TileId): Promise<unknown> => {
    const { kind, args } = tiles.tileQuery(t);
    const time = new Date(t.hourMs);
    if (kind === 'field') {
      const a = args as { layer: 'wind'; bbox: BBox; res: number };
      return overlays.fieldGrid(src, a.layer, a.bbox, time, a.res);
    }
    if (kind === 'wind_points') {
      const a = args as { bbox: BBox; res: number };
      return tiles.trimPoints(overlays.windPoints(src, a.bbox, time, a.res), t.z, t.x, t.y);
    }
    throw new Error(`no fixture for ${kind}`);
  };
  return { src, get, overlays, hour: t0 + 3600_000 };
}

test('a joined value grid equals the grid computed for the box directly', async () => {
  const { src, get, overlays, hour } = await fixture();
  const { joinField } = await import('./tilejoin');
  // Several tiles, not aligned with tile edges.
  const bbox = { west: -72.3, south: 40.1, east: -68.7, north: 42.9 };
  const joined = await joinField(get, 'wind', bbox, hour, 0.05);
  const direct = overlays.fieldGrid(src, 'wind', bbox, new Date(hour), joined.res);
  assert.deepEqual(joined.lons, direct.lons);
  assert.deepEqual(joined.lats, direct.lats);
  assert.deepEqual(joined.fields, direct.fields);
  assert.ok(joined.res / 0.05 <= Math.SQRT2 + 1e-9 && 0.05 / joined.res <= Math.SQRT2 + 1e-9, `res ${joined.res}`);
});

test('joined wind barbs: every point of the box once, as computed directly', async () => {
  const { src, get, overlays, hour } = await fixture();
  const { joinPoints, zoomFor, tileSpacing } = await import('./tilejoin');
  const bbox = { west: -73, south: 39.5, east: -67, north: 44.5 };
  const joined = await joinPoints<{ lon: number; lat: number; speed_ms: number }>(get, 'barbs', bbox, hour, 0.4);
  const r = tileSpacing('barbs', zoomFor('barbs', bbox, 0.4, 20_000));
  const direct = overlays.windPoints(src, bbox, new Date(hour), r);
  const key = (p: { lon: number; lat: number }) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`;
  assert.equal(joined.length, direct.length);
  assert.deepEqual(new Set(joined.map(key)), new Set(direct.map(key)));
});

test('joined isobars: contours from the pressure tiles', async () => {
  const { get, hour } = await fixture();
  const { joinPressure } = await import('./tilejoin');
  const fc = await joinPressure(get as never, { west: -74, south: 39, east: -66, north: 45 }, hour, 1);
  assert.ok(fc.features.some(f => f.properties.kind === 'isobar'));
});

test('tiles covering a box across the date line', async () => {
  const { tilesCovering } = await import('./tilejoin');
  const t = tilesCovering({ west: 170, south: -10, east: 190, north: 10 }, 3);
  assert.ok(t.some(x => x.x === 7) && t.some(x => x.x === 0));
  assert.ok(t.every(x => x.x >= 0 && x.x < 8));
});

test('isobars read the pressure tiles at PRESSURE_TILE_ZOOM for a typical view', async () => {
  const { zoomFor, PRESSURE_TILE_RES, PRESSURE_TILE_ZOOM } = await import('./tilejoin');
  assert.equal(zoomFor('field', { west: -80, south: 30, east: -60, north: 45 }, PRESSURE_TILE_RES, 400_000), PRESSURE_TILE_ZOOM);
});
