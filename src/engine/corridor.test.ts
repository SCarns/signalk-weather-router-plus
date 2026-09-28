import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LandMask } from '../geo/landmask';
import { WaterGrid } from '../geo/watergrid';
import { buildWaterGrid } from '../geo/watergrid_build';
import { gridAstar, GridAstarError, smoothGridPath, gridLineOfSight } from './gridastar';
import { planCorridor, mergeVias, widthProfile, CorridorError, type AutoVia } from './corridor';
import { OceanPropagator } from './propagator';
import { makeVessel } from '../vessel/vessel';

// ---------------------------------------------------------------------
// Synthetic polygon shapefile writer (ESRI .shp, shape type 5).

function writeShapefile(file: string, polys: number[][][]): void {
  const recs: Buffer[] = [];
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  polys.forEach((rings, k) => {
    const pts = rings.flatMap((r) => { const c = [...r]; if (c[0] !== c[c.length - 2] || c[1] !== c[c.length - 1]) c.push(c[0], c[1]); return [c]; });
    const nPts = pts.reduce((a, r) => a + r.length / 2, 0);
    const len = 44 + 4 * pts.length + 16 * nPts;
    const b = Buffer.alloc(8 + len);
    b.writeInt32BE(k + 1, 0);
    b.writeInt32BE(len / 2, 4);
    const xs = pts.flatMap((r) => r.filter((_v, i) => i % 2 === 0));
    const ys = pts.flatMap((r) => r.filter((_v, i) => i % 2 === 1));
    const bx = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    minX = Math.min(minX, bx[0]); minY = Math.min(minY, bx[1]); maxX = Math.max(maxX, bx[2]); maxY = Math.max(maxY, bx[3]);
    b.writeInt32LE(5, 8);
    bx.forEach((v, i) => b.writeDoubleLE(v, 12 + 8 * i));
    b.writeInt32LE(pts.length, 44);
    b.writeInt32LE(nPts, 48);
    let o = 52;
    let start = 0;
    for (const r of pts) { b.writeInt32LE(start, o); o += 4; start += r.length / 2; }
    for (const r of pts) for (let i = 0; i < r.length; i += 2) { b.writeDoubleLE(r[i], o); b.writeDoubleLE(r[i + 1], o + 8); o += 16; }
    recs.push(b);
  });
  const body = Buffer.concat(recs);
  const h = Buffer.alloc(100);
  h.writeInt32BE(9994, 0);
  h.writeInt32BE((100 + body.length) / 2, 24);
  h.writeInt32LE(1000, 28);
  h.writeInt32LE(5, 32);
  [minX, minY, maxX, maxY].forEach((v, i) => h.writeDoubleLE(v, 36 + 8 * i));
  fs.writeFileSync(file, Buffer.concat([h, body]));
}

const rect = (w: number, s: number, e: number, n: number): number[][] => [[w, s, e, s, e, n, w, n]];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-grid-'));
const SHP = path.join(tmp, 'synthetic.shp');
// Tile borders: a 0.02°-wide north–south channel centred on lon 170 (a tile
// column border) crossing lat 0 (a tile row border), cut through a land block.
// Antimeridian: a 0.02°-wide channel straddling lon 180 through a land block.
// A "boom": a 0.0002°-thin land line across a second channel (lon 172.5),
// invisible at the grid's centre sampling but land on any conservative raster.
// A closed block: solid land at lat 20..30, lon 160..165.
writeShapefile(SHP, [
  rect(165, -5, 169.99, 5), rect(170.01, -5, 175, 5),
  rect(179, 20, 179.99, 30), rect(-179.99, 20, -179, 30),
  rect(160, 20, 165, 30),
]);
// Boom scenario: a wide, shallow (north–south) land block with two short
// channels, at lon 165 (open) and lon 172.5 (crossed by the boom).
const SHP2 = path.join(tmp, 'boom.shp');
writeShapefile(SHP2, [
  rect(160.5, -0.5, 164.99, 0.5), rect(165.01, -0.5, 172.49, 0.5), rect(172.51, -0.5, 180, 0.5),
  rect(172.49, 0.0, 172.51, 0.0002),
]);
const region = { west: 160, east: -170, south: -10, north: 40 };
let gridCache: WaterGrid | null = null;
function grid(): WaterGrid {
  if (!gridCache) gridCache = buildWaterGrid([SHP], { region });
  return gridCache;
}

/** Component-aware flood inside a lon/lat box (antimeridian-safe). */
function connectedIn(g: WaterGrid, a: [number, number], b: [number, number], box: { west: number; east: number; south: number; north: number }): boolean {
  const [r1, c1] = g.cellOf(a[0], a[1]);
  const [r2, c2] = g.cellOf(b[0], b[1]);
  const inBox = (r: number, c: number): boolean => {
    const [lon, lat] = g.cellCentre(r, c);
    const off = ((lon - box.west) % 360 + 360) % 360;
    const w = ((box.east - box.west) % 360 + 360) % 360;
    return lat >= box.south && lat <= box.north && off <= w;
  };
  const seen = new Set<number>();
  const st: [number, number, number][] = [];
  for (const comp of g.nodeComponents(r1, c1)) { st.push([r1, c1, comp]); seen.add((r1 * g.nx + c1) * 16 + comp); }
  while (st.length) {
    const [r, c, comp] = st.pop()!;
    if (r === r2 && g.wrapCol(c) === c2) return true;
    g.neighbours(r, c, comp, (dr, dc, comp2) => {
      const rr = r + dr; const cc = g.wrapCol(c + dc);
      if (!inBox(rr, cc)) return;
      const k = (rr * g.nx + cc) * 16 + comp2;
      if (seen.has(k)) return;
      seen.add(k); st.push([rr, cc, comp2]);
    });
  }
  return false;
}

test('build: a channel on a tile column border crossing a tile row border stays open', () => {
  const g = grid();
  // Around the land block is excluded by the box (it spans lon 165..175).
  const box = { west: 166, east: 174, south: -7, north: 7 };
  assert.ok(connectedIn(g, [170, -6], [170, 6], box), 'north–south through the channel');
  // The channel's cells on both sides of lon 170 are linked across the tile column border.
  const [r, cW] = g.cellOf(169.99, 0.5);
  assert.ok(g.isWater(r, cW) && g.isWater(r, cW + 1));
  assert.ok(g.eastOpen(r, cW), 'east edge across the tile border at lon 170');
  // Row border at lat 0: the north edge of the row just below is open inside the channel.
  const [r0, c0] = g.cellOf(169.995, -0.01);
  assert.ok(g.northOpen(r0, c0), 'north edge across the tile border at lat 0');
  // Solid block: no way through (box excludes the way round).
  assert.ok(!connectedIn(g, [162.5, 19], [162.5, 31], { west: 160.5, east: 164.5, south: 18, north: 32 }));
});

test('build: a channel straddling the antimeridian is open across it', () => {
  const g = grid();
  const box = { west: 179.5, east: -179.5, south: 18, north: 32 };
  assert.ok(connectedIn(g, [180, 19], [-180, 31], box), 'north–south through the antimeridian channel');
  const [r, cLast] = g.cellOf(179.99, 25);
  assert.equal(cLast, g.nx - 1);
  assert.ok(g.isWater(r, cLast) && g.isWater(r, 0));
  assert.ok(g.eastOpen(r, cLast), 'east edge of the last column wraps to column 0');
  // Without the channel the block would be closed: the blocks either side are land.
  const [rb, cb] = g.cellOf(179.5, 25);
  assert.ok(!g.isWater(rb, cb));
});

// ---------------------------------------------------------------------
// A* on a synthetic grid

/** Globe of 9° cells (40 × 20); `water(r, c)` decides water; edges open between water cells. */
function syntheticGrid(water: (r: number, c: number) => boolean): WaterGrid {
  const g = WaterGrid.empty(40, 20, 9);
  const set = (p: Uint8Array, i: number): void => { p[i >> 3] |= 1 << (i & 7); };
  for (let r = 0; r < 20; r++) for (let c = 0; c < 40; c++) {
    if (!water(r, c)) continue;
    const i = r * 40 + c;
    set(g.water, i);
    if (water(r, (c + 1) % 40)) set(g.east, i);
    if (r + 1 < 20 && water(r + 1, c)) set(g.north, i);
  }
  return g;
}

test('grid A*: goes through the gap in a wall, respects blocked cells, never cuts land corners', () => {
  // Wall at column 20 with a gap at row 15; everything else water between rows 2..17.
  const g = syntheticGrid((r, c) => r >= 2 && r <= 17 && (c !== 20 || r === 15));
  // Narrower than the globe, so the window does not wrap round the back.
  const win = { r0: 0, r1: 19, c0: 1, c1: 38 };
  const res = gridAstar(g, win, [{ r: 5, c: 10, comp: 0, cost: 0 }], [{ r: 5, c: 30, comp: 0 }], g.cellCentre(5, 30) as [number, number], 0);
  assert.ok(res.path.some((p) => p.c === 20 && p.r === 15), 'through the gap');
  for (let i = 1; i < res.path.length; i++) {
    const a = res.path[i - 1]; const b = res.path[i];
    assert.ok(Math.abs(a.r - b.r) <= 1 && Math.abs(a.c - b.c) <= 1);
    if (a.r !== b.r && a.c !== b.c) {
      assert.ok(g.isWater(a.r, b.c) && g.isWater(b.r, a.c), 'a diagonal step needs both side cells');
    }
  }
  // Block the gap: no path inside the window.
  const blocked = new Set([15 * 40 + 20]);
  assert.throws(() => gridAstar(g, win, [{ r: 5, c: 10, comp: 0, cost: 0 }], [{ r: 5, c: 30, comp: 0 }], g.cellCentre(5, 30) as [number, number], 0, { blocked }),
    (e: unknown) => e instanceof GridAstarError && e.exhausted);
  // Smoothing keeps line of sight and the endpoints.
  const sm = smoothGridPath(g, res.path);
  assert.deepEqual(sm[0], res.path[0]);
  assert.deepEqual(sm[sm.length - 1], res.path[res.path.length - 1]);
  for (let i = 1; i < sm.length; i++) assert.ok(gridLineOfSight(g, sm[i - 1], sm[i]));
  assert.ok(!gridLineOfSight(g, { r: 5, c: 10, comp: 0 }, { r: 5, c: 30, comp: 0 }), 'no sight through the wall');
});

test('grid A*: a full-width window wraps across the antimeridian', () => {
  // Land band from column 5 to 34: the only way from column 3 to column 36 is west across the wrap.
  const g = syntheticGrid((r, c) => r >= 8 && r <= 11 && (c < 5 || c > 34));
  const win = { r0: 0, r1: 19, c0: 0, c1: 39 };
  const res = gridAstar(g, win, [{ r: 9, c: 3, comp: 0, cost: 0 }], [{ r: 9, c: 36, comp: 0 }], g.cellCentre(9, 36) as [number, number], 0);
  const cols = res.path.map((p) => p.c);
  assert.ok(cols.includes(0) && cols.includes(39), 'crosses column 39 → 0');
  assert.ok(res.path.length <= 10, `short way round (${res.path.length} cells)`);
  // Unwrapped window starting west of 0 works too.
  const win2 = { r0: 0, r1: 19, c0: -10, c1: 10 };
  const res2 = gridAstar(g, win2, [{ r: 9, c: 3, comp: 0, cost: 0 }], [{ r: 9, c: -4, comp: 0 }], g.cellCentre(9, 36) as [number, number], 0);
  assert.ok(res2.path.some((p) => p.c < 0));
});

// ---------------------------------------------------------------------
// Corridor planning against the route raster

test('corridor: a passage the base raster closes is refined locally and verified', () => {
  const g = grid();
  const lands: LandMask[] = [];
  const cor = planCorridor(g, [[170, -6], [170, 6]], {
    stages: 20,
    landFor: (b) => { const m = LandMask.fromShapefiles([SHP], b, { resolutionDeg: 0.01 }); lands.push(m); return m; },
  });
  assert.ok(cor.stats.refines >= 1, 'refined at least once');
  assert.ok(cor.land.patches.length >= 1);
  assert.ok(cor.land.patches.every((p) => p.resolutionDeg < 0.01));
  // The skeleton runs through the channel.
  assert.ok(cor.skeleton.some((p) => Math.abs(p.lat) < 0.5 && Math.abs(p.lon - 170) < 0.02));
  // Width profile inside the channel ≈ 0.02° of longitude.
  const mid = cor.skeleton.reduce((best, p, i) => (Math.abs(p.lat) < Math.abs(cor.skeleton[best].lat) ? i : best), 0);
  assert.ok(cor.widthM[mid] > 1000 && cor.widthM[mid] < 3000, `channel width ${cor.widthM[mid]} m`);
  // The route box covers the corridor, not just the endpoints ± 1°.
  assert.ok(cor.bbox.south <= -6 && cor.bbox.north >= 6);
});

test('corridor: a passage closed on the raster even at the finest patch is blocked and routed around', () => {
  const g = buildWaterGrid([SHP2], { region: { west: 160, east: 180, south: -10, north: 10 } });
  // The boom channel at lon 172.5 is open on the grid (the boom is thinner than a fine cell).
  const box = { west: 171.5, east: 173.5, south: -2, north: 2 };
  assert.ok(connectedIn(g, [172.5, -1], [172.5, 1], box), 'grid sees the boom channel as open');
  const messages: string[] = [];
  const cor = planCorridor(g, [[172.5, -1], [172.5, 1]], {
    stages: 20, onProgress: (m) => messages.push(m),
    landFor: (b) => LandMask.fromShapefiles([SHP2], b, { resolutionDeg: 0.002 }),
  });
  assert.ok(cor.stats.reroutes >= 1, `re-routed (${messages.join(' | ')})`);
  // The corridor now crosses the block through the open channel at lon 165, never the boom channel.
  assert.ok(!cor.skeleton.some((p) => Math.abs(p.lat) < 0.4 && Math.abs(p.lon - 172.5) < 0.1));
  assert.ok(cor.skeleton.some((p) => Math.abs(p.lat) < 0.4 && Math.abs(p.lon - 165) < 0.05));
});

test('corridor: a start on land is a fatal error; a missing water path is a corridor error', () => {
  const g = grid();
  // On land 500 m from the channel: found by the exact polygon check.
  assert.throws(() => planCorridor(g, [[169.985, 0], [170, 6]], { stages: 20, landFor: (b) => LandMask.fromShapefiles([SHP], b, { resolutionDeg: 0.01 }) }),
    (e: unknown) => e instanceof CorridorError && e.fatal && /start point .* on land/.test(e.message));
  // Deep inside the solid block: no water within 10 km on the grid (also fatal: no fallback can help).
  assert.throws(() => planCorridor(g, [[162.5, 25], [170, 6]], { stages: 20, landFor: (b) => LandMask.fromShapefiles([SHP], b, { resolutionDeg: 0.01 }) }),
    (e: unknown) => e instanceof CorridorError && e.fatal && /no water within/.test(e.message));
});

test('width profile: an islet on the skeleton is not a narrow passage; a strait is', () => {
  const m = LandMask.fromShapefiles([SHP], { west: 165, east: 175, south: -6, north: 6 }, { resolutionDeg: 0.002 });
  // Along lon 170 through the channel: width ≈ 0.02° · cos(0) · 111 km ≈ 2.2 km.
  const pts = [{ lon: 170, lat: -0.2 }, { lon: 170, lat: 0 }, { lon: 170, lat: 0.2 }];
  const w = widthProfile(m, pts);
  assert.ok(w[1] > 1500 && w[1] < 2600, `strait width ${w[1]}`);
  // Open water far from land: Infinity.
  const w2 = widthProfile(m, [{ lon: 150, lat: 0 }, { lon: 150.1, lat: 0 }]);
  assert.equal(w2[0], Infinity);
});

test("mergeVias puts each segment's automatic vias before the user via ending it", () => {
  const user = [{ lon: 1, lat: 1, radiusM: 500 }];
  const autos: AutoVia[] = [
    { lon: 2, lat: 2, radiusM: 900, widthM: 800, axisDeg: 0, name: 'B', segment: 1, pathIndex: 50 },
    { lon: 0.5, lat: 0.5, radiusM: 900, widthM: 800, axisDeg: 0, name: 'A', segment: 0, pathIndex: 10 },
  ];
  const v = mergeVias(user, autos);
  assert.deepEqual(v.map((x) => x.name ?? 'user'), ['A', 'user', 'B']);
  assert.ok(v[0].auto && !v[1].auto && v[2].auto);
});

test('propagator: automatic vias pull the route through the passage but are not route waypoints', () => {
  const g = grid();
  const cor = planCorridor(g, [[170, -3], [170, 3]], { stages: 12, landFor: (b) => LandMask.fromShapefiles([SHP], b, { resolutionDeg: 0.002 }) });
  const prop = new OceanPropagator(cor.land, { stages: 12 });
  const auto = [{ lon: 170, lat: 0, radiusM: 1500, auto: true, name: 'Test Channel', widthM: 2200 }];
  const msgs: string[] = [];
  const route = prop.computeRoute({
    start: [170, -3], end: [170, 3], departureTime: new Date(0), vessel: makeVessel({ motorSpeedMs: 3 }), modePolicy: 'motor',
    vias: auto, corridor: { skeleton: cor.skeleton, widthM: cor.widthM }, onProgress: (_s, _k, m) => msgs.push(m),
  });
  assert.ok(route.waypoints.every((w) => w.role !== 'via'), 'no waypoint is marked as a user via');
  assert.equal(route.autoVias?.length, 1);
  assert.equal(route.autoVias?.[0].name, 'Test Channel');
  assert.ok(msgs.some((m) => /auto via at Test Channel, width 2\.2 km/.test(m)));
  assert.equal(route.warnings, undefined, 'no leg crosses land');
  // With a user via at the same place the waypoint is marked.
  const r2 = prop.computeRoute({
    start: [170, -3], end: [170, 3], departureTime: new Date(0), vessel: makeVessel({ motorSpeedMs: 3 }), modePolicy: 'motor',
    vias: [{ lon: 170, lat: 0, radiusM: 1500 }], corridor: { skeleton: cor.skeleton, widthM: cor.widthM },
  });
  assert.ok(r2.waypoints.some((w) => w.role === 'via'));
});
