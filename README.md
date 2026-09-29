# signalk-weather-router-plus

Standalone open-water weather routing as a Signal K plugin. Nothing runs
outside the Signal K process: the plugin downloads ECMWF open-data
forecasts by HTTP byte range, decodes the CCSDS-packed GRIB2 fields in
TypeScript, reads Copernicus Marine SMOC ocean currents (worldwide,
including tides) and the Copernicus Marine hourly sea level (tide
height, total water level, surge) from their Zarr stores with an
in-process Blosc/LZ4 decoder, avoids land with GSHHG coastline polygons, and runs an
isochrone router against the vessel's polar in a worker thread. No
runtime npm dependencies.

It is the "plus" sibling of `signalk-weather-router`, which is a thin
client to the routePlanning server. This plugin needs no routePlanning
server and no S-57 charts. It does **not** do near-shore chart
navigation (fairways, depths, bridges); it routes between open-water
positions and treats the coastline as the only obstacle.

What changed in this version: [WHATSNEW.md](WHATSNEW.md). Full history:
[CHANGELOG.md](CHANGELOG.md).

## What it provides

| Surface | Path |
|---|---|
| Webapp (map, compute, watch progress) | listed in the Admin UI's Webapps page as **Weather Router Plus**; served at `/signalk-weather-router-plus/` (also `/plugins/signalk-weather-router-plus/ui`) |
| Route job API (REST + Server-Sent Events) | `/plugins/signalk-weather-router-plus/api/…` |
| OpenAPI | `/plugins/signalk-weather-router-plus/api/openapi.json` |
| Finished routes | saved to `/signalk/v2/api/resources/routes/{jobId}` (needs a routes provider, e.g. `resources-provider`) |
| Weather API provider | point forecasts anywhere from the global forecast (read from the decoded run on disk by the data worker) via `/signalk/v2/api/weather/forecasts/point?lat=&lon=`, with `water.level` / `water.levelTendency` (relative to mean sea level) when tides are on |
| Notifications | `notifications.weatherRouterPlus.{jobId}` on completion or failure |
| CLI (no Signal K) | `wrp-route` |

## Data

- **Forecast:** ECMWF IFS 0.25° open data, `oper`/`wave` streams
  (00z/12z) or `scda`/`scwv` (06z/18z). Fields: `10u`, `10v`, `msl`,
  `swh`, `mwp`, `mwd`. Only those fields are fetched (byte-range
  requests against the published `.index` files, roughly 4.7 MB per
  step instead of 140 MB) and cached on disk under the plugin's data
  directory (`ecmwf/`). The whole globe is decoded at full Float32
  precision (exactly the decoded values), so overlays, conditions, the
  Weather API and routing work anywhere: 1440 × 721 cells × 4 B =
  4.15 MB per field per step. A 72 h horizon (25 steps) is 623 MB with
  the six base fields and 1.14 GB with the extra fields (`2t`, `tprate`,
  `skt`, `2d`, `ptype`).

  **Decoded once per update, kept on disk, read per request.** The
  decoded forecast is not kept in memory. When a new ECMWF run arrives
  the data worker decodes it one step at a time into one reusable
  one-step block (45.7 MB with the extra fields) plus decode buffers
  (20.8 MB: one global field as Uint32 + Float64 + Float32 + Int32) and
  writes each step to `forecast/<yyyymmddHH>/` under the
  plugin data directory: one raw Float32 file per field and step
  (`<step>-<param>.f32`, rows from the south, 1440 × 721, NaN kept, the
  exact in-memory layout) and an `index.json` (cycle, steps and valid
  times, parameters, grid, format version, `complete`). The run is
  written into a temporary directory, every file fsync'd, and renamed
  into place only when complete, so a crash never leaves a run that
  looks complete. It stays there until the next run replaces it
  (`forecast.keepCycles` applies, as for the GRIB cache). At start-up a
  complete decoded run of the current cycle is used as it is, without
  decoding. Each request then reads only what it needs, for as long as
  it needs it: a map layer reads its view (plus two cells) at the two
  steps around the map time; the conditions popup, the Weather API and
  `/api/forecast?lat=&lon=` read a few cells around the point for every
  step; a route reads its corridor box plus 5° (wind and waves, every
  step) into one block before it runs and drops it when it ends. Inside
  what was read every sample is bit for bit the value of the whole
  global store (the unit tests check map grids, arrows, isobars,
  conditions, Weather API points and corridor sampling against it).
  Nothing is cached in the process beyond that: warm reads come from the
  OS page cache (1–2 ms for a map view, below), so an in-process cache
  of field-steps was not added.

  Disk: one run of 72 h with the extra fields is 1,142,064,000 B of
  `.f32` files plus a 3.5 kB `index.json`; with `keepCycles` 2 up to two
  runs are kept, next to the GRIB cache (212.5 MB for one 72 h cycle
  with the extra fields). An update writes the run once:
  1,144,471,552 B written by the plugin process during a forced reload
  (`/proc/<pid>/io` `write_bytes`). The GRIB cache stays, so a settings
  change (horizon, extra fields) can decode again without downloading.

  *Measured on a Pi 5 (8 GB, NVMe), 2026-09-28*, the installed build
  (whole forecast in memory) against this design, same settings (72 h,
  extra fields, SMOC, RTOFS, tides), the plugin run with a stand-in
  Signal K app, process RSS sampled every second from `/proc/<pid>/status`:

  | | whole forecast in memory | decoded on disk |
  |---|---|---|
  | RSS after start-up, all loads + 60 s | 1644.0 MiB | 533.8 MiB |
  | peak RSS during a forced forecast reload | 3059.6 MiB | 891.3 MiB |
  | RSS 60 s after the reload | 1987.3 MiB | 806.3 MiB |
  | start-up to forecast ready | 64.6 s (decode from the GRIB cache) | 1.3 s (decoded run on disk); 68.6 s when it has to decode |
  | forced reload (decode from the GRIB cache) | 66.9 s | 69.4 s (includes writing and fsyncing 1.14 GB) |

  Forecast reads from the decoded run (`DecodedRun.window`), cold = page
  cache dropped first: a map view (10° × 8°, wind, 2 steps) 7.1 ms cold,
  1.6–1.7 ms warm; the North Atlantic (70° × 40°) 10.5 / 2.1–2.4 ms; the
  whole world 37.9 / 8.4–9.2 ms (16.6 MB); a point series (11 fields ×
  25 steps) 34.7 / 25–29 ms; a route corridor (5 fields × 25 steps)
  108.6–148.4 ms cold, 27–35 ms warm (3.7–7.4 MB). Route jobs Newport
  RI → Bermuda and → Horta (motor and sail_max) took 196–238 s with the
  whole forecast in memory and 199–239 s decoded on disk; Lisbon →
  Palma 3.2–7.2 s and 6.8–12.9 s (the first Lisbon route of the second
  run downloaded 19.2 MB of SMOC chunks the first run already had on
  disk). Route areas are released when a route ends, so each route
  decodes its CMEMS SMOC area again from the disk cache (2.1–3.4 s
  measured).
- **Land:** GSHHG shorelines as shapefiles (`GSHHS_f_L1.shp` for full
  resolution; add `GSHHS_f_L6.shp` for Antarctica) or the OSM
  land-polygons export. Overlay land flags use a raster built on demand
  for each requested bbox at a resolution matched to the request's
  sample spacing (a quarter of it, 0.002° to 0.25°, at most 4 M cells),
  from an in-memory index of the shapefile records; the last 8 rasters
  are kept. Conditions `is_land` uses the exact polygons. For routing,
  land is loaded for the box around the route's corridor (see [Global
  water grid](#global-water-grid)) plus 1° and rasterised at
  the finest resolution that fits the configured cell budget (0.5 m
  arc-seconds to 0.01°). The raster is conservative: cells crossed by a
  coastline edge count as land (an exact supercover of every edge, so a
  water cell contains no coastline). Where the corridor passes a passage
  only a few cells wide, finer patches (down to 0.0005°, about 55 m) are
  rasterised locally. Endpoints and the finished route are checked
  against the exact polygons (only samples in land or coastline cells
  need the polygon test).
- **Depth:** none in this version. There is no bathymetry gate; a
  vessel's draught only matters through the configured values carried in
  the output.
- **Currents:** a stack of sources; where several cover a point the
  highest priority with data wins, and exactly (0, 0) from a source
  means "no data here" (the next one is asked):

  | Priority | Source | Coverage |
  |---|---|---|
  | 10 (from the file) | user-installed tidal harmonics `.npz`, e.g. NECOFS GoM3 | its grid |
  | 3 | **Copernicus Marine SMOC** (below) | worldwide, 80°S–90°N |
  | 2 | NOAA Global RTOFS, depth-averaged `ubaro`/`vbaro`, one regional product | the product's box |
  | 0 (from the file) | FES2014 harmonic extract `.npz` | its grid |

  **SMOC** is product `GLOBAL_ANALYSISFORECAST_PHY_001_024`, dataset
  `cmems_mod_glo_phy_anfc_merged-uv_PT1H-i_202211`: hourly surface
  currents merging the Mercator 1/12° circulation model, FES2014 tidal
  currents and Stokes drift (`utotal`/`vtotal`, m/s), from 2020-11-01 to
  about 10 days ahead, updated once a day. It is read anonymously (no
  account) from the Copernicus Marine ARCO Zarr v2 stores on
  `s3.waw3-1.cloudferro.com` (`timeChunked.zarr`: 1 h × 512 × 2048-cell
  chunks; `geoChunked.zarr`: 4272 h × 16 × 8-cell chunks;
  `downsampled4.zarr`: 1/3°, one chunk per hour for the globe), with the
  chunks' Blosc/LZ4 compression decoded in TypeScript
  (`src/data/blosc.ts`, `src/data/zarr.ts`). Each load takes the layout
  with the lower estimated download (a small box over many hours comes
  from `geoChunked`, a wide area from `timeChunked`).
  - *Resident area:* the vessel's position (Signal K
    `navigation.position`) ± the configured half-width (15°), every step
    from the current hour to the SMOC horizon (72 h) at 3 h (or 1 h)
    spacing, cropped from the decoded chunks and held as Float32 in
    SharedArrayBuffers: the data worker loads it and the route worker
    uses the same memory. It is rebuilt when the window moves on a step,
    when the vessel has moved more than a third of the half-width, or
    for a new run.
  - *On demand:* before a route (route worker) or an overlay /
    conditions query (data worker) whose box the resident area does not
    cover, the plugin loads that box first: all window steps for a
    route or a conditions series, only the one or two steps around the
    requested hour for a map overlay (from the 1/3° store for zoomed-out
    views, lattice ≥ 0.25°). A single area is capped at 128 MB (a route
    box too large at 1/12° is loaded at 1/3°). On-demand areas are not
    kept for long: the route worker releases its route areas when the
    route ends, and the data worker keeps at most 16 MB of areas loaded
    for map / conditions queries (least recently used first; measured on
    a Pi 5 NVMe, 2026-09-28: a map view's area is 0.0–0.2 MB decoded, and
    decoding one again from the disk cache takes 25–89 ms). Overlay queries wait at most
    60 s; a slower load finishes in the background and serves the next
    request. Without a vessel position nothing is resident and
    everything loads on demand.
  - *Runs and cache:* compressed chunks are cached under
    `<data dir>/smoc/<run>/`, where the run is the last hour on the
    store's time axis (it advances by 24 h each day). On every refresh
    tick the plugin reads the 12 kB `.zmetadata` and the STAC record;
    a new run is used once STAC reports the update finished
    (`admp_updated_data` later than the metadata rewrite, no
    `admp_updating_start_date`), the resident area is downloaded again,
    and the previous run's cache is deleted. Offline, the newest cached
    run is used.
  - *Sampling:* bilinear on the 1/12° grid (seamless across the
    antimeridian), linear in time between steps with a ±1 h grace at the
    ends, like RTOFS. Cells the model leaves empty (land, and roughly the
    first cell off the coast) are "no data".
  - *Measured* (2026-09-28, ±15° box = 367 × 367 cells, 72 h): 26 steps
    at 3 h: 181.8 MB download (English Channel, 208 chunks, 9 s on a fast
    line) or 110.9 MB (US East Coast, 104 chunks), 28 MB resident; 74
    steps at 1 h: 219.5 MB (English Channel, from `geoChunked`) or
    315.6 MB (US East Coast), 79.7 MB resident. A one-hour overlay of a
    1.5° × 1° box outside the resident area: 2.7 MB (2 chunks); a
    conditions series at a point: 0.64 MB (4 `geoChunked` chunks, which
    hold every hour of the run). Decoding runs at about 400 MB/s.

  **Coastal display extension.** A ~9 km model has no value in the cells
  next to the coast, so drawn currents would stop short of the
  shoreline. For the map layers only (`/api/field?layer=current` and
  `/api/currents`), SMOC and RTOFS fill an empty grid cell that has
  valid cells within 2 grid cells from those cells (inverse-distance²
  weights, no fade; valid cells never change), so colour and arrows
  reach the coast, where the page's screen-resolution land mask cuts
  them. Routing, the conditions popup and the sea-state layer use the
  raw values only.

  **Attribution and licence.** SMOC is *Generated using E.U. Copernicus
  Marine Service Information; https://doi.org/10.48670/moi-00016*. The
  Copernicus Marine licence
  (https://marine.copernicus.eu/user-corner/service-commitments-and-licence)
  grants the licence free of charge (section 2.1) as a worldwide,
  non-exclusive, royalty-free, perpetual licence to use the products and
  to create and distribute value-added products or derivative works
  "for any purpose" (2.2), with the credit above, which the page shows
  in the map's attribution while a current layer is on (2.3–2.4). The
  products come without warranty (4). The service commitments state the
  service is free of charge until the end of the current Copernicus
  Marine Service phase, planned for 30 June 2028.

- **Tides and water level: Copernicus Marine hourly sea level.** Same
  product (`GLOBAL_ANALYSISFORECAST_PHY_001_024`), dataset
  `cmems_mod_glo_phy_anfc_merged-sl_PT1H-i_202411`: 1/12°, 80°S–90°N,
  hourly from 2022-09-01 to about 10 days ahead, updated daily (source
  attribute "MERCATOR GLO12, FES2014"). Read anonymously from the same
  ARCO Zarr stores with the same run detection, disk cache and layouts
  as SMOC (shared code in `src/data/arco.ts`; `src/tides/`). Variables
  used, in metres:
  - `ocean_tide`: the FES2014 ocean tide, "tidal sea surface height
    above mean sea level", i.e. the tide relative to the sea floor, as a
    tide gauge records it. `tide_loading` (sea-floor displacement under
    the tidal load) is **not** added: a gauge and the land move with the
    loaded crust, so the height a mariner sees is the ocean tide alone;
    ocean + load tide (geocentric) matters only for satellite altimetry.
    `total_sea_level` does not include it either.
  - `total_sea_level`: height above the geoid = `ocean_tide` +
    `invert_barometer` + `sea_surface_height` (GLO12 dynamic sea level,
    which includes the mean dynamic topography) +
    `global_mean_steric_variation` + `global_mean_mass_volume_variation`
    (product user manual CMEMS-GLO-PUM-001-024 issue 2.4 and the
    variable's long_name; checked on the data: the sum matches to the
    product's 1 mm quantisation).

  Derived quantities, SI metres **relative to local mean sea level**:

  | Field | Formula |
  |---|---|
  | tide height `tide_m` | `ocean_tide` |
  | MSL offset | mean(`total_sea_level` − `ocean_tide`) over the mean window |
  | surge (non-tidal residual) `surge_m` | `total_sea_level` − `ocean_tide` − offset |
  | total water level `water_level_m` | `total_sea_level` − offset = tide + surge |

  The mean window is every hourly sample of the geoChunked time chunks
  covering the last 60 days of the run (60 to ~210 days: a geo chunk
  holds 3648 h and is downloaded whole anyway), so the offset is fixed
  for a run and place. It removes the geoid-to-MSL separation (mean
  dynamic topography, e.g. −0.44 m at Newport RI, +0.15 m at Sydney) and
  the seasonal mean; the surge is the departure from that recent mean:
  weather set-up, inverse barometer and shorter dynamic signals. Over
  the last 130 days its standard deviation was ~8 cm at Newport and
  Sydney, correlating with the inverse barometer (r = 0.37 and 0.68).

  *Point series* (conditions popup, Weather API): from the geoChunked
  store, bilinear from the 4 surrounding cells; a corner that is model
  land takes the IDW² mean of valid cells within 2 cells and the value
  is flagged `tide_extrapolated`. No valid cell within 2 cells (~18 km)
  → no tide data (e.g. Southampton: the Solent is land at 1/12°). High
  and low waters are those of the tide height: local extrema of the
  hourly samples (pairs less than 3 cm apart dropped), refined with a
  parabola through each extremum and its neighbours; range = mean of
  consecutive high−low differences. Tendency: rising / falling, steady
  within ±2 cm/h. Measured: 0.9–6.7 MB and 0.2–1.5 s per new place (2
  variables × 1–4 chunks of ~0.3–1.6 MB; the whole 3120-hour chunk),
  then served from memory (8 places) or disk for the rest of the run.

  *Tide-height map layer* (`/api/field?layer=tide`): `ocean_tide` only,
  hourly (a 3-hourly step would err by up to ~30 % of the amplitude
  mid-step). A resident area around the vessel (± `tides.halfWidth`,
  default 15°) over now → `tides.horizon` (default 24 h), its start
  aligned to 6 h so it is rebuilt four times a day; views elsewhere load
  their hour on demand (1/3° grid for zoomed-out views); at most 16 MB
  of those on-demand hours are kept between queries. Measured at 15° around Newport: 368 × 368 cells × 31 hourly
  steps, 16.8 MB in memory, 62 timeChunked chunks = 39.9 MB downloaded
  in 3.5 s (about 1.3 MB per hour of window; a new daily run re-downloads
  it). One on-demand hour: 0.74 MB (1/12°, Sydney) or 0.53 MB (1/3°,
  most of the North Atlantic). The same 2-cell coastal extension as the
  current layers is applied for display; the page's land mask clips it.

  **Datum and accuracy caveats.** Heights are relative to **mean sea
  level, not chart datum** (LAT / MLLW): add the local chart-datum-to-MSL
  difference yourself; **not for under-keel clearance**. The model is
  ~9 km: in bays, estuaries and harbours the tide can be earlier and
  smaller than local tide tables (see the Newport check under
  Verification: highs 14–17 cm low and ~1 h early; lows within 2 cm and
  ~30 min early), and small basins may not exist in the model at all.
  Credit: *Generated using E.U. Copernicus Marine Service Information;
  https://doi.org/10.48670/moi-00016* (shown in the map attribution while
  the tide layer is on, and under the Tide chart).

## Using the webapp

- **Planning.** Click the map for the menu: set or move the start, set or
  move the destination, **Add waypoint here** (the clicked point becomes
  the destination and the old destination becomes the last waypoint, so
  waypoints stay in placing order), or **Conditions here**. Holding on
  the map does the direct action (start, then destination, then extend
  the course). Drag any pin to move it. Holding on a computed route pins
  that point as a waypoint.
- **Waypoint behaviour** (Setup tab): **Precision** Precise (each leg
  ends exactly at its waypoint) or Approximate (a leg ends on entering
  the circle around the waypoint and the next leg starts there), and
  **Waypoint radius** 50–2000 m, default 200 (Approximate only). See
  [Waypoints](#waypoints-legs).
- **Layers** (Base / Weather / Water): each layer is named for the
  quantity it shows. Colour layers are exclusive (one at a time) and are
  cut at the coastline with a screen-resolution land mask from
  `/api/land-mask`. The tide colour scale stretches to the largest tide
  in view (at least ±0.5 m). On the tide and current layers, water the
  source model has no value for (narrower than its ~9 km grid) is hatched
  and labelled "no model data".
- **Conditions popup** (shift-click, or the menu): 72-hour charts for
  Wind, Waves, Sea state (index / Beaufort / Douglas), **Tide & current**
  (tide height, total water level and surge on the left axis; current
  speed as a filled area on the right axis; the current's set as arrows;
  high and low water marked), Pressure, Temp, Precip, and a Raw table.
  Click the chart to move every map layer to that hour.
- **Polars**: the picker lists the default polar and the polars
  directory; "Create polar from boat specs…" generates one.
- **Settings tab**: the web-app settings below, in the selected units.
- The page references its scripts with `?v=<tag>`, a tag that changes
  whenever a file in `public/` changes, so browsers and proxies in front
  of Signal K always load the current scripts after an update.

## Routing engine

A port of the routePlanning `OceanPropagator` (subsector isochrone,
Hagiwara 1989 / Chen & Mao 2024), guided by a corridor from a global
water grid:

1. **Corridor.** A* on the [global water grid](#global-water-grid) finds
   a land-avoiding corridor from the start to the end of each leg (see
   [Waypoints](#waypoints-legs)), wherever the water path goes (Lisbon → Palma goes south through
   the Strait of Gibraltar, far outside the box around the endpoints).
   The route's land raster, the CMEMS SMOC area loaded for the route and
   the first-boot forecast crop cover the corridor's box plus 1°.
2. **Consistency with the route raster.** A flood fill on the route's
   (conservative) land raster, inside a band of grid cells along the
   corridor, must connect start and end. Where it stops, because the
   raster's resolution closes a passage the grid keeps open, the raster
   is refined locally (a finer patch, down to 0.0005°) and the fill
   repeated. A passage still closed at 0.0005° is not navigable for this
   router: its grid cells are blocked and A* runs again (up to 12 times).
   Narrow stretches of the corridor (a passage under 10 raster cells
   wide) are refined the same way so the isochrones have room, and
   stretches under 8 km wide are re-traced on the route raster (a fine
   A* kept to mid-channel), because the grid's 2 km cells cannot place
   the skeleton inside a 700 m strait.
3. **Isochrones.** From each retained parent, 2m+1 candidate headings
   are projected one stage step ahead, aimed at the corridor point one
   step ahead; candidates whose great-circle leg touches land are
   dropped; survivors are timed by a leg simulator that samples wind and
   the polar every `simStepM` metres (mode policy `sail_max`, `fastest`
   or `motor`). Candidates are binned by cross-track offset into 2k
   subsectors and the cheapest per bin is kept.
4. **Narrow passages.** The corridor carries the across-track water
   width at every point. A parent's step never jumps past a point where
   the passage is narrower than a quarter of the step: it may step up to
   that point, and inside the passage it steps at most 4 × the local
   width (not below 1 km); the stage budget grows by the stages this
   costs. Inside a stretch narrower than one subsector bin, candidates
   are binned across the passage (6 bins over its width) instead of by
   the start → end offset, so several branches get through a strait
   (in the test runs Madeira → Cartagena kept 8–12 branches through
   Gibraltar, where it used to get down to 1).
5. **Automatic vias.** Where the corridor crosses a narrow passage the
   grid build recorded (below) that is narrower than one stage step, a
   soft via (a pass-through disc of radius half the width + 500 m, at
   least 1 km) is placed at its narrowest point, so every branch is
   pulled through the passage instead of drifting against the coast
   beside it. Progress messages name them ("auto via at Strait of
   Gibraltar, width 14.2 km"); the GeoJSON lists them in the
   `auto_vias` property and the job summary in `auto_vias`. They are not
   route waypoints and never carry `role: "via"`.
6. **Finish.** The search stops when a branch that crossed every
   automatic via is within one (local) stage step of the leg's end with a
   land-free straight final leg (or, for an approximate waypoint, as soon
   as a branch is inside the waypoint's circle); the terminal is chosen
   among those with a clear final leg. If the planned stages run out
   first, up to K/2 more run.

### Waypoints (legs)

A waypoint is an end point and a start point by another name: it ends
one leg and starts the next (port of the routePlanning
`compute_multi_leg_route`). Each leg is routed as its own route, with its
own corridor, land raster, isochrone search (K stages per leg) and
retries, departing at the previous leg's arrival time so wind, current
and waves move on with the boat. The legs are then stitched: the
duplicate junction point is dropped, distances and sailing/motoring
times are summed, and the junction point of each waypoint carries
`role: "via"` in the GeoJSON (automatic vias stay in `auto_vias` and are
never `role: "via"`). Progress messages are prefixed `leg 2/4: …`.

`precision` decides where an intermediate leg ends:

- **`precise`** (default): exactly on the waypoint (a straight final leg
  from the last stage to the point, checked against land and simulated
  like the final leg to the destination).
- **`approximate`**: as soon as the route enters the waypoint's circle
  (`arrival_radius_m`, default 200 m, or the waypoint's own `radius_m`):
  the leg stops when a branch is inside the circle; if the search instead
  stops within one stage step of the waypoint (the reference's fallback),
  the straight final leg goes only as far as the circle. The next leg
  starts where the route entered the circle.

The final destination is always exact. Routes without waypoints are one
leg, unchanged. Where this differs from the reference: its next leg
starts from the canonical waypoint and the stitch trims the points inside
the circle; here the next leg starts at the circle entry, so the track is
continuous. The reference's merging of consecutive approximate ocean legs
into one search with via discs is not ported (that single search with
discs is what failed on routes with waypoints before).

The forecast area and the CMEMS SMOC area are read per leg (the leg's
corridor box plus the margin) and released after the leg; everything is
released when the route ends. On brain (Pi 5) one area for all legs took
the same time (Baja, 4 legs: 11.9 / 12.0 s against 11.5 / 11.8 s per leg)
and held more forecast (3.0 MB against at most 2.0 MB per leg) and SMOC
(2.5 MB against at most 0.9 MB).

One deliberate difference from the reference: the stage budget is sized
to the corridor length, not the straight-line distance, so detours around
land fit within the configured number of stages.

If a route arrives after the last forecast step, conditions are held at
the last step and the GeoJSON carries `forecast_horizon_exceeded_s`.

### Global water grid

`data/water-grid-0.02.bin.gz` (shipped, 1.49 MB) is a navigability graph
of the whole world at 0.02° (18000 × 9000 cells), built from GSHHG full
resolution L1 (`GSHHS_f_L1.shp`):

- **Water and edges.** The coastline is rasterised at 0.005° (4 × 4 fine
  cells per grid cell) in 10° tiles with a 1.2° halo, so edges on tile
  borders and across the antimeridian see the neighbouring tile. A fine
  cell is water when its centre is outside every polygon. Per grid cell
  the file stores a water bit and two edge bits (east, north). An edge is
  open when a 4-connected path of fine water cells inside the two cells
  crosses it, i.e. when some fine row (or column) has water on both
  sides. A plain "any water in the cell" rule closed the Bosphorus (a
  one-cell thread crossing cells corner to corner); the edge rule keeps
  it open. Diagonal fine contacts do not count: on the conservative
  raster the Bosphorus is closed even with diagonal connectivity, while
  centre sampling with 4-connectivity keeps it open and keeps every
  isthmus in the checks below closed.
- **Split cells.** Where a cell's fine water forms two components that
  both touch its border (the two shores of a spit or isthmus thinner
  than a cell), the grid stores the component of each border fine cell
  and which fine rows cross to each neighbour (57 759 cells worldwide),
  and the search follows components through them. Without this the grid
  leaked across such strips.
- **Moves.** A* moves to the four neighbours through open edges, and
  diagonally only where both L-shaped paths through the two side cells
  are open (never through a split cell), so a diagonal never cuts a land
  corner. Cost is distance times a coast penalty (up to 1.4× next to
  land, fading out 4 cells off), with a heuristic weight of 1.1 (corridor
  cost at most 10 % above optimal; measured +0.3 %). The search window
  grows from the legs' box until the path is found (at most 12 M cells,
  about 84 MB while it runs) and wraps round the antimeridian.
- **Narrow passages.** Per grid cell the build takes the largest
  distance to land of its fine water cells (the clearance) and runs a
  merge tree in local windows (2° cores, 1° margin): cells are added
  from the widest water down, and a cell that joins two basins whose
  widest water is at least 1.5× its own clearance (and 500 m wider, and
  basins at least 2 km wide) is a passage's narrowest point. Windows are
  local on purpose: Messina joins the Tyrrhenian and the Ionian, which
  also connect round Sicily. 4987 passages up to 40 km wide are stored
  with position, width and channel axis; names come from a table of
  well-known straits.
- **Canals.** Known ship canals (Corinth, Cape Cod, Chesapeake and
  Delaware, Kiel, Suez, Panama) are stored as the edges their cut lines
  cross, closed unless **Allow canals** is on. With GSHHG none of them is
  open water at 0.005° (Cape Cod and Corinth only look open when a test
  box lets the water go round the cape or the Peloponnese); three edges
  near the Panama Canal's approaches are recorded, but the canal is
  closed anyway. The setting matters with coastline data that includes
  canals (e.g. OSM land polygons).
- **Memory and loading.** The route worker loads it once (about 20 ms
  to decompress, into one buffer): 62.9 MB of arrays (three 20.25 MB bit
  planes, 1.3 MB of split cells, the passage list) plus 2.3 MB of lookup
  maps; measured process RSS +73 MB. The data worker does not load it.
- **Rebuilding.** The file records the shapefiles it was built from
  (name, size, modification time and a SHA-256 of the size and the first
  and last MiB). When the configured `landShapefiles` differ (another
  GSHHG resolution, L6 Antarctica added, OSM land polygons), the route
  worker keeps routing with the shipped grid and rebuilds a matching one
  in a background thread into the plugin data directory, then switches
  to it. A rebuild needs about 400 MB while it runs (checked against
  "memory kept free" first) and took 74–79 s for GSHHG full L1 and 47 s for
  GSHHG high on an Apple M3; not measured on a Raspberry Pi 5 (expect
  several minutes). To rebuild the shipped file:
  `npm run build:water-grid -- --land /path/GSHHS_f_L1.shp`;
  `npm run check:water-grid` runs the connectivity checks.

## Install

```sh
cd signalk-weather-router-plus
npm install
npm run build
npm link
cd ~/.signalk        # your Signal K config directory
npm link signalk-weather-router-plus
```

Restart Signal K, enable the plugin, and configure at least the coastline
shapefile path. The package carries the `signalk-webapp` keyword and a
`public/` folder, so after the restart the webapp appears on the Admin UI's
Webapps page. Writes (computing, cancelling, publishing) need a `readwrite`
login; the page redirects to the server login when it gets a 401. A polar file (`.csv` or `.pol`, knots) enables sailing;
without one every route is motor-only.

## Configuration

Settings are split in two.

**Signal K plugin configuration** (Admin UI → Server → Plugin Config):
installation settings only.

| Field | Notes |
|---|---|
| `landShapefiles` | comma-separated absolute paths |
| `polarFile` | `.csv` (`twa/tws,4,6,…`) or `.pol` (tab-delimited); the default polar (token `default`) |
| `polarsDir` | directory of `.pol`/`.csv` polars listed by `/api/polars`; needed to pick a named polar per route |
| `currents.harmonicDir` | directory of tidal-harmonic `.npz` files |
| `forecast.mirror` | `ecmwf`, `aws` or `google` |
| `weatherProvider.enabled` | register with the Weather API (default on) |

**Web-app settings** (the webapp's **Settings** tab, or `GET`/`PUT
/api/settings`): stored on the server in `settings.json` in the plugin
data directory and shared by every client. Values are SI on the wire
(m, m/s, s; degrees for the heading increment); the page shows them in
the Signal K user's unit preferences. Saving needs a `readwrite` login.

| Group | Settings (default) | A change… |
|---|---|---|
| `vessel` | name, draught (1.8 m), air draft (16 m), LOA (11 m), beam (3.7 m), under-keel margin (0.5 m), overhead margin (1 m), speed under power (6 kt = 3.087 m/s), max wave height (none), tack penalty (30 s), polar performance (1 = 100%, 0.3–1.2) | applies to the next route |
| `forecast` | horizon (72 h = 259200 s, 3–240 h), check interval (60 min), cached cycles kept (2), extra fields (on), memory kept free (1 GB = 1e9 B) | horizon / extra fields / memory kept free reload the forecast; the interval restarts the timer |
| `currents` | SMOC on, SMOC horizon (72 h = 259200 s, 6–240 h), SMOC step (3 h = 10800 s; 1 h or 3 h only), SMOC area half-width (15°, 2–30°), RTOFS on, RTOFS product (`west_atl`, …), RTOFS horizon (72 h), RTOFS step (3 h) | reloads currents |
| `tides` | Copernicus Marine sea level on, tide map area half-width (15°, 1–30°), tide map horizon (24 h = 86400 s, 6–240 h) | reloads tides only |
| `routing` | stages (20), subsectors (30), headings (30), heading increment (1°), sail threshold (4.9 kt), simulation step (200 m), land raster cell budget (25 M), allow canals (off), route simplification (10 m, 0 = off), shortcut smoother (on), shortcut may be slower by (0.05 = 5%), finished routes kept (50) | applies to the next route |
| `publish` | save to the Resources API (on), route name prefix (`WRP`), notifications (on) | applies to the next route |

**Resource guard.** The decoded forecast is on disk, so the guard
checks what actually needs memory. Before a forecast update: the
streaming decoder's one-step block and buffers (66 MB with the extra
fields) against the memory available now (Linux `MemAvailable`, bounded
by a cgroup (container) limit, or reclaimable pages from `vm_stat` on
macOS), leaving "memory kept free"; and the decoded run's exact size
(fields × steps × 4.15 MB) against the free disk space, leaving 1 GB.
Before a route: its corridor store (area × 5 fields × steps × 4 B)
against available memory. If something does not fit, it does not run;
the Signal K plugin status and the page's status line say how much is
needed and available and what would fit (extra fields off, a shorter
horizon, a lower setting, free disk space), and the run in use keeps
serving. A settings change that would not fit is rejected before it is
saved. The global water grid
(about 65 MB in the route worker) is loaded at start-up, so it is already
counted as used; a water grid rebuild is checked the same way before it
starts.

`PUT` takes only the keys to change, e.g. `{"vessel": {"draught": 1.9}}`,
validates all of them (same ranges and enums as before), and either saves
all or returns `400 {errors: {"vessel.draught": "…"}}` and saves nothing.
Per-route values in a route request (`vessel.*`, `stages`,
`sail_thresh_ms`, `publish`) still take precedence over the settings.

Upgrading from a version that kept these in the plugin configuration: on
the first start without `settings.json`, the old values are migrated
(knots converted to m/s, hours and minutes to seconds) and written to
`settings.json`; after that the old keys are ignored. The Signal K
configuration file is not modified. `forecast.region` and
`forecast.regionFromVesselDeg` are gone: the forecast is global.

## API

```
POST /plugins/signalk-weather-router-plus/api/routes
{
  "start": {"lat": 41.44, "lon": -71.36},
  "end":   {"lat": 32.42, "lon": -64.58},
  "waypoints": [{"lat": 41.13, "lon": -71.53}],
  "precision": "precise",
  "arrival_radius_m": 200,
  "departure": "2026-09-28T12:00:00Z",
  "mode": "sail_max",
  "name": "Newport to Bermuda",
  "vessel": {"polar": "a_boat.pol"}
}
→ 202 {"id": "…", "status": "queued", "links": {…}}
```

`waypoints` (at most 20) end one leg each ([Waypoints](#waypoints-legs)).
`precision` is `"precise"` (default: each leg ends exactly on its
waypoint) or `"approximate"` (a leg ends on entering the waypoint's
circle). `arrival_radius_m` is that circle in metres (default 200,
0..5000, must be > 0 with `"approximate"`); a waypoint's own `radius_m`
(0..5000) overrides it for that waypoint. Both are ignored in precise
mode and for the destination, which is always exact. The job summary of
a route with waypoints carries `legs` and `precision`.

`vessel.polar` is a token from `GET …/api/polars`. A file name such as
`a_boat.pol` resolves only inside the configured `polarsDir`. Use
`"default"`, or omit the field, for the configured `polarFile`.

`vessel.polar_performance` (ratio, 0.3..1.2) is the share of the polar's
boat speeds the boat makes under sail; it overrides the vessel setting
of the same name (default 1, the polar as written). Every boat speed in
the polar is multiplied by it before the sail/motor choice, so a lower
value also means more motoring; motor speed is unchanged. Polars are
usually race predictions (flat water, racing sails, full crew), so a
loaded cruising boat is slower than its polar. The job summary carries
`polar_performance` when a polar was used.

`POST …/api/polar-from-specs` (readwrite) takes `{name, specs, overwrite?}`
with the routing server's boat-spec fields (`loa_m`, `lwl_m`, `beam_m`,
`draft_m`, `displacement_kg`, `sail_area_upwind_m2`, optional `ballast_kg`,
`sail_area_downwind_m2` (not used: no spinnaker is assumed), `mast_height_m`,
`rig_type`, `keel_type`, `hull_type`). It runs the physics polar calculator
(`src/vessel/vpp_physics.ts`: ORC 2026 sail forces, Delft hull resistance,
a heeling limit; see `docs/plans/vpp-physics.md`), writes
`<polarsDir>/user/<slug>.csv` in the routing server's CSV layout and returns
`{path, label, warnings, polar}`, where `path` (`user/<slug>.csv`) is a
`vessel.polar` token. 400: invalid specs, bad name, or no `polarsDir`;
409: the file exists and `overwrite` is not true; 422: a multihull, which
the calculator does not model. Against 441 ORC 2026 non-spinnaker
certificates it was not fitted on, its median error is 3.3% upwind, 3.2%
reaching and 3.3% running (6–20 kn). ORC's speeds are race predictions;
use the polar performance setting for a cruising boat. In the webapp, use "Create polar from
boat specs…" under the polar picker.

```

GET  …/api/routes/{id}          status, progress, summary
GET  …/api/routes/{id}/events   SSE: status, progress, route, done, error (Last-Event-ID honoured)
GET  …/api/routes/{id}/result   GeoJSON FeatureCollection (LineString + one Point per waypoint)
GET  …/api/routes/{id}/signalk  Signal K route record
POST …/api/routes/{id}/cancel
POST …/api/routes/{id}/publish
GET  …/api/forecast?lat=&lon=   forecast metadata and a time series at a position (every step)
GET  …/api/settings             web-app settings {values, schema} (SI)
PUT  …/api/settings             change some settings (readwrite)
GET  …/api/polars               polar library: the configured default + every .pol/.csv in the polars directory
GET  …/api/polar-angles?path=   best upwind/downwind VMG angles per TWS (point-of-sail bucketing)
GET  …/api/polars/table?path=   polar speed table in m/s for drawing
POST …/api/polar-from-specs     generate a polar from boat specs (physics calculator) → <polarsDir>/user/<slug>.csv
GET  …/api/legends              colour ramps (SI stops) for every overlay
GET  …/api/field?layer=&bbox=&time=&res=      JSON grid for a heatmap layer (wind, waves, msl, temperature, sst, precip, sea_state, current, tide → tide_m in m above MSL)
GET  …/api/wind-points?bbox=&time=&res=       barb points
GET  …/api/currents?bbox=&time=&res=          current arrow points
GET  …/api/pressure?bbox=&time=&interval=     isobars + H/L as GeoJSON
GET  …/api/conditions?lon=&lat=&from=&hours=  72-hour conditions series at a point, with tide_m / water_level_m / surge_m /
                                              tide_extrapolated / tide_tendency per row and `tides` {highs, lows, range_m, …}
GET  …/api/land-mask?bbox=&w=&h=               land mask at screen resolution: gzip bytes, one per pixel (1 = land), row 0 north
POST …/api/forecast/refresh      check for a new cycle (?force=true decodes the current one again from the GRIB cache)
GET  …/api/status               forecast: decoded run (decoded_dir, decoded_bytes, decoded_disk_bytes, grib_cache_bytes, source disk|grib,
                                last_decode) and memory actually held (memory.data_worker_held_bytes, route_worker_held_bytes, …); process_rss_bytes
```

All values are in Signal K SI units: metres, m/s, Pa, K, seconds, degrees
true. Dimensionless quantities are plain ratios or indices: relative
humidity is 0..1 (`rh`), Beaufort and Douglas are integers with a label,
and the sea-state index is a number to one decimal place with a label. Precipitation is a depth rate in m/s
(`precip_rate_ms`); ECMWF's kg m⁻² s⁻¹ is converted once, when the field
enters the forecast store, so every endpoint agrees. The Weather API
omits precipitation volume, because only the instantaneous rate is fetched.
Nothing is sent in percent, knots or mm/h; the client converts.
On Signal K 2.31+ reads are open to `readonly` users and writes to
`readwrite`; older servers keep every plugin route admin-only.

## CLI

```sh
wrp-route --start 41.44,-71.36 --end 32.42,-64.58 \
  --land /path/GSHHS_f_L1.shp --polar catalina36.csv \
  --mode sail_max --hours 72 --cache ./ecmwf-cache -o route.geojson
```

`--no-forecast` routes with calm wind; `--via "lat,lon[@radius_m];…"` adds
waypoints (each ends a leg), `--precision precise|approximate` (default
precise) and `--radius <m>` (approximate circle, default 200; `@radius_m`
overrides it per waypoint).
The corridor uses `data/water-grid-0.02.bin.gz` (or a rebuilt grid matching
`--land`); `--water-grid <file>` picks another, `--no-water-grid` uses the old
per-route skeleton, `--allow-canals` opens the known canals.

## Verification

- Water grid: `npm run check:water-grid` floods the grid between point
  pairs inside tight boxes (so going round an island or peninsula does
  not count). Open: Gibraltar, Messina, Bonifacio, Dover, Dardanelles,
  Bosphorus, Øresund, Bab-el-Mandeb, Hormuz, Singapore, Magellan, Kerch.
  Closed with canals blocked (and still closed with canals allowed, since
  GSHHG has no canal water): Corinth, Cape Cod, Panama, Suez, Kra, Kiel,
  Chesapeake and Delaware, Perekop. `src/geo/watergrid.test.ts` and
  `src/engine/corridor.test.ts` cover the edge rule (a one-cell staircase
  thread, a diagonal-only contact, one-sided slivers), split cells, tile
  border and antimeridian edges (a synthetic shapefile built with the
  real builder), A* (walls, blocked cells, corner cutting, antimeridian
  wrap), the chokepoint merge tree, canal blocking, local refinement and
  re-routing round a passage closed on the route raster.
- Routes (CLI, GSHHG full, Apple M3). Motor, no forecast:

  | Route | Distance | Waypoints | Duration | Corridor A* | Total | Auto vias |
  |---|---|---|---|---|---|---|
  | Lisbon → Palma | 742.2 nm | 23 | 123.7 h | 155 ms | 0.9 s | Gibraltar |
  | Madeira → Cartagena | 846.7 nm | 22 | 141.1 h | 233 ms | 1.0 s | Gibraltar |
  | Cape St Vincent → Alboran | 357.8 nm | 21 | 59.6 h | 78 ms | 0.6 s | Gibraltar |
  | Aegean (39.45 N 25.0 E) → Black Sea | 311.5 nm | 35 | 51.9 h | 63 ms | 1.0 s | Dardanelles ×4, Bosphorus |
  | Tyrrhenian → Ionian | 180.9 nm | 22 | 30.1 h | 75 ms | 0.7 s | Messina |
  | Newport RI → Horta | 1955.7 nm | 26 | 326.0 h | 150 ms | 1.5 s | unnamed passage 41.47 N 70.02 W (17.2 km, east of Nantucket Sound) |
  | Singapore Strait (1.5 N 103 E → 1.5 N 105 E) | 127.0 nm | 21 | 21.2 h | 43 ms | 0.6 s | Singapore Strait |
  | Lisbon → Helsinki | 2176.3 nm | 38 | 362.7 h | 1550 ms | 4.8 s | Dover; 57.42 N 11.46 E (Kattegat); Øresund; 59.76 N 24.44 E (Gulf of Finland) |

  `sail_max` with the ECMWF 2026-09-28 00z forecast (72 h, Catalina 36
  polar): Lisbon → Palma 782.7 nm, 220.1 h; Madeira → Cartagena
  886.1 nm, 226.8 h; Aegean → Black Sea 313.8 nm, 52.3 h; Tyrrhenian →
  Ionian 193.0 nm, 55.9 h; Newport → Horta 2044.4 nm, 419.8 h. Every
  route above has 0 legs crossing land in the exact polygon check.

- `npm test` runs the unit tests. The GRIB2/CCSDS decoder is checked
  against eccodes output stored in `test-data/` (full-array hash).
- The Blosc decoder is checked bit for bit against numcodecs (c-blosc
  1.21.6): a real SMOC `utotal` chunk and 25 synthetic frames covering
  byte / bit / no shuffle, split and unsplit blocks, several blocks with
  a partial last one, raw streams, memcpyed chunks and typesizes 1–8
  (`test-data/blosc/`, regenerated by `tools/gen_blosc_fixtures.py`).
  Against the live store, 154 downloaded chunks (409 MB decoded) matched
  numcodecs exactly, and SMOC samples matched xarray bit for bit at grid
  nodes and to 2.5e-6 m/s between them.
- `npm run test:corpus <dir>` compares the decoder value-for-value
  against an eccodes dump of any GRIB2 corpus (see `tools/verify_grib_corpus.ts`).
  On 30 ECMWF messages (12- and 16-bit, with and without bit maps) it
  matched all 31,147,200 cells exactly.

- Sea level: `src/tides/sealevel.test.ts` compares point series at
  three coastal points (Narragansett Bay, Portsmouth, Sydney Harbour;
  all use the coastal fill) against an independent xarray decode of the
  real store (`test-data/sealevel/`, regenerated by
  `tools/gen_sealevel_fixtures.py`): tide, water level, surge and the
  MSL offset agree to < 1e-6 m. High / low extraction is checked against
  dense sampling of synthetic mixed and double-high tides (times within
  6 min, heights within 1 cm).
- Newport RI against NOAA CO-OPS 8452660 (datum MSL), run 2026100723,
  point 41.49 N 71.33 W (extrapolated from the model cells in Rhode
  Island Sound), 28 Sep – 1 Oct 2026, 15 high and low waters: lows
  within 2.4 cm and 15–33 min early; highs 14–17 cm low and 53–71 min
  early; mean range 1.09 m vs NOAA 1.25 m. Surge on 28 Sep: model
  +0.24 to +0.29 m vs NOAA observed − predicted +0.36 to +0.43 m
  (NOAA's MSL is the 1983–2001 epoch, so part of that residual is
  sea-level rise since, which the model's recent-mean offset removes).
  Total water level vs the observed 6-min level: 0.27 m RMS, −0.22 m
  bias (0.16 m RMS with the means removed).

## Limits

- Open water only. A start or end inside a narrow harbour can fail with
  "stage 1 has no live waypoints"; start from the harbour approach.
- Passages narrower than about 150 m (three 55 m cells of the finest
  local raster) are not navigable for the router; the corridor goes round
  them, or the route fails with a message naming the place when there is
  no way round. Corridors are searched on 0.02° cells: water enclosed at
  that resolution with no open water within 10 km cannot be reached.
- The corridor's box (plus 1°) may be at most 120° × 90°, and one leg's
  grid search at most 12 M cells (about 69° × 69°); longer routes need
  intermediate waypoints.
- Automatic vias fix the passage the corridor chose (e.g. Messina rather
  than round Sicily). If a sailing route would rather take another
  passage, set a waypoint in it.
- Canals are closed unless allowed, and with GSHHG none of the listed
  canals is open water anyway.
- No depth data.
- SMOC areas are loaded whole-chunk: a box outside the resident area
  costs its chunks' download (see the measured sizes above), cached for
  the rest of the day's run.
- Routes beyond the forecast horizon use the last step's conditions.
- One route computes at a time (single worker thread); others queue.
