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
import { LegendSwatch, SPREAD_PRODUCT_LABELS } from './tabs/ForecastTab';
import { GradientLegend } from '../utils/GradientLegend';

interface WeatherLegendRow {
  product: WeatherProduct;
  label: string;
  url: string;
  stops?: [number, string][];
  units?: string;
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
  const showSpread = spreadVisible && !!spreadProduct && !!run;
  const spreadMeta = showSpread && spreadProduct ? run?.products?.[spreadProduct] : undefined;
  const toaRamp = spreadProduct === 'time-of-arrival' ? run?.toa_ramp : undefined;
  // Legacy image fallback for pre-v2 catalogs only.
  const spreadLegendSrc =
    showSpread && spreadProduct && !spreadMeta?.legend_stops && !toaRamp
      ? spreadLegendUrl(spreadProduct, run)
      : null;

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
      let stops: [number, string][] | undefined;
      let units: string | undefined;
      let found = false;
      for (const model of Object.values(weatherRuns.models)) {
        const meta = model.products[product];
        if (meta && model.runs.length) {
          label = meta.label;
          legendTemplate = model.legend_template;
          stops = meta.legend_stops;
          units = meta.units;
          found = true;
          break;
        }
      }
      if (!found) continue;
      rows.push({ product, label, url: weatherLegendUrl(product, legendTemplate), stops, units });
    }
    return rows;
  }, [weatherState, weatherRuns]);

  if (!showSpread && weatherRows.length === 0) return null;

  return (
    <div className="rd-legendbar">
      {showSpread && spreadProduct && (
        <div className="rd-legendbar-spread">
          <div className="rd-legendbar-caption">{SPREAD_PRODUCT_LABELS[spreadProduct]}</div>
          {toaRamp ? (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {toaRamp.stops.map(([name, color]) => (
                <LegendSwatch key={name} color={color} label={name} />
              ))}
            </div>
          ) : spreadMeta?.legend_labels && spreadMeta.legend_stops ? (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {spreadMeta.legend_stops.map(([, color], i) => (
                <LegendSwatch key={i} color={color} label={spreadMeta.legend_labels?.[i] ?? ''} />
              ))}
            </div>
          ) : spreadMeta?.legend_stops ? (
            <GradientLegend stops={spreadMeta.legend_stops} units={spreadMeta.units ?? undefined} />
          ) : spreadLegendSrc ? (
            <LegendImg src={spreadLegendSrc} alt="Forecast legend" />
          ) : null}
        </div>
      )}
      {weatherRows.map((row) => (
        <div key={row.product} className="rd-legendbar-weather-row">
          <span className="rd-legendbar-label">{row.label}</span>
          {row.stops ? (
            <GradientLegend stops={row.stops} units={row.units} />
          ) : (
            <LegendImg src={row.url} alt={`${row.label} legend`} />
          )}
        </div>
      ))}
    </div>
  );
}
