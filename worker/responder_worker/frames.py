"""Frame plumbing shared by the weather pipeline + the national snapshot.

What remains of the static-frames architecture (docs/spec-frames.md) after
spread forecasts moved to client-side rendering from the public archive
(docs/spec-archives.md): the wall-clock deadline shared with hrrr.py, instant
parsing / thinning / mercator helpers, the generic budgeted job runner, and
the single national-perimeters CONUS snapshot. All spread frame fetching,
annotation, and legend fetching is gone.

Politeness: concurrency <= 2 to each geoserver, tenacity retries (http.get),
and a per-sync image budget (FRAME_BUDGET, default 3000) shared with hrrr.py.
"""

from __future__ import annotations

import math
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from urllib.parse import urlencode

import httpx

from . import config
from .b2 import Storage
from .http import get

# ---------------------------------------------------------------------------
# Wall-clock deadline: the frames phase must never push the CI job into its
# timeout — a killed job publishes no manifests/catalog at all. When the
# deadline passes, remaining fetches defer to the next hourly sync exactly
# like budget exhaustion (frames marked complete=False). Frames already on B2
# are never refetched (storage.exists), so progress accrues run over run.
# ---------------------------------------------------------------------------

_DEADLINE: float | None = None


def start_deadline(seconds: int | None = None) -> None:
    """Arm the frames wall-clock. FRAMES_MAX_SECONDS env (default 720); <=0 disables."""
    global _DEADLINE
    if seconds is None:
        seconds = int(os.environ.get("FRAMES_MAX_SECONDS", "720"))
    _DEADLINE = (time.monotonic() + seconds) if seconds > 0 else None


def deadline_passed() -> bool:
    return _DEADLINE is not None and time.monotonic() > _DEADLINE

# ---------------------------------------------------------------------------
# Manifest path templates (contract with the frontend)
# ---------------------------------------------------------------------------

NATIONAL_PERIMS_KEY = "frames/national/current-year-perimeters.png"
# weather frames live in hrrr.py (NOAA AWS pipeline, docs/spec-hrrr.md);
# spread frames are gone (client-side archive rendering, docs/spec-archives.md)


# ---------------------------------------------------------------------------
# Pure helpers (unit-tested)
# ---------------------------------------------------------------------------

def parse_instant(instant: str) -> datetime:
    """Parse a verbatim ISO instant ('2026-08-17T11:25:00.000Z')."""
    return datetime.fromisoformat(instant.replace("Z", "+00:00"))


def epoch_ms(instant: str) -> int:
    """JS Date.parse equivalent for the verbatim ISO instants -> epoch ms."""
    return int(parse_instant(instant).timestamp() * 1000)


def thin_instants(instants: list[str]) -> list[str]:
    """Thin a run's verbatim time_instants for pre-rendering.

    Keep the very first (minute-precision) instant, every instant within the
    first 24 h after run start, then 3-hourly to 72 h, then 6-hourly to the
    end (~56 frames for a 169-instant 7-day hourly run). Returned strings are
    the VERBATIM inputs — never regenerated.
    """
    if not instants:
        return []
    t0 = parse_instant(instants[0])
    out = [instants[0]]
    for s in instants[1:]:
        dt = parse_instant(s) - t0
        if dt <= timedelta(hours=24):
            out.append(s)
            continue
        dt_h = int(dt.total_seconds() // 3600)
        if dt <= timedelta(hours=72):
            if dt_h % 3 == 0:
                out.append(s)
        elif dt_h % 6 == 0:
            out.append(s)
    return out


# ---- Web mercator (EPSG:3857) — port of frontend/src/api/geo.ts ----------

_R = 6378137.0
_MAX_LAT = 85.051129


def _js_round(x: float) -> int:
    """JS Math.round: half-up for positive values (Python round is banker's)."""
    return math.floor(x + 0.5)


def lon_lat_to_3857(lon: float, lat: float) -> tuple[float, float]:
    clamped = max(-_MAX_LAT, min(_MAX_LAT, lat))
    x = lon * math.pi * _R / 180.0
    y = _R * math.log(math.tan(math.pi / 4 + clamped * math.pi / 360.0))
    return x, y


def bounds4326_to_3857(b: list[float]) -> tuple[float, float, float, float]:
    """[w,s,e,n] 4326 -> (minX, minY, maxX, maxY) 3857."""
    min_x, min_y = lon_lat_to_3857(b[0], b[1])
    max_x, max_y = lon_lat_to_3857(b[2], b[3])
    return min_x, min_y, max_x, max_y


def dims_for_width(merc: tuple[float, float, float, float], width: int
                   ) -> tuple[int, int]:
    """Pixel (width, height) at a fixed width, aspect-correct height."""
    w = merc[2] - merc[0]
    h = merc[3] - merc[1]
    if w <= 0 or h <= 0:
        return width, width
    return width, max(1, _js_round(width * h / w))


def getmap_url(ows_base: str, layer: str,
               merc: tuple[float, float, float, float],
               width: int, height: int, *, time: str | None = None) -> str:
    params = {
        "service": "WMS",
        "version": "1.3.0",
        "request": "GetMap",
        "layers": layer,
        "styles": "",
        "crs": "EPSG:3857",
        "bbox": ",".join(repr(float(v)) for v in merc),
        "width": str(width),
        "height": str(height),
        "format": "image/png",
        "transparent": "true",
    }
    if time:
        params["time"] = time
    return f"{ows_base}?{urlencode(params)}"


# ---------------------------------------------------------------------------
# Manifest annotation
# ---------------------------------------------------------------------------

def national_layers_image_form(national_probe: dict) -> dict:
    """Probe result {'current_year_perimeters': {'layer','as_of'}} -> catalog form."""
    perims = (national_probe or {}).get("current_year_perimeters")
    if not perims:
        return {}
    return {
        "current_year_perimeters": {
            "image": f"/{NATIONAL_PERIMS_KEY}",
            "bounds": list(config.CONUS_BOUNDS),
            "as_of": perims.get("as_of"),
        }
    }


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------

def _fetch_image(client: httpx.Client, url: str) -> bytes:
    """GetMap/GetLegendGraphic with retries; reject 200-XML ServiceExceptions."""
    resp = get(client, url)
    ct = resp.headers.get("content-type", "")
    if not ct.startswith("image/"):
        snippet = resp.text[:200].replace("\n", " ")
        raise RuntimeError(f"non-image response ({ct or 'no content-type'}): {snippet}")
    return resp.content


def _run_jobs(client: httpx.Client, storage: Storage, ws_state: dict,
              jobs: list[tuple[str, str]], budget: int, log, label: str
              ) -> tuple[int, bool]:
    """Fetch the (key, url) jobs that are not yet in storage, <=2 concurrent.

    Returns (budget_left, complete). Attempts (including failures) count
    against the budget so a persistently failing layer cannot stall the sync.
    """
    missing = [(k, u) for k, u in jobs if not storage.exists(k)]
    if not missing:
        return budget, True
    if budget <= 0 or deadline_passed():
        return budget, False
    batch = missing[:budget]
    fetched = 0
    attempted = 0
    # Chunked so the wall-clock deadline is honored mid-workspace, not only
    # between workspaces.
    with ThreadPoolExecutor(max_workers=config.FRAMES_CONCURRENCY) as ex:
        for i in range(0, len(batch), 50):
            if deadline_passed():
                break
            chunk = batch[i : i + 50]
            attempted += len(chunk)
            futures = {ex.submit(_fetch_image, client, url): key for key, url in chunk}
            for fut in as_completed(futures):
                key = futures[fut]
                try:
                    data = fut.result()
                except Exception as exc:  # tenacity already retried
                    log(f"[frames] FAILED {key}: {exc}")
                    continue
                storage.put_bytes(key, data, content_type="image/png")
                fetched += 1
    ws_state["fetched"] = int(ws_state.get("fetched", 0)) + fetched
    budget -= attempted
    deferred = len(missing) - attempted
    if fetched or deferred:
        reason = "deadline" if deadline_passed() else "budget"
        log(f"[frames] {label}: +{fetched} images"
            + (f" ({deferred} deferred by {reason})" if deferred else ""))
    return budget, fetched == len(missing)


def sync_national_frame(client: httpx.Client, storage: Storage,
                        national_probe: dict, *, log=print) -> dict:
    """Render the newest current-year-perimeters snapshot to a single CONUS
    PNG (mutable, max-age=300). Returns the catalog.json national_layers
    image form ({} on failure — the frontend hides the layer)."""
    perims = (national_probe or {}).get("current_year_perimeters")
    if not perims:
        return {}
    merc = bounds4326_to_3857(list(config.CONUS_BOUNDS))
    width, height = dims_for_width(merc, config.NATIONAL_FRAME_WIDTH)
    url = getmap_url(config.GS01_OWS, perims["layer"], merc, width, height)
    try:
        data = _fetch_image(client, url)
    except Exception as exc:
        log(f"[frames] national perimeters snapshot FAILED: {exc}")
        return {}
    storage.put_bytes(NATIONAL_PERIMS_KEY, data, content_type="image/png",
                      cache_control="public, max-age=300")
    log(f"[frames] national perimeters snapshot: {len(data) / 1e6:.1f} MB "
        f"({width}x{height})")
    return national_layers_image_form(national_probe)
