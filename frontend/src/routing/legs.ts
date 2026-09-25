/**
 * Search path → route legs, times, climb and step text (pure).
 *
 * Pieces come from the engine: graph runs (node + RDG1 edge sequences) and
 * cross-country runs (already smoothed grid-metre polylines). Graph runs
 * split into legs where the way's name/kind/restriction changes; a
 * cross-country run under 50 m between two graph legs is `minor` (drawn and
 * counted, but no step and no join marker — the same way's legs around it
 * read as one step that mentions the cut). Times: graph legs by Sullivan
 * tertiles on the smoothed node elevations; cross-country legs by the
 * sampler (GET pace × α, scaled by the tertile ratios). Legs are treated as
 * fully correlated — the range totals are sums of the per-leg fast and slow
 * ends. Nothing here sees the search cost, so the search-only
 * LEAVE_TRAIL_PENALTY_S never reaches a reported time.
 */
import type { RouteLeg, RouteStep } from '../api/routing';
import { SAC_FACTOR, gradeDeg, sullivanRate } from './costModel';
import type { RoutingGrid } from './gridDecode';
import { cellOf, demAt, type HybridGraph } from './hybridGraph';
import { FLAG, KIND, NONE, SRC, str, type Rdg1 } from './rdg1';
import { tallyPolyline } from './sampler';
import { STREAM_BIT, vegClass } from './vegClasses';

export type Piece =
  | { kind: 'graph'; nodes: number[]; edges: number[] }
  | { kind: 'xc'; pts: [number, number][] };

/** A leg as built here: an xc leg also names each stream it fords (null =
 * unnamed, or a bundle without stream names), one entry per crossing. */
export type WalkLeg = RouteLeg & { streamNames?: (string | null)[] };

/** "Company Creek", "Company Creek and 1 unnamed stream", "2 streams" —
 * the fords of some xc legs, names first, each name once. */
export function fordsText(legs: WalkLeg[]): { text: string; named: number; total: number } {
  const names: string[] = [];
  let total = 0;
  let unnamed = 0;
  for (const l of legs) {
    if (l.kind !== 'xc') continue;
    const n = l.streamCrossings ?? 0;
    total += n;
    const ids = l.streamNames ?? [];
    for (const nm of ids) if (nm && !names.includes(nm)) names.push(nm);
    unnamed += n - ids.filter(Boolean).length;
  }
  const s = (k: number) => (k > 1 ? 's' : '');
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? '';
  const text = !names.length ? `${total} stream${s(total)}`
    : unnamed ? `${list} and ${unnamed} unnamed stream${s(unnamed)}` : list;
  return { text, named: names.length, total };
}

export interface LegContext {
  grid: RoutingGrid;
  mask: Uint8Array | null;
  graph: HybridGraph;
  rdg: Rdg1;
  toLonLat: (x: number, y: number) => [number, number];
}

const SAMPLE_M = 15;
const CLIMB_HYSTERESIS_M = 3;
const MINOR_XC_M = 50;
const M_PER_MI = 1609.344;
const FT_PER_M = 3.28084;

/** Climb/descent with hysteresis: count only once a change from the last
 * anchor reaches 3 m (30 m DEM noise must not read as climbing). */
export function climbOf(zs: number[]): { climb: number; descent: number } {
  let climb = 0;
  let descent = 0;
  if (!zs.length) return { climb, descent };
  let anchor = zs[0];
  for (const z of zs) {
    const d = z - anchor;
    if (d >= CLIMB_HYSTERESIS_M) {
      climb += d;
      anchor = z;
    } else if (d <= -CLIMB_HYSTERESIS_M) {
      descent -= d;
      anchor = z;
    }
  }
  return { climb, descent };
}

function densify(pts: [number, number][], step: number): [number, number][] {
  const out: [number, number][] = pts.length ? [pts[0]] : [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let k = 1; k <= n; k++) out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  }
  return out;
}

function sourceOf(src: number): RouteLeg['source'] {
  return src === SRC.usfs ? 'usfs' : src === SRC.blm ? 'blm' : src === SRC.nps ? 'nps' : 'osm';
}

function graphLeg(ctx: LegContext, nodes: number[], edges: number[]): RouteLeg {
  const { graph: g, rdg } = ctx;
  const e0 = edges[0];
  let dist = 0;
  let typ = 0;
  let fast = 0;
  let slow = 0;
  for (let i = 0; i + 1 < nodes.length; i++) {
    const u = nodes[i];
    const v = nodes[i + 1];
    const dh = Math.hypot(g.x[v] - g.x[u], g.y[v] - g.y[u]);
    const th = gradeDeg(g.z[v] - g.z[u], dh);
    const sac = SAC_FACTOR[rdg.sac[edges[i]]] ?? 1;
    dist += dh;
    typ += (dh / sullivanRate(th, 'mod')) * sac;
    fast += (dh / sullivanRate(th, 'high')) * sac;
    slow += (dh / sullivanRate(th, 'low')) * sac;
  }
  const { climb, descent } = climbOf(nodes.map((n) => g.z[n]));
  const kind = rdg.kind[e0];
  const flags = rdg.flags[e0];
  const note = str(rdg, rdg.note[e0]);
  return {
    kind: kind === KIND.paved || kind === KIND.unpaved || kind === KIND.track ? 'road' : 'trail',
    coordinates: nodes.map((n) => ctx.toLonLat(g.x[n], g.y[n])),
    distanceM: dist,
    climbM: climb,
    descentM: descent,
    durationS: typ,
    durationRangeS: [fast, slow],
    name: str(rdg, rdg.name[e0]),
    ref: str(rdg, rdg.ref[e0]),
    source: sourceOf(rdg.src[e0]),
    restricted: note ?? (flags & FLAG.restricted ? 'Access restricted (OSM)' : null),
  };
}

function xcLeg(ctx: LegContext, pts: [number, number][]): WalkLeg {
  const { grid, mask } = ctx;
  const t = tallyPolyline(grid, mask, pts);
  const dense = densify(pts, SAMPLE_M);
  const vegM: Record<number, number> = {};
  const runs: { veg: number; from: number; to: number }[] = [];
  // one entry per ford, named from grid band 3 when the bundle has it (the
  // first named cell of the crossing: a line's cells aren't all named)
  const fords: (string | null)[] = [];
  let inStream = false;
  let dist = 0;
  for (let j = 0; j + 1 < dense.length; j++) {
    const [x0, y0] = dense[j];
    const [x1, y1] = dense[j + 1];
    const d = Math.hypot(x1 - x0, y1 - y0);
    dist += d;
    const cell = cellOf(grid, (x0 + x1) / 2, (y0 + y1) / 2);
    const vb = cell >= 0 ? grid.veg[cell] : 0;
    const cls = vegClass(vb).id;
    vegM[cls] = (vegM[cls] ?? 0) + d;
    const last = runs[runs.length - 1];
    if (last && last.veg === cls) last.to = j + 1;
    else runs.push({ veg: cls, from: j, to: j + 1 });
    const s = (vb & STREAM_BIT) !== 0;
    if (s) {
      const id = grid.stream?.[cell] ?? 0;
      const name = id ? grid.streamNames?.[id - 1] ?? null : null;
      if (!inStream) fords.push(name);
      else if (name && fords[fords.length - 1] == null) fords[fords.length - 1] = name;
    }
    inStream = s;
  }
  const { climb, descent } = climbOf(dense.map(([x, y]) => demAt(grid, x, y)));
  return {
    kind: 'xc',
    coordinates: dense.map(([x, y]) => ctx.toLonLat(x, y)),
    distanceM: dist,
    climbM: climb,
    descentM: descent,
    durationS: t.cost,
    durationRangeS: [t.fast, t.slow],
    vegM,
    vegRuns: runs,
    streamCrossings: fords.length,
    streamNames: fords,
  };
}

/** Graph runs split into legs where the step LABEL changes (wayLabel: the
 * name, else the ref) or the restriction does (note, or OSM's restricted
 * flag — graphLeg reads both from a leg's first edge, so an access=no
 * stretch must start its own leg). A ref alone must not split a named way:
 * conflation donates an agency number to only some of an OSM way's edges,
 * and on SISI that turned one walk up Agnes Gorge Trail into two identical
 * "Follow Agnes Gorge Trail" steps. */
function wayKey(rdg: Rdg1, e: number): string {
  const k = rdg.kind[e];
  const road = k === KIND.paved || k === KIND.unpaved || k === KIND.track;
  const label = rdg.name[e] !== NONE ? `n${rdg.name[e]}` : `r${rdg.ref[e]}`;
  return `${label}|${rdg.note[e]}|${rdg.flags[e] & FLAG.restricted}|${road ? 'r' : 't'}`;
}

export function buildLegs(ctx: LegContext, pieces: Piece[]): WalkLeg[] {
  const legs: WalkLeg[] = [];
  for (const p of pieces) {
    if (p.kind === 'xc') {
      if (p.pts.length >= 2) legs.push(xcLeg(ctx, p.pts));
      continue;
    }
    let start = 0;
    for (let i = 1; i <= p.edges.length; i++) {
      if (i === p.edges.length || wayKey(ctx.rdg, p.edges[i]) !== wayKey(ctx.rdg, p.edges[start])) {
        legs.push(graphLeg(ctx, p.nodes.slice(start, i + 1), p.edges.slice(start, i)));
        start = i;
      }
    }
  }
  for (let i = 1; i + 1 < legs.length; i++) {
    const l = legs[i];
    if (l.kind === 'xc' && l.distanceM < MINOR_XC_M && legs[i - 1].kind !== 'xc'
        && legs[i + 1].kind !== 'xc') {
      l.minor = true;
    }
  }
  return legs.filter((l) => l.distanceM > 0.5);
}

export interface RouteTotals {
  distanceM: number;
  durationS: number;
  rangeS: [number, number];
  climbM: number;
  descentM: number;
  trailM: number;
  xcM: number;
}

export function totals(legs: RouteLeg[]): RouteTotals {
  const t: RouteTotals = { distanceM: 0, durationS: 0, rangeS: [0, 0], climbM: 0, descentM: 0, trailM: 0, xcM: 0 };
  for (const l of legs) {
    t.distanceM += l.distanceM;
    t.climbM += l.climbM;
    t.descentM += l.descentM;
    if (l.kind === 'xc' || l.kind === 'gap') t.xcM += l.distanceM;
    else t.trailM += l.distanceM;
    if (l.durationS != null) {
      t.durationS += l.durationS;
      t.rangeS[0] += l.durationRangeS?.[0] ?? l.durationS;
      t.rangeS[1] += l.durationRangeS?.[1] ?? l.durationS;
    }
  }
  return t;
}

// ---------- text ----------

export function fmtMiles(m: number): string {
  const mi = m / M_PER_MI;
  return mi < 0.1 ? `${Math.round(m * FT_PER_M / 10) * 10} ft` : `${mi.toFixed(1)} mi`;
}

export function fmtFeet(m: number): string {
  return `${(Math.round((m * FT_PER_M) / 10) * 10).toLocaleString('en-US')} ft`;
}

/** < 60 min → nearest minute; else nearest 5 min. */
export function fmtDur(s: number): string {
  const min = s / 60;
  if (min < 60) return `${Math.max(1, Math.round(min))} min`;
  const r = Math.round(min / 5) * 5;
  const h = Math.floor(r / 60);
  const mm = r % 60;
  return mm ? `${h} h ${String(mm).padStart(2, '0')} min` : `${h} h`;
}

/** The typical time only: the UI shows no fast/slow bounds (owner call;
 * WalkRouteDetails.tsx). */
function fmtAbout(l: RouteLeg): string {
  return l.durationS == null ? '' : ` — about ${fmtDur(l.durationS)}`;
}

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function bearing(a: [number, number], b: [number, number]): string {
  const dx = (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180);
  const dy = b[1] - a[1];
  const deg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  return DIRS[Math.round(deg / 45) % 8];
}

const M_PER_DEG = 111_320;
/** Douglas–Peucker tolerance for a cross-country step's bends. */
const BEND_TOL_M = 80;
const MAX_PARTS = 4;
/** Shorter parts fold into a neighbour: every part reads 0.1 mi or more. */
const MIN_PART_M = M_PER_MI / 10;

function segDist(p: number[], a: number[], b: number[]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** A cross-country leg's main bends as compass parts (NE 0.4 mi, then N
 * 0.6 mi): one bearing from end to end would send a crew across the river
 * or cliff band the drawn line bends around. Douglas–Peucker in local
 * metres, farthest vertex first so the cap keeps the biggest bends; a tiny
 * part folds into its neighbour, and neighbours with one bearing join.
 * Part distances are along the line, scaled to the leg's distance. */
function xcParts(l: RouteLeg): { dir: string; m: number }[] {
  const c = l.coordinates;
  const kx = Math.cos((c[0][1] * Math.PI) / 180) * M_PER_DEG;
  const p = c.map(([lon, lat]) => [lon * kx, lat * M_PER_DEG]);
  const cum = [0];
  for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
  const keep = [0, p.length - 1];
  while (keep.length <= MAX_PARTS) {
    let best = -1;
    let far = BEND_TOL_M;
    for (let j = 0; j + 1 < keep.length; j++) {
      for (let i = keep[j] + 1; i < keep[j + 1]; i++) {
        const d = segDist(p[i], p[keep[j]], p[keep[j + 1]]);
        if (d > far) {
          far = d;
          best = i;
        }
      }
    }
    if (best < 0) break;
    keep.push(best);
    keep.sort((a, b) => a - b);
  }
  const scale = cum[cum.length - 1] ? l.distanceM / cum[cum.length - 1] : 0;
  const parts: { dir: string; m: number }[] = [];
  for (let j = 0; j + 1 < keep.length; j++) {
    const dir = bearing(c[keep[j]], c[keep[j + 1]]);
    const m = (cum[keep[j + 1]] - cum[keep[j]]) * scale;
    const last = parts[parts.length - 1];
    if (!last) parts.push({ dir, m });
    else if (last.m < MIN_PART_M) { // a tiny first part joins the next
      last.dir = dir;
      last.m += m;
    } else if (last.dir === dir || m < MIN_PART_M) last.m += m;
    else parts.push({ dir, m });
  }
  return parts;
}

function ll(p: [number, number]): string {
  return `${p[1].toFixed(5)}, ${p[0].toFixed(5)}`;
}

function wayLabel(l: RouteLeg): string {
  if (l.name) return l.name;
  if (l.ref) return l.kind === 'road' ? `road ${l.ref}` : `trail ${l.ref}`;
  return l.kind === 'road' ? 'unnamed road' : 'unnamed trail';
}

function climbText(l: RouteLeg): string {
  const up = l.climbM >= 3 ? `↑ ${fmtFeet(l.climbM)}` : '';
  const dn = l.descentM >= 3 ? `↓ ${fmtFeet(l.descentM)}` : '';
  return [up, dn].filter(Boolean).join(' ');
}

function dominantVeg(l: RouteLeg): string {
  const entries = Object.entries(l.vegM ?? {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '';
  const top = entries.slice(0, 2).filter(([, m], i) => i === 0 || m > 0.25 * l.distanceM);
  return top.map(([id]) => vegClass(Number(id)).short).join(' and ');
}

const isWay = (l: RouteLeg) => l.kind === 'road' || l.kind === 'trail';

/** Same step text: kind, label and restriction. */
const sameWay = (p: RouteLeg, q: RouteLeg) => p.kind === q.kind && wayLabel(p) === wayLabel(q)
  && (p.restricted ?? null) === (q.restricted ?? null);

/** Consecutive legs as one step's numbers. */
function sumLegs(legs: RouteLeg[]): RouteLeg {
  const out: RouteLeg = { ...legs[0], distanceM: 0, climbM: 0, descentM: 0, durationS: 0, durationRangeS: [0, 0] };
  for (const l of legs) {
    out.distanceM += l.distanceM;
    out.climbM += l.climbM;
    out.descentM += l.descentM;
    out.durationS = (out.durationS ?? 0) + (l.durationS ?? 0);
    out.durationRangeS![0] += l.durationRangeS?.[0] ?? l.durationS ?? 0;
    out.durationRangeS![1] += l.durationRangeS?.[1] ?? l.durationS ?? 0;
  }
  return out;
}

export function stepsFor(legs: WalkLeg[]): RouteStep[] {
  const steps: RouteStep[] = [];
  let first = true;
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i];
    if (l.minor) continue;
    const c = l.coordinates;
    if (l.kind === 'xc') {
      const veg = dominantVeg(l);
      const cross = l.streamCrossings ? `, crossing ${fordsText([l]).text}` : '';
      const lead = first ? 'Head cross-country' : `Leave the ${legs[i - 1]?.kind === 'road' ? 'road' : 'trail'} at ${ll(c[0])}; go cross-country`;
      const climb = climbText(l);
      const through = veg ? ` through ${veg}` : '';
      const parts = xcParts(l);
      const way = parts.length > 1
        ? `${fmtMiles(l.distanceM)}${through}: ${parts.map((p) => `${p.dir} ${fmtMiles(p.m)}`).join(', then ')}`
        : `${bearing(c[0], c[c.length - 1])} ${fmtMiles(l.distanceM)}${through}`;
      steps.push({
        text: `${lead} ${way}${cross}${climb ? `, ${climb}` : ''}${fmtAbout(l)}`,
        distanceM: l.distanceM,
      });
    } else if (l.kind === 'gap') {
      steps.push({ text: `Straight line ${fmtMiles(l.distanceM)} to the pin — not modeled, not timed`, distanceM: l.distanceM });
    } else {
      const prev = legs.slice(0, i).reverse().find((p) => !p.minor);
      const label = wayLabel(l);
      if (prev?.kind === 'xc') steps.push({ text: `Join ${label} at ${ll(c[0])}`, distanceM: 0 });
      // One step per way: fold in the same way after minor (< 50 m)
      // cross-country hops, which get no step of their own — otherwise the
      // list read "Follow McGregor Mountain Trail" four times while the
      // drawn line left the trail between them.
      const run = [l];
      let cuts = 0;
      for (;;) {
        let k = i + 1;
        while (k < legs.length && legs[k].minor) k++;
        if (k >= legs.length || !isWay(legs[k]) || !sameWay(l, legs[k])) break;
        cuts += k - i - 1;
        run.push(...legs.slice(i + 1, k + 1));
        i = k;
      }
      const s = run.length > 1 ? sumLegs(run) : l;
      const verb = l.kind === 'road' ? (l.name || l.ref ? 'Continue on' : 'Follow') : 'Follow';
      const climb = climbText(s);
      const cut = cuts ? ` · includes ${cuts === 1 ? 'a short cross-country cut' : `${cuts} short cross-country cuts`}` : '';
      const restr = l.restricted ? ` · Restricted: ${l.restricted}` : '';
      steps.push({
        text: `${verb} ${label} ${fmtMiles(s.distanceM)}${climb ? `, ${climb}` : ''}${fmtAbout(s)}${cut}${restr}`,
        distanceM: s.distanceM,
      });
    }
    first = false;
  }
  steps.push({ text: 'Arrive at B', distanceM: 0 });
  return steps;
}
