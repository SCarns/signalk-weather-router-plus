/**
 * The rough cuts of the chart meshes (engine/mesh/coarse.ts) on disk, and
 * the two child tasks that use them (childtask.ts): `mesh-coarse` builds
 * one mesh's rough cut for one boat, `mesh-reach` finds a leg's reach on
 * it (whether water connects the ends, and the box of the tiles it runs
 * through). Both read mesh tiles, so they run in child processes and the
 * tiles never stay in Signal K's memory.
 *
 * Kept under `<data dir>/mesh-coarse/`, two files per mesh build and boat:
 * `<build key>-v<version>-d<draught>-a<air draft>.json` (the pieces and
 * links) and the same name with `.bnd` (the tile-boundary triangles, raw
 * Int32: the count blocked, the count of opening bridges, then the ids of
 * each, ascending), the build key a hash of the mesh's index.json (a new
 * build is a new key). The `.bnd` is written first: a `.json` means both
 * are there. Built after a mesh is downloaded or updated, on the plugin
 * configuration's Rebuild button, and by a route that needs one not built
 * yet; never at plugin start (the owner's choice, 2026-10-12).
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BBox } from '../geo/geodesy';
import { buildCoarseMap, type CoarseMap, type CoarseRules, COARSE_VERSION, coarseRoute, pieceAt, reachOf } from '../engine/mesh/coarse';
import type { BoundarySeeds } from '../engine/mesh/paged';
import { MeshStore } from '../engine/mesh/store';

export const COARSE_DIR = 'mesh-coarse';
/** Rough cuts kept per mesh build (other boats' maps beyond these are removed, oldest first). */
export const COARSE_KEEP_PER_MESH = 4;

/** The key of a mesh build: a hash of its index.json (one per cluster folder). */
export function coarseKey(meshDir: string): string {
  return createHash('sha1')
    .update(fs.readFileSync(path.join(meshDir, 'index.json')))
    .digest('hex')
    .slice(0, 16);
}

/** The rough-cut file (.json) of a mesh folder for a boat. */
export function coarseFile(dataDir: string, meshDir: string, rules: CoarseRules): string {
  return path.join(
    dataDir,
    COARSE_DIR,
    `${coarseKey(meshDir)}-v${COARSE_VERSION}-d${rules.draughtM.toFixed(2)}-a${rules.airDraftM.toFixed(2)}.json`
  );
}

/** The tile-boundary file (.bnd) beside a rough-cut file. */
export function boundaryFile(mapFile: string): string {
  return mapFile.replace(/\.json$/, '.bnd');
}

export function writeBoundary(file: string, b: BoundarySeeds): void {
  const out = new Int32Array(2 + b.blocked.length + b.bridges.length);
  out[0] = b.blocked.length;
  out[1] = b.bridges.length;
  out.set(b.blocked, 2);
  out.set(b.bridges, 2 + b.blocked.length);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, Buffer.from(out.buffer, out.byteOffset, out.byteLength));
  fs.renameSync(tmp, file);
}

export function readBoundary(file: string): BoundarySeeds {
  const buf = fs.readFileSync(file);
  const all = new Int32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const nb = all[0];
  const nr = all[1];
  if (all.length !== 2 + nb + nr) throw new Error(`${path.basename(file)}: ${all.length} values, expected ${2 + nb + nr}`);
  return { blocked: all.subarray(2, 2 + nb), bridges: all.subarray(2 + nb) };
}

/**
 * Remove the rough cuts of builds no longer in use (`liveKeys`) or of
 * another version, and beyond COARSE_KEEP_PER_MESH per build the oldest
 * (a map and its boundary file go together). Returns how many maps went.
 */
export function pruneCoarse(dataDir: string, liveKeys: Set<string>): number {
  const dir = path.join(dataDir, COARSE_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter(n => n.endsWith('.json'));
  } catch {
    return 0;
  }
  let removed = 0;
  const rm = (n: string): void => {
    fs.rmSync(path.join(dir, n), { force: true });
    fs.rmSync(boundaryFile(path.join(dir, n)), { force: true });
    removed++;
  };
  const byKey = new Map<string, { name: string; mtimeMs: number }[]>();
  for (const n of names) {
    const [key, version] = n.split('-');
    const p = path.join(dir, n);
    if (!liveKeys.has(key) || version !== `v${COARSE_VERSION}`) {
      rm(n);
      continue;
    }
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(p).mtimeMs;
    } catch {
      continue;
    }
    const list = byKey.get(key) ?? [];
    list.push({ name: n, mtimeMs });
    byKey.set(key, list);
  }
  for (const list of byKey.values()) {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const old of list.slice(COARSE_KEEP_PER_MESH)) rm(old.name);
  }
  return removed;
}

export interface MeshCoarseTask {
  task: 'mesh-coarse';
  dir: string;
  out: string;
  rules: CoarseRules;
}

export interface MeshCoarseResult {
  pieces: number;
  links: number;
  /** Tile-boundary triangles blocked for the boat, and opening bridges among the boundary triangles. */
  boundaryBlocked: number;
  boundaryBridges: number;
  /** Bytes of the two files. */
  bytes: number;
  ms: number;
}

/**
 * Build one mesh folder's rough cut and write it, the boundary file first (each to a temporary name, then renamed:
 * a reader never sees half a file, and a map on disk has its boundary file beside it).
 */
export function runMeshCoarseTask(t: MeshCoarseTask): MeshCoarseResult {
  const t0 = Date.now();
  const { map, boundary } = buildCoarseMap(MeshStore.open(t.dir), t.rules);
  const text = JSON.stringify(map);
  fs.mkdirSync(path.dirname(t.out), { recursive: true });
  writeBoundary(boundaryFile(t.out), boundary);
  const tmp = `${t.out}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, t.out);
  return {
    pieces: map.pieces.length,
    links: map.links.length,
    boundaryBlocked: boundary.blocked.length,
    boundaryBridges: boundary.bridges.length,
    bytes: text.length + 4 * (2 + boundary.blocked.length + boundary.bridges.length),
    ms: Date.now() - t0,
  };
}

export interface MeshReachTask {
  task: 'mesh-reach';
  dir: string;
  mapFile: string;
  start: [number, number];
  end: [number, number];
  rules: CoarseRules;
}

export type MeshReachResult = { ok: true; box: BBox; lengthM: number; chainTiles: number } | { ok: false; reason: string };

/** A leg's reach on the rough cut: the piece under each end, the chain of pieces between them, the box of its tiles. */
export function runMeshReachTask(t: MeshReachTask): MeshReachResult {
  const store = MeshStore.open(t.dir);
  const map = JSON.parse(fs.readFileSync(t.mapFile, 'utf8')) as CoarseMap;
  if (map.version !== COARSE_VERSION || map.triangles !== store.index.triangles)
    return { ok: false, reason: 'the rough cut on disk is for another build of the mesh; rebuild it in the plugin configuration' };
  const ends: number[] = [];
  for (const [which, p] of [
    ['start', t.start],
    ['end', t.end],
  ] as const) {
    const r = pieceAt(store, map, t.rules, p[0], p[1]);
    if (r.kind === 'outside') return { ok: false, reason: `the ${which} point is not on a triangle of the mesh` };
    if (r.kind === 'blocked')
      return {
        ok: false,
        reason: `the ${which} point is on water the boat cannot use${r.depth !== null ? ` (charted depth {depth:${r.depth}})` : ' (a hazard, mark, structure or clearance)'}`,
      };
    ends.push(r.piece);
  }
  const chain = coarseRoute(map, ends[0], ends[1]);
  if (!chain)
    return {
      ok: false,
      reason: `no water on the chart mesh connects the start and the end for this boat (draught {depth:${t.rules.draughtM}}, air draft {length:${t.rules.airDraftM}})`,
    };
  const r = reachOf(store, map, chain);
  return { ok: true, box: r.box, lengthM: r.lengthM, chainTiles: r.chainTiles.length };
}
