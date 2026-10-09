"""audit-incident-keys: every incident key state names, checked against the
bucket's listings (asset_locate, the same LIST pass and locate rules as the
incident-ID migration's step C).

--report (the default) runs over a ReadOnlyStorage and lists:
  1  raw files not at their raw_key, with the hash-verified copy found
  2  shas whose tiles or preview are not where their stamps point, with the
     copies listed elsewhere
  3  every URL in every published ID manifest that names no object
  4  IR: failed conversions with their sources (the files stamped to the
     key; for a legacy key no stamp names, the files the slug-keyed build
     could have converted it from) and whether one now resolves;
     conversions and ir_keys whose object is not on the bucket
  5  files of different folders at one raw key with other sizes or bytes
  6  files whose unit token or name points at a third fire
  7  records whose fire_slug is not their storage_prefix (older code)
  8  raw files at their key with another size

--repair runs the same checks and edits state only: new hash-verified
locations are stamped; raw files found nowhere are marked `missing`; a
preview found nowhere is queued for the probe backlog's preview-only pass
(`needs_preview`) and tiles found nowhere for the tile backlog
(tiler_version None); IR conversions with no object are dropped, so the
next mirror run converts their sources into new keys, and failed ones whose
object exists get their heat types back. Every fire whose manifest that
touches, and every fire whose manifest item 3 found broken, is marked stale
(incident_fires[fk].v = 0) and migrations.incident_keys_audit is set.

--refetch-missing (with --repair) GETs every `missing` file from the FTP
with no conditional headers and writes bytes that still hash to the file's
sha16 to its new_raw_key, only when nothing is at that key yet (by the
audit's LIST, this run's writes and a HEAD that must answer) and no other
record's file with other bytes is stamped there.

Nothing is ever deleted or copied on the bucket.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import httpx

from . import asset_locate, state as state_mod
from .asset_keys import new_raw_key, raw_key
from .b2 import ReadOnlyStorage, get_json_retry
from .fires import ACTIVE_FIRES_LIMIT, fire_key, fire_list_suspect
from .http import get
from .incident_ids import file_owner, migrated, suspect_files
from .maint import write_report
from .migrate_ids import legacy_ir_conversions


def _records(state: dict):
    for inc_key, rec in (state.get("incidents") or {}).items():
        if rec.get("storage_prefix") or rec.get("fire_slug"):
            yield inc_key, rec


def heat_types_of(doc: dict | None) -> list[str]:
    """The heat classes a converted flight holds, in order of appearance
    (each feature carries its `heat_type`, as ir_vectors writes them)."""
    out: list[str] = []
    for f in (doc or {}).get("features") or []:
        heat = (f.get("properties") or {}).get("heat_type")
        if heat and heat not in out:
            out.append(heat)
    return out


class Audit:
    """The checks over `state` (edited in place when `repair`); reads and
    listings go through a read-only view of the bucket."""

    def __init__(self, storage, state: dict, fires: list[dict], *, repair: bool, now: str,
                 log=print):
        self.ro = ReadOnlyStorage(storage)
        self.state = state
        self.fires_by_fk = {fk: f for f in fires if (fk := fire_key(f.get("cornea_id")))}
        self.repair, self.now, self.log = repair, now, log
        self.listings: asset_locate.Listings | None = None
        self.manifests: dict[str, dict] = {}
        #: fire keys whose manifests the repair changed (marked stale)
        self.affected: set[str] = set()
        self._by_sha: dict[str, list[tuple[dict, dict]]] | None = None
        self.report: dict = {
            "command": "audit-incident-keys",
            "mode": "repair" if repair else "report",
            "generated_at": now,
            "state_updated_at": state.get("updated_at"),
            "fire_list_suspect": None,
            "raw": {},
            "shas": {},
            "manifests": {"checked": 0, "urls": 0, "missing_urls": [], "problems": []},
            "ir": {"failed": [], "failed_source_resolves": [], "missing_objects": [],
                   "ir_keys_missing": []},
            "shared_rel_conflicts": [],
            "id_suspect": [],
            "name_suspect": [],
            "slug_drift": [],
            "raw_size_mismatch": [],
        }
        if repair:
            self.report["repair"] = {
                "raw_stamped": 0, "missing_marked": [], "missing_cleared": [],
                "shas_stamped": 0, "needs_preview": [],
                "tiles_requeued": [], "ir_failed_dropped": [], "ir_heat_types_restored": [],
                "ir_lost_dropped": [], "ir_keys_dropped": [], "marked_stale": []}

    def _affect(self, rec: dict, meta: dict | None) -> None:
        if meta is not None and (fk := file_owner(rec, meta)):
            self.affected.add(fk)

    def _affect_sha(self, sha: str) -> None:
        if self._by_sha is None:
            self._by_sha = {}
            for _key, rec in _records(self.state):
                for meta in (rec.get("files") or {}).values():
                    if meta.get("sha16") and not meta.get("pruned_at"):
                        self._by_sha.setdefault(meta["sha16"], []).append((rec, meta))
        for rec, meta in self._by_sha.get(sha, ()):
            self._affect(rec, meta)

    def run(self) -> dict:
        self.listings = asset_locate.list_assets(self.ro, self.log)
        self.check_manifests()
        self.check_raw()
        self.check_shas()
        self.check_ir()
        self.check_shared_rels()
        self.report.update(suspect_files(self.state, self.fires_by_fk))
        self.report["slug_drift"] = [
            {"key": k, "fire_slug": r.get("fire_slug"), "storage_prefix": r.get("storage_prefix")}
            for k, r in sorted(_records(self.state))
            if r.get("fire_slug") != r.get("storage_prefix")]
        return self.report

    # -- 3: published manifests ---------------------------------------------

    def check_manifests(self) -> None:
        """Every URL of every ID manifest the index names, against the
        listings (also the copies item 2 prefers: the ones they link)."""
        rep = self.report["manifests"]
        for fk, entry in sorted((self.state.get("incident_fires") or {}).items()):
            path = entry.get("manifest")
            try:
                man = get_json_retry(self.ro, path) if path else None
            except ValueError as exc:
                rep["problems"].append({"fk": fk, "problem": f"{path} does not parse: {exc}"})
                continue
            if not man:
                rep["problems"].append({"fk": fk, "problem": f"{path} is not on the bucket"})
                continue
            self.manifests[fk] = man
            rep["checked"] += 1
            if fire_key(man.get("cornea_id")) != fk:
                rep["problems"].append({"fk": fk, "problem": f"cornea_id {man.get('cornea_id')}"})
            for url in asset_locate.manifest_urls(man):
                rep["urls"] += 1
                if not self.listings.url_exists(url):
                    rep["missing_urls"].append({"fk": fk, "url": url})
        self.log(f"[audit] manifests: {rep['checked']} checked, {rep['urls']} URLs, "
                 f"{len(rep['missing_urls'])} name no object")

    # -- 1, 8: raw files -----------------------------------------------------

    def check_raw(self) -> None:
        """locate_raw over every file (stamping only when repairing); a file
        found nowhere is marked missing, one found again loses the mark."""
        prefer = {k: [s] for k, s in
                  ((self.state.get("migrations") or {}).get("slugs_at_migration") or {}).items()}
        raw = asset_locate.locate_raw(self.ro, self.state, self.listings, prefer=prefer,
                                      stamp=self.repair, log=self.log)
        self.report["raw"] = raw
        self.report["raw_size_mismatch"] = raw["raw_size_mismatch"]
        self.log(f"[audit] raw: ok={raw['ok']} elsewhere={len(raw['moves'])} "
                 f"missing={len(raw['missing'])} size_mismatch={len(raw['raw_size_mismatch'])}")
        if not self.repair:
            return
        incidents = self.state["incidents"]
        rep = self.report["repair"]
        rep["raw_stamped"] = len(raw["moves"])
        for move in raw["moves"]:
            rec = incidents[move["key"]]
            self._affect(rec, rec["files"][move["rel"]])
        missing = {(m["key"], m["rel"]) for m in raw["missing"]}
        for inc_key, rec in _records(self.state):
            for rel, meta in (rec.get("files") or {}).items():
                if meta.get("pruned_at"):
                    continue
                if (inc_key, rel) in missing:
                    if not meta.get("missing"):
                        meta["missing"] = self.now  # since when, kept across audits
                        rep["missing_marked"].append({"key": inc_key, "rel": rel})
                        self._affect(rec, meta)
                elif meta.pop("missing", None):
                    rep["missing_cleared"].append({"key": inc_key, "rel": rel})
                    self._affect(rec, meta)

    # -- 2: tiles and previews -----------------------------------------------

    def check_shas(self) -> None:
        """Unstamped shas are located first (locate_shas, as the migration
        did); then every sha's claimed copies are checked where its stamps
        point (audit_shas). Copies found nowhere are queued again."""
        tiled = self.state["tiled"]
        before = {sha: (e.get("prefix"), e.get("preview_prefix")) for sha, e in tiled.items()}
        live_tiles, live_previews = asset_locate.live_copies(self.manifests.values())
        unstamped = asset_locate.locate_shas(self.state, self.listings, live_tiles,
                                             live_previews, stamp=self.repair)
        shas = asset_locate.audit_shas(self.state, self.listings, live_tiles, live_previews,
                                       stamp=self.repair)
        self.report["shas"] = {"unstamped": unstamped, **shas}
        self.log(f"[audit] shas: tiles moved={len(shas['tiles']['moved'])} "
                 f"missing={len(shas['tiles']['missing'])}; previews "
                 f"moved={len(shas['previews']['moved'])} "
                 f"missing={len(shas['previews']['missing'])}")
        if not self.repair:
            return
        rep = self.report["repair"]
        restamped = [sha for sha, e in tiled.items()
                     if (e.get("prefix"), e.get("preview_prefix")) != before.get(sha)]
        rep["shas_stamped"] = len(restamped)
        for sha in restamped:
            self._affect_sha(sha)
        for sha in shas["previews"]["missing"]:
            # the probe backlog renders it again (preview-only, tiles untouched)
            tiled[sha]["needs_preview"] = True
            rep["needs_preview"].append(sha)
            self._affect_sha(sha)
        for sha in shas["tiles"]["missing"]:
            # the tile worker and the tile backlog pick it up again
            tiled[sha]["tiler_version"] = None
            rep["tiles_requeued"].append(sha)
            self._affect_sha(sha)

    # -- 4: IR conversions ---------------------------------------------------

    def _legacy_sources(self) -> dict[str, list[tuple[str, str]]]:
        """Legacy IR key (vectors/ir/{slug}/{flight}.geojson) -> the files
        the slug-keyed build could have converted it from, recomputed as
        prune recomputes them (legacy_ir_conversions)."""
        out: dict[str, list[tuple[str, str]]] = {}
        for inc_key, rec in _records(self.state):
            dirs = {rel.rpartition("/")[0] for rel, meta in (rec.get("files") or {}).items()
                    if meta.get("kind", rel.split("/", 1)[0]) == "ir"}
            if not dirs:
                continue
            for vkey, src, _fid in sorted(legacy_ir_conversions(self.state, inc_key, rec, dirs)):
                if (inc_key, src) not in out.setdefault(vkey, []):
                    out[vkey].append((inc_key, src))
        return out

    def check_ir(self) -> None:
        ir_state = self.state.setdefault("ir", {})
        incidents = self.state["incidents"]
        vectors = self.listings.vectors
        moved = {(m["key"], m["rel"]) for m in self.report["raw"].get("moves") or []}
        refs: dict[str, list[tuple[str, str]]] = {}
        for inc_key, rec in _records(self.state):
            for src, e in (rec.get("ir_keys") or {}).items():
                if e.get("key"):
                    refs.setdefault(e["key"], []).append((inc_key, src))
        legacy: dict[str, list[tuple[str, str]]] | None = None
        rep = self.report["ir"]
        for key, e in sorted(ir_state.items()):
            e = e or {}
            if e.get("failed"):
                # the files stamped to the key; a key no stamp names (every
                # failed slug-keyed conversion: the migration never stamped
                # one) is matched to the files that build could have used
                via, holders = "ir_keys", refs.get(key)
                if not holders:
                    if legacy is None:
                        legacy = self._legacy_sources()
                    via, holders = "legacy", legacy.get(key, [])
                sources = []
                for inc_key, src in holders:
                    rec = incidents[inc_key]
                    meta = (rec.get("files") or {}).get(src)
                    rk = raw_key(rec, src) if meta else None
                    sources.append({"key": inc_key, "src": src, "via": via, "raw_key": rk,
                                    "resolves": bool(meta) and not meta.get("pruned_at")
                                    and (rk in self.listings.raw or (inc_key, src) in moved)})
                rep["failed"].append({"key": key, "object_exists": key in vectors,
                                      "sources": sources})
                if any(s["resolves"] for s in sources):
                    rep["failed_source_resolves"].append(key)
            elif e.get("heat_types") and key not in vectors:
                rep["missing_objects"].append(key)
        for inc_key, rec in _records(self.state):
            for src, e in sorted((rec.get("ir_keys") or {}).items()):
                if e.get("key") not in vectors:
                    rep["ir_keys_missing"].append({"key": inc_key, "src": src,
                                                   "ir_key": e.get("key")})
        self.log(f"[audit] IR: {len(rep['failed'])} failed "
                 f"({len(rep['failed_source_resolves'])} with a source that resolves), "
                 f"{len(rep['missing_objects'])} conversions and "
                 f"{len(rep['ir_keys_missing'])} stamped keys with no object")
        if not self.repair:
            return
        fix = self.report["repair"]

        def affect_refs(key: str) -> None:
            for inc_key, src in refs.get(key, []):
                rec = incidents[inc_key]
                self._affect(rec, (rec.get("files") or {}).get(src))

        for key, e in list(ir_state.items()):
            e = e or {}
            if e.get("failed"):
                if key not in vectors:
                    # nothing was written there. A stamped key: the next
                    # mirror run converts its source again (into a key that
                    # is still free). A key no stamp names is only cleaned
                    # up: nothing converts into it again (a source with no
                    # stamp converts into a new key anyway)
                    ir_state.pop(key)
                    fix["ir_failed_dropped"].append(key)
                    affect_refs(key)
                    continue
                try:
                    heat = heat_types_of(get_json_retry(self.ro, key))
                except ValueError:
                    heat = []  # not a conversion's output: stays failed
                if heat:
                    e.pop("failed", None)
                    e["heat_types"] = heat
                    fix["ir_heat_types_restored"].append(key)
                    affect_refs(key)
            elif e.get("heat_types") and key not in vectors:
                # a conversion whose object is gone would be reused from
                # state for its own key; dropped, the source converts again
                ir_state.pop(key)
                fix["ir_lost_dropped"].append(key)
                affect_refs(key)
        for inc_key, rec in _records(self.state):
            ir_keys = rec.get("ir_keys") or {}
            for src in [s for s, e in ir_keys.items() if e.get("key") not in vectors]:
                ir_keys.pop(src)
                fix["ir_keys_dropped"].append({"key": inc_key, "src": src})
                self._affect(rec, (rec.get("files") or {}).get(src))

    # -- 5: one raw key, several files ---------------------------------------

    def raw_holders(self) -> dict[str, list[dict]]:
        """raw key -> every unpruned file whose bytes state places there."""
        by_key: dict[str, list[dict]] = {}
        for inc_key, rec in _records(self.state):
            for rel, meta in (rec.get("files") or {}).items():
                if not meta.get("pruned_at"):
                    by_key.setdefault(raw_key(rec, rel), []).append(
                        {"key": inc_key, "rel": rel, "size": meta.get("size"),
                         "sha16": meta.get("sha16")})
        return by_key

    def check_shared_rels(self) -> None:
        self.report["shared_rel_conflicts"] = [
            {"raw_key": key, "holders": holders}
            for key, holders in sorted(self.raw_holders().items())
            if len({h["key"] for h in holders}) > 1
            and len({(h["size"], h["sha16"]) for h in holders}) > 1]

    # -- --refetch-missing ---------------------------------------------------

    def refetch_missing(self, storage, client) -> dict:
        """GET every file marked missing from its FTP URL, unconditionally
        (the file's etag would only earn a 304), and write bytes that hash
        to its sha16 to its new_raw_key, never over an existing object and
        never where another record's file with other bytes is stamped (the
        mirror's _foreign guard: that file's URLs would serve these bytes)."""
        out: dict = {"restored": [], "revised_upstream": [], "unrecoverable": [],
                     "key_occupied": [], "key_claimed": [], "errors": []}
        holders = self.raw_holders()
        written: set[str] = set()
        for inc_key, rec in _records(self.state):
            for rel, meta in (rec.get("files") or {}).items():
                if not meta.get("missing") or meta.get("pruned_at"):
                    continue
                item = {"key": inc_key, "rel": rel, "url": meta.get("url")}
                if not meta.get("url"):
                    out["unrecoverable"].append(dict(item, reason="no FTP URL"))
                    continue
                try:
                    resp = get(client, meta["url"])
                except httpx.HTTPStatusError as exc:
                    if exc.response.status_code in (404, 410):
                        out["unrecoverable"].append(
                            dict(item, reason=f"FTP {exc.response.status_code}"))
                    else:
                        out["errors"].append(dict(item, error=str(exc)))
                    continue
                except httpx.HTTPError as exc:
                    out["errors"].append(dict(item, error=f"{type(exc).__name__}: {exc}"))
                    continue
                if resp.status_code != 200:
                    out["errors"].append(dict(item, error=f"HTTP {resp.status_code}"))
                    continue
                body = resp.content
                sha = hashlib.sha256(body).hexdigest()[:16]
                if sha != meta.get("sha16"):
                    # a new revision upstream: the mirror's next conditional
                    # GET of the file takes it as one
                    out["revised_upstream"].append(
                        dict(item, sha16=meta.get("sha16"), upstream_sha16=sha))
                    continue
                key = new_raw_key(rec, rel)
                claimed = [h for h in holders.get(key, ())
                           if h["key"] != inc_key and h["sha16"] != meta.get("sha16")]
                if claimed:
                    out["key_claimed"].append(dict(item, raw_key=key, holders=claimed))
                    continue
                # Occupied by the audit's own LIST (it runs in the writer
                # group, so nothing else writes meanwhile), by this run, or
                # by a HEAD. A HEAD that fails is never read as "free".
                try:
                    occupied = (key in self.listings.raw or key in written
                                or storage.exists_strict(key))
                except Exception as exc:
                    out["errors"].append(dict(item, raw_key=key,
                                              error=f"HEAD {type(exc).__name__}: {exc}"))
                    continue
                if occupied:
                    out["key_occupied"].append(dict(item, raw_key=key))
                    continue
                storage.put_bytes(key, body)
                written.add(key)
                meta.pop("prefix", None)
                meta.pop("missing", None)
                out["restored"].append(dict(item, raw_key=key))
                self._affect(rec, meta)
        self.log(f"[audit] refetch: {len(out['restored'])} restored, "
                 f"{len(out['revised_upstream'])} revised upstream, "
                 f"{len(out['unrecoverable'])} unrecoverable, "
                 f"{len(out['key_occupied']) + len(out['key_claimed'])} at a taken key, "
                 f"{len(out['errors'])} errors")
        return out


def run(storage, *, fetch_fires, repair: bool, refetch: bool = False, client=None,
        report_out: Path | None = None, log=print) -> int:
    """audit-incident-keys. `fetch_fires(meta)` returns the active fires
    (fetch_active_fires); `client` is the FTP client --refetch-missing uses."""
    mode = "repair" if repair else "report"
    if refetch and not repair:
        log("[audit] refused: --refetch-missing writes raw objects; it runs with --repair only")
        write_report(report_out, {"command": "audit-incident-keys", "mode": mode,
                                  "error": "--refetch-missing needs --repair",
                                  "storage_writes": 0})
        return 2
    now = state_mod.now_iso()
    state = state_mod.load_state(storage)
    if not migrated(state):
        log("[audit] refused: state is not keyed by fire ID yet (migrate-incident-ids)")
        write_report(report_out, {"command": "audit-incident-keys", "mode": mode,
                                  "error": "state is not migrated", "storage_writes": 0})
        return 2
    meta: dict = {}
    fires = fetch_fires(meta)
    prev = get_json_retry(storage, "catalogs/catalog.json") or {}
    audit = Audit(storage, state, fires, repair=repair, now=now, log=log)
    # the active fires only name third fires in items 6; a partial list
    # leaves some unnamed, which the report says
    audit.report["fire_list_suspect"] = fire_list_suspect(
        meta.get("raw_rows", ACTIVE_FIRES_LIMIT), len(fires),
        (prev.get("counts") or {}).get("active_fires"))
    report = audit.run()
    writes = 0
    if repair:
        if refetch:
            report["refetch"] = audit.refetch_missing(storage, client)
            writes += len(report["refetch"]["restored"])
        idx = state.get("incident_fires") or {}
        # also every manifest item 3 found broken (not on the bucket, not
        # parsing, another fire's, or linking objects that are gone): a
        # rebuild from state is idempotent
        broken = ({p["fk"] for p in report["manifests"]["problems"]}
                  | {u["fk"] for u in report["manifests"]["missing_urls"]})
        marked = sorted(fk for fk in audit.affected | broken if fk in idx)
        for fk in marked:
            idx[fk]["v"] = 0  # the next mirror run rebuilds it
        report["repair"]["marked_stale"] = marked
        state.setdefault("migrations", {})["incident_keys_audit"] = now
        state_mod.save_state(storage, state)
        writes += 1
        log(f"[audit] repaired: state saved, {len(marked)} fire manifest(s) marked for rebuild")
    else:
        log("[audit] report only: nothing written")
    report["storage_writes"] = writes
    write_report(report_out, report)
    return 0
