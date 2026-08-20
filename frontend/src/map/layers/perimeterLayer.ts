/**
 * Selected-fire perimeter: the version already resolved for currentTime by
 * useMapLayerSync (ctx.perimeterFeature). setData only when the feature
 * identity changes; empty source when hidden or before the first version.
 */
import type { GeoJSONSource } from 'maplibre-gl';
import type { PerimeterFeature } from '../../api/types';
import { beforeIdFor } from '../zOrder';
import type { LayerManager } from '../layerTypes';

const SRC = 'rd-perimeter';
const FILL = 'rd-perimeter-fill';
const LINE = 'rd-perimeter-line';

const PERIMETER_COLOR = '#CC0000'; // tokens.css --perimeter

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

let lastFeature: PerimeterFeature | null = null;
let lastFireKey: string | null = null;
let lastVisible: boolean | null = null;

export const perimeterLayer: LayerManager = {
  mount(map) {
    lastFeature = null;
    lastVisible = null;
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: 'geojson', data: EMPTY_FC });
    }
    if (!map.getLayer(FILL)) {
      map.addLayer(
        {
          id: FILL,
          type: 'fill',
          source: SRC,
          paint: { 'fill-color': PERIMETER_COLOR, 'fill-opacity': 0.13 },
        },
        beforeIdFor(map, 'rd-perimeter-fill'),
      );
    }
    if (!map.getLayer(LINE)) {
      map.addLayer(
        {
          id: LINE,
          type: 'line',
          source: SRC,
          paint: { 'line-color': PERIMETER_COLOR, 'line-width': 2 },
        },
        beforeIdFor(map, 'rd-perimeter-line'),
      );
    }
  },

  update(map, ctx) {
    if (!map.getLayer(FILL) || !map.getLayer(LINE)) return;

    const on = ctx.view.mode === 'fire' && ctx.layers.perimeters.visible;
    const fireKey = ctx.view.mode === 'fire' ? ctx.view.corneaId : null;
    if (fireKey !== lastFireKey) {
      // New fire: never show the previous fire's shape, even for a frame.
      lastFireKey = fireKey;
      lastFeature = null;
      (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(EMPTY_FC);
    }

    // ctx.perimeterFeature goes undefined for a beat every time playback
    // crosses a version boundary (the next version is still fetching).
    // HOLD the current shape through that gap instead of strobing — only an
    // explicit hide or fire switch clears it.
    const feature = on ? (ctx.perimeterFeature ?? lastFeature) : null;
    const visible = feature !== null;

    if (visible !== lastVisible) {
      lastVisible = visible;
      const vis = visible ? 'visible' : 'none';
      map.setLayoutProperty(FILL, 'visibility', vis);
      map.setLayoutProperty(LINE, 'visibility', vis);
    }

    if (feature !== lastFeature) {
      lastFeature = feature;
      const src = map.getSource(SRC) as GeoJSONSource | undefined;
      src?.setData(feature ?? EMPTY_FC);
    }
  },

  unmount(map) {
    lastFeature = null;
    lastFireKey = null;
    lastVisible = null;
    if (map.getLayer(LINE)) map.removeLayer(LINE);
    if (map.getLayer(FILL)) map.removeLayer(FILL);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },
};
