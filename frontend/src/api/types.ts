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
  has_incident_maps: boolean;
  incident_manifest: string | null;
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
 * Pre-rendered spread-forecast frames on B2 (worker `frames.py`). Templates
 * are root-relative to DATA_BASE_URL; `{epoch_ms}` = Date.parse of a VERBATIM
 * instant from `instants`. Frames are run-stamped and immutable.
 */
export interface SpreadFrames {
  /** Only these percentiles are pre-rendered (v1: [50, 90]). */
  percentiles: Percentile[];
  /** Thinned VERBATIM ISO subset of time_instants — the scrubber uses THESE. */
  instants: string[];
  /** e.g. "/frames/spread/{ws}/{pct}/{product}/{epoch_ms}.png" */
  timed_template: string;
  /** e.g. "/frames/spread/{ws}/{pct}/{product}/static.png" */
  static_template: string;
  /** false while the worker's per-sync image budget cut this run short. */
  complete: boolean;
}

export interface PyrecastRun {
  workspace: string;
  run_time: string;
  bbox: [number, number, number, number]; // [w, s, e, n] EPSG:4326
  native_crs: string;
  percentiles: Percentile[];
  /** VERBATIM ISO strings from caps — first instant has minute precision. */
  time_instants: string[];
  products: Partial<
    Record<
      SpreadProduct,
      {
        timed: boolean;
        vector?: boolean;
        /** Root-relative legend image, e.g. "/frames/legends/spread-{product}.png". */
        legend?: string;
      }
    >
  >;
  /** Static-frame block — absent only on catalogs older than the frames worker. */
  frames?: SpreadFrames;
}

export interface PyrecastRunsCatalog {
  schema_version: number;
  generated_at: string;
  fires: Record<string, { pyrecast_slug: string; runs: PyrecastRun[] }>;
  unmatched_workspaces: { workspace: string; slug: string; run_time: string; bbox: number[] }[];
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
 * The 8 fire-critical products the frames worker actually pre-renders (v1).
 * The WeatherProduct union stays broad for old catalogs/state, but the UI and
 * layers only offer this intersection.
 */
export const RENDERED_WEATHER_PRODUCTS = [
  'tmpf',
  'rh',
  'ws',
  'wg',
  'wd',
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

export interface WeatherRunsCatalog {
  schema_version: number;
  generated_at: string;
  models: Record<
    string,
    {
      label: string;
      products: Partial<Record<WeatherProduct, { label: string }>>;
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
