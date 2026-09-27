/**
 * Subsector isochrone propagator for open-water legs. Port of
 * routing/engine/ocean_propagator.py (Hagiwara 1989 / Chen & Mao 2024
 * IPO family) without the bathymetry gate.
 *
 * Per stage:
 *  1. From each retained parent, project (2m+1) candidates at evenly
 *     spaced headings around the bearing to the next skeleton target,
 *     one stage step away.
 *  2. Drop candidates whose great-circle leg touches land.
 *  3. Score survivors with the batched leg simulator (wind, current,
 *     polar, mode policy).
 *  4. Bin by cross-track offset from the start→end great circle into 2k
 *     subsectors; keep the cheapest (elapsed + remaining/cruise) per bin
 *     and per via-count.
 *  5. Stop early when a candidate is within one stage step (or the
 *     caller's arrival radius) of the destination.
 * Then a straight final leg to the destination, back-trace, enrich each
 * waypoint with wind/waves/current, and validate every leg against the
 * exact polygons.
 *
 * A coarse A* skeleton (land-avoiding motor path on a raster of the
 * land mask) biases the heading sweep so channels and around-island
 * detours are found without widening the sweep at every stage.
 */

import {
  bboxFromLonLat, haversineBearing, haversineDistanceM, perpendicularOffsetM,
  projectAlongBearing, segmentWithinDisc,
} from '../geo/geodesy';
import { buildCoarseGrid, type NavigabilityGrid } from '../geo/grid';
import type { LandMask } from '../geo/landmask';
import { astarRoute, AstarError } from './astar';
import { NoCurrent, NoWind, type CurrentSource, type WindSource } from './environment';
import { scoreCandidatesFromParent, simulateLegTime, type ModePolicy } from './legsim';
import { recomputePerWaypointMetadata, type Route, type RouteWarning, type Waypoint } from './route';
import type { PolarDiagram } from '../vessel/polar';
import type { VesselParams } from '../vessel/vessel';

export interface PropagatorOptions {
  /** Number of isochrone stages spanning the great-circle distance. */
  stages?: number;
  /** Subsector half-count k (2k bins across the corridor). */
  subsectors?: number;
  /** Heading half-count m (2m+1 candidates per parent). */
  headings?: number;
  /** Heading spacing in degrees. */
  headingIncrementDeg?: number;
  /** Coarse skeleton grid resolution in degrees. */
  skeletonResolutionDeg?: number;
  /** Padding around the leg's bbox for the skeleton grid, degrees. */
  skeletonPaddingDeg?: number;
  /** Along-leg land sampling step, metres. */
  landStepM?: number;
}

export interface Via {
  lon: number;
  lat: number;
  /** Disc radius the polyline must pass through, metres (> 0). */
  radiusM: number;
}

export interface ComputeRouteArgs {
  start: [number, number];
  end: [number, number];
  departureTime: Date;
  vessel: VesselParams;
  polar?: PolarDiagram | null;
  wind?: WindSource;
  current?: CurrentSource;
  modePolicy?: ModePolicy;
  sailThreshMs?: number;
  simStepM?: number;
  /** Stop when within this distance of the end; default is one stage step. */
  arrivalRadiusM?: number;
  vias?: Via[];
  /** Progress callback; messages are short human-readable lines. */
  onProgress?: (stage: number, totalStages: number, message: string) => void;
  /** Return true to abort; a RouteCancelled error is thrown. */
  shouldCancel?: () => boolean;
}

/**
 * Nearest passable cell centre to `p` within `maxRadius` cells (ring
 * search); returns `p` unchanged when its own cell is passable or when
 * nothing is found.
 */
function snapToPassable(grid: NavigabilityGrid, p: [number, number], maxRadius: number): [number, number] {
  const [i0, j0] = grid.spec.lonlatToIJ(p[0], p[1]);
  if (grid.isPassable(i0, j0)) return p;
  for (let r = 1; r <= maxRadius; r++) {
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (let di = -r; di <= r; di++) {
      for (let dj = -r; dj <= r; dj++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = i0 + di;
        const j = j0 + dj;
        if (!grid.isPassable(i, j)) continue;
        const [lon, lat] = grid.spec.ijToLonLat(i, j);
        const d = haversineDistanceM(p[0], p[1], lon, lat);
        if (d < bestD) {
          bestD = d;
          best = [lon, lat];
        }
      }
    }
    if (best) return best;
  }
  return p;
}

export class RouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteError';
  }
}

export class RouteCancelled extends Error {
  constructor() {
    super('route computation cancelled');
    this.name = 'RouteCancelled';
  }
}

interface Candidate {
  lon: number;
  lat: number;
  timeMs: number;
  elapsedS: number;
  parentIdx: number;
  sogMs: number;
  cogDeg: number;
  mode: 'sailing' | 'motoring';
  sailingS: number;
  motoringS: number;
  viaCount: number;
  viaIdxs: number[];
}

export class OceanPropagator {
  readonly K: number;
  readonly k: number;
  readonly m: number;
  readonly deltaC: number;
  readonly skeletonResolutionDeg: number;
  readonly skeletonPaddingDeg: number;
  readonly landStepM: number;

  constructor(readonly landMask: LandMask, opts: PropagatorOptions = {}) {
    this.K = Math.max(1, Math.floor(opts.stages ?? 20));
    this.k = Math.max(1, Math.floor(opts.subsectors ?? 30));
    this.m = Math.max(1, Math.floor(opts.headings ?? 30));
    this.deltaC = opts.headingIncrementDeg ?? 1.0;
    this.skeletonResolutionDeg = opts.skeletonResolutionDeg ?? 0.005;
    this.skeletonPaddingDeg = opts.skeletonPaddingDeg ?? 1.0;
    this.landStepM = opts.landStepM ?? 200;
  }

  computeRoute(args: ComputeRouteArgs): Route {
    const wind = args.wind ?? new NoWind();
    const current = args.current ?? new NoCurrent();
    const polar = args.polar ?? null;
    const vessel = args.vessel;
    const modePolicy = args.modePolicy ?? 'sail_max';
    const sailThreshMs = args.sailThreshMs ?? 2.5;
    const simStepM = args.simStepM ?? 200;
    const progress = args.onProgress ?? (() => undefined);
    const shouldCancel = args.shouldCancel ?? (() => false);
    const checkCancel = (): void => {
      if (shouldCancel()) throw new RouteCancelled();
    };
    const simOpts = { modePolicy, sailThreshMs, simStepM };

    const [sLon, sLat] = args.start;
    const [eLon, eLat] = args.end;

    // Pre-flight endpoint checks against the exact polygons.
    if (this.landMask.isLandExact(sLon, sLat)) {
      throw new RouteError(`start point (${sLat.toFixed(4)}, ${sLon.toFixed(4)}) is on land`);
    }
    if (this.landMask.isLandExact(eLon, eLat)) {
      throw new RouteError(`end point (${eLat.toFixed(4)}, ${eLon.toFixed(4)}) is on land`);
    }

    // Goal queue: vias then the end (radius 0).
    const goals: Via[] = [];
    if (args.vias) {
      args.vias.forEach((v, idx) => {
        if (!(v.radiusM > 0)) throw new RouteError(`via ${idx} arrival radius must be > 0 (got ${v.radiusM})`);
        if (this.landMask.isLandExact(v.lon, v.lat)) {
          throw new RouteError(`via ${idx} (${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}) is on land`);
        }
        goals.push({ ...v });
      });
    }
    goals.push({ lon: eLon, lat: eLat, radiusM: 0 });
    const nVias = goals.length - 1;
    let startViaCount = 0;
    while (startViaCount < nVias) {
      const g = goals[startViaCount];
      if (haversineDistanceM(sLon, sLat, g.lon, g.lat) <= g.radiusM) startViaCount++;
      else break;
    }

    // Distance budget.
    let chainDist = 0;
    let prev: [number, number] = [sLon, sLat];
    for (const g of goals) {
      chainDist += haversineDistanceM(prev[0], prev[1], g.lon, g.lat);
      prev = [g.lon, g.lat];
    }
    const totalDistM = Math.max(chainDist, haversineDistanceM(sLon, sLat, eLon, eLat));
    if (totalDistM <= 0) {
      const wp: Waypoint = { lon: sLon, lat: sLat, time: args.departureTime, sogMs: 0, cogDeg: 0, mode: 'motoring', leg: 'ocean' };
      return { waypoints: [wp], totalTimeS: 0, totalDistanceM: 0, motoringTimeS: 0, sailingTimeS: 0, validated: true };
    }
    const cruise = vessel.motorSpeedMs;
    if (!(cruise > 0)) throw new RouteError('vessel.motorSpeedMs must be > 0');
    // Stage budget. The reference implementation sizes K stages to the
    // straight-line distance; here the budget is re-sized to the coarse
    // skeleton's length once it is known (below), so a passage that must
    // detour around land still fits in K stages instead of running out
    // of stages short of the destination.
    let budgetDistM = totalDistM;
    let dtS = (budgetDistM / cruise) / this.K;
    let deltaD = budgetDistM / (2 * this.k);
    let candStepM = cruise * dtS;

    // ---- Coarse A* skeleton -------------------------------------------
    const chainEndpoints: [number, number][] = [[sLon, sLat], ...goals.slice(0, -1).map((g) => [g.lon, g.lat] as [number, number]), [eLon, eLat]];
    let skeleton: { lon: number; lat: number }[] | null = null;
    let skeletonCum: number[] | null = null;
    try {
      const bbox = bboxFromLonLat(chainEndpoints.map((p) => p[0]), chainEndpoints.map((p) => p[1]), this.skeletonPaddingDeg);
      const t0 = Date.now();
      const coarse = buildCoarseGrid(this.landMask, bbox, this.skeletonResolutionDeg);
      progress(0, this.K, `skeleton grid ${coarse.spec.nx}x${coarse.spec.ny} at ${this.skeletonResolutionDeg}° built in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      checkCancel();
      const t1 = Date.now();
      // The skeleton is guidance only, so endpoints that fall on a land
      // cell of the coarse raster (a harbour narrower than a cell) are
      // snapped to the nearest passable cell centre for the search.
      const snapped = chainEndpoints.map((p) => snapToPassable(coarse, p, 20));
      const chain: { lon: number; lat: number }[] = [];
      try {
        for (let s = 0; s + 1 < snapped.length; s++) {
          const seg = astarRoute(coarse, snapped[s], snapped[s + 1], cruise);
          if (chain.length) chain.push(...seg.path.slice(1));
          else chain.push(...seg.path);
        }
        skeleton = chain;
      } catch (err) {
        if (!(err instanceof AstarError)) throw err;
        progress(0, this.K, `skeleton chain A* failed (${err.message}); retrying start→end only`);
        skeleton = astarRoute(coarse, snapped[0], snapped[snapped.length - 1], cruise).path;
      }
      // Restore the exact endpoints on the skeleton.
      skeleton[0] = { lon: sLon, lat: sLat };
      skeleton[skeleton.length - 1] = { lon: eLon, lat: eLat };
      skeletonCum = [0];
      for (let i = 1; i < skeleton.length; i++) {
        skeletonCum.push(skeletonCum[i - 1] + haversineDistanceM(skeleton[i - 1].lon, skeleton[i - 1].lat, skeleton[i].lon, skeleton[i].lat));
      }
      progress(0, this.K, `skeleton: ${skeleton.length} points, ${(skeletonCum[skeletonCum.length - 1] / 1000).toFixed(1)} km, A* ${((Date.now() - t1) / 1000).toFixed(1)} s`);
      const skLen = skeletonCum[skeletonCum.length - 1];
      if (skLen > budgetDistM) {
        budgetDistM = skLen;
        dtS = (budgetDistM / cruise) / this.K;
        deltaD = budgetDistM / (2 * this.k);
        candStepM = cruise * dtS;
      }
    } catch (err) {
      if (err instanceof RouteCancelled) throw err;
      progress(0, this.K, `skeleton unavailable (${(err as Error).message}); headings aim straight at the destination`);
      skeleton = null;
      skeletonCum = null;
    }

    progress(0, this.K, `K=${this.K} stages, k=${this.k} subsectors, m=${this.m} headings, step ${(candStepM / 1000).toFixed(1)} km, budget ${(budgetDistM / 1000).toFixed(1)} km (straight ${(totalDistM / 1000).toFixed(1)} km)`);

    const targetForParent = (pLon: number, pLat: number): [number, number] => {
      if (!skeleton || !skeletonCum || skeleton.length < 2) return [eLon, eLat];
      let bestI = 0;
      let bestD = Infinity;
      for (let i = 0; i < skeleton.length; i++) {
        const d = haversineDistanceM(pLon, pLat, skeleton[i].lon, skeleton[i].lat);
        if (d < bestD) {
          bestD = d;
          bestI = i;
        }
      }
      const targetCum = skeletonCum[bestI] + candStepM;
      if (targetCum >= skeletonCum[skeletonCum.length - 1]) return [eLon, eLat];
      for (let i = bestI + 1; i < skeleton.length; i++) {
        if (skeletonCum[i] >= targetCum) return [skeleton[i].lon, skeleton[i].lat];
      }
      return [eLon, eLat];
    };

    // ---- Candidate proposal ----------------------------------------------
    const propose = (parents: Candidate[], sweepM: number, sweepDc: number, stepM: number): Candidate[] => {
      const nH = 2 * sweepM + 1;
      const nP = parents.length;
      const total = nP * nH;
      const pIdx = new Int32Array(total);
      const hdg = new Float64Array(total);
      const cLon = new Float64Array(total);
      const cLat = new Float64Array(total);
      const pLon = new Float64Array(total);
      const pLat = new Float64Array(total);
      let q = 0;
      for (let p = 0; p < nP; p++) {
        const par = parents[p];
        const tgt = targetForParent(par.lon, par.lat);
        const b0 = haversineBearing(par.lon, par.lat, tgt[0], tgt[1]);
        for (let h = -sweepM; h <= sweepM; h++) {
          const b = ((b0 + h * sweepDc) % 360 + 360) % 360;
          const [x, y] = projectAlongBearing(par.lon, par.lat, b, stepM);
          pIdx[q] = p;
          hdg[q] = b;
          cLon[q] = x;
          cLat[q] = y;
          pLon[q] = par.lon;
          pLat[q] = par.lat;
          q++;
        }
      }
      const crosses = this.landMask.legsCrossLandBulk(pLon, pLat, cLon, cLat, this.landStepM);
      const out: Candidate[] = [];
      // Group survivors by parent for batched scoring.
      let start = 0;
      for (let p = 0; p < nP; p++) {
        const end = start + nH;
        const keep: number[] = [];
        for (let i = start; i < end; i++) if (!crosses[i]) keep.push(i);
        start = end;
        if (keep.length === 0) continue;
        const par = parents[p];
        const bearings = new Float64Array(keep.map((i) => hdg[i]));
        const dists = new Float64Array(keep.length).fill(stepM);
        const sc = scoreCandidatesFromParent(par.lon, par.lat, new Date(par.timeMs), bearings, dists, vessel, polar, wind, current, simOpts);
        for (let c = 0; c < keep.length; c++) {
          const secs = sc.seconds[c];
          if (!Number.isFinite(secs) || secs <= 0) continue;
          const i = keep[c];
          const legDist = haversineDistanceM(par.lon, par.lat, cLon[i], cLat[i]);
          const cand: Candidate = {
            lon: cLon[i],
            lat: cLat[i],
            timeMs: par.timeMs + secs * 1000,
            elapsedS: par.elapsedS + secs,
            parentIdx: p,
            sogMs: legDist / secs,
            cogDeg: hdg[i],
            mode: sc.dominant[c] === 1 ? 'sailing' : 'motoring',
            sailingS: sc.sailing[c],
            motoringS: sc.motoring[c],
            viaCount: par.viaCount,
            viaIdxs: [],
          };
          while (cand.viaCount < nVias) {
            const g = goals[cand.viaCount];
            if (segmentWithinDisc(par.lon, par.lat, cand.lon, cand.lat, g.lon, g.lat, g.radiusM)) {
              cand.viaIdxs.push(cand.viaCount);
              cand.viaCount++;
            } else break;
          }
          out.push(cand);
        }
      }
      return out;
    };

    // ---- Stage loop --------------------------------------------------------
    const stages: Candidate[][] = [[{
      lon: sLon, lat: sLat, timeMs: args.departureTime.getTime(), elapsedS: 0, parentIdx: -1,
      sogMs: 0, cogDeg: 0, mode: 'motoring', sailingS: 0, motoringS: 0, viaCount: startViaCount, viaIdxs: [],
    }]];

    for (let stage = 0; stage < this.K; stage++) {
      checkCancel();
      const tStage = Date.now();
      const parents = stages[stages.length - 1];
      if (parents.length === 0) {
        throw new RouteError(
          `stage ${stage} has no live waypoints: every candidate from the previous stage was blocked by land even after widening the heading sweep and halving the step`,
        );
      }
      let cands = propose(parents, this.m, this.deltaC, candStepM);
      if (cands.length === 0) {
        progress(stage + 1, this.K, `primary sweep empty; widening to ±${this.m * 2 * this.deltaC * 2}°`);
        cands = propose(parents, this.m * 2, this.deltaC * 2, candStepM);
      }
      if (cands.length === 0) {
        progress(stage + 1, this.K, `widened sweep empty; trying ±${this.m * 3 * this.deltaC * 2}° with half step`);
        cands = propose(parents, this.m * 3, this.deltaC * 2, candStepM / 2);
      }
      if (cands.length === 0) {
        // Third fallback (beyond the reference implementation): a full
        // 360° sweep at a quarter step, for parents boxed in by a coast
        // whose exits are shorter than half a stage step.
        progress(stage + 1, this.K, 'half step empty; trying full 360° sweep with quarter step');
        cands = propose(parents, 90, 2, candStepM / 4);
      }
      if (cands.length === 0) {
        stages.push([]);
        continue;
      }

      // Subsector pruning.
      const best = new Map<string, number>();
      const cost = new Float64Array(cands.length);
      for (let i = 0; i < cands.length; i++) {
        const c = cands[i];
        const g = goals[c.viaCount];
        cost[i] = c.elapsedS + haversineDistanceM(c.lon, c.lat, g.lon, g.lat) / cruise;
        const off = perpendicularOffsetM(sLon, sLat, eLon, eLat, c.lon, c.lat);
        let bin = Math.floor(off / deltaD);
        if (bin < -this.k) bin = -this.k;
        if (bin > this.k - 1) bin = this.k - 1;
        const key = `${c.viaCount}:${bin}`;
        const cur = best.get(key);
        if (cur === undefined || cost[i] < cost[cur]) best.set(key, i);
      }
      const retained = [...best.values()].map((i) => cands[i]);
      stages.push(retained);

      let bestRemaining = Infinity;
      for (const c of retained) bestRemaining = Math.min(bestRemaining, haversineDistanceM(c.lon, c.lat, eLon, eLat));
      progress(stage + 1, this.K, `${parents.length} parents → ${cands.length} candidates → ${retained.length} retained; best remaining ${(bestRemaining / 1000).toFixed(1)} km; ${((Date.now() - tStage) / 1000).toFixed(1)} s`);

      const eligible = retained.filter((c) => c.viaCount === nVias);
      if (eligible.length) {
        let minDist = Infinity;
        for (const c of eligible) minDist = Math.min(minDist, haversineDistanceM(c.lon, c.lat, eLon, eLat));
        if (args.arrivalRadiusM !== undefined && minDist <= args.arrivalRadiusM) {
          progress(stage + 1, this.K, `early termination: within arrival radius ${args.arrivalRadiusM.toFixed(0)} m (${minDist.toFixed(0)} m)`);
          break;
        }
        if (minDist <= candStepM) {
          progress(stage + 1, this.K, `early termination: within one stage step of destination (${(minDist / 1000).toFixed(1)} km)`);
          break;
        }
      } else if (nVias > 0) {
        const deepest = Math.max(...retained.map((c) => c.viaCount));
        progress(stage + 1, this.K, `via progress: deepest branch crossed ${deepest}/${nVias}`);
      }
    }

    const terminals = stages[stages.length - 1];
    if (terminals.length === 0) throw new RouteError('front went empty before reaching the destination; no path found');
    const score = (c: Candidate): [number, number] => [haversineDistanceM(c.lon, c.lat, eLon, eLat), c.elapsedS];
    const pool = nVias > 0 ? terminals.filter((c) => c.viaCount === nVias) : terminals;
    if (pool.length === 0) {
      const deepest = Math.max(0, ...terminals.map((c) => c.viaCount));
      throw new RouteError(
        `finished ${this.K} stages without any branch crossing all ${nVias} via(s); deepest branch crossed ${deepest}. Widen the via radius, add stages, or move the via.`,
      );
    }
    let bestC = pool[0];
    for (const c of pool) {
      const [d, t] = score(c);
      const [bd, bt] = score(bestC);
      if (d < bd || (d === bd && t < bt)) bestC = c;
    }
    const stageOfBest = stages.findIndex((st) => st.includes(bestC));

    // Final straight leg to the exact destination.
    checkCancel();
    const finalCross = this.landMask.legsCrossLandBulk(
      Float64Array.of(bestC.lon), Float64Array.of(bestC.lat), Float64Array.of(eLon), Float64Array.of(eLat), this.landStepM,
    );
    if (finalCross[0]) {
      throw new RouteError(
        `terminal hop from (${bestC.lat.toFixed(4)}, ${bestC.lon.toFixed(4)}) to the destination crosses land; the propagation got close but the straight final leg is blocked. Try a via point or a closer endpoint.`,
      );
    }
    const simFinal = simulateLegTime(bestC.lon, bestC.lat, new Date(bestC.timeMs), eLon, eLat, vessel, polar, wind, current, simOpts);
    if (!Number.isFinite(simFinal.seconds) || simFinal.seconds <= 0) {
      throw new RouteError(`terminal hop to the destination could not be simulated (stuck under ${modePolicy} given wind/current at the destination)`);
    }
    const legDistFinal = haversineDistanceM(bestC.lon, bestC.lat, eLon, eLat);
    const finalCand: Candidate = {
      lon: eLon, lat: eLat, timeMs: bestC.timeMs + simFinal.seconds * 1000,
      elapsedS: bestC.elapsedS + simFinal.seconds, parentIdx: -1,
      sogMs: legDistFinal / simFinal.seconds, cogDeg: haversineBearing(bestC.lon, bestC.lat, eLon, eLat),
      mode: simFinal.dominantMode === 'sailing' ? 'sailing' : 'motoring',
      sailingS: simFinal.sailingSeconds, motoringS: simFinal.motoringSeconds, viaCount: bestC.viaCount, viaIdxs: [],
    };

    // Back-trace.
    const chain: Candidate[] = [];
    let cur: Candidate | undefined = bestC;
    let curStage = stageOfBest;
    while (cur && curStage >= 0) {
      chain.push(cur);
      if (curStage === 0 || cur.parentIdx < 0) break;
      cur = stages[curStage - 1][cur.parentIdx];
      curStage--;
    }
    chain.reverse();
    if (legDistFinal > 0) chain.push(finalCand);

    // Build waypoints.
    const wps: Waypoint[] = [];
    let motorS = 0;
    let sailS = 0;
    let dist = 0;
    chain.forEach((c, i) => {
      wps.push({
        lon: c.lon, lat: c.lat, time: new Date(c.timeMs),
        sogMs: i > 0 ? c.sogMs : 0, cogDeg: i > 0 ? c.cogDeg : 0,
        mode: i > 0 ? c.mode : 'motoring', leg: 'ocean',
        role: c.viaIdxs.length ? 'via' : undefined,
      });
      if (i > 0) {
        motorS += c.motoringS;
        sailS += c.sailingS;
        dist += haversineDistanceM(chain[i - 1].lon, chain[i - 1].lat, c.lon, c.lat);
      }
    });

    // Enrichment: wind, waves, current at each waypoint's position/time.
    for (const wp of wps) {
      const [ws, wd] = wind.at(wp.lon, wp.lat, wp.time);
      if (Number.isFinite(ws)) {
        wp.windMs = ws;
        wp.windDirDeg = wd;
      }
      if (wind.hasWaves) {
        const wv = wind.wavesAt(wp.lon, wp.lat, wp.time);
        if (wv) {
          wp.swhM = wv.swh;
          wp.mwpS = wv.mwp;
          wp.mwdDeg = wv.mwd;
        }
      }
      const [cu, cv] = current.at(wp.lon, wp.lat, wp.time);
      if (Number.isFinite(cu) && Number.isFinite(cv)) {
        wp.currentUMs = cu;
        wp.currentVMs = cv;
        const sp = Math.hypot(cu, cv);
        wp.currentMs = sp;
        if (sp > 1e-9) wp.currentDirDeg = ((90 - Math.atan2(cv, cu) * 180 / Math.PI) % 360 + 360) % 360;
      }
    }

    const route: Route = {
      waypoints: wps,
      totalTimeS: (wps[wps.length - 1].time.getTime() - wps[0].time.getTime()) / 1000,
      totalDistanceM: dist,
      motoringTimeS: motorS,
      sailingTimeS: sailS,
      validated: false,
    };
    recomputePerWaypointMetadata(route);

    // Final validation against the exact polygons.
    const warns: RouteWarning[] = [];
    for (let i = 0; i + 1 < wps.length; i++) {
      const a = wps[i];
      const b = wps[i + 1];
      if (this.landMask.legCrossesLandExact(a.lon, a.lat, b.lon, b.lat, 100)) {
        warns.push({ leg_index: i, violation: 'leg_crosses_land', from: [a.lon, a.lat], to: [b.lon, b.lat], repaired: false });
      }
    }
    route.validated = true;
    if (warns.length) {
      route.warnings = warns;
      progress(this.K, this.K, `WARNING: ${warns.length} leg(s) cross land in the exact polygon check`);
    }
    progress(this.K, this.K, `done: ${wps.length} waypoints, ${(dist / 1000).toFixed(1)} km, ${(route.totalTimeS / 3600).toFixed(1)} h`);
    return route;
  }
}
