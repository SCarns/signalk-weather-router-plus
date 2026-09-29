/**
 * Motor-only A* over a NavigabilityGrid. Port of the routing engine's
 * `router.compute_route` / `_astar_inner` / `_compute_shore_cost`:
 *
 *  - 16-neighbour moves (8 cardinal/diagonal + 8 knight moves); a move
 *    is allowed only when the landing cell and every cell it passes
 *    are passable, so one-cell-thick land cannot be hopped.
 *  - Edge cost is great-circle distance / motor speed, multiplied by a
 *    shore-proximity factor (up to 1.3× within 2 km of land, exempting
 *    narrow channels where no water within 2 km is farther than 1 km
 *    from shore).
 *  - Heuristic is straight-line time to the goal.
 *
 * Used only to produce a land-avoiding waypoint chain that biases the
 * isochrone heading sweep, so timing here is nominal motor timing.
 */

import { R_EARTH_M, haversineBearing, haversineDistanceM, DEG } from '../geo/geodesy';
import type { NavigabilityGrid } from '../geo/grid';

export interface SkeletonPoint {
  lon: number;
  lat: number;
}

export interface AstarResult {
  path: SkeletonPoint[];
  cellsVisited: number;
  distanceM: number;
}

export class AstarError extends Error {
  partialPath: SkeletonPoint[];
  constructor(message: string, partialPath: SkeletonPoint[] = []) {
    super(message);
    this.name = 'AstarError';
    this.partialPath = partialPath;
  }
}

const NEIGHBORS_16: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
  [-2, -1],
  [-2, 1],
  [2, -1],
  [2, 1],
  [-1, -2],
  [-1, 2],
  [1, -2],
  [1, 2],
];

// ---------------------------------------------------------------------
// Exact Euclidean distance transform (Felzenszwalb & Huttenlocher 2012),
// separable lower-envelope of parabolas. Returns, for each cell with
// mask=1, the distance in cells to the nearest mask=0 cell (0 for
// mask=0 cells; +Infinity if there is no zero cell at all).

function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

export function distanceTransformCells(mask: Uint8Array, ny: number, nx: number): Float32Array {
  // Large but exactly representable when added to squared cell offsets
  // (cell counts stay far below 1e5 per axis), so the parabola
  // intersections in edt1d stay numerically meaningful.
  const INF = 1e10;
  const sq = new Float64Array(ny * nx);
  for (let i = 0; i < sq.length; i++) sq[i] = mask[i] ? INF : 0;
  const maxN = Math.max(nx, ny);
  const f = new Float64Array(maxN);
  const d = new Float64Array(maxN);
  const v = new Int32Array(maxN);
  const z = new Float64Array(maxN + 1);
  // Columns.
  for (let j = 0; j < nx; j++) {
    for (let i = 0; i < ny; i++) f[i] = sq[i * nx + j];
    edt1d(f, ny, d, v, z);
    for (let i = 0; i < ny; i++) sq[i * nx + j] = d[i];
  }
  // Rows.
  for (let i = 0; i < ny; i++) {
    const base = i * nx;
    for (let j = 0; j < nx; j++) f[j] = sq[base + j];
    edt1d(f, nx, d, v, z);
    for (let j = 0; j < nx; j++) sq[base + j] = d[j];
  }
  const out = new Float32Array(ny * nx);
  for (let i = 0; i < out.length; i++) out[i] = sq[i] >= INF / 2 ? Infinity : Math.sqrt(sq[i]);
  return out;
}

/** Separable sliding-window maximum over a square window of `size` cells. */
export function maximumFilter(src: Float32Array, ny: number, nx: number, size: number): Float32Array {
  const half = Math.floor(size / 2);
  const tmp = new Float32Array(ny * nx);
  const out = new Float32Array(ny * nx);
  const win = (n: number, get: (k: number) => number, set: (k: number, v: number) => void): void => {
    // Monotonic deque of indices with decreasing values.
    const dq = new Int32Array(n);
    let head = 0;
    let tail = 0;
    // scipy's maximum_filter centres the window at [k-half, k-half+size-1].
    const lo = -half;
    const hi = size - 1 - half;
    let next = 0; // next index to push
    for (let k = 0; k < n; k++) {
      const end = Math.min(n - 1, k + hi);
      while (next <= end) {
        const val = get(next);
        while (tail > head && get(dq[tail - 1]) <= val) tail--;
        dq[tail++] = next;
        next++;
      }
      const start = k + lo;
      while (head < tail && dq[head] < start) head++;
      set(k, get(dq[head]));
    }
  };
  for (let i = 0; i < ny; i++) {
    const base = i * nx;
    win(
      nx,
      k => src[base + k],
      (k, val) => {
        tmp[base + k] = val;
      }
    );
  }
  for (let j = 0; j < nx; j++) {
    win(
      ny,
      k => tmp[k * nx + j],
      (k, val) => {
        out[k * nx + j] = val;
      }
    );
  }
  return out;
}

/**
 * Shore-proximity cost multiplier per cell (1.0 far from shore, up to
 * 1.3 at the shoreline, 1.0 inside narrow channels).
 */
export function computeShoreCost(grid: NavigabilityGrid): Float32Array {
  const { nx, ny, resolutionDeg } = grid.spec;
  const distCells = distanceTransformCells(grid.passable, ny, nx);
  const cellM = resolutionDeg * R_EARTH_M * DEG;
  const distM = new Float32Array(distCells.length);
  for (let i = 0; i < distM.length; i++) distM[i] = distCells[i] * cellM;

  const neighborhoodM = 2000;
  const neighborhoodCells = Math.max(3, Math.floor(neighborhoodM / cellM));
  const maxNearby = maximumFilter(distM, ny, nx, neighborhoodCells);

  const penaltyRangeM = 2000;
  const maxPenalty = 1.3;
  const channelThresholdM = 1000;
  const cost = new Float32Array(distM.length).fill(1);
  for (let i = 0; i < cost.length; i++) {
    if (!grid.passable[i]) continue;
    const d = distM[i];
    if (d < penaltyRangeM && !(maxNearby[i] < channelThresholdM)) {
      cost[i] = 1 + (maxPenalty - 1) * (1 - d / penaltyRangeM);
    }
  }
  return cost;
}

// ---------------------------------------------------------------------
// Growable binary min-heap of (cost, cell index).

class MinHeap {
  private cost: Float64Array;
  private cell: Int32Array;
  size = 0;
  constructor(capacity = 1 << 16) {
    this.cost = new Float64Array(capacity);
    this.cell = new Int32Array(capacity);
  }
  push(c: number, idx: number): void {
    if (this.size === this.cost.length) {
      const nc = new Float64Array(this.cost.length * 2);
      nc.set(this.cost);
      this.cost = nc;
      const ni = new Int32Array(this.cell.length * 2);
      ni.set(this.cell);
      this.cell = ni;
    }
    let pos = this.size++;
    this.cost[pos] = c;
    this.cell[pos] = idx;
    while (pos > 0) {
      const parent = (pos - 1) >> 1;
      if (this.cost[parent] > this.cost[pos]) {
        this.swap(parent, pos);
        pos = parent;
      } else break;
    }
  }
  pop(): [number, number] {
    const c = this.cost[0];
    const idx = this.cell[0];
    this.size--;
    if (this.size > 0) {
      this.cost[0] = this.cost[this.size];
      this.cell[0] = this.cell[this.size];
      let pos = 0;
      for (;;) {
        const l = 2 * pos + 1;
        const r = l + 1;
        let s = pos;
        if (l < this.size && this.cost[l] < this.cost[s]) s = l;
        if (r < this.size && this.cost[r] < this.cost[s]) s = r;
        if (s === pos) break;
        this.swap(s, pos);
        pos = s;
      }
    }
    return [c, idx];
  }
  private swap(a: number, b: number): void {
    const tc = this.cost[a];
    this.cost[a] = this.cost[b];
    this.cost[b] = tc;
    const ti = this.cell[a];
    this.cell[a] = this.cell[b];
    this.cell[b] = ti;
  }
}

/**
 * Find a motor path from start to end on the grid. Throws AstarError
 * (with the partial path to the closest reached cell) when no path exists.
 */
export function astarRoute(
  grid: NavigabilityGrid,
  startLonLat: [number, number],
  endLonLat: [number, number],
  motorSpeedMs: number,
  shoreCost?: Float32Array
): AstarResult {
  const spec = grid.spec;
  const { nx, ny } = spec;
  const [si, sj] = spec.lonlatToIJ(startLonLat[0], startLonLat[1]);
  const [ei, ej] = spec.lonlatToIJ(endLonLat[0], endLonLat[1]);
  if (!grid.isPassable(si, sj)) {
    throw new AstarError(`start (${startLonLat[1].toFixed(4)}, ${startLonLat[0].toFixed(4)}) is not on a passable grid cell`);
  }
  if (!grid.isPassable(ei, ej)) {
    throw new AstarError(`end (${endLonLat[1].toFixed(4)}, ${endLonLat[0].toFixed(4)}) is not on a passable grid cell`);
  }
  if (!(motorSpeedMs > 0)) throw new AstarError('motor speed must be > 0');
  const cost = shoreCost ?? computeShoreCost(grid);

  const dist = new Float64Array(nx * ny).fill(Infinity);
  const cameFrom = new Int32Array(nx * ny).fill(-1);
  const visited = new Uint8Array(nx * ny);
  const heap = new MinHeap();

  const endLon = endLonLat[0];
  const endLat = endLonLat[1];
  const res = spec.resolutionDeg;
  const west = spec.bbox.west;
  const south = spec.bbox.south;
  // Cell (i, j) geographic position: cell centre, consistent with ijToLonLat.
  const cellLon = (j: number): number => west + (j + 0.5) * res;
  const cellLat = (i: number): number => south + (i + 0.5) * res;
  const heuristic = (i: number, j: number): number => haversineDistanceM(cellLon(j), cellLat(i), endLon, endLat) / motorSpeedMs;

  const startIdx = si * nx + sj;
  const endIdx = ei * nx + ej;
  dist[startIdx] = 0;
  heap.push(heuristic(si, sj), startIdx);
  let cellsVisited = 0;
  let reached = false;

  while (heap.size > 0) {
    const [, cur] = heap.pop();
    if (visited[cur]) continue;
    visited[cur] = 1;
    cellsVisited++;
    if (cur === endIdx) {
      reached = true;
      break;
    }
    const ci = Math.floor(cur / nx);
    const cj = cur - ci * nx;
    const cLon = cellLon(cj);
    const cLat = cellLat(ci);
    for (const [di, dj] of NEIGHBORS_16) {
      const ni = ci + di;
      const nj = cj + dj;
      if (ni < 0 || ni >= ny || nj < 0 || nj >= nx) continue;
      const nIdx = ni * nx + nj;
      if (visited[nIdx]) continue;
      if (!grid.passable[nIdx]) continue;
      if (di !== 0 && dj !== 0) {
        if (Math.abs(di) === 2) {
          const mi = ci + di / 2;
          if (!grid.isPassable(mi, cj) || !grid.isPassable(mi, nj)) continue;
        } else if (Math.abs(dj) === 2) {
          const mj = cj + dj / 2;
          if (!grid.isPassable(ci, mj) || !grid.isPassable(ni, mj)) continue;
        } else if (!grid.isPassable(ni, cj) || !grid.isPassable(ci, nj)) {
          continue;
        }
      }
      const stepM = haversineDistanceM(cLon, cLat, cellLon(nj), cellLat(ni));
      const newDist = dist[cur] + (stepM / motorSpeedMs) * cost[nIdx];
      if (newDist < dist[nIdx]) {
        dist[nIdx] = newDist;
        cameFrom[nIdx] = cur;
        heap.push(newDist + heuristic(ni, nj), nIdx);
      }
    }
  }

  const walk = (fromIdx: number): SkeletonPoint[] => {
    const cells: number[] = [];
    let c = fromIdx;
    while (c !== -1) {
      cells.push(c);
      c = cameFrom[c];
    }
    cells.reverse();
    return cells.map(idx => {
      const i = Math.floor(idx / nx);
      const j = idx - i * nx;
      const [lon, lat] = spec.ijToLonLat(i, j);
      return { lon, lat };
    });
  };

  if (!reached) {
    // Closest reached cell to the goal, for diagnostics.
    let best = -1;
    let bestD = Infinity;
    for (let idx = 0; idx < dist.length; idx++) {
      if (!Number.isFinite(dist[idx])) continue;
      const i = Math.floor(idx / nx);
      const j = idx - i * nx;
      const d = haversineDistanceM(cellLon(j), cellLat(i), endLon, endLat);
      if (d < bestD) {
        bestD = d;
        best = idx;
      }
    }
    throw new AstarError(
      `no passable path between start and end on the coarse grid (closest approach ${(bestD / 1000).toFixed(1)} km, ${cellsVisited} cells explored)`,
      best >= 0 ? walk(best) : []
    );
  }

  const path = walk(endIdx);
  // Replace the first and last cell centres with the exact endpoints so
  // the skeleton starts and ends where the route does.
  path[0] = { lon: startLonLat[0], lat: startLonLat[1] };
  path[path.length - 1] = { lon: endLonLat[0], lat: endLonLat[1] };
  let distanceM = 0;
  for (let k = 1; k < path.length; k++) {
    distanceM += haversineDistanceM(path[k - 1].lon, path[k - 1].lat, path[k].lon, path[k].lat);
  }
  return { path, cellsVisited, distanceM };
}

/** Initial bearing helper re-exported for callers that only import this module. */
export const bearingDeg = haversineBearing;
