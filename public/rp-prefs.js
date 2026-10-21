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
// browser's. localStorage is not split by user, so the browser records
// whose choices it holds (OWNER_KEY): a choice only this browser has is
// sent up when it is this user's, and dropped when it was another user's.
// The choices a browser held before this module have no owner: they stay
// in use in this browser, as before, but go to the user's record only when
// the user says they are theirs (keepLegacy; rp-core.js asks), or are
// dropped (discardLegacy).
// A change is written to localStorage at once and to the server shortly
// after, one request at a time (a slider drag sends one request); a
// change the server did not take is kept and sent again later.
// Without a login, with security off (the server keeps no application
// data) or for a read-only user, the choices stay in this browser, as
// before. Values are the strings localStorage holds.
//
// The user is the Signal K login name, the plugin's one rule for "user"
// (README, Users): `username` from loginStatus here. Signal K answers it
// with req.skPrincipal.identifier, the identifier it also attaches to an
// authenticated request reaching a plugin route (http_authorize on
// /plugins, same token or cookie) and files application data under
// (applicationData/users/<identifier>); signalk-server 2.34,
// src/tokensecurity.ts and src/interfaces/applicationData.js. So the
// server side of a per-user feature sees the same name as this module.
// The Freeboard panel (plotterext/panel.html) uses this store too, for
// the polar, the mode, the min sail speed and the route limits.

export const PREFS_URL = '/signalk/v1/applicationData/user/signalk-weather-router-plus/1.0.0';
export const LOGIN_STATUS_URL = '/skServer/loginStatus';
/** localStorage key: the Signal K user whose choices this browser holds. */
export const OWNER_KEY = 'rp:prefsUser';

// The sail-speed slider's key until 2026-10 (knots); load() moves it to
// routeVar:sailThreshMs in this browser, so it is never sent up.
const LEGACY_KEYS = new Set(['routeVar:sailThresh']);
const KT_MS = 1852 / 3600;   // as rp-core.js, which imports this module

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
 * A change the server refused with another status than 401/403/405 (or
 * that did not reach it) is sent again after `retryMs`, doubling to 5 min.
 * @param {{ storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'> | null,
 *   fetchFn: (url: string, init?: object) => Promise<Response>,
 *   url?: string, loginUrl?: string, delayMs?: number, timeoutMs?: number, retryMs?: number,
 *   log?: { warn: (...args: any[]) => void } }} opts
 */
export function createPrefs({ storage, fetchFn, url = PREFS_URL, loginUrl = LOGIN_STATUS_URL, delayMs = 500, timeoutMs = 3000, retryMs = 30_000, log = console }) {
  const RETRY_MAX_MS = 5 * 60_000;
  const values = new Map();   // the user's choices this page knows, read or set
  let pending = new Map();    // changes the server has not taken yet
  let inflight = null;        // the batch being sent, while a request runs
  let inflightDone = null;    // its promise
  let timer = null;
  let retryWait = retryMs;
  let remote = false;         // the server keeps this user's choices
  let user = null;            // the logged-in user load() found
  const legacy = new Map();   // ownerless choices from before this module, waiting for the user's answer
  let reading = false;        // load() is waiting for the server
  const setWhileReading = new Set(); // choices made meanwhile: they win over the server's
  let owned = false;          // load() found the logged-in user to be the one this browser records (OWNER_KEY)

  const local = {
    get(key) { try { return storage ? storage.getItem(key) : null; } catch (_) { return null; } },
    set(key, value) { try { if (storage) storage.setItem(key, value); } catch (_) { /* not remembered here */ } },
    remove(key) { try { if (storage) storage.removeItem(key); } catch (_) { /* nothing to drop */ } },
    keys() {
      const out = [];
      try { if (storage) for (let i = 0; i < storage.length; i++) out.push(storage.key(i)); } catch (_) { /* none */ }
      return out;
    },
  };

  // Until 2026-10 the sail-speed slider held knots (it holds m/s now under
  // a new key), and powerBoat held the cruise speed in knots (it is
  // routeVar:pb_cruise:si now, in m/s with the other limits). Converted in
  // this browser before load() decides whose choices the browser holds, so
  // the converted values follow the same rules as every other choice (sent
  // up only when they are this user's).
  function migrateLocal() {
    const old = local.get('routeVar:sailThresh');
    if (old !== null) {
      const kn = parseFloat(old);
      if (Number.isFinite(kn) && local.get('routeVar:sailThreshMs') === null)
        local.set('routeVar:sailThreshMs', String(Math.round(kn * KT_MS * 10) / 10));
      local.remove('routeVar:sailThresh');
    }
    const boat = local.get('powerBoat');
    if (boat === null) return;
    let pb;
    try { pb = JSON.parse(boat); } catch (_) { return; }   // not JSON: left as it is
    if (!pb || typeof pb !== 'object' || pb.cruise_kts == null) return;
    const cruiseKn = parseFloat(pb.cruise_kts);
    if (Number.isFinite(cruiseKn) && local.get('routeVar:pb_cruise:si') === null)
      local.set('routeVar:pb_cruise:si', String(cruiseKn * KT_MS));
    delete pb.cruise_kts;
    local.set('powerBoat', JSON.stringify(pb));
  }

  // A choice is the recorded owner's only when load() found that user logged
  // in. One made otherwise (the read failed, or the user is unknown or
  // another one) cannot be told apart from the owner's, so the browser's
  // choices are left without an owner: the next load() offers those the
  // user's record lacks with Keep / Discard instead of sending them up as
  // the recorded owner's.
  function disown() {
    if (!owned) local.remove(OWNER_KEY);
  }

  function schedule(ms) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; send(); }, ms);
  }

  function post(batch, keepalive) {
    // JSON Patch `add` sets the member whether or not it exists, so
    // changes from two browsers to different choices both land.
    const ops = [...batch].map(([key, value]) => ({ op: 'add', path: _pointer(key), value }));
    return fetchFn(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ops),
      keepalive,
    });
  }

  // One request at a time: changes made while it runs wait for it, so an
  // older value can never land after a newer one.
  function send() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (!remote || inflight || pending.size === 0) return inflightDone || Promise.resolve();
    const batch = pending;
    pending = new Map();
    inflight = batch;
    inflightDone = (async () => {
      let taken = false;
      try {
        const r = await post(batch, false);
        if (r.status === 401 || r.status === 403 || r.status === 405) {
          // Not logged in, read-only, or security off: this browser only.
          remote = false;
          log.warn('[prefs] the server does not keep this user\'s choices (HTTP ' + r.status + '); they stay in this browser');
        } else if (!r.ok) {
          log.warn('[prefs] saving choices to the server failed: HTTP ' + r.status + '; trying again later');
        } else {
          taken = true;
        }
      } catch (e) {
        log.warn('[prefs] saving choices to the server failed; trying again later', e);
      }
      inflight = null;
      inflightDone = null;
      if (!remote) { pending.clear(); return; }
      if (taken) {
        retryWait = retryMs;
        if (pending.size) schedule(delayMs);
        return;
      }
      // Kept for the next attempt, unless the key changed again meanwhile.
      for (const [key, value] of batch) if (!pending.has(key)) pending.set(key, value);
      schedule(retryWait);
      retryWait = Math.min(retryWait * 2, RETRY_MAX_MS);
    })();
    return inflightDone;
  }

  async function getJson(u, signal) {
    const r = await fetchFn(u, { credentials: 'same-origin', signal });
    return r.ok ? r.json() : null;
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
      legacy.delete(key);     // set now: the user's own choice
      if (reading) setWhileReading.add(key);
      else disown();
      if (values.get(key) === value) return;
      values.set(key, value);
      if (!remote) return;
      pending.set(key, value);
      if (!inflight && timer === null) schedule(delayMs);
    },
    /**
     * Send what is pending now and resolve when the server has answered.
     * `keepalive` is for a page being closed: everything not yet taken,
     * the request in flight included, goes in one request that outlives
     * the page.
     */
    async flush(keepalive) {
      if (!remote) return;
      if (keepalive) {
        if (timer !== null) { clearTimeout(timer); timer = null; }
        const all = new Map([...(inflight || []), ...pending]);
        if (all.size) post(all, true).catch(() => { /* the page is going */ });
        return;
      }
      while (inflightDone) await inflightDone;
      await send();
    },
    /** True once load() found the server keeping this user's choices. */
    get remote() { return remote; },
    /** The logged-in user load() found (null: unknown). */
    get user() { return user; },
    /** Choices this browser held before they were kept per user, not yet claimed: [key, value] pairs. */
    legacyChoices() { return [...legacy]; },
    /** The user says the browser's older choices are theirs: they go to the user's record. */
    keepLegacy() {
      if (!user) return;
      for (const [key, value] of legacy) {
        values.set(key, value);
        if (remote) pending.set(key, value);
      }
      legacy.clear();
      local.set(OWNER_KEY, user);
      owned = true;
      send();
    },
    /** The user does not want them: dropped from this browser. */
    discardLegacy() {
      if (!user) return;
      for (const key of legacy.keys()) local.remove(key);
      legacy.clear();
      local.set(OWNER_KEY, user);
      owned = true;
    },
    /**
     * Read the user's choices from the server into this browser. Resolves
     * whether or not the server answers (after `timeoutMs` at most), so a
     * slow server delays the page by that much and no more; the upload of
     * this browser's own choices is not waited for.
     */
    async load() {
      migrateLocal();
      let data;
      let login;
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const t = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      const signal = ctrl ? ctrl.signal : undefined;
      reading = true;
      try {
        // Each on its own: the login status is known even when the read fails. No answer (in time): null.
        [data, login] = await Promise.all([
          getJson(url, signal).catch(() => null),
          getJson(loginUrl, signal).catch(() => null),
        ]);
      } finally {
        if (t !== null) clearTimeout(t);
        reading = false;
      }
      // A page whose controls work before this answers (the Freeboard panel): what the user chose meanwhile is newer
      // than the server's value, so it is kept and sent up.
      const mine = new Set(setWhileReading);
      setWhileReading.clear();
      const loggedIn = login && login.status === 'loggedIn' && typeof login.username === 'string' ? login.username : null;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        // This browser only. The choices stay the recorded owner's only while that user is the one logged in.
        owned = loggedIn !== null && local.get(OWNER_KEY) === loggedIn;
        if (mine.size) disown();
        return false;
      }
      remote = true;
      for (const [key, value] of Object.entries(data)) {
        if (!isUserPref(key) || typeof value !== 'string' || mine.has(key)) continue;
        values.set(key, value);
        local.set(key, value);
      }
      for (const key of mine) pending.set(key, values.get(key));
      user = loggedIn;
      if (user === null) {   // the user is unknown: the browser's choices are left as they are, until one is made here
        if (mine.size) disown();
        send();
        return true;
      }
      const owner = local.get(OWNER_KEY);
      for (const key of local.keys()) {
        if (!isUserPref(key) || values.has(key)) continue;
        const value = local.get(key);
        if (value === null) continue;
        if (owner === user) {
          values.set(key, value);
          pending.set(key, value);
        } else if (owner === null) {
          legacy.set(key, value);   // from before: in use here, sent up only when the user claims it
        } else {
          local.remove(key);        // another user's choice
        }
      }
      // With older choices waiting for an answer the browser has no owner yet.
      if (owner !== null || legacy.size === 0) local.set(OWNER_KEY, user);
      owned = local.get(OWNER_KEY) === user;
      send();
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
