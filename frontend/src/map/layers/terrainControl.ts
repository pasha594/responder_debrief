/**
 * 3D terrain toggle (Draw tab): AWS Open Data terrain tiles (terrarium
 * encoding, keyless) as a raster-dem source + maplibre setTerrain. Enabling
 * eases to a pitched view; disabling flattens back. Self-driven off the
 * store's ui.terrain3d flag.
 */
import type { Map as MlMap } from 'maplibre-gl';
import { useStore } from '../../state/store';
import type { LayerManager } from '../layerTypes';

const DEM_SRC = 'rd-dem';
const DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

let unsubscribe: (() => void) | null = null;
let applied = false;

function apply(map: MlMap, on: boolean): void {
  if (on === applied) return;
  try {
    if (on) {
      if (!map.getSource(DEM_SRC)) {
        map.addSource(DEM_SRC, {
          type: 'raster-dem',
          tiles: [DEM_TILES],
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: 15,
          attribution: 'Terrain: Mapzen/AWS Open Data',
        });
      }
      map.setTerrain({ source: DEM_SRC, exaggeration: 1.25 });
      map.easeTo({ pitch: 58, duration: 700 });
    } else {
      map.setTerrain(null);
      map.easeTo({ pitch: 0, duration: 500 });
    }
    applied = on;
  } catch {
    /* DEM tiles unreachable — stay 2D */
  }
}

export const terrainControl: LayerManager = {
  mount(map) {
    applied = false;
    unsubscribe = useStore.subscribe((state, prev) => {
      if (state.ui.terrain3d !== prev.ui.terrain3d) apply(map, state.ui.terrain3d);
    });
  },

  update(map) {
    apply(map, useStore.getState().ui.terrain3d);
  },

  unmount(map) {
    unsubscribe?.();
    unsubscribe = null;
    try {
      map.setTerrain(null);
    } catch {
      /* style gone */
    }
    applied = false;
  },
};
