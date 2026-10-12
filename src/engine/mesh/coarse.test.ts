/**
 * The rough cut (coarse.ts) and the corridor search (route.ts searchMesh
 * with a corridor) on a U-shaped mesh of 1° tiles: two arms, columns 0 and
 * 2, rows 0–3, joined by row 0. A leg from the top of one arm to the top
 * of the other must run down, across and up: every box the search grows
 * around its ends (up to 2°) stops at row 1, so only the corridor finds it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildCoarseMap, coarseRoute, corridorOf, pieceAt } from './coarse';
import { writeGridMesh } from './fixture';
import { searchMesh } from './route';
import { MeshStore } from './store';

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

function withMesh(cells: { i: number; j: number; depth?: number }[], fn: (store: MeshStore) => void): void {
  const dir = writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-coarse-')), cells);
  try {
    fn(MeshStore.open(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('rough cut: one piece per water tile, linked across shared tile edges', () => {
  withMesh(U, store => {
    const map = buildCoarseMap(store, RULES);
    assert.equal(map.pieces.length, 9);
    assert.equal(map.links.length, 8, JSON.stringify(map.links));
    assert.equal(map.triangles, 18);
    assert.equal(map.tiles.length, 9);
  });
});

test('corridor: the boxes around the ends find no route; the corridor down, across and up does', () => {
  withMesh(U, store => {
    const boxes = searchMesh(store, START, END, SEARCH);
    assert.equal(boxes.result.ok, false, 'no box up to 2° around the ends reaches row 0');
    const map = buildCoarseMap(store, RULES);
    const a = pieceAt(store, map, RULES, START[0], START[1]);
    const b = pieceAt(store, map, RULES, END[0], END[1]);
    assert.equal(a.kind, 'piece');
    assert.equal(b.kind, 'piece');
    if (a.kind !== 'piece' || b.kind !== 'piece') return;
    const chain = coarseRoute(map, a.piece, b.piece);
    assert.ok(chain);
    const c = corridorOf(store, map, chain!, 2);
    assert.deepEqual(
      c.chainTiles.map(t => t.join(',')),
      ['0,3', '0,2', '0,1', '0,0', '1,0', '2,0', '2,1', '2,2', '2,3']
    );
    // Ring 1 around those tiles takes in every tile of the mesh (all are within one tile of the chain).
    assert.equal(c.rings[0].length, 9);
    const s = searchMesh(store, START, END, SEARCH, c.rings);
    assert.ok(s.result.ok, s.result.ok ? '' : s.result.reason);
    if (s.result.ok) {
      // Pulled tight, it turns at the inner corners of the U, on row 0's top edge (lat 1).
      assert.ok(
        s.result.path.some(p => p[1] <= 1 + 1e-9),
        'the route runs down to row 0: ' + JSON.stringify(s.result.path)
      );
      assert.equal(s.result.stats.corridorRing, 1);
      assert.equal(s.result.stats.corridorTiles, 9);
    }
  });
});

test('corridor: an end on water too shallow is reported with its depth; water that does not connect has no chain', () => {
  withMesh(
    U.map(c => (c.i === 2 && c.j === 3 ? { ...c, depth: 1 } : c)),
    store => {
      const map = buildCoarseMap(store, RULES);
      assert.deepEqual(pieceAt(store, map, RULES, END[0], END[1]), { kind: 'blocked', depth: 1 });
    }
  );
  // Without the bottom middle tile the arms do not meet.
  withMesh(
    U.filter(c => !(c.i === 1 && c.j === 0)),
    store => {
      const map = buildCoarseMap(store, RULES);
      const a = pieceAt(store, map, RULES, START[0], START[1]);
      const b = pieceAt(store, map, RULES, END[0], END[1]);
      if (a.kind !== 'piece' || b.kind !== 'piece') throw new Error('ends not on pieces');
      assert.equal(coarseRoute(map, a.piece, b.piece), null);
      assert.deepEqual(pieceAt(store, map, RULES, 5.5, 5.5), { kind: 'outside' });
    }
  );
});
