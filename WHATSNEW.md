# What's new

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
