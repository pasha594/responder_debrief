"""Perennial streams and water for a routing AOI from the static NHD HU8
GeoPackages (the hydro.nationalmap.gov REST services time out; NHD itself is
frozen at its 2023-24 vintage, so per-HU8 extracts are cached forever).

Discovery goes through the TNM Access API. Titles read
"... for Hydrological Unit (HU) 8 - 17050111 ...", so an item is an HU8
GeoPackage when its title contains "(HU) 8" or its downloadURL contains
"_HU8_" — and prodFormats=GeoPackage keeps the national/state/HU4 products
(which the API lists first) from pushing HU8s past `max`.

Kept (trimmed, EPSG:4326, cached at work/nhd/v{NHD_TRIM_VERSION}/{huc8}.gpkg):
- streams: NHDFlowline fcode 46006 (perennial stream/river);
- water:   NHDWaterbody ftype 390 LakePond / 436 Reservoir minus the
           intermittent/ephemeral fcodes (dry playas are not barriers),
           plus NHDArea ftype 460 StreamRiver polygons.
"""

from __future__ import annotations

import re
import zipfile
from pathlib import Path

import httpx

from . import config, gdal_cli
from .b2 import Storage
from .http import download_to, get

CACHE_PREFIX = "work/nhd"
# In the cache key and in every bundle id: bump it whenever trim_huc8 keeps
# different layers, rows or fields. The cache is write-once, so without it a
# cached HU8 (in B2, or in a --keep-work dir) would keep the old trim forever.
NHD_TRIM_VERSION = 1
NON_PERENNIAL_WATERBODY = (39001, 39005, 39006, 43614)
_HU8_URL = re.compile(r"_(\d{8})_HU8_", re.I)


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


def trim_huc8(zip_path: Path, dest: Path) -> Path:
    """Full HU8 GeoPackage zip -> small GPKG with `streams` and `water`."""
    src = f"/vsizip/{zip_path}/{_inner_gpkg(zip_path)}"
    dest.unlink(missing_ok=True)
    gdal_cli.run(["ogr2ogr", "-f", "GPKG", str(dest), src, "NHDFlowline",
                  "-where", "fcode = 46006", "-dim", "XY", "-t_srs", "EPSG:4326",
                  "-nlt", "MULTILINESTRING", "-nln", "streams", "-select", "fcode"], timeout=600)
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


def rasterize(gpkgs: list[Path], *, epsg: int, bounds_utm, cell: float,
              bbox4326, workdir: Path) -> tuple[Path | None, Path | None]:
    """-> (streams.tif, water.tif) Byte 0/1 on the grid, or (None, None).
    Streams are burned all-touched so a line stays 8-connected (diagonal
    grid moves can't slip across); water uses cell centres so shores aren't
    over-blocked."""
    aoi = workdir / "aoi_hydro.gpkg"
    aoi.unlink(missing_ok=True)
    w, s, e, n = bbox4326
    have = {"streams": False, "water": False}
    for g in gpkgs:
        for layer in ("streams", "water"):
            cmd = ["ogr2ogr", "-f", "GPKG", str(aoi), str(g), layer, "-nln", layer,
                   "-spat", str(w), str(s), str(e), str(n), "-spat_srs", "EPSG:4326",
                   "-t_srs", f"EPSG:{epsg}"]
            if aoi.exists():
                cmd[1:1] = ["-update", "-append"]
            try:
                gdal_cli.run(cmd, timeout=300)
                have[layer] = True
            except gdal_cli.GdalError:
                continue  # layer absent/empty in this HU8
    xmin, ymin, xmax, ymax = bounds_utm
    outs = []
    for layer, at in (("streams", True), ("water", False)):
        if not have[layer]:
            outs.append(None)
            continue
        tif = workdir / f"nhd_{layer}.tif"
        cmd = ["gdal_rasterize", "-q", "-l", layer, "-burn", "1", "-init", "0", "-ot", "Byte",
               "-te", str(xmin), str(ymin), str(xmax), str(ymax), "-tr", str(cell), str(cell),
               "-a_srs", f"EPSG:{epsg}"]
        if at:
            cmd.append("-at")
        gdal_cli.run([*cmd, str(aoi), str(tif)], timeout=300)
        outs.append(tif)
    return outs[0], outs[1]
