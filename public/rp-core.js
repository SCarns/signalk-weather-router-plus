// Weather Router Plus — route planner UI, part 1 of 3 (core).
// Ported from routePlanning/ui/route-planner.html and adapted to the
// plugin's API (/plugins/signalk-weather-router-plus/api/...). Load
// order: rp-core.js, rp-layers.js, rp-plan.js — top-level const/let
// declarations share one global lexical scope across the three files.

// ─── Slider label wiring / display units ─────────────────────────────
// Display units come from the Signal K user's unit preferences, never
// from a choice on this page. Everything the plugin sends is SI. As the
// Signal K Unit Preferences guide describes for clients, the page reads
// `displayUnits` from path metadata,
//   GET /signalk/v1/api/vessels/self/<path>/meta
// which the server resolves for the logged-in user (category,
// targetUnit, formula, inverseFormula, symbol, displayFormat). The
// page's values aren't Signal K paths, so each quantity takes the
// displayUnits of one path in its category (paths from the server's
// default-categories mapping).
// Quantities with no Signal K category:
//   wave_height → follows the user's depth unit (as tide height does)
//   wave_period → always seconds
//   precip      → mm/h when the user's length unit is metric, else in/h
// There is no fallback: until the metadata loads, or for any category
// the server doesn't resolve, values show as '—' and the Display
// section names what is missing.
const CATEGORY_PATH = {
  speed: 'navigation/speedOverGround',
  distance: 'navigation/log',
  depth: 'environment/depth/belowTransducer',
  length: 'design/beam',
  temperature: 'environment/outside/temperature',
  pressure: 'environment/outside/pressure',
  time: 'navigation/racing/timeToStart',
  percentage: 'environment/outside/relativeHumidity',
};
const UNIT_CATEGORY = {
  speed: 'speed', distance: 'distance', depth: 'depth', short_distance: 'length',
  wave_height: 'depth', time: 'time', temperature: 'temperature', pressure: 'pressure',
  ratio: 'percentage',
};
const METRIC_LENGTH_UNITS = ['m', 'meter', 'mm', 'cm', 'km', 'kilometer'];
const _ident = v => v;
const WAVE_PERIOD_UNIT = { unit: 's', fn: _ident, inv: _ident, precision: 0 };
const UNIT_MISSING = '—';      // shown in place of a value whose unit is unresolved
let UI_UNITS = {};             // page quantity → {unit, fn, inv, precision[, text]}; empty until loaded

// Signal K conversion formulas use mathjs syntax. This evaluates the
// arithmetic subset (numbers, `value`, + - * / ^, parentheses, and a
// few Math functions) without eval. Returns fn(value) or null.
function _compileFormula(src) {
  const toks = String(src).match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?|[A-Za-z_]\w*|[-+*/^(),]/gi);
  if (!toks || toks.join('') !== String(src).replace(/\s+/g, '')) return null;
  const FUNCS = { sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, log: Math.log, log10: Math.log10,
    round: Math.round, floor: Math.floor, ceil: Math.ceil, pow: Math.pow, cbrt: Math.cbrt };
  let i = 0;
  const peek = () => toks[i], take = () => toks[i++];
  function expr() {
    let a = term();
    while (peek() === '+' || peek() === '-') { const op = take(), b = term(), x = a; a = op === '+' ? v => x(v) + b(v) : v => x(v) - b(v); }
    return a;
  }
  function term() {
    let a = unary();
    while (peek() === '*' || peek() === '/') { const op = take(), b = unary(), x = a; a = op === '*' ? v => x(v) * b(v) : v => x(v) / b(v); }
    return a;
  }
  function unary() {
    if (peek() === '-') { take(); const a = unary(); return v => -a(v); }
    if (peek() === '+') { take(); return unary(); }
    return power();
  }
  function power() {
    const a = atom();
    if (peek() === '^') { take(); const b = unary(); return v => Math.pow(a(v), b(v)); }
    return a;
  }
  function atom() {
    const t = take();
    if (t === undefined) throw new Error('end');
    if (t === '(') { const a = expr(); if (take() !== ')') throw new Error(')'); return a; }
    if (/^[\d.]/.test(t)) { const n = Number(t); return () => n; }
    if (t === 'value') return v => v;
    if (FUNCS[t] && peek() === '(') {
      take(); const args = [expr()];
      while (peek() === ',') { take(); args.push(expr()); }
      if (take() !== ')') throw new Error(')');
      const f = FUNCS[t];
      return v => f(...args.map(a => a(v)));
    }
    throw new Error('token ' + t);
  }
  try { const f = expr(); return i === toks.length ? f : null; } catch (_) { return null; }
}

// Duration formats named by Signal K's time conversions
// (formatDurationHMS(value) etc.). The server ships only the names, no
// implementation, so these layouts follow the unit keys (HH:MM:SS …);
// verbose and compact are this page's own wording.
const _durPad = (n, w = 2) => String(n).padStart(w, '0');
function _durParts(s) {
  const neg = s < 0; s = Math.abs(s);
  const ms = Math.round(s * 1000);
  return { neg, d: Math.floor(ms / 86400000), h: Math.floor(ms / 3600000), hd: Math.floor(ms / 3600000) % 24,
    m: Math.floor(ms / 60000) % 60, mt: Math.floor(ms / 60000), sec: Math.floor(ms / 1000) % 60, milli: ms % 1000 };
}
const DURATION_FORMATS = {
  formatDurationDHMS: s => { const p = _durParts(s); return (p.neg ? '-' : '') + _durPad(p.d) + ':' + _durPad(p.hd) + ':' + _durPad(p.m) + ':' + _durPad(p.sec); },
  formatDurationHMS: s => { const p = _durParts(s); return (p.neg ? '-' : '') + _durPad(p.h) + ':' + _durPad(p.m) + ':' + _durPad(p.sec); },
  formatDurationHMSMillis: s => { const p = _durParts(s); return (p.neg ? '-' : '') + _durPad(p.h) + ':' + _durPad(p.m) + ':' + _durPad(p.sec) + '.' + _durPad(p.milli, 3); },
  formatDurationMS: s => { const p = _durParts(s); return (p.neg ? '-' : '') + _durPad(p.mt) + ':' + _durPad(p.sec); },
  formatDurationMSMillis: s => { const p = _durParts(s); return (p.neg ? '-' : '') + _durPad(p.mt) + ':' + _durPad(p.sec) + '.' + _durPad(p.milli, 3); },
  formatDurationVerbose: s => {
    const p = _durParts(s), out = [];
    const part = (n, w) => { if (n) out.push(n + ' ' + w + (n === 1 ? '' : 's')); };
    part(p.d, 'day'); part(p.hd, 'hour'); part(p.m, 'minute');
    if (!out.length) part(p.sec, 'second');
    return (p.neg ? '-' : '') + (out.join(' ') || '0 minutes');
  },
  formatDurationCompact: s => {
    const p = _durParts(s), out = [];
    if (p.d) out.push(p.d + 'd'); if (p.hd) out.push(p.hd + 'h'); if (p.m || !out.length) out.push(p.m + 'm');
    return (p.neg ? '-' : '') + out.join(' ');
  },
};

// Signal K displayFormat ("0", "0.0", "0.00") → decimal places.
function _precisionOf(fmt) {
  const m = /^0(?:\.(0+))?$/.exec(fmt || '');
  return m ? (m[1] ? m[1].length : 0) : 1;
}

// A Signal K displayUnits object → page unit, or null when its formula
// can't be evaluated.
function _unitFromDisplayUnits(du) {
  if (!du || typeof du.formula !== 'string') return null;
  const dur = /^\s*(formatDuration\w+)\(\s*value\s*\)\s*$/.exec(du.formula);
  if (dur) {
    const text = DURATION_FORMATS[dur[1]];
    return text ? { unit: '', fn: v => v / 3600, inv: v => v * 3600, precision: 1, text } : null;
  }
  const fn = _compileFormula(du.formula), inv = _compileFormula(du.inverseFormula);
  if (!fn) return null;
  return { unit: du.symbol || du.targetUnit || '', fn, inv, precision: _precisionOf(du.displayFormat) };
}

// category → displayUnits (null where unresolved) → {units, missing}.
function _buildUnits(byCategory) {
  const u = {}, missing = new Set();
  const resolved = {};
  for (const [cat, du] of Object.entries(byCategory)) {
    resolved[cat] = _unitFromDisplayUnits(du);
    if (!resolved[cat]) missing.add(cat);
  }
  for (const [key, cat] of Object.entries(UNIT_CATEGORY)) if (resolved[cat]) u[key] = resolved[cat];
  u.wave_period = WAVE_PERIOD_UNIT;
  const len = byCategory.length;
  if (resolved.length && len) {
    u.precip = METRIC_LENGTH_UNITS.includes(len.targetUnit)
      ? { unit: 'mm/h', fn: v => v * 3600000, inv: v => v / 3600000, precision: 1 }
      : { unit: 'in/h', fn: v => v * 3600000 / 25.4, inv: v => v * 25.4 / 3600000, precision: 2 };
  }
  return { units: u, missing: [...missing] };
}

// displayUnits for one category, or null with the reason logged.
async function _fetchDisplayUnits(cat) {
  const url = '/signalk/v1/api/vessels/self/' + CATEGORY_PATH[cat] + '/meta';
  try {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) { console.warn('[units] ' + url + ' → HTTP ' + r.status); return null; }
    const meta = await r.json();
    if (!meta || !meta.displayUnits || meta.displayUnits.category !== cat) {
      console.warn('[units] ' + url + ': no "' + cat + '" displayUnits', meta && meta.displayUnits);
      return null;
    }
    return meta.displayUnits;
  } catch (e) {
    console.warn('[units] ' + url + ' failed', e);
    return null;
  }
}
let _lastUnitsJson = null;
async function loadUnitPreferences() {
  const cats = Object.keys(CATEGORY_PATH);
  const got = await Promise.all(cats.map(_fetchDisplayUnits));
  const byCategory = Object.fromEntries(cats.map((c, i) => [c, got[i]]));
  const { units, missing } = _buildUnits(byCategory);
  let status = missing.length === cats.length
    ? 'Could not read your Signal K unit preferences, so values show as ' + UNIT_MISSING + '.'
    : 'Units from your Signal K unit preferences.';
  if (missing.length && missing.length < cats.length) {
    status += ' No unit for: ' + missing.join(', ') + ', so those values show as ' + UNIT_MISSING + '.';
  }
  const json = JSON.stringify(byCategory);
  if (json !== _lastUnitsJson) { _lastUnitsJson = json; UI_UNITS = units; applyDisplayUnits(); }
  const el = document.getElementById('unitSource');
  if (el) el.textContent = status;
}

// Re-render everything that shows a number. Parts that live inside
// closures listen for `rp:units`.
function applyDisplayUnits() {
  if (typeof refreshSliderLabels === 'function') refreshSliderLabels();
  if (typeof renderResultStrip === 'function' && typeof _lastRouteProps !== 'undefined' && _lastRouteProps) renderResultStrip(_lastRouteProps, _lastNavWarns);
  if (typeof populateItinerary === 'function' && typeof _itineraryFeatures !== 'undefined' && _itineraryFeatures.length) populateItinerary(_itineraryFeatures);
  if (typeof updateLegends === 'function') updateLegends();
  if (typeof _renderConditionsPopup === 'function' && typeof _cond !== 'undefined' && _cond) _renderConditionsPopup();
  if (typeof drawPolarDiagram === 'function') drawPolarDiagram();
  if (typeof loadRouteHistory === 'function') loadRouteHistory();
  window.dispatchEvent(new Event('rp:units'));
}

// Format helpers — null-safe, return null if input is null.
function _fmt(siValue, key) {
  if (siValue == null) return null;
  const c = UI_UNITS[key];
  if (!c) return UNIT_MISSING;
  if (c.text) return c.text(siValue);
  const t = c.fn(siValue).toFixed(c.precision);
  return (t === '-0' ? '0' : t) + (c.unit ? ' ' + c.unit : '');
}
function fmtSpeed(ms)        { return _fmt(ms, 'speed'); }
function fmtDist(m)          { return _fmt(m, 'distance'); }
function fmtDepth(m)         { return _fmt(m, 'depth'); }
function fmtSwh(m)           { return _fmt(m, 'wave_height'); }
function fmtWavePeriod(s)    { return _fmt(s, 'wave_period'); }
function fmtTime(s)          { return _fmt(s, 'time'); }
function fmtShortDist(m)     { return _fmt(m, 'short_distance'); }
function fmtTemp(k)          { return _fmt(k, 'temperature'); }
function fmtPressure(pa)     { return _fmt(pa, 'pressure'); }
function fmtPrecip(rate)     { return _fmt(rate, 'precip'); }
// Display-unit descriptor for chart axes and legends: {fn, u, p};
// fn converts SI → display (may be non-linear, e.g. Beaufort). When the
// unit is unresolved, `missing` is set and fn gives NaN.
function unitDesc(key) {
  const c = UI_UNITS[key];
  return c ? { fn: c.fn, u: c.unit, p: c.precision } : { fn: () => NaN, u: '', p: 0, missing: true };
}

// Sliders hold SI (m/s for sail speed, metres for the distances,
// seconds otherwise); the readout converts to the display preset.
// `toSI` maps slider value → SI for the quantity (identity today).
const SLIDER_DISPLAY = {
  sailThresh:         { q: 'speed',          toSI: v => v },
  arrivalRadiusM:     { q: 'short_distance', toSI: v => v },
  proximityRadiusM:   { q: 'short_distance', toSI: v => v },
  xteThresholdM:      { q: 'short_distance', toSI: v => v },
};
function refreshSliderLabels() {
  for (const id of Object.keys(SLIDER_DISPLAY)) {
    const inp = document.getElementById(id), lbl = document.getElementById(id + 'Label');
    if (!inp || !lbl) continue;
    const d = SLIDER_DISPLAY[id], c = UI_UNITS[d.q];
    const u = document.querySelector('.unitOf[data-for="' + id + 'Label"]');
    if (!c) { lbl.textContent = UNIT_MISSING; if (u) u.textContent = ''; continue; }
    const v = c.fn(d.toSI(parseFloat(inp.value)));
    lbl.textContent = v.toFixed(v >= 100 ? 0 : c.precision);
    if (u) u.textContent = c.unit;
  }
  const st = document.getElementById('stages'), stl = document.getElementById('stagesLabel');
  if (st && stl) stl.textContent = parseInt(st.value, 10) > 0 ? st.value : 'auto';
}
(function () {
  const SLIDER_IDS = [
    'sailThresh', 'stages', 'arrivalRadiusM',
    'proximityRadiusM', 'xteThresholdM', 'xteSustainSec',
  ];
  for (const id of SLIDER_IDS) {
    const inp = document.getElementById(id);
    const lbl = document.getElementById(id + 'Label');
    if (!inp || !lbl) continue;
    inp.addEventListener('input', () => {
      if (SLIDER_DISPLAY[id] || id === 'stages') refreshSliderLabels(); else lbl.textContent = inp.value;
    });
  }
  refreshSliderLabels();
  // Pick up the user's preferences now, and again when the page regains
  // focus (they may have changed them in the admin UI meanwhile).
  loadUnitPreferences();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadUnitPreferences(); });
})();

// ─── Sailing tack ────────────────────────────────────────────────────
// Convention (shared with the ZedDisplay client): `wind_dir_deg` is
// the direction the wind comes FROM; the API's `twa_deg` is unsigned
// 0..180 and carries no side, so the client derives it. The side is
// the wind's bearing relative to the bow, wind minus course, wrapped
// to 0..360: 0..180 means the wind is over the starboard rail
// (starboard tack), otherwise port. Course minus wind names the
// opposite tack — do not use it.
// Returns 'starboard', 'port', or null when either input is missing.
function tackSide(cogDeg, windFromDeg) {
  if (cogDeg == null || windFromDeg == null) return null;
  const rel = ((windFromDeg - cogDeg) % 360 + 360) % 360;
  return rel <= 180 ? 'starboard' : 'port';
}
const TACK_COLOR = { starboard: '#2E7D32', port: '#D32F2F' };

// ─── Exclusive heatmap layer group ───────────────────────────────────
// Only one full-map heatmap may be visible at a time. Wind barbs,
// vector tidal-current arrows, and synoptic pressure are NOT in this
// group — they don't fully cover the map and read fine alongside a
// heatmap.
(function () {
  const HEATMAP_TOGGLE_IDS = [
    'windCombinedToggle',
    'currentHeatmapToggle',
    'roughnessToggle',
    'wavesCombinedToggle',
    'precipToggle',
    'temperatureToggle',
    'sstToggle',
    'tideToggle',
  ];
  const inputs = HEATMAP_TOGGLE_IDS
    .map((id) => document.getElementById(id))
    .filter(Boolean);

  inputs.forEach((inp) => {
    inp.addEventListener('change', function () {
      // We only need to enforce exclusivity when this toggle was
      // just TURNED ON. A user un-checking a heatmap just hides it;
      // siblings don't need to know.
      if (!this.checked) return;
      for (const other of inputs) {
        if (other === this) continue;
        if (!other.checked) continue;
        other.checked = false;
        // Re-fire the sibling's `change` event so its inline
        // onchange (which clears the layer source) runs. The
        // recursive entry into this same handler is a no-op
        // because `other.checked` is now false (see the early
        // return above).
        other.dispatchEvent(new Event('change'));
      }
    });
  });
})();

// ─── API base ────────────────────────────────────────────────────────
// The page is served at <base>/ui (base = /plugins/signalk-weather-
// router-plus); the API lives at <base>/api. Derive the base from the
// current path so a renamed plugin id or a proxy prefix still works.
const BASE = (function () {
  const m = window.location.pathname.match(/^(.*?)\/ui(?:\/|$)/);
  return m ? m[1] : '/plugins/signalk-weather-router-plus';
})();
const API = BASE + '/api';
const ROUTER = API;   // name kept from the sister app: every app fetch is ROUTER + '/…'

// Server and page are SI throughout; a number is converted only when it
// is formatted through UI_UNITS (the Signal K user's preferences). Knots
// appear in exactly one place: the wind-barb and current-arrow class
// tables (rp-layers.js), because barbs are a glyph drawn in 5-kt steps
// by meteorological convention. This is that one factor.
const KT_MS = 1852 / 3600;

// ─────────── Auth gate / request circuit breaker ───────────
// Every same-origin app fetch funnels through authFetch(): a global
// token bucket caps the rate with exponential backoff on failure, and
// the first 401 trips a hard breaker that cancels in-flight requests,
// blocks all new ones, and routes to Signal K's login page once. A
// successful sign-in redirects back here, which starts the gate
// untripped. Signal K cookie auth — no bearer tokens.
const AuthGate = {
  tripped: false,
  _inflight: new Set(),
  _stopHooks: [],
  _reauthStarted: false,
  track(c) { this._inflight.add(c); return c; },
  untrack(c) { this._inflight.delete(c); },
  onStop(fn) { this._stopHooks.push(fn); },
  trip(status) {
    if (this.tripped) return;
    this.tripped = true;
    console.warn('AuthGate: HTTP ' + status + ' — halting overlay requests');
    for (const c of this._inflight) { try { c.abort(); } catch (_) {} }
    this._inflight.clear();
    for (const fn of this._stopHooks) { try { fn(); } catch (_) {} }
    try { closeReplanStream(); } catch (_) {}
    try { if (typeof map !== 'undefined') map.render(); } catch (_) {}
    this._showBanner();
  },
  _showBanner() {
    if (document.getElementById('authExpiredBanner')) return;
    const bar = document.createElement('div');
    bar.id = 'authExpiredBanner';
    bar.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:9999;background:#b00020;color:#fff;' +
      'font:14px/1.4 system-ui,sans-serif;padding:10px 16px;display:flex;' +
      'align-items:center;justify-content:center;gap:12px;';
    bar.innerHTML =
      '<span>Signal K login required — map data has stopped loading.</span>' +
      '<button id="authReauthBtn" style="background:#fff;color:#b00020;border:0;' +
      'border-radius:4px;padding:6px 14px;font-weight:600;cursor:pointer;">Sign in</button>';
    document.body.appendChild(bar);
    document.getElementById('authReauthBtn').addEventListener('click', () => this.reauth());
    setTimeout(() => this.reauth(), 1500);   // unattended clients recover on their own
  },
  reauth() {
    if (this._reauthStarted) return;
    this._reauthStarted = true;
    const here = window.location.pathname + window.location.search + window.location.hash;
    window.location.assign('/admin/#/login?redirect=' + encodeURIComponent(here));
  },
};

// Global rate limiter (token bucket) + consecutive-failure backoff.
const _rate = { tokens: 30, max: 30, refill: 30, last: Date.now(), fails: 0, blockedUntil: 0 };
function _rateAcquire(signal) {
  // Abortable: a superseded pan/zoom request must stop waiting AND stop
  // holding its place in line.
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
    if (signal) {
      if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    (function attempt() {
      const now = Date.now();
      if (now < _rate.blockedUntil) { timer = setTimeout(attempt, _rate.blockedUntil - now); return; }
      _rate.tokens = Math.min(_rate.max, _rate.tokens + (now - _rate.last) / 1000 * _rate.refill);
      _rate.last = now;
      if (_rate.tokens >= 1) { _rate.tokens -= 1; cleanup(); resolve(); }
      else timer = setTimeout(attempt, Math.ceil((1 - _rate.tokens) / _rate.refill * 1000));
    })();
  });
}
function _rateNote(ok) {
  if (ok) { _rate.fails = 0; _rate.blockedUntil = 0; }
  else { _rate.fails = Math.min(_rate.fails + 1, 8);
         _rate.blockedUntil = Date.now() + Math.min(30000, 250 * 2 ** _rate.fails); }
}

// The single funnel for same-origin app fetches. `channel` makes a new
// request abort the prior one on that channel (pan/zoom supersession).
// 400 from an overlay endpoint ("no wave data in the forecast", "skt
// not loaded") is a routine answer, not a server failure: it must not
// wind up the backoff for every other caller.
const _authChannels = new Map();
async function authFetch(url, opts, channel) {
  if (AuthGate.tripped) throw new Error('auth-gate-tripped');
  opts = Object.assign({ credentials: 'same-origin' }, opts || {});
  const ctrl = new AbortController();
  opts.signal = ctrl.signal;
  if (channel) {
    const prev = _authChannels.get(channel);
    if (prev) { try { prev.abort(); } catch (_) {} }
    _authChannels.set(channel, ctrl);
  }
  AuthGate.track(ctrl);
  try {
    await _rateAcquire(ctrl.signal);
    if (AuthGate.tripped) throw new Error('auth-gate-tripped');
    const r = await fetch(url, opts);
    _rateNote(r.ok || r.status === 400 || r.status === 404 || r.status === 409 || r.status === 422 || r.status === 403);
    if (r.status === 401) {
      AuthGate.trip(r.status);
      const err = new Error('auth ' + r.status);
      err.rateNoted = true;
      throw err;
    }
    if (r.status === 403) {
      // Logged in but lacking permission (readonly user hitting a
      // write route) — a real answer, not a dead session.
      const err = new Error('permission denied (HTTP 403)');
      err.scopeMiss = true;
      err.rateNoted = true;
      throw err;
    }
    return r;
  } catch (e) {
    if (e.name !== 'AbortError' && !e.scopeMiss && !e.rateNoted) _rateNote(false);
    throw e;
  }
  finally {
    AuthGate.untrack(ctrl);
    if (channel && _authChannels.get(channel) === ctrl) _authChannels.delete(channel);
  }
}

// Error text out of a plugin JSON error body ({error} or {message}).
async function _apiErrorText(r) {
  try {
    const d = await r.clone().json();
    return (d && (d.error || d.message)) ? String(d.error || d.message) : ('HTTP ' + r.status);
  } catch (_) { return 'HTTP ' + r.status; }
}

// Replan EventSource handle so the gate can close it on trip.
let _activeReplanES = null;
function closeReplanStream() { if (_activeReplanES) { try { _activeReplanES.close(); } catch (_) {} _activeReplanES = null; } }


// Set default departure to now — `datetime-local` inputs interpret their
// value as LOCAL time, so build a local-time YYYY-MM-DDTHH:MM string.
const now = new Date();
now.setMinutes(0, 0, 0);
const _pad = n => String(n).padStart(2, '0');
document.getElementById('departure').value =
    `${now.getFullYear()}-${_pad(now.getMonth() + 1)}-${_pad(now.getDate())}` +
    `T${_pad(now.getHours())}:${_pad(now.getMinutes())}`;

let startCoord = null;  // [lon, lat]
let endCoord = null;
let waypointCoords = [];  // [[lon, lat], ...] — intermediate stops in order

// --- Marker features ---
const startFeature = new ol.Feature({ name: 'start' });
const endFeature = new ol.Feature({ name: 'end' });
// Waypoint features live in a parallel list so we can rebuild the set
// on every mutation and wire drag-to-move through the Modify interaction.
let waypointFeatures = [];  // one ol.Feature per waypoint, aligned with waypointCoords
const routeSource = new ol.source.Vector();
const skeletonSource = new ol.source.Vector();

// --- Route history (recent jobs on the plugin) ---
let routeHistoryItems = [];  // JobPublic rows from GET /api/routes

// Split one route segment at the antimeridian so OpenLayers draws
// the short hop over ±180 instead of a straight Mercator line across
// the whole map. a/b are [lon,lat]. Returns a list of [lon,lat]-pair
// segments — one when the segment doesn't cross ±180, two when it does.
function _segAtMeridian(a, b) {
  const lonA = a[0], latA = a[1], lonB = b[0], latB = b[1];
  if (Math.abs(lonB - lonA) <= 180) return [[a, b]];
  const lonBu = lonB > lonA ? lonB - 360 : lonB + 360;
  const bnd = lonBu < lonA ? -180 : 180;
  const t = (bnd - lonA) / (lonBu - lonA);
  const latX = latA + t * (latB - latA);
  return [[a, [bnd, latX]], [[-bnd, latX], b]];
}

// Name of the route currently on the map (from the job request), shown
// in the Itinerary name bar.
let _currentRouteName = '';

// Padding for fitting the map to a route: the side panel (desktop) or the
// bottom sheet (mobile) covers part of the map, so the fit leaves it out.
function _mapFitPadding() {
  const pad = [60, 60, 60, 60];
  const panel = document.getElementById('panel');
  if (!panel) return pad;
  const r = panel.getBoundingClientRect(), w = window.innerWidth, h = window.innerHeight;
  if (r.width >= w * 0.9 && r.top > h * 0.3) pad[2] = Math.round(h - r.top) + 20;
  else if (r.left > w * 0.3) pad[1] = Math.round(w - r.left) + 20;
  return pad;
}

function displayRoute(geojson) {
  _selectedRouteFeature = null;
  routeSource.clear();
  const features = new ol.format.GeoJSON().readFeatures(geojson, {
    featureProjection: 'EPSG:3857'
  });
  routeSource.addFeatures(features);

  // Read snap metadata from the LineString props before manipulating
  // features — we need it for both pin placement and the dashed connector.
  const _lineFeatForSnap = features.find(
    f => f.getGeometry().getType() === 'LineString');
  const _snapProps = _lineFeatForSnap
    ? _lineFeatForSnap.getProperties() : {};

  const pts = features.filter(f => f.getGeometry().getType() === 'Point');
  // Move the start/end pin markers to the reloaded route's first/last
  // waypoint so a history-loaded route shows the same green-start and
  // red-end icons as a freshly-computed one. When the server
  // snapped an endpoint to a nearby navigable cell, the visible pin
  // stays at the original (user-intent) point — the dashed maroon
  // connector below bridges intent → anchor.
  if (pts.length > 0) {
    const startLonLat = _snapProps.start_original
      ? _snapProps.start_original
      : ol.proj.toLonLat(pts[0].getGeometry().getCoordinates());
    const endLonLat = _snapProps.end_original
      ? _snapProps.end_original
      : ol.proj.toLonLat(pts[pts.length - 1].getGeometry().getCoordinates());
    const startMercator = ol.proj.fromLonLat(startLonLat);
    const endMercator = ol.proj.fromLonLat(endLonLat);
    startFeature.setGeometry(new ol.geom.Point(startMercator));
    endFeature.setGeometry(new ol.geom.Point(endMercator));
    // Keep the global [lon, lat] state in sync with the visible pins
    // so the next "Find Route" POSTs the right endpoints.
    startCoord = [startLonLat[0], startLonLat[1]];
    endCoord = [endLonLat[0], endLonLat[1]];
    if (typeof updateCoordDisplay === 'function') {
      updateCoordDisplay('start', startCoord);
      updateCoordDisplay('end', endCoord);
    }
    // Via points the route was asked to pass through become draggable
    // orange pins again, so a re-run keeps them.
    const vias = pts.filter(f => f.get('role') === 'via').map(f => ol.proj.toLonLat(f.getGeometry().getCoordinates()));
    if (vias.length && typeof _rebuildWaypointFeatures === 'function') {
      waypointCoords = vias.map(c => [c[0], c[1]]);
      _rebuildWaypointFeatures();
    }
    if (typeof refreshFindRouteEnabled === 'function') {
      refreshFindRouteEnabled();
    }
  }
  // Set outgoing_cog on each point
  for (let k = 0; k < pts.length - 1; k++) {
    const c1 = pts[k].getGeometry().getCoordinates();
    const c2 = pts[k + 1].getGeometry().getCoordinates();
    const dx = c2[0] - c1[0];
    const dy = c2[1] - c1[1];
    const bearing = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
    pts[k].set('outgoing_cog', bearing);
  }
  for (let k = 1; k < pts.length; k++) {
    const prev = pts[k - 1];
    const curr = pts[k];
    const currMode = curr.get('mode');
    const currCog = curr.get('cog_deg');
    const currWind = curr.get('wind_dir_deg');
    let segColor;
    if (currMode !== 'sailing') {
      segColor = '#000000';
    } else {
      // Leg departing prev is coloured by the arriving waypoint's cog
      // and wind (forward-looking); starboard when either is missing.
      segColor = TACK_COLOR[tackSide(currCog, currWind) || 'starboard'];
    }
    prev.set('next_mode', currMode);
    prev.set('next_cog', currCog);
    prev.set('next_wind', currWind);
    prev.set('next_sog_ms', curr.get('sog_ms'));
    prev.set('next_twa_deg', curr.get('twa_deg'));
    prev.set('next_wind_ms', curr.get('wind_ms'));
    prev.set('next_wind_dir_deg', curr.get('wind_dir_deg'));
    prev.set('next_current_ms', curr.get('current_ms'));
    prev.set('next_current_dir_deg', curr.get('current_dir_deg'));
    prev.set('next_depth_m', curr.get('depth_m'));
    prev.set('next_swh_m', curr.get('swh_m'));
    prev.set('next_mwp_s', curr.get('mwp_s'));
    prev.set('next_mwd_deg', curr.get('mwd_deg'));
    // The leg ends after the forecast's last step: drawn dashed, the point
    // flagged for the itinerary card and the saved description.
    const beyond = !!curr.get('beyond_forecast');
    prev.set('next_beyond_forecast', beyond);
    const _ac = prev.getGeometry().getCoordinates();
    const _bc = curr.getGeometry().getCoordinates();
    const _aLL = ol.proj.toLonLat(_ac);
    const _bLL = ol.proj.toLonLat(_bc);
    let _segPairs;
    if (Math.abs(_bLL[0] - _aLL[0]) <= 180) {
      _segPairs = [[_ac, _bc]];
    } else {
      // Dateline-crossing: split at ±180 so it renders the short way.
      _segPairs = _segAtMeridian(_aLL, _bLL).map(
        sp => [ol.proj.fromLonLat(sp[0]), ol.proj.fromLonLat(sp[1])]);
    }
    for (const _sp of _segPairs) {
      const segLine = new ol.Feature({
        geometry: new ol.geom.LineString([_sp[0], _sp[1]])
      });
      segLine.setStyle(new ol.style.Style({
        stroke: new ol.style.Stroke({ color: segColor, width: 3, lineDash: beyond ? [10, 7] : undefined })
      }));
      routeSource.addFeature(segLine);
    }
  }
  // Where the forecast runs out along the route: a marker on the first leg
  // that ends after the last forecast step, placed by time along that leg.
  const _validTo = _snapProps.forecast_valid_to ? Date.parse(_snapProps.forecast_valid_to) : NaN;
  const _firstBeyond = pts.findIndex(f => f.get('beyond_forecast'));
  if (Number.isFinite(_validTo) && _firstBeyond > 0) {
    const a = pts[_firstBeyond - 1], b = pts[_firstBeyond];
    const ta = Date.parse(a.get('time')), tb = Date.parse(b.get('time'));
    const frac = tb > ta ? Math.min(1, Math.max(0, (_validTo - ta) / (tb - ta))) : 0;
    const aLL = ol.proj.toLonLat(a.getGeometry().getCoordinates()), bLL = ol.proj.toLonLat(b.getGeometry().getCoordinates());
    let dLon = bLL[0] - aLL[0];
    if (dLon > 180) dLon -= 360; else if (dLon < -180) dLon += 360;
    const at = ol.proj.fromLonLat([aLL[0] + dLon * frac, aLL[1] + (bLL[1] - aLL[1]) * frac]);
    routeSource.addFeature(new ol.Feature({ geometry: new ol.geom.Point(at), kind: 'forecast_end', valid_to: _snapProps.forecast_valid_to }));
  }

  const lineFeat = features.find(f => f.getGeometry().getType() === 'LineString');
  if (lineFeat) {
    const p = lineFeat.getProperties();

    // Maroon dashed connector(s): intent → anchor where the server
    // snapped an unnavigable endpoint to the nearest navigable cell.
    const _dashedStyle = new ol.style.Style({
      stroke: new ol.style.Stroke({
        color: '#7F0000', width: 2, lineDash: [6, 6]
      })
    });
    if (p.start_original && p.start_anchor && p.start_snap_distance_m > 0) {
      const f = new ol.Feature({
        geometry: new ol.geom.LineString([
          ol.proj.fromLonLat(p.start_original),
          ol.proj.fromLonLat(p.start_anchor),
        ])
      });
      f.setStyle(_dashedStyle);
      routeSource.addFeature(f);
    }
    if (p.end_original && p.end_anchor && p.end_snap_distance_m > 0) {
      const f = new ol.Feature({
        geometry: new ol.geom.LineString([
          ol.proj.fromLonLat(p.end_original),
          ol.proj.fromLonLat(p.end_anchor),
        ])
      });
      f.setStyle(_dashedStyle);
      routeSource.addFeature(f);
    }
    // Drawn waypoints that were on land and were moved to the nearest water
    // (`snaps`, every stop; the start and end are drawn above).
    const _snaps = Array.isArray(p.snaps) ? p.snaps : [];
    const _lastStop = p.stop_count > 0 ? p.stop_count - 1 : -1;
    for (const s of _snaps) {
      if (s.index === 0 || s.index === _lastStop || !s.original || !s.anchor) continue;
      const f = new ol.Feature({ geometry: new ol.geom.LineString([ol.proj.fromLonLat(s.original), ol.proj.fromLonLat(s.anchor)]) });
      f.setStyle(_dashedStyle);
      routeSource.addFeature(f);
    }

    // Warning text for the info card — surfaces snaps and the
    // forecast-horizon note to the user.
    const _navWarns = [];
    if (p.start_snap_distance_m > 0) {
      _navWarns.push('Start not navigable — anchored '
        + Math.round(p.start_snap_distance_m) + ' m away');
    }
    if (p.end_snap_distance_m > 0) {
      _navWarns.push('End not navigable — anchored '
        + Math.round(p.end_snap_distance_m) + ' m away');
    }
    for (const s of _snaps) {
      if (s.index === 0 || s.index === _lastStop) continue;
      _navWarns.push('Waypoint ' + s.index + ' was on land — anchored ' + Math.round(s.distance_m) + ' m away');
    }
    _routeWarnings = Array.isArray(p.warnings) ? p.warnings : [];
    renderResultStrip(p, _navWarns);
    const nameInput = document.getElementById('routeNameInput');
    if (nameInput) nameInput.value = p.name || _currentRouteName || '';
    routeSource.removeFeature(lineFeat);
  }
  // Refresh the itinerary tab with this route's waypoints.
  if (typeof populateItinerary === 'function') {
    populateItinerary(features);
  }
}

// ─────────── Polar picker (GET /api/polars) ───────────
let _polarItems = [];

function _renderPolarOptions(filterText) {
  const sel = document.getElementById('polarSelect');
  const needle = (filterText || '').trim().toLowerCase();
  const filtered = needle
    ? _polarItems.filter(it => it.label.toLowerCase().includes(needle)
                            || it.path.toLowerCase().includes(needle))
    : _polarItems;
  const current = sel.value;
  sel.innerHTML = filtered.map(it => {
    const opt = document.createElement('option');
    opt.value = it.path;
    opt.textContent = it.label;
    return opt.outerHTML;
  }).join('') || '<option value="">(no matches)</option>';
  // Preserve current selection if still visible; otherwise pick first match.
  if (filtered.some(it => it.path === current)) {
    sel.value = current;
  } else if (filtered.length > 0) {
    sel.value = filtered[0].path;
  }
}

function loadPolarList() {
  const sel = document.getElementById('polarSelect');
  const stored = (() => { try { return localStorage.getItem('polarPath') || ''; } catch (_) { return ''; } })();
  return authFetch(ROUTER + '/polars', {}, null)
    .then(r => r.json())
    .then(items => {
      if (!Array.isArray(items) || items.length === 0) {
        sel.innerHTML = '<option value="">(no polars found — configure a polar file or polars directory in the plugin settings)</option>';
        _polarItems = [];
        _polarAngles = null; _polarTable = null;
        drawPolarDiagram();
        return;
      }
      _polarItems = items;
      _renderPolarOptions('');
      // Prefer the last-used selection if it's still in the list;
      // otherwise fall back to the vessel default (first item).
      const paths = items.map(it => it.path);
      sel.value = paths.includes(stored) ? stored : paths[0];
      loadPolarAngles(sel.value);
      loadPolarTable(sel.value);
    })
    .catch(e => {
      sel.innerHTML = '<option value="">(error loading polars)</option>';
      console.log('Polar list error:', e);
    });
}

let _polarAngles = null;   // { tws_ms:[], beat_deg:[], run_deg:[] }
function loadPolarAngles(polarPath) {
  if (!polarPath) { _polarAngles = null; drawPolarDiagram(); return; }
  authFetch(ROUTER + '/polar-angles?path=' + encodeURIComponent(polarPath), {}, 'polar-angles')
    .then(r => r.ok ? r.json() : null)
    .then(d => { _polarAngles = d; drawPolarDiagram(); })
    .catch(() => { _polarAngles = null; });
}

// ─────────── Polar diagram (GET /api/polars/table) ───────────
// Half polar, TWA 0–180° clockwise from the top, one curve per TWS,
// radius = boat speed in the display speed unit. Beat/run angles from
// /polar-angles are dotted on each curve.
let _polarTable = null;    // { twa_deg:[], tws_ms:[], speeds_ms:[][] } rows = twa
function loadPolarTable(polarPath) {
  if (!polarPath) { _polarTable = null; drawPolarDiagram(); return; }
  authFetch(ROUTER + '/polars/table?path=' + encodeURIComponent(polarPath), {}, 'polar-table')
    .then(r => r.ok ? r.json() : r.json().then(d => Promise.reject(new Error(d.error || ('HTTP ' + r.status)))))
    .then(d => { _polarTable = d; drawPolarDiagram(); })
    .catch(err => {
      _polarTable = null; drawPolarDiagram();
      const info = document.getElementById('polarInfo');
      if (info) info.textContent = 'Polar table unavailable: ' + err.message;
    });
}
const _POLAR_TWS_COLORS = ['#90caf9', '#4fc3f7', '#00897b', '#43a047', '#f9a825', '#e64a19', '#c62828', '#8a0000', '#6a1b9a', '#ad1457', '#37474f', '#000'];
function drawPolarDiagram() {
  const canvas = document.getElementById('polarDiagram');
  const info = document.getElementById('polarInfo');
  if (!canvas) return;
  // PLOT_H is the diagram; the strip below it holds the caption, clear of the 180° label.
  const W = 380, PLOT_H = 300, H = PLOT_H + 16;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  ctx.font = '10px sans-serif';
  const T = _polarTable;
  if (!T || !Array.isArray(T.twa_deg) || !Array.isArray(T.tws_ms) || !T.twa_deg.length || !T.tws_ms.length) {
    ctx.fillStyle = '#888'; ctx.textAlign = 'center';
    ctx.fillText(_polarItems.length ? 'Loading polar…' : 'No polar loaded', W / 2, H / 2);
    if (info && !T) info.textContent = '';
    return;
  }
  const u = unitDesc('speed'); u.p = 0;
  if (u.missing) {
    ctx.fillStyle = '#888'; ctx.textAlign = 'center';
    ctx.fillText('No speed unit from your Signal K unit preferences', W / 2, H / 2);
    return;
  }
  const cx = 96, cy = PLOT_H / 2, R = Math.min(cy - 18, W - cx - 14);
  let vmax = 0;
  for (const row of T.speeds_ms) for (const v of row) if (Number.isFinite(v)) vmax = Math.max(vmax, u.fn(v));
  if (vmax <= 0) vmax = 1;
  // Ring step: a round number in the display unit giving 3–6 rings.
  const rawStep = vmax / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(s => s >= rawStep) || rawStep;
  const rmax = Math.ceil(vmax / step) * step;
  const rOf = v => v / rmax * R;
  const xy = (twa, v) => { const a = twa * Math.PI / 180; return [cx + Math.sin(a) * rOf(v), cy - Math.cos(a) * rOf(v)]; };
  // Rings + radial spokes.
  ctx.strokeStyle = '#e0e0e0'; ctx.fillStyle = '#777'; ctx.lineWidth = 1;
  for (let v = step; v <= rmax + 1e-9; v += step) {
    ctx.beginPath(); ctx.arc(cx, cy, rOf(v), -Math.PI / 2, Math.PI / 2); ctx.stroke();
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText(v.toFixed(u.p), cx - 3, cy - rOf(v) + 1);
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (let a = 0; a <= 180; a += 30) {
    const [x, y] = xy(a, rmax);
    ctx.strokeStyle = a % 90 === 0 ? '#bbb' : '#eaeaea';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
    const [lx, ly] = xy(a, rmax * 1.06);
    ctx.fillStyle = '#555';
    ctx.textAlign = a === 0 || a === 180 ? 'center' : 'left';
    ctx.fillText(a + '°', lx, ly);
  }
  ctx.strokeStyle = '#999'; ctx.beginPath(); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
  // One curve per TWS.
  const nW = T.tws_ms.length;
  for (let k = 0; k < nW; k++) {
    const color = _POLAR_TWS_COLORS[Math.min(k, _POLAR_TWS_COLORS.length - 1)];
    ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.beginPath();
    let up = true;
    for (let i = 0; i < T.twa_deg.length; i++) {
      const v = T.speeds_ms[i] ? T.speeds_ms[i][k] : null;
      if (v == null || !Number.isFinite(v)) { up = true; continue; }
      const [x, y] = xy(T.twa_deg[i], u.fn(v));
      if (up) { ctx.moveTo(x, y); up = false; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // Beat / run angle markers from /polar-angles.
    if (_polarAngles && Array.isArray(_polarAngles.tws_ms)) {
      const j = _polarAngles.tws_ms.findIndex(t => Math.abs(t - T.tws_ms[k]) < 1e-6);
      if (j >= 0) {
        for (const ang of [_polarAngles.beat_deg[j], _polarAngles.run_deg[j]]) {
          if (ang == null) continue;
          const v = _polarSpeedAt(T, ang, k);
          if (v == null) continue;
          const [x, y] = xy(ang, u.fn(v));
          ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
        }
      }
    }
  }
  // Legend: TWS per curve, in the display speed unit.
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = '10px sans-serif';
  const lx = 6; let ly = 14;
  ctx.fillStyle = '#333'; ctx.fillText('TWS (' + u.u + ')', lx, ly); ly += 13;
  for (let k = 0; k < nW; k++) {
    ctx.fillStyle = _POLAR_TWS_COLORS[Math.min(k, _POLAR_TWS_COLORS.length - 1)];
    ctx.fillRect(lx, ly - 4, 14, 3);
    ctx.fillStyle = '#333'; ctx.fillText(u.fn(T.tws_ms[k]).toFixed(u.p), lx + 18, ly);
    ly += 12;
    if (ly > PLOT_H - 8) break;
  }
  ctx.fillStyle = '#777'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.fillText('rings: boat speed (' + u.u + ') · dots: beat / run VMG angles', lx, H - 4);
  if (info) {
    const sel = document.getElementById('polarSelect');
    const it = _polarItems.find(p => p.path === (sel ? sel.value : ''));
    info.textContent = (it ? it.label + ' — ' : '') + T.twa_deg.length + ' angles × ' + nW + ' wind speeds';
  }
}
// Linear interpolation of a polar row at an arbitrary TWA for curve k.
function _polarSpeedAt(T, twa, k) {
  const A = T.twa_deg;
  if (!A.length) return null;
  if (twa <= A[0]) return T.speeds_ms[0][k];
  if (twa >= A[A.length - 1]) return T.speeds_ms[A.length - 1][k];
  for (let i = 1; i < A.length; i++) {
    if (twa <= A[i]) {
      const f = (twa - A[i - 1]) / (A[i] - A[i - 1]);
      const a = T.speeds_ms[i - 1][k], b = T.speeds_ms[i][k];
      if (a == null || b == null) return a == null ? b : a;
      return a + f * (b - a);
    }
  }
  return null;
}

document.getElementById('polarSelect').addEventListener('change', function() {
  try { localStorage.setItem('polarPath', this.value); } catch (_) {}
  loadPolarAngles(this.value);
  loadPolarTable(this.value);
});

// ─────────── Persist route-variable controls across reloads ───────────
// All route params except `departure` (which should default to "now"
// each session) are saved to localStorage on change and restored on
// load. Ranges fire an 'input' event after restore so the paired
// labels update to match.
(function() {
  const PERSIST_IDS = [
    'mode', 'sailThresh', 'stages', 'arrivalRadiusM', 'precision',
    'publishSel', 'proximityRadiusM', 'xteThresholdM', 'xteSustainSec',
  ];
  const CHECK_IDS = ['noCurrents', 'noForecast'];
  // The sail-speed slider held knots until 2026-10; it holds m/s now under a new key.
  try {
    const old = localStorage.getItem('routeVar:sailThresh');
    if (old !== null) {
      if (old !== '' && localStorage.getItem('routeVar:sailThreshMs') === null)
        localStorage.setItem('routeVar:sailThreshMs', String(Math.round(parseFloat(old) * KT_MS * 10) / 10));
      localStorage.removeItem('routeVar:sailThresh');
    }
  } catch (_) {}
  const KEY = (id) => 'routeVar:' + (id === 'sailThresh' ? 'sailThreshMs' : id);
  for (const id of PERSIST_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    let saved = null;
    try { saved = localStorage.getItem(KEY(id)); } catch (_) {}
    if (saved != null && saved !== '') {
      el.value = saved;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    el.addEventListener('change', function() {
      try { localStorage.setItem(KEY(id), el.value); } catch (_) {}
    });
    if (el.type === 'range') {
      el.addEventListener('input', function() {
        try { localStorage.setItem(KEY(id), el.value); } catch (_) {}
      });
    }
  }
  for (const id of CHECK_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    let saved = null;
    try { saved = localStorage.getItem(KEY(id)); } catch (_) {}
    if (saved === 'true' || saved === 'false') el.checked = saved === 'true';
    el.addEventListener('change', function() {
      try { localStorage.setItem(KEY(id), el.checked ? 'true' : 'false'); } catch (_) {}
    });
  }
})();

// Map-layer toggle persistence. Each checkbox's checked state is
// stored in localStorage. The restore step is deferred to `window.load`
// because the inline `onchange` handlers reference `osmLayer`,
// `windLayer`, etc., which are declared in rp-layers.js.
(function() {
  const LAYER_IDS = [
    'osmToggle', 'seamarkToggle', 'vesselToggle',
    'currentToggle', 'windToggle', 'windCombinedToggle', 'currentHeatmapToggle', 'roughnessToggle', 'wavesCombinedToggle', 'precipToggle', 'temperatureToggle', 'sstToggle', 'tideToggle', 'pressureToggle',
  ];
  const KEY = (id) => 'layer:' + id;
  for (const id of LAYER_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('change', function() {
      try { localStorage.setItem(KEY(id), el.checked ? 'true' : 'false'); } catch (_) {}
    });
  }
  window.addEventListener('load', function() {
    for (const id of LAYER_IDS) {
      const el = document.getElementById(id);
      if (!el) continue;
      let saved = null;
      try { saved = localStorage.getItem(KEY(id)); } catch (_) {}
      if (saved !== 'true' && saved !== 'false') continue;
      const want = saved === 'true';
      if (el.checked !== want) {
        el.checked = want;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  });
})();
document.getElementById('polarFilter').addEventListener('input', function() {
  _renderPolarOptions(this.value);
});
loadPolarList();

// ─────────── Vessel/polar specs form (VPP generator) ───────────
// POST /api/polar-from-specs runs the plugin's polar calculator on the specs
// and writes <polarsDir>/user/<slug>.csv; the new polar is then selected
// in the picker. The sister app's sailboatdata search (Algolia + a public
// CORS proxy for the boat page) is not carried over: a Signal K server
// on a boat is often offline and the plugin makes no third-party calls
// from the browser. The plain sailboatdata.com link stays.
(function() {
  const overlay = document.getElementById('vesselOverlay');
  const openBtn = document.getElementById('openVesselForm');
  const closeBtn = document.getElementById('vesselClose');
  const cancelBtn = document.getElementById('vf_cancel');
  const generateBtn = document.getElementById('vf_generate');
  const sbdLink = document.getElementById('sbdLink');
  const resultDiv = document.getElementById('vf_result');
  const warnDiv = document.getElementById('vf_warnings');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function openModal() {
    overlay.style.display = 'flex';
    resultDiv.innerHTML = '';
    warnDiv.innerHTML = '';
  }
  function closeModal() {
    overlay.style.display = 'none';
  }
  openBtn.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);

  // Update the sailboatdata link to use the current boat name as a
  // hint for the user's search.
  document.getElementById('vf_name').addEventListener('input', function() {
    const name = this.value.trim();
    if (name) {
      sbdLink.href = 'https://sailboatdata.com/?s=' + encodeURIComponent(name);
    } else {
      sbdLink.href = 'https://sailboatdata.com/';
    }
  });

  function post(body) {
    return authFetch(ROUTER + '/polar-from-specs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, null);
  }

  generateBtn.addEventListener('click', async function() {
    warnDiv.innerHTML = '';
    resultDiv.innerHTML = '';

    const g = id => document.getElementById(id);
    const num = id => {
      const v = g(id).value.trim();
      return v === '' ? null : parseFloat(v);
    };
    const name = g('vf_name').value.trim();
    if (!name) {
      warnDiv.innerHTML = 'Boat name is required.';
      return;
    }

    const body = {
      name: name,
      specs: {
        loa_m: num('vf_loa'),
        lwl_m: num('vf_lwl'),
        beam_m: num('vf_beam'),
        draft_m: num('vf_draft'),
        displacement_kg: num('vf_disp'),
        ballast_kg: num('vf_ballast'),
        sail_area_upwind_m2: num('vf_sa_up'),
        rig_type: g('vf_rig').value,
        keel_type: g('vf_keel').value,
        hull_type: 'monohull',
      },
      overwrite: false,
    };

    // Basic client-side validation — all required fields must have values.
    const req = ['loa_m', 'lwl_m', 'beam_m', 'draft_m', 'displacement_kg', 'sail_area_upwind_m2'];
    for (const k of req) {
      if (body.specs[k] == null || isNaN(body.specs[k])) {
        warnDiv.innerHTML = 'Missing required value: ' + k;
        return;
      }
    }
    if (body.specs.ballast_kg != null && isNaN(body.specs.ballast_kg)) body.specs.ballast_kg = null;

    generateBtn.disabled = true;
    generateBtn.textContent = 'Generating…';
    try {
      let resp = await post(body);
      if (resp.status === 409) {
        if (!confirm('A polar with that name already exists. Overwrite?')) {
          return;
        }
        body.overwrite = true;
        resp = await post(body);
      }
      const data = await resp.json();
      if (!resp.ok) {
        warnDiv.innerHTML = 'Error: ' + esc(data.error || data.detail || resp.status);
        return;
      }
      const warnings = (data.warnings || []).join('; ');
      resultDiv.innerHTML =
        '<div style="color:#2a7;">✓ Polar saved to ' + esc(data.path) + ' (' + esc(data.label) + ')</div>'
        + (warnings ? '<div style="color:#c60;margin-top:4px;">Warnings: ' + esc(warnings) + '</div>' : '')
        + '<div style="margin-top:8px;">Refreshing polar list…</div>';

      // Refresh the polar dropdown so the new entry appears, and select it.
      // Stored first: loadPolarList() restores the stored path and loads
      // its angles and diagram. The filter is cleared so the entry shows.
      try { localStorage.setItem('polarPath', data.path); } catch (_) {}
      const filt = document.getElementById('polarFilter');
      if (filt) filt.value = '';
      await loadPolarList();
      const sel = document.getElementById('polarSelect');
      let found = false;
      for (let i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === data.path) {
          if (sel.selectedIndex !== i) {
            sel.selectedIndex = i;
            loadPolarAngles(sel.value);
            loadPolarTable(sel.value);
          }
          found = true;
          break;
        }
      }
      resultDiv.innerHTML += found
        ? '<div style="color:#2a7;margin-top:4px;">Selected as active polar.</div>'
        : '<div style="color:#c60;margin-top:4px;">Saved, but it is not in the polar list (check the plugin\'s polars directory).</div>';
    } catch (e) {
      warnDiv.innerHTML = 'Request failed: ' + esc(e.message);
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = 'Generate polar';
    }
  });
})();

// ─────────── Plugin status (header line + Forecast data section) ───────────
let _pluginStatus = null;
/** Text for innerHTML: escapes &, <, >, " and '. */
function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function _statusLine(s) {
  const f = s.forecast;
  if (s.starting) return '<span class="warn">' + escapeHtml(s.starting) + '</span>';
  if (!f) return '<span class="warn">no forecast loaded</span>' + (s.forecast_error ? ': ' + escapeHtml(s.forecast_error) : ' (loading)');
  const cur = Array.isArray(s.currents) && s.currents.length ? s.currents.map(c => c.name).join(', ') : 'none';
  return '<span class="ok">forecast</span> ' + f.cycle.slice(0, 13) + 'Z · ' + f.steps + ' steps to ' + f.valid_to.slice(0, 13) + 'Z'
    + (f.has_waves ? ' · waves' : '') + '<br>currents: ' + cur
    + (s.jobs ? ' · jobs: ' + (s.jobs.running ? 'running' : 'idle') + ', ' + s.jobs.queued + ' queued' : '')
    // A refused reload (e.g. the memory guard) while the previous forecast keeps serving.
    + (s.forecast_error ? '<br><span class="warn">' + escapeHtml(s.forecast_error) + '</span>' : '');
}
let _statusSoon = null;
function loadPluginStatus() {
  const el = document.getElementById('dataStatus');
  const fi = document.getElementById('forecastInfo');
  return authFetch(ROUTER + '/status', { cache: 'no-store' }, 'status')
    .then(r => r.json())
    .then(s => {
      _pluginStatus = s;
      if (el) el.innerHTML = _statusLine(s);
      // First start (coastline, first forecast): check again soon, not in 30 s.
      clearTimeout(_statusSoon);
      if (s.starting || !s.forecast) _statusSoon = setTimeout(loadPluginStatus, 5000);
      if (fi) {
        const f = s.forecast;
        fi.innerHTML = f
          ? 'Cycle <b>' + f.cycle + '</b><br>valid ' + f.valid_from + ' → ' + f.valid_to + '<br>coverage ' + (f.coverage || 'global')
            + (typeof f.decoded_bytes === 'number' ? ', ' + (f.decoded_bytes / 1e6).toFixed(0) + ' MB decoded on disk' : '')
            + (f.memory ? ', ' + ((f.memory.data_worker_held_bytes + f.memory.route_worker_held_bytes) / 1e6).toFixed(1) + ' MB in memory now' : '')
            + '<br>params: ' + (f.params || []).join(', ') + (s.extra_fields ? '' : '<br><span style="color:var(--warn)">extra fields (temperature, precipitation, SST, humidity) are off in Settings</span>')
            + (s.rtofs_run ? '<br>RTOFS run ' + s.rtofs_run : '')
            + (s.vessel ? '<br>vessel ' + (s.vessel.name || '—') + ', motor ' + (fmtSpeed(s.vessel.motorSpeedMs) || '—') : '')
          : '<span style="color:var(--warn)">No forecast loaded' + (s.forecast_error ? ': ' + escapeHtml(s.forecast_error) : '') + '</span>';
      }
      window.dispatchEvent(new Event('rp:status'));
    })
    .catch(e => { if (el) el.innerHTML = '<span class="err">status unavailable</span>: ' + e.message; });
}
loadPluginStatus();
setInterval(loadPluginStatus, 30000);
document.getElementById('refreshForecast').addEventListener('click', function() {
  const st = document.getElementById('refreshForecastStatus');
  st.textContent = 'requesting…';
  authFetch(ROUTER + '/forecast/refresh', { method: 'POST' }, null)
    .then(r => r.ok ? r.json() : _apiErrorText(r).then(t => Promise.reject(new Error(t))))
    .then(() => { st.textContent = 'refresh requested — status updates in a moment'; setTimeout(loadPluginStatus, 4000); setTimeout(loadPluginStatus, 15000); })
    .catch(e => { st.textContent = 'refresh failed: ' + e.message; });
});

// ─────────── Route library: recent jobs (GET /api/routes) ───────────
// Track the job id of the route currently displayed on the map. Used by
// the Publish + Delete buttons and set from two places: the history
// list, and the SSE `done` event after a fresh compute.
let _currentRouteJobId = null;

function _jobLabel(j) {
  const rq = j.request || {};
  if (rq.name) return rq.name;
  const s = rq.start, e = rq.end;
  if (s && e) return s.lat.toFixed(3) + ', ' + s.lon.toFixed(3) + ' → ' + e.lat.toFixed(3) + ', ' + e.lon.toFixed(3);
  return j.id;
}
function _jobSub(j) {
  const parts = [];
  if (j.created_at) parts.push(new Date(j.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
  if (j.summary) {
    if (j.summary.total_distance_m != null) parts.push(fmtDist(j.summary.total_distance_m));
    if (j.summary.total_time_s != null) parts.push(fmtTime(j.summary.total_time_s));
    if (j.summary.warnings) parts.push(j.summary.warnings + ' warn');
  }
  if (j.request && j.request.mode) parts.push(j.request.mode);
  if (j.resource_id) parts.push('published');
  if (j.error && j.status !== 'done') parts.push(j.error);
  return parts.join(' · ');
}

function _loadRouteJob(id) {
  if (!id) return;
  const job = routeHistoryItems.find(j => j.id === id);
  if (job && (job.status === 'running' || job.status === 'queued')) {
    // Re-attach to a job in progress: same SSE ladder as Find Route.
    if (typeof attachToJob === 'function') attachToJob(id, job);
    return;
  }
  _currentRouteJobId = id;
  _currentRouteName = job && job.request ? (job.request.name || '') : '';
  authFetch(ROUTER + '/routes/' + encodeURIComponent(id) + '/result', { cache: 'no-store' }, 'route-load')
    .then(r => r.ok ? r.json() : _apiErrorText(r).then(t => Promise.reject(new Error(t))))
    .then(geojson => {
      displayRoute(geojson);
      routeActive = true;
      _routeStale = false;
      if (typeof updatePlanHint === 'function') updatePlanHint();
      // Zoom to the loaded route's extent with padding so the map
      // frames the entire track beside the panel (not under it).
      const ext = routeSource.getExtent();
      if (ext && ext.every(Number.isFinite)) {
        map.getView().fit(ext, {
          padding: _mapFitPadding(),
          duration: 400,
          maxZoom: 14,
        });
      }
      if (typeof showTab === 'function') showTab('itinerarySection');
    })
    .catch(err => {
      console.error('Failed to load route:', err);
      const st = document.getElementById('status');
      if (st) st.textContent = 'Could not load route: ' + err.message;
    });
  // Skeleton (coarse A*) when the job has one.
  authFetch(ROUTER + '/routes/' + encodeURIComponent(id) + '/skeleton', { cache: 'no-store' }, 'skeleton-load')
    .then(r => r.ok ? r.json() : null)
    .then(geojson => {
      skeletonSource.clear();
      if (!geojson) return;
      const features = new ol.format.GeoJSON().readFeatures(geojson, { featureProjection: 'EPSG:3857' });
      skeletonSource.addFeatures(features);
    })
    .catch(() => skeletonSource.clear());
  if (typeof _loadFronts === 'function') _loadFronts(id);
}

function _clearDisplayedRoute() {
  _currentRouteJobId = null;
  _currentRouteName = '';
  routeSource.clear();
  skeletonSource.clear();
  frontSource.clear();
  startFeature.setGeometry(null);
  endFeature.setGeometry(null);
  const routeInfo = document.getElementById('routeInfo');
  if (routeInfo) routeInfo.innerHTML = '';
  const modalItin = document.getElementById('modalItinerary');
  if (modalItin) modalItin.innerHTML = '';
  const nameInput = document.getElementById('routeNameInput');
  if (nameInput) nameInput.value = '';
}

function _deleteRouteJob(id, labelForConfirm) {
  if (!id) return;
  if (!confirm(`Delete "${labelForConfirm || id}"?`)) return;
  authFetch(ROUTER + '/routes/' + encodeURIComponent(id), { method: 'DELETE', cache: 'no-store' }, null)
    .then(r => { if (!r.ok && r.status !== 204) return _apiErrorText(r).then(t => Promise.reject(new Error(t))); })
    .then(() => {
      // If the deleted route is the one on the map, clear it.
      if (_currentRouteJobId === id) _clearDisplayedRoute();
      loadRouteHistory();
    })
    .catch(err => alert('Delete failed: ' + err.message));
}

function loadRouteHistory() {
  return authFetch(ROUTER + '/routes?limit=50', { cache: 'no-store' }, 'route-history')
    .then(r => r.json())
    .then(items => {
      routeHistoryItems = Array.isArray(items) ? items : [];
      const list = document.getElementById('routeHistoryList');
      if (!list) return;
      list.replaceChildren();
      if (routeHistoryItems.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:8px;color:#888;font-size:11px;';
        empty.textContent = 'No route jobs yet.';
        list.appendChild(empty);
        return;
      }
      routeHistoryItems.forEach((j, i) => {
        const row = document.createElement('div');
        row.className = 'rh-row';
        if (j.id === _currentRouteJobId) row.style.background = '#1c1c3a';
        const label = document.createElement('span');
        label.className = 'rh-label';
        label.textContent = (i + 1) + '. ' + _jobLabel(j);
        const sub = document.createElement('span');
        sub.className = 'rh-sub';
        sub.textContent = _jobSub(j);
        label.appendChild(sub);
        label.onclick = () => _loadRouteJob(j.id);
        row.appendChild(label);
        const st = document.createElement('span');
        st.className = 'rh-status ' + j.status;
        st.textContent = j.status;
        st.onclick = () => _loadRouteJob(j.id);
        row.appendChild(st);
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'rh-del';
        del.textContent = '×';
        del.title = j.status === 'running' ? 'Cancel the running job first' : 'Delete';
        del.disabled = j.status === 'running';
        del.onclick = (e) => { e.stopPropagation(); _deleteRouteJob(j.id, _jobLabel(j)); };
        row.appendChild(del);
        list.appendChild(row);
      });
    })
    .catch(() => {});
}

// Populate the list on first load.
loadRouteHistory();
document.getElementById('routeHistoryRefresh').addEventListener('click', () => loadRouteHistory());

// ─────────── Vessel type (sail / power) ───────────
// Toggle in Setup switches the UI between a sailing run (polar picker +
// sail sliders, mode dropdown) and a motoring run. Power mode forces
// `mode=motor` on the POST /api/routes payload and sends the boat's name
// and cruise speed as a vessel override. Selection and the power-boat
// fields persist in localStorage.
function getVesselType() {
  try { return localStorage.getItem('vesselType') === 'power' ? 'power' : 'sail'; }
  catch (_) { return 'sail'; }
}
// The cruise speed is a display-unit input like the wind and wave limits
// (rp-plan.js `_LIMITS`): typed in the user's unit, kept in SI.
function readPowerBoat() {
  return {
    name: (document.getElementById('pb_name').value || '').trim(),
    cruise_ms: typeof _limitSI === 'function' ? _limitSI('pb_cruise') : null,
  };
}
function validatePowerBoat() {
  const pb = readPowerBoat();
  const missing = [];
  if (!pb.name) missing.push('name');
  if (pb.cruise_ms == null || pb.cruise_ms <= 0) missing.push('cruise speed');
  return missing;
}
function savePowerBoat() {
  try {
    localStorage.setItem('powerBoat', JSON.stringify({ name: readPowerBoat().name }));
  } catch (_) {}
}
function loadPowerBoat() {
  try {
    const j = localStorage.getItem('powerBoat');
    if (!j) return;
    const pb = JSON.parse(j);
    if (pb.name != null) document.getElementById('pb_name').value = pb.name;
    // Until 2026-10 the cruise speed was stored here in knots; it lives in SI with the other limits now.
    if (pb.cruise_kts != null && localStorage.getItem('routeVar:pb_cruise:si') === null)
      localStorage.setItem('routeVar:pb_cruise:si', String(pb.cruise_kts * KT_MS));
  } catch (_) {}
}
function refreshFindRouteEnabled() {
  // Find Route stays disabled until start + end are set; power mode
  // additionally requires the boat's name and cruise speed.
  const btn = document.getElementById('findRoute');
  const haveEndpoints = !!(startCoord && endCoord);
  let blocked = !haveEndpoints;
  const status = document.getElementById('pb_status');
  if (getVesselType() === 'power') {
    const missing = validatePowerBoat();
    if (missing.length) {
      blocked = true;
      if (status) status.textContent = 'Fill in: ' + missing.join(', ');
    } else if (status) {
      status.textContent = '';
    }
  } else if (status) {
    status.textContent = '';
  }
  if (typeof _routeComputing !== 'undefined' && _routeComputing) blocked = true;
  btn.disabled = blocked;
}
function applyVesselType(vt) {
  const panel = document.getElementById('panel');
  const powerSection = document.getElementById('powerBoatSection');
  panel.classList.toggle('power', vt === 'power');
  powerSection.style.display = vt === 'power' ? 'block' : 'none';
  document.querySelectorAll('#vesselTypeToggle .vt-btn').forEach(b => {
    const active = b.dataset.val === vt;
    b.classList.toggle('vt-active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  try { localStorage.setItem('vesselType', vt); } catch (_) {}
  refreshFindRouteEnabled();
}
document.querySelectorAll('#vesselTypeToggle .vt-btn').forEach(b => {
  b.addEventListener('click', () => applyVesselType(b.dataset.val));
});
['pb_name', 'pb_cruise'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', () => { savePowerBoat(); refreshFindRouteEnabled(); });
});
loadPowerBoat();
applyVesselType(getVesselType());

// Itinerary name bar: Publish (POST /api/routes/{id}/publish) and
// Delete (DELETE /api/routes/{id}) for the route on the map.
(function() {
  const status = document.getElementById('routeNameStatus');
  const pubBtn = document.getElementById('routePublish');
  const delBtn = document.getElementById('routeDelete');
  const input = document.getElementById('routeNameInput');
  if (pubBtn) {
    pubBtn.addEventListener('click', () => {
      if (!_currentRouteJobId) { status.textContent = '(no route loaded)'; return; }
      status.textContent = '…';
      authFetch(ROUTER + '/routes/' + encodeURIComponent(_currentRouteJobId) + '/publish', { method: 'POST' }, null)
        .then(r => r.ok ? r.json() : _apiErrorText(r).then(t => Promise.reject(new Error(t))))
        .then(d => {
          status.textContent = '✓';
          status.title = 'Published as ' + d.resource_id;
          if (typeof appendLog === 'function') appendLog('Published to Signal K resources: ' + d.href, 'done');
          loadRouteHistory();
          setTimeout(() => { status.textContent = ''; }, 2500);
        })
        .catch(err => { status.textContent = '✗'; status.title = err.message; if (typeof appendLog === 'function') appendLog('Publish failed: ' + err.message, 'error'); });
    });
  }
  if (delBtn) {
    delBtn.addEventListener('click', () => {
      if (!_currentRouteJobId) { status.textContent = '(no route loaded)'; return; }
      _deleteRouteJob(_currentRouteJobId, (input && input.value.trim()) || _currentRouteJobId);
    });
  }
})();
