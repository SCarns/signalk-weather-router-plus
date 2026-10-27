// The panel's size on the screen (2026-10-27): the map comes first on a small
// screen, the panel takes what the user gives it.
//
// Three layouts, told apart by media queries and written on <html> as
// data-panel-mode (index.html styles each):
//   desktop   the panel at the top right, as always; folded to its header
//             (title, status line, tab bar) by the chevron in the title row;
//   phone     a bottom sheet with three heights: peek (the tab bar alone),
//             half, open; dragged by its grip, or tapped: a tab opens it, the
//             active tab tapped again folds it;
//   landscape a phone held sideways: a drawer on the right; folded, a rail of
//             the tab names stays at the edge and opens the drawer at a tab.
// The state (data-panel: peek, half, open) is remembered per layout in this
// browser. The legend and the map fit read the panel's rectangle, so they
// follow (rp-layers.js, rp-plan.js _mapFitPadding); --sheet-top on <html> is
// the sheet's height for CSS. Tab switching itself stays in rp-plan.js: this
// module clicks the real tab buttons.

const STATES = ['peek', 'half', 'open'];
/** A drag shorter than this is a tap on the grip: open or fold. */
const TAP_PX = 8;
/** Phone: the sheet's heights as a share of the screen (peek is the header's own height). */
const HALF = 0.48;
const OPEN = 0.985;

const html = document.documentElement;
const panel = document.getElementById('panel');
const head = document.getElementById('panelHead');
const grip = document.getElementById('panelGrip');
const tabBar = document.getElementById('tabBar');
const toggle = document.getElementById('panelToggle');
const rail = document.getElementById('panelRail');

let mode = null;
let state = null;

/** The layout for this screen: decided by the inline script in index.html (window.rpLayout), before the first paint. */
function currentMode() {
  const l = /** @type {{ mode?: () => string } | undefined} */ (/** @type {any} */ (window).rpLayout);
  return l && typeof l.mode === 'function' ? l.mode() : window.innerWidth <= 768 ? 'phone' : 'desktop';
}
function key(m) {
  return 'rp:panel:' + m;
}
function remembered(m) {
  try {
    const s = localStorage.getItem(key(m));
    return STATES.includes(s) ? s : null;
  } catch (_) {
    return null;
  }
}
function remember(m, s) {
  try {
    localStorage.setItem(key(m), s);
  } catch (_) {}
}
/** A first visit: the phone sheet half open (the Route form in view), the others open. */
function defaultState(m) {
  return m === 'phone' ? 'half' : 'open';
}
/** 'half' exists on the phone sheet only. */
function valid(m, s) {
  return m === 'phone' ? s : s === 'half' ? 'open' : s;
}

function setState(s, keep = true) {
  state = valid(mode, s);
  html.dataset.panel = state;
  if (panel) panel.style.removeProperty('height');
  if (keep) remember(mode, state);
  updateToggle();
  updateVars();
  window.dispatchEvent(new CustomEvent('rp:panel', { detail: { mode, state } }));
}

function updateToggle() {
  if (!toggle) return;
  const folded = state === 'peek';
  const label = folded ? 'Open the panel' : 'Collapse the panel';
  toggle.textContent = mode === 'landscape' ? (folded ? '‹' : '›') : folded ? '⌃' : '⌄';
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
  toggle.setAttribute('aria-expanded', String(!folded));
}

/** --sheet-top: the sheet's height on a phone (the legend sits just above it); 0 elsewhere. */
function updateVars() {
  if (!panel) return;
  let top = 0;
  if (mode === 'phone') {
    const r = panel.getBoundingClientRect();
    top = Math.max(0, Math.round(window.innerHeight - r.top));
  }
  html.style.setProperty('--sheet-top', top + 'px');
}

function applyMode() {
  const m = currentMode();
  if (m === mode) {
    updateVars();
    return;
  }
  mode = m;
  html.dataset.panelMode = m;
  setState(remembered(m) || defaultState(m), false);
  // The other modules (the legend, the credits, the conditions card) follow the layout through this event.
  window.dispatchEvent(new CustomEvent('rp:layout', { detail: { mode: m } }));
}

// ---- Tabs: a tab tapped opens a folded panel; on a phone or sideways the active tab tapped again folds it. ----
if (tabBar) {
  tabBar.addEventListener(
    'click',
    e => {
      const b = e.target instanceof window.Element ? e.target.closest('button[data-tab]') : null;
      if (!b) return;
      const wasActive = b.classList.contains('active');
      if (state === 'peek') setState(mode === 'phone' ? 'half' : 'open');
      else if (wasActive && mode !== 'desktop') setState('peek');
    },
    true
  );
}
if (toggle) toggle.addEventListener('click', () => setState(state === 'peek' ? 'open' : 'peek'));

// ---- The rail (landscape, folded): the tab names along the right edge; one tapped opens the drawer at that tab. ----
if (rail && tabBar) {
  for (const b of /** @type {NodeListOf<HTMLButtonElement>} */ (tabBar.querySelectorAll('button[data-tab]'))) {
    const r = document.createElement('button');
    r.type = 'button';
    r.dataset.tab = b.dataset.tab;
    r.textContent = b.textContent;
    r.setAttribute('role', 'tab');
    r.addEventListener('click', () => {
      // The real tab button: rp-plan.js shows the tab, the capture listener above opens the drawer.
      const real = /** @type {HTMLButtonElement | null} */ (tabBar.querySelector('button[data-tab="' + r.dataset.tab + '"]'));
      if (real) real.click();
      if (state === 'peek') setState('open');
    });
    rail.appendChild(r);
  }
  const syncRail = () => {
    for (const r of /** @type {NodeListOf<HTMLButtonElement>} */ (rail.querySelectorAll('button'))) {
      const real = tabBar.querySelector('button[data-tab="' + r.dataset.tab + '"]');
      const on = !!real && real.classList.contains('active');
      r.classList.toggle('active', on);
      r.setAttribute('aria-selected', String(on));
    }
  };
  window.addEventListener('rp:tab', syncRail);
  syncRail();
}

// ---- Phone: drag the sheet by its grip or header; a short drag is a tap. ----
if (panel && grip && head) {
  let drag = null;
  const peekHeight = () => {
    // The header's own height: what the sheet is when folded.
    const g = grip.getBoundingClientRect().height;
    const h = head.getBoundingClientRect().height;
    const cs = window.getComputedStyle(panel);
    return g + h + parseFloat(cs.paddingBottom || '0');
  };
  const start = e => {
    if (mode !== 'phone' || e.button !== 0) return;
    if (e.target instanceof window.Element && e.target.closest('button, a, input, select, textarea, label')) return;
    drag = { y: e.clientY, h: panel.getBoundingClientRect().height, moved: false, id: e.pointerId };
    panel.classList.add('dragging');
    try {
      panel.setPointerCapture(e.pointerId);
    } catch (_) {}
  };
  const move = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = drag.y - e.clientY;
    if (Math.abs(dy) > TAP_PX) drag.moved = true;
    if (!drag.moved) return;
    const vh = window.innerHeight;
    const h = Math.min(vh * OPEN, Math.max(peekHeight(), drag.h + dy));
    panel.style.height = h + 'px';
    updateVars();
    e.preventDefault();
  };
  const end = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    panel.classList.remove('dragging');
    try {
      panel.releasePointerCapture(e.pointerId);
    } catch (_) {}
    if (!d.moved) {
      // A tap on the grip or the header: fold, or open to half.
      if (e.target instanceof window.Element && e.target.closest('button, a, input, select, textarea, label')) return;
      setState(state === 'peek' ? 'half' : 'peek');
      return;
    }
    const vh = window.innerHeight;
    const h = panel.getBoundingClientRect().height;
    const dir = e.clientY < d.y ? 1 : -1; // 1: dragged up
    /** @type {[string, number][]} */
    const stops = [
      ['peek', peekHeight()],
      ['half', vh * HALF],
      ['open', vh * OPEN],
    ];
    // The nearest stop, leaning the way the drag went.
    let best = stops[0];
    let bestD = Infinity;
    for (const s of stops) {
      const dd = Math.abs(s[1] - h) - (Math.sign(s[1] - h) === dir ? vh * 0.08 : 0);
      if (dd < bestD) {
        bestD = dd;
        best = s;
      }
    }
    setState(best[0]);
  };
  for (const el of [grip, head]) el.addEventListener('pointerdown', start);
  panel.addEventListener('pointermove', move);
  panel.addEventListener('pointerup', end);
  panel.addEventListener('pointercancel', end);
}

// ---- Something else needs the map (the conditions card, rp-plan.js): a small screen's panel folds. ----
window.addEventListener('rp:panel-fold', () => {
  // Not remembered: the user did not fold it (PR #4 review).
  if (mode !== 'desktop' && state !== 'peek') setState('peek', false);
});

// ---- Layout changes: a rotation, a resize, the header growing (its status text). ----
window.addEventListener('resize', applyMode);
window.addEventListener('orientationchange', applyMode);
if (window.screen && window.screen.orientation) window.screen.orientation.addEventListener('change', applyMode);
if (panel && typeof ResizeObserver === 'function') new ResizeObserver(() => updateVars()).observe(panel);
applyMode();
