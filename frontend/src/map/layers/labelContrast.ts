/**
 * Google-style basemap labels: dark ink with a white outline, applied to
 * every basemap symbol layer. That single treatment reads on ANY ground —
 * the dark basemap, bright weather rasters, incident-map sheets, satellite —
 * so no per-layer or per-overlay switching is needed.
 */
import type { Map as MlMap } from 'maplibre-gl';
import type { LayerManager } from '../layerTypes';

const TEXT_COLOR = '#1f1b1e';
const HALO_COLOR = 'rgba(255, 255, 255, 0.92)';
const HALO_WIDTH = 1.8;

/** Ids already restyled (style reloads clear layers, so re-apply is safe). */
let styled: Set<string> = new Set();

function apply(map: MlMap): void {
  const layers = map.getStyle()?.layers ?? [];
  for (const l of layers) {
    if (l.type !== 'symbol' || l.id.startsWith('rd-') || styled.has(l.id)) continue;
    map.setPaintProperty(l.id, 'text-color', TEXT_COLOR);
    map.setPaintProperty(l.id, 'text-halo-color', HALO_COLOR);
    map.setPaintProperty(l.id, 'text-halo-width', HALO_WIDTH);
    styled.add(l.id);
  }
}

export const labelContrastLayer: LayerManager = {
  mount() {
    styled = new Set();
  },

  update(map) {
    try {
      apply(map);
    } catch {
      /* style mid-swap — the next update() re-applies */
    }
  },

  unmount() {
    styled = new Set();
  },
};
