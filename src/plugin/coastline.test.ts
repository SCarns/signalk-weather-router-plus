/**
 * The coastline download at start (coastline.ts) while the internet state holds background downloads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Coastline } from './coastline';

test('a held start waits without downloading; Download pressed starts it anyway', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-coast-'));
  const statuses: string[] = [];
  const app = {
    setPluginStatus: (s: string) => {
      statuses.push(s);
      // Stopped as the download starts: the aborted signal ends it before any request is made.
      if (s.includes('downloading GSHHG')) coast.abort();
    },
    setPluginError: () => undefined,
    getDataDirPath: () => dataDir,
  };
  const coast: Coastline = new Coastline(app, () => undefined, {
    active: true,
    holdNow: async () => 'the internet connection is metered (network.internet.state)',
  });
  try {
    const done = coast.download(dataDir, () => true);
    await new Promise(r => setImmediate(r));
    assert.equal(statuses.length, 1);
    assert.match(statuses[0], /waits, the internet connection is metered/);
    assert.match(coast.held ?? '', /metered/, 'the reason the status answers while starting');
    assert.equal(coast.state.downloading, false, 'nothing downloads while held');
    coast.requestDownload();
    assert.equal(await done, false);
    assert.ok(
      statuses.some(s => s.includes('downloading GSHHG')),
      'the press starts the download'
    );
  } finally {
    coast.abort();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
