/** TomTom live traffic flow tiles — relative congestion coloring. Only
 * available when VITE_TOMTOM_KEY ships; the toggle hides itself otherwise. */
import type { LayerManager } from '../layerTypes';
import { beforeIdFor } from '../zOrder';

const TOMTOM_KEY = import.meta.env.VITE_TOMTOM_KEY as string | undefined;
const SRC = 'rd-traffic';
const LYR = 'rd-traffic';

export const trafficAvailable = !!TOMTOM_KEY;

let lastVisible: boolean | null = null;

export const trafficLayer: LayerManager = {
  mount(map) {
    lastVisible = null;
    if (!TOMTOM_KEY) return;
    if (!map.getSource(SRC)) {
      map.addSource(SRC, {
        type: 'raster',
        tiles: [
          `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=${TOMTOM_KEY}`,
        ],
        tileSize: 256,
        maxzoom: 18,
        attribution: '© TomTom',
      });
    }
    if (!map.getLayer(LYR)) {
      map.addLayer(
        {
          id: LYR,
          type: 'raster',
          source: SRC,
          layout: { visibility: 'none' },
          paint: { 'raster-opacity': 0.8 },
        },
        beforeIdFor(map, 'rd-traffic'),
      );
    }
  },

  update(map, ctx) {
    if (!map.getLayer(LYR)) return;
    const visible = ctx.layers.traffic.visible;
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
