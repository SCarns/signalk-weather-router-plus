# Plan: stage fronts on the map, and max wind / max wave / no-go regions

Status: proposal, 2026-10-01. Anchors are into this repository at that date.

Two features borrowed from signalk-weather-routing's good side (its isochrone
display and its constraints), designed for this router. Not borrowed: GRIB
file input (the files still have to be fetched; nothing is gained).

## Two facts that shape the design

1. **Our frontiers are not isochrones.** The propagator advances one distance
   stage at a time (`src/engine/propagator.ts:1-48`, settings at 224-230);
   every frontier point keeps its own arrival time (`Candidate.timeMs`,
   196-209). So what we can draw is the **front of each stage**, with its
   points' times, not equal-time curves. The display must say "stage fronts",
   not "isochrones", or it misleads.
2. **The search samples wind and current only** (`legsim.ts:126-230`,
   `scoreCandidatesFromParent`: `wind.atMany`, `current.atMany`). Wave height
   is read once, after the route is found (`enrichWaypoints`,
   `propagator.ts:1018-1031`). A wave limit therefore needs wave sampling in
   the search, and the forecast window already holds `swh/mwp/mwd`
   (`worker.ts:1292`), so it is a sampling change, not a data change.

## A. Stage fronts on the map

### Engine

- Capture each stage's final frontier at the one place it exists:
  `stages.push(retained)` (`propagator.ts:731`). Add an optional callback
  `onFrontier?(stage, points)` beside `onProgress` (`ComputeRouteArgs`, 139)
  and also return the fronts as `Route.fronts` (like `Route.skeleton`,
  `route.ts:66-67`), as `{ stage, points: { lon, lat, timeMs, viaCount }[] }`.
- Points come out in Map insertion order (730). For a line, sort by
  cross-track offset (`perpendicularOffsetM`, as at 721) and group by
  `viaCount`; about 60 points per via-count per stage. Round to 1e-4°.
- Discard the fronts of a first attempt that ends in `ViasNotCrossedError`
  (the rerun at `worker.ts:1174`); keep only the attempt that produced the
  route. Multi-leg routes: concatenate per leg with the leg index, as
  `stitchLegs` does for skeletons (`multileg.ts:172-224`).

### Job and API

- **Live:** a new SSE event `frontier` (add to `JobEvent['event']`,
  `jobs.ts:15`), one per stage, payload `{ leg, stage, total, points }`. Keep
  it **out of `job.progress`** (the last-200 list, `jobs.ts:205`), out of the
  persisted job file (`persist`, `jobs.ts:95-100`) and out of `toPublic`;
  the 500-event cap (`jobs.ts:118`) is fine for 200 stages once the
  frontier events are not stored at all (stream them straight from the
  worker relay at `index.ts:584-586`).
- **Final:** `job.fronts`, set from the `done` message (`protocol.ts:257-264`,
  `worker.ts:1264-1271`, `jobs.onDone` 209-227), served by
  `GET /api/routes/:id/fronts` modeled on `/skeleton` (`api.ts:553-566`),
  listed in `links()` (`jobs.ts:122-132`). Persisted with the job (about
  200 × 60 points, under 400 KB as JSON).
- OpenAPI: the new path and the `frontier` event in the events description.

### Web app

- `isochroneSource` / `stageFrontLayer` next to the skeleton layer
  (`rp-layers.js:156-162`), zIndex 14 (under the route), inserted in the
  layer list at 1443. Style: thin lines, colour by elapsed time (cool →
  warm), one line per via-count; points when a stage has fewer than 3.
- Live: handle the `frontier` event in `attachToJob` (`rp-plan.js:1045+`)
  and the live-mode stream (2265-2290); replace the layer's features per
  stage, so the search is visible as it runs. Final: fetch `/fronts` where
  the skeleton is fetched (`rp-plan.js:1098-1108`, past jobs
  `rp-core.js:1253-1262`). Clear where the skeleton is cleared
  (`rp-core.js:1269`, `rp-plan.js:294-295`).
- A **Stage fronts** checkbox in the Layers section, off by default,
  remembered like the other toggles. Hovering a front shows its stage and
  the time range of its points.

### Freeboard

Not possible today: the Plotter Extensions API has no vector drawing. The
panel can show stage counts and times as text only. A "vector overlay from
an extension" capability is a Freeboard PR candidate (see
freeboard-sk-integration.md); not pursued here.

### Tests

- Propagator: a short synthetic route yields one front per stage, points
  rounded, `viaCount` groups intact; the rerun discards the first attempt.
- Jobs: `frontier` events are streamed but not persisted or counted in
  `progress`.

## B. Constraints: max wind, max wave, no-go regions

### Semantics

- **Max wind** (m/s, SI) and **max wave** (significant height, m): a leg is
  not allowed where the sampled wind speed or wave height at the leg's time
  exceeds the limit. Hard constraint in the search; if no route exists
  within the limits the job fails with "no route within the wind/wave
  limits" (not "blocked by land", the message today at
  `propagator.ts:687-689`).
- **Regions**: Signal K `resources/regions` (GeoJSON Polygon/MultiPolygon
  features, as Freeboard draws them) chosen by the user are obstacles, like
  land, for the whole pipeline: corridor, search, smoothing, validation. A
  start, destination or waypoint inside a chosen region is an error.
- Both are per route request, with defaults from the web-app settings.

### Request and settings

- `RouteRequest` (`protocol.ts:35-69`): `max_wind_ms?`, `max_swh_m?`,
  `avoid_regions?: string[] | 'all'` (resource ids). Validation in
  `validateRequestShape` (`api.ts:677-711`) and `validateRequest`
  (`worker.ts:926-941`); OpenAPI `routeRequest` (`openapi.ts:56+`).
- Settings (`settings.ts`): `routing.maxWind` and `routing.maxSwh`, SI,
  nullable (null = no limit), with the unit-aware display the Settings tab
  already does; `routing.avoidRegions` boolean (avoid every region by
  default or none). `vessel.maxSwh` had been removed because nothing read it;
  this time the engine reads it.
- Regions are resolved on the main thread: extend `SkApp.resourcesApi` with
  `listResources(type)` (today only `setResource`, `index.ts:72-74`), read
  the chosen regions when a job starts, and pass the polygons to the worker
  in the job message (the worker has no `app`). Unknown ids → 400.

### Wind and wave in the search

- Add a batched `wavesAtMany` to `WindSource` (`environment.ts:12-18`,
  `ForecastStore` at `data/forecast.ts:588-630`), called in
  `scoreCandidatesFromParent` next to `wind.atMany` only when a wave limit
  is set (no cost otherwise).
- Carry the limits in `SimOptions` (`legsim.ts:34-38`). In the scorer loop
  (182-230) mark a candidate `stuck` when `speed > maxWind` or
  `swh > maxSwh` at any sub-step; the propagator already drops stuck
  candidates (`propagator.ts:622`). Mirror the test in `simulateLegTime`
  (`legsim.ts:47-107`, returning Infinity) so the final hop (851), via
  splits (930) and the smoother (`smoother.ts:140`) respect the limits.
- Final validation (`propagator.ts:995`): also report legs whose sampled
  wind or waves exceed the limit as warnings (the route points are
  sampled at waypoints, the search at sub-steps; a difference is possible
  and should be visible).
- Failure message: when every candidate of a stage fails and a limit is
  set, say which limit; keep "blocked by land" for the land case.

### Regions in the pipeline

- Represent a chosen set as `Obstacles` (polygons in lon/lat with bboxes),
  built per route in the worker, never burned into the cached land raster
  (`worker.ts:133, 175-190` reuses one mask per bbox; patches are cleared
  between routes but the base raster is not).
- **Corridor:** pre-fill `blocked` (`corridor.ts:657`) with the water-grid
  cells whose centres are inside an obstacle (point-in-polygon over the
  obstacle bboxes), so the A* skeleton avoids them (`legAstar` 669 and
  `smoothGridPath` 778 already honour `blocked`).
- **Search:** in `propose()` right after the land test (`propagator.ts:595`),
  an exact segment-against-polygon-edges test (reuse `segmentsTouch` from
  `landmask.ts`) plus point-in-polygon for the endpoint; a few polygons per
  route, so no raster is needed.
- **Everywhere else land is tested:** the final hop and pool checks
  (765-771, 803-809), `rdpSimplify`/`legClear` (`smoother.ts:38, 47`),
  `shortcutSmoother` (136), `revalidateLand` (202-208): pass the obstacles
  along with the land mask. Start/end/via inside an obstacle: the same
  error path as "on land" (`propagator.ts:256-270`, `corridor.ts:700-706`)
  with its own message.

### Web app and panel

- Web app: a **Regions** list (from `/signalk/v2/api/resources/regions`,
  drawn hatched on the map, tick to avoid; "avoid all" as default from the
  setting), and **Max wind** / **Max wave** fields in the Plan tab, in the
  user's units, remembered like the other controls; itinerary cards flag
  legs over a limit.
- Freeboard panel: Max wind / Max wave fields next to Min sail speed, and an
  **Avoid regions** checkbox (all regions the host lists via
  `resources.list({type:'regions'})`; Freeboard shows them on its chart).

### Tests

- Legsim: a candidate over the wind or wave limit is stuck; `simulateLegTime`
  returns Infinity over the limit.
- Propagator: a synthetic forecast with a band of strong wind across the
  direct path: with a limit the route detours, without it goes straight;
  no possible route → the limit's message.
- Obstacles: a polygon on the direct path is avoided by the corridor and
  the search; a start inside it is an error; the smoother never shortcuts
  through it.
- API: request validation of the three fields; unknown region id → 400.

## Status (2026-10-01)

B (max wind, max wave): done and verified on brain. A (stage fronts, live and
final, web app): done. Regions: not started.

## Order

1. Constraints, max wind and max wave first (engine, settings, API, web
   app, panel, tests): the smallest change with the clearest value.
2. Regions (resources read, obstacles through the pipeline, web app list,
   panel checkbox).
3. Stage fronts (engine capture, events, endpoint, web app layer).

Each step is verified on brain with real forecasts before the next.
