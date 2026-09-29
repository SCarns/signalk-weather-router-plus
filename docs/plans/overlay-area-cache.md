# Plan: disk cache of the map overlays and conditions around the boat and the view

Status: **decided** 2026-09-29, not built yet (except the land-raster disk
cache, see "Already done").

Decisions (user, 2026-09-29):
- Deepest pre-built zoom: **15**.
- No taper: **every hour of the cache window the user sets**, at every
  pyramid level.
- All 8 colour layers pre-built.
- Disk cap default: **20 GB** (20e9 B), user-settable.
- Radius default 250,000 m; window default: the whole forecast.

User request (2026-09-29): set a radius around the vessel's last known
position and cache on disk all the overlays and the conditions for that
area; the radius is a distance (Signal K `distance` category) settable in
the plugin configuration; cache smaller areas at deeper zoom levels; the
cached area follows the map as it moves; the forecast length should reach
as far as the data goes, as an optional setting. All values SI.

## Problem (measured on brain, 2026-09-29)

- Over 3 hours of normal use the page sent 6,867 overlay requests. Median
  response time (Signal K access log): wind barbs 10.2 s, current arrows
  10.3 s, sea state 8.0 s, land mask 5.8 s, waves 2.3 s, wind 1.5 s.
- The same requests alone take 10–250 ms (`curl` on brain, one at a
  time). The time is queueing: every request goes through the single data
  worker, one at a time, and the page never cancels requests for tiles it
  no longer shows.
- During a zoom-out the worker also rebuilt land rasters back to back
  (~165 ms each; 673 builds against 1,573 hits in 20 minutes). Fixed
  separately; see "Already done".

## What a map view costs (measured on brain, one tile, one hour)

The page asks per web-map tile (zoom 6: 5.625° wide … zoom 12: 0.0879°).
A colour-layer grid is capped at 40,000 cells, so a tile's response is
about the same size at every zoom.

| Layer | gzip size | Compute |
|---|---|---|
| wind | 73–80 kB | 0.20–0.25 s |
| waves | 90–105 kB | 0.04 s |
| pressure (msl) | 38–44 kB | 0.03 s |
| temperature | 22–34 kB | 0.03–0.05 s |
| rain | 5–7 kB | 0.04–0.06 s |
| sea state | 53–60 kB | 0.16–0.17 s |
| current | 48–63 kB | 0.13–0.14 s |
| tide | 13–16 kB | 0.03–0.06 s |
| **all 8 colour layers** | **~390 kB** | **~0.7 s** |
| wind barbs | 2 kB | 0.01 s |
| current arrows | 2–4 kB | 0.18–0.20 s |

## Design

### 1. Areas

- **Boat area:** centred on the vessel's last known position
  (`navigation.position`, kept across restarts).
- **View area:** centred on the page's current view, inferred from the
  tile requests it already sends (centre and zoom), so no new API.
- **Pyramid (the same for both):** the full radius at zoom ≤ 8, halved at
  each deeper level. Tiles covering a 250,000 m radius at 41 °N:

  | Zoom | Radius (m) | Tiles |
  |---|---|---|
  | 6 | 250,000 | 4 |
  | 7 | 250,000 | 12 |
  | 8 | 250,000 | 30 |
  | 9 | 125,000 | 36 |
  | 10 | 62,500 | 30 |
  | 11 | 31,250 | 25 |
  | 12 | 15,625 | 30 |
  | 13 | 7,812 | 25 |
  | **total** | | **192** |

  (A full 250,000 m radius at every level would be 4,761 tiles at zoom 12
  alone.)

### 2. Time

- **Exact hourly frames, not blended forecast steps.** The page shows any
  hour; its values are computed at that hour. Blending two cached forecast
  steps would not give the same numbers:
  - wind speed/direction are derived after blending u/v in time,
  - the sea-state index is non-linear,
  - tidal currents are predicted at the exact time and change within
    3 hours.
- **Every hour of the window the user sets**, at every level (no taper).
  Pyramid zoom 6–15 at a 250,000 m radius: **247 tiles**. All 8 colour
  layers + barbs + arrows (~395 kB and ~0.9 s of worker time per
  tile-hour, single worker):

  | Window | Frames | Disk | Worker time per cycle (1 worker) |
  |---|---|---|---|
  | 72 h (default forecast) | 72 | ~7 GB | ~4.4 h |
  | 144 h | 144 | ~14 GB | ~8.9 h |
  | 240 h | 240 | ~23 GB | ~14.8 h |
  | 360 h | 360 | ~35 GB | ~22 h |

  Windows longer than ~144 h take longer than the 6-hourly ECMWF cycle on
  one worker, and exceed the 20 GB default cap beyond ~200 h (the
  setting's help says so).
- **Pre-build workers:** separate worker threads (brain: 4 cores, 8 GB),
  2–3 in parallel, at lower priority than on-screen requests and routes,
  so their time per cycle drops roughly by that factor. Their count is a
  setting.
- **Priority:** what is on screen first, then the view's ring and pyramid,
  then the boat area; within each, nearest lead time and zoomed-out
  levels first. A new forecast cycle restarts the queue; tiles of the old
  cycle are dropped.

### 3. Serving

- A cached tile is answered by the **main thread** from disk (gzip bytes
  sent with `Content-Encoding: gzip`), never through the data worker, so
  cached views do not queue.
- Uncached tiles go to the worker as now, and the answer is saved.
- The page aborts requests for tiles no longer shown (pan, zoom, time
  change), so the worker stops doing work nobody needs.

### 4. What is cached

- Colour layers (`/api/field`), wind barbs, current arrows, land mask
  (never expires: the coastline does not change), isobars (per frame).
- All 8 colour layers are pre-built.
- **Conditions** (the point popup): measure first. Since the tide
  speed-up a conditions request should take well under a second; if it
  does, it is not cached. If not, cache it for points on a grid.

### 5. Forecast length

- ECMWF open data (ecmwf.int, "Open data"): 00z and 12z runs go to 360 h
  (0–144 h every 3 h, 150–360 h every 6 h); 06z and 18z to 144 h.
- The plugin's `forecast.horizon` stops at 240 h. Raise the limit to
  360 h. Needs checking: whether the wave fields follow the same
  schedule, how a 06z/18z cycle (144 h) is handled when the horizon is
  longer, and the decoded run's disk size at 360 h (1.1 GB at 72 h with
  the extra fields today).

### 6. Settings (SI; shown in the user's Signal K units)

| Setting | Unit | Default |
|---|---|---|
| enabled | boolean | on |
| radius | m (`distance` category) | 250,000 |
| cache window | s | the whole forecast |
| deepest pre-built zoom | level | 15 |
| disk cap | B | 20e9 (20 GB) |
| pre-build workers | count | 2 |
| follow the view | boolean | on |

Set in a custom Admin UI plugin configuration panel (keyword
`signalk-plugin-configurator`, Module Federation, exposing
`./PluginConfigurationPanel`, React 19), which reads the user's Signal K
units so the radius shows as a distance. The panel replaces the generic
form, so it also carries the existing plugin options (coastline files,
polar file, polars directory, harmonics directory, ECMWF mirror, Weather
API switch). To check before building: the props the Admin UI passes to
the panel (upstream `EmbeddedPluginConfigurationForm.tsx`).

## Already done (deployed to brain, not yet restarted)

- Land rasters saved on disk (`overlay-land/coast-<fingerprint>/`, gzip,
  ~8 kB each, 256 MB cap, least recently used pruned) and reused after a
  restart; 8 kept in memory as before. Build ~68–88 ms on the Mac
  (~165 ms on brain) against ~1 ms from disk.

## Build order

1. Forecast length limit raised to 360 h (after the checks in 5).
2. Cache store on disk + main-thread serving of cached tiles; page aborts
   stale requests. Measure the 10 s median again.
3. Pre-build workers, boat-area pyramid, cycle invalidation, disk cap.
4. View-following area.
5. Conditions: measure; cache only if needed.
6. Admin UI configuration panel (React 19, Module Federation) with the
   settings in the user's units.

## Verification

- On brain, the same map session as the 2026-09-29 log: median tile
  response before and after, worker queue length, disk used, build time
  per cycle.
- Cached and freshly computed tiles for the same tile and hour are
  byte-identical.
