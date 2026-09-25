"""Normalize the three agency trail sources to one schema (pure).

Sources (docs/trails-routing/codebase-map/data-api-facts.md):
- USFS National Forest System trails, weekly EDW FGDB, TRAIL_TYPE='TERRA',
  UPPERCASE fields;
- BLM GTLF hosted FeatureServers: Public Managed Trails (/2) and the disjoint
  Not Assessed Trails (/7);
- NPS Public Trails MapServer/0.

Output fields (the GPKG, FlatGeobuf and MVT 'trails' layer):
  tid, agency, name, num, cls, uses, foot, restr, season, status, mgmt, unit,
  src_date

`uses` is a comma list of H hiker, P pack & saddle, B bicycle, M motorcycle,
A ATV/UTV, 4 4WD > 50"; '' means the source doesn't publish uses. `restr`
is display text for OFFICIAL restrictions — crews route on every trail
regardless (administrative use); the popup just tells them what the public
rules are. Each normalizer returns None to drop a row.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

FIELDS = ["tid", "agency", "name", "num", "cls", "uses", "foot", "restr",
          "season", "status", "mgmt", "unit", "src_date"]
LO_FIELDS = ["tid", "agency", "name", "num", "status"]

_KEEP_UPPER = {"NF", "FS", "NFS", "BLM", "NPS", "OHV", "ATV", "UTV", "II", "III",
               "IV", "VI", "NW", "NE", "SW", "SE", "USFS", "PCT", "CDT", "CCC",
               "TH", "RD", "HWY", "US", "SR", "MTB"}
_SMALL = {"of", "the", "and", "to", "at", "on", "in", "by"}


def _clean(v) -> str:
    if v is None:
        return ""
    return re.sub(r"\s+", " ", str(v)).strip()


def _word(w: str, first: bool) -> str:
    if not w:
        return w
    core = w.strip("()#.,")
    if core.upper() in _KEEP_UPPER or any(ch.isdigit() for ch in core):
        return w.upper()
    lw = w.lower()
    if not first and lw in _SMALL:
        return lw
    # capitalize after hyphens / slashes, but not after an apostrophe
    return re.sub(r"(^|[-/(])([a-z])", lambda m: m.group(1) + m.group(2).upper(), lw)


def tidy_name(v) -> str | None:
    """Trim, collapse spaces, and title-case ALL-CAPS names (keeping NF, BLM,
    route numbers...). Mixed-case names are left as the agency wrote them."""
    s = _clean(v)
    if not s or s.upper() in ("N/A", "NA", "NONE", "UNKNOWN", "UNNAMED", "NULL"):
        return None
    if re.search(r"[a-z]", s):
        return s
    words = s.split(" ")
    return " ".join(_word(w, i == 0) for i, w in enumerate(words))


def _window(v) -> str | None:
    """'05/15-09/15 ' -> '05/15–09/15'."""
    s = _clean(v)
    m = re.fullmatch(r"(\d{2}/\d{2})\s*-\s*(\d{2}/\d{2})", s)
    return f"{m.group(1)}–{m.group(2)}" if m else (s or None)


def _join(parts) -> str | None:
    out = [p for p in parts if p]
    return "; ".join(out) if out else None


# ---------------------------------------------------------------------------
# USFS
# ---------------------------------------------------------------------------

_USFS_USE = {"1": "H", "2": "P", "3": "B", "4": "M", "5": "A", "6": "4"}
USE_ORDER = "HPBMA4"


def _ordered(letters) -> str:
    have = set(letters)
    return ",".join(c for c in USE_ORDER if c in have)


def usfs_uses(code) -> tuple[str, str]:
    """ALLOWED_TERRA_USE ('54321', 'N/A', None) -> (uses, foot)."""
    s = _clean(code).upper()
    digits = [c for c in s if c in _USFS_USE]
    if not digits:
        return "", "unknown"
    uses = _ordered(_USFS_USE[d] for d in digits)
    return uses, ("yes" if "1" in digits else "no")


def normalize_usfs(p: dict, src_date: str) -> dict | None:
    cn = _clean(p.get("TRAIL_CN"))
    if not cn:
        return None
    try:
        bmp = float(p.get("BMP") or 0)
    except (TypeError, ValueError):
        bmp = 0.0
    uses, foot = usfs_uses(p.get("ALLOWED_TERRA_USE"))
    restricted = _window(p.get("HIKER_PEDESTRIAN_RESTRICTED"))
    restr = _join([
        f"Hiker restricted {restricted}" if restricted else None,
        "Hiking not listed as an allowed use" if foot == "no" else None,
    ])
    cls = _clean(p.get("TRAIL_CLASS"))
    sma = _clean(p.get("SPECIAL_MGMT_AREA")).upper()
    mgmt = _join([
        "Wilderness" if "WILDERNESS" in sma else None,
        "National Scenic/Historic Trail" if _clean(p.get("NATIONAL_TRAIL_DESIGNATION")) == "3" else None,
    ])
    return {
        "tid": f"usfs:{cn}:{bmp:.3f}",
        "agency": "USFS",
        "name": tidy_name(p.get("TRAIL_NAME")),
        "num": _clean(p.get("TRAIL_NO")) or None,
        "cls": int(cls) if cls in ("1", "2", "3", "4", "5") else 0,
        "uses": uses,
        "foot": foot,
        "restr": restr,
        "season": _window(p.get("HIKER_PEDESTRIAN_MANAGED")),
        "status": "open",
        "mgmt": mgmt,
        "unit": None,
        "src_date": src_date,
    }


# ---------------------------------------------------------------------------
# BLM
# ---------------------------------------------------------------------------

_BLM_USE = {
    "HIK_ONLY": "H", "EQU_HIK_ONLY": "HP", "BIKE_HIK_ONLY": "HB",
    "NON_MOTO_SHARED": "HPB", "MTC_ATV_SHARED": "MA", "TECH_VEH_SHARED": "MA4",
}
_BLM_ACCESS = {
    "ADMIN ONLY": "Admin only (agency/fire use)",
    "AUTHORIZED/PERMITTED USER ONLY": "Authorized/permitted users only",
    "LIMITED BY VEHICLE TYPE": "Limited by vehicle type",
}


def _code(v) -> str:
    return re.sub(r"\s*/\s*", "/", _clean(v).upper())


def normalize_blm(p: dict, layer: str, src_date: str) -> dict | None:
    """layer: 'managed' (FeatureServer/2) or 'not_assessed' (/7)."""
    oid = p.get("OBJECTID")
    if oid is None:
        return None
    mode = _code(p.get("PLAN_ALLOW_MODE_TRNSPRT")).replace(" ", "_")
    letters = _BLM_USE.get(mode, "")
    uses = _ordered(letters)
    foot = "yes" if "H" in letters else "unknown"
    season = _clean(p.get("PLAN_SEASON_RSTRCT_CODE"))
    if season.upper() in ("", "NONE", "UNK", "UNKNOWN", "N/A"):
        season = ""
    observed = _code(p.get("OBSRVE_ROUTE_USE_CLASS"))
    restr = _join([
        _BLM_ACCESS.get(_code(p.get("PLAN_ACCESS_RSTRCT"))),
        "Observed impassable" if observed == "IMPASSABLE" else None,
    ])
    special = _clean(p.get("ROUTE_SPCL_DSGNTN_TYPE"))
    st = _clean(p.get("ADMIN_ST")).upper()
    return {
        "tid": f"blm:{'n' if layer == 'not_assessed' else 'm'}{int(oid)}",
        "agency": "BLM",
        "name": tidy_name(p.get("ROUTE_PRMRY_NM")),
        "num": None,
        "cls": 0,
        "uses": uses,
        "foot": foot,
        "restr": restr,
        "season": season or None,
        "status": "not_assessed" if layer == "not_assessed" else "open",
        "mgmt": tidy_name(special) if special.upper() not in ("", "NONE", "UNKNOWN", "N/A") else None,
        "unit": f"BLM {st}" if st else "BLM",
        "src_date": src_date,
    }


# ---------------------------------------------------------------------------
# NPS
# ---------------------------------------------------------------------------

NPS_DROP_STATUS = {"DECOMMISSIONED", "ABANDONED", "PROPOSED"}
NPS_DROP_TYPE = {"WATER TRAIL", "SNOW TRAIL", "FERRY ROUTE"}
_NPS_TOKENS = [
    (("HIKER", "PEDESTRIAN", "HIKE", "HIKING", "WALK", "FOOT"), "H"),
    (("HORSE", "EQUESTRIAN", "PACK", "STOCK", "SADDLE"), "P"),
    (("BICYCLE", "BIKE", "MOUNTAIN BIKE", "CYCLING"), "B"),
    (("MOTORCYCLE",), "M"),
    (("ATV", "OHV", "UTV"), "A"),
    (("4WD", "HIGH CLEARANCE"), "4"),
]


def nps_uses(v) -> tuple[str, str]:
    toks = [t.strip() for t in re.split(r"[|,/;]", _clean(v).upper()) if t.strip()]
    letters = set()
    for t in toks:
        for words, letter in _NPS_TOKENS:
            if any(w in t for w in words):
                letters.add(letter)
    if not letters:
        return "", "unknown"
    return _ordered(letters), ("yes" if "H" in letters else "unknown")


def _epoch_date(v) -> str | None:
    try:
        ms = float(v)
    except (TypeError, ValueError):
        s = _clean(v)
        return s[:10] if re.match(r"\d{4}-\d{2}-\d{2}", s) else None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def normalize_nps(p: dict, fallback_date: str) -> dict | None:
    if _clean(p.get("PUBLICDISPLAY")) not in ("", "Public Map Display"):
        return None
    if _clean(p.get("DATAACCESS")) not in ("", "Unrestricted"):
        return None
    status_raw = _clean(p.get("TRLSTATUS")).upper()
    if status_raw in NPS_DROP_STATUS or _clean(p.get("TRLTYPE")).upper() in NPS_DROP_TYPE:
        return None
    oid = p.get("OBJECTID")
    if oid is None:
        return None
    feat = _clean(p.get("TRLFEATTYPE")).upper()
    closed = status_raw == "TEMPORARILY CLOSED"
    status = "closed" if closed else ("unofficial" if feat == "UNOFFICIAL TRAIL" else "open")
    m = re.search(r"([1-5])", _clean(p.get("TRLCLASS")))
    uses, foot = nps_uses(p.get("TRLUSE"))
    seasonal = _clean(p.get("SEASONAL")).upper() in ("YES", "Y", "TRUE")
    name = (tidy_name(p.get("TRLNAME")) or tidy_name(p.get("MAPLABEL"))
            or tidy_name(p.get("TRLALTNAME")))
    return {
        "tid": f"nps:{int(oid)}",
        "agency": "NPS",
        "name": name,
        "num": None,
        "cls": int(m.group(1)) if m else 0,
        "uses": uses,
        "foot": foot,
        "restr": "Temporarily closed" if closed else None,
        "season": (_clean(p.get("SEASDESC")) or "Seasonal") if seasonal else None,
        "status": status,
        "mgmt": None,
        "unit": _clean(p.get("UNITNAME")) or None,
        "src_date": _epoch_date(p.get("EDITDATE")) or fallback_date,
    }
