/**
 * Walk: the offline off-road router inside a fire's routing area, the
 * online foot engines elsewhere (docs/trails-routing/FINAL_PLAN.md).
 *
 *  1. The fire has a bundle and BOTH A and B are inside its grid → the
 *     on-device router, online or not. It knows the fire; the online
 *     engines don't, so a "no path" or "blocked by the perimeter" here
 *     never falls back to them.
 *  2. Otherwise, offline → an explicit error (not the generic "no route").
 *  3. Otherwise → ORS / Valhalla, with ONLINE_NO_PERIM always, CROSSES_PERIM
 *     when the line enters the latest perimeter, and any end the engine
 *     couldn't reach (they snap up to tens of km) drawn as a dotted,
 *     untimed straight 'gap' leg — or, when that gap lies inside the fire's
 *     routing area, modeled cross-country by the on-device router.
 */
import { routeHikeOnline, type RouteLeg, type RouteNote, type RouteResult } from './routing';
import type { PerimeterFeature } from './types';
import { insideRoutingArea } from '../routing/bundleIndex';
import { loadPackedBundle } from '../routing/hooks';
import { ensureBundle, routeOffroad, setPerimeter } from '../routing/offroadClient';
import { ageHours, crossesPerimeter, metresBetween, polygonsOf } from '../routing/safety';
import type { RoutingBundle } from '../routing/types';

type LonLat = [number, number];

export interface WalkPerimeter {
  feature: PerimeterFeature;
  path: string;
  date: string;
}

export interface WalkContext {
  corneaId: string | null;
  online: boolean;
  avoidPerimeter: boolean;
  bundle: RoutingBundle | null;
  /** Whether this fire has a pack on this device (for the error copy). */
  packed: boolean;
  getPerimeter(): Promise<WalkPerimeter | null>;
  onStatus?(text: string | null): void;
  nowMs: number;
}

export type WalkErrorCode =
  | 'offline-no-bundle' | 'offline-not-packed' | 'outside-area-offline' | 'no-path' | 'budget'
  | 'blocked' | 'load-failed' | 'online-failed' | 'superseded';

export class WalkError extends Error {
  constructor(readonly code: WalkErrorCode, message: string, readonly alternative?: RouteResult) {
    super(message);
  }
}

const GAP_M = 25;
const PERIM_OLD_H = 12;

export const WALK_ERROR_TEXT: Record<WalkErrorCode, string> = {
  'offline-no-bundle': "Offline walking routes aren't available for this fire yet.",
  'offline-not-packed': 'Download this fire (Overview tab) to route on foot without service.',
  'outside-area-offline': "Offline, Walk routes only inside this fire's routing area (dashed box).",
  'no-path': 'No walkable route inside the routing area — cliffs, open water, or the fire perimeter block every path.',
  budget: 'Route search took too long on this device. Try closer points.',
  blocked: 'The fire perimeter blocks every walkable route between these points.',
  'load-failed': "Couldn't load the terrain model on this device.",
  'online-failed': 'No route found — try different points.',
  superseded: '',
};

function perimeterNotes(p: WalkPerimeter | null, ctx: WalkContext, avoided: boolean): RouteNote[] {
  const out: RouteNote[] = [];
  if (!p) {
    if (ctx.avoidPerimeter) {
      out.push({ level: 'warn', code: 'NO_PERIMETER', text: 'Fire perimeter unavailable — route does not avoid the fire.' });
    }
    return out;
  }
  const age = ageHours(p.date, ctx.nowMs);
  if (avoided && age != null && age > PERIM_OLD_H) {
    out.push({ level: 'warn', code: 'PERIM_OLD', text: `Fire perimeter is ${Math.round(age)} h old — the fire may have moved.` });
  }
  return out;
}

async function offroad(a: LonLat, b: LonLat, bundleIn: RoutingBundle, ctx: WalkContext,
  perim: WalkPerimeter | null): Promise<RouteResult> {
  let bundle = bundleIn;
  ctx.onStatus?.(`Loading terrain model for this fire · ${(sizeOf(bundle) / 1e6).toFixed(1)} MB…`);
  try {
    await ensureBundle(bundle);
  } catch (err) {
    // A newer live bundle than the pack holds, on a dead network: route on
    // the packed one rather than failing.
    const packed = ctx.corneaId ? await loadPackedBundle(ctx.corneaId) : null;
    if (packed && packed.bundle_id !== bundle.bundle_id
        && insideRoutingArea(packed, a) && insideRoutingArea(packed, b)) {
      bundle = packed;
      try {
        await ensureBundle(bundle);
      } catch (err2) {
        ctx.onStatus?.(null);
        throw new WalkError('load-failed', WALK_ERROR_TEXT['load-failed'] + ` (${String(err2).slice(0, 80)})`);
      }
    } else {
      ctx.onStatus?.(null);
      throw new WalkError('load-failed', WALK_ERROR_TEXT['load-failed'] + ` (${String(err).slice(0, 80)})`);
    }
  }
  await setPerimeter(perim ? perim.path : null, perim ? polygonsOf(perim.feature.geometry) : null);
  ctx.onStatus?.('Computing walking route…');
  let res;
  try {
    res = await routeOffroad(a, b, !!perim && ctx.avoidPerimeter, perim?.date ?? null);
  } finally {
    ctx.onStatus?.(null);
  }
  if (res.ok) {
    res.route.notes = [...(res.route.notes ?? []),
      ...perimeterNotes(perim, ctx, !!res.route.provenance?.avoidPerimeter)];
    return res.route;
  }
  if (res.code === 'superseded') throw new WalkError('superseded', '');
  if (res.code === 'blocked_by_perimeter') throw new WalkError('blocked', WALK_ERROR_TEXT.blocked, res.alternative);
  if (res.code === 'budget') throw new WalkError('budget', WALK_ERROR_TEXT.budget);
  if (res.code === 'decode-failed') throw new WalkError('load-failed', WALK_ERROR_TEXT['load-failed']);
  throw new WalkError('no-path', res.message || WALK_ERROR_TEXT['no-path']);
}

function sizeOf(b: RoutingBundle): number {
  return b.files.grid.bytes + b.files.dem.bytes + b.files.graph.bytes;
}

function gapLeg(from: LonLat, to: LonLat): RouteLeg {
  return { kind: 'gap', coordinates: [from, to], distanceM: metresBetween(from, to),
    climbM: 0, descentM: 0, durationS: null };
}

async function online(a: LonLat, b: LonLat, ctx: WalkContext): Promise<RouteResult> {
  let base: RouteResult;
  try {
    base = await routeHikeOnline(a, b);
  } catch {
    throw new WalkError('online-failed', WALK_ERROR_TEXT['online-failed']);
  }
  const coords = base.geometry.coordinates;
  const notes: RouteNote[] = [{ level: 'warn', code: 'ONLINE_NO_PERIM',
    text: 'Online route — does not avoid the fire perimeter.' }];
  const legs: RouteLeg[] = [];
  let modeled = false;
  const bundle = ctx.bundle;
  const gap = async (from: LonLat, to: LonLat): Promise<RouteLeg[]> => {
    if (metresBetween(from, to) <= GAP_M) return [];
    if (bundle && insideRoutingArea(bundle, from) && insideRoutingArea(bundle, to)) {
      try {
        const r = await offroad(from, to, bundle, { ...ctx, avoidPerimeter: false }, null);
        modeled = true;
        return r.legs ?? [];
      } catch {
        /* fall back to a straight untimed gap */
      }
    }
    notes.push({ level: 'warn', code: 'GAP_UNTIMED',
      text: `+${(metresBetween(from, to) / 1609.344).toFixed(1)} mi cross-country to a pin (straight line, not modeled, not in the time).` });
    return [gapLeg(from, to)];
  };
  legs.push(...(await gap(a, coords[0])));
  legs.push({ kind: 'net', coordinates: coords, distanceM: base.distanceM, climbM: 0, descentM: 0,
    durationS: base.durationS });
  legs.push(...(await gap(coords[coords.length - 1], b)));
  const perim = await ctx.getPerimeter().catch(() => null);
  if (perim && crossesPerimeter(coords, polygonsOf(perim.feature.geometry))) {
    notes.push({ level: 'warn', code: 'CROSSES_PERIM', text: 'This route crosses the latest mapped fire perimeter.' });
  }
  const all: LonLat[] = [];
  let dist = 0;
  let dur = 0;
  let fast = 0;
  let slow = 0;
  for (const l of legs) {
    all.push(...l.coordinates);
    dist += l.distanceM;
    if (l.durationS != null) {
      dur += l.durationS;
      fast += l.durationRangeS?.[0] ?? l.durationS;
      slow += l.durationRangeS?.[1] ?? l.durationS;
    }
  }
  return {
    ...base,
    geometry: { type: 'LineString', coordinates: all },
    distanceM: dist,
    durationS: dur,
    legs,
    durationRangeS: modeled ? [fast, slow] : undefined,
    modeled,
    notes,
  };
}

export async function routeWalk(a: LonLat, b: LonLat, ctx: WalkContext): Promise<RouteResult> {
  const bundle = ctx.bundle;
  if (bundle && insideRoutingArea(bundle, a) && insideRoutingArea(bundle, b)) {
    const perim = ctx.avoidPerimeter ? await ctx.getPerimeter().catch(() => null) : null;
    return offroad(a, b, bundle, ctx, perim);
  }
  if (!ctx.online) {
    if (bundle) throw new WalkError('outside-area-offline', WALK_ERROR_TEXT['outside-area-offline']);
    throw new WalkError(ctx.packed ? 'offline-no-bundle' : 'offline-not-packed',
      WALK_ERROR_TEXT[ctx.packed ? 'offline-no-bundle' : 'offline-not-packed']);
  }
  return online(a, b, ctx);
}
