/**
 * My maps storage over an in-memory OPFS (directory/file handles with
 * createWritable, getFile, removeEntry and entries, behaving like the real
 * thing where it matters: getFileHandle({create}) makes an empty file, a
 * write lands only on close(), quota errors are DOMExceptions), then the
 * session-only fallback when OPFS writes are missing or getDirectory()
 * rejects.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserMapMeta } from './types';

// ---------- in-memory OPFS ----------

const notFound = () => new DOMException('not found', 'NotFoundError');
const fs = {
  log: [] as string[],
  /** Every chunk handed to a writable's write(), for identity checks. */
  written: [] as unknown[],
  quotaBytes: Infinity,
  usedBytes: 0,
};

class MockFileHandle {
  readonly kind = 'file';
  constructor(
    readonly name: string,
    private readonly dir: MockDir,
  ) {}
  async getFile(): Promise<File> {
    const b = this.dir.files.get(this.name);
    if (!b) throw notFound();
    return new File([b], this.name, { type: b.type });
  }
  async createWritable() {
    const chunks: Blob[] = [];
    let size = 0;
    const path = this.dir.path + this.name;
    return {
      write: async (d: Blob | string) => {
        fs.written.push(d);
        const part = typeof d === 'string' ? new Blob([d]) : d;
        if (fs.usedBytes + size + part.size > fs.quotaBytes) {
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        }
        chunks.push(part);
        size += part.size;
      },
      close: async () => {
        this.dir.files.set(this.name, new Blob(chunks));
        fs.usedBytes += size;
        fs.log.push(`write ${path}`);
      },
      abort: async () => {
        fs.log.push(`abort ${path}`);
      },
    };
  }
}

class MockDir {
  readonly kind = 'directory';
  readonly dirs = new Map<string, MockDir>();
  readonly files = new Map<string, Blob>();
  constructor(readonly path: string) {}
  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let d = this.dirs.get(name);
    if (!d) {
      if (!opts?.create) throw notFound();
      this.dirs.set(name, (d = new MockDir(`${this.path}${name}/`)));
    }
    return d;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (!opts?.create) throw notFound();
      this.files.set(name, new Blob([])); // real OPFS: empty file right away
    }
    return new MockFileHandle(name, this);
  }
  async removeEntry(name: string, opts?: { recursive?: boolean }) {
    const d = this.dirs.get(name);
    if (d) {
      if ((d.dirs.size || d.files.size) && !opts?.recursive) {
        throw new DOMException('not empty', 'InvalidModificationError');
      }
      this.dirs.delete(name);
    } else if (!this.files.delete(name)) {
      throw notFound();
    }
    fs.log.push(`rm ${this.path}${name}`);
  }
  async *entries(): AsyncGenerator<[string, MockDir | MockFileHandle]> {
    for (const [n, d] of this.dirs) yield [n, d];
    for (const n of this.files.keys()) yield [n, new MockFileHandle(n, this)];
  }
}

let top = new MockDir('/');
const persist = vi.fn(async () => true);
const getDirectory = vi.fn(async () => top);
vi.stubGlobal('navigator', { storage: { getDirectory, persist } });
vi.stubGlobal('FileSystemFileHandle', MockFileHandle);

const storage = await import('./storage');

const docDir = (docId: string) => top.dirs.get('user-maps')?.dirs.get(docId);
const text = async (b: Blob | null) => (b ? await b.text() : null);

function meta(docId: string, page: number, addedAt: string, over: Partial<UserMapMeta> = {}): UserMapMeta {
  return {
    v: 1,
    id: `${docId}-p${page}`,
    docId,
    page,
    pageCount: 3,
    title: `Map ${docId} · page ${page}`,
    fileName: `${docId}.pdf`,
    fileBytes: 1234,
    addedAt,
    image: { width: 100, height: 80, bytes: 99, pageToImage: [1, 0, 0, -1, 0, 80], budgetPx: 12e6 },
    georef: {
      v: 1,
      wkt: null,
      frame: [0, 0, 100, 80],
      points: [
        { page: [0, 0], lonLat: [-120, 40] },
        { page: [100, 0], lonLat: [-119, 40] },
        { page: [100, 80], lonLat: [-119, 41] },
        { page: [0, 80], lonLat: [-120, 41] },
      ],
      warnings: [],
    },
    bounds: [-120, 40, -119, 41],
    center: [-119.5, 40.5],
    maxzoom: 15,
    warnings: [],
    ...over,
  };
}

beforeEach(() => {
  top = new MockDir('/');
  fs.log.length = 0;
  fs.written.length = 0;
  fs.quotaBytes = Infinity;
  fs.usedBytes = 0;
  persist.mockClear();
});
afterAll(() => vi.unstubAllGlobals());

describe('user map storage (OPFS)', () => {
  it('keeps each doc in its own user-maps/{docId}/ folder, never under packs/', async () => {
    expect(storage.userMapsPersistent()).toBe(true);
    const src = new File(['%PDF-1.7 hello'], 'Big Fire.pdf', { type: 'application/pdf' });
    await storage.saveSource('abc', src);
    await storage.savePageImages('abc', 2, new Blob(['jpeg2']), new Blob(['thumb2']));

    expect(top.dirs.has('packs')).toBe(false);
    expect([...docDir('abc')!.files.keys()].sort()).toEqual(['p2.jpg', 'p2.thumb.jpg', 'source.pdf']);
    expect(await text(await storage.readSource('abc'))).toBe('%PDF-1.7 hello');
    expect(await text(await storage.readPageImage('abc', 2))).toBe('jpeg2');
    expect(await text(await storage.readThumb('abc', 2))).toBe('thumb2');
    expect(await storage.readPageImage('abc', 1)).toBeNull();
    expect(await storage.readSource('nope')).toBeNull();
  });

  it('writes the picked File itself — no ArrayBuffer copy', async () => {
    const src = new File(['%PDF-1.7'], 'a.pdf');
    await storage.saveSource('abc', src);
    expect(fs.written).toHaveLength(1);
    expect(fs.written[0]).toBe(src);
  });

  it('a doc exists only once meta.json is written (last)', async () => {
    await storage.saveSource('abc', new Blob(['%PDF-']));
    await storage.savePageImages('abc', 1, new Blob(['j']), new Blob(['t']));
    expect(await storage.hasDoc('abc')).toBe(false);
    expect(await storage.listUserMaps('abc')).toEqual([]);

    await storage.writeMeta('abc', [meta('abc', 1, '2026-10-16T10:00:00.000Z')]);
    expect(fs.log.at(-1)).toBe('write /user-maps/abc/meta.json');
    expect(await storage.hasDoc('abc')).toBe(true);
    expect((await storage.listUserMaps()).map((m) => m.id)).toEqual(['abc-p1']);
    expect((await storage.readMeta('abc'))?.[0].title).toBe('Map abc · page 1');
  });

  it('listing deletes unfinished imports except the kept (crashed) one', async () => {
    await storage.saveSource('done', new Blob(['%PDF-']));
    await storage.writeMeta('done', [meta('done', 1, '2026-10-16T10:00:00.000Z')]);
    await storage.saveSource('partial', new Blob(['%PDF-']));
    await storage.savePageImages('partial', 1, new Blob(['j']), new Blob(['t']));
    await storage.saveSource('crashed', new Blob(['%PDF-']));

    const list = await storage.listUserMaps('crashed');
    expect(list.map((m) => m.docId)).toEqual(['done']);
    expect(docDir('partial')).toBeUndefined();
    expect(docDir('crashed')?.files.has('source.pdf')).toBe(true);
    expect(fs.log).toContain('rm /user-maps/partial');

    // Without a keeper, the crashed folder goes too.
    await storage.listUserMaps();
    expect(docDir('crashed')).toBeUndefined();
    expect(docDir('done')).toBeDefined();
  });

  it('an empty meta.json (writable never closed) counts as unfinished', async () => {
    await storage.saveSource('half', new Blob(['%PDF-']));
    await docDir('half')!.getFileHandle('meta.json', { create: true });
    expect(await storage.hasDoc('half')).toBe(false);
    await storage.listUserMaps();
    expect(docDir('half')).toBeUndefined();
  });

  it('validates meta (v1, required fields) and skips — never deletes — what it cannot read', async () => {
    const good = meta('ok', 1, '2026-10-16T10:00:00.000Z');
    await storage.writeMeta('ok', [good, { ...meta('ok', 2, good.addedAt), v: 2 } as unknown as UserMapMeta]);
    await storage.writeMeta('future', [{ ...meta('future', 1, good.addedAt), v: 2 } as unknown as UserMapMeta]);
    await storage.writeMeta('noBounds', [{ ...meta('noBounds', 1, good.addedAt), bounds: undefined } as unknown as UserMapMeta]);
    await storage.writeMeta('wrongId', [meta('wrongId', 1, good.addedAt, { id: 'other-p1' })]);
    const junk = await (await top.dirs.get('user-maps')!.getDirectoryHandle('junk', { create: true }))
      .getFileHandle('meta.json', { create: true });
    const w = await junk.createWritable();
    await w.write('{not json');
    await w.close();

    const list = await storage.listUserMaps();
    expect(list.map((m) => m.id)).toEqual(['ok-p1']);
    for (const kept of ['future', 'noBounds', 'wrongId', 'junk']) expect(docDir(kept)).toBeDefined();
    expect(await storage.readMeta('junk')).toBeNull();
  });

  it('sorts newest import first, a PDF’s pages together in page order', async () => {
    await storage.writeMeta('old', [meta('old', 1, '2026-10-01T00:00:00.000Z')]);
    await storage.writeMeta('new', [
      meta('new', 3, '2026-10-16T09:00:00.000Z'),
      meta('new', 1, '2026-10-16T09:00:00.000Z'),
    ]);
    await storage.writeMeta('mid', [meta('mid', 2, '2026-10-10T00:00:00.000Z')]);
    expect((await storage.listUserMaps()).map((m) => m.id)).toEqual([
      'new-p1',
      'new-p3',
      'mid-p2',
      'old-p1',
    ]);
  });

  it('QuotaExceededError becomes StorageFullError and leaves no content behind', async () => {
    fs.quotaBytes = 10;
    const err = await storage
      .saveSource('big', new Blob(['%PDF-1.7 this is more than ten bytes']))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(storage.StorageFullError);
    expect((err as Error).name).toBe('StorageFullError');
    expect(((err as Error).cause as DOMException).name).toBe('QuotaExceededError');
    expect(fs.log).toEqual(['abort /user-maps/big/source.pdf']);
    expect((await storage.readSource('big'))?.size ?? 0).toBe(0);

    // Other write failures pass through untouched.
    fs.quotaBytes = Infinity;
    const writable = MockFileHandle.prototype.createWritable;
    MockFileHandle.prototype.createWritable = async () => {
      throw new DOMException('nope', 'NotAllowedError');
    };
    try {
      const other = await storage.writeMeta('big', []).catch((e: unknown) => e);
      expect(other).not.toBeInstanceOf(storage.StorageFullError);
      expect((other as DOMException).name).toBe('NotAllowedError');
    } finally {
      MockFileHandle.prototype.createWritable = writable;
    }
  });

  it('removes one page’s images, or a whole doc recursively', async () => {
    await storage.saveSource('d', new Blob(['%PDF-']));
    await storage.savePageImages('d', 1, new Blob(['a']), new Blob(['b']));
    await storage.savePageImages('d', 2, new Blob(['c']), new Blob(['d']));
    await storage.deletePageImages('d', 1);
    expect([...docDir('d')!.files.keys()].sort()).toEqual(['p2.jpg', 'p2.thumb.jpg', 'source.pdf']);
    await storage.deleteDoc('d');
    expect(docDir('d')).toBeUndefined();
    await storage.deleteDoc('d'); // already gone: no throw
  });

  it('asks the browser to persist storage', async () => {
    expect(await storage.requestPersist()).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

describe('user map storage (session-only fallback)', () => {
  it('serves the same API from memory when OPFS writes are missing', async () => {
    vi.resetModules();
    getDirectory.mockClear();
    vi.stubGlobal('FileSystemFileHandle', undefined);
    try {
      await sessionOnlyRoundTrip();
    } finally {
      vi.stubGlobal('FileSystemFileHandle', MockFileHandle);
    }
  });

  async function sessionOnlyRoundTrip() {
    const mem = await import('./storage');
    expect(mem.userMapsPersistent()).toBe(false);

    const src = new File(['%PDF-1.7'], 'a.pdf');
    await mem.saveSource('m', src);
    expect(await mem.readSource('m')).toBe(src); // held by reference
    await mem.savePageImages('m', 1, new Blob(['j']), new Blob(['t']));
    expect(await mem.hasDoc('m')).toBe(false);
    await mem.saveSource('partial', new Blob(['%PDF-']));
    await mem.writeMeta('m', [meta('m', 1, '2026-10-16T10:00:00.000Z')]);
    expect(await mem.hasDoc('m')).toBe(true);

    expect((await mem.listUserMaps()).map((m) => m.id)).toEqual(['m-p1']);
    expect(await mem.readSource('partial')).toBeNull(); // unfinished: cleaned
    expect(await text(await mem.readThumb('m', 1))).toBe('t');
    await mem.deleteDoc('m');
    expect(await mem.listUserMaps()).toEqual([]);

    expect(await mem.requestPersist()).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    expect(getDirectory).not.toHaveBeenCalled();
    expect(top.dirs.size).toBe(0);
  }

  it('falls back to memory when getDirectory() rejects (Firefox private window)', async () => {
    vi.resetModules();
    getDirectory.mockImplementation(async () => {
      throw new DOMException('Security error', 'SecurityError');
    });
    try {
      const mem = await import('./storage');
      expect(mem.userMapsPersistent()).toBe(true); // not probed yet
      expect(await mem.listUserMaps()).toEqual([]);
      expect(mem.userMapsPersistent()).toBe(false);
      await mem.saveSource('x', new Blob(['%PDF-']));
      expect(await mem.readSource('x')).not.toBeNull();
    } finally {
      getDirectory.mockImplementation(async () => top);
    }
  });
});
