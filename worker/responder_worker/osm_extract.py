"""OpenStreetMap roads/tracks/paths for routing AOIs: Geofabrik extracts +
apt osmium-tool + a stdlib OPL parser. Never Overpass (its policy caps
automated use far below one fire's worth of data per day).

Per shard and region:
  1. download the region PBF (US state leaf; California is norcal/socal),
     picked by intersecting the AOI box with index-v1.json polygons;
  2. `osmium tags-filter region.pbf w/highway` (one pass, much smaller);
  3. `osmium extract -c extracts.json -s complete_ways` — every fire of the
     region in one pass, whole ways kept so node ids stay exact;
  4. per fire `osmium cat -f opl` -> parse_opl (node ids + locations).

The dated Geofabrik filename behind the -latest redirect gives the OSM date
recorded in the bundle.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote

import httpx

from . import config, gdal_cli
from .http import download_to, get


# ---------------------------------------------------------------------------
# region choice (pure)
# ---------------------------------------------------------------------------

def us_leaf_regions(index: dict) -> list[dict]:
    """Geofabrik index features inside the US that have no children.

    The live index (2026-09-25) parents the states to "north-america", not
    to "us": a state is known by its "us/" id ("us/washington"), and
    California's children ("norcal", "socal") drop the prefix but have
    parent "us/california". So a region is in the US when it or an ancestor
    is "us" or has a "us/" id. "us" itself and the multi-state groupings
    ("us-west", "us-pacific", also leaves) are never picked."""
    feats = index.get("features") or []
    by_id = {f["properties"]["id"]: f for f in feats if f.get("properties", {}).get("id")}
    parents = {f["properties"].get("parent") for f in feats}

    def under_us(fid: str) -> bool:
        seen = set()
        while fid and fid not in seen:
            seen.add(fid)
            if fid == "us" or fid.startswith("us/"):
                return True
            fid = (by_id.get(fid) or {}).get("properties", {}).get("parent")
        return False

    out = []
    for fid, f in by_id.items():
        if fid == "us" or fid in parents or not under_us(fid):
            continue
        pbf = (f["properties"].get("urls") or {}).get("pbf")
        if pbf and f.get("geometry"):
            out.append({"id": fid, "pbf": pbf, "geometry": f["geometry"]})
    return out


def _rings(geom: dict):
    if geom["type"] == "Polygon":
        yield from geom["coordinates"]
    elif geom["type"] == "MultiPolygon":
        for poly in geom["coordinates"]:
            yield from poly


def _point_in_rings(x: float, y: float, geom: dict) -> bool:
    inside = False
    for ring in _rings(geom):
        n = len(ring)
        for i in range(n):
            x1, y1 = ring[i][0], ring[i][1]
            x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                inside = not inside
    return inside


def _seg_hits_rect(x1, y1, x2, y2, w, s, e, n) -> bool:
    # Liang–Barsky clip test
    dx, dy = x2 - x1, y2 - y1
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, x1 - w), (dx, e - x1), (-dy, y1 - s), (dy, n - y1)):
        if p == 0:
            if q < 0:
                return False
        else:
            t = q / p
            if p < 0:
                t0 = max(t0, t)
            else:
                t1 = min(t1, t)
            if t0 > t1:
                return False
    return True


def polygon_hits_rect(geom: dict, rect) -> bool:
    w, s, e, n = rect
    for ring in _rings(geom):
        for i in range(len(ring) - 1):
            if _seg_hits_rect(ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1], w, s, e, n):
                return True
    return _point_in_rings((w + e) / 2, (s + n) / 2, geom)


def regions_for_bbox(regions: list[dict], bbox4326) -> list[str]:
    return sorted(r["id"] for r in regions if polygon_hits_rect(r["geometry"], bbox4326))


def load_index(client: httpx.Client) -> dict:
    return get(client, config.GEOFABRIK_INDEX, timeout=120).json()


# ---------------------------------------------------------------------------
# extraction (osmium CLI)
# ---------------------------------------------------------------------------

_DATED = re.compile(r"-(\d{6})\.osm\.pbf$")


def osm_date_from_url(url: str) -> str | None:
    m = _DATED.search(url)
    if not m:
        return None
    return datetime.strptime(m.group(1), "%y%m%d").strftime("%Y-%m-%d")


def download_region(client: httpx.Client, region: dict, workdir: Path, log=print
                    ) -> tuple[Path, str | None]:
    dest = workdir / f"{region['id'].replace('/', '_')}.osm.pbf"
    resp = download_to(client, region["pbf"], dest, timeout=3600)
    # Geofabrik may redirect -latest to a dated file (the name is the
    # date) or serve it directly; Last-Modified covers the latter.
    date = osm_date_from_url(str(resp.url))
    if date is None and resp.headers.get("last-modified"):
        from email.utils import parsedate_to_datetime
        try:
            date = parsedate_to_datetime(resp.headers["last-modified"]).strftime("%Y-%m-%d")
        except (TypeError, ValueError):
            date = None
    log(f"[osm] {region['id']}: {dest.stat().st_size / 1e6:.0f} MB ({date})")
    return dest, date


def extract_fires(pbf: Path, fires: dict[str, tuple], workdir: Path, log=print) -> dict[str, Path]:
    """{fire_key: bbox4326} -> {fire_key: per-fire .osm.pbf} in two passes."""
    workdir.mkdir(parents=True, exist_ok=True)
    hw = workdir / (pbf.stem + "-hw.osm.pbf")
    gdal_cli.run(["osmium", "tags-filter", str(pbf), "w/highway", "-o", str(hw),
                  "--overwrite"], timeout=3600)
    outdir = workdir / "osm_extracts"
    outdir.mkdir(exist_ok=True)
    cfg = {"directory": str(outdir), "extracts": [
        {"output": f"{k}.osm.pbf", "output_format": "pbf", "bbox": list(b)}
        for k, b in fires.items()]}
    cfg_path = workdir / "extracts.json"
    cfg_path.write_text(json.dumps(cfg))
    gdal_cli.run(["osmium", "extract", "-c", str(cfg_path), "-s", "complete_ways",
                  str(hw), "--overwrite"], timeout=3600)
    hw.unlink(missing_ok=True)
    return {k: outdir / f"{k}.osm.pbf" for k in fires}


def to_opl(pbf: Path, dest: Path) -> Path:
    gdal_cli.run(["osmium", "cat", str(pbf), "-f", "opl,add_metadata=false", "-o",
                  str(dest), "--overwrite"], timeout=900)
    return dest


# ---------------------------------------------------------------------------
# OPL parser (pure)
# ---------------------------------------------------------------------------

_ESC = re.compile(r"%([0-9a-fA-F]+)%")


def _unescape(s: str) -> str:
    return _ESC.sub(lambda m: chr(int(m.group(1), 16)), s)


def _tags(field: str) -> dict:
    out = {}
    if not field:
        return out
    for kv in field.split(","):
        if "=" not in kv:
            continue
        k, v = kv.split("=", 1)
        out[_unescape(k)] = _unescape(v)
    return out


def parse_opl(lines) -> tuple[dict[int, tuple[float, float]], list[dict]]:
    """OPL lines -> ({node_id: (lon, lat)}, [{id, nodes, tags}])."""
    nodes: dict[int, tuple[float, float]] = {}
    ways: list[dict] = []
    for line in lines:
        line = line.rstrip("\n")
        if not line:
            continue
        kind = line[0]
        parts = line.split(" ")
        oid = int(parts[0][1:])
        fields = {p[0]: p[1:] for p in parts[1:] if p}
        if kind == "n":
            x, y = fields.get("x"), fields.get("y")
            if x and y:
                nodes[oid] = (float(x), float(y))
        elif kind == "w":
            refs = [int(r[1:]) for r in (fields.get("N") or "").split(",") if r.startswith("n")]
            ways.append({"id": oid, "nodes": refs, "tags": _tags(fields.get("T", ""))})
    return nodes, ways


def read_opl(path: Path):
    with open(path, encoding="utf-8") as f:
        return parse_opl(f)
