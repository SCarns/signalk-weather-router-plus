# Plan: waypoints as legs (port the parent's multi-leg routing)

Status: **done** 2026-09-28 (written 2026-09-28 17:15 EDT). Waypoints are
leg ends: `src/engine/multileg.ts` (planLegs / stitchLegs / routeMultiLeg),
propagator `snapToExact` (approximate legs end on the circle), route worker
and CLI loop over legs, forecast and SMOC areas read per leg (measured on
brain: same time as one area for all legs, less memory held). Request
fields `precision` / `arrival_radius_m`, page Precision select + radius
50–2000 m default 200. On brain, cycle 2026-09-28 12Z: the job 5e0abb0d
request succeeds precise and approximate (500 m, 200 m), motor and
sail_max; Lisbon → Palma via Cabo de São Vicente and a hairpin succeed;
no-waypoint routes byte-identical to the installed build. Deviation from
the reference: the next approximate leg starts at the circle entry, not
the canonical waypoint.

Update 2026-09-29: the collapse of consecutive approximate legs into one
via-disc search **is now ported** (`collapseRuns` in multileg.ts), with
two additions: an into-the-circle hop candidate in the propagator
(INTO_CIRCLE_NOTE in propagator.ts), and a leg-by-leg fallback when no
branch crosses every circle.

## Problem (facts)

- Routes **with waypoints** fail; the same routes **without** waypoints
  work (user report, 2026-09-28).
- Reproduced on brain with the user's failed job `5e0abb0d-…`
  (source: `GET /api/routes/5e0abb0d…`): start 21.7605 N 109.6291 W,
  end 27.0184 N 117.1314 W, waypoints (radius 500 m each)
  22.6204 N 114.5027 W, 22.9350 N 114.2476 W, 25.6761 N 116.7524 W.
  Error: `finished 30 stages without any branch crossing all 3 via(s);
  deepest branch crossed 0` (source: /tmp/baja.log on brain, installed
  build, `--no-forecast --mode motor`).
- The same request also fails with yesterday's build (commit `eae2708`,
  2026-09-27 16:19; source: /tmp/baja-yday.log on brain) and with the
  pre-water-grid build (commit `1376ad6`, 2026-09-28 13:12; source:
  /tmp/baja-old.log). It is **not** a regression from today's changes: the
  plugin never ported the parent's multi-leg layer.
- The skeleton passes exactly through every waypoint (0 m; source:
  /tmp/skel.log on brain), so the skeleton is not the cause.

## Root cause (facts from the code)

`src/engine/propagator.ts` runs **one** search for the whole route and
treats each waypoint as a disc (`Via.radiusM`) that some fixed-length
candidate leg (one stage step, e.g. 55.7 km) must happen to cross
(`segmentWithinDisc`, ~line 517). Branches aim at the skeleton point one
full step ahead of their nearest skeleton point (`targetForParent`,
`nearestSkeleton` searches the whole skeleton). Near a waypoint where the
course turns, legs cut the corner and miss a 500 m disc; once past, no
branch returns. The end point, by contrast, gets a final straight hop.

## The parent's design (what to port)

Source: the routePlanning repository.

- `routing/engine/hybrid.py` `compute_multi_leg_route` (line 850):
  `stops = [start, via1, …, end]`; **each consecutive pair is routed as its
  own route**, departing at the previous leg's arrival time so
  wind/current/tide advance; legs are stitched (duplicate junction
  waypoints dropped, distances and sail/motor times summed). Each leg has
  its own search and retries.
- `routing/routers/routes.py` lines 95–122: request fields
  `precision: "precise" | "approximate"` (default `"precise"`) and
  `arrival_radius_m` (default 200, range 0–5000; must be > 0 for
  approximate).
  - **Precise**: each leg ends exactly at the waypoint via a short motor
    segment.
  - **Approximate (the circle)**: `routing/engine/ocean_propagator.py`
    lines 1037–1075: the leg's propagation is done "as soon as any
    candidate enters this disc, regardless of stage-step size"; the next
    leg starts from that point (lines 1148–1160, `snap_to_exact=False`).
    Final destination is always exact.
- Parent UI (`ui/route-planner.html` lines 666–687): a "Waypoint
  behaviour" section with a **Precision** select (Precise / Approximate)
  and **Waypoint radius** slider 50–2000 m, default 200 ("Ignored in
  Precise mode").

The circle matters to the user ("the circle is important"): keep it, but
reached the way the parent does it (leg ends on entering the circle), not
by chance crossing.

## Current plugin state

- Page: one "Waypoint radius" slider, default 500 m
  (`public/index.html` ~line 688), no precision control.
- Worker: `radiusM: w.radius_m ?? 500` (`src/plugin/worker.ts` ~line 805),
  all vias passed to one propagator run.
- Auto vias from the water grid (narrow passages) are also discs; keep
  them working inside each leg.

## Implementation steps

1. **Request/protocol** (`src/plugin/protocol.ts`, `src/plugin/api.ts`
   validation, `openapi.ts`, README): add `precision` ("precise" default,
   "approximate") and `arrival_radius_m` (default 200, 0–5000; > 0 when
   approximate), matching the parent. Keep per-waypoint `radius_m` if
   present (it overrides `arrival_radius_m` for that waypoint).
2. **Leg loop** (route job in `src/plugin/worker.ts`; a new
   `src/engine/multileg.ts` so it is testable and used by the CLI too):
   for each consecutive stop pair, plan the corridor for that leg (global
   water grid), load that leg's forecast/current area (whatever the
   disk-forecast work provides for a route), run the propagator with
   **no user vias** (auto vias allowed), departure = previous leg's
   arrival.
3. **Propagator leg end** (`src/engine/propagator.ts`):
   - add an `arrivalRadiusM` option: terminate as soon as any candidate
     is within it of the leg's end (parent's rule (a)), keeping the
     one-stage fallback (rule (b));
   - add `snapToExact` (true for precise legs and always for the last
     leg): validate and append the final hop to the exact point
     (existing terminal-hop logic); false for approximate intermediate
     legs: the leg ends at the best candidate inside the circle and the
     next leg starts there.
4. **Stitching**: concatenate legs, drop duplicate junction points, sum
   distance/time/sail/motor, recompute leg indices; user waypoints get
   `role: "via"` in the GeoJSON; auto vias stay listed separately;
   progress messages per leg ("leg 2/4: …").
5. **Page** (`public/index.html`, `public/rp-plan.js` buildRoutePayload,
   `rp-core.js` persisted inputs): add the parent's "Waypoint behaviour"
   section: Precision select + radius slider 50–2000 m default 200 (hint
   text as the parent). Send `precision` and `arrival_radius_m`.
6. **CLI** (`src/cli.ts`): `--precision precise|approximate`,
   `--radius <m>`; `--via` keeps `@radius` per waypoint.

## Tests (all on brain for runtime; unit tests on the Mac)

- Unit: leg stitching (times chain, distances sum, no duplicate
  junctions); approximate leg ends inside the circle and the next leg
  starts there; precise leg ends exactly on the waypoint; last leg always
  exact.
- brain, installed-style CLI and the live webapp (with permission):
  - the Baja request above, precise and approximate, motor and sail_max
    with the real forecast — must succeed;
  - the same start/end **without** waypoints — result unchanged vs the
    current build (distance/time identical);
  - Lisbon → Palma with a waypoint off Cabo de São Vicente;
  - a hairpin: two waypoints ~40 km apart with a reversal (like Baja
    via1 → via2).
- Report every result with its source (log file, job id).

## Acceptance

Routes with waypoints succeed wherever the same legs succeed as separate
no-waypoint routes; approximate mode passes within the chosen radius of
each intermediate waypoint; precise mode passes exactly through it; no
change to routes without waypoints.

## Related open items (not part of this fix)

- User reported (2026-09-28): start/end markers "never appear", points not
  draggable, click placement "flaky". On brain in Chrome the markers
  appeared (small, under wind barbs), dragging the destination worked,
  and the click menu opened on 4 of 5 clicks (first click did not; cause
  not found). Need the user's steps/zoom to reproduce.
- OpenStreetMap base tiles intermittently blank on brain (cause not
  investigated).
