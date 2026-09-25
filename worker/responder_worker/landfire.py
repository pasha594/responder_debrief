"""LANDFIRE rasters for one routing AOI, anonymously.

Primary: the lfps.usgs.gov ArcGIS ImageServers' exportImage, in EPSG:5070
with the request box snapped outward to the CONUS product grid (origin
-2362425, 3267405; 30 m) so the server returns grid-exact pixels instead of
resampling. Fallback: LANDFIRE's documented GeoServer WCS (identical pixels,
NoData 32767). The LFPS job API is never used: it requires sending an email
address to USGS.

Vegetation (EVT, EVC, FBFM40) is fetched for LF2025 and, where LF2025 is not
complete for the box (it covers only some GeoAreas until Nov 2026), LF2024;
cost_grid.mosaic_versions picks per pixel. Topography is LF2020 SlpD + Elev,
the grids GET v2 was calibrated on.
"""

from __future__ import annotations

import math
import time
from pathlib import Path

import httpx

from . import config, gdal_cli
from .http import download_to

VEG_PRODUCTS = ("EVT", "EVC", "FBFM40")
TOPO_PRODUCTS = ("SlpD", "Elev")
VEG_VERSIONS = ("LF2025", "LF2024")
REQUEST_GAP_S = 1.0


def snap_5070(bbox: tuple[float, float, float, float], pad_m: float = 60.0
              ) -> tuple[float, float, float, float]:
    """Pad and snap a 5070 box OUTWARD to the LANDFIRE 30 m grid."""
    x0, y0 = config.LANDFIRE_ORIGIN_X, config.LANDFIRE_ORIGIN_Y
    xmin = x0 + 30 * math.floor((bbox[0] - pad_m - x0) / 30)
    xmax = x0 + 30 * math.ceil((bbox[2] + pad_m - x0) / 30)
    ymax = y0 - 30 * math.floor((y0 - (bbox[3] + pad_m)) / 30)
    ymin = y0 - 30 * math.ceil((y0 - (bbox[1] - pad_m)) / 30)
    return (xmin, ymin, xmax, ymax)


def size_of(bbox) -> tuple[int, int]:
    return int(round((bbox[2] - bbox[0]) / 30)), int(round((bbox[3] - bbox[1]) / 30))


def service_path(product: str, version: str) -> str:
    if product in TOPO_PRODUCTS:
        return f"Landfire_Topo/LF2020_{product}_CONUS"
    return f"Landfire_{version}/{version}_{product}_CONUS"


def export_image_url(product: str, version: str, bbox) -> tuple[str, dict]:
    w, h = size_of(bbox)
    params = {
        "bbox": ",".join(f"{v:.0f}" for v in bbox), "bboxSR": "5070", "imageSR": "5070",
        "size": f"{w},{h}", "format": "tiff", "pixelType": "S16", "noData": "-9999",
        "interpolation": "RSP_NearestNeighbor", "compression": "LZ77", "f": "image",
    }
    return f"{config.LANDFIRE_IMAGESERVER}/{service_path(product, version)}/ImageServer/exportImage", params


def wcs_url(product: str, version: str, bbox) -> tuple[str, dict]:
    if product in TOPO_PRODUCTS:
        cov_set, cov = "conus_topo", f"landfire_wcs__LF2020_{product}_CONUS"
    else:
        cov_set, cov = f"conus_{version[2:]}", f"landfire_wcs__{version}_{product}_CONUS"
    # httpx would encode repeated subset= params fine, but the X(..) / Y(..)
    # parentheses must stay literal, so build the query by hand.
    q = (f"service=WCS&version=2.0.1&request=GetCoverage&coverageId={cov}"
         f"&subset=X({bbox[0]:.0f},{bbox[2]:.0f})&subset=Y({bbox[1]:.0f},{bbox[3]:.0f})"
         "&format=image/geotiff")
    return f"{config.LANDFIRE_WCS}/{cov_set}/wcs?{q}", {}


def _is_tiff(path: Path) -> bool:
    with open(path, "rb") as f:
        head = f.read(4)
    return head in (b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+")


def fetch_product(client: httpx.Client, product: str, version: str, bbox, dest: Path,
                  log=print) -> str:
    """Download one product to `dest`; -> 'exportImage' | 'wcs'. Raises if
    both channels fail. WCS NoData 32767 is left for cost_grid to treat as
    nodata (it accepts both sentinels)."""
    errors = []
    for via, builder in (("exportImage", export_image_url), ("wcs", wcs_url)):
        url, params = builder(product, version, bbox)
        try:
            download_to(client, url, dest, params=params or None, timeout=300)
            if not _is_tiff(dest):
                raise ValueError(f"not a GeoTIFF: {dest.read_bytes()[:120]!r}")
            inf = gdal_cli.info(dest)
            if tuple(inf["size"]) != size_of(bbox):
                raise ValueError(f"size {inf['size']} != {size_of(bbox)}")
            return via
        except Exception as exc:  # noqa: BLE001 — try the next channel
            errors.append(f"{via}: {str(exc)[:160]}")
            log(f"[landfire] {version} {product} via {via} failed: {str(exc)[:160]}")
        finally:
            time.sleep(REQUEST_GAP_S)
    raise RuntimeError(f"LANDFIRE {version} {product}: " + " | ".join(errors))


def fetch_all(client: httpx.Client, bbox5070, workdir: Path, *, log=print,
              need_lf2024=None) -> dict:
    """-> {"topo": {SlpD, Elev: path}, "LF2025": {EVT, EVC, FBFM40: path} | None,
           "LF2024": {...} | None, "via": set of channels}.

    `need_lf2024(paths25) -> bool` decides whether LF2025 left gaps (the
    caller warps and checks); by default LF2024 is fetched only if an LF2025
    product failed outright."""
    workdir.mkdir(parents=True, exist_ok=True)
    out: dict = {"topo": {}, "LF2025": None, "LF2024": None, "via": set()}
    for p in TOPO_PRODUCTS:
        dest = workdir / f"lf_{p}.tif"
        out["via"].add(fetch_product(client, p, "LF2020", bbox5070, dest, log=log))
        out["topo"][p] = dest
    got25 = {}
    try:
        for p in VEG_PRODUCTS:
            dest = workdir / f"lf25_{p}.tif"
            out["via"].add(fetch_product(client, p, "LF2025", bbox5070, dest, log=log))
            got25[p] = dest
        out["LF2025"] = got25
    except RuntimeError as exc:
        log(f"[landfire] LF2025 unavailable, using LF2024: {str(exc)[:160]}")
    if out["LF2025"] is None or (need_lf2024 and need_lf2024(out["LF2025"])):
        got24 = {}
        for p in VEG_PRODUCTS:
            dest = workdir / f"lf24_{p}.tif"
            out["via"].add(fetch_product(client, p, "LF2024", bbox5070, dest, log=log))
            got24[p] = dest
        out["LF2024"] = got24
    return out
