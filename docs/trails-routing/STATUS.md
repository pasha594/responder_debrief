# Trails overlay + offline Walk: build status

Overnight build, 2026-09-25, branch `trails-offroad-routing`. Nothing is merged to
`main` and no PR is open. The plan is `FINAL_PLAN.md`.

## Summary for the owner

The whole feature is built on this branch: the worker jobs, the two workflows and
the frontend. Everything builds, and every automated test passes (worker 305,
frontend 482).

**None of it has run against real data yet.** This session's network policy
blocked every data host: USFS, BLM, NPS, LANDFIRE, TNM, Geofabrik, the fire API
and our B2 bucket. The code is therefore tested against local fixtures and a
synthetic "fire" scene that the worker builds with the real GDAL 3.8.4 and
osmium 1.16. Those are the same versions the CI runner installs.

**Your first step:** dispatch **Trails build** with `dry_run` checked, then
**Routing bundles** with `dry_run` checked (optionally `fire=<slug>`). Download
the artifacts. The checklist is at the end of this file.

## What's done

### Worker (Python, `worker/responder_worker/`)

| Area | Module(s) | Notes |
|---|---|---|
| Foundations | `gdal_cli.py`, `utm.py`, `pmtiles_inspect.py`, `http.download_to`, `config.py` | GDAL through the CLI only; raster I/O goes through ENVI/VRT. UTM uses the Krüger series and matches PROJ to about 1 nm. A stdlib PMTiles reader means GDAL 3.8.4 never reads a PMTiles. Key rules: `trails/` and `routing/` are immutable, `work/` is private, pointers live under `catalogs/`. Content types added for pmtiles, fgb, tif, gz and gpkg; Content-Encoding is never set. `numpy` is added to the deps. |
| Trails | `trails_normalize.py`, `trails.py`, `trails_cli.py` (`sync-trails`), `.github/workflows/trails.yml` | Probe, then decide (builds at most weekly), then fetch: the USFS FGDB zip, and BLM/NPS through GDAL ESRIJSON paging with count checks. Then normalize, apply the sanity gate (floors, plus a 10% drop limit), and build GPKG, FGB and PMTiles z7–13 (two-layer CONF, verified on 3.8.4). CPL_DEBUG=MVT counts degraded tiles. Publishes `trails/b{id}/…` first and `catalogs/trails.json` last. Health goes to `catalogs/health/trails.json`. |
| Routing plan | `routing_plan.py`, `perimeters.py`, `routing_cli.py` (`routing-plan`) | The fire list comes from our published `catalog.json`. Perimeters come from `FIRE_API_DEV` using verbatim paths, fetched only when `poly_last_updated` changed. The AOI is the perimeter bbox + 8 km, at least 16 km a side; 30 m cells up to 6.25M cells, else 60 m, else a 150 km clip. It never shrinks and has 2 km hysteresis. Actions are build, check, skip, backoff or unsupported (non-CONUS). Priority is `PRIORITY_FIRES`, then acres. Shards are region-affine. |
| Routing build | `routing_bundle.py`, `landfire.py`, `nhd.py`, `cost_grid.py`, `osm_extract.py`, `graph_build.py` (`routing-build`, `routing-one`, `routing-index`), `.github/workflows/routing.yml` | **LANDFIRE:** `exportImage` in 5070, snapped to the CONUS grid, with a WCS fallback and a per-pixel LF2025/LF2024 mosaic. **NHD:** TNM lookup with the `(HU) 8` / `_HU8_` rule plus `prodFormats` and a total check. Each HU8 is trimmed to perennial streams and perennial water and cached at `work/nhd/`. **Cost model:** GET v2 on terrain slope, packed as pace code + veg class + DEM. **OSM:** Geofabrik leaf regions, then osmium tags-filter and a multi-bbox extract, then an OPL parser. **Graph:** exact OSM topology, with conflation that keeps OSM edges and moves agency names onto them; T5/T6 and via_ferrata are excluded. **Output:** RDG1 graph and a per-fire trails+ways PMTiles. Bundle ids hash the actual AOI inputs, so unchanged fires skip. Each fire's pointer is written last, and the index is rebuilt from pointers only. |

### Frontend (`frontend/src/`)

| Area | Files | Notes |
|---|---|---|
| Trails layer | `map/pmtilesSource.ts`, `map/layers/trailsLayer.ts`, `trailsStyle.ts`, `panels/layers/TrailsRow.tsx` | The `pmtiles` Protocol (npm, approved). Online it reads the national archive (S3 URL preferred); offline it reads the packed per-fire extract from an OPFS `File`. Teal casing and core per ground. OSM ways show only on the offline ground. Popups are escaped and show restrictions plus "Walk here". `rd-trails-hit` is in `FEATURE_LAYERS` and `INTERACTIVE`; the popup yields to route claims, the draw tool and priority features. `trl` URL param. |
| Routing core | `routing/{costModel,pacecode,heap,rasterize,rdg1,gridDecode,hybridGraph,astar,sampler,smooth,legs,engine,safety}.ts` | Pure and node-tested. Hybrid A* uses window-local cells, portals at every densified vertex, a hard perimeter block (60 m standoff, graph included), endpoint snapping ≤150 m, avoidance off when an endpoint is inside the perimeter, and a `blocked_by_perimeter` alternative. Sliced search passes; horizontal-distance times; Sullivan tertiles on trails; GET × α off trail. |
| Worker + Walk | `routing/{offroad.worker,offroadClient,protocol,bundleIndex,hooks}.ts`, `api/walkRouting.ts`, `api/routing.ts`, `panels/walk/*`, `panels/SearchDirectionsControl.tsx`, `map/layers/routeLayer.ts` | Module worker (`worker.format: 'es'`). Buffers are fetched on the main thread through the pack wrapper and transferred to the worker. Walk uses the offline router inside the area; outside it uses ORS/Valhalla plus untimed dotted gaps with ONLINE_NO_PERIM and CROSSES_PERIM. Only Walk reruns when its context changes. Errors are kept per mode; offline Drive/Apparatus show "Needs a connection"; the slow bound leads. Legs draw solid, dashed with vegetation colour, or dotted, with join dots. The card shows the permanent label, notes, avoid toggle, provenance, ODbL line and steps. |
| Vegetation, area, offline | `map/layers/{vegetationLayer,routingAreaLayer}.ts`, `offline/{packModel,packs,opfs}.ts`, `panels/OfflineCard.tsx` | The vegetation canvas is rendered by the worker. The routing-area dashed box shows in Walk. The pack plan adds the index snapshot, the descriptor and 4 immutable files. Range requests bypass the pack. Immutable packed URLs are served pack-first. `packsReady` and `packedFile` added. The packed bundle is preferred offline. |
| Credits and health | `SourcesView.tsx`, `HealthView.tsx`, `README.md` | Credits for USFS, BLM, NPS, OSM (ODbL), LANDFIRE, NHD and the travel-rate research. Per-workflow run strips plus freshness rows from the new health docs. |

## How it was tested

| Command | Result |
|---|---|
| `cd frontend && npm ci && npx tsc --noEmit && npx vitest run && npx vite build` | ci OK, tsc clean, **482 tests pass (49 files)**, build OK. `offroad.worker-*.js` plus the geotiff codec chunks are emitted. |
| `cd worker && uv sync && uv run pytest` | **305 pass.** The GDAL/osmium tests ran for real, not skipped: `apt-get install gdal-bin osmium-tool` gave GDAL 3.8.4+dfsg-3ubuntu3 and osmium 1.16.0 (Ubuntu 24.04, same as CI). |

Key tests:
- **`worker/tests/test_routing_bundle.py`** builds a whole bundle from `tests/routing_scene.py` through gdalwarp, gdal_rasterize, ogr2ogr (FGB, GPKG, PMTiles) and osmium. The synthetic scene has a ridge, timber and brush, a lake, slash, a cliff, a creek, an OSM road and path, and two USFS trails. The test checks upload order (pointer last), descriptor, rasters, graph names, conflation and PMTiles layers, and that a rerun is `unchanged`.
- **`worker/scripts/make_routing_fixture.py`** writes that bundle into `frontend/src/routing/__fixtures__/synthetic/`.
- **`frontend/src/routing/engine.test.ts`** routes on the real worker bytes: road stays on road; the ridge follows `Ridge Trail #101`; cross-country goes through timber; lakeshore snapping works, and a mid-lake pin gets an error; the perimeter detour never enters the fire; an endpoint inside the perimeter gets its note; a ring of fire gives `blocked_by_perimeter` with an alternative; outside the area gives an error. **A\* ≡ Dijkstra** on 40 random grids.
- **`frontend/src/map/pmtilesSource.test.ts`** reads the worker's per-fire PMTiles through the OPFS-style source with the real `pmtiles` library.
- **`test_trails.py`** runs an end-to-end sync on local sources through the GDAL 3.8.4 PMTiles writer.
- **Chromium smoke run** (Playwright + Vite dev; the harness was not committed): the bundle loaded in the worker in 242 ms, the ridge route computed in 59 ms, the perimeter detour and the vegetation image worked. It also found and fixed a bug: servers that label `.gz` files with `Content-Encoding: gzip`, as Vite does, broke graph decoding.
- **Scale check:** a synthetic 240k-vertex OSM network plus 400 agency trails conflates in 15 s. It took minutes before the fix in commit 33fd951.
- **Review:** a separate reviewer read the whole diff. Its 6 findings plus 1 unverified item are fixed in commit 4ca45ee.

## Not verified yet

1. **No real data has run anywhere.** Not verified:
   - the agency service response shapes;
   - GDAL ESRIJSON paging on 3.8.4;
   - LANDFIRE `exportImage` and WCS responses (codes and sizes);
   - TNM JSON, which is parsed per the recorded format; the fixture is reconstructed, not captured;
   - Geofabrik `index-v1.json` ids, parent structure and redirect behaviour;
   - FGDB field names from the live zip.
2. **Golden routes on real terrain** have not run: Iron Creek → Stanley Lake with trail share ≥ 0.85, and the Bob Marshall summit. Nor have phone timings on mid-range devices.
3. **The whole app in a browser** has not been exercised: MapLibre with the trails layer, popups, the Walk card, and offline pack download → airplane mode. Only the worker pipeline ran in Chromium. The OPFS source is unit-tested in node, not in a browser.
4. **National build size and time on the runner** are not measured. The estimate is 160–290 MB and minutes to tens of minutes; `timeout-minutes` is 120.
5. **The EVT lookup table is not used.** Lifeform comes from EVC, with FBFM40 as the fallback. EVT and EVC disagree on about 8.5% of cells; there, EVC's call wins, which is usually herb over shrub or tree and so faster.
6. **Supersede in the browser:** the smoke test's first route finished before the second request arrived, so the superseded path was not exercised. It is covered only by code review.

## Decisions I made (revisit any)

- **Trails default `auto`:** on only on the offline ground, where there is no basemap. An explicit on/off choice wins and persists across fires. USGS Topo already draws trails.
- **Headline time is the slow tertile**, shown as `≤2h 50m`. The card shows range and typical.
- **Perimeter standoff is 60 m.** Hotspots are not a factor in routing, and there is no HOTSPOT_NEAR warning yet (not built).
- **LANDFIRE epoch in the bundle id is monthly.** Every bundle rebuilds about monthly so LF2025 coverage and OSM changes get picked up. That costs roughly 80 CI-minutes a month.
- **Routing cadence is every 3 h**, plus a run after each Trails build. Trails check daily and build at most weekly (≥ 6 days, or any change after 30 days).
- **AOI** is the perimeter bbox + 8 km, minimum 16 km a side. Grids over 6.25M cells switch to 60 m cells; sides over 150 km are clipped.
- **OSM:** apt osmium-tool with a Python OPL parser, not pyosmium. Geofabrik PBFs are not stored in actions/cache.
- **The prune command is not written.** Nothing deletes automatically (convention). README recommends a B2 hidden-version lifecycle rule for `catalogs/` and `work/`.
- **GET's slash multiplier is 5×**, the table value. Snow is 3× and unknown ground 4×; both are my choices, since GET is silent on them.
- **The online fallback** models cross-country gaps with the offline router when both ends are inside the area. Otherwise the gap is a straight untimed line.

## Needs your call

1. **ODbL posture:** graphs and the per-fire `ways` layer are published publicly on B2. The attribution line is in the route card and on the Sources page.
2. **Safety wording:** the label, notes and error texts are in `api/walkRouting.ts`, `routing/engine.ts` and `panels/walk/WalkRouteDetails.tsx`. Should "modeled, not scouted" also apply to online engines?
3. **Whether to use the S3-endpoint URL for PMTiles.** The pointer carries `pmtiles_url_s3` when `B2_S3_ENDPOINT` is set, and the frontend prefers it. Chrome caches it; the native URL is not cached.
4. **AK/HI/PR are unsupported** in v1. The index lists no bundle for them.
5. **Merge strategy.** Other sessions edit `store.ts`, `useMapLayerSync.ts`, `zOrder.ts` and `SearchDirectionsControl.tsx`. My diffs there are small and additive, but they will need a rebase or merge.

## Where to resume

1. Dispatch **Trails build** with `dry_run` checked. Download `trails-dryrun` and check:
   - `catalogs/trails.json` counts are about 75k USFS, 19.5k BLM managed, 5k not assessed and 31k NPS;
   - `uv run python -m responder_worker.pmtiles_inspect out/trails/b*/trails.pmtiles`;
   - the `degraded_tiles` count.

   Fix any source-shape surprises in `trails.py` or `trails_normalize.py`.
2. Dispatch **Routing bundles** with `dry_run` checked and `fire=<a big CONUS fire>`. Inspect:
   - `bundle.json` stats and warnings;
   - `gdalinfo -stats grid.tif`;
   - `graph_build.decode_rdg1` counts.

   Then point a local build at it: copy the `out/` tree under `frontend/public/data/` and use a dev build (DATA_BASE_URL `/data`). Walk the golden routes.
3. Run for real: Trails build, then Routing bundles. Watch the `/health` rows.
4. Browser QA of the full app, including offline: download the pack, switch to airplane mode, then check trails, Walk and vegetation.
5. Later work: HOTSPOT_NEAR, the EVT LUT (recipe 2), a manual prune command, GPX export, phone timing.
