/**
 * signalk-internet's state (internet.ts): which states hold background downloads, and following it with one
 * subscription (no lookups, no waits, no timers).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTERNET_STATE_PATH, InternetState, internetHold, type InternetApp } from './internet';

test('metered, offline and captive hold background downloads, with the state in the reason', () => {
  for (const state of ['metered', 'offline', 'captive']) {
    const why = internetHold(state);
    assert.ok(why?.includes(state), `${state}: ${why}`);
  }
});

test('online, any other value or no value: downloads run as before', () => {
  for (const value of ['online', 'something-new', null, undefined, 3]) assert.equal(internetHold(value), null, String(value));
});

/**
 * A subscription manager as Signal K's: `subscribe` replays the cached value at once (handleSubscribeRow), `push`
 * delivers a delta to the live subscriptions, an unsubscribe ends one.
 */
function fakeServer(cached?: unknown) {
  const live = new Set<(delta: unknown) => void>();
  const subscriptions: { context: string; subscribe: { path: string; policy: string }[] }[] = [];
  const delta = (value: unknown) => ({ context: 'vessels.self', updates: [{ values: [{ path: INTERNET_STATE_PATH, value }] }] });
  const app: InternetApp = {
    subscriptionmanager: {
      subscribe: (subscription, unsubscribes, _onError, onDelta) => {
        subscriptions.push(subscription);
        const cb = onDelta as (d: unknown) => void;
        live.add(cb);
        unsubscribes.push(() => live.delete(cb));
        if (cached !== undefined) onDelta(delta(cached));
      },
    },
  };
  return { app, subscriptions, live, push: (value: unknown) => [...live].forEach(cb => cb(delta(value))) };
}

test('one subscription to the state at start, none after stop', () => {
  const server = fakeServer();
  const state = new InternetState(server.app);
  state.start();
  assert.deepEqual(server.subscriptions, [{ context: 'vessels.self', subscribe: [{ path: INTERNET_STATE_PATH, policy: 'instant' }] }]);
  assert.equal(server.live.size, 1);
  state.start();
  assert.equal(server.live.size, 1, 'a second start replaces the first subscription');
  state.stop();
  assert.equal(server.live.size, 0);
});

test('the value the server replays at subscribe time holds at once: a start beside a running signalk-internet knows it', () => {
  const state = new InternetState(fakeServer('metered').app);
  assert.equal(state.hold(), null, 'before start: nothing');
  state.start();
  assert.match(state.hold() ?? '', /metered/);
  state.stop();
  assert.equal(state.hold(), null, 'forgotten at stop');
});

test('without signalk-internet nothing is delivered: nothing holds, nothing changes', () => {
  const server = fakeServer();
  const state = new InternetState(server.app);
  let changes = 0;
  state.onChange(() => changes++);
  state.start();
  assert.equal(state.hold(), null);
  assert.equal(changes, 0);
  // A server without a subscription manager: as without the plugin.
  const bare = new InternetState({});
  assert.doesNotThrow(() => bare.start());
  assert.equal(bare.hold(), null);
});

test('onChange fires when the hold changes, not for the same state again; null (signalk-internet stopped) clears it', () => {
  const server = fakeServer();
  const state = new InternetState(server.app);
  const seen: (string | null)[] = [];
  state.onChange(() => seen.push(state.hold()));
  state.start();
  server.push('online');
  server.push('metered');
  server.push('metered');
  server.push('offline');
  server.push(null);
  assert.equal(seen.length, 3, JSON.stringify(seen));
  assert.match(seen[0] ?? '', /metered/);
  assert.match(seen[1] ?? '', /offline/);
  assert.equal(seen[2], null);
});

test('a listener that throws does not keep the others from hearing the change', () => {
  const server = fakeServer();
  const logged: string[] = [];
  const state = new InternetState(server.app, m => logged.push(m));
  let heard = false;
  state.onChange(() => {
    throw new Error('boom');
  });
  state.onChange(() => (heard = true));
  state.start();
  server.push('metered');
  assert.equal(heard, true);
  assert.match(logged.join('\n'), /boom/);
});

test('whenClear resolves at once when nothing holds, when the state clears, or when its signal aborts', async () => {
  const server = fakeServer('metered');
  const state = new InternetState(server.app);
  const ctrl = new AbortController();
  await state.whenClear(ctrl.signal); // before start: nothing holds
  state.start();
  let cleared = false;
  const waiting = state.whenClear(ctrl.signal).then(() => (cleared = true));
  await new Promise(r => setImmediate(r));
  assert.equal(cleared, false, 'held: still waiting');
  server.push('offline');
  await new Promise(r => setImmediate(r));
  assert.equal(cleared, false, 'another holding state: still waiting');
  server.push('online');
  await waiting;
  server.push('metered');
  const stop = new AbortController();
  const aborted = state.whenClear(stop.signal);
  stop.abort();
  await aborted;
});
