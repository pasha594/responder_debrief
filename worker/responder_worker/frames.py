"""Pre-render WMS frames to static PNGs on B2 (static-frames architecture).

Replaces the deleted Cloudflare WMS proxy: the browser never talks to the
pyrecast geoservers. Every image the frontend needs is fetched server-side
here (GetMap / GetLegendGraphic), uploaded to B2 immutable-cached, and
referenced from the manifests via path templates. See docs/spec-frames.md.

Politeness: concurrency <= 2 to each geoserver, tenacity retries (http.get),
strictly incremental (a frame is fetched at most once ever — run-stamped
workspaces are immutable; state records completed workspaces), and a per-sync
image budget (FRAME_BUDGET, default 3000).
"""

from __future__ import annotations

import math
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx

from . import config
from .b2 import Storage
from .http import get

# ---------------------------------------------------------------------------
# Manifest path templates (contract with the frontend)
# ---------------------------------------------------------------------------

SPREAD_TIMED_TEMPLATE = "/frames/spread/{ws}/{pct}/{product}/{epoch_ms}.png"
SPREAD_STATIC_TEMPLATE = "/frames/spread/{ws}/{pct}/{product}/static.png"
WEATHER_IMAGE_TEMPLATE = "/frames/weather/{ws}/{product}/{epoch_ms}.png"
SPREAD_LEGEND_TEMPLATE = "/frames/legends/spread-{product}.png"
WEATHER_LEGEND_TEMPLATE = "/frames/legends/weather-{product}.png"
NATIONAL_PERIMS_KEY = "frames/national/current-year-perimeters.png"


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


def frame_dims(merc: tuple[float, float, float, float], max_dim: int
               ) -> tuple[int, int]:
    """Pixel (width, height) for a mercator bbox at a max edge, aspect-correct.

    Faithful port of frontend/src/api/geo.ts frameDims().
    """
    w = merc[2] - merc[0]
    h = merc[3] - merc[1]
    if w <= 0 or h <= 0:
        return max_dim, max_dim
    if w >= h:
        return max_dim, max(1, _js_round(max_dim * h / w))
    return max(1, _js_round(max_dim * w / h)), max_dim


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


def legend_url(ows_base: str, layer: str) -> str:
    params = {
        "service": "WMS",
        "version": "1.3.0",
        "request": "GetLegendGraphic",
        "format": "image/png",
        "layer": layer,
    }
    return f"{ows_base}?{urlencode(params)}"


def hour_layer_suffix(hour_iso: str) -> tuple[str, str]:
    """'2026-08-17T12:00:00Z' -> ('20260817', '120000')."""
    t = parse_instant(hour_iso).astimezone(timezone.utc)
    return t.strftime("%Y%m%d"), t.strftime("%H%M%S")


# ---------------------------------------------------------------------------
# Manifest annotation (frames blocks + legend fields)
# ---------------------------------------------------------------------------

def annotate_spread_run(run: dict, frames_state: dict) -> None:
    """Attach the frames block + per-product legend paths to a pyrecast run."""
    st = frames_state.get(run["workspace"]) or {}
    pcts = [p for p in config.SPREAD_FRAME_PERCENTILES
            if p in (run.get("percentiles") or [])]
    run["frames"] = {
        "percentiles": pcts or list(config.SPREAD_FRAME_PERCENTILES),
        "instants": thin_instants(run.get("time_instants") or []),
        "timed_template": SPREAD_TIMED_TEMPLATE,
        "static_template": SPREAD_STATIC_TEMPLATE,
        "complete": bool(st.get("done")),
    }
    for name, product in (run.get("products") or {}).items():
        product["legend"] = SPREAD_LEGEND_TEMPLATE.format(product=name)


def annotate_weather_run(run: dict, frames_state: dict) -> None:
    """Attach the frames block to a weather run (hours filled after fetch)."""
    st = frames_state.get(run["workspace"]) or {}
    done = bool(st.get("done"))
    run["frames"] = {
        "bounds": list(config.CONUS_BOUNDS),
        "image_template": WEATHER_IMAGE_TEMPLATE,
        "hours": list(run.get("hours") or []) if done else [],
        "complete": done,
    }


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
    if budget <= 0:
        return budget, False
    batch = missing[:budget]
    fetched = 0
    with ThreadPoolExecutor(max_workers=config.FRAMES_CONCURRENCY) as ex:
        futures = {ex.submit(_fetch_image, client, url): key for key, url in batch}
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
    budget -= len(batch)
    if fetched or len(batch) < len(missing):
        log(f"[frames] {label}: +{fetched} images"
            + (f" ({len(missing) - len(batch)} deferred by budget)"
               if len(batch) < len(missing) else ""))
    return budget, fetched == len(missing)


def sync_spread_frames(client: httpx.Client, storage: Storage, state: dict,
                       pyre: dict, *, budget: int,
                       fires_filter: set[str] | None = None, log=print) -> int:
    """Fetch spread-forecast frames for every not-yet-complete gs02 run.

    Annotated `frames` blocks on the pyre doc are updated in place
    (`complete` flips true once every frame of the workspace is stored).
    """
    frames_state: dict = state.setdefault("frames", {})
    for slug, entry in pyre.get("fires", {}).items():
        if fires_filter and slug not in fires_filter:
            continue
        for run in entry.get("runs", []):
            ws = run["workspace"]
            if "frames" not in run:  # stored doc from an older schema
                annotate_spread_run(run, frames_state)
            ws_state = frames_state.setdefault(ws, {"done": False, "fetched": 0})
            if ws_state.get("done"):
                run["frames"]["complete"] = True
                continue
            if budget <= 0:
                return budget

            merc = bounds4326_to_3857(run["bbox"])
            width, height = frame_dims(merc, config.SPREAD_FRAME_MAX_DIM)
            jobs: list[tuple[str, str]] = []
            for pct in run["frames"]["percentiles"]:
                for product, p in run.get("products", {}).items():
                    layer = p["layer_template"].format(ws=ws, pct=pct)
                    prefix = f"frames/spread/{ws}/{pct}/{product}"
                    if p.get("timed"):
                        for inst in run["frames"]["instants"]:
                            jobs.append((
                                f"{prefix}/{epoch_ms(inst)}.png",
                                getmap_url(config.GS02_OWS, layer, merc,
                                           width, height, time=inst),
                            ))
                    else:
                        jobs.append((
                            f"{prefix}/static.png",
                            getmap_url(config.GS02_OWS, layer, merc, width, height),
                        ))

            budget, complete = _run_jobs(client, storage, ws_state, jobs,
                                         budget, log, ws)
            ws_state["done"] = complete
            run["frames"]["complete"] = complete
    return budget


def sync_weather_frames(client: httpx.Client, storage: Storage, state: dict,
                        weather: dict, *, budget: int,
                        hours_limit: int | None = None,
                        products_filter: set[str] | None = None,
                        log=print) -> int:
    """Fetch CONUS weather frames per product per forecast hour (gs01).

    Hour-major so partially budgeted syncs still render complete hours; the
    run's frames.hours lists the hours actually rendered.
    """
    frames_state: dict = state.setdefault("frames", {})
    model = weather.get("models", {}).get("hrrr", {})
    limited = bool(hours_limit or products_filter)

    merc = bounds4326_to_3857(list(config.CONUS_BOUNDS))
    width, height = dims_for_width(merc, config.WEATHER_FRAME_WIDTH)

    for run in model.get("runs", []):
        ws = run["workspace"]
        if "frames" not in run:
            annotate_weather_run(run, frames_state)
        ws_state = frames_state.setdefault(ws, {"done": False, "fetched": 0})
        if ws_state.get("done"):
            run["frames"]["hours"] = list(run.get("hours") or [])
            run["frames"]["complete"] = True
            continue

        products = [p for p in run.get("products", [])
                    if p in config.WEATHER_FRAME_PRODUCTS
                    and (not products_filter or p in products_filter)]
        hours = run.get("hours") or []
        if hours_limit:
            hours = hours[:hours_limit]

        rendered: list[str] = []
        all_ok = True
        for hour in hours:
            if budget <= 0:
                all_ok = False
                break
            ems = epoch_ms(hour)
            d, t = hour_layer_suffix(hour)
            jobs = [(
                f"frames/weather/{ws}/{product}/{ems}.png",
                getmap_url(config.GS01_OWS, f"{ws}:{product}_{d}_{t}",
                           merc, width, height),
            ) for product in products]
            budget, ok = _run_jobs(client, storage, ws_state, jobs, budget,
                                   log, f"{ws} {hour}")
            if ok:
                rendered.append(hour)
            else:
                all_ok = False

        complete = all_ok and not limited and rendered == (run.get("hours") or [])
        ws_state["done"] = complete
        run["frames"]["hours"] = rendered
        run["frames"]["complete"] = complete
    return budget


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


def sync_legends(client: httpx.Client, storage: Storage, pyre: dict,
                 weather: dict, *, products_filter: set[str] | None = None,
                 log=print) -> int:
    """Fetch legends once per product; refresh only when missing."""
    jobs: list[tuple[str, str]] = []

    # spread legends: any current run works (pct 50 per spec)
    for entry in pyre.get("fires", {}).values():
        runs = entry.get("runs") or []
        if not runs:
            continue
        run = runs[0]
        for product, p in run.get("products", {}).items():
            key = SPREAD_LEGEND_TEMPLATE.format(product=product).lstrip("/")
            layer = p["layer_template"].format(ws=run["workspace"], pct=50)
            jobs.append((key, legend_url(config.GS02_OWS, layer)))
        break

    # weather legends: bare default layer {ws}:{product} on the newest run
    model = weather.get("models", {}).get("hrrr", {})
    runs = model.get("runs") or []
    if runs:
        ws = runs[0]["workspace"]
        for product in model.get("products", {}):
            if products_filter and product not in products_filter:
                continue
            key = WEATHER_LEGEND_TEMPLATE.format(product=product).lstrip("/")
            jobs.append((key, legend_url(config.GS01_OWS, f"{ws}:{product}")))

    fetched = 0
    for key, url in jobs:
        if storage.exists(key):
            continue
        try:
            data = _fetch_image(client, url)
        except Exception as exc:
            log(f"[frames] legend FAILED {key}: {exc}")
            continue
        storage.put_bytes(key, data, content_type="image/png")
        fetched += 1
    if fetched:
        log(f"[frames] legends fetched: {fetched}")
    return fetched
