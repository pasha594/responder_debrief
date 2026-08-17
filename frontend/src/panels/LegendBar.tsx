/**
 * Small legend card, bottom-right above the timeline. Mirrors the active
 * spread product (ui.legendKey = "spread:{product}") and every visible
 * weather layer.
 */
import { useMemo } from 'react';
import {
  latestRun,
  useFire,
  useMasterCatalog,
  usePyrecastRuns,
  useWeatherRuns,
} from '../api/queries';
import { legendUrl, proxyRelative, WMS01 } from '../api/wmsUrls';
import type { SpreadProduct, WeatherProduct, WeatherRun } from '../api/types';
import { useStore, type WeatherLayerState } from '../state/store';
import { SPREAD_PRODUCT_LABELS } from './tabs/ForecastTab';
import { weatherDefaultLayer } from './tabs/WeatherTab';

interface WeatherLegendRow {
  product: WeatherProduct;
  label: string;
  url: string;
}

export function LegendBar() {
  const legendKey = useStore((s) => s.ui.legendKey);
  const weatherState = useStore((s) => s.layers.weather);
  const spreadVisible = useStore((s) => s.layers.spread.visible);
  const view = useStore((s) => s.view);
  const corneaId = view.mode === 'fire' ? view.corneaId : null;

  const { data: catalog } = useMasterCatalog();
  const { data: fire } = useFire(corneaId);
  const { data: pyrecastRuns } = usePyrecastRuns();
  const { data: weatherRuns } = useWeatherRuns();

  const run = useMemo(() => {
    const slug =
      catalog?.fires.find((f) => f.cornea_id === corneaId)?.fire_slug ??
      fire?.unique_slug ??
      null;
    return latestRun(pyrecastRuns, slug);
  }, [catalog, fire, pyrecastRuns, corneaId]);

  const spreadProduct =
    legendKey && legendKey.startsWith('spread:')
      ? (legendKey.slice('spread:'.length) as SpreadProduct)
      : null;
  const spreadLegendRel =
    spreadVisible && spreadProduct ? (run?.products[spreadProduct]?.legend_url ?? null) : null;

  const weatherRows = useMemo<WeatherLegendRow[]>(() => {
    const visible = Object.entries(weatherState).filter(
      (e): e is [WeatherProduct, WeatherLayerState] => !!e[1]?.visible,
    );
    if (!visible.length || !weatherRuns) return [];
    const rows: WeatherLegendRow[] = [];
    for (const [product] of visible) {
      let label: string = product;
      let latest: WeatherRun | null = null;
      for (const model of Object.values(weatherRuns.models)) {
        const meta = model.products[product];
        if (meta && model.runs.length) {
          label = meta.label;
          latest = model.runs[0];
          break;
        }
      }
      if (!latest) continue;
      rows.push({ product, label, url: legendUrl(WMS01, weatherDefaultLayer(latest, product)) });
    }
    return rows;
  }, [weatherState, weatherRuns]);

  if (!spreadLegendRel && weatherRows.length === 0) return null;

  return (
    <div className="rd-legendbar">
      {spreadLegendRel && spreadProduct && (
        <div className="rd-legendbar-spread">
          <div className="rd-legendbar-caption">{SPREAD_PRODUCT_LABELS[spreadProduct]}</div>
          <img src={proxyRelative(spreadLegendRel)} alt="Forecast legend" loading="lazy" />
        </div>
      )}
      {weatherRows.map((row) => (
        <div key={row.product} className="rd-legendbar-weather-row">
          <span className="rd-legendbar-label">{row.label}</span>
          <img src={row.url} alt={`${row.label} legend`} loading="lazy" />
        </div>
      ))}
    </div>
  );
}
