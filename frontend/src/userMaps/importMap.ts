/**
 * Adds one PDF to My maps, start to finish, on the device:
 *
 *   size/type checks → bytes + sha256 (docId) → already saved? → pdf.js
 *   (lazy chunk) → per page: locate its georef (our own /VP reader; pdf.js
 *   only maps page → object number) → crash breadcrumb → save source.pdf →
 *   draw each plausible page once (JPEG + thumbnail) → meta.json LAST →
 *   breadcrumb cleared.
 *
 * Nothing is written until the file is known to hold a map: a PDF without
 * coordinates (or a locked one) costs no 150 MB write and gets its real
 * answer even on a full disk, and an offline add fails before any work.
 *
 * Every georeferenced page of the file becomes its own map; pages without
 * map coordinates are skipped, and so are pages whose coordinates land
 * nowhere real (only when every such page does is it a bad_location).
 * Re-adding a saved file is a duplicate (no work) — unless one of its maps
 * was removed since, or lost its image: then just those pages are drawn
 * into the saved doc.
 *
 * Never throws: every outcome is an ImportResult with firefighter wording
 * (failureMessage, shared with the UI). Any failure removes the doc's
 * partial folder and the breadcrumb. The one failure that can't be caught
 * is iOS killing the tab mid-render (jetsam): the breadcrumb survives the
 * reload and the session offers to redraw from the saved source.pdf at
 * half the pixel budget. An orderly unload is told apart (pagehide) so it
 * never reads as a crash.
 *
 * pdf.js is never imported statically: `import('./pdfRender')` keeps its
 * 0.7 MB (gz) out of the main chunk. The service worker caches it on first
 * use (not in the precache), so a failed load offline means "needs a
 * connection the first time"; online, it means a deploy renamed the chunk
 * under this open tab ('load_failed': reload).
 *
 * Analytics carry counts, sizes and reason codes only — never a file
 * name, title or coordinate.
 */
import { track } from '../app/analytics';
import { buildGeoModel, georefFromViewports, plausibleLocation } from './georef';
import { readPageViewports, sniffPdf } from './pdfObjects';
import type { OpenedPdf, RenderedCrop } from './pdfRender';
import { MAX_FILE_BYTES, MIN_BUDGET, pixelBudget } from './renderBudget';
import {
  StorageFullError,
  deleteDoc,
  hasDoc,
  readMeta,
  readPageImage,
  readSource,
  requestPersist,
  savePageImages,
  saveSource,
  writeMeta,
} from './storage';
import type {
  Box,
  GeoModel,
  ImportBreadcrumb,
  ImportFailure,
  ImportProgress,
  ImportResult,
  ImportStage,
  UserMapMeta,
} from './types';

// ---------- user-facing wording ----------

/** Everything My maps tells the user about an import. */
export type UserMapMessage =
  | ImportFailure
  | 'duplicate'
  | 'crashed'
  /** Crashed in a session-only browser: the source went with the tab. */
  | 'crashed_lost'
  /** "Try again" after a crash, with no connection: the saved source is kept. */
  | 'retry_offline'
  | 'remove_failed';

const MESSAGES: Record<UserMapMessage, string> = {
  not_pdf: 'That file isn’t a PDF.',
  too_large: 'That PDF is over 150 MB — too big to add here.',
  no_georef: 'This PDF has no map coordinates, so it can’t go on the map.',
  lgidict: 'This PDF stores its map coordinates in a format we can’t read yet.',
  encrypted: 'This PDF is locked, so its map coordinates can’t be read.',
  parse_fail: 'Couldn’t read this PDF’s map coordinates.',
  bad_location: 'This PDF’s map coordinates don’t point to a real place.',
  render_failed: 'Couldn’t draw this map on this device.',
  storage_full: 'Not enough storage space on this device to save the map.',
  offline: 'Adding a map needs a connection the first time.',
  load_failed: 'Couldn’t load the map reader. Reload the page and try again.',
  cancelled: 'Stopped adding the map.',
  duplicate: 'That map is already in My maps.',
  crashed: 'The last map ran out of memory while drawing. Try again at lower detail?',
  crashed_lost:
    'The last map ran out of memory while drawing. Add it again to try at lower detail.',
  retry_offline: 'Drawing the map again needs a connection. Try again once you’re online?',
  remove_failed: 'Couldn’t remove that map. Try again.',
};

export function failureMessage(reason: UserMapMessage): string {
  return MESSAGES[reason];
}

// ---------- crash breadcrumb ----------

export const BREADCRUMB_KEY = 'rd-usermap-import';

export function readBreadcrumb(): ImportBreadcrumb | null {
  try {
    const raw = localStorage.getItem(BREADCRUMB_KEY);
    if (!raw) return null;
    const b = JSON.parse(raw) as Partial<ImportBreadcrumb> | null;
    if (
      b &&
      typeof b.docId === 'string' &&
      typeof b.fileName === 'string' &&
      typeof b.budgetPx === 'number' &&
      Number.isFinite(b.budgetPx) &&
      typeof b.startedAt === 'string'
    ) {
      return b as ImportBreadcrumb;
    }
  } catch {
    /* storage blocked, or not ours */
  }
  return null;
}

function writeBreadcrumb(b: ImportBreadcrumb): void {
  try {
    localStorage.setItem(BREADCRUMB_KEY, JSON.stringify(b));
  } catch {
    /* storage blocked: a crash then just goes unexplained */
  }
}

export function clearBreadcrumb(): void {
  try {
    localStorage.removeItem(BREADCRUMB_KEY);
  } catch {
    /* storage blocked */
  }
}

// ---------- raster zoom ----------

/** Web Mercator ground meters per pixel at zoom 0 on the equator (256-px tiles). */
const Z0_M_PER_PX = 156543.03392804097;

/** The raster source's maxzoom: one level past where a 256-px tile pixel
 * matches an image pixel at the frame centre, so the deepest tiles are
 * still drawn from the stored JPEG rather than upscaled by MapLibre. */
export function nativeMaxZoom(
  model: GeoModel,
  image: { width: number; height: number },
  frame: Box,
): number {
  // By area, not per axis: a /Rotate 90/270 page renders the frame sideways
  // (image width spans the frame's height), and one uniform scale was used.
  const ptsPerPx = Math.sqrt(
    Math.abs((frame[2] - frame[0]) * (frame[3] - frame[1])) / (image.width * image.height),
  );
  const mPerPx = model.metersPerPoint * ptsPerPx;
  const [, lat] = model.pageToLonLat((frame[0] + frame[2]) / 2, (frame[1] + frame[3]) / 2);
  const z = Math.ceil(Math.log2((Z0_M_PER_PX * Math.cos((lat * Math.PI) / 180)) / mPerPx)) + 1;
  if (Number.isNaN(z)) return 18;
  return Math.min(22, Math.max(0, z));
}

// ---------- import ----------

export interface ImportOptions {
  onProgress: (p: ImportProgress) => void;
  signal?: AbortSignal;
  /** Pixels per rendered page; defaults to the device's pixelBudget(). */
  budgetPx?: number;
}

/** Add a picked/dropped file. */
export function importPdf(file: File, opts: ImportOptions): Promise<ImportResult> {
  return runImport({ blob: file, fileName: file.name, docId: null }, opts);
}

/** Redraw a doc from its saved source.pdf (after a crash), at `budgetPx`. */
export async function retryImport(
  docId: string,
  budgetPx: number,
  onProgress: (p: ImportProgress) => void,
  opts: { signal?: AbortSignal; fileName?: string } = {},
): Promise<ImportResult> {
  const crumb = readBreadcrumb();
  const fileName = opts.fileName ?? (crumb?.docId === docId ? crumb.fileName : 'map.pdf');
  const source = await readSource(docId).catch(() => null);
  if (!source) {
    if (crumb?.docId === docId) clearBreadcrumb();
    if (!(await hasDoc(docId).catch(() => true))) await deleteDoc(docId).catch(() => undefined);
    track('user_map_import_failed', { reason: 'parse_fail', retry: true });
    return failure('parse_fail');
  }
  return runImport(
    {
      blob: source,
      fileName,
      docId,
      // Put back if this retry fails for a reason that passes; without the
      // crash's own, one at twice this budget makes the next Try again
      // start here again rather than lower.
      crumb:
        crumb?.docId === docId
          ? crumb
          : { docId, fileName, budgetPx: budgetPx * 2, startedAt: new Date().toISOString() },
    },
    { onProgress, signal: opts.signal, budgetPx },
  );
}

/**
 * Retry failures that can still succeed later — no connection, a deploy
 * waiting for a reload, Cancel. Such a retry keeps the saved source.pdf and
 * the crash breadcrumb so Try again still works; any other failure
 * (render_failed, parse_fail, storage_full…) discards them.
 */
export function retryKeepsSource(reason: ImportFailure): boolean {
  return reason === 'offline' || reason === 'load_failed' || reason === 'cancelled';
}

/** Whether this page load already asked for persistent storage. */
let persistAsked = false;

interface Source {
  blob: Blob;
  fileName: string;
  /** Known for a retry (source.pdf already saved); null for a new file. */
  docId: string | null;
  /** A retry's crash breadcrumb, restored when it fails with retryKeepsSource. */
  crumb?: ImportBreadcrumb;
}

/** Mutable bookkeeping so one place can clean up after any failure. */
interface Job {
  docId: string | null;
  /** The doc folder may hold files of this import → remove on failure. */
  wrote: boolean;
  /** The breadcrumb this import wrote and still owns (the latest budget). */
  crumb: ImportBreadcrumb | null;
  /** pagehide fired: the page is going away, so writes no breadcrumb. */
  hidden: boolean;
  /** What an unload leaves behind instead: a retry's crash breadcrumb. */
  restore: ImportBreadcrumb | null;
  opened: OpenedPdf | null;
  /** Reason used when a step throws something unrecognised. */
  fallback: ImportFailure;
}

async function runImport(src: Source, opts: ImportOptions): Promise<ImportResult> {
  const job: Job = {
    docId: src.docId,
    wrote: false,
    crumb: null,
    hidden: false,
    restore: src.crumb ?? null,
    opened: null,
    fallback: 'parse_fail',
  };
  const unwatch = watchUnload(job);
  let result: ImportResult;
  try {
    result = await attempt(src, opts, job);
  } catch (err) {
    result = failure(
      opts.signal?.aborted
        ? 'cancelled'
        : err instanceof StorageFullError || (err as { name?: unknown })?.name === 'QuotaExceededError'
          ? 'storage_full'
          : job.fallback,
    );
  } finally {
    unwatch();
    // Kills the pdf.js worker and its decoded images.
    const opened = job.opened;
    if (opened) await Promise.resolve().then(() => opened.close()).catch(() => undefined);
  }
  // A failure that raced Cancel reads as a cancel. A doc already committed
  // (meta.json written) stays a success: it is saved.
  if (!result.ok && opts.signal?.aborted) result = failure('cancelled');
  if (!result.ok) {
    const keep = !!src.docId && retryKeepsSource(result.reason);
    // Never a doc with readable maps: another tab may have committed it while
    // this one drew (an unreadable meta.json being imported over still goes).
    if (job.wrote && job.docId && !keep && !(await readMeta(job.docId).catch(() => null))) {
      await deleteDoc(job.docId).catch(() => undefined);
    }
    if (keep) {
      if (src.crumb) writeBreadcrumb(src.crumb);
    } else if ((job.crumb || src.docId) && readBreadcrumb()?.docId === job.docId) {
      // This import's breadcrumb, or the crash's a retry was redrawing: the
      // source it pointed at is gone. Another tab's own one stays.
      clearBreadcrumb();
    }
    track('user_map_import_failed', { reason: result.reason, retry: !!src.docId });
  }
  return result;
}

/** Records this import's breadcrumb (unless the page is going away). */
function setCrumb(job: Job, b: ImportBreadcrumb): void {
  job.crumb = b;
  if (!job.hidden) writeBreadcrumb(b);
}

/**
 * An orderly unload — reload, closing the tab, navigating away — is not a
 * crash, so pagehide clears this import's breadcrumb: else the next visit
 * says "ran out of memory", halves the detail of every import and logs a
 * crash. (A retry puts back the crash it was redrawing, which still stands,
 * at its own budget.) iOS killing the tab (jetsam) fires nothing, so a real
 * crash keeps it. Shown again while still running (back/forward cache, or
 * a browser that fires pagehide on backgrounding) → written back.
 */
function watchUnload(job: Job): () => void {
  if (typeof addEventListener !== 'function') return () => undefined;
  const hide = () => {
    job.hidden = true;
    if (job.crumb && readBreadcrumb()?.docId === job.crumb.docId) {
      if (job.restore) writeBreadcrumb(job.restore);
      else clearBreadcrumb();
    }
  };
  const show = () => {
    job.hidden = false;
    const current = readBreadcrumb();
    if (job.crumb && (!current || current.docId === job.crumb.docId)) writeBreadcrumb(job.crumb);
  };
  const visible = () => {
    if (document.visibilityState === 'visible') show();
  };
  const doc = typeof document !== 'undefined' ? document : null;
  addEventListener('pagehide', hide);
  addEventListener('pageshow', show);
  doc?.addEventListener('visibilitychange', visible);
  return () => {
    removeEventListener('pagehide', hide);
    removeEventListener('pageshow', show);
    doc?.removeEventListener('visibilitychange', visible);
  };
}

async function attempt(src: Source, opts: ImportOptions, job: Job): Promise<ImportResult> {
  const t0 = Date.now();
  const { signal } = opts;
  const progress = (stage: ImportStage, extra?: { page: number; pages: number }) => {
    if (!signal?.aborted) opts.onProgress({ fileName: src.fileName, stage, ...extra });
  };
  const fileBytes = src.blob.size;
  let budget = Math.max(MIN_BUDGET, opts.budgetPx ?? pixelBudget());

  // Size / type: before reading a byte more than the header.
  progress('reading');
  if (fileBytes > MAX_FILE_BYTES) return failure('too_large');
  if (!fileBytes || !sniffPdf(new Uint8Array(await src.blob.slice(0, 1024).arrayBuffer())).isPdf) {
    return failure('not_pdf');
  }
  checkAbort(signal);

  // Bytes + docId. This copy is for our own /VP reader; pdf.js gets its own
  // (getDocument detaches the buffer it is handed).
  let bytes: Uint8Array<ArrayBuffer> | null = new Uint8Array(await src.blob.arrayBuffer());
  checkAbort(signal);
  const docId = (job.docId ??= await docIdFor(bytes));
  checkAbort(signal);

  // Already saved: a duplicate (no work) while every map page it was
  // imported with is still there, image included. Else only the missing
  // pages are drawn, into the saved doc — which no failure may touch.
  let saved: UserMapMeta[] | null = null;
  const savedImages = new Set<number>();
  if (await hasDoc(docId)) {
    saved = await readMeta(docId);
    if (saved) {
      for (const m of saved) {
        if (await readPageImage(docId, m.page).catch(() => null)) savedImages.add(m.page);
      }
      const want = saved[0].mapPages;
      if (isPageList(want) && [...want, ...saved.map((m) => m.page)].every((p) => savedImages.has(p))) {
        return { ok: true, maps: saved, duplicate: true };
      }
    } else {
      job.wrote = true; // meta.json unreadable: import again over it, gone on failure
    }
  }
  // A retry that fails takes its saved source with it (see retryKeepsSource).
  if (src.docId && !saved) job.wrote = true;
  checkAbort(signal);

  // pdf.js before anything is written: an add with no connection fails at once.
  progress('locating');
  let pdfRender: typeof import('./pdfRender');
  try {
    pdfRender = await import('./pdfRender');
  } catch {
    // Online, the chunk itself is gone: a deploy renamed it under this tab.
    return failure(
      typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'load_failed',
    );
  }
  checkAbort(signal);
  try {
    job.opened = await pdfRender.openPdf(bytes.slice());
  } catch (err) {
    checkAbort(signal);
    const name = (err as { name?: unknown })?.name;
    return failure(
      name === 'PasswordException' || sniffPdf(bytes).encrypted
        ? 'encrypted'
        : looksOffline(err)
          ? 'offline'
          : 'parse_fail',
    );
  }
  const opened = job.opened;
  checkAbort(signal);

  // Locate: every page, before drawing any, so "page n of N" and the
  // bad_location verdict know the whole file.
  const candidates: { page: number; model: GeoModel; bounds: Box }[] = [];
  let georefPages = 0;
  let unreadable = 0;
  for (let page = 1; page <= opened.numPages; page++) {
    checkAbort(signal);
    try {
      const objNum = await opened.pageObjNum(page);
      if (objNum === null) {
        unreadable++;
        continue;
      }
      const georef = georefFromViewports(await readPageViewports(bytes, objNum));
      if (!georef) continue;
      const model = buildGeoModel(georef);
      georefPages++;
      const bounds = boundsOf(model.footprint());
      if (bounds && plausibleLocation(model)) candidates.push({ page, model, bounds });
    } catch {
      checkAbort(signal);
      unreadable++; // PdfParseError or a degenerate frame: skip the page
    }
  }
  // Pages to draw: every map page of a new doc; of a saved one, the missing.
  const todo = candidates.filter((c) => !savedImages.has(c.page));
  if (saved && !todo.length) return { ok: true, maps: saved, duplicate: true };
  if (!todo.length) {
    // The whole-file sniff only on the way out: ~0.2 s of main thread per
    // 150 MB that an import that works never needs.
    const sniff = sniffPdf(bytes);
    return failure(
      georefPages
        ? 'bad_location'
        : sniff.lgidict
          ? 'lgidict'
          : sniff.encrypted
            ? 'encrypted'
            : unreadable
              ? 'parse_fail'
              : 'no_georef',
    );
  }
  bytes = null; // pdf.js holds its own copy; let ours go before drawing

  if (!saved) {
    if (!src.docId) {
      // The same file crashed the tab last time: start lower.
      const crashed = readBreadcrumb();
      if (crashed?.docId === docId) {
        budget = Math.min(budget, Math.max(MIN_BUDGET, Math.floor(crashed.budgetPx / 2)));
      }
    }
    // Breadcrumb before the folder exists: another tab's boot cleanup spares
    // the breadcrumb's doc, so it never takes a half-saved source.
    setCrumb(job, { docId, fileName: src.fileName, budgetPx: budget, startedAt: new Date().toISOString() });
    if (!src.docId) {
      progress('saving');
      job.fallback = 'storage_full';
      job.wrote = true;
      await saveSource(docId, src.blob);
      checkAbort(signal);
    }
  }

  // Draw + save each map page. Pages restored into a saved doc take its
  // name and date, so they sort and read with their siblings.
  const maps: UserMapMeta[] = [];
  const fileName = saved?.[0].fileName ?? src.fileName;
  const addedAt = saved?.[0].addedAt ?? new Date().toISOString();
  const title = baseTitle(fileName);
  const mapPages = candidates.map((c) => c.page);
  for (const [i, c] of todo.entries()) {
    checkAbort(signal);
    progress('drawing', { page: i + 1, pages: todo.length });
    job.fallback = 'render_failed';
    // Every budget renderCrop tries is in the breadcrumb before it draws, so
    // a crash retry halves the budget that died, not the one it started at.
    const crumb = job.crumb;
    const crop = await opened.renderCrop(
      c.page,
      c.model.georef.frame,
      budget,
      signal,
      crumb ? (b) => setCrumb(job, { ...crumb, budgetPx: b }) : undefined,
    );
    checkAbort(signal);
    // renderCrop stepped down to fit: later pages start there.
    if (crop.budgetPx < budget) budget = crop.budgetPx;
    job.fallback = 'storage_full';
    await savePageImages(docId, c.page, crop.jpeg, crop.thumb);
    maps.push(
      buildMeta({
        docId,
        page: c.page,
        pageCount: opened.numPages,
        title: candidates.length > 1 ? `${title} · page ${c.page}` : title,
        fileName,
        fileBytes,
        addedAt,
        model: c.model,
        bounds: c.bounds,
        crop,
        mapPages,
      }),
    );
  }

  checkAbort(signal);
  progress('finishing');
  job.fallback = 'storage_full';
  // A saved doc keeps its other maps. The new ones lead the result, so the
  // session shows the map that just came back.
  const kept = saved ? saved.filter((m) => !maps.some((n) => n.page === m.page)) : [];
  await writeMeta(docId, [...kept, ...maps].sort((a, b) => a.page - b.page)); // the commit point
  if (job.crumb && readBreadcrumb()?.docId === docId) clearBreadcrumb();
  job.crumb = null;

  if (!persistAsked) {
    persistAsked = true;
    void requestPersist();
  }
  track('user_map_imported', {
    maps: maps.length,
    pages: opened.numPages,
    mb: Math.round(fileBytes / 1_000_000),
    secs: Math.round((Date.now() - t0) / 1000),
    budget_mp: Math.round(Math.min(...maps.map((m) => m.image.budgetPx)) / 1_000_000),
    retry: !!src.docId,
  });
  return { ok: true, maps: [...maps, ...kept], duplicate: false };
}

// ---------- helpers ----------

function failure(reason: ImportFailure): ImportResult {
  return { ok: false, reason, message: MESSAGES[reason] };
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('Import cancelled');
    err.name = 'AbortError';
    throw err;
  }
}

/** pdf.js couldn't fetch its worker, or openPdf its JPEG 2000 / JBIG2
 * decoders (fetched up front: pdf.js itself would just draw them white). */
function looksOffline(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const msg = String((err as { message?: unknown })?.message ?? '');
  return /fake worker|failed to fetch|dynamically imported module|importing a module script|networkerror|load failed/i.test(
    msg,
  );
}

/** sha256(file bytes) hex, first 16 chars. */
async function docIdFor(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest, 0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const isPageList = (v: unknown): v is number[] =>
  Array.isArray(v) && v.length > 0 && v.every((p) => Number.isInteger(p) && p >= 1);

/** File name without ".pdf" (any case); a name that is only the
 * extension still gets a title. */
function baseTitle(fileName: string): string {
  return fileName.replace(/\.pdf$/i, '').trim() || 'PDF map';
}

/** [w, s, e, n] of a footprint, or null when any point is unusable. */
function boundsOf(ring: [number, number][]): Box | null {
  if (!ring.length) return null;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lon, lat] of ring) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    w = Math.min(w, lon);
    e = Math.max(e, lon);
    s = Math.min(s, lat);
    n = Math.max(n, lat);
  }
  return [w, s, e, n];
}

function buildMeta(p: {
  docId: string;
  page: number;
  pageCount: number;
  title: string;
  fileName: string;
  fileBytes: number;
  addedAt: string;
  model: GeoModel;
  bounds: Box;
  crop: RenderedCrop;
  mapPages: number[];
}): UserMapMeta {
  const { model, bounds, crop } = p;
  return {
    v: 1,
    id: `${p.docId}-p${p.page}`,
    docId: p.docId,
    page: p.page,
    pageCount: p.pageCount,
    title: p.title,
    fileName: p.fileName,
    fileBytes: p.fileBytes,
    addedAt: p.addedAt,
    image: {
      width: crop.width,
      height: crop.height,
      bytes: crop.jpeg.size,
      pageToImage: crop.pageToImage,
      budgetPx: crop.budgetPx,
    },
    georef: model.georef,
    bounds,
    center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
    maxzoom: nativeMaxZoom(model, crop, model.georef.frame),
    warnings: [...model.georef.warnings],
    mapPages: p.mapPages,
  };
}
