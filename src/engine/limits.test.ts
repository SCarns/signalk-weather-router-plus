import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCandidatesFromParent, simulateLegTime, type SimOptions } from './legsim';
import type { CurrentSource, WindSource } from './environment';
import { makeVessel } from '../vessel/vessel';
import { PolarDiagram } from '../vessel/polar';
import { OceanPropagator, ViasNotCrossedError } from './propagator';
import { LandMask } from '../geo/landmask';

/** Uniform wind and waves everywhere. */
function wind(speedMs: number, swhM: number): WindSource {
  return {
    at: () => [speedMs, 180],
    atMany: lons => ({ speed: new Float64Array(lons.length).fill(speedMs), dir: new Float64Array(lons.length).fill(180) }),
    hasWaves: true,
    wavesAt: () => ({ swh: swhM, mwp: 6, mwd: 180 }),
    wavesAtMany: lons => new Float64Array(lons.length).fill(swhM),
  };
}
const still: CurrentSource = {
  at: () => [0, 0],
  atMany: lons => ({ u: new Float64Array(lons.length), v: new Float64Array(lons.length) }),
};
const vessel = makeVessel({ motorSpeedMs: 3 });
const base: SimOptions = { modePolicy: 'motor', sailThreshMs: 2, simStepM: 200 };
const t0 = new Date('2026-10-01T00:00:00Z');

test('limits: a leg over the wind or wave limit is stuck; under the limits it is not', () => {
  const ok = simulateLegTime(0, 0, t0, 0.01, 0, vessel, null, wind(10, 1.5), still, base);
  assert.ok(Number.isFinite(ok.seconds) && ok.seconds > 0);
  const windy = simulateLegTime(0, 0, t0, 0.01, 0, vessel, null, wind(20, 1.5), still, { ...base, maxWindMs: 15 });
  assert.equal(windy.seconds, Infinity);
  assert.equal(windy.dominantMode, 'stuck');
  const rough = simulateLegTime(0, 0, t0, 0.01, 0, vessel, null, wind(10, 2.5), still, { ...base, maxSwhM: 2 });
  assert.equal(rough.seconds, Infinity);
  // Limits exactly met are allowed.
  const edge = simulateLegTime(0, 0, t0, 0.01, 0, vessel, null, wind(15, 2), still, { ...base, maxWindMs: 15, maxSwhM: 2 });
  assert.ok(Number.isFinite(edge.seconds));
});

test('limits: scored candidates over a limit are stuck and flagged as limited', () => {
  const bearings = new Float64Array([0, 90, 180]);
  const dists = new Float64Array([1000, 1000, 1000]);
  const free = scoreCandidatesFromParent(0, 0, t0, bearings, dists, vessel, null, wind(20, 3), still, base);
  assert.ok(free.seconds.every(s => Number.isFinite(s)));
  assert.ok(free.limited.every(l => l === 0));
  const capped = scoreCandidatesFromParent(0, 0, t0, bearings, dists, vessel, null, wind(20, 3), still, { ...base, maxSwhM: 2.5 });
  assert.ok(capped.seconds.every(s => s === Infinity));
  assert.ok(capped.limited.every(l => l === 1));
  assert.ok(capped.dominant.every(d => d === -1));
  // Without wave data in the forecast a wave limit cannot stop anything.
  const noWaves: WindSource = { ...wind(20, 3), hasWaves: false, wavesAt: () => null, wavesAtMany: undefined };
  const dry = scoreCandidatesFromParent(0, 0, t0, bearings, dists, vessel, null, noWaves, still, { ...base, maxSwhM: 2.5 });
  assert.ok(dry.seconds.every(s => Number.isFinite(s)));
});

test('a zero min sail speed sails whenever the polar gives any speed; where it gives none the leg is stuck (so the router tacks), not motored', () => {
  const dead = new PolarDiagram([45, 135], [5, 15], [0, 0, 0, 0]);
  const r = simulateLegTime(0, 0, t0, 0.01, 0, vessel, dead, wind(10, 1), still, {
    modePolicy: 'sail_max',
    sailThreshMs: 0,
    simStepM: 200,
  });
  assert.equal(r.seconds, Infinity);
  assert.equal(r.dominantMode, 'stuck');
  const slow = new PolarDiagram([45, 135], [5, 15], [1, 1, 1, 1]);
  const s = simulateLegTime(0, 0, t0, 0.01, 0, vessel, slow, wind(10, 1), still, {
    modePolicy: 'sail_max',
    sailThreshMs: 0,
    simStepM: 200,
  });
  assert.equal(s.dominantMode, 'sailing');
});

test('a search boxed in by the wind limit fails with a message that counts the limited candidates and names the forecast end', () => {
  // Open water; wind from the north, 8 m/s west of 0.3°E and 20 m/s east of
  // it, so with a 15 m/s limit the route can never get past that line.
  const bbox = { west: -1, south: -3, east: 3, north: 4 };
  const lm = LandMask.fromPolygons([], bbox, 0.02);
  const banded: WindSource = {
    at: (lon: number) => [lon < 0.3 ? 8 : 20, 0],
    atMany: lons => ({ speed: Float64Array.from(lons, lon => (lon < 0.3 ? 8 : 20)), dir: new Float64Array(lons.length) }),
    hasWaves: false,
    wavesAt: () => null,
  };
  const polar = new PolarDiagram(
    [45, 60, 90, 120, 150],
    [4, 8, 12],
    [2.5, 3.2, 3.5, 3.4, 3.0, 3.0, 3.8, 4.2, 4.0, 3.5, 3.3, 4.1, 4.6, 4.4, 3.9]
  );
  const prop = new OceanPropagator(lm, { stages: 8, subsectors: 20, headings: 30 });
  const run = (forecastEndMs?: number) =>
    prop.computeRoute({
      start: [0, 0.5],
      end: [2, 0.5],
      departureTime: t0,
      vessel,
      polar,
      wind: banded,
      modePolicy: 'sail_max',
      sailThreshMs: 0,
      maxWindMs: 15,
      forecastEndMs,
    });
  assert.throws(run, (err: Error) => {
    assert.match(err.message, /boxed in/);
    assert.match(err.message, /\d+ over the wind\/wave limit/);
    assert.doesNotMatch(err.message, /forecast ends/);
    return true;
  });
  // With a forecast that ended before the search got stuck, the message says so.
  assert.throws(
    () => run(t0.getTime() + 3600_000),
    (err: Error) => {
      assert.match(err.message, /boxed in/);
      assert.match(err.message, /The forecast ends 2026-10-01 01:00 UTC and the search is \d+ h past it/);
      return true;
    }
  );
  // Without the limit the same route is found.
  const free = prop.computeRoute({
    start: [0, 0.5],
    end: [2, 0.5],
    departureTime: t0,
    vessel,
    polar,
    wind: banded,
    modePolicy: 'sail_max',
    sailThreshMs: 0,
  });
  assert.ok(free.waypoints.length >= 2);
});

test('boxed in before a via is crossed raises ViasNotCrossedError (so the router can retry without automatic vias)', () => {
  // A band over the wind limit between 0.3°E and 0.5°E south of 1°N holds
  // the via; the destination beyond is reachable around the band's north
  // end, but no branch can cross the via, so the search must not end with
  // a plain "boxed in" (the caller retries without auto vias only on the
  // vias error; job 58b50b0d, east of Crete with the Kythira via behind).
  const bbox = { west: -1, south: -3, east: 3, north: 4 };
  const lm = LandMask.fromPolygons([], bbox, 0.02);
  const over = (lon: number, lat: number): boolean => lon > 0.3 && lon < 0.5 && lat < 1.0;
  const banded: WindSource = {
    at: (lon: number, lat: number) => [over(lon, lat) ? 20 : 8, 0],
    atMany: (lons, lats) => ({
      speed: Float64Array.from(lons, (lon, i) => (over(lon, lats[i]) ? 20 : 8)),
      dir: new Float64Array(lons.length),
    }),
    hasWaves: false,
    wavesAt: () => null,
  };
  const polar = new PolarDiagram(
    [45, 60, 90, 120, 150],
    [4, 8, 12],
    [2.5, 3.2, 3.5, 3.4, 3.0, 3.0, 3.8, 4.2, 4.0, 3.5, 3.3, 4.1, 4.6, 4.4, 3.9]
  );
  const prop = new OceanPropagator(lm, { stages: 8, subsectors: 20, headings: 30 });
  assert.throws(
    () =>
      prop.computeRoute({
        start: [0, 0.5],
        end: [2, 0.5],
        departureTime: t0,
        vessel,
        polar,
        wind: banded,
        modePolicy: 'sail_max',
        sailThreshMs: 0,
        maxWindMs: 15,
        vias: [{ lon: 0.4, lat: 0.5, radiusM: 5000, auto: true, name: 'the band' }],
      }),
    (err: Error) => {
      assert.ok(err instanceof ViasNotCrossedError, `${err.name}: ${err.message}`);
      assert.match(err.message, /deepest branch crossed 0/);
      assert.match(err.message, /next via at the band/);
      return true;
    }
  );
});
