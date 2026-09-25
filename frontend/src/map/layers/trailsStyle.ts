/**
 * Trails overlay styling and popup text (pure — no map, no DOM).
 *
 * Pink, in a casing + core pair tuned per ground (owner call: teal sank
 * into the Vegetation layer's greens). Pink is the one hue nothing else on
 * the map uses: Vegetation's greens/browns/yellows/greys/blues, USGS Topo's
 * greens, brown contours, blue water and red/black roads, perimeter red, the
 * route's blue and the draw palette. Nearest neighbour is the purple of
 * older hotspots (CIEDE2000 ~17-20), which are dots, not lines. Deep pink
 * on light grounds, bright pink on dark ones. BLM "not assessed" segments
 * draw lighter and thinner.
 */
import type { ExpressionSpecification } from 'maplibre-gl';

export type Ground = 'topo' | 'satellite' | 'map-dark' | 'map-light' | 'offline';

export interface TrailPaint {
  casing: string;
  casingOpacity: number;
  core: string;
  halo: string;
  ways: string;
}

export const TRAIL_PAINT: Record<Ground, TrailPaint> = {
  topo: { casing: '#ffffff', casingOpacity: 0.85, core: '#d6247f', halo: '#ffffff', ways: '#6f6a6b' },
  satellite: { casing: '#1a0710', casingOpacity: 0.65, core: '#ff79c6', halo: '#1a0710', ways: '#d8d2d5' },
  'map-dark': { casing: '#0d0a0c', casingOpacity: 0.8, core: '#ff79c6', halo: '#0d0a0c', ways: '#8a8586' },
  'map-light': { casing: '#ffffff', casingOpacity: 0.9, core: '#d6247f', halo: '#ffffff', ways: '#8a8586' },
  offline: { casing: '#0d0a0c', casingOpacity: 0.8, core: '#ff79c6', halo: '#0d0a0c', ways: '#8a8586' },
};

/** Which ground the trails sit on. `offlineStyle` = the style has no
 * non-rd sources (MapRoot's blank offline background). */
export function groundKey(
  basemap: 'map' | 'satellite' | 'topo',
  theme: 'dark' | 'light',
  offlineStyle: boolean,
): Ground {
  if (offlineStyle) return 'offline';
  if (basemap === 'topo') return 'topo';
  if (basemap === 'satellite') return 'satellite';
  return theme === 'dark' ? 'map-dark' : 'map-light';
}

/** 'auto' shows trails only on the offline ground — there they (and the
 * pack's OSM ways) are the only ground reference; on Topo they'd double
 * USGS's own trails. */
export function trailsVisible(mode: 'auto' | 'on' | 'off', ground: Ground): boolean {
  return mode === 'on' || (mode === 'auto' && ground === 'offline');
}

export const CORE_WIDTH: ExpressionSpecification = [
  'interpolate', ['linear'], ['zoom'], 9, 1.0, 12, 1.8, 15, 3.0,
];
export const CASING_WIDTH: ExpressionSpecification = [
  'interpolate', ['linear'], ['zoom'], 9, 3.0, 12, 3.8, 15, 5.0,
];
export const NOT_ASSESSED: ExpressionSpecification = ['==', ['get', 'status'], 'not_assessed'];

// ---------- popup ----------

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const USE_LABELS: Record<string, string> = {
  H: 'hiker', P: 'pack & saddle', B: 'bicycle', M: 'motorcycle', A: 'ATV/UTV', '4': '4WD > 50"',
};
const CLASS_LABELS: Record<number, string> = {
  1: 'Class 1 (minimally developed)', 2: 'Class 2 (moderately developed)',
  3: 'Class 3 (developed)', 4: 'Class 4 (highly developed)', 5: 'Class 5 (fully developed)',
};
const AGENCY_SOURCE: Record<string, string> = {
  USFS: 'USFS National Forest System Trails',
  BLM: 'BLM Ground Transportation Linear Features',
  NPS: 'NPS Public Trails',
};

export function usesText(uses: unknown): string {
  const codes = String(uses ?? '').split(',').filter(Boolean);
  if (!codes.length) return 'Allowed uses not published';
  return `Allowed: ${codes.map((c) => USE_LABELS[c] ?? c).join(', ')}`;
}

export function trailTitle(p: Record<string, unknown>): string {
  const name = p.name ? String(p.name) : '';
  const num = p.num ? String(p.num) : '';
  if (name && num) return `${name} #${num}`;
  if (name) return name;
  if (num) return `Trail #${num}`;
  return 'Unnamed trail';
}

const SEP = ' <span style="opacity:.55">•</span> ';

/** Popup HTML for one trail feature; every value is escaped. */
export function trailPopupHtml(p: Record<string, unknown>): string {
  const cls = Number(p.cls);
  const meta = [
    esc(p.agency),
    CLASS_LABELS[cls] ? esc(CLASS_LABELS[cls]) : '',
    p.status === 'not_assessed' ? 'Not assessed' : '',
    p.status === 'unofficial' ? 'Unofficial trail' : '',
    p.mgmt ? esc(p.mgmt) : '',
    p.unit ? esc(p.unit) : '',
  ].filter(Boolean);
  const lines = [
    `<strong>${esc(trailTitle(p))}</strong>`,
    meta.join(SEP),
    esc(usesText(p.uses)),
  ];
  if (p.restr || p.status === 'closed') {
    lines.push(
      `<span style="color:#e0a24a">Restricted: ${esc(p.restr || 'Temporarily closed')}</span>`,
      '<span style="opacity:.7">Walk routes still use it (crew / administrative use).</span>',
    );
  }
  if (p.season) lines.push(`Season: ${esc(p.season)}`);
  const src = AGENCY_SOURCE[String(p.agency)] ?? 'Agency trail data';
  lines.push(`<span style="opacity:.7">Source: ${esc(src)}${p.src_date ? `, ${esc(p.src_date)}` : ''}</span>`);
  lines.push('<button type="button" class="rd-trail-walk" data-walk-here="1">Walk here</button>');
  return lines.filter(Boolean).join('<br>');
}
