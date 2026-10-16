/**
 * importPdf / retryImport orchestration. pdf.js (./pdfRender), the /VP
 * reader (./pdfObjects) and the georef maths (./georef) are mocked — each
 * has its own tests — so these pin down the step order, the outcome of
 * every failure path, cleanup (no partial folder, no stale breadcrumb) and
 * what analytics may see. Storage is the real module in its session-only
 * (in-memory) mode, wrapped so the write order can be checked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Georef, GeoModel, ImportProgress, RawViewport } from './types';

type PageKind = 'georef' | 'far' | 'none' | 'broken' | 'noref';

const h = vi.hoisted(() => {
  const state = {
    pages: [] as PageKind[],
    renders: [] as { page: number; frame: number[]; budget: number; signal?: AbortSignal }[],
    /** The breadcrumb as seen while each page was drawn. */
    crumbs: [] as (string | null)[],
    /** byteLength of what the /VP reader got (pdf.js detaches its own copy). */
    viewportBytes: [] as number[],
    /** Calls to sniffPdf (the header sniff, plus any whole-file scan). */
    sniffs: 0,
    /** saveSource hits the quota. */
    diskFull: false,
    closed: 0,
    renderImpl: null as null | ((page: number, signal?: AbortSignal) => Promise<void>),
  };
  const storageCalls: string[] = [];
  const openPdf = vi.fn(async (bytes: Uint8Array) => {
    // pdf.js transfers the buffer to its worker: the caller's view goes empty.
    (bytes.buffer as ArrayBuffer & { transfer(): ArrayBuffer }).transfer();
    return {
      numPages: state.pages.length,
      pageObjNum: async (p: number) => (state.pages[p - 1] === 'noref' ? null : p * 10),
      renderCrop: async (
        page: number,
        frame: number[],
        budgetPx: number,
        signal?: AbortSignal,
        onAttempt?: (b: number) => void,
      ) => {
        onAttempt?.(budgetPx); // the real one reports each rung before drawing it
        state.renders.push({ page, frame, budget: budgetPx, signal });
        state.crumbs.push(localStorage.getItem('rd-usermap-import'));
        await state.renderImpl?.(page, signal);
        return {
          jpeg: new Blob([`jpeg${page}`], { type: 'image/jpeg' }),
          thumb: new Blob(['thumb'], { type: 'image/jpeg' }),
          width: 1000,
          height: 800,
          pageToImage: [10, 0, 0, -10, -100, 1000],
          budgetPx,
        };
      },
      close: async () => {
        state.closed++;
      },
    };
  });
  return { state, storageCalls, openPdf, track: vi.fn() };
});

vi.mock('../app/analytics', () => ({ track: h.track }));
vi.mock('./renderBudget', () => ({
  MAX_FILE_BYTES: 64 * 1024,
  MIN_BUDGET: 2e6,
  pixelBudget: () => 12e6,
}));
vi.mock('./pdfRender', () => ({ openPdf: h.openPdf }));
vi.mock('./pdfObjects', () => {
  class PdfParseError extends Error {}
  const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
  return {
    PdfParseError,
    sniffPdf: (b: Uint8Array) => {
      h.state.sniffs++;
      const isPdf = latin1(b.subarray(0, 1024)).includes('%PDF-');
      return {
        isPdf,
        encrypted: isPdf && latin1(b).includes('/Encrypt'),
        lgidict: isPdf && latin1(b).includes('LGIDict'),
      };
    },
    readPageViewports: async (b: Uint8Array, objNum: number): Promise<RawViewport[]> => {
      h.state.viewportBytes.push(b.byteLength);
      const kind = h.state.pages[objNum / 10 - 1];
      if (kind === 'broken') throw new PdfParseError('no such object');
      if (kind !== 'georef' && kind !== 'far') return [];
      return [{ bbox: [0, 0, 612, 792], name: null, geo: true, gpts: [], lpts: [], bounds: null, wkt: kind }];
    },
  };
});
vi.mock('./georef', () => ({
  georefFromViewports: (vps: RawViewport[]): Georef | null =>
    vps.length
      ? { v: 1, wkt: vps[0].wkt, frame: [10, 20, 110, 100], points: [], warnings: ['inset_in_frame'] }
      : null,
  buildGeoModel: (g: Georef): GeoModel => {
    // 'far' lands on null island; 'georef' near Lassen.
    const [lon0, lat0] = g.wkt === 'far' ? [0.1, 0.1] : [-120, 40];
    return {
      georef: g,
      approximate: false,
      fitResidualM: 0.5,
      metersPerPoint: 10,
      lonLatToPage: () => [0, 0],
      pageToLonLat: (x, y) => [lon0 + x / 1000, lat0 + y / 1000],
      footprint: () => [
        [lon0 + 0.01, lat0 + 0.02],
        [lon0 + 0.11, lat0 + 0.02],
        [lon0 + 0.11, lat0 + 0.1],
        [lon0 + 0.01, lat0 + 0.1],
      ],
    };
  },
  plausibleLocation: (m: GeoModel) => m.georef.wkt !== 'far',
}));
vi.mock('./storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./storage')>();
  const spy = <A extends unknown[], R>(name: string, f: (...a: A) => R) =>
    vi.fn((...a: A) => {
      h.storageCalls.push(name);
      return f(...a);
    });
  return {
    ...actual,
    saveSource: spy('saveSource', (docId: string, file: Blob) =>
      h.state.diskFull ? Promise.reject(new actual.StorageFullError()) : actual.saveSource(docId, file),
    ),
    savePageImages: spy('savePageImages', actual.savePageImages),
    writeMeta: spy('writeMeta', actual.writeMeta),
    deleteDoc: spy('deleteDoc', actual.deleteDoc),
    requestPersist: spy('requestPersist', actual.requestPersist),
  };
});

const ls = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => ls.get(k) ?? null,
  setItem: (k: string, v: string) => void ls.set(k, String(v)),
  removeItem: (k: string) => void ls.delete(k),
});

import * as storage from './storage';
import * as im from './importMap';

// ---------- helpers ----------

let fileCount = 0;
/** A distinct tiny "PDF" per call (distinct sha → distinct docId). */
const pdfFile = (name: string, extra = '') =>
  new File([`%PDF-1.7\n% file ${++fileCount} ${extra}\n%%EOF\n`], name, { type: 'application/pdf' });

async function docIdOf(f: Blob): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', await f.arrayBuffer());
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function run(file: File, opts: { signal?: AbortSignal; budgetPx?: number; onProgress?: (p: ImportProgress) => void } = {}) {
  const progress: ImportProgress[] = [];
  const result = im.importPdf(file, {
    signal: opts.signal,
    budgetPx: opts.budgetPx,
    onProgress: (p) => {
      progress.push(p);
      opts.onProgress?.(p);
    },
  });
  return { result, progress };
}

const tracked = (event: string) =>
  h.track.mock.calls.filter(([e]) => e === event).map(([, props]) => props as Record<string, unknown>);

/** The doc left nothing behind: no folder, no breadcrumb. */
async function expectCleanedUp(docId: string) {
  expect(await storage.readSource(docId)).toBeNull();
  expect(await storage.hasDoc(docId)).toBe(false);
  expect(ls.has(im.BREADCRUMB_KEY)).toBe(false);
}

beforeEach(() => {
  Object.assign(h.state, { pages: ['georef'], renders: [], crumbs: [], viewportBytes: [], sniffs: 0, diskFull: false, closed: 0, renderImpl: null });
  h.storageCalls.length = 0;
  h.track.mockClear();
  h.openPdf.mockClear();
  ls.clear();
});

// ---------- tests ----------

describe('importPdf: success', () => {
  it('adds a single-page map: steps in order, meta.json last, breadcrumb only while drawing', async () => {
    const file = pdfFile('Big Fire IAP.pdf');
    const docId = await docIdOf(file);
    const { result, progress } = run(file);
    const r = await result;

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.duplicate).toBe(false);
    expect(r.maps).toHaveLength(1);
    const m = r.maps[0];
    expect(m).toMatchObject({
      v: 1,
      id: `${docId}-p1`,
      docId,
      page: 1,
      pageCount: 1,
      title: 'Big Fire IAP',
      fileName: 'Big Fire IAP.pdf',
      fileBytes: file.size,
      image: { width: 1000, height: 800, bytes: 'jpeg1'.length, pageToImage: [10, 0, 0, -10, -100, 1000], budgetPx: 12e6 },
      maxzoom: 18, // 1 m per image px at 40.06°N
      warnings: ['inset_in_frame'],
    });
    expect(m.georef.frame).toEqual([10, 20, 110, 100]);
    m.bounds.forEach((v, i) => expect(v).toBeCloseTo([-119.99, 40.02, -119.89, 40.1][i], 9));
    expect(m.center[0]).toBeCloseTo(-119.94, 9);
    expect(m.center[1]).toBeCloseTo(40.06, 9);
    expect(Date.parse(m.addedAt)).not.toBeNaN();

    // Located before anything is saved: a PDF that isn't a map writes nothing.
    expect(progress.map((p) => p.stage)).toEqual(['reading', 'locating', 'saving', 'drawing', 'finishing']);
    expect(progress[3]).toEqual({ fileName: 'Big Fire IAP.pdf', stage: 'drawing', page: 1, pages: 1 });

    // Source first, images, then the commit; persistence asked once.
    expect(h.storageCalls).toEqual(['saveSource', 'savePageImages', 'writeMeta', 'requestPersist']);
    expect(await storage.readMeta(docId)).toEqual(r.maps);
    expect(m.mapPages).toEqual([1]);
    // Only the header sniff: the whole-file scan is for failures alone.
    expect(h.state.sniffs).toBe(1);
    expect(await (await storage.readPageImage(docId, 1))!.text()).toBe('jpeg1');
    expect(await (await storage.readSource(docId))!.text()).toBe(await file.text());

    // Breadcrumb set while drawing, gone after.
    expect(JSON.parse(h.state.crumbs[0]!)).toMatchObject({ docId, fileName: 'Big Fire IAP.pdf', budgetPx: 12e6 });
    expect(ls.has(im.BREADCRUMB_KEY)).toBe(false);

    // pdf.js got its own copy: detaching it left the /VP reader's intact.
    expect(h.openPdf.mock.calls[0][0].byteLength).toBe(0);
    expect(h.state.viewportBytes).toEqual([file.size]);
    expect(h.state.renders[0]).toMatchObject({ page: 1, frame: [10, 20, 110, 100], budget: 12e6 });
    expect(h.state.closed).toBe(1);

    expect(tracked('user_map_imported')).toEqual([
      { maps: 1, pages: 1, mb: 0, secs: 0, budget_mp: 12, retry: false },
    ]);
    // Never a name, title or coordinate.
    const sent = JSON.stringify(h.track.mock.calls);
    for (const leak of ['Big Fire', '.pdf', '-119', '40.0', docId]) expect(sent).not.toContain(leak);
  });

  it('makes one map per georeferenced page and skips the rest', async () => {
    h.state.pages = ['georef', 'none', 'georef', 'noref', 'broken'];
    const file = pdfFile('Division Maps.PDF');
    const { result, progress } = run(file);
    const r = await result;

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.maps.map((m) => [m.page, m.title, m.pageCount])).toEqual([
      [1, 'Division Maps · page 1', 5],
      [3, 'Division Maps · page 3', 5],
    ]);
    expect(new Set(r.maps.map((m) => m.addedAt)).size).toBe(1);
    expect(h.state.renders.map((x) => x.page)).toEqual([1, 3]);
    expect(progress.filter((p) => p.stage === 'drawing')).toEqual([
      { fileName: 'Division Maps.PDF', stage: 'drawing', page: 1, pages: 2 },
      { fileName: 'Division Maps.PDF', stage: 'drawing', page: 2, pages: 2 },
    ]);
    expect(h.storageCalls.filter((c) => c !== 'requestPersist')).toEqual([
      'saveSource',
      'savePageImages',
      'savePageImages',
      'writeMeta',
    ]);
    expect(h.storageCalls).not.toContain('requestPersist'); // first import only
    expect(tracked('user_map_imported')[0]).toMatchObject({ maps: 2, pages: 5 });
  });

  it('skips a page whose coordinates point nowhere when another page is fine', async () => {
    h.state.pages = ['far', 'georef'];
    const r = await run(pdfFile('Mixed.pdf')).result;
    expect(r.ok && r.maps.map((m) => [m.page, m.title])).toEqual([[2, 'Mixed']]);
  });

  it('a later page starts at the budget an earlier page had to step down to', async () => {
    h.state.pages = ['georef', 'georef'];
    h.openPdf.mockImplementationOnce(async (bytes: Uint8Array) => {
      const doc = await h.openPdf.getMockImplementation()!(bytes);
      return {
        ...doc,
        renderCrop: async (page: number, frame: number[], budget: number, signal?: AbortSignal, onAttempt?: (b: number) => void) => ({
          ...(await doc.renderCrop(page, frame, budget, signal, onAttempt)),
          budgetPx: Math.min(budget, 6e6),
        }),
      };
    });
    const r = await run(pdfFile('Two.pdf')).result;
    expect(r.ok).toBe(true);
    expect(h.state.renders.map((x) => x.budget)).toEqual([12e6, 6e6]);
    expect(JSON.parse(h.state.crumbs[1]!).budgetPx).toBe(6e6);
    expect(tracked('user_map_imported')[0].budget_mp).toBe(6);
  });

  it('the breadcrumb names the budget being drawn as renderCrop steps down, not the one it started at', async () => {
    const seen: number[] = [];
    h.openPdf.mockImplementationOnce(async (bytes: Uint8Array) => {
      const doc = await h.openPdf.getMockImplementation()!(bytes);
      return {
        ...doc,
        // 12 MP fails silently (no canvas); iOS would kill the tab during 6 MP.
        renderCrop: async (page: number, frame: number[], budget: number, signal?: AbortSignal, onAttempt?: (b: number) => void) => {
          onAttempt?.(budget);
          seen.push(im.readBreadcrumb()!.budgetPx);
          onAttempt?.(budget / 2);
          seen.push(im.readBreadcrumb()!.budgetPx);
          return { ...(await doc.renderCrop(page, frame, budget / 2, signal)), budgetPx: budget / 2 };
        },
      };
    });
    const r = await run(pdfFile('Ladder.pdf')).result;
    expect(r.ok).toBe(true);
    // A crash retry halves 6 MP (the rung that died), not 12.
    expect(seen).toEqual([12e6, 6e6]);
  });

  it('re-adding the same file is a duplicate: no work, the saved maps back', async () => {
    const file = pdfFile('Same.pdf');
    const first = await run(file).result;
    h.storageCalls.length = 0;
    h.openPdf.mockClear();
    h.track.mockClear();

    const again = new File([await file.arrayBuffer()], 'renamed copy.pdf');
    const { result, progress } = run(again);
    const r = await result;
    expect(r).toEqual({ ok: true, maps: first.ok ? first.maps : [], duplicate: true });
    expect(progress.map((p) => p.stage)).toEqual(['reading']);
    expect(h.storageCalls).toEqual([]);
    expect(h.openPdf).not.toHaveBeenCalled();
    expect(h.track).not.toHaveBeenCalled();
  });
});

describe('importPdf: re-adding a saved PDF', () => {
  async function importPacket(name: string) {
    h.state.pages = ['georef', 'georef', 'georef'];
    const file = pdfFile(name);
    const docId = await docIdOf(file);
    const first = await run(file).result;
    if (!first.ok) throw new Error('setup import failed');
    Object.assign(h.state, { renders: [], crumbs: [] });
    h.storageCalls.length = 0;
    h.track.mockClear();
    h.openPdf.mockClear();
    return { file, docId, first: first.maps };
  }

  /** What session.deleteUserMap does to remove one map of several. */
  async function removePage(docId: string, maps: { page: number }[], page: number) {
    await storage.writeMeta(docId, maps.filter((m) => m.page !== page) as never);
    await storage.deletePageImages(docId, page);
    h.storageCalls.length = 0;
  }

  it('brings back a map removed since: draws that page only, the others stay as saved', async () => {
    const { file, docId, first } = await importPacket('Packet.pdf');
    await removePage(docId, first, 2);

    const { result, progress } = run(new File([await file.arrayBuffer()], 'renamed copy.pdf'));
    const r = await result;
    expect(r.ok && !r.duplicate).toBe(true);
    if (!r.ok) return;
    // The one that came back leads (the session shows it); same name and
    // date as its siblings so the list keeps the doc together.
    expect(r.maps.map((m) => m.page)).toEqual([2, 1, 3]);
    expect(r.maps[0]).toMatchObject({
      title: 'Packet · page 2',
      fileName: 'Packet.pdf',
      addedAt: first[0].addedAt,
      mapPages: [1, 2, 3],
    });
    expect(r.maps.slice(1)).toEqual([first[0], first[2]]);
    expect(h.state.renders.map((x) => x.page)).toEqual([2]);
    expect(progress.filter((p) => p.stage === 'drawing')).toEqual([
      { fileName: 'renamed copy.pdf', stage: 'drawing', page: 1, pages: 1 },
    ]);
    expect(h.storageCalls).toEqual(['savePageImages', 'writeMeta']); // no source re-save
    expect((await storage.readMeta(docId))!.map((m) => m.page)).toEqual([1, 2, 3]);
    expect(await (await storage.readPageImage(docId, 2))!.text()).toBe('jpeg2');
    expect(ls.has(im.BREADCRUMB_KEY)).toBe(false);
  });

  it('redraws a saved map whose image went missing', async () => {
    const { file, docId } = await importPacket('Lost.pdf');
    await storage.deletePageImages(docId, 1);
    const r = await run(file).result;
    expect(r.ok && !r.duplicate).toBe(true);
    expect(h.state.renders.map((x) => x.page)).toEqual([1]);
    expect(await storage.readPageImage(docId, 1)).not.toBeNull();
  });

  it('a failure (or Cancel) while bringing a map back never touches the saved doc', async () => {
    const { file, docId, first } = await importPacket('Keep.pdf');
    await removePage(docId, first, 3);
    h.state.renderImpl = async () => {
      throw new Error('canvas');
    };
    const r = await run(file).result;
    expect(r).toMatchObject({ ok: false, reason: 'render_failed' });
    expect(h.storageCalls).not.toContain('deleteDoc');
    expect((await storage.readMeta(docId))!.map((m) => m.page)).toEqual([1, 2]);
    expect(await storage.readSource(docId)).not.toBeNull();
    expect(await storage.readPageImage(docId, 1)).not.toBeNull();
  });
});

describe('importPdf: failures', () => {
  async function expectFailure(file: File, reason: string, opts?: Parameters<typeof run>[1]) {
    const r = await run(file, opts).result;
    expect(r).toEqual({ ok: false, reason, message: im.failureMessage(r.ok ? 'not_pdf' : r.reason) });
    expect(tracked('user_map_import_failed')).toEqual([{ reason, retry: false }]);
    await expectCleanedUp(await docIdOf(file));
    return r;
  }

  it('too_large: refused before reading', async () => {
    const big = new File([new Uint8Array(64 * 1024 + 1)], 'huge.pdf');
    await expectFailure(big, 'too_large');
    expect(h.storageCalls).toEqual([]);
  });

  it('not_pdf: refused from the header, nothing saved', async () => {
    await expectFailure(new File(['<html>hello</html>'], 'map.pdf'), 'not_pdf');
    h.track.mockClear();
    await expectFailure(new File([], 'empty.pdf'), 'not_pdf');
    expect(h.storageCalls).toEqual([]);
  });

  it('no_georef: no page has map coordinates', async () => {
    h.state.pages = ['none', 'none'];
    await expectFailure(pdfFile('IAP.pdf'), 'no_georef');
    expect(h.storageCalls).toEqual([]); // nothing written for a PDF that isn't a map
    expect(h.state.renders).toEqual([]);
    expect(h.state.closed).toBe(1);
  });

  it('a PDF that isn’t a map gets its real answer on a full disk, not storage_full', async () => {
    h.state.diskFull = true;
    h.state.pages = ['none'];
    await expectFailure(pdfFile('Plain.pdf'), 'no_georef');
    h.track.mockClear();
    h.state.pages = ['broken'];
    await expectFailure(pdfFile('Locked2.pdf', 'trailer << /Encrypt 5 0 R >>'), 'encrypted');
  });

  it('encrypted: an /Encrypt trailer explains missing coordinates', async () => {
    h.state.pages = ['broken'];
    await expectFailure(pdfFile('Locked.pdf', 'trailer << /Encrypt 5 0 R >>'), 'encrypted');
  });

  it('encrypted: pdf.js asks for a password', async () => {
    h.openPdf.mockRejectedValueOnce(Object.assign(new Error('No password given'), { name: 'PasswordException' }));
    await expectFailure(pdfFile('Pw.pdf'), 'encrypted');
  });

  it('lgidict: TerraGo-style georeferencing', async () => {
    h.state.pages = ['none'];
    await expectFailure(pdfFile('Terra.pdf', '/LGIDict 7 0 R'), 'lgidict');
  });

  it('parse_fail: pages that cannot be read and nothing found', async () => {
    h.state.pages = ['broken', 'none'];
    await expectFailure(pdfFile('Odd.pdf'), 'parse_fail');
    h.track.mockClear();
    h.openPdf.mockRejectedValueOnce(Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' }));
    await expectFailure(pdfFile('Corrupt.pdf'), 'parse_fail');
  });

  it('bad_location: every georeferenced page lands nowhere real', async () => {
    h.state.pages = ['far', 'none', 'far'];
    await expectFailure(pdfFile('Null Island.pdf'), 'bad_location');
    expect(h.state.renders).toEqual([]);
  });

  it('render_failed: the page can’t be drawn on this device', async () => {
    h.state.renderImpl = async () => {
      throw new Error('canvas allocation failed');
    };
    await expectFailure(pdfFile('Huge Sheet.pdf'), 'render_failed');
    expect(h.state.closed).toBe(1);
  });

  it('storage_full: quota hit while saving a page image', async () => {
    h.state.pages = ['georef', 'georef'];
    vi.mocked(storage.savePageImages).mockImplementationOnce(async () => {
      h.storageCalls.push('savePageImages');
      throw new storage.StorageFullError();
    });
    await expectFailure(pdfFile('Full.pdf'), 'storage_full');
    expect(h.storageCalls).toEqual(['saveSource', 'savePageImages', 'deleteDoc']);
    expect(h.state.renders).toHaveLength(1);
  });

  it('storage_full: quota hit while saving the source (of a real map)', async () => {
    h.state.diskFull = true;
    await expectFailure(pdfFile('Full2.pdf'), 'storage_full');
    expect(h.storageCalls).toEqual(['saveSource', 'deleteDoc']);
    expect(h.state.renders).toEqual([]);
  });

  it('offline: pdf.js can’t fetch its worker', async () => {
    h.openPdf.mockRejectedValueOnce(new Error('Setting up fake worker failed: "Failed to fetch dynamically imported module"'));
    await expectFailure(pdfFile('NoNet.pdf'), 'offline');
  });

  it('cancelled while drawing: the signal reaches renderCrop, everything is undone', async () => {
    const ctl = new AbortController();
    h.state.renderImpl = async (_page, signal) => {
      expect(signal).toBe(ctl.signal);
      ctl.abort(); // the user taps Cancel; pdf.js rejects the render
      throw Object.assign(new Error('Rendering cancelled'), { name: 'AbortError' });
    };
    const file = pdfFile('Cancel.pdf');
    const r = await run(file, { signal: ctl.signal }).result;
    expect(r).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(h.storageCalls).toEqual(['saveSource', 'deleteDoc']);
    expect(h.state.closed).toBe(1);
    await expectCleanedUp(await docIdOf(file));
  });

  it('cancelled between steps: stops at the next step and reports no more progress', async () => {
    const ctl = new AbortController();
    const file = pdfFile('Cancel2.pdf');
    const { result, progress } = run(file, {
      signal: ctl.signal,
      onProgress: (p) => p.stage === 'locating' && ctl.abort(),
    });
    expect(await result).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(progress.map((p) => p.stage)).toEqual(['reading', 'locating']);
    expect(h.openPdf).not.toHaveBeenCalled();
    await expectCleanedUp(await docIdOf(file));
    expect(tracked('user_map_import_failed')).toEqual([{ reason: 'cancelled', retry: false }]);
  });

  it('a failure never clears another doc’s crash breadcrumb it didn’t write', async () => {
    const crumb = { docId: 'other', fileName: 'x.pdf', budgetPx: 12e6, startedAt: '2026-10-16T00:00:00.000Z' };
    ls.set(im.BREADCRUMB_KEY, JSON.stringify(crumb));
    await run(new File(['nope'], 'a.pdf')).result;
    expect(im.readBreadcrumb()).toEqual(crumb);
  });
});

describe('importPdf: leaving the page mid-import', () => {
  /** addEventListener/removeEventListener on a fake window (node has none). */
  function fakeWindow() {
    const handlers = new Map<string, Set<() => void>>();
    const g = globalThis as unknown as Record<string, unknown>;
    g.addEventListener = (t: string, f: () => void) => {
      if (!handlers.has(t)) handlers.set(t, new Set());
      handlers.get(t)!.add(f);
    };
    g.removeEventListener = (t: string, f: () => void) => void handlers.get(t)?.delete(f);
    return {
      fire: (t: string) => handlers.get(t)?.forEach((f) => f()),
      listening: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
      restore: () => {
        delete g.addEventListener;
        delete g.removeEventListener;
      },
    };
  }

  it('a reload or tab close (pagehide) is not a crash: the breadcrumb goes; shown again, it’s back', async () => {
    const win = fakeWindow();
    try {
      let drawing!: () => void;
      let finish!: () => void;
      const started = new Promise<void>((r) => (drawing = r));
      const gate = new Promise<void>((r) => (finish = r));
      h.state.renderImpl = async () => {
        drawing();
        await gate;
      };
      const file = pdfFile('Closing.pdf');
      const docId = await docIdOf(file);
      const { result } = run(file);
      await started;
      expect(im.readBreadcrumb()?.docId).toBe(docId);

      win.fire('pagehide'); // iOS killing the tab fires nothing, so a real crash keeps it
      expect(im.readBreadcrumb()).toBeNull();
      win.fire('pageshow'); // back/forward cache brought the page back mid-import
      expect(im.readBreadcrumb()).toMatchObject({ docId, budgetPx: 12e6 });

      finish();
      expect((await result).ok).toBe(true);
      expect(im.readBreadcrumb()).toBeNull();
      expect(win.listening()).toBe(0);
    } finally {
      win.restore();
    }
  });

  it('a reload during a crash retry leaves the crash’s own breadcrumb, so the next visit still offers it', async () => {
    const win = fakeWindow();
    try {
      const file = pdfFile('Retry reload.pdf');
      const docId = await docIdOf(file);
      await storage.saveSource(docId, file);
      const crumb = { docId, fileName: 'Retry reload.pdf', budgetPx: 6e6, startedAt: 'x' };
      ls.set(im.BREADCRUMB_KEY, JSON.stringify(crumb));
      const seen: unknown[] = [];
      h.state.renderImpl = async () => {
        seen.push(im.readBreadcrumb()?.budgetPx); // the retry's own while drawing
        win.fire('pagehide');
        seen.push(im.readBreadcrumb());
      };
      await im.retryImport(docId, 3e6, () => undefined);
      expect(seen).toEqual([3e6, crumb]);
    } finally {
      win.restore();
    }
  });

  it('after pagehide, a lower rung tried as the page unloads writes no breadcrumb back', async () => {
    const win = fakeWindow();
    try {
      const seen: boolean[] = [];
      h.openPdf.mockImplementationOnce(async (bytes: Uint8Array) => {
        const doc = await h.openPdf.getMockImplementation()!(bytes);
        return {
          ...doc,
          renderCrop: async (_p: number, _f: number[], budget: number, _s?: AbortSignal, onAttempt?: (b: number) => void) => {
            onAttempt?.(budget);
            seen.push(ls.has(im.BREADCRUMB_KEY));
            win.fire('pagehide');
            onAttempt?.(budget / 2);
            seen.push(ls.has(im.BREADCRUMB_KEY));
            throw new Error('canvas'); // never mind the rest: the page is gone
          },
        };
      });
      await run(pdfFile('Unloading.pdf')).result;
      expect(seen).toEqual([true, false]);
      expect(ls.has(im.BREADCRUMB_KEY)).toBe(false);
    } finally {
      win.restore();
    }
  });
});

describe('crash recovery', () => {
  it('re-adding the file that crashed last time starts at half its budget', async () => {
    const file = pdfFile('Crashy.pdf');
    const docId = await docIdOf(file);
    ls.set(im.BREADCRUMB_KEY, JSON.stringify({ docId, fileName: 'Crashy.pdf', budgetPx: 12e6, startedAt: 'x' }));
    const r = await run(file).result;
    expect(r.ok).toBe(true);
    expect(h.state.renders[0].budget).toBe(6e6);
    expect(ls.has(im.BREADCRUMB_KEY)).toBe(false);
  });

  it('retryImport redraws from the saved source.pdf at the given budget', async () => {
    const file = pdfFile('Saved.pdf');
    const docId = await docIdOf(file);
    await storage.saveSource(docId, file);
    ls.set(im.BREADCRUMB_KEY, JSON.stringify({ docId, fileName: 'Saved.pdf', budgetPx: 6e6, startedAt: 'x' }));
    h.storageCalls.length = 0;

    const progress: ImportProgress[] = [];
    const r = await im.retryImport(docId, 3e6, (p) => progress.push(p));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.maps[0]).toMatchObject({ id: `${docId}-p1`, title: 'Saved', fileName: 'Saved.pdf', fileBytes: file.size });
    expect(h.state.renders[0].budget).toBe(3e6);
    expect(JSON.parse(h.state.crumbs[0]!).budgetPx).toBe(3e6);
    expect(h.storageCalls).toEqual(['savePageImages', 'writeMeta']); // source not re-saved
    expect(progress.map((p) => p.stage)).toEqual(['reading', 'locating', 'drawing', 'finishing']);
    expect(ls.has(im.BREADCRUMB_KEY)).toBe(false);
    expect(tracked('user_map_imported')[0]).toMatchObject({ retry: true, budget_mp: 3 });
  });

  it('a failed retry takes the saved source with it', async () => {
    h.state.renderImpl = async () => {
      throw new Error('canvas');
    };
    const file = pdfFile('Again.pdf');
    const docId = await docIdOf(file);
    await storage.saveSource(docId, file);
    ls.set(im.BREADCRUMB_KEY, JSON.stringify({ docId, fileName: 'Again.pdf', budgetPx: 6e6, startedAt: 'x' }));
    const r = await im.retryImport(docId, 3e6, () => undefined);
    expect(r).toMatchObject({ ok: false, reason: 'render_failed' });
    await expectCleanedUp(docId);
  });

  it('a retry that fails for good before drawing also drops the source and the crash breadcrumb', async () => {
    const file = pdfFile('Gone.pdf');
    const docId = await docIdOf(file);
    await storage.saveSource(docId, file);
    ls.set(im.BREADCRUMB_KEY, JSON.stringify({ docId, fileName: 'Gone.pdf', budgetPx: 6e6, startedAt: 'x' }));
    h.openPdf.mockRejectedValueOnce(Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' }));
    expect(await im.retryImport(docId, 3e6, () => undefined)).toMatchObject({ ok: false, reason: 'parse_fail' });
    await expectCleanedUp(docId);
  });

  it('a retry with no connection keeps the saved source and the crash breadcrumb for later', async () => {
    const file = pdfFile('Camp.pdf');
    const docId = await docIdOf(file);
    await storage.saveSource(docId, file);
    const crumb = { docId, fileName: 'Camp.pdf', budgetPx: 6e6, startedAt: 'x' };
    ls.set(im.BREADCRUMB_KEY, JSON.stringify(crumb));
    h.openPdf.mockRejectedValueOnce(new TypeError('Failed to fetch /assets/pdfjs/6.3.289/openjpeg.wasm'));
    const r = await im.retryImport(docId, 3e6, () => undefined);
    expect(r).toMatchObject({ ok: false, reason: 'offline' });
    expect(im.retryKeepsSource('offline')).toBe(true);
    expect(await storage.readSource(docId)).not.toBeNull();
    expect(im.readBreadcrumb()).toEqual(crumb);
    expect(tracked('user_map_import_failed')).toEqual([{ reason: 'offline', retry: true }]);
  });

  it('a retry cancelled mid-draw puts the crash’s breadcrumb back, so Try again halves from it again', async () => {
    const file = pdfFile('Stop.pdf');
    const docId = await docIdOf(file);
    await storage.saveSource(docId, file);
    const crumb = { docId, fileName: 'Stop.pdf', budgetPx: 6e6, startedAt: 'x' };
    ls.set(im.BREADCRUMB_KEY, JSON.stringify(crumb));
    const ctl = new AbortController();
    h.state.renderImpl = async () => {
      ctl.abort();
      throw Object.assign(new Error('Rendering cancelled'), { name: 'AbortError' });
    };
    const r = await im.retryImport(docId, 3e6, () => undefined, { signal: ctl.signal });
    expect(r).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(JSON.parse(h.state.crumbs[0]!).budgetPx).toBe(3e6); // the retry's own while it drew
    expect(im.readBreadcrumb()).toEqual(crumb); // not 3e6: nothing crashed
    expect(await storage.readSource(docId)).not.toBeNull();
  });

  it('a failed retry never deletes a doc another tab committed while it drew', async () => {
    const file = pdfFile('Two tabs.pdf');
    const docId = await docIdOf(file);
    const done = await run(file).result;
    if (!done.ok) throw new Error('setup import failed');
    await storage.deleteDoc(docId);
    await storage.saveSource(docId, file);
    ls.set(im.BREADCRUMB_KEY, JSON.stringify({ docId, fileName: 'Two tabs.pdf', budgetPx: 6e6, startedAt: 'x' }));
    h.state.renderImpl = async () => {
      await storage.writeMeta(docId, done.maps); // the other tab finishes first
      throw new Error('canvas');
    };
    const r = await im.retryImport(docId, 3e6, () => undefined);
    expect(r).toMatchObject({ ok: false, reason: 'render_failed' });
    expect(await storage.readMeta(docId)).toEqual(done.maps);
    expect(await storage.readSource(docId)).not.toBeNull();
  });

  it('retryImport without a saved source fails cleanly', async () => {
    ls.set(im.BREADCRUMB_KEY, JSON.stringify({ docId: 'gone', fileName: 'g.pdf', budgetPx: 6e6, startedAt: 'x' }));
    const r = await im.retryImport('gone', 3e6, () => undefined);
    expect(r).toMatchObject({ ok: false, reason: 'parse_fail' });
    expect(ls.has(im.BREADCRUMB_KEY)).toBe(false);
  });

  it('readBreadcrumb ignores junk', () => {
    ls.set(im.BREADCRUMB_KEY, '{oops');
    expect(im.readBreadcrumb()).toBeNull();
    ls.set(im.BREADCRUMB_KEY, JSON.stringify({ docId: 1 }));
    expect(im.readBreadcrumb()).toBeNull();
    im.clearBreadcrumb();
    expect(ls.size).toBe(0);
  });
});

describe('helpers', () => {
  const model = (metersPerPoint: number, lat: number) =>
    ({ metersPerPoint, pageToLonLat: () => [-120, lat] }) as unknown as GeoModel;

  it('nativeMaxZoom: one level past native resolution, clamped to 0..22', () => {
    // 100 pt frame over 1000 px at 10 m/pt = 1 m/px: log2(156543·cos40°) = 16.87 → 17 + 1.
    expect(im.nativeMaxZoom(model(10, 40), { width: 1000, height: 800 }, [0, 0, 100, 80])).toBe(18);
    // Twice the pixels → one more level.
    expect(im.nativeMaxZoom(model(10, 40), { width: 2000, height: 1600 }, [0, 0, 100, 80])).toBe(19);
    // A /Rotate 90 page draws the frame sideways: same resolution, same zoom.
    expect(im.nativeMaxZoom(model(10, 40), { width: 1600, height: 2000 }, [0, 0, 100, 80])).toBe(19);
    expect(im.nativeMaxZoom(model(1e-6, 40), { width: 1000, height: 800 }, [0, 0, 100, 80])).toBe(22);
    expect(im.nativeMaxZoom(model(1e9, 40), { width: 1000, height: 800 }, [0, 0, 100, 80])).toBe(0);
  });

  it('failureMessage gives the firefighter wording', () => {
    expect(im.failureMessage('no_georef')).toBe('This PDF has no map coordinates, so it can’t go on the map.');
    expect(im.failureMessage('offline')).toBe('Adding a map needs a connection the first time.');
    expect(im.failureMessage('duplicate')).toBe('That map is already in My maps.');
    expect(im.failureMessage('crashed')).toBe(
      'The last map ran out of memory while drawing. Try again at lower detail?',
    );
  });
});

// Last: it swaps the module registry.
describe('importPdf: offline', () => {
  it('the pdf.js chunk can’t be loaded: offline, or (online) a deploy renamed it — before any write', async () => {
    vi.resetModules();
    vi.doMock('./pdfRender', () => {
      throw new TypeError('Failed to fetch dynamically imported module: /assets/pdfjs/pdfRender-abc.js');
    });
    const nav = globalThis.navigator as unknown as Record<string, unknown>;
    try {
      const fresh = await import('./importMap');
      const freshStorage = await import('./storage');
      Object.defineProperty(nav, 'onLine', { value: false, configurable: true });
      const file = pdfFile('Offline.pdf');
      const docId = await docIdOf(file);
      const r = await fresh.importPdf(file, { onProgress: () => undefined });
      expect(r).toEqual({ ok: false, reason: 'offline', message: 'Adding a map needs a connection the first time.' });
      expect(h.storageCalls).toEqual([]); // failed before the 150 MB source write
      expect(await freshStorage.readSource(docId)).toBeNull();
      expect(ls.has(im.BREADCRUMB_KEY)).toBe(false);
      expect(h.openPdf).not.toHaveBeenCalled();
      expect(tracked('user_map_import_failed')).toEqual([{ reason: 'offline', retry: false }]);

      h.track.mockClear();
      Object.defineProperty(nav, 'onLine', { value: true, configurable: true });
      const r2 = await fresh.importPdf(pdfFile('Stale tab.pdf'), { onProgress: () => undefined });
      expect(r2).toEqual({
        ok: false,
        reason: 'load_failed',
        message: 'Couldn’t load the map reader. Reload the page and try again.',
      });
      expect(tracked('user_map_import_failed')).toEqual([{ reason: 'load_failed', retry: false }]);
    } finally {
      delete nav.onLine;
      vi.doMock('./pdfRender', () => ({ openPdf: h.openPdf }));
    }
  });
});
