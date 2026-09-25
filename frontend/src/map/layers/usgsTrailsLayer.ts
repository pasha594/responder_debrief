/** Trails from USGS National Digital Trails — the multi-agency aggregate
 * (Forest Service, BLM, Park Service, FWS, several states) — drawn by The
 * National Map's own export service (keyless, CORS *), so there's no worker
 * job behind it. Online only, USGS styling, not tappable; the data lags the
 * agencies by a few months. Rendered at 2× for crisp lines on retina. */
import type { LayerManager } from '../layerTypes';
import { beforeIdFor } from '../zOrder';

const SRC = 'rd-usgs-trails';
const LYR = 'rd-usgs-trails';
const TILES =
  'https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/export' +
  '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&dpi=192' +
  '&layers=show:37&format=png32&transparent=true&f=image';

let lastVisible: boolean | null = null;

export const usgsTrailsLayer: LayerManager = {
  mount(map) {
    lastVisible = null;
    if (!map.getSource(SRC)) {
      map.addSource(SRC, {
        type: 'raster',
        tiles: [TILES],
        tileSize: 256,
        maxzoom: 17,
        attribution: 'Trails: USGS National Digital Trails',
      });
    }
    if (!map.getLayer(LYR)) {
      map.addLayer(
        {
          id: LYR,
          type: 'raster',
          source: SRC,
          // below z9 a tile spans ~80 km of dense trail network — slow to
          // draw server-side and unreadable anyway
          minzoom: 9,
          layout: { visibility: 'none' },
          paint: { 'raster-opacity': 0.9 },
        },
        beforeIdFor(map, 'rd-usgs-trails'),
      );
    }
  },

  update(map, ctx) {
    if (!map.getLayer(LYR)) return;
    const visible = ctx.layers.trails.visible;
    if (visible !== lastVisible) {
      lastVisible = visible;
      map.setLayoutProperty(LYR, 'visibility', visible ? 'visible' : 'none');
    }
  },

  unmount(map) {
    lastVisible = null;
    if (map.getLayer(LYR)) map.removeLayer(LYR);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },
};
