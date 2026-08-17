"""Pyrecast GeoServer capabilities: the gs01 national detection layers probe.

Only the namespace-filtered national-perimeters caps is fetched — NEVER the
33 MB full gs01 caps on schedule. (gs02 spread parsing was removed: spread
forecasts are client-rendered straight from the public forecast archive — see
archives.py / docs/spec-archives.md. gs01 HRRR weather probing was removed
earlier: weather comes from the NOAA HRRR AWS bucket — see hrrr.py.)
"""

from __future__ import annotations

import re
import urllib.parse

import httpx
from lxml import etree

from . import config
from .http import get_optional

WMS_NS = "{http://www.opengis.net/wms}"


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
