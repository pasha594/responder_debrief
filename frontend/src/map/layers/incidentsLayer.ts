/** TomTom road incidents: closure segments red-dashed, everything else in
 * its category color. Click for description, road, delay. */
import type { GeoJSONSource, Map as MlMap, MapLayerMouseEvent } from 'maplibre-gl';
import { Popup } from 'maplibre-gl';
import type { IncidentFC } from '../../api/tomtomTraffic';
import { routeClickClaims, useStore } from '../../state/store';
import { beforeIdFor } from '../zOrder';
import type { LayerManager } from '../layerTypes';

const SRC = 'rd-incidents';
const LINE = 'rd-incidents-line';
const PT = 'rd-incidents-pt';

const EMPTY: IncidentFC = { type: 'FeatureCollection', features: [] };

let lastData: IncidentFC | undefined;
let lastVisible: boolean | null = null;
let popup: Popup | null = null;
const handlersInstalled = new WeakSet<MlMap>();

function esc(x: string): string {
  return x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function onClick(this: MlMap, e: MapLayerMouseEvent): void {
  if (routeClickClaims(useStore.getState().directions)) return; // fill click claims
  const f = e.features?.[0];
  if (!f) return;
  const p = f.properties ?? {};
  const delay = Number(p.delayS);
  popup ??= new Popup({ closeButton: false, offset: 8 });
  popup
    .setLngLat(e.lngLat)
    .setHTML(
      `<strong>${esc(String(p.kind ?? 'Incident'))}</strong>` +
        (p.road ? `<br>${esc(String(p.road))}` : '') +
        `<br>${esc(String(p.description ?? ''))}` +
        (Number.isFinite(delay) && delay > 60
          ? `<br>+${Math.round(delay / 60)} min delay`
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

export const incidentsLayer: LayerManager = {
  mount(map) {
    lastData = undefined;
    lastVisible = null;
    if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: EMPTY as unknown as GeoJSON.GeoJSON });
    if (!map.getLayer(LINE)) {
      map.addLayer(
        {
          id: LINE,
          type: 'line',
          source: SRC,
          filter: ['==', ['geometry-type'], 'LineString'],
          layout: { visibility: 'none', 'line-cap': 'round' },
          paint: {
            'line-color': ['get', 'color'],
            'line-width': ['case', ['get', 'closure'], 4, 2.5],
            'line-dasharray': [2, 1.2],
            'line-opacity': 0.95,
          },
        },
        beforeIdFor(map, 'rd-incidents-line'),
      );
    }
    if (!map.getLayer(PT)) {
      map.addLayer(
        {
          id: PT,
          type: 'circle',
          source: SRC,
          layout: { visibility: 'none' },
          paint: {
            'circle-radius': ['case', ['get', 'closure'], 5, 3.5],
            'circle-color': ['get', 'color'],
            'circle-stroke-width': 1.5,
            'circle-stroke-color': '#0d0a0c',
          },
        },
        beforeIdFor(map, 'rd-incidents-pt'),
      );
    }
    if (!handlersInstalled.has(map)) {
      handlersInstalled.add(map);
      for (const lyr of [LINE, PT]) {
        map.on('click', lyr, onClick);
        map.on('mouseenter', lyr, onEnter);
        map.on('mouseleave', lyr, onLeave);
      }
    }
  },

  update(map, ctx) {
    if (!map.getLayer(LINE)) return;
    const visible = ctx.layers.incidents.visible;
    if (visible !== lastVisible) {
      lastVisible = visible;
      const v = visible ? 'visible' : 'none';
      map.setLayoutProperty(LINE, 'visibility', v);
      map.setLayoutProperty(PT, 'visibility', v);
      if (!visible) popup?.remove();
    }
    const data = ctx.incidents ?? EMPTY;
    if (data !== lastData) {
      lastData = data;
      (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(data as unknown as GeoJSON.GeoJSON);
    }
  },

  unmount(map) {
    for (const lyr of [LINE, PT]) {
      map.off('click', lyr, onClick);
      map.off('mouseenter', lyr, onEnter);
      map.off('mouseleave', lyr, onLeave);
    }
    handlersInstalled.delete(map);
    popup?.remove();
    popup = null;
    lastData = undefined;
    lastVisible = null;
    for (const id of [PT, LINE]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },
};
