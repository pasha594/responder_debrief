/**
 * Index tables of the QR share format, version 1 — FROZEN. A code stores a
 * symbol, style or product as its position in these lists, and phones on
 * the fireline can run app versions days apart while offline, so an index
 * must mean the same thing forever:
 *   - never reorder or remove an entry;
 *   - never append either: a symbol added to the palette later travels as
 *     its string id (the codec's escape), which every version can carry.
 * Changing a list means a new format version. Lists added later ride new
 * flag bits (see shareCodec), so an app that predates them reports the code
 * as "from a newer version" instead of misreading it.
 */
import type { RouteEngine, RouteProfile } from '../api/routing';
import type { Percentile, SpreadProduct, WeatherProduct } from '../api/types';

/** NWCG PMS 936 point symbols, palette order as of format v1. */
export const WIRE_POINTS: readonly string[] = [
  'division-break', 'branch-break', 'zone-break', 'safety-zone', 'hazard',
  'hazard-tree', 'aerial-hazard', 'airstrip-or-airport', 'aviation-check-point',
  'mobile-retardant-base', 'helispot', 'helibase', 'sling-site',
  'unimproved-landing-area', 'uas-launch-and-recovery', 'lookout',
  'hot-spot-spot-fire', 'fire-origin', 'medical', 'incident-command-post',
  'drop-point', 'closure', 'camp', 'staging-area', 'dip-site', 'draft-site',
  'hydrant', 'restricted-water-source', 'mobile-weather-unit', 'internet-access',
  'repeater', 'value-at-risk', 'other', 'landmark', 'gate', 'fire-station',
  'bridge', 'structure-wrap', 'stream-crossing', 'road-repair',
  'retardant-in-avoidance-area', 'resource-location', 'repair-point',
  'landing-or-log-deck', 'slash-pile', 'fence-cut-damaged', 'invasive-plant',
  'dozer-push', 'culvert', 'clean-up-area',
];

/** Line styles: the two app extras, then NWCG's, palette order as of v1. */
export const WIRE_LINES: readonly string[] = [
  'sketch', 'perimeter', 'hoselay', 'completed-burnout', 'completed-dozer-line',
  'completed-fuel-break', 'completed-hand-line', 'completed-mixed-construction-line',
  'completed-plow-line', 'completed-road-as-line', 'planned-burnout',
  'planned-dozer-line', 'planned-fuel-break', 'planned-hand-line',
  'planned-mixed-construction-line', 'planned-plow-line', 'planned-road-as-line',
  'proposed-line', 'break-line', 'fence', 'highlighted-feature',
  'management-action-point', 'other', 'repair-line', 'road-repair', 'escape-route',
  'access-route', 'aerial-hazard', 'aviation-route', 'retardant-drop',
  'temporary-flight-restriction', 'fire-edge-field-collection',
  'contained-fire-edge', 'uncontained',
];

/** Weather layers, bit i of the visible mask. */
export const WIRE_WEATHER: readonly WeatherProduct[] = [
  'tmpf', 'rh', 'ws', 'wg', 'wd', 'ffwi', 'smoke', 'tcdc', 'pign', 'meq',
  'apcp01', 'apcptot',
];

export const WIRE_SPREAD: readonly SpreadProduct[] = [
  'spread-rate', 'flame-length', 'crown-fire', 'hours-since-burned',
  'time-of-arrival', 'isochrones',
];

export const WIRE_PERCENTILES: readonly Percentile[] = [10, 30, 50, 70, 90];

export const WIRE_BASEMAPS = ['map', 'satellite', 'topo'] as const;

// ---- added with directions, pins and the trails/vegetation/land layers ----

/** Directions travel modes (store `directions.profile`; 'hike' is Walk). */
export const WIRE_PROFILES: readonly RouteProfile[] = ['drive', 'hike', 'apparatus'];

/** Routing engines (RouteResult.engine). */
export const WIRE_ENGINES: readonly RouteEngine[] = ['tomtom', 'osrm', 'ors', 'valhalla', 'offroad'];

/** Trails layer modes (store `layers.trails.mode`). */
export const WIRE_TRAILS = ['auto', 'on', 'off'] as const;
