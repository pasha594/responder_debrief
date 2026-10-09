"""prune: delete the bucket objects of incident files whose fire has been
inactive for --days, by fire key. USER POLICY (2026-08-17): FTP-derived
incident data is kept indefinitely, so this never runs on a schedule:
--report (the default) only lists what would go; --days N --confirm, from
the CLI, deletes.

The clock is sync-catalogs' (state.prune, hourly): inactive_since_by_id[fk]
starts the first hour a fire that incident files show on is missing from a
sane active-fire list, last_seen_active[fk] is its last hour on one.

A file is doomed only when the fire it shows on (file_owner) has been
inactive for more than N days by that clock, is not on today's list, and
its folder's own newest upload and last sync are both older than N days.
Unresolved and ignored folders and files shown on no fire are never
doomed. Doomed files keep their state entries, marked `pruned_at` (the
mirror never fetches them again; the backlogs and the manifests skip
them); a folder leaves state only when every file is doomed and so is the
fire it is bound to.

Every object that a surviving file needs stays: its raw key, every object
of its sha, and its IR conversions (or, for an IR flight never stamped,
every conversion under its locations). Only exact keys are deleted, never a
prefix: a prefix can hold other folders' files.

--confirm runs outside the writer group (the operator disables the writing
workflows first), so state is read again before the first delete and
before the save: a state writer that ran meanwhile stops the run, and its
save is never overwritten.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import state as state_mod
from .asset_keys import (
    file_location,
    preview_key,
    raw_key,
    record_prefix,
    tile_root,
    tiles_prefix,
)
from .b2 import ReadOnlyStorage, get_json_retry
from .fire_manifests import manifest_key
from .fires import ACTIVE_FIRES_LIMIT, fire_key, fire_list_suspect
from .incident_ids import file_owner, migrated, own_newest_upload, prior_owner
from .maint import write_report
from .matching import parse_when
from .migrate_ids import legacy_ir_conversions
from .state import STATE_KEY

RAW = "raw/incidents/"
PREVIEWS = "previews/incidents/"
VECTORS = "vectors/ir/"
MANIFESTS = "catalogs/incidents/"


def _older(stamp, cutoff: datetime) -> bool:
    """True when `stamp` parses and is before `cutoff` (no evidence never
    dooms anything)."""
    when = parse_when(stamp)
    return when is not None and when < cutoff


def _is_ir(rel: str, meta: dict) -> bool:
    return meta.get("kind", rel.split("/", 1)[0]) == "ir"


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def clock_summary(state: dict, active: set[str], now: datetime) -> list[dict]:
    """Every fire on prune's clock: since when it is inactive and for how
    many days, and how many unpruned files show on it."""
    clock = state.get("prune") or {}
    seen = clock.get("last_seen_active") or {}
    files: dict[str, int] = {}
    for rec in (state.get("incidents") or {}).values():
        for meta in (rec.get("files") or {}).values():
            if (fk := file_owner(rec, meta)):
                files[fk] = files.get(fk, 0) + 1
    out = []
    for fk, since in sorted((clock.get("inactive_since_by_id") or {}).items()):
        when = parse_when(since)
        days = round((now - when).total_seconds() / 86400, 1) if when else None
        out.append({"fk": fk, "inactive_since": since, "last_seen_active": seen.get(fk),
                    "inactive_days": days, "active_now": fk in active,
                    "files": files.get(fk, 0)})
    return out


class Plan:
    """What a prune at `cutoff` deletes and how it edits state, computed
    from state alone; `resolve` then names the exact keys on the bucket."""

    def __init__(self, state: dict, active: set[str], cutoff: datetime):
        self.state, self.cutoff = state, cutoff
        incidents = state.get("incidents") or {}
        clock = state.get("prune") or {}
        seen = clock.get("last_seen_active") or {}
        #: fires inactive past the cutoff by the clock, and not active today
        self.fires = sorted(
            fk for fk, since in (clock.get("inactive_since_by_id") or {}).items()
            if fk not in active and _older(since, cutoff)
            and (not seen.get(fk) or _older(seen[fk], cutoff)))
        doomed_fks = set(self.fires)
        #: inc_key -> rels doomed now
        self.doomed: dict[str, list[str]] = {}
        for key, rec in incidents.items():
            if not self._folder_old(rec):
                continue  # the folder is still receiving uploads, or was synced since
            rels = [rel for rel, meta in (rec.get("files") or {}).items()
                    if not meta.get("pruned_at") and file_owner(rec, meta) in doomed_fks]
            if rels:
                self.doomed[key] = rels

        # what every surviving file still needs
        self.keep_raw: set[str] = set()
        self.keep_sha: set[str] = set()
        self.keep_ir: set[str] = set()
        ir_state = state.get("ir") or {}
        remaining: set[str] = set()   # fires still shown something after the prune
        self.removed: list[str] = []  # records leaving state
        for key, rec in incidents.items():
            files = rec.get("files") or {}
            gone = set(self.doomed.get(key, ()))
            survivors = [rel for rel, meta in files.items()
                         if not meta.get("pruned_at") and rel not in gone]
            for rel in survivors:
                self.keep_raw.add(raw_key(rec, rel))
                if sha := files[rel].get("sha16"):
                    self.keep_sha.add(sha)
                if fk := file_owner(rec, files[rel]):
                    remaining.add(fk)
            ir_keys = rec.get("ir_keys") or {}
            self.keep_ir.update(e["key"] for src, e in ir_keys.items()
                                if e.get("key") and src in survivors)
            stamped_dirs = {src.rpartition("/")[0] for src in ir_keys}
            if any(_is_ir(rel, files[rel]) and rel.rpartition("/")[0] not in stamped_dirs
                   for rel in survivors):
                # an IR flight never stamped may still be served by a legacy
                # conversion under any location of the folder's files
                locs = {file_location(rec, rel) for rel in survivors} | {record_prefix(rec)}
                self.keep_ir.update(k for k in ir_state
                                    if k.startswith(VECTORS)
                                    and k[len(VECTORS):].partition("/")[0] in locs)
            bound = prior_owner(rec)
            if not survivors and bound in doomed_fks and self._folder_old(rec):
                self.removed.append(key)
            elif bound:
                remaining.add(bound)
        #: doomed fires no folder shows anything on after the prune
        self.emptied = sorted(doomed_fks - remaining)

        slugs_at = (state.get("migrations") or {}).get("slugs_at_migration") or {}
        self.raw: list[str] = []
        self.shas: dict[str, tuple[str, str]] = {}   # sha -> (tile root, preview key)
        self.ir: set[str] = set()
        self.legacy_slugs: dict[str, set[str]] = {fk: set() for fk in self.emptied}
        for key, rels in self.doomed.items():
            rec = incidents[key]
            files = rec["files"]
            for rel in rels:
                rk = raw_key(rec, rel)
                if rk not in self.keep_raw and rk not in self.raw:
                    self.raw.append(rk)
                sha = files[rel].get("sha16")
                if (sha and sha not in self.keep_sha and sha not in self.shas
                        and sha in (state.get("tiled") or {})):
                    self.shas[sha] = (tile_root(tiles_prefix(state, sha, rec), sha),
                                      preview_key(state, sha, rec))
            ir_keys = rec.get("ir_keys") or {}
            self.ir.update(e["key"] for e in ir_keys.values() if e.get("key"))
            # flights never stamped: the slug-keyed build's keys, recomputed
            # for each slug and fire name the folder was shown under
            stamped_dirs = {src.rpartition("/")[0] for src in ir_keys}
            dirs = {rel.rpartition("/")[0] for rel in rels if _is_ir(rel, files[rel])}
            self.ir.update(vkey for vkey, _src, _fid in
                           legacy_ir_conversions(state, key, rec, dirs - stamped_dirs))
            owners = {file_owner(rec, files[rel]) for rel in rels} | {prior_owner(rec)}
            for fk in owners & set(self.emptied):
                self.legacy_slugs[fk].update(filter(None, (
                    slugs_at.get(key), rec.get("fire_slug"), rec.get("storage_prefix"),
                    *(file_location(rec, rel) for rel in rels))))
        self.ir = {k for k in self.ir - self.keep_ir if k in ir_state}

    def _folder_old(self, rec: dict) -> bool:
        """The folder's own newest upload and its last sync are both older
        than the cutoff."""
        return (_older(own_newest_upload(rec), self.cutoff)
                and _older(rec.get("synced_at"), self.cutoff))

    def resolve(self, storage, log=print) -> dict:
        """The exact keys on the bucket, with their sizes: {kind: [(key,
        size)]}. Tiles are listed per sheet (a tile tree is hundreds of
        keys); a legacy slug manifest counts only when it names the fire."""
        def listed(prefix: str) -> dict[str, int]:
            return dict(storage.list_keys(prefix))

        raw, previews, vectors = listed(RAW), listed(PREVIEWS), listed(VECTORS)
        manifests = listed(MANIFESTS)
        out: dict[str, list] = {
            "raw": [(k, raw[k]) for k in self.raw if k in raw],
            "tiles": [], "previews": [],
            "vectors": [(k, vectors[k]) for k in sorted(self.ir) if k in vectors],
            "manifests": [(manifest_key(fk), manifests[manifest_key(fk)])
                          for fk in self.emptied if manifest_key(fk) in manifests],
            "legacy_manifests": [],
        }
        for sha, (root, pkey) in self.shas.items():
            keys = list(storage.list_keys(f"{root}/"))
            if keys:
                out["tiles"].append((root, keys))
            if pkey in previews:
                out["previews"].append((pkey, previews[pkey]))
        seen: set[str] = set()
        for fk in self.emptied:
            for slug in sorted(self.legacy_slugs.get(fk, ())):
                key = f"{MANIFESTS}{slug}.json"
                if key in seen or key not in manifests:
                    continue
                man = get_json_retry(storage, key) or {}
                if fire_key(man.get("cornea_id")) == fk:
                    seen.add(key)
                    out["legacy_manifests"].append((key, manifests[key]))
                else:
                    log(f"[prune] {key} names {man.get('cornea_id')}, not {fk}: kept")
        return out

    def apply_to_state(self, now: str) -> dict:
        """pruned_at on every doomed file; the sha, IR and index entries of
        what goes; folders with nothing left."""
        state = self.state
        incidents = state["incidents"]
        n = 0
        for key, rels in self.doomed.items():
            rec = incidents[key]
            for rel in rels:
                rec["files"][rel]["pruned_at"] = now
                n += 1
            ir_keys = rec.get("ir_keys") or {}
            for src in [s for s, e in ir_keys.items() if e.get("key") in self.ir]:
                ir_keys.pop(src)
        for sha in self.shas:
            state["tiled"].pop(sha, None)
        for key in self.ir:
            (state.get("ir") or {}).pop(key, None)
        idx = state.get("incident_fires") or {}
        for fk in self.emptied:
            idx.pop(fk, None)
        for fk in set(self.fires) - set(self.emptied):
            if fk in idx:
                idx[fk]["v"] = 0  # lost files: rebuilt should it be active again
        for key in self.removed:
            incidents.pop(key, None)
        return {"pruned_at": n, "tiled_popped": len(self.shas), "ir_popped": len(self.ir),
                "index_popped": list(self.emptied), "records_removed": list(self.removed)}


def run(storage, *, fetch_fires, days: int | None, confirm: bool,
        report_out: Path | None = None, log=print, now: datetime | None = None) -> int:
    """prune. Report mode (no --confirm) writes nothing; --confirm needs
    --days, both migration flags and a sane active-fire list."""
    now = now or datetime.now(timezone.utc)
    mode = "confirm" if confirm else "report"
    doc: dict = {"command": "prune", "mode": mode, "days": days, "generated_at": _iso(now),
                 "would_refuse": [], "deleted": [], "storage_writes": 0}

    def refuse(why: str) -> int:
        log(f"[prune] refused: {why}")
        doc["error"] = why
        write_report(report_out, doc)
        return 2

    if confirm and days is None:
        return refuse("incident data is kept indefinitely by policy; to delete, pass "
                      "BOTH --days N and --confirm")
    if days is not None and days < 1:
        return refuse(f"--days {days}: the threshold is at least one day")
    ro = ReadOnlyStorage(storage)
    state = state_mod.load_state(ro)
    loaded_at = state.get("updated_at")
    if not migrated(state):
        return refuse("state is not keyed by fire ID yet (migrate-incident-ids)")
    if not (state.get("migrations") or {}).get("incident_keys_audit"):
        why = "the key audit has not repaired state yet (audit-incident-keys --repair)"
        if confirm:
            return refuse(why)
        doc["would_refuse"].append(why)
    meta: dict = {}
    fires = fetch_fires(meta)
    prev = get_json_retry(ro, "catalogs/catalog.json") or {}
    why = fire_list_suspect(meta.get("raw_rows", ACTIVE_FIRES_LIMIT), len(fires),
                            (prev.get("counts") or {}).get("active_fires"))
    if why:
        # a fire missing from a partial list is not inactive
        if confirm:
            return refuse(f"active-fire list: {why}")
        doc["would_refuse"].append(f"active-fire list: {why}")
    active = {fk for f in fires if (fk := fire_key(f.get("cornea_id")))}
    doc["clock"] = clock_summary(state, active, now)
    if days is None:
        log(f"[prune] report: {len(doc['clock'])} fire(s) on the inactivity clock; "
            "pass --days N for what would be deleted")
        write_report(report_out, doc)
        return 0

    cutoff = now - timedelta(days=days)
    plan = Plan(state, active, cutoff)
    found = plan.resolve(ro, log)
    tile_keys = [k for _root, keys in found["tiles"] for k, _size in keys]
    flat = {kind: [k for k, _size in found[kind]]
            for kind in ("raw", "previews", "vectors", "manifests", "legacy_manifests")}
    sizes = {kind: sum(size for _k, size in found[kind])
             for kind in ("raw", "previews", "vectors", "manifests", "legacy_manifests")}
    sizes["tiles"] = sum(size for _root, keys in found["tiles"] for _k, size in keys)
    doc.update({
        "cutoff": _iso(cutoff),
        "fires": plan.fires,
        "emptied_fires": plan.emptied,
        "files": {key: len(rels) for key, rels in sorted(plan.doomed.items())},
        "records_removed": plan.removed,
        "delete": {**flat, "tiles": [{"root": root, "keys": len(keys),
                                      "bytes": sum(s for _k, s in keys)}
                                     for root, keys in found["tiles"]]},
        "keys": sum(len(v) for v in flat.values()) + len(tile_keys),
        "bytes": dict(sizes, total=sum(sizes.values())),
    })
    log(f"[prune] {len(plan.fires)} fire(s) inactive > {days}d; "
        f"{sum(len(r) for r in plan.doomed.values())} file(s) doomed; "
        f"{doc['keys']} key(s), {doc['bytes']['total'] / 1e6:.1f} MB")
    if not confirm:
        log("[prune] report only: nothing deleted")
        write_report(report_out, doc)
        return 0

    def writer_ran() -> str | None:
        """Why state changed since it was loaded (a writer saved it), or None."""
        now_at = (get_json_retry(ro, STATE_KEY) or {}).get("updated_at")
        if now_at == loaded_at:
            return None
        return (f"state was saved at {now_at} after this run loaded it ({loaded_at}): "
                "a state writer ran; disable mirror.yml, tile.yml and catalogs.yml, "
                "wait for their runs to finish, and run again")

    # Nothing is deleted under a writer: the plan would be stale.
    if why := writer_ran():
        return refuse(why)
    # Exact keys, in upload order reversed: the manifests first, then the
    # objects they name. State is saved last, so a run that dies part-way
    # is simply run again (the same plan; deleting a missing key succeeds).
    doc["deleted_tile_roots"] = []
    try:
        for kind in ("manifests", "legacy_manifests", "vectors", "previews"):
            if flat[kind]:
                storage.delete_keys(flat[kind])
                doc["deleted"].extend(flat[kind])
        for root, keys in found["tiles"]:
            storage.delete_keys([k for k, _size in keys])
            doc["deleted_tile_roots"].append({"root": root, "keys": len(keys)})
        if flat["raw"]:
            storage.delete_keys(flat["raw"])
            doc["deleted"].extend(flat["raw"])
    except Exception as exc:
        doc["error"] = f"{type(exc).__name__}: {exc}"
        log(f"[prune] delete failed after {len(doc['deleted'])} key(s): {doc['error']} "
            "— state not saved; run again")
        write_report(report_out, doc)
        return 1
    if why := writer_ran():
        # its save stands; a run again recomputes the plan from it
        doc["error"] = why
        log(f"[prune] after {len(doc['deleted'])} key(s) deleted: {why} — state not saved")
        write_report(report_out, doc)
        return 1
    doc["state"] = plan.apply_to_state(_iso(now))
    state_mod.save_state(storage, state)
    doc["storage_writes"] = 1
    log(f"[prune] done: {len(doc['deleted']) + len(tile_keys)} key(s) deleted, "
        f"{doc['state']['pruned_at']} file(s) marked pruned_at")
    write_report(report_out, doc)
    return 0
