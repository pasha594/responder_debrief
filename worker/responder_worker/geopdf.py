"""GeoPDF pipeline: georef detection, neatline crop, XYZ tiling, previews.

GDAL is used exclusively via subprocess CLI (gdalinfo -json, gdal_translate,
gdalwarp, gdal2tiles.py) — no Python bindings.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from . import config, graticule

WEBMERC_TOP_RES = 156543.03392804097  # m/px at z0


class GdalNotAvailable(RuntimeError):
    pass


def gdal_available() -> bool:
    return all(shutil.which(t) for t in ("gdalinfo", "gdal_translate", "gdalwarp"))


def sha16(path: Path) -> str:
    """sha256(pdf)[:16] — the content-addressed, immutable asset id."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def _run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def gdalinfo_json(path: Path, *, dpi: int = 72, page: int = 1) -> dict:
    if shutil.which("gdalinfo") is None:
        raise GdalNotAvailable("gdalinfo not on PATH")
    cmd = [
        "gdalinfo", "-json",
        "--config", "GDAL_PDF_DPI", str(dpi),
        "--config", "GDAL_PDF_PAGE", str(page),
        str(path),
    ]
    return json.loads(_run(cmd).stdout)


def is_georeferenced(info: dict) -> bool:
    """Non-identity geoTransform + a coordinate system WKT."""
    gt = info.get("geoTransform")
    wkt = (info.get("coordinateSystem") or {}).get("wkt")
    if not gt or not wkt:
        return False
    identity = [0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
    return [round(v, 9) for v in gt] != identity


def projection_name(info: dict) -> str | None:
    wkt = (info.get("coordinateSystem") or {}).get("wkt") or ""
    m = re.search(r'^\s*PROJCRS\[\"([^\"]+)\"', wkt) or re.search(r'PROJCS\[\"([^\"]+)\"', wkt)
    return m.group(1) if m else None


def neatline_wkt(info: dict) -> str | None:
    md = info.get("metadata") or {}
    for domain in md.values():
        if isinstance(domain, dict) and "NEATLINE" in domain:
            return domain["NEATLINE"]
    return None


def neatline_geojson(wkt: str, crs_wkt: str | None, out_path: Path) -> Path:
    """POLYGON WKT (map coords) -> GeoJSON cutline file for gdalwarp."""
    coords_txt = re.search(r"\(\(\s*(.+?)\s*\)\)", wkt, re.S)
    if not coords_txt:
        raise ValueError(f"unparseable NEATLINE: {wkt[:80]}")
    ring = []
    for pair in coords_txt.group(1).split(","):
        x, y = pair.split()[:2]
        ring.append([float(x), float(y)])
    fc = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {},
            "geometry": {"type": "Polygon", "coordinates": [ring]},
        }],
    }
    out_path.write_text(json.dumps(fc))
    return out_path


def dpi_for_sheet(sheet: str | None) -> int:
    """8x11/11x17 -> 300; arch_c/d -> 200; arch_e -> 150; default 200."""
    if sheet:
        key = sheet.lower().replace(".", "")
        if key in config.SHEET_DPI:
            return config.SHEET_DPI[key]
    return config.DEFAULT_DPI


def zoom_range(native_res_m_per_px: float) -> tuple[int, int]:
    zmax = int(math.floor(math.log2(WEBMERC_TOP_RES / native_res_m_per_px)))
    zmax = max(10, min(16, zmax))
    return zmax - 6, zmax


def page_count(pdf_path: Path) -> int:
    try:
        from pypdf import PdfReader

        return len(PdfReader(str(pdf_path)).pages)
    except Exception:
        return 1


def bounds_4326(info: dict) -> list[float] | None:
    """[w, s, e, n] from gdalinfo wgs84Extent (or cornerCoordinates fallback)."""
    ext = info.get("wgs84Extent")
    if ext and ext.get("coordinates"):
        ring = ext["coordinates"][0]
        lons = [p[0] for p in ring]
        lats = [p[1] for p in ring]
        return [min(lons), min(lats), max(lons), max(lats)]
    return None


def render_preview(pdf_path: Path, out_png: Path, *, dpi: int = 72,
                   width: int = 480, page: int = 1) -> Path:
    out_png.parent.mkdir(parents=True, exist_ok=True)
    _run([
        "gdal_translate", "-q", "-of", "PNG", "-outsize", str(width), "0",
        "--config", "GDAL_PDF_DPI", str(dpi),
        "--config", "GDAL_PDF_PAGE", str(page),
        str(pdf_path), str(out_png),
    ])
    for aux in (out_png.with_suffix(".png.aux.xml"),):
        aux.unlink(missing_ok=True)
    return out_png


def probe_pdf(pdf_path: Path) -> dict:
    """CHEAP pass: is this sheet georeferenced, and in what projection?

    Only gdalinfo (~1 s) — no rendering, no warping, no tiling. Every mirrored
    PDF gets this on every run, so the manifest always knows whether a sheet is
    overlayable, even when the expensive tiling step is deferred. Without it,
    un-tiled sheets were indistinguishable from non-georeferenced ones and the
    UI could only say "processing…" for both.
    """
    pdf_path = Path(pdf_path)
    out: dict = {
        "id": sha16(pdf_path),
        "georeferenced": False,
        "projection": None,
        "pages": 1,
        "tiles": None,
    }
    if not gdal_available():
        out["error"] = "gdal unavailable"
        return out
    try:
        out["pages"] = page_count(pdf_path)
        info = gdalinfo_json(pdf_path)
        if is_georeferenced(info):
            out["georeferenced"] = True
            out["projection"] = projection_name(info)
        else:
            # No embedded georef — many sheets still carry their graticule
            # labels as vector text, which pins them down to ~0.005 deg.
            fit = graticule.solve(pdf_path)
            if fit:
                out["georeferenced"] = True
                out["projection"] = f"Graticule fit (±{fit.rms_max:.3f}°)"
    except Exception as exc:  # never fatal — degrade to "not georeferenced"
        out["error"] = f"probe failed: {exc}"
    return out


def process_pdf(pdf_path: Path, tiles_out_dir: Path, *, sheet: str | None = None,
                zoom_cap: int | None = None) -> dict:
    """Full pipeline for one PDF. Returns a manifest fragment:

    {id, georeferenced, projection, pages, tiles: {minzoom, maxzoom, bounds} | None,
     error?}. Never raises for degradable failures.
    """
    pdf_path = Path(pdf_path)
    result: dict = {
        "id": sha16(pdf_path),
        "georeferenced": False,
        "projection": None,
        "pages": 1,
        "tiles": None,
    }
    if not gdal_available():
        result["error"] = "gdal unavailable"
        return result

    try:
        result["pages"] = page_count(pdf_path)
        info = gdalinfo_json(pdf_path)
        native = is_georeferenced(info)
        grat_fit = None if native else graticule.solve(pdf_path)
        if not native and grat_fit is None:
            return result
        result["georeferenced"] = True
        result["projection"] = (
            projection_name(info) if native
            else f"Graticule fit (±{grat_fit.rms_max:.3f}°)"
        )

        dpi = dpi_for_sheet(sheet)
        with tempfile.TemporaryDirectory(prefix="geopdf_") as tmp:
            tmpd = Path(tmp)
            page_tif = tmpd / "page.tif"
            merc_tif = tmpd / "merc.tif"
            _run([
                "gdal_translate", "-q", "-of", "GTiff",
                "--config", "GDAL_PDF_DPI", str(dpi),
                "--config", "GDAL_PDF_PAGE", "1",
                str(pdf_path), str(page_tif),
            ])

            warp = ["gdalwarp", "-q", "-t_srs", "EPSG:3857", "-r", "bilinear", "-dstalpha"]
            if grat_fit is not None:
                # Assign the graticule GCPs (page points -> raster pixels at
                # dpi/72) and crop the warp to the map frame, which drops the
                # title-block collar the way the native neatline path does.
                px = dpi / 72.0
                gcp_tif = tmpd / "gcp.tif"
                gcp_args: list[str] = []
                for x_pt, y_pt, lon, lat in grat_fit.gcps_points():
                    gcp_args += ["-gcp", repr(x_pt * px), repr(y_pt * px),
                                 repr(lon), repr(lat)]
                _run(["gdal_translate", "-q", "-a_srs", "EPSG:4326",
                      *gcp_args, str(page_tif), str(gcp_tif)])
                from . import frames as _frames
                te = _frames.bounds4326_to_3857(list(grat_fit.frame_bounds_4326()))
                _run(warp + ["-te", *(repr(float(v)) for v in te),
                             str(gcp_tif), str(merc_tif)])
            else:
                nl = neatline_wkt(info)
                cutline = None
                if nl:
                    try:
                        cutline = neatline_geojson(nl, None, tmpd / "neatline.json")
                    except ValueError:
                        cutline = None
                try:
                    cmd = list(warp)
                    if cutline:
                        # cutline is in the source SRS (map coords)
                        cmd += ["-cutline", str(cutline), "-crop_to_cutline"]
                    _run(cmd + [str(page_tif), str(merc_tif)])
                except subprocess.CalledProcessError:
                    # fallback chain: warp without cutline
                    merc_tif.unlink(missing_ok=True)
                    _run(warp + [str(page_tif), str(merc_tif)])

            merc_info = gdalinfo_json(merc_tif)
            native_res = abs(merc_info["geoTransform"][1])
            zmin, zmax = zoom_range(native_res)
            if zoom_cap is not None:
                zmax = min(zmax, zoom_cap)
                zmin = min(zmin, zmax)
            bounds = bounds_4326(merc_info)

            tiler = shutil.which("gdal2tiles.py") or shutil.which("gdal2tiles")
            if tiler is None:
                result["error"] = "gdal2tiles unavailable"
                return result
            tiles_out_dir.mkdir(parents=True, exist_ok=True)
            _run([
                tiler, "--xyz", "--profile=mercator", "-r", "bilinear",
                "-w", "none", "--processes=4",  # no -x: sparse pyramids 404 under maplibre
                "-z", f"{zmin}-{zmax}", str(merc_tif), str(tiles_out_dir),
            ])
            result["tiles"] = {"minzoom": zmin, "maxzoom": zmax, "bounds": bounds}
        return result
    except (subprocess.CalledProcessError, OSError, KeyError, ValueError) as exc:
        msg = str(exc)
        if isinstance(exc, subprocess.CalledProcessError) and exc.stderr:
            msg = exc.stderr.strip().splitlines()[-1][:300]
        result["error"] = msg
        result["tiles"] = None
        return result
