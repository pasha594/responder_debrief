/**
 * WMS URL builders. ALL pyrecast traffic flows through the proxy
 * ({PROXY_BASE}/wms01, {PROXY_BASE}/wms02) — never the geoserver host.
 */
import { PROXY_BASE, SPREAD_FRAME_MAX_DIM } from '../app/config';
import { bounds4326To3857, frameDims } from './geo';
import type { Percentile, PyrecastRun, SpreadProduct, WeatherRun } from './types';

export const WMS01 = `${PROXY_BASE}/wms01`;
export const WMS02 = `${PROXY_BASE}/wms02`;

/**
 * Catalogs carry proxy-relative URLs like "/wms02?request=GetLegendGraphic…";
 * resolve them against the configured proxy origin.
 */
export function proxyRelative(rel: string): string {
  return `${PROXY_BASE}${rel}`;
}

function wmsQuery(params: Record<string, string>): string {
  // Stable key order → stable URLs → better browser/edge cache reuse.
  const sorted = Object.keys(params).sort();
  return sorted.map((k) => `${k}=${encodeURIComponent(params[k])}`).join('&');
}

export function spreadLayerName(run: PyrecastRun, product: SpreadProduct, pct: Percentile): string {
  const tpl = run.products[product]?.layer_template;
  if (tpl) return tpl.replace('{ws}', run.workspace).replace('{pct}', String(pct));
  return `${run.workspace}:elmfire_landfire_${pct}_${product}`;
}

/**
 * Single-image GetMap for a spread-forecast frame. Deterministic: fixed
 * per-run bbox + dims; `time` is a VERBATIM instant from run.time_instants
 * (omit for static products). One URL per (run, product, pct, instant).
 */
export function spreadFrameUrl(
  run: PyrecastRun,
  product: SpreadProduct,
  pct: Percentile,
  timeInstant: string | null,
): string {
  const merc = bounds4326To3857(run.bbox);
  const { width, height } = frameDims(merc, SPREAD_FRAME_MAX_DIM);
  const params: Record<string, string> = {
    service: 'WMS',
    version: '1.3.0',
    request: 'GetMap',
    layers: spreadLayerName(run, product, pct),
    styles: '',
    crs: 'EPSG:3857',
    bbox: merc.join(','),
    width: String(width),
    height: String(height),
    format: 'image/png',
    transparent: 'true',
  };
  if (timeInstant) params.time = timeInstant;
  return `${WMS02}?${wmsQuery(params)}`;
}

/** Weather (gs01) layer name for a specific hour, from the run's template. */
export function weatherLayerName(run: WeatherRun, product: string, hourIso: string): string {
  // hourIso e.g. "2026-08-18T03:00:00Z" → YYYYMMDD "20260818", HHMMSS "030000"
  const d = new Date(hourIso);
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  const ymd = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const hms = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return run.layer_template
    .replace('{ws}', run.workspace)
    .replace('{product}', product)
    .replace('{YYYYMMDD}', ymd)
    .replace('{HHMMSS}', hms);
}

/**
 * Tiled GetMap template for MapLibre raster sources ({bbox-epsg-3857} token is
 * substituted by MapLibre itself). Used for weather layers and the national
 * perimeters raster.
 */
export function wmsTileTemplate(base: string, qualifiedLayer: string, tileSize = 512): string {
  const params: Record<string, string> = {
    service: 'WMS',
    version: '1.3.0',
    request: 'GetMap',
    layers: qualifiedLayer,
    styles: '',
    crs: 'EPSG:3857',
    width: String(tileSize),
    height: String(tileSize),
    format: 'image/png',
    transparent: 'true',
  };
  // bbox must keep the literal placeholder — append unencoded.
  return `${base}?${wmsQuery(params)}&bbox={bbox-epsg-3857}`;
}

export function legendUrl(base: string, qualifiedLayer: string): string {
  const params: Record<string, string> = {
    service: 'WMS',
    version: '1.3.0',
    request: 'GetLegendGraphic',
    format: 'image/png',
    width: '20',
    height: '20',
    layer: qualifiedLayer,
  };
  return `${base}?${wmsQuery(params)}`;
}

/**
 * National current-year perimeters raster: gs01 layer names are rotating
 * timestamped snapshots, so the qualified layer comes from
 * catalog.national_layers.current_year_perimeters at runtime.
 */
export function nationalPerimetersTileTemplate(qualifiedLayer: string): string {
  return wmsTileTemplate(WMS01, qualifiedLayer);
}

/** GetFeatureInfo point probe (JSON) — stretch feature. */
export function featureInfoUrl(
  base: string,
  qualifiedLayer: string,
  bboxMerc: [number, number, number, number],
  width: number,
  height: number,
  i: number,
  j: number,
  timeInstant?: string,
): string {
  const params: Record<string, string> = {
    service: 'WMS',
    version: '1.3.0',
    request: 'GetFeatureInfo',
    layers: qualifiedLayer,
    query_layers: qualifiedLayer,
    styles: '',
    crs: 'EPSG:3857',
    bbox: bboxMerc.join(','),
    width: String(width),
    height: String(height),
    i: String(Math.round(i)),
    j: String(Math.round(j)),
    info_format: 'application/json',
  };
  if (timeInstant) params.time = timeInstant;
  return `${base}?${wmsQuery(params)}`;
}
