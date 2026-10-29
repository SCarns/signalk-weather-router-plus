# To do

## Tack penalty

Lose a fixed time (for example 30 s) on every tack or gybe, so that the
router avoids needless tacking. Until 0.1.0-beta.5 it was a vessel
setting (`vessel.tackPenalty`, and `vessel.tack_penalty_s` in a route
request) that nothing in the router used; it was removed. Needs: a tack
or gybe detected between consecutive legs in the leg simulation
(`src/engine/legsim.ts`) and the isochrone propagation
(`src/engine/propagator.ts`), the setting and route-request field back,
and a test on brain comparing routes with and without it.

## Bearing correctness in the webapp

`public/rp-plan.js` (`_drawRouteLegs`) sets each route point's `outgoing_cog`
with `atan2(dx, dy)` on OpenLayers map coordinates. That is a correct
(rhumb-line) bearing only if those coordinates are Web Mercator
(EPSG:3857, conformal). If they are lon/lat degrees, it is the
flat-earth bearing that kristianwiklund/signalk-weather-routing PR #387
fixes there: east–west differences not scaled by cos(latitude), about
45° instead of 27° for a 1°N 1°E step at 60°N. Needs: confirm the map
projection the points use; if it is not EPSG:3857, use a geodesic
bearing (as `haversineBearing` in `src/geo/geodesy.ts`), and add a test
at high latitude. Also check any other place the webapp computes a
bearing or angular gap from coordinates.

## RTOFS in the tile builders: read the cells a tile needs

Every tile builder (`src/plugin/prebuild.ts`) decodes every RTOFS product in
use whole from the GRIB cache and keeps it for its life
(`adoptCurrentsRef` → `rtofsFromCache(ref, null)`,
`src/plugin/worker/currents.ts`, `src/currents/fromcache.ts`), though it
builds tiles near the boat or the view only. The chart-mesh leg reads it
the same way. Nothing is retained: a builder exits when its walk ends and
gives everything back, and Signal K does not move. The cost is the peak
while a walk runs. Brain, 2026-10-26, west_atl and samoa, 72 h at 3 h:
each builder peaked at about 350 MB (two builders, about 700 MB; reaching
300 MB within 6 s of its start); the two products alone in their own
process went from 47 MB to 304 MB loading and 190 MB after a GC, for 84 MB
of values (46 + 38 MB). Proposed (design not written yet): the data worker
writes the decoded RTOFS steps to disk once, as it writes the decoded
forecast, and the builders and the mesh leg read the cells a tile or leg
needs from it. Measure a walk's builder peak before and after.
