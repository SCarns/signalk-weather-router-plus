import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hoursOfFile, readGridHeader, resolveRegionalRoot, scanRegional } from './regional';

const SAMPLE = path.join(__dirname, '..', '..', 'test-data', 'regional', 'gfs-sample.grb2'); // NOMADS filter, 10°W–10°E, 40–50°N, 0.25°

function fakeRoot(): { root: string; dataDir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-regional-'));
  const root = path.join(base, 'gribs');
  const dataDir = path.join(base, 'plugin-config-data', 'signalk-weather-router-plus');
  fs.mkdirSync(dataDir, { recursive: true });
  // A complete GFS run (two steps) and an older one; an incomplete newer run.
  const gfs = path.join(root, 'gfs-0p25');
  fs.mkdirSync(gfs, { recursive: true });
  for (const f of [
    'gfs-0p25__20261002T06__f000.grb2',
    'gfs-0p25__20261002T12__f003.grb2',
    'gfs-0p25__20261002T12__f006.grb2',
    'gfs-0p25__20261002T18__f000.grb2',
  ])
    fs.copyFileSync(SAMPLE, path.join(gfs, f));
  fs.writeFileSync(path.join(gfs, '.run-20261002T06.complete'), '{"params":{}}');
  fs.writeFileSync(path.join(gfs, '.run-20261002T12.complete'), '{"params":{}}');
  fs.mkdirSync(path.join(gfs, 'archive'));
  // A Météo-France source with no complete run yet.
  fs.mkdirSync(path.join(root, 'arpege-01'));
  fs.writeFileSync(path.join(root, 'arpege-01', 'arpege-01__20261002T12__SP1_000H012H.grb2.part'), '');
  return { root, dataDir };
}

test('regional: file hours from the downloader naming', () => {
  assert.deepEqual(hoursOfFile('gfs-0p25__20261002T12__f003.grb2'), [3]);
  assert.deepEqual(hoursOfFile('arome-0025__20261002T12__SP1_00H06H.grb2'), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(hoursOfFile('arome-001__20261002T12__SP1_07H.grb2'), [7]);
  assert.deepEqual(hoursOfFile('arpege-01__20261002T12__SP1_013H024H.grb2').length, 12);
  assert.deepEqual(hoursOfFile('notes.txt'), []);
});

test('regional: the grid of a real GRIB2 file from its header alone', () => {
  const d = readGridHeader(SAMPLE)!;
  assert.deepEqual([d.south, d.north, d.west, d.east, d.ni, d.nj, d.di], [40, 50, -10, 10, 81, 41, 0.25]);
});

test('regional: root from the setting, the downloader config, or its default; newest complete run only', () => {
  const { root, dataDir } = fakeRoot();
  // The downloader's own config beside ours under plugin-config-data.
  fs.writeFileSync(path.join(dataDir, '..', 'signalk-grib-downloader.json'), JSON.stringify({ configuration: { gribsRoot: root } }));
  assert.deepEqual(resolveRegionalRoot('', dataDir), { root, from: 'downloader config' });
  assert.deepEqual(resolveRegionalRoot(root, dataDir), { root, from: 'setting' });
  assert.equal(resolveRegionalRoot('/no/such/folder', dataDir), null);
  const st = scanRegional('', dataDir);
  assert.equal(st.root, root);
  assert.deepEqual(
    st.sources.map(s => s.name),
    ['arpege-01', 'gfs-0p25'],
    'archive and dot folders are not sources'
  );
  const gfs = st.sources.find(s => s.name === 'gfs-0p25')!;
  assert.equal(gfs.run, '2026-10-02T12:00:00.000Z', 'the newest run with a marker, not the unmarked 18Z');
  assert.deepEqual(gfs.hours, [3, 6]);
  assert.equal(gfs.validFrom, '2026-10-02T15:00:00.000Z');
  assert.equal(gfs.validTo, '2026-10-02T18:00:00.000Z');
  assert.equal(gfs.files.length, 2);
  assert.equal(gfs.problem, null);
  assert.deepEqual([gfs.domain!.west, gfs.domain!.east], [-10, 10]);
  assert.equal(st.sources.find(s => s.name === 'arpege-01')!.problem, 'no complete run yet');
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

test('regional: no downloader gives a note, not an error', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-nodl-'));
  const st = scanRegional('/no/such/folder', dataDir);
  assert.equal(st.root, null);
  assert.match(st.note!, /not found/);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('regional decode: a run becomes a decoded run of 10 m wind once, readable like the ECMWF runs, old runs pruned', async () => {
  const { decodeRegionalRun, pruneRegional } = await import('./regionaldecode');
  const { openDecodedRun } = await import('./decoded');
  const { root, dataDir } = fakeRoot();
  fs.writeFileSync(path.join(dataDir, '..', 'signalk-grib-downloader.json'), JSON.stringify({ configuration: { gribsRoot: root } }));
  const src = scanRegional('', dataDir).sources.find(s => s.name === 'gfs-0p25')!;
  const r = await decodeRegionalRun(src, path.join(root, 'gfs-0p25'), dataDir);
  assert.equal(r.cycle, '2026100212');
  assert.equal(r.reused, false);
  // Both files of the sample are the same step (f003 in the GRIB): written once.
  assert.equal(r.steps, 1);
  const run = openDecodedRun(r.dir).run!;
  assert.deepEqual(run.index.request.params, ['10u', '10v']);
  assert.deepEqual([run.index.grid.lat0, run.index.grid.lon0, run.index.grid.nLat, run.index.grid.nLon], [40, -10, 41, 81]);
  const store = await run.window({ bbox: null, params: ['10u', '10v'] });
  const [ws] = store.at(0, 45, new Date(run.index.steps[0].validMs));
  assert.ok(Number.isFinite(ws) && ws >= 0 && ws < 40, `wind ${ws}`);
  assert.equal(store.covers(0, 45), true);
  assert.equal(store.covers(20, 45), false, 'outside the regional grid');
  assert.equal((await decodeRegionalRun(src, path.join(root, 'gfs-0p25'), dataDir)).reused, true);
  // Pruning keeps the newest runs.
  const base = path.join(dataDir, 'regional', 'gfs-0p25');
  fs.mkdirSync(path.join(base, '2026100100'));
  fs.mkdirSync(path.join(base, '2026100106'));
  pruneRegional(base, 2);
  assert.deepEqual(
    fs
      .readdirSync(base)
      .filter(n => /^\d{10}$/.test(n))
      .sort(),
    ['2026100106', '2026100212']
  );
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});
