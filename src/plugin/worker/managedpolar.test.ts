import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoastTiles } from '../../geo/coasttiles';
import { CurrentStack } from '../../currents/stack';
import { resolveConfig } from '../config';
import { defaultSettings } from '../settings';
import type { WorkerToMain } from '../protocol';
import type { WorkerState } from './state';
import { route } from './route';

// Exercise the worker, not just token classification: motor requests with either
// managed token must finish without a provider, forecast or local polar file.
test('motor routes ignore managed polar tokens and complete without a provider', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-motor-polar-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  CoastTiles.build([], root); // Synthetic open sea, no network or real coastline needed.
  const config = resolveConfig({}, defaultSettings());
  config.landShapefiles = [];
  for (const token of [undefined, 'auto', 'signalk-active']) {
    const messages: WorkerToMain[] = [];
    const st = {
      config,
      client: {},
      cacheRoot: root,
      cancelFlag: new Int32Array(new SharedArrayBuffer(4)),
      send: (m: WorkerToMain) => messages.push(m),
      log: () => {},
      polar: null,
      harmonic: [],
      rtofs: [],
      stack: new CurrentStack([]),
      routeRegional: [],
      forecastMemory: { heldBytes: 0, last: null },
    } as unknown as WorkerState;
    await route(st, 'motor', {
      start: { lat: 0, lon: 0 },
      end: { lat: 0, lon: 0.01 },
      mode: 'motor',
      no_currents: true,
      avoid_areas: false,
      vessel: { polar: token },
    });
    const done = messages.find(m => m.type === 'done');
    assert.ok(done?.type === 'done', JSON.stringify(messages.filter(m => m.type === 'error')));
    assert.equal(done.summary.polar, null);
    assert.equal(done.summary.polar_source, undefined);
    assert.ok(done.summary.motoring_time_s > 0);
    assert.equal(done.summary.sailing_time_s, 0);
  }
});
