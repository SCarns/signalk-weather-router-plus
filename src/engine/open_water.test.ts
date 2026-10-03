import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OceanPropagator } from './propagator';
import { LandMask } from '../geo/landmask';
import { PolarDiagram } from '../vessel/polar';
import { makeVessel } from '../vessel/vessel';
import type { WindSource } from './environment';

// Course south along lon 0; wind from the east everywhere, light (1.5 m/s)
// near the line and fresh (9 m/s) west of 0.5°W, about 55 km off. The fast
// route detours west into the breeze. Measured: aimed at the skeleton the
// front never got more than 0.21° off the line; aimed parallel, 1.6°. On
// Tonga → Auckland the skeleton aim kept the front within 170 km of the
// direct line while a route 479 km west was 15 h faster.
const windAt = (lon: number): number => (lon < -0.5 ? 9 : 1.5);
const wind: WindSource = {
  at: lon => [windAt(lon), 90],
  atMany: lons => ({ speed: Float64Array.from(lons, windAt), dir: new Float64Array(lons.length).fill(90) }),
  hasWaves: false,
  wavesAt: () => null,
};
const polar = new PolarDiagram(
  [45, 60, 90, 120, 150],
  [1, 4, 8, 12],
  [0.5, 2.5, 3.2, 3.5, 0.6, 3.0, 3.8, 4.2, 0.7, 3.3, 4.1, 4.6, 0.6, 3.2, 4.0, 4.4, 0.5, 2.8, 3.6, 4.0]
);

function run(widthM: number): { route: ReturnType<OceanPropagator['computeRoute']>; frontWest: number } {
  const lm = LandMask.fromPolygons([], { west: -7, south: -8, east: 2, north: 1 }, 0.02);
  const skeleton = Array.from({ length: 61 }, (_, i) => ({ lon: 0, lat: -i * 0.1 }));
  const prop = new OceanPropagator(lm, { stages: 16, subsectors: 30, headings: 30, headingIncrementDeg: 1 });
  let frontWest = 0;
  const route = prop.computeRoute({
    start: [0, 0],
    end: [0, -6],
    departureTime: new Date('2026-01-01T00:00:00Z'),
    vessel: makeVessel({ motorSpeedMs: 3 }),
    polar,
    wind,
    modePolicy: 'sail_max',
    sailThreshMs: 0,
    corridor: { skeleton, widthM: new Float64Array(skeleton.length).fill(widthM) },
    onFrontier: f => {
      for (const p of f.points) frontWest = Math.min(frontWest, p.lon);
    },
  });
  return { route, frontWest };
}

test('in open water the search can leave the skeleton far enough to find a wide detour', () => {
  const open = run(Infinity);
  const control = run(1e6); // finite width: parents aim back at the skeleton, as before
  assert.ok(open.frontWest < -1, `open-water front reached ${open.frontWest.toFixed(2)}°`);
  assert.ok(control.frontWest > -0.5, `skeleton-aimed front reached ${control.frontWest.toFixed(2)}°`);
  assert.ok(Math.min(...open.route.waypoints.map(w => w.lon)) < -0.5, 'the route goes into the breeze');
  assert.ok(
    open.route.totalTimeS < 0.75 * control.route.totalTimeS,
    `open ${(open.route.totalTimeS / 3600).toFixed(1)} h vs skeleton-aimed ${(control.route.totalTimeS / 3600).toFixed(1)} h`
  );
});
