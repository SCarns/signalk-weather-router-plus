/**
 * Where a leg from one chart mesh to another changes meshes (transfer.ts, part 5 step 2), on two meshes of 1° tiles
 * written to disk: A over lon 0–3, B over lon 2–5, both over lat 0–2, overlapping in the column lon 2–3. The leg runs
 * from (0.5, 0.5) in A to (4.5, 0.5) in B. The transfer point must be water both call usable, connected on B to the
 * end; a point only one calls usable is never used.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LandMask, moveMeetsCells } from '../../geo/landmask';
import type { ShapePolygon } from '../../geo/shapefile';
import { boundarySeeds, buildCoarseMap, type CoarseRules, meshRulesOf } from './coarse';
import { writeGridMesh } from './fixture';
import { PagedMesh } from './paged';
import { MeshStore } from './store';
import { findMeshGap, findMeshTransfer, type TransferMesh } from './transfer';

const RULES = { draughtM: 2, airDraftM: 18, motorSpeedMs: 3 };
const COARSE: CoarseRules = {
  draughtM: 2,
  airDraftM: 18,
  underKeelClearanceM: 0.5,
  overheadClearanceM: 1,
  bufferM: 0,
  openingBridges: 'open',
};
const START: [number, number] = [0.5, 0.5];
const END: [number, number] = [4.5, 0.5];
const NAMES = { start: 'the start', end: 'the end' };

/** Cells of lon i0 … i1 - 1, lat 0 … 1, 10 m deep unless `depth` says otherwise. */
function cells(i0: number, i1: number, depth: (i: number, j: number) => number = () => 10): { i: number; j: number; depth: number }[] {
  const out: { i: number; j: number; depth: number }[] = [];
  for (let i = i0; i < i1; i++) for (let j = 0; j < 2; j++) out.push({ i, j, depth: depth(i, j) });
  return out;
}

function withPair(a: ReturnType<typeof cells>, b: ReturnType<typeof cells>, fn: (from: TransferMesh, to: TransferMesh) => void): void {
  const da = writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-xfer-a-')), a);
  const db = writeGridMesh(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-xfer-b-')), b);
  try {
    const sa = MeshStore.open(da);
    const sb = MeshStore.open(db);
    const ba = boundarySeeds(sa, COARSE);
    const bb = boundarySeeds(sb, COARSE);
    const ma = buildCoarseMap(sa, COARSE, new PagedMesh(sa, meshRulesOf(COARSE), 1, ba));
    const mb = buildCoarseMap(sb, COARSE, new PagedMesh(sb, meshRulesOf(COARSE), 1, bb));
    fn({ store: sa, boundary: ba, map: ma, name: 'A' }, { store: sb, boundary: bb, map: mb, name: 'B' });
  } finally {
    fs.rmSync(da, { recursive: true, force: true });
    fs.rmSync(db, { recursive: true, force: true });
  }
}

function withMeshes(a: ReturnType<typeof cells>, b: ReturnType<typeof cells>, fn: (r: ReturnType<typeof findMeshTransfer>) => void): void {
  withPair(a, b, (from, to) => fn(findMeshTransfer(from, to, RULES, START, END, NAMES)));
}

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

/** Coastline land south of lat 0 and north of lat 2: the water between the meshes is open, the meshes' outer sides shore. */
const LAND = LandMask.fromPolygons(
  [rect(1, -1, -1, 7, 0), rect(2, -1, 2, 7, 3), rect(3, -1, -1, 0, 3), rect(4, 6, -1, 7, 3)],
  {
    west: -1,
    south: -1,
    east: 7,
    north: 3,
  },
  0.05
);

test('findMeshTransfer: the leg changes meshes in the overlap, on water both call usable', () => {
  withMeshes(cells(0, 3), cells(2, 5), r => {
    assert.ok(r.ok, r.ok ? '' : r.reason);
    if (!r.ok) return;
    const [lon, lat] = r.point;
    assert.ok(lon > 2 && lon < 3 && lat > 0 && lat < 1, `in the overlap, on the straight side: ${lon}, ${lat}`);
    assert.ok(r.transfers > 0 && r.tested >= r.transfers);
  });
});

test('findMeshTransfer: water only the start mesh calls usable is never the transfer point', () => {
  // B charts the overlap's southern cell at 1 m: A says usable there, B does not. The transfer goes north of it.
  withMeshes(
    cells(0, 3),
    cells(2, 5, (i, j) => (i === 2 && j === 0 ? 1 : 10)),
    r => {
      assert.ok(r.ok, r.ok ? '' : r.reason);
      if (!r.ok) return;
      const [lon, lat] = r.point;
      assert.ok(lon > 2 && lon < 3 && lat > 1 && lat < 2, `in the overlap's northern cell: ${lon}, ${lat}`);
    }
  );
});

test('findMeshTransfer: water both call usable but not connected on the end mesh to the end is no transfer point', () => {
  // On B the overlap's southern cell is deep but walled off from the end (lon 3–4 and the northern cell shallow).
  withMeshes(
    cells(0, 3),
    cells(2, 5, (i, j) => (i === 3 || (i === 2 && j === 1) ? 1 : 10)),
    r => {
      assert.ok(!r.ok);
      if (!r.ok)
        assert.equal(
          r.reason,
          'no water on A connects the start to water that both A and B call usable for this boat and that connects on B to the end'
        );
    }
  );
});

test('findMeshTransfer: meshes that do not overlap are refused, naming them', () => {
  withMeshes(cells(0, 2), cells(3, 5), r => {
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.reason, 'the chart meshes A and B do not overlap');
  });
});

test("findMeshGap: meshes with water between them: out of the first at its edge facing the second, in at the second's edge; both meshes' water is land between", () => {
  withPair(cells(0, 2), cells(3, 6), (from, to) => {
    const r = findMeshGap(from, to, RULES, LAND, START, END, NAMES);
    assert.ok(r.ok, r.ok ? '' : r.reason);
    if (!r.ok) return;
    assert.ok(Math.abs(r.exit[0] - 2) < 1e-9 && r.exit[1] > 0 && r.exit[1] < 2, `exit on A's east edge: ${r.exit}`);
    assert.ok(Math.abs(r.entry[0] - 3) < 1e-9 && r.entry[1] > 0 && r.entry[1] < 2, `entry on B's west edge: ${r.entry}`);
    assert.equal(moveMeetsCells(r.mask, 1, 0.5, 1, 1.5), true, "A's water");
    assert.equal(moveMeetsCells(r.mask, 4.5, 0.5, 4.5, 1.5), true, "B's water");
    assert.equal(moveMeetsCells(r.mask, 2.3, 1, 2.7, 1), false, 'the water between');
  });
});

test("findMeshGap: the second mesh's edge water not connected on it to the end is no entry; the route is refused, naming why", () => {
  // B's column lon 4–5 is 1 m deep: its west edge (lon 3) does not connect to the end (lon 5.5).
  withPair(
    cells(0, 2),
    cells(3, 6, i => (i === 4 ? 1 : 10)),
    (from, to) => {
      const r = findMeshGap(from, to, RULES, LAND, START, [5.5, 0.5], NAMES);
      assert.ok(!r.ok);
      if (!r.ok)
        assert.equal(
          r.reason,
          "no water on B that this boat can use and that connects to the end meets the coastline's water within the area"
        );
    }
  );
});

test("findMeshTransfer: the start's water cut off from the overlap is refused from the rough cuts", () => {
  // A's column lon 1–2 is 1 m deep: the start's water (lon 0–1) never reaches the overlap.
  withMeshes(
    cells(0, 3, i => (i === 1 ? 1 : 10)),
    cells(2, 5),
    r => {
      assert.ok(!r.ok);
      if (!r.ok)
        assert.equal(
          r.reason,
          'no water on A connects the start to water that both A and B call usable for this boat and that connects on B to the end'
        );
    }
  );
});
