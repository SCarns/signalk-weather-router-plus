/**
 * The rough cut of a chart mesh for one boat (docs/drafts/mesh-no-gshhg-design.md, part 4): the water the boat
 * can use, as pieces joined across tile edges. A piece is a set of usable triangles (route.ts blockedTriangles under
 * the boat's draught and air draft, opening bridges as open, no buffer) connected inside one 0.25° tile; two pieces
 * are linked where a usable triangle of one shares an edge with a usable triangle of the other in the next tile.
 *
 * What it is for: a leg's water route can swing far outside the box around its two ends (the Bahamas to the Gulf
 * round the Florida Keys, Chicago to Lake Huron through the Straits of Mackinac), where the mesh search's growing
 * boxes never reach. A search on the rough cut gives the tiles the water passes through; the mesh search then reads
 * only those tiles and a ring of their neighbours (the corridor).
 *
 * Pieces are numbered tile by tile, in index order, and inside a tile in the order of their first triangle, so the
 * piece under a point is found again from its own tile alone (pieceAt).
 */

import { haversineDistanceM, type BBox } from '../../geo/geodesy';
import { MinHeap } from '../heap';
import { blockedTriangles, type MeshRules } from './route';
import type { MeshStore, MeshTileInfo, TileArrays } from './store';

export const COARSE_VERSION = 1;

/** The rules a rough cut is built for (route.ts blockedTriangles; opening bridges as open, no avoid areas). */
export type CoarseRules = Pick<MeshRules, 'draughtM' | 'airDraftM'>;

export interface CoarseMap {
  version: number;
  /** The rules it was built for. */
  draughtM: number;
  airDraftM: number;
  /** The mesh index's triangle count, to tell a map of another build. */
  triangles: number;
  /** Per tile with pieces: [i, j, first piece, piece count]. */
  tiles: [number, number, number, number][];
  /** Per piece: [lon, lat] of its centre (mean of its triangles' centroids) and its triangle count. */
  pieces: [number, number, number][];
  /** Links between pieces, each once (a < b). */
  links: [number, number][];
}

/** The usable triangles of one tile grouped into pieces: the piece of each triangle (-1 = blocked), in first-triangle order. */
function tilePieces(t: TileArrays, first: number, rules: CoarseRules): { pieceOf: Int32Array; count: number; blocked: Uint8Array } {
  const n = t.n;
  const blocked = blockedTriangles(
    { n, flags: t.flags, depth: t.depth, clear: t.clear, hazv: t.hazv } as Parameters<typeof blockedTriangles>[0],
    {
      ...rules,
      motorSpeedMs: 1,
      openingBridges: 'open',
    }
  );
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let a = 0; a < n; a++) {
    if (blocked[a]) continue;
    for (let k = 0; k < 3; k++) {
      const g = t.nb[a * 3 + k];
      const b = g - first;
      if (g < 0 || b < 0 || b >= n || blocked[b]) continue;
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    }
  }
  const pieceOf = new Int32Array(n).fill(-1);
  const idOfRoot = new Map<number, number>();
  let count = 0;
  for (let a = 0; a < n; a++) {
    if (blocked[a]) continue;
    const r = find(a);
    let id = idOfRoot.get(r);
    if (id === undefined) {
      id = count++;
      idOfRoot.set(r, id);
    }
    pieceOf[a] = id;
  }
  return { pieceOf, count, blocked };
}

/** Build the rough cut of one mesh for the rules. Reads every tile once; holds one piece id per triangle of the mesh. */
export function buildCoarseMap(store: MeshStore, rules: CoarseRules): CoarseMap {
  const ix = store.index;
  const infos = [...ix.tiles].sort((a, b) => a.first - b.first);
  const total = infos.reduce((m, t) => Math.max(m, t.first + t.n), 0);
  const pieceOfGlobal = new Int32Array(total).fill(-1);
  const tiles: CoarseMap['tiles'] = [];
  const pieces: CoarseMap['pieces'] = [];
  // Edges that leave a tile, as (global triangle, global neighbour), resolved once every tile has its pieces.
  let cross = new Int32Array(1 << 20);
  let nc = 0;
  for (const info of infos) {
    const t = store.readTileArrays(info);
    const { pieceOf, count } = tilePieces(t, info.first, rules);
    if (!count) continue;
    const base = pieces.length;
    tiles.push([info.i, info.j, base, count]);
    const sx = new Float64Array(count);
    const sy = new Float64Array(count);
    const sn = new Int32Array(count);
    for (let a = 0; a < t.n; a++) {
      const p = pieceOf[a];
      if (p < 0) continue;
      pieceOfGlobal[info.first + a] = base + p;
      const c = a * 6;
      sx[p] += (t.corners[c] + t.corners[c + 2] + t.corners[c + 4]) / 3 / ix.xScale;
      sy[p] += (t.corners[c + 1] + t.corners[c + 3] + t.corners[c + 5]) / 3;
      sn[p]++;
      for (let k = 0; k < 3; k++) {
        const g = t.nb[a * 3 + k];
        const b = g - info.first;
        if (g < 0 || (b >= 0 && b < t.n)) continue;
        if (nc + 2 > cross.length) {
          const grown = new Int32Array(cross.length * 2);
          grown.set(cross);
          cross = grown;
        }
        cross[nc++] = info.first + a;
        cross[nc++] = g;
      }
    }
    for (let p = 0; p < count; p++) pieces.push([sx[p] / sn[p], sy[p] / sn[p], sn[p]]);
  }
  const seen = new Set<string>();
  const links: CoarseMap['links'] = [];
  for (let q = 0; q < nc; q += 2) {
    const a = pieceOfGlobal[cross[q]];
    const b = pieceOfGlobal[cross[q + 1]];
    if (a < 0 || b < 0 || a === b) continue;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = `${lo},${hi}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push([lo, hi]);
  }
  return { version: COARSE_VERSION, draughtM: rules.draughtM, airDraftM: rules.airDraftM, triangles: ix.triangles, tiles, pieces, links };
}

/** Where a point lies for the rough cut: its piece, or the triangle that blocks it, or outside the mesh. */
export type PointPiece =
  { kind: 'piece'; piece: number; tile: [number, number] } | { kind: 'blocked'; depth: number | null } | { kind: 'outside' };

/** The piece under a point, from its own tile alone (the numbering of buildCoarseMap). */
export function pieceAt(store: MeshStore, map: CoarseMap, rules: CoarseRules, lon: number, lat: number): PointPiece {
  const [i, j] = store.tileIJ(lon, lat);
  // The point's own tile first, then its neighbours (a tile's triangles reach a little past its cell).
  for (const [di, dj] of [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ]) {
    const info = store.tile(i + di, j + dj);
    if (!info || lon < info.bbox[0] || lat < info.bbox[1] || lon > info.bbox[2] || lat > info.bbox[3]) continue;
    const t = store.readTileArrays(info);
    const x = lon * store.index.xScale;
    let hit = -1;
    for (let a = 0; a < t.n && hit < 0; a++) {
      const c = a * 6;
      const ax = t.corners[c];
      const ay = t.corners[c + 1];
      const bx = t.corners[c + 2];
      const by = t.corners[c + 3];
      const cx = t.corners[c + 4];
      const cy = t.corners[c + 5];
      if (x < Math.min(ax, bx, cx) || x > Math.max(ax, bx, cx) || lat < Math.min(ay, by, cy) || lat > Math.max(ay, by, cy)) continue;
      const d1 = (bx - ax) * (lat - ay) - (by - ay) * (x - ax);
      const d2 = (cx - bx) * (lat - by) - (cy - by) * (x - bx);
      const d3 = (ax - cx) * (lat - cy) - (ay - cy) * (x - cx);
      if (d1 >= 0 && d2 >= 0 && d3 >= 0) hit = a;
    }
    if (hit < 0) continue;
    const { pieceOf } = tilePieces(t, info.first, rules);
    if (pieceOf[hit] < 0) return { kind: 'blocked', depth: t.depth[hit] === -999 ? null : t.depth[hit] };
    const entry = map.tiles.find(e => e[0] === info.i && e[1] === info.j);
    if (!entry) return { kind: 'outside' };
    return { kind: 'piece', piece: entry[2] + pieceOf[hit], tile: [info.i, info.j] };
  }
  return { kind: 'outside' };
}

/** The shortest chain of pieces from one to the other (A* on the distance between centres), or null when none. */
export function coarseRoute(map: CoarseMap, from: number, to: number): number[] | null {
  const n = map.pieces.length;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of map.links) {
    adj[a].push(b);
    adj[b].push(a);
  }
  const d = (a: number, b: number): number => haversineDistanceM(map.pieces[a][0], map.pieces[a][1], map.pieces[b][0], map.pieces[b][1]);
  const g = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new MinHeap();
  g[from] = 0;
  heap.push(d(from, to), from);
  while (heap.size > 0) {
    const c = heap.pop();
    if (done[c]) continue;
    done[c] = 1;
    if (c === to) break;
    for (const nb of adj[c]) {
      const gg = g[c] + d(c, nb);
      if (gg < g[nb]) {
        g[nb] = gg;
        came[nb] = c;
        heap.push(gg + d(nb, to), nb);
      }
    }
  }
  if (!Number.isFinite(g[to])) return null;
  const chain: number[] = [];
  for (let c = to; c >= 0; c = came[c]) chain.push(c);
  return chain.reverse();
}

/** The tile of each piece, by binary search over the tile table. */
function tileOfPiece(map: CoarseMap, p: number): [number, number] {
  let lo = 0;
  let hi = map.tiles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (map.tiles[mid][2] <= p) lo = mid;
    else hi = mid - 1;
  }
  return [map.tiles[lo][0], map.tiles[lo][1]];
}

export interface Corridor {
  /** The tiles of the chain of pieces. */
  chainTiles: [number, number][];
  /** Each ring: the chain's tiles and every tile of the mesh within that many tiles of them (Chebyshev), as [i, j]. */
  rings: [number, number][][];
  /** The box of the widest ring's tiles (their vertex extents). */
  box: BBox;
  /** The chain's length between piece centres, metres. */
  lengthM: number;
}

/** The corridor of a chain of pieces: its tiles grown by 1, 2, … `maxRing` rings, only tiles the mesh has. */
export function corridorOf(store: MeshStore, map: CoarseMap, chain: number[], maxRing: number): Corridor {
  const chainKeys = new Set<string>();
  const chainTiles: [number, number][] = [];
  for (const p of chain) {
    const t = tileOfPiece(map, p);
    const k = `${t[0]},${t[1]}`;
    if (chainKeys.has(k)) continue;
    chainKeys.add(k);
    chainTiles.push(t);
  }
  const rings: [number, number][][] = [];
  let widest: MeshTileInfo[] = [];
  for (let r = 1; r <= maxRing; r++) {
    const keys = new Map<string, MeshTileInfo>();
    for (const [i, j] of chainTiles)
      for (let di = -r; di <= r; di++)
        for (let dj = -r; dj <= r; dj++) {
          const info = store.tile(i + di, j + dj);
          if (info) keys.set(`${info.i},${info.j}`, info);
        }
    const infos = [...keys.values()];
    rings.push(infos.map(t => [t.i, t.j]));
    widest = infos;
  }
  const box: BBox = {
    west: Math.min(...widest.map(t => t.bbox[0])),
    south: Math.min(...widest.map(t => t.bbox[1])),
    east: Math.max(...widest.map(t => t.bbox[2])),
    north: Math.max(...widest.map(t => t.bbox[3])),
  };
  let lengthM = 0;
  for (let k = 1; k < chain.length; k++)
    lengthM += haversineDistanceM(
      map.pieces[chain[k - 1]][0],
      map.pieces[chain[k - 1]][1],
      map.pieces[chain[k]][0],
      map.pieces[chain[k]][1]
    );
  return { chainTiles, rings, box, lengthM };
}
