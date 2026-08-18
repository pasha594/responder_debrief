// RETIRED by the directory pivot: the map is single-fire now, so this CONUS
// perimeter raster is no longer in useMapLayerSync's MANAGERS list.
/**
 * National current-year perimeters: a single pre-rendered CONUS snapshot
 * image from B2 (catalog.national_layers). The image path is MUTABLE (the
 * worker overwrites it every sync), so the resolved URL carries a ?t={as_of}
 * cache-buster; the source is recreated when as_of rotates.
 */
import { nationalPerimetersImage } from '../../api/wmsUrls';
import { beforeIdFor } from '../zOrder';
import type { LayerManager } from '../layerTypes';

const SRC = 'rd-national-perimeters';
const LYR = 'rd-national-perimeters';

let lastUrl: string | null = null;
let lastVisible: boolean | null = null;

function removeAll(map: Parameters<LayerManager['mount']>[0]): void {
  if (map.getLayer(LYR)) map.removeLayer(LYR);
  if (map.getSource(SRC)) map.removeSource(SRC);
  lastUrl = null;
  lastVisible = null;
}

export const nationalPerimetersLayer: LayerManager = {
  mount() {
    lastUrl = null;
    lastVisible = null;
    // Source/layer are created lazily once the catalog provides the image.
  },

  update(map, ctx) {
    const img = nationalPerimetersImage(ctx.catalog);
    if (!img) {
      removeAll(map); // hide gracefully when the catalog lacks the block
      return;
    }

    if (img.url !== lastUrl || !map.getSource(SRC)) {
      removeAll(map);
      map.addSource(SRC, {
        type: 'image',
        url: img.url,
        coordinates: img.coords,
      });
      lastUrl = img.url;
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

    // Unreachable while retired: no mode shows a CONUS-wide overlay any more.
    const visible = ctx.view.mode !== 'fire' && ctx.layers.nationalPerimeters.visible;
    if (visible !== lastVisible) {
      lastVisible = visible;
      map.setLayoutProperty(LYR, 'visibility', visible ? 'visible' : 'none');
    }
  },

  unmount(map) {
    removeAll(map);
  },
};
