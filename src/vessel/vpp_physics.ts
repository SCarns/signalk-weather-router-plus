/**
 * Physics VPP, used by POST /api/polar-from-specs: sail forces against
 * hull resistance with a heeling limit, per docs/plans/vpp-physics.md.
 * No spinnaker: downwind speeds use the upwind sails.
 *
 * Sources (full citations in the plan):
 *  - Sails: ORC VPP Documentation 2026, Tables 5.2 (main, LOW set) and 5.5
 *    (jib, LOW set); combination eqs 5.36–5.37, 5.41; induced drag 5.35;
 *    flat application 5.47; fcdmult p.58; force resolution 5.49–5.52;
 *    minimum flat 0.42 (ch.5 intro, p.37).
 *  - Friction: ITTC-57, ITTC 7.5-02-02-01 Rev 04 (2017) p.3; Reynolds
 *    number on 0.7·Lwl (DSYHS convention, Kleijweg 2016 eqs 2.7–2.8).
 *  - Residuary: Keuning & Katgert 2008 via Kleijweg 2016 eq 2.9 and
 *    Table B.2 (checked against DSYHS tow-tank data, 51 hulls).
 *  - Canoe wetted surface: Keuning & Sonnenberg 1998 via secondary copies,
 *    exponent 1/3 (majority reading; unverified against the original).
 *  - Hull+keel effective span: Keuning & Sonnenberg 1998 via Borba Labi
 *    2019 Table 16 (upright row).
 *  - Hull form coefficients the form doesn't collect: medians of the 51
 *    DSYHS hulls (4TU doi:10.4121/21501375).
 *
 * Not from a source, and flagged: the heeling-force limit and the
 * effective sail span are fitted to ORC certificates (PhysicsFit); the
 * waterline-to-maximum beam ratio and keel taper ratio are assumptions.
 */

import { UnsupportedHull, type BoatSpecs } from './vpp';
import { KTS_TO_MS } from '../geo/units';
import { POLAR_TWA_DEG, POLAR_TWS_KT, type VppTable } from './vpp_empirical';

const RHO_A = 1.225;
const RHO_W = 1025.0;
const G = 9.81;
/** Kinematic viscosity of sea water, m²/s (value used in the DSYHS check). */
const NU = 1.19e-6;

// ── ORC 2026 sail coefficients (LOW sets) ───────────────────────────
const MAIN_BETA = [0, 7, 9, 12, 28, 60, 90, 120, 150, 180];
const MAIN_CL = [0.0, 0.86207, 1.05172, 1.16379, 1.34698, 1.35345, 1.26724, 0.93103, 0.38793, -0.11207];
const MAIN_CD = [0.0431, 0.02586, 0.02328, 0.02328, 0.03259, 0.11302, 0.3825, 0.96888, 1.31578, 1.34483];
const MAIN_KP = 0.01379;
const JIB_BETA = [7, 15, 20, 27, 50, 60, 100, 150, 180];
const JIB_CL = [0.0, 1.0, 1.375, 1.45, 1.45, 1.25, 0.4, 0.0, -0.1];
const JIB_CD = [0.05, 0.032, 0.031, 0.037, 0.25, 0.35, 0.73, 0.95, 0.9];
const JIB_KP = 0.016;
const FCD_FLAT = [0.1, 0.2, 0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0];
const FCD_MULT = [1.06, 1.06, 1.06, 1.06, 1.06, 1.06, 1.055, 1.048, 1.035, 1.02, 1.008, 1.002, 1.0, 1.004, 1.06];
const FLAT_MIN = 0.42;

// ── DSYHS upright residuary, Keuning & Katgert 2008 (Kleijweg Table B.2)
const RR_FN = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75];
const RR_A: number[][] = [
  [-0.0005, 0.0023, -0.0086, -0.0015, 0.0061, 0.001, 0.0001, 0.0052],
  [-0.0003, 0.0059, -0.0064, 0.007, 0.0014, 0.0013, 0.0005, -0.002],
  [-0.0002, -0.0156, 0.0031, -0.0021, -0.007, 0.0148, 0.001, -0.0043],
  [-0.0009, 0.0016, 0.0337, -0.0285, -0.0367, 0.0218, 0.0015, -0.0172],
  [-0.0026, -0.0567, 0.0446, -0.1091, -0.0707, 0.0914, 0.0021, -0.0078],
  [-0.0064, -0.4034, -0.125, 0.0273, -0.1341, 0.3578, 0.0045, 0.1115],
  [-0.0218, -0.5261, -0.2945, 0.2485, -0.2428, 0.6293, 0.0081, 0.2086],
  [-0.0388, -0.5986, -0.3038, 0.6033, -0.043, 0.8332, 0.0106, 0.1336],
  [-0.0347, -0.4764, -0.2361, 0.8726, 0.4219, 0.899, 0.0096, -0.2272],
  [-0.0361, 0.0037, -0.296, 0.9661, 0.6123, 0.7534, 0.01, -0.3352],
  [0.0008, 0.3728, -0.3667, 1.3957, 1.0343, 0.323, 0.0072, -0.4632],
  [0.0108, -0.1238, -0.2026, 1.1282, 1.1836, 0.4973, 0.0038, -0.4477],
  [0.1023, 0.7726, 0.504, 1.7867, 2.1934, -1.5479, -0.0115, -0.0977],
];

// ── DSYHS effective span, upright row (A1, A2, A3, A4, B0, B1) ──────
const TE0 = [3.7455, -3.6246, 0.0589, -0.0296, 1.2306, -0.7256];

// ── DSYHS medians (51 hulls) ────────────────────────────────────────
const HULL_MEDIAN = { Cp: 0.551, Cm: 0.711, Cw: 0.678, Cb: 0.394, lcbAftOfMid: 0.0241, lcfAftOfMid: 0.0554 };

/** Assumptions without a source (sensitivity-tested in tools/vpp_fit.ts). */
export interface PhysicsAssumptions {
  /** Waterline beam / maximum beam. */
  bwlOverBmax: number;
  /** Keel taper ratio (tip / root chord). */
  keelTaper: number;
  /** Appendage wetted area as a fraction of the canoe-body wetted area. */
  appendageFraction: number;
  /** Jib share of the upwind sail area when the form gives only the total. */
  jibShare: number;
}

/** Constants fitted to ORC certificates (tools/vpp_fit.ts). */
export interface PhysicsFit {
  /** Effective sail span = spanK · √(sail area). */
  spanK: number;
  /** Heeling-force limit = (Δ·g·(cB·Bmax + cT·T) + crew·g·Bmax/2) / (zK·√SA + 0.43·T). */
  cB: number;
  cT: number;
  zK: number;
}

/**
 * appendageFraction 0.185 and jibShare 0.476 are medians over the 882 ORC
 * 2026 non-spinnaker certificates in test-data/orc-ns-2026.json (ORC WSS
 * over the DSYHS canoe-body estimate; Area_Jib / (Area_Main + Area_Jib)).
 * bwlOverBmax and keelTaper have no source; changing them over 0.85–0.95
 * and 0.3–0.7 moves the held-out error by < 0.001 (tools/vpp_fit.ts).
 */
export const DEFAULT_ASSUMPTIONS: PhysicsAssumptions = { bwlOverBmax: 0.9, keelTaper: 0.5, appendageFraction: 0.185, jibShare: 0.476 };
/**
 * Fitted by tools/vpp_fit.ts on the 441 even-indexed boats of
 * test-data/orc-ns-2026.json (2026-09-29). Effective values: they make the
 * model match ORC's predictions, they are not measured stability figures.
 */
export const DEFAULT_FIT: PhysicsFit = { spanK: 1.515, cB: 0.01178, cT: 0.2391, zK: 1.589 };

function interp(xs: readonly number[], ys: readonly number[], x: number): number {
  if (x <= xs[0]) return ys[0];
  const n = xs.length;
  if (x >= xs[n - 1]) return ys[n - 1];
  let i = 0;
  while (xs[i + 1] < x) i++;
  const t = (x - xs[i]) / (xs[i + 1] - xs[i]);
  return ys[i] + t * (ys[i + 1] - ys[i]);
}

interface Hull {
  lwl: number;
  bwl: number;
  tc: number;
  t: number;
  vc: number;
  disp: number;
  sc: number;
  sWet: number;
  aw: number;
  lcbFpp: number;
  lcfFpp: number;
  bmax: number;
  te0: number; // effective span before the Fn factor
}

function hullFrom(s: BoatSpecs, a: PhysicsAssumptions): Hull {
  const lwl = s.lwl_m;
  const bmax = s.beam_m;
  const bwl = bmax * a.bwlOverBmax;
  const vc = s.displacement_kg / RHO_W;
  const tc = Math.min(vc / (HULL_MEDIAN.Cb * lwl * bwl), 0.9 * s.draft_m);
  const t = s.draft_m;
  const cm = HULL_MEDIAN.Cm;
  const sc = (1.97 + 0.171 * (bwl / tc)) * (0.65 / cm) ** (1 / 3) * Math.sqrt(vc * lwl);
  const r = tc / t;
  const te0 = t * (TE0[0] * r + TE0[1] * r * r + TE0[2] * (bwl / tc) + TE0[3] * a.keelTaper);
  return {
    lwl,
    bwl,
    tc,
    t,
    vc,
    disp: s.displacement_kg,
    bmax,
    sc,
    sWet: sc * (1 + a.appendageFraction),
    aw: HULL_MEDIAN.Cw * lwl * bwl,
    lcbFpp: lwl * (0.5 + HULL_MEDIAN.lcbAftOfMid),
    lcfFpp: lwl * (0.5 + HULL_MEDIAN.lcfAftOfMid),
    te0,
  };
}

/** Upright residuary resistance, N. Below Fn 0.15 scaled linearly to 0. */
function residuary(h: Hull, v: number): number {
  const fn = v / Math.sqrt(G * h.lwl);
  const coef = (row: number[]): number =>
    row[0] +
    (h.vc ** (1 / 3) / h.lwl) *
      ((row[1] * h.lcbFpp) / h.lwl +
        row[2] * HULL_MEDIAN.Cp +
        (row[3] * h.vc ** (2 / 3)) / h.aw +
        (row[4] * h.bwl) / h.lwl +
        (row[5] * h.lcbFpp) / h.lcfFpp +
        (row[6] * h.bwl) / h.tc +
        row[7] * HULL_MEDIAN.Cm);
  let c: number;
  if (fn <= RR_FN[0]) c = coef(RR_A[0]) * (fn / RR_FN[0]);
  else if (fn >= RR_FN[RR_FN.length - 1]) c = coef(RR_A[RR_A.length - 1]);
  else {
    let i = 0;
    while (RR_FN[i + 1] < fn) i++;
    const t = (fn - RR_FN[i]) / (RR_FN[i + 1] - RR_FN[i]);
    c = coef(RR_A[i]) + t * (coef(RR_A[i + 1]) - coef(RR_A[i]));
  }
  return Math.max(0, c) * RHO_W * G * h.vc;
}

function friction(h: Hull, v: number): number {
  if (v <= 0) return 0;
  const re = (0.7 * h.lwl * v) / NU;
  const cf = 0.075 / (Math.log10(re) - 2) ** 2;
  return 0.5 * RHO_W * v * v * h.sWet * cf;
}

interface Sails {
  am: number;
  aj: number;
  aref: number;
  spanK: number;
}

/** Sail force coefficients at apparent wind angle beta (deg), flat, reef. */
function sailCoef(s: Sails, beta: number, flat: number, reef: number): { cl: number; cd: number; aref: number } {
  const clm = interp(MAIN_BETA, MAIN_CL, beta);
  const cdm = interp(MAIN_BETA, MAIN_CD, beta);
  const clj = interp(JIB_BETA, JIB_CL, beta);
  const cdj = interp(JIB_BETA, JIB_CD, beta);
  const aref = s.am + s.aj;
  const clmax = (clm * s.am + clj * s.aj) / aref;
  const cd0max = (cdm * s.am + cdj * s.aj) / aref;
  const kpp = clmax !== 0 ? (MAIN_KP * clm * clm * s.am + JIB_KP * clj * clj * s.aj) / (aref * clmax * clmax) : 0;
  const heff = s.spanK * Math.sqrt(aref) * reef;
  const ce = kpp + aref / (Math.PI * heff * heff);
  const fcdj = cd0max !== 0 ? (cdj * s.aj) / (cd0max * aref) : 0;
  const fm = interp(FCD_FLAT, FCD_MULT, flat);
  const cl = flat * clmax;
  const cd = cd0max * (flat * fm * fcdj + (1 - fcdj)) + ce * clmax * clmax * flat * flat * fm;
  return { cl, cd, aref: aref * reef * reef };
}

export interface PhysicsModel {
  hull: Hull;
  sails: Sails;
  fhMax: number;
  vMax: number;
}

export function buildModel(
  specs: BoatSpecs,
  fit: PhysicsFit = DEFAULT_FIT,
  a: PhysicsAssumptions = DEFAULT_ASSUMPTIONS,
  sailSplit?: { main: number; jib: number }
): PhysicsModel {
  const hull = hullFrom(specs, a);
  const sa = specs.sail_area_upwind_m2;
  const sails: Sails = sailSplit
    ? { am: sailSplit.main, aj: sailSplit.jib, aref: sailSplit.main + sailSplit.jib, spanK: fit.spanK }
    : { am: sa * (1 - a.jibShare), aj: sa * a.jibShare, aref: sa, spanK: fit.spanK };
  // Crew on the rail: ORC 2026 default crew weight CW = 25.8·LSM0^1.4262 kg
  // (sec 4.4.3, p.33), with Lwl standing in for LSM0 (an ORC length the
  // form doesn't have), sitting at half the maximum beam (simplified from
  // ORC eq 4.30). 0.43·T is ORC's lateral centre of pressure depth (4.29).
  const crewKg = 25.8 * hull.lwl ** 1.4262;
  const rmN = hull.disp * G * (fit.cB * hull.bmax + fit.cT * hull.t) + crewKg * G * (hull.bmax / 2);
  const fhMax = rmN / (fit.zK * Math.sqrt(sails.aref) + 0.43 * hull.t);
  return { hull, sails, fhMax, vMax: 0.75 * Math.sqrt(G * hull.lwl) };
}

/** Net forward force and heeling (side) force at boat speed v. */
function forces(m: PhysicsModel, twaDeg: number, tws: number, v: number, flat: number, reef: number): { net: number; side: number } {
  const tr = (twaDeg * Math.PI) / 180;
  const x = tws * Math.cos(tr) + v;
  const y = tws * Math.sin(tr);
  const aws = Math.hypot(x, y);
  const beta = (Math.atan2(y, x) * 180) / Math.PI;
  const { cl, cd, aref } = sailCoef(m.sails, beta, flat, reef);
  const q = 0.5 * RHO_A * aws * aws * aref;
  const br = (beta * Math.PI) / 180;
  const drive = q * (cl * Math.sin(br) - cd * Math.cos(br));
  const side = q * (cl * Math.cos(br) + cd * Math.sin(br));
  let res = friction(m.hull, v) + residuary(m.hull, v);
  if (v > 0) {
    const fn = v / Math.sqrt(G * m.hull.lwl);
    const te = Math.max(0.1, m.hull.te0 * (TE0[4] + TE0[5] * fn));
    res += (side * side) / (Math.PI * te * te * 0.5 * RHO_W * v * v);
  }
  return { net: drive - res, side };
}

/**
 * Equilibrium speed: the highest speed at which drive still exceeds
 * resistance. Induced resistance (side force² / speed²) is unbounded as
 * speed → 0, so the net force is negative at both ends and positive in
 * between; scan down from vMax for the first positive sample, then bisect
 * the crossing above it.
 */
function solveSpeed(m: PhysicsModel, twa: number, tws: number, flat: number, reef: number): { v: number; side: number } {
  const N = 48;
  let lo = -1;
  for (let k = N; k >= 1; k--) {
    const v = (m.vMax * k) / N;
    if (forces(m, twa, tws, v, flat, reef).net > 0) {
      lo = v;
      break;
    }
  }
  if (lo < 0) return { v: 0, side: 0 };
  let hi = Math.min(m.vMax, lo + m.vMax / N);
  if (lo >= m.vMax) return { v: m.vMax, side: forces(m, twa, tws, m.vMax, flat, reef).side };
  for (let i = 0; i < 40 && hi - lo > 1e-3; i++) {
    const mid = 0.5 * (lo + hi);
    if (forces(m, twa, tws, mid, flat, reef).net > 0) lo = mid;
    else hi = mid;
  }
  const v = 0.5 * (lo + hi);
  return { v, side: forces(m, twa, tws, v, flat, reef).side };
}

const FLATS = [1.0, 0.94, 0.88, 0.82, 0.76, 0.7, 0.64, 0.58, 0.52, 0.46, FLAT_MIN];
const REEFS = [1.0, 0.93, 0.86, 0.79, 0.72, 0.65, 0.58, 0.5];

/**
 * Boat speed (m/s) at a true wind angle (deg) and speed (m/s): the
 * fastest flat/reef setting whose side force stays within the heeling
 * limit. Depowers flat first, then reef, as ORC does.
 */
export function boatSpeed(m: PhysicsModel, twaDeg: number, twsMs: number): number {
  if (twsMs <= 0 || twaDeg < 25) return 0;
  let best = -1;
  for (const reef of REEFS) {
    let foundAtReef = false;
    for (const flat of FLATS) {
      const r = solveSpeed(m, twaDeg, twsMs, flat, reef);
      if (r.v > 0 && r.side <= m.fhMax) {
        if (r.v > best) best = r.v;
        foundAtReef = true;
        if (flat === 1.0) return best; // full power allowed: nothing faster
        break; // flatter only slows further at this reef
      }
    }
    if (foundAtReef && reef < 1.0) break;
  }
  // No setting keeps the heel within the limit: sail fully depowered
  // (the boat heels past the limit rather than stopping).
  if (best < 0) best = solveSpeed(m, twaDeg, twsMs, FLAT_MIN, REEFS[REEFS.length - 1]).v;
  return best;
}

/**
 * Polar table on the standard grid (vpp_empirical's POLAR_TWA_DEG ×
 * POLAR_TWS_KT), for the polar generator. No spinnaker: downwind uses the
 * upwind sails. Throws UnsupportedHull for multihulls.
 */
export function computePhysicsTable(
  specs: BoatSpecs,
  fit: PhysicsFit = DEFAULT_FIT,
  a: PhysicsAssumptions = DEFAULT_ASSUMPTIONS
): VppTable {
  const hull = specs.hull_type ?? 'monohull';
  if (hull !== 'monohull') throw new UnsupportedHull(`The polar calculator handles monohulls only; got '${hull}'.`);
  const m = buildModel(specs, fit, a);
  const tws_ms = POLAR_TWS_KT.map(k => k * KTS_TO_MS);
  const speeds_ms = POLAR_TWA_DEG.map(twa => tws_ms.map(t => (twa < 30 ? 0 : boatSpeed(m, twa, t))));
  return { twa_deg: [...POLAR_TWA_DEG], tws_ms, speeds_ms };
}
