/**
 * Where a leg leaves the chart mesh (exit.ts, part 5), on a mesh of two 1° tiles (lon 0–2, lat 0–1) with coastline
 * land along its south side (lat < 0) and its west side (lon < 0): those mesh edges are shorelines; its north and
 * east edges meet open water beyond the charts. A leg from inside the mesh to open water east of it must leave
 * through the east edge, never a shoreline; the coastline part may not enter the mesh's water; a stop that the
 * coastline data calls land (a blob inside the mesh) is never given to it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ShapePolygon } from '../../geo/shapefile';
import { LandMask, moveMeetsCells } from '../../geo/landmask';
import { boundarySeeds, buildCoarseMap, type CoarseMap, type CoarseRules, meshRulesOf } from './coarse';
import { findMeshExit } from './exit';
import { PagedMesh } from './paged';
import { writeGridMesh } from './fixture';
import { MeshStore } from './store';

function rect(recordNumber: number, lon0: number, lat0: number, lon1: number, lat1: number): ShapePolygon {
  const c = [lon0, lat0, lon1, lat0, lon1, lat1, lon0, lat1, lon0, lat0];
  return {
    recordNumber,
    minLon: lon0,
    minLat: lat0,
    maxLon: lon1,
    maxLat: lat1,
    rings: [{ coords: Float64Array.from(c), minLon: lon0, minLat: lat0, maxLon: lon1, maxLat: lat1 }],
  };
}

const RULES = { draughtM: 2, airDraftM: 18, motorSpeedMs: 3 };
const BOX = { west: -1, south: -1, east: 5, north: 3 };

const COARSE: CoarseRules = {
  draughtM: 2,
  airDraftM: 18,
  underKeelClearanceM: 0.5,
  overheadClearanceM: 1,
  bufferM: 0,
  openingBridges: 'open',
};

function withMesh(
  fn: (store: MeshStore, map: CoarseMap) => void,
  cells = [
    { i: 0, j: 0 },
    { i: 1, j: 0 },
  ] as { i: number; j: number; depth?: number }[]
): void {
  const dir = writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-exit-')), cells);
  try {
    const store = MeshStore.open(dir);
    fn(store, buildCoarseMap(store, COARSE, new PagedMesh(store, meshRulesOf(COARSE), 1, boundarySeeds(store, COARSE))));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('findMeshExit: a leg to open water beyond the charts leaves through the edge that meets it, never a shoreline', () => {
  withMesh((store, map) => {
    // Land south (lat < 0) and west (lon < 0) of the mesh, and a blob the coastline data calls land round the stop.
    const land = LandMask.fromPolygons([rect(1, -1, -1, 5, 0), rect(2, -1, -1, 0, 3), rect(3, 0.4, 0.4, 0.6, 0.6)], BOX, 0.05);
    const r = findMeshExit(store, RULES, null, map, land, [0.5, 0.5], [3.5, 0.5], { inside: 'the start', outside: 'the end' });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    if (!r.ok) return;
    const [lon, lat] = r.exit;
    assert.ok(Math.abs(lon - 2) < 1e-9 && lat > 0 && lat < 1, `leaves through the east edge: ${lon}, ${lat}`);
    assert.ok(r.exits > 0);
    // The mesh's water is land to the coastline part: a move across the mesh meets it, one beyond it does not.
    assert.equal(moveMeetsCells(r.mask, 1.5, 0.5, 1.5, 0.9), true, 'inside the mesh');
    assert.equal(moveMeetsCells(r.mask, 3, 0.5, 4, 0.5), false, 'beyond it');
  });
});

test('findMeshExit: a far end the coastline data calls land is refused, naming it', () => {
  withMesh((store, map) => {
    // Land round the mesh, the far end (4.5, 2.5) inside it.
    const land = LandMask.fromPolygons(
      [rect(1, -1, -1, 5, -0.5), rect(2, -1, -1, 0, 3), rect(3, 2, -1, 5, 1.2), rect(4, -1, 1, 5, 3)],
      BOX,
      0.05
    );
    const r = findMeshExit(store, RULES, null, map, land, [0.5, 0.5], [4.5, 2.5], { inside: 'the start', outside: 'the end' });
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.reason, 'the end is not on open water to the coastline data outside the chart mesh');
  });
});

test("findMeshExit: a stop whose water does not reach the mesh's edge facing the far end fails before any search", () => {
  // Three tiles in a row; the middle one 1 m deep cuts the stop's water (lon 0–1) off from the east edge (lon 3).
  withMesh(
    (store, map) => {
      const land = LandMask.fromPolygons([rect(1, -1, -1, 5, 0), rect(2, -1, -1, 0, 3), rect(4, -1, 1, 5, 3)], BOX, 0.05);
      const r = findMeshExit(store, RULES, null, map, land, [0.5, 0.5], [4, 0.5], { inside: 'the start', outside: 'the end' });
      assert.ok(!r.ok);
      if (!r.ok)
        assert.equal(
          r.reason,
          'no water on the chart mesh connects the start to where the charts meet the water that reaches the end, within the area'
        );
    },
    [
      { i: 0, j: 0 },
      { i: 1, j: 0, depth: 1 },
      { i: 2, j: 0 },
    ]
  );
});
