/** Weather layer toggles: one checkbox row per catalog product. */
import { useState } from 'react';
import { useWeatherRuns } from '../../api/queries';
import { legendUrl, WMS01 } from '../../api/wmsUrls';
import type { WeatherProduct, WeatherRun } from '../../api/types';
import { useStore } from '../../state/store';
import { formatDateTime, formatRelative } from '../../utils/format';

const STALE_MS = 7 * 3600_000;

export function weatherDefaultLayer(run: WeatherRun, product: string): string {
  return run.default_layer_template
    .replace('{ws}', run.workspace)
    .replace('{product}', product);
}

function WeatherRow({
  product,
  label,
  run,
}: {
  product: WeatherProduct;
  label: string;
  run: WeatherRun;
}) {
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
          <img
            src={legendUrl(WMS01, weatherDefaultLayer(run, product))}
            alt={`${label} legend`}
            loading="lazy"
          />
        </div>
      )}
    </div>
  );
}

export function WeatherTab() {
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
    <div className="rd-tab-body">
      {usable.map(([modelId, model]) => {
        const run = model.runs[0];
        const stale = Date.now() - Date.parse(run.run_time) > STALE_MS;
        const products = Object.entries(model.products) as [
          WeatherProduct,
          { label: string },
        ][];
        return (
          <section key={modelId} className="rd-section">
            {usable.length > 1 && <h3 className="rd-section-title">{model.label}</h3>}
            {products.map(([p, meta]) => (
              <WeatherRow key={p} product={p} label={meta.label} run={run} />
            ))}
            <div className="rd-runinfo">
              {stale
                ? `Run ${formatDateTime(run.run_time, 'UTC')} — refreshing hourly`
                : `Run ${formatRelative(run.run_time)}`}
            </div>
          </section>
        );
      })}
    </div>
  );
}
