import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLegends } from './legends';

test('legends: tide ramp diverges around 0 from −3 to +3 m', () => {
  const L = buildLegends().tide;
  assert.equal(L.si_unit, 'm');
  assert.equal(L.quantity, 'sea_level');
  assert.match(L.title, /Tide height/);
  assert.equal(L.stops[0][0], -3);
  assert.equal(L.stops[L.stops.length - 1][0], 3);
  assert.ok(L.stops.some(([v]) => v === 0));
  for (let i = 1; i < L.stops.length; i++) assert.ok(L.stops[i][0] > L.stops[i - 1][0]);
});
