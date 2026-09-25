# Trails overlay + offline Walk: build status

Branch `trails-offroad-routing`. Built overnight on 2026-09-25 and first run on
real data later that day. Nothing is merged to `main`, no PR is open, nothing is
pushed, and nothing has been written to B2. The plan is `FINAL_PLAN.md`. Where it
disagrees with "Contract changes since the plan" below, this file wins.

## Summary for the owner

The whole feature is built: the worker jobs, the two workflows and the frontend.
Every automated test passes: worker 363, frontend 517. One more frontend file,
the golden routes, runs only when you point it at a real bundle.

**Real data has now run, as local dry runs.** Nothing went to B2.
- **National trails build:** all three agencies, 130,736 trails.
- **One fire's routing bundle:** SISI in the North Cascades, around Stehekin, WA.
- **16 SISI routes** through the app's own routing engine.

That first contact found more than 20 real bugs. All are fixed, with tests. The
worst:
- the router forded the Stehekin River and Agnes Creek;
- it walked across glaciers;
- a pin 45 m outside the fire turned perimeter avoidance off, and the route went
  straight through the fire;
- it cut switchbacks to save seconds;
- the LANDFIRE request box was garbage;
- the build used no OpenStreetMap data at all;
- 8,368 Forest Service trails said "Hiker restricted N/A".

**Two cost-model questions are yours:**
1. Should rock and talus stay as fast as grass?
2. Should tree cost scale with canopy cover?

They are the main reason some routes still look wrong: see "Needs your call".

**Not yet run anywhere:**
- the CI runner's versions (GDAL 3.8.4, osmium 1.16);
- the plan/build/index path;
- the whole app in a browser on the final bundle, including offline;
- any fire other than SISI.

## Owner decisions taken (2026-09-25)

| Decision | How it is built |
|---|---|
| A fixed cost for **leaving** a trail or road, so routes stop cutting switchbacks | `costModel.LEAVE_TRAIL_PENALTY_S = 90`. It only affects which route is chosen and is never added to a reported time. The move into the goal cell does not pay it, and neither does a start that is already off the network. A pin *on* a trail does pay it on its first cross-country step, so it can't cut the first switchback for free. That goes a bit beyond the literal decision: say if you don't want it. |
| Times stay at loaded-crew pace (Sullivan 2020 hotshot crews, ~50 lb packs) | Unchanged. |
| Keep the current relative time ranges | `durationRangeS` is still computed (about 0.8x to 1.5x the typical time). After hands-on testing (ebe302b), the card, the mode button and the steps show **the typical time only** and say it is a fit hotshot crew's pace. |
| Session defaults, safety-conservative (not yet confirmed by you) | Glaciers and permanent snow/ice are impassable cross-country. BLM `MTC_SHARED` means motorcycles only, and hiker access is "unknown", not inferred. `STRT_LGL_VEH` maps to 4WD. The GET v2 multipliers are otherwise unchanged: rock and canopy wait for your call. |

## Real-data results

### National trails (dry run of `sync-trails`, recipe 2)

| | |
|---|---|
| Build | `b20260925-7eed4edc`: 179 s on this laptop, exit 0, GDAL 3.13.2 |
| Trails | 74,867 USFS · 19,532 BLM managed · 5,038 BLM not assessed · 31,299 NPS. Dropped: 3,289 USFS and 3 NPS with no geometry, 189 NPS by rule |
| Source dates | USFS 2026-09-23 · BLM 2026-09-21 · NPS 2026-09-22 |
| PMTiles | 105.5 MB, 81,344 tiles at z7–13. Largest tile 137 KB (z7, Sierra Nevada). 0 degraded tiles. `pmtiles verify` OK |
| FGB | 420.5 MB (the routing build reads the fire's area from it) |
| Checked against the live services | 30 records (10 per agency), re-normalized before and after the fixes: 0 mismatches. Real tile properties were run through the app's popup code |
| Values after today's fixes | USFS trails with no class: 4,287 → 2,696. 74,837 of 74,867 USFS trails now name their forest. BLM trails wrongly claiming hiker access: 1,637 → 0. BLM trails with no uses: 12,440 → 8,197 |

### SISI routing bundle (`routing-one --dry-run --force --fire sisi`)

| | |
|---|---|
| Bundle | `1318f3a35b9d` (fire `{DC4342D9-B479-44F1-906C-8ABD42E1F59C}`), built from worker HEAD 92a1e31 and trails `b20260925-7eed4edc`. 36 s wall with the NHD and OSM downloads cached; the first build took 48 s |
| Grid | 729 x 743 cells at 30 m, UTM 10N, about 8 km past the perimeter on every side. Perimeter: 44 polygons, 2026-09-25T10:15:48Z |
| Sources | LANDFIRE LF2025 via `exportImage` · OSM `us/washington` 2026-09-24 · NHD HU8 17020008/09, 17110005/06. No warnings |
| Ground | Impassable 8.8%: over 45° 7.8%, water and rivers 0.78% (2,563 river cells), snow/ice 0.25% (1,381 cells, all impassable). 21,133 creek cells can be crossed. 55 named streams in band 3; the first are Stehekin River, Agnes Creek, Blackberry Creek and Sun Creek |
| Graph | 493 nodes and 519 edges, in 3 components (the largest holds 99.2%): 149.2 km of OSM trail, 28.4 km of road, 14.3 km of track, 6.7 km of added agency trail. Conflation: 117 agency lines; 75 covered by OSM; 24 runs added; 25 parallel copies and 9 same-named braids dropped; 290 OSM edges named |
| Size | 1.31 MB: grid 536 KB, DEM 444 KB, graph 35 KB, trails.pmtiles 291 KB |
| Engine (node, this laptop) | Load 55–60 ms, perimeter mask 8 ms, route 1–265 ms |

### SISI routes (golden set, app engine; `frontend/src/routing/golden.ts`)

Times are typical, with the model's fast–slow range. "On network" is the share
of the distance on trails and roads. "Cuts" counts trail → cross-country → trail
hops, with how much each saves over staying on the trail.

| Route | Result | Before today's fixes |
|---|---|---|
| **a** Company Creek trailhead → trail km 12 | 12.0 km, ↑1,124 m, 2 h 50 (2 h 15–4 h), 99.8% on network, 0 cuts | same |
| **a2** Devore Creek trailhead → trail km 11 | 11.0 km, ↑1,264 m, 2 h 40 (2 h 05–3 h 50), 100%, 0 cuts | same |
| **b** road end → McGregor Mountain Trail km 9 | 10.0 km, ↑1,664 m, 2 h 40 (2 h 05–3 h 55), 97.8%, **1 cut**: 221 m, ↑120 m of rock in 11 min, saving 89 s | 7 cuts, each saving 0–2.6 min |
| **b_rev** the same, downhill | 9.9 km, 2 h 20 (1 h 50–3 h 30), 97.2%, 1 cut: 280 m, ↓166 m of rock in 11 min, saving 160 s | 4 cuts (penalty off) |
| **c1** Rainbow Lake Trail → off-trail rock bench | 2.6 km, ↑297 m, 1 h 20 (1 h–1 h 55), 57%, **1 cut** saving 110 s. Warns: fords North Fork Rainbow Creek | 2 cuts; clipped 11 m of open water |
| **c2** PCT → off-trail timber | 1.1 km, ↑258 m, 1 h 45 (1 h 20–2 h 40), 14%. Warns: fords South Fork Agnes Creek | same time; the stream had no name |
| **d** across the fire, avoidance on | 14.6 km, 6 h 45 (5 h 30–9 h 45), 76%. Stays out of the fire; closest approach 79 m, with a NEAR_PERIM note. Goes the long way, with 3.4 km of cross-country timber, because Agnes Creek is now a wall | 10.4 km, 2 h 40, **forded Agnes Creek** at Agnes Gorge, no note |
| **d_off** the same, avoidance off | 10.3 km, 2 h 10, 2.2 km inside the fire, with a CROSSES_PERIM note | no note |
| **e** start inside the perimeter | 8.7 km, 10 h 05 (7 h 45–16 h 10), 4.6 km inside the fire (its own polygon only). Notes: ENDPOINT_IN_PERIM, CROSSES_PERIM, XC_STREAM (Cabin Creek) | avoidance off for the whole route; no crossing note |
| **f** Company Creek Road → Stehekin Valley Road, across the river | 6.0 km of road over **Harlequin Bridge**, 1 h 15 | **forded the Stehekin River** 2.9 km from the bridge |
| **f2** a second pair across the river, 274 m apart | 5.1 km over Harlequin Bridge, 1 h | forded |
| **f3** either bank 330 m above High Bridge | 2.0 km over the Stehekin Valley Road bridge, 1 h 05 | new |
| **g** pin 45 m outside the fire (in the 60 m standoff) → far side | 17.0 km, 8 h, never enters the fire; closest approach 38 m, next to the pin. Notes: ENDPOINT_NEAR_PERIM, NEAR_PERIM | **straight through the fire**; its only note lumped the standoff in with inside |
| **g2** PCT → pin 45 m outside the north-east edge | 28.9 km, 14 h 05, around by Harlequin Bridge (the pin is across the river from the road, and the fire lies between) | through the fire; then a 23 h 35 climb (fixed by 548b819) |
| **h** straight line over the McGregor Mountain snowfield | 2.1 km around it, on rock, 1 h 10 | crossed snow cells at 3x |
| **h2** straight line over a glacier south of Agnes Creek | 2.2 km around it, on rock, 1 h 50 | crossed it |

All 16 pass the golden checks (see "How it was tested"). The worst remaining
problem is the cost model, not the routing: steep rock is priced like grass, and
timber is priced very slowly. See "Needs your call".

## Fixes made today (all with tests; each new test fails on the code before it)

**Trails ETL**

| Commit | Fix |
|---|---|
| f96db30 | Garbage values found against the live services. The USFS 'N/A' window read "Hiker restricted N/A" on 8,368 trails and reached Walk notes. A Wilderness Study Area was labelled Wilderness. BLM showed "Season: NO". BLM and NPS uses were missing. 'PCT:' was title-cased. |
| 559ae29 | `src_date` stays an ISO string. GDAL typed it as a date, so tiles said '2026/01/12'. |
| 79186c4 | A `TRAILS_RECIPE` bump now republishes (reason 'recipe'); the recipe is now 2. BLM `MTC_SHARED` means motorcycles only, and `STRT_LGL_VEH` maps to 4WD. USFS class 3 comes from 'TC3', and the forest name from ADMIN_ORG. |

**Routing worker**

| Commit | Fix |
|---|---|
| 17f243d | Under numpy 2, `gdaltransform` got 'np.float64(…)' text and projected garbage. The LANDFIRE box came out 26,708 x 172,455 px, and every build failed. |
| 4d85a99 | `bbox_5070` now refuses an implausible projected box, whatever the cause. |
| 53816a2, 85d5922 | In the live Geofabrik index, US states have parent 'north-america', so no OSM was ever used. That is fixed. A short region list now fails the job once, instead of failing every fire. |
| 4514759 | **Rivers are walls.** NHD stream order ≥ 5, a name ending in "River", or OSM `waterway=river` makes the line impassable water (class 10). New grid band 3 names each stream, listed in `bundle.json` `streams`. Smaller creeks keep the x5 cost. |
| 12688ad | **Glaciers and permanent snow/ice are impassable** (EVC 12, EVT 7735, FBFM40 NB2). They cost 3x before. |
| 6651d7e, 0263497 | The bundle id now covers the graph builder, cost grid, NHD trim and OSM filter code, and the NHD cache is keyed by trim version. A fix to any of them therefore rebuilds every bundle. Before, it would have waited up to a month. |
| 02f35e9, 51d425d, 92a1e31 | Conflation. Agency lines drawn 10–40 m off the OSM line are not new trails. Their name, number, restriction and flags now reach the whole matched OSM trail. A same-named agency braid yields to the OSM line. |

**Walk (frontend)**

| Commit | Fix |
|---|---|
| 94849b5 | The 90 s leave-trail penalty. McGregor route: 7 cuts → 1. |
| 6476cfe, 8d7e03a | A pin in the standoff or inside one polygon opens only what it needs, and the rest of the fire stays blocked. Every Walk route is checked against the perimeter: CROSSES_PERIM, NEAR_PERIM within 200 m, and PERIM_OLD even with avoidance off. |
| 40b7eef | Smoothing can no longer clip the corner of a barrier cell (c1 cut 11 m through open water). |
| 1c74a02, fe96108 | One step per trail. Short cuts are mentioned in the step. An OSM restriction starts a new step, and a ref alone does not. |
| 88b87dc, c3de3ea, 946fbae | Fords are named ("Unbridged crossing of Weasel Creek…"). Snow/ice is marked impassable in the legend. |
| 548b819 | When a cheaper route may leave the search window, the search widens (g2: 23 h 35 → 14 h 05). |
| 16d6aed | **A pin on a road over river cells starts on the road.** 178 SISI graph vertices sit on river cells. A pin there used to snap to the nearest walkable cell, which for 7 of them lies across more river. The line then began with a wade: route f's first leg had 11 m of water, and a Company Creek Road pin 25 m. In the synthetic test, a pin nearer the far bank got no route at all. |
| 154f632 | The legend says "Open water or river" and "Perennial creek (crossable)". |
| ebe302b, 6878674 | From hands-on testing: typical time only; the credit moved to the map attribution; the map toolbar lets clicks through; the step list scrolls. |
| 4d2aa8d | The golden-route harness (below). |

## Contract changes since the plan

These replace the corresponding parts of FINAL_PLAN §2.

- **`grid.tif`** has 3 Byte bands. Band 3 is `stream`: 0 means none; k means
  `bundle.json` `streams.names[k-1]`. `streams` is `{band: 3, names: [...], truncated}`,
  with at most 255 names: rivers first, then the longest streams.
- **Rivers** are class 10 with an id > 0 and no stream bit; pace 255. The stream
  bit now means a creek below river size (x5).
- **Snow/ice** is class 9, pace 255.
- **New stat** `river_cells`.
- **Bundle id inputs:**
  - added: `cost_grid` (COST_GRID_VERSION 3), `nhd_trim` (2), `osm_filter` (2),
    `graph_build` (4) and `osm_water_hash`;
  - the `recipe` is still 1, so no app update is required.
- **NHD cache key:** `work/nhd/v{N}/{huc8}.gpkg`.
- **Trails:**
  - `state/trails.json` and `build.json` carry `recipe` (now 2);
  - the USFS `unit` is the forest name.

## How it was tested

| Command | Result |
|---|---|
| `cd worker && uv run pytest -q` | **363 passed.** The GDAL/osmium tests ran for real, but on GDAL 3.13.2 and osmium 1.19.1, not CI's 3.8.4 and 1.16. |
| `cd frontend && npx tsc --noEmit && npx vitest run && npx vite build` | tsc clean. **517 passed**, plus the golden file skipped (it names the variable to set). Build OK. |
| Golden routes on the real SISI bundle | **17 of 17 pass** on `1318f3a35b9d` (16 routes plus a check that the fire has goldens). |

Running the golden routes:

```sh
cd worker && uv run python scripts/golden_bundle.py <out>/routing/<fire_key>/b<id> /tmp/golden/sisi
cd frontend && ROUTING_GOLDEN_DIR=/tmp/golden/sisi npx vitest run src/routing/golden.test.ts
```

**The copy script** checks each file's sha256 and stores the perimeter the routes
were written against. Pass `--perimeter FILE`, or it fetches the latest from the
DEV fire API. Real bundles are never committed.

**Each route runs through `routeWalk`**, so the notes are the ones the Walk card
shows. Every route is checked for these:
- no cross-country cell of a barrier class (river/water, snow/ice, over 45°);
- every cut saves the 90 s penalty over the network between its ends, with 10 s
  of slack;
- with avoidance on, the line enters no fire polygon that a pin isn't in;
- at most 15 m of the line lies in the fire or standoff away from the pins.

Each route also checks its own bounds and notes. Preconditions fail as such, not
as routing bugs: where each pin sits on the perimeter, and what the straight line
crosses.

**The harness catches known regressions.** I checked it against three older
states:
- the pre-river bundle `d515909392c7`: f and f2 ford, h and h2 cross snow;
- the engine before 16d6aed: f starts with 64 m cross-country, 11 m of it water;
- `LEAVE_TRAIL_PENALTY_S = 0`: b cuts 7 switchbacks.

## Not verified yet

1. **CI versions.** GDAL 3.8.4 and osmium 1.16 have not run anything. Two things
   to watch on 3.8.4:
   - the NHD trim's GPKG native SQL (`-sql` with a LEFT JOIN on NHDFlowlineVAA and
     an IN subquery), which `test_nhd_trim_keeps_perennial_only` covers on CI;
   - the `ogrinfo -q` layer listing.

   One CI dry run of each workflow (`dry_run` checked, `fire=SISI`) settles it.
2. **The CI path.** Only `routing-one --trails-src <local FGB>` ran. Not run:
   - `routing-plan`, `routing-build --shard` and `routing-index`;
   - the `/vsicurl/` read of the 420 MB FGB;
   - `catalogs/health/routing.json`;
   - AOI never-shrink/hysteresis;
   - backoff.

   Because the trails came from a local file, `sources.trails.build_id` is null in
   the SISI bundle.
3. **The app in a browser.** Only your hands-on Walk test on SISI has run in a
   browser (it led to ebe302b and 6878674), and that was on an earlier bundle.
   Not run:
   - the final bundle `1318f3a35b9d` in the app;
   - the national trails layer and its popups;
   - vegetation;
   - an offline pack download, then airplane mode;
   - phone timings (the budget is < 2 s load and < 1 s per route).

   The final bundle is at `scratchpad/realdata/routing-out/` (pointer and index
   included). The trails build is at `scratchpad/realdata/trails-out3/`. Serve a
   static build from the scratchpad (the dev server can't launch from ~/Desktop).
4. **Other fires.** SISI is small: a 22 km box at 30 m cells, one Geofabrik
   region, one UTM zone, fully covered by LF2025, and a perimeter with no holes.
   These have run only in unit tests, never on real data:
   - 60 m grids, clipping, several regions or zones;
   - the LF2024 per-pixel mosaic and the WCS fallback;
   - perimeter holes;
   - `blocked_by_perimeter`.

   The golden routes from the plan (Iron Creek → Stanley Lake, Bob Marshall) have
   not run.
5. **Fixtures and ground truth.** The TNM fixture is still a reconstructed Idaho
   excerpt, not a captured response. Where NPS/USFS and OSM draw the same trail up
   to 130 m apart, which line is on the ground is unknown.
6. **USFS "Centerline" rows** (all 8 USFS trails around SISI):
   - allowed uses are not published and cannot be joined from other rows, so the
     popup reads "Allowed uses not published";
   - 2,696 rows keep class 0 because their band is 'TC1-2' or 'TC4-5';
   - Wilderness is not shown, since SPECIAL_MGMT_AREA is 'N/A'.

## Needs your call

1. **Rock, talus and bedrock multiplier** (pending). Barren ground costs the same
   as grass (M = 1) up to 45°. On SISI that is 11% of cells: all LANDFIRE
   bedrock/cliff/talus, median slope 34°. The multiplier:
   - drives the remaining cuts: b's is 221 m of rock up 120 m in 11 min, saving
     89 s; b_rev's is 280 m down 166 m in 11 min;
   - makes h walk 1.7 km of steep rock in an hour.

   Options:
   - a 2–3x barren multiplier;
   - a lower impassable slope for bedrock/talus (e.g. > 35°);
   - a cap on the cross-country climb and descent rate.

   It is one constant in `cost_grid.py`; bump `COST_GRID_VERSION` and the bundles
   rebuild.
2. **Tree canopy scaling** (pending). Every tree cell costs 4x whatever its EVC
   cover, and heavy litter 8x. On SISI, 34,625 cells with 10–29% cover are as slow
   as dense timber (median 0.36 km/h). This is why:
   - d now takes 3.4 km cross-country, mostly timber, in 4 h 20;
   - e takes 10 h, with 3.95 km cross-country, mostly timber, in 9 h 05;
   - c2 takes 1 h 45 for 920 m.

   Options: scale with cover as brush already does, or cap it. Relative costs
   matter more than absolute ones, since they decide the route.
3. **River threshold.** RIVER_ORDER = 5 (NHD HR stream order). Order-4 creeks stay
   crossable at 5x unless OSM calls them a river.
4. **A pin inside the fire opens its whole polygon** (route e: 4.6 km inside the
   fire, 10 h). Should a pin inside instead route out by the nearest edge?
5. **The start-on-trail penalty rule**: see the first table.
6. **"Near-optimal" note on short pairs.** f (260 m apart) and g get WEIGHTED
   because the only bridge is outside the 2 km search window. The fallback searches
   the whole grid at weight 1.2. On a grid SISI's size, weight 1 would be exact and
   still fast.
7. Still open from the overnight build:
   - the ODbL posture (graphs and `ways` are public on B2);
   - whether "modeled, not scouted" also applies to online engines;
   - the S3-endpoint PMTiles URL;
   - AK/HI/PR unsupported;
   - the merge strategy for `store.ts`, `useMapLayerSync.ts`, `zOrder.ts` and
     `SearchDirectionsControl.tsx`.

## Decisions I made (revisit any)

- **Trails default `auto`:** shown only on the offline ground, where there is no
  basemap. An explicit on/off wins and persists.
- **Perimeter standoff is 60 m.** A pin in it opens about 105 m around itself. A
  pin inside a polygon opens that polygon and its own standoff.
- **Walk notes:**
  - NEAR_PERIM within 200 m;
  - PERIM_OLD over 12 h;
  - no HOTSPOT_NEAR yet.
- **Network snap:** a pin on impassable ground within 30 m of a road or trail
  vertex starts on it. SNAP_MOVED appears when the pin moved 5 m or more.
- **Monthly LANDFIRE epoch** in the bundle id: every bundle rebuilds about monthly.
- **Cadence:** routing every 3 h. Trails check daily and build at most weekly.
- **AOI:** perimeter bbox + 8 km, at least 16 km a side; 60 m cells above 6.25M
  cells; clipped at 150 km.
- **Hazards:** unknown ground 4x; GET slash 5x. Snow was 3x; it is now impassable
  (session default).
- **No prune command.** Nothing deletes automatically.

## Where to resume

1. **Answer the cost-model questions** (rock, canopy). Then:
   - change `cost_grid.py`;
   - bump `COST_GRID_VERSION`;
   - rebuild SISI with `routing-one --dry-run --force --fire sisi --trails-src …`;
   - rerun the golden routes. Tighten b/c1 `maxCuts` to 0 if the rock change
     removes the cuts.
2. **Dispatch Trails build, then Routing bundles,** with `dry_run` checked and
   `fire=SISI`, on the CI runner (GDAL 3.8.4). Compare the output with the local
   numbers above.
3. **Browser QA on the final SISI bundle,** online and offline, including the pack
   download.
4. **Add a second, bigger fire,** with its own golden routes in `golden.ts`.
   Choose one that exercises 60 m cells, two regions or a perimeter with holes.
5. **Run for real:** Trails build, then Routing bundles. Watch the `/health` rows.
