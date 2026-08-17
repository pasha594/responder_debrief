/**
 * National fire pins: teardrop symbols from the /fires index. Selection is a
 * per-feature icon-image swap driven by ctx.view; hover shows a lightweight
 * popup (name • acres • containment) and click selects the fire.
 */
import {
  Popup,
  type ExpressionSpecification,
  type GeoJSONSource,
  type Map as MlMap,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import { parseFireCoordinates } from '../../api/geo';
import type { FiresListResponse } from '../../api/types';
import { beforeIdFor } from '../zOrder';
import type { LayerContext, LayerManager } from '../layerTypes';
import { installMarkerImages } from './markerImages';

const SRC = 'rd-fire-pins';
const LYR = 'rd-fire-pins';

const EMPTY_FC: GeoJSON.FeatureCollection<GeoJSON.Point> = {
  type: 'FeatureCollection',
  features: [],
};

/** Mild size boost with fire size (multiplies the zoom ramp). */
const ACRES_BOOST: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['coalesce', ['get', 'acres'], 0],
  0,
  1,
  200000,
  1.35,
];

const ICON_SIZE: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  3,
  ['*', 0.5, ACRES_BOOST],
  10,
  ['*', 0.9, ACRES_BOOST],
];

function iconImageExpr(selectedId: string | null): ExpressionSpecification {
  return [
    'concat',
    [
      'case',
      ['==', ['get', 'firetype'], 'Prescribed Fire'],
      'rd-pin-prescribed',
      'rd-pin-wildfire',
    ],
    ['case', ['==', ['get', 'cornea_id'], selectedId ?? ''], '-selected', ''],
  ];
}

function toFeatureCollection(
  fires: FiresListResponse,
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
  for (const f of fires.fires) {
    const coords = parseFireCoordinates(f.fire_coordinates);
    if (!coords) continue; // unparseable/missing coordinates: skip
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: coords },
      properties: {
        cornea_id: f.cornea_id,
        name: f.post_title,
        acres: f.acres ?? 0,
        containment: f.containment,
        firetype: f.firetype,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function popupHtml(props: Record<string, unknown>): string {
  const parts: string[] = [
    `<strong style="font-family:var(--font-serif)">${escapeHtml(String(props.name ?? 'Unknown fire'))}</strong>`,
  ];
  const acres = Number(props.acres);
  if (Number.isFinite(acres) && acres > 0) parts.push(`${acres.toLocaleString()} acres`);
  const containment = props.containment == null ? NaN : Number(props.containment);
  if (Number.isFinite(containment)) parts.push(`${containment}% contained`);
  return (
    `<div style="font-family:var(--font-sans,sans-serif);font-size:12px;line-height:1.4;` +
    `background:var(--color-surface,#241c21);color:var(--color-text,#e8e2e5);` +
    `border-radius:var(--radius,4px);margin:-10px -10px -15px;padding:8px 10px;">` +
    parts.join(' <span style="opacity:.55">•</span> ') +
    `</div>`
  );
}

// ---------- module state (one live map at a time) ----------

let lastFires: FiresListResponse | undefined;
let lastSelected: string | null | undefined; // undefined = never applied
let ctxRef: LayerContext | null = null;
let popup: Popup | null = null;
const handlersInstalled = new WeakSet<MlMap>();

function onClick(e: MapLayerMouseEvent): void {
  const id = e.features?.[0]?.properties?.cornea_id;
  if (typeof id === 'string' && id) ctxRef?.onSelectFire(id);
}

function onEnter(this: MlMap, e: MapLayerMouseEvent): void {
  this.getCanvas().style.cursor = 'pointer';
  const f = e.features?.[0];
  if (!f || f.geometry.type !== 'Point') return;
  popup ??= new Popup({ closeButton: false, closeOnClick: false, offset: [0, -44] });
  popup
    .setLngLat(f.geometry.coordinates as [number, number])
    .setHTML(popupHtml(f.properties ?? {}))
    .addTo(this);
}

function onLeave(this: MlMap): void {
  this.getCanvas().style.cursor = '';
  popup?.remove();
}

export const firePinsLayer: LayerManager = {
  mount(map) {
    lastFires = undefined;
    lastSelected = undefined;
    installMarkerImages(map);
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: 'geojson', data: EMPTY_FC });
    }
    if (!map.getLayer(LYR)) {
      map.addLayer(
        {
          id: LYR,
          type: 'symbol',
          source: SRC,
          layout: {
            'icon-image': iconImageExpr(null),
            'icon-anchor': 'bottom',
            'icon-size': ICON_SIZE,
            'symbol-sort-key': ['*', -1, ['coalesce', ['get', 'acres'], 0]],
            'icon-allow-overlap': ['step', ['zoom'], false, 8, true],
            'icon-ignore-placement': false,
          },
        },
        beforeIdFor(map, 'rd-fire-pins'),
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
    ctxRef = ctx;
    if (!map.getLayer(LYR)) return;

    if (ctx.fires !== lastFires) {
      lastFires = ctx.fires;
      const src = map.getSource(SRC) as GeoJSONSource | undefined;
      src?.setData(ctx.fires ? toFeatureCollection(ctx.fires) : EMPTY_FC);
    }

    const selected = ctx.view.mode === 'fire' ? ctx.view.corneaId : null;
    if (selected !== lastSelected) {
      lastSelected = selected;
      map.setLayoutProperty(LYR, 'icon-image', iconImageExpr(selected));
    }
  },

  unmount(map) {
    map.off('click', LYR, onClick);
    map.off('mouseenter', LYR, onEnter);
    map.off('mouseleave', LYR, onLeave);
    handlersInstalled.delete(map);
    popup?.remove();
    popup = null;
    ctxRef = null;
    lastFires = undefined;
    lastSelected = undefined;
    if (map.getLayer(LYR)) map.removeLayer(LYR);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },
};
