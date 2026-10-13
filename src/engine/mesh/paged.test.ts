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
import { writeTile } from './fixture';
import { PagedMesh } from './paged';
import { MeshStore } from './store';

test('locate and locateAll find a triangle whose tile lies more than one cell from the point', () => {
  // Tile (0, 0): one triangle from lon 0 to lon 3 (cells 0 to 2 of a 1° grid); no tile in cell (2, 0) itself.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-paged-'));
  try {
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
    const pm = new PagedMesh(MeshStore.open(dir), { draughtM: 2, airDraftM: 18, motorSpeedMs: 3 }, 1);
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
