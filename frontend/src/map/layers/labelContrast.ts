/**
 * Google-style basemap labels: dark ink with a white outline so labels read
 * over weather rasters, incident-map sheets, and satellite. Part of the
 * curated "Classic dark" look only — the alternate style variants keep their
 * out-of-the-box labels (that's the point of offering them).
 */
import type { Map as MlMap } from 'maplibre-gl';
import { mapStyleDef } from '../../app/config';
import { useStore } from '../../state/store';
import type { LayerManager } from '../layerTypes';

const TEXT_COLOR = '#1f1b1e';
const HALO_COLOR = 'rgba(255, 255, 255, 0.92)';
const HALO_WIDTH = 1.8;

/** Ids already restyled (style reloads clear layers, so re-apply is safe). */
let styled: Set<string> = new Set();

function apply(map: MlMap): void {
  const ui = useStore.getState().ui;
  if (ui.theme !== 'dark' || mapStyleDef(ui.theme, ui.mapStyle[ui.theme]).id !== 'dark') return;
  const layers = map.getStyle()?.layers ?? [];
  for (const l of layers) {
    if (l.type !== 'symbol' || l.id.startsWith('rd-') || styled.has(l.id)) continue;
    map.setPaintProperty(l.id, 'text-color', TEXT_COLOR);
    map.setPaintProperty(l.id, 'text-halo-color', HALO_COLOR);
    map.setPaintProperty(l.id, 'text-halo-width', HALO_WIDTH);
    styled.add(l.id);
  }
}

/** After a style swap: forget the old style's layer ids and re-treat (no-op
 * unless the classic dark style is active). */
export function resyncLabelContrast(map: MlMap): void {
  styled = new Set();
  try {
    apply(map);
  } catch {
    /* style mid-swap */
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
