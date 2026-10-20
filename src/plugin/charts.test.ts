import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChartsProvider } from './charts';
import type { DataStatus, ForecastRunInfo } from './protocol';

const HOUR = 3_600_000;
// The run starts this hour, so its frames run ahead of now whenever the test runs
// (resource() never lets a chart's timeline end before the current hour).
const CYCLE_MS = Math.floor(Date.now() / HOUR) * HOUR;
const PARAMS = ['10u', '10v', 'msl', '2t', 'tprate', 'skt', 'ptype', 'swh', 'mwp', 'mwd'];

/** A provider over a 10-day forecast run (with or without waves), no tides, and currents when asked. */
function provider(params = PARAMS, currents = false): ChartsProvider {
  const run = {
    index: {
      cycle: '2026110200',
      cycleTimeMs: CYCLE_MS,
      request: { horizonHours: 240, params },
      steps: [0, 120, 240].map(h => ({ stepHours: h, validMs: CYCLE_MS + h * HOUR, params })),
    },
  } as unknown as ForecastRunInfo;
  const status = {
    forecast: { hasWaves: params.includes('swh') },
    currents: currents ? [{ name: 'CMEMS-SMOC' }] : [],
  } as unknown as DataStatus;
  return new ChartsProvider({
    app: {},
    pluginId: 'signalk-weather-router-plus',
    basePath: '/plugins/signalk-weather-router-plus',
    dataDir: () => '/nonexistent',
    isStopped: () => false,
    forecastRun: () => run,
    tidesRun: () => null,
    tidesEnabled: () => false,
    dataStatus: () => status,
    log: () => {},
    error: () => {},
  });
}

test('charts: the groups hold only the charts with data, colour layer first, and name its legend', () => {
  const groups = provider().groups();
  const byName = Object.fromEntries(groups.map(g => [g.name.replace(' (Weather Router Plus)', ''), g]));
  assert.deepEqual(byName.Wind.charts, ['wrp-wind-speed', 'wrp-wind-barbs']);
  assert.equal(byName.Wind.legend, 'wind');
  assert.deepEqual(byName.Waves.charts, ['wrp-wave-height', 'wrp-wave-arrows']);
  assert.equal(byName.Waves.legend, 'waves');
  // Isobars have no colour layer, so no legend.
  assert.deepEqual(byName.Pressure.charts, ['wrp-isobars', 'wrp-wind-barbs']);
  assert.equal(byName.Pressure.legend, null);
  // No currents: the currents group is left out, sea temperature keeps its colour layer without the arrows.
  assert.equal(byName.Currents, undefined);
  assert.deepEqual(byName['Sea temperature'].charts, ['wrp-sea-temperature']);
  // No tides either.
  assert.equal(byName.Tide, undefined);
});

test('charts: each chart with data names the freshness rows it is drawn from', () => {
  const rows = provider(PARAMS, true).chartRows();
  assert.deepEqual(rows['wrp-wind-speed'], ['wind']);
  assert.deepEqual(rows['wrp-isobars'], ['wind'], 'the forecast run: the ECMWF entry');
  assert.deepEqual(rows['wrp-wave-height'], ['waves']);
  assert.deepEqual(rows['wrp-current-arrows'], ['currents']);
  assert.deepEqual(rows['wrp-sea-state'], ['wind', 'waves', 'currents']);
  assert.equal(rows['wrp-tide-height'], undefined, 'no tides: not a chart');
  assert.deepEqual(Object.keys(rows).sort(), Object.keys(provider(PARAMS, true).resources()).sort());
});

test('charts: a group whose colour layer has no data is left out, not offered with its glyphs alone', () => {
  // Currents but no tides: the current arrows are there, the tide height is not.
  const byName = Object.fromEntries(
    provider(PARAMS, true)
      .groups()
      .map(g => [g.name.replace(' (Weather Router Plus)', ''), g])
  );
  assert.deepEqual(byName.Currents.charts, ['wrp-current-speed', 'wrp-current-arrows']);
  assert.equal(byName.Tide, undefined);
  assert.deepEqual(byName['Sea temperature'].charts, ['wrp-sea-temperature', 'wrp-current-arrows']);
});

test('charts: a group is left out without its first layer: no Pressure of wind barbs alone (PR #54 review)', () => {
  const byName = Object.fromEntries(
    provider(PARAMS.filter(p => p !== 'msl'))
      .groups()
      .map(g => [g.name.replace(' (Weather Router Plus)', ''), g])
  );
  assert.equal(byName.Pressure, undefined);
  assert.deepEqual(byName.Wind.charts, ['wrp-wind-speed', 'wrp-wind-barbs']);
  // Rain and air temperature keep their colour layer, without the isobars.
  assert.equal(byName.Rain.charts.length, 1);
  assert.equal(byName.Rain.legend, 'precip');
  assert.equal(byName['Air temperature'].charts.length, 1);
});

test('charts: a forecast without waves leaves the wave groups out', () => {
  const names = provider(PARAMS.filter(p => !['swh', 'mwp', 'mwd'].includes(p)))
    .groups()
    .map(g => g.name);
  assert.ok(!names.some(n => n.startsWith('Waves') || n.startsWith('Sea state')), names.join(', '));
  assert.ok(names.some(n => n.startsWith('Wind')));
});

test('charts: time blocks mark the frames as a forecast and name the run for forecast-only layers', () => {
  const charts = provider().resources();
  const wind = charts['wrp-wind-speed'].time as Record<string, unknown>;
  assert.equal(wind.forecast, true);
  assert.equal(wind.issued, new Date(CYCLE_MS).toISOString());
  assert.equal(wind.to, new Date(CYCLE_MS + 240 * HOUR).toISOString());
  // Sea state mixes in the currents: a forecast, but not of one run.
  const seaState = charts['wrp-sea-state'].time as Record<string, unknown>;
  assert.equal(seaState.forecast, true);
  assert.equal('issued' in seaState, false);
});
