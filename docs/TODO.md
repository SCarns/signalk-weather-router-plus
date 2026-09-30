# To do

## Tack penalty

Lose a fixed time (for example 30 s) on every tack or gybe, so that the
router avoids needless tacking. Until 0.1.0-beta.4 it was a vessel
setting (`vessel.tackPenalty`, and `vessel.tack_penalty_s` in a route
request) that nothing in the router used; it was removed. Needs: a tack
or gybe detected between consecutive legs in the leg simulation
(`src/engine/legsim.ts`) and the isochrone propagation
(`src/engine/propagator.ts`), the setting and route-request field back,
and a test on brain comparing routes with and without it.

## Maximum wave height

Avoid places and times where the significant wave height is above a
limit the user sets. Until 0.1.0-beta.4 it was a vessel setting
(`vessel.maxSwh`, "informational") that nothing in the router used; it
was removed. Needs: the wave field (ECMWF `swh`) sampled during the
propagation, candidates above the limit dropped, a clear failure message
when no route stays under the limit, the setting and route-request field
back, and a test on brain.
