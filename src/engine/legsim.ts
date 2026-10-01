/**
 * Leg-time simulation along a fixed great-circle line, and the batched
 * candidate scorer the propagator uses. Port of routing/engine/leg_sim.py
 * and ocean_propagator._score_candidates_from_parent.
 *
 * Mode policy:
 *  - motor:    always motor
 *  - fastest:  sail when sail speed > motor speed
 *  - sail_max: sail when the polar speed is at least sailThreshMs, else motor
 *
 * Deviation from the reference (2026-09-29, user decision): leg_sim.py's
 * sail_max also sails when vmg > 0.25 m/s or sail >= 1.0 m/s. With the
 * heading on the leg bearing vmg equals the polar speed, so those tests
 * made the boat sail above 0.25 m/s whatever the threshold; the
 * threshold alone decides here.
 */

import { haversineBearing, haversineDistanceM, projectAlongBearing, DEG } from '../geo/geodesy';
import { twaFromHeading } from '../geo/angles';
import type { CurrentSource, WindSource } from './environment';
import type { PolarDiagram } from '../vessel/polar';
import type { VesselParams } from '../vessel/vessel';

export type ModePolicy = 'sail_max' | 'fastest' | 'motor';

export interface LegSimResult {
  /** Infinity when stuck. */
  seconds: number;
  dominantMode: 'sailing' | 'motoring' | 'stuck';
  sampleCount: number;
  sailingSeconds: number;
  motoringSeconds: number;
}

export interface SimOptions {
  modePolicy: ModePolicy;
  sailThreshMs: number;
  simStepM: number;
  /** A leg is not allowed where the wind speed (m/s) or the significant wave height (m) exceeds these. */
  maxWindMs?: number;
  maxSwhM?: number;
}

function selectSpeed(sailSpeed: number, motorSpeed: number, policy: ModePolicy, sailThreshMs: number): [number, boolean] {
  if (policy === 'motor') return [motorSpeed, false];
  if (policy === 'fastest') return sailSpeed > motorSpeed ? [sailSpeed, true] : [motorSpeed, false];
  // A candidate the polar cannot sail (0 speed, e.g. in the no-go angle) is
  // stuck, never motored: that is what makes the propagator widen its heading
  // sweep and tack. Motoring is only for speeds below a positive threshold.
  return sailSpeed >= sailThreshMs ? [sailSpeed, true] : [motorSpeed, false];
}

/**
 * One sub-step through the water on a fixed heading: boat speed from the
 * polar at the true wind angle (0 without a polar), the mode choice, and
 * the progress made along the heading once the current is added.
 * `inNoGo`: the polar gave no speed because the heading is inside its
 * no-go angle. The two callers differ in how they treat missing data and
 * keep doing so until the loops are unified (structural cleanup, phase 3):
 * simulateLegTime passes no polar when the wind is NaN and zeroes a NaN
 * current; scoreCandidatesFromParent zeroes NaN wind and current first.
 */
export function stepAlongHeading(
  bearingDeg: number,
  headingU: number,
  headingV: number,
  ws: number,
  wd: number,
  cu: number,
  cv: number,
  polar: PolarDiagram | null,
  motorMs: number,
  opts: SimOptions
): { progress: number; sailUsed: boolean; inNoGo: boolean } {
  let sailSpeed = 0;
  let inNoGo = false;
  if (polar) {
    const twa = twaFromHeading(bearingDeg, wd);
    sailSpeed = polar.boatSpeed(twa, ws);
    inNoGo = sailSpeed <= 0 && twa < polar.noGoFloor(ws);
  }
  const [waterSpeed, sailUsed] = selectSpeed(sailSpeed, motorMs, opts.modePolicy, opts.sailThreshMs);
  const sogU = waterSpeed * headingU + cu;
  const sogV = waterSpeed * headingV + cv;
  return { progress: sogU * headingU + sogV * headingV, sailUsed, inNoGo };
}

/**
 * Simulate traversal of the straight line a→c starting at aTime: the
 * batched scorer with one candidate, so a final leg, a beat and a
 * smoother shortcut are timed under exactly the rules the stage
 * candidates were (structural cleanup, decision D: the loops unified).
 */
export function simulateLegTime(
  aLon: number,
  aLat: number,
  aTime: Date,
  cLon: number,
  cLat: number,
  vessel: VesselParams,
  polar: PolarDiagram | null,
  wind: WindSource,
  current: CurrentSource,
  opts: SimOptions
): LegSimResult {
  const totalDistM = haversineDistanceM(aLon, aLat, cLon, cLat);
  if (totalDistM <= 0) {
    return { seconds: 0, dominantMode: 'motoring', sampleCount: 0, sailingSeconds: 0, motoringSeconds: 0 };
  }
  const bearingDeg = haversineBearing(aLon, aLat, cLon, cLat);
  const sc = scoreCandidatesFromParent(
    aLon,
    aLat,
    aTime,
    Float64Array.of(bearingDeg),
    Float64Array.of(totalDistM),
    vessel,
    polar,
    wind,
    current,
    opts
  );
  const nSteps = Math.max(1, Math.ceil(totalDistM / opts.simStepM));
  if (!Number.isFinite(sc.seconds[0]) || sc.seconds[0] <= 0) {
    return { seconds: Infinity, dominantMode: 'stuck', sampleCount: nSteps, sailingSeconds: 0, motoringSeconds: 0 };
  }
  return {
    seconds: sc.seconds[0],
    dominantMode: sc.dominant[0] === 1 ? 'sailing' : 'motoring',
    sampleCount: nSteps,
    sailingSeconds: sc.sailing[0],
    motoringSeconds: sc.motoring[0],
  };
}

/** Wind per point at its own time: the source's batched lookup, else `at` point by point. */
export function windAtTimes(
  wind: WindSource,
  lons: Float64Array,
  lats: Float64Array,
  timesMs: Float64Array
): { speed: Float64Array; dir: Float64Array } {
  if (wind.atManyAt) return wind.atManyAt(lons, lats, timesMs);
  const n = lons.length;
  const speed = new Float64Array(n);
  const dir = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const [ws, wd] = wind.at(lons[k], lats[k], new Date(timesMs[k]));
    speed[k] = ws;
    dir[k] = wd;
  }
  return { speed, dir };
}

/** Current per point at its own time: the source's batched lookup, else `at` point by point. */
export function currentAtTimes(
  current: CurrentSource,
  lons: Float64Array,
  lats: Float64Array,
  timesMs: Float64Array
): { u: Float64Array; v: Float64Array } {
  if (current.atManyAt) return current.atManyAt(lons, lats, timesMs);
  const n = lons.length;
  const u = new Float64Array(n);
  const v = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const [a, b] = current.at(lons[k], lats[k], new Date(timesMs[k]));
    u[k] = a;
    v[k] = b;
  }
  return { u, v };
}

/** Significant wave height per point at its own time (NaN where there is none). */
export function wavesAtTimes(wind: WindSource, lons: Float64Array, lats: Float64Array, timesMs: Float64Array): Float64Array {
  if (wind.wavesAtManyAt) return wind.wavesAtManyAt(lons, lats, timesMs);
  const n = lons.length;
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const wv = wind.wavesAt(lons[k], lats[k], new Date(timesMs[k]));
    out[k] = wv ? wv.swh : NaN;
  }
  return out;
}

export interface CandidateScores {
  /** Elapsed seconds per candidate; Infinity when stuck. */
  seconds: Float64Array;
  sailing: Float64Array;
  motoring: Float64Array;
  /** 1 = sailing dominant, 0 = motoring, -1 = stuck. */
  dominant: Int8Array;
  /** 1 when the candidate was stopped by a wind or wave limit. */
  limited: Uint8Array;
  /** 1 when the candidate was stopped because its heading lies in the polar's no-go angle (dead upwind). */
  noGo: Uint8Array;
}

/**
 * Score N candidate legs from one parent in lockstep. Each candidate
 * holds a constant heading `bearings[i]` for `legDistM[i]` metres; all
 * share the parent's position and departure time. The walk is split
 * into nSteps = ceil(max(legDistM)/simStepM) sub-steps; each candidate
 * samples the environment at its own clock (the parent's time plus the
 * time its own sub-steps took so far), through the sources' per-point-time
 * lookups where they have them. Deviation from the reference, which used
 * one shared time per sub-step (parent time + k × a motor-speed step
 * estimate) for every candidate: on a long sailing leg that read the
 * forecast hours away from when the boat is there (structural cleanup,
 * decision D, 2026-10-01: measured on brain as a 16 min arrival
 * difference on a 9.5 h final leg).
 */
export function scoreCandidatesFromParent(
  parentLon: number,
  parentLat: number,
  parentTime: Date,
  bearings: Float64Array,
  legDistM: Float64Array,
  vessel: VesselParams,
  polar: PolarDiagram | null,
  wind: WindSource,
  current: CurrentSource,
  opts: SimOptions
): CandidateScores {
  const n = bearings.length;
  const seconds = new Float64Array(n);
  const sailing = new Float64Array(n);
  const motoring = new Float64Array(n);
  const dominant = new Int8Array(n);
  const limited = new Uint8Array(n);
  const noGo = new Uint8Array(n);
  if (n === 0) return { seconds, sailing, motoring, dominant, limited, noGo };

  const motor = vessel.motorSpeedMs;
  let maxDist = 0;
  for (let i = 0; i < n; i++) if (legDistM[i] > maxDist) maxDist = legDistM[i];
  const nSteps = Math.max(1, Math.ceil(maxDist / opts.simStepM));
  const stepPerCand = new Float64Array(n);
  for (let i = 0; i < n; i++) stepPerCand[i] = legDistM[i] / nSteps;
  const parentMs = parentTime.getTime();

  const curLon = new Float64Array(n).fill(parentLon);
  const curLat = new Float64Array(n).fill(parentLat);
  const stuck = new Uint8Array(n);
  const headingU = new Float64Array(n);
  const headingV = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    headingU[i] = Math.sin(bearings[i] * DEG);
    headingV[i] = Math.cos(bearings[i] * DEG);
  }

  const liveLon = new Float64Array(n);
  const liveLat = new Float64Array(n);
  const liveT = new Float64Array(n);
  const liveIdx = new Int32Array(n);

  for (let k = 0; k < nSteps; k++) {
    let nLive = 0;
    for (let i = 0; i < n; i++) {
      if (!stuck[i]) {
        liveIdx[nLive] = i;
        liveLon[nLive] = curLon[i];
        liveLat[nLive] = curLat[i];
        liveT[nLive] = parentMs + seconds[i] * 1000;
        nLive++;
      }
    }
    if (nLive === 0) break;
    const lonsL = liveLon.subarray(0, nLive);
    const latsL = liveLat.subarray(0, nLive);
    const timesL = liveT.subarray(0, nLive);
    const w = windAtTimes(wind, lonsL, latsL, timesL);
    const c = currentAtTimes(current, lonsL, latsL, timesL);
    const swh = opts.maxSwhM !== undefined && wind.hasWaves ? wavesAtTimes(wind, lonsL, latsL, timesL) : null;

    for (let q = 0; q < nLive; q++) {
      const i = liveIdx[q];
      let ws = w.speed[q];
      let wd = w.dir[q];
      if ((opts.maxWindMs !== undefined && ws > opts.maxWindMs) || (swh !== null && opts.maxSwhM !== undefined && swh[q] > opts.maxSwhM)) {
        stuck[i] = 1;
        limited[i] = 1;
        continue;
      }
      if (!Number.isFinite(ws)) ws = 0;
      if (!Number.isFinite(wd)) wd = 0;
      const cu = Number.isFinite(c.u[q]) ? c.u[q] : 0;
      const cv = Number.isFinite(c.v[q]) ? c.v[q] : 0;

      const { progress, sailUsed, inNoGo } = stepAlongHeading(bearings[i], headingU[i], headingV[i], ws, wd, cu, cv, polar, motor, opts);
      if (progress <= 0) {
        stuck[i] = 1;
        if (inNoGo) noGo[i] = 1;
        continue;
      }
      const stepS = stepPerCand[i] / progress;
      seconds[i] += stepS;
      if (sailUsed) sailing[i] += stepS;
      else motoring[i] += stepS;
      const [nl, nla] = projectAlongBearing(curLon[i], curLat[i], bearings[i], stepPerCand[i]);
      curLon[i] = nl;
      curLat[i] = nla;
    }
  }

  for (let i = 0; i < n; i++) {
    if (stuck[i]) {
      seconds[i] = Infinity;
      dominant[i] = -1;
    } else {
      dominant[i] = sailing[i] >= motoring[i] ? 1 : 0;
    }
  }
  return { seconds, sailing, motoring, dominant, limited, noGo };
}
