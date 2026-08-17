# Responder Debrief

Fire professionals and hotshots getting deployed to a wildfire currently stitch together NIFC/CalFire data, pyrecast spread forecasts, FTP'd incident maps, and weather sites to build a picture of the incident. **Responder Debrief** unifies them in one map-centric web app: a USA map of active fires, per-fire detail with spread forecasts and weather layers, a timeline that scrubs from fire history into the forecast future, and geo-aligned incident-map PDF overlays.

**Features**

- National map of ~400 active fires: pins, perimeters (WMS raster), satellite hotspot detections with age-based styling
- Per-fire view: versioned perimeter history, stats, AI incident summary, structure exposure
- Spread forecasts (pyrecast ELMFIRE): crown fire, flame length, spread rate, hours-since-burned, time of arrival — percentile selector, hourly playback out to +7 days
- Weather forecast overlays (HRRR via pyrecast): temperature, RH, wind, gusts, fire-weather index, smoke, precip, and more — multi-select with legends
- Timeline scrubber spanning fire history (perimeter versions, hotspot aging) into the forecast future, with buffered playback
- Incident map room: the actual ops/IAP/briefing/evac PDFs posted by incident teams, mirrored from ftp.wildfire.gov, tiled and geo-aligned on the map where georeferenced, with IR heat-perimeter vectors

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

Repo layout:

| Dir | What | Deployed by |
|---|---|---|
| `frontend/` | Vite + React + TS + MapLibre GL SPA | `deploy-pages.yml` → GitHub Pages |
| `proxy/` | Cloudflare Worker WMS caching proxy (`/wms01`, `/wms02`) — single-file `worker.js`, Python deploy, no npm | `deploy-proxy.yml` → workers.dev |
| `worker/` | Python data pipeline (uv-managed) | `catalogs.yml` (hourly), `mirror.yml` (4×/day) on GitHub Actions |
| `docs/` | Plan + detailed specs | — |

## Local development

**Frontend** (no deployed proxy needed — the Vite dev server proxies `/wms01`/`/wms02` to the geoservers with the Origin header stripped):

```sh
cd frontend
npm install
npm run dev          # http://localhost:5173
```

**Python worker** (dry-run writes catalogs to `./out/` instead of B2 — no credentials needed):

```sh
cd worker
uv sync
uv run python -m responder_worker.cli sync-catalogs --dry-run
uv run python -m responder_worker.cli sync-incidents --dry-run --fire elk
uv run pytest        # unit tests against tests/fixtures/
```

Local GDAL for the mirror job: `brew install gdal` (macOS) / `apt-get install gdal-bin` (Linux).

**WMS proxy** (no npm — a single plain-JS `worker.js` plus dependency-free tests):

```sh
node proxy/tests.js  # 34 unit tests of the validation/canonicalization rules
```

There's no local Worker runtime: for app development the frontend's Vite dev
proxy (above) already covers `/wms01`/`/wms02`, and the Worker's live behavior
is verified after deploy with curl:

```sh
# Legend through the proxy → 200, content-type: image/png, x-proxy-cache: MISS (HIT on repeat)
curl -si "https://responder-debrief-wms.<account>.workers.dev/wms02?service=WMS&version=1.3.0&request=GetLegendGraphic&layer=<a current fire-spread-forecast_… layer>&format=image/png" | head -20

# GetCapabilities is blocked → 400 {"error":"GetCapabilities is not served by this proxy"}
curl -si "https://responder-debrief-wms.<account>.workers.dev/wms01?service=WMS&request=GetCapabilities" | head -20
```

(Current layer names are run-stamped — grab one from the frontend's network tab
or the pyrecast run catalogs.)

## Deployment setup (one-time checklist)

1. **Create the GitHub repo** (public — Actions minutes are free only on public repos) and push:

   ```sh
   git remote add origin git@github.com:<you>/responder_debrief.git
   git push -u origin main
   ```

2. **Enable GitHub Pages**: repo → Settings → Pages → *Build and deployment* → Source: **GitHub Actions**. The site will live at `https://<you>.github.io/responder_debrief/` (the Vite build bakes in `VITE_BASE=/responder_debrief/`; if you rename the repo, update that value in `.github/workflows/deploy-pages.yml`).

3. **Create the B2 bucket** `responder-debrief-data`, **public**, with CORS open for GET:

   - Console: Buckets → Create Bucket → name `responder-debrief-data`, *Files in Bucket are: Public*.
   - CLI (`brew install b2-tools` or `pip install b2`):

     ```sh
     b2 account authorize   # master key, one-time
     b2 bucket create responder-debrief-data allPublic
     b2 bucket update responder-debrief-data allPublic --cors-rules '[{
       "corsRuleName": "public-get",
       "allowedOrigins": ["*"],
       "allowedOperations": ["b2_download_file_by_name", "b2_download_file_by_id", "s3_get", "s3_head"],
       "allowedHeaders": ["range"],
       "exposeHeaders": ["etag", "content-range"],
       "maxAgeSeconds": 3600
     }]'
     ```

   - Create an **application key scoped to this bucket only** (Read & Write): App Keys → Add a New Application Key → restrict to `responder-debrief-data`. Note the `keyID` and `applicationKey`.
   - Note your bucket's S3 endpoint (shown on the bucket page, e.g. `s3.us-west-004.backblazeb2.com`) and friendly download URL (e.g. `https://f004.backblazeb2.com/file/responder-debrief-data`).
   - Optional: add a 14-day lifecycle rule on the `catalogs/versions/` prefix (the worker snapshots catalogs there).

4. **Cloudflare**: create a free account, then an API token with the **Workers Scripts: Edit** permission (My Profile → API Tokens → the *Edit Cloudflare Workers* template grants it) and note your Account ID (dashboard sidebar).

5. **GitHub secrets** (repo → Settings → Secrets and variables → Actions → *Secrets*):

   | Secret | Value |
   |---|---|
   | `B2_KEY_ID` | the bucket-scoped application keyID |
   | `B2_APP_KEY` | the bucket-scoped applicationKey |
   | `CLOUDFLARE_API_TOKEN` | Workers-edit API token |
   | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account id |

   **Variables** (same page, *Variables* tab):

   | Variable | Example |
   |---|---|
   | `B2_S3_ENDPOINT` | `https://s3.us-west-004.backblazeb2.com` |
   | `VITE_PROXY_BASE` | `https://responder-debrief-wms.<account>.workers.dev` |
   | `VITE_DATA_BASE_URL` | `https://f004.backblazeb2.com/file/responder-debrief-data` |

6. **First proxy deploy** (locally, so you learn the workers.dev URL for `VITE_PROXY_BASE` — Python 3 stdlib only, nothing to install):

   ```sh
   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... python3 proxy/deploy.py
   # → Deployed: https://responder-debrief-wms.<account>.workers.dev
   ```

   Subsequent deploys happen automatically on push to `main` touching `proxy/**` (tests via `node proxy/tests.js`, then the same `deploy.py`).

7. **Go live**: push to `main`. `deploy-pages.yml` builds and publishes the frontend; run *Sync catalogs* and *Mirror incidents* once by hand (Actions → workflow → *Run workflow*) to seed B2, after which the crons keep them fresh (catalogs hourly at :07, mirror at 01:25/07:25/13:25/19:25 UTC).

## Data sources & attribution

- **Fire locations, perimeters, hotspots, incident data** — NIFC and CAL FIRE public data, accessed via the [fire-api](https://fire-api-prod.web.app) service.
- **Fire spread & fire-weather forecasts** — WMS services by **Pyrecast LLC** ([pyrecast.org](https://pyrecast.org)). Out of courtesy to their free service, this app never hits their geoservers directly from users' browsers: all requests go through our caching proxy, which serves repeat tiles from the edge cache and keeps upstream load to a minimum. Forecasts are experimental model output — not operational guidance.
- **Incident maps & IR products** — incident-team uploads on [ftp.wildfire.gov](https://ftp.wildfire.gov/public/incident_specific_maps/) (NWCG), mirrored 4×/day with conditional requests and a contact-tagged user agent.
- **Basemap** — [OpenFreeMap](https://openfreemap.org) tiles, © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
- **Design inspiration** — [fires.cornea.is](https://fires.cornea.is).

This is a prototype for gathering user feedback. Verify all operational information through official channels before acting on it.
