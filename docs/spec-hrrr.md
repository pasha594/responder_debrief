# HRRR weather pipeline (replaces pyrecast gs01 weather frames)

User decision: weather comes from the NOAA HRRR bucket on AWS (public,
anonymous), not pyrecast. The output contract stays the same static-frames
shape (`weather_runs.json` + `/frames/weather/...` PNGs on B2) so the
frontend barely changes. Pyrecast gs02 spread frames and the national
perimeters snapshot are unaffected.

## Source facts (verified live 2026-08-17)

- Listing: `https://noaa-hrrr-bdp-pds.s3.amazonaws.com/?list-type=2&prefix=hrrr.{YYYYMMDD}/conus/&max-keys=...`
  (S3 XML; no auth). Files `hrrr.tHHz.wrfsfcfFF.grib2` (~150–175 MB) + `.idx`
  sidecar (~10 KB). Cycles hourly; **f00–f48 only for 00/06/12/18z**, f00–f18
  otherwise. sfc files land ~50–55 min after cycle init, one hour at a time.
- idx line format `msgnum:byteOffset:d=YYYYMMDDHH:VAR:level:fcst:`; message
  size = next offset − offset (last: open-ended range). Byte-range GETs return
  standalone decodable GRIB2 messages. Match records EXACTLY:
  - `TMP:2 m above ground` → tmpf (K → °F)
  - `RH:2 m above ground` → rh (%)
  - `UGRD:10 m above ground` + `VGRD:10 m above ground` → ws (m/s → mph)
  - `GUST:surface` → wg (m/s → mph)
  - `MASSDEN:8 m above ground` → smoke (kg/m³ ×1e9 → µg/m³)
  - `APCP:surface` with fcst string `(FF-1)-FF hour acc fcst` (exact window
    match — the file also has a 0-FF run-total APCP) → apcp01 (mm → in)
- Grid: Lambert conformal `+proj=lcc +lat_0=38.5 +lat_1=38.5 +lat_2=38.5
  +lon_0=-97.5 +R=6371229`, 1799×1059 @ 3 km. NEVER corner-pin — warp.

## Pipeline (worker/responder_worker/hrrr.py, CLI-GDAL only)

Per new complete-enough cycle (newest with ≥ N hours available, N=2):
1. For each forecast hour and product: idx fetch → byte-range GET the
   message(s) → write `msg.grib2`.
2. `gdalwarp -t_srs EPSG:3857 -te <CONUS bounds in 3857> -ts 2560 0
   -r bilinear -dstnodata nan msg.grib2 warped.tif` (CONUS bounds
   [-125.0, 24.5, -66.5, 49.5] as in spec-frames.md; gdal reads GRIB2
   complex packing natively — apt gdal-bin / brew gdal).
3. Unit conversion + derived fields via `gdal_calc.py` (CLI; from
   python3-gdal on ubuntu, included in brew gdal):
   ws = `sqrt(A*A+B*B) * 2.23694`; tmpf = `(A-273.15)*9/5+32`;
   wg ×2.23694; smoke ×1e9; apcp01 /25.4; rh as-is.
4. Colormap → transparent PNG: `gdaldem color-relief calc.tif ramp.txt out.png
   -alpha -nearest_color_entry`? No — use interpolated (default). One
   `ramps/{product}.txt` per product, stops chosen from the cornea legend
   ramps (wind `#78b4dc→#50aa96→#ffdc50→#ff9628→#e63c32→#aa2882→#6e1450` over
   0–70+ mph; smoke `#b4b4b4→#ffde59→#ff8c00→#e63223→#a02378→#6e143c` over
   0–200+ µg/m³; rh inverted danger scale 5–100%; tmpf 20–115 °F; precip
   cornea 18-stop). `nv` entries transparent.
5. Upload `frames/weather/{workspace}/{product}/{epoch_ms}.png` where
   workspace = `hrrr_{YYYYMMDD}_{HH}` (epoch_ms = valid-time). Immutable.
6. Incremental + deadline-guarded exactly like frames.py (storage.exists skip,
   frames.start_deadline shared clock, budget counts images).

## Manifest (weather_runs.json — same file, new source)

```jsonc
{ "schema_version": 1, "generated_at": "…", "source": "noaa-hrrr",
  "models": { "hrrr": {
    "label": "HRRR (NOAA)",
    "products": {
      "ws":    {"label": "Wind speed",        "units": "mph",  "legend_stops": [[0,"#78b4dc"],[10,"#50aa96"],[20,"#ffdc50"],[30,"#ff9628"],[45,"#e63c32"],[58,"#aa2882"],[70,"#6e1450"]]},
      "wg":    {"label": "Wind gust",         "units": "mph",  "legend_stops": [ …same ramp… ]},
      "tmpf":  {"label": "Temperature",       "units": "°F",   "legend_stops": [[20,"#78b4dc"],[50,"#50aa96"],[70,"#ffdc50"],[85,"#ff9628"],[100,"#e63c32"],[115,"#6e1450"]]},
      "rh":    {"label": "Relative humidity", "units": "%",    "legend_stops": [[5,"#d4572e"],[15,"#f57c00"],[25,"#ffdc50"],[40,"#e0d063"],[70,"#9ad8a0"],[100,"#78b4dc"]]},
      "smoke": {"label": "Near-surface smoke","units": "µg/m³","legend_stops": [[0,"#b4b4b4"],[20,"#ffde59"],[60,"#ff8c00"],[100,"#e63223"],[150,"#a02378"],[200,"#6e143c"]]},
      "apcp01":{"label": "1-h precip",        "units": "in",   "legend_stops": [[0,"#a4aab8"],[0.05,"#627cae"],[0.15,"#6bc858"],[0.4,"#f6cf57"],[0.8,"#e8543b"],[1.5,"#9f40dd"]]}
    },
    "runs": [{ "workspace": "hrrr_20260818_00", "run_time": "2026-08-18T00:00:00Z",
      "hours": ["…ISO valid times…"],
      "frames": { "bounds": [-125.0, 24.5, -66.5, 49.5],
                  "image_template": "/frames/weather/{ws}/{product}/{epoch_ms}.png",
                  "hours": ["…rendered…"], "complete": true } }]
  } } }
```

Ramp stops in `legend_stops` MUST match the gdaldem ramp files (single source
of truth: a RAMPS dict in hrrr.py emits both).

- No `wd` raster and no `ffwi` in v1 (direction needs arrow rendering, Fosberg
  needs a derived formula — both deferred; drop from products).
- Products list drives the Weather tab automatically (frontend intersects with
  RENDERED_WEATHER_PRODUCTS — ws/wg/tmpf/rh/smoke/apcp01 all in it).

## Frontend change (small)

- `weatherLegendUrl` path stays as fallback; add gradient-bar rendering: when
  a product carries `legend_stops`, LegendBar rows and the WeatherTab mini
  legends render a CSS linear-gradient bar with min/max labels + units
  (cornea style: uppercase left/right captions) instead of an `<img>`.
- Types: products map gains optional `units` + `legend_stops: [number, string][]`.

## Removals / wiring

- pyrecast.py: drop gs01 HRRR probing (`probe_gs01_runs`) and frames.py's
  weather fetch path; keep gs01 national-perimeters probe.
- cli.py sync-catalogs: replace sync_weather_frames(pyrecast) with
  hrrr.sync_weather(client, storage, state, …) producing the manifest block;
  same deadline clock; --frames-hours/--frames-products flags keep working.
- catalogs.yml: add `sudo apt-get install -y --no-install-recommends gdal-bin
  python3-gdal` (needed now for warping).
- HRRR needs no credentials — nothing added to secrets.
