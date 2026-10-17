// Weather Router Plus — route planner UI: the Setup choices, kept per
// Signal K user.
// The vessel (polar, sail or power, the power boat), the sailing
// strategy, waypoint, solver and live re-plan options, and the search
// and router choices belong to the user, not to one browser: besides
// localStorage they are kept in the server's per-user application data,
//   /signalk/v1/applicationData/user/signalk-weather-router-plus/1.0.0
// so a choice made in one browser is there in the next one the same
// user opens (another device, the kiosk, a private window). Page state
// (map view, open tabs, layer toggles, the plan being drawn) stays per
// browser and does not come through here.
//
// load() reads the stored choices once at start-up; rp-core.js awaits it
// before any module reads them. A choice the server has wins over this
// browser's; one only this browser has is sent up, so what a browser
// remembered before is kept. A change is written to localStorage at once
// and to the server shortly after (a slider drag sends one request).
// Without a login, with security off (the server keeps no application
// data) or for a read-only user, the choices stay in this browser, as
// before. Values are the strings localStorage holds.

export const PREFS_URL = '/signalk/v1/applicationData/user/signalk-weather-router-plus/1.0.0';

// The sail-speed slider's key until 2026-10 (knots); rp-core.js moves it
// to routeVar:sailThreshMs in this browser, so it is never sent up.
const LEGACY_KEYS = new Set(['routeVar:sailThresh']);

/** True for the keys that are the user's choices (kept on the server too). */
export function isUserPref(key) {
  if (LEGACY_KEYS.has(key)) return false;
  return key === 'polarPath' || key === 'vesselType' || key === 'powerBoat'
    || key === 'rp:search' || key === 'rp:router' || key.startsWith('routeVar:');
}

// RFC 6901 pointer for one member of the stored object.
function _pointer(key) {
  return '/' + key.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * The preference store. `storage` is localStorage (or null where the
 * browser blocks it), `fetchFn` the fetch to the Signal K server.
 * @param {{ storage: Pick<Storage, 'getItem' | 'setItem' | 'key' | 'length'> | null,
 *   fetchFn: (url: string, init?: object) => Promise<Response>,
 *   url?: string, delayMs?: number, timeoutMs?: number,
 *   log?: { warn: (...args: any[]) => void } }} opts
 */
export function createPrefs({ storage, fetchFn, url = PREFS_URL, delayMs = 500, timeoutMs = 3000, log = console }) {
  const values = new Map();   // the user's choices this page knows, read or set
  let pending = new Map();    // changes not yet sent to the server
  let timer = null;
  let remote = false;         // the server keeps this user's choices

  const local = {
    get(key) { try { return storage ? storage.getItem(key) : null; } catch (_) { return null; } },
    set(key, value) { try { if (storage) storage.setItem(key, value); } catch (_) { /* not remembered here */ } },
    keys() {
      const out = [];
      try { if (storage) for (let i = 0; i < storage.length; i++) out.push(storage.key(i)); } catch (_) { /* none */ }
      return out;
    },
  };

  async function send(keepalive) {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (!remote || pending.size === 0) return;
    // JSON Patch `add` sets the member whether or not it exists, so
    // changes from two browsers to different choices both land.
    const ops = [...pending].map(([key, value]) => ({ op: 'add', path: _pointer(key), value }));
    pending = new Map();
    try {
      const r = await fetchFn(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ops),
        keepalive: !!keepalive,
      });
      if (r.status === 401 || r.status === 403 || r.status === 405) {
        // Not logged in, read-only, or security off: this browser only.
        remote = false;
        log.warn('[prefs] the server does not keep this user\'s choices (HTTP ' + r.status + '); they stay in this browser');
      } else if (!r.ok) {
        log.warn('[prefs] saving choices to the server failed: HTTP ' + r.status);
      }
    } catch (e) {
      log.warn('[prefs] saving choices to the server failed', e);
    }
  }

  return {
    /** The stored value, or null. */
    get(key) {
      return values.has(key) ? values.get(key) : local.get(key);
    },
    /** Store a value (a string) in this browser and, for a user choice, on the server. */
    set(key, value) {
      value = String(value);
      local.set(key, value);
      if (!isUserPref(key)) return;
      if (values.get(key) === value) return;
      values.set(key, value);
      if (!remote) return;
      pending.set(key, value);
      if (timer === null) timer = setTimeout(() => { send(false); }, delayMs);
    },
    /** Send what is pending now; `keepalive` for a page being closed. */
    flush(keepalive) {
      return send(keepalive);
    },
    /** True once load() found the server keeping this user's choices. */
    get remote() { return remote; },
    /**
     * Read the user's choices from the server into this browser. Resolves
     * whether or not the server answers (after `timeoutMs` at most), so a
     * slow server delays the page by that much and no more.
     */
    async load() {
      let data = null;
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const t = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      try {
        const r = await fetchFn(url, { credentials: 'same-origin', signal: ctrl ? ctrl.signal : undefined });
        if (r.ok) data = await r.json();
      } catch (_) {
        data = null;
      } finally {
        if (t !== null) clearTimeout(t);
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
      remote = true;
      for (const [key, value] of Object.entries(data)) {
        if (!isUserPref(key) || typeof value !== 'string') continue;
        values.set(key, value);
        local.set(key, value);
      }
      for (const key of local.keys()) {
        if (!isUserPref(key) || values.has(key)) continue;
        const value = local.get(key);
        if (value === null) continue;
        values.set(key, value);
        pending.set(key, value);
      }
      if (pending.size) await send(false);
      return true;
    },
  };
}

function _localStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (_) { return null; }
}

/** The page's store; rp-core.js loads it before the other modules start. */
export const prefs = createPrefs({
  storage: _localStorage(),
  fetchFn: (...a) => fetch(...a),
});

if (typeof window !== 'undefined') {
  // A choice made just before the page closes still reaches the server.
  window.addEventListener('pagehide', () => { prefs.flush(true); });
}
