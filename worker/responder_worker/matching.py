"""Fire <-> FTP-incident-dir and fire <-> pyrecast-slug matching.

Deterministic unit-token matching first, tolerant fuzzy name fallback second,
GACC->state constraint throughout, manual overrides as the escape hatch.
"""

from __future__ import annotations

import re
import urllib.parse
from collections import Counter
from dataclasses import dataclass, field

from rapidfuzz import fuzz

from . import config
from .fires import slugify

# Deterministic join key inside product filenames:
#   ops_arch_e_port_20260816_2100_Elk_COGMF000114_817day.pdf -> COGMF 000114
UNIT_TOKEN_RE = re.compile(r"_(?P<unit>[A-Z]{2}[A-Z0-9]{2,4})(?P<num>\d{6})(?=[_.])")

_PLACEHOLDER_RE = re.compile(r"^z?firename\d*$", re.I)

# runs of >=2 caps/digits stay one token (I5MM57NB); split lower->Upper and
# ACRONYMWord boundaries.
_CAMEL_1 = re.compile(r"(?<=[a-z])(?=[A-Z])")
_CAMEL_2 = re.compile(r"(?<=[A-Z])(?=[A-Z][a-z])")


def extract_unit_tokens(filenames: list[str], year: int = 2026) -> Counter:
    """Counter of candidate unique_fire_ids ('2026-COGMF-000114') from filenames."""
    counts: Counter = Counter()
    for fn in filenames:
        for m in UNIT_TOKEN_RE.finditer(fn):
            counts[f"{year}-{m.group('unit').upper()}-{m.group('num')}"] += 1
    return counts


def is_placeholder_dir(name: str) -> bool:
    """True for template dirs: FireName, zFireName4, YYMMDD-style templates."""
    stripped = re.sub(r"^\d{4}_", "", name)
    if _PLACEHOLDER_RE.fullmatch(stripped):
        return True
    return False


# "TX_TXTX_123456" / "FL_FNF_000833" style tokens embedded in a dir name —
# the Southern GACC's state subdirs name dirs this way with no year at all.
_UNIT_IN_NAME_RE = re.compile(r"[A-Z]{2}[_-][A-Z0-9]{2,4}[_-]\d{4,6}")


def candidate_dir_name(name: str, year: int = 2026, *, lenient: bool = False) -> str | None:
    """'2026_HayCreekComplex/' -> 'HayCreekComplex' or None if not a candidate.
    Also accepts the reversed 'Ross_2026' form. With lenient=True (state
    subdirectory roots), a dir whose name embeds a unit id ('MailBox_FL_FNF_
    002135') qualifies too — the unit-token matcher resolves it."""
    name = urllib.parse.unquote(name.rstrip("/"))
    if is_placeholder_dir(name):
        return None
    m = re.fullmatch(r"(?P<yr>\d{4})_(?P<rest>.+)", name)
    if m and int(m.group("yr")) == year:
        return m.group("rest")
    m = re.fullmatch(r"(?P<rest>.+)_(?P<yr>\d{4})", name)
    if m and int(m.group("yr")) == year:
        return m.group("rest")
    if lenient and _UNIT_IN_NAME_RE.search(name):
        return name
    return None


def normalize_name(raw: str) -> str:
    """Normalize a dir or fire name for comparison.

    2026_HayCreekComplex -> 'hay creek complex'; 2026_Aspen%20Acres ->
    'aspen acres'; 2026_P-L_Gulch -> 'p l gulch'; 2026_I5MM57NB -> 'i5mm57nb'.
    """
    s = urllib.parse.unquote(raw)
    s = re.sub(r"^\d{4}_", "", s)
    s = re.sub(r"_\d{4}$", "", s)  # year-suffixed dirs: Ross_2026
    s = _CAMEL_1.sub(" ", s)
    s = _CAMEL_2.sub(" ", s)
    s = re.sub(r"[_\-]+", " ", s)
    s = s.lower()
    s = re.sub(r"[^a-z0-9 ]+", "", s)
    return re.sub(r"\s+", " ", s).strip()


def name_variants(normalized: str) -> list[str]:
    """raw / trailing-'complex'-stripped / trailing-'fire'-stripped forms."""
    variants = [normalized]
    for suffix in (" complex", " fire"):
        if normalized.endswith(suffix):
            variants.append(normalized[: -len(suffix)].strip())
    return variants


@dataclass
class IncidentCandidate:
    region: str            # GACC key into config.GACC_STATES
    year: int
    dir_name: str          # raw listed name, e.g. "2026_Aspen Acres"
    dir_url: str
    dir_mtime: str | None = None
    unit_tokens: Counter = field(default_factory=Counter)  # from filenames

    @property
    def key(self) -> str:
        region_dir = re.sub(r"^(southern|eastern)_[a-z_]+$", r"\1", self.region)
        region_dir = region_dir.replace("pacific_nw_oregon", "pacific_nw").replace(
            "pacific_nw_washington", "pacific_nw"
        )
        return f"{region_dir}/{self.year}/{self.dir_name}"


@dataclass
class Match:
    fire_slug: str
    method: str      # unit_id | name_exact | name_fuzzy | override
    confidence: float
    token: str | None = None


def _allowed_states(region: str) -> set[str] | None:
    direct = config.GACC_STATES.get(region)
    if direct is not None:
        return direct
    # state-subdir keys like "southern_texas" narrow to that one state
    for gacc in config.STATE_SUBDIR_REGIONS:
        prefix = f"{gacc}_"
        if region.startswith(prefix):
            abbr = config.STATE_NAME_ABBR.get(region[len(prefix):].replace("_", " "))
            if abbr:
                return {abbr}
            return config.GACC_STATES.get(gacc)
    return None


def match_candidate(
    cand: IncidentCandidate,
    fires: list[dict],
    overrides: dict[str, str] | None = None,
) -> Match | None:
    """Match one incident dir to one active fire. None = unmatched."""
    overrides = overrides or {}
    ov = overrides.get(cand.key)
    if ov == "ignore":
        return None
    if ov:
        return Match(fire_slug=ov, method="override", confidence=1.0)

    by_uid = {
        (f.get("unique_fire_id") or "").upper(): f
        for f in fires
        if f.get("unique_fire_id")
    }

    # 1. deterministic unit token, majority vote
    if cand.unit_tokens:
        for token, _n in cand.unit_tokens.most_common():
            fire = by_uid.get(token.upper())
            if fire:
                return Match(
                    fire_slug=fire["fire_slug"],
                    method="unit_id",
                    confidence=1.0,
                    token=token,
                )

    # 2. fuzzy name fallback, constrained by GACC states
    states = _allowed_states(cand.region)
    pool = [f for f in fires if states is None or (f.get("state") in states)]
    dir_norm = normalize_name(cand.dir_name)
    dir_forms = name_variants(dir_norm)

    exact_hits: list[dict] = []
    fuzzy_hits: list[tuple[float, dict]] = []
    for f in pool:
        fire_norm = normalize_name(f.get("post_title") or "")
        if not fire_norm:
            continue
        fire_forms = name_variants(fire_norm)
        if any(df == ff for df in dir_forms for ff in fire_forms):
            exact_hits.append(f)
            continue
        score = max(fuzz.ratio(df, ff) for df in dir_forms for ff in fire_forms)
        if score >= 90:
            fuzzy_hits.append((score, f))

    if len(exact_hits) == 1:
        return Match(fire_slug=exact_hits[0]["fire_slug"], method="name_exact", confidence=0.95)
    if len(exact_hits) > 1:
        return None  # ambiguous tie -> unmatched (surface in report)
    if fuzzy_hits:
        fuzzy_hits.sort(key=lambda t: -t[0])
        if len(fuzzy_hits) > 1 and fuzzy_hits[0][0] == fuzzy_hits[1][0]:
            return None
        score, f = fuzzy_hits[0]
        return Match(fire_slug=f["fire_slug"], method="name_fuzzy", confidence=round(score / 100, 3))
    return None


# ---------------------------------------------------------------------------
# pyrecast slug matching (geoserver02 workspaces)
# ---------------------------------------------------------------------------

_SLUG_NUM_RE = re.compile(r"-(?P<num>\d{4,6})$")


def match_pyrecast_slug(slug: str, fires: list[dict]) -> tuple[dict | None, str, float]:
    """Match 'or-paradise' / 'ar-dallas-500153' to a fire.

    Returns (fire | None, method, confidence).
    """
    parts = slug.split("-", 1)
    if len(parts) != 2:
        return None, "unmatched", 0.0
    state, rest = parts[0].upper(), parts[1]

    stripped_num: str | None = None
    m = _SLUG_NUM_RE.search(rest)
    rest_nonum = rest
    if m:
        stripped_num = m.group("num")
        rest_nonum = rest[: m.start()]

    pool = [f for f in fires if f.get("state") == state]
    for candidate_rest in ([rest] if stripped_num is None else [rest_nonum, rest]):
        exact = [f for f in pool if slugify(f.get("post_title") or "") == candidate_rest]
        if len(exact) == 1:
            fire = exact[0]
            conf = 0.95
            method = "name_exact"
            if stripped_num and fire.get("unique_fire_id"):
                uid_num = fire["unique_fire_id"].rsplit("-", 1)[-1]
                try:
                    if int(uid_num) == int(stripped_num) or str(int(stripped_num)).endswith(
                        str(int(uid_num))
                    ):
                        conf, method = 1.0, "unit_num"
                except ValueError:
                    pass
            return fire, method, conf

    # fuzzy on normalized names
    best: tuple[float, dict] | None = None
    target = normalize_name(rest_nonum.replace("-", " "))
    for f in pool:
        score = fuzz.ratio(target, normalize_name(f.get("post_title") or ""))
        if score >= 90 and (best is None or score > best[0]):
            best = (score, f)
    if best:
        return best[1], "name_fuzzy", round(best[0] / 100, 3)
    return None, "unmatched", 0.0
