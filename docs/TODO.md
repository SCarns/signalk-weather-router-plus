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

`public/rp-core.js` ~line 597 sets each route point's `outgoing_cog`
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
