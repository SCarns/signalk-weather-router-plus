import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HarmonicCurrentSource } from './harmonic';
import { CurrentStack } from './stack';
import { RtofsCurrentSource, loadRtofsSteps, RtofsClient, rtofsRunFor } from './rtofs';
import { buildIsobarFeatures, contourLines } from '../engine/isobars';

// The harmonic .npz files are the user's data (35 MB) and are not in the
// repo; point WRP_TIDES_DIR at a directory holding currents_local.npz and
// necofs_gom3.npz to run the end-to-end comparison.
const tidesDir = process.env.WRP_TIDES_DIR;
const refPath = path.join(__dirname, '..', '..', 'test-data', 'harmonic_points_ref.json');

interface RefPoint { lon: number; lat: number; time: string; fes: [number, number]; necofs: [number, number]; stack: [number, number] }

test('harmonic sources and stack reproduce the reference implementation', { skip: !tidesDir || !fs.existsSync(refPath) ? 'WRP_TIDES_DIR not set' : false }, () => {
  const fes = new HarmonicCurrentSource(path.join(tidesDir!, 'currents_local.npz'));
  const necofs = new HarmonicCurrentSource(path.join(tidesDir!, 'necofs_gom3.npz'));
  const ref = JSON.parse(fs.readFileSync(refPath, 'utf8')) as { points: RefPoint[]; stack_order: string[]; fes_constituents: string[]; necofs_constituents: string[] };
  assert.deepEqual(fes.constituents, ref.fes_constituents);
  assert.deepEqual(necofs.constituents, ref.necofs_constituents);
  assert.deepEqual(fes.dropped, ['la2']);
  const stack = new CurrentStack([fes, necofs]);
  assert.deepEqual(stack.sources.map((s) => s.name), ref.stack_order);
  let maxD = 0;
  let nonzero = 0;
  for (const p of ref.points) {
    const t = new Date(p.time);
    const a = fes.at(p.lon, p.lat, t);
    const b = necofs.at(p.lon, p.lat, t);
    const s = stack.at(p.lon, p.lat, t);
    for (const [got, want] of [[a, p.fes], [b, p.necofs], [s, p.stack]] as [number[], number[]][]) {
      maxD = Math.max(maxD, Math.abs(got[0] - want[0]), Math.abs(got[1] - want[1]));
    }
    if (p.stack[0] !== 0 || p.stack[1] !== 0) nonzero++;
  }
  console.log(`  harmonic end-to-end: ${ref.points.length} points, ${nonzero} with current, max |Δ| = ${maxD.toExponential(2)} m/s`);
  // The reference evaluates its bilinear index in float32; 5e-5 m/s covers that rounding.
  assert.ok(maxD < 5e-5, `max deviation ${maxD}`);
  // atMany agrees with at.
  const lons = new Float64Array(ref.points.slice(0, 50).map((p) => p.lon));
  const lats = new Float64Array(ref.points.slice(0, 50).map((p) => p.lat));
  const t0 = new Date(ref.points[0].time);
  const m = stack.atMany(lons, lats, t0);
  for (let i = 0; i < lons.length; i++) {
    const [u, v] = stack.at(lons[i], lats[i], t0);
    assert.ok(Math.abs(m.u[i] - u) < 1e-12 && Math.abs(m.v[i] - v) < 1e-12);
  }
});

const rtofsFile = process.env.WRP_RTOFS_FILE;
test('RTOFS GRIB2 daily file decodes into a current source', { skip: !rtofsFile ? 'WRP_RTOFS_FILE not set' : false }, async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'wrp-rtofs-'));
  const run = rtofsRunFor(new Date());
  const client = new RtofsClient({ cacheDir: dir, region: 'west_atl', fetchImpl: (async () => { throw new Error('no network in test'); }) as unknown as typeof fetch });
  fs.mkdirSync(path.dirname(client.cachePath(run, 'f024')), { recursive: true });
  fs.copyFileSync(rtofsFile!, client.cachePath(run, 'f024'));
  const bbox = { west: -75, south: 36, east: -65, north: 44 };
  const steps = await loadRtofsSteps(client, run, bbox, 24, 3);
  assert.equal(steps.length, 8);
  const g = steps[0].u;
  const src = new RtofsCurrentSource('RTOFS-test', run.time.getTime(), { south: g.lat0, west: g.lon0, north: g.lat0 + (g.nLat - 1) * g.dLat, east: g.lon0 + (g.nLon - 1) * g.dLon }, steps);
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

test('isobars: a synthetic low yields closed contours, labels and an L', () => {
  const nx = 41;
  const ny = 33;
  const lons = new Float64Array(nx);
  const lats = new Float64Array(ny);
  for (let i = 0; i < nx; i++) lons[i] = -75 + i * 0.25;
  for (let j = 0; j < ny; j++) lats[j] = 36 + j * 0.25;
  const field = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const dx = (lons[i] + 70) / 2;
      const dy = (lats[j] - 40) / 2;
      field[j * nx + i] = 1016 - 20 * Math.exp(-(dx * dx + dy * dy));
    }
  }
  const lines = contourLines(field, lons, lats, 1004);
  assert.ok(lines.length >= 1);
  const longest = lines.reduce((a, b) => (b.length > a.length ? b : a));
  const first = longest[0];
  const last = longest[longest.length - 1];
  assert.ok(Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6, 'contour around the low should close');
  const feats = buildIsobarFeatures(field, lons, lats, 4);
  const kinds = new Set(feats.map((f) => f.properties.kind));
  assert.ok(kinds.has('isobar') && kinds.has('label') && kinds.has('low'), `kinds ${[...kinds].join(',')}`);
  const low = feats.find((f) => f.properties.kind === 'low')!;
  const [lon, lat] = (low.geometry as { coordinates: [number, number] }).coordinates;
  assert.ok(Math.abs(lon + 70) <= 0.26 && Math.abs(lat - 40) <= 0.26, `low at ${lon},${lat}`);
  assert.ok(feats.some((f) => f.properties.kind === 'isobar' && f.properties.hpa === 1000 && f.properties.bold === true));
  for (const f of feats) assert.equal(f.properties.pa, Math.round((f.properties.hpa as number) * 100), `pa beside hpa on ${f.properties.kind}`);
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
