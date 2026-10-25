/**
 * A refresh round held by the internet state (internet.ts) with no forecast on disk yet: the forecast is
 * missing, not failed, so a route waiting for the first forecast is not released (index.ts asks for a round of
 * the owner's for it). An unheld round that cannot reach ECMWF reports the error as before.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CurrentStack } from '../../currents/stack';
import { latestExpectedCycle, type EcmwfClient } from '../../data/ecmwf';
import type { ResolvedConfig } from '../config';
import type { WorkerToMain } from '../protocol';
import { refreshForecast } from './forecast';
import type { WorkerState } from './state';

function state(sent: WorkerToMain[], cacheRoot: string): WorkerState {
  return {
    role: 'data',
    cancelFlag: new Int32Array(new SharedArrayBuffer(4)),
    send: m => sent.push(m),
    log: () => undefined,
    config: { forecast: { horizonS: 72 * 3600, extraFields: false, energyFields: false } } as unknown as ResolvedConfig,
    client: { cycleFullyCached: () => false, cachedCycles: () => [] } as unknown as EcmwfClient,
    rtofsClients: new Map(),
    run: null,
    runInfo: null,
    forecastMemory: { heldBytes: 0, last: null },
    lastDecode: null,
    decodingBlockBytes: null,
    diskBytes: { decoded: 0, grib: 0 },
    overlayLand: null,
    polar: null,
    landCache: null,
    harmonic: [],
    rtofs: [],
    rtofsChoice: null,
    smocClient: null,
    smoc: null,
    vesselPos: null,
    stack: new CurrentStack([]),
    reportedLandBuilds: 0,
    reportedSmocRev: -1,
    cacheRoot,
    regional: new Map(),
    seaLevelClient: null,
    tides: null,
    tidesError: null,
    reportedTidesRev: -1,
    waterGrid: null,
    gridBuilder: null,
    routeWindow: null,
    routeRegional: [],
    cancelledQueries: new Set(),
    checks: {},
    connectivity: { online: null, since: null, lastOkAt: null, reason: null },
    lastOfflineMs: 0,
    internetHold: null,
    backgroundRound: false,
    harmonicErrors: [],
    decodeAbort: null,
  };
}

test('a held round with no forecast yet sends no refresh-error; an offline unheld one does', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-held-'));
  try {
    const sent: WorkerToMain[] = [];
    const metered = 'the internet connection is metered (network.internet.state)';
    await refreshForecast(state(sent, dir), false, `skipped: ${metered}`, () => metered);
    assert.equal(sent.filter(m => m.type === 'refresh-error').length, 0);
    const check = sent.find(m => m.type === 'forecast-check');
    assert.ok(check && check.type === 'forecast-check' && check.check.outcome === 'could-not-check');
    assert.match(check.check.reason ?? '', /metered/);

    const sent2: WorkerToMain[] = [];
    await refreshForecast(state(sent2, dir), false, 'skipped: no internet connection', () => null);
    assert.equal(sent2.filter(m => m.type === 'refresh-error').length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A decode under way that the internet state stops (worker.ts 'internet-hold' aborts st.decodeAbort): skipped, as the
 * sources after it are, not failed. The child is aborted as soon as it is forked; its requests would go to a proxy on
 * a closed port anyway.
 */
/** `stop`: called once the decode has started, before it is aborted (the state turning then); none: no abort by hand. */
async function decodeStopped(held: () => string | null, stop?: () => void): Promise<WorkerToMain[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-held-'));
  const env = { proxy: process.env.HTTPS_PROXY, use: process.env.NODE_USE_ENV_PROXY };
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
  process.env.NODE_USE_ENV_PROXY = '1';
  try {
    const sent: WorkerToMain[] = [];
    const st = state(sent, dir);
    st.config = {
      forecast: { horizonS: 72 * 3600, extraFields: false, energyFields: false, memoryHeadroomBytes: 0, mirror: 'ecmwf' },
    } as unknown as ResolvedConfig;
    st.client = {
      cycleFullyCached: () => false,
      cachedCycles: () => [],
      findLatestCycle: async (horizonS: number) => latestExpectedCycle(new Date(), horizonS),
    } as unknown as EcmwfClient;
    const round = refreshForecast(st, false, null, held);
    if (stop) {
      for (let i = 0; i < 500 && !st.decodeAbort; i++) await new Promise(r => setTimeout(r, 2));
      assert.ok(st.decodeAbort, 'the decode started');
      stop();
      st.decodeAbort.abort();
    }
    // A decode still running after 10 s (one the hold missed) is killed rather than left downloading, then reported.
    const ended = await Promise.race([round.then(() => true), new Promise<false>(r => setTimeout(() => r(false), 10_000))]);
    st.decodeAbort?.abort();
    await round;
    assert.ok(ended, 'the round ended on its own');
    assert.equal(st.decodeAbort, null);
    return sent;
  } finally {
    if (env.proxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = env.proxy;
    if (env.use === undefined) delete process.env.NODE_USE_ENV_PROXY;
    else process.env.NODE_USE_ENV_PROXY = env.use;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a decode the internet state stops is skipped, not failed; one stopped otherwise is still an error', async () => {
  const metered = 'the internet connection is metered (network.internet.state)';
  let holding: string | null = null;
  const sent = await decodeStopped(
    () => holding,
    () => (holding = metered)
  );
  assert.equal(sent.filter(m => m.type === 'refresh-error').length, 0, 'no error for the page');
  const check = sent.find(m => m.type === 'forecast-check');
  assert.ok(check && check.type === 'forecast-check');
  assert.equal(check.check.outcome, 'could-not-check');
  assert.equal(check.check.reason, `skipped: ${metered}`);

  const sent2 = await decodeStopped(
    () => null,
    () => undefined
  );
  assert.equal(sent2.filter(m => m.type === 'refresh-error').length, 1, 'not held: the stop is reported as before');
});

test('a hold that began while the cycle was looked up stops the decode before it downloads', async () => {
  const metered = 'the internet connection is metered (network.internet.state)';
  // The round passed its first look at the state; the hold came while resolveCycle ran, before st.decodeAbort existed.
  const sent = await decodeStopped(() => metered);
  assert.equal(sent.filter(m => m.type === 'refresh-error').length, 0);
  const check = sent.find(m => m.type === 'forecast-check');
  assert.ok(check && check.type === 'forecast-check');
  assert.equal(check.check.reason, `skipped: ${metered}`);
});
