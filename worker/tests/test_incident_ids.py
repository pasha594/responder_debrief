"""Folder and file ownership by fire ID: file-name evidence, the rebind
policy, contributors, the per-record date check, and IR source choice.
File names come from the real records (fixtures/incident_files.json)."""

import hashlib
import json
from collections import Counter
from types import SimpleNamespace

import pytest

from responder_worker import incident_ids as ii, state as state_mod
from responder_worker.fires import fire_key

AUSTIN = {"cornea_id": "{49D1FB0B-74D1-4A95-B8DF-066DCC5F06E1}", "post_title": "AUSTIN",
          "unique_fire_id": "2026-ORMHF-000863", "state": "OR", "created_on": "2026-08-09T18:30:24Z"}
GRASSHOPPER = {"cornea_id": "{6AA4C355-AD18-472F-AAAB-78BAA9DE31B1}", "post_title": "GRASSHOPPER",
               "unique_fire_id": "2026-ORMHF-000688", "state": "OR",
               "created_on": "2026-07-24T03:39:58Z"}
BOBCAT_LAKES = {"cornea_id": "{801A448C-B5B4-4DCC-BAE2-CEF8FEDBB2A6}", "post_title": "Bobcat Lakes",
                "unique_fire_id": "2026-MTBDF-266313", "state": "MT"}
SAND_CREEK = {"cornea_id": "{84FD3D7E-6B04-49CD-A729-ED3178A49C42}", "post_title": "Sand Creek",
              "unique_fire_id": "2026-MTBDF-266319", "state": "MT"}
CHERRY_ID = {"cornea_id": "{4ED33892-8440-4997-A22B-DA0D36632ED1}", "post_title": "Cherry",
             "unique_fire_id": "2026-IDLEX-260156", "state": "ID", "created_on": "2026-08-27T21:23:44Z"}
IRON = {"cornea_id": "{B22F7798-E3C3-4E1B-A091-CC85EBE4DA75}", "post_title": "Iron",
        "unique_fire_id": "2026-UTSCS-260194", "state": "UT"}
SAWMILL_ID = {"cornea_id": "{44ACF72D-362D-4818-8504-FDB896A95A16}", "post_title": "SAWMILL",
              "unique_fire_id": "2026-IDBOF-000412", "state": "ID"}
TWIN_SISTERS_MT = {"cornea_id": "{BD729423-8D4D-4FA3-BB9A-B738F6C71B88}", "post_title": "Twin Sisters",
                   "unique_fire_id": "2026-MTHLF-000497", "state": "MT"}
TWIN_SISTERS_WA = {"cornea_id": "{40432B79-397F-4C30-8667-2DCE4A76A6FE}", "post_title": "TWIN SISTERS",
                   "unique_fire_id": "2026-WAWFS-260222", "state": "WA"}
BEAR_TRAP = {"cornea_id": "{1BB1F12F-DB68-40B0-8D7B-FA0E4FCEE2E4}", "post_title": "Bear Trap",
             "unique_fire_id": "2026-MNSUF-002394", "state": "MN"}
CHIPMUNK_FL = {"cornea_id": "{961F6E41-B910-4A84-BE8D-ACAEB538FC56}", "post_title": "Chipmunk",
               "unique_fire_id": "2026-FLEVP-002565", "state": "FL"}
CHIPMUNK_WI = {"cornea_id": "{4D53005D-D092-4281-9CC7-56B13E9880A9}", "post_title": "Chipmunk",
               "unique_fire_id": "2026-WIWIS-125377", "state": "WI"}

GRASSHOPPER_KEY = "pacific_nw/2026/2026_Grasshopper"
BOBCAT_KEY = "n_rockies/2026/2026_BobcatLakes"
CHERRY_KEY = "great_basin/2026/2026_Cherry"
NOW = "2026-10-08T18:00:00Z"


def fk(fire):
    return fire_key(fire["cornea_id"])


def match(method, fire):
    return SimpleNamespace(method=method, cornea_id=fire["cornea_id"])


@pytest.fixture(scope="module")
def names(fixtures):
    return json.loads((fixtures / "incident_files.json").read_text())


def _rec(fire, method, rels, *, slug="x", **extra):
    rec = {"fire_slug": slug, "storage_prefix": slug, "cornea_id": fire["cornea_id"],
           "match": {"method": method, "confidence": ii.DEFAULT_CONFIDENCE[method]},
           "bound": ii.bound_info(fire, method),
           "files": {rel: {"sha16": hashlib.sha256(rel.encode()).hexdigest()[:16]} for rel in rels}}
    rec.update(extra)
    return rec


def _stamps(rec):
    return Counter((m.get("fk", "unstamped"), m.get("fk_src")) for m in rec["files"].values())


# ---------------------------------------------------------------------------
# records
# ---------------------------------------------------------------------------

def test_new_record_slug_equals_prefix():
    state = {"incidents": {"n_rockies/2026/2026_SandCreek": _rec(
        SAND_CREEK, "unit_id", [], slug=fk(SAND_CREEK))}}
    rec = ii.bind_record(state, BOBCAT_KEY, cornea_id=BOBCAT_LAKES["cornea_id"],
                         match={"method": "unit_id"}, bound=ii.bound_info(BOBCAT_LAKES, "unit_id"),
                         region="n_rockies")
    assert state["incidents"][BOBCAT_KEY] is rec
    assert rec["fire_slug"] == rec["storage_prefix"] == fk(BOBCAT_LAKES)
    assert (rec["cornea_id"], rec["region"], rec["files"], rec["dir_mtime"]) == (
        BOBCAT_LAKES["cornea_id"], "n_rockies", {}, None)
    # a second folder of Sand Creek may not share the first one's prefix
    key = "n_rockies/2026/2026_SandCreekComplex"
    rec2 = ii.bind_record(state, key, cornea_id=SAND_CREEK["cornea_id"], match={"method": "unit_id"})
    assert rec2["fire_slug"] == rec2["storage_prefix"] == \
        f"{fk(SAND_CREEK)}-{hashlib.sha1(key.encode()).hexdigest()[:6]}"
    with pytest.raises(ValueError):
        ii.bind_record(state, "n_rockies/2026/2026_Nope", cornea_id=None, match={"method": "unit_id"})
    assert "n_rockies/2026/2026_Nope" not in state["incidents"]


def test_existing_record_never_rewrites_slug_or_prefix():
    rec = _rec(AUSTIN, "unit_id", ["products/20260820/Ops_Austin_0820.pdf"], slug="austin")
    state = {"incidents": {"pacific_nw/2026/2026_Austin": rec}}
    same_fire = AUSTIN["cornea_id"].strip("{}").lower()  # any spelling of the same id
    got = ii.bind_record(state, "pacific_nw/2026/2026_Austin", cornea_id=same_fire,
                         match={"method": "name_exact"}, region="pacific_nw_oregon")
    assert got is rec
    assert (rec["fire_slug"], rec["storage_prefix"]) == ("austin", "austin")
    assert rec["match"] == {"method": "name_exact"} and rec["region"] == "pacific_nw_oregon"
    ii.bind_record(state, "pacific_nw/2026/2026_Austin", cornea_id=same_fire, match={"method": "unit_id"})
    assert rec["region"] == "pacific_nw_oregon"  # not cleared by a call without one
    before = json.dumps(rec, sort_keys=True)
    with pytest.raises(ValueError):
        ii.bind_record(state, "pacific_nw/2026/2026_Austin", cornea_id=GRASSHOPPER["cornea_id"],
                       match={"method": "unit_id"})
    assert json.dumps(rec, sort_keys=True) == before


def test_state_defaults_add_sections_but_never_the_flag(tmp_path):
    from responder_worker.b2 import DryRunStorage

    assert ii.migrated(state_mod.empty_state()) is False
    storage = DryRunStorage(tmp_path)
    storage.put_json(state_mod.STATE_KEY, {"incidents": {"k": {"fire_slug": "a"}}, "catalog_version": 7})
    st = state_mod.load_state(storage)
    assert st["incident_fires"] == {} and st["migrations"] == {} and not ii.migrated(st)
    storage.put_json(state_mod.STATE_KEY, {"migrations": {"incident_ids": NOW}})
    assert ii.migrated(state_mod.load_state(storage))


# ---------------------------------------------------------------------------
# file-name evidence
# ---------------------------------------------------------------------------

def test_file_evidence_token_then_name_only_bound_fires():
    gh = {fk(AUSTIN): ii.bound_info(AUSTIN, "unit_id"),
          fk(GRASSHOPPER): ii.bound_info(GRASSHOPPER, "unit_id")}
    ev = lambda fn, cands=gh: ii.file_evidence(fn, 2026, cands)  # noqa: E731
    # the unit token wins over a name elsewhere in the file name
    assert ev("Briefing_Grasshopper_ArchE_Land_20260924_2024_Austin_ORMHF000863_0925_Day.pdf") == \
        (fk(AUSTIN), "token")
    assert ev("Ops_ArchE_Land_20260924_2037_Grasshopper_ORMHF000688_0925_Day.pdf") == \
        (fk(GRASSHOPPER), "token")
    # an unparseable token (OR-MHF…) falls through to the name
    assert ev("security_arch_e_land_20261001_1540_Grasshopper_OR-MHF000688_1001day.pdf") == \
        (fk(GRASSHOPPER), "name")
    assert ev("OpsTheNarrows_Austin_0820.pdf") == (fk(AUSTIN), "name")
    assert ev("20260921_Austin_TheNarrows_IR.kmz") == (fk(AUSTIN), "name")
    # a third fire (The Narrows) is never named, by token or by name
    assert ev("20260817_TheNarrows_IR_11x17_Topo.pdf") == (None, None)
    assert ev("Ops_ArchE_20260924_2018_TheNarrows_ORMHF000855_0925_Day.pdf") == (None, None)
    # naming both bound fires proves neither
    assert ev("OpsBoth_Grasshopper_Austin_0820.pdf") == (None, None)

    bl = {fk(BOBCAT_LAKES): ii.bound_info(BOBCAT_LAKES, "unit_id"),
          fk(SAND_CREEK): ii.bound_info(SAND_CREEK, "unit_id")}
    assert ev("brief_arch_e_land_20260817_0444_BobcatLake_MTBDF266313_0817day.pdf", bl) == \
        (fk(BOBCAT_LAKES), "token")
    assert ev("20260914_Bobcat_Lakes_IR.kmz", bl) == (fk(BOBCAT_LAKES), "name")
    assert ev("OpsDivBobcatAK_BobcatLakes_0925.pdf", bl) == (fk(BOBCAT_LAKES), "name")
    assert ev("OpsBothFires_SandCreek_0925.pdf", bl) == (fk(SAND_CREEK), "name")
    assert ev("EvacBobcatLake_8x11_0820.pdf", bl) == (None, None)

    assert ii.names_fire("Bobcat_Lakes", "bobcatlakes")
    assert ii.names_fire("BobcatLakes", "bobcatlakes")
    assert ii.names_fire("SandCreek-Skull", "sandcreek")
    assert not ii.names_fire("BobcatLake", "bobcatlakes")
    assert not ii.names_fire("OpsDivBobcatAK", "bobcatlakes")  # camel case is one token
    assert ii.names_fire("20260806_HayCreek_IR", "haycreekcomplex")  # trailing complex optional
    assert not ii.names_fire("Elk_IR", None)

    # same-name fires (Chipmunk FL and WI): only the token can tell them apart
    chip = {fk(CHIPMUNK_FL): ii.bound_info(CHIPMUNK_FL, "unit_id"),
            fk(CHIPMUNK_WI): ii.bound_info(CHIPMUNK_WI, "unit_id")}
    assert ev("ops_20260822_Chipmunk_IR.kmz", chip) == (None, None)
    assert ev("ops_20260822_Chipmunk_FLEVP002565_0822day.pdf", chip) == (fk(CHIPMUNK_FL), "token")
    # a unique_fire_id held by both candidates is skipped, not guessed
    shared = {k: dict(v, uid="2026-ORMHF-000863") for k, v in gh.items()}
    assert ev("Ops_20260924_Grasshopper_ORMHF000863_0925_Day.pdf", shared) == \
        (fk(GRASSHOPPER), "name")


def test_rebind_counts_bobcat_lakes(names):
    # 2026_BobcatLakes was bound to Bobcat Lakes, then rebound by token to
    # Sand Creek: every sheet mirrored before stays with Bobcat Lakes.
    rec = _rec(BOBCAT_LAKES, "unit_id", names["bobcatlakes_under_bobcat_lakes"], slug="bobcat-lakes")
    assert ii.rebind_decision(rec, match("unit_id", SAND_CREEK)) == "rebind"
    ii.apply_bind(rec, match("unit_id", SAND_CREEK), SAND_CREEK, NOW, inc_key=BOBCAT_KEY)
    assert _stamps(rec) == {(fk(BOBCAT_LAKES), "token"): 20, (fk(BOBCAT_LAKES), "name"): 5}
    # and of the files mirrored since, 9 prove Bobcat Lakes by their names
    cands = {fk(BOBCAT_LAKES): ii.bound_info(BOBCAT_LAKES, "unit_id"),
             fk(SAND_CREEK): ii.bound_info(SAND_CREEK, "unit_id")}
    got = Counter(ii.file_evidence(r.rpartition("/")[2], 2026, cands)
                  for r in names["bobcatlakes_own"])
    assert got[(fk(BOBCAT_LAKES), "token")] == 2 and got[(fk(BOBCAT_LAKES), "name")] == 7


def test_name_evidence_ignored_for_name_bound_candidate(names):
    cands = {fk(IRON): ii.bound_info(IRON, "unit_id"),
             fk(CHERRY_ID): ii.bound_info(CHERRY_ID, "name_exact")}
    ev = lambda fn: ii.file_evidence(fn, 2026, cands)  # noqa: E731
    assert ev("20280630_Cherry_IR_11x17_Ortho.pdf") == (None, None)
    assert ev("20280630_Iron_Cherry_IR.kmz") == (fk(IRON), "name")
    # another Cherry's token (UTWDD-260218) is not Cherry ID's
    assert ev("ops_11x17_Port_20260704_1838_Cherry_UTWDD260218_0705day.pdf") == (None, None)
    # had Cherry ID been bound by ID, its name would count (and tie with Iron here)
    cands[fk(CHERRY_ID)] = ii.bound_info(CHERRY_ID, "unit_id")
    assert ev("20280630_Cherry_IR_11x17_Ortho.pdf") == (fk(CHERRY_ID), "name")
    assert ev("20280630_Iron_Cherry_IR.kmz") == (None, None)


def test_file_evidence_year_from_inc_key_2027():
    key = "pacific_nw/2027/2027_Grasshopper"
    assert ii.year_of(key) == 2027
    a27 = dict(AUSTIN, unique_fire_id="2027-ORMHF-000863", post_title="Lone Pine")
    g27 = dict(GRASSHOPPER, unique_fire_id="2027-ORMHF-000688", post_title="Juniper Flat")
    cands = {fk(a27): ii.bound_info(a27, "unit_id"), fk(g27): ii.bound_info(g27, "unit_id")}
    fn = "Ops_ArchE_Land_20270924_2018_LP_ORMHF000863_0925_Day.pdf"
    assert ii.file_evidence(fn, 2027, cands) == (fk(a27), "token")
    assert ii.file_evidence(fn, 2026, cands) == (None, None)
    # the rebind reads the year from the incident key
    rec = _rec(a27, "unit_id", [f"products/20270925/{fn}", "products/20270925/Trans_0925.pdf"])
    ii.apply_bind(rec, match("unit_id", g27), g27, NOW, inc_key=key)
    assert rec["files"][f"products/20270925/{fn}"] == {
        "sha16": rec["files"][f"products/20270925/{fn}"]["sha16"], "fk": fk(a27), "fk_src": "token"}
    assert rec["files"]["products/20270925/Trans_0925.pdf"]["fk_src"] == "prior"


# ---------------------------------------------------------------------------
# rebind policy
# ---------------------------------------------------------------------------

def test_rebind_decision_table():
    d = ii.rebind_decision
    unit_g = _rec(GRASSHOPPER, "unit_id", [])
    name_g = _rec(GRASSHOPPER, "name_exact", [])
    over_g = _rec(GRASSHOPPER, "override", [])
    assert d(None, match("unit_id", AUSTIN)) == "new"
    assert d(dict(unit_g, ignored=True, match=None), match("unit_id", GRASSHOPPER)) == "same"
    assert d(dict(unit_g, ignored=True, match=None), match("unit_id", AUSTIN)) == "fresh"
    assert d(unit_g, match("name_exact", GRASSHOPPER)) == "same"
    assert d(dict(unit_g, match=None), match("name_exact", GRASSHOPPER)) == "bind"  # detached
    assert d(dict(unit_g, cornea_id=None, match=None, id_unresolved={"reason": "x"}),
             match("unit_id", AUSTIN)) == "bind"
    assert d(unit_g, match("override", AUSTIN)) == "rebind"
    assert d(over_g, match("name_exact", AUSTIN)) == "rebind"  # override removed
    assert d(unit_g, match("name_exact", AUSTIN)) == "refuse"
    assert d(unit_g, match("name_fuzzy", AUSTIN)) == "refuse"
    assert d(unit_g, match("unit_id", AUSTIN)) == "rebind"
    assert d(name_g, match("name_exact", AUSTIN)) == "rebind"


def test_unit_to_unit_rebind_grasshopper_counts(names):
    # 2026_Grasshopper was bound to Austin by token, then to Grasshopper.
    rels = names["grasshopper_under_austin"]
    rec = _rec(AUSTIN, "unit_id", rels, slug="austin")
    m = match("unit_id", GRASSHOPPER)
    assert ii.rebind_decision(rec, m) == "rebind"
    assert ii.apply_bind(rec, m, GRASSHOPPER, NOW, inc_key=GRASSHOPPER_KEY) == fk(AUSTIN)
    assert _stamps(rec) == {("unstamped", None): 35, (fk(AUSTIN), "token"): 17,
                            (fk(AUSTIN), "name"): 17, (fk(AUSTIN), "prior"): 4}
    owners = Counter(ii.file_owner(rec, meta) for meta in rec["files"].values())
    assert owners == {fk(GRASSHOPPER): 35, fk(AUSTIN): 38}
    assert rec["cornea_id"] == GRASSHOPPER["cornea_id"]
    assert rec["bound"] == {"uid": "2026-ORMHF-000688", "name": "grasshopper", "method": "unit_id"}
    assert rec["rebound_from"] == [{"cornea_id": AUSTIN["cornea_id"], "uid": "2026-ORMHF-000863",
                                    "name": "austin", "method": "unit_id", "at": NOW,
                                    "source": "sync"}]
    assert (rec["fire_slug"], rec["storage_prefix"]) == ("austin", "austin")


def test_same_fire_rematch_keeps_the_strongest_method():
    w = ii.weakens
    assert w("unit_id", "name_exact") and w("name_exact", "name_fuzzy")
    assert not w("name_exact", "unit_id") and not w("unit_id", "unit_id")
    assert not w("override", "name_exact")  # the override was removed
    assert not w(None, "name_fuzzy")        # no binding to weaken (ignored)

    # 2026_Grasshopper name-bound to Austin, then carrying Austin's token
    # ('same'): bound by ID from then on. A later unit-to-unit rebind weighs
    # its Austin-named sheet by name, so the stamp is evidence and stays.
    named = "products/20260820/Ops_Austin_0820.pdf"
    plain = "products/20260820/Transport_0820.pdf"
    rec = _rec(AUSTIN, "name_exact", [named, plain])
    m = match("unit_id", AUSTIN)
    assert ii.rebind_decision(rec, m) == "same"
    ii.apply_bind(rec, m, AUSTIN, NOW, inc_key=GRASSHOPPER_KEY)
    assert rec["bound"] == ii.bound_info(AUSTIN, "unit_id")
    rec["match"] = {"method": "unit_id"}  # what the mirror then records
    ii.apply_bind(rec, match("unit_id", GRASSHOPPER), GRASSHOPPER, NOW, inc_key=GRASSHOPPER_KEY)
    assert {r: (meta.get("fk"), meta.get("fk_src")) for r, meta in rec["files"].items()} == {
        named: (fk(AUSTIN), "name"), plain: (fk(AUSTIN), "prior")}

    # a weaker re-match keeps an ID binding's evidence, and mends a bound
    # that lags its match
    rec = _rec(AUSTIN, "unit_id", [named], bound=ii.bound_info(AUSTIN, "name_exact"))
    ii.apply_bind(rec, match("name_exact", AUSTIN), AUSTIN, NOW, inc_key=GRASSHOPPER_KEY)
    assert rec["bound"] == ii.bound_info(AUSTIN, "unit_id")


def test_name_to_unit_rebind_unproven_files_follow_new(names):
    rec = _rec(CHERRY_ID, "name_exact", names["cherry"], slug="cherry")
    m = match("unit_id", IRON)
    assert ii.rebind_decision(rec, m) == "rebind"
    assert ii.apply_bind(rec, m, IRON, NOW, inc_key=CHERRY_KEY) == fk(CHERRY_ID)
    # no file carries Cherry ID's own token, so nothing is stamped to it
    assert _stamps(rec) == {("unstamped", None): 26}
    assert {ii.file_owner(rec, meta) for meta in rec["files"].values()} == {fk(IRON)}


def test_unit_to_name_rebind_refused():
    rec = _rec(GRASSHOPPER, "unit_id", ["products/20261003/Ops_Grasshopper_1003.pdf"])
    before = json.dumps(rec, sort_keys=True)
    m = match("name_exact", AUSTIN)
    assert ii.rebind_decision(rec, m) == "refuse"
    with pytest.raises(ValueError):
        ii.apply_bind(rec, m, AUSTIN, NOW, inc_key=GRASSHOPPER_KEY)
    assert json.dumps(rec, sort_keys=True) == before


def test_bind_after_detach_hides_unproven(names):
    # detached by the date check (match None); the folder now matches Bobcat Lakes
    rels = names["bobcatlakes_under_bobcat_lakes"][:5] + names["bobcatlakes_own"][:5]
    rec = _rec(SAND_CREEK, "name_exact", rels, match=None,
               match_rejected={"cornea_id": SAND_CREEK["cornea_id"], "method": "name_exact",
                               "reason": "newest upload …", "at": NOW})
    m = match("unit_id", BOBCAT_LAKES)
    assert ii.rebind_decision(rec, m) == "bind"
    assert ii.apply_bind(rec, m, BOBCAT_LAKES, NOW, inc_key=BOBCAT_KEY) is None
    stamps = {rel: (meta.get("fk", "unstamped"), meta.get("fk_src")) for rel, meta in rec["files"].items()}
    for rel in rels[:5]:  # Bobcat Lakes' own token: follow the new binding
        assert stamps[rel] == ("unstamped", None)
    for rel in rels[5:]:  # Sand Creek sheets: nothing proves Bobcat Lakes, so hidden
        assert stamps[rel] == (None, "hidden")
    rec["match"] = {"method": "unit_id"}  # what the mirror then records
    assert Counter(ii.file_owner(rec, meta) for meta in rec["files"].values()) == \
        {fk(BOBCAT_LAKES): 5, None: 5}
    assert "match_rejected" not in rec
    assert rec["rebound_from"][0]["cornea_id"] == SAND_CREEK["cornea_id"]

    # an unresolved record binds the same way, with no history to record
    unresolved = _rec(SAND_CREEK, "unit_id", rels[5:], cornea_id=None, match=None, bound=None,
                      id_unresolved={"reason": "uncorroborated"})
    ii.apply_bind(unresolved, m, BOBCAT_LAKES, NOW, inc_key=BOBCAT_KEY)
    assert _stamps(unresolved) == {(None, "hidden"): 5}
    assert "id_unresolved" not in unresolved and "rebound_from" not in unresolved


def test_override_keeps_evidence_stamps_clears_rest(names):
    files = {
        "products/20260925/Ops_ArchE_Port_20260924_2018_Austin_ORMHF000863_0925_Day.pdf":
            {"fk": fk(AUSTIN), "fk_src": "token"},
        "products/20260820/Ops_Austin_0820.pdf": {"fk": fk(AUSTIN), "fk_src": "name"},
        "products/20260820/Ops_Grasshopper_0820.pdf": {"fk": fk(GRASSHOPPER), "fk_src": "name"},
        "ir/20260817/20260817_Mitchell_IR_11x17_Topo.pdf": {"fk": fk(AUSTIN), "fk_src": "location"},
        "products/20260820/prog_Austin_0819.pdf": {"fk": "7f8205dd-40b8-4abd-ab53-2c4a87394b87",
                                                   "fk_src": "manual"},
        "products/20260817/old.pdf": {"fk": fk(AUSTIN), "fk_src": "prior"},
        "products/20260817/junk.pdf": {"fk": None, "fk_src": "hidden"},
        "products/20261003/Trans_1003_day.pdf": {},
    }
    rec = _rec(GRASSHOPPER, "unit_id", [], slug="grasshopper")
    rec["files"] = {rel: dict(meta, sha16="ab") for rel, meta in files.items()}
    m = match("override", AUSTIN)
    assert ii.rebind_decision(rec, m) == "rebind"
    ii.apply_bind(rec, m, AUSTIN, NOW, inc_key=GRASSHOPPER_KEY)
    for rel, meta in files.items():
        if meta.get("fk_src") in ii.EVIDENCE_SRC:
            assert rec["files"][rel] == dict(meta, sha16="ab")
        else:
            assert "fk" not in rec["files"][rel] and "fk_src" not in rec["files"][rel]
    rec["match"] = {"method": "override"}
    owners = Counter(ii.file_owner(rec, meta) for meta in rec["files"].values())
    assert owners == {fk(AUSTIN): 6, fk(GRASSHOPPER): 1, "7f8205dd-40b8-4abd-ab53-2c4a87394b87": 1}
    assert rec["override"] == AUSTIN["cornea_id"] and rec["bound"]["method"] == "override"

    # an override of unresolved Cherry to Iron shows all 26 files on Iron
    cherry = _rec(CHERRY_ID, "name_exact", names["cherry"], cornea_id=None, match=None,
                  id_unresolved={"reason": "date"})
    assert ii.rebind_decision(cherry, match("override", IRON)) == "bind"
    ii.apply_bind(cherry, match("override", IRON), IRON, NOW, inc_key=CHERRY_KEY)
    cherry["match"] = {"method": "override"}
    assert Counter(ii.file_owner(cherry, meta) for meta in cherry["files"].values()) == {fk(IRON): 26}


def test_unignore_same_fire_same_other_fire_fresh():
    def ignored():
        rec = _rec(GRASSHOPPER, "unit_id", ["products/20261003/Ops_1003.pdf",
                                            "products/20260820/Ops_Austin_0820.pdf"],
                   match=None, ignored=True, override="ignore")
        rec["files"]["products/20260820/Ops_Austin_0820.pdf"].update(fk=fk(AUSTIN), fk_src="name")
        return rec

    rec = ignored()
    assert ii.prior_owner(rec) is None
    stamps = _stamps(rec)
    m = match("unit_id", GRASSHOPPER)
    assert ii.rebind_decision(rec, m) == "same"
    assert ii.apply_bind(rec, m, GRASSHOPPER, NOW, inc_key=GRASSHOPPER_KEY) is None
    assert "ignored" not in rec and "override" not in rec and "rebound_from" not in rec
    assert _stamps(rec) == stamps and rec["cornea_id"] == GRASSHOPPER["cornea_id"]
    rec["match"] = {"method": "unit_id"}  # the mirror restores the match
    assert ii.contributors({"incidents": {GRASSHOPPER_KEY: rec}}) == {
        fk(GRASSHOPPER): {GRASSHOPPER_KEY}, fk(AUSTIN): {GRASSHOPPER_KEY}}

    rec = ignored()
    m = match("unit_id", AUSTIN)
    assert ii.rebind_decision(rec, m) == "fresh"
    ii.apply_bind(rec, m, AUSTIN, NOW, inc_key=GRASSHOPPER_KEY)
    assert _stamps(rec) == stamps  # matched as if new: nothing stamped
    assert rec["cornea_id"] == AUSTIN["cornea_id"] and rec["bound"]["uid"] == "2026-ORMHF-000863"
    assert "ignored" not in rec and "override" not in rec
    assert [e["cornea_id"] for e in rec["rebound_from"]] == [GRASSHOPPER["cornea_id"]]


def test_new_revision_drops_non_evidence_stamp():
    for src in ("location", "prior", "hidden"):
        meta = {"sha16": "aa", "fk": None if src == "hidden" else fk(AUSTIN), "fk_src": src}
        assert ii.revision_stamp(meta, "bb") == {}
        assert ii.revision_stamp(meta, "aa") == {"fk": meta["fk"], "fk_src": src}
    for src in ("token", "name", "manual"):
        meta = {"sha16": "aa", "fk": fk(AUSTIN), "fk_src": src}
        assert ii.revision_stamp(meta, "bb") == {"fk": fk(AUSTIN), "fk_src": src}
    assert ii.revision_stamp({"sha16": "aa"}, "bb") == {}
    assert ii.revision_stamp({}, "bb") == {}


# ---------------------------------------------------------------------------
# contributors
# ---------------------------------------------------------------------------

def test_contributors_include_bound_empty_record():
    sawmill = _rec(SAWMILL_ID, "name_exact", [], slug="sawmill")  # 0 files
    mt = _rec(TWIN_SISTERS_MT, "unit_id", ["products/20260805/ops.pdf"], slug="twin-sisters")
    wa = _rec(TWIN_SISTERS_WA, "name_exact", ["products/20260617/brief.pdf"],
              slug="twin-sisters-3c1f0a")
    gone = _rec(GRASSHOPPER, "unit_id", ["products/20260820/Ops_Austin_0820.pdf"])
    gone["files"]["products/20260820/Ops_Austin_0820.pdf"].update(fk=fk(AUSTIN), fk_src="name")
    state = {"incidents": {"great_basin/2026/2026_Sawmill": sawmill,
                           "n_rockies/2026/2026_TwinSisters": mt,
                           "pacific_nw/2026/2026_TwinSisters": wa,
                           GRASSHOPPER_KEY: gone}}
    assert ii.contributors(state) == {
        fk(SAWMILL_ID): {"great_basin/2026/2026_Sawmill"},
        fk(TWIN_SISTERS_MT): {"n_rockies/2026/2026_TwinSisters"},
        fk(TWIN_SISTERS_WA): {"pacific_nw/2026/2026_TwinSisters"},
        # every file of the folder is stamped away; it still feeds its binding
        fk(GRASSHOPPER): {GRASSHOPPER_KEY},
        fk(AUSTIN): {GRASSHOPPER_KEY},
    }
    assert ii.owners_of(gone) == {fk(GRASSHOPPER), fk(AUSTIN)}
    assert ii.owners_of(sawmill) == {fk(SAWMILL_ID)}


def test_null_stamp_hides_file():
    rec = _rec(GRASSHOPPER, "unit_id", ["ir/20260817/20260817_TheNarrows_IR_11x17_Topo.pdf"])
    meta = rec["files"]["ir/20260817/20260817_TheNarrows_IR_11x17_Topo.pdf"]
    assert ii.file_owner(rec, meta) == fk(GRASSHOPPER)
    meta.update(fk=None, fk_src="hidden")
    assert ii.file_owner(rec, meta) is None
    assert ii.owners_of(rec) == {fk(GRASSHOPPER)}


def test_unresolved_ignored_pruned_contribute_nothing():
    stamped = {"products/20260820/Ops_Austin_0820.pdf": {"sha16": "aa", "fk": fk(AUSTIN),
                                                          "fk_src": "name"},
               "products/20261003/Ops_1003.pdf": {"sha16": "bb"}}
    unresolved = {"fire_slug": "cherry", "cornea_id": None, "match": None,
                  "id_unresolved": {"reason": "date"}, "files": json.loads(json.dumps(stamped))}
    ignored = _rec(GRASSHOPPER, "unit_id", [], match=None, ignored=True, override="ignore")
    ignored["files"] = json.loads(json.dumps(stamped))
    detached = _rec(SAND_CREEK, "name_exact", ["products/x.pdf"], match=None)
    never = {"fire_slug": "elk", "match": {"method": "unit_id"}, "files": {"a.pdf": {}}}
    pruned = _rec(BEAR_TRAP, "unit_id", ["products/20260801/ops.pdf"])
    pruned["files"]["products/20260801/ops.pdf"]["pruned_at"] = NOW
    for rec in (unresolved, ignored, detached, never):
        assert ii.prior_owner(rec) is None
        assert {ii.file_owner(rec, m) for m in rec["files"].values()} == {None}
    assert ii.file_owner(pruned, pruned["files"]["products/20260801/ops.pdf"]) is None
    state = {"incidents": {"a": unresolved, "b": ignored, "c": detached, "d": never, "e": pruned}}
    assert ii.contributors(state) == {fk(BEAR_TRAP): {"e"}}  # bound, zero visible files


# ---------------------------------------------------------------------------
# the per-record date check
# ---------------------------------------------------------------------------

def test_own_newest_upload_skips_templates_and_union_counts():
    # SageCreek's only file is a GISS template: the folder is dated by its listing
    sage = {"fire_slug": "sage-creek", "match": {"method": "name_exact"},
            "dir_mtime": "2026-08-21 09:34", "children": {"IR": "2026-08-21 09:34",
                                                          "Products": "2026-08-20 11:00"},
            "latest_upload_ts": "2026-06-01T00:00:00Z",  # fire-wide merge: ignored
            "files": {"products/yymmdd/connection-auth-103.p12":
                      {"lm": "Thu, 16 Apr 2026 23:17:42 GMT"},
                      "products/YYMMDD/template_map.pdf": {"lm": "Thu, 16 Apr 2026 23:17:42 GMT"}}}
    assert ii.own_newest_upload(sage) == "2026-08-21 09:34"
    assert ii.record_predates_fire(sage, "name_exact", "2026-08-20T00:00:00Z") is None

    # Rock Canyon holds only June IR from an earlier fire, while the merged
    # stamps (another folder of Rocky Canyon UT) look current
    rock = {"fire_slug": "rocky-canyon", "dir_mtime": "2026-08-18 21:01",
            "latest_upload_ts": "2026-08-20T20:52:00Z", "latest_upload": "2026-08-20",
            "files": {
                "ir/20260622/20260622_Rock_Canyon_IR.kmz": {"lm": "Mon, 22 Jun 2026 05:15:04 GMT"},
                "ir/20260622/20260622_Rock_Canyon_IR_11x17_Topo.pdf":
                    {"lm": "Mon, 22 Jun 2026 05:15:04 GMT"},
                "ir/20260622/20260622_Rock_Canyon_IR.jpg": {"lm": "Thu, 20 Aug 2026 05:15:04 GMT"},
                "products/20260820/late.pdf": {"lm": "Thu, 20 Aug 2026 05:15:04 GMT",
                                               "pruned_at": NOW},
                "products/20260601/no_lm.pdf": {"first_seen": "2026-06-02T00:00:00Z"}}}
    assert ii.own_newest_upload(rock) == "2026-06-22T05:15:04Z"
    reason = ii.record_predates_fire(rock, "name_fuzzy", "2026-08-16T00:00:00Z")
    assert reason == ("newest upload 2026-06-22T05:15:04Z is more than 7 days before the fire "
                      "was created (2026-08-16T00:00:00Z)")
    assert ii.record_predates_fire(rock, "unit_id", "2026-08-16T00:00:00Z") is None
    assert ii.record_predates_fire(rock, "override", "2026-08-16T00:00:00Z") is None
    assert ii.record_predates_fire(rock, "name_exact", None) is None  # flagged by the caller
    assert ii.own_newest_upload({"files": {}}) is None


# ---------------------------------------------------------------------------
# IR source choice
# ---------------------------------------------------------------------------

ACTIVE = {"beartrap", "thumb", "sioux", "camp", "grasshopper", "austin", "thenarrows", "mitchell"}


def test_choose_ir_source_mixed_folder_hides(names):
    bt = _rec(BEAR_TRAP, "unit_id", names["beartrap_ir"], slug="bear-trap")
    choose = lambda rec, d, owner, name: ii.choose_ir_source(rec, d, owner, name, ACTIVE)  # noqa: E731
    # the complex's folder carries Bear Trap's flight next to Sioux's and Thumb's
    assert choose(bt, "ir/20260817", fk(BEAR_TRAP), "beartrap") == \
        ("ir/20260817/20260817_c0700_Bear_Trap_Aircraft3_Shapefiles.zip", False)
    assert choose(bt, "ir/20260806", fk(BEAR_TRAP), "beartrap") == \
        ("ir/20260806/20260806_BearTrap_Thumb_Wolfpack_IR.kmz", False)
    # flights of other fires only: no vectors rather than Thumb's on Bear Trap
    assert choose(bt, "ir/20260805", fk(BEAR_TRAP), "beartrap") == (None, True)
    assert choose(bt, "ir/20260804", fk(BEAR_TRAP), "beartrap") == (None, True)

    # 2026_Grasshopper's 08-17 folder (under austin/) after the ownership split
    gh = _rec(GRASSHOPPER, "unit_id", [r for r in names["grasshopper_under_austin"]
                                       if r.startswith("ir/20260817/")])
    for rel, meta in gh["files"].items():
        if "Austin" in rel:
            meta.update(fk=fk(AUSTIN), fk_src="name")
        elif "Mitchell" in rel or "TheNarrows" in rel:
            meta.update(fk=fk(AUSTIN), fk_src="location")
    assert choose(gh, "ir/20260817", fk(GRASSHOPPER), "grasshopper") == \
        ("ir/20260817/20260817_Grasshopper_IR.kmz", False)
    assert choose(gh, "ir/20260817", fk(AUSTIN), "austin") == (None, False)  # PDF only

    # a source naming the owner is preferred over an earlier one in state order
    f29 = ["ir/20260929/20260929_The_Narrows_IR.kmz", "ir/20260929/20260929_Austin_IR.kmz",
           "ir/20260929/20260929_Grasshopper_IR.kmz", "ir/20260929/20260929_Grasshopper_IR_11x17_Topo.pdf"]
    g29 = _rec(GRASSHOPPER, "unit_id", f29)
    g29["files"]["ir/20260929/20260929_Austin_IR.kmz"].update(fk=fk(AUSTIN), fk_src="name")
    assert choose(g29, "ir/20260929", fk(GRASSHOPPER), "grasshopper") == \
        ("ir/20260929/20260929_Grasshopper_IR.kmz", False)
    assert choose(g29, "ir/20260929", fk(AUSTIN), "austin") == \
        ("ir/20260929/20260929_Austin_IR.kmz", False)

    # an anonymous source is used unless the folder names another fire; a fire
    # the folder was once bound to counts even when it is no longer active
    anon = _rec(GRASSHOPPER, "unit_id", ["ir/20260930/20260930_IR.kmz",
                                         "ir/20260930/20260930_IR_Topo.pdf"])
    assert choose(anon, "ir/20260930", fk(GRASSHOPPER), "grasshopper") == \
        ("ir/20260930/20260930_IR.kmz", False)
    anon["files"]["ir/20260930/20260930_Lookout_IR_Topo.pdf"] = {"sha16": "cc"}
    anon["rebound_from"] = [{"cornea_id": "{X}", "name": "lookout", "uid": None,
                             "method": "unit_id", "at": NOW, "source": "sync"}]
    assert choose(anon, "ir/20260930", fk(GRASSHOPPER), "grasshopper") == (None, True)
    # an empty or non-flight folder has no source and is not mixed
    assert choose(anon, "ir/20261001", fk(GRASSHOPPER), "grasshopper") == (None, False)
