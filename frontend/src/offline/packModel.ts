/**
 * Pure pack planning: given the fire's already-fetched catalogs, enumerate
 * every URL the offline pack must contain, plus a size estimate. No fetching,
 * no storage — fully unit-testable.
 *
 * V1 pack contents (see docs/plan): fire detail + perimeter versions (latest
 * + last 7 days), full hotspot archive, latest spread run's ToA tifs, the
 * hourly point-weather strip, and incident-map tile pyramids + previews for
 * sheets dated within the last 2 days. Weather raster frames (CONUS-wide),
 * PDFs, and the basemap are deliberately out of v1.
 *
 * Also the pure half of pack storage: which stored pack each fire serves
 * from, the url -> stored-file serving index, and where a download goes.
 */
import { DATA_BASE_URL, FIRE_API } from '../app/config';
import { firesIndexUrl } from '../api/fireApi';
import { dataUrl } from '../api/catalogs';
import { fireKey } from '../api/fireKey';
import { spreadToaUrl, toaPercentiles, weatherImageUrl, windUvUrl } from '../api/wmsUrls';
import { routingIndexUrl } from '../routing/bundleIndex';
import type { RoutingBundle, RoutingIndexEntry } from '../routing/types';
import type {
  HotspotArchiveIndex,
  IncidentManifest,
  PerimeterIndexItem,
  PyrecastRun,
  WeatherRun,
} from '../api/types';

export interface PackFilePlan {
  url: string;
  /** Immutable content (skip re-download when already stored). */
  immutable: boolean;
  /** Rough size for the pre-download estimate, bytes. */
  estBytes: number;
  /** Best-effort: a 404 skips the file instead of failing the pack (weather
   * frames — the worker renders only products with data, e.g. no apcp01 on
   * dry runs — mirroring the app's own graceful degradation). */
  optional?: boolean;
}

export interface PackPlan {
  files: PackFilePlan[];
  estBytes: number;
  tileCount: number;
  mapSheetCount: number;
  /** Offline Walk bundle bytes (descriptor-reported sizes), 0 when none. */
  routingBytes: number;
}

const DAY_MS = 86_400_000;

/** Sizes measured from live Big Grass data (2026-08); estimates only. */
const EST = {
  tile: 70_000,
  perimeter: 1_200_000,
  hotspotDay: 450_000,
  toaTif: 3_400_000,
  preview: 60_000,
  json: 150_000,
  weatherFrame: 3_000_000,
  windUv: 120_000,
};

/** CONUS weather frames are ~3 MB each; cap the packed forecast horizon so a
 * 48-hour cycle can't balloon the pack (the field brief cares about the next
 * shifts, not hour 47). */
export const WEATHER_HOURS_CAP = 12;

// ---------- tile math (standard slippy scheme, mirrors MapLibre) ----------

function lonToX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

function latToY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z,
  );
}

/** Every tile URL in a sheet's declared grid (the worker uploads the full grid). */
export function sheetTileUrls(tiles: {
  url_template: string;
  minzoom: number;
  maxzoom: number;
  bounds: [number, number, number, number];
}): string[] {
  const [w, s, e, n] = tiles.bounds;
  const out: string[] = [];
  for (let z = tiles.minzoom; z <= tiles.maxzoom; z++) {
    const max = 2 ** z - 1;
    const x0 = Math.max(0, Math.min(max, lonToX(w, z)));
    const x1 = Math.max(0, Math.min(max, lonToX(e, z)));
    const y0 = Math.max(0, Math.min(max, latToY(n, z)));
    const y1 = Math.max(0, Math.min(max, latToY(s, z)));
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        out.push(
          dataUrl(
            tiles.url_template
              .replace('{z}', String(z))
              .replace('{x}', String(x))
              .replace('{y}', String(y)),
          ),
        );
      }
    }
  }
  return out;
}

// ---------- plan assembly ----------

export interface PackInputs {
  corneaId: string;
  /** Root-relative manifest path from the catalog entry, e.g. /catalogs/incidents/id/{fk}.json */
  manifestPath: string | null;
  /** Root-relative hotspot index path from the catalog entry. */
  hotspotIndexPath: string | null;
  manifest: IncidentManifest | null;
  hotspotIndex: HotspotArchiveIndex | null;
  perimeterIndex: PerimeterIndexItem[] | null;
  spreadRun: PyrecastRun | null;
  /** The run WeatherSection would render (renderable-first) + its products. */
  weatherRun: WeatherRun | null;
  weatherProducts: string[];
  /** The fire's routing-index entry + its descriptor (both or neither). */
  routingEntry?: RoutingIndexEntry | null;
  routingBundle?: RoutingBundle | null;
  nowMs: number;
}

/** The snapshot JSONs every pack carries (mutable; always re-downloaded). */
export function snapshotUrls(inp: PackInputs): string[] {
  const urls = [
    firesIndexUrl(),
    `${DATA_BASE_URL}/catalogs/catalog.json`,
    `${DATA_BASE_URL}/catalogs/pyrecast_runs.json`,
    `${DATA_BASE_URL}/catalogs/weather_runs.json`,
    `${FIRE_API}/fires/${encodeURIComponent(inp.corneaId)}`,
    `${FIRE_API}/fires/${encodeURIComponent(inp.corneaId)}/perimeters`,
  ];
  if (inp.manifestPath) urls.push(dataUrl(inp.manifestPath));
  if (inp.hotspotIndexPath) urls.push(dataUrl(inp.hotspotIndexPath));
  // The index is how the offline app finds the bundle; packed as a snapshot.
  if (inp.routingEntry && inp.routingBundle) urls.push(routingIndexUrl());
  return urls;
}

export function buildPackPlan(inp: PackInputs): PackPlan {
  const files: PackFilePlan[] = snapshotUrls(inp).map((url) => ({
    url,
    immutable: false,
    estBytes: EST.json,
  }));
  let tileCount = 0;
  let mapSheetCount = 0;

  // Perimeter versions: latest + everything from the last 7 days. Version
  // paths are verbatim from the index (never reconstructed) and immutable.
  const perims = inp.perimeterIndex ?? [];
  if (perims.length > 0) {
    const cutoff = inp.nowMs - 7 * DAY_MS;
    const ts = (p: PerimeterIndexItem) => Date.parse(p.date) || 0;
    const keep = perims.filter((p) => ts(p) >= cutoff);
    const latest = perims.reduce((a, b) => (ts(b) > ts(a) ? b : a));
    if (!keep.includes(latest)) keep.push(latest);
    for (const p of keep) {
      files.push({ url: `${FIRE_API}${p.path}`, immutable: true, estBytes: EST.perimeter });
    }
  }

  // Hotspots: the full archive (closed days are immutable; today's chunk is not).
  if (inp.hotspotIndex && inp.hotspotIndexPath) {
    const dir = dataUrl(inp.hotspotIndexPath).replace(/\/index\.json$/, '');
    const gen = inp.hotspotIndex.gen ?? 1;
    // A chunk stored while its day (or the archive's resume window — the
    // worker can rewrite yesterday) was still open would be frozen forever by
    // the skip-if-stored rule, so only days closed for 2+ days count immutable.
    const closed = new Date(inp.nowMs - 2 * DAY_MS).toISOString().slice(0, 10);
    for (const day of inp.hotspotIndex.days) {
      files.push({
        url: `${dir}/g${gen}/${day}.json`,
        immutable: day < closed,
        estBytes: EST.hotspotDay,
      });
    }
  }

  // Fire forecast: the latest run's time-of-arrival tifs, all percentiles
  // (the default forecast view; hourly product tars are out of v1).
  if (inp.spreadRun) {
    for (const pct of toaPercentiles(inp.spreadRun)) {
      files.push({
        url: spreadToaUrl(inp.spreadRun, pct),
        immutable: true,
        estBytes: EST.toaTif,
      });
    }
  }

  // Weather raster layers: the active run's frames for every rendered
  // product, capped to the first WEATHER_HOURS_CAP forecast hours, plus the
  // wind U/V grids for the arrow overlay. URLs come from the same resolvers
  // the map uses, so offline serving matches byte-for-byte.
  if (inp.weatherRun?.frames) {
    const hours = inp.weatherRun.frames.hours.slice(0, WEATHER_HOURS_CAP);
    for (const product of inp.weatherProducts) {
      for (const h of hours) {
        files.push({
          url: weatherImageUrl(inp.weatherRun, product, h),
          immutable: true,
          estBytes: EST.weatherFrame,
          optional: true,
        });
      }
    }
    for (const h of hours) {
      const uv = windUvUrl(inp.weatherRun, h);
      if (uv) files.push({ url: uv, immutable: true, estBytes: EST.windUv, optional: true });
    }
  }

  // Incident maps from the last 2 days: full tile pyramids + previews. A
  // fire whose newest sheets predate the window still packs its most recent
  // DATED sheet day — an older ops map beats no map in the field.
  const mapCutoff = new Date(inp.nowMs - 2 * DAY_MS).toISOString().slice(0, 10);
  const dated = (inp.manifest?.maps ?? []).filter((m) => m.op_date);
  const anyInWindow = dated.some((m) => m.op_date! >= mapCutoff);
  const newestDay = dated.reduce<string | null>(
    (best, m) => (best && best >= m.op_date! ? best : m.op_date!),
    null,
  );
  const effectiveCutoff = anyInWindow ? mapCutoff : newestDay ?? mapCutoff;
  for (const m of inp.manifest?.maps ?? []) {
    // Thumbnails for the whole Maps tab (small); tile pyramids stay windowed.
    if (m.preview_url) {
      files.push({ url: dataUrl(m.preview_url), immutable: true, estBytes: EST.preview });
    }
    if (!m.op_date || m.op_date < effectiveCutoff) continue;
    mapSheetCount += 1;
    if (m.tiles) {
      const urls = sheetTileUrls(m.tiles);
      tileCount += urls.length;
      for (const url of urls) files.push({ url, immutable: true, estBytes: EST.tile });
    }
  }

  // IR flights (usually few; geojson is small), with their card thumbnails.
  for (const f of inp.manifest?.ir_flights ?? []) {
    if (f.geojson_url) {
      files.push({ url: dataUrl(f.geojson_url), immutable: true, estBytes: EST.json });
    }
    if (f.preview_url) {
      files.push({ url: dataUrl(f.preview_url), immutable: true, estBytes: EST.preview });
    }
  }

  // Offline Walk: descriptor + grid, DEM, graph, trails extract. All
  // immutable (versioned bundle URLs) and none optional — the descriptor
  // lists only files that exist, and a hole would break offline routing.
  let routingBytes = 0;
  if (inp.routingEntry && inp.routingBundle) {
    files.push({ url: dataUrl(inp.routingEntry.descriptor), immutable: true, estBytes: EST.json });
    const fs = inp.routingBundle.files;
    for (const f of [fs.grid, fs.dem, fs.graph, fs.trails]) {
      if (!f) continue;
      files.push({ url: dataUrl(f.path), immutable: true, estBytes: f.bytes });
      routingBytes += f.bytes;
    }
  }

  return {
    files,
    estBytes: files.reduce((sum, f) => sum + f.estBytes, 0),
    tileCount,
    mapSheetCount,
    routingBytes,
  };
}

/** "~180 MB" style label. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

// ---------- stored packs ----------

/** A pack's pack.json. */
export interface PackMeta {
  version: 1;
  /** The OPFS folder the pack lives in (packs/{slug}/), whatever its name:
   * older app versions read packs/{slug}, so it must equal the folder. */
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
  /** URLs of immutable files (served pack-first). Absent on older packs. */
  immutable?: string[];
  /** The routing bundle this pack holds, when the fire had one. */
  routing?: { descriptor: string; bundleId: string; bytes: number };
}

/** Where a packed URL is stored. */
export interface PackHit {
  folder: string;
  file: string;
}

function savedAt(m: PackMeta): number {
  const t = Date.parse(m.downloadedAt);
  return Number.isNaN(t) ? -Infinity : t;
}

/** Winner first: the newest download (an unparseable date is oldest), then
 * the folder named for the fire's key, then the alphabetically first folder. */
function packOrder(a: PackMeta, b: PackMeta): number {
  const ta = savedAt(a);
  const tb = savedAt(b);
  if (ta !== tb) return tb > ta ? 1 : -1;
  const ida = a.slug === fireKey(a.corneaId);
  const idb = b.slug === fireKey(b.corneaId);
  if (ida !== idb) return ida ? -1 : 1;
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

/**
 * The pack each fire serves from, keyed by fire key, from every stored
 * pack by folder. One fire can hold two folders (its old fire_slug folder
 * and its fire-key folder, or a copy an older app version wrote): the
 * newest download wins and `claimants` lists them all, winner first.
 */
export function choosePacks(found: Iterable<readonly [folder: string, meta: PackMeta]>): {
  packs: Record<string, PackMeta>;
  claimants: Record<string, string[]>;
} {
  const byFire = new Map<string, PackMeta[]>();
  for (const [folder, meta] of found) {
    const fk = fireKey(meta.corneaId);
    if (!fk) continue;
    const list = byFire.get(fk) ?? [];
    list.push({ ...meta, slug: folder });
    byFire.set(fk, list);
  }
  const packs: Record<string, PackMeta> = {};
  const claimants: Record<string, string[]> = {};
  for (const [fk, list] of byFire) {
    list.sort(packOrder);
    packs[fk] = list[0];
    claimants[fk] = list.map((m) => m.slug);
  }
  return { packs, claimants };
}

/** A fire's pack, found by any spelling of its cornea_id. */
export function packForFire(
  packs: Record<string, PackMeta>,
  corneaId: string | null | undefined,
): PackMeta | null {
  const fk = fireKey(corneaId);
  return fk && Object.hasOwn(packs, fk) ? packs[fk] : null;
}

/** The folder a download of this fire writes: the folder its pack already
 * lives in (an update keeps a legacy fire_slug folder), else its fire key. */
export function downloadFolder(
  packs: Record<string, PackMeta>,
  corneaId: string | null | undefined,
): string | null {
  return packForFire(packs, corneaId)?.slug ?? fireKey(corneaId);
}

export interface ServingIndex {
  urls: Map<string, PackHit>;
  /** Newest pack first, so the first prefix match is the newest copy. */
  prefixes: (PackHit & { prefix: string })[];
  /** URLs whose served copy is immutable (served pack-first even online). */
  immutable: Set<string>;
}

/**
 * The url -> stored-file index over every complete pack, shadowed copies
 * included: a URL two packs hold (catalog.json, or a manifest URL a name
 * passed between fires) serves the newest pack's copy, and removing one
 * pack keeps every URL another pack still holds.
 */
export function servingIndex(metas: Iterable<PackMeta>): ServingIndex {
  const newestFirst = [...metas].sort(packOrder);
  const urls = new Map<string, PackHit>();
  for (const m of [...newestFirst].reverse()) {
    for (const [url, file] of Object.entries(m.files)) urls.set(url, { folder: m.slug, file });
  }
  const immutable = new Set<string>();
  for (const m of newestFirst) {
    for (const url of m.immutable ?? []) {
      if (urls.get(url)?.folder === m.slug) immutable.add(url);
    }
  }
  const prefixes = newestFirst.flatMap((m) =>
    m.prefixes.map((p) => ({ prefix: p.prefix, folder: m.slug, file: p.file })),
  );
  return { urls, prefixes, immutable };
}

/**
 * A request for a fire's ID manifest (/catalogs/incidents/id/{fk}.json)
 * served from that fire's own pack when the pack predates ID manifests and
 * holds its manifest under the old name-filed URL. Read from the fire's own
 * pack, never through the shared index: a newer pack of a same-name fire
 * can hold that same legacy URL with the other fire's manifest.
 */
export function aliasHit(
  url: string,
  packs: Record<string, PackMeta>,
  dataBase: string,
): PackHit | null {
  const head = `${dataBase}/catalogs/incidents/id/`;
  if (!url.startsWith(head)) return null;
  const m = /^([0-9a-z-]{1,64})\.json$/.exec(url.slice(head.length));
  const pack = m && Object.hasOwn(packs, m[1]) ? packs[m[1]] : null;
  if (!pack) return null;
  const manifests = Object.keys(pack.files).filter((k) =>
    k.startsWith(`${dataBase}/catalogs/incidents/`),
  );
  return manifests.length === 1 ? { folder: pack.slug, file: pack.files[manifests[0]] } : null;
}
