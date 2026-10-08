/**
 * Pack orchestration over an in-memory OPFS, with FL and WI Chipmunk sharing
 * the fire_slug "chipmunk": loading touches nothing on disk, a download
 * writes only its own fire's folder, Remove takes every copy of one fire,
 * and the offline fetch serves each fire's ID manifest from its own pack.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackMeta } from './packModel';

// In-memory OPFS: packs/{folder}/{file}. Every mutating call is recorded.
const fs = vi.hoisted(() => ({
  dirs: new Map<string, Map<string, string>>(),
  writes: [] as string[],
  deletes: [] as string[],
}));
vi.mock('./opfs', () => ({
  opfsSupported: () => true,
  listPackFolders: async () => [...fs.dirs.keys()],
  listPackFiles: async (f: string) => [...(fs.dirs.get(f)?.keys() ?? [])],
  readPackFile: async (f: string, n: string) => {
    const v = fs.dirs.get(f)?.get(n);
    return v === undefined ? null : new TextEncoder().encode(v).buffer;
  },
  getPackFile: async () => null,
  packFileSize: async (f: string, n: string) => fs.dirs.get(f)?.get(n)?.length ?? null,
  fileNameForUrl: async (u: string) => `h${[...u].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)}`,
  writePackFile: async (f: string, n: string, d: ArrayBuffer | string) => {
    fs.writes.push(`${f}/${n}`);
    if (!fs.dirs.has(f)) fs.dirs.set(f, new Map());
    fs.dirs.get(f)!.set(n, typeof d === 'string' ? d : new TextDecoder().decode(d));
  },
  deletePackFile: async (f: string, n: string) => { fs.deletes.push(`${f}/${n}`); fs.dirs.get(f)?.delete(n); },
  deletePack: async (f: string) => { fs.deletes.push(`${f}/`); fs.dirs.delete(f); },
}));
vi.mock('../app/analytics', () => ({ track: () => undefined, trackOncePer: () => undefined, resetScope: () => undefined }));

const FL = '{8E2C1A4B-0F3D-4C6E-9A7B-1D2E3F4A5B6C}';
const FL_FK = '8e2c1a4b-0f3d-4c6e-9a7b-1d2e3f4a5b6c';
const WI = '{1B2C3D4E-5F60-4718-8A9B-0C1D2E3F4A5B}';
const WI_FK = '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b';

function seed(folder: string, over: Partial<PackMeta>, extra: Record<string, string> = {}) {
  const meta = { version: 1, slug: folder, corneaId: FL, name: 'Chipmunk', state: 'FL',
    downloadedAt: '2026-10-06T00:00:00Z', bytes: 1, fileCount: 1, files: {}, prefixes: [], ...over };
  fs.dirs.set(folder, new Map([['pack.json', JSON.stringify(meta)], ...Object.entries(extra)]));
}

const catalog = { fires: [
  { cornea_id: FL, fire_slug: 'chipmunk', name: 'Chipmunk', state: 'FL', incident_manifest: null, hotspot_archive: null, coordinates: null },
  { cornea_id: WI, fire_slug: 'chipmunk', name: 'Chipmunk', state: 'WI', incident_manifest: null, hotspot_archive: null, coordinates: null },
] };
/** Runs once a download has picked its folder (the next fetch is perimeters). */
let midDownload: (() => void) | null = null;
// Stubbed before the import: packs.ts captures fetch as its raw fetch.
vi.stubGlobal('fetch', async (u: string) => {
  if (u.endsWith('/perimeters')) midDownload?.();
  const body = u.endsWith('/catalogs/catalog.json') ? catalog
    : u.endsWith('/perimeters') ? []
    : u.endsWith('pyrecast_runs.json') ? { fires: {} }
    : {};
  return new Response(JSON.stringify(body), { status: 200 });
});

const packs = await import('./packs');
const { useStore } = await import('../state/store');

const packJson = (folder: string) =>
  JSON.parse(fs.dirs.get(folder)!.get('pack.json')!) as PackMeta;

beforeEach(() => {
  fs.dirs.clear();
  fs.writes.length = 0;
  fs.deletes.length = 0;
  midDownload = null;
});
afterAll(() => vi.unstubAllGlobals());

describe('packs orchestration', () => {
  it('load is read-only: nothing written, moved or deleted', async () => {
    seed('chipmunk', { downloadedAt: '2026-10-07T00:00:00Z' }, { a: 'x' });
    seed(FL_FK, {}, { b: 'y' });
    seed(WI_FK, { corneaId: WI });
    fs.dirs.set('partial', new Map([['c', 'z']]));
    await packs.initOfflinePacks();
    expect(fs.writes).toEqual([]);
    expect(fs.deletes).toEqual([]);
    expect([...fs.dirs.keys()].sort()).toEqual([FL_FK, WI_FK, 'chipmunk', 'partial'].sort());
    const p = useStore.getState().offline.packs;
    expect(Object.keys(p).sort()).toEqual([FL_FK, WI_FK].sort());
    expect(p[FL_FK].slug).toBe('chipmunk');
  });

  it("Chipmunk: a WI download never touches FL's packs/chipmunk", async () => {
    seed('chipmunk', {}, { keep: 'fl' });
    await packs.initOfflinePacks();
    const meta = await packs.downloadPack(WI);
    expect(meta.slug).toBe(WI_FK);
    expect(fs.writes.every((w) => w.startsWith(`${WI_FK}/`))).toBe(true);
    expect(fs.deletes.every((d) => d.startsWith(`${WI_FK}/`))).toBe(true);
    expect(fs.dirs.get('chipmunk')?.get('keep')).toBe('fl');
    const fl = await packs.downloadPack(FL);
    expect(fl.slug).toBe('chipmunk'); // legacy folder reused
  });

  it('an update re-reads a legacy folder: WI saved there since load goes untouched', async () => {
    seed('chipmunk', {}, { keep: 'fl' });
    await packs.initOfflinePacks();
    // An older tab on WI's page saves WI into packs/chipmunk after this load.
    seed('chipmunk', { corneaId: WI, state: 'WI', downloadedAt: '2026-10-07T00:00:00Z' }, { wi: 'w' });
    const before = new Map(fs.dirs.get('chipmunk'));
    const meta = await packs.downloadPack(FL);
    expect(meta.slug).toBe(FL_FK);
    expect(fs.writes.every((w) => w.startsWith(`${FL_FK}/`))).toBe(true);
    expect(fs.deletes.every((d) => d.startsWith(`${FL_FK}/`))).toBe(true);
    expect(fs.dirs.get('chipmunk')).toEqual(before);
    const p = useStore.getState().offline.packs;
    expect(p[WI_FK].slug).toBe('chipmunk');
    expect(p[FL_FK].slug).toBe(FL_FK);
  });

  it('WI saved into the folder mid-download: no pack.json write, no prune', async () => {
    seed('chipmunk', {}, { keep: 'fl' });
    await packs.initOfflinePacks();
    midDownload = () =>
      seed('chipmunk', { corneaId: WI, state: 'WI', downloadedAt: '2026-10-07T00:00:00Z' }, { wi: 'w' });
    await expect(packs.downloadPack(FL)).rejects.toBeInstanceOf(packs.PackDownloadError);
    expect(packJson('chipmunk').corneaId).toBe(WI);
    expect(fs.dirs.get('chipmunk')?.get('wi')).toBe('w');
    expect(fs.deletes).toEqual([]);
    const p = useStore.getState().offline.packs;
    expect(Object.keys(p)).toEqual([WI_FK]);
    expect(p[WI_FK].slug).toBe('chipmunk');
  });

  it("removePack deletes every folder of the fire and none of the other fire's", async () => {
    seed('chipmunk', { downloadedAt: '2026-10-07T00:00:00Z' });
    seed(FL_FK, { corneaId: FL_FK.toUpperCase() });
    seed(WI_FK, { corneaId: WI });
    await packs.initOfflinePacks();
    await packs.removePack(FL);
    expect([...fs.dirs.keys()]).toEqual([WI_FK]);
    expect(Object.keys(useStore.getState().offline.packs)).toEqual([WI_FK]);
  });
});

// Last in the file: installOfflineFetch swaps packs.ts's raw fetch for the
// throwing stub below, so no download can run after it.
describe('offline fetch: ID manifest alias', () => {
  it("serves each fire's ID manifest from its own pack, never the other Chipmunk's", async () => {
    const { DATA_BASE_URL } = await import('../app/config');
    const legacy = `${DATA_BASE_URL}/catalogs/incidents/chipmunk.json`;
    const id = (fk: string) => `${DATA_BASE_URL}/catalogs/incidents/id/${fk}.json`;
    seed('chipmunk', { corneaId: FL, files: { [legacy]: 'fl' } }, { fl: '{"cornea_id":"FL"}' });
    seed(WI_FK, { corneaId: WI, downloadedAt: '2026-10-08T00:00:00Z', files: { [legacy]: 'wi' } },
      { wi: '{"cornea_id":"WI"}' });
    await packs.initOfflinePacks();
    // Node's navigator.onLine is undefined, which the wrapper reads as offline.
    vi.stubGlobal('window', { fetch: async () => { throw new TypeError('offline'); } });
    packs.installOfflineFetch();
    const w = (globalThis as unknown as { window: { fetch: typeof fetch } }).window;
    expect(await (await w.fetch(id(FL_FK))).text()).toBe('{"cornea_id":"FL"}');
    expect(await (await w.fetch(id(WI_FK))).text()).toBe('{"cornea_id":"WI"}');
    await expect(w.fetch(id('0000'))).rejects.toThrow('offline');
  });
});
