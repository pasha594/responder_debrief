# Trails overlay + offline off-road Walk: final plan

Written 2026-09-25 by the overnight build session, on `trails-offroad-routing`
(base = `main` at 61413cf). This merges the three designs in `designs/` per
`designs/judges.json` and fixes every must-fix item. Where this file and a design
disagree, this file wins.

## Owner summary (plain language)

**What you get.**
1. A **Trails** toggle in the Layers tab. It draws Forest Service, BLM and Park
   Service trails in teal over any basemap. Tapping a trail shows its name,
   number, agency, class, allowed uses, any official restriction and the date
   of the source data. Offline, the map shows the fire's own copy of the
   trails plus the OpenStreetMap roads and paths around it, because there is
   no basemap offline.
2. **Walk now knows the ground inside each fire's area.** For every active fire,
   biggest first, the worker builds a "routing bundle": a 30 m terrain and
   vegetation grid plus a road and trail network. The phone routes on it with no
   signal. Trail and road parts of the route draw solid blue. Cross-country
   parts draw dashed, colored by what you walk through (grass, brush, timber,
   slash, rock). The card shows a **time range** (slow to fast crew), the trail
   vs cross-country split, the climb, step-by-step text, and always the line
   **"Cross-country legs are modeled, not scouted."**
3. The router **stays out of the latest fire perimeter**, with a 60 m standoff.
   If you are standing inside the perimeter it says so and routes anyway. If
   the only way through is through the fire, it says that and offers to show the
   route through the perimeter as an explicit choice.
4. Outside a fire's routing area, Walk uses today's online engines. Any part the
   online engine can't reach (it snaps to the nearest road or path) is drawn as
   a dotted straight line and is not counted in the time.
5. "Download this fire" also stores the routing bundle and the trails copy
   (about 5 to 15 MB more per fire).

**Calls I made that you may want to revisit** (all listed with reasons in
`STATUS.md`):
- Pace model: GET v2 off-trail (conservative, agency-vetted) with a small
  uphill-vs-downhill correction; Sullivan 2020 loaded-crew rates on trails. The
  headline time is the **slow** end of the range, per IRPG "time it with your
  slowest person".
- Vegetation lifeform comes from LANDFIRE **EVC** (it encodes lifeform and cover
  in one code), with EVT only as a water/snow cross-check. That avoids shipping
  a 1,069-row EVT lookup table I could not download tonight. A later recipe can
  add the EVT table.
- Trails are **off by default** online (USGS Topo already draws trails) and **on
  automatically offline**. Your explicit on/off choice always wins.
- Two new worker dependencies: `numpy` (PyPI, cell math) and `osmium-tool`
  (apt, OSM extracts). One new npm dependency: `pmtiles` (approved).
- No automatic deletion of anything. Old bundles and trail builds accumulate
  until someone runs a manual prune (not written yet; storage is cents/month).

## 1. Decisions

| Topic | Decision | Source |
|---|---|---|
| Base design | **field** for routing, UX and offline | judges |
| National trails | One PMTiles per build, z7–13, two source layers via CONF: `trails_lo` z7–10 (few fields), `trails_hi` z11–13 (all popup fields), both named `trails`. Verified on GDAL 3.8.4 locally. | field + facts |
| Per-fire trails | PMTiles extract z10–14 with layers `trails` and `ways` (OSM roads/tracks/paths), built from the fire's GPKG with ogr2ogr (never by reading the national PMTiles with GDAL 3.8.4). | field |
| Offline trails source | pmtiles `Source` that slices the packed OPFS `File` (owner: "OPFS-backed Source"). Online uses the stock FetchSource on the national archive. The fetch wrapper passes every `Range` request straight to the network. | field |
| Fire list | Our own published `catalogs/catalog.json` (zero fire-API index traffic). Perimeters from `FIRE_API_DEV`, verbatim `path`. | pipeline, must-fix |
| Pointers | All mutable docs under `catalogs/` (existing 60 s rule). Immutable assets under versioned `trails/` and `routing/` prefixes. | pipeline, must-fix |
| Health | Separate single-writer docs `catalogs/health/trails.json` and `catalogs/health/routing.json`. `catalogs/health.json` is not touched. | pipeline, must-fix |
| Bundle id | `sha256(canonical inputs)[:12]` where inputs include AOI-scoped `trails_hash` and `osm_hash`. A refresh that changed nothing inside the AOI keeps the same id and the fire is skipped (the "check" action). | pipeline |
| OSM | Geofabrik leaf-region PBFs (state; CA = norcal/socal) chosen with `index-v1.json` polygons; **apt osmium-tool** `tags-filter` + multi-bbox `extract -c` + `cat -f opl`; stdlib OPL parser. **Never Overpass.** | pipeline, must-fix |
| Conflation | OSM topology is kept exact (node ids). An agency trail covered ≥80% by OSM ways (≤20 m, bearing <35°) donates its name/number/agency/restriction to those OSM edges and is dropped; uncovered agency runs ≥60 m become new edges snapped to OSM within 10/25 m. | model |
| Excluded OSM | `sac_scale` demanding/difficult alpine (T5/T6), `highway=via_ferrata`, motorways, construction, proposed, platforms, `area=yes`. Legal access tags never exclude (crews = administrative use); they set flags only. | model, must-fix |
| LANDFIRE | Anonymous `lfps.usgs.gov` ImageServer `exportImage` in EPSG:5070, bbox snapped to the CONUS grid (origin −2362425, 3267405). WCS fallback (NoData 32767 → −9999). **Per-pixel** LF2025/LF2024 mosaic, consistent across EVT/EVC/FBFM40. LF2020 Elev + SlpD. | model, must-fix |
| Hydro | TNM Access API with `prodFormats=GeoPackage`, keep items whose title contains `(HU) 8` or whose URL contains `_HU8_`; check `total` vs `max`. Perennial flowlines fcode 46006; perennial waterbodies only (exclude intermittent/ephemeral fcodes 39001/39005/39006, 43614); NHDArea StreamRiver. Zero HU8s for a CONUS AOI → `nhd_unavailable` warning. Trimmed per-HU8 GPKG cached at `work/nhd/{huc8}.gpkg`. | field + pipeline, must-fix |
| Grid | Fire's WGS84 UTM zone, 30 m, ≤ 6.25M cells; else 60 m (`coarse_grid_60m` note); else clipped at 150 km. `grid.tif`: 2 Byte bands (pace code, veg class). `dem.tif`: Int16 m. DEFLATE, no ZSTD. | field, must-fix |
| Off-trail cost | GET v2 isotropic rate on **terrain slope** (SlpD) × GET multipliers, baked into the pace code. Client multiplies by a round-trip-preserving uphill/downhill factor α(θ) from Sullivan-moderate using DEM grade. **Horizontal distance**: `t = d_h · P · α(θ)`. | field + must-fix |
| On-trail time | Sullivan 2020 tertiles on directional grade over horizontal distance, × OSM `sac_scale` factor. | field + must-fix |
| Router | Browser Web Worker (`worker.format: 'es'`), hybrid A*: window-local 8-neighbour grid + densified graph with a portal at every vertex. Sliced search that yields every 40k settled nodes; newer request supersedes. Cost-aware line-of-sight smoothing. | field |
| Perimeter | Latest perimeter by date (not the playhead). Hard block: rasterized + 60 m dilation, blocking cells, graph nodes and graph edges. Endpoint inside → avoidance off with `ENDPOINT_IN_PERIM`. No path → rerun without avoidance, return `blocked_by_perimeter` with the alternative attached; shown only if the user asks. | field + model, must-fix |
| Endpoints | Impassable or masked cell → snap to nearest passable unmasked cell within 150 m, note `SNAP_MOVED`. | field, must-fix |
| Headline time | Mode button and summary lead with the **slow** bound; card shows the full range and the typical value. | must-fix |
| Online fallback | ORS→Valhalla as today; always `ONLINE_NO_PERIM`; `CROSSES_PERIM` when the line crosses the latest perimeter; untimed dotted end-gaps. Offline: Drive/Apparatus show "Needs a connection". | field, must-fix |
| Walk effect | `SearchDirectionsControl` reruns **only the hike profile** when the Walk context (bundle, perimeter, avoid flag) changes; errors stored per mode. | must-fix |
| Clickable layers | `rd-trails-hit` joins `pinDrop.ts` `FEATURE_LAYERS` and `useMapLayerSync` `INTERACTIVE`; the popup handler also bails on an armed draw tool. | must-fix |
| Prune | None automated. Manual-only later. | must-fix |
| CI | `runs-on: ubuntu-24.04` pinned; own concurrency groups `trails-build` and `routing-bundles`; no writes to `state/state.json` or `catalog.json`. | must-fix |

## 2. B2 contract

| Key | Writer | Mutable? | Cache-Control |
|---|---|---|---|
| `catalogs/trails.json` | sync-trails, last | yes | existing `catalogs/` 60 s |
| `trails/b{build_id}/{trails.pmtiles,trails.fgb,build.json}` | sync-trails | no | new `trails/` 1 y immutable |
| `catalogs/routing.json` | routing-index | yes | 60 s |
| `catalogs/routing/fires/{fire_key}.json` | routing-build, last per fire | yes | 60 s |
| `routing/{fire_key}/b{bundle_id}/{grid.tif,dem.tif,graph.bin.gz,trails.pmtiles,bundle.json}` | routing-build | no | new `routing/` 1 y immutable |
| `catalogs/health/trails.json`, `catalogs/health/routing.json` | one job each | yes | 60 s |
| `work/nhd/{huc8}.gpkg` | routing-build (cache; NHD frozen) | write-once | new `work/` private, no-store |
| `state/trails.json`, `state/routing/fires.json` | one job each | yes | existing `state/` |

New content types: `.pmtiles` and `.fgb` application/octet-stream, `.tif` image/tiff,
`.gz` application/gzip, `.gpkg` application/geopackage+sqlite3. **Never** set
Content-Encoding.

`fire_key(cornea_id) = re.sub(r"[^0-9a-z-]", "", cornea_id.lower())[:64]` or
`sha1[:16]` when empty. Keys in documents are the verbatim `cornea_id`.

Upload order per fire: grid, dem, graph, trails → `bundle.json` → per-fire
pointer. The index is rebuilt from pointers only, so a crash can orphan a bundle
directory but never publish a pointer to missing bytes.

### 2.1 `catalogs/trails.json` (`rd-trails/1`)
```json
{"schema": "rd-trails/1", "build_id": "20260925-3f9a1c2e", "built_at": "…",
 "pmtiles": "/trails/b20260925-3f9a1c2e/trails.pmtiles", "pmtiles_url_s3": "https://s3…/trails.pmtiles|null",
 "pmtiles_bytes": 0, "fgb": "/trails/b…/trails.fgb", "fgb_bytes": 0,
 "layer": "trails", "minzoom": 7, "maxzoom": 13, "bounds": [w, s, e, n],
 "counts": {"usfs": 0, "blm_managed": 0, "blm_not_assessed": 0, "nps": 0},
 "source_dates": {"usfs": "YYYY-MM-DD", "blm_managed": "…", "blm_not_assessed": "…", "nps": "…"},
 "degraded_tiles": 0, "attribution": "Trails: USFS · BLM · NPS"}
```

### 2.2 Normalized trail schema (GPKG/FGB/MVT layer `trails`)
`tid, agency (USFS|BLM|NPS), name, num, cls (0–5), uses ("H,P,B,M,A,4" letters; ""
unknown), foot (yes|no|unknown), restr (display text or null), season, status
(open|closed|not_assessed|unofficial), mgmt, unit, src_date`. `trails_lo` keeps
`tid, agency, name, num, status`. Normalizers are pure and fixture-tested.

### 2.3 `catalogs/routing.json` (`rd-routing-index/1`)
```json
{"schema": "rd-routing-index/1", "generated_at": "…", "recipe": 1,
 "fires": {"<cornea_id>": {"descriptor": "/routing/<key>/b<id>/bundle.json", "bundle_id": "…",
                           "built_at": "…", "bbox": [w, s, e, n], "cell_m": 30, "bytes": 0}}}
```

### 2.4 `bundle.json` (`rd-routing-bundle/1`, immutable)
```json
{"schema": "rd-routing-bundle/1", "recipe": 1, "bundle_id": "…", "cornea_id": "…", "fire_key": "…",
 "fire_name": "…", "built_at": "…",
 "crs": {"epsg": 32611, "zone": 11, "northern": true},
 "grid": {"x0": 612330, "y0": 4912830, "cell_m": 30, "width": 1734, "height": 1602},
 "bounds4326": [w, s, e, n],
 "aoi": {"source": "perimeter|point", "perimeter_date": "…|null", "buffer_m": 8000, "clipped": false},
 "files": {"grid": {"path": "…/grid.tif", "bytes": 0, "sha256": "…"},
           "dem": {"path": "…/dem.tif", "bytes": 0, "sha256": "…"},
           "graph": {"path": "…/graph.bin.gz", "bytes": 0, "sha256": "…", "nodes": 0, "edges": 0},
           "trails": {"path": "…/trails.pmtiles", "bytes": 0, "sha256": "…", "minzoom": 10, "maxzoom": 14} },
 "sources": {"landfire": {"veg": "LF2025|LF2024|LF2025+LF2024", "topo": "LF2020", "via": "exportImage|wcs"},
             "osm": {"regions": ["…"], "date": "YYYY-MM-DD"},
             "trails": {"build_id": "…|null"}, "nhd": {"huc8": ["…"]}},
 "stats": {"cells": 0, "impassable_pct": 0, "class_pct": {}, "graph_km": {}},
 "warnings": [], "attribution": ["© OpenStreetMap contributors (ODbL 1.0)", "USFS", "BLM", "NPS", "LANDFIRE", "USGS NHD"],
 "license": "graph.bin.gz and the 'ways' layer of trails.pmtiles are Derivative Databases of OpenStreetMap, available under ODbL 1.0."}
```
`warnings`: `nhd_unavailable`, `trails_unavailable`, `aoi_clipped`, `coarse_grid_60m`,
`landfire_wcs_fallback`, `nodata_border`.

### 2.5 Grid encoding (`recipe 1`)
- `grid.tif` band 1 **pace code** (`logpace-v1`): `P(c) = 0.8 · 1024^((c−1)/253)` s/m
  for c = 1..254 (0.8–819 s/m, 2.7 % steps); 0 and 255 impassable. `P = M / rGET(slope)`,
  `rGET(σ) = (0.0065σ² + 80.8887)/(0.1402σ² + 70.3892)` m/s.
- band 2 **veg** byte: low nibble class (App. C), bit `0x10` perennial stream.
- `dem.tif` Int16 metres, NoData −32768, same georef.
- EPSG 326zz/327zz, origin `(x0, y0)` top-left, pixel `(cell, −cell)`.

Multiplier M (GET v2, lifeform from EVC): tree (EVC 110–199) 4; shrub (210–299)
`1 + 3·cover`; herb/sparse/barren/ag/developed 1; snow 3 (our choice); unknown 4;
× 2 for FBFM40 TL4/TL5/TL7; × 5 for SB1–4; × 5 perennial stream. Impassable: SlpD
> 45°, EVC 11, EVT 7292, FBFM40 98, NHD water polygon, nodata.

### 2.6 `graph.bin.gz` (RDG1, gzip `mtime=0`, little-endian, 4-byte-aligned sections)
Header 64 B: `"RDG1"`, u16 version 1, u16 64, u32 N nodes, u32 E edges, u32 D
deltas, u32 K strings, u32 S string bytes, u32 epsg, f64 x0, f64 y0, u32 unit_mm
= 100, u32 flags = 1 (bidirectional), 8 B reserved.
Sections: `nodes i32[2N]` (x_dm = (E−x0)·10, y_dm = (y0−N)·10, row-down) ·
`edge_from u32[E]` · `edge_to u32[E]` · `edge_dstart u32[E+1]` · `deltas i16[2D]`
(from `node[from]`; the last vertex equals `node[to]`) · `edge_name u32[E]` ·
`edge_ref u32[E]` · `edge_note u32[E]` (restriction text; 0xFFFFFFFF = none) ·
`edge_kind u8[E]` (1 paved road, 2 unpaved road, 3 track, 4 path, 5 steps,
6 agency trail) · `edge_src u8[E]` (1 OSM, 2 USFS, 3 BLM, 4 NPS) · `edge_sac u8[E]`
(0–6) · `edge_flags u8[E]` (bit0 legally restricted, bit1 seasonal, bit2 bridge,
bit3 tunnel, bit4 wilderness, bit5 not assessed, bit6 agency-named, bit7 ford) ·
`str_off u32[K+1]` · `str u8[S]`. No elevation: the client samples `dem.tif`.

## 3. Worker

New modules (pure builders unit-tested; I/O thin):
`gdal_cli.py` (run/which/require/drivers/version, `read_raster`/`write_raster`
through ENVI + VRT), `utm.py`, `pmtiles_inspect.py`, `trails_normalize.py`,
`trails.py`, `trails_cli.py`, `routing_plan.py`, `landfire.py`, `nhd.py`,
`cost_grid.py`, `osm_extract.py` (Geofabrik regions + osmium + OPL parser),
`graph_build.py` (conflation, clipping, RDG1), `routing_bundle.py` (one fire),
`routing_cli.py` (plan/build/one/index), `perimeters.py`, `health_docs.py`.
`cli.py` gains one registration line; `config.py` gets rules, types and endpoints;
`http.py` gains `download_to` (streamed).

Subcommands: `sync-trails [--max-seconds]`, `routing-plan --plan-out`,
`routing-build --plan --shard`, `routing-one (--fire | --aoi W,S,E,N --name)`,
`routing-index`. All take `--dry-run --out --force`.

AOI: latest perimeter bbox (or fire point) in the fire's UTM zone, + 8 km,
minimum 16 km per side, never shrinks against the previous pointer, snapped to
the cell size. Rebuild when: no pointer, recipe changed, AOI outgrown by >2 km,
age ≥ 7 days ("check": recompute hashes and rebuild only if the id changes), or
forced. Backoff after 3 failures (24 h). Priority: `PRIORITY_FIRES`, then acres
descending. Shards are region-affine: fires grouped by primary Geofabrik region,
greedy by estimated seconds.

Workflows: `trails.yml` (daily cron at an odd minute, builds when a source changed
and the last build is ≥ 6 days old, or ≥ 30 days old), `routing.yml` (every 3 h +
after Trails + dispatch; jobs `plan` → `build` matrix of 4 → `index`). Both pin
`ubuntu-24.04`, install `gdal-bin osmium-tool` with the repo's apt retry loop, run
the pure pytest files as a guard, and offer a `dry_run` dispatch that uploads the
`--out` tree as an artifact.

## 4. Frontend

New: `src/routing/{types,costModel,vegClasses,pacecode,rdg1,gridDecode,heap,
rasterize,hybridGraph,astar,smooth,legs,safety,engine,offroad.worker,
offroadClient,bundleIndex}.ts`, `src/api/walkRouting.ts`,
`src/panels/walk/{WalkRouteDetails.tsx,walk.css}`, `src/map/pmtilesSource.ts`,
`src/map/layers/{trailsStyle,trailsLayer,vegetationLayer}.ts`,
`src/panels/layers/{TrailsRow,VegetationRow}.tsx`.
Changed (kept small): `spread/utm.ts` (+forward), `api/routing.ts` (optional
fields, `routeHikeOnline`), `routeLayer.ts` (legs), `zOrder.ts` (ids),
`store.ts` (`layers.trails.mode`, `layers.vegetation`, `directions.avoidPerimeter`),
`useMapLayerSync.ts` (MANAGERS + INTERACTIVE), `pinDrop.ts` (FEATURE_LAYERS),
`SearchDirectionsControl.tsx` (hike via `routeWalk`, per-mode errors, offline
modes), `ForecastTab.tsx` (rows), `urlState.ts` (`trl`, `veg`),
`offline/{packModel,packs,opfs}.ts`, `SourcesView.tsx`, `vite.config.ts`
(`worker: {format: 'es'}`), `package.json` (`pmtiles`).

z-order: `rd-vegetation` first (bottom raster); `rd-trails-ways`,
`rd-trails-casing`, `rd-trails-line` just before `rd-national-perimeters`;
`rd-trails-label`, `rd-trails-hit` right after the basemap-symbol marker;
`rd-routing-area`, `rd-route-casing`, `rd-route-line`, `rd-route-xc`,
`rd-route-gap`, `rd-route-joins` at the top.

Time math, errors, notes and steps follow `designs/design_field.md` §4.5–4.8 with
the horizontal-distance fix and slow-bound headline.

## 5. Must-fix checklist

| # | Must-fix | Where it is handled |
|---|---|---|
| 1 | Isotropic GET v2 on terrain slope off-trail | `cost_grid.py` pace code; `costModel.ts` α(θ) only |
| 2 | Horizontal distance for times | `astar.ts`, `legs.ts`, `hybridGraph.ts` |
| 3 | NHD HU8 title/URL filter + prodFormats + total check | `nhd.py` + test on captured-format fixture |
| 4 | Hard perimeter block with standoff, graph included; endpoint inside; blocked alternative | `rasterize.ts`, `astar.ts`, `engine.ts` |
| 5 | Endpoint snapping ≤150 m | `engine.ts` |
| 6 | No automated prune | no prune code in workflows |
| 7 | `FEATURE_LAYERS` + `INTERACTIVE` + draw-tool bail | `pinDrop.ts`, `useMapLayerSync.ts`, `trailsLayer.ts` |
| 8 | Hike-only rerun on Walk context; per-mode errors | `SearchDirectionsControl.tsx` |
| 9 | Per-pixel LF mosaic | `landfire.py`/`cost_grid.py` |
| 10 | Pointers under `catalogs/`; no Content-Encoding | `config.py` |
| 11 | Range requests bypass the pack; pmtiles/gz types | `packs.ts`, `opfs.ts` |
| 12 | `worker.format: 'es'`; lazy worker singleton | `vite.config.ts`, `offroadClient.ts` |
| 13 | Health in separate docs | `health_docs.py` |
| 14 | Fire list from `catalog.json`; perimeters from DEV | `routing_plan.py`, `perimeters.py` |
| 15 | Wait for pack hydration; retry from the packed bundle | `offroadClient.ts`, `packs.ts` |
| 16 | Immutable packed URLs pack-first even online | `packs.ts` |
| 17 | Phone memory: ≤ 6.25M cells, window-local arrays, no deviceMemory | plan + `astar.ts` |
| 18 | T5/T6 + via_ferrata excluded | `graph_build.py` |
| 19 | Perennial-only lakes | `nhd.py` |
| 20 | CPL_DEBUG MVT degradation counting | `trails.py` |
| 21 | Online route perimeter warnings; untimed gaps | `walkRouting.ts` |
| 22 | Slow-bound headline time | `SearchDirectionsControl.tsx`, `WalkRouteDetails.tsx` |
| 23 | Pin `ubuntu-24.04`; never read PMTiles with GDAL 3.8.4 | workflows, `pmtiles_inspect.py` |
| 24 | `actions/cache` never keyed on run id | no actions/cache for data |

## 6. Slices (commit + push after each)

W1 foundations (config, gdal_cli, utm, pmtiles_inspect, http.download_to) →
W2 trails (normalize, build, cli, workflow) → W3 routing worker (plan, landfire,
nhd, cost grid, osm, graph, bundle, index, workflow) → F1 frontend seams + trails
layer → F2 routing core (pure modules + tests) → F3 worker/client + Walk UX →
F4 vegetation + offline pack → STATUS.md.

## Appendix C: vegetation classes (`veg-v1`)

| id | label | colour |
|---|---|---|
| 0 | Unknown | `#7a7a7a` |
| 1 | Grass / herb | `#e3cf6f` |
| 2 | Light brush (< 40 % cover) | `#c9a25a` |
| 3 | Dense brush (≥ 40 %) | `#9a6a33` |
| 4 | Timber | `#4f8a3c` |
| 5 | Timber, heavy litter | `#2f5f2a` |
| 6 | Slash / blowdown | `#b4532a` |
| 7 | Rock / sparse | `#a6a6a6` |
| 8 | Developed / agriculture | `#d9b9a3` |
| 9 | Snow / ice | `#e6f2ff` |
| 10 | Open water (impassable) | `#3b78c2` |
| 11 | Too steep > 45° (impassable) | `#5b3a29` |
| 0x10 bit | Perennial stream | `#2f8fd8` |
