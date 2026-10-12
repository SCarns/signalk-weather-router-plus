/**
 * The rough cuts of the chart meshes (engine/mesh/coarse.ts) on disk, and
 * the two child tasks that use them (childtask.ts): `mesh-coarse` builds
 * one mesh's rough cut for one boat, `mesh-corridor` finds a leg's
 * corridor of tiles on it. Both read mesh tiles, so they run in child
 * processes and the tiles never stay in Signal K's memory.
 *
 * Kept under `<data dir>/mesh-coarse/`, one file per mesh build and boat:
 * `<build key>-d<draught>-a<air draft>.json`, the build key a hash of the
 * mesh's index.json (a new build is a new key). Built after a mesh is
 * downloaded or updated, on the plugin configuration's Rebuild button, and
 * by a route that needs one not built yet; never at plugin start (the
 * owner's choice, 2026-10-12).
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BBox } from '../geo/geodesy';
import { buildCoarseMap, type CoarseMap, type CoarseRules, COARSE_VERSION, coarseRoute, corridorOf, pieceAt } from '../engine/mesh/coarse';
import { MeshStore } from '../engine/mesh/store';

export const COARSE_DIR = 'mesh-coarse';
/** Rough cuts kept per mesh build (other boats' maps beyond these are removed, oldest first). */
export const COARSE_KEEP_PER_MESH = 4;
/** Rings of neighbour tiles a corridor offers the mesh search: one, then two. */
export const CORRIDOR_RINGS = 2;

/** The key of a mesh build: a hash of its index.json (one per cluster folder). */
export function coarseKey(meshDir: string): string {
  return createHash('sha1')
    .update(fs.readFileSync(path.join(meshDir, 'index.json')))
    .digest('hex')
    .slice(0, 16);
}

/** The rough-cut file of a mesh folder for a boat. */
export function coarseFile(dataDir: string, meshDir: string, rules: CoarseRules): string {
  return path.join(dataDir, COARSE_DIR, `${coarseKey(meshDir)}-d${rules.draughtM.toFixed(2)}-a${rules.airDraftM.toFixed(2)}.json`);
}

/**
 * Remove the rough cuts of builds no longer in use (`liveKeys`), and beyond
 * COARSE_KEEP_PER_MESH per build the oldest. Returns how many went.
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
  const byKey = new Map<string, { name: string; mtimeMs: number }[]>();
  for (const n of names) {
    const key = n.split('-')[0];
    const p = path.join(dir, n);
    if (!liveKeys.has(key)) {
      fs.rmSync(p, { force: true });
      removed++;
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
    for (const old of list.slice(COARSE_KEEP_PER_MESH)) {
      fs.rmSync(path.join(dir, old.name), { force: true });
      removed++;
    }
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
  bytes: number;
  ms: number;
}

/** Build one mesh folder's rough cut and write it (to a temporary name, then renamed: a reader never sees half a file). */
export function runMeshCoarseTask(t: MeshCoarseTask): MeshCoarseResult {
  const t0 = Date.now();
  const map = buildCoarseMap(MeshStore.open(t.dir), t.rules);
  const text = JSON.stringify(map);
  fs.mkdirSync(path.dirname(t.out), { recursive: true });
  const tmp = `${t.out}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, t.out);
  return { pieces: map.pieces.length, links: map.links.length, bytes: text.length, ms: Date.now() - t0 };
}

export interface MeshCorridorTask {
  task: 'mesh-corridor';
  dir: string;
  mapFile: string;
  start: [number, number];
  end: [number, number];
  rules: CoarseRules;
}

export type MeshCorridorResult =
  { ok: true; rings: [number, number][][]; box: BBox; lengthM: number; chainTiles: number } | { ok: false; reason: string };

/** A leg's corridor on the rough cut: the piece under each end, the chain of pieces between them, its tiles and rings. */
export function runMeshCorridorTask(t: MeshCorridorTask): MeshCorridorResult {
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
  const c = corridorOf(store, map, chain, CORRIDOR_RINGS);
  return { ok: true, rings: c.rings, box: c.box, lengthM: c.lengthM, chainTiles: c.chainTiles.length };
}
