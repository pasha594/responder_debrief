/**
 * One label point per historic fire, for the always-on name + year labels.
 *
 * MapLibre can label polygons itself, but it places one label per polygon
 * piece per map tile, so a big burn scar split across tiles (or a
 * MultiPolygon with spot-fire islands) repeats its name many times, off
 * centre. Instead each fire gets a single point here, at the pole of
 * inaccessibility of its largest piece: the spot farthest from any edge,
 * which stays inside C-shaped and ragged perimeters where a centroid would
 * fall outside.
 *
 * The NIFC history also carries the same fire more than once (agency and
 * national copies, "SOUTH FORK" beside "South Fork"). Records with the same
 * name and year whose outlines overlap share one label.
 */
import type { HistoricPerimeterFC } from '../../api/nifcHistory';

type Ring = number[][];
type Polygon = Ring[];
type Bbox = [number, number, number, number];

export interface HistoricLabelFC {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: { name: string; year: string; acres: number; yearNum: number | null };
  }[];
}

function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return Math.abs(a / 2);
}

function bboxOf(ring: Ring): Bbox {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of ring) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

function segDistSq(px: number, py: number, a: number[], b: number[]): number {
  let x = a[0], y = a[1];
  let dx = b[0] - x, dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b[0];
      y = b[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = px - x;
  dy = py - y;
  return dx * dx + dy * dy;
}

/** Distance to the polygon's outline: positive inside, negative outside. */
function signedDist(x: number, y: number, polygon: Polygon): number {
  let inside = false;
  let minSq = Infinity;
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) {
        inside = !inside;
      }
      minSq = Math.min(minSq, segDistSq(x, y, a, b));
    }
  }
  return (inside ? 1 : -1) * Math.sqrt(minSq);
}

interface Cell {
  x: number;
  y: number;
  h: number; // half the cell's size
  d: number; // distance from centre to the outline
  max: number; // best distance any point in the cell could reach
}

function cell(x: number, y: number, h: number, polygon: Polygon): Cell {
  const d = signedDist(x, y, polygon);
  return { x, y, h, d, max: d + h * Math.SQRT2 };
}

/**
 * Pole of inaccessibility (Mapbox's polylabel): grid search that keeps
 * splitting only the cells that could still beat the best point found,
 * to within `precision` in the polygon's units.
 */
export function poleOfInaccessibility(polygon: Polygon, precision: number): [number, number] {
  const [w, s, e, n] = bboxOf(polygon[0]);
  const size = Math.min(e - w, n - s);
  if (size === 0) return [w, s];

  // ascending by `max`, so pop() takes the most promising cell
  const queue: Cell[] = [];
  const push = (c: Cell) => {
    let lo = 0, hi = queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (queue[mid].max < c.max) lo = mid + 1;
      else hi = mid;
    }
    queue.splice(lo, 0, c);
  };

  const h0 = size / 2;
  for (let x = w; x < e; x += size) {
    for (let y = s; y < n; y += size) push(cell(x + h0, y + h0, h0, polygon));
  }
  let best = cell(w + (e - w) / 2, s + (n - s) / 2, 0, polygon);
  while (queue.length) {
    const c = queue.pop()!;
    if (c.d > best.d) best = c;
    if (c.max - best.d <= precision) continue;
    const h = c.h / 2;
    push(cell(c.x - h, c.y - h, h, polygon));
    push(cell(c.x + h, c.y - h, h, polygon));
    push(cell(c.x - h, c.y + h, h, polygon));
    push(cell(c.x + h, c.y + h, h, polygon));
  }
  return [best.x, best.y];
}

/** Label spot for a Polygon/MultiPolygon: inside its largest piece. */
export function labelPoint(geometry: { type: string; coordinates: unknown }): [number, number] | null {
  let polygons: Polygon[];
  if (geometry.type === 'Polygon') polygons = [geometry.coordinates as Polygon];
  else if (geometry.type === 'MultiPolygon') polygons = geometry.coordinates as Polygon[];
  else return null;
  let largest: Polygon | null = null;
  let largestArea = -1;
  for (const p of polygons) {
    if (!p[0] || p[0].length < 3) continue;
    const a = ringArea(p[0]);
    if (a > largestArea) {
      largest = p;
      largestArea = a;
    }
  }
  if (!largest) return null;

  // Search in locally-square units (longitude shrinks with latitude), or the
  // "middle" leans toward the east-west axis.
  const [w, s, e, n] = bboxOf(largest[0]);
  const k = Math.cos((((s + n) / 2) * Math.PI) / 180);
  const scaled = largest.map((ring) => ring.map(([x, y]) => [x * k, y]));
  const precision = Math.max((e - w) * k, n - s) / 100;
  const [x, y] = poleOfInaccessibility(scaled, precision);
  return [x / k, y];
}

function geometryBbox(geometry: { type: string; coordinates: unknown }): Bbox {
  const outers =
    geometry.type === 'Polygon'
      ? [(geometry.coordinates as Polygon)[0]]
      : (geometry.coordinates as Polygon[]).map((p) => p[0]);
  const b: Bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const ring of outers) {
    if (!ring) continue;
    const [w, s, e, n] = bboxOf(ring);
    b[0] = Math.min(b[0], w);
    b[1] = Math.min(b[1], s);
    b[2] = Math.max(b[2], e);
    b[3] = Math.max(b[3], n);
  }
  return b;
}

const overlaps = (a: Bbox, b: Bbox) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const allCaps = (s: string) => s === s.toUpperCase() && s !== s.toLowerCase();

/** One labelled point per fire, largest fires first. */
export function historicLabelPoints(fc: HistoricPerimeterFC): HistoricLabelFC {
  const byAcres = fc.features
    .filter((f) => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'))
    .map((f) => ({ f, acres: Number(f.properties?.GIS_ACRES) || 0 }))
    .sort((a, b) => b.acres - a.acres);

  const kept: { key: string; bbox: Bbox; out: HistoricLabelFC['features'][number] }[] = [];
  for (const { f, acres } of byAcres) {
    const name = (f.properties?.INCIDENT ?? '').trim();
    const yearNum = f.properties?.FIRE_YEAR_INT ?? null;
    const key = `${name.toLowerCase()}|${yearNum ?? ''}`;
    const bbox = geometryBbox(f.geometry);
    const twin = kept.find((k) => k.key === key && overlaps(k.bbox, bbox));
    if (twin) {
      // a duplicate record: keep the bigger outline's spot, but prefer the
      // copy whose name isn't shouted
      if (allCaps(twin.out.properties.name) && !allCaps(name)) twin.out.properties.name = name;
      continue;
    }
    const at = labelPoint(f.geometry);
    if (!at) continue;
    kept.push({
      key,
      bbox,
      out: {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: at },
        properties: { name, year: yearNum == null ? '' : String(yearNum), acres, yearNum },
      },
    });
  }
  return { type: 'FeatureCollection', features: kept.map((k) => k.out) };
}
