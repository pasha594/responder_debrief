/**
 * Weather rasters — pre-rendered CONUS frame images from B2, one per product
 * per forecast hour. Frames are whole-image swaps, so each enabled product
 * keeps an A/B pair of image sources: the next hour's PNG is preloaded via
 * Image().decode() (B2 frames are immutable → the HTTP cache makes the
 * subsequent source fetch instant), then the hidden member updateImage()s and
 * a ~150 ms raster-opacity crossfade swaps roles — no white flash stepping
 * through hours.
 */
import type { ImageSource, Map as MlMap } from 'maplibre-gl';
import { weatherImageUrl } from '../../api/wmsUrls';
import { boundsToImageCoords, type Bounds4326 } from '../../api/geo';
import { RENDERED_WEATHER_PRODUCTS, type WeatherProduct, type WeatherRun } from '../../api/types';
import { resolveWeatherFrame } from '../../timeline/framePlan';
import { beforeIdFor, type RdLayerId } from '../zOrder';
import type { LayerManager } from '../layerTypes';

const FADE_MS = 150;
const LOAD_TIMEOUT_MS = 2000;
const DEFAULT_OPACITY = 0.7;

/** Spec CONUS bounds — fallback for manifests missing frames.bounds. */
const CONUS_BOUNDS: Bounds4326 = [-125.0, 24.5, -66.5, 49.5];

function frameCoords(run: WeatherRun): ReturnType<typeof boundsToImageCoords> {
  return boundsToImageCoords(run.frames?.bounds ?? CONUS_BOUNDS);
}

type MemberKey = 'a' | 'b';

interface Pair {
  active: MemberKey;
  /** Frame URL currently loaded into each member (null = empty). */
  url: { a: string | null; b: string | null };
  /** In-flight step (preload wait and/or crossfade). */
  pending: { member: MemberKey; url: string; cancel(): void } | null;
  /** Last raster-opacity applied to the active member. */
  appliedOpacity: number | null;
  shown: boolean;
}

const pairs = new Map<WeatherProduct, Pair>();

const memberId = (p: WeatherProduct, m: MemberKey): string => `rd-weather-${p}-${m}`;

/** Point a member's image source at a frame URL (updateImage when possible). */
function ensureMember(
  map: MlMap,
  p: WeatherProduct,
  m: MemberKey,
  url: string,
  coordinates: ReturnType<typeof boundsToImageCoords>,
): void {
  const id = memberId(p, m);
  const src = map.getSource(id) as ImageSource | undefined;
  if (src) {
    src.updateImage({ url, coordinates });
  } else {
    map.addSource(id, { type: 'image', url, coordinates });
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

/**
 * Warm + decode a frame off-DOM, then cb. Proceeds on error too (a 404 frame
 * must not wedge stepping) and after a 2 s fallback timeout.
 */
function preloadImage(url: string, cb: () => void): () => void {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cb();
  };
  const timer = setTimeout(finish, LOAD_TIMEOUT_MS);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  img.decode().then(finish, finish);
  return () => {
    done = true;
    clearTimeout(timer);
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

    for (const p of RENDERED_WEATHER_PRODUCTS) {
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
      const wanted = weatherImageUrl(ctx.weatherRun, p, frame.hourIso);
      const coords = frameCoords(ctx.weatherRun);

      if (!pair) {
        pair = {
          active: 'a',
          url: { a: null, b: null },
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
      if (pr.url[pr.active] === wanted) {
        if (pr.pending && pr.pending.url !== wanted) cancelPending(pr);
        if (!pr.pending && pr.appliedOpacity !== target) {
          const id = memberId(p, pr.active);
          if (map.getLayer(id)) map.setPaintProperty(id, 'raster-opacity', target);
          pr.appliedOpacity = target;
        }
        continue;
      }

      // A step toward `wanted` is already in flight — let it land.
      if (pr.pending) {
        if (pr.pending.url === wanted) continue;
        cancelPending(pr);
      }

      if (pr.url[pr.active] === null) {
        // First show for this product: preload, load into the active member,
        // fade in.
        const m = pr.active;
        const id = memberId(p, m);
        let cancelFade: (() => void) | null = null;
        const cancelWait = preloadImage(wanted, () => {
          ensureMember(map, p, m, wanted, coords);
          pr.url[m] = wanted;
          setLayerVisibility(map, id, true);
          cancelFade = animateOpacity(map, id, 0, target, () => {
            pr.pending = null;
          });
          pr.appliedOpacity = target;
        });
        pr.pending = {
          member: m,
          url: wanted,
          cancel: () => {
            cancelWait();
            cancelFade?.();
          },
        };
        continue;
      }

      // Standard A/B step: preload, update the inactive member, crossfade,
      // swap roles.
      const inM: MemberKey = pr.active === 'a' ? 'b' : 'a';
      const inId = memberId(p, inM);
      const outId = memberId(p, pr.active);
      let cancelFadeIn: (() => void) | null = null;
      let cancelFadeOut: (() => void) | null = null;
      const cancelWait = preloadImage(wanted, () => {
        ensureMember(map, p, inM, wanted, coords);
        pr.url[inM] = wanted;
        if (map.getLayer(inId)) {
          map.setPaintProperty(inId, 'raster-opacity', 0);
          map.setLayoutProperty(inId, 'visibility', 'visible');
        }
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
        url: wanted,
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
