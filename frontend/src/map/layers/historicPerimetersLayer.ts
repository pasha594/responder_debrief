/**
 * Historic fire perimeters (NIFC, last 10 years) — burn-scar context under
 * the live layers. Recency ramp: last season warm amber fading to grey a
 * decade back. Each fire's name and year sit in its middle; click for acres.
 */
import {
  Popup,
  type ExpressionSpecification,
  type GeoJSONSource,
  type SymbolLayerSpecification,
  type Map as MlMap,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import type { HistoricPerimeterFC } from '../../api/nifcHistory';
import { HISTORY_YEARS } from '../../api/nifcHistory';
import { routeClickClaims, useStore } from '../../state/store';
import { rdLabelFont } from '../glyphFonts';
import { beforeIdFor } from '../zOrder';
import type { LayerManager } from '../layerTypes';
import { historicLabelPoints, type HistoricLabelFC } from './historicLabels';

const SRC = 'rd-hist-perims';
const FILL = 'rd-hist-perims-fill';
const LINE = 'rd-hist-perims-line';
const LABEL_SRC = 'rd-hist-perims-labels';
const LABEL = 'rd-hist-perims-label';

const EMPTY: HistoricPerimeterFC = { type: 'FeatureCollection', features: [] };
const NO_LABELS: HistoricLabelFC = { type: 'FeatureCollection', features: [] };

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

/** Label ink: a dark shade of the outline's recency colour, on a white halo
 * so it reads on the dark map, topo and satellite alike. */
function labelInkExpr(nowYear: number): ExpressionSpecification {
  return [
    'interpolate',
    ['linear'],
    ['coalesce', ['get', 'yearNum'], nowYear - HISTORY_YEARS],
    nowYear - HISTORY_YEARS,
    '#46413c',
    nowYear - 5,
    '#574630',
    nowYear - 1,
    '#6e4610',
  ];
}

function labelLayerSpec(map: MlMap, nowYear: number, visible: boolean): SymbolLayerSpecification {
  const hasName: ExpressionSpecification = ['!=', ['get', 'name'], ''];
  const hasYear: ExpressionSpecification = ['!=', ['get', 'year'], ''];
  return {
    id: LABEL,
    type: 'symbol',
    source: LABEL_SRC,
    layout: {
      visibility: visible ? 'visible' : 'none',
      'text-field': [
        'format',
        ['get', 'name'], {},
        ['case', ['all', hasName, hasYear], '\n', ''], {},
        ['get', 'year'], { 'font-scale': 0.85 },
      ],
      'text-font': rdLabelFont(map),
      'text-size': ['interpolate', ['linear'], ['zoom'], 9, 11, 13, 13.5],
      'text-max-width': 8,
      'text-padding': 4,
      // where two labels collide, the bigger fire's wins
      'symbol-sort-key': ['-', 0, ['get', 'acres']],
    },
    paint: {
      'text-color': labelInkExpr(nowYear),
      'text-halo-color': 'rgba(255, 255, 255, 0.92)',
      'text-halo-width': 1.6,
    },
  };
}

/** Text layers need the style's glyph server; the offline boot style has
 * none, so the label layer waits for a network style. */
function ensureLabelLayer(map: MlMap, visible: boolean): void {
  if (map.getLayer(LABEL) || !map.getGlyphs()) return;
  map.addLayer(
    labelLayerSpec(map, new Date().getUTCFullYear(), visible),
    beforeIdFor(map, 'rd-hist-perims-label'),
  );
}

let lastData: HistoricPerimeterFC | undefined;
let lastVisible: boolean | null = null;
let popup: Popup | null = null;
const handlersInstalled = new WeakSet<MlMap>();

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The fire's year. Not DATE_CUR: that is when the record was last edited
 * (2017's South Fork fire carries 20190102, the day it was re-imported). */
export function fmtWhen(p: Record<string, unknown>): string {
  return p.FIRE_YEAR_INT == null ? '—' : String(p.FIRE_YEAR_INT);
}

function onClick(this: MlMap, e: MapLayerMouseEvent): void {
  if (routeClickClaims(useStore.getState().directions)) return; // fill click claims
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
    if (!map.getSource(LABEL_SRC)) {
      map.addSource(LABEL_SRC, { type: 'geojson', data: NO_LABELS as unknown as GeoJSON.GeoJSON });
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
    ensureLabelLayer(map, false);
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
    ensureLabelLayer(map, visible);
    if (visible !== lastVisible) {
      lastVisible = visible;
      const v = visible ? 'visible' : 'none';
      map.setLayoutProperty(FILL, 'visibility', v);
      map.setLayoutProperty(LINE, 'visibility', v);
      if (map.getLayer(LABEL)) map.setLayoutProperty(LABEL, 'visibility', v);
      if (!visible) popup?.remove();
    }
    const data = ctx.historicPerimeters ?? EMPTY;
    if (data !== lastData) {
      lastData = data;
      (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(
        data as unknown as GeoJSON.GeoJSON,
      );
      (map.getSource(LABEL_SRC) as GeoJSONSource | undefined)?.setData(
        historicLabelPoints(data) as unknown as GeoJSON.GeoJSON,
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
    if (map.getLayer(LABEL)) map.removeLayer(LABEL);
    if (map.getLayer(LINE)) map.removeLayer(LINE);
    if (map.getLayer(FILL)) map.removeLayer(FILL);
    if (map.getSource(LABEL_SRC)) map.removeSource(LABEL_SRC);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },
};
