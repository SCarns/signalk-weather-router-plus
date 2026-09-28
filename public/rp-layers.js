// Weather Router Plus — route planner UI, part 2 of 3 (map layers).
// Markers, route styling, weather/water overlays (JSON grids drawn on
// canvas in place of the routing server's PNG tiles), streamlines,
// pressure, and the map itself.

const markerSource = new ol.source.Vector({
  features: [startFeature, endFeature]
});

const markerStyle = function(feature) {
  const name = feature.get('name');
  if (!feature.getGeometry()) return null;
  let color, label;
  if (name === 'start') {
    color = '#4CAF50'; label = 'S';
  } else if (name === 'end') {
    color = '#F44336'; label = 'E';
  } else {
    // waypoint
    color = '#FF9800';
    label = 'W' + (feature.get('waypoint_index') + 1);
  }
  return new ol.style.Style({
    image: new ol.style.Circle({
      radius: 10,
      fill: new ol.style.Fill({ color: color }),
      stroke: new ol.style.Stroke({ color: '#fff', width: 2 })
    }),
    text: new ol.style.Text({
      text: label,
      fill: new ol.style.Fill({ color: '#fff' }),
      font: 'bold 11px sans-serif'
    })
  });
};

const markerLayer = new ol.layer.Vector({
  source: markerSource,
  style: markerStyle,
  zIndex: 20
});

// --- Route layer ---
const routeLayer = new ol.layer.Vector({
  source: routeSource,
  style: function(feature) {
    const geomType = feature.getGeometry().getType();
    if (geomType === 'LineString') {
      return feature.getStyle();
    }
    if (geomType === 'Point') {
      const mode = feature.get('mode');
      const cog = feature.get('cog_deg');
      const outCog = feature.get('outgoing_cog');
      const windDir = feature.get('wind_dir_deg');
      // Chevron direction: outgoing_cog (forward-looking)
      const displayCog = outCog != null ? outCog : cog;
      // Tack color: based on NEXT segment's data (forward-looking)
      const nextMode = feature.get('next_mode');
      const nextCog = feature.get('next_cog');
      const nextWind = feature.get('next_wind');
      // Colors match the itinerary-card accents:
      //   sailing/starboard = #2E7D32, sailing/port = #D32F2F,
      //   motoring = #fc4 (amber), arrival (last waypoint) = #88f (blue).
      let color;
      if (nextMode != null) {
        if (nextMode === 'sailing') {
          // Starboard when cog or wind is missing.
          color = TACK_COLOR[tackSide(nextCog, nextWind) || 'starboard'];
        } else {
          color = '#fc4';   // motoring
        }
      } else {
        // Last waypoint (arrival) — blue.
        color = '#88f';
      }
      const styles = [];
      const isSelected = (feature === _selectedRouteFeature);
      // Selection halo — bright cyan double-ring with soft tint.
      if (isSelected) {
        styles.push(new ol.style.Style({
          image: new ol.style.Circle({
            radius: 28,
            fill: new ol.style.Fill({ color: 'rgba(0,229,255,0.18)' }),
            stroke: new ol.style.Stroke({ color: '#00e5ff', width: 3 })
          }),
          zIndex: 8,
        }));
        styles.push(new ol.style.Style({
          image: new ol.style.Circle({
            radius: 22,
            fill: new ol.style.Fill({ color: 'rgba(255,255,255,0)' }),
            stroke: new ol.style.Stroke({ color: '#fff', width: 2 })
          }),
          zIndex: 9,
        }));
      }
      // Circle ring at waypoint — radius matches chevron tail length
      styles.push(new ol.style.Style({
        image: new ol.style.Circle({
          radius: 16,
          fill: new ol.style.Fill({ color: 'rgba(255,255,255,0)' }),
          stroke: new ol.style.Stroke({ color: color, width: isSelected ? 5 : 2 })
        }),
        zIndex: 10,
      }));
      // Vessel heading arrow (SVG: shaft + notched arrowhead, points up by default)
      if (displayCog != null) {
        const vesselSvg = '<svg width="20" height="32" viewBox="0 0 20 32" xmlns="http://www.w3.org/2000/svg">' +
          '<rect x="8" y="12" width="4" height="20" fill="' + color + '"/>' +
          '<path d="M10,0 L2,14 L10,10 L18,14 Z" fill="' + color + '"/>' +
          '</svg>';
        styles.push(new ol.style.Style({
          image: new ol.style.Icon({
            src: 'data:image/svg+xml;utf8,' + encodeURIComponent(vesselSvg),
            anchor: [0.5, 0.5],
            rotation: displayCog * Math.PI / 180,
            scale: 1,
          })
        }));
      } else {
        styles.push(new ol.style.Style({
          image: new ol.style.Circle({
            radius: 4,
            fill: new ol.style.Fill({ color: '#333' }),
            stroke: new ol.style.Stroke({ color: '#fff', width: 1 })
          })
        }));
      }
      // Wind arrow (blue SVG arrow, offset upwind, points where wind blows TO)
      if (windDir != null) {
        const windToRad = ((windDir + 180) % 360) * Math.PI / 180;
        const offsetRad = windDir * Math.PI / 180;
        const windSvg = '<svg width="16" height="28" viewBox="0 0 16 28" xmlns="http://www.w3.org/2000/svg">' +
          '<rect x="6" y="10" width="4" height="18" fill="%231565C0"/>' +
          '<path d="M8,0 L1,12 L8,9 L15,12 Z" fill="%231565C0"/>' +
          '</svg>';
        styles.push(new ol.style.Style({
          image: new ol.style.Icon({
            src: 'data:image/svg+xml;utf8,' + encodeURIComponent(windSvg),
            anchor: [0.5, 0.5],
            rotation: windToRad,
            displacement: [Math.sin(offsetRad) * 22, Math.cos(offsetRad) * 22],
            scale: 1,
          }),
          zIndex: 20,
        }));
      }
      return styles;
    }
  },
  zIndex: 15
});

// --- Skeleton layer (A* presumptive route, blue) ---
const skeletonLayer = new ol.layer.Vector({
  source: skeletonSource,
  style: new ol.style.Style({
    stroke: new ol.style.Stroke({ color: '#2060cc', width: 2, lineDash: [8, 4] })
  }),
  zIndex: 16
});

// --- Proposed-route layer (Live mode re-plan preview, dashed purple) ---
// Drawn alongside the active route while the user decides Accept/Dismiss.
const proposedRouteSource = new ol.source.Vector();
const proposedRouteLayer = new ol.layer.Vector({
  source: proposedRouteSource,
  style: function(feature) {
    if (feature.getGeometry().getType() !== 'LineString') return null;
    return new ol.style.Style({
      stroke: new ol.style.Stroke({
        color: 'rgba(142, 36, 170, 0.75)',   // translucent purple
        width: 4,
        lineDash: [10, 6],
      }),
    });
  },
  zIndex: 17,
});

// --- Vessel marker layer (own boat from Signal K) ---
// Rotated to headingTrue when available, else COG. Rendered on top of
// route/skeleton but below the start/end pin markers so dragging pins
// stays unambiguous.
const vesselMarkerSource = new ol.source.Vector();
const vesselMarkerLayer = new ol.layer.Vector({
  source: vesselMarkerSource,
  style: function(feature) {
    const rot = feature.get('rotation_rad') || 0;
    // Boat-arrow SVG: black outline for visibility on any base map,
    // cyan fill matching the selected-waypoint halo color family.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="40" viewBox="0 0 28 40">' +
      '<path d="M14,1 L26,36 L14,30 L2,36 Z" ' +
      'fill="#00e5ff" stroke="#003a43" stroke-width="1.8" stroke-linejoin="round"/>' +
      '</svg>';
    return new ol.style.Style({
      image: new ol.style.Icon({
        src: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg),
        anchor: [0.5, 0.5],
        rotation: rot,
      }),
      zIndex: 19,
    });
  },
  zIndex: 19,
});

// --- Conditions-point marker ---
// Target ring at the spot the conditions popup describes (shift-click
// or "Conditions here"). Set in openConditionsAt; cleared by the
// popup position listener there whenever the popup closes or moves.
const condMarkerFeature = new ol.Feature();
const condMarkerSource = new ol.source.Vector({ features: [condMarkerFeature] });
const condMarkerLayer = new ol.layer.Vector({
  source: condMarkerSource,
  style: function(feature) {
    if (!feature.getGeometry()) return null;
    return [
      new ol.style.Style({
        image: new ol.style.Circle({
          radius: 11,
          stroke: new ol.style.Stroke({ color: '#fff', width: 5 }),
        }),
      }),
      new ol.style.Style({
        image: new ol.style.Circle({
          radius: 11,
          stroke: new ol.style.Stroke({ color: '#ad1457', width: 3 }),
        }),
      }),
      new ol.style.Style({
        image: new ol.style.Circle({
          radius: 3.5,
          fill: new ol.style.Fill({ color: '#ad1457' }),
          stroke: new ol.style.Stroke({ color: '#fff', width: 1.5 }),
        }),
      }),
    ];
  },
  zIndex: 21,
});

// OpenStreetMap — the base map. Tiles come from the internet (the
// document's origin-only referrer meta keeps OSM happy behind Signal K's
// no-referrer policy).
const osmLayer = new ol.layer.Tile({
  source: new ol.source.OSM(),
  opacity: 0.6,
  zIndex: 0,
  visible: true,
});

// OpenSeaMap seamarks — buoys, lights, marks — as transparent tiles
// drawn over the base map. Layer minZoom keeps it from rendering when
// zoomed out (fetch-flood rule).
const seamarkLayer = new ol.layer.Tile({
  source: new ol.source.XYZ({
    url: 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
    attributions: '&copy; <a href="https://www.openseamap.org/">OpenSeaMap</a> contributors',
    crossOrigin: 'anonymous',
    maxZoom: 18,
  }),
  zIndex: 2,
  minZoom: 8,
  visible: true,
});

// ─────────── Shared overlay helpers ───────────
// The time every overlay is drawn for: a clicked waypoint / conditions
// hour when set, else the departure input.
let _currentTimeOverride = null;  // set when clicking a waypoint or a conditions hour
function _overlayTimeIso() {
  if (_currentTimeOverride) return _currentTimeOverride;
  const depEl = document.getElementById('departure');
  return depEl.value ? new Date(depEl.value).toISOString() : new Date().toISOString();
}
// Viewport as [w, s, e, n] in degrees, latitudes clamped to ±85 and a
// dateline-crossing view expressed with e > 180 (the plugin accepts
// longitudes in [-180, 360]).
function _viewBBox() {
  const view = map.getView();
  const extent = view.calculateExtent(map.getSize());
  let [w, s] = ol.proj.toLonLat([extent[0], extent[1]]);
  let [e, n] = ol.proj.toLonLat([extent[2], extent[3]]);
  s = Math.max(-85, s); n = Math.min(85, n);
  if (extent[2] - extent[0] >= 40075016) { w = -180; e = 180; }
  else if (e < w) e += 360;
  return [w, s, e, n];
}
// Per-layer notes ("no wave data in the forecast") shown in the legend
// box next to the layer that could not load.
const _overlayNotes = {};
function _noteOverlay(key, msg) {
  if (msg) _overlayNotes[key] = msg; else delete _overlayNotes[key];
  if (typeof updateLegends === 'function') updateLegends();
}
function _bboxParam(b) { return b.map(v => +v.toFixed(5)).join(','); }

// --- Tidal current overlay ---
const currentSource = new ol.source.Vector();

// Pre-build current arrow styles to avoid icon cache thrashing
const _currentStyleCache = new Map();
// Arrow colour classes, lower bound in knots. Shared with the legend.
const CURRENT_ARROW_CLASSES = [
  [0,   'rgba(0,200,140,0.85)'], [0.5, 'rgba(180,180,0,0.85)'],
  [1.0, 'rgba(220,140,0,0.85)'], [1.5, 'rgba(220,40,40,0.9)'],
];
function _currentColor(speed) {
  let c = CURRENT_ARROW_CLASSES[0][1];
  for (const [lo, color] of CURRENT_ARROW_CLASSES) if (speed >= lo) c = color;
  return c;
}
const SLACK_KT = 0.05;  // below this, render as a pause symbol
function _currentStyle(feature) {
  const speedMs = feature.get('speed_ms') || 0;
  const speed = speedMs / MS_PER_KT;  // display thresholds are in kts
  const dirDeg = feature.get('dir_deg') || 0;
  const color = _currentColor(speed);

  if (speed < SLACK_KT) {
    const key = 'slack|' + color;
    if (_currentStyleCache.has(key)) return _currentStyleCache.get(key);
    const pauseSvg = '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' +
      '<rect x="4" y="3" width="2.5" height="10" fill="' + color + '"/>' +
      '<rect x="9.5" y="3" width="2.5" height="10" fill="' + color + '"/></svg>';
    const style = new ol.style.Style({
      image: new ol.style.Icon({
        src: 'data:image/svg+xml;utf8,' + encodeURIComponent(pauseSvg),
        anchor: [0.5, 0.5],
        scale: 0.7,
      }),
      zIndex: 8,
    });
    _currentStyleCache.set(key, style);
    return style;
  }

  // Quantize to reduce unique styles: direction to 5°, speed to color bucket
  const dirQ = Math.round(dirDeg / 5) * 5;
  const key = color + '|' + dirQ;
  if (_currentStyleCache.has(key)) return _currentStyleCache.get(key);
  const dirRad = dirQ * Math.PI / 180;
  const scale = Math.max(0.4, Math.min(0.8, speed * 0.7 + 0.27));
  const svg = '<svg width="16" height="32" viewBox="0 0 16 32" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="6" y="12" width="4" height="20" fill="' + color + '"/>' +
    '<path d="M8,0 L1,14 L8,10 L15,14 Z" fill="' + color + '"/></svg>';
  const style = new ol.style.Style({
    image: new ol.style.Icon({
      src: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg),
      anchor: [0.5, 0.5],
      rotation: dirRad,
      scale: scale,
    }),
    zIndex: 8,
  });
  _currentStyleCache.set(key, style);
  return style;
}

const currentLayer = new ol.layer.Vector({
  source: currentSource,
  declutter: false,
  style: _currentStyle,
  zIndex: 8
});

let _currentDebounce = null;
function loadCurrentOverlay() {
  if (!currentLayer.getVisible()) return;
  if (_currentDebounce) clearTimeout(_currentDebounce);
  _currentDebounce = setTimeout(_doLoadCurrents, 300);
}

function _doLoadCurrents() {
  const view = map.getView();
  const zoom = view.getZoom();
  const bbox = _viewBBox();

  // Resolution: ~0.02° at zoom 12, ~0.01° at zoom 14, ~0.005° at zoom 16
  const res = Math.min(5, Math.max(0.005, 0.3 / Math.pow(2, zoom - 8)));
  const timeStr = _overlayTimeIso();

  authFetch(ROUTER + `/currents?bbox=${_bboxParam(bbox)}&time=${encodeURIComponent(timeStr)}&res=${res}`, {}, 'currents')
    .then(r => r.ok ? r.json() : _apiErrorText(r).then(t => Promise.reject(new Error(t))))
    .then(points => {
      currentSource.clear();
      _noteOverlay('currentToggle', null);
      if (!Array.isArray(points) || points.length === 0) return;
      const features = points.map(p => {
        const f = new ol.Feature({
          geometry: new ol.geom.Point(ol.proj.fromLonLat([p.lon, p.lat]))
        });
        f.set('speed_ms', p.speed_ms);
        f.set('dir_deg', p.dir_deg);
        f.set('u_ms', p.u_ms);
        f.set('v_ms', p.v_ms);
        return f;
      });
      currentSource.addFeatures(features);
    }).catch(e => { if (e.name !== 'AbortError') { console.log('Current overlay error: ' + e); _noteOverlay('currentToggle', e.message); } });
}

// Refresh currents when departure time changes
document.getElementById('departure').addEventListener('change', function() {
  loadCurrentOverlay();
});


// ─────────── Wind barb overlay ───────────
// Classic meteorological wind barb rendering: staff points toward the
// wind source (FROM direction); feathers on one side of the staff
// encode speed — a pennant = 50 kt, a long feather = 10 kt, a half
// feather = 5 kt. Below ~2.5 kt we draw an open circle (calm). Color
// codes speed on a cool→warm ramp so a glance tells wind strength
// without reading the feathers.
const windSource = new ol.source.Vector();
const _windStyleCache = new Map();

// Barb colour classes, lower bound in knots. Shared with the legend.
const WIND_BARB_CLASSES = [
  [0,  '#90CAF9', 'very light'], [5,  '#4FC3F7', 'light'], [10, '#00897B', 'moderate'],
  [15, '#43A047', 'fresh'], [20, '#F9A825', 'strong'], [25, '#E64A19', 'near gale'],
  [30, '#C62828', 'gale+'],
];
function _windColor(kts) {
  let c = WIND_BARB_CLASSES[0][1];
  for (const [lo, color] of WIND_BARB_CLASSES) if (kts >= lo) c = color;
  return c;
}

function _windBarbSvg(speedKts, color) {
  // Canvas: 44 high × 28 wide. Plot point at (14, 38). Staff goes up
  // to (14, 4). Feathers stick out to the LEFT of the staff (WMO
  // northern-hemisphere convention).
  const W = 28, H = 44;
  const sx = 14;        // staff x
  const staffTopY = 4;  // staff tip
  const anchorY = 38;   // plot point (bottom)
  const parts = ['<svg width="', W, '" height="', H,
    '" viewBox="0 0 ', W, ' ', H, '" xmlns="http://www.w3.org/2000/svg">'];

  if (speedKts < 2.5) {
    // Calm: open circle at the plot point.
    parts.push('<circle cx="', sx, '" cy="', anchorY - 4,
      '" r="4" fill="none" stroke="', color, '" stroke-width="1.5"/>');
    parts.push('</svg>');
    return parts.join('');
  }

  // Round to nearest 5 kt.
  let remain = Math.round(speedKts / 5) * 5;
  // Staff.
  parts.push('<line x1="', sx, '" y1="', anchorY, '" x2="', sx,
    '" y2="', staffTopY, '" stroke="', color, '" stroke-width="1.8"/>');

  // Draw features from the tip of the staff inward toward the plot.
  let y = staffTopY;
  const FEATHER_STEP = 4;    // spacing between feathers along staff
  const FEATHER_LEN = 10;    // horizontal feather length
  const HALF_LEN = 5;

  // 50 kt pennants first (triangular flags).
  while (remain >= 50) {
    parts.push('<polygon points="',
      sx, ',', y, ' ',
      sx, ',', y + FEATHER_STEP, ' ',
      sx - FEATHER_LEN, ',', y + FEATHER_STEP / 2,
      '" fill="', color, '"/>');
    y += FEATHER_STEP + 1;
    remain -= 50;
  }
  // 10 kt full feathers. Feather slants BACK toward the plot point
  // (WMO convention — "drawn obliquely toward lower pressure").
  while (remain >= 10) {
    parts.push('<line x1="', sx, '" y1="', y,
      '" x2="', sx - FEATHER_LEN, '" y2="', y + 3,
      '" stroke="', color, '" stroke-width="1.8"/>');
    y += FEATHER_STEP;
    remain -= 10;
  }
  // 5 kt half feather. Convention: a lone half feather sits one step
  // in from the tip, not at it. We only get here with remain in {0, 5}.
  if (remain >= 5) {
    if (y === staffTopY) y += FEATHER_STEP;
    parts.push('<line x1="', sx, '" y1="', y,
      '" x2="', sx - HALF_LEN, '" y2="', y + 1.5,
      '" stroke="', color, '" stroke-width="1.8"/>');
  }

  parts.push('</svg>');
  return parts.join('');
}

function _windStyle(feature) {
  const speedMs = feature.get('speed_ms') || 0;
  const kts = speedMs / MS_PER_KT;
  // From-direction: meteorological convention. Staff points at the
  // source, so rotation = dirDeg (with north = 0 matching our SVG's
  // up-pointing staff).
  const dirDeg = feature.get('dir_deg') || 0;
  const color = _windColor(kts);

  // Quantize to reduce unique styles: speed to nearest 5 kt, direction
  // to 5°. One Icon per (speed, dir, color) bucket.
  const speedQ = Math.round(kts / 5) * 5;
  const dirQ = Math.round(dirDeg / 5) * 5;
  const key = speedQ + '|' + dirQ + '|' + color;
  if (_windStyleCache.has(key)) return _windStyleCache.get(key);
  const svg = _windBarbSvg(speedQ, color);
  const style = new ol.style.Style({
    image: new ol.style.Icon({
      src: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg),
      anchor: [0.5, 38 / 44],   // plot point is near the bottom of the SVG
      rotation: dirQ * Math.PI / 180,
      scale: 1,
    }),
    zIndex: 7,
  });
  _windStyleCache.set(key, style);
  return style;
}

const windLayer = new ol.layer.Vector({
  source: windSource,
  declutter: false,
  style: _windStyle,
  zIndex: 7,
  visible: false,
});

let _windDebounce = null;
function loadWindOverlay() {
  if (!windLayer.getVisible()) return;
  if (_windDebounce) clearTimeout(_windDebounce);
  _windDebounce = setTimeout(_doLoadWind, 300);
}

function _doLoadWind() {
  const view = map.getView();
  const zoom = view.getZoom();
  const bbox = _viewBBox();

  // ECMWF is 0.25°. Barbs are chunky so we sample much sparser
  // than currents: ~0.4° at z6, ~0.1° at z10, ~0.02° at z14+.
  const res = Math.min(5, Math.max(0.02, 0.8 / Math.pow(2, zoom - 6)));
  const timeStr = _overlayTimeIso();
  authFetch(ROUTER + `/wind-points?bbox=${_bboxParam(bbox)}&time=${encodeURIComponent(timeStr)}&res=${res}`, {}, 'wind')
    .then(r => r.ok ? r.json() : _apiErrorText(r).then(t => Promise.reject(new Error(t))))
    .then(points => {
      windSource.clear();
      _noteOverlay('windToggle', null);
      if (!Array.isArray(points) || points.length === 0) return;
      const features = points.map(p => {
        const f = new ol.Feature({
          geometry: new ol.geom.Point(ol.proj.fromLonLat([p.lon, p.lat]))
        });
        f.set('speed_ms', p.speed_ms);
        f.set('dir_deg', p.dir_deg);
        return f;
      });
      windSource.addFeatures(features);
    })
    .catch(err => { if (err.name !== 'AbortError') { console.log('Wind overlay error: ' + err); _noteOverlay('windToggle', err.message); } });
}

document.getElementById('departure').addEventListener('change', function() {
  loadWindOverlay();
  loadWindHeatmap();
  loadCurrentHeatmap();
  loadRoughness();
  loadWaveHeatmap();
  loadPrecipHeatmap();
  loadTemperature();
  loadSst();
  loadPressure();
  if (waveStreamlines.enabled) waveStreamlines._fetchField();
  if (windStreamlines.enabled) windStreamlines._fetchField();
});


// ─────────── Heatmap engine (JSON grid → canvas → ImageStatic) ───────────
// The routing server rendered translucent PNGs (matplotlib bilinear
// imshow, alpha 0.55, land masked). The plugin instead serves the grid
// as JSON (`GET /api/field`): lons/lats ascending, `fields` row-major
// from the south, `land` per cell. We draw the same picture here: a
// viewport-sized canvas, bilinear interpolation between grid points,
// the legend's SI colour stops, alpha 0.55, land masked, and hand it to
// OpenLayers as an EPSG:4326 ImageStatic exactly where the PNG used to go.
const KT_MS = 0.514444;
const MMH_MS = 1 / 3600000;
// Fallback ramps (identical to the plugin's legends.ts) used until
// `GET /api/legends` has answered.
const _FALLBACK_STOPS = {
  wind: [[0, '#90caf9'], [5 * KT_MS, '#4fc3f7'], [10 * KT_MS, '#00897b'], [15 * KT_MS, '#43a047'], [20 * KT_MS, '#f9a825'], [25 * KT_MS, '#e64a19'], [30 * KT_MS, '#c62828'], [50 * KT_MS, '#8a0000']],
  current: [[0, '#cce6fa'], [0.5 * KT_MS, '#66ccf2'], [1.0 * KT_MS, '#4ccc73'], [1.5 * KT_MS, '#f2d933'], [2.0 * KT_MS, '#f28c26'], [3.0 * KT_MS, '#d93326'], [5.0 * KT_MS, '#800d0d']],
  waves: [[0, '#b3e5fc'], [1, '#4fc3f7'], [2, '#43a047'], [3, '#fdd835'], [4, '#fb8c00'], [5, '#e64a19'], [6, '#c62828']],
  precip: [[0, '#b3e5fc'], [0.5 * MMH_MS, '#b3e5fc'], [2 * MMH_MS, '#4fc3f7'], [5 * MMH_MS, '#43a047'], [10 * MMH_MS, '#fdd835'], [25 * MMH_MS, '#c2185b']],
  temperature: [[253.15, '#0d2673'], [263.15, '#3359b2'], [268.15, '#73a6e6'], [273.15, '#b2d9f2'], [278.15, '#66d9e6'], [288.15, '#66cc66'], [293.15, '#f2eb4c'], [298.15, '#faa626'], [303.15, '#f2591a'], [308.15, '#cc261a'], [313.15, '#800d0d']],
  sst: [[271.15, '#4c1a80'], [275.15, '#1a4cbf'], [281.15, '#4ca6d9'], [287.15, '#4cbfa6'], [291.15, '#8cd966'], [295.15, '#f2eb4c'], [299.15, '#faa626'], [303.15, '#f24c1a'], [305.15, '#a61a1a']],
  sea_state: [[0, '#313695'], [9.375, '#3d5da8'], [18.75, '#5083bb'], [28.125, '#6ea6cd'], [37.5, '#90c3dd'], [46.875, '#b2dceb'], [56.25, '#d3ecf4'], [65.625, '#ecf7e1'], [75, '#fefebe'], [84.375, '#feeca2'], [93.75, '#fdd484'], [103.125, '#fdb467'], [112.5, '#f88e52'], [121.875, '#f0653f'], [131.25, '#de3f2e'], [140.625, '#c41e26'], [150, '#a50026']],
};
function _legendStops(key) {
  const L = (typeof _LEGENDS !== 'undefined' && _LEGENDS && _LEGENDS[key]) ? _LEGENDS[key] : null;
  return (L && Array.isArray(L.stops) && L.stops.length >= 2) ? L.stops : _FALLBACK_STOPS[key];
}
function _cssToRgb(c) {
  c = String(c).trim();
  let m = c.match(/^#([0-9a-f]{3})$/i);
  if (m) return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16)];
  m = c.match(/^#([0-9a-f]{6})/i);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  m = c.match(/^rgba?\(([^)]+)\)/i);
  if (m) { const p = m[1].split(',').map(Number); return [p[0], p[1], p[2]]; }
  return [128, 128, 128];
}
// 256-entry RGB lookup over [v0, v1] from ascending [value, colour] stops.
const _lutCache = new Map();
function _rampLut(stops) {
  const key = JSON.stringify(stops);
  if (_lutCache.has(key)) return _lutCache.get(key);
  const v0 = stops[0][0], v1 = stops[stops.length - 1][0];
  const rgb = stops.map(s => _cssToRgb(s[1]));
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const v = v0 + (v1 - v0) * i / 255;
    let k = 0;
    while (k < stops.length - 2 && v > stops[k + 1][0]) k++;
    const a = stops[k][0], b = stops[k + 1][0];
    const f = b > a ? Math.max(0, Math.min(1, (v - a) / (b - a))) : 0;
    lut[i * 3] = rgb[k][0] + f * (rgb[k + 1][0] - rgb[k][0]);
    lut[i * 3 + 1] = rgb[k][1] + f * (rgb[k + 1][1] - rgb[k][1]);
    lut[i * 3 + 2] = rgb[k][2] + f * (rgb[k + 1][2] - rgb[k][2]);
  }
  const out = { v0, v1, lut };
  _lutCache.set(key, out);
  return out;
}
// Bilinear sampler over one named grid, null-aware: corners without
// data drop out and the remaining weights renormalise, so a coast cell
// keeps colour up to the land edge instead of fading a whole cell early.
function _gridSampler(grid, rows) {
  const lons = grid.lons, lats = grid.lats, res = grid.res;
  const nx = lons.length, ny = lats.length;
  if (!rows || !nx || !ny) return () => null;
  const lon0 = lons[0], lat0 = lats[0];
  return function (lon, lat) {
    let dx = lon - lon0;
    dx = ((dx + 180) % 360 + 360) % 360 - 180;
    let fx = dx / res, fy = (lat - lat0) / res;
    if (fx < -0.5 || fx > nx - 0.5 || fy < -0.5 || fy > ny - 0.5) return null;
    fx = Math.max(0, Math.min(nx - 1, fx)); fy = Math.max(0, Math.min(ny - 1, fy));
    const i0 = Math.floor(fx), j0 = Math.floor(fy);
    const i1 = Math.min(nx - 1, i0 + 1), j1 = Math.min(ny - 1, j0 + 1);
    const tx = fx - i0, ty = fy - j0;
    const r0 = rows[j0], r1 = rows[j1];
    const v00 = r0 ? r0[i0] : null, v10 = r0 ? r0[i1] : null, v01 = r1 ? r1[i0] : null, v11 = r1 ? r1[i1] : null;
    let sum = 0, wsum = 0;
    if (v00 != null) { const w = (1 - tx) * (1 - ty); sum += v00 * w; wsum += w; }
    if (v10 != null) { const w = tx * (1 - ty); sum += v10 * w; wsum += w; }
    if (v01 != null) { const w = (1 - tx) * ty; sum += v01 * w; wsum += w; }
    if (v11 != null) { const w = tx * ty; sum += v11 * w; wsum += w; }
    return wsum > 0.25 ? sum / wsum : null;
  };
}
// Draw a grid into a data URL. spec: { field, legend, alpha, maskLand,
// alphaField (multiplies alpha, e.g. sea-state `signal`), fadeBelow
// (alpha ramps 0→1 across [0, fadeBelow], precip) }.
function renderHeatmapImage(grid, spec) {
  const [w, s, e, n] = grid.bbox;
  const size = map.getSize() || [800, 600];
  const W = Math.max(128, Math.min(1024, Math.round(size[0])));
  const H = Math.max(128, Math.min(1024, Math.round(size[1])));
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const data = img.data;
  const { v0, v1, lut } = _rampLut(_legendStops(spec.legend));
  const sample = _gridSampler(grid, grid.fields[spec.field]);
  const sampleLand = spec.maskLand ? _gridSampler(grid, grid.land) : null;
  const sampleAlpha = spec.alphaField ? _gridSampler(grid, grid.fields[spec.alphaField]) : null;
  const baseA = spec.alpha == null ? 0.55 : spec.alpha;
  const span = (v1 - v0) || 1;
  for (let y = 0; y < H; y++) {
    const lat = n - (y + 0.5) / H * (n - s);
    for (let x = 0; x < W; x++) {
      const lon = w + (x + 0.5) / W * (e - w);
      const v = sample(lon, lat);
      if (v == null) continue;
      if (sampleLand) { const l = sampleLand(lon, lat); if (l != null && l > 0.5) continue; }
      let a = baseA;
      if (sampleAlpha) { const sg = sampleAlpha(lon, lat); a *= sg == null ? 0 : Math.max(0, Math.min(1, sg)); }
      if (spec.fadeBelow) a *= Math.max(0, Math.min(1, v / spec.fadeBelow));
      if (a <= 0.002) continue;
      const idx = Math.max(0, Math.min(255, Math.round((v - v0) / span * 255)));
      const o = (y * W + x) * 4;
      data[o] = lut[idx * 3]; data[o + 1] = lut[idx * 3 + 1]; data[o + 2] = lut[idx * 3 + 2]; data[o + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}
// Grid resolution for a viewport: enough cells for a smooth picture,
// within the plugin's 40k-cell cap (it coarsens further itself).
function _fieldRes(bbox) {
  return Math.min(2, Math.max(0.02, +((bbox[2] - bbox[0]) / 160).toFixed(4)));
}
// Fetch a field grid for the current viewport + overlay time. The URL
// is identical for the heatmap and the streamlines of the same layer,
// so the second request is a browser-cache hit.
function fetchField(layer, channel) {
  const bbox = _viewBBox();
  const res = _fieldRes(bbox);
  const url = ROUTER + '/field?layer=' + layer + '&bbox=' + _bboxParam(bbox) + '&time=' + encodeURIComponent(_overlayTimeIso()) + '&res=' + res;
  return authFetch(url, {}, channel).then(r => r.ok ? r.json() : _apiErrorText(r).then(t => Promise.reject(new Error(t))));
}
function _setHeatmap(layer, grid, spec) {
  const [w, s, e, n] = grid.bbox;
  layer.setSource(new ol.source.ImageStatic({
    url: renderHeatmapImage(grid, spec),
    imageExtent: [w, s, e, n],
    projection: 'EPSG:4326',
  }));
}
function _heatmapLoader(layer, toggleId, fieldLayer, spec, channel) {
  return function () {
    fetchField(fieldLayer, channel)
      .then(grid => { _setHeatmap(layer, grid, spec); _noteOverlay(toggleId, null); })
      .catch(err => { if (err.name !== 'AbortError') { console.log(fieldLayer + ' heatmap error: ' + err.message); layer.setSource(null); _noteOverlay(toggleId, err.message); } });
  };
}

// ─────────── Wind-speed heatmap ───────────
// Same ramp as the barbs (0–50 kt, 8 stops), alpha 0.55, not land
// masked (wind is a real field over land, as on the routing server).
const windHeatmapLayer = new ol.layer.Image({ source: null, opacity: 1.0, zIndex: 6, visible: false });
let _windHeatmapDebounce = null;
const _doLoadWindHeatmap = _heatmapLoader(windHeatmapLayer, 'windCombinedToggle', 'wind', { field: 'speed_ms', legend: 'wind', maskLand: false }, 'wind-heatmap');
function loadWindHeatmap() {
  if (!windHeatmapLayer.getVisible()) return;
  if (_windHeatmapDebounce) clearTimeout(_windHeatmapDebounce);
  _windHeatmapDebounce = setTimeout(_doLoadWindHeatmap, 300);
}

// ─────────── Current-speed heatmap ───────────
// Land masked so the coasts stay sharp.
const currentHeatmapLayer = new ol.layer.Image({ source: null, opacity: 1.0, zIndex: 6, visible: false });
let _currentHeatmapDebounce = null;
const _doLoadCurrentHeatmap = _heatmapLoader(currentHeatmapLayer, 'currentHeatmapToggle', 'current', { field: 'speed_ms', legend: 'current', maskLand: true }, 'current-heatmap');
function loadCurrentHeatmap() {
  if (!currentHeatmapLayer.getVisible()) return;
  if (_currentHeatmapDebounce) clearTimeout(_currentHeatmapDebounce);
  _currentHeatmapDebounce = setTimeout(_doLoadCurrentHeatmap, 300);
}

// ─────────── Sea-state / roughness heatmap ───────────
// Combined wind + swell + current index, painted blue→red (RdYlBu_r,
// 0–150). Alpha is 0.55 × the grid's `signal` (0..1 fade from calm),
// 0 over land.
const roughnessLayer = new ol.layer.Image({ source: null, opacity: 1.0, zIndex: 6, visible: false });
let _roughnessDebounce = null;
const _doLoadRoughness = _heatmapLoader(roughnessLayer, 'roughnessToggle', 'sea_state', { field: 'index', legend: 'sea_state', maskLand: true, alphaField: 'signal' }, 'roughness');
function loadRoughness() {
  if (!roughnessLayer.getVisible()) return;
  if (_roughnessDebounce) clearTimeout(_roughnessDebounce);
  _roughnessDebounce = setTimeout(_doLoadRoughness, 300);
}

// ─────────── Wave height heatmap (0–6 m, 7 stops, land masked) ───────────
const waveHeatmapLayer = new ol.layer.Image({ source: null, opacity: 1.0, zIndex: 6, visible: false });
let _waveHeatmapDebounce = null;
const _doLoadWaveHeatmap = _heatmapLoader(waveHeatmapLayer, 'wavesCombinedToggle', 'waves', { field: 'swh', legend: 'waves', maskLand: true }, 'wave-heatmap');
function loadWaveHeatmap() {
  if (!waveHeatmapLayer.getVisible()) return;
  if (_waveHeatmapDebounce) clearTimeout(_waveHeatmapDebounce);
  _waveHeatmapDebounce = setTimeout(_doLoadWaveHeatmap, 300);
}

// ─────────── Precipitation rate heatmap ────
// Alpha fades to 0 below 0.5 mm/h (linear ramp across [0, 0.5 mm/h])
// so the broad zero-precip background does not wash out the basemap;
// land masked like the routing server's PNG.
const precipHeatmapLayer = new ol.layer.Image({ source: null, opacity: 1.0, zIndex: 6, visible: false });
let _precipHeatmapDebounce = null;
const _doLoadPrecipHeatmap = _heatmapLoader(precipHeatmapLayer, 'precipToggle', 'precip', { field: 'rate', legend: 'precip', maskLand: true, fadeBelow: 0.5 * MMH_MS }, 'precip-heatmap');
function loadPrecipHeatmap() {
  if (!precipHeatmapLayer.getVisible()) return;
  if (_precipHeatmapDebounce) clearTimeout(_precipHeatmapDebounce);
  _precipHeatmapDebounce = setTimeout(_doLoadPrecipHeatmap, 300);
}

// ─────────── 2-m air temperature heatmap ─────────────
// Constant alpha, no land mask: air temp is meaningful everywhere and a
// sailor at anchor still cares about the shore-side temp.
const temperatureLayer = new ol.layer.Image({ source: null, opacity: 1.0, zIndex: 5, visible: false });
let _temperatureDebounce = null;
const _doLoadTemperature = _heatmapLoader(temperatureLayer, 'temperatureToggle', 'temperature', { field: 't2m', legend: 'temperature', maskLand: false }, 'temperature');
function loadTemperature() {
  if (!temperatureLayer.getVisible()) return;
  if (_temperatureDebounce) clearTimeout(_temperatureDebounce);
  _temperatureDebounce = setTimeout(_doLoadTemperature, 300);
}

// ─────────── Sea-surface (skin) temperature heatmap ──
// Land masked: over land `skt` is the land-surface temperature, not SST.
const sstLayer = new ol.layer.Image({ source: null, opacity: 1.0, zIndex: 5, visible: false });
let _sstDebounce = null;
const _doLoadSst = _heatmapLoader(sstLayer, 'sstToggle', 'sst', { field: 'skt', legend: 'sst', maskLand: true }, 'sst');
function loadSst() {
  if (!sstLayer.getVisible()) return;
  if (_sstDebounce) clearTimeout(_sstDebounce);
  _sstDebounce = setTimeout(_doLoadSst, 300);
}

// ─────────── MSL pressure synoptic chart (vector GeoJSON) ─────────
// Plugin returns isobars + hPa labels along each contour + H/L glyphs
// at smoothed-field circulation centres. Rendered with an OL VectorLayer
// styled per `kind` property: isobar (gray; bold black on multiples of 20
// hPa), label (hPa value with white halo), high (blue "H"), low (red "L").
const pressureSource = new ol.source.Vector({});
const pressureLayer = new ol.layer.Vector({
  source: pressureSource,
  zIndex: 8,
  visible: false,
  style: function(feature) {
    const p = feature.getProperties();
    if (p.kind === 'isobar') {
      const stroke = p.bold
        ? new ol.style.Stroke({ color: '#000', width: 1.6 })
        : new ol.style.Stroke({ color: '#555', width: 1.0,
                                lineDash: [4, 3] });
      return new ol.style.Style({ stroke });
    }
    if (p.kind === 'label') {
      return new ol.style.Style({
        text: new ol.style.Text({
          text: String(p.hpa),
          font: 'bold 11px sans-serif',
          fill: new ol.style.Fill({ color: '#000' }),
          stroke: new ol.style.Stroke({ color: '#fff', width: 3 }),
        }),
      });
    }
    if (p.kind === 'high' || p.kind === 'low') {
      const isHigh = p.kind === 'high';
      const color = isHigh ? '#1565C0' : '#C62828';
      return [
        new ol.style.Style({
          text: new ol.style.Text({
            text: isHigh ? 'H' : 'L',
            font: 'bold 22px sans-serif',
            fill: new ol.style.Fill({ color }),
            stroke: new ol.style.Stroke({ color: '#fff', width: 4 }),
          }),
        }),
        new ol.style.Style({
          text: new ol.style.Text({
            text: String(Math.round(p.hpa)),
            offsetY: 16,
            font: 'bold 11px sans-serif',
            fill: new ol.style.Fill({ color }),
            stroke: new ol.style.Stroke({ color: '#fff', width: 3 }),
          }),
        }),
      ];
    }
    return null;
  },
});

let _pressureDebounce = null;
function loadPressure() {
  if (!pressureLayer.getVisible()) return;
  if (_pressureDebounce) clearTimeout(_pressureDebounce);
  _pressureDebounce = setTimeout(_doLoadPressure, 400);
}
function _doLoadPressure() {
  const bbox = _viewBBox();
  const timeStr = _overlayTimeIso();
  const url = ROUTER + '/pressure?bbox=' + _bboxParam(bbox) +
              '&time=' + encodeURIComponent(timeStr) + '&interval=4';
  authFetch(url, {}, 'pressure')
    .then(r => {
      if (r.status === 304) return null;
      if (!r.ok) return _apiErrorText(r).then(t => Promise.reject(new Error(t)));
      return r.json();
    })
    .then(fc => {
      if (fc === null) return;   // 304 — preserve current features.
      pressureSource.clear();
      _noteOverlay('pressureToggle', null);
      if (!fc || !fc.features) return;
      const features = (new ol.format.GeoJSON()).readFeatures(fc, {
        dataProjection: 'EPSG:4326',
        featureProjection: map.getView().getProjection(),
      });
      pressureSource.addFeatures(features);
    })
    .catch(err => { if (err.name !== 'AbortError') { console.log('Pressure overlay error: ' + err); _noteOverlay('pressureToggle', err.message); } });
}

// ─────────── Wave streamlines (animated canvas overlay) ───────────
// Fetches the wave grid (`/api/field?layer=waves`) for the current
// viewport, spawns particles anywhere swh is finite, advects them in the
// mwd propagation direction, and fades a trail. Color matches the
// wave-height heatmap ramp so the two layers reinforce each other.
const waveStreamlines = {
  canvas: null,
  ctx: null,
  enabled: false,
  particles: [],
  vectorField: null,
  rafId: null,
  fetching: false,
  _onMoveEnd: null,

  _init() {
    if (this.canvas) return;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText =
      'position:absolute;top:0;left:0;pointer-events:none;z-index:5;display:none;';
    document.getElementById('map').appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this._resize();
    window.addEventListener('resize', () => this._resize());
    map.on('change:size', () => this._resize());
  },

  _resize() {
    const size = map.getSize();
    if (!size) return;
    this.canvas.width = size[0];
    this.canvas.height = size[1];
  },

  setEnabled(on) {
    this._init();
    this.enabled = on;
    this.canvas.style.display = on ? '' : 'none';
    if (on) {
      this._fetchField();
      if (!this.rafId) this._loop();
      this._onMoveEnd = () => this._fetchField();
      map.on('moveend', this._onMoveEnd);
    } else {
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.rafId = null;
      this.particles = [];
      this.vectorField = null;
      if (this._onMoveEnd) { map.un('moveend', this._onMoveEnd); this._onMoveEnd = null; }
      if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  },

  _fetchField() {
    if (!this.enabled || this.fetching || AuthGate.tripped) return;
    this.fetching = true;
    fetchField('waves', 'wave-vec').then(d => {
      this.vectorField = d;
      // Respawn the whole particle population — old particles are at
      // positions now out of the field's bounds.
      const N = 1500;
      this.particles = new Array(N);
      for (let i = 0; i < N; i++) this.particles[i] = this._spawn();
    }).catch(err => { if (err.name !== 'AbortError') console.log('wave field error:', err.message); })
      .finally(() => { this.fetching = false; });
  },

  _spawn() {
    const f = this.vectorField;
    if (!f || !f.bbox) return null;
    const [w, s, e, n] = f.bbox;
    for (let i = 0; i < 20; i++) {
      const lon = w + Math.random() * (e - w);
      const lat = s + Math.random() * (n - s);
      const sample = this._sample(lon, lat);
      if (sample) {
        return { lon, lat, age: 0, maxAge: 60 + Math.random() * 60 };
      }
    }
    return null;  // couldn't find a live cell
  },

  _sample(lon, lat) {
    const f = this.vectorField;
    if (!f || !f.res || !f.fields || !f.fields.swh) return null;
    let dx = lon - f.lons[0];
    dx = ((dx + 180) % 360 + 360) % 360 - 180;
    const j = Math.round(dx / f.res);
    const i = Math.round((lat - f.lats[0]) / f.res);
    if (i < 0 || i >= f.lats.length || j < 0 || j >= f.lons.length) return null;
    if (f.land && f.land[i] && f.land[i][j]) return null;
    const swh = f.fields.swh[i][j];
    const mwd = f.fields.mwd[i][j];
    if (swh == null || mwd == null) return null;
    return { swh, mwd };
  },

  _loop() {
    if (!this.enabled) { this.rafId = null; return; }
    const ctx = this.ctx;
    // Fade the previous frame to leave trails.
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0,0,0,0.92)';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.globalCompositeOperation = 'source-over';

    for (let k = 0; k < this.particles.length; k++) {
      let p = this.particles[k];
      if (!p) { this.particles[k] = this._spawn(); continue; }
      const sample = this._sample(p.lon, p.lat);
      if (!sample) { this.particles[k] = this._spawn(); continue; }
      // ECMWF mwd is direction FROM; velocity TO is mwd + 180°.
      const dirTo = (sample.mwd + 180) % 360;
      const rad = dirTo * Math.PI / 180;
      const speed = 0.0008 + 0.00025 * sample.swh;   // deg per frame
      const coslat = Math.max(0.1, Math.cos(p.lat * Math.PI / 180));
      p.lat += Math.cos(rad) * speed;
      p.lon += Math.sin(rad) * speed / coslat;
      p.age++;
      if (p.age > p.maxAge) { this.particles[k] = this._spawn(); continue; }
      const pix = map.getPixelFromCoordinate(ol.proj.fromLonLat([p.lon, p.lat]));
      if (!pix) continue;
      ctx.fillStyle = this._color(sample.swh);
      ctx.fillRect(pix[0], pix[1], 2, 2);
    }
    this.rafId = requestAnimationFrame(() => this._loop());
  },

  // Same stops as the waves legend (0..6 m).
  _color(swh) {
    const stops = [
      [0.0, [179, 229, 252]],
      [1.0, [79, 195, 247]],
      [2.0, [67, 160, 71]],
      [3.0, [253, 216, 53]],
      [4.0, [251, 140, 0]],
      [5.0, [230, 74, 25]],
      [6.0, [198, 40, 40]],
    ];
    const t = Math.max(0, Math.min(6, swh));
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i], b = stops[i + 1];
      if (t <= b[0]) {
        const f = (t - a[0]) / (b[0] - a[0]);
        const r = Math.round(a[1][0] + f * (b[1][0] - a[1][0]));
        const g = Math.round(a[1][1] + f * (b[1][1] - a[1][1]));
        const bl = Math.round(a[1][2] + f * (b[1][2] - a[1][2]));
        return `rgb(${r},${g},${bl})`;
      }
    }
    return 'rgb(198,40,40)';
  },
};

// ─────────── Wind streamlines (animated canvas overlay) ───────────
// Parallel to waveStreamlines. Fetches the wind grid, advects particles
// in the (dir_from + 180) direction, colors by wind speed in knots using
// the same 8-stop ramp as the wind heatmap.
const windStreamlines = {
  canvas: null,
  ctx: null,
  enabled: false,
  particles: [],
  vectorField: null,
  rafId: null,
  fetching: false,
  _onMoveEnd: null,

  _init() {
    if (this.canvas) return;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText =
      'position:absolute;top:0;left:0;pointer-events:none;z-index:5;display:none;';
    document.getElementById('map').appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this._resize();
    window.addEventListener('resize', () => this._resize());
    map.on('change:size', () => this._resize());
  },

  _resize() {
    const size = map.getSize();
    if (!size) return;
    this.canvas.width = size[0];
    this.canvas.height = size[1];
  },

  setEnabled(on) {
    this._init();
    this.enabled = on;
    this.canvas.style.display = on ? '' : 'none';
    if (on) {
      this._fetchField();
      if (!this.rafId) this._loop();
      this._onMoveEnd = () => this._fetchField();
      map.on('moveend', this._onMoveEnd);
    } else {
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.rafId = null;
      this.particles = [];
      this.vectorField = null;
      if (this._onMoveEnd) { map.un('moveend', this._onMoveEnd); this._onMoveEnd = null; }
      if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  },

  _fetchField() {
    if (!this.enabled || this.fetching || AuthGate.tripped) return;
    this.fetching = true;
    fetchField('wind', 'wind-vec').then(d => {
      this.vectorField = d;
      const N = 1500;
      this.particles = new Array(N);
      for (let i = 0; i < N; i++) this.particles[i] = this._spawn();
    }).catch(err => { if (err.name !== 'AbortError') console.log('wind field error:', err.message); })
      .finally(() => { this.fetching = false; });
  },

  _spawn() {
    const f = this.vectorField;
    if (!f || !f.bbox) return null;
    const [w, s, e, n] = f.bbox;
    for (let i = 0; i < 20; i++) {
      const lon = w + Math.random() * (e - w);
      const lat = s + Math.random() * (n - s);
      const sample = this._sample(lon, lat);
      if (sample) {
        return { lon, lat, age: 0, maxAge: 60 + Math.random() * 60 };
      }
    }
    return null;
  },

  _sample(lon, lat) {
    const f = this.vectorField;
    if (!f || !f.res || !f.fields || !f.fields.speed_ms) return null;
    let dx = lon - f.lons[0];
    dx = ((dx + 180) % 360 + 360) % 360 - 180;
    const j = Math.round(dx / f.res);
    const i = Math.round((lat - f.lats[0]) / f.res);
    if (i < 0 || i >= f.lats.length || j < 0 || j >= f.lons.length) return null;
    // Land cells are skipped so particles don't drift over the shore
    // (the routing server nulled them in its wind-vector field).
    if (f.land && f.land[i] && f.land[i][j]) return null;
    const spd = f.fields.speed_ms[i][j];
    const dir = f.fields.dir_from[i][j];
    if (spd == null || dir == null) return null;
    return { speed_ms: spd, dir_from: dir };
  },

  _loop() {
    if (!this.enabled) { this.rafId = null; return; }
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0,0,0,0.92)';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.globalCompositeOperation = 'source-over';

    for (let k = 0; k < this.particles.length; k++) {
      let p = this.particles[k];
      if (!p) { this.particles[k] = this._spawn(); continue; }
      const sample = this._sample(p.lon, p.lat);
      if (!sample) { this.particles[k] = this._spawn(); continue; }
      // meteorological dir_from → velocity TO is +180°
      const dirTo = (sample.dir_from + 180) % 360;
      const rad = dirTo * Math.PI / 180;
      // Wind visual step: scale with speed (m/s). Tuned so 20 kt ≈ quick drift.
      const speed = 0.001 + 0.00012 * sample.speed_ms;
      const coslat = Math.max(0.1, Math.cos(p.lat * Math.PI / 180));
      p.lat += Math.cos(rad) * speed;
      p.lon += Math.sin(rad) * speed / coslat;
      p.age++;
      if (p.age > p.maxAge) { this.particles[k] = this._spawn(); continue; }
      const pix = map.getPixelFromCoordinate(ol.proj.fromLonLat([p.lon, p.lat]));
      if (!pix) continue;
      ctx.fillStyle = this._color(sample.speed_ms);
      ctx.fillRect(pix[0], pix[1], 2, 2);
    }
    this.rafId = requestAnimationFrame(() => this._loop());
  },

  // Match the wind legend ramp (units = knots).
  _color(speed_ms) {
    const kts = speed_ms * 1.94384;
    const stops = [
      [0.0,  [144, 202, 249]],  // #90CAF9
      [5.0,  [ 79, 195, 247]],  // #4FC3F7
      [10.0, [  0, 137, 123]],  // #00897B
      [15.0, [ 67, 160,  71]],  // #43A047
      [20.0, [249, 168,  37]],  // #F9A825
      [25.0, [230,  74,  25]],  // #E64A19
      [30.0, [198,  40,  40]],  // #C62828
      [50.0, [138,   0,   0]],
    ];
    const t = Math.max(0, Math.min(50, kts));
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i], b = stops[i + 1];
      if (t <= b[0]) {
        const f = (t - a[0]) / (b[0] - a[0]);
        const r = Math.round(a[1][0] + f * (b[1][0] - a[1][0]));
        const g = Math.round(a[1][1] + f * (b[1][1] - a[1][1]));
        const bl = Math.round(a[1][2] + f * (b[1][2] - a[1][2]));
        return `rgb(${r},${g},${bl})`;
      }
    }
    return 'rgb(138,0,0)';
  },
};

// --- Map ---
// ─────────── Conditions sample points (current overlay hour) ───────────
// `GET /api/conditions-tile/{z}/{x}/{y}?t=<hour>` — one point per
// wind-barb sample position carrying every conditions field for the
// hour (SI, the plugin's ConditionsRow names). Drawn as faint dots;
// shift-click (or "Conditions here") reads the nearest one for instant
// values, then fetches the hourly series from `/api/conditions`. The
// source is rebuilt on every overlay-time change (`loadConditionsLayer`).
function _conditionsSource(tHour) {
  return new ol.source.VectorTile({
    format: new ol.format.GeoJSON(),
    url: ROUTER + '/conditions-tile/{z}/{x}/{y}?t=' + encodeURIComponent(tHour),
    minZoom: 5,
    maxZoom: 18,
    tileLoadFunction: function(tile, url) {
      if (AuthGate.tripped) { tile.setFeatures([]); return; }
      tile.setLoader(function(extent, resolution, projection) {
        authFetch(url, {}, null)
          .then(r => r.json())
          .then(points => {
            const feats = (Array.isArray(points) ? points : []).map(p => {
              const f = new ol.Feature(new ol.geom.Point(
                ol.proj.transform([p.lon, p.lat], 'EPSG:4326', projection)));
              f.setProperties(p, true);
              return f;
            });
            tile.setFeatures(feats);
          })
          .catch(() => tile.setFeatures([]));
      });
    },
  });
}

const conditionsLayer = new ol.layer.VectorTile({
  source: _conditionsSource(_overlayTimeIso().slice(0, 13)),
  zIndex: 7,
  visible: false,
  style: new ol.style.Style({
    image: new ol.style.Circle({
      radius: 3,
      fill: new ol.style.Fill({ color: 'rgba(30, 60, 120, 0.35)' }),
      stroke: new ol.style.Stroke({ color: 'rgba(255,255,255,0.8)', width: 1 }),
    }),
  }),
});

function loadConditionsLayer() {
  if (!conditionsLayer.getVisible()) return;
  conditionsLayer.setSource(_conditionsSource(_overlayTimeIso().slice(0, 13)));
}

const _DEFAULT_LONLAT = [-71.7, 41.25];
let _SAVED_VIEW = null;
try {
  const v = JSON.parse(localStorage.getItem('rp:view') || 'null');
  if (v && isFinite(v.lon) && isFinite(v.lat) && isFinite(v.zoom)
      && Math.abs(v.lon) <= 180 && Math.abs(v.lat) <= 85) _SAVED_VIEW = v;
} catch (_) {}

const map = new ol.Map({
  target: 'map',
  layers: [osmLayer, seamarkLayer, conditionsLayer, windHeatmapLayer, currentHeatmapLayer, roughnessLayer, waveHeatmapLayer, precipHeatmapLayer, temperatureLayer, sstLayer, pressureLayer, currentLayer, windLayer, skeletonLayer, routeLayer, proposedRouteLayer, vesselMarkerLayer, markerLayer, condMarkerLayer],
  view: new ol.View({
    // Last view this browser had (saved on every move), else Block
    // Island Sound at zoom 11. On a first visit the geolocation block
    // below (or the first Signal K position fix) pans to the vessel.
    center: ol.proj.fromLonLat(_SAVED_VIEW ? [_SAVED_VIEW.lon, _SAVED_VIEW.lat] : _DEFAULT_LONLAT),
    zoom: _SAVED_VIEW ? _SAVED_VIEW.zoom : 11
  })
});

// Remember where the map was left, so the next load opens there. Not
// while a first-visit position request is pending: OL fires moveend
// after the first render, which would otherwise save the default view
// and stop the next visit from asking for the device position.
let _geoPending = false;
let _autoCentreOnVessel = !_SAVED_VIEW;   // first visit: the first Signal K fix centres the map
const _startCenter = map.getView().getCenter();
map.on('moveend', function() {
  if (_geoPending) return;
  const v = map.getView();
  const c = v.getCenter();
  if (_autoCentreOnVessel && (c[0] !== _startCenter[0] || c[1] !== _startCenter[1])) _autoCentreOnVessel = false;
  const [lon, lat] = ol.proj.toLonLat(c);
  try { localStorage.setItem('rp:view', JSON.stringify({ lon, lat, zoom: v.getZoom() })); } catch (_) {}
});

// First visit (nothing saved): centre on the device's position if the
// browser grants it. Denied, unavailable or timed out → stay on the
// default (or wherever the Signal K vessel fix put us).
if (!_SAVED_VIEW && typeof navigator !== 'undefined' && navigator.geolocation) {
  _geoPending = true;
  navigator.geolocation.getCurrentPosition(pos => {
    _geoPending = false;
    const v = map.getView();
    const c = v.getCenter();
    if (c[0] !== _startCenter[0] || c[1] !== _startCenter[1]) return;
    _autoCentreOnVessel = false;
    v.animate({ center: ol.proj.fromLonLat([pos.coords.longitude, pos.coords.latitude]), zoom: 11, duration: 400 });
  }, () => { _geoPending = false; }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 });
}

// Reload overlays when map view changes (each loader debounces itself).
map.on('moveend', function() {
  if (AuthGate.tripped) return;
  loadCurrentOverlay();
  loadWindOverlay();
  loadWindHeatmap();
  loadCurrentHeatmap();
  loadRoughness();
  loadWaveHeatmap();
  loadPrecipHeatmap();
  loadTemperature();
  loadSst();
  loadPressure();
  // wave/wind streamlines each attach their own moveend listener in setEnabled
});

// --- Drag interaction ---
const modify = new ol.interaction.Modify({
  source: markerSource,
  style: null,
  pixelTolerance: 20
});
modify.on('modifyend', function(e) {
  e.features.forEach(function(f) {
    const coords = ol.proj.toLonLat(f.getGeometry().getCoordinates());
    const name = f.get('name');
    if (name === 'start') {
      startCoord = coords;
      updateCoordDisplay('start', coords);
    } else if (name === 'waypoint') {
      const idx = f.get('waypoint_index');
      waypointCoords[idx] = coords;
      _updateWaypointListUI();
    } else {
      endCoord = coords;
      updateCoordDisplay('end', coords);
    }
    markRouteStale();
    updateButton();
  });
});
map.addInteraction(modify);

