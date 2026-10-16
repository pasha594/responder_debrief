/**
 * pdf.js glue for My maps: open a user's PDF and draw one page's main map
 * frame to a JPEG (plus a list thumbnail). The only module that touches
 * pdf.js, and LAZY — app code reaches it solely through
 * `await import('./pdfRender')`, so pdf.js (+0.72 MB gz with its worker,
 * wasm and ICC profile) is fetched only when someone adds a map. vite.config.ts
 * emits this chunk and every pdf.js file under assets/pdfjs/, and
 * scripts/build-sw.mjs keeps that folder out of the precache, caching it
 * on first use instead.
 *
 * pdf.js choices (measured on 6.3.289, see the pdfjs research report):
 *  - LEGACY build: the modern one needs Safari 26.2 / Chrome 147 and throws
 *    inside page.render() below that. Two ES2024 built-ins the legacy build
 *    does not polyfill (Promise.withResolvers, ArrayBuffer
 *    transferToFixedLength — missing on iOS 17.0–17.3) are installed here
 *    before any pdf.js call, and in the worker before its pdf.js loads.
 *  - wasmUrl is mandatory: 30 of 35 sample maps carry JPEG 2000 imagery that
 *    renders white without openjpeg.wasm. pdf.js requests every wasm, its
 *    no-wasm fallback script and the ICC profile BY FIXED NAME from
 *    wasmUrl/iccUrl, which is why Vite keeps those names unhashed.
 *  - useWorkerFetch must be set by hand when cMapUrl/standardFontDataUrl are
 *    left out (else ICC colour is off); none of the samples needs either.
 *  - getDocument detaches the buffer it is given (openPdf takes ownership).
 *
 * Rendering: a canvas sized to the frame crop, not the page — the page
 * viewport shifted by the crop's top-left (offsetX/offsetY), so the
 * viewport's own transform is the exact page → image mapping. Canvas and
 * encode failures are silent in every browser (a blank canvas, a null blob,
 * or a PNG instead of a JPEG), so the canvas is probed by pixel readback
 * before rendering and the blob type is checked; any failure retries at half
 * the pixel budget down to MIN_BUDGET (renderBudget.budgetLadder).
 */
// @ts-expect-error -- the minified legacy build ships no .d.mts; it is the API typed by 'pdfjs-dist'
import * as pdfjsLegacy from 'pdfjs-dist/legacy/build/pdf.min.mjs';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import openjpegWasmUrl from 'pdfjs-dist/wasm/openjpeg.wasm?url';
import jbig2WasmUrl from 'pdfjs-dist/wasm/jbig2.wasm?url';
import qcmsWasmUrl from 'pdfjs-dist/wasm/qcms_bg.wasm?url';
import openjpegFallbackUrl from 'pdfjs-dist/wasm/openjpeg_nowasm_fallback.js?url';
import jbig2FallbackUrl from 'pdfjs-dist/wasm/jbig2_nowasm_fallback.js?url';
import iccProfileUrl from 'pdfjs-dist/iccs/CGATS001Compat-v2-micro.icc?url';
import { budgetLadder, cropSize, isTouchDevice } from './renderBudget';
import type { Affine, Box } from './types';

const { getDocument, GlobalWorkerOptions } = pdfjsLegacy as typeof import('pdfjs-dist');

export interface RenderedCrop {
  jpeg: Blob;
  thumb: Blob;
  width: number;
  height: number;
  /** Page user space → image pixels: the offset viewport's transform. */
  pageToImage: Affine;
  /** The budget that succeeded (may be below the one asked for). */
  budgetPx: number;
}

export interface OpenedPdf {
  numPages: number;
  /** Object number of the page's dict (matches pdfObjects.readPageViewports), or null when pdf.js has no ref. */
  pageObjNum(page: number): Promise<number | null>;
  /** `onAttempt` hears each budget just before it is drawn (the crash
   * breadcrumb must name the one being drawn, not the one asked for). */
  renderCrop(
    page: number,
    frame: Box,
    budgetPx: number,
    signal?: AbortSignal,
    onAttempt?: (budgetPx: number) => void,
  ): Promise<RenderedCrop>;
  /** Ends the document and terminates its worker (frees every decoded image). */
  close(): Promise<void>;
}

const JPEG_QUALITY = 0.85;
const THUMB_QUALITY = 0.8;
/** Long side of the My maps list thumbnail. */
const THUMB_PX = 112;
/**
 * Canvas area pdf.js's in-worker image downscaler may use (×4 bytes a pixel):
 * 4096² on phones/tablets (iOS 17's cap, the lowest), 2^28 on desktops
 * (Chrome's). Also spares it probing the limit with test canvases.
 */
const CANVAS_MAX_AREA_PX = isTouchDevice() ? 16_777_216 : 268_435_456;

/* ---------------------------------------------------------------------------
 * Polyfills + worker
 * ------------------------------------------------------------------------- */

/**
 * Installs the two built-ins pdf.js 6 calls that its legacy build leaves
 * unpolyfilled. Self-contained on purpose: its source text is also run in
 * the worker (polyfilledWorkerSrc). The ArrayBuffer one copies instead of
 * transferring — pdf.js only uses it to trim a buffer it then posts.
 * (pdf.js 6.3.289's main and worker modules evaluate fine without either;
 * only calls into them need these.)
 */
function installPolyfills(g: typeof globalThis): void {
  const P = g.Promise as PromiseConstructor & { withResolvers?: unknown };
  if (typeof P.withResolvers !== 'function') {
    Object.defineProperty(P, 'withResolvers', {
      configurable: true,
      writable: true,
      value: function withResolvers(this: PromiseConstructor) {
        let resolve!: (value: unknown) => void;
        let reject!: (reason?: unknown) => void;
        const promise = new this((res, rej) => {
          resolve = res;
          reject = rej;
        });
        return { promise, resolve, reject };
      },
    });
  }
  const AB = g.ArrayBuffer.prototype as ArrayBuffer & { transferToFixedLength?: unknown };
  if (typeof AB.transferToFixedLength !== 'function') {
    Object.defineProperty(AB, 'transferToFixedLength', {
      configurable: true,
      writable: true,
      value: function transferToFixedLength(this: ArrayBuffer, length?: number) {
        const n = length === undefined ? this.byteLength : length;
        const out = new ArrayBuffer(n);
        new Uint8Array(out).set(new Uint8Array(this, 0, Math.min(n, this.byteLength)));
        return out;
      },
    });
  }
}

/** Same engine on both threads: if the page lacks them, so does the worker. */
const workerNeedsPolyfills =
  typeof (Promise as { withResolvers?: unknown }).withResolvers !== 'function' ||
  typeof (ArrayBuffer.prototype as { transferToFixedLength?: unknown }).transferToFixedLength !==
    'function';
installPolyfills(globalThis);

/**
 * A module worker that installs the polyfills, then loads the real pdf.js
 * worker (pdf.js uses the same blob-wrapper trick for cross-origin workers).
 * It re-exports WorkerMessageHandler because pdf.js imports workerSrc on the
 * main thread when it can't start a Worker at all ("fake worker").
 */
function polyfilledWorkerSrc(): string {
  const real = new URL(workerUrl, location.href).href;
  const code =
    `(${installPolyfills.toString()})(self);\n` +
    `const m = await import(${JSON.stringify(real)});\n` +
    `export const WorkerMessageHandler = m.WorkerMessageHandler;\n`;
  return URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
}

GlobalWorkerOptions.workerSrc = workerNeedsPolyfills ? polyfilledWorkerSrc() : workerUrl;

/** Absolute URL of the folder a file was emitted to (pdf.js appends fixed names). */
function dirOf(url: string): string {
  return new URL('./', new URL(url, location.href)).href;
}

const WASM_DIR = dirOf(openjpegWasmUrl);
const ICC_DIR = dirOf(iccProfileUrl);
// pdf.js fetches all of these by name from WASM_DIR; a build that scatters
// them would silently render JPEG 2000 / JBIG2 imagery white.
for (const u of [jbig2WasmUrl, qcmsWasmUrl, openjpegFallbackUrl, jbig2FallbackUrl]) {
  if (dirOf(u) !== WASM_DIR) console.warn('pdfRender: pdf.js file outside wasmUrl', u);
}

/* ---------------------------------------------------------------------------
 * Errors
 * ------------------------------------------------------------------------- */

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** Thrown when every budget on the ladder failed; importMap maps it to 'render_failed'. */
function renderFailed(cause: unknown): Error {
  const err = new Error('Could not draw this page on this device', { cause });
  err.name = 'RenderFailed';
  return err;
}

/* ---------------------------------------------------------------------------
 * Canvas helpers
 * ------------------------------------------------------------------------- */

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

/** Drops the backing store now rather than at GC (matters on iOS). */
function release(c: HTMLCanvasElement): void {
  c.width = 0;
  c.height = 0;
}

/**
 * Whether the canvas really got a backing store: an over-size or
 * out-of-memory canvas still hands out a context, draws nothing and reads
 * back zeros. Uses the exact context attributes pdf.js asks for (alpha off,
 * GPU-backed with enableHWA), since a canvas keeps its first context.
 */
function canvasWorks(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
  if (!ctx) return false;
  const x = canvas.width - 1;
  const y = canvas.height - 1;
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(x, y, 1, 1);
  const px = ctx.getImageData(x, y, 1, 1).data;
  return px[0] > 127 && px[3] === 255;
}

/** JPEG or bust: Safari silently answers unsupported types with PNG, and a failed canvas with null. */
function encodeJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob && blob.type === 'image/jpeg'
          ? resolve(blob)
          : reject(new Error(`toBlob gave ${blob ? blob.type || 'untyped' : 'null'}`)),
      'image/jpeg',
      quality,
    );
  });
}

/**
 * ≤THUMB_PX JPEG of the render. Halves first while more than 2× too big:
 * one big drawImage step aliases thin map lines into noise in Safari.
 */
async function thumbnail(src: HTMLCanvasElement): Promise<Blob> {
  const k = Math.min(1, THUMB_PX / Math.max(src.width, src.height));
  const tw = Math.max(1, Math.round(src.width * k));
  const th = Math.max(1, Math.round(src.height * k));
  const temps: HTMLCanvasElement[] = [];
  const step = (from: HTMLCanvasElement, w: number, h: number) => {
    const to = makeCanvas(w, h);
    temps.push(to);
    const ctx = to.getContext('2d');
    if (!ctx) throw new Error('thumbnail canvas unavailable');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(from, 0, 0, w, h);
    if (from !== src) release(from);
    return to;
  };
  try {
    let cur = src;
    while (cur.width > tw * 2 || cur.height > th * 2) {
      cur = step(cur, Math.max(tw, Math.ceil(cur.width / 2)), Math.max(th, Math.ceil(cur.height / 2)));
    }
    return await encodeJpeg(step(cur, tw, th), THUMB_QUALITY);
  } finally {
    temps.forEach(release);
  }
}

/* ---------------------------------------------------------------------------
 * Rendering
 * ------------------------------------------------------------------------- */

/** One attempt at one budget; throws on any failure (the caller steps down). */
async function renderAt(
  page: PDFPageProxy,
  frame: Box,
  budgetPx: number,
  signal?: AbortSignal,
): Promise<RenderedCrop> {
  const [x0, y0, x1, y1] = frame;
  const size = cropSize(x1 - x0, y1 - y0, budgetPx);
  // PageViewport multiplies by /UserUnit itself; size.scale is px per user-space unit.
  const scale = size.scale / page.userUnit;
  const whole = page.getViewport({ scale });
  const corners = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ].map(([x, y]) => whole.convertToViewportPoint(x, y) as [number, number]);
  const left = Math.min(...corners.map((p) => p[0]));
  const top = Math.min(...corners.map((p) => p[1]));
  // /Rotate 90/270 pages draw the frame sideways.
  const sideways = whole.rotation % 180 !== 0;
  const width = sideways ? size.height : size.width;
  const height = sideways ? size.width : size.height;
  const viewport: PageViewport = page.getViewport({ scale, offsetX: -left, offsetY: -top });

  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = makeCanvas(width, height);
    if (!canvasWorks(canvas)) throw new Error(`canvas ${width}×${height} not allocated`);
    const task = page.render({ canvas, viewport });
    const cancel = () => task.cancel();
    signal?.addEventListener('abort', cancel);
    try {
      await task.promise;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
    throwIfAborted(signal);
    const jpeg = await encodeJpeg(canvas, JPEG_QUALITY);
    throwIfAborted(signal);
    const thumb = await thumbnail(canvas);
    const t = viewport.transform;
    return {
      jpeg,
      thumb,
      width,
      height,
      pageToImage: [t[0], t[1], t[2], t[3], t[4], t[5]],
      budgetPx,
    };
  } finally {
    if (canvas) release(canvas);
    // Frees the page's decoded images; pdf.js defers it itself while a
    // cancelled render is still winding down.
    page.cleanup();
  }
}

/**
 * Fetches the JPEG 2000 and JBIG2 decoders before any page is drawn. pdf.js
 * swallows a failed wasm fetch in its worker — the images just come out
 * white and render() still resolves, so a dropped connection would save a
 * blank map as a success. Fetched here, a failure throws "Failed to fetch"
 * (importMap reads it as offline), and the worker's own fetch moments later
 * is served from the HTTP / service-worker cache. Most maps need them anyway.
 */
async function fetchDecoders(): Promise<void> {
  await Promise.all(
    [openjpegWasmUrl, jbig2WasmUrl].map(async (url) => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(String(res.status));
        await res.arrayBuffer(); // the whole body, so it is really cached
      } catch {
        // One wording for every way it fails (Chrome's body-stream error isn't one).
        throw new TypeError(`Failed to fetch ${url}`);
      }
    }),
  );
}

/**
 * Opens a PDF. Takes ownership of `bytes`: pdf.js transfers its buffer to
 * the worker, leaving the caller's copy detached (length 0).
 */
export async function openPdf(bytes: Uint8Array): Promise<OpenedPdf> {
  const task = getDocument({
    data: bytes,
    wasmUrl: WASM_DIR,
    iccUrl: ICC_DIR,
    useWorkerFetch: true,
    // GPU-backed canvases: ~30% faster renders in Chrome (pdf.js's viewer default).
    enableHWA: true,
    canvasMaxAreaInBytes: 4 * CANVAS_MAX_AREA_PX,
    // Never maxImageSize: any limit drops whole orthophoto strips.
  });
  let doc: PDFDocumentProxy;
  try {
    [doc] = await Promise.all([task.promise, fetchDecoders()]);
  } catch (e) {
    await task.destroy().catch(() => {});
    throw e;
  }
  let closed: Promise<void> | null = null;

  return {
    numPages: doc.numPages,

    async pageObjNum(n) {
      const page = await doc.getPage(n);
      return page.ref?.num ?? null;
    },

    async renderCrop(n, frame, budgetPx, signal, onAttempt) {
      throwIfAborted(signal);
      const page = await doc.getPage(n);
      let lastError: unknown = null;
      for (const budget of budgetLadder(budgetPx)) {
        throwIfAborted(signal);
        onAttempt?.(budget);
        try {
          return await renderAt(page, frame, budget, signal);
        } catch (e) {
          if (signal?.aborted) throw abortError();
          lastError = e;
        }
      }
      throw renderFailed(lastError);
    },

    close() {
      // v6 has no doc.destroy(); the loading task ends the doc and its worker.
      return (closed ??= task.destroy());
    },
  };
}
