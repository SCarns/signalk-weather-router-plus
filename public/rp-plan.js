// Weather Router Plus — route planner UI, part 3 of 3 (planning).
// Map gestures, tabs, legends, progress, result strip, itinerary, the
// route job ladder (POST /api/routes → SSE → result), waypoint popups,
// the conditions popup and Live mode with the Signal K vessel.

// A long press that just placed something is followed by a click
// event on release; swallow that one so the menu does not open on top.
let _suppressClickUntil = 0;

// --- Long-press to pin a route waypoint as an intermediate "via" ---
// Long-pressing any point along a computed route promotes it to the
// waypointCoords list. It then becomes draggable via the existing
// Modify interaction, and gets included in the next POST /api/routes
// request so the re-run passes through it.
(function() {
  const LONG_PRESS_MS = 500;     // how long the user must hold
  const CANCEL_PX = 10;          // pointer movement beyond this cancels
  let pressTimer = null;
  let pressStartPx = null;
  let pressedFeature = null;

  let longPressFired = false;
  function cancelPress() {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    pressStartPx = null;
    pressedFeature = null;
    // Release after a fired long press: swallow the click OL emits for
    // it, however long the finger stayed down.
    if (longPressFired) { longPressFired = false; _suppressClickUntil = Date.now() + 700; }
  }

  function pinRouteWaypoint(feature) {
    // Only pin features that came from the route layer as Point waypoints.
    const geom = feature.getGeometry();
    if (!geom || geom.getType() !== 'Point') return false;
    if (feature.get('name') === 'start'
        || feature.get('name') === 'end'
        || feature.get('name') === 'waypoint') {
      return false;  // already a draggable marker — nothing to do
    }
    const lonlat = ol.proj.toLonLat(geom.getCoordinates());
    waypointCoords.push([lonlat[0], lonlat[1]]);
    _rebuildWaypointFeatures();
    // Brief visual confirmation via the status line.
    const el = document.getElementById('status');
    if (el) {
      const prev = el.textContent;
      el.textContent = `Pinned via waypoint W${waypointCoords.length} — drag it to adjust, then re-run route`;
      setTimeout(() => { if (el.textContent.startsWith('Pinned via')) el.textContent = prev; }, 2500);
    }
    return true;
  }

  map.getViewport().addEventListener('pointerdown', function(e) {
    // Only primary button; ignore multi-touch pinches.
    if (e.button !== undefined && e.button !== 0) return;
    if (e.isPrimary === false) return;
    const rect = map.getViewport().getBoundingClientRect();
    const px = [e.clientX - rect.left, e.clientY - rect.top];
    pressStartPx = px;
    // What is under the pointer decides what a long press does: a
    // route point gets pinned as a via; a marker is left to the drag
    // interaction; open water gets the direct placement action. Any
    // movement beyond CANCEL_PX cancels (that is a pan).
    let hit = null;
    map.forEachFeatureAtPixel(px, function(f, layer) {
      if (layer === routeLayer && !hit) hit = f;
    }, { hitTolerance: 6 });
    const onMarker = map.hasFeatureAtPixel(px, { layerFilter: l => l === markerLayer, hitTolerance: 8 });
    if (!hit && onMarker) return;
    if (e.shiftKey) return;
    pressedFeature = hit;
    const pressCoord = map.getCoordinateFromPixel(px);
    pressTimer = setTimeout(function() {
      pressTimer = null;
      if (pressedFeature) pinRouteWaypoint(pressedFeature);
      else if (pressCoord) { hideMapMenu(); _placeOrAdd(ol.proj.toLonLat(pressCoord), pressCoord); }
      pressedFeature = null;
      longPressFired = true;
      _suppressClickUntil = Date.now() + 700;
    }, LONG_PRESS_MS);
  });

  map.getViewport().addEventListener('pointermove', function(e) {
    if (!pressStartPx || !pressTimer) return;
    const rect = map.getViewport().getBoundingClientRect();
    const dx = (e.clientX - rect.left) - pressStartPx[0];
    const dy = (e.clientY - rect.top) - pressStartPx[1];
    if (dx * dx + dy * dy > CANCEL_PX * CANCEL_PX) cancelPress();
  });
  map.getViewport().addEventListener('pointerup', cancelPress);
  map.getViewport().addEventListener('pointercancel', cancelPress);
  map.getViewport().addEventListener('pointerleave', cancelPress);
})();

// --- Click to place markers ---
let routeActive = false;

function _rebuildWaypointFeatures() {
  // Drop old waypoint features and add fresh ones so indexes stay aligned.
  for (const f of waypointFeatures) {
    markerSource.removeFeature(f);
  }
  waypointFeatures = waypointCoords.map((coord, idx) => {
    const f = new ol.Feature({
      name: 'waypoint',
      waypoint_index: idx,
      geometry: new ol.geom.Point(ol.proj.fromLonLat(coord)),
    });
    markerSource.addFeature(f);
    return f;
  });
  _updateWaypointListUI();
}

function _updateWaypointListUI() {
  const el = document.getElementById('waypointList');
  if (!el) return;
  if (waypointCoords.length === 0) {
    el.innerHTML = '<span style="color:#888">No intermediate waypoints</span>';
    return;
  }
  el.innerHTML = waypointCoords.map((c, i) =>
    `<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;">` +
    `<span>W${i + 1}: ${c[1].toFixed(4)}, ${c[0].toFixed(4)}</span>` +
    `<button data-idx="${i}" class="wpDel" style="background:#d32f2f;color:#fff;border:none;border-radius:3px;padding:2px 6px;cursor:pointer;font-size:11px;">×</button>` +
    `</div>`
  ).join('');
  el.querySelectorAll('.wpDel').forEach(btn => {
    btn.addEventListener('click', function() {
      const idx = parseInt(this.dataset.idx, 10);
      waypointCoords.splice(idx, 1);
      _rebuildWaypointFeatures();
      markRouteStale();
    });
  });
}

// Insert position for a new via: the segment of the current chain
// (start → vias → end) the click is nearest to, so the route order
// stays sensible wherever the user clicks.
function _viaInsertIndex(lonlat) {
  const chain = [startCoord, ...waypointCoords, endCoord];
  const k = Math.cos(lonlat[1] * Math.PI / 180);
  const P = [lonlat[0] * k, lonlat[1]];
  let best = 0, bestD = Infinity;
  for (let i = 0; i < chain.length - 1; i++) {
    const A = [chain[i][0] * k, chain[i][1]], B = [chain[i + 1][0] * k, chain[i + 1][1]];
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / l2)) : 0;
    const qx = A[0] + t * dx - P[0], qy = A[1] + t * dy - P[1];
    const d = qx * qx + qy * qy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// Map gestures on open water:
//   click       → small menu: set/move start, set/move destination,
//                 add waypoint, conditions here
//   long press  → the direct action (start, then destination, then a
//                 waypoint), no menu
//   shift-click → conditions popup straight away
// Adding a waypoint extends the course: the clicked point becomes the
// destination and the old destination becomes the last waypoint, so
// waypoints stay in the order they were placed.
function _placeOrAdd(coords, coordinate) {
  if (!startCoord) {
    startCoord = coords;
    startFeature.setGeometry(new ol.geom.Point(coordinate));
    updateCoordDisplay('start', coords);
  } else if (!endCoord) {
    endCoord = coords;
    endFeature.setGeometry(new ol.geom.Point(coordinate));
    updateCoordDisplay('end', coords);
  } else {
    // Extend the course: the current destination becomes the last
    // waypoint and the new point is the destination.
    waypointCoords.push(endCoord);
    endCoord = coords;
    endFeature.setGeometry(new ol.geom.Point(coordinate));
    updateCoordDisplay('end', coords);
    _rebuildWaypointFeatures();
    markRouteStale();
  }
  updateButton();
}
function _setStart(coords, coordinate) {
  startCoord = coords; startFeature.setGeometry(new ol.geom.Point(coordinate));
  updateCoordDisplay('start', coords); markRouteStale(); updateButton();
}
function _setEnd(coords, coordinate) {
  endCoord = coords; endFeature.setGeometry(new ol.geom.Point(coordinate));
  updateCoordDisplay('end', coords); markRouteStale(); updateButton();
}

// Click menu — an overlay anchored at the clicked point.
const mapMenu = new ol.Overlay({
  element: (() => {
    const el = document.createElement('div');
    el.className = 'map-menu';
    document.body.appendChild(el);
    return el;
  })(),
  positioning: 'top-left', offset: [8, 8], stopEvent: true,
});
map.addOverlay(mapMenu);
function hideMapMenu() { mapMenu.setPosition(undefined); }
function _showMapMenu(coordinate, pixel) {
  const coords = ol.proj.toLonLat(coordinate);
  const items = [];
  items.push([startCoord ? 'Move start here' : 'Set start here', () => _setStart(coords, coordinate)]);
  if (startCoord) items.push([endCoord ? 'Move destination here' : 'Set destination here', () => _setEnd(coords, coordinate)]);
  if (startCoord && endCoord) items.push(['Add waypoint here', () => _placeOrAdd(coords, coordinate)]);
  items.push(['Conditions here', () => openConditionsAt(coordinate, pixel)]);
  const el = mapMenu.getElement();
  el.innerHTML = '<div class="map-menu-pos">' + coords[1].toFixed(4) + ', ' + coords[0].toFixed(4) + '</div>'
    + items.map((it, i) => '<button type="button" data-i="' + i + '">' + it[0] + '</button>').join('')
    + '<button type="button" class="map-menu-cancel" data-i="-1">Cancel</button>';
  el.querySelectorAll('button').forEach(b => {
    b.onclick = ev => { ev.stopPropagation(); hideMapMenu(); const i = parseInt(b.dataset.i, 10); if (i >= 0) items[i][1](); };
  });
  mapMenu.setPosition(coordinate);
}
map.on('movestart', hideMapMenu);
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideMapMenu(); });
// The browser's own context menu on the map would fight the long press
// on touch devices.
map.getViewport().addEventListener('contextmenu', e => e.preventDefault());

map.on('singleclick', function(e) {
  if (e.originalEvent.shiftKey) return;  // shift-click = conditions popup
  if (Date.now() < _suppressClickUntil) return;
  const onThing = map.hasFeatureAtPixel(e.pixel, {
    layerFilter: l => l === markerLayer || l === routeLayer, hitTolerance: 8 });
  if (onThing) { hideMapMenu(); return; }
  _showMapMenu(e.coordinate, e.pixel);
});

// The one line under the buttons that says what to do next.
function updatePlanHint() {
  const el = document.getElementById('planHint');
  if (!el) return;
  let msg;
  if (!startCoord) msg = 'Click the map for options, or hold to place your start.';
  else if (!endCoord) msg = 'Click the map for options, or hold to place your destination.';
  else if (routeActive && _routeStale) msg = 'Markers changed — press Find Route to recompute.';
  else if (routeActive) msg = 'Click the route for leg details. Click open water for options, or hold to add a waypoint (it becomes the destination); drag markers to move them.';
  else msg = 'Click open water for options, or hold to add a waypoint (it becomes the destination; the old one becomes a waypoint). Drag markers to adjust, then press Find Route.';
  el.textContent = msg;
}

// A computed route is on the map but the markers no longer match it.
// `_routeComputing` is true while a Find Route request is in flight
// so marker changes during the first computation (routeActive still
// false) still flag the result as stale when it lands.
let _routeStale = false;
let _routeComputing = false;
function markRouteStale() {
  if ((!routeActive && !_routeComputing) || _routeStale) { updatePlanHint(); return; }
  _routeStale = true;
  if (_lastRouteProps) renderResultStrip(_lastRouteProps, _lastNavWarns);
  updatePlanHint();
}
updatePlanHint();   // initial "place your start" line

function updateCoordDisplay(which, coords) {
  const el = document.getElementById(which + 'Coord');
  el.textContent = coords[1].toFixed(5) + ', ' + coords[0].toFixed(5);
}

function updateButton() {
  // Endpoint readiness is the baseline; power mode adds hull-def checks.
  if (typeof refreshFindRouteEnabled === 'function') {
    refreshFindRouteEnabled();
  } else {
    document.getElementById('findRoute').disabled = !(startCoord && endCoord);
  }
  updatePlanHint();
}

// --- Reset ---
document.getElementById('resetBtn').addEventListener('click', function() {
  if (routeActive && !confirm('Clear the route and all markers?')) return;
  startCoord = null;
  endCoord = null;
  waypointCoords = [];
  routeActive = false;
  _routeStale = false;
  startFeature.setGeometry(null);
  endFeature.setGeometry(null);
  _rebuildWaypointFeatures();
  routeSource.clear();
  skeletonSource.clear();
  document.getElementById('startCoord').textContent = 'Click map or drag marker';
  document.getElementById('endCoord').textContent = 'Click map or drag marker';
  document.getElementById('status').textContent = '';
  document.getElementById('routeInfo').innerHTML = '';
  document.getElementById('modalLog').innerHTML = '';
  document.getElementById('modalStatus').textContent = 'Waiting...';
  document.getElementById('modalItinerary').innerHTML = '';
  document.getElementById('routeNameInput').value = '';
  document.getElementById('routeNameStatus').textContent = '';
  _currentRouteJobId = null;
  _currentRouteName = '';
  _lastRouteProps = null;
  if (_currentTimeOverride) { _currentTimeOverride = null; _reloadTimedOverlays(); }
  updateButton();
});

// --- Clear single endpoints ---
document.getElementById('clearStart').addEventListener('click', function() {
  startCoord = null;
  startFeature.setGeometry(null);
  document.getElementById('startCoord').textContent = 'Click map or drag marker';
  markRouteStale();
  updateButton();
});
document.getElementById('clearEnd').addEventListener('click', function() {
  endCoord = null;
  endFeature.setGeometry(null);
  document.getElementById('endCoord').textContent = 'Click map or drag marker';
  markRouteStale();
  updateButton();
});

// --- Tabs ---
// All panes share #tabBody, the route inputs and result strip included
// (Route tab); only the title, status line and tab bar stay on top.
const modalLog = document.getElementById('modalLog');
const modalItinerary = document.getElementById('modalItinerary');
const modalStatus = document.getElementById('modalStatus');
const logSection = document.getElementById('logSection');
const itinerarySection = document.getElementById('itinerarySection');
const cancelBtn = document.getElementById('cancelRoute');
const TAB_IDS = ['routeSection', 'settingsSection', 'layersSection', 'savedSection', 'logSection', 'itinerarySection', 'srvSettingsSection'];
function showTab(id) {
  if (!TAB_IDS.includes(id)) return;
  for (const t of TAB_IDS) {
    const pane = document.getElementById(t);
    if (pane) pane.classList.toggle('active', t === id);
  }
  document.querySelectorAll('#tabBar button').forEach(b => {
    const on = b.dataset.tab === id;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  try { localStorage.setItem('rp:tab', id); } catch (_) {}
  if (id === 'settingsSection' && typeof drawPolarDiagram === 'function') drawPolarDiagram();
  window.dispatchEvent(new CustomEvent('rp:tab', { detail: id }));
}
document.querySelectorAll('#tabBar button').forEach(b => {
  b.addEventListener('click', () => showTab(b.dataset.tab));
});
(function () {
  let saved = null;
  try { saved = localStorage.getItem('rp:tab'); } catch (_) {}
  showTab(TAB_IDS.includes(saved) ? saved : 'routeSection');
})();

// ─────────── Legends ───────────
// One row per active water/weather overlay, drawn from the same
// colour stops the heatmaps use (`GET /api/legends`, SI values) plus the
// barb/arrow class tables. Values shown in display units.
let _LEGENDS = null, _legendsReq = null;
function _loadLegends() {
  if (_LEGENDS || _legendsReq) return;
  _legendsReq = authFetch(ROUTER + '/legends', {}, null)
    .then(r => r.ok ? r.json() : null)
    .then(d => { if (d) { _LEGENDS = d; updateLegends(); } })
    .catch(() => {})
    .finally(() => { _legendsReq = null; });
}
_loadLegends();

function _legendUnit(quantity) {
  if (quantity === 'speed') { const d = unitDesc('speed'); d.p = 0; return d; }
  if (quantity === 'wave_height') { const d = unitDesc('wave_height'); d.p = Math.min(d.p, 1); return d; }
  if (quantity === 'temperature') { const d = unitDesc('temperature'); d.p = 0; return d; }
  // Precip stops are a water-depth rate in m/s, as is the precip unit.
  if (quantity === 'precip_depth_rate') return unitDesc('precip');
  // Sea-level heights (tide) follow the user's depth unit.
  if (quantity === 'sea_level') { const d = unitDesc('depth'); d.p = Math.min(d.p, 1); return d; }
  return { fn: v => v, u: '', p: 0 };
}
function _legendVal(v, u) {
  if (u.missing) return UNIT_MISSING;
  const x = u.fn(v);
  const s = x.toFixed(u.p);
  return s === '-0' ? '0' : s;
}
function _gradientRow(L) {
  const u = _legendUnit(L.quantity);
  const v0 = L.stops[0][0], v1 = L.stops[L.stops.length - 1][0], span = (v1 - v0) || 1;
  const pct = v => ((v - v0) / span * 100).toFixed(1);
  const grad = 'linear-gradient(to right, ' + L.stops.map(([v, c]) => c + ' ' + pct(v) + '%').join(', ') + ')';
  // At most ~6 tick labels: first, last, and evenly chosen stops between.
  const n = L.stops.length, every = Math.max(1, Math.ceil((n - 2) / 4));
  const ticks = L.stops.map(([v], i) => ({ v, i })).filter(t => t.i === 0 || t.i === n - 1 || ((t.i % every) === 0));
  const tickHtml = ticks.map(t => '<span class="' + (t.i === 0 ? 'first' : t.i === n - 1 ? 'last' : '') + '" style="left:' + pct(t.v) + '%;">' + _legendVal(t.v, u) + (t.i === n - 1 ? '+' : '') + '</span>').join('');
  return '<div class="lg-row"><div class="lg-title">' + L.title + ' <span>(' + u.u + ')</span></div>'
    + '<div class="lg-bar" style="background:' + grad + ';"></div><div class="lg-ticks">' + tickHtml + '</div></div>';
}
function _bandsRow(L) {
  const cells = L.bands.map(([lo, name], i) => {
    const hi = i + 1 < L.bands.length ? L.bands[i + 1][0] : L.stops[L.stops.length - 1][0];
    const mid = (lo + hi) / 2;
    let best = L.stops[0][1], bd = Infinity;
    for (const [v, c] of L.stops) { const d = Math.abs(v - mid); if (d < bd) { bd = d; best = c; } }
    return '<div><i style="background:' + best + ';"></i>' + name + '</div>';
  }).join('');
  return '<div class="lg-row"><div class="lg-title">' + L.title + '</div><div class="lg-classes">' + cells + '</div></div>';
}
// Class bounds are in knots (the symbols are knot-based); shown in the
// preset's speed unit.
function _classesRow(title, classes, glyph) {
  const u = unitDesc('speed'); u.p = 1;
  const cv = kt => { if (u.missing) return UNIT_MISSING; const t = u.fn(kt * 0.5144444444).toFixed(u.p); return t.replace(/\.0$/, ''); };
  const cells = classes.map(([lo, color], i) => {
    const hi = i + 1 < classes.length ? classes[i + 1][0] : null;
    const label = hi == null ? '≥' + cv(lo) : (i === 0 ? '&lt;' + cv(hi) : cv(lo) + '–' + cv(hi));
    const g = glyph ? '<span class="lg-glyph">' + glyph(lo, color) + '</span>' : '';
    return '<div>' + g + '<i style="background:' + color + ';"></i>' + label + '</div>';
  }).join('');
  return '<div class="lg-row"><div class="lg-title">' + title + ' <span>(' + u.u + ')</span></div><div class="lg-classes">' + cells + '</div></div>';
}
function _on(id) { const el = document.getElementById(id); return !!(el && el.checked); }
function _noteRow(id) {
  const m = _overlayNotes[id];
  return m ? '<div class="lg-note" style="color:var(--danger);">unavailable: ' + m + '</div>' : '';
}
function updateLegends() {
  const box = document.getElementById('legendBox');
  if (!box) return;
  if (_LEGENDS == null) _loadLegends();
  const rows = [];
  const G = _LEGENDS || {};
  // Barb glyph per class: the class's lower bound drawn as the map draws
  // it (calm circle, half feather, full feathers) in the class colour.
  if (_on('windToggle')) rows.push(_classesRow('Wind barbs', WIND_BARB_CLASSES, (lo, c) => _windBarbSvg(lo, c)) + _noteRow('windToggle'));
  if (_on('windCombinedToggle') && G.wind) rows.push(_gradientRow(G.wind) + _noteRow('windCombinedToggle'));
  if (_on('currentToggle')) rows.push(_classesRow('Tidal current', CURRENT_ARROW_CLASSES) + _noteRow('currentToggle'));
  if (_on('currentHeatmapToggle') && G.current) rows.push(_gradientRow(G.current) + '<div class="lg-note"><span style="display:inline-block;width:14px;height:9px;vertical-align:middle;margin-right:4px;border:1px solid #bbb;background:repeating-linear-gradient(135deg,rgba(96,96,96,.6) 0 1px,transparent 1px 5px);"></span>no model data: water narrower than the model grid (~9 km)</div>' + _noteRow('currentHeatmapToggle'));
  if (_on('wavesCombinedToggle') && G.waves) rows.push(_gradientRow(G.waves) + _noteRow('wavesCombinedToggle'));
  if (_on('roughnessToggle') && G.sea_state) rows.push(_bandsRow(G.sea_state) + _noteRow('roughnessToggle'));
  if (_on('precipToggle') && G.precip) rows.push(_gradientRow(G.precip) + _noteRow('precipToggle'));
  if (_on('temperatureToggle') && G.temperature) rows.push(_gradientRow(G.temperature) + _noteRow('temperatureToggle'));
  if (_on('sstToggle') && G.sst) rows.push(_gradientRow(G.sst) + _noteRow('sstToggle'));
  if (_on('tideToggle') && G.tide) {
    // The map stretches the tide scale to the tiles loaded (rp-layers _noteTileScale); show the stops actually drawn.
    const scaled = (typeof _autoScaleStops !== 'undefined' && _autoScaleStops.tide) ? Object.assign({}, G.tide, { stops: _autoScaleStops.tide }) : G.tide;
    rows.push(_gradientRow(scaled) + '<div class="lg-note">scaled to the largest tide in the tiles loaded · relative to mean sea level, not chart datum · Copernicus Marine</div>' + '<div class="lg-note"><span style="display:inline-block;width:14px;height:9px;vertical-align:middle;margin-right:4px;border:1px solid #bbb;background:repeating-linear-gradient(135deg,rgba(96,96,96,.6) 0 1px,transparent 1px 5px);"></span>no model data: water narrower than the model grid (~9 km)</div>' + _noteRow('tideToggle'));
  }
  if (_on('pressureToggle')) rows.push('<div class="lg-row"><div class="lg-title">Pressure <span>(' + unitDesc('pressure').u + ')</span></div><div class="lg-note">isobars every ' + fmtPressure(400) + ' · bold every ' + fmtPressure(2000) + ' · <b style="color:#1565C0">H</b> / <b style="color:#C62828">L</b> centres</div>' + _noteRow('pressureToggle') + '</div>');
  box.innerHTML = rows.join('');
}
// Any layer toggle change (user click, or the saved-state restore that
// dispatches bubbling change events) refreshes the box.
const _layersSec = document.getElementById('layersSection');
if (_layersSec) _layersSec.addEventListener('change', updateLegends);
window.addEventListener('load', updateLegends);

// Layers sub-tabs: one group of toggles visible at a time.
(function () {
  const row = document.getElementById('layersSubTabs');
  if (!row) return;
  const groups = Array.from(document.querySelectorAll('#layersSection .layer-group'));
  function show(id) {
    groups.forEach(g => g.classList.toggle('active', g.dataset.group === id));
    row.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.group === id));
    try { localStorage.setItem('rp:layersTab', id); } catch (_) {}
  }
  row.querySelectorAll('button').forEach(b => b.addEventListener('click', () => show(b.dataset.group)));
  let saved = null;
  try { saved = localStorage.getItem('rp:layersTab'); } catch (_) {}
  show(groups.some(g => g.dataset.group === saved) ? saved : 'base');
})();

// --- Phase progress ---
// Drives the five-cell bar in #routeProgress from the plugin's SSE
// `progress` events ({stage, total, message}): stage 0 covers setup and
// the coarse A* skeleton, stages 1..K the isochrone sweep, stage K the
// validation and summary. The raw log still fills #modalLog behind the
// toggle on the Log tab.
const RouteProgress = (function () {
  const PHASES = ['Setup', 'Skeleton', 'Sweep', 'Validate', 'Done'];
  const box = document.getElementById('routeProgress');
  const bar = document.getElementById('rpBar');
  const label = document.getElementById('rpLabel');
  let st = null, timer = null;
  function render() {
    if (!st) return;
    bar.innerHTML = PHASES.map((_, i) => {
      let cls = 'rp-cell';
      if (st.failed && i === Math.max(st.phase, 0)) cls += ' failed';
      else if (st.finished || i < st.phase) cls += ' done';
      else if (i === st.phase) cls += ' current';
      return '<div class="' + cls + '"></div>';
    }).join('');
    const phaseTxt = st.failed ? (st.failMsg || 'Failed')
                   : st.finished ? 'Done'
                   : st.phase < 0 ? (st.queued || 'Starting…') : PHASES[st.phase];
    label.className = 'rp-label' + (st.failed ? ' failed' : st.finished ? ' done' : '');
    label.querySelector('.rp-phase').textContent = phaseTxt;
    label.querySelector('.rp-sub').textContent = st.sub || '';
    label.querySelector('.rp-elapsed').textContent = ((Date.now() - st.t0) / 1000).toFixed(0) + 's';
  }
  function tick() { if (st && !st.finished && !st.failed) render(); }
  return {
    start() {
      st = { t0: Date.now(), phase: -1, sub: '', queued: '', finished: false, failed: false, failMsg: '' };
      box.style.display = '';
      if (timer) clearInterval(timer);
      timer = setInterval(tick, 1000);
      render();
    },
    status(s) {
      if (!st || st.finished || st.failed) return;
      if (s && s.status === 'queued') st.queued = 'Queued' + (s.position > 1 ? ' (#' + s.position + ')' : '');
      else if (s && s.status === 'running') { st.queued = ''; st.phase = Math.max(st.phase, 0); }
      render();
    },
    feed(p) {
      if (!st || st.finished || st.failed || !p) return;
      const t = String(p.message || '').trim();
      const stage = Number(p.stage) || 0, total = Number(p.total) || 0;
      let m;
      if (total > 0 && stage >= total) {
        st.phase = Math.max(st.phase, 3);
        if (/^WARNING/.test(t)) st.sub = ((m = /(\d+) leg/.exec(t)) ? m[1] + ' leg(s) cross land' : 'warnings');
        else if (/^done:/.test(t)) st.sub = t.replace(/^done:\s*/, '');
        else st.sub = 'validating';
      } else if (total > 0 && stage >= 1) {
        st.phase = Math.max(st.phase, 2);
        st.sub = 'stage ' + stage + '/' + total + ((m = /(\d+) retained/.exec(t)) ? ' · ' + m[1] + ' retained' : '')
          + ((m = /best remaining ([\d.]+ km)/.exec(t)) ? ' · ' + m[1] + ' to go' : '');
      } else if (total > 0 && /^K=/.test(t)) {
        st.phase = Math.max(st.phase, 2); st.sub = 'stage 0/' + total;
      } else if (/^skeleton/.test(t)) {
        st.phase = Math.max(st.phase, 1); st.sub = (m = /A\* ([\d.]+ s)/.exec(t)) ? 'A* ' + m[1] : (/failed|unavailable/.test(t) ? 'no skeleton' : '');
      } else {
        st.phase = Math.max(st.phase, 0); st.sub = t.length > 48 ? t.slice(0, 46) + '…' : t;
      }
      render();
    },
    done(elapsedS) { if (!st) return; st.finished = true; st.phase = 4; st.sub = 'in ' + elapsedS + 's'; if (timer) clearInterval(timer); render(); },
    fail(msg) { if (!st) return; st.failed = true; st.failMsg = msg || 'Failed'; st.sub = ''; if (timer) clearInterval(timer); render(); },
    hide() { box.style.display = 'none'; },
  };
})();

// --- Result strip ---
// One line of what the route is, from the LineString properties, plus
// a badge that opens the validator's warnings.
let _lastRouteProps = null, _lastNavWarns = null;
function renderResultStrip(p, navWarns) {
  const el = document.getElementById('routeInfo');
  _lastRouteProps = p; _lastNavWarns = navWarns;
  el.classList.toggle('stale', !!(p && _routeStale));
  if (!p) { el.innerHTML = ''; return; }
  const distStr = p.total_distance_m != null ? fmtDist(p.total_distance_m) : '?';
  const timeStr = p.total_time_s != null ? fmtTime(p.total_time_s) : '?';
  const arrStr = p.arrival ? new Date(p.arrival).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : null;
  const sailStr = fmtTime(p.sailing_time_s || 0), motorStr = fmtTime(p.motoring_time_s || 0);
  const warns = Array.isArray(p.warnings) ? p.warnings : [];
  const land = p.land_crossings || 0;
  let badge;
  if (land > 0) badge = '<button type="button" class="rs-badge danger" id="rsBadge">' + land + ' land crossing' + (land > 1 ? 's' : '') + '</button>';
  else if (warns.length) badge = '<button type="button" class="rs-badge warn" id="rsBadge">' + warns.length + ' warning' + (warns.length > 1 ? 's' : '') + '</button>';
  else if (p.validated === false) badge = '<span class="rs-badge muted">not validated</span>';
  else badge = '<span class="rs-badge ok">validated</span>';
  const repaired = p.repairs_applied > 0 ? '<span style="color:var(--text-2);">' + p.repairs_applied + ' repaired</span>' : '';
  let html = '<div class="rs-main"><b>' + distStr + '</b><span>' + timeStr + '</span>'
    + (arrStr ? '<span>arrives ' + arrStr + '</span>' : '')
    + '<span>sail ' + sailStr + ' · motor ' + motorStr + '</span>'
    + (p.waypoint_count != null ? '<span>' + p.waypoint_count + ' wps</span>' : '')
    + (p.max_swh_m != null ? '<span>waves max ' + fmtSwh(p.max_swh_m) + '</span>' : '')
    + badge + repaired + '</div>';
  if (navWarns && navWarns.length) html += '<div class="rs-notes">' + navWarns.join(' · ') + '</div>';
  if (_routeStale) html += '<div class="rs-stale">Markers changed since this route was computed.</div>';
  if (warns.length) {
    html += '<div class="rs-warnlist" id="rsWarnList" hidden>' + warns.map(w => {
      if (typeof w !== 'object' || w === null) return '<div>' + String(w) + '</div>';
      const kind = String(w.violation || 'warning').replace(/_/g, ' ');
      const where = Array.isArray(w.to) ? ' at ' + w.to[1].toFixed(4) + ', ' + w.to[0].toFixed(4) : '';
      // The plugin names the leg `leg_index`; the routing server named it `leg`.
      const li = w.leg_index != null ? w.leg_index : w.leg;
      const leg = li != null ? ' (leg ' + (li + 1) + ')' : '';
      const fixed = w.repaired ? ' · repaired' : '';
      return '<div class="' + (w.violation === 'leg_crosses_land' ? 'land' : '') + '">' + kind + leg + where + fixed + '</div>';
    }).join('') + '</div>';
  }
  el.innerHTML = html;
  const b = el.querySelector('#rsBadge'), list = el.querySelector('#rsWarnList');
  if (b && list) b.onclick = () => { list.hidden = !list.hidden; };
}

// Stub kept for backward-compat with any existing caller.
function switchModalTab(tab) {
  if (tab === 'log') showTab('logSection');
  else if (tab === 'itinerary') showTab('itinerarySection');
}

// Called when route computation starts: clear the stale log and
// itinerary, start the phase progress, show Cancel. The user's tab is
// left alone — progress is visible in the pinned head regardless.
function showModal() {
  modalLog.innerHTML = '';
  modalItinerary.innerHTML = '';
  modalItinerary.style.display = 'block';
  modalStatus.textContent = 'Starting...';
  _routeStale = false;
  _routeComputing = true;
  renderResultStrip(null);
  RouteProgress.start();
  cancelBtn.style.display = 'inline-block';
}

function appendLog(text, cls) {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text + '\n';
  modalLog.appendChild(span);
  modalLog.scrollTop = modalLog.scrollHeight;
}

// ─────────── Itinerary tab ───────────
// Populated from the route's Point features once the result lands.
// Each card summarizes one leg (time, mode, SOG, COG, wind, TWA,
// current, waves, depth). Clicking a card centers the map on that
// waypoint and selects it.
let _itineraryFeatures = [];
let _routeWarnings = [];   // validator/propagator warnings of the route on the map

// Match each warning to the leg card it belongs to by position: the
// waypoint nearest the warning's `from` point.
function _warningCardIndex(w, lonlats) {
  const pt = Array.isArray(w.from) ? w.from : (Array.isArray(w.to) ? w.to : null);
  if (!pt || !lonlats.length) return -1;
  const k = Math.cos(pt[1] * Math.PI / 180);
  let best = -1, bestD = Infinity;
  lonlats.forEach((c, i) => {
    const dx = (c[0] - pt[0]) * k, dy = c[1] - pt[1];
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  });
  return Math.sqrt(bestD) * 111000 < 300 ? best : -1;   // within 300 m
}
function _warningText(w) {
  if (typeof w !== 'object' || w === null) return String(w);
  const kind = String(w.violation || 'warning').replace(/_/g, ' ');
  const at = Array.isArray(w.to) ? ' at ' + w.to[1].toFixed(4) + ', ' + w.to[0].toFixed(4) : '';
  return kind + at + (w.repaired ? ' · repaired' : '');
}

function _kv(label, value) {
  if (value == null || value === '' || value === '—') return '';
  return `<span class="kv"><span class="k">${label}</span><span class="v">${value}</span></span>`;
}

function populateItinerary(features) {
  // Drop LineString features; keep only waypoints with timing data.
  _itineraryFeatures = features.filter(f => {
    if (f.getGeometry().getType() !== 'Point') return false;
    const p = f.getProperties();
    return p.sog_ms != null || p.time != null;
  });
  if (_itineraryFeatures.length === 0) {
    modalItinerary.innerHTML = '<div style="padding:12px;color:#888;">No waypoints yet.</div>';
    return;
  }

  // Warnings → cards.
  const lonlats = _itineraryFeatures.map(f => ol.proj.toLonLat(f.getGeometry().getCoordinates()));
  const cardWarn = new Map();   // card idx → {land: bool, n: int}
  const warnRows = (_routeWarnings || []).map((w, wi) => {
    const ci = _warningCardIndex(w, lonlats);
    const land = w && w.violation === 'leg_crosses_land';
    if (ci >= 0) { const cur = cardWarn.get(ci) || { land: false, n: 0 }; cur.n += 1; cur.land = cur.land || land; cardWarn.set(ci, cur); }
    return { wi, ci, land, text: _warningText(w) + (ci >= 0 ? ' (leg ' + (ci + 1) + ')' : '') };
  });

  const cards = _itineraryFeatures.map((f, i) => {
    const p = f.getProperties();
    const isArrival = p.next_mode == null && p.next_sog_ms == null;
    const mode = isArrival ? 'arrival'
                : (p.next_mode || p.mode || '');
    const modeCls = mode.includes('sail') ? 'mode-sailing'
                 : mode.includes('motor') ? 'mode-motoring'
                 : isArrival ? 'mode-arrival' : '';

    // Sailing-tack color: starboard = green, port = red — matches the
    // map route-line coloring. Same `tackSide` rule as displayRoute
    // (wind minus course), forward-looking on the next leg.
    // No tack when course or wind is missing (no colour, no label).
    let tackCls = '';
    let tack = null;
    if (modeCls === 'mode-sailing') {
      const nCog = p.next_cog != null ? p.next_cog : p.outgoing_cog;
      tack = tackSide(nCog, p.next_wind_dir_deg);
      if (tack) tackCls = 'tack-' + tack;
    }

    const t = p.time ? formatTime(p.time) : '—';

    // Gather values (next-* for non-arrival, fallbacks for arrival).
    const sogMs = p.next_sog_ms != null ? p.next_sog_ms : p.sog_ms;
    const cogDeg = p.next_cog != null ? p.next_cog : p.outgoing_cog;
    const windMs = p.next_wind_ms;
    const windDir = p.next_wind_dir_deg;
    const twa = p.next_twa_deg;
    const curMs = p.next_current_ms;
    const curDir = p.next_current_dir_deg;
    const depthM = p.next_depth_m != null ? p.next_depth_m : p.depth_m;
    const swhM = p.next_swh_m != null ? p.next_swh_m : p.swh_m;
    const mwpS = p.next_mwp_s != null ? p.next_mwp_s : p.mwp_s;
    const mwdDeg = p.next_mwd_deg != null ? p.next_mwd_deg : p.mwd_deg;

    // Format
    const sog = fmtSpeed(sogMs);
    const cog = cogDeg != null
              ? `${degToCardinal(cogDeg)} ${Math.round(cogDeg)}°` : null;
    const pos = pointOfSail(twa, windMs);
    const wind = windMs != null
               ? `${fmtSpeed(windMs)} from ${degToCardinal(windDir)} (${Math.round(windDir || 0)}°)`
                 + (pos ? ` · ${pos}` : '')
               : null;
    const twaStr = twa != null ? Math.round(twa) + '°' : null;

    // Current: `current_dir_deg` is the set (flows TO); shown as "from"
    // with fair/foul computed vs COG.
    let curStr = null;
    if (curMs != null && curMs > 0.05) {
      const fromDeg = curDir != null ? (curDir + 180) % 360 : null;
      const ff = fairFoul(cogDeg, curDir);
      curStr = fmtSpeed(curMs)
             + (fromDeg != null ? ` from ${degToCardinal(fromDeg)} (${Math.round(fromDeg)}°)` : '')
             + (ff ? ' · ' + ff : '');
    }

    // Waves
    let wavesStr = null;
    if (swhM != null) {
      const parts = [fmtSwh(swhM)];
      if (mwpS != null) parts.push(fmtWavePeriod(mwpS));
      if (mwdDeg != null) parts.push(`from ${degToCardinal(mwdDeg)} ${Math.round(mwdDeg)}°`);
      wavesStr = parts.join(' · ');
    }

    // Depth: the plugin has no bathymetry, so `depth_m` is null and the
    // card shows "—".
    const depth = depthM != null ? fmtDepth(depthM) : '—';

    // Distance + time of the leg DEPARTING this waypoint
    // (`leg_distance_m`, `leg_time_s` on each Point). Arrival waypoint
    // has no next leg so both fields are absent (filtered out by _kv).
    const distStr = p.leg_distance_m != null
                  ? fmtDist(p.leg_distance_m) : null;
    // Leg time in H:MM (zero-padded minutes; hours unbounded).
    const legTimeStr = (() => {
      const s = p.leg_time_s;
      if (s == null) return null;
      const totalMin = Math.round(s / 60);
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      return `${h}:${String(m).padStart(2, '0')}`;
    })();

    const fields = [
      _kv('Distance', distStr),
      _kv('Time', legTimeStr),
      _kv('SOG', sog),
      _kv('COG', cog),
      _kv('Wind', wind),
      _kv('TWA', twaStr),
      _kv('Tack', tack ? (tack === 'port' ? 'Port' : 'Starboard') : null),
      _kv('Current', curStr),
      _kv('Waves', wavesStr),
      `<span class="kv"><span class="k">Depth</span><span class="v">${depth}</span></span>`,
    ].filter(Boolean).join('');

    const footer = (p.lat != null && p.lon != null)
      ? `<div class="leg-footer">${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}${p.role === 'via' ? ' · via' : ''}</div>`
      : '';

    const cw = cardWarn.get(i);
    const warnCls = cw ? (cw.land ? ' has-land' : ' has-warn') : '';
    const warnChip = cw ? `<span class="leg-warn-chip${cw.land ? ' land' : ''}" title="${cw.n} warning(s) on this leg">⚠${cw.n > 1 ? ' ' + cw.n : ''}</span>` : '';
    return `<div class="leg-card ${modeCls} ${tackCls}${warnCls}" data-idx="${i}">`
      + `<div class="leg-head">`
      + `  <span><span class="leg-num">${i + 1}.</span> <span class="leg-time">${t}</span>${warnChip}</span>`
      + `  <span class="leg-mode ${modeCls} ${tackCls}">${mode || '—'}</span>`
      + `</div>`
      + `<div class="leg-grid">${fields || '<span style="color:#666;">—</span>'}</div>`
      + footer
      + `</div>`;
  }).join('');
  let warnBlock = '';
  if (warnRows.length) {
    const nLand = warnRows.filter(r => r.land).length;
    warnBlock = `<div id="itinWarnings" class="${nLand ? '' : 'warn-only'}">`
      + `<div class="iw-head">${nLand ? nLand + ' land crossing' + (nLand > 1 ? 's' : '') + ' · ' : ''}${warnRows.length} warning${warnRows.length > 1 ? 's' : ''} — click one to see it on the map</div>`
      + warnRows.map(r => `<div class="iw-row${r.land ? ' land' : ''}" data-wi="${r.wi}" data-ci="${r.ci}">${r.text}</div>`).join('')
      + `</div>`;
  }
  modalItinerary.innerHTML = warnBlock + cards;

  modalItinerary.querySelectorAll('#itinWarnings .iw-row').forEach(row => {
    row.addEventListener('click', () => {
      const w = _routeWarnings[parseInt(row.dataset.wi, 10)];
      const ci = parseInt(row.dataset.ci, 10);
      const pt = w && (Array.isArray(w.to) ? w.to : w.from);
      if (pt) map.getView().animate({ center: ol.proj.fromLonLat(pt), zoom: Math.max(map.getView().getZoom(), 13), duration: 300 });
      if (ci >= 0) _highlightItineraryRow(ci);
    });
  });

  modalItinerary.querySelectorAll('.leg-card[data-idx]').forEach(card => {
    card.addEventListener('click', () => {
      const idx = parseInt(card.dataset.idx, 10);
      const f = _itineraryFeatures[idx];
      if (!f) return;
      _highlightItineraryRow(idx);
      _focusOnWaypoint(f);
    });
  });
}

function _highlightItineraryRow(idx) {
  modalItinerary.querySelectorAll('.leg-card.active').forEach(c => c.classList.remove('active'));
  const card = modalItinerary.querySelector(`.leg-card[data-idx="${idx}"]`);
  if (card) {
    card.classList.add('active');
    card.scrollIntoView({block: 'nearest', behavior: 'smooth'});
  }
}

function _focusOnWaypoint(f) {
  const coord = f.getGeometry().getCoordinates();
  map.getView().animate({ center: coord, duration: 300 });
  // Directly render the selection for this exact feature — skipping the
  // pixel-based feature lookup that could land on a different nearby
  // waypoint.
  _showPopupForFeature(f);
}

// --- Find Route ---
// Build the POST body for /api/routes. Accepts an `overrides` object so
// Live-mode re-plans can supply {start, waypoints, departure} without
// touching the other configurables, which still come from the DOM.
function buildRoutePayload(overrides) {
  overrides = overrides || {};
  const sailThreshKts = parseFloat(document.getElementById('sailThresh').value);
  const radiusM = parseFloat(document.getElementById('arrivalRadiusM').value);
  const depVal = document.getElementById('departure').value;
  const body = {
    start: overrides.start
        ? { lat: overrides.start[1], lon: overrides.start[0] }
        : { lat: startCoord[1], lon: startCoord[0] },
    end: overrides.end
        ? { lat: overrides.end[1], lon: overrides.end[0] }
        : { lat: endCoord[1], lon: endCoord[0] },
    mode: document.getElementById('mode').value,
    sail_thresh_ms: sailThreshKts * MS_PER_KT,        // m/s
  };
  if (overrides.departure !== undefined) body.departure = overrides.departure;
  else if (depVal && !Number.isNaN(new Date(depVal).getTime())) body.departure = new Date(depVal).toISOString();
  const stages = parseInt(document.getElementById('stages').value, 10);
  if (stages > 0) body.stages = Math.max(4, Math.min(200, stages));
  const name = (document.getElementById('routeName').value || '').trim();
  if (name) body.name = name;
  const pub = document.getElementById('publishSel').value;
  if (pub === 'true') body.publish = true; else if (pub === 'false') body.publish = false;
  if (document.getElementById('noCurrents').checked) body.no_currents = true;
  if (document.getElementById('noForecast').checked) body.no_forecast = true;
  const vessel = {};
  const ukc = parseFloat(document.getElementById('underKeelClearance').value);
  if (Number.isFinite(ukc)) vessel.under_keel_clearance = ukc;
  const tackS = parseFloat(document.getElementById('tackPenalty').value);
  if (Number.isFinite(tackS)) vessel.tack_penalty_s = tackS;
  // Vessel-type override. Power mode forces mode=motor, drops polar,
  // and sends hull-def values as a per-request vessel override.
  if (getVesselType() === 'power') {
    body.mode = 'motor';
    const pb = readPowerBoat();
    vessel.name = pb.name;
    vessel.loa = pb.loa_m;
    vessel.draught = pb.draught_m;
    vessel.air_draft = pb.air_draft_m;
    vessel.motor_speed_ms = pb.cruise_kts * MS_PER_KT;
  } else {
    const polarPath = document.getElementById('polarSelect').value;
    if (polarPath) vessel.polar = polarPath;
  }
  if (Object.keys(vessel).length) body.vessel = vessel;
  // Waypoints: overrides win if provided (Live mode's remaining vias);
  // otherwise use the user-picked intermediate pins.
  const wps = overrides.waypoints !== undefined
      ? overrides.waypoints
      : waypointCoords.map(c => ({ lat: c[1], lon: c[0] }));
  if (wps && wps.length > 0) {
    // Each waypoint ends one leg and starts the next. radius_m only when a
    // caller supplies one per waypoint; otherwise arrival_radius_m applies.
    body.waypoints = wps.map(w => (w.radius_m != null ? { lat: w.lat, lon: w.lon, radius_m: w.radius_m } : { lat: w.lat, lon: w.lon }));
    const precEl = document.getElementById('precision');
    body.precision = precEl && precEl.value === 'approximate' ? 'approximate' : 'precise';
    if (Number.isFinite(radiusM)) body.arrival_radius_m = radiusM;
  }
  return body;
}

// ── Job ladder: POST /api/routes → SSE /api/routes/{id}/events → result ──
let _activeJobES = null;
let _activeJobId = null;
function _closeJobStream() {
  if (_activeJobES) { try { _activeJobES.close(); } catch (_) {} _activeJobES = null; }
}
function _computeUiIdle() {
  _routeComputing = false;
  _activeJobId = null;
  const btn = document.getElementById('findRoute');
  btn.textContent = 'Find Route';
  cancelBtn.style.display = 'none';
  refreshFindRouteEnabled();
}

// Subscribe to a job's event stream and drive the log, progress bar and
// result. Used by Find Route and by the Saved tab for a job that is
// still queued/running. `Last-Event-ID` is sent by the browser on
// reconnect, so a dropped connection replays what was missed.
function attachToJob(id, jobRow) {
  _closeJobStream();
  _activeJobId = id;
  _currentRouteJobId = id;
  _currentRouteName = jobRow && jobRow.request ? (jobRow.request.name || '') : ((document.getElementById('routeName').value || '').trim());
  const btn = document.getElementById('findRoute');
  const statusEl = document.getElementById('status');
  btn.disabled = true;
  btn.textContent = 'Computing...';
  statusEl.textContent = 'Computing route...';
  showModal();
  appendLog('job ' + id);
  if (jobRow && Array.isArray(jobRow.progress)) {
    // Backfill from the status row; the SSE replay adds the rest.
    for (const p of jobRow.progress) RouteProgress.feed(p);
  }

  const t0 = Date.now();
  let lineCount = 0;
  const es = _activeJobES = new EventSource(ROUTER + '/routes/' + encodeURIComponent(id) + '/events', { withCredentials: true });
  const isMine = () => _activeJobES === es;

  es.addEventListener('status', ev => {
    if (!isMine()) return;
    let d = null; try { d = JSON.parse(ev.data); } catch (_) {}
    if (!d) return;
    if (d.status === 'queued') appendLog('status: queued' + (d.position ? ' (position ' + d.position + ')' : ''));
    else if (d.status === 'running') appendLog('status: running');
    else if (d.resource_id) appendLog('published to Signal K resources as ' + d.resource_id, 'done');
    else if (d.publish_error) appendLog('publish failed: ' + d.publish_error, 'error');
    if (d.status) modalStatus.textContent = d.status;
    RouteProgress.status(d);
  });
  es.addEventListener('progress', ev => {
    if (!isMine()) return;
    let p = null; try { p = JSON.parse(ev.data); } catch (_) {}
    if (!p) return;
    lineCount++;
    const msg = String(p.message || '');
    appendLog((p.total ? '[' + p.stage + '/' + p.total + '] ' : '') + msg, msg.startsWith('WARNING') ? 'warn' : undefined);
    RouteProgress.feed(p);
    modalStatus.textContent = 'Line ' + lineCount + ' | ' + ((Date.now() - t0) / 1000).toFixed(0) + 's elapsed';
  });
  es.addEventListener('route', () => { /* the result is fetched separately below (large payload) */ });
  es.addEventListener('done', ev => {
    if (!isMine()) return;
    _closeJobStream();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    let d = null; try { d = JSON.parse(ev.data); } catch (_) {}
    appendLog('Route complete! (' + elapsed + 's)', 'done');
    if (d && d.summary) appendLog('summary: ' + (fmtDist(d.summary.total_distance_m) || '') + ', ' + (fmtTime(d.summary.total_time_s) || '') + ', ' + d.summary.waypoint_count + ' waypoints' + (d.summary.polar ? ', polar ' + d.summary.polar : '') + (d.summary.polar_performance != null && UI_UNITS.ratio ? ' at ' + _fmt(d.summary.polar_performance, 'ratio') : ''));
    modalStatus.textContent = 'Done in ' + elapsed + 's';
    statusEl.textContent = '';
    RouteProgress.done(elapsed);
    routeActive = true;
    _computeUiIdle();
    // Fetch the route GeoJSON separately (SSE is not for large payloads).
    authFetch(ROUTER + '/routes/' + encodeURIComponent(id) + '/result', { cache: 'no-store' }, 'route-load')
      .then(r => r.ok ? r.json() : _apiErrorText(r).then(t => Promise.reject(new Error(t))))
      .then(geojson => {
        displayRoute(geojson);
        loadRouteHistory();
        RouteProgress.hide();
        showTab('itinerarySection');
      })
      .catch(err => appendLog('Failed to load route: ' + err.message, 'error'));
    // Fetch skeleton (coarse A* route) and draw in blue.
    authFetch(ROUTER + '/routes/' + encodeURIComponent(id) + '/skeleton', { cache: 'no-store' }, 'skeleton-load')
      .then(r => r.ok ? r.json() : null)
      .then(geojson => {
        skeletonSource.clear();
        if (!geojson) return;
        const features = new ol.format.GeoJSON().readFeatures(geojson, { featureProjection: 'EPSG:3857' });
        skeletonSource.addFeatures(features);
        console.log('Skeleton loaded: ' + features.length + ' features');
      })
      .catch(err => { console.log('Skeleton fetch error:', err); skeletonSource.clear(); });
    loadPluginStatus();
  });
  es.addEventListener('error', ev => {
    if (!isMine()) return;
    if (ev && ev.data) {
      // Server-pushed `event: error` — terminal (failed or cancelled).
      _closeJobStream();
      let d = null; try { d = JSON.parse(ev.data); } catch (_) {}
      const msg = (d && d.message) || 'compute error';
      const cancelled = d && d.status === 'cancelled';
      appendLog((cancelled ? 'Cancelled: ' : 'ERROR: ') + msg, 'error');
      modalStatus.textContent = cancelled ? 'Cancelled' : 'Failed';
      statusEl.textContent = cancelled ? 'Route cancelled.' : 'Error: ' + msg;
      RouteProgress.fail(cancelled ? 'Cancelled' : 'Failed: ' + msg);
      _computeUiIdle();
      showTab('logSection');
      const rawLog = document.getElementById('rawLog');
      if (rawLog) rawLog.open = true;
      loadRouteHistory();
      loadPluginStatus();
      return;
    }
    // Native connection drop: the browser retries with Last-Event-ID
    // while readyState is CONNECTING. CLOSED means it gave up (or the
    // server answered 404/401) — check the job's status once.
    if (es.readyState === EventSource.CLOSED) {
      _closeJobStream();
      authFetch(ROUTER + '/routes/' + encodeURIComponent(id), { cache: 'no-store' }, null)
        .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
        .then(j => {
          if (j.status === 'done') { appendLog('stream closed; job finished — loading result', 'done'); _computeUiIdle(); RouteProgress.hide(); _loadRouteJob(id); }
          else if (j.status === 'queued' || j.status === 'running') { appendLog('stream lost; reconnecting…', 'error'); setTimeout(() => attachToJob(id, j), 2000); }
          else { appendLog('job ' + j.status + (j.error ? ': ' + j.error : ''), 'error'); RouteProgress.fail(j.status); _computeUiIdle(); }
        })
        .catch(e => { appendLog('Connection error: ' + e.message, 'error'); statusEl.textContent = 'Error: ' + e.message; RouteProgress.fail('Connection error'); _computeUiIdle(); });
    } else {
      appendLog('(event stream interrupted — reconnecting)', 'error');
    }
  });
}

document.getElementById('findRoute').addEventListener('click', function() {
  const btn = this;
  const statusEl = document.getElementById('status');
  const infoEl = document.getElementById('routeInfo');

  btn.disabled = true;
  btn.textContent = 'Submitting...';
  statusEl.textContent = 'Submitting route...';
  infoEl.innerHTML = '';
  _routeComputing = true;

  const body = buildRoutePayload();
  authFetch(ROUTER + '/routes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, null)
    .then(r => r.ok ? r.json() : _apiErrorText(r).then(t => Promise.reject(new Error(t))))
    .then(job => {
      _currentRouteName = body.name || '';
      attachToJob(job.id, { request: body });
      loadRouteHistory();
    })
    .catch(err => {
      showModal();
      appendLog('Submit failed: ' + err.message, 'error');
      statusEl.textContent = 'Error: ' + err.message;
      RouteProgress.fail('Submit failed');
      _computeUiIdle();
      showTab('logSection');
    });
});

cancelBtn.addEventListener('click', () => {
  if (!_activeJobId) return;
  authFetch(ROUTER + '/routes/' + encodeURIComponent(_activeJobId) + '/cancel', { method: 'POST' }, null)
    .then(r => r.ok ? r.json() : _apiErrorText(r).then(t => Promise.reject(new Error(t))))
    .then(() => { appendLog('Cancel requested…', 'error'); modalStatus.textContent = 'Cancelling'; })
    .catch(e => appendLog('Cancel failed: ' + e.message, 'error'));
});

// --- Click popup ---
const popup = new ol.Overlay({
  element: (() => {
    const el = document.createElement('div');
    el.style.cssText = 'background:white;padding:8px;border-radius:4px;border:1px solid #ccc;font:12px sans-serif;max-width:300px;';
    document.body.appendChild(el);
    return el;
  })(),
  autoPan: true
});
map.addOverlay(popup);
// OpenLayers gives its overlay container an inline z-index of 0 inside
// #map, so popups sat under the panel (z-index 100) and under the
// streamline canvases (z-index 5, appended to #map). Lift the container
// above both.
map.getOverlayContainerStopEvent().style.zIndex = '150';

function degToCardinal(deg) {
  if (deg == null) return '—';
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

function _interpAt(x, xs, ys) {
  if (!xs || !ys || xs.length === 0) return null;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]) {
      const f = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
      return ys[i - 1] + f * (ys[i] - ys[i - 1]);
    }
  }
  return ys[ys.length - 1];
}

function pointOfSail(twa, windMs) {
  if (twa == null) return null;
  const a = Math.abs(twa);
  // Default bands when no polar is loaded.
  let beat = 40, run = 150;
  if (_polarAngles && windMs != null) {
    const b = _interpAt(windMs, _polarAngles.tws_ms, _polarAngles.beat_deg);
    const r = _interpAt(windMs, _polarAngles.tws_ms, _polarAngles.run_deg);
    if (b != null) beat = b;
    if (r != null) run = r;
  }
  if (a < beat - 5) return 'in irons';
  if (a < beat + 15) return 'close hauled';
  if (a < 75) return 'close reach';
  if (a <= 105) return 'beam reach';
  if (a <= run - 15) return 'broad reach';
  return 'downwind';
}

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit', hour12: false});
}

function fairFoul(cog, currentDir) {
  // Fair = current has any forward component (from astern semicircle),
  // Foul = any backward component (from ahead semicircle),
  // Cross = narrow ±10° band around the beam.
  if (cog == null || currentDir == null) return '';
  const diff = Math.abs(((currentDir - cog + 180) % 360) - 180);
  if (diff < 80) return '<span style="color:green;font-weight:bold">fair</span>';
  if (diff > 100) return '<span style="color:red;font-weight:bold">foul</span>';
  return '<span style="color:#b8860b">cross</span>';
}

// Render + position the selection for a single route-waypoint feature.
// Shared by the map-click handler and the itinerary card-click
// handler so both paths use the exact same feature.
let _selectedRouteFeature = null;
// Every overlay that is keyed by the overlay time. Called after
// `_currentTimeOverride` changes (waypoint click, conditions row
// click, reset).
function _reloadTimedOverlays() {
  loadCurrentOverlay();
  loadWindOverlay();
  loadWindHeatmap();
  loadCurrentHeatmap();
  loadRoughness();
  loadWaveHeatmap();
  loadPrecipHeatmap();
  loadTemperature();
  loadSst();
  loadTide();
  loadPressure();
  if (waveStreamlines.enabled) waveStreamlines._fetchField();
  if (windStreamlines.enabled) windStreamlines._fetchField();
}

function _showPopupForFeature(f) {
  const p = f.getProperties();
  if (!p.sog_ms && p.sog_ms !== 0) return;

  _selectedRouteFeature = f;
  routeLayer.changed();

  // Popup disabled — the itinerary cards carry the same info. We still
  // sync the card highlight and time-shift the overlays to the
  // waypoint's hour.
  const idx = _itineraryFeatures ? _itineraryFeatures.indexOf(f) : -1;
  if (idx >= 0) {
    showTab('itinerarySection');
    _highlightItineraryRow(idx);
    const card = modalItinerary.querySelector(`.leg-card[data-idx="${idx}"]`);
    if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  if (p.time) {
    _currentTimeOverride = new Date(p.time).toISOString();
    _reloadTimedOverlays();
  }
}

map.on('singleclick', function(e) {
  if (e.originalEvent.shiftKey) return;
  const features = map.getFeaturesAtPixel(e.pixel, {
    layerFilter: l => l === routeLayer
  });
  if (features.length > 0) {
    const f = features[0];
    const p = f.getProperties();

    // Skip LineString features (route line)
    if (!p.sog_ms && p.sog_ms !== 0) { popup.setPosition(undefined); return; }

    _showPopupForFeature(f);
  } else {
    popup.setPosition(undefined);
    if (_selectedRouteFeature) {
      _selectedRouteFeature = null;
      routeLayer.changed();
      modalItinerary.querySelectorAll('.leg-card.active').forEach(c => c.classList.remove('active'));
    }
    // Reset to departure time
    if (_currentTimeOverride) {
      _currentTimeOverride = null;
      _reloadTimedOverlays();
    }
  }
});

// ─────────── Conditions popup (shift-click) ───────────
// Tabs: Wind, Waves, Sea state, Current, Pressure, Temp, Precip (one
// chart each, plain canvas) and Raw (the hourly table). The hourly
// series comes from `GET /api/conditions`. Clicking a chart or a Raw
// row retimes every overlay to that hour. Tabs whose fields are all
// null in the series (e.g. temperature when the plugin's extra fields
// are off) are hidden.
function _fmtHpa(pa)   { return fmtPressure(pa) || '—'; }
function _fmtDegC(k)   { return fmtTemp(k) || '—'; }
function _fmtMmH(rate) { return fmtPrecip(rate) || '—'; }
function _fmtDir(deg)  { return deg == null ? '' : ' ' + degToCardinal(deg) + ' (' + Math.round(deg) + '°)'; }
function _fmtWhen(iso) {
  const d = new Date(iso);
  return d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}
function _rowCells(r) {
  return '<td>' + (fmtSpeed(r.wind_ms) || '—') + _fmtDir(r.wind_dir_deg) + '</td>'
       + '<td>' + (r.swh_m == null ? '—' : (fmtSwh(r.swh_m) + (r.mwp_s != null ? ' / ' + fmtWavePeriod(r.mwp_s) : '') + _fmtDir(r.mwd_deg))) + '</td>'
       + '<td>' + (r.current_ms == null ? '—' : (fmtSpeed(r.current_ms) + _fmtDir(r.current_dir_deg))) + '</td>'
       + '<td>' + _fmtHpa(r.msl_pa) + '</td>'
       + '<td>' + _fmtDegC(r.t2m_k) + ' / ' + ((_cond && _cond.isLand) ? '—' : _fmtDegC(r.skt_k)) + '</td>'
       + '<td>' + _fmtMmH(r.precip_rate_ms) + '</td>'
       + '<td>' + (r.precip_type_label || '—') + '</td>'
       + '<td>' + _fmtDegC(r.feels_like_k) + (r.feels_like_basis && r.feels_like_basis !== 'air' ? ' (' + r.feels_like_basis.replace('_', ' ') + ')' : '') + '</td>'
       + '<td>' + (r.rh == null ? '—' : (r.rh * 100).toFixed(0) + ' %') + '</td>'
       + '<td>' + (r.beaufort == null ? '—' : 'F' + r.beaufort) + '</td>'
       + '<td>' + (r.douglas == null ? '—' : r.douglas + ' ' + (r.douglas_label || '')) + '</td>'
       + '<td>' + (r.sea_state_index == null ? '—' : r.sea_state_index.toFixed(0) + ' ' + (r.sea_state || '') + (r.sea_state_partial ? '*' : '')) + '</td>'
       + '<td>' + (r.tide_m == null ? '—' : _fmtTideH(r.tide_m) + ' / ' + _fmtTideH(r.water_level_m) + ' / ' + _fmtTideH(r.surge_m) + (r.tide_extrapolated ? '*' : '')) + '</td>';
}
// Sea-level height in the user's depth unit, one more decimal than depths (tides are small).
function _tideUnit() { const u = unitDesc('depth'); u.p = u.p + 1; return u; }
function _fmtTideH(m) {
  if (m == null) return '—';
  const u = _tideUnit();
  if (u.missing) return UNIT_MISSING;
  const t = u.fn(m).toFixed(u.p);
  return (t.startsWith('-') && Number(t) === 0 ? t.slice(1) : t) + ' ' + u.u;
}
const _COND_HEAD = '<tr><th>time</th><th>wind</th><th>waves (h / T)</th><th>current (set)</th><th>press.</th><th>air / water</th><th>rain</th><th>type</th><th>feels like</th><th>RH</th><th>Bft</th><th>Douglas</th><th>sea state</th><th>tide / level / surge</th></tr>';

// Display-unit scale for a SI value.
function _unitOf(key) { return unitDesc(key); }

// Tab definitions. `lines`: series drawn; `dir`: arrow field + sense
// ('from' → arrow shows where it goes, 'to' → as given); `hover`:
// extra text for the readout.
const _BEAUFORT_NAMES = ['calm', 'light air', 'light breeze', 'gentle breeze', 'moderate breeze',
  'fresh breeze', 'strong breeze', 'near gale', 'gale', 'strong gale', 'storm', 'violent storm', 'hurricane force'];
let _condSub = {};   // tab id → selected sub-tab id
const _PRECIP_COLORS = {
  'rain': '#1e88e5', 'freezing rain': '#d81b60', 'freezing drizzle': '#f06292',
  'snow': '#546e7a', 'wet snow': '#26a69a', 'rain and snow': '#8e24aa',
  'ice pellets': '#00acc1', 'none': '#bdbdbd', 'other': '#9e9e9e',
};
const _COND_TABS = [
  { id: 'wind',  label: 'Wind', overlays: [['windToggle', 'Barbs'], ['windCombinedToggle', 'Wind speed']],
    lines: [{ key: 'wind_ms', unit: () => _unitOf('speed'), color: '#1565c0', name: 'wind' }],
    dir: { key: 'wind_dir_deg', sense: 'from' },
    hover: r => r.beaufort == null ? '' : ' · Beaufort ' + r.beaufort },
  { id: 'waves', label: 'Waves', marine: true, overlays: [['wavesCombinedToggle', 'Wave height']],
    lines: [{ key: 'swh_m', unit: () => _unitOf('wave_height'), color: '#00838f', name: 'height' }],
    dir: { key: 'mwd_deg', sense: 'from' },
    hover: r => (r.mwp_s == null ? '' : ' · period ' + fmtWavePeriod(r.mwp_s))
              + (r.douglas == null ? '' : ' · Douglas ' + r.douglas + ' ' + (r.douglas_label || '')) },
  { id: 'seastate', label: 'Sea state', marine: true,
    sub: [
      { id: 'index', label: 'Index', overlays: [['roughnessToggle', 'Sea state']],
        lines: [{ key: 'sea_state_index', unit: () => ({ fn: v => v, u: 'index', p: 0 }), color: '#ad1457', name: 'index' }],
        bands: [[35, 'good'], [50, 'slight'], [75, 'choppy'], [100, 'rough'], [150, 'extreme']],
        hover: r => (r.sea_state ? ' · ' + r.sea_state : '') + (r.sea_state_partial ? ' (wind only, no wave data)' : '') },
      { id: 'beaufort', label: 'Beaufort', overlays: [['windCombinedToggle', 'Wind speed']],
        lines: [{ key: 'beaufort', unit: () => ({ fn: v => v, u: 'force', p: 0 }), color: '#1565c0', name: 'force', step: true }],
        range: [0, 12], yTicks: 6,
        hover: r => r.beaufort == null ? '' : ' · ' + _BEAUFORT_NAMES[r.beaufort] },
      { id: 'douglas', label: 'Douglas', overlays: [['wavesCombinedToggle', 'Waves']],
        lines: [{ key: 'douglas', unit: () => ({ fn: v => v, u: 'state', p: 0 }), color: '#00838f', name: 'state', step: true }],
        range: [0, 9], yTicks: 9,
        hover: r => r.douglas_label ? ' · ' + r.douglas_label : '' },
    ] },
  // Tide and current on one chart: tide heights relative to mean sea level
  // (Copernicus Marine hourly sea level: tide, total water level = tide +
  // surge, non-tidal residual) on the left axis; current speed on the right
  // axis with its set as arrows along the top, so slack water lines up with
  // high and low water. On land the current line (marine) is dropped.
  { id: 'tidecur', label: 'Tide & current',
    overlays: [['tideToggle', 'Tide height'], ['currentToggle', 'Current direction'], ['currentHeatmapToggle', 'Current speed']],
    // Validated categorical slots (blue, violet, orange, aqua; all-pairs
    // colour-blind ΔE ≥ 9.2, normal-vision ≥ 16.3). Aqua is light on white,
    // so current speed is also a filled area, a different mark from the lines.
    lines: [{ key: 'tide_m', unit: () => _tideUnit(), color: '#2a78d6', name: 'tide height', width: 2 },
            { key: 'water_level_m', unit: () => _tideUnit(), color: '#eb6834', name: 'total water level', width: 2 },
            { key: 'surge_m', unit: () => _tideUnit(), color: '#4a3aa7', name: 'surge (non-tidal)', width: 1.6, dash: [5, 3] },
            { key: 'current_ms', unit: () => _unitOf('speed'), color: '#1baf7a', name: 'current speed', axis: 'right', width: 1.5, fill: 'rgba(27,175,122,0.16)', marine: true }],
    dir: { key: 'current_dir_deg', sense: 'to', color: '#11805a' },
    zeroLine: 'mean sea level', tideMarks: true,
    hover: r => (r.tide_tendency ? ' · tide ' + r.tide_tendency : '') + (r.tide_extrapolated ? ' · tide extrapolated near the coast' : '') },
  { id: 'pressure', label: 'Pressure', overlays: [['pressureToggle', 'Isobars']],
    lines: [{ key: 'msl_pa', unit: () => unitDesc('pressure'), color: '#37474f', name: 'MSL' }] },
  { id: 'temp', label: 'Temp', overlays: [['temperatureToggle', 'Air'], ['sstToggle', 'Sea surface']],
    lines: [{ key: 't2m_k', unit: () => unitDesc('temperature'), color: '#e65100', name: 'air' },
            // ECMWF skin temperature: sea surface over ocean cells, ground
            // over land cells — only shown as "water" off land.
            { key: 'skt_k', unit: () => unitDesc('temperature'), color: '#0277bd', name: 'water', marine: true },
            { key: 'feels_like_k', unit: () => unitDesc('temperature'), color: '#8e24aa', name: 'feels like', width: 2.4 },
            { key: 'wind_chill_k', unit: () => unitDesc('temperature'), color: '#00838f', name: 'wind chill', dash: [4, 3] },
            { key: 'heat_index_k', unit: () => unitDesc('temperature'), color: '#c62828', name: 'heat index', dash: [4, 3] }],
    hover: r => (r.rh == null ? '' : ' · RH ' + (r.rh * 100).toFixed(0) + ' %')
              + (r.dewpoint_k == null ? '' : ' · dew point ' + _fmtDegC(r.dewpoint_k)) },
  { id: 'precip', label: 'Precip', overlays: [['precipToggle', 'Precip']],
    lines: [{ key: 'precip_rate_ms', unit: () => unitDesc('precip'), color: '#2e7d32', name: 'rate' }],
    colorBy: { key: 'precip_type_label', colors: _PRECIP_COLORS },
    hover: r => r.precip_type_label && r.precip_type_label !== 'none' ? ' · ' + r.precip_type_label : '' },
  { id: 'raw', label: 'Raw' },
];
let _condTab = 'wind';
let _cond = null;   // { lon, lat, hourIso, instant, series, note, isLand }

function _condDisplay(v, unit) {
  if (v == null || unit.missing) return null;
  return unit.fn(v);
}

// True when at least one row of the series carries a value for any of
// the tab's lines. Before the series arrives every tab is shown.
function _tabHasData(tab, series) {
  if (!series) return true;
  if (!tab.lines) return true;
  return tab.lines.some(l => series.some(r => r[l.key] != null));
}

function _condSetHour(iso) {
  _currentTimeOverride = new Date(iso).toISOString();
  if (_cond) _cond.hourIso = _currentTimeOverride.slice(0, 13) + ':00:00Z';
  _reloadTimedOverlays();
  _renderConditionsPopup();
}

// ── Chart ──
const _CH = { w: 500, h: 230, left: 46, right: 10, top: 30, bottom: 28 };
// Right margin: room for a second value axis when a line uses axis:'right'.
function _chRight(tab) { return tab && tab.lines && tab.lines.some(l => l.axis === 'right') ? 46 : _CH.right; }

function _drawArrow(ctx, x, y, deg, color) {
  // Canvas y is down; 0° = up (north), clockwise.
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(deg * Math.PI / 180);
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(0, 6); ctx.lineTo(0, -5); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(-3.5, -2); ctx.lineTo(3.5, -2); ctx.closePath(); ctx.fill();
  ctx.restore();
}

function _drawConditionsChart(canvas, tab, series, hourIso, instant, hoverIdx) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = _CH.w * dpr; canvas.height = _CH.h * dpr;
  canvas.style.width = _CH.w + 'px'; canvas.style.height = _CH.h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, _CH.w, _CH.h);
  ctx.font = '10px sans-serif';
  const x0 = _CH.left, x1 = _CH.w - _chRight(tab), y0 = _CH.top, y1 = _CH.h - _CH.bottom;
  const n = series.length;
  if (n < 2) { ctx.fillStyle = '#666'; ctx.fillText('No series', x0, (y0 + y1) / 2); return; }
  const t0 = new Date(series[0].time).getTime(), tN = new Date(series[n - 1].time).getTime();
  const xOf = t => x0 + (t - t0) / (tN - t0) * (x1 - x0);

  // Value range across all lines (display units), padded.
  const allLines = tab.lines.map(l => ({ ...l, u: l.unit(), vals: series.map(r => _condDisplay(r[l.key], l.unit())) }));
  // Lines on a right-hand axis get their own range and scale (tide & current).
  const rightLines = allLines.filter(l => l.axis === 'right' && l.vals.some(v => v != null));
  let lines = allLines.filter(l => l.axis !== 'right');
  if (!lines.some(l => l.vals.some(v => v != null)) && rightLines.length) lines = [];
  let vmin = Infinity, vmax = -Infinity;
  for (const l of lines) for (const v of l.vals) if (v != null) { vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); }
  if (instant) for (const l of lines) { const v = _condDisplay(instant[l.key], l.u); if (v != null) { vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); } }
  if (!isFinite(vmin) && !rightLines.length) { ctx.fillStyle = '#666'; ctx.fillText('No data', x0, (y0 + y1) / 2); return; }
  if (!isFinite(vmin)) { vmin = 0; vmax = 1; }
  let rmin = 0, rmax = -Infinity;
  for (const l of rightLines) for (const v of l.vals) if (v != null) rmax = Math.max(rmax, v);
  if (instant) for (const l of rightLines) { const v = _condDisplay(instant[l.key], l.u); if (v != null) rmax = Math.max(rmax, v); }
  if (!(rmax > rmin)) rmax = rmin + 1;
  rmax += (rmax - rmin) * 0.08;
  const yOfR = v => y1 - (v - rmin) / (rmax - rmin) * (y1 - y0);
  if (tab.id !== 'pressure' && tab.id !== 'temp') vmin = Math.min(0, vmin);
  if (tab.bands) vmax = Math.max(vmax, tab.bands[1][0]);   // show at least two bands
  if (vmax === vmin) vmax = vmin + 1;
  if (tab.range) { vmin = tab.range[0]; vmax = tab.range[1]; }
  else { const pad = (vmax - vmin) * 0.08; vmin -= pad; vmax += pad; }
  const yOf = v => y1 - (v - vmin) / (vmax - vmin) * (y1 - y0);
  const yOfLine = l => (l.axis === 'right' ? yOfR : yOf);
  const drawn = lines.concat(rightLines);

  // Y grid + labels.
  ctx.strokeStyle = '#e6e6e6'; ctx.fillStyle = '#555'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const yTicks = tab.yTicks || 4;
  for (let i = 0; i <= yTicks; i++) {
    const v = vmin + (vmax - vmin) * i / yTicks, y = yOf(v);
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    if (lines.length) ctx.fillText(v.toFixed(lines[0].u.p), x0 - 4, y);
  }
  ctx.textAlign = 'left'; if (lines.length) ctx.fillText(lines[0].u.u, x0 - 44, y0 - 18);
  // Right-hand axis labels in the right line's colour and unit.
  if (rightLines.length) {
    const ru = rightLines[0].u;
    ctx.fillStyle = '#555'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= yTicks; i++) {
      const v = rmin + (rmax - rmin) * i / yTicks;
      ctx.fillText(v.toFixed(Math.max(1, ru.p)), x1 + 4, yOfR(v));
    }
    ctx.textAlign = 'right'; ctx.fillText(ru.u, _CH.w - 2, y0 - 18);
    ctx.fillStyle = '#555';
  }

  // Band boundaries (sea-state tab): dashed lines with the band name
  // of the region above each cut.
  if (tab.bands) {
    ctx.setLineDash([2, 3]); ctx.strokeStyle = '#c99'; ctx.fillStyle = '#a66';
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    for (const [cut, name] of tab.bands) {
      if (cut < vmin || cut > vmax) continue;
      const y = yOf(cut);
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.fillText(name, x1 - 2, y - 1);
    }
    ctx.setLineDash([]);
  }

  // X ticks: every 6 h local, day name at local midnight.
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const first = new Date(t0); first.setMinutes(0, 0, 0);
  for (let d = new Date(first); d.getTime() <= tN; d.setHours(d.getHours() + 1)) {
    const h = d.getHours(); if (h % 6) continue;
    const x = xOf(d.getTime());
    ctx.strokeStyle = h === 0 ? '#bbb' : '#eee';
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    ctx.fillStyle = '#555';
    ctx.fillText(h === 0 ? d.toLocaleDateString([], { weekday: 'short' }) : String(h).padStart(2, '0'), x, y1 + 4);
  }
  ctx.strokeStyle = '#999'; ctx.beginPath(); ctx.moveTo(x0, y1); ctx.lineTo(x1, y1); ctx.stroke();

  // Lines. With `tab.colorBy`, each segment takes the colour of the
  // category at its end point (precip type), so the rate line changes
  // colour where the type changes.
  // Filled areas first (under every line), down to their axis baseline.
  for (const l of drawn) {
    if (!l.fill) continue;
    const yOf = yOfLine(l), base = l.axis === 'right' ? yOfR(rmin) : yOf(Math.max(vmin, Math.min(vmax, 0)));
    ctx.fillStyle = l.fill; ctx.beginPath(); let open = false, lastX = null;
    series.forEach((r, i) => {
      const v = l.vals[i]; const x = xOf(new Date(r.time).getTime());
      if (v == null) { if (open) { ctx.lineTo(lastX, base); ctx.closePath(); open = false; } return; }
      if (!open) { ctx.moveTo(x, base); open = true; }
      ctx.lineTo(x, yOf(v)); lastX = x;
    });
    if (open) { ctx.lineTo(lastX, base); ctx.closePath(); }
    ctx.fill();
  }
  for (const l of drawn) {
    const yOf = yOfLine(l);
    ctx.lineWidth = l.width || 1.6; ctx.setLineDash(l.dash || []);
    if (tab.colorBy) {
      for (let i = 1; i < n; i++) {
        const a = l.vals[i - 1], b = l.vals[i]; if (a == null || b == null) continue;
        const cat = series[i][tab.colorBy.key] || 'none';
        ctx.strokeStyle = tab.colorBy.colors[cat] || tab.colorBy.colors.other;
        ctx.beginPath();
        ctx.moveTo(xOf(new Date(series[i - 1].time).getTime()), yOf(a));
        ctx.lineTo(xOf(new Date(series[i].time).getTime()), yOf(b));
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = l.color; ctx.beginPath(); let up = true, prevY = null;
      series.forEach((r, i) => {
        const v = l.vals[i]; if (v == null) { up = true; return; }
        const x = xOf(new Date(r.time).getTime()), y = yOf(v);
        if (up) { ctx.moveTo(x, y); up = false; }
        else if (l.step) { ctx.lineTo(x, prevY); ctx.lineTo(x, y); }   // step chart
        else ctx.lineTo(x, y);
        prevY = y;
      });
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // Direction arrows along the top (thinned when dense).
  if (tab.dir) {
    const every = n > 40 ? 3 : n > 20 ? 2 : 1;
    series.forEach((r, i) => {
      if (i % every) return;
      const d = r[tab.dir.key]; if (d == null) return;
      const deg = tab.dir.sense === 'from' ? d + 180 : d;
      _drawArrow(ctx, xOf(new Date(r.time).getTime()), y0 - 8, deg, tab.dir.color || (drawn[0] && drawn[0].color) || '#555');
    });
  }

  // Reference level (tide tab: mean sea level) as a labelled solid line.
  if (tab.zeroLine && 0 >= vmin && 0 <= vmax) {
    ctx.strokeStyle = '#90a4ae'; ctx.lineWidth = 1; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(x0, yOf(0)); ctx.lineTo(x1, yOf(0)); ctx.stroke();
    ctx.fillStyle = '#78909c'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(tab.zeroLine, x0 + 3, yOf(0) - 1);
  }
  // High / low water markers (tide tab): triangles at the refined time and height, labelled with the clock time.
  if (tab.tideMarks && lines.length && typeof _cond !== 'undefined' && _cond && _cond.tides) {
    const u = lines[0].u;
    const mark = (e, up) => {
      const t = new Date(e.time).getTime();
      if (t < t0 || t > tN) return;
      const x = xOf(t), y = yOf(u.fn(e.height_m));
      ctx.fillStyle = lines[0].color;
      ctx.beginPath();
      if (up) { ctx.moveTo(x, y - 7); ctx.lineTo(x - 4, y - 1); ctx.lineTo(x + 4, y - 1); }
      else { ctx.moveTo(x, y + 7); ctx.lineTo(x - 4, y + 1); ctx.lineTo(x + 4, y + 1); }
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#333'; ctx.textAlign = 'center'; ctx.textBaseline = up ? 'bottom' : 'top';
      ctx.fillText(new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), x, up ? y - 8 : y + 8);
    };
    for (const e of _cond.tides.highs || []) mark(e, true);
    for (const e of _cond.tides.lows || []) mark(e, false);
  }

  // Current overlay hour + instant (map) value.
  const tc = new Date(hourIso).getTime();
  if (tc >= t0 && tc <= tN) {
    const x = xOf(tc);
    ctx.strokeStyle = '#d32f2f'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke(); ctx.setLineDash([]);
    if (instant) for (const l of drawn) {
      const v = _condDisplay(instant[l.key], l.u); if (v == null) continue;
      ctx.strokeStyle = l.color; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, yOfLine(l)(v), 4, 0, Math.PI * 2); ctx.stroke();
    }
  }

  // Hover marker.
  if (hoverIdx != null && series[hoverIdx]) {
    const x = xOf(new Date(series[hoverIdx].time).getTime());
    ctx.strokeStyle = '#999'; ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    for (const l of drawn) { const v = l.vals[hoverIdx]; if (v == null) continue; ctx.fillStyle = l.color; ctx.beginPath(); ctx.arc(x, yOfLine(l)(v), 3, 0, Math.PI * 2); ctx.fill(); }
  }
  return { xOf, t0, tN };
}

function _condIdxAtX(series, px, tab) {
  const n = series.length; if (n < 2) return null;
  const t0 = new Date(series[0].time).getTime(), tN = new Date(series[n - 1].time).getTime();
  const frac = Math.max(0, Math.min(1, (px - _CH.left) / (_CH.w - _CH.left - _chRight(tab))));
  const t = t0 + frac * (tN - t0);
  let best = 0, bd = Infinity;
  series.forEach((r, i) => { const d = Math.abs(new Date(r.time).getTime() - t); if (d < bd) { bd = d; best = i; } });
  return best;
}

function _condReadout(tab, r) {
  const parts = [_fmtWhen(r.time)];
  for (const l of tab.lines) {
    const u = l.unit(), v = _condDisplay(r[l.key], u);
    if (v == null && tab.lines.length > 1) continue;   // optional line, nothing this hour
    parts.push((tab.lines.length > 1 ? l.name + ' ' : '') + (v == null ? '—' : v.toFixed(u.p) + ' ' + u.u));
  }
  if (tab.dir && r[tab.dir.key] != null) parts.push((tab.dir.sense === 'from' ? 'from ' : 'set ') + degToCardinal(r[tab.dir.key]) + ' (' + Math.round(r[tab.dir.key]) + '°)');
  if (tab.hover) parts.push(tab.hover(r).replace(/^ · /, ''));
  return parts.filter(Boolean).join(' · ');
}

// Legend entries for a tab: the lines that have any data, or the
// precip types present in the series.
function _condLegend(tab, series) {
  const items = [];
  if (tab.colorBy) {
    const seen = new Set();
    for (const r of series || []) { const c = r[tab.colorBy.key]; if (c && c !== 'none') seen.add(c); }
    for (const c of seen) items.push({ name: c, color: tab.colorBy.colors[c] || tab.colorBy.colors.other, dash: null });
    if (!items.length) {
      // No typed precip this series: say whether the rate line is
      // still non-zero (type missing) or genuinely dry.
      const rateKey = tab.lines[0].key;
      const wet = (series || []).some(r => r[rateKey] != null && r[rateKey] > 0);
      items.push({ name: wet ? 'precipitation type unavailable' : 'no precipitation', color: tab.colorBy.colors.none, dash: null });
    }
  } else if (tab.lines.length > 1) {
    for (const l of tab.lines) {
      if ((series || []).some(r => r[l.key] != null)) items.push({ name: l.name, color: l.color, dash: l.dash || null, fill: l.fill || null });
    }
  }
  return items.map(it =>
    '<span style="display:inline-flex;align-items:center;margin-right:10px;">'
    + (it.fill
      ? '<span style="display:inline-block;width:18px;height:9px;background:' + it.fill + ';border-top:2px solid ' + it.color + ';margin-right:4px;"></span>'
      : '<span style="display:inline-block;width:18px;border-top:' + (it.dash ? '2px dashed ' : '3px solid ') + it.color + ';margin-right:4px;"></span>')
    + it.name + '</span>').join('');
}

// High / low water list and the datum / extrapolation notes under the Tide chart.
function _tideDetailsHtml(series) {
  const T = _cond && _cond.tides;
  let h = '<div style="font-size:11px;color:#333;margin-top:4px;">';
  if (T) {
    const ev = (T.highs || []).map(e => ({ e, hi: true })).concat((T.lows || []).map(e => ({ e, hi: false })))
      .sort((a, b) => new Date(a.e.time) - new Date(b.e.time));
    if (ev.length) {
      h += '<div style="display:flex;flex-wrap:wrap;gap:2px 10px;">' + ev.map(({ e, hi }) =>
        '<span><b style="color:' + (hi ? '#004d40' : '#6d4c41') + ';">' + (hi ? '▲ High' : '▼ Low') + '</b> '
        + _fmtWhen(e.time) + ' ' + _fmtTideH(e.height_m) + '</span>').join('') + '</div>';
    } else h += '<div>No high or low water within this window.</div>';
    if (T.range_m != null) h += '<div>Tidal range: ' + _fmtTideH(T.range_m) + ' mean' + (T.max_range_m != null ? ', ' + _fmtTideH(T.max_range_m) + ' largest' : '') + '</div>';
  } else if (_cond && _cond.tidesError) {
    h += '<div style="color:#b71c1c;">Tide data unavailable: ' + _cond.tidesError + '</div>';
  }
  const extrap = (T && T.extrapolated) || (series || []).some(r => r.tide_extrapolated);
  h += '<div style="color:#666;">Heights relative to mean sea level, not chart datum. Not for under-keel clearance.'
    + (extrap ? ' <b style="color:#e65100;">Extrapolated near the coast</b> (the nearest model cells are land).' : '')
    + ' Copernicus Marine hourly sea level, 1/12°' + (T && T.run ? ' (run ' + T.run + ')' : '') + '.</div>';
  return h + '</div>';
}

function _renderConditionsPopup() {
  if (!_cond) return;
  const { lon, lat, hourIso, instant, series, note } = _cond;
  // Marine tabs (waves, current, sea state) mean nothing on land, and a
  // tab whose fields are absent from the series has nothing to draw.
  const tabs = _COND_TABS
    .filter(t => !(t.marine && _cond.isLand))
    .map(t => t.sub ? Object.assign({}, t, { sub: t.sub.filter(st => _tabHasData(st, series)) }) : t)
    .filter(t => t.id === 'raw' || (t.sub ? t.sub.length > 0 : _tabHasData(t, series)));
  if (!tabs.some(t => t.id === _condTab)) _condTab = tabs.length ? tabs[0].id : 'raw';
  const el = popup.getElement();
  let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">'
    + '<b>Conditions at ' + lat.toFixed(4) + ', ' + lon.toFixed(4) + '</b>'
    + (_cond.isLand ? '<span style="color:#b71c1c;font-weight:600;margin-left:8px;">on land</span>' : '')
    + '<span id="condClose" style="cursor:pointer;padding:0 4px;">×</span></div>';
  html += '<div id="condTabs" style="display:flex;gap:2px;border-bottom:1px solid #ddd;margin-bottom:6px;">';
  for (const t of tabs) {
    const on = t.id === _condTab;
    html += '<span data-tab="' + t.id + '" style="padding:3px 8px;cursor:pointer;border-radius:3px 3px 0 0;'
      + (on ? 'background:#e8eef7;font-weight:600;border:1px solid #ddd;border-bottom:1px solid #e8eef7;margin-bottom:-1px;' : 'color:#555;')
      + '">' + t.label + '</span>';
  }
  html += '</div>';
  let tab = tabs.find(t => t.id === _condTab) || tabs[0];
  if (tab.sub) {
    // Second row of pills inside this tab; the chosen sub-tab is the
    // chart definition.
    let subId = _condSub[tab.id] || tab.sub[0].id;
    if (!tab.sub.some(st => st.id === subId)) subId = tab.sub[0].id;
    html += '<div id="condSubTabs" style="display:flex;gap:2px;margin:-2px 0 6px 0;">';
    for (const st of tab.sub) {
      const on = st.id === subId;
      html += '<span data-sub="' + st.id + '" style="padding:2px 8px;cursor:pointer;border-radius:10px;font-size:11px;'
        + (on ? 'background:#ad1457;color:#fff;font-weight:600;' : 'background:#eee;color:#555;')
        + '">' + st.label + '</span>';
    }
    html += '</div>';
    const parentId = tab.id;
    tab = Object.assign({ id: parentId + ':' + subId }, tab.sub.find(st => st.id === subId) || tab.sub[0]);
    tab._parent = parentId;
  }
  // On land a "water" temperature is the ground: leave that line out.
  if (_cond.isLand && tab.lines && tab.lines.some(l => l.marine)) {
    tab = Object.assign({}, tab, { lines: tab.lines.filter(l => !l.marine) });
  }
  // Map overlays that show the same field as this chart, as pills that
  // mirror (and click) their Layers-tab checkboxes. `overlays` is
  // [checkboxId, label] pairs on the tab or sub-tab definition.
  const overlays = (tab.overlays || []).filter(([id]) => document.getElementById(id));
  if (overlays.length) {
    html += '<div id="condOverlays" style="display:flex;gap:4px;align-items:center;margin:0 0 6px 0;font-size:11px;">'
      + '<span style="color:#666;">Map:</span>';
    for (const [id, label] of overlays) {
      const on = document.getElementById(id).checked;
      html += '<span data-toggle="' + id + '" title="' + (on ? 'Hide' : 'Show') + ' this overlay on the map" '
        + 'style="padding:2px 8px;cursor:pointer;border-radius:10px;border:1px solid ' + (on ? '#1565c0' : '#ccc') + ';'
        + (on ? 'background:#1565c0;color:#fff;font-weight:600;' : 'background:#fff;color:#555;')
        + '">' + label + '</span>';
    }
    html += '</div>';
  }
  if (tab.id === 'raw') {
    html += '<div style="max-height:300px;overflow:auto;"><table style="border-collapse:collapse;font-size:11px;white-space:nowrap;">' + _COND_HEAD;
    if (instant) html += '<tr style="background:#eef;"><td>' + _fmtWhen(hourIso) + ' (map)</td>' + _rowCells(instant) + '</tr>';
    if (series && series.length) {
      const curHour = hourIso.slice(0, 13);
      for (const r of series) {
        const isCur = r.time.slice(0, 13) === curHour;
        html += '<tr class="cond-row" data-time="' + r.time + '" style="cursor:pointer;' + (isCur ? 'background:#ffe;font-weight:600;' : '')
          + '"><td>' + _fmtWhen(r.time) + '</td>' + _rowCells(r) + '</tr>';
      }
    }
    html += '</table></div>';
  } else {
    html += '<canvas id="condChart" style="display:block;cursor:crosshair;"></canvas>'
      + '<div style="font-size:11px;color:#333;margin-top:2px;">' + _condLegend(tab, series) + '</div>'
      + '<div id="condReadout" style="font-size:11px;color:#333;min-height:14px;margin-top:2px;"></div>';
    if (tab.tideMarks) html += _tideDetailsHtml(series);
  }
  if (note) html += '<div style="color:#666;margin-top:4px;font-size:11px;">' + note + '</div>';
  el.innerHTML = html;
  el.style.maxWidth = (_CH.w + 20) + 'px';

  el.querySelector('#condClose').onclick = () => { popup.setPosition(undefined); el.style.maxWidth = '300px'; };
  el.querySelectorAll('#condTabs span').forEach(sp => {
    sp.onclick = () => { _condTab = sp.dataset.tab; _renderConditionsPopup(); };
  });
  el.querySelectorAll('#condSubTabs span').forEach(sp => {
    sp.onclick = () => { _condSub[tab._parent] = sp.dataset.sub; _renderConditionsPopup(); };
  });
  el.querySelectorAll('#condOverlays span[data-toggle]').forEach(sp => {
    // .click() on the checkbox runs its inline onchange (show + load,
    // or hide + clear) and keeps the Layers tab in step.
    sp.onclick = () => { document.getElementById(sp.dataset.toggle).click(); _renderConditionsPopup(); };
  });
  el.querySelectorAll('.cond-row').forEach(tr => { tr.onclick = () => _condSetHour(tr.dataset.time); });

  const canvas = el.querySelector('#condChart');
  if (canvas) {
    const ro = el.querySelector('#condReadout');
    const ser = series || [];
    const cur = ser.length ? _condIdxAtX(ser, _CH.left + (new Date(hourIso).getTime() - new Date(ser[0].time).getTime())
                  / Math.max(1, new Date(ser[ser.length - 1].time).getTime() - new Date(ser[0].time).getTime()) * (_CH.w - _CH.left - _chRight(tab)), tab) : null;
    _drawConditionsChart(canvas, tab, ser, hourIso, instant, null);
    if (cur != null) ro.textContent = _condReadout(tab, ser[cur]);
    else if (instant) ro.textContent = _condReadout(tab, Object.assign({ time: hourIso }, instant)) + ' (map)';
    canvas.onmousemove = ev => {
      if (!ser.length) return;
      const i = _condIdxAtX(ser, ev.offsetX, tab);
      _drawConditionsChart(canvas, tab, ser, hourIso, instant, i);
      ro.textContent = _condReadout(tab, ser[i]);
    };
    canvas.onmouseleave = () => { _drawConditionsChart(canvas, tab, ser, hourIso, instant, null); if (cur != null) ro.textContent = _condReadout(tab, ser[cur]); };
    canvas.onclick = ev => { if (!ser.length) return; _condSetHour(ser[_condIdxAtX(ser, ev.offsetX, tab)].time); };
  }
}

// Open the conditions popup for a map coordinate (shift-click, or
// "Conditions here" on the click menu). 72 hourly rows from the overlay
// hour; the plugin clips the series to the forecast's valid range.
function openConditionsAt(coordinate, pixel) {
  const [lon, lat] = ol.proj.toLonLat(coordinate);
  const hourIso = _overlayTimeIso().slice(0, 13) + ':00:00Z';
  _cond = { lon, lat, hourIso, instant: null, series: null, note: 'Loading forecast…' };
  condMarkerFeature.setGeometry(new ol.geom.Point(coordinate));
  _renderConditionsPopup();
  // Centre the map on the clicked spot, then anchor the popup there
  // (autoPan nudges it into view afterwards if it still overflows).
  const _at = coordinate;
  map.getView().animate({ center: _at, duration: 250 }, () => popup.setPosition(_at));
  const mine = _cond;
  authFetch(ROUTER + '/conditions?lon=' + lon.toFixed(5) + '&lat=' + lat.toFixed(5)
            + '&from=' + encodeURIComponent(hourIso) + '&hours=72&step_h=1', {}, 'conditions')
    .then(r => r.ok ? r.json() : _apiErrorText(r).then(t => Promise.reject(new Error(t))))
    .then(d => {
      if (_cond !== mine) return;   // a newer click replaced this popup
      mine.series = d.series;
      mine.isLand = d.is_land === true;
      mine.tides = d.tides || null;
      mine.tidesError = d.tides_error || null;
      mine.note = (d.truncated && Array.isArray(d.forecast_time_range)
        ? 'Series clipped to the forecast (' + _fmtWhen(d.forecast_time_range[0]) + ' → ' + _fmtWhen(d.forecast_time_range[1]) + '). '
        : '') + 'Click the chart or a row to retime the overlays.'
        + (d.sources && d.sources.currents && d.sources.currents.length ? ' Currents: ' + d.sources.currents.join(', ') + '.' : '');
      _renderConditionsPopup();
    })
    .catch(err => { if (_cond !== mine) return; mine.note = 'Forecast unavailable: ' + err.message; _renderConditionsPopup(); });
}

map.on('singleclick', function(e) {
  if (!e.originalEvent.shiftKey) return;
  hideMapMenu();
  openConditionsAt(e.coordinate, e.pixel);
});

// The popup overlay is closed from several places (× button, plain
// click elsewhere). Drop the conditions marker whenever the popup closes
// or moves off its spot.
popup.on('change:position', () => {
  const g = condMarkerFeature.getGeometry();
  if (!g) return;
  const pos = popup.getPosition();
  const [mx, my] = g.getCoordinates();
  if (!pos || pos[0] !== mx || pos[1] !== my) condMarkerFeature.setGeometry(null);
});

// ─────────── Own vessel (Signal K) + Live mode ───────────
// The vessel marker is drawn from Signal K's own-vessel position every
// 5 s whenever the "Own vessel" layer is on. Live mode additionally
// shows the readout and runs the re-plan triggers (proximity to the
// next via, sustained cross-track error) through the same job API as
// Find Route. Live always starts OFF on page load — explicit opt-in.
(function() {
  function numOr(id, fallback) {
    const el = document.getElementById(id);
    const v = el ? parseFloat(el.value) : NaN;
    return Number.isFinite(v) ? v : fallback;
  }
  const VESSEL_STALE_MS = 30000;
  const MIN_SOG_MS = 0.25;    // below this COG is noise; gate triggers
  const POLL_MS = 5000;

  let liveMode = false;
  let pollInterval = null;
  let lastSnap = null;
  let xteSustainStart = null;
  let lastReplanAt = 0;       // cooldown so we don't spam re-plans
  const REPLAN_COOLDOWN_MS = 15000;

  const btnPlanning = document.getElementById('modeBtnPlanning');
  const btnLive = document.getElementById('modeBtnLive');
  const readoutBody = document.getElementById('liveReadoutBody');
  const readoutStale = document.getElementById('liveReadoutStale');
  const readoutPanel = document.getElementById('liveReadout');
  const banner = document.getElementById('proposalBanner');
  const summaryEl = document.getElementById('proposalSummary');

  const SK_NAV = '/signalk/v1/api/vessels/self/navigation';
  const SK_WIND = '/signalk/v1/api/vessels/self/environment/wind';
  const R2D = 180 / Math.PI;
  function _skVal(node) {
    if (node == null) return null;
    if (typeof node === 'object' && !Array.isArray(node) && 'value' in node) return node.value;
    return node;
  }
  function _skDeg(node) { const v = _skVal(node); return typeof v === 'number' && Number.isFinite(v) ? ((v * R2D) % 360 + 360) % 360 : null; }
  function _skNum(node) { const v = _skVal(node); return typeof v === 'number' && Number.isFinite(v) ? v : null; }
  function _skTs(node) {
    const ts = node && typeof node === 'object' ? node.timestamp : null;
    const t = ts ? Date.parse(ts) : NaN;
    return Number.isFinite(t) ? t / 1000 : null;
  }

  // One snapshot in the shape the sister app's /api/v1/vessel returned:
  // {lat, lon, sog_ms, cog_deg, heading_deg, twa_deg, tws_ms, updated_at}.
  function fetchVesselSnapshot() {
    return authFetch(SK_NAV, { cache: 'no-store' }, 'vessel')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(nav => {
        const pos = _skVal(nav.position);
        const snap = {
          lat: pos && Number.isFinite(pos.latitude) ? pos.latitude : null,
          lon: pos && Number.isFinite(pos.longitude) ? pos.longitude : null,
          sog_ms: _skNum(nav.speedOverGround),
          cog_deg: _skDeg(nav.courseOverGroundTrue),
          heading_deg: _skDeg(nav.headingTrue),
          twa_deg: null, tws_ms: null,
          updated_at: _skTs(nav.position) || (Date.now() / 1000),
        };
        return authFetch(SK_WIND, { cache: 'no-store' }, 'vessel-wind')
          .then(r => r.ok ? r.json() : null)
          .then(w => {
            if (w) {
              const a = _skNum(w.angleTrueWater) != null ? _skNum(w.angleTrueWater) : _skNum(w.angleTrueGround);
              if (a != null) snap.twa_deg = Math.abs(a * R2D);
              snap.tws_ms = _skNum(w.speedTrue);
            }
            return snap;
          })
          .catch(() => snap);
      });
  }

  function setVisual() {
    btnPlanning.classList.toggle('live-active', !liveMode);
    btnLive.classList.toggle('live-active', liveMode);
    btnPlanning.classList.toggle('live-on', false);
    btnLive.classList.toggle('live-on', liveMode);
    btnPlanning.setAttribute('aria-pressed', String(!liveMode));
    btnLive.setAttribute('aria-pressed', String(liveMode));
    readoutPanel.style.display = liveMode ? '' : 'none';
  }

  function startPolling() {
    if (pollInterval) return;
    pollInterval = setInterval(poll, POLL_MS);
    poll();   // kick immediately so the marker lands before the first tick.
  }
  function stopPolling() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  }

  function startLive() {
    if (liveMode) return;
    liveMode = true;
    setVisual();
    readoutBody.textContent = 'connecting…';
    startPolling();
    poll();
  }

  function stopLive() {
    liveMode = false;
    setVisual();
    lastSnap = null;
    xteSustainStart = null;
    dismissProposal();
  }
  AuthGate.onStop(() => { stopLive(); stopPolling(); });
  window.addEventListener('rp:units', () => { if (lastSnap && liveMode) renderReadout(lastSnap); });

  let _pollFails = 0;
  function poll() {
    if (AuthGate.tripped) return;
    fetchVesselSnapshot()
      .then(snap => {
        _pollFails = 0;
        lastSnap = snap;
        if (liveMode) renderReadout(snap);
        renderMarker(snap);
        evaluateTriggers(snap);
      })
      .catch(err => {
        if (err && err.name === 'AbortError') return;
        _pollFails++;
        if (liveMode && _pollFails >= 3) { readoutBody.textContent = 'no Signal K position (' + err.message + ')'; readoutStale.style.display = ''; }
      });
  }

  function renderReadout(snap) {
    const age = snap.updated_at ? (Date.now() / 1000 - snap.updated_at) : 9999;
    const stale = age * 1000 > VESSEL_STALE_MS;
    readoutStale.style.display = stale ? '' : 'none';
    const fmt = (v, n, u) => (v == null ? '—' : v.toFixed(n) + u);
    readoutBody.innerHTML =
      (snap.lat != null && snap.lon != null
        ? `${snap.lat.toFixed(4)}, ${snap.lon.toFixed(4)}`
        : '—') +
      `<br>SOG ${fmtSpeed(snap.sog_ms) || '—'} · COG ${fmt(snap.cog_deg, 0, '°')}` +
      (snap.heading_deg != null ? ` · HDG ${fmt(snap.heading_deg, 0, '°')}` : '') +
      `<br>TWA ${fmt(snap.twa_deg, 0, '°')} · TWS ${fmtSpeed(snap.tws_ms) || '—'}`;
  }

  function renderMarker(snap) {
    if (snap.lat == null || snap.lon == null) return;
    const coord = ol.proj.fromLonLat([snap.lon, snap.lat]);
    const rot_deg = snap.heading_deg != null ? snap.heading_deg
                    : (snap.cog_deg != null ? snap.cog_deg : 0);
    const existing = vesselMarkerSource.getFeatures()[0];
    if (existing) {
      existing.setGeometry(new ol.geom.Point(coord));
      existing.set('rotation_rad', rot_deg * Math.PI / 180);
      existing.changed();
    } else {
      const f = new ol.Feature({ geometry: new ol.geom.Point(coord) });
      f.set('rotation_rad', rot_deg * Math.PI / 180);
      vesselMarkerSource.addFeature(f);
    }
    // First visit with no saved view: open the map on the boat.
    if (_autoCentreOnVessel) {
      _autoCentreOnVessel = false;
      _geoPending = false;
      map.getView().animate({ center: coord, zoom: 11, duration: 400 });
    }
  }

  // ── trigger logic ────────────────────────────────────────────────
  function evaluateTriggers(snap) {
    if (!liveMode || !routeActive) return;
    if (snap.lat == null || snap.lon == null) return;
    const age = snap.updated_at ? (Date.now() / 1000 - snap.updated_at) : 9999;
    if (age * 1000 > VESSEL_STALE_MS) return;              // stale data
    if ((snap.sog_ms ?? 0) < MIN_SOG_MS) { xteSustainStart = null; return; }
    if (Date.now() - lastReplanAt < REPLAN_COOLDOWN_MS) return;
    if (_routeComputing) return;

    const vesselLonLat = [snap.lon, snap.lat];

    const proxM = numOr('proximityRadiusM', 200);
    const xteM_thresh = numOr('xteThresholdM', 500);
    const xteSustainMs = numOr('xteSustainSec', 30) * 1000;

    // Proximity trigger: within X m of the next unvisited user via.
    const nextVia = nextRemainingVia(vesselLonLat);
    if (nextVia) {
      const d = haversineM(vesselLonLat, nextVia);
      if (d <= proxM) {
        fireReplan(vesselLonLat, `Within ${proxM.toFixed(0)} m of next waypoint`);
        return;
      }
    }

    // Cross-track trigger: sustained XTE > threshold.
    const xteM = xteToActiveRoute(vesselLonLat);
    if (xteM != null && xteM > xteM_thresh) {
      if (xteSustainStart == null) xteSustainStart = Date.now();
      if (Date.now() - xteSustainStart >= xteSustainMs) {
        fireReplan(vesselLonLat, `Off course by ${xteM.toFixed(0)} m`);
        return;
      }
    } else {
      xteSustainStart = null;
    }
  }

  // Walk the Point features of the active route that are tagged
  // role="via"; return the next one ahead of the vessel (by index),
  // or null if none remain.
  function nextRemainingVia(vesselLonLat) {
    const feats = routeSource.getFeatures().filter(
      f => f.getGeometry().getType() === 'Point');
    const vias = feats.filter(f => f.get('role') === 'via');
    if (vias.length === 0) return null;
    let nearestIdx = -1, nearestD = Infinity;
    feats.forEach((f, i) => {
      const c = ol.proj.toLonLat(f.getGeometry().getCoordinates());
      const d = haversineM(vesselLonLat, c);
      if (d < nearestD) { nearestD = d; nearestIdx = i; }
    });
    for (const v of vias) {
      const globalIdx = feats.indexOf(v);
      if (globalIdx > nearestIdx) {
        return ol.proj.toLonLat(v.getGeometry().getCoordinates());
      }
    }
    return null;
  }

  // Cross-track distance from the active route (min perpendicular
  // distance across all legs, flat-earth metres).
  function xteToActiveRoute(lonLat) {
    const coords = routeSource.getFeatures()
      .filter(f => f.getGeometry().getType() === 'Point')
      .map(f => ol.proj.toLonLat(f.getGeometry().getCoordinates()));
    if (coords.length < 2) return null;
    let minD = Infinity;
    for (let i = 0; i < coords.length - 1; i++) {
      const d = perpendicularM(lonLat, coords[i], coords[i + 1]);
      if (d < minD) minD = d;
    }
    return minD;
  }

  function haversineM(a, b) {
    const R = 6371000;
    const toRad = x => x * Math.PI / 180;
    const dLat = toRad(b[1] - a[1]);
    const dLon = toRad(b[0] - a[0]);
    const la1 = toRad(a[1]);
    const la2 = toRad(b[1]);
    const h = Math.sin(dLat / 2) ** 2
            + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Perpendicular distance (m) from point P to the segment A-B.
  function perpendicularM(p, a, b) {
    const cosLat = Math.cos(a[1] * Math.PI / 180);
    const mPerDegLon = 111320 * cosLat;
    const mPerDegLat = 110540;
    const ax = 0, ay = 0;
    const bx = (b[0] - a[0]) * mPerDegLon, by = (b[1] - a[1]) * mPerDegLat;
    const px = (p[0] - a[0]) * mPerDegLon, py = (p[1] - a[1]) * mPerDegLat;
    const segLen2 = bx * bx + by * by;
    if (segLen2 === 0) return Math.hypot(px, py);
    let t = (px * bx + py * by) / segLen2;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * bx, qy = ay + t * by;
    return Math.hypot(px - qx, py - qy);
  }

  // ── re-plan flow (job API) ─────────────────────────────────
  function fireReplan(vesselLonLat, reason) {
    lastReplanAt = Date.now();
    xteSustainStart = null;
    // Collect remaining vias ahead of the vessel.
    const vias = [];
    const feats = routeSource.getFeatures().filter(
      f => f.getGeometry().getType() === 'Point');
    let nearestIdx = -1, nearestD = Infinity;
    feats.forEach((f, i) => {
      const c = ol.proj.toLonLat(f.getGeometry().getCoordinates());
      const d = haversineM(vesselLonLat, c);
      if (d < nearestD) { nearestD = d; nearestIdx = i; }
    });
    feats.forEach((f, i) => {
      if (i > nearestIdx && f.get('role') === 'via') {
        const c = ol.proj.toLonLat(f.getGeometry().getCoordinates());
        vias.push({ lat: c[1], lon: c[0] });
      }
    });

    const payload = buildRoutePayload({
      start: vesselLonLat,
      waypoints: vias,
      departure: new Date().toISOString(),
    });
    payload.name = (payload.name ? payload.name + ' ' : '') + '(re-plan)';
    payload.publish = false;

    summaryEl.innerHTML = `<span style="color:#ffcf7a">${escapeForHtml(reason)}</span><br>Computing re-plan…`;
    banner.style.display = '';
    appendLog(`[re-plan] ${reason}`, 'done');
    showTab('logSection');

    let jobId = null;
    authFetch(ROUTER + '/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, null)
    .then(r => r.ok ? r.json() : _apiErrorText(r).then(t => Promise.reject(new Error(t))))
    .then(job => { jobId = job.id; return streamJobUntilDone(job.id); })
    .then(id => authFetch(ROUTER + '/routes/' + encodeURIComponent(id) + '/result', { cache: 'no-store' }, null))
    .then(r => r.ok ? r.json() : _apiErrorText(r).then(t => Promise.reject(new Error(t))))
    .then(geojson => { renderProposal(geojson, reason); banner.dataset.jobId = jobId; loadRouteHistory(); })
    .catch(err => {
      summaryEl.innerHTML =
        `<span style="color:#ff9090">Re-plan failed: ${escapeForHtml(err.message)}</span>`;
      appendLog(`[re-plan] FAILED: ${err.message}`, 'error');
    });
  }

  // Subscribe to the per-job SSE stream, tee progress into the Log
  // panel (prefixed so it's distinguishable from Find Route output), and
  // resolve on `done` / reject on `error`.
  function streamJobUntilDone(jobId) {
    return new Promise((resolve, reject) => {
      const url = ROUTER + '/routes/' + encodeURIComponent(jobId) + '/events';
      const es = _activeReplanES = new EventSource(url, { withCredentials: true });
      const deadline = Date.now() + 600000;
      let settled = false;
      const tick = setInterval(() => {
        if (Date.now() > deadline && !settled) {
          settled = true;
          clearInterval(tick); es.close();
          reject(new Error('re-plan timeout'));
        }
      }, 2000);
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearInterval(tick); es.close();
        if (_activeReplanES === es) _activeReplanES = null;
        fn(arg);
      };
      es.addEventListener('progress', (ev) => {
        try {
          const d = JSON.parse(ev.data);
          if (d && d.message) appendLog('  [re-plan] ' + (d.total ? '[' + d.stage + '/' + d.total + '] ' : '') + d.message);
        } catch (_) { /* ignore */ }
      });
      es.addEventListener('status', (ev) => {
        try {
          const d = JSON.parse(ev.data);
          if (d && d.status) appendLog('[re-plan] status: ' + d.status);
        } catch (_) { /* ignore */ }
      });
      es.addEventListener('done', () => {
        appendLog('[re-plan] done', 'done');
        finish(resolve, jobId);
      });
      // Server-pushed `event: error` — always terminal; always rejects.
      es.addEventListener('error', (ev) => {
        let msg = 'compute error';
        try {
          const d = ev && ev.data ? JSON.parse(ev.data) : null;
          if (d && d.message) msg = d.message;
        } catch (_) { /* ignore */ }
        // Native EventSource connection drops fire `error` with no
        // data. Those might be transient — let the browser retry
        // unless it has given up.
        if (!ev || !ev.data) {
          if (es.readyState === EventSource.CLOSED) finish(reject, new Error('event stream closed'));
          return;
        }
        finish(reject, new Error(msg));
      });
    });
  }

  function renderProposal(geojson, reason) {
    proposedRouteSource.clear();
    const features = new ol.format.GeoJSON().readFeatures(geojson, {
      featureProjection: 'EPSG:3857',
    });
    // Only the LineString is drawn dashed on the proposed layer;
    // points would clutter at this density.
    const line = features.find(f => f.getGeometry().getType() === 'LineString');
    if (line) proposedRouteSource.addFeature(line);
    banner.style.display = '';
    banner.dataset.geojson = JSON.stringify(geojson);
    banner.dataset.reason = reason;

    // Diff summary: vs the currently-active route.
    const newProps = line ? line.getProperties() : {};
    const oldProps = _lastRouteProps || {};
    const distOld = oldProps.total_distance_m, distNew = newProps.total_distance_m;
    const arrivalOld = oldProps.arrival, arrivalNew = newProps.arrival;
    const fmtArr = s => s == null ? '—' : new Date(s).toLocaleString();
    const fmtDistOrDash = m => m == null ? '—' : fmtDist(m);
    summaryEl.innerHTML =
      `<span style="color:#ffcf7a">${escapeForHtml(reason)}</span>` +
      `<br>Distance: ${fmtDistOrDash(distOld)} → ${fmtDistOrDash(distNew)}` +
      `<br>Arrival:  ${fmtArr(arrivalOld)} → ${fmtArr(arrivalNew)}`;
  }

  function acceptProposal() {
    const raw = banner.dataset.geojson;
    if (!raw) { dismissProposal(); return; }
    try {
      const geojson = JSON.parse(raw);
      if (banner.dataset.jobId) { _currentRouteJobId = banner.dataset.jobId; }
      displayRoute(geojson);    // replaces active route wholesale
      routeActive = true;
      _routeStale = false;
      updatePlanHint();
    } catch (e) { /* ignore */ }
    dismissProposal();
  }

  function dismissProposal() {
    proposedRouteSource.clear();
    banner.style.display = 'none';
    delete banner.dataset.geojson;
    delete banner.dataset.reason;
    delete banner.dataset.jobId;
  }

  function escapeForHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── wiring ───────────────────────────────────────────────────────
  btnPlanning.addEventListener('click', () => stopLive());
  btnLive.addEventListener('click', () => startLive());
  document.getElementById('proposalAccept').addEventListener('click', acceptProposal);
  document.getElementById('proposalDismiss').addEventListener('click', dismissProposal);

  // When the user clicks Find Route while Live is on, implicitly turn
  // Live off — they're starting a new route from scratch.
  document.getElementById('findRoute').addEventListener('click', () => {
    if (liveMode) stopLive();
  });

  // User drags the start/end marker while Live is on → start is no
  // longer the vessel's current position; exit Live.
  if (typeof modify !== 'undefined') {
    modify.on('modifyend', (e) => {
      if (!liveMode) return;
      const touched = e.features.getArray
        ? e.features.getArray() : e.features;
      for (const f of touched) {
        const n = f.get('name');
        if (n === 'start' || n === 'end') { stopLive(); break; }
      }
    });
  }
  const origResetBtn = document.getElementById('resetBtn');
  if (origResetBtn) {
    origResetBtn.addEventListener('click', () => { if (liveMode) stopLive(); });
  }

  // The marker poll runs whenever the Own-vessel layer is on.
  const vesselToggle = document.getElementById('vesselToggle');
  function syncPolling() {
    if ((vesselToggle && vesselToggle.checked) || liveMode) startPolling();
    else { stopPolling(); vesselMarkerSource.clear(); }
  }
  if (vesselToggle) vesselToggle.addEventListener('change', syncPolling);
  window.addEventListener('load', syncPolling);
  syncPolling();
})();
