"""Incident manifests by fire ID: one manifest per fire, holding only the
files it owns from every folder feeding it, its index entry written only
after its PUT, and IR flights chosen per owner. All on migrated state."""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from incident_world import (
    AU_FK, AU_KEY, AUSTIN, GH_FK, GH_KEY, GRASSHOPPER, MT_KEY, NOW, TWIN_MT, TWIN_WA, WA_FK,
    WA_KEY, api_fire, dir_of, sha16,
)
from responder_worker import catalogs as cat, fire_manifests as fm, frames, geopdf, ir_vectors
from responder_worker.fires import fire_key
from responder_worker.incident_ids import DEFAULT_CONFIDENCE, bound_info
from responder_worker.mirror import MirroredFile, MirrorResult

MT_FK = fire_key(TWIN_MT["cornea_id"])
BEAR_TRAP = {"cornea_id": "{1BB1F12F-DB68-40B0-8D7B-FA0E4FCEE2E4}", "post_title": "Bear Trap",
             "unique_fire_id": "2026-MNSUF-002394", "state": "MN"}
THUMB = {"cornea_id": "{5E0A1B2C-0000-4000-8000-0000000000F1}", "post_title": "Thumb",
         "unique_fire_id": "2026-MNSUF-002401", "state": "MN"}
BT_KEY = "eastern/2026/2026_JulyLightningEvent"
BT_FK = fire_key(BEAR_TRAP["cornea_id"])


def _file(rel, **meta):
    entry = {"sha16": sha16(rel.encode()), "size": 10, "rev": 1,
             "kind": "ir" if rel.startswith("ir/") else "product",
             "lm": "Thu, 01 Oct 2026 05:05:56 GMT", "url": f"https://ftp/{rel}"}
    entry.update(meta)
    return entry


def _rec(fire, method, key, slug, rels=(), **extra):
    rec = {"fire_slug": slug, "storage_prefix": slug, "cornea_id": fire["cornea_id"],
           "match": {"method": method, "confidence": DEFAULT_CONFIDENCE[method],
                     "token": fire["unique_fire_id"] if method == "unit_id" else None,
                     "dir_url": dir_of(key)},
           "bound": bound_info(fire, method), "dir_url": dir_of(key), "region": key.split("/")[0],
           "synced_at": "2026-10-08T16:00:00Z", "children": {},
           "files": {rel: _file(rel) for rel in rels}}
    rec.update(extra)
    return rec


def _state(**incidents):
    return {"incidents": {k.replace("__", "/"): v for k, v in incidents.items()},
            "tiled": {}, "ir": {}, "incident_fires": {},
            "migrations": {"incident_ids": NOW}}


def _fires(*fires):
    return {fire_key(f["cornea_id"]): api_fire(f, f["post_title"].lower().replace(" ", "-"))
            for f in fires}


class Bucket:
    """put_json is recorded with the index entries present at that moment;
    downloads, file uploads and deletes fail the test."""

    def __init__(self, state, fail_on: str | None = None):
        self.state, self.fail_on = state, fail_on
        self.puts: list[str] = []
        self.index_at_put: list[list[str]] = []
        self.docs: dict[str, dict] = {}

    def put_json(self, key, obj, *, cache_control=None):
        if self.fail_on and key == fm.manifest_key(self.fail_on):
            raise RuntimeError("503 too_busy")
        self.puts.append(key)
        self.index_at_put.append(sorted(self.state.get("incident_fires") or {}))
        self.docs[key] = json.loads(json.dumps(obj))

    def get_json(self, key):
        return self.docs.get(key)

    def get_file(self, key, dest):
        raise AssertionError(f"download {key}")

    def put_file(self, key, path, **kw):
        raise AssertionError(f"upload {key}")

    def delete_keys(self, keys):
        raise AssertionError("delete")

    delete_prefix = delete_keys


def _publish(state, fires_by_fk, rebuild=None, *, storage=None, mirrors=None, replay_only=True,
             stats=None):
    storage = storage or Bucket(state)
    rebuild = set(fires_by_fk) if rebuild is None else rebuild
    out = fm.publish_fire_manifests(None, storage, state, fires_by_fk, rebuild, mirrors or {},
                                    replay_only=replay_only, stats=stats, log=lambda *_: None)
    return out, storage


def _urls(man):
    return sorted(m["pdf_url"] for m in man["maps"])


# ---------------------------------------------------------------------------

def test_twin_sisters_split_into_two_manifests():
    mt = _rec(TWIN_MT, "unit_id", MT_KEY, "twin-sisters", ["products/20260805/ops_0805.pdf"])
    # WA after the prefix split: its own prefix, its bytes still under twin-sisters/
    wa = _rec(TWIN_WA, "name_exact", WA_KEY, WA_FK, ["products/20260617/brief_0617.pdf"])
    wa["files"]["products/20260617/brief_0617.pdf"]["prefix"] = "twin-sisters"
    state = _state(n_rockies__2026__2026_TwinSisters=mt, pacific_nw__2026__2026_TwinSisters=wa)
    out, storage = _publish(state, _fires(TWIN_MT, TWIN_WA))

    assert set(out) == {MT_FK, WA_FK}
    assert _urls(out[MT_FK]) == ["/raw/incidents/twin-sisters/products/20260805/ops_0805.pdf"]
    assert _urls(out[WA_FK]) == ["/raw/incidents/twin-sisters/products/20260617/brief_0617.pdf"]
    for fk, fire in ((MT_FK, TWIN_MT), (WA_FK, TWIN_WA)):
        assert out[fk]["cornea_id"] == fire["cornea_id"] and out[fk]["fire_key"] == fk
        assert storage.docs[fm.manifest_key(fk)] == json.loads(json.dumps(out[fk]))
    idx = state["incident_fires"]
    assert idx[MT_FK]["dirs"] == [MT_KEY] and idx[WA_FK]["dirs"] == [WA_KEY]
    assert idx[WA_FK]["manifest"] == f"catalogs/incidents/id/{WA_FK}.json"
    assert (idx[WA_FK]["method"], idx[WA_FK]["dir_url"]) == ("name_exact", dir_of(WA_KEY))
    assert idx[MT_FK]["counts"]["maps"] == 1 and idx[MT_FK]["v"] == cat.INCIDENT_MANIFEST_V


def test_rebind_ownership_lands_files_on_right_fire():
    gh = _rec(GRASSHOPPER, "unit_id", GH_KEY, "grasshopper", [
        "products/20261003/Ops_Grasshopper_1003.pdf",
        "products/20260817/Ops_Austin_ORMHF000863_0817.pdf",
        "products/20260817/OpsTheNarrows_0817.pdf",
        "products/20260817/Trans_0817.pdf"])
    files = gh["files"]
    files["products/20260817/Ops_Austin_ORMHF000863_0817.pdf"].update(
        prefix="austin", fk=AU_FK, fk_src="token")
    files["products/20260817/OpsTheNarrows_0817.pdf"].update(prefix="austin", fk=None,
                                                             fk_src="hidden")
    files["products/20260817/Trans_0817.pdf"].update(prefix="austin", fk=AU_FK, fk_src="prior")
    au = _rec(AUSTIN, "unit_id", AU_KEY, "austin", ["products/20260930/Ops_Austin_0930.pdf"])
    state = _state(pacific_nw__2026__2026_Grasshopper=gh, pacific_nw__2026__2026_Austin=au)
    out, _ = _publish(state, _fires(GRASSHOPPER, AUSTIN))

    assert _urls(out[GH_FK]) == ["/raw/incidents/grasshopper/products/20261003/Ops_Grasshopper_1003.pdf"]
    assert _urls(out[AU_FK]) == [
        "/raw/incidents/austin/products/20260817/Ops_Austin_ORMHF000863_0817.pdf",
        "/raw/incidents/austin/products/20260817/Trans_0817.pdf",
        "/raw/incidents/austin/products/20260930/Ops_Austin_0930.pdf"]
    hidden = "OpsTheNarrows_0817.pdf"
    assert hidden not in json.dumps(out)
    idx = state["incident_fires"]
    assert idx[AU_FK]["dirs"] == [AU_KEY, GH_KEY] and idx[AU_FK]["primary"] == AU_KEY
    assert idx[GH_FK]["dirs"] == [GH_KEY]
    # the folder lending files names neither its binding's method nor its unit id
    assert out[AU_FK]["sources"] == [
        {"dir_url": dir_of(AU_KEY), "region": "pacific_nw", "unit_incident": "ORMHF000863",
         "method": "unit_id"},
        {"dir_url": dir_of(GH_KEY), "region": "pacific_nw", "unit_incident": None, "method": None}]


def test_one_put_per_fire_then_index():
    gh = _rec(GRASSHOPPER, "unit_id", GH_KEY, "grasshopper", ["products/a/Ops_1003.pdf"])
    gh["files"]["products/a/Ops_Austin_0820.pdf"] = _file("products/a/Ops_Austin_0820.pdf",
                                                          fk=AU_FK, fk_src="name")
    au = _rec(AUSTIN, "unit_id", AU_KEY, "austin", ["products/b/Ops_0930.pdf"])
    mt = _rec(TWIN_MT, "unit_id", MT_KEY, "twin-sisters", ["products/c/ops.pdf"])
    state = _state(pacific_nw__2026__2026_Grasshopper=gh, pacific_nw__2026__2026_Austin=au,
                   n_rockies__2026__2026_TwinSisters=mt)
    fires = _fires(GRASSHOPPER, AUSTIN)  # Twin Sisters MT is not active
    _out, storage = _publish(state, fires, rebuild={GH_FK, AU_FK, AU_FK, MT_FK})

    assert storage.puts == [fm.manifest_key(AU_FK), fm.manifest_key(GH_FK)]
    # each fire's entry appears only after its own PUT
    assert storage.index_at_put == [[], [AU_FK]]
    assert sorted(state["incident_fires"]) == [AU_FK, GH_FK]


def test_put_failure_writes_no_index_entry():
    gh = _rec(GRASSHOPPER, "unit_id", GH_KEY, "grasshopper", ["products/a/Ops_1003.pdf"])
    au = _rec(AUSTIN, "unit_id", AU_KEY, "austin", ["products/b/Ops_0930.pdf"])
    state = _state(pacific_nw__2026__2026_Grasshopper=gh, pacific_nw__2026__2026_Austin=au)
    storage = Bucket(state, fail_on=GH_FK)
    with pytest.raises(RuntimeError):
        _publish(state, _fires(GRASSHOPPER, AUSTIN), storage=storage)
    assert storage.puts == [fm.manifest_key(AU_FK)]
    assert set(state["incident_fires"]) == {AU_FK}

    # an existing entry is left as it was, never pointed at an unwritten build
    old = {"v": 1, "manifest": fm.manifest_key(GH_FK), "dirs": [GH_KEY], "built_at": "old",
           "counts": {"maps": 7}}
    state["incident_fires"][GH_FK] = dict(old)
    with pytest.raises(RuntimeError):
        _publish(state, _fires(GRASSHOPPER, AUSTIN), storage=Bucket(state, fail_on=GH_FK))
    assert state["incident_fires"][GH_FK] == old


def test_detach_rebuilds_old_fire():
    complex_key = "pacific_nw/2026/2026_AustinComplex"
    au = _rec(AUSTIN, "unit_id", AU_KEY, "austin", ["products/b/Ops_0930.pdf"])
    cx = _rec(AUSTIN, "name_exact", complex_key, "austin-complex", ["products/c/Ops_Cx_0601.pdf"])
    state = _state(pacific_nw__2026__2026_Austin=au, pacific_nw__2026__2026_AustinComplex=cx)
    fires = _fires(AUSTIN)
    _publish(state, fires)
    assert state["incident_fires"][AU_FK]["dirs"] == [AU_KEY, complex_key]
    assert fm.stale_index_fks(state, fires) == set()

    # the date check detaches the complex folder: Austin's entry no longer
    # matches its contributors, so Austin is rebuilt without the folder
    cx["match_rejected"] = {"cornea_id": AUSTIN["cornea_id"], "method": "name_exact",
                            "reason": "newest upload …", "at": NOW}
    cx["match"] = None
    assert fm.stale_index_fks(state, fires) == {AU_FK}
    out, _ = _publish(state, fires, fm.stale_index_fks(state, fires))
    assert _urls(out[AU_FK]) == ["/raw/incidents/austin/products/b/Ops_0930.pdf"]
    assert state["incident_fires"][AU_FK]["dirs"] == [AU_KEY]


def test_reactivated_fire_and_version_bump_rebuild(monkeypatch):
    au = _rec(AUSTIN, "unit_id", AU_KEY, "austin", ["products/b/Ops_0930.pdf"])
    gh = _rec(GRASSHOPPER, "unit_id", GH_KEY, "grasshopper", ["products/a/Ops_1003.pdf"])
    state = _state(pacific_nw__2026__2026_Austin=au, pacific_nw__2026__2026_Grasshopper=gh)
    both = _fires(AUSTIN, GRASSHOPPER)
    only_gh = _fires(GRASSHOPPER)

    # Austin's folder changed while Austin was off the active list: it is
    # not rebuilt, and not considered stale, until it is active again
    _publish(state, only_gh, rebuild={AU_FK, GH_FK})
    assert set(state["incident_fires"]) == {GH_FK}
    assert fm.stale_index_fks(state, only_gh) == set()
    assert fm.stale_index_fks(state, both) == {AU_FK}
    _publish(state, both, fm.stale_index_fks(state, both))
    assert fm.stale_index_fks(state, both) == set()

    # reassign-files marks an entry v=0; a manifest version bump rebuilds all
    state["incident_fires"][GH_FK]["v"] = 0
    assert fm.stale_index_fks(state, both) == {GH_FK}
    state["incident_fires"][GH_FK]["v"] = cat.INCIDENT_MANIFEST_V
    monkeypatch.setattr(cat, "INCIDENT_MANIFEST_V", cat.INCIDENT_MANIFEST_V + 1)
    assert fm.stale_index_fks(state, both) == {AU_FK, GH_FK}
    _publish(state, both, fm.stale_index_fks(state, both))
    assert {e["v"] for e in state["incident_fires"].values()} == {cat.INCIDENT_MANIFEST_V}


def test_fire_without_contributors_dropped_from_index_only():
    au = _rec(AUSTIN, "unit_id", AU_KEY, "austin", ["products/b/Ops_0930.pdf"])
    gh = _rec(GRASSHOPPER, "unit_id", GH_KEY, "grasshopper", ["products/a/Ops_1003.pdf"],
              match=None, ignored=True, override="ignore")
    state = _state(pacific_nw__2026__2026_Austin=au, pacific_nw__2026__2026_Grasshopper=gh)
    state["incident_fires"][GH_FK] = {"v": 1, "manifest": fm.manifest_key(GH_FK),
                                      "dirs": [GH_KEY]}
    state["incident_fires"]["0000dead-0000-4000-8000-000000000000"] = {"v": 1, "dirs": ["x"]}
    _out, storage = _publish(state, _fires(AUSTIN, GRASSHOPPER), rebuild={AU_FK, GH_FK})
    # the ignored folder feeds nothing: Grasshopper's entry goes (with the
    # stale one), nothing is uploaded for it and nothing is deleted
    assert storage.puts == [fm.manifest_key(AU_FK)]
    assert set(state["incident_fires"]) == {AU_FK}


def test_replay_only_never_converts_renders_or_downloads(tmp_path, monkeypatch):
    def forbidden(*a, **k):
        raise AssertionError("no conversion, render or download when replaying")

    monkeypatch.setattr(geopdf, "render_preview", forbidden)
    monkeypatch.setattr(geopdf, "gdal_available", lambda: True)
    monkeypatch.setattr(ir_vectors, "process_ir_kmz", forbidden)
    monkeypatch.setattr(ir_vectors, "process_ir_zip", forbidden)
    monkeypatch.setattr(fm.shutil, "which", lambda _: "/usr/bin/ogr2ogr")
    frames.start_deadline(0)  # disarmed

    kmz, pdf = "ir/20260929/20260929_Grasshopper_IR.kmz", "ir/20260929/20260929_Grasshopper_IR.pdf"
    sheet = "products/20261003/Ops_Grasshopper_1003.pdf"
    gh = _rec(GRASSHOPPER, "unit_id", GH_KEY, "grasshopper", [kmz, pdf, sheet])
    state = _state(pacific_nw__2026__2026_Grasshopper=gh)
    # this run downloaded the KMZ: even its local copy is not converted
    local = tmp_path / "x.kmz"
    local.write_bytes(b"kmz")
    meta = gh["files"][kmz]
    res = MirrorResult(files=[MirroredFile(
        kind="ir", filename=kmz.rpartition("/")[2], key=f"raw/incidents/grasshopper/{kmz}",
        url="", size=3, sha16=meta["sha16"], rev=1, local_path=local, changed=True,
        rel_dir="ir/20260929")])
    mirrors = {GH_KEY: {"result": res}}
    out, storage = _publish(state, _fires(GRASSHOPPER), mirrors=mirrors)
    [flight] = out[GH_FK]["ir_flights"]
    assert flight["geojson_url"] is None and flight["preview_url"] is None
    assert flight["kmz_url"] == f"/raw/incidents/grasshopper/{kmz}"
    assert storage.puts == [fm.manifest_key(GH_FK)]
    assert state["ir"] == {} and state["tiled"] == {} and "ir_keys" not in gh

    # the same build outside replay converts into a new content-addressed
    # key and stamps it for that source
    def convert(src, out_path, *, flight_id):
        Path(out_path).write_text('{"features": []}')
        return {"heat_types": ["Perimeter"], "feature_count": 1}

    monkeypatch.setattr(ir_vectors, "process_ir_kmz", convert)
    monkeypatch.setattr(ir_vectors, "kmz_flight_time", lambda p: {"flown_at": None,
                                                                   "flown_date": "2026-09-29"})
    uploaded = []
    storage = Bucket(state)
    storage.put_file = lambda key, path, **kw: uploaded.append(key)
    out, _ = _publish(state, _fires(GRASSHOPPER), mirrors=mirrors, storage=storage,
                      replay_only=False)
    key = f"vectors/ir/grasshopper/{meta['sha16']}.v{ir_vectors.IR_CONVERTER_VERSION}.geojson"
    assert uploaded == [key]
    assert out[GH_FK]["ir_flights"][0]["geojson_url"] == f"/{key}"
    assert gh["ir_keys"][kmz] == {"key": key, "flight_id": "20260929_IR",
                                  "src_sha16": meta["sha16"]}


def test_unit_incident_strips_any_year():
    assert fm.unit_incident("2026-ORMHF-000863") == "ORMHF000863"
    assert fm.unit_incident("2027-MTBDF-266313") == "MTBDF266313"
    assert fm.unit_incident(None) is None
    a27 = dict(AUSTIN, unique_fire_id="2027-ORMHF-000863")
    key = "pacific_nw/2027/2027_Austin"
    au = _rec(a27, "unit_id", key, "austin", ["products/b/Ops_0930.pdf"])
    state = _state(pacific_nw__2027__2027_Austin=au)
    out, _ = _publish(state, _fires(a27))
    assert out[AU_FK]["unit_incident"] == "ORMHF000863"
    assert out[AU_FK]["sources"][0]["unit_incident"] == "ORMHF000863"
    assert out[AU_FK]["region"] == "pacific_nw"


def test_ir_flights_per_owner_in_mixed_folder(fixtures):
    names = json.loads((fixtures / "incident_files.json").read_text())
    bt = _rec(BEAR_TRAP, "unit_id", BT_KEY, "bear-trap", names["beartrap_ir"])
    files = bt["files"]
    # the slug-keyed build once converted Thumb's KMZ for Bear Trap (08-05);
    # a stamp for Bear Trap's own 08-17 shapefiles is kept
    zip17 = "ir/20260817/20260817_c0700_Bear_Trap_Aircraft3_Shapefiles.zip"
    bt["ir_keys"] = {
        zip17: {"key": "vectors/ir/bear-trap/20260817_c0700_Aircraft3.geojson",
                "flight_id": "20260817_c0700_Aircraft3", "src_sha16": files[zip17]["sha16"]},
        "ir/20260805/20260805_Thumb_Wolfpack_IR.kmz": {
            "key": "vectors/ir/bear-trap/20260805_Thumb_Wolfpack_IR.geojson",
            "flight_id": "20260805_Thumb_Wolfpack_IR",
            "src_sha16": files["ir/20260805/20260805_Thumb_Wolfpack_IR.kmz"]["sha16"]}}
    v = ir_vectors.IR_CONVERTER_VERSION
    state = _state(eastern__2026__2026_JulyLightningEvent=bt)
    state["ir"] = {e["key"]: {"v": v, "heat_types": ["Perimeter"]} for e in bt["ir_keys"].values()}
    stats: dict = {}
    out, _ = _publish(state, _fires(BEAR_TRAP, THUMB), stats=stats)

    flights = {f["flight_date"]: f for f in out[BT_FK]["ir_flights"]}
    f17 = flights["2026-08-17"]
    assert f17["geojson_url"] == "/vectors/ir/bear-trap/20260817_c0700_Aircraft3.geojson"
    assert f17["flight_id"] == "20260817_c0700_Aircraft3"
    # the folder's other files are Bear Trap's to show, but its own come first
    assert f17["pdf_url"].endswith("20260817_c0700_Bear_Trap_Aircraft3.pdf")
    assert f17["kmz_url"].endswith("20260817_c0700_Bear_Trap_Aircraft3_All.kmz")
    assert f17["readme_url"].endswith("20260817_c0700_Bear_Trap_Aircraft3_Read_Me.txt")
    assert flights["2026-08-06"]["kmz_url"].endswith("20260806_BearTrap_Thumb_Wolfpack_IR.kmz")
    # flights of other fires only: no vectors, even from the old stamp
    for day in ("2026-08-05", "2026-08-04"):
        assert flights[day]["geojson_url"] is None
    assert stats["ir_mixed_hidden"] == [
        {"key": BT_KEY, "rel_dir": "ir/20260805", "owner": BT_FK},
        {"key": BT_KEY, "rel_dir": "ir/20260804", "owner": BT_FK}]
    assert THUMB["cornea_id"] and fire_key(THUMB["cornea_id"]) not in out  # a third fire: nothing

    # 2026_Grasshopper's 08-17 folder after the split: one flight per owner,
    # each from its own files
    gh = _rec(GRASSHOPPER, "unit_id", GH_KEY, "grasshopper", [
        "ir/20260817/20260817_Austin_IR_11x17_Topo.pdf", "ir/20260817/20260817_Grasshopper_IR.kmz",
        "ir/20260817/20260817_Grasshopper_IR_11x17_Topo.pdf",
        "ir/20260817/20260817_Mitchell_IR_11x17_Topo.pdf"])
    for rel, meta in gh["files"].items():
        meta["prefix"] = "austin"
        if "Austin" in rel or "Mitchell" in rel:
            meta.update(fk=AU_FK, fk_src="name" if "Austin" in rel else "location")
    kmz = "ir/20260817/20260817_Grasshopper_IR.kmz"
    gh["ir_keys"] = {kmz: {"key": "vectors/ir/austin/20260817_IR_11x17_Topo.geojson",
                           "flight_id": "20260817_IR_11x17_Topo",
                           "src_sha16": gh["files"][kmz]["sha16"]}}
    state = _state(pacific_nw__2026__2026_Grasshopper=gh)
    state["ir"] = {"vectors/ir/austin/20260817_IR_11x17_Topo.geojson": {"v": v,
                                                                       "heat_types": ["Perimeter"]}}
    out, _ = _publish(state, _fires(GRASSHOPPER, AUSTIN))
    [g] = out[GH_FK]["ir_flights"]
    [a] = out[AU_FK]["ir_flights"]
    assert g["geojson_url"] == "/vectors/ir/austin/20260817_IR_11x17_Topo.geojson"
    assert g["pdf_url"] == "/raw/incidents/austin/ir/20260817/20260817_Grasshopper_IR_11x17_Topo.pdf"
    assert a["geojson_url"] is None and a["kmz_url"] is None
    assert a["pdf_url"] == "/raw/incidents/austin/ir/20260817/20260817_Austin_IR_11x17_Topo.pdf"
    assert a["flight_id"] == "20260817_IR_11x17_Topo"


def test_publish_catalog_points_each_fire_at_its_own_manifest(tmp_path, monkeypatch):
    from responder_worker.b2 import DryRunStorage

    monkeypatch.setattr(cat, "now_iso", lambda: NOW)
    storage = DryRunStorage(tmp_path)
    storage.put_json("catalogs/catalog.json", {"fires": [
        {"cornea_id": AUSTIN["cornea_id"], "has_spread_forecast": True,
         "spread_latest_run": "2026-10-08T12:00:00Z", "spread_run_count": 3}],
        "national_layers": {"x": 1}})
    au = _rec(AUSTIN, "unit_id", AU_KEY, "austin", ["products/b/Ops_0930.pdf"])
    state = _state(pacific_nw__2026__2026_Austin=au)
    state["catalog_version"] = 41
    fires = _fires(AUSTIN, GRASSHOPPER)
    fm.publish_fire_manifests(None, storage, state, fires, set(fires), {}, replay_only=True,
                              log=lambda *_: None)
    storage.written.clear()
    catalog = fm.publish_catalog(storage, state, list(fires.values()), log=lambda *_: None)
    assert storage.written == ["state/state.json", "catalogs/versions/catalog.42.json",
                               "catalogs/catalog.json"]
    rows = {fire_key(r["cornea_id"]): r for r in catalog["fires"]}
    assert rows[AU_FK]["incident_manifest"] == f"/catalogs/incidents/id/{AU_FK}.json"
    assert rows[AU_FK]["spread_latest_run"] == "2026-10-08T12:00:00Z"
    assert rows[GH_FK]["has_incident_maps"] is False
    assert catalog["national_layers"] == {"x": 1} and state["catalog_version"] == 42
    with pytest.raises(RuntimeError):
        fm.publish_catalog(storage, dict(state, migrations={}), [], log=lambda *_: None)
