/**
 * Worker thread that rebuilds the global water grid from the configured
 * coastline shapefiles and writes it (atomically) to the given file.
 * Spawned by the route worker when no grid matching the configured
 * coastline exists; about a minute on a desktop, several on a Raspberry
 * Pi, a few hundred MB of memory while it runs.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { buildWaterGrid } from '../geo/watergrid_build';

export interface GridBuilderData {
  shapefiles: string[];
  outFile: string;
}

export type GridBuilderMessage =
  | { type: 'progress'; done: number; total: number; message: string }
  | { type: 'done'; file: string; bytes: number; seconds: number; peakRssBytes: number }
  | { type: 'error'; message: string };

if (!parentPort) throw new Error('gridbuilder.ts must run as a worker thread');
const port = parentPort;
const data = workerData as GridBuilderData;
try {
  const t0 = Date.now();
  let last = 0;
  const grid = buildWaterGrid(data.shapefiles, {
    onProgress: (done, total, message) => {
      if (Date.now() - last > 10_000 || done === total) {
        last = Date.now();
        port.postMessage({ type: 'progress', done, total, message } satisfies GridBuilderMessage);
      }
    },
  });
  const bytes = grid.save(data.outFile);
  port.postMessage({
    type: 'done',
    file: data.outFile,
    bytes,
    seconds: (Date.now() - t0) / 1000,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  } satisfies GridBuilderMessage);
} catch (err) {
  port.postMessage({ type: 'error', message: (err as Error).message } satisfies GridBuilderMessage);
}
