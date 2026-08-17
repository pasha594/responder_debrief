/**
 * Static-frame URL resolvers. The browser never talks to a WMS server: the
 * worker pre-renders every frame/legend to B2 and the manifests carry
 * root-relative path templates, resolved here against DATA_BASE_URL via
 * dataUrl(). Spread/weather frames are immutable run-stamped keys; the
 * national perimeters image is MUTABLE (cache-busted with as_of).
 */
import { dataUrl } from './catalogs';
import { boundsToImageCoords } from './geo';
import type {
  MasterCatalog,
  Percentile,
  PyrecastRun,
  SpreadProduct,
  WeatherProduct,
  WeatherRun,
} from './types';

// Fallback templates matching the worker's B2 key scheme (docs/spec-frames.md)
// — used only when a manifest predates the frames blocks.
const SPREAD_TIMED_TEMPLATE = '/frames/spread/{ws}/{pct}/{product}/{epoch_ms}.png';
const SPREAD_STATIC_TEMPLATE = '/frames/spread/{ws}/{pct}/{product}/static.png';
const WEATHER_IMAGE_TEMPLATE = '/frames/weather/{ws}/{product}/{epoch_ms}.png';
const SPREAD_LEGEND_TEMPLATE = '/frames/legends/spread-{product}.png';
const WEATHER_LEGEND_TEMPLATE = '/frames/legends/weather-{product}.png';

/**
 * Pre-rendered spread-forecast frame. `timeInstant` must be a VERBATIM
 * instant from run.frames.instants (Date.parse → {epoch_ms}); null selects
 * the static frame (time-of-arrival / isochrones). One URL per
 * (run, product, pct, instant) — immutable.
 */
export function spreadFrameUrl(
  run: PyrecastRun,
  product: SpreadProduct,
  pct: Percentile,
  timeInstant: string | null,
): string {
  const tpl =
    timeInstant === null
      ? (run.frames?.static_template ?? SPREAD_STATIC_TEMPLATE)
      : (run.frames?.timed_template ?? SPREAD_TIMED_TEMPLATE);
  let rel = tpl
    .replace('{ws}', run.workspace)
    .replace('{pct}', String(pct))
    .replace('{product}', product);
  if (timeInstant !== null) {
    rel = rel.replace('{epoch_ms}', String(Date.parse(timeInstant)));
  }
  return dataUrl(rel);
}

/**
 * Pre-rendered CONUS weather frame for one product + forecast hour.
 * `hourIso` must come from run.frames.hours. Immutable.
 */
export function weatherImageUrl(run: WeatherRun, product: string, hourIso: string): string {
  const tpl = run.frames?.image_template ?? WEATHER_IMAGE_TEMPLATE;
  const rel = tpl
    .replace('{ws}', run.workspace)
    .replace('{product}', product)
    .replace('{epoch_ms}', String(Date.parse(hourIso)));
  return dataUrl(rel);
}

/**
 * Spread legend image. Prefers the per-product manifest field
 * (run.products[product].legend), falling back to the spec key scheme.
 */
export function spreadLegendUrl(product: SpreadProduct, run?: PyrecastRun | null): string {
  const rel =
    run?.products[product]?.legend ?? SPREAD_LEGEND_TEMPLATE.replace('{product}', product);
  return dataUrl(rel);
}

/**
 * Weather legend image. Prefers the model-level manifest template
 * (models[m].legend_template), falling back to the spec key scheme.
 */
export function weatherLegendUrl(product: WeatherProduct, legendTemplate?: string | null): string {
  const tpl = legendTemplate ?? WEATHER_LEGEND_TEMPLATE;
  return dataUrl(tpl.replace('{product}', product));
}

/**
 * National current-year perimeters snapshot: a single mutable CONUS image the
 * worker overwrites every sync — cache-busted with as_of so rotation is
 * picked up. Null when the catalog lacks the block (layer hides gracefully).
 */
export function nationalPerimetersImage(
  catalog: MasterCatalog | undefined,
): { url: string; coords: ReturnType<typeof boundsToImageCoords> } | null {
  const entry = catalog?.national_layers?.current_year_perimeters;
  if (!entry?.image || !entry.bounds) return null;
  return {
    url: `${dataUrl(entry.image)}?t=${encodeURIComponent(entry.as_of)}`,
    coords: boundsToImageCoords(entry.bounds),
  };
}
