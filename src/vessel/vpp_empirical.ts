/**
 * Empirical VPP — simplified regression-based velocity prediction.
 * Port of the routing server's `routing/vessel/vpp_empirical.py`; the
 * arithmetic follows the Python line by line (same constants, same
 * operation order, same bisection) so the tables match to rounding.
 *
 * Not a full ORC-IMS/Hazen VPP. It uses:
 *  - simplified sail drive coefficient curves (upwind + downwind) keyed
 *    off apparent wind angle and sail areas;
 *  - a displacement-hull drag model with a Froude-number wave term that
 *    rises steeply towards hull speed;
 *  - a bisection solve for steady-state boat speed per (TWA, TWS) cell.
 *
 * Accuracy is moderate (~15-20% of a measured polar for typical cruising
 * monohulls): adequate for route planning, not racing tactics.
 * Multihulls are rejected with UnsupportedHull.
 */

import { PolarDiagram } from './polar';
import { DEG, RAD, KTS_TO_MS } from '../geo/units';
import { pyFixed, UnsupportedHull, type BoatSpecs } from './vpp';

// ── Physical constants ──────────────────────────────────────────────
const RHO_AIR = 1.225; // kg/m³
const RHO_WATER = 1025.0; // kg/m³ (seawater)
const G = 9.81; // m/s²

// ── Standard output grid (ORC-IMS inspired) ─────────────────────────
export const POLAR_TWA_DEG: readonly number[] = [
  0, 30, 32, 36, 40, 45, 50, 55, 60, 70, 80, 90, 100, 110, 120, 130, 135, 140, 150, 160, 170, 180,
];
export const POLAR_TWS_KT: readonly number[] = [4, 6, 8, 10, 12, 14, 16, 20, 24, 30];

/**
 * (upwind, downwind) sail drive coefficients at an apparent wind angle.
 * Upwind: ramp 0->0.75 over AWA 20-35°, plateau to 80°, linear to 0 at
 * 150°. Downwind: 0 below 60°, ramp to 1.05 at 120°, plateau to 150°,
 * then 1.05 -> 0.75 at 180°.
 */
export function driveCoefficient(awaDeg: number): [number, number] {
  let a = Math.abs(awaDeg) % 360.0;
  if (a > 180.0) a = 360.0 - a;

  const up_peak = 0.75;
  let up: number;
  if (a < 20.0) up = 0.0;
  else if (a < 35.0) up = (up_peak * (a - 20.0)) / 15.0;
  else if (a < 80.0) up = up_peak;
  else if (a < 150.0) up = (up_peak * (150.0 - a)) / 70.0;
  else up = 0.0;

  const dn_peak = 1.05;
  let dn: number;
  if (a < 60.0) dn = 0.0;
  else if (a < 120.0) dn = (dn_peak * (a - 60.0)) / 60.0;
  else if (a < 150.0) dn = dn_peak;
  else dn = dn_peak - (0.3 * (a - 150.0)) / 30.0;

  return [up, dn];
}

/** Theoretical displacement-hull speed, ~1.25 x sqrt(LWL_m) m/s. */
export function hullSpeedMs(lwl_m: number): number {
  return 1.25 * Math.sqrt(lwl_m);
}

/** Total hydrodynamic drag [N]: viscous (quadratic) + wave (exponential past Fn 0.33). */
export function dragForceN(boat_speed_ms: number, displacement_kg: number, lwl_m: number, _beam_m: number): number {
  if (boat_speed_ms <= 0.0) return 0.0;
  // Wetted surface S ≈ 2.7 × (displacement/ρ)^(2/3).
  const vol = displacement_kg / RHO_WATER;
  const s_wet = 2.7 * vol ** (2.0 / 3.0);
  // Viscous: 0.5 ρ S V² C_f, C_f ≈ 0.004.
  const cf = 0.004;
  const f_viscous = 0.5 * RHO_WATER * s_wet * boat_speed_ms ** 2 * cf;
  // Wave: ~0 below Fn 0.33, dominates above Fn 0.4.
  const fn = boat_speed_ms / Math.sqrt(G * lwl_m);
  const wave_factor = Math.exp(15.0 * Math.max(0.0, fn - 0.33));
  const f_wave = 0.5 * RHO_WATER * s_wet * boat_speed_ms ** 2 * 0.01 * wave_factor;
  return f_viscous + f_wave;
}

/** (AWS m/s, AWA degrees in [0, 180]) for true wind + boat speed on the TWA heading. */
export function apparentWind(tws_ms: number, twa_deg: number, vs_ms: number): [number, number] {
  const twa_r = twa_deg * DEG;
  const x = tws_ms * Math.cos(twa_r) + vs_ms;
  const y = tws_ms * Math.sin(twa_r);
  const aws = Math.hypot(x, y);
  if (aws < 1e-9) return [0.0, 0.0];
  let awa = Math.atan2(y, x) * RAD;
  awa = Math.abs(awa);
  if (awa > 180.0) awa = 360.0 - awa;
  return [aws, awa];
}

/** Boat speed where sail drive equals hull drag: bisection on [0, vs_max]. */
export function solveBoatSpeed(
  twa: number,
  tws_ms: number,
  sa_up: number,
  sa_dn: number,
  displacement_kg: number,
  lwl_m: number,
  beam_m: number,
  vs_max: number
): number {
  const netForce = (vsIn: number): number => {
    const vs = vsIn < 0.0 ? 0.0 : vsIn;
    const [aws, awa] = apparentWind(tws_ms, twa, vs);
    const [cr_up, cr_dn] = driveCoefficient(awa);
    const drive = 0.5 * RHO_AIR * aws ** 2 * (sa_up * cr_up + sa_dn * cr_dn);
    const drag = dragForceN(vs, displacement_kg, lwl_m, beam_m);
    return drive - drag;
  };
  let lo = 0.0;
  let hi = vs_max;
  if (netForce(0.0) <= 0.0) return 0.0;
  if (netForce(hi) > 0.0) return vs_max; // drive still wins at the cap
  for (let it = 0; it < 40; it++) {
    const mid = 0.5 * (lo + hi);
    if (netForce(mid) > 0.0) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-3) break;
  }
  return 0.5 * (lo + hi);
}

/** Raw VPP output (m/s), before it becomes a PolarDiagram. */
export interface VppTable {
  twa_deg: number[];
  tws_ms: number[];
  /** speeds_ms[i][j] for twa_deg[i], tws_ms[j]. */
  speeds_ms: number[][];
}

/**
 * The polar table on the standard grid; throws UnsupportedHull for multihulls. `twsMs` evaluates at other wind
 * speeds (the parity tests pass the Python's, which used a rounded knot).
 */
export function computePolarTable(specs: BoatSpecs, twsMs: readonly number[] = POLAR_TWS_KT.map(k => k * KTS_TO_MS)): VppTable {
  const hull = specs.hull_type ?? 'monohull';
  if (hull !== 'monohull') {
    throw new UnsupportedHull(`Empirical VPP handles monohulls only; got '${hull}'. Use a physics VPP for multihulls.`);
  }
  const sa_up = specs.sail_area_upwind_m2;
  const sa_dn_in = specs.sail_area_downwind_m2 ?? 0;
  const sa_dn = sa_dn_in > 0.0 ? sa_dn_in : 1.5 * sa_up;

  const v_hull = hullSpeedMs(specs.lwl_m);
  // Cap the search at 1.08 x hull speed to avoid numerical blow-up.
  const vs_max = v_hull * 1.08;

  const speeds: number[][] = POLAR_TWA_DEG.map(() => new Array<number>(twsMs.length).fill(0));
  for (let j = 0; j < twsMs.length; j++) {
    const tws_ms = twsMs[j];
    for (let i = 0; i < POLAR_TWA_DEG.length; i++) {
      const twa = POLAR_TWA_DEG[i];
      if (twa < 30.0) {
        speeds[i][j] = 0.0; // in irons
        continue;
      }
      speeds[i][j] = solveBoatSpeed(twa, tws_ms, sa_up, sa_dn, specs.displacement_kg, specs.lwl_m, specs.beam_m, vs_max);
    }
  }
  return { twa_deg: [...POLAR_TWA_DEG], tws_ms: [...twsMs], speeds_ms: speeds };
}

/** `EmpiricalVPP.compute_polar`. */
export function computePolar(specs: BoatSpecs): PolarDiagram {
  const t = computePolarTable(specs);
  return new PolarDiagram(t.twa_deg, t.tws_ms, t.speeds_ms.flat());
}

/**
 * CSV text in the layout `PolarDiagram.save_csv` writes and
 * `PolarDiagram.load` reads: header `<label>,<tws kt .1f>...`, then one
 * row per TWA `<twa .0f>,<speed kt .2f>...`, CRLF line ends (Python
 * csv.writer default), knots on disk.
 */
export function polarCsv(table: VppTable, headerLabel = 'twa/tws'): string {
  const lines: string[] = [];
  lines.push([csvCell(headerLabel), ...table.tws_ms.map(t => pyFixed(t / KTS_TO_MS, 1))].join(','));
  for (let i = 0; i < table.twa_deg.length; i++) {
    lines.push([pyFixed(table.twa_deg[i], 0), ...table.speeds_ms[i].map(v => pyFixed(v / KTS_TO_MS, 2))].join(','));
  }
  return lines.map(l => l + '\r\n').join('');
}

/** Python csv.writer minimal quoting for one cell. */
function csvCell(s: string): string {
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
