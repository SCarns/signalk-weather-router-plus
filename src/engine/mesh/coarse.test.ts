/**
 * The rough cut (coarse.ts) and the paged mesh search (route.ts searchMesh, paged.ts) on a U-shaped mesh of 1° tiles:
 * two arms, columns 0 and 2, rows 0–3, joined by row 0. A leg from the top of one arm to the top of the other must
 * run down, across and up, far from the box around its ends; the search reads the tiles as it reaches them, with no
 * area given. The rough cut is built from the same tile reads as the search, so the two must agree on what water
 * connects: the buffer from unusable water, an area to avoid and an opening bridge under Avoid each close the
 * bottom of the U for both or for neither.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { meshAstar } from './astar';
import { boundarySeeds, buildCoarseMap, type CoarseMap, type CoarseRules, coarseRoute, meshRulesOf, PieceGraph } from './coarse';
import { writeGridMesh } from './fixture';
import { MeshLand } from './land';
import { type BoundarySeeds, PagedMesh } from './paged';
import { blockedTriangles, type MeshRules, searchMesh } from './route';
import { FLAG_OPENING_BRIDGE, MeshStore } from './store';

const RULES: CoarseRules = {
  draughtM: 2,
  airDraftM: 18,
  underKeelClearanceM: 0.5,
  overheadClearanceM: 1,
  bufferM: 0,
  openingBridges: 'open',
};
const SEARCH = { draughtM: 2, airDraftM: 18, motorSpeedMs: 3 };
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

/** The rough cut for the rules, as the plugin builds it (meshcoarse.ts). */
function build(store: MeshStore, rules: CoarseRules): { map: CoarseMap; boundary: BoundarySeeds } {
  const boundary = boundarySeeds(store, rules);
  return { map: buildCoarseMap(store, rules, new PagedMesh(store, meshRulesOf(rules), 1, boundary)), boundary };
}

/** The rough cut as the reach task sees it (under the rules and the areas to avoid). */
function graphOf(store: MeshStore, rules: CoarseRules, avoid?: MeshRules['avoid']): { graph: PieceGraph; pm: PagedMesh } {
  const { map, boundary } = build(store, rules);
  const pm = new PagedMesh(store, meshRulesOf(rules, avoid), 1, boundary);
  return { graph: new PieceGraph(map, pm), pm };
}

/** Does the rough cut connect two points, as the reach task asks? */
function connects(store: MeshStore, rules: CoarseRules, a: [number, number], b: [number, number], avoid?: MeshRules['avoid']): boolean {
  const { graph, pm } = graphOf(store, rules, avoid);
  const piece = (p: [number, number]): number | null => {
    const g = pm.locate(...pm.toXY(p[0], p[1]), true);
    return g >= 0 && !pm.isBlocked(g) ? graph.pieceOf(g) : null;
  };
  const [pa, pb] = [piece(a), piece(b)];
  if (pa === null || pb === null) return false;
  const same = graph.component(pa) === graph.component(pb);
  assert.equal(coarseRoute(graph, pa, pb) !== null, same, 'a chain exactly when the pieces share a group');
  return same;
}

test('rough cut: one piece per water tile, linked across shared tile edges; the blocked tile-boundary triangles recorded', () => {
  withMesh(U, store => {
    const { map, boundary } = build(store, RULES);
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
      const { map, boundary } = build(store, RULES);
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
    const { graph, pm } = graphOf(store, RULES);
    const a = graph.pieceOf(pm.locate(...pm.toXY(START[0], START[1])))!;
    const b = graph.pieceOf(pm.locate(...pm.toXY(END[0], END[1])))!;
    const chain = coarseRoute(graph, a, b);
    assert.ok(chain);
    const r = graph.reach([chain!]);
    assert.equal(r.chainTiles, 9);
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

test('paged mesh: a tile’s blocked set is the same whatever leg reads it (its own frame)', () => {
  withMesh([...U, { i: 1, j: 1, depth: 1 }], store => {
    const boundary = boundarySeeds(store, RULES);
    const rules = { ...SEARCH, bufferM: 10 };
    for (let idx = 0; idx < 10; idx++) {
      const a = new PagedMesh(store, rules, Math.cos((10 * Math.PI) / 180), boundary).tile(idx);
      const b = new PagedMesh(store, rules, Math.cos((60 * Math.PI) / 180), boundary).tile(idx);
      assert.deepEqual(a.blocked, b.blocked, `tile ${idx}`);
    }
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
      const boundary = boundarySeeds(store, RULES);
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
      const boundary = boundarySeeds(store, RULES);
      const avoid = new PagedMesh(store, { ...SEARCH, bufferM: 10, openingBridges: 'avoid' }, 1, boundary).tile(0);
      assert.deepEqual(Array.from(avoid.blocked), [1, 1]);
      const open = new PagedMesh(store, { ...SEARCH, bufferM: 10, openingBridges: 'open' }, 1, boundary).tile(0);
      assert.deepEqual(Array.from(open.blocked), [0, 0]);
    }
  );
});

test('the rough cut connects two points exactly when the search finds a route: buffer, area to avoid, opening bridge', () => {
  /** Rough cut and search on the same mesh and rules: they must agree. */
  const agree = (store: MeshStore, rules: CoarseRules, avoid?: MeshRules['avoid']): boolean => {
    const rough = connects(store, rules, START, END, avoid);
    const boundary = boundarySeeds(store, rules);
    const s = searchMesh(store, START, END, meshRulesOf(rules, avoid), boundary);
    assert.equal(rough, s.result.ok, `rough cut ${rough}, search ${s.result.ok ? 'routed' : s.result.reason}`);
    return rough;
  };
  // A shallow tile above the bottom middle one: the buffer closes the bottom of the U, and only the buffer does.
  withMesh([...U, { i: 1, j: 1, depth: 1 }], store => {
    assert.equal(agree(store, RULES), true, 'no buffer: connected');
    assert.equal(agree(store, { ...RULES, bufferM: 10 }), false, 'a 10 m buffer from the shallow tile closes it');
  });
  // An area to avoid over the bottom middle tile (its triangles' centroids about 26 km from its centre).
  withMesh(U, store => {
    assert.equal(agree(store, RULES, [{ lon: 1.5, lat: 0.5, radiusM: 30000 }]), false, 'the area closes it');
    assert.equal(agree(store, RULES, [{ lon: 1.5, lat: 0.5, radiusM: 1000 }]), true, 'a small area does not');
  });
  // An opening bridge over the bottom middle tile: open by default, closed under Avoid.
  withMesh(
    U.map(c => (c.i === 1 && c.j === 0 ? { ...c, flags: FLAG_OPENING_BRIDGE } : c)),
    store => {
      assert.equal(agree(store, RULES), true);
      assert.equal(agree(store, { ...RULES, openingBridges: 'avoid' }), false);
    }
  );
});

test('rough cut: water that does not connect has no chain, and the search runs out of water', () => {
  // Without the bottom middle tile the arms do not meet.
  withMesh(
    U.filter(c => !(c.i === 1 && c.j === 0)),
    store => {
      assert.equal(connects(store, RULES, START, END), false);
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

test('every segment of a mesh route passes the mesh land test (its corners turn round blocked water)', () => {
  // The U with a shallow tile above its bottom middle: the route down, across and up turns at the shallow tile's and
  // the arms' corners.
  withMesh([...U, { i: 1, j: 1, depth: 1 }], store => {
    const s = searchMesh(store, START, END, SEARCH);
    assert.ok(s.result.ok, s.result.ok ? '' : s.result.reason);
    if (!s.result.ok) return;
    const land = new MeshLand(new PagedMesh(store, SEARCH, Math.cos((3.6 * Math.PI) / 180)));
    const p = s.result.path;
    assert.ok(p.length > 2, 'the route turns');
    for (let i = 1; i < p.length; i++)
      assert.equal(
        land.legCrossesLandExact(p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]),
        false,
        `segment ${i}: ${JSON.stringify([p[i - 1], p[i]])}`
      );
  });
});
