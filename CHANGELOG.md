# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0-beta.5] - 2026-09-30

### Added

- **Weather routing inside Freeboard-SK.** The plugin is now a plotter
  extension (Signal K Plotter Extensions API, version 1): Freeboard-SK
  3.0 and later shows a **Weather route** button in its extension
  toolbar, which opens a panel. Draw a route on the chart with
  Freeboard's own tool (start, waypoints, destination by tapping) or show
  a saved one, and **Weather-route it** rewrites it in place with the
  weather route (first point = start, last = destination, the others =
  precise waypoints), still Freeboard's editable draft; or route from the
  vessel to a typed position, the map centre or a saved waypoint as a new
  draft. Each point carries its ETA, the leg's mode and the wind;
  **Save route…** opens Freeboard's own Route Details dialog and stores
  the route in Signal K. Needs no change to Freeboard. The
  panel is served as part of this webapp (`/signalk-weather-router-plus/
  plotterext/`) and is versioned, so an update never runs a cached copy.
- **Map overlays as chart layers.** The eight colour layers (wind speed,
  wave height, current speed, sea state, precipitation, air and sea
  temperature, tide height) are also served as **PNG image tiles**
  (`GET /api/tile/<layer>/{z}/{x}/{y}.png?time=<ISO>`, the picture the web
  app paints, rendered on the server from the same cached data tiles) and
  published as Signal K **chart resources** (`/signalk/v2/api/resources/
  charts`, ids `wrp-wind-speed` …) with a `time` block covering the forecast
  hours. Freeboard-SK lists them in its Chart list with opacity and order,
  and its Time palette scrubs, steps and plays them through the forecast
  with no change to Freeboard. A layer is listed only while its data is
  there (currents, tides, waves, the extra fields). Display settings a
  plotter saves on a layer (opacity, minimum zoom, image adjustment) are
  kept in `chart-overrides.json` in the plugin data directory. The tide
  layer uses its fixed ±3 m scale here (the web app's auto-scale spans
  tiles). Three glyph layers too: wind barbs, current arrows and isobars
  (`barbs`, `arrows`, `isobars`; ids `wrp-wind-barbs`,
  `wrp-current-arrows`, `wrp-isobars`), drawn as the web app draws them;
  isobars without pressure labels, highs and lows as dots. The layers are
  also written as Freeboard resource Groups into the server's `groups`
  collection when it exists: one colour layer per group with its glyphs
  (Wind, Waves, Currents, Pressure, Sea state, Tide, Rain, Air
  temperature, Sea temperature), each holding the layers whose data is
  there.

### Removed

- Eight vessel settings that the router never used: draught, air draft,
  LOA, beam, under-keel margin, overhead margin, maximum wave height and
  tack penalty. They are gone from the Settings tab, `GET/PUT
  /api/settings` and the route request's `vessel` object (sent there,
  they are ignored); an existing `settings.json` that still holds them
  loads normally and drops them. The vessel settings that remain are
  name, speed under power and polar performance. A working tack penalty
  and maximum wave height are planned (docs/TODO.md).
- Web app: the Tack penalty and Under-keel clearance sliders, and LOA,
  draught and air draft in the power-boat form (they were required but
  not used; a power boat now needs only a name and a cruise speed). The
  "Solver & safety tuning" section is now "Solver tuning".

### Fixed

- Configuration panel: on a fresh install the Save button stayed greyed
  out until some field was changed, yet a save is the only way the Admin
  UI enables a plugin that has no saved configuration ("Save
  configuration to enable this plugin"). The button is now enabled at
  first setup and reads "Save and enable the plugin". (Verified on a
  fresh App Store install on Signal K 2.33.0.)
- **Stale web files after an update.** Files installed by npm carry
  npm's fixed date (26 Oct 1985); Signal K sends it as `Last-Modified`
  with no ETag, so a browser that already had the web app's page, the
  configuration panel's script or the plotter panel was told "not
  modified" after an update and kept the old copy until the URL changed.
  The plugin now sets its web files' dates to the time of the first start
  after they changed (a hash of `public/` is kept in the data directory),
  so the next conditional request gets the new file; the plotter panel's
  URL also carries a hash of its files.

### Known issues

- Right after installing the plugin from the App Store and restarting
  the server, an Admin UI page that was open before the restart shows
  *Module "signalk-weather-router-plus" is not available* instead of the
  configuration panel, until it is reloaded once. This is the server's
  doing (it lists configuration panels once at start and writes them
  into the Admin UI page as it is served); no plugin change can avoid
  it.

## [0.1.0-beta.4] - 2026-09-30

### Fixed

- README: the introduction wrongly described this plugin as a
  server-free sibling of `signalk-weather-router`. It now says what the
  "plus" is (the map overlays, drawn from the same data the routing
  uses) and that inshore routing (depths, channels, bridges) is not done
  here but by the separate router.zeddisplay.com.

## [0.1.0-beta.3] - 2026-09-30

### Changed

- **First start:** while the coastline downloads, the API answers and the
  web app's status line say so ("starting: downloading the coastline
  (40 %)") instead of "plugin not started" (status field `starting`), and
  the page checks the status every 5 s until the first forecast is in.
- **A route started before the first forecast** waits for it ("waiting
  for the first forecast") instead of downloading its own copy of the
  same fields alongside: on a fresh install such a route took 170 s
  (brain, measured); it now runs as soon as the forecast is ready. It can
  be cancelled while waiting; if the forecast download fails, it runs as
  before.

### Fixed

- On a fresh install the first forecast download could fail with
  `ENOENT … rename …grib2.tmp-<pid>` (it was retried and succeeded 10
  minutes later): two threads fetching the same GRIB field at once, e.g.
  a route computed before the first forecast was ready, wrote the same
  temporary file. Temporary files (GRIB downloads, the water grid rebuild,
  generated polars) are now unique per writer, and a field
  another writer has just saved is taken as it is.

## [0.1.0-beta.2] - 2026-09-30

### Added

- **Polars included.** The plugin now ships the ~700 polars of the
  OpenCPN weather_routing_pi library (GPL-3.0, credited in NOTICE) and a
  Catalina 36 default, used when no polar library or default polar is
  configured, so routes sail out of the box; 0.1.0-beta.1 had none and
  routed motor-only until a polar was configured. With the bundled
  library, polars you generate are kept in `polars/user/` in the plugin
  data directory, so updating the plugin never removes them. A configured
  `polarsDir` / `polarFile` works as before.

### Fixed

- A polar with an empty cell (two tabs with nothing between, as in
  weather_routing_pi's `Figaro_1-1.pol`) failed to load; the cell is now
  filled from the rows around it.

## [0.1.0-beta.1] - 2026-09-30

First public beta: weather routing that runs entirely inside the Signal K
server, with no outside routing service. The history of the development
builds before this release, with their measurements, is in
[docs/development-notes.md](https://github.com/motamman/signalk-weather-router-plus/blob/main/docs/development-notes.md).

### Added

#### Routing

- Isochrone router (a TypeScript port of the routePlanning subsector
  router) in a worker thread, against the vessel's polar. Modes
  `sail_max` (sail when the polar speed reaches the sail threshold,
  motor otherwise), `fastest` and `motor`, with a motor speed. (This
  entry also listed a tack penalty, under-keel and overhead margins and a
  maximum wave height; those settings existed but the router did not use
  them. They were removed in 0.1.0-beta.5.)
- **Routes through straits anywhere:** a global water grid shipped with
  the plugin (0.02°, built from GSHHG full-resolution level 1, with 4,987
  narrow passages) gives each route a corridor; routes such as Lisbon →
  Palma through Gibraltar or the Aegean → Black Sea through the
  Dardanelles and the Bosphorus need no waypoints. Where the corridor
  crosses a passage narrower than a stage step, an automatic
  pass-through point is placed at its narrowest point and steps shorten
  there. Known canals are closed unless **Allow canals** is on.
- **Waypoints as legs:** each waypoint ends a leg; the next departs at
  the arrival time. **Precise** (exactly through the waypoint) or
  **Approximate** (through a circle of 50–2000 m, one search across
  consecutive approximate waypoints). The destination is always exact.
- **Route simplification:** waypoints within 10 m of a straight line are
  dropped, and runs of waypoints become one straight leg when it stays
  clear of land and is at most 5% slower. Your own waypoints are kept.
- **Polar performance** (default 100%, 30–120%): the share of the
  polar's speeds the boat actually makes under sail.
- Every leg is checked for land against every raster cell it crosses
  during the search and against the exact coastline polygon edges at the
  end, so land of any width is found.
- Route jobs with progress over Server-Sent Events; results as GeoJSON,
  saved to the Signal K Resources API, with a notification on completion
  or failure. **Live mode** re-plans from the boat's position.
- `wrp-route` command-line tool (no Signal K needed).

#### Weather, currents and tides

- **ECMWF open data**, global at 0.25°: wind, pressure and waves;
  optional air and sea temperature, precipitation, dew point and
  precipitation type. Every cycle (00z/12z to 360 h, 06z/18z to 144 h),
  horizon 3–360 h (default 72 h). Fetched by byte range and decoded in
  the plugin.
- **The forecast is decoded once to disk**, not held in memory: about
  1.1 GB for 72 h with the extra fields, 3.9 GB at 360 h. The forecast
  is ready 1.3 s after a restart when the current run is already decoded
  (Raspberry Pi 5, measured). On that Pi (8 GB), the whole Signal K
  process, with this plugin, its two tile build workers and the server's
  other plugins, used 1.9 GB after 7 hours (measured 30 September).
- A resource guard refuses a forecast, a route or a setting the device
  cannot hold (memory kept free, default 1 GB; 1 GB of disk kept free)
  and says what to change.
- **Currents:** Copernicus Marine SMOC (worldwide, hourly, including
  tidal currents), NOAA Global RTOFS as a backup, and tidal-harmonic
  files you install (FES2014, NECOFS) taking priority where they cover.
- **Tides and water level:** Copernicus Marine hourly sea level: tide
  height, total water level and surge, high and low waters.

#### Web app

- Plan on the map: click menu, draggable start, destination and
  waypoints, course extension, itinerary cards per leg with the tack,
  saved routes, run log.
- Map layers named for the quantity shown: wind speed (colour) and flow
  lines, wind barbs, wave height and direction lines, current speed and
  arrows, sea state, precipitation, air and sea temperature, pressure
  isobars with highs and lows, tide height, OpenSeaMap seamarks and your
  own vessel. Colour layers stop at the coastline; water the current and
  tide models cannot resolve is hatched "no model data".
- **Map tiles saved on disk and built ahead of time:** colour layers,
  barbs and arrows load as fixed tiles on the hour, answered from disk
  (11–27 ms per tile measured on the Pi against a 10 s median before
  caching). Worker threads build the tiles around the boat and the area
  the map shows for every hour of the forecast (zoom 6–15, 250 km radius
  to zoom 8, half of it at each deeper zoom). Disk cap 20 GB by default.
- **Conditions popup** (shift-click): 72-hour charts of wind, waves, sea
  state, tide and current, pressure, temperature and precipitation, and
  a raw table. Where no current model has data (water narrower than
  their grids) it says so instead of showing 0 kn.
- **Centre on the boat** button under the zoom buttons; the route
  summary also at the top of the Itinerary tab.
- **Units from your Signal K unit preferences**; values are SI
  everywhere else.
- **Settings tab** for vessel, forecast, currents, tides, routing and
  publishing, shared by every client.

#### Polars

- Polar library (default polar plus a polars directory), polar diagram
  and point-of-sail angles, polar per route.
- **Create polar from boat specs:** a physics model (ORC VPP 2026 sail
  forces, Delft hull series resistance, heeling limit with crew on the
  rail). Checked against 441 ORC 2026 non-spinnaker certificates: median
  error 3.3% upwind, 3.2% reaching, 3.3% running. No spinnaker assumed.

#### Signal K integration

- **Configuration panel** in the Admin UI: coastline with a Download
  button and progress, the map cache settings in your units, and the
  other plugin options.
- **Coastline downloaded on first start** when none is configured: GSHHG
  2.3.7 full-resolution level 1 (149 MB, once) from the authors' site,
  or an identical copy on router.zeddisplay.com, checked by SHA-256.
- **Weather API provider:** point forecasts anywhere, including
  temperature, dew point, humidity, water temperature, water level and
  its tendency.
- REST API with an OpenAPI document; every map and point answer is shared
  by all clients through the same disk cache.

### Known issues

- Tide heights and water level are relative to **mean sea level, not
  chart datum**. Do not use them for under-keel clearance.
- Currents and tides come from ~9 km models: fine along coasts, not
  inside small harbours or narrow channels.
- Open water only; no depths, fairways or bridges. Passages narrower than
  about 150 m are not navigable for the router. A start or end deep
  inside a harbour can fail; start from the approach.
- One route computes at a time; others queue. Routes beyond the forecast
  horizon use the last forecast step.
- Map layers show the forecast on the hour; latitudes beyond ±85° have no
  map tiles.
- After an update, the browser could keep the previous version's web
  app page, configuration panel script and plotter panel: files installed
  by npm all carry npm's fixed date (26 Oct 1985), Signal K serves that as
  `Last-Modified` with no ETag, so a browser that had the file was told
  "not modified" and kept its copy until the URL changed (fixed in
  0.1.0-beta.5: the plugin re-dates its web files on the first start after
  they changed, and the plotter panel's URL carries a content hash). Hard-
  refresh, or open `/plugins/signalk-weather-router-plus/ui`, which always
  loads the current scripts.
- The configuration panel has been tested on Signal K server 2.33.0.

[Unreleased]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.0-beta.5...HEAD
[0.1.0-beta.5]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.0-beta.4...v0.1.0-beta.5
[0.1.0-beta.4]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.0-beta.3...v0.1.0-beta.4
[0.1.0-beta.3]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.0-beta.2...v0.1.0-beta.3
[0.1.0-beta.2]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.0-beta.1...v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/motamman/signalk-weather-router-plus/releases/tag/v0.1.0-beta.1
