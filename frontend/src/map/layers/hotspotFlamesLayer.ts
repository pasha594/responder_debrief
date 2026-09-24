/**
 * Flames on the freshest hotspots. Every detection from the last 12 h before
 * the playhead — the ones still more yellow than orange on the circles' age
 * ramp — gets an animated low-poly flame standing on its dot (the vendored
 * fire-layer, a MapLibre custom layer). The circles stay underneath: they
 * carry the age colour, the popups and the hit-testing, because custom layers
 * are invisible to queryRenderedFeatures.
 *
 * Cost control — an animating custom layer makes MapLibre repaint the whole
 * map (terrain, rasters, every circle) on every frame, and MapLibre's label
 * placement turns any frame cap set from inside the map back into full
 * speed. So the flames only move while the map is repainting anyway:
 *  - they animate while the camera moves (pan, zoom, tilt, rotate) and for
 *    FLAME_SETTLE_MS after it stops, then hold a still pose. Still flames
 *    stay drawn in 3D and cost nothing while the map is at rest, which also
 *    lets session replay skip the unchanged frames;
 *  - the layer holds just the detections near the playhead (the 12 h window
 *    plus slack either side) and is re-fed when the playhead leaves that
 *    slack, so a fire's months of history never reach the GPU;
 *  - inside the slack, scrubbing is the layer's own GPU time filter — one
 *    uniform per tick, no rebuild;
 *  - when nothing falls inside the 12 h window it stays paused even while
 *    the camera moves; the library also holds still when no flame is in
 *    view, below its min zoom, and for people who ask for reduced motion.
 */
import type { CustomLayerInterface, Map as MlMap } from 'maplibre-gl';
import type { HotspotFeatureCollection } from '../../api/types';
import { beforeIdFor } from '../zOrder';
import type { LayerManager } from '../layerTypes';
import { FireLayer } from '../vendor/fire-layer/fire-layer.js';

const LYR = 'rd-hotspot-flames';

const HOUR_MS = 3_600_000;

/**
 * A hotspot burns for this long after its detection. 12 h is the midpoint of
 * the circles' yellow → orange day (see ageColorExpr): younger than this it
 * reads yellow, older it reads orange.
 */
export const FLAME_MAX_AGE_MS = 12 * HOUR_MS;

/** How far the playhead may drift before the layer is re-fed. */
export const FLAME_SLACK_MS = 12 * HOUR_MS;

/** Flames move while the camera does, and for this long after it stops. */
export const FLAME_SETTLE_MS = 2000;

type HotspotFeature = HotspotFeatureCollection['features'][number];

/** Detections with a usable time, oldest first, and their times alongside. */
export interface FlameIndex {
  features: HotspotFeature[];
  times: Float64Array;
}

export function buildFlameIndex(fc: HotspotFeatureCollection | undefined): FlameIndex {
  const features = (fc?.features ?? []).filter((f) => {
    const t = f.properties?.acq_ts;
    return typeof t === 'number' && Number.isFinite(t) && t > 0;
  });
  features.sort((a, b) => a.properties.acq_ts! - b.properties.acq_ts!);
  const times = new Float64Array(features.length);
  for (let i = 0; i < features.length; i++) times[i] = features[i].properties.acq_ts!;
  return { features, times };
}

/** First index whose time is >= t (times ascending). */
function lowerBound(times: Float64Array, t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index range [lo, hi) of detections with from <= time <= to. */
export function timeSlice(times: Float64Array, from: number, to: number): [number, number] {
  return [lowerBound(times, from), lowerBound(times, to + 1)];
}

export interface FlamePlan {
  /** The window that burns at this playhead: [tEff − 12 h, tEff]. */
  burning: [number, number];
  /** How many detections are inside it — 0 pauses the layer. */
  count: number;
  /** Non-null when the layer must be re-fed: the time span to load. */
  refeed: [number, number] | null;
}

/**
 * What the layer needs at playhead `tEff`, given the span it currently holds.
 * Pure, so the re-feed rule (the expensive path) is testable without WebGL.
 */
export function planFlames(
  times: Float64Array,
  tEff: number,
  loaded: [number, number] | null,
): FlamePlan {
  const burning: [number, number] = [tEff - FLAME_MAX_AGE_MS, tEff];
  const [lo, hi] = timeSlice(times, burning[0], burning[1]);
  const covered = !!loaded && burning[0] >= loaded[0] && burning[1] <= loaded[1];
  return {
    burning,
    count: hi - lo,
    refeed: covered ? null : [burning[0] - FLAME_SLACK_MS, burning[1] + FLAME_SLACK_MS],
  };
}

// ---------- module state (one map at a time, like the peers) ----------

let fire: FireLayer | null = null;
let onStyleData: (() => void) | null = null;
let lastData: HotspotFeatureCollection | undefined;
let index: FlameIndex = { features: [], times: new Float64Array(0) };
let loaded: [number, number] | null = null;
let lastTEff: number | null = null;
let shown = false;
let onMove: (() => void) | null = null;
/** Pending end of the post-move settle: non-null while the flames may move. */
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let animating = false;

/**
 * Run the flames' own repaint loop only while something is burning and the
 * camera moved within the last FLAME_SETTLE_MS. Paused flames keep their
 * pose and are still drawn whenever the map repaints for any other reason.
 */
function syncAnimation(): void {
  if (!fire) return;
  const want = shown && settleTimer !== null;
  if (want === animating) return;
  animating = want;
  if (want) fire.resume();
  else fire.pause();
}

function clearSettle(): void {
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = null;
}

function quantize(t: number): number {
  return Math.round(t / 60_000) * 60_000;
}

/** Custom layers do not survive setStyle (basemap swaps) — put it back. */
function ensureLayer(map: MlMap): void {
  if (!fire || map.getLayer(LYR)) return;
  map.addLayer(fire satisfies CustomLayerInterface, beforeIdFor(map, LYR));
}

export const hotspotFlamesLayer: LayerManager = {
  mount(map) {
    fire = new FireLayer({
      id: LYR,
      getTime: (p) => p.acq_ts,
      // A VIIRS pixel is ~375 m, so true-to-scale flames only appear zoomed
      // well in; at fire-overview zooms they hold this size over their dots.
      minPixelSize: 12,
      maxPixelSize: 96,
    });
    fire.pause(); // still until something burns and the camera moves
    lastData = undefined;
    index = { features: [], times: new Float64Array(0) };
    loaded = null;
    lastTEff = null;
    shown = false;
    animating = false;
    clearSettle();
    ensureLayer(map);
    onStyleData = () => {
      if (map.isStyleLoaded()) ensureLayer(map);
    };
    map.on('styledata', onStyleData);
    // 'move' fires on every camera frame (pan, zoom, tilt, rotate, flyTo), so
    // each one pushes the settle deadline back until the camera stops.
    onMove = () => {
      clearSettle();
      settleTimer = setTimeout(() => {
        settleTimer = null;
        syncAnimation();
      }, FLAME_SETTLE_MS);
      syncAnimation();
    };
    map.on('move', onMove);
  },

  update(map, ctx) {
    if (!fire) return;
    ensureLayer(map);

    const visible = ctx.layers.hotspots.visible;
    const data = visible ? ctx.hotspots : undefined;
    if (data !== lastData) {
      lastData = data;
      index = buildFlameIndex(data);
      loaded = null; // whatever the layer holds is stale
      lastTEff = null;
    }

    // Same clock as the circles: frozen at the present when scrubbed into
    // the future, quantized to the minute so repeat ticks are free.
    const tEff = quantize(Math.min(ctx.currentTime, ctx.now));
    if (tEff === lastTEff) return;
    lastTEff = tEff;

    const plan = planFlames(index.times, tEff, loaded);
    if (plan.refeed) {
      const [lo, hi] = timeSlice(index.times, plan.refeed[0], plan.refeed[1]);
      fire.setHotspots(index.features.slice(lo, hi));
      loaded = plan.refeed;
    }
    fire.setTimeRange(plan.burning[0], plan.burning[1]);

    shown = plan.count > 0;
    syncAnimation();
  },

  unmount(map) {
    if (onStyleData) map.off('styledata', onStyleData);
    onStyleData = null;
    if (onMove) map.off('move', onMove);
    onMove = null;
    clearSettle();
    if (map.getLayer(LYR)) map.removeLayer(LYR);
    fire = null;
    lastData = undefined;
    index = { features: [], times: new Float64Array(0) };
    loaded = null;
    lastTEff = null;
    shown = false;
    animating = false;
  },
};
