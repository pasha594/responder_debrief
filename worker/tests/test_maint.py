"""maint.yml commands: per-file reassignment (state only, rebuild marked)
and the migration's rollback; the parser registrations they run through."""

import json

import pytest

from incident_world import AU_FK, AU_KEY, AUSTIN, GH_FK, GH_KEY, GRASSHOPPER, NOW, SpyStorage
from responder_worker import cli, fire_manifests as fm
from responder_worker.incident_ids import file_owner
from responder_worker.state import STATE_KEY

SHEETS = ["products/20260820/Ops_Austin_0820.pdf", "products/20260820/PIO_Austin_0820.pdf",
          "products/20261003/Ops_Grasshopper_1003.pdf"]


def _migrated():
    gh = {"fire_slug": "grasshopper", "storage_prefix": "grasshopper",
          "cornea_id": GRASSHOPPER["cornea_id"], "match": {"method": "unit_id"},
          "files": {rel: {"sha16": f"{i:016x}", "prefix": "austin"} for i, rel in enumerate(SHEETS)}}
    gh["files"][SHEETS[1]].update(fk=None, fk_src="hidden")
    au = {"fire_slug": "austin", "storage_prefix": "austin", "cornea_id": AUSTIN["cornea_id"],
          "match": {"method": "unit_id"}, "files": {"products/a.pdf": {"sha16": "ab"}}}
    entry = lambda fk, dirs: {"v": 1, "manifest": fm.manifest_key(fk), "dirs": dirs}  # noqa: E731
    return {"incidents": {GH_KEY: gh, AU_KEY: au}, "tiled": {}, "migrations": {"incident_ids": NOW},
            "incident_fires": {GH_FK: entry(GH_FK, [GH_KEY]), AU_FK: entry(AU_FK, [AU_KEY])}}


def _wire(monkeypatch, storage):
    monkeypatch.setattr(cli, "make_storage", lambda dry_run, out: storage)


def test_reassign_files_state_only_and_marks_rebuild(tmp_path, monkeypatch):
    storage = SpyStorage(tmp_path / "bucket")
    storage.put_json(STATE_KEY, _migrated())
    storage.written.clear()
    _wire(monkeypatch, storage)
    args = ["reassign-files", "--key", GH_KEY, "--rel", r"_Austin_0820\.pdf$",
            "--to", AUSTIN["cornea_id"].strip("{}").lower()]

    # report mode: the changes, nothing saved
    assert cli.main([*args, "--report-out", str(tmp_path / "r.json")]) == 0
    assert storage.written == []
    report = json.loads((tmp_path / "r.json").read_text())
    assert report["files"] == [{"rel": SHEETS[0], "before": GH_FK, "after": AU_FK},
                               {"rel": SHEETS[1], "before": None, "after": AU_FK}]

    assert cli.main([*args, "--apply"]) == 0
    assert storage.written == [STATE_KEY]  # state only
    state = storage.get_json(STATE_KEY)
    gh = state["incidents"][GH_KEY]
    for rel in SHEETS[:2]:
        assert (gh["files"][rel]["fk"], gh["files"][rel]["fk_src"]) == (AU_FK, "manual")
        assert gh["files"][rel]["prefix"] == "austin"  # where the bytes are is untouched
    assert "fk" not in gh["files"][SHEETS[2]]
    # both fires that gained or lost a file are rebuilt by the next mirror
    assert {fk: e["v"] for fk, e in state["incident_fires"].items()} == {GH_FK: 0, AU_FK: 0}
    fires = {GH_FK: GRASSHOPPER, AU_FK: AUSTIN}
    assert fm.stale_index_fks(state, fires) == {GH_FK, AU_FK}

    # back to the binding, and hidden (both sticky: 'manual' is evidence)
    storage.written.clear()
    assert cli.main(["reassign-files", "--key", GH_KEY, "--rel", "Ops_Austin", "--to",
                     "binding", "--apply"]) == 0
    assert cli.main(["reassign-files", "--key", GH_KEY, "--rel", "Grasshopper_1003", "--to",
                     "hidden", "--apply"]) == 0
    gh = storage.get_json(STATE_KEY)["incidents"][GH_KEY]
    assert "fk" not in gh["files"][SHEETS[0]] and file_owner(gh, gh["files"][SHEETS[0]]) == GH_FK
    assert (gh["files"][SHEETS[2]]["fk"], gh["files"][SHEETS[2]]["fk_src"]) == (None, "manual")
    assert storage.written == [STATE_KEY, STATE_KEY]


@pytest.mark.parametrize("to, rel, why", [
    ("austin", "Ops", "--to takes a fire GUID"),              # a slug is a name, not an ID
    ("{49D1FB0B-74D1-4A95-B8DF-066DCC5F06E1", "(", "not a regular expression"),
    ("hidden", "nothing-matches", "no file of"),
])
def test_reassign_files_refusals_write_nothing(tmp_path, monkeypatch, to, rel, why):
    storage = SpyStorage(tmp_path / "bucket")
    storage.put_json(STATE_KEY, _migrated())
    storage.written.clear()
    _wire(monkeypatch, storage)
    out = tmp_path / "r.json"
    assert cli.main(["reassign-files", "--key", GH_KEY, "--rel", rel, "--to", to, "--apply",
                     "--report-out", str(out)]) == 2
    assert storage.written == [] and why in json.loads(out.read_text())["error"]
    # before the migration file stamps mean nothing
    storage.put_json(STATE_KEY, dict(_migrated(), migrations={}))
    storage.written.clear()
    assert cli.main(["reassign-files", "--key", GH_KEY, "--rel", "Ops", "--to", "hidden",
                     "--apply"]) == 2
    assert storage.written == []


def test_restore_backup_refuses_migrated_backup(tmp_path, monkeypatch):
    storage = SpyStorage(tmp_path / "bucket")
    backup_key = "state/backups/state.pre-incident-ids.20261009T020000Z.json"
    pre = {"updated_at": "2026-10-08T17:00:02Z", "incidents": {GH_KEY: {"fire_slug": "grasshopper"}},
           "catalog_version": 844}
    migrated = dict(_migrated(), migrations={"incident_ids": NOW, "backup": backup_key})
    storage.put_json(STATE_KEY, migrated)
    storage.put_json(backup_key, dict(pre, migrations={"incident_ids": NOW}))  # not pre-migration
    storage.written.clear()
    _wire(monkeypatch, storage)

    assert cli.main(["restore-state-backup", "--apply"]) == 2
    assert storage.written == []
    assert storage.get_json(STATE_KEY)["migrations"]["incident_ids"] == NOW
    # report mode never restores
    assert cli.main(["restore-state-backup"]) == 2
    # a backup that does not parse is refused too
    (storage.out_dir / backup_key).write_text("{not json")
    assert cli.main(["restore-state-backup", "--apply"]) == 2
    assert storage.written == []

    storage.put_json(backup_key, pre)
    storage.written.clear()
    out = tmp_path / "r.json"
    assert cli.main(["restore-state-backup", "--apply", "--report-out", str(out)]) == 0
    assert storage.written == [STATE_KEY]
    assert storage.get_json(STATE_KEY) == pre
    assert json.loads(out.read_text())["restored"] is True


def test_maint_parsers_registered(tmp_path, monkeypatch):
    # the Phase 4 audit is a stub until then; prune reports only, deleting nothing
    assert cli.main(["audit-incident-keys", "--report"]) == 2
    storage = SpyStorage(tmp_path / "bucket")
    storage.put_json(STATE_KEY, _migrated())
    storage.written.clear()
    _wire(monkeypatch, storage)
    out = tmp_path / "r.json"
    assert cli.main(["prune", "--report", "--days", "14", "--confirm",
                     "--report-out", str(out)]) == 2
    assert storage.written == [] and json.loads(out.read_text())["deleted"] == []
