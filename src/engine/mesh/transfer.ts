/**
 * Where a leg from one district's chart mesh to another's changes meshes, where the two overlap
 * (docs/drafts/mesh-no-gshhg-design.md, part 5 step 2): the leg stays on the charts the whole way, no coastline.
 *
 * A transfer point is a triangle of the start's mesh (A), in a tile whose extent meets one of the end's mesh (B),
 * whose centre both meshes call usable for this boat under the leg's rules (B: a usable triangle holds it), and whose
 * water in B connects to the leg's end (B's rough cut, PieceGraph). Neighbouring districts' charts mostly agree in
 * their overlap, but not everywhere (measured 2026-10-12 on brain, 100 points per shared tile under the same rules:
 * 07CGD/08CGD 3.6% of points usable in one and blocked in the other, 01CGD/05CGD 3.2%, 05CGD/07CGD 0.1%), so a point
 * only one calls usable is never used.
 *
 * The mesh search on A goes from the start to the cheapest transfer point, each costed as its route on A plus the
 * straight run from it to the end (which never overestimates the rest on B). The test is made as the search reaches
 * each triangle, not over the whole overlap first; B's tiles are dropped once no tile of A the search holds meets them.
 * The leg is then planned on A to that point and on B from it (pipeline.ts); the final depth check walks both meshes,
 * and a stretch either calls unusable fails the route (check.ts).
 *
 * Where the two do not connect in their overlap (or do not overlap), the leg crosses the gap on the coastline search
 * (findMeshGap), with the part 5 exits from both sides: the coastline's water, outside both meshes, is flooded from
 * B's edge sides whose water connects to the end; A's exit is chosen as for a leg leaving the charts (exit.ts), towards
 * the end; B's entry by the search on B from the end towards the exit, among B's sides that the water from A's exit
 * reaches. The coastline part runs between them with both meshes' water as land.
 */

import type { CellMask, LandMask } from '../../geo/landmask';
import { cellOf } from '../../geo/landmask';
import { DROP_EVERY, meshAstar } from './astar';
import { emptyMask, floodFree, forEachEdgeSide, isFree, markMeshWater } from './exit';
import { type CoarseMap, PieceGraph } from './coarse';
import { type BoundarySeeds, PagedMesh } from './paged';
import type { MeshRules } from './route';
import type { MeshStore } from './store';

export interface TransferMesh {
  store: MeshStore;
  /** The rough cut's tile-boundary record for this boat (seeds the buffer across tile edges). */
  boundary: BoundarySeeds | null;
  /** For the messages. */
  name: string;
}

export type MeshTransferResult =
  | {
      ok: true;
      /** Where the leg changes meshes: the transfer triangle's centre, [lon, lat]. */
      point: [number, number];
      /** Tiles of A whose extent meets one of B's; triangles tested there; of those, transfer points. */
      sharedTiles: number;
      tested: number;
      transfers: number;
      expanded: number;
    }
  | { ok: false; reason: string };

type Box = [number, number, number, number];
const meets = (a: Box, b: Box): boolean => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

export function findMeshTransfer(
  from: TransferMesh,
  /** The end's mesh, with its rough cut for the leg's rules (without the areas to avoid: PieceGraph applies them). */
  to: TransferMesh & { map: CoarseMap },
  rules: MeshRules,
  start: [number, number],
  end: [number, number],
  names: { start: string; end: string }
): MeshTransferResult {
  // One frame for both meshes (the leg's), so a point of A is the same point of B.
  const cl = Math.cos((((start[1] + end[1]) / 2) * Math.PI) / 180);
  const pa = new PagedMesh(from.store, rules, cl, from.boundary);
  const pb = new PagedMesh(to.store, rules, cl, to.boundary);
  const { groupOf, endGroups } = endWater(pb, to.map, end);
  if (!endGroups.length) return { ok: false, reason: `${to.name} has no water this boat can use` };
  const bBoxes = to.store.index.tiles.map(t => t.bbox);
  const shared = new Set<number>();
  for (let idx = 0; idx < pa.tileCount; idx++) {
    const a = pa.infoAt(idx)!.bbox;
    if (bBoxes.some(b => meets(a, b))) shared.add(idx);
  }
  if (!shared.size) return { ok: false, reason: `the chart meshes ${from.name} and ${to.name} do not overlap` };
  const [ex, ey] = pb.toXY(end[0], end[1]);
  const [sx, sy] = pa.toXY(start[0], start[1]);
  const starts = pa.locateAll(sx, sy);
  if (!starts.length) return { ok: false, reason: `${names.start} is not on water this boat can use on ${from.name}` };
  const memo = new Map<number, { x: number; y: number; restS: number } | null>();
  let tested = 0;
  let transfers = 0;
  const transferAt = {
    get: (t: number): { x: number; y: number; restS: number } | undefined => {
      const known = memo.get(t);
      if (known !== undefined) return known ?? undefined;
      let e: { x: number; y: number; restS: number } | null = null;
      const T = pa.tileOf(t);
      if (shared.has(T.idx)) {
        const q = (t - T.first) * 3;
        const cx = (T.x[q] + T.x[q + 1] + T.x[q + 2]) / 3;
        const cy = (T.y[q] + T.y[q + 1] + T.y[q + 2]) / 3;
        const [lon, lat] = pa.fromXY(cx, cy);
        tested++;
        // Each leg part is planned on the mesh covering its ends (the runner's choice), so both must cover the point.
        if (
          from.store.covers(lon, lat) &&
          to.store.covers(lon, lat) &&
          pb.locateAll(cx, cy).some(g => endGroups.includes(groupOf(g) ?? -1))
        ) {
          e = { x: cx, y: cy, restS: Math.hypot(ex - cx, ey - cy) / rules.motorSpeedMs };
          transfers++;
        }
        // B's tiles go once no tile of A the search holds meets them.
        if (tested % DROP_EVERY === 0) {
          const held = pa.heldTiles().map(i => pa.infoAt(i)!.bbox);
          for (const idx of pb.heldTiles()) if (!held.some(a => meets(a, pb.infoAt(idx)!.bbox))) pb.drop(idx);
        }
      }
      memo.set(t, e);
      return e ?? undefined;
    },
  };
  const res = meshAstar(pa, starts, [], sx, sy, ex, ey, rules.motorSpeedMs, transferAt);
  if (res.goalNode === -2 || res.goalTri < 0)
    return {
      ok: false,
      reason: `no water on ${from.name} connects ${names.start} to water that both ${from.name} and ${to.name} call usable for this boat and that connects on ${to.name} to ${names.end}`,
    };
  const e = memo.get(res.goalTri)!;
  return { ok: true, point: pa.fromXY(e.x, e.y), sharedTiles: shared.size, tested, transfers, expanded: res.expanded };
}

/**
 * The end's water on B (its rough cut, PieceGraph): the connected groups the end's point touches, or that of the usable
 * water nearest it (an approximate end on water the boat cannot use); none when B has no usable water.
 */
function endWater(pb: PagedMesh, map: CoarseMap, end: [number, number]): { groupOf: (g: number) => number | null; endGroups: number[] } {
  const graph = new PieceGraph(map, pb);
  const groupOf = (g: number): number | null => {
    const p = graph.pieceOf(g);
    return p === null ? null : graph.component(p);
  };
  const [ex, ey] = pb.toXY(end[0], end[1]);
  const endGroups = [...new Set(pb.locateAll(ex, ey).map(groupOf))].filter((c): c is number => c !== null);
  if (!endGroups.length) {
    const nu = pb.nearestUsable(ex, ey);
    if (nu) endGroups.push(groupOf(nu.tri)!);
  }
  return { groupOf, endGroups };
}

export type MeshGapResult =
  | {
      ok: true;
      /** Where the leg leaves A and enters B: the middles of the sides crossed (on each mesh), [lon, lat]. */
      exit: [number, number];
      entry: [number, number];
      /** A's sides the coastline's water from B reaches; B's sides the water from the exit reaches. */
      exits: number;
      entries: number;
      /** Both meshes' water on the coastline raster (1 = a mesh triangle holds the cell's centre), the exit's and entry's cells cleared. */
      mask: CellMask;
    }
  | { ok: false; reason: string };

/** A leg from mesh A to mesh B across water neither charts (see the header): A's exit and B's entry. */
export function findMeshGap(
  from: TransferMesh,
  to: TransferMesh & { map: CoarseMap },
  rules: MeshRules,
  /** The coastline search's land for the leg's area (its raster, at its resolution, with its land buffer). */
  land: LandMask,
  start: [number, number],
  end: [number, number],
  names: { start: string; end: string }
): MeshGapResult {
  const mask = emptyMask(land);
  markMeshWater(from.store, mask);
  markMeshWater(to.store, mask);
  const cl = Math.cos((((start[1] + end[1]) / 2) * Math.PI) / 180);
  const pa = new PagedMesh(from.store, rules, cl, from.boundary);
  const pb = new PagedMesh(to.store, rules, cl, to.boundary);
  const { groupOf, endGroups } = endWater(pb, to.map, end);
  if (!endGroups.length) return { ok: false, reason: `${to.name} has no water this boat can use` };
  // B's sides on water connected to the end whose outside is the coastline's water: the flood's seeds.
  const sides = new Map<number, { x: number; y: number; cell: number }>();
  forEachEdgeSide(pb, mask, (g, mx, my, c) => {
    if (c < 0 || !isFree(land, mask, c) || !endGroups.includes(groupOf(g) ?? -1)) return;
    if (!sides.has(g)) sides.set(g, { x: mx, y: my, cell: c });
  });
  if (!sides.size)
    return {
      ok: false,
      reason: `no water on ${to.name} that this boat can use and that connects to ${names.end} meets the coastline's water within the area`,
    };
  const reached = floodFree(
    land,
    mask,
    [...sides.values()].map(v => v.cell)
  );
  // A's exits: sides whose outside that water reaches, each costed on to the end by the straight run.
  const [ex, ey] = pa.toXY(end[0], end[1]);
  const exits = new Map<number, { x: number; y: number; restS: number; cell: number }>();
  forEachEdgeSide(pa, mask, (g, mx, my, c) => {
    if (c < 0 || !reached[c]) return;
    const restS = Math.hypot(ex - mx, ey - my) / rules.motorSpeedMs;
    const prev = exits.get(g);
    if (!prev || restS < prev.restS) exits.set(g, { x: mx, y: my, restS, cell: c });
  });
  if (!exits.size)
    return {
      ok: false,
      reason: `the coastline's water from ${to.name}'s water that connects to ${names.end} meets no water on ${from.name} this boat can use within the area`,
    };
  const [sx, sy] = pa.toXY(start[0], start[1]);
  const starts = pa.locateAll(sx, sy);
  if (!starts.length) return { ok: false, reason: `${names.start} is not on water this boat can use on ${from.name}` };
  const ra = meshAstar(pa, starts, [], sx, sy, ex, ey, rules.motorSpeedMs, exits);
  if (ra.goalNode === -2 || ra.goalTri < 0)
    return {
      ok: false,
      reason: `no water on ${from.name} connects ${names.start} to where its charts meet the coastline's water that reaches ${to.name}`,
    };
  const x = exits.get(ra.goalTri)!;
  // B's entries: its sides on the end's water that the coastline's water from the exit reaches.
  const fromExit = floodFree(land, mask, [x.cell]);
  const entries = new Map<number, { x: number; y: number; restS: number }>();
  for (const [g, v] of sides)
    if (fromExit[v.cell]) entries.set(g, { x: v.x, y: v.y, restS: Math.hypot(v.x - x.x, v.y - x.y) / rules.motorSpeedMs });
  // The search on B from the end (its usable triangles, or the usable water nearest it on the end's water).
  const [bx, by] = pb.toXY(end[0], end[1]);
  let ends = pb.locateAll(bx, by).filter(g => endGroups.includes(groupOf(g) ?? -1));
  let [fx, fy] = [bx, by];
  if (!ends.length) {
    const nu = pb.nearestUsable(bx, by, g => endGroups.includes(groupOf(g) ?? -1))!;
    ends = [nu.tri];
    [fx, fy] = [nu.x, nu.y];
  }
  const rb = meshAstar(pb, ends, [], fx, fy, x.x, x.y, rules.motorSpeedMs, entries);
  if (rb.goalNode === -2 || rb.goalTri < 0)
    return {
      ok: false,
      reason: `no water on ${to.name} connects ${names.end} to where its charts meet the coastline's water from ${from.name}`,
    };
  const y = entries.get(rb.goalTri)!;
  const exit = pa.fromXY(x.x, x.y);
  const entry = pb.fromXY(y.x, y.y);
  // The cells the leg crosses in belong to the coastline search too (where it meets each mesh).
  for (const p of [exit, entry]) {
    const c = cellOf(mask, p[0], p[1]);
    if (c >= 0) mask.cells[c] = 0;
  }
  return { ok: true, exit, entry, exits: exits.size, entries: entries.size, mask };
}
