/**
 * A* over the global water grid (geo/watergrid.ts) inside a window of
 * rows × (unwrapped) columns, so memory stays bounded and a window may
 * cross the antimeridian (columns are taken modulo the grid width).
 *
 *  - Moves: the four orthogonal moves the grid allows (following split
 *    cells' components), plus diagonals where both L-shaped paths
 *    through the two side cells are open (WaterGrid.diagOpen), so a
 *    diagonal never cuts a land corner.
 *  - Cost: distance between cell centres times a coast penalty (up to
 *    1.4× next to land, fading to 1 at COAST_RADIUS cells), which keeps
 *    the corridor off the coast where there is room. Narrow passages are
 *    penalised uniformly across, so they are not avoided unless a
 *    comparable open-water way exists.
 *  - Heuristic: great-circle distance to the goal point, minus the goal
 *    cells' radius (admissible), optionally weighted (heuristicWeight).
 *
 * Memory: 7 bytes per window cell (Float32 cost, direction byte, closed
 * flag, coast memo), plus maps for split-cell components and the heap.
 */

import { DEG, R_EARTH_M, haversineDistanceM } from '../geo/geodesy';
import type { WaterGrid } from '../geo/watergrid';

export interface GridNode {
  r: number;
  /** Column, unwrapped (may be < 0 or ≥ nx inside an antimeridian-crossing window). */
  c: number;
  /** Split-cell component, 0 for an ordinary cell. */
  comp: number;
}

export interface GridWindow {
  r0: number;
  r1: number;
  /** Unwrapped columns [c0, c1]; c1 - c0 + 1 ≤ nx. */
  c0: number;
  c1: number;
}

export interface GridSource extends GridNode {
  /** Initial cost (m), e.g. the distance from the exact start point. */
  cost: number;
}

export interface GridAstarResult {
  path: GridNode[];
  /** Penalised cost of the path, m. */
  cost: number;
  expanded: number;
  windowCells: number;
}

export class GridAstarError extends Error {
  constructor(
    message: string,
    readonly exhausted: boolean,
    readonly expanded: number
  ) {
    super(message);
    this.name = 'GridAstarError';
  }
}

const COAST_RADIUS = 4;
const COAST_MAX_PENALTY = 0.4;
const M_PER_DEG = R_EARTH_M * DEG;

/** Coast penalty factor for a Chebyshev distance to land in cells (1 = adjacent). */
export function coastFactor(d: number): number {
  if (d > COAST_RADIUS) return 1;
  return 1 + (COAST_MAX_PENALTY * (COAST_RADIUS + 1 - d)) / COAST_RADIUS;
}

class Heap {
  private k = new Float64Array(1 << 14);
  private v = new Float64Array(1 << 14);
  size = 0;
  push(key: number, val: number): void {
    if (this.size === this.k.length) {
      const k2 = new Float64Array(this.k.length * 2);
      k2.set(this.k);
      this.k = k2;
      const v2 = new Float64Array(this.v.length * 2);
      v2.set(this.v);
      this.v = v2;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p];
      this.v[i] = this.v[p];
      i = p;
    }
    this.k[i] = key;
    this.v[i] = val;
  }
  pop(): number {
    const top = this.v[0];
    const lastK = this.k[--this.size];
    const lastV = this.v[this.size];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= this.size) break;
      const r = l + 1;
      const m = r < this.size && this.k[r] < this.k[l] ? r : l;
      if (this.k[m] >= lastK) break;
      this.k[i] = this.k[m];
      this.v[i] = this.v[m];
      i = m;
    }
    this.k[i] = lastK;
    this.v[i] = lastV;
    return top;
  }
}

// Direction codes 0..7: E, N, W, S, NE, NW, SW, SE.
const DR = [0, 1, 0, -1, 1, 1, -1, -1];
const DC = [1, 0, -1, 0, 1, -1, -1, 1];

export interface GridAstarOptions {
  /** Global cell indices that must not be entered. */
  blocked?: Set<number>;
  /** Stop after this many expansions (throws, not exhausted). */
  maxExpansions?: number;
  shouldCancel?: () => boolean;
  /** Heuristic weight (≥ 1): > 1 trades optimality (cost ≤ weight × optimal) for fewer expansions. */
  heuristicWeight?: number;
}

/**
 * Cheapest path from any source to any goal node inside the window.
 * Throws GridAstarError when the goal cannot be reached inside it
 * (`exhausted` = the reachable set was fully explored).
 */
export function gridAstar(
  grid: WaterGrid,
  win: GridWindow,
  sources: GridSource[],
  goals: GridNode[],
  goalLonLat: [number, number],
  goalRadiusM: number,
  opts: GridAstarOptions = {}
): GridAstarResult {
  const W = win.c1 - win.c0 + 1;
  const H = win.r1 - win.r0 + 1;
  if (W <= 0 || H <= 0 || W > grid.nx) throw new Error(`gridAstar: bad window ${JSON.stringify(win)}`);
  const n = W * H;
  const g = new Float32Array(n).fill(Infinity);
  // bit 7 closed; bits 0-2 direction to the parent's move (the move that entered); bits 3-6 parent component.
  const dir = new Uint8Array(n).fill(0xff & 0x7f);
  const closed = new Uint8Array(n);
  const coast = new Uint8Array(n);
  const splitG = new Map<number, number>();
  const splitPar = new Map<number, number>();
  const splitClosed = new Set<number>();
  const blocked = opts.blocked;
  const res = grid.res;
  const cosRow = new Float64Array(H);
  for (let i = 0; i < H; i++) cosRow[i] = Math.cos((-90 + (win.r0 + i + 0.5) * res) * DEG);
  const dyM = res * M_PER_DEG;
  const [gLon, gLat] = goalLonLat;
  // A full-width window wraps: columns are taken modulo the grid width into [c0, c1].
  const full = W === grid.nx;
  const norm = (c: number): number => (full ? win.c0 + grid.wrapCol(c - win.c0) : c);
  const inWin = (r: number, c: number): boolean => r >= win.r0 && r <= win.r1 && c >= win.c0 && c <= win.c1;
  const li = (r: number, c: number): number => (r - win.r0) * W + (c - win.c0);
  const key = (l: number, comp: number): number => l * 16 + comp;
  const goalSet = new Set<number>();
  for (const q of goals) if (inWin(q.r, norm(q.c))) goalSet.add(key(li(q.r, norm(q.c)), q.comp));
  if (goalSet.size === 0) throw new GridAstarError('goal outside the search window', false, 0);
  const hw = opts.heuristicWeight ?? 1;
  const heuristic = (r: number, c: number): number => {
    const lon = -180 + (c + 0.5) * res;
    const lat = -90 + (r + 0.5) * res;
    return hw * Math.max(0, haversineDistanceM(lon, lat, gLon, gLat) - goalRadiusM);
  };
  const coastDist = (r: number, c: number, l: number): number => {
    const m = coast[l];
    if (m) return m;
    let d = COAST_RADIUS + 1;
    outer: for (let rad = 1; rad <= COAST_RADIUS; rad++) {
      for (let dr = -rad; dr <= rad; dr++) {
        const step = Math.abs(dr) === rad ? 1 : 2 * rad;
        for (let dc = -rad; dc <= rad; dc += step) {
          if (!grid.isWater(r + dr, c + dc)) {
            d = rad;
            break outer;
          }
        }
      }
    }
    coast[l] = d;
    return d;
  };
  const getG = (k: number): number => (k % 16 === 0 ? g[k / 16] : (splitG.get(k) ?? Infinity));
  const heap = new Heap();
  for (const s0 of sources) {
    const s = { ...s0, c: norm(s0.c) };
    if (!inWin(s.r, s.c)) continue;
    if (!grid.isWater(s.r, s.c)) continue;
    const l = li(s.r, s.c);
    const k = key(l, s.comp);
    if (s.cost < getG(k)) {
      if (s.comp === 0) {
        g[l] = s.cost;
        dir[l] = 0x7f;
      } else {
        splitG.set(k, s.cost);
        splitPar.set(k, -1);
      }
      heap.push(s.cost + heuristic(s.r, s.c), k);
    }
  }
  let expanded = 0;
  const maxExp = opts.maxExpansions ?? Infinity;
  let found = -1;
  while (heap.size > 0) {
    const k = heap.pop();
    const comp = k % 16;
    const l = (k - comp) / 16;
    if (comp === 0) {
      if (closed[l]) continue;
      closed[l] = 1;
    } else {
      if (splitClosed.has(k)) continue;
      splitClosed.add(k);
    }
    if (goalSet.has(k)) {
      found = k;
      break;
    }
    if (++expanded > maxExp) throw new GridAstarError(`search stopped after ${maxExp} expansions`, false, expanded);
    if ((expanded & 0xffff) === 0 && opts.shouldCancel?.()) throw new GridAstarError('cancelled', false, expanded);
    const r = win.r0 + Math.floor(l / W);
    const c = win.c0 + (l % W);
    const gk = getG(k);
    const cosR = cosRow[r - win.r0];
    const relax = (r2: number, c2u: number, comp2: number, stepM: number, d: number): void => {
      const c2 = norm(c2u);
      if (!inWin(r2, c2)) return;
      if (blocked && blocked.has(r2 * grid.nx + grid.wrapCol(c2))) return;
      const l2 = li(r2, c2);
      const k2 = key(l2, comp2);
      const ng = gk + stepM * coastFactor(coastDist(r2, c2, l2));
      if (comp2 === 0) {
        if (closed[l2] || ng >= g[l2]) return;
        g[l2] = ng;
        dir[l2] = d | (comp << 3);
      } else {
        if (splitClosed.has(k2) || ng >= (splitG.get(k2) ?? Infinity)) return;
        splitG.set(k2, ng);
        splitPar.set(k2, k);
      }
      heap.push(ng + heuristic(r2, c2), k2);
    };
    grid.neighbours(r, c, comp, (dr, dc, comp2) => {
      const d = dc === 1 ? 0 : dr === 1 ? 1 : dc === -1 ? 2 : 3;
      const stepM = dr === 0 ? dyM * cosR : dyM;
      relax(r + dr, c + dc, comp2, stepM, d);
    });
    if (comp === 0) {
      for (let d = 4; d < 8; d++) {
        const dr = DR[d];
        const dc = DC[d];
        if (!grid.diagOpen(r, c, dr, dc)) continue;
        const cm = Math.cos((-90 + (r + 0.5 + dr / 2) * res) * DEG);
        relax(r + dr, c + dc, 0, dyM * Math.sqrt(1 + cm * cm), d);
      }
    }
  }
  if (found < 0) throw new GridAstarError('no water path inside the search window', true, expanded);
  // Reconstruct.
  const path: GridNode[] = [];
  let k = found;
  let guard = 0;
  while (k >= 0 && guard++ < n * 2) {
    const comp = k % 16;
    const l = (k - comp) / 16;
    const r = win.r0 + Math.floor(l / W);
    const c = win.c0 + (l % W);
    path.push({ r, c, comp });
    if (comp === 0) {
      const b = dir[l];
      if ((b & 0x7f) === 0x7f) break; // source
      const d = b & 7;
      const pc = (b >> 3) & 0xf;
      k = key(li(r - DR[d], norm(c - DC[d])), pc);
    } else {
      k = splitPar.get(k) ?? -1;
    }
  }
  path.reverse();
  return { path, cost: getG(found), expanded, windowCells: n };
}

/**
 * Line of sight between two cell centres on the grid: every cell border
 * the straight segment (in grid coordinates) crosses must be open, it
 * must not touch a split or blocked cell, and a corner crossing needs the
 * diagonal rule.
 */
export function gridLineOfSight(grid: WaterGrid, a: GridNode, b: GridNode, blocked?: Set<number>): boolean {
  if (a.comp || b.comp) return false;
  const x1 = a.c + 0.5;
  const y1 = a.r + 0.5;
  const x2 = b.c + 0.5;
  const y2 = b.r + 0.5;
  let cx = a.c;
  let cy = a.r;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const sx = dx > 0 ? 1 : -1;
  const sy = dy > 0 ? 1 : -1;
  const tDx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  let tMaxX = dx !== 0 ? 0.5 * tDx : Infinity;
  let tMaxY = dy !== 0 ? 0.5 * tDy : Infinity;
  const bad = (r: number, c: number): boolean =>
    grid.isSplit(r, c) || !grid.isWater(r, c) || (!!blocked && blocked.has(r * grid.nx + grid.wrapCol(c)));
  let guard = 0;
  while ((cx !== b.c || cy !== b.r) && guard++ < 100_000) {
    if (Math.abs(tMaxX - tMaxY) < 1e-12) {
      if (!grid.diagOpen(cy, cx, sy, sx)) return false;
      if (bad(cy, cx + sx) || bad(cy + sy, cx)) return false;
      cx += sx;
      cy += sy;
      tMaxX += tDx;
      tMaxY += tDy;
    } else if (tMaxX < tMaxY) {
      if (!grid.orthOpen(cy, cx, 0, sx)) return false;
      cx += sx;
      tMaxX += tDx;
    } else {
      if (!grid.orthOpen(cy, cx, sy, 0)) return false;
      cy += sy;
      tMaxY += tDy;
    }
    if (bad(cy, cx)) return false;
  }
  return true;
}

/**
 * Greedy string pulling: from each anchor, jump to the farthest later
 * node (within `maxCells` cells) in line of sight. Split-cell nodes are
 * always kept.
 */
export function smoothGridPath(grid: WaterGrid, path: GridNode[], maxCells = 150, blocked?: Set<number>): GridNode[] {
  if (path.length <= 2) return path.slice();
  const out: GridNode[] = [path[0]];
  let i = 0;
  while (i < path.length - 1) {
    let best = i + 1;
    for (let j = path.length - 1; j > i + 1; j--) {
      if (Math.max(Math.abs(path[j].r - path[i].r), Math.abs(path[j].c - path[i].c)) > maxCells) continue;
      if (gridLineOfSight(grid, path[i], path[j], blocked)) {
        best = j;
        break;
      }
    }
    out.push(path[best]);
    i = best;
  }
  return out;
}

/** Length of a node path (cell centres), metres. */
export function gridPathLengthM(grid: WaterGrid, path: GridNode[]): number {
  let d = 0;
  for (let i = 1; i < path.length; i++) {
    const [lo1, la1] = grid.cellCentre(path[i - 1].r, path[i - 1].c);
    const [lo2, la2] = grid.cellCentre(path[i].r, path[i].c);
    d += haversineDistanceM(lo1, la1, lo2, la2);
  }
  return d;
}
