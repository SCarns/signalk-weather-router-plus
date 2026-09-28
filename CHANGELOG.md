# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/).

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
