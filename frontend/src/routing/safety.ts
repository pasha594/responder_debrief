/**
 * Route safety checks on lon/lat geometry (pure): does a line enter the
 * latest perimeter, and how old is that perimeter. Planar in degrees with a
 * cos(lat) x-scale — fine at fire scale.
 */
export type LonLat = [number, number];
export type PolygonRings = LonLat[][];

/** Even-odd point-in-polygon over all rings (holes stay out). Planar, so it
 * also serves grid coordinates (engine.ts). */
export function pointInRings(p: LonLat, rings: PolygonRings): boolean {
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

type Box = [number, number, number, number];

function bboxOf(pts: LonLat[]): Box {
  let w = Infinity, so = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of pts) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < so) so = y;
    if (y > n) n = y;
  }
  return [w, so, e, n];
}

const overlaps = (a: Box, b: Box) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/** True when the line enters the polygon: a segment crosses a ring, or (no
 * crossing at all) its first vertex is inside. Ring segments are bucketed
 * on a grid over the line's box, so a 2k-vertex route against a 100k-vertex
 * perimeter stays fast on the main thread. */
export function crossesPerimeter(line: LonLat[], polygons: PolygonRings[]): boolean {
  if (line.length === 0) return false;
  const lb = bboxOf(line);
  const G = 64;
  const gw = (lb[2] - lb[0]) / G || 1e-9;
  const gh = (lb[3] - lb[1]) / G || 1e-9;
  const cellOf = (x: number, y: number): [number, number] => [
    Math.max(0, Math.min(G - 1, Math.floor((x - lb[0]) / gw))),
    Math.max(0, Math.min(G - 1, Math.floor((y - lb[1]) / gh))),
  ];
  for (const poly of polygons) {
    const outer = poly[0];
    if (!outer || !overlaps(lb, bboxOf(outer))) continue;
    const buckets = new Map<number, [LonLat, LonLat][]>();
    for (const ring of poly) {
      for (let k = 0; k + 1 < ring.length; k++) {
        const a = ring[k];
        const b = ring[k + 1];
        const sb: Box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
        if (!overlaps(sb, lb)) continue;
        const [c0, r0] = cellOf(sb[0], sb[1]);
        const [c1, r1] = cellOf(sb[2], sb[3]);
        for (let r = r0; r <= r1; r++) {
          for (let c = c0; c <= c1; c++) {
            const key = r * G + c;
            let lst = buckets.get(key);
            if (!lst) buckets.set(key, (lst = []));
            lst.push([a, b]);
          }
        }
      }
    }
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i];
      const b = line[i + 1];
      const [c0, r0] = cellOf(Math.min(a[0], b[0]), Math.min(a[1], b[1]));
      const [c1, r1] = cellOf(Math.max(a[0], b[0]), Math.max(a[1], b[1]));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          for (const [p, q] of buckets.get(r * G + c) ?? []) if (segmentsCross(a, b, p, q)) return true;
        }
      }
    }
    if (pointInRings(line[0], poly)) return true;
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
