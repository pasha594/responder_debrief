/**
 * Weather rasters (gs01 WMS tiles). Frames are layer-NAME swaps, not TIME
 * params, so each enabled product keeps an A/B pair of raster sources: the
 * hidden member loads the next hour's tiles, then a ~150 ms raster-opacity
 * crossfade swaps roles — no white flash while stepping through hours.
 */
import type { Map as MlMap, RasterTileSource } from 'maplibre-gl';
import { WMS01, weatherLayerName, wmsTileTemplate } from '../../api/wmsUrls';
import type { WeatherProduct } from '../../api/types';
import { resolveWeatherFrame } from '../../timeline/framePlan';
import { beforeIdFor, type RdLayerId } from '../zOrder';
import type { LayerManager } from '../layerTypes';

const PRODUCTS: WeatherProduct[] = [
  'tmpf', 'rh', 'ws', 'wg', 'wd', 'ffwi',
  'smoke', 'tcdc', 'pign', 'meq', 'apcp01', 'apcptot',
];

const FADE_MS = 150;
const LOAD_TIMEOUT_MS = 2000;
const DEFAULT_OPACITY = 0.7;

type MemberKey = 'a' | 'b';

interface Pair {
  active: MemberKey;
  /** Qualified WMS layer name currently loaded into each member (null = empty). */
  layerName: { a: string | null; b: string | null };
  /** In-flight step (tile wait and/or crossfade). */
  pending: { member: MemberKey; layerName: string; cancel(): void } | null;
  /** Last raster-opacity applied to the active member. */
  appliedOpacity: number | null;
  shown: boolean;
}

const pairs = new Map<WeatherProduct, Pair>();

const memberId = (p: WeatherProduct, m: MemberKey): string => `rd-weather-${p}-${m}`;

/** Point a member at a qualified layer (setTiles when available, else rebuild). */
function ensureMember(map: MlMap, p: WeatherProduct, m: MemberKey, layerName: string): void {
  const id = memberId(p, m);
  const tpl = wmsTileTemplate(WMS01, layerName);
  const src = map.getSource(id);
  if (src) {
    const rts = src as Partial<RasterTileSource>;
    if (typeof rts.setTiles === 'function') {
      rts.setTiles([tpl]);
    } else {
      if (map.getLayer(id)) map.removeLayer(id);
      map.removeSource(id);
    }
  }
  if (!map.getSource(id)) {
    map.addSource(id, { type: 'raster', tiles: [tpl], tileSize: 512 });
  }
  if (!map.getLayer(id)) {
    map.addLayer(
      {
        id,
        type: 'raster',
        source: id,
        paint: { 'raster-opacity': 0, 'raster-fade-duration': 0 },
      },
      beforeIdFor(map, id as RdLayerId),
    );
  }
}

/** Resolve once the member's tiles are loaded, or after a 2 s fallback. */
function waitForSourceLoaded(map: MlMap, sourceId: string, cb: () => void): () => void {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    cleanup();
    cb();
  };
  const check = () => {
    if (done) return;
    let loaded = false;
    try {
      loaded = !!map.getSource(sourceId) && map.isSourceLoaded(sourceId) && map.areTilesLoaded();
    } catch {
      loaded = false;
    }
    if (loaded) finish();
  };
  const timer = setTimeout(finish, LOAD_TIMEOUT_MS);
  const cleanup = () => {
    clearTimeout(timer);
    map.off('sourcedata', check);
    map.off('idle', check);
  };
  map.on('sourcedata', check);
  map.on('idle', check);
  queueMicrotask(check);
  return () => {
    done = true;
    cleanup();
  };
}

/** A few rAF steps of raster-opacity from → to over ~150 ms. */
function animateOpacity(
  map: MlMap,
  layerId: string,
  from: number,
  to: number,
  onDone?: () => void,
): () => void {
  const start = performance.now();
  let raf = 0;
  const step = (t: number) => {
    const k = Math.min(1, (t - start) / FADE_MS);
    if (map.getLayer(layerId)) {
      map.setPaintProperty(layerId, 'raster-opacity', from + (to - from) * k);
    }
    if (k < 1) {
      raf = requestAnimationFrame(step);
    } else {
      onDone?.();
    }
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

function setLayerVisibility(map: MlMap, id: string, visible: boolean): void {
  if (map.getLayer(id)) {
    map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

function cancelPending(pair: Pair): void {
  pair.pending?.cancel();
  pair.pending = null;
}

function hidePair(map: MlMap, p: WeatherProduct, pair: Pair): void {
  if (!pair.shown) return;
  pair.shown = false;
  cancelPending(pair);
  setLayerVisibility(map, memberId(p, 'a'), false);
  setLayerVisibility(map, memberId(p, 'b'), false);
}

function removePair(map: MlMap, p: WeatherProduct, pair: Pair): void {
  cancelPending(pair);
  for (const m of ['a', 'b'] as const) {
    const id = memberId(p, m);
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
  }
  pairs.delete(p);
}

export const weatherLayers: LayerManager = {
  mount() {
    // Pairs are created lazily per enabled product; nothing to add up front.
    pairs.clear();
  },

  update(map, ctx) {
    const frame = resolveWeatherFrame(ctx.weatherRun, ctx.currentTime);

    for (const p of PRODUCTS) {
      const st = ctx.layers.weather[p];
      let pair = pairs.get(p);

      if (!st?.visible) {
        if (pair) removePair(map, p, pair); // toggled off → tear the pair down
        continue;
      }

      const target = st.opacity ?? DEFAULT_OPACITY;

      if (!frame || !ctx.weatherRun) {
        if (pair) hidePair(map, p, pair); // outside forecast coverage
        continue;
      }
      const wanted = weatherLayerName(ctx.weatherRun, p, frame.hourIso);

      if (!pair) {
        pair = {
          active: 'a',
          layerName: { a: null, b: null },
          pending: null,
          appliedOpacity: null,
          shown: true,
        };
        pairs.set(p, pair);
      }
      const pr = pair;
      if (!pr.shown) {
        pr.shown = true;
        const id = memberId(p, pr.active);
        setLayerVisibility(map, id, true);
        if (map.getLayer(id)) {
          map.setPaintProperty(id, 'raster-opacity', pr.appliedOpacity ?? 0);
        }
      }

      // Already showing the wanted frame: just track opacity changes.
      if (pr.layerName[pr.active] === wanted) {
        if (pr.pending && pr.pending.layerName !== wanted) cancelPending(pr);
        if (!pr.pending && pr.appliedOpacity !== target) {
          const id = memberId(p, pr.active);
          if (map.getLayer(id)) map.setPaintProperty(id, 'raster-opacity', target);
          pr.appliedOpacity = target;
        }
        continue;
      }

      // A step toward `wanted` is already in flight — let it land.
      if (pr.pending) {
        if (pr.pending.layerName === wanted) continue;
        cancelPending(pr);
      }

      if (pr.layerName[pr.active] === null) {
        // First show for this product: load into the active member, fade in.
        const m = pr.active;
        const id = memberId(p, m);
        ensureMember(map, p, m, wanted);
        pr.layerName[m] = wanted;
        setLayerVisibility(map, id, true);
        let cancelFade: (() => void) | null = null;
        const cancelWait = waitForSourceLoaded(map, id, () => {
          cancelFade = animateOpacity(map, id, 0, target, () => {
            pr.pending = null;
          });
          pr.appliedOpacity = target;
        });
        pr.pending = {
          member: m,
          layerName: wanted,
          cancel: () => {
            cancelWait();
            cancelFade?.();
          },
        };
        continue;
      }

      // Standard A/B step: load the inactive member, crossfade, swap roles.
      const inM: MemberKey = pr.active === 'a' ? 'b' : 'a';
      const inId = memberId(p, inM);
      const outId = memberId(p, pr.active);
      ensureMember(map, p, inM, wanted);
      pr.layerName[inM] = wanted;
      if (map.getLayer(inId)) {
        map.setPaintProperty(inId, 'raster-opacity', 0);
        map.setLayoutProperty(inId, 'visibility', 'visible');
      }
      let cancelFadeIn: (() => void) | null = null;
      let cancelFadeOut: (() => void) | null = null;
      const cancelWait = waitForSourceLoaded(map, inId, () => {
        cancelFadeIn = animateOpacity(map, inId, 0, target, () => {
          pr.pending = null;
          setLayerVisibility(map, outId, false);
        });
        cancelFadeOut = animateOpacity(map, outId, pr.appliedOpacity ?? target, 0);
        pr.active = inM;
        pr.appliedOpacity = target;
      });
      pr.pending = {
        member: inM,
        layerName: wanted,
        cancel: () => {
          cancelWait();
          cancelFadeIn?.();
          cancelFadeOut?.();
        },
      };
    }
  },

  unmount(map) {
    for (const [p, pair] of [...pairs]) removePair(map, p, pair);
    pairs.clear();
  },
};
