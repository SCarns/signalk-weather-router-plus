/**
 * Physics VPP against ORC 2026 non-spinnaker certificates
 * (test-data/orc-ns-2026.json). The constants were fitted on the
 * even-indexed boats; these checks use only the odd-indexed ones, which
 * the fit never saw. Limits sit just above the scores measured on
 * 2026-09-29 (tools/vpp_fit.ts), so a change that makes the model worse
 * fails here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { boatSpeed, buildModel, computePhysicsTable } from './vpp_physics';
import { UnsupportedHull, type BoatSpecs } from './vpp';

const KT = 0.5144444444;
interface Pt { twa: number; tws_kt: number; bs_kt: number }
interface Boat { specs: BoatSpecs; points: Pt[] }
const held: Boat[] = JSON.parse(fs.readFileSync(path.join(__dirname, '../../test-data/orc-ns-2026.json'), 'utf8')).boats.filter((_: Boat, i: number) => i % 2 === 1);

const sector = (twa: number): string | null => (twa >= 30 && twa <= 60 ? 'upwind' : twa >= 70 && twa <= 120 ? 'reaching' : twa >= 135 && twa <= 180 ? 'running' : null);
const median = (a: number[]): number => { const v = [...a].sort((p, q) => p - q); return v[Math.floor(v.length / 2)]; };

test('held-out ORC boats: median error per sector and boats over 30%', () => {
  const meanAbs: Record<string, number[]> = { upwind: [], reaching: [], running: [] };
  const over: Record<string, number> = { upwind: 0, reaching: 0, running: 0 };
  for (const b of held) {
    const m = buildModel(b.specs);
    const e: Record<string, number[]> = { upwind: [], reaching: [], running: [] };
    for (const p of b.points) {
      const s = sector(p.twa);
      if (!s || p.tws_kt < 6 || p.tws_kt > 20) continue;
      e[s].push(((boatSpeed(m, p.twa, p.tws_kt * KT) / KT - p.bs_kt) / p.bs_kt) * 100);
    }
    for (const s of Object.keys(e)) {
      if (!e[s].length) continue;
      meanAbs[s].push(e[s].reduce((a, x) => a + Math.abs(x), 0) / e[s].length);
      if (Math.max(...e[s].map(Math.abs)) > 30) over[s]++;
    }
  }
  // Measured 2026-09-29: 3.3 / 3.2 / 3.3 %, and 3 / 1 / 0 boats of 441.
  assert.ok(median(meanAbs.upwind) < 4, `upwind ${median(meanAbs.upwind)}`);
  assert.ok(median(meanAbs.reaching) < 4, `reaching ${median(meanAbs.reaching)}`);
  assert.ok(median(meanAbs.running) < 4, `running ${median(meanAbs.running)}`);
  assert.ok(over.upwind <= 5 && over.reaching <= 3 && over.running <= 2, JSON.stringify(over));
});

// Within ORC's range (4–24 kn) speed must not fall by more than 0.1 m/s
// as the wind rises. Known artifact (2026-09-29): at tight angles the
// heavily depowered model loses ~2% from 20 to 24 kn (ORC shows a flat
// line there), and up to 0.3 kn from 24 to 30 kn, outside ORC's range.
test('table: standard grid, zero below 30° TWA, no real speed drop as wind rises (4–24 kn)', () => {
  const specs: BoatSpecs = { loa_m: 14.6, lwl_m: 11.5, beam_m: 4.3, draft_m: 2.4, displacement_kg: 14000, sail_area_upwind_m2: 95, rig_type: 'ketch', keel_type: 'fin' };
  const t = computePhysicsTable(specs);
  assert.equal(t.twa_deg.length, 22);
  assert.equal(t.tws_ms.length, 10);
  assert.ok(t.speeds_ms[0].every((v) => v === 0));
  for (let i = 1; i < t.twa_deg.length; i++) {
    for (let k = 1; k < t.tws_ms.length; k++) {
      if (t.tws_ms[k] > 24 * KT + 1e-6) continue;
      assert.ok(t.speeds_ms[i][k] >= t.speeds_ms[i][k - 1] - 0.1, `TWA ${t.twa_deg[i]} drops from ${t.speeds_ms[i][k - 1]} to ${t.speeds_ms[i][k]}`);
    }
  }
});

test('multihulls are rejected', () => {
  assert.throws(() => computePhysicsTable({ loa_m: 12, lwl_m: 11, beam_m: 6, draft_m: 1.2, displacement_kg: 7000, sail_area_upwind_m2: 90, hull_type: 'catamaran' }), UnsupportedHull);
});
