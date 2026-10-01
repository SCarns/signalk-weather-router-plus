import { test } from 'node:test';
import { HOUR_S } from '../geo/units';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  alignedSteps,
  AREA_MARGIN_CELLS,
  chooseLayout,
  isSettled,
  loadArea,
  parseStac,
  regionContains,
  regionForBBox,
  residentStale,
  SmocClient,
  SmocCurrentSource,
  timeIndex,
  SMOC_PRIORITY,
  type SmocRun,
  type SmocSettings,
} from './smoc';
import { CurrentStack } from './stack';
import { FILL_RADIUS_CELLS, filledCell, sampleFieldPairFilled } from './coastfill';
import { RtofsCurrentSource } from './rtofs';
import type { CurrentSourceLike } from './types';
import { decodeChunk, parseArrayMeta, parseCfTimeUnits, parseConsolidated } from '../data/zarr';
import { sampleField, type FieldGrid } from '../data/forecast';

// ───────────── synthetic Zarr v2 store (uncompressed chunks) ─────────────
//
// Global 1° grid (80°S..90°N × 180°W..179°E), 200 hourly steps from
// 2026-09-20T00Z, the SMOC variable layout (time, elevation, latitude,
// longitude). Three layouts like the real product: `time` (1 h × 64 × 128
// cells, partial edge chunks), `geo` (48 h × 16 × 8) and `ds4` (2° grid).
// Land (fill value) on 40..45°N × 10..20°E; the rows south of 65°S are
// fill in `time` and absent chunks (HTTP 403) in `geo`.

const FILL = 9.969209968386869e36;
const T0 = Date.UTC(2026, 8, 20, 0);
const NT = 200;
const H = 3600_000;
const HOURS_1950 = (T0 - Date.UTC(1950, 0, 1)) / H;

function uTrue(lat: number, lon: number, ti: number): number {
  return 0.5 * Math.sin((2 * Math.PI * lon) / 360) + 0.01 * lat + 0.001 * ti;
}
function vTrue(lat: number, lon: number, ti: number): number {
  return 0.3 * Math.cos((2 * Math.PI * lon) / 360) - 0.005 * lat - 0.002 * ti;
}
function isLand(lat: number, lon: number): boolean {
  return (lat >= 40 && lat <= 45 && lon >= 10 && lon <= 20) || lat < -64.5;
}

interface MockLayout {
  d: number;
  chunks: [number, number, number, number];
}
const LAYOUTS: Record<string, MockLayout> = {
  time: { d: 1, chunks: [1, 1, 64, 128] },
  geo: { d: 1, chunks: [48, 1, 16, 8] },
  ds4: { d: 2, chunks: [1, 1, 86, 180] },
};

function f4(vals: ArrayLike<number>): Uint8Array {
  return new Uint8Array(new Float32Array(Array.from(vals)).buffer);
}

function layoutMeta(name: string): { nLat: number; nLon: number; zmeta: unknown } {
  const L = LAYOUTS[name];
  const nLat = Math.round(170 / L.d) + 1;
  const nLon = Math.round(360 / L.d);
  const comp = null;
  const arr = (shape: number[], chunks: number[], fill: unknown) => ({
    chunks,
    compressor: comp,
    dtype: '<f4',
    fill_value: fill,
    filters: null,
    order: 'C',
    shape,
    zarr_format: 2,
  });
  const md: Record<string, unknown> = {
    '.zattrs': { credit: 'E.U. Copernicus Marine Service Information (CMEMS)' },
    'latitude/.zarray': arr([nLat], [nLat], 'NaN'),
    'latitude/.zattrs': { _ARRAY_DIMENSIONS: ['latitude'] },
    'longitude/.zarray': arr([nLon], [nLon], 'NaN'),
    'longitude/.zattrs': { _ARRAY_DIMENSIONS: ['longitude'] },
    'time/.zarray': arr([NT], [64], 'NaN'),
    'time/.zattrs': { _ARRAY_DIMENSIONS: ['time'], calendar: 'gregorian', units: 'hours since 1950-01-01' },
    'elevation/.zarray': arr([1], [1], 'NaN'),
    'elevation/.zattrs': { _ARRAY_DIMENSIONS: ['elevation'] },
  };
  for (const v of ['utotal', 'vtotal', 'uo', 'vo']) {
    md[`${v}/.zarray`] = arr([NT, 1, nLat, nLon], L.chunks, FILL);
    md[`${v}/.zattrs`] = { _ARRAY_DIMENSIONS: ['time', 'elevation', 'latitude', 'longitude'], units: 'm s-1' };
  }
  return { nLat, nLon, zmeta: { metadata: md, zarr_consolidated_format: 1 } };
}

interface Mock {
  fetch: typeof fetch;
  counts: Map<string, number>;
  total: () => number;
  stacUpdating: boolean;
  stacUpdated: string;
}

function makeMock(): Mock {
  const counts = new Map<string, number>();
  const mock: Mock = {
    counts,
    total: () => [...counts.values()].reduce((a, b) => a + b, 0),
    stacUpdating: false,
    stacUpdated: '2026-09-28T10:42:54Z',
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      counts.set(url, (counts.get(url) ?? 0) + 1);
      const headers = { 'last-modified': 'Mon, 28 Sep 2026 08:16:14 GMT', etag: '"abc"' };
      if (url.endsWith('dataset.stac.json')) {
        return new Response(
          JSON.stringify({
            properties: {
              admp_updated_data: mock.stacUpdated,
              admp_updating_start_date: mock.stacUpdating ? '2026-09-28T08:00:00Z' : null,
            },
          }),
          { status: 200 }
        );
      }
      const m = /\/(time|geo|ds4)\.zarr\/(.+)$/.exec(url);
      if (!m) return new Response('no', { status: 404 });
      const layout = m[1];
      const key = m[2];
      const L = LAYOUTS[layout];
      const { nLat, nLon, zmeta } = layoutMeta(layout);
      if (key === '.zmetadata') return new Response(JSON.stringify(zmeta), { status: 200, headers });
      if (key === 'latitude/0') return new Response(f4(Array.from({ length: nLat }, (_, i) => -80 + i * L.d)), { status: 200 });
      if (key === 'longitude/0') return new Response(f4(Array.from({ length: nLon }, (_, i) => -180 + i * L.d)), { status: 200 });
      const tm = /^time\/(\d+)$/.exec(key);
      if (tm) {
        const c = +tm[1];
        return new Response(f4(Array.from({ length: 64 }, (_, i) => (c * 64 + i < NT ? HOURS_1950 + c * 64 + i : NaN))), { status: 200 });
      }
      const dm = /^(utotal|vtotal)\/(\d+)\.0\.(\d+)\.(\d+)$/.exec(key);
      if (!dm) return new Response('no', { status: 404 });
      const [ct, , cr, cc] = L.chunks;
      const [tc, rc, ccI] = [+dm[2], +dm[3], +dm[4]];
      if (layout === 'geo' && rc === 0) return new Response('denied', { status: 403 });
      const out = new Float32Array(ct * cr * cc).fill(FILL);
      for (let t = 0; t < ct; t++) {
        const ti = tc * ct + t;
        if (ti >= NT) continue;
        for (let r = 0; r < cr; r++) {
          const gr = rc * cr + r;
          if (gr >= nLat) continue;
          const lat = -80 + gr * L.d;
          for (let c = 0; c < cc; c++) {
            const gc = ccI * cc + c;
            if (gc >= nLon) continue;
            const lon = -180 + gc * L.d;
            if (isLand(lat, lon)) continue;
            out[(t * cr + r) * cc + c] = dm[1] === 'utotal' ? uTrue(lat, lon, ti) : vTrue(lat, lon, ti);
          }
        }
      }
      return new Response(new Uint8Array(out.buffer), { status: 200 });
    }) as typeof fetch,
  };
  return mock;
}

const URLS = {
  time: 'https://mock/time.zarr',
  geo: 'https://mock/geo.zarr',
  ds4: 'https://mock/ds4.zarr',
  stac: 'https://mock/dataset.stac.json',
};
const SETTINGS: SmocSettings = { stepS: 3 * HOUR_S, horizonS: 24 * HOUR_S, halfWidthDeg: 10, budgetBytes: 64 * 1024 * 1024 };

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-smoc-'));
}

async function setup(): Promise<{ mock: Mock; client: SmocClient; run: SmocRun; dir: string }> {
  const mock = makeMock();
  const dir = tmpDir();
  const client = new SmocClient({ cacheDir: dir, urls: URLS, fetchImpl: mock.fetch, sleepImpl: async () => undefined });
  const run = await client.probe();
  return { mock, client, run, dir };
}

/** Grid value as stored (float32), NaN on land. */
function node(lat: number, lon: number, ti: number): [number, number] {
  if (isLand(lat, lon)) return [NaN, NaN];
  return [Math.fround(uTrue(lat, lon, ti)), Math.fround(vTrue(lat, lon, ti))];
}

/** Direct bilinear on the stored 1° grid (longitude wrapping). */
function directBilinear(lat: number, lon: number, ti: number): [number, number] {
  const x = (((lon + 180) % 360) + 360) % 360;
  const y = lat + 80;
  const c = Math.floor(x);
  const r = Math.floor(y);
  const tx = x - c;
  const ty = y - r;
  const L = (cc: number): number => -180 + (cc % 360);
  const a = node(-80 + r, L(c), ti);
  const b = node(-80 + r, L(c + 1), ti);
  const cN = node(-80 + r + 1, L(c), ti);
  const d = node(-80 + r + 1, L(c + 1), ti);
  const ua = a[0] + tx * (b[0] - a[0]);
  const ub = cN[0] + tx * (d[0] - cN[0]);
  const va = a[1] + tx * (b[1] - a[1]);
  const vb = cN[1] + tx * (d[1] - cN[1]);
  return [ua + ty * (ub - ua), va + ty * (vb - va)];
}

// ───────────── zarr ─────────────

test('zarr: real SMOC .zmetadata parses (shapes, chunks, fill, dims, CF time units)', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'test-data', 'smoc', 'timeChunked.zmetadata'), 'utf8'));
  const { arrays, attrs } = parseConsolidated(doc);
  const u = arrays.get('utotal')!;
  assert.deepEqual(u.chunks, [1, 1, 512, 2048]);
  assert.equal(u.shape.length, 4);
  assert.equal(u.shape[2], 2041);
  assert.equal(u.shape[3], 4320);
  assert.equal(u.dtype, '<f4');
  assert.equal(u.fillValue, 9.969209968386869e36);
  assert.equal(u.compressor?.id, 'blosc');
  assert.deepEqual(u.attrs._ARRAY_DIMENSIONS, ['time', 'elevation', 'latitude', 'longitude']);
  const t = arrays.get('time')!;
  assert.ok(Number.isNaN(t.fillValue));
  assert.equal(t.attrs.units, 'hours since 1950-01-01');
  const cf = parseCfTimeUnits(String(t.attrs.units), String(t.attrs.calendar));
  assert.equal(cf.unitMs, 3600_000);
  assert.equal(cf.epochMs, Date.UTC(1950, 0, 1));
  // 620928 h since 1950 = 2020-11-01T00Z (the product start).
  assert.equal(new Date(cf.epochMs + 620928 * cf.unitMs).toISOString(), '2020-11-01T00:00:00.000Z');
  assert.match(String(attrs.credit), /Copernicus Marine/);
  assert.equal(parseCfTimeUnits('seconds since 1970-01-01 00:00:00').epochMs, 0);
  assert.equal(parseCfTimeUnits('days since 2000-01-01T12:00:00Z').epochMs, Date.UTC(2000, 0, 1, 12));
  assert.throws(() => parseCfTimeUnits('hours since 1950-01-01', 'noleap'), /calendar/);
  assert.throws(
    () => parseArrayMeta({ zarr_format: 2, shape: [2], chunks: [2], dtype: '<f4', compressor: { id: 'zstd' }, fill_value: 0 }),
    /zstd/
  );
  assert.throws(() => parseArrayMeta({ zarr_format: 3, shape: [2], chunks: [2], dtype: '<f4', fill_value: 0 }), /zarr_format/);
});

test('zarr: a real blosc chunk decodes to float32 with the fill value mapped to NaN', () => {
  const dir = path.join(__dirname, '..', '..', 'test-data', 'blosc');
  const ref = JSON.parse(fs.readFileSync(path.join(dir, 'smoc_utotal_51780.0.3.2.ref.json'), 'utf8')) as {
    fill_count: number;
    samples: [number, number, number][];
  };
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'test-data', 'smoc', 'timeChunked.zmetadata'), 'utf8'));
  const meta = parseConsolidated(doc).arrays.get('utotal')!;
  const vals = decodeChunk(meta, new Uint8Array(fs.readFileSync(path.join(dir, 'smoc_utotal_51780.0.3.2.blosc'))));
  assert.ok(vals instanceof Float32Array);
  let nan = 0;
  for (let i = 0; i < vals.length; i++) if (Number.isNaN(vals[i])) nan++;
  assert.equal(nan, ref.fill_count);
  for (const [r, c, v] of ref.samples) {
    if (v > 1e30) assert.ok(Number.isNaN(vals[r * 2048 + c]));
    else assert.equal(vals[r * 2048 + c], Math.fround(v));
  }
  // An absent chunk is all fill.
  const empty = decodeChunk(meta, null);
  assert.ok(Number.isNaN(empty[0]) && Number.isNaN(empty[empty.length - 1]));
});

// ───────────── probe / run / time ─────────────

test('smoc: probe derives the grid, time axis and run from the store', async () => {
  const { run, mock, client } = await setup();
  assert.equal(run.timeCount, NT);
  assert.equal(run.timeFirstMs, T0);
  assert.equal(run.timeStepMs, H);
  assert.equal(run.key, new Date(T0 + (NT - 1) * H).toISOString().slice(0, 13).replace(/[-T]/g, ''));
  const g = run.levels.time.grid;
  assert.deepEqual([g.nLat, g.nLon, g.lat0, g.lon0, g.wrap], [171, 360, -80, -180, true]);
  assert.ok(Math.abs(g.dLon - 1) < 1e-12 && Math.abs(g.dLat - 1) < 1e-12);
  assert.ok(run.levels.geo && run.levels.ds4);
  assert.equal(run.levels.ds4!.grid.nLon, 180);
  assert.equal(run.settled, true);
  assert.equal(timeIndex(run, T0 + 5 * H), 5);
  assert.equal(timeIndex(run, T0 + 5.5 * H), -1);
  assert.equal(timeIndex(run, T0 + NT * H), -1);
  // Same ETag: the coordinates are not read again.
  const before = mock.total();
  const again = await client.probe(run);
  assert.equal(again.key, run.key);
  assert.equal(mock.total() - before, 2, 'only .zmetadata and STAC');
  // An update in progress is reported as unsettled.
  mock.stacUpdating = true;
  assert.equal((await client.probe(run)).settled, false);
});

test('smoc: settledness from STAC and aligned steps', async () => {
  assert.equal(isSettled(null, 0), true);
  assert.equal(
    isSettled(
      parseStac({ properties: { admp_updated_data: '2026-09-28T10:42:54Z', admp_updating_start_date: null } }),
      Date.parse('2026-09-28T08:16:14Z')
    ),
    true
  );
  assert.equal(
    isSettled(parseStac({ properties: { admp_updated_data: '2026-09-27T10:42:54Z' } }), Date.parse('2026-09-28T08:16:14Z')),
    false
  );
  assert.equal(
    isSettled(
      parseStac({ properties: { admp_updated_data: '2026-09-28T10:42:54Z', admp_updating_start_date: '2026-09-28T11:00:00Z' } }),
      null
    ),
    false
  );
  const { run } = await setup();
  // Aligned to whole multiples of the step: first at or before, last at or after.
  const s3 = alignedSteps(run, T0 + 4 * H + 1000, T0 + 10 * H, 3);
  assert.deepEqual(
    s3.map(t => (t - T0) / H),
    [3, 6, 9, 12]
  );
  assert.deepEqual(
    alignedSteps(run, T0 + 4 * H, T0 + 6 * H, 1).map(t => (t - T0) / H),
    [4, 5, 6]
  );
  // Only instants on the store time axis.
  assert.deepEqual(
    alignedSteps(run, T0 + (NT - 2) * H, T0 + (NT + 10) * H, 3).map(t => (t - T0) / H),
    [198]
  );
});

// ───────────── area loading and sampling ─────────────

test('smoc: time- and geo-chunked loads give identical areas equal to the stored values', async () => {
  const { client, run } = await setup();
  const steps = [T0 + 3 * H, T0 + 6 * H];
  const region = regionForBBox(run.levels.time.grid, { west: 5, east: 25, south: 30, north: 50 }, AREA_MARGIN_CELLS)!;
  const a = (await loadArea(client, run, 'full', region, steps, { reason: 't', layout: 'time' })).area;
  const b = (await loadArea(client, run, 'full', region, steps, { reason: 'g', layout: 'geo' })).area;
  assert.equal(a.u.length, b.u.length);
  for (let i = 0; i < a.u.length; i++) {
    assert.ok(Object.is(a.u[i], b.u[i]) && Object.is(a.v[i], b.v[i]), `cell ${i}`);
  }
  for (let s = 0; s < steps.length; s++) {
    const ti = (steps[s] - T0) / H;
    for (let r = 0; r < a.nRows; r++) {
      for (let c = 0; c < a.nCols; c++) {
        const lat = -80 + a.row0 + r;
        const lon = -180 + ((a.col0 + c) % 360);
        const [u, v] = node(lat, lon, ti);
        const i = s * a.nRows * a.nCols + r * a.nCols + c;
        assert.ok(Object.is(a.u[i], u) || (Number.isNaN(u) && Number.isNaN(a.u[i])));
        assert.ok(Object.is(a.v[i], v) || (Number.isNaN(v) && Number.isNaN(a.v[i])));
      }
    }
  }
  assert.ok(a.u.buffer instanceof SharedArrayBuffer);
  // The layout choice follows the chunk volume: many steps over a small box → geo; one step over a wide box → time.
  const small = regionForBBox(run.levels.time.grid, { west: 0, east: 2, south: 0, north: 2 }, 3)!;
  assert.equal(
    chooseLayout(
      run,
      small,
      Array.from({ length: 40 }, (_, i) => i)
    ),
    'geo'
  );
  const wide = regionForBBox(run.levels.time.grid, { west: -100, east: 60, south: -40, north: 60 }, 3)!;
  assert.equal(chooseLayout(run, wide, [10]), 'time');
});

test('smoc: bilinear in space and linear in time match a direct decode; antimeridian; grace; no data', async () => {
  const { client, run } = await setup();
  const src = new SmocCurrentSource(run, SETTINGS, client);
  const steps = src.stepsBetween(T0 + 3 * H, T0 + 9 * H);
  assert.deepEqual(
    steps.map(t => (t - T0) / H),
    [3, 6, 9]
  );
  // Box across the antimeridian.
  assert.equal(await src.ensure({ west: 170, east: -170, south: -10, north: 10 }, steps, { reason: 'test' }), true);
  const pts: [number, number][] = [
    [179.3, 0.4],
    [-179.6, -3.25],
    [179.99, 5.5],
    [-180, 2],
    [175.25, -7.75],
    [-172.5, 8.1],
  ];
  for (const [lon, lat] of pts) {
    for (const hOff of [3, 4.5, 6, 7.25, 9]) {
      const t = T0 + hOff * H;
      const [u, v] = src.at(lon, lat, new Date(t));
      // Linear in time between the bracketing 3-hourly steps.
      const t0 = Math.floor(hOff / 3) * 3;
      const t1 = Math.min(9, t0 + 3);
      const w = t1 === t0 ? 0 : (hOff - t0) / 3;
      const a = directBilinear(lat, lon, t0);
      const b = directBilinear(lat, lon, t1);
      const eu = a[0] * (1 - w) + b[0] * w;
      const ev = a[1] * (1 - w) + b[1] * w;
      assert.ok(Math.abs(u - eu) < 1e-12 && Math.abs(v - ev) < 1e-12, `${lon},${lat} +${hOff}h: ${u},${v} vs ${eu},${ev}`);
    }
  }
  // ±1 h grace beyond the ends, then no data.
  assert.notDeepEqual(src.at(179.3, 0.4, new Date(T0 + 9.9 * H)), [0, 0]);
  assert.deepEqual(src.at(179.3, 0.4, new Date(T0 + 10.1 * H)), [0, 0]);
  assert.deepEqual(src.at(179.3, 0.4, new Date(T0 + 1.9 * H)), [0, 0]);
  // Outside every loaded area.
  assert.equal(src.contains(0, 0), false);
  assert.deepEqual(src.at(0, 0, new Date(T0 + 6 * H)), [0, 0]);
  // atMany agrees with at.
  const r = src.atMany(new Float64Array([179.3, 0]), new Float64Array([0.4, 0]), new Date(T0 + 4 * H));
  assert.deepEqual([r.u[0], r.v[0]], src.at(179.3, 0.4, new Date(T0 + 4 * H)));
  assert.deepEqual([r.u[1], r.v[1]], [0, 0]);
});

test('smoc: on-demand areas are cached (memory and disk), deduplicated, evicted by budget', async () => {
  const { client, run, mock, dir } = await setup();
  const src = new SmocCurrentSource(run, { ...SETTINGS, budgetBytes: 40 * 1024 }, client);
  const steps = src.bracketSteps(T0 + 7 * H);
  assert.deepEqual(
    steps.map(t => (t - T0) / H),
    [6, 9]
  );
  const n0 = mock.total();
  const [a, b] = await Promise.all([
    src.ensure({ west: -10, east: 0, south: 45, north: 55 }, steps, { reason: 'overlay' }),
    src.ensure({ west: -10, east: 0, south: 45, north: 55 }, steps, { reason: 'overlay' }),
  ]);
  assert.ok(a && b);
  const n1 = mock.total();
  assert.ok(n1 > n0);
  assert.equal(src.onDemandAreas.length, 1, 'concurrent identical requests load once');
  // Inside the loaded area: no fetch.
  assert.equal(await src.ensure({ west: -8, east: -2, south: 47, north: 53 }, [steps[0]], { reason: 'overlay' }), true);
  assert.equal(mock.total(), n1);
  // A second source on the same cache dir reads the chunks from disk.
  const src2 = new SmocCurrentSource(run, SETTINGS, new SmocClient({ cacheDir: dir, urls: URLS, fetchImpl: mock.fetch }));
  await src2.ensure({ west: -10, east: 0, south: 45, north: 55 }, steps, { reason: 'overlay' });
  assert.equal(mock.total(), n1, 'served from the disk cache');
  assert.deepEqual(src2.at(-5, 50, new Date(T0 + 7 * H)), src.at(-5, 50, new Date(T0 + 7 * H)));
  // Budget: loading more areas evicts the oldest.
  const rev = src.revision;
  for (let k = 0; k < 6; k++)
    await src.ensure({ west: 30 + 12 * k, east: 40 + 12 * k, south: -30, north: 30 }, steps, { reason: 'overlay' });
  assert.ok(src.onDemandBytes() <= 40 * 1024);
  assert.ok(src.revision > rev);
  assert.equal(src.contains(-5, 50), false, 'first area evicted');
  // A box too large for the per-area cap at 1/12° falls back to the 1/3°-style coarse level.
  const big = new SmocCurrentSource(run, { ...SETTINGS, budgetBytes: 200 * 1024 }, client);
  assert.equal(await big.ensure({ west: -60, east: 60, south: -40, north: 40 }, steps, { reason: 'route' }), true);
  assert.equal(big.onDemandAreas[0].res, 'ds4');
  // … and a box too large even for that fails clearly.
  const tiny = new SmocCurrentSource(run, { ...SETTINGS, budgetBytes: 16 * 1024 }, client);
  await assert.rejects(() => tiny.ensure({ west: -60, east: 60, south: -40, north: 40 }, steps, { reason: 'route' }), /per-area cap/);
  // Absent chunks (geo layout, far south) are remembered once the run is settled.
  const south = new SmocCurrentSource(run, SETTINGS, client);
  const longSteps = src.stepsBetween(T0, T0 + 150 * H);
  await south.ensure({ west: 0, east: 1, south: -79, north: -78 }, longSteps, { reason: 'conditions' });
  assert.equal(south.onDemandAreas[0].layout, 'geo');
  assert.deepEqual(south.at(0.5, -78.5, new Date(T0 + 30 * H)), [0, 0]);
  const markers = fs.readdirSync(path.join(dir, run.key, 'geo', 'utotal')).filter(f => f.endsWith('.none'));
  assert.ok(markers.length > 0);
});

test('smoc: resident area, serialization (shared memory) and staleness', async () => {
  const { client, run } = await setup();
  const src = new SmocCurrentSource(run, SETTINGS, client);
  const now = T0 + 20 * H + 1234;
  const steps = src.windowSteps(now);
  assert.deepEqual(
    steps.map(t => (t - T0) / H),
    [18, 21, 24, 27, 30, 33, 36, 39, 42, 45]
  );
  const pos = { lat: 50, lon: -3 };
  assert.equal(residentStale(src, pos, steps), true);
  assert.equal(residentStale(src, null, steps), false);
  const { loadResident } = await import('./smoc');
  const res = await loadResident(client, run, SETTINGS, pos, steps);
  assert.ok(res);
  src.setResident(res.area, pos);
  assert.equal(residentStale(src, pos, steps), false);
  assert.equal(residentStale(src, { lat: 50, lon: 1 }, steps), true, 'moved more than a third of the half-width');
  assert.equal(residentStale(src, pos, steps.slice(1)), true, 'window moved');
  assert.ok(src.contains(-12.9, 40.1) && src.contains(6.9, 59.9));
  assert.equal(src.contains(-17, 50), false);
  const s = src.serialize();
  const copy = SmocCurrentSource.fromSerialized(structuredClone(s), null);
  assert.ok(copy.resident!.u.buffer instanceof SharedArrayBuffer);
  // Structured clone of a SharedArrayBuffer view shares the memory.
  const i = 10;
  const old = src.resident!.u[i];
  src.resident!.u[i] = 123;
  assert.equal(copy.resident!.u[i], 123);
  src.resident!.u[i] = old;
  assert.deepEqual(copy.at(-3.3, 50.2, new Date(now)), src.at(-3.3, 50.2, new Date(now)));
  const st = src.status();
  assert.equal(st.resident!.steps, 10);
  assert.equal(st.memory_bytes, st.resident!.bytes);
  assert.equal(st.shared_resident, true);
});

// ───────────── coastal fill (display only) ─────────────

test('coastal fill: never changes valid values, fills only within 2 cells, routing value unchanged', async () => {
  const { client, run } = await setup();
  const src = new SmocCurrentSource(run, SETTINGS, client);
  const steps = [T0 + 6 * H];
  await src.ensure({ west: 0, east: 30, south: 30, north: 55 }, steps, { reason: 'test' });
  const t = new Date(T0 + 6 * H);
  let filled = 0;
  let unfilled = 0;
  for (let lat = 36; lat <= 49; lat++) {
    for (let lon = 6; lon <= 24; lon++) {
      const raw = node(lat, lon, 6);
      const disp = src.atDisplay(lon, lat, t);
      const at = src.at(lon, lat, t);
      if (!Number.isNaN(raw[0])) {
        // Valid node: display = raw = routing value (bilinear at a node is the node).
        assert.deepEqual(disp, [raw[0], raw[1]], `${lat},${lon}`);
        // Routing: the raw bilinear value, which is the node's value when its whole stencil is water
        // and no data (0, 0) when a stencil corner is land (the model's coastal gap).
        const stencilWet = [
          [0, 1],
          [1, 0],
          [1, 1],
        ].every(([dr, dc]) => !Number.isNaN(node(lat + dr, lon + dc, 6)[0]));
        assert.deepEqual(at, stencilWet ? [raw[0], raw[1]] : [0, 0], `${lat},${lon} routing`);
        continue;
      }
      assert.deepEqual(at, [0, 0], 'routing sees no data on land');
      // Distance (cells) to the nearest valid node.
      let dmin = Infinity;
      for (let dr = -3; dr <= 3; dr++)
        for (let dc = -3; dc <= 3; dc++) if (!Number.isNaN(node(lat + dr, lon + dc, 6)[0])) dmin = Math.min(dmin, Math.hypot(dr, dc));
      if (dmin <= FILL_RADIUS_CELLS) {
        assert.notDeepEqual(disp, [0, 0], `${lat},${lon} within ${dmin} cells should be filled`);
        // IDW² over the valid neighbours within the radius.
        let su = 0;
        let sv = 0;
        let sw = 0;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const d2 = dr * dr + dc * dc;
            if (d2 === 0 || d2 > 4) continue;
            const n = node(lat + dr, lon + dc, 6);
            if (Number.isNaN(n[0])) continue;
            su += n[0] / d2;
            sv += n[1] / d2;
            sw += 1 / d2;
          }
        }
        assert.ok(Math.abs(disp[0] - su / sw) < 1e-12 && Math.abs(disp[1] - sv / sw) < 1e-12);
        filled++;
      } else {
        assert.deepEqual(disp, [0, 0], `${lat},${lon} is ${dmin} cells from water`);
        unfilled++;
      }
    }
  }
  assert.ok(filled > 0 && unfilled > 0, `filled ${filled}, unfilled ${unfilled}`);
});

test('coastal fill: generic grid helper and RTOFS atDisplay', () => {
  // 7×7 grid, valid only in column 0.
  const nR = 7;
  const nC = 7;
  const u = new Float32Array(nR * nC).fill(NaN);
  const v = new Float32Array(nR * nC).fill(NaN);
  for (let r = 0; r < nR; r++) {
    u[r * nC] = 1 + r;
    v[r * nC] = -r;
  }
  const g = { nRows: nR, nCols: nC, wrap: false, u, v, offset: 0 };
  for (let r = 0; r < nR; r++) {
    assert.deepEqual([...filledCell(g, r, 0)], [1 + r, -r], 'valid unchanged');
    assert.ok(Number.isFinite(filledCell(g, r, 1)[0]));
    assert.ok(Number.isFinite(filledCell(g, r, 2)[0]));
    assert.ok(Number.isNaN(filledCell(g, r, 3)[0]), 'beyond 2 cells stays missing');
  }
  // With wrap, column 6 is next to column 0.
  assert.ok(Number.isFinite(filledCell({ ...g, wrap: true }, 3, 6)[0]));
  // RTOFS: display fill at the coast, raw `at` unchanged.
  const mk = (vals: Float32Array): FieldGrid => ({ lat0: 40, lon0: -70, dLat: 0.1, dLon: 0.1, nLat: nR, nLon: nC, values: vals });
  const fu = mk(u);
  const fv = mk(v);
  const rt = new RtofsCurrentSource('RTOFS-test', 0, { south: 40, west: -70, north: 40.6, east: -69.4 }, [{ validMs: 0, u: fu, v: fv }]);
  const t = new Date(0);
  assert.deepEqual(rt.at(-69.9, 40.3, t), [0, 0], 'raw: a corner is on land');
  const d = rt.atDisplay(-69.9, 40.3, t);
  assert.ok(d[0] !== 0 && Number.isFinite(d[0]));
  // On the valid column itself: raw bilinear is NaN (land corner east of it), display gives the column's value.
  assert.ok(Number.isNaN(sampleField(fu, -70, 40.3)));
  const onCol = rt.atDisplay(-70, 40.3, t);
  assert.ok(Math.abs(onCol[0] - 4) < 1e-9 && Math.abs(onCol[1] + 3) < 1e-9);
  assert.deepEqual(sampleFieldPairFilled(fu, fv, -69.3, 40.3).map(Number.isNaN), [true, true]);
});

// ───────────── stack priority ─────────────

test('stack: NECOFS 10 > SMOC 3 > RTOFS 2 > FES 0, with (0, 0) falling through; display uses atDisplay', async () => {
  const { client, run } = await setup();
  const smoc = new SmocCurrentSource(run, SETTINGS, client);
  await smoc.ensure({ west: -10, east: 10, south: 30, north: 50 }, smoc.bracketSteps(T0 + 6 * H), { reason: 'test' });
  const fake = (
    name: string,
    priority: number,
    val: [number, number],
    box = { south: -90, west: -180, north: 90, east: 180 }
  ): CurrentSourceLike => ({
    name,
    priority,
    resolutionM: 1000,
    bbox: box,
    contains: (lon, lat) => lat >= box.south && lat <= box.north && lon >= box.west && lon <= box.east,
    at: () => val,
    atMany: lons => ({ u: new Float64Array(lons.length).fill(val[0]), v: new Float64Array(lons.length).fill(val[1]) }),
  });
  const necofs = fake('NECOFS', 10, [9, 9], { south: 41, west: -2, north: 42, east: -1 });
  const rtofs = fake('RTOFS', 2, [2, 2]);
  const fes = fake('FES', 0, [0.5, 0.5]);
  const stack = new CurrentStack([fes, rtofs, smoc, necofs]);
  assert.deepEqual(
    stack.sources.map(s => s.name),
    ['NECOFS', 'CMEMS-SMOC', 'RTOFS', 'FES']
  );
  assert.equal(SMOC_PRIORITY, 3);
  const t = new Date(T0 + 6 * H);
  assert.deepEqual(stack.at(-1.5, 41.5, t), [9, 9]);
  assert.deepEqual(stack.at(0, 35, t), smoc.at(0, 35, t));
  assert.equal(stack.sourceAt(0, 35, t), 'CMEMS-SMOC');
  // On SMOC land (no data) the next source answers.
  assert.deepEqual(stack.at(15, 42, t), [2, 2]);
  // Outside the SMOC areas too.
  assert.deepEqual(stack.at(100, 0, t), [2, 2]);
  const m = stack.atMany(new Float64Array([0, 15, -1.5]), new Float64Array([35, 42, 41.5]), t);
  assert.deepEqual([m.u[0], m.u[1], m.u[2]], [smoc.at(0, 35, t)[0], 2, 9]);
  // Display: SMOC fills near the coast where the raw value falls through to RTOFS.
  const coast: [number, number] = [10, 42];
  assert.deepEqual(stack.at(coast[0], coast[1], t), [2, 2]);
  assert.deepEqual(stack.atDisplay(coast[0], coast[1], t), smoc.atDisplay(coast[0], coast[1], t));
  assert.notDeepEqual(stack.atDisplay(coast[0], coast[1], t), [2, 2]);
  assert.match(stack.key, /CMEMS-SMOC#\d+/);
  // Region containment across the wrap.
  assert.equal(regionContains({ row0: 0, nRows: 10, col0: 350, nCols: 20 }, { row0: 2, nRows: 3, col0: 5, nCols: 4 }, 360), true);
  assert.equal(regionContains({ row0: 0, nRows: 10, col0: 350, nCols: 20 }, { row0: 2, nRows: 3, col0: 9, nCols: 4 }, 360), false);
});
