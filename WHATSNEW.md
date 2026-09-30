# What's new

## Next release (unreleased)

### Waypoints work

- **Routes with waypoints no longer fail.** Each waypoint now ends one
  leg of the route and starts the next; every leg is planned on its own
  and the boat's arrival time carries over, so the weather moves on with
  you. The route that failed with three waypoints off Baja California
  now plans in every mode.
- **Choose how exactly to hit each waypoint** (Setup → Waypoint
  behaviour): **Precise** (the default) takes the route exactly through
  each waypoint; **Approximate** lets a leg finish as soon as the route
  enters the circle around the waypoint (radius 50–2000 m, default
  200 m) and carries on from there. The destination is always exact.
- Routes without waypoints are exactly as before.

### Much less memory, instant restarts

- **The forecast no longer sits in memory.** Each new ECMWF forecast is
  decoded once and kept on disk (about 1.1 GB for 72 hours with the
  extra fields); the map, the conditions popup, the Weather API and
  routes read just the part they need. Measured on a Raspberry Pi 5:
  534 MiB instead of 1644 MiB after start-up, and at most 891 MiB
  instead of 3060 MiB while a new forecast comes in.
- **Restarts have the forecast ready in 1.3 s** when the current
  forecast is already decoded on disk (64.6 s before, on the same Pi).
- The Status panel shows the forecast's size on disk and how much of it
  is in memory right now.

### Routes through straits, anywhere

- **Routes find their way round.** The router now plans with a map of
  the world's navigable water, so a route whose way lies well outside
  the straight line, like Lisbon to Palma through the Strait of
  Gibraltar, Aegean to the Black Sea through the Dardanelles and the
  Bosphorus, or the Tyrrhenian to the Ionian through the Strait of
  Messina, just works. No waypoints needed.
- **Straits are handled for you.** Where a route passes a narrow strait,
  the router slows its steps down, keeps several options open through
  it, and adds an automatic pass-through point there. You see it in the
  progress messages ("auto via at Strait of Gibraltar, width 14.2 km");
  it is not added to your route's waypoints.
- **Canals are off by default.** A new Routing setting, **Allow canals**,
  lets routes use known ship canals (Corinth, Cape Cod, Chesapeake and
  Delaware, Kiel, Suez, Panama) where your coastline data shows them as
  water. The standard GSHHG coastline does not include them, so routes
  go the natural way round.
- **Other coastline data.** If you configure a different coastline file
  (another GSHHG resolution, Antarctica added, OSM land polygons), the
  plugin rebuilds its water map from it once in the background (about a
  minute on a desktop computer, longer on a Raspberry Pi) and uses the
  built-in one meanwhile.

## 0.1.0-beta.1 (28 September 2026)

The first beta of Weather Router Plus: weather routing that runs entirely
inside your Signal K server, with no outside routing service.

### Route anywhere

- **Global forecast.** ECMWF's 0.25° forecast for the whole world is kept
  in memory, so the map layers, the conditions popup and routing work
  wherever you are. No region to set up.
- **Currents everywhere.** Copernicus Marine's worldwide current forecast,
  including tidal currents, is the main current source. NOAA RTOFS stays
  as a backup, and tidal-harmonic files you install take priority where
  they cover.
- **Tides everywhere.** Tide height, total water level and storm surge
  for any point on the coast, with high and low water times.

### Plan on the map

- Click the map for the menu: set start, set destination, add a waypoint,
  or open conditions. **Add waypoint here** extends the course: the
  clicked point becomes the destination and the old destination becomes
  the last waypoint, so waypoints stay in the order you place them.
  Holding on the map does the same without the menu.
- Drag the start, the destination or any waypoint to move it.
- Legs are coloured by tack (green starboard, red port, black motoring),
  with heading and wind arrows at each waypoint and a card per leg in the
  Itinerary tab.

### See the conditions

- **Layers** named for what they show: wind speed, wind barbs, wave
  height, current speed, current direction, sea state, precipitation,
  air and sea temperature, pressure, tide height and seamarks. Colour layers stop exactly at the coastline.
- **Tide height** colour stretches to the tide in view, so it is readable
  even near slack water. Narrow water the global model cannot resolve is
  hatched and labelled "no model data" instead of looking like zero.
- **Conditions popup** (shift-click, or "Conditions here" in the menu):
  72-hour charts of wind, waves, sea state, pressure, temperature and
  precipitation, and a combined **Tide & current** chart with the tide on
  the left axis and current speed and direction on the right, so slack
  water lines up with high and low tide.

### Your boat

- Pick a polar from the library for each route and see its diagram.
- **Create polar from boat specs** builds a polar from length, beam,
  displacement, sail area and rig, using the same model as the
  routePlanning server.
- All settings (vessel, routing, forecast, currents, tides, publishing)
  are in the webapp's **Settings** tab, shared by everyone on the boat,
  shown in your chosen units.

### Safe on small devices

- **Memory guard.** Before loading a forecast, the plugin checks it fits
  and leaves the "Memory kept free" amount (default 1 GB) for Signal K
  and the rest of the system. If not, it says how much is needed and what
  to change, such as a shorter horizon or turning off the extra fields.

### Good to know

- Tide heights are relative to **mean sea level, not chart datum**. Do not
  use them for under-keel clearance.
- The current and tide models are about 9 km: fine along coastlines, but
  not inside small harbours and narrow channels.
- Routes through a passage far outside the straight line between start
  and end, such as Lisbon to Palma via Gibraltar, need a waypoint in the
  passage for now.
- Current and tide data: *Generated using E.U. Copernicus Marine Service
  Information; https://doi.org/10.48670/moi-00016*.

See [CHANGELOG.md](CHANGELOG.md) for the full list of changes.
