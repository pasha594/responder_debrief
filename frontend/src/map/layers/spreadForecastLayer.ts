/**
 * Pyrecast spread forecast as a single-image source over pre-rendered B2
 * frames. Frames are atomic updateImage({url}) swaps (the FramePrefetcher
 * warms the HTTP cache); timed products resolve their instant from
 * currentTime, static products (time-of-arrival / isochrones) ignore it.
 * Load errors on this source (404 = frames pruned) signal run rotation →
 * ctx.onFrameError(), throttled to once per 30 s.
 */
import type { ImageSource, Map as MlMap } from 'maplibre-gl';
import { boundsToImageCoords } from '../../api/geo';
import { spreadFrameUrl } from '../../api/wmsUrls';
import { resolveSpreadFrame } from '../../timeline/framePlan';
import { beforeIdFor } from '../zOrder';
import type { LayerContext, LayerManager } from '../layerTypes';

const SRC = 'rd-spread-forecast';
const LYR = 'rd-spread-forecast';

const ERROR_THROTTLE_MS = 30_000;

let lastUrl: string | null = null;
let lastRunKey: string | null = null;
let lastVisible: boolean | null = null;
let lastOpacity: number | null = null;
let lastErrorAt = 0;
let ctxRef: LayerContext | null = null;
const errorBound = new WeakSet<MlMap>();

function onMapError(e: unknown): void {
  const sourceId = (e as { sourceId?: string; source?: { id?: string } }).sourceId;
  if (sourceId !== SRC) return;
  const now = Date.now();
  if (now - lastErrorAt < ERROR_THROTTLE_MS) return;
  lastErrorAt = now;
  ctxRef?.onFrameError();
}

function setVisible(map: MlMap, visible: boolean): void {
  if (!map.getLayer(LYR) || visible === lastVisible) return;
  lastVisible = visible;
  map.setLayoutProperty(LYR, 'visibility', visible ? 'visible' : 'none');
}

function removeAll(map: MlMap): void {
  if (map.getLayer(LYR)) map.removeLayer(LYR);
  if (map.getSource(SRC)) map.removeSource(SRC);
  lastUrl = null;
  lastRunKey = null;
  lastVisible = null;
  lastOpacity = null;
}

export const spreadForecastLayer: LayerManager = {
  mount(map) {
    lastUrl = null;
    lastRunKey = null;
    lastVisible = null;
    lastOpacity = null;
    // Source needs a run bbox + first frame URL — created lazily in update().
    if (!errorBound.has(map)) {
      errorBound.add(map);
      map.on('error', onMapError);
    }
  },

  update(map, ctx) {
    ctxRef = ctx;
    const run = ctx.spreadRun;
    const spread = ctx.layers.spread;
    const prodInfo = run?.products[spread.product];

    if (ctx.view.mode !== 'fire' || !spread.visible || !run || !prodInfo) {
      setVisible(map, false);
      return;
    }

    let instant: string | null = null;
    if (prodInfo.timed !== false) {
      const frame = resolveSpreadFrame(run, ctx.currentTime);
      if (!frame) {
        // t outside run coverage: hide the layer, keep the source warm.
        setVisible(map, false);
        return;
      }
      instant = frame.instant;
    }

    const url = spreadFrameUrl(run, spread.product, spread.percentile, instant);
    const runKey = `${run.workspace}|${run.run_time}`;
    if (runKey !== lastRunKey && map.getSource(SRC)) {
      removeAll(map); // bbox changed with the run — rebuild from scratch
    }

    if (!map.getSource(SRC)) {
      map.addSource(SRC, {
        type: 'image',
        url,
        coordinates: boundsToImageCoords(run.bbox),
      });
      lastUrl = url;
      lastRunKey = runKey;
    }
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
      lastVisible = null; // force visibility below
    }

    if (url !== lastUrl) {
      lastUrl = url;
      (map.getSource(SRC) as ImageSource).updateImage({ url });
    }
    if (spread.opacity !== lastOpacity) {
      lastOpacity = spread.opacity;
      map.setPaintProperty(LYR, 'raster-opacity', spread.opacity);
    }
    setVisible(map, true);
  },

  unmount(map) {
    map.off('error', onMapError);
    errorBound.delete(map);
    ctxRef = null;
    removeAll(map);
  },
};
