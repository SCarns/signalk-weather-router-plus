/**
 * Connectivity checks on a built water grid (flood fill on the coarse
 * graph between point pairs, within a tight box around each pair so the
 * test is about the passage itself, not a way round: Bonifacio must not
 * count as open by going round Corsica, Corinth must not count as open by
 * going round the Peloponnese):
 *
 *   npx tsx tools/check_water_grid.ts [grid file]
 *
 * Expected-open straits must connect; isthmuses and canals must not
 * (with canals blocked). Endpoints on a land cell are nudged to the
 * nearest water cell. Also lists the chokepoints near named straits.
 */

import * as path from 'node:path';
import { WaterGrid, WG_FILE_NAME } from '../src/geo/watergrid';
import { NAMED_STRAITS, straitName } from '../src/geo/straits';
import { haversineDistanceM } from '../src/geo/geodesy';

const file = process.argv[2] ?? path.join(__dirname, '..', 'data', WG_FILE_NAME);
const t0 = Date.now();
const grid = WaterGrid.load(file);
console.log(`loaded ${file} in ${Date.now() - t0} ms: ${(grid.bytes() / 1e6).toFixed(1)} MB resident, ${grid.chokepoints.length} chokepoints, ${grid.splits.length} split cells, built ${grid.header.builtAt} from ${grid.header.sources.map((s) => s.name).join(', ')}`);

/** name, lat1, lon1, lat2, lon2, optional box [south, west, north, east] (default: pair box + 0.3°). */
type Pair = [string, number, number, number, number, [number, number, number, number]?];
export const OPEN: Pair[] = [
  ['Gibraltar', 36.0, -6.5, 36.1, -4.5], ['Messina', 38.35, 15.5, 38.05, 15.62], ['Bonifacio', 41.45, 8.95, 41.25, 9.45],
  ['Dover', 51.2, 1.8, 50.8, 1.2], ['Dardanelles', 39.9, 25.9, 40.7, 27.8], ['Bosphorus', 40.9, 28.9, 41.35, 29.2],
  ['Oresund', 56.1, 12.6, 55.5, 12.8], ['Bab-el-Mandeb', 12.9, 43.1, 12.4, 43.6], ['Hormuz', 26.2, 56.8, 26.6, 55.9],
  ['Singapore', 1.25, 103.6, 1.2, 104.2], ['Magellan', -53.4, -70.9, -52.5, -69.0], ['Kerch', 45.5, 36.4, 45.2, 36.6],
];
export const CLOSED: Pair[] = [
  ['Corinth', 38.05, 22.85, 37.85, 23.1, [37.75, 22.7, 38.15, 23.2]],
  ['Cape Cod', 41.68, -70.72, 41.8, -70.45, [41.5, -70.8, 41.95, -70.3]],
  ['Panama', 8.85, -79.5, 9.4, -79.9, [8.7, -80.1, 9.5, -79.3]],
  ['Suez', 29.9, 32.55, 31.3, 32.3, [29.7, 32.0, 31.5, 32.8]],
  ['Kra', 10.3, 98.5, 10.4, 99.3, [9.8, 98.2, 10.9, 99.6]],
  ['Kiel', 54.4, 10.2, 53.9, 9.2, [53.7, 8.9, 54.6, 10.4]],
  ['C&D', 39.55, -75.55, 39.5, -75.95, [39.3, -76.1, 39.8, -75.4]],
  ['Perekop', 46.0, 33.5, 46.0, 34.6, [45.8, 33.2, 46.3, 34.75]],
];

function nudge(lat: number, lon: number): [number, number, number] {
  const [r0, c0] = grid.cellOf(lon, lat);
  if (grid.isWater(r0, c0)) return [r0, c0, 0];
  for (let rad = 1; rad <= 50; rad++) {
    for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
      if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
      if (grid.isWater(r0 + dr, c0 + dc)) return [r0 + dr, grid.wrapCol(c0 + dc), rad];
    }
  }
  throw new Error(`no water near ${lat},${lon}`);
}

export function connected(a: [number, number], b: [number, number], box?: [number, number, number, number]): { ok: boolean; nudged: number[] } {
  const [r1, c1, n1] = nudge(a[0], a[1]);
  const [r2, c2, n2] = nudge(b[0], b[1]);
  const [bs, bw, bn, be] = box ?? [Math.min(a[0], b[0]) - 0.3, Math.min(a[1], b[1]) - 0.3, Math.max(a[0], b[0]) + 0.3, Math.max(a[1], b[1]) + 0.3];
  const rLo = Math.floor((bs + 90) / grid.res), rHi = Math.floor((bn + 90) / grid.res);
  let dc = c2 - c1; if (dc > grid.nx / 2) dc -= grid.nx; if (dc < -grid.nx / 2) dc += grid.nx;
  let cLo = Math.floor((bw + 180) / grid.res) - c1, cHi = Math.floor((be + 180) / grid.res) - c1; // relative to c1
  if (cLo > 0) { cLo -= grid.nx; cHi -= grid.nx; }
  const W = cHi - cLo + 1;
  const seen = new Set<number>();
  const key = (r: number, cRel: number, comp: number): number => ((r - rLo) * W + (cRel - cLo)) * 16 + comp;
  const st: [number, number, number][] = [];
  for (const comp of grid.nodeComponents(r1, c1)) { st.push([r1, 0, comp]); seen.add(key(r1, 0, comp)); }
  while (st.length) {
    const [r, cr, comp] = st.pop()!;
    if (r === r2 && cr === dc) return { ok: true, nudged: [n1, n2] };
    grid.neighbours(r, c1 + cr, comp, (dr, dcc, comp2) => {
      const rr = r + dr, cc = cr + dcc;
      if (rr < rLo || rr > rHi || cc < cLo || cc > cHi) return;
      const k = key(rr, cc, comp2); if (seen.has(k)) return; seen.add(k); st.push([rr, cc, comp2]);
    });
  }
  return { ok: false, nudged: [n1, n2] };
}

let failures = 0;
for (const allow of [false, true]) {
  grid.setCanalsAllowed(allow);
  console.log(`\ncanals ${allow ? 'ALLOWED' : 'blocked'}:`);
  for (const [name, a, b, c, d, box] of OPEN) {
    const r = connected([a, b], [c, d], box);
    if (!r.ok) failures++;
    console.log(`  ${r.ok ? 'open  ' : 'CLOSED'} ${name}${r.nudged.some((x) => x) ? ` (endpoints nudged ${r.nudged.join('/')} cells)` : ''}  [expect open]`);
  }
  for (const [name, a, b, c, d, box] of CLOSED) {
    const r = connected([a, b], [c, d], box);
    if (r.ok && !allow) failures++;
    console.log(`  ${r.ok ? 'open  ' : 'closed'} ${name}${r.nudged.some((x) => x) ? ` (endpoints nudged ${r.nudged.join('/')} cells)` : ''}  [expect ${allow ? 'open if canal is open in the data' : 'closed'}]`);
  }
}
console.log(`\ncanal edges: ${grid.header.canals.map((c) => `${c.name} ${c.edges.length}`).join(', ')}`);
console.log('\nchokepoints near named straits (nearest within the strait radius):');
for (const s of NAMED_STRAITS) {
  const idx = grid.chokepoints.near(s.lon, s.lat, s.radiusKm / 100 + 0.1)
    .filter((i) => haversineDistanceM(s.lon, s.lat, grid.chokepoints.lon[i], grid.chokepoints.lat[i]) <= s.radiusKm * 1000)
    .filter((i) => straitName(grid.chokepoints.lat[i], grid.chokepoints.lon[i]) === s.name)
    .sort((x, y) => grid.chokepoints.widthM[x] - grid.chokepoints.widthM[y]);
  const fmt = (i: number): string => `${grid.chokepoints.lat[i].toFixed(3)},${grid.chokepoints.lon[i].toFixed(3)} w=${(grid.chokepoints.widthM[i] / 1000).toFixed(1)}km axis=${grid.chokepoints.axisDeg[i]}`;
  console.log(`  ${s.name}: ${idx.length ? idx.slice(0, 3).map(fmt).join(' | ') + (idx.length > 3 ? ` (+${idx.length - 3})` : '') : '-'}`);
}
console.log(`\n${failures} failure(s)`);
process.exitCode = failures ? 1 : 0;
