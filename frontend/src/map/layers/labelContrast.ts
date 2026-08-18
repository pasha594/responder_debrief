/**
 * Basemap label legibility under weather rasters. The dark style's labels
 * (light text, subtle dark halo) drown on a bright raster — cold-blue
 * temperature, pale smoke. While ANY weather layer is visible, every basemap
 * symbol layer gets a strong near-black halo; light text + dark halo reads on
 * any ground, so no per-product color guessing. Originals are saved on first
 * override and restored when the last weather layer turns off.
 */
import type { Map as MlMap } from 'maplibre-gl';
import type { LayerContext, LayerManager } from '../layerTypes';

const HALO_COLOR = 'rgba(12, 9, 12, 0.9)';
const HALO_WIDTH = 2;

interface SavedHalo {
  color: unknown;
  width: unknown;
}

/** Layer id -> pre-override halo paint values (undefined = style default). */
let saved: Map<string, SavedHalo> | null = null;

function anyWeatherVisible(ctx: LayerContext): boolean {
  return Object.values(ctx.layers.weather).some((l) => l?.visible);
}

function basemapSymbolIds(map: MlMap): string[] {
  return (map.getStyle()?.layers ?? [])
    .filter((l) => l.type === 'symbol' && !l.id.startsWith('rd-'))
    .map((l) => l.id);
}

function apply(map: MlMap): void {
  if (saved) return; // already boosted
  saved = new Map();
  for (const id of basemapSymbolIds(map)) {
    saved.set(id, {
      color: map.getPaintProperty(id, 'text-halo-color'),
      width: map.getPaintProperty(id, 'text-halo-width'),
    });
    map.setPaintProperty(id, 'text-halo-color', HALO_COLOR);
    map.setPaintProperty(id, 'text-halo-width', HALO_WIDTH);
  }
}

function restore(map: MlMap): void {
  if (!saved) return;
  for (const [id, halo] of saved) {
    if (!map.getLayer(id)) continue; // style changed under us
    map.setPaintProperty(id, 'text-halo-color', halo.color);
    map.setPaintProperty(id, 'text-halo-width', halo.width);
  }
  saved = null;
}

export const labelContrastLayer: LayerManager = {
  mount() {
    saved = null;
  },

  update(map, ctx) {
    try {
      if (anyWeatherVisible(ctx)) apply(map);
      else restore(map);
    } catch {
      /* style mid-swap — the next update() re-applies */
    }
  },

  unmount(map) {
    try {
      restore(map);
    } catch {
      /* style already gone */
    }
  },
};
