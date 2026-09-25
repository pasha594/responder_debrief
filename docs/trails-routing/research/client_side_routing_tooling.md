# Client-side trail + cross-country routing tooling (browser worker, offline, Python preprocessing)

Research date: 2026-09-24. Consumer context: Responder Debrief (MapLibre GL JS v5 + React + zustand, static GitHub Pages, Python 3.12/GDAL 3.8 worker on GitHub Actions, static files on Backblaze B2, OPFS offline pack). Current walk routing (`frontend/src/api/routing.ts`) calls openrouteservice foot-hiking, falling back to FOSSGIS Valhalla pedestrian, over the network only. Nothing works offline or off-network today.

About the local measurements: numbers marked "local benchmark" come from scripts I wrote and ran in the session scratchpad. The scripts are `bench/core.mjs`, `bench/bench.mjs`, `osm_graph_sizes.py` and a tile HEAD-request script, all under `(local scratch, not included)/`. They ran on one machine: Apple M5 Pro, 24 GiB RAM, Node v26.7.0, single thread. Treat them as best-case desktop figures. Phones will be slower, and I did not measure by how much. The raw output is in `scratchpad/bench/bench_out.txt` and `scratchpad/osm_sizes.jsonl`.

## Q1. Browser graph routing: small JS libraries vs a hand-rolled Dijkstra/A*, and WASM builds of real routing engines

### Takeaway
A per-fire trail/road graph is small. A real 50×50 km WUI area had about 36k edges, and 200k edges is the high end. At that size a hand-rolled A* over typed-array (CSR) adjacency with a binary heap answers a query in about 0.3–1.5 ms median on desktop. The code is about 150 lines and about 2 KB gzipped, so no dependency is needed. The smallest acceptable library, ngraph.path plus ngraph.graph, is about 4 KB gzipped and object-based. Valhalla now runs in the browser as WASM (about 1.8–2.1 MB gzipped plus a tile tarball), but both builds are weeks-to-months old with single-digit to 25 GitHub stars. I found no WASM build of OSRM, GraphHopper, RoutingKit or BRouter.

### Cited Findings
**JS libraries** (sizes from Bundlephobia's API, versions and dates from the npm registry, activity from the GitHub API; all queried 2026-09-24):
- **ngraph.path** 1.6.1 (published 2025-11-18). 7.2 KB min / 2.4 KB gzip, 0 declared runtime deps, MIT. Repo has 3,133 stars, last push 2026-07-27, 18 open issues. It runs on an `ngraph.graph` instance (ngraph.graph 20.1.2 is 4.3 KB min / 1.8 KB gzip) — [npm registry](https://registry.npmjs.org/ngraph.path), [Bundlephobia](https://bundlephobia.com/package/ngraph.path), [GitHub](https://github.com/anvaka/ngraph.path)
- ngraph.path offers A*, bidirectional NBA*, greedy A*, and Dijkstra (A* with no heuristic). Options include `distance(from,to,link)`, `heuristic`, `oriented` and `blocked(from,to,link)`. The README benchmark uses the NYC road graph (264,346 nodes, 733,844 edges) and 250 random queries; the machine is not stated. Average per query: greedy 32 ms, NBA* 44 ms, A* 55 ms, Dijkstra 264 ms. p99 was 136, 172, 287 and 631 ms respectively. It uses a heap priority queue and an object pool; the README says nothing about web workers — [ngraph.path README](https://github.com/anvaka/ngraph.path)
- **geojson-path-finder** 2.1.0 (2025-11-15), TypeScript, ISC. 10.1 KB min / 3.5 KB gzip. Dependencies: @turf/distance, @turf/explode, @turf/helpers, tinyqueue. Repo has 332 stars, last push 2025-11-15 — [npm registry](https://registry.npmjs.org/geojson-path-finder), [Bundlephobia](https://bundlephobia.com/package/geojson-path-finder), [GitHub](https://github.com/perliedman/geojson-path-finder)
- geojson-path-finder builds topology from GeoJSON LineStrings: lines that "start and end, or cross, at the same coordinate are joined", with vertex snapping `tolerance` (default 1e-5°). A `weight` function can return `{forward, backward}` for direction-dependent (for example uphill vs downhill) costs, or 0/undefined to disable an edge. The README says "both points _have to_ be vertices in the routing network" and gives no performance figures — [README](https://github.com/perliedman/geojson-path-finder)
- **graphology-shortest-path** 2.1.0 (2024-03-27). 17.5 KB min / 5.7 KB gzip with 4 deps (mnemonist, graphology-indices, graphology-utils, helpers). It also needs graphology core 0.26.0 at 66.4 KB min / 12.8 KB gzip. Monorepo has 1,749 stars, pushed 2026-09-02 — [npm registry](https://registry.npmjs.org/graphology-shortest-path), [Bundlephobia](https://bundlephobia.com/package/graphology-shortest-path)
- **PathFinding.js** (npm `pathfinding`) is grid-only. Last npm release 0.4.18 was 2016-05-10 (stale). Depends on `heap`; 21.2 KB min / 5.4 KB gzip. 8,715 stars, last push 2024-06-20, 106 open issues — [npm registry](https://registry.npmjs.org/pathfinding), [Bundlephobia](https://bundlephobia.com/package/pathfinding), [GitHub](https://github.com/qiao/PathFinding.js)
- **easystarjs** is grid-only. Last release 0.4.4 was 2020-10-18 (stale); 8.1 KB min / 3.0 KB gzip; last push 2024-01-23 — [npm registry](https://registry.npmjs.org/easystarjs), [Bundlephobia](https://bundlephobia.com/package/easystarjs)
- **contraction-hierarchy-js** 2.0.0 (2025-07-19). Deps: geokdbush, kdbush, nanoclone, pbf. 34.7 KB min / 10.7 KB gzip. 15 stars, pushed 2026-04-16 — [npm registry](https://registry.npmjs.org/contraction-hierarchy-js), [Bundlephobia](https://bundlephobia.com/package/contraction-hierarchy-js)
- **@turf/shortest-path** 7.4.0 (2026-08-03) does grid obstacle avoidance. 11 deps, 19.4 KB min / 6.9 KB gzip — [npm registry](https://registry.npmjs.org/@turf/shortest-path), [Bundlephobia](https://bundlephobia.com/package/@turf/shortest-path)
- Priority queues if you hand-roll: **flatqueue** 3.1.0 (2026-06-05) is 1.06 KB min / 545 B gzip, and **tinyqueue** 3.0.0 is 845 B / 454 B gzip. Both have zero deps — [flatqueue npm](https://registry.npmjs.org/flatqueue), [tinyqueue npm](https://registry.npmjs.org/tinyqueue), [Bundlephobia](https://bundlephobia.com/package/flatqueue)
- **route-snapper** 0.4.9 (npm 2024-11-25) is a MapLibre plugin for drawing routes and areas that "snap to some network (streets, usually)". It routes client-side in Rust compiled to WASM over prebuilt graph files; `osm-to-route-snapper` and `geojson-to-route-snapper` build those files. Used by Ungap the Map and ATIP. Package has a 282 KB `.wasm` (117 KB gzip, measured) plus about 26 KB of JS glue. 237 stars, last push 2026-01-04. The README I fetched does not document a freehand/off-network mode — [GitHub](https://github.com/dabreegster/route_snapper), [jsDelivr file list](https://data.jsdelivr.com/v1/packages/npm/route-snapper@0.4.9?structure=flat)

**Hand-rolled baseline** (local benchmark):
- My dependency-free core covers a binary heap on typed arrays, A* and Dijkstra over CSR adjacency, raster A* (8/16 neighbours, anisotropic), and path tracing. It is 147 lines: 5,459 B raw, 2,008 B gzip, or 1,471 B gzip with comments and whitespace stripped (no minifier used) — [local core.mjs](file://(local scratch, not included)/bench/core.mjs)
- On the real OSM graph for the Park Fire 50×50 km area (27,263 nodes, 35,855 edges; see Q3), 300 random pairs gave A* median 0.3 ms, p95 1.7 ms, max 2.0 ms. Dijkstra median was 1.0 ms (p95 1.4 ms). A full single-source tree took 2.6 ms and the CSR build 6 ms. 7/300 pairs were unreachable because the graph has 48 components — [local bench.mjs](file://(local scratch, not included)/bench/bench.mjs)
- On a synthetic jittered-grid graph (102,400 nodes, 187,906 edges), A* median was 1.3–1.4 ms, p95 4.6–5.2 ms, max about 8 ms. Dijkstra median was 3.0 ms, a full tree 6.9–7.9 ms, and the CSR build about 2 ms — [local bench.mjs](file://(local scratch, not included)/bench/bench.mjs)

**WASM builds of real engines:**
- **valhalla-browser** 0.2.1 (repo tobilg/valhalla-wasm). Repo created 2026-09-17; npm versions published 2026-09-18 to 2026-09-21; 25 stars; MIT.
  - Wraps Valhalla 3.8.3 and must run in a dedicated Web Worker. Tiles load on demand through HTTP ranges from an indexed TAR, or as individual `.gph` files. Costings: auto, bicycle, pedestrian, truck.
  - WASM memory defaults to 128/512 MiB, with a ceiling of 1,024. Its CSP needs `'wasm-unsafe-eval'` and `blob:` workers.
  - The README states: "There is no OPFS, IndexedDB, service-worker cache, offline guarantee or external routing fallback". Cloudflare Workers support is marked experimental. Demo: valhalla-browser.gh.tobilg.com.
  - The `.wasm` is 9.86 MB raw, 2.14 MB gzip -9 (measured).
  - Sources: [GitHub](https://github.com/tobilg/valhalla-browser), [npm registry](https://registry.npmjs.org/valhalla-browser), [README via jsDelivr](https://cdn.jsdelivr.net/npm/valhalla-browser@0.2.1/README.md)
- **valhalla-wasm** 0.1.0 (ecc521; a single npm version, 2026-06-20). The README says "There is no official Valhalla WASM build".
  - It does "fully offline" routing by mounting a routing-tile `.tar` from local storage as a lazily read virtual file; there is an OPFS tar tile source (`createOpfsTarTileSourceFactory`). "A route uses ~20–50 MB instead of the full multi-hundred-MB graph."
  - It was extracted from rivers.run, which uses it for offline navigation. Building from source takes about 1 hour in Docker.
  - Prebuilt `valhalla.wasm` is 7.26 MB raw, 1.78 MB gzip (measured).
  - Sources: [README via jsDelivr](https://cdn.jsdelivr.net/npm/valhalla-wasm@0.1.0/README.md), [npm registry](https://registry.npmjs.org/valhalla-wasm)
- @jansoft/mbujkanji-valhalla-wasm 0.1.2 (2026-04-25; repo has 3 stars) declares about 70 runtime dependencies in package.json, including next, react, radix-ui, mapbox-gl and playwright — [npm registry](https://registry.npmjs.org/@jansoft/mbujkanji-valhalla-wasm)
- OSRM: web and npm searches turned up only the native Node binding (`@project-osrm/osrm` 26.9.0, 2026-09-01) and REST clients, no WASM build — [npm search](https://registry.npmjs.org/-/v1/search?text=osrm%20wasm), [osrm.js](https://github.com/Project-OSRM/osrm.js)
- Engine repo activity for context: valhalla/valhalla has 6,250 stars (pushed 2026-09-23); Project-OSRM/osrm-backend 8,105 (2026-09-13); abrensch/brouter 722 (2026-09-09); easbar/fast_paths (Rust contraction hierarchies) 296 stars, last push 2024-05-07 — [GitHub API](https://api.github.com/repos/valhalla/valhalla)

### Inferences
- For a per-fire graph of 10k–200k edges, the routing kernel is cheap enough that library choice is about dependencies and data model, not speed. A hand-rolled CSR A* matches or beats what the ngraph.path README reports on a larger graph (their NYC graph is about 4× bigger than my 188k-edge synthetic graph). I did not benchmark the libraries head to head.
- The hand-rolled route also fits the owner's minimal-dependency preference. Typed arrays load straight from a binary file, transfer to a worker without copying, and fit the anisotropic-cost and hybrid-raster work in Q2. ngraph.graph and graphology store nodes and links as JS objects, so memory and startup are heavier (not measured here).
- geojson-path-finder's forward/backward weights fit Tobler-style uphill/downhill costs. However, it requires endpoints to be graph vertices, snaps by coordinate tolerance at runtime, and builds from GeoJSON (1.3 MB gzipped for the Park Fire area vs 365 KB for a compact binary; see Q3). The app would still need its own snapping and off-network legs.
- Valhalla-WASM would buy real pedestrian costing, turn-by-turn text and an engine the team already uses as a fallback, at a cost of about 2 MB gzipped WASM, a Docker-built tile tar, and worker/CSP complexity. Both browser builds are brand new (June and September 2026) with one or four npm releases, so they are not proven. Neither does off-network or raster legs, so a custom raster router would be needed anyway. Precedent exists for offline OPFS tile reading (ecc521/rivers.run).

### Gaps
- No head-to-head benchmark of ngraph.path, geojson-path-finder or graphology against the hand-rolled core on the same graph. I did not download and run third-party packages, and the ngraph.path README does not state its machine.
- No mobile-device timings. How much slower phones are than the M5 Pro desktop was not measured.
- No WASM builds of GraphHopper (Java), RoutingKit or BRouter surfaced. No production users of valhalla-browser were found beyond its demo, and rivers.run for ecc521's build was not independently checked.
- Not verified: contraction-hierarchy-js's README claims (building and serializing contraction hierarchies in JS), whether route-snapper supports freehand segments, and whether A/B Street uses fast_paths in WASM.

## Q2. Raster least-cost paths in the browser (1–4M cells, 8 vs 16 neighbours, anisotropic slope, any-angle) and hybrid network+raster graphs

### Takeaway
Hand-rolled A* over typed arrays with anisotropic Tobler pace times a vegetation friction multiplier is fast enough in a Web Worker for realistic off-trail legs. On 4M cells at 30 m on the desktop test machine, a 5 km leg took about 6 ms (A*8) and a 15 km leg about 50–80 ms. A pathological about-80 km corner-to-corner search took 0.7–1.2 s, about 0.23 s with weighted A*. Array memory was about 73 MB. The 16-neighbour search costs 1.4–1.6× the time of 8-neighbour for a 2–4% cheaper path, in line with the literature's worst-case elongation (8.2% for 8 neighbours vs 2.8% for 16). A cheap cost-aware "string-pulling" pass removes most zig-zag vertices in about 1 ms. Hybrids are easy: sparse "portal" trail edges on top of the grid ran in the same time as the pure grid, and the literature (2026) supports network+terrain graphs that allow transitions anywhere along an edge.

### Cited Findings
- Goodchild's worst-case elongation on a uniform-cost raster is 41.4% for 4 neighbours (rook), 8.2% for 8 (queen) and 2.79% for 16 (knight) — [PLOS One, "Effects of raster terrain representation on GIS shortest path analysis" (2021)](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0250106) (via search snippet; Goodchild's original is from 1977)
- Herzog (Internet Archaeology 36, about 2013):
  - Queen-only moves have worst-case elongation of about 8% and worst-case distance of about 20% of path length. Adding knight moves gives 2.8% and 11%; adding A/B moves (24 neighbours) gives 1.4% and 4.6%.
  - "Knight's, A- or B-moves may skip over small local barriers unnoticed", so subdivide long moves.
  - Many packages backtrack with "drainage algorithms which does not necessarily track the back-links", and paths can get "trapped in localised plateaux or pits".
  - Work in a projected coordinate system, not lat/lon. Most LCP software supports only queen moves; GRASS has a knight's-move option.
  - Source: [Herzog, LCP algorithms](https://intarch.ac.uk/journal/issue36/5/3.html)
- **GRASS r.walk** (manual version 8.5.1dev):
  - Anisotropic Aitken/Langmuir time model: T = a·ΔS + b·ΔH_uphill + c·ΔH_moderate_downhill + d·ΔH_steep_downhill. Defaults are a,b,c,d = 0.72, 6.0, 1.9998, −1.9998 and slope_factor = −0.2125 (tan −12°).
  - Total cost = movement time + lambda·friction·ΔS; friction is a time penalty in s/m.
  - `-k` adds knight's moves "at the cost of increased computation time". Paths are traced with `r.path` from the direction output. Default memory is 300 MB; the algorithm is Dijkstra.
  - Source: [r.walk manual](https://grass.osgeo.org/grass-stable/manuals/r.walk.html)
- **scikit-image 0.26.0 `skimage.graph`**:
  - `MCP_Geometric` weights diagonal moves by √2 split between the two cells (cost (√2/2)·c[a] + (√2/2)·c[b]). `offsets` allow custom neighbourhoods such as knight moves, and `sampling` handles anisotropic pixel spacing.
  - `MCP_Flexible` lets you override `travel_cost()`/`examine_neighbor()` in Python, which allows direction-dependent (uphill vs downhill) costs.
  - `route_through_array` is the simple helper; `MCP_Connect` handles multi-source searches.
  - Source: [skimage.graph API](https://scikit-image.org/docs/stable/api/skimage.graph.html)
- **WhiteboxTools**:
  - `CostDistance` takes a source raster and a cost (friction) raster and outputs an accumulated-cost raster plus a back-link raster "conceptually similar to the D8 flow-direction pointer". `CostPathway` traces least-cost paths from destination cells using the back-link.
  - The cost raster is built with a raster calculator or `WeightedOverlay`, so costs are isotropic per cell.
  - Sources: [whiteboxR cost_distance docs](https://whiteboxr.gishub.org/reference/wbt_cost_distance.html), [WhiteboxTools manual (search snippet; the manual page returned 404 when fetched)](https://www.whiteboxgeo.com/manual/wbt_book/available_tools/gis_analysis_distance_tools.html)
- Python packaging: whitebox 2.3.6 (PyPI, 2025-02-23) and whitebox-workflows 2.0.6 (2026-06-14) — [PyPI whitebox](https://pypi.org/project/whitebox/), [PyPI whitebox-workflows](https://pypi.org/project/whitebox-workflows/)
- **Theta*** (Daniel, Nash, Koenig, Felner, JAIR vol. 39, 2010) propagates information along grid edges without constraining paths to grid edges. It finds shorter paths than A* with post-smoothing and Field D*, "with a runtime comparable to that of A* on grids", but is not guaranteed to find true shortest paths. Angle-Propagation Theta* has better worst-case complexity but is slower in practice — [arXiv 1401.3843](https://arxiv.org/abs/1401.3843), [JAIR](https://jair.org/index.php/jair/article/view/10676)
- A 2026 arXiv paper (2607.00065) compared online grid planners A*, Theta*, Anya and its Zeta* variants, all implemented in JavaScript on Node.js v22.19.0. That shows JS any-angle implementations exist, but I did not extract its numbers — [arXiv 2607.00065](https://arxiv.org/pdf/2607.00065)
- **Hybrid network+terrain precedent** (Zaslavskaya & Karpachevskiy 2026, GES journal):
  - Walking routes combine a vector road network with raster terrain. Instead of burning roads into a cost surface, a "hierarchy of network edges" allows transitions between roads and terrain "at any point along an edge, rather than just at vertices".
  - Walking speed by land cover ranged 1.84–4.21 km/h. They used the Tobler function with maximum speed at −2.86°, plus weather coefficients.
  - Tools: ArcGIS Pro, 5 m DEM. A square grid with queen adjacency proved the best trade-off.
  - Source: [Geography, Environment, Sustainability article](https://ges.rgo.ru/jour/article/view/4624)
- **Wildland-firefighter travel-rate research** usable for friction:
  - Campbell, Dennison & Butler 2017 (IJWF 26(10):884–895) timed walkers against LiDAR-derived slope, vegetation density and ground roughness for escape-route mapping — [IJWF doi:10.1071/WF17031](https://doi.org/10.1071/WF17031), [FRAMES](https://www.frames.gov/catalog/55603)
  - Sullivan et al. 2020 ("Modeling wildland firefighter travel rates by terrain slope: results from GPS-tracking of Type 1 crew movement", Fire 3(3):52) — [USFS PDF](https://www.fs.usda.gov/rm/pubs_journals/2020/rmrs_2020_sullivan_p001.pdf) (title and venue only, not read in detail)

**Raster benchmark setup** (local benchmark, [bench.mjs](file://(local scratch, not included)/bench/bench.mjs)):
- Terrain is a synthetic fBm DEM with 30 m cells and mean slope about 30%.
- Friction multipliers: open 1.67 (Tobler's 0.6 off-path factor), timber 2.0, shrub 3.0, heavy brush 5.0, trail 1.0, and about 3% impassable barrier cells.
- Moves steeper than 45° are impassable. Knight moves also check the two cells they cut across, which addresses Herzog's barrier-skipping issue.
- Edge cost is distance × Tobler pace, where pace = exp(3.5·|s+0.05|)/1.667 s/m, times the mean friction. The A* heuristic is straight-line distance × minimum pace (admissible).

**Results on 2000×2000 (4M cells, 60 km square)**, median of 5 random pairs per distance unless noted:
- 1.5 km: A*8 1.7 ms, A*16 2.5 ms.
- 5 km: A*8 5.8 ms (max 20 ms), A*16 8.3 ms (max 31 ms), Dijkstra 15 ms.
- 15 km: A*8 51 ms (max 85 ms), A*16 80 ms (max 129 ms), Dijkstra 230 ms.
- About 80 km corner to corner (single run): A*8 742 ms, A*16 1,167 ms, Dijkstra 771 ms (A* expanded 3.39M of 4M cells). Weighted A* (w=2) took 230 ms for a path 3.7% more costly.

**Results on 1000×1000 (1M cells, 30 km square)**:
- 5 km: A*8 5.3 ms. 15 km: A*8 50 ms.
- About 40 km diagonal: A*8 145 ms, A*16 233 ms. Weighted A* (w=2) took 25 ms for a path 7.2% more costly.

**8 vs 16 neighbours** (same pairs, 2000² run): the 16-neighbour path cost 0.961–0.982× the 8-neighbour cost and was 0.970–0.987× the length. It took about 1.4–1.6× the time and needed about 2× the heap size.

**Cost-aware post-smoothing**: a greedy line-of-sight pass keeps each straight shortcut only if its sampled anisotropic cost is no higher than the path's cost over that stretch.
- Runtime 0.3–2 ms per path.
- Path cost fell about 1% (0.987–0.992×) and length 3–5% (0.952–0.971×).
- Vertices dropped from 165 to 29 on a 5 km path and from 509 to 96 on a 15 km path.
- Turn counts before smoothing were 51 (8-neighbour) vs 65 (16-neighbour) on 5 km paths, so 16 neighbours do not reduce vertex zig-zag by themselves.

**Hybrid grid + trail portals**: the real Park Fire OSM graph (see Q3) was placed on the synthetic terrain as 55,246 directed "portal" edges, each costed with anisotropic Tobler at trail friction 1.0.
- Timings were the same order as the pure grid: 15 km 76 ms (A*8, versus 51 ms pure) and diagonal 842 ms. More nodes are expanded because trails weaken the heuristic.
- 42–64% of the path length ran on trails for 15 km and longer queries.
- Modeled travel time fell 17–18%, for example from 3,097 to 2,536 minutes on the diagonal.

**Memory at 4M cells**: 73 MB of ArrayBuffers and 228 MB process RSS. The arrays were a Float32 DEM, a Uint8 class grid, Float32 g-scores, Int32 parents, a Uint8 closed set, Int32 portal offsets and the heap. At 1M cells: 23 MB ArrayBuffers, 131 MB RSS.

### Inferences
- Realistic off-trail legs are about 5 km or less on a per-fire raster of about 2.8M cells (50 km at 30 m). Those should come back in tens of ms on the desktop test machine; I did not measure phones. Full-extent searches can take about a second there, so run in a Worker, cap the search radius or use a bounding window, and consider weighted A* (w≈1.2–2) with a label such as "near-optimal".
- A small index can replace the 16 MB portal-offset array, and 8-bit direction codes can replace Int32 parents. DEM as Int16 plus parents as Uint8 would bring 4M-cell working memory to about 40 MB. That is inferred from array sizes, not measured.
- Reasonable default: 8-neighbour A* plus cost-aware smoothing. 16-neighbour A* gives about 2–4% better costs, but its paths still zig-zag between vertices, while smoothing gives nicer display geometry. True any-angle search (Theta*) costs about the same as A* per the JAIR paper, but I did not find a maintained npm package.
- Hybrid design choices:
  - (a) Burn trails into the friction raster. This is simplest and supports r.walk/scikit-image validation directly (set r.walk friction to 0 on trails and above 0 off-trail), but loses sub-cell trail geometry and adds stair-stepping.
  - (b) Grid plus sparse portal edges, as benchmarked. This keeps exact trail geometry and anisotropic costs.
  - (c) Densify trail edges to about 30 m so crews can leave or join trails mid-edge, as the 2026 paper recommends. Option (b) with (c) is still small, since there are about 223k trail/road vertices in the Park Fire area.
- For server-side validation in the Python worker, scikit-image `MCP_Geometric` with knight-move `offsets` is the most pip-friendly. Anisotropic Tobler needs either `MCP_Flexible` (per-node Python callbacks, likely slow on 2.8M cells) or GRASS r.walk. r.walk's Langmuir model differs from Tobler, so validation compares shapes, not identical costs.

### Gaps
- No published JS/WASM timings for raster least-cost paths at 1–4M cells were found; the numbers above are from my own desktop-only run.
- I did not implement or benchmark Theta* or Field D*, only A* with post-smoothing.
- No wildfire-specific tool was found that ships hybrid trail+raster routing to browsers. Escape-route research (Campbell et al.) is GIS/desktop-based, and its implementations were not examined.
- The synthetic terrain and vegetation are not real LANDFIRE/DEM data. Path-quality comparisons, for example 16 vs 8 neighbours, may differ on real rasters.

## Q3. Python/worker preprocessing: extracting OSM and federal trails, noding and topology cleanup, compact graph format, cost raster, server-side LCP tools, and typical sizes

### Takeaway
All pieces exist as pip or apt tools that work on Python 3.12 and GDAL 3.8. The best OSM path is osmium or pyosmium, or pyrosm, reading a Geofabrik PBF. These keep node IDs, so ways can be split exactly at shared nodes; GDAL's OSM driver and shapely noding cannot do that. Overture's `overturemaps` CLI gives bbox GeoParquet with explicit connectors. Federal trails such as USFS TrailNFS_Publish need snapping and noding with shapely or momepy/neatnet.

I measured a real 50×50 km WUI area around the 2024 Park Fire, near Chico, CA: 16.7k OSM highway ways became 27k nodes and 36k edges with 223k vertices. That encodes to 365 KB gzipped as a compact varint binary (107 KB gzipped for topology only), versus 1.3 MB gzipped as GeoJSON. A 30 m cost raster for 50×50 km is 2.78M cells, 2.78 MB raw as uint8.

### Cited Findings
**Extraction tools** (versions from PyPI, 2026-09-24):
- **osmium** (pyosmium) 4.3.1, 2026-04-02, wheels cp38–cp314 — [PyPI osmium](https://pypi.org/project/osmium/)
- `osmium tags-filter` selects ways by tag, for example `w/highway=primary`, with comma-separated values. Referenced nodes are included by default. `-R/--omit-referenced` reads the input once instead of up to three times. The tool "does all its work on the fly and only keeps tables of object IDs it needs in main memory" — [osmium tags-filter manual](https://docs.osmcode.org/osmium/latest/osmium-tags-filter.html)
- **pyrosm** 0.13.1 (2026-08-02) has wheels for cp310–cp314, so Python 3.12 is fine.
  - It reads `*.osm.pbf` into GeoDataFrames. Network types: driving, cycling, walking, all. It filters by bounding box, outputs nodes and edges, and exports "as a directed graph to igraph, networkx and pandarm".
  - It is mainly Cython using protobuf's upb backend, and recent versions have an opt-in out-of-core streaming engine.
  - "OSMnx reads the data over internet using OverPass API, whereas pyrosm reads the data from local OSM data dumps."
  - Sources: [PyPI pyrosm](https://pypi.org/project/pyrosm/), [pyrosm GitHub](https://github.com/pyrosm/pyrosm)
- **osmnx** 2.1.1 (2026-07-21) requires Python ≥3.11.
  - `graph_from_bbox` takes `(left, bottom, right, top)`. `network_type` is one of all, all_public, bike, drive, drive_service, walk; walk is bidirectional. `custom_filter` takes Overpass QL.
  - Downloads come from the Overpass API. `graph_from_xml` reads OSM XML, not PBF. `simplify=True` by default.
  - Sources: [OSMnx user reference](https://osmnx.readthedocs.io/en/stable/user-reference.html), [PyPI osmnx](https://pypi.org/project/osmnx/)
- **GDAL OSM driver**:
  - Output layers: points, lines, multilinestrings, multipolygons, other_relations. `osmconf.ini` chooses which keys become fields; unlisted tags go to `other_tags` as HSTORE, or as JSON since GDAL 3.7 via `TAGS_FORMAT=JSON`.
  - `OSM_MAX_TMPFILE_SIZE` defaults to 100 MB before spilling to disk; use `OGR_INTERLEAVED_READING=YES` for large files.
  - "A spatial filter applied on the points layer will also affect other layers", which can drop vertices. The docs do not say that lines are split at intersections.
  - Source: [GDAL OSM driver](https://gdal.org/en/stable/drivers/vector/osm.html)
- **overturemaps CLI** 1.0.2 (2026-08-25): `overturemaps download --bbox=W,S,E,N -f geoparquet --type=segment` (also `--type=connector`); output formats geojson, geojsonseq, geoparquet — [PyPI overturemaps](https://pypi.org/project/overturemaps/), [Overture Python client docs](https://docs.overturemaps.org/getting-data/overturemaps-py/)
- **Overture transportation model**:
  - Segments are "not split at every connector". Connectors can sit mid-segment through linear referencing, so properties can "apply to just part of a segment ... without chopping the geometry in two". A routable graph therefore needs splitting at connector positions; an optional transportation-splitter tool exists.
  - Hiking-relevant classes: footway (17.9M segments), path (14.4M), track (26.6M), steps (2.1M), bridleway (103,867).
  - Sources: OSM, "enhanced with commercial road data from TomTom", plus authoritative sources. Released monthly.
  - Source: [Overture transportation guide](https://docs.overturemaps.org/guides/transportation/)
- **Federal trails**:
  - USFS National Forest System Trails (TrailNFS_Publish) are published by the FSGeodata Clearinghouse as shapefile and file geodatabase, plus a map service (`EDW/EDW_TrailNFSPublish_01/MapServer`). Attribute subsets: TRAILNFS_CENTERLINE (location, name, number), TRAILNFS_BASIC (characteristics) and TRAILNFS_MGMT (allowed, prohibited and encouraged uses by season).
  - Sources: [FSGeodata datasets](https://data.fs.usda.gov/geodata/edw/datasets.php?xmlKeyword=trailnfs), [ArcGIS MapServer](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer), [data.gov](https://catalog.data.gov/dataset/national-forest-system-trails-feature-layer)

**Noding and topology cleanup:**
- `shapely.node()` returns "the fully noded version of the linear input as MultiLineString". It adds all segment intersections so lines touch only at endpoints. Shapely 2.1.2 is current — [shapely.node docs](https://shapely.readthedocs.io/en/stable/reference/shapely.node.html), [PyPI shapely](https://pypi.org/project/shapely/)
- momepy offers `close_gaps` (snaps nearby endpoints to their midpoint), `extend_lines` (extends dangling ends to meet other lines) and `remove_false_nodes`. The last is deprecated and moved to the `neatnet` package as `neatnet.remove_interstitial_nodes`. momepy 1.0.0 (2026-07-02) requires Python ≥3.12 — [momepy preprocessing docs](https://docs.momepy.org/en/stable/user_guide/preprocessing/simple_preprocessing.html), [remove_false_nodes](http://docs.momepy.org/en/stable/api/momepy.remove_false_nodes.html), [PyPI momepy](https://pypi.org/project/momepy/)

**Cost raster inputs:**
- LANDFIRE Product Service (LFPS) takes an area of interest and layer list through a REST API (`lfps.usgs.gov/api/job/submit` with `Layer_List`, `Area_of_Interest`, `Email`). It returns a zip holding one multiband GeoTIFF; the R package `rlandfire` wraps it — [LFPS task](https://lfps.usgs.gov/arcgis/rest/services/LandfireProductService/GPServer/LandfireProductService), [LFPS user guide](https://lfps.usgs.gov/LFProductsServiceUserGuide.pdf), [rlandfire vignette](https://cran.r-project.org/web/packages/rlandfire/vignettes/rlandfire.html)
- Server-side LCP tools for validation (GRASS r.walk/r.cost + r.path, scikit-image MCP, WhiteboxTools CostDistance/CostPathway) are covered in Q2. GRASS r.walk takes the DEM plus a friction raster directly — [r.walk](https://grass.osgeo.org/grass-stable/manuals/r.walk.html)

**Measured OSM sizes, Park Fire 50×50 km** (bbox S 39.724, W −122.043, N 40.176, E −121.457; foothill forest plus the Chico WUI edge). Local script: [osm_graph_sizes.py](file://(local scratch, not included)/osm_graph_sizes.py), data via the [Overpass API](https://overpass-api.de/api/interpreter).
- **Raw pull:** 16,657 `highway=*` ways, a 21.7 MB Overpass JSON fetched in 11 s. Top tags: service 5,411, residential 4,455, footway 3,870, track 803, path 528, tertiary 376, cycleway 348, secondary 250.
- **Walkable subset:** 16,501 ways after excluding motorways and construction. By group: 10,900 road, 803 track, 4,798 trail-like ways (path, footway, bridleway, steps, cycleway, pedestrian). Lengths: 2,985 km road, 1,119 km track, 636 km trail.
- **Graph after splitting ways at shared OSM nodes:** 27,263 nodes, 35,855 edges and 222,708 geometry vertices. It has 48 connected components; the largest holds 26,948 nodes.
- **Compact varint encoding:** local coordinates quantized to 1 m, Morton-sorted nodes, delta and zigzag varints.
  - Node table: 70 KB.
  - Topology with a class byte: 182 KB raw, 107 KB gzip.
  - Full graph with edge geometry: 529 KB raw, 365 KB gzip, 340 KB xz.
  - The same edges as GeoJSON (6-decimal coordinates): 8.68 MB raw, 1.32 MB gzip.
- The simpler typed-array file used for the JS benchmark (Float32 node coordinates, Uint32 edge endpoints, Float32 lengths, class byte, no geometry) was 684 KB raw — [graph_park_fire_ca.bin](file://(local scratch, not included)/graph_park_fire_ca.bin)
- **Raster arithmetic:** 50 km / 30 m = 1,667 cells per side, 2.78M cells. That is 2.78 MB raw as a uint8 cost/class grid and 5.56 MB raw as an Int16 DEM (arithmetic, not a measured file size).
- **Pack budget comparison:** the current offline pack estimates are 3.4 MB per ToA GeoTIFF, 1.2 MB per perimeter and 70 KB per map tile (`frontend/src/offline/packModel.ts`, EST constants).

### Inferences
- OSM shared nodes are the true topology. Splitting ways where a node ID appears in 2 or more ways, or is a way endpoint, is exact. It avoids false junctions at bridges and tunnels, which purely geometric noding (`shapely.node`, `unary_union`) would create wherever lines cross.
- GDAL's `lines` layer drops node IDs, so ogr2ogr alone cannot split at shared nodes; it could only node geometrically. Prefer pyosmium/osmium or pyrosm for OSM, and use GDAL/ogr2ogr to clip, reproject and convert the federal shapefiles.
- Federal trails such as USFS lack shared node IDs, so they need three steps:
  1. Snap endpoints within a few metres (momepy/neatnet or custom STRtree logic).
  2. Node them against each other.
  3. Conflate them to OSM, adding USFS-only trails and attaching endpoints to the nearest OSM node or edge within a tolerance.
- Overture segments need splitting at connector `at` positions before routing.
- A compact binary graph plus one Uint8 cost/class raster plus an Int16 DEM for a fire area would add roughly 0.4 MB (graph) plus a few MB (rasters) to the pack. That is the same order as one ToA GeoTIFF, so it fits the existing pack model. Raster compression was not measured.
- Serve binaries pre-gzipped and decode with `DecompressionStream('gzip')` in the worker (see Q4). Whether B2 serves a `Content-Encoding` header needs checking (see Gaps).
- Suggested worker pipeline: Geofabrik state PBF (or Overpass for the bbox) → `osmium extract --bbox` + `osmium tags-filter w/highway` → pyosmium split at shared nodes → merge USFS trails (ogr2ogr clip, snap, node) → compute per-edge length, class and elevation gain from the DEM → write the varint/typed-array binary. For the raster: `gdalwarp` the DEM and LANDFIRE layers to a common 30 m UTM grid → numpy friction lookup (optionally `gdaldem slope`) → Uint8 class grid, with an Int16 DEM kept for runtime anisotropic slopes. Validate sample routes with scikit-image MCP or GRASS r.walk.

### Gaps
- The Stanley, ID (remote Sawtooth) and Beachie Creek, OR (west Cascades forest roads) measurements failed. All three Overpass mirrors returned HTTP 504 repeatedly during the session. Edge counts for a remote wilderness area therefore remain unmeasured. The one area measured includes Chico's urban edge, so it is likely at the high end for roads; a remote area likely has fewer roads but a similar share of trails and tracks.
- I did not measure how well a real 30 m LANDFIRE/DEM GeoTIFF compresses (COG with DEFLATE or ZSTD), or LFPS job turnaround and whether it can be scripted from a cron.
- USFS TrailNFS national download size and its positional agreement with OSM trails were not checked. BLM GTLF and USGS National Digital Trails availability were not researched.
- `osmium extract --bbox/--strategy` syntax was not confirmed from its own manual page; the fetched page covered only tags-filter.
- I did not confirm whether Backblaze B2 can serve a `Content-Encoding: gzip` header for pre-compressed objects.

## Q4. Reading elevation in the browser: terrarium PNG decoding, zoom vs ground resolution, and MapLibre v5 `queryTerrainElevation` limits

### Takeaway
Decode terrarium as elevation = (R·256 + G + B/256) − 32768 m. AWS terrain tiles in the US come from 3DEP 1/3″ (about 10 m) and 1/9″ (about 3 m) data at z10–15. At 40°N a 256-px tile gives about 29 m/px at z12, a good match for a 30 m cost raster; a 50×50 km fire costs about 6.8 MB of z12 PNGs (measured). Don't use `map.queryTerrainElevation` for route profiles. It depends on the viewport, returns 0 (not null) where no DEM tile is loaded, and multiplies by terrain exaggeration. Sample a DEM you decode yourself in the worker, or use a DEM raster from the pack.

### Cited Findings
- Terrarium decode is `(red * 256 + green + blue / 256) - 32768`: 16 bits of integer plus 8 bits of fraction, so blue steps are 1/256 m. Tiles come in 256, 260, 512 and 516 px. The range is about −11,000 to 8,900 m — [tilezen/joerd formats](https://github.com/tilezen/joerd/blob/master/docs/formats.md)
- US sources: SRTM from z7, and NED/3DEP 1/3 arc-second (about 10 m) and 1/9 arc-second (about 3 m) at z10–15. Maximum zoom is 15. Ground resolution at the equator is 152.9 m/px at z10 and 4.8 m/px at z15 — [joerd data sources](https://github.com/tilezen/joerd/blob/master/docs/data-sources.md)
- Measured with HEAD requests to `s3.amazonaws.com/elevation-tiles-prod/terrarium` over the Park Fire 50×50 km bbox (about 40°N), for 256-px tiles:
  - z11: 20 tiles, average 127 KB, about 2.5 MB total, 58.6 m/px.
  - z12: 56 tiles, average 122 KB, about 6.8 MB total, 29.3 m/px.
  - z13: 210 tiles (70 sampled), average 110 KB, about 23 MB total, 14.6 m/px.
  - Ground resolution is 156,543·cos(lat)/2^z.
  - Source: [local HEAD-request script](file://(local scratch, not included)/), [AWS terrain tiles bucket](https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/674/1546.png)
- **MapLibre `queryTerrainElevation`**:
  - The doc comment says it "Gets the elevation at a given location, in meters above sea level. Returns null if terrain is not enabled. If terrain is enabled with some exaggeration value, the value returned here will be reflective of (multiplied by) that exaggeration value", and is meant for positioning custom 3D objects — [maplibre-gl-js src/ui/map.ts](https://github.com/maplibre/maplibre-gl-js/blob/main/src/ui/map.ts)
  - In v5.24.0, the version installed in the repo (package.json has `^5.0.0`), `getElevationForLngLat` takes the highest zoom among the tiles covering the current viewport and samples that tile. Its doc says it "will traverse up the zoom levels to find the first tile with data".
  - `getDEMElevation` returns `0` when the tile ID can't be normalized or no DEM is loaded (`if (!dem) return 0;`), and interpolates bilinearly otherwise. The result is multiplied by `exaggeration`.
  - Source: [terrain.ts at v5.24.0](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/render/terrain.ts)
  - The main branch (MapLibre v6.x; latest release v6.11.2 on 2026-09-24) adds a coverage index that samples the rendered surface "where the location is covered by a rendered tile with loaded DEM data" before falling back — [terrain.ts main](https://github.com/maplibre/maplibre-gl-js/blob/main/src/render/terrain.ts), [releases](https://github.com/maplibre/maplibre-gl-js/releases)
- `createImageBitmap` has `colorSpaceConversion: 'none'` and `premultiplyAlpha: 'none'` options. Standards issues and browser bugs describe inconsistent behaviour, for example Firefox producing incorrect pixels with premultiply and ImageData — [MDN createImageBitmap](https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap), [whatwg/html #10142](https://github.com/whatwg/html/issues/10142), [whatwg/html #11029](https://github.com/whatwg/html/issues/11029), [Mozilla bug 1756803](https://bugzilla.mozilla.org/show_bug.cgi?id=1756803), [WebKit bug 237082](https://bugs.webkit.org/show_bug.cgi?id=237082)
- `DecompressionStream` (gzip and others) is Baseline "widely available" since May 2023 and works in Web Workers — [MDN DecompressionStream](https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream)

### Inferences
- For elevation profiles and anisotropic costs, sample a DEM you control:
  - (a) The pack's Int16 DEM raster, which the cost raster needs anyway.
  - (b) Terrarium tiles fetched at a fixed zoom (z12, about 29 m, or z13, about 15 m) and decoded in the worker with `createImageBitmap(blob, {colorSpaceConversion:'none', premultiplyAlpha:'none'})` plus `OffscreenCanvas.getContext('2d').getImageData`. Terrarium PNGs are opaque, so premultiplication should not change values, but colour conversion could. Validate a few known points against a GDAL-decoded tile.
- `queryTerrainElevation` returns 0 on unloaded tiles and is scaled by exaggeration. Off-screen parts of a route, or areas of lower zoom than the viewport, would silently get wrong or zero elevations. If the app ever uses it, divide by `map.getTerrain()?.exaggeration` and treat 0 as missing. It is unusable in an offline worker, which has no map.
- Offline, the z12 terrarium tiles for a fire (about 6.8 MB for 50×50 km) are comparable to one or two existing pack items. The 3D terrain view would reuse them, so a single DEM source can serve both display and routing.

### Gaps
- I did not verify whether Safari's canvas or ImageBitmap decoding alters terrarium RGB values in practice (no device test).
- I did not check how MapLibre v5 itself decodes raster-dem tiles (worker `getImageData` path) or whether its DEM can be read back from the style.
- `queryTerrainElevation` behaviour across the other v5.x minors (5.0–5.23) was not diffed; only v5.24.0 and main were read.

## Q5. UX precedent: showing snap-to-trail vs straight/off-trail segments (CalTopo, Gaia GPS, onX Backcountry, FarOut, AllTrails, Komoot, brouter-web)

### Takeaway
In every product reviewed, off-network travel is a user-drawn straight segment made with a mode toggle ("Straight Line", "Point Draw", "Follow ways" off, "Snap to paths" off, a beeline B-key). None generates terrain-aware off-trail paths. Komoot draws off-grid sections dotted and warns that it cannot guarantee passability; others mostly show the same line with distance, elevation and time totals. Time estimates are rule-of-thumb: CalTopo uses the Munter method, and brouter-web shows travel-time and energy stats. A modeled cross-country leg would therefore be new in this category. It needs clear visual distinction (dashed or dotted) and explicit uncertainty wording.

### Cited Findings
- **CalTopo**:
  - Snap To traces OSM, USFS, hydro (rivers and streams) or existing drawn lines. Snappable features are highlighted yellow, and a Snap To dropdown switches the target mid-draw. It also works with the measure tool — [CalTopo training: lines & polygons](https://training.caltopo.com/all_users/objects/lines-and-polys), [CalTopo blog July 2025](https://blog.caltopo.com/2025/07/16/new-feature-snap-to-on-mobile/)
  - Mobile Snap To (app 1.20.1+) "works on your mobile device with a data connection"; offline support is promised "in future app updates" (July 2025) — [CalTopo blog](https://blog.caltopo.com/2025/07/16/new-feature-snap-to-on-mobile/)
  - Travel Time uses the "Munter Method", which considers distance, elevation gain and loss, and travel mode. Travel Plan (Pro+) produces per-leg tables with elevation, gain/loss, bearing and time. A commentator's caveat: "This is a baseline for general trip planning, not the Holy Grail" — [Alpinesavvy, 2021-02-04](https://www.alpinesavvy.com/blog/caltopo-pro-tip-travel-time-travel-plan)
- **Gaia GPS**:
  - Snap-to-Trail uses OSM. Straight Line mode turns snapping off, and the mode can be switched at any time while plotting to mix segments. Clicking near a trail in Snap mode adds a short straight out-and-back to the trail; clicking far enough away drops free points — [Gaia help: Create and Measure Routes](https://help.gaiagps.com/hc/en-us/articles/115003640568-Create-and-Measure-Routes-on-gaiagps-com), [community: Straight and Trail Follow in one route](https://help.gaiagps.com/hc/en-us/community/posts/4408935436695-Straight-and-Trail-Follow-in-one-route-line) (via search snippets; help pages are behind a Cloudflare challenge)
  - Offline snap-to-trail routing launched 2021-08-05. It needs the map plus "route data" downloaded ahead of time, downloaded by default with new maps, and requires Premium — [Gaia blog](https://blog.gaiagps.com/offline-snap-to-trail-route-planning/)
- **onX Backcountry**: Route Builder launched 2023-04-28. It snaps across "more than 650,000 miles" of trails and shows distance and elevation gain/loss, with offline maps — [onX blog](https://www.onxmaps.com/blog/onx-backcountry-unveils-route-builder-tool). Help centre (via search snippet): if Snap To fails because of "a gap in the underlying routing graph", switch to Point Draw and drop points manually, then switch back — [onX help](https://onxbackcountry.zendesk.com/hc/en-us/articles/360052210091-Using-Map-Tools). The line style for point-draw segments was not documented in the sources found.
- **Komoot**: off-grid planning means unchecking "Follow ways" on a waypoint, or Alt+click, which draws a straight line to that waypoint until you revert. Off-grid sections render as a dotted line instead of the normal solid blue (search snippet). Disclaimers: navigation "might not be as accurate", and komoot "cannot guarantee that your route is passable" — [komoot: Advanced route planning](https://support.komoot.com/hc/en-us/articles/360024733651-Off-grid-Tour-planning-outside-of-komoot-s-routing-network) (via search snippets; page behind Cloudflare)
- **AllTrails**: Custom Routes (Peak membership, $79.99/yr) route "along existing OpenStreetMap paths with confirmed foot traffic", optimizing for shorter, less elevation gain or scenic. Turning off the "Snap to paths" toggle makes clicks create straight lines; Shift-drag draws freehand — [AllTrails help](https://support.alltrails.com/hc/en-us/articles/37270479773204-How-to-create-custom-routes), [Tom's Guide review](https://www.tomsguide.com/wellness/fitness/i-tried-alltrails-new-custom-routes-tool-and-its-a-game-changer-for-hikers-bikers-and-runners) (via search snippets)
- **FarOut**: custom routes follow paths in the downloaded map, taking the shortest path between long-pressed points, with an elevation profile. Off-trail, distances to waypoints show as "x miles from you" (straight line) instead of "x miles ahead/behind" along the trail — [FarOut: custom routes](https://faroutguides.com/how-i-use-custom-routes-to-make-thru-hiking-easier/), [FarOut tips](https://faroutguides.com/11-quick-tips-tricks-for-your-farout-app/)
- **brouter-web**:
  - Release history: incline colouring of route segments (v0.11.0, 2020), always-on travel time and energy stats (v0.12.0, 2020), and a Heightgraph elevation profile coloured by incline (v0.15.0, 2021) — [CHANGELOG](https://github.com/nrenner/brouter-web/blob/master/CHANGELOG.md)
  - v0.17.0 (2022-06-08) added "Allow straight lines": a toggle button (B key) or Shift+click draws "as the crow flies" segments, and existing segments convert to and from straight lines via the edit handle — same [CHANGELOG](https://github.com/nrenner/brouter-web/blob/master/CHANGELOG.md)
  - A dashed line previews from the last waypoint to the cursor (search snippet) — [issue #68](https://github.com/nrenner/brouter-web/issues/68)
  - Repo has 501 stars and was pushed 2026-09-24 — [GitHub API](https://api.github.com/repos/nrenner/brouter-web)

### Inferences
- The products converge on one pattern:
  - A persistent mode toggle (snap vs straight), set per segment and switchable mid-route.
  - A visual distinction for off-network segments; Komoot's dotted line is the only documented example.
  - Totals plus an elevation profile for the whole route.
  - A disclaimer that off-network segments are unverified.
- For Responder Debrief, a modeled cross-country leg is new. Suggestions:
  - Draw it dashed or dotted in a distinct colour, and label it "cross-country (modeled)".
  - Show that leg's time as a range derived from friction or travel-rate uncertainty, not a single number.
  - Colour the elevation profile by on-trail vs off-trail.
  - State the inputs and their age, for example "LANDFIRE 20xx vegetation, 30 m DEM; does not know fire, closures, cliffs < 30 m".
  - Keep a "straight line" fallback so users can override the model.
- The offline precedent (Gaia 2021) supports bundling routing data with the offline map download, which matches the existing "Download this fire" pack.

### Gaps
- The Gaia, Komoot, AllTrails and onX help centres were behind Cloudflare bot checks and could not be fetched, so details come from search-engine snippets. The dotted/dashed styling is confirmed only for Komoot (snippet) and brouter-web's draw preview (snippet).
- No product was found that labels uncertainty on off-trail time estimates, or that auto-generates slope- or vegetation-aware off-trail routes; FATMAP, Outdooractive and Strava were not checked.
- FarOut does not appear to support drawing off-trail segments; not confirmed.
- CalTopo's 2016 auto-routing post and how its Travel Time treats unsnapped segments were not read.
