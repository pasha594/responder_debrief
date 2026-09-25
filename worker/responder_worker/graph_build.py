"""Road + trail network for one routing AOI -> RDG1 binary (pure Python +
numpy; no shapely/GEOS).

Inputs: OSM nodes/ways (osm_extract.parse_opl) and agency trail lines
(normalized schema, already projected to the fire's UTM zone).

1. OSM ways are filtered and classed; legal-access tags never exclude a way
   (crews are administrative users) — they only set the RESTRICTED flag.
   Excluded: motorways, construction/proposed, platforms, area=yes,
   highway=via_ferrata and sac_scale demanding/difficult alpine (T5/T6: that
   is climbing, not crew travel).
2. OSM topology is exact: ways split only at nodes shared by >= 2 kept ways
   and at way ends, so bridges and tunnels never create false junctions.
3. Clip to the grid rectangle (runs of inside vertices; a boundary-crossing
   segment is dropped — the grid still routes around it).
4. Conflation keeps OSM topology: an agency trail >= 80 % covered by OSM
   ways (within 20 m, bearing within 35°) is dropped. Uncovered agency
   runs >= 60 m become new edges whose ends snap to an OSM vertex within
   10 m, else onto an OSM segment within 25 m (splitting it), else to another
   agency end within 10 m. Loose ends are fine: every graph vertex is also a
   portal into the cost grid, so the router bridges gaps cross-country.
   An uncovered run with less than 60 m of it beyond 40 m of a parallel OSM
   trail (path, steps or track; never a road) is the same trail drawn
   offset, not a trail OSM lacks: agency lines and OSM traces disagree by
   10-40 m under canopy (SISI, North Cascades: NPS vs OSM median offsets up
   to 30 m), and adding those runs braided the network with parallel copies
   that split route steps.
5. Whatever an agency trail is not added as, it says about the OSM trail it
   matches: its name/number/restriction/season/wilderness go to the OSM
   trail it parallels within 40 m (and to a road within 20 m when the whole
   trail is that road), per matched stretch of each OSM way rather than per
   edge, so a restriction covers the whole matched trail and not just the
   edges that happened to lie close; an edge splits where a match starts or
   ends inside it (_matched_spans, _donate_spans).

RDG1 (little-endian; gzip, mtime 0; sections 4-byte aligned) — the byte
contract with frontend/src/routing/rdg1.ts (FINAL_PLAN.md §2.6):
  header 64 B: "RDG1" u16 version u16 header_bytes u32 N u32 E u32 D u32 K
               u32 S u32 epsg f64 x0 f64 y0 u32 unit_mm u32 flags 8B reserved
  nodes i32[2N] (dm; x east of x0, y SOUTH of y0) · edge_from u32[E] ·
  edge_to u32[E] · edge_dstart u32[E+1] · deltas i16[2D] · edge_name u32[E] ·
  edge_ref u32[E] · edge_note u32[E] · edge_kind u8[E] · edge_src u8[E] ·
  edge_sac u8[E] · edge_flags u8[E] · str_off u32[K+1] · str u8[S]
"""

from __future__ import annotations

import gzip
import hashlib
import json
import math
import struct
from dataclasses import dataclass, field

import numpy as np

from . import utm

# Part of every bundle id (routing_bundle.build_fire): bump it whenever the
# SAME inputs would now give a different graph (classification, conflation,
# snapping), so existing bundles rebuild instead of staying "unchanged".
# 2: offset agency copies are no longer braided in (SAME_TRAIL_M).
# 3: agency attributes reach every matched OSM trail stretch; roads are
#    never the "same trail".
BUILD_VERSION = 3

KIND_PAVED, KIND_UNPAVED, KIND_TRACK, KIND_PATH, KIND_STEPS, KIND_AGENCY = 1, 2, 3, 4, 5, 6
TRAIL_KINDS = (KIND_TRACK, KIND_PATH, KIND_STEPS)
SRC_OSM, SRC_USFS, SRC_BLM, SRC_NPS = 1, 2, 3, 4
F_RESTRICTED, F_SEASONAL, F_BRIDGE, F_TUNNEL = 1, 2, 4, 8
F_WILDERNESS, F_NOT_ASSESSED, F_AGENCY_NAMED, F_FORD = 16, 32, 64, 128
NONE = 0xFFFFFFFF

EXCLUDE_HIGHWAY = {
    "motorway", "motorway_link", "construction", "proposed", "platform", "raceway",
    "bus_stop", "elevator", "corridor", "abandoned", "razed", "rest_area", "services",
    "escape", "busway", "bus_guideway", "emergency_bay", "via_ferrata", "disused",
}
ROADS = {
    "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link",
    "tertiary", "tertiary_link", "unclassified", "residential", "living_street",
    "service", "road",
}
PATHS = {"path", "footway", "bridleway", "cycleway", "pedestrian"}
UNPAVED = {"unpaved", "gravel", "dirt", "ground", "compacted", "fine_gravel", "earth",
           "mud", "sand", "grass", "pebblestone", "rock", "woodchips"}
SAC = {"hiking": 1, "mountain_hiking": 2, "demanding_mountain_hiking": 3,
       "alpine_hiking": 4, "demanding_alpine_hiking": 5, "difficult_alpine_hiking": 6}
AGENCY_SRC = {"USFS": SRC_USFS, "BLM": SRC_BLM, "NPS": SRC_NPS}

COVER_M, COVER_BEARING, COVER_FRACTION = 20.0, 35.0, 0.80
SAME_TRAIL_M = 40.0
NAME_EDGE_FRACTION = 0.60
# A match along an OSM way: hits closer than MATCH_GAP_M along it are one
# match (a brief divergence stays inside), which must be MIN_MATCH_M long
# and have parallel agency line along MATCH_SUPPORT of it, so a trail that
# only touches a track now and then is not the track. A match ending within
# CUT_SNAP_M of an edge end takes the whole edge; otherwise the edge splits.
MATCH_GAP_M, MIN_MATCH_M, MATCH_SUPPORT, CUT_SNAP_M = 200.0, 30.0, 0.5, 25.0
MIN_AGENCY_RUN_M = 60.0
SNAP_VERTEX_M, SNAP_SEGMENT_M, SNAP_AGENCY_M = 10.0, 25.0, 10.0
SAMPLE_M = 10.0
MAX_DELTA_DM = 32000


@dataclass
class Edge:
    a: int
    b: int
    xy: list  # [(x, y)] UTM metres, xy[0] == node a, xy[-1] == node b
    kind: int
    src: int = SRC_OSM
    sac: int = 0
    flags: int = 0
    name: str | None = None
    ref: str | None = None
    note: str | None = None
    way: tuple | None = None  # (OSM way id, clip run): edges of one way stretch
    seq: int = 0              # order along that way stretch


@dataclass
class Graph:
    nodes: list = field(default_factory=list)   # [(x, y)]
    edges: list = field(default_factory=list)   # [Edge]
    stats: dict = field(default_factory=dict)

    def add_node(self, x: float, y: float) -> int:
        self.nodes.append((float(x), float(y)))
        return len(self.nodes) - 1


# ---------------------------------------------------------------------------
# OSM
# ---------------------------------------------------------------------------

def classify_way(tags: dict) -> tuple[int, int, int] | None:
    """-> (kind, sac, flags) or None to exclude."""
    hw = tags.get("highway")
    if not hw or hw in EXCLUDE_HIGHWAY or tags.get("area") == "yes":
        return None
    sac = SAC.get(tags.get("sac_scale", ""), 0)
    if sac >= 5:
        return None
    if hw in ROADS or hw.endswith("_link"):
        kind = KIND_UNPAVED if tags.get("surface") in UNPAVED else KIND_PAVED
    elif hw == "track":
        kind = KIND_TRACK
    elif hw in PATHS:
        kind = KIND_PATH
    elif hw == "steps":
        kind = KIND_STEPS
    else:
        return None
    flags = 0
    if tags.get("access") in ("no", "private") or tags.get("foot") == "no":
        flags |= F_RESTRICTED
    if tags.get("bridge") not in (None, "no"):
        flags |= F_BRIDGE
    if tags.get("tunnel") not in (None, "no"):
        flags |= F_TUNNEL
    if tags.get("ford") == "yes":
        flags |= F_FORD
    return kind, sac, flags


def _inside(x, y, rect) -> bool:
    return rect[0] <= x <= rect[2] and rect[1] <= y <= rect[3]


def osm_graph(nodes_ll: dict, ways: list, *, zone: int, northern: bool, rect) -> Graph:
    """rect = (xmin, ymin, xmax, ymax) UTM metres."""
    kept = []
    for w in ways:
        c = classify_way(w["tags"])
        if c is None:
            continue
        refs = [r for r in w["nodes"] if r in nodes_ll]
        # collapse consecutive duplicates
        refs = [r for i, r in enumerate(refs) if i == 0 or r != refs[i - 1]]
        if len(refs) >= 2:
            kept.append((w, refs, c))
    count: dict[int, int] = {}
    for _, refs, _ in kept:
        for r in set(refs):
            count[r] = count.get(r, 0) + 1
    ids = sorted({r for _, refs, _ in kept for r in refs})
    if ids:
        lon = np.array([nodes_ll[i][0] for i in ids])
        lat = np.array([nodes_ll[i][1] for i in ids])
        xs, ys = utm.fwd(lon, lat, zone, northern)
        xy = dict(zip(ids, zip(np.atleast_1d(xs).tolist(), np.atleast_1d(ys).tolist())))
    else:
        xy = {}
    g = Graph()
    node_of: dict[int, int] = {}

    def nid(r):
        if r not in node_of:
            node_of[r] = g.add_node(*xy[r])
        return node_of[r]

    for w, refs, (kind, sac, flags) in kept:
        tags = w["tags"]
        name, ref = tags.get("name"), tags.get("ref")
        # runs of consecutive inside vertices
        run: list[int] = []
        runs = []
        for r in refs:
            if _inside(*xy[r], rect):
                run.append(r)
            else:
                if len(run) >= 2:
                    runs.append(run)
                run = []
        if len(run) >= 2:
            runs.append(run)
        for ri, run in enumerate(runs):
            start = seq = 0
            for i in range(1, len(run)):
                if i == len(run) - 1 or count.get(run[i], 0) >= 2:
                    seg = run[start:i + 1]
                    g.edges.append(Edge(nid(seg[0]), nid(seg[-1]), [xy[r] for r in seg],
                                        kind, SRC_OSM, sac, flags, name, ref,
                                        way=(w["id"], ri), seq=seq))
                    start = i
                    seq += 1
    return g


# ---------------------------------------------------------------------------
# agency trails
# ---------------------------------------------------------------------------

def clip_line(xy: list, rect) -> list[list]:
    runs, run = [], []
    for p in xy:
        if _inside(p[0], p[1], rect):
            run.append((float(p[0]), float(p[1])))
        else:
            if len(run) >= 2:
                runs.append(run)
            run = []
    if len(run) >= 2:
        runs.append(run)
    return runs


def _length(xy) -> float:
    return sum(math.hypot(xy[i + 1][0] - xy[i][0], xy[i + 1][1] - xy[i][1])
               for i in range(len(xy) - 1))


def densify(xy: list, step: float) -> tuple[np.ndarray, np.ndarray]:
    """-> (points (k,2), bearing mod 180 per point)."""
    pts, brg = [], []
    for i in range(len(xy) - 1):
        (x1, y1), (x2, y2) = xy[i], xy[i + 1]
        d = math.hypot(x2 - x1, y2 - y1)
        if d == 0:
            continue
        b = math.degrees(math.atan2(y2 - y1, x2 - x1)) % 180.0
        n = max(1, int(math.ceil(d / step)))
        for k in range(n):
            t = k / n
            pts.append((x1 + (x2 - x1) * t, y1 + (y2 - y1) * t))
            brg.append(b)
    if xy:
        pts.append((float(xy[-1][0]), float(xy[-1][1])))
        brg.append(brg[-1] if brg else 0.0)
    return np.asarray(pts, dtype=np.float64).reshape(-1, 2), np.asarray(brg)


class _Hash:
    def __init__(self, pts: np.ndarray, cell: float):
        self.cell = cell
        self.pts = pts
        self.buckets: dict[tuple[int, int], list[int]] = {}
        if len(pts):
            keys = np.floor(pts / cell).astype(np.int64)
            for i, (kx, ky) in enumerate(keys.tolist()):
                self.buckets.setdefault((kx, ky), []).append(i)

    def near(self, x: float, y: float, r: float) -> list[int]:
        c = self.cell
        kx, ky = int(math.floor(x / c)), int(math.floor(y / c))
        span = int(math.ceil(r / c))
        out = []
        for dx in range(-span, span + 1):
            for dy in range(-span, span + 1):
                out.extend(self.buckets.get((kx + dx, ky + dy), ()))
        return out


class _SegHash:
    """Segment index: each segment listed in every cell it crosses."""

    def __init__(self, cell: float):
        self.cell = cell
        self.buckets: dict[tuple[int, int], list[int]] = {}

    def add(self, si: int, p, q) -> None:
        c = self.cell
        n = max(1, int(math.ceil(math.hypot(q[0] - p[0], q[1] - p[1]) / (c / 2))))
        seen = set()
        for i in range(n + 1):
            t = i / n
            key = (int(math.floor((p[0] + (q[0] - p[0]) * t) / c)),
                   int(math.floor((p[1] + (q[1] - p[1]) * t) / c)))
            if key not in seen:
                seen.add(key)
                self.buckets.setdefault(key, []).append(si)

    def near(self, x: float, y: float, r: float) -> list[int]:
        c = self.cell
        kx, ky = int(math.floor(x / c)), int(math.floor(y / c))
        span = int(math.ceil(r / c))
        out: set[int] = set()
        for dx in range(-span, span + 1):
            for dy in range(-span, span + 1):
                out.update(self.buckets.get((kx + dx, ky + dy), ()))
        return list(out)


def _bdiff(a: float, b: float) -> float:
    d = abs(a - b) % 180.0
    return min(d, 180.0 - d)


def agency_edge_attrs(p: dict) -> dict:
    name, num = p.get("name"), p.get("num")
    label = f"{name} #{num}" if name and num else (name or (f"#{num}" if num else None))
    flags = 0
    if p.get("restr"):
        flags |= F_RESTRICTED
    if p.get("season"):
        flags |= F_SEASONAL
    if "Wilderness" in (p.get("mgmt") or ""):
        flags |= F_WILDERNESS
    if p.get("status") == "not_assessed":
        flags |= F_NOT_ASSESSED
    return {"src": AGENCY_SRC.get(p.get("agency"), SRC_USFS), "name": label,
            "ref": num, "note": p.get("restr"), "flags": flags}


def _split_edge_at(g: Graph, ei: int, cuts: list[tuple[float, tuple[float, float]]]) -> list[int]:
    """Split edge ei at positions (seg_index + t, point); -> node id per cut."""
    e = g.edges[ei]
    order = sorted(range(len(cuts)), key=lambda i: cuts[i][0])
    res = [0] * len(cuts)
    pieces = []
    cur_xy = [e.xy[0]]
    cur_a = e.a
    seg_done = 0  # vertices of e.xy consumed up to (index)
    last_pos = -1.0
    last_node = e.a
    for i in order:
        pos, pt = cuts[i]
        if pos <= 1e-9:
            res[i] = e.a
            continue
        if pos >= len(e.xy) - 1 - 1e-9:
            res[i] = e.b
            continue
        if pos - last_pos < 1e-6 and last_pos >= 0:
            res[i] = last_node
            continue
        seg = int(math.floor(pos))
        while seg_done < seg:
            seg_done += 1
            cur_xy.append(e.xy[seg_done])
        t = pos - seg
        if t < 1e-9:
            pt = e.xy[seg]
            if cur_xy[-1] != pt:
                cur_xy.append(pt)
        else:
            cur_xy.append(pt)
        n = g.add_node(*pt)
        pieces.append((cur_a, n, cur_xy))
        cur_xy, cur_a = [pt], n
        last_pos, last_node = pos, n
        res[i] = n
    if not pieces:
        return res
    while seg_done < len(e.xy) - 1:
        seg_done += 1
        cur_xy.append(e.xy[seg_done])
    pieces.append((cur_a, e.b, cur_xy))
    first = True
    for a, b, xy in pieces:
        if len(xy) < 2:
            continue
        ne = Edge(a, b, xy, e.kind, e.src, e.sac, e.flags, e.name, e.ref, e.note, e.way, e.seq)
        if first:
            g.edges[ei] = ne
            first = False
        else:
            g.edges.append(ne)
    return res


def _nearest_on_edges(g: Graph, candidates: list[int], seg_ref: list, x: float, y: float
                      ) -> tuple[float, int, float, tuple[float, float]] | None:
    """Nearest (dist, edge, pos, point) on any candidate OSM segment within
    SNAP_SEGMENT_M, preferring an existing vertex within SNAP_VERTEX_M."""
    best = None
    best_vertex = None
    for si in candidates:
        ei, k = seg_ref[si]
        (x1, y1), (x2, y2) = g.edges[ei].xy[k], g.edges[ei].xy[k + 1]
        dx, dy = x2 - x1, y2 - y1
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / L2))
        px, py = x1 + t * dx, y1 + t * dy
        d = math.hypot(x - px, y - py)
        if d <= SNAP_SEGMENT_M and (best is None or d < best[0]):
            best = (d, ei, k + t, (px, py))
        for vt, vx, vy in ((0.0, x1, y1), (1.0, x2, y2)):
            dv = math.hypot(x - vx, y - vy)
            if dv <= SNAP_VERTEX_M and (best_vertex is None or dv < best_vertex[0]):
                best_vertex = (dv, ei, k + vt, (vx, vy))
    return best_vertex or best


def _donate(e: Edge, attrs: dict) -> None:
    """An agency trail's attributes onto an OSM edge it matches (OSM's own
    name and ref win; a restriction note is never dropped)."""
    if not e.name:
        e.name = attrs["name"]
    if not e.ref:
        e.ref = attrs["ref"]
    e.note = e.note or attrs["note"]
    e.flags |= F_AGENCY_NAMED | (attrs["flags"] & (F_RESTRICTED | F_SEASONAL | F_WILDERNESS))


def _matched_spans(hits: list[tuple[int, int]], stretch: np.ndarray, pos: np.ndarray,
                   stretches: dict[int, list[int]], edge_off: dict[int, float],
                   edge_len: dict[int, float]) -> list[tuple[int, float, float]]:
    """Where an agency trail follows OSM, from its hits (OSM sample j near
    and parallel to agency sample i): per way stretch, hits split where they
    lie more than MATCH_GAP_M apart along the way, and a group spanning
    [lo, hi] is one match, however many edges it crosses (a brief parting
    of the lines stays inside it), if it is >= MIN_MATCH_M long and the
    agency samples behind it cover >= MATCH_SUPPORT of it. -> [(edge, u0,
    u1)]: the matched metres along each edge, snapped out to an edge end
    within CUT_SNAP_M."""
    out = []
    by_stretch: dict[int, list[tuple[float, int]]] = {}
    for j, i in set(hits):
        by_stretch.setdefault(int(stretch[j]), []).append((float(pos[j]), i))
    for sid, hs in by_stretch.items():
        hs.sort()
        ps = np.asarray([h[0] for h in hs])
        for idx in np.split(np.arange(len(hs)), np.flatnonzero(np.diff(ps) > MATCH_GAP_M) + 1):
            lo, hi = ps[idx[0]], ps[idx[-1]]
            if hi - lo < MIN_MATCH_M \
                    or len({hs[k][1] for k in idx}) * SAMPLE_M < MATCH_SUPPORT * (hi - lo):
                continue
            for ei in stretches[sid]:
                a, L = edge_off[ei], edge_len[ei]
                u0, u1 = max(lo - a, 0.0), min(hi - a, L)
                if u1 <= u0:
                    continue
                u0 = 0.0 if u0 < CUT_SNAP_M else u0
                u1 = L if L - u1 < CUT_SNAP_M else u1
                if u1 - u0 >= min(L, CUT_SNAP_M):
                    out.append((ei, u0, u1))
    return out


def _pos_at(xy: list, u: float) -> tuple[float, tuple[float, float]]:
    """Metres u along a polyline -> (segment index + t, point)."""
    acc = 0.0
    for k in range(len(xy) - 1):
        (x1, y1), (x2, y2) = xy[k], xy[k + 1]
        d = math.hypot(x2 - x1, y2 - y1)
        if d > 0 and acc + d >= u:
            t = (u - acc) / d
            return k + t, (x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)
        acc += d
    return len(xy) - 1.0, (float(xy[-1][0]), float(xy[-1][1]))


def _donate_spans(g: Graph, donations: list[tuple[int, float, float, dict]]) -> set[int]:
    """Give each (edge, u0, u1, attrs) its attributes, splitting an edge
    where a match starts or ends inside it, so a restriction covers the
    matched metres exactly. Earlier donations win (_donate). -> edges named."""
    by_edge: dict[int, list] = {}
    for ei, u0, u1, attrs in donations:
        by_edge.setdefault(ei, []).append((u0, u1, attrs))
    named: set[int] = set()
    for ei, spans in by_edge.items():
        e = g.edges[ei]
        L = _length(e.xy)
        cuts: list[float] = []  # one cut for match ends closer than CUT_SNAP_M: no slivers
        for u in sorted({u for u0, u1, _ in spans for u in (u0, u1) if 0 < u < L}):
            if not cuts or u - cuts[-1] >= CUT_SNAP_M:
                cuts.append(u)
        pieces = [(ei, 0.0, L)]
        if cuts:
            n_before = len(g.edges)
            nodes = _split_edge_at(g, ei, [_pos_at(e.xy, u) for u in cuts])
            ends = [e.a, *nodes, e.b]
            us = [0.0, *cuts, L]
            cand = [ei, *range(n_before, len(g.edges))]
            pieces = [(pe, us[k], us[k + 1]) for k in range(len(ends) - 1)
                      for pe in cand if (g.edges[pe].a, g.edges[pe].b) == (ends[k], ends[k + 1])]
        for u0, u1, attrs in spans:
            for pe, a, b in pieces:
                if u0 <= (a + b) / 2 <= u1:
                    _donate(g.edges[pe], attrs)
                    named.add(pe)
    return named


def conflate(g: Graph, agency: list[tuple[dict, list]], *, log=print) -> dict:
    """agency: [(normalized props, UTM polyline)] already clipped to the AOI.
    Mutates g. -> stats."""
    osm_idx = [i for i, e in enumerate(g.edges) if e.src == SRC_OSM]
    # OSM edges grouped into way stretches (osm_graph's Edge.way; an edge
    # built elsewhere is a stretch of its own) and offset along them
    sid_of: dict = {}
    stretches: dict[int, list[int]] = {}
    for ei in osm_idx:
        sid = sid_of.setdefault(g.edges[ei].way or ("edge", ei), len(sid_of))
        stretches.setdefault(sid, []).append(ei)
    edge_len = {ei: _length(g.edges[ei].xy) for ei in osm_idx}
    edge_off: dict[int, float] = {}
    for eis in stretches.values():
        eis.sort(key=lambda ei: g.edges[ei].seq)
        off = 0.0
        for ei in eis:
            edge_off[ei] = off
            off += edge_len[ei]
    pts, brg, owner, stretch, pos = [], [], [], [], []
    for ei in osm_idx:
        p, b = densify(g.edges[ei].xy, SAMPLE_M / 2)
        pts.append(p)
        brg.append(b)
        owner.append(np.full(len(p), ei, dtype=np.int64))
        stretch.append(np.full(len(p), sid_of[g.edges[ei].way or ("edge", ei)], dtype=np.int64))
        along = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])
        pos.append(edge_off[ei] + along[:len(p)])
    P = np.concatenate(pts) if pts else np.zeros((0, 2))
    B = np.concatenate(brg) if brg else np.zeros(0)
    O = np.concatenate(owner) if owner else np.zeros(0, dtype=np.int64)
    S = np.concatenate(stretch) if stretch else np.zeros(0, dtype=np.int64)
    W = np.concatenate(pos) if pos else np.zeros(0)
    trail = np.isin([g.edges[ei].kind for ei in osm_idx], TRAIL_KINDS)
    TRAIL = np.repeat(trail, [len(p) for p in pts]) if pts else np.zeros(0, bool)
    h = _Hash(P, SAME_TRAIL_M)

    stats = {"agency_features": len(agency), "agency_dropped_covered": 0,
             "agency_runs_added": 0, "agency_runs_parallel": 0, "osm_edges_named": 0,
             "snapped": 0}
    donations: list[tuple[int, float, float, dict]] = []
    new_runs: list[tuple[dict, list]] = []
    for props, line in agency:
        ap, ab = densify(line, SAMPLE_M)
        if len(ap) < 2:
            continue
        covered = np.zeros(len(ap), bool)  # a parallel OSM way within COVER_M
        same = np.zeros(len(ap), bool)     # a parallel OSM trail within SAME_TRAIL_M
        trail_hits: list[tuple[int, int]] = []  # (OSM sample, agency sample)
        road_hits: list[tuple[int, int]] = []
        for i, (x, y) in enumerate(ap.tolist()):
            for j in h.near(x, y, SAME_TRAIL_M):
                d2 = (P[j, 0] - x) ** 2 + (P[j, 1] - y) ** 2
                if d2 > SAME_TRAIL_M ** 2 or _bdiff(B[j], ab[i]) >= COVER_BEARING:
                    continue
                if TRAIL[j]:
                    same[i] = True
                    trail_hits.append((j, i))
                if d2 <= COVER_M ** 2:
                    covered[i] = True
                    if not TRAIL[j]:
                        road_hits.append((j, i))
        whole = covered.mean() >= COVER_FRACTION
        # a road is the trail only when the whole trail runs on it
        attrs = agency_edge_attrs(props)
        donations += [(ei, u0, u1, attrs) for ei, u0, u1 in _matched_spans(
            trail_hits + (road_hits if whole else []), S, W, stretches, edge_off, edge_len)]
        if whole:
            stats["agency_dropped_covered"] += 1
            continue
        # keep uncovered runs
        start = None
        for i in range(len(ap) + 1):
            unc = i < len(ap) and not covered[i]
            if unc and start is None:
                start = i
            elif not unc and start is not None:
                run = [tuple(p) for p in ap[max(0, start - 1):min(len(ap), i + 1)].tolist()]
                if _length(run) >= MIN_AGENCY_RUN_M:
                    # a new trail strays >= 60 m beyond SAME_TRAIL_M somewhere;
                    # otherwise it is an offset copy of the OSM trail beside it
                    if (~same[start:i]).sum() * SAMPLE_M < MIN_AGENCY_RUN_M:
                        stats["agency_runs_parallel"] += 1
                    else:
                        new_runs.append((props, run))
                start = None
    # split and name only now: the samples above index the unsplit edges
    stats["osm_edges_named"] = len(_donate_spans(g, donations))
    osm_idx = [i for i, e in enumerate(g.edges) if e.src == SRC_OSM]

    # snap run ends onto OSM, splitting edges; then agency-agency clusters.
    # Every segment is hashed into each 25 m cell it passes through, so a
    # query costs 9 buckets however long the network's straight segments are.
    seg_ref = [(ei, k) for ei in osm_idx for k in range(len(g.edges[ei].xy) - 1)]
    seg_hash = _SegHash(25.0)
    for si, (ei, k) in enumerate(seg_ref):
        seg_hash.add(si, g.edges[ei].xy[k], g.edges[ei].xy[k + 1])

    ends = []  # (run index, which end, x, y)
    for ri, (_, run) in enumerate(new_runs):
        ends.append((ri, 0, *run[0]))
        ends.append((ri, 1, *run[-1]))
    snap_req: dict[int, list] = {}
    snapped_to: dict[tuple[int, int], int] = {}
    pending = []
    for ri, which, x, y in ends:
        cand = seg_hash.near(x, y, SNAP_SEGMENT_M)
        best = _nearest_on_edges(g, cand, seg_ref, x, y) if cand else None
        if best is not None:
            snap_req.setdefault(best[1], []).append((best[2], best[3], (ri, which)))
        else:
            pending.append((ri, which, x, y))
    for ei, reqs in snap_req.items():
        nodes = _split_edge_at(g, ei, [(pos, pt) for pos, pt, _ in reqs])
        for (_, _, key), n in zip(reqs, nodes):
            snapped_to[key] = n
            stats["snapped"] += 1
    # remaining ends: merge agency ends within SNAP_AGENCY_M, else new nodes
    placed: list[tuple[float, float, int]] = []
    for ri, which, x, y in pending:
        n = None
        for px, py, pn in placed:
            if math.hypot(px - x, py - y) <= SNAP_AGENCY_M:
                n = pn
                break
        if n is None:
            n = g.add_node(x, y)
            placed.append((x, y, n))
        snapped_to[(ri, which)] = n
    for ri, (props, run) in enumerate(new_runs):
        a, b = snapped_to[(ri, 0)], snapped_to[(ri, 1)]
        xy = [g.nodes[a], *run[1:-1], g.nodes[b]]
        at = agency_edge_attrs(props)
        g.edges.append(Edge(a, b, xy, KIND_AGENCY, at["src"], 0, at["flags"], at["name"],
                            at["ref"], at["note"]))
        stats["agency_runs_added"] += 1
    return stats


# ---------------------------------------------------------------------------
# stats + hashes
# ---------------------------------------------------------------------------

def graph_stats(g: Graph) -> dict:
    km: dict[str, float] = {}
    names = {KIND_PAVED: "road", KIND_UNPAVED: "road", KIND_TRACK: "track",
             KIND_PATH: "trail", KIND_STEPS: "trail", KIND_AGENCY: "agency_trail"}
    for e in g.edges:
        k = names.get(e.kind, "other")
        km[k] = km.get(k, 0.0) + _length(e.xy) / 1000
    parent = list(range(len(g.nodes)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for e in g.edges:
        ra, rb = find(e.a), find(e.b)
        if ra != rb:
            parent[ra] = rb
    used = {find(e.a) for e in g.edges}
    sizes: dict[int, int] = {}
    for e in g.edges:
        r = find(e.a)
        sizes[r] = sizes.get(r, 0) + 1
    return {"nodes": len(g.nodes), "edges": len(g.edges),
            "km": {k: round(v, 1) for k, v in sorted(km.items())},
            "components": len(used),
            "largest_component_share": round(max(sizes.values()) / len(g.edges), 3)
            if g.edges else 0.0}


def osm_hash(nodes_ll: dict, ways: list) -> str:
    h = hashlib.sha256()
    for w in sorted(ways, key=lambda w: w["id"]):
        c = classify_way(w["tags"])
        if c is None:
            continue
        coords = [(round(nodes_ll[r][0], 6), round(nodes_ll[r][1], 6))
                  for r in w["nodes"] if r in nodes_ll]
        h.update(json.dumps([w["id"], c, w["tags"].get("name"), w["tags"].get("ref"),
                             w["nodes"], coords], separators=(",", ":")).encode())
    return h.hexdigest()[:16]


def trails_hash(agency: list[tuple[dict, list]]) -> str:
    h = hashlib.sha256()
    for props, line in sorted(agency, key=lambda t: (t[0].get("tid") or "", t[1][0] if t[1] else ())):
        h.update(json.dumps([props, [(round(x, 1), round(y, 1)) for x, y in line]],
                            sort_keys=True, separators=(",", ":")).encode())
    return h.hexdigest()[:16]


# ---------------------------------------------------------------------------
# RDG1
# ---------------------------------------------------------------------------

def _pad4(buf: bytearray) -> None:
    while len(buf) % 4:
        buf.append(0)


def encode_rdg1(g: Graph, *, epsg: int, x0: float, y0: float) -> bytes:
    """Serialize; -> gzip bytes (deterministic)."""
    def q(p):
        return int(round((p[0] - x0) * 10)), int(round((y0 - p[1]) * 10))

    strings: dict[str, int] = {}
    str_list: list[bytes] = []

    def sidx(s):
        if not s:
            return NONE
        if s not in strings:
            strings[s] = len(str_list)
            str_list.append(s.encode("utf-8"))
        return strings[s]

    qnodes = [q(p) for p in g.nodes]
    froms, tos, dstart, deltas = [], [], [0], []
    names, refs, notes, kinds, srcs, sacs, flags = [], [], [], [], [], [], []
    for e in g.edges:
        verts = [qnodes[e.a]] + [q(p) for p in e.xy[1:-1]] + [qnodes[e.b]]
        d = []
        for (ax, ay), (bx, by) in zip(verts, verts[1:]):
            dx, dy = bx - ax, by - ay
            n = max(1, int(math.ceil(max(abs(dx), abs(dy)) / MAX_DELTA_DM)))
            px, py = ax, ay
            for k in range(1, n + 1):
                nx, ny = ax + round(dx * k / n), ay + round(dy * k / n)
                if (nx, ny) != (px, py):
                    d.append((nx - px, ny - py))
                px, py = nx, ny
        if not d:
            if e.a == e.b:
                continue  # degenerate loop
            d = [(0, 0)]
        froms.append(e.a)
        tos.append(e.b)
        deltas.extend(d)
        dstart.append(len(deltas))
        names.append(sidx(e.name))
        refs.append(sidx(e.ref))
        notes.append(sidx(e.note))
        kinds.append(e.kind)
        srcs.append(e.src)
        sacs.append(e.sac)
        flags.append(e.flags & 0xFF)
    N, E, D, K = len(qnodes), len(froms), len(deltas), len(str_list)
    blob = b"".join(str_list)
    offs = [0]
    for s in str_list:
        offs.append(offs[-1] + len(s))
    out = bytearray(struct.pack("<4sHHIIIIIIddII8x", b"RDG1", 1, 64, N, E, D, K, len(blob),
                                epsg, x0, y0, 100, 1))
    assert len(out) == 64
    out += np.asarray(qnodes, dtype="<i4").reshape(-1).tobytes()
    out += np.asarray(froms, dtype="<u4").tobytes()
    out += np.asarray(tos, dtype="<u4").tobytes()
    out += np.asarray(dstart, dtype="<u4").tobytes()
    out += np.asarray(deltas, dtype="<i2").reshape(-1).tobytes()
    _pad4(out)
    out += np.asarray(names, dtype="<u4").tobytes()
    out += np.asarray(refs, dtype="<u4").tobytes()
    out += np.asarray(notes, dtype="<u4").tobytes()
    out += bytes(kinds) + bytes(srcs) + bytes(sacs) + bytes(flags)
    _pad4(out)
    out += np.asarray(offs, dtype="<u4").tobytes()
    out += blob
    _pad4(out)
    return gzip.compress(bytes(out), 9, mtime=0)


def decode_rdg1(data: bytes) -> dict:
    """Inverse of encode_rdg1 (tests + inspection)."""
    raw = gzip.decompress(data)
    (magic, ver, hdr, N, E, D, K, S, epsg, x0, y0, unit, flags) = struct.unpack_from(
        "<4sHHIIIIIIddII", raw, 0)
    if magic != b"RDG1" or ver != 1:
        raise ValueError("not RDG1 v1")
    pos = hdr

    def take(dtype, n):
        nonlocal pos
        a = np.frombuffer(raw, dtype=dtype, count=n, offset=pos)
        pos += a.nbytes
        return a

    def align():
        nonlocal pos
        pos = (pos + 3) & ~3

    nodes = take("<i4", 2 * N).reshape(N, 2)
    efrom, eto = take("<u4", E), take("<u4", E)
    dstart = take("<u4", E + 1)
    deltas = take("<i2", 2 * D).reshape(D, 2)
    align()
    names, refs, notes = take("<u4", E), take("<u4", E), take("<u4", E)
    kinds, srcs, sacs, fl = take("u1", E), take("u1", E), take("u1", E), take("u1", E)
    align()
    offs = take("<u4", K + 1)
    blob = raw[pos:pos + S]
    strs = [blob[offs[i]:offs[i + 1]].decode("utf-8") for i in range(K)]
    return {"epsg": epsg, "x0": x0, "y0": y0, "unit_mm": unit, "flags": flags,
            "nodes": nodes, "from": efrom, "to": eto, "dstart": dstart, "deltas": deltas,
            "name": names, "ref": refs, "note": notes, "kind": kinds, "src": srcs,
            "sac": sacs, "eflags": fl, "strings": strs}
