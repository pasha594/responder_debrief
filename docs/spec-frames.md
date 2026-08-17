# Static-frames architecture (no proxy)

Supersedes the Cloudflare Worker proxy in [plan.md](plan.md)/[spec-backend.md](spec-backend.md): the
user wants GitHub + B2 only. The worker pre-renders every WMS image the
frontend needs into B2 as static, immutable PNGs; the browser never talks to
pyrecast (whose CORS allowlist 403s all other origins). The frontend is 100%
static-file consumers: fire API (CORS *) + B2 (CORS *).

## Worker: `frames.py`, run as part of hourly `sync-catalogs`

All fetches are server-side GetMap calls to the pyrecast geoservers,
concurrency ≤ 2–3 (GeoServer flow control), tenacity retries, and strictly
incremental: a frame is fetched at most once ever (immutable run-stamped
workspaces; state records completed workspaces).

### 1. Spread-forecast frames (gs02, per NEW run)

- Percentiles: **[10, 50] only** (user decision: median + low-percentile scenario; NOT 90).
- Timed products (spread-rate, flame-length, crown-fire, hours-since-burned):
  **thinned instants** from the run's verbatim `time_instants`: every instant in
  the first 24 h after run start, then 3-hourly to 72 h, then 6-hourly to the
  end (~56 frames). Always include the very first (minute-precision) instant.
- Static products (time-of-arrival, isochrones): one frame each, no time param.
- GetMap params: EPSG:3857, run bbox, aspect-correct max-dim 1536, transparent
  PNG (mirror frontend/src/api/geo.ts frameDims math).
- B2 keys: `frames/spread/{workspace}/{pct}/{product}/{epoch_ms}.png`
  (epoch_ms = Date.parse of the verbatim instant) and `.../static.png` for
  untimed products. Cache-Control immutable 1y.
- Budget guard per sync (default 3000 images) + resumable per-workspace state;
  unfinished workspaces retry next tick.

### 2. Weather frames (gs01, per NEW hrrr run)

- Products: **tmpf, rh, ws, wg, wd, ffwi, smoke, apcp01** (8 fire-critical;
  tcdc/pign/meq/apcptot dropped from v1 frames and from the manifest).
- One CONUS image per product per forecast hour (49 on long cycles): GetMap
  EPSG:3857, CONUS bounds **[-125.0, 24.5, -66.5, 49.5]**, width 2560 (height
  aspect-correct ≈ HRRR native 3 km), transparent PNG.
- B2 keys: `frames/weather/{workspace}/{product}/{epoch_ms}.png`, immutable.
- Keep 2 newest runs in manifests; B2 lifecycle/prune deletes older runs.

### 3. National perimeters snapshot (gs01, every sync)

- Single CONUS image of the newest `current-year-perimeters_{ts}` layer, same
  CONUS bounds, width 2048 → `frames/national/current-year-perimeters.png`
  (mutable, Cache-Control max-age=300).

### 4. Legends (once per product, refreshed when missing)

- `frames/legends/spread-{product}.png` (from gs02 GetLegendGraphic, pct 50)
- `frames/legends/weather-{product}.png` (from gs01, bare default layer)
- Cache-Control max-age=86400.

## Manifest changes (contract with frontend)

`pyrecast_runs.json` — each run object gains:

```jsonc
"frames": {
  "percentiles": [10, 50],
  "instants": ["…thinned verbatim ISO subset…"],   // scrubber uses THESE, not time_instants
  "timed_template": "/frames/spread/{ws}/{pct}/{product}/{epoch_ms}.png",
  "static_template": "/frames/spread/{ws}/{pct}/{product}/static.png",
  "complete": true                                   // false while budget-limited
}
```

`weather_runs.json` — model gains `"products"` trimmed to the 8 above; each run gains:

```jsonc
"frames": {
  "bounds": [-125.0, 24.5, -66.5, 49.5],
  "image_template": "/frames/weather/{ws}/{product}/{epoch_ms}.png",
  "hours": ["…ISO hours actually rendered…"],
  "complete": true
}
```

Legend paths: `"legend": "/frames/legends/spread-{product}.png"` per spread
product entry; `"legend_template": "/frames/legends/weather-{product}.png"` on
the weather model.

`catalog.json`:

```jsonc
"national_layers": {
  "current_year_perimeters": {
    "image": "/frames/national/current-year-perimeters.png",
    "bounds": [-125.0, 24.5, -66.5, 49.5],
    "as_of": "…"
  }
}
```

All paths root-relative to `DATA_BASE_URL`, as before.

## Frontend changes

- Delete `PROXY_BASE`; `wmsUrls.ts` becomes manifest-template resolvers
  (spread frame URL, weather image URL, legend URLs) via `dataUrl()`.
- `spreadForecastLayer`: unchanged mechanics (image source + `updateImage`);
  snapping now binary-searches `run.frames.instants`.
- `weatherLayers`: tiled A/B pairs → **image-source A/B pairs** with the same
  150 ms crossfade; coordinates from `frames.bounds`.
- `nationalPerimetersLayer`: raster tile source → image source.
- ForecastTab: percentile pills render 30/70/90 disabled ("not pre-rendered");
  legend `<img>` from B2.
- WeatherTab: products from the trimmed manifest; legends from B2.
- vite dev proxy for /wms01,/wms02: deleted (nothing calls pyrecast).
- Dev data: worker dry-run writes frames under `out/frames/...`; copy to
  `frontend/public/data` as before.

## Removals

- `proxy/` directory, `.github/workflows/deploy-proxy.yml`, README proxy
  sections (replace with a "static frames" paragraph), `VITE_PROXY_BASE`
  variable in `deploy-pages.yml`.
