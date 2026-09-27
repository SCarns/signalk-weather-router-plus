/**
 * ECMWF open-data client: finds the newest published forecast cycle,
 * reads each step's `.index` file, and fetches only the requested
 * fields by HTTP Range request. Fetched messages are cached on disk
 * (one GRIB2 message per file) before anything decodes them, so a
 * failed decode never forces a re-download.
 *
 * URL layout (verified against data.ecmwf.int and the reference
 * `ecmwf-opendata` client):
 *   {base}/{yyyymmdd}/{HH}z/ifs/0p25/{stream}/{yyyymmddHH0000}-{step}h-{stream}-fc.grib2
 *   {base}/{yyyymmdd}/{HH}z/ifs/0p25/{stream}/{yyyymmddHH0000}-{step}h-{stream}-fc.index
 * Streams: 00z/12z use `oper` (atmosphere) and `wave`; 06z/18z use
 * `scda` and `scwv` (shorter range).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const ECMWF_MIRRORS: Record<string, string> = {
  ecmwf: 'https://data.ecmwf.int/forecasts',
  aws: 'https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com',
  google: 'https://storage.googleapis.com/ecmwf-open-data',
};

/** Parameters the router needs, by stream. */
export const ATM_PARAMS = ['10u', '10v', 'msl'] as const;
export const WAVE_PARAMS = ['swh', 'mwp', 'mwd'] as const;
export type EcmwfParam = (typeof ATM_PARAMS)[number] | (typeof WAVE_PARAMS)[number] | '2t' | 'tprate';

export interface IndexRecord {
  param: string;
  step: string;
  levtype?: string;
  _offset: number;
  _length: number;
  [k: string]: unknown;
}

export interface Cycle {
  /** Cycle reference time (UTC). */
  time: Date;
  yyyymmdd: string;
  hh: string;
  atmStream: 'oper' | 'scda';
  waveStream: 'wave' | 'scwv';
}

export interface EcmwfClientOptions {
  baseUrl?: string;
  /** Directory for cached GRIB2 messages. */
  cacheDir: string;
  timeoutMs?: number;
  retries?: number;
  log?: (msg: string) => void;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

export class EcmwfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EcmwfError';
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function cycleFor(time: Date): Cycle {
  const hh = pad2(time.getUTCHours());
  const yyyymmdd = `${time.getUTCFullYear()}${pad2(time.getUTCMonth() + 1)}${pad2(time.getUTCDate())}`;
  const main = hh === '00' || hh === '12';
  return { time, yyyymmdd, hh, atmStream: main ? 'oper' : 'scda', waveStream: main ? 'wave' : 'scwv' };
}

/** Steps published for a stream: 3-hourly to 144 h then 6-hourly to 240 h (oper); scda stops at 90 h. */
export function availableSteps(stream: Cycle['atmStream'] | Cycle['waveStream'], horizonHours: number): number[] {
  const steps: number[] = [];
  const max = stream === 'oper' || stream === 'wave' ? 240 : 90;
  for (let s = 0; s <= Math.min(horizonHours, max); s += s < 144 ? 3 : 6) steps.push(s);
  return steps;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class EcmwfClient {
  readonly baseUrl: string;
  readonly cacheDir: string;
  readonly timeoutMs: number;
  readonly retries: number;
  private readonly log: (msg: string) => void;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: EcmwfClientOptions) {
    this.baseUrl = (opts.baseUrl ?? ECMWF_MIRRORS.ecmwf).replace(/\/$/, '');
    this.cacheDir = opts.cacheDir;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.retries = opts.retries ?? 4;
    this.log = opts.log ?? (() => undefined);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  stepUrl(cycle: Cycle, stream: string, step: number, ext: 'grib2' | 'index'): string {
    return `${this.baseUrl}/${cycle.yyyymmdd}/${cycle.hh}z/ifs/0p25/${stream}/${cycle.yyyymmdd}${cycle.hh}0000-${step}h-${stream}-fc.${ext}`;
  }

  /** HTTP request with retries and backoff. 404 is returned, not retried. */
  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, { ...init, signal: ctrl.signal });
        if (res.status === 404 || res.status === 403) return res;
        if (res.status === 429 || res.status === 503 || res.status >= 500) {
          lastErr = new EcmwfError(`HTTP ${res.status} for ${url}`);
          await res.arrayBuffer().catch(() => undefined);
        } else {
          return res;
        }
      } catch (err) {
        lastErr = err;
      } finally {
        clearTimeout(timer);
      }
      const backoff = Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500;
      this.log(`retry ${attempt + 1}/${this.retries} for ${url} after ${(backoff / 1000).toFixed(1)} s: ${(lastErr as Error).message}`);
      await sleep(backoff);
    }
    throw lastErr instanceof Error ? lastErr : new EcmwfError(`request failed: ${url}`);
  }

  /** Does the index for this step exist on the server? */
  async stepPublished(cycle: Cycle, stream: string, step: number): Promise<boolean> {
    const res = await this.request(this.stepUrl(cycle, stream, step, 'index'), { method: 'HEAD' });
    if (res.status === 200) return true;
    if (res.status === 404 || res.status === 403) return false;
    throw new EcmwfError(`unexpected HTTP ${res.status} probing ${this.stepUrl(cycle, stream, step, 'index')}`);
  }

  /**
   * Newest cycle whose atmosphere and wave streams both have the
   * requested final step published. Walks back in 6 h cycles from the
   * current UTC hour, up to `maxAgeHours`.
   */
  async findLatestCycle(horizonHours: number, opts: { mainCyclesOnly?: boolean; maxAgeHours?: number; now?: Date } = {}): Promise<Cycle> {
    const now = opts.now ?? new Date();
    const maxAge = opts.maxAgeHours ?? 48;
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Math.floor(now.getUTCHours() / 6) * 6));
    for (let ageH = 0; ageH <= maxAge; ageH += 6) {
      const c = cycleFor(new Date(start.getTime() - ageH * 3600_000));
      if (opts.mainCyclesOnly && c.atmStream !== 'oper') continue;
      const atmSteps = availableSteps(c.atmStream, horizonHours);
      const waveSteps = availableSteps(c.waveStream, horizonHours);
      const lastAtm = atmSteps[atmSteps.length - 1];
      const lastWave = waveSteps[waveSteps.length - 1];
      if (lastAtm < horizonHours && c.atmStream === 'scda') continue; // short cycle cannot cover the horizon
      const [a, w] = await Promise.all([
        this.stepPublished(c, c.atmStream, lastAtm),
        this.stepPublished(c, c.waveStream, lastWave),
      ]);
      if (a && w) {
        this.log(`latest complete cycle: ${c.yyyymmdd} ${c.hh}z (${c.atmStream}/${c.waveStream}) to +${lastAtm} h`);
        return c;
      }
    }
    throw new EcmwfError(`no ECMWF cycle in the last ${maxAge} h has +${horizonHours} h published`);
  }

  async fetchIndex(cycle: Cycle, stream: string, step: number): Promise<IndexRecord[]> {
    const url = this.stepUrl(cycle, stream, step, 'index');
    const res = await this.request(url);
    if (res.status !== 200) throw new EcmwfError(`HTTP ${res.status} fetching ${url}`);
    const text = await res.text();
    const out: IndexRecord[] = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const rec = JSON.parse(t) as IndexRecord;
      if (typeof rec._offset !== 'number' || typeof rec._length !== 'number' || typeof rec.param !== 'string') {
        throw new EcmwfError(`malformed index line in ${url}: ${t.slice(0, 120)}`);
      }
      out.push(rec);
    }
    return out;
  }

  cachePath(cycle: Cycle, stream: string, step: number, param: string): string {
    return path.join(this.cacheDir, `${cycle.yyyymmdd}${cycle.hh}`, `${stream}-${String(step).padStart(3, '0')}h-${param}.grib2`);
  }

  /**
   * Fetch one field of one step as a raw GRIB2 message (from cache when
   * present). Returns null when the index has no such parameter.
   */
  async fetchField(cycle: Cycle, stream: string, step: number, param: string, index?: IndexRecord[]): Promise<Uint8Array | null> {
    const cached = this.cachePath(cycle, stream, step, param);
    if (fs.existsSync(cached)) {
      const buf = fs.readFileSync(cached);
      if (buf.length > 16 && buf.toString('latin1', 0, 4) === 'GRIB') return new Uint8Array(buf);
      fs.unlinkSync(cached);
    }
    const idx = index ?? (await this.fetchIndex(cycle, stream, step));
    const rec = idx.find((r) => r.param === param && (r.levtype === undefined || r.levtype === 'sfc'));
    if (!rec) return null;
    const url = this.stepUrl(cycle, stream, step, 'grib2');
    const res = await this.request(url, { headers: { Range: `bytes=${rec._offset}-${rec._offset + rec._length - 1}` } });
    if (res.status !== 206 && res.status !== 200) throw new EcmwfError(`HTTP ${res.status} fetching ${param} from ${url}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    let msg = buf;
    if (res.status === 200) {
      // Server ignored the range: slice the whole file.
      msg = buf.subarray(rec._offset, rec._offset + rec._length);
    }
    if (msg.length !== rec._length) {
      throw new EcmwfError(`short read for ${param} step ${step}: got ${msg.length} of ${rec._length} bytes`);
    }
    if (!(msg[0] === 0x47 && msg[1] === 0x52 && msg[2] === 0x49 && msg[3] === 0x42)) {
      throw new EcmwfError(`fetched bytes for ${param} step ${step} do not start with GRIB`);
    }
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    const tmp = `${cached}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, msg);
    fs.renameSync(tmp, cached);
    return msg;
  }

  /** Delete cached cycles other than `keep`. */
  pruneCache(keep: Cycle[]): void {
    const keepNames = new Set(keep.map((c) => `${c.yyyymmdd}${c.hh}`));
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.cacheDir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (/^\d{10}$/.test(e) && !keepNames.has(e)) {
        fs.rmSync(path.join(this.cacheDir, e), { recursive: true, force: true });
        this.log(`pruned cached cycle ${e}`);
      }
    }
  }
}
