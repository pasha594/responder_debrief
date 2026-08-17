/**
 * National current-year perimeters raster (gs01). The upstream layer name is a
 * rotating timestamped snapshot, so the qualified name comes from
 * catalog.national_layers at runtime; the source is recreated when it rotates.
 */
import { nationalPerimetersTileTemplate } from '../../api/wmsUrls';
import { beforeIdFor } from '../zOrder';
import type { LayerManager } from '../layerTypes';

const SRC = 'rd-national-perimeters';
const LYR = 'rd-national-perimeters';

let lastLayerName: string | null = null;
let lastVisible: boolean | null = null;

function removeAll(map: Parameters<LayerManager['mount']>[0]): void {
  if (map.getLayer(LYR)) map.removeLayer(LYR);
  if (map.getSource(SRC)) map.removeSource(SRC);
  lastLayerName = null;
  lastVisible = null;
}

export const nationalPerimetersLayer: LayerManager = {
  mount() {
    lastLayerName = null;
    lastVisible = null;
    // Source/layer are created lazily once the catalog provides a layer name.
  },

  update(map, ctx) {
    const qualified = ctx.catalog?.national_layers?.current_year_perimeters?.layer ?? null;
    if (!qualified) {
      removeAll(map); // hide gracefully when the catalog lacks the layer
      return;
    }

    if (qualified !== lastLayerName || !map.getSource(SRC)) {
      removeAll(map);
      map.addSource(SRC, {
        type: 'raster',
        tiles: [nationalPerimetersTileTemplate(qualified)],
        tileSize: 512,
      });
      lastLayerName = qualified;
    }
    if (!map.getLayer(LYR)) {
      map.addLayer(
        {
          id: LYR,
          type: 'raster',
          source: SRC,
          paint: { 'raster-opacity': 0.85 },
        },
        beforeIdFor(map, 'rd-national-perimeters'),
      );
      lastVisible = null;
    }

    const visible = ctx.view.mode === 'national' && ctx.layers.nationalPerimeters.visible;
    if (visible !== lastVisible) {
      lastVisible = visible;
      map.setLayoutProperty(LYR, 'visibility', visible ? 'visible' : 'none');
    }
  },

  unmount(map) {
    removeAll(map);
  },
};
