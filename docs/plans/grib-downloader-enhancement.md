# Plan: regional wind from signalk-grib-downloader, layered over ECMWF

Status: proposal, 2026-10-02. Enhance, never replace: ECMWF stays the
global base for wind, pressure and waves; Copernicus/RTOFS stay the
currents and sea level. The downloader's models add finer wind where and
when they cover a point, and nothing else.

## What the downloader gives (read from its source, v as of 2026-10-02)

| Model | Grid | Domain | Horizon (cap) | Cadence | Source |
|---|---|---|---|---|---|
| AROME | 0.025° or 0.01° | France and nearby seas | 51 h | 3 h | Météo-France open data (`meteofrance-pnt…/pnt`), package `SP1`, time-range groups |
| ARPEGE | 0.1° (Europe) or 0.25° (global) | Europe / globe | 102 h | 6 h | Météo-France open data |
| ICON-EU | regular lat/lon (DWD) | Europe | 120 h | 6 h | DWD opendata, `.grib2.bz2`, one file per variable, concatenated per step |
| GFS | 0.25°, 0.5°, 1° | globe, NOMADS subset to the user's box | 384 h | 6 h | NOMADS `filter_gfs_*.pl`, `var_*`/`lev_*` |

On disk: `<gribsRoot>/<model>[-<resolution>]/` (default root
`~/.signalk/gribs`, config `gribsRoot`), files
`<source>__<YYYYMMDDTHH>__f<step>.grb2` (GFS, ICON-EU) or
`<source>__<stamp>__SP1_<group>.grb2` (AROME, ARPEGE), a run is complete
when `.run-<stamp>.complete` exists (its JSON is the fetch fingerprint),
older runs move to `archive/`. Downloads are atomic per run; auto or
manual mode, and it pauses offline or on a captive portal.

**Two facts that shape the plan**

1. The finer models are European. For the US East Coast (the test box),
   the downloader offers only GFS, at the same 0.25° as ECMWF: little to
   gain there. The value is for European users (AROME at 1–2.5 km on the
   French coasts, ICON-EU and ARPEGE 0.1° over European waters), who are
   part of the audience. A NOAA HRRR (3 km, CONUS) source would be the
   US equivalent; that is a downloader PR, not ours.
2. None of these carry waves or currents as the downloader fetches them.
   So this is a wind (and optionally pressure) layer only.

## Design

### A. Discovery, read-only (data worker)

- Setting `forecast.regionalGribs`: the downloader's root. Empty means
  auto: read `gribsRoot` from the downloader's plugin config
  (`plugin-config-data/signalk-grib-downloader.json`), else
  `~/.signalk/gribs` if it exists, else off.
- Scan on the forecast refresh interval: each source directory, its
  newest **complete** run (marker present), the files of that run. Never
  read a run without its marker; never touch the directory (it is the
  downloader's).
- `/api/status` gains `regional`: per source the model, resolution, run,
  domain box, first and last valid time, decode state. The Settings tab
  shows the same.

### B. Decode into our own format (data worker)

- Decode each complete run once into the decoded-run layout we already
  use (one Float32 file per field and step, `decoded.ts`), under
  `<dataDir>/regional/<source>/<stamp>/`, with the same window reads and
  the same release rules. Only `10u`/`10v` at first; `msl` optional
  (isobars, Weather API pressure). Old runs pruned with
  `forecast.keepCycles`.
- **Decoder coverage is phase 0's question, not an assumption.** Our
  GRIB2 reader handles grid 3.0, product 4.0/4.8, packing 5.0 and 5.42.
  The three providers' packings are not documented in the downloader;
  fetch one run of each on the test box and run our decoder on it. Add
  whatever template is missing (5.3 complex packing with spatial
  differencing and 5.40 JPEG 2000 are the usual suspects), with fixtures.
  AROME/ARPEGE group files hold several steps each, ICON-EU per-step files
  hold several variables: both already fit an iterate-messages reader.

### C. One layered wind source (engine)

- `LayeredWind implements WindSource`: an ordered list of regional stores
  (finest grid first) over the ECMWF store. For a point and time it uses
  the first regional store that covers both, else ECMWF. `atManyAt` is
  batched per source as `CurrentStack` already does for currents.
- **Edges.** A regional domain ends abruptly; a route along the border
  would see the wind jump. Blend over a margin inside the domain edge
  (say 5 grid cells of the regional grid) and over the last 3 hours of
  its horizon, weight going linearly from regional to ECMWF. The margin
  and handoff are constants with a test each.
- Waves, `hasWaves`, `wavesAt…` delegate to ECMWF unchanged: the router's
  wave limit and the sea-state layer stay ECMWF.
- Route request `wind_model`: `"auto"` (default, layered when any regional
  run is loaded) or `"ecmwf"`. The job log names the sources used and the
  share of wind samples each answered ("wind: AROME 0.025° 38 %, ECMWF
  62 %"); the route summary carries it.

### D. Map and Weather API

- Wind heatmap, barbs and flow lines read the layered source; the tile
  generation key for the `wx` group includes the regional runs, so a new
  AROME run refreshes only what it changes. The legend says which model
  is drawn where ("AROME 0.025° inside its domain, ECMWF elsewhere").
- Weather API point forecasts and observations use the layered wind; the
  entry's `description` names the model per step (regional steps stop at
  its horizon, ECMWF continues after).

### E. Web app and Freeboard

- Plan tab: "Regional wind where available" (on by default when a run is
  loaded), maps to `wind_model`.
- A "Regional wind domains" outline layer in Layers → Base, drawn from
  `/api/status`, so the user sees where the finer model applies.
- Freeboard gets it for free through the chart tiles and the Weather API.

## Phases

0. **Spike on the test box**: install the downloader, fetch one run each
   of AROME 0.025, ARPEGE 0.1, ICON-EU and GFS 0.25 over a small box,
   decode with our reader, list missing templates. Measure decode time and
   disk per run on the Pi. Report before building anything else.
1. Missing GRIB templates, with fixtures from phase 0.
2. Discovery and status (A).
3. Decode into decoded runs (B), wind first.
4. `LayeredWind` with edge and horizon blending (C), routing switch and
   log; tests: a synthetic regional box over a global field, a route
   crossing its edge without a jump, a route outlasting its horizon.
5. Map tiles, legend, Weather API (D).
6. Web app toggle and domain outlines (E); README, CHANGELOG.

Each phase verified on the test box before the next; phase 0 decides
whether the rest is worth doing as written.

## Risks and open points

- **Model disagreement at the edge** is the main quality risk: a route
  may prefer to skirt a domain if one model is windier. The blend margin
  softens it; the log share makes it visible.
- **Disk and CPU on a Pi**: AROME 0.01° over its domain is large (to be
  measured in phase 0, not estimated here); the downloader's own area and
  duration settings are the user's control.
- **GFS adds little here** where ECMWF is already loaded at 0.25°; it
  could be offered as an alternative global model (`wind_model: "gfs"`)
  later, not as a layer.
- **Coupling**: we read a directory another plugin writes. The marker
  file is the contract; if the downloader changes its layout, discovery
  logs what it found and skips the source rather than guessing.
