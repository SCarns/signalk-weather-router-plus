/**
 * Explicit full garbage collection after the resident forecast is
 * replaced.
 *
 * The global forecast is ~0.6–1.1 GB of SharedArrayBuffer memory held by
 * three isolates (main thread, data worker, route worker). A shared
 * backing store is released only when every isolate that referenced it
 * has collected its wrapper, and an idle isolate (the main thread
 * between requests, the route worker between jobs) can go hours without
 * a major GC, so the previous cycle's store would otherwise stay
 * resident next to the new one. Each thread calls releaseMemory() right
 * after dropping its reference; the last one frees the old store.
 *
 * `gc` is obtained without a command-line flag: --expose_gc set at run
 * time installs `gc` in contexts created afterwards, so a fresh vm
 * context hands it back. If that is unavailable nothing happens (the old
 * store is then freed whenever V8 next collects on its own).
 */

import * as v8 from 'node:v8';
import * as vm from 'node:vm';

let gcFn: (() => void) | null | undefined;

function getGc(): (() => void) | null {
  if (gcFn !== undefined) return gcFn;
  try {
    const g = (globalThis as { gc?: () => void }).gc;
    if (typeof g === 'function') {
      gcFn = g;
    } else {
      v8.setFlagsFromString('--expose_gc');
      const f = vm.runInNewContext('gc') as unknown;
      gcFn = typeof f === 'function' ? (f as () => void) : null;
    }
  } catch {
    gcFn = null;
  }
  return gcFn;
}

/** Run a full GC now; returns the time taken in ms, or null when GC is not available. */
export function releaseMemory(): number | null {
  const gc = getGc();
  if (!gc) return null;
  const t = Date.now();
  gc();
  return Date.now() - t;
}
