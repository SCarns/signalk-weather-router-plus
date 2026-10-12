/**
 * One leg on the navigation mesh: the tiles read as the search reaches them
 * (paged.ts), the triangles the boat cannot use marked in each, search
 * (astar.ts) and pull the string through the crossed edges (funnel.ts).
 * Motor only: the cost
 * is distance with the mesh's shore and depth penalties over the motor
 * speed; no wind or current. The experiment's mesh_route5.py with
 * RULES=full, ported; the parity test against its saved results is in
 * the experiment folder (not this repo).
 *
 * Blocked triangles (the parent planner's rules, plus the three the grid
 * planner does not check before routing):
 *  - a charted vertical clearance under the air draft + 1 m (an opening
 *    bridge's open clearance; the bridge is blocked outright when the
 *    route's rule for opening bridges is 'avoid');
 *  - a charted depth under the draught + 0.5 m, unless the triangle is in
 *    a fairway, dredged area or recommended track (is_navigable);
 *  - a rock, wreck or obstruction whose charted depth (VALSOU) is under
 *    the draught + 0.5 m, or not charted (hazv = -1e9 in the build);
 *  - a mark (20 m standoff in the build), except a channel mark inside a
 *    fairway or dredged area;
 *  - a structure (pier, bridge pier, …);
 *  - an area to avoid (Signal K notes): the triangle's centroid inside it.
 */

import { haversineDistanceM, type BBox } from '../../geo/geodesy';
import { MinHeap } from '../heap';
import { meshAstar } from './astar';
import { funnel, type XY } from './funnel';
import { type BoundarySeeds, PagedMesh } from './paged';
import { passageWidths } from './width';
import {
  FLAG_CHANNEL_MARK,
  FLAG_DREDGED,
  FLAG_FAIRWAY,
  FLAG_HAZARD,
  FLAG_MARK,
  FLAG_NAVIGABLE,
  FLAG_OPENING_BRIDGE,
  FLAG_STRUCTURE,
  type LoadedMesh,
  type MeshStore,
  NO_VALUE,
  toMeshXY,
} from './store';

/** How a route treats opening bridges: ask (plan as open, report the ones crossed), open, or avoid them. */
export const DRAWBRIDGE_CHOICES = ['ask', 'open', 'avoid'] as const;
export type DrawbridgeChoice = (typeof DRAWBRIDGE_CHOICES)[number];

export interface MeshRules {
  draughtM: number;
  airDraftM: number;
  motorSpeedMs: number;
  /** Opening bridges: 'open' (default) passes them under their open clearance; 'avoid' blocks every one. */
  openingBridges?: 'open' | 'avoid';
  /** Areas to avoid: triangles whose centroid lies within radiusM of the centre are blocked. */
  avoid?: { lon: number; lat: number; radiusM: number }[];
  /** Keep at least this far from every blocked triangle: usable triangles within it are blocked too (0 or absent: none). */
  bufferM?: number;
}

export interface MeshRouteStats {
  /** Distinct triangles and tiles the search read; tile reads, re-reads included; the most triangles held at once. */
  trianglesLoaded: number;
  tiles: number;
  tileReads: number;
  peakTriangles: number;
  /** Triangles blocked (rules and buffer) among those read. */
  blocked: number;
  expanded: number;
  readMs: number;
  prepMs: number;
  searchMs: number;
  funnelMs: number;
  /** The buffer applied (metres), the usable triangles it blocked, and its time. */
  bufferM: number;
  buffered: number;
  bufferMs: number;
}

export type MeshRouteResult =
  | {
      ok: true;
      path: [number, number][];
      /** Per path point: water to the left and to the right of the track, metres, capped at width.ts MAX_SCAN_M. */
      widths: [number, number][];
      lengthM: number;
      costS: number;
      stats: MeshRouteStats;
    }
  | { ok: false; reason: string; stats: MeshRouteStats };

/**
 * Degrees around a leg's ends the worker loads the forecast and currents
 * for (with the rough cut's reach added when it gives one, pipeline.ts):
 * the mesh process reads them from the worker's files only. The search
 * itself reads tiles on demand and has no box.
 */
export const MESH_BOX_PAD_MAX_DEG = 2.0;

/** Every point of the leg lies in the mesh (a tile exists and its extent holds the point). */
export function meshCovers(store: MeshStore, points: [number, number][]): boolean {
  return points.every(p => store.covers(p[0], p[1]));
}

export function blockedTriangles(m: LoadedMesh, rules: MeshRules): Uint8Array {
  const b = new Uint8Array(m.n);
  const minClear = rules.airDraftM + 1;
  const minDepth = rules.draughtM + 0.5;
  const { flags, depth, clear, hazv } = m;
  const avoidOpening = rules.openingBridges === 'avoid';
  for (let t = 0; t < m.n; t++) {
    const f = flags[t];
    if (avoidOpening && f & FLAG_OPENING_BRIDGE) b[t] = 1;
    else if (clear[t] !== NO_VALUE && clear[t] < minClear) b[t] = 1;
    else if (!(f & FLAG_NAVIGABLE) && depth[t] !== NO_VALUE && depth[t] < minDepth) b[t] = 1;
    else if (f & FLAG_HAZARD && hazv[t] < minDepth) b[t] = 1;
    else if (f & FLAG_MARK && !(f & FLAG_CHANNEL_MARK && f & (FLAG_FAIRWAY | FLAG_DREDGED))) b[t] = 1;
    else if (f & FLAG_STRUCTURE) b[t] = 1;
  }
  if (rules.avoid?.length) {
    for (const a of rules.avoid) {
      const [ax, ay] = toMeshXY(m, a.lon, a.lat);
      const r2 = a.radiusM * a.radiusM;
      for (let t = 0; t < m.n; t++) {
        if (b[t]) continue;
        const cx = (m.x[t * 3] + m.x[t * 3 + 1] + m.x[t * 3 + 2]) / 3;
        const cy = (m.y[t * 3] + m.y[t * 3 + 1] + m.y[t * 3 + 2]) / 3;
        if ((cx - ax) * (cx - ax) + (cy - ay) * (cy - ay) <= r2) b[t] = 1;
      }
    }
  }
  return b;
}

/** Distance from point p to segment ab (metres frame). */
function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const l2 = vx * vx + vy * vy;
  let t = l2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/**
 * Grow the blocked set by a distance: every usable triangle whose nearest
 * point lies within `bufferM` of an edge between a blocked triangle and a
 * usable one becomes blocked too (in place). Exact: the distance between
 * a segment and a triangle is attained at a corner of one of them, so the
 * corners of the triangle against the edge and the edge's ends against
 * the triangle's sides are tested.
 *
 * One flood from every boundary edge at once, nearest first: each
 * triangle keeps the nearest boundary edge it has been handed and hands
 * it on to its neighbours with their exact distance to that edge, so a
 * triangle is relaxed a handful of times, not once per edge near it.
 *
 * KNOWN GAP, left on purpose (the owner's decision, 2026-10-08): this is
 * not exact. A triangle hands on only its own nearest edge, so a triangle
 * whose only path from its nearest edge runs through a neighbour nearer
 * to a different edge is never reached. Measured on brain, Block Island
 * to the canal, against the exact walk from every edge separately: 6,517
 * triangles missed of 1,281,634 at 50 m (0.5%), 4,743 of 1,564,288 at
 * 100 m, 3,155 of 2,234,947 at 300 m; the routes came out the same
 * length. The exact alternative is that walk: from each boundary edge,
 * walk outward across shared edges while the triangle's exact distance
 * to that edge is within the buffer (a stamp per edge against revisits).
 * Its cost on the same leg: 26 s at 50 m, 53 s at 100 m, 207 s at 300 m,
 * against 8 s, 11 s and 17 s here (a spatial query per edge before either
 * took 104 s and 312 s). To restore exactness, replace the loop below with
 * that walk; the tests in mesh.test.ts hold for both.
 *
 * Labels spread through adjacent triangles only, so water within the
 * distance only across land (no triangles) or across the blocked region
 * itself is not reached: that is the land buffer's business. Returns how
 * many triangles it blocked. The mesh's own edge (no neighbour) is not a
 * boundary here (docs/plans/buffers-and-tacks.md, item 4).
 *
 * `outerSeeds` (paged.ts, one tile at a time): edges t * 3 + k of usable
 * triangles of this mesh whose neighbour across k, in the next tile, is
 * blocked; they are boundary edges too, the flood starting in t itself.
 * Water within the buffer of a blocked triangle of the next tile that is
 * reached only through a usable triangle of that tile is not seen from
 * here: the known gap's one further case (docs/drafts/mesh-no-gshhg-design.md,
 * part 4 revised).
 */
export function growBlocked(m: LoadedMesh, blocked: Uint8Array, bufferM: number, outerSeeds: number[] = []): number {
  if (!(bufferM > 0)) return 0;
  const { x, y, neighbours: NB, n } = m;
  const original = blocked.slice();
  // The boundary edges, as t * 3 + k, and the usable triangle each floods from.
  const edges: number[] = [];
  const firsts: number[] = [];
  for (let t = 0; t < n; t++) {
    if (!original[t]) continue;
    for (let k = 0; k < 3; k++) {
      const v = NB[t * 3 + k];
      if (v >= 0 && !original[v]) {
        edges.push(t * 3 + k);
        firsts.push(v);
      }
    }
  }
  for (const e of outerSeeds) {
    const t = Math.floor(e / 3);
    if (original[t]) continue;
    edges.push(e);
    firsts.push(t);
  }
  const dist = new Float64Array(n).fill(Infinity);
  const nearest = new Int32Array(n).fill(-1);
  const heap = new MinHeap();
  const toEdge = (u: number, e: number): number => {
    const t = Math.floor(e / 3);
    const k = e % 3;
    const ax = x[t * 3 + k];
    const ay = y[t * 3 + k];
    const bx = x[t * 3 + ((k + 1) % 3)];
    const by = y[t * 3 + ((k + 1) % 3)];
    let d = Infinity;
    for (let c = 0; c < 3; c++) {
      const cx = x[u * 3 + c];
      const cy = y[u * 3 + c];
      const dx = x[u * 3 + ((c + 1) % 3)];
      const dy = y[u * 3 + ((c + 1) % 3)];
      d = Math.min(
        d,
        pointSegmentDistance(cx, cy, ax, ay, bx, by),
        pointSegmentDistance(ax, ay, cx, cy, dx, dy),
        pointSegmentDistance(bx, by, cx, cy, dx, dy)
      );
    }
    return d;
  };
  for (let i = 0; i < edges.length; i++) {
    const first = firsts[i]; // the usable triangle at the edge: distance 0
    if (dist[first] > 0) {
      dist[first] = 0;
      nearest[first] = i;
      heap.push(0, first);
    }
  }
  let added = 0;
  while (heap.size > 0) {
    const d = heap.peekKey();
    const u = heap.pop();
    if (d > dist[u]) continue; // a stale entry
    if (!blocked[u]) {
      blocked[u] = 1;
      added++;
    }
    const e = edges[nearest[u]];
    for (let c = 0; c < 3; c++) {
      const v = NB[u * 3 + c];
      if (v < 0 || original[v]) continue;
      const dv = toEdge(v, e);
      if (dv <= bufferM && dv < dist[v]) {
        dist[v] = dv;
        nearest[v] = nearest[u];
        heap.push(dv, v);
      }
    }
  }
  return added;
}

/** The search's answer with the mesh it read, for the leg to be planned on (legrun.ts, land.ts). */
export interface MeshSearch {
  result: MeshRouteResult;
  /** The extent of the tiles the search read (degrees); around the ends when it read none past them. */
  box: BBox;
  /** The paged mesh the search ran on (its tiles read again on demand by the leg's land). */
  paged: PagedMesh;
}

export function meshRoute(
  store: MeshStore,
  start: [number, number],
  end: [number, number],
  rules: MeshRules,
  boundary: BoundarySeeds | null = null
): MeshRouteResult {
  return searchMesh(store, start, end, rules, boundary).result;
}

/**
 * The mesh search for a leg on the paged mesh (paged.ts): no area is chosen
 * before it; a tile is read when the search first reaches it, and dropped
 * when the search's frontier has left it (astar.ts). The frame is the
 * leg's: cl from the mid-latitude of its ends. `boundary` (the rough cut's
 * record of the tile-boundary triangles for this boat, coarse.ts) seeds the
 * buffer across tile edges.
 */
export function searchMesh(
  store: MeshStore,
  start: [number, number],
  end: [number, number],
  rules: MeshRules,
  boundary: BoundarySeeds | null = null
): MeshSearch {
  const cl = Math.cos(((start[1] + end[1]) / 2) * (Math.PI / 180));
  const pm = new PagedMesh(store, rules, cl, boundary);
  const ends: BBox = {
    west: Math.min(start[0], end[0]),
    east: Math.max(start[0], end[0]),
    south: Math.min(start[1], end[1]),
    north: Math.max(start[1], end[1]),
  };
  const stats = (): MeshRouteStats => ({
    trianglesLoaded: pm.stats.triangles,
    tiles: pm.stats.tiles,
    tileReads: pm.stats.reads,
    peakTriangles: pm.stats.peakTriangles,
    blocked: pm.stats.blocked + pm.stats.buffered,
    expanded,
    readMs: pm.stats.readMs,
    prepMs: pm.stats.prepMs,
    searchMs,
    funnelMs,
    bufferM: rules.bufferM ?? 0,
    buffered: pm.stats.buffered,
    bufferMs: pm.stats.bufferMs,
  });
  let expanded = 0;
  let searchMs = 0;
  let funnelMs = 0;
  const done = (result: MeshRouteResult): MeshSearch => ({ result, box: pm.touchedBox() ?? ends, paged: pm });
  const [sx, sy] = pm.toXY(start[0], start[1]);
  const [ex, ey] = pm.toXY(end[0], end[1]);
  const st = pm.locate(sx, sy);
  const et = pm.locate(ex, ey);
  if (st < 0 || et < 0) return done({ ok: false, reason: `${st < 0 ? 'start' : 'end'} point is not in a mesh triangle`, stats: stats() });
  // The ends against the rules themselves, before the buffer: inside a blocked triangle is one error, inside the buffer another.
  const S = pm.tileOf(st);
  const E = pm.tileOf(et);
  const endsBlocked = [S.ruleBlocked[st - S.first] === 1, E.ruleBlocked[et - E.first] === 1];
  if (endsBlocked[0] || endsBlocked[1])
    return done({ ok: false, reason: `${endsBlocked[0] ? 'start' : 'end'} point is in a blocked triangle`, stats: stats() });
  const inBuffer = [S.blocked[st - S.first] === 1, E.blocked[et - E.first] === 1];
  if (inBuffer[0] || inBuffer[1])
    return done({
      ok: false,
      reason: `${inBuffer[0] ? 'start' : 'end'} point is within the buffer ({length:${rules.bufferM}}) of unusable water`,
      stats: stats(),
    });
  const t0 = Date.now();
  const r = meshAstar(pm, st, et, sx, sy, ex, ey, rules.motorSpeedMs);
  searchMs = Date.now() - t0;
  expanded = r.expanded;
  if (r.goalNode === -2)
    return done({
      ok: false,
      reason: 'no route on the mesh between the start and the end for this boat (the search ran out of water it may use)',
      stats: stats(),
    });
  const t1 = Date.now();
  // The crossed edges from the start, each as [left corner, right corner] going forward.
  const portals: [XY, XY][] = r.crossings().map(([t, k]) => {
    const T = pm.tileOf(t);
    const l = t - T.first;
    const a = l * 3 + ((k + 1) % 3);
    const b = l * 3 + k;
    return [
      [T.x[a], T.y[a]],
      [T.x[b], T.y[b]],
    ];
  });
  const pathXY = funnel(portals, [sx, sy], [ex, ey]);
  const widths = passageWidths(pm, pathXY, st);
  funnelMs = Date.now() - t1;
  const path = pathXY.map(p => pm.fromXY(p[0], p[1]));
  let lengthM = 0;
  for (let i = 1; i < path.length; i++) lengthM += haversineDistanceM(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
  return done({ ok: true, path, widths, lengthM, costS: r.goalG, stats: stats() });
}
