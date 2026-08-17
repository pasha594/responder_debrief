/** Central configuration. Everything URL-shaped flows through here. */

/** Fire data API (cornea). Browser-callable directly: CORS `*`, no auth. */
export const FIRE_API = 'https://fire-api-prod.web.app';

/**
 * WMS proxy origin. Empty string in dev — vite's dev server proxies /wms01 and
 * /wms02 with the Origin header stripped. In production this is the deployed
 * Cloudflare Worker origin (https://….workers.dev).
 * NEVER reference the pyrecast geoserver hostname directly in src/.
 */
export const PROXY_BASE: string = import.meta.env.VITE_PROXY_BASE ?? '';

/** Where worker-produced catalogs/tiles/PDFs live (B2 in prod, /data in dev). */
export const DATA_BASE_URL: string =
  import.meta.env.VITE_DATA_BASE_URL || `${import.meta.env.BASE_URL}data`;

/** Free, keyless dark basemap (OpenMapTiles schema). */
export const BASEMAP_STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark';
export const BASEMAP_STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/positron';

/** Spread-forecast frame images: longest edge in px (proxy caps at 2048). */
export const SPREAD_FRAME_MAX_DIM = 1536;

/** Max concurrent uncached GetMap requests (GeoServer flow control is real). */
export const PREFETCH_CONCURRENCY_GS02 = 1;
export const PREFETCH_CONCURRENCY_TOTAL = 4;

/** LRU cap for decoded frame images. */
export const FRAME_CACHE_MAX_ENTRIES = 500;

/** Playback speed default: model-hours advanced per wall-clock second. */
export const DEFAULT_PLAYBACK_SPEED = 2;

/** Hotspot fetch settings. */
export const HOTSPOT_LIMIT = 50000;
export const HOTSPOT_NATIONAL_MIN_ZOOM = 6;
export const HOTSPOT_HISTORY_MAX_DAYS = 45;
export const HOTSPOT_BBOX_SNAP_DEG = 0.25;

/** Weather frame snapping tolerance (ms). */
export const WEATHER_SNAP_TOLERANCE_MS = 90 * 60 * 1000;

/** National timeline: past extent (ms). Future extent comes from weather runs. */
export const NATIONAL_PAST_MS = 7 * 24 * 3600 * 1000;

/** Fraction of the timeline track allotted to the past (rest is future). */
export const TIMELINE_PAST_FRACTION = 0.55;
