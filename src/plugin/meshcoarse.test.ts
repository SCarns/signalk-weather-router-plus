/**
 * The rough cuts on disk and their child tasks (meshcoarse.ts, childtask.ts
 * 'mesh-coarse', 'mesh-reach'): built into the data folder with their
 * boundary file, read back for a leg's reach on a U-shaped mesh, pruned
 * when their build or version is gone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeGridMesh } from '../engine/mesh/fixture';
import { runChildTask } from './childtask';
import { boundaryFile, COARSE_DIR, COARSE_KEEP_PER_MESH, coarseFile, coarseKey, pruneCoarse, readBoundary } from './meshcoarse';

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

test('mesh-coarse and mesh-reach child tasks: a rough cut built into the data folder gives the leg its reach', async () => {
  const mesh = writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-')), U);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-data-'));
  try {
    const out = coarseFile(data, mesh, RULES);
    assert.equal(path.dirname(out), path.join(data, COARSE_DIR));
    assert.match(path.basename(out), /^[0-9a-f]{16}-v2-d2\.00-a18\.00\.json$/);
    const b = await runChildTask({ task: 'mesh-coarse', dir: mesh, out, rules: RULES }, 60_000);
    assert.equal(b.pieces, 9);
    assert.equal(b.links, 8);
    assert.equal(b.boundaryBlocked, 0);
    assert.ok(fs.existsSync(out));
    assert.deepEqual(readBoundary(boundaryFile(out)), { blocked: new Int32Array(0), bridges: new Int32Array(0) });
    const ends = (a: [number, number], b: [number, number]): { lon: number; lat: number; name: string }[] => [
      { lon: a[0], lat: a[1], name: 'the start' },
      { lon: b[0], lat: b[1], name: 'the destination' },
    ];
    const c = await runChildTask(
      { task: 'mesh-reach', dir: mesh, mapFile: out, points: ends([0.5, 3.6], [2.5, 3.6]), rules: RULES },
      60_000
    );
    assert.ok(c.ok, c.ok ? '' : c.reason);
    if (c.ok) {
      assert.equal(c.chainTiles, 9);
      assert.deepEqual(c.box, { west: 0, south: 0, east: 3, north: 4 });
    }
    // An end on land: not on a triangle of the mesh.
    const off = await runChildTask(
      { task: 'mesh-reach', dir: mesh, mapFile: out, points: ends([1.5, 3.6], [2.5, 3.6]), rules: RULES },
      60_000
    );
    assert.deepEqual(off, { ok: false, reason: 'the start is not on a triangle of the mesh' });
    // An approximate waypoint off the water (the gap between the arms): the reach goes through the nearest usable
    // water; an exact one there is refused.
    const via = await runChildTask(
      {
        task: 'mesh-reach',
        dir: mesh,
        mapFile: out,
        points: [
          { lon: 0.5, lat: 3.6, name: 'the start' },
          { lon: 1.5, lat: 2.5, radiusM: 500, name: 'waypoint 1' },
          { lon: 2.5, lat: 3.6, name: 'the destination' },
        ],
        rules: RULES,
      },
      60_000
    );
    assert.ok(via.ok, via.ok ? '' : via.reason);
  } finally {
    fs.rmSync(mesh, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('pruneCoarse: rough cuts of builds no longer in use or of another version go, with their boundary files, and beyond the limit per build the oldest', () => {
  const mesh = writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-')), U);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-data-'));
  try {
    const dir = path.join(data, COARSE_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const key = coarseKey(mesh);
    const names: string[] = [];
    for (let k = 0; k < COARSE_KEEP_PER_MESH + 2; k++) {
      const n = `${key}-v2-d${(1 + k).toFixed(2)}-a18.00.json`;
      fs.writeFileSync(path.join(dir, n), '{}');
      fs.writeFileSync(boundaryFile(path.join(dir, n)), '');
      // Older first: each file a second newer than the one before.
      const t = new Date(Date.now() - (COARSE_KEEP_PER_MESH + 2 - k) * 1000);
      fs.utimesSync(path.join(dir, n), t, t);
      names.push(n, boundaryFile(n));
    }
    fs.writeFileSync(path.join(dir, 'deadbeefdeadbeef-v2-d2.00-a18.00.json'), '{}');
    // A rough cut of version 1 (no boundary file, no version in its name) of the live build.
    fs.writeFileSync(path.join(dir, `${key}-d2.00-a18.00.json`), '{}');
    const removed = pruneCoarse(data, new Set([key]));
    assert.equal(removed, 4);
    const left = fs.readdirSync(dir).sort();
    assert.deepEqual(left, names.slice(4).sort());
  } finally {
    fs.rmSync(mesh, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});
