/**
 * The map's key, bottom-left above the timeline. Mirrors the spread product
 * the map draws (read from the store, so it holds on every tab), every
 * visible weather layer, the IR flight shown on the map, and the vegetation
 * layer. Folded to a "Key · N" pill by default so it doesn't cover the map
 * (each layer's row in the side panel carries the same key); open or folded
 * is remembered on this device. A native <details>, so keyboard and screen
 * readers get a real disclosure for free.
 */
import { LegendImg } from '../utils/LegendImg';
import { useMemo, useState } from 'react';
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
  type WeatherProduct,
} from '../api/types';
import { useStore, type WeatherLayerState } from '../state/store';
import { SPREAD_PRODUCT_LABELS } from './tabs/ForecastTab';
import { LegendSwatch, ToaBandLegend, ToaTimelineLegend } from './ToaLegends';
import { clampWithinHours } from '../spread/toaBands';
import { GradientLegend } from '../utils/GradientLegend';
import { irFlightWhen } from '../utils/incidentMaps';
import { IrHeatLegend } from './IrHeatLegend';
import { useManifestForFire } from './tabs/IncidentMapsTab';
import { VegetationLegend } from './VegetationLegend';
import { useFireBundle } from '../routing/hooks';

const OPEN_KEY = 'rd-map-key-open';

function readOpen(): boolean {
  // Everything inside the try: even `typeof localStorage` can throw when
  // site data is blocked.
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function saveOpen(open: boolean) {
  try {
    if (open) localStorage.setItem(OPEN_KEY, '1');
    else localStorage.removeItem(OPEN_KEY);
  } catch {
    /* folded next time; nothing else depends on it */
  }
}

interface WeatherLegendRow {
  product: WeatherProduct;
  label: string;
  url: string;
  stops?: [number, string][];
  units?: string;
}

export function LegendBar() {
  const weatherState = useStore((s) => s.layers.weather);
  const spreadVisible = useStore((s) => s.layers.spread.visible);
  const spreadProduct = useStore((s) => s.layers.spread.product);
  const toaMode = useStore((s) => s.layers.spread.toaMode);
  const toaWithinHours = useStore((s) => s.layers.spread.toaWithinHours);
  const irFlightId = useStore((s) => s.layers.irFlight.flightId);
  const vegVisible = useStore((s) => s.layers.vegetation.visible);
  const view = useStore((s) => s.view);
  const corneaId = view.mode === 'fire' ? view.corneaId : null;
  const [open, setOpen] = useState(readOpen);

  const { data: catalog } = useMasterCatalog();
  const { data: fire } = useFire(corneaId);
  const { data: pyrecastRuns } = usePyrecastRuns();
  const { data: weatherRuns } = useWeatherRuns();
  const { data: manifest } = useManifestForFire(corneaId);
  const irFlight =
    (irFlightId && manifest?.ir_flights.find((f) => f.flight_id === irFlightId && f.geojson_url)) ||
    null;
  // Vegetation paints only when the fire has a routing bundle.
  const { data: bundle } = useFireBundle(vegVisible ? corneaId : null);
  const showVeg = vegVisible && !!bundle;

  const run = useMemo(() => {
    const slug =
      catalog?.fires.find((f) => f.cornea_id === corneaId)?.fire_slug ??
      fire?.unique_slug ??
      null;
    return latestRun(pyrecastRuns, slug);
  }, [catalog, fire, pyrecastRuns, corneaId]);

  const showSpread = spreadVisible && !!run;
  const spreadMeta = showSpread ? run?.products?.[spreadProduct] : undefined;
  const isToa = spreadProduct === 'time-of-arrival';
  // Legacy image fallback for pre-v2 catalogs only.
  const spreadLegendSrc =
    showSpread && !spreadMeta?.legend_stops && !isToa
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

  const count = (showSpread ? 1 : 0) + weatherRows.length + (irFlight ? 1 : 0) + (showVeg ? 1 : 0);
  if (count === 0) return null;

  return (
    <details
      className="rd-legendbar"
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        if (next !== open) {
          setOpen(next);
          saveOpen(next);
        }
      }}
    >
      <summary className="rd-legendbar-summary" title={open ? 'Hide the key' : 'Show the key'}>
        <span>Key · {count}</span>
        <svg className="rd-legendbar-chevron" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 6.5 5 3.5 8 6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </summary>
      <div className="rd-legendbar-body">
        {showSpread && (
          <div className="rd-legendbar-spread">
            <div className="rd-legendbar-caption">{SPREAD_PRODUCT_LABELS[spreadProduct]}</div>
            {isToa && run ? (
              // Mirror whichever ToA legend the Forecast tab is showing.
              toaMode === 'whole' ? (
                <ToaBandLegend
                  horizonHours={run.horizon_hours}
                  withinHours={clampWithinHours(toaWithinHours, run.horizon_hours)}
                />
              ) : (
                <ToaTimelineLegend run={run} timezone={fire?.timezone ?? null} />
              )
            ) : spreadMeta?.legend_labels && spreadMeta.legend_stops ? (
              <div className="rd-swatch-row">
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
        {irFlight && (
          <div>
            <div className="rd-legendbar-caption">
              IR heat · {irFlightWhen(irFlight, fire?.timezone ?? null).label}
            </div>
            <IrHeatLegend heatTypes={irFlight.heat_types} />
          </div>
        )}
        {showVeg && (
          <div>
            <div className="rd-legendbar-caption">Vegetation</div>
            <VegetationLegend />
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
    </details>
  );
}
