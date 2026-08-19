/** Types for the fire API and the worker-produced B2 catalogs. */

// ---------- fire-api-prod.web.app ----------

/** Slim projection used by the national fires index. */
export interface FireSummary {
  cornea_id: string;
  unique_slug: string;
  post_title: string;
  /** "lat, lon" STRING — parse with parseFireCoordinates only. */
  fire_coordinates: string | null;
  acres: number | null;
  containment: number | null;
  state: string;
  firetype: 'Wildfire' | 'Prescribed Fire' | string;
  created_on: string;
  last_updated: string;
  poly_last_updated: string | null;
  active: boolean;
}

export interface StructureExposureBuffer {
  buffer_miles: number;
  housing_units: number | null;
  buildings: number | null;
  population: number | null;
  major_roads_mi: number | null;
  historic_structures: number | null;
  emergency_service_sites: number | null;
  hospitals: number | null;
  electric_substations: number | null;
  electric_line_mi: number | null;
}

export interface FireDetail extends FireSummary {
  unique_fire_id: string | null;
  containment: number | null;
  cause: string | null;
  general_cause: string | null;
  complexity_type: string | null;
  primary_fuel_group: string | null;
  county: string | null;
  days: number | null;
  general_behavior: string | null;
  personnel: number | null;
  description: string | null;
  city: string | null;
  state_full: string | null;
  contained_at: string | null;
  timezone: string | null;
  nearby_states: string[] | null;
  latest_summary: {
    summary_text: string;
    citations: unknown[];
    created_at: string;
  } | null;
  inciweb: { incident_url: string | null; media: unknown[] } | null;
  structure_exposure: {
    published_at: string;
    buffers: StructureExposureBuffer[];
  } | null;
}

export interface FiresListResponse {
  fires: FireSummary[];
  pagination: {
    limit: number;
    offset: number;
    returned: number;
    total: number;
    wildfireCount: number;
    prescribedCount: number;
  };
}

/** Perimeter version index entry. `path` MUST be used verbatim. */
export interface PerimeterIndexItem {
  path: string;
  date: string; // ISO
}

export interface HotspotProperties {
  latitude: number;
  longitude: number;
  source: string; // MODIS | SNPP | NOAA-20 | NOAA-21
  acq_date: string; // YYYY-MM-DD
  acq_time: string; // HHMM as float-ish string, e.g. "421.0"
  confidence: string; // numeric for MODIS, l/n/h for VIIRS
  frp: number | null;
  brightness: number | null;
  /** added at ingest: */
  acq_ts?: number;
  conf_norm?: 'low' | 'nominal' | 'high';
}

export type HotspotFeatureCollection = GeoJSON.FeatureCollection<GeoJSON.Point, HotspotProperties>;
export type PerimeterFeature = GeoJSON.Feature<GeoJSON.MultiPolygon | GeoJSON.Polygon, Record<string, unknown>>;

// ---------- Worker catalogs (B2) ----------

export interface CatalogFire {
  fire_slug: string;
  cornea_id: string;
  unique_fire_id: string | null;
  name: string;
  coordinates: [number, number]; // [lon, lat]
  state: string;
  acres: number | null;
  containment: number | null;
  active: boolean;
  last_updated: string;
  poly_last_updated: string | null;
  timezone: string | null;
  /**
   * Fields below arrived with the directory pivot; older catalogs (and a
   * CDN-cached one mid-deploy) omit them, so every consumer must guard.
   */
  created_on?: string | null;
  has_incident_maps: boolean;
  incident_manifest: string | null;
  incident_last_synced?: string | null;
  /** FTP map sheets mirrored for this fire. */
  incident_map_count?: number | null;
  /** IR flight packages mirrored for this fire. */
  incident_ir_count?: number | null;
  /** YYYY-MM-DD of the newest FTP upload. */
  incident_latest_upload?: string | null;
  ftp_match: {
    method: 'unit_id' | 'name_exact' | 'name_fuzzy';
    confidence: number;
    dir_url: string;
  } | null;
  has_spread_forecast: boolean;
  spread_latest_run: string | null;
}

export interface MasterCatalog {
  schema_version: number;
  version: number;
  generated_at: string;
  fires: CatalogFire[];
  counts: Record<string, number>;
  /**
   * Pre-rendered national overlay snapshots (worker-produced static frames on
   * B2). `image` is root-relative to DATA_BASE_URL and MUTABLE (the worker
   * overwrites it every sync) — cache-bust with `as_of`.
   * Optional: layers hide gracefully when absent.
   */
  national_layers?: {
    current_year_perimeters?: {
      image: string;
      bounds: [number, number, number, number]; // [w, s, e, n] EPSG:4326
      as_of: string;
    };
  };
}

export type SpreadProduct =
  | 'spread-rate'
  | 'flame-length'
  | 'crown-fire'
  | 'hours-since-burned'
  | 'time-of-arrival'
  | 'isochrones';

export type Percentile = 10 | 30 | 50 | 70 | 90;

/**
 * v2 (schema_version 2, docs/spec-archives.md): per hourly product — which
 * percentiles have a granule tar, the archive-base-relative tar template, and
 * a data-driven legend ramp. `legend` is the v1 legend-image leftover, kept
 * optional for parse tolerance only.
 */
export interface SpreadProductMeta {
  /** Percentiles with an ok tar in the archive manifest (subset of 10..90). */
  percentiles: number[];
  /** e.g. "/forecast_archive/{slug}/{run_ts}/{pct}_{product}.tar" */
  tar_template: string;
  units: string | null;
  /** [value, cssColor] pairs ascending — GradientLegend + client colormap. */
  legend_stops: [number, string][];
  /** Present for discrete products (crown-fire): one label per stop. */
  legend_labels?: string[];
  /** v1 leftover (legend image path) — unused in v2, tolerated when present. */
  legend?: string;
}

/** Time-of-arrival colorize hint: burned + leading-edge colors. */
export interface ToaRamp {
  /** Width of the bright leading edge, in hours behind the scrub time. */
  recent_hours: number;
  /** [["burned", css], ["recent", css]] */
  stops: [string, string][];
}

/**
 * v2 run: rendered CLIENT-SIDE straight from the public forecast archive
 * (docs/spec-archives.md). ToA tifs and hourly product tars are decoded in
 * the browser; url/tar templates are archive-base-relative — resolve via
 * wmsUrls spread resolvers (prepends the catalog's archive_base).
 */
export interface PyrecastRun {
  /** "{slug}_{run_ts}" */
  workspace: string;
  slug: string;
  run_ts: string;
  run_time: string; // ISO
  /** Timeline extent: coverage = run_time .. run_time + horizon_hours. */
  horizon_hours: number;
  centroid: [number, number] | null; // [lon, lat]
  /**
   * [w, s, e, n] EPSG:4326. v2 catalogs do NOT emit this (the grid lives in
   * the tifs); the spread layer back-fills it from the decoded grid. Every
   * consumer must guard for null/absent.
   */
  bbox: [number, number, number, number] | null;
  /** Time-of-arrival availability; null when no {pct}.tif is ok. */
  toa: {
    /** Percentiles with files[pct].ok in the archive manifest. */
    percentiles: number[];
    /** e.g. "/forecast_archive/{slug}/{run_ts}/{pct}.tif" */
    url_template: string;
  } | null;
  products: Partial<Record<SpreadProduct, SpreadProductMeta>>;
  toa_ramp?: ToaRamp;
}

export interface PyrecastRunsCatalog {
  schema_version: number;
  generated_at: string;
  /** Loose provenance string, e.g. "fire-forecast-archive". */
  source?: string;
  /** Public archive origin; prepended to the runs' relative templates. */
  archive_base?: string;
  fires: Record<string, { pyrecast_slug: string; runs: PyrecastRun[] }>;
  unmatched_slugs?: string[];
}

export type WeatherProduct =
  | 'tmpf'
  | 'rh'
  | 'ws'
  | 'wg'
  | 'wd'
  | 'ffwi'
  | 'smoke'
  | 'tcdc'
  | 'pign'
  | 'meq'
  | 'apcp01'
  | 'apcptot';

/**
 * The fire-critical products the frames worker actually pre-renders. The
 * WeatherProduct union stays broad for old catalogs/state, but the UI and
 * layers only offer this intersection. ('wd' retired: wind direction is now
 * the per-hour U/V grid rendered as arrows, not a raster.)
 */
export const RENDERED_WEATHER_PRODUCTS = [
  'tmpf',
  'rh',
  'ws',
  'wg',
  'ffwi',
  'smoke',
  'apcp01',
] as const satisfies readonly WeatherProduct[];

export type RenderedWeatherProduct = (typeof RENDERED_WEATHER_PRODUCTS)[number];

/**
 * Pre-rendered CONUS weather frames on B2, one image per product per forecast
 * hour. Template root-relative to DATA_BASE_URL; `{epoch_ms}` = Date.parse of
 * an ISO hour from `hours`. Immutable run-stamped keys.
 */
export interface WeatherFrames {
  bounds: [number, number, number, number]; // [w, s, e, n] EPSG:4326 (CONUS)
  /** e.g. "/frames/weather/{ws}/{product}/{epoch_ms}.png" */
  image_template: string;
  /**
   * Per-hour wind U/V grid JSONs for the arrow overlay, e.g.
   * "/frames/weather/{ws}/wind_uv/{epoch_ms}.json". Absent on manifests
   * older than the arrows worker — degrade to no arrows.
   */
  wind_uv_template?: string;
  /** ISO hours actually rendered — the scrubber uses THESE. */
  hours: string[];
  /** false while the worker's per-sync image budget cut this run short. */
  complete: boolean;
}

export interface WeatherRun {
  workspace: string;
  run_time: string;
  hours: string[]; // ISO, hourly
  /** Static-frame block — absent only on catalogs older than the frames worker. */
  frames?: WeatherFrames;
}

/**
 * Per-product metadata in the weather manifest. `legend_stops` (HRRR worker)
 * is a value→color ramp mirroring the gdaldem ramp files; when present the UI
 * renders a data-driven gradient legend instead of a legend image.
 */
export interface WeatherProductMeta {
  label: string;
  units?: string;
  /** [value, cssColor] pairs sorted ascending by value. */
  legend_stops?: [number, string][];
}

export interface WeatherRunsCatalog {
  schema_version: number;
  generated_at: string;
  /** Loose provenance string, e.g. "noaa-hrrr" (older catalogs omit it). */
  source?: string;
  models: Record<
    string,
    {
      label: string;
      products: Partial<Record<WeatherProduct, WeatherProductMeta>>;
      runs: WeatherRun[];
      /** Root-relative legend template, e.g. "/frames/legends/weather-{product}.png". */
      legend_template?: string;
    }
  >;
}

export interface IncidentMapEntry {
  id: string; // sha16
  kind: 'product' | 'qr' | 'mobile';
  product: string;
  product_label: string;
  sheet: string | null;
  orientation: string | null;
  op_date: string | null;
  period: 'day' | 'night' | null;
  /** Fire-local wall time parsed from the filename (no zone suffix). */
  generated_at_local?: string | null;
  /** UTC ISO of the FTP Last-Modified — when the sheet was uploaded. */
  uploaded_at?: string | null;
  filename: string;
  pdf_url: string;
  size_bytes: number | null;
  georeferenced: boolean;
  projection: string | null;
  preview_url: string | null;
  tiles: {
    url_template: string;
    minzoom: number;
    maxzoom: number;
    bounds: [number, number, number, number]; // [w, s, e, n]
  } | null;
  tiling_pending: boolean;
  rev: number;
}

export interface IrFlight {
  flight_date: string;
  flight_id: string;
  no_flight_reason: string | null;
  geojson_url: string | null;
  heat_types: string[];
  estimated_acres: number | null;
  pdf_url: string | null;
  kmz_url: string | null;
  readme_url: string | null;
}

export interface IncidentManifest {
  schema_version: number;
  fire_slug: string;
  cornea_id: string;
  generated_at: string;
  source_dir: string;
  region: string;
  unit_incident: string | null;
  maps: IncidentMapEntry[];
  ir_flights: IrFlight[];
}


// ---------- catalogs/imsr.json (NIFC daily sit report, per-fire) ----------

export interface ImsrEntry {
  name: string;
  unit: string;
  acres: number | null;
  acres_change: number | null;
  contained_pct: number | null;
  /** 'Ctn' (containment) or 'Comp' (completion, full-suppression alt). */
  containment_kind: string;
  /** "M/D" or null when unknown. */
  est_containment: string | null;
  personnel: number | null;
  personnel_change: number | null;
  crews: number | null;
  engines: number | null;
  helicopters: number | null;
  structures_lost: number | null;
  /** e.g. "56.2M" — as printed in the report. */
  cost_to_date: string | null;
  owner: string;
  narrative: string | null;
}

export interface ImsrCatalog {
  schema_version: number;
  generated_at: string;
  source_url: string;
  fires: Record<string, ImsrEntry>;
}


// ---------- catalogs/health.json (ingestion heartbeat) ----------

export interface HealthWeatherRun {
  workspace: string;
  rendered: number;
  expected: number;
}

export interface HealthCatalogsEntry {
  started_at: string;
  finished_at: string;
  ok: boolean;
  note: string | null;
  catalog_version: number;
  fires: number;
  matched_incident_dirs: number;
  spread_fires: number;
  weather: {
    gdal_available: boolean;
    images_fetched: number;
    carried_forward: boolean;
    deadline_hit: boolean;
    runs: HealthWeatherRun[];
  };
  imsr: { published: boolean; matched_fires: number };
}

export interface HealthMirrorEntry {
  started_at: string;
  finished_at: string;
  ok: boolean;
  note: string | null;
  catalog_version: number;
  candidates: number;
  unchanged_skips: number;
  mirrored_incidents: number;
  files_downloaded: number;
  bytes_downloaded: number;
  failed_incidents: string[];
  deadline_hit: boolean;
  gdal_available: boolean;
}

export interface HealthDoc {
  schema_version: number;
  updated_at: string;
  catalogs?: HealthCatalogsEntry;
  mirror?: HealthMirrorEntry;
  history?: { job: string; at: string; ok: boolean; note: string | null }[];
}
