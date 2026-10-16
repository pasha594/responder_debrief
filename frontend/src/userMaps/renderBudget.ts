/**
 * How many pixels a My maps import may render, decided before pdf.js loads
 * (tiny and static: the importer and the UI read these without pulling in
 * the lazy pdf.js chunk).
 *
 * The limit is memory, not canvas size. pdf.js decodes every embedded image
 * of the page at full size whatever the crop (155 MP on an ARCH E ops map,
 * 422 MP on a 72×72 in BAM) and peaks at ~4.5× the target area in scratch
 * canvases, and iOS 17+ answers an overrun with a jetsam reload of the tab,
 * which no code can catch. So phones and tablets get 12 MP, desktops 32 MP
 * (an ARCH E sheet ≈ 4000×3000 px ≈ 83 dpi on a phone, ≈ 6530×4900 px
 * ≈ 136 dpi on a desktop, close to the worker's 150 dpi sheet tiles).
 * pdfRender retries at half the budget, down to MIN_BUDGET, when the canvas
 * or the JPEG encode fails silently.
 */

/** Longest canvas side ever rendered — inside every browser's per-side limit (Chrome 65,535, Firefox ≈23,168, older Android ≈16,384). */
export const MAX_SIDE = 16384;
/** The last retry step: ~1630×1225 px for an ARCH E sheet, still readable at street zoom. */
export const MIN_BUDGET = 2e6;
/** Hard file-size limit for an import (the largest sample incident map is 25.5 MB). */
export const MAX_FILE_BYTES = 150 * 1024 * 1024;
/** Print resolution: past it a small sheet (letter, 11×17) gains nothing but memory and storage — a letter page fills 32 MP at ~790 dpi. */
export const MAX_DPI = 300;

const PHONE_BUDGET = 12e6;
const DESKTOP_BUDGET = 32e6;

/**
 * Phone or tablet: iPhone/iPad/iPod/Android user agents, plus iPadOS 13+,
 * which asks for the desktop site (a Mac UA on platform "MacIntel") and is
 * told apart only by its touch points — the same test pdf.js's own viewer
 * uses for its mobile canvas limit. Touch laptops stay on the desktop budget.
 */
export function isTouchDevice(nav: Navigator | undefined = globalThis.navigator): boolean {
  if (!nav) return false;
  if (/iPhone|iPad|iPod|Android/.test(nav.userAgent ?? '')) return true;
  return nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1;
}

/** Pixel budget for one page render on this device. */
export function pixelBudget(nav?: Navigator): number {
  return isTouchDevice(nav) ? PHONE_BUDGET : DESKTOP_BUDGET;
}

/**
 * Canvas size for a frame of frameW × frameH page points under `budget`
 * pixels: one uniform scale (page points → px) so width·height ≤ budget,
 * neither side exceeds MAX_SIDE (the side cap wins on long strip maps) and
 * the render stays at or under MAX_DPI (it wins on small sheets).
 * Sides are floored (never over budget) but at least 1 px.
 */
export function cropSize(
  frameW: number,
  frameH: number,
  budget: number,
): { width: number; height: number; scale: number } {
  if (!(frameW > 0 && frameH > 0 && Number.isFinite(frameW) && Number.isFinite(frameH))) {
    throw new RangeError(`cropSize: bad frame ${frameW}×${frameH}`);
  }
  if (!(budget >= 1 && Number.isFinite(budget))) {
    throw new RangeError(`cropSize: bad budget ${budget}`);
  }
  const scale = Math.min(
    Math.sqrt(budget / (frameW * frameH)),
    MAX_SIDE / Math.max(frameW, frameH),
    MAX_DPI / 72,
  );
  // The epsilon absorbs float error on exact products (6912 · 16384/6912 = 16383.999…).
  const side = (pts: number) => Math.min(MAX_SIDE, Math.max(1, Math.floor(pts * scale + 1e-6)));
  return { width: side(frameW), height: side(frameH), scale };
}

/**
 * The budgets a render tries in order: `budgetPx`, then halves, ending at
 * exactly MIN_BUDGET (12 MP → 6 → 3 → 2). A start at or below MIN_BUDGET is
 * tried once.
 */
export function budgetLadder(budgetPx: number): number[] {
  const out = [budgetPx];
  let b = budgetPx;
  while (b > MIN_BUDGET) {
    b = Math.max(MIN_BUDGET, b / 2);
    out.push(b);
  }
  return out;
}
