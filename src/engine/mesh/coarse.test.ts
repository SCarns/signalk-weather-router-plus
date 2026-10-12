/**
 * The rough cut (coarse.ts) and the paged mesh search (route.ts searchMesh,
 * paged.ts) on a U-shaped mesh of 1° tiles: two arms, columns 0 and 2, rows
 * 0–3, joined by row 0. A leg from the top of one arm to the top of the
 * other must run down, across and up, far from the box around its ends;
 * the search reads the tiles as it reaches them, with no area given.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { meshAstar } from './astar';
import { buildCoarseMap, coarseRoute, pieceAt, reachOf } from './coarse';
import { writeGridMesh } from './fixture';
import { PagedMesh } from './paged';
import { blockedTriangles, searchMesh } from './route';
import { FLAG_OPENING_BRIDGE, MeshStore } from './store';

const RULES = { draughtM: 2, airDraftM: 18 };
const SEARCH = { ...RULES, motorSpeedMs: 3 };
const U = [
  { i: 0, j: 0 },
  { i: 1, j: 0 },
  { i: 2, j: 0 },
  { i: 0, j: 1 },
  { i: 2, j: 1 },
  { i: 0, j: 2 },
  { i: 2, j: 2 },
  { i: 0, j: 3 },
  { i: 2, j: 3 },
];
const START: [number, number] = [0.5, 3.6];
const END: [number, number] = [2.5, 3.6];

function withMesh(cells: { i: number; j: number; depth?: number; flags?: number }[], fn: (store: MeshStore) => void): void {
  const dir = writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-coarse-')), cells);
  try {
    fn(MeshStore.open(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('rough cut: one piece per water tile, linked across shared tile edges; the blocked tile-boundary triangles recorded', () => {
  withMesh(U, store => {
    const { map, boundary } = buildCoarseMap(store, RULES);
    assert.equal(map.pieces.length, 9);
    assert.equal(map.links.length, 8, JSON.stringify(map.links));
    assert.equal(map.triangles, 18);
    assert.equal(map.tiles.length, 9);
    assert.equal(boundary.blocked.length, 0);
    assert.equal(boundary.bridges.length, 0);
  });
  // The bottom middle tile (cell 1: ids 2, 3) 1 m deep, the top of the right arm (cell 8: ids 16, 17) an opening
  // bridge. Only triangles with a neighbour in another tile are recorded: both of cell 1 (left and right), the lower
  // one of cell 8 (its bottom edge on cell 6; its upper triangle's top and left edges have no neighbour).
  withMesh(
    U.map((c, k) => (k === 1 ? { ...c, depth: 1 } : k === 8 ? { ...c, flags: FLAG_OPENING_BRIDGE } : c)),
    store => {
      const { map, boundary } = buildCoarseMap(store, RULES);
      assert.equal(map.pieces.length, 8);
      assert.deepEqual(Array.from(boundary.blocked), [2, 3]);
      assert.deepEqual(Array.from(boundary.bridges), [16]);
    }
  );
});

test('paged search: the U is routed down, across and up with no area given; the reach spans its tiles', () => {
  withMesh(U, store => {
    const s = searchMesh(store, START, END, SEARCH);
    assert.ok(s.result.ok, s.result.ok ? '' : s.result.reason);
    if (s.result.ok) {
      // Pulled tight, it turns at the inner corners of the U, on row 0's top edge (lat 1).
      assert.ok(
        s.result.path.some(p => p[1] <= 1 + 1e-9),
        'the route runs down to row 0: ' + JSON.stringify(s.result.path)
      );
      assert.equal(s.result.stats.tiles, 9);
      assert.equal(s.result.stats.trianglesLoaded, 18);
    }
    assert.deepEqual(s.box, { west: 0, south: 0, east: 3, north: 4 });
    const { map } = buildCoarseMap(store, RULES);
    const a = pieceAt(store, map, RULES, START[0], START[1]);
    const b = pieceAt(store, map, RULES, END[0], END[1]);
    if (a.kind !== 'piece' || b.kind !== 'piece') throw new Error('ends not on pieces');
    const chain = coarseRoute(map, a.piece, b.piece);
    assert.ok(chain);
    const r = reachOf(store, map, chain!);
    assert.deepEqual(
      r.chainTiles.map(t => t.join(',')),
      ['0,3', '0,2', '0,1', '0,0', '1,0', '2,0', '2,1', '2,2', '2,3']
    );
    assert.deepEqual(r.box, { west: 0, south: 0, east: 3, north: 4 });
  });
});

test('paged search: the same cost as the search on the whole mesh read at once', () => {
  withMesh(U, store => {
    const s = searchMesh(store, START, END, SEARCH);
    assert.ok(s.result.ok);
    if (!s.result.ok) return;
    // The whole mesh in one set of arrays, in the leg's frame (mid-latitude 3.6: a box from 0 to 7.2); its local ids
    // are the global ids (tiles in id order from 0).
    const m = store.load({ west: 0, south: 0, east: 3, north: 7.2 });
    const pm = PagedMesh.fromLoaded(m, blockedTriangles(m, SEARCH));
    const [sx, sy] = pm.toXY(START[0], START[1]);
    const [ex, ey] = pm.toXY(END[0], END[1]);
    const r = meshAstar(pm, pm.locate(sx, sy), pm.locate(ex, ey), sx, sy, ex, ey, SEARCH.motorSpeedMs);
    assert.equal(r.goalG, s.result.costS);
  });
});

test('paged mesh: a tile dropped and read again is the same tile', () => {
  withMesh(U, store => {
    const pm = new PagedMesh(store, { ...SEARCH, bufferM: 10 }, Math.cos((3.6 * Math.PI) / 180));
    const a = pm.tile(4);
    const copy = { x: a.x.slice(), nb: a.nb.slice(), blocked: a.blocked.slice(), first: a.first };
    pm.drop(4);
    assert.equal(pm.isHeld(4), false);
    const b = pm.tile(4);
    assert.notEqual(a, b);
    assert.deepEqual(b.x, copy.x);
    assert.deepEqual(b.nb, copy.nb);
    assert.deepEqual(b.blocked, copy.blocked);
    assert.equal(b.first, copy.first);
    assert.equal(pm.stats.reads, 2);
    assert.equal(pm.stats.tiles, 1);
  });
});

test('paged mesh: the buffer crosses a tile edge from the rough cut’s blocked boundary triangles, opening bridges under Avoid', () => {
  // Two tiles side by side: (0, 0) 10 m deep (ids 0, 1), (1, 0) 1 m deep (ids 2, 3); only 3, the upper triangle
  // of (1, 0), has a neighbour across the tile edge (0, the lower triangle of (0, 0)).
  withMesh(
    [
      { i: 0, j: 0 },
      { i: 1, j: 0, depth: 1 },
    ],
    store => {
      const { boundary } = buildCoarseMap(store, RULES);
      assert.deepEqual(Array.from(boundary.blocked), [3]);
      const rules = { ...SEARCH, bufferM: 10 };
      const seeded = new PagedMesh(store, rules, 1, boundary).tile(0);
      assert.deepEqual(Array.from(seeded.ruleBlocked), [0, 0]);
      assert.deepEqual(Array.from(seeded.blocked), [1, 1], 'both triangles touch the edge of the shallow tile');
      const alone = new PagedMesh(store, rules, 1).tile(0);
      assert.deepEqual(Array.from(alone.blocked), [0, 0], 'without the rough cut the tile sees no blocked water');
    }
  );
  withMesh(
    [
      { i: 0, j: 0 },
      { i: 1, j: 0, flags: FLAG_OPENING_BRIDGE },
    ],
    store => {
      const { boundary } = buildCoarseMap(store, RULES);
      const avoid = new PagedMesh(store, { ...SEARCH, bufferM: 10, openingBridges: 'avoid' }, 1, boundary).tile(0);
      assert.deepEqual(Array.from(avoid.blocked), [1, 1]);
      const open = new PagedMesh(store, { ...SEARCH, bufferM: 10, openingBridges: 'open' }, 1, boundary).tile(0);
      assert.deepEqual(Array.from(open.blocked), [0, 0]);
    }
  );
});

test('rough cut: an end on water too shallow is reported with its depth; water that does not connect has no chain', () => {
  withMesh(
    U.map(c => (c.i === 2 && c.j === 3 ? { ...c, depth: 1 } : c)),
    store => {
      const { map } = buildCoarseMap(store, RULES);
      assert.deepEqual(pieceAt(store, map, RULES, END[0], END[1]), { kind: 'blocked', depth: 1 });
    }
  );
  // Without the bottom middle tile the arms do not meet; the paged search runs out of water.
  withMesh(
    U.filter(c => !(c.i === 1 && c.j === 0)),
    store => {
      const { map } = buildCoarseMap(store, RULES);
      const a = pieceAt(store, map, RULES, START[0], START[1]);
      const b = pieceAt(store, map, RULES, END[0], END[1]);
      if (a.kind !== 'piece' || b.kind !== 'piece') throw new Error('ends not on pieces');
      assert.equal(coarseRoute(map, a.piece, b.piece), null);
      assert.deepEqual(pieceAt(store, map, RULES, 5.5, 5.5), { kind: 'outside' });
      const s = searchMesh(store, START, END, SEARCH);
      assert.ok(!s.result.ok);
      if (!s.result.ok)
        assert.equal(
          s.result.reason,
          'no route on the mesh between the start and the end for this boat (the search ran out of water it may use)'
        );
    }
  );
});
