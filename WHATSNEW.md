# What's new

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
  air and sea temperature, pressure, tide height, conditions dots and
  seamarks. Colour layers stop exactly at the coastline.
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
