/**
 * The freshness rules (freshness.ts) at fixed times: green until 30 min before the next run is due, orange until
 * 60 min after, then red; each source by its own cadence and publication time.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOUR_S } from '../geo/units';
import {
  arcoFreshness,
  ecmwfFreshness,
  freshnessState,
  harmonicFailure,
  harmonicFreshness,
  regionalFreshness,
  rtofsFreshness,
} from './freshness';

const at = (iso: string): number => Date.parse(iso);

test('freshnessState: green, orange from 30 min before due, red from 60 min after', () => {
  const due = at('2026-10-19T00:27:00Z');
  assert.equal(freshnessState(due - 30 * 60_000 - 1, due), 'green');
  assert.equal(freshnessState(due - 30 * 60_000, due), 'orange');
  assert.equal(freshnessState(due + 60 * 60_000 - 1, due), 'orange');
  assert.equal(freshnessState(due + 60 * 60_000, due), 'red');
});

test('ECMWF: the night of 2026-10-18 on brain (12z in use, 18z due 00:27Z, then 00z due 07:34Z)', () => {
  const c12 = at('2026-10-18T12:00:00Z');
  const f = (iso: string): ReturnType<typeof ecmwfFreshness> => ecmwfFreshness(c12, 110 * HOUR_S, true, at(iso));
  const g = f('2026-10-18T23:00:00Z');
  assert.equal(g.state, 'green');
  assert.deepEqual(g.rows, ['wind', 'waves']);
  assert.equal(g.run, '20261018 12z');
  assert.equal(g.published_at, '2026-10-18T19:34:00.000Z');
  assert.equal(g.next_due_at, '2026-10-19T00:27:00.000Z');
  assert.equal(f('2026-10-18T23:57:00Z').state, 'orange');
  assert.equal(f('2026-10-19T01:26:59Z').state, 'orange');
  assert.equal(f('2026-10-19T01:27:00Z').state, 'red');
  // Still on 12z when 00z is out: red (two runs behind).
  assert.equal(f('2026-10-19T08:00:00Z').state, 'red');
  // No waves in the run: only the wind row.
  assert.deepEqual(ecmwfFreshness(c12, 110 * HOUR_S, false, at('2026-10-18T23:00:00Z')).rows, ['wind']);
});

test('ECMWF: a horizon past 144 h waits for the next 00z/12z run, not 06z/18z', () => {
  const c00 = at('2026-10-19T00:00:00Z');
  const f = ecmwfFreshness(c00, 150 * HOUR_S, true, at('2026-10-19T14:00:00Z'));
  assert.equal(f.next_due_at, '2026-10-19T19:34:00.000Z');
  assert.equal(f.state, 'green');
});

test('ECMWF: nothing loaded is red', () => {
  const f = ecmwfFreshness(null, 110 * HOUR_S, false, at('2026-10-19T08:00:00Z'));
  assert.equal(f.state, 'red');
  assert.equal(f.reason, 'no forecast loaded');
});

test('RTOFS: the next daily run is due by the last file the horizon needs', () => {
  const run = at('2026-10-18T00:00:00Z');
  const h72 = rtofsFreshness('RTOFS-west_atl', run, 72 * HOUR_S, at('2026-10-19T09:00:00Z'));
  assert.equal(h72.published_at, '2026-10-18T09:42:00.000Z');
  assert.equal(h72.next_due_at, '2026-10-19T09:42:00.000Z');
  assert.equal(h72.state, 'green');
  assert.equal(rtofsFreshness('RTOFS-west_atl', run, 72 * HOUR_S, at('2026-10-19T10:42:00Z')).state, 'red');
  assert.equal(rtofsFreshness('RTOFS-west_atl', run, 144 * HOUR_S, at('2026-10-19T09:00:00Z')).next_due_at, '2026-10-19T15:38:00.000Z');
  assert.equal(rtofsFreshness('RTOFS-west_atl', null, 72 * HOUR_S, at('2026-10-19T09:00:00Z')).state, 'red');
});

test('SMOC and sea level: a day after the run appeared in the store', () => {
  const f = arcoFreshness('CMEMS-SMOC', ['currents'], '2026102823', '2026-10-19T08:11:31.000Z', at('2026-10-20T07:00:00Z'));
  assert.equal(f.next_due_at, '2026-10-20T08:11:31.000Z');
  assert.equal(f.state, 'green');
  assert.equal(
    arcoFreshness('CMEMS-SMOC', ['currents'], '2026102823', '2026-10-19T08:11:31.000Z', at('2026-10-20T07:45:00Z')).state,
    'orange'
  );
  assert.equal(
    arcoFreshness('CMEMS-SMOC', ['currents'], '2026102823', '2026-10-19T08:11:31.000Z', at('2026-10-20T09:12:00Z')).state,
    'red'
  );
  const none = arcoFreshness('sea level', ['tides'], null, null, at('2026-10-20T07:00:00Z'));
  assert.equal(none.state, 'red');
  const unknown = arcoFreshness('sea level', ['tides'], '2026102823', null, at('2026-10-20T07:00:00Z'));
  assert.equal(unknown.state, 'red');
  assert.match(unknown.reason ?? '', /no publication time/);
});

test('regional wind: AROME by its measured per-run lag, the other models by the downloader schedule', () => {
  // brain, 2026-10-19 10:13Z: the 03z run in use (published 05:47Z), the 06z not out yet; it is due at 11:36Z
  // (336 min after 06z), not 08:45Z as a flat 2.75 h would have it.
  const f = regionalFreshness('arome-0025', 'arome', '2026101903', at('2026-10-19T10:13:00Z'));
  assert.equal(f.published_at, '2026-10-19T05:47:00.000Z');
  assert.equal(f.next_due_at, '2026-10-19T11:36:00.000Z');
  assert.equal(f.state, 'green');
  assert.equal(regionalFreshness('arome-0025', 'arome', '2026101903', at('2026-10-19T11:06:00Z')).state, 'orange');
  assert.equal(regionalFreshness('arome-0025', 'arome', '2026101903', at('2026-10-19T12:36:00Z')).state, 'red');
  // 06z in use: 09z due 259 min after 09z.
  assert.equal(regionalFreshness('arome-0025', 'arome', '2026101906', at('2026-10-19T12:00:00Z')).next_due_at, '2026-10-19T13:19:00.000Z');
  // GFS: not measured here; the downloader's 6 h cadence and 5.5 h delay.
  assert.equal(regionalFreshness('gfs-0p25', 'gfs', '2026101900', at('2026-10-19T08:00:00Z')).next_due_at, '2026-10-19T11:30:00.000Z');
  assert.equal(regionalFreshness('x', 'unknown', '2026101903', at('2026-10-19T08:00:00Z')).state, 'red');
  assert.equal(regionalFreshness('gfs-0p25', 'gfs', null, at('2026-10-19T08:00:00Z')).state, 'red');
});

test('tidal harmonics: green when loaded, red for a file that failed', () => {
  assert.equal(harmonicFreshness('necofs_gom').state, 'green');
  const bad = harmonicFailure('necofs_gom.npz: bad zip');
  assert.equal(bad.state, 'red');
  assert.equal(bad.source, 'necofs_gom.npz');
  assert.equal(bad.reason, 'bad zip');
});
