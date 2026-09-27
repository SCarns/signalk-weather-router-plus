/**
 * Fetch, decode and crop the forecast fields a route needs into a
 * ForecastStore. Fetching goes through the disk cache in EcmwfClient,
 * so repeated loads for the same cycle only decode.
 */

import type { BBox } from '../geo/geodesy';
import { parseGrib2Message } from '../grib/grib2';
import { ATM_PARAMS, WAVE_PARAMS, availableSteps, type Cycle, type EcmwfClient } from './ecmwf';
import { buildStep, ForecastStore, type ForecastStep } from './forecast';

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

export async function loadForecastForBBox(client: EcmwfClient, bbox: BBox, opts: LoadOptions): Promise<ForecastStore> {
  const log = opts.log ?? (() => undefined);
  const cycle = opts.cycle ?? (await client.findLatestCycle(opts.horizonHours));
  const includeWaves = opts.includeWaves ?? true;
  const atmParams = [...ATM_PARAMS, ...(opts.extraAtmParams ?? [])];
  const steps = availableSteps(cycle.atmStream, opts.horizonHours);
  const waveSteps = new Set(availableSteps(cycle.waveStream, opts.horizonHours));
  const built: ForecastStep[] = [];
  let done = 0;
  for (const step of steps) {
    if (opts.shouldCancel?.()) throw new Error('forecast load cancelled');
    const named: { param: string; message: ReturnType<typeof parseGrib2Message> }[] = [];
    const atmIndex = await client.fetchIndex(cycle, cycle.atmStream, step);
    for (const p of atmParams) {
      const msg = await client.fetchField(cycle, cycle.atmStream, step, p, atmIndex);
      if (!msg) {
        if (p === '10u' || p === '10v') throw new Error(`cycle ${cycle.yyyymmdd}${cycle.hh} step +${step}h has no ${p}`);
        log(`step +${step}h: ${p} not in index, skipped`);
        continue;
      }
      named.push({ param: p, message: parseGrib2Message(msg) });
    }
    if (includeWaves && waveSteps.has(step)) {
      const waveIndex = await client.fetchIndex(cycle, cycle.waveStream, step);
      for (const p of WAVE_PARAMS) {
        const msg = await client.fetchField(cycle, cycle.waveStream, step, p, waveIndex);
        if (!msg) {
          log(`step +${step}h: wave ${p} not in index, skipped`);
          continue;
        }
        named.push({ param: p, message: parseGrib2Message(msg) });
      }
    }
    built.push(buildStep(named, bbox, opts.waveFillCells ?? 3));
    done++;
    opts.onStep?.(done, steps.length);
    // Yield to the event loop between steps so a host process stays responsive.
    await new Promise((r) => setImmediate(r));
  }
  log(`loaded ${built.length} steps for cycle ${cycle.yyyymmdd} ${cycle.hh}z`);
  return new ForecastStore(built, {
    cycleTime: cycle.time, bbox, steps, params: [...atmParams, ...(includeWaves ? WAVE_PARAMS : [])], loadedAt: new Date(),
  });
}
