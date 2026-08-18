/**
 * Open-Meteo point forecast for the fire origin — feeds the timeline weather
 * strip (icon / temp / wind per hour). Free, keyless, CORS-enabled; one call
 * covers the timeline's past (up to 92 days) and 16 forecast days. HRRR stays
 * the source for the map RASTER layers; this is only the point strip.
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { parseFireCoordinates } from './geo';
import { useFire, useMasterCatalog } from './queries';
import { parseOpenMeteoHourly, type HourlyWeather } from '../timeline/weatherStripModel';

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const DAY = 86_400_000;
/** Open-Meteo caps past_days at 92. */
const MAX_PAST_DAYS = 92;

interface OpenMeteoResponse {
  hourly?: {
    time: string[];
    temperature_2m: (number | null)[];
    weather_code: (number | null)[];
    wind_speed_10m: (number | null)[];
    wind_direction_10m: (number | null)[];
  };
}

async function fetchOriginWeather(
  lat: number,
  lon: number,
  pastDays: number,
): Promise<HourlyWeather[]> {
  const params = new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lon.toFixed(3),
    hourly: 'temperature_2m,weather_code,wind_speed_10m,wind_direction_10m',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    timezone: 'UTC',
    past_days: String(pastDays),
    forecast_days: '16',
  });
  const resp = await fetch(`${ENDPOINT}?${params}`);
  if (!resp.ok) throw new Error(`open-meteo ${resp.status}`);
  const body = (await resp.json()) as OpenMeteoResponse;
  if (!body.hourly) return [];
  return parseOpenMeteoHourly(body.hourly);
}

/**
 * Hourly point weather at the selected fire's origin, spanning the timeline
 * domain. Null coords (fire still loading) → query disabled, strip hidden.
 */
export function useOriginWeather(
  corneaId: string | null,
  domainStart: number,
): { data: HourlyWeather[] | undefined } {
  const { data: catalog } = useMasterCatalog();
  const { data: fire } = useFire(corneaId);

  const coords = useMemo(() => {
    const fromCatalog = catalog?.fires.find((f) => f.cornea_id === corneaId)?.coordinates;
    return fromCatalog ?? parseFireCoordinates(fire?.fire_coordinates) ?? null;
  }, [catalog, fire, corneaId]);

  const pastDays = Math.min(
    MAX_PAST_DAYS,
    Math.max(1, Math.ceil((Date.now() - domainStart) / DAY)),
  );

  // Coords rounded into the key so a catalog refresh doesn't refetch.
  const lat = coords ? Math.round(coords[1] * 1000) / 1000 : null;
  const lon = coords ? Math.round(coords[0] * 1000) / 1000 : null;

  const { data } = useQuery({
    queryKey: ['origin-weather', lat, lon, pastDays],
    queryFn: () => fetchOriginWeather(lat!, lon!, pastDays),
    enabled: lat !== null && lon !== null && !!corneaId,
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
    retry: 1,
  });
  return { data };
}
