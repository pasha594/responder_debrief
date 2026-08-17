# Responder Debrief — Implementation Plan

## Context

Fire professionals and hotshots need to get up to speed on a wildfire before deployment. Today that means stitching together NIFC/CalFire data, pyrecast forecasts, FTP'd incident maps, and weather sites. **Responder Debrief** is a map-centric web app that unifies them: a USA map of active fires (pins, perimeters, hotspots), per-fire detail with spread forecasts and multi-select weather layers, a timeline that scrubs from fire history into the forecast future, and geo-aligned incident-map PDF overlays. Goal: a lightweight hosted prototype to start collecting user feedback.

**Design references:** fires.cornea.is (colors/typography/fire styling — exact tokens extracted from their CSS/bundles), Windy (bottom timeline scrubber, layer rail, model dropdown).

## Decisions made with user

- **Stack**: Static frontend (Vite + React + TS + MapLibre GL JS) + separate cron worker writing processed data to Backblaze B2.
- **Hosting**: GitHub ecosystem as much as possible — **GitHub Pages** (frontend), **GitHub Actions** (cron worker + deploys), **public repo** (free Actions minutes). No custom domain: B2 assets served via raw `https://fNNN.backblazeb2.com/file/...` URLs (catalogs store relative paths + configurable `DATA_BASE_URL`). The one non-GitHub piece: a single free **Cloudflare Worker** on `*.workers.dev` as the WMS caching proxy (GitHub has no serverless HTTP runtime, and pyrecast hard-403s every browser origin except pyrecast.org — a proxy is unavoidable).
- **Weather source (v1)**: pyrecast geoserver01 `fire-weather-forecast_hrrr_*` WMS layers. Own AWS-HRRR GRIB pipeline documented as fallback only (appendix).
- **Weather rendering**: raster overlays + legends (no particle animation in v1).
- **FTP mirroring**: active incidents only, 4×/day; backfill on demand.
- **Devices**: responsive, desktop-first.

## Verified data-source facts (live research, 2026-08-17)

### Fire API — `https://fire-api-prod.web.app` (browser-callable: CORS `*`, no auth)
- `GET /fires?active=true&limit=500&fields=...` → all ~395 active fires, one 125 KB page. `fire_coordinates` is a `"lat, lon"` **string** (parse!). `cornea_id` = braced IRWIN GUID (NIFC) or bare UUID (CalFire).
- `GET /fires/{cornea_id}` → detail (~27 KB): acres, containment, personnel, AI `latest_summary` markdown + citations, `inciweb`, `structure_exposure` (1/3/5-mi buffers), `unique_fire_id` (e.g. `2026-COGMF-000114` — the FTP join key), `unique_slug`, `timezone` (IANA).
- `GET /fires/{id}/perimeters` → `[{path, date}]` version index (version = poly_DateCurrent epoch **ms**). Fetch each version via `path` **verbatim** (CalFire indexes mix two storage keys — reconstruction 404s). Versioned perimeter GeoJSON Features are `cache-control: max-age=31536000, public` → cache forever. Large fire ≈ 2 MB/version, 68 versions observed.
- `GET /hotspots?bbox=min_lat,min_lon,max_lat,max_lon` (**LAT-FIRST**) `&since=YYYY-MM-DD&limit=` (cap 50000) → GeoJSON Points {source: MODIS/SNPP/NOAA-20/NOAA-21, acq_date, acq_time, frp, confidence (mixed numeric/letter vocab)}. No `since` ≈ 7-day window; server cache 300 s. Full-history worst case 35k features / 8.8 MB.
- Never call `/perimeters?state=` from the browser (10.6 MB for OR). Extras: `/state_summaries`, `/states/{abbrev}`, `/fires/count`, `/weather/meta` (cornea's HRRR smoke/wind textures — stretch for wind particles later).

### Pyrecast — `https://geoserver-usw1.pyrecast.org`
- **geoserver02** (spread): workspaces `fire-spread-forecast_{state-slug}_{YYYYMMDD_HHMMSS}` (38 runs / 26 fires observed; **ephemeral, ~3 days**). Per run: percentiles {10,30,50,70,90} × {crown-fire, flame-length, hours-since-burned, spread-rate — TIME-enabled hourly ISO list, run-start→+7d (~169 instants, **first instant has minute precision**); time-of-arrival, isochrones — static}.
- **geoserver01** (weather+detections): `fire-weather-forecast_hrrr_{YYYYMMDD_HH}` per cycle (00/06/12/18z), products `tmpf, rh, ws, wg, wd, ffwi, smoke, tcdc, pign, meq, apcp01, apcptot` — **one layer per product per forecast hour** named `{product}_{YYYYMMDD}_{HHMMSS}` (49 hourly layers per product on long cycles) plus bare `{product}` default layer. Also `fire-detections_current-year-perimeters` (national perimeter raster), GOES, `fire-risk-forecast_*`, `fuels-and-topography_*`.
- **CORS hard allowlist** — every origin except `https://pyrecast.org` gets 403 (verified incl. localhost). GetMap is `cache-control: private`. → proxy required, proxy adds caching.
- **WMTS silently ignores TIME** (verified identical tile MD5s) → all timeline frames via WMS GetMap `time=`. GetLegendGraphic returns full ~249×278 ramp regardless of requested size. GetFeatureInfo JSON works. WFS reprojection broken (native UTM only).
- Caps are 5.4 MB (gs02) / 33 MB (gs01) — parsed only by the worker; `&namespace=` filter → ~330 KB–2 MB; `&updatesequence=` short-circuits unchanged caps.

### FTP — `https://ftp.wildfire.gov/public/incident_specific_maps/` (no CORS → server-side only)
- 11 GACC dirs → `{region}/2026/{YYYY_FireName}/{Products|GIS, QR, IR}/`; pacific_nw splits `2026_Incidents_Oregon|Washington` and uses `GIS/`. ~240 real incidents in 2026 (filter `2026_FireName`, `zFireName*`, `YYMMDD` template dirs).
- PDF names: `{product}_{sheet}_{orient}_{YYYYMMDD}_{HHmm}_{FireName}_{UnitID+IncidentNum}_{MMDD}day.pdf`; product vocab: ops, brief, iap, pio, airops, evac, trans, owner, suprep, Mobile (26 MB Avenza). Naming case/padding inconsistent — parse tolerantly.
- **PDFs are geospatial PDFs** (ISO 32000 `/VP /Measure /GPTS` + `/GCS` WKT; projections vary: UTM zones, CA Teale Albers). GDAL's PDF driver reads them directly, including the NEATLINE metadata (map frame minus title-block collar).
- Join key: filename token `_([A-Z]{2}[A-Z0-9]{2,4})(\d{6})(?=[_.])` → fire API `unique_fire_id` (`2026-COGMF-000114`); fallback fuzzy name match on dir `YYYY_FireName` (IR-only dirs have no token).
- Files: Last-Modified + ETag + Range(206) + If-Modified-Since(304) → incremental mirror. Index pages are dynamic (no validators) but parent listings expose child mtimes → change-driven descent. Big fire ≈ 500 files / 4.5 GB → mirror selectively. QR/ = latest maps **overwritten in place**; IR/ = nightly PDF+JPG+KMZ+Shapefiles.zip (Perimeter/Intense/Scattered/Isolated heat polygons, NAD83) + Read_Me.txt (has `Estimated Acreage:`).

### Design tokens (from fires.cornea.is)
- Dark: bg `#1a1218`, surface `#241c21`, text `#e8e2e5`, muted `#998e94`, border `#332a2f`, accent `#ffbd5a`, error `#d4572e`. Light: bg `#fdfcf9`, text `#3b1d29`.
- Fonts: Newsreader (display) + Public Sans (UI), base 15px. 4px radii, hairline borders.
- Fire styling: perimeter `#CC0000` fill-opacity 0.13 / line 2px (selected 4px); pins teardrop `#FFBB56` (prescribed `#C3B392`); hotspot hexagons — active(24h) `#FF7518`, aging `#FF6467`→`#C05DE1` (7d+).
- Basemap: fork OpenFreeMap dark (`https://tiles.openfreemap.org/styles/dark`, keyless, OpenMapTiles schema — cornea dark paints port directly: bg `#161313`, water `#292e38`, residential `#5b3140`, labels `#beb3a0`); Carto dark-matter as day-1 fallback.
- Windy patterns: bottom timeline (play btn, day labels + hour ticks, draggable playhead + tooltip, dim cover right of playhead), layer rail → panel, product dropdown bottom-right, legend gradient bar above timeline.

## Architecture

```
Browser (Vite+React+TS+MapLibre SPA — GitHub Pages)
 ├─→ fire-api-prod.web.app                directly (CORS *)
 ├─→ https://<name>.workers.dev/wms01|02  Cloudflare Worker caching proxy → pyrecast geoservers
 └─→ https://fNNN.backblazeb2.com/file/responder-debrief-data/…   catalogs, tiles, PDFs (B2, CORS *)
Cron worker (Python 3.12 + gdal-bin CLI, GitHub Actions, public repo)
 ├─ catalogs job (hourly):   fire API + pyrecast caps → catalog.json / pyrecast_runs.json / weather_runs.json
 └─ mirror job (4×/day):     FTP crawl → match to active fires → mirror PDFs → GeoPDF→XYZ tiles → B2
```

### Repo layout (monorepo, public)

```
responder_debrief/
├── frontend/                # Vite + React + TS + MapLibre (src layout below)
├── proxy/                   # Cloudflare Worker: wrangler.toml + src/index.ts
├── worker/                  # Python pipeline (uv-managed)
│   ├── pyproject.toml
│   ├── responder_worker/    # config, fires, ftp_index, matching, mirror, geopdf,
│   │                        # ir_vectors, pyrecast, catalogs, b2, state, cli
│   ├── config/match_overrides.json
│   └── tests/ + tests/fixtures/   # real sampled PDFs, autoindex HTML, caps excerpts
├── .github/workflows/       # catalogs.yml (hourly), mirror.yml (4×/day),
│                            # deploy-pages.yml (push→GH Pages), deploy-proxy.yml (wrangler)
└── README.md
```

**Secrets**: `B2_KEY_ID`, `B2_APP_KEY` (scoped to one bucket); `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (proxy deploy only). Everything else is unauthenticated.

**GitHub Pages notes**: deploy `frontend/dist` via `actions/deploy-pages`; set Vite `base: '/responder_debrief/'` (project page path); SPA deep links (`/fire/:id`) via the `404.html` = copy-of-`index.html` trick.

## Frontend

### src/ layout

```
frontend/src/
├── app/            routes ('/' national, '/fire/:corneaId'), tokens.css (cornea vars), config.ts
│                   (DATA_BASE_URL, PROXY_BASE, layer z-order, cache caps)
├── state/          zustand store + selectors (view, time, layers, ui) — server data lives in TanStack Query only
├── api/            fireApi.ts, wmsUrls.ts, catalogs.ts, queries.ts, geo.ts (LatFirstBbox), confidence.ts
├── map/            MapRoot.tsx (owns maplibregl.Map), zOrder.ts, styles/rd-dark|light.ts,
│   └── layers/     firePinsLayer, perimeterLayer, nationalPerimetersLayer, hotspotLayer,
│                   spreadForecastLayer, weatherLayers, incidentMapLayer, irHeatLayer
│                   (imperative mount/update/unmount; single zustand subscription diffs state)
├── timeline/       Timeline.tsx, TimelineTrack.tsx, timeScale.ts, framePlan.ts, prefetch.ts, usePlayback.ts
├── panels/         Sidebar (380px), NationalPanel (list+search), FirePanel tabs
│                   (Overview | Forecast | Weather | Maps), LegendBar, MobileSheet
└── utils/          format.ts (nulls → "—"; fire-local time via fire.timezone), markdown.tsx (AI summary)
```

### Key decisions

- **State**: zustand holds `view`, `time.currentTime` (single source of truth, epoch ms UTC), layer toggles (spread product/percentile/opacity; weather multi-select map; incident overlay id/opacity), ui. TanStack Query owns all server data: perimeter versions `staleTime: Infinity` (server-marked immutable), hotspots 300 s keyed on 0.25°-snapped bbox, catalogs 300 s invalidated on any WMS 404 (run-rotation detector), fires index 60 s.
- **Basemap**: fork OpenFreeMap dark with cornea paints (`rd-dark.ts`); theme swap via `setStyle(..., {transformStyle})` re-merging all `rd-`-prefixed sources/layers.
- **Z-order** (bottom→top): basemap fills < weather rasters < incident-map overlay < spread forecast < basemap labels < IR heat < perimeter fill/line < hotspots < pins. Enforced by `zOrder.ensureOrder()`.
- **Pins**: one GeoJSON source from the slim fires index; teardrop SVG via `addImage`; **collision declutter, not clustering** (`symbol-sort-key` by −acres; overlap allowed at z≥8) — keeps the national geographic pattern honest. Click → select fire, flyTo.
- **National perimeters**: geoserver01 `fire-detections_current-year-perimeters` WMS raster via proxy tiles (O(viewport), CDN-cached). **Selected fire**: vector GeoJSON versions via verbatim index paths.
- **Hotspots**: ingest adds `acq_ts` (epoch ms from acq_date+HHMM UTC) + `conf_norm`; SDF hexagon symbol layer; timeline scrub = cheap `setFilter(acq_ts ≤ t)` + `icon-color` aging ramp relative to t (`#FF7518` <24h → `#FF6467` 1d → `#C05DE1` 7d+). National: debounced moveend fetch at z≥6, 7-day window. Fire mode: one fetch, run/perimeter bbox +20%, `since = max(created_on, now−45d)`, limit 50000.
- **Spread forecast**: MapLibre **`image` source** pinned to the run bbox; frame = `updateImage(url)` with deterministic URLs (fixed bbox, max dimension 1536, verbatim catalog time instant) → atomic swaps, 1 request/frame, edge-cacheable, immune to GeoServer flow-control tile storms. Weather: tiled 512px `{bbox-epsg-3857}` GetMap template per product, **A/B source pair** with 150 ms opacity crossfade per time step (step = layer-name swap, since gs01 weather is layer-per-hour).
- **Timeline**: piecewise-linear scale (past 55% / future 45%, seam at NOW marker). Domain: national `[now−7d, weather last frame]`; fire `[created_on, max(spread last instant, weather last frame)]`. Track: day ticks + labels, hour ticks where ≥3 px/hr, perimeter-version dots (click-to-snap, hover → 4px perimeter line), draggable playhead + fire-local-time tooltip, dim cover right of playhead. **Snapping**: perimeter = latest version ≤ t; hotspots = filter ≤ t; spread = binary-search verbatim `time_instants` (minute-precision first instant — never do hour arithmetic); weather = nearest frame within 90 min else hidden + "forecast begins {t}" chip. **Playback**: frame-index-driven (not wall clock), gated on prefetch readiness (`buffering` state); `FramePrefetcher` strictly sequential (concurrency 1 to gs02, ≤4 total uncached GetMaps — GeoServer flow control), LRU decoded-Image cache (~500 entries), playhead-forward-then-back priority, starts on product select. Any frame 404 → invalidate catalogs, re-resolve run, toast "Forecast updated to newer run".
- **Incident maps tab**: grouped by product kind (ops/iap/brief/pio/evac/airops/mobile/other), newest badged "Latest", thumbnail previews; georeferenced → exclusive "Show on map" toggle + opacity slider (default 0.75) + zoom-to-bounds; non-geo → "opens as PDF" pill with size warning (26 MB Avenza). Active overlay gets a dismissible floating chip on the map. IR flights render as a GeoJSON heat-polygon toggle (`irHeatLayer`).
- **Responsive**: desktop = right sidebar 380px + 64px bottom timeline + legend bar above it; mobile <768px = bottom sheet (peek/half/full) + 48px compact timeline; pickers move into tabs; touch targets ≥44px.
- **Guardrails in the API layer**: `LatFirstBbox` named-field type (the hotspot bbox order bug becomes unrepresentable); `parseFireCoordinates` is the only parser of the `"lat, lon"` string; `fetchPerimeterByPath(path)` only — no URL reconstruction; lint-forbid `geoserver-usw1.pyrecast.org` in `src/` (everything goes through `PROXY_BASE`).
- **Local dev**: Vite `server.proxy` routes `/wms01|/wms02` to the geoservers with Origin stripped (`changeOrigin`), so `npm run dev` needs no deployed proxy.

## Cron worker (Python 3.12, GitHub Actions ubuntu-latest)

GDAL used **exclusively via subprocess CLI** (`gdalinfo -json`, `gdal_translate`, `gdalwarp`, `gdal2tiles.py`, `ogr2ogr`) — `apt-get install gdal-bin` in CI (~20 s), `brew install gdal` locally; no Python-binding version hell. Deps: httpx, lxml (iterparse), rapidfuzz, boto3 (B2 S3 endpoint; sets `CacheControl` per object), tenacity, pypdf. Two CLI jobs:

### Job `sync-catalogs` (hourly, `7 * * * *`, ~2 min, no GDAL)
1. Fetch active fires (slim fields incl. `unique_slug`, `unique_fire_id`, `timezone`); filter wildfires; parse coordinates.
2. gs02 full caps (with `&updatesequence=` skip) → per-run: workspace, bbox, native CRS, **verbatim time-instant list** (shared by all 4 timed products), product layer templates, proxy-rewritten legend URLs. Slug→fire match: state prefix must equal fire.state; strip optional trailing `-\d{4,6}` local-incident number (cross-check vs `unique_fire_id` numeric part); exact slugified-name compare then rapidfuzz ≥90; unmatched → `unmatched_workspaces` (still browsable generically).
3. gs01: **never fetch 33 MB caps** — probe last 4 deterministic HRRR cycle workspaces via `&namespace=` filtered caps; extract products + hour lists from layer-name suffixes; emit newest complete run + one previous. Weekly full-caps parse as drift detector.
4. Upload catalogs (ordering in §Atomicity).

### Job `sync-incidents` (4×/day, `25 1,7,13,19 * * *`, budget 45 min, GDAL)
1. **Match** (`matching.py`): crawl configured year-roots per GACC (pacific_nw's two state dirs; probe southern/eastern state subdirs; tolerate 404). Candidate dirs `^\d{4}_(.+)/$` minus placeholders. Deterministic: unit-token regex over newest Products/GIS + QR filenames → `2026-{UNIT}-{NUM}` == `unique_fire_id` (majority vote, confidence 1.0). Fallback: CamelCase-split + normalize both sides, compare raw / `-complex` / `-fire` stripped forms, exact → 0.95, rapidfuzz ≥90; **GACC→states constraint** disambiguates duplicate names; ties stay unmatched (report + `match_overrides.json` for manual pins). `unit_id` beats name matches. Cache matches in state.
2. **Mirror** (`mirror.py`) per matched active fire: `QR/` whole set incl. Avenza mobile (≤40 MB cap, never tiled); newest 3 `Products|GIS/YYYYMMDD/` dirs; newest 7 `IR/` dirs (incl. `*_UTF_*` Read_Me). Change detection: listed child-dir mtimes vs state (skip unchanged subtrees with zero requests); per-file ETag/Last-Modified conditional GETs; QR overwrites bump a `rev`. Politeness: UA `responder-debrief-mirror/1.0 (contact: pashaminkovsky@gmail.com)`, ≤2 concurrent listings / ≤4 downloads, tenacity retries, per-incident checkpoints → resumable.
3. **GeoPDF** (`geopdf.py`) per new PDF (skip mobile): `gdalinfo -json` detects georef (geoTransform + WKT); DPI by sheet size (8x11/11x17→300, arch_c/d→200, arch_e→150); `gdal_translate` → `gdalwarp -t_srs EPSG:3857 -dstalpha -cutline NEATLINE -crop_to_cutline` (drops the title-block collar) → `gdal2tiles.py --xyz -x -w none`, zmax = clamp(log2(156543/native_res), 10, 16), zmin = zmax−6. Tiles keyed by **`sha256(pdf)[:16]`** → content-addressed, immutable. 480px preview PNG for every PDF (geo or not). Per-run tile budget 40 sheets, priority ops>brief>iap>airops>evac>trans>pio>other, rest flagged `tiling_pending`. Failures degrade to `georeferenced:false` + raw link, never fatal.
4. **IR vectors** (`ir_vectors.py`): Shapefiles.zip → `ogr2ogr -t_srs EPSG:4326` per heat class → merged FeatureCollection tagged `heat_type`, + `Estimated Acreage` from Read_Me → `vectors/ir/{fire_slug}/{flight}.geojson`.
5. Rebuild incident manifests + master catalog; prune fires inactive >14 days.

Both workflows: `workflow_dispatch` with `fire`/`since`/`force` inputs (backfill), `concurrency: cancel-in-progress: false`, odd-minute crons (GH scheduler rush), `--dry-run` writes to `./out/` for local dev against `tests/fixtures/`.

## B2 layout, caching, atomicity

```
catalogs/catalog.json | pyrecast_runs.json | weather_runs.json      max-age=60, must-revalidate
catalogs/incidents/{fire_slug}.json                                  max-age=60
raw/incidents/{fire_slug}/{products/YYYYMMDD|qr|ir/YYYYMMDD}/…       products/ir: 604800; qr: 300 (+?v={rev})
tiles/incidents/{fire_slug}/{sha16}/{z}/{x}/{y}.png                  immutable, max-age=31536000
previews/incidents/{fire_slug}/{sha16}.png                           immutable
vectors/ir/{fire_slug}/{flight}.geojson                              immutable
state/state.json                                                     private, no-store (worker-internal)
```

- Bucket public; CORS `allowedOrigins: ["*"]`, GET/HEAD + range, expose etag/content-range.
- **Atomicity = ordering** (B2 PUTs are atomic, no rename): immutable assets → incident manifests → runs catalogs → `catalog.json` **last** (sole polling entry point; monotonic `version`). Crash mid-run leaves only orphaned immutable assets (pruned later), never dangling references. Snapshot copies under `catalogs/versions/` with a 14-day lifecycle rule.
- `state/state.json` (single writer, GH concurrency groups): per-incident dir mtimes, per-file etag/lm/size/sha/rev, `tiled: {sha: tiler_version}`, gs02 updateSequence, prune clocks. Preferred over B2 list calls.

## WMS caching proxy (Cloudflare Worker, `proxy/`)

Routes `GET /wms01` → gs01 `/ows`, `GET /wms02` → gs02 `/ows`. Logic:
- Allowlist `request ∈ {GetMap, GetLegendGraphic, GetFeatureInfo}` (**never** GetCapabilities), param allowlist (drops `sld`, `sld_body`, `env`, `viewparams` → no SSRF/style injection), layer regex + namespace prefix allowlist (`fire-spread-forecast_`, `fire-weather-forecast_`, `fire-risk-forecast_`, `fire-detections_`, `fuels-and-topography_`), width/height ≤ 2048, format ∈ {png, jpeg, json}.
- Canonical sorted query = cache key (TIME included); Cloudflare Cache API. Upstream fetch sends **no Origin/Cookie** (passes pyrecast's allowlist; drop `GS_FLOW_CONTROL` Set-Cookie both ways).
- Don't cache GeoServer's 200-with-XML ServiceExceptions (content-type check). TTLs: spread GetMap 7 d, weather GetMap 3 d (both run-stamped → effectively immutable), legends 1 d, GetFeatureInfo 1 h. Errors → 502 `no-store` + `x-upstream-status` (frontend's run-rotation signal).
- **Response header `Access-Control-Allow-Origin: *`** (frontend is on github.io — cross-origin to workers.dev).
- Free tier: 100k req/day; heavy scrub session ≈ 1–3k requests → ~50–100 heavy sessions/day headroom. B2 assets are never routed through the Worker.

## Data contracts (worker → frontend, on B2)

**`catalogs/catalog.json`** (master, polled): `{schema_version, version, generated_at, wms_proxy: {gs01, gs02}, fires: [{fire_slug, cornea_id, unique_fire_id, name, coordinates: [lon,lat], state, acres, containment, active, last_updated, poly_last_updated, timezone, has_incident_maps, incident_manifest, ftp_match: {method: unit_id|name_exact|name_fuzzy, confidence, dir_url}, has_spread_forecast, spread_latest_run}], counts}`

**`catalogs/pyrecast_runs.json`**: keyed by `fire_slug` → `{pyrecast_slug, runs: [{workspace, run_time, bbox [w,s,e,n 4326], native_crs, percentiles, time_instants: [verbatim ISO strings], products: {name: {timed, layer_template: "{ws}:elmfire_landfire_{pct}_{product}", legend_url, vector?}}}]}` + `unmatched_workspaces`. Frontend GetMap: `{PROXY_BASE}/wms02?service=WMS&version=1.3.0&request=GetMap&layers={layer}&styles=&crs=EPSG:3857&bbox={merc}&width=…&height=…&format=image/png&transparent=true&time={instant}`.

**`catalogs/weather_runs.json`**: `{models: {hrrr: {label, products: {id: {label}}, runs: [{workspace, run_time, hours: [ISO…], layer_template: "{ws}:{product}_{YYYYMMDD}_{HHMMSS}", default_layer_template, legend_url_template}]}}}` — weather time-stepping is **by layer name**, not TIME param.

**`catalogs/incidents/{fire_slug}.json`**: `{fire_slug, cornea_id, source_dir, region, unit_incident, maps: [{id (sha16), kind: product|qr|mobile, product, product_label, sheet, orientation, op_date, period, filename, pdf_url, size_bytes, georeferenced, projection, preview_url, tiles: {url_template, minzoom, maxzoom, bounds [w,s,e,n]} | null, tiling_pending, rev}], ir_flights: [{flight_date, flight_id, no_flight_reason, geojson_url, heat_types, estimated_acres, pdf_url, kmz_url, readme_url}]}`

All URLs root-relative; frontend prepends `DATA_BASE_URL`.

## Build order (phases; always demoable)

| # | Scope | Est. |
|---|---|---|
| 0 | Repo scaffold: frontend (Vite+TS, tokens.css, fonts, MapRoot + dark style), worker skeleton (`b2/state/config`, dry-run CLI), proxy Worker deployed, B2 bucket + CORS + key, GH Pages + workflows live | 1 d |
| 1 | **National map**: fires index, pins + declutter, sidebar list/search, fire route + Overview tab (stats, AI summary, structure exposure) | 2 d |
| 2 | **Worker: pyrecast catalogs** (`fires/pyrecast/catalogs`, catalogs.yml) — unblocks all forecast UI | 1 d |
| 3 | **Perimeters + hotspots**: selected-fire vector perimeter, national WMS raster, hotspot ingest/normalize/hex render (national + fire modes) | 2 d |
| 4 | **Timeline core (past)**: timeScale, track/ticks/playhead, NOW marker, perimeter-version snapping, hotspot time filter + aging | 2–3 d |
| 5 | **Spread forecast**: run resolution, ForecastTab (product dropdown + percentile pills), image-source frame player, instant snapping, legends, future domain | 2 d |
| 6 | **Weather**: WeatherTab multi-select + opacity, A/B tiled rasters, hour snapping, legends | 1.5 d |
| 7 | **Playback**: frame plan, sequential prefetcher + LRU, buffering gate, crossfade, 404→catalog refresh | 2 d |
| 8 | **Worker: FTP mirror + matching** (`ftp_index/matching/mirror` + fixture tests, mirror.yml) → manifests with PDF links + previews | 1.5 d |
| 9 | **Worker: GeoPDF tiling + IR vectors** (`geopdf/ir_vectors`, budget/pruning) | 1.5–2 d |
| 10 | **Incident maps UI**: grouped list + previews, tile overlay + opacity + chip, PDF fallback, IR heat toggle | 1 d |
| 11 | **Responsive + polish**: MobileSheet, compact timeline, light theme, empty/error states, hardening (backfill CLI, proxy observability, match_overrides docs) | 2–3 d |

Total ≈ 19–21 focused dev-days. Frontend is unblocked on live forecast data after phase 2; FTP work (8–9) can proceed in parallel with frontend phases 3–7.

## Risks & mitigations (top)

1. **Ephemeral pyrecast runs** (workspaces vanish in ~3 days, new runs several times daily): hourly catalogs keep previous run as fallback; proxy surfaces upstream status; frontend 404 → catalog refetch + toast; no layer names ever hardcoded.
2. **GeoServer flow control / uncached upstream**: single-image spread frames, sequential prefetch (≤4 concurrent), hard edge caching in the Worker, `x-upstream-flow-delay` observability. Durable-Object queueing only if throttling proves real.
3. **Matching errors** (FTP dirs, pyrecast slugs): deterministic unit-token first, GACC-state constraint, ties left unmatched + surfaced in run logs, `match_overrides.json` escape hatch, `ftp_match.confidence` badged in UI.
4. **FTP naming chaos**: tolerant parsers, unparseable files still mirrored as `product: "other"`, fixture tests pinned to real observed names.
5. **GH cron drift**: odd-minute schedules; jobs idempotent and state-diff-driven (catch-up safe).
6. **GDAL PDF edge cases** (multi-page, missing neatline, exotic projections): fallback chain warp-without-cutline → `georeferenced:false` + raw PDF; errors recorded in manifest, never fatal.
7. **Quota surprises**: public repo (Actions free); B2 ~13 GB steady-state ≈ $0.08/mo; Workers 100k req/day fine for a feedback round; B2 egress free up to 3× stored per day (add Cloudflare-proxied domain later if traffic grows — catalogs already use relative paths).

## Appendix — AWS HRRR fallback pipeline (build only if pyrecast weather fails)

Worker module `hrrr.py`, cron `40 1,7,13,19 * * *`: poll `https://noaa-hrrr-bdp-pds.s3.amazonaws.com/?list-type=2&prefix=hrrr.{YYYYMMDD}/conus/` (files land ~50–55 min after init; only 00/06/12/18z reach f48). Per hour: fetch `.idx` (~10 KB), select `GUST:surface`, `TMP:2 m`, `RH:2 m`, `MASSDEN:8 m` (scale ×1e9 → µg/m³!), `UGRD/VGRD:10 m`, `APCP:surface:(FF-1)-FF hour acc` (match full window string), `COLMD`; byte-range GET each (~11.5 MB/hr total). `gdalwarp -t_srs EPSG:3857` (grid is Lambert `+proj=lcc +lat_0=38.5 +lat_1=38.5 +lat_2=38.5 +lon_0=-97.5 +R=6371229`, 1799×1059@3 km — never corner-pin, tens-of-km edge error); apply cornea legend ramps → paletted PNG per field/hour (~0.2–1 MB) + downsampled U/V JSON grid for barbs; publish `weather/hrrr/{run}/…` + manifest (written last) to B2; frontend swaps `image` source URLs. ~6–10 min Actions time per cycle.

## Verification

1. **Worker units**: `uv run pytest` — matching (real observed names: `2026_Elk`/COGMF000114, `2026_Aspen%20Acres`, `HayCreekComplex`, zFireName filtering), autoindex parsing, GeoPDF georef detection on the two sampled PDFs in fixtures, caps parsing on saved excerpts.
2. **Worker dry-run**: `uv run python -m responder_worker.cli sync-catalogs --dry-run` then `sync-incidents --dry-run --fire elk` → inspect `./out/` catalogs against the schemas; validate every `time_instants` list is verbatim-ISO and every tile bounds is [w,s,e,n].
3. **Proxy**: `wrangler dev` + curl matrix — allowed GetMap returns PNG + `ACAO:*` + cache MISS→HIT on repeat; GetCapabilities/SLD params → 400; vanished-workspace layer → 502 + `x-upstream-status: 404`.
4. **Frontend e2e (manual, dev server)**: national pins/hotspots render; select BIG GRASS-class fire → perimeter, Overview stats vs fire-api values; scrub past → perimeter steps through versions, hotspots age; scrub future → spread frames advance (verify first minute-precision instant renders), weather multi-select stacks with legends; play → no stutter (buffering gate) at 4 layers; incident map overlay aligns with basemap roads/water at the fire (visual georef check vs the map's own grid); opacity sliders; mobile viewport (375px) sheet + compact timeline.
5. **Live smoke test after first deploys**: GH Pages URL loads over the workers.dev proxy + B2 catalogs end-to-end; Lighthouse quick pass; confirm no requests hit `geoserver-usw1.pyrecast.org` directly from the page (DevTools network).
