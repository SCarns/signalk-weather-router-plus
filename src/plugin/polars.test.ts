import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listPolars, loadPolarCached, polarAngles, polarFromSpecs, polarTable, resolvePolarPath } from './polars';
import { PolarDiagram } from '../vessel/polar';

const CSV =
  'twa/tws,6,10,16\n30,0,0,0\n45,3.5,5.2,6.0\n60,4.2,6.0,6.8\n90,4.8,6.6,7.2\n120,4.6,6.9,7.8\n150,3.9,6.2,7.9\n180,3.2,5.4,7.1\n';

function lib(): { dir: string; def: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polars-'));
  fs.writeFileSync(path.join(dir, 'a_boat.csv'), CSV);
  fs.writeFileSync(path.join(dir, 'b_boat.pol'), CSV.replace(/,/g, '\t').replace('twa/tws', 'TWA\\TWS'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
  fs.mkdirSync(path.join(dir, 'user', 'someone_example_org'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'user', 'legacy.csv'), CSV);
  fs.writeFileSync(path.join(dir, 'user', 'someone_example_org', 'mine.csv'), CSV);
  const def = path.join(dir, 'default_boat.csv');
  fs.writeFileSync(def, CSV);
  return { dir, def };
}

test('listPolars: default first, library files by name, non-polars skipped, default not duplicated', () => {
  const { dir, def } = lib();
  const entries = listPolars({ polarFile: def, polarsDir: dir });
  assert.deepEqual(
    entries.map(e => e.path),
    ['default', 'a_boat.csv', 'b_boat.pol', 'user/legacy.csv', 'user/someone_example_org/mine.csv']
  );
  assert.equal(entries[0].source, 'default');
  assert.equal(entries[1].label, 'a boat');
  assert.equal(entries[3].label, 'user: legacy');
  assert.equal(entries[4].label, 'someone example org: mine');
  assert.deepEqual(listPolars({ polarFile: null, polarsDir: null }), []);
});

test('resolvePolarPath refuses anything outside the library', () => {
  const { dir, def } = lib();
  const cfg = { polarFile: def, polarsDir: dir };
  assert.equal(resolvePolarPath(cfg, undefined), def);
  assert.equal(resolvePolarPath(cfg, 'default'), def);
  assert.equal(fs.realpathSync(resolvePolarPath(cfg, 'a_boat.csv')!), fs.realpathSync(path.join(dir, 'a_boat.csv')));
  assert.equal(
    fs.realpathSync(resolvePolarPath(cfg, 'user/someone_example_org/mine.csv')!),
    fs.realpathSync(path.join(dir, 'user/someone_example_org/mine.csv'))
  );
  for (const bad of [
    '../etc/passwd',
    '/etc/passwd',
    'notes.txt',
    '.hidden.csv',
    'missing.csv',
    'sub/x.csv',
    'user/../a_boat.csv',
    'user/x/y/z.csv',
    'user/.x/a.csv',
  ]) {
    assert.throws(() => resolvePolarPath(cfg, bad), /not found/, bad);
  }
  assert.throws(() => resolvePolarPath({ polarFile: null, polarsDir: null }, 'default'), /no default/);
});

test('polarAngles and polarTable from a loaded polar', () => {
  const { dir } = lib();
  const p = loadPolarCached(path.join(dir, 'a_boat.csv'));
  assert.equal(loadPolarCached(path.join(dir, 'a_boat.csv')), p); // cached
  const a = polarAngles(p);
  assert.equal(a.tws_ms.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.ok(a.beat_deg[i] >= 20 && a.beat_deg[i] < 90);
    assert.ok(a.run_deg[i] >= 90 && a.run_deg[i] < 180);
  }
  // The no-go angle: the tightest table row with any speed (45°: the 30° row is all zeros). The
  // tightest sailable angle setting drops the rows closer than it, as the router does, so at 50° the
  // 45° row goes and the no-go angle is the next row, 60°; the beat angle is never inside it.
  assert.deepEqual(a.nogo_deg, [45, 45, 45]);
  const floored = polarAngles(p, 50);
  assert.deepEqual(floored.nogo_deg, [60, 60, 60]);
  for (let i = 0; i < 3; i++) assert.ok(floored.beat_deg[i] >= 60, `beat ${floored.beat_deg[i]} inside the no-go angle`);
  const t = polarTable(p);
  assert.equal(t.twa_deg.length, 7);
  assert.equal(t.speeds_ms.length, 7);
  assert.equal(t.speeds_ms[0].length, 3);
  // Knots in the file, m/s in the table: 7.9 kt at 150°/16 kt.
  assert.ok(Math.abs(t.speeds_ms[5][2] - 7.9 * 0.514444) < 1e-3);
});

const SPECS = {
  loa_m: 10.97,
  lwl_m: 9.14,
  beam_m: 3.66,
  draft_m: 1.47,
  displacement_kg: 6214,
  ballast_kg: 2722,
  sail_area_upwind_m2: 55.7,
  sail_area_downwind_m2: 0,
  rig_type: 'sloop',
  keel_type: 'fin',
  hull_type: 'monohull',
};

test('polarFromSpecs: writes user/<slug>.csv, lists it, resolves it, 409 without overwrite', () => {
  const { dir } = lib();
  const cfg = { polarFile: null, polarsDir: dir };
  const r = polarFromSpecs(cfg, { name: 'My Catalina 36', specs: SPECS });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.path, 'user/my_catalina_36.csv');
  assert.equal(r.body.label, 'user: my catalina 36');
  assert.deepEqual(r.body.warnings, []);
  const polar = r.body.polar as { path: string; twa_deg: number[]; tws_ms: number[]; speeds_ms: number[][] };
  assert.equal(polar.path, 'user/my_catalina_36.csv');
  assert.equal(polar.twa_deg.length, 22);
  assert.equal(polar.tws_ms.length, 10);
  const text = fs.readFileSync(path.join(dir, 'user', 'my_catalina_36.csv'), 'utf8');
  assert.ok(text.startsWith('my_catalina_36,4.0,6.0,8.0,10.0,12.0,14.0,16.0,20.0,24.0,30.0\r\n0,0.00,'));
  const entry = listPolars(cfg).find(e => e.path === 'user/my_catalina_36.csv');
  assert.ok(entry);
  assert.equal(entry.label, r.body.label);
  assert.equal(resolvePolarPath(cfg, 'user/my_catalina_36.csv'), fs.realpathSync(path.join(dir, 'user', 'my_catalina_36.csv')));
  assert.deepEqual(polarTable(loadPolarCached(resolvePolarPath(cfg, 'user/my_catalina_36.csv') as string)), {
    twa_deg: polar.twa_deg,
    tws_ms: polar.tws_ms,
    speeds_ms: polar.speeds_ms,
  });

  const again = polarFromSpecs(cfg, { name: 'my catalina 36', specs: SPECS });
  assert.equal(again.status, 409);
  const over = polarFromSpecs(cfg, { name: 'my catalina 36', specs: { ...SPECS, sail_area_upwind_m2: 60 }, overwrite: true });
  assert.equal(over.status, 200);
});

test('polarFromSpecs: 400 validation, 400 bad name, 422 multihull, 400 without polarsDir', () => {
  const { dir } = lib();
  const cfg = { polarFile: null, polarsDir: dir };
  const bad = polarFromSpecs(cfg, { name: 'x', specs: { ...SPECS, lwl_m: 11.5 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'LWL 11.5 > LOA 10.97 — swap?');
  // The field and values in SI, for the web app to word in its user's units.
  assert.equal(bad.body.field, 'lwl_m');
  assert.equal(bad.body.value, 11.5);
  assert.deepEqual(bad.body.longer_than, { field: 'loa_m', value: 10.97 });
  const heavy = polarFromSpecs(cfg, { name: 'x', specs: { ...SPECS, displacement_kg: 600_000 } });
  assert.equal(heavy.status, 400);
  assert.equal(heavy.body.field, 'displacement_kg');
  assert.equal(heavy.body.value, 600_000);
  assert.equal(heavy.body.min, 50);
  assert.equal(heavy.body.max, 500_000);
  assert.equal(polarFromSpecs(cfg, { name: '___', specs: SPECS }).status, 400);
  assert.equal(polarFromSpecs(cfg, { name: '', specs: SPECS }).status, 400);
  assert.equal(polarFromSpecs(cfg, { name: 'x'.repeat(61), specs: SPECS }).status, 400);
  assert.equal(polarFromSpecs(cfg, { name: 'x', specs: { ...SPECS, loa_m: 'long' } }).status, 400);
  assert.equal(polarFromSpecs(cfg, { name: 'x', specs: { ...SPECS, rig_type: 'junk' } }).status, 400);
  const cat = polarFromSpecs(cfg, { name: 'cat', specs: { ...SPECS, hull_type: 'catamaran' } });
  assert.equal(cat.status, 422);
  assert.match(String(cat.body.error), /monohulls only; got 'catamaran'/);
  assert.equal(fs.existsSync(path.join(dir, 'user', 'cat.csv')), false);
  assert.equal(polarFromSpecs({ polarFile: null, polarsDir: null }, { name: 'x', specs: SPECS }).status, 400);
});

test('PolarDiagram.scaled multiplies every boat speed and keeps the no-go floor', () => {
  const p = PolarDiagram.parse('twa/tws,6,12\n0,0,0\n40,0,5\n90,6,8\n', ',');
  const s = p.scaled(0.8);
  assert.equal(p.scaled(1), p);
  for (const [twa, tws] of [
    [90, 3.0867],
    [90, 6.1733],
    [60, 5],
  ]) {
    assert.ok(Math.abs(s.boatSpeed(twa, tws) - 0.8 * p.boatSpeed(twa, tws)) < 1e-12);
  }
  assert.equal(s.boatSpeed(40, 3.0867), 0, 'in irons at 6 kn stays in irons');
  assert.equal(s.noGoFloor(3.0867), p.noGoFloor(3.0867));
});

test('bundled library: every shipped polar loads; user polars live in a separate directory', async () => {
  const { BUNDLED_POLARS_DIR, BUNDLED_DEFAULT_POLAR } = await import('./polars');
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polars-user-'));
  const cfg = { polarFile: BUNDLED_DEFAULT_POLAR, polarsDir: BUNDLED_POLARS_DIR, userDir };
  const list = listPolars(cfg);
  assert.equal(list[0].path, 'default');
  const shipped = list.filter(e => e.source === 'library');
  assert.ok(shipped.length >= 700, `bundled polars listed: ${shipped.length}`);
  for (const e of shipped) {
    const file = resolvePolarPath(cfg, e.path) as string;
    const p = PolarDiagram.load(file);
    assert.ok(p.tws.length > 0 && p.twa.length > 0, `${e.path} loads`);
  }
  // A generated polar goes to the user directory, not into the package, and resolves from there.
  const r = polarFromSpecs(cfg, { name: 'Test Boat', specs: SPECS });
  assert.equal(r.status, 200);
  assert.ok(fs.existsSync(path.join(userDir, 'test_boat.csv')));
  assert.ok(!fs.existsSync(path.join(BUNDLED_POLARS_DIR, 'user')));
  assert.equal(resolvePolarPath(cfg, 'user/test_boat.csv'), fs.realpathSync(path.join(userDir, 'test_boat.csv')));
  assert.ok(listPolars(cfg).some(e => e.path === 'user/test_boat.csv'));
  assert.throws(() => resolvePolarPath(cfg, 'user/../catalina36.csv'));
  fs.rmSync(userDir, { recursive: true, force: true });
});

test('a tab polar with an empty cell loads, the cell filled from the rows around it (weather_routing_pi Figaro_1-1.pol)', () => {
  const text = 'TWA\\TWS\t6\t10\n60\t4.0\t6.0\n90\t5.0\t\t\n120\t4.6\t7.0\n';
  const p = PolarDiagram.parse(text, '\t', 'test');
  const kn = (v: number): number => Math.round((v / 0.514444) * 100) / 100;
  assert.equal(kn(p.boatSpeed(90, 10 * 0.514444)), 6.5, 'halfway between 6.0 and 7.0');
  assert.throws(() => PolarDiagram.parse('TWA\\TWS\t6\t10\n60\t4.0\n', '\t', 'test'), /expected 2 boat-speed columns/);
});
