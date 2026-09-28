/**
 * Fetch and decode the forecast fields into a ForecastStore (global, or
 * cropped to a bbox), and decide which cycle to use without touching the
 * network when fresh data is already on disk.
 */

import type { BBox } from '../geo/geodesy';
import { parseGrib2Message, type DecodeScratch } from '../grib/grib2';
import {
  ATM_PARAMS, WAVE_PARAMS, availableSteps, latestExpectedCycle,
  type Cycle, type EcmwfClient, type IndexRecord,
} from './ecmwf';
import { buildStep, ForecastStore, GLOBAL_BBOX, type ForecastStep } from './forecast';

export interface LoadOptions {
  horizonHours: number;
  cycle?: Cycle;
  includeWaves?: boolean;
  /** Extra parameters from the atmosphere stream (e.g. '2t', 'tprate'). */
  extraAtmParams?: string[];
  log?: (msg: string) => void;
  shouldCancel?: () => boolean;
  /** Called after each step is decoded. */
  onStep?: (done: number, total: number) => void;
  /** Wave NaN fill radius in cells. */
  waveFillCells?: number;
}

export interface ResolvedCycle {
  cycle: Cycle;
  /** True when every needed message is already on disk (no network needed). */
  fromCache: boolean;
  /** Set when the network was unavailable and an older cached cycle was chosen. */
  fallback?: string;
}

/**
 * Choose the cycle to load, planner-style:
 *  1. the wall-clock expected cycle when it is fully cached → no network;
 *  2. otherwise ask the server for the newest complete cycle;
 *  3. if that fails, the newest fully cached cycle, if any.
 */
export async function resolveCycle(
  client: EcmwfClient, horizonHours: number,
  opts: { now?: Date; includeWaves?: boolean; extraAtmParams?: string[]; log?: (m: string) => void } = {},
): Promise<ResolvedCycle> {
  const log = opts.log ?? (() => undefined);
  const atm = [...ATM_PARAMS, ...(opts.extraAtmParams ?? [])];
  const wave = opts.includeWaves === false ? [] : [...WAVE_PARAMS];
  const expected = latestExpectedCycle(opts.now ?? new Date(), horizonHours);
  if (client.cycleFullyCached(expected, horizonHours, atm, wave)) {
    log(`expected cycle ${expected.yyyymmdd} ${expected.hh}z is fully cached; no download needed`);
    return { cycle: expected, fromCache: true };
  }
  try {
    const cycle = await client.findLatestCycle(horizonHours, { now: opts.now });
    return { cycle, fromCache: client.cycleFullyCached(cycle, horizonHours, atm, wave) };
  } catch (err) {
    const cached = client.cachedCycles().find((c) => client.cycleFullyCached(c, horizonHours, atm, wave));
    if (cached) {
      const msg = `ECMWF unreachable (${(err as Error).message}); using cached cycle ${cached.yyyymmdd} ${cached.hh}z`;
      log(msg);
      return { cycle: cached, fromCache: true, fallback: msg };
    }
    throw err;
  }
}

/**
 * Load the whole globe (no crop) into a SharedArrayBuffer-backed store.
 * Fields already in the disk cache are read from it; the rest are
 * fetched. Messages are cached whole on disk either way, so a global
 * load downloads exactly what a cropped one did.
 */
export function loadGlobalForecast(client: EcmwfClient, opts: LoadOptions): Promise<ForecastStore> {
  return loadForecast(client, null, opts);
}

/** Load a bbox crop (the route worker's first-boot fallback and the CLI). */
export function loadForecastForBBox(client: EcmwfClient, bbox: BBox, opts: LoadOptions): Promise<ForecastStore> {
  return loadForecast(client, bbox, opts);
}

async function loadForecast(client: EcmwfClient, bbox: BBox | null, opts: LoadOptions): Promise<ForecastStore> {
  const log = opts.log ?? (() => undefined);
  const includeWaves = opts.includeWaves ?? true;
  const atmParams = [...ATM_PARAMS, ...(opts.extraAtmParams ?? [])];
  const cycle = opts.cycle ?? (await resolveCycle(client, opts.horizonHours, { includeWaves, extraAtmParams: opts.extraAtmParams, log })).cycle;
  const steps = availableSteps(cycle.atmStream, opts.horizonHours);
  const waveSteps = new Set(availableSteps(cycle.waveStream, opts.horizonHours));
  const built: ForecastStep[] = [];
  // One set of decode buffers for every field (~12 MB for 0.25° global)
  // instead of fresh ones per field: a 72 h load decodes ~275 fields.
  const scratch: DecodeScratch = {};
  let done = 0;
  let downloaded = 0;
  for (const step of steps) {
    if (opts.shouldCancel?.()) throw new Error('forecast load cancelled');
    const named: { param: string; message: ReturnType<typeof parseGrib2Message> }[] = [];
    // The index is only needed for fields not already on disk.
    let atmIndex: IndexRecord[] | undefined;
    for (const p of atmParams) {
      if (!client.hasCached(cycle, cycle.atmStream, step, p)) {
        atmIndex = atmIndex ?? (await client.fetchIndex(cycle, cycle.atmStream, step));
        downloaded++;
      }
      const msg = await client.fetchField(cycle, cycle.atmStream, step, p, atmIndex);
      if (!msg) {
        if (p === '10u' || p === '10v') throw new Error(`cycle ${cycle.yyyymmdd}${cycle.hh} step +${step}h has no ${p}`);
        log(`step +${step}h: ${p} not in index, skipped`);
        continue;
      }
      named.push({ param: p, message: parseGrib2Message(msg) });
    }
    if (includeWaves && waveSteps.has(step)) {
      let waveIndex: IndexRecord[] | undefined;
      for (const p of WAVE_PARAMS) {
        if (!client.hasCached(cycle, cycle.waveStream, step, p)) {
          waveIndex = waveIndex ?? (await client.fetchIndex(cycle, cycle.waveStream, step));
          downloaded++;
        }
        const msg = await client.fetchField(cycle, cycle.waveStream, step, p, waveIndex);
        if (!msg) {
          log(`step +${step}h: wave ${p} not in index, skipped`);
          continue;
        }
        named.push({ param: p, message: parseGrib2Message(msg) });
      }
    }
    built.push(buildStep(named, bbox, opts.waveFillCells ?? 3, scratch));
    done++;
    opts.onStep?.(done, steps.length);
    // Yield to the event loop between steps so a host process stays responsive.
    await new Promise((r) => setImmediate(r));
  }
  log(`loaded ${built.length} steps for cycle ${cycle.yyyymmdd} ${cycle.hh}z (${downloaded} fields downloaded, rest from cache)`);
  return new ForecastStore(built, {
    cycleTime: cycle.time, bbox: bbox ?? GLOBAL_BBOX, steps, params: [...atmParams, ...(includeWaves ? WAVE_PARAMS : [])], loadedAt: new Date(),
  });
}
