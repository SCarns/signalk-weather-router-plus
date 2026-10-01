import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WaterGrid } from './watergrid';
import { shippedWaterGridPath } from './watergrid_store';
import { LandMask } from './landmask';
import { OnDemandLand } from './landcache';

const stJoe = [-86.55, 42.1] as const;
const holland = [-86.3, 42.8] as const;
const chicago = [-87.55, 41.95] as const;
const huron = [-82.5, 43.8] as const;

function connected(grid: WaterGrid, a: readonly number[], b: readonly number[]): boolean {
  const [ar, ac] = grid.cellOf(a[0], a[1]),
    [br, bc] = grid.cellOf(b[0], b[1]);
  assert.equal(grid.isWater(ar, ac), true, 'start must be water without nudging');
  assert.equal(grid.isWater(br, bc), true, 'end must be water without nudging');
  const stack: number[][] = grid.nodeComponents(ar, ac).map(comp => [ar, ac, comp]);
  const seen = new Set<string>();
  while (stack.length) {
    const [r, c, comp] = stack.pop()!;
    const key = `${r},${c},${comp}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r === br && c === bc) return true;
    grid.neighbours(r, c, comp, (dr, dc, next) => {
      const rr = r + dr,
        cc = c + dc;
      const [lon, lat] = grid.cellCentre(rr, cc);
      // Excludes the real connection around northern Michigan.
      if (lon >= -88 && lon <= -82 && lat >= 41.7 && lat <= 44.2) stack.push([rr, cc, next]);
    });
  }
  return false;
}

test('bundled global grid opens Lake Michigan and keeps Michigan landmass blocked', () => {
  const grid = WaterGrid.load(shippedWaterGridPath());
  assert.equal(grid.header.stats?.partial, undefined);
  assert.equal(grid.header.sources.length, 4);
  assert.equal(grid.isWater(...grid.cellOf(-85.6, 43.2)), false);
  assert.equal(connected(grid, stJoe, chicago), true);
  assert.equal(connected(grid, holland, chicago), true);
  assert.equal(connected(grid, holland, huron), false);
});

const source = process.env.WRP_GSHHG_L1;
test('actual GSHHG geometry: Lake Michigan bulk, refined and exact checks agree', { skip: !source }, () => {
  const mask = LandMask.fromShapefiles([source!], { west: -88, south: 41.7, east: -82, north: 44.2 }, { resolutionDeg: 0.005 });
  const overlay = new OnDemandLand([source!]);
  for (const point of [stJoe, holland, chicago, huron]) {
    assert.equal(mask.isLandExact(point[0], point[1]), false);
    assert.equal(overlay.isLandAt(point[0], point[1]), false);
  }
  assert.equal(mask.isLandExact(-85.6, 43.2), true);
  for (const start of [stJoe, holland]) {
    assert.equal(mask.legCrossesRaster(start[0], start[1], chicago[0], chicago[1]), false);
    assert.equal(mask.legCrossesLandExact(start[0], start[1], chicago[0], chicago[1]), false);
  }
  assert.equal(mask.legCrossesRaster(...holland, ...huron), true);
  assert.equal(mask.legCrossesLandExact(...holland, ...huron), true);
  mask.refine({ west: -86.6, south: 42, east: -86.2, north: 43 }, 0.001);
  assert.equal(mask.isLandExact(...holland), false);
});
