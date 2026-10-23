/**
 * The internet state gate (internet.ts): which signalk-internet states hold background downloads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTERNET_STATE_PATH, internetHold } from './internet';

const leaf = (value: unknown) => (p: string) =>
  p === INTERNET_STATE_PATH ? { value, $source: 'signalk-internet', timestamp: '' } : undefined;

test('metered, offline and captive hold background downloads, with the state in the reason', () => {
  for (const state of ['metered', 'offline', 'captive']) {
    const why = internetHold(leaf(state));
    assert.ok(why?.includes(state), `${state}: ${why}`);
  }
  assert.match(internetHold(() => 'metered') ?? '', /metered/, 'a bare value is read too');
});

test('online, any other value, no state or no signalk-internet: downloads run as before', () => {
  assert.equal(internetHold(leaf('online')), null);
  assert.equal(internetHold(leaf('something-new')), null);
  assert.equal(internetHold(leaf(null)), null);
  assert.equal(
    internetHold(() => undefined),
    null
  );
  assert.equal(internetHold(undefined), null);
  assert.equal(
    internetHold(() => {
      throw new Error('no self yet');
    }),
    null
  );
});
