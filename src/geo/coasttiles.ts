/**
 * The coastline cut into 0.5° tiles on disk, so a land question reads only
 * the pieces in its box.
 *
 * GSHHG keeps each continent as one record (North America 14.0 MB, Eurasia
 * 18.6 MB in the full-resolution L1 file, brain 2026-10-25). Read by record,
 * any box near a coast decoded the whole continent and dropped it: the map's
 * land rasters twice per raster (fill and coastline pass), the point test,
 * every route's land mask and every snapped stop. Signal K's process kept
 * the freed memory (about 80 MB per new map area).
 *
 * The cut (cutCoastline, once per coastline, in its own process at start):
 * every ring is clipped to the tile grid by halving (one straight cut at a
 * time), and every edge keeps a flag: real coastline, or a cut along a tile
 * border. A tile holds, per record touching it, the record's part inside the
 * tile. Filling and point-in-polygon use all edges (the parts of a record
 * fill exactly what the record fills); the coastline tests (the
 * conservative raster's edge cells, a leg touching the coast, the distance
 * to the shore) skip the cut edges (landmask.ts, Ring.real).
 *
 * On disk, per coastline (the fingerprint of its files, as the saved land
 * rasters use): `tiles.bin` (the pieces), `index.bin` (per tile, where its
 * pieces are) and `complete.json`, written last.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BBox } from './geodesy';
import { bboxWidth } from './geodesy';
import { wrapLon } from './angles';
import { pointInShape, shorelineLevel, shorelinePaths, ShapefileIndex, type ShapePolygon } from './shapefile';

/** Tile size, degrees (the reads are smallest at 0.5°: brain, 2026-10-25). */
export const COAST_TILE_DEG = 0.5;
/** The tile stores' folder under the plugin's data directory. */
export const COAST_TILES_DIR = 'coast-tiles';
const VERSION = 3;
const N_LON = Math.round(360 / COAST_TILE_DEG);
const N_LAT = Math.round(180 / COAST_TILE_DEG);
const INDEX_MAGIC = 0x43505257; // 'WRPC'
/** The one buffer forEachRaw reads a tile into (per thread), its views, and where each piece starts in it. */
function rawBuffer(bytes: number): { u8: Uint8Array; u32: Uint32Array; f64: Float64Array; starts: Int32Array } {
  const ab = new ArrayBuffer(bytes);
  return { u8: new Uint8Array(ab), u32: new Uint32Array(ab), f64: new Float64Array(ab), starts: new Int32Array(64) };
}
let raw = rawBuffer(1 << 20);

/** Recently read tiles kept per thread. A tile is at most a few hundred kB (287 kB in GSHHG full resolution). */
export const COAST_TILE_CACHE_BYTES = 24 * 1024 * 1024;

/**
 * Folder name for one coastline: a hash of the shapefile paths, sizes and
 * modification times, so a changed coastline never reuses saved tiles or
 * rasters.
 */
export function coastlineFingerprint(paths: string[]): string {
  const h = crypto.createHash('sha256');
  h.update('hierarchy-v1');
  for (const p of paths) {
    h.update(p);
    try {
      const st = fs.statSync(p);
      h.update(`|${st.size}|${Math.floor(st.mtimeMs)}`);
    } catch {
      h.update('|missing');
    }
  }
  return `coast-${h.digest('hex').slice(0, 16)}`;
}

/** The tile store's folder for a coastline under `root` (the plugin's data directory). */
export function coastTilesDir(root: string, paths: string[]): string {
  return path.join(root, COAST_TILES_DIR, coastlineFingerprint(shorelinePaths(paths)));
}

/**
 * Is the tile store for this coastline complete under `root`, in this version's format? Throws for an incomplete GSHHG
 * hierarchy (shorelinePaths), before any cut starts.
 */
export function coastTilesReady(root: string, paths: string[]): boolean {
  return storeComplete(coastTilesDir(root, paths));
}

/** Is the tile store in `dir` complete, in this version's format? */
function storeComplete(dir: string): boolean {
  const file = path.join(dir, 'complete.json');
  let done: { version?: number } | null;
  try {
    done = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: number } | null;
  } catch {
    return false; // not cut yet, or a cut that did not finish
  }
  // A marker that is not an object (a damaged file: `null`) is not ready either.
  return done?.version === VERSION;
}

// ─────────────── the cut ───────────────

interface CutRing {
  x: number[];
  y: number[];
  /** Edge k → k+1 (the last: back to the first): 1 real coastline, 0 a cut along a tile border. */
  f: number[];
  /** Edge k's whole coastline edge in the record [x0, y0, x1, y1] (null for a cut): the edge itself unless a cut shortened it. */
  o: (number[] | null)[];
}

/** The part of a ring on one side of the line `v = c` (axis 0: longitude, 1: latitude), or null when under 3 points. */
function clipRing(r: CutRing, axis: 0 | 1, c: number, keepLow: boolean): CutRing | null {
  const n = r.x.length;
  const vs = axis === 0 ? r.x : r.y;
  const ox: number[] = [];
  const oy: number[] = [];
  const of: number[] = [];
  const oo: (number[] | null)[] = [];
  let firstArrive = 0;
  let firstOrigin: number[] | null = null;
  const inside = (i: number): boolean => (keepLow ? vs[i] <= c : vs[i] >= c);
  /** Add a vertex; the edge arriving at it is `arrive` (real or cut), part of the record's edge `origin`. */
  const emit = (x: number, y: number, arrive: number, origin: number[] | null): void => {
    if (ox.length) {
      of[ox.length - 1] = arrive;
      oo[ox.length - 1] = origin;
    } else {
      firstArrive = arrive;
      firstOrigin = origin;
    }
    ox.push(x);
    oy.push(y);
    of.push(0);
    oo.push(null);
  };
  const cross = (a: number, b: number): [number, number] => {
    const t = (c - vs[a]) / (vs[b] - vs[a]);
    return axis === 0 ? [c, r.y[a] + t * (r.y[b] - r.y[a])] : [r.x[a] + t * (r.x[b] - r.x[a]), c];
  };
  for (let a = 0; a < n; a++) {
    const b = (a + 1) % n;
    const ia = inside(a);
    const ib = inside(b);
    if (ia && ib) emit(r.x[b], r.y[b], r.f[a], r.o[a]);
    else if (ia) emit(...cross(a, b), r.f[a], r.o[a]);
    else if (ib) {
      // Back inside: the way from the last exit runs along the cut line.
      emit(...cross(a, b), 0, null);
      emit(r.x[b], r.y[b], r.f[a], r.o[a]);
    }
  }
  if (ox.length < 3) return null;
  of[ox.length - 1] = firstArrive;
  oo[ox.length - 1] = firstOrigin;
  return { x: ox, y: oy, f: of, o: oo };
}

function ringRange(r: CutRing, axis: 0 | 1): [number, number] {
  const vs = axis === 0 ? r.x : r.y;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of vs) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/**
 * Edge flags as stored: a cut along a tile border; a coastline edge as in the record; a coastline edge a cut
 * shortened, whose whole edge follows (marking cells and testing legs against the whole edge gives exactly the
 * answers the record gives: a shortened edge walked on its own can touch a cell more or less where a vertex lies on a
 * cell corner).
 */
const EDGE_CUT = 0;
const EDGE_REAL = 1;
const EDGE_SHORTENED = 2;

/** The edge's flag as stored (EDGE_*). */
function edgeKind(r: CutRing, k: number): number {
  if (!r.f[k]) return EDGE_CUT;
  const o = r.o[k]!;
  const k1 = (k + 1) % r.x.length;
  return o[0] === r.x[k] && o[1] === r.y[k] && o[2] === r.x[k1] && o[3] === r.y[k1] ? EDGE_REAL : EDGE_SHORTENED;
}

const align8 = (o: number): number => (o + 7) & ~7;

/**
 * A piece as stored, laid out so a reader takes its arrays as views on the bytes read (no copy): every block of
 * doubles starts on a multiple of 8 from the piece's start (a piece is read into its own buffer, or at a multiple of
 * 8 into a shared one).
 *   [bytes u32][level u8][pad 3][record i32][rings u32]                                       16 bytes
 *   per ring, from a multiple of 8:
 *     [vertices u32: the closed ring, the first vertex repeated][shortened edges u32]          8 bytes
 *     [x,y f64 × vertices]                                                                     the ring, closed
 *     [x0,y0,x1,y1 f64 × shortened]                                                            each shortened edge whole
 *     [edge index u32 × shortened]                                                             which edge each one is
 *     [flag u8 × vertices]                                                                     EDGE_*, the closing one cut
 *     padding to a multiple of 8
 */
function encodePiece(level: number, rec: number, rings: CutRing[]): Buffer {
  const layout = rings.map(r => {
    const kinds = r.x.map((_x, k) => edgeKind(r, k));
    const short = kinds.flatMap((kd, k) => (kd === EDGE_SHORTENED ? [k] : []));
    const n = r.x.length + 1;
    return { r, kinds, short, n, size: align8(8 + 16 * n + 32 * short.length + 4 * short.length + n) };
  });
  const bytes = 16 + layout.reduce((a, l) => a + l.size, 0);
  const b = Buffer.alloc(bytes);
  b.writeUInt32LE(bytes, 0);
  b.writeUInt8(level, 4);
  b.writeInt32LE(rec, 8);
  b.writeUInt32LE(rings.length, 12);
  let o = 16;
  for (const { r, kinds, short, n, size } of layout) {
    const start = o;
    b.writeUInt32LE(n, o);
    b.writeUInt32LE(short.length, o + 4);
    o += 8;
    for (let i = 0; i < n; i++) {
      o = b.writeDoubleLE(r.x[i % r.x.length], o);
      o = b.writeDoubleLE(r.y[i % r.x.length], o);
    }
    for (const k of short) for (const v of r.o[k]!) o = b.writeDoubleLE(v, o);
    for (const k of short) o = b.writeUInt32LE(k, o);
    for (const kd of kinds) o = b.writeUInt8(kd, o);
    b.writeUInt8(EDGE_CUT, o); // the closing vertex repeats the first: a zero-length edge, not coastline
    o = start + size;
  }
  return b;
}

export interface CutResult {
  dir: string;
  tiles: number;
  pieces: number;
  bytes: number;
  ms: number;
}

/**
 * Cut the coastline into the tile store under `root`; with `pruneOthers` (the plugin's own cut), any other
 * coastline's store there is removed. Reads every record, the continents included: run it in its own process, whose
 * memory goes when it exits (childtask.ts).
 */
export function cutCoastline(paths: string[], root: string, log: (m: string) => void = () => undefined, pruneOthers = false): CutResult {
  const t0 = Date.now();
  const files = shorelinePaths(paths);
  const dir = coastTilesDir(root, files);
  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const data = fs.openSync(path.join(tmp, 'tiles.bin'), 'w');
  let pos = 0;
  let pieces = 0;
  /** Tile key (row × N_LON + column) → [offset, length, offset, length, …] in write order. */
  const chunks = new Map<number, number[]>();
  try {
    const write = (key: number, level: number, rec: number, rings: CutRing[]): void => {
      const b = encodePiece(level, rec, rings);
      fs.writeSync(data, b, 0, b.length, pos);
      let l = chunks.get(key);
      if (!l) chunks.set(key, (l = []));
      l.push(pos, b.length);
      pos += b.length;
      pieces++;
    };
    /** A record's rings inside tiles [i0, i1) × [j0, j1): halved along the longer side until one tile. */
    const cut = (rings: CutRing[], i0: number, i1: number, j0: number, j1: number, level: number, rec: number): void => {
      if (i1 - i0 === 1 && j1 - j0 === 1) {
        write(j0 * N_LON + i0, level, rec, rings);
        return;
      }
      const axis: 0 | 1 = i1 - i0 >= j1 - j0 ? 0 : 1;
      const m = axis === 0 ? (i0 + i1) >> 1 : (j0 + j1) >> 1;
      const c = (axis === 0 ? -180 : -90) + m * COAST_TILE_DEG;
      const lo: CutRing[] = [];
      const hi: CutRing[] = [];
      for (const r of rings) {
        const [v0, v1] = ringRange(r, axis);
        if (v1 <= c) lo.push(r);
        else if (v0 >= c) hi.push(r);
        else {
          const a = clipRing(r, axis, c, true);
          const b = clipRing(r, axis, c, false);
          if (a) lo.push(a);
          if (b) hi.push(b);
        }
      }
      if (axis === 0) {
        if (lo.length) cut(lo, i0, m, j0, j1, level, rec);
        if (hi.length) cut(hi, m, i1, j0, j1, level, rec);
      } else {
        if (lo.length) cut(lo, i0, i1, j0, m, level, rec);
        if (hi.length) cut(hi, i0, i1, m, j1, level, rec);
      }
    };
    for (const file of files) {
      const level = shorelineLevel(file);
      const ix = ShapefileIndex.open(file);
      const reader = ix.openReader();
      try {
        for (let i = 0; i < ix.count; i++) {
          const s = reader.decode(i);
          if (!s) continue;
          const rings: CutRing[] = [];
          for (const rg of s.rings) {
            const c = rg.coords;
            let n = c.length / 2;
            // The closing vertex repeats the first: the cut works on the open ring.
            if (n > 1 && c[0] === c[2 * n - 2] && c[1] === c[2 * n - 1]) n--;
            if (n < 3) continue;
            const r: CutRing = {
              x: new Array<number>(n),
              y: new Array<number>(n),
              f: new Array<number>(n).fill(1),
              o: new Array<number[] | null>(n),
            };
            for (let k = 0; k < n; k++) {
              r.x[k] = Math.max(-180, Math.min(180, c[2 * k]));
              r.y[k] = c[2 * k + 1];
            }
            for (let k = 0; k < n; k++) r.o[k] = [r.x[k], r.y[k], r.x[(k + 1) % n], r.y[(k + 1) % n]];
            rings.push(r);
          }
          if (!rings.length) continue;
          const i0 = Math.max(0, Math.floor((s.minLon + 180) / COAST_TILE_DEG));
          const i1 = Math.min(N_LON, Math.floor((s.maxLon + 180) / COAST_TILE_DEG) + 1);
          const j0 = Math.max(0, Math.floor((s.minLat + 90) / COAST_TILE_DEG));
          const j1 = Math.min(N_LAT, Math.floor((s.maxLat + 90) / COAST_TILE_DEG) + 1);
          if (i1 > i0 && j1 > j0) cut(rings, i0, i1, j0, j1, level, s.recordNumber);
        }
      } finally {
        reader.close();
      }
    }
  } finally {
    fs.closeSync(data);
  }
  // The index: tiles in key order, each its range of chunks.
  const keys = [...chunks.keys()].sort((a, b) => a - b);
  const nChunks = pieces;
  const idx = Buffer.alloc(24 + keys.length * 4 + (keys.length + 1) * 4 + nChunks * 12);
  let o = 0;
  o = idx.writeUInt32LE(INDEX_MAGIC, o);
  o = idx.writeUInt32LE(VERSION, o);
  o = idx.writeUInt32LE(N_LON, o);
  o = idx.writeUInt32LE(N_LAT, o);
  o = idx.writeUInt32LE(keys.length, o);
  o = idx.writeUInt32LE(nChunks, o);
  for (const k of keys) o = idx.writeUInt32LE(k, o);
  let first = 0;
  for (const k of keys) {
    o = idx.writeUInt32LE(first, o);
    first += chunks.get(k)!.length / 2;
  }
  o = idx.writeUInt32LE(first, o);
  for (const k of keys) {
    const l = chunks.get(k)!;
    for (let i = 0; i < l.length; i += 2) {
      o = idx.writeDoubleLE(l[i], o);
      o = idx.writeUInt32LE(l[i + 1], o);
    }
  }
  fs.writeFileSync(path.join(tmp, 'index.bin'), idx);
  const ms = Date.now() - t0;
  fs.writeFileSync(
    path.join(tmp, 'complete.json'),
    JSON.stringify({ version: VERSION, tileDeg: COAST_TILE_DEG, sources: files, tiles: keys.length, pieces, bytes: pos, ms })
  );
  // A complete store there is another cut's, finished first, which readers may have open: it stays, this one goes.
  // Otherwise (none, or one that did not finish or is of an older version, which no reader opens) this one replaces it.
  if (storeComplete(dir)) fs.rmSync(tmp, { recursive: true, force: true });
  else {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
  }
  // Another coastline's store, or a cut that did not finish: no longer used. A cut still running in another process
  // keeps its staging folder.
  const parent = path.dirname(dir);
  if (pruneOthers)
    for (const name of fs.readdirSync(parent)) {
      if (name === path.basename(dir) || !name.startsWith('coast-')) continue;
      const owner = /\.tmp-(\d+)$/.exec(name);
      if (owner && processAlive(Number(owner[1]))) continue;
      fs.rmSync(path.join(parent, name), { recursive: true, force: true });
    }
  log(`coastline tiles: ${keys.length} tiles, ${pieces} pieces, ${(pos / 1e6).toFixed(1)} MB in ${(ms / 1000).toFixed(1)} s`);
  return { dir, tiles: keys.length, pieces, bytes: pos, ms };
}

/** Is process `pid` running (EPERM: running, owned by another user)? */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ─────────────── reading ───────────────

/** One thread's view of a coastline's tile store: the index in memory, the pieces read from disk as needed. */
export class CoastTiles {
  readonly dir: string;
  /** The coastline's files (all GSHHG levels), as cut. */
  readonly paths: string[];
  /** The fingerprint the store is filed under (also the saved land rasters' folder). */
  readonly fingerprint: string;
  private readonly keys: Uint32Array;
  private readonly first: Uint32Array;
  private readonly offset: Float64Array;
  private readonly length: Uint32Array;
  /** Recently read tiles, least recently used first (Map order). */
  private readonly cache = new Map<number, { shapes: ShapePolygon[]; bytes: number }>();
  private cacheBytes = 0;
  hits = 0;
  reads = 0;
  evictions = 0;

  private static open_ = new Map<string, CoastTiles>();

  /** The store for this coastline under `root`; it must have been cut (cutCoastline). One instance per thread. */
  static open(paths: string[], root: string): CoastTiles {
    const files = shorelinePaths(paths);
    const dir = coastTilesDir(root, files);
    const hit = CoastTiles.open_.get(dir);
    if (hit) return hit;
    if (!fs.existsSync(path.join(dir, 'complete.json')))
      throw new Error(`the coastline has not been cut into tiles yet (${dir}); the plugin does this at start`);
    const t = new CoastTiles(dir, files);
    CoastTiles.open_.set(dir, t);
    return t;
  }

  /** The store, cut first when missing: for a process of its own (the CLI, the tools, tests), never a plugin thread. */
  static build(paths: string[], root: string, log?: (m: string) => void): CoastTiles {
    if (!coastTilesReady(root, paths)) cutCoastline(paths, root, log);
    return CoastTiles.open(paths, root);
  }

  private constructor(dir: string, paths: string[]) {
    this.dir = dir;
    this.paths = paths;
    this.fingerprint = path.basename(dir);
    const b = fs.readFileSync(path.join(dir, 'index.bin'));
    if (b.readUInt32LE(0) !== INDEX_MAGIC || b.readUInt32LE(4) !== VERSION)
      throw new Error(`${dir}: not a coastline tile index of version ${VERSION}`);
    const nTiles = b.readUInt32LE(16);
    const nChunks = b.readUInt32LE(20);
    let o = 24;
    this.keys = new Uint32Array(nTiles);
    for (let i = 0; i < nTiles; i++, o += 4) this.keys[i] = b.readUInt32LE(o);
    this.first = new Uint32Array(nTiles + 1);
    for (let i = 0; i <= nTiles; i++, o += 4) this.first[i] = b.readUInt32LE(o);
    this.offset = new Float64Array(nChunks);
    this.length = new Uint32Array(nChunks);
    for (let i = 0; i < nChunks; i++, o += 12) {
      this.offset[i] = b.readDoubleLE(o);
      this.length[i] = b.readUInt32LE(o + 8);
    }
  }

  /** Resident bytes of the index. */
  indexBytes(): number {
    return this.keys.byteLength + this.first.byteLength + this.offset.byteLength + this.length.byteLength;
  }

  /** The tile's pieces (cached), or none. */
  private tile(key: number): ShapePolygon[] {
    const c = this.cache.get(key);
    if (c) {
      this.cache.delete(key);
      this.cache.set(key, c);
      this.hits++;
      return c.shapes;
    }
    const at = this.find(key);
    // A tile without pieces (open sea): nothing to read, nothing to cache.
    if (at < 0) return [];
    const shapes: ShapePolygon[] = [];
    let bytes = 0;
    this.reads++;
    const fd = fs.openSync(path.join(this.dir, 'tiles.bin'), 'r');
    try {
      for (let k = this.first[at]; k < this.first[at + 1]; k++) {
        const b = Buffer.alloc(this.length[k]);
        if (fs.readSync(fd, b, 0, b.length, this.offset[k]) !== b.length) throw new Error(`${this.dir}: truncated tile data`);
        shapes.push(decodePiece(b));
        bytes += b.length;
      }
    } finally {
      fs.closeSync(fd);
    }
    this.cache.set(key, { shapes, bytes });
    this.cacheBytes += bytes;
    for (const [k, e] of this.cache) {
      if (this.cacheBytes <= COAST_TILE_CACHE_BYTES || k === key) break;
      this.cache.delete(k);
      this.cacheBytes -= e.bytes;
      this.evictions++;
    }
    return shapes;
  }

  /** The index position of a tile (binary search of the sorted keys), or -1 when it has no pieces. */
  private find(key: number): number {
    let lo = 0;
    let hi = this.keys.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.keys[mid] === key) return mid;
      if (this.keys[mid] < key) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /** The tiles meeting `box` (across the antimeridian too): the first column, how many more, and the rows. */
  private span(box: BBox): { i0: number; span: number; j0: number; j1: number } {
    const width = bboxWidth(box);
    const i0 = Math.floor((wrapLon(box.west) + 180) / COAST_TILE_DEG);
    const span = width >= 360 ? N_LON - 1 : Math.min(N_LON - 1, Math.floor((wrapLon(box.west) + 180 + width) / COAST_TILE_DEG) - i0);
    const j0 = Math.max(0, Math.floor((box.south + 90) / COAST_TILE_DEG));
    const j1 = Math.min(N_LAT - 1, Math.floor((box.north + 90) / COAST_TILE_DEG));
    return { i0, span, j0, j1 };
  }

  /**
   * Every piece in the tiles meeting `box`, as its byte offset in one reused buffer (`f64`, `u32`, `u8` are views on
   * it; rawraster.ts reads the pieces there): no object per piece, nothing cached. Drawing land this way kept 18 MB
   * of a whole-world map view where decoding the pieces kept 381 MB (brain, 2026-10-26). Returns how many.
   */
  forEachRaw(box: BBox, fn: (f64: Float64Array, u32: Uint32Array, u8: Uint8Array, piece: number) => void): number {
    const { i0, span, j0, j1 } = this.span(box);
    let count = 0;
    const fd = fs.openSync(path.join(this.dir, 'tiles.bin'), 'r');
    try {
      for (let j = j0; j <= j1; j++)
        for (let k = 0; k <= span; k++) {
          const at = this.find(j * N_LON + ((i0 + k) % N_LON));
          if (at < 0) continue;
          const c0 = this.first[at];
          const c1 = this.first[at + 1];
          let total = 0;
          for (let c = c0; c < c1; c++) total += align8(this.length[c]);
          if (raw.u8.length < total) raw = rawBuffer(Math.max(total, 2 * raw.u8.length));
          if (raw.starts.length < c1 - c0) raw.starts = new Int32Array(2 * (c1 - c0));
          let o = 0;
          for (let c = c0; c < c1; c++) {
            if (fs.readSync(fd, raw.u8, o, this.length[c], this.offset[c]) !== this.length[c])
              throw new Error(`${this.dir}: truncated tile data`);
            raw.starts[c - c0] = o;
            o += align8(this.length[c]);
          }
          for (let q = 0; q < c1 - c0; q++) {
            fn(raw.f64, raw.u32, raw.u8, raw.starts[q]);
            count++;
          }
        }
    } finally {
      fs.closeSync(fd);
    }
    return count;
  }

  /**
   * Every piece in the tiles meeting `box` (across the antimeridian too), tile by tile as each is read: only the
   * tile cache is held, never the whole box (a whole-world view gathered first held 741 MB, brain 2026-10-26).
   * Within a tile the pieces are in level order (the cut reads the files lowest level first), which is all the
   * rasteriser needs: pieces of different tiles never fill the same cell, and the exact tests take the deepest
   * level whatever the order. Returns how many.
   */
  forEach(box: BBox, fn: (s: ShapePolygon) => void): number {
    const { i0, span, j0, j1 } = this.span(box);
    let count = 0;
    for (let j = j0; j <= j1; j++)
      for (let k = 0; k <= span; k++) {
        for (const s of this.tile(j * N_LON + ((i0 + k) % N_LON))) {
          fn(s);
          count++;
        }
      }
    return count;
  }

  /** The pieces meeting `box`, as forEach lists them. */
  read(box: BBox): ShapePolygon[] {
    const out: ShapePolygon[] = [];
    this.forEach(box, s => out.push(s));
    return out;
  }

  /**
   * Exact land test of a point: the deepest GSHHG level whose piece holds it, land when odd. Reads the point's tile
   * only. A point on a tile border is decided by the tile to its east or north, by the same half-open crossing rule
   * the whole record would use.
   */
  containsPoint(lon: number, lat: number): boolean {
    if (!(lat >= -90 && lat <= 90)) return false;
    const l = wrapLon(lon);
    const i = Math.min(N_LON - 1, Math.floor((l + 180) / COAST_TILE_DEG));
    const j = Math.min(N_LAT - 1, Math.floor((lat + 90) / COAST_TILE_DEG));
    let level = 0;
    for (const s of this.tile(j * N_LON + i)) {
      const lv = s.level ?? 1;
      if (lv > level && pointInShape(s, l, lat)) level = lv;
    }
    return level % 2 === 1;
  }

  /** The tile cache, as the status shows it. */
  cacheStats(): { entries: number; bytes: number; budget_bytes: number; hits: number; decodes: number; evictions: number } {
    return {
      entries: this.cache.size,
      bytes: this.cacheBytes,
      budget_bytes: COAST_TILE_CACHE_BYTES,
      hits: this.hits,
      decodes: this.reads,
      evictions: this.evictions,
    };
  }
}

/**
 * A stored piece as a polygon whose arrays are views on `b` (no copy): each ring closed, `real` per edge (the closing
 * one cut), the shortened edges' whole edges in `whole` with their edge indices in `wholeEdges`.
 */
function decodePiece(b: Buffer): ShapePolygon {
  const level = b.readUInt8(4);
  const recordNumber = b.readInt32LE(8);
  const nRings = b.readUInt32LE(12);
  let o = 16;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  const rings: ShapePolygon['rings'] = [];
  for (let r = 0; r < nRings; r++) {
    const n = b.readUInt32LE(o);
    const nShort = b.readUInt32LE(o + 4);
    o += 8;
    const coords = new Float64Array(b.buffer, b.byteOffset + o, 2 * n);
    o += 16 * n;
    let rMinLon = Infinity;
    let rMinLat = Infinity;
    let rMaxLon = -Infinity;
    let rMaxLat = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = coords[2 * i];
      const y = coords[2 * i + 1];
      if (x < rMinLon) rMinLon = x;
      if (x > rMaxLon) rMaxLon = x;
      if (y < rMinLat) rMinLat = y;
      if (y > rMaxLat) rMaxLat = y;
    }
    const whole = nShort ? new Float64Array(b.buffer, b.byteOffset + o, 4 * nShort) : undefined;
    o += 32 * nShort;
    const wholeEdges = nShort ? new Uint32Array(b.buffer, b.byteOffset + o, nShort) : undefined;
    o += 4 * nShort;
    const real = new Uint8Array(b.buffer, b.byteOffset + o, n);
    o = align8(o + n);
    rings.push({ coords, minLon: rMinLon, minLat: rMinLat, maxLon: rMaxLon, maxLat: rMaxLat, real, whole, wholeEdges });
    minLon = Math.min(minLon, rMinLon);
    minLat = Math.min(minLat, rMinLat);
    maxLon = Math.max(maxLon, rMaxLon);
    maxLat = Math.max(maxLat, rMaxLat);
  }
  return { level, recordNumber, minLon, minLat, maxLon, maxLat, rings };
}
