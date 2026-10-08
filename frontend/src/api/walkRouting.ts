/**
 * Walk: the offline off-road router inside a fire's routing area, the
 * online foot engines elsewhere (docs/trails-routing/FINAL_PLAN.md).
 *
 *  1. The fire has a bundle and BOTH A and B are inside its grid → the
 *     on-device router, online or not. It knows the fire; the online
 *     engines don't, so a "no path" or "blocked by the perimeter" here
 *     never falls back to them.
 *  2. Otherwise, offline → an explicit error (not the generic "no route").
 *  3. Otherwise → ORS / Valhalla, with ONLINE_NO_PERIM always. The engines
 *     join a pin to the nearest way on a flat map (up to tens of km off), so
 *     an end that lies inside the fire's routing area is modeled
 *     cross-country by the on-device router, and any other far end has its
 *     join chosen by total time over the terrain (walkAttach.ts) and is
 *     drawn as a dotted straight 'gap' leg, timed on the terrain — untimed,
 *     with GAP_STEEP, when that line crosses ground over 45°.
 * Either way the drawn line is checked against the latest perimeter, with
 * avoidance on or off: CROSSES_PERIM when it enters it, NEAR_PERIM within
 * 200 m, PERIM_OLD when the perimeter is over 12 h old.
 */
import { routeHikeOnline, type RouteLeg, type RouteNote, type RouteResult, type RouteStep } from './routing';
import { chooseJoins, type End } from './walkAttach';
import type { PerimeterFeature } from './types';
import { insideRoutingArea } from '../routing/bundleIndex';
import { loadPackedBundle } from '../routing/hooks';
import { ensureBundle, routeOffroad, setPerimeter } from '../routing/offroadClient';
import { bearing, fmtDur, fmtFeet, fmtMiles } from '../routing/legs';
import { ageHours, crossesPerimeter, metresBetween, nearestApproachM, polygonsOf } from '../routing/safety';
import { Dem, priceConnector, walkable, type Connector, type TileSource } from '../routing/terrainTiles';
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
  /** True once a newer request replaced this one: stop chaining calls. */
  isStale?(): boolean;
  /** Terrain tiles for the cross-country ends (tests pass synthetic ones). */
  tiles?: TileSource;
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
const NEAR_PERIM_M = 200;

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

/** The latest perimeter against the line actually drawn — whether or not
 * the route avoided it (a pin inside the fire, avoidance off, an online
 * engine). */
function perimeterNotes(p: WalkPerimeter | null, line: LonLat[], nowMs: number): RouteNote[] {
  const out: RouteNote[] = [];
  if (!p) return out;
  const polys = polygonsOf(p.feature.geometry);
  if (crossesPerimeter(line, polys)) {
    out.push({ level: 'warn', code: 'CROSSES_PERIM', text: 'This route crosses the latest mapped fire perimeter.' });
  } else {
    const d = nearestApproachM(line, polys, NEAR_PERIM_M);
    if (d != null) {
      out.push({ level: 'warn', code: 'NEAR_PERIM',
        text: `This route passes within ${Math.max(10, Math.round(d / 10) * 10)} m of the latest mapped fire perimeter.` });
    }
  }
  const age = ageHours(p.date, nowMs);
  if (age != null && age > PERIM_OLD_H) {
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
    const notes = [...(res.route.notes ?? []),
      ...perimeterNotes(perim, res.route.geometry.coordinates, ctx.nowMs)];
    if (!perim && ctx.avoidPerimeter) {
      notes.push({ level: 'warn', code: 'NO_PERIMETER', text: 'Fire perimeter unavailable — route does not avoid the fire.' });
    }
    res.route.notes = notes;
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

function gapLeg(from: LonLat, to: LonLat, c?: Connector | null): RouteLeg {
  const timed = !!c && walkable(c);
  return { kind: 'gap', coordinates: [from, to], distanceM: metresBetween(from, to),
    climbM: c?.climbM ?? 0, descentM: c?.descentM ?? 0, durationS: timed ? c.durationS : null,
    durationRangeS: timed ? c.rangeS : undefined };
}

/** The step for a straight cross-country end ('A' leaves the pin, 'B'
 * reaches it); `c` null = no terrain to price it. */
function gapStep(l: RouteLeg, who: 'A' | 'B', c: Connector | null): RouteStep {
  const [p, q] = l.coordinates;
  const way = `${bearing(p, q)} ${fmtMiles(l.distanceM)}`;
  const climb = [l.climbM >= 3 ? `↑ ${fmtFeet(l.climbM)}` : '', l.descentM >= 3 ? `↓ ${fmtFeet(l.descentM)}` : '']
    .filter(Boolean).join(' ');
  const how = l.durationS != null ? ` — about ${fmtDur(l.durationS)}`
    : c ? ' — crosses ground steeper than 45°, not timed' : ' — not timed (no terrain data)';
  const text = who === 'A' ? `Head cross-country ${way} to the route` : `Leave the route; go cross-country ${way} to B`;
  return { text: `${text}${climb ? `, ${climb}` : ''}${how}`, distanceM: l.distanceM };
}

async function online(a: LonLat, b: LonLat, ctx: WalkContext): Promise<RouteResult> {
  let base: RouteResult;
  try {
    base = await routeHikeOnline(a, b);
  } catch {
    throw new WalkError('online-failed', WALK_ERROR_TEXT['online-failed']);
  }
  const bundle = ctx.bundle;
  const stale = () => !!ctx.isStale?.();
  const modelable = (p: LonLat, q: LonLat) => !!bundle && insideRoutingArea(bundle, p) && insideRoutingArea(bundle, q);
  // an end the engine joined far off, by a line nothing models: pick its
  // join by total time over the terrain (api/walkAttach). One the bundle
  // models keeps the engine's join — the on-device router goes round its
  // cliffs, and a choice there would double the requests.
  let coords = base.geometry.coordinates;
  const ends: [End, End] = [{ pin: a, join: coords[0] }, { pin: b, join: coords[coords.length - 1] }]
    .map((e) => ({ ...e, choose: metresBetween(e.pin, e.join) > GAP_M && !modelable(e.pin, e.join) })) as [End, End];
  if (ends.some((e) => e.choose)) {
    const picked = await chooseJoins(ends, base, stale, ctx.tiles).catch(() => null);
    if (stale()) throw new WalkError('superseded', '');
    if (picked) base = picked;
    coords = base.geometry.coordinates;
  }
  const notes: RouteNote[] = [{ level: 'warn', code: 'ONLINE_NO_PERIM',
    text: 'Online route — does not avoid the fire perimeter.' }];
  let modeled = false;
  const gap = async (from: LonLat, to: LonLat, who: 'A' | 'B'): Promise<{ legs: RouteLeg[]; steps: RouteStep[] }> => {
    if (metresBetween(from, to) <= GAP_M) return { legs: [], steps: [] };
    if (modelable(from, to)) {
      try {
        const r = await offroad(from, to, bundle!, { ...ctx, avoidPerimeter: false }, null);
        modeled = true;
        // the engine calls the route's join "A" or "B" too: not a pin that moved
        const join = who === 'A' ? 'B ' : 'A ';
        notes.push(...(r.notes ?? []).filter((n) => !(n.code === 'SNAP_MOVED' && n.text.startsWith(join))));
        const steps = r.steps.slice(0, -1); // not its "Arrive at B"
        if (who === 'B' && steps[0]) {
          steps[0] = { ...steps[0], text: steps[0].text.replace(/^Head cross-country/, 'Leave the route; go cross-country') };
        }
        return { legs: r.legs ?? [], steps };
      } catch {
        /* fall back to a straight line */
      }
    }
    const c = await Dem.load([[from, to]], ctx.tiles).then((dem) => priceConnector(dem, from, to)).catch(() => null);
    const mi = fmtMiles(metresBetween(from, to));
    const side = who === 'A' ? 'from A to the route' : 'from the route to B';
    if (!c) {
      notes.push({ level: 'warn', code: 'GAP_UNTIMED',
        text: `+${mi} cross-country ${side} (straight line, not modeled, not in the time).` });
    } else if (!walkable(c)) {
      notes.push({ level: 'warn', code: 'GAP_STEEP',
        text: `The ${mi} straight line ${side} crosses ground steeper than 45° — find a way round. It is not in the time.` });
    } else {
      modeled = true;
      notes.push({ level: 'warn', code: 'GAP_TERRAIN',
        text: `+${mi} cross-country ${side}: straight line, timed as heavy going on the slope (ground cover isn't mapped here); rivers, lakes and small cliffs aren't checked.` });
    }
    const leg = gapLeg(from, to, c);
    return { legs: [leg], steps: [gapStep(leg, who, c)] };
  };
  const ga = await gap(a, coords[0], 'A');
  const gb = await gap(coords[coords.length - 1], b, 'B');
  const net = base.legs?.find((l) => l.kind === 'net');
  const legs: RouteLeg[] = [...ga.legs, { kind: 'net', coordinates: coords, distanceM: base.distanceM,
    climbM: net?.climbM ?? 0, descentM: net?.descentM ?? 0, durationS: base.durationS }, ...gb.legs];
  // the engine's own "arrive" comes after the leg to B
  const steps: RouteStep[] = gb.steps.length
    ? [...ga.steps, ...base.steps.slice(0, -1), ...gb.steps, { text: 'Arrive at B', distanceM: 0 }]
    : [...ga.steps, ...base.steps];
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
  const perim = await ctx.getPerimeter().catch(() => null);
  notes.push(...perimeterNotes(perim, all, ctx.nowMs));
  return {
    ...base,
    geometry: { type: 'LineString', coordinates: all },
    distanceM: dist,
    durationS: dur,
    steps,
    legs,
    durationRangeS: modeled ? [fast, slow] : undefined,
    modeled,
    notes,
  };
}

export async function routeWalk(a: LonLat, b: LonLat, ctx: WalkContext): Promise<RouteResult> {
  const bundle = ctx.bundle;
  if (bundle && insideRoutingArea(bundle, a) && insideRoutingArea(bundle, b)) {
    // fetched with avoidance off too: the route is still checked against it
    const perim = await ctx.getPerimeter().catch(() => null);
    return offroad(a, b, bundle, ctx, perim);
  }
  if (!ctx.online) {
    if (bundle) throw new WalkError('outside-area-offline', WALK_ERROR_TEXT['outside-area-offline']);
    throw new WalkError(ctx.packed ? 'offline-no-bundle' : 'offline-not-packed',
      WALK_ERROR_TEXT[ctx.packed ? 'offline-no-bundle' : 'offline-not-packed']);
  }
  return online(a, b, ctx);
}
