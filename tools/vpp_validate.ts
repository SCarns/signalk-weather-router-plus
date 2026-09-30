/**
 * Score a polar calculator against ORC non-spinnaker certificates.
 *
 * Usage:
 *   node --import tsx tools/vpp_validate.ts [dataset.json] [--worst K]
 *
 * The dataset (default test-data/orc-ns-2026.json, built by
 * tools/orc_ns_dataset.py) holds, per boat, the specs the calculator's
 * form takes and the certificate's reference speeds. Reference speeds are
 * ORC's own VPP run on the boat's measured hull and sails (not on-water
 * logs); see docs/plans/vpp-physics.md.
 *
 * Error per cell = (calculated − reference) / reference. Reported per
 * sector for TWS 6–20 kn: mean absolute error, and the worst cell. A
 * sector whose worst cell is over 30% is flagged (warning threshold, not
 * a pass mark).
 */

import * as fs from 'node:fs';
import { computePolar } from '../src/vessel/vpp_empirical';
import { KTS_TO_MS } from '../src/geo/geodesy';
import type { BoatSpecs } from '../src/vessel/vpp';
import type { PolarDiagram } from '../src/vessel/polar';

export interface RefPoint {
  twa: number;
  tws_kt: number;
  bs_kt: number;
  kind: 'angle' | 'beat' | 'run';
}
export interface RefBoat {
  ref: string;
  name: string;
  cls: string;
  source: string;
  specs: BoatSpecs;
  points: RefPoint[];
}

export type Sector = 'upwind' | 'reaching' | 'running';
export const SECTORS: Sector[] = ['upwind', 'reaching', 'running'];
export const WARN_PCT = 30;
const TWS_MIN = 6;
const TWS_MAX = 20;

export function sectorOf(twa: number): Sector | null {
  if (twa >= 30 && twa <= 60) return 'upwind';
  if (twa >= 70 && twa <= 120) return 'reaching';
  if (twa >= 135 && twa <= 180) return 'running';
  return null;
}

export interface BoatScore {
  ref: string;
  name: string;
  cls: string;
  sectors: Record<Sector, { n: number; meanAbs: number; worst: number; worstAt: string }>;
}

export function scoreBoat(boat: RefBoat, polar: PolarDiagram): BoatScore {
  const acc: Record<Sector, number[]> = { upwind: [], reaching: [], running: [] };
  const where: Record<Sector, string[]> = { upwind: [], reaching: [], running: [] };
  for (const p of boat.points) {
    if (p.tws_kt < TWS_MIN || p.tws_kt > TWS_MAX) continue;
    const s = sectorOf(p.twa);
    if (!s) continue;
    const calc = polar.boatSpeed(p.twa, p.tws_kt * KTS_TO_MS) / KTS_TO_MS;
    acc[s].push(((calc - p.bs_kt) / p.bs_kt) * 100);
    where[s].push(`${p.kind === 'angle' ? '' : p.kind + ' '}${p.twa.toFixed(0)}°/${p.tws_kt}kt`);
  }
  const sectors = {} as BoatScore['sectors'];
  for (const s of SECTORS) {
    const e = acc[s];
    let wi = 0;
    for (let i = 1; i < e.length; i++) if (Math.abs(e[i]) > Math.abs(e[wi])) wi = i;
    sectors[s] = {
      n: e.length,
      meanAbs: e.length ? e.reduce((a, b) => a + Math.abs(b), 0) / e.length : NaN,
      worst: e.length ? e[wi] : NaN,
      worstAt: e.length ? where[s][wi] : '',
    };
  }
  return { ref: boat.ref, name: boat.name, cls: boat.cls, sectors };
}

function pct(v: number): string {
  return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
}

function main(): void {
  const args = process.argv.slice(2);
  const wi = args.indexOf('--worst');
  const worstK = wi >= 0 ? Number(args[wi + 1]) || 10 : 10;
  const file = args.find((a, i) => !a.startsWith('--') && !(wi >= 0 && i === wi + 1)) ?? 'test-data/orc-ns-2026.json';
  const boats: RefBoat[] = JSON.parse(fs.readFileSync(file, 'utf8')).boats;
  const scores: BoatScore[] = [];
  const failed: string[] = [];
  for (const b of boats) {
    try {
      scores.push(scoreBoat(b, computePolar(b.specs)));
    } catch (e) {
      failed.push(`${b.ref} ${b.cls}: ${(e as Error).message}`);
    }
  }
  console.log(`${file}: ${boats.length} boats, ${scores.length} scored, ${failed.length} not computable`);
  console.log('Sector     | boats | mean |err| (median over boats) | worst cell, median | boats with worst > 30%');
  for (const s of SECTORS) {
    const xs = scores.filter((b) => b.sectors[s].n > 0);
    const med = (a: number[]): number => {
      const v = [...a].sort((p, q) => p - q);
      return v.length ? v[Math.floor(v.length / 2)] : NaN;
    };
    const over = xs.filter((b) => Math.abs(b.sectors[s].worst) > WARN_PCT).length;
    console.log(
      `${s.padEnd(10)} | ${String(xs.length).padStart(5)} | ${med(xs.map((b) => b.sectors[s].meanAbs)).toFixed(1).padStart(29)}% | ${pct(med(xs.map((b) => b.sectors[s].worst))).padStart(18)} | ${over} (${((over / xs.length) * 100).toFixed(0)}%)`,
    );
  }
  const ranked = [...scores].sort(
    (a, b) => Math.max(...SECTORS.map((s) => Math.abs(b.sectors[s].worst) || 0)) - Math.max(...SECTORS.map((s) => Math.abs(a.sectors[s].worst) || 0)),
  );
  console.log(`\nWorst ${worstK} boats:`);
  for (const b of ranked.slice(0, worstK)) {
    console.log(`  ${b.cls.padEnd(24)} ${SECTORS.map((s) => `${s} ${pct(b.sectors[s].worst)} @${b.sectors[s].worstAt}`).join('  ')}`);
  }
  if (failed.length) console.log(`\nNot computable:\n  ${failed.slice(0, 20).join('\n  ')}`);
}

if (require.main === module) main();
