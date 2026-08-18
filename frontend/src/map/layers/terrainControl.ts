/**
 * 3D terrain, always on: AWS Open Data terrain tiles (terrarium encoding,
 * keyless) as a raster-dem source + maplibre setTerrain. The first apply
 * eases into a pitched view; pitch stays user-adjustable afterwards
 * (right-drag / two-finger).
 */
import type { Map as MlMap } from 'maplibre-gl';
import type { LayerManager } from '../layerTypes';

const DEM_SRC = 'rd-dem';
const DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

let applied = false;

function apply(map: MlMap): void {
  if (applied) return;
  try {
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
    map.setTerrain({ source: DEM_SRC, exaggeration: 1.2 });
    map.easeTo({ pitch: 48, duration: 900 });
    applied = true;
  } catch {
    /* DEM tiles unreachable — stay 2D and retry next update */
  }
}

export const terrainControl: LayerManager = {
  mount() {
    applied = false;
  },

  update(map) {
    apply(map);
  },

  unmount(map) {
    try {
      map.setTerrain(null);
    } catch {
      /* style gone */
    }
    applied = false;
  },
};
