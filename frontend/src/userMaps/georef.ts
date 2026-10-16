/**
 * GeoPDF viewports → a placed map frame, the way GDAL's PDF driver does it
 * (pdfdataset.cpp), so a user's PDF lands where GDAL — and the server-tiled
 * incident sheets — would put it.
 *
 *   georefFromViewports: de-duplicate the page's /VP viewports, pick the main
 *     one (first strictly largest |Δx·Δy| among GEO viewports), and turn its
 *     LPTS/GPTS pairs into page-point ↔ lon/lat control points. LPTS are
 *     applied to the BBox AS WRITTEN — never normalized — because one sample
 *     (three-queens) has an inverted BBox with LPTS outside the unit square,
 *     and others list the corners in rotated/permuted order.
 *   buildGeoModel: project the control points into the WKT's CRS and fit a
 *     least-squares affine page→CRS (GDAL's GCPs-to-geotransform, including
 *     its zeroing of rounding-noise rotation); lon/lat → page is then exact
 *     through the projection, and page → lon/lat is its numeric inverse.
 *     Within 0.1 m of GDAL's own corners on all 67 sample pages
 *     (georef.test.ts).
 *
 * Pure: no DOM, no pdf.js.
 */

import { crsDatumToWgs84, crsFromWkt, forward, wgs84ToCrsDatum } from './projection';
import type { Box, GeoModel, Georef, GeorefWarning, LonLat, RawViewport } from './types';

/** An affine fit whose worst control point is further off than this is 'poor_fit'. */
const POOR_FIT_M = 5;
/** Footprint samples per frame edge. */
const EDGE_SAMPLES = 16;

// WGS84, for turning small lon/lat differences into ground meters.
const WGS84_A = 6378137;
const WGS84_E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563);
const DEG = Math.PI / 180;

function normalizeBox(b: Box): Box {
  return [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
}

function boxArea(b: Box): number {
  return Math.abs((b[2] - b[0]) * (b[3] - b[1]));
}

function sameViewport(a: RawViewport, b: RawViewport): boolean {
  const eq = (x: number[], y: number[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  return eq(a.bbox, b.bbox) && eq(a.gpts, b.gpts) && eq(a.lpts, b.lpts) && a.wkt === b.wkt;
}

/** |cross product| of the triangle with the largest area, relative to the points' spread. */
function nonCollinear(pts: [number, number][]): boolean {
  let best = 0;
  let spread = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      spread = Math.max(spread, Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]));
      for (let k = j + 1; k < pts.length; k++) {
        const cross =
          (pts[j][0] - pts[i][0]) * (pts[k][1] - pts[i][1]) -
          (pts[j][1] - pts[i][1]) * (pts[k][0] - pts[i][0]);
        best = Math.max(best, Math.abs(cross));
      }
    }
  }
  return spread > 0 && best > 1e-6 * spread * spread;
}

/** The viewport's LPTS/GPTS pairs as control points; null unless ≥3 usable, non-collinear. */
function controlPoints(vp: RawViewport): Georef['points'] | null {
  const [x0, y0, x1, y1] = vp.bbox;
  if (![x0, y0, x1, y1].every(Number.isFinite) || boxArea(vp.bbox) === 0) return null;
  const pairs = Math.min(Math.floor(vp.gpts.length / 2), Math.floor(vp.lpts.length / 2));
  const points: Georef['points'] = [];
  for (let i = 0; i < pairs; i++) {
    const lat = vp.gpts[2 * i];
    const lon = vp.gpts[2 * i + 1];
    const lx = vp.lpts[2 * i];
    const ly = vp.lpts[2 * i + 1];
    if (![lat, lon, lx, ly].every(Number.isFinite)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    // GDAL pdfdataset.cpp: x = x0 + lx·(x1 − x0), y = y0 + ly·(y1 − y0), BBox as written.
    points.push({ page: [x0 + lx * (x1 - x0), y0 + ly * (y1 - y0)], lonLat: [lon, lat] });
  }
  if (points.length < 3) return null;
  if (!nonCollinear(points.map((p) => p.page)) || !nonCollinear(points.map((p) => p.lonLat))) {
    return null;
  }
  return points;
}

/**
 * A page's /VP viewports → the georeferencing of its main map frame, or null
 * when no GEO viewport has ≥3 usable control points. Flags 'inset_in_frame'
 * when another distinct GEO viewport (an inset map) sits mostly inside the
 * main frame — that inset is drawn at the wrong place once the main frame is
 * laid on the map.
 */
export function georefFromViewports(viewports: RawViewport[]): Georef | null {
  const distinct: RawViewport[] = [];
  for (const vp of viewports) {
    if (!distinct.some((d) => sameViewport(d, vp))) distinct.push(vp);
  }

  let main: RawViewport | null = null;
  let mainPoints: Georef['points'] | null = null;
  let mainArea = 0;
  for (const vp of distinct) {
    if (!vp.geo) continue;
    const pts = controlPoints(vp);
    if (!pts) continue;
    const area = boxArea(vp.bbox);
    if (area > mainArea) {
      main = vp;
      mainPoints = pts;
      mainArea = area;
    }
  }
  if (!main || !mainPoints) return null;

  const frame = normalizeBox(main.bbox);
  const warnings: GeorefWarning[] = [];
  const inset = distinct.some((vp) => {
    if (vp === main || !vp.geo) return false;
    const b = normalizeBox(vp.bbox);
    const area = boxArea(b);
    if (!(area > 0) || area >= 0.9 * mainArea) return false;
    const ix = Math.max(0, Math.min(b[2], frame[2]) - Math.max(b[0], frame[0]));
    const iy = Math.max(0, Math.min(b[3], frame[3]) - Math.max(b[1], frame[1]));
    return ix * iy >= 0.5 * area;
  });
  if (inset) warnings.push('inset_in_frame');

  return { v: 1, wkt: main.wkt, frame, points: mainPoints, warnings };
}

/** Least-squares affine q ≈ c + M·(p − pc), fitted in centred coordinates. */
interface Fit {
  pc: [number, number];
  qc: [number, number];
  /** Row-major 2×2: [m00, m01, m10, m11]. */
  m: [number, number, number, number];
}

function fitAffine(src: [number, number][], dst: [number, number][]): Fit {
  const n = src.length;
  const pc: [number, number] = [0, 0];
  const qc: [number, number] = [0, 0];
  for (let i = 0; i < n; i++) {
    pc[0] += src[i][0] / n;
    pc[1] += src[i][1] / n;
    qc[0] += dst[i][0] / n;
    qc[1] += dst[i][1] / n;
  }
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sxu = 0;
  let syu = 0;
  let sxv = 0;
  let syv = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i][0] - pc[0];
    const y = src[i][1] - pc[1];
    const u = dst[i][0] - qc[0];
    const v = dst[i][1] - qc[1];
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    sxu += x * u;
    syu += y * u;
    sxv += x * v;
    syv += y * v;
  }
  const det = sxx * syy - sxy * sxy;
  if (!(Math.abs(det) > 1e-12 * sxx * syy)) throw new Error('georef: control points are collinear');
  // Normal equations [sxx sxy; sxy syy]·[m0; m1] = [sxu; syu] (and for v).
  return {
    pc,
    qc,
    m: [
      (syy * sxu - sxy * syu) / det,
      (sxx * syu - sxy * sxu) / det,
      (syy * sxv - sxy * syv) / det,
      (sxx * syv - sxy * sxv) / det,
    ],
  };
}

function applyFit(fit: Fit, x: number, y: number): [number, number] {
  const dx = x - fit.pc[0];
  const dy = y - fit.pc[1];
  return [fit.qc[0] + fit.m[0] * dx + fit.m[1] * dy, fit.qc[1] + fit.m[2] * dx + fit.m[3] * dy];
}

/**
 * GDAL's clean-up of a north-up fit (pdfdataset.cpp, after
 * GDALGCPsToGeoTransform): rotation/shear terms under 1e-5 of the pixel size
 * are artifacts of GPTS rounded to 1e-5° (~1 m), so they are zeroed and the
 * scales recomputed through two opposite corners. GDAL anchors on the raster
 * (MediaBox) corners, which a Georef doesn't carry; anchoring on the frame
 * corners instead differs by millimetres. Without this the corners drift up
 * to ~0.6 m from GDAL's (and from the server-tiled incident sheets).
 */
function snapNorthUp(fit: Fit, frame: Box): Fit {
  const [m00, m01, m10, m11] = fit.m;
  if (Math.max(Math.abs(m01), Math.abs(m10)) >= 1e-5 * Math.min(Math.abs(m00), Math.abs(m11))) {
    return fit;
  }
  const [x0, y0, x1, y1] = frame;
  const tl = applyFit(fit, x0, y1);
  const br = applyFit(fit, x1, y0);
  return { pc: [x0, y1], qc: tl, m: [(br[0] - tl[0]) / (x1 - x0), 0, 0, (br[1] - tl[1]) / (y0 - y1)] };
}

/** Inverse of applyFit (q → p). */
function invertFit(fit: Fit): (u: number, v: number) => [number, number] {
  const [a, b, c, d] = fit.m;
  const det = a * d - b * c;
  if (!(Math.abs(det) > 0)) throw new Error('georef: singular page→CRS fit');
  return (u, v) => {
    const du = u - fit.qc[0];
    const dv = v - fit.qc[1];
    return [fit.pc[0] + (d * du - b * dv) / det, fit.pc[1] + (-c * du + a * dv) / det];
  };
}

/** Ground meters between two nearby WGS84 points (local ellipsoid radii; fine below ~10 km). */
function nearbyMeters(a: LonLat, b: LonLat): number {
  const phi = ((a[1] + b[1]) / 2) * DEG;
  const s = Math.sin(phi);
  const w = 1 - WGS84_E2 * s * s;
  const N = WGS84_A / Math.sqrt(w);
  const M = (WGS84_A * (1 - WGS84_E2)) / (w * Math.sqrt(w));
  return Math.hypot((b[1] - a[1]) * DEG * M, (b[0] - a[0]) * DEG * N * Math.cos(phi));
}

/**
 * The live model of a Georef: projection + least-squares affine page→CRS
 * over every control point. Adds 'approximate_projection', 'nad27_shifted'
 * and 'poor_fit' to georef.warnings (in place, once each).
 */
export function buildGeoModel(georef: Georef): GeoModel {
  const pts = georef.points;
  const center: LonLat = [
    pts.reduce((s, p) => s + p.lonLat[0], 0) / pts.length,
    pts.reduce((s, p) => s + p.lonLat[1], 0) / pts.length,
  ];
  const crs = crsFromWkt(georef.wkt, center);
  // GPTS are in the WKT's own datum: project them without a datum change.
  const crsPts = pts.map((p) => forward(crs, p.lonLat[0], p.lonLat[1]));
  const pagePts = pts.map((p) => p.page);
  const pageToCrs = snapNorthUp(fitAffine(pagePts, crsPts), georef.frame);
  const crsToPage = invertFit(pageToCrs);

  let fitResidualM = 0;
  pts.forEach((p, i) => {
    const [u, v] = applyFit(pageToCrs, p.page[0], p.page[1]);
    const du = u - crsPts[i][0];
    const dv = v - crsPts[i][1];
    let m: number;
    if (crs.kind === 'geographic') {
      // Degrees → meters on the ellipsoid at the point.
      m = nearbyMeters(p.lonLat, [p.lonLat[0] + du, p.lonLat[1] + dv]);
    } else {
      m = Math.hypot(du, dv) * crs.unitM;
    }
    fitResidualM = Math.max(fitResidualM, m);
  });

  const add = (w: GeorefWarning) => {
    if (!georef.warnings.includes(w)) georef.warnings.push(w);
  };
  if (crs.approximate) add('approximate_projection');
  if (crs.datum === 'nad27') add('nad27_shifted');
  if (fitResidualM > POOR_FIT_M) add('poor_fit');

  const lonLatToPage = (lon: number, lat: number): [number, number] => {
    const [dlon, dlat] = wgs84ToCrsDatum(crs, lon, lat);
    const [u, v] = forward(crs, dlon, dlat);
    return crsToPage(u, v);
  };

  // Newton seed: affine page → WGS84 lon/lat through the control points
  // (within ~4 km even on a 300 km frame; Newton converges in 2–4 steps).
  const seedFit = fitAffine(
    pagePts,
    pts.map((p) => crsDatumToWgs84(crs, p.lonLat[0], p.lonLat[1])),
  );

  const pageToLonLat = (x: number, y: number): LonLat => {
    let [lon, lat] = applyFit(seedFit, x, y);
    const h = 1e-6;
    for (let iter = 0; iter < 20; iter++) {
      const [px, py] = lonLatToPage(lon, lat);
      const rx = px - x;
      const ry = py - y;
      // Central-difference Jacobian ∂page/∂(lon, lat).
      const [ax, ay] = lonLatToPage(lon + h, lat);
      const [bx, by] = lonLatToPage(lon - h, lat);
      const [cx, cy] = lonLatToPage(lon, lat + h);
      const [ex, ey] = lonLatToPage(lon, lat - h);
      const j00 = (ax - bx) / (2 * h);
      const j10 = (ay - by) / (2 * h);
      const j01 = (cx - ex) / (2 * h);
      const j11 = (cy - ey) / (2 * h);
      const det = j00 * j11 - j01 * j10;
      if (!(Math.abs(det) > 0)) break;
      const dLon = (j11 * rx - j01 * ry) / det;
      const dLat = (-j10 * rx + j00 * ry) / det;
      lon -= dLon;
      lat -= dLat;
      if (Math.abs(dLon) < 1e-9 && Math.abs(dLat) < 1e-9) break;
    }
    return [lon, lat];
  };

  const [x0, y0, x1, y1] = georef.frame;
  const footprint = (): LonLat[] => {
    // Page space is y-up: TL → TR → BR → BL, EDGE_SAMPLES per edge, ring not closed.
    const corners: [number, number][] = [
      [x0, y1],
      [x1, y1],
      [x1, y0],
      [x0, y0],
    ];
    const ring: LonLat[] = [];
    for (let c = 0; c < 4; c++) {
      const [ax, ay] = corners[c];
      const [bx, by] = corners[(c + 1) % 4];
      for (let i = 0; i < EDGE_SAMPLES; i++) {
        const t = i / EDGE_SAMPLES;
        ring.push(pageToLonLat(ax + t * (bx - ax), ay + t * (by - ay)));
      }
    }
    return ring;
  };

  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const mx = nearbyMeters(pageToLonLat(cx - 0.5, cy), pageToLonLat(cx + 0.5, cy));
  const my = nearbyMeters(pageToLonLat(cx, cy - 0.5), pageToLonLat(cx, cy + 0.5));

  return {
    georef,
    approximate: crs.approximate,
    fitResidualM,
    lonLatToPage,
    pageToLonLat,
    footprint,
    metersPerPoint: Math.sqrt(mx * my),
  };
}

/**
 * False for coordinates that can't be a real incident map: a frame centred
 * within 1° of the equator (null island, and maps whose northing was never
 * set — mcconnell's pilot table sits at 0.0°N 121.5°W; no incident the app
 * covers is that close to the equator), beyond ±85° latitude, or a footprint
 * spanning more than 90° of longitude or 60° of latitude (a broken fit, not a
 * map sheet). The limits sit past continental size on purpose: the corners of
 * a conic frame fan out far wider in longitude than the land they frame, so a
 * correctly placed statewide Alaska Albers sheet spans ~56° and a CONUS Albers
 * one ~64° × 29°.
 */
export function plausibleLocation(model: GeoModel): boolean {
  const [x0, y0, x1, y1] = model.georef.frame;
  const [lon, lat] = model.pageToLonLat((x0 + x1) / 2, (y0 + y1) / 2);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  if (Math.abs(lat) < 1 || Math.abs(lat) > 85 || Math.abs(lon) > 180) return false;
  const ring = model.footprint();
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [x, y] of ring) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    w = Math.min(w, x);
    e = Math.max(e, x);
    s = Math.min(s, y);
    n = Math.max(n, y);
  }
  return e - w <= 90 && n - s <= 60;
}
