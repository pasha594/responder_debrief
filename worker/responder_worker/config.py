"""Central configuration: endpoints, region roots, product vocab, caps, retention."""

from __future__ import annotations

import json
import os
from pathlib import Path

# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

FIRE_API = "https://fire-api-prod.web.app"
GS01_OWS = "https://geoserver-usw1.pyrecast.org/geoserver01/ows"
GS02_OWS = "https://geoserver-usw1.pyrecast.org/geoserver02/ows"
FTP_BASE = "https://ftp.wildfire.gov/public/incident_specific_maps"

WMS_PROXY = {"gs01": "/wms01", "gs02": "/wms02"}

USER_AGENT = "responder-debrief-mirror/1.0 (contact: pashaminkovsky@gmail.com)"

# ---------------------------------------------------------------------------
# Politeness / budgets
# ---------------------------------------------------------------------------

MAX_CONCURRENT_LISTINGS = 2
MAX_CONCURRENT_DOWNLOADS = 4
LISTING_DELAY_S = 0.5  # ~1 rps listings, stay gentle
HTTP_TIMEOUT_S = 60.0
RETRY_ATTEMPTS = 3

FRAMES_CONCURRENCY = 2   # max concurrent GetMap requests per geoserver
FRAME_BUDGET_DEFAULT = 3000  # images per sync (env FRAME_BUDGET overrides)

PRODUCTS_DAILY_KEEP = 3  # newest N Products|GIS/YYYYMMDD dirs
IR_KEEP = 7              # newest N IR/ entries
MOBILE_CAP_MB = 40       # Avenza mobile PDFs above this are skipped
TILE_BUDGET = 40         # GeoPDF sheets tiled per run
TILER_VERSION = 1
PRUNE_INACTIVE_DAYS = 14

# ---------------------------------------------------------------------------
# FTP region roots (the 11 GACC dirs observed live at FTP_BASE)
# ---------------------------------------------------------------------------

FTP_REGIONS = [
    "alaska",
    "calif_n",
    "calif_s",
    "california_statewide",
    "eastern",
    "great_basin",
    "n_rockies",
    "pacific_nw",
    "rocky_mtn",
    "southern",
    "southwest",
]

# GACC region dir -> allowed fire states (used to disambiguate duplicate names).
GACC_STATES: dict[str, set[str]] = {
    "alaska": {"AK"},
    "calif_n": {"CA"},
    "calif_s": {"CA"},
    "california_statewide": {"CA"},
    "eastern": {
        "MN", "WI", "MI", "IA", "IL", "IN", "OH", "MO",
        "NH", "VT", "ME", "MA", "CT", "RI", "NY", "NJ",
        "PA", "DE", "MD", "WV",
    },
    "great_basin": {"NV", "UT", "ID", "WY", "AZ"},
    "n_rockies": {"MT", "ND", "ID"},
    "pacific_nw": {"OR", "WA"},
    "pacific_nw_oregon": {"OR"},
    "pacific_nw_washington": {"WA"},
    "rocky_mtn": {"CO", "WY", "SD", "NE", "KS"},
    "southern": {
        "TX", "OK", "AR", "LA", "MS", "AL", "GA", "FL",
        "SC", "NC", "TN", "KY", "VA", "PR",
    },
    "southwest": {"AZ", "NM", "TX"},
}

# pacific_nw splits into per-state year roots and uses GIS/ instead of Products/.
def region_year_roots(year: int) -> list[tuple[str, str]]:
    """(region_key, url) pairs to crawl for candidate incident dirs."""
    roots: list[tuple[str, str]] = []
    for region in FTP_REGIONS:
        if region == "pacific_nw":
            roots.append(("pacific_nw_oregon", f"{FTP_BASE}/pacific_nw/{year}_Incidents_Oregon/"))
            roots.append(("pacific_nw_washington", f"{FTP_BASE}/pacific_nw/{year}_Incidents_Washington/"))
        else:
            roots.append((region, f"{FTP_BASE}/{region}/{year}/"))
    return roots


# ---------------------------------------------------------------------------
# Incident-map product vocabulary
# ---------------------------------------------------------------------------

PRODUCT_LABELS = {
    "ops": "Operations Map",
    "brief": "Briefing Map",
    "iap": "IAP Map",
    "pio": "Public Information Map",
    "airops": "Air Operations Map",
    "evac": "Evacuation Map",
    "trans": "Transportation Map",
    "owner": "Land Ownership Map",
    "suprep": "Suppression Repair Map",
    "suppression_repair": "Suppression Repair Map",
    "mobile": "Avenza Mobile Map",
    "other": "Map",
}

# tiling priority: lower = first
PRODUCT_PRIORITY = {
    "ops": 0, "brief": 1, "iap": 2, "airops": 3,
    "evac": 4, "trans": 5, "pio": 6, "other": 7,
}

SHEET_DPI = {
    "8x11": 300, "85x11": 300, "8.5x11": 300, "11x17": 300,
    "arch_c": 200, "arch_d": 200,
    "arch_e": 150,
}
DEFAULT_DPI = 200

# ---------------------------------------------------------------------------
# Weather (gs01) products
# ---------------------------------------------------------------------------

WEATHER_PRODUCTS = {
    "tmpf": {"label": "Temperature (°F)"},
    "rh": {"label": "Relative humidity"},
    "ws": {"label": "Wind speed"},
    "wg": {"label": "Wind gust"},
    "wd": {"label": "Wind direction"},
    "ffwi": {"label": "Fosberg fire wx index"},
    "smoke": {"label": "Near-surface smoke"},
    "tcdc": {"label": "Cloud cover"},
    "pign": {"label": "P(ignition)"},
    "meq": {"label": "Fuel moisture eq."},
    "apcp01": {"label": "1-h precip"},
    "apcptot": {"label": "Run-total precip"},
}

# The 8 fire-critical products pre-rendered as frames (and the only ones in
# the v1 weather manifest — tcdc/pign/meq/apcptot are dropped).
WEATHER_FRAME_PRODUCTS = ["tmpf", "rh", "ws", "wg", "wd", "ffwi", "smoke", "apcp01"]

# ---------------------------------------------------------------------------
# Pre-rendered frames (docs/spec-frames.md)
# ---------------------------------------------------------------------------

SPREAD_FRAME_PERCENTILES = [10, 50]  # user decision: median + low-percentile scenario
SPREAD_FRAME_MAX_DIM = 1536       # run-bbox GetMap max edge, aspect-correct
WEATHER_FRAME_WIDTH = 2560        # CONUS width (height aspect-correct)
NATIONAL_FRAME_WIDTH = 2048       # national perimeters snapshot width
CONUS_BOUNDS = [-125.0, 24.5, -66.5, 49.5]  # [w, s, e, n] EPSG:4326

# ---------------------------------------------------------------------------
# B2 / cache-control
# ---------------------------------------------------------------------------

B2_ENV = ("B2_S3_ENDPOINT", "B2_KEY_ID", "B2_APP_KEY", "B2_BUCKET")

CACHE_CONTROL_RULES: list[tuple[str, str]] = [
    # (key prefix, Cache-Control) — first match wins
    ("frames/national/", "public, max-age=300"),          # mutable snapshot
    ("frames/legends/", "public, max-age=86400"),
    ("frames/", "public, max-age=31536000, immutable"),   # run-stamped frames
    ("tiles/", "public, max-age=31536000, immutable"),
    ("previews/", "public, max-age=31536000, immutable"),
    ("vectors/", "public, max-age=31536000, immutable"),
    ("catalogs/versions/", "public, max-age=31536000"),
    ("catalogs/", "public, max-age=60, must-revalidate"),
    ("state/", "private, no-store"),
]


def cache_control_for_key(key: str) -> str:
    for prefix, cc in CACHE_CONTROL_RULES:
        if key.startswith(prefix):
            return cc
    if key.startswith("raw/") and "/qr/" in key:
        return "public, max-age=300"
    if key.startswith("raw/"):
        return "public, max-age=604800"
    return "public, max-age=300"


CONTENT_TYPES = {
    ".json": "application/json",
    ".geojson": "application/geo+json",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".kmz": "application/vnd.google-earth.kmz",
    ".txt": "text/plain",
    ".zip": "application/zip",
    ".html": "text/html",
}


def content_type_for_key(key: str) -> str:
    return CONTENT_TYPES.get(Path(key).suffix.lower(), "application/octet-stream")


# ---------------------------------------------------------------------------
# Match overrides
# ---------------------------------------------------------------------------

CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"
MATCH_OVERRIDES_PATH = CONFIG_DIR / "match_overrides.json"


def load_match_overrides(path: Path | None = None) -> dict[str, str]:
    p = path or MATCH_OVERRIDES_PATH
    if not p.exists():
        return {}
    data = json.loads(p.read_text())
    return {k: v for k, v in data.items() if not k.startswith("_")}


def b2_settings_from_env() -> dict[str, str]:
    missing = [k for k in B2_ENV if not os.environ.get(k)]
    if missing:
        raise RuntimeError(
            f"Missing B2 env vars: {', '.join(missing)} (use --dry-run for local runs)"
        )
    return {k: os.environ[k] for k in B2_ENV}
