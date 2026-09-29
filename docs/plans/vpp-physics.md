# Plan: a polar calculator that respects heel, side force and hull shape

Status: **plugin done** 2026-09-29. Done: validation set, baseline, sources, the polar performance setting, and the physics calculator in the plugin (`src/vessel/vpp_physics.ts`, fit `tools/vpp_fit.ts`, held-out test `src/vessel/vpp_physics.test.ts`), used by the polar generator. Held-out median error 3.3% / 3.2% / 3.3% (upwind / reaching / running), boats over 30%: 3 / 1 / 0 of 441. Known artifacts: heavy boats +7–10% reaching in 4–6 kn; up to ~2% speed loss at tight angles from 20 to 24 kn. Open: port to the parent, regenerate saved polars, rerun the Skye 51 route. Covers both apps:
the parent's `routePlanning/routing/vessel/vpp_empirical.py` and the
plugin's port `src/vessel/vpp_empirical.ts`, which reproduces the Python
bit for bit (`src/vessel/vpp.test.ts`).

Decided 2026-09-28 (user):
- Hull coefficients the form doesn't collect use **published** typical
  values, shown to the user as assumptions.
- **No spinnaker assumption.**
- Multihulls are **out of scope** (still rejected).
- **Plugin first**, parent after.

- 30% worst-cell error is a warning threshold, not a blocker (see
  "Measuring accuracy").

## Update 2026-09-28: ORC baseline (supersedes the "15–35% fast" claim below)

- **Validation set built:** `test-data/orc-ns-2026.json`, 882 ORC 2026
  non-spinnaker certificates, one per boat class, from
  `https://data.orc.org/public/WPub.dll?action=activecerts&Family=5&VPPYear=2026`
  and `…?action=DownBoatRMS&RefNo=<ref>&ext=json`. Builder:
  `tools/orc_ns_dataset.py` (field mapping in its header; LWL is ORC's
  IMS sailing length, as certificates carry no LWL). Scorer:
  `tools/vpp_validate.ts`.
- **Today's calculator against it** (median over boats, TWS 6–20 kn):
  mean absolute error 8.8% upwind, 3.7% reaching, 6.9% running; worst
  cell over 30% for 4% / 3% / 3% of boats. Heavy boats (DLR ≥ 250, 186
  boats) lean fast: median +10–14% upwind, +3–13% running, worst tenth up
  to +26%.
- **The Skye 51 polar matches ORC's predictions for comparable boats**:
  at TWA 75° in 6 / 8 / 10 kn it gives 5.08 / 6.77 / 7.53 kn; ORC gives
  5.33–6.08 / 6.26–7.06 / 6.96–7.69 kn for the Swan 48, Southerly 145,
  Compass 47, Baltic 51 and Contest 48CS. The "as fast as the wind"
  routes are race-prediction speeds applied to a cruising boat.
- **The Catalina comparison below was misleading:** `catalina36.csv`
  (source unrecorded) is much slower than ORC-type predictions.
- **Done in response:** the polar performance setting (user decision:
  both the setting and this calculator; setting first). See CHANGELOG.
- **Sources gathered** (scratchpad `vpp-sources/`, with citations): ORC
  VPP Documentation 2026 (primary, free: sail coefficients, depowering,
  heeling moment); ITTC-57; Delft hull-series coefficients from
  secondary copies only (primary papers are closed), the upright
  residuary table checked against Delft's open tow-tank data (3–9% mean
  absolute error over 51 hulls). Gaps: no free, citable righting-moment
  estimate from beam/draft/displacement/ballast; no published canoe-body
  draft ratio by keel type; ORC's effective-span curve is a plot only;
  the wetted-surface exponent and one side-force sign differ between
  copies.

## Problem (facts, as first written)

- User report, 2026-09-28: routes for a displacement ketch show SOG "as
  fast as the wind", even into a foul tide.
- The routing maths is not the cause. On brain, job `100c4f7b…` (Skye 51
  ketch, 125 legs), every leg's implied speed through the water (SOG
  minus the current along the course) matches the polar at that leg's
  wind within 0.72 kn. The 16 legs with SOG ≥ 70% of wind speed in a
  foul current match it within 0.14 kn; their foul current was
  0.01–0.29 kn and was subtracted. Leg simulation, current addition,
  mode choice, polar lookup and SOG all match the parent line for line.
- The polar is the cause. `routePlanning/data/polars/user/skye_51_ketch.csv`
  (2026-04-18) came from the parent's empirical calculator. Below about
  10 kn of wind its speed is a fixed fraction of wind speed: at TWA 70°
  it is 3.58 / 5.37 / 7.16 kn in 4 / 6 / 8 kn of wind (0.895 × TWS); at
  TWA 30° it is exactly 0.3225 × TWS from 4 to 10 kn.
- Against a reference polar the calculator is 15–35% fast from about
  8 kn of wind up. Generated `catalina_36_gen.csv` vs the repo's
  `catalina36.csv` (committed 2026-04-01; its source is not recorded, so
  "reference", not "measured"):

  | TWA | 8 kn | 12 kn | 16 kn | 20 kn |
  |---|---|---|---|---|
  | 30° | 3.3 / 2.7 | 4.3 / 4.0 | 4.6 / 5.3 | 4.7 / 6.3 |
  | 60° | 5.2 / 6.5 | 6.2 / 7.2 | 6.5 / 7.6 | 6.6 / 7.9 |
  | 180° | 2.9 / 3.4 | 4.1 / 5.1 | 4.9 / 6.4 | 5.4 / 7.1 |

  (reference / generated, knots)

## Root cause (facts from the code)

`_solve_boat_speed` balances one forward drive against one hull drag:

1. **Speed is a fixed fraction of wind speed below hull speed.** Drive is
   `0.5·ρ_air·AWS²·SA·C(AWA)`; drag is `0.5·ρ_water·S·V²·(0.004 + 0.01)`
   with the wave term flat until Froude 0.33. Both scale with the square
   of speed, so the solution V/TWS is the same at every wind speed.
2. **No heel, stability or reefing.** Nothing limits sail force as wind
   builds; only the hull-speed cap (1.08 × 1.25·√LWL) stops it. Hence
   30° at 20 kn: 6.3 kn generated vs 4.7 reference.
3. **All sail force is forward drive.** `C` (0.75 from AWA 35° to 80°) is
   applied along the heading. There is no side force, so no leeway and
   no induced drag.
4. **Hull drag ignores the hull.** Wetted area is `2.7·(Δ/ρ)^(2/3)` from
   displacement alone; `beam_m` is passed in and never used; no form,
   appendage or residuary resistance by hull shape.
5. **A spinnaker is assumed.** With no downwind sail area, it becomes
   1.5 × upwind area with a peak coefficient of 1.05.

## Proposed model

A standard, published yacht VPP structure (the kind ORC and Hazen-type
programs use), kept small enough to run in the browser-request path.
Every coefficient comes from a cited source; none is invented. The
sources are listed under "Reading before coding" and must be read
before any number goes into code.

1. **Sail forces as lift and drag.** Per sail, lift and drag
   coefficients against apparent wind angle; resolve into drive
   `L·sin(AWA) − D·cos(AWA)` and side force `L·cos(AWA) + D·sin(AWA)`.
   Induced drag `C_L² / (π·AR_eff)`, effective span from mast height
   (`mast_height_m`, already in `BoatSpecs`).
2. **Heel and depowering.** Heeling moment = side force × (centre of
   effort height + hull centre of lateral resistance depth). Righting
   moment from displacement, beam, draft and ballast. Solve for heel;
   reduce sail power with the usual "flat" and "reef" depowering
   factors and pick the setting that gives the most drive. This is what
   makes the upwind rows level off.
3. **Hull resistance by shape.** Friction from the ITTC-57 line with
   Reynolds number on waterline length; residuary resistance and wetted
   area from the Delft Systematic Yacht Hull Series regressions, which
   use LWL, beam, draft and displacement (so `beam_m` finally counts);
   keel and rudder viscous and induced resistance. Hull coefficients the
   form doesn't collect (prismatic coefficient, LCB, canoe-body draft)
   take published typical values by keel and hull type, each with its
   source, and the page lists them as assumptions next to the polar.
6. **Downwind: no spinnaker assumption.** Downwind speed uses the
   upwind sails only unless the user enters a downwind sail area. The
   silent "1.5 × upwind area" default and its spinnaker coefficient go.
4. **Leeway.** Keel side force balances sail side force; the keel's
   induced drag is part of the resistance.
5. **Solver.** Per (TWA, TWS) cell, solve boat speed and heel together,
   optimising the depowering settings, on the same TWA/TWS grid as today
   so saved polars and the routing code don't change.

## Steps

1. **Reading before coding.** Read and record page references for: the
   Delft series papers (Keuning & Sonnenberg; Gerritsma, Keuning &
   Onnink), the ORC VPP documentation, Hazen's aerodynamic model, and
   Larsson & Eliasson "Principles of Yacht Design" (VPP chapter). Write
   each coefficient's source into this doc before it goes into code.
2. **Validation set.** Collect boats that have both (a) specs in the
   calculator's form fields and (b) a polar with a recorded source, such
   as an ORC certificate. Include at least one heavy displacement ketch
   and the Catalina 36. Record the source of every polar. Do not use
   `catalina36.csv` or the `data/polars/*.pol` files as ground truth
   unless their source is found.
3. **Baseline.** Score today's calculator against the validation set:
   per cell and mean absolute error for TWS 6–20 kn, split into upwind,
   reaching and running.
4. **Plugin first.** Implement the model in `src/vessel/` behind the
   same `VPP` interface, with tests: the validation set within the
   target, speed never falls as TWS rises, upwind speed levels off,
   zero below the no-go angle. The current bit-for-bit test against the
   parent's Python (`src/vessel/vpp.test.ts`) stops applying; it is
   replaced by the validation-set test.
5. **Port to the parent.** Port to `routing/vessel/` with
   `tests/test_vpp.py`, and make the parent's tables match the plugin's.
6. **Regenerate saved polars.** Find the specs behind every generated
   polar (parent `data/polars/user/`, plugin data directory). Regenerate
   those whose specs are recorded; list the ones whose specs aren't, for
   the user to re-enter.
7. **Check a route.** Rerun job `100c4f7b…` on brain with the
   regenerated Skye 51 polar and report the per-leg speed-through-water
   check again.

## Measuring accuracy

- **What is compared.** For each validation boat, the calculator's
  polar against that boat's reference polar, cell by cell, for TWS 6–20
  kn. Error per cell = (calculated − reference) / reference, in percent.
- **What is reported.** Mean absolute error and worst cell, per sector:
  upwind (TWA 30–60°), reaching (70–120°), running (135–180°).
- **Reference polars.** ORC certificates are the candidate. They are
  ORC's own VPP run on each boat's measured hull and sails, not
  on-water logs; no large set of logged polars with specs is known.
  ORC also issues non-spinnaker (NS) certificates, which match the
  no-spinnaker rule. Not yet verified: whether ORC's public data service
  (data.orc.org) gives per-boat polars and specs for download; its
  unparameterised response is certificate counts by country only.
- **Today's baseline**, generated `catalina_36_gen.csv` against the
  repo's `catalina36.csv` (source unrecorded), TWS 6–20 kn:

  | Sector | Cells | Mean abs. error | Worst cell |
  |---|---|---|---|
  | Upwind | 12 | 19.6% | +35.1% |
  | Reaching | 18 | 11.9% | +33.6% |
  | Running | 12 | 20.7% | +31.2% |

- **Threshold (user, 2026-09-28): worst cell within 30%** of the
  reference in every sector, TWS 6–20 kn. It is a **warning, not a
  blocker**: a boat or sector over 30% is reported (in the validation
  report, and on the page next to the polar when it applies) but does not
  stop the work shipping. The mean error is reported with no threshold.
  Today's calculator is over it in all three sectors on the Catalina 36
  (+35.1%, +33.6%, +31.2%).
