/**
 * URL resolvers. Weather frames + legends stay worker-rendered on B2
 * (root-relative templates joined against DATA_BASE_URL via dataUrl()); the
 * national perimeters image is MUTABLE (cache-busted with as_of). Spread
 * forecasts are NOT frames anymore: the v2 runs catalog carries
 * archive-base-relative templates for the raw archive files (ToA tifs,
 * hourly-product tars), joined here against the catalog's `archive_base`
 * (spec docs/spec-archives.md) — the browser decodes them client-side.
 */
import { dataUrl } from './catalogs';
import { boundsToImageCoords } from './geo';
import type {
  MasterCatalog,
  PyrecastRun,
  SpreadProduct,
  WeatherProduct,
  WeatherRun,
} from './types';

// Fallback templates matching the worker's B2 key scheme (docs/spec-frames.md)
// — used only when a manifest predates the frames blocks.
const WEATHER_IMAGE_TEMPLATE = '/frames/weather/{ws}/{product}/{epoch_ms}.png';
const SPREAD_LEGEND_TEMPLATE = '/frames/legends/spread-{product}.png';
const WEATHER_LEGEND_TEMPLATE = '/frames/legends/weather-{product}.png';

// ---------- Spread (public forecast archive, client-side decode) ----------

/** Spec source base — used until a v2 catalog supplies its own archive_base. */
const DEFAULT_SPREAD_ARCHIVE_BASE = 'https://f005.backblazeb2.com/file/fire-forecast-archive';

// Fallback archive key scheme (spec) for runs missing their templates.
const TOA_URL_TEMPLATE = '/forecast_archive/{slug}/{run_ts}/{pct}.tif';
const PRODUCT_TAR_TEMPLATE = '/forecast_archive/{slug}/{run_ts}/{pct}_{product}.tar';

let spreadArchiveBase = DEFAULT_SPREAD_ARCHIVE_BASE;

/**
 * Remember the runs catalog's `archive_base` (call whenever the catalog
 * loads). Relative spread templates resolve against the last base seen.
 */
export function setSpreadArchiveBase(base: string | null | undefined): void {
  if (base) spreadArchiveBase = base.replace(/\/+$/, '');
}

function archiveUrl(rel: string): string {
  return `${spreadArchiveBase}${rel.startsWith('/') ? '' : '/'}${rel}`;
}

function fillRunTemplate(tpl: string, run: PyrecastRun, pct: number): string {
  return tpl
    .replace('{slug}', run.slug)
    .replace('{run_ts}', run.run_ts)
    .replace('{pct}', String(pct));
}

/** Absolute URL of a run's time-of-arrival {pct}.tif in the archive. */
export function spreadToaUrl(run: PyrecastRun, pct: number): string {
  return archiveUrl(fillRunTemplate(run.toa?.url_template ?? TOA_URL_TEMPLATE, run, pct));
}

/** Absolute URL of a run's hourly {pct}_{product}.tar in the archive. */
export function spreadProductTarUrl(
  run: PyrecastRun,
  product: SpreadProduct,
  pct: number,
): string {
  const tpl = run.products[product]?.tar_template ?? PRODUCT_TAR_TEMPLATE;
  return archiveUrl(fillRunTemplate(tpl, run, pct).replace('{product}', product));
}

/** Percentiles with an ok ToA tif for the run ([] when none/no run). */
export function toaPercentiles(run: PyrecastRun | null | undefined): number[] {
  return run?.toa?.percentiles ?? [];
}

/**
 * Percentiles available for a product selection — ToA percentiles for
 * 'time-of-arrival', the product's tar percentiles otherwise.
 */
export function productPercentiles(
  run: PyrecastRun | null | undefined,
  product: SpreadProduct,
): number[] {
  if (product === 'time-of-arrival') return toaPercentiles(run);
  return run?.products[product]?.percentiles ?? [];
}

/**
 * The percentile to actually render: `want` when available, else the nearest
 * available (ties → the smaller). Null when nothing is available.
 */
export function nearestPercentile(available: number[], want: number): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const p of available) {
    const d = Math.abs(p - want);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best;
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
  // cv=2: one-time cache-bust. Early builds preloaded these frames without
  // crossOrigin, poisoning browser caches (no-ACAO entries under an immutable
  // 1y max-age) so MapLibre's CORS fetch failed. New URLs start clean.
  return `${dataUrl(rel)}?cv=2`;
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
