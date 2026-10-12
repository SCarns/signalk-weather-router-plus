/**
 * The rough cuts on disk and their child tasks (meshcoarse.ts, childtask.ts
 * 'mesh-coarse', 'mesh-corridor'): built into the data folder, read back
 * for a leg's corridor on a U-shaped mesh, pruned when their build is gone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeGridMesh } from '../engine/mesh/fixture';
import { runChildTask } from './childtask';
import { COARSE_DIR, COARSE_KEEP_PER_MESH, coarseFile, coarseKey, pruneCoarse } from './meshcoarse';

const RULES = { draughtM: 2, airDraftM: 18 };
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

test('mesh-coarse and mesh-corridor child tasks: a rough cut built into the data folder gives the leg its corridor', async () => {
  const mesh = writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-')), U);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-data-'));
  try {
    const out = coarseFile(data, mesh, RULES);
    assert.equal(path.dirname(out), path.join(data, COARSE_DIR));
    assert.match(path.basename(out), /^[0-9a-f]{16}-d2\.00-a18\.00\.json$/);
    const b = await runChildTask({ task: 'mesh-coarse', dir: mesh, out, rules: RULES }, 60_000);
    assert.equal(b.pieces, 9);
    assert.equal(b.links, 8);
    assert.ok(fs.existsSync(out));
    const c = await runChildTask(
      { task: 'mesh-corridor', dir: mesh, mapFile: out, start: [0.5, 3.6], end: [2.5, 3.6], rules: RULES },
      60_000
    );
    assert.ok(c.ok, c.ok ? '' : c.reason);
    if (c.ok) {
      assert.equal(c.chainTiles, 9);
      assert.equal(c.rings.length, 2);
      assert.ok(c.box.south <= 0 && c.box.north >= 4, JSON.stringify(c.box));
    }
    // An end on land: not on a triangle of the mesh.
    const off = await runChildTask(
      { task: 'mesh-corridor', dir: mesh, mapFile: out, start: [1.5, 3.6], end: [2.5, 3.6], rules: RULES },
      60_000
    );
    assert.deepEqual(off, { ok: false, reason: 'the start point is not on a triangle of the mesh' });
  } finally {
    fs.rmSync(mesh, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('pruneCoarse: rough cuts of builds no longer in use go, and beyond the limit per build the oldest', () => {
  const mesh = writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-')), U);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-data-'));
  try {
    const dir = path.join(data, COARSE_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const key = coarseKey(mesh);
    const names: string[] = [];
    for (let k = 0; k < COARSE_KEEP_PER_MESH + 2; k++) {
      const n = `${key}-d${(1 + k).toFixed(2)}-a18.00.json`;
      fs.writeFileSync(path.join(dir, n), '{}');
      // Older first: each file a second newer than the one before.
      const t = new Date(Date.now() - (COARSE_KEEP_PER_MESH + 2 - k) * 1000);
      fs.utimesSync(path.join(dir, n), t, t);
      names.push(n);
    }
    fs.writeFileSync(path.join(dir, 'deadbeefdeadbeef-d2.00-a18.00.json'), '{}');
    const removed = pruneCoarse(data, new Set([key]));
    assert.equal(removed, 3);
    const left = fs.readdirSync(dir).sort();
    assert.deepEqual(left, names.slice(2).sort());
  } finally {
    fs.rmSync(mesh, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});
