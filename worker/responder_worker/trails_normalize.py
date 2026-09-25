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
# Placeholder values the services use for "no value" (live: USFS 'N/A' in
# 9,810 TERRA rows' use/season/restriction fields, BLM '<Null>' names).
_NA = {"N/A", "NA", "NONE", "UNKNOWN", "UNK", "UNNAMED", "NULL", "<NULL>"}


def _clean(v) -> str:
    if v is None:
        return ""
    s = re.sub(r"\s+", " ", str(v))
    return re.sub(r"[\x00-\x1f\x7f]", "", s).strip()  # NPS has a '\x08D & H Canal Trail'


def _word(w: str, first: bool) -> str:
    if not w:
        return w
    core = w.strip("()#.,:;")  # 'PCT:' keeps its capitals
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
    if not s or s.upper() in _NA:
        return None
    if re.search(r"[a-z]", s):
        return s
    words = s.split(" ")
    return " ".join(_word(w, i == 0) for i, w in enumerate(words))


def _window(v) -> str | None:
    """'05/15-09/15 ' -> '05/15–09/15'; 'N/A' -> None."""
    s = _clean(v)
    if s.upper() in _NA:
        return None
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
_CLASSES = ("1", "2", "3", "4", "5")

# The FGDB is one layer whose ATTRIBUTESUBSET says how much each forest
# publishes. TrailNFS_Centerline rows (4,520 TERRA rows from 16 forests on
# 2026-09-23, every USFS trail around the SISI fire among them) carry only
# the name, number, org codes and map symbol: TRAIL_CLASS 'N' and 'N/A' in
# every use, season and area field. Their TRAIL_CNs appear in no other
# subset, and their TRAIL_NOs only match other trails (other PCT sections,
# other forests' numbers), so no join recovers the uses. Two fields survive:
# TERRA_BASE_SYMBOLOGY, the class band the map symbol is drawn from ('TC3'
# is class 3 on all 38,725 attributed rows; 'TC1-2' and 'TC4-5' don't say
# which class, so they stay 0), and ADMIN_ORG (below).

# ADMIN_ORG is RRFFDD (region, forest, ranger district); its first four
# digits are the administrative forest. Names as the EDW Administrative
# Forest Boundaries layer (FORESTORGCODE -> FORESTNAME) served them on
# 2026-09-25; they cover all but 33 of 78,156 TERRA rows (those have no org
# or a region-only '01').
USFS_FORESTS = {
    "0102": "Beaverhead-Deerlodge National Forest", "0103": "Bitterroot National Forest",
    "0104": "Idaho Panhandle National Forests", "0110": "Flathead National Forest",
    "0111": "Custer Gallatin National Forest", "0114": "Kootenai National Forest",
    "0115": "Helena-Lewis and Clark National Forest", "0116": "Lolo National Forest",
    "0117": "Nez Perce-Clearwater National Forest", "0118": "Dakota Prairie Grasslands",
    "0202": "Bighorn National Forest", "0203": "Black Hills National Forest",
    "0204": "Grand Mesa, Uncompahgre and Gunnison National Forests",
    "0206": "Medicine Bow-Routt National Forest", "0207": "Nebraska National Forest",
    "0209": "Rio Grande National Forest", "0210": "Arapaho and Roosevelt National Forests",
    "0212": "Pike and San Isabel National Forests", "0213": "San Juan National Forest",
    "0214": "Shoshone National Forest", "0215": "White River National Forest",
    "0301": "Apache-Sitgreaves National Forests", "0302": "Carson National Forest",
    "0303": "Cibola National Forest", "0304": "Coconino National Forest",
    "0305": "Coronado National Forest", "0306": "Gila National Forest",
    "0307": "Kaibab National Forest", "0308": "Lincoln National Forest",
    "0309": "Prescott National Forest", "0310": "Santa Fe National Forest",
    "0312": "Tonto National Forest", "0401": "Ashley National Forest",
    "0402": "Boise National Forest", "0403": "Bridger-Teton National Forest",
    "0407": "Dixie National Forest", "0408": "Fishlake National Forest",
    "0410": "Manti-La Sal National Forest", "0412": "Payette National Forest",
    "0413": "Salmon-Challis National Forest", "0414": "Sawtooth National Forest",
    "0415": "Caribou-Targhee National Forest", "0417": "Humboldt-Toiyabe National Forest",
    "0419": "Uinta-Wasatch-Cache National Forest", "0501": "Angeles National Forest",
    "0502": "Cleveland National Forest", "0503": "Eldorado National Forest",
    "0504": "Inyo National Forest", "0505": "Klamath National Forest",
    "0506": "Lassen National Forest", "0507": "Los Padres National Forest",
    "0508": "Mendocino National Forest", "0509": "Modoc National Forest",
    "0510": "Six Rivers National Forest", "0511": "Plumas National Forest",
    "0512": "San Bernardino National Forest", "0513": "Sequoia National Forest",
    "0514": "Shasta-Trinity National Forest", "0515": "Sierra National Forest",
    "0516": "Stanislaus National Forest", "0517": "Tahoe National Forest",
    "0519": "Lake Tahoe Basin Management Unit", "0601": "Deschutes National Forest",
    "0602": "Fremont-Winema National Forest", "0603": "Gifford Pinchot National Forest",
    "0604": "Malheur National Forest", "0605": "Mt. Baker-Snoqualmie National Forest",
    "0606": "Mt. Hood National Forest", "0607": "Ochoco National Forest",
    "0609": "Olympic National Forest", "0610": "Rogue River-Siskiyou National Forests",
    "0612": "Siuslaw National Forest", "0614": "Umatilla National Forest",
    "0615": "Umpqua National Forest", "0616": "Wallowa-Whitman National Forest",
    "0617": "Okanogan-Wenatchee National Forest", "0618": "Willamette National Forest",
    "0621": "Colville National Forest", "0622": "Columbia River Gorge National Scenic Area",
    "0801": "National Forests in Alabama", "0802": "Daniel Boone National Forest",
    "0803": "Chattahoochee-Oconee National Forests", "0804": "Cherokee National Forest",
    "0805": "National Forests in Florida", "0806": "Kisatchie National Forest",
    "0807": "National Forests in Mississippi",
    "0808": "George Washington and Jefferson National Forest",
    "0809": "Ouachita National Forest", "0810": "Ozark-St. Francis National Forest",
    "0811": "National Forests in North Carolina",
    "0812": "Francis Marion and Sumter National Forests", "0813": "National Forests in Texas",
    "0816": "El Yunque National Forest", "0836": "Savannah River Site",
    "0860": "Land Between the Lakes National Recreation Area",
    "0903": "Chippewa National Forest", "0904": "Huron-Manistee National Forest",
    "0905": "Mark Twain National Forest", "0907": "Ottawa National Forest",
    "0908": "Shawnee National Forest", "0909": "Superior National Forest",
    "0910": "Hiawatha National Forest", "0912": "Hoosier National Forest",
    "0913": "Chequamegon-Nicolet National Forest", "0914": "Wayne National Forest",
    "0915": "Midewin National Tallgrass Prairie", "0919": "Allegheny National Forest",
    "0920": "Green Mountain and Finger Lakes National Forests",
    "0921": "Monongahela National Forest", "0922": "White Mountain National Forest",
    "1004": "Chugach National Forest", "1005": "Tongass National Forest",
}


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


def usfs_class(trail_class, symbology) -> int:
    """TRAIL_CLASS '1'..'5', else the TC3 symbol band; 0 = unknown."""
    cls = _clean(trail_class)
    if cls in _CLASSES:
        return int(cls)
    return 3 if _clean(symbology).upper() == "TC3" else 0


def usfs_unit(org) -> str | None:
    """ADMIN_ORG ('061702') -> 'Okanogan-Wenatchee National Forest'."""
    s = _clean(org)
    return USFS_FORESTS.get(s[:4]) if len(s) >= 4 else None


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
    sma = _clean(p.get("SPECIAL_MGMT_AREA")).upper()
    # live SPECIAL_MGMT_AREA holds 'WSA - WILDERNESS STUDY AREA' (not designated
    # Wilderness); NATIONAL_TRAIL_DESIGNATION 3 = PCT/AT/CDT/NCT, 2 = NRTs
    ntd = _clean(p.get("NATIONAL_TRAIL_DESIGNATION"))
    mgmt = _join([
        "Wilderness Study Area" if "WILDERNESS STUDY" in sma
        else ("Wilderness" if "WILDERNESS" in sma else None),
        {"3": "National Scenic/Historic Trail", "2": "National Recreation Trail"}.get(ntd),
    ])
    return {
        "tid": f"usfs:{cn}:{bmp:.3f}",
        "agency": "USFS",
        # verbatim apart from case: USFS names PCT sections 'PCT: <section>'
        # (401 TERRA rows), so the popup reads 'PCT: Glacier Peak Wilderness #2000'
        "name": tidy_name(p.get("TRAIL_NAME")),
        "num": _clean(p.get("TRAIL_NO")) or None,
        "cls": usfs_class(p.get("TRAIL_CLASS"), p.get("TERRA_BASE_SYMBOLOGY")),
        "uses": uses,
        "foot": foot,
        "restr": restr,
        "season": _window(p.get("HIKER_PEDESTRIAN_MANAGED")),
        "status": "open",
        "mgmt": mgmt,
        "unit": usfs_unit(p.get("ADMIN_ORG")),
        "src_date": src_date,
    }


# ---------------------------------------------------------------------------
# BLM
# ---------------------------------------------------------------------------

# PLAN_ALLOW_MODE_TRNSPRT, per the layer's coded-value domain (e.g.
# MTC_ATV_SHARED = 'Shared Motorcycle, ATV, Mountain Bike, Electric Mountain
# Bike, Equestrian, Hiking'). Only what a label names: MTC_SHARED's is just
# 'Motorcycle Shared', so it is motorcycle with foot 'unknown' (1,637 live
# trails), never an inferred hiker. STRT_LGL_VEH ('Licensed Street-Legal
# Vehicles Only') has no live rows yet. UNK and the over-snow codes publish
# no summer use.
_BLM_USE = {
    "HIK_ONLY": "H", "EQU_ONLY": "P", "EQU_HIK_ONLY": "HP", "BIKE_ONLY": "B",
    "BIKE_HIK_ONLY": "HB", "NON_MOTO_SHARED": "HPB",
    "MTC_ONLY": "M", "TECH_MTC_ONLY": "M", "MTC_SHARED": "M",
    "MTC_ATV_ONLY": "MA", "MTC_ATV_UTV_ONLY": "MA",
    "MTC_ATV_SHARED": "HPBMA", "MTC_ATV_UTV_SHARED": "HPBMA",
    "ALL_MOTO_VEH": "HPBMA4", "TECH_VEH_SHARED": "HPBMA4", "TECH_HI_CLEAR_VEH_ONLY": "4",
    "STRT_LGL_VEH": "4",
}
_BLM_DESIGNATION = {"NST": "National Scenic Trail", "NHT": "National Historic Trail",
                    "NRT": "National Recreation Trail"}
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
    # a YES/NO/UNK status (domain 'Planned Seasonal Restriction Status'), not a window
    seasonal = _code(p.get("PLAN_SEASON_RSTRCT_CODE")) == "YES"
    observed = _code(p.get("OBSRVE_ROUTE_USE_CLASS"))
    restr = _join([
        _BLM_ACCESS.get(_code(p.get("PLAN_ACCESS_RSTRCT"))),
        "Observed impassable" if observed == "IMPASSABLE" else None,
    ])
    special = _clean(p.get("ROUTE_SPCL_DSGNTN_TYPE"))
    special = _BLM_DESIGNATION.get(special.upper()) or tidy_name(special)
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
        "season": "Seasonal restrictions" if seasonal else None,
        "status": "not_assessed" if layer == "not_assessed" else "open",
        "mgmt": special,
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
    (("BICYCLE", "BIKE", "MOUNTAIN BIKE", "CYCLING", "BIKING"), "B"),
    (("MOTORCYCLE",), "M"),
    # live TRLUSE spells them out: 'All-Terrain Vehicle' (~1,080 rows),
    # 'Four-Wheel Drive Vehicle > 50” in Tread Width'
    (("ATV", "OHV", "UTV", "ALL-TERRAIN"), "A"),
    (("4WD", "HIGH CLEARANCE", "FOUR-WHEEL"), "4"),
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
