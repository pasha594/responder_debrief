/** Drive-time isochrone rings (reachable range) — nested translucent
 * polygons, largest ring first so smaller budgets stay clickable/visible. */
import type { GeoJSONSource } from 'maplibre-gl';
import type { RangeRing } from '../../api/routing';
import { beforeIdFor } from '../zOrder';
import type { LayerManager } from '../layerTypes';

const SRC = 'rd-range';
const FILL = 'rd-range-fill';
const LINE = 'rd-range-line';

export const RANGE_COLORS: Record<number, string> = {
  15: '#5fd0a5',
  30: '#4a9fd8',
  60: '#8a6fd1',
};

const EMPTY = { type: 'FeatureCollection', features: [] } as GeoJSON.GeoJSON;

let lastRings: unknown = undefined;

function ringsToFC(rings: RangeRing[]): GeoJSON.GeoJSON {
  return {
    type: 'FeatureCollection',
    features: [...rings]
      .sort((a, b) => b.minutes - a.minutes) // large first → small drawn on top
      .map((r) => ({
        type: 'Feature' as const,
        geometry: r.polygon,
        properties: { minutes: r.minutes, color: RANGE_COLORS[r.minutes] ?? '#4a9fd8' },
      })),
  } as GeoJSON.GeoJSON;
}

export const rangeLayer: LayerManager = {
  mount(map) {
    lastRings = undefined;
    if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: EMPTY });
    if (!map.getLayer(FILL)) {
      map.addLayer(
        {
          id: FILL,
          type: 'fill',
          source: SRC,
          paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.08 },
        },
        beforeIdFor(map, 'rd-range-fill'),
      );
    }
    if (!map.getLayer(LINE)) {
      map.addLayer(
        {
          id: LINE,
          type: 'line',
          source: SRC,
          paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-opacity': 0.9 },
        },
        beforeIdFor(map, 'rd-range-line'),
      );
    }
  },

  update(map, ctx) {
    if (!map.getLayer(FILL)) return;
    const rings = ctx.range.rings;
    if (rings !== lastRings) {
      lastRings = rings;
      (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(
        rings.length ? ringsToFC(rings) : EMPTY,
      );
    }
  },

  unmount(map) {
    lastRings = undefined;
    for (const id of [LINE, FILL]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },
};
