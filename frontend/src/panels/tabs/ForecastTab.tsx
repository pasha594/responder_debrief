/**
 * Spread-forecast controls (v2 archive runs): product dropdown (time-of-
 * arrival + the run's hourly products), the ToA paint-mode switch and its
 * reach slider, percentile pills from the archive's actual availability,
 * opacity, and data-driven legends (legend_stops / discrete legend_labels /
 * the ToA legends).
 *
 * The forecast layer has no visibility checkbox: it is on whenever this tab
 * has a run and a product. Anything that could strand it invisible re-arms it
 * (see the store's selectFire / setSpreadProduct, plus the guard below).
 */
import { useEffect, useMemo } from 'react';
import {
  latestRun,
  useFire,
  useMasterCatalog,
  usePyrecastRuns,
} from '../../api/queries';
import {
  nearestPercentile,
  productPercentiles,
  setSpreadArchiveBase,
} from '../../api/wmsUrls';
import type { Percentile, PyrecastRun, SpreadProduct } from '../../api/types';
import { spreadCoverage } from '../../timeline/framePlan';
import {
  clampWithinHours,
  formatBandLabel,
  toaWithinStops,
} from '../../spread/toaBands';
import { staleBadgeLabel } from '../../spread/runMeta';
import { useStore, type ToaMode } from '../../state/store';
import { formatDateTime, formatRelative } from '../../utils/format';
import { GradientLegend } from '../../utils/GradientLegend';
import { LegendSwatch, ToaBandLegend, ToaTimelineLegend } from '../ToaLegends';

export const SPREAD_PRODUCT_LABELS: Record<SpreadProduct, string> = {
  'time-of-arrival': 'Fire spread (time of arrival)',
  'spread-rate': 'Spread rate',
  'flame-length': 'Flame length',
  'crown-fire': 'Crown fire',
  'hours-since-burned': 'Hours since burned',
  isochrones: 'Isochrones',
};

const ALL_PERCENTILES: Percentile[] = [10, 30, 50, 70, 90];

/** Dropdown order: ToA first, then the run's hourly products (spec order). */
const PRODUCT_ORDER: SpreadProduct[] = [
  'time-of-arrival',
  'spread-rate',
  'flame-length',
  'crown-fire',
  'hours-since-burned',
];

const TOA_MODE_LABELS: Record<ToaMode, string> = {
  timeline: 'Timeline (as it burns)',
  whole: 'Whole prediction',
};

/**
 * Latest spread run for the selected fire — the same slug resolution
 * useMapLayerSync uses (catalog fire_slug, falling back to unique_slug).
 */
export function useSpreadRunForFire(corneaId: string | null): PyrecastRun | null {
  const { data: catalog } = useMasterCatalog();
  const { data: fire } = useFire(corneaId);
  const { data: runs } = usePyrecastRuns();
  // Keep the archive base fresh for any panel-driven resolver use.
  useEffect(() => {
    setSpreadArchiveBase(runs?.archive_base);
  }, [runs]);
  return useMemo(() => {
    const slug =
      catalog?.fires.find((f) => f.cornea_id === corneaId)?.fire_slug ??
      fire?.unique_slug ??
      null;
    return latestRun(runs, slug);
  }, [catalog, fire, runs, corneaId]);
}

/** Products offered for a run: ToA (when present) + available hourly tars. */
function availableProducts(run: PyrecastRun): SpreadProduct[] {
  return PRODUCT_ORDER.filter((p) =>
    p === 'time-of-arrival'
      ? (run.toa?.percentiles.length ?? 0) > 0
      : (run.products[p]?.percentiles.length ?? 0) > 0,
  );
}

/**
 * When the model ran vs. how far it forecasts — two separate facts, both in
 * fire-local time with an explicit zone, because conflating them ("model run
 * 5 d ago — through Aug 19") reads as if the forecast itself were 5 days old.
 */
function RunMeta({ run, timezone }: { run: PyrecastRun; timezone: string | null }) {
  const coverage = spreadCoverage(run);
  const stale = staleBadgeLabel(run);
  return (
    <dl className="rd-runmeta">
      <dt>Run</dt>
      <dd>
        {formatDateTime(run.run_time, timezone)}
        <span className="rd-runmeta-rel">({formatRelative(run.run_time)})</span>
        {stale && (
          <span className="rd-stale-badge" title="No newer run has been published">
            {stale}
          </span>
        )}
      </dd>
      <dt>Covers</dt>
      <dd>{coverage ? `through ${formatDateTime(coverage[1], timezone)}` : '—'}</dd>
    </dl>
  );
}

/**
 * Whole-prediction reach: a discrete slider over the band bounds this run can
 * reach. Dragging it left hides the later arrivals, peeling the prediction
 * back toward the ignition area.
 */
function ToaReachSlider({ horizonHours }: { horizonHours: number }) {
  const withinHours = useStore((s) => s.layers.spread.toaWithinHours);
  const setToaWithinHours = useStore((s) => s.actions.setToaWithinHours);
  const stops = useMemo(() => toaWithinStops(horizonHours), [horizonHours]);
  const value = clampWithinHours(withinHours, horizonHours);
  const index = Math.max(0, stops.indexOf(value));
  return (
    <div className="rd-field">
      <span className="rd-field-label">
        Show arrival within
        <span className="rd-field-value">+{Math.round(value)}h</span>
      </span>
      <input
        type="range"
        className="rd-slider"
        min={0}
        max={stops.length - 1}
        step={1}
        value={index}
        onChange={(e) => setToaWithinHours(stops[Number(e.target.value)])}
        aria-label="Show arrival within hours"
        aria-valuetext={formatBandLabel(value)}
      />
      <div className="rd-slider-ends">
        <span>+{stops[0]}h</span>
        <span>+{stops[stops.length - 1]}h</span>
      </div>
    </div>
  );
}

/** Segmented control: which way the time-of-arrival grid is painted. */
function ToaModeSwitch() {
  const mode = useStore((s) => s.layers.spread.toaMode);
  const setToaMode = useStore((s) => s.actions.setToaMode);
  return (
    <div className="rd-field">
      <span className="rd-field-label">Arrival view</span>
      <div className="rd-seg" role="group" aria-label="Arrival view">
        {(Object.keys(TOA_MODE_LABELS) as ToaMode[]).map((m) => (
          <button
            key={m}
            type="button"
            className={`rd-seg-btn${mode === m ? ' rd-seg-btn--active' : ''}`}
            aria-pressed={mode === m}
            onClick={() => setToaMode(m)}
          >
            {TOA_MODE_LABELS[m]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Discrete swatch-row legend (crown-fire: legend_labels ↔ legend_stops). */
function DiscreteLegend({
  stops,
  labels,
}: {
  stops: [number, string][];
  labels: string[];
}) {
  return (
    <div className="rd-swatch-row">
      {stops.map(([value, color], i) => (
        <LegendSwatch key={value} color={color} label={labels[i] ?? String(value)} />
      ))}
    </div>
  );
}

export function ForecastTab({ corneaId }: { corneaId: string }) {
  const run = useSpreadRunForFire(corneaId);
  const { data: fire } = useFire(corneaId);
  const spread = useStore((s) => s.layers.spread);
  const actions = useStore((s) => s.actions);

  // Mirror this tab's active product into the LegendBar.
  useEffect(() => {
    const key = run ? `spread:${spread.product}` : null;
    if (useStore.getState().ui.legendKey !== key) actions.setLegendKey(key);
  }, [run, spread.product, actions]);

  // There is no visibility control any more, so the tab guarantees the layer
  // is on whenever it has something to show (see the store actions too).
  useEffect(() => {
    if (run && !spread.visible) actions.setSpreadVisible(true);
  }, [run, spread.visible, actions]);

  const products = run ? availableProducts(run) : [];
  if (!run || products.length === 0) {
    return <div className="rd-empty">No spread forecast published for this fire.</div>;
  }

  // Fall back to ToA if the stored product isn't in this run.
  const product: SpreadProduct = products.includes(spread.product)
    ? spread.product
    : products[0];
  const percentiles = productPercentiles(run, product);
  // Requested percentile may be absent — the map renders the nearest one.
  const effectivePct = nearestPercentile(percentiles, spread.percentile);
  const meta = product === 'time-of-arrival' ? null : run.products[product];
  const isToa = product === 'time-of-arrival';
  const wholeMode = isToa && spread.toaMode === 'whole';
  const timezone = fire?.timezone ?? null;

  return (
    <div className="rd-tab-body">
      <div className="rd-field">
        <span className="rd-field-label">Product</span>
        <select
          className="rd-select"
          value={product}
          onChange={(e) => actions.setSpreadProduct(e.target.value as SpreadProduct)}
        >
          {products.map((p) => (
            <option key={p} value={p}>
              {SPREAD_PRODUCT_LABELS[p]}
            </option>
          ))}
        </select>
      </div>

      {isToa && <ToaModeSwitch />}
      {wholeMode && <ToaReachSlider horizonHours={run.horizon_hours} />}

      <div className="rd-field">
        <span className="rd-field-label">Ensemble percentile</span>
        <div className="rd-pills" role="group" aria-label="Ensemble percentile">
          {ALL_PERCENTILES.map((p) => {
            const enabled = percentiles.includes(p);
            return (
              <button
                key={p}
                type="button"
                className={`rd-pill${effectivePct === p ? ' rd-pill--active' : ''}`}
                disabled={!enabled}
                title={enabled ? undefined : 'Not published for this product'}
                aria-pressed={effectivePct === p}
                onClick={() => actions.setSpreadPercentile(p)}
              >
                {p}
              </button>
            );
          })}
        </div>
        {effectivePct !== null && effectivePct !== spread.percentile && (
          <div className="rd-field-note">
            Showing nearest available percentile ({effectivePct}).
          </div>
        )}
      </div>

      <div className="rd-field">
        <span className="rd-field-label">Opacity</span>
        <input
          type="range"
          className="rd-slider"
          min={0}
          max={1}
          step={0.05}
          value={spread.opacity}
          onChange={(e) => actions.setSpreadOpacity(Number(e.target.value))}
          aria-label="Forecast opacity"
        />
      </div>

      <RunMeta run={run} timezone={timezone} />

      <div className="rd-legend-card">
        {isToa ? (
          wholeMode ? (
            <ToaBandLegend
              horizonHours={run.horizon_hours}
              withinHours={clampWithinHours(spread.toaWithinHours, run.horizon_hours)}
            />
          ) : (
            <ToaTimelineLegend run={run} timezone={timezone} />
          )
        ) : meta?.legend_labels?.length ? (
          <DiscreteLegend stops={meta.legend_stops} labels={[...meta.legend_labels]} />
        ) : meta?.legend_stops?.length ? (
          <GradientLegend stops={meta.legend_stops} units={meta.units ?? undefined} />
        ) : null}
      </div>
    </div>
  );
}
