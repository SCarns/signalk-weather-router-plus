import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePng } from './png';
import type { FieldGridResponse } from './overlays';
import { PngCache, rampLut, renderFieldPng, sampleGrid } from './pngtiles';
import { WIND_STOPS } from './legends';
import { tileBBox } from './tiles';

const Z = 2;
const X = 1;
const Y = 1;
const PX = 256;

/** A field lattice over the tile, one cell of padding, like the data worker builds. */
function grid(fill: (lon: number, lat: number) => number | null, extra: Partial<FieldGridResponse> = {}): FieldGridResponse {
  const b = tileBBox(Z, X, Y);
  const res = (b.east - b.west) / 64;
  const lons: number[] = [];
  for (let v = b.west - res; v <= b.east + res + 1e-9; v += res) lons.push(v);
  const lats: number[] = [];
  for (let v = Math.max(-90, b.south - res); v <= Math.min(90, b.north + res) + 1e-9; v += res) lats.push(v);
  const speed = lats.map(lat => lons.map(lon => fill(lon, lat)));
  return {
    layer: 'wind',
    time: '2026-09-30T12:00:00.000Z',
    bbox: [lons[0], lats[0], lons[lons.length - 1], lats[lats.length - 1]],
    res,
    lons,
    lats,
    fields: { speed_ms: speed },
    land: lats.map(() => lons.map(() => 0)),
    units: { speed_ms: 'm/s' },
    ...extra,
  };
}

const px = (rgba: Uint8Array, x: number, y: number): number[] => [...rgba.subarray((y * PX + x) * 4, (y * PX + x) * 4 + 4)];

test('png tiles: a uniform field paints every pixel the legend colour at alpha 0.55', () => {
  const g = grid(() => 10 * 0.514444);
  const { width, height, rgba } = decodePng(renderFieldPng('wind', Z, X, Y, g, null));
  assert.equal(width, PX);
  assert.equal(height, PX);
  const lut = rampLut(WIND_STOPS);
  const v0 = WIND_STOPS[0][0];
  const v1 = WIND_STOPS[WIND_STOPS.length - 1][0];
  const idx = Math.round(((10 * 0.514444 - v0) / (v1 - v0)) * 255);
  const want = [lut[idx * 3], lut[idx * 3 + 1], lut[idx * 3 + 2], Math.round(0.55 * 255)];
  assert.deepEqual(px(rgba, 0, 0), want);
  assert.deepEqual(px(rgba, 128, 128), want);
  assert.deepEqual(px(rgba, 255, 255), want);
});

test('png tiles: no data is transparent; a land mask blanks land; hatch marks no-data water', () => {
  const empty = grid(() => null);
  const t = decodePng(renderFieldPng('wind', Z, X, Y, empty, null));
  assert.ok(
    t.rgba.every(b => b === 0),
    'all transparent'
  );

  // Top half land, bottom half water with a value: waves masks land.
  const mask = new Uint8Array(PX * PX);
  mask.fill(1, 0, (PX / 2) * PX);
  const waves = grid(() => 2, { layer: 'waves', fields: { swh: grid(() => 2).fields.speed_ms } });
  const w = decodePng(renderFieldPng('waves', Z, X, Y, waves, mask));
  assert.equal(px(w.rgba, 10, 10)[3], 0, 'land pixel transparent');
  assert.equal(px(w.rgba, 10, 200)[3], Math.round(0.55 * 255), 'water pixel painted');

  // Current with no model data and a mask: the hatch pattern, nothing else.
  const cur = grid(() => null, { layer: 'current', fields: { speed_ms: empty.fields.speed_ms } });
  const c = decodePng(renderFieldPng('current', Z, X, Y, cur, new Uint8Array(PX * PX)));
  const gx0 = X * PX;
  const gy0 = Y * PX;
  let hatched = 0;
  for (let y = 0; y < PX; y++)
    for (let x = 0; x < PX; x++) {
      const p = px(c.rgba, x, y);
      if ((gx0 + x + gy0 + y) % 7 < 1) {
        assert.deepEqual(p, [96, 96, 96, 150]);
        hatched++;
      } else assert.equal(p[3], 0);
    }
  assert.ok(hatched > 9000, `${hatched} hatched pixels`);
});

test('png tiles: the sampler is bilinear and null-aware', () => {
  const g = grid((_lon, lat) => (lat > 0 ? 1 : 0));
  // Mid-way between the two rows straddling lat 0: half-way.
  const j = g.lats.findIndex(l => l > 0);
  const mid = (g.lats[j - 1] + g.lats[j]) / 2;
  const v = sampleGrid(g, g.fields.speed_ms, g.lons[3], mid);
  assert.ok(v !== null && Math.abs(v - 0.5) < 1e-9, `got ${v}`);
  // Outside by more than half a cell: null.
  assert.equal(sampleGrid(g, g.fields.speed_ms, g.lons[0] - g.res, g.lats[0]), null);
  // One null corner renormalises; three null corners give null.
  const h = grid(() => 4);
  h.fields.speed_ms[j][3] = null;
  assert.equal(sampleGrid(h, h.fields.speed_ms, g.lons[3], mid), 4);
  h.fields.speed_ms[j - 1][3] = null;
  h.fields.speed_ms[j][4] = null;
  assert.equal(sampleGrid(h, h.fields.speed_ms, (g.lons[3] + g.lons[4]) / 2, mid), null);
});

test('png cache: bounded by bytes, least recently used evicted first', () => {
  const c = new PngCache(25);
  c.set('a', Buffer.alloc(10));
  c.set('b', Buffer.alloc(10));
  assert.ok(c.get('a'));
  c.set('c', Buffer.alloc(10)); // 30 > 25: evicts b (a was just used)
  assert.equal(c.get('b'), undefined);
  assert.ok(c.get('a') && c.get('c'));
  assert.equal(c.size, 2);
});

test('sampleGrid reads a grid wider than 180° all the way to its eastern edge (zoom 0 and 1 tiles)', () => {
  // A global lattice from -180 east in 10° steps: 36 columns, one row.
  const res = 10;
  const lons = Array.from({ length: 36 }, (_, i) => -180 + i * res);
  const values = [lons.map((_, i) => i)];
  const g = { lons, lats: [0], res };
  assert.equal(sampleGrid(g, values, -180, 0), 0);
  assert.equal(sampleGrid(g, values, 0, 0), 18);
  assert.equal(sampleGrid(g, values, 100, 0), 28, 'an offset over 180° east is still inside the grid');
  assert.equal(sampleGrid(g, values, 170, 0), 35, 'the last column');
  // On a global grid, 10° west of the first column is the last column.
  assert.equal(sampleGrid(g, values, -180 - res, 0), 35);
  // On a partial grid, a point just west of the first column reads as a small
  // negative offset and still samples that column (as the web app does); one
  // further west is outside.
  const part = { lons: Array.from({ length: 20 }, (_, i) => i * res), lats: [0], res };
  const pv = [part.lons.map((_, i) => 100 + i)];
  assert.equal(sampleGrid(part, pv, -3, 0), 100);
  assert.equal(sampleGrid(part, pv, -8, 0), null);
  assert.equal(sampleGrid(part, pv, 190, 0), 119);
});
