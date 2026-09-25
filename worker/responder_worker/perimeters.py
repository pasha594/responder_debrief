"""Latest fire perimeter for a routing AOI (bulk traffic -> the DEV fire API).

The perimeter index is `[{path, date}]`; the geometry is fetched by the
index item's `path` VERBATIM (CalFire indexes mix IRWIN- and UniqueId-keyed
paths, so a URL rebuilt from the fire id 404s). "Latest" means newest by
date — the routing area and avoidance follow where the fire is now, not the
map's timeline playhead.
"""

from __future__ import annotations

from datetime import datetime
from urllib.parse import quote

import httpx

from . import config
from .http import get


def _ts(item: dict) -> float:
    try:
        return datetime.fromisoformat(str(item.get("date")).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return float("-inf")


def latest_item(index: list[dict]) -> dict | None:
    items = [i for i in index or [] if isinstance(i, dict) and i.get("path")]
    return max(items, key=_ts) if items else None


def geometry_bbox(geom: dict) -> tuple[float, float, float, float] | None:
    xs: list[float] = []
    ys: list[float] = []

    def walk(c):
        if isinstance(c, (list, tuple)) and c and isinstance(c[0], (int, float)):
            xs.append(float(c[0]))
            ys.append(float(c[1]))
        elif isinstance(c, (list, tuple)):
            for cc in c:
                walk(cc)

    walk((geom or {}).get("coordinates"))
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def latest_perimeter(client: httpx.Client, cornea_id: str) -> dict | None:
    """-> {path, date, bbox, geometry} for the newest version, or None."""
    r = get(client, f"{config.FIRE_API_DEV}/fires/{quote(cornea_id, safe='')}/perimeters",
            timeout=30)
    item = latest_item(r.json() if isinstance(r.json(), list) else [])
    if item is None:
        return None
    feat = get(client, f"{config.FIRE_API_DEV}{item['path']}", timeout=60).json()
    geom = feat.get("geometry") if feat.get("type") == "Feature" else feat
    bbox = geometry_bbox(geom)
    if bbox is None:
        return None
    return {"path": item["path"], "date": item.get("date"), "bbox": bbox, "geometry": geom}
