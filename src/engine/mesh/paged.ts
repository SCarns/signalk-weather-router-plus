/**
 * The chart mesh read a tile at a time (docs/drafts/mesh-no-gshhg-design.md, part 4 revised): no area is chosen
 * before a search. Triangles keep their global ids (index.json `first` + position in the tile); a tile is read from
 * disk the first time one of its triangles is asked for, with its corners in the leg's metres frame (x = lon × cl ×
 * M_PER_DEG_MESH, y = lat × M_PER_DEG_MESH, cl the cosine of the leg's mid-latitude), its neighbours as global ids,
 * its blocked set under the leg's rules (route.ts blockedTriangles) and the buffer from unusable water grown inside
 * it (growBlocked, seeded across its edges from the rough cut's blocked boundary triangles). A tile can be dropped
 * and is read again when asked for; the search (astar.ts) drops a tile when no node of its frontier lies in it.
 *
 * Measured on brain (2026-10-12, 31 legs, read-only scripts): every leg routed with no area given, median 1.16 M
 * triangles read, and dropping tiles the frontier has left took the worst case from 2.8 GB to 1.1 GB for the same
 * route cost.
 *
 * The tests' in-memory meshes are one tile (fromLoaded), so the search, the land and the walks run the same code.
 */

import type { BBox } from '../../geo/geodesy';
import { blockedTriangles, growBlocked, type MeshRules } from './route';
import { type LoadedMesh, M_PER_DEG_MESH, type MeshStore, type MeshTileInfo } from './store';

/** Index cell size, metres: a few triangles a cell on a chart mesh (triangles are tens of metres). */
export const TILE_INDEX_CELL_M = 250;

/** One tile in memory. Arrays are per local triangle (global id − first). */
export interface PagedTile {
  /** Position in the mesh's tile list (sorted by first id). */
  idx: number;
  first: number;
  n: number;
  /** Corner k of local triangle t at [t * 3 + k], metres in the leg's frame. */
  x: Float64Array;
  y: Float64Array;
  /** Global id of the neighbour across edge k of t (edge k runs from corner k to k + 1), -1 = none. */
  nb: Int32Array;
  /** Index of the shared edge on the neighbour's side. */
  rev: Int8Array;
  mult: Float32Array;
  depth: Float32Array;
  clear: Float32Array;
  hazv: Float32Array;
  flags: Uint8Array;
  /** Blocked by the rules themselves, and with the buffer grown (what the search avoids). */
  ruleBlocked: Uint8Array;
  blocked: Uint8Array;
  /** The tile's vertex extent, degrees [west, south, east, north]. */
  bbox: [number, number, number, number];
  /** Grid over the tile for point lookups (built on first use). */
  grid: { x0: number; y0: number; nx: number; ny: number; offsets: Int32Array; ids: Int32Array } | null;
}

/**
 * What the rough cut (coarse.ts) records of the triangles with an edge on another tile, for one boat: the ones
 * blocked under its draught and air draft (opening bridges as open), and the opening bridges. Global ids, sorted.
 */
export interface BoundarySeeds {
  blocked: Int32Array;
  bridges: Int32Array;
}

function sortedHas(a: Int32Array, g: number): boolean {
  let lo = 0;
  let hi = a.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (a[m] === g) return true;
    if (a[m] < g) lo = m + 1;
    else hi = m - 1;
  }
  return false;
}

export interface PagedStats {
  /** Tile reads from disk, re-reads included; distinct tiles; their triangles. */
  reads: number;
  tiles: number;
  triangles: number;
  /** Most triangles held at once. */
  peakTriangles: number;
  /** Triangles blocked by the rules, and more by the buffer, over the distinct tiles read. */
  blocked: number;
  buffered: number;
  readMs: number;
  prepMs: number;
  bufferMs: number;
}

export class PagedMesh {
  private readonly firsts: number[];
  private readonly infos: (MeshTileInfo | null)[];
  private readonly held = new Map<number, PagedTile>();
  private readonly seen = new Set<number>();
  private heldTriangles = 0;
  private last: PagedTile | null = null;
  readonly stats: PagedStats = {
    reads: 0,
    tiles: 0,
    triangles: 0,
    peakTriangles: 0,
    blocked: 0,
    buffered: 0,
    readMs: 0,
    prepMs: 0,
    bufferMs: 0,
  };
  /** Union of the extents of the tiles read, degrees (null before the first). */
  private touched: BBox | null = null;
  /** A tile that cannot be read again (an in-memory mesh) is never dropped. */
  private readonly droppable: boolean;

  /**
   * A mesh on disk for one leg: `cl` the cosine of the leg's mid-latitude; `boundary` the rough cut's record of the
   * tile-boundary triangles for this boat (coarse.ts), seeds of the buffer across tile edges (absent: the buffer is
   * grown inside each tile only).
   */
  constructor(
    private readonly store: MeshStore | null,
    private readonly rules: MeshRules,
    readonly cl: number,
    private readonly boundary: BoundarySeeds | null = null,
    private readonly cellM = TILE_INDEX_CELL_M,
    inMemory?: PagedTile
  ) {
    if (inMemory) {
      this.firsts = [0];
      this.infos = [null];
      this.held.set(0, inMemory);
      this.seen.add(0);
      this.droppable = false;
      this.heldTriangles = inMemory.n;
      this.stats.tiles = 1;
      this.stats.triangles = inMemory.n;
      this.stats.peakTriangles = inMemory.n;
    } else {
      const infos = [...store!.index.tiles].sort((a, b) => a.first - b.first);
      this.firsts = infos.map(t => t.first);
      this.infos = infos;
      this.droppable = true;
    }
  }

  /** An in-memory mesh (the tests' synthetic meshes) as one tile that is never dropped, with its blocked set as given. */
  static fromLoaded(m: LoadedMesh, blocked: Uint8Array, cellM = TILE_INDEX_CELL_M): PagedMesh {
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let nn = -Infinity;
    for (let k = 0; k < m.n * 3; k++) {
      const lon = m.x[k] / (m.cl * M_PER_DEG_MESH);
      const lat = m.y[k] / M_PER_DEG_MESH;
      w = Math.min(w, lon);
      e = Math.max(e, lon);
      s = Math.min(s, lat);
      nn = Math.max(nn, lat);
    }
    const tile: PagedTile = {
      idx: 0,
      first: 0,
      n: m.n,
      x: m.x,
      y: m.y,
      nb: m.neighbours,
      rev: m.rev,
      mult: m.mult,
      depth: m.depth,
      clear: m.clear,
      hazv: m.hazv,
      flags: m.flags,
      ruleBlocked: blocked,
      blocked,
      bbox: [w, s, e, nn],
      grid: null,
    };
    return new PagedMesh(null, { draughtM: 0, airDraftM: 0, motorSpeedMs: 1 }, m.cl, null, cellM, tile);
  }

  toXY(lon: number, lat: number): [number, number] {
    return [lon * this.cl * M_PER_DEG_MESH, lat * M_PER_DEG_MESH];
  }

  fromXY(x: number, y: number): [number, number] {
    return [x / (this.cl * M_PER_DEG_MESH), y / M_PER_DEG_MESH];
  }

  /** Position in the tile list of the tile holding a global id. */
  tileIndexOf(g: number): number {
    const f = this.firsts;
    let lo = 0;
    let hi = f.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (f[m] <= g) lo = m;
      else hi = m - 1;
    }
    return lo;
  }

  /** The tile holding a global triangle id, read when not held. */
  tileOf(g: number): PagedTile {
    const L = this.last;
    if (L && g >= L.first && g < L.first + L.n) return L;
    return (this.last = this.tile(this.tileIndexOf(g)));
  }

  /** The tile at a position of the tile list, read when not held. */
  tile(idx: number): PagedTile {
    const held = this.held.get(idx);
    if (held) return held;
    const T = this.read(idx);
    this.held.set(idx, T);
    this.heldTriangles += T.n;
    if (this.heldTriangles > this.stats.peakTriangles) this.stats.peakTriangles = this.heldTriangles;
    return T;
  }

  isHeld(idx: number): boolean {
    return this.held.has(idx);
  }

  /** The positions of the tiles held now. */
  heldTiles(): number[] {
    return [...this.held.keys()];
  }

  /** Let a tile go (read again when asked for). An in-memory mesh keeps its tile. */
  drop(idx: number): void {
    if (!this.droppable) return;
    const T = this.held.get(idx);
    if (!T) return;
    this.held.delete(idx);
    this.heldTriangles -= T.n;
    if (this.last === T) this.last = null;
  }

  /** Keep only the tiles for which `keep` answers true. */
  retain(keep: (T: PagedTile) => boolean): void {
    for (const [idx, T] of [...this.held]) if (!keep(T)) this.drop(idx);
  }

  /** The union of the extents of every tile read so far (the leg's area, for the currents read beside it). */
  touchedBox(): BBox | null {
    return this.touched;
  }

  private read(idx: number): PagedTile {
    const info = this.infos[idx];
    if (!info || !this.store) throw new Error(`mesh tile ${idx}: not in memory and no store to read it from`);
    const t0 = Date.now();
    const a = this.store.readTileArrays(info);
    const n = a.n;
    const K = this.store.index.xScale;
    const x = new Float64Array(n * 3);
    const y = new Float64Array(n * 3);
    for (let q = 0; q < n * 3; q++) {
      x[q] = (a.corners[2 * q] / K) * this.cl * M_PER_DEG_MESH;
      y[q] = a.corners[2 * q + 1] * M_PER_DEG_MESH;
    }
    const t1 = Date.now();
    // The tile as a mesh of its own (neighbours local, -1 across its edges) for the rules and the buffer.
    const local = new Int32Array(n * 3);
    for (let q = 0; q < n * 3; q++) {
      const l = a.nb[q] - info.first;
      local[q] = a.nb[q] >= 0 && l >= 0 && l < n ? l : -1;
    }
    const m: LoadedMesh = {
      n,
      x,
      y,
      cl: this.cl,
      neighbours: local,
      rev: a.rev,
      mult: a.mult,
      depth: a.depth,
      clear: a.clear,
      hazv: a.hazv,
      flags: a.flags,
      tiles: [{ info, offset: 0 }],
    };
    const ruleBlocked = blockedTriangles(m, this.rules);
    const blocked = ruleBlocked.slice();
    const t2 = Date.now();
    let buffered = 0;
    if ((this.rules.bufferM ?? 0) > 0) {
      // Seeds across the tile's edges: usable triangles whose neighbour in the next tile is blocked for this boat
      // (an opening bridge too under Drawbridges = Avoid). An area to avoid in the next tile is not known here:
      // its triangles are judged by their centroids, which only that tile's corners give.
      const outer: number[] = [];
      const B = this.boundary;
      const bridges = this.rules.openingBridges === 'avoid';
      if (B)
        for (let q = 0; q < n * 3; q++) {
          const g = a.nb[q];
          if (local[q] >= 0 || g < 0) continue;
          if (sortedHas(B.blocked, g) || (bridges && sortedHas(B.bridges, g))) outer.push(q);
        }
      buffered = growBlocked(m, blocked, this.rules.bufferM!, outer);
    }
    const t3 = Date.now();
    this.stats.reads++;
    this.stats.readMs += t1 - t0;
    this.stats.prepMs += t2 - t1;
    this.stats.bufferMs += t3 - t2;
    if (!this.seen.has(idx)) {
      this.seen.add(idx);
      this.stats.tiles++;
      this.stats.triangles += n;
      let b = 0;
      for (let t = 0; t < n; t++) b += ruleBlocked[t];
      this.stats.blocked += b;
      this.stats.buffered += buffered;
      const tb = this.touched;
      this.touched = tb
        ? {
            west: Math.min(tb.west, info.bbox[0]),
            south: Math.min(tb.south, info.bbox[1]),
            east: Math.max(tb.east, info.bbox[2]),
            north: Math.max(tb.north, info.bbox[3]),
          }
        : { west: info.bbox[0], south: info.bbox[1], east: info.bbox[2], north: info.bbox[3] };
    }
    return {
      idx,
      first: info.first,
      n,
      x,
      y,
      nb: a.nb,
      rev: a.rev,
      mult: a.mult,
      depth: a.depth,
      clear: a.clear,
      hazv: a.hazv,
      flags: a.flags,
      ruleBlocked,
      blocked,
      bbox: info.bbox,
      grid: null,
    };
  }

  /** The grid over a tile's triangles (each cell lists the triangles whose bounding box meets it). */
  private gridOf(T: PagedTile): NonNullable<PagedTile['grid']> {
    if (T.grid) return T.grid;
    const { x, y, n } = T;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < n * 3; k++) {
      if (x[k] < x0) x0 = x[k];
      if (x[k] > x1) x1 = x[k];
      if (y[k] < y0) y0 = y[k];
      if (y[k] > y1) y1 = y[k];
    }
    if (n === 0) x0 = y0 = x1 = y1 = 0;
    const c = this.cellM;
    const nx = Math.max(1, Math.ceil((x1 - x0) / c) + 1);
    const ny = Math.max(1, Math.ceil((y1 - y0) / c) + 1);
    const col = (px: number): number => Math.min(nx - 1, Math.max(0, Math.floor((px - x0) / c)));
    const row = (py: number): number => Math.min(ny - 1, Math.max(0, Math.floor((py - y0) / c)));
    const offsets = new Int32Array(nx * ny + 1);
    const span = (t: number): [number, number, number, number] => {
      const a = t * 3;
      return [
        col(Math.min(x[a], x[a + 1], x[a + 2])),
        col(Math.max(x[a], x[a + 1], x[a + 2])),
        row(Math.min(y[a], y[a + 1], y[a + 2])),
        row(Math.max(y[a], y[a + 1], y[a + 2])),
      ];
    };
    for (let t = 0; t < n; t++) {
      const [i0, i1, j0, j1] = span(t);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) offsets[j * nx + i + 1]++;
    }
    for (let k = 0; k < nx * ny; k++) offsets[k + 1] += offsets[k];
    const ids = new Int32Array(offsets[nx * ny]);
    const fill = new Int32Array(nx * ny);
    for (let t = 0; t < n; t++) {
      const [i0, i1, j0, j1] = span(t);
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const cc = j * nx + i;
          ids[offsets[cc] + fill[cc]++] = t;
        }
    }
    T.grid = { x0, y0, nx, ny, offsets, ids };
    return T.grid;
  }

  /** Bytes of the grids held (for the log). */
  indexBytes(): number {
    let b = 0;
    for (const T of this.held.values()) if (T.grid) b += T.grid.offsets.byteLength + T.grid.ids.byteLength;
    return b;
  }

  /** The triangle of a tile holding (px, py), local id or -1; with preferUsable a usable one wins over a blocked one. */
  private locateIn(T: PagedTile, px: number, py: number, preferUsable: boolean): number {
    const G = this.gridOf(T);
    const i = Math.floor((px - G.x0) / this.cellM);
    const j = Math.floor((py - G.y0) / this.cellM);
    if (i < 0 || j < 0 || i >= G.nx || j >= G.ny) return -1;
    const c = j * G.nx + i;
    const { x, y } = T;
    let found = -1;
    for (let k = G.offsets[c]; k < G.offsets[c + 1]; k++) {
      const t = G.ids[k];
      const a = t * 3;
      const ax = x[a];
      const ay = y[a];
      const bx = x[a + 1];
      const by = y[a + 1];
      const cx = x[a + 2];
      const cy = y[a + 2];
      if (px < Math.min(ax, bx, cx) || px > Math.max(ax, bx, cx) || py < Math.min(ay, by, cy) || py > Math.max(ay, by, cy)) continue;
      const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      const d2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
      const d3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
      if (d1 >= 0 && d2 >= 0 && d3 >= 0) {
        if (!preferUsable || !T.blocked[t]) return t;
        if (found < 0) found = t;
      }
    }
    return found;
  }

  /**
   * The triangle holding a point of the metres frame, global id or -1: the point's own tile first, then the tiles
   * around it whose vertex extent holds it (a tile's triangles reach a little past its cell). Corners wind
   * counter-clockwise; a point on a shared edge or corner counts for the first triangle met, unless `preferUsable`:
   * then a usable triangle holding the point wins over a blocked one (a route corner on a depth contour belongs to
   * the water the route uses).
   */
  locate(px: number, py: number, preferUsable = false): number {
    if (!this.store) {
      const T = this.held.get(0)!;
      const t = this.locateIn(T, px, py, preferUsable);
      return t < 0 ? -1 : t;
    }
    const [lon, lat] = this.fromXY(px, py);
    const [i, j] = this.store.tileIJ(lon, lat);
    let fallback = -1;
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
      const info = this.store.tile(i + di, j + dj);
      if (!info || lon < info.bbox[0] || lat < info.bbox[1] || lon > info.bbox[2] || lat > info.bbox[3]) continue;
      const T = this.tile(this.tileIndexOf(info.first));
      const t = this.locateIn(T, px, py, preferUsable);
      if (t < 0) continue;
      if (!preferUsable || !T.blocked[t]) return T.first + t;
      if (fallback < 0) fallback = T.first + t;
    }
    return fallback;
  }

  /** Blocked for the search (rules and buffer)? */
  isBlocked(g: number): boolean {
    const T = this.tileOf(g);
    return T.blocked[g - T.first] === 1;
  }
}
