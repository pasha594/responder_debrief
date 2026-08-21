/**
 * Satellite hotspot detections as tinted circles. (Circle layer, not symbol:
 * MapLibre symbol buckets crash past 8192 icons per bucket — historic fire
 * queries return 30k+ points.) Scrubbing must stay cheap at 100k+ features:
 *  - the time window is enforced in PAINT (radius/stroke collapse to 0),
 *    never via setFilter — filter changes force MapLibre to regenerate
 *    feature buckets for every tile and the queued work keeps "catching up"
 *    after the scrub stops;
 *  - paint transitions are zeroed (the default 300 ms tween on circle-color
 *    was animating every scrub tick);
 *  - time applies are throttled with a trailing update, and quantized to the
 *    minute so identical ticks dedupe.
 * setData happens only when the FeatureCollection identity changes.
 */
import {
  Popup,
  type ExpressionSpecification,
  type FilterSpecification,
  type GeoJSONSource,
  type Map as MlMap,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import type { HotspotFeatureCollection } from '../../api/types';
import { beforeIdFor } from '../zOrder';
import type { LayerManager } from '../layerTypes';

const SRC = 'rd-hotspots';
const LYR = 'rd-hotspots';

const DAY_MS = 86_400_000;

/**
 * Detections older than this are not shown at all: past ~3 days a hotspot says
 * little about where the fire is now, and the pile-up buries fresh heat.
 */
export const HOTSPOT_MAX_AGE_MS = 3 * DAY_MS;

/** Age ramp: fresh yellow → 1 d orange → 2 d purple, smooth in between. */
const AGE_YELLOW = '#ffd400';
const AGE_ORANGE = '#ff7518';
const AGE_PURPLE = '#c05de1';

const EMPTY_FC: HotspotFeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * Age-based tint, interpolated by the hour across the three day-bands.
 * `max 0` guards clock skew (a detection stamped slightly ahead of tEff).
 */
export function ageColorExpr(tEff: number): ExpressionSpecification {
  return [
    'interpolate',
    ['linear'],
    ['max', 0, ['-', tEff, ['coalesce', ['get', 'acq_ts'], 0]]],
    0,
    AGE_YELLOW,
    DAY_MS,
    AGE_ORANGE,
    2 * DAY_MS,
    AGE_PURPLE,
  ];
}

const CIRCLE_OPACITY: ExpressionSpecification = [
  'case',
  ['==', ['coalesce', ['get', 'conf_norm'], 'nominal'], 'low'],
  0.45,
  0.8,
];

/**
 * Coarse prefilter around the playhead: paint applies re-evaluate every
 * feature the FILTER lets through, so keeping a generous window in the
 * filter (recentered only when the playhead drifts COARSE_RECENTER_MS)
 * cuts per-tick work from the fire's whole history to ~a week of points,
 * while filter changes — the expensive bucket-regenerating operation —
 * happen a handful of times per full scrub instead of every tick.
 */
export const COARSE_BACK_MS = 6 * DAY_MS;
export const COARSE_FWD_MS = 3 * DAY_MS;
export const COARSE_RECENTER_MS = 3 * DAY_MS;

export function coarseFilter(center: number) {
  return [
    'all',
    ['>=', ['coalesce', ['get', 'acq_ts'], 0], center - COARSE_BACK_MS],
    ['<=', ['coalesce', ['get', 'acq_ts'], 0], center + COARSE_FWD_MS],
  ] as FilterSpecification;
}

/** Acquired at or before tEff, and no older than the age cutoff. */
function inTimeWindow(tEff: number): ExpressionSpecification {
  return [
    'all',
    ['<=', ['coalesce', ['get', 'acq_ts'], 0], tEff],
    ['>=', ['coalesce', ['get', 'acq_ts'], 0], tEff - HOTSPOT_MAX_AGE_MS],
  ];
}

/** Radius gated by the time window: out-of-window points collapse to r=0,
 * which also removes them from hit-testing (unlike opacity 0). MapLibre
 * only allows ["zoom"] at the top level, so the interpolate wraps the case
 * (one gated output per zoom stop), not the other way around. */
export function timeRadiusExpr(tEff: number): ExpressionSpecification {
  const gate = (r: number): ExpressionSpecification =>
    ['case', inTimeWindow(tEff), r, 0];
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    5,
    gate(1),
    9,
    gate(2.25),
    13,
    gate(4),
  ];
}

export function timeStrokeExpr(tEff: number): ExpressionSpecification {
  return ['case', inTimeWindow(tEff), 0.5, 0];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtAcq(acqTs: unknown): string {
  const t = Number(acqTs);
  if (!Number.isFinite(t) || t <= 0) return 'unknown time';
  const iso = new Date(t).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function popupHtml(props: Record<string, unknown>): string {
  const parts: string[] = [
    `<strong>${escapeHtml(String(props.source ?? 'Hotspot'))}</strong>`,
    escapeHtml(fmtAcq(props.acq_ts)),
  ];
  const frp = props.frp == null ? NaN : Number(props.frp);
  if (Number.isFinite(frp)) parts.push(`FRP ${frp.toFixed(1)} MW`);
  if (props.confidence != null && props.confidence !== '') {
    parts.push(`confidence ${escapeHtml(String(props.confidence))}`);
  }
  return (
    `<div style="font-family:var(--font-sans,sans-serif);font-size:12px;line-height:1.4;` +
    `background:var(--color-surface,#241c21);color:var(--color-text,#e8e2e5);` +
    `border-radius:var(--radius,4px);margin:-10px -10px -15px;padding:8px 10px;">` +
    parts.join(' <span style="opacity:.55">•</span> ') +
    `</div>`
  );
}

// ---------- module state ----------

let lastData: HotspotFeatureCollection | undefined;
let lastTEff: number | null = null;
let lastVisible: boolean | null = null;

// ---- throttled time application (one map at a time, like the peers) ----
const THROTTLE_MS = 100;
let pendingT: number | null = null;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
let lastApplyAt = 0;
let coarseCenter: number | null = null;

function quantize(t: number): number {
  return Math.round(t / 60_000) * 60_000;
}

function applyTime(map: MlMap, t: number): void {
  lastTEff = t;
  lastApplyAt = performance.now();
  if (coarseCenter == null || Math.abs(t - coarseCenter) > COARSE_RECENTER_MS) {
    coarseCenter = t;
    map.setFilter(LYR, coarseFilter(t));
  }
  map.setPaintProperty(LYR, 'circle-color', ageColorExpr(t));
  map.setPaintProperty(LYR, 'circle-radius', timeRadiusExpr(t));
  map.setPaintProperty(LYR, 'circle-stroke-width', timeStrokeExpr(t));
}

function queueTime(map: MlMap, t: number): void {
  pendingT = t;
  const since = performance.now() - lastApplyAt;
  if (since >= THROTTLE_MS) {
    pendingT = null;
    applyTime(map, t);
    return;
  }
  if (throttleTimer) return; // trailing apply already scheduled
  throttleTimer = setTimeout(() => {
    throttleTimer = null;
    const dead = (map as unknown as { _removed?: boolean })._removed || !map.getLayer(LYR);
    if (dead || pendingT == null) return;
    const t2 = pendingT;
    pendingT = null;
    applyTime(map, t2);
  }, THROTTLE_MS - since);
}
let popup: Popup | null = null;
const handlersInstalled = new WeakSet<MlMap>();

function onClick(this: MlMap, e: MapLayerMouseEvent): void {
  const f = e.features?.[0];
  if (!f) return;
  popup ??= new Popup({ closeButton: false, offset: 10 });
  popup.setLngLat(e.lngLat).setHTML(popupHtml(f.properties ?? {})).addTo(this);
}

function onEnter(this: MlMap): void {
  this.getCanvas().style.cursor = 'pointer';
}

function onLeave(this: MlMap): void {
  this.getCanvas().style.cursor = '';
}

export const hotspotLayer: LayerManager = {
  mount(map) {
    lastData = undefined;
    lastTEff = null;
    lastVisible = null;
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: 'geojson', data: EMPTY_FC });
    }
    if (!map.getLayer(LYR)) {
      const t0 = quantize(Date.now());
      coarseCenter = t0;
      map.addLayer(
        {
          id: LYR,
          type: 'circle',
          source: SRC,
          filter: coarseFilter(t0),
          paint: {
            'circle-color': ageColorExpr(t0),
            'circle-opacity': CIRCLE_OPACITY,
            'circle-radius': timeRadiusExpr(t0),
            'circle-stroke-width': timeStrokeExpr(t0),
            'circle-stroke-color': 'rgba(0,0,0,0.35)',
          },
        },
        beforeIdFor(map, 'rd-hotspots'),
      );
      for (const prop of ['circle-color', 'circle-radius', 'circle-stroke-width', 'circle-opacity']) {
        map.setPaintProperty(LYR, `${prop}-transition`, { duration: 0, delay: 0 });
      }
    }
    if (!handlersInstalled.has(map)) {
      handlersInstalled.add(map);
      map.on('click', LYR, onClick);
      map.on('mouseenter', LYR, onEnter);
      map.on('mouseleave', LYR, onLeave);
    }
  },

  update(map, ctx) {
    if (!map.getLayer(LYR)) return;

    const visible = ctx.layers.hotspots.visible;
    if (visible !== lastVisible) {
      lastVisible = visible;
      map.setLayoutProperty(LYR, 'visibility', visible ? 'visible' : 'none');
    }

    const data = ctx.hotspots ?? EMPTY_FC;
    if (data !== lastData) {
      lastData = data;
      const src = map.getSource(SRC) as GeoJSONSource | undefined;
      src?.setData(data);
    }

    // Freeze at present when scrubbing into the future. Minute quantization
    // makes repeat ticks free; the throttle absorbs scrub streams.
    const tEff = quantize(Math.min(ctx.currentTime, ctx.now));
    if (tEff !== lastTEff && tEff !== pendingT) {
      queueTime(map, tEff);
    }
  },

  unmount(map) {
    if (throttleTimer) clearTimeout(throttleTimer);
    throttleTimer = null;
    pendingT = null;
    coarseCenter = null;
    map.off('click', LYR, onClick);
    map.off('mouseenter', LYR, onEnter);
    map.off('mouseleave', LYR, onLeave);
    handlersInstalled.delete(map);
    popup?.remove();
    popup = null;
    lastData = undefined;
    lastTEff = null;
    lastVisible = null;
    if (map.getLayer(LYR)) map.removeLayer(LYR);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },
};
