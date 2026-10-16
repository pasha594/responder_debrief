/**
 * Shared contracts for "My maps": georeferenced PDFs a user adds from their
 * own device. Everything runs in the browser — the PDF never leaves the
 * device. Pipeline:
 *
 *   File ─► storage (OPFS user-maps/{docId}/source.pdf)
 *        ─► pdfObjects.readPageViewports  (hand-rolled: /VP → RawViewport[])
 *        ─► georef.georefFromViewports    (main frame + 4 control points)
 *        ─► pdfRender.renderCrop          (pdf.js, lazy chunk: JPEG of the frame)
 *        ─► storage (p{n}.jpg, p{n}.thumb.jpg, meta.json written last)
 *   Map ─► tileRenderer (addProtocol 'rdusermap'): each raster tile is drawn
 *          from the stored JPEG through the map's real projection, so the
 *          overlay lands where GDAL would put it (a 4-corner image source
 *          is ~27 m off on a 28 km sheet and ~1 km off on area maps).
 *
 * Pure types only — no runtime code here.
 */

/** [x0, y0, x1, y1] */
export type Box = [number, number, number, number];
/** 2D affine [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f (canvas order). */
export type Affine = [number, number, number, number, number, number];
export type LonLat = [number, number];

/** One /Viewport dict of a page's /VP array, values exactly as written. */
export interface RawViewport {
  /** As written — may be inverted (y0 > y1); never normalize before applying LPTS. */
  bbox: Box;
  name: string | null;
  /** /Measure /Subtype is /GEO. */
  geo: boolean;
  /** Flat [lat, lon, lat, lon, …] as written (ISO 32000 GPTS order is lat first). */
  gpts: number[];
  /** Flat [x, y, …] unit coordinates relative to bbox, in GPTS order. */
  lpts: number[];
  bounds: number[] | null;
  /** /GCS /WKT (ESRI WKT1), or null when absent. */
  wkt: string | null;
}

/** What a byte sniff of the whole file says before any parsing. */
export interface PdfSniff {
  isPdf: boolean;
  encrypted: boolean;
  /** OGC best-practice (TerraGo) georeferencing — not supported. */
  lgidict: boolean;
}

export type GeorefWarning =
  /** Projection not implemented: placed with a local Transverse Mercator fit. */
  | 'approximate_projection'
  /** NAD 1927 datum: shifted to WGS84 with a 3-parameter transform (~5 m). */
  | 'nad27_shifted'
  /** A second georeferenced frame (inset/locator) sits inside the main frame. */
  | 'inset_in_frame'
  /** The 4 control points disagree with an affine frame by more than ~5 m. */
  | 'poor_fit';

/** Serializable georeferencing of one page's main map frame. */
export interface Georef {
  v: 1;
  wkt: string | null;
  /** Main frame bbox in page user space, normalized (x0<x1, y0<y1) — the crop. */
  frame: Box;
  /** Control points: page user-space point ↔ lon/lat IN THE WKT'S OWN DATUM. */
  points: { page: [number, number]; lonLat: LonLat }[];
  warnings: GeorefWarning[];
}

/** Live model built from a Georef (projection + fitted affine). */
export interface GeoModel {
  georef: Georef;
  /** True when the WKT projection isn't implemented (local fit used). */
  approximate: boolean;
  /** Worst control-point residual of the affine fit, meters. */
  fitResidualM: number;
  /** WGS84 lon/lat → page user-space point. Exact through the projection. */
  lonLatToPage(lon: number, lat: number): [number, number];
  /** Page user-space point → WGS84 lon/lat (numeric inverse of lonLatToPage). */
  pageToLonLat(x: number, y: number): LonLat;
  /** Frame outline in WGS84, densified along each edge (closed ring not repeated). */
  footprint(): LonLat[];
  /** Ground meters per page point at the frame center. */
  metersPerPoint: number;
}

/** One map in My maps = one georeferenced page of an imported PDF. */
export interface UserMapMeta {
  v: 1;
  /** `${docId}-p${page}` */
  id: string;
  /** sha256(file bytes) hex, first 16 chars — dedupes re-imports of the same file. */
  docId: string;
  /** 1-based page number. */
  page: number;
  pageCount: number;
  /** Display title: file name without ".pdf", plus " · page N" when the file has several maps. */
  title: string;
  fileName: string;
  fileBytes: number;
  /** ISO time of the import. */
  addedAt: string;
  image: {
    width: number;
    height: number;
    bytes: number;
    /** Page user space → image pixels (from pdf.js's viewport, offset to the crop). */
    pageToImage: Affine;
    /** Pixel budget the image was rendered at. */
    budgetPx: number;
  };
  georef: Georef;
  /** WGS84 bounds of the footprint [w, s, e, n]. */
  bounds: Box;
  center: LonLat;
  /** Raster source maxzoom (256-px tile grid) — about one level past native resolution. */
  maxzoom: number;
  warnings: GeorefWarning[];
  /** Every map page the doc had when it was imported, so re-adding the file
   * can tell "already saved" from "one of its maps was removed since". */
  mapPages?: number[];
}

export type ImportStage = 'reading' | 'saving' | 'locating' | 'drawing' | 'finishing';

export interface ImportProgress {
  fileName: string;
  stage: ImportStage;
  /** 1-based page being drawn, with the count of georeferenced pages. */
  page?: number;
  pages?: number;
}

export type ImportFailure =
  | 'not_pdf'
  | 'too_large'
  | 'no_georef'
  | 'lgidict'
  | 'encrypted'
  | 'parse_fail'
  | 'bad_location'
  | 'render_failed'
  | 'storage_full'
  | 'offline'
  /** Online, yet the pdf.js chunk wouldn't load: usually a deploy renamed it under an open tab. */
  | 'load_failed'
  | 'cancelled';

export type ImportResult =
  | { ok: true; maps: UserMapMeta[]; duplicate: boolean }
  | { ok: false; reason: ImportFailure; message: string };

/** Left in localStorage while an import renders; survives a jetsam reload. */
export interface ImportBreadcrumb {
  docId: string;
  fileName: string;
  budgetPx: number;
  startedAt: string;
}

/** The store's "My maps" slice. */
export interface UserMapsState {
  list: UserMapMeta[];
  /** listUserMaps has run once. */
  loaded: boolean;
  /** No OPFS writes in this browser: maps live only until the page closes. */
  sessionOnly: boolean;
  import: ImportProgress | null;
  notice:
    | { kind: 'error' | 'info'; text: string }
    | { kind: 'crashed'; text: string; docId: string }
    | null;
}
