/** Directions route line + A/B endpoint dots, above every data layer. */
import type { GeoJSONSource } from 'maplibre-gl';
import { beforeIdFor } from '../zOrder';
import type { LayerManager } from '../layerTypes';

const SRC = 'rd-route';
const CASING = 'rd-route-casing';
const LINE = 'rd-route-line';
const ENDS_SRC = 'rd-route-ends';
const ENDS = 'rd-route-ends';

const EMPTY = { type: 'FeatureCollection', features: [] } as GeoJSON.GeoJSON;

let lastRoute: unknown = undefined;
let lastEnds = '';

export const routeLayer: LayerManager = {
  mount(map) {
    lastRoute = undefined;
    lastEnds = '';
    if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: EMPTY });
    if (!map.getSource(ENDS_SRC)) map.addSource(ENDS_SRC, { type: 'geojson', data: EMPTY });
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
    if (!map.getLayer(ENDS)) {
      map.addLayer(
        {
          id: ENDS,
          type: 'circle',
          source: ENDS_SRC,
          paint: {
            'circle-radius': 6,
            'circle-color': ['case', ['==', ['get', 'which'], 'a'], '#ffffff', '#4aa3ff'],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#0d0a0c',
          },
        },
        beforeIdFor(map, 'rd-route-ends'),
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
    const ends = JSON.stringify([ctx.directions.a?.coords, ctx.directions.b?.coords]);
    if (ends !== lastEnds) {
      lastEnds = ends;
      const features = (['a', 'b'] as const)
        .map((w) => ctx.directions[w])
        .map((p, i) =>
          p
            ? {
                type: 'Feature' as const,
                geometry: { type: 'Point' as const, coordinates: p.coords },
                properties: { which: i === 0 ? 'a' : 'b' },
              }
            : null,
        )
        .filter((f): f is NonNullable<typeof f> => f !== null);
      (map.getSource(ENDS_SRC) as GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features,
      } as GeoJSON.GeoJSON);
    }
  },

  unmount(map) {
    lastRoute = undefined;
    lastEnds = '';
    for (const id of [ENDS, LINE, CASING]) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of [ENDS_SRC, SRC]) if (map.getSource(id)) map.removeSource(id);
  },
};
