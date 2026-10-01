# Plan: bringing Weather Router Plus into Freeboard-SK

Status: proposal, 2026-10-01. Based on a read of Freeboard-SK master at
25bbb2f (3.2.0-beta.5, "feat(routes): step the active route straight from
the vessel (#864)"), its `AGENTS.md` / `CONTRIBUTING.md`, the Plotter
Extensions API (`docs/api/plotter-extensions-api.md`, version 1) and the
reference extension `joelkoz/signalk-auto-route`. File references below are
into the Freeboard-SK tree unless marked.

## The one decision that shapes everything

Freeboard-SK will not take weather routing as a core feature, and we should
not ask. Its maintainers built the **Plotter Extensions API** so that a
server plugin can add "a completely new feature to Freeboard, without
waiting on a Freeboard code change", and their own feature documentation
gives "an automatic route planner that routes around land" as the example
(`features/extension-panels.md`). A reference auto-router already exists
(`signalk-auto-route`: toolbar button, parameter panel, server-side engine,
`routes` capability). Freeboard master implements every version-1
capability (`src/app/modules/plotterext/types.ts:11-28`).

So "a PR to incorporate this project" becomes:

1. **Most of the work is on our side**: make this plugin a plotter
   extension and a chart provider. No Freeboard change, works on every
   Freeboard from the version that shipped the API.
2. **A small number of Freeboard PRs**, one logical change each (their
   rule), for the gaps the host API has that our features hit. Each PR is
   generic (helps every extension), comes with a working consumer (us), and
   is proposed in an issue first, because they change a published API.

Trying to do it the other way round (a big PR that wires our API into
Freeboard's menus and map) would be refused on their stated policy and
would also be wrong: they already have the mechanism.

## What Freeboard gives us today, with no change on either side

- **Point forecasts and the wind layer.** Freeboard calls only two Weather
  API endpoints: `GET /signalk/v2/api/weather/forecasts/point?lat&lon` (the
  Weather Forecast bottom sheet, first 12 entries; menu and map right-click)
  and `GET /weather/observations?lat&lon` (a 5×4 grid of wind barbs over
  the view). No provider choice: the server's default provider answers.
  Fields read: `date`, `outside.temperature`, `outside.dewPointTemperature`,
  `outside.absoluteHumidity` (shown as %, a Freeboard bug), `outside.pressure`
  (shown in Pa), `outside.precipitationVolume`, `wind.speedTrue`,
  `wind.gust`, `wind.directionTrue`
  (`src/app/modules/weather/weather-forecast-modal.ts:330-385`,
  `weather.service.ts:84-98`). **To verify on our side:** that our provider
  answers `/observations` as well as `/forecasts/point`, with those fields.
- **Routes we publish appear in the Routes list** (resource deltas trigger a
  re-list, `resources.service.ts:528-577`) but are **hidden on the map until
  ticked** (`config.selections.routes` defaults to filtered). Our
  `feature.properties` extras survive reads; Freeboard never shows them.

## Phase 0: the plugin as a plotter extension and chart provider (our work)

### 0.1 Routing panel

**Done 2026-10-01** (first slice): manifest registered from `src/index.ts`,
panel at `public/plotterext/`, verified on brain with Freeboard-SK 3.0.1:
button, panel, route from a typed start, draft on the chart, Save through
Freeboard's dialog, route in Resources with per-point ETA/mode/wind.
**Reworked the same day** around Freeboard's own route drawing: the panel
lists the host's visible routes and "Weather-route it" rewrites the chosen
one in place (`route.get` → job with precise waypoints → `route.replace`),
with "Restore drawn route"; the vessel-to-position flow (typed, map
centre or a saved waypoint) creates a new draft. Verified on brain with a
6-point drawn route. Not yet: a background runtime, departure time,
polar performance.

- Register a read-only `plotterExtensions` resource provider with a manifest:
  `requires: ['buttons', 'panels.iframe', 'routes']`,
  `optional: ['map', 'units', 'background.iframe', 'charts', 'charts.time',
  'signalk.stream']`. One toolbar button (`slot: 'mapToolbar'`,
  `togglePanel`), one panel, one background runtime.
- Serve the panel assets from `/plotterext/signalk-weather-router-plus/`
  (`app.use(ASSET_BASE, express.static(...))`), not under `/plugins/…`,
  which is admin-gated for static files. The iframe is same-origin, so it
  calls our `/plugins/signalk-weather-router-plus/api/*` with the user's
  session as the web app does now.
- Panel = a slimmed version of our Plan tab: polar, mode, departure,
  waypoint precision, Find Route, progress, itinerary summary. Reuse
  `rp-plan.js` logic; the map is Freeboard's, so no OpenLayers in the panel.
- Background runtime holds the job (SSE `/api/routes/{id}/events`) so the
  panel can close during a long run (`lifecycle` semantics,
  `plotter-extensions-api.md:208-259`).
- Start and end: A = `navigation.position` via `signalk.subscribe`; B = the
  map centre (`map.getView`), a waypoint picked from `resources.list({type:
  'waypoints'})`, or typed. There is **no map-click or context-menu hook for
  extensions** (`map` offers only `getView`, `center`, `fitBounds`,
  `map.view`): that is PR-1 below. Until then B is entered, not clicked.
- Result → `route.create({points})` as a draft on the chart (amber,
  editable), then `route.save({dialog: true})` or the user's own Save. Per
  point: `name` = leg index/time, `description` = ETA, wind, sail/motor,
  TWA, because `coordinatesMeta` `{name, description}` is all Freeboard
  shows (`active-resource-dialog.ts:258-298`). Our own GeoJSON properties
  are dropped if the user saves through Freeboard's buffer
  (`plotterext.service.ts:1078-1180`), so nothing we need may live only
  there. Never set `properties.temporary` (Freeboard deletes such routes).
- Decide whether the plugin keeps publishing routes to Resources itself when
  the request came from the panel (then `route.show({ref})` instead of
  `route.create`), to avoid two copies.

### 0.2 Overlays as time-varying chart resources

**Colour layers done 2026-10-01**: `src/plugin/pngtiles.ts` (renderer +
cache), `GET /api/tile/<layer>/{z}/{x}/{y}.png`, `charts` resource provider
in `src/index.ts` (eight layers, `time` from/to/step hourly,
`refreshInterval` 10 min, display overrides persisted). **Glyph layers
done the same day**: `src/plugin/raster.ts` (anti-aliased lines, polygons,
rings) and `src/plugin/glyphtiles.ts` (barbs, arrows from the 3 × 3
neighbourhood of point tiles; isobars from `joinPressure`), three more
chart resources. No isobar labels (no font on the server).

Freeboard draws chart layers only as image tiles (or vector tiles /
Mapbox styles, which are never time-varying,
`features/temporal-charts.md`). Our tiles are data painted on the client.
So:

- Render **PNG tiles server-side** for the colour layers first (wind speed,
  wave height, current speed, sea state, precipitation, temperatures, tide
  height): per-pixel colour from the field, land masked. A pure-JS PNG
  encoder (zlib is in Node) keeps "no runtime dependencies". Glyph layers
  (barbs, arrows, isobars) need a line rasteriser; second step.
- Publish one chart resource per layer with
  `type: 'tilelayer'`, `format: 'png'`,
  `url: /plugins/…/api/tile/<layer>/{z}/{x}/{y}.png` (live hour) and
  `time: { url: …?time={time}, current: true, values: [every forecast hour] }`,
  `refreshInterval` (new cycle), `bounds`, `minzoom`/`maxzoom`,
  `defaultOpacity`. Freeboard then lists the layer in its Chart list with
  opacity, order and the **Time palette** (scrub, step, loop, play),
  no code change (`chart-utils.ts:1131-1149`, `chart-time.ts`).
  Keep `type` set: relative URLs get the host prefix only then
  (`resources.service.ts:1032`). Update the `time` block by resource delta
  when a new forecast cycle lands (`resources.service.ts:593-614` applies it
  in place).
- **To verify:** that Signal K allows a second provider for the `charts`
  type next to `resources-provider`/the charts plugin, or whether we must
  write the resources into the existing provider.
- The panel can drive the Time palette (`chart.setTime`) so "show me the
  weather along the route at hour N" works from our side.

### 0.3 What stays weak without Freeboard changes

- No "weather route to here" or "conditions here" on a right-click.
- No legend for the colour layers (Freeboard has no chart legend UI).
- Per-point timing shown only as text in the point description.

## Phase 1: Freeboard PRs, one per logical change

Each proposed first in an issue (the API has an author and a spec; `joelkoz`
wrote the bus and the reference extensions), implemented with a working
consumer on our side, and following `AGENTS.md`: `npm run format`, `npm run
build:all`, `npm run test:ci`, `type(scope): subject` commits kept unsquashed,
a user-facing title, a description that says what changes for the user,
screenshots for anything visible, no edits in `features/`, no version
bumps, every CodeRabbit finding answered, host API changes mirrored in
`dev-tools/fsk-mcp/src/tools.js` and `docs/api/plotter-extensions-api.md`.

### PR-1: map position for extensions (highest value)

Add a `map.contextMenu` capability: extension buttons may declare
`slot: 'mapContextMenu'`; the host renders them in the map right-click menu
(`fb-map.component.html:983-1106`) and, on selection, publishes the button's
`sendMessage` topic with `params` extended by `{ position: [lon, lat] }`
from `onContextMenuAction` (`fb-map.component.ts:698-746`). Optionally also
a `map.contextMenu` event for subscribed contexts. Generic: a POI search,
an anchor tool or an auto-router all want "the point the user meant". For
us: "Weather route to here" and "Conditions here" become one click.

### PR-2a: stop dropping unknown route metadata on save

`saveBuffer` rebuilds the route and keeps only `coordinatesMeta`
name/description and `temporary` (`plotterext.service.ts:1078-1180`); other
`feature.properties` and per-point keys are lost even when updating an
existing resource. Preserve them. This is a data-loss fix, independent of
us, small, likely welcome.

### PR-2b: show per-point time in the route views

Extend `coordinatesMeta` entries with an optional `eta` (ISO 8601) and show
it in the route panel and Points dialog (`route-panel.ts:178-250`,
`active-resource-dialog.ts:258-298`); write it from the plotter extension
`route.*` point model. Any route planner benefits.

### PR-3: chart legend

A `legend` field on the chart resource (`{ unit, stops: [{ value, color }] }`
or an image URL), rendered in the Chart list row or the Time palette. Weather
and radar providers all need it; Freeboard has no legend anywhere today.

### PR-4: Weather Forecast sheet fixes (small, independent, goodwill)

Pressure shown in Pa rather than the user's unit; `absoluteHumidity` shown
as a percentage (should be relative humidity); `toCardinal` sector bounds
(`weather-forecast-modal.ts:396-430`); add waves/swell when the provider
returns them. Each is a one-change PR a maintainer can merge quickly.

Out of scope for Freeboard PRs: provider selection in the Weather API, and
currents in the Weather API (Freeboard calls Open-Meteo from the browser as
a documented stopgap, `weather.service.ts:105-108`); both are Signal K
server/spec conversations.

### PR-5: route styling (added 2026-10-01)

Freeboard draws every route the same way (amber dashed draft, green saved)
and the extension API carries no style. A per-route (and per-leg) style
on the route resource, e.g. `feature.properties.style` and a per-point
`coordinatesMeta[].legStyle` (colour, dash), honoured by the route layer,
would let a weather route show sailing legs green and motoring legs amber
as the web app does, and a tack colour. Generic: any route source.

### PR-6: weather charts in the Weather panel (added 2026-10-01)

Freeboard's Weather panel is fixed (its own wind layer, Open-Meteo
currents, the tidal-currents plugin). Chart resources tagged
`category: "weather"` (or similar) could be listed there with their own
toggle and time control, so the weather layers sit with the other weather
items instead of among nautical charts.

### Signal K server PR: static files served without ETags (added 2026-10-01)

Files installed by npm carry npm's fixed date (26 Oct 1985); the server
sends it as `Last-Modified` with no ETag, so after an update a browser that
already has a webapp file, a plugin configurator's `remoteEntry.js` or an
extension panel is told "not modified" and keeps the old copy. Every plugin
is affected. Fix in signalk-server's static serving: ETags from content (or
size and inode), or `Last-Modified` from the package's install time. This
plugin works around it by re-dating its own files on start.

## Phase 2: later

- Re-route from the active route's point popover (next to REJOIN HERE /
  SKIP, `route-point-popover.component.ts:63-88`), our Live mode.
- Isochrone display as a vector layer: needs a GeoJSON-from-URL chart type
  Freeboard does not have; propose only if PR-1..3 land well.

## Order

1. Phase 0.1 and 0.2 on our side (0.2 colour layers before glyph layers).
2. Open the PR-1 issue with 0.1 running as the consumer; in parallel send
   PR-2a and PR-4 (independent fixes).
3. PR-2b and PR-3 once PR-1's shape is agreed.
