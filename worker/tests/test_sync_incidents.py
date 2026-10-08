"""sync-incidents by fire ID, whole runs against a stub FTP and a dry-run
bucket: the first run after the migration reproduces the migration's
manifests and catalog rows, an unchanged folder of an active fire is
re-listed under its binding (no re-match) and rebuilds its fires only when
something came in, a folder re-bound to another fire splits its files by
their names, overrides are fire GUIDs (anything else leaves the folder
alone), a name never re-binds a folder bound by ID, and two folders
claiming one incident key never share a record."""

import hashlib
import json

import pytest

from ftp_stub import BASE, FakeFTP
from incident_world import (
    AU_FK, AU_KEY, AUSTIN, CHERRY_ID, CHERRY_KEY, GH_FK, GH_KEY, GRASSHOPPER, LATEST, MT_FK,
    MT_KEY, NOW, TWIN_MT, TWIN_WA, WA_FK, WA_KEY, World, freeze_clock, sha16, wire_cli,
)
from responder_worker import cli, fire_manifests, geopdf, health
from responder_worker.fires import fire_key
from responder_worker.incident_ids import bound_info
from responder_worker.state import STATE_KEY

ORE = f"{BASE}/pacific_nw/2026_Incidents_Oregon/"
WASH = f"{BASE}/pacific_nw/2026_Incidents_Washington/"
GH_DIR = f"{ORE}2026_Grasshopper/"
FLAG = "2026-10-09T00:00:00Z"


def _no_tools(monkeypatch, overrides=None):
    """No GDAL (no tiling, previews or probes) and no ogr2ogr (no IR
    conversion), so a run's only work is mirroring and manifests."""
    monkeypatch.setattr(geopdf, "gdal_available", lambda: False)
    monkeypatch.setattr(fire_manifests.shutil, "which", lambda _: None)
    monkeypatch.setattr(cli.config, "load_match_overrides", lambda: dict(overrides or {}))


def _id_manifests(storage) -> dict[str, bytes]:
    return {k: (storage.out_dir / k).read_bytes()
            for k, _ in storage.list_keys("catalogs/incidents/id/")}


# ---------------------------------------------------------------------------
# the first sync after the migration
# ---------------------------------------------------------------------------

def test_first_sync_after_migration_reproduces_step_e(tmp_path, monkeypatch):
    freeze_clock(monkeypatch)
    world = World(tmp_path).publish()
    wire_cli(monkeypatch, world)
    report = str(tmp_path / "report.json")
    assert cli.main(["migrate-incident-ids", "--report-out", report]) == 0
    assert cli.main(["migrate-incident-ids", "--apply", "--expect", report]) == 0
    migrated = world.state_on_bucket()
    step_e = _id_manifests(world.storage)
    assert sorted(step_e) == sorted(fire_manifests.manifest_key(fk)
                                    for fk in migrated["incident_fires"])
    rows = world.storage.get_json("catalogs/catalog.json")["fires"]

    # the FTP: every folder as it was at its last sync
    ftp = FakeFTP()
    bound_dirs = [ftp.dir(ORE, key.rpartition("/")[2], "2026-10-02 19:15")
                  for key in (GH_KEY, AU_KEY)]
    bound_dirs.append(ftp.dir(WASH, "2026_TwinSisters", "2026-10-02 19:15"))
    bound_dirs.append(ftp.dir(f"{BASE}/n_rockies/2026/", "2026_TwinSisters", "2026-10-02 19:15"))
    ftp.dir(f"{BASE}/great_basin/2026/", "2026_Cherry", "2026-10-02 19:15")
    ftp.wire(monkeypatch)
    _no_tools(monkeypatch)

    def sync():
        world.storage.written.clear()
        ftp.requests.clear()
        assert cli.main(["sync-incidents"]) == 0
        return world.storage.get_json(health.KEY)["mirror"], world.state_on_bucket()

    def resynced(incidents: dict) -> dict:
        # a refresh stamps when a bound folder was last looked at
        return {k: dict(r, synced_at=NOW) if k != CHERRY_KEY else r
                for k, r in incidents.items()}

    m, state = sync()
    # Each folder bound to an active fire is listed at its root (spec 3.9)
    # and found nothing new: nothing else listed or downloaded, nothing
    # re-matched, re-keyed or re-stamped. The unresolved one is not listed.
    assert sorted(r for r in ftp.requests if r[0] != "root") == sorted(
        ("list", u) for u in bound_dirs)
    assert (m["candidates"], m["unchanged_skips"], m["files_downloaded"]) == (5, 5, 0)
    assert m["refreshed"] == 0
    assert m["unresolved"] == [CHERRY_KEY]
    assert m["rebinds"] == m["rebind_refused"] == m["override_errors"] == []
    assert m["key_collisions"] == m["raw_sha_mismatch"] == []
    for section in ("tiled", "ir", "migrations"):
        assert state[section] == migrated[section], section
    assert state["incidents"] == resynced(migrated["incidents"])
    # the manifests and catalog rows are the migration's, byte for byte
    # (a fire still owed an IR conversion is rebuilt, and with no converter
    # this run it comes out the same, its folders' sync time aside)
    assert _id_manifests(world.storage) == step_e
    rebuilt = set(m["rebuilt_fires"])
    assert rebuilt <= set(migrated["incident_fires"])
    assert [k for k in world.storage.written if k.startswith("catalogs/incidents/")] == [
        fire_manifests.manifest_key(fk) for fk in m["rebuilt_fires"]]
    assert state["incident_fires"] == {fk: dict(e, synced_at=NOW) if fk in rebuilt else e
                                       for fk, e in migrated["incident_fires"].items()}
    catalog = world.storage.get_json("catalogs/catalog.json")
    assert catalog["version"] == state["catalog_version"] == LATEST + 2
    assert json.dumps(catalog["fires"]) == json.dumps([
        dict(r, incident_last_synced=NOW) if fire_key(r["cornea_id"]) in rebuilt else r
        for r in rows])
    assert not [k for k in world.storage.written
                if k.startswith(("raw/", "tiles/", "previews/", "vectors/"))]
    assert world.storage.written[-3:] == [f"catalogs/versions/catalog.{LATEST + 2}.json",
                                          "catalogs/catalog.json", health.KEY]

    # Every index entry stale (as reassign-files leaves them): the mirror
    # rebuilds every fire, with the same code as step E, to the same bytes.
    stale = world.state_on_bucket()
    for e in stale["incident_fires"].values():
        e["v"] = 0
    world.storage.put_json(STATE_KEY, stale)
    m, state = sync()
    assert sorted(m["rebuilt_fires"]) == sorted(migrated["incident_fires"])
    assert sorted(k for k in world.storage.written if k.startswith("catalogs/incidents/")) == \
        sorted(step_e)
    assert _id_manifests(world.storage) == step_e
    assert state["incident_fires"] == {fk: dict(e, synced_at=NOW)
                                       for fk, e in migrated["incident_fires"].items()}
    assert state["incidents"] == resynced(migrated["incidents"])
    assert json.dumps(world.storage.get_json("catalogs/catalog.json")["fires"]) == \
        json.dumps([dict(r, incident_last_synced=NOW) if r["has_incident_maps"] else r
                    for r in rows])


# ---------------------------------------------------------------------------
# one folder, whole runs
# ---------------------------------------------------------------------------

AU_0817 = "products/20260817/Ops_ArchE_port_20260816_2155_Austin_ORMHF000863_0817_Day.pdf"
GH_0925 = "products/20260925/Ops_ArchE_Land_20260924_2037_Grasshopper_ORMHF000688_0925_Day.pdf"
PLAIN = "products/20260820/Transport_0820.pdf"
GH_1008 = "Ops_ArchE_Land_20261007_2037_Grasshopper_ORMHF000688_1008_Day.pdf"


def _fires():
    return [dict(GRASSHOPPER, fire_slug="grasshopper", active=True),
            dict(AUSTIN, fire_slug="austin", active=True)]


def _gh_on_austin() -> dict:
    """2026_Grasshopper bound to Austin by unit token (as it was until
    v787): Austin's sheet, Grasshopper's sheet and one naming neither."""
    files = {}
    for rel in (AU_0817, GH_0925, PLAIN):
        data = f"%PDF {rel}".encode()
        files[rel] = {"etag": '"e"', "lm": "Thu, 01 Oct 2026 05:05:56 GMT", "size": len(data),
                      "sha16": sha16(data), "rev": 1, "kind": "product", "url": f"{GH_DIR}{rel}"}
    return {"fire_slug": "austin-gh", "storage_prefix": "austin-gh",
            "cornea_id": AUSTIN["cornea_id"], "bound": bound_info(AUSTIN, "unit_id"),
            "match": {"method": "unit_id", "confidence": 1.0, "token": AUSTIN["unique_fire_id"],
                      "dir_url": GH_DIR, "cornea_id": AUSTIN["cornea_id"]},
            "dir_url": GH_DIR, "region": "pacific_nw_oregon", "dir_mtime": "2026-10-02 19:15",
            "synced_at": "2026-10-02T19:20:00Z", "children": {}, "files": files}


def _gh_on_grasshopper() -> dict:
    """2026_Grasshopper after that rebind: bound to Grasshopper by token and
    lending Austin its sheet (Austin's token)."""
    rec = _gh_on_austin()
    rec.update(cornea_id=GRASSHOPPER["cornea_id"], bound=bound_info(GRASSHOPPER, "unit_id"),
               match={"method": "unit_id", "confidence": 1.0,
                      "token": GRASSHOPPER["unique_fire_id"], "dir_url": GH_DIR,
                      "cornea_id": GRASSHOPPER["cornea_id"]})
    rec["files"][AU_0817].update(fk=AU_FK, fk_src="token")
    return rec


def _bucket(tmp_path, monkeypatch, rec: dict, *, overrides=None, fires=None, others=None,
            key=GH_KEY):
    """A migrated bucket holding one record at `key` (plus `others`, by
    key), its fires' manifests built, and cli wired to it with no tools."""
    world = World(tmp_path)  # only for its spy bucket and active-fire list
    world.fires = fires or _fires()
    storage = world.storage
    state = {"schema_version": 1, "incidents": {key: rec, **(others or {})}, "tiled": {},
             "ir": {},
             "incident_fires": {}, "migrations": {"incident_ids": FLAG}, "catalog_version": 50}
    fires_by_fk = {fire_key(f["cornea_id"]): f for f in world.fires}
    fire_manifests.publish_fire_manifests(None, storage, state, fires_by_fk, set(fires_by_fk),
                                          {}, replay_only=True, log=lambda *_: None)
    storage.put_json(STATE_KEY, state)
    storage.written.clear()
    wire_cli(monkeypatch, world)
    _no_tools(monkeypatch, overrides)
    return world


def _gh_folder(mtime="2026-10-08 05:00") -> FakeFTP:
    """The 2026_Grasshopper folder after Grasshopper's team took it over:
    a new daily folder of Grasshopper sheets (token ORMHF000688)."""
    ftp = FakeFTP()
    ftp.dir(ORE, "2026_Grasshopper", mtime)
    products = ftp.dir(GH_DIR, "Products", mtime)
    day = ftp.dir(products, "20261008", mtime)
    ftp.file(day, GH_1008, b"%PDF grasshopper 1008")
    return ftp


def test_rebind_splits_files_by_name_and_rebuilds_both_fires(tmp_path, monkeypatch):
    world = _bucket(tmp_path, monkeypatch, _gh_on_austin())
    assert world.storage.exists(fire_manifests.manifest_key(AU_FK))
    ftp = _gh_folder().wire(monkeypatch)
    assert cli.main(["sync-incidents"]) == 0

    state = world.state_on_bucket()
    rec = state["incidents"][GH_KEY]
    assert rec["cornea_id"] == GRASSHOPPER["cornea_id"] and rec["match"]["method"] == "unit_id"
    assert rec["bound"] == bound_info(GRASSHOPPER, "unit_id")
    assert [e["cornea_id"] for e in rec["rebound_from"]] == [AUSTIN["cornea_id"]]
    # Austin's sheet (its token) and the unproven one (the old binding was
    # by ID) stay with Austin; Grasshopper's sheets follow the folder
    assert {r: (m.get("fk"), m.get("fk_src")) for r, m in rec["files"].items()} == {
        AU_0817: (AU_FK, "token"), PLAIN: (AU_FK, "prior"), GH_0925: (None, None),
        f"products/20261008/{GH_1008}": (None, None)}
    # the new sheet lands under the record's own prefix, never re-keyed
    assert (rec["fire_slug"], rec["storage_prefix"]) == ("austin-gh", "austin-gh")
    assert ftp.gets() == [f"{GH_DIR}Products/20261008/{GH_1008}"]
    assert world.storage.exists(f"raw/incidents/austin-gh/products/20261008/{GH_1008}")

    gh = world.storage.get_json(fire_manifests.manifest_key(GH_FK))
    au = world.storage.get_json(fire_manifests.manifest_key(AU_FK))
    assert sorted(m["filename"] for m in gh["maps"]) == sorted(
        [GH_1008, GH_0925.rpartition("/")[2]])
    assert sorted(m["filename"] for m in au["maps"]) == sorted(
        [AU_0817.rpartition("/")[2], PLAIN.rpartition("/")[2]])
    assert gh["cornea_id"] == GRASSHOPPER["cornea_id"] and au["cornea_id"] == AUSTIN["cornea_id"]
    assert au["sources"][0]["method"] is None  # the folder only lends Austin files now
    m = world.storage.get_json(health.KEY)["mirror"]
    assert m["rebinds"] == [{"key": GH_KEY, "decision": "rebind", "from": AU_FK, "to": GH_FK,
                             "method": "unit_id"}]
    assert sorted(m["rebuilt_fires"]) == sorted([AU_FK, GH_FK])
    rows = {r["fire_slug"]: r for r in world.storage.get_json("catalogs/catalog.json")["fires"]}
    assert rows["grasshopper"]["incident_map_count"] == 2
    assert rows["austin"]["incident_map_count"] == 2


def _filenames(storage, fk) -> set[str]:
    return {x["filename"] for x in storage.get_json(fire_manifests.manifest_key(fk))["maps"]}


def test_rematched_folder_rebuilds_the_fires_its_files_left(tmp_path, monkeypatch):
    # 2026_Grasshopper, bound to Grasshopper, lends Austin its token sheet
    # and a QR sheet placed there by the old ID binding ('prior'). The QR
    # sheet is overwritten in place: its new bytes follow the binding. Austin
    # still gets the token sheet, so its index entry names the same folder
    # and only the run itself can know Austin lost a file.
    qr = "qr/Transport_QR.pdf"
    rec = _gh_on_grasshopper()
    rec["files"][qr] = dict(rec["files"][PLAIN], kind="qr", url=f"{GH_DIR}QR/Transport_QR.pdf",
                            sha16=sha16(b"%PDF qr rev 1"), fk=AU_FK, fk_src="prior")
    world = _bucket(tmp_path, monkeypatch, rec)
    assert _filenames(world.storage, AU_FK) == {AU_0817.rpartition("/")[2], "Transport_QR.pdf"}
    ftp = _gh_folder()                                     # root changed: a re-match
    ftp.file(ftp.dir(GH_DIR, "QR"), "Transport_QR.pdf", b"%PDF qr rev 2")
    ftp.wire(monkeypatch)
    assert cli.main(["sync-incidents"]) == 0

    m = world.storage.get_json(health.KEY)["mirror"]
    assert m["rebinds"] == [] and m["files_downloaded"] == 2
    meta = world.state_on_bucket()["incidents"][GH_KEY]["files"][qr]
    assert "fk" not in meta and meta["sha16"] == sha16(b"%PDF qr rev 2")
    assert sorted(m["rebuilt_fires"]) == sorted([AU_FK, GH_FK])
    assert _filenames(world.storage, AU_FK) == {AU_0817.rpartition("/")[2]}
    assert "Transport_QR.pdf" in _filenames(world.storage, GH_FK)

    # An override clears a placement naming a third fire (Twin Sisters MT),
    # which keeps a sheet an operator assigned it: its manifest drops the
    # placed one.
    twin = "products/20260805/ops_twin_sisters_0805.pdf"
    rec = _gh_on_austin()
    rec["files"][PLAIN].update(fk=MT_FK, fk_src="location")
    rec["files"][twin] = dict(rec["files"][PLAIN], sha16=sha16(b"%PDF twin"), fk=MT_FK,
                              fk_src="manual")
    world = _bucket(tmp_path / "override", monkeypatch, rec,
                    overrides={GH_KEY: GRASSHOPPER["cornea_id"]},
                    fires=_fires() + [dict(TWIN_MT, fire_slug="twin-sisters", active=True)])
    assert _filenames(world.storage, MT_FK) == {"Transport_0820.pdf", "ops_twin_sisters_0805.pdf"}
    _gh_folder(mtime="2026-10-02 19:15").wire(monkeypatch)   # root unchanged
    assert cli.main(["sync-incidents"]) == 0

    m = world.storage.get_json(health.KEY)["mirror"]
    assert [(e["decision"], e["to"]) for e in m["rebinds"]] == [("rebind", GH_FK)]
    # (Austin has no files left: its index entry goes, no manifest to build)
    assert sorted(m["rebuilt_fires"]) == sorted([GH_FK, MT_FK])
    assert AU_FK not in world.state_on_bucket()["incident_fires"]
    assert _filenames(world.storage, MT_FK) == {"ops_twin_sisters_0805.pdf"}
    assert "Transport_0820.pdf" in _filenames(world.storage, GH_FK)


def test_rebuilds_owed_when_a_run_dies_before_publishing(tmp_path, monkeypatch):
    # The rebind is checkpointed with the download, then the run dies
    # before any manifest is written. The next run finds the folder
    # unchanged, so only the index can say Austin is owed a rebuild.
    world = _bucket(tmp_path, monkeypatch, _gh_on_austin())
    assert GH_0925.rpartition("/")[2] in _filenames(world.storage, AU_FK)
    _gh_folder().wire(monkeypatch)
    publish = fire_manifests.publish_fire_manifests

    def killed(*a, **kw):
        raise RuntimeError("job killed")
    monkeypatch.setattr(fire_manifests, "publish_fire_manifests", killed)
    with pytest.raises(RuntimeError):
        cli.main(["sync-incidents"])
    state = world.state_on_bucket()
    assert state["incidents"][GH_KEY]["cornea_id"] == GRASSHOPPER["cornea_id"]
    assert state["incident_fires"][AU_FK]["v"] == 0

    monkeypatch.setattr(fire_manifests, "publish_fire_manifests", publish)
    assert cli.main(["sync-incidents"]) == 0
    m = world.storage.get_json(health.KEY)["mirror"]
    assert (m["unchanged_skips"], m["files_downloaded"]) == (1, 0)
    assert sorted(m["rebuilt_fires"]) == sorted([AU_FK, GH_FK])
    assert _filenames(world.storage, AU_FK) == {AU_0817.rpartition("/")[2],
                                                PLAIN.rpartition("/")[2]}
    assert world.state_on_bucket()["incident_fires"][AU_FK]["v"] == 1


def test_unchanged_folder_with_new_child_is_refreshed(tmp_path, monkeypatch):
    # 2026_Grasshopper, bound to Grasshopper and lending Austin its sheet:
    # a new daily folder under Products/ leaves the folder's own mtime
    # alone. The run re-lists it under its binding (no re-match), takes the
    # new sheet and rebuilds the fires it shows files on, and no other. The
    # Twin Sisters folder found nothing new and is neither listed below its
    # root nor rebuilt.
    gh = _gh_on_austin()
    gh.update(cornea_id=GRASSHOPPER["cornea_id"], bound=bound_info(GRASSHOPPER, "unit_id"),
              match={"method": "unit_id", "confidence": 1.0,
                     "token": GRASSHOPPER["unique_fire_id"], "dir_url": GH_DIR,
                     "cornea_id": GRASSHOPPER["cornea_id"]},
              children={"Products": "2026-10-02 19:15"})
    gh["files"][AU_0817].update(fk=AU_FK, fk_src="token")
    mt_dir = f"{BASE}/n_rockies/2026/2026_TwinSisters/"
    mt_sheet = "products/20260805/ops_twin_sisters_0805.pdf"
    mt = {"fire_slug": "twin-sisters", "storage_prefix": "twin-sisters",
          "cornea_id": TWIN_MT["cornea_id"], "bound": bound_info(TWIN_MT, "unit_id"),
          "match": {"method": "unit_id", "confidence": 1.0, "token": TWIN_MT["unique_fire_id"],
                    "dir_url": mt_dir, "cornea_id": TWIN_MT["cornea_id"]},
          "dir_url": mt_dir, "dir_mtime": "2026-10-02 19:15",
          "synced_at": "2026-10-02T19:20:00Z", "children": {"Products": "2026-10-02 19:15"},
          "files": {mt_sheet: {"etag": '"e"', "lm": "Wed, 05 Aug 2026 05:00:00 GMT",
                               "size": 9, "sha16": sha16(b"%PDF twin"), "rev": 1,
                               "kind": "product", "url": f"{mt_dir}{mt_sheet}"}}}
    world = _bucket(tmp_path, monkeypatch, gh, others={MT_KEY: mt},
                    fires=_fires() + [dict(TWIN_MT, fire_slug="twin-sisters", active=True)])
    mt_before = world.storage.get_json(fire_manifests.manifest_key(MT_FK))

    def no_match(*a, **kw):
        raise AssertionError("an unchanged bound folder is never re-matched")
    monkeypatch.setattr(cli, "_gather_unit_tokens", no_match)
    monkeypatch.setattr(cli, "match_candidate", no_match)

    ftp = FakeFTP()
    ftp.dir(ORE, "2026_Grasshopper", "2026-10-02 19:15")            # root unchanged
    products = ftp.dir(GH_DIR, "Products", "2026-10-08 05:00")       # ... one level down not
    day = ftp.dir(products, "20261008", "2026-10-08 05:00")
    ftp.file(day, GH_1008, b"%PDF grasshopper 1008")
    ftp.dir(f"{BASE}/n_rockies/2026/", "2026_TwinSisters", "2026-10-02 19:15")
    ftp.dir(mt_dir, "Products", "2026-10-02 19:15")
    ftp.wire(monkeypatch)
    assert cli.main(["sync-incidents"]) == 0

    assert sorted(r[:2] for r in ftp.requests if r[0] != "root") == sorted([
        ("list", GH_DIR), ("list", products), ("list", day), ("get", f"{day}{GH_1008}"),
        ("list", mt_dir)])
    m = world.storage.get_json(health.KEY)["mirror"]
    assert (m["refreshed"], m["unchanged_skips"], m["files_downloaded"]) == (1, 1, 1)
    assert m["rebinds"] == m["rebind_refused"] == []
    assert sorted(m["rebuilt_fires"]) == sorted([AU_FK, GH_FK])
    assert sorted(k for k in world.storage.written if k.startswith("catalogs/incidents/")) == \
        sorted(fire_manifests.manifest_key(fk) for fk in (AU_FK, GH_FK))
    assert world.storage.get_json(fire_manifests.manifest_key(MT_FK)) == mt_before

    state = world.state_on_bucket()
    rec = state["incidents"][GH_KEY]
    assert (rec["cornea_id"], rec["match"], rec["bound"]) == (
        gh["cornea_id"], gh["match"], gh["bound"])
    assert rec["dir_mtime"] == "2026-10-02 19:15"
    assert rec["children"] == {"Products": "2026-10-08 05:00"}
    new_rel = f"products/20261008/{GH_1008}"
    assert "fk" not in rec["files"][new_rel]  # follows the binding
    assert world.storage.exists(f"raw/incidents/austin-gh/{new_rel}")
    assert state["incidents"][MT_KEY]["children"] == mt["children"]
    gh_man = world.storage.get_json(fire_manifests.manifest_key(GH_FK))
    au_man = world.storage.get_json(fire_manifests.manifest_key(AU_FK))
    assert GH_1008 in {x["filename"] for x in gh_man["maps"]}
    assert {x["filename"] for x in au_man["maps"]} == {AU_0817.rpartition("/")[2]}

    # the next run finds the folder unchanged at every level: root
    # listings only, nothing rebuilt
    ftp.requests.clear()
    world.storage.written.clear()
    assert cli.main(["sync-incidents"]) == 0
    assert sorted(r for r in ftp.requests if r[0] != "root") == sorted(
        [("list", GH_DIR), ("list", mt_dir)])
    m = world.storage.get_json(health.KEY)["mirror"]
    assert (m["refreshed"], m["unchanged_skips"], m["rebuilt_fires"]) == (0, 2, [])
    assert not [k for k in world.storage.written if k.startswith("catalogs/incidents/")]


def test_live_build_lists_sheets_as_step_e(tmp_path, monkeypatch):
    # A folder whose dated dirs sit at its root and whose daily sheet is
    # also published loose (products/current), the same bytes. After the
    # migration its dated dir has no child stamp, so the first sync lists
    # it again (in FTP order: the daily dir, then the loose file) and
    # rebuilds the fire. The manifest must keep the copy and order the
    # migration's build (state order) kept.
    def sheet(rel: str, data: bytes) -> dict:
        etag = '"' + hashlib.sha256(data).hexdigest()[:12] + '"'  # FakeFTP's: a 304
        return {"etag": etag, "lm": "Thu, 08 Oct 2026 05:00:00 GMT", "size": len(data),
                "sha16": sha16(data), "rev": 1, "kind": "product", "url": f"{GH_DIR}{rel}",
                "first_seen": "2026-10-08T05:10:00Z"}

    x, y = b"%PDF ops", b"%PDF transport"
    rec = _gh_on_grasshopper()
    rec["files"] = {"products/current/Ops_1008.pdf": sheet("Ops_1008.pdf", x),
                    "products/20261008/Transport_1008.pdf": sheet("20261008/Transport_1008.pdf", y),
                    "products/20261008/Ops_1008.pdf": sheet("20261008/Ops_1008.pdf", x)}
    world = _bucket(tmp_path, monkeypatch, rec)
    step_e = world.storage.get_json(fire_manifests.manifest_key(GH_FK))["maps"]
    assert [e["pdf_url"].rpartition("/products/")[2] for e in step_e] == [
        "current/Ops_1008.pdf", "20261008/Transport_1008.pdf"]

    ftp = FakeFTP()
    ftp.dir(ORE, "2026_Grasshopper", "2026-10-02 19:15")       # root unchanged
    day = ftp.dir(GH_DIR, "20261008", "2026-10-08 05:00")
    ftp.file(day, "Ops_1008.pdf", x)
    ftp.file(day, "Transport_1008.pdf", y)
    ftp.file(GH_DIR, "Ops_1008.pdf", x)
    ftp.wire(monkeypatch)
    assert cli.main(["sync-incidents"]) == 0

    m = world.storage.get_json(health.KEY)["mirror"]
    assert (m["refreshed"], m["files_downloaded"]) == (1, 0)
    assert GH_FK in m["rebuilt_fires"]
    assert world.storage.get_json(fire_manifests.manifest_key(GH_FK))["maps"] == step_e


def test_keeper_of_a_split_prefix_never_overwrites_moved_bytes(tmp_path, monkeypatch):
    # The twin-sisters split: Montana's folder kept the prefix, Washington's
    # moved to one of its own and its files stayed stamped under
    # twin-sisters/. Montana now publishes a QR sheet at the path where
    # Washington's QR sheet sits. The new revision is held back and
    # reported, every run, and Washington's bytes and manifest are intact.
    mt_dir = f"{BASE}/n_rockies/2026/2026_TwinSisters/"
    wa_dir = f"{BASE}/pacific_nw/2026_Incidents_Washington/2026_TwinSisters/"
    qr, wa_qr = "qr/Twin_Sisters_QR.pdf", b"%PDF washington's qr"
    key = f"raw/incidents/twin-sisters/{qr}"

    def rec(fire, method, prefix, dir_url, files):
        return {"fire_slug": prefix, "storage_prefix": prefix, "cornea_id": fire["cornea_id"],
                "bound": bound_info(fire, method),
                "match": {"method": method, "confidence": 1.0, "dir_url": dir_url,
                          "token": fire["unique_fire_id"] if method == "unit_id" else None,
                          "cornea_id": fire["cornea_id"]},
                "dir_url": dir_url, "dir_mtime": "2026-10-02 19:15",
                "synced_at": "2026-10-02T19:20:00Z", "children": {}, "files": files}

    wa = rec(TWIN_WA, "name_exact", WA_FK, wa_dir, {qr: {
        "etag": '"e"', "lm": "Wed, 17 Jun 2026 04:59:39 GMT", "size": len(wa_qr),
        "sha16": sha16(wa_qr), "rev": 1, "kind": "qr", "url": f"{wa_dir}QR/Twin_Sisters_QR.pdf",
        "prefix": "twin-sisters"}})
    world = _bucket(tmp_path, monkeypatch, rec(TWIN_MT, "unit_id", "twin-sisters", mt_dir, {}),
                    key=MT_KEY, others={WA_KEY: wa},
                    fires=[dict(TWIN_MT, fire_slug="twin-sisters", active=True),
                           dict(TWIN_WA, fire_slug="twin-sisters-wa", active=True)])
    world.storage.put_bytes(key, wa_qr)
    wa_manifest = world.storage.get_json(fire_manifests.manifest_key(WA_FK))
    ftp = FakeFTP()
    ftp.dir(f"{BASE}/n_rockies/2026/", "2026_TwinSisters", "2026-10-02 19:15")
    day = ftp.dir(ftp.dir(mt_dir, "Products", "2026-10-08 05:00"), "20261008", "2026-10-08 05:00")
    ftp.file(day, "ops_twin_1008.pdf", b"%PDF montana ops")
    ftp.file(ftp.dir(mt_dir, "QR", "2026-10-08 05:00"), "Twin_Sisters_QR.pdf", b"%PDF montana qr")
    ftp.wire(monkeypatch)

    for run in range(2):
        world.storage.written.clear()
        assert cli.main(["sync-incidents"]) == 0
        m = world.storage.get_json(health.KEY)["mirror"]
        assert m["raw_key_collisions"] == [key] and "held back" in m["note"]
        assert world.storage.get_file(key, tmp_path / "qr.pdf")
        assert (tmp_path / "qr.pdf").read_bytes() == wa_qr
        assert key not in world.storage.written
        state = world.state_on_bucket()
        assert qr not in state["incidents"][MT_KEY]["files"]
        assert state["incidents"][WA_KEY] == wa
        # QR is listed again next run; Products, done, replays
        assert state["incidents"][MT_KEY]["children"] == {"Products": "2026-10-08 05:00"}
        assert m["files_downloaded"] == (1 if run == 0 else 0)
        assert world.storage.get_json(fire_manifests.manifest_key(WA_FK))["maps"] == \
            wa_manifest["maps"]


def test_override_must_be_a_fire_guid(tmp_path, monkeypatch):
    # a slug: reported, the folder left exactly as it was, nothing listed
    world = _bucket(tmp_path, monkeypatch, _gh_on_austin(), overrides={GH_KEY: "grasshopper"})
    before = world.state_on_bucket()["incidents"]
    ftp = _gh_folder().wire(monkeypatch)
    assert cli.main(["sync-incidents"]) == 0
    assert world.state_on_bucket()["incidents"] == before
    assert [r for r in ftp.requests if r[0] != "root"] == []
    m = world.storage.get_json(health.KEY)["mirror"]
    assert [(e["key"], e["error"]) for e in m["override_errors"]] == [(GH_KEY, "error")]
    assert "invalid override" in m["note"]

    # a GUID (any spelling): an override re-binds, keeping only the stamps
    # files earn by their names
    guid = GRASSHOPPER["cornea_id"].strip("{}").lower()
    world = _bucket(tmp_path / "guid", monkeypatch, _gh_on_austin(), overrides={GH_KEY: guid})
    _gh_folder().wire(monkeypatch)
    assert cli.main(["sync-incidents"]) == 0
    rec = world.state_on_bucket()["incidents"][GH_KEY]
    assert rec["match"]["method"] == "override" and rec["override"] == GRASSHOPPER["cornea_id"]
    assert rec["files"][AU_0817].get("fk") is None  # no evidence stamps before: all follow
    assert rec["files"][PLAIN].get("fk") is None

    # 'ignore': the folder feeds nothing and Austin loses its index entry
    world = _bucket(tmp_path / "ignore", monkeypatch, _gh_on_austin(),
                    overrides={GH_KEY: "ignore"})
    _gh_folder().wire(monkeypatch)
    assert cli.main(["sync-incidents"]) == 0
    state = world.state_on_bucket()
    rec = state["incidents"][GH_KEY]
    assert (rec["ignored"], rec["match"], rec["override"]) == (True, None, "ignore")
    assert rec["cornea_id"] == AUSTIN["cornea_id"]  # kept: un-ignoring restores it
    assert state["incident_fires"] == {}
    rows = {r["fire_slug"]: r for r in world.storage.get_json("catalogs/catalog.json")["fires"]}
    assert rows["austin"]["has_incident_maps"] is False


def test_name_match_never_rebinds_an_id_bound_folder(tmp_path, monkeypatch):
    # 2026_Grasshopper bound to Austin by token; its new sheets carry no
    # token and the folder's name matches Grasshopper: refused, mirrored
    # under Austin's binding.
    world = _bucket(tmp_path, monkeypatch, _gh_on_austin())
    ftp = FakeFTP()
    ftp.dir(ORE, "2026_Grasshopper", "2026-10-08 05:00")
    day = ftp.dir(ftp.dir(GH_DIR, "Products"), "20261008")
    ftp.file(day, "Ops_Grasshopper_1008.pdf", b"%PDF no token")
    ftp.wire(monkeypatch)
    assert cli.main(["sync-incidents"]) == 0

    rec = world.state_on_bucket()["incidents"][GH_KEY]
    assert rec["cornea_id"] == AUSTIN["cornea_id"] and rec["match"]["method"] == "unit_id"
    assert "rebound_from" not in rec
    assert "products/20261008/Ops_Grasshopper_1008.pdf" in rec["files"]
    m = world.storage.get_json(health.KEY)["mirror"]
    assert [(e["key"], e["method"]) for e in m["rebind_refused"]] == [(GH_KEY, "name_exact")]
    au = world.storage.get_json(fire_manifests.manifest_key(AU_FK))
    assert "Ops_Grasshopper_1008.pdf" in {x["filename"] for x in au["maps"]}
    assert not world.storage.exists(fire_manifests.manifest_key(GH_FK))


def test_name_rematch_to_its_own_fire_keeps_the_id_binding(tmp_path, monkeypatch):
    # 2026_Grasshopper bound to Grasshopper by token; its newest daily
    # carries no token, so the folder matches its own fire by name. The
    # binding stays an ID binding: the same match, evidence and catalog row.
    rec = _gh_on_grasshopper()
    world = _bucket(tmp_path, monkeypatch, rec)
    ftp = FakeFTP()
    ftp.dir(ORE, "2026_Grasshopper", "2026-10-08 05:00")
    day = ftp.dir(ftp.dir(GH_DIR, "Products"), "20261008")
    ftp.file(day, "Ops_Grasshopper_1008.pdf", b"%PDF no token")
    ftp.wire(monkeypatch)
    assert cli.main(["sync-incidents"]) == 0

    after = world.state_on_bucket()["incidents"][GH_KEY]
    assert (after["match"], after["bound"]) == (rec["match"], rec["bound"])
    m = world.storage.get_json(health.KEY)["mirror"]
    assert m["rebinds"] == m["rebind_refused"] == []
    assert "Ops_Grasshopper_1008.pdf" in _filenames(world.storage, GH_FK)
    rows = {r["fire_slug"]: r for r in world.storage.get_json("catalogs/catalog.json")["fires"]}
    assert (rows["grasshopper"]["ftp_match"]["method"],
            rows["grasshopper"]["ftp_match"]["confidence"]) == ("unit_id", 1.0)


def test_folder_detached_by_date_is_not_bound_again_by_name(tmp_path, monkeypatch):
    # 2026_Cherry, name-bound to a Cherry created weeks after the folder's
    # last sheet. A newer notes file passes the matcher's date check (any
    # file it lists), so the folder name-matches Cherry again; its own maps
    # still predate the fire. Detached, it stays detached: no bind hiding
    # its sheet, no rebind, run after run.
    cherry_dir = f"{BASE}/great_basin/2026/2026_Cherry/"
    sheet = "products/20260705/ops_Cherry_0705.pdf"
    data = b"%PDF cherry 0705"
    rec = {"fire_slug": "cherry", "storage_prefix": "cherry", "cornea_id": CHERRY_ID["cornea_id"],
           "bound": bound_info(CHERRY_ID, "name_exact"),
           "match": {"method": "name_exact", "confidence": 0.95, "token": None,
                     "dir_url": cherry_dir, "cornea_id": CHERRY_ID["cornea_id"]},
           "dir_url": cherry_dir, "region": "great_basin", "dir_mtime": "2026-10-05 05:00",
           "synced_at": "2026-10-05T05:10:00Z", "children": {"Products": "2026-10-05 05:00"},
           "files": {sheet: {"etag": '"e"', "lm": "Sun, 05 Jul 2026 15:42:24 GMT",
                             "size": len(data), "sha16": sha16(data), "rev": 1,
                             "kind": "product", "url": f"{cherry_dir}{sheet}"}}}
    world = _bucket(tmp_path, monkeypatch, rec, key=CHERRY_KEY,
                    fires=[dict(CHERRY_ID, fire_slug="cherry", active=True)])
    ftp = FakeFTP()
    ftp.dir(f"{BASE}/great_basin/2026/", "2026_Cherry", "2026-10-05 05:00")
    products = ftp.dir(cherry_dir, "Products", "2026-10-05 05:00")
    ftp.file(ftp.dir(products, "20260705", "2026-07-05 15:42"), "ops_Cherry_0705.pdf", data,
             mtime="2026-07-05 15:42")
    ftp.file(products, "notes.txt", b"radio plan", mtime="2026-10-05 05:00")
    ftp.wire(monkeypatch)

    for _run in range(2):
        assert cli.main(["sync-incidents"]) == 0
        m = world.storage.get_json(health.KEY)["mirror"]
        assert m["date_rejected"] == [CHERRY_KEY]
        assert m["rebinds"] == [] and m["files_downloaded"] == 0
        after = world.state_on_bucket()["incidents"][CHERRY_KEY]
        assert after["match"] is None
        assert fire_key(after["match_rejected"]["cornea_id"]) == fire_key(CHERRY_ID["cornea_id"])
        assert after["files"][sheet] == rec["files"][sheet]  # not stamped hidden
        assert world.state_on_bucket()["incident_fires"] == {}


def test_new_folder_gets_its_own_prefix(tmp_path, monkeypatch):
    world = _bucket(tmp_path, monkeypatch, _gh_on_austin())
    # a Grasshopper folder seen for the first time, matched by its token
    ftp = FakeFTP()
    ftp.dir(ORE, "2026_Grasshopper", "2026-10-02 19:15")   # unchanged
    new_dir = ftp.dir(ORE, "2026_GrasshopperComplex", "2026-10-08 05:00")
    ftp.file(ftp.dir(ftp.dir(new_dir, "Products"), "20261008"), GH_1008, b"%PDF complex")
    ftp.wire(monkeypatch)
    assert cli.main(["sync-incidents"]) == 0

    key = "pacific_nw/2026/2026_GrasshopperComplex"
    rec = world.state_on_bucket()["incidents"][key]
    assert rec["fire_slug"] == rec["storage_prefix"] == GH_FK
    assert rec["region"] == "pacific_nw_oregon" and rec["match"]["cornea_id"] == \
        GRASSHOPPER["cornea_id"]
    assert world.storage.exists(f"raw/incidents/{GH_FK}/products/20261008/{GH_1008}")
    man = world.storage.get_json(fire_manifests.manifest_key(GH_FK))
    assert [x["pdf_url"] for x in man["maps"]] == [
        f"/raw/incidents/{GH_FK}/products/20261008/{GH_1008}"]
    assert world.state_on_bucket()["incident_fires"][GH_FK]["dirs"] == [key]


def test_key_collision_one_folder_per_record(tmp_path, monkeypatch):
    # The state subfolders fold into their GACC's key: Texas's and
    # Florida's Ross_2026 are both southern/2026/Ross_2026.
    world = _bucket(tmp_path, monkeypatch, _gh_on_austin())
    ftp = FakeFTP()
    ftp.dir(ORE, "2026_Grasshopper", "2026-10-02 19:15")
    texas = ftp.dir(ftp.dir(f"{BASE}/southern/", "Texas"), "2026")
    ftp.dir(texas, "Ross_2026")
    ftp.dir(ftp.dir(f"{BASE}/southern/2026/", "Florida"), "Ross_2026")
    ftp.wire(monkeypatch)
    assert cli.main(["sync-incidents"]) == 0
    m = world.storage.get_json(health.KEY)["mirror"]
    assert m["key_collisions"] == [{
        "key": "southern/2026/Ross_2026", "kept": f"{texas}Ross_2026/",
        "dropped": f"{BASE}/southern/2026/Florida/Ross_2026/"}]
    assert m["candidates"] == 2  # Grasshopper's folder and one Ross
    assert "southern/2026/Ross_2026" not in world.state_on_bucket()["incidents"]

    # the folder a record was mirrored from keeps the key, wherever it lists
    florida = f"{BASE}/southern/2026/Florida/Ross_2026/"
    texas_c, florida_c = (cli.IncidentCandidate(region=r, year=2026, dir_name="Ross_2026",
                                                dir_url=u)
                          for r, u in (("southern_texas", f"{texas}Ross_2026/"),
                                       ("southern_florida", florida)))
    state = {"incidents": {"southern/2026/Ross_2026": {"dir_url": florida}}}
    kept, collisions = cli._drop_key_collisions([texas_c, florida_c, florida_c], state)
    assert kept == [florida_c]
    assert collisions == [{"key": "southern/2026/Ross_2026", "kept": florida,
                           "dropped": f"{texas}Ross_2026/"}]

