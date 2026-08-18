/**
 * Wind direction arrows — a symbol layer over the wind rasters, fed by the
 * worker's per-hour U/V grid JSONs (m/s on a coarse CONUS lattice, row 0 =
 * NORTH edge). Shown whenever wind speed or gust is visible and the run's
 * manifest carries `wind_uv_template`; older manifests degrade to no arrows.
 * Each hour is one small fetch (LRU-cached) converted to grid-center points
 * with { dir, speed }; MapLibre's symbol collision thins density at low zoom.
 */
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import { windUvUrl } from '../../api/wmsUrls';
import { resolveWeatherFrame } from '../../timeline/framePlan';
import { beforeIdFor } from '../zOrder';
import type { LayerManager } from '../layerTypes';
import { installMarkerImages, WIND_ARROW_IMAGE } from './markerImages';

const SRC = 'rd-wind-arrows';
const LYR = 'rd-wind-arrows';

const MS_TO_MPH = 2.23694;
/** Calm cells below this (mph) draw no arrow — direction is noise. */
const MIN_SPEED_MPH = 1;
const CACHE_MAX = 6;

/** Worker contract: docs/spec-frames.md wind_uv block. */
export interface WindUvGrid {
  nx: number;
  ny: number;
  /** [w, s, e, n] EPSG:4326. */
  bounds: [number, number, number, number];
  /** Row-major, row 0 = NORTH edge, index = row*nx+col; null = nodata. */
  u: (number | null)[];
  v: (number | null)[];
}

export interface WindArrowProps {
  /** Bearing the air moves TOWARD, degrees clockwise from north. */
  dir: number;
  /** mph */
  speed: number;
}

export type WindArrowCollection = GeoJSON.FeatureCollection<GeoJSON.Point, WindArrowProps>;

const EMPTY_FC: WindArrowCollection = { type: 'FeatureCollection', features: [] };

/**
 * U/V grid → arrow points at cell centers. Pure; exported for tests.
 * Skips nodata cells and calm cells (< 1 mph).
 */
export function windGridToFeatures(grid: WindUvGrid): WindArrowCollection {
  const { nx, ny, bounds, u, v } = grid;
  const [w, s, e, n] = bounds;
  if (!nx || !ny || u.length !== nx * ny || v.length !== nx * ny) return EMPTY_FC;
  const dx = (e - w) / nx;
  const dy = (n - s) / ny;
  const features: WindArrowCollection['features'] = [];
  for (let row = 0; row < ny; row++) {
    const lat = n - (row + 0.5) * dy; // row 0 = north edge
    for (let col = 0; col < nx; col++) {
      const i = row * nx + col;
      const uc = u[i];
      const vc = v[i];
      if (uc == null || vc == null) continue;
      const speed = Math.hypot(uc, vc) * MS_TO_MPH;
      if (speed < MIN_SPEED_MPH) continue;
      // Bearing the air moves toward: u east+, v north+ → atan2(u, v).
      const dir = (Math.atan2(uc, vc) * (180 / Math.PI) + 360) % 360;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [w + (col + 0.5) * dx, lat] },
        properties: { dir, speed },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

// ---------- module state ----------

/** Tiny in-module LRU of parsed hour grids, keyed by URL. */
const gridCache = new Map<string, WindArrowCollection>();
const inflight = new Map<string, Promise<WindArrowCollection | null>>();

/** URL whose collection is currently loaded into the source (null = empty). */
let loadedUrl: string | null = null;
/** URL the latest update() wants — stale fetch resolutions check this. */
let wantedUrl: string | null = null;

function cachePut(url: string, fc: WindArrowCollection): void {
  gridCache.delete(url);
  gridCache.set(url, fc);
  while (gridCache.size > CACHE_MAX) {
    const oldest = gridCache.keys().next().value;
    if (oldest === undefined) break;
    gridCache.delete(oldest);
  }
}

function fetchGrid(url: string): Promise<WindArrowCollection | null> {
  const hit = inflight.get(url);
  if (hit) return hit;
  const p = fetch(url)
    .then((res) => (res.ok ? (res.json() as Promise<WindUvGrid>) : null))
    .then((grid) => {
      if (!grid) return null;
      const fc = windGridToFeatures(grid);
      cachePut(url, fc);
      return fc;
    })
    .catch(() => null)
    .finally(() => {
      inflight.delete(url);
    });
  inflight.set(url, p);
  return p;
}

function ensureLayer(map: MlMap): void {
  if (!map.getSource(SRC)) {
    map.addSource(SRC, { type: 'geojson', data: EMPTY_FC });
    loadedUrl = null;
  }
  if (!map.getLayer(LYR)) {
    map.addLayer(
      {
        id: LYR,
        type: 'symbol',
        source: SRC,
        layout: {
          'icon-image': WIND_ARROW_IMAGE,
          'icon-rotate': ['get', 'dir'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': false, // collision thins density at low zoom
          'icon-size': [
            'interpolate',
            ['linear'],
            ['get', 'speed'],
            3,
            0.35,
            50,
            0.85,
          ],
        },
        paint: {
          'icon-color': 'rgba(255, 255, 255, 0.92)',
          'icon-halo-color': 'rgba(20, 16, 20, 0.55)',
          'icon-halo-width': 1,
        },
      },
      beforeIdFor(map, LYR),
    );
  }
}

function setData(map: MlMap, fc: WindArrowCollection, url: string | null): void {
  const src = map.getSource(SRC) as GeoJSONSource | undefined;
  if (!src) return;
  src.setData(fc);
  loadedUrl = url;
}

function hide(map: MlMap): void {
  if (map.getLayer(LYR)) map.setLayoutProperty(LYR, 'visibility', 'none');
}

function show(map: MlMap): void {
  if (map.getLayer(LYR)) map.setLayoutProperty(LYR, 'visibility', 'visible');
}

export const windArrowsLayer: LayerManager = {
  mount(map) {
    installMarkerImages(map);
    loadedUrl = null;
    wantedUrl = null;
  },

  update(map, ctx) {
    const windOn = !!(ctx.layers.weather.ws?.visible || ctx.layers.weather.wg?.visible);
    const frame = windOn ? resolveWeatherFrame(ctx.weatherRun, ctx.currentTime) : null;
    const url =
      frame && ctx.weatherRun ? windUvUrl(ctx.weatherRun, frame.hourIso) : null;

    if (!url) {
      wantedUrl = null;
      hide(map);
      return;
    }

    ensureLayer(map);
    show(map);

    if (url === loadedUrl) return; // frame unchanged — nothing to rebuild
    wantedUrl = url;

    const cached = gridCache.get(url);
    if (cached) {
      cachePut(url, cached); // refresh LRU recency
      setData(map, cached, url);
      return;
    }

    void fetchGrid(url).then((fc) => {
      // Only the most recently wanted hour may land; a failed fetch clears
      // the stale hour's arrows rather than showing wrong directions.
      if (wantedUrl !== url || !map.getSource(SRC)) return;
      setData(map, fc ?? EMPTY_FC, fc ? url : null);
    });
  },

  unmount(map) {
    if (map.getLayer(LYR)) map.removeLayer(LYR);
    if (map.getSource(SRC)) map.removeSource(SRC);
    loadedUrl = null;
    wantedUrl = null;
  },
};
