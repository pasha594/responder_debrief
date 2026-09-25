/**
 * Vegetation classes of the fire's routing grid (LANDFIRE via the bundle),
 * painted into a canvas source corner-pinned from UTM — the same pixels
 * the offline Walk router costs, so what the map shows is what the route
 * model believes. Works offline (the bundle is in the pack).
 *
 * The routing Web Worker already holds the decoded grid, so it renders
 * the RGBA (nearest-downsampled to ≤ 2048 px) and transfers it here. Static
 * content → animate:false (no per-frame texture upload) and nearest
 * resampling so class edges stay crisp. Self-driven: it depends on the
 * bundle, which the layer context doesn't carry.
 */
import type { Map as MlMap } from 'maplibre-gl';
import { ensureBundle, vegImage } from '../../routing/offroadClient';
import { loadFireBundle } from '../../routing/hooks';
import type { RoutingBundle } from '../../routing/types';
import { utmBoundsTo4326 } from '../../spread/utm';
import { useStore } from '../../state/store';
import type { LayerManager } from '../layerTypes';
import { beforeIdFor } from '../zOrder';

const SRC = 'rd-vegetation';
const LYR = 'rd-vegetation';
const MAX_WIDTH = 2048;

let unsubscribe: (() => void) | null = null;
let shownFor: string | null = null; // bundle id painted into the source
let seq = 0;
let lastOpacity: number | null = null;
let lastVisible: boolean | null = null;

function dead(map: MlMap): boolean {
  const m = map as unknown as { _removed?: boolean; style?: unknown };
  return !!m._removed || !m.style;
}

function remove(map: MlMap): void {
  if (map.getLayer(LYR)) map.removeLayer(LYR);
  if (map.getSource(SRC)) map.removeSource(SRC);
  shownFor = null;
  lastOpacity = null;
  lastVisible = null;
}

async function paint(map: MlMap, b: RoutingBundle, mySeq: number): Promise<void> {
  await ensureBundle(b);
  const img = await vegImage(MAX_WIDTH);
  if (mySeq !== seq || dead(map)) return;
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext('2d')!.putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
  const g = b.grid;
  const { corners } = utmBoundsTo4326(
    [g.x0, g.y0 - g.height * g.cell_m, g.x0 + g.width * g.cell_m, g.y0], b.crs.zone, b.crs.northern);
  remove(map);
  map.addSource(SRC, { type: 'canvas', canvas, coordinates: corners, animate: false });
  const v = useStore.getState().layers.vegetation;
  map.addLayer({
    id: LYR, type: 'raster', source: SRC,
    paint: { 'raster-opacity': v.opacity, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 },
  }, beforeIdFor(map, 'rd-vegetation'));
  shownFor = b.bundle_id;
  lastOpacity = v.opacity;
  lastVisible = true;
}

function reconcile(map: MlMap): void {
  if (dead(map)) return;
  const s = useStore.getState();
  const corneaId = s.view.mode === 'fire' ? s.view.corneaId : null;
  const v = s.layers.vegetation;
  if (!corneaId || !v.visible) {
    seq++;
    if (map.getLayer(LYR) && lastVisible !== false) {
      map.setLayoutProperty(LYR, 'visibility', 'none');
      lastVisible = false;
    }
    return;
  }
  const mySeq = ++seq;
  void loadFireBundle(corneaId).then((b) => {
    if (mySeq !== seq || dead(map)) return;
    if (!b) {
      remove(map);
      return;
    }
    if (shownFor === b.bundle_id && map.getLayer(LYR)) {
      if (lastVisible !== true) {
        map.setLayoutProperty(LYR, 'visibility', 'visible');
        lastVisible = true;
      }
      if (lastOpacity !== v.opacity) {
        map.setPaintProperty(LYR, 'raster-opacity', v.opacity);
        lastOpacity = v.opacity;
      }
      return;
    }
    return paint(map, b, mySeq);
  }).catch(() => undefined);
}

export const vegetationLayer: LayerManager = {
  mount(map) {
    shownFor = null;
    lastOpacity = null;
    lastVisible = null;
    unsubscribe?.();
    unsubscribe = useStore.subscribe((s, prev) => {
      if (s.layers.vegetation !== prev.layers.vegetation || s.view !== prev.view) reconcile(map);
    });
    reconcile(map);
  },
  update() {
    /* self-driven (store subscription) */
  },
  unmount(map) {
    unsubscribe?.();
    unsubscribe = null;
    seq++;
    try {
      remove(map);
    } catch {
      /* dead style */
    }
  },
};
