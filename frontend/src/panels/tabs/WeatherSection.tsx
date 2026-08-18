/**
 * Weather layer toggles: one checkbox row per pre-rendered catalog product.
 * Rendered as the "Weather" section of the Forecast tab.
 */
import { LegendImg } from '../../utils/LegendImg';
import { useState } from 'react';
import { useWeatherRuns } from '../../api/queries';
import { weatherLegendUrl } from '../../api/wmsUrls';
import {
  RENDERED_WEATHER_PRODUCTS,
  type WeatherProduct,
  type WeatherProductMeta,
} from '../../api/types';
import { useStore } from '../../state/store';
import { formatDateTime, formatRelative } from '../../utils/format';
import { GradientLegend } from '../../utils/GradientLegend';

const STALE_MS = 7 * 3600_000;

function WeatherRow({
  product,
  meta,
  legendTemplate,
  arrowNote,
}: {
  product: WeatherProduct;
  meta: WeatherProductMeta;
  legendTemplate: string | undefined;
  /** True on wind rows when the run carries U/V grids (arrows will render). */
  arrowNote?: boolean;
}) {
  const label = meta.label;
  const state = useStore((s) => s.layers.weather[product]);
  const actions = useStore((s) => s.actions);
  const [legendOpen, setLegendOpen] = useState(false);
  const visible = state?.visible ?? false;
  const opacity = state?.opacity ?? 0.7;

  return (
    <div className={`rd-weather-row${visible ? ' rd-weather-row--on' : ''}`}>
      <div className="rd-weather-row-top">
        <label className="rd-field--row">
          <input
            type="checkbox"
            checked={visible}
            onChange={(e) => actions.setWeatherLayer(product, { visible: e.target.checked })}
          />
          <span>{label}</span>
        </label>
        <button
          type="button"
          className="rd-mini-btn"
          aria-expanded={legendOpen}
          onClick={() => setLegendOpen((v) => !v)}
          title={legendOpen ? 'Hide legend' : 'Show legend'}
        >
          {legendOpen ? 'Legend ▾' : 'Legend ▸'}
        </button>
      </div>
      {visible && arrowNote && (
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
          arrows show wind direction
        </div>
      )}
      {visible && (
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
      )}
      {legendOpen && (
        <div className="rd-mini-legend">
          {meta.legend_stops ? (
            <GradientLegend stops={meta.legend_stops} units={meta.units} />
          ) : (
            <LegendImg src={weatherLegendUrl(product, legendTemplate)} alt={`${label} legend`} />
          )}
        </div>
      )}
    </div>
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
        const run = model.runs[0];
        const stale = Date.now() - Date.parse(run.run_time) > STALE_MS;
        // Only products that are BOTH in the manifest and pre-rendered.
        const products = RENDERED_WEATHER_PRODUCTS.flatMap((p) => {
          const meta = model.products[p];
          return meta ? ([[p, meta]] as [WeatherProduct, WeatherProductMeta][]) : [];
        });
        const hasArrows = !!run.frames?.wind_uv_template;
        return (
          <section key={modelId} className="rd-section">
            {usable.length > 1 && <h3 className="rd-section-title">{model.label}</h3>}
            {products.map(([p, meta]) => (
              <WeatherRow
                key={p}
                product={p}
                meta={meta}
                legendTemplate={model.legend_template}
                arrowNote={hasArrows && (p === 'ws' || p === 'wg')}
              />
            ))}
            <div className="rd-runinfo">
              {stale
                ? `Run ${formatDateTime(run.run_time, 'UTC')} — refreshing hourly`
                : `Run ${formatRelative(run.run_time)}`}
            </div>
          </section>
        );
      })}
    </>
  );
}
