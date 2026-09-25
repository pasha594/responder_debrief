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

from responder_worker import config, pmtiles_inspect, trails
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
        row = dict(self.ROW, PLAN_ALLOW_MODE_TRNSPRT="MTC_ATV_SHARED",
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


NOW = datetime(2026, 9, 25, 12, tzinfo=timezone.utc)
SIG = {"usfs": {"etag": '"a"', "last_modified": "Wed, 23 Sep 2026 13:34:02 GMT", "bytes": 1},
       "blm_managed": {"count": 3, "max_edit": 1758475680000},
       "blm_not_assessed": {"count": 1, "max_edit": 1758475680000},
       "nps": {"count": 2, "max_edit": 1758564695000}}


class TestDecide:
    def test_first_and_forced(self):
        assert trails.decide(SIG, None, NOW, False) == (True, "first_build")
        assert trails.decide(SIG, {"build_id": "x", "built_at": "2026-09-24T00:00:00Z",
                                   "signature": SIG}, NOW, True) == (True, "forced")

    def test_weekly_cadence(self):
        prev = {"build_id": "x", "built_at": "2026-09-22T00:00:00Z",
                "signature": dict(SIG, nps={"count": 1, "max_edit": 1})}
        assert trails.decide(SIG, prev, NOW, False) == (False, "deferred_weekly")
        prev["built_at"] = "2026-09-18T00:00:00Z"
        assert trails.decide(SIG, prev, NOW, False) == (True, "changed")
        same = dict(prev, signature=SIG)
        assert trails.decide(SIG, same, NOW, False) == (False, "unchanged")
        same["built_at"] = "2026-08-20T00:00:00Z"
        assert trails.decide(SIG, same, NOW, False) == (True, "max_age")

    def test_build_id_and_dates(self):
        bid = trails.build_id_for(SIG, NOW)
        assert bid.startswith("20260925-") and len(bid) == 17
        assert bid == trails.build_id_for(json.loads(json.dumps(SIG)), NOW)
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
        fetchers = {"usfs": lambda: usfs, "blm_managed": lambda: blm,
                    "blm_not_assessed": lambda: blmn, "nps": lambda: nps}
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
        health = storage.get_json("catalogs/health/trails.json")
        assert health["last_run"]["build_id"] == bid and health["last_failure"] is None
        # second run: unchanged signature, recent build -> no-op
        again = trails.sync(None, storage, workdir=tmp_path / "work2", fetchers=fetchers,
                            sig=SIG, now=NOW, log=lambda *_: None)
        assert not again["built"] and again["reason"] == "unchanged"

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
