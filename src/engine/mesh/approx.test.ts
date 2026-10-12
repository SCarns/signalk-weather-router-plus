/**
 * Approximate waypoints on the mesh (docs/drafts/mesh-no-gshhg-design.md, part 3): the usable water nearest a point
 * (paged.ts nearestUsable), a leg aimed at a waypoint circle (route.ts searchMesh `approach`), a run through circles
 * (searchMeshRun), and the cut where a route enters a circle (trimAtCircle). On the U-shaped mesh of 1° tiles: two
 * arms, columns 0 and 2, rows 0–3, joined by row 0; the gap between the arms has no triangles.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { haversineDistanceM } from '../../geo/geodesy';
import { writeGridMesh } from './fixture';
import { PagedMesh } from './paged';
import { runTargets, searchMesh, searchMeshRun, trimAtCircle } from './route';
import { M_PER_DEG_MESH, MeshStore } from './store';

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

function withMesh(cells: { i: number; j: number; depth?: number }[], fn: (store: MeshStore) => void): void {
  const dir = writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-approx-')), cells);
  try {
    fn(MeshStore.open(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('nearestUsable: the point itself in usable water; else the nearest point of the nearest usable triangle', () => {
  withMesh(U, store => {
    const pm = new PagedMesh(store, SEARCH, 1);
    const own = pm.nearestUsable(...pm.toXY(0.5, 2.5));
    assert.ok(own);
    assert.equal(own!.distM, 0);
    // In the gap at lon 1.5: half a degree to either arm; the left arm's edge at lon 1 is met first (ties keep the first).
    const gap = pm.nearestUsable(...pm.toXY(1.5, 2.5));
    assert.ok(gap);
    assert.ok(Math.abs(gap!.distM - 0.5 * M_PER_DEG_MESH) < 1e-6, String(gap!.distM));
    const [lon, lat] = pm.fromXY(gap!.x, gap!.y);
    assert.ok(Math.abs(lat - 2.5) < 1e-9 && (Math.abs(lon - 1) < 1e-9 || Math.abs(lon - 2) < 1e-9), `${lon}, ${lat}`);
  });
  // A shallow arm tile is not usable: the nearest usable water is the next tile down.
  withMesh(
    U.map(c => (c.i === 0 && c.j === 2 ? { ...c, depth: 1 } : c)),
    store => {
      const pm = new PagedMesh(store, SEARCH, 1);
      const nu = pm.nearestUsable(...pm.toXY(0.5, 2.9));
      assert.ok(nu);
      assert.ok(Math.abs(nu!.distM - 0.1 * M_PER_DEG_MESH) < 1e-6 || Math.abs(nu!.distM - 0.9 * M_PER_DEG_MESH) < 1e-6, String(nu!.distM));
    }
  );
});

test('trimAtCircle: cut where the polyline enters the circle; unchanged when it starts inside or never reaches it', () => {
  const p: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
  ];
  assert.deepEqual(trimAtCircle(p, 10, 10, 2), [
    [0, 0],
    [10, 0],
    [10, 8],
  ]);
  // A segment passing through the circle between two points outside it.
  const cut = trimAtCircle(p, 5, 1, 2);
  assert.equal(cut.length, 2);
  assert.ok(Math.abs(cut[1][0] - (5 - Math.sqrt(3))) < 1e-9 && cut[1][1] === 0, JSON.stringify(cut));
  assert.deepEqual(trimAtCircle(p, 0, 0, 1), p);
  assert.deepEqual(trimAtCircle(p, 50, 50, 1), p);
});

test('searchMesh approach: a waypoint in usable water is aimed at itself; one off the water at the nearest usable water, moved', () => {
  withMesh(U, store => {
    const own = searchMesh(store, START, [0.5, 1.5], SEARCH, null, { radiusM: 500, trim: false });
    assert.ok(own.result.ok, own.result.ok ? '' : own.result.reason);
    if (own.result.ok) {
      assert.equal(own.result.target!.movedM, 0);
      const last = own.result.path[own.result.path.length - 1];
      assert.ok(haversineDistanceM(last[0], last[1], 0.5, 1.5) < 1e-3);
    }
    // In the gap: no water within 500 m; the leg goes to the nearest usable water, 0.5° (about 55 km) away.
    const gap = searchMesh(store, START, [1.5, 2.5], SEARCH, null, { radiusM: 500, trim: true });
    assert.ok(gap.result.ok, gap.result.ok ? '' : gap.result.reason);
    if (gap.result.ok) {
      assert.ok(gap.result.target!.movedM > 500);
      const last = gap.result.path[gap.result.path.length - 1];
      assert.deepEqual([last[0].toFixed(6), last[1].toFixed(6)], [gap.result.target!.lon.toFixed(6), gap.result.target!.lat.toFixed(6)]);
    }
    // An exact end in the gap is refused, as before.
    const exact = searchMesh(store, START, [1.5, 2.5], SEARCH);
    assert.ok(!exact.result.ok);
  });
});

test('searchMeshRun: through a waypoint circle, cut where it enters it, then on to the end; the circle recorded', () => {
  withMesh(U, store => {
    const plan = {
      index: 0,
      lastIndex: 1,
      count: 2,
      vias: [{ lon: 0.5, lat: 1.5, radiusM: 20000 }],
      end: END,
      snapToExact: true,
    };
    const targets = runTargets(plan);
    assert.deepEqual(
      targets.map(t => [t.name, t.radiusM]),
      [
        ['waypoint 1', 20000],
        ['the destination', undefined],
      ]
    );
    const s = searchMeshRun(store, START, targets, SEARCH);
    assert.ok(s.result.ok, s.result.ok ? '' : s.result.reason);
    if (!s.result.ok) return;
    const c = s.result.circles!;
    assert.equal(c.length, 1);
    assert.equal(c[0].movedM, 0);
    const at = s.result.path[c[0].pathIndex];
    const d = haversineDistanceM(at[0], at[1], 0.5, 1.5);
    assert.ok(Math.abs(d - 20000) < 200, `entered the circle ${d} m from the waypoint`);
    const last = s.result.path[s.result.path.length - 1];
    assert.ok(haversineDistanceM(last[0], last[1], END[0], END[1]) < 1e-3, 'ends exactly on the end');
    assert.equal(s.result.widths.length, s.result.path.length);
    // A piece that fails names its target.
    const bad = searchMeshRun(
      store,
      START,
      [
        { lon: 0.5, lat: 1.5, radiusM: 20000, name: 'waypoint 1' },
        { lon: 1.5, lat: 2.5, name: 'the destination' },
      ],
      SEARCH
    );
    assert.ok(!bad.result.ok);
    if (!bad.result.ok) assert.equal(bad.result.reason, 'to the destination: end point is not in a mesh triangle');
  });
});

test('a waypoint aimed at a corner shared with other water: the chosen triangle decides, and the next piece starts in it', () => {
  // Two tiles touching only at the corner (1, 1): (0, 0) (ids 0, 1) and (1, 1) (ids 2, 3), no shared edge, two waters.
  withMesh(
    [
      { i: 0, j: 0 },
      { i: 1, j: 1 },
    ],
    store => {
      const start: [number, number] = [0.5, 0.4];
      // Aimed at the corner in triangle 0 (the lower one of (0, 0), which holds the corner): routed in the start's water.
      const s = searchMesh(store, start, [1, 1], SEARCH, null, { radiusM: 500, trim: false, aim: { lon: 1, lat: 1, tri: 0 } });
      assert.ok(s.result.ok, s.result.ok ? '' : s.result.reason);
      if (s.result.ok) assert.ok([0, 1].includes(s.result.endTri!), `ended in ${s.result.endTri}`);
      // A run: to the corner, then back into (0, 0): the second piece starts on the corner in the first piece's water.
      const run = searchMeshRun(
        store,
        start,
        [
          { lon: 1, lat: 1, radiusM: 1, name: 'waypoint 1', aim: { lon: 1, lat: 1, tri: 0 } },
          { lon: 0.2, lat: 0.8, name: 'the destination' },
        ],
        SEARCH
      );
      assert.ok(run.result.ok, run.result.ok ? '' : run.result.reason);
    }
  );
});
