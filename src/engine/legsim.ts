/**
 * Leg-time simulation along a fixed great-circle line, and the batched
 * candidate scorer the propagator uses. Port of routing/engine/leg_sim.py
 * and ocean_propagator._score_candidates_from_parent.
 *
 * Mode policy:
 *  - motor:    always motor
 *  - fastest:  sail when sail speed > motor speed
 *  - sail_max: sail when any of (sail >= sailThreshMs, vmg > 0.25, sail >= 1.0)
 */

import { haversineBearing, haversineDistanceM, projectAlongBearing, DEG } from '../geo/geodesy';
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
}

function selectSpeed(sailSpeed: number, motorSpeed: number, vmg: number, policy: ModePolicy, sailThreshMs: number): [number, boolean] {
  if (policy === 'motor') return [motorSpeed, false];
  if (policy === 'fastest') return sailSpeed > motorSpeed ? [sailSpeed, true] : [motorSpeed, false];
  if (sailSpeed >= sailThreshMs || vmg > 0.25 || sailSpeed >= 1.0) return [sailSpeed, true];
  return [motorSpeed, false];
}

/** Simulate traversal of the straight line a→c starting at aTime. */
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
  const headingU = Math.sin(bearingDeg * DEG);
  const headingV = Math.cos(bearingDeg * DEG);
  const motor = vessel.motorSpeedMs;
  const nSteps = Math.max(1, Math.ceil(totalDistM / opts.simStepM));
  const stepM = totalDistM / nSteps;

  let sailing = 0;
  let motoring = 0;
  let elapsed = 0;
  let lon = aLon;
  let lat = aLat;
  let tMs = aTime.getTime();
  for (let k = 0; k < nSteps; k++) {
    const t = new Date(tMs);
    const [ws, wd] = wind.at(lon, lat, t);
    const [cu, cv] = current.at(lon, lat, t);
    let sailSpeed = 0;
    let vmg = 0;
    if (polar && Number.isFinite(ws)) {
      let twa = (((bearingDeg - wd) % 360) + 360) % 360;
      if (twa > 180) twa = 360 - twa;
      sailSpeed = polar.boatSpeed(twa, ws);
      vmg = sailSpeed; // heading equals leg bearing
    }
    const [waterSpeed, sailUsed] = selectSpeed(sailSpeed, motor, vmg, opts.modePolicy, opts.sailThreshMs);
    const sogU = waterSpeed * headingU + (Number.isFinite(cu) ? cu : 0);
    const sogV = waterSpeed * headingV + (Number.isFinite(cv) ? cv : 0);
    const progress = sogU * headingU + sogV * headingV;
    if (progress <= 0) {
      return { seconds: Infinity, dominantMode: 'stuck', sampleCount: k + 1, sailingSeconds: 0, motoringSeconds: 0 };
    }
    const stepS = stepM / progress;
    elapsed += stepS;
    if (sailUsed) sailing += stepS;
    else motoring += stepS;
    [lon, lat] = projectAlongBearing(lon, lat, bearingDeg, stepM);
    tMs += stepS * 1000;
  }
  return {
    seconds: elapsed,
    dominantMode: sailing >= motoring ? 'sailing' : 'motoring',
    sampleCount: nSteps,
    sailingSeconds: sailing,
    motoringSeconds: motoring,
  };
}

export interface CandidateScores {
  /** Elapsed seconds per candidate; Infinity when stuck. */
  seconds: Float64Array;
  sailing: Float64Array;
  motoring: Float64Array;
  /** 1 = sailing dominant, 0 = motoring, -1 = stuck. */
  dominant: Int8Array;
}

/**
 * Score N candidate legs from one parent in lockstep. Each candidate
 * holds a constant heading `bearings[i]` for `legDistM[i]` metres; all
 * share the parent's position and departure time. The walk is split
 * into nSteps = ceil(max(legDistM)/simStepM) sub-steps, and environment
 * sampling uses one shared time per sub-step (parent time + k × mean
 * motor step time), as in the reference implementation.
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
  if (n === 0) return { seconds, sailing, motoring, dominant };

  const motor = vessel.motorSpeedMs;
  let maxDist = 0;
  let sumDist = 0;
  for (let i = 0; i < n; i++) {
    if (legDistM[i] > maxDist) maxDist = legDistM[i];
    sumDist += legDistM[i];
  }
  const nSteps = Math.max(1, Math.ceil(maxDist / opts.simStepM));
  const stepPerCand = new Float64Array(n);
  for (let i = 0; i < n; i++) stepPerCand[i] = legDistM[i] / nSteps;
  const meanDtPerStep = sumDist / n / nSteps / Math.max(motor, 0.1);

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
  const liveIdx = new Int32Array(n);

  for (let k = 0; k < nSteps; k++) {
    let nLive = 0;
    for (let i = 0; i < n; i++) {
      if (!stuck[i]) {
        liveIdx[nLive] = i;
        liveLon[nLive] = curLon[i];
        liveLat[nLive] = curLat[i];
        nLive++;
      }
    }
    if (nLive === 0) break;
    const sampleTime = new Date(parentTime.getTime() + k * meanDtPerStep * 1000);
    const lonsL = liveLon.subarray(0, nLive);
    const latsL = liveLat.subarray(0, nLive);
    const w = wind.atMany(lonsL, latsL, sampleTime);
    const c = current.atMany(lonsL, latsL, sampleTime);

    for (let q = 0; q < nLive; q++) {
      const i = liveIdx[q];
      let ws = w.speed[q];
      let wd = w.dir[q];
      if (!Number.isFinite(ws)) ws = 0;
      if (!Number.isFinite(wd)) wd = 0;
      const cu = Number.isFinite(c.u[q]) ? c.u[q] : 0;
      const cv = Number.isFinite(c.v[q]) ? c.v[q] : 0;

      let sailSpeed = 0;
      if (polar) {
        let twa = (((bearings[i] - wd) % 360) + 360) % 360;
        if (twa > 180) twa = 360 - twa;
        sailSpeed = polar.boatSpeed(twa, ws);
      }
      const vmg = sailSpeed;
      const [waterSpeed, sailUsed] = selectSpeed(sailSpeed, motor, vmg, opts.modePolicy, opts.sailThreshMs);
      const sogU = waterSpeed * headingU[i] + cu;
      const sogV = waterSpeed * headingV[i] + cv;
      const progress = sogU * headingU[i] + sogV * headingV[i];
      if (progress <= 0) {
        stuck[i] = 1;
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
  return { seconds, sailing, motoring, dominant };
}
