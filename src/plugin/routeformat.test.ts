import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Route, Waypoint } from '../engine/route';
import { routeToGeoJSON, routeToSignalKRoute } from './routeformat';

function wp(lon: number, lat: number, h: number, role?: 'via'): Waypoint {
  const w: Waypoint = { lon, lat, time: new Date(Date.UTC(2026, 9, 1, h)), sogMs: 3, cogDeg: 90, mode: 'sailing' };
  if (role) w.role = role;
  return w;
}

test('snapped stops are reported on the route, on the matching points and as the start/end fields the web app draws', () => {
  // Stops: start, waypoint 1, waypoint 2, destination; waypoint 2 and the
  // destination were on land and moved.
  const route: Route = {
    waypoints: [wp(0, 0, 0), wp(0.1, 0, 1), wp(0.2, 0, 2, 'via'), wp(0.3, 0, 3), wp(0.4, 0, 4, 'via'), wp(0.5, 0, 5), wp(0.6, 0, 6)],
    totalTimeS: 6 * 3600,
    totalDistanceM: 66_000,
    motoringTimeS: 0,
    sailingTimeS: 6 * 3600,
    validated: true,
    snaps: [
      { index: 2, original: [0.4005, 0.0004], anchor: [0.4, 0], distanceM: 70 },
      { index: 3, original: [0.601, 0.001], anchor: [0.6, 0], distanceM: 150 },
    ],
  };
  const g = routeToGeoJSON(route) as { features: { geometry: { type: string }; properties: Record<string, unknown> }[] };
  const line = g.features.find(f => f.geometry.type === 'LineString')!.properties;
  assert.equal(line.stop_count, 4);
  assert.deepEqual(line.snaps, [
    { index: 2, original: [0.4005, 0.0004], anchor: [0.4, 0], distance_m: 70 },
    { index: 3, original: [0.601, 0.001], anchor: [0.6, 0], distance_m: 150 },
  ]);
  assert.deepEqual(line.end_original, [0.601, 0.001]);
  assert.deepEqual(line.end_anchor, [0.6, 0]);
  assert.equal(line.end_snap_distance_m, 150);
  assert.equal(line.start_original, undefined);
  const pts = g.features.filter(f => f.geometry.type === 'Point').map(f => f.properties);
  assert.equal(pts[4].snap_distance_m, 70, 'the second via carries its snap');
  assert.deepEqual(pts[4].original, [0.4005, 0.0004]);
  assert.equal(pts[6].snap_distance_m, 150, 'the destination carries its snap');
  assert.equal(pts[2].snap_distance_m, undefined, 'the first via was not moved');
  assert.equal(pts[0].snap_distance_m, undefined);
  const sk = routeToSignalKRoute(route, 'r') as { feature: { properties: { coordinatesMeta: Record<string, unknown>[] } } };
  assert.equal(sk.feature.properties.coordinatesMeta[4].snap_distance_m, 70);
  assert.equal(sk.feature.properties.coordinatesMeta[6].snap_distance_m, 150);
  assert.equal(sk.feature.properties.coordinatesMeta[2].snap_distance_m, undefined);
});

test('a route without snaps carries none of the snap fields', () => {
  const route: Route = {
    waypoints: [wp(0, 0, 0), wp(0.1, 0, 1)],
    totalTimeS: 3600,
    totalDistanceM: 11_000,
    motoringTimeS: 0,
    sailingTimeS: 3600,
    validated: true,
  };
  const g = routeToGeoJSON(route) as { features: { geometry: { type: string }; properties: Record<string, unknown> }[] };
  const line = g.features.find(f => f.geometry.type === 'LineString')!.properties;
  assert.equal(line.snaps, undefined);
  assert.equal(line.stop_count, undefined);
  assert.equal(line.start_snap_distance_m, undefined);
});

test('the stops the route was asked for and the precision ride with the route (pins and circles for a client)', () => {
  const route: Route = {
    waypoints: [wp(0, 0, 0), wp(0.1, 0, 1), wp(0.2, 0, 2, 'via'), wp(0.3, 0, 3)],
    totalTimeS: 3 * 3600,
    totalDistanceM: 33_000,
    motoringTimeS: 0,
    sailingTimeS: 3 * 3600,
    validated: true,
    precision: 'approximate',
    stops: [
      { lon: 0, lat: 0 },
      { lon: 0.2004, lat: 0.0005, radiusM: 600 },
      { lon: 0.3, lat: 0 },
    ],
  };
  const g = routeToGeoJSON(route) as { features: { geometry: { type: string }; properties: Record<string, unknown> }[] };
  const line = g.features.find(f => f.geometry.type === 'LineString')!.properties;
  assert.equal(line.precision, 'approximate');
  assert.deepEqual(line.stops, [
    { lon: 0, lat: 0 },
    { lon: 0.2004, lat: 0.0005, radius_m: 600 },
    { lon: 0.3, lat: 0 },
  ]);
  const plain: Route = { ...route, precision: undefined, stops: undefined };
  const g2 = routeToGeoJSON(plain) as { features: { geometry: { type: string }; properties: Record<string, unknown> }[] };
  const line2 = g2.features.find(f => f.geometry.type === 'LineString')!.properties;
  assert.equal(line2.stops, undefined);
  assert.equal(line2.precision, undefined);
});
