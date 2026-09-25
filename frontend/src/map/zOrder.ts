/**
 * Canonical z-order for all rd- layers. Rasters slot below the basemap's
 * first symbol (label) layer so roads/places stay legible; vectors and pins
 * ride on top.
 */
import type { Map as MlMap } from 'maplibre-gl';

/** Bottom → top. Layer ids owned by our layer managers (prefix rd-). */
export const RD_LAYER_ORDER = [
  // rasters (below basemap labels), bottom → top: incident-map sheets,
  // then the fire forecast, then weather. An ops map at full opacity must
  // never hide the forecast or smoke — those are the transient signal; the
  // sheet is the reference underneath.
  'rd-traffic',
  'rd-incident-map',
  'rd-spread-forecast',
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
  'rd-usgs-trails', // thin lines: over the weather wash, under the labels
  'rd-national-perimeters',
  // ── basemap symbol layers sit here ──
  // vectors above labels
  'rd-wind-arrows', // over the weather rasters + labels, under perimeters/pins
  'rd-range-fill',
  'rd-range-line',
  'rd-incidents-line',
  'rd-incidents-pt',
  'rd-hist-perims-fill',
  'rd-hist-perims-line',
  'rd-hist-perims-label',
  'rd-ir-heat-fill',
  'rd-ir-heat-line',
  'rd-ir-heat-pt',
  'rd-perimeter-fill',
  'rd-perimeter-line',
  'rd-hotspots',
  'rd-hotspot-flames', // custom 3D layer: flames stand on the freshest dots
  'rd-fire-pins',
  // user annotations (Draw tab) ride above every data layer: the NWCG line
  // parts stack bottom → top (layers/drawPlan.ts), then the point symbols
  'rd-draw-line',
  'rd-draw-line-dash',
  'rd-draw-line-pattern',
  'rd-draw-line-marks',
  'rd-draw-line-top',
  'rd-draw-line-dash-top',
  'rd-draw-line-letter',
  'rd-draw-pt-map',
  'rd-draw-pt',
  // directions ride on the very top
  'rd-route-casing',
  'rd-route-line',
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

/** The canonical placement, as moves — applied to the map, or to a plain
 * array first to find out whether anything would actually change. */
function placeCanonically(
  ids: readonly RdLayerId[],
  symbolId: string | undefined,
  move: (id: string, beforeId?: string) => void,
): void {
  // Place top→bottom within each group so every move targets a settled layer.
  let prevAbove: string | undefined;
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i];
    if (BELOW_LABELS.has(id)) continue;
    move(id, prevAbove);
    prevAbove = id;
  }
  let prevBelow = symbolId;
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i];
    if (!BELOW_LABELS.has(id)) continue;
    move(id, prevBelow);
    prevBelow = id;
  }
}

/**
 * Re-assert canonical order (after style swaps or out-of-order adds).
 *
 * It must touch nothing when the order is already right. MapRoot runs this on
 * every 'styledata', and MapLibre's moveLayer marks the style changed even
 * when the layer does not move — which fires 'styledata' again on the next
 * frame. Moving unconditionally made that an endless loop: after the first
 * style change of a session (a layer toggle, a timeline tick) the map redrew
 * itself ~30×/s forever, with nothing on screen changing.
 */
export function ensureOrder(map: MlMap): void {
  const symbolId = firstSymbolLayerId(map);
  // getLayersOrder, not getStyle().layers: the serialized style leaves custom
  // layers (the hotspot flames) out.
  const order = map.getLayersOrder();
  const ids = RD_LAYER_ORDER.filter((id) => order.includes(id));

  const want = order.slice();
  placeCanonically(ids, symbolId, (id, beforeId) => {
    want.splice(want.indexOf(id), 1);
    want.splice(beforeId ? want.indexOf(beforeId) : want.length, 0, id);
  });
  if (want.every((id, i) => id === order[i])) return;

  placeCanonically(ids, symbolId, (id, beforeId) => map.moveLayer(id, beforeId));
}
