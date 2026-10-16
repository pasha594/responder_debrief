/**
 * On-device storage for My maps. Layout, one folder per imported PDF:
 *
 *   user-maps/{docId}/source.pdf        the file as picked (kept so a crashed
 *                                       or improved render can be redone)
 *   user-maps/{docId}/p{n}.jpg          page n's map frame, rendered once
 *   user-maps/{docId}/p{n}.thumb.jpg    its list thumbnail
 *   user-maps/{docId}/meta.json         UserMapMeta[] for the doc — WRITTEN LAST
 *
 * A folder without meta.json is an import that never finished (cancelled,
 * failed, or the tab was killed mid-render): listUserMaps deletes it, except
 * the one a crash breadcrumb still wants for "Try again". Its own top-level
 * folder, never under packs/: the offline-pack loader treats every packs/
 * folder as a pack and Remove deletes them recursively.
 *
 * OPFS through createWritable (atomic per file: a write that never closes
 * leaves nothing behind), same support gate as offline packs. Where that is
 * missing (iOS 17/18 Safari, Firefox private windows whose getDirectory
 * rejects) the same API is served from an in-memory Map: maps work until
 * the page closes, and userMapsPersistent() says so for the UI.
 */
import { opfsSupported } from '../offline/opfs';
import type { UserMapMeta } from './types';

const ROOT = 'user-maps';
const META = 'meta.json';
const SOURCE = 'source.pdf';
const imageName = (page: number) => `p${page}.jpg`;
const thumbName = (page: number) => `p${page}.thumb.jpg`;

/** A write hit the origin's storage quota (QuotaExceededError). */
export class StorageFullError extends Error {
  constructor(cause?: unknown) {
    super('Not enough storage space to save the map', { cause });
    this.name = 'StorageFullError';
  }
}

function isQuotaError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  // Firefox before 2023 used its own name for the same condition.
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

/** The few file operations the API below needs, per doc folder. */
interface Backend {
  docIds(): Promise<string[]>;
  write(docId: string, name: string, data: Blob | string): Promise<void>;
  read(docId: string, name: string): Promise<File | Blob | null>;
  /** Bytes stored, or null when the file doesn't exist. */
  size(docId: string, name: string): Promise<number | null>;
  remove(docId: string, name: string): Promise<void>;
  removeDoc(docId: string): Promise<void>;
}

// ---------- OPFS ----------

async function mapsRoot(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  const top = await navigator.storage.getDirectory();
  try {
    return await top.getDirectoryHandle(ROOT, { create });
  } catch (err) {
    if (create) throw err;
    return null; // nothing saved yet
  }
}

async function docDir(docId: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  const root = await mapsRoot(create);
  if (!root) return null;
  try {
    return await root.getDirectoryHandle(docId, { create });
  } catch (err) {
    if (create) throw err;
    return null;
  }
}

const opfs: Backend = {
  async docIds() {
    const root = await mapsRoot(false);
    if (!root) return [];
    const out: string[] = [];
    // entries() is AsyncIterable<[name, handle]> (not in this TS DOM lib).
    const entries = (root as unknown as {
      entries(): AsyncIterable<[string, FileSystemHandle]>;
    }).entries();
    for await (const [name, handle] of entries) {
      if (handle.kind === 'directory') out.push(name);
    }
    return out;
  },
  async write(docId, name, data) {
    try {
      const dir = (await docDir(docId, true))!;
      const handle = await dir.getFileHandle(name, { create: true });
      const w = await handle.createWritable();
      try {
        // A Blob/File is streamed in by the browser — no ArrayBuffer copy.
        await w.write(data);
        await w.close();
      } catch (err) {
        await w.abort().catch(() => undefined); // discard the swap file
        throw err;
      }
    } catch (err) {
      throw isQuotaError(err) ? new StorageFullError(err) : err;
    }
  },
  async read(docId, name) {
    const dir = await docDir(docId, false);
    if (!dir) return null;
    try {
      return await (await dir.getFileHandle(name)).getFile();
    } catch {
      return null;
    }
  },
  async size(docId, name) {
    const dir = await docDir(docId, false);
    if (!dir) return null;
    try {
      return (await (await dir.getFileHandle(name)).getFile()).size;
    } catch {
      return null;
    }
  },
  async remove(docId, name) {
    const dir = await docDir(docId, false);
    if (!dir) return;
    try {
      await dir.removeEntry(name);
    } catch {
      /* already gone */
    }
  },
  async removeDoc(docId) {
    const root = await mapsRoot(false);
    if (!root) return;
    try {
      await root.removeEntry(docId, { recursive: true });
    } catch {
      /* already gone */
    }
  },
};

// ---------- in-memory fallback (session only) ----------

const mem = new Map<string, Map<string, Blob>>();

const memory: Backend = {
  async docIds() {
    return [...mem.keys()];
  },
  async write(docId, name, data) {
    let dir = mem.get(docId);
    if (!dir) mem.set(docId, (dir = new Map()));
    // Keeps the picked File by reference: nothing is copied.
    dir.set(name, typeof data === 'string' ? new Blob([data], { type: 'application/json' }) : data);
  },
  async read(docId, name) {
    return mem.get(docId)?.get(name) ?? null;
  },
  async size(docId, name) {
    return mem.get(docId)?.get(name)?.size ?? null;
  },
  async remove(docId, name) {
    mem.get(docId)?.delete(name);
  },
  async removeDoc(docId) {
    mem.delete(docId);
  },
};

// ---------- backend choice ----------

/** null until probed: getDirectory() can reject even where opfsSupported()
 * is true (Firefox private windows), and every write would then fail. */
let opfsUsable: boolean | null = null;
let probe: Promise<boolean> | null = null;

async function backend(): Promise<Backend> {
  if (!opfsSupported()) return memory;
  probe ??= navigator.storage.getDirectory().then(
    () => (opfsUsable = true),
    () => (opfsUsable = false),
  );
  return (await probe) ? opfs : memory;
}

/** Maps survive a reload (OPFS). False → session-only in-memory storage.
 * Exact once any storage call has run (initUserMaps lists at boot). */
export function userMapsPersistent(): boolean {
  return opfsSupported() && opfsUsable !== false;
}

// ---------- meta ----------

/** meta.json exists with content. getFileHandle({create}) makes an empty
 * file before the write, so a writeMeta that never closed (quota, or the
 * tab killed) leaves zero bytes: that doc never finished. */
async function committed(be: Backend, docId: string): Promise<boolean> {
  return ((await be.size(docId, META)) ?? 0) > 0;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNumArr = (v: unknown, n: number) =>
  Array.isArray(v) && v.length === n && v.every(isNum);

/** Shape check for one stored meta — a v1 reader skips anything else (a
 * newer app version's maps stay on disk untouched). */
function isValidMeta(m: unknown, docId: string): m is UserMapMeta {
  const u = m as Partial<UserMapMeta> | null;
  return (
    !!u &&
    u.v === 1 &&
    u.docId === docId &&
    Number.isInteger(u.page) &&
    u.page! >= 1 &&
    u.id === `${docId}-p${u.page}` &&
    isNum(u.pageCount) &&
    typeof u.title === 'string' &&
    typeof u.fileName === 'string' &&
    isNum(u.fileBytes) &&
    typeof u.addedAt === 'string' &&
    !!u.image &&
    isNum(u.image.width) &&
    isNum(u.image.height) &&
    isNumArr(u.image.pageToImage, 6) &&
    !!u.georef &&
    u.georef.v === 1 &&
    isNumArr(u.georef.frame, 4) &&
    Array.isArray(u.georef.points) &&
    isNumArr(u.bounds, 4) &&
    isNumArr(u.center, 2) &&
    isNum(u.maxzoom) &&
    Array.isArray(u.warnings)
  );
}

async function readMetaWith(be: Backend, docId: string): Promise<UserMapMeta[] | null> {
  const blob = await be.read(docId, META);
  if (!blob) return null;
  try {
    const parsed: unknown = JSON.parse(await blob.text());
    if (!Array.isArray(parsed)) return null;
    const metas = parsed.filter((m) => isValidMeta(m, docId));
    return metas.length ? metas : null;
  } catch {
    return null; // unreadable: skipped, not deleted
  }
}

/** Newest import first; a PDF's pages together in page order. */
export function sortUserMaps(list: UserMapMeta[]): UserMapMeta[] {
  return [...list].sort(
    (a, b) =>
      b.addedAt.localeCompare(a.addedAt) || a.docId.localeCompare(b.docId) || a.page - b.page,
  );
}

// ---------- public API ----------

/** Every saved map, newest first. Deletes folders without meta.json
 * (unfinished imports) except `keepDocId` — the crashed import whose saved
 * source.pdf "Try again" re-renders. */
export async function listUserMaps(keepDocId?: string): Promise<UserMapMeta[]> {
  const be = await backend();
  const out: UserMapMeta[] = [];
  for (const docId of await be.docIds()) {
    if (!(await committed(be, docId))) {
      if (docId !== keepDocId) await be.removeDoc(docId);
      continue;
    }
    const metas = await readMetaWith(be, docId);
    if (metas) out.push(...metas);
  }
  return sortUserMaps(out);
}

/** One doc's stored metas, or null when it has none (or they don't parse). */
export async function readMeta(docId: string): Promise<UserMapMeta[] | null> {
  return readMetaWith(await backend(), docId);
}

/** Saves the picked file as-is (streamed, never copied into memory). */
export async function saveSource(docId: string, file: Blob): Promise<void> {
  await (await backend()).write(docId, SOURCE, file);
}

export async function readSource(docId: string): Promise<File | Blob | null> {
  return (await backend()).read(docId, SOURCE);
}

/** The doc finished importing (its meta.json was written). */
export async function hasDoc(docId: string): Promise<boolean> {
  return committed(await backend(), docId);
}

export async function savePageImages(
  docId: string,
  page: number,
  jpeg: Blob,
  thumb: Blob,
): Promise<void> {
  const be = await backend();
  await be.write(docId, imageName(page), jpeg);
  await be.write(docId, thumbName(page), thumb);
}

export async function readPageImage(docId: string, page: number): Promise<Blob | null> {
  return (await backend()).read(docId, imageName(page));
}

export async function readThumb(docId: string, page: number): Promise<Blob | null> {
  return (await backend()).read(docId, thumbName(page));
}

/** Drops one page's images (its map was removed; others in the doc stay).
 * Rewrite meta.json without the page FIRST so nothing points at them. */
export async function deletePageImages(docId: string, page: number): Promise<void> {
  const be = await backend();
  await be.remove(docId, imageName(page));
  await be.remove(docId, thumbName(page));
}

/** The commit point of an import: call after every image is saved. */
export async function writeMeta(docId: string, metas: UserMapMeta[]): Promise<void> {
  await (await backend()).write(docId, META, JSON.stringify(metas));
}

export async function deleteDoc(docId: string): Promise<void> {
  await (await backend()).removeDoc(docId);
}

/** Asks the browser not to evict saved maps under storage pressure. Safari
 * grants it only to Home Screen apps; Firefox may prompt. */
export async function requestPersist(): Promise<boolean> {
  if (!userMapsPersistent()) return false;
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
