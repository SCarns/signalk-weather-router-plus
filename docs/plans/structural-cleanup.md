# Plan: structural cleanup (units, god functions, duplicated algorithms, duplicated rules)

Status: **decided** 2026-10-01 (all six decisions). Phase 0 built
2026-10-01: `src/engine/golden.test.ts` (5 routes, `test-data/golden/
routes.json`), `src/data/sampling.golden.test.ts` (`samples.json`,
Object.is on every number; harmonic interp not covered, it is private),
`tools/golden_tiles.sh` (copy at brain `~/golden-tiles/`; two runs at an
unused time compared 161/161 identical). Baseline on the Mac: 230 tests,
226 pass, 4 skipped, 0 fail; lint 0 errors (8 pre-existing no-console
warnings); typecheck clean.
Phase 1.1 built 2026-10-01 (`src/geo/units.ts`; golden routes unchanged
by the metre-per-degree change; VPP parity tests evaluate at the
Python's wind speeds, decision F). Phase 1.2 built 2026-10-01
(`src/geo/angles.ts`: norm360, wrapLon, lonOffset, unwrapLonNear,
twaFromHeading, foldTwa; every inline form replaced; golden samples and
routes bit-exact; the four `(Math.atan2(..) * 180) / Math.PI` wind
direction expressions keep their arithmetic inside `norm360` because
`* RAD` rounds differently). Phase 1.3 built 2026-10-01
(`src/geo/mercator.ts`: MERC_MAX_LAT, clampMercLat, mercY, latOfMercY,
latOfTileYFrac, tileYFrac, tileXFrac, tileBBox, tileAt; tiles.ts
re-exports tileAt/tileBBox; the land-mask row latitude in overlays.ts
now uses the same inverse formula as pngtiles.ts, so one coastline pixel
could move by an ulp: the pre/post golden tiles on brain decide).
Remaining `(x * 180) / Math.PI` radian→degree conversions (forecast,
propagator, overlays, prebuild, vpp_physics) stay as written: `* RAD`
rounds differently and would break bit-exactness for no gain.
Phase 1.4 built 2026-10-01: `ResolvedConfig` is SI (`horizonS`,
`refreshIntervalS`, `smocHorizonS/StepS`, `rtofsHorizonS/StepS`,
`tides.horizonS`); `SmocSettings`/`TideSettings` take seconds; the ECMWF
loader/client entry points (`resolveCycle`, `LoadOptions.horizonS`,
`findLatestCycle`, `cycleFullyCached`, `latestExpectedCycle`), memguard
and the RTOFS entry points (`runFullyCached`, `findLatestRun`,
`loadRtofsSteps`) take seconds and convert once at the top; the step
ladders (`availableSteps`, `filesFor`, `alignedSteps`) and the on-disk
decoded index keep hours, which is those formats' own unit. Smoother
tolerance is a ratio end to end. Phase 1.5 built 2026-10-01: the sail
speed slider holds m/s (0–5.2, step 0.1, default 2.6 ≈ 5.05 kt; stored
knot values migrate once to the new key `routeVar:sailThreshMs`); the
power-boat cruise speed is a display-unit input through the same
`_LIMITS` mechanism as the wind/wave limits, kept in SI (old `cruise_kts`
migrates once); `MS_PER_KT`/`M_PER_NM`/`KT_MS`/`MMH_MS`/`_FALLBACK_STOPS`
and the two RGB ramps are gone; the only knot factor on the page is
`KT_MS` in rp-core.js for the barb/arrow class tables; heatmaps and
streamlines take their ramps from `GET /api/legends` only and the loader
waits for it (decision A); the precipitation fade threshold travels in
the legend (`fade_below`), shared with the PNG tiles. Not yet checked on
brain (needs a deploy). Phase 1.6 built 2026-10-01 (notes at the barb
class table and the legend stops; conditions.ts already says so).
**Phase 1 verified on brain 2026-10-01** (deployed into
`~/.signalk/node_modules/signalk-weather-router-plus`, Signal K restarted
by the user, same forecast cycle 2026-10-01T12Z before and after):
golden tiles pre/post at 2026-10-03T00:00Z: 152 of 161 files identical;
the 9 that differ are wind and current PNGs, 1–3 pixels of 65,536 each
with a channel delta ≤ 8 and no alpha change: the exact-knot legend stops
moving a boundary pixel, as predicted. Every JSON tile identical, so the
land-mask row formula change moved nothing. Status reports SMOC 3 h /
72 h, tides 24 h, RTOFS 72 h (the SI config converts correctly). Web
app: units from the Signal K preferences (kn, ft, °F), legends and
`fade_below` loaded, the removed globals are gone, slider in m/s with
its label in kn, cruise speed 8 kn → 4.115552 m/s via the preference's
own formula, `buildRoutePayload` carries SI, the wind heatmap paints
from the legend ramp. No console errors on load.
Phase 2.1 built 2026-10-01: `computeRoute` is 12 lines calling
`search/context.ts` (inputs, goals, budget), `search/skeleton.ts`,
`search/zones.ts` (narrow passages + the skeleton guide),
`search/propose.ts`, `search/stages.ts`, `search/terminal.ts`,
`search/assemble.ts`, `search/enrich.ts`, with `search/types.ts` holding
the types, constants and errors (re-exported from propagator.ts, so no
importer changed). The bodies were sliced from the old method text, not
retyped; the shared locals became a `SearchContext`; the skeleton's
cumulative-distance table and the budget re-size are built once each.
Golden routes identical; 231 tests pass.
Phase 2.2 built 2026-10-01: `plugin/worker.ts` is the entry (state
creation, `refresh`, `handle`, the message chain; 320 lines) and the
functions live in `plugin/worker/{state,forecast,landgrid,currents,
tides,route,query}.ts`, each taking the `WorkerState` explicitly; the 30
module-level variables are its fields. Generated from the old text (not
retyped); typecheck, lint, build and the 231 tests pass; the worker has
no unit tests, so the role behaviour is checked on brain at the Phase 2
deploy. `route()` itself is still 420 lines: phase 3.5 moves its leg
pipeline into the engine.
Phase 2.3 built 2026-10-01: index.ts 1,434 → 829 lines. Extracted:
`plugin/coastline.ts` (Coastline: download with retries, state, manual
download, abort), `plugin/workerpool.ts` (WorkerPool: start, post,
query round trip, cancel flag, shutdown; crashes and restarts reported
through callbacks), `plugin/webfiles.ts` (hashes, re-dating),
`plugin/plotterext.ts` (manifest + registration), `plugin/charts.ts`
(ChartsProvider: chart resources, groups, overrides, and the one
`layerAvailable` the prebuilder now shares; LAYER_NEEDS lives there),
`registerWeatherProvider` in `plugin/weather.ts`. The three identical
"replay to a (re)started worker" blocks are one `sharedDataMessages()`.
Typecheck, lint, build, 231 tests pass.
Phase 2.4 built 2026-10-01 (page, no behaviour change): `displayRoute`
→ `_placeRoutePins`, `_drawRouteLegs`, `_markForecastEnd`,
`_drawSnapConnectors`; `populateItinerary` → `_itineraryWarnings`,
`_legCardHtml`, `_itineraryWarnBlockHtml`, `_bindItineraryClicks`;
`attachToJob` → `_jobOnStatus/Progress/Frontier/Done/Error` sharing a
small `job` context; `_renderConditionsPopup` → `_condVisibleTabs`,
`_condHeaderHtml`, `_condResolveSubTab`, `_condOverlaysHtml`,
`_condBodyHtml`, `_bindConditionsPopup`; `_drawConditionsChart` →
`_chartFrame`, `_chartScales`, `_chartAxes`, `_chartSeries`,
`_chartMarkers` with a shared `g`. The Live-mode IIFE is left as is: it
is already twenty named functions inside one closure, and the module
conversion (decision C, last phase) is the right place to open it; its
private haversine / perpendicular / escape helpers go in phase 3.6.
Syntax-checked.
**Phase 2 verified on brain 2026-10-01** (server restarted 18:32 EDT;
note: a plugin stop/start from the admin UI does NOT reload the code,
the Signal K process must restart). Golden tiles pre/post at
2026-10-03T06:00Z: 161 of 161 identical, every PNG freshly rendered.
Same short route (Rockaway → off Jones Beach, sail_max) on the old and
the new build: identical result (19.0 nmi, 2.5 h, 6 waypoints, 64 log
lines, corridor + decoded-run window + SMOC check all logged). Page: no
console errors, all 24 split functions present; the job stream, route
drawing, itinerary cards, and the conditions popup with all eight tabs
and chart hover work; the route worker released its forecast window
after the route. Every step is a
behaviour-preserving refactor: same routes, same tiles, same API, same
page. Lint hygiene is already clean (0 TODO/HACK markers, 0
eslint-disable, 2 `any`); this plan is about shape.

User request (2026-10-01), in priority order: (3) units and geometry
constants scattered, (1) god functions and files, (2) the same algorithm
written several times, (4) the same rule or table in several places, then
the smaller findings. Units and conversions are to be handled in one
metadata store and the system follows the user's Signal K preferences.
The Freeboard panel (`public/plotterext/panel.html`) is an exception: it
uses the host's unit vocabulary and stays as it is.

Ground rules for every step
- Tests first where a step has no bit-exact guard yet (listed per step).
  `npm test` green before and after; `npm run lint`, `npm run typecheck`.
- Routes: a golden-route test (step 0) must give identical waypoints
  (lon, lat, time, mode) before and after any engine change.
- Runtime checks on brain only (`npm pack` → scp → replace
  `/opt/staging/signalk-weather-router-plus` except node_modules; the user
  restarts Signal K). Nothing is measured on the Mac.
- One phase per deployable chunk; the user runs every git command.
- No new runtime dependencies.

## Phase 0 — a golden baseline (before anything else)

Why: `computeRoute`, `legsim`, the samplers and the corridor are about
to move. The existing tests check properties (land-free, monotone time,
error cases), not exact output. One exact fixture catches drift that
property tests do not.

0.1 `src/engine/golden.test.ts`: two routes on the synthetic land masks
    the engine tests already build (engine.test.ts, multileg.test.ts),
    one motor, one sail with the test polar and a constant wind, plus
    one with `vias`. Store waypoints (lon, lat, time ms, mode, legal
    flags) as a JSON fixture under `test-data/golden/`; assert
    `deepStrictEqual` after rounding to 1e-9 degrees and 1 ms.
0.2 `src/data/sample.golden.test.ts`: sample 200 pseudo-random
    (lon, lat) on a wrapping global grid, a cropped grid and a windowed
    field with `sampleField`, `sampleFieldNearest`, `bilinearCorners`
    (arco), `bilinearFilled` (coastfill) and `interp` (harmonic); store
    the results. Bit-exact (`Object.is` on each Float64).
0.3 Tile baseline: `tools/golden_tiles.sh` on brain. Not one baseline
    but a pre/post pair per deploy, within one forecast cycle: `fetch
    pre-<x>` on the old build, deploy, restart, `fetch post-<x> <same
    time>`, `compare`. It deletes the saved JSON tiles first so each is
    computed afresh; PNGs also sit in a 48 MB in-memory cache that only a
    restart or an unused time empties, so the pre run uses a time nobody
    viewed (default valid_from + 24 h). 7 tiles × (12 JSON + 11 PNG
    layers) = 161 files, JSON compared decompressed.

## Phase 1 — units and geometry in one place (user priority 1)

Principle: SI in memory from ingestion to the wire. Display units come
only from the Signal K user's preferences, read once into one store on
the page. The server never formats for display; the only non-SI numbers
left on the server are domain conventions that are part of a glyph or a
data format, each named once.

1.1 `src/geo/units.ts` (new, tiny, no imports):
    `KTS_TO_MS = 1852 / 3600`, `NM_M = 1852`, `HOUR_S = 3600`,
    `HOUR_MS`, `MINUTE_S`, `MMH_TO_MS = 1 / 3_600_000`,
    `KELVIN_OFFSET`, `HPA_TO_PA`, `DEG`, `RAD`, `M_PER_DEG = R_EARTH_M * DEG`.
    `geodesy.ts` re-exports `KTS_TO_MS`, `DEG`, `RAD` from it so no
    import changes elsewhere; `R_EARTH_M` stays in geodesy.
    Delete the local copies:
    - `KT` in `plugin/legends.ts:24` and `plugin/glyphtiles.ts:51`
      (0.514444 → exact 1852/3600; the legend stop values change in
      the 6th significant digit; the golden tiles tell whether a pixel
      moves — if any does, record it in the CHANGELOG as a correction).
    - `VPP_KTS_TO_MS` (`vessel/vpp_empirical.ts:27`), `CSV_KTS_TO_MS`
      (`:183`), `KT` (`vessel/vpp_physics.ts:331`): these reproduce a
      Python port that used the rounded 0.514444. Replace with the
      exact `KTS_TO_MS` (decision F). Re-run `vpp.test.ts` and
      `vpp_physics.test.ts`; where a golden table fails, regenerate it
      with the exact constant and list the changed values (expected:
      sixth significant digit) in the CHANGELOG.
    - `MMH` in `legends.ts:25` and `pngtiles.ts:43`.
    - `M_PER_DEG` in `engine/corridor.ts:35`, `engine/gridastar.ts:67`,
      `geo/watergrid_build.ts:45`.
    - The literals `111_195` (`propagator.ts:593,614`, `smoother.ts:34`),
      `111000` (`smoother.ts:50`), `111_320` (`plugin/tiles.ts:129-130`,
      `prebuild.ts:331,344`) → `M_PER_DEG`. These are step/padding
      heuristics, not data; the golden route test shows whether any
      changes a route (expected: 111_195 vs 111_194.9 does not).
    - `DEG` redefined in `currents/harmonic.ts:205,230`,
      `DEG2RAD` in `currents/tidal_arguments.ts:46`.
    - `3600_000` / `60_000` / `/ 3600` literals in plugin/* → `HOUR_MS`,
      `MINUTE_MS`, `HOUR_S` (about 25 sites; mechanical).
1.2 `src/geo/angles.ts` (new): `wrapLon(lon)` (moved from geodesy,
    re-exported), `lonOffset(lon, lon0)` → [0, 360),
    `lonOffsetSigned(lon, lon0)` → (-180, 180], `foldTwa(headingDeg,
    windDirDeg)` → [0, 180], `norm360(deg)`.
    Replace: the `(((x % 360) + 360) % 360)` inlines in
    `data/forecast.ts` (16 sites: 145, 194, 218, 346, 374, 424, 430,
    472, 484, 488, 497, 502, 585, 605, 619, 626), `geo/landmask.ts` (5),
    `engine/corridor.ts` (4), `geo/landcache.ts` (2),
    `engine/propagator.ts` (2), `plugin/pngtiles.ts`, `plugin/glyphtiles.ts`;
    the fake-BBox hack `lonOffsetFromWest({ west: f.lon0, east: f.lon0,
    south: 0, north: 0 }, lon)` at `forecast.ts:667,732` → `lonOffset`;
    the TWA fold at `legsim.ts` (2), `conditions.ts` (2),
    `propagator.ts` (1), `vessel/polar.ts` (1) → `foldTwa`.
    Guard: the sampling golden test (0.2) and the route golden (0.1).
1.3 `src/geo/mercator.ts` (new): `MAX_LAT = 85.0511`, `clampLat`,
    `latToMercY(lat)`, `mercYToLat(y)`, `tileAt(lon, lat, z)`,
    `tileBBox(z, x, y)`, `lonLatToPixel(bbox, px, lon, lat)`.
    Replace the inlines in `plugin/overlays.ts:552`,
    `pngtiles.ts:212-213`, `glyphtiles.ts:57-63`, `tiles.ts:91,109-112,
    129-133`, `tilejoin.ts:70-71,211-213` (keep `tilejoin.normLon` as
    the one named longitude normaliser → move to angles.ts).
    Guard: golden tiles (0.3) byte-identical.
1.4 `ResolvedConfig` goes SI. `plugin/config.ts:317-338`: `horizonHours`
    → `horizonS`, `refreshMinutes` → `refreshIntervalS`,
    `smocHorizonHours/StepHours`, `rtofsHorizonHours/StepHours`,
    `tides.horizonHours` → `…S`; `routing.smootherTolerance` stays a
    ratio and `engine/smoother.ts:108,122` takes `tolerance` (ratio),
    deleting the `* 100` at `worker.ts:1271`.
    The data clients keep hours internally because the ECMWF/RTOFS
    step ladders are hours by format (`availableSteps`, `filesFor`);
    they take `horizonS` at their public signature and convert once at
    the top with `HOUR_S`: `data/loader.ts:24,53`, `data/ecmwf.ts:83,
    130,231,294`, `currents/rtofs.ts:156,180,203,266`,
    `currents/smoc.ts:163`, `tides/sealevel.ts:282`,
    `plugin/memguard.ts:44,149`. `decoded.ts` index `request.horizonHours`
    is on disk → keep the field name, write hours from `horizonS /
    HOUR_S` in one place (`loader.ts:244`), compare the same way in
    `worker.ts:697 runFitsConfig`.
    `index.ts:748,1250` use `refreshIntervalS * 1000`.
    `settings.ts:752-760` (legacy migration reads old hour-based
    config) stays: that is a boundary.
    Guard: settings.test.ts, memguard.test.ts, and a brain restart
    showing the same `forecast:` and `currents reloaded` log lines.
1.5 Page: one unit store, no second vocabulary.
    `public/rp-core.js` already holds `UI_UNITS` from the Signal K
    preferences; it becomes the only place a unit is known.
    - The sail-threshold slider (`#sailThresh`, index.html; rp-core:243
      `SLIDER_DISPLAY.sailThresh`; rp-plan:997) holds knots today. It
      becomes SI like the other three sliders: min/max/step in m/s,
      `toSI: v => v`, the request sends the value as is, the label is
      formatted through `UI_UNITS.speed`. Saved settings that hold the
      old knot value are migrated once on load (decision B).
    - `pb.cruise_kts` (rp-plan:1019) comes from the polar boat list;
      the server sends that field in m/s instead (`plugin/polars.ts`),
      so the page stops converting.
    - Delete `M_PER_NM` (rp-core:351, unused), `KT_MS` (rp-layers:679)
      and `MS_PER_KT` (rp-core:352). The one knot constant left on the
      page is the wind-barb and current-arrow class table
      (rp-layers:461,615), because barbs are a glyph drawn in 5-kt
      steps by meteorological convention; name it `BARB_KT_STEP` and
      say so in a comment.
    - rp-plan:420 (`kt * 0.5144444444`): the slider label; goes with
      the slider change.
    - rp-layers:1483 (`speed_ms * 1.94384`) and the RGB stop tables in
      the two `_color` methods (1326-1334, 1484-1493) go: both read
      `_legendStops('wind' | 'waves')` + `_cssToRgb`, which already
      exist.
    - `_FALLBACK_STOPS` (rp-layers:683-692) is deleted (decision A).
      `_legendStops(key)` returns null until `GET /api/legends` has
      answered and the heatmap painter draws nothing for that layer
      until then; `loadLegends()` (rp-plan:368) is awaited before the
      first layer paint.
    - Five `UI_UNITS` entry points (`_fmt`, `unitDesc`, `_legendUnit`,
      `_tideUnit`, `_unitOf`): keep `_fmt` and `unitDesc`; make
      `_legendUnit`/`_tideUnit` call `unitDesc`; delete `_unitOf`
      (rp-plan:1470, a pure alias).
    - `maxWind`/`maxSwh` inputs via `_limitSI` already hold display
      units and convert to SI once; the slider change above makes every
      input follow the same model.
    Guard: load the page on brain with the user's preferences set to
    knots/nm and again to m/s/km; every readout shows the preference
    unit or "—"; no number differs from before except where a
    `_FALLBACK_STOPS` colour was ever shown.
1.6 Server-side leftovers, each named once in `units.ts` and documented
    as a domain convention: wind-barb pennant steps in knots
    (`glyphtiles.ts:93,141`), colour-ramp stops authored in knots and
    mm/h (`legends.ts`), `conditions.ts` heat index (RH in %) and wind
    chill (km/h) regression inputs. These stay; they are not display
    conversions.

Phase 1 deliverable: `grep -rnE '0\.5144|1\.94384|111_?[0-9]{3}|85\.0511|Math\.PI */ *180' src public/rp-*.js` returns only `src/geo/units.ts`, `src/geo/mercator.ts` and the one page constant.

## Phase 2 — god functions and files (user priority 2)

2.1 `OceanPropagator.computeRoute` (`engine/propagator.ts:348-1387`,
    ~1,040 lines, 15 closures over ~30 locals) → a `RouteSearch` class
    in `engine/search/` whose fields are today's captured locals, and
    whose methods are today's sections, in the order the comments
    already mark:
    - `search/skeleton.ts`: lines 453-540 (coarse A* skeleton, or the
      corridor's) → `buildSkeleton(args, land): Skeleton` returning
      `{ points, cum, stepLimits }`. Build `skeletonCum` once (today
      twice: 468-472, 518-521).
    - `search/budget.ts`: lines 429-452 and the three resize blocks
      (449-451, 476-479, 530-533) → one `sizeBudget(distM, stages)`.
    - `search/zones.ts`: 542-680 (`stepFor`, `targetForParent`,
      `zoneKey`, `nearestSkeleton`, narrow-bin zones).
    - `search/propose.ts`: 681-804 (`propose`).
    - `search/stages.ts`: 805-1091 (stage loop, fallback ladder,
      pruning, stall detection, `resetTry`/`tryNote`/`forecastNote`).
    - `search/terminal.ts`: 1092-1244 (`score`, `hopEndFor`, `planFor`,
      beat planning, final straight leg).
    - `search/assemble.ts`: 1245-1387 (back-trace, waypoints, totals,
      validation, limit warnings). Totals via `smoother.recomputeTotals`
      instead of the inline copy (1261-1334) — fold `recomputeTotals`
      into `engine/route.ts` so both call one function.
    `computeRoute` becomes ~40 lines calling these in order.
    `Route.validated` set once (today `false` at 1344 then
    unconditionally `true` at 1372).
    Guard: golden routes (0.1) identical; all engine tests; brain route
    timing within noise (log line `job …: N waypoints, … ms`).
2.2 `plugin/worker.ts` (1,820 lines, three roles): split by role.
    - `plugin/worker/main.ts`: `handle()` dispatch, `send`/`log`,
      lifecycle (`init`, `config`, `shutdown`), ~150 lines.
    - `plugin/worker/forecast.ts`: 692-929 (runs on disk, refresh,
      decode, windows, prune) + the forecast part of `dataStatus`.
    - `plugin/worker/currents.ts`: 263-330, 568-690 (SMOC, RTOFS,
      harmonic, stack) — `refreshSmoc` and `refreshTides` share one
      `refreshArcoSource(spec)` (today 329-405 vs 424-488 are the same
      probe → provisional → resident → prune skeleton).
    - `plugin/worker/tides.ts`: 407-567.
    - `plugin/worker/route.ts`: 934-1388 — see 3.5, the pipeline moves
      to the engine, so this file shrinks to request validation, area
      loading and progress plumbing (~150 lines).
    - `plugin/worker/query.ts`: 1389-1581.
    Module-level `let`s (123-169) become fields of one `WorkerState`
    object passed to each module; the role check happens once in
    `main.ts` by constructing only the modules that role needs
    (`data`: forecast+currents+tides+query; `tiles`: forecast+tides+
    query; `route`: forecast+currents+route).
    Guard: worker.ts has no direct tests; the API tests
    (tiles.test, overlays.test, pngtiles.test) and a brain session
    exercising route, overlays, conditions, tides, settings reload.
2.3 `src/index.ts` (1,434 lines, one closure, ~40 `let`s): extract
    - `plugin/coastline.ts`: 190-291 (download state machine, retry).
    - `plugin/webfiles.ts`: 833-914 (`filesHash`, `panelFilesHash`,
      `versionIndexHtml`, `refreshPublicFileDates`) — see 4.3, which
      deletes half of it.
    - `plugin/plotterext.ts`: 915-992 (manifest, registration).
    - `plugin/charts.ts`: 993-1180 (chart resources provider).
    - `plugin/weather.ts` already exists; `registerWeather` (676-714)
      moves in.
    - `plugin/workers.ts`: 308-396, 478-675 (post/query/onWorkerMessage/
      startWorker) with the three identical "replay after ready"
      blocks (484-486, 666-668, 794-797) as one `replayPending()`.
    `index.ts` keeps `start`/`stop`/`applySettings`/`registerWithRouter`
    and the deps object (~350 lines).
    Guard: brain start/stop/settings-change cycle; `curl` of every
    `/api/*` route listed in README; the plotter panel loads.
2.4 Page functions: `displayRoute` (rp-core:551-747), `populateItinerary`
    (rp-plan:788-960), `_drawConditionsChart` (1583-1772),
    `_renderConditionsPopup` (1855-1970), `attachToJob` (1100-1239), the
    Live IIFE (2027-2535). Each splits along its existing comment
    headings into 3-6 named functions in the same file; no behaviour
    change, no module system change yet (that is "smaller things",
    and it is a bigger decision — DECISION C).
    Guard: the brain page walk-through from 1.5.

## Phase 3 — the same algorithm written several times (user priority 3)

3.1 One heap, one ring search, one line-of-sight.
    `engine/heap.ts`: the typed-array `Heap` from `gridastar.ts:75-118`
    (already generic). Delete `astar.ts MinHeap` (200-257) and the
    inline heap in `corridor.ts fineTrace` (924-958).
    `geo/grid.ts` gains `nearestPassable(isPassable, x, y, maxR)`;
    replace `propagator.ts snapToPassable` (162-185),
    `corridor.ts endpointNodes` (131-151), `fix` (206-241),
    `fineTrace cellOf` (898-915).
    `engine/los.ts`: `gridastar.ts gridLineOfSight/smoothGridPath`
    (306-369) — `corridor.ts los` (1007-1033) calls it.
    Guard: golden routes; corridor.test.ts; `gridastar` has its own
    tests via corridor.
3.2 One bilinear sampler. `data/sampling.ts`:
    `cornersFor(grid, lon, lat): { c, c1, r, r1, tx, ty }` with the
    window remap applied by the caller (`winRow`/`winCol`). Rewrite
    `forecast.ts sampleField/sampleWrapped/sampleWindow/
    sampleFieldNearest` (342-510), `arco.ts bilinearCorners` (943),
    `coastfill.ts bilinearFilled/bilinearFilledScalar/
    sampleFieldPairFilled` (108, 156, 221), `harmonic.ts interp/pointAt`
    (249, 296) on top of it. The order of floating-point operations
    must stay the same to keep bit-exactness: write `cornersFor` by
    copying `sampleWrapped`'s arithmetic verbatim and prove the others
    equal with the golden sampler test (0.2) before deleting them.
3.3 One HTTP client. `data/http.ts`: `fetchWithRetry(url, init,
    { timeoutMs, retries, fetchImpl, sleepImpl, log, tag, mirrors? })`
    taken from `ecmwf.ts:182-222` (the most complete: mirrors and
    Retry-After). `zarr.ts httpGet` (205-240) and `rtofs.ts request`
    (119-146) become 5-line wrappers; RTOFS gains Retry-After as a
    side effect (behaviour change, benign; note in CHANGELOG).
    `zarr.ts:18` stops importing from `ecmwf.ts`. Move
    `parseRetryAfterMs` to http.ts.
    Guard: data.test.ts, smoc.test.ts, sealevel.test.ts (they inject
    `fetchImpl`); add one http.test.ts for backoff/Retry-After/mirror.
3.4 One step-physics loop. `legsim.ts simulateLegTime` (63-126) becomes
    `scoreCandidatesFromParent` with n = 1 and the per-step time taken
    from the candidate's own elapsed time (today the scalar sim advances
    `tMs` by its own `stepS`; the batch sim samples at `parentTime + k ×
    meanDtPerStep`). DECISION D: these are different time models and
    the golden route test will show which routes move. If the user
    wants identical routes, instead extract only the shared inner step
    (`stepPhysics(ws, wd, cu, cv, bearing, …) → { stepS, sailUsed,
    inNoGo, limited }`) and keep both outer loops; the two
    inconsistencies (scalar sim ignores `noGo`/`limited`; it skips the
    polar on NaN wind where the batch sim zeroes it) are then fixed in
    one place.
3.5 One route pipeline. `engine/pipeline.ts`: `runLegPipeline(ctx,
    plan, legStart, legDeparture): Route` holding today's
    `worker.ts:1142-1309` (corridor → fallback bbox → land → areas →
    propagate → ViasNotCrossed retry → RDP → smoother → enrich →
    revalidate → horizon warning). `ctx` carries `waterGrid`,
    `landFor`, `loadAreas`, `wind`, `current`, `vessel`, `polar`,
    config values, `progress`, `shouldCancel`, `onFrontier`.
    `plugin/worker/route.ts` and `cli.ts:136-209` both call it; the CLI
    gains the vias retry, RDP, smoother and revalidate it lacks today
    (behaviour change for the CLI only; intended).
    Guard: golden routes via the worker path (add one plugin-level
    test that runs `runLegPipeline` with `waterGrid = null`); the CLI
    on the Mac is fine for a smoke run (no runtime measurements).
3.6 Page duplicates.
    - One `escapeHtml` in rp-core.js; delete rp-core:1048,
      rp-plan:2456, rp-settings:26 (rp-settings is an IIFE: it takes
      the global). panel.html keeps its own (exception).
    - `waveStreamlines`/`windStreamlines` (rp-layers:1197-1348,
      1354-1507) → one `Streamlines(sampleFn, colorFn, opts)`.
    - The eight 6-line heatmap-layer blocks (1004-1094) → a table +
      loop; the three 11-call `loadX()` fan-outs (rp-layers:655-668,
      1576-1590; rp-plan:1361-1375) → one `refreshAllLayers()`.
    - Signal K formula parser: `remoteEntry.js:28-90` is loaded by the
      host without rp-core, so it cannot import; make rp-core load the
      same file (`public/skunits.js`) via a `<script>` tag and have
      remoteEntry keep its copy only if the Module Federation
      container cannot load a sibling script — check on brain first.
    - Time formatting: one `fmtWhen(ms, { date: bool })` replaces
      `_whenText`, `_fmtWhen`, `formatTime` (hard-coded `'en-US'` →
      the browser locale) and the inline `toLocaleString`s.

## Phase 4 — the same rule or table in several places (user priority 4)

4.1 One request schema. `plugin/request_schema.ts`: a table
    `{ field: { type, min, max, enum, description } }` for the route
    request. `openapi.ts:56-130` renders it; `api.ts
    validateRequestShape` (694-732) walks it; `worker.ts validateRequest`
    (934-949) keeps only what the API cannot know (finite lat/lon
    ranges) or is deleted if the table covers it. Settings defaults in
    `SETTINGS_SPEC` reference the same min/max entries for the fields
    they share (stages, maxWind, maxSwh, simplify, smootherTolerance).
    Guard: settings.test.ts; an openapi snapshot test (serialise
    `openApiDocument()` once, compare) so the rendered document does
    not change except in description text.
4.2 One layer table. `plugin/layers.ts`: `LAYER_PARAMS` (worker:1400-
    1410) is the source; `index.ts LAYER_NEEDS` (759-768) is deleted
    (`barbs` → `wind`'s entry); `chartLayerAvailable` (index:994-1002)
    deleted in favour of `layerAvailable` (807-814); the field-layer
    list typed in `overlays.ts:29`, `tiles.ts:28` and the string array
    in `api.ts:314` derive from this table's keys.
4.3 One cache buster. Keep the serve-time rewrite in `api.ts
    servePublic` (143-174): it is stateless and also covers proxies.
    Delete `versionIndexHtml` and the `?v=` part of
    `refreshPublicFileDates` (index:871-914); keep the mtime re-dating
    (it serves the other files' Last-Modified). `publicVersion()`'s
    hash is per-request `readdir`+`stat` of the top-level public dir;
    compute it once at start and on `SIGHUP`-less servers that is fine
    because the files only change on install. The plotter panel's
    `?v=` (index:946) uses the same function.
    Guard: brain: after deploy, index.html on disk no longer changes;
    the served page carries `?v=`; hard reload gets new scripts.
4.4 One colour-ramp source: already `plugin/legends.ts` → `/api/legends`;
    the page copies go in 1.5. Nothing else to do here beyond
    DECISION A.
4.5 `api.ts`: the "jobs or 503" + "job not found 404" block repeated
    nine times (527-689) → `withJob(req, res, (job) => …)`.

## Phase 5 — smaller things

5.1 Dead code: `astar.ts:395 bearingDeg`, `gridastar.ts gridPathLengthM`,
    `shapefile.ts containing/readRecords` (316, 382), `landcache.ts
    Entry.key`, `landmask.ts:258-307` bare block, `loader.ts:136-137`
    and `ecmwf.ts:238-241` identical `steps`/`waveSteps`,
    `landmask.ts:543,610` unused `stepM` params, `protocol.ts
    'currents'.rtofs` (always null), `TileStore.setCap`, `JobManager
    'finish'`, `AstarResult.cellsVisited`, `LegSimResult.sampleCount`,
    `Corridor.cells`, `defaultSpecsFor`, `class EmpiricalVPP`,
    `RouteWarning 'leg_too_shallow'`, page `switchModalTab`, `ROUTER`
    alias, `_unitOf`, `M_PER_NM`. Each deletion compiles or it stays.
5.2 Errors: one `EngineError` base with `code: 'cancelled' | 'vias_not_
    crossed' | 'corridor' | 'exhausted' | …` and `fatal`; cancellation
    is `RouteCancelled` everywhere (drop the message-string match at
    `corridor.ts:312`). Progress callback shape `(stage, total, msg)`
    everywhere (corridor and multileg today take `(msg)`).
    `api.ts` status mapping: `fail()` decides from the error class, not
    from `/not started/.test(message)` (205) or the caller's guess.
5.3 Decide the coarse-A* fallback (`propagator.ts:481-540`, all of
    `astar.ts`, `buildCoarseGrid`, `computeShoreCost`): DECISION E.
5.4 Tests by subject: move the legends/settings tests out of
    `sealevel.test.ts:591`, the isobars test out of
    `currents.test.ts:118`, `nearestExactWater`/`waterAround` out of
    `snaps.test.ts:65-93`; replace message-regex asserts
    (`beat.test:133`, `limits.test:106-116,174-175`,
    `corridor.test:400`) with error-class/field asserts after 5.2.
5.5 Page under lint: add a `public/**/*.js` block to
    `eslint.config.mjs` with browser globals and `no-undef: off` (the
    shared scope defeats it), `no-unused-vars: warn`; fix what it
    finds. DECISION C covers whether to go further (ES modules).
5.6 Comments that still say "the routing server" / "the parent" /
    "Pydantic" (`overlays.ts:45,359-362`, `legends.ts:2-5`,
    `polars.ts:91,163,215,259`) → say what the code does; the
    misplaced doc blocks (`protocol.ts:145`, `index.ts:823-831`,
    `geodesy.ts:86-94`) move to their functions.
5.7 Wire-format code out of `engine/`: `route.ts routeToSignalKRoute/
    snapProperties` → `plugin/skroute.ts`; `conditions.ts`, `isobars.ts`
    → `plugin/` (only plugin and cli use them).

## Decisions needed from the user before building

A. DECIDED (user, 2026-10-01): delete `_FALLBACK_STOPS`; heatmaps draw
   only after `GET /api/legends` has answered.
B. DECIDED (user, 2026-10-01): nothing on the page stores knots; the
   sail-threshold slider holds m/s like the other sliders and only its
   label is formatted through the Signal K preference.
C. DECIDED (user, 2026-10-01): convert the
   four page scripts to ES modules as the LAST phase of this plan
   (after the dedupe in phases 2-3 leaves fewer symbols to export, and
   with the phase-5 lint in place to catch missed references).
   OpenLayers stays a vendored classic script.
D. DECIDED (user, 2026-10-01): extract the shared inner
   step first (routes identical, the two inconsistencies fixed), then
   unify the two loops as the final step of phase 3, inspect the route
   differences on brain, and regenerate the golden fixture.
E. DECIDED (user, 2026-10-01): keep the coarse-A* fallback; add a
   counter of fallback runs to the data status so brain logs show how
   often it happens.
F. DECIDED (user, 2026-10-01): the exact SI constant `1852/3600`
   everywhere, including the VPP port; regenerate any golden table that
   differs and record the changed values.

## Order and size

Phase 0 (half a day), Phase 1 (1-2 days; 1.4 and 1.5 are the only parts
with runtime visibility), Phase 2 (2-3 days; 2.1 and 2.2 are the
riskiest and each gets its own brain deploy), Phase 3 (2-3 days),
Phase 4 (1 day), Phase 5 (1 day). Each numbered step is one commit the
user makes; each phase ends with a brain deploy and the golden
comparisons. Estimates are mine and not measured.
