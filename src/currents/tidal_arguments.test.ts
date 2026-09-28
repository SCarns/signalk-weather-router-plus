import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DOODSON } from './doodson';
import { isSupportedConstituent, meanLongitudesAstro5, tidalArguments } from './tidal_arguments';

interface ArgumentsRef {
  constituents: string[];
  mjd: number[];
  /** mjd-major: pu[t][c] */
  pu: number[][];
  pf: number[][];
  G: number[][];
  astro5: { s: number[]; h: number[]; p: number[]; n: number[]; pp: number[] };
}

const REF_PATH = path.join(__dirname, '..', '..', 'test-data', 'pytmd_arguments_ref.json');
const ref: ArgumentsRef = JSON.parse(fs.readFileSync(REF_PATH, 'utf8'));

test('reference file has the expected shape', () => {
  assert.equal(ref.constituents.length, 47);
  assert.equal(ref.mjd.length, 153);
  assert.equal(ref.pu.length, ref.mjd.length);
  assert.equal(ref.pu[0].length, ref.constituents.length);
  assert.equal(ref.pf.length, ref.mjd.length);
  assert.equal(ref.G.length, ref.mjd.length);
  for (const key of ['s', 'h', 'p', 'n', 'pp'] as const) {
    assert.equal(ref.astro5[key].length, ref.mjd.length);
  }
});

test('Doodson table has all 479 pyTMD constituents with 7 coefficients each', () => {
  const names = Object.keys(DOODSON);
  assert.equal(names.length, 479);
  for (const name of names) {
    assert.equal(DOODSON[name].length, 7, name);
  }
  // spot checks against pyTMD/data/doodson.json
  assert.deepEqual(DOODSON['m2'], [2, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(DOODSON['k1'], [1, 1, 0, 0, 0, 0, 1]);
  assert.deepEqual(DOODSON['sa'], [0, 0, 1, 0, 0, -1, 0]);
  for (const c of ref.constituents) assert.ok(isSupportedConstituent(c), c);
});

test('meanLongitudesAstro5 matches pyTMD ASTRO5 for every reference epoch (|d| < 1e-9 deg)', () => {
  let worst = 0;
  for (let t = 0; t < ref.mjd.length; t++) {
    const got = meanLongitudesAstro5(ref.mjd[t]);
    for (const key of ['s', 'h', 'p', 'n', 'pp'] as const) {
      const d = Math.abs(got[key] - ref.astro5[key][t]);
      worst = Math.max(worst, d);
      assert.ok(d < 1e-9, `${key} at mjd ${ref.mjd[t]}: got ${got[key]} expected ${ref.astro5[key][t]} (d=${d})`);
      assert.ok(got[key] >= 0 && got[key] < 360, `${key} not normalised: ${got[key]}`);
    }
  }
  console.log(`  astro5 max |d| = ${worst.toExponential(3)} deg`);
});

test('tidalArguments matches pyTMD arguments(..., corrections="FES") for every (mjd, constituent)', () => {
  let worstPu = 0;
  let worstPf = 0;
  let worstG = 0;
  for (let t = 0; t < ref.mjd.length; t++) {
    const { pu, pf, G } = tidalArguments(ref.mjd[t], ref.constituents);
    assert.equal(pu.length, ref.constituents.length);
    for (let i = 0; i < ref.constituents.length; i++) {
      const c = ref.constituents[i];
      const dPu = Math.abs(pu[i] - ref.pu[t][i]);
      const dPf = Math.abs(pf[i] - ref.pf[t][i]);
      const dG = Math.abs(G[i] - ref.G[t][i]);
      worstPu = Math.max(worstPu, dPu);
      worstPf = Math.max(worstPf, dPf);
      worstG = Math.max(worstG, dG);
      assert.ok(dPu < 1e-10, `pu ${c} @ ${ref.mjd[t]}: got ${pu[i]} expected ${ref.pu[t][i]} (d=${dPu})`);
      assert.ok(dPf < 1e-10, `pf ${c} @ ${ref.mjd[t]}: got ${pf[i]} expected ${ref.pf[t][i]} (d=${dPf})`);
      assert.ok(dG < 1e-8, `G ${c} @ ${ref.mjd[t]}: got ${G[i]} expected ${ref.G[t][i]} (d=${dG})`);
    }
  }
  console.log(`  max |d| pu=${worstPu.toExponential(3)} rad, pf=${worstPf.toExponential(3)}, G=${worstG.toExponential(3)} deg`);
});

test('per-constituent calls agree with the batched call (order independence)', () => {
  const mjd = ref.mjd[17];
  const all = tidalArguments(mjd, ref.constituents);
  for (let i = 0; i < ref.constituents.length; i++) {
    const one = tidalArguments(mjd, [ref.constituents[i]]);
    assert.equal(one.pu[0], all.pu[i]);
    assert.equal(one.pf[0], all.pf[i]);
    assert.equal(one.G[0], all.G[i]);
  }
});

test('m2 at MJD 61310.0 (2026-09-27T00:00Z): pu≈0.019970, pf≈0.968808, G≈346.7789', () => {
  const { pu, pf, G } = tidalArguments(61310.0, ['m2']);
  assert.ok(Math.abs(pu[0] - 0.019970) < 1e-6, `pu ${pu[0]}`);
  assert.ok(Math.abs(pf[0] - 0.968808) < 1e-6, `pf ${pf[0]}`);
  assert.ok(Math.abs(G[0] - 346.7789) < 1e-4, `G ${G[0]}`);
});

test('every constituent in the Doodson table evaluates under FES without throwing', () => {
  const names = Object.keys(DOODSON);
  const { pu, pf, G } = tidalArguments(61310.0, names);
  for (let i = 0; i < names.length; i++) {
    assert.ok(Number.isFinite(pu[i]), `pu ${names[i]}`);
    assert.ok(Number.isFinite(pf[i]) && pf[i] > 0, `pf ${names[i]} = ${pf[i]}`);
    assert.ok(Number.isFinite(G[i]), `G ${names[i]}`);
  }
  // constituents without a nodal rule get f = 1, u = 0 (pyTMD's default branch)
  const z0 = names.indexOf('z0');
  assert.equal(pu[z0], 0);
  assert.equal(pf[z0], 1);
  assert.equal(G[z0], 0);
});

test('unknown constituent names throw "Unsupported constituent: <name>"', () => {
  assert.throws(() => tidalArguments(61310.0, ['m2', 'bogus9']), /^Error: Unsupported constituent: bogus9$/);
  assert.throws(() => tidalArguments(61310.0, ['M2']), /Unsupported constituent: M2/);
  assert.throws(() => tidalArguments(61310.0, ['']), /Unsupported constituent: $/);
  assert.equal(isSupportedConstituent('bogus9'), false);
  assert.equal(isSupportedConstituent('M2'), false);
  assert.equal(isSupportedConstituent('m2'), true);
  // inherited Object.prototype keys must not count as constituents
  assert.equal(isSupportedConstituent('constructor'), false);
  assert.throws(() => tidalArguments(61310.0, ['toString']), /Unsupported constituent: toString/);
});
