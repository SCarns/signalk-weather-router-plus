/**
 * The data worker's refresh queue (refreshqueue.ts): requests join while one waits, and a refresh runs on the newest
 * position it was sent, not on an older one a settings change queued ahead of it set meanwhile (PR #68 review).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VesselPosition } from '../protocol';
import { refreshQueue } from './refreshqueue';

function harness(): {
  queue: ReturnType<typeof refreshQueue>;
  background: (fn: () => Promise<void>) => void;
  drain: () => Promise<void>;
  pos: () => VesselPosition | null;
  setPos: (p: VesselPosition | null) => void;
  runs: { force: boolean; pos: VesselPosition | null }[];
} {
  let chain: Promise<void> = Promise.resolve();
  let vesselPos: VesselPosition | null = null;
  const runs: { force: boolean; pos: VesselPosition | null }[] = [];
  const background = (fn: () => Promise<void>): void => {
    chain = chain.then(fn);
  };
  const queue = refreshQueue({
    inBackground: background,
    setPosition: p => (vesselPos = p),
    run: async force => {
      runs.push({ force, pos: vesselPos });
    },
  });
  return { queue, background, drain: () => chain, pos: () => vesselPos, setPos: p => (vesselPos = p), runs };
}

const OLD = { lat: 41.6, lon: -70.7 };
const NEW = { lat: -18, lon: 178 };

test('a refresh runs on its own (newest) position, not on the older one a queued settings change set', async () => {
  const h = harness();
  // A settings change is queued first, carrying the position of its time (worker.ts 'config' sets it when it runs).
  h.background(async () => h.setPos(OLD));
  // Then a refresh with the vessel's newer position.
  h.queue({ position: NEW });
  assert.deepEqual(h.pos(), NEW, 'taken at once');
  await h.drain();
  assert.deepEqual(h.runs, [{ force: false, pos: NEW }]);
});

test('requests made while one waits join it: force if either asked, the latest position', async () => {
  const h = harness();
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  h.background(() => gate); // other network work running
  h.queue({ position: OLD });
  h.queue({ force: true, position: NEW });
  h.queue({});
  release();
  await h.drain();
  assert.deepEqual(h.runs, [{ force: true, pos: NEW }]);
  // One asked for after it started is done once more.
  h.queue({ position: OLD });
  await h.drain();
  assert.deepEqual(h.runs[1], { force: false, pos: OLD });
});
