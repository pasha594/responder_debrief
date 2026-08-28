/** Central configuration. Everything URL-shaped flows through here. */

/** Fire data API (cornea). Browser-callable directly: CORS `*`, no auth. */
export const FIRE_API = 'https://fire-api-prod.web.app';

/** Where worker-produced catalogs/frames/tiles/PDFs live (B2 in prod, /data in dev). */
export const DATA_BASE_URL: string =
  import.meta.env.VITE_DATA_BASE_URL || `${import.meta.env.BASE_URL}data`;

/**
 * Basemap style catalog — all free and keyless, straight from the provider
 * (OpenFreeMap serves the OpenMapTiles styles; CARTO's GL styles are public).
 * Three variants per theme; the first entry is each theme's default.
 * `swatch` is just the picker chip color, roughly the style's ground tone.
 */
export interface MapStyleDef {
  id: string;
  label: string;
  url: string;
  swatch: string;
}

export const MAP_STYLES: Record<'dark' | 'light', MapStyleDef[]> = {
  dark: [
    { id: 'dark-matter', label: 'Dark Matter', url: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json', swatch: '#0e0e0e' },
    { id: 'fiord', label: 'Fiord', url: 'https://tiles.openfreemap.org/styles/fiord', swatch: '#232f41' },
    { id: 'dark', label: 'Classic dark', url: 'https://tiles.openfreemap.org/styles/dark', swatch: '#161313' },
  ],
  light: [
    { id: 'positron', label: 'Positron', url: 'https://tiles.openfreemap.org/styles/positron', swatch: '#f4f4f2' },
    { id: 'liberty', label: 'Liberty', url: 'https://tiles.openfreemap.org/styles/liberty', swatch: '#efe9e1' },
    { id: 'voyager', label: 'Voyager', url: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json', swatch: '#fbf6ef' },
  ],
};

export function mapStyleDef(theme: 'dark' | 'light', id: string): MapStyleDef {
  const list = MAP_STYLES[theme];
  return list.find((s) => s.id === id) ?? list[0];
}

/** Playback speed default: model-hours advanced per wall-clock second. */
export const DEFAULT_PLAYBACK_SPEED = 10;

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
