/**
 * Decode a regional run of signalk-grib-downloader into our own decoded
 * format (docs/plans/grib-downloader-enhancement.md, phase 3, wind only).
 *
 * Each complete run of a source is decoded once: its 10 m wind (u, v) for
 * every forecast hour, as whole regional fields, written with the same
 * DecodedRunWriter (and so the same atomic layout and readers) as the
 * ECMWF runs, under `<dataDir>/regional/<source>/<yyyymmddHH>/`. The
 * downloader's files are only read.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { iterateGrib2 } from '../grib/grib2';
import { globalField, type FieldGrid } from './forecast';
import { DecodedRunWriter, INDEX_FILE, cycleName, openDecodedRun } from './decoded';
import type { RegionalSource } from './regional';

/** Directory of the decoded regional runs below the plugin data directory. */
export const REGIONAL_DIR = 'regional';
/** The parameters decoded: 10 m wind, as in the ECMWF runs. */
export const REGIONAL_PARAMS = ['10u', '10v'] as const;

/** 10 m u (2.2) or v (2.3) wind, meteorology discipline, height above ground 10 m; else null. */
function windParam(p: {
  discipline: number;
  parameterCategory: number;
  parameterNumber: number;
  typeOfFirstFixedSurface: number;
  firstFixedSurfaceValue: number;
}): '10u' | '10v' | null {
  if (p.discipline !== 0 || p.parameterCategory !== 2 || p.typeOfFirstFixedSurface !== 103 || p.firstFixedSurfaceValue !== 10) return null;
  return p.parameterNumber === 2 ? '10u' : p.parameterNumber === 3 ? '10v' : null;
}

export interface RegionalDecodeResult {
  source: string;
  cycle: string;
  dir: string;
  steps: number;
  bytes: number;
  decodeMs: number;
  /** True when the run was already decoded (nothing done). */
  reused: boolean;
}

/** The decoded directory of a source's run, if a complete one exists. */
export function decodedRegionalDir(dataDir: string, source: string, cycle: string): string | null {
  const dir = path.join(dataDir, REGIONAL_DIR, source, cycle);
  if (!fs.existsSync(path.join(dir, INDEX_FILE))) return null;
  return openDecodedRun(dir).run ? dir : null;
}

/**
 * Decode the newest complete run of `src` (found by scanSource in
 * `srcDir`) unless already decoded. Steps are written as soon as both
 * wind components of an hour are read; a file holds one or several hours
 * (GFS and ICON-EU one, AROME and ARPEGE a group).
 */
export function decodeRegionalRun(src: RegionalSource, srcDir: string, dataDir: string, keepRuns = 2): RegionalDecodeResult {
  if (!src.run || src.problem) throw new Error(`${src.name}: ${src.problem ?? 'no complete run'}`);
  const runMs = Date.parse(src.run);
  const cycle = cycleName(new Date(runMs));
  const root = path.join(dataDir, REGIONAL_DIR, src.name);
  const done = decodedRegionalDir(dataDir, src.name, cycle);
  if (done) {
    const idx = openDecodedRun(done).run!.index;
    return { source: src.name, cycle, dir: done, steps: idx.steps.length, bytes: idx.bytes, decodeMs: idx.decodeMs, reused: true };
  }
  const t0 = Date.now();
  const writer = new DecodedRunWriter(root, cycle);
  const pending = new Map<number, Map<string, FieldGrid>>();
  const written = new Set<number>();
  try {
    for (const file of src.files) {
      const buf = new Uint8Array(fs.readFileSync(path.join(srcDir, file)));
      for (const m of iterateGrib2(buf)) {
        const param = windParam(m.product);
        if (!param) continue;
        const h = m.product.forecastHours;
        if (written.has(h)) continue;
        let fields = pending.get(h);
        if (!fields) pending.set(h, (fields = new Map()));
        fields.set(param, globalField(m.grid, m.decode()));
        if (fields.size === REGIONAL_PARAMS.length) {
          writer.writeStep({ validMs: runMs + h * 3600_000, stepHours: h, fields });
          pending.delete(h);
          written.add(h);
        }
      }
    }
    if (written.size === 0) throw new Error(`${src.name}: no 10 m wind in run ${cycle}`);
    const stepHours = [...written].sort((a, b) => a - b);
    const index = writer.finish({
      cycleTimeMs: runMs,
      request: { horizonHours: stepHours[stepHours.length - 1], params: [...REGIONAL_PARAMS] },
      stepHours,
      decodeMs: Date.now() - t0,
    });
    pruneRegional(root, keepRuns);
    return {
      source: src.name,
      cycle,
      dir: writer.finalDir,
      steps: index.steps.length,
      bytes: index.bytes,
      decodeMs: index.decodeMs,
      reused: false,
    };
  } catch (err) {
    writer.abort();
    throw err;
  }
}

/** Keep the newest `keep` decoded runs of a source; remove older ones and leftover temporary directories. */
export function pruneRegional(root: string, keep: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  const runs = names.filter(n => /^\d{10}$/.test(n)).sort();
  for (const n of runs.slice(0, Math.max(0, runs.length - keep))) fs.rmSync(path.join(root, n), { recursive: true, force: true });
  for (const n of names.filter(x => x.startsWith('.tmp-') || x.startsWith('.old-'))) {
    // Another decode in progress writes its own .tmp-<cycle>-<pid>-…; only stale ones (an hour old) are removed.
    try {
      if (Date.now() - fs.statSync(path.join(root, n)).mtimeMs > 3600_000) fs.rmSync(path.join(root, n), { recursive: true, force: true });
    } catch {
      /* gone */
    }
  }
}
