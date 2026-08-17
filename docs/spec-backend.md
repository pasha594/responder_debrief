# Backend / Data-Pipeline Detailed Spec

Companion to [plan.md](plan.md) — the full backend design with exact algorithms, schemas, and pseudocode. Where this and plan.md disagree, plan.md wins (it reflects final user decisions: GitHub Pages hosting, proxy routes `/wms01`+`/wms02`, width/height cap 2048).

## Worker runtime

- GitHub Actions, ubuntu-latest, Python 3.12 via `uv` (lockfile; `uv python install 3.12` handles interpreter). GDAL **exclusively via subprocess CLI** (`gdalinfo -json`, `gdal_translate`, `gdalwarp`, `gdal2tiles.py`, `ogr2ogr`) from `apt-get install gdal-bin` (CI) / `brew install gdal` (local).
- Deps: `httpx` (HTTP/2), `lxml` (iterparse caps), `rapidfuzz`, `boto3` (B2 S3-compatible endpoint; set `CacheControl`+`ContentType` on put), `tenacity`, `pypdf`.
- Known GH-cron caveats: schedule drift up to ~15–30 min (use odd minutes), no persistent disk (state in B2), jobs idempotent/catch-up-safe.

## Module layout

```
worker/
  pyproject.toml                     # uv-managed; py3.12
  responder_worker/
    config.py        # region roots, product allowlists, retention windows,
                     # concurrency caps, B2 bucket/prefixes, GACC->states map
    fires.py         # fetch_active_fires(): GET /fires?active=true&limit=500&fields=...
                     # parse "lat, lon" string -> [lon, lat]; slugify helpers
    ftp_index.py     # Apache autoindex parser: list_dir(url) -> [Entry(name, href,
                     # mtime, is_dir, size_hint)]; handles %20 and sort params
    matching.py      # unit-token regex, name normalizer, match_incidents(),
                     # match_pyrecast_slugs(); loads config/match_overrides.json
    mirror.py        # incremental crawl + conditional downloads -> B2 raw/; politeness
    geopdf.py        # georef detect, DPI policy, translate/warp/neatline-crop/tile,
                     # bounds+zoom extraction, preview PNG render
    ir_vectors.py    # Shapefiles.zip -> merged GeoJSON (ogr2ogr, NAD83->4326)
    pyrecast.py      # caps fetch/parse for geoserver02 (full) and geoserver01
                     # (namespace probes); TIME extents; legend URL rewrite to proxy
    catalogs.py      # assemble + upload catalog.json / pyrecast_runs.json /
                     # weather_runs.json / per-fire incident manifests (upload order!)
    b2.py            # boto3 wrapper: put with Cache-Control + content-type, exists,
                     # batched tile upload (thread pool), prefix delete (pruning)
    state.py         # load/save state/state.json, per-incident checkpointing
    cli.py           # sync-catalogs | sync-incidents | backfill --fire X |
                     # tile --url PDFURL | prune | --dry-run everywhere (writes ./out/)
  config/match_overrides.json        # manual dir->fire pins / "ignore"
  tests/fixtures/                    # real sampled PDFs, autoindex HTML snapshots,
                                     # caps excerpts, elk IR zip
  tests/test_{matching,ftp_index,geopdf,pyrecast_parse}.py
```

## Job A — fire ↔ incident-dir matching

Inputs: active wildfires (slim fields incl. `unique_slug`, `unique_fire_id`); FTP year-roots from config: `{region}/2026/` where present, `pacific_nw/2026_Incidents_Oregon/`, `pacific_nw/2026_Incidents_Washington/`, probe `southern|eastern/{StateName}/2026/` tolerating 404. `products_dirname` detected at runtime (`Products/` or `GIS/`).

1. **Candidates**: dirs matching `^(?P<yr>\d{4})_(?P<name>.+)/$` with yr==2026, URL-decoded. Drop placeholders: name == `FireName` (ci) or `^z?FireName\d*$`. Record dir mtime from parent listing row.
2. **Deterministic key**: over newest 1–2 daily dirs in Products|GIS plus QR filenames, apply `_(?P<unit>[A-Z]{2}[A-Z0-9]{2,4})(?P<num>\d{6})(?=[_.])`. Candidate `f"2026-{unit}-{num}"` matched case-insensitively vs `unique_fire_id`. Majority token wins (operator typos). → `match_method: "unit_id"`, confidence 1.0.
3. **Fuzzy name fallback** (IR-only dirs have no token): dir side strip `^\d{4}_`, URL-decode, CamelCase-split (runs of ≥2 capitals/digits stay one token: `I5MM57NB`, `P-L`), `_`/`-`→space, lowercase, strip non-alnum. Fire side: `post_title` same normalize. Compare raw / trailing-`complex`-stripped / trailing-`fire`-stripped forms: exact → `name_exact` 0.95; else `rapidfuzz.ratio ≥ 90` → `name_fuzzy` ratio/100. **Constraint**: fire.state ∈ GACC allowed-states (config map: `rocky_mtn→{CO,WY,SD,NE,KS}`, `calif_n|calif_s→{CA}`, pacific_nw_oregon→{OR}, etc.). ≥2 ties → unmatched + match_report. Manual pins in `config/match_overrides.json` (`{"rocky_mtn/2026/2026_Elk": "<fire_slug>"}` or `"ignore"`). `unit_id` always beats name matches.
4. Matches cached in state; re-verified when dir gains first Products PDF or fire goes inactive.

## Job B — FTP mirror

Scope per matched active fire: `QR/` whole set incl. Avenza mobile (≤40 MB cap, never tiled — responders load these into Avenza); newest 3 `Products|GIS/YYYYMMDD/` dirs (skip `YYMMDD` templates/empties); newest 7 `IR/` dirs incl. `*_UTF_*` (mirror Read_Me.txt). Older dailies via `backfill --fire X --since YYYYMMDD`.

Change detection (indexes have no HTTP validators): compare listed child mtimes to state → skip unchanged subtrees with zero requests; per-file `{etag, last_modified, size}` in state → conditional GET (`If-None-Match`/`If-Modified-Since`); QR in-place overwrite → re-download + bump `rev`.

Politeness: UA `responder-debrief-mirror/1.0 (contact: pashaminkovsky@gmail.com)`; ≤2 concurrent listings, ≤4 downloads, ~1 rps listings; tenacity 3× exponential honoring 503; 35-min wall budget with per-incident checkpoints.

B2 keys (lowercase, spaces→`_`): `raw/incidents/{fire_slug}/products/{YYYYMMDD}/{filename}.pdf`, `.../qr/{filename}.pdf`, `.../ir/{YYYYMMDD}/{filename}`.

## Job C — GeoPDF processing

Per new/changed PDF (skip `mobile_*`/`Mobile_*`):
1. Detect: `gdalinfo -json --config GDAL_PDF_DPI 72` → georeferenced iff non-identity `geoTransform` + `coordinateSystem.wkt`. Multipage (pypdf count>1): page 1 only (`--config GDAL_PDF_PAGE 1`), flag `pages: N`.
2. DPI by sheet token (fallback: page size): 8x11/11x17→300; arch_c/d→200; arch_e→150.
3. `gdal_translate -of GTiff --config GDAL_PDF_DPI {dpi} in.pdf page.tif`; extract `NEATLINE` metadata (POLYGON WKT in map coords) → temp GeoJSON; `gdalwarp -t_srs EPSG:3857 -r bilinear -dstalpha -cutline neatline.json -crop_to_cutline page.tif merc.tif` (crops title-block collar; full sheet stays available as raw PDF + preview).
4. `gdal2tiles.py --xyz --profile=mercator -r bilinear -x -w none --processes=4 -z {zmin}-{zmax} merc.tif outdir/`; `zmax = clamp(floor(log2(156543 / native_res_m_per_px)), 10, 16)`, `zmin = zmax - 6`. Typical arch-E ≈ 500–900 PNGs, 15–30 MB.
5. Preview: `gdal_translate -of PNG -outsize 480 0` on un-cropped page → `previews/incidents/{fire_slug}/{id}.png` (all PDFs, geo or not).
6. Upload tiles to `tiles/incidents/{fire_slug}/{id}/{z}/{x}/{y}.png`, **id = sha256(pdf)[:16]** (content-addressed, immutable; QR overwrites mint new id). Record bounds [w,s,e,n 4326], minzoom, maxzoom in manifest.
7. Non-geo: raw + preview, `georeferenced: false`, no tiles.
8. Budget: 40 sheets/run, priority ops>brief>iap>airops>evac>trans>pio>other; rest `tiling_pending: true`. State records `tiled: {pdf_sha: tiler_version}`; re-tile only on `TILER_VERSION` bump. Failures degrade (warp-without-cutline → georeferenced:false), recorded in manifest `error`, never fatal.

IR: unzip `*_Shapefiles.zip` ignoring `*.lock`; per shapefile (`*_Perimeter|_Intense|_Scattered|_Isolated`) `ogr2ogr -f GeoJSON -t_srs EPSG:4326`, tag `heat_type` + `flight_id`, merge → `vectors/ir/{fire_slug}/{YYYYMMDD}_{flight}.geojson`; parse `Estimated Acreage:` from Read_Me.txt.

## Job D — pyrecast catalogs

**geoserver02**: hourly full caps GET (5.4 MB OK server-side) with `&updatesequence={last}` short-circuit (exception report = unchanged). `lxml.iterparse`, clear elements. Per workspace `fire-spread-forecast_{slug}_{YYYYMMDD_HHMMSS}`: bbox, native CRS, **verbatim TIME instant list once per run** (~169 instants, first minute-precision — never regenerate), per-product layer templates + legend URLs rewritten to proxy. Slug→fire: split state prefix, require == fire.state; strip trailing `-\d{4,6}` (cross-check vs unique_fire_id numeric part → confidence 1.0); exact slugified-name then rapidfuzz ≥90; unmatched → `unmatched_workspaces`.

**geoserver01**: never fetch 33 MB caps on schedule. Probe last 4 deterministic workspaces `fire-weather-forecast_hrrr_{YYYYMMDD_HH}`, HH∈{00,06,12,18} via `&namespace=` caps (~1–2 MB). Layer naming (verified): one layer per product per hour `{product}_{YYYYMMDD}_{HHMMSS}` (49 per product on long cycles) + bare `{product}` default. Emit newest complete run + one previous. Weekly full-caps parse (or all-probes-404) as drift detector.

## B2 layout, Cache-Control, atomicity

See plan.md §B2. Key points: bucket public, CORS `*` GET/HEAD+range; per-class Cache-Control set at upload (tiles/previews/vectors immutable 1y; raw products/ir 7d; raw qr 300s + `?v={rev}`; catalogs 60s must-revalidate; state private no-store). **Upload ordering = atomicity**: immutable assets → incident manifests → runs catalogs → `catalog.json` last (monotonic `version`); snapshots under `catalogs/versions/` (14-day lifecycle). `state/state.json` single-writer (GH concurrency groups), preferred over B2 lists.

State shape:
```json
{ "schema_version": 1, "updated_at": "…",
  "incidents": { "rocky_mtn/2026/2026_Elk": {
      "fire_slug": "elk", "match": {"method": "unit_id", "token": "COGMF000114", "confidence": 1.0},
      "dir_mtime": "2026-08-16 22:43",
      "children": {"Products": "…", "QR": "…", "IR": "…"},
      "files": {"products/20260816/ops_….pdf": {"etag": "\"71ac4-…\"", "lm": "…", "size": 10485760, "sha16": "a1b2…", "rev": 1}} } },
  "tiled": {"a1b2c3d4e5f6a7b8": {"tiler_version": 2, "at": "…"}},
  "pyrecast": {"gs02_update_sequence": "270882", "gs01_probed_runs": ["…"]},
  "prune": {"inactive_since": {"chute": "2026-08-10T…"}} }
```

## JSON contracts

Authoritative shapes in plan.md §Data contracts. Full examples:

`catalogs/catalog.json`:
```jsonc
{ "schema_version": 1, "version": 173, "generated_at": "2026-08-17T18:07:31Z",
  "wms_proxy": {"gs01": "/wms01", "gs02": "/wms02"},
  "fires": [{ "fire_slug": "big-grass", "cornea_id": "{6B0C72B3-…}", "unique_fire_id": "2026-ORVAD-000123",
    "name": "BIG GRASS", "coordinates": [-117.303363, 42.649806], "state": "OR",
    "acres": 578422, "containment": 71, "active": true,
    "last_updated": "…", "poly_last_updated": "…", "timezone": "America/Boise",
    "has_incident_maps": true, "incident_manifest": "/catalogs/incidents/big-grass.json",
    "incident_last_synced": "…",
    "ftp_match": {"method": "unit_id", "confidence": 1.0, "dir_url": "https://ftp.wildfire.gov/…/2026_BigGrass/"},
    "has_spread_forecast": true, "spread_latest_run": "2026-08-17T11:25:00Z" }],
  "counts": {"active_fires": 372, "matched_incident_dirs": 34, "spread_forecast_fires": 26} }
```

`catalogs/pyrecast_runs.json`:
```jsonc
{ "schema_version": 1, "generated_at": "…", "source": "geoserver02", "wms_proxy_path": "/wms02",
  "fires": { "big-grass": { "pyrecast_slug": "or-paradise",
    "runs": [{ "workspace": "fire-spread-forecast_or-paradise_20260817_112500",
      "run_time": "2026-08-17T11:25:00Z",
      "bbox": [-118.42345, 45.69707, -117.53805, 46.30738], "native_crs": "EPSG:32611",
      "percentiles": [10,30,50,70,90],
      "time_instants": ["2026-08-17T11:25:00.000Z", "2026-08-17T12:00:00.000Z", "…", "2026-08-24T11:00:00.000Z"],
      "products": {
        "spread-rate": {"timed": true, "layer_template": "{ws}:elmfire_landfire_{pct}_spread-rate", "legend_url": "…"},
        "flame-length": {"timed": true, "layer_template": "…", "legend_url": "…"},
        "crown-fire": {"timed": true, "layer_template": "…", "legend_url": "…"},
        "hours-since-burned": {"timed": true, "layer_template": "…", "legend_url": "…"},
        "time-of-arrival": {"timed": false, "layer_template": "…", "legend_url": "…"},
        "isochrones": {"timed": false, "layer_template": "…", "legend_url": "…", "vector": true} } }] } },
  "unmatched_workspaces": [{"workspace": "…", "slug": "mt-somefire", "run_time": "…", "bbox": []}] }
```

`catalogs/weather_runs.json`:
```jsonc
{ "schema_version": 1, "generated_at": "…", "source": "geoserver01", "wms_proxy_path": "/wms01",
  "models": { "hrrr": { "label": "HRRR",
    "products": { "tmpf": {"label": "Temperature (°F)"}, "rh": {"label": "Relative humidity"},
      "ws": {"label": "Wind speed"}, "wg": {"label": "Wind gust"}, "wd": {"label": "Wind direction"},
      "ffwi": {"label": "Fosberg fire wx index"}, "smoke": {"label": "Near-surface smoke"},
      "tcdc": {"label": "Cloud cover"}, "pign": {"label": "P(ignition)"}, "meq": {"label": "Fuel moisture eq."},
      "apcp01": {"label": "1-h precip"}, "apcptot": {"label": "Run-total precip"} },
    "runs": [{ "workspace": "fire-weather-forecast_hrrr_20260817_12", "run_time": "2026-08-17T12:00:00Z",
      "hours": ["2026-08-17T12:00:00Z", "…hourly…", "2026-08-19T12:00:00Z"],
      "layer_template": "{ws}:{product}_{YYYYMMDD}_{HHMMSS}",
      "default_layer_template": "{ws}:{product}",
      "legend_url_template": "/wms01?service=WMS&version=1.3.0&request=GetLegendGraphic&format=image/png&layer={ws}%3A{product}" }] } } }
```

`catalogs/incidents/{fire_slug}.json`:
```jsonc
{ "schema_version": 1, "fire_slug": "elk", "cornea_id": "…", "generated_at": "…",
  "source_dir": "https://ftp.wildfire.gov/public/incident_specific_maps/rocky_mtn/2026/2026_Elk/",
  "region": "rocky_mtn", "unit_incident": "COGMF000114",
  "maps": [{ "id": "a1b2c3d4e5f6a7b8", "kind": "product", "product": "ops", "product_label": "Operations Map",
    "sheet": "arch_e", "orientation": "port", "op_date": "2026-08-16", "period": "day",
    "generated_at_local": "2026-08-15T20:41",
    "filename": "ops_arch_e_port_20260815_2041_Elk_COGMF000114_816day.pdf",
    "pdf_url": "/raw/incidents/elk/products/20260816/ops_arch_e_port_20260815_2041_Elk_COGMF000114_816day.pdf",
    "size_bytes": 10485760, "georeferenced": true, "projection": "NAD_1983_UTM_Zone_13N",
    "preview_url": "/previews/incidents/elk/a1b2c3d4e5f6a7b8.png",
    "tiles": { "url_template": "/tiles/incidents/elk/a1b2c3d4e5f6a7b8/{z}/{x}/{y}.png",
      "minzoom": 9, "maxzoom": 15, "bounds": [-107.4018, 37.9984, -107.2424, 38.1621] },
    "tiling_pending": false, "rev": 1 }],
  "ir_flights": [{ "flight_date": "2026-08-17", "flight_id": "20260817_c0730_Aircraft3",
    "no_flight_reason": null, "geojson_url": "/vectors/ir/elk/20260817_c0730_Aircraft3.geojson",
    "heat_types": ["Perimeter","Intense","Scattered","Isolated"], "estimated_acres": 7373,
    "pdf_url": "…", "kmz_url": "…", "readme_url": "…" }] }
```

## WMS proxy (Cloudflare Worker) pseudocode

```
UPSTREAM = { wms01: "https://geoserver-usw1.pyrecast.org/geoserver01/ows",
             wms02: "https://geoserver-usw1.pyrecast.org/geoserver02/ows" }
ALLOWED_REQUEST = { getmap, getlegendgraphic, getfeatureinfo }        // NEVER GetCapabilities
ALLOWED_PARAMS  = { service, version, request, layers, query_layers, layer, styles,
                    crs, srs, bbox, width, height, format, transparent, time,
                    info_format, i, j, x, y, feature_count }          // drops sld/sld_body/env/viewparams
LAYER_RE  = /^[A-Za-z0-9_.:-]+$/
LAYER_NS  = [fire-spread-forecast_, fire-weather-forecast_, fire-risk-forecast_,
             fire-detections_, fuels-and-topography_]
FORMAT_OK = { image/png, image/jpeg, application/json }
width/height ≤ 2048

onRequestGet:
  validate service=WMS, request ∈ ALLOWED_REQUEST, params ⊆ allowlist,
    layer matches RE + NS prefix, dims, format → else 400
  canonical = sorted query; cacheKey = own-origin URL with canonical
  hit = caches.default.match(cacheKey) → return with x-proxy-cache: HIT + ACAO:*
  upstream fetch WITHOUT Origin/Cookie headers (passes pyrecast allowlist)
  !ok → 502 no-store + x-upstream-status (frontend run-rotation signal)
  content-type not image/* (except getfeatureinfo) → 502 no-store   // don't cache 200-XML ServiceException
  ttl: spread GetMap 604800; weather GetMap 259200; legend 86400; featureinfo 3600
  respond 200 {content-type, cache-control: public max-age=ttl,
    access-control-allow-origin: *, x-proxy-cache: MISS, x-upstream-flow-delay: <hdr>}
  waitUntil(cache.put)
  // never forward upstream Set-Cookie (GS_FLOW_CONTROL); do not serialize requests in v1
```

## GitHub Actions workflows

`catalogs.yml`: cron `7 * * * *` + workflow_dispatch; concurrency group `catalogs` no-cancel; timeout 15 min; checkout → setup-uv → `uv sync` → `uv run python -m responder_worker.cli sync-catalogs` with env `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET=responder-debrief-data`, `B2_S3_ENDPOINT` (vars).

`mirror.yml`: cron `25 1,7,13,19 * * *`; same shell + `sudo apt-get install -y --no-install-recommends gdal-bin`; `sync-incidents`, timeout 45 min, `TILE_BUDGET=40`; dispatch inputs `fire`/`since`/`force` → CLI flags.

`deploy-pages.yml`: on push to main touching frontend/ → build (`npm ci && npm run build`, `cp dist/index.html dist/404.html`) → `actions/upload-pages-artifact` + `actions/deploy-pages` (needs Pages enabled, `permissions: pages: write, id-token: write`).

`deploy-proxy.yml`: on push touching proxy/ → `wrangler deploy` with `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`.

## Costs/quotas

B2 ~13 GB steady ≈ $0.08/mo; uploads free; egress free to 3× stored/day (no domain yet). GH Actions ≈ 190 min/day — free on public repo only. Workers free 100k req/day; every /wms* request invokes the Worker even on cache hit; B2 assets never routed through it. CF Cache API free-plan eviction can be aggressive — acceptable (re-fetch).

## AWS HRRR fallback (v2 only)

See plan.md appendix. Module `hrrr.py`, cron `40 1,7,13,19 * * *`, idx-driven byte-range GETs of GUST/TMP/RH/MASSDEN(×1e9)/UGRD/VGRD/APCP-1h-window/COLMD (~11.5 MB/hr), `gdalwarp` LCC→3857 (never corner-pin), cornea ramps → paletted PNGs + U/V JSON grid → `weather/hrrr/{run}/…` + manifest-last to B2.
