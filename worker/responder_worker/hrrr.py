"""NOAA HRRR weather pipeline: AWS bucket -> CONUS product PNGs on B2.

Replaces the pyrecast gs01 weather frames (docs/spec-hrrr.md). Per forecast
hour and product: idx sidecar parse -> byte-range GET of exactly the GRIB2
message(s) needed -> gdalwarp to EPSG:3857 CONUS 2560px -> gdal_calc.py unit
conversion / wind-speed derivation -> gdaldem color-relief (interpolated,
alpha) -> PNG under frames/weather/{workspace}/{product}/{epoch_ms}.png.
Alongside each ws PNG, the same warped U/V bands are downsampled into a
coarse row-major grid JSON (frames/weather/{workspace}/wind_uv/{epoch_ms}
.json) that the frontend uses to draw wind direction arrows.

All GDAL work is CLI subprocess (gdal-bin + python3-gdal / brew gdal), no
Python bindings. HRRR is public + anonymous: plain httpx GETs, no boto3.
Incremental + deadline-guarded exactly like frames.py: storage.exists skips,
frames.start_deadline/deadline_passed shared wall clock, the sync image
budget counts HRRR images too. Workspace state lives in state.json under the
'hrrr' section: {workspace: {"done": bool, "fetched": N}} — "done" only once
the cycle's full hour range (f00-f18 / f00-f48) is rendered.
"""

from __future__ import annotations

import json
import math
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode

import httpx
from lxml import etree

from . import config, frames
from .b2 import Storage
from .http import get

HRRR_BUCKET = "https://noaa-hrrr-bdp-pds.s3.amazonaws.com"
S3_NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"

# Manifest path template (contract with the frontend — unchanged shape)
WEATHER_IMAGE_TEMPLATE = "/frames/weather/{ws}/{product}/{epoch_ms}.png"

# Coarse U/V grid JSON per forecast hour, produced alongside the ws PNG (the
# same warped UGRD/VGRD bands). The frontend draws wind ARROWS from these raw
# m/s values whenever a wind layer (ws/wg) is visible — this replaces the old
# 'wd' direction raster, which is retired (already-uploaded wd PNGs are
# harmless orphans).
WIND_UV_TEMPLATE = "/frames/weather/{ws}/wind_uv/{epoch_ms}.json"
# 144 columns ~= 32 km cells: the frontend bilinearly densifies arrows when
# zoomed in, so finer cells feed it real local variation (~100 KB/hour JSON).
WIND_UV_NX = 144

# ---------------------------------------------------------------------------
# Products: EXACT idx record matching + gdal_calc conversion expressions.
# A/B refer to warped band 1/2 (band order == the "records" order below).
# ---------------------------------------------------------------------------

PRODUCTS: dict[str, dict] = {
    "ws": {
        "label": "Wind speed", "units": "mph",
        "records": [("UGRD", "10 m above ground"), ("VGRD", "10 m above ground")],
        "calc": "sqrt(A*A+B*B)*2.23694",           # m/s -> mph
    },
    "wg": {
        "label": "Wind gust", "units": "mph",
        "records": [("GUST", "surface")],
        "calc": "A*2.23694",                        # m/s -> mph
    },
    "tmpf": {
        "label": "Temperature", "units": "°F",
        "records": [("TMP", "2 m above ground")],
        "calc": "(A-273.15)*9/5+32",                # K -> °F
    },
    "rh": {
        "label": "Relative humidity", "units": "%",
        "records": [("RH", "2 m above ground")],
        "calc": None,                               # already %
    },
    "smoke": {
        "label": "Near-surface smoke", "units": "µg/m³",
        "records": [("MASSDEN", "8 m above ground")],
        "calc": "A*1e9",                            # kg/m³ -> µg/m³
    },
    "apcp01": {
        "label": "1-h precip", "units": "in",
        "records": [("APCP", "surface")],
        "calc": "A/25.4",                           # mm -> in
        # The sfc file carries TWO APCP:surface records: the 0-FF run total
        # and the (FF-1)-FF hourly window — match the window EXACTLY.
        "apcp_window": True,
    },
}

# Color ramps: single source of truth for BOTH the gdaldem ramp files and the
# manifest legend_stops (docs/spec-hrrr.md).
_WIND_RAMP: list[tuple[float, str]] = [
    (0, "#78b4dc"), (10, "#50aa96"), (20, "#ffdc50"), (30, "#ff9628"),
    (45, "#e63c32"), (58, "#aa2882"), (70, "#6e1450"),
]
RAMPS: dict[str, list[tuple[float, str]]] = {
    "ws": _WIND_RAMP,
    "wg": _WIND_RAMP,
    "tmpf": [(20, "#78b4dc"), (50, "#50aa96"), (70, "#ffdc50"),
             (85, "#ff9628"), (100, "#e63c32"), (115, "#6e1450")],
    "rh": [(5, "#d4572e"), (15, "#f57c00"), (25, "#ffdc50"),
           (40, "#e0d063"), (70, "#9ad8a0"), (100, "#78b4dc")],
    "smoke": [(0, "#b4b4b4"), (20, "#ffde59"), (60, "#ff8c00"),
              (100, "#e63223"), (150, "#a02378"), (200, "#6e143c")],
    "apcp01": [(0, "#a4aab8"), (0.05, "#627cae"), (0.15, "#6bc858"),
               (0.4, "#f6cf57"), (0.8, "#e8543b"), (1.5, "#9f40dd")],
}


def manifest_products() -> dict:
    """weather_runs.json products block: label + units + legend_stops."""
    return {
        name: {
            "label": spec["label"],
            "units": spec["units"],
            "legend_stops": [[value, color] for value, color in RAMPS[name]],
        }
        for name, spec in PRODUCTS.items()
    }


def _hex_to_rgb(color: str) -> tuple[int, int, int]:
    c = color.lstrip("#")
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)


def ramp_file_text(product: str) -> str:
    """gdaldem color-relief ramp file (interpolated); nodata transparent."""
    lines = []
    for value, color in RAMPS[product]:
        r, g, b = _hex_to_rgb(color)
        lines.append(f"{value:g} {r} {g} {b} 255")
    lines.append("nv 0 0 0 0")
    return "\n".join(lines) + "\n"


def write_ramp_file(product: str, path: Path) -> Path:
    path.write_text(ramp_file_text(product))
    return path


# ---------------------------------------------------------------------------
# idx sidecar parsing + byte-range math (pure, unit-tested)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class IdxRecord:
    msgnum: int
    offset: int
    var: str
    level: str
    fcst: str


def parse_idx(text: str) -> list[IdxRecord]:
    """Parse 'msgnum:byteOffset:d=YYYYMMDDHH:VAR:level:fcst:' lines."""
    out: list[IdxRecord] = []
    for line in text.splitlines():
        parts = line.split(":")
        if len(parts) < 6:
            continue
        try:
            out.append(IdxRecord(int(parts[0]), int(parts[1]),
                                 parts[3], parts[4], parts[5]))
        except ValueError:
            continue
    return out


def byte_range(records: list[IdxRecord], index: int) -> str:
    """HTTP Range header value for message `index`; message size = next
    offset - offset, the last message gets an open-ended range."""
    start = records[index].offset
    if index + 1 < len(records):
        return f"bytes={start}-{records[index + 1].offset - 1}"
    return f"bytes={start}-"


def apcp_window_fcst(fhour: int) -> str:
    """The EXACT hourly-accumulation fcst string, e.g. f02 -> '1-2 hour acc fcst'."""
    return f"{fhour - 1}-{fhour} hour acc fcst"


def select_records(records: list[IdxRecord], product: str, fhour: int
                   ) -> list[int] | None:
    """Indices of the product's message(s) in idx order, or None if any is
    missing (e.g. no hourly APCP window at f00)."""
    spec = PRODUCTS[product]
    out: list[int] = []
    for var, level in spec["records"]:
        want_fcst = apcp_window_fcst(fhour) if spec.get("apcp_window") else None
        found = None
        for i, rec in enumerate(records):
            if (rec.var == var and rec.level == level
                    and (want_fcst is None or rec.fcst == want_fcst)):
                found = i
                break
        if found is None:
            return None
        out.append(found)
    return out


# ---------------------------------------------------------------------------
# Cycle discovery (anonymous S3 XML listing)
# ---------------------------------------------------------------------------

_SFC_KEY_RE = re.compile(
    r"hrrr\.t(?P<h>\d{2})z\.wrfsfcf(?P<f>\d{2})\.grib2(?P<idx>\.idx)?$")


def grib_key(date_str: str, cycle_hour: int, fhour: int) -> str:
    return f"hrrr.{date_str}/conus/hrrr.t{cycle_hour:02d}z.wrfsfcf{fhour:02d}.grib2"


def parse_listing_fhours(xml_bytes: bytes) -> list[int]:
    """Forecast hours whose .grib2 AND .idx are both present, sorted."""
    root = etree.fromstring(xml_bytes)
    gribs: set[int] = set()
    idxs: set[int] = set()
    for key_el in root.iter(f"{S3_NS}Key"):
        m = _SFC_KEY_RE.search(key_el.text or "")
        if not m:
            continue
        (idxs if m.group("idx") else gribs).add(int(m.group("f")))
    return sorted(gribs & idxs)


def list_cycle_fhours(client: httpx.Client, cycle: datetime) -> list[int]:
    prefix = f"hrrr.{cycle:%Y%m%d}/conus/hrrr.t{cycle:%H}z.wrfsfcf"
    url = f"{HRRR_BUCKET}/?" + urlencode(
        {"list-type": "2", "prefix": prefix, "max-keys": "200"})
    resp = get(client, url)
    return parse_listing_fhours(resp.content)


def workspace_name(cycle: datetime) -> str:
    return f"hrrr_{cycle:%Y%m%d}_{cycle:%H}"


def expected_fhour_count(cycle: datetime) -> int:
    """f00-f48 for the 00/06/12/18z cycles, f00-f18 otherwise."""
    return 49 if cycle.hour % 6 == 0 else 19


def run_from_cycle(cycle: datetime, fhours: list[int]) -> dict:
    return {
        "workspace": workspace_name(cycle),
        "run_time": cycle.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "hours": [(cycle + timedelta(hours=f)).strftime("%Y-%m-%dT%H:%M:%SZ")
                  for f in fhours],
    }


def discover_runs(client: httpx.Client, now: datetime | None = None, *,
                  min_hours: int = 2, count: int = 2, lookback: int = 12
                  ) -> list[dict]:
    """Newest `count` cycles with >= min_hours sfc hours listed, newest first.

    Cycles are hourly; sfc files land ~50-55 min after init, one hour at a
    time, so the newest usable cycle is usually 1-2 hours old.
    """
    cycle = (now or datetime.now(timezone.utc)).replace(
        minute=0, second=0, microsecond=0)
    runs: list[dict] = []
    for _ in range(lookback):
        fhours = list_cycle_fhours(client, cycle)
        if len(fhours) >= min_hours:
            runs.append(run_from_cycle(cycle, fhours))
            if len(runs) >= count:
                break
        cycle -= timedelta(hours=1)
    return runs


# ---------------------------------------------------------------------------
# Manifest annotation (frames block — same shape as the gs01-era manifest)
# ---------------------------------------------------------------------------

def annotate_run(run: dict, hrrr_state: dict) -> None:
    st = hrrr_state.get(run["workspace"]) or {}
    done = bool(st.get("done"))
    run["frames"] = {
        "bounds": list(config.CONUS_BOUNDS),
        "image_template": WEATHER_IMAGE_TEMPLATE,
        "hours": list(run.get("hours") or []) if done else [],
        "complete": done,
    }


def image_key(ws: str, product: str, hour_iso: str) -> str:
    """B2 key for one frame; epoch_ms = valid time (JS Date.parse)."""
    return f"frames/weather/{ws}/{product}/{frames.epoch_ms(hour_iso)}.png"


def wind_uv_key(ws: str, hour_iso: str) -> str:
    """B2 key for one hour's coarse U/V grid JSON (epoch_ms = valid time)."""
    return f"frames/weather/{ws}/wind_uv/{frames.epoch_ms(hour_iso)}.json"


# ---------------------------------------------------------------------------
# GDAL CLI pipeline (warp -> calc -> color-relief -> PNG)
# ---------------------------------------------------------------------------

def _tool(name: str) -> str:
    path = shutil.which(name)
    if path is None and name.endswith(".py"):     # some distros drop the .py
        path = shutil.which(name[:-3])
    if path is None:
        raise RuntimeError(
            f"required GDAL tool not found on PATH: {name} "
            "(install gdal-bin + python3-gdal / brew gdal)")
    return path


def _run(cmd: list[str]) -> None:
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as exc:
        tail = (exc.stderr or "").strip().splitlines()[-1:] or ["(no stderr)"]
        raise RuntimeError(f"{Path(cmd[0]).name} failed: {tail[0]}") from exc


def warp_to_conus(grib_path: Path, workdir: Path) -> Path:
    """Warp a message file to the EPSG:3857 CONUS frame grid (NaN nodata)."""
    merc = frames.bounds4326_to_3857(list(config.CONUS_BOUNDS))
    width, height = frames.dims_for_width(merc, config.WEATHER_FRAME_WIDTH)
    warped = workdir / "warped.tif"
    _run([_tool("gdalwarp"), "-q", "-overwrite", "-t_srs", "EPSG:3857",
          "-te", *(repr(float(v)) for v in merc),
          "-ts", str(width), str(height), "-r", "bilinear",
          "-dstnodata", "nan", str(grib_path), str(warped)])
    return warped


def render_warped_to_png(warped: Path, product: str, ramp_path: Path,
                         workdir: Path) -> bytes:
    """Warped tif -> transparent colored CONUS PNG bytes."""
    calc_expr = PRODUCTS[product]["calc"]
    if calc_expr is None:
        calc_out = warped
    else:
        calc_out = workdir / "calc.tif"
        cmd = [_tool("gdal_calc.py"), "--quiet", "--overwrite",
               "-A", str(warped), "--A_band=1"]
        if len(PRODUCTS[product]["records"]) > 1:
            cmd += ["-B", str(warped), "--B_band=2"]
        # no --NoDataValue: gdal_calc propagates the input NaN nodata mask
        cmd += ["--calc", calc_expr, "--outfile", str(calc_out)]
        _run(cmd)

    colored = workdir / "colored.tif"
    _run([_tool("gdaldem"), "color-relief", "-q", str(calc_out),
          str(ramp_path), str(colored), "-alpha"])  # interpolated (default)

    png = workdir / "out.png"
    _run([_tool("gdal_translate"), "-q", "-of", "PNG", str(colored), str(png)])
    return png.read_bytes()


# ---------------------------------------------------------------------------
# Coarse U/V grid for frontend wind arrows (CLI GDAL only, no numpy)
# ---------------------------------------------------------------------------

def parse_xyz_values(text: str, nx: int) -> tuple[int, list[float | None]]:
    """Parse `gdal_translate -of XYZ` text into (ny, values).

    XYZ writes one 'x y z' line per pixel in natural raster order: row-major,
    row 0 at the NORTH edge, index = row*nx + col. Values are rounded to 0.1;
    nodata (NaN) becomes None.
    """
    vals: list[float | None] = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        z = float(parts[2])
        vals.append(None if math.isnan(z) else round(z, 1))
    ny, rem = divmod(len(vals), nx)
    if rem or ny == 0:
        raise RuntimeError(
            f"XYZ output is not a {nx}-wide raster ({len(vals)} values)")
    return ny, vals


def wind_uv_grid(warped: Path, workdir: Path, nx: int = WIND_UV_NX) -> dict:
    """Warped 2-band (U, V) tif -> coarse grid dict for the manifest contract:

    { nx, ny, bounds, u, v } — u/v in m/s, row-major with row 0 at the north
    edge, rounded to 0.1, null where nodata. Downsampled to `nx` px wide with
    aspect-correct height (average resampling honors the NaN nodata mask).
    """
    small = workdir / "uv_small.tif"
    _run([_tool("gdal_translate"), "-q", "-outsize", str(nx), "0",
          "-r", "average", str(warped), str(small)])
    bands: list[tuple[int, list[float | None]]] = []
    for band in (1, 2):
        xyz = workdir / f"uv_band{band}.xyz"
        _run([_tool("gdal_translate"), "-q", "-of", "XYZ", "-b", str(band),
              str(small), str(xyz)])
        bands.append(parse_xyz_values(xyz.read_text(), nx))
    (ny_u, u), (ny_v, v) = bands
    if ny_u != ny_v:
        raise RuntimeError(f"U/V grid height mismatch: {ny_u} != {ny_v}")
    return {"nx": nx, "ny": ny_u, "bounds": list(config.CONUS_BOUNDS),
            "u": u, "v": v}


# ---------------------------------------------------------------------------
# Sync (incremental, budget + deadline shared with frames.py)
# ---------------------------------------------------------------------------

def fetch_messages(client: httpx.Client, grib_url: str,
                   records: list[IdxRecord], indices: list[int]) -> bytes:
    """Byte-range GET each message; concatenated messages form a valid
    multi-band GRIB2 file (band order == indices order)."""
    chunks = []
    for i in indices:
        resp = get(client, grib_url, headers={"Range": byte_range(records, i)})
        chunks.append(resp.content)
    return b"".join(chunks)


def _put_wind_uv(storage: Storage, ws: str, hour: str, warped: Path,
                 workdir: Path) -> None:
    grid = wind_uv_grid(warped, workdir)
    storage.put_bytes(wind_uv_key(ws, hour),
                      json.dumps(grid, separators=(",", ":")).encode(),
                      content_type="application/json")


def _render_hour(client: httpx.Client, storage: Storage, ws_state: dict,
                 run: dict, hour: str, products: list[str],
                 ramps: dict[str, Path], budget: int, workdir: Path, log
                 ) -> tuple[bool, bool, int]:
    """Render every missing product image (and, when ws is in scope, the
    coarse U/V grid JSON) for one forecast hour.

    Returns (hour_ok, uv_present, budget_left). Attempts (including failures)
    count against the budget so a persistently failing hour cannot stall the
    sync; the U/V grid counts one image too.
    """
    ws = run["workspace"]
    run_time = frames.parse_instant(run["run_time"])
    valid = frames.parse_instant(hour)
    fhour = int((valid - run_time).total_seconds() // 3600)

    uv_present = "ws" in products and storage.exists(wind_uv_key(ws, hour))
    need_uv = "ws" in products and not uv_present
    missing = [p for p in products if not storage.exists(image_key(ws, p, hour))]
    if not missing and not need_uv:
        return True, uv_present, budget

    grib_url = f"{HRRR_BUCKET}/{grib_key(f'{run_time:%Y%m%d}', run_time.hour, fhour)}"
    try:
        records = parse_idx(get(client, grib_url + ".idx").text)
    except Exception as exc:
        log(f"[hrrr] idx FAILED {ws} f{fhour:02d}: {exc}")
        return False, uv_present, budget - 1

    ok = True
    fetched = 0
    for product in missing:
        if budget <= 0 or frames.deadline_passed():
            ok = False
            break
        indices = select_records(records, product, fhour)
        if indices is None:
            # expected for apcp01 at f00 (no hourly accumulation window yet)
            if product != "apcp01":
                log(f"[hrrr] {ws} f{fhour:02d} {product}: idx records missing")
                ok = False
            continue
        budget -= 1
        try:
            grib = fetch_messages(client, grib_url, records, indices)
            with tempfile.TemporaryDirectory(dir=workdir) as td:
                tdp = Path(td)
                msg = tdp / "msg.grib2"
                msg.write_bytes(grib)
                warped = warp_to_conus(msg, tdp)
                png = render_warped_to_png(warped, product, ramps[product], tdp)
                storage.put_bytes(image_key(ws, product, hour), png,
                                  content_type="image/png")
                fetched += 1
                if product == "ws" and need_uv:
                    # U/V are exactly this product's warped bands — reuse them
                    budget -= 1
                    _put_wind_uv(storage, ws, hour, warped, tdp)
                    need_uv = False
                    uv_present = True
                    fetched += 1
        except Exception as exc:
            log(f"[hrrr] FAILED {ws} f{fhour:02d} {product}: {exc}")
            ok = False

    if need_uv:
        # ws PNG already existed (or its render failed) but the grid is
        # missing — fetch U/V and emit the JSON on its own.
        if budget <= 0 or frames.deadline_passed():
            ok = False
        else:
            budget -= 1
            indices = select_records(records, "ws", fhour)
            if indices is None:
                log(f"[hrrr] {ws} f{fhour:02d} wind_uv: idx records missing")
                ok = False
            else:
                try:
                    grib = fetch_messages(client, grib_url, records, indices)
                    with tempfile.TemporaryDirectory(dir=workdir) as td:
                        tdp = Path(td)
                        msg = tdp / "msg.grib2"
                        msg.write_bytes(grib)
                        _put_wind_uv(storage, ws, hour,
                                     warp_to_conus(msg, tdp), tdp)
                    uv_present = True
                    fetched += 1
                except Exception as exc:
                    log(f"[hrrr] FAILED {ws} f{fhour:02d} wind_uv: {exc}")
                    ok = False

    ws_state["fetched"] = int(ws_state.get("fetched", 0)) + fetched
    if fetched:
        log(f"[hrrr] {ws} f{fhour:02d}: +{fetched} images")
    return ok, uv_present, budget


def sync_weather(client: httpx.Client, storage: Storage, state: dict,
                 weather: dict, *, budget: int,
                 hours_limit: int | None = None,
                 products_filter: set[str] | None = None,
                 log=print) -> int:
    """Render HRRR frames for every run in the weather manifest, hour-major
    so partially budgeted syncs still complete whole hours. Updates the runs'
    `frames` blocks in place and returns the remaining budget."""
    hrrr_state: dict = state.setdefault("hrrr", {})
    model = weather.get("models", {}).get("hrrr", {})
    limited = bool(hours_limit or products_filter)

    # Weather rendering is the ONLY part of sync-catalogs that needs GDAL. When
    # the toolchain is missing (a slow apt mirror timed the install out), skip
    # it and still publish fires, forecasts, and incident catalogs — a stalled
    # Ubuntu mirror must not block the whole refresh.
    missing = [t for t in ("gdalwarp", "gdaldem", "gdal_translate")
               if shutil.which(t) is None]
    if missing:
        log(f"[hrrr] GDAL unavailable ({', '.join(missing)}) — skipping weather "
            "frames this sync; catalogs still publish")
        return budget

    for run in model.get("runs", []):
        ws = run["workspace"]
        if "frames" not in run:
            annotate_run(run, hrrr_state)
        ws_state = hrrr_state.setdefault(ws, {"done": False, "fetched": 0})
        if ws_state.get("done"):
            run["frames"]["hours"] = list(run.get("hours") or [])
            run["frames"]["complete"] = True
            done_hours = run.get("hours") or []
            if done_hours and storage.exists(wind_uv_key(ws, done_hours[0])):
                run["frames"]["wind_uv_template"] = WIND_UV_TEMPLATE
            continue

        products = [p for p in PRODUCTS
                    if not products_filter or p in products_filter]
        hours = run.get("hours") or []
        if hours_limit:
            hours = hours[:hours_limit]
        run_time = frames.parse_instant(run["run_time"])

        rendered: list[str] = []
        all_ok = True
        uv_any = False
        with tempfile.TemporaryDirectory() as td:
            ramps = {p: write_ramp_file(p, Path(td) / f"{p}.txt")
                     for p in products}
            for hour in hours:
                if budget <= 0 or frames.deadline_passed():
                    all_ok = False
                    reason = "deadline" if frames.deadline_passed() else "budget"
                    log(f"[hrrr] {ws}: remaining hours deferred by {reason}")
                    break
                hour_ok, uv_present, budget = _render_hour(
                    client, storage, ws_state, run, hour, products, ramps,
                    budget, Path(td), log)
                if hour_ok:
                    rendered.append(hour)
                else:
                    all_ok = False
                uv_any = uv_any or uv_present

        complete = (all_ok and not limited
                    and rendered == (run.get("hours") or []))
        # only freeze the workspace once the cycle's full hour range exists
        cycle_full = len(run.get("hours") or []) >= expected_fhour_count(run_time)
        ws_state["done"] = complete and cycle_full
        run["frames"]["hours"] = rendered
        run["frames"]["complete"] = complete
        if uv_any:
            # at least one U/V grid JSON exists for this run — advertise it
            # (same complete-semantics as `hours`)
            run["frames"]["wind_uv_template"] = WIND_UV_TEMPLATE
    return budget
