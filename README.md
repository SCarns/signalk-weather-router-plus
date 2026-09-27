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
| Test page (map, compute, watch progress) | `/plugins/signalk-weather-router-plus/ui` |
| Route job API (REST + Server-Sent Events) | `/plugins/signalk-weather-router-plus/api/…` |
| OpenAPI | `/plugins/signalk-weather-router-plus/api/openapi.json` |
| Finished routes | saved to `/signalk/v2/api/resources/routes/{jobId}` (needs a routes provider, e.g. `resources-provider`) |
| Weather API provider | point forecasts from the resident forecast region via `/signalk/v2/api/weather/forecasts/point?lat=&lon=` |
| Notifications | `notifications.weatherRouterPlus.{jobId}` on completion or failure |
| CLI (no Signal K) | `wrp-route` |

## Data

- **Forecast:** ECMWF IFS 0.25° open data, `oper`/`wave` streams
  (00z/12z) or `scda`/`scwv` (06z/18z). Fields: `10u`, `10v`, `msl`,
  `swh`, `mwp`, `mwd`. Only those fields are fetched (byte-range
  requests against the published `.index` files, roughly 4.7 MB per
  step instead of 140 MB), cached on disk under the plugin's data
  directory, and only the configured region is kept in memory
  (about 7 kB per field per step for a 10°×10° region).
- **Land:** GSHHG shorelines as shapefiles (`GSHHS_f_L1.shp` for full
  resolution; add `GSHHS_f_L6.shp` for Antarctica) or the OSM
  land-polygons export. Loaded per route bounding box and rasterised at
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
shapefile path. A polar file (`.csv` or `.pol`, knots) enables sailing;
without one every route is motor-only.

## Configuration

| Field | Notes |
|---|---|
| `landShapefiles` | comma-separated absolute paths |
| `polarFile` | `.csv` (`twa/tws,4,6,…`) or `.pol` (tab-delimited) |
| `vessel.*` | draught, air draft, LOA, beam (m), cruising speed under power (kt) |
| `forecast.horizonHours` | default 72; up to 240 on 00z/12z cycles |
| `forecast.region` | explicit west/south/east/north; otherwise a box of `regionFromVesselDeg` around the vessel position |
| `forecast.mirror` | `ecmwf`, `aws` or `google` |
| `routing.*` | stages (20), subsectors (30), headings (30), heading increment (1°), sail threshold (kt), simulation step (m), land raster cell budget |
| `publish.toResources` | save finished routes to the Resources API (default on) |
| `weatherProvider.enabled` | register with the Weather API (default on) |

## API

```
POST /plugins/signalk-weather-router-plus/api/routes
{
  "start": {"lat": 41.44, "lon": -71.36},
  "end":   {"lat": 32.42, "lon": -64.58},
  "waypoints": [{"lat": 41.13, "lon": -71.53, "radius_m": 1000}],
  "departure": "2026-09-28T12:00:00Z",
  "mode": "sail_max",
  "name": "Newport to Bermuda"
}
→ 202 {"id": "…", "status": "queued", "links": {…}}

GET  …/api/routes/{id}          status, progress, summary
GET  …/api/routes/{id}/events   SSE: status, progress, route, done, error (Last-Event-ID honoured)
GET  …/api/routes/{id}/result   GeoJSON FeatureCollection (LineString + one Point per waypoint)
GET  …/api/routes/{id}/signalk  Signal K route record
POST …/api/routes/{id}/cancel
POST …/api/routes/{id}/publish
GET  …/api/forecast?lat=&lon=   resident forecast metadata and a time series at a position
POST …/api/forecast/refresh
GET  …/api/status
```

All values are SI: metres, m/s, seconds, degrees true; the client converts.
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
