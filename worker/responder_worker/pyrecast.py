"""Pyrecast GeoServer capabilities: fetch + parse for gs02 (spread) and gs01 (weather).

gs02: full caps hourly (5.4 MB is fine server-side) with &updatesequence=
short-circuit. gs01: NEVER the 33 MB full caps on schedule — probe the last 4
deterministic HRRR cycle workspaces via &namespace= filtered caps.
"""

from __future__ import annotations

import re
import urllib.parse
from datetime import datetime, timedelta, timezone

import httpx
from lxml import etree

from . import config
from .http import get, get_optional

WMS_NS = "{http://www.opengis.net/wms}"
XLINK_NS = "{http://www.w3.org/1999/xlink}"

GS02_WS_RE = re.compile(
    r"^fire-spread-forecast_(?P<slug>[a-z0-9-]+?)_(?P<d>\d{8})_(?P<t>\d{6})$"
)
GS01_HRRR_WS_RE = re.compile(r"^fire-weather-forecast_hrrr_(?P<d>\d{8})_(?P<h>\d{2})$")
GS02_LAYER_RE = re.compile(r"^elmfire_landfire_(?P<pct>\d+)_(?P<product>[a-z-]+)$")
GS01_HOUR_LAYER_RE = re.compile(r"^(?P<product>[a-z0-9]+)_(?P<d>\d{8})_(?P<t>\d{6})$")

VECTOR_PRODUCTS = {"isochrones"}
TIMED_EXPECTED = {"crown-fire", "flame-length", "hours-since-burned", "spread-rate"}


def caps_url(ows_base: str, *, namespace: str | None = None,
             update_sequence: str | None = None) -> str:
    params = {
        "service": "WMS",
        "version": "1.3.0",
        "request": "GetCapabilities",
    }
    if namespace:
        params["namespace"] = namespace
    if update_sequence:
        params["updatesequence"] = update_sequence
    return f"{ows_base}?{urllib.parse.urlencode(params)}"


def _proxy_legend_url(href: str, proxy_path: str) -> str:
    """Rewrite an absolute GeoServer legend URL to the caching proxy path."""
    parsed = urllib.parse.urlsplit(href)
    return f"{proxy_path}?{parsed.query}" if parsed.query else proxy_path


def run_time_from_ws(ws: str) -> str | None:
    m = GS02_WS_RE.match(ws)
    if m:
        d, t = m.group("d"), m.group("t")
        return f"{d[:4]}-{d[4:6]}-{d[6:]}T{t[:2]}:{t[2:4]}:{t[4:]}Z"
    m = GS01_HRRR_WS_RE.match(ws)
    if m:
        d, h = m.group("d"), m.group("h")
        return f"{d[:4]}-{d[4:6]}-{d[6:]}T{h}:00:00Z"
    return None


# ---------------------------------------------------------------------------
# gs02 — spread-forecast runs
# ---------------------------------------------------------------------------

def parse_gs02_caps(xml_source) -> tuple[str | None, dict[str, dict]]:
    """Parse gs02 caps (bytes / file path / file-like) via iterparse.

    Returns (updateSequence, {workspace: run}) where run =
      {workspace, slug, run_time, bbox [w,s,e,n], native_crs, percentiles,
       time_instants [verbatim], products {name: {timed, layer_template,
       legend_url, vector?}}}
    """
    update_sequence: str | None = None
    runs: dict[str, dict] = {}

    import io

    if isinstance(xml_source, (bytes, bytearray)):
        xml_source = io.BytesIO(bytes(xml_source))

    for _event, elem in etree.iterparse(xml_source, events=("end",), recover=True):
        tag = etree.QName(elem).localname
        if tag == "WMS_Capabilities":
            update_sequence = elem.get("updateSequence")
            continue
        if tag != "Layer" or elem.get("queryable") is None:
            continue

        name_el = elem.find(f"{WMS_NS}Name")
        if name_el is None or not name_el.text or ":" not in name_el.text:
            elem.clear()
            continue
        ws, layer = name_el.text.split(":", 1)
        ws_m = GS02_WS_RE.match(ws)
        layer_m = GS02_LAYER_RE.match(layer)
        if not ws_m or not layer_m:
            elem.clear()
            continue

        run = runs.setdefault(ws, {
            "workspace": ws,
            "slug": ws_m.group("slug"),
            "run_time": run_time_from_ws(ws),
            "bbox": None,
            "native_crs": None,
            "percentiles": set(),
            "time_instants": None,
            "products": {},
        })

        if run["bbox"] is None:
            gb = elem.find(f"{WMS_NS}EX_GeographicBoundingBox")
            if gb is not None:
                run["bbox"] = [
                    float(gb.findtext(f"{WMS_NS}westBoundLongitude")),
                    float(gb.findtext(f"{WMS_NS}southBoundLatitude")),
                    float(gb.findtext(f"{WMS_NS}eastBoundLongitude")),
                    float(gb.findtext(f"{WMS_NS}northBoundLatitude")),
                ]
        if run["native_crs"] is None:
            for crs_el in elem.findall(f"{WMS_NS}CRS"):
                if crs_el.text and crs_el.text.startswith("EPSG:"):
                    run["native_crs"] = crs_el.text
                    break

        run["percentiles"].add(int(layer_m.group("pct")))
        product = layer_m.group("product")

        dim = elem.find(f"{WMS_NS}Dimension")
        timed = dim is not None and (dim.get("name") or "").lower() == "time"
        if timed and run["time_instants"] is None and dim.text:
            # verbatim instants — never regenerated, first has minute precision
            run["time_instants"] = [s for s in dim.text.strip().split(",") if s]

        if product not in run["products"]:
            legend_url = None
            lr = elem.find(f"{WMS_NS}Style/{WMS_NS}LegendURL/{WMS_NS}OnlineResource")
            if lr is not None:
                href = lr.get(f"{XLINK_NS}href")
                if href:
                    # strip the percentile-specific layer param? keep verbatim query,
                    # proxied — frontend may substitute layer per percentile.
                    legend_url = _proxy_legend_url(href, config.WMS_PROXY["gs02"])
            entry: dict = {
                "timed": timed,
                "layer_template": "{ws}:elmfire_landfire_{pct}_" + product,
                "legend_url": legend_url,
            }
            if product in VECTOR_PRODUCTS:
                entry["vector"] = True
            run["products"][product] = entry
        elif timed:
            run["products"][product]["timed"] = True

        elem.clear()

    for run in runs.values():
        run["percentiles"] = sorted(run["percentiles"])
    return update_sequence, runs


def fetch_gs02_runs(client: httpx.Client, last_update_sequence: str | None = None
                    ) -> tuple[str | None, dict[str, dict] | None]:
    """Fetch + parse gs02 caps. Returns (updateSequence, runs) — runs None if
    unchanged (updatesequence short-circuit returned CurrentUpdateSequence)."""
    url = caps_url(config.GS02_OWS, update_sequence=last_update_sequence)
    resp = get(client, url)
    body = resp.content
    if last_update_sequence and b"CurrentUpdateSequence" in body[:2000]:
        return last_update_sequence, None
    return parse_gs02_caps(body)


# ---------------------------------------------------------------------------
# gs01 — HRRR weather runs
# ---------------------------------------------------------------------------

def parse_gs01_caps(xml_source) -> dict[str, dict]:
    """Parse gs01 (possibly namespace-filtered) caps for HRRR workspaces.

    Returns {workspace: {workspace, run_time, products: set, hours: [ISO...]}}
    Hour list is extracted from layer-name suffixes {product}_{YYYYMMDD}_{HHMMSS}.
    """
    import io

    if isinstance(xml_source, (bytes, bytearray)):
        xml_source = io.BytesIO(bytes(xml_source))

    runs: dict[str, dict] = {}
    for _event, elem in etree.iterparse(xml_source, events=("end",), recover=True):
        if etree.QName(elem).localname != "Layer" or elem.get("queryable") is None:
            continue
        name_el = elem.find(f"{WMS_NS}Name")
        if name_el is None or not name_el.text or ":" not in name_el.text:
            elem.clear()
            continue
        ws, layer = name_el.text.split(":", 1)
        if not GS01_HRRR_WS_RE.match(ws):
            elem.clear()
            continue
        run = runs.setdefault(ws, {
            "workspace": ws,
            "run_time": run_time_from_ws(ws),
            "products": set(),
            "hours": set(),
        })
        m = GS01_HOUR_LAYER_RE.match(layer)
        if m:
            run["products"].add(m.group("product"))
            d, t = m.group("d"), m.group("t")
            run["hours"].add(f"{d[:4]}-{d[4:6]}-{d[6:]}T{t[:2]}:{t[2:4]}:{t[4:]}Z")
        elif re.fullmatch(r"[a-z0-9]+", layer):
            run["products"].add(layer)
        elem.clear()

    for run in runs.values():
        run["products"] = sorted(run["products"])
        run["hours"] = sorted(run["hours"])
    return runs


def deterministic_hrrr_workspaces(now: datetime | None = None, count: int = 4) -> list[str]:
    """Last `count` HRRR cycle workspace names (00/06/12/18z), newest first."""
    now = now or datetime.now(timezone.utc)
    out = []
    cycle = now.replace(minute=0, second=0, microsecond=0)
    cycle = cycle.replace(hour=(cycle.hour // 6) * 6)
    for _ in range(count):
        out.append(f"fire-weather-forecast_hrrr_{cycle.strftime('%Y%m%d')}_{cycle.strftime('%H')}")
        cycle -= timedelta(hours=6)
    return out


def probe_gs01_runs(client: httpx.Client, count: int = 4) -> dict[str, dict]:
    """Probe recent HRRR cycles via namespace-filtered caps; merge results."""
    merged: dict[str, dict] = {}
    for ws in deterministic_hrrr_workspaces(count=count):
        resp = get_optional(client, caps_url(config.GS01_OWS, namespace=ws))
        if resp is None:
            continue
        merged.update(parse_gs01_caps(resp.content))
    return merged


# ---------------------------------------------------------------------------
# gs01 — national detection layers (rotating timestamped snapshots)
# ---------------------------------------------------------------------------

NATIONAL_PERIMS_WS = "fire-detections_current-year-perimeters"
GS01_SNAPSHOT_LAYER_RE = re.compile(
    r"^current-year-perimeters_(?P<d>\d{8})_(?P<t>\d{6})$"
)


def parse_gs01_national_layers(xml_source) -> dict | None:
    """Newest current-year-perimeters snapshot layer from namespace caps.

    gs01 publishes these as rotating timestamped layers (a new one every ~10
    minutes, no stable alias), so the frontend needs the qualified name from
    the catalog. Returns {"layer": qualified_name, "as_of": ISO} or None.
    """
    import io

    if isinstance(xml_source, (bytes, bytearray)):
        xml_source = io.BytesIO(bytes(xml_source))

    best: tuple[str, str] | None = None  # (sortable ts, qualified layer)
    for _event, elem in etree.iterparse(xml_source, events=("end",), recover=True):
        if etree.QName(elem).localname != "Layer" or elem.get("queryable") is None:
            continue
        name_el = elem.find(f"{WMS_NS}Name")
        if name_el is None or not name_el.text or ":" not in name_el.text:
            elem.clear()
            continue
        ws, layer = name_el.text.split(":", 1)
        if ws == NATIONAL_PERIMS_WS:
            m = GS01_SNAPSHOT_LAYER_RE.match(layer)
            if m:
                key = m.group("d") + m.group("t")
                if best is None or key > best[0]:
                    best = (key, name_el.text)
        elem.clear()

    if best is None:
        return None
    k = best[0]
    as_of = f"{k[:4]}-{k[4:6]}-{k[6:8]}T{k[8:10]}:{k[10:12]}:{k[12:]}Z"
    return {"layer": best[1], "as_of": as_of}


def probe_gs01_national_layers(client: httpx.Client) -> dict:
    """National layer names for catalog.json (empty dict when unavailable)."""
    resp = get_optional(client, caps_url(config.GS01_OWS, namespace=NATIONAL_PERIMS_WS))
    if resp is None:
        return {}
    perims = parse_gs01_national_layers(resp.content)
    return {"current_year_perimeters": perims} if perims else {}
