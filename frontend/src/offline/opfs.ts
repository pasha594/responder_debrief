/**
 * Thin OPFS (Origin Private File System) wrapper for offline fire packs.
 * Layout: packs/{slug}/{sha256(url).16}[.ext] plus packs/{slug}/pack.json.
 *
 * OPFS rather than the Cache API by design: the same storage core carries
 * into a future Capacitor wrap (where service-worker caching is unavailable),
 * and writes commit atomically per file (a createWritable that never closes
 * leaves no partial file behind).
 */

export function opfsSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.storage?.getDirectory &&
    typeof FileSystemFileHandle !== 'undefined' &&
    'createWritable' in FileSystemFileHandle.prototype
  );
}

async function packsRoot(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle('packs', { create });
  } catch {
    return null;
  }
}

async function packDir(
  slug: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  const root = await packsRoot(create);
  if (!root) return null;
  try {
    return await root.getDirectoryHandle(slug, { create });
  } catch {
    return null;
  }
}

/** Stable storage filename for a URL (extension kept for debuggability). */
export async function fileNameForUrl(url: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ext = /\.(png|json|geojson|tif|tar|pdf)(\?|$)/.exec(url)?.[1];
  return `${hex.slice(0, 16)}${ext ? `.${ext}` : ''}`;
}

export async function writePackFile(
  slug: string,
  name: string,
  data: ArrayBuffer | string,
): Promise<void> {
  const dir = await packDir(slug, true);
  if (!dir) throw new Error('opfs unavailable');
  const handle = await dir.getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  await w.write(data);
  await w.close();
}

export async function readPackFile(slug: string, name: string): Promise<ArrayBuffer | null> {
  const dir = await packDir(slug, false);
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(name);
    const file = await handle.getFile();
    return await file.arrayBuffer();
  } catch {
    return null;
  }
}

export async function packFileExists(slug: string, name: string): Promise<boolean> {
  const dir = await packDir(slug, false);
  if (!dir) return false;
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

export async function deletePack(slug: string): Promise<void> {
  const root = await packsRoot(false);
  if (!root) return;
  try {
    await root.removeEntry(slug, { recursive: true });
  } catch {
    /* already gone */
  }
}

/** Slugs that have a directory under packs/ (pack.json may or may not exist). */
export async function listPackSlugs(): Promise<string[]> {
  const root = await packsRoot(false);
  if (!root) return [];
  const out: string[] = [];
  // entries() is AsyncIterable<[name, handle]>
  for await (const [name, handle] of root as unknown as AsyncIterable<
    [string, FileSystemHandle]
  >) {
    if (handle.kind === 'directory') out.push(name);
  }
  return out;
}
