# signalk-weather-router-plus

Standalone open-water weather routing as a Signal K plugin. Nothing runs
outside the Signal K process: the plugin downloads ECMWF open-data
forecasts by HTTP byte range, decodes the CCSDS-packed GRIB2 fields in
TypeScript, avoids land with GSHHG coastline polygons, and runs an
isochrone router against the vessel's polar in a worker thread.

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
| Weather API provider | point forecasts anywhere from the resident global forecast via `/signalk/v2/api/weather/forecasts/point?lat=&lon=` |
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
- **Currents:** none in this version.

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
| `currents` | RTOFS on, RTOFS product (`west_atl`, …), RTOFS horizon (72 h), RTOFS step (3 h) | reloads currents |
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
GET  …/api/field?layer=&bbox=&time=&res=      JSON grid for a heatmap layer (wind, waves, msl, temperature, sst, precip, sea_state, current)
GET  …/api/wind-points?bbox=&time=&res=       barb points
GET  …/api/currents?bbox=&time=&res=          current arrow points
GET  …/api/pressure?bbox=&time=&interval=     isobars + H/L as GeoJSON
GET  …/api/conditions?lon=&lat=&from=&hours=  72-hour conditions series at a point
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
- `npm run test:corpus <dir>` compares the decoder value-for-value
  against an eccodes dump of any GRIB2 corpus (see `tools/verify_grib_corpus.ts`).
  On 30 ECMWF messages (12- and 16-bit, with and without bit maps) it
  matched all 31,147,200 cells exactly.

## Limits

- Open water only. A start or end inside a narrow harbour can fail with
  "stage 1 has no live waypoints"; start from the harbour approach.
- No depth or current data.
- Routes beyond the forecast horizon use the last step's conditions.
- One route computes at a time (single worker thread); others queue.
