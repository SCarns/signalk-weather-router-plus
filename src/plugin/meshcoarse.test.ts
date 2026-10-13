/**
 * The rough cuts on disk and their child tasks (meshcoarse.ts, childtask.ts
 * 'mesh-coarse', 'mesh-reach'): built into the data folder with their
 * boundary file, read back for a leg's reach on a U-shaped mesh (with an
 * approximate waypoint aimed at water connected to the start, not at a
 * pond), pruned when their build or version is gone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeGridMesh } from '../engine/mesh/fixture';
import { searchMesh } from '../engine/mesh/route';
import { MeshStore } from '../engine/mesh/store';
import { runChildTask } from './childtask';
import {
  boundaryFile,
  COARSE_DIR,
  COARSE_KEEP_PER_MESH,
  coarseFile,
  coarseKey,
  joinsFile,
  type MeshReachTask,
  pruneCoarse,
  readBoundary,
  readJoins,
  runMeshCoarseTask,
  runMeshJoinsTask,
  runMeshReachTask,
  runMeshSnapTask,
} from './meshcoarse';

const RULES = { draughtM: 2, airDraftM: 18, bufferM: 0, openingBridges: 'open' as const };
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
    assert.match(path.basename(out), /^[0-9a-f]{16}-v3-d2\.00-a18\.00-b0\.00-o\.json$/);
    assert.match(path.basename(coarseFile(data, mesh, { ...RULES, bufferM: 10, openingBridges: 'avoid' })), /-b10\.00-x\.json$/);
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
      assert.deepEqual(c.aims, [null]);
    }
    // An end on land: not on a triangle of the mesh.
    const off = await runChildTask(
      { task: 'mesh-reach', dir: mesh, mapFile: out, points: ends([1.5, 3.6], [2.5, 3.6]), rules: RULES },
      60_000
    );
    assert.deepEqual(off, { ok: false, reason: 'the start is not on a triangle of the mesh' });
    // An approximate waypoint off the water (the gap between the arms): aimed at the nearest usable water, half a
    // degree away on an arm's edge.
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
    if (via.ok) {
      const aim = via.aims[0]!;
      assert.ok(Math.abs(aim.lat - 2.5) < 1e-9 && (Math.abs(aim.lon - 1) < 1e-9 || Math.abs(aim.lon - 2) < 1e-9), JSON.stringify(aim));
      assert.ok(aim.movedM > 500);
      assert.equal(via.aims[1], null);
    }
  } finally {
    fs.rmSync(mesh, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('mesh-reach: an approximate waypoint whose nearest water is a pond is aimed at water connected to the start; an exact one in the pond is refused', async () => {
  // The U and, apart from it, a one-tile pond at (5, 5).
  const mesh = writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-')), [...U, { i: 5, j: 5 }]);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-data-'));
  try {
    const out = coarseFile(data, mesh, RULES);
    await runChildTask({ task: 'mesh-coarse', dir: mesh, out, rules: RULES }, 60_000);
    const points = (wp: { lon: number; lat: number; radiusM?: number }): MeshReachTask['points'] => [
      { lon: 0.5, lat: 3.6, name: 'the start' },
      { ...wp, name: 'waypoint 1' },
      { lon: 2.5, lat: 3.6, name: 'the destination' },
    ];
    // Just off the pond's edge: the pond is 0.1° away, the right arm's corner (3, 4) far further.
    const r = runMeshReachTask({
      task: 'mesh-reach',
      dir: mesh,
      mapFile: out,
      points: points({ lon: 4.9, lat: 5.5, radiusM: 500 }),
      rules: RULES,
    });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    if (r.ok) {
      const aim = r.aims[0]!;
      assert.ok(aim.lon <= 3 + 1e-9 && aim.lat <= 4 + 1e-9, `aimed in the U, not the pond: ${JSON.stringify(aim)}`);
    }
    const exact = runMeshReachTask({ task: 'mesh-reach', dir: mesh, mapFile: out, points: points({ lon: 5.5, lat: 5.5 }), rules: RULES });
    assert.deepEqual(exact, {
      ok: false,
      reason: 'no water on the chart mesh connects the start and waypoint 1 for this boat (draught {depth:2}, air draft {length:18})',
    });
  } finally {
    fs.rmSync(mesh, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('mesh-snap: a stop on water the boat cannot use, or in a pond, moves to the nearest usable water connected to the route, within the limit', () => {
  // The U, the top of its left arm 1 m deep, and apart from it a one-tile pond at (5, 5).
  const mesh = writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-')), [
    ...U.map(c => (c.i === 0 && c.j === 3 ? { ...c, depth: 1 } : c)),
    { i: 5, j: 5 },
  ]);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-data-'));
  try {
    const out = coarseFile(data, mesh, RULES);
    runMeshCoarseTask({ task: 'mesh-coarse', dir: mesh, out, rules: RULES });
    const snap = (points: { lon: number; lat: number; name: string }[], maxMoveM: number) =>
      runMeshSnapTask({ task: 'mesh-snap', dir: mesh, mapFile: out, points, rules: RULES, maxMoveM });
    // A start on the shallow tile: moved down the arm to its edge (lat 3), the destination left where it is.
    const r = snap(
      [
        { lon: 0.5, lat: 3.6, name: 'the start point' },
        { lon: 2.5, lat: 3.6, name: 'the destination' },
      ],
      1e6
    );
    assert.ok(r.ok, r.ok ? '' : r.reason);
    if (r.ok) {
      assert.ok(Math.abs(r.points[0].lat - 3) < 1e-9 && Math.abs(r.points[0].lon - 0.5) < 1e-9, JSON.stringify(r.points[0]));
      assert.equal(r.points[0].why, 'is on charted depth {depth:1}, too shallow for this boat');
      assert.equal(r.points[0].outsideGroup, false);
      assert.deepEqual(r.points[1], { lon: 2.5, lat: 3.6, movedM: 0, why: null, outsideGroup: false });
    }
    // A start in the pond: usable but cut off; moved to the U's water, and said so.
    const pond = snap(
      [
        { lon: 5.5, lat: 5.5, name: 'the start point' },
        { lon: 2.5, lat: 3.6, name: 'the destination' },
      ],
      1e6
    );
    assert.ok(pond.ok, pond.ok ? '' : pond.reason);
    if (pond.ok) {
      assert.ok(pond.points[0].lon <= 3 + 1e-9 && pond.points[0].lat <= 4 + 1e-9, JSON.stringify(pond.points[0]));
      assert.equal(pond.points[0].outsideGroup, true);
    }
    // Farther than the limit: an error naming the stop and the nearest usable water.
    const far = snap(
      [
        { lon: 0.5, lat: 3.6, name: 'the start point' },
        { lon: 2.5, lat: 3.6, name: 'the destination' },
      ],
      1000
    );
    assert.ok(!far.ok);
    if (!far.ok)
      assert.match(
        far.reason,
        /^the start point, at 3\.6000, 0\.5000, is on charted depth \{depth:1\}, too shallow for this boat; the nearest water this boat can use, connected to the route, is \{length:\d+\} away at 3\.0000, 0\.5000, more than \{length:1000\}/
      );
  } finally {
    fs.rmSync(mesh, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('a stop on a corner where the route’s water meets a separate pocket belongs to the route’s water: reach, snap and search', () => {
  // The U, and a one-tile pocket at (3, 4) touching the top of its right arm (2, 3) only at the corner (3, 4).
  const mesh = writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-')), [...U, { i: 3, j: 4 }]);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-data-'));
  try {
    const out = coarseFile(data, mesh, RULES);
    runMeshCoarseTask({ task: 'mesh-coarse', dir: mesh, out, rules: RULES });
    const points = [
      { lon: 0.5, lat: 3.6, name: 'the start' },
      { lon: 3, lat: 4, name: 'the destination' },
    ];
    const reach = runMeshReachTask({ task: 'mesh-reach', dir: mesh, mapFile: out, points, rules: RULES });
    assert.ok(reach.ok, reach.ok ? '' : reach.reason);
    const snap = runMeshSnapTask({ task: 'mesh-snap', dir: mesh, mapFile: out, points, rules: RULES, maxMoveM: 1000 });
    assert.ok(snap.ok, snap.ok ? '' : snap.reason);
    if (snap.ok) assert.equal(snap.points[1].movedM, 0, 'not moved: it touches the route');
    const s = searchMesh(MeshStore.open(mesh), [0.5, 3.6], [3, 4], { ...RULES, motorSpeedMs: 3 });
    assert.ok(s.result.ok, s.result.ok ? '' : s.result.reason);
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
      const n = `${key}-v3-d${(1 + k).toFixed(2)}-a18.00-b0.00-o.json`;
      fs.writeFileSync(path.join(dir, n), '{}');
      fs.writeFileSync(boundaryFile(path.join(dir, n)), '');
      // Older first: each file a second newer than the one before.
      const t = new Date(Date.now() - (COARSE_KEEP_PER_MESH + 2 - k) * 1000);
      fs.utimesSync(path.join(dir, n), t, t);
      names.push(n, boundaryFile(n));
    }
    fs.writeFileSync(path.join(dir, 'deadbeefdeadbeef-v3-d2.00-a18.00-b0.00-o.json'), '{}');
    // A rough cut of an earlier version of the live build.
    fs.writeFileSync(path.join(dir, `${key}-v2-d2.00-a18.00.json`), '{}');
    const removed = pruneCoarse(data, new Set([key]));
    assert.equal(removed, 4);
    const left = fs.readdirSync(dir).sort();
    assert.deepEqual(left, names.slice(4).sort());
  } finally {
    fs.rmSync(mesh, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('joins: built with the rough cut and on their own alike: which piece of one mesh joins which of another, per direction', () => {
  // A over cells lon 0–3, B over cells lon 1–4 (lat 0–1): they overlap in cells 1 and 2. B charts cell 2 at 1 m.
  const a = writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-a-')), [
    { i: 0, j: 0 },
    { i: 1, j: 0 },
    { i: 2, j: 0 },
  ]);
  const b = writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-b-')), [
    { i: 1, j: 0 },
    { i: 2, j: 0, depth: 1 },
    { i: 3, j: 0 },
  ]);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-data-'));
  try {
    const outA = coarseFile(data, a, RULES);
    const outB = coarseFile(data, b, RULES);
    const r = runMeshCoarseTask({ task: 'mesh-coarse', dir: a, out: outA, rules: RULES, joins: [{ dir: b, mapFile: outB, name: 'B' }] });
    // A's cell 1 (tile position 1, piece 0) joins B's cell 1 (position 0, piece 0); cell 2 is too shallow in B.
    assert.deepEqual(
      r.joins.map(j => [j.name, j.joins]),
      [['B', 1]]
    );
    assert.deepEqual(Array.from(readJoins(joinsFile(outA, b))!), [1, 0, 0, 0]);
    // B's boundary record was written for it, its map not yet.
    assert.ok(fs.existsSync(boundaryFile(outB)) && !fs.existsSync(outB));
    // The other direction, from B's rough cut: B's cell 1 joins A's cell 1.
    runMeshCoarseTask({ task: 'mesh-coarse', dir: b, out: outB, rules: RULES, joins: [{ dir: a, mapFile: outA, name: 'A' }] });
    assert.deepEqual(Array.from(readJoins(joinsFile(outB, a))!), [0, 0, 1, 0]);
    // On their own (the other mesh a newer build): the same joins.
    fs.rmSync(joinsFile(outA, b));
    const alone = runMeshJoinsTask({
      task: 'mesh-joins',
      dir: a,
      mapFile: outA,
      rules: RULES,
      other: { dir: b, mapFile: outB, name: 'B' },
    });
    assert.equal(alone.joins, 1);
    assert.deepEqual(Array.from(readJoins(joinsFile(outA, b))!), [1, 0, 0, 0]);
    // Pruned with its map's build, or when the other mesh's build is no longer in use.
    pruneCoarse(data, new Set([coarseKey(a), coarseKey(b)]));
    assert.ok(fs.existsSync(joinsFile(outA, b)));
    pruneCoarse(data, new Set([coarseKey(a)]));
    assert.ok(!fs.existsSync(joinsFile(outA, b)), "A's joins towards B go when B's build is no longer in use");
    assert.ok(fs.existsSync(outA));
  } finally {
    for (const d of [a, b, data]) fs.rmSync(d, { recursive: true, force: true });
  }
});
