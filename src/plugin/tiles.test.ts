import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { roundHour, tileAt, tileBBox, tileQuery, TileService, TileStore, trimPoints, type TileId } from './tiles';

test('tile boxes: web-map tile edges and the tile holding a point', () => {
  const b = tileBBox(1, 0, 0);
  assert.equal(b.west, -180);
  assert.equal(b.east, 0);
  assert.ok(Math.abs(b.north - 85.0511) < 1e-3);
  assert.ok(Math.abs(b.south) < 1e-9);
  const t = tileAt(-71.5, 41.2, 8);
  const tb = tileBBox(8, t.x, t.y);
  assert.ok(tb.west <= -71.5 && -71.5 < tb.east && tb.south <= 41.2 && 41.2 < tb.north);
});

test('tile queries: colour layers reach one spacing past the tile; spacing is fixed by zoom', () => {
  const q = tileQuery({ layer: 'wind', z: 8, x: 75, y: 95, hourMs: 0 });
  assert.equal(q.kind, 'field');
  const a = q.args as { bbox: { west: number; east: number }; res: number };
  const b = tileBBox(8, 75, 95);
  assert.ok(Math.abs(a.res - (b.east - b.west) / 64) < 1e-12);
  assert.ok(Math.abs(a.bbox.west - (b.west - a.res)) < 1e-12);
  assert.equal(tileQuery({ layer: 'land', z: 8, x: 75, y: 95, hourMs: 0 }).kind, 'land_mask');
});

test('trimPoints keeps west/south edges and drops east/north edges', () => {
  const b = tileBBox(4, 5, 6);
  const pts = [
    { lon: b.west, lat: b.south },
    { lon: b.east, lat: b.south },
    { lon: b.west, lat: b.north },
    { lon: (b.west + b.east) / 2, lat: (b.south + b.north) / 2 },
  ];
  assert.equal(trimPoints(pts, 4, 5, 6).length, 2);
});

test('roundHour rounds to the nearest hour', () => {
  assert.equal(roundHour(Date.UTC(2026, 8, 29, 12, 29)), Date.UTC(2026, 8, 29, 12));
  assert.equal(roundHour(Date.UTC(2026, 8, 29, 12, 31)), Date.UTC(2026, 8, 29, 13));
});

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-tiles-'));
}

const T: TileId = { layer: 'wind', z: 6, x: 18, y: 23, hourMs: Date.UTC(2026, 8, 29, 12) };

test('tile service: computes once, saves, then answers from disk', async () => {
  const root = tmp();
  const store = new TileStore({ root, capBytes: 1e9 });
  store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  let calls = 0;
  const svc = new TileService(store, async () => {
    calls++;
    await new Promise(r => setTimeout(r, 20));
    return { result: { v: 1 }, complete: true };
  });
  const [a, b] = await Promise.all([svc.get(T), svc.get(T)]);
  assert.equal(calls, 1, 'identical requests share one query');
  assert.equal(a.cached, false);
  assert.deepEqual(JSON.parse(zlib.gunzipSync(b.gz).toString()), { v: 1 });
  const c = await svc.get(T);
  assert.equal(c.cached, true);
  assert.equal(calls, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('tile service: an incomplete answer is served but not saved', async () => {
  const root = tmp();
  const store = new TileStore({ root, capBytes: 1e9 });
  store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  const svc = new TileService(store, async () => ({ result: [], complete: false }));
  assert.equal((await svc.get(T)).cached, false);
  assert.equal((await svc.get(T)).cached, false);
  assert.equal(store.stats().not_kept, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('tile service: the query is cancelled when every requester has gone', async () => {
  const root = tmp();
  const store = new TileStore({ root, capBytes: 1e9 });
  store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  let seen: AbortSignal | undefined;
  const svc = new TileService(store, (_k, _a, signal) => {
    seen = signal;
    return new Promise((_res, rej) => signal?.addEventListener('abort', () => rej(new Error('cancelled'))));
  });
  const c1 = new AbortController();
  const c2 = new AbortController();
  const p1 = svc.get(T, c1.signal).catch(e => e as Error);
  const p2 = svc.get(T, c2.signal).catch(e => e as Error);
  // Both requesters must have missed the store and joined the one query before the first leaves.
  for (let i = 0; i < 500 && svc.waiters(T) < 2; i++) await new Promise(r => setTimeout(r, 2));
  assert.equal(svc.waiters(T), 2, 'both requesters joined the query');
  c1.abort();
  assert.equal(seen?.aborted, false, 'one requester is still waiting');
  c2.abort();
  assert.equal(seen?.aborted, true);
  assert.equal(((await p1) as Error).message, 'cancelled');
  assert.equal(((await p2) as Error).message, 'cancelled');
  assert.equal(svc.inflightCount, 0);
  // Gone before the query was sent: nothing is started.
  const c3 = new AbortController();
  c3.abort();
  seen = undefined;
  assert.equal(((await svc.get(T, c3.signal).catch(e => e as Error)) as Error).message, 'cancelled');
  assert.equal(seen, undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('tile store: a new generation removes the old one; an answer from the old one is not saved', async () => {
  const root = tmp();
  const store = new TileStore({ root, capBytes: 1e9 });
  store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  const g1 = store.generation('wx');
  await store.write(T, zlib.gzipSync('1'), g1);
  assert.ok(await store.has(T));
  store.setGenerations({ wx: 'b', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  assert.equal(await store.has(T), false);
  await store.write(T, zlib.gzipSync('1'), g1);
  assert.equal(await store.has(T), false, 'written under a superseded generation');
  for (let i = 0; i < 50 && fs.existsSync(path.join(root, g1 as string)); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(fs.existsSync(path.join(root, g1 as string)), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('tile store: prunes least recently used tiles to 90 % of the cap', async () => {
  const root = tmp();
  const store = new TileStore({ root, capBytes: 1e9 });
  store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  const g = store.generation('wx');
  const body = Buffer.alloc(1000, 1);
  for (let i = 0; i < 10; i++) {
    const t = { ...T, x: i };
    await store.write(t, body, g);
    const when = new Date(Date.now() - (10 - i) * 60_000);
    fs.utimesSync(store.file(t) as string, when, when);
  }
  store.setCap(5000);
  await store.prune();
  const s = store.stats();
  assert.ok(s.bytes <= 4500, `bytes ${s.bytes}`);
  assert.equal(await store.has({ ...T, x: 0 }), false, 'oldest removed');
  assert.ok(await store.has({ ...T, x: 9 }), 'newest kept');
  fs.rmSync(root, { recursive: true, force: true });
});

test('pyramid: full radius to zoom 8, halved deeper; nearest the centre first; wraps at the date line', async () => {
  const { pyramidTiles, pyramidRadius } = await import('./tiles');
  assert.equal(pyramidRadius(250_000, 6), 250_000);
  assert.equal(pyramidRadius(250_000, 8), 250_000);
  assert.equal(pyramidRadius(250_000, 10), 62_500);
  const z10 = pyramidTiles(41.2, -71.5, 250_000, 10);
  const c = tileAt(-71.5, 41.2, 10);
  assert.deepEqual(z10[0], c, 'centre tile first');
  // Every tile at zoom 10 lies within the 62.5 km box (plus one tile).
  const b = tileBBox(10, c.x, c.y);
  const w = b.east - b.west;
  for (const t of z10) assert.ok(Math.abs(t.x - c.x) * w < 62_500 / (111_320 * Math.cos((41.2 * Math.PI) / 180)) + w);
  const dl = pyramidTiles(0, 179.9, 250_000, 8);
  const n = 2 ** 8;
  assert.ok(dl.some(t => t.x === n - 1) && dl.some(t => t.x === 0), 'both sides of the date line');
  assert.ok(dl.every(t => t.x >= 0 && t.x < n));
});

test('tile store: an empty or non-gzip saved file is a miss and is removed (what a crash leaves behind)', async () => {
  const root = tmp();
  const store = new TileStore({ root, capBytes: 1e9 });
  store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  const g = store.generation('wx');
  await store.write(T, zlib.gzipSync('1'), g);
  const f = store.file(T) as string;
  fs.writeFileSync(f, Buffer.alloc(0));
  assert.equal(await store.read(T), null, 'empty file is a miss');
  for (let i = 0; i < 50 && fs.existsSync(f); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(fs.existsSync(f), false, 'and it is removed');
  await store.write(T, zlib.gzipSync('1'), g);
  fs.writeFileSync(f, Buffer.from('not gzip at all, but long enough'));
  assert.equal(await store.read(T), null, 'a non-gzip file is a miss');
  await store.write(T, zlib.gzipSync('2'), g);
  const ok = await store.read(T);
  assert.ok(ok && zlib.gunzipSync(ok).toString() === '2', 'a real tile reads back');
  assert.equal(store.corrupt, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('tile store: totals are kept running, saved, and reloaded without a walk', async () => {
  const root = tmp();
  const store = new TileStore({ root, capBytes: 1e9 });
  store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  const g = store.generation('wx');
  // No saved totals: a count walk learns them (empty store: 0) and the first flush saves them.
  const totalsFile = path.join(root, '.totals.json');
  let counted = false;
  for (let i = 0; i < 500 && !counted; i++) {
    store.stats(); // starts the count when the totals are unknown
    await store.flushTotals();
    counted = fs.existsSync(totalsFile);
    if (!counted) await new Promise(r => setTimeout(r, 10));
  }
  assert.ok(counted, 'initial count did not complete');
  const body = Buffer.alloc(1000, 1);
  // A tile written again replaces its file: counted once, bytes by the difference.
  await store.write({ ...T, x: 0 }, Buffer.alloc(400, 1), g);
  await store.write({ ...T, x: 0 }, body, g);
  assert.deepEqual([store.stats().files, store.stats().bytes], [1, 1000]);
  for (let i = 1; i < 5; i++) await store.write({ ...T, x: i }, body, g);
  assert.equal(store.stats().files, 5);
  assert.equal(store.stats().bytes, 5000);
  await store.flushTotals();
  const saved = JSON.parse(fs.readFileSync(path.join(root, '.totals.json'), 'utf8')) as { files: number; bytes: number; savedAt: string };
  assert.equal(saved.files, 5);
  assert.equal(saved.bytes, 5000);
  // A new store on the same root answers from the saved totals at once.
  const again = new TileStore({ root, capBytes: 1e9 });
  assert.deepEqual([again.stats().files, again.stats().bytes], [5, 5000]);
  // A retired generation is subtracted, not forgotten.
  again.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  again.setGenerations({ wx: 'b', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  for (let i = 0; i < 100 && again.stats().files !== 0; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual([again.stats().files, again.stats().bytes], [0, 0]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('tile store: a root without saved totals is counted in the background', async () => {
  const root = tmp();
  const a = new TileStore({ root, capBytes: 1e9 });
  a.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
  const g = a.generation('wx');
  for (let i = 0; i < 3; i++) await a.write({ ...T, x: i }, Buffer.alloc(100, 1), g);
  fs.rmSync(path.join(root, '.totals.json'), { force: true });
  const b = new TileStore({ root, capBytes: 1e9 });
  assert.equal(b.stats().files, 0, 'unknown until counted');
  for (let i = 0; i < 100 && b.stats().files !== 3; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual([b.stats().files, b.stats().bytes], [3, 300]);
  fs.rmSync(root, { recursive: true, force: true });
});
