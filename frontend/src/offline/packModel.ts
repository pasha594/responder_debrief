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
 */
import { DATA_BASE_URL, FIRE_API } from '../app/config';
import { dataUrl } from '../api/catalogs';
import { spreadToaUrl, toaPercentiles } from '../api/wmsUrls';
import type {
  HotspotArchiveIndex,
  IncidentManifest,
  PerimeterIndexItem,
  PyrecastRun,
} from '../api/types';

export interface PackFilePlan {
  url: string;
  /** Immutable content (skip re-download when already stored). */
  immutable: boolean;
  /** Rough size for the pre-download estimate, bytes. */
  estBytes: number;
}

export interface PackPlan {
  files: PackFilePlan[];
  estBytes: number;
  tileCount: number;
  mapSheetCount: number;
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
};

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
  slug: string;
  /** Root-relative manifest path from the catalog entry, e.g. /catalogs/incidents/x.json */
  manifestPath: string | null;
  /** Root-relative hotspot index path from the catalog entry. */
  hotspotIndexPath: string | null;
  manifest: IncidentManifest | null;
  hotspotIndex: HotspotArchiveIndex | null;
  perimeterIndex: PerimeterIndexItem[] | null;
  spreadRun: PyrecastRun | null;
  nowMs: number;
}

/** The snapshot JSONs every pack carries (mutable; always re-downloaded). */
export function snapshotUrls(inp: PackInputs): string[] {
  const urls = [
    `${FIRE_API}/fires?active=true&limit=500&fields=cornea_id,unique_slug,post_title,fire_coordinates,acres,containment,state,firetype,created_on,last_updated,poly_last_updated,active`,
    `${DATA_BASE_URL}/catalogs/catalog.json`,
    `${DATA_BASE_URL}/catalogs/pyrecast_runs.json`,
    `${DATA_BASE_URL}/catalogs/weather_runs.json`,
    `${FIRE_API}/fires/${encodeURIComponent(inp.corneaId)}`,
    `${FIRE_API}/fires/${encodeURIComponent(inp.corneaId)}/perimeters`,
  ];
  if (inp.manifestPath) urls.push(dataUrl(inp.manifestPath));
  if (inp.hotspotIndexPath) urls.push(dataUrl(inp.hotspotIndexPath));
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
    const today = new Date(inp.nowMs).toISOString().slice(0, 10);
    for (const day of inp.hotspotIndex.days) {
      files.push({
        url: `${dir}/g${gen}/${day}.json`,
        immutable: day < today,
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

  // Incident maps from the last 2 days: full tile pyramids + previews.
  const mapCutoff = new Date(inp.nowMs - 2 * DAY_MS).toISOString().slice(0, 10);
  for (const m of inp.manifest?.maps ?? []) {
    if (!m.op_date || m.op_date < mapCutoff) continue;
    mapSheetCount += 1;
    if (m.preview_url) {
      files.push({ url: dataUrl(m.preview_url), immutable: true, estBytes: EST.preview });
    }
    if (m.tiles) {
      const urls = sheetTileUrls(m.tiles);
      tileCount += urls.length;
      for (const url of urls) files.push({ url, immutable: true, estBytes: EST.tile });
    }
  }

  // IR flights (usually few; geojson is small).
  for (const f of inp.manifest?.ir_flights ?? []) {
    if (f.geojson_url) {
      files.push({ url: dataUrl(f.geojson_url), immutable: true, estBytes: EST.json });
    }
  }

  return {
    files,
    estBytes: files.reduce((sum, f) => sum + f.estBytes, 0),
    tileCount,
    mapSheetCount,
  };
}

/** "~180 MB" style label. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}
