import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KTS_TO_MS } from '../geo/geodesy';
import { resolveConfig, routeVessel, type LegacyPluginConfig } from './config';
import {
  defaultSettings, mergeSettings, migrateLegacy, reloadsFor, SETTINGS_SPEC, settingsSchema, SettingsStore, SettingsValidationError,
} from './settings';
import { registerApi, type ApiDeps } from './api';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-settings-'));

// The plugin config this repository's owner actually has (pre-migration shape).
const LEGACY: LegacyPluginConfig & Record<string, unknown> = {
  landShapefiles: '/x/GSHHS_f_L1.shp',
  polarFile: '/x/catalina36.csv',
  vessel: { name: 'Catalina 36', draughtM: 1.0, airDraftM: 16.15, loaM: 10.97, beamM: 3.73, underKeelClearanceM: 2.0, overheadClearanceM: 1.0, motorSpeedKts: 6.0, maxSwhM: 3.0, tackPenaltySeconds: 30 },
  forecast: { horizonHours: 48, refreshMinutes: 60, mirror: 'ecmwf', region: { west: -75, south: 36, east: -65, north: 45 }, keepCycles: 2 } as LegacyPluginConfig['forecast'],
  routing: { stages: 20, subsectors: 30, headings: 30, headingIncrementDeg: 1, sailThresholdKts: 4.9, simStepM: 200, landRasterMaxCells: 25000000, keepJobs: 50 },
  publish: { toResources: true, routeNamePrefix: 'WRP', notifications: true },
  weatherProvider: { enabled: true },
};

test('defaults resolve to the same engine config the plugin config gave before', () => {
  const c = resolveConfig({ landShapefiles: '/a.shp, /b.shp' }, defaultSettings());
  assert.deepEqual(c.landShapefiles, ['/a.shp', '/b.shp']);
  assert.equal(c.forecast.horizonHours, 72);
  assert.equal(c.forecast.refreshMinutes, 60);
  assert.equal(c.forecast.keepCycles, 2);
  assert.equal(c.forecast.extraFields, true);
  assert.equal(c.forecast.mirror, 'ecmwf');
  assert.equal(c.currents.rtofsRegion, 'west_atl');
  assert.equal(c.currents.rtofsHorizonHours, 72);
  assert.equal(c.currents.rtofsStepHours, 3);
  assert.ok(Math.abs(c.routing.sailThreshMs - 4.9 * KTS_TO_MS) < 1e-12);
  assert.ok(Math.abs(c.vessel.motorSpeedMs - 6 * KTS_TO_MS) < 1e-12);
  assert.equal(c.vessel.maxSwh, undefined);
  assert.equal(c.weatherProvider.enabled, true);
  assert.throws(() => resolveConfig({ forecast: { mirror: 'nope' as 'aws' } }, defaultSettings()), /mirror/);
});

test('migration converts the old plugin config to SI settings and ignores region keys', () => {
  const m = migrateLegacy(LEGACY);
  assert.equal(m.values.vessel.name, 'Catalina 36');
  assert.equal(m.values.vessel.draught, 1.0);
  assert.equal(m.values.vessel.airDraft, 16.15);
  assert.equal(m.values.vessel.underKeelClearance, 2.0);
  assert.ok(Math.abs(m.values.vessel.motorSpeed - 6 * 0.514444444) < 1e-6, 'kt → m/s');
  assert.equal(m.values.vessel.maxSwh, 3);
  assert.equal(m.values.forecast.horizon, 48 * 3600, 'h → s');
  assert.equal(m.values.forecast.refreshInterval, 3600, 'min → s');
  assert.ok(Math.abs(m.values.routing.sailThreshold - 4.9 * 0.514444444) < 1e-6, 'kt → m/s');
  assert.equal(m.values.routing.headingIncrement, 1);
  assert.equal(m.values.currents.rtofsRegion, 'west_atl', 'unset → default');
  assert.ok(!('region' in m.values.forecast) && !('regionFromVesselDeg' in m.values.forecast));
  assert.ok(m.migrated.includes('vessel.motorSpeed') && m.migrated.includes('forecast.horizon'));
  assert.deepEqual(m.skipped, []);
  // An invalid legacy value is skipped (default kept), the rest still migrate.
  const bad = migrateLegacy({ forecast: { horizonHours: 500 }, currents: { rtofsRegion: 'mars' }, vessel: { draughtM: 2.2 } });
  assert.equal(bad.values.forecast.horizon, 72 * 3600);
  assert.equal(bad.values.currents.rtofsRegion, 'west_atl');
  assert.equal(bad.values.vessel.draught, 2.2);
  assert.equal(bad.skipped.length, 2);
});

test('partial merge validates with the old ranges and enums, all-or-nothing', () => {
  const base = defaultSettings();
  const r = mergeSettings(base, { vessel: { draught: 2.1 }, routing: { stages: 40 } });
  assert.deepEqual(r.changed.sort(), ['routing.stages', 'vessel.draught']);
  assert.equal(r.values.vessel.draught, 2.1);
  assert.equal(r.values.vessel.beam, base.vessel.beam, 'untouched keys kept');
  assert.equal(base.vessel.draught, 1.8, 'base not mutated');
  // Same value → not reported as changed.
  assert.deepEqual(mergeSettings(r.values, { vessel: { draught: 2.1 } }).changed, []);
  try {
    mergeSettings(base, {
      vessel: { draught: 31, name: 5, bogus: 1 },
      forecast: { horizon: 2 * 3600, refreshInterval: 601, keepCycles: 2.5 },
      currents: { rtofsRegion: 'mars', rtofsStep: 7 * 3600 },
      routing: { headingIncrement: 0.1, sailThreshold: -1 },
      publish: { toResources: 'yes' },
      nope: {},
    });
    assert.fail('should throw');
  } catch (err) {
    assert.ok(err instanceof SettingsValidationError);
    const e = err.errors;
    assert.match(e['vessel.draught'], /\[0, 30\] m/);
    assert.match(e['vessel.name'], /string/);
    assert.match(e['vessel.bogus'], /unknown setting/);
    assert.match(e['forecast.horizon'], /\[10800, 864000\] s/);
    assert.match(e['forecast.refreshInterval'], /multiple of 60/);
    assert.match(e['forecast.keepCycles'], /whole number/);
    assert.match(e['currents.rtofsRegion'], /one of west_atl, west_conus/);
    assert.match(e['currents.rtofsStep'], /\[3600, 21600\]/);
    assert.match(e['routing.headingIncrement'], /\[0.25, 10\]/);
    assert.match(e['routing.sailThreshold'], /\[0, /);
    assert.match(e['publish.toResources'], /true or false/);
    assert.match(e.nope, /unknown settings group/);
  }
  // Nullable: maxSwh can be cleared.
  assert.equal(mergeSettings({ ...base, vessel: { ...base.vessel, maxSwh: 3 } }, { vessel: { maxSwh: null } }).values.vessel.maxSwh, null);
  assert.throws(() => mergeSettings(base, []), SettingsValidationError);
  assert.throws(() => mergeSettings(base, { vessel: { draught: '2' } }), /must be a number/);
});

test('reload kinds per changed key', () => {
  assert.deepEqual([...reloadsFor(['forecast.horizon'])], ['forecast']);
  assert.deepEqual([...reloadsFor(['forecast.extraFields'])], ['forecast']);
  assert.deepEqual([...reloadsFor(['currents.rtofsRegion', 'currents.rtofsEnabled'])], ['currents']);
  assert.deepEqual([...reloadsFor(['vessel.draught', 'routing.stages', 'publish.toResources'])], ['next_job']);
  assert.deepEqual([...reloadsFor(['forecast.refreshInterval'])], ['refresh_timer']);
  assert.deepEqual([...reloadsFor(['routing.keepJobs'])], ['jobs']);
  // Every spec entry has a label, help and SI unit where dimensional.
  for (const s of SETTINGS_SPEC) {
    assert.ok(s.label && s.help, s.key);
    if (s.quantity && !['count'].includes(s.quantity)) assert.ok(s.unit, `${s.key} has a unit`);
  }
  assert.equal(settingsSchema().groups.length, 6);
});

test('SettingsStore: first load migrates and writes settings.json; later loads ignore the old keys', () => {
  const dir = tmp();
  const s = new SettingsStore(dir);
  const r = s.load(LEGACY);
  assert.equal(r.created, true);
  assert.ok(r.migrated.includes('vessel.name'));
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(file.version, 1);
  assert.equal(file.migratedFrom, 'plugin-config');
  assert.equal(file.values.vessel.name, 'Catalina 36');
  // Update persists; a second store reads the file, not the legacy config.
  const u = s.update({ vessel: { draught: 1.2 }, forecast: { horizon: 72 * 3600 } });
  assert.deepEqual(u.changed.sort(), ['forecast.horizon', 'vessel.draught']);
  const s2 = new SettingsStore(dir);
  const r2 = s2.load({ vessel: { draughtM: 9 } });
  assert.equal(r2.created, false);
  assert.equal(s2.values.vessel.draught, 1.2);
  assert.equal(s2.values.forecast.horizon, 72 * 3600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).migratedFrom, 'plugin-config');
  // Invalid update: nothing saved.
  assert.throws(() => s2.update({ vessel: { draught: 1.3, beam: -1 } }), SettingsValidationError);
  const s3 = new SettingsStore(dir);
  s3.load(undefined);
  assert.equal(s3.values.vessel.draught, 1.2);
});

test('SettingsStore: bad stored values fall back per key; unreadable file is kept aside', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { vessel: { draught: 99, beam: 4 }, forecast: { horizon: 'x' } } }));
  const s = new SettingsStore(dir);
  const r = s.load(LEGACY);
  assert.equal(r.created, false);
  assert.equal(s.values.vessel.draught, 1.8);
  assert.equal(s.values.vessel.beam, 4);
  assert.equal(r.problems.length, 2);
  const dir2 = tmp();
  fs.writeFileSync(path.join(dir2, 'settings.json'), '{not json');
  const s2 = new SettingsStore(dir2);
  const r2 = s2.load(LEGACY);
  assert.equal(r2.created, true);
  assert.equal(s2.values.vessel.name, 'Catalina 36');
  assert.ok(fs.readdirSync(dir2).some((f) => f.startsWith('settings.json.corrupt-')));
});

/** Minimal express-like router capturing handlers. */
function fakeRouter(): { router: unknown; call: (method: string, p: string, body?: unknown) => Promise<{ status: number; body: unknown }> } {
  const routes = new Map<string, (req: unknown, res: unknown) => unknown>();
  const reg = (m: string) => (p: string | string[], h: (req: unknown, res: unknown) => unknown) => {
    for (const x of Array.isArray(p) ? p : [p]) routes.set(`${m} ${x}`, h);
  };
  const router = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE') };
  const call = async (method: string, p: string, body?: unknown) => {
    const h = routes.get(`${method} ${p}`);
    if (!h) throw new Error(`no route ${method} ${p}`);
    let status = 200;
    let out: unknown;
    const res = {
      status(c: number) { status = c; return res; },
      json(b: unknown) { out = b; return res; },
      setHeader() { return res; },
    };
    await h({ body, query: {}, params: {} }, res);
    return { status, body: out };
  };
  return { router, call };
}

test('GET/PUT /api/settings: schema + values, partial update, 400 with per-key errors', async () => {
  const dir = tmp();
  const store = new SettingsStore(dir);
  store.load(undefined);
  const applied: string[][] = [];
  const { router, call } = fakeRouter();
  registerApi(router as never, {
    pluginId: 'x', basePath: '/x', publicDir: dir,
    getSettings: () => ({ values: store.values, schema: settingsSchema() }),
    updateSettings: (partial: unknown) => {
      const { values, changed } = store.update(partial);
      applied.push(changed);
      const k = reloadsFor(changed);
      return { values, changed, reloaded: { forecast: k.has('forecast'), currents: k.has('currents'), tides: k.has('tides'), refresh_timer: k.has('refresh_timer'), jobs: k.has('jobs') } };
    },
  } as unknown as ApiDeps);
  const g = await call('GET', '/api/settings');
  assert.equal(g.status, 200);
  const gb = g.body as { values: { vessel: { draught: number } }; schema: { settings: { key: string; unit?: string }[] } };
  assert.equal(gb.values.vessel.draught, 1.8);
  assert.equal(gb.schema.settings.find((s) => s.key === 'vessel.motorSpeed')!.unit, 'm/s');
  const p = await call('PUT', '/api/settings', { forecast: { horizon: 96 * 3600 } });
  assert.equal(p.status, 200);
  const pb = p.body as { values: { forecast: { horizon: number } }; changed: string[]; reloaded: { forecast: boolean } };
  assert.equal(pb.values.forecast.horizon, 96 * 3600);
  assert.deepEqual(pb.changed, ['forecast.horizon']);
  assert.equal(pb.reloaded.forecast, true);
  const bad = await call('PUT', '/api/settings', { vessel: { draught: -1 } });
  assert.equal(bad.status, 400);
  assert.match((bad.body as { errors: Record<string, string> }).errors['vessel.draught'], /\[0, 30\]/);
  assert.equal(store.values.vessel.draught, 1.8);
  assert.deepEqual(applied, [['forecast.horizon']]);
});

test('per-route vessel values override the settings; omitted ones come from the settings', () => {
  const m = migrateLegacy(LEGACY);
  const cfg = resolveConfig({ landShapefiles: '/a.shp' }, m.values);
  const plain = routeVessel(cfg, undefined);
  assert.equal(plain.draught, 1.0);
  assert.equal(plain.underKeelClearance, 2.0);
  assert.equal(plain.maxSwh, 3);
  const o = routeVessel(cfg, { draught: 1.5, motor_speed_ms: 2.5 });
  assert.equal(o.draught, 1.5);
  assert.equal(o.motorSpeedMs, 2.5);
  assert.equal(o.airDraft, 16.15, 'not overridden → setting, not the 16 m default');
  assert.equal(o.underKeelClearance, 2.0);
  assert.equal(o.name, 'Catalina 36');
});

test('CMEMS SMOC settings: defaults in SI, 1 h or 3 h step only, changes reload currents', () => {
  const d = defaultSettings();
  assert.equal(d.currents.smocEnabled, true);
  assert.equal(d.currents.smocStep, 3 * 3600);
  assert.equal(d.currents.smocHorizon, 72 * 3600);
  assert.equal(d.currents.smocHalfWidth, 15);
  const c = resolveConfig({ landShapefiles: '/a.shp' }, d);
  assert.deepEqual([c.currents.smocEnabled, c.currents.smocStepHours, c.currents.smocHorizonHours, c.currents.smocHalfWidthDeg], [true, 3, 72, 15]);
  const ok = mergeSettings(d, { currents: { smocStep: 3600, smocHalfWidth: 20, smocHorizon: 120 * 3600 } });
  assert.deepEqual(ok.changed.sort(), ['currents.smocHalfWidth', 'currents.smocHorizon', 'currents.smocStep']);
  assert.deepEqual([...reloadsFor(ok.changed)], ['currents']);
  try {
    mergeSettings(d, { currents: { smocStep: 7200, smocHalfWidth: 60, smocHorizon: 300 * 3600 } });
    assert.fail('should throw');
  } catch (err) {
    const e = (err as SettingsValidationError).errors;
    assert.match(e['currents.smocStep'], /one of 3600, 10800/);
    assert.match(e['currents.smocHalfWidth'], /\[2, 30\]/);
    assert.match(e['currents.smocHorizon'], /\[21600, 864000\]/);
  }
  const specs = settingsSchema().settings.filter((s) => s.key.startsWith('currents.smoc'));
  assert.deepEqual(specs.map((s) => s.key), ['currents.smocEnabled', 'currents.smocHorizon', 'currents.smocStep', 'currents.smocHalfWidth']);
  assert.deepEqual(SETTINGS_SPEC.find((s) => s.key === 'currents.smocStep')!.oneOf, [3600, 10800]);
});
