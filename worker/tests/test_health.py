"""Heartbeat merging: completed runs replace their section; outages are
recorded without losing the last good run."""
from types import SimpleNamespace

from responder_worker import health
from responder_worker.cli import _ftp_outage_entry, _zero_mirror_entry


def _success(finished="2026-09-06T05:51:37Z"):
    return {
        "started_at": "2026-09-06T05:31:25Z", "finished_at": finished,
        "ok": True, "note": None, "candidates": 285, "files_downloaded": 32,
        "failed_incidents": [], "deadline_hit": False,
    }


def test_failure_keeps_last_success_and_records_outage():
    doc = health.merge_health(None, "mirror", _success())
    doc = health.merge_failure(doc, "mirror", {
        "started_at": "2026-09-06T13:08:11Z", "finished_at": "2026-09-06T13:11:41Z",
        "note": "FTP unreachable (ftp.wildfire.gov): ConnectTimeout: timed out",
        "error": "ftp_unreachable",
    })
    m = doc["mirror"]
    # The heartbeat still answers "how stale?" from the last completed run…
    assert m["ok"] is True
    assert m["finished_at"] == "2026-09-06T05:51:37Z"
    assert m["files_downloaded"] == 32
    # …and carries the outage.
    assert m["last_failure"]["error"] == "ftp_unreachable"
    assert m["last_failure"]["finished_at"] == "2026-09-06T13:11:41Z"
    assert "ConnectTimeout" in m["last_failure"]["note"]
    # History gets an ok=false row stamped at the failure time.
    assert doc["history"][-1] == {
        "job": "mirror", "at": "2026-09-06T13:11:41Z", "ok": False,
        "note": m["last_failure"]["note"],
    }


def test_success_after_failure_clears_last_failure():
    doc = health.merge_health(None, "mirror", _success())
    doc = health.merge_failure(doc, "mirror", {
        "started_at": "x", "finished_at": "2026-09-06T13:11:41Z",
        "note": "FTP unreachable", "error": "ftp_unreachable",
    })
    doc = health.merge_health(doc, "mirror", _success("2026-09-07T01:30:00Z"))
    assert "last_failure" not in doc["mirror"]
    assert doc["mirror"]["finished_at"] == "2026-09-07T01:30:00Z"
    assert [h["ok"] for h in doc["history"]] == [True, False, True]


def test_first_ever_failure_seeds_a_zeroed_section():
    doc = health.merge_failure(None, "mirror", {
        "started_at": "2026-09-06T13:08:11Z", "finished_at": "2026-09-06T13:11:41Z",
        "note": "FTP unreachable", "error": "ftp_unreachable",
    }, defaults={"candidates": 0, "files_downloaded": 0, "failed_incidents": []})
    m = doc["mirror"]
    assert m["ok"] is False
    assert m["candidates"] == 0 and m["failed_incidents"] == []
    assert m["finished_at"] == "2026-09-06T13:11:41Z"
    assert m["last_failure"]["error"] == "ftp_unreachable"


def test_failure_leaves_other_sections_alone():
    doc = health.merge_health(None, "catalogs", {"finished_at": "t1", "ok": True})
    doc = health.merge_failure(doc, "mirror", {"finished_at": "t2", "note": "down"})
    assert doc["catalogs"] == {"finished_at": "t1", "ok": True}
    assert doc["history"][-1]["job"] == "mirror"


def test_history_is_capped():
    doc = None
    for i in range(health.HISTORY_MAX + 5):
        doc = health.merge_failure(doc, "mirror", {"finished_at": f"t{i}", "note": "down"})
    assert len(doc["history"]) == health.HISTORY_MAX


def test_ftp_outage_entry_names_host_and_cause():
    import httpx
    entry = _ftp_outage_entry("2026-09-06T13:08:11Z", httpx.ConnectTimeout("timed out"))
    assert entry["error"] == "ftp_unreachable"
    assert entry["started_at"] == "2026-09-06T13:08:11Z"
    assert entry["note"] == "FTP unreachable (ftp.wildfire.gov): ConnectTimeout: timed out"
    zero = _zero_mirror_entry()
    assert zero["files_downloaded"] == 0 and zero["failed_incidents"] == []


def test_sync_incidents_records_ftp_outage_and_fails(tmp_path, monkeypatch):
    """End to end through cmd_sync_incidents: an unreachable FTP publishes a
    mirror failure record (keeping the previous heartbeat) and exits 1."""
    import httpx
    from responder_worker import cli
    from responder_worker.b2 import DryRunStorage

    storage = DryRunStorage(tmp_path)
    storage.put_json(health.KEY, health.merge_health(None, "mirror", _success()))

    monkeypatch.setattr(cli, "make_storage", lambda dry_run, out: storage)
    monkeypatch.setattr(cli.state_mod, "load_state", lambda s: {"incidents": {}})
    monkeypatch.setattr(cli.config, "load_match_overrides", lambda: {})
    monkeypatch.setattr(cli, "fetch_active_fires", lambda client: [])
    monkeypatch.setattr(cli, "_probe_backlog", lambda *a, **k: set())
    monkeypatch.setattr(cli, "_tile_backlog", lambda *a, **k: set())
    monkeypatch.setattr(cli, "_ir_backlog", lambda *a, **k: set())

    def boom(client, args, fires, **kw):
        raise httpx.ConnectTimeout("timed out")
    monkeypatch.setattr(cli, "_collect_candidates", boom)

    args = SimpleNamespace(dry_run=True, out=tmp_path, year=2026, fire=None,
                           region=None, priority_fires="", zoom_cap=None)
    assert cli.cmd_sync_incidents(args) == 1

    doc = storage.get_json(health.KEY)
    m = doc["mirror"]
    assert m["ok"] is True and m["files_downloaded"] == 32  # last success kept
    assert m["last_failure"]["error"] == "ftp_unreachable"
    assert m["last_failure"]["note"].startswith("FTP unreachable (ftp.wildfire.gov): ConnectTimeout")
    assert doc["history"][-1]["ok"] is False


def test_sync_incidents_other_crashes_still_propagate(tmp_path, monkeypatch):
    """Only transport errors are the outage path; anything else still raises
    (a crashed run writes nothing, as before)."""
    from responder_worker import cli
    from responder_worker.b2 import DryRunStorage
    import pytest

    storage = DryRunStorage(tmp_path)
    monkeypatch.setattr(cli, "make_storage", lambda dry_run, out: storage)
    monkeypatch.setattr(cli.state_mod, "load_state", lambda s: {"incidents": {}})
    monkeypatch.setattr(cli.config, "load_match_overrides", lambda: {})
    monkeypatch.setattr(cli, "fetch_active_fires", lambda client: [])
    for name in ("_probe_backlog", "_tile_backlog", "_ir_backlog"):
        monkeypatch.setattr(cli, name, lambda *a, **k: set())

    def boom(client, args, fires, **kw):
        raise ValueError("parser bug")
    monkeypatch.setattr(cli, "_collect_candidates", boom)
    args = SimpleNamespace(dry_run=True, out=tmp_path, year=2026, fire=None,
                           region=None, priority_fires="", zoom_cap=None)
    with pytest.raises(ValueError):
        cli.cmd_sync_incidents(args)
    assert storage.get_json(health.KEY) is None
