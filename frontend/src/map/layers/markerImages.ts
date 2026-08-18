/**
 * Shared canvas-generated marker images: teardrop fire pins (wildfire /
 * prescribed, plus -selected variants) and the flat-top hexagon SDF used by
 * the hotspot layer. Colors come from the fire-data tokens (with hex
 * fallbacks matching tokens.css).
 */
import type { Map as MlMap } from 'maplibre-gl';

export const PIN_WILDFIRE = 'rd-pin-wildfire';
export const PIN_PRESCRIBED = 'rd-pin-prescribed';
export const PIN_WILDFIRE_SELECTED = 'rd-pin-wildfire-selected';
export const PIN_PRESCRIBED_SELECTED = 'rd-pin-prescribed-selected';
export const HEX_IMAGE = 'rd-hex';
export const WIND_ARROW_IMAGE = 'rd-wind-arrow';

const PIXEL_RATIO = 2;

/** Read a fire-data color token off :root, with a spec-hex fallback. */
function tokenColor(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

interface RawImage {
  data: ImageData;
  pixelRatio: number;
}

/**
 * Teardrop pin: circular head tapering to a bottom tip (anchor: bottom).
 * ~40x52 CSS px (2x canvas); selected variant slightly larger with a white
 * ring so the active fire reads instantly.
 */
function drawPin(fill: string, selected: boolean): RawImage | null {
  const w = selected ? 46 : 40;
  const h = selected ? 60 : 52;
  const canvas = document.createElement('canvas');
  canvas.width = w * PIXEL_RATIO;
  canvas.height = h * PIXEL_RATIO;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(PIXEL_RATIO, PIXEL_RATIO);

  const cx = w / 2;
  const r = w * 0.36; // head radius
  const cy = r + 3.5; // head center (top padding for ring/shadow)
  const tipY = h - 2.5; // tip near bottom edge (bottom anchor)

  const p = new Path2D();
  p.moveTo(cx, tipY);
  p.quadraticCurveTo(cx - r * 0.92, cy + r * 0.85, cx - r, cy);
  // top semicircle: left → top → right (canvas y-down, clockwise sweep)
  p.arc(cx, cy, r, Math.PI, 0, false);
  p.quadraticCurveTo(cx + r * 0.92, cy + r * 0.85, cx, tipY);
  p.closePath();

  if (selected) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke(p);
  }

  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = fill;
  ctx.fill(p);
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  ctx.lineWidth = 1.25;
  ctx.strokeStyle = 'rgba(35, 18, 25, 0.55)'; // subtle dark stroke
  ctx.stroke(p);

  // small dark core dot for legibility on light terrain
  ctx.fillStyle = 'rgba(35, 18, 25, 0.35)';
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.3, 0, Math.PI * 2);
  ctx.fill();

  return {
    data: ctx.getImageData(0, 0, canvas.width, canvas.height),
    pixelRatio: PIXEL_RATIO,
  };
}

/** Signed distance (px, + outside) to a flat-top hexagon of radius r. */
function hexDist(px: number, py: number, r: number): number {
  const kx = -0.866025404;
  const ky = 0.5;
  const kz = 0.577350269;
  let x = Math.abs(px);
  let y = Math.abs(py);
  const d = 2 * Math.min(kx * x + ky * y, 0);
  x -= d * kx;
  y -= d * ky;
  x -= Math.min(Math.max(x, -kz * r), kz * r);
  y -= r;
  return Math.sign(y) * Math.sqrt(x * x + y * y);
}

/**
 * Flat-top hexagon as an SDF image (tinted at render time via icon-color).
 * tiny-sdf-style encoding: edge at alpha 0.75, radius 8 px, cutoff 0.25.
 */
function drawHexSdf(): RawImage {
  const size = 64; // canvas px (2x of a 32 CSS-px icon)
  const r = 20; // hexagon radius in canvas px
  const sdfRadius = 8;
  const cutoff = 0.25;
  const img = new ImageData(size, size);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = hexDist(x - c, y - c, r);
      const a = Math.round(255 - 255 * (dist / sdfRadius + cutoff));
      img.data[(y * size + x) * 4 + 3] = Math.max(0, Math.min(255, a));
    }
  }
  return { data: img, pixelRatio: PIXEL_RATIO };
}

/** Signed distance (px, + outside) to an axis-aligned box of half-extents (bx, by). */
function boxDist(px: number, py: number, bx: number, by: number): number {
  const dx = Math.abs(px) - bx;
  const dy = Math.abs(py) - by;
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(dx, dy), 0);
}

/** Signed distance to an isoceles triangle: apex up at (0, -h/2), base at +h/2. */
function triDist(px: number, py: number, halfBase: number, h: number): number {
  // Vertices: apex A(0, -h/2), base B(-halfBase, h/2), C(halfBase, h/2).
  const x = Math.abs(px); // symmetric about the vertical axis
  const ax = 0;
  const ay = -h / 2;
  const cx = halfBase;
  const cy = h / 2;
  // Distance to the two edges that matter on the right half: A→C and base C→C'.
  const segDist = (x1: number, y1: number, x2: number, y2: number): number => {
    const vx = x2 - x1;
    const vy = y2 - y1;
    const wx = x - x1;
    const wy = py - y1;
    const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
    const dx = wx - t * vx;
    const dy = wy - t * vy;
    return Math.sqrt(dx * dx + dy * dy);
  };
  const d = Math.min(segDist(ax, ay, cx, cy), segDist(cx, cy, 0, cy));
  // Inside test (right half): below edge A→C and above the base.
  const cross = (cx - ax) * (py - ay) - (cy - ay) * (x - ax);
  const inside = cross >= 0 && py <= cy;
  return inside ? -d : d;
}

/**
 * Slender wind arrow as an SDF (tinted via icon-color, haloed via icon-halo).
 * Points UP in icon space; icon-rotate turns it to the flow bearing. 48 px
 * canvas at 2x (24 CSS px icon): triangular head over a thin shaft.
 */
function drawArrowSdf(): RawImage {
  const size = 48;
  const sdfRadius = 6;
  const cutoff = 0.25;
  const img = new ImageData(size, size);
  const cx = (size - 1) / 2;
  // Geometry (canvas px, y down): head apex y=6 → base y=20; shaft to y=42.
  const headH = 14;
  const headHalfBase = 8;
  const headCy = 6 + headH / 2;
  const shaftHalfW = 2;
  const shaftTop = 18; // tucked slightly under the head base
  const shaftBottom = 42;
  const shaftCy = (shaftTop + shaftBottom) / 2;
  const shaftHalfH = (shaftBottom - shaftTop) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.min(
        triDist(x - cx, y - headCy, headHalfBase, headH),
        boxDist(x - cx, y - shaftCy, shaftHalfW, shaftHalfH),
      );
      const a = Math.round(255 - 255 * (dist / sdfRadius + cutoff));
      img.data[(y * size + x) * 4 + 3] = Math.max(0, Math.min(255, a));
    }
  }
  return { data: img, pixelRatio: PIXEL_RATIO };
}

function makeImage(id: string): RawImage | null {
  switch (id) {
    case PIN_WILDFIRE:
      return drawPin(tokenColor('--pin-wildfire', '#FFBB56'), false);
    case PIN_WILDFIRE_SELECTED:
      return drawPin(tokenColor('--pin-wildfire', '#FFBB56'), true);
    case PIN_PRESCRIBED:
      return drawPin(tokenColor('--pin-prescribed', '#C3B392'), false);
    case PIN_PRESCRIBED_SELECTED:
      return drawPin(tokenColor('--pin-prescribed', '#C3B392'), true);
    case HEX_IMAGE:
      return drawHexSdf();
    case WIND_ARROW_IMAGE:
      return drawArrowSdf();
    default:
      return null;
  }
}

const ALL_IDS = [
  PIN_WILDFIRE,
  PIN_WILDFIRE_SELECTED,
  PIN_PRESCRIBED,
  PIN_PRESCRIBED_SELECTED,
  HEX_IMAGE,
  WIND_ARROW_IMAGE,
];

function addIfMissing(map: MlMap, id: string): void {
  if (map.hasImage(id)) return;
  const img = makeImage(id);
  if (!img) return;
  map.addImage(id, img.data, {
    pixelRatio: img.pixelRatio,
    sdf: id === HEX_IMAGE || id === WIND_ARROW_IMAGE,
  });
}

const installed = new WeakSet<MlMap>();

/**
 * Add all rd- marker images (idempotent) and keep them alive across style
 * swaps via `styleimagemissing`. Safe to call from multiple layer mounts.
 */
export function installMarkerImages(map: MlMap): void {
  for (const id of ALL_IDS) addIfMissing(map, id);
  if (installed.has(map)) return;
  installed.add(map);
  map.on('styleimagemissing', (e: { id: string }) => {
    if (ALL_IDS.includes(e.id)) addIfMissing(map, e.id);
  });
}
