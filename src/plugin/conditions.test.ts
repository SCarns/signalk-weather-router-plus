import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beaufort, douglas, feelsLike, heatIndexK, relativeHumidity, roughnessIndex, seaStateBand, SWELL_COEFF } from './conditions';

test('relative humidity is a ratio in 0..1, not a percent', () => {
  // 20 °C air, 10 °C dew point → about 52.5 % by the Magnus form.
  const rh = relativeHumidity(293.15, 283.15);
  assert.ok(rh !== null && Math.abs(rh - 0.526) < 0.005, `got ${rh}`);
  assert.equal(relativeHumidity(293.15, 293.15), 1);
  assert.equal(relativeHumidity(null, 283.15), null);
  // Dew point above air temperature clamps to 1, never above.
  assert.equal(relativeHumidity(283.15, 293.15), 1);
});

test('heat index and feels-like take the humidity ratio', () => {
  // 32 °C at 70 %: NWS heat index about 41 °C.
  const hi = heatIndexK(305.15, 0.7);
  assert.ok(hi !== null && Math.abs(hi - 273.15 - 41) < 1.5, `got ${hi}`);
  // Below the 40 % threshold the index does not apply.
  assert.equal(heatIndexK(305.15, 0.3), null);
  // A ratio must not be mistaken for a percent: 0.7 as "0.7 %" would return null.
  assert.equal(feelsLike(305.15, 1, 0.7).basis, 'heat_index');
  assert.equal(feelsLike(278.15, 5, 0.7).basis, 'wind_chill');
  assert.equal(feelsLike(293.15, 5, 0.7).basis, 'air');
});

test('dimensionless scales stay integer indices', () => {
  assert.equal(beaufort(0), 0);
  assert.equal(beaufort(10.8), 6);
  assert.equal(beaufort(40), 12);
  assert.equal(douglas(0), 0);
  assert.equal(douglas(1.25), 4);
  assert.equal(seaStateBand(151), 'extreme');
});

test('long-period swell is dampened, short-period coastal swell is not', () => {
  // Calm wind and no current: only the swell term contributes.
  const swellOnly = (swh: number, mwp: number) => roughnessIndex(0, 0, 0, 0, swh, mwp, 0).idx;
  // 2.25 m at 5 s (steep coastal wind sea) is not damped: SWELL_COEFF × 2.25².
  const full = SWELL_COEFF * 2.25 * 2.25;
  assert.ok(Math.abs(swellOnly(2.25, 5) - full) < 0.01, `got ${swellOnly(2.25, 5)}`);
  // Periods under 5 s are treated the same as 5 s (no amplification).
  assert.ok(Math.abs(swellOnly(2.25, 3) - full) < 0.01);
  // The same height at a lazy 12 s trade swell is cut to 5/12.
  assert.ok(Math.abs(swellOnly(2.25, 12) - full * (5 / 12)) < 0.01, `got ${swellOnly(2.25, 12)}`);
  assert.ok(swellOnly(2.25, 12) < swellOnly(2.25, 5));
  // Against an opposing current (flowing against the waves) the steepening
  // factor still applies on top of the period dampening.
  const steep = roughnessIndex(0, 1, 0, 0, 2.25, 12, 0).idx;
  assert.ok(steep > swellOnly(2.25, 12), `steepened ${steep} should exceed dampened ${swellOnly(2.25, 12)}`);
});

test('the sea-state index calibration: known seas land in their bands', () => {
  // [wind kn, current m/s against wind and waves, swh m, period s, expected band(s)].
  // Expectations follow the Douglas scale and seamanship (a judgement, not a
  // standard): a moderate wind sea is choppy, not extreme; long swell reads
  // milder than a wind sea of the same height; strong current against the
  // waves makes even a moderate sea rough.
  const KT = 0.514444;
  const cases: [string, number, number, number, number, string[]][] = [
    ['calm, light air', 5, 0, 0.3, 4, ['good', 'slight']],
    ['slight wind sea', 12, 0, 1.0, 5, ['slight']],
    ['moderate wind sea', 15, 0, 2.0, 6.5, ['choppy']],
    ['moderate, upper', 18, 0, 2.4, 6.2, ['choppy']],
    ['rough wind sea', 25, 0, 3.5, 8, ['rough']],
    ['rough, upper', 30, 0, 4.0, 8.5, ['rough', 'extreme']],
    ['very rough', 35, 0, 5.0, 9, ['extreme']],
    ['high', 45, 0, 7.0, 11, ['extreme']],
    ['long ocean swell', 10, 0, 2.5, 13, ['slight', 'choppy']],
    ['big long swell', 12, 0, 4.0, 15, ['choppy', 'rough']],
    ['tide race, light air', 8, 2.0, 0.8, 5, ['rough', 'extreme']],
    ['Gulf Stream against a 2 m sea', 18, 1.7, 2.0, 7, ['rough', 'extreme']],
  ];
  for (const [name, kn, cur, h, T, want] of cases) {
    // Wind from the north, waves from the north, current setting north: against both.
    const band = seaStateBand(roughnessIndex(kn * KT, cur, 0, 0, h, T, 0).idx)!;
    assert.ok(want.includes(band), `${name}: ${band}, expected ${want.join(' or ')}`);
  }
});
