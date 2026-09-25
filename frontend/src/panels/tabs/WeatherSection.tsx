/**
 * Weather layer toggles: one checkbox row per pre-rendered catalog product.
 * Rendered as the "Weather" section of the Forecast tab.
 */
import { LegendImg } from '../../utils/LegendImg';
import { isRenderableWeatherRun, useWeatherRuns } from '../../api/queries';
import { weatherLegendUrl } from '../../api/wmsUrls';
import {
  RENDERED_WEATHER_PRODUCTS,
  type WeatherProduct,
  type WeatherProductMeta,
} from '../../api/types';
import { useStore } from '../../state/store';
import { weatherCoverage, weatherJumpTarget } from '../../timeline/framePlan';
import { formatDateTime, formatRelative } from '../../utils/format';
import { GradientLegend } from '../../utils/GradientLegend';
import { LayerRow } from '../layers/LayerRow';

const STALE_MS = 7 * 3600_000;

function WeatherRow({
  product,
  meta,
  legendTemplate,
  coverage,
  arrowNote,
}: {
  product: WeatherProduct;
  meta: WeatherProductMeta;
  legendTemplate: string | undefined;
  /** The run's rendered-hour span; turning a layer on may jump the playhead (weatherJumpTarget). */
  coverage: [number, number] | null;
  /** True on wind rows when the run carries U/V grids (arrows will render). */
  arrowNote?: boolean;
}) {
  const label = meta.label;
  const state = useStore((s) => s.layers.weather[product]);
  const actions = useStore((s) => s.actions);
  const visible = state?.visible ?? false;
  const opacity = state?.opacity ?? 0.7;

  return (
    <LayerRow
      label={label}
      checked={visible}
      onChange={(on) => {
        const { currentTime, now } = useStore.getState().time;
        const target = on ? weatherJumpTarget(coverage, currentTime, now) : null;
        if (target !== null) actions.setTime(target);
        actions.setWeatherLayer(product, { visible: on });
      }}
    >
      {visible && (
        <>
          {arrowNote && (
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
              arrows show wind direction
            </div>
          )}
          <input
            type="range"
            className="rd-slider"
            min={0}
            max={1}
            step={0.05}
            value={opacity}
            onChange={(e) => actions.setWeatherLayer(product, { opacity: Number(e.target.value) })}
            aria-label={`${label} opacity`}
          />
          <div className="rd-mini-legend">
            {meta.legend_stops ? (
              <GradientLegend stops={meta.legend_stops} units={meta.units} />
            ) : (
              <LegendImg src={weatherLegendUrl(product, legendTemplate)} alt={`${label} legend`} />
            )}
          </div>
        </>
      )}
    </LayerRow>
  );
}

export function WeatherSection() {
  const { data: weather, isLoading } = useWeatherRuns();

  if (isLoading) return <div className="rd-empty">Loading weather catalogs…</div>;

  const models = weather ? Object.entries(weather.models) : [];
  const usable = models.filter(([, m]) => m.runs.length > 0);
  if (!weather || usable.length === 0) {
    return (
      <div className="rd-empty">Weather catalogs not yet published — run the worker.</div>
    );
  }

  return (
    <>
      {usable.map(([modelId, model]) => {
        const run = model.runs.find(isRenderableWeatherRun) ?? model.runs[0];
        const stale = Date.now() - Date.parse(run.run_time) > STALE_MS;
        // Only products that are BOTH in the manifest and pre-rendered.
        const products = RENDERED_WEATHER_PRODUCTS.flatMap((p) => {
          const meta = model.products[p];
          return meta ? ([[p, meta]] as [WeatherProduct, WeatherProductMeta][]) : [];
        });
        const hasArrows = !!run.frames?.wind_uv_template;
        const coverage = weatherCoverage(run);
        return (
          <div key={modelId}>
            <h3 className="rd-section-title">
              {usable.length > 1 ? model.label : 'HRRR Forecast'}
              <span className="rd-title-meta">
                {stale
                  ? `Run ${formatDateTime(run.run_time, 'UTC')} — refreshing hourly`
                  : `Run ${formatRelative(run.run_time)}`}
              </span>
            </h3>
            {products.map(([p, meta]) => (
              <WeatherRow
                key={p}
                product={p}
                meta={meta}
                legendTemplate={model.legend_template}
                coverage={coverage}
                arrowNote={hasArrows && (p === 'ws' || p === 'wg')}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}
