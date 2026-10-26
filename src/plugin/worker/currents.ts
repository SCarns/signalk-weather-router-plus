/**
 * Currents: the stack of sources (tidal harmonics, CMEMS SMOC, RTOFS), their refresh, and SMOC loaded on demand for a query.
 *
 * Split from plugin/worker.ts (docs/plans/structural-cleanup.md, phase
 * 2.2): the same functions with the worker's state passed explicitly
 * instead of module-level variables.
 */

import { HOUR_MS, HOUR_S, MINUTE_MS } from '../../geo/units';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type BBox } from '../../geo/geodesy';
import { HarmonicCurrentSource } from '../../currents/harmonic';
import { CurrentStack } from '../../currents/stack';
import {
  chooseRtofsProduct,
  extentOfField,
  finestFirst,
  loadRtofsExtents,
  loadRtofsSteps,
  noteRtofsExtent,
  readRtofsExtents,
  RTOFS_REGIONS,
  RtofsClient,
  RtofsCurrentSource,
  type RtofsRun,
  rtofsRunFor,
  shareRtofsSteps,
} from '../../currents/rtofs';
import { type CurrentSourceLike } from '../../currents/types';
import {
  alignedSteps,
  loadResident,
  residentStale,
  SMOC_DEFAULT_BUDGET_BYTES,
  SmocClient,
  SmocCurrentSource,
  type SmocRun,
  type SmocSettings,
} from '../../currents/smoc';
import { isOffline, OfflineError } from '../../data/http';
import { type ResolvedConfig } from '../config';
import { type CheckedSource, type CheckOutcome, type DataStatus, type QueryArgs } from '../protocol';
import { backgroundHold, requireInit } from './state';
import type { WorkerState } from './state';

/** Overlay / conditions queries wait at most this long for an on-demand SMOC load. */
const SMOC_QUERY_DEADLINE_MS = MINUTE_MS;

export function rebuildStack(st: WorkerState): void {
  const sources: CurrentSourceLike[] = [...st.harmonic];
  if (st.smoc) sources.push(st.smoc);
  sources.push(...st.rtofs);
  st.stack = new CurrentStack(sources);
}

export function currentsStatus(st: WorkerState): DataStatus['currents'] {
  return st.stack.sources.map(s => {
    if (s instanceof SmocCurrentSource) {
      const st = s.status();
      return {
        name: s.name,
        priority: s.priority,
        resolutionM: s.resolutionM,
        bbox: st.resident ? st.resident.bbox : s.bbox,
        validFrom: st.resident?.valid_from ?? undefined,
        validTo: st.resident?.valid_to ?? undefined,
        smoc: st,
      };
    }
    return {
      name: s.name,
      priority: s.priority,
      resolutionM: s.resolutionM,
      bbox: s.bbox,
      validFrom: s instanceof RtofsCurrentSource ? s.validRange[0].toISOString() : undefined,
      validTo: s instanceof RtofsCurrentSource ? s.validRange[1].toISOString() : undefined,
    };
  });
}

export function sendCurrents(st: WorkerState): void {
  st.send({
    type: 'currents',
    status: currentsStatus(st),
    rtofsRuns: st.rtofs.map(s => `${s.product} ${new Date(s.runMs).toISOString().slice(0, 10)}`),
  });
}

export function smocSettings(cfg: ResolvedConfig): SmocSettings {
  return {
    stepS: cfg.currents.smocStepS,
    horizonS: cfg.currents.smocHorizonS,
    halfWidthDeg: cfg.currents.smocHalfWidthDeg,
    budgetBytes: SMOC_DEFAULT_BUDGET_BYTES,
  };
}

export function makeSmocClient(st: WorkerState, cfg: ResolvedConfig): SmocClient | null {
  if (!cfg.currents.smocEnabled) return null;
  return new SmocClient({ cacheDir: path.join(st.cacheRoot, 'smoc'), log: m => st.log('debug', m) });
}

/** data worker → main → route worker: the run and the resident area (shared memory). */
export function sendSmoc(st: WorkerState): void {
  if (st.role === 'data') st.send({ type: 'smoc', smoc: st.smoc ? st.smoc.serialize() : null });
}

/** Record what a source's check found (st.checks, reported in the data status). */
export function noteCheck(st: WorkerState, source: CheckedSource, outcome: CheckOutcome, reason: string | null): void {
  st.checks[source] = { outcome, at: new Date().toISOString(), reason };
}

/**
 * Data worker: check the store for a new daily run (cheap: .zmetadata +
 * STAC), load the resident area around the vessel for the current
 * window when the run, the window or the position changed, and prune
 * superseded cached runs. Offline, the newest cached run is used.
 * `offline`: this round already found no connection; the store is not asked.
 */
export async function refreshSmoc(st: WorkerState, offline: string | null = null): Promise<void> {
  const { config: cfg } = requireInit(st);
  if (!cfg.currents.smocEnabled || !st.smocClient) {
    delete st.checks.smoc;
    if (st.smoc) {
      st.smoc = null;
      rebuildStack(st);
      sendSmoc(st);
    }
    return;
  }
  const settings = smocSettings(cfg);
  let run: SmocRun | null;
  let checked: { outcome: CheckOutcome; reason: string | null };
  try {
    if (offline) throw new OfflineError(offline);
    const probed = await st.smocClient.probe(st.smoc?.run ?? null);
    if (probed.settled || !st.smoc) {
      run = probed;
      if (!probed.settled)
        st.log(
          'info',
          `smoc: the store update is still being written (STAC updated ${probed.stacUpdated ?? '?'}, metadata ${probed.metadataModified ?? '?'}); using run ${probed.key} provisionally`
        );
    } else {
      st.log(
        'info',
        `smoc: store update in progress (STAC updated ${probed.stacUpdated ?? '?'}, metadata ${probed.metadataModified ?? '?'}); keeping run ${st.smoc.run.key}`
      );
      run = st.smoc.run;
    }
    checked = { outcome: 'newest', reason: run.settled ? null : `run ${run.key} is still being written by Copernicus Marine` };
  } catch (err) {
    if (!offline) st.log('error', `smoc: cannot reach the Copernicus Marine store: ${(err as Error).message}`);
    run = st.smoc?.run ?? st.smocClient.cachedRuns()[0] ?? null;
    if (run && !st.smoc) st.log('info', `smoc: using cached run ${run.key} (offline)`);
    checked = { outcome: 'could-not-check', reason: (err as Error).message };
  }
  if (!run) {
    noteCheck(st, 'smoc', checked.outcome, checked.reason);
    return;
  }
  // A run first loaded while its update was still being written is
  // reloaded from scratch once the update has finished (its cached
  // chunks may predate the update).
  const provisionalReplaced = !!st.smoc && st.smoc.run.key === run.key && !st.smoc.run.settled && run.settled;
  const newRun = !st.smoc || st.smoc.run.key !== run.key || provisionalReplaced;
  const now = Date.now();
  const steps = alignedSteps(run, now, now + settings.horizonS * 1000, settings.stepS / HOUR_S);
  const src = newRun ? new SmocCurrentSource(run, settings, st.smocClient, m => st.log('info', m)) : st.smoc!;
  if (!newRun) src.expire(now);
  if (newRun) st.smocClient.saveRun(run);
  const pos = st.vesselPos;
  let changed = newRun;
  if (pos && (newRun || residentStale(src, pos, steps))) {
    // A background round loads no resident area while the internet state holds (its missing chunks would be
    // downloaded), and stops one under way between chunks once it starts holding (worker.ts 'internet-hold').
    let hold = backgroundHold(st);
    try {
      const t = Date.now();
      const res = hold
        ? null
        : await loadResident(st.smocClient, run, settings, pos, steps, {
            log: m => st.log('info', m),
            shouldCancel: () => backgroundHold(st) !== null,
          });
      if (res) {
        src.setResident(res.area, pos);
        src.noteDownload('resident area', res.stats);
        changed = true;
        st.log(
          'info',
          `smoc: run ${run.key}: resident ${res.area.nRows}×${res.area.nCols} cells × ${steps.length} steps, ${(src.memoryBytes() / 1e6).toFixed(1)} MB resident, downloaded ${(res.stats.bytes / 1e6).toFixed(1)} MB in ${((Date.now() - t) / 1000).toFixed(1)} s`
        );
      }
    } catch (err) {
      hold = backgroundHold(st);
      if (!hold) {
        st.log('error', `smoc: resident area load failed: ${(err as Error).message}`);
        if (newRun && st.smoc) {
          // Keep serving the previous run.
          noteCheck(st, 'smoc', isOffline(err) ? 'could-not-check' : 'failed', `run ${run.key}: ${(err as Error).message}`);
          return;
        }
      }
    }
    if (hold) {
      st.log('info', `smoc: run ${run.key}: the resident area is not loaded: ${hold}`);
      checked = { outcome: 'could-not-check', reason: `skipped: ${hold}` };
      // As after a failed load: the previous run keeps serving.
      if (newRun && st.smoc) {
        noteCheck(st, 'smoc', checked.outcome, checked.reason);
        return;
      }
    }
  } else if (newRun && !pos) {
    st.log('info', `smoc: run ${run.key}: no vessel position; nothing resident, areas load on demand`);
  }
  if (checked.outcome === 'newest' && newRun)
    checked = { outcome: 'new-run', reason: `run ${run.key}${run.settled ? '' : ' (still being written)'}` };
  noteCheck(st, 'smoc', checked.outcome, checked.reason);
  if (newRun) {
    st.smoc = src;
    // Also removes the provisional directory the settled run replaces: only
    // now, so a failed load above leaves the still-serving run its chunks.
    const removed = st.smocClient.pruneRuns([run]);
    if (removed.length) st.log('info', `smoc: removed superseded cached run(s) ${removed.join(', ')}`);
  }
  if (changed || newRun) {
    rebuildStack(st);
    sendSmoc(st);
  }
}

/**
 * Before an overlay / conditions query: load SMOC for the query box on
 * demand when it is not resident (bounded wait; see ensure()). False
 * when the answer will lack SMOC data it should have.
 */
export async function prepareSmocForQuery(st: WorkerState, kind: string, args: QueryArgs[keyof QueryArgs]): Promise<boolean> {
  if (!st.smoc || !st.config?.currents.smocEnabled) return true;
  const src = st.smoc;
  let bbox: BBox | null;
  let steps: number[];
  let coarseOk = false;
  switch (kind) {
    case 'field': {
      const a = args as QueryArgs['field'];
      if (a.layer !== 'current' && a.layer !== 'sea_state') return true;
      bbox = a.bbox;
      steps = src.bracketSteps(a.timeMs);
      coarseOk = a.res >= 0.25;
      break;
    }
    case 'currents':
    case 'sea_points': {
      const a = args as QueryArgs['currents'];
      bbox = a.bbox;
      steps = src.bracketSteps(a.timeMs);
      coarseOk = a.res >= 0.25;
      break;
    }
    case 'conditions': {
      const a = args as QueryArgs['conditions'];
      bbox = { west: a.lon - 0.05, east: a.lon + 0.05, south: a.lat - 0.05, north: a.lat + 0.05 };
      const end = Math.min(a.fromMs + a.hours * HOUR_MS, Date.now() + src.settings.horizonS * 1000);
      steps = src.stepsBetween(a.fromMs, Math.max(a.fromMs, end));
      break;
    }
    default:
      return true;
  }
  if (!bbox || steps.length === 0) return true;
  let complete = true;
  try {
    await src.ensure(bbox, steps, {
      reason: `${kind} query`,
      deadlineMs: SMOC_QUERY_DEADLINE_MS,
      coarseOk,
      onIncomplete: () => (complete = false),
    });
  } catch (err) {
    st.log('error', (err as Error).message);
    complete = false;
  }
  return complete;
}

export function loadHarmonic(st: WorkerState, dir: string | null): void {
  st.harmonic = [];
  st.harmonicErrors = [];
  if (!dir) return;
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter(f => f.toLowerCase().endsWith('.npz'))
      .sort();
  } catch (err) {
    st.log('error', `currents: cannot read harmonic directory ${dir}: ${(err as Error).message}`);
    st.harmonicErrors.push(`${dir}: ${(err as Error).message}`);
    return;
  }
  for (const f of files) {
    const p = path.join(dir, f);
    try {
      const t = Date.now();
      const s = new HarmonicCurrentSource(p);
      st.harmonic.push(s);
      st.log(
        'info',
        `currents: ${s.name}: ${s.constituents.length} constituents${s.dropped.length ? ` (dropped ${s.dropped.join(', ')})` : ''}, ${s.lats.length}×${s.lons.length} grid, priority ${s.priority}, ${(s.blockBytes() / 1e6).toFixed(1)} MB shared, ${Date.now() - t} ms`
      );
    } catch (err) {
      st.log('error', `currents: failed to load ${p}: ${(err as Error).message}`);
      st.harmonicErrors.push(`${f}: ${(err as Error).message}`);
    }
  }
}

/** data worker → main → route and tiles workers: the RTOFS products (shared memory, no copy), with the setting they were loaded under. */
export function sendRtofs(st: WorkerState): void {
  if (st.role !== 'data') return;
  const cfg = st.config;
  st.send({
    type: 'rtofs',
    rtofs: cfg?.currents.rtofsEnabled ? { extra: [...cfg.currents.rtofsExtra], runs: st.rtofs.map(s => s.serialize()) } : null,
  });
}

/** The RTOFS cache directory: every product, read by every worker and the mesh process. */
export function rtofsCacheDir(st: WorkerState): string {
  return path.join(st.cacheRoot, 'rtofs');
}

function rtofsClientFor(st: WorkerState, product: string): RtofsClient {
  let c = st.rtofsClients.get(product);
  if (!c) {
    c = new RtofsClient({ cacheDir: rtofsCacheDir(st), region: product, log: m => st.log('debug', m) });
    st.rtofsClients.set(product, c);
  }
  return c;
}

/**
 * Data worker: load the RTOFS products wanted now into shared memory and
 * relay them. Wanted: the product that contains the vessel (the finest
 * where two overlap; none without a position or where none does) and the
 * extra products from the settings. Each one's newest run comes from the
 * network, else the disk cache; a product no longer wanted is dropped. The
 * route and tiles workers do not load RTOFS themselves: they adopt the
 * data worker's products ('rtofs' message). True when the products in use
 * changed (and were relayed).
 */
export async function refreshRtofs(st: WorkerState, networkAllowed: boolean, offline: string | null = null): Promise<boolean> {
  const { config: cfg } = requireInit(st);
  if (st.role !== 'data') return false;
  const dropChecks = (keep: ReadonlySet<string>): void => {
    for (const k of Object.keys(st.checks) as CheckedSource[]) if (k.startsWith('rtofs:') && !keep.has(k.slice(6))) delete st.checks[k];
  };
  if (!cfg.currents.rtofsEnabled) {
    dropChecks(new Set());
    st.rtofsChoice = null;
    if (st.rtofs.length) {
      st.rtofs = [];
      rebuildStack(st);
      sendRtofs(st);
      return true;
    }
    return false;
  }
  const cacheDir = rtofsCacheDir(st);
  let off = offline;
  let extents = readRtofsExtents(cacheDir);
  let unknown: string[] = RTOFS_REGIONS.filter(r => !extents[r]);
  if (unknown.length) {
    try {
      if (off) throw new OfflineError(off);
      ({ extents, unknown } = await loadRtofsExtents(cacheDir, { network: networkAllowed, log: m => st.log('info', m) }));
    } catch (err) {
      if (isOffline(err)) off = off ?? (err as Error).message;
      else st.log('error', `rtofs: the products' extents could not be read: ${(err as Error).message}`);
    }
  }
  const choice = chooseRtofsProduct(extents, st.vesselPos);
  if (choice.product !== (st.rtofsChoice?.auto ?? null) || choice.reason !== (st.rtofsChoice?.autoReason ?? null))
    st.log('info', choice.product ? `rtofs: the vessel is in product ${choice.product}` : `rtofs: ${choice.reason}`);
  st.rtofsChoice = { auto: choice.product, autoReason: choice.reason, unknownExtents: unknown };
  const wanted = finestFirst([...new Set([...(choice.product ? [choice.product] : []), ...cfg.currents.rtofsExtra])], extents);
  const loaded: RtofsCurrentSource[] = [];
  const keep: RtofsRun[] = [];
  let newRun = false;
  for (const product of wanted) {
    const r = await refreshRtofsProduct(st, product, st.rtofs.find(s => s.product === product) ?? null, off);
    if (r.src) loaded.push(r.src);
    keep.push(...r.keep);
    newRun ||= r.newRun;
  }
  dropChecks(new Set(wanted));
  const changed = loaded.length !== st.rtofs.length || loaded.some((s, i) => s !== st.rtofs[i]);
  if (changed) {
    st.rtofs = loaded;
    rebuildStack(st);
    sendRtofs(st);
  }
  // One prune for every product: the cache is kept by run date, a date directory holding each product's files.
  if (newRun) rtofsClientFor(st, wanted[0]).pruneCache(keep);
  return changed;
}

/**
 * One product: its newest run (today's when fully cached, else the newest
 * published, else the newest in the cache when NOMADS cannot be asked),
 * loaded when it is not the one in use. Returns the source to use (the
 * current one when nothing newer loads), the runs whose files are kept,
 * and whether a new run was loaded.
 */
async function refreshRtofsProduct(
  st: WorkerState,
  product: string,
  current: RtofsCurrentSource | null,
  offline: string | null
): Promise<{ src: RtofsCurrentSource | null; keep: RtofsRun[]; newRun: boolean }> {
  const { config: cfg } = requireInit(st);
  const client = rtofsClientFor(st, product);
  const key: CheckedSource = `rtofs:${product}`;
  const horizon = cfg.currents.rtofsHorizonS;
  let run: RtofsRun | null;
  let checked: { outcome: CheckOutcome; reason: string | null } = { outcome: 'newest', reason: null };
  const cachedRuns = client.cachedRuns().filter(r => client.runFullyCached(r, horizon));
  const inUse = current ? [rtofsRunFor(new Date(current.runMs))] : [];
  // Fresh enough already? The daily run appears during the morning;
  // if today's run is cached there is nothing to do.
  const today = rtofsRunFor(new Date());
  if (client.runFullyCached(today, horizon)) run = today;
  else {
    try {
      if (offline) throw new OfflineError(offline);
      run = await client.findLatestRun(horizon);
    } catch (err) {
      if (!offline) st.log('error', `rtofs ${product}: ${(err as Error).message}`);
      run = cachedRuns[0] ?? null;
      checked = { outcome: 'could-not-check', reason: (err as Error).message };
    }
  }
  if (!run) {
    if (current) st.log('info', `rtofs ${product}: keeping the resident run`);
    noteCheck(st, key, checked.outcome, checked.reason);
    return { src: current, keep: inUse, newRun: false };
  }
  if (current && current.runMs === run.time.getTime()) {
    noteCheck(st, key, checked.outcome, checked.reason);
    return { src: current, keep: [run, ...cachedRuns.slice(0, 1)], newRun: false };
  }
  try {
    const t = Date.now();
    // The whole product, uncropped.
    const steps = await loadRtofsSteps(client, run, null, horizon, cfg.currents.rtofsStepS, { log: m => st.log('debug', m) });
    if (steps.length === 0) throw new Error(`run ${run.yyyymmdd} has no steps in product ${product}`);
    const g = steps[0].u;
    const extent = extentOfField(g);
    if (noteRtofsExtent(rtofsCacheDir(st), product, { ...extent, dLon: g.dLon, dLat: g.dLat }))
      st.log('info', `rtofs: ${product}'s extent recorded from its run ${run.yyyymmdd}`);
    const src = new RtofsCurrentSource(product, run.time.getTime(), extent, shareRtofsSteps(steps));
    st.log(
      'info',
      `rtofs: ${product} run ${run.yyyymmdd}, ${steps.length} steps, ${(src.bytes() / 1e6).toFixed(1)} MB resident, ${((Date.now() - t) / 1000).toFixed(1)} s`
    );
    noteCheck(st, key, checked.outcome === 'newest' ? 'new-run' : checked.outcome, checked.reason ?? `run ${run.yyyymmdd}`);
    return { src, keep: [run, ...cachedRuns.slice(0, 1)], newRun: true };
  } catch (err) {
    st.log('error', `rtofs ${product}: load failed: ${(err as Error).message}`);
    noteCheck(st, key, isOffline(err) ? 'could-not-check' : 'failed', `run ${run.yyyymmdd}: ${(err as Error).message}`);
    return { src: current, keep: [...inUse, ...cachedRuns.slice(0, 1)], newRun: false };
  }
}
