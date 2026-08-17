/**
 * Small legend card, bottom-right above the timeline. Mirrors the active
 * spread product (ui.legendKey = "spread:{product}") and every visible
 * weather layer.
 */
import { LegendImg } from '../utils/LegendImg';
import { useMemo } from 'react';
import {
  latestRun,
  useFire,
  useMasterCatalog,
  usePyrecastRuns,
  useWeatherRuns,
} from '../api/queries';
import { spreadLegendUrl, weatherLegendUrl } from '../api/wmsUrls';
import {
  RENDERED_WEATHER_PRODUCTS,
  type SpreadProduct,
  type WeatherProduct,
} from '../api/types';
import { useStore, type WeatherLayerState } from '../state/store';
import { SPREAD_PRODUCT_LABELS } from './tabs/ForecastTab';

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
  const spreadLegendSrc =
    spreadVisible && spreadProduct && run ? spreadLegendUrl(spreadProduct, run) : null;

  const weatherRows = useMemo<WeatherLegendRow[]>(() => {
    const visible = Object.entries(weatherState).filter(
      (e): e is [WeatherProduct, WeatherLayerState] =>
        !!e[1]?.visible &&
        (RENDERED_WEATHER_PRODUCTS as readonly string[]).includes(e[0]),
    );
    if (!visible.length || !weatherRuns) return [];
    const rows: WeatherLegendRow[] = [];
    for (const [product] of visible) {
      let label: string = product;
      let legendTemplate: string | undefined;
      let found = false;
      for (const model of Object.values(weatherRuns.models)) {
        const meta = model.products[product];
        if (meta && model.runs.length) {
          label = meta.label;
          legendTemplate = model.legend_template;
          found = true;
          break;
        }
      }
      if (!found) continue;
      rows.push({ product, label, url: weatherLegendUrl(product, legendTemplate) });
    }
    return rows;
  }, [weatherState, weatherRuns]);

  if (!spreadLegendSrc && weatherRows.length === 0) return null;

  return (
    <div className="rd-legendbar">
      {spreadLegendSrc && spreadProduct && (
        <div className="rd-legendbar-spread">
          <div className="rd-legendbar-caption">{SPREAD_PRODUCT_LABELS[spreadProduct]}</div>
          <LegendImg src={spreadLegendSrc} alt="Forecast legend" />
        </div>
      )}
      {weatherRows.map((row) => (
        <div key={row.product} className="rd-legendbar-weather-row">
          <span className="rd-legendbar-label">{row.label}</span>
          <LegendImg src={row.url} alt={`${row.label} legend`} />
        </div>
      ))}
    </div>
  );
}
