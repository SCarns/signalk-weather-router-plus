import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LandMask } from '../geo/landmask';
import type { ShapePolygon } from '../geo/shapefile';
import { haversineDistanceM } from '../geo/geodesy';
import { OceanPropagator } from './propagator';
import { planLegs, routeMultiLeg, stitchLegs, validateLegOptions, type LegPlan } from './multileg';
import type { Route, Waypoint } from './route';
import { makeVessel } from '../vessel/vessel';

function rect(recordNumber: number, lon0: number, lat0: number, lon1: number, lat1: number): ShapePolygon {
  const c = [lon0, lat0, lon1, lat0, lon1, lat1, lon0, lat1, lon0, lat0];
  return {
    recordNumber, minLon: lon0, minLat: lat0, maxLon: lon1, maxLat: lat1,
    rings: [{ coords: Float64Array.from(c), minLon: lon0, minLat: lat0, maxLon: lon1, maxLat: lat1 }],
  };
}

const T0 = new Date('2026-01-01T00:00:00Z');

/** A straight 2-point leg at constant speed (fake runLeg). */
function straightLeg(from: [number, number], to: [number, number], dep: Date, speedMs: number, mode: 'sailing' | 'motoring' = 'motoring'): Route {
  const d = haversineDistanceM(from[0], from[1], to[0], to[1]);
  const s = d / speedMs;
  const a: Waypoint = { lon: from[0], lat: from[1], time: dep, sogMs: 0, cogDeg: 0, mode: 'motoring' };
  const b: Waypoint = { lon: to[0], lat: to[1], time: new Date(dep.getTime() + s * 1000), sogMs: speedMs, cogDeg: 0, mode };
  return {
    waypoints: [a, b], totalTimeS: s, totalDistanceM: d,
    motoringTimeS: mode === 'motoring' ? s : 0, sailingTimeS: mode === 'sailing' ? s : 0, validated: true,
  };
}

test('planLegs: precise legs are exact; approximate intermediate legs use the circle, the last leg is exact', () => {
  const stops = [{ lon: 0, lat: 0 }, { lon: 1, lat: 0 }, { lon: 1, lat: 1, radiusM: 750 }, { lon: 2, lat: 1 }];
  const p = planLegs(stops, 'precise', 300);
  assert.equal(p.length, 3);
  assert.ok(p.every((l) => l.snapToExact && l.arrivalRadiusM === undefined));
  const a = planLegs(stops, 'approximate', 300);
  assert.deepEqual(a.map((l) => [l.snapToExact, l.arrivalRadiusM]), [[false, 300], [false, 750], [true, undefined]]);
  assert.deepEqual(a.map((l) => l.end), [[1, 0], [1, 1], [2, 1]]);
  // Defaults: precise.
  assert.ok(planLegs(stops).every((l) => l.snapToExact));
  // One leg (no waypoints): exact whatever the precision.
  assert.deepEqual(planLegs([{ lon: 0, lat: 0 }, { lon: 1, lat: 0 }], 'approximate', 300).map((l) => l.snapToExact), [true]);
});

test('validateLegOptions follows the reference (approximate needs radius > 0, 0..5000)', () => {
  assert.equal(validateLegOptions(undefined, undefined, undefined), null);
  assert.equal(validateLegOptions('approximate', undefined, []), null); // default 200
  assert.match(validateLegOptions('approximate', 0, [])!, /> 0/);
  assert.match(validateLegOptions('fuzzy', 100, [])!, /precision/);
  assert.match(validateLegOptions('precise', 6000, [])!, /0\.\.5000/);
  assert.match(validateLegOptions('precise', 100, [{ radius_m: -1 }])!, /waypoints\[0\]/);
  assert.match(validateLegOptions('approximate', 100, [{ radius_m: 0 }])!, /waypoints\[0\]/);
  assert.equal(validateLegOptions('precise', 0, [{ radius_m: 0 }]), null);
});

test('stitching: times chain, distances and sail/motor sum, no duplicate junctions, junctions are vias', async () => {
  const stops = [{ lon: 0, lat: 0 }, { lon: 0.5, lat: 0 }, { lon: 0.5, lat: 0.5 }, { lon: 1, lat: 0.5 }];
  const seen: { start: [number, number]; dep: number }[] = [];
  const r = await routeMultiLeg({
    stops, departureTime: T0,
    runLeg: (leg: LegPlan, start, dep) => {
      seen.push({ start, dep: dep.getTime() });
      return straightLeg(start, leg.end, dep, leg.index === 1 ? 4 : 2, leg.index === 1 ? 'sailing' : 'motoring');
    },
  });
  // Each leg departs at the previous leg's arrival from the previous leg's end.
  assert.equal(seen[0].dep, T0.getTime());
  const d0 = haversineDistanceM(0, 0, 0.5, 0);
  const d1 = haversineDistanceM(0.5, 0, 0.5, 0.5);
  const d2 = haversineDistanceM(0.5, 0.5, 1, 0.5);
  assert.ok(Math.abs(seen[1].dep - (T0.getTime() + (d0 / 2) * 1000)) <= 1);
  assert.ok(Math.abs(seen[2].dep - (seen[1].dep + (d1 / 4) * 1000)) <= 1);
  assert.deepEqual(seen[1].start, [0.5, 0]);
  assert.deepEqual(seen[2].start, [0.5, 0.5]);
  // 3 legs × 2 points − 2 duplicate junctions.
  assert.equal(r.waypoints.length, 4);
  assert.deepEqual(r.waypoints.map((w) => [w.lon, w.lat]), [[0, 0], [0.5, 0], [0.5, 0.5], [1, 0.5]]);
  assert.deepEqual(r.waypoints.map((w) => w.role), [undefined, 'via', 'via', undefined]);
  assert.ok(Math.abs(r.totalDistanceM - (d0 + d1 + d2)) < 1e-6);
  assert.ok(Math.abs(r.sailingTimeS - d1 / 4) < 1e-6);
  assert.ok(Math.abs(r.motoringTimeS - (d0 / 2 + d2 / 2)) < 1e-6);
  assert.ok(Math.abs(r.totalTimeS - (d0 / 2 + d1 / 4 + d2 / 2)) < 0.01);
  for (let i = 1; i < r.waypoints.length; i++) assert.ok(r.waypoints[i].time > r.waypoints[i - 1].time);
});

test('stitching keeps warnings at their stitched leg index and concatenates auto vias', () => {
  const a = straightLeg([0, 0], [1, 0], T0, 2);
  a.waypoints.splice(1, 0, { ...a.waypoints[1], lon: 0.5 });
  a.warnings = [{ leg_index: 1, violation: 'leg_crosses_land', from: [0.5, 0], to: [1, 0], repaired: false }];
  a.autoVias = [{ lon: 0.2, lat: 0, radiusM: 100, widthM: 50, name: 'A' }];
  const b = straightLeg([1, 0], [2, 0], a.waypoints[2].time, 2);
  b.warnings = [{ leg_index: 0, violation: 'leg_crosses_land', from: [1, 0], to: [2, 0], repaired: false }];
  b.autoVias = [{ lon: 1.5, lat: 0, radiusM: 100, widthM: 50, name: 'B' }];
  const r = stitchLegs([a, b]);
  assert.equal(r.waypoints.length, 4);
  assert.deepEqual(r.warnings!.map((w) => w.leg_index), [1, 2]);
  assert.deepEqual(r.warnings!.map((w) => r.waypoints[w.leg_index].lon), [0.5, 1]);
  assert.deepEqual(r.autoVias!.map((v) => v.name), ['A', 'B']);
  // One leg: returned unchanged.
  assert.equal(stitchLegs([b]), b);
});

// ---- the real propagator on a synthetic chart -------------------------

const BBOX = { west: -1, south: -1, east: 2, north: 2 };
const LM = LandMask.fromPolygons([rect(1, 1.5, 1.5, 1.9, 1.9)], BBOX, 0.01);
const VESSEL = makeVessel({ motorSpeedMs: 3 });

function legRunner(prop: OceanPropagator) {
  return (leg: LegPlan, start: [number, number], dep: Date): Route => prop.computeRoute({
    start, end: leg.end, departureTime: dep, vessel: VESSEL, modePolicy: 'motor',
    arrivalRadiusM: leg.arrivalRadiusM, snapToExact: leg.snapToExact,
  });
}

test('precise: every leg ends exactly on its waypoint; the route passes through each', async () => {
  const prop = new OceanPropagator(LM, { stages: 10, subsectors: 20, headings: 30 });
  const stops = [{ lon: 0, lat: 0 }, { lon: 0.6, lat: 0.1 }, { lon: 0.5, lat: 0.45 }, { lon: 1, lat: 0.5 }];
  const r = await routeMultiLeg({ stops, departureTime: T0, precision: 'precise', runLeg: legRunner(prop) });
  const vias = r.waypoints.filter((w) => w.role === 'via');
  assert.equal(vias.length, 2);
  for (let k = 0; k < 2; k++) {
    assert.ok(haversineDistanceM(vias[k].lon, vias[k].lat, stops[k + 1].lon, stops[k + 1].lat) < 0.01, `via ${k} not exact`);
  }
  const last = r.waypoints[r.waypoints.length - 1];
  assert.ok(haversineDistanceM(last.lon, last.lat, 1, 0.5) < 0.01);
  for (let i = 1; i < r.waypoints.length; i++) assert.ok(r.waypoints[i].time > r.waypoints[i - 1].time);
});

test('approximate: an intermediate leg ends inside the circle, the next leg starts there, the last leg is exact', async () => {
  const prop = new OceanPropagator(LM, { stages: 10, subsectors: 20, headings: 30 });
  // A hairpin: out to (0.6, 0.1), back to (0.5, 0.45) with a reversal.
  const stops = [{ lon: 0, lat: 0 }, { lon: 0.6, lat: 0.1 }, { lon: 0.5, lat: 0.45, radiusM: 900 }, { lon: 1, lat: 0.5 }];
  const starts: [number, number][] = [];
  const run = legRunner(prop);
  const r = await routeMultiLeg({
    stops, departureTime: T0, precision: 'approximate', arrivalRadiusM: 500,
    runLeg: (leg, start, dep) => { starts.push(start); return run(leg, start, dep); },
  });
  const vias = r.waypoints.filter((w) => w.role === 'via');
  assert.equal(vias.length, 2);
  const d0 = haversineDistanceM(vias[0].lon, vias[0].lat, 0.6, 0.1);
  const d1 = haversineDistanceM(vias[1].lon, vias[1].lat, 0.5, 0.45);
  assert.ok(d0 <= 500, `first via ${d0} m from its waypoint (radius 500)`);
  // Per-waypoint radius override (900 m).
  assert.ok(d1 <= 900, `second via ${d1} m from its waypoint (radius 900)`);
  // Next leg starts where the previous ended.
  assert.deepEqual(starts[1], [vias[0].lon, vias[0].lat]);
  assert.deepEqual(starts[2], [vias[1].lon, vias[1].lat]);
  const last = r.waypoints[r.waypoints.length - 1];
  assert.ok(haversineDistanceM(last.lon, last.lat, 1, 0.5) < 0.01, 'last leg must be exact');
});

test('snapToExact=false: without a candidate inside the circle the leg ends on the circle', () => {
  // Two stages: candidates land ~half the leg apart, far outside a 300 m circle.
  const prop = new OceanPropagator(LM, { stages: 3, subsectors: 10, headings: 10 });
  const r = prop.computeRoute({ start: [0, 0], end: [0.5, 0], departureTime: T0, vessel: VESSEL, modePolicy: 'motor', arrivalRadiusM: 300, snapToExact: false });
  const last = r.waypoints[r.waypoints.length - 1];
  const d = haversineDistanceM(last.lon, last.lat, 0.5, 0);
  assert.ok(d <= 300 && d > 250, `ends ${d} m from the waypoint`);
  // snapToExact=false needs a radius.
  assert.throws(() => prop.computeRoute({ start: [0, 0], end: [0.5, 0], departureTime: T0, vessel: VESSEL, modePolicy: 'motor', snapToExact: false }), /arrivalRadiusM/);
  // Default (exact) is unchanged.
  const e = prop.computeRoute({ start: [0, 0], end: [0.5, 0], departureTime: T0, vessel: VESSEL, modePolicy: 'motor' });
  const le = e.waypoints[e.waypoints.length - 1];
  assert.deepEqual([le.lon, le.lat], [0.5, 0]);
});
