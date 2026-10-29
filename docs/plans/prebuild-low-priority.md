# Tile builders at low priority (plan for the next release)

Status: planned, not started. The owner asked for it on 2026-10-13 to be saved for the next release.

## Why

On brain, 2026-10-13 20:30 (`/proc/stat`, `top`, `/api/status`): the two tile builder processes had run without
stopping for 1 h 32 min at 70–80 % CPU each, the box 51 % busy, building the user's map view (Rhode Island Sound) and
the boat's area for every hour to 10-22 23Z, zoom 6–15. Each new place looked at starts a full walk there: up to about
500,000 tiles (arithmetic: 228 tiles per layer per hour × 10 layers × 219 hours; many layers end sooner), roughly 1–3
hours of two cores at the measured 50–180 tiles a second (arithmetic).

What is built is the user's choice (window, maximum zoom, follow the view: the owner, 2026-10-13, "the user decides
that"). What the plugin controls is how the building competes with Signal K and routes for the processor: today the
builders run at the same priority as Signal K.

## What changes

- `src/plugin/worker.ts`: a builder process (role `tiles`, a forked child) lowers its own priority to the lowest the
  system allows when it starts (`os.setPriority(os.constants.priority.PRIORITY_LOWEST)`, nice 19 on Linux).
- If the system refuses, the builder logs one line and carries on at normal priority.

## What does not change

What is built (window, zoom, areas), how many builders run, Signal K itself, routes, and the map's own tiles drawn on
demand (the data worker, inside Signal K).

## What it should do

- An idle box: the builders build as fast as today (priority matters only when something else wants the processor).
- A busy box (Signal K, a route): the processor goes to them first; the builders get what is left. How strongly is
  Linux's scheduler weighting, not measured on brain.

Not covered: the builders' disk writes keep normal priority (Node cannot set I/O priority).

## How it is measured (brain, before and after, prebuild running)

1. Box idle: tiles built per second (expected unchanged).
2. One replay route run while the builders work: the route's time, and Signal K's CPU during it (expected faster).
3. The builders' CPU while the route runs.

## Test

Scheduling cannot be shown in a unit test. The builder reports the priority it set at start-up; a test reads it back.
