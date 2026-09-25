# Trails overlay + offline off-road foot routing: design (field architect)

Branch `trails-offroad-routing`, base 69858dc. Written 2026-09-24.

The lens for this design is a crew member on a phone with no signal. What renders offline, what the numbers mean, how the UI fails when data is missing, and how fast it is on a mid-range phone all come before pipeline elegance. Every component is still specified end to end.

---

## 0. Decisions at a glance

| Topic | Decision | Why (short) |
|---|---|---|
| Trails display format | One national **PMTiles** archive (z7–13) per build, at a versioned immutable key. Each fire's offline pack gets a small per-fire PMTiles extract (z10–14) read through an **OPFS FileSource**. | One upload per build instead of 85k–212k z/x/y objects. No sparse-grid 404s (B2 404s carry no CORS headers). PMTiles gzips tiles internally, so no Content-Encoding plumbing is needed. Offline reads use File.slice, with no HTTP Range emulation. |
| PMTiles client | npm `pmtiles` 4.5.0: 7.7 kB gz, one transitive dependency (fflate), owner approval pending. **Fallback:** `map/pmtilesLite.ts`, a hand-rolled PMTiles v3 reader of about 250 lines behind the same `TileArchive` interface. | MapLibre 5.24 has no native PMTiles support. `addProtocol` (the built-in) is used either way. |
| Trail sources | USFS EDW weekly FGDB zip (TERRA only); BLM hosted FS `Public_Managed_Trails/2` plus `Public_Not_Assessed_Trails/7`; NPS `NPS_Public_Trails/MapServer/0`. All normalized to one schema (App. B). | Verified live. BLM MapServer layers 2–5 are subsets of 7, so they are not unioned. |
| Router placement | In the browser, inside a module **Web Worker** (`worker.format: 'es'`). The main thread fetches the data through the offline-aware `window.fetch` and **transfers** the buffers to the worker. | This is the only path the OPFS pack wrapper serves. Worker fetches would bypass the pack. |
| Routing model | **Hybrid A\***: a 30 m UTM cost grid (8 neighbours plus cost-aware smoothing) combined with a trail/road graph densified to ≤ one cell. Every graph vertex is a "portal" to its cell, so a route can join or leave a trail anywhere. | Benchmarked at desktop 5 km ≈ 6 ms and 15 km ≈ 50–80 ms on 4M cells. Portals keep exact trail geometry. |
| Off-trail cost | **GET v2**: isotropic Lorentz slope term on terrain slope × LANDFIRE multipliers, > 45° or water impassable, perennial streams ×5. A **round-trip-preserving uphill/downhill asymmetry** is taken from the Sullivan-moderate curve. | GET v2 is the agency-vetted, CC0, conservative recipe. The asymmetry restores the uphill/downhill difference GET dropped for CONUS-scale reasons, without changing GET's out-and-back time. |
| On-trail time | **Sullivan et al. 2020** loaded-crew tertiles on directional slope: low, moderate and high. Moderate is the point estimate. The range is [high, low]. | These rates were measured on hotshots carrying about 50 lb. |
| Grid resolution / AOI | Latest perimeter bbox + 8 km, minimum 16 × 16 km, in the fire's UTM zone. 30 m cells up to 6.25M cells; 60 m cells up to 150 km per side; beyond that, clipped. | Keeps phone memory ≤ ~30 MB of data arrays. |
| Scope | **Every active CONUS fire** (~312), largest first. AK/HI/PR are v2. | Owner choice. LANDFIRE AK/HI/PRVI services exist but are unverified. |
| Worker data sources | LANDFIRE **exportImage** (anonymous ImageServer) with **WCS** fallback, LF2025 where valid, else LF2024. Topography from LF2020 Elev and SlpD. NHD HU8 GeoPackages through the TNM Access API, cached in B2. **Geofabrik** state PBFs read with **pyosmium**. No Overpass. | All verified live. The LFPS job API needs an email; Overpass policy forbids cron use. |
| Publication | Standalone pointer JSONs: `trails/latest.json`, `routing/p/{cid}.json` and `routing/index.json`. **catalog.json and state.json are never touched.** Private state lives in `state/trails.json` and `state/routing/{cid}.json`. | Avoids the two-writer catalog problem and the shared 4.5 MB state document. |
| Keys | Per-fire bundles are keyed by **cornea_id**, never fire_slug. | fire_slug is unstable. |
| Walk behaviour | When a bundle exists and **both** A and B are inside the routing area, the offline engine is used (online or offline). Otherwise the online ORS/Valhalla route is used, and any end gap is drawn as a dashed leg: modeled if the gap is inside the area, straight and untimed if not. There is **no silent fallback** to online engines when the offline engine says the fire blocks the route. | Online engines don't know the fire. |
| Safety wording | This label is always on: **"Cross-country legs are modeled, not scouted."** Times are shown as ranges. Warning notes cover perimeter age, perimeter crossings, nearby recent hotspots, and snapped endpoints. | IRPG language: scout the route and time it with the slowest person. |

---

## 1. Architecture overview and data flow

```
                         GitHub Actions  (runs-on: ubuntu-24.04 pinned, apt gdal-bin 3.8.4)
 ┌─────────────────────────────────────────────────────────────────────────────────────────────┐
 │ trails.yml  "Trails build"   daily 09:37 UTC, change-driven, ≥6 d between builds             │
 │   USFS EDW FGDB zip ──┐  ogr2ogr → src_*.gpkg ─► attrs CSV ─► Python normalize ─► CSV        │
 │   BLM FS/2, FS/7 ─────┼─ (ESRIJSON auto-paging)          ▲ join back by fid (SQLite dialect) │
 │   NPS MapServer/0 ────┘                                  └──────────► trails_norm.gpkg        │
 │        ├─► ogr2ogr -f PMTiles (trails_lo z7–10, trails_hi z11–13) ─► trails.pmtiles          │
 │        ├─► ogr2ogr -f FlatGeobuf (spatial index)                   ─► trails.fgb              │
 │        └─► pmtiles_check.py (pure-Python sanity; never read PMTiles with GDAL 3.8.4)          │
 │   upload trails/v/{build}/* ─► trails/latest.json (LAST) ─► state/trails.json ─► health       │
 │                                                                                               │
 │ routing.yml "Routing bundles"   every 3 h + after "Trails build" + dispatch                   │
 │   job plan  (no GDAL): fires (prod index, 1 req) + latest perimeters (DEV API, only changed)  │
 │             + Geofabrik index + routing/p/*.json ─► plan.json (AOIs, keys, priority,          │
 │             region-affine shard assignment) ─► matrix                                         │
 │   job build[k] (≤6 shards, 350 min):                                                           │
 │      per region: Geofabrik PBF ─ pyosmium (with_locations, KeyFilter highway) ─► ways/AOI      │
 │      per fire:   LANDFIRE exportImage (EPSG:5070, snapped) ─► gdalwarp → UTM grid              │
 │                  TNM API → NHD HU8 (cache work/nhd/v1) ─► gdal_rasterize streams/water        │
 │                  numpy cost model ─► grid.tif (pace code, veg) + dem.tif                       │
 │                  trails.fgb via /vsicurl/ -spat ─┐                                             │
 │                  OSM ways ───────────────────────┴─► graph_build ─► graph.bin.gz (RDG1)        │
 │                                               └──► per-fire trails.pmtiles (trails + ways)     │
 │                  upload routing/b/{cid}/{bid}/* ─► bundle.json ─► routing/p/{cid}.json (LAST)  │
 │   job index: routing/p/*.json for active fires ─► routing/index.json ─► health                │
 └─────────────────────────────────────────────────────────────────────────────────────────────┘
                                   │ public B2 (f005 native; optional S3 endpoint for ranges)
 Browser (GitHub Pages SPA)        ▼
 ┌─────────────────────────────────────────────────────────────────────────────────────────────┐
 │ main thread                                                                                   │
 │   window.fetch wrapper (OPFS packs; network-first online / pack-first offline; RANGE → bypass)│
 │   getJson('/routing/index.json') → bundle.json → fetch grid.tif, dem.tif, graph.bin.gz        │
 │        │ postMessage({t:'load', …}, [buffers])            ▲ {t:'route', result}               │
 │        ▼                                                  │                                    │
 │   offroad.worker (module): geotiff decode · DecompressionStream gunzip · hybrid A* · legs     │
 │                                                                                               │
 │   pmtiles Protocol (main thread, addProtocol 'pmtiles')                                        │
 │     online : FetchSource(range) → trails/v/{build}/trails.pmtiles (national)                   │
 │     offline: FileSource(OPFS File) → routing/b/{cid}/{bid}/trails.pmtiles (per fire)           │
 │                                                                                               │
 │   Walk (SearchDirectionsControl → walkRouting.routeWalk):                                      │
 │     A,B inside area ─► offroad engine (works offline)                                          │
 │     else online     ─► ORS/Valhalla + dashed end-gap legs (+ safety checks)                    │
 │     else            ─► explicit offline error                                                  │
 │                                                                                               │
 │   "Download this fire" pack += routing/index.json (mutable) + bundle.json + 4 files (immutable)│
 └─────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Offline rendering, fire by fire.** Take a fire whose pack was downloaded after its routing bundle existed. With no signal, the map draws on the plain `#161313` offline ground:
- perimeters, hotspots, forecast, weather and incident maps (existing behaviour);
- **trails** and **OSM roads/tracks/paths** from the per-fire extract;
- the **vegetation** layer, if toggled, from `grid.tif`;
- the dashed **routing-area** box;
- Walk routes computed on the device.

Labels render through MapLibre's local TinySDF glyphs.

---

## 2. B2 key layout, headers, versioning, schemas, retention

### 2.1 Keys

| Key | Written by | Mutability | Cache-Control | Content-Type |
|---|---|---|---|---|
| `trails/latest.json` | trails job (last) | mutable pointer | `public, max-age=60, must-revalidate` | application/json |
| `trails/v/{build_id}/trails.pmtiles` | trails job | immutable | `public, max-age=31536000, immutable` | application/octet-stream |
| `trails/v/{build_id}/trails.fgb` | trails job | immutable | same | application/octet-stream |
| `trails/v/{build_id}/build.json` | trails job | immutable | same | application/json |
| `trails/README.txt` | trails job | mutable | 60 s | text/plain |
| `routing/index.json` | routing index job | mutable | `public, max-age=60, must-revalidate` | application/json |
| `routing/p/{cid}.json` | build shard owning the fire (last) | mutable pointer | 60 s must-revalidate | application/json |
| `routing/b/{cid}/{bundle_id}/{bundle.json,grid.tif,dem.tif,graph.bin.gz,trails.pmtiles}` | build shard | immutable | 1 y immutable | json / image/tiff / application/gzip / octet-stream |
| `routing/README.txt` | index job | mutable | 60 s | text/plain |
| `work/nhd/v1/{huc8}.gpkg` | build shards (cache) | write-once | `public, max-age=86400` | application/geopackage+sqlite3 |
| `state/trails.json`, `state/routing/{cid}.json` | trails job, build shard | private docs | `private, no-store` (existing `state/` rule) | application/json |
| `catalogs/health.json` | new sections `trails`, `routing` via `health.publish` | existing | existing | existing |

Definitions:
- `{cid}` = `re.sub(r'[^A-Za-z0-9_-]', '_', cornea_id)`. The original cornea_id is stored inside every document.
- `build_id` = `t{YYYYMMDD}T{HHMM}-{sha8(source fingerprints)}`.
- `bundle_id` = `b{YYYYMMDD}T{HHMM}-{sha8(inputs_key)}`.

**config.py additions.** First match wins. These rules go **before** the existing `catalogs/` rule; they overlap no existing prefix.
```python
("trails/v/",  "public, max-age=31536000, immutable"),
("trails/",    "public, max-age=60, must-revalidate"),
("routing/b/", "public, max-age=31536000, immutable"),
("routing/",   "public, max-age=60, must-revalidate"),
("work/",      "public, max-age=86400"),
```
New `CONTENT_TYPES` entries:
- `.pmtiles`: application/octet-stream
- `.fgb`: application/octet-stream
- `.tif`, `.tiff`: image/tiff
- `.gz`: application/gzip
- `.gpkg`: application/geopackage+sqlite3
- `.bin`: application/octet-stream

**Never set Content-Encoding.** PMTiles range reads break under an encoded object, and `graph.bin.gz` is gunzipped by the app itself.

### 2.2 `trails/latest.json` (schema 1)
```json
{
 "schema": 1,
 "build_id": "t20260924T0937-5c1e09aa",
 "built_at": "2026-09-24T09:52:11Z",
 "pmtiles": {"path": "/trails/v/t20260924T0937-5c1e09aa/trails.pmtiles", "bytes": 183456789,
             "minzoom": 7, "maxzoom": 13, "layer": "trails",
             "bounds": [-179.9, 17.5, -64.0, 71.5], "max_tile_bytes": 212004},
 "fgb":     {"path": "/trails/v/t20260924T0937-5c1e09aa/trails.fgb", "bytes": 402113220, "crs": "EPSG:4326"},
 "sources": {
   "usfs":             {"date": "2026-09-23", "count": 74867, "etag": "\"71d7c4e-65c26895234d1\""},
   "blm_managed":      {"date": "2026-09-21", "count": 19532},
   "blm_not_assessed": {"date": "2026-09-21", "count": 5038},
   "nps":              {"date": "2026-09-22", "count": 31120}
 },
 "fields": ["tid","agency","name","num","cls","uses","foot","restr","season","status","surface","grade","width_in","mgmt","unit","src_date","miles"],
 "attribution": "Trails: USFS, BLM, NPS"
}
```

### 2.3 `routing/p/{cid}.json`: per-fire pointer (schema 1)
```json
{
 "schema": 1, "cornea_id": "…", "bundle_id": "b20260924T1712-3fa9c2d1",
 "descriptor": "/routing/b/{cid}/b20260924T1712-3fa9c2d1/bundle.json",
 "built_at": "2026-09-24T17:12:03Z", "recipe": 1, "inputs_key": "sha256…",
 "epsg": 32611, "cell_m": 30, "aoi_utm": [612330, 4864770, 664350, 4912830],
 "bounds4326": [-115.61, 43.91, -114.94, 44.36],
 "aoi_source": {"kind": "perimeter", "perimeter_date": "2026-09-24T06:10:00Z", "poly_last_updated": "…",
                "perimeter_bbox": [-115.3, 44.0, -115.1, 44.2]},
 "trails_build": "t20260921T0937-…", "osm_timestamp": "2026-09-23T20:22:00Z", "lf": "LF2024",
 "bytes": 7345678
}
```

### 2.4 `routing/index.json` (schema 1). This is the only routing document the app needs up front.
```json
{
 "schema": 1, "generated_at": "…", "recipe": 1,
 "fires": {
   "<cornea_id>": {"descriptor": "/routing/b/…/bundle.json", "bundle_id": "…", "built_at": "…",
                   "bounds4326": [w,s,e,n], "cell_m": 30, "bytes": 7345678}
 }
}
```
The index is about 312 × 190 B ≈ 60 KB. The app fetches it lazily in fire mode, and it is packed as a mutable snapshot.

### 2.5 `bundle.json`: the immutable descriptor (schema 1)
```json
{
 "schema": 1, "kind": "rd-routing-bundle", "bundle_id": "…", "cornea_id": "…",
 "fire_name": "…", "fire_slug": "informational only", "built_at": "…",
 "recipe": {"version": 1, "cost_model": "getv2-2024+sullivan2020", "pace_code": "logpace-v1",
            "veg_classes": "v1", "graph_format": "RDG1"},
 "crs": {"epsg": 32611, "zone": 11, "northern": true},
 "grid": {"x0": 612330, "y0": 4912830, "cell_m": 30, "width": 1734, "height": 1602},
 "bounds4326": [w,s,e,n], "corners4326": [[lon,lat],[lon,lat],[lon,lat],[lon,lat]],
 "aoi": {"source": "perimeter", "perimeter_date": "…", "buffer_m": 8000, "clipped": false},
 "files": {
   "grid":   {"path": "/routing/b/…/grid.tif",       "bytes": 2201934, "sha256": "…", "bands": ["pace_code","veg"]},
   "dem":    {"path": "/routing/b/…/dem.tif",        "bytes": 2410022, "sha256": "…", "unit": "m"},
   "graph":  {"path": "/routing/b/…/graph.bin.gz",   "bytes": 912345,  "sha256": "…",
              "junctions": 31022, "interior": 219877, "chains": 40123, "links": 5120},
   "trails": {"path": "/routing/b/…/trails.pmtiles", "bytes": 1403112, "sha256": "…",
              "minzoom": 10, "maxzoom": 14, "layers": ["trails","ways"]}
 },
 "sources": {
   "landfire": {"veg": "LF2024", "topo": "LF2020", "via": "exportImage"},
   "osm":      {"regions": ["us/idaho"], "timestamp": "2026-09-23T20:22:00Z"},
   "trails":   {"build_id": "t…", "usfs": "2026-09-23", "blm": "2026-09-21", "nps": "2026-09-22"},
   "nhd":      {"huc8": ["17060201"], "vintage": "2024-01-05"}
 },
 "stats": {"cells": 2777868, "impassable_pct": 2.1, "graph_km": {"road": 1234.5, "track": 400.1, "trail": 321.0},
           "osm_trail_chains_dropped_as_duplicates": 311},
 "warnings": [],
 "attribution": ["© OpenStreetMap contributors (ODbL 1.0)", "USFS", "BLM", "NPS", "LANDFIRE", "USGS NHD"],
 "license": "graph.bin.gz and the 'ways' layer of trails.pmtiles are Derivative Databases of OpenStreetMap, available under ODbL 1.0 (see /routing/README.txt)."
}
```
`warnings` values: `nhd_unavailable`, `trails_unavailable`, `aoi_clipped`, `coarse_grid_60m`, `landfire_wcs_fallback`, `border_nodata`. The app shows each one as an info note.

### 2.6 Private state documents
- `state/trails.json`:
  ```
  {schema, last_build_id, last_built_at,
   usfs: {etag, last_modified, count},
   blm_managed: {data_last_edit_ms, count},
   blm_not_assessed: {…},
   nps: {max_editdate_ms, count}}
  ```
- `state/routing/{cid}.json`: `{schema, failures, last_error, last_attempt_at, last_success_at}`. Only the shard that owns the fire in the current plan writes it.

### 2.7 Versioning and upload order (atomicity)
- Immutable assets go up first, then `bundle.json`/`build.json`, then the mutable pointer **last**.
- The index job derives `routing/index.json` from pointers only. If a shard crashes, it can leave an orphan bundle directory, which nothing references. It can never leave a pointer to missing bytes.
- Pointers carry `recipe`. When the app sees a recipe newer than it knows (e.g. 2), it treats the fire as having no bundle: "Offline walking routes need an app update" (Walk falls back online).

### 2.8 Retention and pruning
Rough storage:
- Bundles: about 312 fires × ~7 MB per 14-day refresh ≈ 5 GB/month if never pruned, roughly $0.03/month.
- National trails: about 200 MB per week.

This is the owner's keep-by-default posture. **No automatic deletion.** A manual `routing-prune --keep 2 --inactive-days 60 --confirm` covers bundles of fires inactive for more than 60 days and all but the 2 newest bundles per fire. A matching `trails-prune --keep 4 --confirm` covers trails builds. Both need `--confirm`, following the existing prune convention. Old bundles are safe to delete: packs keep their own copies, and online clients follow the pointer.

---

## 3. Worker (Python 3.12, uv, GDAL 3.8.4 via subprocess)

### 3.1 New modules (`worker/responder_worker/`)

| Module | Pure? | Responsibility |
|---|---|---|
| `utm.py` | pure numpy | Forward and inverse UTM, WGS84, Snyder series. `zone_for(lon)`, `epsg_for(lon, lat)`, `fwd(lon, lat, zone, north) -> (e, n)` and `inv(e, n, zone, north)`, all vectorized. |
| `gdalio.py` | CLI | `gdal_available(tools)`, `drivers_available(names)` (parses `ogrinfo --formats` and `gdalinfo --formats`), `info(path)` (via `gdalinfo -json`), `read_raster(path) -> (ndarray[bands,h,w], Georef)` (via `gdal_translate -of ENVI` then `numpy.fromfile`), `write_raster(arr, georef, path, creation_opts, nodata, band_names)` (raw BSQ, then VRT with `VRTRawRasterBand`, then `gdal_translate -of GTiff`), `transform_points(pts, src, dst)` (via `gdaltransform`), `run(cmd, timeout)` (the `hrrr._run` style: RuntimeError carrying the last stderr line). |
| `pmtiles_check.py` | pure stdlib | PMTiles v3 header and directory reader (App. E): `summarize(path) -> {tiles, zooms, max_tile_bytes_by_zoom, bounds, clustered, compression}`. Used only for sanity checks. GDAL 3.8.4 never reads PMTiles (bug #9288). |
| `trails_normalize.py` | pure | `normalize_usfs(row, src_date)`, `normalize_blm(row, layer, src_date)`, `normalize_nps(row)` return a dict following App. B, or `None` to drop the row. Also the value parsers: grade, width, uses, dates, title-case. |
| `trails.py` | CLI+IO | `sync(client, storage, *, workdir, force, log, deadline_passed)`: change detection, downloads, the sidecar-join normalization, the PMTiles and FGB builds, checks and publish. |
| `geofabrik.py` | pure+IO | Loads `https://download.geofabrik.de/index-v1.json` (with geometry). `leaf_us_regions()` returns the US state leaves plus `norcal`/`socal` instead of `us/california`. `regions_for_aoi(lonlat_quad)` does a pure point-in-polygon and edge-intersection test. |
| `perimeters.py` | IO | `latest_perimeter(client, cornea_id)`: DEV `/fires/{cid}/perimeters`, picks the latest by `date`, then GETs `FIRE_API_DEV + path` verbatim. Returns `(feature, date)` or None. |
| `routing_plan.py` | pure | `aoi_for(fire, perim_bbox, prev_pointer)`, `inputs_key(...)`, `needs_build(...)`, `priority(...)`, `assign_shards(fires, shards, region_sizes)`, and the `Plan` dataclasses (JSON round-trip). |
| `landfire.py` | IO | `fetch_layers(client, bbox5070, out_dir, want=("EVT","EVC","FBFM40","Elev","SlpD"))`: exportImage, WCS fallback, and the LF2025 validity test. |
| `nhd.py` | IO | `huc8_for_bbox(client, bbox4326)` via the TNM API, and `ensure_huc8_gpkg(client, storage, huc8, workdir)` to extract and cache. |
| `cost_grid.py` | pure numpy | `compute(evt, evc, fbfm, slope, perennial, water, lf_version) -> (pace_code u8, veg u8, stats)`, plus the constants and LUTs from `data/landfire_evt_lf.json`. |
| `osm_ways.py` | IO (pyosmium) | `scan_region(pbf, aois: dict[cid, bbox4326]) -> dict[cid, list[OsmWay]]`: one pass per region for all of the shard's fires. |
| `graph_build.py` | pure numpy | Clipping, junction splitting, conflation, densification, connectors, elevation and smoothing. `write_rdg1(...) -> bytes`, plus `read_rdg1(bytes)` for tests. |
| `routing_bundle.py` | IO | `build_fire(ctx, fire_plan) -> BundleResult`: orchestrates one fire and uploads it (§3.6). |
| `routing_index.py` | IO | `rebuild_index(storage, fires, log)`, plus the README and health. |
| `cli_trails.py`, `cli_routing.py` | CLI | Subparser registration and `cmd_*` bodies. `cli.build_parser()` calls `register(sub, common)` on each, so the new work stays out of the 1,580-line `cli.py`. |
| `data/landfire_evt_lf.json` | data | `{"LF2024": {"<VALUE>": <lf_int>, …}, "LF2025": {…}}`. Generated by `worker/scripts/build_landfire_luts.py` from the landfire.gov CSVs and committed, so runtime never depends on landfire.gov. |

### 3.2 CLI subcommands
Every subcommand takes `common()`: `--dry-run --out --force`.
- `sync-trails [--max-seconds N (env TRAILS_MAX_SECONDS, 6000)] [--min-days 6] [--skip-pmtiles]`
- `routing-plan --plan-out PATH [--shards N (env ROUTING_SHARDS, 6)] [--priority-fires CSV (env PRIORITY_FIRES)] [--fire ID] [--max-fires N]`. When `GITHUB_OUTPUT` is set it writes `matrix={"shard":[…]}` and `work=true|false` there.
- `routing-build --plan PATH --shard K [--max-seconds N (env ROUTING_MAX_SECONDS, 19500)] [--keep-work DIR]`
- `routing-one (--fire <cornea_id|slug|name> | --aoi W,S,E,N --name NAME) [--keep-work DIR]` runs a local plan and build for one AOI. This is the debugging and verification entry point.
- `routing-index`
- `routing-prune --keep 2 --inactive-days 60 --confirm` and `trails-prune --keep 4 --confirm` (both manual)

### 3.3 Workflows
Both new workflows share these conventions:
- pinned `runs-on: ubuntu-24.04`;
- the apt retry block copied from `tile.yml:39-55`, with the package list reduced to `gdal-bin`;
- a check step that runs `gdalinfo --version` and `ogrinfo --formats | grep -E 'PMTiles|FlatGeobuf|GPKG|OpenFileGDB|ESRIJSON'` and prints the result;
- `df -h` and `free -h`;
- `astral-sh/setup-uv@v5` with Python 3.12 and `uv sync`;
- the B2 env block;
- `defaults.run.working-directory: worker`.

**`.github/workflows/trails.yml`, "Trails build"**
- `on: schedule: cron '37 9 * * *'` plus `workflow_dispatch` (inputs `force: bool`, `dry_run: bool`).
- `concurrency: {group: trails-build, cancel-in-progress: false}`.
- One job, `timeout-minutes: 120`.
- Steps: GDAL install, check, uv, then `uv run pytest -q tests/test_trails_normalize.py tests/test_pmtiles_check.py` (about 1 s; gates the build), then `uv run python -m responder_worker.cli sync-trails ${FLAGS[@]}`. On `dry_run`, it uploads `worker/out/trails` as an artifact (1-day retention) so the output of the real GDAL 3.8.4 can be inspected.
- Env: `GDAL_NUM_THREADS=4`, `CPL_TMPDIR=$RUNNER_TEMP`.

**`.github/workflows/routing.yml`, "Routing bundles"**
- `on: schedule: cron '47 */3 * * *'`, `workflow_run: {workflows: ["Trails build"], types: [completed]}`, and `workflow_dispatch` (inputs `fire`, `force`, `shards`, `dry_run`).
- `concurrency: {group: routing-bundles, cancel-in-progress: false}`.
- `plan`: 20 min timeout, no GDAL. Runs uv, then `uv run pytest -q tests/test_routing_plan.py tests/test_cost_grid.py tests/test_graph_build.py tests/test_utm.py` (pure, about 2 s), then `routing-plan --plan-out plan.json`, then `upload-artifact plan`. Outputs `matrix` and `work`.
- `build`: `needs: plan`, `if: needs.plan.outputs.work == 'true'`, `strategy: {fail-fast: false, max-parallel: 6, matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}}`, 350 min timeout. Steps: GDAL, check, uv, `download-artifact plan`, then `routing-build --plan plan.json --shard ${{ matrix.shard }}`. Env: `ROUTING_MAX_SECONDS=19500`, `GDAL_NUM_THREADS=4`, `GDAL_HTTP_MAX_RETRY=4`, `GDAL_HTTP_RETRY_DELAY=2`, `CPL_VSIL_CURL_CHUNK_SIZE=1048576`, `CPL_TMPDIR=$RUNNER_TEMP`.
- `index`: `needs: [plan, build]`, `if: always() && needs.plan.result == 'success'`, 15 min timeout. Runs `routing-index`.

Neither workflow writes `state/state.json` or `catalog.json`, so neither needs a slot in `worker-b2-writes`. `health.publish` does a read-modify-write of `catalogs/health.json` from a different concurrency group. The race window is milliseconds and the worst case is one cosmetic lost heartbeat, which the next run restores. This is accepted and documented in `health.py`.

### 3.4 Trails pipeline (`sync-trails`)

**Change detection** runs first and is cheap:
- USFS: conditional GET of the zip with `If-None-Match`/`If-Modified-Since` from `state/trails.json`. A 304 means unchanged.
- BLM: `…/BLM_Natl_GTLF_Public_Managed_Trails/FeatureServer/2?f=json` → `editingInfo.dataLastEditDate`, and the same for `…/Public_Not_Assessed_Trails/FeatureServer/7?f=json`.
- NPS: `…/NPS_Public_Trails/MapServer/0/query?where=1%3D1&outStatistics=[{"statisticType":"max","onStatisticField":"EDITDATE","outStatisticFieldName":"m"}]&f=json`.

The build runs if any source changed **and** the last build is at least `--min-days 6` old, or if the last build is at least 30 days old, or with `--force`. Otherwise the job logs `[trails] unchanged` and publishes health `skipped_unchanged: true`.

**Fetch recipes.** All downloads stream to disk through the new `http.download_to(client, url, dest, headers=…)`, which uses `client.stream` with tenacity retries.

1. **USFS.** GET `https://data.fs.usda.gov/geodata/edw/edw_resources/fc/Trans_Trail_NFS_Publish.gdb.zip` (119 MB). Then:
   ```
   ogr2ogr -f GPKG src_usfs.gpkg /vsizip/{zip}/Trans_Trail_NFS_Publish.gdb Trans_Trail_NFS_Publish \
     -where "TRAIL_TYPE='TERRA'" -t_srs EPSG:4326 -nlt MULTILINESTRING -nln src -lco FID=fid \
     -select TRAIL_CN,TRAIL_NO,TRAIL_NAME,TRAIL_CLASS,ALLOWED_TERRA_USE,TERRA_MOTORIZED,HIKER_PEDESTRIAN_MANAGED,HIKER_PEDESTRIAN_ACCPT,HIKER_PEDESTRIAN_RESTRICTED,TYPICAL_TRAIL_GRADE,TYPICAL_TREAD_WIDTH,TRAIL_SURFACE,NATIONAL_TRAIL_DESIGNATION,SPECIAL_MGMT_AREA,ADMIN_ORG,ATTRIBUTESUBSET,GIS_MILES,BMP,EMP
   ```
   `src_date` is the zip's Last-Modified date.
2. **BLM Managed** (`layer='managed'`):
   ```
   ogr2ogr -f GPKG src_blm_m.gpkg "https://services1.arcgis.com/KbxwQRRfWyEYLgp4/arcgis/rest/services/BLM_Natl_GTLF_Public_Managed_Trails/FeatureServer/2/query?where=1%3D1&outFields=OBJECTID,ROUTE_PRMRY_NM,ADMIN_ST,PLAN_ASSET_CLASS,PLAN_MODE_TRNSPRT,PLAN_ALLOW_MODE_TRNSPRT,PLAN_OHV_ROUTE_DSGNTN,PLAN_ACCESS_RSTRCT,PLAN_SEASON_RSTRCT_CODE,OBSRVE_ROUTE_USE_CLASS,OBSRVE_SRFCE_TYPE,ROUTE_SPCL_DSGNTN_TYPE,GIS_MILES,ACCURACY_FT,FAMS_ID&outSR=4326&orderByFields=OBJECTID&f=json" \
     -nlt PROMOTE_TO_MULTI -nln src -lco FID=fid
   ```
   GDAL auto-pages because there is no `resultOffset` in the URL.
3. **BLM Not Assessed** (`layer='not_assessed'`): the same recipe against `…/BLM_Natl_GTLF_Public_Not_Assessed_Trails/FeatureServer/7/query?…` with `outFields=*`.
4. **NPS:**
   ```
   ogr2ogr -f GPKG src_nps.gpkg "https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails/MapServer/0/query?where=1%3D1&outFields=OBJECTID,TRLNAME,TRLALTNAME,MAPLABEL,TRLSTATUS,TRLSURFACE,TRLTYPE,TRLCLASS,TRLUSE,TRLFEATTYPE,SEASONAL,SEASDESC,UNITCODE,UNITNAME,MAINTAINER,EDITDATE,XYACCURACY,PUBLICDISPLAY,DATAACCESS&outSR=4326&orderByFields=OBJECTID&f=json" \
     -nlt PROMOTE_TO_MULTI -nln src -lco FID=fid
   ```

**Normalization by attribute sidecar join.** Geometry never passes through Python.
1. `ogr2ogr -f CSV attrs_{a}.csv src_{a}.gpkg -sql "SELECT fid AS src_fid, * FROM src"`.
2. Python streams the CSV through `normalize_*` and writes `norm_{a}.csv` plus a `norm_{a}.csvt` giving exact column types (`Integer,String,…`). Rows that `normalize_*` returns as None are dropped.
3. `ogr2ogr -update -f GPKG src_{a}.gpkg norm_{a}.csv -nln norm`.
4. Join into one layer:
   ```
   ogr2ogr -f GPKG -append trails_norm.gpkg src_{a}.gpkg -nln trails -nlt MULTILINESTRING \
     -sql "SELECT s.geom AS geom, n.* FROM src s JOIN norm n ON n.src_fid = s.fid WHERE s.geom IS NOT NULL"
   ```
   The `WHERE` drops the 3,289 NULL USFS geometries. FlatGeobuf with a spatial index aborts on NULL geometry.
5. `ogr2ogr -update trails_norm.gpkg trails_norm.gpkg -nln trails_lo -sql "SELECT geom, tid, agency, name, num, status FROM trails"`.

**Count sanity.** For each source, a drop of more than 10% against `state/trails.json` aborts the publish. The previous `latest.json` stays live, and health records `note: "usfs count 34000 vs 74867 last build (partial refresh?)"`. The EDW service was caught mid-reload on 2026-09-24; the FGDB zip is atomic, but the guard is cheap.

**PMTiles (national).** This path works around the 3.8.4 quirks. It goes through a temp mbtiles plus a hidden SQLite scratch database, so peak temp disk is about 1–3 GB under `CPL_TMPDIR`.
```
ogr2ogr -f PMTiles trails.pmtiles trails_norm.gpkg trails_lo trails_hi \
  -spat -179.9 17.5 -64.0 71.5 \
  -dsco NAME="Responder Debrief trails" -dsco DESCRIPTION="USFS/BLM/NPS trails {build_id}" -dsco TYPE=overlay \
  -dsco MINZOOM=7 -dsco MAXZOOM=13 -dsco CONF=pmtiles_conf.json \
  -dsco SIMPLIFICATION=1 -dsco SIMPLIFICATION_MAX_ZOOM=0.5 -dsco MAX_SIZE=500000 -dsco MAX_FEATURES=200000
```
- `trails_hi` is the full `trails` layer copied under that name.
- `pmtiles_conf.json` = `{"trails_lo":{"target_name":"trails","minzoom":7,"maxzoom":10},"trails_hi":{"target_name":"trails","minzoom":11,"maxzoom":13}}`.
- The `-spat` bounds drop Guam and Samoa, so the header bounds are meaningful.

**Why z13 nationally.** At 150k features, z7–13 is 85k tiles against 212k for z7–14, and z14 adds only 45–50% more bytes. MapLibre overzooms, and z13 still gives about 1 m coordinate precision.

**Silent degradation guard.** In 3.8.4, a tile over MAX_SIZE is silently re-encoded at lower resolution and then loses features. `pmtiles_check.summarize()` must report `max_tile_bytes < 480_000` at every zoom. At or above that, the publish aborts with the health note `pmtiles tile near MAX_SIZE at z{z}`. It must also report `clustered == true`, `tile_compression == gzip` and `min/max zoom == 7/13`.

**FlatGeobuf** (the routing input and an open-data download):
```
ogr2ogr -f FlatGeobuf trails.fgb trails_norm.gpkg trails -lco SPATIAL_INDEX=YES
```

**Publish order:** `trails.pmtiles`, `trails.fgb`, `build.json`, `README.txt`, then `trails/latest.json`, then `state/trails.json`, then `health.publish('trails', …)`.

### 3.5 Per-fire AOI policy, priority, rebuild triggers (`routing-plan`)

**Fire set.** `fires.fetch_active_fires(client)`: one prod request, the same light index the catalog uses. Only fires whose point falls within the CONUS box `[-125,24.5,-66.5,49.5]` get bundles. The rest are recorded as `unsupported_region`.

**Perimeter bbox.** The plan reuses `pointer.aoi_source.perimeter_bbox` when `poly_last_updated` is unchanged. Otherwise it calls `perimeters.latest_perimeter(client_dev, cid)` against **FIRE_API_DEV** with the verbatim path. No perimeter means the fire point is used.

**AOI formula** (all in the UTM zone of the fire point, `epsg = 326zz`):
```
core      = utm_bbox(perimeter_bbox or point)            # project the 4 corners + 4 edge midpoints; take the min/max
desired   = expand(core, BUFFER_M=8000)
desired   = ensure_min_side(desired, MIN_SIDE_M=16000)    # grow symmetrically
if prev and prev.epsg == epsg: desired = union(desired, prev.aoi_utm)   # never shrink a live area
cell      = 30 if cells(desired, 30) <= 6_250_000 else 60
if cell == 60 and cells(desired, 60) > 6_250_000: desired = centered_clip(desired, 150_000); clipped = True
x0 = floor(xmin / cell) * cell;  y0 = ceil(ymax / cell) * cell
width = ceil((xmax - x0) / cell); height = ceil((y0 - ymin) / cell)
```

**Rebuild triggers.** `needs_build(fire, pointer, trails_latest, now)` is true on any of:
1. no pointer;
2. `pointer.recipe != RECIPE_VERSION` (1);
3. growth, with hysteresis: `not contains(pointer.aoi_utm, expand(core, 2000))`;
4. age: `now - built_at >= 14 d` (refreshes OSM, LANDFIRE and NHD);
5. `pointer.trails_build is None and trails_latest exists`;
6. `pointer.trails_build != trails_latest.build_id and age >= 7 d`;
7. `--force` / `--fire`.

**Backoff.** A fire is skipped when `state/routing/{cid}.json` shows `failures >= 3` and `last_attempt_at` is under 24 h ago. After that it gets one retry per 24 h.

**`inputs_key`** = `sha256(json.dumps({recipe, cid, epsg, x0, y0, width, height, cell, lf_policy:"lf2025-else-lf2024", topo:"LF2020", trails_build, osm_epoch: days_since_2026_01_01 // 14, nhd:"v1"}, sort_keys=True))`. It names the bundle and lets a re-plan detect that there is nothing to do. The age and trails rules above decide freshness. The key alone does not, since the OSM files change daily.

**Priority.** Buckets in order, acreage descending within each:
1. `PRIORITY_FIRES` matches on slug, name or cornea_id;
2. no bundle yet;
3. AOI outgrown;
4. recipe changed;
5. trails missing or stale;
6. age refresh, oldest first.

**Region-affine shard assignment** (`assign_shards`):
- Each fire gets `regions = geofabrik.regions_for_aoi(aoi_lonlat_quad)` (a leaf region set; CA uses norcal/socal).
- Estimated seconds: `est = 25 + 12 * cells_M + 6 * graph_density_guess` per fire, plus `55 * pbf_GB` once per region per shard.
- Greedy: fires are taken in priority order, grouped by their primary region. Each region group goes to the shard with the least load that already holds that region; otherwise to the least-loaded shard. A group bigger than 40% of the budget is split.
- Each shard's list is capped at `ROUTING_MAX_SECONDS × 0.85`. The overflow is deferred to the next run and listed in the plan as `deferred`.

`plan.json` = `{schema:1, generated_at, trails_build, shards:[{shard, regions:[{id,url,bytes}], fires:[FirePlan…]}], deferred:[cid…], unsupported:[cid…]}`.
`FirePlan` = `{cid, cornea_id, name, slug, acres, epsg, zone, north, grid:{x0,y0,cell,width,height}, aoi_source, bounds4326, regions, reason, inputs_key}`.

### 3.6 Bundle build (`routing-build`, per shard)

**Shard preamble.**
- Read `trails/latest.json`.
- Check GDAL tools and drivers. If they are missing, log `[routing] GDAL unavailable`, record it in health and exit 0, the existing convention.
- Arm `frames.start_deadline(max_seconds)`.
- For each region: stream the PBF to `$RUNNER_TEMP`, run `osm_ways.scan_region(pbf, {cid: bbox4326_with_300m_margin})` once for all of the shard's fires in that region, keep the per-fire ways as `.npz`/pickle in the workdir, and delete the PBF. The OSM timestamp comes from the PBF header `osmosis_replication_timestamp`.
- **PBFs are deliberately not cached across runs.** Geofabrik publishes a new dated file every day, and `actions/cache` keys are immutable, so a cache would either go stale or churn 3–6 GB of the repo's 10 GB cache limit. Three things keep downloads small instead: region-affine sharding (each region is downloaded by exactly one shard per run), the 14-day refresh rule (steady state is about 1–3 regions per run), and one sequential download per region. If download volume ever matters, `actions/cache` keyed `osm-{region}-{isoYear}w{isoWeek}` is a drop-in addition. **NHD is cached** (B2 `work/nhd/v1/`) because it is frozen.

**Per fire** (inside `try/except` that logs and continues; deadline checked before each fire):

1. **LANDFIRE.**
   - Compute the 5070 bbox of the UTM grid: 4 corners + 4 edge midpoints via `gdalio.transform_points(EPSG:326zz → EPSG:5070)`, expanded by 60 m, then snapped outward to the CONUS grid (`x = -2362425 + 30*i`, `y = 3267405 - 30*j`).
   - For each layer, GET `https://lfps.usgs.gov/arcgis/rest/services/{svc}/ImageServer/exportImage` with `bbox=xmin,ymin,xmax,ymax&bboxSR=5070&imageSR=5070&size=W,H&format=tiff&pixelType=S16&noData=-9999&interpolation=RSP_NearestNeighbor&compression=LZ77&f=image`.
   - The `{svc}` values are `Landfire_LF2025/LF2025_{EVT,EVC,FBFM40}_CONUS` first, then `Landfire_LF2024/…`, plus `Landfire_Topo/LF2020_{Elev,SlpD}_CONUS`.
   - **LF2025 validity:** if more than 95% of the EVT pixels are −9999, all three veg layers switch to LF2024. The veg layers never mix versions.
   - On HTTP failure or a non-TIFF body, fall back to WCS `https://edcintl.cr.usgs.gov/geoserver/landfire_wcs/{conus_2024|conus_2025|conus_topo}/wcs?service=WCS&version=2.0.1&request=GetCoverage&coverageId=landfire_wcs__{LAYER}&subset=X(xmin,xmax)&subset=Y(ymin,ymax)&format=image/geotiff`. WCS NoData is 32767, normalized to −9999. This adds the warning `landfire_wcs_fallback`.
   - Requests go out one at a time, at least 1 s apart.
2. **Warp to the grid.**
   ```
   gdalwarp -t_srs EPSG:326zz -te x0 (y0-H*cell) (x0+W*cell) y0 -tr cell cell -r {near|mode|bilinear|average} -ot Int16 -dstnodata -9999 -overwrite
   ```
   Categorical EVT/EVC/FBFM40 use `near` at 30 m and `mode` at 60 m. Elev and SlpD use `bilinear` at 30 m and `average` at 60 m.
3. **NHD.**
   - `huc8_for_bbox`: GET `https://tnmaccess.nationalmap.gov/api/v1/products?datasets=National%20Hydrography%20Dataset%20(NHD)%20Best%20Resolution&bbox=W,S,E,N&max=50`. Keep items whose title contains "HU) 8" and whose format is GeoPackage.
   - For each HU8, `ensure_huc8_gpkg`: if `work/nhd/v1/{huc8}.gpkg` exists, use it. Otherwise stream the zip (15–28 MB) and `ogr2ogr` two layers into a small GPKG:
     - `perennial` from `NHDFlowline WHERE fcode = 46006`, `-dim XY`;
     - `water` from `NHDWaterbody WHERE ftype IN (390, 436)` plus `NHDArea WHERE ftype = 460`.
     Then upload it (NHD is frozen at its 2023–24 vintage).
   - Per fire: `ogr2ogr -t_srs EPSG:326zz` into a temp GPKG, then `gdal_rasterize -at -burn 1 -ot Byte -te … -tr cell cell` for `perennial` (all-touched), and `gdal_rasterize -burn 1` for `water` (cell-centre rule).
   - If NHD fails entirely, the bundle proceeds with EVT and FBFM40 water only and the warning `nhd_unavailable`.
4. **Cost model** (`cost_grid.compute`, numpy):
   ```
   LF   = evt_lf_lut[lf_version][evt]            # 0 nodata,1 Tree,2 Shrub,3 Herb,4 Sparse,5 Agri,6 Developed,7 Water,8 Barren,9 Snow-Ice
   M    = 1.0
   M[LF==1] = 4.0                                 # tree-dominated
   cover = where((evc>=210)&(evc<=299), (evc-200)/100, 0.0)
   M[LF==2] = 1 + 3*cover[LF==2]                  # shrub 1× at 0% → 4× at 100%
   M[LF==9] = 3.0                                 # snow/ice — expert choice (not in GET v2)
   M[LF==0] = 4.0                                 # unknown vegetation → conservative
   M *= where(isin(fbfm,[184,185,187]), 2, 1)     # TL4/TL5/TL7 extra 2×
   M *= where((fbfm>=201)&(fbfm<=204), 5, 1)      # SB1–SB4 extra 5× (table value; see §7 conflicts)
   M *= where(perennial==1, 5, 1)                 # perennial stream extra 5×
   imp  = (slope>45) | (LF==7) | (fbfm==98) | (evc==11) | (water==1) | (elev==-9999) | (slope==-9999)
   rGET = (0.0065*s**2 + 80.8887)/(0.1402*s**2 + 70.3892)      # s = slope degrees (LF2020 SlpD warped)
   P    = M / rGET                                             # isotropic off-trail pace, s/m
   code = clip(1 + rint(253*ln(P/0.8)/ln(640)), 1, 254).astype(u8);  code[imp] = 255
   ```
   **Pace code "logpace-v1":** `P(code) = 0.8 × 640^((code−1)/253)` s/m, for codes 1–254. Code 255 means impassable; code 0 is reserved and also treated as impassable. The step is 2.6% and rounding error at most ±1.3%. The range covers 0.87 s/m (flat grass) to 377 s/m (M = 100 at 45°).

   **Veg class byte "veg-v1":** the low nibble is the class and bit `0x10` marks a perennial stream. Classes are assigned in this precedence:
   - 10 water: water tests
   - 11 too steep: slope > 45
   - 6 slash/blowdown: SB1–4
   - 5 timber + heavy litter: tree with TL4/5/7
   - 4 timber: other tree
   - 3 dense brush: shrub with cover ≥ 0.40
   - 2 light brush: shrub with cover < 0.40
   - 1 grass/herb: herb
   - 7 rock/sparse: sparse or barren
   - 8 developed/agriculture: agriculture or developed
   - 9 snow/ice
   - 0 unknown: nodata
5. **Write rasters** (`gdalio.write_raster`), with an identical georef on both: EPSG:326zz, origin `(x0, y0)` and pixel `(cell, −cell)`.
   - `grid.tif`: 2 × Byte bands (`pace_code`, `veg`), created with `-co COMPRESS=DEFLATE -co ZLEVEL=9 -co PREDICTOR=1 -co TILED=YES -co BLOCKXSIZE=512 -co BLOCKYSIZE=512 -co INTERLEAVE=BAND` and metadata `RD_RECIPE=1 RD_PACE_CODE=logpace-v1 RD_VEG=veg-v1`.
   - `dem.tif`: Int16 metres, NoData −32768, `-co COMPRESS=DEFLATE -co PREDICTOR=2 -co ZLEVEL=9 -co TILED=YES -co BLOCKXSIZE=512 -co BLOCKYSIZE=512`.
   - geotiff 2.1.3 decodes DEFLATE with predictor 2. ZSTD must not be used.
6. **Agency trails for the AOI:**
   ```
   ogr2ogr -f GPKG fire_trails.gpkg /vsicurl/{DATA_BASE}/trails/v/{build}/trails.fgb -spat W S E N -spat_srs EPSG:4326 \
     -t_srs EPSG:326zz -clipdst x0 ymin xmax y0 -nln trails -nlt MULTILINESTRING
   ```
   The FGB spatial index means only the ranges for the fire's bbox are read. If `trails_latest` is missing, the bundle is built without agency trails and gets the warning `trails_unavailable`.
7. **Graph** (`graph_build`, pure numpy plus stdlib):
   1. OSM ways are projected to UTM (`utm.fwd`) and clipped to the grid rectangle. A way is split into runs of consecutive inside nodes; each boundary-crossing segment is dropped, a ≤ 1-segment edge effect.
   2. **OSM topology is exact by node ID.** A node is a junction if it appears in two or more runs or is a run endpoint. Runs are split at junctions into chains.
      - Kept tags: `highway name ref surface tracktype bridge tunnel access foot sac_scale layer`.
      - Excluded highway values: `motorway motorway_link construction proposed platform raceway bus_stop elevator corridor abandoned razed`.
      - Closed ways with `area=yes` are excluded.
      - `access=private` and `foot=no` are kept but flagged (crews have administrative use).
   3. Agency trails are read from `fire_trails.gpkg` via `ogr2ogr -f GeoJSONSeq /vsistdout/`, one chain per LineString part. Endpoints are merged into shared junctions when they coincide within 0.5 m.
   4. **Conflation.** OSM chains with class track, trail or steps are densified at 10 m. If at least 80% of the samples lie within 15 m of any agency vertex (a 15 m spatial hash), the chain is dropped as a duplicate. Roads are never dropped. The drop count goes into `stats`.
   5. **Densify** every chain so that consecutive vertices are at most `cell_m` apart. Original vertices are kept.
   6. **Connectors**, using a 20 m spatial hash of all nodes:
      - every dead-end junction (degree 1) links to the nearest node of a *different* chain within 20 m;
      - every agency segment that crosses a segment of another chain (excluding OSM chains flagged bridge or tunnel) links the nearest vertex pair of the two chains at the crossing (≤ about 21 m apart);
      - links with the same pair of chains are deduplicated within 30 m.

      Links carry class `connector` (6).
   7. **Elevation.** The DEM is sampled bilinearly at every node and stored as i16 metres. Interior nodes are smoothed along each chain with a `[1,2,1]/4` kernel in 2 passes; junctions are not smoothed. This keeps 30 m DEM noise from inflating climb and slope.
   8. The ways table is deduplicated on the tuple `(cls, source, flags, trail_class, sac, name, ref)`. The file is written as RDG1 (App. A) and compressed with `gzip.compress(data, 9, mtime=0)`, which is deterministic.

   OSM class mapping:
   - **cls 1 road_paved:** `trunk primary secondary tertiary unclassified residential living_street service road` and their `_link`s, unless `surface` is unpaved.
   - **cls 2 road_unpaved:** the same highway values with `surface` in `unpaved gravel dirt ground compacted fine_gravel earth mud sand grass`.
   - **cls 3 track:** `track`.
   - **cls 4 trail:** `path footway bridleway cycleway pedestrian`.
   - **cls 5 steps:** `steps`.

   Agency chains are always cls 4, with source USFS 2, BLM 3 or NPS 4.
8. **Per-fire trails extract.**
   - OSM chains (before conflation) are written with `{cls, name, ref}` in lon/lat to `ways.geojsonseq`, then `ogr2ogr -f GPKG fire_disp.gpkg ways.geojsonseq -nln ways`. The agency layer is added from `fire_trails.gpkg` as `trails`.
   - Build:
     ```
     ogr2ogr -f PMTiles trails.pmtiles fire_disp.gpkg trails ways -dsco MINZOOM=10 -dsco MAXZOOM=14 -dsco MAX_SIZE=500000 -dsco NAME="{fire} trails"
     ```
   - `pmtiles_check` must pass: tiles ≥ 1 and max tile < 480 KB.
9. **Descriptor and upload.**
   - Write the sha256 and bytes of each file.
   - `put_file` in the order grid, dem, graph, trails, then `bundle.json`.
   - Then write `routing/p/{cid}.json`, and then `state/routing/{cid}.json` = `{failures: 0, last_success_at}`.
   - On failure, write `state/routing/{cid}.json` = `{failures: n+1, last_error: <≤300 chars>, last_attempt_at}` and no pointer.

**Measured and estimated budget per fire** (50 × 50 km class):

| Step | Time |
|---|---|
| LANDFIRE (5 layers) | ≈ 6 s |
| NHD (cached) | ≈ 3 s; ≈ 5 s per first-time HU8 |
| Warps and rasterize | ≈ 6 s |
| numpy | ≈ 1 s |
| Graph | ≈ 5–20 s |
| PMTiles | ≈ 5 s |
| Upload (5–10 MB) | ≈ 5 s |
| **Total** | **≈ 40–60 s** |

Region scans add once per shard: Idaho ≈ 6.4 s (measured) and California ≈ 60–70 s (extrapolated). The initial backfill of about 312 fires is roughly 4–6 h of compute, or under 1.5 h spread over 6 shards.

### 3.7 Health, idempotence, failure handling
- **`routing-index`** reads `routing/p/{cid}.json` for every active CONUS fire (about 312 GETs, about 30 s) and rewrites `routing/index.json` and `routing/README.txt` (format plus the ODbL notice). It then publishes `health.publish(storage, 'routing', {started_at, finished_at, ok, note, fires_active, fires_with_bundle, built, failed, unsupported, deferred, oldest_bundle_days, gdal_version})`. The `built`, `failed` and `deferred` counts come from `plan.json` and the shard logs, which each shard uploads as a `routing-result-{k}.json` artifact.
- **`sync-trails`** publishes `health.publish(storage, 'trails', {…, build_id, counts, pmtiles_bytes, max_tile_bytes, skipped_unchanged, gdal_version})`. Failures go through `publish_failure`.
- **Idempotence:**
  - Pointers are written last, and the index is derived from pointers only.
  - Rerunning a plan with nothing changed produces zero builds.
  - A crashed shard leaves only orphan `routing/b/…` directories. Orphans are harmless and removed by manual prune.
  - The Trails job never overwrites `trails/v/*`.
- **Failure isolation:** every fire, region scan and HU8 is wrapped in try/except. A failed region scan fails its fires, which retry on the next run. Subprocess timeouts:
  - `gdalwarp`: 300 s
  - `ogr2ogr` per call: 900 s; the national PMTiles build gets 3,600 s
  - `gdal_rasterize`: 300 s
  - HTTP: 60 s; 300 s for streams, with retries
- **Politeness:**
  - Geofabrik: at most one download per region per shard run, sequential, with the project User-Agent. Steady state is about 1–3 regions per run. The backfill is about 4–6 GB once.
  - LANDFIRE: sequential, at least 1 s apart.
  - Fire API: the prod list once per plan; perimeters only from DEV and only when changed.

### 3.8 New Python dependencies (justified)
| Dependency | Why | Alternatives rejected |
|---|---|---|
| `numpy>=1.26` | Per-cell LUTs over 0.3–6M cells × 5 layers per fire; graph arrays; exact little-endian byte layouts. Manylinux wheel, no compiling. | `gdal_calc.py` via the system python3-numpy can't express a 1,069-entry EVT LUT cleanly. VRT `<LUT>` interpolates linearly, which is wrong for classes. Pure Python is about 50× slower (hours across 312 fires). |
| `osmium>=4.3` (pyosmium) | Exact OSM topology by node ID; scans Idaho in 6.4 s with `with_locations()` plus `KeyFilter('highway')`. Manylinux wheels exist. | GDAL's OSM driver drops node IDs, which forces geometric noding with false junctions at bridges. `osmium-tool` export also loses per-vertex IDs. Overpass is ruled out by policy. |

No shapely, pyproj or GeoPandas. Noding uses node IDs plus spatial-hash connectors, and projection uses `utm.py` plus `gdaltransform`. apt stays at `gdal-bin` only.

---

## 4. Frontend

### 4.1 Module map (new files unless marked *)
```
frontend/src/routing/
  types.ts            RoutingIndex, RoutingPointer, RoutingBundle, RouteLeg, RouteNote, OffroadResult, error codes
  costModel.ts        Sullivan tertiles, GET v2, α(θ), tertile ratios, pace-code LUT, H_PACE, constants
  vegClasses.ts       class table (id,key,label,color,legendOrder) + STREAM_BIT + paint LUT
  graphFormat.ts      RDG1 parser → typed arrays + CSR builder (pure)
  gridLoad.ts         geotiff fromArrayBuffer → full-res Uint8/Int16 arrays + georef (no downsampling)
  heap.ts             binary min-heap on Float64Array/Int32Array (growable)
  rasterize.ts        (Multi)Polygon lon/lat → UTM → cell mask (scanline + supercover edges + dilation)
  astar.ts            hybrid grid+graph search, sliced (generator), window-local arrays
  smooth.ts           cost-aware line-of-sight smoothing of cross-country runs
  legs.ts             path → RouteLeg[] (+veg runs, climb w/ hysteresis, time ranges, steps text)
  safetyChecks.ts     crossesPerimeter, nearRecentHotspots, perimeterAgeHours (lon/lat, pure)
  engine.ts           createOffroadEngine(): load/perimeter/route/veg — pure orchestration used by the worker shell AND node tests
  offroad.worker.ts   thin message shell around engine.ts
  offroadClient.ts    main-thread singleton: lazy Worker, bundle loading via wrapped fetch, request ids, status store
  bundleIndex.ts      routingIndexUrl(), getRoutingEntry(cid), getBundle(entry), insideRoutingArea(bundle, lonlat)
frontend/src/spread/utm.ts*        + lonLatToUtm(lon,lat,zone,northern) forward (Snyder), tests
frontend/src/api/routing.ts*       RouteResult extension, engine 'offroad', export routeHikeOnline()
frontend/src/api/walkRouting.ts    routeWalk(a,b,ctx): offroad vs online + gap legs + notes
frontend/src/panels/walk/useWalkRouting.ts   WalkContext hook (perimeter via queryClient.fetchQuery, hotspots, online)
frontend/src/panels/walk/WalkRouteDetails.tsx   summary / split / veg breakdown / steps / label / notes
frontend/src/panels/walk/walk.css  (keeps panels.css untouched)
frontend/src/map/pmtilesSource.ts  TileArchive interface, protocol registration, national/offline resolution
frontend/src/map/pmtilesLite.ts    fallback PMTiles v3 reader (only if `pmtiles` dep rejected)
frontend/src/map/trailsTypes.ts    TrailsLatest type
frontend/src/map/layers/trailsStyle.ts   ground → paint, popup HTML (pure)
frontend/src/map/layers/trailsLayer.ts   LayerManager (self-driven)
frontend/src/map/layers/vegetationLayer.ts   LayerManager (self-driven, canvas source)
frontend/src/map/layers/routingAreaLayer.ts  LayerManager (dashed box when Walk is active)
frontend/src/map/layers/routeLayer.ts*   legs → FeatureCollection; new xc/gap/joins layers
frontend/src/panels/layers/TrailsRow.tsx, VegetationRow.tsx   Layers-tab rows + legends
frontend/src/offline/{packModel,packs,opfs}.ts*, panels/OfflineCard.tsx*
frontend/src/state/store.ts*, map/zOrder.ts*, map/useMapLayerSync.ts*, app/urlState.ts*, panels/tabs/ForecastTab.tsx*
frontend/src/panels/SearchDirectionsControl.tsx*, SourcesView.tsx*, LegendBar.tsx*, HealthView.tsx*, api/types.ts* (HealthDoc)
frontend/vite.config.ts*  worker: { format: 'es' }     frontend/package.json*  "pmtiles": "^4.5.0" (pending)
```

### 4.2 PMTiles protocol and sources (`map/pmtilesSource.ts`)
```ts
export interface TileArchiveSource { key: string; kind: 'national' | 'fire'; url: string /* 'pmtiles://…' */ }
export async function ensureProtocol(): Promise<void>        // dynamic import('pmtiles'); new Protocol({metadata:false}); maplibregl.addProtocol('pmtiles', p.tile) once
export async function nationalTrailsSource(latest: TrailsLatest): Promise<TileArchiveSource>
  // url = 'pmtiles://' + rangeDataUrl(latest.pmtiles.path)   (FetchSource, Range through the wrapper → bypass)
export async function fireTrailsSource(bundle: RoutingBundle): Promise<TileArchiveSource | null>
  // file = await packedFile(dataUrl(bundle.files.trails.path)); if !file → null
  // protocol.add(new PMTiles(new FileSource(file))); url = 'pmtiles://' + file.name   (OPFS name is unique per URL)
export function invalidateFireSource(): void                  // on pack change / NotReadableError → re-resolve
```
- `rangeDataUrl(path)` = `(import.meta.env.VITE_DATA_RANGE_BASE_URL ?? DATA_BASE_URL) + path`. Setting the repo variable to `https://s3.us-east-005.backblazeb2.com/responder-debrief-data` lets Chrome HTTP-cache the 206 range responses (measured: native f005 206s were not cached; S3-endpoint 206s were). `deploy-pages.yml` passes the variable through, and it is optional.
- **Wrapper hardening** (`packs.ts`): any GET carrying a `Range` header goes straight to `rawFetch` and never to the pack. A packed file served as a whole 200 would crash pmtiles' FetchSource.
- **Fallback, `pmtilesLite.ts`** (if `pmtiles` is rejected; about 250 lines, App. E):
  - `class Archive { constructor(src: RangeReader) }`, where `RangeReader` is either `(off, len) => fetch(url, {headers:{range}})` or `File.slice`;
  - `header()`, `getZxy(z,x,y) → Uint8Array | null`, with gunzip via `DecompressionStream('gzip')`;
  - addProtocol `'rdpm'` handler returning `{data}`, with `{type:'vector', tiles:['rdpm://{key}/{z}/{x}/{y}'], minzoom, maxzoom, bounds}` taken from our pointer JSON.

### 4.3 Trails layer (`trailsLayer.ts` + `trailsStyle.ts`)
**Source.** `rd-trails` is `{type:'vector', url: src.url, attribution}`:
- national: `'Trails: USFS · BLM · NPS'`;
- fire extract: `'Trails: USFS · BLM · NPS · © OpenStreetMap contributors'`.

The source is recreated when `src.key` changes (the incidentMapLayer key pattern).

**Source selection**, re-evaluated when `online`, `view.corneaId`, the pack set or `trails/latest.json` changes:
1. Online and `latest` loaded → national.
2. Otherwise, the fire has a packed bundle with a `trails` file → fire extract.
3. Otherwise → none. The Layers row shows "Trails unavailable offline for this fire (not in download)".

If the national source fires `error` 3 times within 10 s, the layer switches to the fire extract when one is packed.

**Layers**, all created in `mount()` with `visibility:'none'` (hidden layers load no tiles):

| id | type | source-layer | z-slot | notes |
|---|---|---|---|---|
| `rd-trails-ways` | line | `ways` | below labels, before casing | only on the fire extract and offline ground; `#8a8586` roads (cls 1–2) 1.2 px, tracks dashed `[2,1]` 1 px |
| `rd-trails-casing` | line | `trails` | below labels, just before `rd-national-perimeters` | casing per ground |
| `rd-trails-line` | line | `trails` | after casing | core per ground; `status == 'not_assessed'` → opacity 0.55, width ×0.75 |
| `rd-trails-label` | symbol | `trails` | above labels (first after the basemap-symbol marker) | `symbol-placement: line`, `text-field: coalesce(name, num)`, 11 px, `minzoom 12`, `text-font: rdLabelFont(map)`, `symbol-spacing 400` |
| `rd-trails-hit` | line | `trails` | above labels | width 12 px, opacity 0 (still hit-testable), `minzoom 11` |

Line width by zoom: core `['interpolate',['linear'],['zoom'], 9,1.0, 12,1.8, 15,3.0]`, casing = core + 2.

**Paint by ground** (`groundKey`: `'offline'` when the style has no non-rd sources, else `ui.basemap` `'topo'|'satellite'`, else `ui.theme` dark or light). The teal hue was chosen to avoid the route blue `#4aa3ff`, the perimeter red, the hotspot yellows, oranges and purples, the draw purple, blue, ink and red, and the USGS dashed brown and black trails.

| ground | casing | core | label halo |
|---|---|---|---|
| topo (default) | `#ffffff` @0.85 | `#0e8f8a` | `#ffffff` |
| satellite | `#06201f` @0.65 | `#3ee0d8` | `#06201f` |
| map-dark (Dark Matter, Fiord, Classic dark) | `#0d0a0c` @0.80 | `#34d1c9` | `#0d0a0c` |
| map-light (Positron, Liberty, Voyager) | `#ffffff` @0.90 | `#0e8f8a` | `#ffffff` |
| offline (`#161313` ground) | `#0d0a0c` @0.80 | `#34d1c9` | `#0d0a0c` |

The manager subscribes to `ui.basemap`, `ui.theme` and `ui.mapStyle` (the `basemapUnderlay.ts:121-131` pattern, including the dead-map guard), calls `setPaintProperty` when the ground changes, and re-applies after MapRoot's idle resync.

**Visibility.** `layers.trails.mode: 'auto' | 'on' | 'off'` (default `'auto'`). Effective visibility is `mode === 'on' || (mode === 'auto' && ground === 'offline')`. With no basemap offline, trails and roads are the crew's only ground reference. On topo, the default stays off to avoid doubling the USGS trails that appear from z14.

**Popup** (`trailPopupHtml(props, {walkHere})`; pure, every field escaped):
```
Iron Creek–Stanley Lake Trail #640                                  ← name + ' #' + num
USFS · Class 3 (Developed) · Wilderness                             ← agency · class label · mgmt
Allowed: hiker, pack & saddle, bicycle                               ← uses expanded ('' → "Allowed uses not published")
Restricted: hiker 01/01–12/31   |  Admin only (agency/fire use)       ← restr (amber)   [only if present]
Season (hiker): 05/15–09/15                                          ← season          [only if present]
Tread 18–24 in · Grade 12–20% · Native surface                       ← width/grade/surface [if present]
Source: USFS EDW, Sep 23 2026                                         ← agency dataset + src_date
[ Walk here ]                                                         ← sets directions B at the tapped point
```
- Handlers: `click`, `mouseenter` and `mouseleave` on `rd-trails-hit`.
- The click handler bails if `routeClickClaims(directions)` **or** `draw.tool !== 'none'`.
- The Popup is created lazily with `closeButton:false` and `offset:8`, closes when the layer hides, and a WeakSet guards handler installation.
- "Walk here" does `setDirectionsPoint('b', {coords: tap, label})` and `setDirectionsProfile('hike')`. Event delegation happens on the popup element.
- `trackOncePer('fire-view','trail_popup_opened',{agency})`.

**Click arbitration.** Add `'rd-trails-hit'` to `INTERACTIVE` in `useMapLayerSync.ts`. After the hotspot-flames WIP merges, also add it to `FEATURE_LAYERS` in `pinDrop.ts`. Otherwise a trail tap drops a pin or moves B while the popup opens.

**Layers tab** (`TrailsRow`): a checkbox showing the effective state; clicking it sets `'on'` or `'off'` explicitly. The subtitle is "USFS · BLM · NPS" and a swatch line shows `▬ trail  ┈ not assessed (BLM)`. When the fire extract is active, the row also reads "offline copy".

**URL.** `trl=1` means on and `trl=0` means off. Auto is omitted.

### 4.4 Routing engine (worker)

**Loading path.** The main thread does the fetching (`offroadClient.ensureBundle(corneaId)`):
1. `getRoutingEntry(cid)` fetches `routing/index.json` through `getJson`. This goes through the wrapper, so offline it comes from the pack.
2. No entry → `null`. `entry.recipe > SUPPORTED_RECIPE` → `null` with reason `app_update`.
3. `getBundle(entry)` fetches `bundle.json`.
4. `Promise.all` fetches the grid, DEM and graph with `fetch(dataUrl(path))`, then `.arrayBuffer()`. Byte progress is `Σ files[*].bytes`, shown as "Loading terrain model · 6.2 MB".
5. `worker.postMessage({t:'load', …}, [graphGz, grid, dem])` and wait for `loaded`.
6. The worker is kept warm until the fire changes or it has been idle for 10 min, then `terminate()`.

**Preload triggers:** directions profile is `'hike'` with A set, the vegetation layer is toggled on, or a "Walk here" popup action.

**Message protocol** (`routing/types.ts`):
```ts
type ToWorker =
 | { t:'load'; id:number; bundleId:string; bundle:RoutingBundle; graphGz:ArrayBuffer; grid:ArrayBuffer; dem:ArrayBuffer }
 | { t:'perimeter'; id:number; key:string|null; polygons:[number,number][][][]|null; marginM:number }
 | { t:'route'; id:number; a:[number,number]; b:[number,number]; avoidPerimeter:boolean; neighbors?:8|16 }
 | { t:'veg'; id:number; maxWidth:number }
 | { t:'unload' };
type FromWorker =
 | { t:'loaded'; id:number; bundleId:string; ms:number; cells:number; nodes:number }
 | { t:'perimeterSet'; id:number; key:string|null; maskedCells:number }
 | { t:'progress'; id:number; settled:number }
 | { t:'route'; id:number; result:OffroadResult }
 | { t:'veg'; id:number; width:number; height:number; rgba:ArrayBuffer }          // transferred
 | { t:'error'; id:number; code:OffroadErrorCode; message:string };
type OffroadErrorCode = 'not-loaded'|'outside-area'|'no-path'|'budget'|'decode-failed'|'oom'|'superseded';
```

**Worker memory.** Data arrays are kept for the bundle's lifetime:
- `code: Uint8Array(cells)`, `veg: Uint8Array(cells)` and `dem: Int16Array(cells)`: 4 B per cell, so 11 MB at 2.8M cells and 25 MB at 6.25M.
- Graph: node x/y as `Float32Array` metres (2 × 4 B), z `Int16Array`, `nodeCell: Uint32Array`, CSR (`adjStart: Uint32Array(n+1)`, `adjTo: Uint32Array(2E)`, `adjCost: Float32Array(2E)`, `adjWay: Uint32Array(2E)`). About 8–10 MB for 250k nodes.
- Cell-to-nodes index: nodes sorted by cell, plus an open-addressing `Int32Array(2^k)` hash from cell to `[start, end)`.

Per-query arrays are **window-local**: g `Float32Array`, parent `Int32Array` and closed `Uint8Array`, sized to the window cells plus the graph nodes inside the window. A typical 5 km query touches about 0.13M entries, about 1.2 MB.

**Decode.**
- The graph is gunzipped with `new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()` and parsed by `graphFormat`.
- The grid goes through `gridLoad.decodeGrid(buf)`: geotiff `fromArrayBuffer` → `getImage()` → `readRasters({interleave:false})` at **native size**. There is no `width` option, because the 1536 px downsampling in `decodeSpreadTiff` must not apply here.
- The grid must satisfy `grid.width/height` equal to the descriptor, an EPSG geokey in 326xx/327xx, and an origin matching `(x0, y0)` within 0.01 m. Otherwise `decode-failed`.

**Coordinates.** `lonLatToUtm` gives `(E, N)`. Then `col = (E − x0)/cell` and `row = (y0 − N)/cell`, both fractional. "Inside the routing area" means `1 ≤ col < W−1` and `1 ≤ row < H−1`. The main thread computes the same test from the descriptor in `insideRoutingArea` before calling the worker.

**Perimeter mask.**
- Built from the LATEST perimeter by date: `perimeterIndex.reduce(max by date)`, the packModel rule, not the playhead version.
- The main thread sends it once per `key = path`.
- The worker projects the vertices to grid coordinates, even-odd scanline fills cell centres into a bitset `Uint8Array(ceil(cells/8))`, marks every cell touched by an edge (supercover), and dilates by `ceil(marginM / cell)` cells. `marginM = 60`, which is 2 cells at 30 m.
- Masked cells are impassable, and graph nodes in masked cells are blocked.

**Endpoints.**
- If the start or end cell is impassable (code 255), spiral outward to the nearest passable, unmasked cell within 150 m. The note `SNAP_MOVED` records the distance. Nothing within 150 m → `no-path`, with message "No walkable ground within 150 m of A".
- If A's or B's cell is masked and avoidance is on, avoidance is **turned off for this route**, with the note `ENDPOINT_IN_PERIM`. The route is still computed; this is not an error.

**Hybrid A\*.** The state space is window cells ∪ graph nodes in the window.
```
h(u)         = hypot(ux−bx, uy−by) · H_PACE,  H_PACE = 0.70 s/m    (≤ min pace anywhere ⇒ admissible & consistent)
cell→cell    (8-nbr; optional 16 with knight moves that also require both cut cells passable)
  dh = cell·(diag ? √2 : 1);  dz = dem[v] − dem[u];  d3 = √(dh² + dz²);  θ = atan2(dz, dh)°
  cost = d3 · ½(P[code[u]] + P[code[v]]) · α(θ)
  forbidden if code[u|v] ≥ 255, mask[v], or (diagonal && both orthogonal cut cells impassable/masked)
cell↔node    (portal; join/leave the trail anywhere)
  cost = dist(node, cellCenter) · P[code[cell]]   (both directions; forbidden if code[cell] == 255 or masked)
node→node    (graph edge, precomputed per direction at load)
  θ = atan2(Δz, d)° clamped ±40;  cost = d3 / r_M(θ) · sacFactor(way)
seed          g[startCell] = dist(A, center(startCell)) · P[code[startCell]]
goal          endCell; total = g[endCell] + dist(center(endCell), B) · P[code[endCell]]
```
**Passes:**
1. Window = bbox(A, B) padded by `clamp(0.5·|AB|, 2 km, 15 km)`, clamped to the grid. w = 1.0, cap 2.5M settled.
2. If the open set was exhausted (no path inside the window): the full grid, w = 1.2, cap 4M.
3. If pass 1 hit the cap instead: the same window with w = 1.6, cap 2.5M. The note `WEIGHTED` says "near-optimal".

If pass 2 or 3 fails, the result is `no-path` if the open set was exhausted and `budget` otherwise.

**Slicing.** The search is a generator that yields every 40,000 settled nodes. The worker then awaits a `MessageChannel` tick. If a newer `route` message arrived, the old search stops and replies `superseded`. Marker drags stay responsive this way, and a `progress` message goes out with each slice.

**Smoothing** (`smooth.ts`) runs only on cross-country runs, meaning the maximal sub-paths between graph legs or between A/B and a graph leg:
- greedy line of sight from index i;
- try j from `min(i+64, end)` down to i+2;
- accept the first j whose straight segment, sampled every ½ cell, touches no impassable or masked cell and whose sampled cost is ≤ the original cost from i to j, plus 0.5%.

The smoothed geometry and its recomputed cost are what get reported, so smoothing can never make a route more expensive. Desktop time is 0.3–2 ms per path.

**Legs** (`legs.ts`):
- The path is split into runs: cross-country (cells and portals) and graph (edge sequences). Graph runs are split further whenever `way.name/ref` or `kind` changes.
- `kind` comes from `way.cls`: 1–3 → `'road'` (3 is labelled "4WD track"), 4–6 → `'trail'`.
- A cross-country run under 50 m **between two graph runs** is kept for rendering with `minor: true`: no step, no join marker. It still counts toward the cross-country totals.
- Each cross-country leg records:
  - `vegM` (horizontal metres by class, sampled every ≤ 15 m on the smoothed line);
  - `vegRuns` (index ranges of constant class, for painting);
  - `streamCrossings` (entries into cells with `0x10` set);
  - climb and descent from the DEM sampled bilinearly every 15 m.
- Graph legs take climb and descent from node z.
- **Climb filter:** 3 m hysteresis (accumulate only once the change from the anchor is ≥ 3 m).
- Output is lon/lat via `utmToLonLat` for every vertex. The first vertex is exactly A and the last exactly B.

**Vegetation image.** `{t:'veg', maxWidth: 2048}` → RGBA from `veg & 0x0f` through `vegClasses` paint LUT with nearest downsampling. Pixels with `0x10` set are painted as stream `#2f8fd8`, and alpha is 255. The buffer is transferred.

### 4.5 Cost and time math (`costModel.ts`; the worker's `cost_grid.py` mirrors the GET and pace-code parts)
```
Sullivan 2020 Lorentz rate (m/s), θ = directional slope in degrees (signed, + uphill):
  r(θ) = c / (π·b·(1 + ((θ − a)/b)²)) + d + e·θ
  LOW  a=−3.3717 b=25.8255 c=92.6594 d=−0.1624 e= 0.0019   (flat 0.961 m/s)
  MOD  a=−2.8292 b=20.9482 c=77.6346 d= 0.2228 e=−0.0004   (flat 1.381 m/s)
  HIGH a=−2.2893 b=19.4024 c=65.3577 d= 0.6226 e=−0.0020   (flat 1.680 m/s)
  θ clamped to [−40, 40]; r ≥ 0.10 m/s.
GET v2 isotropic off-trail rate, σ = terrain slope in degrees:
  rGET(σ) = (0.0065σ² + 80.8887)/(0.1402σ² + 70.3892)      (σ=0 → 1.149; 30 → 0.441; 45 → 0.265)
Pace code: P(code) = 0.8 · 640^((code−1)/253) s/m, codes 1..254; 0 and 255 impassable.
Anisotropy (off-trail), round-trip-preserving:
  pM(θ) = 1/r_MOD(θ);   α(θ) = 2·pM(θ) / (pM(θ) + pM(−θ))        ⇒ (α(θ)+α(−θ))/2 = 1, α(0) = 1
  (e.g. α(±15°) = 1.104 / 0.896; α(±30°) = 1.100 / 0.900); LUT at 0.5° over [−60°, 60°].
Tertile ratios for ranges:  ρ_fast(θ) = r_MOD(θ)/r_HIGH(θ),  ρ_slow(θ) = r_MOD(θ)/r_LOW(θ)   (flat: 0.822 / 1.437)
Times:
  trail/road edge:  t_k = d3 / r_k(θ) · sacFactor          (k = HIGH→fast, MOD→typical, LOW→slow)
  off-trail step:   t_MOD = d3 · P · α(θ);  t_fast = t_MOD · ρ_fast(θ);  t_slow = t_MOD · ρ_slow(θ)
sacFactor (OSM sac_scale, Valhalla's time multipliers): T1–T2 = 1.0, T3 = 1.54, T4 = 2.5, T5 = 4.0, T6 = 6.67.
H_PACE = 0.70 s/m  (< 1/1.404 trail peak and < 0.842 minimum off-trail pace).
Display: typical = Σ t_MOD; range = [Σ t_fast, Σ t_slow]; rounding: < 60 min → nearest min, else nearest 5 min.
Units: miles (0.1), climb/descent in feet (×3.28084, nearest 10 ft) — matching the app's miles-only directions.
```
The off-trail typical time is GET v2's median-hiker rate × multipliers, and it is deliberately not rescaled to the crews' faster base. GET's expert multipliers were calibrated on that base and are described as conservative. The range scaling adds crew spread without discarding that caution.

### 4.6 RouteResult extension and Walk orchestration
`api/routing.ts` changes are additive, so existing consumers keep working:
```ts
export type RouteEngine = 'tomtom'|'osrm'|'ors'|'valhalla'|'offroad';
export interface RouteLeg {
  kind: 'road'|'trail'|'net'|'xc'|'gap';           // net = online-engine segment of unknown type
  coordinates: [number, number][];
  distanceM: number; climbM: number; descentM: number;
  durationS: number | null;                         // null for 'gap' (untimed)
  durationRangeS?: [number, number];
  name?: string|null; ref?: string|null; source?: 'osm'|'usfs'|'blm'|'nps';
  restricted?: 'admin-only'|'foot-not-listed'|'seasonal'|'closed'|null;
  vegM?: Partial<Record<number, number>>;          // xc only
  vegRuns?: { veg: number; from: number; to: number }[];
  streamCrossings?: number; minor?: boolean; modeled?: boolean;
}
export interface RouteNote { level: 'info'|'warn'; code: string; text: string }
export interface RouteResult {                     // existing fields unchanged; geometry = all legs concatenated
  …; engine: RouteEngine;
  legs?: RouteLeg[]; durationRangeS?: [number, number]; modeled?: boolean; notes?: RouteNote[];
  provenance?: { bundleId: string; builtAt: string; perimeterDate: string|null; avoidPerimeter: boolean;
                 cellM: number; weighted: boolean; ms: number };
}
export async function routeHikeOnline(a: LonLat, b: LonLat): Promise<RouteResult>   // the existing ORS→Valhalla branch, exported
```
For offroad routes, `durationS` is the typical time, so the existing mode-button time and summary keep working. `steps` is built from the legs so the type stays consistent.

**`api/walkRouting.ts`:**
```ts
export interface WalkContext { corneaId: string|null; online: boolean; avoidPerimeter: boolean;
  getPerimeter(): Promise<{ feature: PerimeterFeature; path: string; date: string } | null>;   // queryClient.fetchQuery, same keys as usePerimeterIndex/Version; 5 s timeout
  hotspots: HotspotFeatureCollection | null; nowMs: number }
export class WalkError extends Error { code: 'offline-no-bundle'|'offline-not-packed'|'outside-area-offline'|'no-path'|'budget'|'load-failed'|'online-failed'; retryWithoutPerimeter?: boolean }
export async function routeWalk(a, b, ctx): Promise<RouteResult>
```
1. `entry = ctx.corneaId ? await getRoutingEntry(ctx.corneaId) : null`, then `bundle = entry ? await getBundle(entry) : null`. Fetch failures count as null.
2. If `bundle` and both A and B are `insideRoutingArea(bundle, …)`:
   - `perim = ctx.avoidPerimeter ? await ctx.getPerimeter() : null`;
   - `await offroadClient.ensureBundle()`, then `setPerimeter`, then `route`;
   - convert to a RouteResult with `engine:'offroad'`, `modeled:true` and notes (§4.8);
   - on `no-path`, throw a WalkError with `retryWithoutPerimeter = avoidPerimeter`.
   - **This case never falls back to the online engines.**
3. Else if `!ctx.online`, throw one of:
   - `outside-area-offline` if a bundle exists;
   - `offline-not-packed` if the index is known but no bundle is cached;
   - `offline-no-bundle` otherwise.
4. Online: `base = await routeHikeOnline(a, b)`. Then compute `gapA = dist(a, base.start)` and `gapB = dist(b, base.end)` with a local equirectangular approximation. For each gap over 25 m:
   - if the bundle is present and both ends of the gap are inside the area, run an offroad route over the gap, giving modeled cross-country legs (their time is added and flagged);
   - otherwise add a `'gap'` leg on a straight line: untimed, with note `GAP_UNTIMED`.

   The engine segment itself becomes one `'net'` leg. Always add the note `ONLINE_NO_PERIM`, and run `crossesPerimeter` against the latest perimeter; a crossing adds `CROSSES_PERIM` (warn).
5. Safety notes for all routes: `PERIM_OLD` when the perimeter is over 12 h old, and `HOTSPOT_NEAR` for any VIIRS/MODIS detection under 12 h old within 500 m of the route. Hotspots use a 500 m grid bucket, so the check is O(route + hotspots).

**SearchDirectionsControl.tsx: minimal diff**, since this file has WIP in the main checkout:
1. `const walk = useWalkRouting();` provides `ctxRef` and `walkKey = ${avoidPerimeter}|${latestPerimeterPath}`.
2. The fetch loop becomes `const run = p === 'hike' ? routeWalk(a.coords, b.coords, walk.ctx()) : fetchRoute(a.coords, b.coords, p);`, and the effect key becomes `${endpointsKey}|${walk.walkKey}`.
3. `.catch(err)` stores the error on `modes[p]` as `{failed: WalkError}` so the message is specific (§4.8).
4. Offline: skip the network profiles. `modes.drive` and `modes.apparatus` become `'offline'`, with the button title "Needs a connection" and the time label `—`.
5. The mode time label uses `~` plus the typical time when `route.modeled`.
6. When `route.legs` exists, render `<WalkRouteDetails route={route} onRetryWithoutPerimeter=… />` inside `.rd-sd-result`.
7. The Walk button's title reads "Walk: trail + cross-country model inside this fire's routing area (works offline); online engine elsewhere".

### 4.7 Route rendering (`routeLayer.ts`, pure builder `routeFeatures(route)`)
- **Source `rd-route`** (GeoJSON FeatureCollection), built per leg:
  - `road`, `trail` and `net` legs give LineString `{kind}`.
  - `xc` legs are split by `vegRuns` into LineStrings `{kind:'xc', veg}`.
  - `gap` legs give LineString `{kind:'gap'}`.
  - Every boundary between an `xc` leg and a road/trail leg (not `minor`) gives a Point `{kind:'join'}`.

  A legacy route with no `legs` becomes one feature `{kind:'road'}`, so drive and apparatus look unchanged.
- **Layers**, bottom to top, following the repo convention of one layer per dash class:
  - `rd-route-casing`: all LineStrings, `#0d0a0c`, 7 px, opacity 0.7.
  - `rd-route-line`: filter `kind in [road, trail, net]`, `#4aa3ff` 4 px solid (unchanged).
  - `rd-route-xc`: filter `kind == xc`, width 4, `line-dasharray [1.6, 1.2]`, `line-color` = `['match', ['get','veg'], 1,'#e3cf6f', 2,'#c9a25a', 3,'#9a6a33', 4,'#4f8a3c', 5,'#2f5f2a', 6,'#b4532a', 7,'#a6a6a6', 8,'#d9b9a3', 9,'#e6f2ff', '#bdbdbd']`, taken from `vegClasses`.
  - `rd-route-gap`: filter `kind == gap`, `#f2eff0` 3 px, `line-dasharray [0.4, 1.6]` (dotted, "straight line, not modeled").
  - `rd-route-joins`: circle radius 4.5, fill `#ffffff`, stroke `#0d0a0c` 2 px.

### 4.8 Summary, steps, labels, errors (`WalkRouteDetails.tsx`, `walk.css`)
**Summary** (offroad engine):
```
~2 h 05 min   (1 h 40 min – 2 h 50 min) · 4.2 mi · ↑ 1,240 ft ↓ 380 ft
▬ Trail & road 3.1 mi   ┅ Cross-country 1.1 mi                       (chips; widths ∝ share)
Cross-country: Timber 0.6 mi · Light brush 0.3 mi · Grass 0.2 mi · 1 stream crossing
⚠ Cross-country legs are modeled, not scouted.                         (always shown when modeled; not dismissible)
  Times assume a loaded crew in daylight and orderly travel. Scout and time escape routes with your slowest person.
☑ Avoid fire perimeter (Sep 24 06:10, +60 m)          [checkbox → directions.avoidPerimeter]
Terrain & trails: built Sep 24 · LANDFIRE 2024 · OSM Sep 23 · USFS Sep 23   · computed on this device in 0.4 s
Route data © OpenStreetMap contributors (ODbL) · USFS · BLM · NPS · LANDFIRE
[Steps ▾]
```
**Online fallback summary:** `1 h 50 min · 4.6 mi (online engine) + 0.5 mi cross-country not timed`, then the notes, then "Online route — does not avoid the fire perimeter."

**Steps** (`legs.ts` → `stepText`). The coordinate format matches the app's `lat, lon` to 5 decimals.
1. `Head cross-country NE 0.3 mi through timber, ↑ 210 ft — about 12 min (9–17)`
2. `Join Iron Creek Trail #640 (USFS) at 44.21230, -115.03410`
3. `Follow Iron Creek Trail #640 1.8 mi, ↑ 540 ft ↓ 60 ft — about 41 min (33–58) · Restricted: hiker 01/01–12/31`
4. `Continue on FS 619 0.6 mi` (road) / `Follow 4WD track 0.4 mi` (cls 3) / `Follow unnamed trail 0.2 mi`
5. `Leave the trail at 44.23011, -115.05920; go cross-country W 0.4 mi through light brush, crossing 1 stream`
6. `Arrive at B`

**Notes** (`RouteNote`; warn notes in amber, info notes muted):

| code | level | text |
|---|---|---|
| `ENDPOINT_IN_PERIM` | warn | "B is inside the fire perimeter mapped 9 h ago — perimeter avoidance is off for this route." |
| `PERIM_OLD` | warn | "Fire perimeter is 26 h old — the fire may have moved." |
| `HOTSPOT_NEAR` | warn | "Passes within 0.3 mi of a satellite heat detection from 4 h ago." |
| `CROSSES_PERIM` | warn | "This route crosses the latest mapped fire perimeter." |
| `ONLINE_NO_PERIM` | warn | "Online route — does not avoid the fire perimeter." |
| `GAP_UNTIMED` | warn | "+0.5 mi cross-country at the end (straight line, not modeled, not in the time)." |
| `SNAP_MOVED` | info | "A moved 45 m to the nearest walkable ground (open water or cliff at the pin)." |
| `WEIGHTED` | info | "Long search — route is near-optimal, not guaranteed shortest." |
| `COARSE_GRID` | info | "This fire's terrain model uses 60 m cells — small cliffs and gullies may be missed." |
| `NO_PERIMETER` | warn | "Fire perimeter unavailable — route does not avoid the fire." |
| bundle `warnings` | info | "Streams unavailable in this terrain build." / "Agency trails unavailable in this build — OSM trails only." |

**Errors** (replace the generic "No route found" for Walk):

| code | text | action |
|---|---|---|
| `offline-no-bundle` | "Offline walking routes aren't available for this fire yet." | — |
| `offline-not-packed` | "Download this fire (Overview tab) to route on foot without service." | link to Overview |
| `outside-area-offline` | "Offline, Walk routes only inside this fire's routing area (dashed box)." | "Show area" (fit bounds) |
| `no-path` | "No walkable route inside the routing area — cliffs, open water, or the fire perimeter block every path." | "Try without perimeter avoidance" when avoidance was on |
| `budget` | "Route search took too long on this device. Try closer points." | — |
| `load-failed` | "Couldn't load the terrain model on this device." | if online: "Use online route" |
| `online-failed` | "No route found — try different points." (existing) | — |

While the bundle loads, the status line reads "Loading terrain model for this fire · 6.2 MB…". While the search runs, "Computing walking route…" appears; the mode button shows `…`.

### 4.9 Vegetation and routing-area layers
- **`vegetationLayer.ts`** (self-driven). While `layers.vegetation.visible` is true and a bundle exists: `offroadClient.vegImage(2048)`, put the pixels in a `<canvas>`, then `addSource('rd-vegetation', {type:'canvas', canvas, coordinates: utmBoundsTo4326(bbox).corners, animate:false, attribution:'Vegetation: LANDFIRE'})`, then `addLayer({id:'rd-vegetation', type:'raster', paint:{'raster-opacity': opacity, 'raster-resampling':'nearest', 'raster-fade-duration':0}}, beforeIdFor(map,'rd-vegetation'))`. The layer resets when `corneaId` changes (the perimeterLayer.ts:58-64 pattern). It works offline because the bundle is in the pack.
- **`VegetationRow`:** a checkbox, an opacity slider shown only when on (the WeatherSection pattern, default 0.5), and a legend of the 10 chips from `vegClasses` plus a stream swatch. If the fire has no bundle, the checkbox is disabled and titled "Vegetation needs this fire's terrain model (not built yet)". `LegendBar` gets a compact vegetation row, and its early return is widened.
- **`routingAreaLayer.ts`:** `rd-routing-area` line from `bundle.corners4326` (closed ring), `#d8d2d5`, opacity 0.6, 1.2 px, `line-dasharray [3,3]`. Visible while `directions.profile === 'hike'` and the directions UI shows A or B. The Walk hint "Walk routes offline inside the dashed box" appears in the card when no route is shown.

### 4.10 Offline pack additions
- **`packModel.ts`:**
  - `PackInputs += { routingEntry: RoutingIndexEntry | null; routingBundle: RoutingBundle | null }`.
  - `snapshotUrls` pushes `routingIndexUrl()` (mutable, EST.json). This is the same resolver `bundleIndex.ts` uses, so the wrapper's exact-URL match holds.
  - `buildPackPlan` adds a section after IR flights. When both the entry and the bundle exist:
    ```ts
    files.push({ url: dataUrl(entry.descriptor), immutable: true, estBytes: EST.json });
    for (const k of ['grid','dem','graph','trails'] as const) {
      const f = bundle.files[k]; if (f) files.push({ url: dataUrl(f.path), immutable: true, estBytes: f.bytes });
    }
    ```
    None of these are `optional`: the descriptor lists only files that exist, and a hole would break offline Walk.
  - `PackPlan += { routingBytes: number }`.
- **`packs.ts`:**
  - Phase 1: `const routingIndex = await rawJson<RoutingIndex>(routingIndexUrl(), abort).catch(() => null)`, then `entry`, then `bundle` via `rawJson(dataUrl(entry.descriptor))` wrapped in `.catch(() => null)`. A missing index never fails a pack.
  - Export `packedFile(url): Promise<File | null>` (exact `urlIndex` lookup, then `opfs.getPackFile`).
  - **Range bypass** in `installOfflineFetch`.
  - `contentTypeFor`: `.gz` → application/gzip, `.pmtiles` → application/octet-stream.
  - `offline_pack_downloaded` gains `{routing: bool, routing_mb}`.
  - The pack-change listener calls `invalidateFireSource()`.
- **`opfs.ts`:** the extension regex adds `pmtiles|gz` (so `graph.bin.gz` is stored as `.gz`), and `getPackFile(slug, name): Promise<File|null>` is added.
- **`OfflineCard.tsx`:** the idle copy gets ", trails, and offline walking routes" appended when the catalog fire has a routing entry.
- **Sizes:** about 5–15 MB per fire, against about 30–60 MB for the existing packs. That is roughly 1 ToA tif's worth.

### 4.11 Analytics (`track`; rate limit 30/min)
- `walk_route_computed {engine, offline, xc_pct (nearest 10), km (rounded), ms_bucket ('<250'|'<1000'|'<3000'|'>=3000'), avoided_perimeter, weighted, notes: count}`. Sent once per final result; superseded and progress results never send.
- `walk_route_failed {code}`
- `offroad_bundle_loaded {cells_m (0.1), mb (rounded), ms_bucket, from_pack: bool}` (from_pack = the response carried `x-rd-offline`)
- `layer_toggled {layer:'trails'|'vegetation', on}` (existing event name)
- `trail_popup_opened {agency}` via `trackOncePer('fire-view', …)`
- `walk_here_used {}` via `trackOncePer`
- No coordinates, names or IDs beyond agency are ever sent.

### 4.12 Sources, credits, attribution
- **`SourcesView` SOURCES += :**
  - "USDA Forest Service: National Forest System Trails (EDW)", `data.fs.usda.gov/geodata/edw`
  - "Bureau of Land Management: Ground Transportation Linear Features (GTLF)"
  - "National Park Service: Public Trails"
  - "OpenStreetMap contributors (ODbL)", with a link to `openstreetmap.org/copyright`. The text says routing roads and paths come from OpenStreetMap via Geofabrik extracts, and the derived routing data is published under ODbL.
  - "LANDFIRE (USGS/USFS/DOI): vegetation type, cover, fuel models, elevation and slope"
  - "USGS National Hydrography Dataset"
  - Research credit entries: "Sullivan et al. 2020 (crew travel rates)" and "Campbell et al. 2024, Ground Evacuation Time v2 (off-trail cost)".
- **Map attribution:** `rd-trails` gets `Trails: USFS · BLM · NPS`, plus `· © OpenStreetMap contributors` on the fire extract. `rd-vegetation` gets `Vegetation: LANDFIRE`. The route attribution line sits in the result card. The `rd-route` source is not tagged: TomTom and OSRM routes share it, and a map-corner OSM credit on them would be inaccurate.
- **ODbL:** `graph.bin.gz` and the `ways` layer are Derivative Databases. They are publicly downloadable from B2, with `routing/README.txt` stating the ODbL licence and the format. The displayed routes (Produced Works) carry the attribution line.

### 4.13 Built-ins considered (per the owner's "say why not" rule)
- **Routing:** MapLibre has no routing. Valhalla-WASM builds (1.8–2.1 MB gz, weeks old) can't do raster legs, so a custom grid router is needed anyway. The hand-rolled typed-array A* is about 150 lines, and the measured work at our sizes is under 100 ms on desktop.
- **Vector tiles offline:** MapLibre fetches vector tiles in its own worker, which bypasses the OPFS wrapper. We use MapLibre's built-in `addProtocol`, which routes to the main thread. PMTiles isn't native to MapLibre 5.24, hence the `pmtiles` package or the lite reader.
- **Class raster colours:** MapLibre 5.24 has no `raster-color`, so the colours are painted on a canvas, matching the existing spread layer.
- **Dashed legs:** the installed style spec allows data-driven `line-dasharray`, but the repo convention is one layer per dash class (drawLayer.ts). This design follows the convention.
- **Elevation:** `map.queryTerrainElevation` is viewport-bound, multiplied by the exaggeration, and returns 0 on unloaded tiles. It is unusable in a worker or offline, so the DEM ships in the bundle.

---

## 5. Testing and verification

### 5.1 Worker (pytest, `worker/tests/`; GDAL tests skip when tools are absent)
| Test file | Covers | Fixtures |
|---|---|---|
| `test_utm.py` | `fwd`/`inv` round trip < 1 mm; known points; agreement with `gdaltransform` < 0.01 m (GDAL-guarded) | — |
| `test_gdalio.py` | ENVI read and VRT/GTiff write round trip: georef, dtype, nodata, band names | synthetic arrays |
| `test_pmtiles_check.py` | header fields, directory decode incl. run-length and zero-offset, max tile per zoom | `fixtures/tiny.pmtiles` (about 20 KB, built once with GDAL, committed) |
| `test_trails_normalize.py` | USFS grade (`'TG05 - +12-20%'`→`'12–20%'`, `'TRAIL_GRADE'`→None), width (`'TW03 - 18-24 INCHES'`→21), uses (`'54321'`→`H,P,B,M,A`; `'N/A'`→''), foot yes/no/unknown, restriction dates with trailing spaces; BLM case variants and access codes; NPS drop rules (Decommissioned/Proposed/Water Trail), `'Class 3'`→3, TRLUSE pipes | real captured rows: `fixtures/trails/{usfs,blm,nps}_rows.csv` (about 40 rows each) |
| `test_trails_build.py` (GDAL) | the sidecar join on a tiny GPKG → `trails_norm`; PMTiles build (`z7–9` for speed) → `pmtiles_check` OK; FGB readable with `-spat` | tiny source GPKGs |
| `test_routing_plan.py` | AOI buffer and min side; the 30→60 m switch; clip at 150 km; hysteresis containment; never shrink; `inputs_key` stability; priority buckets; backoff; region-affine shard assignment; deferral | fire records, pointer JSONs, a Geofabrik index excerpt |
| `test_geofabrik.py` | leaf selection (norcal/socal instead of california); a state-line AOI picks 2 regions | `fixtures/geofabrik_index_excerpt.json` |
| `test_landfire.py` | 5070 snapping to the CONUS grid origin; request params; LF2025 all-nodata detection; WCS 32767 → −9999; fallback order (MockTransport) | tiny TIFFs |
| `test_nhd.py` | TNM API parsing → HU8 list; cache hit and miss on DryRunStorage | `fixtures/tnm_nhd.json` (captured) |
| `test_cost_grid.py` | multipliers for every class, SB 5×, TL 2×, stream 5×, shrub cover interpolation, impassable rules, pace-code encode/decode vs `fixtures/pace_code_table.json` (also copied into the frontend), veg precedence | synthetic arrays |
| `test_graph_build.py` | junction split by node ID (bridge crossing without a shared node stays unconnected); densify ≤ cell; conflation drops the duplicate OSM path only; dead-end and crossing connectors; z smoothing; RDG1 header and section offsets; `read_rdg1(write_rdg1(g)) == g`; deterministic gzip bytes | synthetic ways |
| `test_routing_bundle.py` (GDAL) | `build_fire` with fetchers monkeypatched to fixture rasters and ways, run on DryRunStorage: key set, **upload order (pointer last)**, descriptor fields and bytes/sha256, state doc on failure | tiny rasters |
| `test_routing_index.py` | index from pointers; recipe filter; README written; health section | pointer JSONs |
| `test_cli_routing.py` | `cmd_routing_plan` writes `GITHUB_OUTPUT` matrix; `cmd_routing_one --aoi` wiring (monkeypatched) | — |

**Cross-language fixture.** `worker/scripts/make_frontend_fixture.py` builds `frontend/src/routing/__fixtures__/tiny/` from synthetic arrays through the **real writers**:
- `grid.tif`, `dem.tif`, `graph.bin.gz`, `bundle.json`;
- `expected_routes.json`: the Python reference Dijkstra's costs for 6 A/B pairs, using the same cost formulas, under 100 lines in `scripts/ref_dijkstra.py`;
- `pace_code_table.json`.

The grid is 200 × 150 cells with a ridge, a lake, a perennial stream, a slash patch and 3 trails, one of which duplicates an OSM path.

### 5.2 Frontend (vitest, node)
| Test | Covers |
|---|---|
| `routing/costModel.test.ts` | Sullivan HIGH min/km at −30/−15/0/+15/+30 = 16.1/11.9/9.9/14.0/19.7 (Table 4, ±0.1); flat rates 0.961/1.381/1.680; rGET(0/30/45); the α symmetry property; pace LUT equals the shared JSON; H_PACE ≤ every minimum pace |
| `routing/graphFormat.test.ts` | parses `tiny/graph.bin.gz` (zlib gunzip in node); node counts; CSR degree sums; ways and strings |
| `routing/rasterize.test.ts` | square → cell count; hole; MultiPolygon; margin dilation |
| `routing/astar.test.ts` | uniform grid gives a straight-ish path; wall with gap; lake detour; prefers the trail when faster; joins and leaves the trail mid-edge; mask blocks, and an endpoint in the mask disables it with a note; impassable endpoint snaps ≤ 150 m; cap → weighted; **A\* cost == Dijkstra cost** on 50 random small grids; 8 vs 16 neighbours |
| `routing/smooth.test.ts` | cost never increases; never crosses impassable or masked cells; vertex reduction |
| `routing/legs.test.ts` | kinds, minor-leg absorption, `vegM` sums to xc distance ±1 m, fast ≤ typical ≤ slow, climb hysteresis, step text snapshot |
| `routing/engine.test.ts` | end to end on `tiny/`: load → route for the 6 pairs; costs within 0.5% of `expected_routes.json` (the smoothing tolerance); `veg` image size |
| `routing/safetyChecks.test.ts` | crossing detection, hotspot proximity and age filter |
| `spread/utm.test.ts` | forward/inverse round trip < 1 cm across zones 10–19 and in the southern hemisphere |
| `api/walkRouting.test.ts` | decision table: inside/outside × online/offline × bundle yes/no × no-path; gap leg creation; no online fallback on `no-path` (fetch and worker client stubbed) |
| `map/layers/trailsStyle.test.ts` | paint per ground key; `groundKey` resolution; popup escaping; uses and restriction text |
| `map/layers/routeLayer.test.ts` | `routeFeatures`: legacy route → 1 road feature; xc split by `vegRuns`; join points |
| `map/pmtilesLite.test.ts` (fallback only) | reads `tiny.pmtiles` shared with the worker; tile at a known z/x/y decompresses to an MVT starting with `0x1a` |
| `offline/packModel.test.ts` | the routing section: descriptor and 4 files immutable, index snapshot mutable, absent entry → no section, bytes from the descriptor |
| `app/urlState.test.ts`, `map/zOrder.test.ts`, store slice test | `trl`/`veg` round trip; new ids in the right groups; toggle and reset rules |

### 5.3 Verification plan
1. **Worker, local (GDAL 3.13 via brew).**
   - `cd worker && uv sync && uv run pytest -q`
   - Stanley test AOI (not a fire; matches the research's R1 pair):
     ```
     uv run python -m responder_worker.cli routing-one --aoi -115.25,43.95,-114.63,44.40 --name stanley-test --dry-run --out $SCRATCH/out --keep-work $SCRATCH/work
     ```
     The session scratchpad already holds `dataapi/idaho.osm.pbf` and LANDFIRE samples, usable via `--local-pbf`/`--local-lf` debug flags. **Expected:** the route from Iron Creek TH (44.19870, −115.01402) to Stanley Lake TH (44.24711, −115.06576) follows Iron Creek–Stanley Lake Trail and Alpine Way #528 (about 14 km), not the 15.2 km road route. If the road is chosen, its typical time must be within 5% of the trail route and the trail must be the second option.
   - Rocky Mountain summit (MT) AOI: the route from South Fork Teton TH ends **at** the summit, with a modeled cross-country leg of about 0.8 km plus climb.
   - A real fire:
     ```
     routing-one --fire <largest active by acres in catalog.json at run time, e.g. 0445-crosswhite> --dry-run
     ```
     Also run a small fire (< 1,000 acres) and one near a state line.
   - Inspect with `gdalinfo -stats grid.tif dem.tif` and QGIS (veg palette), `uv run python scripts/inspect_rdg1.py graph.bin.gz` (counts, km by class, a GeoJSON dump for QGIS), and `pmtiles_check`.
2. **Worker, real GDAL 3.8.4.** Dispatch `trails.yml` and `routing.yml` with `dry_run: true` (routing with `fire=<id>`). The `worker/out` artifact is downloaded and inspected the same way. This is the only way to confirm the 3.8.4 PMTiles path (temp mbtiles and MAX_SIZE) and the pyosmium wheel on the runner.
3. **Frontend unit.** `cd frontend && npx vitest run && npx tsc --noEmit`.
4. **Static build preview**, following project memory (the dev server can't launch from ~/Desktop):
   ```
   python3 worker/scripts/serve_out.py --dir $SCRATCH/out --fallback https://f005.backblazeb2.com/file/responder-debrief-data --port 8871
   cd frontend && VITE_BASE=/ VITE_DATA_BASE_URL=http://localhost:8871 npx vite build --outDir $SCRATCH/preview-walk --emptyOutDir
   python3 $SCRATCH/spa_server.py $SCRATCH/preview-walk 4231
   ```
   `serve_out.py` is a stdlib server (about 80 lines) that serves local dry-run keys, proxies everything else to real B2, and supports **Range and CORS**. Use a port no earlier session used; 4231 is proposed. Then `preview_start {url: http://localhost:4231/fire/<id>}` (with the user's OK, since the preview tool reads the main checkout's launch.json).

   Scenarios, each with pass criteria:
   - (a) The Trails toggle works on topo, satellite, Dark Matter and Positron. The popup shows agency, uses and restrictions, and "Walk here" sets B with profile Walk.
   - (b) A Walk route inside the area shows solid trail legs, dashed veg-coloured cross-country legs, join dots, the range, the split, the permanent label and working steps.
   - (c) Perimeter avoidance: a route that must detour around the perimeter; B inside the perimeter gives the note and a route.
   - (d) Outside the area online: the online route plus a dotted gap and the `ONLINE_NO_PERIM` note.
   - (e) "Download this fire", then go offline with `Object.defineProperty(navigator,'onLine',{get:()=>false}); dispatchEvent(new Event('offline'))` and stop `serve_out.py`. Trails and ways render from the pack; Walk routes offline; the vegetation layer works; outside the area gives the offline error.
   - (f) Phone: `resize_window` mobile preset plus a 4× CPU-slowdown proxy. Targets are bundle load < 2.0 s and a 5 km route < 1.0 s, both read from the result card's `data-ms` attribute and the status line. No main-thread long task over 100 ms during a route.
   - (g) Marker drag: rapid drags produce no stale route and the UI stays responsive.
5. **UI review.** Run a Diffalo review of the Walk card, the Layers rows and the map legs, per the project skill.

---

## 6. Implementation slices (parallelizable; minimal file overlap)

The contracts are App. A (RDG1), App. B (trails schema), App. C (pace/veg codes) and §2.2–2.5 (JSON). Everyone codes against these.

### Worker
| Slice | Files (new unless *) | Depends on | Acceptance | Tests |
|---|---|---|---|---|
| **W1 Foundations** | `utm.py`, `gdalio.py`, `pmtiles_check.py`, `http.py*` (`download_to`), `config.py*` (rules, types, constants), `b2.py*` (`max_pool_connections=16`, `list_common_prefixes`), `cli.py*` (only calls `cli_trails.register`/`cli_routing.register` as stubs), `cli_trails.py`/`cli_routing.py` (stubs), `pyproject.toml*`/`uv.lock*` (numpy, osmium), `fixtures/tiny.pmtiles` | — | `content_type_for_key`/`cache_control_for_key` for every new key; ENVI round trip; PMTiles fixture summary | `test_utm`, `test_gdalio`, `test_pmtiles_check`, config tests |
| **W2 Trails** | `trails_normalize.py`, `trails.py`, `cli_trails.py`, `.github/workflows/trails.yml`, fixtures | W1 | a local dry run publishes `trails/v/*` and `latest.json` last; the count guard works; pmtiles_check passes; a dispatch `dry_run` on the runner succeeds | `test_trails_normalize`, `test_trails_build` |
| **W3 Plan** | `geofabrik.py`, `perimeters.py`, `routing_plan.py`, `cli_routing.py` (`routing-plan`) | W1 | `plan.json` for the live fire list in < 2 min; stable keys; region-affine shards; matrix output | `test_routing_plan`, `test_geofabrik`, `test_cli_routing` (plan part) |
| **W4 Cost grid** | `landfire.py`, `nhd.py`, `cost_grid.py`, `data/landfire_evt_lf.json`, `scripts/build_landfire_luts.py`, `fixtures/pace_code_table.json` | W1 | the Stanley box produces grid.tif and dem.tif matching the georef; class shares plausible (Tree ≈ 40%, Shrub ≈ 30%); impassable ≈ 2% | `test_landfire`, `test_nhd`, `test_cost_grid` |
| **W5 Graph** | `osm_ways.py`, `graph_build.py`, `scripts/inspect_rdg1.py`, `scripts/make_frontend_fixture.py`, `scripts/ref_dijkstra.py` | W1 (W4 only for the fixture's rasters; synthetic until then) | Idaho PBF + Stanley AOI → RDG1 with about 2k OSM ways split exactly; conflation stats; frontend fixture committed | `test_graph_build` |
| **W6 Orchestration** | `routing_bundle.py`, `routing_index.py`, `cli_routing.py` (build/one/index/prune), `.github/workflows/routing.yml`, `scripts/serve_out.py`, README texts | W2 (contract), W3, W4, W5 | `routing-one` for Stanley and one real fire; pointer written last; index lists bundles; health section; the dispatch `dry_run` artifact is valid | `test_routing_bundle`, `test_routing_index`, `test_cli_routing` |

### Frontend
| Slice | Files | Depends on | Acceptance | Tests |
|---|---|---|---|---|
| **F0 Scaffolding** (lands first; the only slice touching the files with WIP in the main checkout) | `zOrder.ts*` (all new ids), `store.ts*` (`layers.trails{mode}`, `layers.vegetation{visible,opacity}`, `directions.avoidPerimeter` + actions + reset rules), `urlState.ts*` (`trl`, `veg`), `useMapLayerSync.ts*` (MANAGERS += 3 stub managers; INTERACTIVE += `rd-trails-hit`), stub `trailsLayer.ts`/`vegetationLayer.ts`/`routingAreaLayer.ts`, stub `panels/layers/{TrailsRow,VegetationRow}.tsx`, `ForecastTab.tsx*` (renders the rows), `vite.config.ts*` (`worker:{format:'es'}`), `package.json*` (pmtiles, if approved) | — | `tsc` and `vite build` green with stubs; purely additive diffs | `zOrder`, `urlState`, store tests |
| **F1 Routing core** | `routing/{types,costModel,vegClasses,graphFormat,heap,rasterize,astar,smooth,legs,safetyChecks}.ts`, `spread/utm.ts*` (forward) | contracts (TS synthetic fixtures until W5's lands) | all pure tests; A\* matches Dijkstra | §5.2 rows 1–8 |
| **F2 Engine & client** | `routing/{gridLoad,engine,offroad.worker,offroadClient,bundleIndex}.ts` | F0 (vite worker), F1, W5 fixture | `engine.test` passes on `tiny/`; the worker builds in `vite build` with geotiff decoder chunks under `/assets` | `engine.test.ts` |
| **F3 Walk UX** | `api/routing.ts*`, `api/walkRouting.ts`, `panels/walk/{useWalkRouting.ts,WalkRouteDetails.tsx,walk.css}`, `SearchDirectionsControl.tsx*` (§4.6 minimal diff), `map/layers/routeLayer.ts*`; optional stretch: "Download GPX" button (Blob, `<trk>` with legs as segments) | F1, F2, F0 | scenarios (b)–(d) and (g) of §5.3; drive and apparatus unchanged | `walkRouting.test`, `routeLayer.test` |
| **F4 Trails layer** | `map/{pmtilesSource,pmtilesLite?,trailsTypes}.ts`, `map/layers/{trailsStyle,trailsLayer}.ts`, `panels/layers/TrailsRow.tsx`, `api/queries.ts*` (`useTrailsLatest`, key `['trails-latest']`, staleTime 30 min), `SourcesView.tsx*`, `.github/workflows/deploy-pages.yml*` (optional `VITE_DATA_RANGE_BASE_URL`) | F0; F6's `packedFile` signature (stub OK); W2 output (or a local archive via `serve_out.py`) | scenario (a) and the trails half of (e) | `trailsStyle.test`, `pmtilesLite.test` (fallback) |
| **F5 Vegetation & area** | `map/layers/{vegetationLayer,routingAreaLayer}.ts`, `panels/layers/VegetationRow.tsx`, `LegendBar.tsx*` | F0, F1 (`vegClasses`), F2 (veg message) | vegetation matches QGIS for the same bundle (spot check 5 points); area box aligns with the grid | legend/LUT test |
| **F6 Offline pack** | `offline/packModel.ts*`, `offline/packs.ts*`, `offline/opfs.ts*`, `panels/OfflineCard.tsx*` | contracts (`routing/types.ts` from F1; F6 may land the types file first if F1 lags) | a pack contains index, descriptor and 4 files; the Range bypass is proven in the browser; `packedFile` returns a File; pack update re-downloads only a new bundle | `packModel.test` |
| **F7 Health** | `api/types.ts*` (HealthDoc `trails?`, `routing?`), `panels/HealthView.tsx*` (rows "Trails build" and "Routing bundles"; per-workflow runs endpoint so a weekly workflow doesn't scroll out) | W2/W6 health shapes | `/health` shows both sections | type-only |

**Order and critical path:** W1 → (W2 ∥ W3 ∥ W4 ∥ W5) → W6; F0 → (F1 → F2 → F3) ∥ F4 ∥ F6 ∥ F7, with F5 after F2. The end-to-end integration point is W5's fixture, which feeds F2.

**Merge etiquette:** F0 is rebased onto main after the hotspot-flames WIP lands. It then also adds `'rd-trails-hit'` to `pinDrop.ts` `FEATURE_LAYERS` and keeps `rd-hotspot-flames` in place. All other slices avoid `geo.ts` and `panels.css`, since new styles live in `walk.css` and row-level CSS modules.

---

## 7. Risks, open questions, non-goals, and research conflicts

### 7.1 Risks (and mitigations)
- **Phone memory and CPU.** The data arrays are ≤ 25 MB, plus the graph (~10 MB), plus window arrays. The worst case is the largest fires at 6.25M cells on older iPhones. Mitigations: the 60 m switch, window-local search arrays, idle termination, and passing `load-failed` to online as the fallback. Verification scenario (f) measures this. Not measured on real phones yet.
- **geotiff DEFLATE decode speed** on phones (pako, JS) could be 0.5–1.5 s for ~11 MB decoded. It runs off the main thread and only once per session. The contingency is a raw+gzip grid decoded with the native `DecompressionStream`; that would be a format change with a recipe bump.
- **LANDFIRE exportImage** is anonymous but not a documented programmatic channel, and its rate limits are unknown. Mitigations: sequential requests with WCS fallback, and bundles simply retry later.
- **GDAL 3.8.4 PMTiles:** silent MAX_SIZE degradation (guarded by pmtiles_check), temp-disk spikes (`CPL_TMPDIR`, `df -h`), and a possible `ubuntu-latest` jump (runs-on is pinned).
- **The EDW weekly refresh may stall** (live notice). The count guard and `src_date` in popups make this visible rather than wrong.
- **DEM and slope limits.** LF2020 at 30 m smooths short cliff bands, so steep cross-country legs are optimistic. The `COARSE_GRID` note covers 60 m grids, and the permanent label covers the rest. 3DEP is future work (§7.3).
- **Perimeter staleness:** handled by the `PERIM_OLD` and `HOTSPOT_NEAR` warnings and the 60 m margin. The model still doesn't know live fire behaviour.
- **Router quality at trail junctions without noding.** Portals and connectors tolerate gaps, with a small off-trail penalty of about 1–2 min per missed junction. The conflation threshold (15 m / 80%) may drop a legitimately parallel OSM path. Drops are logged in stats and can be tuned.
- **GitHub scheduling jitter and the 6 h job cap:** plans are resumable and deferral is explicit. Health shows `deferred` and `oldest_bundle_days`.
- **health.json read-modify-write race** with the catalogs and mirror jobs is cosmetic (§3.3).
- **OPFS File snapshot invalidation** after a pack update: `invalidateFireSource()` on pack change, plus a retry on NotReadableError.
- **Exact-URL pack matching:** every URL comes from shared resolvers (`routingIndexUrl`, `dataUrl`). In local previews `DATA_BASE_URL` must be absolute (which `serve_out.py` provides).
- **Geofabrik volume during backfill** is about 4–6 GB once, then small.

### 7.2 Open questions for the owner
1. Approve the npm `pmtiles` package (7.7 kB gz, plus fflate)? If not, ship `pmtilesLite.ts`.
2. Approve the worker dependencies `numpy` and `osmium`?
3. ODbL posture: publishing the OSM-derived graph and ways publicly under ODbL, with the attribution line in the route card. OK?
4. Safety wording: approve the label and notes text. Should "modeled, not scouted" wording also apply to online engines?
5. Defaults: a 60 m perimeter margin; hotspots **warn only** in v1 (avoidance would block many valid routes); trails `'auto'` (on only on the offline ground).
6. Set `VITE_DATA_RANGE_BASE_URL` to the S3 endpoint for cached range reads?
7. Refresh cadence: 14-day bundle age, growth hysteresis of 2 km, a 6-day minimum between trail builds. Acceptable?
8. Penalize USFS class-1 trails, or add seasonal-closure weighting? v1 applies neither; the information appears in popups and steps.
9. Pack size: +5–15 MB per fire. Should the Download card show the estimate (non-goal for v1)?
10. Derived-data pruning stays manual-only. Confirm.

### 7.3 Explicit non-goals (v1)
- AK, HI and PR bundles (the LANDFIRE `_AK/_HI/_PRVI` services and the Geofabrik regions exist for v2).
- Vehicle off-road routing; changes to Drive or Apparatus.
- Fire-spread-aware routing (avoiding cells with forecast arrival under N h) and escape-time isochrones. Both are natural v2 features on the same engine.
- Current-season NIFS event lines (dozer and hand line); these are restricted.
- State and local trail aggregators and USGS NDT; OSM covers non-federal trails.
- An offline basemap or hillshade. The per-fire OSM `ways` layer is a byproduct, not a basemap; Protomaps PMTiles remains the separate plan.
- Turn-by-turn navigation, GPS-follow rerouting, multi-waypoint routes.
- Lidar-based STRIDE density modeling, and 3DEP 10 m / 1 m DEMs (future recipe v2).
- Tap popups on the vegetation layer.

### 7.4 Where research facts conflicted, and what was chosen
| Conflict | Chosen | Why |
|---|---|---|
| GET v2 slash/blowdown multiplier: 5× (table and overview) vs 4× (one methods sentence) | **5×** | Two of the three statements say 5×, and it is the conservative choice. |
| Off-trail slope: directional (anisotropic) vs terrain (GET v2 isotropic) | **GET terrain slope** × round-trip-preserving asymmetry α(θ) from Sullivan-moderate | Keeps GET's calibrated out-and-back time, penalizes sidehill (terrain slope), and restores uphill ≠ downhill. |
| Off-trail rate family: Tobler ×0.6, STRIDE, Campbell 2017, GET v2 | **GET v2** | STRIDE needs lidar density, which LANDFIRE proxies can't supply. Tobler ×0.6 is a crude single factor. GET v2 is agency-vetted, CC0 and specified. |
| On-trail rate: Tobler / Campbell p50 vs Sullivan tertiles | **Sullivan tertiles** | These are loaded hotshots; the others include runners and unloaded hikers. |
| DEM: 3DEP (fresher, F32, 11 MB/5 s, needs alignment) vs LF2020 Elev/SlpD (GET's source, same grid, Int16, 1 s) | **LF2020** | Fidelity to the GET calibration, speed, and exact alignment. 3DEP is a v2 option (MAE 4.6 m, slopes r = 0.97). |
| LANDFIRE access: LFPS job API vs anonymous ImageServer | **exportImage + WCS fallback** | LFPS requires sending an email to USGS. exportImage returned grid-exact data in about 1 s. |
| OSM: Overpass vs Geofabrik + pyosmium | **Geofabrik + pyosmium** | Overpass policy (< 100 queries and 10 MB/day for regular use) and measured 504s. pyosmium reproduced the result exactly. |
| BLM layers: MapServer 2–5 union vs hosted FS/2 + FS/7 | **FS/2 + FS/7** | 2–5 are exact subsets of 7, so a union double counts up to 12.6k features. |
| Hydro: NHDPlus HR REST (GET's source) vs static NHD HU8 GPKG | **NHD HU8 GPKG, fcode 46006** | The REST services timed out (42–110 s). NHD is frozen, so caching is safe, and it carries the same perennial classification. |
| Trails tiling: z/x/y pbf + addProtocol (no dependency) vs PMTiles vs per-fire GeoJSON | **PMTiles** (+ lite fallback) | z/x/y is 85k–212k objects per rebuild, needs a full grid or tile listing (B2 404s lack CORS), and GDAL gzips the tiles. Per-fire GeoJSON alone can't serve the national online overlay. |
| National maxzoom: z14 vs z13 | **z13** national, **z14** per fire | 2.5× the tiles for +45–50% bytes; overzoom is fine; per-fire files are small. |
| Grid neighbourhood: 16 (2–4% cheaper paths) vs 8 (1.4–1.6× faster) | **8 + cost-aware smoothing** (16 behind a flag) | Phone speed; smoothing fixes the display zig-zag, which 16 does not. |
| Graph noding: shapely/momepy vs node IDs | **Node IDs (OSM) + spatial-hash connectors (agency)** | Exact topology with no false junctions at bridges, and no geometry dependency. |
| Worker data path: worker reads OPFS directly vs main-thread fetch + transfer | **Main thread + transfer** | Reuses the existing wrapper and URL index, with no slug coupling and one serving path. |
| Offline PMTiles: Range emulation in the wrapper vs FileSource | **FileSource** (+ a Range bypass guard) | No HTTP semantics offline; avoids reading the whole file per tile. |
| Range URL: native f005 (206 not cached) vs S3 endpoint (cached in Chrome) | **S3 endpoint when configured**, native otherwise | Measured caching difference; CORS works on both. |
| Per-fire AOI: hotspot box (±0.6°/±0.5°, up to 2° × 1.75°) vs perimeter bbox + buffer | **Perimeter bbox + 8 km** | Smaller and centred on where crews work; the hotspot box can reach about 34M cells. |
| `line-dasharray`: data-driven (per the style spec) vs one layer per dash class (repo) | **Repo convention** | Consistency with drawLayer; only two dash classes exist. |

---

## Appendix A: RDG1 graph binary (`graph.bin.gz`; gzip of the following, little-endian)
```
Header (64 bytes)
 off  type     field
  0   char[4]  magic = "RDG1"
  4   u16      version = 1
  6   u16      header_bytes = 64
  8   u32      epsg                      (32601..32660 | 32701..32760)
 12   f64      origin_x                  (= grid x0, UTM m, west edge)
 20   f64      origin_y                  (= grid y0, UTM m, north edge)
 28   f32      unit_m = 0.1              (coordinate unit)
 32   u32      J  n_junction
 36   u32      I  n_interior
 40   u32      C  n_chains
 44   u32      L  n_links
 48   u32      W  n_ways
 52   u32      S  strings_bytes
 56   u32      reserved0 = 0
 60   u32      reserved1 = 0
Sections (each starts at a 4-byte-aligned offset, in order; pad with zeros):
 A  junc_xy   i32[2J]   interleaved (x, y); x = (E − origin_x)/unit_m, y = (origin_y − N)/unit_m
 B  junc_z    i16[J]    metres (unsmoothed DEM, bilinear)
 C  int_dxy   i32[2I]   interleaved deltas; interior node k of chain c: xy = prev + d, prev = chain start junction
                        for the chain's first interior node, else the previous interior node
 D  int_z     i16[I]    metres (smoothed along chain)
 E  chains    u32[5C]   (start_junction, end_junction, interior_offset, interior_count, way_index)
 F  links     u32[3L]   (node_a, node_b, way_index)   node ids: junction j → j; interior k → J + k
 G  ways      20 B × W  u8 cls | u8 source | u8 flags | u8 trail_class | u8 sac | u8 pad[3]
                        | u32 name_off | u32 ref_off | u32 ext_id
 H  strings   u8[S]     UTF-8, NUL-terminated, deduplicated; offset 0xFFFFFFFF = none
Implicit edges per chain: start → J+o → … → J+o+n−1 → end   (n = 0 ⇒ start → end). Loops allowed.
cls:    1 road_paved · 2 road_unpaved · 3 track · 4 trail · 5 steps · 6 connector
source: 1 osm · 2 usfs · 3 blm · 4 nps · 9 synthetic
flags:  bit0 bridge · bit1 tunnel · bit2 foot_not_listed · bit3 admin_only · bit4 seasonal_restriction
        bit5 closed_status · bit6 not_assessed · bit7 private_access
sac:    0 none/T1 … 6 (OSM sac_scale)   ext_id: OSM way id & 0xFFFFFFFF, or crc32(tid) for agency
```

## Appendix B: normalized trails schema (GPKG `trails`, FGB, PMTiles `trails` layer)
| field | type | values / rule |
|---|---|---|
| `tid` | string | `usfs:{TRAIL_CN}:{BMP:.3f}`, `blm:{FAMS_ID or 'oid'+OBJECTID}`, `nps:{OBJECTID}` |
| `agency` | string enum | `USFS`, `BLM`, `NPS` |
| `name` | string? | trimmed; smart title case if all caps; NPS `TRLNAME`→`MAPLABEL`; BLM `ROUTE_PRMRY_NM` |
| `num` | string? | USFS `TRAIL_NO`; else null |
| `cls` | int 0–5 | USFS `TRAIL_CLASS` 1–5; NPS "Class N"/digit; else 0 |
| `uses` | string | comma list of `H` hiker, `P` pack & saddle, `B` bicycle, `M` motorcycle, `A` ATV, `4` 4WD > 50"; '' = not published |
| `foot` | string enum | `yes`, `no`, `unknown` |
| `restr` | string? | "Hiker restricted 01/01–12/31", "Admin only (agency/fire use)", "Authorized/permitted users only", "Limited by vehicle type", "Temporarily closed", "Seasonal restriction" (joined with "; ") |
| `season` | string? | USFS `HIKER_PEDESTRIAN_MANAGED` "05/15–09/15"; NPS `SEASDESC` |
| `status` | string enum | `open`, `closed`, `not_assessed` |
| `surface` | string? | title-cased; `Unknown` → null |
| `grade` | string? | normalized bin "12–20%", ">50%" |
| `width_in` | int? | tread-width midpoint in inches (TW codes) |
| `mgmt` | string? | "Wilderness", "Wilderness Study Area", "Inventoried Roadless", "National Scenic/Historic Trail" |
| `unit` | string? | NPS `UNITNAME`; BLM "BLM {ADMIN_ST}"; USFS null (v1) |
| `src_date` | string | YYYY-MM-DD (USFS zip Last-Modified; BLM `dataLastEditDate`; NPS per-feature `EDITDATE`) |
| `miles` | real? | source GIS_MILES |

`trails_lo` carries only `tid, agency, name, num, status` (z7–10).

**USFS → uses:** digit `1`→H, `2`→P, `3`→B, `4`→M, `5`→A, `6`→4. `foot` is `yes` if `1` is present, `no` if the code has digits but no `1`, and `unknown` for `N/A` or null.

**BLM `PLAN_ALLOW_MODE_TRNSPRT` →** `HIK_ONLY`→H, `EQU_HIK_ONLY`→H,P, `BIKE_HIK_ONLY`→H,B, `NON_MOTO_SHARED`→H,P,B, `MTC_ATV_SHARED`→M,A (foot unknown), `TECH_VEH_SHARED`→4 (foot unknown), `SNOW_*`/`UNK`→''. The raw code is kept in the popup when uses is ''.

## Appendix C: vegetation classes (`veg-v1`) and colours (`vegClasses.ts`, shared by the layer, route legs and legend)
| id | key | label | colour |
|---|---|---|---|
| 0 | unknown | Unknown | `#7a7a7a` |
| 1 | grass | Grass / herb | `#e3cf6f` |
| 2 | shrub_light | Light brush (< 40% cover) | `#c9a25a` |
| 3 | shrub_dense | Dense brush (≥ 40% cover) | `#9a6a33` |
| 4 | timber | Timber | `#4f8a3c` |
| 5 | timber_litter | Timber, heavy litter | `#2f5f2a` |
| 6 | slash | Slash / blowdown | `#b4532a` |
| 7 | sparse | Rock / sparse | `#a6a6a6` |
| 8 | developed | Developed / agriculture | `#d9b9a3` |
| 9 | snow | Snow / ice | `#e6f2ff` |
| 10 | water | Open water (impassable) | `#3b78c2` |
| 11 | steep | Too steep > 45° (impassable) | `#5b3a29` |
| bit 0x10 | stream | Perennial stream | `#2f8fd8` |

## Appendix D: pace code `logpace-v1`
`code = clip(1 + round(253 · ln(P/0.8) / ln(640)), 1, 254)`; `P(code) = 0.8 · 640^((code−1)/253)` s/m; 255 means impassable and 0 is reserved (impassable). Both codebases test against `pace_code_table.json`, which holds all 256 decoded values to 6 significant digits.

## Appendix E: PMTiles v3 facts used by `pmtiles_check.py` and `pmtilesLite.ts`
- **Header (127 bytes, little-endian):**
  - `magic "PMTiles"` (7 bytes), `version u8 = 3`
  - `root_dir_offset u64 @8`, `root_dir_len @16`, `metadata_offset @24`, `metadata_len @32`
  - `leaf_dirs_offset @40`, `leaf_dirs_len @48`, `tile_data_offset @56`, `tile_data_len @64`
  - `n_addressed_tiles @72`, `n_tile_entries @80`, `n_tile_contents @88`
  - `clustered u8 @96`, `internal_compression u8 @97` (2 = gzip), `tile_compression u8 @98` (2 = gzip), `tile_type u8 @99` (1 = MVT)
  - `min_zoom @100`, `max_zoom @101`
  - `min_lon_e7 i32 @102`, `min_lat_e7 @106`, `max_lon_e7 @110`, `max_lat_e7 @114`
  - `center_zoom @118`, `center_lon_e7 @119`, `center_lat_e7 @123`
- **Directory** (internal-compressed):
  - `varint n`, then n varint tile_id deltas (cumulative), then n varint run_lengths, then n varint lengths, then n varint offsets.
  - An offset of 0 for i > 0 means `offset[i-1] + length[i-1]`; otherwise the value is `offset + 1`.
  - `run_length == 0` marks a leaf directory pointer.
- **Tile id:** `(4^z − 1)/3 + hilbert_index(z, x, y)`.
- **First read:** `getBytes(0, 16384)` covers the header and the root directory.
