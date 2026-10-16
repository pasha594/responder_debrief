/**
 * Map projections for "My maps", hand-rolled (no proj4): a GeoPDF's
 * /GCS /WKT (ESRI WKT1) → a Crs, and lon/lat → CRS coordinates for the
 * projections incident maps are actually drawn in — Transverse Mercator
 * (UTM, State Plane TM, OCRS TM), Lambert Conformal Conic (1SP/2SP, State
 * Plane and Oregon Lambert), Albers (CONUS), Mercator (ellipsoidal, and the
 * spherical Web Mercator) and plain geographic. src/spread/utm.ts is the
 * UTM-only version of the same idea; this generalizes it to any ellipsoid,
 * origin, scale factor and linear unit.
 *
 * Why the real projection and not a fit through the 4 control points: GDAL
 * places a GeoPDF by projecting its GPTS into the WKT's CRS and fitting an
 * affine page→CRS (pdfdataset.cpp). Any shortcut in lon/lat or Web Mercator
 * is metres to kilometres off inside the frame (27 m on a 28 km sheet, up to
 * 3.6 km on a 300 km area map — reports/maplibre-accuracy.md), and the one
 * Albers sample has no control point on a frame corner at all.
 *
 * Datums: NAD 1927 is shifted to WGS84 with the 3-parameter geocentric
 * translation (≈5 m; NADCON would be exact but needs grids). Every other datum
 * (NAD83 and its realizations, WGS84) is treated as WGS84 — ≤1.3 m on the
 * sample corpus. A projection we don't implement falls back to a local
 * Transverse Mercator centred on the control points, flagged approximate.
 */

import type { LonLat } from './types';

export type CrsKind =
  | 'geographic'
  | 'tm'
  | 'lcc'
  | 'albers'
  | 'mercator'
  | 'webmercator'
  | 'local-tm';

export interface Crs {
  /** PROJCS/GEOGCS name from the WKT ('' when absent). */
  name: string;
  kind: CrsKind;
  /** The WKT's projection isn't implemented (or there is no WKT): local TM fit. */
  approximate: boolean;
  datum: 'wgs84' | 'nad27';
  /** Ellipsoid semi-major axis (m) and flattening (0 = sphere). */
  a: number;
  f: number;
  /** Meters per CRS linear unit (1 for 'geographic', whose unit is the degree). */
  unitM: number;
  /** Natural origin / central meridian, degrees. */
  lon0: number;
  lat0: number;
  /** Standard parallels, degrees (LCC, Albers; lat1 also Mercator 2SP). */
  lat1: number;
  lat2: number;
  /** Scale factor at the natural origin (TM, LCC 1SP, Mercator 1SP). */
  k0: number;
  /** False easting / northing, in the CRS linear unit. */
  fe: number;
  fn: number;
}

const DEG = Math.PI / 180;

// Ellipsoids the datum logic needs when a WKT omits its SPHEROID.
const WGS84_A = 6378137;
const WGS84_F = 1 / 298.257223563;
const CLARKE1866_A = 6378206.4;
const CLARKE1866_F = 1 / 294.978698214;

/** NAD27 → WGS84 geocentric translation, meters (NIMA TR8350.2 CONUS mean). */
const NAD27_SHIFT: [number, number, number] = [-8, 160, 176];

// ───────────────────────────── WKT1 parsing ─────────────────────────────

type WktValue = string | number | WktNode;
interface WktNode {
  key: string;
  args: WktValue[];
}

/**
 * Generic WKT1 reader: KEYWORD[arg, …] (or parentheses) where an arg is a
 * quoted string ("" escapes a quote), a number, a bare word (AXIS[…,EAST]) or
 * a nested node. Returns null on anything malformed.
 */
function parseWkt(src: string): WktNode | null {
  let i = 0;
  const n = src.length;
  const WORD = /[A-Za-z_][A-Za-z0-9_]*/y;
  const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
  const sticky = (re: RegExp): string | null => {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  const ws = () => {
    while (i < n && /\s/.test(src[i])) i++;
  };
  const word = () => sticky(WORD);
  const value = (): WktValue | null => {
    ws();
    const c = src[i];
    if (c === '"') {
      let s = '';
      i++;
      for (;;) {
        if (i >= n) return null;
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            s += '"';
            i += 2;
            continue;
          }
          i++;
          return s;
        }
        s += src[i++];
      }
    }
    const num = sticky(NUM);
    if (num !== null) return Number(num);
    const w = word();
    if (w === null) return null;
    ws();
    if (src[i] === '[' || src[i] === '(') return node(w);
    return w;
  };
  const node = (key: string): WktNode | null => {
    const close = src[i] === '[' ? ']' : ')';
    i++;
    const args: WktValue[] = [];
    ws();
    if (src[i] === close) {
      i++;
      return { key, args };
    }
    for (;;) {
      const v = value();
      if (v === null) return null;
      args.push(v);
      ws();
      if (src[i] === ',') {
        i++;
        continue;
      }
      if (src[i] === close) {
        i++;
        return { key, args };
      }
      return null;
    }
  };
  ws();
  const key = word();
  if (key === null) return null;
  ws();
  if (src[i] !== '[' && src[i] !== '(') return null;
  return node(key);
}

function child(nodeOrNull: WktNode | null | undefined, key: string): WktNode | null {
  if (!nodeOrNull) return null;
  const k = key.toUpperCase();
  for (const a of nodeOrNull.args) {
    if (typeof a === 'object' && a.key.toUpperCase() === k) return a;
  }
  return null;
}

function nameOf(nodeOrNull: WktNode | null): string {
  const v = nodeOrNull?.args[0];
  return typeof v === 'string' ? v : '';
}

function numArg(nodeOrNull: WktNode | null, idx: number): number | undefined {
  const v = nodeOrNull?.args[idx];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// ─────────────────────────────── Crs build ───────────────────────────────

/** ESRI + OGC WKT1 projection names (lower-cased) → our kinds. */
function kindOf(projection: string): CrsKind | null {
  const p = projection.toLowerCase().replace(/[\s-]+/g, '_');
  if (p.startsWith('transverse_mercator') || p === 'gauss_kruger') return 'tm';
  if (p.startsWith('lambert_conformal_conic')) return 'lcc';
  if (p === 'albers' || p === 'albers_conic_equal_area') return 'albers';
  if (p === 'mercator_auxiliary_sphere' || p === 'popular_visualisation_pseudo_mercator') {
    return 'webmercator';
  }
  if (p === 'mercator' || p === 'mercator_1sp' || p === 'mercator_2sp') return 'mercator';
  return null;
}

/** OGC WKT1 spells some parameters differently from ESRI — accept both. */
const PARAM_ALIASES: Record<string, string> = {
  longitude_of_center: 'central_meridian',
  longitude_of_origin: 'central_meridian',
  latitude_of_center: 'latitude_of_origin',
  scale_factor_at_natural_origin: 'scale_factor',
};

/**
 * Parse a GeoPDF /GCS /WKT. `center` is the control-point centroid (lon/lat),
 * used as the origin of the local Transverse Mercator fallback when the WKT is
 * missing, malformed or names a projection we don't implement.
 */
export function crsFromWkt(wkt: string | null, center: LonLat): Crs {
  const root = wkt ? parseWkt(wkt) : null;
  const rootKey = root?.key.toUpperCase();
  const projcs = rootKey === 'PROJCS' ? root : null;
  const geogcs = rootKey === 'GEOGCS' ? root : child(projcs, 'GEOGCS');

  const datumNode = child(geogcs, 'DATUM');
  const datumName = nameOf(datumNode);
  const nad27 = /north_american(_datum)?_1927|\bnad[_ ]?27\b/i.test(datumName);
  const datum: Crs['datum'] = nad27 ? 'nad27' : 'wgs84';
  const sph = child(datumNode, 'SPHEROID') ?? child(datumNode, 'ELLIPSOID');
  let a = numArg(sph, 1) ?? 0;
  let invF = numArg(sph, 2);
  if (!(a > 0) || invF === undefined || invF < 0) {
    a = nad27 ? CLARKE1866_A : WGS84_A;
    invF = 1 / (nad27 ? CLARKE1866_F : WGS84_F);
  }
  // ESRI writes a sphere as inverse flattening 0.
  const f = invF === 0 ? 0 : 1 / invF;

  const base: Crs = {
    name: nameOf(projcs ?? geogcs),
    kind: 'local-tm',
    approximate: true,
    datum,
    a,
    f,
    unitM: 1,
    lon0: center[0],
    lat0: center[1],
    lat1: 0,
    lat2: 0,
    k0: 1,
    fe: 0,
    fn: 0,
  };

  // PRIMEM is assumed Greenwich (always so in incident maps).
  if (!projcs) {
    // A bare GEOGCS is a real, fully supported CRS (lon/lat in degrees);
    // no usable WKT at all → local TM.
    return geogcs ? { ...base, kind: 'geographic', approximate: false, lon0: 0, lat0: 0 } : base;
  }

  const kind = kindOf(nameOf(child(projcs, 'PROJECTION')));
  if (!kind) return base;

  const params = new Map<string, number>();
  for (const arg of projcs.args) {
    if (typeof arg !== 'object' || arg.key.toUpperCase() !== 'PARAMETER') continue;
    const raw = nameOf(arg).toLowerCase();
    const v = numArg(arg, 1);
    if (v !== undefined) params.set(PARAM_ALIASES[raw] ?? raw, v);
  }
  const unitM = numArg(child(projcs, 'UNIT'), 1);
  const p = (k: string) => params.get(k);

  const crs: Crs = {
    ...base,
    kind,
    approximate: false,
    unitM: unitM && unitM > 0 ? unitM : 1,
    lon0: p('central_meridian') ?? 0,
    lat0: p('latitude_of_origin') ?? 0,
    k0: p('scale_factor') ?? 1,
    fe: p('false_easting') ?? 0,
    fn: p('false_northing') ?? 0,
  };

  if (kind === 'lcc') {
    const sp1 = p('standard_parallel_1');
    const sp2 = p('standard_parallel_2');
    const k = p('scale_factor');
    const lat0 = p('latitude_of_origin') ?? sp1 ?? 0;
    // ESRI writes LCC 1SP as Lambert_Conformal_Conic with SP1 = latitude of
    // origin plus a Scale_Factor (SP2 absent or equal); OGC names it _1SP.
    const oneSp =
      /_1sp$/i.test(nameOf(child(projcs, 'PROJECTION'))) ||
      sp1 === undefined ||
      sp2 === undefined ||
      (k !== undefined && k !== 1 && sp1 === lat0);
    crs.lat0 = lat0;
    crs.lat1 = oneSp ? lat0 : sp1;
    crs.lat2 = oneSp ? lat0 : sp2;
  } else if (kind === 'albers') {
    crs.lat1 = p('standard_parallel_1') ?? 0;
    crs.lat2 = p('standard_parallel_2') ?? crs.lat1;
  } else if (kind === 'mercator' || kind === 'webmercator') {
    crs.lat0 = 0; // Mercator northings are always from the equator.
    crs.lat1 = p('standard_parallel_1') ?? 0;
    // ArcGIS's "WGS_1984_Web_Mercator" is plain Mercator on a sphere
    // (1/f written as 0, datum D_WGS_1984_Major_AuxSphere): Web Mercator.
    if (kind === 'mercator' && (f === 0 || /auxsphere/i.test(datumName))) crs.kind = 'webmercator';
  }
  return crs;
}

// ─────────────────────────────── forward ───────────────────────────────

type Projector = (lon: number, lat: number) => [number, number];

const projectors = new WeakMap<Crs, Projector>();

/** lon − lon0 wrapped to [−180, 180), radians. */
function dLambda(lon: number, lon0: number): number {
  let d = lon - lon0;
  if (d < -180 || d >= 180) d = ((((d + 180) % 360) + 360) % 360) - 180;
  return d * DEG;
}

/**
 * Transverse Mercator, ellipsoidal, via the Krüger n-series to 6th order —
 * Karney (2011) "Transverse Mercator with an accuracy of a few nanometers",
 * J. Geodesy 85:475, eqs. (7)–(11), (14) and the α coefficients of eq. (35).
 * Same series as utm.ts (which stops at 4th order); nanometre-level within a
 * few degrees of the central meridian. Latitude of origin: northing is
 * measured from the series value of the central meridian at lat0.
 */
function tmProjector(crs: Crs): Projector {
  const { f } = crs;
  const n = f / (2 - f);
  const n2 = n * n;
  const n3 = n2 * n;
  const n4 = n3 * n;
  const n5 = n4 * n;
  const n6 = n5 * n;
  const e = Math.sqrt(f * (2 - f));
  // Rectifying radius A (eq. 14).
  const A = (crs.a / (1 + n)) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
  const alpha = [
    n / 2 - (2 * n2) / 3 + (5 * n3) / 16 + (41 * n4) / 180 - (127 * n5) / 288 + (7891 * n6) / 37800,
    (13 * n2) / 48 - (3 * n3) / 5 + (557 * n4) / 1440 + (281 * n5) / 630 - (1983433 * n6) / 1935360,
    (61 * n3) / 240 - (103 * n4) / 140 + (15061 * n5) / 26880 + (167603 * n6) / 181440,
    (49561 * n4) / 161280 - (179 * n5) / 168 + (6601661 * n6) / 7257600,
    (34729 * n5) / 80640 - (3418889 * n6) / 1995840,
    (212378941 * n6) / 319334400,
  ];

  // Gauss–Schreiber (ξ', η') → Krüger (ξ, η), eq. (11).
  const kruger = (phi: number, lam: number): [number, number] => {
    let xiP: number;
    let etaP: number;
    if (Math.abs(phi) >= Math.PI / 2 - 1e-12) {
      xiP = Math.sign(phi) * (Math.PI / 2);
      etaP = 0;
    } else {
      const s = Math.sin(phi);
      // tan of the conformal latitude, eq. (7)–(9).
      const t = Math.sinh(Math.atanh(s) - e * Math.atanh(e * s));
      xiP = Math.atan2(t, Math.cos(lam));
      etaP = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
    }
    let xi = xiP;
    let eta = etaP;
    for (let j = 1; j <= 6; j++) {
      const aj = alpha[j - 1];
      xi += aj * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
      eta += aj * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
    }
    return [xi, eta];
  };

  const xi0 = kruger(crs.lat0 * DEG, 0)[0];
  const kA = crs.k0 * A;
  return (lon, lat) => {
    const [xi, eta] = kruger(lat * DEG, dLambda(lon, crs.lon0));
    return [kA * eta, kA * (xi - xi0)];
  };
}

/** Snyder (1987) eq. 14-15: m = cos φ / √(1 − e² sin² φ). */
function snyderM(phi: number, e2: number): number {
  const s = Math.sin(phi);
  return Math.cos(phi) / Math.sqrt(1 - e2 * s * s);
}

/**
 * Lambert Conformal Conic, ellipsoidal — Snyder (1987) "Map Projections: A
 * Working Manual", USGS PP 1395, pp. 107–108, eqs. 15-7 … 15-11, 14-15, 14-1,
 * 14-2. 1SP is the same cone with lat1 = lat2 = lat0 (n = sin lat0) and the
 * scale factor k0 applied to ρ (EPSG 9801 / PROJ +k_0).
 */
function lccProjector(crs: Crs): Projector {
  const { a, f } = crs;
  const e2 = f * (2 - f);
  const e = Math.sqrt(e2);
  // eq. 15-9
  const tOf = (phi: number) => {
    const s = Math.sin(phi);
    return Math.tan(Math.PI / 4 - phi / 2) / Math.pow((1 - e * s) / (1 + e * s), e / 2);
  };
  const phi1 = crs.lat1 * DEG;
  const phi2 = crs.lat2 * DEG;
  const m1 = snyderM(phi1, e2);
  const t1 = tOf(phi1);
  const n =
    Math.abs(phi1 - phi2) < 1e-12
      ? Math.sin(phi1)
      : (Math.log(m1) - Math.log(snyderM(phi2, e2))) / (Math.log(t1) - Math.log(tOf(phi2))); // 15-8
  const F = m1 / (n * Math.pow(t1, n)); // 15-10
  const aFk = a * F * crs.k0;
  const rho = (phi: number) => aFk * Math.pow(tOf(phi), n); // 15-7
  const rho0 = rho(crs.lat0 * DEG);
  return (lon, lat) => {
    const r = rho(lat * DEG);
    const theta = n * dLambda(lon, crs.lon0); // 14-4
    return [r * Math.sin(theta), rho0 - r * Math.cos(theta)]; // 14-1, 14-2
  };
}

/**
 * Albers Equal-Area Conic, ellipsoidal — Snyder (1987) pp. 101–102, eqs.
 * 3-12 (q), 14-12 … 14-15, 14-1, 14-2. lat1 = lat2 degenerates to n = sin lat1.
 */
function albersProjector(crs: Crs): Projector {
  const { a, f } = crs;
  const e2 = f * (2 - f);
  const e = Math.sqrt(e2);
  // eq. 3-12
  const q = (phi: number) => {
    const s = Math.sin(phi);
    if (e < 1e-12) return 2 * s;
    return (1 - e2) * (s / (1 - e2 * s * s) - (1 / (2 * e)) * Math.log((1 - e * s) / (1 + e * s)));
  };
  const phi1 = crs.lat1 * DEG;
  const phi2 = crs.lat2 * DEG;
  const m1 = snyderM(phi1, e2);
  const m2 = snyderM(phi2, e2);
  const q1 = q(phi1);
  const n = Math.abs(phi1 - phi2) < 1e-12 ? Math.sin(phi1) : (m1 * m1 - m2 * m2) / (q(phi2) - q1); // 14-14
  const C = m1 * m1 + n * q1; // 14-13
  const rho = (phi: number) => (a * Math.sqrt(Math.max(0, C - n * q(phi)))) / n; // 14-12
  const rho0 = rho(crs.lat0 * DEG);
  return (lon, lat) => {
    const r = rho(lat * DEG);
    const theta = n * dLambda(lon, crs.lon0);
    return [r * Math.sin(theta), rho0 - r * Math.cos(theta)];
  };
}

/**
 * Mercator — Snyder (1987) eqs. 7-6, 7-7 (ellipsoid) written as
 * y = a·k0·(atanh(sin φ) − e·atanh(e·sin φ)). 2SP: k0 = m(lat1) (eq. 14-15),
 * times any written scale factor. Web Mercator: the same on a sphere of radius
 * a (e = 0), whatever the WKT's flattening.
 */
function mercatorProjector(crs: Crs, spherical: boolean): Projector {
  const e2 = spherical ? 0 : crs.f * (2 - crs.f);
  const e = Math.sqrt(e2);
  const ak = crs.a * crs.k0 * snyderM(crs.lat1 * DEG, e2);
  return (lon, lat) => {
    const s = Math.sin(lat * DEG);
    return [ak * dLambda(lon, crs.lon0), ak * (Math.atanh(s) - e * Math.atanh(e * s))];
  };
}

function projector(crs: Crs): Projector {
  let p = projectors.get(crs);
  if (p) return p;
  let raw: Projector;
  switch (crs.kind) {
    case 'geographic':
      raw = (lon, lat) => [lon, lat];
      break;
    case 'tm':
    case 'local-tm':
      raw = tmProjector(crs);
      break;
    case 'lcc':
      raw = lccProjector(crs);
      break;
    case 'albers':
      raw = albersProjector(crs);
      break;
    case 'mercator':
      raw = mercatorProjector(crs, false);
      break;
    case 'webmercator':
      raw = mercatorProjector(crs, true);
      break;
  }
  if (crs.kind === 'geographic') {
    p = raw;
  } else {
    const { unitM, fe, fn } = crs;
    p = (lon, lat) => {
      const [x, y] = raw(lon, lat);
      return [fe + x / unitM, fn + y / unitM];
    };
  }
  projectors.set(crs, p);
  return p;
}

/**
 * lon/lat (degrees, IN THE CRS'S OWN DATUM — see wgs84ToCrsDatum) → CRS
 * coordinates in the CRS linear unit, false easting/northing included.
 * 'geographic' returns [lon, lat] unchanged.
 */
export function forward(crs: Crs, lon: number, lat: number): [number, number] {
  return projector(crs)(lon, lat);
}

// ─────────────────────────────── datums ───────────────────────────────

function geodeticToEcef(lon: number, lat: number, a: number, f: number): [number, number, number] {
  const e2 = f * (2 - f);
  const phi = lat * DEG;
  const lam = lon * DEG;
  const s = Math.sin(phi);
  const c = Math.cos(phi);
  const N = a / Math.sqrt(1 - e2 * s * s);
  return [N * c * Math.cos(lam), N * c * Math.sin(lam), N * (1 - e2) * s];
}

/** ECEF → geodetic lon/lat (height dropped), fixed-point iteration on φ. */
function ecefToGeodetic(x: number, y: number, z: number, a: number, f: number): LonLat {
  const e2 = f * (2 - f);
  const p = Math.hypot(x, y);
  let phi = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 10; i++) {
    const s = Math.sin(phi);
    const N = a / Math.sqrt(1 - e2 * s * s);
    const h = p / Math.cos(phi) - N;
    const next = Math.atan2(z, p * (1 - (e2 * N) / (N + h)));
    const done = Math.abs(next - phi) < 1e-14;
    phi = next;
    if (done) break;
  }
  return [Math.atan2(y, x) / DEG, phi / DEG];
}

function shiftDatum(
  lon: number,
  lat: number,
  from: [number, number],
  to: [number, number],
  sign: 1 | -1,
): LonLat {
  const [x, y, z] = geodeticToEcef(lon, lat, from[0], from[1]);
  return ecefToGeodetic(
    x + sign * NAD27_SHIFT[0],
    y + sign * NAD27_SHIFT[1],
    z + sign * NAD27_SHIFT[2],
    to[0],
    to[1],
  );
}

/** CRS-datum lon/lat → WGS84 (identity unless NAD27). */
export function crsDatumToWgs84(crs: Crs, lon: number, lat: number): LonLat {
  if (crs.datum !== 'nad27') return [lon, lat];
  return shiftDatum(lon, lat, [crs.a, crs.f], [WGS84_A, WGS84_F], 1);
}

/**
 * WGS84 lon/lat → the CRS's datum (identity unless NAD27). The negated shift
 * starts from height 0 on the wrong ellipsoid; one correction step through
 * crsDatumToWgs84 makes this its exact inverse (≪1 mm).
 */
export function wgs84ToCrsDatum(crs: Crs, lon: number, lat: number): LonLat {
  if (crs.datum !== 'nad27') return [lon, lat];
  const [lon1, lat1] = shiftDatum(lon, lat, [WGS84_A, WGS84_F], [crs.a, crs.f], -1);
  const [blon, blat] = crsDatumToWgs84(crs, lon1, lat1);
  return [lon1 - (blon - lon), lat1 - (blat - lat)];
}
