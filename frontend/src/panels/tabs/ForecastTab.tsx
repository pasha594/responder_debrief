/** Spread-forecast controls: product, percentile, opacity, legend. */
import { LegendImg } from '../../utils/LegendImg';
import { useEffect, useMemo } from 'react';
import {
  latestRun,
  useFire,
  useMasterCatalog,
  usePyrecastRuns,
} from '../../api/queries';
import { spreadLegendUrl } from '../../api/wmsUrls';
import type { Percentile, PyrecastRun, SpreadProduct } from '../../api/types';
import { spreadCoverage } from '../../timeline/framePlan';
import { useStore } from '../../state/store';
import { formatDateTime, formatRelative } from '../../utils/format';

export const SPREAD_PRODUCT_LABELS: Record<SpreadProduct, string> = {
  'spread-rate': 'Spread rate',
  'flame-length': 'Flame length',
  'crown-fire': 'Crown fire',
  'hours-since-burned': 'Hours since burned',
  'time-of-arrival': 'Time of arrival',
  isochrones: 'Isochrones',
};

const ALL_PERCENTILES: Percentile[] = [10, 30, 50, 70, 90];

/**
 * Latest spread run for the selected fire — the same slug resolution
 * useMapLayerSync uses (catalog fire_slug, falling back to unique_slug).
 */
export function useSpreadRunForFire(corneaId: string | null): PyrecastRun | null {
  const { data: catalog } = useMasterCatalog();
  const { data: fire } = useFire(corneaId);
  const { data: runs } = usePyrecastRuns();
  return useMemo(() => {
    const slug =
      catalog?.fires.find((f) => f.cornea_id === corneaId)?.fire_slug ??
      fire?.unique_slug ??
      null;
    return latestRun(runs, slug);
  }, [catalog, fire, runs, corneaId]);
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

  if (!run) {
    return <div className="rd-empty">No spread forecast published for this fire.</div>;
  }

  const products = (Object.keys(run.products) as SpreadProduct[]).filter(
    (p) => run.products[p],
  );
  const coverage = spreadCoverage(run);
  // Only pre-rendered percentiles are selectable in static mode.
  const renderedPercentiles = run.frames?.percentiles ?? run.percentiles;

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
          value={spread.product}
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
            const enabled = renderedPercentiles.includes(p);
            return (
              <button
                key={p}
                type="button"
                className={`rd-pill${spread.percentile === p ? ' rd-pill--active' : ''}`}
                disabled={!enabled}
                title={enabled ? undefined : 'Not pre-rendered in static mode'}
                aria-pressed={spread.percentile === p}
                onClick={() => actions.setSpreadPercentile(p)}
              >
                {p}
              </button>
            );
          })}
        </div>
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
        {coverage && (
          <> — through {formatDateTime(coverage[1], fire?.timezone ?? null)}</>
        )}
      </div>

      <div className="rd-legend-card">
        <LegendImg
          src={spreadLegendUrl(spread.product, run)}
          alt={`${SPREAD_PRODUCT_LABELS[spread.product]} legend`}
        />
      </div>
    </div>
  );
}
