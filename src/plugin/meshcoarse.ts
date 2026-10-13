/**
 * The rough cuts of the chart meshes (engine/mesh/coarse.ts) on disk, and
 * the two child tasks that use them (childtask.ts): `mesh-coarse` builds
 * one mesh's rough cut for one boat, `mesh-reach` finds a leg's reach on
 * it (whether water connects the ends, and the box of the tiles it runs
 * through). Both read mesh tiles, so they run in child processes and the
 * tiles never stay in Signal K's memory.
 *
 * Kept under `<data dir>/mesh-coarse/`, two files per mesh build, boat,
 * buffer and Drawbridges choice:
 * `<build key>-v<version>-d<draught>-a<air draft>-b<buffer>-<o|x>.json`
 * (the pieces and links; o: opening bridges open, x: avoided) and the same
 * name with `.bnd` (the tile-boundary triangles, raw
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
import {
  boundarySeeds,
  buildCoarseMap,
  type CoarseMap,
  type CoarseRules,
  COARSE_VERSION,
  coarseRoute,
  meshRulesOf,
  PieceGraph,
} from '../engine/mesh/coarse';
import { type BoundarySeeds, PagedMesh } from '../engine/mesh/paged';
import type { MeshRules } from '../engine/mesh/route';
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

/** The rough-cut file (.json) of a mesh folder for a boat, buffer and Drawbridges choice. */
export function coarseFile(dataDir: string, meshDir: string, rules: CoarseRules): string {
  const r = rules;
  return path.join(
    dataDir,
    COARSE_DIR,
    `${coarseKey(meshDir)}-v${COARSE_VERSION}-d${r.draughtM.toFixed(2)}-a${r.airDraftM.toFixed(2)}-b${r.bufferM.toFixed(2)}-${r.openingBridges === 'avoid' ? 'x' : 'o'}.json`
  );
}

/** A rough cut's rules from a mesh leg's (the buffer absent: none; opening bridges absent: open). */
export function coarseRulesOf(rules: Pick<MeshRules, 'draughtM' | 'airDraftM' | 'bufferM' | 'openingBridges'>): CoarseRules {
  return {
    draughtM: rules.draughtM,
    airDraftM: rules.airDraftM,
    bufferM: rules.bufferM ?? 0,
    openingBridges: rules.openingBridges === 'avoid' ? 'avoid' : 'open',
  };
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

/** A rough cut read from disk for a mesh and the rules, or why it cannot be used (another build or other rules). */
export function readCoarseMap(file: string, store: MeshStore, rules: CoarseRules, name: string): CoarseMap | string {
  const map = JSON.parse(fs.readFileSync(file, 'utf8')) as CoarseMap;
  if (
    map.version !== COARSE_VERSION ||
    map.triangles !== store.index.triangles ||
    map.draughtM !== rules.draughtM ||
    map.airDraftM !== rules.airDraftM ||
    map.bufferM !== rules.bufferM ||
    map.openingBridges !== rules.openingBridges
  )
    return `the rough cut of ${name} on disk is for another build of the mesh or other rules; rebuild it in the plugin configuration`;
  return map;
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
 * a reader never sees half a file, and a map on disk has its boundary file beside it). Two passes over the tiles:
 * the boundary record, then every tile read through the paged mesh with it (the search's blocked sets).
 */
export function runMeshCoarseTask(t: MeshCoarseTask): MeshCoarseResult {
  const t0 = Date.now();
  const store = MeshStore.open(t.dir);
  const boundary = boundarySeeds(store, t.rules);
  fs.mkdirSync(path.dirname(t.out), { recursive: true });
  writeBoundary(boundaryFile(t.out), boundary);
  const ix = store.index;
  const pm = new PagedMesh(store, meshRulesOf(t.rules), Math.cos((((ix.south + ix.north) / 2) * Math.PI) / 180), boundary);
  const map = buildCoarseMap(store, t.rules, pm);
  const text = JSON.stringify(map);
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
  /** The leg's start, its waypoint circles in order, its end; a circle (radiusM) for an approximate waypoint. */
  points: { lon: number; lat: number; radiusM?: number; name: string }[];
  rules: CoarseRules;
  /** The request's areas to avoid. */
  avoid?: MeshRules['avoid'];
}

export type MeshReachResult =
  | {
      ok: true;
      box: BBox;
      lengthM: number;
      chainTiles: number;
      /**
       * Per point after the start: for an approximate waypoint, the point the leg aims at (the waypoint itself, or
       * the nearest usable water connected to the start), the triangle it was chosen in (global id: the point can
       * lie on a corner shared with a triangle of other water), and how far it lies from the waypoint; null for an
       * exact one.
       */
      aims: ({ lon: number; lat: number; tri: number; movedM: number } | null)[];
    }
  | { ok: false; reason: string };

/**
 * A leg's reach on the rough cut, under the request's rules (the rough cut's, plus its areas to avoid: PieceGraph).
 * The start and every exact point must lie on usable water connected to the start; an approximate waypoint aims at
 * itself when it does, else at the nearest usable water that does (part 3; the owner's choice: moved, with a
 * warning when outside its circle). Then the chains of pieces from each point to the next give the box of tiles
 * the water runs through.
 */
export function runMeshReachTask(t: MeshReachTask): MeshReachResult {
  const store = MeshStore.open(t.dir);
  const map = JSON.parse(fs.readFileSync(t.mapFile, 'utf8')) as CoarseMap;
  if (
    map.version !== COARSE_VERSION ||
    map.triangles !== store.index.triangles ||
    map.draughtM !== t.rules.draughtM ||
    map.airDraftM !== t.rules.airDraftM ||
    map.bufferM !== t.rules.bufferM ||
    map.openingBridges !== t.rules.openingBridges
  )
    return {
      ok: false,
      reason: 'the rough cut on disk is for another build of the mesh or other rules; rebuild it in the plugin configuration',
    };
  const lats = t.points.map(p => p.lat);
  const cl = Math.cos((((Math.min(...lats) + Math.max(...lats)) / 2) * Math.PI) / 180);
  const pm = new PagedMesh(store, meshRulesOf(t.rules, t.avoid), cl, readBoundary(boundaryFile(t.mapFile)));
  const graph = new PieceGraph(map, pm);
  // Each point's pieces: of every usable triangle it touches (a corner or an edge can touch water of two groups).
  const piecesAt = (lon: number, lat: number): number[] => {
    const out: number[] = [];
    for (const tri of pm.locateAll(...pm.toXY(lon, lat))) {
      const q = graph.pieceOf(tri);
      if (q !== null && !out.includes(q)) out.push(q);
    }
    return out;
  };
  const at = t.points.map(p => (p.radiusM === undefined || p === t.points[0] ? piecesAt(p.lon, p.lat) : []));
  // The route's water: a connected group the start and every exact point touch.
  let groups: number[] | null = null;
  for (let k = 0; k < t.points.length; k++) {
    const p = t.points[k];
    if (k > 0 && p.radiusM !== undefined) continue;
    if (!at[k].length) return { ok: false, reason: unusable(pm, pm.locate(...pm.toXY(p.lon, p.lat), true), p.name, t.rules.bufferM) };
    const here = [...new Set(at[k].map(q => graph.component(q)))];
    groups = groups === null ? here : groups.filter(c => here.includes(c));
    if (!groups.length) return { ok: false, reason: noWater(p.name, t.rules) };
  }
  const group = groups![0];
  const pieces: number[] = [];
  const aims: ({ lon: number; lat: number; tri: number; movedM: number } | null)[] = [];
  for (let k = 0; k < t.points.length; k++) {
    const p = t.points[k];
    if (k === 0 || p.radiusM === undefined) {
      pieces.push(at[k].find(q => graph.component(q) === group)!);
      if (k > 0) aims.push(null);
      continue;
    }
    // An approximate waypoint: itself when it is usable water of the route's group, else the nearest that is.
    const nu = pm.nearestUsable(...pm.toXY(p.lon, p.lat), tri => {
      const q = graph.pieceOf(tri);
      return q !== null && graph.component(q) === group;
    });
    if (!nu) return { ok: false, reason: noWater(p.name, t.rules) };
    const [lon, lat] = nu.distM > 0 ? pm.fromXY(nu.x, nu.y) : [p.lon, p.lat];
    pieces.push(graph.pieceOf(nu.tri)!);
    aims.push({ lon, lat, tri: nu.tri, movedM: nu.distM });
  }
  const chains: number[][] = [];
  for (let k = 1; k < pieces.length; k++) chains.push(coarseRoute(graph, pieces[k - 1], pieces[k])!);
  const r = graph.reach(chains);
  return { ok: true, box: r.box, lengthM: r.lengthM, chainTiles: r.chainTiles, aims };
}

/** Why a point's water is not usable: outside the mesh, blocked (with the charted depth), or within the buffer. */
function unusable(pm: PagedMesh, g: number, name: string, bufferM: number): string {
  if (g < 0) return `${name} is not on a triangle of the mesh`;
  const T = pm.tileOf(g);
  const l = g - T.first;
  if (!T.ruleBlocked[l]) return `${name} is within the buffer ({length:${bufferM}}) of water the boat cannot use`;
  const d = T.depth[l];
  return `${name} is on water the boat cannot use${d !== -999 ? ` (charted depth {depth:${d}})` : ' (a hazard, mark, structure, clearance or area to avoid)'}`;
}

function noWater(name: string, rules: CoarseRules): string {
  return `no water on the chart mesh connects the start and ${name} for this boat (draught {depth:${rules.draughtM}}, air draft {length:${rules.airDraftM}}${rules.bufferM > 0 ? `, keeping {length:${rules.bufferM}} from water it cannot use` : ''})`;
}

export interface MeshSnapTask {
  task: 'mesh-snap';
  dir: string;
  mapFile: string;
  /** The route's exact stops in this mesh, in route order (start, exact waypoints, end), each with its name. */
  points: { lon: number; lat: number; name: string }[];
  rules: CoarseRules;
  avoid?: MeshRules['avoid'];
  /** The farthest a stop is moved, metres (the owner's choice, 2026-10-12: 1,000 m); farther is an error. */
  maxMoveM: number;
}

/** Per point: where it goes (itself when its water is usable and connected), how far, and why it moved. */
export type MeshSnapResult =
  | { ok: true; points: { lon: number; lat: number; movedM: number; why: string | null; outsideGroup: boolean }[] }
  | { ok: false; reason: string };

/**
 * Snap the route's exact stops in one mesh (docs/drafts/mesh-no-gshhg-design.md, part 2; the owner's choices of
 * 2026-10-12): a stop on water the boat cannot use under the route's rules (blocked, in the buffer, or on land: no
 * triangle), or on water not connected to the route's, moves to the nearest usable water connected to the route,
 * at most `maxMoveM`. The route's water is the connected group of the last stop in this mesh (the destination, or
 * where the route leaves the mesh): its own when it is usable, else that of the usable water nearest it. So a start
 * in a pond moves out to water connected to the destination.
 */
export function runMeshSnapTask(t: MeshSnapTask): MeshSnapResult {
  const store = MeshStore.open(t.dir);
  const map = JSON.parse(fs.readFileSync(t.mapFile, 'utf8')) as CoarseMap;
  if (
    map.version !== COARSE_VERSION ||
    map.triangles !== store.index.triangles ||
    map.draughtM !== t.rules.draughtM ||
    map.airDraftM !== t.rules.airDraftM ||
    map.bufferM !== t.rules.bufferM ||
    map.openingBridges !== t.rules.openingBridges
  )
    return {
      ok: false,
      reason: 'the rough cut on disk is for another build of the mesh or other rules; rebuild it in the plugin configuration',
    };
  const lats = t.points.map(p => p.lat);
  const cl = Math.cos((((Math.min(...lats) + Math.max(...lats)) / 2) * Math.PI) / 180);
  const pm = new PagedMesh(store, meshRulesOf(t.rules, t.avoid), cl, readBoundary(boundaryFile(t.mapFile)));
  const graph = new PieceGraph(map, pm);
  const groupOf = (g: number): number | null => {
    const p = graph.pieceOf(g);
    return p === null ? null : graph.component(p);
  };
  // The groups of the usable water a point touches (a corner or an edge can touch water of two groups).
  const groupsAt = (px: number, py: number): number[] => [
    ...new Set(pm.locateAll(px, py).flatMap(tri => (groupOf(tri) === null ? [] : [groupOf(tri)!]))),
  ];
  // The route's water: the last stop's connected group (its own water, or the usable water nearest it); of several
  // its point touches, one the first stop touches too.
  const last = t.points[t.points.length - 1];
  const [lx, ly] = pm.toXY(last.lon, last.lat);
  let lastGroups = groupsAt(lx, ly);
  if (!lastGroups.length) {
    const nu = pm.nearestUsable(lx, ly);
    if (!nu) return { ok: false, reason: 'the chart mesh has no water this boat can use' };
    lastGroups = [groupOf(nu.tri)!];
  }
  const firstGroups = groupsAt(...pm.toXY(t.points[0].lon, t.points[0].lat));
  const group = lastGroups.find(c => firstGroups.includes(c)) ?? lastGroups[0];
  const out: Extract<MeshSnapResult, { ok: true }>['points'] = [];
  for (const p of t.points) {
    const [px, py] = pm.toXY(p.lon, p.lat);
    const here = groupsAt(px, py);
    if (here.includes(group)) {
      out.push({ lon: p.lon, lat: p.lat, movedM: 0, why: null, outsideGroup: false });
      continue;
    }
    const usable = here.length > 0;
    const why = usable
      ? 'its water does not connect to the route for this boat'
      : whyUnusable(pm, pm.locate(px, py, true), t.rules.bufferM);
    const nu = pm.nearestUsable(px, py, tri => groupOf(tri) === group);
    if (!nu)
      return {
        ok: false,
        reason: `${p.name}, at ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}, ${why}, and no usable water connected to the route was found`,
      };
    const [lon, lat] = pm.fromXY(nu.x, nu.y);
    if (nu.distM > t.maxMoveM)
      return {
        ok: false,
        reason: `${p.name}, at ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}, ${why}; the nearest water this boat can use, connected to the route, is {length:${nu.distM.toFixed(0)}} away at ${lat.toFixed(4)}, ${lon.toFixed(4)}, more than {length:${t.maxMoveM}}; move it there or into deeper water`,
      };
    out.push({ lon, lat, movedM: nu.distM, why, outsideGroup: usable });
  }
  return { ok: true, points: out };
}

/** Why a point's water is not usable on the mesh: on land (no triangle), blocked (with what blocks it), or in the buffer. */
function whyUnusable(pm: PagedMesh, g: number, bufferM: number): string {
  if (g < 0) return 'is on land';
  const T = pm.tileOf(g);
  const l = g - T.first;
  if (!T.ruleBlocked[l]) return `is within {length:${bufferM}} of water the boat cannot use`;
  const d = T.depth[l];
  return d !== -999
    ? `is on charted depth {depth:${d}}, too shallow for this boat`
    : 'is on a hazard, mark, structure, low clearance or area to avoid';
}
