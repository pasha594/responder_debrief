/**
 * Satellite / topo grounds under the vector basemap — keyless USGS National
 * Map tiles (public domain, US coverage: right for this app).
 *
 * Satellite is a HYBRID: the imagery slides in above the vector style's
 * background/fill layers (which get hidden) but below its roads and labels,
 * Google-hybrid style. Topo is self-sufficient (it has its own roads and
 * labels), so the whole vector basemap hides. Every rd- layer stays exactly
 * where it was — no setStyle, nothing rebuilt. Self-driven off ui.basemap.
 */
import type { Map as MlMap } from 'maplibre-gl';
import { useStore } from '../../state/store';
import type { LayerManager } from '../layerTypes';

const LYR = 'rd-underlay';
const SOURCES = {
  satellite: {
    id: 'rd-underlay-satellite',
    tiles: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery: USGS',
    maxzoom: 16,
  },
  topo: {
    id: 'rd-underlay-topo',
    tiles: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Topo: USGS',
    maxzoom: 16,
  },
} as const;

let unsubscribe: (() => void) | null = null;
let appliedFor: 'map' | 'satellite' | 'topo' | null = null;
/** Basemap layer ids we hid, to restore on switch-back. */
let hidden: string[] = [];

function isBasemapLayer(id: string): boolean {
  return !id.startsWith('rd-');
}

/** First basemap line/symbol layer — the hybrid imagery slots below it. */
function firstLinework(map: MlMap): string | undefined {
  return (map.getStyle()?.layers ?? []).find(
    (l) => isBasemapLayer(l.id) && (l.type === 'line' || l.type === 'symbol'),
  )?.id;
}

function hideBasemap(map: MlMap, kinds: 'ground' | 'all'): void {
  for (const l of map.getStyle()?.layers ?? []) {
    if (!isBasemapLayer(l.id)) continue;
    if (kinds === 'ground' && l.type !== 'background' && l.type !== 'fill') continue;
    if (map.getLayoutProperty(l.id, 'visibility') === 'none') continue;
    map.setLayoutProperty(l.id, 'visibility', 'none');
    hidden.push(l.id);
  }
}

function restoreBasemap(map: MlMap): void {
  for (const id of hidden) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible');
  }
  hidden = [];
}

function apply(map: MlMap): void {
  const want = useStore.getState().ui.basemap;
  if (want === appliedFor) return;

  if (map.getLayer(LYR)) map.removeLayer(LYR);
  restoreBasemap(map);

  if (want !== 'map') {
    const src = SOURCES[want];
    if (!map.getSource(src.id)) {
      map.addSource(src.id, {
        type: 'raster',
        tiles: [src.tiles],
        tileSize: 256,
        maxzoom: src.maxzoom,
        attribution: src.attribution,
      });
    }
    map.addLayer(
      { id: LYR, type: 'raster', source: src.id },
      // hybrid: below the vector linework; for topo the anchor barely
      // matters since the whole basemap hides next
      firstLinework(map),
    );
    hideBasemap(map, want === 'satellite' ? 'ground' : 'all');
  }
  appliedFor = want;
}

export const basemapUnderlay: LayerManager = {
  mount(map) {
    appliedFor = null;
    hidden = [];
    unsubscribe = useStore.subscribe((state, prev) => {
      if (state.ui.basemap !== prev.ui.basemap) {
        try {
          apply(map);
        } catch {
          /* style mid-swap */
        }
      }
    });
  },

  update(map) {
    try {
      apply(map);
    } catch {
      /* style not ready — next update retries */
    }
  },

  unmount(map) {
    unsubscribe?.();
    unsubscribe = null;
    try {
      if (map.getLayer(LYR)) map.removeLayer(LYR);
      restoreBasemap(map);
    } catch {
      /* style gone */
    }
    appliedFor = null;
  },
};
