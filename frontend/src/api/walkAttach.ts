/**
 * Where an online Walk route meets the pins. The online engines join a pin
 * to whichever way is nearest on a flat map — down a cliff if that is
 * nearest. Yosemite, 2026-10: two pins 400 m apart on the rim above the
 * valley's north wall fell either side of the line where Valley Loop Trail
 * (800 m below) and El Capitan Trail (on the rim) are equally far, so one
 * route went straight down the wall (4 h 11, the descent neither timed nor
 * climbed) and the other along the rim (8 h 10).
 *
 * Here an off-network end joins the way with the least total time: the
 * straight cross-country line to it priced on the terrain
 * (routing/terrainTiles: impassable over 45°) plus the /route time from
 * there — the time the card shows, so the choice and the total agree and
 * the total moves smoothly with the pin. The engine's own join is always in
 * the running (its route is already known), so the result is never slower.
 *
 * Candidates come from /locate: the nearest way to the pin and to 16 probes,
 * 8 compass points at d and 2d from it (d = distance to the engine's join,
 * ≤ 3 km); when none of those lines is walkable (a pin above a cliff whose
 * foot is nearest), once more at 4d, 8d and 16d. Kept within REACH_M (each
 * line's terrain tiles are fetched, about 130 KB per 7 km tile). Each way
 * offers its cheapest-to-reach point; the MAX_WAYS cheapest are timed by
 * /route. Not Valhalla's matrix: on the FOSSGIS server it caps at 100
 * pairs, leaves long pairs blank, and its times for one pair change with
 * the request's shape (9,626 vs 12,166 s).
 */
import { locateWays, routeHikeOnline, type RouteResult } from './routing';
import { Dem, priceConnector, walkable, type TileSource } from '../routing/terrainTiles';
import { metresBetween } from '../routing/safety';

type LonLat = [number, number];

/** One end of the route: its pin, the engine's join, and whether to
 * choose (false: the join stays — on the network, or modeled offline). */
export interface End {
  pin: LonLat;
  join: LonLat;
  choose: boolean;
}

/** A join point, its OSM way, and the seconds to walk to it from the pin. */
type Cand = { at: LonLat; way: number | null; s: number };

const DEDUPE_M = 30;
const MAX_D_M = 3000;
const REACH_M = 5000;
const MAX_WAYS = 3;
/** Added to a line that can't be walked: any walkable join beats it. */
const BLOCKED_S = 1e7;

function ring(p: LonLat, r: number): LonLat[] {
  const ky = 111_320;
  const kx = ky * Math.cos((p[1] * Math.PI) / 180);
  return Array.from({ length: 8 }, (_, k) => {
    const t = (k * Math.PI) / 4;
    return [p[0] + (r * Math.sin(t)) / kx, p[1] + (r * Math.cos(t)) / ky];
  });
}

/** The route between the joins with the least total time, or null to keep
 * the engine's (`base`): a request failed, or the run was superseded. Ends
 * choose in turn — A against B's join, B against A's choice, and A once
 * more when B moved. */
export async function chooseJoins(ends: [End, End], base: RouteResult, isStale: () => boolean,
  tiles?: TileSource): Promise<RouteResult | null> {
  if (isStale()) return null;
  const d = ends.map((e) => Math.min(metresBetween(e.pin, e.join), MAX_D_M));
  const cands: Cand[][] = ends.map((e) => [{ at: e.join, way: null, s: e.choose ? NaN : 0 }]);
  // add the ways nearest the pin and rings of these radii, then price them
  const gather = async (radii: number[][]) => {
    const probes = ends.map((e, i) => (radii[i].length ? [e.pin, ...radii[i].flatMap((r) => ring(e.pin, r))] : []));
    const found = await locateWays(probes.flat());
    let k = 0;
    probes.forEach((ps, i) => ps.forEach(() => {
      const q = found[k++];
      if (!q || metresBetween(ends[i].pin, q.at) > REACH_M) return;
      const dup = cands[i].find((c) => metresBetween(c.at, q.at) <= DEDUPE_M);
      if (!dup) cands[i].push({ ...q, s: NaN });
      else dup.way ??= q.way; // the engine's join, named by /locate
    }));
    const todo = cands.flatMap((cs, i) => cs.filter((c) => Number.isNaN(c.s)).map((c) => [i, c] as const));
    // a tile that fails reads as blocked ground: those lines rank last
    const dem = await Dem.load(todo.map(([i, c]) => [ends[i].pin, c.at]), tiles, true);
    for (const [i, c] of todo) {
      // in walking order: A → join, join → B
      const x = i === 0 ? priceConnector(dem, ends[0].pin, c.at) : priceConnector(dem, c.at, ends[1].pin);
      c.s = x.durationS + (walkable(x) ? 0 : BLOCKED_S + x.blockedM);
    }
  };
  const walkableAt = (i: number) => cands[i].some((c) => c.s < BLOCKED_S);
  await gather(ends.map((e, i) => (e.choose ? [d[i], 2 * d[i]] : [])));
  if (isStale()) return null;
  if (ends.some((e, i) => e.choose && !walkableAt(i))) {
    await gather(ends.map((e, i) => (e.choose && !walkableAt(i)
      ? [4, 8, 16].map((x) => Math.min(x * d[i], REACH_M - 250)) : [])));
    if (isStale()) return null;
  }
  // walkable ones only when there are any; each way's cheapest point; plus
  // the engine's join, whose route is free
  const picks = ends.map((_, i) => {
    const pool = walkableAt(i) ? cands[i].filter((c) => c.s < BLOCKED_S) : cands[i];
    const byWay = new Map<number | string, Cand>();
    pool.forEach((c, n) => {
      const key = c.way ?? `n${n}`;
      const b = byWay.get(key);
      if (!b || c.s < b.s) byWay.set(key, c);
    });
    const top = [...byWay.values()].sort((p, q) => p.s - q.s).slice(0, MAX_WAYS);
    return pool.includes(cands[i][0]) && !top.includes(cands[i][0]) ? [...top, cands[i][0]] : top;
  });
  const routes = new Map<string, Promise<RouteResult | null>>([[`${ends[0].join}|${ends[1].join}`, Promise.resolve(base)]]);
  const timed = (p: LonLat, q: LonLat) => {
    const key = `${p}|${q}`;
    if (!routes.has(key)) routes.set(key, routeHikeOnline(p, q).catch(() => null));
    return routes.get(key)!;
  };
  const sel: [Cand, Cand] = [cands[0][0], cands[1][0]];
  let route = base;
  let best = sel[0].s + base.durationS + sel[1].s;
  for (const [n, i] of [0, 1, 0].entries()) {
    if (n === 2 && sel[1] === cands[1][0]) break; // B kept its join: A's pass stands
    for (const c of picks[i]) {
      const pair: [Cand, Cand] = i === 0 ? [c, sel[1]] : [sel[0], c];
      const r = await timed(pair[0].at, pair[1].at);
      if (isStale()) return null;
      if (r && pair[0].s + r.durationS + pair[1].s < best) {
        best = pair[0].s + r.durationS + pair[1].s;
        route = r;
        sel[i] = c;
      }
    }
  }
  return route;
}
