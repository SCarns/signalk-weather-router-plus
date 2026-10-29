/**
 * The forecast decode task (forecastdecodetask.ts, run in a child process by the data worker): a decode that loses the
 * connection fails as "no connection" (so the worker reports "could not check", not a failed download) and leaves no
 * unfinished run directory behind.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EcmwfClient } from '../data/ecmwf';
import { DECODED_DIR } from '../data/decoded';
import { isOffline } from '../data/http';
import { runForecastDecodeTask, type ForecastDecodeEvent } from './forecastdecodetask';

test('a decode with no connection fails as offline at once and removes its unfinished directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-decodetask-'));
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }) });
  }) as unknown as typeof fetch;
  const client = new EcmwfClient({ baseUrl: 'https://x', cacheDir: path.join(root, 'ecmwf'), fetchImpl, sleepImpl: async () => undefined });
  const events: ForecastDecodeEvent[] = [];
  await assert.rejects(
    runForecastDecodeTask(
      {
        task: 'forecast-decode',
        cacheRoot: root,
        mirror: 'ecmwf',
        cycle: '2026-10-19T00:00:00.000Z',
        horizonS: 6 * 3600,
        extraAtmParams: [],
      },
      e => events.push(e),
      client
    ),
    (e: unknown) => isOffline(e)
  );
  assert.equal(calls, 1, 'no retries, no other mirror');
  assert.equal(events.filter(e => e.event === 'decode-step').length, 0);
  assert.deepEqual(fs.readdirSync(path.join(root, DECODED_DIR)), [], 'the .tmp-* directory is gone');
  fs.rmSync(root, { recursive: true, force: true });
});
