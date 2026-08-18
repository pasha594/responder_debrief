/**
 * Georeferenced incident-map (GeoPDF) tile overlay. Exclusive: at most one
 * manifest entry is shown, chosen by ctx.layers.incidentMap.mapId. The
 * source is recreated on mapId change (tile URLs/zooms/bounds all differ).
 */
import type { Map as MlMap } from 'maplibre-gl';
import { dataUrl } from '../../api/catalogs';
import type { IncidentMapEntry } from '../../api/types';
import { beforeIdFor } from '../zOrder';
import type { LayerManager } from '../layerTypes';

const SRC = 'rd-incident-map';
const LYR = 'rd-incident-map';

let lastKey: string | null = null; // `${mapId}@${rev}`
let lastOpacity: number | null = null;

function removeAll(map: MlMap): void {
  if (map.getLayer(LYR)) map.removeLayer(LYR);
  if (map.getSource(SRC)) map.removeSource(SRC);
  lastKey = null;
  lastOpacity = null;
}

function findEntry(ctx: { incidentManifest?: { maps: IncidentMapEntry[] } | undefined }, mapId: string) {
  return ctx.incidentManifest?.maps.find((m) => m.id === mapId && m.tiles != null) ?? null;
}

export const incidentMapLayer: LayerManager = {
  mount() {
    lastKey = null;
    lastOpacity = null;
    // Created lazily when a map is selected.
  },

  update(map, ctx) {
    const mapId = ctx.layers.incidentMap.mapId;
    const entry = mapId ? findEntry(ctx, mapId) : null;
    const tiles = entry?.tiles ?? null;

    if (!entry || !tiles) {
      removeAll(map);
      return;
    }

    const key = `${entry.id}@${entry.rev}`;
    if (key !== lastKey || !map.getSource(SRC)) {
      removeAll(map);
      map.addSource(SRC, {
        type: 'raster',
        tiles: [dataUrl(tiles.url_template)],
        // gdal2tiles emits 256px tiles; MapLibre's default is 512, which
        // fetches one zoom level coarser than the screen needs and stretches
        // it 2x — declaring the real size recovers a full level of sharpness.
        tileSize: 256,
        minzoom: tiles.minzoom,
        maxzoom: tiles.maxzoom,
        bounds: tiles.bounds,
      });
      lastKey = key;
    }
    if (!map.getLayer(LYR)) {
      map.addLayer(
        {
          id: LYR,
          type: 'raster',
          source: SRC,
          paint: { 'raster-opacity': ctx.layers.incidentMap.opacity },
        },
        beforeIdFor(map, 'rd-incident-map'),
      );
      lastOpacity = ctx.layers.incidentMap.opacity;
    }

    if (ctx.layers.incidentMap.opacity !== lastOpacity) {
      lastOpacity = ctx.layers.incidentMap.opacity;
      map.setPaintProperty(LYR, 'raster-opacity', lastOpacity);
    }
  },

  unmount(map) {
    removeAll(map);
  },
};
