/**
 * The final depth check in a child process (childtask.ts 'mesh-check',
 * meshchecktask.ts): a route across a two-tile mesh on disk comes back
 * with its violations and per-leg figures.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeTwoTileMesh } from '../engine/mesh/fixture';
import { runChildTask } from './childtask';
import type { MeshCheckTask } from './meshchecktask';

function across(dir: string): MeshCheckTask {
  return {
    task: 'mesh-check',
    dirs: [dir],
    path: [
      [0.25, 0.1],
      [1.75, 0.1],
    ],
    legOf: [0],
    legCount: 1,
    rules: { draughtM: 2, airDraftM: 18, openingBridges: 'open' },
  };
}

test('mesh-check child task: a route over shallow water comes back with the violation, one over deep water with its depths', async () => {
  const shallow = writeTwoTileMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-')), [10, 10, 1, 1]);
  const deep = writeTwoTileMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-')), [10, 10, 7.5, 7.5]);
  try {
    const bad = await runChildTask(across(shallow), 60_000);
    assert.equal(bad.violations.length, 1);
    assert.equal(bad.violations[0].kind, 'depth');
    assert.equal(bad.violations[0].value, 1);
    const good = await runChildTask(across(deep), 60_000);
    assert.deepEqual(good.violations, []);
    assert.equal(good.legs.length, 1);
    assert.equal(good.legs[0].shallowestM, 7.5);
    assert.ok(good.legs[0].onMeshM > 160_000 && good.legs[0].onMeshM < 170_000, `${good.legs[0].onMeshM} m`);
  } finally {
    fs.rmSync(shallow, { recursive: true, force: true });
    fs.rmSync(deep, { recursive: true, force: true });
  }
});
