/**
 * How a Draw-tab mark becomes map features — pure (no DOM), so it's testable.
 *
 * Each line style is a bottom → top list of parts (see ../nwcg/symbology.gen):
 * solid or dashed strokes, marks repeating along the line, and end markers.
 * Strokes are native line features. Marks are placed here, one point feature
 * each, at the layer file's exact spacing measured on screen at the current
 * zoom (MapLibre's line patterns and line-placed symbols stretch up to 2x
 * between zoom levels and can't hold a phase from the start of the line).
 * The exception is marks that overlap into a continuous texture (dozer
 * crosshatch, fuel-break zigzag): separate icons pull apart where the map's
 * terrain stretches the line, so those stay a repeating line-pattern tile.
 * The parts route to a small fixed stack of map layers ("slots"), keeping
 * each style's own stacking order:
 *
 *   stroke      solid strokes (halo casings ride here too)
 *   dash        dashed strokes
 *   pattern     continuous marks, as a repeating tile
 *   marks       marks that turn with the line, and end markers
 *   stroke-top  solid strokes drawn over marks (escape route, aerial hazard, …)
 *   dash-top    dashed strokes drawn over marks (fire edge field collection)
 *   upright     marks that stay upright (hand / mixed / plow / road letters, hoselay)
 *   pt-map      point symbols that keep their heading on the map (assignment breaks)
 *   pt          point symbols (the official NWCG icons), upright on screen
 */
import type { DrawFeature } from '../../state/store';
import type { NwcgLinePart } from '../nwcg/symbology.gen';
import { drawLineById, drawSymbolById, type DrawLineStyle } from './drawSymbols';

/** NWCG sizes are points; the map draws 1 pt as 4/3 CSS px (96 dpi). */
export const PX_PER_PT = 4 / 3;
/** Light halo that lifts black NWCG ink off dark basemaps (PMS 936 allows a halo). */
export const HALO_COLOR = 'rgba(255, 255, 255, 0.9)';
export const HALO_PT = 1.1;
/** Device pixels per CSS px for generated images; decided once per page. */
export const IMAGE_DPR =
  typeof window === 'undefined'
    ? 2
    : Math.min(3, Math.max(2, Math.ceil(window.devicePixelRatio || 1)));

export type DrawSlot =
  | 'stroke'
  | 'dash'
  | 'pattern'
  | 'marks'
  | 'stroke-top'
  | 'dash-top'
  | 'upright'
  | 'pt-map'
  | 'pt';

type SlotKind = 'solid' | 'dashed' | 'pattern' | 'marks' | 'upright';

/** Bottom → top. */
export const LINE_SLOTS: { slot: DrawSlot; kind: SlotKind }[] = [
  { slot: 'stroke', kind: 'solid' },
  { slot: 'dash', kind: 'dashed' },
  { slot: 'pattern', kind: 'pattern' },
  { slot: 'marks', kind: 'marks' },
  { slot: 'stroke-top', kind: 'solid' },
  { slot: 'dash-top', kind: 'dashed' },
  { slot: 'upright', kind: 'upright' },
];

type StrokePart = Extract<NwcgLinePart, { kind: 'stroke' }>;
type MarksPart = Extract<NwcgLinePart, { kind: 'marks' }>;
type EndsPart = Extract<NwcgLinePart, { kind: 'ends' }>;

export interface PlannedPart {
  slot: DrawSlot;
  part: NwcgLinePart;
  /** Position in the style's bottom → top stack. */
  order: number;
  /** Map image for mark / end parts. */
  image?: string;
}

export const LINE_IMAGE_PREFIX = 'rd-dl-';
export const POINT_IMAGE_PREFIX = 'rd-dp-';

export function lineImageId(styleId: string, order: number): string {
  return `${LINE_IMAGE_PREFIX}${styleId}~${order}`;
}

export function pointImageId(symbolId: string): string {
  return `${POINT_IMAGE_PREFIX}${symbolId}`;
}

/** Marks close enough to overlap their neighbours read as one texture. */
export function isContinuous(part: MarksPart): boolean {
  const at = [...part.at].sort((a, b) => a - b);
  const gaps = at.map((a, i) => (i + 1 < at.length ? at[i + 1] : at[0] + part.period) - a);
  return Math.min(...gaps) < part.box[2] - part.box[0];
}

function kindOf(part: NwcgLinePart): SlotKind {
  if (part.kind === 'stroke') return part.dash ? 'dashed' : 'solid';
  if (part.kind === 'marks' && part.upright) return 'upright';
  if (part.kind === 'marks' && isContinuous(part)) return 'pattern';
  return 'marks';
}

const plans = new Map<string, PlannedPart[]>();

/** Route a style's parts to slots, bottom → top; throws if the stack can't hold it. */
export function planStyle(style: DrawLineStyle): PlannedPart[] {
  const cached = plans.get(style.id);
  if (cached) return cached;
  let cursor = 0;
  const planned = style.parts.map((part, order): PlannedPart => {
    const kind = kindOf(part);
    let i = cursor;
    while (i < LINE_SLOTS.length && LINE_SLOTS[i].kind !== kind) i++;
    if (i === LINE_SLOTS.length) {
      throw new Error(`${style.id}: no draw layer can stack part ${order} (${kind})`);
    }
    cursor = i;
    const p: PlannedPart = { slot: LINE_SLOTS[i].slot, part, order };
    if (part.kind !== 'stroke') p.image = lineImageId(style.id, order);
    return p;
  });
  plans.set(style.id, planned);
  return planned;
}

/** The planned part an image id draws. */
export function plannedPartForImage(imageId: string): { style: DrawLineStyle; planned: PlannedPart } | null {
  if (!imageId.startsWith(LINE_IMAGE_PREFIX)) return null;
  const rest = imageId.slice(LINE_IMAGE_PREFIX.length);
  const cut = rest.lastIndexOf('~');
  const style = drawLineById(rest.slice(0, cut));
  if (!style) return null;
  const planned = planStyle(style).find((p) => p.order === Number(rest.slice(cut + 1)));
  return planned ? { style, planned } : null;
}

/**
 * Pattern tile geometry: one period long, tall enough for the marks' ink and
 * halo either side of the line. The tile is sized in whole device pixels, so
 * pixelRatio is nudged to keep the period exact; line-width must equal the
 * tile's CSS height for MapLibre to draw it unscaled.
 */
export function patternTileMetrics(part: MarksPart, dpr = IMAGE_DPR) {
  const periodPx = part.period * PX_PER_PT;
  const widthDev = Math.max(1, Math.round(periodPx * dpr));
  const pixelRatio = widthDev / periodPx;
  const [, y0, , y1] = part.box;
  const halfPx = (Math.max(Math.abs(y0), Math.abs(y1)) + HALO_PT + 0.5) * PX_PER_PT;
  const heightDev = 2 * Math.ceil(halfPx * pixelRatio);
  return { widthDev, heightDev, pixelRatio, heightPx: heightDev / pixelRatio };
}

// ---------- screen geometry (Web Mercator world pixels at a zoom) ----------

/** What the marks are laid out for: the map zoom and, optionally, the visible area. */
export interface MarkView {
  zoom: number;
  /** [west, south, east, north] — marks outside (plus a margin) are skipped. */
  bounds?: [number, number, number, number];
}

type Pt = [number, number];

function project([lng, lat]: Pt, worldSize: number): Pt {
  const phi = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  return [
    ((lng + 180) / 360) * worldSize,
    ((1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2) * worldSize,
  ];
}

function unproject([x, y]: Pt, worldSize: number): Pt {
  const lng = (x / worldSize) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / worldSize;
  return [lng, (Math.atan(Math.sinh(n)) * 180) / Math.PI];
}

/** A line in world px with cumulative lengths, for walking along it. */
interface Walk {
  pts: Pt[];
  cum: number[];
  length: number;
}

function walkOf(coords: Pt[], worldSize: number): Walk {
  const pts = coords.map((c) => project(c, worldSize));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return { pts, cum, length: cum[cum.length - 1] };
}

/** Point and clockwise screen heading (degrees from east) at distance s. */
function pointAt(w: Walk, s: number): { at: Pt; heading: number } {
  let i = 1;
  while (i < w.pts.length - 1 && w.cum[i] < s) i++;
  // skip zero-length segments so the heading is defined
  let a = i - 1;
  while (a > 0 && w.cum[i] - w.cum[a] === 0) a--;
  const p0 = w.pts[a];
  const p1 = w.pts[i];
  const segLen = w.cum[i] - w.cum[a];
  const t = segLen > 0 ? Math.min(1, Math.max(0, (s - w.cum[a]) / segLen)) : 0;
  return {
    at: [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t],
    heading: (Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) * 180) / Math.PI,
  };
}

/** Distances along the line (px) where a marks / ends part puts a mark. */
export function markDistances(part: MarksPart | EndsPart, length: number): { s: number; flip: boolean }[] {
  const out: { s: number; flip: boolean }[] = [];
  if (part.kind === 'ends') {
    const inset = part.inset * PX_PER_PT;
    if (length < 2 * inset) return out;
    out.push({ s: inset, flip: part.flipFirst }, { s: length - inset, flip: false });
    return out;
  }
  const period = part.period * PX_PER_PT;
  for (const at of part.at) {
    for (let s = at * PX_PER_PT; s <= length + 1e-6; s += period) out.push({ s, flip: false });
  }
  return out.sort((a, b) => a.s - b.s);
}

// ---------- features ----------

export interface LiveStroke {
  coords: Pt[];
  styleId: string;
}

type Props = Record<string, unknown> & { fid: string; slot: DrawSlot; sort: number };

function strokeProps(part: StrokePart, casing: boolean): Record<string, unknown> {
  const width = part.width + (casing ? 2 * HALO_PT : 0);
  const props: Record<string, unknown> = {
    color: casing ? HALO_COLOR : part.color,
    width: width * PX_PER_PT,
    offset: (part.offset ?? 0) * PX_PER_PT,
    // a casing's dashes stay the ink's length, so they need square-off ends
    cap: casing && part.dash ? 'butt' : part.cap,
    join: part.join,
  };
  // MapLibre dash lengths are in line widths
  if (part.dash) props.dash = part.dash.map((d) => d / width);
  return props;
}

function lineFeatures(
  coords: Pt[],
  style: DrawLineStyle,
  fid: string,
  base: number,
  view: MarkView,
): GeoJSON.Feature[] {
  const out: GeoJSON.Feature[] = [];
  const line = { type: 'LineString', coordinates: coords } as GeoJSON.LineString;
  const push = (geometry: GeoJSON.Geometry, props: Props) =>
    out.push({ type: 'Feature', geometry, properties: props });
  const worldSize = 512 * 2 ** view.zoom;
  let walk: Walk | null = null;
  let visible: [number, number, number, number] | null = null;
  if (view.bounds) {
    const [w, s, e, n] = view.bounds;
    const [x0, y1] = project([w, s], worldSize);
    const [x1, y0] = project([e, n], worldSize);
    const pad = 64;
    visible = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  }
  for (const p of planStyle(style)) {
    const sort = base + p.order * 2 + 1;
    const { part } = p;
    if (part.kind === 'stroke') {
      if (part.halo) push(line, { fid, slot: p.slot, sort: sort - 1, ...strokeProps(part, true) });
      push(line, { fid, slot: p.slot, sort, ...strokeProps(part, false) });
      continue;
    }
    if (p.slot === 'pattern' && part.kind === 'marks') {
      push(line, { fid, slot: p.slot, pattern: p.image, width: patternTileMetrics(part).heightPx, sort });
      continue;
    }
    walk ??= walkOf(coords, worldSize);
    if (walk.length === 0) continue;
    const upright = p.slot === 'upright';
    for (const { s, flip } of markDistances(part, walk.length)) {
      const { at, heading } = pointAt(walk, s);
      if (visible && (at[0] < visible[0] || at[0] > visible[2] || at[1] < visible[1] || at[1] > visible[3])) {
        continue;
      }
      push({ type: 'Point', coordinates: unproject(at, worldSize) }, {
        fid,
        slot: p.slot,
        icon: p.image,
        // icon-rotate is clockwise from the icon's +x pointing east
        ...(upright ? {} : { rot: heading + (flip ? 180 : 0) }),
        sort,
      });
    }
  }
  return out;
}

/**
 * The marks with the most recent line of this style reversed — the side its
 * ticks or burn offset fall on swaps — or null when there is none to flip.
 */
export function flipLatestLine(features: DrawFeature[], styleId: string): DrawFeature[] | null {
  for (let i = features.length - 1; i >= 0; i--) {
    const f = features[i];
    if (f.geometry.type !== 'LineString' || drawLineById(f.properties.style)?.id !== styleId) continue;
    const flipped: DrawFeature = {
      ...f,
      geometry: { type: 'LineString', coordinates: [...f.geometry.coordinates].reverse() },
    };
    return features.map((g, j) => (j === i ? flipped : g));
  }
  return null;
}

/** Everything the draw source shows: saved marks plus the stroke being drawn. */
export function drawSourceFeatures(
  features: DrawFeature[],
  view: MarkView,
  live: LiveStroke | null = null,
): GeoJSON.Feature[] {
  const out: GeoJSON.Feature[] = [];
  features.forEach((f, i) => {
    const base = i * 64;
    if (f.geometry.type === 'Point') {
      const sym = drawSymbolById(f.properties.sym);
      if (!sym) return;
      const props = { fid: f.properties.fid, icon: pointImageId(sym.id), sort: base };
      out.push({
        type: 'Feature',
        geometry: f.geometry,
        properties: sym.rotatesWithMap
          ? { ...props, slot: 'pt-map', rot: f.properties.rot ?? 0 }
          : { ...props, slot: 'pt' },
      });
    } else {
      const style = drawLineById(f.properties.style) ?? drawLineById('sketch')!;
      out.push(...lineFeatures(f.geometry.coordinates, style, f.properties.fid, base, view));
    }
  });
  if (live && live.coords.length > 1) {
    const style = drawLineById(live.styleId) ?? drawLineById('sketch')!;
    out.push(...lineFeatures(live.coords, style, '', features.length * 64, view));
  }
  return out;
}
