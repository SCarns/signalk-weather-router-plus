/**
 * Fit the physics VPP's un-sourced constants (PhysicsFit) to ORC
 * non-spinnaker certificates, then score it on boats it never saw.
 *
 *   node --import tsx tools/vpp_fit.ts [dataset.json] [--train N]
 *
 * Boats are split by position: even index → training, odd → held out.
 * Objective: mean |ln(calculated / reference)| over training cells,
 * TWS 6–20 kn, all sectors. Optimiser: Nelder–Mead on the log of each
 * constant. Held-out boats are scored per sector like tools/vpp_validate.ts,
 * next to today's empirical calculator on the same boats.
 */

import * as fs from 'node:fs';
import { boatSpeed, buildModel, DEFAULT_ASSUMPTIONS, type PhysicsAssumptions, type PhysicsFit } from '../src/vessel/vpp_physics';
import { computePolar } from '../src/vessel/vpp_empirical';
import { KTS_TO_MS } from '../src/geo/geodesy';
import { sectorOf, SECTORS, WARN_PCT, type RefBoat, type Sector } from './vpp_validate';

type Boat = RefBoat & { orc: { WSS?: number; Area_Main: number; Area_Jib: number } };

const args = process.argv.slice(2);
const ti = args.indexOf('--train');
const trainCap = ti >= 0 ? Number(args[ti + 1]) : Infinity;
const file = args.find((a, i) => !a.startsWith('--') && !(ti >= 0 && i === ti + 1)) ?? 'test-data/orc-ns-2026.json';
const all: Boat[] = JSON.parse(fs.readFileSync(file, 'utf8')).boats;
const train = all.filter((_, i) => i % 2 === 0).slice(0, trainCap);
const test = all.filter((_, i) => i % 2 === 1);

const median = (a: number[]): number => { const v = [...a].sort((p, q) => p - q); return v[Math.floor(v.length / 2)]; };
const jibShare = median(all.map((b) => b.orc.Area_Jib / (b.orc.Area_Main + b.orc.Area_Jib)));
const assumptions: PhysicsAssumptions = { ...DEFAULT_ASSUMPTIONS, appendageFraction: 0.185, jibShare };

const inBand = (p: { tws_kt: number; twa: number }): boolean => p.tws_kt >= 6 && p.tws_kt <= 20 && sectorOf(p.twa) !== null;

function objective(fit: PhysicsFit, boats: Boat[], a: PhysicsAssumptions): number {
  let sum = 0;
  let n = 0;
  for (const b of boats) {
    const m = buildModel(b.specs, fit, a);
    for (const p of b.points) {
      if (!inBand(p)) continue;
      const v = boatSpeed(m, p.twa, p.tws_kt * KTS_TO_MS) / KTS_TO_MS;
      sum += v > 0 ? Math.abs(Math.log(v / p.bs_kt)) : 3;
      n++;
    }
  }
  return sum / n;
}

function nelderMead(f: (x: number[]) => number, x0: number[], step: number, iters: number): { x: number[]; fx: number } {
  const n = x0.length;
  let simplex = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v + step : v)))].map((x) => ({ x, fx: f(x) }));
  for (let it = 0; it < iters; it++) {
    simplex.sort((a, b) => a.fx - b.fx);
    const best = simplex[0];
    const worst = simplex[n];
    const c = x0.map((_, j) => simplex.slice(0, n).reduce((s, p) => s + p.x[j], 0) / n);
    const at = (t: number): number[] => c.map((cj, j) => cj + t * (worst.x[j] - cj));
    const r = { x: at(-1), fx: 0 }; r.fx = f(r.x);
    if (r.fx < best.fx) {
      const e = { x: at(-2), fx: 0 }; e.fx = f(e.x);
      simplex[n] = e.fx < r.fx ? e : r;
    } else if (r.fx < simplex[n - 1].fx) {
      simplex[n] = r;
    } else {
      const k = { x: at(0.5), fx: 0 }; k.fx = f(k.x);
      if (k.fx < worst.fx) simplex[n] = k;
      else simplex = simplex.map((p, i) => (i === 0 ? p : (() => { const x = p.x.map((v, j) => best.x[j] + 0.5 * (v - best.x[j])); return { x, fx: f(x) }; })()));
    }
    if (it % 10 === 0) process.stderr.write(`  iter ${it}: ${simplex[0].fx.toFixed(4)}\n`);
  }
  simplex.sort((a, b) => a.fx - b.fx);
  return simplex[0];
}

const toFit = (x: number[]): PhysicsFit => ({ spanK: Math.exp(x[0]), cB: Math.exp(x[1]), cT: Math.exp(x[2]), zK: Math.exp(x[3]) });

function sectorScores(calc: (b: Boat, twa: number, twsKt: number) => number, boats: Boat[]): Record<Sector, { meanAbsMed: number; worstMed: number; over: number; n: number; bias: number }> {
  const out = {} as Record<Sector, { meanAbsMed: number; worstMed: number; over: number; n: number; bias: number }>;
  const per: Record<Sector, { mean: number[]; worst: number[]; signed: number[] }> = { upwind: { mean: [], worst: [], signed: [] }, reaching: { mean: [], worst: [], signed: [] }, running: { mean: [], worst: [], signed: [] } };
  for (const b of boats) {
    const e: Record<Sector, number[]> = { upwind: [], reaching: [], running: [] };
    for (const p of b.points) {
      if (!inBand(p)) continue;
      const s = sectorOf(p.twa)!;
      e[s].push(((calc(b, p.twa, p.tws_kt) - p.bs_kt) / p.bs_kt) * 100);
    }
    for (const s of SECTORS) {
      if (!e[s].length) continue;
      per[s].mean.push(e[s].reduce((a, x) => a + Math.abs(x), 0) / e[s].length);
      per[s].worst.push(e[s].reduce((a, x) => (Math.abs(x) > Math.abs(a) ? x : a), 0));
      per[s].signed.push(...e[s]);
    }
  }
  for (const s of SECTORS) {
    out[s] = { meanAbsMed: median(per[s].mean), worstMed: median(per[s].worst), over: per[s].worst.filter((w) => Math.abs(w) > WARN_PCT).length, n: per[s].worst.length, bias: median(per[s].signed) };
  }
  return out;
}

function report(label: string, r: ReturnType<typeof sectorScores>): void {
  console.log(`  ${label}`);
  for (const s of SECTORS) {
    const x = r[s];
    console.log(`    ${s.padEnd(9)} median |err| ${x.meanAbsMed.toFixed(1).padStart(5)}%  median signed ${(x.bias >= 0 ? '+' : '') + x.bias.toFixed(1)}%  worst-cell median ${(x.worstMed >= 0 ? '+' : '') + x.worstMed.toFixed(1)}%  boats over 30%: ${x.over}/${x.n} (${((x.over / x.n) * 100).toFixed(0)}%)`);
  }
}

const t0 = Date.now();
console.log(`${file}: ${all.length} boats; training ${train.length}, held out ${test.length}; jib share (median of certificates) ${jibShare.toFixed(3)}`);
const res = nelderMead((x) => objective(toFit(x), train, assumptions), [Math.log(1.5), Math.log(0.05), Math.log(0.05), Math.log(0.6)], 0.4, 120);
const fit = toFit(res.x);
console.log(`fitted in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${JSON.stringify(Object.fromEntries(Object.entries(fit).map(([k, v]) => [k, Number(v.toPrecision(4))])))}; training mean |ln ratio| ${res.fx.toFixed(4)}`);

console.log(`\nHeld-out boats (${test.length}), TWS 6–20 kn:`);
const memo = <T>(make: (b: Boat) => T): ((b: Boat) => T) => { const c = new Map<string, T>(); return (b) => { let v = c.get(b.ref); if (!v) { v = make(b); c.set(b.ref, v); } return v; }; };
const phys = memo((b) => buildModel(b.specs, fit, assumptions));
const emp = memo((b) => computePolar(b.specs));
report('physics (fitted)', sectorScores((b, twa, t) => boatSpeed(phys(b), twa, t * KTS_TO_MS) / KTS_TO_MS, test));
report('empirical (today)', sectorScores((b, twa, t) => emp(b).boatSpeed(twa, t * KTS_TO_MS) / KTS_TO_MS, test));

console.log('\nSensitivity to the un-sourced assumptions (held-out mean |ln ratio|, same fit):');
for (const [k, vals] of [['bwlOverBmax', [0.85, 0.9, 0.95]], ['keelTaper', [0.3, 0.5, 0.7]]] as const) {
  console.log(`  ${k}: ${vals.map((v) => `${v} → ${objective(fit, test, { ...assumptions, [k]: v }).toFixed(4)}`).join('   ')}`);
}
