/** Geometry + coordinate utilities. The only place bbox/coord conventions live. */

/**
 * The fire API's /hotspots bbox is LAT-FIRST (min_lat,min_lon,max_lat,max_lon)
 * — opposite of GeoJSON order. This named-field type + serializer make the
 * silent-empty-result bug unrepresentable. Never pass arrays around.
 */
export interface LatFirstBbox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export function bboxParam(b: LatFirstBbox): string {
  return `${b.minLat},${b.minLon},${b.maxLat},${b.maxLon}`;
}

/** [w, s, e, n] in EPSG:4326 — the convention used by worker catalogs. */
export type Bounds4326 = [number, number, number, number];

export function boundsToLatFirst(b: Bounds4326): LatFirstBbox {
  const [w, s, e, n] = b;
  return { minLat: s, minLon: w, maxLat: n, maxLon: e };
}

/** Pad bounds by a fraction of their size (e.g. 0.2 = 20%). */
export function padBounds(b: Bounds4326, frac: number): Bounds4326 {
  const [w, s, e, n] = b;
  const dx = (e - w) * frac;
  const dy = (n - s) * frac;
  return [w - dx, Math.max(-85, s - dy), e + dx, Math.min(85, n + dy)];
}

/** Snap bounds outward to a degree grid (cache-friendly hotspot queries). */
export function snapBoundsOut(b: Bounds4326, grid: number): Bounds4326 {
  const [w, s, e, n] = b;
  return [
    Math.floor(w / grid) * grid,
    Math.floor(s / grid) * grid,
    Math.ceil(e / grid) * grid,
    Math.ceil(n / grid) * grid,
  ];
}

/**
 * Parse the fire API's `fire_coordinates` "lat, lon" STRING.
 * Returns GeoJSON-ordered [lon, lat], or null when unparseable.
 * This is the ONLY place that string is interpreted.
 */
export function parseFireCoordinates(s: string | null | undefined): [number, number] | null {
  if (!s) return null;
  const parts = s.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return null;
  const [lat, lon] = parts;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return [lon, lat];
}

// ---------- Web mercator (EPSG:3857) ----------

const R = 6378137;
const MAX_LAT = 85.051129;

export function lonLatTo3857(lon: number, lat: number): [number, number] {
  const clampedLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const x = (lon * Math.PI * R) / 180;
  const y = R * Math.log(Math.tan(Math.PI / 4 + (clampedLat * Math.PI) / 360));
  return [x, y];
}

/** [w,s,e,n] 4326 → [minX,minY,maxX,maxY] 3857. */
export function bounds4326To3857(b: Bounds4326): [number, number, number, number] {
  const [minX, minY] = lonLatTo3857(b[0], b[1]);
  const [maxX, maxY] = lonLatTo3857(b[2], b[3]);
  return [minX, minY, maxX, maxY];
}

/**
 * Pixel dimensions for a mercator bbox at a max edge length, aspect-correct.
 */
export function frameDims(
  merc: [number, number, number, number],
  maxDim: number,
): { width: number; height: number } {
  const w = merc[2] - merc[0];
  const h = merc[3] - merc[1];
  if (w <= 0 || h <= 0) return { width: maxDim, height: maxDim };
  if (w >= h) {
    return { width: maxDim, height: Math.max(1, Math.round((maxDim * h) / w)) };
  }
  return { width: Math.max(1, Math.round((maxDim * w) / h)), height: maxDim };
}

/**
 * Image-source corner coordinates for MapLibre from [w,s,e,n] bounds:
 * [top-left, top-right, bottom-right, bottom-left] as [lon, lat].
 */
export function boundsToImageCoords(
  b: Bounds4326,
): [[number, number], [number, number], [number, number], [number, number]] {
  const [w, s, e, n] = b;
  return [
    [w, n],
    [e, n],
    [e, s],
    [w, s],
  ];
}

/** Hotspot acq_date "YYYY-MM-DD" + acq_time "421.0"/"1735.0" (HHMM UTC) → epoch ms. */
export function hotspotAcqTs(acqDate: string, acqTime: string): number {
  const hhmm = String(Math.trunc(Number(acqTime) || 0)).padStart(4, '0');
  const hh = hhmm.slice(0, 2);
  const mm = hhmm.slice(2, 4);
  return Date.parse(`${acqDate}T${hh}:${mm}:00Z`);
}
