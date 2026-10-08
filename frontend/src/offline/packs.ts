/**
 * Offline pack orchestration: download a fire's pack into OPFS, serve it
 * back through a window.fetch wrapper, and track state for the UI.
 *
 * Serving model (deliberately simple): the wrapper consults an in-memory
 * url -> stored-file index built from every pack's pack.json at boot.
 * Online, the network always goes first (fresh data wins; immutable files
 * ride the normal HTTP cache anyway) and the pack is only a fallback on
 * failure. Offline (navigator.onLine === false), the pack is consulted
 * first. MapLibre RASTER tile requests go through global fetch, so
 * incident-map tiles need no map-specific plumbing (vector tiles are fetched
 * in MapLibre's worker: the trails layer reads its packed PMTiles through
 * packedFile() instead). Immutable packed files (versioned URLs: routing
 * bundles, closed hotspot days) are served pack-first even online — dead
 * field wifi would otherwise cost the 8 s patience per file. Any request
 * carrying a Range header goes straight to the network: a pack serves whole
 * files, which a range reader (pmtiles) rejects.
 *
 * Packs are keyed by fire key (fireKey(cornea_id)), never by fire_slug: two
 * active fires can share a name, and the slug moves between them. A new
 * download goes to packs/{fk}/; a pack saved under its fire_slug keeps
 * updating that folder. PackMeta.slug is always the folder. When one fire
 * has two folders the newest download wins; both stay on disk until Remove,
 * and nothing in OPFS is moved or deleted at load. A pack saved before the
 * catalog moved to ID manifests (/catalogs/incidents/id/{fk}.json) holds its
 * manifest under the old name-filed URL; aliasHit serves the ID URL from
 * that file in the fire's own pack.
 *
 * Older app versions (slug-keyed packs) against packs saved here:
 * - they read packs/{meta.slug}, which is the folder, so they serve them;
 * - their Offline card shows "Download" for a pack in an ID folder, and
 *   downloading there writes a duplicate into packs/{fire_slug}, which this
 *   version resolves by newest download;
 * - an older tab on WI Chipmunk's page can still overwrite FL Chipmunk's
 *   packs/chipmunk, as before.
 */
import { DATA_BASE_URL, FIRE_API } from '../app/config';
import { dataUrl } from '../api/catalogs';
import { fireKey, sameFire } from '../api/fireKey';
import { useStore } from '../state/store';
import { track } from '../app/analytics';
import { routingIndexUrl } from '../routing/bundleIndex';
import {
  SUPPORTED_RECIPE,
  type RoutingBundle,
  type RoutingIndex,
  type RoutingIndexEntry,
} from '../routing/types';
import type {
  HotspotArchiveIndex,
  IncidentManifest,
  MasterCatalog,
  PerimeterIndexItem,
  PyrecastRunsCatalog,
  WeatherRunsCatalog,
} from '../api/types';
import { isRenderableWeatherRun, latestRun, manifestBelongsTo } from '../api/queries';
import { setSpreadArchiveBase } from '../api/wmsUrls';
import {
  aliasHit,
  buildPackPlan,
  choosePacks,
  downloadFolder,
  formatBytes,
  packForFire,
  servingIndex,
  type PackHit,
  type PackInputs,
  type PackMeta,
  type ServingIndex,
} from './packModel';
import {
  deletePack as opfsDeletePack,
  deletePackFile,
  fileNameForUrl,
  getPackFile,
  listPackFiles,
  listPackFolders,
  opfsSupported,
  packFileSize,
  readPackFile,
  writePackFile,
} from './opfs';

export type { PackMeta };
export { formatBytes, opfsSupported, packForFire };

// ---------- in-memory serving index ----------

/** Every complete pack on this device by OPFS folder, a fire's second
 * folder included. */
const onDisk = new Map<string, PackMeta>();
/** The pack each fire serves from, by fire key (what the store holds). */
let winners: Record<string, PackMeta> = {};
let urlIndex: ServingIndex['urls'] = new Map();
let prefixIndex: ServingIndex['prefixes'] = [];
let immutableUrls: ServingIndex['immutable'] = new Set();

/** Recompute the winners and the serving index from onDisk, and hand the
 * winners to the store. */
function rebuildIndex(): void {
  winners = choosePacks(onDisk).packs;
  ({ urls: urlIndex, prefixes: prefixIndex, immutable: immutableUrls } = servingIndex(
    onDisk.values(),
  ));
  useStore.getState().actions.setOfflinePacks(winners);
}

function contentTypeFor(name: string): string {
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.tif')) return 'image/tiff';
  if (name.endsWith('.tar')) return 'application/x-tar';
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.gz')) return 'application/gzip';
  if (name.endsWith('.pmtiles')) return 'application/octet-stream';
  return 'application/json';
}

async function serveFromPack(hit: PackHit): Promise<Response | null> {
  const buf = await readPackFile(hit.folder, hit.file);
  if (!buf) return null;
  return new Response(buf, {
    status: 200,
    headers: { 'content-type': contentTypeFor(hit.file), 'x-rd-offline': '1' },
  });
}

/** Look up a URL in the downloaded packs (exact, then a fire's ID manifest
 * from its own older pack, then time-varying prefixes). */
async function packResponse(url: string): Promise<Response | null> {
  const exact = urlIndex.get(url);
  if (exact) return serveFromPack(exact);
  const alias = aliasHit(url, winners, DATA_BASE_URL);
  if (alias) return serveFromPack(alias);
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
    if (method !== 'GET' || urlIndex.size + prefixIndex.length === 0 || hasRange(input, init)) {
      return rawFetch(input, init);
    }
    const packed =
      urlIndex.has(url)
      || prefixIndex.some((p) => url.startsWith(p.prefix))
      || aliasHit(url, winners, DATA_BASE_URL) !== null;
    if (packed && (!navigator.onLine || immutableUrls.has(url))) {
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

function hasRange(input: RequestInfo | URL, init?: RequestInit): boolean {
  const h = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  if (!h) return false;
  return new Headers(h).has('range');
}

/** The packed OPFS File for an exact URL, or null (not packed / no OPFS). */
export async function packedFile(url: string): Promise<File | null> {
  await packsReady;
  const hit = urlIndex.get(url);
  return hit ? getPackFile(hit.folder, hit.file) : null;
}

/** The routing descriptor URL a fire's pack holds (for a retry when the
 * live index points at a newer bundle the pack doesn't have). */
export function packedRoutingDescriptor(corneaId: string): string | null {
  return packForFire(winners, corneaId)?.routing?.descriptor ?? null;
}

// ---------- boot ----------

let resolveReady: () => void = () => undefined;
/** Resolves once the pack index is hydrated: loaders outside React Query
 * (the Walk router, the trails source) await it so a request issued offline
 * right after boot doesn't race the index and fail. */
export const packsReady: Promise<void> = new Promise((r) => {
  resolveReady = r;
});

/** Load every stored pack's metadata; hydrate the index and the store. */
export async function initOfflinePacks(): Promise<void> {
  try {
    await hydratePacks();
  } finally {
    resolveReady();
  }
}

/** Read every folder's pack.json. Read-only: a fire's second folder stays
 * on disk (newest download serves), and nothing is renamed. */
async function hydratePacks(): Promise<void> {
  if (!opfsSupported()) return;
  onDisk.clear();
  for (const folder of await listPackFolders()) {
    const raw = await readPackFile(folder, 'pack.json');
    if (!raw) continue; // interrupted download — files stay for resume
    try {
      const meta = JSON.parse(new TextDecoder().decode(raw)) as PackMeta;
      // files/prefixes checked here so a malformed pack.json is skipped
      // rather than breaking the index for every pack.
      if (meta.version === 1 && fireKey(meta.corneaId) && meta.files && meta.prefixes) {
        onDisk.set(folder, { ...meta, slug: folder });
      }
    } catch {
      /* corrupt meta — ignore; re-download rewrites it */
    }
  }
  rebuildIndex();
}

// ---------- download ----------

const CONCURRENCY = 6;

async function fetchInto(
  folder: string,
  url: string,
  opts: { immutable: boolean; signal?: AbortSignal },
): Promise<{ file: string; bytes: number }> {
  const file = await fileNameForUrl(url);
  if (opts.immutable) {
    const stored = await packFileSize(folder, file);
    if (stored !== null) return { file, bytes: stored }; // resume/update skips it
  }
  const res = await rawFetch(url, { signal: opts.signal });
  if (!res.ok) throw new Error(`${res.status} for ${url.slice(0, 120)}`);
  const buf = await res.arrayBuffer();
  await writePackFile(folder, file, buf);
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
  // The target folder depends on the packs already on disk.
  await packsReady;
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
    const entry = catalog.fires.find((f) => sameFire(f.cornea_id, corneaId));
    if (!entry) throw new PackDownloadError('Fire not in the catalog yet');
    const fk = fireKey(corneaId)!;
    const legacySlug = entry.fire_slug ?? null;
    const folder = downloadFolder(winners, corneaId)!;

    const perimeterIndex = await rawJson<PerimeterIndexItem[]>(
      `${FIRE_API}/fires/${encodeURIComponent(corneaId)}/perimeters`, abort);
    const fetched = entry.incident_manifest
      ? await rawJson<IncidentManifest>(dataUrl(entry.incident_manifest), abort)
      : null;
    // A cached older catalog can still name another fire's legacy manifest.
    const manifest = fetched && manifestBelongsTo(fetched, corneaId) ? fetched : null;
    const hotspotIndex = entry.hotspot_archive
      ? await rawJson<HotspotArchiveIndex>(dataUrl(entry.hotspot_archive), abort)
      : null;
    const runsCatalog = await rawJson<PyrecastRunsCatalog>(
      `${DATA_BASE_URL}/catalogs/pyrecast_runs.json`, abort);
    // Same base the app uses at runtime, so planned ToA URLs match exactly.
    setSpreadArchiveBase(runsCatalog.archive_base);
    const spreadRun = latestRun(runsCatalog, corneaId, legacySlug);
    const weatherCatalog = await rawJson<WeatherRunsCatalog>(
      `${DATA_BASE_URL}/catalogs/weather_runs.json`, abort);
    const hrrr = weatherCatalog.models?.hrrr;
    // Exactly the run WeatherSection picks (renderable-first fallback).
    const weatherRun = hrrr?.runs?.find(isRenderableWeatherRun) ?? hrrr?.runs?.[0] ?? null;
    const weatherProducts = hrrr ? Object.keys(hrrr.products ?? {}) : [];
    // Offline Walk: the fire's routing bundle, when one exists. A missing
    // index or descriptor never fails the pack (the fire just has no
    // offline routing yet).
    let routingEntry: RoutingIndexEntry | null = null;
    let routingBundle: RoutingBundle | null = null;
    const routingIndex = await rawJson<RoutingIndex>(routingIndexUrl(), abort).catch(() => null);
    const re = routingIndex && (routingIndex.recipe ?? 1) <= SUPPORTED_RECIPE
      ? routingIndex.fires?.[corneaId] : undefined;
    if (re) {
      routingEntry = re;
      routingBundle = await rawJson<RoutingBundle>(dataUrl(re.descriptor), abort)
        .catch(() => null);
    }

    const inputs: PackInputs = {
      corneaId,
      manifestPath: manifest ? entry.incident_manifest : null,
      hotspotIndexPath: entry.hotspot_archive ?? null,
      manifest,
      hotspotIndex,
      perimeterIndex,
      spreadRun,
      weatherRun,
      weatherProducts,
      routingEntry: routingBundle ? routingEntry : null,
      routingBundle,
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
      const { file } = await fetchInto(folder, url, { immutable: false, signal: abort });
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
          const r = await fetchInto(folder, item.url, {
            immutable: item.immutable,
            signal: abort,
          });
          files[item.url] = r.file;
          bytes += r.bytes;
        } catch (err) {
          if (item.optional) {
            // best-effort content (weather frames a dry run never rendered)
            done += 1;
            continue;
          }
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
      slug: folder,
      corneaId,
      name: entry.name ?? legacySlug ?? fk,
      state: entry.state ?? '',
      downloadedAt: new Date().toISOString(),
      bytes,
      fileCount: total,
      files,
      prefixes: weatherPrefix ? [weatherPrefix] : [],
      immutable: plan.files.filter((f) => f.immutable && files[f.url]).map((f) => f.url),
      routing: routingEntry && routingBundle
        ? { descriptor: dataUrl(routingEntry.descriptor), bundleId: routingBundle.bundle_id,
            bytes: plan.routingBytes }
        : undefined,
    };
    await writePackFile(folder, 'pack.json', JSON.stringify(meta));

    // Prune files the new plan no longer references (rotated-out sheets,
    // superseded chunks) so updates don't grow the pack forever.
    const referenced = new Set(Object.values(files));
    referenced.add('pack.json');
    if (weatherPrefix) referenced.add(weatherPrefix.file);
    for (const name of await listPackFiles(folder)) {
      if (!referenced.has(name)) await deletePackFile(folder, name);
    }

    onDisk.set(folder, meta);
    rebuildIndex();
    track('offline_pack_downloaded', {
      files: total,
      mb: Math.round(bytes / 1_000_000),
      sheets: plan.mapSheetCount,
      routing: !!routingBundle,
      routing_mb: Math.round(plan.routingBytes / 1_000_000),
      legacy_folder: folder !== fk,
    });
    void navigator.storage?.persist?.().catch(() => undefined);
    return meta;
  } finally {
    actions.setOfflineProgress(null);
    void wakeLock?.release().catch(() => undefined);
  }
}

/** Delete every folder holding a pack of this fire, its second copy too. */
export async function removePack(corneaId: string): Promise<void> {
  const fk = fireKey(corneaId);
  for (const [folder, meta] of [...onDisk]) {
    if (fk === null || fireKey(meta.corneaId) !== fk) continue;
    await opfsDeletePack(folder);
    onDisk.delete(folder);
  }
  rebuildIndex();
}
