# directions

## Summary
All paths below are relative to (repo root) (branch trails-offroad-routing, HEAD 69858dc, the same as main). The installed versions are maplibre-gl 5.24.0, geotiff 2.1.3, vite 6.4.3, vitest 2.1.9, TypeScript 5.9.3, React 18.3.1 and zustand 5.0.15. `tsc --noEmit` passes on this tree today.

DIRECTIONS TODAY
- frontend/src/api/routing.ts is a stateless, online-only client with three profiles, `RouteProfile = 'drive' | 'hike' | 'apparatus'` (:14).
  - drive: TomTom with live traffic when VITE_TOMTOM_KEY is set, silently falling back to the OSRM public demo.
  - apparatus: TomTom truck mode using APPARATUS_DIMS, with deliberately no fallback (:249-253).
  - hike, labelled "Walk" in the UI: openrouteservice foot-hiking POST when VITE_ORS_KEY is set, silently falling back to FOSSGIS Valhalla pedestrian GET (:264-271).
- Every engine is normalized to `RouteResult {geometry: {type: 'LineString', coordinates}, distanceM, durationS, trafficDelayS|null, steps: RouteStep[], engine: 'tomtom'|'osrm'|'ors'|'valhalla'}` (:35-43). Errors are a bare `routing ${status}` throw from getJson (:50-54). There is no AbortSignal and no timeout. `fetchReachableRange` returns TomTom or Valhalla isochrone rings.
- State lives in the zustand slice `directions {a, b: {coords, label}|null, profile, route: RouteResult|null, armed}` (store.ts:129-136, initial value at :318).
  - `setDirectionsPoint` and `setDirectionsProfile` null the route.
  - `clearDirections` keeps the profile but also wipes the range rings and stops location tracking.
  - `selectFire` resets everything except the profile. It still carries a stale `picking: null` field (:371).
  - `routeClickClaims()` (:249-251) decides whether a map click claims an endpoint. It is true when exactly one slot is empty, or when the bar is armed with neither slot set.
- panels/SearchDirectionsControl.tsx is mounted only inside the fire map shell (App.tsx:234-236).
  - When both ends exist, it fetches EVERY profile in parallel: ['drive','apparatus','hike'], or ['drive','hike'] without the TomTom key. This is keyed on the endpoint-coordinate string, guarded by a routeSeq counter, and emits `directions_requested {modes}` (:374-407).
  - Each result goes into local `modes` state (RouteResult | 'pending' | 'failed'). The active profile's result goes through `applyRoute` (:355-372), which stores it and fits the bounds from `geometry.coordinates`.
  - Switching profile re-applies from cache (:409-422).
  - Mode buttons show '…', '—' or a short duration (:466-497).
  - The summary shows bold duration · miles · traffic delay, plus an isochrone checkbox that is hidden for hike (:559-605).
  - Route steps are never rendered (the .rd-sd-steps CSS is dead), and neither is the engine.
  - There are only two error strings: 'No apparatus-legal route found for these points.' and 'No route found — try different points.' (:398-402, :415-419). They also show for network or offline failures.
  - Endpoints are draggable maplibre Markers. dragend writes a 'lat, lon' label through setDirectionsPoint, which refetches every mode (:309-336).
  - Map clicks that set points live in useMapLayerSync.ts:281-322. An active draw tool wins. Idle clicks are ignored. If routeClickClaims is true, the click fills the missing slot. With both ends set, clicks on INTERACTIVE feature layers keep their popups; empty-map clicks move B. Layer popups yield via `if (routeClickClaims(...)) return` (hotspotLayer.ts:203, incidentsLayer.ts:26, historicPerimetersLayer.ts:58).
- Drawing: routeLayer.ts sets one Feature with the route's LineString and empty properties on the 'rd-route' source. That source feeds two line layers, 'rd-route-casing' (#0d0a0c, width 7) and 'rd-route-line' (#4aa3ff, width 4). Updates are identity-diffed. rangeLayer.ts draws the rings as a FeatureCollection with data-driven colors (RANGE_COLORS). Both layers sit at the top of RD_LAYER_ORDER (zOrder.ts:33-34, 55-56), and both managers are last in MANAGERS (useMapLayerSync.ts:79-81).
- Analytics: `track`/`trackOncePer` in app/analytics.ts, limited to 30 events/min and 300 per page load. Directions events are directions_requested, range_requested {engine}, place_searched {kind} and location_used {context}. There is no event for a profile switch or for route success or failure.

IN-BROWSER COMPUTE PRECEDENTS
- There is no Web Worker anywhere in frontend/src. The only worker-like code is the service-worker registration (main.tsx:58-64).
- vite.config.ts has no `worker` key, so Vite's default `worker.format: 'iife'` applies. I verified with a scratch build that a module worker importing geotiff FAILS to build under iife ("UMD and IIFE output formats are not supported for code-splitting builds"). It builds fine with `worker: {format: 'es'}`, emitting geotiff's decoder chunks next to the worker chunk.
- The generated service worker precaches all of dist/assets (build-sw.mjs:40-47), so a worker chunk and its decoder chunks would work offline automatically.
- geotiff runs on the MAIN thread today:
  - `decodeSpreadTiff(buf, maxWidth = 1536)` (toaRenderer.ts:59-81) uses fromArrayBuffer → getImage → readRasters({width, height}). That resamples nearest-neighbour whenever the native width is over 1536.
  - It requires a UTM ProjectedCSTypeGeoKey of 326xx or 327xx and throws otherwise.
  - It derives corner pins with the hand-rolled inverse UTM in utm.ts. utm.ts has NO forward lon/lat→UTM function.
  - ToaRenderer.load fetches, decodes and asserts a Float32Array. ProductRenderer untars and decodes with an LRU. No geotiff Pool is used.
  - Supported codecs are raw, LZW, Deflate, PackBits, JPEG, LERC and WebImage. Standalone ZSTD is not supported.
  - geotiff's `writeArrayBuffer` round-trips a UTM-keyed Uint8 GeoTIFF in Node (verified), so vitest fixtures are easy to make.
- The offline pack serving layer only wraps `window.fetch` on the main thread (packs.ts:125-167). A Web Worker's own fetch, and MapLibre's own vector-tile fetches, bypass it (verified in maplibre-gl-dev.js makeRequest). Offline-capable routing data must therefore either be fetched on the main thread and transferred to the worker, or read from OPFS directly.
- api/geo.ts holds bbox and projection helpers (3857, geometryBounds) but no distance function. The great-circle distanceMiles lives in directory/rowModel.ts:273. Uncommitted work in the main checkout moves it into geo.ts.

PERIMETERS
- Perimeters come from fire-api (external, CORS *):
  - usePerimeterIndex(corneaId) → [{path, date}], sorted ascending.
  - usePerimeterVersion(path) → `PerimeterFeature = GeoJSON.Feature<Polygon|MultiPolygon, Record<string, unknown>>` in lon/lat, cached forever.
- useMapLayerSync resolves the version for the PLAYHEAD time (framePlan.resolvePerimeterVersion), not the newest one. For avoidance the router should pick the newest by date, the way packModel.ts:156 does.
- Offline packs contain the latest perimeter plus the last 7 days of versions.

DEM
- terrainControl uses AWS terrarium raster-dem tiles (maxzoom 15, exaggeration 1.2). They are not in offline packs, and the offline style is a blank background with no glyphs.
- map.queryTerrainElevation returns null without terrain and scales values by the exaggeration. It only covers loaded tiles and cannot be called from a worker. Elevation for routing should therefore come from a DEM or cost grid that the worker bakes.

## Extension points
- vite.config.ts:23-30: add `worker: { format: 'es' }` to defineConfig. This is REQUIRED if the router worker imports geotiff: the default iife build fails because geotiff's decoders are dynamic imports (verified in a scratch build). Create the worker with `new Worker(new URL('./offroad.worker.ts', import.meta.url), { type: 'module' })`, or `import W from './offroad.worker.ts?worker'` (typed by vite/client.d.ts:205).
- New modules, suggested at frontend/src/routing/: pure A*/graph/grid modules (node-testable) + a thin offroad.worker.ts shell + a main-thread client that creates the worker lazily as a module singleton (not at import time, or vitest imports would break), with request ids and transfer lists. Worker file typing under the existing DOM lib: `self.onmessage = (e: MessageEvent<Req>) => {...}; self.postMessage(msg, { transfer: [buf] })` type-checks with the project's flags (verified). Don't add lib 'WebWorker'.
- Offline-safe data path: fetch routing blobs on the MAIN thread through the wrapped window.fetch (packs.ts:125-167), then transfer the ArrayBuffers to the worker. Alternative: the worker reads OPFS itself using opfs.ts readPackFile(slug, await fileNameForUrl(url)) (opfs.ts:43-48, 63-73); those APIs are worker-safe, but the url→file index lives only in main-thread memory (packs.ts:63).
- Grid decode: reuse decodeSpreadTiff(buf, maxWidth) (toaRenderer.ts:59-81), but pass maxWidth >= native width to avoid nearest-neighbour downsampling (default MAX_DECODE_WIDTH=1536, :29). Better, extract it into a DOM-free module, since toaRenderer.ts also carries the canvas class. The grid must be UTM (EPSG 326xx) or it throws (:65-67). Returned grid.bboxUtm/width/height give the affine; corners/bounds are for drawing.
- utm.ts:33-78 has only the inverse. Add a forward `lonLatToUtm(lon, lat, zone, northern)` (Snyder series, same constants :8-16) plus utm.test.ts round-trip tests, to map A/B points and perimeter vertices into grid cells. Use utmToLonLat to turn path cells back into [lon, lat].
- routing.ts:14 and :35-43: either add a new profile (e.g. 'foot'/'xc') or re-point 'hike'. Extend RouteResult with optional fields, e.g. `legs?: {kind: 'road'|'trail'|'xc', veg?: number, coordinates: [number, number][], distanceM, durationS}[]`, `durationRangeS?: [number, number]`, `modeled?: boolean`, and add an engine literal (e.g. 'offroad'). Keep `geometry` as the full LineString so the two existing consumers keep working.
- routing.ts:244-272 fetchRoute: its signature (a, b, profile) has no fire context. Add an options arg (slug/routing asset URLs, latest perimeter, avoidPerimeter) or a separate routeOffroad() entry. Decide whether to fall back to ORS→Valhalla or, like apparatus at :249-253, deliberately NOT fall back silently.
- SearchDirectionsControl.tsx:381-383 is the profile list fetched in parallel; :209-213 is MODES (icon/label/title). :351 is ModeState. :469-476 is the per-mode time label, which must format a range. :355-372 applyRoute computes bounds from geometry.coordinates, so update it if legs replace geometry. :559-578 is the result summary: add the time range, 'modeled, not scouted' wording, a trail vs cross-country legend and data-age notes. :398-402/:415-419 are the error strings: add offline/no-data/outside-grid/blocked-by-perimeter messages.
- routeLayer.ts:44-55: build a FeatureCollection from legs, with properties {kind, veg} or {kind, color}. Keep rd-route-casing, keep rd-route-line for solid road/trail legs filtered on kind, and add a dashed cross-country layer (e.g. 'rd-route-xc') with line-dasharray and data-driven line-color by vegetation. Follow the drawLayer.ts:83-130 convention of one filtered layer per dash class. Register the new ids in zOrder.ts RD_LAYER_ORDER between/after :55-56, because RdLayerId (:59) is derived from that array.
- store.ts:129-136 directions slice: add e.g. `avoidPerimeter: boolean` (default true) and a routing status if needed. Add actions at :208-215/:526-560 and keep the reset rules consistent in selectFire (:369-376) and clearDirections (:551-560), where profile persists across both.
- Perimeter for avoidance: in the control (fire mode only), use usePerimeterIndex(corneaId) + usePerimeterVersion(latestPath) (queries.ts:42-58), which share cache keys with the map. Pick the latest version by date the way packModel.ts:156 does (`perims.reduce((a, b) => ts(b) > ts(a) ? b : a)`), NOT the playhead version (useMapLayerSync.ts:175-179). Send the Polygon/MultiPolygon coordinates to the worker and rasterize them to a grid mask (optionally buffered).
- Offline pack: packModel.ts PackInputs (:108-123) + buildPackPlan (:140-252) to add the per-fire routing files (graph, cost/veg tif, DEM tif, trail tiles) with an EST size (:46-55). Take their paths from a new optional CatalogFire field (types.ts:101-140, like hotspot_archive at :128, guarded as optional) that packs.ts runDownload (:265-301) reads. Optionally extend opfs.ts:46 ext regex and packs.ts:82-88 contentTypeFor for .bin/.pbf.
- Vegetation overlay: copy spreadForecastLayer's canvas-source adopt pattern (spreadForecastLayer.ts:138-179) with corners from utmBoundsTo4326 and a LUT paint like productRenderer.buildLut/paintProduct (:66-129). Add a layer id to RD_LAYER_ORDER (below-label raster group, zOrder.ts:14-29). Add a toggle in store.layers (:81-116) with a toggle action that calls track('layer_toggled', {layer, on}) (pattern :468-490), reset it in selectFire (:358-367), add a checkbox in ForecastTab MapLayerToggles (:325-368), and optionally a URL flag in urlState.ts (:101-105, :150-156) and a legend in LegendBar.
- Click arbitration for any new clickable layer (trail popups): add its layer id to INTERACTIVE (useMapLayerSync.ts:289-292), and start its onClick with `if (routeClickClaims(useStore.getState().directions)) return;` (hotspotLayer.ts:202-207 pattern).
- Analytics: add explicit events next to directions_requested (SearchDirectionsControl.tsx:386), e.g. track('offroad_route_computed', {ms, xc_share, avoided_perimeter}). Use trackOncePer('fire-view', ...) for repeated drag recomputes so the 30/min limit (analytics.ts:30) isn't consumed.
- Sources/credits: add USFS/BLM/NPS trails, LANDFIRE and OSM entries to SourcesView.tsx SOURCES (:12+).

## Conventions
- TypeScript strict with noUnusedLocals, noUnusedParameters, noFallthroughCasesInSwitch and isolatedModules. `import type` for type-only imports. Casts to maplibre internals go through `as unknown as` (useMapLayerSync.ts:118-121). The `build` script runs `tsc --noEmit && vite build && node scripts/build-sw.mjs`, but tsconfig excludes src/**/*.test.ts, so tests are NOT type-checked.
- Tests: vitest 2, node environment, include src/**/*.test.ts only (no .tsx/component tests), co-located next to the module. Explicit `import { describe, expect, it } from 'vitest'`. Pure functions are preferred. Maps are faked with minimal objects cast `as unknown as MlMap` (zOrder.test.ts:11-25). Network is stubbed by swapping globalThis.fetch and restoring it in finally (queries.test.ts:51-73). vi.mock/vi.stubEnv appear only in analytics.test.ts. There is no Worker, DOM or canvas in tests, so routing logic must live in pure modules; geotiff.writeArrayBuffer can create UTM GeoTIFF fixtures in node (verified).
- Pure logic is split from DOM and map code and documented as such, e.g. packModel.ts 'Pure pack planning', scaleReadings.ts 'pure — panels own the DOM', toaBands.ts 'Pure data + math only'. Heavy loops are plain typed-array loops (paintToa, paintProduct).
- Layer managers are module-level singletons implementing LayerManager. mount() is idempotent (check getSource/getLayer before adding) and resets module state. update() is cheap and identity-diffed against a module-level `lastX` before setData or setLayoutProperty. unmount() removes layers then sources. All ids are prefixed 'rd-' and inserted with beforeIdFor(map, id) from zOrder.ts. Colors are hex constants in the layer file.
- State: one zustand store with nested slices replaced immutably, and all mutators under `actions`. Analytics calls live inside actions (store.ts:452-533). Server data belongs in TanStack Query 'never duplicated here' (store.ts:1-4); directions.route is the pragmatic exception. Components read with selectors, and imperative code reads with useStore.getState().
- Async staleness is guarded with sequence counters or tokens rather than aborts: routeSeq/rangeSeq (SearchDirectionsControl.tsx:230, 238), renderToken (productRenderer.ts:197), loadingKey (spreadForecastLayer.ts). New worker requests should follow the same drop-stale pattern.
- Minimal dependencies (owner preference): hand-rolled UTM, tar, polyline decoding and scale math instead of npm packages. Only 7 runtime deps. A hand-rolled typed-array A* matches this.
- Comments are explanatory prose headers at the top of each file giving the why (see routing.ts:1-12, spreadForecastLayer.ts:1-19). Inline comments explain tradeoffs. `// eslint-disable-next-line react-hooks/exhaustive-deps` comments exist although ESLint is not installed.
- Every fetch that should work offline must go through the main-thread window.fetch wrapper (installed first in main.tsx:40). Downloads for packs use rawFetch (packs.ts:113-119).
- Units in the directions UI are miles only (fmtDistance, SearchDirectionsControl.tsx:28-31). Durations use fmtDuration/fmtDurationShort, which are local to the file, not in utils/format.ts. The scale bar shows mi + km.
- Feature gating by build-time env flag: `export const apparatusAvailable = !!import.meta.env.VITE_TOMTOM_KEY` (routing.ts:28). Optional catalog fields are guarded because older or CDN-cached catalogs omit them (types.ts:115-118 comment).

## Risks
- BUILD BREAK: a router worker that imports geotiff will fail `vite build` unless vite.config.ts sets `worker: { format: 'es' }` (verified). Module workers need a modern browser; that is fine for this app.
- OFFLINE DATA PATH: a Web Worker's fetch does not go through the OPFS pack wrapper (packs.ts:125-167), so offline routing data fetched inside the worker 404s or fails. Fetch on the main thread and transfer, or read OPFS from the worker. The same trap hits MapLibre vector tiles for the Trails layer: tiles are fetched in MapLibre's worker, so offline trail tiles need maplibregl.addProtocol or a main-thread fetch path.
- GRID FORMAT CONSTRAINTS for the Python worker output:
- decodeSpreadTiff accepts only UTM 326xx/327xx GeoTIFFs, but LANDFIRE's native CRS is Albers, so the cost grid must be warped to UTM.
- Compression must be DEFLATE or LZW; standalone ZSTD is undecodable by geotiff 2.1.3.
- The client must pass a large maxWidth, or cells are silently nearest-neighbour downsampled to 1536 px.
- No forward lon/lat→UTM exists; it must be added and tested. Otherwise A/B points and perimeter vertices can't be mapped into grid cells.
- RouteResult.geometry is consumed in two places: applyRoute's fitBounds (SearchDirectionsControl.tsx:359-365) and routeLayer setData (routeLayer.ts:49-53). Changing to multi-leg without keeping a full LineString breaks both. The mode-button time and the summary assume a single durationS number.
- All-mode parallel fetching reruns on every endpoint change, including each marker drag. Offline, the drive, apparatus and hike network calls all fail and show the misleading 'No route found — try different points.' There is no timeout, so a hung community server leaves '…' forever. The offline router needs its own error states: no routing data for this fire, point outside grid, destination unreachable/blocked by perimeter, impassable.
- Superseded worker queries: a synchronous A* can't be interrupted mid-run. Use request ids to drop stale results, and bound the search window or cap iterations, or terminate and recreate the worker. React StrictMode double-invokes effects in dev, so create the worker as a lazy module singleton, or terminate it in cleanup.
- Avoidance must use the LATEST perimeter version, not ctx.perimeterFeature (the playhead version). Offline, it depends on the pack having the latest perimeter (it does, per packModel.ts:156). Perimeters can be large MultiPolygons (EST 1.2 MB), so rasterize them in the worker. The fire moves faster than weekly trail bakes, so avoidance has to happen at query time.
- Elevation cannot come from MapLibre: queryTerrainElevation is viewport-bound and multiplied by the 1.2 exaggeration, terrarium tiles aren't packed, and the offline style has no DEM. The worker must bake DEM/slope into the per-fire grid or ship an Int16 DEM tif.
- Uncommitted WIP in the main checkout (hotspot-flames branch) edits store.ts, useMapLayerSync.ts (the click handler gains dropped-pin semantics and a pin card that hands off a Directions B point), zOrder.ts (ensureOrder rewritten to use getLayersOrder, new rd-hotspot-flames id), SearchDirectionsControl.tsx, geo.ts and panels.css. Expect merge conflicts, and design map-click arbitration assuming idle clicks will drop a pin.
- Tests run in a node env without Worker, DOM or canvas, and test files are not type-checked by tsc. Keep A*, grid, graph, rasterize and projection code in pure modules with their own *.test.ts. The worker shell and control wiring will be untested unless verified in the browser.
- Offline text labels: OFFLINE_STYLE has no glyphs, so symbol text layers (e.g. leg labels, trail names) won't render offline. Use DOM Markers/Popups or accept label loss offline.
- Analytics rate limits (30/min) are easy to burn through with per-drag route events. directions_requested already fires on every endpoint change; use trackOncePer for new events.
- The routing.ts header (:10-11) claims a closures disclaimer that the UI doesn't show. The new 'modeled, not scouted' label would be the first routing disclaimer, and the owner may want it applied to the network engines too.
- Memory on phones: a 50x50 km, 30 m grid is about 2.8M cells, several typed arrays in the worker (the research estimates about 40-73 MB of working memory for A* on 4M cells). Transferring rather than copying ArrayBuffers and bounding the search window matter.
- Open question: does the offline router replace Walk ('hike') when data exists, or become a fourth mode (e.g. 'Cross-country')? The profile list (SearchDirectionsControl.tsx:381-383), MODES (:209-213), RouteProfile (routing.ts:14) and the store's persisted profile across fire switches (store.ts:370) all depend on that choice.

## Facts
- There is no Web Worker usage in frontend/src; the only worker is the PWA service worker registration. — grep for 'new Worker|?worker|postMessage|OffscreenCanvas' over frontend/src found only main.tsx:58-64 (navigator.serviceWorker.register)
- Vite's default worker format is 'iife', and a worker importing geotiff fails to build under it; it builds with worker.format 'es'. — node_modules/vite/dist/node/index.d.ts:3873-3876 (@default 'iife'); scratch build error: 'Invalid value "iife" for option "worker.format" - UMD and IIFE output formats are not supported for code-splitting builds.' With 'es' it emitted router.worker-*.js plus deflate/lzw/jpeg/lerc/packbits/raw/webimage chunks
- vite.config.ts sets no worker options. Vitest runs in the node environment over src/**/*.test.ts. — frontend/vite.config.ts:23-30
- routing.ts defines RouteProfile 'drive'|'hike'|'apparatus'. RouteResult is a single LineString plus distanceM, durationS, trafficDelayS, steps and an engine union of tomtom|osrm|ors|valhalla. — frontend/src/api/routing.ts:14, :35-43
- fetchRoute fallbacks: apparatus uses TomTom truck with no fallback; drive uses TomTom (if key) then OSRM demo; hike uses ORS foot-hiking (if key) then FOSSGIS Valhalla pedestrian. — frontend/src/api/routing.ts:244-272
- Routing fetches have no AbortSignal or timeout; errors are a generic 'routing {status}' throw. — frontend/src/api/routing.ts:50-54
- The control fetches every available profile in parallel whenever the endpoint coordinates change, guarded by a routeSeq counter; the active profile's result is applied and the others are cached in local state. — frontend/src/panels/SearchDirectionsControl.tsx:351-407
- Profile switch applies a cached result when directions.route is null; setDirectionsProfile nulls the route. — SearchDirectionsControl.tsx:409-422; store.ts:547-548
- applyRoute stores the route and fits bounds computed from result.geometry.coordinates, with padding that depends on container width. — frontend/src/panels/SearchDirectionsControl.tsx:355-372
- Only two error messages exist for route failure, and network or offline failures show them too. — frontend/src/panels/SearchDirectionsControl.tsx:398-402, :415-419
- RouteResult.steps and engine are never rendered. The .rd-sd-steps CSS exists but no JSX uses it. — grep '.steps' outside routing.ts returns nothing; panels.css:2079-2081; SearchDirectionsControl.tsx:559-578 renders only duration, distance and traffic delay
- routing.ts's header says the UI tells users the engines don't know fire closures, but no such text exists in the UI. — routing.ts:10-11 vs grep -i 'closure' in src/panels, src/app (only an unrelated ForecastTab label)
- The isochrone rings toggle is disabled and hidden for the hike profile. — SearchDirectionsControl.tsx:428, :566, :582
- Endpoint markers are draggable maplibre Markers; dragend writes a 'lat, lon' label via setDirectionsPoint, which nulls the route and triggers a full parallel refetch. — SearchDirectionsControl.tsx:309-336; store.ts:526-529; effect keyed on endpointsKey :353, :407
- Map-click endpoint setting lives in useMapLayerSync. A draw tool wins; idle clicks are ignored; routeClickClaims fills the missing slot; with both set, clicks on INTERACTIVE layers keep popups and others move B. — frontend/src/map/useMapLayerSync.ts:281-322; store.ts:247-251
- The directions armed flag follows search-input focus. — SearchDirectionsControl.tsx:519, :542 (onFocusChange → setDirectionsArmed)
- clearDirections also clears range rings and resets location tracking; selectFire resets directions but keeps the profile, and includes a stale `picking: null` field. — frontend/src/state/store.ts:551-560, :369-376
- The route is drawn as one Feature with the route's LineString and empty properties; casing is #0d0a0c width 7 opacity 0.7, line is #4aa3ff width 4; setData happens only on identity change. — frontend/src/map/layers/routeLayer.ts:17-54
- Route and range layers are at the top of the canonical z-order, and RdLayerId is derived from that array. — frontend/src/map/zOrder.ts:33-34, :55-56, :59
- The repo convention is one filtered layer per dash class, although the installed style spec (24.10.0) marks line-dasharray as cross-faded-data-driven. — drawLayer.ts:84-130; node check of @maplibre/maplibre-gl-style-spec latest.json paint_line['line-dasharray']['property-type'] = 'cross-faded-data-driven'
- Directions analytics events: directions_requested {modes}, range_requested {engine}, place_searched {kind} (A only), location_used {context}. There is no profile-switch or route-result event. — SearchDirectionsControl.tsx:303, :386, :437, :448, :629
- Analytics limits are 30 events/min and 300 per page load; trackOncePer dedupes per scope, and 'fire-view' is reset on selectFire. — frontend/src/app/analytics.ts:30-31, :60-90; store.ts:345
- decodeSpreadTiff is the only geotiff decode path. It runs on the main thread, resamples to at most 1536 px wide, and throws for non-UTM (326xx/327xx) geokeys. — frontend/src/spread/toaRenderer.ts:23, :29, :59-81
- geotiff 2.1.3 decodes raw, LZW, Deflate, PackBits, JPEG, LERC (with inner zstd) and WebImage. It has no standalone ZSTD (compression 50000) decoder. — node_modules/geotiff/dist-module/compression/index.js addDecoder registry
- No geotiff Pool (worker decoding) is used anywhere. — grep 'Pool' in src: none; geotiff exports Pool (geotiff.d.ts:243)
- geotiff writeArrayBuffer produces a UTM-keyed Uint8 GeoTIFF that fromArrayBuffer reads back in Node (usable as vitest fixtures); an uncompressed 1700x1700 Uint8 decoded in about 21 ms on this Mac. — scratchpad rt.mjs output: '40 30 32611 [600000, 4199100, 601200, 4200000] Uint8Array'; '1700^2 decode ms 21'
- utm.ts implements only UTM→WGS84 (inverse) plus zone parsing and corner pins; there is no lon/lat→UTM forward function. — frontend/src/spread/utm.ts:19-111
- api/geo.ts has no distance helper on this branch; the great-circle distanceMiles is in directory/rowModel.ts. — frontend/src/api/geo.ts (whole file); frontend/src/directory/rowModel.ts:273-281
- The offline fetch wrapper patches only window.fetch on the main thread. MapLibre's worker-side vector-tile fetches use the worker's own fetch for https URLs, so they bypass it; a custom Web Worker's fetch would bypass it too. — frontend/src/offline/packs.ts:125-167; maplibre-gl-dev.js:9960-9986 (makeRequest → makeFetchRequest in worker), :44504 (getArrayBuffer in vector tile worker source)
- The service worker precaches every file in dist/assets, so Vite worker chunks and geotiff decoder chunks would be available offline. — frontend/scripts/build-sw.mjs:40-47, :99-101
- Pack file naming keeps an extension only for png|json|geojson|tif|tar|pdf, and the served content-type defaults to application/json. — frontend/src/offline/opfs.ts:46; frontend/src/offline/packs.ts:82-88
- Perimeters come from fire-api as an index of {path, date} and per-version GeoJSON Feature<Polygon|MultiPolygon> in lon/lat, cached forever. — fireApi.ts:51-64; queries.ts:42-58; types.ts:77-80, :97
- The map shows the perimeter version at the PLAYHEAD, not necessarily the latest. — useMapLayerSync.ts:175-181; framePlan.ts:33-42
- Offline packs include the latest perimeter plus all versions from the last 7 days, plus the perimeter index snapshot. — frontend/src/offline/packModel.ts:126-138, :149-161
- The DEM is AWS terrarium raster-dem (maxzoom 15) with terrain exaggeration 1.2. queryTerrainElevation returns null without terrain and multiplies by the exaggeration. — terrainControl.ts:10-29; maplibre-gl.d.ts:9199-9207
- The offline map style is a bare background with no glyphs, and DEM tiles are not packed, so offline there is no terrain and no rd- text labels. — frontend/src/map/MapRoot.tsx:47-58, :82-91; packModel.ts header :6-10 (basemap out of v1)
- The existing tree type-checks cleanly. A worker-style file using self.onmessage and self.postMessage(msg, {transfer}) type-checks under the project's DOM-only lib settings. — `tsc --noEmit -p frontend/tsconfig.json` exit 0; scratchpad w1.ts/m.ts with --lib ES2022,DOM,DOM.Iterable --strict exit 0
- The app is wrapped in React.StrictMode, so effects run twice in dev. — frontend/src/main.tsx:66-72
- The canvas-source raster overlay pattern: decoded grid painted into a canvas, added as a 'canvas' source with UTM-derived corner coordinates and animate:true. — frontend/src/map/layers/spreadForecastLayer.ts:138-179
- The main checkout ((main checkout), branch hotspot-flames at 945f61b, behind main) has uncommitted WIP in files this feature will touch:
- store.ts adds a droppedPin slice, and setDirectionsPoint clears droppedPin.
- useMapLayerSync.ts adds hotspotFlamesLayer and makes idle clicks drop a pin.
- zOrder.ts rewrites ensureOrder and adds 'rd-hotspot-flames'.
- SearchDirectionsControl.tsx now imports MY_LOCATION_LABEL from geolocation.
- geo.ts gains distanceMiles.
- panels.css changes. — `git -C (main checkout) diff --stat` and file diffs; untracked DroppedPin.tsx, pinDrop.ts, hotspotFlamesLayer.ts

## Files
- frontend/src/api/routing.ts: Engine client. Contains RouteProfile (:14), RouteResult (:35-43), the TomTom/OSRM/ORS/Valhalla adapters, fetchRoute profile/fallback flow (:244-272), decodePolyline6 (:187-209) and fetchReachableRange (:322-336). The offline foot router plugs in here.
- frontend/src/api/routing.test.ts: Existing routing tests: decodePolyline6 fixture and APPARATUS_DIMS sanity. Only pure functions are tested; no fetch stubbing.
- frontend/src/state/store.ts: Zustand store: directions slice (:129-136, init :318), range (:118-120), location (:122-127), offline.online (:146-153), directions actions (:526-560), routeClickClaims (:247-251), selectFire reset (:369-376).
- frontend/src/panels/SearchDirectionsControl.tsx: Directions UI: PlaceInput autocomplete, MODES (:209-213), draggable endpoint markers (:309-346), parallel all-mode fetch (:374-407), cache apply on profile switch (:409-422), applyRoute fitBounds (:355-372), result summary and error text (:555-605).
- frontend/src/map/layers/routeLayer.ts: Draws directions.route as one Feature with the route's LineString and empty properties on the rd-route source, feeding rd-route-casing and rd-route-line; identity-diffed setData.
- frontend/src/map/layers/rangeLayer.ts: Isochrone rings as a FeatureCollection with data-driven color; exports RANGE_COLORS used by the control's legend.
- frontend/src/map/useMapLayerSync.ts: Assembles LayerContext (directions/range at :212-213), MANAGERS order (:64-82), map-click → route endpoint arbitration with the INTERACTIVE list (:281-322), perimeter version by playhead (:175-181).
- frontend/src/map/layerTypes.ts: LayerContext (:21-46) and LayerManager mount/update/unmount contract (:48-55).
- frontend/src/map/zOrder.ts: RD_LAYER_ORDER (:9-57). RdLayerId type (:59) gates beforeIdFor, so new rd- layer ids must be added here. Also ensureOrder.
- frontend/src/map/layers/drawLayer.ts: Precedent for dashed lines: one filtered layer per dash class (:83-130, comment at :84), coalesce'd data-driven line-color.
- frontend/src/app/analytics.ts: track (:60-68), trackOncePer (:72-86) and resetScope; rate limits 30/min and 300/page load (:30-31).
- frontend/vite.config.ts: No worker config (default format 'iife'). Vitest config: node env, src/**/*.test.ts.
- frontend/tsconfig.json: strict, noUnusedLocals/Parameters, noFallthroughCasesInSwitch, isolatedModules, lib ES2022+DOM+DOM.Iterable (no WebWorker), skipLibCheck, excludes *.test.ts.
- frontend/src/spread/toaRenderer.ts: decodeSpreadTiff (:59-81), the only geotiff decode path: UTM-only, downsamples to MAX_DECODE_WIDTH=1536 (:29). ToaRenderer.load does fetch → arrayBuffer → decode on the main thread (:229-237).
- frontend/src/spread/productRenderer.ts: Tar-bundle LRU and per-member geotiff decode (memberArrayBuffer :143-146, setTimeout yield before untar :162, decode LRU :222-238). Precedent for multi-file bundles.
- frontend/src/spread/untar.ts: Zero-copy USTAR reader (pure, DOM-free). Could unpack a per-fire routing tar (graph + grids) inside the Web Worker.
- frontend/src/spread/utm.ts: Hand-rolled UTM inverse (utmToLonLat :34-78), epsgToUtm (:19-26), utmBoundsTo4326 corner pins (:94-111). No forward projection.
- frontend/src/map/layers/spreadForecastLayer.ts: Canvas-source raster overlay pattern: decoded grid → canvas → corner-pinned 'canvas' source (adopt :138-179, beginLoad :181-222). The template for the optional vegetation layer.
- frontend/src/api/geo.ts: Bounds4326, padBounds, snapBoundsOut, parseFireCoordinates, 3857 helpers, frameDims, boundsToImageCoords, geometryBounds (:120-139). No distance helper on this branch.
- frontend/src/directory/rowModel.ts: distanceMiles great-circle helper (:273-281). The only distance function in the tree.
- frontend/src/api/queries.ts: usePerimeterIndex (:42-48), usePerimeterVersion (:51-58, staleTime Infinity), prefetch neighbors, useMasterCatalog (catalogFire → fire_slug).
- frontend/src/api/fireApi.ts: fetchPerimeterIndex (:51-55) and fetchPerimeterByPath (:62-64, path used verbatim) against FIRE_API.
- frontend/src/api/types.ts: PerimeterIndexItem (:77-80), PerimeterFeature (:97), CatalogFire (:101-140, optional per-fire paths like hotspot_archive :128). Place for a routing-manifest path.
- frontend/src/timeline/framePlan.ts: resolvePerimeterVersion (:33-42): picks the perimeter version at the playhead, not the latest.
- frontend/src/map/layers/perimeterLayer.ts: Draws the playhead perimeter; holds the last shape through version gaps.
- frontend/src/map/layers/terrainControl.ts: Terrarium raster-dem source rd-dem from s3 elevation-tiles-prod (:10-11), maxzoom 15, setTerrain exaggeration 1.2 (:28).
- frontend/src/offline/packs.ts: Main-thread window.fetch wrapper for offline serving (:125-167), rawFetch (:118-119), contentTypeFor (:82-88), runDownload pack assembly (:246-403).
- frontend/src/offline/packModel.ts: Pure pack plan: PackInputs (:108-123), buildPackPlan (:140-252), latest-perimeter selection (:149-161), EST sizes (:46-55). Routing files get added here.
- frontend/src/offline/opfs.ts: OPFS helpers (worker-safe APIs): fileNameForUrl sha256 naming with ext regex png|json|geojson|tif|tar|pdf (:43-48), readPackFile (:63-73).
- frontend/scripts/build-sw.mjs: Service worker precaches every dist/assets file (:40-47), so worker chunks work offline. Never touches data.
- frontend/src/main.tsx: installOfflineFetch before anything (:40-41); React.StrictMode (:67); QueryClient networkMode 'always'.
- frontend/src/map/MapRoot.tsx: useMap(); OFFLINE_STYLE is a blank background with no glyphs or sprite (:47-58); style swaps carry rd- sources and layers plus terrain.
- frontend/src/panels/tabs/ForecastTab.tsx: MapLayerToggles (:325-368): where a Vegetation/Trails overlay checkbox would go.
- frontend/src/app/urlState.ts: Layer flags in the share URL (hs/pm/hist/tr/ri at :101-105, applyViewState :150-156). Directions are not encoded.
- frontend/src/panels/SourcesView.tsx: SOURCES list (:12+) for crediting USFS/BLM/NPS/LANDFIRE/OSM. Currently no routing-engine credits.
- frontend/src/app/App.tsx: FireMapView mounts SearchDirectionsControl inside ErrorBoundary 'Search' in the map toolbar (:224-236).
- frontend/src/map/zOrder.test.ts: Test convention: fake map object cast `as unknown as MlMap` (:11-25).
- frontend/src/api/queries.test.ts: Test convention for network code: swap globalThis.fetch and restore in finally (:51-73).
- .github/workflows/deploy-pages.yml: Build env: VITE_TOMTOM_KEY / VITE_ORS_KEY from repo vars (:50-51); keyless community fallbacks when unset.
