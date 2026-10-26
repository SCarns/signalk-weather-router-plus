import { test } from 'node:test';
import { HOUR_S } from '../geo/units';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HarmonicCurrentSource } from './harmonic';
import { CurrentStack } from './stack';
import { RtofsCurrentSource, loadRtofsSteps, RtofsClient, rtofsRunFor } from './rtofs';

// The harmonic .npz files are the user's data (35 MB) and are not in the
// repo; point WRP_TIDES_DIR at a directory holding currents_local.npz and
// necofs_gom3.npz to run the end-to-end comparison.
const tidesDir = process.env.WRP_TIDES_DIR;
const refPath = path.join(__dirname, '..', '..', 'test-data', 'harmonic_points_ref.json');

interface RefPoint {
  lon: number;
  lat: number;
  time: string;
  fes: [number, number];
  necofs: [number, number];
  stack: [number, number];
}

test(
  'harmonic sources and stack reproduce the recorded reference points',
  { skip: !tidesDir || !fs.existsSync(refPath) ? 'WRP_TIDES_DIR not set' : false },
  () => {
    const fes = new HarmonicCurrentSource(path.join(tidesDir!, 'currents_local.npz'));
    const necofs = new HarmonicCurrentSource(path.join(tidesDir!, 'necofs_gom3.npz'));
    const ref = JSON.parse(fs.readFileSync(refPath, 'utf8')) as {
      points: RefPoint[];
      stack_order: string[];
      fes_constituents: string[];
      necofs_constituents: string[];
    };
    assert.deepEqual(fes.constituents, ref.fes_constituents);
    assert.deepEqual(necofs.constituents, ref.necofs_constituents);
    assert.deepEqual(fes.dropped, ['la2']);
    const stack = new CurrentStack([fes, necofs]);
    assert.deepEqual(
      stack.sources.map(s => s.name),
      ref.stack_order
    );
    let maxD = 0;
    let nonzero = 0;
    for (const p of ref.points) {
      const t = new Date(p.time);
      const a = fes.at(p.lon, p.lat, t);
      const b = necofs.at(p.lon, p.lat, t);
      const s = stack.at(p.lon, p.lat, t);
      for (const [got, want] of [
        [a, p.fes],
        [b, p.necofs],
        [s, p.stack],
      ] as [number[], number[]][]) {
        maxD = Math.max(maxD, Math.abs(got[0] - want[0]), Math.abs(got[1] - want[1]));
      }
      if (p.stack[0] !== 0 || p.stack[1] !== 0) nonzero++;
    }
    console.log(`  harmonic end-to-end: ${ref.points.length} points, ${nonzero} with current, max |Δ| = ${maxD.toExponential(2)} m/s`);
    // The reference points were computed with a float32 bilinear index; 5e-5 m/s covers that rounding.
    assert.ok(maxD < 5e-5, `max deviation ${maxD}`);
    // atMany agrees with at.
    const lons = new Float64Array(ref.points.slice(0, 50).map(p => p.lon));
    const lats = new Float64Array(ref.points.slice(0, 50).map(p => p.lat));
    const t0 = new Date(ref.points[0].time);
    const m = stack.atMany(lons, lats, t0);
    for (let i = 0; i < lons.length; i++) {
      const [u, v] = stack.at(lons[i], lats[i], t0);
      assert.ok(Math.abs(m.u[i] - u) < 1e-12 && Math.abs(m.v[i] - v) < 1e-12);
    }
  }
);

const rtofsFile = process.env.WRP_RTOFS_FILE;
test('RTOFS GRIB2 daily file decodes into a current source', { skip: !rtofsFile ? 'WRP_RTOFS_FILE not set' : false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-rtofs-'));
  const run = rtofsRunFor(new Date());
  const client = new RtofsClient({ cacheDir: dir, region: 'west_atl', cacheOnly: true });
  fs.mkdirSync(path.dirname(client.cachePath(run, 'f024')), { recursive: true });
  fs.copyFileSync(rtofsFile!, client.cachePath(run, 'f024'));
  const bbox = { west: -75, south: 36, east: -65, north: 44 };
  const steps = await loadRtofsSteps(client, run, bbox, 24 * HOUR_S, 3 * HOUR_S);
  assert.equal(steps.length, 8);
  const g = steps[0].u;
  const src = new RtofsCurrentSource(
    'test',
    run.time.getTime(),
    { south: g.lat0, west: g.lon0, north: g.lat0 + (g.nLat - 1) * g.dLat, east: g.lon0 + (g.nLon - 1) * g.dLon },
    steps
  );
  // Gulf Stream off Cape Hatteras should show a strong north-eastward current at some hour.
  const t = new Date(steps[0].validMs);
  const [u, v] = src.at(-74.5, 35.5, t);
  console.log(`  RTOFS at 35.5N 74.5W: u=${u.toFixed(2)} v=${v.toFixed(2)} m/s, grid ${g.nLon}x${g.nLat}`);
  assert.ok(Number.isFinite(u) && Number.isFinite(v));
  // Land (central Long Island) → bit-mapped in the product → no data; outside the box → no data.
  assert.deepEqual(src.at(-73.0, 40.85, t), [0, 0]);
  assert.deepEqual(src.at(-78.5, 37.5, t), [0, 0]);
  // Time interpolation: halfway between steps 0 and 1 equals the mean.
  const tm = new Date((steps[0].validMs + steps[1].validMs) / 2);
  const [u0] = src.at(-70, 40, new Date(steps[0].validMs));
  const [u1] = src.at(-70, 40, new Date(steps[1].validMs));
  const [um] = src.at(-70, 40, tm);
  assert.ok(Math.abs(um - (u0 + u1) / 2) < 1e-9);
  // Beyond the grace period → no data.
  assert.deepEqual(src.at(-70, 40, new Date(steps[steps.length - 1].validMs + 2 * 3600_000)), [0, 0]);
});

test('harmonic: one point at a new time equals the full-grid prediction', { skip: !tidesDir ? 'WRP_TIDES_DIR not set' : false }, () => {
  for (const f of ['necofs_gom3.npz', 'currents_local.npz']) {
    const point = new HarmonicCurrentSource(path.join(tidesDir!, f));
    const grid = new HarmonicCurrentSource(path.join(tidesDir!, f));
    const b = point.bbox;
    const t0 = Date.parse('2026-09-29T18:00:00Z');
    for (let h = 0; h < 24; h++) {
      const t = new Date(t0 + h * 3600e3);
      for (let k = 0; k < 4; k++) {
        const lon = b.west + (b.east - b.west) * ((k * 0.173 + h * 0.037) % 1);
        const lat = b.south + (b.north - b.south) * ((k * 0.291 + h * 0.053) % 1);
        const p = point.at(lon, lat, t); // no grid cached: single-point path
        const g = grid.atMany(Float64Array.of(lon), Float64Array.of(lat), t); // full grid
        assert.equal(p[0], g.u[0], `${f} u at ${lon},${lat} ${t.toISOString()}`);
        assert.equal(p[1], g.v[0], `${f} v at ${lon},${lat} ${t.toISOString()}`);
      }
    }
  }
});

test('rtofs: a relayed set is used only when it was loaded under the current extra products, and only when RTOFS is on', async () => {
  const { rtofsSetForConfig } = await import('./rtofs');
  const set = { extra: ['samoa'], runs: [] };
  assert.equal(rtofsSetForConfig(set, true, ['samoa']), set);
  assert.equal(rtofsSetForConfig(set, true, []), null, 'loaded before the extra products changed: dropped');
  assert.equal(rtofsSetForConfig(set, true, ['samoa', 'guam']), null);
  assert.equal(rtofsSetForConfig(set, false, ['samoa']), null);
  assert.equal(rtofsSetForConfig(null, true, ['samoa']), null);
});

/** The products' extents as their f024 headers gave them (2026-10-21 run; rtofsExtentOfGrid of each grid). */
const EXTENTS = {
  west_atl: { south: 10, north: 44.72, west: -100, east: -54.08, dLon: 0.08, dLat: 0.08 },
  west_conus: { south: 10, north: 59.92, west: -150, east: -100.08, dLon: 0.08, dLat: 0.08 },
  alaska: { south: 40, north: 84.7, west: 140, east: 244.7, dLon: 0.3, dLat: 0.3 },
  hudson_baffin: { south: 40, north: 77.75, west: -109, east: -27.25, dLon: 0.25, dLat: 0.25 },
  honolulu: { south: 0, north: 39.92, west: -180, east: -130.08, dLon: 0.08, dLat: 0.08 },
  samoa: { south: -30, north: -0.08, west: 170, east: 214.72, dLon: 0.08, dLat: 0.08 },
  trop_paci_lowres: { south: -40, north: 39, west: 130, east: 249, dLon: 1, dLat: 1 },
};

/** The start of a GRIB2 file: sections 0, 1 and 3 (template 3.0) of a lat/lon grid; nothing after section 3. */
function gribHead(g: { ni: number; nj: number; la1: number; lo1: number; la2: number; lo2: number; di: number; dj: number }): Uint8Array {
  const b = new Uint8Array(16 + 21 + 72);
  const dv = new DataView(b.buffer);
  b.set([0x47, 0x52, 0x49, 0x42], 0);
  b[6] = 10; // discipline: oceanographic
  b[7] = 2; // edition
  dv.setUint32(12, 16 + 21 + 72 + 4); // a total length past the end, as in a file read only in part
  dv.setUint32(16, 21);
  b[20] = 1;
  const s3 = 37;
  dv.setUint32(s3, 72);
  b[s3 + 4] = 3;
  dv.setUint32(s3 + 6, g.ni * g.nj);
  const o = s3 - 1; // octet numbering
  dv.setUint32(o + 31, g.ni);
  dv.setUint32(o + 35, g.nj);
  const s32 = (at: number, v: number): void => dv.setUint32(at, v < 0 ? (0x80000000 | -v) >>> 0 : v);
  s32(o + 47, Math.round(g.la1 * 1e6));
  s32(o + 51, Math.round(g.lo1 * 1e6));
  s32(o + 56, Math.round(g.la2 * 1e6));
  s32(o + 60, Math.round(g.lo2 * 1e6));
  dv.setUint32(o + 64, Math.round(g.di * 1e6));
  dv.setUint32(o + 68, Math.round(g.dj * 1e6));
  b[o + 72] = 0x40; // rows south to north, columns west to east
  return b;
}

test("rtofs: a product's extent from the first bytes of its file, across the antimeridian", async () => {
  const { rtofsExtentOfGrid } = await import('./rtofs');
  const { parseGrib2Grid } = await import('../grib/grib2');
  // samoa as NOMADS codes it: 560 × 375 from 170°E eastward, 30°S to "0" (374 rows of 0.08° end at 0.08°S).
  const e = rtofsExtentOfGrid(parseGrib2Grid(gribHead({ ni: 560, nj: 375, la1: -30, lo1: 170, la2: 0, lo2: 214.8, di: 0.08, dj: 0.08 })));
  assert.equal(e.south, -30);
  assert.ok(Math.abs(e.north + 0.08) < 1e-9, `${e.north}`);
  assert.equal(e.west, 170);
  assert.ok(Math.abs(e.east - 214.72) < 1e-6, `${e.east}`);
  // west_atl: 260° coded, -100 as a longitude; 44.8°N coded as the last row, 44.72°N where the decoder puts it
  // (and brain's /api/status showed for the decoded run, 2026-10-22).
  const w = rtofsExtentOfGrid(parseGrib2Grid(gribHead({ ni: 575, nj: 435, la1: 10, lo1: 260, la2: 44.8, lo2: 306, di: 0.08, dj: 0.08 })));
  assert.equal(w.west, -100);
  assert.ok(Math.abs(w.north - 44.72) < 1e-9 && Math.abs(w.east + 54.08) < 1e-9, `${w.north} ${w.east}`);
  assert.throws(
    () => parseGrib2Grid(gribHead({ ni: 5, nj: 5, la1: 0, lo1: 0, la2: 1, lo2: 1, di: 0.25, dj: 0.25 }).subarray(0, 60)),
    /no grid definition/
  );
});

test('rtofs: the product the vessel is in: the finest where two overlap, none without a position or where none covers', async () => {
  const { chooseRtofsProduct, extentContains, extentMeets, finestFirst } = await import('./rtofs');
  // Fiji (the boat in issue #61): samoa, not the 1° trop_paci_lowres.
  assert.deepEqual(chooseRtofsProduct(EXTENTS, { lat: -18, lon: 178 }), { product: 'samoa', reason: null });
  // East of the antimeridian, still samoa (214.8°E = 145.2°W).
  assert.equal(chooseRtofsProduct(EXTENTS, { lat: -14, lon: -170 }).product, 'samoa');
  // Buzzards Bay: west_atl (0.08°) over hudson_baffin (0.25°).
  assert.equal(chooseRtofsProduct(EXTENTS, { lat: 41.6, lon: -70.75 }).product, 'west_atl');
  // Bering Sea at 160°W, west of west_conus: alaska, which crosses the antimeridian (140°E–115°W).
  assert.equal(chooseRtofsProduct(EXTENTS, { lat: 58, lon: -160 }).product, 'alaska');
  // 150°W is west_conus's west edge: its finer grid wins over alaska's.
  assert.equal(chooseRtofsProduct(EXTENTS, { lat: 58, lon: -150 }).product, 'west_conus');
  const fr = chooseRtofsProduct(EXTENTS, { lat: 47.3, lon: -2.5 });
  assert.equal(fr.product, null);
  assert.match(fr.reason!, /no RTOFS product known to cover the vessel at 47\.30, -2\.50 \(the extent of .*guam.* is not known yet\)/);
  assert.deepEqual(chooseRtofsProduct(EXTENTS, null), { product: null, reason: 'no vessel position' });
  assert.deepEqual(finestFirst(['trop_paci_lowres', 'samoa', 'hudson_baffin', 'west_atl'], EXTENTS), [
    'west_atl',
    'samoa',
    'hudson_baffin',
    'trop_paci_lowres',
  ]);
  assert.ok(extentContains(EXTENTS.alaska, -150, 58) && extentContains(EXTENTS.alaska, 170, 58));
  assert.ok(!extentContains(EXTENTS.alaska, -100, 58) && !extentContains(EXTENTS.alaska, 120, 58));
  assert.ok(extentMeets(EXTENTS.samoa, { west: 178, east: -178, south: -20, north: -16 }), 'a box across the antimeridian');
  assert.ok(!extentMeets(EXTENTS.west_atl, { west: 170, east: 175, south: -20, north: -16 }));
});

test('rtofs: a source across the antimeridian answers on both sides of it', () => {
  const nLat = 3;
  const nLon = 4;
  const f = (v: number): { lat0: number; lon0: number; dLat: number; dLon: number; nLat: number; nLon: number; values: Float32Array } => ({
    lat0: -20,
    lon0: 178,
    dLat: 1,
    dLon: 1,
    nLat,
    nLon,
    values: new Float32Array(nLat * nLon).fill(v),
  });
  const src = new RtofsCurrentSource('samoa', 0, { south: -20, west: 178, north: -18, east: 181 }, [{ validMs: 0, u: f(0.3), v: f(0.1) }]);
  assert.equal(src.name, 'RTOFS-samoa');
  const t = new Date(0);
  assert.deepEqual(
    src.at(179.5, -19, t).map(x => Math.round(x * 10) / 10),
    [0.3, 0.1]
  );
  assert.deepEqual(
    src.at(-179.5, -19, t).map(x => Math.round(x * 10) / 10),
    [0.3, 0.1],
    'east of the antimeridian'
  );
  assert.deepEqual(src.at(-178.5, -19, t), [0, 0], 'beyond its east edge');
});

test('rtofs: extents read once from NOMADS (the newest published f024, its first bytes only) and kept on disk', async () => {
  const { loadRtofsExtents, readRtofsExtents, RTOFS_REGIONS } = await import('./rtofs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-rtofs-ext-'));
  const now = new Date(Date.UTC(2026, 9, 22, 6));
  const head = gribHead({ ni: 575, nj: 435, la1: 10, lo1: 260, la2: 44.72, lo2: 305.92, di: 0.08, dj: 0.08 });
  const asked: { url: string; range: string | null }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('range');
    asked.push({ url, range });
    // Today's run is not out yet; yesterday's answers the range with the whole file (a server ignoring Range).
    if (url.includes('rtofs.20261022')) return new Response(null, { status: 404 });
    const body = new Uint8Array(200_000);
    body.set(head, 0);
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  const r = await loadRtofsExtents(dir, { network: true, now, fetchImpl, sleepImpl: async () => undefined });
  assert.deepEqual(r.unknown, []);
  assert.equal(r.extents.samoa.west, -100, 'every product read from its own file (all the same grid here)');
  assert.equal(asked.length, 2 * RTOFS_REGIONS.length, 'today 404, then yesterday, per product');
  assert.ok(asked.every(a => a.range === 'bytes=0-4095'));
  assert.ok(asked.some(a => a.url.endsWith('rtofs.20261021/rtofs_glo.t00z.f024_honolulu_std.grb2')));
  assert.equal(readRtofsExtents(dir).guam.north, 44.72);
  // Kept: the next load asks nothing, also without the network.
  asked.length = 0;
  assert.deepEqual((await loadRtofsExtents(dir, { network: true, now, fetchImpl })).unknown, []);
  assert.equal(asked.length, 0);
});

test('harmonic: points at their own times (per-cell prediction) equal the full-grid prediction exactly', () => {
  // A synthetic source: 7 × 9 cells, three constituents, one no-data cell.
  const lats = Float64Array.from({ length: 7 }, (_, i) => 41 + i * 0.05);
  const lons = Float64Array.from({ length: 9 }, (_, j) => -71.6 + j * 0.05);
  const constituents = ['m2', 's2', 'k1'];
  const per = lats.length * lons.length;
  const n = constituents.length * per;
  const block = new SharedArrayBuffer(4 * n * 4);
  const [ea, ep, na, np] = [0, 1, 2, 3].map(k => new Float32Array(block, k * n * 4, n));
  let seed = 7;
  const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < n; i++) {
    ea[i] = 80 * rnd();
    ep[i] = 360 * rnd();
    na[i] = 80 * rnd();
    np[i] = 360 * rnd();
  }
  for (let c = 0; c < constituents.length; c++) ea[c * per + 3 * lons.length + 4] = NaN;
  const ser = {
    name: 'synthetic',
    priority: 10,
    resolutionM: 5000,
    bbox: { south: lats[0], north: lats[lats.length - 1], west: lons[0], east: lons[lons.length - 1] },
    lats,
    lons,
    constituents,
    dropped: [],
    block,
  };
  const cells = new HarmonicCurrentSource(ser);
  const grid = new HarmonicCurrentSource(ser);
  const t0 = Date.parse('2026-10-15T12:00:00Z');
  const k = 400;
  const lo = new Float64Array(k);
  const la = new Float64Array(k);
  const ts = new Float64Array(k);
  for (let i = 0; i < k; i++) {
    lo[i] = lons[0] - 0.02 + (lons[lons.length - 1] - lons[0] + 0.04) * rnd();
    la[i] = lats[0] - 0.02 + (lats[lats.length - 1] - lats[0] + 0.04) * rnd();
    ts[i] = t0 + 6 * 3600e3 * rnd();
  }
  const a = cells.atManyAt(lo, la, ts); // no grid cached: per-cell path
  let nonzero = 0;
  let nodata = 0;
  for (let i = 0; i < k; i++) {
    const g = grid.atMany(Float64Array.of(lo[i]), Float64Array.of(la[i]), new Date(ts[i])); // full grid
    assert.equal(a.u[i], g.u[0], `u ${i}`);
    assert.equal(a.v[i], g.v[0], `v ${i}`);
    if (a.u[i] !== 0) nonzero++;
    else if (cells.contains(lo[i], la[i])) nodata++;
  }
  assert.ok(nonzero > 250 && nodata > 0, `${nonzero} with current, ${nodata} next to the no-data cell`);
  assert.equal(cells.cacheBytes(), 0, 'the per-cell path predicts no whole grid');
});

test('rtofs: a file whose body stalls after the headers is given up at the timeout, not waited for', async () => {
  const { RtofsClient, rtofsRunFor } = await import('./rtofs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-rtofs-stall-'));
  // Headers, a few bytes, then nothing: the stream never ends (a server that stalls mid-body).
  const fetchImpl = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([0x47, 0x52, 0x49, 0x42]));
        },
      }),
      { status: 206 }
    )) as unknown as typeof fetch;
  const client = new RtofsClient({ cacheDir: dir, region: 'west_atl', fetchImpl, timeoutMs: 200, retries: 1 });
  const t0 = Date.now();
  await assert.rejects(() => client.fetchExtent(rtofsRunFor(new Date())), /not a GRIB message|no grid definition|edition/);
  assert.ok(Date.now() - t0 < 5000, `gave up after ${Date.now() - t0} ms`);
});

test('rtofs: a cache-only read of a file not in the cache fails at once, without the network', async () => {
  const { rtofsFromCache } = await import('./fromcache');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-rtofs-cacheonly-'));
  let asked = 0;
  const fetchImpl = (async () => {
    asked++;
    throw new Error('the network was asked');
  }) as unknown as typeof fetch;
  const client = new RtofsClient({ cacheDir: dir, region: 'west_atl', cacheOnly: true, fetchImpl });
  const t0 = Date.now();
  await assert.rejects(
    () => client.fetchFile(rtofsRunFor(new Date(Date.UTC(2026, 9, 26))), 'f024'),
    /west_atl run 20261026 f024 is not in the cache/
  );
  // As the tile builders and the chart-mesh leg read it (fromcache.ts): an error at once, not 62 s of retries.
  const r = await rtofsFromCache(
    {
      cacheDir: dir,
      runs: [{ product: 'west_atl', runMs: Date.UTC(2026, 9, 26), bbox: { south: 10, west: -100, north: 44.72, east: -54.08 } }],
      horizonS: 72 * HOUR_S,
      stepS: 3 * HOUR_S,
    },
    null
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].source, null);
  assert.match(r[0].error!, /not in the cache/);
  assert.equal(asked, 0, 'the network is never asked');
  assert.ok(Date.now() - t0 < 2000, `failed after ${Date.now() - t0} ms`);
  fs.rmSync(dir, { recursive: true, force: true });
});
