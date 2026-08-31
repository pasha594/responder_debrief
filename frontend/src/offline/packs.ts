/**
 * Offline pack orchestration: download a fire's pack into OPFS, serve it
 * back through a window.fetch wrapper, and track state for the UI.
 *
 * Serving model (deliberately simple): the wrapper consults an in-memory
 * url -> stored-file index built from every pack's pack.json at boot.
 * Online, the network always goes first (fresh data wins; immutable files
 * ride the normal HTTP cache anyway) and the pack is only a fallback on
 * failure. Offline (navigator.onLine === false), the pack is consulted
 * first. MapLibre tile requests go through global fetch, so incident-map
 * tiles need no map-specific plumbing.
 */
import { DATA_BASE_URL, FIRE_API } from '../app/config';
import { dataUrl } from '../api/catalogs';
import { useStore } from '../state/store';
import { track } from '../app/analytics';
import type {
  HotspotArchiveIndex,
  IncidentManifest,
  MasterCatalog,
  PerimeterIndexItem,
  PyrecastRunsCatalog,
} from '../api/types';
import { latestRun } from '../api/queries';
import { setSpreadArchiveBase } from '../api/wmsUrls';
import {
  buildPackPlan,
  formatBytes,
  type PackInputs,
} from './packModel';
import {
  deletePack as opfsDeletePack,
  deletePackFile,
  fileNameForUrl,
  listPackFiles,
  listPackSlugs,
  opfsSupported,
  packFileSize,
  readPackFile,
  writePackFile,
} from './opfs';

export interface PackMeta {
  version: 1;
  slug: string;
  corneaId: string;
  name: string;
  state: string;
  downloadedAt: string; // ISO
  bytes: number;
  fileCount: number;
  /** url -> stored file name (content-type derived from extension). */
  files: Record<string, string>;
  /** Prefix fallbacks for URLs that vary with time (open-meteo). */
  prefixes: { prefix: string; file: string }[];
}

export { formatBytes, opfsSupported };

// ---------- in-memory serving index ----------

const urlIndex = new Map<string, { slug: string; file: string }>();
const prefixIndex: { prefix: string; slug: string; file: string }[] = [];

function indexPack(meta: PackMeta): void {
  for (const [url, file] of Object.entries(meta.files)) {
    urlIndex.set(url, { slug: meta.slug, file });
  }
  for (const p of meta.prefixes) {
    prefixIndex.push({ prefix: p.prefix, slug: meta.slug, file: p.file });
  }
}

function unindexPack(slug: string): void {
  for (const [url, v] of urlIndex) if (v.slug === slug) urlIndex.delete(url);
  for (let i = prefixIndex.length - 1; i >= 0; i--) {
    if (prefixIndex[i].slug === slug) prefixIndex.splice(i, 1);
  }
}

function contentTypeFor(name: string): string {
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.tif')) return 'image/tiff';
  if (name.endsWith('.tar')) return 'application/x-tar';
  if (name.endsWith('.pdf')) return 'application/pdf';
  return 'application/json';
}

async function serveFromPack(hit: { slug: string; file: string }): Promise<Response | null> {
  const buf = await readPackFile(hit.slug, hit.file);
  if (!buf) return null;
  return new Response(buf, {
    status: 200,
    headers: { 'content-type': contentTypeFor(hit.file), 'x-rd-offline': '1' },
  });
}

/** Look up a URL in the downloaded packs (exact, then time-varying prefixes). */
async function packResponse(url: string): Promise<Response | null> {
  const exact = urlIndex.get(url);
  if (exact) return serveFromPack(exact);
  for (const p of prefixIndex) {
    if (url.startsWith(p.prefix)) return serveFromPack(p);
  }
  return null;
}

/**
 * Install the global fetch wrapper. Call once at boot, before the map or any
 * query runs. Network-first while online; pack-first while offline.
 */
/**
 * The un-wrapped fetch. Downloads MUST use this: routing a pack update
 * through the wrapper would let the pack's own stale files "satisfy" the
 * update on a flaky network and silently freeze the pack in time.
 */
let rawFetch: typeof fetch =
  typeof window !== 'undefined' ? window.fetch.bind(window) : fetch;

/** Field networks lie: connected-but-dead wifi keeps navigator.onLine true.
 * When the pack has the answer, don't wait more than this for the network. */
const NETWORK_PATIENCE_MS = 8000;

export function installOfflineFetch(): void {
  if (typeof window === 'undefined') return;
  rawFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (method !== 'GET' || urlIndex.size + prefixIndex.length === 0) {
      return rawFetch(input, init);
    }
    const packed = urlIndex.has(url) || prefixIndex.some((p) => url.startsWith(p.prefix));
    if (!navigator.onLine && packed) {
      const hit = await packResponse(url);
      if (hit) return hit;
    }
    try {
      const netPromise = rawFetch(input, init);
      const res = packed
        ? await Promise.race([
            netPromise,
            new Promise<'slow'>((r) => setTimeout(() => r('slow'), NETWORK_PATIENCE_MS)),
          ]).then(async (v) => {
            if (v !== 'slow') return v;
            const hit = await packResponse(url);
            if (hit) {
              netPromise.catch(() => undefined); // don't leak an unhandled rejection
              return hit;
            }
            return netPromise;
          })
        : await netPromise;
      if (!res.ok && res.status !== 304) {
        const hit = await packResponse(url);
        if (hit) return hit;
      }
      return res;
    } catch (err) {
      const hit = await packResponse(url);
      if (hit) return hit;
      throw err;
    }
  };
}

// ---------- boot ----------

/** Load every stored pack's metadata; hydrate the index and the store. */
export async function initOfflinePacks(): Promise<void> {
  if (!opfsSupported()) return;
  const packs: Record<string, PackMeta> = {};
  for (const slug of await listPackSlugs()) {
    const raw = await readPackFile(slug, 'pack.json');
    if (!raw) continue; // interrupted download — files stay for resume
    try {
      const meta = JSON.parse(new TextDecoder().decode(raw)) as PackMeta;
      if (meta.version === 1) {
        packs[meta.slug] = meta;
        indexPack(meta);
      }
    } catch {
      /* corrupt meta — ignore; re-download rewrites it */
    }
  }
  useStore.getState().actions.setOfflinePacks(packs);
}

// ---------- download ----------

const CONCURRENCY = 6;

async function fetchInto(
  slug: string,
  url: string,
  opts: { immutable: boolean; signal?: AbortSignal },
): Promise<{ file: string; bytes: number }> {
  const file = await fileNameForUrl(url);
  if (opts.immutable) {
    const stored = await packFileSize(slug, file);
    if (stored !== null) return { file, bytes: stored }; // resume/update skips it
  }
  const res = await rawFetch(url, { signal: opts.signal });
  if (!res.ok) throw new Error(`${res.status} for ${url.slice(0, 120)}`);
  const buf = await res.arrayBuffer();
  await writePackFile(slug, file, buf);
  return { file, bytes: buf.byteLength };
}

async function rawJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await rawFetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status} for ${url.slice(0, 120)}`);
  return res.json() as Promise<T>;
}

export class PackDownloadError extends Error {}

/** One download at a time; the controller lives here so ANY OfflineCard
 * instance (tab switches remount them) can cancel the active download. */
let activeDownload: AbortController | null = null;

export function cancelActiveDownload(): void {
  activeDownload?.abort();
}

/**
 * Download (or update) a fire's offline pack. Progress lands in the store;
 * cancel via cancelActiveDownload(). Resolves with the pack meta.
 */
export async function downloadPack(corneaId: string): Promise<PackMeta> {
  const ctl = new AbortController();
  activeDownload?.abort();
  activeDownload = ctl;
  try {
    return await runDownload(corneaId, ctl.signal);
  } catch (err) {
    if (ctl.signal.aborted) throw new PackDownloadError('cancelled');
    throw err;
  } finally {
    if (activeDownload === ctl) activeDownload = null;
  }
}

async function runDownload(corneaId: string, abort: AbortSignal): Promise<PackMeta> {
  const actions = useStore.getState().actions;
  const progress = (done: number, total: number, bytes: number) =>
    actions.setOfflineProgress({ corneaId, done, total, bytes });

  let wakeLock: WakeLockSentinel | null = null;
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
  } catch {
    /* wake lock is best-effort */
  }

  try {
    progress(0, 1, 0);

    // Phase 1 — snapshots (also the enumeration inputs). Fetched fresh via
    // the RAW fetch: an update must never be satisfied by its own stale pack.
    const catalog = await rawJson<MasterCatalog>(
      `${DATA_BASE_URL}/catalogs/catalog.json`, abort);
    const entry = catalog.fires.find((f) => f.cornea_id === corneaId);
    if (!entry?.fire_slug) throw new PackDownloadError('Fire not in the catalog yet');
    const slug = entry.fire_slug;

    const perimeterIndex = await rawJson<PerimeterIndexItem[]>(
      `${FIRE_API}/fires/${encodeURIComponent(corneaId)}/perimeters`, abort);
    const manifest = entry.incident_manifest
      ? await rawJson<IncidentManifest>(dataUrl(entry.incident_manifest), abort)
      : null;
    const hotspotIndex = entry.hotspot_archive
      ? await rawJson<HotspotArchiveIndex>(dataUrl(entry.hotspot_archive), abort)
      : null;
    const runsCatalog = await rawJson<PyrecastRunsCatalog>(
      `${DATA_BASE_URL}/catalogs/pyrecast_runs.json`, abort);
    // Same base the app uses at runtime, so planned ToA URLs match exactly.
    setSpreadArchiveBase(runsCatalog.archive_base);
    const spreadRun = latestRun(runsCatalog, slug);

    const inputs: PackInputs = {
      corneaId,
      slug,
      manifestPath: entry.incident_manifest,
      hotspotIndexPath: entry.hotspot_archive ?? null,
      manifest,
      hotspotIndex,
      perimeterIndex,
      spreadRun,
      nowMs: Date.now(),
    };
    const plan = buildPackPlan(inputs);

    // Point-weather strip: capture what the app would fetch (URL varies with
    // past_days, so it is served back by PREFIX match, not exact URL).
    const coords = entry.coordinates;
    let weatherPrefix: { prefix: string; file: string } | null = null;
    if (coords) {
      const lat = (Math.round(coords[1] * 1000) / 1000).toFixed(3);
      const lon = (Math.round(coords[0] * 1000) / 1000).toFixed(3);
      const prefix = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`;
      const params = new URLSearchParams({
        latitude: lat,
        longitude: lon,
        hourly: 'temperature_2m,weather_code,wind_speed_10m,wind_direction_10m',
        temperature_unit: 'fahrenheit',
        wind_speed_unit: 'mph',
        timezone: 'UTC',
        past_days: '92',
        forecast_days: '16',
      });
      const url = `https://api.open-meteo.com/v1/forecast?${params}`;
      const { file } = await fetchInto(slug, url, { immutable: false, signal: abort });
      weatherPrefix = { prefix, file };
    }

    // Phase 2 — the bulk plan.
    const files: Record<string, string> = {};
    let done = 0;
    let bytes = 0;
    const total = plan.files.length;
    progress(done, total, bytes);

    const queue = [...plan.files];
    let firstError: unknown = null;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const item = queue.shift();
        if (!item || abort.aborted || firstError) return;
        try {
          const r = await fetchInto(slug, item.url, {
            immutable: item.immutable,
            signal: abort,
          });
          files[item.url] = r.file;
          bytes += r.bytes;
        } catch (err) {
          // A pack with silent holes is worse than a failed download.
          firstError = err;
          return;
        }
        done += 1;
        if (done % 20 === 0 || done === total) progress(done, total, bytes);
      }
    });
    await Promise.all(workers);
    if (abort.aborted) throw new PackDownloadError('cancelled');
    if (firstError) throw firstError;

    const meta: PackMeta = {
      version: 1,
      slug,
      corneaId,
      name: entry.name ?? slug,
      state: entry.state ?? '',
      downloadedAt: new Date().toISOString(),
      bytes,
      fileCount: total,
      files,
      prefixes: weatherPrefix ? [weatherPrefix] : [],
    };
    await writePackFile(slug, 'pack.json', JSON.stringify(meta));

    // Prune files the new plan no longer references (rotated-out sheets,
    // superseded chunks) so updates don't grow the pack forever.
    const referenced = new Set(Object.values(files));
    referenced.add('pack.json');
    if (weatherPrefix) referenced.add(weatherPrefix.file);
    for (const name of await listPackFiles(slug)) {
      if (!referenced.has(name)) await deletePackFile(slug, name);
    }

    unindexPack(slug);
    indexPack(meta);
    const packs = { ...useStore.getState().offline.packs, [slug]: meta };
    actions.setOfflinePacks(packs);
    track('offline_pack_downloaded', {
      files: total,
      mb: Math.round(bytes / 1_000_000),
      sheets: plan.mapSheetCount,
    });
    void navigator.storage?.persist?.().catch(() => undefined);
    return meta;
  } finally {
    actions.setOfflineProgress(null);
    void wakeLock?.release().catch(() => undefined);
  }
}

export async function removePack(slug: string): Promise<void> {
  await opfsDeletePack(slug);
  unindexPack(slug);
  const packs = { ...useStore.getState().offline.packs };
  delete packs[slug];
  useStore.getState().actions.setOfflinePacks(packs);
}
