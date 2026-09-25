# Trails overlay + offline off-road foot routing: design (routing-fidelity lens)

Branch: `trails-offroad-routing` (worktree at HEAD 69858dc). Author role: architect, with routing quality and model fidelity as the priority. Every component is designed end to end below.

Status of inputs: I read the six `understand/*.md` maps and four research notes. I then confirmed the details against source files: `api/routing.ts`, `SearchDirectionsControl.tsx`, `routeLayer.ts`, `zOrder.ts`, `useMapLayerSync.ts`, `layerTypes.ts`, `store.ts`, `offline/{packModel,packs,opfs}.ts`, `spread/{utm,toaRenderer}.ts`, `vite.config.ts`, `package.json`, `worker/{config,b2,fires,hotspots}.py`, `pyproject.toml` and `tile.yml`. I checked the live `catalogs/catalog.json` on 2026-09-24: it lists **328** active wildfires. The largest are 0445-crosswhite OR (342,923 ac), coleman-creek OR, little-giant WA and sinlahekin WA. By state there are 31 in PR and 6 in AK. `cornea_id` is a braced GUID such as `{091081ED-BD23-4610-AE4A-270F95D1711E}`.

I computed the cost-model numbers in this document with `scratchpad/design/costmodel_check.py`. For example, the Sullivan high tertile reproduces the paper's Table 4 exactly: 16.1, 11.9, 9.9, 14.0 and 19.7 min/km at −30°, −15°, 0°, +15° and +30°.

---

## 0. Key decisions (one screen)

| # | Decision | Why |
|---|---|---|
| D1 | The **hybrid graph + grid A\*** runs in a module Web Worker. A trail/road graph of densified vertices (≤20 m) is linked by "portals" to a 30 m UTM cost grid, so a route can join or leave a trail at any vertex. The grid uses **16 neighbours**, knight moves check the cells they cross, and a cost-aware string-pulling pass follows. | Keeps exact trail geometry and anisotropic trail costs. 16 neighbours cut worst-case metrication error from 8.2% to 2.8%. The portals also absorb topology errors in the agency/OSM network: a missing junction costs one ~30 m cross-country hop, not a failed route. |
| D2 | **Trail and road legs** use the **Sullivan 2020 loaded-crew Lorentz tertiles**, which are anisotropic. **Off-trail (grid) legs** use the **GET v2 isotropic Lorentz**, with its peak shifted to −2.8° to make it anisotropic, times the **GET v2 multipliers**. The off-trail time *range* applies Sullivan's tertile/moderate ratios at the same slope (clamped to ±30°). | This follows the owner's spec: Sullivan tertiles on trail, GET v2 off-trail. It adds anisotropy with the smallest defensible change, a peak shift from the literature (Tobler −2.86°, Sullivan −2.3° to −3.4°, STRIDE −2.32°). The crew-variability band comes from the only firefighter-calibrated spread available. |
| D3 | The search minimizes **typical (moderate) time**. The three tertile times are computed afterwards on the final, smoothed geometry. | One search gives one route. The range expresses crew variability, not route choice. |
| D4 | The **grid** is a 2-band `cost_veg.tif` (cost byte on a log2 scale, veg class + flags) plus a `dem.tif` (UInt16 decimetres above a per-bundle base). Both are UTM EPSG:326xx at 30 m, DEFLATE. The **graph** is a structure-of-arrays binary (`graph.bin.gz`) that the worker gunzips with `DecompressionStream`. | geotiff 2.1.3 decodes DEFLATE and PREDICTOR=2. SoA arrays give zero-copy typed-array views. B2 cannot send Content-Encoding, so the client gunzips explicitly. |
| D5 | **Trails** are built weekly into a national **PMTiles** (z8–13) via GDAL 3.8.4 (temp MBTiles → PMTiles) plus a national **FlatGeobuf** of the normalized trails. The routing job cuts per-fire extracts (PMTiles z8–14) from the FGB over `/vsicurl/`. GDAL 3.8.4 never reads PMTiles. | Avoids GDAL bug #9288 and the go-pmtiles binary. FGB range reads mean the routing job never downloads the national file. |
| D6 | Mutable pointers live under `catalogs/`: `catalogs/trails.json`, `catalogs/routing.json` and `catalogs/routing/{fire}.json`. Immutable assets live under the new `trails/` and `routing/` prefixes. Private state goes in `state/trails.json` and `state/routing.json`. Nothing touches `catalog.json` or `state/state.json`. | Both catalog writers rebuild `catalog.json` wholesale, and `state.json` is shared. Existing cache rules cover `catalogs/` (60 s) and `state/` (private). |
| D7 | Bundles are keyed by the **normalized cornea GUID** (`091081ed-bd23-…`), never by `fire_slug`. | `fire_slug` depends on API order. |
| D8 | Offline: all routing files are fetched on the **main thread through the wrapped `window.fetch`** and transferred to the worker. Trails come from a **custom pmtiles `Source` over the OPFS `File`**. The wrapper passes through any request that carries a `Range` header. | Web Worker fetches and MapLibre vector-tile fetches bypass the wrapper. PMTiles `FetchSource` cannot use a whole-file 200 response. |
| D9 | Walk engine selection: **offroad** when both A and B are inside the fire's grid, and it works offline. Otherwise the online ORS→Valhalla route plus **explicit end-gap legs**. A gap is routed offroad if its two ends are inside the grid, and otherwise drawn as a dashed straight "unmodeled" leg. When both points are inside the grid there is no silent fallback to online engines. | Matches the owner's spec. Online engines ignore the perimeter and impassable terrain, so silently substituting them would be dishonest. |
| D10 | The **latest** perimeter (newest by date from the index, not the playhead version) is rasterized in the worker and dilated by **100 m**, and those cells are made impassable. If A or B is inside it, avoidance is switched off for that request and the legs inside are flagged. | Honest and simple. A crew inside the black knows more than the model does about which way is safe. |

---

## 1. Architecture overview and data flow

```
                        ┌──────────────────────── GitHub Actions (ubuntu-24.04, GDAL 3.8.4) ─────────────────────────┐
 USFS EDW FGDB zip ────►│ trails.yml  (daily cron, builds when ≥6 d old & sources changed; group "trails")            │
 BLM GTLF FS/2, FS/7 ──►│  sync-trails: fetch → ogr2ogr GPKG → attrs CSV → trail_schema.py normalize → join →      │
 NPS Trails MS/0 ──────►│   parts/{usfs,blm,nps}.fgb → trails.fgb (national, normalized) → trails.pmtiles (z8–13)   │
                        │   upload trails/b{id}/…  →  catalogs/trails.json (LAST)   state/trails.json  health.trails  │
                        └───────────────┬────────────────────────────────────────────────────────────────────────────┘
                                        │ workflow_run(Trails completed) + daily cron
                        ┌───────────────▼──────────── routing.yml (group "routing-bundles") ─────────────────────────┐
 fire-api PROD index ──►│ plan job:  routing-plan → active fires, latest perimeters (FIRE_API_DEV), AOIs, input keys, │
 fire-api DEV perims ──►│            priority, shard assignment by Geofabrik region → plan.json + matrix              │
                        │ build job ×N shards: routing-bundles --shard k                                              │
 Geofabrik state PBF ──►│   per region: 1 pyosmium pass for all its fires → per fire:                                 │
 LANDFIRE exportImage ─►│     trails extract (ogr2ogr -spat /vsicurl/trails.fgb → PMTiles z8–14)                     │
 USGS 3DEP exportImage ►│     grid  (LF EVT/EVC/FBFM40/SlpD → UTM; 3DEP DEM; NHD HU8 → GET v2 cost + veg + DEM)     │
 NHD HU8 GPKG (S3) ────►│     graph (OSM walkable ways split at shared nodes + agency trails conflated → graph.bin.gz)│
                        │     upload routing/{fk}/{g|n|t}{hash}/… + done.json → catalogs/routing/{fk}.json            │
                        │   upload-artifact routing-shard-k.json                                                     │
                        │ publish job: routing-publish → catalogs/routing.json (LAST), state/routing.json, health    │
                        └───────────────┬────────────────────────────────────────────────────────────────────────────┘
                                        ▼  Backblaze B2 (public; native f005 URLs; S3 endpoint for cached ranges)
   ┌──────────────────────────────────────────── Browser (GitHub Pages SPA) ──────────────────────────────────────────┐
   │ main thread                                                                                                     │
   │  trailsLayer ── pmtiles Protocol ── FetchSource(national, Range → wrapper passes through) | OpfsSource(pack)      │
   │  SearchDirectionsControl ─ fetchRoute('hike', walkCtx) ─┬─ inside grid ─► offroadClient ─► [Web Worker]          │
   │                                                          └─ else ORS/Valhalla + withEndGaps() (+offroad gap)      │
   │  offroadClient: fetch(cost_veg.tif, dem.tif, graph.bin.gz) via wrapped window.fetch → transfer → worker          │
   │  vegetationLayer ◄── worker 'veg' raster (downsampled class bytes) → LUT → canvas source                         │
   │  routeLayer ◄── RouteResult.legs (solid road/trail, dashed xc coloured by veg, dotted gap)                        │
   │ [offroad.worker.ts]  gunzip graph · decode GeoTIFFs · CSR + densify · perimeter raster · hybrid A* · smooth · legs│
   │ offline: packModel adds routing.json + descriptor + 4 immutable files; packs.ts serves them; opfs File → pmtiles │
   └─────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. B2 key layout, caching, versioning, pointers, retention

### 2.1 Keys

`{fk}` = fire key = `cornea_id.strip("{}").lower()`, for example `091081ed-bd23-4610-ae4a-270f95d1711e`. Every `{…hash…}` is `sha256(canonical_json(inputs)).hexdigest()[:16]`, where canonical JSON is `sort_keys=True, separators=(",",":")`.

| Key | Written by | Mutability | Cache-Control | Content-Type |
|---|---|---|---|---|
| `trails/b{YYYYMMDD}-{hash6}/parts/{usfs,blm,nps}.fgb` | sync-trails | immutable | `public, max-age=31536000, immutable` | `application/octet-stream` |
| `trails/b…/trails.fgb` (national normalized, spatial index) | sync-trails | immutable | same | `application/octet-stream` |
| `trails/b…/trails.pmtiles` (z8–13) | sync-trails | immutable | same | `application/vnd.pmtiles` |
| `trails/b…/manifest.json` | sync-trails | immutable | same | `application/json` |
| `catalogs/trails.json` | sync-trails, **last** | mutable | `public, max-age=60, must-revalidate` (existing `catalogs/` rule) | json |
| `routing/{fk}/g{hash16}/cost_veg.tif`, `dem.tif`, `done.json` | routing-bundles | immutable | `public, max-age=31536000, immutable` | `image/tiff` |
| `routing/{fk}/n{hash16}/graph.bin.gz`, `done.json` | routing-bundles | immutable | same | `application/gzip` (no Content-Encoding) |
| `routing/{fk}/t{hash16}/trails.pmtiles`, `done.json` | routing-bundles | immutable | same | `application/vnd.pmtiles` |
| `catalogs/routing/{fk}.json` (per-fire descriptor) | routing-bundles, after its parts | mutable | existing `catalogs/` rule | json |
| `catalogs/routing.json` (national index) | routing-publish, **last** | mutable | existing `catalogs/` rule | json |
| `state/trails.json`, `state/routing.json` | sync-trails / routing-publish only | mutable | existing `state/` rule (`private, no-store`; the bucket is public, so store no secrets here) | json |

`config.py` changes. The immutable prefixes do not overlap `catalogs/`, so they can go anywhere before the default:

```python
CACHE_CONTROL_RULES += [
    ("trails/",  "public, max-age=31536000, immutable"),
    ("routing/", "public, max-age=31536000, immutable"),
]   # insert before ("catalogs/versions/", …) to keep grouping; no overlap either way
CONTENT_TYPES |= {".pmtiles": "application/vnd.pmtiles", ".fgb": "application/octet-stream",
                  ".tif": "image/tiff", ".gz": "application/gzip", ".bin": "application/octet-stream"}
```

**Never set ContentEncoding.** PMTiles gzips each tile internally, and range reads on an encoded object would break. `graph.bin.gz` is gunzipped by the client. The TIFFs use internal DEFLATE.

### 2.2 Versioning and atomicity

- Upload order is the atomicity mechanism. Each part's files are uploaded first, then that part's `done.json`, then the per-fire descriptor, and finally `catalogs/routing.json` in the publish job. For trails: parts, then the FGB, then the PMTiles, then `manifest.json`, then `catalogs/trails.json`.
- **Immutable keys are never rewritten.** Before uploading, `storage.exists(f"{part_prefix}/done.json")` is checked, and an existing part is skipped. This avoids the hidden B2 versions that an overwrite would create.
- `aoi.id = sha256(f"{epsg}:{x0}:{y0}:{w}:{h}")[:12]`. Grid and graph both carry `aoi_id`. The graph's coordinates are relative to the grid origin, so the client refuses to route when `grid.aoi_id != graph.aoi_id`. That case only happens in a mid-rebuild failure, and section 3.10 prevents it.

### 2.3 Pointer JSON schemas (exact field names)

**`catalogs/trails.json`**
```json
{
  "schema_version": 1,
  "generated_at": "2026-09-27T09:41:12Z",
  "build_id": "b20260927-3f9a1c",
  "pmtiles": {
    "url": "/trails/b20260927-3f9a1c/trails.pmtiles",
    "url_s3": "https://s3.us-east-005.backblazeb2.com/responder-debrief-data/trails/b20260927-3f9a1c/trails.pmtiles",
    "bytes": 214318080, "minzoom": 8, "maxzoom": 13, "layer": "trails"
  },
  "fgb": { "url": "/trails/b20260927-3f9a1c/trails.fgb", "bytes": 162000000 },
  "counts": { "USFS": 74867, "BLM": 24570, "NPS": 31102 },
  "sources": {
    "USFS": { "as_of": "2026-09-23", "etag": "\"71d7c4e-65c26895234d1\"", "reused_from": null },
    "BLM":  { "as_of": "2026-09-21", "layers": ["Public_Managed_Trails/2", "Public_Not_Assessed_Trails/7"], "reused_from": null },
    "NPS":  { "as_of": "2026-09-22", "reused_from": "b20260920-a81e02" }
  },
  "recipe": 1,
  "attribution": "Trails: USFS, BLM, NPS"
}
```
The frontend prefers `pmtiles.url_s3`, because Chrome caches 206 responses from the S3 endpoint (it sends ETag/Last-Modified) but not from the native URL. If a request to it errors, the frontend falls back to `dataUrl(pmtiles.url)`.

**`catalogs/routing.json`** (index)
```json
{
  "schema_version": 1,
  "generated_at": "2026-09-27T12:03:00Z",
  "fires": {
    "{091081ED-BD23-4610-AE4A-270F95D1711E}": {
      "descriptor": "/catalogs/routing/091081ed-bd23-4610-ae4a-270f95d1711e.json",
      "bounds": [-121.52, 47.61, -120.18, 48.42],
      "grid": true, "graph": true, "trails": true,
      "updated_at": "2026-09-27T11:40:10Z"
    }
  }
}
```

**`catalogs/routing/{fk}.json`** (descriptor)
```json
{
  "schema_version": 1,
  "fire_key": "091081ed-bd23-4610-ae4a-270f95d1711e",
  "cornea_id": "{091081ED-BD23-4610-AE4A-270F95D1711E}",
  "name": "Little Giant", "fire_slug": "little-giant",
  "generated_at": "2026-09-27T11:40:10Z",
  "aoi": {
    "id": "5c0e9a1d77b2", "epsg": 32610, "cell_m": 30,
    "origin": [663000, 5367000], "width": 2600, "height": 2400,
    "bounds": [-121.52, 47.61, -120.18, 48.42],
    "basis": "perimeter", "perimeter_date": "2026-09-26T21:05:00Z", "clipped": false
  },
  "grid": {
    "id": "g8d1f0c2e9a7b3314", "aoi_id": "5c0e9a1d77b2", "recipe": 1,
    "cost_veg": { "url": "/routing/091081ed-…/g8d1f…/cost_veg.tif", "bytes": 1840221 },
    "dem":      { "url": "/routing/091081ed-…/g8d1f…/dem.tif", "bytes": 4120554, "base_m": 380.0, "scale_m": 0.1 },
    "cost_encoding": { "type": "log2", "steps_per_doubling": 24, "impassable": 0, "nodata": 255 },
    "sources": {
      "landfire": { "evt": "LF2025", "evc": "LF2025", "fbfm40": "LF2025", "slope": "LF2020_SlpD", "via": "exportImage" },
      "dem": { "source": "3DEP", "as_of": "2026-08-24" },
      "hydro": { "source": "NHD HU8 GPKG", "hu8": ["17020009", "17020010"], "vintage": "2024-01" }
    },
    "stats": { "impassable_pct": 3.1, "unknown_pct": 0.0, "class_pct": { "5": 61.2, "4": 12.0 } }
  },
  "graph": {
    "id": "n41aa9c07f2e1d0b3", "aoi_id": "5c0e9a1d77b2", "recipe": 1,
    "url": "/routing/091081ed-…/n41aa…/graph.bin.gz", "bytes": 880412,
    "nodes": 21877, "edges": 29305, "km": { "trail": 612.4, "road": 2210.9 },
    "sources": { "osm": { "regions": ["washington"], "pbf_date": "2026-09-26" }, "trails_build": "b20260927-3f9a1c" },
    "license": "ODbL-1.0 (derived from OpenStreetMap)"
  },
  "trails": {
    "id": "t9e3b…", "url": "/routing/091081ed-…/t9e3b…/trails.pmtiles", "bytes": 1302114,
    "minzoom": 8, "maxzoom": 14, "build": "b20260927-3f9a1c"
  },
  "status": { "grid": "ok", "graph": "ok", "trails": "ok", "errors": [] }
}
```
`grid`, `graph` and `trails` may each be `null`. For non-CONUS fires in v1, the status is `"skipped:outside_conus"`.

### 2.4 Retention and pruning

- The repository's policy is that nothing is auto-deleted. Superseded `routing/{fk}/{g|n|t}*` and `trails/b*` dirs stay. Storage cost is small: about 1.5 GB per full bundle generation plus about 330 MB/week of graphs and about 200 MB/week of national trails, at B2's $0.005/GB-month.
- New manual commands, each requiring `--confirm`, in the style of `prune`:
  - `prune-trails --keep 4 --confirm` deletes `trails/b*` except the 4 newest and whatever `catalogs/trails.json` references.
  - `prune-routing --keep 2 --inactive-days 30 --confirm` deletes per-fire part dirs not referenced by the current descriptor beyond the 2 newest per part, plus all bundles of fires inactive for more than 30 days.
- Owner action (bucket config, not code): add a B2 lifecycle rule with `daysFromHidingToDeleting: 1` for prefixes `catalogs/routing/` and `state/`, so hidden versions of mutable JSONs don't accumulate.

---

## 3. Worker

### 3.1 New modules

```
worker/responder_worker/
  gdaltools.py        # which()/driver checks, _run(cmd, timeout) → RuntimeError w/ last stderr line (hrrr._run style)
  utm.py              # pure-Python WGS84↔UTM (Snyder), zone_for_lon(), epsg_for(zone) — used for AOI math only
  trail_schema.py     # PURE: per-agency row → normalized dict; parsers (uses, grade, width, dates, restrictions)
  trails.py           # sync(): fetch, ogr2ogr, normalize/join, FGB + PMTiles build, verify, publish, state/health
  pmtiles_check.py    # PURE: parse/validate a PMTiles v3 header (127 bytes) — never GDAL-read PMTiles on 3.8.4
  routing/
    __init__.py
    aoi.py            # PURE: AOI policy (perimeter bbox → UTM rect), growth, snapping, id
    plan.py           # routing-plan: fires → work list, keys, priority, shards (writes plan.json)
    landfire.py       # exportImage/WCS fetch, LF2025→LF2024 per-pixel mosaic, warp to UTM
    dem.py            # 3DEP exportImage in UTM (fallback LF2020_Elev), fill, UInt16 dm encode
    hydro.py          # TNM Access HU8 discovery, cached download, extract, rasterize streams/water
    gridio.py         # GDAL-CLI ↔ numpy bridge (ENVI raw read; VRTRawRasterBand write → GTiff)
    grid.py           # PURE numpy: GET v2 recipe → cost byte + veg/flags; stats
    geofabrik.py      # index-v1.json, region selection (polygon∩rect), conditional PBF download, cache
    osm.py            # pyosmium single pass per region for many AOIs; walkable filter; split at shared nodes
    graph.py          # project (ogr2ogr), conflate agency↔OSM, snap, classify, encode graph.bin(.gz)
    costmodel.py      # PURE: Sullivan/GET speed functions (mirror of frontend costModel.ts); constants export
    validate.py       # reference hybrid A* (numpy + heapq) for parity + golden routes
    bundle.py         # per-fire build of parts + descriptor; carry-forward; markers
    publish.py        # routing-publish: merge shard results → index + state + health
    data/lf_evt_lifeform.csv  # VALUE,EVT_LF,EVT_PHYS for LF2024 + LF2025 (trimmed from landfire.gov CSVs)
```

### 3.2 CLI subcommands (added to `cli.py` build_parser; all use `common(sp)`)

| Command | Args (beyond `--dry-run/--out/--force`) | Notes |
|---|---|---|
| `sync-trails` | `--max-seconds` (env `TRAILS_MAX_SECONDS`, default 4800), `--agencies usfs,blm,nps`, `--min-age-days` (default 6) | No-op unless `--force`, or the last build is ≥ min-age and some source changed. |
| `routing-plan` | `--fires ID,…`, `--shards` (env `ROUTING_SHARDS`, default 4), `--plan-out plan.json`, `--adhoc NAME:W,S,E,N` (repeatable, dev only) | Writes plan.json and prints `SHARDS=[…]`. |
| `routing-bundles` | `--plan plan.json --shard K`, `--max-seconds` (env `ROUTING_MAX_SECONDS`, default 9000), `--result-out shard-K.json`, `--parts grid,graph,trails`, `--trails-fgb PATH_OR_URL` (local override) | Stateless, like tile-worker. Never writes the index or state. |
| `routing-publish` | `--results-dir DIR --plan plan.json` | The single writer of `catalogs/routing.json` and `state/routing.json`. |
| `routing-validate` | `--descriptor PATH_OR_URL --routes golden.json [--neighbors 16]` | Dev and CI-optional. Exit 1 on an expectation failure. |
| `prune-trails`, `prune-routing` | see 2.4 | Manual only; require `--confirm`. |

The stale `cli.py` module docstring list gets updated. Env knobs are wired explicitly as argparse defaults (the `TILE_BUDGET` lesson): `ROUTING_AOI_MIN_KM`=24, `ROUTING_AOI_MAX_KM`=100, `ROUTING_PRIORITY_FIRES`, `OSM_CACHE_DIR`=`~/.cache/rd-osm`, `NHD_CACHE_DIR`=`~/.cache/rd-nhd`.

### 3.3 Workflows

**`.github/workflows/trails.yml`** (name `Trails`)
```yaml
on:
  schedule: [{ cron: "23 9 * * *" }]        # daily; the job no-ops unless due (weekly cadence, catch-up-safe)
  workflow_dispatch: { inputs: { force: { type: boolean, default: false } } }
concurrency: { group: trails, cancel-in-progress: false }
jobs:
  build:
    runs-on: ubuntu-24.04                    # pinned: GDAL 3.8.4; ubuntu-26.04 would silently jump to 3.12
    timeout-minutes: 90
    defaults: { run: { working-directory: worker } }
    steps:
      - uses: actions/checkout@v4
      - run: df -h / "$RUNNER_TEMP"
      - name: Install GDAL CLI tools            # copy of tile.yml loop, packages: gdal-bin (only)
        continue-on-error: true
        timeout-minutes: 9
      - name: GDAL driver check
        run: gdalinfo --version && ogrinfo --formats | grep -Ei 'PMTiles|FlatGeobuf|OpenFileGDB|ESRIJSON|GPKG'
      - uses: astral-sh/setup-uv@v5  (python 3.12, cache on worker/uv.lock)
      - run: uv sync
      - env: { B2_*: …, TRAILS_MAX_SECONDS: "4800", GDAL_NUM_THREADS: "4", CPL_TMPDIR: "${{ runner.temp }}", INPUT_FORCE: "${{ inputs.force }}" }
        run: |
          FLAGS=(); [ "$INPUT_FORCE" = "true" ] && FLAGS+=(--force)
          uv run python -m responder_worker.cli sync-trails "${FLAGS[@]}"
```

**`.github/workflows/routing.yml`** (name `Routing bundles`)
```yaml
on:
  schedule: [{ cron: "37 10 * * *" }]
  workflow_run: { workflows: ["Trails"], types: [completed] }
  workflow_dispatch: { inputs: { fires: { type: string, default: "" }, force: { type: boolean, default: false } } }
concurrency: { group: routing-bundles, cancel-in-progress: false }   # own group — never worker-b2-writes
jobs:
  plan:            # ubuntu-24.04, timeout 20; no GDAL needed (pure-Python AOI math)
    outputs: { shards: "${{ steps.p.outputs.shards }}", has_work: "${{ steps.p.outputs.has_work }}", week: … }
    steps: checkout → setup-uv → uv sync → routing-plan --plan-out plan.json (FIRE_API_DEV for per-fire calls)
           → echo "shards=[0,1,2,3]" / "has_work=true" / "week=$(date -u +%G-W%V)" >> $GITHUB_OUTPUT
           → upload-artifact routing-plan (plan.json, retention 2 d)
  build:
    needs: plan
    if: needs.plan.outputs.has_work == 'true'
    runs-on: ubuntu-24.04
    timeout-minutes: 175
    strategy: { fail-fast: false, matrix: { shard: "${{ fromJSON(needs.plan.outputs.shards) }}" } }
    steps: checkout → df -h → GDAL apt (gdal-bin) → driver check (+ GTiff|ENVI|VRT) → setup-uv → uv sync
           → download-artifact routing-plan
           → actions/cache@v4 { path: ~/.cache/rd-osm, key: "osm-${{matrix.shard}}-${{needs.plan.outputs.week}}",
                                restore-keys: "osm-${{matrix.shard}}-" }
           → actions/cache@v4 { path: ~/.cache/rd-nhd, key: "nhd-v1-${{matrix.shard}}-${{github.run_id}}",
                                restore-keys: "nhd-v1-${{matrix.shard}}-" }      # grows; caches filtered HU8 extracts only
           → routing-bundles --plan plan.json --shard K --result-out shard-K.json   (ROUTING_MAX_SECONDS=9000)
           → if: always(): upload-artifact routing-shard-K (shard-K.json, retention 2 d)
  publish:
    needs: [plan, build]
    if: always() && needs.plan.outputs.has_work == 'true'
    timeout-minutes: 15
    steps: checkout → setup-uv → uv sync → download-artifact pattern routing-shard-* merge-multiple → routing-publish
```
`ROUTING_MAX_SECONDS=9000` (150 min) leaves 25 min of the 175-min job for the last fire and the uploads. The OSM cache is about 3.3 GB for western states, and the NHD extract cache is about 0.4 GB, which fits the 10 GB repo cache limit alongside the uv caches.

### 3.4 Trail source recipes (exact)

HTTP goes through `http.make_client`. A new `http.download(client, url, dest, *, etag=None, last_modified=None) -> (status, headers)` streams to disk with `client.stream`, handles 304, and retries with tenacity like `get()`.

**USFS (FGDB zip, weekly and atomic)**
1. Conditional GET `https://data.fs.usda.gov/geodata/edw/edw_resources/fc/Trans_Trail_NFS_Publish.gdb.zip` with `If-None-Match`/`If-Modified-Since` from `state/trails.json`. A 304 reuses the previous build's `parts/usfs.fgb`.
2. `ogr2ogr -f GPKG raw_usfs.gpkg /vsizip/{zip}/Trans_Trail_NFS_Publish.gdb Trans_Trail_NFS_Publish -where "TRAIL_TYPE='TERRA'" -select TRAIL_CN,TRAIL_NAME,TRAIL_NO,TRAIL_CLASS,ALLOWED_TERRA_USE,HIKER_PEDESTRIAN_MANAGED,HIKER_PEDESTRIAN_RESTRICTED,TYPICAL_TRAIL_GRADE,TYPICAL_TREAD_WIDTH,TRAIL_SURFACE,NATIONAL_TRAIL_DESIGNATION,SPECIAL_MGMT_AREA,ADMIN_ORG,ATTRIBUTESUBSET,TERRA_MOTORIZED,GIS_MILES -t_srs EPSG:4326 -nlt MULTILINESTRING -nln usfs`
3. `ogrinfo raw_usfs.gpkg -sql "DELETE FROM usfs WHERE geom IS NULL OR ST_IsEmpty(geom)"`. About 3,289 NULLs are expected. FlatGeobuf aborts on NULL geometry.
4. **Sanity check:** the count must be ≥ 0.8 × the previous count, otherwise reuse the previous part. This guards against a publish that caught the EDW reload in progress.

**BLM (hosted FeatureServer; GDAL pages automatically because the URL has no resultOffset)**
- `ogr2ogr -f GPKG raw_blm.gpkg "https://services1.arcgis.com/KbxwQRRfWyEYLgp4/arcgis/rest/services/BLM_Natl_GTLF_Public_Managed_Trails/FeatureServer/2/query?where=1%3D1&outFields=OBJECTID,FAMS_ID,ROUTE_PRMRY_NM,ADMIN_ST,PLAN_ASSET_CLASS,PLAN_MODE_TRNSPRT,PLAN_ALLOW_MODE_TRNSPRT,PLAN_OHV_ROUTE_DSGNTN,PLAN_ACCESS_RSTRCT,PLAN_SEASON_RSTRCT_CODE,OBSRVE_ROUTE_USE_CLASS,OBSRVE_SRFCE_TYPE,ROUTE_SPCL_DSGNTN_TYPE,GIS_MILES&outSR=4326&orderByFields=OBJECTID&f=json" -nlt PROMOTE_TO_MULTI -nln blm_managed`
- The same for `BLM_Natl_GTLF_Public_Not_Assessed_Trails/FeatureServer/7` with `-nln blm_na`. That layer is disjoint from layer 2. **Never** union MapServer layers 2–5; they are subsets of layer 7.
- Completeness check: `…/query?where=1%3D1&returnCountOnly=true&f=json` must equal the fetched count. `as_of` comes from the service JSON `editingInfo.dataLastEditDate`.

**NPS (MapServer)**
- `ogr2ogr -f GPKG raw_nps.gpkg "https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails/MapServer/0/query?where=PUBLICDISPLAY%3D'Public%20Map%20Display'%20AND%20DATAACCESS%3D'Unrestricted'&outFields=OBJECTID,FEATUREID,TRLNAME,TRLALTNAME,MAPLABEL,TRLSTATUS,TRLSURFACE,TRLTYPE,TRLCLASS,TRLUSE,TRLFEATTYPE,SEASONAL,SEASDESC,UNITCODE,UNITNAME,EDITDATE&outSR=4326&orderByFields=OBJECTID&f=json" -nlt PROMOTE_TO_MULTI -nln nps`
- The post-filter lives in `trail_schema.norm_nps`: drop `TRLSTATUS ∈ {Decommissioned, Abandoned, Proposed}` and `TRLTYPE ∈ {Water Trail, Snow Trail, Ferry Route}`.

**Normalize without routing geometry through Python** (memory: USFS alone has 18.8M vertices)
1. `ogr2ogr -f CSV attrs_{a}.csv raw_{a}.gpkg -sql "SELECT fid AS src_fid, * FROM {layer}"`. The CSV carries attributes only.
2. Python runs `trail_schema.norm_{agency}(row, as_of)` on each row and writes `norm_{a}.csv` with `src_fid` plus the normalized fields. A `None` result drops the row.
3. `ogr2ogr -update -f GPKG raw_{a}.gpkg norm_{a}.csv -nln norm` imports the CSV as a table. `-oo AUTODETECT_TYPE=YES` fixes `cls` to an integer and `miles` to a real.
4. `ogr2ogr -f FlatGeobuf parts/{a}.fgb raw_{a}.gpkg -dialect SQLite -sql "SELECT u.geom, n.* FROM {layer} u JOIN norm n ON u.fid = n.src_fid" -nln trails -lco SPATIAL_INDEX=YES`
5. Build the national file: `ogr2ogr -f GPKG trails_norm.gpkg parts/usfs.fgb -nln trails`, then `-append` the BLM and NPS parts, then `ogr2ogr -f FlatGeobuf trails.fgb trails_norm.gpkg trails -lco SPATIAL_INDEX=YES`.

### 3.5 Normalized trail schema (`trail_schema.py`; the FGB and PMTiles attribute set)

| Field | Type | USFS | BLM | NPS |
|---|---|---|---|---|
| `tid` | str | `USFS:{TRAIL_CN}` | `BLM:{FAMS_ID or OBJECTID}` | `NPS:{FEATUREID or OBJECTID}` |
| `agency` | enum `USFS\|BLM\|NPS` | | | |
| `name` | str? | TRAIL_NAME (title-cased if ALL CAPS) | ROUTE_PRMRY_NM (24% empty) | TRLNAME or MAPLABEL |
| `num` | str? | TRAIL_NO | — | — |
| `cls` | int 0–5 | TRAIL_CLASS 1–5, `N`/blank → 0 | 0 | digit parsed from TRLCLASS ("Class 3"/"3"), Unknown → 0 |
| `uses` | str, comma list ⊂ `hike,pack,bike,moto,atv,4wd,snow`; `""` = unknown | ALLOWED_TERRA_USE digits 1→hike, 2→pack, 3→bike, 4→moto, 5→atv, 6→4wd; `N/A`/null → `""` | PLAN_ALLOW_MODE_TRNSPRT: HIK_ONLY→hike; EQU_HIK_ONLY→hike,pack; BIKE_HIK_ONLY→hike,bike; NON_MOTO_SHARED→hike,pack,bike; MTC_ATV_SHARED→moto,atv; TECH_VEH_SHARED→4wd,atv,moto; SNOW_*→snow; UNK→`""` | TRLUSE split on `\|,/;` with keyword match: hik\|pedestrian\|walk→hike; horse\|stock\|equestrian\|pack→pack; bike\|bicycle→bike; motorcycle→moto; atv\|ohv→atv; 4wd\|vehicle→4wd |
| `uses_raw` | str? | raw code | raw code (upper-cased, whitespace-collapsed) | raw text (≤60 chars) |
| `motor` | enum `Y\|N\|U` | TERRA_MOTORIZED (X→U) | PLAN_MODE_TRNSPRT Motorized→Y, Non-*→N | U |
| `restrict` | str? ≤120 chars | `"Hiking restricted {MM/DD–MM/DD}"` when HIKER_PEDESTRIAN_RESTRICTED is set (trimmed); `"Hiking not a listed use"` when uses is known and lacks hike | `ADMIN ONLY`→"Administrative use only (BLM, fire, etc.)"; `AUTHORIZED/PERMITTED USER ONLY`→"Authorized/permitted users only"; `LIMITED BY VEHICLE TYPE`→"Limited by vehicle type"; season code appended | `TRLSTATUS='Temporarily Closed'`→"Temporarily closed" |
| `season` | str? | HIKER_PEDESTRIAN_MANAGED range | — | SEASDESC if SEASONAL=Yes |
| `surface` | str? | TRAIL_SURFACE | OBSRVE_SRFCE_TYPE (title-cased) | TRLSURFACE (Unknown→null) |
| `grade` | str? | TYPICAL_TRAIL_GRADE normalized to a bin: `"TG05 - +12-20%"`→`"12-20%"`, the literal `"TRAIL_GRADE"`/`N/A` → null | — | — |
| `width` | str? | TYPICAL_TREAD_WIDTH `"TW03 - 18-24 INCHES"`→`"18–24 in"` | — | — |
| `desig` | str? | NATIONAL_TRAIL_DESIGNATION 3→"National Scenic/Historic Trail" | ROUTE_SPCL_DSGNTN_TYPE | — |
| `unit` | str? | ADMIN_ORG | "BLM {ADMIN_ST}" | UNITNAME |
| `status` | enum `open\|closed\|not_assessed\|unknown` | open | layer 7 → not_assessed; else open | Temporarily Closed → closed; Existing → open; else unknown |
| `as_of` | `YYYY-MM-DD` | FGDB Last-Modified date | service dataLastEditDate | EDITDATE (feature) or the service max |
| `miles` | real | GIS_MILES | GIS_MILES (null in OR → length computed later) | computed |

Case and whitespace are normalized everywhere, for example BLM's `'4WD HIGH CLEARANCE / SPECIALIZED'` and `'…/SPECIALIZED'`, and USFS dates with trailing spaces.

### 3.6 PMTiles builds

**National (z8–13)**
```bash
ogr2ogr -f GPKG tiles_in.gpkg trails_norm.gpkg -nln trails_lo -simplify 0.00015 \
  -sql "SELECT geom, agency, name, num, cls, status FROM trails"
ogr2ogr -update -f GPKG tiles_in.gpkg trails_norm.gpkg -nln trails_hi \
  -sql "SELECT geom, tid, agency, name, num, cls, uses, uses_raw, motor, restrict, season, surface, grade, width, desig, unit, status, as_of FROM trails"
cat > conf.json <<'J'
{"trails_lo":{"target_name":"trails","minzoom":8,"maxzoom":10},
 "trails_hi":{"target_name":"trails","minzoom":11,"maxzoom":13}}
J
CPL_DEBUG=MVT ogr2ogr -f PMTiles trails.pmtiles tiles_in.gpkg \
  -dsco MINZOOM=8 -dsco MAXZOOM=13 -dsco CONF=conf.json \
  -dsco NAME=rd-trails -dsco DESCRIPTION="USFS/BLM/NPS trails (normalized)" \
  -dsco SIMPLIFICATION=1 -dsco SIMPLIFICATION_MAX_ZOOM=0.5 -dsco MAX_SIZE=800000 2> pmtiles_debug.log
```
- **MAX_SIZE handling on 3.8.4:** GDAL silently halves EXTENT and then drops the smallest features, logging only under CPL_DEBUG. The job greps `pmtiles_debug.log` for the reduction messages, counts them and reports the count in `health.trails.note`. If more than 50 tiles are reduced, the build is still published but health is marked `warn`. The ~0.00015° (≈15 m) pre-simplification of the lo layer keeps z8–10 tiles far below 800 kB. The measured largest simplified z7 tile was 93 kB.
- `GDAL_NUM_THREADS=4`. `CPL_TMPDIR=$RUNNER_TEMP` holds the hidden `.tmp.mbtiles.temp.db`, which peaks at 1–3 GB.
- **Verify** with `pmtiles_check.parse_header(path)`: magic `PMTiles`, version 3, `tile_type==1` (MVT), `tile_compression==2` (gzip), `min_zoom==8`, `max_zoom==13`, `addressed_tiles > 60_000`, and file size ≥ `tile_data_offset + tile_data_length`. A failure means the new pointer is not published.
- Expected output: about 150–250 MB, about 85k tiles, a build of several to about 20 min on 4 vCPU.

**Per-fire extract (routing job, z8–14)**
```bash
ogr2ogr -f GPKG fire_trails.gpkg /vsicurl/{DATA_BASE}/trails/b…/trails.fgb trails -spat W S E N -spat_srs EPSG:4326
# then the same two-layer split + conf (lo z8–10, hi z11–14) → -dsco MAXZOOM=14 → t…/trails.pmtiles
```

### 3.7 Per-fire AOI policy (`routing/aoi.py`, pure)

- **Input:** the newest perimeter by `date` from `FIRE_API_DEV/fires/{cornea_id}/perimeters`, fetched by its verbatim `path` on DEV. If there is none, use the fire point.
- **Zone:** the UTM zone of the perimeter bbox centre longitude, giving `epsg = 32600 + zone`. Scale error is ≤0.1% within ±3°, and even an AOI straddling a zone boundary stays below 0.07%.
- **Rectangle in UTM metres:**
  1. Project the perimeter bbox corners and edge midpoints (4 × 8 points).
  2. Take the extent `[xmin, ymin, xmax, ymax]`, with `w = xmax − xmin` and `h = ymax − ymin`.
  3. Set the buffer `B = clamp(0.25·max(w,h), 8 km, 15 km)`. With no perimeter, use a point box with `B = 12 km`.
  4. Expand by B, then enforce min side `ROUTING_AOI_MIN_KM` = 24 km (symmetric grow) and max side `ROUTING_AOI_MAX_KM` = 100 km. If it exceeds the max, centre a 100 km square on the perimeter bbox centre and set `clipped=true`.
  5. **Snap outward to a 3 km lattice.** The origin is `x0 = floor(xmin/3000)·3000` and `y0 = ceil(ymax/3000)·3000` (top-left), and `width`/`height` in cells are multiples of 100. This keeps AOIs stable under small perimeter changes and aligns the grid to 30 m.
- **Growth only:** if the previous AOI contains `perimeter_bbox ⊕ 3 km`, keep it. Otherwise the new AOI is `snap(union(prev, required))`, or `required` alone if the union exceeds the max side. The AOI never shrinks while the fire is active.
- **Scope:** CONUS fires get grid, graph and trails. Non-CONUS fires get trails only in v1 (PR 31, AK 6, HI).
- **Sizes:** a typical 10k-acre fire gives 24 km (800² = 0.64M cells). A 100k-acre fire gives about 48–54 km (1,800² ≈ 3.2M cells). Crosswhite (343k ac) hits the 100 km cap (3,334² ≈ 11M cells).

### 3.8 Plan: priority order, rebuild triggers, skip-if-unchanged keys (`routing/plan.py`)

Input keys (canonical JSON hashed to 16 hex):
```
aoi_id     = sha256("{epsg}:{x0}:{y0}:{w}:{h}")[:12]
grid_key   = H({recipe_grid, aoi_id, lf_epoch, dem:"3DEP", hydro:"NHD-HU8-2024"})
graph_key  = H({recipe_graph, aoi_id, trails_build, osm_epoch})
trails_key = H({recipe_trails, aoi_id, trails_build})
lf_epoch   = H(editingInfo.lastEditDate + extent of LF2025_EVT/EVC/FBFM40 ImageServer ?f=json)  # auto-rebuild when LF2025 expands (Nov 2026)
osm_epoch  = floor((days_since_2000 + stagger) / 7),  stagger = int(fk[:8],16) % 7   # weekly, staggered across days
```

A part is scheduled when its key differs from `state/routing.json`'s, or the previous attempt failed and `next_retry_at ≤ now`. Backoff after consecutive failures is 1, 1, 3 and then 7 days. `--force` rebuilds everything selected.

Priority tiers are processed in order, within a tier by acres descending:
0. `ROUTING_PRIORITY_FIRES` / `--fires`.
1. Fires with no usable bundle (no grid or no graph).
2. AOI changed (grid, graph and trails all needed).
3. Graph or trails refresh only.

**Shards:** `shards = min(ROUTING_SHARDS, max(1, ceil(work_fires/40)))` and `shard = crc32(primary_region) % shards`. The primary Geofabrik region is the one with the largest AOI overlap, so all fires of a region share one PBF download and one pyosmium pass. Plan output:
```json
{ "generated_at": "…", "week": "2026-W39", "trails_build": "b…", "lf_epoch": "…", "shards": [0,1,2,3],
  "fires": [ { "cornea_id": "{…}", "fire_key": "…", "name": "…", "fire_slug": "…", "state": "WA", "acres": 172879,
               "aoi": { "id":"…","epsg":32610,"origin":[…],"width":2600,"height":2400,"bounds":[…],"basis":"perimeter",
                        "perimeter_date":"…","clipped":false },
               "regions": ["washington"], "needs": { "grid": true, "graph": true, "trails": true },
               "keys": { "grid":"…","graph":"…","trails":"…" }, "tier": 1, "shard": 2 } ] }
```
The perimeter geometry is fetched only when the fire's `poly_last_updated` from the light prod index is newer than `state.fires[fk].poly_seen`. That keeps DEV traffic proportional to change.

### 3.9 Grid build (`landfire.py`, `dem.py`, `hydro.py`, `gridio.py`, `grid.py`)

**Common target grid:** `EPSG:326zz`, origin `(x0, y0)` top-left, 30 m, `W × H`. Everything is warped to exactly this grid.

**LANDFIRE (exportImage, anonymous; the LFPS job API is never used because it requires an email)**
1. Project the AOI rectangle to EPSG:5070 by densifying each edge with 16 points through `utm.py` → WGS84 → a `gdaltransform -s_srs EPSG:4326 -t_srs EPSG:5070` batch. Add a 60 m margin and snap outward to the native grid: `xmin = -2362425 + 30·floor((x+2362425)/30)`, `ymax = 3267405 − 30·floor((3267405−y)/30)` (and likewise for xmax/ymin). Then `W5 = (xmax−xmin)/30`.
2. For each product `P ∈ {EVT, EVC, FBFM40}` and version `V ∈ ["LF2025", "LF2024"]`:
   `GET https://lfps.usgs.gov/arcgis/rest/services/Landfire_{V}/{V}_{P}_CONUS/ImageServer/exportImage?bbox={xmin},{ymin},{xmax},{ymax}&bboxSR=5070&imageSR=5070&size={W5},{H5}&format=tiff&pixelType=S16&noData=-9999&interpolation=RSP_NearestNeighbor&compression=LZ77&f=image`
   The same call is made for `Landfire_Topo/LF2020_SlpD_CONUS`.
   Verify with `gdalinfo -json`: EPSG 5070, origin `(xmin, ymax)`, pixel 30, size as requested.
3. **Fallback:** WCS `https://edcintl.cr.usgs.gov/geoserver/landfire_wcs/conus_2024/wcs?service=WCS&version=2.0.1&request=GetCoverage&coverageId=landfire_wcs__LF2024_{P}_CONUS&subset=X({xmin},{xmax})&subset=Y({ymin},{ymax})&format=image/geotiff`. Topo uses `conus_topo/wcs` with `landfire_wcs__LF2020_SlpD_CONUS`, and LF2025 uses `conus_2025/wcs`. NoData there is **32767**, so treat both −9999 and 32767 as nodata.
4. **Version mosaic, consistent per pixel across all three products:** `use25 = valid(EVT25) & valid(EVC25) & valid(FBFM25)`, then `X = where(use25, X25, X24)`. Record `"LF2025"`, `"LF2024"` or `"LF2025+LF2024"` per product.
5. Warp: `gdalwarp -q -overwrite -s_srs EPSG:5070 -t_srs EPSG:326zz -te {x0} {y0−H·30} {x0+W·30} {y0} -tr 30 30 -r near -ot Int16 -srcnodata -9999 -dstnodata -9999 in.tif out.tif`. Classes use `near`, and so does SlpD.

**DEM (3DEP, fresher and float; the LANDFIRE Elev grid is the fallback)**
- Request directly in UTM: `GET https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?bbox={x0},{y0−H·30},{x0+W·30},{y0}&bboxSR=326zz&imageSR=326zz&size={W},{H}&format=tiff&pixelType=F32&interpolation=RSP_BilinearInterpolation&compression=LZ77&renderingRule={"rasterFunction":"None"}&f=image`. W and H are ≤ 3,400, under the 8,000 cap.
- Verify the geotransform. If it doesn't match, `gdalwarp -r bilinear` onto the target grid.
- Fallback: `Landfire_Topo/LF2020_Elev_CONUS` exportImage in 5070, then `gdalwarp -r bilinear`.
- Fill holes with numpy (3 passes of 3×3 mean over valid neighbours). Encode: `base_m = 10·floor(min(z)/10) − 10` and `dem_u16 = clip(round((z − base_m)·10), 1, 65535)`, with 0 as nodata. This gives 0.1 m resolution and a 6,553 m span, enough for any single AOI; Telescope Peak to Death Valley is 3.45 km.

**Hydro (NHD HU8 GeoPackages; the REST services are too slow)**
- Discover: `GET https://tnmaccess.nationalmap.gov/api/v1/products?datasets=National%20Hydrography%20Dataset%20(NHD)%20Best%20Resolution&bbox={W},{S},{E},{N}&prodFormats=GeoPackage&max=50`. Keep items whose title contains `Hydrologic Unit (HU) 8` / `HU8`, and use each item's `downloadURL`, for example `…/NHD_H_17060201_HU8_GPKG.zip`.
- Cache: `~/.cache/rd-nhd/{HU8}.gpkg` holds a **filtered** extract (4326) made once per HU8:
  - `NHDFlowline WHERE fcode IN (46006, 55800)` (perennial; artificial paths)
  - `NHDWaterbody WHERE ftype IN (390, 436) AND areasqkm >= 0.005`
  - `NHDArea WHERE ftype = 460` (StreamRiver polygons)
  - with `-dim XY -nlt PROMOTE_TO_MULTI`. The zip is deleted after extraction.
- Per fire: `ogr2ogr -spat … -t_srs EPSG:326zz` into `hydro.gpkg`, then:
  - `gdal_rasterize -burn 1 -at -init 0 -ot Byte -te … -tr 30 30 hydro.gpkg -l flowline streams.tif`. `-at` (ALL_TOUCHED) makes a 4-connected supercover, so diagonal moves can't slip through.
  - `gdal_rasterize -burn 1 -init 0 … -l waterbody -l area water.tif` (centre-in).

**Cost and class recipe (`grid.py`, numpy, GET v2 with explicit deviations)**

Lifeform comes from **EVC** as the primary source. EVC encodes both lifeform and cover %, and the continuous shrub term needs EVC. EVT is a cross-check for water/snow and the fallback when EVC is nodata, via `data/lf_evt_lifeform.csv` EVT_LF.

| Condition (evaluated in order) | veg class id | Base multiplier M |
|---|---|---|
| EVC nodata and EVT nodata (e.g. Canada) | 0 unknown | **255 (nodata → impassable)** |
| EVC==11 or EVT==7292 or FBFM40==98 or NHD water polygon | 10 water | **0 impassable** |
| EVC==12 or EVT==7735 | 11 snow/ice | 2.5 *(not GET; Soule & Goldman soft snow 2.5)* |
| EVC 13–25 | 9 developed | 1 |
| EVC 61–82 | 8 agriculture | 1 |
| EVC 31, 32 | 1 barren/rock | 1 |
| EVC 100 or 310–399 | 2 grass/herb | 1 |
| EVC 210–299 (cover c = EVC−200) | 3 if c<35 else 4 | 1 + 3·c/100 |
| EVC 110–199 | 5 timber | 4 |
| EVC other or nodata with EVT known | from EVT_LF: Tree→5 (M 4), Shrub→3/4 (c=50 → M 2.5), Herb→2, Sparse/Barren→1, Agriculture→8, Developed→9 | as row |

Modifiers multiply:
- FBFM40 ∈ {184 TL4, 185 TL5, 187 TL7} → ×2. If the class is 5, it becomes class 6, "timber, heavy litter/down wood".
- FBFM40 ∈ {201–204 SB1–4} → ×5, class 7 "slash/blowdown". I chose GET's table value of 5, not the 4 in one methods sentence.
- Stream cell (streams.tif==1 and not water) → ×5 and flag `0x10`.
- SlpD > 45 → **impassable** and flag `0x20`. This is GET's calibrated rule on LANDFIRE slope, not a 3DEP-derived slope.

**Band encoding:**
- `cost` (u8): 0 = impassable, 255 = nodata or outside AOI, otherwise `clip(round(1 + 24·log2(M)), 1, 254)`, decoded as `M = 2^((v−1)/24)`. Steps are 2.9%. Examples: 1→1, 2.5→33, 4→49, 8→73, 20→105, 40→129, 100→160.
- `veg` (u8): bits 0–3 hold the class id (0–11), bit 4 the perennial stream flag and bit 5 the too-steep flag. Bits 6–7 are reserved (0).

**Write** through `gridio.write_geotiff`, which writes raw `.bin` bands plus a VRT built from `VRTRawRasterBand` entries (GeoTransform, `EPSG:326zz`) and then runs `gdal_translate`:
- `cost_veg.tif`: `-co COMPRESS=DEFLATE -co ZLEVEL=9 -co PREDICTOR=1 -co INTERLEAVE=BAND -co BLOCKYSIZE=64`, nodata 255 on band 1.
- `dem.tif`: `-co PREDICTOR=2`, nodata 0.

Expected sizes at 1,667² (50 km): cost_veg about 1.0–1.8 MB and dem about 2–3 MB.

`gridio.read_band(path, band)` is `gdal_translate -of ENVI -b N` followed by `np.fromfile(...).reshape(H, W)`. No Python GDAL bindings are needed.

**Stats** go into the descriptor: `impassable_pct`, `unknown_pct`, and `class_pct` (non-zero classes, one decimal). If `unknown_pct > 20`, `status.grid="degraded"`.

### 3.10 Graph build (`geofabrik.py`, `osm.py`, `graph.py`)

**OSM ingest (no Overpass).**
- Region selection uses `https://download.geofabrik.de/index-v1.json` (with geometry, cached per run). It picks all *leaf* US regions (states, plus `california/norcal` and `california/socal`) whose polygon intersects the AOI rectangle. A pure-Python polygon∩rect test checks vertex-in-rect, corner-in-polygon and edge crossings.
- The PBF (`properties.urls.pbf`) is fetched by conditional GET into `~/.cache/rd-osm/{region}.osm.pbf`. The dated redirect filename (`{region}-YYMMDD.osm.pbf`) gives `pbf_date`.
- **One pyosmium pass per region** for all of that shard's fires in the region: `osmium.FileProcessor(pbf).with_locations().with_filter(osmium.filter.KeyFilter('highway'))`, restricted to ways. `scratchpad/dataapi/pyosm_extract.py` is the template.
- A way is kept when:
  - `highway ∈ {path, footway, bridleway, steps, cycleway, pedestrian, track, service, unclassified, residential, living_street, road, tertiary, tertiary_link, secondary, secondary_link, primary, primary_link, trunk, trunk_link}`;
  - it is not `area=yes`, not `highway=via_ferrata`, not `sac_scale ∈ {demanding_alpine_hiking, difficult_alpine_hiking}` (T5/T6 = climbing), and not `access=no` together with `highway ∈ {construction, proposed}`;
  - and any node is inside the AOI's 4326 bbox plus 500 m.
- **Legal access tags do not exclude a way,** because crews are administrative users. They only set flags.
- Stored tags: `highway, name, ref, tracktype, surface, sac_scale, trail_visibility, access, foot, bridge, tunnel, ford`.
- **Split at shared nodes:** a node is a junction if it is referenced by ≥2 kept ways or is a way endpoint. Each way splits into edges between junctions. This is exact topology, so bridges and tunnels don't create false crossings.

**Project and clip.** Write edges as GeoJSONSeq in 4326 with `{u, v, …tags}`, then `ogr2ogr -t_srs EPSG:326zz`, and read back. Vertices outside the AOI rectangle are dropped, which splits the edge. Pieces under 10 m are discarded.

**Agency trails.** `ogr2ogr -f GeoJSONSeq /vsistdout/ /vsicurl/{trails.fgb} trails -spat W S E N -spat_srs EPSG:4326 -t_srs EPSG:326zz -select tid,agency,name,num,cls,status`.

**Conflation (numpy + spatial hash with 25 m cells):**
1. Densify OSM walkable edges at 5 m and agency trails at 10 m.
2. An agency point is **covered** if an OSM segment is within **20 m** and the bearing difference is **< 35°**. The bearing test stops a perpendicular crossing from counting as coverage.
3. If an agency feature is ≥80% covered, drop its geometry. Its `name/num/agency` go to the covering OSM edges when those lack a `name` (majority vote per OSM edge, requiring ≥60% of that OSM edge's points to be covered by the feature), and those edges get the flag `AGENCY_NAMED`.
4. Otherwise keep the uncovered runs ≥60 m as new edges (class `trail`, `agency` set).
5. Snap each kept run's endpoints: to an OSM vertex within 10 m; else to the nearest point on an OSM edge within 25 m, splitting that edge and inserting a junction; else to another agency endpoint within 10 m (merging clusters); else leave it dangling. The grid portals connect dangling ends anyway.

**Edge attributes:**

| Field | Values |
|---|---|
| `class` u8 | 0 = trail (path, footway, bridleway, steps, cycleway, pedestrian, agency); 1 = track; 2 = minor road (service, unclassified, residential, living_street, road); 3 = major road (tertiary..trunk + links) |
| `flags` u8 | bit0 bridge, bit1 tunnel, bit2 access-restricted (access∈{private,no} or foot=no), bit3 no-portal (bridge\|tunnel), bit4 agency-named, bit5 ford |
| `agency` u8 | 0 OSM, 1 USFS, 2 BLM, 3 NPS |
| `mult` u8 (×0.1; 10 = 1.0) | 10 by default. Heuristic, clearly not GET: `sac_scale=alpine_hiking` (T4) → 15; `trail_visibility=bad` → 13; `horrible`/`no` → 16. Never below 10, which keeps the A* heuristic admissible. |
| `name_idx`, `ref_idx` u16 | into the string table; 0xFFFF = none. An agency `num` goes to `ref`. |

**`graph.bin` byte layout** (little-endian; gzip-compressed as `graph.bin.gz`; every section starts on a 4-byte boundary)
```
Header (64 B)
  0  char[4] magic "RDG1"
  4  u16 format_version = 1
  6  u16 header_bytes = 64
  8  u32 node_count           (Nn)
 12  u32 edge_count           (Ne)
 16  u32 vertex_count         (Nv, interior vertices total)
 20  u32 string_count         (Ns)
 24  u32 string_bytes         (Sb)
 28  i32 epsg                 (e.g. 32610)
 32  f64 origin_x             (UTM m, grid top-left x0)
 40  f64 origin_y             (UTM m, grid top-left y0)
 48  u32 grid_width           (cells)
 52  u32 grid_height          (cells)
 56  f32 cell_m               (30)
 60  u32 crc32                (of all bytes after the header)
Section A  nodes      i32[2·Nn]   (X_dm, Y_dm) with X_dm = round((x − x0)·10), Y_dm = round((y0 − y)·10)  (row-down)
Section B  edges (SoA)
           u32[Ne] from, u32[Ne] to
           u32[Ne+1] geom_start      (prefix offsets into section C, in vertices)
           u32[Ne] length_dm         (planar length)
           u8[Ne] class, u8[Ne] flags, u8[Ne] agency, u8[Ne] mult    (+ pad to 4)
           u16[Ne] name_idx, u16[Ne] ref_idx                          (+ pad to 4)
Section C  vertices   i16[2·Nv]   (dX_dm, dY_dm) deltas; the first is relative to the `from` node; the `to` node is implicit at the end
           the worker inserts vertices so |delta| ≤ 32767 dm (3.28 km)
Section D  strings    u32[Ns+1] offsets, then u8[Sb] UTF-8
```
For the Park Fire 50 km box (27k nodes, 36k edges, 223k vertices) this is about 2.1 MB raw and about 0.8–1.0 MB gzip. The client parses it into typed-array views with no copying.

### 3.11 Per-fire bundle orchestration, idempotence and failure handling (`bundle.py`)

For each fire in the shard's slice, in plan order, while `not deadline_passed()`:
1. `prev = storage.get_json(f"catalogs/routing/{fk}.json")`.
2. **trails part** (if needed): build the extract, then upload `t{key}/trails.pmtiles` and then `t{key}/done.json` `{built_at, bytes, build}`.
3. **grid + graph as an AOI-consistent pair:** if the AOI changed, both must succeed or the previous pair is kept. If only one is needed (same AOI), it is built independently.
4. Write the descriptor with carry-forward. Parts that were not rebuilt or that failed keep `prev`'s entry when `aoi_id` matches, and are otherwise `null`. `status.errors[]` gets `{part, error (last stderr line, ≤300 chars), at}`.
5. Append the per-fire result to `shard-K.json`: `{fk: {cornea_id, aoi, keys, parts: {grid: key|null, …}, status, errors, built_at}}`.

- Each part runs under try/except; failures are logged as `[routing] {name} grid FAILED: …` and the loop continues.
- **Missing GDAL tools or drivers** (`gdaltools.require(["ogr2ogr","gdalwarp","gdal_translate","gdal_rasterize","gdalinfo","gdaltransform"], drivers=["GTiff","ENVI","VRT","GPKG","FlatGeobuf","PMTiles"])`): the job logs, sets `health.routing.note="GDAL unavailable"` and exits 0, like `cmd_tile_worker`.
- **Temp disk:** each fire runs in a `TemporaryDirectory(dir=$RUNNER_TEMP)`. PBFs are kept in the cache dir, and `df` is logged per region.

**Publish (`publish.py`):**
1. Load `catalogs/routing.json` and `state/routing.json`.
2. Merge the shard results.
3. Drop index entries for fires no longer active. State entries are kept for 30 days in case a fire reactivates.
4. Write `state/routing.json`, then `catalogs/routing.json` **last**.
5. `health.publish(storage, "routing", {started_at, finished_at, ok, note, fires_total, with_grid, with_graph, with_trails, built: {grid, graph, trails}, failed, deferred})`.

Shards that failed to upload an artifact contribute nothing, and their fires keep their previous entries.

### 3.12 Health

- `health.publish(storage, "trails", {started_at, finished_at, ok, note, build_id, counts, reused, mvt_reduced_tiles})`.
- The routing health section is described in 3.11.
- Frontend: `HealthDoc.trails?` and `HealthDoc.routing?` (optional), and `HealthView` rows for workflows named `Trails` and `Routing bundles`, read from the health sections. A weekly workflow scrolls out of the 40-latest-runs window.

### 3.13 New Python dependencies (two)

| Dep | Why it is needed | Alternatives rejected |
|---|---|---|
| `numpy` (one wheel, no transitive deps) | Per-cell GET recipe over 3–11M cells, the stream/water/slope masks, DEM encoding, conflation distance math, and the reference A* for parity/validation. | `gdal_calc.py` runs on system python3 with apt numpy, and it cannot express the ordered class logic or LUTs cleanly. Pure-Python loops would take minutes per fire. |
| `osmium` (pyosmium 4.3.1; manylinux wheel) | Streams a state PBF with node IDs and locations, which is required for exact splitting at shared nodes. It reproduced the Overpass result exactly in 6.4 s. | GDAL's OSM driver drops node IDs, which forces geometric noding with false junctions at bridges. `osmium-tool` from apt would still need a reader. Overture adds pyarrow and merges ways. |

Deliberately **not** added: shapely, pyproj, scikit-image and GRASS. AOI projection is pure Python (`utm.py`, checked against `gdaltransform` in tests), geometry projection goes through `ogr2ogr`, and the snapping/conflation needs are small enough for numpy.

---

## 4. Frontend

### 4.1 New modules (paths)

```
frontend/src/routing/
  bundle.ts          # RoutingIndex/RoutingDescriptor types; ROUTING_INDEX_PATH; bundleFileUrls(desc) — the ONE resolver
                     #   used by both packModel and offroadClient; useRoutingIndex(), useRoutingDescriptor(corneaId);
                     #   getRoutingDescriptor(corneaId) (imperative, module cache)
  costModel.ts       # PURE: constants, Sullivan/GET speed fns, pace LUTs, decodeCost LUT, edge/move/leg time fns
  vegClasses.ts      # PURE: class table (ids, keys, labels, colours, legend order) shared by veg layer, route legs, legend
  graphCodec.ts      # PURE: parse graph.bin → Graph views; densify(≤20 m) → CSR; vertex elevations & directional costs
  gridTiff.ts        # PURE-ish (geotiff): decode cost_veg.tif + dem.tif at native res; validate EPSG/size/origin vs descriptor
  rasterize.ts       # PURE: MultiPolygon (UTM) → Uint8 mask (active-edge scanline, even-odd, holes); chamfer dilation
  astar.ts           # PURE: resumable hybrid A* (typed arrays, binary heap), windowing, weighted fallback
  smooth.ts          # PURE: DDA segment evaluator + cost-aware string pulling
  legs.ts            # PURE: path → legs, veg runs, tertile times, climb (5 m hysteresis), steps text
  protocol.ts        # worker message types (shared by worker and client)
  offroad.worker.ts  # thin shell: holds bundles, dispatches load/route/veg/unload, cooperative yield
  offroadClient.ts   # main thread: lazy module worker singleton, bundle loading via wrapped fetch + transfer,
                     #   request ids, latest-wins coalescing, routeOffroad(), vegRaster()
  useWalkContext.ts  # hook: corneaId → descriptor, LATEST perimeter feature+date, avoidPerimeter flag → WalkContext
frontend/src/map/
  pmtilesProtocol.ts # ensurePmtiles() (dynamic import 'pmtiles', addProtocol once), OpfsSource, registerPackArchive()
  layers/trailsLayer.ts, layers/trailStyle.ts (PURE paint/popup builders), layers/vegetationLayer.ts
frontend/src/panels/
  OffroadSummary.tsx, offroad.css, VegetationLegend.tsx, vegetation.css
```
`spread/utm.ts` gains a forward `lonLatToUtm(lon, lat, zone, northern=true): [e, n]` using Snyder series with the same constants.

### 4.2 PMTiles protocol, offline Source, and the no-dependency fallback

- **Dependency:** `pmtiles@^4.5.0` (7.7 kB gzip, one transitive dep: fflate). It is **dynamically imported** the first time Trails is shown, so the main chunk is unchanged. Owner approval is pending.
- `ensurePmtiles()`: `const { Protocol } = await import('pmtiles'); protocol = new Protocol({ metadata: false }); maplibregl.addProtocol('pmtiles', protocol.tile);`, run once.
- **Online national source:** `url: 'pmtiles://' + (ptr.pmtiles.url_s3 ?? dataUrl(ptr.pmtiles.url))`. The stock `FetchSource` calls the global `window.fetch` on the main thread. The wrapper gets a new first line that passes through any request with a `Range` header, so pmtiles always sees B2's real 206 responses.
- **Offline per-fire source:**
  ```ts
  class OpfsSource implements Source {
    constructor(private file: File, private key: string) {}
    getKey() { return this.key; }
    async getBytes(offset: number, length: number) {
      return { data: await this.file.slice(offset, offset + length).arrayBuffer() };
    }
  }
  // key = `rdpack/${slug}/${desc.trails.id}` → source url 'pmtiles://rdpack/<slug>/<id>'
  ```
  The `File` comes from the new `packs.packedFile(dataUrl(desc.trails.url))`. A new PMTiles instance is registered whenever `store.offline.packs` identity changes, because a `File` snapshot goes stale after a pack update.
- **Source selection:** the national archive when `store.offline.online === true`; otherwise the pack archive for the current fire if one exists; otherwise the layer is hidden with a Layers-tab note "Trails unavailable offline for this fire."
- **Fallback if the owner declines the dependency:** `map/pmtilesLite.ts`, about 250 lines with no deps, behind the same `pmtilesProtocol.ts` facade. It would:
  - parse the 127-byte v3 header (min/max zoom at bytes 100–101, compression at 97–98);
  - decode varint directories (entry count, delta tile ids, run lengths, lengths, offsets), including leaf directories;
  - convert zxy to the Hilbert tile id;
  - read ranges via `window.fetch` with `Range` (online) or `File.slice` (offline);
  - gunzip with `DecompressionStream('gzip')`;
  - answer `addProtocol('pmtiles', …)` with `{data}` plus a synthesized TileJSON.
  It would be tested against a tiny GDAL-built PMTiles fixture. Call sites stay identical.

### 4.3 Trails layer (`trailsLayer.ts`, `trailStyle.ts`)

**Self-driven manager** in the `basemapUnderlay` pattern. It subscribes to `layers.trails.visible`, `ui.basemap`, `ui.theme`, `offline.online`, `offline.packs` and `view.corneaId`, with the dead-map guard `(map as any)._removed || !map.style`. So `LayerContext` and the `useMapLayerSync` ctx memo stay **unchanged**, which keeps churn out of the contested file. `catalogs/trails.json` is fetched through `getJson` into a module cache with a 30-min TTL.

**Source `rd-trails`:** `{type:'vector', url:'pmtiles://…', attribution:'Trails: USFS · BLM · NPS'}`, source-layer `trails`. It is recreated when the URL changes (online/offline or a new build).

**Layers and z-order slots** (added to `RD_LAYER_ORDER`):
- Below labels, immediately before `'rd-national-perimeters'`: `'rd-trails-casing'`, `'rd-trails-line'` (filter `status != 'not_assessed'`), `'rd-trails-line-na'` (filter `status == 'not_assessed'`, dasharray `[2, 2]`).
- Above labels, immediately after the basemap-symbol marker and before `'rd-wind-arrows'`: `'rd-trails-label'` (symbol, `symbol-placement: line`, `text-field: ['coalesce', ['concat', ['get','name'], ' #', ['get','num']], ['get','name'], ['get','num']]`, `text-font: rdLabelFont(map)`, minzoom 12, size 11), then `'rd-trails-hit'` (line width 16, opacity 0).
- All layers have minzoom 9 and are created with `visibility:'none'`.

**Paint per ground** (`trailPaint(ground)`, pure). Ground is `basemap==='satellite' ? 'satellite' : basemap==='topo' ? 'topo' : theme` (dark|light), and `'dark'` when the map style is the offline style.

| ground | casing (colour / opacity) | core | label text / halo |
|---|---|---|---|
| topo (default, has USGS dashed trails from z14) | `#ffffff` / 0.85 | `#c2255c` (raspberry) | `#7a1238` / `#ffffff` |
| light vector | `#ffffff` / 0.9 | `#c2255c` | `#7a1238` / `#ffffff` |
| dark vector + offline | `#120d10` / 0.8 | `#f06595` | `#ffd6e5` / `#120d10` |
| satellite | `#000000` / 0.6 | `#ff8fb8` | `#ffe3ee` / `#000000` |

- Width is `interpolate(linear, zoom, 9, 1.1, 14, 2.6)` for the core. Class 1–2 trails use ×0.8 (`['match',['get','cls'],[1,2],0.8,1]`). The casing is core + 2.2.
- Raspberry is chosen to avoid collisions with the route blue `#4aa3ff`, perimeter red, the hotspot yellow→purple ramp, the draw purple/blue/ink palette, range teal, the historic tan, and the dashed cross-country legs.

**Popup** (`trailPopupHtml(props)`, pure and escaped; hotspotLayer pattern: lazy `Popup({closeButton:false, offset:8})`, WeakSet install guard):
```
<b>Iron Creek Trail #640</b>  <span class=badge>USFS</span>
Class 3 · Developed  ·  Allowed: Hike · Pack · Bike
⚠ Hiking restricted 01/01–12/31          (warning colour; shown for any `restrict`)
Season: 05/15–09/15 · Grade 12–20% · Tread 18–24 in
Sawtooth NF · National Scenic Trail
Source: USFS EDW, updated 2026-09-23
<small>Crew routing uses all trails regardless of these restrictions.</small>
```
- Click handling: `onClick` returns early if `routeClickClaims(directions)` or `draw.tool !== 'none'`.
- `'rd-trails-hit'` is added to `INTERACTIVE` in `useMapLayerSync.ts`. After the hotspot-flames merge it also goes into `pinDrop.FEATURE_LAYERS`.
- The popup closes when the layer is hidden.
- `trackOncePer('fire-view', 'trail_popup_opened', {agency})`.

### 4.4 Layers-tab toggles, store, URL

- Store:
  - `layers.trails: { visible: boolean }`, default `false`. It is a viewing preference like traffic, so it is **not** reset in `selectFire`.
  - `layers.vegetation: { visible: boolean; opacity: number }`, default `{false, 0.55}`. It is per-fire, **reset in `selectFire`**.
  - `directions.avoidPerimeter: boolean`, default `true`. It persists across fires like `profile`.
  - Actions `toggleTrails()`, `setVegetation(partial)`, `setAvoidPerimeter(on)`. Each calls `track('layer_toggled', {layer, on})` or `track('offroad_avoid_perimeter', {on})`.
- `ForecastTab` `MapLayerToggles` rows:
  - "Trails", with meta `USFS · BLM · NPS`.
  - "Vegetation", with meta `LANDFIRE, for cross-country travel`, an opacity slider when it is on, and `<VegetationLegend>` chips.
- URL (`urlState.ts`): `trl=1` shows trails and `veg=1` shows vegetation. Only non-default values are written. `urlState.test.ts` `mkState` gains the two slices.

### 4.5 Cost and time math (exact; `costModel.ts`, mirrored in `routing/costmodel.py`)

θ is the signed slope in **degrees** along the direction of travel, with + meaning uphill: θ = atan(dz/d_h)·180/π, where d_h is the horizontal distance. Speeds are in m/s over **horizontal** distance, the convention of Tobler, Campbell and GET.

**Sullivan et al. 2020 loaded-crew tertiles (trail and road legs):**
```
v_sul,q(θ) = c_q / (π·b_q·(1 + ((θ − a_q)/b_q)²)) + d_q + e_q·θ
  low : a=−3.3717 b=25.8255 c=92.6594 d=−0.1624 e= 0.0019
  mod : a=−2.8292 b=20.9482 c=77.6346 d= 0.2228 e=−0.0004
  high: a=−2.2893 b=19.4024 c=65.3577 d= 0.6226 e=−0.0020
```
Check values: high gives 16.1, 11.9, 9.9, 14.0 and 19.7 min/km at −30, −15, 0, +15 and +30°, matching Table 4. Moderate gives 12.1 flat, +2.9 at −15° and +6.4 at +15°, matching the paper's "+3/+6". Low gives 17.4, +4.6 and +9.3, matching "+5/+9".

**GET v2 off-trail, anisotropic by a peak shift (grid legs):**
```
v_GET(s)      = 77.6196 / (π·22.4056·(1 + (s/22.4056)²)) + 0.0464            (= (0.0065s²+80.8887)/(0.1402s²+70.3892))
v_xc,mod(θ)   = v_GET(θ − θ0),  θ0 = −2.8°                                     (peak 1.149 m/s at −2.8°; 1.132 m/s at 0°)
ρ_q(θ)        = v_sul,q(θ*) / v_sul,mod(θ*),  θ* = clamp(θ, −30°, +30°)          (low 0.58–0.70, high 1.22–1.53)
v_xc,q(θ)     = max(0.05, v_xc,mod(θ)·ρ_q(θ))
```
All speeds are floored at `V_MIN = 0.05` m/s, and θ is clamped to ±45° for evaluation.

**Times:**
- Trail/road sub-edge: `t_q = d_h · (mult/10) / v_sul,q(θ)`.
- Grid move or smoothed off-trail piece: `t_q = d_h · M / v_xc,q(θ)`, where M is the move's mean multiplier (below).
- Portal between a vertex and its cell: `t_q = |vertex − cell centre| · M_cell / v_xc,q(0)`.

**Search metric:** the moderate tertile. Pace LUT: `PACE_XC[i] = 1/v_xc,mod(atan(g))` and `PACE_SUL[i] = 1/v_sul,mod(atan(g))` for grade `g = −1 + i/512`, i = 0…1024 (±45°). Grades are clamped and nearest-indexed; the error is <0.3%. Reported tertile times use the exact functions.

**A\* heuristic:** `h(n) = ‖p(n) − B‖ / V_MAX` with `V_MAX = 1.405` m/s (Sullivan moderate peak 1.4036). This is admissible and consistent because every step's cost is ≥ d/1.149 (grid and portals; M ≥ 1) or ≥ len/1.4036 (graph; mult ≥ 1.0, length ≥ chord).

Reference numbers for 1 km, as fast / typical / slow:

| Case | Time |
|---|---|
| Trail, flat | 9.9 / 12.1 / 17.4 min |
| Trail, +10° | 12.2 / 15.5 / 22.0 min |
| Grass off-trail, flat | 12.1 / 14.7 / 21.2 min |
| Grass off-trail, +10° | 14.9 / 19.0 / 27.0 min |
| Grass off-trail, −10° | 13.0 / 15.9 / 23.0 min |
| Timber (M=4), flat | 48 / 59 / 85 min |
| Timber + TL litter (M=8), flat | 97 / 118 / 169 min |

Crossing one stream cell adds a typical 106 s in grass, 424 s in timber and 848 s in timber with TL.

### 4.6 Hybrid A* design (`astar.ts`)

**Node space:** window cells `[0, Nw)` plus densified graph vertices `[Nw, Nw+V)`.

**Arrays:**
- `g: Float32Array(Nw+V)` (+∞)
- `parent: Int32Array(Nw+V)` (global id, −1 none)
- `viaSlot: Int32Array(V)` (CSR slot that reached the vertex, −1 = via portal)
- `closed: Uint8Array(Nw+V)`
- a binary heap of `(f: Float32, id: Int32)` with ties broken on the smaller id (deterministic, and matched by the Python reference)

**Bundle-time precomputation (worker, once per load):**
1. Parse graph → `densify(20 m)` → CSR `adjStart Int32(V+1)`, `adjTo Int32`, `adjEdge Int32` (original edge id), `adjCostMod Float32` (directional). `adjCostMod` comes from vertex elevations that are bilinear-sampled from the DEM and then smoothed with a (¼, ½, ¼) filter along each original edge, endpoints excluded.
2. Portals: vertex j links to its cell `cell(j) = (⌊Y_dm/300⌋, ⌊X_dm/300⌋)` unless the edge has the `no_portal` flag or the cell is impassable or nodata. `portalCost[j]` is Float32.
3. `M_LUT[256]`: 0 → ∞, 255 → ∞, v → 2^((v−1)/24).

**Grid expansion of cell s**, with offsets for 16 neighbours: 8 king moves (d = 30, 42.43 m) and 8 knight moves (d = 67.08 m):
- Skip a neighbour n that is closed, out of window, impassable (cost byte 0 or 255) or masked. The goal cell is always allowed.
- **Diagonal:** both orthogonal corner cells must be passable, so the move cannot cut a corner through water or cliff. `M = (M_s + M_n)/2`.
- **Knight** (|dr|,|dc|) = (1,2): the two crossed cells are `(r, c+sgn(dc))` and `(r+dr, c+sgn(dc))`, transposed for (2,1). Both must be passable and unmasked, and `M = (M_s + M_i1 + M_i2 + M_n)/4`.
- `θ` from `dz = (dem[n] − dem[s])·0.1` m: `cost = d·M·PACE_XC[grade]`.
- Portals from s: iterate the linked list `portalHead[s] → portalNext[j]`, with cost `portalCost[j]`. `portalHead` is Int32(Nw) built per window.

**Graph expansion of vertex j:** traverse CSR slots with `adjCostMod`. The graph is **not windowed**: trails may leave the grid window, since V is small. Skip `vertexBlocked[j]` (perimeter mask) and edges with both ends blocked. Portal back to `cell(j)` only if that cell is in the window and passable.

**Start and goal:**
- Start: A's cell `a` with `g = |A − centre(a)|·M_a·pace0`.
- Termination: on popping B's cell.
- If A's or B's cell is impassable or nodata, a BFS finds the nearest passable cell within 150 m and a flagged straight connector piece is added. If there is none, the error is `endpoint_blocked`.

**Window and limits:**
- Initial window = bbox(A, B) ⊕ `max(2000 m, 0.35·|AB|)`, clipped to the grid.
- If no path is found, or the grid part of the path passes within 2 cells of a window edge while the window is not yet full, the search re-runs with the margin ×2.5. There are at most 3 attempts, and the last uses the full grid.
- `MAX_WINDOW_CELLS = 6e6`, or `3e6` when `navigator.deviceMemory ≤ 4`. Above that the error is `too_far` ("Route too long for offline cross-country modeling; split it or use roads/trails online").
- Neighbours: **16**, dropping to **8** when the window is larger than 3e6 cells.
- Pop budget of 8e6, after which the search continues as weighted A* with `w = 1.4` from the current open set and the result is flagged `nearOptimal`.

**Cooperation:** A* is a resumable `step(maxPops=65536): 'more'|'done'|'fail'`. The worker yields between steps through a `MessageChannel` ping so it can see `cancel` messages. Superseded requests are dropped (latest wins).

**Perimeter:**
1. The main thread sends the LATEST perimeter as a flattened transferable (`coords Float64Array` lon/lat, `ringStart Uint32Array`, `polyRingCount Uint32Array`) plus a `key` (the path).
2. The worker projects it with `lonLatToUtm`.
3. It rasterizes with an even-odd active-edge scanline, which handles holes and MultiPolygons, to a full-grid `Uint8` mask.
4. It dilates with a two-pass 3-4 chamfer distance to ≤ `PERIM_BUFFER_M = 100`.
5. `vertexBlocked` is derived from the mask.
6. The result is cached by `(key, aoi.id, buffer)`.
If A or B is inside the dilated mask, avoidance is off for the request, the response carries `perimeterStart:'inside'`, and legs inside the undilated polygon are flagged `insidePerimeter`.

**"Blocked by perimeter" diagnosis:** if avoidance is on and no path is found, the search re-runs with avoidance off on the same window. If a route exists, the error is `blocked_by_perimeter` and that route is attached as `alternative` for the UI to offer.

### 4.7 Smoothing and post-processing (`smooth.ts`, `legs.ts`)

- **DDA evaluator:** an Amanatides–Woo traversal of a straight segment. For each cell piece, `t_mod = ℓ·M(cell)·pace_xc(θ)`, where θ comes from bilinear DEM samples at the piece ends. It returns ∞ on any impassable, nodata or masked cell. The corner rule treats touching exactly at a corner as passing through both corner cells.
- **Cost-aware string pulling** runs on each maximal run of grid cells, with endpoints fixed at portals, A or B:
  - From i, try `j = i+2, i+4, i+8 …` up to i+64, then binary-refine.
  - Accept the straight segment (i→j) if `eval(i→j) ≤ eval(polyline i..j)`, with both sides measured by the same evaluator.
  - Smoothing never increases cost. The research measured −1% cost, −3–5% length, and 165 → 29 vertices on a 5 km path.
- **Legs:**
  - Split by kind: graph sub-edges with class 0 → `trail`; class 1–3 → `road`; grid/portal pieces → `xc`.
  - Merge adjacent pieces of the same kind and name.
  - An **xc run shorter than 30 m between two network legs is absorbed** into the following network leg. Its time is kept, and `absorbedXcM` is set on that leg. This removes "missing junction" stubs without hiding modeled cross-country travel of any length that matters.
  - Legs at the route ends are always kept.
- **Per leg:**
  - Horizontal `distanceM`.
  - `climbM`/`descentM` from DEM samples every ≤10 m with a 5 m hysteresis filter.
  - `durationS: [fast(high), typical(mod), slow(low)]` using the exact tertile functions.
  - For xc legs: `veg: Record<classId, metres>`, `dominantVeg`, `creekCrossings` (entries into stream-flag cells) and `vegRuns` (sub-polylines by class, for colouring).
- **Coordinates:** cell centres and vertices are converted UTM → `utmToLonLat` and rounded to 1e-6°.

### 4.8 Worker protocol (`protocol.ts`)

```ts
// main → worker
type ToWorker =
 | { type:'load'; reqId:number; bundleKey:string; aoi:AoiMeta; demBaseM:number;
     costVeg:ArrayBuffer; dem:ArrayBuffer; graphGz:ArrayBuffer }                    // transfer all 3
 | { type:'route'; reqId:number; bundleKey:string; a:[number,number]; b:[number,number];
     avoid:{ key:string; coords:Float64Array; ringStart:Uint32Array; polyRingCount:Uint32Array } | null;
     opts?:{ neighbors?:8|16; bufferM?:number } }                                   // transfer the typed arrays
 | { type:'veg'; reqId:number; bundleKey:string; maxWidth:number }
 | { type:'cancel'; reqId:number }
 | { type:'unload'; bundleKey:string };
// worker → main
type FromWorker =
 | { type:'loaded'; reqId:number; bundleKey:string; stats:{ cells:number; vertices:number; edges:number; ms:number } }
 | { type:'route'; reqId:number; ok:true; result:OffroadResult }
 | { type:'route'; reqId:number; ok:false; error:{ code:OffroadErrorCode; message:string; alternative?:OffroadResult } }
 | { type:'veg'; reqId:number; width:number; height:number; classes:Uint8Array; corners:Corners }  // transfer classes
 | { type:'error'; reqId:number; message:string };
type OffroadErrorCode = 'not_loaded'|'outside'|'endpoint_blocked'|'no_path'|'blocked_by_perimeter'|'too_far'|'cancelled'|'internal';
```
`bundleKey = ${fk}:${grid.id}:${graph.id}`. `offroadClient` keeps one in-flight route and one pending (latest wins), and `unload`s the previous fire's bundle on `corneaId` change. The worker is created lazily with `new Worker(new URL('./offroad.worker.ts', import.meta.url), {type:'module'})`, never at import time, so vitest imports stay safe. `vite.config.ts` gains `worker: { format: 'es' }`, which is required because geotiff's decoder chunks fail under `iife`.

### 4.9 RouteResult extension (backward compatible)

```ts
export type LegKind = 'road' | 'trail' | 'xc' | 'gap';
export interface RouteLeg {
  kind: LegKind;
  coordinates: [number, number][];
  distanceM: number; climbM: number; descentM: number;
  durationS: [number, number, number] | null;   // [fast, typical, slow]; null for unmodeled gaps
  name?: string; ref?: string; agency?: 'OSM'|'USFS'|'BLM'|'NPS';
  veg?: Record<number, number>; dominantVeg?: number; creekCrossings?: number;
  vegRuns?: { veg: number; coordinates: [number, number][] }[];
  modeled: boolean;                // false for 'gap'
  insidePerimeter?: boolean; accessRestricted?: boolean; absorbedXcM?: number;
}
export interface RouteResult {                    // existing fields unchanged
  geometry: { type:'LineString'; coordinates:[number,number][] };   // still the full concatenated line
  distanceM: number; durationS: number;            // durationS = typical total (modeled legs)
  trafficDelayS: number | null; steps: RouteStep[];
  engine: 'tomtom'|'osrm'|'ors'|'valhalla'|'offroad';
  legs?: RouteLeg[];
  durationRangeS?: [number, number];               // [fast, slow] totals over modeled legs
  unmodeledM?: number;                             // total 'gap' distance
  nearOptimal?: boolean;
  avoidance?: { perimeterDate: string | null; applied: boolean; reason?: 'inside'|'off'|'none' };
  dataAsOf?: { osm?: string; trails?: string; landfire?: string; dem?: string };
}
```
`applyRoute`'s `fitBounds` and all existing consumers keep working, because `geometry` is still present.

### 4.10 Integration into `fetchRoute` and `SearchDirectionsControl` (engine selection, fallback, gap legs)

```ts
export interface WalkContext {
  corneaId: string; descriptor: RoutingDescriptor | null;
  perimeter: PerimeterFeature | null; perimeterDate: string | null;
  avoidPerimeter: boolean; online: boolean;
}
export async function fetchRoute(a, b, profile, walk?: WalkContext): Promise<RouteResult>
```
Behaviour of the `hike` branch:
1. **Inside:** if `walk?.descriptor` has a grid and graph with matching `aoi_id`, and `insideGrid(a)` and `insideGrid(b)` hold (UTM rect inset by 2 cells), then return `routeOffroad(walk, a, b)`.
   - Error `no_path`, `blocked_by_perimeter`, `endpoint_blocked` or `too_far` is thrown as `OffroadError`. There is **no** fallback to online engines, because they would ignore the perimeter and the terrain.
   - Error `not_loaded` (bundle fetch failed): fall back to online if `walk.online`, otherwise throw `offline_no_pack`.
2. **Outside or no bundle:** the existing ORS → Valhalla path, then `withEndGaps(result, a, b, walk)`, which is pure:
   - `gapA = haversine(a, coords[0])`, `gapB = haversine(b, coords[last])`. The threshold is 30 m.
   - If both ends of a gap are inside the grid, route that gap offroad (xc legs, modeled) and splice it in.
   - Otherwise add `{kind:'gap', modeled:false, durationS:null}` as a straight segment and add its length to `unmodeledM`.
   - The network portion becomes one `{kind:'road', modeled:true, durationS:[t,t,t]}` leg using the engine's time. Online engines can't tell trail from road.
   - If a perimeter is available and the network line intersects it (segment/polygon test on the main thread), add `avoidance = {applied:false, reason:'none'}` so the UI warns: "This online route crosses the fire perimeter."

`SearchDirectionsControl.tsx` gets minimal edits in this contested file:
- `const walk = useWalkContext();`
- The effect key becomes `${endpointsKey}|${walk.key}`, where `walk.key` is the descriptor ids, perimeter path and avoid flag.
- The 4th argument `p === 'hike' ? walk : undefined` is passed to `fetchRoute`.
- The mode-button label uses `fmtTypicalShort(state)`, which gives "~1h35" when `legs` are present.
- `routeErrorText(p, err)` maps the error codes (4.11).
- The summary block renders `<OffroadSummary route={route} walk={walk} />` when `route.legs` is set, and the existing summary otherwise.

### 4.11 Route rendering, summary, steps, error text

**`routeLayer.ts`** builds a `FeatureCollection` from `legs`. With no legs it emits one feature `{kind:'road'}` with today's look.
- `'rd-route-casing'`: all features, `#0d0a0c`, width 7, opacity 0.7 (existing).
- `'rd-route-line'`: filter `kind ∈ {road, trail}`, `#4aa3ff`, width 4 (existing).
- `'rd-route-xc'` (new): filter `kind == 'xc'`, features are **one per veg run**. Width 4.5, `line-dasharray [1.6, 1.1]`, butt cap, `line-color: ['match', ['get','veg'], 1,'#bdb5a8', 2,'#e9d66b', 3,'#d9a441', 4,'#a8672a', 5,'#2f8f4e', 6,'#1d5e36', 7,'#9a4f5c', 8,'#cfe0a0', 9,'#8e8e8e', 11,'#eef2f6', '#cccccc']`. The palette comes from `vegClasses.ts`.
- `'rd-route-gap'` (new): filter `kind == 'gap'`, `#d8d2d5`, width 3, `line-dasharray [0.6, 1.4]`.
- The ids are appended after `'rd-route-line'` in `RD_LAYER_ORDER`. The repo's one-layer-per-dash-class convention is kept.

**`OffroadSummary.tsx`** (styles in `offroad.css`):
```
1 h 10 – 2 h 15                         ← bold; fast–slow crew
typical loaded crew ≈ 1 h 35 · 6.4 mi · ↑ 1,240 ft ↓ 380 ft
[■■■■■■■■■■■□□□□□□]  Trail/road 4.1 mi · Cross-country 2.3 mi (36%)
Cross-country through: Timber 1.1 mi · Dense shrub 0.7 mi · Grass 0.5 mi · 2 creek crossings
⚠ Cross-country legs are modeled, not scouted.          ← persistent whenever the engine is offroad or any xc/gap leg exists
Avoids the fire perimeter from Sep 26, 9:05 PM (15 h old).   [☑ Avoid fire perimeter]
Times: Sullivan 2020 loaded-crew rates on trail; USFS GET v2 off trail. Scout and time with the slowest person.
Data: OSM Sep 26 · USFS/BLM/NPS trails Sep 21–23 · LANDFIRE 2025 · USGS 3DEP · NHD
▸ Steps (5)
```
**Step templates:**
- xc: `"Cross-country {dist} {bearing8} — {top2 veg}{, crosses N creek(s)} · ↑{climb} · {fast}–{slow}"`
- trail (first): `"Take {name ?? 'unnamed trail'}{ #ref}{ (USFS)} for {dist} · ↑{climb} · {fast}–{slow}"`
- trail (continue): `"Continue on …"`
- road: `"Walk {name ?? 'the road'} for {dist}"`, plus `" (private/restricted road)"` if `accessRestricted`
- gap: `"Last {dist} is cross-country and not modeled (outside this fire's routing area)"`
- end: `"Arrive at B"`

**Other notes:**
- `nearOptimal` → "Near-optimal route (long search)".
- `perimeterStart:'inside'` → "Start or destination is inside the fire perimeter; perimeter avoidance is off for this route. Legs inside are marked."
- A per-leg ⚠ appears when `insidePerimeter` is set.

**Error text** (`routeErrorText`):

| Code | Text |
|---|---|
| `no_path` | "No foot route inside this fire's routing area. Open water, cliffs (>45°) or the perimeter block every path." |
| `blocked_by_perimeter` | "Every foot route crosses the fire perimeter." [Show route through the perimeter] button, which renders `alternative` flagged. |
| `endpoint_blocked` | "Start or destination is in open water or on >45° terrain." |
| `too_far` | "Too long for offline cross-country modeling. Try a closer destination." |
| `offline_no_pack` | "Offline foot routing needs this fire downloaded (Overview → Download this fire)." |
| drive/apparatus offline | "No service. Driving directions need a connection." |

### 4.12 Vegetation layer (`vegetationLayer.ts`)

- Self-driven: it subscribes to `layers.vegetation` and `view.corneaId`, and gets the descriptor via `getRoutingDescriptor`.
- When visible, it asks `offroadClient.vegRaster(desc, 2048)`. The worker returns the veg class bytes, nearest-downsampled by an integer step `ceil(W/2048)`.
- The main thread paints through a LUT built from `vegClasses` colours (alpha 0 for class 0), overlaying `#3a2f2f` at 0.7 alpha for the steep flag and `#2f6fbf` for the stream flag at full resolution only. It uses `buildLut`/`paintProduct` semantics from `productRenderer` and writes into an offscreen canvas.
- Source and layer: `addSource('rd-vegetation', {type:'canvas', canvas, coordinates: corners, animate:false, attribution:'Vegetation: LANDFIRE'})`, and a raster layer `'rd-vegetation'` with `raster-resampling:'nearest'`, `raster-fade-duration:0` and opacity from the store. It is the **first** entry in `RD_LAYER_ORDER`, below `rd-traffic`.
- Corners come from `utmBoundsTo4326(aoi rect)`.
- It resets on `corneaId` change (perimeterLayer pattern).
- The legend appears in the ForecastTab row and in `LegendBar`, whose early return is widened.

### 4.13 Offline pack additions

- **`packModel.ts`:**
  - `PackInputs` gains `routingDescriptorPath: string | null` and `routingDescriptor: RoutingDescriptor | null`.
  - `snapshotUrls` adds `dataUrl(ROUTING_INDEX_PATH)` and `dataUrl(routingDescriptorPath)` (mutable).
  - `buildPackPlan` adds, from `bundleFileUrls(desc)` (the same resolver as runtime), `{url, immutable:true, estBytes: part.bytes ?? EST.x}` for `cost_veg.tif`, `dem.tif`, `graph.bin.gz` and the trails `pmtiles` extract. They are not optional: the URLs are versioned and referenced by the fresh descriptor, so a 404 is a real error.
  - `EST` adds `routingCostVeg 1_500_000`, `routingDem 2_500_000`, `routingGraph 900_000` and `trailsExtract 1_000_000`.
- **`packs.ts`:**
  - `runDownload` Phase 1: `rawJson(routing index)` → entry for `corneaId` → `rawJson(descriptor)`.
  - Wrapper: a first-line `Range` pass-through.
  - `contentTypeFor`: `.pmtiles` → `application/vnd.pmtiles`, `.gz` → `application/gzip`.
  - New `export async function packedFile(url): Promise<File | null>` (urlIndex lookup, then `opfs.getPackFile`).
  - `track('offline_pack_downloaded', {…, routing: !!desc?.grid, trails: !!desc?.trails})`.
  - `PackMeta` gains optional `routing?: {grid?: string; graph?: string; trails?: string}`, with `version: 1` unchanged.
- **`opfs.ts`:** `getPackFile(slug, name): Promise<File | null>`, and the ext regex adds `pmtiles|gz`.
- **`OfflineCard.tsx`** copy: "…perimeters, hotspots, forecast, weather, the last 2 days of incident maps, **trails and offline foot routing**."
- Typical addition per fire: about 5–7 MB.

### 4.14 Analytics (existing `track`/`trackOncePer`; limits 30/min, 300/page)

- `offroad_route` via `trackOncePer('fire-view', 'offroad_route', …)` with `{ms_bucket, km, xc_pct_bucket (0/10/…/100), legs, avoided, near_optimal, window_expansions}`.
- `offroad_fallback` `{reason:'outside'|'no_bundle'|'load_failed'}` via trackOncePer.
- `offroad_error` `{code}`, which is rare.
- `offroad_avoid_perimeter` `{on}`.
- `layer_toggled` `{layer:'trails'|'vegetation', on}`.
- `trail_popup_opened` `{agency}` via trackOncePer.
- `offline_pack_downloaded` gains `{routing, trails}`.

### 4.15 Sources, credits and attribution

`SourcesView.SOURCES` gains:
- USFS EDW National Forest System Trails.
- BLM GTLF (public managed and not-assessed trails).
- NPS Public Trails.
- **OpenStreetMap**: "© OpenStreetMap contributors. Offline routing graphs are a derived database under **ODbL-1.0**; they are published at `/routing/{fire}/n…/graph.bin.gz`."
- LANDFIRE (EVT, EVC, FBFM40 LF 2024/2025; LF 2020 slope; public domain, "modified").
- USGS 3DEP.
- USGS NHD.
- A "Models" entry: Sullivan et al. 2020 (Fire 3:52) and Campbell et al. 2024, GET v2 (Fire 7:292).

Map attributions: `rd-trails` → "Trails: USFS · BLM · NPS", `rd-vegetation` → "Vegetation: LANDFIRE". When the engine is offroad, the directions card footer reads "© OpenStreetMap contributors (ODbL) · USFS · BLM · NPS · LANDFIRE · USGS".

---

## 5. Testing strategy and verification plan

### 5.1 Worker (pytest; real captured fixtures; GDAL tests `needs_gdal`-skipped)

| File | Covers |
|---|---|
| `test_trail_schema.py` | Per-agency normalization against 60-row CSV excerpts per agency, taken from `scratchpad/dataapi/{usfs_terra,blm_managed_trails,nps_trails}.gpkg`. Includes the messy cases: `TG05 - +12-20%`, `TRAIL_GRADE`, `TW03 - 18-24 INCHES`, trailing-space dates, `N/A`, BLM case variants, NPS pipe-delimited TRLUSE and the filtered statuses. |
| `test_pmtiles_check.py` | Header parse of a 30 KB GDAL-built PMTiles fixture; rejects a truncated file, a wrong magic and the MVT/gzip flags. |
| `test_trails.py` | Monkeypatched `_run` and `download`: 304 reuse of a part, the count-drop guard, per-agency carry-forward, pointer shape, upload order (pointer last), and no-op when not due. |
| `test_routing_aoi.py` | Zone choice, min/max sizes, 3 km snapping, growth-only union, `clipped` flag, `aoi.id` stability. |
| `test_routing_grid.py` | Synthetic 6×6 arrays covering every recipe row (tree+TL=8→73; tree+TL+stream=40→129; shrub c=50→2.5; SB; water via EVC/EVT/FBFM; SlpD 46→0; nodata→255), the LF2025/LF2024 per-pixel mosaic, the encode/decode round trip, and DEM encoding. `needs_gdal`: gridio write→read round trip and geotransform checks. |
| `test_routing_graph.py` | A tiny `.osm` XML fixture (pyosmium reads XML): split at shared nodes, bridge crossing without a junction, walkable filter, T5 exclusion. Conflation: agency line offset 10 m gets dropped and names transferred; offset 60 m gets kept and snapped (vertex and edge-split cases); a perpendicular crossing is not "covered". Encoder: a Python reader round trip, delta overflow splitting, crc32. |
| `test_costmodel.py` | Sullivan Table 4, moderate/low guidance, GET equivalence of both forms, anisotropic peak at −2.8°, ρ clamp, V_MAX. Exports `fixtures/routing/costmodel_constants.json`. |
| `test_validate_astar.py` | The reference A* reproduces hand-computed optima on a 5×5 grid; trail preference; portal join mid-edge; anisotropy (A→B ≠ B→A on a slope); perimeter block; diagonal corner rule; knight intermediate rule. Exports `fixtures/routing/parity_small.json` (60×60 grid, 40-edge graph, 6 queries with expected costs and cell/vertex sequences). |
| `test_routing_bundle.py` / `test_routing_publish.py` | DryRunStorage end-to-end with stubbed fetchers: keys, `done.json` skip, AOI-pair consistency on a partial failure, descriptor carry-forward, index merge, inactive drop, health section. |

### 5.2 Frontend (vitest, node, pure modules)

- `routing/costModel.test.ts`: Table 4, guidance numbers, LUT error <0.3%, constants equal `costmodel_constants.json`.
- `routing/graphCodec.test.ts`: parses `graph_fixture.bin.gz` produced by the worker test, with gunzip via node's `DecompressionStream`. Checks densification spacing ≤20 m, CSR degrees and directional costs.
- `routing/gridTiff.test.ts`: fixtures written with `geotiff.writeArrayBuffer` (UTM keys). Checks the EPSG/size/origin mismatch errors.
- `routing/rasterize.test.ts`: square, hole, MultiPolygon, dilation radius.
- `routing/astar.test.ts`:
  - A* equals Dijkstra (h=0) on 50 random small grids, which checks admissibility and consistency.
  - Straight-line flat cost is within 3% of Euclidean·pace for 16-neighbour.
  - An obstacle forces a detour.
  - A trail shortcut is taken.
  - Window expansion when the optimum leaves the initial window.
  - The weighted fallback flags `nearOptimal`.
  - Cancellation.
  - **Parity** with `parity_small.json`: costs within 1e-4 relative, identical sequences.
- `routing/smooth.test.ts`: never increases cost; zig-zag removal; never crosses an impassable cell.
- `routing/legs.test.ts`: segmentation, <30 m xc absorption, veg run splitting, `fast ≤ typical ≤ slow`, climb hysteresis, step texts, bearing8.
- `spread/utm.test.ts`: forward/inverse round trip <1 mm; 5 points against `gdaltransform` values stored in the test.
- `api/routing.test.ts`: `withEndGaps` thresholds, gap splicing, and `insideGrid`.
- `map/layers/trailStyle.test.ts` (paint per ground, popup escaping, the restriction line), `routeLayer.test.ts` (legs → features), `zOrder.test.ts` (new ids and groups), `offline/packModel.test.ts` (routing files, immutability, snapshot URLs), `app/urlState.test.ts` (trl/veg).

### 5.3 Model validation (the fidelity gate)

1. **Literature reproduction** (unit tests above): Sullivan tertiles and GET v2.
2. **Golden routes** (`worker/tests/fixtures/routing/golden_routes.json`, run by `routing-validate` in Python and by the frontend in the browser, see 5.4). Ad-hoc AOIs built with `routing-plan --adhoc`:
   - **R1 Sawtooth** (`stanley:-115.25,43.95,-114.63,44.40`), Iron Creek TH (−115.01402, 44.19870) → Stanley Lake TH (−115.06576, 44.24711). Expected:
     - trail share ≥ 0.85 (Iron Creek–Stanley Lake Trail + Alpine Way #528);
     - distance 13.3–14.8 km (BRouter trail 14.05 km, versus Valhalla's 15.15 km road route);
     - must **not** use "ID 21";
     - typical time 2.5–4.5 h.
   - **R2 Bob Marshall** (`teton:-112.95,47.70,-112.60,47.95`), South Fork Teton TH (−112.78245, 47.84753) → Rocky Mountain summit (−112.80032, 47.81245). Expected:
     - reaches B (no silent snap);
     - trail share ≥ 0.6 on Headquarters Creek Trail #165;
     - an xc leg of 0.6–1.6 km;
     - total 6.5–8.0 km;
     - xc climb ≥ 350 m (summit 2,858 m).
     If the summit cells are >45°, expect `endpoint_blocked` with a nearest-passable connector ≤150 m.
   - **Little Giant WA** (real bundle): three pairs chosen after the build by the verifier. (a) Trailhead→trailhead on a USFS trail: trail share ≥ 0.9. (b) Road→ridge off-trail: the xc leg never crosses a cost-0 cell, and its average grade ≤ the fall-line grade. (c) A pair straddling a perennial river with one road or trail bridge: the route uses the bridge vertex.
   - **Symmetry/anisotropy check:** for (b), both directions are computed; the uphill direction must be slower.
3. **Sensitivity report** (dev script output, not a test): typical time for pairs (b) and (c) under `tree_mode=getv2` versus a cover-scaled variant (M_tree = 1 + 3·cover), to inform the open question in 7.

### 5.4 Verification plan (local, end to end)

1. **Worker dry run on real data** (scratch output only):
   ```bash
   cd worker && uv sync
   uv run python -m responder_worker.cli sync-trails --dry-run --out $SCRATCH/out --force
   uv run python -m responder_worker.cli routing-plan --dry-run --out $SCRATCH/out \
       --fires "{091081ED-BD23-4610-AE4A-270F95D1711E}" --adhoc stanley:-115.25,43.95,-114.63,44.40 \
       --adhoc teton:-112.95,47.70,-112.60,47.95 --plan-out $SCRATCH/plan.json
   uv run python -m responder_worker.cli routing-bundles --dry-run --out $SCRATCH/out --plan $SCRATCH/plan.json \
       --shard 0 --result-out $SCRATCH/shard-0.json --trails-fgb $SCRATCH/out/trails/b*/trails.fgb
   uv run python -m responder_worker.cli routing-publish --dry-run --out $SCRATCH/out --results-dir $SCRATCH --plan $SCRATCH/plan.json
   uv run python -m responder_worker.cli routing-validate --descriptor $SCRATCH/out/catalogs/routing/<fk>.json --routes tests/fixtures/routing/golden_routes.json
   ```
   Inspect with `gdalinfo -stats cost_veg.tif dem.tif`, `ogrinfo -so trails.fgb`, and the `pmtiles_check` header dump. Note that local brew GDAL is newer; the CI version must be exercised by a `workflow_dispatch` on the branch before merge.
   Primary fire: **Little Giant WA** (172,879 ac, steep timber, USFS trails, perennial streams). Stress fire: **0445-crosswhite OR** (342,923 ac), which hits the 100 km AOI cap at about 11M cells.
2. **Static build preview** (per project memory; the dev server can't launch from ~/Desktop):
   - Serve `$SCRATCH/out` with a tiny CORS- and Range-capable static server (`scratchpad/design/range_server.py`, a stdlib `http.server` subclass handling single `Range` requests with 206 and `Access-Control-Allow-Origin: *`) on a fresh port.
   - `VITE_DATA_BASE_URL=http://127.0.0.1:<port> npx vite build --outDir $SCRATCH/dist`. An absolute URL is required so pack keys match MapLibre's absolute Request URLs.
   - Serve `dist` with `spa_server` on another fresh port and open it in the browser pane.
3. **Browser checks** (use `window.__rdStore` / `__rdMap` in DEV builds, or a DOM plus network-panel check in preview):
   - Trails: toggle on Topo, Satellite, Dark and Light; tap a trail → popup fields and restriction line; with both route ends set, a trail tap opens the popup and does not move B.
   - Walk inside the AOI: the golden pairs render solid trail legs and dashed veg-coloured xc legs, with the range, split bar, veg chips, persistent label and steps. The Avoid-perimeter checkbox changes the route when the pair straddles the perimeter.
   - Walk with B outside the AOI: the online route plus a dotted "unmodeled" gap leg.
   - Vegetation layer: aligned with the topo underlay (check a lake shoreline and a ridge).
   - Offline: download the fire pack, stop the data server (the network fails, so the wrapper falls back to the pack), and reload with the browser offline. Trails come from the OPFS source, Walk inside the AOI still routes, and vegetation still paints.
   - Performance: log route ms for a 5 km and a 15 km pair on desktop (targets <150 ms and <600 ms). If a phone is available, test the same pairs with a target <2 s.

---

## 6. Implementation plan: ordered slices

S0 and W0 land first because they concentrate every edit to contested or shared files. Then W1–W5 and F1–F7 run in parallel with minimal overlap. File ownership is exclusive per slice.

| Slice | Files (C = create, M = modify) | Depends on | Acceptance criteria | Tests |
|---|---|---|---|---|
| **S0 Frontend scaffolding** | M `package.json` (+`pmtiles`), `vite.config.ts` (`worker:{format:'es'}`), `map/zOrder.ts` (+`rd-vegetation`, `rd-trails-casing/line/line-na`, `rd-trails-label/hit`, `rd-route-xc/gap`), `map/zOrder.test.ts`, `state/store.ts` (slices + actions + selectFire reset), `map/useMapLayerSync.ts` (MANAGERS += trails/vegetation; INTERACTIVE += `rd-trails-hit`), `app/urlState.ts` + test (`trl`, `veg`), `panels/tabs/ForecastTab.tsx` (2 rows), `api/routing.ts` (**types only** + `fetchRoute` 4th param, no behaviour change); C `map/layers/trailsLayer.ts` and `vegetationLayer.ts` (no-op managers), `routing/bundle.ts` (types, resolvers, hooks) | — | `tsc --noEmit` and vitest pass; no visible behaviour change except two inert toggles | zOrder, urlState, store toggle tests |
| **W0 Worker scaffolding** | M `config.py` (rules, types, endpoints, budgets), `pyproject.toml` + `uv.lock` (numpy, osmium), `http.py` (`download`), `cli.py` (all new subparsers → thin `cmd_*` delegating to module `run_*`, stubs returning 0); C `gdaltools.py`, `utm.py`, `routing/__init__.py` | — | `uv run pytest` green; `cli --help` lists the commands; stubs exit 0 | `test_utm.py`, `test_gdaltools.py` |
| **W1 National trails** | C `trail_schema.py`, `trails.py`, `pmtiles_check.py`, `.github/workflows/trails.yml`, tests + fixtures | W0 | Dry-run writes `trails/b…/{parts/*.fgb, trails.fgb, trails.pmtiles, manifest.json}` then `catalogs/trails.json`; header check passes; counts within ±5% of research (USFS ~74.8k with geometry, BLM 24,570, NPS ~31.1k after filter) | 5.1 rows |
| **W2 Grid builder** | C `routing/{aoi,landfire,dem,hydro,gridio,grid}.py`, `routing/data/lf_evt_lifeform.csv`, tests | W0 | For Little Giant, `cost_veg.tif` and `dem.tif` on the exact UTM grid; recipe stats plausible (timber-dominated, impassable < 10%); LF2025 used (NW GeoArea) | `test_routing_aoi.py`, `test_routing_grid.py` |
| **W3 Graph builder** | C `routing/{geofabrik,osm,graph}.py`, tests, `fixtures/routing/graph_fixture.bin.gz` | W0 (+ W1 FGB for real runs; tests use a fixture FGB) | Stanley ad-hoc graph contains Iron Creek–Stanley Lake Trail and Alpine Way edges connected; encoder round-trips; size ≤ 1.5 MB gz for a 50 km box | `test_routing_graph.py` |
| **W4 Cost model + validation** | C `routing/{costmodel,validate}.py`, `test_costmodel.py`, `test_validate_astar.py`, `fixtures/routing/{costmodel_constants,parity_small,golden_routes}.json`; the `routing-validate` implementation | W0 | Literature checks pass; parity fixture exported; golden routes pass on the ad-hoc bundles once W2/W3/W5 exist | 5.1 rows |
| **W5 Orchestration** | C `routing/{plan,bundle,publish}.py`, `.github/workflows/routing.yml`, tests | W2, W3 (interfaces; stubs acceptable until they land) | Dry-run end-to-end for 2 fires + 2 ad-hoc AOIs; idempotent re-run uploads nothing; a partial failure keeps the AOI-consistent pair; index written last | `test_routing_bundle.py`, `test_routing_publish.py` |
| **F1 Routing core (pure TS)** | C `routing/{costModel,vegClasses,graphCodec,gridTiff,rasterize,astar,smooth,legs}.ts` + tests; M `spread/utm.ts` (+forward) + `utm.test.ts` | S0 types; W3/W4 fixtures (hand-made fixtures until then) | All pure tests pass, including parity; 4M-cell synthetic 15 km route < 150 ms in node on desktop | 5.2 rows |
| **F2 Worker shell + client** | C `routing/{protocol,offroad.worker,offroadClient,useWalkContext}.ts` | F1, S0 | `vite build` emits the worker chunk plus geotiff decoders; load→route→veg round trip in the preview; stale requests dropped; latest-wins coalescing | client coalescing logic tested as a pure helper |
| **F3 Directions integration** | M `api/routing.ts` (behaviour: hike branch, `withEndGaps`, `OffroadError`, `routeErrorText`), `api/routing.test.ts`, `panels/SearchDirectionsControl.tsx` (≈25 lines), `map/layers/routeLayer.ts` + C `routeLayer.test.ts`; C `panels/OffroadSummary.tsx`, `panels/offroad.css` | F2 | Section 4.10/4.11 behaviour in the preview; Drive/Apparatus unchanged; online Walk outside the AOI shows gap legs | api + routeLayer tests |
| **F4 Trails layer** | C `map/pmtilesProtocol.ts`, `map/layers/trailStyle.ts` + test; M `map/layers/trailsLayer.ts` (fill the S0 stub) | S0, W1 (pointer schema), F6's `packedFile` export (land that function first) | Trails render on all grounds; popup + arbitration; offline pack source works; pmtiles dynamic-imported (main chunk unchanged) | trailStyle tests |
| **F5 Vegetation layer** | M `map/layers/vegetationLayer.ts` (fill stub), `panels/LegendBar.tsx`; C `panels/VegetationLegend.tsx`, `panels/vegetation.css` | F1 (vegClasses), F2 (`veg` message) | Canvas aligned (lake/ridge check); nearest resampling; resets on fire switch | LUT/paint test (pure helper) |
| **F6 Offline pack** | M `offline/packModel.ts` + test, `offline/packs.ts` (Range guard, `packedFile`, content types, Phase-1 routing fetch), `offline/opfs.ts` (`getPackFile`, ext regex), `panels/OfflineCard.tsx` | S0 (`bundle.ts` resolvers) | A pack includes routing + trails files; offline reload routes and draws trails; update re-downloads only changed immutable files | packModel tests |
| **F7 Health + credits** | M `api/types.ts` (HealthDoc `trails?`/`routing?`), `panels/HealthView.tsx`, `panels/SourcesView.tsx` | W1/W5 health shapes | /health shows both sections; /sources lists the new sources incl. the ODbL note | — |

**Merge notes:** the main checkout has uncommitted hotspot-flames edits to `zOrder.ts` (a new `rd-hotspot-flames` id and a rewritten `ensureOrder`), `useMapLayerSync.ts` (idle-click pin drop), `store.ts`, `SearchDirectionsControl.tsx`, `geo.ts` and `panels.css`.
- S0's edits to those files are purely additive: array entries, new slices, one line each in MANAGERS and INTERACTIVE.
- F3's edit to SearchDirectionsControl is about 25 lines, and the UI lives in the new `OffroadSummary.tsx`.
- No slice touches `geo.ts` or `panels.css`; distance helpers live in `routing/`.
- After that work merges, add `rd-trails-hit` to `pinDrop.FEATURE_LAYERS`, and build S0 on top of the fixed `ensureOrder` (the no-op-move version) so the extra layers don't worsen the styledata redraw loop.

---

## 7. Risks, open questions, non-goals

### 7.1 Where research facts conflict, and what I chose

| Conflict | Choice | Reason |
|---|---|---|
| GET v2 slash/blowdown **5×** (table, overview) vs **4×** (one methods sentence) | 5× | The table is authoritative and the value is conservative. |
| Impassable-slope source: LF2020 SlpD (1.26% >45°) vs 3DEP-derived (1.79%) | SlpD for the mask; 3DEP for per-move grades | The mask matches GET's calibration. Per-move grades use the fresher float DEM. |
| Lifeform: EVT vs EVC disagree on ~8.5% of cells | EVC primary, EVT as fallback and water/snow cross-check | EVC carries the cover % that GET's continuous shrub term requires. |
| LANDFIRE access: LFPS async job (tooling note) vs anonymous exportImage/WCS (data facts) | exportImage, WCS fallback, never LFPS | LFPS requires sending an email. |
| Streams: GET used NHDPlus HR vs slow REST services | NHD HU8 GPKG with fcode 46006 (+55800 outside water) | Same perennial class; reliable static files. |
| OSM: Overpass (tooling note) vs Geofabrik | Geofabrik + pyosmium | Overpass policy forbids the cron use. |
| Graph encoding: varint (research, 365 KB gz) vs SoA typed arrays | SoA + gzip (~0.9 MB gz) | Zero-copy views and simpler parsing. The size is still small. |
| Neighbourhood: 8 (faster) vs 16 (2.8% worst-case) | 16 + smoothing; 8 above 3M-cell windows | Fidelity priority. |
| Off-trail base function: Tobler ×0.6, STRIDE, GET v2, Sullivan | GET v2 + −2.8° shift; Sullivan ratios for the band | STRIDE needs lidar density (it would add large error from LANDFIRE proxies). Tobler ×0.6 is crude. The owner specified GET v2. |
| Per-fire trails extract: `pmtiles extract` (Go binary) vs `ogr2ogr -spat` from FGB | ogr2ogr from FGB | No new binary, and no GDAL 3.8.4 PMTiles read (bug #9288). |
| Fire count: the brief says ~312; the live catalog has 328 | All catalog wildfires; CONUS get full bundles; non-CONUS trails-only in v1 | LANDFIRE AK/HI/PR services and the Geofabrik regions are follow-ups. |
| Routing DEM: AWS terrarium tiles vs a baked 3DEP grid | Baked grid | Offline, exactly aligned, not exaggerated. |

### 7.2 Risks

- **Model fidelity.**
  - GET multipliers are expert-opinion and "conservative". Tree-dominated = 4× regardless of cover will over-penalize open juniper woodland, common in the Oregon fires such as Crosswhite. Cross-country routes may detour to avoid it.
  - Perennial streams at ×5 make each crossing cost 2–14 min typical, which pushes routes onto bridges (realistic) and inflates forced crossings.
  - Slope comes from 30 m data, so cliff bands narrower than 30 m are invisible.
  - LANDFIRE 2024 only reflects disturbance through FY2024; LF2025 covers FY2025 in the SW and NW. Recent burn scars and blowdown are not represented.
  - Mitigations: the persistent "modeled, not scouted" label, visible data vintages, the sensitivity report and the owner's open questions below.
- **Time range meaning.** The band is crew variability at a given slope (Sullivan tertiles). It excludes fatigue, heat, night, smoke, panic and pack drop (Sullivan caveats). The copy says "loaded crew" and "scout and time with the slowest person" (IRPG).
- **Perimeter staleness and scope.** The latest perimeter can be many hours old, the standoff is a flat 100 m, and spot fires outside the perimeter are unknown. The age is shown. Online routes outside the AOI don't avoid the perimeter, only warn.
- **Phone performance and memory.** Timing is desktop-only (research: 5 km ≈ 6 ms, 15 km ≈ 50–80 ms at 4M cells). A 100 km AOI decodes to about 44 MB of grids plus search arrays. Window caps, `deviceMemory` gating and cooperative yielding mitigate this. Phone measurement is a verification item.
- **Upstream endpoints.** LANDFIRE exportImage is undocumented as a programmatic channel (WCS is the fallback). 3DEP ImageServer reliability and rate limits are unknown. The EDW weekly refresh is currently flagged as failing (the `as_of` shows it). Geofabrik bandwidth: one PBF per region per shard per week.
- **CI.** GitHub crons slip by 3–6 h, and the daily cron plus workflow_run is catch-up-safe. Disk is about 14 GB. The actions cache is 10 GB. Local brew GDAL is newer than CI's 3.8.4, so a branch dispatch run is required before merge.
- **PMTiles caching.** Native B2 206 responses are not HTTP-cached; the `url_s3` host is used (Chrome-verified; Safari/Firefox not). B2 is HTTP/1.1, so first renders at a new place are slower.
- **ODbL.** The graphs are derived databases. They are published on the public bucket, and the Sources page states the licence. The owner should confirm the wording.
- **Merge churn** with the hotspot-flames work (section 6 notes).
- **Click arbitration.** A 16 px trail hit layer over dense networks swallows B-moves when both ends are set, the same trade-off as hotspots. It only applies when Trails is on.

### 7.3 Open questions for the owner

1. Approve the `pmtiles` npm dependency, or use the in-repo `pmtilesLite.ts` fallback (about 250 LOC, same facade)?
2. Perimeter standoff: is 100 m right, or should it be configurable? When A or B is inside, is "avoidance off + flag" the right behaviour?
3. Keep strict GET v2 tree = 4×, or adopt a cover-scaled tree multiplier after reviewing the sensitivity report (5.3)?
4. Include NHD fcode 46000 (stream, permanence unspecified) as ×5? It is off by default for GET fidelity.
5. Default for Trails: off (proposed) or on?
6. Use the S3-endpoint URL for the national archive (a new host in network traffic) for browser caching?
7. Walk when both points are inside the grid but no offroad path exists: keep the "no silent online fallback" rule (proposed)?

### 7.4 Explicit non-goals (v1)

- Grids and graphs for AK, HI and PR. Trails extracts only.
- Live NIFS event lines (restricted), and a historical firelines layer from the NIFC Operational Data Archives (a candidate follow-up).
- MVUM/NFS roads overlay, state trail datasets (COTREX, UGRC, WA RCO; the Idaho IDPR licence forbids commercial use), and USGS NDT.
- Designating escape routes or safety zones. Turn-by-turn navigation or GPS following. Night, smoke or heat adjustments. Pack-drop speeds.
- Lidar STRIDE density/roughness. Route alternatives. Elevation profile chart. Walking isochrones: Dijkstra from A over the same hybrid graph is a cheap follow-up.
- Routing across more than one fire's bundle, or using a neighbouring fire's bundle.
- Drive/Apparatus changes, including the Valhalla `X-Client-Id` and `search_cutoff` improvements noted in research (recommended separately).
