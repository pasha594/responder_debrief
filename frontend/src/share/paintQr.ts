/**
 * Paint a QR code into a canvas, crisp at any size: whole device pixels per
 * module, dark runs merged into single rects. Always black on white, whatever
 * the app theme — readers expect it, and the white border is the quiet zone
 * the standard asks for.
 */
import type { Bitmap2D } from 'lean-qr';

const QUIET = 4; // modules of white around the code

export function paintQr(canvas: HTMLCanvasElement, code: Bitmap2D, cssPx: number): void {
  const modules = code.size + QUIET * 2;
  const scale = Math.max(1, Math.floor((cssPx * (window.devicePixelRatio || 1)) / modules));
  const px = modules * scale;
  if (canvas.width !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000';
  for (let y = 0; y < code.size; y++) {
    let run = -1;
    for (let x = 0; x <= code.size; x++) {
      const on = x < code.size && code.get(x, y);
      if (on && run < 0) run = x;
      if (!on && run >= 0) {
        ctx.fillRect((run + QUIET) * scale, (y + QUIET) * scale, (x - run) * scale, scale);
        run = -1;
      }
    }
  }
}
