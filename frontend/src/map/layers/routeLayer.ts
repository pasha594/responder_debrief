/** Directions route line, above every data layer. (Endpoints are draggable
 * maplibre Markers owned by SearchDirectionsControl.) */
import type { GeoJSONSource } from 'maplibre-gl';
import { beforeIdFor } from '../zOrder';
import type { LayerManager } from '../layerTypes';

const SRC = 'rd-route';
const CASING = 'rd-route-casing';
const LINE = 'rd-route-line';
const EMPTY = { type: 'FeatureCollection', features: [] } as GeoJSON.GeoJSON;

let lastRoute: unknown = undefined;

export const routeLayer: LayerManager = {
  mount(map) {
    lastRoute = undefined;
    if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: EMPTY });
    if (!map.getLayer(CASING)) {
      map.addLayer(
        {
          id: CASING,
          type: 'line',
          source: SRC,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#0d0a0c', 'line-width': 7, 'line-opacity': 0.7 },
        },
        beforeIdFor(map, 'rd-route-casing'),
      );
    }
    if (!map.getLayer(LINE)) {
      map.addLayer(
        {
          id: LINE,
          type: 'line',
          source: SRC,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#4aa3ff', 'line-width': 4 },
        },
        beforeIdFor(map, 'rd-route-line'),
      );
    }
  },

  update(map, ctx) {
    if (!map.getLayer(LINE)) return;
    const route = ctx.directions.route;
    if (route !== lastRoute) {
      lastRoute = route;
      (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(
        route
          ? ({ type: 'Feature', geometry: route.geometry, properties: {} } as GeoJSON.GeoJSON)
          : EMPTY,
      );
    }
  },

  unmount(map) {
    lastRoute = undefined;
    for (const id of [LINE, CASING]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },
};
