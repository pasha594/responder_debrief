/**
 * session.ts against the real store and the real (in-memory, since node has
 * no OPFS) storage, with importPdf/retryImport stubbed: boot listing and the
 * crash notice, crash retry budget, one-import-at-a-time, cancel, delete,
 * and the fly-to hand-off. The tests share module state and run in order.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportOptions } from './importMap';
import type { ImportProgress, ImportResult, UserMapMeta } from './types';

// The store reads document.documentElement.dataset.theme at module load.
(globalThis as { document?: unknown }).document ??= { documentElement: { dataset: {} } };
(globalThis as { window?: unknown }).window ??= globalThis;
const ls = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => ls.get(k) ?? null,
  setItem: (k: string, v: string) => void ls.set(k, v),
  removeItem: (k: string) => void ls.delete(k),
});

const h = vi.hoisted(() => ({ track: vi.fn(), importPdf: vi.fn(), retryImport: vi.fn() }));
vi.mock('../app/analytics', async (orig) => ({
  ...(await orig<typeof import('../app/analytics')>()),
  track: h.track,
}));
vi.mock('./importMap', async (orig) => ({
  ...(await orig<typeof import('./importMap')>()),
  importPdf: h.importPdf,
  retryImport: h.retryImport,
}));

const storage = await import('./storage');
const session = await import('./session');
const { useStore } = await import('../state/store');
const st = () => useStore.getState();
const tick = () => new Promise((r) => setTimeout(r, 5));
// A fire is open: a finished import is shown only then.
st().actions.selectFire('fire-1');

function meta(docId: string, page: number, addedAt = '2026-10-16T10:00:00.000Z'): UserMapMeta {
  return {
    v: 1,
    id: `${docId}-p${page}`,
    docId,
    page,
    pageCount: 2,
    title: 't',
    fileName: 'f.pdf',
    fileBytes: 1,
    addedAt,
    image: { width: 1, height: 1, bytes: 1, pageToImage: [1, 0, 0, 1, 0, 0], budgetPx: 1 },
    georef: { v: 1, wkt: null, frame: [0, 0, 1, 1], points: [], warnings: [] },
    bounds: [-120, 40, -119, 41],
    center: [-119.5, 40.5],
    maxzoom: 15,
    warnings: [],
  };
}
const crumb = (docId: string) =>
  JSON.stringify({ docId, fileName: 'C.pdf', budgetPx: 12e6, startedAt: '2026-10-16T09:00:00.000Z' });

beforeEach(() => {
  ls.clear();
  h.track.mockClear();
  h.importPdf.mockReset();
  h.retryImport.mockReset();
});

describe('My maps session', () => {
  it('boot: lists saved maps, flags session-only, keeps the crashed source and offers a retry', async () => {
    await storage.writeMeta('old', [meta('old', 1, '2026-10-01T00:00:00.000Z')]);
    await storage.saveSource('crash', new Blob(['%PDF-']));
    await storage.saveSource('partial', new Blob(['%PDF-']));
    ls.set('rd-usermap-import', crumb('crash'));
    await session.initUserMaps();
    expect(st().userMaps.list.map((m) => m.id)).toEqual(['old-p1']);
    expect(st().userMaps.sessionOnly).toBe(true);
    expect(st().userMaps.loaded).toBe(true);
    expect(st().userMaps.notice).toMatchObject({ kind: 'crashed', docId: 'crash' });
    expect(await storage.readSource('partial')).toBeNull(); // unfinished, not the crash: tidied
    expect(await storage.readSource('crash')).not.toBeNull();
    expect(h.track).toHaveBeenCalledWith('user_map_import_failed', { reason: 'crashed', budget_mp: 12 });
  });

  it('Try again redraws at half the crashed budget, then shows and flies to the map', async () => {
    h.retryImport.mockImplementation(
      async (docId: string, _budget: number, onProgress: (p: ImportProgress) => void): Promise<ImportResult> => {
        onProgress({ fileName: 'C.pdf', stage: 'drawing', page: 1, pages: 1 });
        expect(st().userMaps.import?.stage).toBe('drawing');
        return { ok: true, duplicate: false, maps: [meta(docId, 1)] };
      },
    );
    const flown: string[] = [];
    const off = session.onUserMapAdded((m) => flown.push(m.id));
    ls.set('rd-usermap-import', crumb('crash'));
    await session.retryCrashedImport();
    off();
    expect(h.retryImport.mock.calls[0].slice(0, 2)).toEqual(['crash', 6e6]);
    expect(h.retryImport.mock.calls[0][3]).toMatchObject({ fileName: 'C.pdf' });
    expect(st().userMaps.notice).toBeNull();
    expect(st().userMaps.import).toBeNull();
    expect(st().userMaps.list.map((m) => m.id)).toEqual(['crash-p1', 'old-p1']);
    expect(st().layers.userMap.id).toBe('crash-p1');
    expect(flown).toEqual(['crash-p1']);
  });

  it('imports run one at a time at the crash-capped budget; errors and duplicates become notices', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.importPdf.mockImplementationOnce(async (f: File, o: ImportOptions): Promise<ImportResult> => {
      order.push(`start ${f.name}`);
      expect(o.budgetPx).toBe(6e6);
      await gate;
      order.push(`end ${f.name}`);
      const at = '2026-10-16T11:00:00.000Z';
      return { ok: true, duplicate: false, maps: [meta('a', 1, at), meta('a', 2, at)] };
    });
    h.importPdf.mockImplementationOnce(async (f: File): Promise<ImportResult> => {
      order.push(`start ${f.name}`);
      return { ok: false, reason: 'no_georef', message: 'This PDF has no map coordinates, so it can’t go on the map.' };
    });
    const p1 = session.addUserMapFile(new File(['x'], 'A.pdf'));
    const p2 = session.addUserMapFile(new File(['y'], 'B.pdf'));
    await tick();
    expect(order).toEqual(['start A.pdf']);
    release();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['start A.pdf', 'end A.pdf', 'start B.pdf']);
    expect(st().userMaps.list.map((m) => m.id)).toEqual(['a-p1', 'a-p2', 'crash-p1', 'old-p1']);
    expect(st().layers.userMap.id).toBe('a-p1');
    expect(st().userMaps.notice).toMatchObject({ kind: 'error' });
    // Nobody was subscribed: the next subscriber gets the pending fly-to.
    const got: string[] = [];
    session.onUserMapAdded((m) => got.push(m.id))();
    expect(got).toEqual(['a-p1']);

    h.importPdf.mockResolvedValueOnce({
      ok: true,
      duplicate: true,
      maps: [meta('old', 1, '2026-10-01T00:00:00.000Z')],
    });
    await session.addUserMapFile(new File(['z'], 'Old.pdf'));
    expect(st().userMaps.notice).toEqual({ kind: 'info', text: 'That map is already in My maps.' });
    expect(st().layers.userMap.id).toBe('old-p1');
  });

  it('a fly-to that throws, or an import that rejects, never rejects addUserMapFile', async () => {
    const off = session.onUserMapAdded(() => {
      throw new Error('map gone');
    });
    h.importPdf.mockResolvedValueOnce({ ok: true, duplicate: false, maps: [meta('b', 1)] });
    await expect(session.addUserMapFile(new File(['b'], 'B.pdf'))).resolves.toBeUndefined();
    expect(st().layers.userMap.id).toBe('b-p1');
    off();

    h.importPdf.mockRejectedValueOnce(new Error('boom'));
    await expect(session.addUserMapFile(new File(['c'], 'C.pdf'))).resolves.toBeUndefined();
    expect(st().userMaps.import).toBeNull();
    expect(st().userMaps.notice).toMatchObject({ kind: 'error' });
  });

  it('Cancel stops the running import and drops queued ones, with no notice', async () => {
    h.importPdf.mockImplementationOnce(
      (_f: File, o: ImportOptions) =>
        new Promise<ImportResult>((res) =>
          o.signal!.addEventListener('abort', () => res({ ok: false, reason: 'cancelled', message: 'x' })),
        ),
    );
    session.dismissUserMapNotice();
    const p1 = session.addUserMapFile(new File(['x'], 'A.pdf'));
    const p2 = session.addUserMapFile(new File(['y'], 'B.pdf'));
    await tick();
    expect(st().userMaps.import).toMatchObject({ fileName: 'A.pdf' });
    session.cancelUserMapImport();
    expect(st().userMaps.import).toBeNull();
    await Promise.all([p1, p2]);
    expect(h.importPdf).toHaveBeenCalledTimes(1);
    expect(st().userMaps.notice).toBeNull();
  });

  it('remove: one page of a multi-map PDF rewrites meta.json; the last page takes the folder', async () => {
    await storage.writeMeta('a', [meta('a', 1), meta('a', 2)]);
    await storage.savePageImages('a', 1, new Blob(['j']), new Blob(['t']));
    st().actions.setUserMap('a-p1');
    await session.deleteUserMap('a-p1');
    expect(st().layers.userMap.id).toBeNull();
    expect((await storage.readMeta('a'))!.map((m) => m.id)).toEqual(['a-p2']);
    expect(await storage.readPageImage('a', 1)).toBeNull();
    expect(st().userMaps.list.map((m) => m.id)).not.toContain('a-p1');
    await session.deleteUserMap('a-p2');
    expect(await storage.hasDoc('a')).toBe(false);
    expect(h.track).toHaveBeenCalledWith('user_map_removed');
  });

  it('dismissing a crash notice drops its unfinished folder and the breadcrumb', async () => {
    await storage.saveSource('c2', new Blob(['%PDF-']));
    ls.set('rd-usermap-import', crumb('c2'));
    st().actions.setUserMapNotice({ kind: 'crashed', text: 'x', docId: 'c2' });
    session.dismissUserMapNotice();
    await tick();
    expect(st().userMaps.notice).toBeNull();
    expect(ls.has('rd-usermap-import')).toBe(false);
    expect(await storage.readSource('c2')).toBeNull();
  });

  it('a Try again that fails for want of a connection, or is cancelled, offers Try again again', async () => {
    ls.set('rd-usermap-import', crumb('c3'));
    st().actions.setUserMapNotice({ kind: 'crashed', text: 'x', docId: 'c3' });
    h.retryImport.mockResolvedValueOnce({ ok: false, reason: 'offline', message: 'x' });
    await session.retryCrashedImport();
    expect(st().userMaps.notice).toEqual({
      kind: 'crashed',
      docId: 'c3',
      text: 'Drawing the map again needs a connection. Try again once you’re online?',
    });

    h.retryImport.mockResolvedValueOnce({ ok: false, reason: 'cancelled', message: 'x' });
    await session.retryCrashedImport();
    expect(st().userMaps.notice).toMatchObject({ kind: 'crashed', docId: 'c3' });

    // For good: an ordinary error, no Try again.
    h.retryImport.mockResolvedValueOnce({ ok: false, reason: 'render_failed', message: 'Couldn’t draw this map on this device.' });
    await session.retryCrashedImport();
    expect(st().userMaps.notice).toEqual({ kind: 'error', text: 'Couldn’t draw this map on this device.' });
    session.dismissUserMapNotice();
    ls.clear();
  });

  it('another tab’s running import is not a crash: no notice, nothing deleted, even on Dismiss', async () => {
    await storage.saveSource('busy', new Blob(['%PDF-']));
    ls.set('rd-usermap-import', crumb('busy'));
    let release!: () => void;
    // Tab A, drawing: it holds the import lock.
    const held = navigator.locks.request(
      'rd-usermap-import',
      { mode: 'shared' },
      () => new Promise<void>((r) => (release = r)),
    );
    await tick();
    try {
      await session.initUserMaps(); // tab B boots
      expect(st().userMaps.notice).toBeNull();
      expect(h.track).not.toHaveBeenCalledWith('user_map_import_failed', expect.anything());
      expect(await storage.readSource('busy')).not.toBeNull();
      expect(ls.has('rd-usermap-import')).toBe(true);
      // A crash notice up from before A started: Dismiss leaves A's files be.
      st().actions.setUserMapNotice({ kind: 'crashed', text: 'x', docId: 'busy' });
      session.dismissUserMapNotice();
      await tick();
      expect(await storage.readSource('busy')).not.toBeNull();
      expect(ls.has('rd-usermap-import')).toBe(true);
    } finally {
      release();
      await held;
    }
    // Once no tab holds the lock, the same leftover breadcrumb is a crash.
    await session.initUserMaps();
    expect(st().userMaps.notice).toMatchObject({ kind: 'crashed', docId: 'busy' });
    session.dismissUserMapNotice();
    await tick();
  });

  it('an import that finishes after leaving the fire is listed, not shown, and flies nowhere later', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.importPdf.mockImplementationOnce(async (): Promise<ImportResult> => {
      await gate;
      return { ok: true, duplicate: false, maps: [meta('d1', 1)] };
    });
    st().actions.selectFire('fire-x');
    const p = session.addUserMapFile(new File(['d'], 'D.pdf'));
    await tick();
    st().actions.backToDirectory();
    h.track.mockClear();
    release();
    await p;
    expect(st().userMaps.list.map((m) => m.id)).toContain('d1-p1');
    expect(st().layers.userMap.id).toBeNull();
    expect(h.track).not.toHaveBeenCalledWith('map_overlay_shown', expect.anything());
    st().actions.selectFire('fire-y');
    const got: string[] = [];
    session.onUserMapAdded((m) => got.push(m.id))();
    expect(got).toEqual([]);

    // Shown with nobody listening, then a fire switch takes it down: the
    // queued fly-to goes with it.
    h.importPdf.mockResolvedValueOnce({ ok: true, duplicate: false, maps: [meta('d2', 1)] });
    await session.addUserMapFile(new File(['e'], 'E.pdf'));
    expect(st().layers.userMap.id).toBe('d2-p1');
    st().actions.selectFire('fire-z');
    session.onUserMapAdded((m) => got.push(m.id))();
    expect(got).toEqual([]);
  });

  // Last: it leaves crashCap at the floor.
  it('a crash at the lowest detail ends there: no Try again that would draw at 2 MP again', async () => {
    const floor = JSON.stringify({ docId: 'floor', fileName: 'F.pdf', budgetPx: 2e6, startedAt: 'x' });
    await storage.saveSource('floor', new Blob(['%PDF-']));
    ls.set('rd-usermap-import', floor);
    await session.initUserMaps();
    expect(st().userMaps.notice).toEqual({ kind: 'error', text: 'Couldn’t draw this map on this device.' });
    expect(ls.has('rd-usermap-import')).toBe(false);
    expect(await storage.readSource('floor')).toBeNull();
    expect(h.track).toHaveBeenCalledWith('user_map_import_failed', { reason: 'crashed', budget_mp: 2 });

    // A crash notice already up (shown before this fix) can't loop either.
    await storage.saveSource('floor', new Blob(['%PDF-']));
    ls.set('rd-usermap-import', floor);
    st().actions.setUserMapNotice({ kind: 'crashed', text: 'x', docId: 'floor' });
    await session.retryCrashedImport();
    expect(h.retryImport).not.toHaveBeenCalled();
    expect(st().userMaps.notice).toEqual({ kind: 'error', text: 'Couldn’t draw this map on this device.' });
    expect(await storage.readSource('floor')).toBeNull();
    expect(ls.has('rd-usermap-import')).toBe(false);
  });
});
