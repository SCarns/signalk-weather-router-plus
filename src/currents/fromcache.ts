/**
 * Current sources read back from the disk caches the data worker writes, for
 * a process that cannot share the data worker's memory: the chart-mesh leg
 * (plugin/meshlegtask.ts) and the tile builders (plugin/prebuild.ts). Such a
 * process is told where the data is, not sent a copy of it: copies made on
 * Signal K's main thread for two tile builders took 609 MB there, which glibc
 * kept after they were freed (brain, 2026-10-25).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BBox } from '../geo/geodesy';
import { HarmonicCurrentSource } from './harmonic';
import { extentMeets, extentOfField, loadRtofsSteps, RtofsClient, RtofsCurrentSource, rtofsRunFor } from './rtofs';
import type { SmocRun, SmocSettings } from './smoc';
import type { SourceBBox } from './types';

/** The RTOFS products the data worker holds (finest first), as another process reads them from the cache. */
export interface RtofsCacheRef {
  cacheDir: string;
  runs: { product: string; runMs: number; bbox: SourceBBox }[];
  horizonS: number;
  stepS: number;
}

/**
 * The data worker's currents for the tile builders: the SMOC run and the resident area's centre and steps (its
 * chunks are in the cache), the RTOFS products, and the tidal-harmonic folder; each null when not in use.
 */
export interface BuilderCurrentsRef {
  smoc: { run: SmocRun; settings: SmocSettings; centre: { lat: number; lon: number } | null; steps: number[] } | null;
  rtofs: RtofsCacheRef | null;
  harmonicDir: string | null;
  /** The folder as the data worker read it (harmonicSignature): a builder reads it only while it still is. */
  harmonicSig: string | null;
}

/**
 * What the tidal-harmonic folder holds: each `.npz` file's name, size and modification time, so a file added, replaced
 * or removed changes it (the current tiles' generation, tiles.ts). 'none' without a folder.
 */
export function harmonicSignature(dir: string | null): string {
  if (!dir) return 'none';
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter(f => f.toLowerCase().endsWith('.npz'))
      .sort();
  } catch (err) {
    return `unreadable: ${(err as Error).message}`;
  }
  return files
    .map(f => {
      try {
        const st = fs.statSync(path.join(dir, f));
        return `${f}:${st.size}:${Math.floor(st.mtimeMs)}`;
      } catch {
        return `${f}:gone`;
      }
    })
    .join(',');
}

/** Every `.npz` source in the folder, in name order; `file` null: the folder itself could not be read. */
export function harmonicFromDir(dir: string): { file: string | null; source: HarmonicCurrentSource | null; error: string | null }[] {
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter(f => f.toLowerCase().endsWith('.npz'))
      .sort();
  } catch (err) {
    return [{ file: null, source: null, error: (err as Error).message }];
  }
  return files.map(f => {
    try {
      return { file: f, source: new HarmonicCurrentSource(path.join(dir, f)), error: null };
    } catch (err) {
      return { file: f, source: null, error: (err as Error).message };
    }
  });
}

/**
 * Each RTOFS product from the cache, never the network: cropped to `box` (products outside it skipped), or the whole
 * product when `box` is null.
 */
export async function rtofsFromCache(
  ref: RtofsCacheRef,
  box: BBox | null
): Promise<{ product: string; source: RtofsCurrentSource | null; error: string | null }[]> {
  const out: { product: string; source: RtofsCurrentSource | null; error: string | null }[] = [];
  for (const r of ref.runs) {
    // A product the box is outside has nothing for it.
    if (box && !extentMeets(r.bbox, box)) continue;
    try {
      const client = new RtofsClient({ cacheDir: ref.cacheDir, region: r.product, cacheOnly: true });
      const steps = await loadRtofsSteps(client, rtofsRunFor(new Date(r.runMs)), box, ref.horizonS, ref.stepS);
      out.push({
        product: r.product,
        source: steps.length ? new RtofsCurrentSource(r.product, r.runMs, extentOfField(steps[0].u), steps) : null,
        error: null,
      });
    } catch (err) {
      out.push({ product: r.product, source: null, error: (err as Error).message });
    }
  }
  return out;
}
