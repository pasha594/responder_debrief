/**
 * Satellite hotspot detections as tinted circles. (Circle layer, not symbol:
 * MapLibre symbol buckets crash past 8192 icons per bucket — historic fire
 * queries return 30k+ points.) Scrubbing is a setFilter + circle-color repaint
 * (cheap per tick); setData happens only when the FeatureCollection identity
 * changes. Age color ramp: fresh #FF7518 → 1 day #FF6467 → 7 days #C05DE1.
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
const WEEK_MS = 604_800_000;

const EMPTY_FC: HotspotFeatureCollection = { type: 'FeatureCollection', features: [] };

/** Age-based tint; interpolate clamps at both ends, max guards negatives. */
function ageColorExpr(tEff: number): ExpressionSpecification {
  return [
    'interpolate',
    ['linear'],
    ['max', 0, ['-', tEff, ['coalesce', ['get', 'acq_ts'], 0]]],
    0,
    '#FF7518',
    DAY_MS,
    '#FF6467',
    WEEK_MS,
    '#C05DE1',
  ];
}

const CIRCLE_OPACITY: ExpressionSpecification = [
  'case',
  ['==', ['coalesce', ['get', 'conf_norm'], 'nominal'], 'low'],
  0.45,
  0.8,
];

const CIRCLE_RADIUS: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  5,
  2,
  9,
  4.5,
  13,
  8,
];

function timeFilter(tEff: number): FilterSpecification {
  return ['<=', ['coalesce', ['get', 'acq_ts'], 0], tEff];
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
      map.addLayer(
        {
          id: LYR,
          type: 'circle',
          source: SRC,
          filter: timeFilter(Date.now()),
          paint: {
            'circle-color': ageColorExpr(Date.now()),
            'circle-opacity': CIRCLE_OPACITY,
            'circle-radius': CIRCLE_RADIUS,
            'circle-stroke-width': 0.5,
            'circle-stroke-color': 'rgba(0,0,0,0.35)',
          },
        },
        beforeIdFor(map, 'rd-hotspots'),
      );
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

    // Freeze at present when scrubbing into the future.
    const tEff = Math.min(ctx.currentTime, ctx.now);
    if (tEff !== lastTEff) {
      lastTEff = tEff;
      map.setFilter(LYR, timeFilter(tEff));
      map.setPaintProperty(LYR, 'circle-color', ageColorExpr(tEff));
    }
  },

  unmount(map) {
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
