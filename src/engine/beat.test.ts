import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OceanPropagator } from './propagator';
import { LandMask } from '../geo/landmask';
import { PolarDiagram } from '../vessel/polar';
import { makeVessel } from '../vessel/vessel';
import type { WindSource } from './environment';

/** A steady wind from `fromDeg`, no waves. */
function steady(speedMs: number, fromDeg: number): WindSource {
  return {
    at: () => [speedMs, fromDeg],
    atMany: lons => ({ speed: new Float64Array(lons.length).fill(speedMs), dir: new Float64Array(lons.length).fill(fromDeg) }),
    hasWaves: false,
    wavesAt: () => null,
  };
}

test('a destination dead to windward is reached by sailing (tacking), never by motoring, with min sail speed 0', () => {
  // Open water, wind from the east, route from west to east: every straight
  // leg to the goal is in the no-go angle (45°), so the only way is to beat.
  const bbox = { west: -1, south: -1, east: 2, north: 2 };
  const lm = LandMask.fromPolygons([], bbox, 0.01);
  const prop = new OceanPropagator(lm, { stages: 12, subsectors: 20, headings: 30 });
  const polar = new PolarDiagram(
    [45, 60, 90, 120, 150],
    [4, 8, 12],
    [2.5, 3.2, 3.5, 3.4, 3.0, 3.0, 3.8, 4.2, 4.0, 3.5, 3.3, 4.1, 4.6, 4.4, 3.9]
  );
  const route = prop.computeRoute({
    start: [0, 0.5],
    end: [0.6, 0.5],
    departureTime: new Date('2026-01-01T00:00:00Z'),
    vessel: makeVessel({ motorSpeedMs: 3 }),
    polar,
    wind: steady(8, 90),
    modePolicy: 'sail_max',
    sailThreshMs: 0,
  });
  assert.ok(route.waypoints.length >= 3);
  assert.equal(route.motoringTimeS, 0, 'no motoring to windward');
  assert.ok(route.waypoints.slice(1).every(w => w.mode === 'sailing'));
  // Every sailed leg is outside the no-go angle on one tack or the other.
  for (const w of route.waypoints.slice(1)) {
    let twa = (((w.cogDeg - 90) % 360) + 360) % 360;
    if (twa > 180) twa = 360 - twa;
    assert.ok(twa >= 44, `leg at TWA ${twa.toFixed(0)}° is in the no-go angle`);
  }
  // The last two legs are on opposite tacks: the beat to the waypoint.
  const n = route.waypoints.length;
  const side = (cog: number): number => Math.sign(Math.sin(((cog - 90) * Math.PI) / 180));
  assert.notEqual(side(route.waypoints[n - 1].cogDeg), side(route.waypoints[n - 2].cogDeg), 'the final approach tacks');
  const last = route.waypoints[n - 1];
  assert.ok(Math.abs(last.lon - 0.6) < 1e-6 && Math.abs(last.lat - 0.5) < 1e-6, 'arrives at the destination');
});

test('a long beat with a narrow primary sweep keeps every parent tacking: the front never falls back', () => {
  // The eastern Mediterranean job 3bde5200: ±30° primary sweep (the user's
  // settings), destination dead upwind. Before the per-parent fallback the
  // parents facing upwind got no wider sweep whenever a sibling had a
  // survivor, and the front "tacked in place" (best remaining 1356 → 1430 →
  // 1356 km …). Now each such parent gets the wider sweep on its own.
  const bbox = { west: -1, south: -3, east: 7, north: 4 };
  const lm = LandMask.fromPolygons([], bbox, 0.02);
  const polar = new PolarDiagram(
    [52, 60, 75, 90, 110, 120, 135, 150],
    [3.09, 4.12, 5.14, 6.17, 7.2, 8.23, 10.29],
    [
      2.73, 3.24, 3.55, 3.7, 3.81, 3.86, 3.91, 2.93, 3.45, 3.76, 3.91, 3.96, 4.01, 4.12, 3.09, 3.6, 3.91, 4.06, 4.22, 4.27, 4.37, 3.24,
      3.76, 4.06, 4.22, 4.27, 4.42, 4.63, 3.24, 3.81, 4.17, 4.37, 4.53, 4.73, 5.09, 3.14, 3.76, 4.17, 4.42, 4.63, 4.89, 5.35, 2.88, 3.5,
      4.01, 4.37, 4.68, 4.99, 5.61, 2.57, 3.19, 3.7, 4.12, 4.48, 4.84, 5.56,
    ]
  );
  const prop = new OceanPropagator(lm, { stages: 10, subsectors: 30, headings: 30, headingIncrementDeg: 1 });
  const remaining: number[] = [];
  const route = prop.computeRoute({
    start: [0, 0.5],
    end: [5.4, 0.5],
    departureTime: new Date('2026-10-01T00:00:00Z'),
    vessel: makeVessel({ motorSpeedMs: 3 }),
    polar,
    wind: steady(8, 90),
    modePolicy: 'sail_max',
    sailThreshMs: 0,
    onProgress: (_s, _t, m) => {
      const r = /best remaining ([\d.]+) km/.exec(m);
      if (r) remaining.push(Number(r[1]));
    },
  });
  assert.equal(route.motoringTimeS, 0);
  const straight = 5.4 * 111_195 * Math.cos((0.5 * Math.PI) / 180);
  assert.ok(
    route.totalDistanceM < 1.8 * straight,
    `beat of ${(route.totalDistanceM / 1000).toFixed(0)} km for ${(straight / 1000).toFixed(0)} km straight`
  );
  assert.ok(remaining.length >= 10);
  for (let i = 1; i < remaining.length; i++)
    assert.ok(remaining[i] < remaining[i - 1], `stage ${i + 1}: best remaining ${remaining[i]} km after ${remaining[i - 1]} km`);
});

test('the final choice is the branch arriving earliest, not the nearest one (a polar with speed close to the wind)', () => {
  // Library-style polar with small speeds at 10°–25°: a straight leg 19° off
  // the wind is legal but slow (job e6e338f6, leg 5: 3.6 kn straight for
  // 10.5 h while tacking branches were hours ahead but further out).
  const bbox = { west: -1, south: -1, east: 2, north: 2 };
  const lm = LandMask.fromPolygons([], bbox, 0.01);
  const polar = new PolarDiagram(
    [10, 20, 32, 40, 52, 60, 90, 120, 150],
    [4, 8, 12],
    [0.5, 0.9, 1.0, 1.0, 1.7, 2.0, 2.0, 3.2, 3.6, 2.6, 4.1, 4.5, 3.0, 4.6, 5.0, 3.3, 4.9, 5.3, 3.6, 5.2, 5.6, 3.4, 5.0, 5.4, 3.0, 4.6, 5.0]
  );
  const prop = new OceanPropagator(lm, { stages: 20, subsectors: 30, headings: 30, headingIncrementDeg: 1 });
  // Course east (90°), wind from 071°: the straight leg is 19° off the wind.
  const lines: string[] = [];
  const route = prop.computeRoute({
    start: [0, 0.5],
    end: [0.62, 0.5],
    departureTime: new Date('2026-01-01T00:00:00Z'),
    vessel: makeVessel({ motorSpeedMs: 3 }),
    polar,
    wind: steady(8, 71),
    modePolicy: 'sail_max',
    sailThreshMs: 0,
    onProgress: (_s, _t, m) => lines.push(m),
  });
  const straightS = route.totalDistanceM > 0 ? (0.62 * 111_195 * Math.cos((0.5 * Math.PI) / 180)) / polar.boatSpeed(19, 8) : 0;
  assert.ok(
    route.totalTimeS < 0.8 * straightS,
    `route ${(route.totalTimeS / 3600).toFixed(1)} h vs ${(straightS / 3600).toFixed(1)} h straight`
  );
  assert.ok(route.waypoints.length > 3, 'the route tacks');
  assert.ok(
    lines.some(m => /final choice: the branch arriving earliest/.test(m)),
    'the earliest branch was chosen over the nearest'
  );
});

test('a beat to a waypoint sails even when the wind backs along the legs (margins wider than 3° are tried)', () => {
  // Dead upwind from the west; the wind direction turns with latitude, 20°
  // per 0.1°, so a leg at the tightest angle runs into the no-go angle
  // after a few km; a wider tack angle gets there.
  const bbox = { west: -1, south: -1, east: 2, north: 2 };
  const lm = LandMask.fromPolygons([], bbox, 0.01);
  const turning: WindSource = {
    at: (_lon, lat) => [8, 90 + (lat - 0.5) * 200],
    atMany: (lons, lats) => ({ speed: new Float64Array(lons.length).fill(8), dir: Float64Array.from(lats, lat => 90 + (lat - 0.5) * 200) }),
    hasWaves: false,
    wavesAt: () => null,
  };
  const prop = new OceanPropagator(lm, { stages: 6, subsectors: 20, headings: 30 });
  const polar = new PolarDiagram(
    [45, 60, 90, 120, 150],
    [4, 8, 12],
    [2.5, 3.2, 3.5, 3.4, 3.0, 3.0, 3.8, 4.2, 4.0, 3.5, 3.3, 4.1, 4.6, 4.4, 3.9]
  );
  const route = prop.computeRoute({
    start: [0, 0.5],
    end: [0.3, 0.5],
    departureTime: new Date('2026-01-01T00:00:00Z'),
    vessel: makeVessel({ motorSpeedMs: 3 }),
    polar,
    wind: turning,
    modePolicy: 'sail_max',
    sailThreshMs: 0,
  });
  assert.equal(route.motoringTimeS, 0);
  const last = route.waypoints[route.waypoints.length - 1];
  assert.ok(Math.abs(last.lon - 0.3) < 1e-6 && Math.abs(last.lat - 0.5) < 1e-6);
});
