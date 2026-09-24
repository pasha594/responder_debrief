/**
 * Canvas side of the Draw tab's NWCG symbology: paints the generated shapes
 * into MapLibre icons (one per repeating mark / end marker), gives the black
 * point icons their halo, and draws the palette's line previews. Images are
 * produced on demand from `styleimagemissing`, so they survive style swaps.
 */
import type { Map as MlMap } from 'maplibre-gl';
import type { NwcgLinePart, NwcgShape } from '../nwcg/symbology.gen';
import {
  HALO_COLOR,
  HALO_PT,
  IMAGE_DPR,
  POINT_IMAGE_PREFIX,
  PX_PER_PT,
  markDistances,
  patternTileMetrics,
  plannedPartForImage,
} from './drawPlan';
import { DRAW_SYMBOLS, type DrawLineStyle, type DrawSymbol } from './drawSymbols';

type MarksPart = Extract<NwcgLinePart, { kind: 'marks' }>;
type EndsPart = Extract<NwcgLinePart, { kind: 'ends' }>;

const paths = new Map<string, Path2D>();
function path2d(d: string): Path2D {
  let p = paths.get(d);
  if (!p) {
    p = new Path2D(d);
    paths.set(d, p);
  }
  return p;
}

/** Paint shapes in the context's current frame (units: points). */
function paintShapes(ctx: CanvasRenderingContext2D, shapes: NwcgShape[]): void {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = HALO_COLOR;
  for (const s of shapes) {
    if (!s.halo) continue;
    ctx.lineWidth = (s.stroke ? (s.width ?? 1) : 0) + 2 * HALO_PT;
    ctx.stroke(path2d(s.d));
  }
  for (const s of shapes) {
    const p = path2d(s.d);
    if (s.fill) {
      ctx.fillStyle = s.fill;
      ctx.fill(p, 'evenodd');
    }
    if (s.stroke) {
      ctx.strokeStyle = s.stroke;
      ctx.lineWidth = s.width ?? 1;
      ctx.lineCap = s.cap ?? 'round';
      ctx.lineJoin = s.join ?? 'round';
      ctx.stroke(p);
    }
  }
}

function canvas2d(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] | null {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  return ctx ? [c, ctx] : null;
}

/** One period of a continuous mark, centred on the line, repeating along it. */
function patternTile(part: MarksPart): { data: ImageData; pixelRatio: number } | null {
  const m = patternTileMetrics(part);
  const made = canvas2d(m.widthDev, m.heightDev);
  if (!made) return null;
  const [, ctx] = made;
  const k = m.pixelRatio * PX_PER_PT; // device px per pt
  const [x0, , x1] = part.box;
  for (const at of part.at) {
    // copies that spill over either tile edge wrap in from the other side
    for (let n = Math.floor((-x1 - at) / part.period); at + n * part.period + x0 < part.period; n++) {
      // MapLibre lays a pattern's bottom row along the LEFT of travel, so the
      // tile is mirrored: our +y (right of travel) goes up.
      ctx.setTransform(k, 0, 0, -k, (at + n * part.period) * k, m.heightDev / 2);
      paintShapes(ctx, part.shapes);
    }
  }
  return { data: ctx.getImageData(0, 0, m.widthDev, m.heightDev), pixelRatio: m.pixelRatio };
}

/** A mark drawn around its anchor (symbol layers centre icons on the anchor). */
function markIcon(part: MarksPart | EndsPart): { data: ImageData; pixelRatio: number } | null {
  const [x0, y0, x1, y1] = part.box;
  const halfW = Math.max(Math.abs(x0), Math.abs(x1)) + HALO_PT + 0.5;
  const halfH = Math.max(Math.abs(y0), Math.abs(y1)) + HALO_PT + 0.5;
  const k = IMAGE_DPR * PX_PER_PT;
  const w = 2 * Math.ceil(halfW * k);
  const h = 2 * Math.ceil(halfH * k);
  const made = canvas2d(w, h);
  if (!made) return null;
  const [, ctx] = made;
  ctx.setTransform(k, 0, 0, k, w / 2, h / 2);
  paintShapes(ctx, part.shapes);
  return { data: ctx.getImageData(0, 0, w, h), pixelRatio: IMAGE_DPR };
}

// ---------- point icons ----------

const decoded = new Map<string, HTMLImageElement>();
const waiting = new Map<string, Set<MlMap>>();

function loadIcon(sym: DrawSymbol): void {
  if (decoded.has(sym.id) || waiting.has(sym.id)) return;
  waiting.set(sym.id, new Set());
  const img = new Image();
  img.onload = () => {
    decoded.set(sym.id, img);
    for (const map of waiting.get(sym.id) ?? []) addPointIcon(map, sym);
    waiting.delete(sym.id);
  };
  img.onerror = () => waiting.delete(sym.id);
  img.src = sym.url;
}

/** The official PNG, with a light halo traced around black-bodied symbols. */
function pointIconImage(sym: DrawSymbol, img: HTMLImageElement): HTMLImageElement | ImageData | null {
  if (!sym.halo) return img;
  const r = HALO_PT * PX_PER_PT * sym.pixelRatio; // halo in image px
  const pad = Math.ceil(r) + 1;
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const sil = canvas2d(w, h);
  const out = canvas2d(w + 2 * pad, h + 2 * pad);
  if (!sil || !out) return img;
  const [silC, sctx] = sil;
  sctx.drawImage(img, 0, 0);
  sctx.globalCompositeOperation = 'source-in';
  sctx.fillStyle = '#fff';
  sctx.fillRect(0, 0, w, h);
  const [, ctx] = out;
  const ring = canvas2d(w + 2 * pad, h + 2 * pad);
  if (!ring) return img;
  const [ringC, rctx] = ring;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    rctx.drawImage(silC, pad + r * Math.cos(a), pad + r * Math.sin(a));
  }
  ctx.globalAlpha = 0.9;
  ctx.drawImage(ringC, 0, 0);
  ctx.globalAlpha = 1;
  ctx.drawImage(img, pad, pad);
  return ctx.getImageData(0, 0, w + 2 * pad, h + 2 * pad);
}

function addPointIcon(map: MlMap, sym: DrawSymbol): void {
  const id = POINT_IMAGE_PREFIX + sym.id;
  const img = decoded.get(sym.id);
  const gone = map as unknown as { _removed?: boolean; style?: unknown };
  if (!img || gone._removed || !gone.style || map.hasImage(id)) return;
  const image = pointIconImage(sym, img);
  if (image) map.addImage(id, image, { pixelRatio: sym.pixelRatio });
}

/** Start decoding every icon so the first tap on the map finds it ready. */
export function preloadPointIcons(): void {
  for (const sym of DRAW_SYMBOLS) loadIcon(sym);
}

// ---------- image provider ----------

/** Add the named draw image if it's ours; true when it was (or will be) supplied. */
export function provideDrawImage(map: MlMap, id: string): boolean {
  if (map.hasImage(id)) return true;
  if (id.startsWith(POINT_IMAGE_PREFIX)) {
    const sym = DRAW_SYMBOLS.find((s) => POINT_IMAGE_PREFIX + s.id === id);
    if (!sym) return false;
    if (decoded.has(sym.id)) addPointIcon(map, sym);
    else {
      loadIcon(sym);
      waiting.get(sym.id)?.add(map);
    }
    return true;
  }
  const hit = plannedPartForImage(id);
  if (!hit) return false;
  const { part, slot } = hit.planned;
  if (part.kind === 'stroke') return false;
  const image = part.kind === 'marks' && slot === 'pattern' ? patternTile(part) : markIcon(part);
  if (image) map.addImage(id, image.data, { pixelRatio: image.pixelRatio });
  return !!image;
}

// ---------- palette previews ----------

const PREVIEW_W = 112;
const PREVIEW_H = 36;
const previews = new Map<string, string>();

function partExtentY(part: NwcgLinePart): [number, number] {
  if (part.kind === 'stroke') {
    const half = part.width / 2 + (part.halo ? HALO_PT : 0);
    const off = part.offset ?? 0;
    return [off - half, off + half];
  }
  const halo = part.shapes.some((s) => s.halo) ? HALO_PT : 0;
  return [part.box[1] - halo, part.box[3] + halo];
}

/**
 * A straight left-to-right sample of the style, painted with the same shapes
 * the map uses (marks at the layer file's own phase). Returned as a data URL.
 */
export function linePreviewUrl(style: DrawLineStyle): string {
  const hit = previews.get(style.id);
  if (hit) return hit;
  const dpr = 2;
  const made = canvas2d(PREVIEW_W * dpr, PREVIEW_H * dpr);
  if (!made) return '';
  const [canvas, ctx] = made;
  let lo = Infinity;
  let hi = -Infinity;
  for (const part of style.parts) {
    const [a, b] = partExtentY(part);
    lo = Math.min(lo, a);
    hi = Math.max(hi, b);
  }
  const scale = Math.min(1, (PREVIEW_H - 4) / ((hi - lo) * PX_PER_PT));
  const k = PX_PER_PT * scale; // CSS px per pt
  const x0 = 8;
  const lengthPt = (PREVIEW_W - 2 * x0) / k;
  const y0 = PREVIEW_H / 2 - ((lo + hi) / 2) * k;
  const frame = (x: number, flip = false) =>
    ctx.setTransform(dpr * k * (flip ? -1 : 1), 0, 0, dpr * k * (flip ? -1 : 1), dpr * (x0 + x * k), dpr * y0);

  for (const part of style.parts) {
    if (part.kind === 'stroke') {
      frame(0);
      const off = part.offset ?? 0;
      const line = (width: number, cap: CanvasLineCap) => {
        ctx.lineWidth = width;
        ctx.lineCap = cap;
        ctx.beginPath();
        ctx.moveTo(0, off);
        ctx.lineTo(lengthPt, off);
        ctx.stroke();
      };
      ctx.lineJoin = part.join;
      ctx.setLineDash(part.dash ?? []);
      if (part.halo) {
        ctx.strokeStyle = HALO_COLOR;
        line(part.width + 2 * HALO_PT, part.dash ? 'butt' : part.cap);
      }
      ctx.strokeStyle = part.color;
      line(part.width, part.cap);
      ctx.setLineDash([]);
    } else {
      // the same positions the map uses, measured in points along the sample
      for (const { s, flip } of markDistances(part, lengthPt * PX_PER_PT)) {
        frame(s / PX_PER_PT, flip);
        paintShapes(ctx, part.shapes);
      }
    }
  }
  const url = canvas.toDataURL();
  previews.set(style.id, url);
  return url;
}
