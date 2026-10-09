"""migrate-incident-ids: re-key incident state from fire slugs to fire IDs.

Report and apply run the same steps on a deep copy of state, over a
RecordingStorage (on top of a read-only view of the bucket) that captures
every write instead of sending it:

  M0  the active-fire list, refused when it may be partial
  A   each folder's fire (cornea_id) from the immutable catalog history:
      the first version at or after the folder's last sync, corroborated,
      then validated by the match method
  B   every folder gets its own storage prefix; a legacy slug two folders
      wrote under stays with one keeper and the others' files are stamped
      where they are
  C   raw files, tiles and previews located from bucket listings
      (asset_locate); a relocated raw file only when its bytes hash right
  D   files under a foreign prefix go to the fire the catalog history
      showed there, unless their own names prove the folder's fire; D2 the
      same name evidence over the folder's own prefix; D3 legacy IR
      conversions kept only for the source file that produced them
  E   every active fire's ID manifest, replay only
  F   the flag, the catalog, the health section
  G   guards over the captured outputs

Report mode writes only its report. Apply needs the expected report, aborts
on any guard before writing anything, and otherwise writes a backup of the
state as loaded first, then the captured objects in capture order. Nothing
is ever deleted, and no tile, preview or vector object is written.
"""

from __future__ import annotations

import copy
import hashlib
import json
from collections import Counter
from pathlib import Path

from . import asset_locate, catalogs as cat, fire_manifests, health, ir_vectors
from . import state as state_mod
from .asset_keys import file_location, new_storage_prefix, raw_key, record_prefix, stamp_ir
from .b2 import ReadOnlyStorage, RecordingStorage, get_json_retry
from .fires import ACTIVE_FIRES_LIMIT, fire_key, fire_list_suspect
from .incident_ids import (
    DEFAULT_CONFIDENCE,
    NAME_METHODS,
    bound_info,
    contributors,
    file_evidence,
    file_owner,
    migrated,
    name_norm,
    names_in,
    prior_owner,
    record_predates_fire,
    suspect_files,
    year_of,
)
from .maint import write_report
from .matching import parse_when
from .state import STATE_KEY

#: catalogs 1-5 predate the serialized writers (36c66c8); no record needs them
FIRST_VERSION = 6
HISTORY_STRIDE = 8
GAP_FLAG_MINUTES = 60
MAX_UNRESOLVED = 10
#: a foreign prefix is attributed on at least this many history rows ...
HISTORY_MIN_ROWS = 3
#: ... of which this share name one fire
HISTORY_MAJORITY = 0.8
BACKUP_PREFIX = "state/backups/state.pre-incident-ids."
_LEGACY_MANIFEST = "/catalogs/incidents/"


def _dir_url(rec: dict) -> str | None:
    return rec.get("dir_url") or (rec.get("match") or {}).get("dir_url")


def _slim_row(f: dict) -> dict:
    m = f.get("ftp_match") or {}
    return {"fire_slug": f.get("fire_slug"), "cornea_id": f.get("cornea_id"),
            "unique_fire_id": f.get("unique_fire_id"), "name": f.get("name"),
            "created_on": f.get("created_on"),
            "ftp_match": {"method": m.get("method"), "dir_url": m.get("dir_url")} if m else None}


class CatalogHistory:
    """Published catalog versions (catalogs/versions/catalog.{N}.json are
    never rewritten), fetched on demand with retries and kept slim: each
    version's generated_at and each row's identity and FTP match."""

    def __init__(self, storage, latest: int, first: int = FIRST_VERSION):
        self.storage, self.latest, self.first = storage, latest, first
        self._docs: dict[int, dict | None] = {}

    def get(self, n: int) -> dict | None:
        if n not in self._docs:
            doc = get_json_retry(self.storage, f"catalogs/versions/catalog.{n}.json")
            self._docs[n] = None if not doc else {
                "version": n, "generated_at": doc.get("generated_at"),
                "by_slug": {f.get("fire_slug"): _slim_row(f) for f in doc.get("fires") or []}}
        return self._docs[n]

    def _existing_from(self, n: int, hi: int) -> int | None:
        while n <= hi:  # a missing version is a hole: move on
            if self.get(n) is not None:
                return n
            n += 1
        return None

    def first_at_or_after(self, when: str) -> int | None:
        """The first version generated at or after `when` (bisected)."""
        t = parse_when(when)
        lo, hi, found = self.first, self.latest, None
        while lo <= hi:
            mid = (lo + hi) // 2
            n = self._existing_from(mid, hi)
            if n is None:
                hi = mid - 1
                continue
            gen = parse_when(self.get(n)["generated_at"])
            if gen is not None and gen >= t:
                found, hi = n, mid - 1
            else:
                lo = n + 1
        return found

    def before(self, n: int) -> int | None:
        for m in range(n - 1, self.first - 1, -1):
            if self.get(m) is not None:
                return m
        return None

    def sample(self, stride: int = HISTORY_STRIDE) -> None:
        for n in [*range(self.first, self.latest + 1, stride), self.latest]:
            self.get(n)

    def index(self) -> tuple[dict, dict]:
        """Over every version fetched so far: (slug, dir_url) -> [row], and
        dir_url -> Counter of the slugs it was shown under."""
        by_loc: dict[tuple[str, str], list[dict]] = {}
        slugs: dict[str, Counter] = {}
        for n in sorted(self._docs):
            doc = self._docs[n]
            for slug, row in (doc or {}).get("by_slug", {}).items():
                d = (row.get("ftp_match") or {}).get("dir_url")
                if d:
                    by_loc.setdefault((slug, d), []).append(row)
                    slugs.setdefault(d, Counter())[slug] += 1
        return by_loc, slugs


def legacy_ir_picks(rels: list[str], slug: str,
                    fire_name: str) -> set[tuple[str, str, str] | None]:
    """Every choice the slug-keyed manifest build could have made for one IR
    folder (`rels`, state order) shown under `slug` on a fire named
    `fire_name` (stem_name): (vectors key, source rel, flight_id), or None
    when it converted nothing. That build's file order was not recorded, so
    the choice is computed in state order and in sorted order."""
    picks = set()
    rel_dir = rels[0].rpartition("/")[0] if rels else ""
    for order in (rels, sorted(rels)):
        names = [r.rpartition("/")[2] for r in order]
        zips = [n for n in names if n.lower().endswith("shapefiles.zip")]
        pdfs = [n for n in names if n.lower().endswith(".pdf")]
        kmzs = [n for n in names if n.lower().endswith(".kmz")]
        flight_id = fire_manifests.flight_id_of(zips, pdfs, kmzs, fire_name)
        if flight_id and (zips or kmzs):
            picks.add((f"vectors/ir/{slug}/{flight_id}.geojson",
                       f"{rel_dir}/{(zips or kmzs)[0]}", flight_id))
        else:
            picks.add(None)
    return picks


def legacy_ir_choice(rels: list[str], slug: str,
                     fire_name: str) -> tuple[tuple[str, str, str] | None, bool]:
    """(the one choice of legacy_ir_picks or None, ambiguous): when the two
    orders differ nothing is chosen."""
    picks = legacy_ir_picks(rels, slug, fire_name)
    if len(picks) > 1:
        return None, True
    return picks.pop(), False


def legacy_ir_conversions(state: dict, inc_key: str, rec: dict,
                          rel_dirs: set[str]) -> set[tuple[str, str, str]]:
    """Every (vectors key, source rel, flight_id) the slug-keyed build could
    have made for these IR folders of a record: legacy_ir_picks under each
    prefix the folder's IR files sit at and its slug at the migration, with
    each fire name it was bound to. Errs wide: prune keeps or deletes these
    keys only against state["ir"], the key audit names possible sources."""
    files = rec.get("files") or {}
    slug_at = ((state.get("migrations") or {}).get("slugs_at_migration") or {}).get(inc_key)
    names = {(rec.get("bound") or {}).get("name")}
    names.update(e.get("name") for e in rec.get("rebound_from") or [])
    ir_rels = [rel for rel, meta in files.items()
               if meta.get("kind", rel.split("/", 1)[0]) == "ir"]
    out: set[tuple[str, str, str]] = set()
    for rel_dir in sorted(rel_dirs):
        in_dir = [rel for rel in ir_rels if rel.rpartition("/")[0] == rel_dir]
        slugs = {file_location(rec, rel) for rel in in_dir} | {slug_at}
        for slug in filter(None, slugs):
            for name in filter(None, names):
                out.update(filter(None, legacy_ir_picks(in_dir, slug, name)))
    return out


def fingerprint(state: dict) -> dict:
    """Per record, what an apply must reproduce from the expected report
    (G8): the binding, the owner stamps by (fk, fk_src), the IR keys."""
    out = {}
    for key, rec in sorted((state.get("incidents") or {}).items()):
        stamps = Counter(f"{m.get('fk')}|{m.get('fk_src')}"
                         for m in (rec.get("files") or {}).values() if "fk" in m)
        out[key] = {"synced_at": rec.get("synced_at"),
                    "unresolved": bool(rec.get("id_unresolved")),
                    "fk": fire_key(rec.get("cornea_id")),
                    "stamps": dict(sorted(stamps.items())),
                    "ir_keys": {src: e.get("key")
                                for src, e in sorted((rec.get("ir_keys") or {}).items())}}
    return out


def expect_diff(expected: dict, current: dict) -> tuple[list[str], list[dict]]:
    """(blockers, drift) between the expected report's per_record and this
    run's. A record whose synced_at moved since is drift; a new record that
    does not resolve blocks; any other difference blocks."""
    exp = expected.get("per_record")
    if not isinstance(exp, dict):
        return ["the expected report has no per_record section"], []
    blockers, drift = [], []
    for key, cur in sorted(current.items()):
        e = exp.get(key)
        if e is None:
            if cur["unresolved"]:
                blockers.append(f"{key}: new since the expected report and unresolved")
            else:
                drift.append({"key": key, "change": "new"})
            continue
        if e.get("synced_at") != cur["synced_at"]:
            drift.append({"key": key, "change": "synced_at",
                          "expected": e.get("synced_at"), "now": cur["synced_at"]})
            continue
        for field in ("unresolved", "fk", "stamps", "ir_keys"):
            if e.get(field) != cur[field]:
                blockers.append(f"{key}: {field} differs from the expected report")
    drift += [{"key": key, "change": "gone"} for key in sorted(exp.keys() - current.keys())]
    return blockers, drift


class Migration:
    """Steps A-G over a deep copy of `state`. Every write lands in
    `self.out` (captured, never sent); `self.report` is the report."""

    def __init__(self, storage, state: dict, fires: list[dict], *, prev_catalog: dict | None,
                 now: str, log=print):
        self.out = RecordingStorage(ReadOnlyStorage(storage))
        self.state = copy.deepcopy(state)
        self.fires = fires
        self.fires_by_fk = {fk: f for f in fires if (fk := fire_key(f.get("cornea_id")))}
        self.prev_catalog = prev_catalog or {}
        self.now, self.log = now, log
        self.version = int(self.state.get("catalog_version") or 0)
        self.legacy = {k: r["fire_slug"] for k, r in self.state["incidents"].items()
                       if r.get("fire_slug")}
        self.hist = CatalogHistory(self.out, self.version)
        self.backup_key = f"{BACKUP_PREFIX}{now.replace('-', '').replace(':', '')}.json"
        self.rows: dict[str, dict] = {}       # inc_key -> the row step A resolved it by
        self.eras: dict[str, list[tuple[str, str | None]]] = {}  # inc_key -> [(slug, fire name)]
        self.missing: set[tuple[str, str]] = set()  # (inc_key, rel) of raw files found nowhere
        self._missing_keys: set[str] | None = None
        self.listings: asset_locate.Listings | None = None
        self.new_manifests: dict[str, dict] = {}
        self._manifests: dict[str, dict | None] = {}
        self.report: dict = {
            "state_updated_at": state.get("updated_at"),
            "catalog_version": self.version,
            "generated_at": now,
            "mode": None,
            "would_abort": [],
            "records": {"total": len(self.state["incidents"]), "resolved": 0, "unresolved": [],
                        "reattached": [], "gaps": [], "no_created_on": [],
                        "id_suspect": [], "name_suspect": []},
            "prefixes": {"split": []},
            "locate": {},
            "ownership": [],
            "foreign_location_unattributed": [],
            "evidence_conflict": [],
            "ir": {"stamped": [], "order_ambiguous": [], "key_collisions": [],
                   "mixed_hidden": [], "flights_losing_vectors": []},
            "fires": [],
            "lost_all_maps": [],
            "unexplained_losses": [],
            "cross_named_entries": {},
            "captured_keys": [],
            "storage_writes": 0,
            "per_record": {},
            "drift": [],
        }

    # -- shared reads ------------------------------------------------------

    def legacy_manifest(self, slug: str) -> dict | None:
        if slug not in self._manifests:
            self._manifests[slug] = get_json_retry(self.out, f"catalogs/incidents/{slug}.json")
        return self._manifests[slug]

    def live_rows(self) -> dict[str, tuple[dict, str]]:
        """fk -> (today's catalog row, slug of the legacy manifest it names)."""
        out = {}
        for row in self.prev_catalog.get("fires") or []:
            fk, path = fire_key(row.get("cornea_id")), row.get("incident_manifest") or ""
            if (fk and row.get("has_incident_maps") and path.startswith(_LEGACY_MANIFEST)
                    and not path.startswith(_LEGACY_MANIFEST + "id/")):
                out[fk] = (row, path[len(_LEGACY_MANIFEST):].removesuffix(".json"))
        return out

    def run(self) -> dict:
        self.resolve_records()
        self.split_prefixes()
        self.hist.sample()
        self.locate()
        self.attribute_foreign_locations()
        self.own_location_evidence()
        self.legacy_ir_stamps()
        self.suspects()
        self.rebuild_fires()
        self.finish()
        self.report["per_record"] = fingerprint(self.state)
        self.report["captured_keys"] = self.out.captured_keys()
        return self.report

    # -- step A ------------------------------------------------------------

    def resolve_records(self) -> None:
        rep = self.report["records"]
        incidents = self.state["incidents"]
        for key in sorted(incidents, key=lambda k: (incidents[k].get("synced_at") or "", k)):
            rec = incidents[key]
            if rec.get("cornea_id") or rec.get("id_unresolved"):
                continue
            row, reason = self._resolve(key, rec)
            if reason:
                rep["unresolved"].append({"key": key, "reason": reason,
                                          "candidate": (row or {}).get("cornea_id"),
                                          "candidate_name": (row or {}).get("name")})
                rec["id_unresolved"] = {"reason": reason, "candidate": (row or {}).get("cornea_id"),
                                        "prior_match": rec.get("match") or rec.get("match_rejected"),
                                        "at": self.now}
                rec["cornea_id"] = None
                rec["match"] = None
                continue
            method = (rec.get("match") or rec.get("match_rejected") or {}).get("method")
            rec["cornea_id"] = row["cornea_id"]
            rec["bound"] = bound_info(row, method)
            self.rows[key] = row
            if rec.get("match") is None:
                # detached only because the slug later named another fire
                rec["match"] = {"method": method, "confidence": DEFAULT_CONFIDENCE.get(method),
                                "token": None, "dir_url": _dir_url(rec)}
                rec["reattached_at"] = self.now
                rec.pop("match_rejected", None)
                rep["reattached"].append(key)
        rep["resolved"] = sum(1 for r in incidents.values()
                              if r.get("cornea_id") and not r.get("id_unresolved"))
        self.log(f"[migrate] A: {rep['resolved']} resolved, {len(rep['unresolved'])} unresolved, "
                 f"{len(rep['reattached'])} re-attached")

    def _resolve(self, key: str, rec: dict) -> tuple[dict | None, str | None]:
        """(the catalog row naming the folder's fire, None) or (row, why not)."""
        rep = self.report["records"]
        synced = rec.get("synced_at")
        if not parse_when(synced):
            return None, "never synced"
        n = self.hist.first_at_or_after(synced)
        if n is None:
            return None, f"no catalog version at or after synced_at {synced}"
        doc = self.hist.get(n)
        slug = self.legacy.get(key)
        row = doc["by_slug"].get(slug) if slug else None
        if row is None:
            return None, f"slug {slug} absent in v{n}"
        fk = fire_key(row.get("cornea_id"))
        if not fk:
            return row, f"v{n} row for {slug} has no cornea_id"
        gap = (parse_when(doc["generated_at"]) - parse_when(synced)).total_seconds() / 60
        if gap > GAP_FLAG_MINUTES:
            # a run that saved this folder and died before its catalog: the
            # version found may be a later run's
            rep["gaps"].append({"key": key, "version": n, "minutes": round(gap, 1)})

        m = rec.get("match")
        method = (m or rec.get("match_rejected") or {}).get("method")
        if not method:
            return row, "no match method to validate"
        dir_url = _dir_url(rec)
        prev_n = self.hist.before(n)
        prev = self.hist.get(prev_n)["by_slug"].get(slug) if prev_n else None
        a = bool(prev) and fire_key(prev.get("cornea_id")) == fk
        b = bool(dir_url) and (row.get("ftp_match") or {}).get("dir_url") == dir_url
        man = self.legacy_manifest(slug) or {}
        c = (bool(dir_url) and fire_key(man.get("cornea_id")) == fk
             and man.get("source_dir") == dir_url)
        by_id = m is not None and method == "unit_id"
        # a name, an override or a detached folder needs the folder itself
        # named next to the fire: the slug alone is a name
        if not ((a or b or c) if by_id else (b or c)):
            return row, f"uncorroborated in v{n}"

        if by_id:
            tok = (m.get("token") or "").upper()
            uid = (row.get("unique_fire_id") or "").upper()
            if not tok or tok != uid:
                return row, f"unit token {tok or None} is not v{n}'s unique_fire_id {uid or None}"
        elif method in NAME_METHODS or m is None:
            created = (row.get("created_on")
                       or (self.fires_by_fk.get(fk) or {}).get("created_on"))
            if not created:
                rep["no_created_on"].append(key)
            why = record_predates_fire(rec, method if method in NAME_METHODS else "name_exact",
                                       created)
            if why:
                return row, why
        elif method != "override":
            return row, f"unknown match method {method!r}"
        return row, None

    # -- step B ------------------------------------------------------------

    def split_prefixes(self) -> None:
        incidents = self.state["incidents"]
        groups: dict[str, list[str]] = {}
        for key in sorted(self.legacy):
            groups.setdefault(self.legacy[key], []).append(key)
        for prefix, keys in sorted(groups.items()):
            if len(keys) == 1:
                incidents[keys[0]].setdefault("storage_prefix", prefix)
                continue
            owner = {k: prior_owner(incidents[k]) for k in keys}
            eligible = [k for k in keys if owner[k] in self.fires_by_fk]
            keeper = min(eligible or keys,
                         key=lambda k: fire_manifests.primary_rank(self.state, owner[k])(k))
            incidents[keeper]["storage_prefix"] = prefix
            moved = []
            for k in keys:
                if k == keeper:
                    continue
                rec = incidents[k]
                stamped = 0
                for meta in (rec.get("files") or {}).values():
                    if not meta.get("prefix"):
                        meta["prefix"] = prefix  # its bytes stay where they are
                        stamped += 1
                fk = None if rec.get("id_unresolved") else fire_key(rec.get("cornea_id"))
                new = (new_storage_prefix(self.state, fk, k) if fk
                       else f"{prefix}-{hashlib.sha1(k.encode()).hexdigest()[:6]}")
                rec["storage_prefix"] = rec["fire_slug"] = new
                moved.append({"key": k, "new_prefix": new, "files_stamped": stamped})
            self.report["prefixes"]["split"].append(
                {"prefix": prefix, "keeper": keeper, "moved": moved})
        self.log(f"[migrate] B: {len(self.report['prefixes']['split'])} shared prefixes split")

    # -- step C ------------------------------------------------------------

    def locate(self) -> None:
        self.listings = asset_locate.list_assets(self.out, self.log)
        _by_loc, slugs_by_dir = self.hist.index()
        prefer = {}
        for key, rec in self.state["incidents"].items():
            seen = slugs_by_dir.get(_dir_url(rec) or "") or Counter()
            prefer[key] = [s for s, _n in sorted(seen.items(), key=lambda kv: (-kv[1], kv[0]))]
        live = [m for _row, slug in self.live_rows().values()
                if (m := self.legacy_manifest(slug))]
        live_tiles, live_previews = asset_locate.live_copies(live)
        raw = asset_locate.locate_raw(self.out, self.state, self.listings, prefer=prefer,
                                      log=self.log)
        shas = asset_locate.locate_shas(self.state, self.listings, live_tiles, live_previews,
                                        baseline=self.legacy)
        self.missing = {(m["key"], m["rel"]) for m in raw["missing"]}
        self.report["locate"] = {"raw": raw, "previews": shas["previews"], "tiles": shas["tiles"],
                                 "url_changes": [],
                                 "ir": asset_locate.ir_objects(self.state, self.listings)}
        self.log(f"[migrate] C: raw ok={raw['ok']} relocated={sum(raw['relocated'].values())} "
                 f"missing={len(raw['missing'])}")

    # -- step D ------------------------------------------------------------

    def _resolved(self, rec: dict) -> bool:
        return bool(rec.get("cornea_id")) and not rec.get("id_unresolved")

    def _era_name(self, key: str, rec: dict) -> str | None:
        row = self.rows.get(key) or {}
        fire = self.fires_by_fk.get(fire_key(rec.get("cornea_id"))) or {}
        return row.get("name") or fire.get("post_title")

    def attribute_foreign_locations(self) -> None:
        by_loc, _slugs = self.hist.index()
        rep = self.report
        for key, rec in sorted(self.state["incidents"].items()):
            if not self._resolved(rec):
                continue
            fk_r = fire_key(rec["cornea_id"])
            self.eras[key] = [(self.legacy.get(key), self._era_name(key, rec))]
            home = {self.legacy.get(key), record_prefix(rec)}
            at: dict[str, list[str]] = {}
            for rel, meta in (rec.get("files") or {}).items():
                loc = file_location(rec, rel)
                if loc not in home and not meta.get("pruned_at"):
                    at.setdefault(loc, []).append(rel)
            for q, rels in sorted(at.items()):
                rows = by_loc.get((q, _dir_url(rec) or ""), [])
                tally = Counter(fire_key(r.get("cornea_id")) for r in rows)
                top, n = tally.most_common(1)[0] if rows else (None, 0)
                if not top or len(rows) < HISTORY_MIN_ROWS or n < HISTORY_MAJORITY * len(rows):
                    rep["foreign_location_unattributed"].append(
                        {"key": key, "location": q, "files": len(rels), "history_rows": len(rows),
                         "top": top, "top_rows": n})
                    continue
                conflict = self._manifest_conflict(rec, q, rels, top)
                if conflict:
                    rep["evidence_conflict"].append(dict(conflict, key=key, location=q, history=top))
                    continue
                row_c = [r for r in rows if fire_key(r.get("cornea_id")) == top][-1]
                method_c = Counter((r.get("ftp_match") or {}).get("method") for r in rows
                                   if fire_key(r.get("cornea_id")) == top).most_common(1)[0][0]
                self.eras[key].append((q, row_c.get("name")))
                entry = {"key": key, "location": q, "owner_fk": top, "by_src": {},
                         "stays": 0, "history_rows": len(rows)}
                rep["ownership"].append(entry)
                if top == fk_r:
                    continue  # the same fire under an older slug
                c_bound = bound_info(row_c, method_c)
                cands = {fk_r: rec.get("bound") or {}, top: c_bound}
                by_src: Counter = Counter()
                for rel in rels:
                    meta = rec["files"][rel]
                    if "fk" in meta:
                        continue
                    ev, src = file_evidence(rel.rpartition("/")[2], year_of(key), cands)
                    if ev == fk_r:
                        entry["stays"] += 1
                        continue
                    meta["fk"], meta["fk_src"] = top, (src if ev == top else "location")
                    by_src[meta["fk_src"]] += 1
                entry["by_src"] = dict(sorted(by_src.items()))
                rec.setdefault("rebound_from", []).append({
                    "cornea_id": row_c.get("cornea_id"), "uid": c_bound["uid"],
                    "name": c_bound["name"], "method": method_c, "at": self.now,
                    "source": "migration"})
        self.log(f"[migrate] D: {len(rep['ownership'])} foreign locations attributed, "
                 f"{len(rep['foreign_location_unattributed'])} unattributed, "
                 f"{len(rep['evidence_conflict'])} conflicts")

    def _manifest_conflict(self, rec: dict, q: str, rels: list[str], fk: str) -> dict | None:
        """The legacy manifest at Q, when it still lists any of these files
        there (a PDF by URL and sha, an IR file by URL), must be fk's."""
        man = self.legacy_manifest(q)
        if not man:
            return None
        maps = {(m.get("pdf_url"), m.get("id")) for m in man.get("maps") or []}
        ir_urls = {f.get(u) for f in man.get("ir_flights") or []
                   for u in ("kmz_url", "pdf_url", "readme_url")}
        listed = [rel for rel in rels
                  if (f"/raw/incidents/{q}/{rel}", rec["files"][rel].get("sha16")) in maps
                  or f"/raw/incidents/{q}/{rel}" in ir_urls]
        if listed and fire_key(man.get("cornea_id")) != fk:
            return {"manifest_cornea": man.get("cornea_id"), "listed": len(listed)}
        return None

    def own_location_evidence(self) -> None:
        """D2: a folder that showed on other fires (step D) may still hold
        their files under its own prefix: weigh its unstamped files there by
        their names against its own fire and those fires."""
        for key, rec in sorted(self.state["incidents"].items()):
            prior = [e for e in rec.get("rebound_from") or [] if e.get("source") == "migration"]
            if not prior or not self._resolved(rec):
                continue
            fk_r = fire_key(rec["cornea_id"])
            cands = {fk_r: rec.get("bound") or {}}
            for e in prior:
                cands.setdefault(fire_key(e["cornea_id"]),
                                 {"uid": e.get("uid"), "name": e.get("name"), "method": e.get("method")})
            by_owner: dict[str, Counter] = {}
            for rel, meta in (rec.get("files") or {}).items():
                if ("fk" in meta or meta.get("pruned_at")
                        or file_location(rec, rel) != self.legacy.get(key)):
                    continue
                ev, src = file_evidence(rel.rpartition("/")[2], year_of(key), cands)
                if ev and ev != fk_r:
                    meta["fk"], meta["fk_src"] = ev, src
                    by_owner.setdefault(ev, Counter())[src] += 1
            for fk, by_src in sorted(by_owner.items()):
                self.report["ownership"].append(
                    {"key": key, "location": self.legacy.get(key), "owner_fk": fk,
                     "by_src": dict(sorted(by_src.items())), "step": "D2"})

    def _ir_eras(self) -> dict[str, list[tuple[str | None, str | None]]]:
        """Per record, each slug its IR files were shown under and the fire
        name that build stripped from flight IDs (None: unknown). Era 0 is
        the legacy slug, which showed every file of the folder; later eras
        showed only the files at their location. A resolved folder has
        step D's eras; any other its legacy slug under its candidate row's
        fire. Locations holding IR files that no era names come last, with
        no name."""
        cand_names = {u["key"]: u.get("candidate_name")
                      for u in self.report["records"]["unresolved"]}
        out: dict[str, list[tuple[str | None, str | None]]] = {}
        for key, rec in sorted(self.state["incidents"].items()):
            eras = list(self.eras.get(key) or [])
            if not eras:
                cand = fire_key((rec.get("id_unresolved") or {}).get("candidate"))
                eras = [(self.legacy.get(key), cand_names.get(key)
                         or (self.fires_by_fk.get(cand) or {}).get("post_title"))]
            named = {slug for slug, _title in eras}
            for rel, meta in (rec.get("files") or {}).items():
                if meta.get("kind", rel.split("/", 1)[0]) == "ir":
                    loc = file_location(rec, rel)
                    if loc not in named:
                        eras.append((loc, None))
                        named.add(loc)
            out[key] = eras
        return out

    def legacy_ir_stamps(self) -> None:
        """D3: keep a legacy conversion (vectors/ir/{slug}/{flight}.geojson)
        only for the source file that produced it, and only while that file
        shows on an active fire. The slug-keyed build is recomputed for
        each era the folder was shown under: its current slug with its own
        fire's name, and each foreign prefix with that fire's name.

        Every folder that was shown under a slug claims the keys it
        recomputes there, whether or not its source can be stamped (an
        inactive fire, a hidden source, an unresolved folder): a key that
        two sources' bytes could have made is kept by none. An era with no
        fire name to recompute under contests every key of its slug made
        from a folder of the same name."""
        ir_state = self.state.get("ir") or {}
        rep = self.report["ir"]
        claims: dict[str, set[str]] = {}         # legacy key -> source bytes that could have made it
        contested: set[tuple[str, str]] = set()  # (slug, IR folder) shown with no known name
        options: dict[tuple[str, str], list[tuple]] = {}  # (inc_key, src) -> eras' picks
        for key, eras in self._ir_eras().items():
            rec = self.state["incidents"][key]
            files = rec.get("files") or {}
            for i, (slug, title) in enumerate(eras):
                if not slug:
                    continue
                dirs: dict[str, list[str]] = {}
                for rel, meta in files.items():
                    if meta.get("kind", rel.split("/", 1)[0]) != "ir":
                        continue
                    # a foreign era held what was mirrored under its prefix
                    if i and file_location(rec, rel) != slug:
                        continue
                    dirs.setdefault(rel.rpartition("/")[0], []).append(rel)
                for rel_dir, rels in sorted(dirs.items()):
                    if not title:
                        contested.add((slug, rel_dir))
                        continue
                    picks = legacy_ir_picks(rels, slug, fire_manifests.stem_name(title))
                    for vkey, src, _fid in filter(None, picks):
                        # bytes unknown: a claim no other source shares
                        claims.setdefault(vkey, set()).add(
                            files[src].get("sha16") or f"{key}/{src}")
                    if key not in self.eras:
                        continue  # never stamped: it claims only
                    if len(picks) > 1:
                        rep["order_ambiguous"].append({"key": key, "rel_dir": rel_dir, "slug": slug})
                        continue
                    pick = next(iter(picks))
                    if pick is None:
                        continue
                    vkey, src, flight_id = pick
                    conv = ir_state.get(vkey) or {}
                    if conv.get("failed") or not conv.get("heat_types"):
                        continue
                    current = conv.get("v") == ir_vectors.IR_CONVERTER_VERSION
                    options.setdefault((key, src), []).append(
                        (not current, i, vkey, flight_id, slug, rel_dir))
        for (key, src), opts in sorted(options.items()):
            rec = self.state["incidents"][key]
            meta = rec["files"][src]
            if file_owner(rec, meta) not in self.fires_by_fk or not meta.get("sha16"):
                continue
            # eras disagreeing: the current converter, then the current binding
            _old, _era, vkey, flight_id, slug, rel_dir = min(opts)
            if len(claims[vkey]) > 1 or (slug, rel_dir) in contested:
                rep["key_collisions"].append({"key": key, "src": src, "ir_key": vkey})
                continue
            stamp_ir(rec, src, vkey, flight_id, meta["sha16"])
            rep["stamped"].append({"key": key, "src": src, "ir_key": vkey,
                                   "owner": file_owner(rec, meta)})
        self.log(f"[migrate] D3: {len(rep['stamped'])} legacy IR conversions kept")

    def suspects(self) -> None:
        """Report only: files whose unit token or name points at an active
        fire other than the one showing them (third fires are never moved)."""
        self.report["records"].update(suspect_files(self.state, self.fires_by_fk))

    # -- step E ------------------------------------------------------------

    def rebuild_fires(self) -> None:
        rebuild = {fk for fk in contributors(self.state) if fk in self.fires_by_fk}
        stats: dict = {}
        self.new_manifests = fire_manifests.publish_fire_manifests(
            None, self.out, self.state, self.fires_by_fk, rebuild, {}, replay_only=True,
            stats=stats, log=self.log)
        self.report["ir"]["mixed_hidden"] = stats.get("ir_mixed_hidden", [])
        self._diff_fires()

    def _holders(self) -> dict[str, list[tuple[str, str]]]:
        out: dict[str, list[tuple[str, str]]] = {}
        for key, rec in self.state["incidents"].items():
            for rel, meta in (rec.get("files") or {}).items():
                if meta.get("sha16"):
                    out.setdefault(meta["sha16"], []).append((key, rel))
        return out

    def _loss_reason(self, holders: list[tuple[str, str]], fk: str) -> str | None:
        """Why a sheet fk shows today is not on its new manifest, or None."""
        for key, rel in holders:
            rec = self.state["incidents"][key]
            meta = rec["files"][rel]
            if rec.get("id_unresolved") or rec.get("ignored"):
                return "unresolved"
            if "fk" in meta and meta["fk"] != fk:
                return "stamped"
            if file_owner(rec, meta) != fk:
                return "other fire"
            if (key, rel) in self.missing:
                return "missing"
        return None

    def _cross_named(self, fk: str, man: dict | None, names: dict[str, str | None]) -> int:
        """Entries of a fire's manifest whose file name names another active
        fire (a same-name fire excepted)."""
        if not man:
            return 0
        others = {n for k, n in names.items() if n and k != fk} - {names.get(fk)}
        entries = [[m.get("filename") or ""] for m in man.get("maps") or []]
        entries += [[(f.get(u) or "").rpartition("/")[2] for u in ("pdf_url", "kmz_url")]
                    for f in man.get("ir_flights") or []]
        return sum(1 for filenames in entries
                   if any(names_in(fn, others) for fn in filenames if fn))

    def _diff_fires(self) -> None:
        rep = self.report
        live = self.live_rows()
        holders = self._holders()
        names = {fk: name_norm(f.get("post_title")) for fk, f in self.fires_by_fk.items()}
        idx = self.state.get("incident_fires") or {}
        for fk, fire in sorted(self.fires_by_fk.items()):
            row, slug = live.get(fk, (None, None))
            man_now = self.legacy_manifest(slug) if slug else None
            belongs = bool(man_now) and fire_key(man_now.get("cornea_id")) == fk
            new = self.new_manifests.get(fk)
            if not (row or new):
                continue
            # a manifest naming another fire shows nothing today (the app
            # checks its cornea_id), so only a fire's own counts as shown
            now_maps = (man_now.get("maps") or []) if belongs else []
            now_ir = (man_now.get("ir_flights") or []) if belongs else []
            new_maps = (new or {}).get("maps") or []
            new_ir = (new or {}).get("ir_flights") or []
            e = idx.get(fk) or {}
            rep["fires"].append({
                "fk": fk, "name": fire.get("post_title"),
                "now": {"path": row.get("incident_manifest") if row else None,
                        "maps": len((man_now or {}).get("maps") or []),
                        "ir": len((man_now or {}).get("ir_flights") or []),
                        "manifest_cornea": (man_now or {}).get("cornea_id")},
                "new": {"path": "/" + e["manifest"] if e.get("manifest") else None,
                        "maps": len(new_maps), "ir": len(new_ir),
                        "dirs": e.get("dirs") or [], "primary": e.get("primary")}})
            if (now_maps or now_ir) and not (new_maps or new_ir):
                rep["lost_all_maps"].append({"fk": fk, "name": fire.get("post_title"),
                                             "maps": len(now_maps), "ir": len(now_ir)})
            new_ids = {m.get("id") for m in new_maps}
            for m in now_maps:
                sha = m.get("id")
                if not sha or sha == "unknown" or sha in new_ids:
                    continue
                if self._loss_reason(holders.get(sha, []), fk) is None:
                    rep["unexplained_losses"].append({"fk": fk, "id": sha,
                                                      "filename": m.get("filename")})
            self._url_changes(fk, now_maps, new_maps, now_ir, new_ir)
            counts = {"now": self._cross_named(fk, man_now if belongs else None, names),
                      "new": self._cross_named(fk, new, names)}
            if counts["now"] or counts["new"]:
                rep["cross_named_entries"][fk] = counts
        self.log(f"[migrate] E: {len(self.new_manifests)} fire manifests rebuilt; "
                 f"lost_all_maps={len(rep['lost_all_maps'])} "
                 f"unexplained_losses={len(rep['unexplained_losses'])}")

    def _url_changes(self, fk, now_maps, new_maps, now_ir, new_ir) -> None:
        changes = self.report["locate"].setdefault("url_changes", [])
        new_by_id = {m.get("id"): m for m in new_maps}
        for m in now_maps:
            n = new_by_id.get(m.get("id"))
            if not n or m.get("id") in (None, "unknown"):
                continue
            for field, get in (("pdf_url", lambda x: x.get("pdf_url")),
                               ("preview_url", lambda x: x.get("preview_url")),
                               ("tiles", lambda x: (x.get("tiles") or {}).get("url_template"))):
                if get(m) != get(n):
                    changes.append({"fk": fk, "id": m.get("id"), "field": field,
                                    "now": get(m), "new": get(n)})
        new_by_flight = {f.get("flight_id") or f.get("flight_date"): f for f in new_ir}
        for f in now_ir:
            n = new_by_flight.get(f.get("flight_id") or f.get("flight_date"))
            if f.get("geojson_url") and not (n or {}).get("geojson_url"):
                self.report["ir"]["flights_losing_vectors"].append(
                    {"fk": fk, "flight_id": f.get("flight_id"), "now": f.get("geojson_url")})

    # -- step F ------------------------------------------------------------

    def finish(self) -> None:
        mig = self.state.setdefault("migrations", {})
        mig["incident_ids"] = self.now
        mig["slugs_at_migration"] = dict(sorted(self.legacy.items()))
        mig["backup"] = self.backup_key
        catalog = fire_manifests.publish_catalog(self.out, self.state, self.fires, log=self.log)
        rec = self.report["records"]
        health.publish(self.out, "migration", {
            "started_at": self.now,
            "finished_at": cat.now_iso(),
            "ok": True,
            "note": f"incident records keyed by fire ID (catalog v{catalog['version']})",
            "catalog_version": catalog["version"],
            "resolved": rec["resolved"],
            "unresolved": [u["key"] for u in rec["unresolved"]],
            "reattached": rec["reattached"],
            "split_prefixes": len(self.report["prefixes"]["split"]),
            "raw_relocated": sum(self.report["locate"]["raw"]["relocated"].values()),
            "fires_with_maps": len(self.new_manifests),
            "backup": self.backup_key,
        }, log=self.log)

    # -- step G ------------------------------------------------------------

    def allowed_key(self, key: str) -> bool:
        return ((key.startswith("catalogs/incidents/id/") and key.endswith(".json"))
                or key in {f"catalogs/versions/catalog.{self.version + 1}.json",
                           "catalogs/catalog.json", STATE_KEY, health.KEY})

    def guards(self, expected: dict | None = None) -> list[str]:
        """G1-G8 over the captured outputs (G8 only with an expected
        report). Sets and returns report["would_abort"]."""
        rep = self.report
        out = []
        unresolved = sorted(k for k, r in self.state["incidents"].items() if r.get("id_unresolved"))
        if len(unresolved) > MAX_UNRESOLVED:
            out.append(f"G1: {len(unresolved)} unresolved records (limit {MAX_UNRESOLVED})")
        if rep["lost_all_maps"]:
            out.append("G2: fires lose all their maps: "
                       + ", ".join(x["name"] or x["fk"] for x in rep["lost_all_maps"]))
        if rep["foreign_location_unattributed"] or rep["evidence_conflict"]:
            out.append(f"G3: {len(rep['foreign_location_unattributed'])} foreign locations "
                       f"unattributed, {len(rep['evidence_conflict'])} evidence conflicts")
        if rep["unexplained_losses"]:
            out.append(f"G4: {len(rep['unexplained_losses'])} sheets leave the fire showing them "
                       "with no explanation")
        rises = sorted(fk for fk, c in rep["cross_named_entries"].items() if c["new"] > c["now"])
        if rises:
            out.append("G5: entries naming another fire rise on " + ", ".join(rises))
        stray = [k for k in self.out.captured_keys() if not self.allowed_key(k)]
        if stray:
            out.append("G6: writes outside the migration's keys: " + ", ".join(stray[:10]))
        problems = self._post_build_problems()
        if problems:
            out.append(f"G7: {len(problems)} post-build check(s) fail: " + "; ".join(problems[:10]))
        if expected is not None:
            blockers, drift = expect_diff(expected, rep["per_record"])
            rep["drift"] = drift
            if blockers:
                out.append(f"G8: {len(blockers)} difference(s) from the expected report: "
                           + "; ".join(blockers[:10]))
        rep["would_abort"] = out
        return out

    def _known_missing(self, url: str) -> bool:
        """A URL whose object step C already found nowhere on the bucket."""
        loc = self.report["locate"]
        key = url.lstrip("/")
        if key.startswith(asset_locate.RAW):
            if self._missing_keys is None:
                self._missing_keys = {raw_key(self.state["incidents"][k], rel)
                                      for k, rel in self.missing}
            return key in self._missing_keys
        if url.startswith("/tiles/"):
            return key.split("/")[3] in loc["tiles"]["missing"]
        if url.startswith("/previews/"):
            return key.rpartition("/")[2].removesuffix(".png") in loc["previews"]["missing"]
        return key in loc["ir"]["missing_objects"]

    def _post_build_problems(self) -> list[str]:
        problems = []
        catalog = self.out.get_json("catalogs/catalog.json") or {}
        for row in catalog.get("fires") or []:
            if not row.get("has_incident_maps"):
                continue
            fk = fire_key(row.get("cornea_id"))
            path = fire_manifests.manifest_key(fk)
            if row.get("incident_manifest") != "/" + path:
                problems.append(f"{fk}: catalog path {row.get('incident_manifest')}")
                continue
            man = self.out.get_json(path)
            if man is None:
                problems.append(f"{fk}: {path} not written")
                continue
            if (row.get("incident_map_count"), row.get("incident_ir_count")) != (
                    len(man.get("maps") or []), len(man.get("ir_flights") or [])):
                problems.append(f"{fk}: catalog counts differ from its manifest")
        for path in self.out.captured_keys():
            if not path.startswith("catalogs/incidents/id/"):
                continue
            fk = path.rpartition("/")[2].removesuffix(".json")
            man = self.out.get_json(path) or {}
            if fire_key(man.get("cornea_id")) != fk:
                problems.append(f"{path}: cornea_id {man.get('cornea_id')}")
            for url in asset_locate.manifest_urls(man):
                if not self.listings.url_exists(url) and not self._known_missing(url):
                    problems.append(f"{fk}: {url} is not on the bucket")
        return problems


def run(storage, *, fetch_fires, apply: bool, expect: Path | None = None,
        report_out: Path | None = None, log=print) -> int:
    """migrate-incident-ids, once cli has checked --apply's preconditions.
    `fetch_fires(meta)` returns the active fires (fetch_active_fires)."""
    mode = "apply" if apply else "report"
    now = cat.now_iso()
    raw_state = storage.get_json(STATE_KEY)
    state = state_mod.load_state(storage)
    if migrated(state):
        log("[migrate] state is already keyed by fire ID: nothing to do")
        write_report(report_out, {"mode": mode, "already_migrated": True,
                                  "migrations": state.get("migrations"), "storage_writes": 0})
        return 0
    if raw_state is None:
        log("[migrate] no state/state.json: nothing to migrate")
        write_report(report_out, {"mode": mode, "would_abort": ["no state"], "storage_writes": 0})
        return 2
    expected = None
    if apply:
        try:
            expected = json.loads(Path(expect).read_text())
        except (OSError, ValueError) as exc:
            log(f"[migrate] cannot read the expected report {expect}: {exc}")
            write_report(report_out, {"mode": mode, "would_abort": [f"expect: {exc}"],
                                      "storage_writes": 0})
            return 2

    prev_catalog = get_json_retry(storage, "catalogs/catalog.json") or {}
    meta: dict = {}
    fires = fetch_fires(meta)
    why = fire_list_suspect(meta.get("raw_rows", ACTIVE_FIRES_LIMIT), len(fires),
                            (prev_catalog.get("counts") or {}).get("active_fires"))
    if why:
        # absence from the list detaches nothing here, but every active fire
        # is rebuilt from it: a partial list would drop fires' maps
        log(f"[migrate] M0 refused: {why}")
        write_report(report_out, {"mode": mode, "would_abort": [f"M0: {why}"], "storage_writes": 0})
        return 2

    mig = Migration(storage, state, fires, prev_catalog=prev_catalog, now=now, log=log)
    report = mig.run()
    report["mode"] = mode
    abort = mig.guards(expected)
    log(f"[migrate] captured {len(mig.out.puts)} writes to {len(report['captured_keys'])} keys"
        + ("; would abort: " + " | ".join(abort) if abort else "; guards pass"))
    if not apply:
        write_report(report_out, report)
        return 0
    if abort:
        log("[migrate] apply aborted before any write")
        write_report(report_out, report)
        return 1

    # the state as loaded first, so a restore is possible whatever follows
    try:
        storage.put_json(mig.backup_key, raw_state, cache_control="private, no-store")
        report["storage_writes"] = 1 + mig.out.flush(storage)
    except Exception as exc:
        # The order still holds: manifests alone are unreferenced, and once
        # state carries the flag the next writer publishes the catalog.
        report["flush_error"] = f"{type(exc).__name__}: {exc}"
        write_report(report_out, report)
        raise
    report["flush_verified"] = migrated(storage.get_json(STATE_KEY) or {})
    write_report(report_out, report)
    if not report["flush_verified"]:
        log("[migrate] state/state.json does not carry the flag after the flush")
        return 1
    log(f"[migrate] applied: backup {mig.backup_key}, {report['storage_writes']} writes")
    return 0
