"""The incident-ID migration flag as the jobs see it: the fire-ID mirror
pauses until the migration has run (a fresh deployment starts migrated),
sync-catalogs switches from the slug-keyed records to the fire-ID index, and
keeps prune's inactivity clock by ID."""

import contextlib
import json
from types import SimpleNamespace

import pytest

from responder_worker import catalogs as cat, cli, fire_manifests, health
from responder_worker.b2 import DryRunStorage
from responder_worker.fires import fire_key
from responder_worker.state import STATE_KEY

FLAG = "2026-10-09T00:00:00Z"
GH = "{7A1B2C3D-0000-4000-8000-000000000001}"
WILDHORSE_ID = "{177292F2-0000-4000-8000-000000000003}"
GH_FK, WH_FK = fire_key(GH), fire_key(WILDHORSE_ID)
GH_KEY = "pacific_nw/2026/2026_Grasshopper"
SHEET = "products/20260817/Ops_ArchE_port_20260816_2155_Grasshopper_ORMHF000688_0817_Day.pdf"


class SpyStorage(DryRunStorage):
    """DryRunStorage that also records every read (writes: `.written`)."""

    def __init__(self, out_dir):
        super().__init__(out_dir)
        self.reads: list[str] = []

    def get_json(self, key):
        self.reads.append(key)
        return super().get_json(key)

    def get_file(self, key, dest):
        self.reads.append(key)
        return super().get_file(key, dest)


def _grasshopper_fire():
    return {"fire_slug": "grasshopper", "post_title": "GRASSHOPPER", "state": "OR",
            "cornea_id": GH, "unique_fire_id": "2026-ORMHF-000688", "active": True}


def _records():
    """Two pre-migration records sync-catalogs would repair: one whose
    counts heal from its published slug manifest, one whose manifest never
    published (dir_mtime cleared so the mirror republishes)."""
    return {
        GH_KEY: {"fire_slug": "grasshopper", "dir_mtime": "2026-10-08T15:00:00Z",
                 "synced_at": "2026-10-08T15:10:00Z",
                 "match": {"method": "unit_id", "confidence": 1.0,
                           "token": "2026-ORMHF-000688", "dir_url": "u/2026_Grasshopper/"},
                 "files": {SHEET: {"sha16": "5b0d93088c8ddb6c"}}},
        "pacific_nw/2026/2026_NeverPublished": {
            "fire_slug": "grasshopper-2", "dir_mtime": "2026-10-08T15:00:00Z",
            "match": {"method": "name_exact", "confidence": 0.95, "dir_url": "u/x/"},
            "files": {}},
    }


def _run_sync_catalogs(monkeypatch, storage, fires, *, raw_rows=None):
    """cmd_sync_catalogs with every network source stubbed out."""
    def fetch_active_fires(client, meta=None):
        if meta is not None:
            meta["raw_rows"] = len(fires) if raw_rows is None else raw_rows
        return [dict(f) for f in fires]

    monkeypatch.setattr(cli, "make_storage", lambda dry_run, out: storage)
    monkeypatch.setattr(cli, "make_client", lambda: contextlib.nullcontext(None))
    monkeypatch.setattr(cli, "fetch_active_fires", fetch_active_fires)
    monkeypatch.setattr(cli, "fetch_perimeter_count", lambda client, cid: None)
    monkeypatch.setattr(cli.archives, "sync",
                        lambda *a, **k: {"fires": {}, "unmatched_slugs": []})
    monkeypatch.setattr(cli.hotspots, "sync_fire", lambda *a, **k: False)
    monkeypatch.setattr(cli.hrrr, "discover_runs", lambda client: [])
    monkeypatch.setattr(cli.hrrr, "sync_weather", lambda *a, budget, **k: budget)
    monkeypatch.setattr(cli.pyrecast, "probe_gs01_national_layers", lambda client: None)
    monkeypatch.setattr(cli.frames, "sync_national_frame", lambda *a, **k: None)
    monkeypatch.setattr(cli.imsr, "build_imsr_catalog", lambda *a, **k: None)
    args = SimpleNamespace(dry_run=True, out=None, force=False, frames_fires=None,
                           frames_hours=None, frames_products=None)
    assert cli.cmd_sync_catalogs(args) == 0
    return storage.get_json("catalogs/catalog.json"), storage.get_json(STATE_KEY)


# ---------------------------------------------------------------------------
# the gate: the fire-ID mirror pauses until the migration has run
# ---------------------------------------------------------------------------

def _no_ftp(*a, **k):
    raise AssertionError("the paused mirror must not reach the network")


def _incidents_args(tmp_path, **kw):
    args = dict(dry_run=True, out=tmp_path, year=2026, fire=None, region=None,
                priority_fires="", zoom_cap=None, force=False, since=None,
                max_file_mb=None, max_pdfs=None, products_keep=3, ir_keep=2, tile_budget=0)
    args.update(kw)
    return SimpleNamespace(**args)


def _wire_sync(monkeypatch, storage, fires, *, roots=None):
    """cmd_sync_incidents against `storage`, with the given active fires
    and an FTP whose region roots list `roots` ({url: html}) and nothing
    else; GDAL and ogr2ogr absent, overrides empty."""
    monkeypatch.setattr(cli, "make_storage", lambda dry_run, out: storage)
    monkeypatch.setattr(cli, "make_client", lambda: contextlib.nullcontext(None))
    monkeypatch.setattr(cli, "fetch_active_fires",
                        lambda client, meta=None: [dict(f) for f in fires])
    monkeypatch.setattr(cli.config, "load_match_overrides", lambda: {})
    monkeypatch.setattr(cli, "get_optional",
                        lambda client, url: SimpleNamespace(text=(roots or {})[url])
                        if url in (roots or {}) else None)
    monkeypatch.setattr(cli, "list_dir", _no_ftp)
    monkeypatch.setattr(cli.geopdf, "gdal_available", lambda: False)
    monkeypatch.setattr(fire_manifests.shutil, "which", lambda _: None)


def test_sync_incidents_paused_publishes_failure_writes_nothing(tmp_path, monkeypatch):
    # Push B on state the migration has not re-keyed yet (the window between
    # push B and the apply): visible as a failure on /health, no other write.
    storage = SpyStorage(tmp_path / "out")
    state = {"incidents": _records(), "catalog_version": 845}
    storage.put_json(STATE_KEY, state)
    storage.put_json(health.KEY, health.merge_health(None, "mirror", {
        "finished_at": "2026-10-08T23:00:00Z", "ok": True, "note": None,
        "files_downloaded": 32}))
    state_before = (tmp_path / "out" / STATE_KEY).read_bytes()
    storage.written.clear()

    monkeypatch.setattr(cli, "make_storage", lambda dry_run, out: storage)
    monkeypatch.setattr(cli, "make_client", _no_ftp)
    monkeypatch.setattr(cli, "fetch_active_fires", _no_ftp)
    assert cli.cmd_sync_incidents(_incidents_args(tmp_path)) == 0

    # the heartbeat is the only write: no state, manifest or catalog
    assert storage.written == [health.KEY]
    assert (tmp_path / "out" / STATE_KEY).read_bytes() == state_before
    m = storage.get_json(health.KEY)["mirror"]
    assert m["ok"] is True and m["files_downloaded"] == 32  # last run kept
    assert m["last_failure"]["error"] == "paused_migration"
    assert m["last_failure"]["note"] == "paused: awaiting incident-ID migration (maint.yml)"
    assert storage.get_json(health.KEY)["history"][-1]["ok"] is False

    # the first run of a deployment seeds the section, ok=false
    storage = SpyStorage(tmp_path / "first")
    storage.put_json(STATE_KEY, {"incidents": _records()})
    monkeypatch.setattr(cli, "make_storage", lambda dry_run, out: storage)
    assert cli.cmd_sync_incidents(_incidents_args(tmp_path)) == 0
    m = storage.get_json(health.KEY)["mirror"]
    assert m["ok"] is False and m["files_downloaded"] == 0 and m["rebinds"] == []
    assert m["last_failure"]["error"] == "paused_migration"


@pytest.mark.parametrize("stored", [None, {"incidents": {}, "catalog_version": 3}])
def test_fresh_state_auto_migrated(tmp_path, monkeypatch, stored):
    # No state/state.json, or no folder mirrored yet: nothing is keyed by
    # slug, so the deployment starts keyed by fire ID instead of pausing.
    storage = SpyStorage(tmp_path / "out")
    if stored is not None:
        storage.put_json(STATE_KEY, stored)
    _wire_sync(monkeypatch, storage, [_grasshopper_fire()])
    monkeypatch.setattr(cat, "now_iso", lambda: FLAG)
    assert cli.cmd_sync_incidents(_incidents_args(tmp_path)) == 0

    state = storage.get_json(STATE_KEY)
    assert state["migrations"]["incident_ids"] == FLAG
    catalog = storage.get_json("catalogs/catalog.json")
    assert catalog["fires"][0]["has_incident_maps"] is False
    first = (stored or {}).get("catalog_version", 0) + 1
    assert catalog["version"] == state["catalog_version"] == first
    m = storage.get_json(health.KEY)["mirror"]
    assert m["ok"] is True and "last_failure" not in m and m["unresolved"] == []


def test_ir_backlog_fks_not_looked_up_as_incident_keys(tmp_path, monkeypatch):
    # A Grasshopper IR flight with no conversion stamped (no ir_keys): the IR
    # backlog owes Grasshopper a conversion and returns its FIRE key, which
    # must reach the manifest rebuild, not be looked up (or re-keyed) as an
    # incident record.
    storage = SpyStorage(tmp_path / "out")
    kmz = "ir/20260929/20260929_Grasshopper_IR.kmz"
    rec = {"fire_slug": "grasshopper", "storage_prefix": "grasshopper", "cornea_id": GH,
           "match": {"method": "unit_id", "confidence": 1.0, "token": "2026-ORMHF-000688",
                     "dir_url": "u/2026_Grasshopper/"},
           "dir_url": "u/2026_Grasshopper/", "dir_mtime": "2026-10-08 15:00",
           "synced_at": "2026-10-08T15:10:00Z", "children": {},
           "files": {kmz: {"sha16": "5b0d93088c8ddb6c", "kind": "ir", "size": 3}}}
    storage.put_json(STATE_KEY, {"incidents": {GH_KEY: rec}, "migrations": {"incident_ids": FLAG},
                                 "incident_fires": {}, "catalog_version": 846})
    _wire_sync(monkeypatch, storage, [_grasshopper_fire()])
    assert cli._ir_backlog(storage.get_json(STATE_KEY),
                           {GH_FK: _grasshopper_fire()}, lambda *_: None) == {GH_FK}
    assert cli.cmd_sync_incidents(_incidents_args(tmp_path)) == 0

    state = storage.get_json(STATE_KEY)
    assert list(state["incidents"]) == [GH_KEY]
    assert state["incidents"][GH_KEY]["dir_mtime"] == "2026-10-08 15:00"  # not cleared
    man = storage.get_json(f"catalogs/incidents/id/{GH_FK}.json")
    assert man["ir_flights"][0]["kmz_url"] == f"/raw/incidents/grasshopper/{kmz}"
    assert state["incident_fires"][GH_FK]["dirs"] == [GH_KEY]
    assert storage.get_json(health.KEY)["mirror"]["rebuilt_fires"] == [GH_FK]


def _root(*names, mtime="2026-10-08 15:00"):
    return "<table>" + "".join(
        f'<tr><td><a href="{n}/">{n}/</a></td><td align="right">{mtime}</td>'
        f'<td align="right">-</td></tr>' for n in names) + "</table>"


def test_fire_arg_guid_collects_bound_dirs(tmp_path, monkeypatch):
    # --fire by fire key: Austin's folders are those named like it (the old
    # rule) AND 2026_Grasshopper, which lends Austin stamped sheets under
    # another name; never an unrelated folder.
    from responder_worker.config import FTP_BASE

    au = {"fire_slug": "austin", "post_title": "AUSTIN", "state": "OR",
          "cornea_id": "{49D1FB0B-74D1-4A95-B8DF-066DCC5F06E1}",
          "unique_fire_id": "2026-ORMHF-000863"}
    au_fk = fire_key(au["cornea_id"])
    state = {"incidents": {
        GH_KEY: {"fire_slug": "grasshopper", "storage_prefix": "grasshopper", "cornea_id": GH,
                 "match": {"method": "unit_id"},
                 "files": {SHEET: {"sha16": "aa", "fk": au_fk, "fk_src": "token"}}},
        "pacific_nw/2026/2026_Austin": {
            "fire_slug": "austin", "storage_prefix": "austin", "cornea_id": au["cornea_id"],
            "match": {"method": "unit_id"}, "files": {}}},
        "incident_fires": {}, "migrations": {"incident_ids": FLAG}}
    oregon = f"{FTP_BASE}/pacific_nw/2026_Incidents_Oregon/"
    roots = {oregon: _root("2026_Grasshopper", "2026_Austin", "2026_Elk", "2026_AustinCreek")}
    monkeypatch.setattr(cli, "get_optional", lambda client, url: (
        SimpleNamespace(text=roots[url]) if url in roots else None))
    fires = [_grasshopper_fire(), au]
    args = _incidents_args(tmp_path)
    for spelling in (au["cornea_id"], au_fk, au_fk.upper(), "austin"):
        target = cli._resolve_fire_arg(spelling, fires)
        assert target is au, spelling
        got = cli._collect_candidates(None, args, fires, target=target, state=state)
        assert sorted(c.key for c in got) == [
            "pacific_nw/2026/2026_Austin", "pacific_nw/2026/2026_AustinCreek", GH_KEY]
    # the index's folders count too (a folder whose stamps were since cleared)
    del state["incidents"][GH_KEY]["files"][SHEET]["fk"]
    got = cli._collect_candidates(None, args, fires, target=au, state=state)
    assert GH_KEY not in {c.key for c in got}
    state["incident_fires"][au_fk] = {"dirs": [GH_KEY, "pacific_nw/2026/2026_Austin"]}
    got = cli._collect_candidates(None, args, fires, target=au, state=state)
    assert GH_KEY in {c.key for c in got}
    # no fire to resolve: nothing collected, nothing written
    assert cli._resolve_fire_arg("{00000000-0000-4000-8000-000000000000}", fires) is None
    storage = SpyStorage(tmp_path / "out")
    storage.put_json(STATE_KEY, state)
    storage.written.clear()
    _wire_sync(monkeypatch, storage, fires)
    assert cli.cmd_sync_incidents(_incidents_args(tmp_path, fire="no-such-fire")) == 2
    assert storage.written == []


# ---------------------------------------------------------------------------
# sync-catalogs: slug-keyed records before the migration, the index after
# ---------------------------------------------------------------------------

def test_sync_catalogs_legacy_before_and_no_manifest_io_after(tmp_path, monkeypatch):
    # Before: the incident block runs as it always has. It reads the slug
    # manifest to heal counts and clears the mtime of a folder whose
    # manifest never published.
    storage = SpyStorage(tmp_path / "before")
    storage.put_json(STATE_KEY, {"incidents": _records(), "catalog_version": 844})
    storage.put_json("catalogs/incidents/grasshopper.json", {
        "maps": [{"op_date": "2026-08-17", "uploaded_at": "2026-08-17T05:00:00Z"}],
        "ir_flights": []})
    catalog, state = _run_sync_catalogs(monkeypatch, storage, [_grasshopper_fire()])

    assert "catalogs/incidents/grasshopper.json" in storage.reads
    assert state["incidents"][GH_KEY]["map_count"] == 1
    assert state["incidents"]["pacific_nw/2026/2026_NeverPublished"]["dir_mtime"] is None
    row = catalog["fires"][0]
    assert row["incident_manifest"] == "/catalogs/incidents/grasshopper.json"
    assert row["incident_map_count"] == 1
    assert catalog["counts"]["matched_incident_dirs"] == 1

    # After: the fire-ID index alone; no manifest read or written, and no
    # record repaired (the mirror owns the records now).
    storage = SpyStorage(tmp_path / "after")
    records = _records()
    for rec in records.values():
        rec["cornea_id"] = GH
    index = {GH_FK: {"v": 1, "cornea_id": GH, "manifest": f"catalogs/incidents/id/{GH_FK}.json",
                     "dirs": [GH_KEY], "primary": GH_KEY, "method": "unit_id",
                     "confidence": 1.0, "dir_url": "u/2026_Grasshopper/",
                     "synced_at": "2026-10-08T15:10:00Z", "built_at": "2026-10-08T15:12:00Z",
                     "counts": {"maps": 35, "ir": 2, "latest_upload": "2026-10-07",
                                "latest_upload_ts": "2026-10-07T21:00:00Z"}}}
    storage.put_json(STATE_KEY, {"incidents": records, "incident_fires": index,
                                 "migrations": {"incident_ids": FLAG},
                                 "catalog_version": 846})
    storage.put_json("catalogs/incidents/grasshopper.json", {"maps": [], "ir_flights": []})
    storage.written.clear()
    catalog, state = _run_sync_catalogs(monkeypatch, storage, [_grasshopper_fire()])

    assert not [k for k in storage.reads if k.startswith("catalogs/incidents/")]
    assert not [k for k in storage.written if k.startswith("catalogs/incidents/")]
    assert state["incidents"] == json.loads(json.dumps(records))
    row = catalog["fires"][0]
    assert row["incident_manifest"] == f"/catalogs/incidents/id/{GH_FK}.json"
    assert row["incident_map_count"] == 35
    assert catalog["counts"]["matched_incident_dirs"] == 1
    assert catalog["version"] == 847


# ---------------------------------------------------------------------------
# prune's inactivity clock, kept hourly by sync-catalogs
# ---------------------------------------------------------------------------

def _migrated_state():
    return {
        "incidents": {
            GH_KEY: {"fire_slug": "grasshopper", "storage_prefix": "grasshopper",
                     "cornea_id": GH, "match": {"method": "unit_id"},
                     "files": {SHEET: {"sha16": "aa"}}},
            "great_basin/2026/2026_Wildhorse": {
                "fire_slug": "wildhorse", "storage_prefix": "wildhorse",
                "cornea_id": WILDHORSE_ID, "match": {"method": "name_exact"},
                "files": {"products/w.pdf": {"sha16": "bb"}}},
            "great_basin/2026/2026_Cherry": {   # unresolved: feeds no fire
                "fire_slug": "cherry", "storage_prefix": "cherry", "cornea_id": None,
                "match": None, "id_unresolved": {"reason": "date"},
                "files": {"products/c.pdf": {"sha16": "cc"}}},
        },
        "migrations": {"incident_ids": FLAG},
        "prune": {"inactive_since": {"wildhorse": "2026-09-01T00:00:00Z"}},
    }


def test_prune_clock_kept_by_sync_catalogs(tmp_path, monkeypatch):
    storage = SpyStorage(tmp_path / "out")
    storage.put_json(STATE_KEY, _migrated_state())
    monkeypatch.setattr(cli.state_mod, "now_iso", lambda: "2026-10-09T01:00:00Z")
    _catalog, state = _run_sync_catalogs(monkeypatch, storage, [_grasshopper_fire()])

    clock = state["prune"]
    assert clock["last_seen_active"] == {GH_FK: "2026-10-09T01:00:00Z"}
    # Wildhorse ID's folder feeds an inactive fire: its clock starts now
    assert clock["inactive_since_by_id"] == {WH_FK: "2026-10-09T01:00:00Z"}
    assert clock["inactive_since"] == {"wildhorse": "2026-09-01T00:00:00Z"}  # legacy, untouched


def test_prune_clock_starts_once_and_clears_on_return(monkeypatch):
    state = _migrated_state()
    fires_meta = {"raw_rows": 300}
    gh = _grasshopper_fire()
    wh = {"fire_slug": "wildhorse", "cornea_id": WILDHORSE_ID}
    stamps = iter(["2026-10-09T01:00:00Z", "2026-10-09T02:00:00Z", "2026-10-09T03:00:00Z"])
    monkeypatch.setattr(cli.state_mod, "now_iso", lambda: next(stamps))

    cli._tick_prune_clock(state, [gh], fires_meta, None)
    cli._tick_prune_clock(state, [gh], fires_meta, None)
    # the first absence is kept, not reset every hour
    assert state["prune"]["inactive_since_by_id"] == {WH_FK: "2026-10-09T01:00:00Z"}
    assert state["prune"]["last_seen_active"][GH_FK] == "2026-10-09T02:00:00Z"
    cli._tick_prune_clock(state, [gh, wh], fires_meta, None)
    assert state["prune"]["inactive_since_by_id"] == {}
    assert state["prune"]["last_seen_active"][WH_FK] == "2026-10-09T03:00:00Z"


@pytest.mark.parametrize("raw_rows, prev_active", [
    (500, None),    # a full API page may be truncated
    (300, 262),     # one fire where the last catalog had 262
])
def test_prune_clock_skipped_on_suspect_fire_list(raw_rows, prev_active):
    state = _migrated_state()
    prev = {"counts": {"active_fires": prev_active}} if prev_active else None
    cli._tick_prune_clock(state, [_grasshopper_fire()], {"raw_rows": raw_rows}, prev)
    assert "inactive_since_by_id" not in state["prune"]
    assert "last_seen_active" not in state["prune"]


def test_fire_list_suspect_thresholds():
    from responder_worker.fires import fire_list_suspect

    assert fire_list_suspect(499, 262, 262) is None
    assert fire_list_suspect(500, 262, 262).startswith("API returned 500 rows")
    assert fire_list_suspect(400, 210, 262) is None          # 80.2%
    assert "under 80%" in fire_list_suspect(400, 209, 262)  # 79.8%
    assert fire_list_suspect(10, 3, None) is None             # no previous catalog
    assert fire_list_suspect(10, 3, 0) is None


def test_index_path_never_used_before_flag():
    # An index left in state without the flag (e.g. a rolled-back
    # migration) must not be advertised.
    state = {"incident_fires": {GH_FK: {"manifest": "catalogs/incidents/id/x.json"}}}
    assert cat.catalog_incident_index(state) is None


def test_prune_never_deletes_a_slug_prefix(tmp_path, monkeypatch):
    # The slug-prefix prune deleted raw/incidents/{slug}/ wholesale; on
    # migrated state that prefix can hold another fire's stamped files. The
    # fire-ID prune refuses until the key audit has run, before any API call.
    storage = SpyStorage(tmp_path / "out")
    storage.put_json(STATE_KEY, _migrated_state())
    storage.put_bytes(f"raw/incidents/wildhorse/{SHEET}", b"%PDF")
    storage.written.clear()
    monkeypatch.setattr(cli, "make_storage", lambda dry_run, out: storage)
    monkeypatch.setattr(cli, "make_client", _no_ftp)
    args = SimpleNamespace(dry_run=True, out=None, days=14, confirm=True)
    assert cli.cmd_prune(args) == 2
    assert storage.written == []
    assert storage.exists(f"raw/incidents/wildhorse/{SHEET}")
