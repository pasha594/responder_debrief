"""Routing-bundle planning (pure): which fires to (re)build, their AOI grids,
priority, and region-affine shard assignment.

AOI (FINAL_PLAN.md §3): the latest perimeter's bbox (or the fire point), in
the fire's WGS84 UTM zone, + 8 km, at least 16 km a side, snapped to the
cell size. 30 m cells up to 6.25M cells (phone memory), else 60 m, else a
150 km centred clip. Hysteresis: while the previous grid still contains the
fire core + 2 km, the previous grid is reused exactly (no rebuild for a small
perimeter change); when it grows, the new grid is the union (never shrinks
under a pack someone downloaded).

Actions: build (new / recipe / aoi_changed / forced / retry), check (age:
the shard recomputes input hashes and rebuilds only if the bundle id
changes), skip, backoff (>= 3 failures, last < 24 h), unsupported (v1 is
CONUS only; AK/HI/PR need other LANDFIRE services).
"""

from __future__ import annotations

import hashlib
import math
import re
from datetime import datetime, timedelta

from . import config, utm


def fire_key(cornea_id: str) -> str:
    k = re.sub(r"[^0-9a-z-]", "", (cornea_id or "").lower())[:64]
    return k or hashlib.sha1((cornea_id or "").encode()).hexdigest()[:16]


def in_conus(point) -> bool:
    if not point:
        return False
    w, s, e, n = config.CONUS_BOUNDS
    return w <= point[0] <= e and s <= point[1] <= n


def _expand(b, d):
    return (b[0] - d, b[1] - d, b[2] + d, b[3] + d)


def _contains(outer, inner) -> bool:
    return outer[0] <= inner[0] and outer[1] <= inner[1] and outer[2] >= inner[2] and outer[3] >= inner[3]


def grid_bounds(g: dict) -> tuple[float, float, float, float]:
    return (g["x0"], g["y0"] - g["height"] * g["cell_m"], g["x0"] + g["width"] * g["cell_m"], g["y0"])


def aoi_for(point, perim_bbox, prev: dict | None = None) -> dict:
    """-> {epsg, zone, northern, grid:{x0,y0,cell_m,width,height}, bbox4326,
           clipped, source}. `prev` is the previous pointer's aoi block."""
    seed = perim_bbox or (point[0], point[1], point[0], point[1])
    cx, cy = (seed[0] + seed[2]) / 2, (seed[1] + seed[3]) / 2
    epsg = utm.epsg_for(cx, cy)
    if prev and prev.get("epsg"):
        epsg = prev["epsg"]  # keep a fire in one zone for its whole life
    zone, northern = utm.zone_of_epsg(epsg)
    core = utm.bbox_lonlat_to_utm(seed, zone, northern)
    if prev and prev.get("epsg") == epsg and prev.get("grid"):
        pb = grid_bounds(prev["grid"])
        if _contains(pb, _expand(core, config.ROUTING_GROWTH_HYSTERESIS_M)):
            return dict(prev, source="perimeter" if perim_bbox else "point")
    want = _expand(core, config.ROUTING_BUFFER_M)
    for axis in (0, 1):
        side = want[axis + 2] - want[axis]
        if side < config.ROUTING_MIN_SIDE_M:
            grow = (config.ROUTING_MIN_SIDE_M - side) / 2
            want = tuple(v - grow if i == axis else v + grow if i == axis + 2 else v
                         for i, v in enumerate(want))
    if prev and prev.get("epsg") == epsg and prev.get("grid"):
        pb = grid_bounds(prev["grid"])
        want = (min(want[0], pb[0]), min(want[1], pb[1]), max(want[2], pb[2]), max(want[3], pb[3]))
    cell = config.ROUTING_CELL_M
    clipped = False
    if (want[2] - want[0]) * (want[3] - want[1]) / cell ** 2 > config.ROUTING_MAX_CELLS:
        cell = cell * 2
    side_cap = min(config.ROUTING_MAX_SIDE_M, math.sqrt(config.ROUTING_MAX_CELLS) * cell)
    ccx, ccy = (core[0] + core[2]) / 2, (core[1] + core[3]) / 2
    if want[2] - want[0] > side_cap:
        want = (ccx - side_cap / 2, want[1], ccx + side_cap / 2, want[3])
        clipped = True
    if want[3] - want[1] > side_cap:
        want = (want[0], ccy - side_cap / 2, want[2], ccy + side_cap / 2)
        clipped = True
    x0 = math.floor(want[0] / cell) * cell
    y0 = math.ceil(want[3] / cell) * cell
    width = int(math.ceil((want[2] - x0) / cell))
    height = int(math.ceil((y0 - want[1]) / cell))
    grid = {"x0": float(x0), "y0": float(y0), "cell_m": cell, "width": width, "height": height}
    bbox4326 = utm.bbox_utm_to_lonlat(grid_bounds(grid), zone, northern)
    return {"epsg": epsg, "zone": zone, "northern": northern, "grid": grid,
            "bbox4326": [round(v, 6) for v in bbox4326], "clipped": clipped,
            "source": "perimeter" if perim_bbox else "point"}


def _parse(ts):
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def action_for(pointer: dict | None, fstate: dict | None, aoi: dict, now: datetime,
               force: bool = False) -> tuple[str, str]:
    fstate = fstate or {}
    last = _parse(fstate.get("last_attempt_at"))
    if (not force and (fstate.get("failures") or 0) >= config.ROUTING_BACKOFF_FAILURES
            and last and now - last < timedelta(hours=24)):
        return "backoff", "failures"
    if force:
        return "build", "forced"
    if not pointer:
        return "build", "retry" if fstate.get("failures") else "new"
    if pointer.get("recipe") != config.ROUTING_RECIPE:
        return "build", "recipe"
    pa = pointer.get("aoi") or {}
    if pa.get("epsg") != aoi["epsg"] or pa.get("grid") != aoi["grid"]:
        return "build", "aoi_changed"
    checked = _parse(fstate.get("checked_at") or pointer.get("built_at"))
    if checked is None or now - checked >= timedelta(days=config.ROUTING_CHECK_DAYS):
        return "check", "age"
    return "skip", "fresh"


def priority_order(entries: list[dict], priority_fires: list[str]) -> list[dict]:
    pri = {p.strip().lower() for p in priority_fires if p.strip()}

    def key(e):
        named = bool(pri & {str(e.get("slug") or "").lower(), str(e.get("name") or "").lower(),
                            str(e.get("cornea_id") or "").lower()})
        return (0 if named else 1, 0 if e.get("reason") == "new" else 1,
                -(float(e.get("acres") or 0)), e.get("cornea_id") or "")
    return sorted(entries, key=key)


def est_seconds(entry: dict) -> float:
    g = entry["aoi"]["grid"]
    return 30.0 + 12.0 * g["width"] * g["height"] / 1e6


def assign_shards(entries: list[dict], shards: int) -> list[list[dict]]:
    """Region-affine greedy packing: fires sharing a primary Geofabrik region
    go to one shard (one download per region per run), biggest groups first,
    each to the least-loaded shard; a group bigger than a fair share is split.
    Entries keep their priority order inside a shard."""
    shards = max(1, shards)
    order = {id(e): i for i, e in enumerate(entries)}
    groups: dict[str, list[dict]] = {}
    for e in entries:
        groups.setdefault((e.get("regions") or ["?"])[0], []).append(e)
    total = sum(est_seconds(e) for e in entries) or 1.0
    fair = total / shards
    chunks = []
    for region, es in groups.items():
        cur, cur_s = [], 0.0
        for e in es:
            if cur and cur_s + est_seconds(e) > fair * 1.1:
                chunks.append(cur)
                cur, cur_s = [], 0.0
            cur.append(e)
            cur_s += est_seconds(e)
        if cur:
            chunks.append(cur)
    chunks.sort(key=lambda c: -sum(est_seconds(e) for e in c))
    loads = [0.0] * shards
    out: list[list[dict]] = [[] for _ in range(shards)]
    for c in chunks:
        k = loads.index(min(loads))
        out[k].extend(c)
        loads[k] += sum(est_seconds(e) for e in c) + 60.0
    for lst in out:
        lst.sort(key=lambda e: order[id(e)])
    return out
