/**
 * The selected fire's pin: a teardrop symbol from the /fires index (falling
 * back to the catalog's coordinates). Since the directory pivot this layer
 * renders exactly ONE feature — the fire in view — so no other incidents leak
 * onto the map. Hover shows a lightweight popup (name • acres • containment).
 */
import {
  Popup,
  type ExpressionSpecification,
  type GeoJSONSource,
  type Map as MlMap,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import { parseFireCoordinates } from '../../api/geo';
import { isPrescribed } from '../../api/fireFields';
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
  ['*', 0.25, ACRES_BOOST],
  10,
  ['*', 0.45, ACRES_BOOST],
];

function iconImageExpr(selectedId: string | null): ExpressionSpecification {
  return [
    'concat',
    // `prescribed` is set when the feature is built (the API's firetype
    // spelling has drifted, so the string test lived in one place only).
    ['case', ['get', 'prescribed'], 'rd-pin-prescribed', 'rd-pin-wildfire'],
    ['case', ['==', ['get', 'cornea_id'], selectedId ?? ''], '-selected', ''],
  ];
}

/**
 * One-feature collection for the fire in view. Prefers the live index (it
 * carries firetype/containment); falls back to the catalog's coordinates so a
 * fire the index has dropped still gets a pin.
 */
function selectedFeatureCollection(
  ctx: LayerContext,
  selectedId: string | null,
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  if (!selectedId) return EMPTY_FC;

  const summary = ctx.fires?.fires.find((f) => f.cornea_id === selectedId);
  const coords =
    parseFireCoordinates(summary?.fire_coordinates) ??
    ctx.catalog?.fires.find((f) => f.cornea_id === selectedId)?.coordinates ??
    null;
  if (!coords) return EMPTY_FC;

  const catalogFire = ctx.catalog?.fires.find((f) => f.cornea_id === selectedId);
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: coords },
        properties: {
          cornea_id: selectedId,
          name: summary?.post_title ?? catalogFire?.name ?? ctx.selectedFire?.post_title ?? '',
          acres: summary?.acres ?? catalogFire?.acres ?? 0,
          containment: summary?.containment ?? catalogFire?.containment ?? null,
          prescribed: isPrescribed(summary?.firetype),
        },
      },
    ],
  };
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

let lastFires: LayerContext['fires'] | undefined;
let lastCatalog: LayerContext['catalog'] | undefined;
let lastSelected: string | null | undefined; // undefined = never applied
let ctxRef: LayerContext | null = null;
let popup: Popup | null = null;
const handlersInstalled = new WeakSet<MlMap>();

function onClick(e: MapLayerMouseEvent): void {
  const id = e.features?.[0]?.properties?.cornea_id;
  if (typeof id !== 'string' || !id) return;
  // The only pin on the map is the fire already in view: re-selecting it would
  // reset the sidebar tab and drop the active incident-map overlay.
  const cur = ctxRef?.view;
  if (cur?.mode === 'fire' && cur.corneaId === id) return;
  ctxRef?.onSelectFire(id);
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
    lastCatalog = undefined;
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

    const selected = ctx.view.mode === 'fire' ? ctx.view.corneaId : null;
    if (ctx.fires !== lastFires || ctx.catalog !== lastCatalog || selected !== lastSelected) {
      lastFires = ctx.fires;
      lastCatalog = ctx.catalog;
      const src = map.getSource(SRC) as GeoJSONSource | undefined;
      src?.setData(selectedFeatureCollection(ctx, selected));
    }

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
    lastCatalog = undefined;
    lastSelected = undefined;
    if (map.getLayer(LYR)) map.removeLayer(LYR);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },
};
