import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PolarDiagram } from './polar';

test('withNoGoFloor zeroes the rows closer to the wind than the floor and recomputes the no-go angle', () => {
  // Library-style rows with small speeds near the wind (the Amel 55 file).
  const p = new PolarDiagram([10, 20, 32, 40, 60, 90], [5, 10], [0.9, 1.2, 1.6, 2.0, 2.8, 3.5, 3.9, 4.5, 4.9, 5.1, 5.2, 5.4]);
  assert.equal(p.noGoFloor(8), 10);
  assert.ok(p.boatSpeed(19, 8) > 0);
  const f = p.withNoGoFloor(30);
  assert.notEqual(f, p);
  assert.equal(f.noGoFloor(8), 32);
  assert.equal(f.boatSpeed(19, 8), 0);
  assert.equal(f.boatSpeed(31, 8), 0);
  assert.ok(f.boatSpeed(32, 8) > 0);
  assert.equal(f.boatSpeed(60, 8), p.boatSpeed(60, 8), 'rows at or beyond the floor are untouched');
  // A row exactly at the floor stays; nothing to change returns the same polar.
  assert.equal(p.withNoGoFloor(10), p);
  assert.equal(p.withNoGoFloor(0), p);
  assert.equal(f.withNoGoFloor(30), f);
});
