/**
 * A newer CMEMS SMOC or sea-level run that Copernicus Marine is still writing (its STAC record marks the update in
 * progress): the run in use stays, and the source reports the newer one as `pending` (status, freshness), with a
 * check reason that says so; a round that cannot ask the store leaves it as it was, and it clears once the update is
 * written. Before, the reason was built from the run kept, which is settled, so it was empty (brain, 2026-10-29).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SmocClient } from '../../currents/smoc';
import { URLS, makeMock } from '../../currents/smoc.mock.test';
import { CurrentStack } from '../../currents/stack';
import { HOUR_S } from '../../geo/units';
import { SeaLevelClient } from '../../tides/sealevel';
import { URLS as TIDE_URLS, mockFetch as tideFetch } from '../../tides/sealevel.mock.test';
import type { EcmwfClient } from '../../data/ecmwf';
import type { ResolvedConfig } from '../config';
import { refreshSmoc } from './currents';
import { refreshTides } from './tides';
import type { WorkerState } from './state';

function state(cacheRoot: string, config: unknown): WorkerState {
  return {
    role: 'data',
    cancelFlag: new Int32Array(new SharedArrayBuffer(4)),
    send: () => undefined,
    log: () => undefined,
    config: config as ResolvedConfig,
    client: {} as EcmwfClient,
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
    // No position: nothing resident is loaded, only the store is asked.
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
    currentsUnread: [],
    decodeAbort: null,
  };
}

const PENDING_REASON =
  /^a newer run appeared in the store .+ and Copernicus Marine is still writing it; the previous run stays in use until it is finished$/;

test('SMOC: a newer run still being written is kept as pending with its reason, left alone offline, cleared once written', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-pending-'));
  try {
    const mock = makeMock();
    const st = state(dir, { currents: { smocEnabled: true, smocStepS: 3 * HOUR_S, smocHorizonS: 24 * HOUR_S, smocHalfWidthDeg: 10 } });
    st.smocClient = new SmocClient({ cacheDir: dir, urls: URLS, fetchImpl: mock.fetch, sleepImpl: async () => undefined });
    await refreshSmoc(st);
    const kept = st.smoc;
    assert.ok(kept, 'a run is in use');
    assert.equal(kept.status().pending, null);

    // Copernicus starts its update: the store says so, and the run in use stays.
    mock.stacUpdating = true;
    await refreshSmoc(st);
    assert.equal(st.smoc, kept, 'the run in use stays');
    assert.deepEqual(kept.status().pending, { run: kept.run.key, appeared_at: kept.run.metadataModified });
    assert.equal(st.checks.smoc?.outcome, 'newest');
    assert.match(st.checks.smoc?.reason ?? '', PENDING_REASON);

    // A round that could not ask the store knows nothing new: the pending run stays reported.
    await refreshSmoc(st, 'skipped: no internet connection');
    assert.ok(kept.status().pending, 'left as it was');

    // The update is written: nothing is pending, and the check says nothing more.
    mock.stacUpdating = false;
    await refreshSmoc(st);
    assert.equal(st.smoc?.status().pending, null);
    assert.equal(st.checks.smoc?.reason, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tides: a newer run still being written is kept as pending with its reason, and cleared once written', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-pending-'));
  try {
    const store = tideFetch(new Map());
    let updating = false;
    // The mock's STAC record, with the update marked in progress while `updating`.
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith('dataset.stac.json') && updating
        ? Promise.resolve(
            new Response(
              JSON.stringify({
                properties: { admp_updated_data: '2026-09-28T10:00:00Z', admp_updating_start_date: '2026-09-28T08:00:00Z' },
              }),
              { status: 200 }
            )
          )
        : store(input, init)) as typeof fetch;
    const st = state(dir, { tides: { enabled: true, halfWidthDeg: 5, horizonS: 24 * HOUR_S } });
    st.seaLevelClient = new SeaLevelClient({ cacheDir: dir, urls: TIDE_URLS, fetchImpl, sleepImpl: async () => undefined });
    await refreshTides(st);
    const kept = st.tides;
    assert.ok(kept, 'a run is in use');
    assert.equal(kept.status().pending, null);

    updating = true;
    await refreshTides(st);
    assert.equal(st.tides, kept, 'the run in use stays');
    assert.deepEqual(kept.status().pending, { run: kept.run.key, appeared_at: kept.run.metadataModified });
    assert.equal(st.checks.tides?.outcome, 'newest');
    assert.match(st.checks.tides?.reason ?? '', PENDING_REASON);

    updating = false;
    await refreshTides(st);
    assert.equal(st.tides?.status().pending, null);
    assert.equal(st.checks.tides?.reason, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
