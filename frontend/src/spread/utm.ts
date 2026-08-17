/**
 * UTM → WGS84 inverse, hand-rolled (no proj4): standard Snyder series
 * expansion on the WGS84 ellipsoid. Accuracy is sub-meter inside a UTM zone —
 * far below the 30 m pixel size of the archive grids. Used to corner-pin the
 * decoded rasters onto the MapLibre canvas source.
 */

const A = 6378137; // WGS84 semi-major axis
const F = 1 / 298.257223563;
const K0 = 0.9996;
const E0 = 500000; // false easting
const N0_SOUTH = 10000000; // false northing, southern hemisphere

const E2 = F * (2 - F); // first eccentricity squared
const EP2 = E2 / (1 - E2); // second eccentricity squared
const E1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));

/** EPSG 326xx/327xx → zone + hemisphere; null for anything else. */
export function epsgToUtm(epsg: number): { zone: number; northern: boolean } | null {
  const base = Math.floor(epsg / 100);
  const zone = epsg % 100;
  if (zone < 1 || zone > 60) return null;
  if (base === 326) return { zone, northern: true };
  if (base === 327) return { zone, northern: false };
  return null;
}

/** Central meridian of a UTM zone, degrees. */
export function zoneCentralMeridian(zone: number): number {
  return zone * 6 - 183;
}

/** UTM easting/northing (meters) → [lon, lat] degrees (WGS84). */
export function utmToLonLat(
  easting: number,
  northing: number,
  zone: number,
  northern = true,
): [number, number] {
  const x = easting - E0;
  const y = northern ? northing : northing - N0_SOUTH;

  // Footpoint latitude from the meridian arc.
  const m = y / K0;
  const mu = m / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 * E2 * E2) / 256));
  const phi1 =
    mu +
    ((3 * E1) / 2 - (27 * E1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * E1 ** 2) / 16 - (55 * E1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * E1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * E1 ** 4) / 512) * Math.sin(8 * mu);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);

  const c1 = EP2 * cosPhi1 * cosPhi1;
  const t1 = tanPhi1 * tanPhi1;
  const oneMinusE2Sin2 = 1 - E2 * sinPhi1 * sinPhi1;
  const n1 = A / Math.sqrt(oneMinusE2Sin2);
  const r1 = (A * (1 - E2)) / Math.pow(oneMinusE2Sin2, 1.5);
  const d = x / (n1 * K0);

  const lat =
    phi1 -
    ((n1 * tanPhi1) / r1) *
      ((d * d) / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * EP2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * EP2 - 3 * c1 * c1) * d ** 6) / 720);
  const lon =
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * EP2 + 24 * t1 * t1) * d ** 5) / 120) /
    cosPhi1;

  const deg = 180 / Math.PI;
  return [zoneCentralMeridian(zone) + lon * deg, lat * deg];
}

/** MapLibre image/canvas source corner order: TL, TR, BR, BL ([lon, lat]). */
export type Corners = [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
];

/**
 * Convert a UTM bbox ([minX, minY, maxX, maxY], geotiff getBoundingBox order)
 * to WGS84: all 4 corners inverted independently (the projected rectangle is
 * NOT axis-aligned in lon/lat) → MapLibre corner-pin coordinates + the
 * enclosing [w, s, e, n] bounds.
 */
export function utmBoundsTo4326(
  bbox: [number, number, number, number],
  zone: number,
  northern = true,
): { corners: Corners; bounds: [number, number, number, number] } {
  const [minX, minY, maxX, maxY] = bbox;
  const tl = utmToLonLat(minX, maxY, zone, northern);
  const tr = utmToLonLat(maxX, maxY, zone, northern);
  const br = utmToLonLat(maxX, minY, zone, northern);
  const bl = utmToLonLat(minX, minY, zone, northern);
  const corners: Corners = [tl, tr, br, bl];
  const lons = corners.map((c) => c[0]);
  const lats = corners.map((c) => c[1]);
  return {
    corners,
    bounds: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
  };
}
