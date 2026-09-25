/**
 * Land status (NIFC Jurisdictional Units) around the fire: public land tinted
 * by agency in NIFC's own land-status colors, private land left unshaded.
 * Under the basemap labels and every data layer — it's the ground the rest
 * sits on. Not tappable: it covers the whole map, so a popup would swallow
 * every dropped pin; the pin card names the unit instead.
 */
import type { ExpressionSpecification, GeoJSONSource } from 'maplibre-gl';
import { FALLBACK_CLASS, LAND_CLASSES, type LandStatusFC } from '../../api/nifcLandStatus';
import { beforeIdFor } from '../zOrder';
import type { LayerManager } from '../layerTypes';

const SRC = 'rd-land';
const FILL = 'rd-land-fill';
const LINE = 'rd-land-line';

const EMPTY: LandStatusFC = { type: 'FeatureCollection', features: [] };

/** Category → one of the class colors, unknown codes as "other federal". */
function byClass(key: 'fill' | 'line'): ExpressionSpecification {
  return [
    'match',
    ['get', 'JurisdictionalCategory'],
    ...LAND_CLASSES.flatMap((c) => [c.codes, c[key]]),
    FALLBACK_CLASS[key],
  ] as unknown as ExpressionSpecification;
}

let lastData: LandStatusFC | undefined;
let lastVisible: boolean | null = null;

export const landStatusLayer: LayerManager = {
  mount(map) {
    lastData = undefined;
    lastVisible = null;
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
          // enough to tell agencies apart without washing out the imagery
          paint: { 'fill-color': byClass('fill'), 'fill-opacity': 0.35 },
        },
        beforeIdFor(map, 'rd-land-fill'),
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
            'line-color': byClass('line'),
            'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 12, 2],
          },
        },
        beforeIdFor(map, 'rd-land-line'),
      );
    }
  },

  update(map, ctx) {
    if (!map.getLayer(FILL)) return;
    const visible = ctx.layers.land.visible;
    if (visible !== lastVisible) {
      lastVisible = visible;
      const v = visible ? 'visible' : 'none';
      map.setLayoutProperty(FILL, 'visibility', v);
      map.setLayoutProperty(LINE, 'visibility', v);
    }
    const data = ctx.landStatus ?? EMPTY;
    if (data !== lastData) {
      lastData = data;
      (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(
        data as unknown as GeoJSON.GeoJSON,
      );
    }
  },

  unmount(map) {
    lastData = undefined;
    lastVisible = null;
    if (map.getLayer(LINE)) map.removeLayer(LINE);
    if (map.getLayer(FILL)) map.removeLayer(FILL);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },
};
