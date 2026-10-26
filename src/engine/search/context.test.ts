/**
 * refuseDeadEnd's choice of reason, from what the last try counted (the wording is refusal.test.ts's).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WindSource } from '../environment';
import { RouteRefused } from '../refusal';
import { refuseDeadEnd } from './context';
import type { Candidate, SearchContext, TryStats } from './types';

const T0 = Date.UTC(2026, 9, 26, 12);
const H = 3600_000;

/** 20 m/s everywhere, all the time. */
const windy: WindSource = {
  at: () => [20, 270],
  atMany: () => {
    throw new Error('unused');
  },
  hasWaves: false,
  wavesAt: () => null,
};

/** A candidate of the front, `h` hours out. */
function cand(lon: number, lat: number, h: number): Candidate {
  return {
    lon,
    lat,
    timeMs: T0 + h * H,
    elapsedS: h * 3600,
    costS: h * 3600,
    parentIdx: 0,
    sogMs: 3,
    cogDeg: 90,
    mode: 'sailing',
    sailingS: h * 3600,
    motoringS: 0,
    viaCount: 0,
    viaIdxs: [],
  };
}

/** The parts of a search refuseDeadEnd reads; the counts of the last try as given. */
function ctx(counts: Partial<TryStats>, forecastEndMs?: number): SearchContext {
  return {
    args: { start: [-71, 41], end: [-70, 41], departureTime: new Date(T0), vessel: {} as never, maxWindMs: 15, forecastEndMs },
    wind: windy,
    lastTry: { tried: 0, land: 0, limited: 0, noGo: 0, stuck: 0, latestMs: 0, ...counts },
    goals: [{ lon: -70, lat: 41, radiusM: 0 }],
    sLon: -71,
    sLat: 41,
    startViaCount: 0,
    budget: { budgetDistM: 0, dtS: 0, deltaD: 0, candStepM: 2000 },
    cruise: 3,
  } as unknown as SearchContext;
}

function refusal(c: SearchContext, stuck: Candidate[]): RouteRefused['refusal'] {
  const e = refuseDeadEnd(c, stuck);
  assert.ok(e instanceof RouteRefused);
  return e.refusal;
}

test('refuseDeadEnd: every move on land is the coast, at the candidate', () => {
  const c = cand(-70.5, 41.1, 3);
  const r = refusal(ctx({ tried: 40, land: 40 }), [c]);
  assert.equal(r.kind, 'coast');
  assert.deepEqual(r.at, { lon: c.lon, lat: c.lat });
  assert.equal(r.atMs, c.timeMs);
});

test('refuseDeadEnd: land and dead upwind together are mixed, the reasons in order, at the one candidate', () => {
  const c = cand(-70.5, 41.1, 3);
  const r = refusal(ctx({ tried: 40, land: 25, noGo: 15 }), [c]);
  assert.equal(r.kind, 'mixed');
  assert.ok(r.kind === 'mixed');
  assert.deepEqual(r.reasons, ['land', 'no_go']);
  assert.deepEqual(r.at, { lon: c.lon, lat: c.lat });
});

test('refuseDeadEnd: several candidates stopped with another cause are mixed at the front, at its latest time', () => {
  const a = cand(-70.6, 41.1, 3);
  const b = cand(-70.5, 41.0, 5);
  const r = refusal(ctx({ tried: 40, stuck: 10, land: 30 }), [a, b]);
  assert.equal(r.kind, 'mixed');
  assert.ok(r.kind === 'mixed');
  assert.equal(r.at, 'front');
  assert.equal(r.atMs, b.timeMs);
  assert.deepEqual(r.reasons, ['land', 'stopped']);
});

test('refuseDeadEnd: several candidates stopped and nothing else is stopped, at the first candidate', () => {
  const a = cand(-70.6, 41.1, 3);
  const b = cand(-70.5, 41.0, 5);
  const r = refusal(ctx({ tried: 40, stuck: 40 }), [a, b]);
  assert.equal(r.kind, 'stopped');
  assert.deepEqual(r.at, { lon: a.lon, lat: a.lat });
  assert.equal(r.atMs, a.timeMs);
});

test('refuseDeadEnd: the limit tied with another cause is over the limit; fewer than another is mixed', () => {
  const c = cand(-70.5, 41.1, 3);
  const tied = refusal(ctx({ tried: 40, limited: 20, land: 20 }), [c]);
  assert.equal(tied.kind, 'over_limit');
  assert.ok(tied.kind === 'over_limit');
  assert.deepEqual(tied.wind, { seen: 20, limit: 15 });
  assert.equal(tied.easesMs, null, 'the wind never eases here');
  const fewer = refusal(ctx({ tried: 40, limited: 10, land: 30 }), [c]);
  assert.equal(fewer.kind, 'mixed');
  assert.ok(fewer.kind === 'mixed');
  assert.deepEqual(fewer.reasons, ['land', 'limit']);
});

test('refuseDeadEnd: with no candidate past the start, the refusal is at the start', () => {
  const r = refusal(ctx({ tried: 40, land: 40 }), []);
  assert.equal(r.kind, 'coast');
  assert.equal(r.at, null);
  assert.equal(r.atMs, T0);
  const limited = refusal(ctx({ tried: 40, limited: 40 }), []);
  assert.equal(limited.kind, 'over_limit');
  assert.equal(limited.at, null);
});

test('refuseDeadEnd: over the limit past the forecast end, it stays over to the end, as far as the forecast goes', () => {
  // The candidate is 5 h out, the forecast ends 2 h out: the search went on past it on the last step held.
  const end = T0 + 2 * H;
  const r = refusal(ctx({ tried: 40, limited: 40 }, end), [cand(-70.5, 41.1, 5)]);
  assert.equal(r.kind, 'over_limit');
  assert.ok(r.kind === 'over_limit');
  assert.equal(r.untilMs, end);
  assert.equal(r.untilForecastEnd, true);
  assert.equal(r.easesMs, null);
});
