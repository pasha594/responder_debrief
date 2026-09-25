/**
 * Is a pin off the road network? The road engines (TomTom, OSRM) snap each
 * pin to the nearest road, so their route starts and ends on the road, not
 * at the pin. A big gap there means the road doesn't reach the pin.
 */
import { distanceMiles } from './geo';
import type { RouteResult } from './routing';

/** How far a road route may start or end from its pin. */
export const ROAD_GAP_M = 250;

/** True when a road route starts more than ROAD_GAP_M from A or ends more
 * than that from B. */
export function roadMissesPins(
  route: RouteResult,
  a: [number, number],
  b: [number, number],
): boolean {
  const line = route.geometry.coordinates;
  if (!line.length) return true;
  const gapM = (p: [number, number], q: [number, number]) => distanceMiles(p, q) * 1609.344;
  return gapM(line[0], a) > ROAD_GAP_M || gapM(line[line.length - 1], b) > ROAD_GAP_M;
}
