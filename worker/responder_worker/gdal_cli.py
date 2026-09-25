"""GDAL through the CLI only (the worker's rule: no osgeo bindings under uv),
plus numpy raster I/O that goes through GDAL's raw ENVI format.

`read_raster` asks gdal_translate for ENVI (headerless BSQ bytes plus a .hdr)
and memory-maps the bytes with numpy; `write_raster` does the reverse by
writing raw BSQ bytes and a VRTRawRasterBand wrapper, then gdal_translate to a
compressed GeoTIFF. The georef travels as an explicit (epsg, geotransform) pair
so nothing depends on parsing WKT.

Used by the trails build and the per-fire routing bundles (GDAL 3.8.4 on the
ubuntu-24.04 runner). Never use it to READ a PMTiles file: GDAL 3.8.4 rejects
some valid archives (bug #9288); pmtiles_inspect.py reads them instead.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np


class GdalError(RuntimeError):
    """A GDAL tool failed; the message carries its last stderr line."""


def which(tool: str) -> str | None:
    path = shutil.which(tool)
    if path is None and tool.endswith(".py"):  # some distros drop the .py
        path = shutil.which(tool[:-3])
    return path


def missing(tools) -> list[str]:
    return [t for t in tools if which(t) is None]


def run(cmd: list[str], *, timeout: float = 600, env: dict | None = None,
        cwd: Path | None = None) -> subprocess.CompletedProcess:
    """Run a CLI tool; raise GdalError('<tool> failed: <last stderr line>')."""
    tool = which(cmd[0]) or cmd[0]
    full_env = None
    if env:
        full_env = dict(os.environ)
        full_env.update(env)
    try:
        return subprocess.run([tool, *cmd[1:]], check=True, capture_output=True,
                              text=True, timeout=timeout, env=full_env, cwd=cwd)
    except subprocess.CalledProcessError as exc:
        lines = [ln for ln in (exc.stderr or "").strip().splitlines() if ln.strip()]
        tail = (lines[-1] if lines else "(no stderr)")[:300]
        raise GdalError(f"{Path(cmd[0]).name} failed: {tail}") from exc
    except subprocess.TimeoutExpired as exc:
        raise GdalError(f"{Path(cmd[0]).name} timed out after {timeout:.0f}s") from exc


def version() -> str | None:
    if which("gdalinfo") is None:
        return None
    out = run(["gdalinfo", "--version"], timeout=30).stdout
    m = re.search(r"GDAL (\d+\.\d+\.\d+)", out)
    return m.group(1) if m else out.strip()


def drivers(kind: str = "vector") -> set[str]:
    """Short driver names known to ogrinfo (vector) or gdalinfo (raster)."""
    tool = "ogrinfo" if kind == "vector" else "gdalinfo"
    if which(tool) is None:
        return set()
    out = run([tool, "--formats"], timeout=30).stdout
    return {m.group(1) for m in re.finditer(r"^\s+(\S+)\s+-", out, re.M)}


def info(path: Path) -> dict:
    return json.loads(run(["gdalinfo", "-json", str(path)], timeout=120).stdout)


# ---------------------------------------------------------------------------
# Raster I/O
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Georef:
    """North-up grid: top-left (x0, y0), square-or-not pixel (dx, dy>0)."""
    epsg: int
    x0: float
    y0: float
    dx: float
    dy: float
    width: int
    height: int

    @property
    def geotransform(self) -> list[float]:
        return [self.x0, self.dx, 0.0, self.y0, 0.0, -self.dy]

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        """(xmin, ymin, xmax, ymax)"""
        return (self.x0, self.y0 - self.height * self.dy,
                self.x0 + self.width * self.dx, self.y0)


_ENVI_TYPES = {1: np.uint8, 2: np.int16, 3: np.int32, 4: np.float32,
               5: np.float64, 12: np.uint16, 13: np.uint32}
_VRT_TYPES = {np.dtype(np.uint8): "Byte", np.dtype(np.int16): "Int16",
              np.dtype(np.uint16): "UInt16", np.dtype(np.int32): "Int32",
              np.dtype(np.uint32): "UInt32", np.dtype(np.float32): "Float32",
              np.dtype(np.float64): "Float64"}


def _epsg_of(inf: dict) -> int | None:
    wkt = (inf.get("coordinateSystem") or {}).get("wkt") or ""
    ids = re.findall(r'ID\["EPSG",(\d+)\]', wkt)
    if ids:
        return int(ids[-1])  # the outermost (CRS) id is last in WKT2
    m = re.findall(r'AUTHORITY\["EPSG","(\d+)"\]', wkt)
    return int(m[-1]) if m else None


def read_raster(path: Path, workdir: Path, *, bands: list[int] | None = None
                ) -> tuple[np.ndarray, Georef, list[float | None]]:
    """Read a raster into (array[bands, h, w], georef, nodata per band)."""
    inf = info(path)
    w, h = inf["size"]
    gt = inf["geoTransform"]
    band_info = inf["bands"]
    idx = bands or list(range(1, len(band_info) + 1))
    workdir.mkdir(parents=True, exist_ok=True)
    out = workdir / f"{Path(path).stem}.envi"
    cmd = ["gdal_translate", "-q", "-of", "ENVI", "-co", "INTERLEAVE=BSQ"]
    for b in idx:
        cmd += ["-b", str(b)]
    run([*cmd, str(path), str(out)])
    hdr = out.with_suffix(".hdr")
    if not hdr.exists():
        hdr = Path(str(out) + ".hdr")
    text = hdr.read_text()
    dtype = _ENVI_TYPES[int(re.search(r"data type\s*=\s*(\d+)", text).group(1))]
    order = int((re.search(r"byte order\s*=\s*(\d)", text) or [0, "0"])[1])
    arr = np.fromfile(out, dtype=np.dtype(dtype).newbyteorder(">" if order else "<"))
    arr = arr.reshape(len(idx), h, w).astype(dtype, copy=False)
    nodata = [band_info[b - 1].get("noDataValue") for b in idx]
    geo = Georef(_epsg_of(inf) or 0, gt[0], gt[3], gt[1], -gt[5], w, h)
    return arr, geo, nodata


def write_raster(arr: np.ndarray, geo: Georef, dest: Path, *,
                 creation: list[str] | None = None, nodata: float | None = None,
                 band_names: list[str] | None = None,
                 metadata: dict[str, str] | None = None) -> Path:
    """Write array[bands, h, w] (or [h, w]) as a GeoTIFF via raw BSQ + VRT."""
    a = arr if arr.ndim == 3 else arr[None, ...]
    a = np.ascontiguousarray(a, dtype=a.dtype.newbyteorder("<"))
    nb, h, w = a.shape
    if (w, h) != (geo.width, geo.height):
        raise ValueError(f"array {w}x{h} != georef {geo.width}x{geo.height}")
    dest = Path(dest)
    raw = dest.with_suffix(".bin")
    a.tofile(raw)
    vt = _VRT_TYPES[np.dtype(a.dtype.newbyteorder("="))]
    item = a.dtype.itemsize
    gt = ", ".join(repr(float(v)) for v in geo.geotransform)
    parts = [f'<VRTDataset rasterXSize="{w}" rasterYSize="{h}">',
             f"<SRS>EPSG:{geo.epsg}</SRS>", f"<GeoTransform>{gt}</GeoTransform>"]
    for i in range(nb):
        parts.append(f'<VRTRasterBand dataType="{vt}" band="{i + 1}" subClass="VRTRawRasterBand">')
        if band_names:
            parts.append(f"<Description>{band_names[i]}</Description>")
        if nodata is not None:
            parts.append(f"<NoDataValue>{nodata}</NoDataValue>")
        parts.append(f'<SourceFilename relativeToVRT="1">{raw.name}</SourceFilename>'
                     f"<ImageOffset>{i * w * h * item}</ImageOffset>"
                     f"<PixelOffset>{item}</PixelOffset><LineOffset>{w * item}</LineOffset>"
                     "<ByteOrder>LSB</ByteOrder></VRTRasterBand>")
    parts.append("</VRTDataset>")
    vrt = dest.with_suffix(".vrt")
    vrt.write_text("".join(parts))
    cmd = ["gdal_translate", "-q", "-of", "GTiff"]
    for co in creation or ["COMPRESS=DEFLATE", "ZLEVEL=9", "TILED=YES"]:
        cmd += ["-co", co]
    for k, v in (metadata or {}).items():
        cmd += ["-mo", f"{k}={v}"]
    run([*cmd, str(vrt), str(dest)])
    raw.unlink(missing_ok=True)
    vrt.unlink(missing_ok=True)
    return dest


def transform_points(points: list[tuple[float, float]], src_epsg: int,
                     dst_epsg: int) -> list[tuple[float, float]]:
    """Batch-project points with gdaltransform (PROJ does the math)."""
    text = "\n".join(f"{x!r} {y!r}" for x, y in points) + "\n"
    tool = which("gdaltransform")
    if tool is None:
        raise GdalError("gdaltransform not on PATH")
    try:
        out = subprocess.run([tool, "-s_srs", f"EPSG:{src_epsg}", "-t_srs",
                              f"EPSG:{dst_epsg}", "-output_xy"], input=text,
                             capture_output=True, text=True, check=True, timeout=60).stdout
    except subprocess.CalledProcessError as exc:
        raise GdalError(f"gdaltransform failed: {(exc.stderr or '').strip()[-300:]}") from exc
    res = []
    for line in out.strip().splitlines():
        xs = line.split()
        res.append((float(xs[0]), float(xs[1])))
    if len(res) != len(points):
        raise GdalError("gdaltransform returned a different point count")
    return res
