# Frontend Detailed Spec

Companion to [plan.md](plan.md). Where they disagree, plan.md wins (final decisions: GitHub Pages hosting, `PROXY_BASE` env pointing at a workers.dev Cloudflare Worker with routes `/wms01`+`/wms02`, spread-frame max dimension 1536 under the proxy's 2048 cap).

## Store shape (zustand)

```ts
type SpreadProduct = 'spread-rate' | 'flame-length' | 'crown-fire'
                   | 'hours-since-burned' | 'time-of-arrival' | 'isochrones';
type WeatherProduct = 'tmpf'|'rh'|'ws'|'wg'|'wd'|'ffwi'|'smoke'|'tcdc'|'apcp01';

interface AppStore {
  view: { mode: 'national' } | { mode: 'fire'; corneaId: string };
  time: {
    currentTime: number;            // epoch ms UTC — THE single time state
    domain: [number, number];       // recomputed on view/data change
    playing: boolean;
    speed: number;                  // model-hours per wall-second (default 2)
    buffering: boolean;             // playback gated on prefetch
  };
  layers: {
    spread: { visible: boolean; product: SpreadProduct; percentile: 10|30|50|70|90;
              runWorkspace: string | null; opacity: number };   // defaults: spread-rate, 50, 0.8
    weather: Partial<Record<WeatherProduct, { visible: boolean; opacity: number }>>;
    hotspots: { visible: boolean };
    perimeters: { visible: boolean };
    incidentMap: { productId: string | null; opacity: number }; // exclusive overlay
    irFlight: { flightId: string | null };
  };
  ui: { theme: 'dark'|'light'; sidebarTab: 'overview'|'forecast'|'weather'|'maps';
        sheetSnap: 'peek'|'half'|'full'; legendProduct: string | null };
}
```

Rules: `selectFire` resolves the spread run from `pyrecast_runs.json`, recomputes domain (`[created_on, max(spread last instant, weather last frame)]`), clamps `currentTime` (default now), flyTo. `backToNational` keeps weather selections, clears spread. Server data lives only in TanStack Query.

## Query caching

| Data | staleTime |
|---|---|
| /fires index | 60 s, refetch on focus |
| /fires/{id} | 300 s |
| perimeter index | 300 s |
| perimeter versions | Infinity (server immutable) |
| /hotspots | 300 s, key = 0.25°-snapped bbox |
| B2 catalogs | 300 s; invalidated on any WMS 404 |
| WMS frames | not Query — FramePrefetcher LRU + browser HTTP cache |

## URL templates

Spread frame (single image, fixed per-run bbox → deterministic, cacheable):
```
{PROXY_BASE}/wms02?service=WMS&version=1.3.0&request=GetMap
  &layers={workspace}:elmfire_landfire_{percentile}_{product}
  &styles=&crs=EPSG:3857&bbox={minX},{minY},{maxX},{maxY}   ← run bbox → 3857, FIXED
  &width={w}&height={h}                                     ← aspect-correct, max dim 1536
  &format=image/png&transparent=true
  &time={instant}                                           ← VERBATIM catalog instant
```
Static products: same minus `time`. Weather tiles (and national perimeter raster):
```
{PROXY_BASE}/wms01?service=WMS&version=1.3.0&request=GetMap&layers={qualifiedLayer}
  &styles=&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=512&height=512
  &format=image/png&transparent=true
```
as `tiles: [template], tileSize: 512`. Legends: `request=GetLegendGraphic&format=image/png&width=20&height=20&layer={qualified}` (server returns full ~249×278 ramp; render at natural size).

## MapLibre integration

- `MapRoot.tsx` owns the map; layer modules are imperative `{mount, update, unmount}`; one zustand subscription (`useMapLayerSync`) diffs and dispatches. All our ids prefixed `rd-`.
- Style swap: `map.setStyle(next, { transformStyle })` re-merging `rd-` sources/layers; `styledata` re-asserts z-order.
- Z-order (bottom→top): basemap fills < **weather rasters < incident map < spread forecast** (inserted before first symbol layer) < basemap labels < IR heat < perimeter fill/line < hotspots < pins.
- Pins: teardrop SVG via `addImage`; `symbol-sort-key: -acres`; `icon-allow-overlap` false below z8, true ≥z8; wildfire `#FFBB56`, prescribed `#C3B392`.
- Hotspots: canvas hexagon uploaded `{sdf:true}`; per-scrub `setFilter(['<=',['get','acq_ts'], t])` + `icon-color` interpolate on `t - acq_ts` (0→`#FF7518`, 1d→`#FF6467`, 7d→`#C05DE1`). `acq_ts` = acq_date + zero-padded HHMM UTC at ingest; `conf_norm` low/nominal/high (MODIS numeric <30/30–79/≥80; VIIRS l/n/h).
- Spread: `image` source with run bbox corners; frame = `updateImage({url})` (prefetched → atomic, instant).
- Weather: per-product A/B raster source pair; step = swap layer name on hidden member, wait source loaded, crossfade `raster-opacity` 150 ms, swap roles. `raster-fade-duration: 0`.
- Selected-fire perimeter: GeoJSON `setData` per snapped version; fill `#CC0000` 0.13, line 2px (4 on hover of a version marker).

## Timeline

- Piecewise-linear `timeToX`: past 55% / future 45% of track, seam at NOW (1px amber marker + "NOW" microlabel). Nonlinearity is presentation-only; all logic in time-space.
- Ticks: day boundaries + labels ("Mon 18"); hour ticks where ≥3 px/hr; else 6-hour ticks. Perimeter-version dots (amber rgba(245,190,104,.85)) on-track, clickable snap. Playhead: 2px line + 13px handle (20px touch), drag pauses, tooltip = fire-local time (fire.timezone). Cover dims right of playhead.
- Snapping resolvers (memoized, return `{frameKey,url}|null`):
  - perimeter: latest version.date ≤ t (holds latest for t>now); before first → hidden + chip
  - hotspots: filter acq_ts ≤ t (frozen at now for t>now)
  - spread: binary-search verbatim `time_instants` for nearest ≤ t; outside range → hidden + "forecast covers X→Y" chip; static products ignore t
  - weather: nearest frame within 90 min else hidden + "forecast begins X" chip
- Playback: frameTimes = sorted union of active spread instants + weather hours clipped to [t, domain.end] (hourly fallback if only past layers); advance by frame index at `1000/speed` ms per model-hour; gate on next-frame-in-cache else `buffering`.
- FramePrefetcher: strictly sequential (concurrency 1 to gs02, ≤4 total), LRU of decoded `Image`s (~500 entries cap), priority = playhead-forward then backward, starts on product select. 404 → invalidate catalogs, re-resolve run, toast.

## Panels & responsive

- Desktop ≥1024: right sidebar 380px (surface #241c21, 1px border left), collapsible to 48px rail; bottom timeline 64px (bg #332a2f); LegendBar bottom-right above timeline (cornea gradient-bar: uppercase LEFT/RIGHT captions); top-left back button + fire name (Newsreader 600) + amber active badge.
- Tablet 768–1024: sidebar 320px overlay.
- Mobile <768: MobileSheet snap points peek(96px)/half/full; timeline compresses to 48px (play + track + readout); pickers move into tabs; touch ≥44px.
- FirePanel tabs: Overview (acres/containment/personnel formatted with "—" nulls, AI summary markdown with citations, structure exposure buffers) | Forecast (product dropdown + percentile pills + legend) | Weather (checkbox rows + opacity sliders + legends) | Maps (grouped by kind, previews, exclusive Show-on-map + opacity, PDF pill with size, IR flights toggle).
- Incident overlay active → dismissible floating chip on map.

## Guardrails

- `LatFirstBbox {minLat,minLon,maxLat,maxLon}` named-field type; serializer is the only way to build the hotspot bbox param.
- `parseFireCoordinates("lat, lon") → [lon, lat]` sole parser, unit-tested.
- `fetchPerimeterByPath(path)` — index `path` used verbatim; no reconstruction helper exists.
- No `geoserver-usw1.pyrecast.org` literal anywhere in src/ (all via `PROXY_BASE`); enforce via lint/grep in CI.
- Dev: Vite `server.proxy` maps `/wms01|/wms02` → geoservers with `changeOrigin: true` (strips Origin), so `npm run dev` works without the deployed Worker.
- GH Pages: `base` from env (`VITE_BASE` default `/responder_debrief/`), SPA fallback 404.html, `DATA_BASE_URL` default `${BASE_URL}data` (dev: worker dry-run output copied to `public/data/`), overridable via `VITE_DATA_BASE_URL` (B2).
