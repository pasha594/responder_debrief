/**
 * Historic fire perimeters (NIFC, last 10 years) — burn-scar context under
 * the live layers. Recency ramp: last season warm amber fading to grey a
 * decade back. Click for name, year, acres.
 */
import {
  Popup,
  type ExpressionSpecification,
  type GeoJSONSource,
  type Map as MlMap,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import type { HistoricPerimeterFC } from '../../api/nifcHistory';
import { HISTORY_YEARS } from '../../api/nifcHistory';
import { beforeIdFor } from '../zOrder';
import type { LayerManager } from '../layerTypes';

const SRC = 'rd-hist-perims';
const FILL = 'rd-hist-perims-fill';
const LINE = 'rd-hist-perims-line';

const EMPTY: HistoricPerimeterFC = { type: 'FeatureCollection', features: [] };

/** Recent burns amber, fading to grey by HISTORY_YEARS back. */
export function recencyColorExpr(nowYear: number): ExpressionSpecification {
  return [
    'interpolate',
    ['linear'],
    ['coalesce', ['get', 'FIRE_YEAR_INT'], nowYear - HISTORY_YEARS],
    nowYear - HISTORY_YEARS,
    '#6f675f',
    nowYear - 5,
    '#a5875a',
    nowYear - 1,
    '#e0a24a',
  ];
}

let lastData: HistoricPerimeterFC | undefined;
let lastVisible: boolean | null = null;
let popup: Popup | null = null;
const handlersInstalled = new WeakSet<MlMap>();

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** DATE_CUR arrives as a "YYYYMMDDHHMMSS" string → "MM/YY". */
export function fmtWhen(p: Record<string, unknown>): string {
  const raw = String(p.DATE_CUR ?? '');
  const m = /^(19|20)(\d{2})(\d{2})/.exec(raw);
  if (m) return `${m[3]}/${m[2]}`;
  return String(p.FIRE_YEAR_INT ?? '—');
}

function onClick(this: MlMap, e: MapLayerMouseEvent): void {
  const f = e.features?.[0];
  if (!f) return;
  const p = f.properties ?? {};
  const acres = Number(p.GIS_ACRES);
  popup ??= new Popup({ closeButton: false, offset: 8 });
  popup
    .setLngLat(e.lngLat)
    .setHTML(
      `<strong>${esc(String(p.INCIDENT ?? 'Unnamed fire'))}</strong>` +
        ` <span style="opacity:.55">•</span> ${esc(fmtWhen(p))}` +
        (Number.isFinite(acres)
          ? ` <span style="opacity:.55">•</span> ${Math.round(acres).toLocaleString('en-US')} ac`
          : ''),
    )
    .addTo(this);
}

function onEnter(this: MlMap): void {
  this.getCanvas().style.cursor = 'pointer';
}
function onLeave(this: MlMap): void {
  this.getCanvas().style.cursor = '';
}

export const historicPerimetersLayer: LayerManager = {
  mount(map) {
    lastData = undefined;
    lastVisible = null;
    const nowYear = new Date().getUTCFullYear();
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: 'geojson', data: EMPTY as unknown as GeoJSON.GeoJSON });
    }
    if (!map.getLayer(FILL)) {
      map.addLayer(
        {
          id: FILL,
          type: 'fill',
          source: SRC,
          layout: { visibility: 'none' },
          paint: { 'fill-color': recencyColorExpr(nowYear), 'fill-opacity': 0.08 },
        },
        beforeIdFor(map, 'rd-hist-perims-fill'),
      );
    }
    if (!map.getLayer(LINE)) {
      map.addLayer(
        {
          id: LINE,
          type: 'line',
          source: SRC,
          layout: { visibility: 'none' },
          paint: {
            'line-color': recencyColorExpr(nowYear),
            'line-width': 1,
            'line-opacity': 0.8,
          },
        },
        beforeIdFor(map, 'rd-hist-perims-line'),
      );
    }
    if (!handlersInstalled.has(map)) {
      handlersInstalled.add(map);
      map.on('click', FILL, onClick);
      map.on('mouseenter', FILL, onEnter);
      map.on('mouseleave', FILL, onLeave);
    }
  },

  update(map, ctx) {
    if (!map.getLayer(FILL)) return;
    const visible = ctx.layers.historicPerimeters.visible;
    if (visible !== lastVisible) {
      lastVisible = visible;
      const v = visible ? 'visible' : 'none';
      map.setLayoutProperty(FILL, 'visibility', v);
      map.setLayoutProperty(LINE, 'visibility', v);
      if (!visible) popup?.remove();
    }
    const data = ctx.historicPerimeters ?? EMPTY;
    if (data !== lastData) {
      lastData = data;
      (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(
        data as unknown as GeoJSON.GeoJSON,
      );
    }
  },

  unmount(map) {
    map.off('click', FILL, onClick);
    map.off('mouseenter', FILL, onEnter);
    map.off('mouseleave', FILL, onLeave);
    handlersInstalled.delete(map);
    popup?.remove();
    popup = null;
    lastData = undefined;
    lastVisible = null;
    if (map.getLayer(LINE)) map.removeLayer(LINE);
    if (map.getLayer(FILL)) map.removeLayer(FILL);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },
};
