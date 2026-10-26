/**
 * The coastline download at start (coastline.ts) while the internet state holds background downloads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Coastline } from './coastline';
import { INTERNET_STATE_PATH, InternetState } from './internet';

/** signalk-internet's state as the plugin follows it (internet.ts); `set` delivers a new value. */
function internetState(initial?: string): { state: InternetState; set: (value: unknown) => void } {
  let push: (value: unknown) => void = () => undefined;
  const state = new InternetState({
    subscriptionmanager: {
      subscribe: (_subscription, _unsubscribes, _onError, onDelta) => {
        push = value => onDelta({ updates: [{ values: [{ path: INTERNET_STATE_PATH, value }] }] });
        if (initial !== undefined) push(initial);
      },
    },
  });
  state.start();
  return { state, set: value => push(value) };
}

/** A Coastline whose downloads are under the test's control: each waits until settled or aborted (then null). */
class TestCoastline extends Coastline {
  readonly fetches: { signal: AbortSignal; settle: (shp: string | null) => void }[] = [];
  override fetch(_dataDir: string, signal: AbortSignal): Promise<string | null> {
    return new Promise(resolve => {
      this.fetches.push({ signal, settle: resolve });
      signal.addEventListener('abort', () => resolve(null), { once: true });
    });
  }
}

const tick = (): Promise<void> => new Promise(r => setImmediate(r));

function setup(initial?: string) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-coast-'));
  const statuses: string[] = [];
  const logs: string[] = [];
  const app = { setPluginStatus: (s: string) => statuses.push(s), setPluginError: () => undefined, getDataDirPath: () => dataDir };
  const internet = internetState(initial);
  const coast = new TestCoastline(app, m => logs.push(m), internet.state);
  return { dataDir, statuses, logs, internet, coast, done: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

test('a held start waits without downloading; Download pressed starts it anyway', async () => {
  const t = setup('metered');
  try {
    const done = t.coast.download(t.dataDir, () => true);
    await tick();
    assert.equal(t.statuses.length, 1);
    assert.match(t.statuses[0], /waits, the internet connection is metered/);
    assert.match(t.coast.held ?? '', /metered/, 'the reason the status answers while starting');
    assert.equal(t.coast.fetches.length, 0, 'nothing downloads while held');
    t.coast.requestDownload();
    await tick();
    assert.equal(t.coast.fetches.length, 1, 'the press starts the download');
    t.coast.fetches[0].settle('/data/gshhg.shp');
    assert.equal(await done, true);
    assert.equal(t.coast.autoPath, '/data/gshhg.shp');
  } finally {
    t.coast.abort();
    t.done();
  }
});

test('a stop while held ends the start at once', async () => {
  const t = setup('metered');
  try {
    const done = t.coast.download(t.dataDir, () => true);
    await tick();
    t.coast.abort();
    assert.equal(await done, false);
  } finally {
    t.done();
  }
});

test('a held start downloads as soon as the state clears, with no timer', async () => {
  const t = setup('metered');
  try {
    const done = t.coast.download(t.dataDir, () => true);
    await tick();
    t.internet.set('offline');
    await tick();
    assert.match(t.coast.held ?? '', /offline/, 'another holding state: it goes on waiting');
    assert.equal(t.coast.fetches.length, 0);
    t.internet.set('online');
    await tick();
    assert.equal(t.coast.held, null);
    assert.equal(t.coast.fetches.length, 1, 'online again: the download starts');
    t.coast.fetches[0].settle('/data/gshhg.shp');
    assert.equal(await done, true);
  } finally {
    t.coast.abort();
    t.done();
  }
});

test('a download under way stops when the state starts holding, and starts again when it clears', async () => {
  const t = setup();
  try {
    const done = t.coast.download(t.dataDir, () => true);
    await tick();
    assert.equal(t.coast.fetches.length, 1, 'no state: it downloads at once, as without signalk-internet');
    t.internet.set('metered');
    await tick();
    assert.equal(t.coast.fetches[0].signal.aborted, true, 'the download under way stops');
    assert.match(t.coast.held ?? '', /metered/, 'and the start waits');
    assert.match(t.logs.join('\n'), /the download stops: the internet connection is metered/);
    t.internet.set('online');
    await tick();
    assert.equal(t.coast.fetches.length, 2, 'cleared: it downloads again');
    t.coast.fetches[1].settle('/data/gshhg.shp');
    assert.equal(await done, true);
  } finally {
    t.coast.abort();
    t.done();
  }
});

test('a download the owner pressed is not stopped by the state', async () => {
  const t = setup('metered');
  try {
    const done = t.coast.download(t.dataDir, () => true);
    await tick();
    t.coast.requestDownload();
    await tick();
    t.internet.set('online');
    t.internet.set('offline');
    await tick();
    assert.equal(t.coast.fetches.length, 1);
    assert.equal(t.coast.fetches[0].signal.aborted, false, 'the pressed download goes on');
    t.coast.fetches[0].settle('/data/gshhg.shp');
    assert.equal(await done, true);
  } finally {
    t.coast.abort();
    t.done();
  }
});
