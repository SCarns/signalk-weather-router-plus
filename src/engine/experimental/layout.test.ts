/**
 * The refined router's layout of a fixed polyline under sail_max (propagator.ts sailPolyline): light-air motoring
 * below a positive threshold is the policy's own and is kept; a course into the no-go angle is tacked, not motored.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LandTest } from '../../geo/landmask';
import { NoCurrent, type WindSource } from '../environment';
import { PolarDiagram } from '../../vessel/polar';
import { makeVessel } from '../../vessel/vessel';
import { ExperimentalPropagator } from './propagator';

const POLAR = PolarDiagram.parse(
  `twa/tws,4,6,8,10,12,14,16,20,25
0,0,0,0,0,0,0,0,0,0
30,1.5,2.5,3.3,4.0,4.3,4.5,4.6,4.7,4.7
45,2.5,3.6,4.5,5.1,5.5,5.7,5.8,5.9,5.9
60,3.0,4.2,5.1,5.7,6.1,6.3,6.4,6.5,6.5
90,3.2,4.5,5.5,6.1,6.5,6.7,6.8,6.9,6.9
120,3.0,4.3,5.3,6.0,6.4,6.7,6.9,7.1,7.2
150,2.4,3.6,4.6,5.4,6.0,6.4,6.7,7.0,7.3
180,2.0,3.0,4.0,4.8,5.5,6.0,6.4,6.8,7.1`,
  ','
);
const VESSEL = makeVessel({ motorSpeedMs: 3 });
const T0 = new Date('2026-01-01T00:00:00Z');
/** Open water everywhere. */
const OPEN: LandTest = {
  isLand: () => false,
  isLandExact: () => false,
  legCrossesLandExact: () => false,
  legsCrossLandBulk: la => new Uint8Array(la.length),
};
/** Wind from `dir` at `kn` everywhere. */
function wind(kn: number, dir: number): WindSource {
  const ms = kn * 0.5144444444;
  return {
    hasWaves: false,
    at: () => [ms, dir],
    atMany: lons => ({ speed: new Float64Array(lons.length).fill(ms), dir: new Float64Array(lons.length).fill(dir) }),
    wavesAt: () => null,
  };
}
const lay = (w: WindSource, path: [number, number][], sailThreshMs: number) =>
  new ExperimentalPropagator(OPEN, { stages: 10 }).sailPolyline(path, T0, {
    vessel: VESSEL,
    polar: POLAR,
    wind: w,
    current: new NoCurrent(),
    sim: { modePolicy: 'sail_max', sailThreshMs, simStepM: 200 },
    who: 'test',
    advice: 'none',
  });

test('sailPolyline under sail_max: a light-air reach below the threshold is motored, as the policy says, not refused', () => {
  // Due east with 4 kn from the north: the polar gives about 1.6 m/s on the beam, under a 2.5 m/s threshold.
  const r = lay(
    wind(4, 0),
    [
      [0, 0],
      [0.1, 0],
    ],
    2.5
  );
  assert.ok(r.motoringTimeS > 0, 'motored');
  assert.equal(r.sailingTimeS, 0);
});

test('sailPolyline under sail_max: a course dead into the wind is tacked, not motored, above a positive threshold', () => {
  // Due north into 12 kn from the north: the beat is sailed on two headings with a tack.
  const r = lay(
    wind(12, 0),
    [
      [0, 0],
      [0, 0.1],
    ],
    2.5
  );
  assert.ok(
    r.waypoints.some(w => w.tack),
    'tacked'
  );
  assert.equal(r.motoringTimeS, 0, 'nothing motored');
});
