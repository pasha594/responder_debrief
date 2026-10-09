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
                     # batched tile upload (thread pool), listings, exact-key
                     # deletes (prune only), read-only / recording wrappers
    state.py         # load/save state/state.json, per-incident checkpointing
    asset_keys.py    # every incident key, from state (prefix stamps), never a slug
    asset_locate.py  # LIST raw/previews/tiles/vectors once; locate rules shared by
                     # the migration and the key audit
    audit_keys.py    # audit-incident-keys: report | repair (state only) | refetch
    prune.py         # prune by fire key: report, or CLI-only --days N --confirm
    cli.py           # sync-catalogs | sync-incidents | backfill --fire X |
                     # tile-worker | prune | migrate-incident-ids |
                     # audit-incident-keys | reassign-files | restore-state-backup |
                     # --dry-run everywhere (writes ./out/)
  config/match_overrides.json        # manual dir->fire pins / "ignore"
  tests/fixtures/                    # real sampled PDFs, autoindex HTML snapshots,
                                     # caps excerpts, elk IR zip
  tests/test_{matching,ftp_index,geopdf,pyrecast_parse}.py
```

## Job A — fire ↔ incident-dir matching

Inputs: active wildfires (slim fields incl. `unique_slug`, `unique_fire_id`); FTP year-roots from config: `{region}/2026/` where present, `pacific_nw/2026_Incidents_Oregon/`, `pacific_nw/2026_Incidents_Washington/`, probe `southern|eastern/{StateName}/2026/` tolerating 404. `products_dirname` detected at runtime (`Products/` or `GIS/`).

1. **Candidates**: dirs matching `^(?P<yr>\d{4})_(?P<name>.+)/$` with yr==2026, URL-decoded. Drop placeholders: name == `FireName` (ci) or `^z?FireName\d*$`. Record dir mtime from parent listing row.
2. **Deterministic key**: over newest 1–2 daily dirs in Products|GIS plus QR filenames, apply `_(?P<unit>[A-Z]{2}[A-Z0-9]{2,4})(?P<num>\d{6})(?=[_.])`. Candidate `f"2026-{unit}-{num}"` matched case-insensitively vs `unique_fire_id`. Majority token wins (operator typos). → `match_method: "unit_id"`, confidence 1.0.
3. **Fuzzy name fallback** (IR-only dirs have no token): dir side strip `^\d{4}_`, URL-decode, CamelCase-split (runs of ≥2 capitals/digits stay one token: `I5MM57NB`, `P-L`), `_`/`-`→space, lowercase, strip non-alnum. Fire side: `post_title` same normalize. Compare raw / trailing-`complex`-stripped / trailing-`fire`-stripped forms: exact → `name_exact` 0.95; else `rapidfuzz.ratio ≥ 90` → `name_fuzzy` ratio/100. **Constraint**: fire.state ∈ GACC allowed-states (config map: `rocky_mtn→{CO,WY,SD,NE,KS}`, `calif_n|calif_s→{CA}`, pacific_nw_oregon→{OR}, etc.). ≥2 ties → unmatched + match_report. Manual pins in `config/match_overrides.json`: `{"rocky_mtn/2026/2026_Elk": "<cornea_id>"}` (the fire's GUID, braces and case optional) or `"ignore"`. A fire slug is refused (names are shared between fires), as is a GUID naming no active fire; either leaves the folder untouched and is reported in mirror health `override_errors`. Per-file corrections go through `maint.yml` `reassign-files`. `unit_id` always beats name matches. A folder bound by unit token is never re-bound by a name (`rebind_refused`). When its newest dailies carry no token and its name matches its own fire, it keeps its `unit_id` match. A unit token that two active fires share counts only for the fire the folder is already bound to. A name match that would move a folder onto a fire (a bind, a rebind, or matching a once-ignored folder) gets the same date check as a cached one, against the folder's own newest map upload, so a folder detached by that check stays detached.
4. Each folder's record is bound to a fire by `cornea_id`. Identity is always compared through `fire_key(cornea_id)` (lowercased, braces dropped); `fire_slug` is only a name. A folder whose root mtime changed is matched again; a match to another fire re-binds it, and the old fire keeps the files whose names prove it (unit token, then fire name, weighed only between the two fires) plus, when it was bound by ID, the files that prove neither. The rebuilt manifests of both fires reflect the split. Cached name matches are re-checked against the date rule every run.

## Job B — FTP mirror

Scope per matched active fire: `QR/` whole set incl. Avenza mobile (≤40 MB cap, never tiled — responders load these into Avenza); newest 3 `Products|GIS/YYYYMMDD/` dirs (skip `YYMMDD` templates/empties); newest 7 `IR/` dirs incl. `*_UTF_*` (mirror Read_Me.txt). Older dailies via `backfill --fire X --since YYYYMMDD`.

Change detection (indexes have no HTTP validators): compare listed child mtimes to state → skip unchanged subtrees with zero requests; per-file `{etag, last_modified, size}` in state → conditional GET (`If-None-Match`/`If-Modified-Since`); QR in-place overwrite → re-download + bump `rev`. A child's mtime (`children[name]`) is stamped only when no file in it was deferred by the wall-clock budget, so a cut-short subtree is listed again next run; the folder's own `dir_mtime` and `synced_at` are always written. An incident with no Products/GIS/QR/IR (dated dirs at its root) stamps each dated dir the same way. A folder of an active fire whose root mtime is unchanged is still listed every run under its binding, with no re-match: a new daily dir one level down (`Products/20261008`) does not touch the root's mtime. Its fires' manifests are rebuilt only when that brought a download or re-listed a child (mirror health `refreshed`).

Politeness: UA `responder-debrief-mirror/1.0 (contact: pashaminkovsky@gmail.com)`; ≤2 concurrent listings, ≤4 downloads, ~1 rps listings; tenacity 3× exponential honoring 503; 35-min wall budget with per-incident checkpoints.

B2 keys (spaces→`_`): `raw/incidents/{prefix}/products/{YYYYMMDD}/{filename}.pdf`, `.../qr/{filename}.pdf`, `.../ir/{YYYYMMDD}/{filename}`. Every key is built in `asset_keys.py` from the record, never from a fire's slug:

- Each incident folder's record has its own `storage_prefix`, set once and never changed: where its **new** bytes go. A new record gets its fire key, or `{fire_key}-{sha1(incident_key)[:6]}` when another record already uses that prefix or still holds stamped files under it. The migration kept each record's old slug as its prefix; where several records shared one slug, one kept it and the others moved to prefixes of their own. `fire_slug` equals `storage_prefix` from then on and is never written again.
- A raw file whose bytes sit under another prefix carries `files[rel].prefix` (stamped by the migration from a LIST match whose bytes hashed to the file's `sha16`, or left by a prefix split). A new revision is written under the record's `storage_prefix` and drops the stamp. The one exception is the keeper of a split prefix: if another record's stamped bytes are at the key the revision would go to, it is not written and the record keeps its old entry. Mirror health reports it as `raw_key_collisions`, and the subtree is listed again every run until an operator resolves it.
- A file is shown on the fire its folder is bound to, unless it carries an owner stamp `files[rel].fk` (another fire's key, or null = shown on no fire) with its provenance `fk_src`: `token`, `name` or `manual` (evidence from the file name, or `reassign-files`), else `location`, `prior` or `hidden`. A new revision keeps an evidence stamp and drops any other.

## Job C — GeoPDF processing

Per new/changed PDF (skip `mobile_*`/`Mobile_*`):
1. Detect: `gdalinfo -json --config GDAL_PDF_DPI 72` → georeferenced iff non-identity `geoTransform` + `coordinateSystem.wkt`. Multipage (pypdf count>1): page 1 only (`--config GDAL_PDF_PAGE 1`), flag `pages: N`.
2. DPI by sheet token (fallback: page size): 8x11/11x17→300; arch_c/d→200; arch_e→150.
3. `gdal_translate -of GTiff --config GDAL_PDF_DPI {dpi} in.pdf page.tif`; extract `NEATLINE` metadata (POLYGON WKT in map coords) → temp GeoJSON; `gdalwarp -t_srs EPSG:3857 -r bilinear -dstalpha -cutline neatline.json -crop_to_cutline page.tif merc.tif` (crops title-block collar; full sheet stays available as raw PDF + preview).
4. `gdal2tiles.py --xyz --profile=mercator -r bilinear -x -w none --processes=4 -z {zmin}-{zmax} merc.tif outdir/`; `zmax = clamp(floor(log2(156543 / native_res_m_per_px)), 10, 16)`, `zmin = zmax - 6`. Typical arch-E ≈ 500–900 PNGs, 15–30 MB.
5. Preview: `gdal_translate -of PNG -outsize 480 0` on un-cropped page → `previews/incidents/{preview_prefix}/{id}.png` (all PDFs, geo or not).
6. Upload tiles to `tiles/incidents/{tiles_prefix}/{id}/{z}/{x}/{y}.png`, **id = sha256(pdf)[:16]** (content-addressed, immutable; QR overwrites mint new id). A sha is tiled once wherever it appears, under `tiled[id].prefix`: the prefix its tiles were first written under (or that the migration found them under), which every later writer keeps; the preview is under `tiled[id].preview_prefix` when that differs, else the same prefix. Bytes downloaded back from B2 (tile worker, backlogs, IR) are tiled only when they hash to the sha. Record bounds [w,s,e,n 4326], minzoom, maxzoom in manifest.
7. Non-geo: raw + preview, `georeferenced: false`, no tiles.
8. Budget: 40 sheets/run, priority ops>brief>iap>airops>evac>trans>pio>other; rest `tiling_pending: true`. State records `tiled[sha16] = {tiler_version, at, geo: {georeferenced, projection, tiles: {minzoom, maxzoom, bounds} | null, preview, error?}, prefix, preview_prefix?, repair_at?, grat_at?, needs_preview?}`; `tiler_version: null` on a georeferenced sheet means tiles are still owed (the backlog and the tile worker pick it up). `needs_preview: true` (set by the key audit when a sheet's preview is on the bucket nowhere) sends it through the probe backlog's preview-only pass: the raw bytes are downloaded and hash-checked, the preview is rendered and PUT only where no preview is yet, and the entry keeps its tiles, `tiler_version` and prefixes. A `TILER_VERSION` bump re-tiles a sheet only when the mirror downloads it again, over the same `tiles/incidents/{prefix}/{id}/` keys. Failures degrade (warp-without-cutline → georeferenced:false), recorded in manifest `error`, never fatal.

IR: unzip `*_Shapefiles.zip` ignoring `*.lock`; per shapefile (`*_Perimeter|_Intense|_Scattered|_Isolated|_Cloud_Cover`) `ogr2ogr -f GeoJSON -t_srs EPSG:4326`, tag `heat_type` + `flight_id`, merge → `vectors/ir/{prefix}/{src_sha16}.v{IR_CONVERTER_VERSION}.geojson` (content-addressed by the source file and versioned, so a key is never rewritten; the record's `ir_keys[src_rel] = {key, flight_id, src_sha16}` names the conversion of each source, valid while the source has those bytes; conversions from before the migration keep their `vectors/ir/{slug}/{flight}.geojson` key where the migration could prove which source made them); parse `Estimated Acreage:` from Read_Me.txt. KMZ-only flights convert from the KMZ: ArcGIS exports carry one KML folder per heat class; NIROPS KMZs have no folders, one named placemark per class ("Heat Perimeter", "Intense Heat", "Scattered Heat", "Isolated Heat", "Possible Heat", "Imagery Obscured" or "Cloud AOI" + "NoData"), empty when a class has nothing, and flat comma-only coordinate lists that only LIBKML reads (the plain-KML fallback regroups them). Classes: Perimeter, Intense, Scattered, Isolated, Possible (unconfirmed heat), Obscured (imagery the sensor couldn't see through). Flight time comes from the KMZ even when shapefiles are converted: NIROPS `Image Acquisition Date/Time` (local clock + zone) or ArcGIS `Production` + `Time_UTC` attributes → `flown_at` (UTC), or `flown_date` when only a date is given; the UI falls back to `flight_date` (the FTP folder). A flight is built per owning fire from the files that fire owns in the flight folder, preferring sources whose names name it; in a folder flown for several fires where no source names the owner, the flight shows no vectors (mirror health `ir_mixed_hidden`). Results and failures cache in `state["ir"][key]` under `IR_CONVERTER_VERSION`; a failure under the current version is not retried, and a bump converts every flight again, from source bytes that hash to their sha, into new keys.

## Job D — pyrecast catalogs

**geoserver02**: hourly full caps GET (5.4 MB OK server-side) with `&updatesequence={last}` short-circuit (exception report = unchanged). `lxml.iterparse`, clear elements. Per workspace `fire-spread-forecast_{slug}_{YYYYMMDD_HHMMSS}`: bbox, native CRS, **verbatim TIME instant list once per run** (~169 instants, first minute-precision — never regenerate), per-product layer templates + legend URLs rewritten to proxy. Slug→fire: split state prefix, require == fire.state; strip trailing `-\d{4,6}` (cross-check vs unique_fire_id numeric part → confidence 1.0); exact slugified-name then rapidfuzz ≥90; unmatched → `unmatched_workspaces`.

**geoserver01**: never fetch 33 MB caps on schedule. Probe last 4 deterministic workspaces `fire-weather-forecast_hrrr_{YYYYMMDD_HH}`, HH∈{00,06,12,18} via `&namespace=` caps (~1–2 MB). Layer naming (verified): one layer per product per hour `{product}_{YYYYMMDD}_{HHMMSS}` (49 per product on long cycles) + bare `{product}` default. Emit newest complete run + one previous. Weekly full-caps parse (or all-probes-404) as drift detector.

## B2 layout, Cache-Control, atomicity

See plan.md §B2. Key points: bucket public, CORS `*` GET/HEAD+range; per-class Cache-Control set at upload (tiles/previews/vectors immutable 1y; raw products/ir 7d; raw qr 300s + `?v={rev}`; catalogs, incident manifests included, 60s must-revalidate; `catalogs/versions/` 1y; state `private, no-store`, which is a caching directive only: `state/` is as readable as the rest of the public bucket, its backups included). **Upload ordering = atomicity**: raw, tiles, previews, IR vectors → each fire's ID manifest, then its `incident_fires` entry → state → `catalogs/versions/catalog.{N}.json` → `catalog.json` last (monotonic `version`). Nothing deletes the version snapshots, and they must not expire: the fire-ID migration reads catalog history back to version 6 (check that the bucket has no lifecycle rule on `catalogs/versions/` before migrating). `state/state.json` single-writer (the `worker-b2-writes` concurrency group), preferred over B2 lists.

State shape (fields of the fire-ID records; all optional, and `load_state` keeps whatever it does not know):
```jsonc
{ "schema_version": 1, "updated_at": "…", "catalog_version": 845,
  "migrations": { "incident_ids": "…",                       // set by migrate-incident-ids --apply; gates everything below
                  "incident_keys_audit": "…",                // set by audit-incident-keys --repair; prune --confirm needs it
                  "slugs_at_migration": {"<incident_key>": "<fire_slug before>"},
                  "backup": "state/backups/state.pre-incident-ids.<ts>.json" },
  "incident_fires": { "<fire_key>": {                       // one per active fire fed by incident folders
      "v": 1, "cornea_id": "{…}", "manifest": "catalogs/incidents/id/<fire_key>.json",
      "dirs": ["<incident_key>", …], "primary": "<incident_key>", "method": "unit_id", "confidence": 1.0,
      "dir_url": "…", "synced_at": "…", "built_at": "…",
      "counts": {"maps": 63, "ir": 2, "latest_upload": "YYYY-MM-DD", "latest_upload_ts": "…"} } },
  "incidents": { "rocky_mtn/2026/2026_Elk": {
      "fire_slug": "elk", "storage_prefix": "elk",            // equal; set once
      "cornea_id": "{…}",
      "match": {"method": "unit_id|name_exact|name_fuzzy|override", "confidence": 1.0, "token": "2026-COGMF-000114",
                "dir_url": "…", "cornea_id": "{…}"},              // null = detached by the date check, or ignored
      "bound": {"uid": "2026-COGMF-000114", "name": null, "method": "unit_id"},
                                                                  // the binding's evidence; name null under 4 letters
      "match_rejected": {"cornea_id", "method", "reason", "at"},
      "id_unresolved": {"reason", "candidate", "prior_match", "at"},   // the migration could not prove the fire
      "ignored": true, "override": "<GUID>|ignore", "reattached_at": "…",
      "rebound_from": [{"cornea_id", "uid", "name", "method", "at", "source": "sync|migration"}],
      "region": "rocky_mtn", "dir_url": "…", "dir_mtime": "2026-08-16 22:43", "synced_at": "…",
      "children": {"Products": "…", "QR": "…", "IR": "…"},   // or the root's dated dirs
      "ir_keys": {"ir/20260817/…_Shapefiles.zip": {"key": "vectors/ir/…", "flight_id": "…", "src_sha16": "…"}},
      "files": {"products/20260816/ops_….pdf": {"etag": "\"71ac4-…\"", "lm": "…", "size": 10485760,
          "sha16": "a1b2…", "rev": 1, "kind": "product", "url": "…", "first_seen": "…",
          "prefix": "austin",                                   // bytes under another prefix
          "fk": "<fire_key>|null", "fk_src": "token|name|manual|location|prior|hidden",
          "missing": "…",                                       // key audit: bytes found nowhere (since)
          "pruned_at": "…"}} } },                               // prune deleted the bytes; never fetched again
          // legacy, frozen, unread: map_count, ir_count, latest_upload*, ir_manifest_v
  "tiled": {"a1b2c3d4e5f6a7b8": {"tiler_version": 1, "at": "…", "geo": {…}, "prefix": "elk", "preview_prefix": "…",
                                  "needs_preview": true}},  // key audit: preview found nowhere
  "ir": {"vectors/ir/…": {"v": 3, "heat_types": ["Perimeter", …], "flown_at": "…", "flown_date": null} | {"v": 3, "failed": true}},
  "prune": {"inactive_since": {},                             // legacy, unused
            "inactive_since_by_id": {"<fire_key>": "…"}, "last_seen_active": {"<fire_key>": "…"}} }
```

A file shows on no fire while its record is unresolved or ignored, or once it is `pruned_at`. A fresh deployment (no `state/state.json`, or no incident records) starts with `migrations.incident_ids` set. Until that flag is set, sync-incidents publishes a mirror health failure ("paused: awaiting incident-ID migration") and writes nothing else.

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
    "has_incident_maps": true,
    "incident_manifest": "/catalogs/incidents/id/6b0c72b3-….json",   // the fire's own fire_key; never another fire's
    "incident_last_synced": "…", "incident_map_count": 63, "incident_ir_count": 2,
    "incident_latest_upload": "2026-08-17", "incident_latest_upload_ts": "…",
    "ftp_match": {"method": "unit_id", "confidence": 1.0, "dir_url": "https://ftp.wildfire.gov/…/2026_BigGrass/"},   // the primary folder's
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

`catalogs/incidents/id/{fire_key}.json` (one per active fire fed by incident folders, mutable, 60 s must-revalidate; it lists only the files that fire owns, from every folder feeding it; the slug-keyed `catalogs/incidents/{fire_slug}.json` is no longer written once migrated):
```jsonc
{ "schema_version": 1, "fire_slug": "elk", "fire_key": "1f0c…", "cornea_id": "{1F0C…}", "generated_at": "…",
  "source_dir": "https://ftp.wildfire.gov/public/incident_specific_maps/rocky_mtn/2026/2026_Elk/",   // the primary folder's
  "region": "rocky_mtn", "unit_incident": "COGMF000114",
  "sources": [{ "dir_url": "…/2026_Elk/", "region": "rocky_mtn", "unit_incident": "COGMF000114", "method": "unit_id" },
              { "dir_url": "…/2026_ElkComplex/", "region": "rocky_mtn", "unit_incident": null, "method": null }],
              // method/unit_incident null: the folder is bound to another fire and only lends this one files
  "maps": [{ "id": "a1b2c3d4e5f6a7b8", "kind": "product", "product": "ops", "product_label": "Operations Map",
    "sheet": "arch_e", "orientation": "port", "op_date": "2026-08-16", "period": "day",
    "generated_at_local": "2026-08-15T20:41",
    "filename": "ops_arch_e_port_20260815_2041_Elk_COGMF000114_816day.pdf",
    "pdf_url": "/raw/incidents/elk/products/20260816/ops_arch_e_port_20260815_2041_Elk_COGMF000114_816day.pdf",   // raw key: where the bytes are
    "size_bytes": 10485760, "georeferenced": true, "projection": "NAD_1983_UTM_Zone_13N",
    "preview_url": "/previews/incidents/elk/a1b2c3d4e5f6a7b8.png",
    "tiles": { "url_template": "/tiles/incidents/elk/a1b2c3d4e5f6a7b8/{z}/{x}/{y}.png",
      "minzoom": 9, "maxzoom": 15, "bounds": [-107.4018, 37.9984, -107.2424, 38.1621] },
    "tiling_pending": false, "rev": 1 }],
  "ir_flights": [{ "flight_date": "2026-08-17", "flown_at": "2026-08-17T07:30:00Z", "flown_date": null,
    "flight_id": "20260817_c0730_Aircraft3",
    "no_flight_reason": null, "geojson_url": "/vectors/ir/elk/0c4d…e9.v3.geojson",
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

`catalogs.yml`: cron `7 * * * *` + workflow_dispatch; concurrency group `worker-b2-writes` no-cancel (shared by every job that writes `state/state.json` or `catalog.json`); timeout 30 min; checkout → setup-uv → `uv sync` → non-fatal `sudo apt-get install -y --no-install-recommends gdal-bin python3-gdal poppler-utils` (only the HRRR weather frames need GDAL) → `uv run python -m responder_worker.cli sync-catalogs` with env `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET=responder-debrief-data`, `B2_S3_ENDPOINT` (vars).

`mirror.yml`: cron `41 * * * *`, group `worker-b2-writes`; same shell + `sudo apt-get install -y --no-install-recommends gdal-bin python3-gdal poppler-utils`; `sync-incidents`, timeout 45 min, `TILE_BUDGET=40`; dispatch inputs `fire` (fire slug or fire key) / `since` / `force` / `products_keep` / `ir_keep` → CLI flags (`--fire`, `--since`, `--force`, `--products-keep`, `--ir-keep`; the last two only when set). A catch-up run after a pause: `since` = the first missed day, plus larger `products_keep`/`ir_keep` when the pause crossed a UTC midnight.

`maint.yml`: workflow_dispatch only, group `worker-b2-writes` (waits for any writer in flight; queuing another writer cancels a maint run still pending, so confirm it completed), timeout 60 min, `permissions: contents: read, actions: read`, no GDAL. Inputs `command`, `mode` (`report`, the default, writes nothing; `apply` writes), `expect_run_id`, `key`/`rel`/`to`, `days`, `refetch_missing`. Every run passes `--report-out report.json` and uploads `report.json` + the log as artifact `report` (30 days).
- `migrate-incident-ids`: report computes the whole fire-ID migration against a recording bucket and writes only the report. Apply needs `expect_run_id` (a report run, whose artifact it downloads) and the fire-ID sync code; it runs the same steps, aborts before any write unless every guard passes and the results reproduce the expected report, then writes a backup of the unmodified state (`state/backups/state.pre-incident-ids.<ts>.json`), the ID manifests, state, the next catalog version and `catalog.json`. Once the flag is set, apply does nothing.
- `reassign-files` (`key`, `rel` regex over the folder's file paths, `to` = a fire GUID | `binding` | `hidden`): state only; stamps `fk_src: "manual"` (`binding` drops the stamp) and marks every affected fire's index entry stale (`v: 0`), so the next mirror run rebuilds it.
- `restore-state-backup`: apply only; the rollback. Copies `migrations.backup` over `state/state.json` after checking that it parses and carries no migration flag.
- `audit-incident-keys` (input `refetch_missing`, boolean, passed only in apply mode): checks every key state names against one LIST of `raw/incidents/`, `previews/incidents/`, `tiles/incidents/` and `vectors/ir/` (`asset_locate`, the migration's locate rules). Report mode reads through a read-only bucket and lists: raw files not at their key, with the copy under another prefix whose bytes hash to the file's `sha16`; shas whose tiles or preview are not where their stamps point, with the copies listed elsewhere; every URL of every published ID manifest that names no object; failed IR conversions (and whether their source now resolves), conversions and `ir_keys` with no object; files of different folders at one raw key with other sizes or bytes; files whose unit token or name points at a third fire (`id_suspect`, `name_suspect`); records whose `fire_slug` is not their `storage_prefix`; raw files at their key with another size. Apply (`--repair`) edits state only: it stamps the hash-verified locations (and a sha's tiles or preview to the copy found, preferring the one live manifests link), marks raw files found nowhere `missing` (and clears the mark when they are back), sets `needs_preview` on a preview found nowhere and `tiler_version: null` on tiles found nowhere, drops failed IR entries whose key has no object (the next mirror run converts the source again), restores `heat_types` from the object of a failed entry that has one, drops conversions and `ir_keys` stamps whose object is gone (the source converts into a new key), marks every fire it touched stale (`incident_fires[fk].v = 0`) and sets `migrations.incident_keys_audit`. `refetch_missing` (`--refetch-missing`) then GETs every `missing` file from its FTP URL with no conditional headers: bytes that hash to its `sha16` are written to its `new_raw_key` only when nothing is at that key (then `prefix` and `missing` are dropped); other bytes are reported `revised_upstream` (the next mirror run takes them as a new revision), a 404 `unrecoverable`, an occupied key `key_occupied`. The audit never deletes or copies an object.
- `prune` (`days`): report only here; the workflow fails apply mode. See below.

`prune` (cli.py → prune.py) works by fire key and keeps everything by default (policy: FTP-derived incident data is kept indefinitely). `--report` (the default) writes nothing and lists exactly the keys `--confirm` would delete, with byte totals, plus every fire on the inactivity clock. Without `--days` it lists only the clock. The clock is kept hourly by sync-catalogs: `last_seen_active[fk]` for every fire on the active list, `inactive_since_by_id[fk]` set the first hour a fire that incident files show on is missing from it and cleared when it returns; an hour whose list may be partial (the API returned 500 rows, or under 80% of the previous catalog's active fires) is skipped. A file is doomed only when the fire it shows on is not on today's list, its clock is older than `--days`, and its folder's own newest upload (as the date check reads it) and last sync are both older too. Unresolved and ignored folders and files shown on no fire are never doomed. Every key a surviving file still needs is kept: its raw key, everything of its sha, its `ir_keys` conversions, and for an IR flight never stamped every conversion under its file locations. The rest goes, by exact key (a sheet's tile tree is listed and deleted key by key; never a prefix): the ID manifest of a fire left with nothing (its index entry is dropped), a legacy `catalogs/incidents/{slug}.json` only when its `cornea_id` is that fire's, the doomed flights' conversions (stamped, or recomputed legacy keys), previews and tiles of shas no survivor holds, then raw keys. Doomed files keep their entries, marked `pruned_at` (the mirror never fetches them, the backlogs and manifests skip them); a folder leaves state only when every file is doomed and so is the fire it is bound to. State is saved after the deletes, so a run that fails part-way is run again. `--confirm` needs `--days` (at least 1), both migration flags (`incident_ids`, `incident_keys_audit`) and a sane active-fire list, and is CLI-only: `gh workflow disable` mirror.yml, tile.yml and catalogs.yml first, wait for their runs in flight to finish, and re-enable them after.

`deploy-pages.yml`: on push to main touching frontend/ → build (`npm ci && npm run build`, `cp dist/index.html dist/404.html`) → `actions/upload-pages-artifact` + `actions/deploy-pages` (needs Pages enabled, `permissions: pages: write, id-token: write`).

`deploy-proxy.yml`: on push touching proxy/ → `wrangler deploy` with `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`.

## Costs/quotas

B2 ~13 GB steady ≈ $0.08/mo; uploads free; egress free to 3× stored/day (no domain yet). GH Actions ≈ 190 min/day — free on public repo only. Workers free 100k req/day; every /wms* request invokes the Worker even on cache hit; B2 assets never routed through it. CF Cache API free-plan eviction can be aggressive — acceptable (re-fetch).

## AWS HRRR fallback (v2 only)

See plan.md appendix. Module `hrrr.py`, cron `40 1,7,13,19 * * *`, idx-driven byte-range GETs of GUST/TMP/RH/MASSDEN(×1e9)/UGRD/VGRD/APCP-1h-window/COLMD (~11.5 MB/hr), `gdalwarp` LCC→3857 (never corner-pin), cornea ramps → paletted PNGs + U/V JSON grid → `weather/hrrr/{run}/…` + manifest-last to B2.
