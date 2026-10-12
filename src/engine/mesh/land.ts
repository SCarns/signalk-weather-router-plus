/**
 * The chart mesh as the router's land: the four checks the search, the
 * tack layout, the polish and the smoother make (geo/landmask.ts
 * LandTest), answered from the paged mesh (paged.ts) and its blocked
 * triangles. A point is unusable when the triangle under it is blocked, or
 * when no triangle holds it (outside the mesh). A straight move is
 * unusable when the walk from the triangle under its start along it meets
 * a blocked triangle or leaves the mesh before its end: the walk that
 * measures passage widths (width.ts), the test the mesh route itself is
 * built with. Tiles are read as the checks reach them; `release` lets go
 * of the ones held (the leg planner calls it after each stretch it
 * searched). No copy of the chart, no raster.
 */

import type { LandTest } from '../../geo/landmask';
import type { PagedMesh } from './paged';
import { FLAG_OPENING_BRIDGE, NO_VALUE } from './store';
import { rayWalk } from './width';

export class MeshLand implements LandTest {
  constructor(readonly pm: PagedMesh) {}

  /** Bytes of the point indexes held. */
  indexBytes(): number {
    return this.pm.indexBytes();
  }

  /** Let go of the tiles held (read again when asked for). */
  release(): void {
    this.pm.retain(() => false);
  }

  /**
   * The triangle holding the point (metres frame), global id or -1. Corners
   * wind counter-clockwise; a point on a shared edge or corner counts for
   * the first triangle met, unless `preferUsable`: then a usable triangle
   * holding the point wins over a blocked one (a mesh route corner on a
   * depth contour belongs to the water the route uses).
   */
  locate(px: number, py: number, preferUsable = false): number {
    return this.pm.locate(px, py, preferUsable);
  }

  /** The triangle under a position, or -1. */
  triangleAt(lon: number, lat: number, preferUsable = false): number {
    const [px, py] = this.pm.toXY(lon, lat);
    return this.locate(px, py, preferUsable);
  }

  /** Charted depth under a position, metres, or null (no triangle, or none charted); a contour corner reports the usable side. */
  depthAt(lon: number, lat: number): number | null {
    const t = this.triangleAt(lon, lat, true);
    if (t < 0) return null;
    const T = this.pm.tileOf(t);
    const d = T.depth[t - T.first];
    return d === NO_VALUE ? null : d;
  }

  /**
   * Every triangle the straight move a→b (mesh frame) passes through, in
   * order, blocked or not, starting with the one under a; stops where the
   * move leaves the mesh. The walk of width.ts rayWalk, reporting each
   * triangle (global id) with the stretch of the move inside it (metres
   * from a, the exit capped at the move's end). Returns how far the walk
   * got: the move's length when it reached b, less where it left the mesh,
   * -1 when no triangle holds a.
   */
  forEachTriangleAlong(ax: number, ay: number, bx: number, by: number, fn: (tri: number, from: number, to: number) => void): number {
    let cur = this.locate(ax, ay, true);
    if (cur < 0) return -1;
    const len = Math.hypot(bx - ax, by - ay);
    if (len <= 0) {
      fn(cur, 0, 0);
      return 0;
    }
    const dx = (bx - ax) / len;
    const dy = (by - ay) / len;
    let T = this.pm.tileOf(cur);
    let entry = -1;
    let s = 0;
    for (let iter = 0; iter < 100000; iter++) {
      const l = cur - T.first;
      const { x, y } = T;
      let bestS = Infinity;
      let bestK = -1;
      for (let k = 0; k < 3; k++) {
        if (k === entry) continue;
        const a = l * 3 + k;
        const b = l * 3 + ((k + 1) % 3);
        const ex = x[b] - x[a];
        const ey = y[b] - y[a];
        if (ex * dy - ey * dx >= 0) continue;
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-18) continue;
        const wx = x[a] - ax;
        const wy = y[a] - ay;
        const sHit = (wx * ey - wy * ex) / den;
        const u = (wx * dy - wy * dx) / den;
        if (u < -1e-7 || u > 1 + 1e-7) continue;
        if (sHit < s - 1e-9) continue;
        if (sHit < bestS) {
          bestS = sHit;
          bestK = k;
        }
      }
      if (bestK < 0) {
        // A numerical dead end: no exit found, the walk stops in this triangle.
        fn(cur, s, s);
        return s;
      }
      const exit = Math.min(Math.max(bestS, s), len);
      fn(cur, s, exit);
      if (bestS >= len) return len;
      const n = T.nb[l * 3 + bestK];
      if (n < 0) return exit;
      s = exit;
      entry = T.rev[l * 3 + bestK];
      cur = n;
      if (n < T.first || n >= T.first + T.n) T = this.pm.tileOf(n);
    }
    return s;
  }

  /**
   * The opening bridges the move a→b passes under: one entry per run of
   * bridge triangles, at the first one's centroid, with the charted open
   * clearance (null when none is charted).
   */
  openingBridgesAlong(lonA: number, latA: number, lonB: number, latB: number): { lon: number; lat: number; clearM: number | null }[] {
    const [ax, ay] = this.pm.toXY(lonA, latA);
    const [bx, by] = this.pm.toXY(lonB, latB);
    const out: { lon: number; lat: number; clearM: number | null }[] = [];
    let inBridge = false;
    this.forEachTriangleAlong(ax, ay, bx, by, t => {
      const T = this.pm.tileOf(t);
      const l = t - T.first;
      const on = (T.flags[l] & FLAG_OPENING_BRIDGE) !== 0;
      if (on && !inBridge) {
        const cx = (T.x[l * 3] + T.x[l * 3 + 1] + T.x[l * 3 + 2]) / 3;
        const cy = (T.y[l * 3] + T.y[l * 3 + 1] + T.y[l * 3 + 2]) / 3;
        const [lon, lat] = this.pm.fromXY(cx, cy);
        out.push({ lon, lat, clearM: T.clear[l] === NO_VALUE ? null : T.clear[l] });
      }
      inBridge = on;
    });
    return out;
  }

  isLand(lon: number, lat: number): boolean {
    // A point on a shared edge or corner belongs to the usable triangle, as legCrossesLandExact locates its start.
    const t = this.triangleAt(lon, lat, true);
    return t < 0 || this.pm.isBlocked(t);
  }

  isLandExact(lon: number, lat: number): boolean {
    return this.isLand(lon, lat);
  }

  /** Does the straight move a→b (in the mesh frame) meet a blocked triangle or leave the mesh? */
  legCrossesLandExact(lonA: number, latA: number, lonB: number, latB: number): boolean {
    const [ax, ay] = this.pm.toXY(lonA, latA);
    const [bx, by] = this.pm.toXY(lonB, latB);
    const ta = this.locate(ax, ay, true);
    if (ta < 0 || this.pm.isBlocked(ta)) return true;
    const len = Math.hypot(bx - ax, by - ay);
    if (len <= 0) return false;
    const r = rayWalk(this.pm, ta, ax, ay, (bx - ax) / len, (by - ay) / len, len);
    // The walk stops short at a blocked triangle, the mesh's edge, or a numerical dead end: all unusable.
    return r.dist < len - 1e-6;
  }

  legsCrossLandBulk(lonsA: ArrayLike<number>, latsA: ArrayLike<number>, lonsB: ArrayLike<number>, latsB: ArrayLike<number>): Uint8Array {
    const n = lonsA.length;
    const out = new Uint8Array(n);
    for (let k = 0; k < n; k++) if (this.legCrossesLandExact(lonsA[k], latsA[k], lonsB[k], latsB[k])) out[k] = 1;
    return out;
  }
}
