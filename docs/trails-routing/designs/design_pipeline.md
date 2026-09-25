# Trails overlay + offline off-trail "Walk": pipeline-first design

Role: Architect (pipeline). Written 2026-09-24 against branch `trails-offroad-routing` (HEAD 69858dc, same as main). Paths are repo-relative unless absolute. "Facts" cited are from the scratchpad `understand/` and `research_notes/` files and were re-checked in source where this design depends on them.

---

## 0. Decisions at a glance

| # | Decision | Reason |
|---|---|---|
| D1 | Two new stateless workflows with their own concurrency groups. `Trails` (group `trails-build`) checks daily and builds at most weekly. `Routing bundles` (group `routing-bundles`) runs every 6 h as plan → 4 build shards → finalize. Neither job reads or writes `state/state.json` or `catalogs/catalog.json`. | `catalog.json` is rebuilt wholesale by two writers, and `state.json` is shared inside `worker-b2-writes`. The tile.yml stateless pattern avoids both. |
| D2 | The frontend discovers data only through standalone pointers: `catalogs/trails.json` and `catalogs/routing.json`, each with exactly one writer. Payloads are versioned and immutable, under `trails/b{build}/` and `routing/{fire_key}/b{bundle}/`. | The existing `catalogs/` rule (60 s, must-revalidate) already covers the pointers, and immutable payloads cache for a year. |
| D3 | Per-fire bundles are keyed by `fire_key` (a normalized cornea_id). `bundle_id` = sha256 of the build inputs, so skip-if-unchanged is a string compare done before any expensive work. | `fire_slug` is unstable, and content-addressing makes reruns idempotent. |
| D4 | No `Content-Encoding` anywhere. PMTiles is gzip internally. `grid.tif` uses DEFLATE inside the TIFF. `graph.bin.gz` is stored as `application/gzip` and gunzipped in the Web Worker with `DecompressionStream`. | b2.py cannot set ContentEncoding, and an encoded object breaks Range reads. |
| D5 | The worker's trail interchange is one normalized FlatGeobuf (`trails.fgb`, full detail, Hilbert spatial index), published alongside the national PMTiles. Routing shards read their AOI slice with `/vsicurl/` + `-spat`. The per-fire trails PMTiles extract is built from that FGB, never from the national PMTiles. | GDAL 3.8.4 must not read PMTiles (bug #9288). This keeps one normalization for the overlay, the offline extract and the routing graph. |
| D6 | OSM comes from Geofabrik state PBFs. Apt `osmium-tool` 1.16 runs one `tags-filter` plus one multi-bbox `extract` per region per week, and a stdlib OPL parser reads the result. No pyosmium, no Overpass. | The owner prefers apt CLI tools over PyPI. Exact shared-node topology is preserved, and Overpass is banned for crons. |
| D7 | The grid is 30 m in the fire's WGS84 UTM zone: one 3-band UInt16 GeoTIFF (class+flags, multiplier×100, elevation in 0.25 m steps), DEFLATE + PREDICTOR=2, 512² tiles. It is built from LANDFIRE exportImage (WCS fallback) → gdalwarp → ENVI raw → numpy → VRT raw → gdal_translate. | geotiff 2.1.3 decodes DEFLATE+predictor, and `spread/utm.ts` already corner-pins UTM. One file serves both routing and the Vegetation layer. |
| D8 | New dependencies: one PyPI package (`numpy`), one apt package (`osmium-tool`), and one npm package (`pmtiles` 4.5.0, owner approval pending). The npm fallback is a ~220-line in-repo PMTiles v3 reader; the B2 contract is identical either way. | Minimal dependencies, with each one justified in §3.14 and §4.2. |
| D9 | Hybrid A* in a module Web Worker searches one graph: 16-neighbour 30 m grid cells plus trail/road "portals" densified to ≤30 m, so a crew can join or leave a trail anywhere. Off-trail cost uses GET v2 multipliers with Sullivan up/down asymmetry. The time range comes from Sullivan loaded-crew tertiles. The latest perimeter is soft-blocked (×50). | §4.6–4.7. |
| D10 | Offline, bundle files are packed as whole files under exact URLs and served by the existing `window.fetch` wrapper. The trails extract is served from memory through a pmtiles `BufferSource`. The national archive is never packed. | The wrapper cannot serve Range requests, and the extract is ≤ about 2 MB. |

---

## 1. Architecture overview and data flow

```
 ┌──────────────────────── Trails workflow (daily 08:23Z check; builds ≤ weekly) ───────────────────────┐
 │ USFS EDW Trans_Trail_NFS_Publish.gdb.zip ─┐                                                           │
 │ BLM GTLF Public_Managed_Trails/FS/2 ──────┼─► sync-trails: probe → fetch → normalize (pure) → sanity   │
 │ BLM GTLF Public_Not_Assessed_Trails/FS/7 ─┤      ├─► trails.gpkg ─► trails.fgb (full detail, indexed) │
 │ NPS_Public_Trails/MapServer/0 ────────────┘      └─► ogr2ogr -f PMTiles z8–13 ─► trails.pmtiles       │
 │ upload: trails/b{build}/{trails.pmtiles,trails.fgb} → build.json → catalogs/trails.json →            │
 │         state/trails.json → catalogs/health/trails.json → prune old builds                           │
 └───────────────────────────────────────────────┬──────────────────────────────────────────────────────┘
                                                 │ workflow_run(completed) + own 6-hourly cron
 ┌───────────────────────── Routing bundles workflow (group routing-bundles) ───────────────────────────┐
 │ plan (1 job): catalogs/catalog.json (B2, read-only) + state/routing/fires.json                        │
 │   + FIRE_API_DEV /fires/{id}/perimeters (only when poly_last_updated changed)                         │
 │   → AOI per fire (pure) → action per fire {build|check|skip|wait|unsupported|backoff}                 │
 │   → for regions needing OSM refresh (≤ weekly): Geofabrik {state}.osm.pbf → osmium tags-filter →      │
 │     osmium extract -c (all fires in region, one pass) → work/osm/{fire_key}/{date}-{region}.osm.pbf   │
 │   → state/routing/plan.json  (entries in priority order; shard = index % 4)                           │
 │ build ×4 (matrix): for each owned entry, deadline-capped:                                             │
 │   trails: /vsicurl/ trails.fgb -spat AOI ─► aoi_trails.gpkg ─► (a) trails.pmtiles extract             │
 │                                                             └► (b) GeoJSONSeq in UTM → graph         │
 │   OSM extract(s) → osmium cat -f opl → OPL parse → split at shared nodes ─┐                           │
 │   agency trails → snap/node against OSM + each other ─────────────────────┴► clip → RDG1 → graph.bin.gz│
 │   LANDFIRE exportImage (WCS fallback) EVT/EVC/FBFM40 (LF2025→LF2024), LF2020 SlpD/Elev                │
 │   NHD HU8 GPKG → work/nhd/{huc8}.gpkg (permanent cache) → gdal_rasterize                              │
 │   → gdalwarp to UTM 30 m ENVI → numpy cost model → VRT raw → gdal_translate → grid.tif               │
 │   upload: routing/{key}/b{bundle}/{grid.tif,graph.bin.gz,trails.pmtiles} → descriptor.json →          │
 │           catalogs/routing/fires/{key}.json → state/routing/runs/{run}/shard-{n}.json                 │
 │ finalize (always): merge shard markers → state/routing/fires.json → catalogs/routing.json →          │
 │                    catalogs/health/routing.json → prune (weekly, --prune --confirm)                   │
 └──────────────────────────────────────────────────────────────────────────────────────────────────────┘

 Browser (fire mode only; the map exists only there)
  Online trails:  catalogs/trails.json → pmtiles://<S3-endpoint URL>/trails.pmtiles (main-thread protocol,
                  Range via FetchSource) → rd-trails-* layers
  Walk:           catalogs/routing.json → descriptor.json → window.fetch(grid.tif, graph.bin.gz)
                  (wrapper: network-first online, pack-first offline) → transfer → offroad.worker.ts
                  (geotiff decode, gunzip, hybrid A*) → RouteResult{legs} → rd-route-* layers + summary
  Offline trails: descriptor.trails_pmtiles → window.fetch (whole file) → BufferSource → pmtiles://rdfire-{bundle}
  Vegetation:     worker paints cls band → RGBA → canvas source rd-vegetation
  Offline pack:   + catalogs/routing.json snapshot + descriptor + grid.tif + graph.bin.gz + trails.pmtiles
```

**Why three routing stages.**
- **Plan** is the only stage that touches Geofabrik: one region download per region per week, then one osmium pass that serves every fire in that region. It also fixes each fire's AOI for the run, so the shards and the OSM extracts agree exactly.
- **Build** shards never contend: each shard owns a disjoint slice of the plan, and every B2 key they write is unique per fire.
- **Finalize** is the single writer of the index, the per-fire state document and health.

The workflow-level concurrency group serializes runs, so every document has exactly one writer at a time.

---

## 2. B2 contract

### 2.1 Key layout

| Key | Writer | Mutability | Cache-Control (rule) | Content-Type | Size |
|---|---|---|---|---|---|
| `catalogs/trails.json` | sync-trails | mutable pointer | `public, max-age=60, must-revalidate` (existing `catalogs/`) | application/json | ~2 KB |
| `catalogs/routing.json` | routing-finalize | mutable index | same | application/json | ~60 KB (328 fires) |
| `catalogs/routing/fires/{fire_key}.json` | routing-build shard | mutable per-fire pointer | same | application/json | ~1 KB |
| `catalogs/health/trails.json`, `catalogs/health/routing.json` | sync-trails / finalize | mutable | same | application/json | ~5 KB |
| `trails/b{build_id}/trails.pmtiles` | sync-trails | immutable | `public, max-age=31536000, immutable` (new `trails/`) | application/octet-stream | ~110–180 MB |
| `trails/b{build_id}/trails.fgb` | sync-trails | immutable | same | application/octet-stream | ~300–400 MB |
| `trails/b{build_id}/build.json` | sync-trails | immutable completion marker | same | application/json | ~3 KB |
| `routing/{fire_key}/b{bundle_id}/grid.tif` | build shard | immutable | new `routing/` immutable | image/tiff | 0.5–6 MB |
| `routing/{fire_key}/b{bundle_id}/graph.bin.gz` | build shard | immutable | same | application/gzip (NO Content-Encoding) | 0.1–1.5 MB |
| `routing/{fire_key}/b{bundle_id}/trails.pmtiles` | build shard | immutable | same | application/octet-stream | 0.05–2 MB |
| `routing/{fire_key}/b{bundle_id}/descriptor.json` | build shard | immutable, written after the 3 assets (completion marker) | same | application/json | ~4 KB |
| `work/osm/{fire_key}/{osm_date}-{region}.osm.pbf` | plan | replaced weekly | new `work/` `private, no-store` | application/octet-stream | 0.1–5 MB |
| `work/nhd/{huc8}.gpkg` | build shard | permanent cache (NHD frozen since 2023) | `private, no-store` | application/octet-stream | 0.5–3 MB |
| `state/trails.json` | sync-trails | private state doc | existing `state/` `private, no-store` | application/json | ~3 KB |
| `state/routing/plan.json` | plan | per run | `state/` | application/json | ~150 KB |
| `state/routing/fires.json` | finalize | private state doc | `state/` | application/json | ~250 KB |
| `state/routing/osm_index.json` | plan | private state doc | `state/` | application/json | ~60 KB |
| `state/routing/runs/{run_id}/shard-{n}.json` | build shard | per run (rewritten incrementally every 10 fires) | `state/` | application/json | ~20 KB |

`fire_key(cornea_id)` is `re.sub(r"[^0-9a-z-]", "", cornea_id.lower())[:64]`, falling back to `sha1(cornea_id)[:16]` when that is empty. Live ids are both `{1B0219EE-…}` and bare `4883092e-…`; both become `1b0219ee-5298-4fef-9927-c2666d9d53fc` style. The frontend never builds a key: it takes descriptor paths from the index.

All published paths are root-relative (`/routing/…`), and the frontend prepends `DATA_BASE_URL`. That matches every existing contract.

### 2.2 `config.py` rule changes (exact)

```python
CACHE_CONTROL_RULES: list[tuple[str, str]] = [
    ("frames/national/", "public, max-age=300"),
    ("frames/", "public, max-age=31536000, immutable"),
    ("tiles/", "public, max-age=31536000, immutable"),
    ("previews/", "public, max-age=31536000, immutable"),
    ("vectors/", "public, max-age=31536000, immutable"),
    ("trails/", "public, max-age=31536000, immutable"),     # NEW: versioned builds only
    ("routing/", "public, max-age=31536000, immutable"),    # NEW: content-addressed bundles only
    ("work/", "private, no-store"),                         # NEW: worker-only caches
    ("catalogs/versions/", "public, max-age=31536000"),
    ("catalogs/", "public, max-age=60, must-revalidate"),   # covers trails.json, routing.json, routing/fires/*, health/*
    ("state/", "private, no-store"),
]
CONTENT_TYPES |= {
    ".tif": "image/tiff",
    ".gz": "application/gzip",          # graph.bin.gz — deliberately NOT Content-Encoding
    ".pmtiles": "application/octet-stream",
    ".fgb": "application/octet-stream",
    ".gpkg": "application/geopackage+sqlite3",
}
```

Invariants, enforced by a test in `test_config.py`:
- Nothing under `trails/` or `routing/` is ever rewritten after a `build.json` or `descriptor.json` exists for it.
- Every mutable document lives under `catalogs/`, `state/` or `work/`.

### 2.3 Versioning

- **Trails `build_id`** = `{YYYYMMDD}-{sig8}`. `sig8` = `sha256(canonical_json({"recipe": TRAILS_RECIPE_VERSION, "sources": probe_signature}))[:8]`. `probe_signature` holds the USFS ETag and Last-Modified, and each ArcGIS source's `count` and `max_edit`.
- **Routing `bundle_id`** = `sha256(canonical_json(inputs))[:12]`. The inputs are exactly:
  ```json
  {"recipe": 1, "cost_model": 1, "graph_format": "RDG1", "grid_format": 1,
   "epsg": 32610, "aoi_utm": [xmin, ymin, xmax, ymax],
   "lf": {"veg": "LF2025", "topo": "LF2020"},
   "trails_hash": "…16 hex | null", "osm_hash": "…16 hex", "nhd": ["17060201", "…"], "nhd_vintage": "2024-01"}
  ```
  `canonical_json` is `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.
  - `trails_hash` covers the AOI's normalized features, sorted by `tid`, with coordinates quantized to dm.
  - `osm_hash` covers the AOI's routable ways: id, relevant tags and node coordinates in dm, sorted.

  Because the key is a hash of the inputs, a weekly trails or OSM refresh that changed nothing inside a fire's AOI yields the same `bundle_id`, and the fire is not rebuilt.
- `ROUTING_RECIPE_VERSION` and `COST_MODEL_VERSION` are constants in `config.py`. Bumping either rebuilds every fire.

### 2.4 JSON schemas (exact field names)

**`catalogs/trails.json`** (pointer, schema `rd-trails/1`):
```json
{
  "schema": "rd-trails/1",
  "build_id": "20260927-3f9a1c2e",
  "built_at": "2026-09-27T08:41:12Z",
  "pmtiles": "/trails/b20260927-3f9a1c2e/trails.pmtiles",
  "pmtiles_url_s3": "https://s3.us-east-005.backblazeb2.com/responder-debrief-data/trails/b20260927-3f9a1c2e/trails.pmtiles",
  "pmtiles_bytes": 141000000,
  "fgb": "/trails/b20260927-3f9a1c2e/trails.fgb",
  "fgb_bytes": 352000000,
  "layer": "trails",
  "minzoom": 8, "maxzoom": 13,
  "bounds": [-170.8, 17.9, -64.5, 71.4],
  "fields": ["tid","ag","name","num","cls","use","usek","acc","ssn","st","wild","unit","sdate"],
  "counts": {"USFS": 74867, "BLM": 24570, "NPS": 31211},
  "source_dates": {"USFS": "2026-09-23", "BLM": "2026-09-21", "NPS": "2026-09-22"},
  "attribution": "Trails: USFS · BLM · NPS"
}
```
`pmtiles_url_s3` is `{B2_S3_ENDPOINT}/{B2_BUCKET}/{key}`. It is written only when B2 settings exist, so it is null in dry runs. The frontend prefers it because Chrome HTTP-caches the S3 endpoint's 206 responses, which carry an ETag, but not the native f005 ones.

**`trails/b{id}/build.json`** is the pointer's fields plus the following:
- `sources` (per source: url, etag, last_modified, count, max_edit, fetched_at)
- `sha256` (per file)
- `gdal_version`
- `tiles`: `{addressed, by_zoom{}, max_tile_bytes, over_480k}`, from `pmtiles_inspect`
- `normalize`: `{dropped_null_geom, dropped_status, unmapped_use_codes{}}`
- `duration_s`

**`catalogs/routing.json`** (index, schema `rd-routing-index/1`, lean because the browser fetches it every session):
```json
{
  "schema": "rd-routing-index/1",
  "generated_at": "2026-09-24T18:40:00Z",
  "recipe_version": 1,
  "fires": {
    "{1B0219EE-5298-4FEF-9927-C2666D9D53FC}": {
      "status": "ok",
      "descriptor": "/routing/1b0219ee-5298-4fef-9927-c2666d9d53fc/b5c1e0a9d2f3b/descriptor.json",
      "bundle_id": "5c1e0a9d2f3b",
      "bbox": [-120.98, 44.51, -119.57, 45.17],
      "built_at": "2026-09-24T12:03:11Z",
      "bytes": 7342111,
      "stale": false
    },
    "{63BA97D7-…}": {"status": "building"},
    "{…AK…}": {"status": "unsupported", "reason": "outside_conus"}
  }
}
```
- Keys are the verbatim `cornea_id`, matching `catalog.json`.
- `status` is one of `ok | building | failed | unsupported`.
- `stale: true` means the fire has an older valid bundle but its latest rebuild failed.
- `bbox` is the AOI's enclosing box in EPSG:4326 (w, s, e, n), for a cheap "inside?" pre-check and the routing-area outline.

**`routing/{key}/b{id}/descriptor.json`** (immutable, schema `rd-routing-bundle/1`):
```json
{
  "schema": "rd-routing-bundle/1",
  "cornea_id": "{1B0219EE-5298-4FEF-9927-C2666D9D53FC}",
  "fire_key": "1b0219ee-5298-4fef-9927-c2666d9d53fc",
  "fire_slug": "0445-crosswhite",
  "bundle_id": "5c1e0a9d2f3b",
  "recipe_version": 1, "cost_model_version": 1, "class_table_version": 1,
  "built_at": "2026-09-24T12:03:11Z",
  "crs": {"epsg": 32610, "zone": 10, "northern": true},
  "aoi": {"bbox_utm": [680000, 4935000, 740000, 4995000], "bbox4326": [-120.98, 44.51, -119.57, 45.17],
          "rule": "perimeter+buffer", "clamped": true,
          "perimeter": {"path": "/…verbatim…", "date": "2026-09-24T06:10:00Z"}},
  "grid": {
    "url": "/routing/…/b5c1e0a9d2f3b/grid.tif", "bytes": 5210331, "sha256": "…",
    "width": 2000, "height": 2000, "cell_m": 30,
    "bands": {"cls": 1, "mul": 2, "elev": 3},
    "cls_flags": {"stream": 256, "litter": 512, "slash": 1024},
    "mul_scale": 0.01, "mul_nodata": 0, "mul_impassable": 65535,
    "elev_scale": 0.25, "elev_offset_m": 612.0, "elev_nodata": 65535
  },
  "graph": {"url": "/routing/…/graph.bin.gz", "bytes": 912004, "sha256": "…", "format": "RDG1",
            "nodes": 31012, "edges": 40877, "deltas": 251330},
  "trails_pmtiles": {"url": "/routing/…/trails.pmtiles", "bytes": 1203311, "minzoom": 8, "maxzoom": 13},
  "sources": {
    "landfire": {"evt": "LF2025_EVT", "evc": "LF2025_EVC", "fbfm40": "LF2025_FBFM40",
                 "slope": "LF2020_SlpD", "elev": "LF2020_Elev", "channel": "imageserver"},
    "osm": {"regions": ["oregon"], "timestamp": "2026-09-23T20:22:00Z"},
    "trails": {"build_id": "20260920-77aa01bc", "source_dates": {"USFS": "2026-09-16", "BLM": "2026-09-14", "NPS": "2026-09-15"}},
    "nhd": {"huc8": ["17070204", "17070305"], "vintage": "2024-01"}
  },
  "inputs": { "…exact bundle_id input object…" },
  "stats": {
    "cells": 4000000, "nodata_pct": 0.0, "impassable_pct": 1.4,
    "class_pct": {"1": 21.3, "2": 38.0, "3": 30.1, "4": 7.9, "250": 0.8, "251": 0.6},
    "stream_cells": 18231, "slash_cells": 4211,
    "graph_km": {"road": 3512.4, "track": 1210.0, "path": 402.2, "agency_trail": 611.9},
    "components": 41, "largest_component_share": 0.97
  },
  "attribution": ["© OpenStreetMap contributors (ODbL)", "USFS", "BLM", "NPS", "LANDFIRE (modified)", "USGS NHD"],
  "license": {"graph": "ODbL-1.0 — derived database; this file is the offered copy",
              "grid": "public domain inputs (LANDFIRE, USGS)", "trails_pmtiles": "public domain inputs"}
}
```

**`catalogs/routing/fires/{fire_key}.json`** (per-fire pointer, written last by the shard): `{schema: "rd-routing-fire/1", cornea_id, fire_key, bundle_id, descriptor, bbox, built_at, inputs, stats_brief}`. Finalize rebuilds the index from these, which is also how a crashed finalize heals itself.

**`state/routing/fires.json`** is private. Per `cornea_id` it holds:
- the published bundle: `fire_key`, `bundle_id`, `built_at`, `checked_at`, `inputs`
- inputs the plan reuses: `poly_last_updated`, `perimeter`, `lf_checked_at`, `huc8`
- history: `prev_bundles: [{bundle_id, superseded_at}]`, `failures: {count, last_at, stage, error}`
- `last_seen_active`

**`state/routing/plan.json`**:
```json
{"schema": "rd-routing-plan/1", "run_id": "…", "generated_at": "…", "shards": 4,
 "trails": {"build_id": "…", "fgb": "/trails/b…/trails.fgb", "fgb_url": "https://…"},
 "entries": [{"i": 0, "cornea_id": "…", "fire_key": "…", "slug": "…", "acres": 342923,
              "action": "build|check", "reason": "new|aoi_changed|recipe|trails_changed|osm_refreshed|lf_recheck|forced|retry",
              "epsg": 32610, "aoi_utm": [...], "bbox4326": [...], "clamped": true,
              "perimeter": {"path": "…", "date": "…"} ,
              "osm": [{"region": "oregon", "key": "work/osm/…", "date": "2026-09-23"}]}],
 "skipped": {"skip": 250, "wait": 3, "unsupported": 37, "backoff": 1}}
```

**Health documents** (single writer each; `HealthView` reads them). The two sections share this shape:
```json
{"schema_version": 1, "updated_at": "…",
 "last_run": {"started_at": "…", "finished_at": "…", "ok": true, "note": "…", "...job-specific…": "…"},
 "last_failure": null,
 "history": [{"at": "…", "ok": true, "note": "…"}]}
```
The history keeps the last 20 entries. Job-specific fields:
- **trails `last_run`**: `built`, `build_id`, `reason` (`unchanged|deferred_weekly|built|forced|sanity_failed`), `sources{usfs,blm_managed,blm_not_assessed,nps: {count, changed, last_modified|max_edit}}`, `features`, `pmtiles_bytes`, `fgb_bytes`, `tiles{addressed, max_tile_bytes, over_480k}`, `gdal_version`, `duration_s`.
- **routing `last_run`**: `fires_active`, `with_bundle`, `building`, `unsupported`, `built`, `checked_unchanged`, `skipped`, `failed: [{cornea_id, slug, stage, error}]`, `osm_regions_refreshed`, `deadline_hit`, `lf2025_share`, `bytes_uploaded`, `oldest_bundle_age_h`, `recipe_version`, `pruned`.

These are separate files rather than sections of `catalogs/health.json` because that document is read-modify-written by jobs in `worker-b2-writes`. Adding writers outside that group would break its single-writer property.

### 2.5 Retention and pruning

B2 keeps every file version by default, and an S3 `DeleteObject` without a VersionId only hides the object while billing continues. Pruning therefore deletes by version: `list_object_versions` on the prefix, then `delete_objects` with VersionIds. This is a new `B2Storage.delete_prefix_versions()`.

| Data | Keep | Deleted by |
|---|---|---|
| Trails builds | the newest 3 builds, plus anything built within the last 21 days | `sync-trails --prune` after a successful publish (the workflow passes it). A build referenced by the pointer is never deleted. |
| Routing bundles, active fire | the current bundle, plus the previous one until 14 days after it was superseded | `routing-finalize --prune --confirm` (Sunday's first run, or dispatch input) |
| Routing bundles, fire gone from catalog | everything, for 30 days after `last_seen_active`; then all bundles, the per-fire pointer and the index entry are removed | same |
| `work/osm/*` | the latest extract per fire | same (older than 14 days) |
| `work/nhd/*` | forever (NHD frozen; < 1 GB) | never |
| `state/routing/runs/*` | the latest 20 runs | finalize |

- The explicit `--confirm` mirrors the repo's deletion policy. Routing bundles are derived and reproducible, not incident data, but the flag keeps deletion explicit. The owner decides the default (§7 open questions).
- Recommended one-time bucket lifecycle rule, added to the README: `daysFromHidingToDeleting: 1` on `trails/`, `routing/`, `work/` and `state/routing/`.
- Estimated steady-state storage: trails 3 × ~0.5 GB = 1.5 GB, routing ~300 × ~6 MB × 1.3 ≈ 2.4 GB, work ~1 GB. That is about 5 GB, roughly $0.03/month at $0.005/GB-month. Class A/B/C transactions are free.

---

## 3. Worker

### 3.1 New and changed modules (`worker/responder_worker/`)

| Module | Kind | Contents |
|---|---|---|
| `gdal_cli.py` | infra | `run(tool, *args, timeout, env)` (the geopdf `_run` pattern: `check=True`, last stderr line ≤300 chars in a `GdalError`); `which(tool)` (with the `.py`-less fallback); `require(tools) -> missing list`; `has_driver(name, write)` (parses `ogr2ogr --formats`); `version()` |
| `b2.py` (changed) | infra | `Storage.list_keys(prefix)`, `head(key) -> {size}`, `delete_prefix_versions(prefix)`, `delete_keys_versions(keys)`; DryRun equivalents |
| `http.py` (changed) | infra | `download_to(client, url, dest, *, headers=None) -> Response`: streams `client.stream("GET")` to a temp file and renames; tenacity retries; returns a 304 untouched |
| `config.py` (changed) | infra | All endpoints and constants in §3.4–3.11, plus the cache/content rules above |
| `trails_normalize.py` | **pure** | `normalize_usfs(props)`, `normalize_blm(props, layer)`, `normalize_nps(props)`, `tidy_name`, `parse_use_*`, `SCHEMA` |
| `arcgis.py` | net | `layer_info(url)`, `count(url, where)`, `max_field(url, field, where)`, `page_geojson(url, where, out_fields, dest_geojsonl) -> n` (count-verified) |
| `pmtiles_inspect.py` | **pure** | PMTiles v3 header, root and leaf directory walk, per-zoom counts, max tile size; MVT layer names of one sampled tile (~150 LOC, stdlib `gzip`) |
| `trails.py` | job | `sync(client, storage, *, force, prune, log, deadline_passed)`: probe → fetch → normalize → sanity → gpkg/fgb/pmtiles → publish |
| `utm.py` | **pure** | Krüger n-series forward and inverse (6th order), `zone_for(lon, lat)`, `epsg_for` |
| `routing_aoi.py` | **pure** | `compute_aoi(...)`, `bbox4326_of(aoi)`, `project_ring` |
| `osm_extract.py` | net + CLI + **pure parser** | state-to-Geofabrik table, `regions_for(bbox4326)`, `refresh_region(...)` (osmium tags-filter + extract -c), `parse_opl(lines) -> (nodes, ways)` |
| `graph_build.py` | **pure** | OSM split, agency snap and node, clip, `encode_rdg1(graph) -> bytes`, `decode_rdg1` (tests and inspect CLI), `stats(graph)` |
| `landfire.py` | net | `snap_5070`, `export_image(...)`, `wcs(...)`, `resolve_veg_version(...)`, `load_lifeform_lut(version)` |
| `nhd.py` | net + GDAL | `huc8_for(bbox4326)` (TNM API), `ensure_huc8_cache(storage, huc8)`, `extract_aoi_hydro(…)` |
| `cost_grid.py` | **pure numpy** + GDAL wrappers | `compose(evt, evc, fbfm, slpd, elev, streams, rivers, lakes, lut) -> (cls, mul, elev_q, offset, stats)`; `read_envi`, `write_grid_tif` |
| `routing.py` | job | `plan(...)`, `build_shard(...)`, `build_fire(...)`, `finalize(...)`, `prune(...)`, `bundle_id(inputs)`, descriptor, pointer and index builders (pure) |
| `trails_cli.py`, `routing_cli.py` | CLI | subparser registration and `cmd_*` functions, kept out of `cli.py` to avoid churn |
| `data/lf_evt_class_2024.json`, `data/lf_evt_class_2025.json` | data | EVT code → class code, generated by `worker/scripts/gen_lf_luts.py` from the LANDFIRE CSVs |
| `data/offroad_contract_v1.json` | data | class codes, flag bits, band order, scales, RDG1 enums; the single source that both the Python and TS tests assert against |
| `data/us_state_bboxes.json` | data | Census state bounding boxes plus the Geofabrik slug per state |

`cli.py` gets exactly one new line in `build_parser()`: `from . import trails_cli, routing_cli; trails_cli.register(sub, common); routing_cli.register(sub, common)`. It also gets a docstring update.

### 3.2 CLI subcommands

All subcommands accept `common()` flags: `--dry-run`, `--out`, `--force`. Env defaults are read explicitly in argparse.

| Command | Flags | Behavior |
|---|---|---|
| `sync-trails` | `--prune`, `--max-seconds` (env `TRAILS_MAX_SECONDS`, default 5400) | Probe → decide → build → publish (§3.6). Exit 0 = ok or no-op, 3 = sanity failure (a red run is deliberate). |
| `routing-plan` | `--run-id` (env `GITHUB_RUN_ID`), `--fire` (cornea_id or slug), `--priority-fires` (env `PRIORITY_FIRES`), `--max-seconds` (env `ROUTING_PLAN_MAX_SECONDS`, 2400), `--shards` (env `ROUTING_SHARDS`, 4) | Writes `plan.json`; prints `work=N` (entries with build or check) for the workflow output |
| `routing-build` | `--run-id`, `--shard`, `--shards`, `--max-seconds` (env `ROUTING_BUILD_MAX_SECONDS`, 7800) | Processes plan entries with `i % shards == shard` |
| `routing-finalize` | `--run-id`, `--prune`, `--confirm` | Merge → index → health → optional prune |
| `routing-one` | `--fire` (required) | Dev and verification: plan, build and finalize for one fire, in-process, in one shard; works with `--dry-run` |

Module mains for inspection:
- `python -m responder_worker.graph_build inspect <graph.bin.gz> [--geojson out.geojson]`
- `python -m responder_worker.pmtiles_inspect <file.pmtiles>`
- `python -m responder_worker.cost_grid inspect <grid.tif>`: band histograms via `gdalinfo -json -hist`

### 3.3 Workflows

**`.github/workflows/trails.yml`**
```yaml
name: Trails
on:
  schedule:
    - cron: "23 8 * * *"          # daily check; builds at most weekly (catch-up-safe, crons slip)
  workflow_dispatch:
    inputs:
      force:   { type: boolean, default: false }
      dry_run: { type: boolean, default: false }
concurrency: { group: trails-build, cancel-in-progress: false }
jobs:
  trails:
    runs-on: ubuntu-24.04           # pinned: GDAL 3.8.4 is the tested writer
    timeout-minutes: 120
    defaults: { run: { working-directory: worker } }
    steps:
      - uses: actions/checkout@v4
      - run: df -h / && nproc
      - name: Install GDAL CLI tools
        continue-on-error: true
        timeout-minutes: 9
        run: |   # verbatim tile.yml retry loop, package list: gdal-bin
          ...
      - uses: astral-sh/setup-uv@v5
        with: { python-version: "3.12", enable-cache: true, cache-dependency-glob: "worker/uv.lock" }
      - run: uv sync
      - name: Contract tests (cheap guard; a red test blocks publishing)
        run: uv run pytest -q tests/test_trails_normalize.py tests/test_arcgis.py tests/test_pmtiles_inspect.py tests/test_config.py
      - name: GDAL self-check
        run: gdalinfo --version && ogr2ogr --formats | grep -Ei 'pmtiles|flatgeobuf|openfilegdb'
      - name: Build trails
        env:
          B2_KEY_ID: ${{ secrets.B2_KEY_ID }}
          B2_APP_KEY: ${{ secrets.B2_APP_KEY }}
          B2_BUCKET: responder-debrief-data
          B2_S3_ENDPOINT: ${{ vars.B2_S3_ENDPOINT }}
          TRAILS_MAX_SECONDS: ${{ vars.TRAILS_MAX_SECONDS || '5400' }}
          GDAL_NUM_THREADS: "4"
          INPUT_FORCE: ${{ inputs.force }}
          INPUT_DRY_RUN: ${{ inputs.dry_run }}
        run: |
          FLAGS=(--prune)
          [ "$INPUT_FORCE" = "true" ] && FLAGS+=(--force)
          [ "$INPUT_DRY_RUN" = "true" ] && FLAGS=(--dry-run --out out --force)
          uv run python -m responder_worker.cli sync-trails "${FLAGS[@]}"
      - if: inputs.dry_run
        uses: actions/upload-artifact@v4
        with: { name: trails-dryrun, path: worker/out/, retention-days: 3 }
```

**`.github/workflows/routing.yml`**
```yaml
name: Routing bundles
on:
  schedule:
    - cron: "37 */6 * * *"
  workflow_run:
    workflows: ["Trails"]
    types: [completed]
  workflow_dispatch:
    inputs:
      fire:    { description: "cornea_id or slug (optional)", default: "" }
      force:   { type: boolean, default: false }
      prune:   { type: boolean, default: false }
      dry_run: { type: boolean, default: false }
concurrency: { group: routing-bundles, cancel-in-progress: false }
jobs:
  plan:
    if: ${{ !inputs.dry_run }}
    runs-on: ubuntu-24.04
    timeout-minutes: 60
    outputs: { work: "${{ steps.plan.outputs.work }}" }
    defaults: { run: { working-directory: worker } }
    steps:
      - checkout; df -h; apt retry loop with: osmium-tool; setup-uv; uv sync
      - id: plan
        env: { B2_*: …, INPUT_FIRE: "${{ inputs.fire }}", INPUT_FORCE: "${{ inputs.force }}", PRIORITY_FIRES: "${{ vars.PRIORITY_FIRES }}" }
        run: |
          FLAGS=(--run-id "$GITHUB_RUN_ID")
          [ -n "$INPUT_FIRE" ] && FLAGS+=(--fire "$INPUT_FIRE")
          [ "$INPUT_FORCE" = "true" ] && FLAGS+=(--force)
          uv run python -m responder_worker.cli routing-plan "${FLAGS[@]}" 2>&1 | tee plan.log
          test "${PIPESTATUS[0]}" -eq 0
          echo "work=$(grep -oE '^work=[0-9]+' plan.log | tail -1 | cut -d= -f2)" >> "$GITHUB_OUTPUT"
  build:
    needs: plan
    if: needs.plan.outputs.work != '0'
    runs-on: ubuntu-24.04
    timeout-minutes: 150
    strategy: { fail-fast: false, matrix: { shard: [0, 1, 2, 3] } }
    defaults: { run: { working-directory: worker } }
    steps:
      - checkout; df -h; apt retry loop with: gdal-bin osmium-tool; setup-uv; uv sync
      - run: uv run pytest -q tests/test_graph_build.py tests/test_cost_grid.py tests/test_routing_aoi.py tests/test_utm.py
      - env: { B2_*: …, ROUTING_BUILD_MAX_SECONDS: "${{ vars.ROUTING_BUILD_MAX_SECONDS || '7800' }}",
               GDAL_HTTP_MULTIRANGE: SERIAL, GDAL_DISABLE_READDIR_ON_OPEN: EMPTY_DIR,
               CPL_VSIL_CURL_CHUNK_SIZE: "262144", VSI_CACHE: "TRUE" }
        run: uv run python -m responder_worker.cli routing-build --run-id "$GITHUB_RUN_ID" --shard ${{ matrix.shard }} --shards 4
  finalize:
    needs: [plan, build]
    if: ${{ always() && needs.plan.result == 'success' }}
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    defaults: { run: { working-directory: worker } }
    steps:
      - checkout; setup-uv; uv sync
      - env: { B2_*: …, INPUT_PRUNE: "${{ inputs.prune }}" }
        run: |
          FLAGS=(--run-id "$GITHUB_RUN_ID")
          # weekly prune: first scheduled run on Sunday (UTC), or explicit dispatch
          if [ "$INPUT_PRUNE" = "true" ] || { [ "$(date -u +%u)" = 7 ] && [ "$(date -u +%H)" -lt 6 ]; }; then
            FLAGS+=(--prune --confirm)
          fi
          uv run python -m responder_worker.cli routing-finalize "${FLAGS[@]}"
  dryrun:
    if: ${{ inputs.dry_run }}
    runs-on: ubuntu-24.04
    timeout-minutes: 60
    steps:
      - checkout; apt gdal-bin osmium-tool; uv
      - run: uv run python -m responder_worker.cli routing-one --fire "${{ inputs.fire }}" --dry-run --out out
      - uses: actions/upload-artifact@v4   # inspect bundle without touching B2
        with: { name: routing-dryrun, path: worker/out/, retention-days: 3 }
```

**Budgets.**
- The plan's OSM phase is capped at 2400 s; regions it doesn't reach are deferred.
- Each build shard has a deadline of 7800 s inside a 150-minute job, which leaves time for the final marker upload.
- The first full build is estimated at about 291 CONUS fires × 30–60 s ÷ 4 shards ≈ 40–70 min.
- A steady-state run is plan ~2–5 min, build usually 0–10 min, and finalize under 1 min.
- Jobs killed by `timeout-minutes` report "cancelled". The deadline sits well inside the timeout so that never happens in practice.

**Caching.**
- Geofabrik PBFs are not cached in actions/cache: the plan downloads a region at most once a week and deletes it after extraction.
- The per-fire extracts, which are small, are the cached artifact, stored in `work/osm/`.
- NHD HU8 GeoPackages are cached permanently as trimmed per-HU8 GPKGs in `work/nhd/`. NHD has been frozen since late 2023, so a cached file never goes stale.

**GDAL checks.**
- Trails needs `ogr2ogr` and `ogrinfo`, plus the PMTiles (write), FlatGeobuf and OpenFileGDB drivers.
- Build shards need `ogr2ogr`, `gdalwarp`, `gdal_translate`, `gdal_rasterize`, `gdaltransform`, `gdalinfo` and `osmium`.
- If any tool is missing: log `[routing-build] GDAL unavailable (missing: …)`, write a shard marker with `gdal_available: false`, and exit 0. That is the repo convention, and health surfaces it.
- `gdal_cli.version()` is logged and recorded. Anything other than 3.8.x logs a warning, as a guard against runner image drift.

### 3.4 Source fetch recipes (exact)

**USFS (weekly national FGDB; atomic, unlike the REST service, which was caught mid-reload)**
- Probe: `GET https://data.fs.usda.gov/geodata/edw/edw_resources/fc/Trans_Trail_NFS_Publish.gdb.zip` with `If-None-Match`/`If-Modified-Since` from `state/trails.json`. A 304 means unchanged.
- Fetch: `http.download_to()` streams the ~119 MB file. It verifies that Content-Length matches the bytes written and that `zipfile.ZipFile(...).testzip() is None`.
- Convert:
  ```
  ogr2ogr -f GeoJSONSeq usfs.geojsonl /vsizip/{zip}/Trans_Trail_NFS_Publish.gdb Trans_Trail_NFS_Publish \
    -where "TRAIL_TYPE='TERRA'" \
    -select TRAIL_CN,BMP,EMP,TRAIL_NAME,TRAIL_NO,TRAIL_CLASS,ALLOWED_TERRA_USE,HIKER_PEDESTRIAN_MANAGED,HIKER_PEDESTRIAN_RESTRICTED,TERRA_MOTORIZED,SPECIAL_MGMT_AREA,ATTRIBUTESUBSET,NATIONAL_TRAIL_DESIGNATION \
    -t_srs EPSG:4326 -nlt MULTILINESTRING -lco COORDINATE_PRECISION=6
  ```
  Timeout 900 s. `-nlt MULTILINESTRING` linearizes the 7 MultiCurve features. Null geometries (about 3,289) are dropped by the normalizer and counted.
- `sdate` = the Last-Modified date. The EDW page currently says weekly refreshes are failing, so the date is shown to users.

**BLM GTLF (hosted FeatureServers, paged in Python for count control)**
- `BLM_MANAGED = https://services1.arcgis.com/KbxwQRRfWyEYLgp4/arcgis/rest/services/BLM_Natl_GTLF_Public_Managed_Trails/FeatureServer/2`
- `BLM_NOT_ASSESSED = …/BLM_Natl_GTLF_Public_Not_Assessed_Trails/FeatureServer/7`. It is disjoint from the managed layer. MapServer layers 2–5 are subsets of the managed layer and must not be unioned.
- Probe: `{url}?f=json` → `editingInfo.dataLastEditDate`, and `{url}/query?where=1%3D1&returnCountOnly=true&f=json`.
- Pages: `{url}/query?where=1%3D1&outFields=OBJECTID,ROUTE_PRMRY_NM,ADMIN_ST,PLAN_ASSET_CLASS,PLAN_MODE_TRNSPRT,PLAN_ALLOW_MODE_TRNSPRT,PLAN_OHV_ROUTE_DSGNTN,PLAN_ACCESS_RSTRCT,PLAN_SEASON_RSTRCT_CODE,OBSRVE_ROUTE_USE_CLASS,ROUTE_SPCL_DSGNTN_TYPE&outSR=4326&geometryPrecision=6&orderByFields=OBJECTID&resultOffset={n}&resultRecordCount=2000&f=geojson`.
- Paging stops when a page has fewer than 2000 features and no `exceededTransferLimit`. Pages are 0.5 s apart.
- Count verification: `sum(pages) == count_before == count_after`. On a mismatch, retry the whole source once after 120 s, then fail it.

**NPS**
- `NPS = https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails/MapServer/0`
- Where clause: `PUBLICDISPLAY='Public Map Display' AND DATAACCESS='Unrestricted'`. It is a no-op today but kept defensively.
- `outFields=OBJECTID,GEOMETRYID,TRLNAME,TRLALTNAME,MAPLABEL,TRLSTATUS,TRLTYPE,TRLCLASS,TRLUSE,TRLFEATTYPE,SEASONAL,SEASDESC,UNITCODE,UNITNAME,EDITDATE`, with the same paging, count check and `f=geojson` as BLM.
- Probe: count plus `outStatistics=[{"statisticType":"max","onStatisticField":"EDITDATE","outStatisticFieldName":"max_edit"}]`.
- Post-filter drops `TRLSTATUS ∈ {Decommissioned, Abandoned, Proposed}` and `TRLTYPE ∈ {Water Trail, Snow Trail, Ferry Route}`. Features whose representative longitude is > 0 (Guam/CNMI) are dropped to keep the header bounds sane.

**LANDFIRE (anonymous ImageServer; documented WCS fallback; the LFPS job API is never used because it requires an Email)**
- ExportImage: `https://lfps.usgs.gov/arcgis/rest/services/{folder}/{service}/ImageServer/exportImage?bbox={xmin},{ymin},{xmax},{ymax}&bboxSR=5070&imageSR=5070&size={W},{H}&format=tiff&pixelType=S16&noData=-9999&interpolation=RSP_NearestNeighbor&compression=LZ77&f=image`

| key | primary (vegetation: try 2025, then 2024) | fallback |
|---|---|---|
| evt | `Landfire_LF2025/LF2025_EVT_CONUS` → `Landfire_LF2024/LF2024_EVT_CONUS` | WCS `…/landfire_wcs/conus_2025/wcs`, then `conus_2024/wcs` coverageId `landfire_wcs__LF2024_EVT_CONUS` |
| evc | `…/LF2025_EVC_CONUS` → `…/LF2024_EVC_CONUS` | same pattern |
| fbfm40 | `…/LF2025_FBFM40_CONUS` → `…/LF2024_FBFM40_CONUS` | same pattern |
| slpd | `Landfire_Topo/LF2020_SlpD_CONUS` | `…/landfire_wcs/conus_topo/wcs` `landfire_wcs__LF2020_SlpD_CONUS` |
| elev | `Landfire_Topo/LF2020_Elev_CONUS` | `…conus_topo…` `landfire_wcs__LF2020_Elev_CONUS` |

- WCS: `https://edcintl.cr.usgs.gov/geoserver/landfire_wcs/{set}/wcs?service=WCS&version=2.0.1&request=GetCoverage&coverageId={id}&subset=X({xmin},{xmax})&subset=Y({ymin},{ymax})&format=image/geotiff`. It returns NoData 32767, which is normalized to −9999.
- The 5070 bbox is found by transforming the densified UTM AOI boundary (4 corners plus 7 points per edge) with `gdaltransform -s_srs EPSG:{epsg} -t_srs EPSG:5070`, padding 90 m, and snapping outward to the LANDFIRE grid:
  - `xmin = X0 + 30·floor((x − X0)/30)` with `X0 = −2362425`
  - `ymax = Y0 − 30·floor((Y0 − y)/30)` with `Y0 = 3267405`
  - `W = (xmax − xmin)/30`
  A 60 km UTM AOI gives about 2,150², under the 100,000 px limit.
- Validation: the response starts with `II*\0` or `MM\0*`; otherwise it is an ArcGIS JSON error and raises. `gdalinfo -json` must report size `W×H` and EPSG 5070.
- Version rule: use LF2025 for all three vegetation layers only if the LF2025 EVT nodata fraction is ≤ 0.1% (outside non-CONUS pixels). Otherwise use LF2024 for all three. The version is recorded, and the matching EVT class LUT is used.
- Politeness: requests are sequential within a shard, 0.5 s apart; at most 4 shards run concurrently. A circuit breaker trips after 5 consecutive LANDFIRE failures in a shard, and the remaining builds in that shard are deferred with a health note.

**NHD (static HU8 GeoPackages; the hydro.nationalmap.gov REST services were unreliable)**
- HU8 lookup: `GET https://tnmaccess.nationalmap.gov/api/v1/products?datasets=National%20Hydrography%20Dataset%20(NHD)%20Best%20Resolution&bbox={w},{s},{e},{n}&prodFormats=GeoPackage&max=50`. Keep items whose title contains `Hydrologic Unit (HU) 8` or `HU8`, with format GeoPackage. The resulting HU8 list is cached in the fire's state.
- Cache miss: download `downloadURL` (e.g. `…/NHD_H_17060201_HU8_GPKG.zip`, 15–28 MB) and write `work/nhd/{huc8}.gpkg` with three layers:
  - `streams`: `ogr2ogr … NHDFlowline -where "fcode IN (46006,46000)" -dim XY -nln streams`
  - `rivers`: `NHDArea -where "ftype = 460" -nln rivers` (StreamRiver polygons)
  - `lakes`: `NHDWaterbody` with ftype 390 or 436, joined to the GPKG's `NHDFCode` table to exclude descriptions containing Intermittent or Ephemeral, and `areasqkm >= 0.009` (one cell). Fallback if the lookup table is absent: `fcode NOT IN (39001,39005,39006)`.

  Upload, then delete the zip.
- Per fire: `ogr2ogr -f GPKG aoi_hydro.gpkg work_huc8.gpkg {layer} -spat {bbox4326} -spat_srs EPSG:4326 -t_srs EPSG:{epsg}`, appended per HU8. Everything is reprojected to UTM before rasterizing.

**OSM (Geofabrik; weekly per region; plan stage only)**
- Region choice: US state bboxes (`data/us_state_bboxes.json`) that intersect the AOI's `bbox4326`, mapped to the slug `north-america/us/{slug}`. California uses the full `california` file; norcal/socal is a later optimization.
- Download `https://download.geofabrik.de/north-america/us/{slug}-latest.osm.pbf`. It 302-redirects to `{slug}-YYMMDD.osm.pbf`, and that dated name is the `osm_date`. The file is streamed to disk.
- `osmium tags-filter {slug}.osm.pbf w/highway -o {slug}-hw.osm.pbf --overwrite` (one pass; much smaller output).
- `osmium extract -c extracts.json -s complete_ways {slug}-hw.osm.pbf --overwrite`, with `extracts.json = {"directory": "ex", "extracts": [{"output": "{fire_key}.osm.pbf", "bbox": [w,s,e,n]}, …]}`. This covers all of the region's fires in one pass, each bbox padded 1 km.
- Upload `work/osm/{fire_key}/{osm_date}-{slug}.osm.pbf` and update `state/routing/osm_index.json`. Delete the region PBFs before moving to the next region, which keeps peak disk at ≤ 1.4 GB (California).
- A region is refreshed only when one of its fires lacks an extract covering its AOI, or its extracts are more than `OSM_MAX_AGE_DAYS = 7` days old. The deadline-capped loop runs biggest-fire-first.

**Perimeters (bulk traffic goes to the DEV fire API)**
- The fire list comes from our own published `catalogs/catalog.json`: zero fire-API index traffic, and cornea_ids and acres identical to what the site shows.
- For fires whose `poly_last_updated` differs from `state/routing/fires.json`: `GET {FIRE_API_DEV}/fires/{quote(cornea_id, safe='')}/perimeters`, take the latest item by `date`, then `GET {FIRE_API_DEV}{path}` with the path used verbatim. From the Polygon/MultiPolygon geometry, compute the bbox.
- Otherwise reuse the stored perimeter bbox. Requests are sequential, 0.2 s apart.

### 3.5 Trails normalization schema

One layer, `trails`, in EPSG:4326 MultiLineString. The same attributes go into the GPKG, the FGB and the MVT.

| Field | Type | Values and derivation |
|---|---|---|
| `tid` | text | `usfs:{TRAIL_CN}:{BMP:.3f}` · `blm:m{OBJECTID}` (managed) / `blm:n{OBJECTID}` (not assessed) · `nps:{GEOMETRYID or OBJECTID}` |
| `ag` | text enum | `USFS` \| `BLM` \| `NPS` |
| `name` | text? | USFS `TRAIL_NAME`, BLM `ROUTE_PRMRY_NM`, NPS `TRLNAME` → `MAPLABEL` → `TRLALTNAME`. `tidy_name`: trim, collapse spaces, and convert ALL-CAPS to title case, keeping `NF`, `FS`, `BLM`, `NPS`, `OHV`, `ATV`, `II`, `III`, `IV` and `#` tokens. Empty becomes null. |
| `num` | text? | USFS `TRAIL_NO` trimmed; null for other sources |
| `cls` | int | 0 = unknown, 1–5. USFS `TRAIL_CLASS` `'1'..'5'`; `'N'`, blank or null → 0. NPS `TRLCLASS` `'Class N'` or digit `'1'..'5'`; `'6'` and `'Unknown'` → 0. BLM → 0. |
| `use` | int bitmask | 1 hike, 2 stock (pack/saddle, equestrian), 4 bike, 8 motorcycle, 16 ATV/UTV, 32 4WD/OHV>50" |
| `usek` | int 0/1 | 1 when `use` comes from a populated source value |
| `acc` | text enum | `open` \| `admin` \| `permit` \| `closed` \| `hike_restricted` \| `no_hike_listed` \| `unknown` |
| `ssn` | text? (≤ 40 chars) | Season window: USFS `HIKER_PEDESTRIAN_MANAGED` (e.g. `05/15-09/15`), trimmed; BLM `PLAN_SEASON_RSTRCT_CODE`; NPS `SEASDESC` when `SEASONAL='Yes'` |
| `st` | text enum | `system` \| `not_assessed` (BLM layer 7) \| `unofficial` (NPS `Unofficial Trail`) \| `non_agency` (NPS `Non-NPS Trail`) |
| `wild` | int 0/1 | USFS `SPECIAL_MGMT_AREA` contains `WILDERNESS`. Crews need to know this for MIST. |
| `unit` | text? | NPS `UNITNAME`; BLM `BLM {ADMIN_ST}`; USFS null (ADMIN_ORG is a code with no lookup) |
| `sdate` | text `YYYY-MM-DD` | USFS: FGDB Last-Modified. BLM: `dataLastEditDate`. NPS: the feature's `EDITDATE`, else the layer's `max_edit`. |

**Use mapping.**
- USFS `ALLOWED_TERRA_USE`: each digit `1..6` sets bit `1<<(d−1)`. `N/A`, blank and null give `usek=0`. Unmapped characters are counted into `unmapped_use_codes`.
- BLM `PLAN_ALLOW_MODE_TRNSPRT` (case- and whitespace-normalized):

  | Code | Bits |
  |---|---|
  | `HIK_ONLY` | 1 |
  | `EQU_HIK_ONLY` | 1\|2 |
  | `BIKE_HIK_ONLY` | 1\|4 |
  | `NON_MOTO_SHARED` | 1\|2\|4 |
  | `MTC_ATV_SHARED` | 8\|16 |
  | `TECH_VEH_SHARED` | 8\|16\|32 |
  | `SNOW_*` | 0 with `usek=1` |
  | `UNK` or null | `usek=0` |

  Any other code gives `usek=0` and is counted in `unmapped_use_codes`.
- NPS `TRLUSE`: upper-case, split on `| , / ;`, then map tokens. `HIKER`, `PEDESTRIAN`, `HIKE`, `HIKING`, `WALK` → 1. `HORSE`, `EQUESTRIAN`, `PACK`, `STOCK`, `SADDLE` → 2. `BICYCLE`, `BIKE`, `MOUNTAIN BIKE` → 4. `MOTORCYCLE` → 8. `ATV`, `OHV`, `UTV` → 16. `4WD`, `HIGH CLEARANCE` → 32. `UNKNOWN` or empty → `usek=0`.

**Access mapping.**
- USFS: a non-empty `HIKER_PEDESTRIAN_RESTRICTED` gives `hike_restricted`, and `ssn` becomes that window. Otherwise, `usek=1` with bit 1 clear gives `no_hike_listed`. Otherwise `open`.
- BLM `PLAN_ACCESS_RSTRCT`: `ADMIN ONLY` → `admin`; `AUTHORIZED/PERMITTED USER ONLY` → `permit`; `NONE`, `ALL`, `LIMITED BY VEHICLE TYPE` → `open`; `UNKNOWN` or null → `unknown`.
- NPS: `TRLSTATUS='Temporarily Closed'` → `closed`, otherwise `open`.

The router ignores every one of these; they are shown in popups and step notes (§4.3, §4.11).

**Sanity gate.** The build aborts and keeps the previous build, with exit code 3 and a health failure, if any source's count after normalization is below `max(floor, 0.9 × previous)`.

| Source | Floor |
|---|---|
| usfs | 50,000 |
| blm_managed | 15,000 |
| blm_not_assessed | 3,000 |
| nps | 25,000 |

It also aborts if more than 2% of features fail normalization. The first build has no "previous" and uses the floors only.

### 3.6 Trails build (FGB + national PMTiles)

1. Stream the three normalized GeoJSONSeq files into one: `norm.geojsonl`, ~150k features.
2. `ogr2ogr -f GPKG trails.gpkg norm.geojsonl -nln trails -nlt MULTILINESTRING -lco SPATIAL_INDEX=YES`. Use GPKG rather than GeoJSON as the input for the tile builds; the facts show 1.1 GB RSS from GeoJSON input.
3. `ogr2ogr -f FlatGeobuf trails.fgb trails.gpkg trails -lco SPATIAL_INDEX=YES`. Nulls were already dropped; the FGB writer aborts on them.
4. National PMTiles:
   ```
   GDAL_NUM_THREADS=4 ogr2ogr -f PMTiles trails.pmtiles trails.gpkg trails -nln trails \
     -dsco NAME="Responder Debrief trails" -dsco DESCRIPTION="USFS TrailNFS TERRA, BLM GTLF managed + not assessed, NPS public; build {build_id}" \
     -dsco MINZOOM=8 -dsco MAXZOOM=13 \
     -dsco SIMPLIFICATION=2 -dsco SIMPLIFICATION_MAX_ZOOM=0.5 \
     -dsco EXTENT=4096 -dsco BUFFER=80 -dsco MAX_SIZE=500000 -dsco MAX_FEATURES=200000 \
     -select tid,ag,name,num,cls,use,usek,acc,ssn,st,wild,unit,sdate
   ```
   Timeout 3600 s. The stderr is captured with `CPL_DEBUG=MVT` so tile-degradation debug lines can be counted. GDAL 3.8.4 degrades oversize tiles silently.
   - One layer, one zoom range, and no `CONF`, to minimize dependence on unverified 3.8.4 options.
   - z13 still gives about 1 m coordinate resolution, and MapLibre overzooms beyond it.
   - Measured sizes: 85k tiles for z7–13; about 110–180 MB after SIMPLIFICATION=2 (the facts measured −27% for this setting).
   - Peak scratch disk is about 1–3 GB (temp.db plus tmp.mbtiles), within the runner's 14 GB. `df -h` is logged.
5. `pmtiles_inspect trails.pmtiles` must pass:
   - magic, version 3, clustered, and gzip tile compression
   - min/max zoom 8/13
   - `addressed ≥ 50,000`
   - a sampled z13 tile contains layer `trails`

   It records `max_tile_bytes` and `over_480k`. More than 0 tiles over 480k is only a health note.
6. Upload `trails.pmtiles` and `trails.fgb` (multipart through `upload_file`) → `build.json` → `catalogs/trails.json` → `state/trails.json` → `catalogs/health/trails.json` → prune.

**Decision logic before step 1.**
- If the signature is unchanged, it's a no-op (`unchanged`).
- If the signature changed but the last build is under 6.5 days old, it's a no-op (`deferred_weekly`). Use `--force` to override.
- If `build.json` already exists for this `build_id`, the upload was already done: only re-assert the pointer.
- A USFS 304 during a build that is needed for other sources falls back to an unconditional download. There's no persistent disk, and the transfer is only ~30 s.

### 3.7 Per-fire AOI policy (`routing_aoi.compute_aoi`, pure)

```
seed   = perimeter_bbox4326 ∪ fire_point      (point only if no perimeter)
zone   = floor((cx + 180)/6) + 1 ; northern = cy ≥ 0 ; epsg = 32600|32700 + zone     (cx, cy = seed center)
box    = UTM bbox of the seed ring (4 corners + 7 pts/edge, Krüger forward)
if perimeter:  box = box ± AOI_BUFFER_M (10 000)
else:          r = max(AOI_MIN_SIDE_M/2, sqrt(max(acres,0)·4046.86/π) + AOI_BUFFER_M); box = center ± r
box    = snap_out(box, AOI_SNAP_M = 1 500)           (1 500 = 50 cells → cell-aligned)
box    = grow_centered(box, AOI_MIN_SIDE_M = 21 000)   (min, a snap multiple)
box, clamped = shrink_centered_on_seed(box, AOI_MAX_SIDE_M = 60 000)   (2 000² cells = 4.0 M, the benchmarked size)
hysteresis: if prev and prev.epsg == epsg:
    if prev.box ⊇ box: return prev                     (shrink never rebuilds)
    u = prev.box ∪ box; if both sides of u ≤ MAX: box = u  (growth is monotonic until the cap)
bbox4326 = enclosing lon/lat box of the final UTM box (inverse, densified) padded 0.005°
```

- **All fires are processed.** There are 328 in the catalog today: 291 in CONUS and 37 in AK, HI or PR.
- **Priority order:** `PRIORITY_FIRES` first (slugs or cornea_ids), then `acres` descending (None counts as 0), then `created_on` descending, then `cornea_id`. Plan entries take this order; shard = index % 4, so the biggest fires are spread across shards and handled first within each.
- **v1 supports CONUS only.** AK, HI and PR fires get `unsupported` / `outside_conus`. LANDFIRE `_AK/_HI/_PRVI` services and Geofabrik and HU8 coverage exist, so v1.1 is a service-table change plus a snap-origin lookup from `ImageServer?f=json`.

**Rebuild triggers.** The plan computes one action per fire:

| Action | When |
|---|---|
| `build` | no pointer · `ROUTING_RECIPE_VERSION` or `COST_MODEL_VERSION` changed · AOI or epsg changed · `--force` · retry after failure (backoff elapsed) |
| `check` | trails `build_id` changed · any OSM extract date changed · `lf_checked_at` older than 30 days (LF2025 is rolling out to more GeoAreas in Nov 2026). The shard computes `trails_hash`, `osm_hash` and the LF version, then builds only if `bundle_id` changes; otherwise it just stamps `checked_at`. |
| `skip` | nothing changed. This costs zero network calls. |
| `wait` | OSM extract missing, because the region was deferred by the plan deadline |
| `unsupported` | outside CONUS (v1) |
| `backoff` | ≥ 3 consecutive failures, the last one under 24 h ago |

### 3.8 Graph build (`graph_build.py`, pure) and the RDG1 format

**Inputs**
- OPL from `osmium cat {part}.osm.pbf -f opl,add_metadata=false`, one file per region part, unioned by id. OPL `%xxxx%` escapes are decoded.
- Agency trails for the AOI: `ogr2ogr -f GeoJSONSeq aoi_trails_utm.geojsonl aoi_trails.gpkg -t_srs EPSG:{epsg}`.

**OSM way filter and mapping**
- Drop `highway ∈ {motorway, motorway_link, construction, proposed, platform, raceway, bus_stop, elevator, corridor, abandoned, razed, rest_area, services, escape, busway, via_ferrata}` and `area=yes`.
- Kind:

  | `kind` | OSM `highway` |
  |---|---|
  | 1 `ROAD` | everything else, e.g. trunk, primary…residential, unclassified, service, living_street, road, `*_link` |
  | 2 `TRACK` | `track` |
  | 3 `PATH` | `path`, `footway`, `bridleway`, `cycleway`, `pedestrian` |
  | 4 `STEPS` | `steps` |

- `sac` from `sac_scale`: hiking 1 through difficult_alpine_hiking 6.
- Flags:
  - `RESTRICTED` (bit 0): `access` or `foot` ∈ {no, private}
  - `BRIDGE` (bit 2), `TUNNEL` (bit 3)
- Name: `name`, `name (ref)` or `ref`.

**Agency edges** come from the AOI trails.
- `kind 5 AGENCY_TRAIL`; `src` 2 USFS, 3 BLM, 4 NPS; `cls` from the trail class.
- Flags:
  - `RESTRICTED` (bit 0): `acc ∈ {admin, permit, closed, hike_restricted, no_hike_listed}`
  - `SEASONAL` (bit 1): `ssn` set
  - `WILDERNESS` (bit 4): `wild=1`
  - `NON_SYSTEM` (bit 5): `st ≠ system`
- Name: `"{name} #{num}"`.

**Noding (all coordinates first quantized to integer decimetres relative to the grid origin `(xmin, ymin)`)**
1. **OSM:** split ways at nodes that are referenced by 2 or more ways, or are way endpoints. This is exact topology: no false junctions at bridges or tunnels.
2. **Agency endpoint snap** (`SNAP_M = 12`). Using a 100 m bucket hash over all nodes and segments, snap each agency polyline endpoint to:
   - the nearest node within 12 m, else
   - the nearest point on any segment within 12 m, splitting that edge there, else
   - a new node.
3. **Agency interior crossings:** proper segment intersections between agency segments and OSM segments not flagged bridge or tunnel, and between agency segments themselves, insert a shared node into both. OSM–OSM crossings are never noded.
4. **Deduplicate** nodes by exact dm coordinate. Drop zero-length edges. Collapse exact-duplicate edges with identical from, to and vertex list, keeping the agency attributes.
5. **Clip** to the AOI rectangle with Liang–Barsky per segment. A cut point becomes a node; the edge gets flag `CLIPPED` (bit 6).
6. **Split long segments:** any segment with |dx| or |dy| > 32,000 dm (3.2 km) is split, so deltas fit Int16.
7. **Stats:** nodes, edges, km by kind, connected components, and the largest component's share.

Imperfect topology is tolerated by design: the grid connects everything, and a missed junction costs one short cross-country link (§4.6). That lets the worker stay dependency-free, with no shapely and no GEOS.

**RDG1 byte layout.** Little-endian. Each section starts 4-byte aligned. The whole file is gzip-compressed (`gzip.compress(raw, 9, mtime=0)`); integrity comes from the descriptor's sha256.

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic `"RDG1"` (52 44 47 31) |
| 4 | 2 | u16 version = 1 |
| 6 | 2 | u16 header_bytes = 64 |
| 8 | 4 | u32 N node_count |
| 12 | 4 | u32 E edge_count |
| 16 | 4 | u32 D delta_count (Σ over edges of vertices−1) |
| 20 | 4 | u32 K name_count |
| 24 | 4 | u32 S name_bytes |
| 28 | 4 | u32 epsg |
| 32 | 8 | f64 origin_x (= grid xmin, UTM m) |
| 40 | 8 | f64 origin_y (= grid ymin, UTM m) |
| 48 | 4 | u32 coord_unit_mm = 100 (decimetres) |
| 52 | 4 | u32 flags (bit0 = all edges bidirectional; always 1) |
| 56 | 8 | reserved 0 |

| Section | Type | Length | Meaning |
|---|---|---|---|
| S1 nodes | i32 | 2N | (x_dm, y_dm) interleaved, relative to origin |
| S2 edge_from | u32 | E | node id |
| S3 edge_to | u32 | E | node id |
| S4 edge_dstart | u32 | E+1 | prefix offsets into S5; edge e owns deltas `[dstart[e], dstart[e+1])` |
| S5 deltas | i16 | 2D | (dx_dm, dy_dm): `v0 = node[from]`, `v(i+1) = v(i) + delta(i)`; the last vertex MUST equal `node[to]` (encoder asserts) |
| pad | | → 4 | |
| S6 edge_name | u32 | E | name index, 0xFFFFFFFF = none |
| S7 edge_kind | u8 | E | 1 ROAD, 2 TRACK, 3 PATH, 4 STEPS, 5 AGENCY_TRAIL |
| S8 edge_src | u8 | E | 1 OSM, 2 USFS, 3 BLM, 4 NPS |
| S9 edge_cls | u8 | E | agency class 0–5 |
| S10 edge_sac | u8 | E | OSM sac_scale 0–6 |
| S11 edge_flags | u8 | E | bit0 RESTRICTED, bit1 SEASONAL, bit2 BRIDGE, bit3 TUNNEL, bit4 WILDERNESS, bit5 NON_SYSTEM, bit6 CLIPPED |
| pad | | → 4 | |
| S12 name_offsets | u32 | K+1 | byte offsets into S13 |
| S13 names | u8 | S | UTF-8 |

Estimate for a dense 50 km WUI area (Park Fire: 27k nodes, 36k edges, about 200k deltas): about 1.8 MB raw and 0.8–1.0 MB gzipped. Elevation is deliberately NOT stored: the client samples the grid's elevation band, so the time model lives entirely client-side and can change without a rebuild.

### 3.9 Grid build and cost-model encoding (`landfire.py`, `nhd.py`, `cost_grid.py`)

**Steps (per fire, in a TemporaryDirectory)**
1. `W = (xmax−xmin)/30`, `H = (ymax−ymin)/30`, from 700 to 2000.
2. Fetch the LANDFIRE tiles EVT, EVC, FBFM40, SlpD and Elev in EPSG:5070 (§3.4).
3. `gdalwarp -overwrite -t_srs EPSG:{epsg} -te {xmin} {ymin} {xmax} {ymax} -tr 30 30 -of ENVI` with:
   - categorical rasters (EVT, EVC, FBFM40, SlpD): `-r near -ot Int16 -dstnodata -9999`
   - Elev: `-r bilinear -ot Float32 -dstnodata -9999`
4. Hydro: `gdal_rasterize -init 0 -ot Byte -te … -tr 30 30 -of ENVI`:
   - `-burn 1 -at -l streams` (all-touched, so lines stay connected)
   - `-burn 1 -l rivers`
   - `-burn 1 -l lakes` (cell centers only, so shores are not over-blocked)
5. numpy compose (below). Write BSQ raw `grid.bin` (3 × H × W little-endian UInt16) and a VRT raw file:
   ```xml
   <VRTDataset rasterXSize="W" rasterYSize="H"><SRS>EPSG:{epsg}</SRS>
     <GeoTransform>{xmin}, 30, 0, {ymax}, 0, -30</GeoTransform>
     <VRTRasterBand dataType="UInt16" band="1" subClass="VRTRawRasterBand"><SourceFilename relativeToVRT="1">grid.bin</SourceFilename>
       <ImageOffset>0</ImageOffset><PixelOffset>2</PixelOffset><LineOffset>{2W}</LineOffset><ByteOrder>LSB</ByteOrder></VRTRasterBand>
     … band 2 ImageOffset {2WH}, band 3 ImageOffset {4WH} …
   </VRTDataset>
   ```
6. `gdal_translate -of GTiff -co COMPRESS=DEFLATE -co PREDICTOR=2 -co ZLEVEL=9 -co TILED=YES -co BLOCKXSIZE=512 -co BLOCKYSIZE=512 -co INTERLEAVE=BAND grid.vrt grid.tif`.
   - No nodata tag; the sentinels are per band and documented in the descriptor.
   - EPSG 326xx/327xx geokeys, so the TS decoder's `epsgToUtm` accepts it.
   - Verify with `gdalinfo -json`: size, 3 bands, UInt16, DEFLATE, epsg.
   - Estimated size: 0.6 MB (21 km) to about 5 MB (60 km).

**Band contract (UInt16)**
- **B1 `cls`**: the low byte is the base class; the high bits are flags: 256 `STREAM`, 512 `LITTER` (TL4/5/7), 1024 `SLASH` (SB1–4).
- **B2 `mul`**: GET v2 multiplier × 100. 0 = no data (outside CONUS, Canada, ocean), which the router treats as impassable. 65535 = impassable (water or cliff).
- **B3 `elev`**: `elev_m = elev_offset_m + v × 0.25`, with `elev_offset_m = floor(min valid) − 1`. 65535 = no data.

**Base classes** (`class_table_version: 1`, shared with TS through `data/offroad_contract_v1.json`)

| Code | Key | From EVT lifeform (LUT from the LF CSV `EVT_LF`) | GET v2 base multiplier |
|---|---|---|---|
| 0 | nodata | EVT −9999 / 32767 | — (mul 0) |
| 1 | grass | Herb | 1.0 |
| 2 | shrub | Shrub | 1 + 3·cover/100; cover = EVC−200 if 210 ≤ EVC ≤ 299, else `SHRUB_COVER_DEFAULT = 30` → 1.9 |
| 3 | timber | Tree | 4.0 |
| 4 | rock | Sparse, Barren | 1.0 (non-burnable) |
| 5 | agriculture | Agriculture | 1.0 |
| 6 | developed | Developed (incl. 7299 Roads) | 1.0 |
| 7 | snow | Snow-Ice (7735) | 2.0 (**our choice**; GET v2 is silent) |
| 250 | water | Water (7292), or FBFM40 NB8 = 98, or an NHD perennial lake | impassable |
| 251 | cliff | LF2020 SlpD > 45° | impassable |

**Modifiers** (they multiply): LITTER (FBFM40 184/185/187) ×2; SLASH (201–204) ×5 (table value, see Appendix A); STREAM (NHD streams or rivers raster) ×5.

The EVT/EVC mismatch rule is our choice, needed because the two disagree on about 8.5% of cells: the EVT lifeform picks the class, and EVC supplies shrub cover only when it is in 210–299.

```python
base = LUT[np.clip(evt, 0, 9999)]; base[evt < 0] = 0
m = np.ones(base.shape, np.float32)
cov = np.where((evc >= 210) & (evc <= 299), evc - 200, SHRUB_COVER_DEFAULT)
m[base == 2] = 1 + 3 * cov[base == 2] / 100; m[base == 3] = 4.0; m[base == 7] = 2.0
lit = np.isin(fbfm, (184, 185, 187)); sl = np.isin(fbfm, (201, 202, 203, 204)); st = (streams | rivers) > 0
m[lit] *= 2; m[sl] *= 5; m[st] *= 5
water = (base == 250) | (fbfm == 98) | (lakes > 0); cliff = (slpd > 45) & ~water
cls = base.astype(np.uint16) | (st.astype(np.uint16) << 8) | (lit.astype(np.uint16) << 9) | (sl.astype(np.uint16) << 10)
cls[water] = 250; cls[cliff] = 251
mul = np.clip(np.rint(m * 100), 1, 65534).astype(np.uint16); mul[water | cliff] = 65535
nod = (base == 0) | ~np.isfinite(elev) | (elev <= -9998); mul[nod] = 0; cls[nod] = 0
off = np.floor(np.nanmin(elev[~nod])) - 1
eq = np.clip(np.rint((elev - off) / 0.25), 0, 65534).astype(np.uint16); eq[nod] = 65535
```

The descriptor `stats` hold class percentages, impassable %, nodata %, stream and slash cell counts, and graph stats.

These **anomaly notes** go to health without failing the build:
- `nodata_pct > 5` (border or coastal fires are expected)
- `impassable_pct > 25`
- `largest_component_share < 0.5`

### 3.10 Build order, idempotence and failure handling

**Per fire (shard)**
1. Compute the input object. For a `check`, extract the trails and OSM data and hash them; if `bundle_id` equals the pointer's, stamp `checked_at` and move on.
2. If `routing/{key}/b{id}/descriptor.json` exists, the fire is already published: re-emit the pointer if it is missing and continue.
3. Build the graph, grid and trails extract in a TemporaryDirectory.
4. Upload `grid.tif`, `graph.bin.gz` and `trails.pmtiles` (in parallel) → `descriptor.json` → `catalogs/routing/fires/{key}.json`.
5. Append to the in-memory shard marker, flushing to `state/routing/runs/{run}/shard-{n}.json` every 10 fires and at the end, so a timeout loses at most 10 fires of bookkeeping. Nothing is lost for good: step 2 heals it on the next run.

**Why reruns are safe**
- Keys are content-addressed. Assets uploaded before a crash but without a descriptor were never visible to anyone, so overwriting them is safe even though they carry immutable headers.
- The pointer, index and state documents each have exactly one writer, and runs are serialized by the concurrency group.

**Failure isolation**
- Every fire runs in `try/except`, recording `{stage: aoi|osm|trails|landfire|nhd|grid|graph|upload, error: last stderr line ≤300 chars}`. The fire keeps its previous bundle, and the index shows `stale: true`.
- Per-subprocess timeouts: 300 s for per-fire GDAL, 1800 s for osmium on a region, 3600 s for the national PMTiles.
- LANDFIRE circuit breaker as in §3.4. If Geofabrik is down, affected fires go to `wait`; fires that already have extracts proceed.
- A trails sanity failure keeps the old build, and routing keeps reading the old FGB.
- Finalize runs on `always()` and merges all unmerged run markers it finds under `state/routing/runs/`.

### 3.11 Health reporting and observability

- **Log tags:** `[trails]`, `[routing-plan]`, `[routing-build n/4]`, `[routing-final]`.
- **One summary line per fire:** `slug key action→result bundle cells edges MB s`.
- **Health documents:** `catalogs/health/trails.json` and `catalogs/health/routing.json` (§2.4).
- **Index `building` entries** let the UI say "off-trail routing for this fire is still being built".
- **HealthView** gets two rows, "Trails (weekly)" and "Routing bundles (6-hourly)", read from the per-workflow runs endpoint `GET /repos/{repo}/actions/workflows/{file}/runs?per_page=10`. The shared 40-run list would scroll a weekly workflow out of view.

### 3.12 New dependencies (worker)

| Dependency | Where | Justification |
|---|---|---|
| `numpy` (PyPI) | `pyproject.toml` | The cost model runs over 0.5–4M cells × 8 input layers per fire, about 300 fires per week. Pure Python would be about 50× slower, roughly 10–20 s per fire just for the loops. GDAL's Python bindings (and their numpy) exist only for the apt system Python and cannot be imported under `uv run`. numpy reads GDAL's raw ENVI output directly, which keeps the "GDAL via CLI only" rule. |
| `osmium-tool` (apt, noble universe 1.16.0) | workflow apt line | Exact OSM topology (node ids), one multi-bbox pass per region, bounded memory. It replaces pyosmium, a PyPI wheel, and Overpass, which is banned. |

Nothing else is added. Specifically there is no shapely (noding is done in-house with a bucket hash), no pyproj (Krüger UTM in `utm.py` for our own points; PROJ via `gdaltransform`/`ogr2ogr -t_srs` elsewhere), no rasterio, no pyosmium and no go-pmtiles.

---

## 4. Frontend

### 4.1 New and changed modules

| Path | Kind | Purpose |
|---|---|---|
| `src/routing/types.ts` | types | `RoutingIndex`, `RoutingIndexEntry`, `RoutingDescriptor`, worker protocol, `OffroadErrorCode` |
| `src/routing/contract.ts` | pure | class codes, flag bits, band order, scales, RDG1 enums, asserted against `worker/responder_worker/data/offroad_contract_v1.json` in tests |
| `src/routing/costModel.ts` | pure | Sullivan and GET v2 functions and constants (§4.7) |
| `src/routing/vegClasses.ts` | pure | display table: code → label and color; used by the vegetation layer, legend and route xc colors (toaBands.ts pattern) |
| `src/spread/utm.ts` (changed) | pure | adds `lonLatToUtm(lon, lat, zone, northern)` (Krüger forward) and `utmZoneFor` |
| `src/routing/rdg1.ts` | pure | `decodeRdg1(buf) -> Rdg1Graph` (typed-array views, no copies) |
| `src/routing/gridDecode.ts` | pure (geotiff) | `decodeRoutingGrid(buf, desc) -> {W, H, cls: Uint16Array, mul: Uint16Array, elev: Float32Array, bboxUtm, epsg}`, full resolution, DOM-free |
| `src/routing/hybridGraph.ts` | pure | densify to ≤30 m, portals, cell links, CSR, precomputed per-direction sub-edge costs |
| `src/routing/perimeterMask.ts` | pure | lon/lat (Multi)Polygon → UTM → Uint8 mask (even-odd scanline + all-touched boundary) |
| `src/routing/astar.ts` | pure | hybrid A* over typed arrays with a stamp-reset open/closed set and a binary heap |
| `src/routing/smooth.ts` | pure | cost-aware string pulling for grid runs |
| `src/routing/legs.ts` | pure | leg assembly, veg breakdown, climb with hysteresis, time ranges, step text, `haversineM` (own copy; `geo.ts` is untouched) |
| `src/routing/offroad.worker.ts` | worker shell | message loop; holds the one loaded bundle |
| `src/routing/offroadClient.ts` | main thread | lazy module-singleton Worker, request ids, stale-drop, buffer fetch + transfer |
| `src/routing/bundleStore.ts` | main thread | memoized `getRoutingIndex()` (60 s TTL), `getDescriptor(corneaId)`, `getFireTrailsArchive(desc)` |
| `src/routing/useOffroadContext.ts` | hook | index + descriptor + latest perimeter + `avoidPerimeter` → `OffroadContext \| null` |
| `src/routing/errors.ts` | pure | `routeErrorText(profile, err)` |
| `src/map/pmtiles.ts` | main thread | lazy `import('pmtiles')`, `ensurePmtilesProtocol()`, `BufferSource`, `registerBufferArchive(key, buf)` |
| `src/map/layers/trailsStyle.ts` | pure | `groundFor(ui, offline)`, `trailPaint(ground)`, `trailPopupHtml(props)`, `usesText(bitmask)` |
| `src/map/layers/trailsLayer.ts` | LayerManager | source switching (national vs extract), layers, popup, store self-subscription |
| `src/map/layers/vegetationLayer.ts` | LayerManager | canvas source from the worker's RGBA |
| `src/map/layers/routeLayer.ts` (changed) | LayerManager | legs → FeatureCollection via pure `routeFeatures(route)`; new layers `rd-route-area` and `rd-route-xc` |
| `src/panels/OffroadSummary.tsx` + `src/panels/offroad.css` | UI | range, split bar, veg chips, modeled label, steps, avoid-perimeter toggle, provenance and attribution. New CSS file, so `panels.css` is untouched. |
| `src/panels/TrailsRow.tsx`, `src/panels/VegetationRow.tsx` | UI | Layers-tab rows (checkbox, opacity, legend chips) |
| `src/api/routing.ts` (changed) | api | `RouteLeg`, `RouteResult` optional fields, `engine: 'offroad'`, `fetchRoute(a, b, p, ctx?)`, `withGapLegs` |
| `src/api/types.ts`, `catalogs.ts`, `queries.ts` (changed) | api | `TrailsPointer`, routing types, health docs; `fetchTrailsPointer`, `fetchRoutingIndex`, `fetchRoutingDescriptor`, `fetchTrailsHealth`, `fetchRoutingHealth`; hooks |
| `src/offline/packModel.ts`, `packs.ts`, `opfs.ts`, `panels/OfflineCard.tsx` (changed) | offline | §4.13 |
| `src/state/store.ts`, `src/app/urlState.ts`, `src/map/zOrder.ts`, `src/map/useMapLayerSync.ts` (changed) | seams | §4.4, minimal diffs |
| `vite.config.ts` (changed) | build | `worker: { format: 'es' }`. Required: geotiff's dynamic decoders fail under the default `iife`, verified in a scratch build. |
| `package.json` (changed) | deps | `pmtiles@^4.5.0` (pending approval) |

### 4.2 pmtiles protocol and the offline Source

- `ensurePmtilesProtocol()` runs once on first trails mount. It does `const { Protocol, PMTiles } = await import('pmtiles')` (code-split, so the 7.7 kB gz loads only if trails are shown), then `maplibregl.addProtocol('pmtiles', protocol.tile)`.
- MapLibre forwards custom-scheme requests to the main thread, so the protocol always runs where the fetch wrapper is installed.
- **Online (national):** the source URL is `pmtiles://` + (`pointer.pmtiles_url_s3 ?? dataUrl(pointer.pmtiles)`). pmtiles' FetchSource calls global fetch with a single-range `Range` header, which is CORS-safelisted, so there is no preflight. The wrapper sees a URL that is not in any pack and passes it straight through with `rawFetch(input, init)`, and B2 returns 206. The S3 URL is HTTP-cached in Chrome; the native URL is not.
- **Offline or fallback (per fire):**
  ```ts
  class BufferSource implements Source {
    constructor(private key: string, private buf: ArrayBuffer) {}
    getKey() { return this.key; }
    async getBytes(offset: number, length: number) { return { data: this.buf.slice(offset, offset + length) }; }
  }
  // desc.trails_pmtiles.url fetched WHOLE through window.fetch (exact pack URL) → registerBufferArchive(`rdfire-${bundle_id}`, buf)
  // → source url 'pmtiles://rdfire-<bundle>'
  ```
  This needs no Range emulation, no OPFS File handle and no exported pack lookup. The extract is ≤ about 2 MB in memory, and a pack update simply yields a new key.
- **Choosing a source:** use the extract when `!store.offline.online`, or when the national source errors for this session (tracked on the source `error` event), and the descriptor has `trails_pmtiles`. Otherwise use national. The source is recreated when its key changes (the incidentMapLayer pattern).
- **Fallback if the owner rejects the npm package:** `src/map/pmtilesLite.ts` (~220 LOC, same `tile()` handler signature). It does:
  - v3 header parse
  - varint directory decode with a leaf cache
  - Hilbert `zxy → tile_id`
  - gzip via `DecompressionStream`
  - TileJSON for `pmtiles://key` source requests, and tile bytes for `/z/x/y`

  The B2 contract and the worker are unchanged. The npm package is recommended because the owner's planned offline basemap (self-produced Protomaps PMTiles, per project memory) will need it anyway.

### 4.3 Trails layer

**Layer ids and z-order** (added to `RD_LAYER_ORDER`)
- `rd-trails-casing`, `rd-trails-line` and `rd-trails-line-minor` sit immediately before `rd-national-perimeters`: below basemap labels, above sheets, forecast and weather.
- `rd-trails-label` (symbol, `symbol-placement: line`, minzoom 12) and `rd-trails-hit` (width 16, opacity 0) go right after the basemap-symbol marker, before `rd-wind-arrows`.

**Paint per ground** (`trailPaint(ground)`). `groundFor` resolves the ground: `ui.basemap === 'topo'` → topo; `'satellite'` → satellite; `'map'` → the theme; offline style → dark.

| Ground | Core | Casing (opacity) | Label / halo |
|---|---|---|---|
| topo (default) | `#c2185b` | `#ffffff` (0.85) | `#7a0f3a` / `#ffffff` |
| satellite | `#ff6ec7` | `#140a10` (0.75) | `#ffe3f3` / `#140a10` |
| dark (Dark Matter, Fiord, Classic dark, offline #161313) | `#ff7ac6` | `#0d0a0c` (0.8) | `#ffd6ec` / `#0d0a0c` |
| light (Positron, Liberty, Voyager) | `#b0156a` | `#ffffff` (0.9) | `#6b0d40` / `#ffffff` |

- Magenta is used because it collides with none of the existing colors:
  - route blue `#4aa3ff`, perimeter `#CC0000`, the hotspot ramp
  - the draw palette (purple `#b05de1`, blue `#5a7cff`, ink, sketch orange)
  - range greens and historic tans
  - the USGS Topo brown/black dashed trails, which only draw at z14 and above
- Widths: `['interpolate', ['linear'], ['zoom'], 8, 0.8, 11, 1.4, 13, 2.2, 16, 3.5]`; the casing is +2.
- `rd-trails-line-minor` is filtered to `st != 'system'` and drawn dashed `[2, 1.5]`, one layer per dash class per repo convention. `rd-trails-line` is filtered to `st == 'system'`.
- Label text: `['coalesce', ['get', 'name'], ['concat', '#', ['get', 'num']]]` with `text-font: rdLabelFont(map)`. Offline it renders through local TinySDF.
- Styling reacts to changes through a store subscription to `ui.basemap`, `ui.theme` and `offline.online`, with the dead-map guard `(map as any)._removed || !map.style` (the basemapUnderlay pattern) and `setPaintProperty`.

**Popup** (`trailPopupHtml`, every value escaped):
```
<b>Iron Creek Trail</b> #640
USFS · Class 3 · Wilderness
Allowed: Hike · Stock   (or "Allowed uses not recorded")
⚠ Hiking restricted 01/01–12/31 (USFS)   | Admin use only (BLM) | Permitted users only (BLM) | Temporarily closed (NPS) | Hiking not listed as allowed (USFS)
Season: 05/15–09/15
Not assessed by BLM   (st=not_assessed) | Unofficial trail (NPS)
USFS data as of 2026-09-23
```

**Click arbitration**
- The handler on `rd-trails-hit` bails when `routeClickClaims(directions)` is true or `draw.tool !== 'none'`.
- It also bails when `queryRenderedFeatures(e.point, {layers: ['rd-hotspots', 'rd-fire-pins', 'rd-incidents-pt', 'rd-incidents-line']})` is non-empty, so higher features win.
- `'rd-trails-hit'` is added to `INTERACTIVE` in `useMapLayerSync.ts`. After the hotspot-flames merge it also goes into `FEATURE_LAYERS` in `map/pinDrop.ts`.
- The popup uses a WeakSet install guard, and closes when the layer is hidden.

**Attribution:** the vector source spec carries `attribution: 'Trails: USFS · BLM · NPS'`.

### 4.4 Store, Layers tab and URL state (minimal diffs in conflict files)

- **`store.ts`**:
  - `layers.trails: {visible: boolean}`, default false. It is a viewing preference that persists across fires, like traffic.
  - `layers.vegetation: {visible: boolean, opacity: number}`, default `{false, 0.6}`. It is per fire and reset in `selectFire`.
  - `directions.avoidPerimeter: boolean`, default true. It persists like `profile`.
  - Actions: `toggleTrails()` and `setVegetation(p)`, each calling `track('layer_toggled', {layer, on})`, and `setAvoidPerimeter(on)`, which calls `track('avoid_perimeter_toggled', {on})`.
- **`urlState.ts`**: `trl=1` means trails shown and `veg=1` means vegetation shown. Only non-default values are written. `urlState.test.ts`'s `mkState` gains both slices.
- **`ForecastTab.tsx`**: `MapLayerToggles` renders `<TrailsRow/>` and `<VegetationRow/>`. That is 2 lines. Each row owns its checkbox, the vegetation opacity slider (shown only when on), and the legend chips from `vegClasses.ts`.
- **`zOrder.ts`**: eight new ids: `rd-vegetation` (first entry), `rd-trails-casing`, `rd-trails-line`, `rd-trails-line-minor`, `rd-trails-label`, `rd-trails-hit`, `rd-route-area` (before `rd-route-casing`) and `rd-route-xc` (last).
- **`useMapLayerSync.ts`**: `trailsLayer` and `vegetationLayer` go into `MANAGERS`, and `rd-trails-hit` into `INTERACTIVE`. `LayerContext` is unchanged: both managers read `ctx.view.corneaId` and `ctx.layers`, and self-subscribe for ui and online changes.

### 4.5 Routing Web Worker protocol

The worker is created lazily as a module singleton in `offroadClient.ts`: `new Worker(new URL('./offroad.worker.ts', import.meta.url), { type: 'module' })`. Creating it at import time would break vitest imports and StrictMode. The service worker precaches the resulting chunk under `dist/assets`.

```ts
// main → worker
type ToWorker =
  | { type: 'load'; reqId: number; bundleId: string; desc: GridMeta; grid: ArrayBuffer; graph: ArrayBuffer }   // transfer [grid, graph]
  | { type: 'route'; reqId: number; bundleId: string; a: LngLat; b: LngLat;
      avoid: { key: string; polygons: number[][][][] } | null;          // lon/lat MultiPolygon coords
      opts: { neighbors: 16; weight: 1; timeBudgetMs: 3500 } }
  | { type: 'vegImage'; reqId: number; bundleId: string; maxWidth: 2048 }
  | { type: 'dispose' };
// worker → main
type FromWorker =
  | { type: 'loaded'; reqId: number; bundleId: string; stats: { cells: number; portals: number; decodeMs: number; buildMs: number } }
  | { type: 'route'; reqId: number; status: 'ok'; result: OffroadResult; ms: number; expanded: number; weighted: boolean }
  | { type: 'route'; reqId: number; status: 'outside' | 'unreachable' | 'timeout' | 'not-loaded' | 'error'; which?: 'a' | 'b' | 'both'; message?: string }
  | { type: 'vegImage'; reqId: number; width: number; height: number; rgba: ArrayBuffer }   // transfer [rgba]
  | { type: 'error'; reqId: number; message: string };
```

**Data path.** On the main thread: `bundleStore` → `window.fetch(dataUrl(desc.grid.url))` and `graph.url`, going through the wrapper (network-first online, OPFS offline, 8 s patience) → `arrayBuffer()` → post to the worker with transfer. The worker never fetches, because its fetch bypasses the pack.

**Integrity.** The worker verifies both buffers against the descriptor's sha256 with `crypto.subtle.digest` before decoding. A mismatch returns `error` with code `load-failed`.

**Concurrency.**
- At most one route runs at a time.
- The client keeps only the latest pending request (drag storms collapse) and drops stale replies by `reqId`, the repo's routeSeq pattern.
- A new bundle's `load` replaces the old one, so the worker holds at most one bundle. It is never terminated on fire switch; it just reloads.

**Load time.** First route latency is a fetch of up to about 7 MB plus about 0.3–1 s to decode and build. `offroadClient.warm(desc)` is called when both endpoints are set and Walk is available, and also when the directions panel opens on a fire with a bundle (if `!navigator.connection?.saveData`).

### 4.6 Hybrid A* (`astar.ts`, `hybridGraph.ts`, `perimeterMask.ts`, `smooth.ts`)

**Node space**
- Grid cells are `0 … N−1` (N = W·H; row 0 is north). A portal is `N + p`.
- Portals are the densified graph vertices: every edge polyline is resampled so consecutive vertices are ≤ `DENSIFY_M = 30` m apart. Junction nodes are shared portals.
- Each portal stores its UTM xy, `pcell` (the containing cell), and CSR adjacency to neighbour portals. The sub-edge arrays are `to`, `tFwdMod` (s), `len` (m), `dz` (m) and `edgeId`. Elevation comes from a bilinear sample of the elev band at each portal.
- **Cell↔portal links** are implicit. From portal p, link to `pcell[p]`. From cell c, link to `cellPortals(c)`, a `Map<number, Int32Array>` built at load.
- Link cost = `d / v_xc(0, M(c)) + TRANSITION_S (3 s)`, with d ≤ 21.2 m. Portals whose cell is impassable or nodata get no link: you can stay on a trail across a cliff band or a bridge over water, but you can't step off there.

**Grid moves (16 neighbours)**

| Move | Length | Allowed unless… | M̄ |
|---|---|---|---|
| king orthogonal (±1,0) | 30 m | either end is impassable or nodata | ½(M_from + M_to) |
| diagonal (±1,±1) | 42.43 m | either end is blocked, or both side cells are blocked (no squeezing between them) | ½(M_from + M_to) |
| knight (±2,±1)/(±1,±2) | 67.08 m | any of the 4 cells is blocked (the 2 cells it cuts through are checked, fixing Herzog's barrier skip) | quarter-weighted mean of from, both cut cells and to |

- **Grade:** `θ = atan((z_to − z_from)/L)` in degrees. `|θ| > 45°` blocks the move.
- **Perimeter:** if any involved cell is in the perimeter mask, the cost is ×`PERIM_PENALTY = 50`. This is a soft block, so a crew already inside can route out, and the result carries `crossesPerimeter: true`.

**Search**
- The open/closed set is reset with generation stamps (`Uint32Array` stamp, `Float32Array` g, `Int32Array` parent), so the 4M arrays are never refilled per query.
- The heap is a typed binary heap ordered by (f, then h, then node id), which makes tie-breaking deterministic.
- Heuristic: `h = euclid(node, goal) / V_MAX_H` with `V_MAX_H = 1.41` m/s. That is ≥ the fastest speed any move can have (Sullivan moderate peak 1.404 at −2.9°), so the heuristic is admissible.
- Start = A's cell; goal = B's cell. Route geometry is `[A, …path…, B]`.
- **Endpoints outside the grid**, meaning outside `[1, W−2] × [1, H−2]`, return `status: 'outside', which` with no search.
- **Window:** only nodes inside the AB bbox padded by `max(3 000 m, 0.5·|AB|)` are expanded. If that fails, retry once over the full grid.
- **Budget:** check elapsed time every 16,384 pops.
  1. If more than 3,500 ms pass, rerun with weighted A* (w = 1.6) and set `result.notes += 'near-optimal'`.
  2. If that also exceeds the budget, return `timeout`.

  An exhausted open set returns `unreachable`.
- **Memory at 4M cells:** stamp 16 MB, g 16 MB, parent 16 MB, mul 8, cls 8, elev 16, plus portals about 5 MB and the heap, for about 90 MB in the worker.

**Perimeter rasterization.**
1. Project lon/lat rings with `lonLatToUtm` in the bundle's zone.
2. Fill with an even-odd scanline at cell centers, so holes stay open.
3. Mark all cells touched by boundary edges (Amanatides–Woo traversal).
4. Buffer 0 m; `AVOID_BUFFER_M` is a tunable constant.
5. Cache the mask by `avoid.key`, the perimeter version path.

**Smoothing.** For each maximal grid run, apply greedy string pulling. From anchor i, find the farthest j such that the straight segment i→j:
- sampled every 15 m, costs no more than the original sub-path's cost under the same model;
- crosses no impassable cell;
- crosses a mask cell only if the original did.

This removes most zig-zag at about 0.3–2 ms per path.

### 4.7 Cost and time math (`costModel.ts`, exact)

```ts
// Sullivan et al. 2020 loaded-crew Lorentz tertiles (θ degrees, signed, downhill negative), m/s
export const SULLIVAN = {
  low:  { a: -3.3717, b: 25.8255, c: 92.6594, d: -0.1624, e:  0.0019 },
  mod:  { a: -2.8292, b: 20.9482, c: 77.6346, d:  0.2228, e: -0.0004 },
  high: { a: -2.2893, b: 19.4024, c: 65.3577, d:  0.6226, e: -0.0020 },
} as const;
export const vSul = (k: keyof typeof SULLIVAN, θ: number) => {
  const { a, b, c, d, e } = SULLIVAN[k];
  return Math.max(V_MIN, c / (Math.PI * b * (1 + ((θ - a) / b) ** 2)) + d + e * θ);
};
// GET v2 isotropic off-road slope term (Campbell et al. 2024), s = |θ| degrees, m/s
export const GETV2 = { a: 22.4056, b: 77.6196, c: 0.0464 } as const;
export const vGet = (s: number) => GETV2.b / (Math.PI * GETV2.a * (1 + (s / GETV2.a) ** 2)) + GETV2.c;
// Up/down asymmetry borrowed from Sullivan moderate, normalized so the ± mean equals GET v2
export const asym = (θ: number) => (2 * vSul('mod', θ)) / (vSul('mod', θ) + vSul('mod', -θ));

export const V_MIN = 0.05, V_MAX_H = 1.41;
export const NET_GRADE_CAP_DEG = 30;      // DEM-vs-switchback noise on trails
export const XC_MAX_GRADE_DEG = 45;       // GET v2 impassable threshold
export const PERIM_PENALTY = 50, TRANSITION_S = 3, DENSIFY_M = 30;
export const SAC_FACTOR = [1, 1, 1, 1, 1.5, 2.5, 4];   // T4+ slow-downs (Valhalla-derived, T0–T3 neutral for crews)
export const STEPS_FACTOR = 1.5;
```

**On network** (roads, tracks, paths, agency trails), for a sub-edge of horizontal length L:
- θ = clamp(atan(dz/L), ±30)
- `t_k = L · SAC_FACTOR[sac] · (kind === STEPS ? 1.5 : 1) / vSul(k, θ)` for k ∈ {high, mod, low}
- The search uses `t_mod`.

**Off network** (grid move of length L with mean multiplier M̄):
- `t_mod = L · M̄ / (vGet(|θ|) · asym(θ))` is the search cost; the perimeter penalty applies in search only.
- `t_fast = t_mod · vSul('mod', θ) / vSul('high', θ)`
- `t_slow = t_mod · vSul('mod', θ) / vSul('low', θ)`

**Sanity values** (tested):
- 1 km of flat trail takes 9.9 / 12.1 / 17.3 min (high / mod / low), matching Sullivan's Table 4 and text.
- `vGet(0) = 1.149` and `vGet(30) = 0.441` m/s, matching the GET v2 paper.
- Flat timber (M = 4): `t_mod` = 58 min/km, with a range of 48–84 min/km.

**Route totals**
- `durationS = Σ t_mod`; `durationRangeS = [Σ t_fast, Σ t_slow]`, treating the legs as fully correlated, which is conservative and simple.
- Climb and descent come from the elevation profile at the final vertices (bilinear), with 3 m hysteresis to suppress DEM noise.
- Distances are horizontal UTM metres; the scale error is ≤ 0.1% inside the zone.

### 4.8 Output legs (a compatible extension of `RouteResult`)

```ts
export type LegKind = 'road' | 'trail' | 'xc' | 'gap' | 'route';
export interface RouteLeg {
  kind: LegKind;                         // 'route' = online-engine body of unknown class; 'gap' = untimed straight connector
  coordinates: [number, number][];       // lon/lat
  distanceM: number; climbM: number; descentM: number;
  durationS: number | null;              // moderate; null for 'gap'
  durationRangeS: [number, number] | null;
  name?: string; source?: 'OSM' | 'USFS' | 'BLM' | 'NPS';
  notes?: string[];                      // 'Admin use only (BLM)', 'Hiking restricted 01/01–12/31', 'Wilderness', 'crosses 2 perennial streams'
  veg?: { cls: number; m: number }[];    // xc only, sorted desc
  segments?: { cls: number; coordinates: [number, number][] }[];   // xc render runs by base class (≥ 60 m, else merged)
  short?: boolean;                       // xc < 40 m between two network legs (connector)
}
export interface RouteResult {
  geometry: { type: 'LineString'; coordinates: [number, number][] };   // kept: fitBounds + legacy draw
  distanceM: number; durationS: number; trafficDelayS: number | null;
  steps: RouteStep[];                    // generated from legs for offroad
  engine: 'tomtom' | 'osrm' | 'ors' | 'valhalla' | 'offroad';
  legs?: RouteLeg[];
  durationRangeS?: [number, number];
  climbM?: number; descentM?: number;
  modeled?: boolean;                     // any xc or gap leg
  crossesPerimeter?: boolean;
  notes?: string[];                      // 'near-optimal (weighted search)', 'Outside offline routing area — online engine used'
  provenance?: { bundleId: string; builtAt: string; veg: string; trailsDate: Record<string, string>; osm: string };
}
```

**Leg boundaries** fall where the kind changes (xc ↔ road/trail) or, on the network, where the edge name changes.

**Default names:** `unnamed road`, `unnamed dirt road` (TRACK), `unnamed trail`.

### 4.9 Integration into `fetchRoute` and `SearchDirectionsControl`

```ts
export async function fetchRoute(a, b, profile, ctx?: { offroad?: OffroadContext | null }): Promise<RouteResult> {
  // drive/apparatus unchanged
  if (profile === 'hike') {
    if (ctx?.offroad) {
      try { return await routeOffroad(a, b, ctx.offroad); }
      catch (err) {
        if (isOffroadError(err, 'unreachable') || isOffroadError(err, 'timeout')) throw err;  // no silent road-only substitute
        // 'outside' | 'load-failed' | 'no-bundle' → online engines, annotated
        try { return withGapLegs(await routeWalkOnline(a, b), a, b, [noteFor(err)]); }
        catch (onlineErr) { throw isOffroadError(err, 'outside') ? new OffroadError('offline-outside', err.which) : onlineErr; }
      }
    }
    return withGapLegs(await routeWalkOnline(a, b), a, b, []);   // ORS → Valhalla (existing), now gap-aware
  }
}
```

- **`withGapLegs`**: if haversine(A, first) or haversine(last, B) exceeds `GAP_MIN_M = 25`, the result gets `legs = [gap?, {kind: 'route', …body}, gap?]` and `modeled = true`. Online engines snap silently, up to 35 km for Valhalla.
- **`useOffroadContext()`** returns `{corneaId, descriptorUrl, bundleId, bbox, avoid: {key, polygons} | null, online}`, or null when the index entry is missing or its status isn't `ok`.
  - `avoid` is the **latest** perimeter by date: `usePerimeterIndex` + `usePerimeterVersion(latestPath)`, never the playhead version. It is null when `avoidPerimeter` is off or no perimeter is cached.
- **`SearchDirectionsControl.tsx`** (about 25 changed lines):
  1. `const offroad = useOffroadContext()`, and a ref.
  2. The effect key becomes `endpointsKey + '|' + (offroad ? offroad.bundleId + offroad.avoid?.key + avoidPerimeter : '-')`.
  3. Call `fetchRoute(a.coords, b.coords, p, p === 'hike' ? { offroad: offroadRef.current } : undefined)`.
  4. The `catch` uses `setRouteError(routeErrorText(p, err))`.
  5. Render `{route?.legs && <OffroadSummary route={route} />}` below the existing summary.
  6. The hike mode button shows `~` + `fmtDurationShort(result.durationS)` when `durationRangeS` is present.

  "Walk" stays the label, and the upgrade is transparent.

### 4.10 Route leg rendering (`routeLayer.ts`)

`routeFeatures(route)` is pure and tested:
- **No legs** (TomTom, OSRM, legacy): one Feature, `{kind: 'route'}`.
- **Legs:**
  - road, trail and route legs become `{kind}` features
  - each xc segment becomes `{kind: 'xc', veg: cls}`
  - a gap becomes `{kind: 'xc', veg: 0}`
  - when `route.notes` has an outside-area note, one `{kind: 'area'}` polygon is added (the AOI outline from the index `bbox`)

Layers on source `rd-route`:

| Layer | Filter | Paint |
|---|---|---|
| `rd-route-area` | `kind == 'area'` | line `#b8c0c8`, width 1.5, dash `[1, 2]`, opacity 0.8 |
| `rd-route-casing` (existing) | `kind != 'area'` | unchanged `#0d0a0c` 7 px @ 0.7; sits under the dashes, so they read on any ground |
| `rd-route-line` (existing) | `kind in [road, trail, route]` | unchanged `#4aa3ff` 4 px, solid |
| `rd-route-xc` | `kind == 'xc'` | `line-color: ['match', ['get', 'veg'], 1, '#d9c86a', 2, '#b0763a', 3, '#2f9a5f', 4, '#a19f96', 5, '#c9d77e', 6, '#8a8fa3', 7, '#e8f4ff', '#b8c0c8']`, width 4, `line-dasharray: [1.2, 1.1]` |

### 4.11 Summary, steps and error text

`OffroadSummary` shows these lines in order:

```
2 h 05 – 3 h 40                    typical 2 h 40
6.2 mi · ↑ 1,450 ft ↓ 380 ft
[████████ Trail & road 4.1 mi][▒▒▒▒ Cross-country 2.1 mi]
Cross-country through: Timber 1.2 mi · Shrub 0.6 mi · Grass 0.3 mi · crosses 2 streams
⚠ Cross-country legs are modeled, not scouted.
[✓] Avoid latest perimeter (Sep 24 06:10)          ← store.directions.avoidPerimeter
Steps ▾
 1. Cross-country 0.3 mi through timber · ↑ 220 ft · 12–25 min
 2. Iron Creek Trail #640 (USFS) · 2.1 mi · ↑ 600 ft ↓ 90 ft · 40–65 min · Wilderness
 3. FS 619 (unnamed dirt road) · 1.2 mi · 14–24 min
 4. Cross-country 0.2 mi through shrub, then onto Alpine Way Trail · …
ⓘ Loaded crew moving together, daylight; no fire, smoke or heat effects. Trail pace: Sullivan et al. 2020. Off-trail: USFS GET v2 method. LANDFIRE 2025 vegetation (modified), OSM + USFS/BLM/NPS trails; data built 6 h ago. Scout and time escape routes with the slowest person.
Routing data © OpenStreetMap contributors (ODbL) · USFS · BLM · NPS · LANDFIRE · USGS
```

Rules for this card:
- The ⚠ label is persistent and cannot be dismissed. It shows whenever a leg of kind `xc` or `gap` exists.
- `crossesPerimeter` adds a red line: "Route enters the latest perimeter — no way around was found."
- Gap legs read "+ 0.5 mi cross-country to B (not timed)".

**Error states** (`routeErrorText`, hike):

| Code | Text |
|---|---|
| `unreachable` | "No passable route found — water, cliffs or the fire perimeter block these points." |
| `timeout` | "Route search took too long — try points closer together." |
| `offline-outside` | "Offline: point {A/B} is outside this fire's routing area (dashed box)." The `rd-route-area` outline is shown. |
| `no-bundle` + offline | "No offline walking data for this fire yet." If the index says `building`: "Off-trail routing for this fire is still being built." |
| `load-failed` + offline | "Offline walking data failed to load — re-download this fire." |
| online-engine failure after an offroad fallback | the existing "No route found — try different points." |

### 4.12 Vegetation layer

- `vegetationLayer.update` does nothing unless `ctx.layers.vegetation.visible`.
- On a fire (`corneaId`) change it resets, following the perimeterLayer `lastFireKey` pattern.
- When visible: `offroadClient.vegImage(desc, 2048)`. The worker loads the bundle if needed and paints the `cls` band through the LUT from `vegClasses.ts` into RGBA (alpha 255). Display precedence: water/cliff, then stream flag (`#4f9fd6`), then slash flag (`#8c5a2b`), then the base class. The RGBA is transferred back.
- The main thread puts it in a canvas and adds `{type: 'canvas', coordinates: utmBoundsTo4326(bbox_utm).corners, animate: false}`, with raster `rd-vegetation`, `raster-resampling: 'nearest'`, `raster-fade-duration: 0`, and `raster-opacity` from the store.
- Source attribution: `'Vegetation: LANDFIRE (modified)'`.
- The legend chips live in `VegetationRow`.
- Offline it works unchanged, because the grid comes from the pack.

### 4.13 Offline pack additions

- **`PackInputs`** gains `routing: { indexOk: boolean; descriptorUrl: string; descriptor: RoutingDescriptor } | null`.
- **`snapshotUrls`**: when `routing?.indexOk`, push `${DATA_BASE_URL}/catalogs/routing.json` (mutable).
- **`buildPackPlan`**: when `routing`, push:
  - the descriptor URL, `immutable: true` (versioned path)
  - `dataUrl(desc.grid.url)`, `immutable: true`, `estBytes: desc.grid.bytes ?? EST.routingGrid`
  - `dataUrl(desc.graph.url)`, likewise
  - `dataUrl(desc.trails_pmtiles.url)`, if present

  New EST entries: `routingGrid: 4_000_000`, `routingGraph: 900_000`, `trailsExtract: 1_000_000`.
- **`runDownload` phase 1:**
  ```ts
  const idx = await rawJson<RoutingIndex>(`${DATA_BASE_URL}/catalogs/routing.json`, abort).catch(() => null);
  const ent = idx?.fires[corneaId];
  const desc = ent?.status === 'ok' && ent.descriptor ? await rawJson<RoutingDescriptor>(dataUrl(ent.descriptor), abort).catch(() => null) : null;
  ```
  Routing is optional: an index 404 surfaces as a CORS TypeError and becomes null, so the pack still succeeds without it. Once planned, the files are non-optional, keeping "no silent holes".
- **`opfs.ts`**: the extension regex becomes `/\.(png|json|geojson|tif|tar|pdf|gz|pmtiles)(\?|$)/`. There is no migration: no stored URL has those extensions.
- **`packs.ts` `contentTypeFor`**: add `.gz` → `application/gzip` and `.pmtiles` → `application/octet-stream`. `PackMeta` gets an optional `routingBundle?: string`, and `version` stays 1.
- **`OfflineCard`** copy: "…weather, the last 2 days of incident maps, trails, and off-trail walking routes." When `routingBundle` is set, it adds "Walking routes work offline inside this fire's area."
- **Exact-URL invariant:** plan and runtime both use `dataUrl(<descriptor path>)`, with the descriptor reached through `dataUrl(<index entry path>)`, and every fetch uses a string URL, never a `Request`.
- **Mixed online/offline consistency:** a pack's snapshot of the index points to that pack's bundle. Online, the newest index and bundle win, network-first. Every file is immutable and self-consistent per bundle, so mixing is impossible.

### 4.14 Analytics

Existing limits are 30 events per minute and 300 per page load.
- `trackOncePer('fire-view', 'offroad_route', {status})`, where status is `ok | outside | unreachable | timeout | fallback_online | offline_outside`.
- `trackOncePer('fire-view', 'offroad_bundle_loaded', {mb, ms_bucket})`.
- `track('offroad_route_result', {xc_pct_bucket, km_bucket, weighted, crosses_perimeter})`, only when a hike route is applied and has been on screen for at least 5 s. This is debounced in `OffroadSummary`.
- `trackOncePer('fire-view', 'trail_popup_opened', {agency})`.
- `layer_toggled {layer: 'trails' | 'vegetation'}` from the store actions.
- `avoid_perimeter_toggled {on}`.
- `offline_pack_downloaded` gains `{routing: bool, routing_mb}`.

### 4.15 Sources, credits and attribution

`SourcesView.tsx` `SOURCES` gains:
- USFS EDW National Forest System Trails (weekly FGDB, public)
- BLM GTLF Public Managed + Not Assessed Trails
- NPS Public Trails
- OpenStreetMap: "© OpenStreetMap contributors, ODbL. Routing graphs derived from OSM are published under ODbL at their bundle URLs."
- LANDFIRE LF2024/LF2025 EVT, EVC, FBFM40 and LF2020 slope/elevation (public domain; "modified")
- USGS NHD (HU8, 2023–24 vintage)
- Method credits: Sullivan et al. 2020 (Fire 3:52) and Campbell et al. 2024 GET v2 (Fire 7:292)

Map sources carry their own attribution strings, and `OffroadSummary` shows the routing-data attribution line.

### 4.16 Health page

- `HealthDoc` is untouched. New types: `TrailsHealthDoc` and `RoutingHealthDoc`.
- `HealthView` adds a "Trails & routing" section, reading `catalogs/health/{trails,routing}.json` via the new fetchers. It shows the build id, age, counts, failures and building/unsupported counts.
- It also adds two `PipelineRuns` rows from the per-workflow runs endpoint.

---

## 5. Testing and verification

### 5.1 Worker (pytest, local plus the new workflows' guard steps)

| File | Covers | Fixtures (real captures, trimmed) |
|---|---|---|
| `test_config.py` | new cache/content rules; the invariant that `trails/` and `routing/` are immutable and every mutable doc is under `catalogs/`, `state/` or `work/` | — |
| `test_trails_normalize.py` | every mapping in §3.5: dirty values (`'TRAIL_GRADE'`, `'N/A'`, trailing-space date ranges, `'654'`, mixed-case BLM codes, pipe-delimited NPS TRLUSE, `'Class 3'`, `'6'`), `tidy_name`, sanity gate | `fixtures/trails/usfs_rows.json` (60 rows from `scratchpad/dataapi/usfs_terra.gpkg`), `blm_rows.json`, `nps_rows.json` |
| `test_arcgis.py` | paging stop conditions, `exceededTransferLimit`, count mismatch → retry → fail, max-edit probe | `httpx.MockTransport` with captured page JSON |
| `test_pmtiles_inspect.py` | header, directories, per-zoom counts, MVT layer names | `fixtures/trails/tiny.pmtiles` (built once locally with GDAL, ~20 KB) + a GDAL skip-if-missing test that builds from `tiny.gpkg` |
| `test_trails_job.py` | decision logic (unchanged, deferred_weekly, forced), upload order (recording storage asserts assets → build.json → pointer → state), prune selection | monkeypatched probes and `gdal_cli.run` |
| `test_utm.py` | Krüger forward/inverse vs PROJ points (captured `gdaltransform` output, 20 points across zones 10–19); round-trip < 1 mm | `fixtures/routing/utm_points.json` (also read by vitest) |
| `test_routing_aoi.py` | perimeter+buffer, point+acres, min/max, snap, clamp flag, hysteresis (contain → keep, grow → union ≤ max), zone choice, bbox4326 | synthetic |
| `test_osm_opl.py` | OPL parse (`%20%` escapes), way filter, kind/sac/flags mapping, split at shared nodes | `fixtures/routing/stanley_small.opl` (from the Idaho extract, ~1k ways) |
| `test_graph_build.py` | endpoint snap, interior crossings, no noding at bridges/tunnels, clip, Int16 delta split, duplicate collapse, stats; RDG1 encode → decode round-trip; header golden offsets; `last vertex == node[to]` | synthetic plus `rdg1_tiny.bin.gz` contract fixture (S0) |
| `test_cost_grid.py` | class/multiplier table, shrub cover rule, TL/SB/stream compounding, water and cliff impassable, nodata, elev quantization and offset; VRT raw → GTiff (GDAL-guarded: `gdalinfo -json` bands, dtype, DEFLATE, epsg) | 60×60 crops of the real Stanley LANDFIRE exports |
| `test_landfire.py` | exact exportImage URL, 5070 snapping, LF2025 → LF2024 decision, JSON-error detection, WCS URL + 32767 normalization | captured small TIFF and error JSON |
| `test_nhd.py` | TNM response parsing → HU8 list, perennial SQL, cache key | captured TNM JSON |
| `test_routing_job.py` | plan actions table, bundle_id determinism (same inputs → same id; any single change → new id), check → unchanged path, shard partition, finalize merge (including an unmerged run), index statuses (ok/stale/building/unsupported), prune selection (current + prev ≤ 14 d; inactive > 30 d) | DryRunStorage, StubClient |
| `test_lf_luts.py` | generated LUT JSON matches the CSV for 7292, 7735, 7295, 7299 and 20 random codes | `LF2024_EVT.csv` excerpt |

### 5.2 Frontend (vitest, node, pure modules only)

| Test | Covers |
|---|---|
| `routing/contract.test.ts` | TS constants equal `worker/responder_worker/data/offroad_contract_v1.json`, read via `fs` |
| `routing/costModel.test.ts` | Sullivan Table 4 values (high tertile 16.1, 11.9, 9.9, 14.0 and 19.7 min/km at −30…+30), moderate 1.381, low 0.961, `vGet(0) = 1.149`, `vGet(30) = 0.441`, `asym` mean, V_MIN clamp, `V_MAX_H` ≥ max of every speed |
| `spread/utm.test.ts` | forward/inverse against the shared `utm_points.json` |
| `routing/rdg1.test.ts` | decodes `worker/tests/fixtures/routing/rdg1_tiny.bin.gz` (cross-language golden) and the Python-encoded Stanley sample |
| `routing/gridDecode.test.ts` | `geotiff.writeArrayBuffer` 3-band UInt16 UTM fixture → scales, sentinels, bbox |
| `routing/perimeterMask.test.ts` | polygon with a hole, MultiPolygon, all-touched boundary |
| `routing/astar.test.ts` | uniform grass straight line (cost = L·M/vGet); a barrier forces a detour; water impassable; knight-move cut-cell rule; diagonal squeeze rule; trail portal preferred when cheaper; join/leave mid-edge; perimeter soft block and `crossesPerimeter`; window retry; weighted fallback flag; **optimality vs a brute-force TS Dijkstra on 30 random small cases** |
| `routing/smooth.test.ts` | never increases cost, never crosses impassable or new mask cells |
| `routing/legs.test.ts` | leg boundaries, veg breakdown sums to xc length, `fast ≤ mod ≤ slow`, short connectors, climb hysteresis, step text |
| `api/routing.test.ts` | `withGapLegs` thresholds; the legs-less result shape is unchanged |
| `map/layers/trailsStyle.test.ts` | `groundFor` matrix, `trailPaint` per ground, popup escaping and uses text |
| `map/layers/routeLayer.test.ts` | `routeFeatures` for legacy routes, offroad legs, gaps and the area |
| `map/pmtiles.test.ts` | `BufferSource.getBytes` slicing and key |
| `offline/packModel.test.ts` | routing snapshot + 4 immutable files; bytes from the descriptor; no routing → unchanged plan |
| `map/zOrder.test.ts` | new ids' groups and order |
| `app/urlState.test.ts` | `trl`/`veg` round-trip |
| `state/*` | `toggleTrails`, `setVegetation`, `setAvoidPerimeter`, and the `selectFire` reset rules |

### 5.3 Verification plan

**A. Worker dry run on real fires** (macOS: brew GDAL 3.13 + `brew install osmium-tool`; the known difference from CI's 3.8.4 is noted):
```
cd worker && uv sync && uv run pytest -q
S=(local scratch)/verify
uv run python -m responder_worker.cli sync-trails --dry-run --out $S/out --force
# 0445-crosswhite, OR, 342,923 ac: exercises the 60 km clamp, zone 10, LF2025 (NW GeoArea)
uv run python -m responder_worker.cli routing-one --fire '{1B0219EE-5298-4FEF-9927-C2666D9D53FC}' --dry-run --out $S/out
# upper-smith, ID, 4,848 ac at 48.93°N: Canadian-border nodata handling
uv run python -m responder_worker.cli routing-one --fire '{AA3DF707-B3F6-41B8-A5FF-BF502A918FFC}' --dry-run --out $S/out
# dome, CA (Yosemite, NPS trails; bare-uuid cornea id): fire_key normalization
uv run python -m responder_worker.cli routing-one --fire 4883092e-485f-429d-878d-819f01172840 --dry-run --out $S/out
# north-trapper, MT, 0 ac, no perimeter: point + minimum AOI
uv run python -m responder_worker.cli routing-one --fire '{63BA97D7-BBED-4C69-ABC9-B05B51A8CAE2}' --dry-run --out $S/out
```

In dry runs, trails are read from the local FGB path rather than `/vsicurl/`: the storage decides.

Check the outputs:
- `gdalinfo -json` on each `grid.tif`: EPSG 32610 for Crosswhite, width and height as expected, 3 × UInt16, DEFLATE.
- `python -m responder_worker.graph_build inspect … --geojson $S/g.geojson`, then eyeball the result in a browser.
- `python -m responder_worker.pmtiles_inspect $S/out/trails/b*/trails.pmtiles`.
- Descriptor stats are plausible: Crosswhite impassable < 5%; upper-smith nodata > 0 north of the border.

Then run once in CI with `workflow_dispatch dry_run=true` on the branch. Artifacts are uploaded and nothing touches B2, which confirms GDAL 3.8.4 behavior: PMTiles writes, FGB `-spat` over the local file, and gdal_rasterize.

**B. Static-build preview** (per project memory: the dev server can't start from ~/Desktop):
```
cd frontend && npx vitest run && npx tsc --noEmit
VITE_BASE=/ VITE_DATA_BASE_URL=http://localhost:4231/data npx vite build --outDir $S/preview --emptyOutDir
python3 $S/data_server.py --spa $S/preview --data $S/out --fallback https://f005.backblazeb2.com/file/responder-debrief-data --port 4231
```
`data_server.py` is a scratch stdlib `http.server` of about 60 lines. It serves the SPA fallback, serves `/data/*` from the local `out/` with single-Range 206 support (national pmtiles), and sends `Access-Control-Allow-Origin: *`. For missing data keys it answers 302 to B2, so the live `catalog.json` is used. Port 4231 is fresh; the memory lists 4173–4203 as used by earlier sessions.

Open it with `preview_start {url: "http://localhost:4231/fire/%7B1B0219EE-5298-4FEF-9927-C2666D9D53FC%7D?trl=1&hs=0"}` at 800×600, then check:
1. Trails render on all four grounds: topo (default), satellite, map-dark and map-light (switch theme). Take screenshots.
2. Tap a trail: the popup fields are right. A tap with both route ends set opens the popup and does not move B.
3. Layers tab → Vegetation on: the legend, the opacity slider, and classes align with the terrain (timber on slopes, water in lakes).
4. Directions: A on a road, B in timber about 1 km off-trail inside the AOI → Walk:
   - solid blue road/trail legs and dashed veg-colored xc legs
   - summary range, split bar, veg chips, persistent label, steps
   - repeat with B across the perimeter, avoid on vs off
5. B outside the AOI: online fallback plus a dashed gap leg.
6. Download this fire, stop `data_server.py`, reload. The offline style boots and trails come from the extract. Walk works; the network tab shows no requests and responses carry `x-rd-offline`. With B outside the area: the error text plus the dashed AOI outline.
7. `/health`: the new rows and section.
8. Mobile viewport 375×812: summary layout, bottom sheet, toggles.

Record worker timings (`ms`, `expanded`) from the summary's debug `title` attribute. Before rollout, do one real mid-range Android test, since no phone timings exist yet.

---

## 6. Implementation plan: parallel slices

Waves: **W1** = {S0, S1, S6} → **W2** = {S2, S3, S4, S7, S10, S12} → **W3** = {S5, S8, S11} → **W4** = {S9, S13} → **W5** = S14. File ownership is exclusive per slice; the shared seams are owned by S1 (worker) and S6 (frontend).

| Slice | Owns (create / modify) | Depends on | Acceptance criteria | Tests |
|---|---|---|---|---|
| **S0 Contract & fixtures** | `docs/spec-offroad.md` (this contract: keys, JSON schemas, RDG1, bands, classes); `worker/responder_worker/data/offroad_contract_v1.json`; `worker/scripts/make_contract_fixtures.py` (independent struct-based RDG1 writer + VRT/GDAL tiny grid); `worker/tests/fixtures/routing/{rdg1_tiny.bin.gz, grid_tiny.tif, descriptor_example.json, routing_index_example.json, trails_pointer_example.json, utm_points.json}` | — | Fixtures reproducible from the script; example JSONs validate against the schemas in the doc | fixture self-check in `test_contract.py` |
| **S1 Worker infra** | `gdal_cli.py`; `b2.py` (list, head, version-deletes); `http.py` (`download_to`); `config.py` (all constants and rules); `pyproject.toml` + `uv.lock` (+numpy); `cli.py` (one registration line + docstring); stub `trails_cli.py` and `routing_cli.py` with `register()` | — | `uv run pytest` still 204+ green; `cli --help` lists the new subcommands (stubs exit 2) | `test_config.py`, `test_b2_versions.py` (moto-free stub client), `test_http_download.py` (MockTransport streaming) |
| **S2 Trails pipeline** | `trails_normalize.py`, `arcgis.py`, `pmtiles_inspect.py`, `trails.py`, `trails_cli.py` (fill), `.github/workflows/trails.yml`, fixtures under `tests/fixtures/trails/` | S0, S1 | Local `sync-trails --dry-run --force` produces pmtiles (inspect passes), fgb, build.json and pointer in the right order; count sanity works; a second run is `unchanged` | `test_trails_normalize.py`, `test_arcgis.py`, `test_pmtiles_inspect.py`, `test_trails_job.py` |
| **S3 Graph builder** | `utm.py`, `osm_extract.py` (OPL parser + region table + `refresh_region`), `graph_build.py`, `data/us_state_bboxes.json` | S0, S1 | Stanley OPL + a USFS sample → RDG1 whose decode equals the input topology; golden fixture decodes; `inspect` CLI emits GeoJSON | `test_utm.py`, `test_osm_opl.py`, `test_graph_build.py` |
| **S4 Cost grid** | `landfire.py`, `nhd.py`, `cost_grid.py`, `scripts/gen_lf_luts.py`, `data/lf_evt_class_{2024,2025}.json` | S0, S1 | For the Stanley box, `grid.tif` matches the contract (bands, scales, EPSG, compression); stats plausible; LF2025 → 2024 fallback works on a Minnesota box | `test_cost_grid.py`, `test_landfire.py`, `test_nhd.py`, `test_lf_luts.py` |
| **S5 Routing orchestration** | `routing_aoi.py`, `routing.py`, `routing_cli.py` (fill), `.github/workflows/routing.yml` | S2 (FGB contract only; can mock), S3, S4 | `routing-one --dry-run` on the 4 verification fires publishes descriptor, pointer, index and health in order; a rerun is a no-op (`skip`); forcing a trails change yields `check` → same `bundle_id` when the AOI's trails are unchanged; prune dry-selection correct | `test_routing_aoi.py`, `test_routing_job.py` |
| **S6 Frontend seams** | `map/zOrder.ts` (+ test), `state/store.ts` (slices + actions + selectFire rules), `app/urlState.ts` (+ test), `api/types.ts`, `api/catalogs.ts`, `api/queries.ts` (trails pointer, routing index/descriptor, health fetchers and hooks), `vite.config.ts` (`worker.format: 'es'`), `package.json` (pmtiles), `routing/types.ts`, `routing/contract.ts` (+ test) | S0 | `tsc` and vitest green; no behavior change visible | `zOrder.test.ts`, `urlState.test.ts`, `drawStore`-style store test, `contract.test.ts` |
| **S7 Routing core (pure)** | `routing/costModel.ts`, `vegClasses.ts`, `spread/utm.ts` (forward), `rdg1.ts`, `gridDecode.ts`, `hybridGraph.ts`, `perimeterMask.ts`, `astar.ts`, `smooth.ts`, `legs.ts`, `errors.ts` + all tests | S0, S6 (types) | A* optimality equals brute-force Dijkstra on random cases; legs and time ranges pass; decodes both goldens | §5.2 routing tests |
| **S8 Worker, client & API** | `routing/offroad.worker.ts`, `offroadClient.ts`, `bundleStore.ts`, `useOffroadContext.ts`; `api/routing.ts` (types, ctx, `withGapLegs`, `routeWalkOnline` extraction) | S6, S7 | In the preview build: a route from the console helper returns legs offline and online; the stale-drop works under drag | `api/routing.test.ts` (gap legs, shape compatibility) |
| **S9 Directions UI & route rendering** | `panels/SearchDirectionsControl.tsx` (≈25 lines), `panels/OffroadSummary.tsx`, `panels/offroad.css`, `map/layers/routeLayer.ts` (+ `routeLayer.test.ts`) | S8 | Summary, labels, steps, avoid toggle and error states match §4.11; legacy engines render exactly as before | `routeLayer.test.ts`; browser checks 4–6 |
| **S10 Trails layer** | `map/pmtiles.ts` (+ test), `map/layers/trailsStyle.ts` (+ test), `map/layers/trailsLayer.ts`, `panels/TrailsRow.tsx` | S6 (types, fetchers, store); S8's `bundleStore` only for offline-extract selection (if S8 isn't landed yet, trails work online only) | Trails on 4 grounds, popup, click arbitration, offline extract swap | `trailsStyle.test.ts`, `pmtiles.test.ts`; browser checks 1–2, 6 |
| **S11 Vegetation layer** | `map/layers/vegetationLayer.ts`, `panels/VegetationRow.tsx`; worker `vegImage` handler (inside `offroad.worker.ts`, coordinated with S8 as an append-only message case) | S8 | Canvas aligns with terrain; opacity, legend, reset per fire | `vegClasses` LUT test (in S7); browser check 3 |
| **S12 Offline pack** | `offline/packModel.ts` (+ test), `offline/packs.ts`, `offline/opfs.ts`, `panels/OfflineCard.tsx` | S0, S6 (types) | The pack includes the 5 routing URLs; a pack without routing still succeeds; offline Walk and trails are served from OPFS | `packModel.test.ts`; browser check 6 |
| **S13 Registration, health & credits** | `map/useMapLayerSync.ts` (MANAGERS + INTERACTIVE), `panels/tabs/ForecastTab.tsx` (2 rows), `panels/HealthView.tsx`, `panels/SourcesView.tsx`, `map/pinDrop.ts` `FEATURE_LAYERS` (only if the hotspot-flames work has merged) | S10, S11 | Layers render from the Layers tab; `/health` shows the new rows; `/sources` lists the credits | browser checks 1, 3, 7 |
| **S14 Verification & rollout** | scratch `data_server.py`; CI dry-run dispatches; the README lifecycle-rule note | all | §5.3 A + B complete; the first real Trails run, then the first real Routing run with `ROUTING_SHARDS=4`; health green | — |

**Conflict notes.**
- S6, S9 and S13 touch the files that already carry uncommitted edits in the main checkout (`zOrder.ts`, `store.ts`, `useMapLayerSync.ts`, `SearchDirectionsControl.tsx`). Keep those diffs additive and small.
- Rebase onto the hotspot-flames merge before S13. That merge rewrites `ensureOrder` with a no-op-move skip, which makes the eight added ids cheap per `styledata`.
- No slice touches `geo.ts` or `panels.css`.

---

## 7. Risks, open questions, non-goals

### 7.1 Risks (with mitigations)

1. **GDAL 3.8.4 PMTiles writer.** Tile degradation is silent, and `MAX_SIZE`/`SIMPLIFICATION` behavior on 3.8.4 is unverified in CI. Mitigations: `pmtiles_inspect` gates publishing (zoom range, tile counts, layer present, max tile size); the `CPL_DEBUG=MVT` line count goes to health; the CI dry-run dispatch runs before the first real build; runs are pinned to `ubuntu-24.04`.
2. **B2 versioning costs.** Deletes hide rather than delete, and pointers accumulate versions. Mitigations: pruning deletes by VersionId, plus the recommended lifecycle rules.
3. **LANDFIRE ImageServer.** It is anonymous and not documented as a programmatic channel; terms and rate limits are unknown. Mitigations: WCS fallback, sequential requests, a circuit breaker, per-fire deferral. LFPS is never used because it needs an email.
4. **Geofabrik volume.** The first week downloads about 6–8 GB across ~28 states, then only regions with active fires, weekly. Mitigations: the plan-stage single pass per region and deletion after extraction.
5. **ODbL.** `graph.bin.gz` is a derived database. Mitigations: an ODbL notice in the descriptor and on Sources; the file is publicly downloadable, which is the "offered copy". Trails PMTiles and the grid contain no OSM data.
6. **Phone performance.** No phone timings exist: about 90 MB in the worker at 4M cells, and 0.3–1 s of load plus decode. Mitigations: windowed search, weighted fallback, the 3.5 s budget, warm-up on endpoint set. Must be tested on a mid-range Android before release.
7. **Model accuracy and safety.**
   - The 30 m DEM misses short cliffs.
   - LANDFIRE is pre-fire vegetation at 2024/2025 vintage.
   - The EVT/EVC mismatch rule, the snow 2× multiplier, the 30% shrub default and the added Sullivan asymmetry off-trail are our choices.
   - DEM grade along switchbacks is noisy (capped at 30° on-network).

   Mitigations: the persistent "modeled, not scouted" label, ranges rather than single numbers, stated assumptions, and the IRPG line.
8. **Perimeter staleness.** Avoidance uses the latest *published* perimeter, which can lag hours; it is shown with its timestamp. Crossing is soft (×50) and flagged.
9. **Agency geometry accuracy** is ±10–40 m. Snapping at 12 m may miss some junctions, but the hybrid grid always connects, at the cost of short "connector" xc legs, which the UI de-emphasizes.
10. **Mega-fire clamp.** A 60 km cap can exclude parts of mega-fire surroundings (Crosswhite, Coleman Creek). Walk falls back online beyond the area, and the outline is shown.
11. **Unreliable GitHub cron.** Runs every 6 h may fire every 6–12 h. The work is idempotent and catch-up safe; new fires can wait up to one missed cycle.
12. **Merge churn** with the hotspot-flames work in `zOrder.ts`, `useMapLayerSync.ts`, `store.ts` and `SearchDirectionsControl.tsx`. Mitigations: additive diffs, isolated slices, and rebasing before S13.
13. **CI tests.** Tests guard the new workflows, which is a new convention in this repo. A flaky test could block publishing, but only these jobs; previous data stays served.
14. **Zone-edge fires.** A fire at a UTM zone edge sees ≤ 0.4% scale error in the zone of the AOI center. That is acceptable.

### 7.2 Open questions for the owner

1. Approve `pmtiles` (7.7 kB gz, lazy-loaded)? It will be reused by the planned offline basemap. The fallback is the in-repo reader with the same contract.
2. Should trails default to **off**, as a persistent viewing preference like traffic? Alternatives: default on, or auto-on while a Walk route is shown.
3. Should weekly prune of superseded routing bundles run automatically (explicit `--prune --confirm` in the workflow) or manually only?
4. Keep OSM `access=private` roads routable (flagged)? The current design says yes.
5. Confirm the cost-model choices:
   - SB ×5 (not ×4)
   - streams = NHD fcode 46006 + 46000 plus StreamRiver areas
   - perennial lakes only
   - snow 2×
   - shrub default cover 30%
   - `PERIM_PENALTY` 50 with 0 m buffer
6. Raise `AOI_MAX_SIDE_M` above 60 km for mega fires, which costs phone memory?
7. Add a pad to the slow end of the off-trail range (e.g. ×1.2 "unscouted")? The current design has none; the range comes from Sullivan's tertile spread.
8. v1.1 scope: AK/HI/PR support (37 fires today), and state trail sources (COTREX, UGRC).

### 7.3 Non-goals (v1)

- Vehicle off-road or apparatus routing changes. BLM/USFS/MVUM roads are not in the overlay or the graph beyond what OSM already has.
- Turn-by-turn navigation or GPS following.
- Stitching a partial offline route with an online one when one endpoint is outside the area (v2); v1 falls back entirely.
- Routing across more than one fire's bundle, or any offline routing outside a bundle.
- Enforcing legal-use restrictions. They are shown, not avoided, per the owner.
- Current-season NIFS event lines (restricted), lidar/STRIDE density models, or fire-behavior-aware timing.
- Offline basemap or terrain tiles.
- Any change to `catalog.json`, `state.json` or the `worker-b2-writes` jobs.
- Overpass, servers or proxies.
- Alaska, Hawaii and Puerto Rico bundles.

---

## Appendix A. Research conflicts and the choice made

| Topic | Conflict | Chosen | Why |
|---|---|---|---|
| GET v2 slash multiplier | Table and overview say ×5; one methods sentence says ×4 | **×5** | Two statements against one; also the conservative option (slower). |
| LANDFIRE access | Research notes: LFPS async job API. Data facts: anonymous ImageServer exportImage plus WCS. | **exportImage, WCS fallback, never LFPS** | LFPS requires an email; exportImage returns grid-exact 30 m tiles in about 1 s; WCS returns identical pixels. |
| Stream source | GET v2 used NHDPlus HR; REST services timed out 60–110 s | **Static NHD HU8 GeoPackages** (fcode 46006 + 46000) | Reliable, frozen, cacheable; HU8 granularity is right. |
| OSM tooling | Research: pyosmium or pyrosm (PyPI). Constraint: minimal deps. Sizes were measured via Overpass. | **Geofabrik + apt osmium-tool + stdlib OPL** | No PyPI dependency; exact node ids; Overpass is banned for crons. |
| DEM | Client note: terrarium tiles. Data facts: 3DEP F32 fresher; LF2020 Elev/SlpD share the EVT grid. | **LF2020 Elev + SlpD** (3DEP as a config alternative) | Same grid as the vegetation layers, no extra alignment, GET v2 used LF slope, and 3DEP correlates at r = 0.97. |
| BLM layers | MapServer layers 2–7 vs hosted FeatureServer /2 + /7 | **FeatureServer /2 (managed) + /7 (not assessed)** | MapServer 2–5 are subsets of 7, so unioning double-counts; the owner specified these layers. |
| USFS channel | REST MapServer vs weekly FGDB zip | **FGDB zip** | Atomic; the REST service was observed mid-reload (34k → 86k features). |
| Tile packaging | z/x/y MVT directory (no new dependency) vs PMTiles | **PMTiles** | A z/x/y tree means 85k–212k objects per rebuild, sparse-grid 404s without CORS, gzip without Content-Encoding, and a worker-side fetch bypass. PMTiles is one object and has a clean offline path. |
| Trail zooms | Measured z7–13 and z7–14 | **z8–13** | z7 is useless on fire maps; z14 costs 2.5× tiles for +45% bytes; MapLibre overzooms. |
| Off-trail model | Tobler ×0.6; STRIDE (needs lidar); GET v2 multipliers | **GET v2 + Sullivan asymmetry** | STRIDE's density term needs lidar; ×0.6 is crude; GET v2 is agency-vetted and uses national 30 m inputs. |
| Grid neighbourhood | Research default: 8-neighbour + smoothing | **16-neighbour + smoothing** (constant switch) | Worst-case elongation 2.8% vs 8.2% feeds directly into time estimates; the 1.4–1.6× search cost is absorbed by windowing. |
| Offline PMTiles serving | Offline notes: OPFS FileSource or Range emulation | **In-memory BufferSource over a whole-file fetch** | The extract is ≤ about 2 MB; no exported pack lookup, no File-snapshot invalidation, no wrapper change. |
| Numeric work in the worker | Convention: no numpy in the venv (GDAL numpy is system-only) | **Add numpy to uv** | Required for 4M-cell grids at 300 fires per week; GDAL stays CLI-only via ENVI raw I/O. |
| Health publishing | worker.md: `health.publish` into `catalogs/health.json` | **Separate `catalogs/health/{trails,routing}.json`** | That document is read-modify-written by jobs in `worker-b2-writes`; a new writer outside the group could race and clobber sections. |
| Fire list source | Existing: prod `/fires?active=true` | **Published `catalogs/catalog.json`** | Zero extra fire-API traffic, and ids and acres identical to the site; perimeters still come from DEV. |

## Appendix B. Constants (single table)

| Constant | Value | Where |
|---|---|---|
| `TRAILS_RECIPE_VERSION` | 1 | config.py |
| `TRAILS_MIN_ZOOM` / `MAX_ZOOM` | 8 / 13 | config.py |
| `TRAILS_REBUILD_MIN_AGE_DAYS` | 6.5 | config.py |
| `TRAILS_KEEP_BUILDS` / keep days | 3 / 21 | config.py |
| `TRAILS_COUNT_FLOOR` | usfs 50k, blm_managed 15k, blm_not_assessed 3k, nps 25k | config.py |
| `TRAILS_COUNT_DROP_MAX` | 0.10 | config.py |
| `ROUTING_RECIPE_VERSION` / `COST_MODEL_VERSION` | 1 / 1 | config.py |
| `AOI_BUFFER_M` / `AOI_MIN_SIDE_M` / `AOI_MAX_SIDE_M` / `AOI_SNAP_M` | 10 000 / 21 000 / 60 000 / 1 500 | config.py |
| `GRID_CELL_M` | 30 | config.py, contract |
| `LF_ORIGIN_5070` | (−2362425, 3267405) | config.py |
| `SHRUB_COVER_DEFAULT` | 30 | contract |
| `SNAP_M` (agency endpoint snap) | 12 | config.py |
| `OSM_MAX_AGE_DAYS` | 7 | config.py |
| `ROUTING_SHARDS` | 4 | config.py / workflow |
| Deadlines | plan 2 400 s · build 7 800 s · trails 5 400 s | env-wired argparse |
| `DENSIFY_M` / `TRANSITION_S` / `PERIM_PENALTY` / `V_MIN` / `V_MAX_H` | 30 / 3 / 50 / 0.05 / 1.41 | costModel.ts |
| `NET_GRADE_CAP_DEG` / `XC_MAX_GRADE_DEG` | 30 / 45 | costModel.ts |
| `GAP_MIN_M` / short-connector threshold | 25 / 40 | routing.ts / legs.ts |
| Search budget / weighted fallback | 3 500 ms / w = 1.6 | astar.ts |
| Window pad | max(3 000 m, 0.5·\|AB\|) | astar.ts |
