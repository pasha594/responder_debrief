/**
 * Land status around the current fire, from NIFC's Jurisdictional Units —
 * the interagency layer fire jurisdiction is assigned from (PAD-US plus
 * agency land records, keyed by NWCG unit IDs like WA-OWF). Queried directly
 * from the browser (public ArcGIS Online, CORS *): an envelope around the
 * fire, server-simplified geometry, only the fields the pin card needs.
 * Fetched lazily — only once the layer is on — like the historic perimeters.
 *
 * Public land only. The dataset counts everything else as private (census
 * block groups, two thirds of the features and payload), and private land
 * stays unshaded on the map anyway.
 *
 * Not NIFC's vector-tile service: it is an indexed cache whose data stops at
 * zoom 8–12 depending on the area, and deeper tiles come back as the parent
 * re-scaled — which MapLibre clamps two tile widths out, bending long
 * straight boundaries.
 */

const SERVICE =
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/' +
  'DMP_JurisdictionalUnits_Public/FeatureServer/0/query';

const PAGE_SIZE = 2000; // the service's maxRecordCount
/** LA-basin boxes run ~6,500 public units; wildland fires a few hundred. */
const MAX_FEATURES = 10000;
/** ~10 m simplification: close enough to answer "whose land is the pin on". */
const SIMPLIFY_DEG = 0.0001;

export interface LandStatusProps {
  JurisdictionalUnitName: string | null;
  /** NIFC's agency class: USFS, NPS, BLM, State, BIA, Tribal, City, … */
  JurisdictionalCategory: string | null;
  /** NWCG unit ID without the country prefix, e.g. WAOWF. */
  JurisdictionalUnitID_sansUS: string | null;
}

export interface LandStatusFC {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    geometry: { type: string; coordinates: unknown } | null;
    properties: LandStatusProps;
  }[];
}

export interface LandClass {
  codes: string[];
  label: string;
  /** NIFC's own land-status fill (the service's renderer). */
  fill: string;
  /** A saturated shade of it: the pastels vanish on the topo basemap, so the
   * boundary line carries the edge. */
  line: string;
}

/** NIFC's land-status symbology, grouped the way its legend groups the
 * codes. Order is legend order. */
export const LAND_CLASSES: LandClass[] = [
  { codes: ['USFS'], label: 'USFS', fill: '#cdebc5', line: '#4c9a3c' },
  { codes: ['NPS'], label: 'NPS', fill: '#c9bddb', line: '#7d5fb0' },
  { codes: ['BLM'], label: 'BLM', fill: '#fce479', line: '#c7a200' },
  { codes: ['USFWS'], label: 'FWS', fill: '#81cca8', line: '#2f8c63' },
  { codes: ['BIA', 'Tribal'], label: 'Tribal', fill: '#fcb26d', line: '#d7782c' },
  { codes: ['State'], label: 'State', fill: '#b4e3ed', line: '#3a9ab8' },
  { codes: ['DOD'], label: 'DOD', fill: '#fab4ce', line: '#d4588a' },
  { codes: ['BOR'], label: 'BOR', fill: '#ffffb5', line: '#b3aa2a' },
  { codes: ['DOE', 'OthFed'], label: 'Other federal', fill: '#e3c39f', line: '#a57a4b' },
  { codes: ['City', 'County', 'OthLocal'], label: 'Local', fill: '#8fb4bd', line: '#4d8290' },
  { codes: ['ANC'], label: 'ANC', fill: '#ebebeb', line: '#9a9a9a' },
];

/** Codes NIFC adds later read as "other federal". */
export const FALLBACK_CLASS = LAND_CLASSES.find((c) => c.codes.includes('OthFed'))!;

export function landClass(category: string | null): LandClass {
  return LAND_CLASSES.find((c) => category && c.codes.includes(category)) ?? FALLBACK_CLASS;
}

/** A legend / pin-card chip drawn like the map: fill inside its line. */
export function landChipStyle(c: LandClass): { background: string; boxShadow: string } {
  return { background: c.fill, boxShadow: `inset 0 0 0 1.5px ${c.line}` };
}

/** The agency as the pin card prints it. */
const CATEGORY_LABEL: Record<string, string> = {
  USFWS: 'FWS',
  OthFed: 'Federal',
  OthLocal: 'Local',
  ANC: 'Alaska Native corporation',
};

export function landQueryUrl(bbox: [number, number, number, number], offset: number): string {
  const [w, s, e, n] = bbox;
  const params = new URLSearchParams({
    where: 'JurisdictionalCategory IS NOT NULL',
    geometry: `${w},${s},${e},${n}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'JurisdictionalUnitName,JurisdictionalCategory,JurisdictionalUnitID_sansUS',
    outSR: '4326',
    maxAllowableOffset: String(SIMPLIFY_DEG),
    geometryPrecision: '5',
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
    orderByFields: 'OBJECTID',
    f: 'geojson',
  });
  return `${SERVICE}?${params}`;
}

export async function fetchLandStatus(
  bbox: [number, number, number, number],
): Promise<LandStatusFC> {
  const features: LandStatusFC['features'] = [];
  for (let offset = 0; offset < MAX_FEATURES; offset += PAGE_SIZE) {
    const res = await fetch(landQueryUrl(bbox, offset));
    if (!res.ok) throw new Error(`nifc land status ${res.status}`);
    const fc = (await res.json()) as LandStatusFC & { error?: { message?: string } };
    // ArcGIS reports query errors as 200s with an error body
    if (fc.error) throw new Error(`nifc land status: ${fc.error.message ?? 'query failed'}`);
    const page = fc.features ?? [];
    features.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return { type: 'FeatureCollection', features };
}

/** WAOWF → WA-OWF, the way unit IDs are written on the line. */
export function formatUnitId(id: string | null | undefined): string | null {
  if (!id) return null;
  return id.length > 2 ? `${id.slice(0, 2)}-${id.slice(2)}` : id;
}

export interface LandUnit {
  name: string | null;
  /** NIFC's category code, for its LAND_CLASSES colors. */
  category: string | null;
  /** Agency as printed: USFS, NPS, BLM, State, … */
  agency: string | null;
  /** WA-OWF */
  unitId: string | null;
}

/** Even-odd ray cast over every ring, so holes (inholdings) fall out. */
function inRings(rings: number[][][], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function contains(geometry: LandStatusFC['features'][number]['geometry'], x: number, y: number) {
  if (geometry?.type === 'Polygon') return inRings(geometry.coordinates as number[][][], x, y);
  if (geometry?.type === 'MultiPolygon') {
    return (geometry.coordinates as number[][][][]).some((poly) => inRings(poly, x, y));
  }
  return false;
}

/**
 * Whose land [lon, lat] is on: the public unit it falls in, 'private' when
 * it is inside the fetched box but on no public unit, null outside the box
 * (nothing was fetched there, so there is nothing to say).
 */
export function landUnitAt(
  fc: LandStatusFC,
  bbox: [number, number, number, number],
  at: [number, number],
): LandUnit | 'private' | null {
  const [x, y] = at;
  const [w, s, e, n] = bbox;
  if (x < w || x > e || y < s || y > n) return null;
  const hit = fc.features.find((f) => contains(f.geometry, x, y));
  if (!hit) return 'private';
  const p = hit.properties;
  const cat = p.JurisdictionalCategory;
  return {
    name: p.JurisdictionalUnitName,
    category: cat,
    agency: cat ? CATEGORY_LABEL[cat] ?? cat : null,
    unitId: formatUnitId(p.JurisdictionalUnitID_sansUS),
  };
}
