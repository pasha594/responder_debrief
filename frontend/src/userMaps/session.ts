/**
 * My maps session: wires storage and importMap to the store's `userMaps`
 * slice, for the Maps tab and the map layer.
 *
 * - initUserMaps() at boot (next to initOfflinePacks): loads the list,
 *   tidies unfinished imports, and turns a leftover crash breadcrumb (iOS
 *   killed the tab while drawing) into a "Try again at lower detail" notice.
 * - Imports run ONE AT A TIME through a promise chain: a PDF render holds a
 *   canvas, a pdf.js worker and every decoded image, and two at once is how
 *   a phone gets killed. The boot listing rides the same chain so it never
 *   deletes the folder of an import that is still writing.
 * - After a success the first new map is shown (setUserMap, which takes down
 *   incident sheets / IR) and announced through onUserMapAdded so the UI
 *   can fly the camera to it — only while a fire is open.
 * - Other tabs: the breadcrumb and OPFS are shared by every tab, so each
 *   import holds a shared Web Lock. A tab that boots (or dismisses a crash
 *   notice) while another holds it leaves the breadcrumb and folders alone:
 *   that is a running import, not a crash. A killed tab drops its lock.
 *
 * Local-only by design: a map id never goes into the URL or a share.
 */
import { track } from '../app/analytics';
import { useStore } from '../state/store';
import {
  clearBreadcrumb,
  failureMessage,
  importPdf,
  readBreadcrumb,
  retryImport,
  retryKeepsSource,
} from './importMap';
import { MIN_BUDGET, pixelBudget } from './renderBudget';
import {
  deleteDoc,
  deletePageImages,
  hasDoc,
  listUserMaps,
  readSource,
  sortUserMaps,
  userMapsPersistent,
  writeMeta,
} from './storage';
import type { ImportBreadcrumb, ImportProgress, ImportResult, UserMapMeta } from './types';

const actions = () => useStore.getState().actions;

// ---------- one import at a time ----------

let chain: Promise<void> = Promise.resolve();

function enqueue(job: () => Promise<void>): Promise<void> {
  const run = chain.then(job);
  chain = run.catch(() => undefined); // one failed job never blocks the next
  return run;
}

/** Running and queued imports: Cancel stops them all. */
const controllers = new Set<AbortController>();

/** Set once this page load has seen a crash: later imports start at this
 * budget instead of the device default (the same phone, the same memory). */
let crashCap: number | null = null;

// ---------- other tabs ----------

const IMPORT_LOCK = 'rd-usermap-import';

/** Runs an import holding the shared lock (shared: tabs still import side
 * by side, as before; the lock only says "one is running"). */
async function withImportLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return run();
  let ran = false;
  try {
    return await locks.request(IMPORT_LOCK, { mode: 'shared' }, () => {
      ran = true;
      return run();
    });
  } catch (err) {
    if (ran) throw err;
    return run(); // the lock itself was refused: import without it
  }
}

/** Some tab holds the import lock. Asked only where this tab can't be
 * importing (boot, and before its next import starts), so it's another. */
async function otherTabImporting(): Promise<boolean> {
  try {
    const held = (await globalThis.navigator?.locks?.query?.())?.held ?? [];
    return held.some((l) => l.name === IMPORT_LOCK);
  } catch {
    return false;
  }
}

// ---------- fly-to announcements ----------

const listeners = new Set<(m: UserMapMeta) => void>();
/** A map added while nothing listened (the map view mounting late); handed
 * to the next subscriber if it arrives soon enough to still make sense. */
let pendingFlyTo: { meta: UserMapMeta; at: number } | null = null;
const PENDING_FLY_TO_MS = 10_000;

/** Subscribe to "a map was just added (or re-added) and shown" — fly there. */
export function onUserMapAdded(cb: (m: UserMapMeta) => void): () => void {
  listeners.add(cb);
  if (pendingFlyTo) {
    const { meta, at } = pendingFlyTo;
    pendingFlyTo = null;
    // Never fly to a map no longer shown (a fire switch cleared it).
    if (Date.now() - at < PENDING_FLY_TO_MS && useStore.getState().layers.userMap.id === meta.id) {
      notify(cb, meta);
    }
  }
  return () => {
    listeners.delete(cb);
  };
}

/** A camera move that throws (a map mid-teardown) must not fail the import
 * that already saved — nor surface as an unhandled rejection of the UI's
 * fire-and-forget addUserMapFile(). */
function notify(cb: (m: UserMapMeta) => void, meta: UserMapMeta): void {
  try {
    cb(meta);
  } catch {
    /* the map is listed and shown; only the fly-to is lost */
  }
}

function announce(meta: UserMapMeta): void {
  if (!listeners.size) {
    pendingFlyTo = { meta, at: Date.now() };
    return;
  }
  for (const cb of listeners) notify(cb, meta);
}

// ---------- boot ----------

/** Load saved maps into the store; surface a crash from the last visit. */
export function initUserMaps(): Promise<void> {
  return enqueue(async () => {
    // Another tab importing: the breadcrumb is its running import, not a
    // crash (its folder is the breadcrumb's, so the listing spares it).
    const busy = await otherTabImporting();
    const crumb = readBreadcrumb();
    let list: UserMapMeta[] = [];
    try {
      // The crashed doc's folder (no meta.json yet) is kept for Try again.
      list = await listUserMaps(crumb?.docId);
    } catch {
      /* storage unreadable: start empty */
    }
    actions().setUserMaps(list, !userMapsPersistent());
    if (crumb && !busy) await recoverCrash(crumb);
  });
}

async function recoverCrash(crumb: ImportBreadcrumb): Promise<void> {
  if (await hasDoc(crumb.docId).catch(() => false)) {
    clearBreadcrumb(); // it committed just before the tab died
    return;
  }
  track('user_map_import_failed', {
    reason: 'crashed',
    budget_mp: Math.round(crumb.budgetPx / 1_000_000),
  });
  if (crumb.budgetPx <= MIN_BUDGET) {
    // It died at the lowest detail there is: "Try again at lower detail"
    // would only draw at the same budget and die again, forever.
    crashCap = MIN_BUDGET;
    clearBreadcrumb();
    await deleteDoc(crumb.docId).catch(() => undefined);
    actions().setUserMapNotice({ kind: 'error', text: failureMessage('render_failed') });
    return;
  }
  crashCap = Math.max(MIN_BUDGET, Math.floor(crumb.budgetPx / 2));
  const source = await readSource(crumb.docId).catch(() => null);
  if (source) {
    actions().setUserMapNotice({ kind: 'crashed', text: failureMessage('crashed'), docId: crumb.docId });
  } else {
    // Session-only storage: the source went with the tab. Adding the file
    // again starts at crashCap.
    clearBreadcrumb();
    actions().setUserMapNotice({ kind: 'error', text: failureMessage('crashed_lost') });
  }
}

// ---------- import ----------

/** Add a picked or dropped file (queued behind any running import). */
export function addUserMapFile(file: File): Promise<void> {
  const ctl = new AbortController();
  controllers.add(ctl);
  return enqueue(async () => {
    try {
      if (ctl.signal.aborted) return;
      // A new import replaces the crash breadcrumb: let the old one go.
      const notice = useStore.getState().userMaps.notice;
      if (notice?.kind === 'crashed') await discardCrashed(notice.docId);
      await runJob(file.name, ctl.signal, (onProgress) =>
        importPdf(file, { onProgress, signal: ctl.signal, budgetPx: crashCap ?? undefined }),
      );
    } finally {
      controllers.delete(ctl);
    }
  });
}

/** "Try again at lower detail": redraw the crashed doc from its saved
 * source.pdf at half the budget it died at (never below MIN_BUDGET). */
export function retryCrashedImport(): Promise<void> {
  const notice = useStore.getState().userMaps.notice;
  const crumb = readBreadcrumb();
  const docId = notice?.kind === 'crashed' ? notice.docId : crumb?.docId;
  actions().setUserMapNotice(null);
  if (!docId) return Promise.resolve();
  if (crumb?.docId === docId && crumb.budgetPx <= MIN_BUDGET) {
    // Died at the lowest detail already: nothing lower to try.
    actions().setUserMapNotice({ kind: 'error', text: failureMessage('render_failed') });
    return discardCrashed(docId);
  }
  const budget =
    crumb?.docId === docId
      ? Math.max(MIN_BUDGET, Math.floor(crumb.budgetPx / 2))
      : (crashCap ?? Math.max(MIN_BUDGET, Math.floor(pixelBudget() / 2)));
  const fileName = crumb?.docId === docId ? crumb.fileName : 'map.pdf';
  const ctl = new AbortController();
  controllers.add(ctl);
  return enqueue(async () => {
    try {
      if (ctl.signal.aborted) return;
      await runJob(
        fileName,
        ctl.signal,
        (onProgress) => retryImport(docId, budget, onProgress, { signal: ctl.signal, fileName }),
        docId,
      );
    } finally {
      controllers.delete(ctl);
    }
  });
}

/** Stop the running import and drop any queued ones. */
export function cancelUserMapImport(): void {
  for (const ctl of controllers) ctl.abort();
  controllers.clear();
  actions().setUserMapImport(null); // don't wait for pdf.js to wind down
}

/** `retryOf`: the crashed doc a Try again is redrawing. */
async function runJob(
  fileName: string,
  signal: AbortSignal,
  start: (onProgress: (p: ImportProgress) => void) => Promise<ImportResult>,
  retryOf?: string,
): Promise<void> {
  actions().setUserMapNotice(null);
  actions().setUserMapImport({ fileName, stage: 'reading' });
  // "Keep this screen open": a sleeping phone suspends the page mid-render.
  let wakeLock: WakeLockSentinel | null = null;
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
  } catch {
    /* wake lock is best-effort */
  }
  let result: ImportResult;
  try {
    result = await withImportLock(() =>
      start((p) => {
        if (!signal.aborted) actions().setUserMapImport(p);
      }),
    );
  } catch {
    // importPdf/retryImport resolve every outcome; this is a backstop so the
    // UI's `void addUserMapFile()` can never reject unhandled.
    result = signal.aborted
      ? { ok: false, reason: 'cancelled', message: failureMessage('cancelled') }
      : { ok: false, reason: 'parse_fail', message: failureMessage('parse_fail') };
  } finally {
    void wakeLock?.release().catch(() => undefined);
    actions().setUserMapImport(null);
  }

  if (!result.ok) {
    if (retryOf && retryKeepsSource(result.reason) && result.reason !== 'load_failed') {
      // The saved source was kept (no connection, or Cancel): offer Try
      // again again. ('load_failed' needs a reload first; the next boot
      // offers it.)
      const text = failureMessage(result.reason === 'offline' ? 'retry_offline' : 'crashed');
      actions().setUserMapNotice({ kind: 'crashed', text, docId: retryOf });
    } else if (result.reason !== 'cancelled') {
      actions().setUserMapNotice({ kind: 'error', text: result.message });
    }
    return;
  }
  const first = result.maps[0];
  if (!first) return;
  const others = useStore.getState().userMaps.list.filter((m) => m.docId !== first.docId);
  actions().setUserMaps(sortUserMaps([...result.maps, ...others]), !userMapsPersistent());
  if (result.duplicate) {
    actions().setUserMapNotice({ kind: 'info', text: failureMessage('duplicate') });
  }
  // Committed just as Cancel was pressed, or after the user left the fire
  // for the directory: it's listed, but nothing is shown to jump to.
  if (signal.aborted || useStore.getState().view.mode !== 'fire') return;
  actions().setUserMap(first.id);
  announce(first);
}

// ---------- notices ----------

/** Close the notice; a dismissed crash also drops its saved source. */
export function dismissUserMapNotice(): void {
  const notice = useStore.getState().userMaps.notice;
  actions().setUserMapNotice(null);
  if (notice?.kind === 'crashed') void discardCrashed(notice.docId);
}

async function discardCrashed(docId: string): Promise<void> {
  // Another tab is importing: the breadcrumb and folder may be its running
  // import (the notice came up before it started). Leave both.
  if (await otherTabImporting()) return;
  if (readBreadcrumb()?.docId === docId) clearBreadcrumb();
  // Only an unfinished folder: never a doc that is listed.
  if (!(await hasDoc(docId).catch(() => true))) await deleteDoc(docId).catch(() => undefined);
}

// ---------- remove ----------

/** Remove one map. The doc's folder (source.pdf included) goes with its
 * last map; otherwise meta.json is rewritten without it, then its images
 * are deleted. */
export async function deleteUserMap(id: string): Promise<void> {
  const state = useStore.getState();
  const meta = state.userMaps.list.find((m) => m.id === id);
  if (!meta) return;
  if (state.layers.userMap.id === id) actions().setUserMap(null);
  const siblings = state.userMaps.list.filter((m) => m.docId === meta.docId && m.id !== id);
  try {
    if (siblings.length) {
      await writeMeta(meta.docId, siblings);
      await deletePageImages(meta.docId, meta.page);
    } else {
      await deleteDoc(meta.docId);
    }
  } catch {
    actions().setUserMapNotice({ kind: 'error', text: failureMessage('remove_failed') });
    return;
  }
  const list = useStore.getState().userMaps.list.filter((m) => m.id !== id);
  actions().setUserMaps(list, !userMapsPersistent());
  track('user_map_removed');
}
