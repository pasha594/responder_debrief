/**
 * "Is this detection near the fire?" — pure. The timeline's hotspot graph
 * counts only detections within NEAR_FIRE_M of the fire's latest perimeter
 * (or of its origin before a perimeter exists). The fetched hotspots cover
 * a box about 1.5° wide, which also holds other fires and industrial heat.
 *
 * A perimeter can carry tens of thousands of vertices and a fire hundreds of
 * thousands of detections, so the test is a grid mask built once per
 * perimeter: the polygon is filled, then every boundary cell stamps a disk
 * of the radius around itself. Each detection is then one array lookup.
 * Cells are at most ~1/40 of the radius, so the edge of the band is off by
 * a cell at worst.
 */

/** 3 miles. */
export const NEAR_FIRE_M = 3 * 1609.344;

export type NearTest = (lon: number, lat: number) => boolean;

type Geometry = GeoJSON.Polygon | GeoJSON.MultiPolygon;

const M_PER_DEG = 111_320;
/** Longest grid side in cells; a mega fire gets ~250 m cells. */
const GRID_MAX = 512;
const MIN_CELL_M = 100;

/** Within `radiusM` of [lon, lat]. */
export function nearPoint(origin: [number, number], radiusM: number): NearTest {
  const [lon0, lat0] = origin;
  const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  const r2 = radiusM * radiusM;
  return (lon, lat) => {
    const dx = (lon - lon0) * kx;
    const dy = (lat - lat0) * M_PER_DEG;
    return dx * dx + dy * dy <= r2;
  };
}

/** Inside the polygon or within `radiusM` of its boundary. Null when the
 * geometry has no usable ring. */
export function nearPolygon(geometry: Geometry, radiusM: number): NearTest | null {
  const polys: GeoJSON.Position[][][] =
    geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const rings = polys.flat().filter((r) => r.length >= 3);
  if (!rings.length) return null;

  // Local equirectangular plane, metres, centred on the perimeter's box.
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  const lon0 = (minLon + maxLon) / 2;
  const lat0 = (minLat + maxLat) / 2;
  const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  const px = (lon: number) => (lon - lon0) * kx;
  const py = (lat: number) => (lat - lat0) * M_PER_DEG;

  const pad = radiusM * 1.05;
  const x0 = px(minLon) - pad;
  const y0 = py(minLat) - pad;
  const spanX = px(maxLon) + pad - x0;
  const spanY = py(maxLat) + pad - y0;
  const cell = Math.max(MIN_CELL_M, Math.max(spanX, spanY) / GRID_MAX);
  const nx = Math.ceil(spanX / cell);
  const ny = Math.ceil(spanY / cell);
  const mask = new Uint8Array(nx * ny);
  const edge = new Uint8Array(nx * ny);

  // Project once: flat [x0, y0, x1, y1, ...] per ring, grouped by polygon.
  const projected = polys.map((poly) =>
    poly.filter((r) => r.length >= 3).map((ring) => {
      const out = new Float64Array(ring.length * 2);
      ring.forEach(([lon, lat], i) => {
        out[2 * i] = px(lon);
        out[2 * i + 1] = py(lat);
      });
      return out;
    }),
  );

  // Fill: scanline at each row's centre, even-odd within each polygon so
  // holes stay open; polygons OR together.
  const xs: number[] = [];
  for (const poly of projected) {
    if (!poly.length) continue;
    let lo = Infinity, hi = -Infinity;
    for (let i = 1; i < poly[0].length; i += 2) {
      lo = Math.min(lo, poly[0][i]);
      hi = Math.max(hi, poly[0][i]);
    }
    const j0 = Math.max(0, Math.floor((lo - y0) / cell));
    const j1 = Math.min(ny - 1, Math.ceil((hi - y0) / cell));
    for (let j = j0; j <= j1; j++) {
      const y = y0 + (j + 0.5) * cell;
      xs.length = 0;
      for (const ring of poly) {
        const n = ring.length / 2;
        for (let i = 0, k = n - 1; i < n; k = i++) {
          const ya = ring[2 * k + 1];
          const yb = ring[2 * i + 1];
          if ((ya > y) === (yb > y)) continue;
          const xa = ring[2 * k];
          xs.push(xa + ((y - ya) / (yb - ya)) * (ring[2 * i] - xa));
        }
      }
      xs.sort((a, b) => a - b);
      for (let m = 0; m + 1 < xs.length; m += 2) {
        const c0 = Math.max(0, Math.ceil((xs[m] - x0) / cell - 0.5));
        const c1 = Math.min(nx - 1, Math.floor((xs[m + 1] - x0) / cell - 0.5));
        if (c1 >= c0) mask.fill(1, j * nx + c0, j * nx + c1 + 1);
      }
    }
  }

  // Boundary cells, sampled every half cell along each edge (a sliver
  // narrower than a cell still gets its band). Rings are closed (GeoJSON),
  // and the k→i walk closes them anyway.
  for (const ring of projected.flat()) {
    const n = ring.length / 2;
    for (let i = 0, k = n - 1; i < n; k = i++) {
      const xa = ring[2 * k], ya = ring[2 * k + 1];
      const xb = ring[2 * i], yb = ring[2 * i + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(xb - xa, yb - ya) / (cell / 2)));
      for (let s = 0; s <= steps; s++) {
        const c = Math.floor((xa + ((xb - xa) * s) / steps - x0) / cell);
        const r = Math.floor((ya + ((yb - ya) * s) / steps - y0) / cell);
        if (c >= 0 && c < nx && r >= 0 && r < ny) edge[r * nx + c] = 1;
      }
    }
  }

  // Each boundary cell stamps a disk of the radius, one row span at a time.
  const rc = radiusM / cell;
  const ri = Math.floor(rc);
  const halfWidth = Array.from({ length: ri + 1 }, (_, dy) =>
    Math.floor(Math.sqrt(rc * rc - dy * dy)),
  );
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      if (!edge[r * nx + c]) continue;
      for (let dy = -ri; dy <= ri; dy++) {
        const rr = r + dy;
        if (rr < 0 || rr >= ny) continue;
        const hw = halfWidth[Math.abs(dy)];
        mask.fill(1, rr * nx + Math.max(0, c - hw), rr * nx + Math.min(nx - 1, c + hw) + 1);
      }
    }
  }

  return (lon, lat) => {
    const c = Math.floor((px(lon) - x0) / cell);
    const r = Math.floor((py(lat) - y0) / cell);
    return c >= 0 && c < nx && r >= 0 && r < ny && mask[r * nx + c] === 1;
  };
}
