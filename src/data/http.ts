/**
 * The one HTTP retry policy of the data clients (ECMWF, Copernicus Marine
 * Zarr, RTOFS): a timeout per attempt, up to `retries` attempts,
 * exponential backoff 2, 4, 8, 16, 32 s capped at a minute with up to
 * 0.5 s of jitter, `Retry-After` honoured, retried only on 408 / 429 / 5xx
 * and network errors; 404 / 403 and other answers are returned as they are.
 * With `readBody` the body is read while the timer is still armed, so a
 * stalled download is retried like a failed connection.
 *
 * No connection at all (the name does not resolve, the connection is
 * refused, no route to the network or host) is not retried: it throws an
 * OfflineError at once, which the callers report as "could not check"
 * rather than as a failed download. A timeout is retried: a slow link at
 * sea looks the same as a dead one.
 */

import { MINUTE_MS } from '../geo/units';

/** Network error codes that mean there is no connection, not a failed transfer. */
const OFFLINE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN']);

export class OfflineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflineError';
  }
}

/** The offline code of a fetch failure (undici: TypeError with a `cause`, sometimes an AggregateError of attempts), or null. */
export function offlineCode(err: unknown): string | null {
  const seen = new Set<unknown>();
  const walk = (e: unknown): string | null => {
    if (!e || typeof e !== 'object' || seen.has(e)) return null;
    seen.add(e);
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && OFFLINE_CODES.has(code)) return code;
    for (const sub of (e as { errors?: unknown[] }).errors ?? []) {
      const c = walk(sub);
      if (c) return c;
    }
    return walk((e as { cause?: unknown }).cause);
  };
  return walk(err);
}

/** Is this error (or one it wraps, such as a child process's) "no connection"? */
export function isOffline(err: unknown): boolean {
  return err instanceof OfflineError || (err as Error | null)?.name === 'OfflineError';
}

/**
 * What the requests of this thread found about the connection: 'ok' when a
 * server answered (any status), 'offline' with the reason when there was no
 * connection. One listener per thread (the data worker's status).
 */
let networkObserver: ((state: 'ok' | 'offline', detail: string | null) => void) | null = null;
export function setNetworkObserver(fn: ((state: 'ok' | 'offline', detail: string | null) => void) | null): void {
  networkObserver = fn;
}

export interface RetryOptions {
  timeoutMs: number;
  retries: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  /** Log prefix (e.g. 'rtofs'). */
  tag?: string;
  /** The error class for a retriable HTTP status, when a client has its own. */
  makeError?: (message: string) => Error;
  /** Read the body inside the attempt (under the timeout); false: the caller reads it. */
  readBody?: boolean;
}

export interface RetryResult {
  status: number;
  headers: Headers;
  /** The body when `readBody` was set, else null. */
  body: Uint8Array | null;
  response: Response;
}

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Parse a Retry-After header (seconds or HTTP date) into milliseconds, or null. */
export function parseRetryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return null;
}

export async function fetchWithRetry(url: string, init: RequestInit, o: RetryOptions): Promise<RetryResult> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const sleepImpl = o.sleepImpl ?? sleep;
  const log = o.log ?? (() => undefined);
  const makeError = o.makeError ?? ((m: string) => new Error(m));
  const prefix = o.tag ? `${o.tag}: ` : '';
  let lastErr: unknown;
  for (let attempt = 1; attempt <= o.retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs);
    let retryAfterMs: number | null = null;
    try {
      const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
      networkObserver?.('ok', null);
      const retriable = res.status === 408 || res.status === 429 || res.status >= 500;
      if (!retriable) {
        const body = o.readBody ? new Uint8Array(await res.arrayBuffer()) : null;
        return { status: res.status, headers: res.headers, body, response: res };
      }
      retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
      lastErr = makeError(`HTTP ${res.status} for ${url}`);
      await res.arrayBuffer().catch(() => undefined);
    } catch (err) {
      lastErr = err;
      const code = offlineCode(err);
      if (code) {
        const host = (() => {
          try {
            return new URL(url).host;
          } catch {
            return url;
          }
        })();
        const reason = `no internet connection (${code} for ${host})`;
        networkObserver?.('offline', reason);
        throw new OfflineError(reason);
      }
    } finally {
      clearTimeout(timer);
    }
    if (attempt === o.retries) break;
    let backoff = Math.min(MINUTE_MS, 2000 * 2 ** (attempt - 1));
    if (retryAfterMs !== null) backoff = Math.min(MINUTE_MS, Math.max(backoff, retryAfterMs));
    backoff += Math.random() * 500;
    log(`${prefix}retry ${attempt}/${o.retries - 1} for ${url} after ${(backoff / 1000).toFixed(1)} s: ${(lastErr as Error).message}`);
    await sleepImpl(backoff);
  }
  throw lastErr instanceof Error ? lastErr : makeError(`request failed: ${url}`);
}
