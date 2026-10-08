"""Which fire an incident folder, and each file in it, belongs to.

A folder's record is bound to one fire by `cornea_id`, and its files follow
that binding unless stamped: `files[rel].fk` names another fire's key (or is
null to hide the file) and `fk_src` says why. Stamps from the file itself
(`token`, `name`) or from an operator (`manual`) are evidence; `location`,
`prior` and `hidden` are placements made without it. Mistakes hide rather
than mis-assign: an unresolved or ignored folder contributes nothing, a
null stamp hides a file, and file names count only as evidence between the
two fires a folder is bound to by ID, never for a third fire.

Everything here is pure: it reads and edits the state dicts it is given.
"""

from __future__ import annotations

import re

from .asset_keys import new_storage_prefix
from .fires import fire_key
from .matching import (
    DATE_SANITY_SLACK_DAYS,
    extract_unit_tokens,
    folder_predates_fire,
    normalize_name,
    parse_when,
)

DEFAULT_CONFIDENCE = {"override": 1.0, "unit_id": 1.0, "name_exact": 0.95, "name_fuzzy": 0.9}
#: fk_src values that come from the file itself or from an operator
EVIDENCE_SRC = frozenset({"token", "name", "manual"})
NAME_METHODS = ("name_exact", "name_fuzzy")
#: bindings made by ID; only these fires' names count as file evidence (a
#: name-matched fire's name is in its files by construction)
ID_METHODS = ("unit_id", "override")

_MIN_NAME = 4        # shorter names ("Elk") collide too often to be evidence
_MAX_RUN = 4         # tokens a fire name may span in a file stem
_STEM_SPLIT = re.compile(r"[_\s\-.]+")
_MAP_EXTS = (".pdf", ".kmz", ".zip", ".kml", ".geojson")
# GISS template folders ("products/yymmdd/") carry stale junk, not uploads
_TEMPLATE_SEG = re.compile(r"(?:^|/)(?:yymmdd|yyyymmdd|mmddyyyy)(?:/|$)", re.I)


def migrated(state: dict) -> bool:
    """True once the incident-ID migration has run (the global gate)."""
    return bool((state.get("migrations") or {}).get("incident_ids"))


def year_of(inc_key: str) -> int:
    """'pacific_nw/2026/2026_Grasshopper' -> 2026."""
    return int(inc_key.split("/")[1])


def name_norm(title: str | None) -> str | None:
    """A fire or folder name as one lowercase run ('Bobcat Lakes' ->
    'bobcatlakes'); None when shorter than 4 characters."""
    n = normalize_name(title or "").replace(" ", "")
    return n if len(n) >= _MIN_NAME else None


def bound_info(fire: dict, method: str | None) -> dict:
    """The evidence behind a binding, captured when it is made. `fire` is an
    API fire (post_title) or a catalog row (name)."""
    uid = (fire.get("unique_fire_id") or "").strip().upper() or None
    return {"uid": uid, "name": name_norm(fire.get("post_title") or fire.get("name")),
            "method": method}


def _stem(filename: str) -> str:
    return filename.rpartition("/")[2].rsplit(".", 1)[0]


def _stem_runs(stem: str) -> set[str]:
    """Every run of up to 4 consecutive stem tokens, joined. Tokens split on
    _ - . and spaces only, so 'OpsDivBobcatAK' never reads as a fire name."""
    toks = [t for t in (re.sub(r"[^a-z0-9]", "", p.lower()) for p in _STEM_SPLIT.split(stem)) if t]
    runs: set[str] = set()
    for i in range(len(toks)):
        acc = ""
        for tok in toks[i:i + _MAX_RUN]:
            acc += tok
            runs.add(acc)
    return runs


def _name_forms(name: str) -> set[str]:
    forms = {name}
    for suffix in ("complex", "fire"):
        if name.endswith(suffix) and len(name) - len(suffix) >= _MIN_NAME:
            forms.add(name[: -len(suffix)])
    return forms


def names_fire(stem: str, name: str | None) -> bool:
    """True when the file stem spells the fire's name (a name_norm) as whole
    tokens: 'Bobcat_Lakes', 'BobcatLakes' and 'SandCreek-Skull' name
    bobcatlakes / sandcreek; 'BobcatLake' does not. A trailing 'complex' or
    'fire' on the fire's name is optional."""
    if not name:
        return False
    return not _name_forms(name).isdisjoint(_stem_runs(stem))


def names_in(filename: str, names) -> set[str]:
    """The names (name_norms) among `names` that the file name spells as
    whole tokens, as names_fire reads them. Used for reports only."""
    runs = _stem_runs(_stem(filename))
    return {n for n in names if n and not _name_forms(n).isdisjoint(runs)}


def file_evidence(filename: str, year: int, cands: dict) -> tuple[str | None, str | None]:
    """Which candidate fire the file name proves, and how.

    `cands` is {fk: {"uid", "name", "method"}} (bound_info) for the fires the
    folder is bound to. A unit token naming exactly one candidate wins;
    otherwise a name naming exactly one ID-bound candidate. (None, None)
    when the name proves neither.
    """
    cands = {fk: c for fk, c in cands.items() if fk and c}
    for token, _n in extract_unit_tokens([filename], year=year).most_common():
        holders = [fk for fk, c in cands.items() if (c.get("uid") or "").upper() == token.upper()]
        if len(holders) == 1:
            return holders[0], "token"
    runs = _stem_runs(_stem(filename))
    named = [fk for fk, c in cands.items()
             if c.get("method") in ID_METHODS and c.get("name")
             and not _name_forms(c["name"]).isdisjoint(runs)]
    if len(named) == 1:
        return named[0], "name"
    return None, None


def prior_owner(rec: dict | None) -> str | None:
    """The fire the folder is bound to now; None when it is unresolved,
    ignored, detached (match None) or was never bound."""
    if not rec or rec.get("ignored") or rec.get("id_unresolved") or not rec.get("match"):
        return None
    return fire_key(rec.get("cornea_id"))


def file_owner(rec: dict, meta: dict) -> str | None:
    """The fire a file shows on, or None (hidden)."""
    if meta.get("pruned_at") or rec.get("ignored") or rec.get("id_unresolved"):
        return None
    if "fk" in meta:
        return meta["fk"]
    return fire_key(rec.get("cornea_id")) if rec.get("match") else None


def owners_of(rec: dict) -> set[str]:
    """Every fire whose manifest this record can touch: its binding plus
    every non-null stamp. Errs wide; it only selects manifests to rebuild."""
    out = {fk for fk in [fire_key(rec.get("cornea_id"))] if fk}
    out.update(m["fk"] for m in (rec.get("files") or {}).values() if m.get("fk"))
    return out


def contributors(state: dict) -> dict[str, set[str]]:
    """fire key -> keys of the records feeding it. A bound record counts
    even when it shows no files (zero-file folders stay advertised)."""
    out: dict[str, set[str]] = {}
    for key, rec in (state.get("incidents") or {}).items():
        bound = prior_owner(rec)
        if bound:
            out.setdefault(bound, set()).add(key)
        for meta in (rec.get("files") or {}).values():
            fk = file_owner(rec, meta)
            if fk:
                out.setdefault(fk, set()).add(key)
    return out


def own_newest_upload(rec: dict) -> str | None:
    """When this folder last received a map: the newest upload time of its
    own map files (not a fire-wide merge), skipping template folders and
    pruned files; the folder's listing mtimes only when no such file has an
    upload time. Returns the newest stamp as stored."""
    from .catalogs import rfc1123_to_iso  # catalogs builds on this module

    stamps = [rfc1123_to_iso(meta.get("lm")) or meta.get("first_seen")
              for rel, meta in (rec.get("files") or {}).items()
              if rel.lower().endswith(_MAP_EXTS) and not _TEMPLATE_SEG.search(rel)
              and not meta.get("pruned_at")]
    if not any(stamps):
        stamps = [rec.get("dir_mtime"), *(rec.get("children") or {}).values()]
    dated = [(when, raw) for raw in stamps if (when := parse_when(raw))]
    return max(dated)[1] if dated else None


def record_predates_fire(rec: dict, method: str | None, created_on: str | None) -> str | None:
    """The date check for a NAME binding: a reason when the folder's own
    newest upload is more than a week older than the fire, else None.
    ID bindings, and fires with no created_on, are never rejected here."""
    if method not in NAME_METHODS:
        return None
    newest = own_newest_upload(rec)
    if not folder_predates_fire(newest, created_on):
        return None
    return (f"newest upload {newest} is more than {DATE_SANITY_SLACK_DAYS} days "
            f"before the fire was created ({created_on})")


def choose_ir_source(rec: dict, rel_dir: str, owner_fk: str, owner_name: str | None,
                     fire_names) -> tuple[str | None, bool]:
    """The source file (shapefiles zip, else KMZ) for `owner_fk`'s flight in
    one IR folder of this record, and whether the folder was found mixed.

    Only files the owner owns are candidates, and files naming the owner
    come first. A folder flown for several fires carries each fire's KMZ:
    when the chosen source does not name the owner and any file in the
    folder names another fire (`fire_names`: name_norms of active fires,
    plus this record's own past and present bindings), the flight gets no
    vectors rather than another fire's: (None, True).
    """
    files = rec.get("files") or {}
    in_dir = [rel for rel in files if rel.rpartition("/")[0] == rel_dir]
    owned = [rel for rel in in_dir if file_owner(rec, files[rel]) == owner_fk]
    owned.sort(key=lambda rel: not names_fire(_stem(rel), owner_name))  # stable
    zips = [rel for rel in owned if rel.lower().endswith("shapefiles.zip")]
    kmzs = [rel for rel in owned if rel.lower().endswith(".kmz")]
    srcs = zips or kmzs
    if not srcs:
        return None, False
    src = srcs[0]
    if names_fire(_stem(src), owner_name):
        return src, False
    names = set(fire_names or ())
    names.update(e.get("name") for e in rec.get("rebound_from") or [])
    names.add((rec.get("bound") or {}).get("name"))
    own_forms = _name_forms(owner_name) if owner_name else set()
    other_forms = {f for n in names if n and n != owner_name for f in _name_forms(n)} - own_forms
    if any(not other_forms.isdisjoint(_stem_runs(_stem(rel))) for rel in in_dir):
        return None, True
    return src, False


# ---------------------------------------------------------------------------
# binding a folder to a fire
# ---------------------------------------------------------------------------

def bind_record(state: dict, inc_key: str, *, cornea_id: str | None, match: dict | None,
                bound: dict | None = None, region: str | None = None) -> dict:
    """The record a mirror run writes under, created on first sight.

    A new record gets its own storage prefix, and fire_slug equals it, so
    code that still builds keys from fire_slug finds the right bytes or a
    404. An existing record must already be bound to this fire (rebinds go
    through apply_bind first); its fire_slug and storage_prefix never change.
    """
    fk = fire_key(cornea_id)
    if fk is None:
        raise ValueError(f"{inc_key}: no fire key in cornea_id {cornea_id!r}")
    incidents = state.setdefault("incidents", {})
    rec = incidents.get(inc_key)
    if rec is None:
        prefix = new_storage_prefix(state, fk, inc_key)
        rec = incidents[inc_key] = {
            "fire_slug": prefix, "storage_prefix": prefix, "cornea_id": cornea_id,
            "match": match, "bound": bound, "region": region,
            "dir_mtime": None, "children": {}, "files": {},
        }
        return rec
    if fire_key(rec.get("cornea_id")) != fk:
        raise ValueError(f"{inc_key}: bound to {rec.get('cornea_id')}, not {cornea_id}; "
                         "rebind with apply_bind first")
    rec["match"] = match
    if region is not None:
        rec["region"] = region
    return rec


def revision_stamp(prev_meta: dict, sha16: str | None) -> dict:
    """The owner stamp a re-downloaded file keeps. The same bytes keep
    theirs; new bytes keep only evidence (the file name, or an operator),
    since the name has not changed. Placements made without evidence do not
    carry over, so new content follows the current binding."""
    if "fk" not in prev_meta:
        return {}
    if prev_meta.get("sha16") == sha16 or prev_meta.get("fk_src") in EVIDENCE_SRC:
        return {"fk": prev_meta["fk"], "fk_src": prev_meta.get("fk_src")}
    return {}


def rebind_decision(prev: dict | None, m) -> str:
    """What a fresh match `m` (method, cornea_id) does to an existing record:
    new | same | fresh | bind | rebind | refuse."""
    new = fire_key(m.cornea_id)
    if prev is None:
        return "new"
    if prev.get("ignored"):
        return "same" if fire_key(prev.get("cornea_id")) == new else "fresh"
    old = prior_owner(prev)
    if old == new:
        return "same"
    if old is None:
        return "bind"
    if m.method == "override":
        return "rebind"
    prev_method = (prev.get("match") or {}).get("method")
    if prev_method == "override":
        return "rebind"  # the override was removed
    if prev_method == "unit_id" and m.method in NAME_METHODS:
        return "refuse"  # a name never outranks an ID
    return "rebind"


def apply_bind(rec: dict, m, new_fire: dict, now: str, *, inc_key: str) -> str | None:
    """Move `rec` onto the fire `m` matched (decisions same, bind, rebind and
    fresh) and return the fire it was bound to (prior_owner) before.

    On a bind or rebind each unstamped file is weighed by its own name
    between the old and the new fire: files proving the new fire follow it;
    files proving the old one are stamped to it; the rest stay with an old
    ID binding ('prior'), are hidden when there was no old binding, and
    follow the new binding when the old one was only a name match. An
    override instead drops every stamp that is not evidence, so unproven
    files follow it. `same` changes no stamps; `fresh` (a once-ignored
    folder matching another fire) stamps nothing.
    """
    decision = rebind_decision(rec, m)
    if decision not in ("same", "bind", "rebind", "fresh"):
        raise ValueError(f"{inc_key}: apply_bind has nothing to do for {decision!r}")
    old = prior_owner(rec)
    new = fire_key(m.cornea_id)
    files = rec.setdefault("files", {})
    prev_method = (rec.get("match") or {}).get("method")

    if decision == "same":
        if not rec.get("bound"):
            rec["bound"] = bound_info(new_fire, m.method)
    else:
        if m.method == "override":
            for meta in files.values():
                if meta.get("fk_src") not in EVIDENCE_SRC:
                    meta.pop("fk", None)
                    meta.pop("fk_src", None)
        elif decision in ("bind", "rebind"):
            cands = {new: bound_info(new_fire, m.method)}
            if old:
                cands[old] = rec.get("bound") or {}
            year = year_of(inc_key)
            for rel, meta in files.items():
                if "fk" in meta or meta.get("pruned_at"):
                    continue
                ev, src = file_evidence(rel.rpartition("/")[2], year, cands)
                if ev == new:
                    continue
                if old is not None and ev == old:
                    meta["fk"], meta["fk_src"] = old, src
                elif old is None:
                    meta["fk"], meta["fk_src"] = None, "hidden"
                elif prev_method in ID_METHODS:
                    meta["fk"], meta["fk_src"] = old, "prior"
        prev_fk = fire_key(rec.get("cornea_id"))
        if prev_fk and prev_fk != new:
            b = rec.get("bound") or {}
            rec.setdefault("rebound_from", []).append({
                "cornea_id": rec["cornea_id"], "uid": b.get("uid"), "name": b.get("name"),
                "method": b.get("method") or prev_method, "at": now, "source": "sync"})
        rec["cornea_id"] = new_fire.get("cornea_id") or m.cornea_id
        rec["bound"] = bound_info(new_fire, m.method)

    for k in ("id_unresolved", "ignored", "match_rejected"):
        rec.pop(k, None)
    if m.method == "override":
        rec["override"] = m.cornea_id
    else:
        rec.pop("override", None)
    return old
