/**
 * Build the global water grid (data/water-grid-0.02.bin.gz) from coastline
 * shapefiles:
 *
 *   npm run build:water-grid -- --land /path/GSHHS_f_L1.shp [--out data/water-grid-0.02.bin.gz]
 *                               [--region west,south,east,north]
 *
 * --region builds only the tiles intersecting the box (the rest stays
 * land); for testing only, never ship a partial grid.
 */

import * as path from 'node:path';
import { buildWaterGrid } from '../src/geo/watergrid_build';
import { WG_FILE_NAME } from '../src/geo/watergrid';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const land = arg('land');
if (!land) {
  console.error('usage: build_water_grid --land <shapefile>[,<shapefile>...] [--out file] [--region w,s,e,n]');
  process.exit(2);
}
const out = arg('out') ?? path.join(__dirname, '..', 'data', WG_FILE_NAME);
const regionArg = arg('region');
const region = regionArg ? (() => {
  const [west, south, east, north] = regionArg.split(',').map(Number);
  return { west, south, east, north };
})() : undefined;
const t0 = Date.now();
let lastLog = 0;
const grid = buildWaterGrid(land.split(','), {
  region,
  onProgress: (done, total, msg) => {
    if (Date.now() - lastLog > 5000 || done === total) {
      lastLog = Date.now();
      console.log(`  ${done}/${total} ${msg} (${((Date.now() - t0) / 1000).toFixed(0)} s, rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB)`);
    }
  },
});
const buildS = (Date.now() - t0) / 1000;
const size = grid.save(out);
const ru = process.resourceUsage();
console.log(`built in ${buildS.toFixed(1)} s; wrote ${out}: ${(size / 1e6).toFixed(2)} MB`);
console.log(`peak RSS ${(ru.maxRSS / 1024).toFixed(0)} MB; grid resident ${(grid.bytes() / 1e6).toFixed(1)} MB`);
console.log(`stats ${JSON.stringify(grid.header.stats)}`);
for (const c of grid.header.canals) console.log(`canal ${c.name}: ${c.edges.length} open edge(s) crossed`);
