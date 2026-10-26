import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pointInShape, readShapefilePolygons, ShapefileIndex, type ShapePolygon } from './shapefile';
import { LandMask } from './landmask';
import { chooseOverlayResolution, OnDemandLand, snapBBox } from './landcache';
import { CoastTiles, COAST_TILE_DEG } from './coasttiles';
import { rasterFromTiles } from './rawraster';

/** Write a minimal polygon shapefile (type 5); each polygon is a list of rings of [lon, lat]. */
function writeShp(file: string, polys: number[][][][]): void {
  const recs: Buffer[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  polys.forEach((rings, i) => {
    const pts = rings.flat();
    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => p[1]);
    const bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    minX = Math.min(minX, bb[0]);
    minY = Math.min(minY, bb[1]);
    maxX = Math.max(maxX, bb[2]);
    maxY = Math.max(maxY, bb[3]);
    const len = 44 + 4 * rings.length + 16 * pts.length;
    const b = Buffer.alloc(8 + len);
    b.writeInt32BE(i + 1, 0);
    b.writeInt32BE(len / 2, 4);
    b.writeInt32LE(5, 8);
    bb.forEach((v, k) => b.writeDoubleLE(v, 12 + 8 * k));
    b.writeInt32LE(rings.length, 44);
    b.writeInt32LE(pts.length, 48);
    let start = 0;
    rings.forEach((r, k) => {
      b.writeInt32LE(start, 52 + 4 * k);
      start += r.length;
    });
    let o = 52 + 4 * rings.length;
    for (const p of pts) {
      b.writeDoubleLE(p[0], o);
      b.writeDoubleLE(p[1], o + 8);
      o += 16;
    }
    recs.push(b);
  });
  const body = Buffer.concat(recs);
  const h = Buffer.alloc(100);
  h.writeInt32BE(9994, 0);
  h.writeInt32BE((100 + body.length) / 2, 24);
  h.writeInt32LE(1000, 28);
  h.writeInt32LE(5, 32);
  [minX, minY, maxX, maxY].forEach((v, k) => h.writeDoubleLE(v, 36 + 8 * k));
  fs.writeFileSync(file, Buffer.concat([h, body]));
}

const sq = (w: number, s: number, e: number, n: number): number[][] => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];

/** The coastline's tiles (coasttiles.ts), cut into a folder of their own. */
function coastOf(files: string[]): CoastTiles {
  return CoastTiles.build(files, fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-tiles-')));
}

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-land-'));
  const file = path.join(dir, 'land.shp');
  writeShp(file, [
    [sq(-71, 41, -70, 42)], // island off Cape Cod
    [sq(10, 50, 12, 52), sq(10.5, 50.5, 11, 51)], // square with a lake
    [sq(179, -10, 180, -9)], // touching the antimeridian from the west
    [sq(-180, -10, -179, -9)], // and from the east
  ]);
  return file;
}

test('ShapefileIndex.read returns what a full scan returns', () => {
  const file = fixture();
  const ix = ShapefileIndex.open(file);
  assert.equal(ix.count, 4);
  for (const b of [
    { west: -72, south: 40, east: -69, north: 43 },
    { west: 170, south: -20, east: -170, north: 0 },
    { west: -180, south: -90, east: 180, north: 90 },
    { west: 0, south: 0, east: 1, north: 1 },
  ]) {
    const a = readShapefilePolygons(file, b).map(s => s.recordNumber);
    const c = ix.read(b).map(s => s.recordNumber);
    assert.deepEqual(c, a, JSON.stringify(b));
  }
  assert.deepEqual(
    ix.containing(10.7, 50.7).map(s => s.recordNumber),
    [2]
  );
  assert.equal(ShapefileIndex.open(file), ix, 'cached per file');
});

test('streamed rasterisation equals rasterising all polygons at once', () => {
  const file = fixture();
  for (const [b, res] of [
    [{ west: -180, south: -90, east: 180, north: 90 }, 0.25],
    [{ west: 170, south: -20, east: -170, north: 0 }, 0.05],
    [{ west: 9, south: 49, east: 13, north: 53 }, 0.01],
  ] as const) {
    const all = LandMask.fromPolygons(readShapefilePolygons(file, b), b, res);
    const ix = ShapefileIndex.open(file);
    const streamed = LandMask.rasterStreamed(b, res, add => {
      ix.forEach(b, add);
    });
    assert.deepEqual(streamed.raster, all.raster, JSON.stringify(b));
    assert.ok(all.landFraction() > 0);
  }
});

test('OnDemandLand: raster per bbox matched to the spacing, LRU reuse, exact point test', () => {
  const file = fixture();
  const land = new OnDemandLand(coastOf([file]), { maxEntries: 2, maxCells: 4_000_000 });
  const view = { west: -72, south: 40, east: -69, north: 43 };
  const m = land.forBBox(view, 0.05);
  assert.equal(m.resolutionDeg, 0.01); // quarter of 0.05 snapped down to the offered set
  assert.ok(m.isLand(-70.5, 41.5));
  assert.ok(!m.isLand(-71.5, 41.5));
  assert.equal(m.hasPolygons, false, 'polygons dropped after rasterising');
  // Same view again and a small pan inside the snapped box: cache hits.
  assert.equal(land.forBBox(view, 0.05), m);
  assert.equal(land.forBBox({ west: -71.9, south: 40.1, east: -69.1, north: 42.9 }, 0.05), m);
  assert.equal(land.stats().builds, 1);
  assert.equal(land.stats().hits, 2);
  // LRU bound.
  land.forBBox({ west: 9, south: 49, east: 13, north: 53 }, 0.05);
  land.forBBox({ west: 170, south: -20, east: -170, north: 0 }, 0.05);
  assert.equal(land.stats().entries, 2);
  // Antimeridian bbox raster sees both halves.
  const am = land.forBBox({ west: 170, south: -20, east: -170, north: 0 }, 0.05);
  assert.ok(am.isLand(179.5, -9.5) && am.isLand(-179.5, -9.5) && !am.isLand(178, -9.5));
  // Exact point tests honour holes and the antimeridian.
  assert.equal(land.isLandAt(10.2, 50.2), true);
  assert.equal(land.isLandAt(10.7, 50.7), false, 'lake');
  assert.equal(land.isLandAt(-70.5, 41.5), true);
  assert.equal(land.isLandAt(-70.5 + 360, 41.5), true);
  assert.equal(land.isLandAt(-179.5, -9.5), true);
  assert.equal(land.isLandAt(0, 0), false);
});

test('OnDemandLand: a view whose north and east edges fall on the raster grid still reads its edge samples as water', () => {
  const file = fixture();
  const land = new OnDemandLand(coastOf([file]), { maxCells: 4_000_000 });
  // At 0.01° the raster snaps to 2.56° blocks: this view's edges are exactly on block boundaries.
  const view = { west: -28 * 2.56, south: 16 * 2.56, east: -27 * 2.56, north: 17 * 2.56 };
  const m = land.forBBox(view, 0.05);
  assert.equal(m.resolutionDeg, 0.01);
  // The overlay lattice samples the edges themselves (overlays.ts lattice): open water there, not "outside the raster".
  assert.equal(m.isLand(view.east, view.north), false, 'north-east corner');
  assert.equal(m.isLand(-70.5, view.north), false, 'north edge');
  assert.equal(m.isLand(view.east, 41.5), false, 'east edge');
  assert.ok(m.isLand(-70.5, 41.5), 'the island inside is still land');
});

test('OnDemandLand: rasters saved on disk are reused by a new instance, identical to a fresh build', () => {
  const file = fixture();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-landcache-'));
  const view = { west: -72, south: 40, east: -69, north: 43 };
  const a = new OnDemandLand(coastOf([file]), { cacheDir });
  const built = a.forBBox(view, 0.05);
  assert.equal(a.stats().builds, 1);
  assert.equal(a.stats().disk_writes, 1);
  assert.equal(a.stats().disk.files, 1);
  // A new instance (as after a restart) reads it back instead of rasterising.
  const b = new OnDemandLand(coastOf([file]), { cacheDir });
  const loaded = b.forBBox(view, 0.05);
  assert.equal(b.stats().builds, 0);
  assert.equal(b.stats().disk_hits, 1);
  assert.equal(loaded.resolutionDeg, built.resolutionDeg);
  assert.deepEqual(loaded.bbox, built.bbox);
  assert.deepEqual(loaded.serializeRaster().raster, built.serializeRaster().raster);
  // A changed coastline file gets a different folder: nothing stale is reused.
  fs.appendFileSync(file, Buffer.alloc(0));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  const c = new OnDemandLand(coastOf([file]), { cacheDir });
  c.forBBox(view, 0.05);
  assert.equal(c.stats().builds, 1);
  assert.equal(c.stats().disk_hits, 0);
  // The disk budget prunes least recently used rasters.
  const pruneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-landcache-'));
  const d = new OnDemandLand(coastOf([file]), { cacheDir: pruneDir, diskBudgetBytes: 1 });
  for (let i = 0; i < 15; i++) d.forBBox({ west: -170 + i * 20, south: 0, east: -165 + i * 20, north: 5 }, 0.05);
  assert.equal(d.stats().disk.files, 15, 'no prune before the 16th write');
  d.forBBox({ west: 150, south: 0, east: 155, north: 5 }, 0.05); // 16th write → prune to the 1-byte budget
  assert.equal(d.stats().disk_writes, 16);
  assert.equal(d.stats().disk.files, 0);
});

test('overlay land resolution respects the cell budget and snapping is outward', () => {
  assert.equal(chooseOverlayResolution({ west: -80, south: 20, east: -40, north: 60 }, 0.2, 4_000_000), 0.05);
  // A whole-world request at fine spacing is coarsened to fit.
  const r = chooseOverlayResolution({ west: -180, south: -90, east: 180, north: 90 }, 0.02, 4_000_000);
  assert.ok(Math.ceil(360 / r) * Math.ceil(180 / r) <= 4_000_000);
  const b = snapBBox({ west: -71.3, south: 41.2, east: -70.1, north: 42.9 }, 0.01);
  assert.ok(b.west <= -71.3 && b.east >= -70.1 && b.south <= 41.2 && b.north >= 42.9);
  const w = snapBBox({ west: 175, south: -5, east: -175, north: 5 }, 0.01);
  assert.ok(w.west <= 175 && w.west > 170 && w.east >= -175 && w.east < -170);
});

// Point WRP_GSHHG_SHP at a GSHHG full-resolution L1 shapefile
// (GSHHS_shp/f/GSHHS_f_L1.shp) to run this; skipped otherwise.
const GSHHG = process.env.WRP_GSHHG_SHP ?? '';
test(
  'real GSHHG full resolution: indexed read equals the full scan; viewport build time',
  { skip: !(GSHHG && fs.existsSync(GSHHG)) && 'WRP_GSHHG_SHP not set' },
  () => {
    const b = { west: -75, south: 36, east: -65, north: 45 };
    let t = Date.now();
    const scan = readShapefilePolygons(GSHHG, b);
    const scanMs = Date.now() - t;
    t = Date.now();
    const ix = ShapefileIndex.open(GSHHG);
    const indexMs = Date.now() - t;
    t = Date.now();
    const read = ix.read(b);
    const readMs = Date.now() - t;
    assert.deepEqual(
      read.map(s => s.recordNumber),
      scan.map(s => s.recordNumber)
    );
    // Byte-level point test agrees with pointInShape on the decoded records.
    const pts: [number, number][] = [
      [-70.62, 41.39],
      [-70.5, 41.3],
      [-72, 42.3],
      [-69, 40],
      [-70.06, 41.28],
      [-76.3, 38.0],
      [-74.0, 40.7],
      [-66.5, 44.5],
    ];
    for (const [lon, lat] of pts) {
      const exact = ix.containing(lon, lat).some(s => pointInShape(s, lon, lat));
      assert.equal(ix.containsPoint(lon, lat), exact, `${lon},${lat}`);
    }
    assert.equal(ix.containsPoint(-72, 42.3), true, 'inland Massachusetts');
    assert.equal(ix.containsPoint(-69, 40), false, 'open Atlantic');
    console.log(
      `GSHHG f L1: index ${ix.count} records in ${indexMs} ms (${(ix.bytes() / 1e6).toFixed(1)} MB); bbox read ${readMs} ms indexed vs ${scanMs} ms full scan`
    );
  }
);

test('GSHHG L1 configuration expands all levels for indexed points, streamed rasters and exact masks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-hierarchy-'));
  try {
    for (let level = 1; level <= 4; level++) {
      const lo = level,
        hi = 10 - level;
      writeShp(path.join(dir, `GSHHS_f_L${level}.shp`), [
        [
          [
            [lo, lo],
            [hi, lo],
            [hi, hi],
            [lo, hi],
            [lo, lo],
          ],
        ],
      ]);
    }
    const files = [path.join(dir, 'GSHHS_f_L1.shp')];
    const coast = coastOf(files);
    const land = new OnDemandLand(coast);
    const mask = LandMask.fromCoastline(coast, { west: 0, south: 0, east: 10, north: 10 }, { resolutionDeg: 0.1 });
    const raster = land.forBBox({ west: 0, south: 0, east: 10, north: 10 }, 0.4);
    const cachedMask = LandMask.fromCoastline(coast, { west: 0, south: 0, east: 10, north: 10 }, { resolutionDeg: 0.1 });
    for (const [x, expected] of [
      [1.5, true],
      [2.5, false],
      [3.5, true],
      [5, false],
    ] as const) {
      assert.equal(land.isLandAt(x, x), expected);
      assert.equal(mask.isLandExact(x, x), expected);
      assert.equal(cachedMask.isLandPolygons(x, x), expected);
      assert.equal(raster.isLand(x, x), expected);
    }
    fs.unlinkSync(path.join(dir, 'GSHHS_f_L2.shp'));
    assert.throws(() => coastOf(files), /Incomplete GSHHG hierarchy/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A coastline whose records cross tile borders everywhere: the fixture's squares (edges on tile borders, a lake, the
 * antimeridian) plus an irregular star and a thin slanted sliver over several tiles, at levels 1–2 (an island in a
 * lake in land).
 */
function crossingFixture(): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-crossing-'));
  const star: number[][] = [];
  for (let k = 0; k < 23; k++) {
    const a = (k / 23) * 2 * Math.PI;
    const r = k % 2 ? 0.61 + 0.07 * Math.sin(5 * k) : 1.73 + 0.11 * Math.cos(3 * k);
    star.push([-70.13 + r * Math.cos(a), 41.27 + r * Math.sin(a)]);
  }
  star.push(star[0]);
  const sliver = [
    [5.01, 44.03],
    [7.47, 45.98],
    [7.49, 45.97],
    [5.03, 44.01],
    [5.01, 44.03],
  ];
  const l1 = path.join(dir, 'GSHHS_f_L1.shp');
  writeShp(l1, [[star], [sliver], [sq(10, 50, 12, 52)], [sq(179.3, -10.2, 180, -8.9)], [sq(-180, -10.2, -179.4, -8.9)]]);
  writeShp(path.join(dir, 'GSHHS_f_L2.shp'), [[sq(10.33, 50.27, 11.71, 51.62)]]);
  writeShp(path.join(dir, 'GSHHS_f_L3.shp'), [[sq(10.8, 50.8, 11.2, 51.2)]]);
  writeShp(path.join(dir, 'GSHHS_f_L4.shp'), [[sq(10.9, 50.9, 11.0, 51.0)]]);
  return [l1];
}

/** Today's way: every record of every level whose box meets `b`, read whole. */
function recordsIn(files: string[], b: { west: number; south: number; east: number; north: number }): ShapePolygon[] {
  const dir = path.dirname(files[0]);
  return [1, 2, 3, 4].flatMap(l => readShapefilePolygons(path.join(dir, `GSHHS_f_L${l}.shp`), b));
}

test('coastline tiles: rasters equal rasterising the whole records, conservative and centre-sampled', () => {
  const files = crossingFixture();
  const coast = coastOf(files);
  for (const [b, res] of [
    [{ west: -72.5, south: 39.0, east: -67.5, north: 43.5 }, 0.01],
    [{ west: -71.23, south: 40.11, east: -69.07, north: 42.93 }, 0.005],
    [{ west: 4.5, south: 43.5, east: 8.0, north: 46.5 }, 0.002],
    [{ west: 9.5, south: 49.5, east: 12.5, north: 52.5 }, 0.01],
    [{ west: 178.5, south: -11, east: -178.5, north: -8 }, 0.01],
  ] as const) {
    for (const edgeCells of [true, false]) {
      const whole = LandMask.rasterStreamed(b, res, add => recordsIn(files, b).forEach(add), { edgeCells });
      const tiled = LandMask.rasterStreamed(b, res, add => coast.forEach(b, add), { edgeCells });
      assert.deepEqual(tiled.raster, whole.raster, `${JSON.stringify(b)} at ${res}, edge cells ${edgeCells}`);
      assert.ok(whole.landFraction() > 0);
    }
  }
});

test('coastline tiles: the raster drawn from the bytes equals the one drawn from the decoded pieces', () => {
  const files = crossingFixture();
  const coast = coastOf(files);
  for (const [b, res] of [
    [{ west: -72.5, south: 39.0, east: -67.5, north: 43.5 }, 0.01],
    [{ west: -71.23, south: 40.11, east: -69.07, north: 42.93 }, 0.005],
    [{ west: 4.5, south: 43.5, east: 8.0, north: 46.5 }, 0.002],
    [{ west: 9.5, south: 49.5, east: 12.5, north: 52.5 }, 0.01],
    [{ west: 178.5, south: -11, east: -178.5, north: -8 }, 0.01],
    [{ west: -180, south: -90, east: 180, north: 90 }, 0.25],
  ] as const) {
    for (const edgeCells of [true, false]) {
      const decoded = LandMask.rasterStreamed(b, res, add => coast.forEach(b, add), { edgeCells });
      const raw = rasterFromTiles(coast, b, res, { edgeCells });
      assert.deepEqual(raw.mask.raster, decoded.raster, `${JSON.stringify(b)} at ${res}, edge cells ${edgeCells}`);
      assert.equal(raw.mask.nx, decoded.nx);
    }
  }
  // An explicit size, as the water grid build asks for.
  const b = { west: 9.5, south: 49.5, east: 12.5, north: 52.5 };
  const decoded = LandMask.rasterStreamed(b, 0.01, add => coast.forEach(b, add), { edgeCells: false, nx: 310, ny: 305 });
  const raw = rasterFromTiles(coast, b, 0.01, { edgeCells: false, nx: 310, ny: 305 });
  assert.deepEqual(raw.mask.raster, decoded.raster);
  assert.deepEqual([raw.mask.nx, raw.mask.ny], [310, 305]);
});

test('coastline tiles: a piece with more crossing edges than the scratch holds draws as the decoded one', () => {
  // A star of 40000 points inside one tile: most of its zig-zag edges cross a scanline at 0.005°, more than the
  // 1 << 14 edges rasterFromTiles first allocates for, so the edge arrays grow while the piece is being drawn.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-bigpiece-'));
  const file = path.join(dir, 'land.shp');
  const star: number[][] = [];
  const n = 40000;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * 2 * Math.PI;
    const r = k % 2 ? 0.1 : 0.2;
    star.push([10.25 + r * Math.cos(a), 50.25 + r * Math.sin(a)]);
  }
  star.push(star[0]);
  writeShp(file, [[star]]);
  const coast = coastOf([file]);
  const b = { west: 10, south: 50, east: 10.5, north: 50.5 };
  for (const edgeCells of [true, false]) {
    const decoded = LandMask.rasterStreamed(b, 0.005, add => coast.forEach(b, add), { edgeCells });
    const raw = rasterFromTiles(coast, b, 0.005, { edgeCells });
    let differ = 0;
    for (let i = 0; i < decoded.raster.length; i++) if (raw.mask.raster[i] !== decoded.raster[i]) differ++;
    assert.equal(differ, 0, `cells differing, edge cells ${edgeCells}`);
    assert.ok(decoded.landFraction() > 0);
  }
});

test('coastline tiles: exact tests equal the whole records, on tile borders too', () => {
  const files = crossingFixture();
  const coast = coastOf(files);
  let seed = 11;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (const [b, res] of [
    [{ west: -72.5, south: 39.0, east: -67.5, north: 43.5 }, 0.01],
    [{ west: 9.5, south: 49.5, east: 12.5, north: 52.5 }, 0.01],
    [{ west: 4.5, south: 43.5, east: 8.0, north: 46.5 }, 0.005],
  ] as const) {
    const whole = LandMask.fromPolygons(recordsIn(files, b), b, res);
    const tiled = LandMask.fromCoastline(coast, b, { resolutionDeg: res, bufferDeg: 0 });
    const w = b.east - b.west;
    const h = b.north - b.south;
    // Random points, and points exactly on tile borders (columns and rows of the 0.5° grid).
    const pts: [number, number][] = [];
    for (let k = 0; k < 4000; k++) pts.push([b.west + rnd() * w, b.south + rnd() * h]);
    for (let k = 0; k < 1500; k++) {
      const x = Math.ceil(b.west / COAST_TILE_DEG) * COAST_TILE_DEG + Math.floor(rnd() * (w / COAST_TILE_DEG)) * COAST_TILE_DEG;
      const y = Math.ceil(b.south / COAST_TILE_DEG) * COAST_TILE_DEG + Math.floor(rnd() * (h / COAST_TILE_DEG)) * COAST_TILE_DEG;
      pts.push([x, b.south + rnd() * h], [b.west + rnd() * w, y], [x, y]);
    }
    for (const [lon, lat] of pts) {
      assert.equal(tiled.isLandPolygons(lon, lat), whole.isLandPolygons(lon, lat), `isLandPolygons ${lon},${lat}`);
      assert.equal(tiled.isLandExact(lon, lat), whole.isLandExact(lon, lat), `isLandExact ${lon},${lat}`);
      assert.equal(coast.containsPoint(lon, lat), whole.isLandPolygons(lon, lat), `containsPoint ${lon},${lat}`);
    }
    // Legs of every length, many across tile borders; with and without a keep-off distance.
    const wb = whole.withBuffer(300);
    const tb = tiled.withBuffer(300);
    for (let k = 0; k < 3000; k++) {
      const a: [number, number] = [b.west + 0.05 + rnd() * (w - 0.1), b.south + 0.05 + rnd() * (h - 0.1)];
      const len = rnd() < 0.5 ? 0.02 + rnd() * 0.1 : 0.3 + rnd() * 1.2;
      const ang = rnd() * 2 * Math.PI;
      const e: [number, number] = [
        Math.min(b.east - 0.05, Math.max(b.west + 0.05, a[0] + len * Math.cos(ang))),
        Math.min(b.north - 0.05, Math.max(b.south + 0.05, a[1] + len * Math.sin(ang))),
      ];
      assert.equal(tiled.legCrossesLandExact(...a, ...e), whole.legCrossesLandExact(...a, ...e), `leg ${a} → ${e}`);
      assert.equal(tb.legCrossesLandExact(...a, ...e), wb.legCrossesLandExact(...a, ...e), `buffered leg ${a} → ${e}`);
      assert.equal(tb.isLandExact(...a), wb.isLandExact(...a), `buffered point ${a}`);
    }
  }
});

test('coastline tiles: the point test matches the byte-level record test, antimeridian included', () => {
  const file = fixture();
  const coast = coastOf([file]);
  const ix = ShapefileIndex.open(file);
  for (const [lon, lat] of [
    [-70.5, 41.5],
    [-71.5, 41.5],
    [10.2, 50.2],
    [10.7, 50.7],
    [179.5, -9.5],
    [-179.5, -9.5],
    [180, -9.5],
    [-180, -9.5],
    [0, 0],
    [-70.5 + 360, 41.5],
  ] as const) {
    const l = ((((lon + 180) % 360) + 360) % 360) - 180;
    assert.equal(coast.containsPoint(lon, lat), ix.containsPoint(l, lat), `${lon},${lat}`);
  }
  // Only the tiles near a box are read; a box out at sea reads none.
  const before = coast.cacheStats().decodes;
  assert.equal(coast.read({ west: -40, south: 10, east: -39, north: 11 }).length, 0);
  assert.equal(coast.cacheStats().decodes, before);
});

test('shorelinePaths keeps the case of the .shp suffix when it adds levels 2–4', async () => {
  const { shorelinePaths } = await import('./shapefile');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-gshhs-'));
  for (let l = 1; l <= 4; l++) fs.writeFileSync(path.join(dir, `GSHHS_f_L${l}.SHP`), '');
  const out = shorelinePaths([path.join(dir, 'GSHHS_f_L1.SHP')]);
  assert.deepEqual(
    out.map(f => path.basename(f)),
    ['GSHHS_f_L1.SHP', 'GSHHS_f_L2.SHP', 'GSHHS_f_L3.SHP', 'GSHHS_f_L4.SHP']
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
