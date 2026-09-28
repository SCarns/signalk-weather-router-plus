/**
 * Memory guard: refuse to load a forecast the device cannot hold with
 * the user's headroom to spare, instead of letting the system swap or
 * kill Signal K.
 *
 * The need is exact: the resident forecast is one Float32 global grid
 * (1440 × 721 cells) per field per step. While a new forecast loads the
 * previous one keeps serving, so the check compares the new store's size
 * against memory available *now* (which already excludes the store in
 * use): after the load, `headroom` bytes must remain.
 *
 * Available memory is Linux MemAvailable (what the kernel can hand out
 * without swapping), bounded by a cgroup memory limit when the plugin
 * runs in a container. On macOS os.freemem() counts only completely free
 * pages (often tens of MB on a busy Mac), so there the figure is free +
 * inactive + speculative + purgeable pages from vm_stat, the memory the
 * kernel reclaims without swapping. Elsewhere os.freemem().
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { availableSteps, ATM_PARAMS, WAVE_PARAMS, cycleFor } from '../data/ecmwf';

/** Bytes of one global field for one step (Float32, 0.25°). */
export const FIELD_STEP_BYTES = 1440 * 721 * 4;
export const EXTRA_FIELD_COUNT = 5;

/** Bytes the global store needs for a horizon and field set. */
export function forecastBytes(horizonHours: number, extraFields: boolean, now = new Date()): number {
  const steps = availableSteps(cycleFor(now).atmStream, horizonHours).length;
  const fields = ATM_PARAMS.length + WAVE_PARAMS.length + (extraFields ? EXTRA_FIELD_COUNT : 0);
  return steps * fields * FIELD_STEP_BYTES;
}

function readNumber(file: string): number | null {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t === 'max' || t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Memory the system can give this process now, bytes, and where the figure came from. */
export function availableMemory(): { bytes: number; source: string } {
  let bytes = os.freemem();
  let source = 'os.freemem';
  try {
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) {
      bytes = Number(m[1]) * 1024;
      source = 'MemAvailable';
    }
  } catch { /* not Linux */ }
  if (process.platform === 'darwin' && source === 'os.freemem') {
    const mac = darwinAvailable();
    if (mac !== null) {
      bytes = mac;
      source = 'vm_stat free+inactive+speculative+purgeable';
    }
  }
  // cgroup v2, then v1: a container limit can be far below the host's free memory.
  const limit = readNumber('/sys/fs/cgroup/memory.max') ?? readNumber('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const used = readNumber('/sys/fs/cgroup/memory.current') ?? readNumber('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  if (limit !== null && used !== null && limit < 2 ** 60) {
    const cg = Math.max(0, limit - used);
    if (cg < bytes) {
      bytes = cg;
      source = 'cgroup limit';
    }
  }
  return { bytes, source };
}

/** macOS reclaimable memory from vm_stat, bytes, or null when unavailable. */
export function parseVmStat(text: string): number | null {
  const page = /page size of (\d+) bytes/.exec(text);
  if (!page) return null;
  const pages = (name: string): number => {
    const m = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, 'm').exec(text);
    return m ? Number(m[1]) : 0;
  };
  return (pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')) * Number(page[1]);
}

function darwinAvailable(): number | null {
  try {
    return parseVmStat(execFileSync('/usr/bin/vm_stat', { encoding: 'utf8', timeout: 2000 }));
  } catch {
    return null;
  }
}

export interface MemoryCheck {
  ok: boolean;
  needBytes: number;
  availableBytes: number;
  headroomBytes: number;
  source: string;
  /** Human explanation with a suggestion when not ok. */
  message: string;
}

const mb = (b: number): string => `${Math.round(b / 1e6)} MB`;

/**
 * Can a forecast of this horizon and field set be loaded, leaving
 * `headroomBytes` free? `available` defaults to the live reading (tests
 * pass their own).
 */
export function checkForecastMemory(
  horizonHours: number, extraFields: boolean, headroomBytes: number,
  available: { bytes: number; source: string } = availableMemory(), now = new Date(),
): MemoryCheck {
  const need = forecastBytes(horizonHours, extraFields, now);
  const ok = need + headroomBytes <= available.bytes;
  let message = `forecast needs ${mb(need)} (${horizonHours} h${extraFields ? ', extra fields' : ''}); ${mb(available.bytes)} available, ${mb(headroomBytes)} headroom kept`;
  if (!ok) {
    const fits = (h: number, x: boolean): boolean => forecastBytes(h, x, now) + headroomBytes <= available.bytes;
    const options: string[] = [];
    if (extraFields && fits(horizonHours, false)) options.push('turn off the extra fields');
    for (const h of [120, 96, 72, 48, 24, 12]) {
      if (h >= horizonHours) continue;
      if (fits(h, extraFields)) { options.push(`shorten the forecast horizon to ${h} h`); break; }
      if (extraFields && fits(h, false)) { options.push(`shorten the horizon to ${h} h with the extra fields off`); break; }
    }
    options.push('lower the memory headroom setting');
    message = `not enough memory: ${message}. To fit: ${options.join(', or ')} (Settings tab).`;
  }
  return { ok, needBytes: need, availableBytes: available.bytes, headroomBytes, source: available.source, message };
}
