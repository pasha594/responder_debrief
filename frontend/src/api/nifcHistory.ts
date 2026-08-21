/**
 * Historic fire perimeters around the current fire, from NIFC Open Data's
 * InterAgency Fire Perimeter History service (final perimeters, ~98k fires).
 * Queried directly from the browser (public ArcGIS Online, CORS *): an
 * envelope around the fire, last 10 years, server-simplified geometry, only
 * the fields the popup needs. Fetched lazily — the query only runs when the
 * layer is switched on — and cached forever (history doesn't change).
 */
import type { HotspotFeatureCollection } from './types';

const SERVICE =
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/' +
  'InterAgencyFirePerimeterHistory_All_Years_View/FeatureServer/0/query';

export const HISTORY_YEARS = 10;
const PAGE_SIZE = 1000;
const MAX_FEATURES = 2000;
/** ~30 m simplification — plenty for context outlines, ~10x smaller payloads. */
const SIMPLIFY_DEG = 0.0003;

export interface HistoricPerimeterFC {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    geometry: { type: string; coordinates: unknown };
    properties: {
      INCIDENT: string | null;
      FIRE_YEAR_INT: number | null;
      DATE_CUR: number | null;
      GIS_ACRES: number | null;
      IRWINID: string | null;
    };
  }[];
}

export function historyQueryUrl(
  bbox: [number, number, number, number],
  offset: number,
  nowYear: number,
): string {
  const [w, s, e, n] = bbox;
  const params = new URLSearchParams({
    where: `FIRE_YEAR_INT >= ${nowYear - HISTORY_YEARS}`,
    geometry: `${w},${s},${e},${n}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'INCIDENT,FIRE_YEAR_INT,DATE_CUR,GIS_ACRES,IRWINID',
    outSR: '4326',
    maxAllowableOffset: String(SIMPLIFY_DEG),
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
    orderByFields: 'FIRE_YEAR_INT DESC',
    f: 'geojson',
  });
  return `${SERVICE}?${params}`;
}

/** Strip braces/case so the dataset's IRWINID matches our cornea_id. */
function normGuid(id: string | null | undefined): string {
  return (id ?? '').replace(/[{}]/g, '').toLowerCase();
}

export async function fetchHistoricPerimeters(
  bbox: [number, number, number, number],
  excludeCorneaId: string | null,
): Promise<HistoricPerimeterFC> {
  const nowYear = new Date().getUTCFullYear();
  const self = normGuid(excludeCorneaId);
  const features: HistoricPerimeterFC['features'] = [];
  for (let offset = 0; offset < MAX_FEATURES; offset += PAGE_SIZE) {
    const res = await fetch(historyQueryUrl(bbox, offset, nowYear));
    if (!res.ok) throw new Error(`nifc history ${res.status}`);
    const fc = (await res.json()) as HistoricPerimeterFC & {
      properties?: { exceededTransferLimit?: boolean };
    };
    const page = fc.features ?? [];
    for (const f of page) {
      // the current fire's own (preliminary) entry is not "history"
      if (self && normGuid(f.properties?.IRWINID) === self) continue;
      features.push(f);
    }
    if (page.length < PAGE_SIZE) break;
  }
  return { type: 'FeatureCollection', features };
}

export type { HotspotFeatureCollection };
