"""Assemble the worker -> frontend JSON contracts.

catalog.json / weather_runs.json / per-fire incident manifests
(pyrecast_runs.json moved to archives.py — schema_version 2, built from the
public forecast archive). Upload ordering (atomicity) lives in cli.py:
immutable assets -> incident manifests -> runs catalogs -> catalog.json LAST.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from . import config, hrrr
from .matching import UNIT_TOKEN_RE

SCHEMA_VERSION = 1

_ANCHOR_RE = re.compile(r"_(?P<date>\d{8})_(?P<time>\d{4})_")
_ORIENTATIONS = {"port", "land"}
_SHEET_SINGLE_RE = re.compile(r"^\d{1,3}(x|X)\d{1,3}$|^85x11$|^8\.5x11$", re.I)
_PERIOD_RE = re.compile(r"^(?P<mmdd>\d{3,4})(?P<period>day|night)?$", re.I)


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_product_filename(filename: str) -> dict:
    """Tolerant parse of incident-map PDF names.

    ops_arch_e_port_20260816_2100_Elk_COGMF000114_817day.pdf ->
      {product: 'ops', product_base: 'ops', sheet: 'arch_e', orientation: 'port',
       generated_at_local: '2026-08-16T21:00', op_date: '2026-08-17',
       period: 'day', fire_name: 'Elk', unit_incident: 'COGMF000114'}

    Unparseable names degrade to {product: 'other'} — still mirrored.
    """
    stem = filename.rsplit(".", 1)[0]
    out: dict = {
        "filename": filename,
        "product": "other",
        "product_base": "other",
        "sheet": None,
        "orientation": None,
        "generated_at_local": None,
        "op_date": None,
        "period": None,
        "fire_name": None,
        "unit_incident": None,
    }

    m = _ANCHOR_RE.search(stem)
    if not m:
        return out

    d, t = m.group("date"), m.group("time")
    out["generated_at_local"] = f"{d[:4]}-{d[4:6]}-{d[6:]}T{t[:2]}:{t[2:]}"

    prefix = stem[: m.start()]
    suffix = stem[m.end():]

    # ---- prefix: product [ + sheet ] [ + orientation ] -------------------
    tokens = [tok for tok in prefix.split("_") if tok]
    if tokens and tokens[-1].lower() in _ORIENTATIONS:
        out["orientation"] = tokens.pop().lower()
    if len(tokens) >= 2 and tokens[-2].lower() == "arch" and len(tokens[-1]) == 1:
        out["sheet"] = f"arch_{tokens[-1].lower()}"
        tokens = tokens[:-2]
    elif tokens and _SHEET_SINGLE_RE.match(tokens[-1]):
        out["sheet"] = tokens.pop().lower()
    if tokens:
        out["product"] = "_".join(tokens).lower()
        out["product_base"] = tokens[0].lower()

    # ---- suffix: FireName_UNITNNNNNN_MMDD[day|night] ---------------------
    stail = [tok for tok in suffix.split("_") if tok]
    if stail:
        pm = _PERIOD_RE.match(stail[-1])
        if pm:
            stail.pop()
            mmdd = pm.group("mmdd").zfill(4)
            year = d[:4]
            out["op_date"] = f"{year}-{mmdd[:2]}-{mmdd[2:]}"
            out["period"] = (pm.group("period") or "").lower() or None
    if stail:
        um = UNIT_TOKEN_RE.match("_" + stail[-1] + "_")
        if um:
            out["unit_incident"] = stail.pop()
    if stail:
        out["fire_name"] = "_".join(stail)
    return out


def product_label(parsed: dict) -> str:
    base = parsed.get("product_base") or "other"
    label = config.PRODUCT_LABELS.get(parsed.get("product") or "", None)
    if label is None:
        label = config.PRODUCT_LABELS.get(base, config.PRODUCT_LABELS["other"])
    extra = parsed.get("product") or ""
    if base in config.PRODUCT_LABELS and extra != base and extra.startswith(base + "_"):
        variant = extra[len(base) + 1:].replace("_", " ")
        label = f"{label} ({variant})"
    return label


def tiling_priority(parsed: dict) -> int:
    return config.PRODUCT_PRIORITY.get(
        parsed.get("product_base") or "other", config.PRODUCT_PRIORITY["other"]
    )


# ---------------------------------------------------------------------------
# weather_runs.json
# ---------------------------------------------------------------------------

def build_weather_runs_hrrr(hrrr_runs: list[dict],
                            hrrr_state: dict | None = None) -> dict:
    """weather_runs.json from NOAA HRRR cycle discovery (docs/spec-hrrr.md).

    hrrr_runs: hrrr.discover_runs output, newest first (newest cycle with
    enough sfc hours + the previous cycle = 2 runs). Products carry units +
    legend_stops (gradient legends — no legend image fetching)."""
    hrrr_state = hrrr_state or {}
    runs_out = []
    for r in hrrr_runs[:2]:
        run_out = {
            "workspace": r["workspace"],
            "run_time": r["run_time"],
            "hours": list(r["hours"]),
        }
        hrrr.annotate_run(run_out, hrrr_state)
        runs_out.append(run_out)

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": now_iso(),
        "source": "noaa-hrrr",
        "models": {
            "hrrr": {
                "label": "HRRR (NOAA)",
                "products": hrrr.manifest_products(),
                "runs": runs_out,
            }
        },
    }


# ---------------------------------------------------------------------------
# catalog.json (master — uploaded LAST)
# ---------------------------------------------------------------------------

def build_catalog(
    fires: list[dict],
    *,
    version: int,
    incident_matches: dict[str, dict] | None = None,   # fire_slug -> {method, confidence, dir_url, synced_at}
    spread_index: dict[str, str] | None = None,        # fire_slug -> latest run_time
    national_layers: dict | None = None,               # {"current_year_perimeters": {"image", "bounds", "as_of"}}
) -> dict:
    incident_matches = incident_matches or {}
    spread_index = spread_index or {}
    fires_out = []
    for f in fires:
        slug = f["fire_slug"]
        m = incident_matches.get(slug)
        fires_out.append({
            "fire_slug": slug,
            "cornea_id": f.get("cornea_id"),
            "unique_fire_id": f.get("unique_fire_id"),
            "name": f.get("post_title"),
            "coordinates": f.get("coordinates"),
            "state": f.get("state"),
            "acres": f.get("acres"),
            "containment": f.get("containment"),
            "active": f.get("active"),
            "last_updated": f.get("last_updated"),
            "poly_last_updated": f.get("poly_last_updated"),
            "timezone": f.get("timezone"),
            "created_on": f.get("created_on"),
            "has_incident_maps": m is not None,
            "incident_manifest": f"/catalogs/incidents/{slug}.json" if m else None,
            "incident_last_synced": (m or {}).get("synced_at"),
            # directory-view summary (avoids fetching every per-fire manifest)
            "incident_map_count": (m or {}).get("map_count"),
            "incident_ir_count": (m or {}).get("ir_count"),
            "incident_latest_upload": (m or {}).get("latest_upload"),
            "ftp_match": (
                {"method": m["method"], "confidence": m["confidence"], "dir_url": m["dir_url"]}
                if m else None
            ),
            "has_spread_forecast": slug in spread_index,
            "spread_latest_run": spread_index.get(slug),
        })
    out = {
        "schema_version": SCHEMA_VERSION,
        "version": version,
        "generated_at": now_iso(),
        "fires": fires_out,
        "counts": {
            "active_fires": len(fires_out),
            "matched_incident_dirs": len(incident_matches),
            "spread_forecast_fires": len(spread_index),
        },
    }
    if national_layers:
        out["national_layers"] = national_layers
    return out


# ---------------------------------------------------------------------------
# catalogs/incidents/{fire_slug}.json
# ---------------------------------------------------------------------------

def build_incident_manifest(
    *,
    fire: dict,
    region: str,
    source_dir: str,
    unit_incident: str | None,
    maps: list[dict],
    ir_flights: list[dict],
) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "fire_slug": fire["fire_slug"],
        "cornea_id": fire.get("cornea_id"),
        "generated_at": now_iso(),
        "source_dir": source_dir,
        "region": region,
        "unit_incident": unit_incident,
        "maps": maps,
        "ir_flights": ir_flights,
    }


def rfc1123_to_iso(lm: str | None) -> str | None:
    """FTP Last-Modified ('Sun, 16 Aug 2026 03:18:07 GMT') -> UTC ISO, or None."""
    if not lm:
        return None
    try:
        dt = datetime.strptime(lm, "%a, %d %b %Y %H:%M:%S %Z")
        return dt.replace(tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None


def map_entry(
    *,
    parsed: dict,
    kind: str,
    sha_id: str,
    fire_slug: str,
    pdf_key: str,
    size_bytes: int | None,
    geo: dict | None,
    rev: int = 1,
    tiling_pending: bool = False,
    uploaded_lm: str | None = None,
) -> dict:
    geo = geo or {}
    tiles = None
    if geo.get("tiles"):
        tiles = {
            "url_template": f"/tiles/incidents/{fire_slug}/{sha_id}/{{z}}/{{x}}/{{y}}.png",
            "minzoom": geo["tiles"]["minzoom"],
            "maxzoom": geo["tiles"]["maxzoom"],
            "bounds": geo["tiles"]["bounds"],
        }
    entry = {
        "id": sha_id,
        "kind": kind,
        "product": parsed.get("product") or "other",
        "product_label": product_label(parsed),
        "sheet": parsed.get("sheet"),
        "orientation": parsed.get("orientation"),
        "op_date": parsed.get("op_date"),
        "period": parsed.get("period"),
        "generated_at_local": parsed.get("generated_at_local"),
        "uploaded_at": rfc1123_to_iso(uploaded_lm),
        "filename": parsed.get("filename"),
        "pdf_url": f"/{pdf_key}",
        "size_bytes": size_bytes,
        "georeferenced": bool(geo.get("georeferenced")),
        "projection": geo.get("projection"),
        "preview_url": (
            f"/previews/incidents/{fire_slug}/{sha_id}.png" if geo.get("preview") else None
        ),
        "tiles": tiles,
        "tiling_pending": tiling_pending,
        "rev": rev,
    }
    if geo.get("error"):
        entry["error"] = geo["error"]
    return entry
