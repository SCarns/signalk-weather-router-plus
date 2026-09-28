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

## What it provides

| Surface | Path |
|---|---|
| Webapp (map, compute, watch progress) | listed in the Admin UI's Webapps page as **Weather Router Plus**; served at `/signalk-weather-router-plus/` (also `/plugins/signalk-weather-router-plus/ui`) |
| Route job API (REST + Server-Sent Events) | `/plugins/signalk-weather-router-plus/api/…` |
| OpenAPI | `/plugins/signalk-weather-router-plus/api/openapi.json` |
| Finished routes | saved to `/signalk/v2/api/resources/routes/{jobId}` (needs a routes provider, e.g. `resources-provider`) |
| Weather API provider | point forecasts anywhere from the resident global forecast via `/signalk/v2/api/weather/forecasts/point?lat=&lon=`, with `water.level` / `water.levelTendency` (relative to mean sea level) when tides are on |
| Notifications | `notifications.weatherRouterPlus.{jobId}` on completion or failure |
| CLI (no Signal K) | `wrp-route` |

## Data

- **Forecast:** ECMWF IFS 0.25° open data, `oper`/`wave` streams
  (00z/12z) or `scda`/`scwv` (06z/18z). Fields: `10u`, `10v`, `msl`,
  `swh`, `mwp`, `mwd`. Only those fields are fetched (byte-range
  requests against the published `.index` files, roughly 4.7 MB per
  step instead of 140 MB) and cached on disk under the plugin's data
  directory. The whole globe is kept in memory at full Float32
  precision (exactly the decoded values), so overlays, conditions, the
  Weather API and routing work anywhere: 1440 × 721 cells × 4 B =
  4.15 MB per field per step. A 72 h horizon (25 steps) is 623 MB with
  the six base fields and 1.14 GB with the extra fields (`2t`, `tprate`,
  `skt`, `2d`, `ptype`). The fields live in SharedArrayBuffers, so the
  data worker, the main thread and the route worker share that one
  copy. While a new cycle loads the previous one stays resident, so
  peak memory during a reload is twice that.
- **Land:** GSHHG shorelines as shapefiles (`GSHHS_f_L1.shp` for full
  resolution; add `GSHHS_f_L6.shp` for Antarctica) or the OSM
  land-polygons export. Overlay land flags use a raster built on demand
  for each requested bbox at a resolution matched to the request's
  sample spacing (a quarter of it, 0.002° to 0.25°, at most 4 M cells),
  from an in-memory index of the shapefile records; the last 8 rasters
  are kept. Conditions `is_land` uses the exact polygons. For routing,
  land is loaded per route bounding box and rasterised at
  the finest resolution that fits the configured cell budget (0.5 m
  arc-seconds to 0.01°). The raster is conservative: cells crossed by a
  coastline edge count as land. Endpoints and the finished route are
  checked against the exact polygons.
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
    views, lattice ≥ 0.25°). On-demand areas are kept in an LRU of
    256 MB per worker; a single area is capped at half that (a route box
    too large at 1/12° is loaded at 1/3°). Overlay queries wait at most
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
  their hour on demand (1/3° grid for zoomed-out views), LRU under
  128 MB. Measured at 15° around Newport: 368 × 368 cells × 31 hourly
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

## Routing engine

A port of the routePlanning `OceanPropagator` (subsector isochrone,
Hagiwara 1989 / Chen & Mao 2024):

1. A coarse A* on a raster of the land mask produces a land-avoiding
   skeleton; each stage aims its heading sweep at the next skeleton point.
2. From each retained parent, 2m+1 candidate headings are projected one
   stage step ahead; candidates whose great-circle leg touches land are
   dropped; survivors are timed by a leg simulator that samples wind and
   the polar every `simStepM` metres (mode policy `sail_max`, `fastest`
   or `motor`).
3. Candidates are binned by cross-track offset into 2k subsectors and
   the cheapest per bin is kept.
4. Vias are soft pass-through discs; a branch must cross each disc in
   order before it may finish.

One deliberate difference from the reference: the stage budget is sized
to the skeleton length, not the straight-line distance, so detours around
land fit within the configured number of stages.

If a route arrives after the last forecast step, conditions are held at
the last step and the GeoJSON carries `forecast_horizon_exceeded_s`.

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
the selected display units. Saving needs a `readwrite` login.

| Group | Settings (default) | A change… |
|---|---|---|
| `vessel` | name, draught (1.8 m), air draft (16 m), LOA (11 m), beam (3.7 m), under-keel margin (0.5 m), overhead margin (1 m), speed under power (6 kt = 3.087 m/s), max wave height (none), tack penalty (30 s) | applies to the next route |
| `forecast` | horizon (72 h = 259200 s, 3–240 h), check interval (60 min), cached cycles kept (2), extra fields (on) | horizon / extra fields reload the forecast; the interval restarts the timer |
| `currents` | SMOC on, SMOC horizon (72 h = 259200 s, 6–240 h), SMOC step (3 h = 10800 s; 1 h or 3 h only), SMOC area half-width (15°, 2–30°), RTOFS on, RTOFS product (`west_atl`, …), RTOFS horizon (72 h), RTOFS step (3 h) | reloads currents |
| `tides` | Copernicus Marine sea level on, tide map area half-width (15°, 1–30°), tide map horizon (24 h = 86400 s, 6–240 h) | reloads tides only |
| `routing` | stages (20), subsectors (30), headings (30), heading increment (1°), sail threshold (4.9 kt), simulation step (200 m), land raster cell budget (25 M), finished routes kept (50) | applies to the next route |
| `publish` | save to the Resources API (on), route name prefix (`WRP`), notifications (on) | applies to the next route |

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
  "waypoints": [{"lat": 41.13, "lon": -71.53, "radius_m": 1000}],
  "departure": "2026-09-28T12:00:00Z",
  "mode": "sail_max",
  "name": "Newport to Bermuda",
  "vessel": {"polar": "a_boat.pol"}
}
→ 202 {"id": "…", "status": "queued", "links": {…}}
```

`vessel.polar` is a token from `GET …/api/polars`. A file name such as
`a_boat.pol` resolves only inside the configured `polarsDir`. Use
`"default"`, or omit the field, for the configured `polarFile`.

`POST …/api/polar-from-specs` (readwrite) takes `{name, specs, overwrite?}`
with the routing server's boat-spec fields (`loa_m`, `lwl_m`, `beam_m`,
`draft_m`, `displacement_kg`, `sail_area_upwind_m2`, optional `ballast_kg`,
`sail_area_downwind_m2` (0 = 1.5 × upwind), `mast_height_m`, `rig_type`,
`keel_type`, `hull_type`). It runs the same empirical VPP as the routing
server, writes `<polarsDir>/user/<slug>.csv` in its CSV layout and returns
`{path, label, warnings, polar}`, where `path` (`user/<slug>.csv`) is a
`vessel.polar` token. 400: invalid specs, bad name, or no `polarsDir`;
409: the file exists and `overwrite` is not true; 422: a multihull, which
the empirical VPP cannot model. In the webapp, use "Create polar from
boat specs…" under the polar picker.

`GET …/api/conditions-tile/{z}/{x}/{y}?t=` returns the conditions fields
(the same names and units as `/api/conditions` rows) at the wind-barb
sample points of one XYZ tile for the hour `t`, with land points dropped.
Tiles below zoom 5 are empty. The webapp draws them as the Conditions dot
layer (Layers → Weather).

```

GET  …/api/routes/{id}          status, progress, summary
GET  …/api/routes/{id}/events   SSE: status, progress, route, done, error (Last-Event-ID honoured)
GET  …/api/routes/{id}/result   GeoJSON FeatureCollection (LineString + one Point per waypoint)
GET  …/api/routes/{id}/signalk  Signal K route record
POST …/api/routes/{id}/cancel
POST …/api/routes/{id}/publish
GET  …/api/forecast?lat=&lon=   resident forecast metadata and a time series at a position
GET  …/api/settings             web-app settings {values, schema} (SI)
PUT  …/api/settings             change some settings (readwrite)
GET  …/api/polars               polar library: the configured default + every .pol/.csv in the polars directory
GET  …/api/polar-angles?path=   best upwind/downwind VMG angles per TWS (point-of-sail bucketing)
GET  …/api/polars/table?path=   polar speed table in m/s for drawing
POST …/api/polar-from-specs     generate a polar from boat specs (empirical VPP) → <polarsDir>/user/<slug>.csv
GET  …/api/legends              colour ramps (SI stops) for every overlay
GET  …/api/field?layer=&bbox=&time=&res=      JSON grid for a heatmap layer (wind, waves, msl, temperature, sst, precip, sea_state, current, tide → tide_m in m above MSL)
GET  …/api/wind-points?bbox=&time=&res=       barb points
GET  …/api/currents?bbox=&time=&res=          current arrow points
GET  …/api/pressure?bbox=&time=&interval=     isobars + H/L as GeoJSON
GET  …/api/conditions?lon=&lat=&from=&hours=  72-hour conditions series at a point, with tide_m / water_level_m / surge_m /
                                              tide_extrapolated / tide_tendency per row and `tides` {highs, lows, range_m, …}
GET  …/api/conditions-tile/{z}/{x}/{y}?t=YYYY-MM-DDTHH   conditions sample points for one map tile at one hour
POST …/api/forecast/refresh
GET  …/api/status
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

`--no-forecast` routes with calm wind; `--via "lat,lon@radius_m;…"` adds pass-through discs.

## Verification

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
- No depth data.
- SMOC areas are loaded whole-chunk: a box outside the resident area
  costs its chunks' download (see the measured sizes above), cached for
  the rest of the day's run.
- Routes beyond the forecast horizon use the last step's conditions.
- One route computes at a time (single worker thread); others queue.
