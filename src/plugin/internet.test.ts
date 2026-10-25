/**
 * The internet state gate (internet.ts): which signalk-internet states hold background downloads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTERNET_PLUGIN_ID, INTERNET_STATE_PATH, InternetGate, internetHold } from './internet';

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

function gateApp(plugins: { id: string; enabled: boolean }[] | null, state: { value: unknown }) {
  return {
    getSelfPath: (p: string) => (p === INTERNET_STATE_PATH && state.value !== undefined ? { value: state.value } : undefined),
    getFeatures: plugins === null ? undefined : async () => ({ plugins }),
  };
}

test('InternetGate: the state holds only while signalk-internet is enabled; a value it left behind holds nothing', async () => {
  const state = { value: 'metered' as unknown };
  const on = new InternetGate(gateApp([{ id: INTERNET_PLUGIN_ID, enabled: true }], state));
  assert.match((await on.holdNow()) ?? '', /metered/);
  assert.equal(on.active, true);
  const off = new InternetGate(gateApp([{ id: INTERNET_PLUGIN_ID, enabled: false }], state));
  assert.equal(await off.holdNow(), null, 'disabled: the stale value is ignored');
  assert.equal(off.active, false);
  const none = new InternetGate(gateApp([], state));
  assert.equal(await none.holdNow(), null);
  const oldServer = new InternetGate(gateApp(null, state));
  assert.equal(await oldServer.holdNow(), null, 'no getFeatures: as without the plugin');
});

test('InternetGate.settle: waits for the first state while signalk-internet is enabled; returns at once without it', async () => {
  const state = { value: undefined as unknown };
  const none = new InternetGate(gateApp([], state));
  const t0 = Date.now();
  assert.equal(await none.settle(() => true, 1000, 10), true);
  assert.ok(Date.now() - t0 < 100, 'no wait without the plugin');

  const on = new InternetGate(gateApp([{ id: INTERNET_PLUGIN_ID, enabled: true }], state));
  const settled = on.settle(() => true, 5000, 10);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(on.settling, true);
  state.value = 'metered';
  assert.equal(await settled, true);
  assert.equal(on.settling, false);
  assert.match(on.hold() ?? '', /metered/, 'the first round is held');

  const silent = new InternetGate(gateApp([{ id: INTERNET_PLUGIN_ID, enabled: true }], { value: undefined }));
  assert.equal(await silent.settle(() => true, 50, 10), true, 'a plugin that never publishes delays the start at most waitMs');
  let current = true;
  const stopped = silent.settle(() => current, 5000, 10);
  current = false;
  assert.equal(await stopped, false);
});

test('InternetGate.settle: one wait serves every caller; a later caller does not wait again', async () => {
  const silent = new InternetGate(gateApp([{ id: INTERNET_PLUGIN_ID, enabled: true }], { value: undefined }));
  const t0 = Date.now();
  const [a, b] = await Promise.all([silent.settle(() => true, 100, 10), silent.settle(() => true, 100, 10)]);
  assert.deepEqual([a, b], [true, true]);
  const t1 = Date.now();
  assert.ok(t1 - t0 < 300, 'the two callers shared one wait');
  assert.equal(await silent.settle(() => true, 100, 10), true);
  assert.ok(Date.now() - t1 < 50, 'after the first wait, at once');
});

test('InternetGate.reset: the next start waits for a first state again', async () => {
  const plugins = [{ id: INTERNET_PLUGIN_ID, enabled: false }];
  const gate = new InternetGate(gateApp(plugins, { value: undefined }));
  assert.equal(await gate.settle(() => true, 1000, 10), true, 'without signalk-internet: at once');
  plugins[0].enabled = true;
  gate.reset();
  const t0 = Date.now();
  await gate.settle(() => true, 100, 10);
  assert.ok(Date.now() - t0 >= 90, 'enabled since: the new start waits for its first state');
});

test('InternetGate.reset: a lookup from before the reset does not speak for the new start', async () => {
  const answers: ((plugins: { id: string; enabled: boolean }[]) => void)[] = [];
  const state = { value: undefined as unknown };
  const gate = new InternetGate({
    getSelfPath: (p: string) => (p === INTERNET_STATE_PATH && state.value !== undefined ? { value: state.value } : undefined),
    getFeatures: () => new Promise(r => answers.push(plugins => r({ plugins }))),
  });
  const first = gate.settle(() => false, 1000, 10);
  assert.equal(gate.pending, true, 'pending from the start of the lookup');
  gate.reset();
  const second = gate.settle(() => true, 100, 10);
  assert.equal(answers.length, 2, 'the new start asks again instead of joining the old lookup');
  answers[0]([]); // the stopped start's answer: not enabled
  answers[1]([{ id: INTERNET_PLUGIN_ID, enabled: true }]);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(gate.active, true, "the old answer did not overwrite the new start's");
  assert.equal(gate.settling, true, 'the new start waits for the first state');
  state.value = 'metered';
  assert.equal(await second, true);
  assert.equal(await first, false);
  assert.equal(gate.pending, false);
  assert.match(gate.hold() ?? '', /metered/);
});

test('InternetGate.watch: called when the state changes, also before the plugin lookup has answered; not for the same state again', async () => {
  const state = { value: 'online' as unknown };
  const listeners: ((v: unknown) => void)[] = [];
  const stream = {
    getSelfStream: (p: string) => {
      assert.equal(p, INTERNET_STATE_PATH);
      return {
        onValue: (cb: (v: unknown) => void) => {
          listeners.push(cb);
          return () => listeners.splice(listeners.indexOf(cb), 1);
        },
      };
    },
  };
  const publish = (v: unknown): void => {
    state.value = v;
    for (const l of [...listeners]) l(v);
  };
  state.value = 'metered';
  const gate = new InternetGate({ ...gateApp([{ id: INTERNET_PLUGIN_ID, enabled: true }], state), streambundle: stream });
  let changes = 0;
  // Watched before the lookup (index.ts start), while the state is already metered.
  const unwatch = gate.watch(() => changes++);
  await gate.check();
  publish('online');
  assert.equal(changes, 1, 'metered to online counts');
  changes = 0;
  publish('online');
  assert.equal(changes, 0, 'the same state again');
  publish('metered');
  publish('metered');
  assert.equal(changes, 1, 'starts holding');
  publish('offline');
  assert.equal(changes, 2, 'another reason');
  publish('online');
  assert.equal(changes, 3, 'clears');
  unwatch();
  assert.equal(listeners.length, 0);
  assert.doesNotThrow(() => new InternetGate(gateApp([], state)).watch(() => undefined)(), 'no stream bundle: nothing to watch');
});
