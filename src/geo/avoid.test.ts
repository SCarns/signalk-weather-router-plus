import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avoidAreasFromNotes, avoidAt, legHitsAvoid, AVOID_MAX_RADIUS_M } from './avoid';
import { LandMask } from './landmask';
import { OceanPropagator } from '../engine/propagator';
import { PolarDiagram } from '../vessel/polar';
import { makeVessel } from '../vessel/vessel';
import { haversineDistanceM, slerpSamples } from './geodesy';
import type { WindSource } from '../engine/environment';

const NM = 1852;

test('avoid areas come from notes with a position and properties.avoid.radius_m', () => {
  const areas = avoidAreasFromNotes({
    a: { title: 'Trough T3', position: { latitude: -20, longitude: -175 }, properties: { avoid: { radius_m: 100 * NM } } },
    b: { title: 'No radius', position: { latitude: -20, longitude: -175 } },
    c: { title: 'Region only', href: '/resources/regions/x', properties: { avoid: { radius_m: 1000 } } },
    d: { name: 'Older writer', position: { latitude: 41, longitude: -71 }, properties: { avoid: { radius_m: 500 } } },
    e: { title: 'Too large', position: { latitude: 0, longitude: 0 }, properties: { avoid: { radius_m: AVOID_MAX_RADIUS_M + 1 } } },
    f: { title: 'Bad radius', position: { latitude: 0, longitude: 0 }, properties: { avoid: { radius_m: -5 } } },
  });
  assert.deepEqual(
    areas.map(a => [a.id, a.title, a.radiusM]),
    [
      ['a', 'Trough T3', 100 * NM],
      ['d', 'Older writer', 500],
    ]
  );
  assert.deepEqual(avoidAreasFromNotes(null), []);
});

test('a point inside, a leg through, a leg past, and across 180°', () => {
  const area = { id: 'x', title: 'X', lon: 0, lat: 0, radiusM: 10 * NM };
  assert.ok(avoidAt([area], 0.1, 0.1));
  assert.equal(avoidAt([area], 0.3, 0), null);
  // A leg straight through the middle, with both ends outside.
  assert.ok(legHitsAvoid([area], -1, 0, 1, 0));
  // The same leg 0.2° (12 nm) north passes outside the 10 nm circle.
  assert.equal(legHitsAvoid([area], -1, 0.2, 1, 0.2), null);
  // A long leg (900 km) through it is still caught (split into pieces).
  assert.ok(legHitsAvoid([area], -4, -0.05, 4, 0.05));
  // Across the antimeridian: a circle at 180° and a leg from 179.5°E to 179.5°W.
  const dateline = { id: 'd', title: 'D', lon: 180, lat: -20, radiusM: 5 * NM };
  assert.ok(legHitsAvoid([dateline], 179.5, -20, -179.5, -20));
  assert.equal(legHitsAvoid([dateline], 179.5, -19, -179.5, -19), null);
});

test('a leg ending just inside a large circle at high latitude is caught (the end checked exactly)', () => {
  // 70°N, a 500 km circle: 13.14° east along the parallel is 498.8 km away
  // (great circle) but 500.3 km in the flat projection the pieces are tested in.
  const area = { id: 'h', title: 'H', lon: 0, lat: 70, radiusM: 500_000 };
  assert.ok(haversineDistanceM(0, 70, 13.14, 70) < area.radiusM);
  assert.ok(legHitsAvoid([area], 20, 70, 13.14, 70));
});

test('a leg is tested along its great circle, not the lat/lon straight line', () => {
  // 30°W to 30°E along 60°N: the great circle bows north to about 63.4°N at
  // 0°, some 200 nm from the 60°N parallel.
  const lon = new Float64Array(3);
  const lat = new Float64Array(3);
  slerpSamples(-30, 60, 30, 60, 3, lon, lat, 0);
  const onArc = { id: 'v', title: 'V', lon: lon[1], lat: lat[1], radiusM: 20 * NM };
  const onParallel = { id: 'p', title: 'P', lon: 0, lat: 60, radiusM: 20 * NM };
  assert.ok(legHitsAvoid([onArc], -30, 60, 30, 60));
  assert.equal(legHitsAvoid([onParallel], -30, 60, 30, 60), null);
});

test('LandMask.withAvoid: the circles answer as land; the mask it is made from is unchanged', () => {
  const base = LandMask.fromPolygons([], { west: -2, south: -2, east: 2, north: 2 }, 0.02);
  const area = { id: 'x', title: 'X', lon: 0, lat: 0, radiusM: 10 * NM };
  const view = base.withAvoid([area]);
  assert.equal(view.isLand(0, 0), true);
  assert.equal(view.isLandExact(0.05, 0), true);
  assert.equal(view.legCrossesLandExact(-1, 0, 1, 0), true);
  assert.deepEqual([...view.legsCrossLandBulk([-1, -1], [0, 1], [1, 1], [0, 1])], [1, 0]);
  // The cached mask is not touched.
  assert.equal(base.isLand(0, 0), false);
  assert.equal(base.legCrossesLandExact(-1, 0, 1, 0), false);
  assert.equal(base.withAvoid([]), base);
});

test('a route goes round an area to avoid on its direct line', () => {
  // Open water, a steady beam wind; the direct line south along 0° passes
  // through a 20 nm circle at 0°, 3°S.
  const wind: WindSource = {
    at: () => [7, 90],
    atMany: lons => ({ speed: new Float64Array(lons.length).fill(7), dir: new Float64Array(lons.length).fill(90) }),
    hasWaves: false,
    wavesAt: () => null,
  };
  const polar = new PolarDiagram([45, 90, 135, 180], [5, 10], [3, 4, 4.5, 5.5, 4, 5, 3.5, 4.5]);
  const area = { id: 'x', title: 'Squall line', lon: 0, lat: -3, radiusM: 20 * NM };
  const run = (avoid: boolean): ReturnType<OceanPropagator['computeRoute']> => {
    const base = LandMask.fromPolygons([], { west: -3, south: -7, east: 3, north: 1 }, 0.02);
    const lm = avoid ? base.withAvoid([area]) : base;
    const skeleton = Array.from({ length: 61 }, (_, i) => ({ lon: 0, lat: -i * 0.1 }));
    const prop = new OceanPropagator(lm, { stages: 16, subsectors: 30, headings: 30, headingIncrementDeg: 1 });
    return prop.computeRoute({
      start: [0, 0],
      end: [0, -6],
      departureTime: new Date('2026-01-01T00:00:00Z'),
      vessel: makeVessel({ motorSpeedMs: 3 }),
      polar,
      wind,
      modePolicy: 'sail_max',
      sailThreshMs: 0,
      corridor: { skeleton, widthM: new Float64Array(skeleton.length).fill(Infinity) },
    });
  };
  const plain = run(false);
  const avoided = run(true);
  // Without the area the route passes within it; with it, every leg stays outside.
  const minDist = (r: typeof plain): number => Math.min(...r.waypoints.map(w => haversineDistanceM(w.lon, w.lat, area.lon, area.lat)));
  assert.ok(minDist(plain) < area.radiusM, `the plain route came within ${(minDist(plain) / NM).toFixed(1)} nm`);
  const wps = avoided.waypoints;
  for (let i = 0; i + 1 < wps.length; i++) {
    assert.equal(legHitsAvoid([area], wps[i].lon, wps[i].lat, wps[i + 1].lon, wps[i + 1].lat), null, `leg ${i} enters the area`);
  }
  assert.ok(avoided.totalTimeS > plain.totalTimeS, 'going round takes longer');
});
