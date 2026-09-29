# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **06z and 18z forecast cycles were never used.** ECMWF publishes them
  under `oper`/`wave` (0–144 h every 3 h); the plugin looked for them
  under `scda`/`scwv`, which are now empty, so it always fell back to the
  00z/12z cycle (brain, 27–29 Sep: only 00z/12z loaded), up to 6 h older
  than needed. Every cycle now uses `oper`/`wave`; a 06z/18z cycle is used
  whenever the horizon is 144 h or less.

- **Approximate waypoints now carry the route through the circle**, as in
  routePlanning: consecutive legs joined by approximate waypoints are
  routed as one search that must pass through each waypoint circle in
  order, instead of each leg ending at the circle and the next restarting
  there (only the last `arrival_radius_m` of each leg differed from
  Precise before). A branch whose next circle is closer than one stage
  step also tries a step straight into it (not in the reference; without
  it small circles were missed where the course turns). If no branch
  passes every circle, the run falls back to leg-by-leg routing and the
  log says so.

### Added

- **Polar performance** (vessel setting, and `vessel.polar_performance`
  per route): the share of the polar's boat speeds the boat makes under
  sail, as a ratio (default 1 = the polar as written, 0.3–1.2). Polars
  are usually race predictions; checked against 882 ORC 2026
  non-spinnaker certificates, the generated Skye 51 polar is in line with
  ORC's own predictions for comparable boats (Swan 48, Baltic 51,
  Contest 48CS), which a loaded cruising boat does not reach. Motor speed
  is unchanged. The Settings tab shows it in the user's Signal K
  percentage unit.

- **Route simplification** (port of the parent's `_rdp_simplify` and
  `shortcut_smoother`), per leg, after the search: waypoints within
  10 m of the straight line between their neighbours are dropped when
  that line is clear of land, then runs of waypoints are replaced by one
  straight leg when it is clear of land and its simulated time is at most
  5% longer (under `sail_max`, a mostly-sailing stretch must stay mostly
  sailing). Your waypoints are always kept. Settings: `routing.simplify`,
  `routing.smoother`, `routing.smootherTolerance`; per route:
  `simplify_m`, `smoother`, `smoother_tolerance`. Conditions are sampled
  again at the new waypoint times, and the job summary's
  `smoother_drops` is now filled in.
- **Leg cards show the tack** (Port / Starboard) on sailing legs. With
  course or wind missing, the card shows no tack instead of defaulting
  to starboard.

- Request fields `precision` (`"precise"` default, `"approximate"`) and
  `arrival_radius_m` (default 200, 0..5000, > 0 for approximate), as in
  routePlanning; a waypoint's `radius_m` overrides the radius for that
  waypoint. Precise legs end exactly on the waypoint; an approximate leg
  ends as soon as the route enters the waypoint's circle and the next leg
  starts there. The destination is always exact.
- Webapp: Waypoint behaviour has a Precision select next to the Waypoint
  radius slider (50–2000 m, default now 200 m, was 500 m).
- Propagator option `snapToExact` (end on the arrival circle instead of
  the exact point); `engine/multileg.ts` (leg planning, stitching, leg
  loop) used by the route worker and the CLI; CLI `--precision` and
  `--radius`.
- GeoJSON: each waypoint's junction point has `role: "via"`; job summary
  `legs` and `precision` for routes with waypoints. Forecast and SMOC
  areas are read per leg and released after each leg.

- **Global water grid** (`data/water-grid-0.02.bin.gz`, 1.49 MB, shipped
  with the package): the world's coastline as a 0.02° navigability graph
  (18000 × 9000 cells) built from GSHHG full-resolution L1 sampled at
  0.005°. Per cell a water bit and east/north edge bits, where an edge is
  open only if a 4-connected path of fine water cells crosses it (keeps
  the Bosphorus open, which a plain any-water cell rule closed); cells
  whose water forms separate components on either side of a thin strip
  are stored with their components (57 759 cells), so the graph cannot
  leak across spits and isthmuses. Loaded once by the route worker
  (about 65 MB; process RSS +73 MB measured).
- `npm run build:water-grid` (`tools/build_water_grid.ts`) to regenerate
  it and `npm run check:water-grid` (`tools/check_water_grid.ts`) for the
  strait / isthmus connectivity checks.
- Automatic rebuild: when the configured coastline shapefiles are not
  the ones the shipped grid was built from (checked by content
  fingerprint), the route worker keeps using the shipped grid and
  rebuilds a matching one in a background thread into the plugin data
  directory (about 400 MB while it runs, guarded by the memory check).
- **Narrow passages** found during the build (4987 worldwide, up to
  40 km wide, with position, width and channel axis) and **automatic
  vias**: where the corridor crosses one narrower than a stage step, a
  soft via is placed at its narrowest point ("auto via at Strait of
  Gibraltar, width 14.2 km"). Listed as `auto_vias` in the route GeoJSON
  and the job summary; never route waypoints.
- **Allow canals** setting (Routing, default off): known canals
  (Corinth, Cape Cod, Chesapeake and Delaware, Kiel, Suez, Panama) are
  stored as edge lists and closed unless allowed. With GSHHG none of them
  is open water; the setting matters with coastline data that has them.
- CLI: `--water-grid <file>`, `--no-water-grid`, `--allow-canals`.
- Local refinement of the route land raster (`LandMask.refine`): finer
  patches, down to 0.0005°, where the corridor passes a narrow passage.

### Changed

- **Forecast horizon up to 360 h** (was 240 h). ECMWF's 00z/12z cycles
  publish to 360 h (every 3 h to 144 h, then every 6 h; 85 steps, checked
  on data.ecmwf.int). The decoded run on disk is about 3.9 GB at 360 h
  with the extra fields.

- **`sail_max` now honours the sail threshold.** The boat sails when the
  polar speed is at or above `routing.sailThreshold` (or the request's
  `sail_thresh_ms`) and motors otherwise. Before, it also sailed whenever
  the VMG along the leg was above 0.25 m/s or the polar speed was at least
  1.0 m/s; since that VMG equals the polar speed, the boat sailed above
  0.25 m/s (≈ 0.5 kn) and the threshold never decided. This deliberately
  differs from the parent routePlanning server (`leg_sim.py`).

- **The polar generator ("Create polar from boat specs…",
  `POST /api/polar-from-specs`) uses a new physics calculator**
  (`src/vessel/vpp_physics.ts`) instead of the empirical one. Sail forces
  come from the ORC VPP Documentation 2026, hull resistance from the Delft
  Systematic Yacht Hull Series and ITTC-57, and a heeling limit (with ORC's
  default crew on the rail) makes the boat flatten and reef as the wind
  builds. The heeling limit and effective sail span are fitted to 441 ORC
  2026 non-spinnaker certificates; on 441 other certificates the median
  error is 3.3% upwind, 3.2% reaching, 3.3% running (was 8.8%, 3.7%,
  6.9%), and boats with a cell over 30% fell from 17 / 12 / 12 to
  3 / 1 / 0. Heavy boats no longer come out 10–15% fast upwind. No
  spinnaker is assumed: the downwind sail area field is gone and the API
  ignores it. Polars generated before are not changed; generate them again
  to get the new numbers.

- **Display units come from the Signal K user's unit preferences.** The
  page's own units selector is gone. As the Signal K Unit Preferences
  guide describes for clients, the page reads `displayUnits` from path
  metadata (`GET /signalk/v1/api/vessels/self/<path>/meta`), which the
  server resolves for the logged-in user. Each quantity uses one path in
  its category: speed, distance, depth, length, temperature, pressure,
  time. Wave height follows depth, wave period is always seconds, rain
  rate is mm/h or in/h depending on the user's length unit. Isobar labels
  and the pressure legend use the user's pressure unit. There is no
  fallback unit: a value whose category doesn't resolve shows as "—" and
  the Display section names the missing categories.

- **The decoded forecast lives on disk, not in memory.** Each ECMWF run
  is decoded once, when it arrives, one step at a time through one
  reusable one-step block (45.7 MB with the extra fields), and written
  to `forecast/<yyyymmddHH>/` in the plugin data directory as raw
  Float32 files (one per field and step, the exact in-memory layout)
  plus `index.json`; written to a temporary directory and renamed when
  complete; pruned with `forecast.keepCycles`. Requests read only what
  they need: map layers their view at the two bracketing steps, the
  conditions popup / Weather API / `/api/forecast` a few cells for every
  step, a route its corridor box + 5° into one block held while it runs.
  Every sample inside what was read equals the whole global store's,
  bit for bit (unit tests). At start-up a complete decoded run of the
  current cycle is used without decoding. Measured on a Pi 5 (8 GB,
  NVMe), 2026-09-28, same settings (72 h, extra fields), process RSS:
  after start-up 1644.0 → 533.8 MiB; peak during a forced reload
  3059.6 → 891.3 MiB; after the reload 1987.3 → 806.3 MiB; start-up to
  forecast ready 64.6 s → 1.3 s with the decoded run on disk. Disk: one
  72 h run with the extra fields is 1.14 GB (1,142,064,000 B); an update
  writes it once.
- The Weather API provider and `GET /api/forecast?lat=&lon=` are answered
  by the data worker; the main thread holds no forecast. The route
  worker no longer adopts a shared forecast: it reads its route area from
  the decoded run.
- `/api/status` `forecast`: `resident_bytes` and `shared` are gone;
  new `storage`, `source` (`disk` | `grib`), `ready_ms`, `decoded_dir`,
  `decoded_bytes`, `decoded_disk_bytes`, `grib_cache_bytes`,
  `last_decode`, and `memory` (forecast memory each worker holds now and
  its largest recent read); top-level `process_rss_bytes`. The page
  shows "MB decoded on disk" instead of "MB resident".
- The memory guard checks what needs memory now: an update's one-step
  decode (66 MB with the extra fields) and a route's corridor store,
  and the free disk space for a decoded run (1 GB kept free). Settings
  help texts updated (horizon: disk grows with it, not memory).
- On-demand CMEMS SMOC and sea-level areas: the route worker releases
  its route areas when a route ends; the data worker keeps at most
  16 MB of areas loaded for map / conditions queries (was an LRU of
  256 MB SMOC and 128 MB tides per worker; 211.3 MB of SMOC areas were
  seen held in the data worker on brain). Re-decoding a map area from
  the disk cache takes 25–89 ms (Pi 5, measured).
- `forecast` refresh with `force=true` decodes the current cycle again
  from the GRIB cache (streaming, to disk).

- The route skeleton comes from an A* over the global water grid (from
  the start through the waypoints to the end, antimeridian-safe, weighted
  heuristic 1.1) instead of a raster of the box around the endpoints. The
  route's land raster, SMOC area and first-boot forecast crop cover the
  corridor's box plus 1°; the 120° × 90° limit applies to that box.
- The corridor is checked against the route's own land raster (flood
  fill in a band along it); a passage the raster closes is refined
  locally, and one closed even at 0.0005° is blocked and the corridor
  re-routed. Stretches narrower than 8 km are re-traced on the route
  raster so the skeleton runs mid-channel.
- Stage steps shorten inside narrow passages (at most 4 × the local
  width, not below 1 km; a step never jumps past a narrow point) with a
  matching stage budget, and candidates inside a passage narrower than a
  subsector bin are binned across the passage, so several branches get
  through a strait.
- The search stops only when a branch within one (local) stage step has
  a land-free final leg, and the terminal is chosen among those with a
  clear final leg; up to K/2 extra stages run if needed.
- The conservative land raster marks cells with an exact supercover of
  each coastline edge (was half-cell sampling, which could miss a cell an
  edge clips at a corner), and the exact polygon test skips samples in
  water cells: computing Lisbon → Palma went from 37.6 s (39.9 s of CPU
  profile in the exact polygon test of the final validation) to 0.27 s.
- A route point on land fails at once with a clear message.

### Removed

- The Conditions sample-dots map layer (Layers → Weather) and its endpoint
  `/api/conditions-tile`. Shift-click (or "Conditions here") gives the
  full conditions forecast for any point without it. Each dots tile
  loaded and kept its own current-data area: on brain, 926 such areas
  held 160 MB after one zoomed-out browse (source: `/api/status`
  on-demand list, 2026-09-28).

### Fixed

- **Zooming out stalled the map (wind barbs 1.3–4.9 s per tile on brain).**
  Every map tile's colour layers, current arrows and land mask ask the
  data worker for a coastline raster; only 8 were kept, so a zoom-out
  rebuilt dozens back to back (~165 ms each on the Pi; 673 builds against
  1,573 hits in 20 minutes) and every other request queued behind them.
  Rasters are now saved on disk (gzip, ~8 kB each, in
  `overlay-land/coast-<fingerprint>/` of the plugin data directory, 256 MB
  cap, least recently used pruned); 8 stay in memory as before. A box seen
  once is read back in about 1 ms instead of being rasterised again, also
  after a restart; a changed coastline file gets a new folder.
  `/api/status` `overlay_land` adds `disk_hits`, `disk_writes` and
  `disk {dir, files, bytes}`.

- **The conditions popup took 14–15 s** inside the NECOFS-GOM3 area
  (brain, 72 hourly rows). Each hour predicted the tidal current for the
  whole NECOFS grid (501 × 501 cells, ~230 ms on the Pi) to read one
  point. A point at a time with no grid cached is now predicted from its
  4 surrounding cells only: 360 points × 72 h took 32 ms instead of
  16.1 s, with identical results (difference 0; the pyTMD reference test
  still passes). Map layers, which read many points at one time, still
  use the cached grid. Leg simulations and the shortcut smoother, which
  read one point at changing times, use the fast path too.

- **Routes with waypoints failed** ("finished 30 stages without any
  branch crossing all 3 via(s); deepest branch crossed 0", job
  `5e0abb0d…`, reproduced on brain with the installed build and the
  2026-09-28 12Z forecast). One search ran for the whole route and each
  waypoint was a disc that some fixed-length stage step had to happen to
  cross; near a turn the steps cut the corner and missed it. Waypoints
  are now leg ends: each leg is routed on its own (port of the
  routePlanning `compute_multi_leg_route`), departing at the previous
  leg's arrival, and the legs are stitched. The same request now succeeds
  in precise and approximate mode (500 m and 200 m), motor and sail_max.
  Routes without waypoints are unchanged (byte-identical GeoJSON against
  the previous build for Baja sail_max / motor and Lisbon → Palma).
- **Routes failed when the search took a different passage than the
  corridor** (same message, "crossing all 1 via(s)", job `2bce05cd…`:
  Long Island Sound → east of Block Island Sound). The corridor went past
  Gardiners Island and put an automatic via there; the search went
  through The Race and no branch crossed the via. When that happens the
  leg is now routed again without its automatic vias. Routes that already
  worked never take this path and are unchanged (byte-identical GeoJSON on
  brain for Lisbon → Palma and Baja, with and without waypoints).

- A forecast reload no longer needs memory for two whole forecasts
  (the old one serving while the new one loaded: 3059.6 MiB peak RSS on
  a Pi 5), and a restart no longer spends 64.6 s (Pi 5, measured)
  decoding a forecast that was already decoded before the restart.
- Memory leak on forecast refresh: after every new forecast run the
  previous store (0.6–1.1 GB) stayed resident, because ~275 separate
  4.15 MB shared buffers allocated in a worker thread were kept in that
  thread's glibc malloc arena when freed. Each forecast is now one
  shared block with a view per field-step, which Linux takes back as soon
  as it is replaced. Measured on a Pi 5 over four reloads: 840 → 1,591 MB
  before, flat at ~795 MB after.
- Map colour layers and flow lines lost everything more than 180° east of
  the view's west edge when the view crossed the date line (e.g. the
  Americas in a Pacific-centred view). Layers are now drawn in the map's
  own projection with longitudes wrapped from the grid's west edge.

- Routes whose only water path lies outside the rectangle around start,
  end and waypoints failed ("skeleton chain A* failed", then "terminal
  hop … crosses land"), e.g. Lisbon → Palma through the Strait of
  Gibraltar. They now route through the passage.
- Long routes through a narrow strait kept a single surviving branch
  (Madeira → Cartagena: 1 retained at stage 14); they now keep several
  (8–12 through Gibraltar in the test runs).
- Adding waypoints by hand to get through a strait is no longer needed.

## [0.1.0-beta.1] - 2026-09-28

First beta. Everything below is new relative to the initial development
snapshot.

### Added

- **Routing engine**: TypeScript port of the routePlanning subsector
  isochrone router (coarse A* skeleton, heading sweep per stage, leg
  simulator against the polar, vias as pass-through discs), running in a
  worker thread. Modes `sail_max`, `fastest`, `motor`.
- **Forecast**: ECMWF IFS 0.25° open data fetched by HTTP byte range from
  the `.index` files, CCSDS/GRIB2 decoded in-process, cached on disk.
  Base fields `10u`, `10v`, `msl`, `swh`, `mwp`, `mwd`; optional extra
  fields `2t`, `tprate`, `skt`, `2d`, `ptype`.
- **Global resident forecast**: the whole globe is held at full Float32
  precision in SharedArrayBuffers shared by the data worker, the main
  thread and the route worker (one copy). Replaces the old vessel-centred
  region.
- **Currents**: Copernicus Marine SMOC (worldwide hourly surface currents
  including tidal currents and Stokes drift), read anonymously from the
  ARCO Zarr stores with an in-process Zarr v2 reader and Blosc/LZ4
  decoder. Priority stack with NOAA Global RTOFS (backup) and
  user-installed tidal-harmonic `.npz` files.
- **Tides and water level**: Copernicus Marine hourly sea level (FES2014
  tide): tide height, total water level and surge relative to mean sea
  level, high and low waters, range and tendency.
- **Webapp** (Signal K Webapps page, OpenLayers bundled for offline use):
  route planning with the click menu, course extension, draggable start,
  end and waypoints, itinerary cards, tack-coloured legs, recent routes,
  Live mode.
- **Map layers**: wind speed (colour) + flow lines, wind barbs, wave
  height (colour) + direction lines, current speed (colour), current
  direction (arrows), sea state, precipitation, air temperature, sea
  surface temperature, pressure isobars with H/L, tide height (colour),
  conditions sample dots, OpenSeaMap seamarks, own vessel.
- **Conditions popup**: 72-hour charts for Wind, Waves, Sea state
  (index / Beaufort / Douglas), Tide & current (tide on the left axis,
  current speed on the right, set as arrows), Pressure, Temperature,
  Precipitation, plus a Raw table.
- **Polars**: polar library picker (configured default plus a polars
  directory), polar diagram, point-of-sail angles, per-route polar
  choice, and "Create polar from boat specs" (empirical VPP, matches the
  routePlanning Python output cell for cell).
- **Settings tab** in the webapp for vessel, routing, forecast, currents,
  tides and publishing, stored server-side in `settings.json` and shared
  by all clients. Values migrated from the old plugin configuration on
  first start.
- **Memory guard**: a forecast only loads if the device keeps the
  configured memory free afterwards ("Memory kept free", default 1 GB).
  If it does not fit, the plugin refuses and says what to change, and a
  refused reload keeps the running forecast.
- **Signal K Weather API provider**: point forecasts anywhere, including
  temperature, dew point, relative humidity, water temperature, water
  level and level tendency when available.
- **Coastline clipping at screen resolution**: `/api/land-mask` returns a
  land mask for the exact map image, so colour layers and flow lines
  stop at the real shoreline.
- **"No model data" hatching** on the tide and current layers where
  water is narrower than the ~9 km model grid.
- `/api/land-mask`, `/api/polars`, `/api/polar-angles`, `/api/polars/table`,
  `/api/polar-from-specs`, `/api/settings`, `/api/conditions-tile`,
  `/api/field?layer=tide`.

### Changed

- All values on the wire are Signal K SI units (dimensionless as ratios
  or indices). ECMWF precipitation is converted to m/s once, at
  ingestion; relative humidity is a 0..1 ratio (`rh`, was `rh_pct`);
  precipitation rate is `precip_rate_ms` (was `tprate_kg_m2_s`).
- The Signal K plugin configuration keeps installation settings only
  (coastline shapefiles, default polar, polars directory, harmonics
  directory, download mirror, Weather API switch); everything else moved
  to the webapp's Settings tab.
- Layer labels name the quantity shown instead of "heatmap".
- Tide colour scale stretches to the largest tide in view (at least
  ±0.5 m), with the legend showing the actual range.
- The webapp's scripts are served with a version tag, so browsers and
  proxies never run a stale script after an update.

### Fixed

- ECMWF 2 m dew point is `2d` in the open-data index (was requested as
  `d2m` and skipped), so humidity, dew point and heat index now fill in.
- Per-route vessel overrides fell back to built-in defaults instead of
  the configured values for fields the request left out.
- Precipitation layer always showed zero (rates rounded away).
- Overlays outside the forecast region repeated edge values; forecast
  layers now report no data there (moot with the global forecast).

### Known issues

- Routes whose only water path lies outside the rectangle around the
  start, end and waypoints (plus 1°) fail, e.g. Lisbon to Palma through
  the Strait of Gibraltar. Workaround: add a waypoint in or near the
  passage.
- Very long routes use long stages (route length / stages); narrow
  passages can then leave only one surviving branch.
- Heights are relative to mean sea level, not chart datum; not for
  under-keel clearance.

[0.1.0-beta.1]: https://github.com/motamman/signalk-weather-router-plus/releases/tag/v0.1.0-beta.1
