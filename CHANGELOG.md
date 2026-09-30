# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
  motor otherwise), `fastest` and `motor`. Tack penalty, motor speed,
  under-keel and overhead margins, maximum wave height.
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
- Behind a caching proxy (e.g. Cloudflare), the web app at
  `/signalk-weather-router-plus/` can run the previous version's scripts
  for a few hours after an update; reload without cache, or open
  `/plugins/signalk-weather-router-plus/ui`, which always loads the
  current scripts.
- The configuration panel has been tested on Signal K server 2.33.0.

[Unreleased]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.0-beta.2...HEAD
[0.1.0-beta.2]: https://github.com/motamman/signalk-weather-router-plus/compare/v0.1.0-beta.1...v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/motamman/signalk-weather-router-plus/releases/tag/v0.1.0-beta.1
