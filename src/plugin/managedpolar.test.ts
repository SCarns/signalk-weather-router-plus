import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activePolarId,
  adaptManagedPolar,
  loadManagedPolar,
  managedDiagram,
  selectManagedPolar,
  type PolarProviderApp,
} from './managedpolar';

const table = () => ({
  kind: 'polarTable',
  schemaVersion: '1.0.0',
  name: 'TBD',
  units: { twa: 'rad', tws: 'm/s', boatSpeed: 'm/s' },
  symmetry: { portStarboardSymmetric: true },
  axes: { twa: [0, Math.PI / 4, Math.PI / 2, Math.PI], tws: [5, 10] },
  values: {
    boatSpeedMatrix: [
      [0, 2, 4, 3],
      [0, 4, 6, 5],
    ],
  },
});

test('canonical SI matrix transposes without changing speeds; routing interpolation and no-go math stay intact', () => {
  const doc = table();
  const snapshot = adaptManagedPolar(doc, 'boat', 0.8);
  assert.deepEqual(snapshot.twa, [0, 45, 90, 180]);
  assert.deepEqual(snapshot.tws, [5, 10]);
  assert.deepEqual(snapshot.speeds, [0, 0, 2, 4, 4, 6, 3, 5]);
  assert.deepEqual(doc, table());
  const polar = managedDiagram(snapshot);
  assert.equal(polar.boatSpeed(67.5, 7.5), 4);
  assert.equal(polar.boatSpeed(-67.5, 7.5), 4);
  assert.equal(polar.boatSpeed(30, 7.5), 0);
  assert.equal(polar.scaled(snapshot.performanceFactor).boatSpeed(67.5, 7.5), 3.2);
  assert.equal(polar.scaled(0).boatSpeed(90, 7.5), 0);
  doc.values.boatSpeedMatrix[0][1] = 100;
  assert.equal(polar.boatSpeed(45, 5), 2);
});

test('provider nodes, resource ids and missing performance factor', async () => {
  assert.equal(activePolarId({ value: { href: '/resources/polars/TBD boat' } }), 'TBD boat');
  for (const href of ['/resources/routes/x', 'https://example.com/resources/polars/x', '/resources/polars/a/b'])
    assert.throws(() => activePolarId({ href }), /activePolar/);
  const calls: string[][] = [];
  const app: PolarProviderApp = {
    getSelfPath: path => (path === 'polars.activePolar' ? { value: { href: '/resources/polars/tbd' } } : undefined),
    resourcesApi: {
      getResource: async (type, id) => {
        calls.push([type, id]);
        return table();
      },
    },
  };
  assert.equal((await loadManagedPolar(app)).performanceFactor, 1);
  assert.deepEqual(calls, [['polars', 'tbd']]);
  await assert.rejects(loadManagedPolar({}), /Resources API/);
  await assert.rejects(loadManagedPolar({ ...app, getSelfPath: () => ({ value: null }) }), /No active polar/);
  await assert.rejects(
    loadManagedPolar({
      ...app,
      resourcesApi: {
        getResource: async () => {
          throw new Error('provider stopped');
        },
      },
    }),
    /provider stopped/
  );
});

test('fresh reads pick up same-id table edits and factor changes; previous snapshots remain unchanged', async () => {
  let speed = 2;
  let factor = 0.8;
  const app: PolarProviderApp = {
    getSelfPath: path => ({ value: path === 'polars.activePolar' ? { href: '/resources/polars/tbd' } : factor }),
    resourcesApi: {
      getResource: async () => {
        const doc = table();
        doc.values.boatSpeedMatrix[0][1] = speed;
        return doc;
      },
    },
  };
  const first = await loadManagedPolar(app);
  speed = 3;
  factor = 0.5;
  const second = await loadManagedPolar(app);
  assert.equal(first.speeds[2], 2);
  assert.equal(first.performanceFactor, 0.8);
  assert.equal(second.speeds[2], 3);
  assert.equal(second.performanceFactor, 0.5);
});

test('selection changes during asynchronous fetch reject a stale polar', async () => {
  let id = 'first';
  const app: PolarProviderApp = {
    getSelfPath: path => (path === 'polars.activePolar' ? { href: `/resources/polars/${id}` } : 1),
    resourcesApi: {
      getResource: async () => {
        id = 'second';
        return table();
      },
    },
  };
  await assert.rejects(loadManagedPolar(app), /changed while loading/);
});

test('reject malformed tables and unsupported semantics before routing', () => {
  const bad: unknown[] = [
    null,
    { ...table(), units: { twa: 'deg', tws: 'kn', boatSpeed: 'kn' } },
    { ...table(), symmetry: { portStarboardSymmetric: false } },
    { ...table(), axes: { twa: [0, Math.PI + 0.01], tws: [5] } },
    { ...table(), axes: { twa: [0, 1], tws: [5, 5] } },
    { ...table(), values: { boatSpeedMatrix: [[1, 2]] } },
    {
      ...table(),
      values: {
        boatSpeedMatrix: [
          [0, null, 4, 3],
          [0, 4, 6, 5],
        ],
      },
    },
    {
      ...table(),
      values: {
        boatSpeedMatrix: [
          [0, NaN, 4, 3],
          [0, 4, 6, 5],
        ],
      },
    },
  ];
  for (const doc of bad) assert.throws(() => adaptManagedPolar(doc, 'tbd', 1));
  for (const factor of [-1, 1.1, NaN, '0.8']) assert.throws(() => adaptManagedPolar(table(), 'tbd', factor), /performanceFactor/);
});

test('automatic route selection detects managed polars, falls back, and respects internal overrides', async () => {
  let available = true;
  let loads = 0;
  const app: PolarProviderApp = {
    getSelfPath: key => (key === 'polars.activePolar' && available ? { value: { href: '/resources/polars/tbd' } } : undefined),
    resourcesApi: {
      getResource: async () => {
        loads++;
        return table();
      },
    },
  };
  assert.equal((await selectManagedPolar(app, 'auto'))?.label, 'TBD');
  assert.equal((await selectManagedPolar(app, 'files', 'auto'))?.label, 'TBD');
  assert.equal(await selectManagedPolar(app, 'auto', 'default'), undefined);
  assert.equal(await selectManagedPolar(app, 'signalk', 'internal.csv'), undefined);
  assert.equal(await selectManagedPolar(app, 'files'), undefined);
  assert.equal(loads, 2);
  available = false;
  assert.equal(await selectManagedPolar(app, 'auto'), undefined);
  assert.equal(await selectManagedPolar(app, 'signalk'), undefined);
  await assert.rejects(selectManagedPolar(app, 'auto', 'signalk-active'), /No active polar/);
});
