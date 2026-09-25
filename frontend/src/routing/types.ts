/**
 * Contracts with the worker's trails build and per-fire routing bundles
 * (docs/trails-routing/FINAL_PLAN.md §2; worker/responder_worker/
 * trails.py, routing_bundle.py). Every path is root-relative — resolve with
 * dataUrl(). Fields are optional-tolerant where older docs may lack them.
 */

/** Bundles newer than this need an app update (the grid/graph encodings or
 * the cost model changed); the app then treats the fire as unbundled. */
export const SUPPORTED_RECIPE = 1;

/** catalogs/trails.json — the national trails pointer. */
export interface TrailsPointer {
  schema: string;
  build_id: string;
  built_at: string;
  pmtiles: string;
  /** Same object via the S3 endpoint: its 206s carry ETag, so Chrome
   * HTTP-caches range reads (the native f005 URL's are not cached). */
  pmtiles_url_s3?: string | null;
  pmtiles_bytes?: number;
  fgb?: string;
  layer: string;
  minzoom: number;
  maxzoom: number;
  bounds: [number, number, number, number];
  counts?: Record<string, number>;
  source_dates?: Record<string, string | null>;
  attribution?: string;
}

export interface RoutingIndexEntry {
  descriptor: string;
  bundle_id: string;
  built_at: string;
  bbox: [number, number, number, number];
  cell_m: number;
  bytes: number;
}

/** catalogs/routing.json */
export interface RoutingIndex {
  schema: string;
  generated_at: string;
  recipe: number;
  fires: Record<string, RoutingIndexEntry>;
}

export interface BundleFile {
  path: string;
  bytes: number;
  sha256?: string;
}

/** routing/{fire_key}/b{bundle_id}/bundle.json (immutable). */
export interface RoutingBundle {
  schema: string;
  recipe: number;
  bundle_id: string;
  cornea_id: string;
  fire_key: string;
  fire_name?: string | null;
  built_at: string;
  crs: { epsg: number; zone: number; northern: boolean };
  grid: { x0: number; y0: number; cell_m: number; width: number; height: number };
  bounds4326: [number, number, number, number];
  aoi?: { source?: string; perimeter_date?: string | null; buffer_m?: number; clipped?: boolean };
  files: {
    grid: BundleFile;
    dem: BundleFile;
    graph: BundleFile & { nodes?: number; edges?: number };
    trails?: BundleFile & { minzoom: number; maxzoom: number };
  };
  sources?: {
    landfire?: { veg?: string; topo?: string; via?: string };
    osm?: { regions?: string[]; date?: string | null };
    trails?: { build_id?: string | null };
    nhd?: { huc8?: string[] };
  };
  stats?: Record<string, unknown>;
  warnings?: string[];
  attribution?: string[];
  license?: string;
}
