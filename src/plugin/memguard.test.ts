import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkForecastMemory, forecastBytes, FIELD_STEP_BYTES, availableMemory } from './memguard';

const NOW = new Date('2026-09-28T00:30:00Z'); // 00z cycle: oper stream, 3-hourly to 144 h

test('forecastBytes is steps × fields × one global grid', () => {
  assert.equal(FIELD_STEP_BYTES, 4_152_960);
  assert.equal(forecastBytes(72, false, NOW), 25 * 6 * FIELD_STEP_BYTES);   // 622,944,000
  assert.equal(forecastBytes(72, true, NOW), 25 * 11 * FIELD_STEP_BYTES);   // 1,142,064,000 (matches the measured store)
});

test('check passes with room, refuses and suggests what fits', () => {
  const GB = 1e9;
  const ok = checkForecastMemory(72, true, GB, { bytes: 5 * GB, source: 'test' }, NOW);
  assert.equal(ok.ok, true);
  // 2 GB available, 1 GB headroom: 1.14 GB does not fit; extra fields off (0.62 GB) does.
  const tight = checkForecastMemory(72, true, GB, { bytes: 2 * GB, source: 'test' }, NOW);
  assert.equal(tight.ok, false);
  assert.match(tight.message, /not enough memory/);
  assert.match(tight.message, /turn off the extra fields/);
  // 1.5 GB available: 72 h base (0.62) +1 GB = 1.62 no; 48 h base = 17×6×4.15 = 0.42 GB fits.
  const tighter = checkForecastMemory(72, true, GB, { bytes: 1.5 * GB, source: 'test' }, NOW);
  assert.equal(tighter.ok, false);
  assert.match(tighter.message, /48 h/);
  assert.match(tighter.message, /headroom/);
});

test('availableMemory returns a positive figure and its source', () => {
  const a = availableMemory();
  assert.ok(a.bytes > 0);
  assert.ok(a.source.length > 0);
});

test('parseVmStat sums free, inactive, speculative and purgeable pages', async () => {
  const { parseVmStat } = await import('./memguard');
  const text = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                                3785.\nPages active:                            188296.\nPages inactive:                          187679.\nPages speculative:                          245.\nPages throttled:                              0.\nPages wired down:                        203849.\nPages purgeable:                              2.\n';
  assert.equal(parseVmStat(text), (3785 + 187679 + 245 + 2) * 16384);
  assert.equal(parseVmStat('nonsense'), null);
});
