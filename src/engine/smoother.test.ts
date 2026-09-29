import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LandMask } from '../geo/landmask';
import type { ShapePolygon } from '../geo/shapefile';
import { haversineDistanceM } from '../geo/geodesy';
import { NoCurrent, NoWind } from './environment';
import { rdpSimplify, shortcutSmoother } from './smoother';
import type { Route, Waypoint } from './route';
import { makeVessel } from '../vessel/vessel';

function rect(recordNumber: number, lon0: number, lat0: number, lon1: number, lat1: number): ShapePolygon {
  const c = [lon0, lat0, lon1, lat0, lon1, lat1, lon0, lat1, lon0, lat0];
  return {
    recordNumber, minLon: lon0, minLat: lat0, maxLon: lon1, maxLat: lat1,
    rings: [{ coords: Float64Array.from(c), minLon: lon0, minLat: lat0, maxLon: lon1, maxLat: lat1 }],
  };
}

const BBOX = { west: -1, south: -1, east: 2, north: 2 };
const OPEN = LandMask.fromPolygons([], BBOX, 0.01);
// Island between (0.4, -0.05) and (0.6, 0.05): blocks the straight line along lat 0.
const ISLAND = LandMask.fromPolygons([rect(1, 0.4, -0.05, 0.6, 0.05)], BBOX, 0.01);
const VESSEL = makeVessel({ motorSpeedMs: 3 });
const T0 = new Date('2026-01-01T00:00:00Z').getTime();

/** Motoring route through the points at 3 m/s, times consistent with distance. */
function route(pts: [number, number][], vias: number[] = []): Route {
  let t = T0;
  const wps: Waypoint[] = pts.map(([lon, lat], i) => {
    if (i > 0) t += (haversineDistanceM(pts[i - 1][0], pts[i - 1][1], lon, lat) / 3) * 1000;
    return { lon, lat, time: new Date(t), sogMs: 3, cogDeg: 90, mode: 'motoring', role: vias.includes(i) ? 'via' : undefined };
  });
  return { waypoints: wps, totalTimeS: (t - T0) / 1000, totalDistanceM: 0, motoringTimeS: (t - T0) / 1000, sailingTimeS: 0, validated: true };
}

const SIM = { modePolicy: 'motor' as const, sailThreshMs: 2.5, simStepM: 200 };
const args = (land: LandMask) => ({ land, vessel: VESSEL, polar: null, wind: new NoWind(), current: new NoCurrent(), sim: SIM, tolerancePct: 5 });

test('RDP drops points on a straight line, keeps endpoints and user waypoints', () => {
  const r = route([[0, 0], [0.1, 0], [0.2, 0.00001], [0.3, 0], [0.4, 0], [0.5, 0]], [3]);
  const n = rdpSimplify(r, OPEN, 10);
  assert.equal(n, 3);
  assert.deepEqual(r.waypoints.map((w) => w.lon), [0, 0.3, 0.5]);
});

test('RDP keeps a detour whose straight replacement crosses land', () => {
  const r = route([[0.3, 0], [0.5, 0.00005], [0.7, 0]]);
  assert.equal(rdpSimplify(r, ISLAND, 100), 0);
  assert.equal(r.waypoints.length, 3);
});

test('smoother collapses a zig-zag in open water and re-times the rest', () => {
  const r = route([[0, 0], [0.1, 0.02], [0.2, 0], [0.3, 0.02], [0.4, 0]]);
  const before = r.waypoints[4].time.getTime();
  const n = shortcutSmoother(r, args(OPEN));
  assert.equal(n, 3);
  assert.equal(r.waypoints.length, 2);
  // Straight 0.4° at 3 m/s is shorter than the zig-zag: arrival moves earlier.
  assert.ok(r.waypoints[1].time.getTime() < before);
  assert.ok(Math.abs(r.totalDistanceM - haversineDistanceM(0, 0, 0.4, 0)) < 1);
  assert.deepEqual(r.waypoints[1].arrivingSplit!.map(Math.round), [0, Math.round(r.totalTimeS)]);
});

test('smoother keeps user waypoints and detours around land', () => {
  const r = route([[0, 0], [0.1, 0.02], [0.2, 0], [0.3, 0.02], [0.4, 0]], [2]);
  shortcutSmoother(r, args(OPEN));
  // Parent rule (smoother.py): a skip over a user waypoint fails and the
  // failed candidate (0.1), not the user waypoint, becomes the next
  // anchor, so 0.1 stays. In the plugin user waypoints are leg ends, so
  // this does not occur inside a leg.
  assert.deepEqual(r.waypoints.map((w) => w.lon), [0, 0.1, 0.2, 0.4]);
  const d = route([[0.3, 0], [0.5, 0.1], [0.7, 0]]);
  assert.equal(shortcutSmoother(d, args(ISLAND)), 0);
});

test('smoother refuses a shortcut that is not faster within the tolerance', () => {
  // Timestamps say the boat was very fast on the original legs: the
  // straight shortcut at 3 m/s is slower than that, beyond 5%.
  const r = route([[0, 0], [0.1, 0.001], [0.2, 0]]);
  r.waypoints[2].time = new Date(T0 + 1000);
  assert.equal(shortcutSmoother(r, args(OPEN)), 0);
});
