/**
 * Spread forecast rendered CLIENT-SIDE from the public forecast archive: a
 * MapLibre canvas source corner-pinned via utm.ts, painted by toaRenderer
 * (time-of-arrival {pct}.tif) or productRenderer (hourly {pct}_{product}.tar)
 * on every scrub tick — continuous rendering, no pre-rendered frames.
 *
 * Loads are async (2–9 MB archive files): the store's buffering flag shows a
 * spinner while a tif/tar downloads; the previous grid stays visible until
 * the new renderer adopts (no flash). Repaints are rAF-throttled and the
 * renderers themselves skip no-op paints (< 0.25 h scrub delta for ToA,
 * unchanged member for products). Load failures hide the layer, toast once
 * per (run, product, pct) via ctx.onFrameError (which also re-validates the
 * catalogs — 404s usually mean the run rotated away).
 */
import type { Map as MlMap } from 'maplibre-gl';
import {
  nearestPercentile,
  productPercentiles,
  spreadProductTarUrl,
  spreadToaUrl,
} from '../../api/wmsUrls';
import type { PyrecastRun, SpreadProduct } from '../../api/types';
import { ProductRenderer } from '../../spread/productRenderer';
import { ToaRenderer } from '../../spread/toaRenderer';
import type { Corners } from '../../spread/utm';
import { useStore } from '../../state/store';
import { beforeIdFor } from '../zOrder';
import type { LayerContext, LayerManager } from '../layerTypes';

const SRC = 'rd-spread-forecast';
const LYR = 'rd-spread-forecast';

type SpreadRenderer = ToaRenderer | ProductRenderer;

let mapRef: MlMap | null = null;
let ctxRef: LayerContext | null = null;
let canvasEl: HTMLCanvasElement | null = null;
let renderer: SpreadRenderer | null = null;
/** Key of the adopted renderer / the load in flight: "{ws}|{product}|{pct}". */
let rendererKey: string | null = null;
let loadingKey: string | null = null;
let sourceCorners: Corners | null = null;
let lastVisible: boolean | null = null;
let lastOpacity: number | null = null;
const failedKeys = new Set<string>();
let raf = 0;
let pendingT: number | null = null;

function setVisible(map: MlMap, visible: boolean): void {
  if (!map.getLayer(LYR) || visible === lastVisible) return;
  lastVisible = visible;
  map.setLayoutProperty(LYR, 'visibility', visible ? 'visible' : 'none');
}

function removeSourceAndLayer(map: MlMap): void {
  if (map.getLayer(LYR)) map.removeLayer(LYR);
  if (map.getSource(SRC)) map.removeSource(SRC);
  sourceCorners = null;
  lastVisible = null;
  lastOpacity = null;
}

function resetAll(map: MlMap): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  pendingT = null;
  removeSourceAndLayer(map);
  renderer = null;
  rendererKey = null;
  loadingKey = null;
  canvasEl = null;
  failedKeys.clear();
}

function cornersEqual(a: Corners, b: Corners): boolean {
  for (let i = 0; i < 4; i++) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  }
  return true;
}

function setBuffering(b: boolean): void {
  useStore.getState().actions.setBuffering(b);
}

/** rAF-throttled repaint at the latest scrub time. */
function schedulePaint(tMs: number): void {
  pendingT = tMs;
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const r = renderer;
    const t = pendingT;
    if (!r || t === null) return;
    const painted = r.renderAt(t);
    if (painted instanceof Promise) {
      void painted.then((did) => {
        if (did) mapRef?.triggerRepaint();
      });
    } else if (painted) {
      mapRef?.triggerRepaint();
    }
  });
}

/** Adopt a freshly loaded renderer: (re)build the canvas source if the grid
 * moved or resized, else just rebind the shared canvas. */
function adopt(map: MlMap, key: string, r: SpreadRenderer, run: PyrecastRun): void {
  renderer = r;
  rendererKey = key;

  const corners = r.grid.corners;
  const dimsChanged =
    !canvasEl || canvasEl.width !== r.grid.width || canvasEl.height !== r.grid.height;
  const gridChanged =
    dimsChanged || !sourceCorners || !cornersEqual(sourceCorners, corners) || !map.getSource(SRC);

  if (!canvasEl) canvasEl = document.createElement('canvas');
  if (gridChanged) {
    removeSourceAndLayer(map);
    r.attach(canvasEl); // sizes the canvas to the grid
    map.addSource(SRC, {
      type: 'canvas',
      canvas: canvasEl,
      coordinates: corners,
      animate: true,
    });
    sourceCorners = corners;
  } else {
    r.attach(canvasEl);
  }

  const spread = useStore.getState().layers.spread;
  if (!map.getLayer(LYR)) {
    map.addLayer(
      {
        id: LYR,
        type: 'raster',
        source: SRC,
        paint: { 'raster-opacity': spread.opacity, 'raster-fade-duration': 0 },
      },
      beforeIdFor(map, 'rd-spread-forecast'),
    );
    lastOpacity = spread.opacity;
    lastVisible = null; // force the visibility write below
  }

  // Back-fill the v1-era bbox (v2 catalogs omit it): useMapLayerSync's
  // hotspot bbox + fitBounds consume it when present.
  if (!run.bbox) run.bbox = r.grid.bounds;

  // The user may have hidden the layer / left fire mode while we downloaded.
  const s = useStore.getState();
  setVisible(map, s.view.mode === 'fire' && s.layers.spread.visible);
  schedulePaint(s.time.currentTime);
}

function beginLoad(
  map: MlMap,
  key: string,
  run: PyrecastRun,
  product: SpreadProduct,
  pct: number,
): void {
  loadingKey = key;
  setBuffering(true);

  const promise: Promise<SpreadRenderer> =
    product === 'time-of-arrival'
      ? ToaRenderer.load(spreadToaUrl(run, pct), {
          runStartMs: Date.parse(run.run_time),
          ramp: run.toa_ramp,
        })
      : ProductRenderer.load(spreadProductTarUrl(run, product, pct), {
          legendStops: run.products[product]?.legend_stops ?? [],
          legendLabels: run.products[product]?.legend_labels,
        });

  promise
    .then((r) => {
      if (loadingKey !== key) return; // superseded by a newer selection
      loadingKey = null;
      setBuffering(false);
      adopt(map, key, r, run);
    })
    .catch(() => {
      if (loadingKey !== key) return;
      loadingKey = null;
      setBuffering(false);
      failedKeys.add(key);
      setVisible(map, false);
      ctxRef?.onFrameError(); // toast + catalog re-validation, once per key
    });
}

export const spreadForecastLayer: LayerManager = {
  mount(map) {
    mapRef = map;
    renderer = null;
    rendererKey = null;
    loadingKey = null;
    sourceCorners = null;
    lastVisible = null;
    lastOpacity = null;
    // Source/layer are created lazily once the first renderer loads.
  },

  update(map, ctx) {
    ctxRef = ctx;
    mapRef = map;
    const run = ctx.spreadRun;
    const spread = ctx.layers.spread;

    if (ctx.view.mode !== 'fire' || !spread.visible || !run) {
      setVisible(map, false);
      return;
    }

    const pct = nearestPercentile(productPercentiles(run, spread.product), spread.percentile);
    if (pct === null) {
      // Product genuinely absent from this run.
      setVisible(map, false);
      return;
    }

    const key = `${run.workspace}|${spread.product}|${pct}`;
    if (key !== rendererKey) {
      if (failedKeys.has(key)) {
        setVisible(map, false);
        return;
      }
      if (loadingKey !== key) beginLoad(map, key, run, spread.product, pct);
      // Keep the previous grid visible while the new one loads (no flash);
      // fall through so opacity/scrub keep applying to it.
      if (!renderer) return;
    }

    if (map.getLayer(LYR) && spread.opacity !== lastOpacity) {
      lastOpacity = spread.opacity;
      map.setPaintProperty(LYR, 'raster-opacity', spread.opacity);
    }
    setVisible(map, true);
    schedulePaint(ctx.currentTime);
  },

  unmount(map) {
    resetAll(map);
    ctxRef = null;
    mapRef = null;
  },
};
