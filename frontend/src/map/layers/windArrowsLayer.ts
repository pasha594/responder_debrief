/**
 * Wind direction arrows — a symbol layer over the wind rasters, fed by the
 * worker's per-hour U/V grid JSONs (m/s on a coarse CONUS lattice, row 0 =
 * NORTH edge). Shown whenever wind speed or gust is visible and the run's
 * manifest carries `wind_uv_template`; older manifests degrade to no arrows.
 *
 * Density is viewport-driven: the grid itself is coarse (one cell per tens of
 * km), so zoomed into a fire the raw cell centers leave one arrow per screen.
 * Instead of drawing raw centers, each rebuild lays a lattice over the visible
 * area targeting a roughly constant on-screen spacing and bilinearly samples
 * the U/V field at each lattice point — smooth interpolation between the real
 * samples, the same trick particle viewers use. Rebuilds happen on frame
 * change and (debounced) on moveend.
 *
 * Geometry note: the worker downsamples the EPSG:3857 warp, so grid rows are
 * equally spaced in MERCATOR Y, not latitude — placement and sampling here
 * work in (lon, mercator-y) space, then convert back for the feature point.
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

/** Desired on-screen arrow spacing (CSS px) the lattice aims for. */
const TARGET_SPACING_PX = 68;
/** Max power-of-two subdivisions of a grid cell (beyond this the field is
 * pure interpolation of one sample — denser arrows would just repeat it). */
const MAX_SUBDIV = 5;
/** Min subdivision (negative = merge cells): zoomed out, sample every 2^|k|th
 * cell so spacing stays near the target instead of relying on collision. */
const MIN_SUBDIV = -3;
/** Hard cap on lattice points per rebuild (symbol-bucket safety). */
const MAX_FEATURES = 1600;
/** Lattice cells drawn beyond each viewport edge (softens pan pop-in). */
const VIEW_MARGIN_CELLS = 2;

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

// ---------- mercator-row geometry ----------

/** Normalized (radius-free) mercator y of a latitude. */
function mercY(latDeg: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI) / 360));
}

function invMercY(y: number): number {
  return ((Math.atan(Math.exp(y)) * 2 - Math.PI / 2) * 180) / Math.PI;
}

interface GridGeom {
  w: number;
  /** Cell width, degrees lon. */
  dx: number;
  /** North edge in normalized mercator y. */
  yN: number;
  /** Cell height in normalized mercator y (positive, decreasing rows). */
  dyM: number;
}

function gridGeom(grid: WindUvGrid): GridGeom | null {
  const { nx, ny, bounds, u, v } = grid;
  if (!nx || !ny || u.length !== nx * ny || v.length !== nx * ny) return null;
  const [w, s, e, n] = bounds;
  const yN = mercY(n);
  return { w, dx: (e - w) / nx, yN, dyM: (yN - mercY(s)) / ny };
}

/**
 * Bilinear U/V sample at (lon, normalized-mercator-y), clamped to edge cells.
 * Null when any contributing cell is nodata. Pure; exported for tests.
 */
export function sampleWind(
  grid: WindUvGrid,
  lon: number,
  y: number,
  g?: GridGeom | null,
): { u: number; v: number } | null {
  const geom = g ?? gridGeom(grid);
  if (!geom) return null;
  const { nx, ny, u, v } = grid;
  const clamp = (val: number, hi: number) => Math.max(0, Math.min(hi, val));
  const f = clamp((lon - geom.w) / geom.dx - 0.5, nx - 1);
  const r = clamp((geom.yN - y) / geom.dyM - 0.5, ny - 1);
  const c0 = Math.floor(f);
  const c1 = Math.min(nx - 1, c0 + 1);
  const r0 = Math.floor(r);
  const r1 = Math.min(ny - 1, r0 + 1);
  const fx = f - c0;
  const fy = r - r0;
  const i00 = r0 * nx + c0;
  const i01 = r0 * nx + c1;
  const i10 = r1 * nx + c0;
  const i11 = r1 * nx + c1;
  const vals = [u[i00], u[i01], u[i10], u[i11], v[i00], v[i01], v[i10], v[i11]];
  if (vals.some((x) => x == null)) return null;
  const lerp2 = (a00: number, a01: number, a10: number, a11: number) =>
    a00 * (1 - fx) * (1 - fy) + a01 * fx * (1 - fy) + a10 * (1 - fx) * fy + a11 * fx * fy;
  return {
    u: lerp2(u[i00]!, u[i01]!, u[i10]!, u[i11]!),
    v: lerp2(v[i00]!, v[i01]!, v[i10]!, v[i11]!),
  };
}

function toArrow(
  lon: number,
  lat: number,
  uc: number,
  vc: number,
): WindArrowCollection['features'][number] | null {
  const speed = Math.hypot(uc, vc) * MS_TO_MPH;
  if (speed < MIN_SPEED_MPH) return null;
  // Bearing the air moves toward: u east+, v north+ → atan2(u, v).
  const dir = (Math.atan2(uc, vc) * (180 / Math.PI) + 360) % 360;
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { dir, speed },
  };
}

/**
 * U/V grid → arrow points at raw cell centers (mercator-correct latitudes).
 * Pure; exported for tests. Skips nodata cells and calm cells (< 1 mph).
 */
export function windGridToFeatures(grid: WindUvGrid): WindArrowCollection {
  const g = gridGeom(grid);
  if (!g) return EMPTY_FC;
  const { nx, ny, u, v } = grid;
  const features: WindArrowCollection['features'] = [];
  for (let row = 0; row < ny; row++) {
    const lat = invMercY(g.yN - (row + 0.5) * g.dyM); // row 0 = north edge
    for (let col = 0; col < nx; col++) {
      const i = row * nx + col;
      const uc = u[i];
      const vc = v[i];
      if (uc == null || vc == null) continue;
      const f = toArrow(g.w + (col + 0.5) * g.dx, lat, uc, vc);
      if (f) features.push(f);
    }
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Arrows for one viewport: a lattice over the visible slice of the grid,
 * subdivided so on-screen spacing lands near TARGET_SPACING_PX, each point
 * bilinearly sampled from the field. Anchored to the grid (not the screen)
 * so arrows hold still while panning. Pure; exported for tests.
 */
export function arrowFeaturesForView(
  grid: WindUvGrid,
  view: { bounds: [number, number, number, number]; zoom: number },
): WindArrowCollection {
  const g = gridGeom(grid);
  if (!g) return EMPTY_FC;
  const [vw, vs, ve, vn] = view.bounds;
  const worldPx = 512 * 2 ** view.zoom;
  // Screen size of one raw cell: lon fraction of the 360° world; mercator-y
  // fraction of the 2π world height.
  const cellPxX = (g.dx / 360) * worldPx;
  const cellPxY = (g.dyM / (2 * Math.PI)) * worldPx;
  const subdiv = (cellPx: number) =>
    Math.max(MIN_SUBDIV, Math.min(MAX_SUBDIV, Math.round(Math.log2(cellPx / TARGET_SPACING_PX))));
  let kx = subdiv(cellPxX);
  let ky = subdiv(cellPxY);

  const [w, s, e] = grid.bounds;
  const yLo = mercY(Math.max(vs, s));
  const yHi = Math.min(mercY(vn), g.yN);
  const lonLo = Math.max(vw, w);
  const lonHi = Math.min(ve, e);
  if (lonLo > lonHi || yLo > yHi) return EMPTY_FC;

  for (;;) {
    const sx = g.dx / 2 ** kx;
    const sy = g.dyM / 2 ** ky;
    const j0 = Math.max(0, Math.floor((lonLo - w) / sx) - VIEW_MARGIN_CELLS);
    const j1 = Math.min(Math.ceil(grid.nx * 2 ** kx) - 1, Math.ceil((lonHi - w) / sx) + VIEW_MARGIN_CELLS);
    const i0 = Math.max(0, Math.floor((g.yN - yHi) / sy) - VIEW_MARGIN_CELLS);
    const i1 = Math.min(Math.ceil(grid.ny * 2 ** ky) - 1, Math.ceil((g.yN - yLo) / sy) + VIEW_MARGIN_CELLS);
    if ((j1 - j0 + 1) * (i1 - i0 + 1) > MAX_FEATURES && (kx > MIN_SUBDIV || ky > MIN_SUBDIV)) {
      // Too many points (huge viewport at high subdivision) — coarsen.
      if (kx >= ky && kx > MIN_SUBDIV) kx--;
      else ky--;
      continue;
    }
    const features: WindArrowCollection['features'] = [];
    for (let i = i0; i <= i1; i++) {
      const y = g.yN - (i + 0.5) * sy;
      const lat = invMercY(y);
      for (let j = j0; j <= j1; j++) {
        const lon = w + (j + 0.5) * sx;
        const uv = sampleWind(grid, lon, y, g);
        if (!uv) continue;
        const f = toArrow(lon, lat, uv.u, uv.v);
        if (f) features.push(f);
      }
    }
    return { type: 'FeatureCollection', features };
  }
}

// ---------- module state ----------

/** Tiny in-module LRU of parsed hour grids, keyed by URL. */
const gridCache = new Map<string, WindUvGrid>();
const inflight = new Map<string, Promise<WindUvGrid | null>>();

/** URL whose arrows are currently loaded into the source (null = empty). */
let loadedUrl: string | null = null;
/** URL the latest update() wants — stale fetch resolutions check this. */
let wantedUrl: string | null = null;
/** The map the moveend rebuild is bound to (one map at a time, like peers). */
let boundMap: MlMap | null = null;
let moveHandler: (() => void) | null = null;
let moveTimer: ReturnType<typeof setTimeout> | undefined;

function cachePut(url: string, grid: WindUvGrid): void {
  gridCache.delete(url);
  gridCache.set(url, grid);
  while (gridCache.size > CACHE_MAX) {
    const oldest = gridCache.keys().next().value;
    if (oldest === undefined) break;
    gridCache.delete(oldest);
  }
}

function fetchGrid(url: string): Promise<WindUvGrid | null> {
  const hit = inflight.get(url);
  if (hit) return hit;
  const p = fetch(url)
    .then((res) => (res.ok ? (res.json() as Promise<WindUvGrid>) : null))
    .then((grid) => {
      if (!grid || !gridGeom(grid)) return null;
      cachePut(url, grid);
      return grid;
    })
    .catch(() => null)
    .finally(() => {
      inflight.delete(url);
    });
  inflight.set(url, p);
  return p;
}

/** Speed→size ramp at one zoom tier (3 mph → lo, 50 mph → hi). */
function speedSize(lo: number, hi: number): unknown[] {
  return ['interpolate', ['linear'], ['get', 'speed'], 3, lo, 50, hi];
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
          // Grows with zoom (the lattice keeps spacing roughly constant, so
          // bigger arrows stay readable without crowding) and with speed.
          'icon-size': [
            'interpolate',
            ['linear'],
            ['zoom'],
            4,
            speedSize(0.32, 0.8),
            8,
            speedSize(0.55, 1.05),
            11,
            speedSize(0.75, 1.35),
            13,
            speedSize(0.95, 1.65),
          ] as never,
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

/** Rebuild the source from the wanted grid for the current viewport. */
function rebuild(map: MlMap): void {
  const grid = wantedUrl ? gridCache.get(wantedUrl) : undefined;
  if (!grid || !map.getSource(SRC)) return;
  const b = map.getBounds();
  const fc = arrowFeaturesForView(grid, {
    bounds: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
    zoom: map.getZoom(),
  });
  setData(map, fc, wantedUrl);
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
    boundMap = map;
    moveHandler = () => {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(() => {
        if (boundMap && wantedUrl) rebuild(boundMap);
      }, 120);
    };
    map.on('moveend', moveHandler);
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

    if (url === loadedUrl) return; // frame + view unchanged since last set
    wantedUrl = url;

    if (gridCache.has(url)) {
      const grid = gridCache.get(url)!;
      cachePut(url, grid); // refresh LRU recency
      rebuild(map);
      return;
    }

    void fetchGrid(url).then((grid) => {
      // Only the most recently wanted hour may land; a failed fetch clears
      // the stale hour's arrows rather than showing wrong directions.
      if (wantedUrl !== url || !map.getSource(SRC)) return;
      if (grid) rebuild(map);
      else setData(map, EMPTY_FC, null);
    });
  },

  unmount(map) {
    if (moveHandler) map.off('moveend', moveHandler);
    clearTimeout(moveTimer);
    moveHandler = null;
    boundMap = null;
    if (map.getLayer(LYR)) map.removeLayer(LYR);
    if (map.getSource(SRC)) map.removeSource(SRC);
    loadedUrl = null;
    wantedUrl = null;
  },
};
