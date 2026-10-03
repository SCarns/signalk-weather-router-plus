/**
 * Regional wind from signalk-grib-downloader (data worker): after each
 * forecast check, decode any complete run not yet decoded (10 m wind only,
 * docs/plans/grib-downloader-enhancement.md). Optional: without the
 * downloader nothing happens.
 */

import * as path from 'node:path';
import { scanRegional } from '../../data/regional';
import { decodeRegionalRun } from '../../data/regionaldecode';
import type { WorkerState } from './state';

export async function refreshRegional(st: WorkerState): Promise<void> {
  if (!st.config || !st.cacheRoot) return;
  const scan = scanRegional(st.config.forecast.regionalGribs, st.cacheRoot);
  if (!scan.root) {
    st.regional.clear();
    return;
  }
  for (const src of scan.sources) {
    if (!src.run || src.problem) continue;
    const prev = st.regional.get(src.name);
    try {
      const r = decodeRegionalRun(src, path.join(scan.root, src.name), st.cacheRoot, Math.max(1, st.config.forecast.keepCycles));
      st.regional.set(src.name, {
        source: src.name,
        cycle: r.cycle,
        dir: r.dir,
        steps: r.steps,
        bytes: r.bytes,
        decodeMs: r.decodeMs,
        decodedAt: r.reused ? (prev?.decodedAt ?? null) : new Date().toISOString(),
        error: null,
      });
      if (!r.reused)
        st.log(
          'info',
          `regional wind: decoded ${src.name} run ${r.cycle}: ${r.steps} steps, ${(r.bytes / 1e6).toFixed(0)} MB, ${(r.decodeMs / 1000).toFixed(1)} s`
        );
    } catch (err) {
      const m = (err as Error).message;
      if (prev?.error !== m) st.log('error', `regional wind: ${src.name}: ${m}`);
      st.regional.set(src.name, {
        source: src.name,
        cycle: prev?.cycle ?? null,
        dir: prev?.dir ?? null,
        steps: prev?.steps ?? 0,
        bytes: prev?.bytes ?? 0,
        decodeMs: prev?.decodeMs ?? 0,
        decodedAt: prev?.decodedAt ?? null,
        error: m,
      });
    }
    // Let messages through between sources.
    await new Promise(r => setImmediate(r));
  }
}
