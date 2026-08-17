# Spread forecasts: client-side rendering from the public forecast archive

REWRITE (supersedes the earlier conversion design): per user direction and the
fire-forecast-eval precedent (~/Desktop/fire-forecast-eval — reviewed), the
browser renders spread forecasts DIRECTLY from the public archive bucket. No
worker conversion, no pre-rendered spread frames, no percentile restrictions.

## Source (public, CORS-enabled — verified for https://pasha594.github.io)

Base: `https://f005.backblazeb2.com/file/fire-forecast-archive`
- `forecast_archive/{slug}/{run_ts}/{pct}.tif` — **time-of-arrival**: float32,
  per-fire UTM (EPSG:326xx), 30 m, DEFLATE tiled-256, nodata 0. **Values =
  HOURS since forecast start** (max ~336). Burned-at-start is nodata; the
  burned-by-hour-H mask is simply `valid && toa <= H`. (Calibration verified
  in fire-forecast-eval/analyze.py.) ~1.5–2.5 MB each.
- `forecast_archive/{slug}/{run_ts}/{pct}_{product}.tar` — hourly granules,
  members `{product}_{YYYYMMDD}_{HHMMSS}.tif` (Byte, same grid/UTM, NoData 0,
  value ≈ physical quantity), ~169 members, 3–9 MB per tar. Products:
  crown-fire, flame-length, hours-since-burned, spread-rate (+ isochrones
  shapefile tar, ignored v1).
- `manifest.json` — per `{slug}/{run_ts}`: complete, expired, centroid,
  files{pct}, vars{pct}{product}{ok,n,got,last,complete}. Source of truth.
- `fire_matches.json` — slug → cornea fire matching (prefer over fuzzy).

## Worker (shrinks: pure catalog work, no GDAL for spread)

- DELETE: gs02 caps parsing (pyrecast.fetch_gs02_runs/parse_gs02_caps),
  frames.sync_spread_frames + spread templates/annotation, spread legend
  fetching (sync_legends gone entirely — weather legends are already
  gradient stops; spread gets stops too). Keep: gs01 national probe, HRRR
  weather (hrrr.py), incidents/FTP, prune policy.
- NEW archives.py: public-HTTPS GET (no creds needed) of manifest.json +
  fire_matches.json (ETag-cached in state). Build the spread section of
  pyrecast_runs.json (keep the filename for frontend compatibility):
  per fire (matched via fire_matches.json first — it maps slug→cornea fire;
  fall back to matching.match_pyrecast_slug), newest non-expired run +
  previous:

```jsonc
{ "schema_version": 2, "generated_at": "…", "source": "fire-forecast-archive",
  "archive_base": "https://f005.backblazeb2.com/file/fire-forecast-archive",
  "fires": { "sinlahekin": { "pyrecast_slug": "wa-sinlahekin", "runs": [{
      "workspace": "wa-sinlahekin_20260817_112500",   // {slug}_{run_ts}
      "slug": "wa-sinlahekin", "run_ts": "20260817_112500",
      "run_time": "2026-08-17T11:25:00Z",
      "horizon_hours": 169,                            // max vars[*][*].n
      "centroid": [-119.6, 48.6],
      "toa": { "percentiles": [10, 30, 50, 70, 90],    // pcts with files[pct].ok
               "url_template": "/forecast_archive/{slug}/{run_ts}/{pct}.tif" },
      "products": { "spread-rate": { "percentiles": [30, 90],   // vars availability
                      "tar_template": "/forecast_archive/{slug}/{run_ts}/{pct}_{product}.tar",
                      "units": "ch/hr", "legend_stops": [[1,"#ffdc50"],[10,"#ff9628"],[25,"#e63c32"],[50,"#aa2882"],[100,"#6e1450"]] },
                    "flame-length":       { …units "ft",  stops [[1,"#ffdc50"],[4,"#ff9628"],[8,"#e63c32"],[11,"#aa2882"],[25,"#6e1450"]] },
                    "hours-since-burned": { …units "h",   stops [[1,"#d4572e"],[24,"#c05de1"],[96,"#6e4bd0"],[168,"#3f2d7d"]] },
                    "crown-fire":         { …units null,  stops [[1,"#ffdc50"],[2,"#ff9628"],[3,"#e63c32"]],
                                            "legend_labels": ["surface","passive crown","active crown"] } },
      "toa_ramp": { "recent_hours": 12,
                    "stops": [["burned","#7a1f1f"],["recent","#ff6a2b"]] }  // colorize hint
  }] } }, "unmatched_slugs": [ … ] }
```

  catalog.json has_spread_forecast/spread_latest_run unchanged. URLs are
  archive-base-relative; frontend prepends `archive_base`.

## Frontend (the substantial piece)

New dependency: `geotiff` (^2) — decodes the DEFLATE UTM tifs; this is the
same decoding stack the user's fire-forecast-eval site uses (georaster wraps
it). Everything else is hand-rolled (NO proj4, NO untar lib):

1. `src/spread/untar.ts`: minimal USTAR reader — parse 512-byte headers
   (name, size octal, typeflag 0), yield {name, bytes} entries. Unit-tested
   against a tiny fixture tar generated in the test.
2. `src/spread/utm.ts`: UTM→WGS84 inverse (standard series expansion,
   WGS84 ellipsoid; zone+hemisphere from the tif's EPSG geokey 326xx).
   `utmBoundsTo4326(bbox, zone)` → [w,s,e,n] + corner coords for MapLibre
   (corner-pin; ~10s of m error at fire scale is acceptable). Unit-tested
   against 3 known coordinate pairs (e.g. from epsg.io).
3. `src/spread/toaRenderer.ts`: load {pct}.tif via geotiff (typed array +
   ModelPixelScale/Tiepoint + geokey), downsample-decode to ≤1536px wide
   (geotiff readRasters with resX/resY or pick overview), keep Float32Array.
   `renderAt(tMs)`: hours = (tMs − runStartMs)/3.6e6; paint RGBA into an
   OffscreenCanvas/canvas: nodata→transparent; toa ≤ hours−recent →
   dark burned #7a1f1f @ 0.55; hours−recent < toa ≤ hours → bright leading
   edge #ff6a2b @ 0.85 (recent_hours from manifest); toa > hours →
   transparent. This runs per scrub tick — with ≤1536² pixels a simple loop
   is ~5–15 ms; throttle via requestAnimationFrame.
4. `src/spread/productRenderer.ts`: fetch {pct}_{product}.tar once (cache by
   url in-module LRU, ~3 entries), untar → member index by parsed timestamp;
   `renderAt(tMs)`: nearest member ≤ t (verbatim timestamps from names),
   geotiff-decode that member (cache last N=8 decoded), colormap via
   legend_stops (piecewise-linear interpolate for continuous products,
   exact-match for crown-fire when legend_labels present), paint canvas.
5. `src/map/layers/spreadForecastLayer.ts`: REWRITE to manage a MapLibre
   **canvas source** ('rd-spread-forecast', coordinates from utm.ts corner
   conversion of the tif bbox) + raster layer (same id/z-order). ctx drives:
   product 'time-of-arrival' (DEFAULT, uses toaRenderer) or an hourly product
   (productRenderer); percentile from store (all available; default 50, then
   nearest); opacity unchanged. Async loads set a store-visible
   loading/progress state; render errors → hide + toast once.
6. ForecastTab: product dropdown = ['time-of-arrival' (labeled 'Fire spread
   (time of arrival)')] + products present in the run; percentile pills =
   toa.percentiles / product.percentiles (all of them; disabled pills only
   when genuinely absent); GradientLegend from legend_stops (crown-fire:
   discrete swatch row via legend_labels); ToA legend: the two-stop
   burned/leading-edge swatches + caption 'as of {scrub time}'.
7. framePlan/usePlayback: spread is now continuous (every timeline tick
   renders — no frame snapping, no prefetch gating for spread; drop spread
   from FramePrefetcher; keep weather gating). buildFrameTimes: spread
   contributes hourly ticks run_start..run_start+horizon.
8. types.ts: new run shape (schema_version 2) with toa/products/toa_ramp;
   remove SpreadFrames-era fields from the run type (keep parsing tolerant).
9. Timeline domain: fire-mode end = max(run_start + horizon_hours, weather
   end) — unchanged logic, new field.

## Cleanup

- B2: frames/spread/* and frames/legends/spread-* on responder-debrief-data
  become dead — delete keys once the new site is live (one-time cleanup in
  the worker deploy, not the prune command).
- docs/spec-frames.md spread sections superseded (note at top).
- Dev data: worker dry-run regenerates catalogs; frontend dev fetches the
  archive bucket directly (public CORS includes localhost via * rules? If
  localhost blocked, note VITE dev proxy for the archive — verify during
  integration).

## Verification

- Worker: pytest (manifest/fire_matches parsing fixtures, availability
  extraction, URL templates); live dry-run --force → pyrecast_runs.json v2
  validates; sinlahekin entry lists real pcts.
- Frontend: unit tests untar (fixture tar), utm (known pairs), toa threshold
  math (synthetic 4×4 raster), product member selection; tsc/build clean.
- Browser: sinlahekin ToA scrub (leading edge advances), product switch
  (spread-rate from tar), pct switch, playback smoothness; then push +
  live-site check.
