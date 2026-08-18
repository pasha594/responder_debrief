"""NIFC Incident Management Situation Report (IMSR) -> per-fire resources.

The daily sit report (https://www.nifc.gov/nicc-files/sitreprt.pdf, posted
~0730 MDT in season) carries the ICS-209-derived table responders asked for:
crews / engines / helicopters, personnel with day-over-day change, estimated
containment date, cost to date — plus a narrative paragraph per incident
(team, fuels, behavior, threats). Parse it with pdftotext -layout (poppler)
and match rows to active fires by normalized name + state.

Missing poppler or a fetch failure degrades to "no imsr.json this sync" —
never fatal to the catalogs job.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import httpx

from .catalogs import now_iso
from .http import get
from .matching import normalize_name

IMSR_URL = "https://www.nifc.gov/nicc-files/sitreprt.pdf"
SCHEMA_VERSION = 1

# One table row, name column excluded (it may sit on the previous line when
# long): unit, acres, acres chge, %, Ctn|Comp, est date, personnel, chge,
# crews, engines, helicopters, structures lost, cost, owner.
_ROW_RE = re.compile(
    r"(?P<unit>[A-Z]{2}-[A-Z0-9]{2,5})\s+"
    r"(?P<acres>[\d,]+)\s+"
    r"(?P<achge>-?[\d,]+|---|UNK)\s+"
    r"(?P<pct>\d{1,3}|---|UNK)\s+"
    r"(?P<kind>Ctn|Comp)\s+"
    r"(?P<est>\d{1,2}/\d{1,2}|UNK|---|NR)\s+"
    r"(?P<pers>[\d,]+|---)\s+"
    r"(?P<pchge>-?[\d,]+|---|UNK)\s+"
    r"(?P<crw>\d+)\s+(?P<eng>\d+)\s+(?P<heli>\d+)\s+"
    r"(?P<strc>\d+)\s+"
    r"(?P<cost>[\d.,]+[KMB]?|UNK|NR|---)\s+"
    r"(?P<own>[A-Z]{2,8})\s*$"
)


def _num(tok: str) -> int | None:
    tok = tok.replace(",", "")
    try:
        return int(tok)
    except ValueError:
        return None


def parse_imsr_rows(text: str) -> list[dict]:
    """Table rows across every GACC section. Rows whose (long) name wrapped
    onto its own line take the closest preceding non-empty line as the name."""
    rows: list[dict] = []
    lines = text.splitlines()
    for i, line in enumerate(lines):
        m = _ROW_RE.search(line)
        if not m:
            continue
        name = line[: m.start()].strip(" *")
        if not name:
            for j in range(i - 1, max(-1, i - 3), -1):
                prev = lines[j].strip(" *")
                if prev and not _ROW_RE.search(lines[j]):
                    name = prev
                    break
        if not name:
            continue
        rows.append({
            "name": name,
            "unit": m.group("unit"),
            "acres": _num(m.group("acres")),
            "acres_change": _num(m.group("achge")),
            "contained_pct": _num(m.group("pct")),
            "containment_kind": m.group("kind"),  # Ctn | Comp
            "est_containment": (
                m.group("est") if "/" in m.group("est") else None
            ),
            "personnel": _num(m.group("pers")),
            "personnel_change": _num(m.group("pchge")),
            "crews": _num(m.group("crw")),
            "engines": _num(m.group("eng")),
            "helicopters": _num(m.group("heli")),
            "structures_lost": _num(m.group("strc")),
            "cost_to_date": (
                None if m.group("cost") in ("UNK", "NR", "---")
                else m.group("cost")
            ),
            "owner": m.group("own"),
        })
    return rows


def parse_imsr_narratives(text: str) -> dict[str, str]:
    """Incident narratives: a paragraph opening "Name, Unit..." after the
    tables. Keyed by normalized name (first paragraph wins on collisions)."""
    out: dict[str, str] = {}
    paragraphs = re.split(r"\n\s*\n", text)
    for para in paragraphs:
        flat = " ".join(ln.strip() for ln in para.strip().splitlines())
        m = re.match(r"^([A-Z][A-Za-z0-9''\. ]{2,40}?),\s", flat)
        if not m:
            continue
        key = normalize_name(m.group(1))
        if key and key not in out:
            out[key] = flat
    return out


def _state_of_unit(unit: str) -> str:
    return unit.split("-", 1)[0]


def match_imsr(rows: list[dict], narratives: dict[str, str],
               fires: list[dict]) -> dict[str, dict]:
    """fire_slug -> imsr entry. Name must match exactly (normalized) AND the
    unit's state must equal the fire's state — duplicate incident names in
    different states are common."""
    by_key: dict[tuple[str, str], dict] = {}
    for f in fires:
        key = (normalize_name(f.get("post_title") or ""), f.get("state") or "")
        by_key.setdefault(key, f)

    out: dict[str, dict] = {}
    for row in rows:
        norm = normalize_name(row["name"])
        fire = by_key.get((norm, _state_of_unit(row["unit"])))
        if fire is None:
            continue
        entry = dict(row)
        entry["narrative"] = narratives.get(norm)
        out[fire["fire_slug"]] = entry
    return out


def pdf_to_text(pdf_bytes: bytes) -> str | None:
    """pdftotext -layout, or None when poppler isn't installed."""
    if shutil.which("pdftotext") is None:
        return None
    with tempfile.TemporaryDirectory() as td:
        pdf = Path(td) / "imsr.pdf"
        pdf.write_bytes(pdf_bytes)
        res = subprocess.run(
            ["pdftotext", "-layout", str(pdf), "-"],
            capture_output=True, text=True,
        )
        return res.stdout if res.returncode == 0 else None


def build_imsr_catalog(client: httpx.Client, fires: list[dict],
                       log=print) -> dict | None:
    """catalogs/imsr.json payload, or None when the report is unavailable
    (fetch failure, poppler missing, or nothing parsed)."""
    try:
        pdf = get(client, IMSR_URL).content
    except Exception as exc:
        log(f"[imsr] fetch failed: {exc}")
        return None
    text = pdf_to_text(pdf)
    if text is None:
        log("[imsr] pdftotext unavailable — skipping this sync")
        return None
    rows = parse_imsr_rows(text)
    matched = match_imsr(rows, parse_imsr_narratives(text), fires)
    if not rows:
        log("[imsr] no table rows parsed — format change? skipping")
        return None
    log(f"[imsr] rows={len(rows)} matched_to_fires={len(matched)}")
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": now_iso(),
        "source_url": IMSR_URL,
        "fires": matched,
    }
