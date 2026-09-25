/**
 * IR heat symbols drawn to match the legend printed on the NIROPS IR PDFs,
 * so the overlay and the PDF read the same: isolated heat is a black-ringed
 * red disc with a black center, possible heat a red diamond, intense heat red
 * "/" hatching, scattered heat a grid of red dots, and cloud cover / no data
 * a grey X crosshatch. Canvas-drawn at 2x; the legend chips reuse the same
 * canvases as data URLs, so the map and the key can never disagree.
 */
import type { Map as MlMap } from 'maplibre-gl';

/** The PDF legend's red and grey, sampled from it. */
export const IR_RED = '#e9381d';
export const IR_GREY = '#4e4e4e';

export const IR_IMAGES = {
  isolated: 'rd-ir-isolated',
  possible: 'rd-ir-possible',
  intense: 'rd-ir-intense',
  scattered: 'rd-ir-scattered',
  obscured: 'rd-ir-obscured',
} as const;
export type IrImageId = (typeof IR_IMAGES)[keyof typeof IR_IMAGES];

/** CSS px per side: the icon's size, or one pattern tile's. */
export const IR_IMAGE_SIZE: Record<IrImageId, number> = {
  'rd-ir-isolated': 11,
  'rd-ir-possible': 11,
  'rd-ir-intense': 9,
  'rd-ir-scattered': 7,
  'rd-ir-obscured': 12,
};

const PIXEL_RATIO = 2;
const ALL_IDS = Object.values(IR_IMAGES);

function draw(id: IrImageId): HTMLCanvasElement | null {
  const s = IR_IMAGE_SIZE[id];
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = s * PIXEL_RATIO;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(PIXEL_RATIO, PIXEL_RATIO);
  const m = s / 2;
  switch (id) {
    case IR_IMAGES.isolated:
      ctx.beginPath();
      ctx.arc(m, m, m - 0.75, 0, Math.PI * 2);
      ctx.fillStyle = IR_RED;
      ctx.fill();
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = '#000';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(m, m, 1.6, 0, Math.PI * 2);
      ctx.fillStyle = '#000';
      ctx.fill();
      break;
    case IR_IMAGES.possible:
      ctx.beginPath();
      ctx.moveTo(m, 0.5);
      ctx.lineTo(s - 0.5, m);
      ctx.lineTo(m, s - 0.5);
      ctx.lineTo(0.5, m);
      ctx.closePath();
      ctx.fillStyle = IR_RED;
      ctx.fill();
      break;
    case IR_IMAGES.intense:
    case IR_IMAGES.obscured: {
      const cross = id === IR_IMAGES.obscured;
      ctx.strokeStyle = cross ? IR_GREY : IR_RED;
      ctx.lineWidth = 1.1;
      ctx.lineCap = 'square';
      ctx.beginPath();
      // diagonals repeated one tile left and right, so the corner stubs
      // meet the neighbouring tiles' lines seamlessly
      for (const o of [-s, 0, s]) {
        ctx.moveTo(o, s);
        ctx.lineTo(o + s, 0); // "/"
        if (cross) {
          ctx.moveTo(o, 0);
          ctx.lineTo(o + s, s); // "\"
        }
      }
      ctx.stroke();
      break;
    }
    case IR_IMAGES.scattered:
      ctx.beginPath();
      ctx.arc(m, m, 1.1, 0, Math.PI * 2);
      ctx.fillStyle = IR_RED;
      ctx.fill();
      break;
  }
  return canvas;
}

const canvases = new Map<IrImageId, HTMLCanvasElement | null>();

function canvasFor(id: IrImageId): HTMLCanvasElement | null {
  if (!canvases.has(id)) canvases.set(id, draw(id));
  return canvases.get(id) ?? null;
}

/** The symbol as a data URL, for the legend chips (null outside a browser). */
export function irImageUrl(id: IrImageId): string | null {
  try {
    return canvasFor(id)?.toDataURL() ?? null;
  } catch {
    return null;
  }
}

function addIfMissing(map: MlMap, id: IrImageId): void {
  if (map.hasImage(id)) return;
  const canvas = canvasFor(id);
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;
  map.addImage(id, ctx.getImageData(0, 0, canvas.width, canvas.height), {
    pixelRatio: PIXEL_RATIO,
  });
}

const installed = new WeakSet<MlMap>();

/**
 * Add the IR symbols (idempotent) and keep them alive across basemap swaps
 * via `styleimagemissing`.
 */
export function installIrHeatImages(map: MlMap): void {
  for (const id of ALL_IDS) addIfMissing(map, id);
  if (installed.has(map)) return;
  installed.add(map);
  map.on('styleimagemissing', (e: { id: string }) => {
    if ((ALL_IDS as string[]).includes(e.id)) addIfMissing(map, e.id as IrImageId);
  });
}
