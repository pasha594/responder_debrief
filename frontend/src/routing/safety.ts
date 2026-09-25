/**
 * Route safety checks on lon/lat geometry (pure): does a line enter the
 * latest perimeter, and how old is that perimeter. Planar in degrees with a
 * cos(lat) x-scale — fine at fire scale.
 */
export type LonLat = [number, number];
export type PolygonRings = LonLat[][];

function pointInRings(p: LonLat, rings: PolygonRings): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

function segmentsCross(a: LonLat, b: LonLat, c: LonLat, d: LonLat): boolean {
  const o = (p: LonLat, q: LonLat, r: LonLat) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/** True when any vertex is inside, or any segment crosses a ring. */
export function crossesPerimeter(line: LonLat[], polygons: PolygonRings[]): boolean {
  for (const poly of polygons) {
    for (const p of line) if (pointInRings(p, poly)) return true;
    for (const ring of poly) {
      for (let i = 0; i + 1 < line.length; i++) {
        for (let k = 0; k + 1 < ring.length; k++) {
          if (segmentsCross(line[i], line[i + 1], ring[k], ring[k + 1])) return true;
        }
      }
    }
  }
  return false;
}

export function polygonsOf(geom: { type: string; coordinates: unknown } | null | undefined): PolygonRings[] {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates as PolygonRings];
  if (geom.type === 'MultiPolygon') return geom.coordinates as PolygonRings[];
  return [];
}

export function ageHours(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (nowMs - t) / 3_600_000 : null;
}

/** Metres between two lon/lat points (equirectangular; short distances). */
export function metresBetween(a: LonLat, b: LonLat): number {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dx = (b[0] - a[0]) * 111_320 * k;
  const dy = (b[1] - a[1]) * 110_540;
  return Math.hypot(dx, dy);
}
