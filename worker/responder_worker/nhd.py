"""Perennial streams, rivers and water for a routing AOI from the static NHD
HU8 GeoPackages (the hydro.nationalmap.gov REST services time out; NHD itself
is frozen at its 2023-24 vintage, so per-HU8 extracts are cached forever),
plus the OSM rivers osm_extract.waterways finds.

Discovery goes through the TNM Access API. Titles read
"... for Hydrological Unit (HU) 8 - 17050111 ...", so an item is an HU8
GeoPackage when its title contains "(HU) 8" or its downloadURL contains
"_HU8_" — and prodFormats=GeoPackage keeps the national/state/HU4 products
(which the API lists first) from pushing HU8s past `max`.

Kept (trimmed, EPSG:4326, cached at work/nhd/v{NHD_TRIM_VERSION}/{huc8}.gpkg):
- streams: NHDFlowline fcode 46006 (perennial stream/river), plus the
           artificial paths through perennial water, with gnis_name and the
           Strahler streamorder of the HU8's own NHDFlowlineVAA table;
- water:   NHDWaterbody ftype 390 LakePond / 436 Reservoir minus the
           intermittent/ephemeral fcodes (dry playas are not barriers),
           plus NHDArea ftype 460 StreamRiver polygons.

Rivers vs creeks (hydro_grids). A flat x5 on every perennial flowline let
the router ford the Stehekin River 2.9 km from Harlequin Bridge and Agnes
Creek at Agnes Gorge (SISI, North Cascades). NHD draws neither as a
StreamRiver area and LANDFIRE maps neither channel as water, so size has to
come from the lines: a flowline is a RIVER, impassable off the road/trail
network, when its streamorder >= RIVER_ORDER (Agnes Creek 5, the lower
Stehekin 6), its name ends in "River", or OSM maps it as waterway=river or
canal (the upper Stehekin is order 4 in NHD but a river in OSM). Graph nodes
may sit on impassable cells, so bridges and fords on the network still
cross. Smaller perennial creeks stay crossable at GET's x5 (cost_grid).
"""

from __future__ import annotations

import json
import re
import zipfile
from pathlib import Path

import httpx
import numpy as np

from . import config, gdal_cli, utm
from .b2 import Storage
from .http import download_to, get
from .routing_plan import grid_bounds

CACHE_PREFIX = "work/nhd"
# In the cache key and in every bundle id: bump it whenever trim_huc8 keeps
# different layers, rows or fields. The cache is write-once, so without it a
# cached HU8 (in B2, or in a --keep-work dir) would keep the old trim forever.
# 2: streams keep gnis_name and the VAA streamorder, plus the artificial
#    paths through perennial water.
NHD_TRIM_VERSION = 2
NON_PERENNIAL_WATERBODY = (39001, 39005, 39006, 43614)
_HU8_URL = re.compile(r"_(\d{8})_HU8_", re.I)

# NHD HR (1:24k) Strahler order; HR counts about one order higher than the
# 1:100k NHDPlus. Order 4 (upper Stehekin, Company Creek mouth) stays a
# crossable creek unless OSM calls it a river.
RIVER_ORDER = 5
_RIVER_NAME = re.compile(r"\bRiver$")
# grid.tif band 3 holds a Byte stream-name id: 0 = none, k = names[k - 1].
MAX_NAMES = 255


class NhdUnavailable(RuntimeError):
    pass


def parse_products(doc: dict) -> list[dict]:
    """TNM products JSON -> [{huc8, url}] (HU8 GeoPackages only, deduped)."""
    out, seen = [], set()
    for it in doc.get("items") or []:
        title = it.get("title") or ""
        url = it.get("downloadURL") or ""
        fmt = (it.get("format") or "").lower()
        if "geopackage" not in fmt and not url.lower().endswith("_gpkg.zip"):
            continue
        m = _HU8_URL.search(url)
        if not ("(HU) 8" in title or m):
            continue
        huc = m.group(1) if m else (re.search(r"\(HU\) 8\D*(\d{8})", title) or [None, None])[1]
        if huc and huc not in seen:
            seen.add(huc)
            out.append({"huc8": huc, "url": url})
    return out


def huc8_for_bbox(client: httpx.Client, bbox4326) -> list[dict]:
    w, s, e, n = bbox4326
    params = {"datasets": config.NHD_DATASET, "bbox": f"{w},{s},{e},{n}",
              "prodFormats": "GeoPackage", "max": "200"}
    doc = get(client, config.TNM_PRODUCTS, params=params, timeout=90).json()
    items = parse_products(doc)
    total = int(doc.get("total") or 0)
    if total > len(doc.get("items") or []):
        raise NhdUnavailable(f"TNM returned {len(doc.get('items') or [])} of {total} products")
    return items


def _inner_gpkg(zip_path: Path) -> str:
    with zipfile.ZipFile(zip_path) as z:
        names = [n for n in z.namelist() if n.lower().endswith(".gpkg")]
    if not names:
        raise NhdUnavailable(f"no .gpkg in {zip_path.name}")
    return names[0]


def _streams_sql(src: str) -> str:
    """Perennial flowlines joined to their VAA stream order. Artificial
    paths (fcode 55800) through perennial water or a StreamRiver area come
    too: a river runs on through a pool as one, and the pool's polygon may
    be too narrow to burn a cell centre (Agnes Creek in Agnes Gorge), which
    would leave a gap in the wall. The geometry column is named in the
    SELECT (it is SHAPE in the HU8 packages); an HU8 without an
    NHDFlowlineVAA table keeps a NULL order."""
    info = gdal_cli.run(["ogrinfo", "-so", src, "NHDFlowline"], timeout=300).stdout
    m = re.search(r"^Geometry Column = (\S+)", info, re.M)
    geom = m.group(1) if m else "geom"
    layers = gdal_cli.run(["ogrinfo", "-q", src], timeout=300).stdout
    bad = ",".join(str(c) for c in NON_PERENNIAL_WATERBODY)
    where = ("f.fcode = 46006 OR (f.fcode = 55800 AND f.wbarea_permanent_identifier IN ("
             "SELECT permanent_identifier FROM NHDWaterbody "
             f"WHERE ftype IN (390, 436) AND fcode NOT IN ({bad}) "
             "UNION SELECT permanent_identifier FROM NHDArea WHERE ftype = 460))")
    if re.search(r"^\s*\d+: NHDFlowlineVAA\b", layers, re.M):
        return (f"SELECT f.{geom}, f.fcode, f.gnis_name, v.streamorder FROM NHDFlowline f "
                "LEFT JOIN NHDFlowlineVAA v ON v.permanent_identifier = f.permanent_identifier "
                f"WHERE {where}")
    return (f"SELECT f.{geom}, f.fcode, f.gnis_name, CAST(NULL AS INTEGER) AS streamorder "
            f"FROM NHDFlowline f WHERE {where}")


def trim_huc8(zip_path: Path, dest: Path) -> Path:
    """Full HU8 GeoPackage zip -> small GPKG with `streams` and `water`."""
    src = f"/vsizip/{zip_path}/{_inner_gpkg(zip_path)}"
    dest.unlink(missing_ok=True)
    gdal_cli.run(["ogr2ogr", "-f", "GPKG", str(dest), src, "-sql", _streams_sql(src),
                  "-dim", "XY", "-t_srs", "EPSG:4326", "-nlt", "MULTILINESTRING",
                  "-nln", "streams"], timeout=600)
    bad = ",".join(str(c) for c in NON_PERENNIAL_WATERBODY)
    gdal_cli.run(["ogr2ogr", "-update", "-f", "GPKG", str(dest), src, "NHDWaterbody",
                  "-where", f"ftype IN (390, 436) AND fcode NOT IN ({bad})", "-dim", "XY",
                  "-t_srs", "EPSG:4326", "-nlt", "MULTIPOLYGON", "-nln", "water",
                  "-select", "fcode"], timeout=600)
    gdal_cli.run(["ogr2ogr", "-update", "-append", "-f", "GPKG", str(dest), src, "NHDArea",
                  "-where", "ftype = 460", "-dim", "XY", "-t_srs", "EPSG:4326",
                  "-nlt", "MULTIPOLYGON", "-nln", "water"], timeout=600)
    # (no -select here: GDAL 3.8.4's ogr2ogr rejects -select with -append)
    return dest


def cache_key(huc8: str) -> str:
    return f"{CACHE_PREFIX}/v{NHD_TRIM_VERSION}/{huc8}.gpkg"


def ensure_huc8(client: httpx.Client, storage: Storage, item: dict, workdir: Path,
                log=print) -> Path:
    """Cached trimmed GPKG for one HU8 (downloads + trims on a cache miss)."""
    local = workdir / f"nhd_v{NHD_TRIM_VERSION}_{item['huc8']}.gpkg"
    key = cache_key(item["huc8"])
    if local.exists() or storage.get_file(key, local):
        return local
    z = workdir / f"nhd_{item['huc8']}.zip"
    download_to(client, item["url"], z, timeout=600)
    trim_huc8(z, local)
    z.unlink(missing_ok=True)
    storage.put_file(key, local)
    log(f"[nhd] cached HU8 {item['huc8']}")
    return local


# ---------------------------------------------------------------------------
# AOI rasters
# ---------------------------------------------------------------------------

def _read_lines(path: Path) -> list[tuple[dict, list]]:
    """GeoJSONSeq -> [(properties, [(lon, lat), ...])], one per line part."""
    out = []
    with open(path, encoding="utf-8") as f:
        for row in f:
            row = row.strip().lstrip("\x1e")
            if not row:
                continue
            ft = json.loads(row)
            g = ft.get("geometry") or {}
            parts = g.get("coordinates") or []
            if g.get("type") == "LineString":
                parts = [parts]
            for ln in parts:
                if len(ln) >= 2:
                    out.append((ft.get("properties") or {}, [(float(x), float(y)) for x, y, *_ in ln]))
    return out


def load_streams(gpkgs: list[Path], bbox4326, workdir: Path) -> list[tuple[dict, list]]:
    """Perennial flowlines touching the AOI box, lon/lat:
    [({"name", "order"}, [(lon, lat), ...])]."""
    w, s, e, n = bbox4326
    out = []
    for g in gpkgs:
        seq = workdir / f"{Path(g).stem}_streams.geojsonl"
        seq.unlink(missing_ok=True)
        try:
            gdal_cli.run(["ogr2ogr", "-f", "GeoJSONSeq", str(seq), str(g), "streams",
                          "-spat", str(w), str(s), str(e), str(n), "-spat_srs", "EPSG:4326",
                          "-lco", "COORDINATE_PRECISION=7"], timeout=300)
        except gdal_cli.GdalError:
            continue  # layer absent/empty in this HU8
        for p, ln in _read_lines(seq):
            order = p.get("streamorder")
            out.append(({"name": p.get("gnis_name") or None,
                         "order": int(order) if order is not None else None}, ln))
    return out


def is_river(props: dict) -> bool:
    """An NHD flowline too big to wade (see the module docstring)."""
    return (props.get("order") or 0) >= RIVER_ORDER or bool(
        _RIVER_NAME.search(props.get("name") or ""))


def _line_cells(xy: np.ndarray, grid: dict) -> tuple[np.ndarray, np.ndarray]:
    """(rows, cols) of the cells a UTM polyline passes through, 4-connected
    like gdal_rasterize -at: samples every cell/8, plus both side cells
    wherever consecutive samples step diagonally (a pass by a cell corner).
    A 4-connected line is a wall for 8-neighbour moves."""
    cell = grid["cell_m"]
    a, b = xy[:-1], xy[1:]
    n = np.maximum(1, np.ceil(np.hypot(*(b - a).T) / (cell / 8)).astype(np.int64))
    seg = np.repeat(np.arange(len(a)), n)
    t = (np.arange(n.sum()) - np.repeat(np.cumsum(n) - n, n)) / np.repeat(n, n)
    p = np.vstack([a[seg] + (b - a)[seg] * t[:, None], xy[-1:]])
    c = np.floor((p[:, 0] - grid["x0"]) / cell).astype(np.int64)
    r = np.floor((grid["y0"] - p[:, 1]) / cell).astype(np.int64)
    diag = (np.diff(r) != 0) & (np.diff(c) != 0)
    r = np.concatenate([r, r[:-1][diag], r[1:][diag]])
    c = np.concatenate([c, c[1:][diag], c[:-1][diag]])
    ok = (r >= 0) & (r < grid["height"]) & (c >= 0) & (c < grid["width"])
    return r[ok], c[ok]


def burn_lines(lines: list[tuple[dict, np.ndarray]], grid: dict) -> dict:
    """UTM lines [({"name", "river"}, xy (k,2))] -> the line rasters:
    streams (every perennial line), rivers (the impassable ones), stream_id
    (Byte name id per cell, grid.tif band 3) and names (id k -> names[k-1]).

    Ids go to names in priority order (a river first, then the longest
    inside the AOI), so if an AOI has more than MAX_NAMES named streams the
    small ones lose their name (truncated=True), never a river. Where two
    named lines share a cell the higher priority burns last and wins."""
    shape = (grid["height"], grid["width"])
    streams = np.zeros(shape, bool)
    rivers = np.zeros(shape, bool)
    cells = [_line_cells(xy, grid) if len(xy) >= 2 else (np.zeros(0, int),) * 2
             for _, xy in lines]
    rank: dict[str, list] = {}
    for (props, xy), (r, c) in zip(lines, cells):
        streams[r, c] = True
        if props.get("river"):
            rivers[r, c] = True
        name = props.get("name")
        if name and len(r):
            k = rank.setdefault(name, [False, 0])
            k[0] = k[0] or bool(props.get("river"))
            k[1] += len(r)  # cells inside the grid
    order = sorted(rank, key=lambda nm: (not rank[nm][0], -rank[nm][1], nm))
    names = order[:MAX_NAMES]
    ids = {nm: i + 1 for i, nm in enumerate(names)}
    stream_id = np.zeros(shape, np.uint8)
    burn = [(ids[p["name"]], rc) for (p, _), rc in zip(lines, cells) if p.get("name") in ids]
    for nid, (r, c) in sorted(burn, key=lambda t: -t[0]):  # lowest priority first
        stream_id[r, c] = nid
    return {"streams": streams, "rivers": rivers, "stream_id": stream_id, "names": names,
            "truncated": len(order) > MAX_NAMES}


def rasterize_water(gpkgs: list[Path], *, epsg: int, bounds_utm, cell: float, bbox4326,
                    workdir: Path, extra: Path | None = None) -> Path | None:
    """NHD water polygons (+ `extra`, a lon/lat FeatureCollection of OSM
    river areas) -> water.tif Byte 0/1 on the grid, or None. Burned at cell
    centres so shores aren't over-blocked."""
    aoi = workdir / "aoi_hydro.gpkg"
    aoi.unlink(missing_ok=True)
    w, s, e, n = bbox4326
    srcs = [[str(g), "water"] for g in gpkgs]
    if extra is not None:
        srcs.append([*gdal_cli.GEOJSON_AS_WRITTEN, str(extra)])
    have = False
    for src in srcs:
        cmd = ["ogr2ogr", "-f", "GPKG", str(aoi), *src, "-nln", "water", "-nlt", "MULTIPOLYGON",
               "-spat", str(w), str(s), str(e), str(n), "-spat_srs", "EPSG:4326",
               "-t_srs", f"EPSG:{epsg}"]
        if aoi.exists():
            cmd[1:1] = ["-update", "-append"]
        try:
            gdal_cli.run(cmd, timeout=300)
            have = True
        except gdal_cli.GdalError:
            continue  # layer absent/empty in this HU8
    if not have:
        return None
    xmin, ymin, xmax, ymax = bounds_utm
    tif = workdir / "nhd_water.tif"
    gdal_cli.run(["gdal_rasterize", "-q", "-l", "water", "-burn", "1", "-init", "0", "-ot", "Byte",
                  "-te", str(xmin), str(ymin), str(xmax), str(ymax), "-tr", str(cell), str(cell),
                  "-a_srs", f"EPSG:{epsg}", str(aoi), str(tif)], timeout=300)
    return tif


def hydro_grids(gpkgs: list[Path], aoi: dict, workdir: Path, *,
                osm_rivers: list | None = None, osm_areas: list | None = None) -> dict:
    """The AOI's hydro rasters on the fire grid: {"streams", "rivers",
    "water" (bool), "stream_id" (u8), "names", "truncated"}.

    NHD perennial flowlines and OSM rivers ([(props, [(lon, lat)...])] from
    osm_extract.waterways) are burned in numpy; NHD water and OSM river
    areas through gdal_rasterize."""
    g = aoi["grid"]
    zone, northern = aoi["zone"], aoi["northern"]
    lines = []
    for p, ln in load_streams(gpkgs, aoi["bbox4326"], workdir):
        lines.append(({"name": p["name"], "river": is_river(p)}, ln))
    for p, ln in osm_rivers or []:
        lines.append(({"name": p.get("name"), "river": True}, ln))
    utm_lines = []
    for p, ln in lines:
        a = np.asarray(ln, dtype=np.float64)
        xs, ys = utm.fwd(a[:, 0], a[:, 1], zone, northern)
        utm_lines.append((p, np.column_stack([np.atleast_1d(xs), np.atleast_1d(ys)])))
    out = burn_lines(utm_lines, g)
    extra = None
    if osm_areas:
        extra = workdir / "osm_river_areas.geojson"
        with gdal_cli.FeatureCollectionWriter(extra) as f:
            for p, ring in osm_areas:
                f.write({"type": "Feature", "properties": {"name": p.get("name")},
                         "geometry": {"type": "Polygon", "coordinates": [ring]}})
    tif = rasterize_water(gpkgs, epsg=aoi["epsg"], bounds_utm=grid_bounds(g), cell=g["cell_m"],
                          bbox4326=aoi["bbox4326"], workdir=workdir, extra=extra)
    water = np.zeros((g["height"], g["width"]), bool)
    if tif is not None:
        water = gdal_cli.read_raster(tif, workdir / "envi_nhd")[0][0] > 0
    out["water"] = water
    return out
