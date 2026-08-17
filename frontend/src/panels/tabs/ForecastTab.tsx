/**
 * Spread-forecast controls (v2 archive runs): product dropdown (time-of-
 * arrival + the run's hourly products), percentile pills from the archive's
 * actual availability, opacity, and data-driven legends (legend_stops /
 * discrete legend_labels / the ToA burned+leading-edge swatches).
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
import { useStore } from '../../state/store';
import { formatDateTime, formatRelative } from '../../utils/format';
import { GradientLegend } from '../../utils/GradientLegend';

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

/** Two-swatch ToA legend + "as of {scrub time}" caption. */
function ToaLegend({ run, timezone }: { run: PyrecastRun; timezone: string | null }) {
  const currentTime = useStore((s) => s.time.currentTime);
  const stops = new Map(run.toa_ramp?.stops ?? []);
  const burned = stops.get('burned') ?? '#7a1f1f';
  const recent = stops.get('recent') ?? '#ff6a2b';
  const recentHours = run.toa_ramp?.recent_hours ?? 12;
  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <LegendSwatch color={recent} label={`Spread in last ${recentHours} h`} />
        <LegendSwatch color={burned} label="Burned earlier" />
      </div>
      <div className="rd-legend-caption" style={{ marginTop: 4, fontSize: 11, opacity: 0.7 }}>
        as of {formatDateTime(currentTime, timezone)}
      </div>
    </div>
  );
}

export function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        aria-hidden
        style={{ width: 14, height: 14, borderRadius: 3, background: color, display: 'inline-block' }}
      />
      <span style={{ fontSize: 12 }}>{label}</span>
    </span>
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
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
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
    const key = run && spread.visible ? `spread:${spread.product}` : null;
    if (useStore.getState().ui.legendKey !== key) actions.setLegendKey(key);
  }, [run, spread.visible, spread.product, actions]);

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
  const coverage = spreadCoverage(run);
  const meta = product === 'time-of-arrival' ? null : run.products[product];

  return (
    <div className="rd-tab-body">
      <label className="rd-field rd-field--row">
        <input
          type="checkbox"
          checked={spread.visible}
          onChange={(e) => actions.setSpreadVisible(e.target.checked)}
        />
        <span>Show forecast on map</span>
      </label>

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
          <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>
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

      <div className="rd-runinfo">
        Model run {formatRelative(run.run_time)}
        {coverage && <> — through {formatDateTime(coverage[1], fire?.timezone ?? null)}</>}
      </div>

      <div className="rd-legend-card">
        {product === 'time-of-arrival' ? (
          <ToaLegend run={run} timezone={fire?.timezone ?? null} />
        ) : meta?.legend_labels?.length ? (
          <DiscreteLegend stops={meta.legend_stops} labels={[...meta.legend_labels]} />
        ) : meta?.legend_stops?.length ? (
          <GradientLegend stops={meta.legend_stops} units={meta.units ?? undefined} />
        ) : null}
      </div>
    </div>
  );
}
