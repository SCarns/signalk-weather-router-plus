import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LandMask } from '../geo/landmask';
import type { ShapePolygon } from '../geo/shapefile';
import { NoCurrent } from './environment';
import { planLegs } from './multileg';
import { runLegPipeline, type LegPipelineInputs } from './pipeline';
import { OceanPropagator } from './propagator';
import { makeVessel } from '../vessel/vessel';

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

const BBOX = { west: -1, south: -1, east: 2, north: 2 };
const T0 = new Date('2026-01-01T00:00:00Z');

function inputs(land: LandMask, over: Partial<LegPipelineInputs> = {}): { inp: LegPipelineInputs; messages: string[] } {
  const messages: string[] = [];
  const inp: LegPipelineInputs = {
    waterGrid: null,
    allowCanals: false,
    landFor: () => land,
    stages: 12,
    propagator: { subsectors: 20, headings: 30 },
    vessel: makeVessel({ motorSpeedMs: 3 }),
    polar: null,
    sim: { modePolicy: 'motor', sailThreshMs: 2.5, simStepM: 200 },
    simplifyM: 0,
    smoother: false,
    smootherTolerance: 0.05,
    loadAreas: async () => null,
    currents: () => ({ source: new NoCurrent(), names: null }),
    multi: false,
    progress: (_s, _t, m) => messages.push(m),
    shouldCancel: () => false,
    ...over,
  };
  return { inp, messages };
}

test('pipeline without a water grid and without simplification equals the propagator alone', async () => {
  const land = LandMask.fromPolygons([rect(1, 0.3, -0.3, 0.7, 1.3)], BBOX, 0.005);
  const [plan] = planLegs(
    [
      { lon: 0, lat: 0.5 },
      { lon: 1, lat: 0.5 },
    ],
    'precise',
    300
  );
  const { inp, messages } = inputs(land);
  const r = await runLegPipeline(inp, plan, 0, [0, 0.5], T0);
  const direct = new OceanPropagator(land, { stages: 12, subsectors: 20, headings: 30 }).computeRoute({
    start: [0, 0.5],
    end: [1, 0.5],
    departureTime: T0,
    vessel: inp.vessel,
    modePolicy: 'motor',
    sailThreshMs: 2.5,
    simStepM: 200,
    arrivalRadiusM: plan.arrivalRadiusM,
    snapToExact: plan.snapToExact,
  });
  assert.deepEqual(
    r.waypoints.map(w => [w.lon, w.lat, w.time.getTime()]),
    direct.waypoints.map(w => [w.lon, w.lat, w.time.getTime()])
  );
  assert.equal(r.validated, true);
  assert.ok(
    messages.some(m => /^skeleton/.test(m)),
    'the per-route skeleton was used'
  );
  assert.ok(!messages.some(m => /corridor/.test(m)), 'no corridor without a water grid');
});

test('pipeline: simplification keeps the route land-free and reports it; the current names travel with the route', async () => {
  const land = LandMask.fromPolygons([rect(1, 0.3, -0.3, 0.7, 1.3)], BBOX, 0.005);
  const [plan] = planLegs(
    [
      { lon: 0, lat: 0.5 },
      { lon: 1, lat: 0.5 },
    ],
    'precise',
    300
  );
  const { inp, messages } = inputs(land, {
    simplifyM: 10,
    smoother: true,
    currents: () => ({ source: new NoCurrent(), names: ['test-source'] }),
  });
  const r = await runLegPipeline(inp, plan, 0, [0, 0.5], T0);
  assert.ok(r.waypoints.length >= 3);
  for (let i = 1; i < r.waypoints.length; i++) {
    const a = r.waypoints[i - 1];
    const b = r.waypoints[i];
    assert.equal(land.legCrossesLandExact(a.lon, a.lat, b.lon, b.lat), false);
    assert.ok(b.time > a.time);
  }
  assert.deepEqual(r.currentSources, ['test-source']);
  assert.ok(messages.some(m => /^currents: test-source$/.test(m)));
  assert.ok(messages.some(m => /^simplified: /.test(m)) || r.smootherDrops === undefined);
});
