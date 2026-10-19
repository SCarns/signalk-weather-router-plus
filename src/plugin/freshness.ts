/**
 * How fresh each data source in use is, by its own publication cadence: when
 * the next run is due, and whether the plugin is on time with it.
 *
 *   green   more than 30 min before the next run is due;
 *   orange  from 30 min before it is due until 60 min after (it should
 *           arrive soon, or is arriving);
 *   red     more than 60 min after it was due and the old run is still in
 *           use, or nothing is loaded.
 * (The owner's thresholds, 2026-10-19.) Connectivity plays no part: data can
 * be fresh while the connection is down.
 *
 * When each source publishes:
 *  - ECMWF: the cycle time plus its measured lag (data/ecmwf.ts publishedAt),
 *    every 6 h, or 12 h when the horizon needs the 00z/12z runs;
 *  - RTOFS: the run's 00z plus the measured lag of the last file the horizon
 *    needs (RTOFS_PUBLISHED_AFTER_MIN), daily;
 *  - CMEMS SMOC and sea level: when the run appeared in the store (the
 *    timeChunked .zmetadata Last-Modified), daily;
 *  - regional wind (signalk-grib-downloader): the run time plus the model's
 *    cadence and publication delay as the downloader schedules them
 *    (REGIONAL_TIMING);
 *  - tidal harmonics: fixed tables, no cadence: green when loaded, red when a
 *    file failed to load.
 * Pure (the clock is an argument), so the rules are tested with fixed times.
 */

import { HOUR_MS, HOUR_S, MINUTE_MS } from '../geo/units';
import { cycleFor, nextCycle, publishedAt } from '../data/ecmwf';
import { RtofsClient } from '../currents/rtofs';

export type FreshnessState = 'green' | 'orange' | 'red';
export type FreshnessRow = 'wind' | 'waves' | 'currents' | 'tides';

export interface Freshness {
  /** The source as the header names it. */
  source: string;
  /** The header rows it colours. */
  rows: FreshnessRow[];
  /** The run in use (as the source names it), or null when none is. */
  run: string | null;
  /** When the run in use was published, ISO (null: not known, or a fixed table). */
  published_at: string | null;
  /** When the next run is due, ISO (null for a fixed table). */
  next_due_at: string | null;
  state: FreshnessState;
  /** Why it is red when the times do not say it (nothing loaded, a file that failed). */
  reason: string | null;
}

/** Orange from this long before the next run is due. */
export const ORANGE_BEFORE_MS = 30 * MINUTE_MS;
/** Red from this long after it was due. */
export const RED_AFTER_MS = 60 * MINUTE_MS;

const DAY_MS = 24 * HOUR_MS;

export function freshnessState(nowMs: number, nextDueMs: number): FreshnessState {
  if (nowMs < nextDueMs - ORANGE_BEFORE_MS) return 'green';
  if (nowMs < nextDueMs + RED_AFTER_MS) return 'orange';
  return 'red';
}

const iso = (ms: number): string => new Date(ms).toISOString();

function timed(source: string, rows: FreshnessRow[], run: string, publishedMs: number | null, nextDueMs: number, nowMs: number): Freshness {
  return {
    source,
    rows,
    run,
    published_at: publishedMs === null ? null : iso(publishedMs),
    next_due_at: iso(nextDueMs),
    state: freshnessState(nowMs, nextDueMs),
    reason: null,
  };
}

function missing(source: string, rows: FreshnessRow[], reason: string): Freshness {
  return { source, rows, run: null, published_at: null, next_due_at: null, state: 'red', reason };
}

/** ECMWF wind (and waves when the run has them): the cycle in use against the next one the horizon can use. */
export function ecmwfFreshness(cycleTimeMs: number | null, horizonS: number, hasWaves: boolean, nowMs: number): Freshness {
  const rows: FreshnessRow[] = hasWaves || cycleTimeMs === null ? ['wind', 'waves'] : ['wind'];
  if (cycleTimeMs === null) return missing('ECMWF', rows, 'no forecast loaded');
  const c = cycleFor(new Date(cycleTimeMs));
  return timed('ECMWF', rows, `${c.yyyymmdd} ${c.hh}z`, publishedAt(c).getTime(), publishedAt(nextCycle(c, horizonS)).getTime(), nowMs);
}

/**
 * Minutes after the run's 00z at which each RTOFS file appears on NOMADS
 * (Last-Modified of the west_atl files of the 2026-10-18 run: f024 09:35:48,
 * f048 09:36:00, f072 09:41:30, f144 15:37:39 UTC; one day measured, NOMADS
 * keeps two), rounded up to the minute.
 */
export const RTOFS_PUBLISHED_AFTER_MIN: Record<string, number> = { f024: 576, f048: 576, f072: 582, f144: 938 };

/** RTOFS: the daily run in use (its 00z, ms) against the next day's, by the last file the horizon needs. */
export function rtofsFreshness(name: string, runMs: number | null, horizonS: number, nowMs: number): Freshness {
  if (runMs === null) return missing(name, ['currents'], 'no RTOFS run loaded');
  const files = RtofsClient.filesFor(horizonS / HOUR_S);
  const lagMs = RTOFS_PUBLISHED_AFTER_MIN[files[files.length - 1].name] * MINUTE_MS;
  return timed(name, ['currents'], iso(runMs).slice(0, 10), runMs + lagMs, runMs + DAY_MS + lagMs, nowMs);
}

/** CMEMS SMOC or sea level: the run in use, published when it appeared in the store, against the next daily update. */
export function arcoFreshness(
  name: string,
  rows: FreshnessRow[],
  run: string | null,
  appearedIso: string | null,
  nowMs: number
): Freshness {
  if (run === null) return missing(name, rows, 'no run loaded');
  const appeared = appearedIso ? Date.parse(appearedIso) : NaN;
  if (Number.isNaN(appeared)) return { ...missing(name, rows, `run ${run}: the store gave no publication time`), run };
  return timed(name, rows, run, appeared, appeared + DAY_MS, nowMs);
}

/**
 * Cadence and publication delay of the regional models, hours. GFS, ARPEGE
 * and ICON-EU: as signalk-grib-downloader 0.2.4 schedules its downloads
 * (dist/scheduler.js MODEL_TIMING), not measured here. AROME's delay depends
 * on the run (AROME_PUBLISHED_AFTER_MIN); its 2.75 h there holds only for
 * the 00z and 03z runs.
 */
export const REGIONAL_TIMING: Record<string, { cadenceH: number; delayH: number }> = {
  gfs: { cadenceH: 6, delayH: 5.5 },
  arome: { cadenceH: 3, delayH: 2.75 },
  arpege: { cadenceH: 6, delayH: 4.5 },
  'icon-eu': { cadenceH: 6, delayH: 4.0 },
};

/**
 * Minutes after each AROME run (by its hour) at which its last file (0.025°,
 * SP1, 49H51H) appears on Météo-France's public bucket: the latest
 * Last-Modified of the runs from 2026-10-16 00z to 2026-10-19 03z, rounded
 * up (00z 2.80–2.88 h, 03z 2.66–2.77 h, 06z 5.16–5.59 h, 09z 4.25–4.30 h,
 * 12z 4.01–4.18 h, 15z 3.88–3.90 h, 18z 5.12–5.28 h, 21z 4.19–4.20 h).
 */
export const AROME_PUBLISHED_AFTER_MIN: Record<number, number> = {
  0: 173,
  3: 167,
  6: 336,
  9: 259,
  12: 252,
  15: 234,
  18: 317,
  21: 252,
};

/** When a regional model's run (00z time, ms) is published. */
function regionalPublishedMs(model: string, runMs: number): number {
  if (model === 'arome') {
    const lag = AROME_PUBLISHED_AFTER_MIN[new Date(runMs).getUTCHours()];
    if (lag !== undefined) return runMs + lag * MINUTE_MS;
  }
  return runMs + REGIONAL_TIMING[model].delayH * HOUR_MS;
}

/** A regional wind model in use: its decoded run (yyyymmddHH) against the model's next run. */
export function regionalFreshness(name: string, model: string, decodedCycle: string | null, nowMs: number): Freshness {
  const t = REGIONAL_TIMING[model];
  if (!t) return missing(name, ['wind'], `no publication schedule known for model ${model}`);
  if (!decodedCycle) return missing(name, ['wind'], 'no run decoded');
  const runMs = Date.UTC(+decodedCycle.slice(0, 4), +decodedCycle.slice(4, 6) - 1, +decodedCycle.slice(6, 8), +decodedCycle.slice(8, 10));
  return timed(
    name,
    ['wind'],
    `${decodedCycle.slice(0, 8)} ${decodedCycle.slice(8, 10)}z`,
    regionalPublishedMs(model, runMs),
    regionalPublishedMs(model, runMs + t.cadenceH * HOUR_MS),
    nowMs
  );
}

/** Tidal harmonics: fixed tables, green when loaded. */
export function harmonicFreshness(name: string): Freshness {
  return { source: name, rows: ['currents'], run: null, published_at: null, next_due_at: null, state: 'green', reason: null };
}

/** A harmonic file that failed to load ("file: reason"). */
export function harmonicFailure(error: string): Freshness {
  const i = error.indexOf(': ');
  return missing(i > 0 ? error.slice(0, i) : 'tidal harmonics', ['currents'], i > 0 ? error.slice(i + 2) : error);
}
