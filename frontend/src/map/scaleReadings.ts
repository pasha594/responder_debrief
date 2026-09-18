/**
 * Dual-unit map scale math (pure — panels/ScaleBar.tsx owns the DOM). Given
 * the ground distance spanned by the widest bar we allow, pick a round
 * distance per unit system and the bar width that represents it. Same
 * rounding ladder as MapLibre's own ScaleControl (1 / 2 / 3 / 5 × 10ⁿ), so a
 * bar is never shorter than half the max width.
 */

export type ScaleUnit = 'ft' | 'mi' | 'm' | 'km';

export interface ScaleReading {
  value: number;
  unit: ScaleUnit;
  /** "5 mi", "2,000 ft" */
  label: string;
  widthPx: number;
}

export interface ScaleReadings {
  imperial: ScaleReading;
  metric: ScaleReading;
}

const FT_PER_M = 3.28084;
const FT_PER_MI = 5280;
const M_PER_KM = 1000;

/** Largest 1 / 2 / 3 / 5 × 10ⁿ that does not exceed `n` (n > 0). */
export function roundDistance(n: number): number {
  const pow10 = 10 ** Math.floor(Math.log10(n));
  const d = n / pow10;
  const step = d >= 5 ? 5 : d >= 3 ? 3 : d >= 2 ? 2 : 1;
  // pow10 < 1 only below one unit (never at this map's zoom range); the
  // round-trip through toPrecision keeps 0.3 from printing as 0.30000000000000004
  return Number((step * pow10).toPrecision(1));
}

function reading(max: number, unit: ScaleUnit, maxWidthPx: number): ScaleReading {
  const value = roundDistance(max);
  return {
    value,
    unit,
    label: `${value.toLocaleString('en-US')} ${unit}`,
    widthPx: Math.round(maxWidthPx * (value / max)),
  };
}

/**
 * `maxMeters` is the ground distance across `maxWidthPx` screen pixels.
 * Imperial reads in feet up to a mile, then miles; metric in meters up to a
 * kilometer, then kilometers.
 */
export function scaleReadings(maxMeters: number, maxWidthPx: number): ScaleReadings | null {
  if (!Number.isFinite(maxMeters) || maxMeters <= 0 || maxWidthPx <= 0) return null;
  const maxFeet = maxMeters * FT_PER_M;
  return {
    imperial:
      maxFeet > FT_PER_MI
        ? reading(maxFeet / FT_PER_MI, 'mi', maxWidthPx)
        : reading(maxFeet, 'ft', maxWidthPx),
    metric:
      maxMeters >= M_PER_KM
        ? reading(maxMeters / M_PER_KM, 'km', maxWidthPx)
        : reading(maxMeters, 'm', maxWidthPx),
  };
}

// ---------- how many meters a pixel is ----------

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
/** MapLibre's world is 512 px wide at zoom 0. */
const WORLD_PX_AT_Z0 = 512;

/** Web-mercator ground resolution at `lat` for a MapLibre zoom. */
export function metersPerPixel(lat: number, zoom: number): number {
  return (
    (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (WORLD_PX_AT_Z0 * 2 ** zoom)
  );
}

/** What the scale needs from the camera — every field is a public Map getter. */
export interface CameraState {
  lat: number;
  zoom: number;
  pitchDeg: number;
  verticalFovDeg: number;
  viewportHeightPx: number;
  /** Elevation MapLibre has the map's center pinned to (exaggerated m; 0 with no terrain). */
  centerElevationM: number;
  /** Terrain elevation above sea level under the center right now (same units). */
  groundElevationM: number;
}

export interface ScaleLock {
  /** Camera height (share of the mercator world) when the ground was last sampled. */
  cameraHeight: number;
  /** The ground elevation the scale is quoted for, held until the camera height changes. */
  groundM: number;
  /** The latitude the scale is quoted for, held until mercator stretch drifts by 1%. */
  lat: number;
}

/** Mercator stretches with latitude; below this much drift a pan is not worth a pixel. */
const LAT_DRIFT = 0.01;
/**
 * A pan keeps the camera height to ~0.05%, but MapLibre re-reads the center
 * elevation when a drag starts, and finer terrain tiles landing in between
 * step it by meters — 0.1–0.3% of the height zoomed in close. Anything a
 * person would call a zoom is far past this.
 */
const HEIGHT_CHANGE = 0.05;

/**
 * Meters per pixel that depend on how high the camera is (the zoom) and on
 * latitude — never on what the map is panned over.
 *
 * With 3D terrain on, neither of the obvious sources is pan-stable:
 *   - measuring the ground (map.unproject between two pixels — MapLibre's own
 *     ScaleControl does this) reads whatever ridge or valley sits under those
 *     pixels, so the answer jitters as terrain slides underneath;
 *   - map.getZoom() is re-based after every drag onto the elevation under the
 *     new center (the camera stays put; "zoom" is relative to that ground), so
 *     it drifts by a few percent at overview zooms and 10–20% zoomed in close
 *     over steep country.
 * What a pan cannot change is the camera's height. So: scale = camera height
 * above a reference ground ÷ the camera's reach in pixels, where the reference
 * is the ground under the center when the camera height last changed.
 * Latitude is the one honest way a pan moves the scale (mercator); it is held
 * until it matters, so panning around a fire is inert while a trip from
 * Arizona to Washington still corrects the bar.
 */
export function panStableMetersPerPixel(
  cam: CameraState,
  prev: ScaleLock | null,
): { metersPerPixel: number; lock: ScaleLock } {
  const rad = Math.PI / 180;
  // distance from camera to the center point, in pixels, projected to vertical
  const reachPx =
    (Math.cos(cam.pitchDeg * rad) * 0.5 * cam.viewportHeightPx) /
    Math.tan((cam.verticalFovDeg * rad) / 2);
  const metersPerWorld = (lat: number) => EARTH_CIRCUMFERENCE_M * Math.cos(lat * rad);
  const cameraHeight =
    (cam.centerElevationM + reachPx * metersPerPixel(cam.lat, cam.zoom)) / metersPerWorld(cam.lat);

  const heightChanged =
    !prev || Math.abs(cameraHeight / prev.cameraHeight - 1) > HEIGHT_CHANGE;
  // groundM 0 also means "sampled before the terrain tiles arrived" — retry.
  const groundM = heightChanged || prev.groundM === 0 ? cam.groundElevationM : prev.groundM;
  const latDrifted =
    !!prev && Math.abs(metersPerWorld(cam.lat) / metersPerWorld(prev.lat) - 1) > LAT_DRIFT;
  const lat = heightChanged || latDrifted ? cam.lat : prev.lat;

  return {
    // always today's camera height; only the ground and latitude are held
    metersPerPixel: (cameraHeight * metersPerWorld(lat) - groundM) / reachPx,
    lock: { cameraHeight: heightChanged ? cameraHeight : prev.cameraHeight, groundM, lat },
  };
}
