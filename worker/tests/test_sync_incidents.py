"""sync-incidents by fire ID, whole runs against a stub FTP and a dry-run
bucket: the first run after the migration reproduces the migration's
manifests and catalog rows, a folder re-bound to another fire splits its
files by their names, overrides are fire GUIDs (anything else leaves the
folder alone), a name never re-binds a folder bound by ID, and two folders
claiming one incident key never share a record."""

import json

from ftp_stub import BASE, FakeFTP
from incident_world import (
    AU_FK, AU_KEY, AUSTIN, CHERRY_KEY, GH_FK, GH_KEY, GRASSHOPPER, LATEST, World, freeze_clock,
    sha16, wire_cli,
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
    for key in (GH_KEY, AU_KEY):
        ftp.dir(ORE, key.rpartition("/")[2], "2026-10-02 19:15")
    ftp.dir(WASH, "2026_TwinSisters", "2026-10-02 19:15")
    ftp.dir(f"{BASE}/n_rockies/2026/", "2026_TwinSisters", "2026-10-02 19:15")
    ftp.dir(f"{BASE}/great_basin/2026/", "2026_Cherry", "2026-10-02 19:15")
    ftp.wire(monkeypatch)
    _no_tools(monkeypatch)

    def sync():
        world.storage.written.clear()
        assert cli.main(["sync-incidents"]) == 0
        return world.storage.get_json(health.KEY)["mirror"], world.state_on_bucket()

    m, state = sync()
    # nothing listed or downloaded, nothing re-keyed or re-stamped
    assert [r for r in ftp.requests if r[0] != "root"] == []
    assert (m["candidates"], m["unchanged_skips"], m["files_downloaded"]) == (5, 5, 0)
    assert m["unresolved"] == [CHERRY_KEY]
    assert m["rebinds"] == m["rebind_refused"] == m["override_errors"] == []
    assert m["key_collisions"] == m["raw_sha_mismatch"] == []
    for section in ("incidents", "tiled", "ir", "incident_fires", "migrations"):
        assert state[section] == migrated[section], section
    # the manifests and catalog rows are the migration's, byte for byte
    # (a fire still owed an IR conversion is rebuilt, and with no converter
    # this run it comes out the same)
    assert _id_manifests(world.storage) == step_e
    assert set(m["rebuilt_fires"]) <= set(migrated["incident_fires"])
    assert [k for k in world.storage.written if k.startswith("catalogs/incidents/")] == [
        fire_manifests.manifest_key(fk) for fk in m["rebuilt_fires"]]
    catalog = world.storage.get_json("catalogs/catalog.json")
    assert catalog["version"] == state["catalog_version"] == LATEST + 2
    assert json.dumps(catalog["fires"]) == json.dumps(rows)
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
    assert state["incident_fires"] == migrated["incident_fires"]
    assert state["incidents"] == migrated["incidents"]
    assert json.dumps(world.storage.get_json("catalogs/catalog.json")["fires"]) == \
        json.dumps(rows)


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


def _bucket(tmp_path, monkeypatch, rec: dict, *, overrides=None, fires=None):
    """A migrated bucket holding one record (its fire's manifest built),
    and cli wired to it with no tools."""
    world = World(tmp_path)  # only for its spy bucket and active-fire list
    world.fires = fires or _fires()
    storage = world.storage
    state = {"schema_version": 1, "incidents": {GH_KEY: rec}, "tiled": {}, "ir": {},
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

