/**
 * Canonical z-order for all rd- layers. Rasters slot below the basemap's
 * first symbol (label) layer so roads/places stay legible; vectors and pins
 * ride on top.
 */
import type { Map as MlMap } from 'maplibre-gl';

/** Bottom → top. Layer ids owned by our layer managers (prefix rd-). */
export const RD_LAYER_ORDER = [
  // rasters (below basemap labels)
  'rd-weather-tmpf-a', 'rd-weather-tmpf-b',
  'rd-weather-rh-a', 'rd-weather-rh-b',
  'rd-weather-ws-a', 'rd-weather-ws-b',
  'rd-weather-wg-a', 'rd-weather-wg-b',
  'rd-weather-wd-a', 'rd-weather-wd-b',
  'rd-weather-ffwi-a', 'rd-weather-ffwi-b',
  'rd-weather-smoke-a', 'rd-weather-smoke-b',
  'rd-weather-tcdc-a', 'rd-weather-tcdc-b',
  'rd-weather-pign-a', 'rd-weather-pign-b',
  'rd-weather-meq-a', 'rd-weather-meq-b',
  'rd-weather-apcp01-a', 'rd-weather-apcp01-b',
  'rd-weather-apcptot-a', 'rd-weather-apcptot-b',
  'rd-incident-map',
  'rd-spread-forecast',
  'rd-national-perimeters',
  // ── basemap symbol layers sit here ──
  // vectors above labels
  'rd-wind-arrows', // over the weather rasters + labels, under perimeters/pins
  'rd-ir-heat-fill',
  'rd-ir-heat-line',
  'rd-perimeter-fill',
  'rd-perimeter-line',
  'rd-hotspots',
  'rd-fire-pins',
] as const;

export type RdLayerId = (typeof RD_LAYER_ORDER)[number];

/** Ids that must be inserted BELOW the first basemap symbol layer. */
const BELOW_LABELS = new Set<string>(
  RD_LAYER_ORDER.slice(0, RD_LAYER_ORDER.indexOf('rd-national-perimeters') + 1),
);

export function firstSymbolLayerId(map: MlMap): string | undefined {
  const layers = map.getStyle()?.layers ?? [];
  return layers.find((l) => l.type === 'symbol' && !l.id.startsWith('rd-'))?.id;
}

/**
 * beforeId to use when adding an rd- layer so it lands in canonical position.
 * Below-label rasters cap at the first basemap symbol layer; above-label
 * vectors cap at the map top.
 */
export function beforeIdFor(map: MlMap, id: RdLayerId): string | undefined {
  const idx = RD_LAYER_ORDER.indexOf(id);
  const groupEnd = BELOW_LABELS.has(id) ? RD_LAYER_ORDER.indexOf('rd-national-perimeters') + 1 : RD_LAYER_ORDER.length;
  for (let i = idx + 1; i < groupEnd; i++) {
    if (map.getLayer(RD_LAYER_ORDER[i])) return RD_LAYER_ORDER[i];
  }
  if (BELOW_LABELS.has(id)) return firstSymbolLayerId(map);
  return undefined;
}

/** Re-assert canonical order (after style swaps or out-of-order adds). */
export function ensureOrder(map: MlMap): void {
  const symbolId = firstSymbolLayerId(map);
  const ids = RD_LAYER_ORDER.filter((id) => map.getLayer(id));
  // Place top→bottom within each group so every move targets a settled layer.
  let prevAbove: string | undefined;
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i];
    if (BELOW_LABELS.has(id)) continue;
    map.moveLayer(id, prevAbove);
    prevAbove = id;
  }
  let prevBelow = symbolId;
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i];
    if (!BELOW_LABELS.has(id)) continue;
    map.moveLayer(id, prevBelow);
    prevBelow = id;
  }
}
