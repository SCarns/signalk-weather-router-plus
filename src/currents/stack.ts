/**
 * Layered current sources: highest priority wins where it has coverage
 * and returns a non-zero value; exact (0, 0) from a source means "no
 * data" and the next source is consulted. Port of the reference
 * `CurrentStack`.
 */

import type { CurrentSource } from '../engine/environment';
import type { CurrentSourceLike } from './types';

export class CurrentStack implements CurrentSource {
  readonly sources: CurrentSourceLike[];

  constructor(sources: CurrentSourceLike[]) {
    this.sources = [...sources].sort((a, b) => b.priority - a.priority);
  }

  get isEmpty(): boolean {
    return this.sources.length === 0;
  }

  at(lon: number, lat: number, time: Date): [number, number] {
    for (const s of this.sources) {
      if (!s.contains(lon, lat)) continue;
      const [u, v] = s.at(lon, lat, time);
      if (!(u === 0 && v === 0)) return [u, v];
    }
    return [0, 0];
  }

  atMany(lons: Float64Array, lats: Float64Array, time: Date): { u: Float64Array; v: Float64Array } {
    const n = lons.length;
    const u = new Float64Array(n);
    const v = new Float64Array(n);
    if (n === 0) return { u, v };
    const unfilled = new Uint8Array(n).fill(1);
    let remaining = n;
    for (const s of this.sources) {
      if (remaining === 0) break;
      const idx: number[] = [];
      for (let k = 0; k < n; k++) if (unfilled[k] && s.contains(lons[k], lats[k])) idx.push(k);
      if (idx.length === 0) continue;
      const subLon = new Float64Array(idx.map((k) => lons[k]));
      const subLat = new Float64Array(idx.map((k) => lats[k]));
      const r = s.atMany(subLon, subLat, time);
      for (let q = 0; q < idx.length; q++) {
        if (r.u[q] !== 0 || r.v[q] !== 0) {
          const k = idx[q];
          u[k] = r.u[q];
          v[k] = r.v[q];
          unfilled[k] = 0;
          remaining--;
        }
      }
    }
    return { u, v };
  }

  /** Which source answers at a point (diagnostics), or null. */
  sourceAt(lon: number, lat: number, time: Date): string | null {
    for (const s of this.sources) {
      if (!s.contains(lon, lat)) continue;
      const [u, v] = s.at(lon, lat, time);
      if (!(u === 0 && v === 0)) return s.name;
    }
    return null;
  }
}
