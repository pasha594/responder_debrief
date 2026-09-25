/** Directions route line, above every data layer. (Endpoints are draggable
 * maplibre Markers owned by SearchDirectionsControl.)
 *
 * Walk routes arrive as legs: road/trail/online legs draw solid blue as
 * before; cross-country legs draw dashed, split by vegetation run and
 * coloured from the shared vegetation table; untimed gap legs draw dotted
 * pale; white dots mark where a route joins or leaves a trail. One layer per
 * dash class (the repo convention, drawLayer.ts). A route without legs
 * (Drive, Apparatus) is one solid feature, exactly as before. */
import type { ExpressionSpecification, GeoJSONSource } from 'maplibre-gl';
import type { RouteResult } from '../../api/routing';
import { vegColorMatch } from '../../routing/vegClasses';
import { beforeIdFor } from '../zOrder';
import type { LayerManager } from '../layerTypes';

const SRC = 'rd-route';
const CASING = 'rd-route-casing';
const LINE = 'rd-route-line';
const XC = 'rd-route-xc';
const GAP = 'rd-route-gap';
const JOINS = 'rd-route-joins';
const EMPTY = { type: 'FeatureCollection', features: [] } as GeoJSON.GeoJSON;

type Feat = GeoJSON.Feature<GeoJSON.LineString | GeoJSON.Point, { kind: string; veg?: number }>;

/** Route → features (pure; exported for tests). */
export function routeFeatures(route: RouteResult | null): GeoJSON.FeatureCollection {
  if (!route) return { type: 'FeatureCollection', features: [] };
  if (!route.legs?.length) {
    return { type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: route.geometry, properties: { kind: 'road' } },
    ] };
  }
  const out: Feat[] = [];
  const line = (coordinates: [number, number][], props: Feat['properties']) => {
    if (coordinates.length >= 2) out.push({ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: props });
  };
  const legs = route.legs;
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i];
    if (l.kind === 'xc') {
      const runs = l.vegRuns?.length ? l.vegRuns : [{ veg: 0, from: 0, to: l.coordinates.length - 1 }];
      for (const r of runs) line(l.coordinates.slice(r.from, r.to + 1), { kind: 'xc', veg: r.veg });
    } else {
      line(l.coordinates, { kind: l.kind });
    }
    const next = legs[i + 1];
    if (next && !l.minor && !next.minor && (l.kind === 'xc') !== (next.kind === 'xc')
        && l.kind !== 'gap' && next.kind !== 'gap') {
      const p = l.coordinates[l.coordinates.length - 1];
      out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: { kind: 'join' } });
    }
  }
  return { type: 'FeatureCollection', features: out };
}

const isLine: ExpressionSpecification = ['==', ['geometry-type'], 'LineString'];

let lastRoute: unknown = undefined;

export const routeLayer: LayerManager = {
  mount(map) {
    lastRoute = undefined;
    if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: EMPTY });
    const round = { 'line-cap': 'round' as const, 'line-join': 'round' as const };
    if (!map.getLayer(CASING)) {
      map.addLayer(
        {
          id: CASING,
          type: 'line',
          source: SRC,
          filter: ['all', isLine, ['!=', ['get', 'kind'], 'gap']],
          layout: round,
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
          filter: ['all', isLine, ['in', ['get', 'kind'], ['literal', ['road', 'trail', 'net']]]],
          layout: round,
          paint: { 'line-color': '#4aa3ff', 'line-width': 4 },
        },
        beforeIdFor(map, 'rd-route-line'),
      );
    }
    if (!map.getLayer(XC)) {
      map.addLayer(
        {
          id: XC,
          type: 'line',
          source: SRC,
          filter: ['all', isLine, ['==', ['get', 'kind'], 'xc']],
          layout: { 'line-join': 'round' },
          paint: {
            'line-color': vegColorMatch() as unknown as ExpressionSpecification,
            'line-width': 4,
            'line-dasharray': [1.6, 1.2],
          },
        },
        beforeIdFor(map, 'rd-route-xc'),
      );
    }
    if (!map.getLayer(GAP)) {
      map.addLayer(
        {
          id: GAP,
          type: 'line',
          source: SRC,
          filter: ['all', isLine, ['==', ['get', 'kind'], 'gap']],
          layout: { 'line-cap': 'round' },
          paint: { 'line-color': '#f2eff0', 'line-width': 3, 'line-dasharray': [0.4, 1.6] },
        },
        beforeIdFor(map, 'rd-route-gap'),
      );
    }
    if (!map.getLayer(JOINS)) {
      map.addLayer(
        {
          id: JOINS,
          type: 'circle',
          source: SRC,
          filter: ['==', ['get', 'kind'], 'join'],
          paint: {
            'circle-radius': 4.5,
            'circle-color': '#ffffff',
            'circle-stroke-color': '#0d0a0c',
            'circle-stroke-width': 2,
          },
        },
        beforeIdFor(map, 'rd-route-joins'),
      );
    }
  },

  update(map, ctx) {
    if (!map.getLayer(LINE)) return;
    const route = ctx.directions.route;
    if (route !== lastRoute) {
      lastRoute = route;
      (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(
        routeFeatures(route) as unknown as GeoJSON.GeoJSON,
      );
    }
  },

  unmount(map) {
    lastRoute = undefined;
    for (const id of [JOINS, GAP, XC, LINE, CASING]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },
};
