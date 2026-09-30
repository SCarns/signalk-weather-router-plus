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

- **Forecast:** ECMWF IFS 0.25° open data, `oper`/`wave` streams for every
  cycle: 00z/12z to 360 h (every 3 h to 144 h, then every 6 h), 06z/18z to
  144 h. Fields: `10u`, `10v`, `msl`,
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
  ends exactly at its waypoint) or Approximate (one search carries the
  route through the circle around each waypoint instead of stopping at
  it), and
  **Waypoint radius** 50–2000 m, default 200 (Approximate only). See
  [Waypoints](#waypoints-legs).
- **Layers** (Base / Weather / Water): each layer is named for the
  quantity it shows. Colour layers are exclusive (one at a time). Colour
  layers, wind barbs and current arrows are drawn tile by tile from
  `/api/tile` (web-map tiles at whole hours, saved on the server, see
  [Map tiles](#get-apitilelayerzxy)); each colour tile is cut at the
  coastline with its own 256 × 256 coastline tile. Their time is the
  overlay time rounded to the hour. Isobars and flow lines are drawn for
  the whole view, from the same saved tiles (see [Map
  layers](#map-layers)). The tide colour scale
  stretches to the largest tide in the tiles loaded (at least ±0.5 m).
  On the tide and current layers, water the source model has no value
  for (narrower than its ~9 km grid) is hatched and labelled "no model
  data".
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
- **`approximate`**: the route only has to pass through the waypoint's
  circle (`arrival_radius_m`, default 200 m, or the waypoint's own
  `radius_m`). As in the reference (`hybrid.py`, collapsed ocean runs),
  consecutive legs joined by approximate waypoints are routed as **one
  search** from the run's start to its end, with each waypoint circle as
  a via the winning branch must pass through in order. The track carries
  on through the waypoint instead of ending there and restarting, and the
  point where it passes the circle carries `role: "via"`. Progress
  messages for such a run read `legs 1–3/3: … through 2 waypoint
  circle(s) … in one search`.

The final destination is always exact. Routes without waypoints are one
leg, unchanged. Where this differs from the reference:
- after a precise waypoint the next leg starts where the previous one
  ended (the reference restarts from the canonical waypoint and trims the
  stitch), so the track is continuous;
- a branch whose next waypoint circle is closer than one stage step also
  gets a candidate that steps straight into the circle. Without it a
  branch reaches a small circle only if a full stage step (tens of km)
  happens to cross it, which failed where the course turns at a waypoint
  (the Baja route in `docs/plans/waypoints-multi-leg.md`);
- if a one-search run still finds no branch through every circle, that
  run's legs are routed one by one (each ends on entering its circle and
  the next starts there) and the log says so, instead of the route
  failing.

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

Restart Signal K and enable the plugin. **Coastline:** with no coastline
shapefile configured, the plugin downloads GSHHG 2.3.7 (Wessel & Smith,
LGPL) once from the authors' site,
`https://www.soest.hawaii.edu/pwessel/gshhg/gshhg-shp-2.3.7.zip`
(149 MB), extracts the full-resolution level-1 shoreline
(`GSHHS_f_L1.shp` with its `.shx` and `.prj`, about 156 MB) into
`coastline/gshhg-2.3.7/` in the plugin data directory, deletes the
archive and starts; the plugin status shows the progress. The global
water grid shipped with the plugin was built from this same file, so it
is used as is. The download does not hold up the server's start-up; if
it fails (offline, server error, short file) the plugin status says why
and it is tried again every 10 minutes; stopping the plugin cancels it.
To use another coastline, or an existing GSHHG copy, set its path in the
plugin configuration. A configured coastline is never replaced by the
download: if a configured file is missing or unreadable, the plugin does
not start and its status names the file. The package carries the `signalk-webapp` keyword and a
`public/` folder, so after the restart the webapp appears on the Admin UI's
Webapps page. Writes (computing, cancelling, publishing) need a `readwrite`
login; the page redirects to the server login when it gets a 401. A polar file (`.csv` or `.pol`, knots) enables sailing;
without one every route is motor-only.

## Configuration

Settings are split in two.

**Signal K plugin configuration** (Admin UI → Server → Plugin Config):
installation settings only. The plugin ships its own configuration panel
(keyword `signalk-plugin-configurator`, `public/remoteEntry.js`), which
the Admin UI shows in place of the generated form: the coastline with a
**Download coastline** button and its progress (and **Use the downloaded
coastline** when a path is set), the map overlay cache with the radius
and window in the Signal K user's distance and time units (stored in m
and s; a unit that cannot be read shows "—" and cannot be edited there),
and the other options below. **Save** stores the configuration and
restarts the plugin. The panel is a hand-written Module Federation
container that uses the Admin UI's own React, so the package carries no
React and needs no build step for it.

| Field | Notes |
|---|---|
| `landShapefiles` | comma-separated absolute paths; blank = download GSHHG 2.3.7 full-resolution level 1 once (see [Install](#install)) |
| `polarFile` | `.csv` (`twa/tws,4,6,…`) or `.pol` (tab-delimited); the default polar (token `default`) |
| `polarsDir` | directory of `.pol`/`.csv` polars listed by `/api/polars`; needed to pick a named polar per route |
| `currents.harmonicDir` | directory of tidal-harmonic `.npz` files |
| `forecast.mirror` | `ecmwf`, `aws` or `google` |
| `weatherProvider.enabled` | register with the Weather API (default on) |
| `overlayCache.enabled` | build map tiles ahead of time (default on) |
| `overlayCache.radius` | m, around the boat and the map view at zoom 8 and below; halved at each deeper zoom (default 250000, 1000–2000000) |
| `overlayCache.window` | s, how far ahead tiles are built from now; 0 = the whole forecast (default 0, max 1296000) |
| `overlayCache.maxZoom` | deepest zoom built ahead (default 15, 6–18) |
| `overlayCache.diskCap` | bytes for saved tiles, least recently used removed first (default 20e9 = 20 GB, min 100e6) |
| `overlayCache.workers` | threads building tiles ahead (default 2, 1–8) |
| `overlayCache.followView` | also build around the area the map shows (default on) |

Stored in SI (metres, seconds, bytes); the configuration panel shows
the radius and window in the user's units and the disk cap in GB.
Tiles the page asks for are saved, whether or not tiles are built
ahead, except those computed while an on-demand current or tide area is
still loading: those are answered but not saved. What is built ahead of time: the colour layers the page
draws (wind, waves, sea state, current, rain, air temperature, sea
temperature, tide height), wind barbs, current arrows and coastline
tiles, for every hour from now to the end of the window (tide height:
to the end of the tide run), at zooms 6 to `maxZoom`. Order: the map
view's area, then the boat's; within each, nearest hour first, then
shallower zoom, then nearest the centre. Tiles already saved are
skipped. A new forecast cycle, currents run or tide run removes the
tiles made from the old one and the walk starts again; so do a new
hour, a boat move of more than 1 km, a new view and a settings change.
No new tile is started while a route runs or the map's own queries are
waiting. The boat's last position is kept in `last-position.json` in
the plugin data directory, so the boat's area is known after a restart
before a fix arrives.

**Web-app settings** (the webapp's **Settings** tab, or `GET`/`PUT
/api/settings`): stored on the server in `settings.json` in the plugin
data directory and shared by every client. Values are SI on the wire
(m, m/s, s; degrees for the heading increment); the page shows them in
the Signal K user's unit preferences. Saving needs a `readwrite` login.

| Group | Settings (default) | A change… |
|---|---|---|
| `vessel` | name, draught (1.8 m), air draft (16 m), LOA (11 m), beam (3.7 m), under-keel margin (0.5 m), overhead margin (1 m), speed under power (6 kt = 3.087 m/s), max wave height (none), tack penalty (30 s), polar performance (1 = 100%, 0.3–1.2) | applies to the next route |
| `forecast` | horizon (72 h = 259200 s, 3–360 h; above 144 h only 00z/12z cycles qualify), check interval (60 min), cached cycles kept (2), extra fields (on), memory kept free (1 GB = 1e9 B) | horizon / extra fields / memory kept free reload the forecast; the interval restarts the timer |
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

This section describes every HTTP endpoint of the plugin and what it
publishes into Signal K. It is written from `src/plugin/api.ts` and the
modules it calls. Another app (a dashboard, a chart plotter) can compute
routes, read overlays and read conditions with it alone.

### Overview

**Base path.** Every endpoint below is relative to
`/plugins/signalk-weather-router-plus` on the Signal K server, e.g.
`http://localhost:3000/plugins/signalk-weather-router-plus/api/status`.
The links the plugin returns (`links`, `Location`) are absolute paths
that start with this base path.

**Units.** All values are in Signal K SI units: metres, m/s, Pa, K,
seconds, degrees true. Dimensionless quantities are plain ratios or
indices: relative humidity is 0..1 (`rh`), Beaufort and Douglas are
integers (Douglas with a label, `douglas_label`), and the sea-state
index is a number to one decimal place with a label (`sea_state`).
Precipitation is a depth rate in m/s (`precip_rate_ms`); ECMWF's
kg m⁻² s⁻¹ is converted once, when the field enters the forecast store,
so every endpoint agrees. Nothing is sent in percent, knots or mm/h; the
client converts. Two exceptions, both named in the field: angles in the
plugin's own API are degrees (`*_deg`), while the Signal K Weather API
answers in radians as that API requires ([Weather API
provider](#weather-api-provider)); and the isobar interval of
`/api/pressure` is given and returned in hPa (`hpa`) beside Pa (`pa`).
Directions are named by their convention: wind and waves are the
direction they come FROM (`dir_from`, `wind_dir_deg`, `mwd_deg`),
currents the direction they flow TO (`dir_to`, `current_dir_deg`, the
`dir_deg` of `/api/currents`). Times are ISO 8601 strings in UTC.

**Access.** Authentication is done by the Signal K server (its session
cookie or a bearer token), not by the plugin. On Signal K 2.31 and
later (servers with `router.access()`), read endpoints are open to
`readonly` users and write endpoints to `readwrite` users; the Access
column of each table says which. Older servers keep every plugin route
admin-only, which is the server's default. When a request lacks the
access it needs, the server answers (401 not signed in, 403 not enough
access) before the plugin sees it. A route registered without an access
level stays admin-only on those servers (upstream `asPluginRouter`), so
every plugin route, `/ui` included, is registered with one.

**Errors.** Errors the plugin produces are JSON with a message:

```json
{"error": "bbox must be w,s,e,n"}
```

Some add fields: `GET /api/routes/{id}/result` adds `status` and
`message`, and `PUT /api/settings` adds `errors` (one message per
setting). A parameter or data problem is `400`; the per-endpoint tables
list the other codes. Overlay and conditions requests go to the plugin's
data worker; its failures (for example `no forecast loaded`,
`data worker not ready`, or `query timed out` after 120 s) also come
back as `400` with the message. While the plugin is stopped, the route
job endpoints answer `503 {"error": "plugin not started"}`.

A body that is not valid JSON never reaches the plugin: the Signal K
server parses bodies itself (`body-parser`) and has no JSON error
handler, so it answers with Express's default `400` page, in HTML, not
the JSON shape above.

**CORS.** The plugin sets no CORS headers of its own, apart from
exposing `X-Mask-Width` and `X-Mask-Height` on `/api/land-mask`
(`Access-Control-Expose-Headers`). Cross-origin access is whatever the
Signal K server allows.

**OpenAPI.** `GET /api/openapi.json` returns an OpenAPI 3.0 document of
the API. The same document is given to the Signal K server through the
plugin's `getOpenApi()`, so it also appears in the server's own API
documentation. It is a summary; where it and this section differ, this
section follows the code.

**Webapp.** `GET /ui` (and `/ui/`) serves the plugin's webapp; `GET
/ui/{file}` serves its scripts and styles; both need `readonly` access.
The webapp is also listed on the Admin UI's Webapps page and served by
the Signal K server at `/signalk-weather-router-plus/`.

### Quick start: compute a route from another app

The minimal sequence is: submit a job, wait for it to finish (Server-Sent
Events or polling), then read the result. The values below are examples.

```sh
BASE=http://localhost:3000/plugins/signalk-weather-router-plus
AUTH="Authorization: Bearer $TOKEN"   # a Signal K token with readwrite access
```

**1. Submit the job** and keep its `id` for the next steps (this uses
`jq`; without it, copy `id` from the response by hand):

```sh
ID=$(curl -s -X POST "$BASE/api/routes" -H "$AUTH" -H 'Content-Type: application/json' -d '{
  "start": {"lat": 41.44, "lon": -71.36},
  "end":   {"lat": 32.42, "lon": -64.58},
  "waypoints": [{"lat": 41.13, "lon": -71.53}],
  "precision": "precise",
  "departure": "2026-09-28T12:00:00Z",
  "mode": "sail_max",
  "name": "Newport to Bermuda",
  "vessel": {"polar": "a_boat.pol"}
}' | jq -r .id)
echo "$ID"
```

Response `202 Accepted`, with a `Location` header equal to `links.self`:

```json
{
  "id": "5b0f3c2e-8d1a-4c7e-9f7b-2a6d1e0c9a41",
  "status": "queued",
  "links": {
    "self": "/plugins/signalk-weather-router-plus/api/routes/5b0f3c2e-8d1a-4c7e-9f7b-2a6d1e0c9a41",
    "events": "/plugins/signalk-weather-router-plus/api/routes/5b0f3c2e-8d1a-4c7e-9f7b-2a6d1e0c9a41/events",
    "result": "/plugins/signalk-weather-router-plus/api/routes/5b0f3c2e-8d1a-4c7e-9f7b-2a6d1e0c9a41/result",
    "skeleton": "/plugins/signalk-weather-router-plus/api/routes/5b0f3c2e-8d1a-4c7e-9f7b-2a6d1e0c9a41/skeleton",
    "cancel": "/plugins/signalk-weather-router-plus/api/routes/5b0f3c2e-8d1a-4c7e-9f7b-2a6d1e0c9a41/cancel",
    "publish": "/plugins/signalk-weather-router-plus/api/routes/5b0f3c2e-8d1a-4c7e-9f7b-2a6d1e0c9a41/publish"
  }
}
```

**2a. Follow progress with Server-Sent Events** (the stream ends after
`done` or `error`):

```sh
curl -sN "$BASE/api/routes/$ID/events" -H "$AUTH"
```

```
id: 1
event: status
data: {"status":"queued","position":1}

id: 2
event: status
data: {"status":"running"}

id: 3
event: progress
data: {"time":"2026-09-28T11:58:02.114Z","stage":0,"total":0,"message":"leg 1/2 corridor: searching the global 0.02° water grid (canals blocked)"}

id: 57
event: route
data: {"type":"FeatureCollection","features":[…]}

id: 58
event: done
data: {"status":"done","summary":{"total_distance_m":1183412.6,"total_time_s":461880.2,…}}
```

**2b. Or poll** until `status` is `done`, `failed` or `cancelled`:

```sh
curl -s "$BASE/api/routes/$ID" -H "$AUTH"
```

```json
{
  "id": "5b0f3c2e-8d1a-4c7e-9f7b-2a6d1e0c9a41",
  "status": "done",
  "request": {"start": {"lat": 41.44, "lon": -71.36}, "end": {"lat": 32.42, "lon": -64.58}, "…": "…"},
  "created_at": "2026-09-28T11:58:00.021Z",
  "started_at": "2026-09-28T11:58:00.030Z",
  "finished_at": "2026-09-28T11:58:41.577Z",
  "progress": [{"time": "2026-09-28T11:58:40.912Z", "stage": 20, "total": 20, "message": "…"}],
  "summary": {
    "total_distance_m": 1183412.6,
    "total_time_s": 461880.2,
    "sailing_time_s": 420120.0,
    "motoring_time_s": 41760.2,
    "waypoint_count": 38,
    "warnings": 0,
    "departure": "2026-09-28T12:00:00.000Z",
    "arrival": "2026-10-03T20:18:00.200Z",
    "forecast_cycle": "2026-09-28T00:00:00.000Z",
    "current_sources": ["CMEMS-SMOC"],
    "polar": "a_boat.pol",
    "polar_performance": 1,
    "legs": 2,
    "precision": "precise"
  },
  "resource_id": "5b0f3c2e-8d1a-4c7e-9f7b-2a6d1e0c9a41",
  "links": {"self": "…", "events": "…", "result": "…", "skeleton": "…", "cancel": "…", "publish": "…"}
}
```

**3. Read the route** as GeoJSON (or `…/signalk` for the Signal K route
record):

```sh
curl -s "$BASE/api/routes/$ID/result" -H "$AUTH"
```

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": {"type": "LineString", "coordinates": [[-71.36, 41.44], [-71.402113, 41.301877], "…"]},
      "properties": {
        "total_distance_m": 1183412.6, "total_time_s": 461880.2,
        "motoring_time_s": 41760.2, "sailing_time_s": 420120.0,
        "departure": "2026-09-28T12:00:00.000Z", "arrival": "2026-10-03T20:18:00.200Z",
        "waypoint_count": 38, "validated": true, "repairs_applied": 0, "smoother_drops": 3,
        "forecast_cycle": "2026-09-28T00:00:00.000Z", "max_swh_m": 2.41, "avg_swh_m": 1.37
      }
    },
    {
      "type": "Feature",
      "geometry": {"type": "Point", "coordinates": [-71.36, 41.44]},
      "properties": {
        "lon": -71.36, "lat": 41.44, "time": "2026-09-28T12:00:00.000Z",
        "sog_ms": 0, "cog_deg": 0, "depth_m": null, "mode": "motoring",
        "wind_ms": 7.214, "wind_dir_deg": 225, "leg": "ocean",
        "leg_distance_m": 15612.3, "leg_time_s": 3021.4
      }
    }
  ]
}
```

A finished route is also saved to the Resources API when publishing is
on (the default; [Publishing](#resources-api-publishing)), so a chart
plotter that reads `/signalk/v2/api/resources/routes` sees it there
without calling this API.

### Routes (jobs)

A route request becomes a job. Jobs run one at a time in the route
worker; the others wait in a queue. Each job keeps an event log that
the SSE endpoint replays.

| Method | Path | Access | Purpose |
|---|---|---|---|
| POST | `/api/routes` | readwrite | submit a route request |
| GET | `/api/routes` | readonly | list jobs |
| GET | `/api/routes/{id}` | readonly | job status, progress and summary |
| GET | `/api/routes/{id}/events` | readonly | Server-Sent Events |
| GET | `/api/routes/{id}/result` | readonly | route as GeoJSON |
| GET | `/api/routes/{id}/skeleton` | readonly | coarse corridor skeleton as GeoJSON |
| GET | `/api/routes/{id}/signalk` | readonly | Signal K Resources API route record |
| POST | `/api/routes/{id}/cancel` | readwrite | cancel a queued or running job |
| POST | `/api/routes/{id}/publish` | readwrite | save the route to the Resources API |
| DELETE | `/api/routes/{id}` | readwrite | delete a job |

#### Job lifecycle

| Status | Meaning |
|---|---|
| `queued` | accepted, waiting for the route worker |
| `running` | being computed; only one job runs at a time |
| `done` | finished; `summary`, the result, the skeleton (when one was found) and the Signal K record are available |
| `failed` | finished with an error; `error` holds the message. A request the worker rejects (see below) also ends here |
| `cancelled` | cancelled by `/cancel`; `error` is `"cancelled"` |

- The queue holds at most 16 waiting jobs; a 17th is refused with `429`.
- Finished jobs (`done`, `failed`, `cancelled`) are saved to disk
  (`jobs/<id>.json` in the plugin data directory) and survive a restart.
  Only the newest are kept: the `routing.keepJobs` setting ("finished
  routes kept", default 50, 1–500); older ones are deleted.
- A job that was `queued` or `running` when the plugin stopped is
  loaded as `failed` with `error` "plugin restarted while the job was in
  progress". If the route worker crashes or exits, the running job fails
  with a message that says so.
- The job's event log keeps its last 500 events; `progress` in the job
  status carries the last 20 progress entries.

#### POST /api/routes

Submit a route request. Access: readwrite. Body: JSON `RouteRequest`.

| Field | Type | Unit | Default | Limits and notes |
|---|---|---|---|---|
| `start` | `{lat, lon}` | degrees | required | both numbers |
| `end` | `{lat, lon}` | degrees | required | both numbers; always reached exactly |
| `waypoints` | array of `{lat, lon, radius_m?}` | degrees, m | none | at most 20; each ends one leg and starts the next ([Waypoints](#waypoints-legs)). `radius_m` 0..5000, overrides `arrival_radius_m` for that waypoint, and must be > 0 with `"approximate"` |
| `precision` | `"precise"` or `"approximate"` | | `"precise"` | `precise`: each leg ends exactly on its waypoint; `approximate`: the route only has to pass through the waypoint's circle; consecutive approximate waypoints are normally routed as one search through their circles in order, and leg by leg when no branch passes through all of them |
| `arrival_radius_m` | number | m | 200 | 0..5000; must be > 0 with `"approximate"`. Ignored in precise mode and for the destination |
| `departure` | string | ISO 8601 | now | an empty string also means now |
| `mode` | `"sail_max"`, `"fastest"` or `"motor"` | | `"sail_max"` | mode policy. `motor`: always motor, and no forecast is used; `fastest`: sail when the polar speed beats the motor speed; `sail_max`: sail when the polar speed is at or above `sail_thresh_ms`, otherwise motor (`src/engine/legsim.ts`). The parent routePlanning server also sails above 0.25 m/s VMG or 1.0 m/s whatever the threshold; this plugin does not |
| `stages` | number | count | setting `routing.stages` (20) | 4..200; isochrone stages per leg |
| `sail_thresh_ms` | number | m/s | setting `routing.sailThreshold` | ≥ 0 |
| `simplify_m` | number | m | setting `routing.simplify` | 0..5000; route simplification tolerance, 0 = off |
| `smoother` | boolean | | setting `routing.smoother` | run the shortcut smoother |
| `smoother_tolerance` | number | ratio | setting `routing.smootherTolerance` | 0..0.5; how much slower a shortcut may be (0.05 = 5%) |
| `name` | string | | `<prefix> <lat>,<lon> → <lat>,<lon>` | name of the Signal K route record (trimmed). The default uses the `publish.routeNamePrefix` setting (`WRP`) and the start and end to two decimals |
| `publish` | boolean | | setting `publish.toResources` (on) | save the finished route to the Resources API |
| `no_forecast` | boolean | | false | route with calm wind |
| `no_currents` | boolean | | false | ignore every current source |
| `vessel` | object | | the vessel settings | per-route overrides; absent keys use the settings ([Configuration](#configuration)) |
| `vessel.name` | string | | setting | |
| `vessel.draught` | number | m | setting (1.8) | 0..30 |
| `vessel.air_draft` | number | m | setting (16) | 0..100 |
| `vessel.loa` | number | m | setting (11) | 0.1..500 |
| `vessel.beam` | number | m | setting (3.7) | 0.1..100 |
| `vessel.motor_speed_ms` | number | m/s | setting (3.087) | 0.01..50 |
| `vessel.under_keel_clearance` | number | m | setting (0.5) | 0..20 |
| `vessel.tack_penalty_s` | number | s | setting (30) | 0..600; time lost per tack or gybe |
| `vessel.polar_performance` | number | ratio | setting (1) | 0.3..1.2; see below |
| `vessel.polar` | string | | the configured `polarFile` | a token from `GET /api/polars`, at most 200 characters; see below |

`vessel.polar` is a token from `GET /api/polars`. A file name such as
`a_boat.pol` resolves only inside the configured `polarsDir`. Use
`"default"`, or omit the field, for the configured `polarFile`. Without
any polar every route is motor-only.

`vessel.polar_performance` (ratio, 0.3..1.2) is the share of the polar's
boat speeds the boat makes under sail; it overrides the vessel setting
of the same name (default 1, the polar as written). Every boat speed in
the polar is multiplied by it before the sail/motor choice, so a lower
value also means more motoring; motor speed is unchanged. Polars are
usually race predictions (flat water, racing sails, full crew), so a
loaded cruising boat is slower than its polar. The job summary carries
`polar_performance` when a polar was used.

Validation happens in two places:

- **At submission** (`400 {"error": …}`, no job is created): a missing
  or non-object body; `start`/`end`/`waypoints` items that are not
  `{lat, lon}` numbers; more than 20 waypoints; `precision`,
  `arrival_radius_m`, `radius_m`, `mode`, `departure`, `stages`,
  `sail_thresh_ms`, `simplify_m`, `smoother`, `smoother_tolerance`,
  `name`, `vessel`, `vessel.tack_penalty_s`, `vessel.polar_performance`
  and `vessel.polar` outside the limits above. The message names the
  field, e.g. `"stages must be 4..200"`.
- **When the job runs** (the job ends `failed` with the message):
  coordinates outside latitude −90..90 or longitude −180..360;
  the other `vessel.*` ranges above (the message uses the internal
  name, e.g. `vessel.airDraft must be a number in [0, 100] (got 120)`);
  a `vessel.polar` token that is not in the library.

| Status | Body |
|---|---|
| 202 | `{id, status: "queued", links}`; header `Location: <links.self>` |
| 400 | `{error}`: invalid request (above) |
| 429 | `{error: "job queue is full"}`: 16 jobs are already waiting |

`links` has `self`, `events`, `result`, `skeleton`, `cancel` and
`publish`, each an absolute path under the base path.

#### GET /api/routes

List jobs, newest first (by creation time). Access: readonly.

| Query | Type | Default | Limits |
|---|---|---|---|
| `limit` | integer | 50 | clamped to 1..500 |

`200`: an array of job status objects (next section).

#### GET /api/routes/{id}

Job status. Access: readonly. `200`: the job; `404 {error: "job not
found"}`.

| Field | Type | Notes |
|---|---|---|
| `id` | string | job id (a UUID) |
| `status` | string | `queued`, `running`, `done`, `failed` or `cancelled` |
| `request` | object | the route request as submitted |
| `created_at` | string | ISO 8601 |
| `started_at` | string | when it started running; absent before |
| `finished_at` | string | when it finished; absent before |
| `progress` | array | the last 20 progress entries `{time, stage, total, message}` |
| `summary` | object | `done` only; see below |
| `error` | string | `failed` / `cancelled` only |
| `resource_id` | string | Resources API id once published (equal to the job id) |
| `publish_error` | string | the last publishing error, when publishing failed |
| `links` | object | as in the `202` of `POST /api/routes` |

Progress entry:

| Field | Type | Notes |
|---|---|---|
| `time` | string | ISO 8601, when the entry was recorded |
| `stage` | number | current isochrone stage; 0 for messages outside the stage loop |
| `total` | number | planned stages (it can grow while the route runs); 0 when not known |
| `message` | string | human-readable text for display, not a stable format. With waypoints it is prefixed with the leg: `leg 2/4: …` for the leg's start line and errors, `leg 2/4 …` for its per-stage messages |

`summary` (a `RouteSummary`; values are not rounded):

| Field | Type | Unit | Notes |
|---|---|---|---|
| `total_distance_m` | number | m | |
| `total_time_s` | number | s | |
| `sailing_time_s` | number | s | |
| `motoring_time_s` | number | s | |
| `waypoint_count` | number | count | points in the route line |
| `warnings` | number | count | entries in the GeoJSON `warnings` |
| `departure` | string | ISO 8601 | time at the first point |
| `arrival` | string | ISO 8601 | time at the last point |
| `forecast_cycle` | string | ISO 8601 | forecast cycle used; absent without a forecast |
| `current_sources` | string[] | | current sources stacked for the route; absent when none or `no_currents` |
| `polar` | string or null | | file name of the polar used; null when motor-only |
| `polar_performance` | number | ratio | present when a polar was used |
| `auto_vias` | `[{name, width_m}]` | m | automatic vias at narrow passages ([Routing engine](#routing-engine)); not route waypoints |
| `legs` | number | count | routes with waypoints only |
| `precision` | string | | routes with waypoints only |

#### GET /api/routes/{id}/events

Server-Sent Events for one job. Access: readonly. `404 {error: "job not
found"}` for an unknown id. Headers: `Content-Type: text/event-stream`,
`Cache-Control: no-cache`, `X-Accel-Buffering: no`.

Each event has a numeric `id` (increasing per job, from 1), an `event`
name and JSON `data`:

| Event | `data` | When |
|---|---|---|
| `status` | `{status: "queued", position}` | job accepted; `position` in the queue (1 = next) |
| `status` | `{status: "running"}` | job started |
| `progress` | `{time, stage, total, message}` | progress entry (as in the job status) |
| `route` | the route GeoJSON FeatureCollection | job done, just before `done` |
| `done` | `{status: "done", summary}` | job done |
| `error` | `{status: "failed" or "cancelled", message}` | job failed or was cancelled |
| `status` | `{status, resource_id, publish_error}` | after a publish attempt (automatic or `/publish`) |

Behaviour:

- On connect the stream first replays the logged events whose `id` is
  greater than the request's `Last-Event-ID` header (all of them without
  the header).
- If the job has already finished, the stream ends after the replay.
  Otherwise it stays open, sends new events as they happen, and ends
  after `done` or `error`.
- A comment line `: keepalive` is sent every 15 s.
- A browser `EventSource` reconnects when the server ends the stream;
  close it yourself on `done` or `error`.
- Automatic publishing runs after `done`, so its `status` event comes
  after the live stream has ended. Read `resource_id` / `publish_error`
  from `GET /api/routes/{id}`, or reconnect with `Last-Event-ID`.

#### GET /api/routes/{id}/result

The route as a GeoJSON FeatureCollection: one LineString feature with
the route's properties, then one Point feature per route point.
Access: readonly.

| Status | Body |
|---|---|
| 200 | FeatureCollection |
| 404 | `{error: "job not found"}` |
| 409 | `{error: "job is <status>", status, message}`: not `done`; `message` is the job's `error`, if any |

LineString `properties`:

| Property | Type | Unit | Notes |
|---|---|---|---|
| `total_distance_m` | number | m | 0.1 m |
| `total_time_s` | number | s | 0.1 s |
| `motoring_time_s` | number | s | |
| `sailing_time_s` | number | s | |
| `departure` | string | ISO 8601 | |
| `arrival` | string | ISO 8601 | |
| `waypoint_count` | number | count | route points |
| `validated` | boolean | | |
| `repairs_applied` | number | count | always 0 |
| `smoother_drops` | number | count | points the shortcut smoother removed |
| `forecast_cycle` | string | ISO 8601 | when a forecast was used |
| `auto_vias` | `[{name, lat, lon, width_m, radius_m}]` | degrees, m | automatic vias; present when any |
| `forecast_horizon_exceeded_s` | number | s | present when the route arrives after the last forecast step |
| `forecast_horizon_note` | string | | explains the above: conditions beyond the last step are held at it |
| `warnings` | array | | present when any; items `{leg_index, violation, from, to, repaired}`, `violation` `"leg_crosses_land"` or `"leg_too_shallow"`, `from`/`to` `[lon, lat]` |
| `land_crossings` | number | count | present when a warning is `leg_crosses_land` |
| `has_land_crossing` | boolean | | `true` when `land_crossings` is present |
| `max_swh_m` | number | m | highest significant wave height at a route point; present when wave data was sampled |
| `avg_swh_m` | number | m | mean of the same |

Point `properties` (one feature per route point, in order):

| Property | Type | Unit | Notes |
|---|---|---|---|
| `lon`, `lat` | number | degrees | 6 decimals |
| `time` | string | ISO 8601 | time at the point |
| `sog_ms` | number | m/s | speed over ground into the point (0 at the start) |
| `cog_deg` | number | degrees true | course over ground into the point |
| `depth_m` | null | | always null |
| `mode` | string | | `"sailing"` or `"motoring"` on the leg into the point |
| `twa_deg` | integer | degrees | true wind angle, 0..180; when wind was sampled |
| `wind_ms` | number | m/s | wind speed |
| `wind_dir_deg` | integer | degrees true | wind direction FROM |
| `swh_m` | number | m | significant wave height |
| `mwp_s` | number | s | mean wave period |
| `mwd_deg` | integer | degrees true | mean wave direction FROM |
| `current_ms` | number | m/s | current speed |
| `current_dir_deg` | integer | degrees true | current set (flows TO) |
| `current_u_ms`, `current_v_ms` | number | m/s | current east and north components |
| `leg` | string | | engine that produced the waypoint; always `"ocean"` in this plugin (kept for compatibility with the routePlanning server, which also uses other values) |
| `role` | string | | `"via"` on the junction point of each request waypoint |
| `leg_distance_m` | number | m | distance to the next point; absent on the last point |
| `leg_time_s` | number | s | time to the next point; absent on the last point |

The optional point properties are present only when the value was
sampled and is finite. Property names match the routePlanning server's
GeoJSON, so consumers of either can read both.

#### GET /api/routes/{id}/skeleton

The coarse corridor that guided the heading sweep, as a FeatureCollection
with one LineString whose properties are `{kind: "skeleton", points}`.
Access: readonly. `404 {error: "job not found"}`, or `404 {error: "no
skeleton for this job"}` when the job has not finished or no skeleton
was found.

#### GET /api/routes/{id}/signalk

The route record the plugin saves to the Resources API (format under
[Resources API publishing](#resources-api-publishing)). Access:
readonly. `200` the record; `404 {error: "job not found"}`; `409
{error: "job is <status>"}` when not `done`.

#### POST /api/routes/{id}/cancel

Cancel a job. Access: readwrite. No body.

| Status | Body |
|---|---|
| 202 | `{id, status: "cancelling"}` for a queued or running job (a queued job is already `cancelled` when this is returned); `{id, status}` with the unchanged status for a finished job |
| 404 | `{error: "job not found"}` |

A queued job is cancelled at once. A running job stops at the route
worker's next cancellation check; it then ends `cancelled` with an
`error` event. No notification is sent for a cancelled job.

#### POST /api/routes/{id}/publish

Save the finished route to the Signal K Resources API. Access:
readwrite. No body. Use it when automatic publishing is off or failed.

| Status | Body |
|---|---|
| 200 | `{id, resource_id, href}`; `href` is `/signalk/v2/api/resources/routes/<resource_id>` |
| 404 | `{error: "job not found"}` |
| 409 | `{error: "job is <status>"}`: not `done` |
| 502 | `{error}`: the server has no Resources API, or it rejected the route (the message asks whether a routes provider such as `resources-provider` is enabled) |

#### DELETE /api/routes/{id}

Delete a job and its saved file. A queued job is also removed from the
queue. The route saved in the Resources API is not deleted. Access:
readwrite.

| Status | Body |
|---|---|
| 204 | none |
| 404 | `{error: "job not found"}` |
| 409 | `{error: "cancel the running job before deleting it"}` |

### Forecast and conditions

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/api/forecast` | readonly | forecast metadata, and a series at a position |
| POST | `/api/forecast/refresh` | readwrite | check for a new forecast cycle |
| GET | `/api/conditions` | readonly | conditions time series at a point, with tides |
| GET | `/api/status` | readonly | plugin, forecast, currents, tides and queue status |

#### GET /api/forecast

| Query | Type | Unit | Default | Notes |
|---|---|---|---|---|
| `lat` | number | degrees | none | |
| `lon` | number | degrees | none | samples are returned only when both are given |

`200`:

| Field | Type | Notes |
|---|---|---|
| `cycle` | string | forecast cycle (run time), ISO 8601 |
| `valid_from` | string | first step's valid time |
| `valid_to` | string | last step's valid time |
| `steps` | number[] | forecast step hours of the run |
| `params` | string[] | ECMWF parameters decoded (e.g. `10u`, `10v`, `msl`, `swh`, `mwp`, `mwd`, plus the extra fields when on) |
| `coverage` | string | always `"global"` |
| `samples` | array | with `lat` and `lon`: one row per step, `{time, wind_ms, wind_dir_deg (FROM), msl_pa, swh_m, mwp_s, mwd_deg (FROM)}`; values not rounded, null when missing |

`400 {error}`: `lat`/`lon` not numbers, no forecast loaded yet (`forecast
not loaded yet`, or `forecast unavailable: …` after a failed download),
or a position outside the forecast.

#### POST /api/forecast/refresh

Ask the data worker to check for a new cycle. Access: readwrite.

| Query | Type | Default | Notes |
|---|---|---|---|
| `force` | `true` / `1` | false | decode the current cycle again from the GRIB cache |

`202 {status: "refresh requested"}`. The check runs in the background;
watch `/api/status` for the result.

#### GET /api/conditions

A time series of every conditions field at a point, with tide height,
total water level and surge, and the high and low waters. This is what
the webapp's 72-hour conditions popup draws. Access: readonly.

| Query | Type | Unit | Default | Limits |
|---|---|---|---|---|
| `lat` | number | degrees | required | −90..90 |
| `lon` | number | degrees | required | −180..360 |
| `from` | string | ISO 8601 | the current UTC hour | |
| `hours` | number | h | 72 | 1..240 |
| `step_h` | number | h | 1 | 1..24 |

The series is cut to the forecast's valid range (then `truncated` is
true) and to at most 1000 rows. `400 {error}` for bad parameters (`lon
and lat are required numbers`, `hours must be a number in [1, 240]`, …).

`200`:

| Field | Type | Notes |
|---|---|---|
| `lon`, `lat` | number | as requested |
| `is_land` | boolean | the point is on land |
| `from` | string | first row's time (after truncation) |
| `hours`, `step_h` | number | as requested |
| `forecast_time_range` | `[string, string]` or null | valid range of the forecast |
| `truncated` | boolean | rows were cut to the forecast range or the row limit |
| `series` | array | rows (below) |
| `tides` | object or null | high and low waters (below); null when tides are off or have no data here |
| `tides_error` | string or null | why `tides` is null when tides are on |
| `sources` | object | `{forecast_cycle, currents: [names], tides}`; `tides` is the source name and run, or null |

Row fields (null when the value is not available, e.g. an extra field
that is switched off):

| Field | Unit | Notes |
|---|---|---|
| `time` | ISO 8601 | |
| `wind_ms` | m/s | 10 m wind speed, 2 decimals |
| `wind_dir_deg` | degrees true | FROM |
| `swh_m` | m | significant wave height |
| `mwp_s` | s | mean wave period |
| `mwd_deg` | degrees true | mean wave direction FROM |
| `current_ms` | m/s | current speed (the stacked current sources) |
| `current_dir_deg` | degrees true | current set (TO) |
| `msl_pa` | Pa | mean sea-level pressure |
| `t2m_k` | K | 2 m air temperature (extra fields) |
| `skt_k` | K | skin (sea surface) temperature (extra fields) |
| `precip_rate_ms` | m/s | precipitation depth rate (extra fields) |
| `precip_type` | code | ECMWF precipitation type (WMO table 4.201) |
| `precip_type_label` | string | `none`, `rain`, `freezing rain`, `snow`, `wet snow`, `rain and snow`, `ice pellets`, `freezing drizzle` or `other` |
| `dewpoint_k` | K | 2 m dew point (extra fields) |
| `rh` | ratio | relative humidity 0..1 |
| `feels_like_k` | K | apparent temperature |
| `feels_like_basis` | string | `air`, `wind_chill` or `heat_index` |
| `wind_chill_k` | K | |
| `heat_index_k` | K | |
| `beaufort` | integer | Beaufort force 0..12 |
| `douglas` | integer | Douglas sea state 0..9 |
| `douglas_label` | string | `calm (glassy)` … `phenomenal` |
| `sea_state_index` | number | combined wind/current/swell roughness index, one decimal |
| `sea_state` | string | band: `smooth`, `good`, `slight`, `choppy`, `rough`, `extreme` |
| `sea_state_partial` | boolean | the index was computed without wave data |
| `tide_m` | m | tide height above mean sea level (Copernicus Marine `ocean_tide`, FES2014) |
| `water_level_m` | m | total water level above local mean sea level |
| `surge_m` | m | non-tidal residual (water level − tide) |
| `tide_extrapolated` | boolean | a bilinear corner is model land and took the value of valid cells within 2 cells (~18 km) |
| `tide_tendency` | string | `rising`, `falling` or `steady` (within ±2 cm/h) |

The tide fields are null when tides are off or there is no model water
within 2 cells. Tide heights are relative to mean sea level, not chart
datum: do not use them for under-keel clearance.

`tides` object:

| Field | Type | Notes |
|---|---|---|
| `highs`, `lows` | `[{time, height_m, water_level_m}]` | high and low waters of the tide height, refined with a parabola through the hourly samples; `water_level_m` may be null |
| `range_m` | number or null | mean of consecutive high − low differences (null with fewer than two extrema) |
| `max_range_m` | number or null | largest such difference |
| `of` | string | always `"tide_m"` |
| `source` | string | source and dataset name |
| `run` | string | source run |
| `datum` | string | `"mean sea level"` |
| `msl_offset_m` | number or null | mean of total sea level − tide over `mean_window`, removed from the total level |
| `mean_window` | `{from, to, samples}` | window of that mean |
| `extrapolated` | boolean | any value in the window came from the coastal fill |
| `doi` | string | dataset DOI |

#### GET /api/status

Plugin, forecast, currents, tides and queue status. Access: readonly.
`200`:

| Field | Notes |
|---|---|
| `plugin` | `"signalk-weather-router-plus"` |
| `started` | the plugin is running |
| `workers` | `{data, route}`: each worker is ready |
| `forecast` | null until a decoded run is ready; see below |
| `process_rss_bytes` | resident memory of the Signal K process, bytes |
| `forecast_error` | last forecast refresh error, or null |
| `currents` | the data worker's current sources in priority order: `{name, priority, resolutionM, bbox, validFrom, validTo}`; the CMEMS SMOC entry adds `smoc` (run, resident and on-demand areas, memory, downloads) |
| `currents_route_worker` | the same for the route worker |
| `rtofs_run` | RTOFS run in use, or null |
| `tides` | Copernicus Marine sea-level source status (run, resident and on-demand areas, point cache, memory, downloads), or null when off or not loaded |
| `tides_enabled` | the tides setting, or null before start |
| `tides_error` | last tide source error, or null |
| `overlay_land` | overlay land-raster cache: `{entries, cells, bytes, index_bytes, builds, hits, last_build_ms, disk_hits, disk_writes, disk}`, or null |
| `overlay_tiles` | saved map tiles: `{dir, cap_bytes, files, bytes, hits, misses, writes, not_kept, generations, inflight}` (`files`/`bytes` after the first scan; `not_kept`: answered but not saved because an on-demand current or tide load was late or failed; `generations`: the data each layer group was built from; `inflight`: tile queries waiting or running), or null before start |
| `overlay_prebuild` | tiles built ahead of time: `{enabled, workers, workers_ready, paused, areas, window, max_zoom, walk_started_at, seen, built, skipped, not_kept, errors, last_error, at, complete, built_total, build_ms_avg}`; `areas`: `[{kind: "view" or "boat", lat, lon, radius_m}]`; `at`: `{area, hour, z}` of the last tile started; `complete`: every tile of the window is saved. Null before start |
| `weather_provider_registered` | the Weather API provider is registered |
| `jobs` | `{running: id or null, queued, total}`, or null before start |
| `vessel`, `polar`, `land`, `harmonic_dir`, `extra_fields` | the resolved configuration: vessel parameters (internal camelCase names), default polar file, coastline shapefiles, tidal-harmonic directory, extra fields on/off |

`forecast` fields: `cycle`, `valid_from`, `valid_to`, `steps` (number of
steps), `params`, `coverage` (`"global"`), `storage`
(`"decoded-on-disk"`), `loaded_at`, `has_waves`, `source` (`"disk"`: a
complete decoded run was already on disk; `"grib"`: decoded from the
GRIB cache or download), `ready_ms`, `fields_downloaded`, `decoded_dir`,
`decoded_bytes` (this run on disk), `decoded_at`, `decode_ms`,
`decoded_disk_bytes` (all decoded runs kept), `grib_cache_bytes`,
`last_decode` (`{at, cycle, ms, stepBlockBytes, writtenBytes,
downloaded}` or null), and `memory`: `{data_worker_held_bytes,
data_worker_largest_recent_window, route_worker_held_bytes,
route_worker_largest_recent_window, decoding_block_bytes}`. The decoded
forecast is never resident; `memory` is what requests hold now (a
route's corridor store while it runs, a query's window while it is
answered). The OpenAPI document's description of `/api/status` lists the
nested `smoc` and `tides` fields in full.

### Map layers

| Method | Path | Access | Returns |
|---|---|---|---|
| GET | `/api/field` | readonly | JSON value grid for one layer |
| GET | `/api/wind-points` | readonly | wind barb points |
| GET | `/api/currents` | readonly | current arrow points |
| GET | `/api/pressure` | readonly | isobars and highs/lows as GeoJSON |
| GET | `/api/land-mask` | readonly | binary land mask at screen resolution |
| GET | `/api/tile/{layer}/{z}/{x}/{y}` | readonly | one web-map tile of a layer at a whole hour, saved on the server |
| GET | `/api/legends` | readonly | colour ramps for every layer |

**Common parameters.**

| Query | Format | Default | Limits |
|---|---|---|---|
| `bbox` | `west,south,east,north`, degrees | required | south < north, both in −90..90; west and east in −180..360; east − west ≤ 360. `east` < `west` crosses the antimeridian |
| `time` | ISO 8601 | now | forecast layers are interpolated at this time |

Invalid values give `400` with messages such as `bbox must be w,s,e,n`,
`bbox latitudes invalid`, `time "x" is not ISO 8601` or `res must be a
number in [0.002, 2]`.

**One cache for every client.** These endpoints are answered from the
same saved tiles as the page (see [`/api/tile`](#get-apitilelayerzxy)),
so a box another app asks for is built from tiles already on disk (or
built ahead of time), and what it causes to be computed is saved for
everyone:

- `/api/field`, `/api/wind-points`, `/api/currents`: the tiles covering
  `bbox` at the zoom whose sample spacing is nearest `res`, joined. At one
  zoom all tiles sample the same global lattice, so the values are the
  same as a grid computed for the box at that spacing (not resampled).
  The spacing used is in the answer (`res` in `/api/field`); it is the
  tile spacing nearest the one asked for, at most √2 × finer or coarser,
  coarsened as before when the box would exceed the sample cap.
- `/api/land-mask`: read from the coastline tiles at the nearest pixel
  size.
- `/api/pressure`: the pressure tiles at zoom 5 (0.176°) joined, sampled
  at 0.25° as before, and contoured.
- `time` is rounded to the nearest hour for all of them.
- Latitudes beyond ±85.05° (the web-map limit) have no tiles and answer
  null (no points, water in the land mask).

`/api/conditions`, the Weather API point forecasts and tide series, and
the `/api/forecast` samples are saved in the same store, keyed by the
exact query (a Weather API request without a start date starts at the
current hour), and replaced with the data they were computed from.

**Caching headers.** `/api/field`, `/api/wind-points`, `/api/currents`
and `/api/pressure` send `Cache-Control: public, max-age=86400` when the
hour is more than an hour in the past, else `public, max-age=1800`.

#### GET /api/field

A regular grid of values for one layer over `bbox` at `time`, for
drawing a colour layer (heatmap) or streamlines.

| Query | Type | Unit | Default | Limits |
|---|---|---|---|---|
| `layer` | string | | required | one of the layers below |
| `bbox`, `time` | | | | common parameters |
| `res` | number | degrees | 0.25 | 0.002..2; lattice spacing |

The lattice is snapped to multiples of `res`. If it would have more than
40 000 cells, `res` is doubled until it fits; the response's `res` is
the spacing used.

`200`:

| Field | Type | Notes |
|---|---|---|
| `layer` | string | as requested |
| `time` | string | ISO 8601 |
| `bbox` | `[west, south, east, north]` | as requested |
| `res` | number | spacing used, degrees |
| `lons` | number[] | column longitudes, normalised to −180..180 |
| `lats` | number[] | row latitudes, ascending (south first) |
| `fields` | `{name: rows}` | one grid per field: `rows[i][j]` is at `lats[i]`, `lons[j]`; values rounded to 4 decimals (precipitation rate to 5 significant digits); null = no data |
| `land` | number[][] | same layout; 1 = land, 0 = water |
| `units` | `{name: unit}` | unit of each field |

| `layer` | `fields` (unit) | Notes |
|---|---|---|
| `wind` | `speed_ms` (m/s), `dir_from` (deg) | 10 m wind |
| `waves` | `swh` (m), `mwp` (s), `mwd` (deg, FROM) | 400 when the forecast has no wave data |
| `msl` | `msl` (Pa) | mean sea-level pressure |
| `temperature` | `t2m` (K) | 2 m air temperature; needs the extra fields |
| `sst` | `skt` (K) | skin temperature; needs the extra fields |
| `precip` | `rate` (m/s), `ptype` (code, when loaded) | precipitation depth rate; needs the extra fields |
| `sea_state` | `index` (dimensionless), `signal` (0..1) | roughness index from wind, current and swell; `signal` is its strength, used by the webapp for opacity |
| `current` | `speed_ms` (m/s), `dir_to` (deg) | display values: gridded model currents (CMEMS SMOC, RTOFS) extended up to 2 source-grid cells into the cells the model leaves empty at the coast, for clipping with `/api/land-mask`. Null where the current is exactly zero. Outside the resident SMOC area the area is loaded on demand first (at most 60 s wait). 400 when no current source is loaded |
| `tide` | `tide_m` (m) | tide height above MEAN SEA LEVEL (not chart datum) from Copernicus Marine `ocean_tide` (FES2014) at the hour (linear between hourly steps), with the same 2-cell coastal extension. Outside the resident tide area the hour is loaded on demand (1/3° grid for `res` ≥ 0.25°). 400 when tides are off |

Forecast layers (all but `current` and `tide`) report null outside the
area the forecast covers.

#### GET /api/wind-points

Wind barb points on a lattice.

| Query | Type | Unit | Default | Limits |
|---|---|---|---|---|
| `bbox`, `time` | | | | common parameters |
| `res` | number | degrees | 0.5 | 0.02..5; coarsened (doubled) to at most 20 000 points |

`200`: `[{lon, lat, speed_ms, dir_deg}]`, `dir_deg` the direction the
wind comes FROM (degrees true, 1 decimal). Points without a forecast
value are left out.

#### GET /api/currents

Current arrow points on a lattice (display values, extended to the coast
as for `/api/field?layer=current`).

| Query | Type | Unit | Default | Limits |
|---|---|---|---|---|
| `bbox`, `time` | | | | common parameters |
| `res` | number | degrees | 0.05 | 0.005..5; coarsened (doubled) to at most 20 000 points |

`200`: `[{lon, lat, u_ms, v_ms, speed_ms, dir_deg}]`: east and north
components and speed in m/s, `dir_deg` the direction the current flows
TO (degrees true, 1 decimal). Land points and points slower than
0.005 m/s are left out. An empty array when no current source is
loaded.

#### GET /api/pressure

Isobars and pressure centres as a GeoJSON FeatureCollection, contoured
from the 0.25° forecast grid around `bbox`.

| Query | Type | Unit | Default | Limits |
|---|---|---|---|---|
| `bbox`, `time` | | | | common parameters |
| `interval` | number | hPa | 4 | 1..20; isobar spacing |

| Feature | Geometry | `properties` |
|---|---|---|
| isobar | LineString | `{kind: "isobar", hpa, pa, bold}`; `bold` is true every 20 hPa and at 1000 hPa |
| label | Point | `{kind: "label", hpa, pa}`: where to write the isobar's value |
| high | Point | `{kind: "high", hpa, pa}` |
| low | Point | `{kind: "low", hpa, pa}` |

`hpa` is in hPa (whole numbers on isobars and labels), `pa` the same in
Pa. Coordinates are `[lon, lat]`, 5 decimals.

#### GET /api/land-mask

A land mask at screen resolution for clipping drawn layers to the
coastline, independent of the data grid.

| Query | Type | Unit | Default | Limits |
|---|---|---|---|---|
| `bbox` | | | required | common parameter |
| `w` | integer | pixels | 1024 | 16..2048 (rounded) |
| `h` | integer | pixels | 1024 | 16..2048 (rounded) |

`200` with `Content-Type: application/octet-stream`, `Content-Encoding:
gzip`, `X-Mask-Width: <w>`, `X-Mask-Height: <h>` and `Cache-Control:
public, max-age=86400`. After gzip decoding (browsers and most HTTP
clients do this themselves), the body is `w × h` bytes, one per pixel,
1 = land and 0 = water, row by row from row 0 at the north edge. Pixel
`(x, y)` is centred at longitude `west + (x + 0.5) × (east − west) / w`
and latitude `north − (y + 0.5) × (north − south) / h`. The raster
follows the pixel size (finest 0.002°). `400 {error: "no coastline
configured"}` without coastline shapefiles.

#### GET /api/tile/{layer}/{z}/{x}/{y}

One web-map tile (the usual XYZ scheme: zoom `z`, column `x` from 180° W,
row `y` from the north) of one layer at a whole hour. The tile's box and
sample spacing are fixed by `z`/`x`/`y`, so the same tile at the same
hour is always the same answer: the plugin saves it on disk and answers
it again from disk without its data worker. A tile being computed for
several clients is computed once; a request whose client goes away
before its query has started is dropped from the data worker's queue.

| Path / query | Values |
|---|---|
| `layer` | `wind`, `waves`, `msl`, `temperature`, `sst`, `precip`, `sea_state`, `current`, `tide` (colour layers), `barbs` (wind barbs), `arrows` (current arrows), `land` (coastline) |
| `z` | 0–18 |
| `x`, `y` | 0 to 2^z − 1 |
| `time` | ISO 8601, default now; rounded to the nearest hour. Ignored for `land` |

`200`, `Content-Encoding: gzip`, `X-Tile-Cache: hit` (from disk) or
`miss` (computed now), and the caching headers of the map layers
(`land`: `max-age=86400`). Bodies after gzip decoding:

- colour layers: as [`/api/field`](#get-apifield) for the tile's box
  extended by one sample spacing on every side (so a tile's edge pixels
  interpolate between samples), spacing = tile width ÷ 64, clamped to 0.002°–2°;
- `barbs`: as [`/api/wind-points`](#get-apiwind-points), 7 across a tile;
- `arrows`: as [`/api/currents`](#get-apicurrents), 5 across a tile;
  for both, points on the tile's east and north edges belong to the
  neighbouring tile;
- `land`: 256 × 256 bytes, 1 = land, row 0 at the north edge, rows
  evenly spaced in Web Mercator y (the map's own rows), columns evenly
  spaced in longitude.

`400` as for the per-box endpoints (e.g. `no wave data in the
forecast`), or for a layer, zoom or tile number out of range. Saved
tiles live in `overlay-tiles/` in the plugin data directory, one
directory per data generation (a new forecast cycle, currents run or
tide run replaces its layers' tiles), under the `overlayCache.diskCap`
byte cap. A tile computed while an on-demand current or tide area was
still loading (60 s wait) is answered but not saved.

#### GET /api/legends

Colour ramps for the colour layers, in SI. Sent with `Cache-Control:
public, max-age=3600`. `200`: `{key: entry}` for the keys `wind`,
`current`, `waves`, `precip`, `temperature`, `sst`, `sea_state` and
`tide`.

| Field | Type | Notes |
|---|---|---|
| `title` | string | e.g. `"Significant wave height"` |
| `quantity` | string | `speed`, `wave_height`, `precip_depth_rate`, `temperature`, `index` or `sea_level` |
| `category` | string or null | Signal K unit-preference category to format the stop values with (`speed`, `depth`, `temperature`); null for the sea-state index and the precipitation rate |
| `si_unit` | string | `m/s`, `m`, `K`, or `""` for the index |
| `kind` | string | `gradient`, or `bands` for `sea_state` |
| `stops` | `[[value, colour]]` | ascending SI values and CSS colours |
| `bands` | `[[value, label]]` | `sea_state` only: band lower bounds and names |

The `tide` ramp is diverging over −3..+3 m; values beyond take the end
colours.

### Polars

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/api/polars` | readonly | polar library |
| GET | `/api/polar-angles` | readonly | best upwind and downwind VMG angles per wind speed |
| GET | `/api/polars/table` | readonly | polar speed table in m/s |
| POST | `/api/polar-from-specs` | readwrite | generate a polar from boat specs |

A polar is named by a token. `default` is the configured `polarFile`;
any other token is a `.pol` or `.csv` file name relative to `polarsDir`
(for example `a_boat.pol`, `user/my_boat.csv` or
`user/<account>/<file>`). Tokens outside the library are refused.

#### GET /api/polars

`200`: `[{path, label, source}]`. `path` is the token, `label` the name
to show (`"<name> (default)"` for the default, `"user: <name>"` for
user polars), and `source` is `"default"` or `"library"`. The list
holds the default polar, then every `.pol`/`.csv` in `polarsDir`, then
those in `polarsDir/user/` and in each `polarsDir/user/<account>/`; a
file that is the same as one already listed is left out.

#### GET /api/polar-angles

| Query | Default | Notes |
|---|---|---|
| `path` | the default polar | a token |

`200`: `{tws_ms[], beat_deg[], run_deg[]}`: for each true wind speed of
the polar (m/s), the true wind angle of best upwind VMG (scanned
20°–89°, 1° steps) and best downwind VMG (90°–179°).

#### GET /api/polars/table

| Query | Default | Notes |
|---|---|---|
| `path` | `default` | a token |

`200`: `{path, twa_deg[], tws_ms[], speeds_ms[][]}`. `speeds_ms[i][k]`
is the boat speed (m/s, 4 decimals) at `twa_deg[i]` and `tws_ms[k]`.

Errors for both: `404 {error: "polar not found…"}` for a token not in
the library; `400 {error}` when no polar is configured (`no polar
configured`, `no default polar is configured`) or the plugin is not
started.

#### POST /api/polar-from-specs

Generate a polar with the physics polar calculator
(`src/vessel/vpp_physics.ts`: ORC 2026 sail forces, Delft hull
resistance, a heeling limit; see `docs/plans/vpp-physics.md`), write it
to `<polarsDir>/user/<slug>.csv` in the routing server's CSV layout, and
return it. Access: readwrite.

Body `{name, specs, overwrite?}`:

| Field | Type | Unit | Default | Limits |
|---|---|---|---|---|
| `name` | string | | required | 1–60 characters. Slugified to the file name: lower case, spaces to `_`, only `[a-z0-9_-]` kept; must keep at least one letter or digit |
| `overwrite` | boolean | | false | replace an existing polar of that name |
| `specs.loa_m` | number | m | required | 3..50 |
| `specs.lwl_m` | number | m | required | 2..50, and not more than `loa_m` + 0.01 |
| `specs.beam_m` | number | m | required | 0.5..15 |
| `specs.draft_m` | number | m | required | 0.1..8 |
| `specs.displacement_kg` | number | kg | required | 50..500000 |
| `specs.sail_area_upwind_m2` | number | m² | required | > 0 (main + 100% jib) |
| `specs.ballast_kg` | number or null | kg | null | |
| `specs.sail_area_downwind_m2` | number | m² | 0 | accepted but not used: no spinnaker is assumed (a value > 0 adds a warning) |
| `specs.mast_height_m` | number or null | m | null | |
| `specs.rig_type` | string | | `sloop` | `sloop`, `cutter`, `ketch`, `yawl`, `cat` |
| `specs.keel_type` | string | | `fin` | `fin`, `bulb`, `wing`, `full`, `centerboard`, `swing` |
| `specs.hull_type` | string | | `monohull` | `monohull`, `catamaran`, `trimaran` (only monohulls are modelled) |

| Status | Body |
|---|---|
| 200 | `{path, label, warnings, polar}`: `path` is `user/<slug>.csv`, a `vessel.polar` token; `label` is `"user: <name>"`; `warnings` lists specs outside typical ranges (displacement-length ratio outside 50–400, SA/D outside 8–30, an unused downwind sail area); `polar` is `{path, twa_deg[], tws_ms[], speeds_ms[][]}` as served by `/api/polars/table` |
| 400 | `{error}`: invalid specs or name, or no `polarsDir` configured |
| 409 | `{error}`: the file exists and `overwrite` is not true |
| 422 | `{error}`: a multihull, which the calculator does not model |
| 500 | `{error: "VPP failed: …"}`: the calculation failed |

Against 441 ORC 2026 non-spinnaker certificates it was not fitted on,
the calculator's median error is 3.3% upwind, 3.2% reaching and 3.3%
running (6–20 kn). ORC's speeds are race predictions; use the polar
performance setting for a cruising boat. In the webapp, use "Create
polar from boat specs…" under the polar picker.

### Settings

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/api/settings` | readonly | web-app settings and their schema |
| PUT | `/api/settings` | readwrite | change some settings |

The settings, their groups and defaults are listed under
[Configuration](#configuration). They are stored in `settings.json` in
the plugin data directory and shared by every client. Values on the
wire are SI (m, m/s, s; degrees for the heading increment); a client
shows them in the Signal K user's unit preferences.

#### GET /api/settings

Sent with `Cache-Control: no-store`. `200`: `{values, schema}`.
`503 {error: "plugin not started"}` when the plugin is not running.

- `values`: `{group: {key: value}}` for the groups `vessel`,
  `forecast`, `currents`, `tides`, `routing` and `publish`.
- `schema.groups`: `[{id, label, help}]`.
- `schema.settings`: one entry per setting:

| Field | Notes |
|---|---|
| `key` | `group.key`, e.g. `vessel.draught` |
| `group` | group id |
| `label`, `help` | text for display |
| `type` | `number`, `integer`, `boolean`, `string` or `enum` |
| `unit` | SI unit of the value (`m`, `m/s`, `s`, `deg`); absent for dimensionless values |
| `quantity` | display quantity for unit conversion: `speed`, `depth`, `wave_height`, `short_distance`, `ratio`, `megabytes`, `hours`, `minutes`, `seconds`, `angle` or `count` |
| `min`, `max` | range |
| `multipleOf` | value must be a whole multiple of this (e.g. 3600 s) |
| `oneOf` | value must be one of these (e.g. `[3600, 10800]`) |
| `default` | default value |
| `nullable` | null is allowed (e.g. no maximum wave height) |
| `enum` | allowed strings |
| `maxLength` | for strings |
| `reload` | what a change re-does: `forecast`, `currents`, `tides`, `refresh_timer`, `jobs`, `next_job` (nothing now; the next route uses it) or `cache` (used at the next cache prune) |

#### PUT /api/settings

Body: only the keys to change, nested by group, in SI, e.g.
`{"vessel": {"draught": 1.9}}`. Every key is validated (type, range,
enum); either all are saved and applied, or none.

| Status | Body |
|---|---|
| 200 | `{values, changed, reloaded}`: all values after the change; `changed` lists the `group.key` names whose value changed; `reloaded` is `{forecast, currents, tides, refresh_timer, jobs}`, each true when the change re-did it |
| 400 | `{error, errors}`: `errors` is `{"group.key": message}` (or `{group: message}` for an unknown or non-object group, `{"": message}` for a non-object body); nothing is saved |
| 503 | `{error}`: plugin not started |
| 500 | `{error}`: any other failure |

What a change re-does: a new forecast horizon, extra-fields choice or
"memory kept free" reloads the forecast; SMOC and RTOFS settings reload
currents; tide settings reload tides only; the check interval restarts
the refresh timer; "finished routes kept" trims the job list; everything
else applies to the next route. A forecast change that the device
cannot hold (memory for one decode step, disk for the decoded run) is
refused with `400` before anything is saved, with the reason under the
setting's key. Per-route values in a route request (`vessel.*`,
`stages`, `sail_thresh_ms`, `simplify_m`, `smoother`,
`smoother_tolerance`, `publish`) take precedence over the settings.

### Signal K integration

#### Weather API provider

When the Signal K plugin configuration has `weatherProvider.enabled`
(the default) and the server has the Weather API, the plugin registers
as a Weather API provider named "Weather Router Plus (ECMWF open data)"
once the first forecast run is ready. `/api/status` reports
`weather_provider_registered`. The server answers
`/signalk/v2/api/weather/…` requests through its registered providers.

| Weather API method | Result |
|---|---|
| point forecasts (`/signalk/v2/api/weather/forecasts/point?lat=&lon=`) | one entry per forecast step, anywhere on the globe |
| daily forecasts | empty list |
| observations | empty list |
| warnings | empty list |

For point forecasts the server passes the options `startDate` and
`maxCount`, from the Weather API query parameters `date` and `count`
(beside `lat`, `lon` and `provider`; upstream
`src/api/weather/index.ts`, `parseQueryOptions`). Steps that ended more than 3 hours before `startDate` (or
now, without it) are skipped, and at most `maxCount` entries are
returned. A position outside the forecast is an error.

Each entry (Signal K units: m/s, rad, Pa, K, m, s, ratio):

| Field | Source | Notes |
|---|---|---|
| `date` | step valid time | ISO 8601 |
| `type` | | `"point"` |
| `description` | | `"ECMWF IFS 0.25° open data, cycle <ISO>, +<h> h"` |
| `wind.speedTrue` | 10 m wind | m/s |
| `wind.directionTrue` | 10 m wind direction FROM | rad |
| `outside.pressure` | `msl` | Pa |
| `outside.temperature` | `2t` | K; extra fields only |
| `outside.dewPointTemperature` | `2d` | K; extra fields only |
| `outside.relativeHumidity` | from `2t` and `2d` | ratio 0..1; extra fields only |
| `water.temperature` | `skt` | K; extra fields only |
| `water.waveSignificantHeight` | `swh` | m |
| `water.wavePeriod` | `mwp` | s |
| `water.waveDirection` | `mwd` (FROM) | rad |
| `water.level` | Copernicus Marine hourly sea level | m, total water level (tide + surge) relative to local mean sea level, not chart datum; tides on only |
| `water.levelTendency` | same | `increasing`, `decreasing` or `steady` (within ±2 cm/h), `not available` |

A field is left out when its value is not available. The Weather API
omits precipitation volume, because only the instantaneous rate is
fetched. When the water-level series cannot be fetched, the two
`water.level*` fields are left out and the rest is returned.

#### Resources API publishing

When a job finishes and publishing is on (the request's `publish`, else
the `publish.toResources` setting, default on), the plugin saves the
route with the server's Resources API as
`/signalk/v2/api/resources/routes/{jobId}`: the resource id is the job
id. This needs a routes provider such as `resources-provider`. A failure
is logged and recorded in the job's `publish_error`; `POST
/api/routes/{id}/publish` retries. `GET /api/routes/{id}/signalk`
returns the same record.

| Field | Notes |
|---|---|
| `name` | the request's `name`, or the default name (see `POST /api/routes`) |
| `description` | `"Weather route, <nm> nm, <h> h"` (one decimal each) |
| `distance` | total distance, m |
| `start`, `end` | departure and arrival times, ISO 8601 |
| `feature` | GeoJSON Feature with a LineString of `[lon, lat]` |
| `feature.properties.source` | `"signalk-weather-router-plus"` |
| `feature.properties.total_time_s`, `motoring_time_s`, `sailing_time_s` | s |
| `feature.properties.departure`, `arrival` | ISO 8601 |
| `feature.properties.coordinatesMeta` | one item per coordinate, in order: `name` (`"Start"`, `"WP1"`, `"WP2"`, …, `"End"`) plus the point properties of the GeoJSON result (`lon`, `lat`, `time`, `sog_ms`, `cog_deg`, `depth_m`, `mode`, and the wind, wave, current, `leg` and `role` fields when present; not `leg_distance_m` / `leg_time_s`) |

#### Notifications

When the `publish.notifications` setting is on (default), the plugin
sends a delta for the own vessel on the path
`notifications.weatherRouterPlus.<jobId>`:

| When | `state` | `message` |
|---|---|---|
| route done | `normal` | `route ready: <nm> nm, <h> h` |
| route failed | `alert` | `route failed: <error>` |

The value is `{state, method: [], message, timestamp}`. Cancelled jobs
send no notification. The plugin emits no other deltas.

#### OpenAPI

The plugin gives its OpenAPI document to the server (`getOpenApi()`)
and serves it at `GET /api/openapi.json` (readonly).

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
