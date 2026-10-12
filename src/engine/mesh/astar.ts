/**
 * A* over the directed edges of a triangle mesh: a node is (triangle t,
 * edge k it was entered through), node id t*3+k with t a global triangle
 * id; moving to a neighbour costs the distance between the two edge
 * midpoints times the triangle's penalty multiplier, divided by the boat
 * speed (seconds). The heuristic is the straight-line time to the end
 * point. Port of the numba search in the experiment's mesh_route5.py (same
 * expansion order: heap.ts orders ties as that heap did).
 *
 * Several start and end triangles (a point on a corner or edge touches each of them, paged.ts locateAll): the
 * search starts from all of them at cost 0 and arrives at any of them, so a stop on a corner shared with other water
 * cannot send it into that water.
 *
 * On the paged mesh (paged.ts): no area is given; a tile is read when the
 * search first reaches it. The search's bookkeeping (cost, came-from, open
 * or closed) is kept per tile touched for the whole search; a tile's chart
 * data is dropped when no open node of the frontier lies in it, and read
 * again if the search comes back (docs/drafts/mesh-no-gshhg-design.md, part 4
 * revised: on brain this held the worst leg at 1.1 GB instead of 2.8 GB, the
 * same route cost on all 31 legs measured).
 */

import { MinHeap } from '../heap';
import type { PagedMesh, PagedTile } from './paged';

/** How often (expansions) tiles with no open node left are dropped: a batch, not a tuning of the route. */
const DROP_EVERY = 1024;

/** Per tile touched: cost per node, the node each was reached from (-1: the start point), state 0 new, 1 open, 2 closed. */
interface TileState {
  g: Float64Array;
  came: Int32Array;
  state: Uint8Array;
  open: number;
}

export interface MeshSearchResult {
  /** The node an end triangle was reached through, -1 when a start triangle is an end triangle, -2 when no route. */
  goalNode: number;
  /** The start triangle the route leaves from (global id). */
  startTri: number;
  /** Cost of the whole route, seconds. */
  goalG: number;
  expanded: number;
  /** The edges crossed from the start to the goal, each [global triangle left, its edge k], in order. */
  crossings: () => [number, number][];
}

export function meshAstar(
  pm: PagedMesh,
  starts: number | number[],
  ends: number | number[],
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  speedMs: number
): MeshSearchResult {
  const states = new Map<number, TileState>();
  const stateOf = (T: PagedTile): TileState => {
    let s = states.get(T.idx);
    if (!s) {
      s = { g: new Float64Array(T.n * 3).fill(Infinity), came: new Int32Array(T.n * 3).fill(-1), state: new Uint8Array(T.n * 3), open: 0 };
      states.set(T.idx, s);
    }
    return s;
  };
  const midX = (T: PagedTile, l: number, k: number): number => (T.x[l * 3 + k] + T.x[l * 3 + ((k + 1) % 3)]) / 2;
  const midY = (T: PagedTile, l: number, k: number): number => (T.y[l * 3 + k] + T.y[l * 3 + ((k + 1) % 3)]) / 2;
  const heap = new MinHeap();
  let goalG = Infinity;
  let goalNode = -2;
  const st = Array.isArray(starts) ? starts : [starts];
  const goals = new Set(Array.isArray(ends) ? ends : [ends]);
  let direct = st[0];
  for (const s0 of st) {
    if (!goals.has(s0)) continue;
    const S0 = pm.tileOf(s0);
    const g = (Math.hypot(ex - sx, ey - sy) * S0.mult[s0 - S0.first]) / speedMs;
    if (g < goalG) {
      goalG = g;
      goalNode = -1;
      direct = s0;
    }
  }
  // Leaving triangle (T, l) through its edges other than kin, from cost g0 at (hx, hy), reached from node `from`.
  const relax = (T: PagedTile, l: number, kin: number, g0: number, hx: number, hy: number, from: number): void => {
    for (let k2 = 0; k2 < 3; k2++) {
      if (k2 === kin) continue;
      const n = T.nb[l * 3 + k2];
      if (n < 0) continue;
      const mx = midX(T, l, k2);
      const my = midY(T, l, k2);
      const kn = T.rev[l * 3 + k2];
      const gc = g0 + (Math.hypot(mx - hx, my - hy) * T.mult[l]) / speedMs;
      const U = pm.tileOf(n);
      const ln = n - U.first;
      if (U.blocked[ln]) continue;
      const S = stateOf(U);
      const q = ln * 3 + kn;
      if (gc < S.g[q]) {
        S.g[q] = gc;
        S.came[q] = from;
        if (S.state[q] === 0) {
          S.state[q] = 1;
          S.open++;
        }
        heap.push(gc + Math.hypot(mx - ex, my - ey) / speedMs, n * 3 + kn);
      }
    }
  };
  // From each start triangle; the node came from encodes which: -2 - its index in `st`.
  st.forEach((s0, k) => {
    const S0 = pm.tileOf(s0);
    relax(S0, s0 - S0.first, -1, 0, sx, sy, -2 - k);
  });
  let expanded = 0;
  const pinnedTiles = new Set([...st, ...goals].map(t => pm.tileIndexOf(t)));
  const pinned = (idx: number): boolean => pinnedTiles.has(idx);
  while (heap.size > 0) {
    const f = heap.peekKey();
    const node = heap.pop();
    if (f >= goalG) break;
    const t = Math.floor(node / 3);
    const kin = node % 3;
    const T = pm.tileOf(t);
    const l = t - T.first;
    const S = stateOf(T);
    const q = l * 3 + kin;
    if (S.state[q] === 2) continue;
    if (S.state[q] === 1) S.open--;
    S.state[q] = 2;
    expanded++;
    const hx = midX(T, l, kin);
    const hy = midY(T, l, kin);
    if (goals.has(t)) {
      const gg = S.g[q] + (Math.hypot(ex - hx, ey - hy) * T.mult[l]) / speedMs;
      if (gg < goalG) {
        goalG = gg;
        goalNode = node;
      }
    }
    relax(T, l, kin, S.g[q], hx, hy, node);
    if (expanded % DROP_EVERY === 0)
      for (const idx of pm.heldTiles()) {
        const s = states.get(idx);
        if ((!s || s.open === 0) && !pinned(idx)) pm.drop(idx);
      }
  }
  const cameOf = (node: number): number => {
    const t = Math.floor(node / 3);
    const T = pm.tileOf(t);
    return states.get(T.idx)!.came[(t - T.first) * 3 + (node % 3)];
  };
  // The start triangle the route leaves from: the one its first crossing came from.
  let startTri = direct;
  if (goalNode >= 0) {
    let node = goalNode;
    while (cameOf(node) >= 0) node = cameOf(node);
    startTri = st[-2 - cameOf(node)];
  }
  return {
    goalNode,
    startTri,
    goalG,
    expanded,
    crossings: () => {
      const out: [number, number][] = [];
      for (let node = goalNode; node >= 0; node = cameOf(node)) {
        const t = Math.floor(node / 3);
        const prev = cameOf(node);
        const from = prev < 0 ? st[-2 - prev] : Math.floor(prev / 3);
        // The edge of `from` whose neighbour is t: the one crossed.
        const F = pm.tileOf(from);
        const lf = from - F.first;
        let k = 0;
        while (k < 3 && F.nb[lf * 3 + k] !== t) k++;
        out.push([from, k]);
      }
      return out.reverse();
    },
  };
}
