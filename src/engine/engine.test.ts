import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LandMask } from '../geo/landmask';
import type { ShapePolygon } from '../geo/shapefile';
import { buildCoarseGrid } from '../geo/grid';
import { astarRoute, AstarError, distanceTransformCells, maximumFilter } from './astar';
import { ConstantWind, NoCurrent, NoWind } from './environment';
import { simulateLegTime } from './legsim';
import { OceanPropagator, RouteError } from './propagator';
import { PolarDiagram } from '../vessel/polar';
import { makeVessel } from '../vessel/vessel';
import { KTS_TO_MS, haversineDistanceM } from '../geo/geodesy';

function rect(recordNumber: number, lon0: number, lat0: number, lon1: number, lat1: number): ShapePolygon {
  const c = [lon0, lat0, lon1, lat0, lon1, lat1, lon0, lat1, lon0, lat0];
  return {
    recordNumber,
    minLon: lon0,
    minLat: lat0,
    maxLon: lon1,
    maxLat: lat1,
    rings: [{ coords: Float64Array.from(c), minLon: lon0, minLat: lat0, maxLon: lon1, maxLat: lat1 }],
  };
}

const POLAR_CSV = `twa/tws,4,6,8,10,12,14,16,20,25
0,0,0,0,0,0,0,0,0,0
30,1.5,2.5,3.3,4.0,4.3,4.5,4.6,4.7,4.7
45,2.5,3.6,4.5,5.1,5.5,5.7,5.8,5.9,5.9
60,3.0,4.2,5.1,5.7,6.1,6.3,6.4,6.5,6.5
90,3.2,4.5,5.5,6.1,6.5,6.7,6.8,6.9,6.9
120,3.0,4.3,5.3,6.0,6.4,6.7,6.9,7.1,7.2
150,2.4,3.6,4.6,5.4,6.0,6.4,6.7,7.0,7.3
180,2.0,3.0,4.0,4.8,5.5,6.0,6.4,6.8,7.1`;

test('polar interpolation, mirroring, no-go floor and extrapolation', () => {
  const p = PolarDiagram.parse(POLAR_CSV, ',');
  assert.ok(Math.abs(p.boatSpeed(90, 10 * KTS_TO_MS) / KTS_TO_MS - 6.1) < 1e-9);
  assert.ok(Math.abs(p.boatSpeed(270, 10 * KTS_TO_MS) / KTS_TO_MS - 6.1) < 1e-9); // mirrored
  assert.ok(Math.abs(p.boatSpeed(75, 10 * KTS_TO_MS) / KTS_TO_MS - 5.9) < 1e-9); // midway 60..90
  assert.ok(Math.abs(p.boatSpeed(90, 11 * KTS_TO_MS) / KTS_TO_MS - 6.3) < 1e-9); // midway 10..12 kt
  assert.equal(p.boatSpeed(20, 10 * KTS_TO_MS), 0); // in irons below 30°
  assert.equal(p.noGoFloor(10 * KTS_TO_MS), 30);
  // Beyond 25 kt the table extrapolates linearly from the last interval and clamps at 0.
  assert.ok(p.boatSpeed(90, 30 * KTS_TO_MS) >= 0);
  assert.throws(() => PolarDiagram.parse('twa/tws,4\n30,x', ','));
});

test('leg simulation: motor timing and stuck detection', () => {
  const vessel = makeVessel({ motorSpeedMs: 5 });
  const r = simulateLegTime(0, 0, new Date(0), 0.1, 0, vessel, null, new NoWind(), new NoCurrent(), {
    modePolicy: 'motor',
    sailThreshMs: 2.5,
    simStepM: 200,
  });
  const d = haversineDistanceM(0, 0, 0.1, 0);
  assert.ok(Math.abs(r.seconds - d / 5) < 1e-6);
  assert.equal(r.dominantMode, 'motoring');
  // Head current stronger than the boat → stuck.
  const strong = {
    at: () => [-10, 0] as [number, number],
    atMany: (l: Float64Array) => ({ u: new Float64Array(l.length).fill(-10), v: new Float64Array(l.length) }),
  };
  const s = simulateLegTime(0, 0, new Date(0), 0.1, 0, vessel, null, new NoWind(), strong, {
    modePolicy: 'motor',
    sailThreshMs: 2.5,
    simStepM: 200,
  });
  assert.equal(s.seconds, Infinity);
  assert.equal(s.dominantMode, 'stuck');
});

test('leg simulation sails when the polar allows it', () => {
  const p = PolarDiagram.parse(POLAR_CSV, ',');
  const vessel = makeVessel({ motorSpeedMs: 3 });
  // Wind from the north at 12 kt, leg due east → TWA 90°, boat speed 6.5 kt > motor.
  const r = simulateLegTime(0, 0, new Date(0), 0.2, 0, vessel, p, new ConstantWind(12 * KTS_TO_MS, 0), new NoCurrent(), {
    modePolicy: 'sail_max',
    sailThreshMs: 2.5,
    simStepM: 500,
  });
  assert.equal(r.dominantMode, 'sailing');
  assert.ok(Math.abs(r.seconds - haversineDistanceM(0, 0, 0.2, 0) / (6.5 * KTS_TO_MS)) < 1);
});

test('distance transform and maximum filter', () => {
  // 5x5 mask with a single zero in the centre.
  const mask = new Uint8Array(25).fill(1);
  mask[12] = 0;
  const d = distanceTransformCells(mask, 5, 5);
  assert.equal(d[12], 0);
  assert.equal(d[13], 1);
  assert.ok(Math.abs(d[0] - Math.sqrt(8)) < 1e-6);
  const mx = maximumFilter(Float32Array.from(d), 5, 5, 3);
  assert.ok(Math.abs(mx[12] - Math.SQRT2) < 1e-6); // 3x3 window around the centre includes the diagonals
  assert.ok(Math.abs(mx[0] - Math.sqrt(8)) < 1e-6);
  assert.ok(Math.abs(mx[7] - Math.sqrt(5)) < 1e-6); // (1,2): window rows 0..2, cols 1..3 → max at (0,1) = √5
});

test('A* routes around an island and refuses impossible starts', () => {
  const bbox = { west: -1, south: -1, east: 2, north: 2 };
  const island = rect(1, 0.3, -0.5, 0.7, 1.5); // north-south wall between x=0.3 and 0.7
  const lm = LandMask.fromPolygons([island], bbox, 0.01);
  const grid = buildCoarseGrid(lm, bbox, 0.02);
  const r = astarRoute(grid, [0, 0.5], [1, 0.5], 3);
  assert.ok(r.path.length > 3);
  // Path must clear the wall: every point is outside the island's box.
  for (const p of r.path)
    assert.ok(!(p.lon > 0.3 && p.lon < 0.7 && p.lat > -0.5 && p.lat < 1.5), `path enters the wall at ${p.lon},${p.lat}`);
  assert.throws(() => astarRoute(grid, [0.5, 0.5], [1, 0.5], 3), AstarError);
});

test('propagator finds a land-free route around an island under motor', () => {
  const bbox = { west: -1, south: -1, east: 2, north: 2 };
  const island = rect(1, 0.3, -0.3, 0.7, 1.3);
  const lm = LandMask.fromPolygons([island], bbox, 0.005);
  const prop = new OceanPropagator(lm, { stages: 12, subsectors: 20, headings: 30 });
  const vessel = makeVessel({ motorSpeedMs: 3 });
  const route = prop.computeRoute({
    start: [0, 0.5],
    end: [1, 0.5],
    departureTime: new Date('2026-01-01T00:00:00Z'),
    vessel,
    modePolicy: 'motor',
  });
  assert.ok(route.waypoints.length >= 3);
  assert.equal(route.warnings, undefined);
  assert.equal(route.validated, true);
  const straight = haversineDistanceM(0, 0.5, 1, 0.5);
  assert.ok(route.totalDistanceM > straight * 1.05, 'detour must be longer than the straight line');
  // Waypoint times are Dates (integer ms); allow the accumulated rounding.
  assert.ok(Math.abs(route.totalTimeS - route.motoringTimeS) < 0.1, `total ${route.totalTimeS} vs motoring ${route.motoringTimeS}`);
  assert.equal(route.sailingTimeS, 0);
  for (let i = 1; i < route.waypoints.length; i++) {
    const a = route.waypoints[i - 1];
    const b = route.waypoints[i];
    assert.equal(lm.legCrossesLandExact(a.lon, a.lat, b.lon, b.lat, 50), false);
    assert.ok(b.time > a.time);
  }
});

test('propagator honours a via disc and rejects endpoints on land', () => {
  const bbox = { west: -1, south: -1, east: 2, north: 2 };
  const lm = LandMask.fromPolygons([rect(1, 1.5, 1.5, 1.9, 1.9)], bbox, 0.01);
  const prop = new OceanPropagator(lm, { stages: 10, subsectors: 20, headings: 30 });
  const vessel = makeVessel({ motorSpeedMs: 3 });
  const via = { lon: 0.5, lat: 0.9, radiusM: 2000 };
  const route = prop.computeRoute({
    start: [0, 0.5],
    end: [1, 0.5],
    departureTime: new Date('2026-01-01T00:00:00Z'),
    vessel,
    modePolicy: 'motor',
    vias: [via],
  });
  // Some consecutive pair of waypoints must pass within the disc.
  let crossed = false;
  for (let i = 1; i < route.waypoints.length; i++) {
    const a = route.waypoints[i - 1];
    const b = route.waypoints[i];
    if (
      haversineDistanceM(b.lon, b.lat, via.lon, via.lat) <= via.radiusM ||
      haversineDistanceM(a.lon, a.lat, via.lon, via.lat) <= via.radiusM
    )
      crossed = true;
  }
  assert.ok(route.waypoints.some(w => w.role === 'via') || crossed);
  assert.throws(
    () => prop.computeRoute({ start: [1.7, 1.7], end: [1, 0.5], departureTime: new Date(), vessel, modePolicy: 'motor' }),
    RouteError
  );
});
