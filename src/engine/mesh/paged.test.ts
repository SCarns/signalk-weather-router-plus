/**
 * The paged mesh's point lookup (paged.ts locate, locateAll) on a mesh written to disk whose one triangle reaches two
 * index cells past its own tile's cell, as offshore triangles do (07CGD, 2026-10-13: a triangle about 40 km across
 * in tile (4, 42) covers a point in cell (2, 43)).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeGridMesh, writeTile } from './fixture';
import { PagedMesh } from './paged';
import { MeshStore } from './store';

/** A mesh on disk of one tile (0, 0) holding one triangle from lon 0 to lon 3 (cells 0 to 2 of a 1° grid); no tile in cells 1, 2. */
function oneTriangle(dir: string): PagedMesh {
  writeTile(
    dir,
    'a.bin',
    [
      [
        [0, 0],
        [3, 0],
        [0, 1],
      ],
    ],
    [[-1, -1, -1]],
    [[-1, -1, -1]],
    [10]
  );
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({
      version: 1,
      west: 0,
      south: 0,
      east: 3,
      north: 1,
      tileDeg: 1,
      xScale: 1,
      triangles: 1,
      tiles: [{ i: 0, j: 0, file: 'a.bin', first: 0, n: 1, bbox: [0, 0, 3, 1] }],
    })
  );
  return new PagedMesh(MeshStore.open(dir), { draughtM: 2, airDraftM: 18, motorSpeedMs: 3 }, 1);
}

test('locate and locateAll find a triangle whose tile lies more than one cell from the point', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-paged-'));
  try {
    const pm = oneTriangle(dir);
    // (2.6, 0.1) lies in cell (2, 0), two cells east of the tile's, inside the triangle.
    const [x, y] = pm.toXY(2.6, 0.1);
    assert.equal(pm.locate(x, y), 0);
    assert.deepEqual(pm.locateAll(x, y), [0]);
    // Outside the triangle (above its hypotenuse), still inside the tile's extent: nothing.
    const [ox, oy] = pm.toXY(2.6, 0.5);
    assert.equal(pm.locate(ox, oy), -1);
    assert.deepEqual(pm.locateAll(ox, oy), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a point a hair west or south of the tile, on its edge, is found: the lookup grid is clamped (PR #39 review)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-paged-'));
  try {
    const pm = oneTriangle(dir);
    // On the west edge (lon 0) and the south edge (lat 0), each 1e-7 m outside: what a lon/lat round trip leaves.
    const [wx, wy] = pm.toXY(0, 0.5);
    assert.equal(pm.locate(wx - 1e-7, wy), 0, 'west');
    assert.deepEqual(pm.locateAll(wx - 1e-7, wy), [0]);
    const [sx, sy] = pm.toXY(1.5, 0);
    assert.equal(pm.locate(sx, sy - 1e-7), 0, 'south');
    assert.deepEqual(pm.locateAll(sx, sy - 1e-7), [0]);
    // Far outside, beside the tile: still nothing.
    assert.equal(pm.locate(wx - 5000, wy), -1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nearestUsable lets go of the tiles it scans, but the one holding its answer (PR #39 review)', () => {
  // A row of eight 1° tiles; only the farthest one's water is accepted (the route's water, far from a pond).
  const dir = writeGridMesh(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-paged-')),
    Array.from({ length: 8 }, (_, i) => ({ i, j: 0 }))
  );
  try {
    const pm = new PagedMesh(MeshStore.open(dir), { draughtM: 2, airDraftM: 18, motorSpeedMs: 3 }, 1);
    const far = (g: number): boolean => pm.tileIndexOf(g) === pm.tileCount - 1;
    const [x, y] = pm.toXY(0.5, 0.5);
    const before = new Set(pm.heldTiles());
    const nu = pm.nearestUsable(x, y, far);
    assert.ok(nu && far(nu.tri), 'found in the farthest tile');
    const held = pm.heldTiles().filter(i => !before.has(i));
    // The point's own tile (read by the lookup of its triangle) and the answer's: nothing in between.
    assert.ok(held.includes(pm.tileIndexOf(nu!.tri)), "the answer's tile is kept");
    assert.ok(held.length <= 2, `held after the scan: ${held}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
