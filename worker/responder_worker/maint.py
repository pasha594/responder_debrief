"""Operator corrections to incident state, run from maint.yml.

reassign-files   move files of one folder to another fire, hide them, or
                 hand them back to the folder's binding (stamps fk_src
                 "manual", which survives new revisions of the file)
restore-state-backup
                 the incident-ID migration's rollback: put the pre-migration
                 state backup back over state/state.json

Both edit state only: no FTP, no other object written, nothing deleted.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from . import state as state_mod
from .b2 import get_json_retry
from .fires import fire_key, is_fire_id
from .incident_ids import file_owner, migrated
from .state import STATE_KEY


def write_report(path: Path | None, doc: dict) -> None:
    """The run's JSON report (maint.yml uploads it as the `report` artifact)."""
    if path is None:
        return
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=1, ensure_ascii=False, sort_keys=False) + "\n")


def reassign_files(storage, *, key: str, rel: str, to: str, apply: bool,
                   report_out: Path | None = None, log=print) -> int:
    """Stamp every file of folder `key` whose rel matches the regex `rel`:
    `to` a fire GUID (any spelling) shows them on that fire, `hidden` on
    none, `binding` drops the stamp so they follow the folder's binding.
    The index entry of every fire that gains or loses a file is marked
    stale (v=0), so the next mirror run rebuilds its manifest. Report mode
    computes the same changes and saves nothing."""
    doc: dict = {"command": "reassign-files", "mode": "apply" if apply else "report",
                 "key": key, "rel": rel, "to": to}

    def refuse(why: str) -> int:
        log(f"[reassign] refused: {why}")
        doc["error"] = why
        write_report(report_out, doc)
        return 2

    state = state_mod.load_state(storage)
    if not migrated(state):
        return refuse("state is not keyed by fire ID yet; file stamps mean nothing before "
                      "the incident-ID migration")
    rec = state["incidents"].get(key)
    if rec is None:
        return refuse(f"no incident folder {key!r}")
    try:
        rx = re.compile(rel)
    except re.error as exc:
        return refuse(f"--rel is not a regular expression: {exc}")
    if to in ("binding", "hidden"):
        target = to
    elif is_fire_id(to):
        target = fire_key(to)
    else:
        return refuse(f"--to takes a fire GUID, 'binding' or 'hidden', not {to!r} "
                      "(fire names are shared between fires)")
    hits = [r for r in rec.get("files") or {} if rx.search(r)]
    if not hits:
        return refuse(f"no file of {key} matches {rel!r}")

    changes, affected = [], set()
    for r in hits:
        meta = rec["files"][r]
        before = file_owner(rec, meta)
        if target == "binding":
            meta.pop("fk", None)
            meta.pop("fk_src", None)
        else:
            meta["fk"] = None if target == "hidden" else target
            meta["fk_src"] = "manual"
        after = file_owner(rec, meta)
        changes.append({"rel": r, "before": before, "after": after})
        affected.update(fk for fk in (before, after) if fk)
        log(f"[reassign] {r}: {before} -> {after}")
    idx = state.get("incident_fires") or {}
    marked = sorted(fk for fk in affected if fk in idx)
    for fk in marked:
        idx[fk]["v"] = 0
    doc.update(files=changes, fires=sorted(affected), marked_stale=marked)
    if apply:
        state_mod.save_state(storage, state)
        log(f"[reassign] saved: {len(changes)} file(s), {len(marked)} fire manifest(s) "
            "marked for rebuild")
    else:
        log(f"[reassign] report only: {len(changes)} file(s) would change")
    write_report(report_out, doc)
    return 0


def restore_state_backup(storage, *, apply: bool, report_out: Path | None = None,
                         log=print) -> int:
    """Copy the backup named by migrations.backup over state/state.json,
    once it parses as a state document without the incident_ids flag.
    Apply only (it is the rollback; run it with the writers disabled)."""
    doc: dict = {"command": "restore-state-backup", "mode": "apply" if apply else "report"}

    def refuse(why: str) -> int:
        log(f"[restore] refused: {why}")
        doc["error"] = why
        write_report(report_out, doc)
        return 2

    if not apply:
        return refuse("apply only: restoring overwrites state/state.json")
    state = storage.get_json(STATE_KEY) or {}
    backup_key = (state.get("migrations") or {}).get("backup")
    if not backup_key:
        return refuse("state names no migrations.backup")
    doc["backup"] = backup_key
    try:
        backup = get_json_retry(storage, backup_key)
    except ValueError as exc:
        return refuse(f"{backup_key} does not parse: {exc}")
    if not isinstance(backup, dict) or not isinstance(backup.get("incidents"), dict):
        return refuse(f"{backup_key} is missing or not a state document")
    if migrated(backup):
        return refuse(f"{backup_key} carries the incident_ids flag: it is not a "
                      "pre-migration state")
    storage.put_json(STATE_KEY, backup, cache_control="private, no-store")
    if migrated(storage.get_json(STATE_KEY) or {}):
        log("[restore] state/state.json still carries the flag after the write")
        doc["error"] = "verify failed"
        write_report(report_out, doc)
        return 1
    doc.update(restored=True, backup_updated_at=backup.get("updated_at"),
               replaced_updated_at=state.get("updated_at"))
    log(f"[restore] state/state.json restored from {backup_key} "
        f"(state of {backup.get('updated_at')})")
    write_report(report_out, doc)
    return 0
