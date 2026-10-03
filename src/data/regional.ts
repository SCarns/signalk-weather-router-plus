/**
 * Regional GRIB runs written by the signalk-grib-downloader plugin
 * (docs/plans/grib-downloader-enhancement.md, phase 2: discovery only).
 *
 * The downloader keeps one folder per source under its root
 * (`<root>/<model>[-<resolution>]/`, default `~/.signalk/gribs`), files
 * `<source>__<YYYYMMDDTHH>__f<step>.grb2` (GFS, ICON-EU) or
 * `<source>__<stamp>__SP1_<group>.grb2` (AROME, ARPEGE), and marks a run
 * complete with `.run-<stamp>.complete`. A run without its marker is
 * never read; nothing here writes into the downloader's folders.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const DOWNLOADER_ID = 'signalk-grib-downloader';
export const DOWNLOADER_DEFAULT_ROOT = '~/.signalk/gribs';

export interface RegionalDomain {
  /** Degrees; west/east in −180..180, west > east when the grid spans the antimeridian. */
  south: number;
  north: number;
  west: number;
  east: number;
  /** Grid spacing, degrees. */
  di: number;
  dj: number;
  ni: number;
  nj: number;
}

export interface RegionalSource {
  /** Folder name, e.g. "arpege-01". */
  name: string;
  model: 'gfs' | 'arome' | 'arpege' | 'icon-eu' | 'unknown';
  /** Grid spacing as the folder names it ("0p25", "0025", "01"), or null. */
  resolution: string | null;
  /** Newest complete run (marker present), ISO, or null. */
  run: string | null;
  /** Forecast hours present for that run (from the file names). */
  hours: number[];
  validFrom: string | null;
  validTo: string | null;
  files: string[];
  bytes: number;
  domain: RegionalDomain | null;
  /** Why the source cannot be used, or null. */
  problem: string | null;
}

export interface RegionalStatus {
  /** The folder scanned, or null when none was found. */
  root: string | null;
  /** How the root was chosen. */
  from: 'setting' | 'downloader config' | 'downloader default' | null;
  sources: RegionalSource[];
  /** Why there is nothing, when there is nothing. */
  note: string | null;
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * The downloader's root: the setting when given, else the downloader's own
 * configured `gribsRoot` (its plugin config, beside ours under
 * plugin-config-data), else its default. Null when that folder does not
 * exist.
 */
export function resolveRegionalRoot(setting: string, ourDataDir: string): { root: string; from: RegionalStatus['from'] } | null {
  const exists = (p: string): boolean => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  if (setting.trim()) {
    const p = expandHome(setting.trim());
    return exists(p) ? { root: p, from: 'setting' } : null;
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ourDataDir, '..', `${DOWNLOADER_ID}.json`), 'utf8')) as {
      configuration?: { gribsRoot?: string };
    };
    const r = cfg.configuration?.gribsRoot;
    if (typeof r === 'string' && r.trim()) {
      const p = expandHome(r.trim());
      if (exists(p)) return { root: p, from: 'downloader config' };
    }
  } catch {
    /* no downloader config */
  }
  const def = expandHome(DOWNLOADER_DEFAULT_ROOT);
  return exists(def) ? { root: def, from: 'downloader default' } : null;
}

const MODELS: RegionalSource['model'][] = ['gfs', 'arome', 'arpege', 'icon-eu'];

function modelOf(name: string): { model: RegionalSource['model']; resolution: string | null } {
  if (name === 'icon-eu') return { model: 'icon-eu', resolution: null };
  const m = /^([a-z]+)-([0-9p]+)$/.exec(name);
  if (m && (MODELS as string[]).includes(m[1])) return { model: m[1] as RegionalSource['model'], resolution: m[2] };
  return { model: 'unknown', resolution: null };
}

/** Forecast hours a run's file covers, from its name: `__f003` or a group `__SP1_00H06H` / `__SP1_07H`. */
export function hoursOfFile(file: string): number[] {
  const f = /__f(\d{3})\.grb2$/.exec(file);
  if (f) return [Number(f[1])];
  const g = /__[A-Z0-9]+_(\d{2,3})H(?:(\d{2,3})H)?\.grb2$/.exec(file);
  if (g) {
    const a = Number(g[1]);
    const b = g[2] !== undefined ? Number(g[2]) : a;
    const out: number[] = [];
    for (let h = a; h <= b; h++) out.push(h);
    return out;
  }
  return [];
}

/** "YYYYMMDDTHH" → epoch ms. */
export function stampMs(stamp: string): number {
  return Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(9, 11));
}

/** GRIB2 sign-magnitude 32-bit integer. */
function sm32(b: Buffer, o: number): number {
  const v = b.readUInt32BE(o);
  return v & 0x80000000 ? -(v & 0x7fffffff) : v;
}

/**
 * The grid of the first message of a GRIB2 file, from its first few
 * hundred bytes (sections 0–3, template 3.0 lat/lon). Null when the file
 * does not start with such a message.
 */
export function readGridHeader(file: string): RegionalDomain | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n < 16 || buf.toString('ascii', 0, 4) !== 'GRIB' || buf[7] !== 2) return null;
    let p = 16;
    while (p + 5 <= n) {
      const len = buf.readUInt32BE(p);
      const sec = buf[p + 4];
      if (len <= 0) return null;
      if (sec === 3) {
        if (p + 72 > n || buf.readUInt16BE(p + 12) !== 0) return null;
        const ni = buf.readUInt32BE(p + 30);
        const nj = buf.readUInt32BE(p + 34);
        const la1 = sm32(buf, p + 46) / 1e6;
        const lo1 = sm32(buf, p + 50) / 1e6;
        const la2 = sm32(buf, p + 55) / 1e6;
        const lo2 = sm32(buf, p + 59) / 1e6;
        const di = buf.readUInt32BE(p + 63) / 1e6;
        const dj = buf.readUInt32BE(p + 67) / 1e6;
        const wrap = (x: number): number => ((((x + 180) % 360) + 360) % 360) - 180;
        return { south: Math.min(la1, la2), north: Math.max(la1, la2), west: wrap(lo1), east: wrap(lo2), di, dj, ni, nj };
      }
      if (sec > 3) return null;
      p += len;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** One source folder: its newest complete run, the files and hours of that run, and its grid. */
export function scanSource(dir: string, name: string): RegionalSource {
  const { model, resolution } = modelOf(name);
  const base: RegionalSource = {
    name,
    model,
    resolution,
    run: null,
    hours: [],
    validFrom: null,
    validTo: null,
    files: [],
    bytes: 0,
    domain: null,
    problem: null,
  };
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    return { ...base, problem: `cannot read ${dir}: ${(err as Error).message}` };
  }
  const stamps = entries
    .map(f => /^\.run-(\d{8}T\d{2})\.complete$/.exec(f)?.[1])
    .filter((s): s is string => !!s)
    .sort();
  if (!stamps.length) return { ...base, problem: 'no complete run yet' };
  const stamp = stamps[stamps.length - 1];
  const files = entries.filter(f => f.includes(`__${stamp}__`) && f.endsWith('.grb2')).sort();
  if (!files.length) return { ...base, problem: `run ${stamp} is marked complete but has no files` };
  const hours = [...new Set(files.flatMap(hoursOfFile))].sort((a, b) => a - b);
  let bytes = 0;
  for (const f of files) {
    try {
      bytes += fs.statSync(path.join(dir, f)).size;
    } catch {
      /* gone meanwhile */
    }
  }
  const runMs = stampMs(stamp);
  const domain = readGridHeader(path.join(dir, files[0]));
  return {
    ...base,
    run: new Date(runMs).toISOString(),
    hours,
    validFrom: hours.length ? new Date(runMs + hours[0] * 3600_000).toISOString() : null,
    validTo: hours.length ? new Date(runMs + hours[hours.length - 1] * 3600_000).toISOString() : null,
    files,
    bytes,
    domain,
    problem: model === 'unknown' ? 'unknown model folder' : domain ? null : 'the first file is not a regular lat/lon GRIB2 grid',
  };
}

/** Every source under the root (the `archive` folders and anything else that is not a source are skipped). */
export function scanRegional(setting: string, ourDataDir: string): RegionalStatus {
  const r = resolveRegionalRoot(setting, ourDataDir);
  if (!r) {
    return {
      root: null,
      from: null,
      sources: [],
      note: setting.trim()
        ? `regional GRIB folder ${setting.trim()} not found`
        : `${DOWNLOADER_ID} not found (no ${DOWNLOADER_DEFAULT_ROOT} and no configured folder); install it for finer regional wind`,
    };
  }
  let names: string[];
  try {
    names = fs
      .readdirSync(r.root, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'archive')
      .map(d => d.name)
      .sort();
  } catch (err) {
    return { root: r.root, from: r.from, sources: [], note: `cannot read ${r.root}: ${(err as Error).message}` };
  }
  const sources = names.map(n => scanSource(path.join(r.root, n), n));
  return { root: r.root, from: r.from, sources, note: sources.length ? null : 'no source folders yet (add a source in the downloader)' };
}
