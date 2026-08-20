/**
 * Shareable view state, encoded in the query string of a fire URL. Copying
 * the address bar reproduces the view: layer toggles, weather multi-select,
 * fire-forecast product, basemap, the map-sheet overlay, and the timeline
 * position. Only non-default state is encoded, so an untouched view keeps a
 * clean URL.
 *
 * Params:
 *   t   playhead, compact UTC minutes: 20260820T1930Z (only when scrubbed
 *       off "now")
 *   hs  0 → hotspots hidden          pm  0 → perimeters hidden
 *   wx  visible weather products, dot-separated: tmpf.rh
 *   ff  fire forecast: {product}.{percentile}, e.g. time-of-arrival.50
 *   bm  basemap: satellite | topo
 *   map single map-sheet overlay (sheet id)
 *   mv  map-sheet version series on the timeline (series key)
 *   ir  IR flight shown on the map
 */
import type { AppState } from '../state/store';
import type { Percentile, SpreadProduct, WeatherProduct } from '../api/types';
import { RENDERED_WEATHER_PRODUCTS } from '../api/types';

const SPREAD_PRODUCTS: SpreadProduct[] = [
  'spread-rate', 'flame-length', 'crown-fire',
  'hours-since-burned', 'time-of-arrival', 'isochrones',
];
const PERCENTILES: Percentile[] = [10, 30, 50, 70, 90];

/** Playhead deltas under this read as "just now" and stay out of the URL. */
const T_EPSILON_MS = 2 * 60_000;

export interface UrlViewState {
  t?: number;
  hotspots?: false;
  perimeters?: false;
  weather?: WeatherProduct[];
  spread?: { product: SpreadProduct; percentile: Percentile };
  basemap?: 'satellite' | 'topo';
  mapId?: string;
  series?: string;
  irFlight?: string;
}

export function encodeTime(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z`
  );
}

export function parseTime(s: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/.exec(s);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return Number.isFinite(t) ? t : null;
}

/** Store → "?…" (or '' when everything is default). */
export function buildSearch(s: AppState): string {
  const q = new URLSearchParams();
  if (Math.abs(s.time.currentTime - s.time.now) > T_EPSILON_MS) {
    q.set('t', encodeTime(s.time.currentTime));
  }
  if (!s.layers.hotspots.visible) q.set('hs', '0');
  if (!s.layers.perimeters.visible) q.set('pm', '0');
  const wx = (Object.keys(s.layers.weather) as WeatherProduct[])
    .filter((p) => s.layers.weather[p]?.visible)
    .sort();
  if (wx.length) q.set('wx', wx.join('.'));
  if (s.layers.spread.visible) {
    q.set('ff', `${s.layers.spread.product}.${s.layers.spread.percentile}`);
  }
  if (s.ui.basemap !== 'map') q.set('bm', s.ui.basemap);
  if (s.layers.incidentMap.series) q.set('mv', s.layers.incidentMap.series);
  else if (s.layers.incidentMap.mapId) q.set('map', s.layers.incidentMap.mapId);
  if (s.layers.irFlight.flightId) q.set('ir', s.layers.irFlight.flightId);
  const str = q.toString();
  return str ? `?${str}` : '';
}

/** "?…" → validated partial view state (unknown values are dropped). */
export function decodeSearch(search: string): UrlViewState {
  const q = new URLSearchParams(search);
  const out: UrlViewState = {};

  const t = q.get('t');
  if (t) {
    const ms = parseTime(t);
    if (ms != null) out.t = ms;
  }
  if (q.get('hs') === '0') out.hotspots = false;
  if (q.get('pm') === '0') out.perimeters = false;

  const wx = q.get('wx');
  if (wx) {
    const valid = wx
      .split('.')
      .filter((p): p is WeatherProduct =>
        (RENDERED_WEATHER_PRODUCTS as readonly string[]).includes(p));
    if (valid.length) out.weather = valid;
  }

  const ff = q.get('ff');
  if (ff) {
    const dot = ff.lastIndexOf('.');
    const product = ff.slice(0, dot) as SpreadProduct;
    const pct = Number(ff.slice(dot + 1)) as Percentile;
    if (SPREAD_PRODUCTS.includes(product) && PERCENTILES.includes(pct)) {
      out.spread = { product, percentile: pct };
    }
  }

  const bm = q.get('bm');
  if (bm === 'satellite' || bm === 'topo') out.basemap = bm;

  const mv = q.get('mv');
  const map = q.get('map');
  if (mv) out.series = mv;
  else if (map) out.mapId = map;

  const ir = q.get('ir');
  if (ir) out.irFlight = ir;

  return out;
}

/** Dispatch a decoded view state into the store. Returns the requested
 * playhead (which may still be outside the current timeline domain — the
 * caller re-applies it once the real domain arrives). */
export function applyViewState(
  v: UrlViewState,
  s: AppState,
  actions: AppState['actions'],
): number | null {
  // hotspots/perimeters only have toggle actions — flip only when needed
  if (v.hotspots === false && s.layers.hotspots.visible) actions.toggleHotspots();
  if (v.perimeters === false && s.layers.perimeters.visible) actions.togglePerimeters();
  for (const p of v.weather ?? []) actions.setWeatherLayer(p, { visible: true });
  if (v.spread) {
    actions.setSpreadProduct(v.spread.product); // also sets visible: true
    actions.setSpreadPercentile(v.spread.percentile);
  }
  if (v.basemap) actions.setBasemap(v.basemap);
  if (v.series) actions.setIncidentMapSeries(v.series);
  else if (v.mapId) actions.setIncidentMap(v.mapId);
  if (v.irFlight) actions.setIrFlight(v.irFlight);
  if (v.t != null) {
    actions.setTime(v.t);
    return v.t;
  }
  return null;
}
