# What's new

## 0.1.0-beta.7

- **Finer wind where you have it.** Install the signalk-grib-downloader
  plugin and its regional runs (AROME, ARPEGE, ICON-EU) are layered over
  ECMWF: routes use the regional wind wherever it covers the point and
  the time, blended in at its edges and handed back to ECMWF near the end
  of its forecast. Waves stay ECMWF. The route summary says how much of
  the route each model answered; a checkbox turns it off.
- **Freeboard shows your weather routes properly.** Tick a saved weather
  route in Freeboard's Routes list and the plugin's panel opens on its
  legs, with no re-routing. The leg cards are redesigned (when, mode and
  tack; distance, time, SOG and COG in large type; wind, current fair or
  foul, waves), a tap on one centres the chart on that waypoint, and the
  leg the boat is on is outlined and kept in view. Routes computed in the
  web app now carry each point's leg into the saved route, so Freeboard's
  points sheet shows it too.
- **LIVE and SIMULATE follow the boat.** The itinerary card of the next
  point shows live figures, each point passed keeps its closest-approach
  figures, and the map stays on the boat. SIMULATE has Start, Stop and
  Rewind, and draws the track sailed.
- **"In irons" means in irons.** Points of sail come from the route's
  polar: in irons only tighter than the polar's no-go angle, close hauled
  up to its best upwind angle. A leg the router sailed at 34° no longer
  reads "in irons".
- **Routes that go where the wind is.** In open water the search can now
  leave the direct line: Tonga → Auckland went from 207.4 h to 185.7 h,
  faster now than the route you had to force through a waypoint far to
  the west (192.7 h). Routes across the 180° meridian draw and fit the
  short way.
- **Less to set up, more remembered.** The page opens on the boat's
  Signal K position instead of asking the browser for its location; the
  vessel name comes from Signal K; your start, destination, waypoints and
  departure survive a reload; opening a saved route offers to recompute
  it with the current forecast.
- **A clearer header.** One line each for wind, waves, currents and
  tides, naming the model behind it, listing only what applies where you
  are looking, in local time.
- **Your units everywhere.** Settings, progress messages, warnings and
  errors are written in your Signal K unit preferences, angles, times and
  data sizes included.
- **Fixes.** After a restart the plugin keeps serving the forecast it has
  while a newer one downloads (overlays used to go blank for minutes);
  opening a saved route no longer brings the previous route's waypoints
  along; the web app no longer stops loading in Power mode; a regional
  decode no longer stalls the map and the Weather API.

## 0.1.0-beta.6

- **Freeboard's wind barbs from this plugin.** The Weather API now
  answers observations: the conditions right now at any point, from the
  ECMWF forecast, with the surface current where the current data covers
  the point. Freeboard-SK's Wind overlay asks for exactly that, so make
  this plugin the server's default weather provider and its barbs come
  from the same forecast as your routes. Freeboard's currents overlay
  still reads Open-Meteo; a Freeboard change for that is on our list.
- **Approximate waypoints show their circle.** In Approximate mode a
  dashed orange circle of the chosen radius is drawn around every
  waypoint, following the pin as you drag it and the slider as you move
  it, and the route is seen to touch the circle and carry on. Before,
  after a run the pins jumped onto the route, so the route looked as if
  it passed through the waypoint exactly and no circle was visible.
- **Decision lines.** The router's search is drawn only when you ask:
  the switch sits beside Find Route (and in Layers → Base), off by
  default, remembered. The search is still recorded with every route, so
  the switch shows it after the fact too.
- **Routes to windward finish.** The final beat to a waypoint tries
  wider tack angles when the wind shifts along the way, where it used to
  fail; a Gibraltar → Canaries route that stopped 37 km short now
  completes. When no final leg can be sailed at all, the message says
  why, for each leg tried, with the wind and current at the nearest
  point.
- **Fixes from the test box.** Empty tiles left by a power cut no longer
  blank a layer (the map rebuilds them); the web app no longer runs old
  scripts after an update; chart groups in Freeboard are complete from
  the first start; the world-zoom tiles were missing their eastern half;
  the water-grid rebuild had stopped working in the previous beta.
- **Under the hood.** A structural cleanup with no change to the routes
  it produces, checked by golden tests: one definition each for units,
  angles and the map projection, SI settings end to end, the search in
  readable sections, the web app as modules. Two things it did change for
  the better: every candidate now reads the forecast and the currents at
  its own clock, so arrival times with a changing forecast or tide are
  more honest, and the `wrp-route` command runs the full pipeline the
  plugin does.

## 0.1.0-beta.5

- **Weather routing inside Freeboard-SK.** With Freeboard-SK 3.0 or
  later: draw a route on the chart as usual (start, waypoints,
  destination), tap the grid icon at the top right, then **Weather
  route** → **Weather-route it**, and the drawn route becomes the weather
  route, still editable, saved with Freeboard's own Save. Or route from
  your boat to a position or a saved waypoint. Each point shows its ETA,
  sailing or motoring, and the wind.
- **The weather layers in Freeboard-SK too.** Wind, waves, currents, sea
  state, rain, temperatures and tide height appear in Freeboard's Chart
  list, with Freeboard's own time control to play them through the
  forecast.
- **Wind and wave limits.** Set a maximum wind speed or wave height in
  the Plan tab (or in Settings as a default) and the router keeps every
  leg under it, or tells you there is no such route, and why: how many
  of its options were over the limit, and whether it had run past the
  end of the forecast.
- **You can see where the forecast ends.** A route that goes on past the
  last forecast step now shows it: an amber badge with the end time, the
  legs after it drawn dashed with a "forecast ends" marker, a chip on
  those itinerary cards, and a note in the saved route. Those legs run on
  conditions held at the last step. The **Forecast horizon** setting
  (Settings tab, Forecast group) reaches up to 15 days.
- **Simpler vessel settings.** Draught, air draft, length, beam,
  under-keel and overhead margins, maximum wave height and tack penalty
  are gone from the Settings tab and the Plan tab: the router never used
  them (it has no depth or bridge data). What is left is what it does
  use: name, speed under power and polar performance. A working tack
  penalty is on the to-do list; the wave-height limit is now a routing
  setting (above).
- **First setup fixed.** On a fresh install the configuration panel's
  Save button was greyed out until you changed something; it now reads
  "Save and enable the plugin" and works straight away. If you updated
  from an earlier beta, hard-refresh the Admin UI once to get the new
  panel.

## 0.1.0-beta.3 and beta.4

- First start shows "starting: downloading the coastline (…)" instead of
  "plugin not started", and a route requested before the first forecast
  waits for it instead of downloading its own copy.
- Fixed a first-forecast download failure (`ENOENT … rename …grib2.tmp`)
  when two threads fetched the same field at once.
- README corrections.

## 0.1.0-beta.2

- **Polars included.** About 700 boat polars (the OpenCPN
  weather_routing_pi library) now come with the plugin, with a Catalina
  36 as the default, so routes sail straight after installing. Pick your
  boat in the web app's polar list, or create one from your boat's specs.
  Polars you create are kept safe across plugin updates.

## 0.1.0-beta.1: first public beta

Weather routing that runs entirely inside your Signal K server, with no
outside routing service. This is a beta: please report problems on
GitHub.

### Route anywhere

- **Worldwide weather, currents and tides.** ECMWF's global forecast
  (up to 15 days ahead), Copernicus Marine's worldwide currents
  (including tidal currents) and tide heights, with NOAA RTOFS as a
  backup. Tidal-harmonic files you install take priority where they
  cover.
- **Routes find their way through straits.** Lisbon to Palma through
  Gibraltar, the Aegean to the Black Sea through the Dardanelles and the
  Bosphorus: no waypoints needed. The router slows down and keeps several
  options open in narrow passages.
- **Waypoints** end one leg and start the next, and the weather moves on
  with you. Choose **Precise** (exactly through each waypoint) or
  **Approximate** (anywhere inside a circle you set).
- **Clean routes:** needless zig-zags are straightened out when the
  straight line is clear of land and no more than 5% slower. Your own
  waypoints are always kept.
- **Live mode** re-plans from your boat's position as you go.

### Your boat

- Pick a polar from your library for each route and see its diagram.
- **Create a polar from boat specs** (length, beam, displacement, sail
  area, rig). Checked against 441 ORC certificates: typically within
  about 3% of ORC's own predictions.
- **Polar performance:** tell the router how much of the polar your boat
  really makes (for example 85% for a loaded cruiser).

### See the conditions

- Map layers for wind, waves, currents, sea state, rain, air and sea
  temperature, pressure and tide height. They load quickly: the map is
  saved on the server and built ahead of time around your boat and
  wherever you look.
- **Conditions popup** (shift-click anywhere): 72-hour charts of wind,
  waves, sea state, tide and current, pressure, temperature and rain.
- Everything is shown in **your Signal K unit preferences**.

### Easy to set up

- Install, enable, done: on first start the plugin downloads the world
  coastline it needs by itself (149 MB, once).
- Its settings page in the Signal K Admin UI has a **Download coastline**
  button, and shows distances and times in your units.
- Vessel, routing and forecast settings are in the web app's
  **Settings** tab, shared by everyone on board.
- Routes are saved to Signal K, so your chartplotter apps can show them,
  and the forecast is offered to other apps through the Signal K Weather
  API.

### Good to know

- Tide heights are relative to **mean sea level, not chart datum**. Do
  not use them for under-keel clearance.
- The current and tide models are about 9 km: fine along coasts, not
  inside small harbours and narrow channels.
- Open water only: the router avoids land but knows nothing about depths,
  channels or bridges.
- Disk: the forecast uses 1–4 GB (depending on how far ahead), and the
  saved map up to 20 GB (adjustable).
- Current and tide data: *Generated using E.U. Copernicus Marine Service
  Information; https://doi.org/10.48670/moi-00016*. Weather: ECMWF open
  data (CC BY 4.0).

See [CHANGELOG.md](CHANGELOG.md) for the full list.
