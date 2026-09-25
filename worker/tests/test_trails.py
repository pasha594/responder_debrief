"""Trails ingest: normalizers, change detection, sanity gate, and an
end-to-end sync on local sources through the real GDAL 3.8.4 writers.

The attribute values below are the live domains recorded on 2026-09-24 in
docs/trails-routing/codebase-map/data-api-facts.md (USFS ALLOWED_TERRA_USE
'54321' / 'N/A', restriction windows with trailing spaces, BLM mixed-case
codes, NPS 'Class 3' / pipe-delimited TRLUSE / Decommissioned). The session
that wrote these had no network access to the agency services, so rows are
reconstructed from those recorded values rather than freshly captured.
"""

import json
import shutil
from datetime import datetime, timezone

import pytest

from responder_worker import config, gdal_cli, pmtiles_inspect, trails
from responder_worker import trails_normalize as tn
from responder_worker.b2 import DryRunStorage

needs_gdal = pytest.mark.skipif(shutil.which("ogr2ogr") is None, reason="GDAL not installed")


class TestNames:
    @pytest.mark.parametrize("raw,want", [
        ("IRON CREEK-STANLEY LAKE", "Iron Creek-Stanley Lake"),
        ("  ALPINE   WAY ", "Alpine Way"),
        ("NF 619 SPUR", "NF 619 Spur"),
        ("LAKE OF THE WOODS", "Lake of the Woods"),
        ("O'BRIEN CREEK", "O'brien Creek"),
        ("Mixed Case Kept", "Mixed Case Kept"),
        ("", None), (None, None), ("N/A", None), ("UNNAMED", None),
        # live, 2026-09-25
        ("PCT: GLACIER PEAK WILDERNESS", "PCT: Glacier Peak Wilderness"),
        ("  <Null>", None), ("\bD & H Canal Trail", "D & H Canal Trail"),
    ])
    def test_tidy_name(self, raw, want):
        assert tn.tidy_name(raw) == want


class TestUsfs:
    ROW = {"TRAIL_CN": "123456010343", "BMP": 0, "TRAIL_NO": "640 ",
           "TRAIL_NAME": "IRON CREEK-STANLEY LAKE", "TRAIL_CLASS": "3",
           "ALLOWED_TERRA_USE": "54321", "HIKER_PEDESTRIAN_MANAGED": "05/15-09/15 ",
           "HIKER_PEDESTRIAN_RESTRICTED": None,
           "SPECIAL_MGMT_AREA": "SAWTOOTH WILDERNESS", "NATIONAL_TRAIL_DESIGNATION": "1"}

    def test_full_row(self):
        r = tn.normalize_usfs(self.ROW, "2026-09-23")
        assert r == {"tid": "usfs:123456010343:0.000", "agency": "USFS",
                     "name": "Iron Creek-Stanley Lake", "num": "640", "cls": 3,
                     "uses": "H,P,B,M,A", "foot": "yes", "restr": None,
                     "season": "05/15–09/15", "status": "open", "mgmt": "Wilderness",
                     "unit": None, "src_date": "2026-09-23"}
        assert list(r) == tn.FIELDS

    @pytest.mark.parametrize("code,uses,foot", [
        ("321", "H,P,B", "yes"), ("21", "H,P", "yes"), ("654321", "H,P,B,M,A,4", "yes"),
        ("3", "B", "no"), ("54", "M,A", "no"), ("N/A", "", "unknown"), (None, "", "unknown"),
    ])
    def test_uses(self, code, uses, foot):
        assert tn.usfs_uses(code) == (uses, foot)

    def test_restrictions_shown_not_dropped(self):
        row = dict(self.ROW, ALLOWED_TERRA_USE="3", HIKER_PEDESTRIAN_RESTRICTED="01/01-12/31 ",
                   TRAIL_CLASS="N", NATIONAL_TRAIL_DESIGNATION="3", SPECIAL_MGMT_AREA=None)
        r = tn.normalize_usfs(row, "2026-09-23")
        assert r["restr"] == "Hiker restricted 01/01–12/31; Hiking not listed as an allowed use"
        assert r["cls"] == 0 and r["foot"] == "no"
        assert r["mgmt"] == "National Scenic/Historic Trail"

    def test_missing_cn_dropped(self):
        assert tn.normalize_usfs(dict(self.ROW, TRAIL_CN=" "), "d") is None


class TestBlm:
    ROW = {"OBJECTID": 42, "ROUTE_PRMRY_NM": "WILD HORSE LOOP", "ADMIN_ST": "or",
           "PLAN_ALLOW_MODE_TRNSPRT": "NON_MOTO_SHARED", "PLAN_ACCESS_RSTRCT": "NONE",
           "PLAN_SEASON_RSTRCT_CODE": None, "OBSRVE_ROUTE_USE_CLASS": "NON-MOTORIZED",
           "ROUTE_SPCL_DSGNTN_TYPE": None}

    def test_managed(self):
        r = tn.normalize_blm(self.ROW, "managed", "2026-09-21")
        assert r["tid"] == "blm:m42" and r["unit"] == "BLM OR"
        assert (r["uses"], r["foot"], r["restr"], r["status"]) == ("H,P,B", "yes", None, "open")

    def test_not_assessed_and_admin_only(self):
        row = dict(self.ROW, PLAN_ALLOW_MODE_TRNSPRT="MTC_ATV_ONLY",
                   PLAN_ACCESS_RSTRCT="admin only", ROUTE_PRMRY_NM="")
        r = tn.normalize_blm(row, "not_assessed", "2026-09-21")
        assert r["tid"] == "blm:n42" and r["status"] == "not_assessed"
        assert r["restr"] == "Admin only (agency/fire use)"
        assert (r["uses"], r["foot"], r["name"]) == ("M,A", "unknown", None)

    def test_case_and_slash_variants(self):
        row = dict(self.ROW, PLAN_ACCESS_RSTRCT="Authorized / Permitted User Only",
                   OBSRVE_ROUTE_USE_CLASS="impassable", PLAN_ALLOW_MODE_TRNSPRT="UNK")
        r = tn.normalize_blm(row, "managed", "d")
        assert r["restr"] == "Authorized/permitted users only; Observed impassable"
        assert (r["uses"], r["foot"]) == ("", "unknown")


class TestNps:
    ROW = {"OBJECTID": 7, "TRLNAME": "", "MAPLABEL": "Mist Trail", "TRLSTATUS": "Existing",
           "TRLTYPE": "Standard Terra Trail", "TRLCLASS": "Class 3",
           "TRLUSE": "HIKER/PEDESTRIAN|HORSE", "TRLFEATTYPE": "Designated Trail",
           "SEASONAL": "No", "UNITNAME": "Yosemite National Park",
           "EDITDATE": 1758564695000, "PUBLICDISPLAY": "Public Map Display",
           "DATAACCESS": "Unrestricted"}

    def test_row(self):
        r = tn.normalize_nps(self.ROW, "2026-09-22")
        assert r["name"] == "Mist Trail" and r["cls"] == 3
        assert (r["uses"], r["foot"]) == ("H,P", "yes")
        assert r["src_date"] == "2025-09-22"
        assert r["unit"] == "Yosemite National Park" and r["status"] == "open"

    @pytest.mark.parametrize("patch", [
        {"TRLSTATUS": "Decommissioned"}, {"TRLSTATUS": "Proposed"}, {"TRLSTATUS": "Abandoned"},
        {"TRLTYPE": "Water Trail"}, {"TRLTYPE": "Ferry Route"},
        {"PUBLICDISPLAY": "No Public Map Display"},
    ])
    def test_drop_rules(self, patch):
        assert tn.normalize_nps(dict(self.ROW, **patch), "d") is None

    def test_closed_unofficial_seasonal(self):
        r = tn.normalize_nps(dict(self.ROW, TRLSTATUS="Temporarily Closed", SEASONAL="Yes",
                                  SEASDESC="Closed in winter", TRLUSE="UNKNOWN",
                                  TRLCLASS="Unknown", EDITDATE=None), "2026-09-22")
        assert (r["status"], r["restr"], r["season"]) == ("closed", "Temporarily closed",
                                                          "Closed in winter")
        assert (r["cls"], r["uses"], r["src_date"]) == (0, "", "2026-09-22")
        r2 = tn.normalize_nps(dict(self.ROW, TRLFEATTYPE="Unofficial Trail"), "d")
        assert r2["status"] == "unofficial"

    @pytest.mark.parametrize("trluse,uses", [
        ("Hiker/Pedestrian|All-Terrain Vehicle|Four-Wheel Drive Vehicle > 50” in Tread Width",
         "H,A,4"),
        ("Hiking & Biking", "H,B"),
        ("Hike | PackOrSaddle", "H,P"),
    ])
    def test_live_trluse_spellings(self, trluse, uses):
        assert tn.nps_uses(trluse)[0] == uses


class TestLiveRows:
    """Rows exactly as the live services returned them on 2026-09-25 (the
    spot check of the first real-data build), with what the popup and Walk
    notes should get. USFS rows come from the EDW REST layer (field names
    upper-cased to match the FGDB we ingest)."""

    def test_usfs_centerline_na_row(self):
        # the PCT through the SISI fire area: a TrailNFS_Centerline record,
        # every use/area attribute 'N/A' (4,520 such TERRA rows). The name is
        # the agency's own section name, not a normalization artifact.
        raw = {"TRAIL_CN": "5064.005511", "BMP": 267.2, "TRAIL_NO": "2000",
               "TRAIL_NAME": "PCT: GLACIER PEAK WILDERNESS", "TRAIL_CLASS": "N",
               "ALLOWED_TERRA_USE": "N/A", "HIKER_PEDESTRIAN_MANAGED": "N/A",
               "HIKER_PEDESTRIAN_RESTRICTED": "N/A", "SPECIAL_MGMT_AREA": "N/A",
               "NATIONAL_TRAIL_DESIGNATION": 0, "TERRA_BASE_SYMBOLOGY": "TC3",
               "ADMIN_ORG": "061702"}
        r = tn.normalize_usfs(raw, "2026-09-23")
        assert r["name"] == "PCT: Glacier Peak Wilderness" and r["num"] == "2000"
        # class from the TC3 symbol band; uses are not published anywhere
        assert (r["cls"], r["uses"], r["foot"]) == (3, "", "unknown")
        assert (r["restr"], r["season"], r["mgmt"]) == (None, None, None)
        assert r["unit"] == "Okanogan-Wenatchee National Forest"
        # Company Creek #1243, same fire: the TC1-2 band doesn't say which class
        cc = dict(raw, TRAIL_CN="8334.004574", BMP=0, TRAIL_NO="1243",
                  TRAIL_NAME="COMPANY CREEK", TERRA_BASE_SYMBOLOGY="TC1-2")
        assert tn.normalize_usfs(cc, "d")["cls"] == 0

    @pytest.mark.parametrize("cls,sym,want", [
        ("2", "TC1-2", 2), ("5", "TC4-5", 5), ("N", "TC3", 3), ("N", "TC4-5", 0),
        ("N", None, 0), (None, "tc3 ", 3),
    ])
    def test_usfs_class(self, cls, sym, want):
        assert tn.usfs_class(cls, sym) == want

    @pytest.mark.parametrize("org,unit", [
        ("061702", "Okanogan-Wenatchee National Forest"), ("0402", "Boise National Forest"),
        ("01", None), (None, None), ("", None), ("999901", None),
    ])
    def test_usfs_unit(self, org, unit):
        assert tn.usfs_unit(org) == unit

    def test_usfs_wsa_and_nrt(self):
        wsa = {"TRAIL_CN": "3446010337", "BMP": 6.0, "TRAIL_NO": "809.4A",
               "TRAIL_NAME": "EAST DUNOIR TRAIL", "TRAIL_CLASS": "1", "ALLOWED_TERRA_USE": "21",
               "HIKER_PEDESTRIAN_MANAGED": None, "HIKER_PEDESTRIAN_RESTRICTED": None,
               "SPECIAL_MGMT_AREA": "WSA - WILDERNESS STUDY AREA", "NATIONAL_TRAIL_DESIGNATION": 1}
        assert tn.normalize_usfs(wsa, "d")["mgmt"] == "Wilderness Study Area"
        nrt = {"TRAIL_CN": "5012.008161", "BMP": 1.3949, "TRAIL_NO": "52706",
               "TRAIL_NAME": "DEER MOUNTAIN NATIONAL RECREAT", "TRAIL_CLASS": "3",
               "ALLOWED_TERRA_USE": "321", "HIKER_PEDESTRIAN_MANAGED": "05/15-09/15",
               "HIKER_PEDESTRIAN_RESTRICTED": None, "SPECIAL_MGMT_AREA": None,
               "NATIONAL_TRAIL_DESIGNATION": 2}
        r = tn.normalize_usfs(nrt, "d")
        assert (r["mgmt"], r["season"], r["restr"]) == ("National Recreation Trail",
                                                        "05/15–09/15", None)

    def test_blm_domain_codes(self):
        tab = {"OBJECTID": 13451, "ROUTE_PRMRY_NM": "Tabeguache Trail", "ADMIN_ST": "CO",
               "PLAN_ALLOW_MODE_TRNSPRT": "MTC_ATV_SHARED", "PLAN_ACCESS_RSTRCT": "None",
               "PLAN_SEASON_RSTRCT_CODE": "NO", "OBSRVE_ROUTE_USE_CLASS": "ATV",
               "ROUTE_SPCL_DSGNTN_TYPE": "NRT"}
        r = tn.normalize_blm(tab, "managed", "2026-09-21")
        assert (r["uses"], r["foot"]) == ("H,P,B,M,A", "yes")
        assert (r["season"], r["mgmt"], r["restr"]) == (None, "National Recreation Trail", None)
        grand = {"OBJECTID": 14264, "ROUTE_PRMRY_NM": "Grandview Ridge Trail", "ADMIN_ST": "CO",
                 "PLAN_ALLOW_MODE_TRNSPRT": "NON_MOTO_SHARED", "PLAN_ACCESS_RSTRCT": "None",
                 "PLAN_SEASON_RSTRCT_CODE": "YES", "OBSRVE_ROUTE_USE_CLASS": "Non-Motorized",
                 "ROUTE_SPCL_DSGNTN_TYPE": None}
        assert tn.normalize_blm(grand, "managed", "d")["season"] == "Seasonal restrictions"
        null = {"OBJECTID": 16968, "ROUTE_PRMRY_NM": "  <Null>", "ADMIN_ST": "UT",
                "PLAN_ALLOW_MODE_TRNSPRT": "MTC_SHARED", "PLAN_ACCESS_RSTRCT": "None",
                "PLAN_SEASON_RSTRCT_CODE": "NO", "OBSRVE_ROUTE_USE_CLASS": "Unknown",
                "ROUTE_SPCL_DSGNTN_TYPE": None}
        # MTC_SHARED's domain label is just 'Motorcycle Shared': no inferred hiker
        r = tn.normalize_blm(null, "managed", "d")
        assert (r["name"], r["uses"], r["foot"], r["season"]) == (None, "M", "unknown", None)
        r = tn.normalize_blm(dict(null, PLAN_ALLOW_MODE_TRNSPRT="STRT_LGL_VEH"), "managed", "d")
        assert (r["uses"], r["foot"]) == ("4", "unknown")
        nst = {"OBJECTID": 5107, "ROUTE_PRMRY_NM": "1591", "ADMIN_ST": "AZ",
               "PLAN_ALLOW_MODE_TRNSPRT": None, "PLAN_ACCESS_RSTRCT": None,
               "PLAN_SEASON_RSTRCT_CODE": None, "OBSRVE_ROUTE_USE_CLASS": "Stock",
               "ROUTE_SPCL_DSGNTN_TYPE": "NST"}
        r = tn.normalize_blm(nst, "not_assessed", "d")
        assert (r["mgmt"], r["uses"], r["season"]) == ("National Scenic Trail", "", None)
        assert tn.normalize_blm(dict(nst, ROUTE_SPCL_DSGNTN_TYPE="UNK"), "managed", "d")["mgmt"] is None


NOW = datetime(2026, 9, 25, 12, tzinfo=timezone.utc)
SIG = {"usfs": {"etag": '"a"', "last_modified": "Wed, 23 Sep 2026 13:34:02 GMT", "bytes": 1},
       "blm_managed": {"count": 3, "max_edit": 1758475680000},
       "blm_not_assessed": {"count": 1, "max_edit": 1758475680000},
       "nps": {"count": 2, "max_edit": 1758564695000}}


class TestDecide:
    def test_first_and_forced(self):
        assert trails.decide(SIG, None, NOW, False) == (True, "first_build")
        assert trails.decide(SIG, {"build_id": "x", "built_at": "2026-09-24T00:00:00Z",
                                   "recipe": config.TRAILS_RECIPE, "signature": SIG},
                             NOW, True) == (True, "forced")

    def test_recipe_change_rebuilds_now(self, monkeypatch):
        # same sources, built yesterday: only the recipe says the output is stale
        prev = {"build_id": "x", "built_at": "2026-09-24T00:00:00Z",
                "recipe": config.TRAILS_RECIPE, "signature": SIG}
        assert trails.decide(SIG, prev, NOW, False) == (False, "unchanged")
        monkeypatch.setattr(config, "TRAILS_RECIPE", config.TRAILS_RECIPE + 1)
        assert trails.decide(SIG, prev, NOW, False) == (True, "recipe")
        # state from before the recipe was recorded is recipe 1
        monkeypatch.setattr(config, "TRAILS_RECIPE", 2)
        old = {k: v for k, v in prev.items() if k != "recipe"}
        assert trails.decide(SIG, old, NOW, False) == (True, "recipe")
        monkeypatch.setattr(config, "TRAILS_RECIPE", 1)
        assert trails.decide(SIG, old, NOW, False) == (False, "unchanged")

    def test_weekly_cadence(self):
        prev = {"build_id": "x", "built_at": "2026-09-22T00:00:00Z",
                "recipe": config.TRAILS_RECIPE,
                "signature": dict(SIG, nps={"count": 1, "max_edit": 1})}
        assert trails.decide(SIG, prev, NOW, False) == (False, "deferred_weekly")
        prev["built_at"] = "2026-09-18T00:00:00Z"
        assert trails.decide(SIG, prev, NOW, False) == (True, "changed")
        same = dict(prev, signature=SIG)
        assert trails.decide(SIG, same, NOW, False) == (False, "unchanged")
        same["built_at"] = "2026-08-20T00:00:00Z"
        assert trails.decide(SIG, same, NOW, False) == (True, "max_age")

    def test_build_id_and_dates(self, monkeypatch):
        bid = trails.build_id_for(SIG, NOW)
        assert bid.startswith("20260925-") and len(bid) == 17
        assert bid == trails.build_id_for(json.loads(json.dumps(SIG)), NOW)
        monkeypatch.setattr(config, "TRAILS_RECIPE", config.TRAILS_RECIPE + 1)
        assert trails.build_id_for(SIG, NOW) != bid
        d = trails.source_dates(SIG)
        assert d["usfs"] == "2026-09-23" and d["blm_managed"] == "2025-09-21"


class TestSanity:
    def test_floors_and_drop(self):
        ok = {"usfs": 74867, "blm_managed": 19532, "blm_not_assessed": 5038, "nps": 31000}
        assert trails.sanity(ok, None) == []
        partial = dict(ok, usfs=34000)
        probs = trails.sanity(partial, ok)
        assert len(probs) == 1 and "usfs count 34000" in probs[0]
        assert trails.sanity(dict(ok, nps=27000), ok) != []  # >10% drop vs last


def _write_seq(path, feats):
    with open(path, "w") as f:
        for props, coords in feats:
            f.write(json.dumps({"type": "Feature", "properties": props,
                                "geometry": {"type": "MultiLineString", "coordinates": [coords]}}) + "\n")
    return path


@needs_gdal
class TestSyncEndToEnd:
    def test_dry_run_publishes_pointer_last(self, tmp_path, monkeypatch):
        monkeypatch.setattr(config, "TRAILS_COUNT_FLOORS",
                            {"usfs": 1, "blm_managed": 1, "blm_not_assessed": 1, "nps": 1})
        line = [[-115.0 + i * 0.002, 44.2 + i * 0.001] for i in range(30)]
        src = tmp_path / "src"
        src.mkdir()
        usfs = _write_seq(src / "usfs.geojsonl", [
            (TestUsfs.ROW, line),
            (dict(TestUsfs.ROW, TRAIL_CN="9", TRAIL_NAME="ALPINE WAY"), [[x + 0.01, y] for x, y in line]),
        ])
        # a null-geometry row, as 3,289 USFS TERRA rows are
        with open(usfs, "a") as f:
            f.write(json.dumps({"type": "Feature", "properties": dict(TestUsfs.ROW, TRAIL_CN="n"),
                                "geometry": None}) + "\n")
        blm = _write_seq(src / "blm_managed.geojsonl", [(TestBlm.ROW, [[x - 0.2, y] for x, y in line])])
        blmn = _write_seq(src / "blm_not_assessed.geojsonl",
                          [(dict(TestBlm.ROW, OBJECTID=5), [[x - 0.3, y] for x, y in line])])
        nps = _write_seq(src / "nps.geojsonl", [
            (TestNps.ROW, [[x, y - 0.2] for x, y in line]),
            (dict(TestNps.ROW, OBJECTID=8, TRLSTATUS="Decommissioned"), line),
            (dict(TestNps.ROW, OBJECTID=9), [[144.8, 13.4], [144.81, 13.41]]),  # Guam
        ])
        def fetched(p):  # sync deletes each download once normalized
            return lambda: shutil.copy(p, p.with_suffix(".fetched"))
        fetchers = {"usfs": fetched(usfs), "blm_managed": fetched(blm),
                    "blm_not_assessed": fetched(blmn), "nps": fetched(nps)}
        storage = DryRunStorage(tmp_path / "out")
        entry = trails.sync(None, storage, workdir=tmp_path / "work", fetchers=fetchers,
                            sig=SIG, now=NOW, log=lambda *_: None)
        assert entry["ok"] and entry["built"], entry
        assert entry["counts"] == {"usfs": 2, "blm_managed": 1, "blm_not_assessed": 1, "nps": 1}
        bid = entry["build_id"]
        written = storage.written
        assert written.index("catalogs/trails.json") > written.index(f"trails/b{bid}/trails.pmtiles")
        assert written.index("catalogs/trails.json") > written.index(f"trails/b{bid}/build.json")
        assert written[-1] == "catalogs/health/trails.json"
        ptr = storage.get_json("catalogs/trails.json")
        assert ptr["pmtiles"] == f"/trails/b{bid}/trails.pmtiles"
        assert (ptr["minzoom"], ptr["maxzoom"]) == (7, 13)
        s = pmtiles_inspect.summarize(tmp_path / "out" / f"trails/b{bid}/trails.pmtiles")
        assert s["sample_layers"] == ["trails"] and s["header"]["clustered"]
        fgb = gdal_cli.run(["ogrinfo", "-so", "-al", str(tmp_path / "out" / f"trails/b{bid}/trails.fgb")])
        assert "src_date: String" in fgb.stdout  # not GDAL's sniffed Date/DateTime
        health = storage.get_json("catalogs/health/trails.json")
        assert health["last_run"]["build_id"] == bid and health["last_failure"] is None
        # second run: unchanged signature, recent build -> no-op
        again = trails.sync(None, storage, workdir=tmp_path / "work2", fetchers=fetchers,
                            sig=SIG, now=NOW, log=lambda *_: None)
        assert not again["built"] and again["reason"] == "unchanged"
        # a normalizer fix (recipe bump) republishes on the next run, same sources
        assert storage.get_json("state/trails.json")["recipe"] == config.TRAILS_RECIPE
        monkeypatch.setattr(config, "TRAILS_RECIPE", config.TRAILS_RECIPE + 1)
        fixed = trails.sync(None, storage, workdir=tmp_path / "work3", fetchers=fetchers,
                            sig=SIG, now=NOW, log=lambda *_: None)
        assert fixed["built"] and fixed["reason"] == "recipe" and fixed["build_id"] != bid
        assert storage.get_json("catalogs/trails.json")["build_id"] == fixed["build_id"]
        assert storage.get_json(f"trails/b{fixed['build_id']}/build.json")["recipe"] == \
            config.TRAILS_RECIPE

    def test_sanity_failure_keeps_previous_build(self, tmp_path):
        line = [[-115.0, 44.2], [-115.01, 44.21]]
        f = _write_seq(tmp_path / "u.geojsonl", [(TestUsfs.ROW, line)])
        fetchers = {k: (lambda f=f: f) for k in trails.SOURCES}
        storage = DryRunStorage(tmp_path / "out")
        entry = trails.sync(None, storage, workdir=tmp_path / "w", fetchers=fetchers, sig=SIG,
                            now=NOW, log=lambda *_: None)
        assert not entry["ok"] and "sanity" in entry["note"]
        assert storage.get_json("catalogs/trails.json") is None
        assert storage.get_json("catalogs/health/trails.json")["last_failure"]["ok"] is False
