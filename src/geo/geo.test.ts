import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bboxFromLonLat, bboxContains, haversineBearing, haversineDistanceM, perpendicularOffsetM,
  projectAlongBearing, segmentWithinDisc, slerpSamples, wrapLon,
} from './geodesy';
import { LandMask } from './landmask';
import type { ShapePolygon } from './shapefile';
import { pointInShape } from './shapefile';
import { buildCoarseGrid } from './grid';

function square(recordNumber: number, lon0: number, lat0: number, lon1: number, lat1: number, holes: number[][] = []): ShapePolygon {
  const ring = (c: number[]): { coords: Float64Array; minLon: number; minLat: number; maxLon: number; maxLat: number } => {
    const xs = c.filter((_, i) => i % 2 === 0);
    const ys = c.filter((_, i) => i % 2 === 1);
    return { coords: Float64Array.from(c), minLon: Math.min(...xs), minLat: Math.min(...ys), maxLon: Math.max(...xs), maxLat: Math.max(...ys) };
  };
  const outer = [lon0, lat0, lon1, lat0, lon1, lat1, lon0, lat1, lon0, lat0];
  return { recordNumber, minLon: lon0, minLat: lat0, maxLon: lon1, maxLat: lat1, rings: [ring(outer), ...holes.map(ring)] };
}

test('haversine distance and bearing', () => {
  // Newport RI to Bermuda, roughly 1170 km at ~150°.
  const d = haversineDistanceM(-71.31, 41.49, -64.78, 32.30);
  assert.ok(d > 1_150_000 && d < 1_190_000, `distance ${d}`);
  const b = haversineBearing(-71.31, 41.49, -64.78, 32.30);
  assert.ok(b > 145 && b < 155, `bearing ${b}`);
  assert.equal(haversineBearing(0, 0, 0, 1), 0);
  assert.equal(haversineBearing(0, 0, 1, 0), 90);
});

test('projectAlongBearing inverts distance/bearing and wraps the antimeridian', () => {
  const [lon, lat] = projectAlongBearing(-71.31, 41.49, 150, 100_000);
  assert.ok(Math.abs(haversineDistanceM(-71.31, 41.49, lon, lat) - 100_000) < 1);
  assert.ok(Math.abs(haversineBearing(-71.31, 41.49, lon, lat) - 150) < 0.01);
  const [lon2] = projectAlongBearing(179.9, 0, 90, 50_000);
  assert.ok(lon2 < -179 && lon2 > -180, `wrapped lon ${lon2}`);
  assert.equal(wrapLon(190), -170);
  assert.equal(wrapLon(-190), 170);
});

test('perpendicular offset sign and magnitude', () => {
  // Reference track due east along the equator; a point 1° north is
  // ~111 km off track. The reference formula (asin(sin d13 · sin(θ13 − θ12)))
  // returns NEGATIVE for points left of the track; the sign only has to
  // be consistent, since it is used for binning.
  const off = perpendicularOffsetM(0, 0, 10, 0, 5, 1);
  assert.ok(Math.abs(off) > 110_000 && Math.abs(off) < 112_000, `offset ${off}`);
  assert.ok(off < 0);
  assert.ok(perpendicularOffsetM(0, 0, 10, 0, 5, -1) > 0);
});

test('segmentWithinDisc is a segment test, not an endpoint test', () => {
  // Segment 0..10° along the equator; via at (5°, 0.001°) with 500 m radius: crossed although both endpoints are far away.
  assert.equal(segmentWithinDisc(0, 0, 10, 0, 5, 0.001, 500), true);
  // Via 5 km north of the track: not crossed with a 500 m disc.
  assert.equal(segmentWithinDisc(0, 0, 10, 0, 5, 0.045, 500), false);
  // Via beyond the end of the segment.
  assert.equal(segmentWithinDisc(0, 0, 10, 0, 10.5, 0, 500), false);
});

test('slerpSamples starts and ends on the endpoints', () => {
  const lon = new Float64Array(5);
  const lat = new Float64Array(5);
  slerpSamples(-71, 41, -64, 32, 5, lon, lat, 0);
  assert.ok(Math.abs(lon[0] + 71) < 1e-9 && Math.abs(lat[0] - 41) < 1e-9);
  assert.ok(Math.abs(lon[4] + 64) < 1e-9 && Math.abs(lat[4] - 32) < 1e-9);
});

test('bboxFromLonLat takes the short way round the antimeridian', () => {
  const b = bboxFromLonLat([175, -175], [-10, 10], 1);
  assert.equal(b.west, 174);
  assert.equal(b.east, -174);
  assert.ok(bboxContains(b, 179, 0));
  assert.ok(bboxContains(b, -179, 0));
  assert.ok(!bboxContains(b, 0, 0));
});

test('point-in-shape honours holes (even-odd)', () => {
  const shape = square(1, 0, 0, 10, 10, [[3, 3, 7, 3, 7, 7, 3, 7, 3, 3]]);
  assert.equal(pointInShape(shape, 1, 1), true);
  assert.equal(pointInShape(shape, 5, 5), false); // inside the hole (a lake)
  assert.equal(pointInShape(shape, 11, 5), false);
});

test('land mask rasterises polygons with holes and tests legs', () => {
  const island = square(1, 0, 0, 1, 1, [[0.4, 0.4, 0.6, 0.4, 0.6, 0.6, 0.4, 0.6, 0.4, 0.4]]);
  const bbox = { west: -1, south: -1, east: 2, north: 2 };
  const lm = LandMask.fromPolygons([island], bbox, 0.01);
  assert.equal(lm.isLand(0.2, 0.2), true);
  assert.equal(lm.isLand(0.5, 0.5), false); // lake
  assert.equal(lm.isLand(1.5, 1.5), false);
  assert.equal(lm.isLandExact(0.2, 0.2), true);
  assert.equal(lm.isLandExact(0.5, 0.5), false);
  // Leg passing over the island is blocked; a leg passing south of it is clear.
  const cross = lm.legsCrossLandBulk(Float64Array.of(-0.5, -0.5), Float64Array.of(0.5, -0.5), Float64Array.of(1.5, 1.5), Float64Array.of(0.5, -0.5), 500);
  assert.equal(cross[0], 1);
  assert.equal(cross[1], 0);
  // Land fraction ≈ (1 - 0.04) / 9 with conservative boundary cells.
  const frac = lm.landFraction();
  assert.ok(frac > 0.1 && frac < 0.13, `land fraction ${frac}`);
});

test('land mask works across the antimeridian', () => {
  const island = square(1, 179.5, 0, 180, 1); // touches the dateline from the west
  const island2 = square(2, -180, 0, -179.5, 1); // continues east of it
  const bbox = { west: 178, south: -1, east: -178, north: 2 };
  const lm = LandMask.fromPolygons([island, island2], bbox, 0.01);
  assert.equal(lm.isLand(179.8, 0.5), true);
  assert.equal(lm.isLand(-179.8, 0.5), true);
  assert.equal(lm.isLand(178.5, 0.5), false);
  assert.equal(lm.isLand(-178.5, 0.5), false);
  const grid = buildCoarseGrid(lm, bbox, 0.05);
  const [i, j] = grid.spec.lonlatToIJ(-179.8, 0.5);
  assert.equal(grid.isPassable(i, j), false);
});

test('chooseResolution respects the cell budget', () => {
  const r = LandMask.chooseResolution({ west: -75, south: 30, east: -65, north: 45 }, 25_000_000);
  assert.equal(r, 0.005); // 10.2° × 15.2° at 0.002° would be 38.8M cells
  const r2 = LandMask.chooseResolution({ west: -72, south: 41, east: -70, north: 42 }, 25_000_000);
  assert.equal(r2, 0.0005);
});
