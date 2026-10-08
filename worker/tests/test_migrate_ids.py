"""The incident-ID migration: resolving each folder's fire from the catalog
history, splitting shared prefixes, locating bytes by listing and hash,
attributing files under foreign prefixes, legacy IR stamps, and the
report/apply contract (never flushed in report mode; apply needs the
expected report, aborts on guards before writing, backs up state first,
writes only its own keys and deletes nothing). Fixtures: incident_world."""

import hashlib
import json
from collections import Counter

import pytest

from incident_world import (
    AU_FK, AU_KEY, AU_SHEET, AUSTIN, BOBCAT_LAKES, CHERRY_ID, CHERRY_KEY, GH_AT_AUSTIN, GH_FK,
    GH_KEY, GH_OWN, GH_SHEET, GRASSHOPPER, IR_AUSTIN_0817, IR_GH_0929, LATEST, MT_KEY, NOW,
    SAND_CREEK, TWIN_MT, TWIN_WA, WA_FK, WA_KEY, World, api_fire, at, default_rows, dir_of,
    freeze_clock, row, sha16, wire_cli,
)
from responder_worker import asset_locate, cli, health, ir_vectors, migrate_ids, state as state_mod
from responder_worker.asset_keys import raw_key
from responder_worker.b2 import DryRunStorage
from responder_worker.fires import fire_key
from responder_worker.incident_ids import file_owner
from responder_worker.state import STATE_KEY


def _migration(world: World) -> migrate_ids.Migration:
    world.publish()
    return migrate_ids.Migration(
        world.storage, state_mod.load_state(world.storage), world.fetch_fires(),
        prev_catalog=world.storage.get_json("catalogs/catalog.json"), now=NOW,
        log=lambda *_: None)


def _through_locate(mig):
    mig.resolve_records()
    mig.split_prefixes()
    mig.hist.sample()
    mig.locate()
    return mig


def _stamps(rec, rels=None):
    files = rec["files"] if rels is None else {r: rec["files"][r] for r in rels}
    return Counter((m.get("fk", "unstamped"), m.get("fk_src")) for m in files.values())


# ---------------------------------------------------------------------------
# step A: each folder's fire from the catalog history
# ---------------------------------------------------------------------------

def test_resolves_first_version_at_or_after_sync(tmp_path):
    # The slug 'austin' showed Austin until v25 and GRASSHOPPER from v26 (a
    # slug swap): a folder synced just before v26 was published under v26.
    def rows(n):
        out = default_rows(n)
        if n >= 26:
            out = [r for r in out if r["fire_slug"] not in ("austin", "grasshopper")]
            out += [row(GRASSHOPPER, "austin", AU_KEY), row(AUSTIN, "austin-or")]
        return out

    world = World(tmp_path, rows=rows, holes={26})
    world.state["incidents"][AU_KEY]["synced_at"] = at(25, 30)
    world.state["incidents"][AU_KEY]["match"]["token"] = GRASSHOPPER["unique_fire_id"]
    mig = _migration(world)
    mig.resolve_records()

    rec = mig.state["incidents"][AU_KEY]
    # v26 is a hole: the first version at or after the sync is v27
    assert rec["cornea_id"] == GRASSHOPPER["cornea_id"]
    assert rec["bound"] == {"uid": "2026-ORMHF-000688", "name": "grasshopper", "method": "unit_id"}
    assert mig.rows[AU_KEY]["fire_slug"] == "austin"
    assert mig.report["records"]["gaps"] == [{"key": AU_KEY, "version": 27, "minutes": 90.0}]
    # a sync exactly at a version's generated_at resolves to that version
    assert mig.hist.first_at_or_after(at(15)) == 15
    assert mig.hist.first_at_or_after(at(15, 1)) == 16
    assert mig.hist.first_at_or_after(at(LATEST, 1)) is None
    assert mig.hist.first_at_or_after(at(25, 59)) == 27


def test_name_record_needs_b_or_c(tmp_path):
    # WA Twin Sisters (a name match): v10 maps twin-sisters to WA and so
    # did v9 (a), but no row names its folder (b) and no manifest does (c)
    def rows(n):
        out = default_rows(n)
        for r in out:
            if r["fire_slug"] == "twin-sisters" and n <= 12:
                r["ftp_match"]["dir_url"] = dir_of("pacific_nw/2026/2026_SomewhereElse")
        return out

    world = World(tmp_path, rows=rows)
    mig = _migration(world)
    mig.resolve_records()
    wa = mig.state["incidents"][WA_KEY]
    assert wa["cornea_id"] is None and wa["match"] is None
    assert wa["id_unresolved"]["reason"] == "uncorroborated in v10"
    assert wa["id_unresolved"]["candidate"] == TWIN_WA["cornea_id"]
    assert wa["id_unresolved"]["prior_match"]["method"] == "name_exact"

    # the slug manifest naming WA and its folder corroborates it (c)
    world = World(tmp_path / "c", rows=rows)
    world.manifests["twin-sisters"] = world.legacy_manifest(TWIN_WA, WA_KEY, "twin-sisters")
    mig = _migration(world)
    mig.resolve_records()
    assert mig.state["incidents"][WA_KEY]["cornea_id"] == TWIN_WA["cornea_id"]

    # a unit_id folder needs only one check: MT with (a) alone resolves
    def rows_a(n):
        out = default_rows(n)
        for r in out:
            if r["fire_slug"] == "twin-sisters" and n > 12:
                r["ftp_match"]["dir_url"] = dir_of("n_rockies/2026/2026_SomewhereElse")
        return out

    world = World(tmp_path / "a", rows=rows_a)
    del world.manifests["twin-sisters"]
    mig = _migration(world)
    mig.resolve_records()
    assert mig.state["incidents"][MT_KEY]["cornea_id"] == TWIN_MT["cornea_id"]


def test_unit_token_mismatch_is_unresolved(tmp_path):
    world = World(tmp_path)
    world.state["incidents"][AU_KEY]["match"]["token"] = "2026-ORMHF-000855"  # The Narrows
    mig = _migration(world)
    mig.resolve_records()
    au = mig.state["incidents"][AU_KEY]
    assert au["cornea_id"] is None and au["match"] is None
    assert au["id_unresolved"]["reason"] == (
        "unit token 2026-ORMHF-000855 is not v28's unique_fire_id 2026-ORMHF-000863")
    assert au["id_unresolved"]["prior_match"]["token"] == "2026-ORMHF-000855"


def test_name_match_predating_fire_unresolved(tmp_path):
    world = World(tmp_path)
    # SageCreek's only file is a GISS template; its listing dates it
    sage_key = "pacific_nw/2026/2026_SageCreek"
    sage = {"cornea_id": "{0F0F0F0F-0000-4000-8000-00000000005A}", "post_title": "Sage Creek",
            "unique_fire_id": "2026-WANES-000301", "created_on": "2026-08-20T00:00:00Z"}
    world.record(sage_key, "sage-creek", "name_exact", sage, synced=at(9, -4),
                 dir_mtime="2026-08-21 09:34",
                 children={"IR": "2026-08-21 09:34", "Products": "2026-08-21 09:34"})
    world.file(sage_key, "products/yymmdd/connection-auth-103.p12",
               lm="Thu, 16 Apr 2026 23:17:42 GMT")
    # a fire whose versions never carried created_on is not rejected, but flagged
    nameless_key = "rocky_mtn/2026/2026_Lookout"
    lookout = {"cornea_id": "{0F0F0F0F-0000-4000-8000-00000000006B}", "post_title": "Lookout",
               "unique_fire_id": "2026-SDBKF-000120"}
    world.record(nameless_key, "lookout", "name_fuzzy", lookout, synced=at(9, -6))
    world.file(nameless_key, "products/20260601/ops_Lookout_0601.pdf",
               lm="Mon, 01 Jun 2026 01:00:00 GMT")

    def rows(n):
        return default_rows(n) + [row(sage, "sage-creek", sage_key, "name_exact"),
                                  row(lookout, "lookout", nameless_key, "name_fuzzy")]

    world.rows = rows
    mig = _migration(world)
    mig.resolve_records()
    cherry = mig.state["incidents"][CHERRY_KEY]
    assert cherry["id_unresolved"]["reason"] == (
        "newest upload 2026-07-05T15:42:24Z is more than 7 days before the fire was created "
        "(2026-08-27T21:23:44Z)")
    assert cherry["id_unresolved"]["candidate"] == CHERRY_ID["cornea_id"]
    assert mig.state["incidents"][sage_key]["cornea_id"] == sage["cornea_id"]
    assert mig.state["incidents"][nameless_key]["cornea_id"] == lookout["cornea_id"]
    assert mig.report["records"]["no_created_on"] == [nameless_key]
    assert [u["key"] for u in mig.report["records"]["unresolved"]] == [CHERRY_KEY]


def test_slug_collision_detach_is_reattached(tmp_path):
    # Wildhorse ID's folder was detached when 'wildhorse' moved to
    # WILDHORSE OK, a newer fire the folder predates; by its own sync's
    # catalog it was Wildhorse ID's folder all along.
    wh_id = {"cornea_id": "{177292F2-1D3B-4C5A-9E8F-000000000001}", "post_title": "Wildhorse",
             "unique_fire_id": "2026-IDBOF-000377", "created_on": "2026-08-20T00:00:00Z"}
    wh_ok = {"cornea_id": "{8C318F2C-0000-4000-8000-000000000002}", "post_title": "WILDHORSE",
             "unique_fire_id": "2026-OKOKS-000044", "created_on": "2026-09-26T23:12:28Z"}
    key = "great_basin/2026/2026_Wildhorse"

    def rows(n):
        return default_rows(n) + [row(wh_id, "wildhorse", key, "name_exact") if n <= 20
                                  else row(wh_ok, "wildhorse")]

    world = World(tmp_path, rows=rows)
    world.record(key, "wildhorse", "name_exact", wh_id, synced=at(15, -20), match=False,
                 match_rejected={"fire_slug": "wildhorse", "method": "name_exact",
                                 "reason": "newest upload 2026-08-27 is more than 7 days before "
                                           "the fire was created (2026-09-26T23:12:28Z)",
                                 "at": "2026-09-27T00:51:55Z"})
    world.file(key, "ir/20260827/20260827_Wildhorse_IR.kmz", lm="Thu, 27 Aug 2026 04:26:00 GMT")
    mig = _migration(world)
    mig.resolve_records()

    rec = mig.state["incidents"][key]
    assert rec["cornea_id"] == wh_id["cornea_id"]
    assert rec["match"] == {"method": "name_exact", "confidence": 0.95, "token": None,
                            "dir_url": dir_of(key)}
    assert rec["reattached_at"] == NOW and "match_rejected" not in rec
    assert rec["bound"]["method"] == "name_exact"
    assert mig.report["records"]["reattached"] == [key]


# ---------------------------------------------------------------------------
# step B: one storage prefix per folder
# ---------------------------------------------------------------------------

def test_split_every_shared_prefix_keeper_and_stamps(tmp_path):
    world = World(tmp_path)
    # Rock Canyon (a June folder name-matched to Rocky Canyon UT) shares
    # rocky-canyon with Rocky Canyon's own folder
    rocky = {"cornea_id": "{0258851A-0000-4000-8000-000000000003}", "post_title": "Rocky Canyon",
             "unique_fire_id": "2026-UTCCD-000555", "created_on": "2026-08-16T00:00:00Z"}
    rock_key, rocky_key = "great_basin/2026/2026_Rock Canyon", "great_basin/2026/2026_RockyCanyon"
    world.record(rocky_key, "rocky-canyon", "unit_id", rocky, synced=at(20, -1))
    world.file(rocky_key, "products/20260820/ops_RockyCanyon_0820.pdf")
    world.record(rock_key, "rocky-canyon", "name_fuzzy", rocky, synced=at(21, -1))
    june = world.file(rock_key, "ir/20260622/20260622_Rock_Canyon_IR.kmz",
                      lm="Mon, 22 Jun 2026 05:15:04 GMT")
    world.fires.append(api_fire(rocky, "rocky-canyon"))

    def rows(n):
        return default_rows(n) + [row(rocky, "rocky-canyon", rocky_key if n < 21 else rock_key,
                                      "unit_id" if n < 21 else "name_fuzzy")]

    world.rows = rows
    mig = _migration(world)
    before = {k: {rel: raw_key(r, rel) for rel in r["files"]}
              for k, r in mig.state["incidents"].items()}
    mig.resolve_records()
    mig.split_prefixes()
    incidents = mig.state["incidents"]

    split = {s["prefix"]: s for s in mig.report["prefixes"]["split"]}
    assert set(split) == {"twin-sisters", "rocky-canyon"}
    # the folder bound to an active fire by the stronger method keeps the prefix
    assert split["twin-sisters"]["keeper"] == MT_KEY
    assert split["twin-sisters"]["moved"] == [{"key": WA_KEY, "new_prefix": WA_FK,
                                               "files_stamped": 1}]
    wa = incidents[WA_KEY]
    assert wa["storage_prefix"] == wa["fire_slug"] == WA_FK
    assert all(m["prefix"] == "twin-sisters" for m in wa["files"].values())
    # Rock Canyon is unresolved (its June IR predates Rocky Canyon UT)
    assert split["rocky-canyon"]["keeper"] == rocky_key
    rock = incidents[rock_key]
    assert rock["id_unresolved"]
    suffix = hashlib.sha1(rock_key.encode()).hexdigest()[:6]
    assert rock["storage_prefix"] == rock["fire_slug"] == f"rocky-canyon-{suffix}"
    assert june["sha16"] and rock["files"]["ir/20260622/20260622_Rock_Canyon_IR.kmz"]["prefix"] \
        == "rocky-canyon"
    # every folder now writes under its own prefix, slug == prefix, and
    # every existing file is still found where it was
    prefixes = [r["storage_prefix"] for r in incidents.values()]
    assert len(prefixes) == len(set(prefixes))
    assert all(r["fire_slug"] == r["storage_prefix"] for r in incidents.values())
    assert {k: {rel: raw_key(r, rel) for rel in r["files"]}
            for k, r in incidents.items()} == before


# ---------------------------------------------------------------------------
# step C: locating bytes
# ---------------------------------------------------------------------------

class ReadSpy(DryRunStorage):
    def __init__(self, root):
        super().__init__(root)
        self.fetched: list[str] = []

    def get_file(self, key, dest):
        self.fetched.append(key)
        return super().get_file(key, dest)


def test_locate_stamps_only_hash_verified_candidate(tmp_path):
    storage = ReadSpy(tmp_path)
    good, other = b"%PDF the real sheet", b"%PDF the other one"
    rel, rel2, rel3 = ("products/20260820/Ops_Austin_0820.pdf", "qr/Evac_0820.pdf",
                       "products/20261003/Ops_Grasshopper_1003.pdf")
    state = {"tiled": {}, "incidents": {GH_KEY: {
        "fire_slug": "grasshopper", "storage_prefix": "grasshopper", "files": {
            rel: {"sha16": sha16(good), "size": len(good)},
            rel2: {"sha16": sha16(good), "size": len(good)},
            rel3: {"sha16": sha16(other), "size": len(other)}}}}}
    # same rel and size under austin/ (where history points first) but other
    # bytes; the right bytes under sand-creek/; a different size never fetched
    storage.put_bytes(f"raw/incidents/austin/{rel}", b"%PDF not the sheet!")
    storage.put_bytes(f"raw/incidents/sand-creek/{rel}", good)
    storage.put_bytes(f"raw/incidents/bobcat-lakes/{rel}", good + b"longer")
    storage.put_bytes(f"raw/incidents/austin/{rel2}", b"%PDF not the sheet!")
    storage.put_bytes(f"raw/incidents/grasshopper/{rel3}", other)
    assert len(b"%PDF not the sheet!") == len(good)

    listings = asset_locate.list_assets(storage, log=lambda *_: None)
    rep = asset_locate.locate_raw(storage, state, listings, prefer={GH_KEY: ["austin"]},
                                  log=lambda *_: None)
    files = state["incidents"][GH_KEY]["files"]
    assert files[rel]["prefix"] == "sand-creek"
    assert "prefix" not in files[rel2] and "prefix" not in files[rel3]
    assert rep["ok"] == 1 and rep["relocated"] == {"sand-creek": 1}
    assert rep["missing"] == [{"key": GH_KEY, "rel": rel2, "sha16": sha16(good)}]
    assert rep["sha_mismatch"] == [f"raw/incidents/austin/{rel}", f"raw/incidents/austin/{rel2}"]
    assert storage.fetched == [f"raw/incidents/austin/{rel}", f"raw/incidents/sand-creek/{rel}",
                               f"raw/incidents/austin/{rel2}"]


def test_locate_prefers_live_manifest_copy():
    state = {"incidents": {
        GH_KEY: {"fire_slug": "grasshopper", "storage_prefix": "grasshopper", "files": {
            "a.pdf": {"sha16": "aaaa"}, "b.pdf": {"sha16": "bbbb", "prefix": "austin"},
            "c.pdf": {"sha16": "cccc"}, "d.pdf": {"sha16": "dddd"}}}},
        "tiled": {"aaaa": {"geo": {"tiles": {}, "preview": True}},
                  "bbbb": {"geo": {"tiles": {}, "preview": True}},
                  "cccc": {"geo": {"tiles": {}, "preview": True}},
                  "dddd": {"geo": {"tiles": {"minzoom": 8}, "preview": True}},
                  "eeee": {"geo": {"tiles": {}}}}}   # held by no file: left alone
    listings = asset_locate.Listings(
        tiles={"aaaa": {"austin", "grasshopper"}, "bbbb": {"austin", "grasshopper"},
               "cccc": {"zeta", "beta"}, "eeee": {"x"}},
        previews={"aaaa": {"bobcat-lakes"}, "bbbb": {"grasshopper"}, "cccc": {"beta"}})
    live_tiles = {"aaaa": {"grasshopper", "elsewhere"}}
    rep = asset_locate.locate_shas(state, listings, live_tiles, {})
    tiled = state["tiled"]
    # the copy today's manifest links, then its preview where it is
    assert (tiled["aaaa"]["prefix"], tiled["aaaa"]["preview_prefix"]) == ("grasshopper",
                                                                          "bobcat-lakes")
    # no live copy: the one under the file's own location
    assert tiled["bbbb"]["prefix"] == "austin" and tiled["bbbb"]["preview_prefix"] == "grasshopper"
    # otherwise alphabetical
    assert tiled["cccc"]["prefix"] == "beta" and "preview_prefix" not in tiled["cccc"]
    # copies nowhere: no stamp, reported against the geo that claims them
    assert "prefix" not in tiled["dddd"] and "prefix" not in tiled["eeee"]
    assert rep["tiles"]["missing"] == ["dddd"] and rep["previews"]["missing"] == ["dddd"]
    assert rep["tiles"]["relocated"] == {"austin": 1, "beta": 1}


# ---------------------------------------------------------------------------
# step D: files under foreign prefixes
# ---------------------------------------------------------------------------

def test_ownership_from_history_majority(tmp_path):
    mig = _through_locate(_migration(World(tmp_path)))
    mig.attribute_foreign_locations()
    gh = mig.state["incidents"][GH_KEY]
    assert _stamps(gh, GH_AT_AUSTIN) == {(AU_FK, "token"): 1, (AU_FK, "name"): 2,
                                         (AU_FK, "location"): 1, ("unstamped", None): 3}
    assert gh["files"]["ir/20260817/20260817_Mitchell_IR_11x17_Topo.pdf"]["fk_src"] == "location"
    assert gh["files"][GH_SHEET].get("fk") is None and "fk" not in gh["files"][GH_SHEET]
    [entry] = mig.report["ownership"]
    assert entry["location"] == "austin" and entry["owner_fk"] == AU_FK
    assert entry["stays"] == 3 and entry["history_rows"] >= 3
    assert gh["rebound_from"] == [{"cornea_id": AUSTIN["cornea_id"], "uid": "2026-ORMHF-000863",
                                   "name": "austin", "method": "unit_id", "at": NOW,
                                   "source": "migration"}]
    assert mig.report["foreign_location_unattributed"] == []

    # history split between two fires under the slug: no majority, a blocker
    other = {"cornea_id": "{B451676E-0000-4000-8000-000000000004}", "post_title": "Austin",
             "unique_fire_id": "2026-ORPRF-000123"}

    def rows(n):
        out = default_rows(n)
        if 16 <= n <= 25:
            out = [r for r in out if r["fire_slug"] != "austin"] + [row(other, "austin", GH_KEY)]
        return out

    mig = _through_locate(_migration(World(tmp_path / "split", rows=rows)))
    mig.attribute_foreign_locations()
    [blocked] = mig.report["foreign_location_unattributed"]
    assert (blocked["key"], blocked["location"], blocked["files"]) == (GH_KEY, "austin", 7)
    assert "fk" not in json.dumps(mig.state["incidents"][GH_KEY]["files"])
    assert any(g.startswith("G3:") for g in _guards_after(mig))


def _guards_after(mig):
    mig.own_location_evidence()
    mig.legacy_ir_stamps()
    mig.suspects()
    mig.rebuild_fires()
    mig.finish()
    mig.report["per_record"] = migrate_ids.fingerprint(mig.state)
    return mig.guards()


def test_history_manifest_conflict_blocks(tmp_path):
    # austin.json still lists 2026_Grasshopper's sheet at austin/ (same URL
    # and sha) but names another fire than the history does
    world = World(tmp_path)
    other = "{B451676E-0000-4000-8000-000000000004}"
    rel = GH_AT_AUSTIN[0]
    world.manifests["austin"]["cornea_id"] = other
    world.manifests["austin"]["maps"].append(
        {"id": world.sha(GH_KEY, rel), "filename": rel.rpartition("/")[2],
         "pdf_url": f"/raw/incidents/austin/{rel}"})
    mig = _through_locate(_migration(world))
    mig.attribute_foreign_locations()
    assert mig.report["evidence_conflict"] == [{"manifest_cornea": other, "listed": 1,
                                                "key": GH_KEY, "location": "austin",
                                                "history": AU_FK}]
    assert "fk" not in json.dumps(mig.state["incidents"][GH_KEY]["files"])
    assert any(g.startswith("G3:") for g in _guards_after(mig))

    # listing the file under the history's fire is no conflict
    world = World(tmp_path / "ok")
    world.manifests["austin"]["maps"].append(
        {"id": world.sha(GH_KEY, rel), "pdf_url": f"/raw/incidents/austin/{rel}"})
    mig = _through_locate(_migration(world))
    mig.attribute_foreign_locations()
    assert mig.report["evidence_conflict"] == []


def test_d2_own_location_name_evidence(tmp_path, fixtures):
    # 2026_BobcatLakes: bound to Bobcat Lakes (bytes under bobcat-lakes/),
    # then by token to Sand Creek (sand-creek/); 9 of the files mirrored
    # since name Bobcat Lakes
    names = json.loads((fixtures / "incident_files.json").read_text())
    key = "n_rockies/2026/2026_BobcatLakes"

    def rows(n):
        out = default_rows(n)
        if n <= 25:
            return out + [row(BOBCAT_LAKES, "bobcat-lakes", key), row(SAND_CREEK, "sand-creek")]
        return out + [row(BOBCAT_LAKES, "bobcat-lakes"), row(SAND_CREEK, "sand-creek", key)]

    world = World(tmp_path, rows=rows)
    world.fires += [api_fire(BOBCAT_LAKES, "bobcat-lakes"), api_fire(SAND_CREEK, "sand-creek")]
    world.record(key, "sand-creek", "unit_id", SAND_CREEK, synced=at(30, -7))
    for rel in names["bobcatlakes_under_bobcat_lakes"]:
        world.file(key, rel, at_prefix="bobcat-lakes")
    for rel in names["bobcatlakes_own"]:
        world.file(key, rel)
    mig = _through_locate(_migration(world))
    mig.attribute_foreign_locations()
    mig.own_location_evidence()

    rec = mig.state["incidents"][key]
    bl = fire_key(BOBCAT_LAKES["cornea_id"])
    assert _stamps(rec, names["bobcatlakes_under_bobcat_lakes"]) == {(bl, "token"): 20,
                                                                    (bl, "name"): 5}
    assert _stamps(rec, names["bobcatlakes_own"]) == {(bl, "token"): 2, (bl, "name"): 7,
                                                      ("unstamped", None): 29}
    assert {"key": key, "location": "sand-creek", "owner_fk": bl,
            "by_src": {"name": 7, "token": 2}, "step": "D2"} in mig.report["ownership"]
    # the 2026-09-14 flight goes with Bobcat Lakes whole
    flight = [r for r in names["bobcatlakes_own"] if r.startswith("ir/20260914/")]
    assert flight and {file_owner(rec, rec["files"][r]) for r in flight} == {bl}


def test_legacy_ir_stamp_only_when_source_owned(tmp_path):
    world = World(tmp_path)
    # Cherry is unresolved: its legacy conversion is never kept
    world.file(CHERRY_KEY, "ir/20260629/20260629_Cherry_IR.kmz", lm="Mon, 29 Jun 2026 04:00:00 GMT")
    world.file(CHERRY_KEY, "ir/20260629/20260629_Cherry_IR_11x17_Topo.pdf",
               lm="Mon, 29 Jun 2026 04:00:00 GMT")
    world.state["ir"]["vectors/ir/cherry/20260629_IR_11x17_Topo.geojson"] = {
        "v": ir_vectors.IR_CONVERTER_VERSION, "heat_types": ["Perimeter"]}
    mig = _migration(world)
    mig.run()

    gh = mig.state["incidents"][GH_KEY]
    # austin/20260817 came from Grasshopper's KMZ; grasshopper/20260929 from Austin's
    assert gh["ir_keys"] == {
        "ir/20260817/20260817_Grasshopper_IR.kmz": {
            "key": IR_AUSTIN_0817, "flight_id": "20260817_IR_11x17_Topo",
            "src_sha16": world.sha(GH_KEY, "ir/20260817/20260817_Grasshopper_IR.kmz")},
        "ir/20260929/20260929_Austin_IR.kmz": {
            "key": IR_GH_0929, "flight_id": "20260929_Austin_IR_11x17_Aerial",
            "src_sha16": world.sha(GH_KEY, "ir/20260929/20260929_Austin_IR.kmz")}}
    assert file_owner(gh, gh["files"]["ir/20260929/20260929_Austin_IR.kmz"]) == AU_FK
    assert "ir_keys" not in mig.state["incidents"][CHERRY_KEY]

    flights = {fk: {f["flight_date"]: f for f in mig.new_manifests[fk]["ir_flights"]}
               for fk in (GH_FK, AU_FK)}
    assert flights[GH_FK]["2026-08-17"]["geojson_url"] == f"/{IR_AUSTIN_0817}"
    assert flights[GH_FK]["2026-08-17"]["kmz_url"] == \
        "/raw/incidents/austin/ir/20260817/20260817_Grasshopper_IR.kmz"
    assert flights[GH_FK]["2026-09-29"]["geojson_url"] is None  # converted on the next run
    assert flights[AU_FK]["2026-08-17"]["geojson_url"] is None  # Austin's own KMZ is not here
    assert flights[AU_FK]["2026-08-17"]["pdf_url"] == \
        "/raw/incidents/austin/ir/20260817/20260817_Austin_IR_11x17_Topo.pdf"
    assert flights[AU_FK]["2026-09-29"]["geojson_url"] == f"/{IR_GH_0929}"


@pytest.mark.parametrize("wa, mt_keeps", [
    ("active", False),
    ("inactive", False),           # WA's fire left the active list: its claim still counts
    ("hidden_source", False),      # WA's KMZ shows on no fire
    ("unresolved", False),         # WA's token names no fire: its candidate's name recomputes
    ("unresolved_unnamed", False),  # no candidate row: the folder name contests the key
    ("inactive_same_bytes", True),  # both KMZs are one file: either made the same key
])
def test_legacy_ir_key_claimed_by_two_sources_is_kept_by_none(tmp_path, wa, mt_keeps):
    # Both Twin Sisters folders wrote under twin-sisters/: each recomputes
    # the same legacy key from its own KMZ, and only one of them made it
    world = World(tmp_path)
    for key in (MT_KEY, WA_KEY):
        world.file(key, "ir/20260801/20260801_IR_Topo.pdf")
        world.file(key, "ir/20260801/20260801_IR.kmz",
                   data=b"one kmz" if wa == "inactive_same_bytes" else None)
    vkey = "vectors/ir/twin-sisters/20260801_IR_Topo.geojson"
    world.state["ir"][vkey] = {"v": ir_vectors.IR_CONVERTER_VERSION, "heat_types": ["Perimeter"]}
    wa_rec = world.state["incidents"][WA_KEY]
    if wa.startswith("inactive"):
        world.fires = [f for f in world.fires if f["cornea_id"] != TWIN_WA["cornea_id"]]
    elif wa == "hidden_source":
        wa_rec["files"]["ir/20260801/20260801_IR.kmz"].update(fk=None, fk_src="hidden")
    elif wa == "unresolved":
        wa_rec["match"] = dict(wa_rec["match"], method="unit_id", token="2026-WAWFS-000001")
    elif wa == "unresolved_unnamed":
        wa_rec["synced_at"] = None
    mig = _migration(world)
    mig.run()

    if wa.startswith("unresolved"):
        assert WA_KEY in {u["key"] for u in mig.report["records"]["unresolved"]}
    else:
        assert mig.state["incidents"][WA_KEY]["cornea_id"] == TWIN_WA["cornea_id"]
    mt = mig.state["incidents"][MT_KEY]
    assert "ir_keys" not in mig.state["incidents"][WA_KEY]
    if mt_keeps:
        assert mt["ir_keys"]["ir/20260801/20260801_IR.kmz"]["key"] == vkey
        assert mig.report["ir"]["key_collisions"] == []
        return
    assert "ir_keys" not in mt
    # only a source that could be stamped is reported
    assert sorted(c["key"] for c in mig.report["ir"]["key_collisions"]) == \
        ([MT_KEY, WA_KEY] if wa == "active" else [MT_KEY])


# ---------------------------------------------------------------------------
# report / apply
# ---------------------------------------------------------------------------

def test_report_and_apply_compute_identical_captures(tmp_path, monkeypatch):
    freeze_clock(monkeypatch)
    world = World(tmp_path).publish()
    runs = []
    for _ in range(2):
        mig = migrate_ids.Migration(
            world.storage, state_mod.load_state(world.storage), world.fetch_fires(),
            prev_catalog=world.storage.get_json("catalogs/catalog.json"), now=NOW,
            log=lambda *_: None)
        mig.run()
        runs.append(mig)
    assert runs[0].out.puts == runs[1].out.puts
    assert runs[0].out.puts and runs[0].report == runs[1].report

    # and through the CLI: the apply reproduces the report run's captures
    wire_cli(monkeypatch, world)
    assert cli.main(["migrate-incident-ids", "--report", "--report-out",
                     str(tmp_path / "report.json")]) == 0
    assert cli.main(["migrate-incident-ids", "--apply", "--expect", str(tmp_path / "report.json"),
                     "--report-out", str(tmp_path / "apply.json")]) == 0
    report = json.loads((tmp_path / "report.json").read_text())
    applied = json.loads((tmp_path / "apply.json").read_text())
    assert report["captured_keys"] == applied["captured_keys"] == runs[0].out.captured_keys()
    assert report["per_record"] == applied["per_record"]
    assert applied["drift"] == []


def test_report_mode_never_flushes(tmp_path, monkeypatch):
    world = World(tmp_path).publish()
    before = (world.storage.out_dir / STATE_KEY).read_bytes()
    wire_cli(monkeypatch, world, sync_by_id=False)
    out = tmp_path / "report.json"
    assert cli.main(["migrate-incident-ids", "--report", "--report-out", str(out)]) == 0
    assert world.storage.written == []
    assert (world.storage.out_dir / STATE_KEY).read_bytes() == before
    assert not world.storage.exists(f"catalogs/incidents/id/{GH_FK}.json")
    report = json.loads(out.read_text())
    assert report["mode"] == "report" and report["storage_writes"] == 0
    assert report["would_abort"] == []
    assert f"catalogs/incidents/id/{GH_FK}.json" in report["captured_keys"]
    assert report["records"]["unresolved"][0]["key"] == CHERRY_KEY
    assert report["per_record"][GH_KEY]["stamps"] == {f"{AU_FK}|location": 1,
                                                      f"{AU_FK}|name": 4, f"{AU_FK}|token": 2}


def test_apply_refuses_without_expect(tmp_path, monkeypatch):
    world = World(tmp_path).publish()
    wire_cli(monkeypatch, world)
    monkeypatch.setattr(cli, "make_storage", lambda *a: pytest.fail("no storage before the checks"))
    assert cli.main(["migrate-incident-ids", "--apply"]) == 2
    # nor while sync-incidents still keys by slug, even with a report
    (tmp_path / "r.json").write_text("{}")
    monkeypatch.setattr(cli, "INCIDENT_SYNC_BY_ID", False)
    assert cli.main(["migrate-incident-ids", "--apply", "--expect", str(tmp_path / "r.json")]) == 2
    assert world.storage.written == []


def test_apply_aborts_on_guard_before_any_write(tmp_path, monkeypatch):
    world = World(tmp_path).publish()
    wire_cli(monkeypatch, world)
    assert cli.main(["migrate-incident-ids", "--report-out", str(tmp_path / "report.json")]) == 0

    # since the report: Austin's folder token changed without a new sync
    state = world.state_on_bucket()
    state["incidents"][AU_KEY]["match"]["token"] = "2026-ORMHF-000855"
    world.storage.put_json(STATE_KEY, state)
    world.storage.written.clear()
    out = tmp_path / "apply.json"
    assert cli.main(["migrate-incident-ids", "--apply", "--expect", str(tmp_path / "report.json"),
                     "--report-out", str(out)]) == 1
    assert world.storage.written == []
    applied = json.loads(out.read_text())
    assert applied["storage_writes"] == 0
    # (Austin keeps the sheets stamped to it, and its own sheet's loss is
    # explained by the unresolved folder: only G8 sees the difference)
    assert [g[:3] for g in applied["would_abort"]] == ["G8:"]
    assert f"{AU_KEY}: unresolved differs" in applied["would_abort"][0]
    assert {u["key"] for u in applied["records"]["unresolved"]} == {CHERRY_KEY, AU_KEY}

    # a guard on this run's own outputs aborts too (G1: too many unresolved)
    monkeypatch.setattr(migrate_ids, "MAX_UNRESOLVED", 0)
    state["incidents"][AU_KEY]["match"]["token"] = AUSTIN["unique_fire_id"]
    world.storage.put_json(STATE_KEY, state)
    world.storage.written.clear()
    assert cli.main(["migrate-incident-ids", "--apply", "--expect",
                     str(tmp_path / "report.json")]) == 1
    assert world.storage.written == []


def test_apply_flush_order_and_backup_first(tmp_path, monkeypatch):
    freeze_clock(monkeypatch)
    world = World(tmp_path).publish()
    original = world.state_on_bucket()
    wire_cli(monkeypatch, world)
    assert cli.main(["migrate-incident-ids", "--report-out", str(tmp_path / "report.json")]) == 0
    assert cli.main(["migrate-incident-ids", "--apply", "--expect", str(tmp_path / "report.json"),
                     "--report-out", str(tmp_path / "apply.json")]) == 0

    backup = "state/backups/state.pre-incident-ids.20261009T020000Z.json"
    manifests = [f"catalogs/incidents/id/{fk}.json" for fk in sorted({GH_FK, AU_FK, WA_FK,
                                                                      fire_key(TWIN_MT["cornea_id"])})]
    assert world.storage.written == [backup, *manifests, STATE_KEY,
                                     f"catalogs/versions/catalog.{LATEST + 1}.json",
                                     "catalogs/catalog.json", health.KEY]
    assert json.loads((world.storage.out_dir / backup).read_text()) == original
    state = world.state_on_bucket()
    assert state["migrations"]["incident_ids"] == NOW
    assert state["migrations"]["backup"] == backup
    assert state["catalog_version"] == LATEST + 1
    catalog = world.storage.get_json("catalogs/catalog.json")
    rows = {r["fire_slug"]: r for r in catalog["fires"]}
    assert rows["austin"]["incident_manifest"] == f"/catalogs/incidents/id/{AU_FK}.json"
    assert rows["twin-sisters-wa"]["has_incident_maps"] is True
    assert world.storage.get_json(health.KEY)["migration"]["unresolved"] == [CHERRY_KEY]
    applied = json.loads((tmp_path / "apply.json").read_text())
    assert applied["flush_verified"] is True and applied["storage_writes"] == len(
        world.storage.written)


def test_apply_is_idempotent_and_writes_slugs_at_migration(tmp_path, monkeypatch):
    world = World(tmp_path).publish()
    wire_cli(monkeypatch, world)
    assert cli.main(["migrate-incident-ids", "--report-out", str(tmp_path / "report.json")]) == 0
    expect = ["--expect", str(tmp_path / "report.json")]
    assert cli.main(["migrate-incident-ids", "--apply", *expect]) == 0
    state = world.state_on_bucket()
    assert state["migrations"]["slugs_at_migration"] == {
        CHERRY_KEY: "cherry", MT_KEY: "twin-sisters", AU_KEY: "austin", GH_KEY: "grasshopper",
        WA_KEY: "twin-sisters"}
    # every record writes under its own prefix and its slug equals it
    assert all(r["fire_slug"] == r["storage_prefix"] for r in state["incidents"].values())
    assert state["incidents"][WA_KEY]["storage_prefix"] == WA_FK

    world.storage.written.clear()
    assert cli.main(["migrate-incident-ids", "--apply", *expect,
                     "--report-out", str(tmp_path / "again.json")]) == 0
    assert world.storage.written == []
    assert json.loads((tmp_path / "again.json").read_text())["already_migrated"] is True


def test_migration_writes_no_immutable_keys_and_no_deletes(tmp_path, monkeypatch):
    world = World(tmp_path).publish()
    keys_before = {k for k, _ in world.storage.list_keys("")}
    wire_cli(monkeypatch, world)
    assert cli.main(["migrate-incident-ids", "--report-out", str(tmp_path / "report.json")]) == 0
    assert cli.main(["migrate-incident-ids", "--apply", "--expect",
                     str(tmp_path / "report.json")]) == 0  # SpyStorage fails any delete

    written = world.storage.written
    assert not [k for k in written if k.startswith(("raw/", "tiles/", "previews/", "vectors/"))]
    assert all(k.startswith(("catalogs/incidents/id/", migrate_ids.BACKUP_PREFIX))
               or k in {STATE_KEY, health.KEY, "catalogs/catalog.json",
                        f"catalogs/versions/catalog.{LATEST + 1}.json"} for k in written)
    assert keys_before <= {k for k, _ in world.storage.list_keys("")}  # nothing removed
    # G6 itself: a stray capture outside those keys blocks the apply
    mig = _migration(World(tmp_path / "g6"))
    mig.run()
    mig.out.put_bytes("tiles/incidents/austin/x/meta.json", b"{}")
    assert any(g.startswith("G6:") for g in mig.guards())
