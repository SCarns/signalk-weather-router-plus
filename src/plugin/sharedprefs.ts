/**
 * The Setup choices with security off. Signal K then keeps no application
 * data (its applicationData.js answers 405 to every write) and there are no
 * users, so the plugin keeps one set of choices for every browser, in
 * prefs.json in its data directory (README, Users). With security on the
 * choices are the user's, in Signal K's application data, and this store
 * is not used (the API answers 405).
 *
 * Not a cache: the file sits beside settings.json, outside the directories
 * tagged CACHEDIR.TAG (cachedir.ts), so a backup keeps it.
 *
 * A write is what rp-prefs.js sends to Signal K's application data, so the
 * page talks to both the same way: a JSON Patch of `add` operations, one
 * top-level member each, string values. `remove` is taken too, as Signal K
 * takes it; the page never sends one, and a browser that still holds a
 * removed member sends it up again when the page next opens (rp-prefs.js
 * load(), as for a user's application data). Reads and writes
 * are synchronous, so two requests never interleave; the file is replaced
 * with a rename, so a crash leaves the old one or the new one.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const SHARED_PREFS_FILE = 'prefs.json';
/** The whole file, at most. A user's record measured 151 bytes (5 choices). */
export const MAX_SHARED_PREFS_BYTES = 64 * 1024;
/** Operations in one request, at most. */
export const MAX_SHARED_PREFS_OPS = 200;

/** Member names a plain object must not take from a request. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** A request the store refuses; `status` is the HTTP answer (400 or 413). */
export class SharedPrefsError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413
  ) {
    super(message);
  }
}

export type SharedPrefs = Record<string, string>;

/** The member a pointer names: one segment, RFC 6901 escapes undone. */
function memberOf(pointer: unknown): string {
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || pointer.indexOf('/', 1) !== -1)
    throw new SharedPrefsError('each path must name one member, "/<name>"', 400);
  const raw = pointer.slice(1);
  // RFC 6901 allows "~" only as "~0" (a "~") or "~1" (a "/"); rp-prefs.js writes no other.
  if (/~(?![01])/.test(raw)) throw new SharedPrefsError(`invalid escape in "${pointer}": "~" must be "~0" or "~1"`, 400);
  const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
  if (!key || UNSAFE_KEYS.has(key)) throw new SharedPrefsError(`invalid member name "${key}"`, 400);
  return key;
}

export class SharedPrefsStore {
  readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, SHARED_PREFS_FILE);
  }

  /**
   * The stored choices; {} while there are none. An unreadable file is kept aside and counts as none, and so is one
   * over MAX_SHARED_PREFS_BYTES (only written outside this store): read, it would be served whole and refuse every
   * write (413), as a patch is checked against the size of the result. At most one byte over the cap is read, from
   * one descriptor, so a file replaced or growing meanwhile (a restore) is never read whole either.
   */
  read(): SharedPrefs {
    const buf = Buffer.alloc(MAX_SHARED_PREFS_BYTES + 1);
    let bytes = 0;
    try {
      const fd = fs.openSync(this.file, 'r');
      try {
        let n: number;
        do {
          n = fs.readSync(fd, buf, bytes, buf.length - bytes, null);
          bytes += n;
        } while (n > 0 && bytes < buf.length);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
    if (bytes > MAX_SHARED_PREFS_BYTES) {
      fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      return {};
    }
    const text = buf.toString('utf8', 0, bytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      return {};
    }
    const out: SharedPrefs = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === 'string' && !UNSAFE_KEYS.has(k)) out[k] = v;
    return out;
  }

  /** Apply a JSON Patch (add / remove, one member each, string values) and return the choices after it. */
  patch(ops: unknown): SharedPrefs {
    if (!Array.isArray(ops)) throw new SharedPrefsError('the body must be a JSON Patch array', 400);
    if (ops.length > MAX_SHARED_PREFS_OPS) throw new SharedPrefsError(`at most ${MAX_SHARED_PREFS_OPS} operations`, 413);
    const prefs = this.read();
    for (const o of ops) {
      if (!o || typeof o !== 'object') throw new SharedPrefsError('each operation must be an object', 400);
      const { op, path: pointer, value } = o as { op?: unknown; path?: unknown; value?: unknown };
      const key = memberOf(pointer);
      if (op === 'add') {
        if (typeof value !== 'string') throw new SharedPrefsError(`"${key}": the value must be a string`, 400);
        prefs[key] = value;
      } else if (op === 'remove') {
        delete prefs[key];
      } else {
        throw new SharedPrefsError(`unsupported operation ${JSON.stringify(op)} (add or remove)`, 400);
      }
    }
    const text = JSON.stringify(prefs, null, 2);
    if (Buffer.byteLength(text, 'utf8') > MAX_SHARED_PREFS_BYTES)
      throw new SharedPrefsError(`the choices would be over ${MAX_SHARED_PREFS_BYTES / 1024} KB`, 413);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, this.file);
    return prefs;
  }
}
