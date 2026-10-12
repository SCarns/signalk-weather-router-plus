/**
 * The chart mesh as the router's land (land.ts): points, straight moves,
 * the bulk form, the index, and depth at a contour corner.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeshLand } from './land';
import { PagedMesh } from './paged';
import { FLAG_OPENING_BRIDGE, fromMeshXY, type LoadedMesh, M_PER_DEG_MESH, NO_HAZARD, NO_VALUE } from './store';

/**
 * A W × H grid of unit squares (side `side` metres), each split on its
 * rising diagonal into a lower triangle (id (cy*W+cx)*2) and an upper one
 * (+1), with neighbours and reverse edges, in the metres frame with cl = 1.
 */
function gridMesh(W: number, H: number, side: number): LoadedMesh {
  const n = W * H * 2;
  const m: LoadedMesh = {
    n,
    x: new Float64Array(n * 3),
    y: new Float64Array(n * 3),
    cl: 1,
    neighbours: new Int32Array(n * 3).fill(-1),
    rev: new Int8Array(n * 3).fill(-1),
    mult: new Float32Array(n).fill(1),
    depth: new Float32Array(n).fill(NO_VALUE),
    clear: new Float32Array(n).fill(NO_VALUE),
    hazv: new Float32Array(n).fill(NO_HAZARD),
    flags: new Uint8Array(n),
    tiles: [],
  };
  const lower = (cx: number, cy: number): number => (cy * W + cx) * 2;
  const upper = (cx: number, cy: number): number => (cy * W + cx) * 2 + 1;
  const set = (t: number, pts: [number, number][]): void => {
    for (let k = 0; k < 3; k++) {
      m.x[t * 3 + k] = pts[k][0] * side;
      m.y[t * 3 + k] = pts[k][1] * side;
    }
  };
  const link = (a: number, ka: number, b: number, kb: number): void => {
    m.neighbours[a * 3 + ka] = b;
    m.rev[a * 3 + ka] = kb;
    m.neighbours[b * 3 + kb] = a;
    m.rev[b * 3 + kb] = ka;
  };
  for (let cy = 0; cy < H; cy++)
    for (let cx = 0; cx < W; cx++) {
      const lo = lower(cx, cy);
      const up = upper(cx, cy);
      set(lo, [
        [cx, cy],
        [cx + 1, cy],
        [cx + 1, cy + 1],
      ]);
      set(up, [
        [cx, cy],
        [cx + 1, cy + 1],
        [cx, cy + 1],
      ]);
      link(lo, 2, up, 0);
      if (cx > 0) link(up, 2, lower(cx - 1, cy), 1);
      if (cy > 0) link(lo, 0, upper(cx, cy - 1), 1);
    }
  return m;
}

/** lon/lat of a point given in grid units. */
function ll(m: LoadedMesh, gx: number, gy: number, side: number): [number, number] {
  return fromMeshXY(m, gx * side, gy * side);
}

test('MeshLand: points and moves against blocked triangles, the mesh edge, and the index', () => {
  // 10 × 10 squares of 100 m; column 5 (both triangles of every square) blocked: a wall from y = 0 to 10,
  // except the square at row 7, which is open (a 100 m gap).
  const side = 100;
  const m = gridMesh(10, 10, side);
  const blocked = new Uint8Array(m.n);
  for (let cy = 0; cy < 10; cy++) {
    if (cy === 7) continue;
    blocked[(cy * 10 + 5) * 2] = 1;
    blocked[(cy * 10 + 5) * 2 + 1] = 1;
  }
  const land = new MeshLand(PagedMesh.fromLoaded(m, blocked, 250));
  // The tile's point index is built on its first lookup.
  assert.equal(land.indexBytes(), 0);
  // Points.
  assert.equal(land.isLand(...ll(m, 2.5, 2.5, side)), false);
  assert.equal(land.isLand(...ll(m, 5.5, 2.5, side)), true, 'in the wall');
  assert.equal(land.isLand(...ll(m, 5.5, 7.5, side)), false, 'in the gap');
  assert.equal(land.isLand(...ll(m, 12, 2, side)), true, 'outside the mesh');
  assert.equal(land.isLandExact(...ll(m, 5.5, 2.5, side)), true);
  assert.ok(land.indexBytes() > 0);
  // Moves.
  const cross = (x0: number, y0: number, x1: number, y1: number): boolean =>
    land.legCrossesLandExact(...ll(m, x0, y0, side), ...ll(m, x1, y1, side));
  assert.equal(cross(2.5, 2.5, 8.5, 2.5), true, 'through the wall');
  assert.equal(cross(2.5, 7.5, 8.5, 7.5), false, 'through the gap');
  assert.equal(cross(2.5, 2.5, 4.5, 2.5), false, 'short of the wall');
  assert.equal(cross(2.5, 2.5, 2.5, 8.5), false, 'along the wall, west of it');
  assert.equal(cross(2.5, 2.5, 4.5, 8.5), false, 'a diagonal west of the wall');
  assert.equal(cross(2.5, 8.5, 8.5, 6.5), false, 'a diagonal that threads the gap');
  assert.equal(cross(2.5, 9.5, 8.5, 3.5), true, 'a diagonal into the wall below the gap');
  assert.equal(cross(2.5, 2.5, 12, 2.5), true, 'off the mesh');
  assert.equal(cross(2.5, 2.5, 2.5, 2.5), false, 'no move');
  // Bulk.
  const a = ll(m, 2.5, 2.5, side);
  const b = ll(m, 8.5, 2.5, side);
  const c = ll(m, 4.5, 2.5, side);
  assert.deepEqual(Array.from(land.legsCrossLandBulk([a[0], a[0]], [a[1], a[1]], [b[0], c[0]], [b[1], c[1]])), [1, 0]);
  // Every triangle is found by the index exactly where store.ts locate would find it (the point's own square).
  for (let cy = 0; cy < 10; cy++)
    for (let cx = 0; cx < 10; cx++) {
      const [px, py] = [(cx + 0.75) * side, (cy + 0.25) * side]; // in the lower triangle
      assert.equal(land.locate(px, py), (cy * 10 + cx) * 2, `lower of ${cx},${cy}`);
      const [qx, qy] = [(cx + 0.25) * side, (cy + 0.75) * side]; // in the upper triangle
      assert.equal(land.locate(qx, qy), (cy * 10 + cx) * 2 + 1, `upper of ${cx},${cy}`);
    }
});

test('MeshLand: depth at a contour corner reports the usable side; a blocked point reports its own triangle when nothing usable holds it', () => {
  const side = 100;
  const m = gridMesh(2, 1, side);
  // Square 0: lower 1.5 m (blocked), upper 8 m; square 1: both 12 m.
  m.depth.set([1.5, 8, 12, 12]);
  const blocked = Uint8Array.of(1, 0, 0, 0);
  const land = new MeshLand(PagedMesh.fromLoaded(m, blocked, 250));
  // On the shared diagonal of square 0: locate (first met) gives the blocked lower triangle; preferUsable gives the upper.
  const [dx, dy] = [50, 50];
  assert.equal(land.locate(dx, dy), 0);
  assert.equal(land.locate(dx, dy, true), 1);
  assert.equal(land.depthAt(...fromMeshXY(m, dx, dy)), 8);
  assert.equal(land.depthAt(...fromMeshXY(m, 75, 25)), 1.5, 'inside the blocked triangle, nothing usable holds the point');
  assert.equal(land.depthAt(...fromMeshXY(m, 150, 50)), 12);
  assert.equal(land.depthAt(...fromMeshXY(m, 500, 500)), null, 'outside the mesh');
  m.depth[2] = NO_VALUE;
  assert.equal(land.depthAt(...fromMeshXY(m, 175, 25)), null, 'no charted depth');
  // A move that starts on the contour and runs into the usable side is clear; one into the blocked side is not.
  const a = fromMeshXY(m, dx, dy);
  const up = fromMeshXY(m, 25, 75);
  const down = fromMeshXY(m, 75, 25);
  assert.equal(land.legCrossesLandExact(a[0], a[1], up[0], up[1]), false);
  assert.equal(land.legCrossesLandExact(a[0], a[1], down[0], down[1]), true);
  void M_PER_DEG_MESH;
});

test('MeshLand: the opening bridges a move passes under, one per bridge, with the charted open clearance', () => {
  const side = 100;
  const m = gridMesh(10, 3, side);
  // A bridge over column 3 (both triangles, all rows) with 30 m open clearance, and one over column 7 with none charted.
  for (let cy = 0; cy < 3; cy++)
    for (const cx of [3, 7])
      for (const t of [(cy * 10 + cx) * 2, (cy * 10 + cx) * 2 + 1]) {
        m.flags[t] |= FLAG_OPENING_BRIDGE;
        m.clear[t] = cx === 3 ? 30 : NO_VALUE;
      }
  const land = new MeshLand(PagedMesh.fromLoaded(m, new Uint8Array(m.n), 250));
  const a = fromMeshXY(m, 0.5 * side, 1.5 * side);
  const b = fromMeshXY(m, 9.5 * side, 1.5 * side);
  const found = land.openingBridgesAlong(a[0], a[1], b[0], b[1]);
  assert.equal(found.length, 2, JSON.stringify(found));
  assert.equal(found[0].clearM, 30);
  assert.equal(found[1].clearM, null);
  assert.ok(found[0].lon < found[1].lon, 'in order along the move');
  // A move that stops short of the second bridge sees one; one entirely in open water sees none.
  const c = fromMeshXY(m, 5.5 * side, 1.5 * side);
  assert.equal(land.openingBridgesAlong(a[0], a[1], c[0], c[1]).length, 1);
  const d = fromMeshXY(m, 0.5 * side, 2.5 * side);
  const e = fromMeshXY(m, 1.5 * side, 2.5 * side);
  assert.equal(land.openingBridgesAlong(d[0], d[1], e[0], e[1]).length, 0);
});

test('MeshLand: moves from a corner or an edge of blocked water, along its edge, and through its corner', () => {
  // 10 × 10 squares of 100 m; the square (5, 5) blocked (both its triangles). Its corners are shared by up to six
  // triangles: a move from one enters the triangle its direction goes into.
  const side = 100;
  const m = gridMesh(10, 10, side);
  const blocked = new Uint8Array(m.n);
  blocked[(5 * 10 + 5) * 2] = 1;
  blocked[(5 * 10 + 5) * 2 + 1] = 1;
  const land = new MeshLand(PagedMesh.fromLoaded(m, blocked, 250));
  const cross = (x0: number, y0: number, x1: number, y1: number): boolean =>
    land.legCrossesLandExact(...ll(m, x0, y0, side), ...ll(m, x1, y1, side));
  // From each corner of the blocked square: away from it clear, into it not.
  assert.equal(cross(5, 5, 4, 4), false, 'from the lower-left corner, away');
  assert.equal(cross(5, 5, 5.5, 5.5), true, 'from the lower-left corner, into the square');
  assert.equal(cross(6, 6, 7, 7), false, 'from the upper-right corner, away');
  assert.equal(cross(6, 5, 7, 4), false, 'from the lower-right corner, away');
  assert.equal(cross(5, 6, 4, 6.5), false, 'from the upper-left corner, away');
  // Along its edges: touching blocked water is not crossing it.
  assert.equal(cross(5, 5, 5, 7), false, 'up its left edge and on');
  assert.equal(cross(3, 5, 8, 5), false, 'along its bottom edge');
  // From a point on its edge: out clear, in not.
  assert.equal(cross(5, 5.5, 4, 5.5), false, 'from its left edge, out');
  assert.equal(cross(5, 5.5, 6, 5.5), true, 'from its left edge, in');
  // Through its corner: touching only the corner is clear; through the corner into it is not.
  assert.equal(cross(3, 7, 7, 3), false, 'through the corner (5, 5) diagonally past the square');
  assert.equal(cross(3, 3, 7, 7), true, 'through the corner (5, 5) into the square');
  // Every triangle the walk reports along a move past the corner is usable (the depth check's walk).
  const [ax, ay] = [3 * side, 7 * side];
  const [bx, by] = [7 * side, 3 * side];
  land.forEachTriangleAlong(ax, ay, bx, by, t => assert.equal(blocked[t], 0, `triangle ${t} reported`));
});

test('MeshLand: a move exactly along an edge between usable and blocked water, through a lon/lat round trip, is clear', () => {
  // The lower triangle of square (5, 5) blocked, its upper one usable: they share the square's diagonal (5, 5)–(6, 6).
  // A mesh route hugging blocked water runs corner to corner along such edges; its points come back from lon/lat, so
  // the direction is a hair off the edge and must still count as along it. Real-scale coordinates (a leg frame at
  // about 40° N, 70° W) and irregular square sizes leave the noise real routes carry: the walk before this rule
  // rejected 187 of these 600 moves.
  let checked = 0;
  for (let k = 0; k < 200; k++) {
    const side = 20 + k * 1.37;
    const m = gridMesh(10, 10, side);
    const [x0, y0] = [-7.3e6, 4.6e6];
    for (let q = 0; q < m.n * 3; q++) {
      m.x[q] += x0;
      m.y[q] += y0;
    }
    m.cl = Math.cos(((40 + k * 0.01) * Math.PI) / 180);
    const blocked = new Uint8Array(m.n);
    blocked[(5 * 10 + 5) * 2] = 1;
    const land = new MeshLand(PagedMesh.fromLoaded(m, blocked, 250));
    const at = (gx: number, gy: number): [number, number] => fromMeshXY(m, x0 + gx * side, y0 + gy * side);
    const cross = (a: [number, number], b: [number, number]): boolean => land.legCrossesLandExact(...at(...a), ...at(...b));
    assert.equal(cross([5, 5], [6, 6]), false, `side ${side}: along the diagonal, corner to corner`);
    assert.equal(cross([6, 6], [5, 5]), false, `side ${side}: back along it`);
    assert.equal(cross([4, 4], [7, 7]), false, `side ${side}: through it from corner to corner beyond`);
    assert.equal(cross([5, 5], [6, 5.5]), true, `side ${side}: off the edge into the blocked triangle`);
    checked += 4;
  }
  assert.equal(checked, 800);
});

test('a point snapped to the nearest usable water, handed on as lon/lat, is found in usable water', () => {
  // The lower triangle of square (5, 5) blocked: from a point inside it, the nearest usable water is a point on the
  // diagonal it shares with the usable upper triangle. That point goes on as lon/lat (the snapped stop); found again,
  // it must lie in usable water, and a move from it into the usable side must be clear. Real-scale coordinates.
  for (let k = 0; k < 200; k++) {
    const side = 20 + k * 1.37;
    const m = gridMesh(10, 10, side);
    const [x0, y0] = [-7.3e6, 4.6e6];
    for (let q = 0; q < m.n * 3; q++) {
      m.x[q] += x0;
      m.y[q] += y0;
    }
    m.cl = Math.cos(((27 + k * 0.01) * Math.PI) / 180);
    const blocked = new Uint8Array(m.n);
    blocked[(5 * 10 + 5) * 2] = 1;
    const pm = PagedMesh.fromLoaded(m, blocked, 250);
    const land = new MeshLand(pm);
    // (5.6, 5.45): nearer the diagonal (0.11 of a side) than the square's bottom (0.45) or right (0.4) edge.
    const nu = pm.nearestUsable(x0 + 5.6 * side, y0 + 5.45 * side)!;
    assert.ok(nu.distM > 0, 'moved out of the blocked triangle');
    assert.equal(nu.tri, (5 * 10 + 5) * 2 + 1, 'onto the diagonal, in the upper triangle');
    const [lon, lat] = pm.fromXY(nu.x, nu.y);
    assert.equal(land.isLand(lon, lat), false, `side ${side}: the snapped point is usable water`);
    const t = land.triangleAt(lon, lat, true);
    assert.equal(blocked[t], 0, `side ${side}: found in a usable triangle`);
    const [ul, ua] = pm.fromXY(x0 + 5.2 * side, y0 + 5.8 * side);
    assert.equal(land.legCrossesLandExact(lon, lat, ul, ua), false, `side ${side}: a move into the usable side is clear`);
  }
});
