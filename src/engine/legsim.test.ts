import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoCurrent, type WindSource } from './environment';
import { scoreCandidatesFromParent, simulateLegTime } from './legsim';
import { PolarDiagram } from '../vessel/polar';
import { makeVessel } from '../vessel/vessel';

/** Wind from the north at `ms` everywhere. */
function wind(ms: number): WindSource {
  return {
    hasWaves: false,
    at: () => [ms, 0],
    atMany: lons => ({ speed: new Float64Array(lons.length).fill(ms), dir: new Float64Array(lons.length) }),
    wavesAt: () => null,
  };
}

// 90° TWA: 1.5 m/s in 6 kn of wind, 3.0 m/s in 12 kn.
const POLAR = PolarDiagram.parse('twa/tws,6,12\n0,0,0\n90,2.9158,5.8315\n180,2,4\n', ',');
const VESSEL = makeVessel({ motorSpeedMs: 3 });
const T0 = new Date('2026-01-01T00:00:00Z');
const opts = (sailThreshMs: number) => ({ modePolicy: 'sail_max' as const, sailThreshMs, simStepM: 200 });

test('sail_max sails only at or above the threshold (no 0.25 / 1.0 m/s shortcut)', () => {
  // Due east with wind from the north: TWA 90°, polar 1.5 m/s in 6 kn.
  const light = wind(6 * 0.5144444444);
  const below = simulateLegTime(0, 0, T0, 0.05, 0, VESSEL, POLAR, light, new NoCurrent(), opts(2.5));
  assert.equal(below.dominantMode, 'motoring', 'polar 1.5 m/s < threshold 2.5 m/s → motor');
  assert.equal(below.sailingSeconds, 0);
  const above = simulateLegTime(0, 0, T0, 0.05, 0, VESSEL, POLAR, light, new NoCurrent(), opts(1.0));
  assert.equal(above.dominantMode, 'sailing', 'polar 1.5 m/s ≥ threshold 1.0 m/s → sail');
  assert.equal(above.motoringSeconds, 0);
  // The batched scorer applies the same rule.
  const sc = scoreCandidatesFromParent(
    0,
    0,
    T0,
    Float64Array.of(90),
    Float64Array.of(5000),
    VESSEL,
    POLAR,
    light,
    new NoCurrent(),
    opts(2.5)
  );
  assert.equal(sc.dominant[0], 0, 'scorer: below threshold → motoring');
});
