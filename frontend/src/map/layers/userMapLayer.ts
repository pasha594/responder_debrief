/**
 * "My maps" overlay: one georeferenced PDF the user added on this device
 * (src/userMaps/), chosen by ctx.layers.userMap.id. It sits in the incident
 * sheet's slot — the store keeps the two (and IR flights) mutually exclusive
 * — and shares the sheet's opacity slider.
 *
 * Tiles come from the 'rdusermap' protocol (userMaps/tileRenderer.ts): each
 * one is drawn on demand from the stored page JPEG through the map's real
 * projection, so the sheet lands where GDAL would put it, with no texture
 * size limit and transparency outside the frame. A protocol URL rather than
 * a blob: URL because a theme/style swap carries rd- sources over by their
 * serialized spec (MapRoot's transformStyle) and reloads them — a protocol
 * URL reloads from storage, a revoked object URL would silently go blank.
 *
 * The source is recreated when the shown map changes; the key includes the
 * import time so re-adding the same file (same id) never reuses old tiles.
 *
 * The PDF stays on the device, so while one is drawn the map canvas carries
 * `ph-no-capture`: session replay's canvas recording (off today, but a
 * PostHog dashboard toggle away) re-checks that class every frame and skips
 * the canvas instead of uploading snapshots of the user's document.
 */
import maplibregl, { type Map as MlMap } from 'maplibre-gl';
import {
  registerUserMapProtocol,
  releaseUserMapImages,
  tilePixelSize,
  userMapTileUrl,
} from '../../userMaps/tileRenderer';
import type { UserMapMeta } from '../../userMaps/types';
import { beforeIdFor } from '../zOrder';
import type { LayerManager } from '../layerTypes';

const SRC = 'rd-user-map';
const LYR = 'rd-user-map';
/** posthog-js's hard-coded replay block class (see MyMapsSection). */
const NO_CAPTURE = 'ph-no-capture';

let lastKey: string | null = null; // `${id}@${addedAt}`
let lastId: string | null = null;
let lastOpacity: number | null = null;
/** The newest My maps list, for the protocol handler's id → meta lookups. */
let latestMaps: UserMapMeta[] = [];

function removeAll(map: MlMap, unblockNow = false): void {
  const wasShown = lastKey !== null;
  // Nothing shown any more: let the renderer drop its decoded page images —
  // first, so a teardown on a map whose style is already gone (the calls
  // below throw there) still frees them.
  if (wasShown) releaseUserMapImages(null);
  lastKey = null;
  lastId = null;
  lastOpacity = null;
  if (unblockNow) {
    map.getCanvas().classList.remove(NO_CAPTURE);
  } else if (wasShown) {
    // Unblock replay only once the map has drawn a frame without the PDF —
    // a snapshot taken before that would still hold it. Shown again by
    // then (lastKey set): stay blocked.
    map.once('idle', () => {
      if (lastKey === null) map.getCanvas().classList.remove(NO_CAPTURE);
    });
  }
  if (map.getLayer(LYR)) map.removeLayer(LYR);
  if (map.getSource(SRC)) map.removeSource(SRC);
}

export const userMapLayer: LayerManager = {
  mount() {
    lastKey = null;
    lastId = null;
    lastOpacity = null;
    // Idempotent; the lookup reads the newest list update() has seen.
    registerUserMapProtocol(maplibregl.addProtocol, (id: string) =>
      latestMaps.find((m) => m.id === id),
    );
    // The source is created lazily when a map is shown.
  },

  update(map, ctx) {
    latestMaps = ctx.userMaps;
    const id = ctx.layers.userMap.id;
    const meta = id ? ctx.userMaps.find((m) => m.id === id) : undefined;

    if (!meta) {
      removeAll(map);
      return;
    }

    // Before any tile can be drawn; idempotent on every later tick.
    map.getCanvas().classList.add(NO_CAPTURE);

    const key = `${meta.id}@${meta.addedAt}`;
    const changed = key !== lastKey;
    if (changed || !map.getSource(SRC)) {
      if (map.getLayer(LYR)) map.removeLayer(LYR);
      if (map.getSource(SRC)) map.removeSource(SRC);
      map.addSource(SRC, {
        type: 'raster',
        tiles: [userMapTileUrl(meta.id)],
        // A 256-px grid, like the incident sheets' tiles; on dense screens
        // the protocol draws each tile at 512 px itself, so it stays sharp.
        tileSize: 256,
        bounds: meta.bounds,
        minzoom: 0,
        // meta.maxzoom is one level past native for 256-px paints. A 512-px
        // paint already resolves twice as fine, so that last level would be
        // 4-8x upsampled main-thread paints MapLibre can overzoom for free
        // from the level above; stop one level sooner there.
        maxzoom: Math.max(0, meta.maxzoom - (tilePixelSize() === 512 ? 1 : 0)),
      });
      // Keep the new map's decoded images and drop the others' — all of
      // them when this is the same id re-imported (its old ones are stale).
      if (changed) releaseUserMapImages(lastId === meta.id ? null : meta.id);
      lastKey = key;
      lastId = meta.id;
      lastOpacity = null;
    }
    if (!map.getLayer(LYR)) {
      map.addLayer(
        {
          id: LYR,
          type: 'raster',
          source: SRC,
          paint: { 'raster-opacity': ctx.layers.incidentMap.opacity },
        },
        beforeIdFor(map, 'rd-user-map'),
      );
      lastOpacity = ctx.layers.incidentMap.opacity;
    }

    if (ctx.layers.incidentMap.opacity !== lastOpacity) {
      lastOpacity = ctx.layers.incidentMap.opacity;
      map.setPaintProperty(LYR, 'raster-opacity', lastOpacity);
    }
  },

  unmount(map) {
    // The canvas goes with the map: unblock now, no frame to wait for.
    removeAll(map, true);
  },
};
