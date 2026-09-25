"""A whole routing bundle built from the synthetic scene (tests/routing_scene.py)
through the real GDAL 3.8.4 + osmium CLIs, plus plan/index logic.

GDAL/osmium-dependent tests skip when the tools are absent.
"""

import shutil
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from responder_worker import config, gdal_cli, graph_build, pmtiles_inspect
from responder_worker import routing_bundle as rb
from responder_worker import routing_plan as rp
from responder_worker.b2 import DryRunStorage

import routing_scene

needs_tools = pytest.mark.skipif(
    any(shutil.which(t) is None for t in ("ogr2ogr", "gdalwarp", "gdal_rasterize", "osmium",
                                          "gdaltransform")),
    reason="GDAL/osmium not installed")
NOW = datetime(2026, 9, 25, 12, tzinfo=timezone.utc)


class TestAoi:
    def test_point_min_side_and_snap(self):
        a = rp.aoi_for([-115.0, 44.2], None)
        g = a["grid"]
        assert a["epsg"] == 32611 and g["cell_m"] == 30 and not a["clipped"]
        assert g["width"] * 30 >= 16000 and g["height"] * 30 >= 16000
        assert g["x0"] % 30 == 0 and g["y0"] % 30 == 0

    def test_perimeter_buffer_and_60m_switch(self):
        small = rp.aoi_for([-115.0, 44.2], (-115.1, 44.1, -114.9, 44.3))
        assert small["source"] == "perimeter" and small["grid"]["cell_m"] == 30
        big = rp.aoi_for([-120.2, 44.9], (-121.0, 44.4, -119.4, 45.4))  # ~130 x 110 km
        assert big["grid"]["cell_m"] == 60
        assert big["grid"]["width"] * big["grid"]["height"] <= config.ROUTING_MAX_CELLS
        huge = rp.aoi_for([-120.0, 44.9], (-122.0, 43.9, -118.0, 45.9))
        assert huge["clipped"] and huge["grid"]["width"] * 60 <= 150_000 + 60

    def test_hysteresis_and_never_shrink(self):
        a = rp.aoi_for([-115.0, 44.2], (-115.1, 44.1, -114.9, 44.3))
        # small growth inside the 2 km margin -> identical grid
        b = rp.aoi_for([-115.0, 44.2], (-115.1, 44.1, -114.89, 44.3), a)
        assert b["grid"] == a["grid"]
        # growth beyond it -> union, still containing the old grid
        c = rp.aoi_for([-115.0, 44.2], (-115.1, 44.1, -114.7, 44.3), a)
        ob, nb = rp.grid_bounds(a["grid"]), rp.grid_bounds(c["grid"])
        assert nb[0] <= ob[0] and nb[1] <= ob[1] and nb[2] > ob[2] and nb[3] >= ob[3]

    def test_fire_key(self):
        assert rp.fire_key("{1B0219EE-5298-4FEF-9927-C2666D9D53FC}") == \
            "1b0219ee-5298-4fef-9927-c2666d9d53fc"
        assert rp.fire_key("4883092e-aaaa") == "4883092e-aaaa"
        assert len(rp.fire_key("{}")) == 16


class TestActions:
    AOI = rp.aoi_for([-115.0, 44.2], None)

    def ptr(self, **kw):
        p = {"recipe": config.ROUTING_RECIPE, "built_at": "2026-09-24T12:00:00Z",
             "aoi": {"epsg": self.AOI["epsg"], "grid": self.AOI["grid"]}}
        p.update(kw)
        return p

    def test_table(self):
        assert rp.action_for(None, None, self.AOI, NOW) == ("build", "new")
        assert rp.action_for(self.ptr(), {}, self.AOI, NOW) == ("skip", "fresh")
        assert rp.action_for(self.ptr(recipe=0), {}, self.AOI, NOW) == ("build", "recipe")
        other = dict(self.AOI, grid=dict(self.AOI["grid"], width=1))
        assert rp.action_for(self.ptr(), {}, other, NOW) == ("build", "aoi_changed")
        assert rp.action_for(self.ptr(built_at="2026-09-10T00:00:00Z"), {}, self.AOI, NOW) == \
            ("check", "age")
        bad = {"failures": 3, "last_attempt_at": "2026-09-25T06:00:00Z"}
        assert rp.action_for(None, bad, self.AOI, NOW) == ("backoff", "failures")
        assert rp.action_for(None, dict(bad, last_attempt_at="2026-09-24T06:00:00Z"),
                             self.AOI, NOW) == ("build", "retry")
        assert rp.action_for(self.ptr(), bad, self.AOI, NOW, force=True) == ("build", "forced")


class TestShards:
    def _e(self, cid, region, acres, side=500):
        return {"cornea_id": cid, "regions": [region], "acres": acres, "slug": cid, "reason": "new",
                "aoi": {"grid": {"width": side, "height": side}}}

    def test_priority_then_region_affinity(self):
        es = [self._e("a", "us/idaho", 10), self._e("b", "us/oregon", 5000),
              self._e("c", "us/idaho", 3000), self._e("d", "us/montana", 1),
              self._e("e", "us/oregon", 20)]
        order = rp.priority_order(es, ["d"])
        assert [e["cornea_id"] for e in order] == ["d", "b", "c", "e", "a"]
        shards = rp.assign_shards(order, 2)
        regions = [{e["regions"][0] for e in s} for s in shards]
        assert all(len(r) >= 1 for r in regions)
        for r in ("us/idaho", "us/oregon"):
            assert sum(r in rs for rs in regions) == 1  # a region lives on one shard
        assert sorted(e["cornea_id"] for s in shards for e in s) == list("abcde")

    def test_big_region_split(self):
        es = [self._e(str(i), "us/california/norcal", 100 - i, side=2000) for i in range(8)]
        shards = rp.assign_shards(es, 4)
        assert all(shards), [len(s) for s in shards]


class TestIndexDoc:
    def test_from_pointers_only(self):
        good = {"recipe": config.ROUTING_RECIPE, "descriptor": "/routing/k/bx/bundle.json",
                "bundle_id": "x", "built_at": "t", "bbox": [0, 0, 1, 1], "cell_m": 30, "bytes": 5}
        idx = rb.index_doc({"{A}": good, "{B}": dict(good, recipe=99), "{C}": None}, NOW)
        assert list(idx["fires"]) == ["{A}"] and idx["schema"] == "rd-routing-index/1"


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    root = tmp_path_factory.mktemp("bundle")
    storage = DryRunStorage(root / "out")
    res = routing_scene.build(root / "out", root / "work", storage)
    return root, storage, res


@needs_tools
class TestBundleBuild:
    def test_result_and_upload_order(self, built):
        root, storage, res = built
        assert res["built"] == ["{SYNTH-0001}"] and not res["failed"], res
        fk = routing_scene.plan_entry()["fire_key"]
        ptr = storage.get_json(rb.pointer_key(fk))
        w = storage.written
        pk = rb.pointer_key(fk)
        prefix = f"routing/{fk}/b{ptr['bundle_id']}"
        for name in ("grid.tif", "dem.tif", "graph.bin.gz", "trails.pmtiles", "bundle.json"):
            assert w.index(f"{prefix}/{name}") < w.index(pk)
        st = storage.get_json(rb.state_key(fk))
        assert st["failures"] == 0 and st["bundle_id"] == ptr["bundle_id"]

    def test_descriptor(self, built):
        root, storage, _ = built
        fk = routing_scene.plan_entry()["fire_key"]
        ptr = storage.get_json(rb.pointer_key(fk))
        d = storage.get_json(ptr["descriptor"].lstrip("/"))
        assert d["schema"] == "rd-routing-bundle/1" and d["crs"]["epsg"] == 32611
        assert d["sources"]["landfire"]["veg"] == "LF2025+LF2024"  # per-pixel mosaic
        assert d["warnings"] == []
        assert set(d["files"]) == {"grid", "dem", "graph", "trails"}
        for f in d["files"].values():
            p = root / "out" / f["path"].lstrip("/")
            assert p.stat().st_size == f["bytes"]
        s = d["stats"]
        assert 0 < s["impassable_pct"] < 10 and s["stream_cells"] > 100
        assert s["conflation"]["agency_dropped_covered"] == 1
        assert s["conflation"]["agency_runs_added"] >= 1

    def test_grid_rasters(self, built):
        root, storage, _ = built
        fk = routing_scene.plan_entry()["fire_key"]
        d = storage.get_json(storage.get_json(rb.pointer_key(fk))["descriptor"].lstrip("/"))
        grid = root / "out" / d["files"]["grid"]["path"].lstrip("/")
        inf = gdal_cli.info(grid)
        assert inf["size"] == [d["grid"]["width"], d["grid"]["height"]]
        assert [b["type"] for b in inf["bands"]] == ["Byte", "Byte"]
        assert inf["metadata"]["IMAGE_STRUCTURE"]["COMPRESSION"] == "DEFLATE"
        arr, geo, _ = gdal_cli.read_raster(grid, root / "chk")
        assert (geo.x0, geo.y0, geo.epsg) == (d["grid"]["x0"], d["grid"]["y0"], 32611)
        veg = arr[1] & 0x0F
        assert {1, 3, 4, 6, 10, 11} <= set(np.unique(veg).tolist())
        assert ((arr[1] & 0x10) > 0).sum() > 100  # creek cells
        dem, _, nd = gdal_cli.read_raster(root / "out" / d["files"]["dem"]["path"].lstrip("/"),
                                          root / "chk")
        assert nd == [-32768] and 1700 < dem.mean() < 2400

    def test_graph_and_trails_extract(self, built):
        root, storage, _ = built
        fk = routing_scene.plan_entry()["fire_key"]
        d = storage.get_json(storage.get_json(rb.pointer_key(fk))["descriptor"].lstrip("/"))
        g = graph_build.decode_rdg1((root / "out" / d["files"]["graph"]["path"].lstrip("/")).read_bytes())
        names = {g["strings"][i] for i in g["name"] if i != graph_build.NONE}
        assert "FS 100" in names and "Ridge Trail #101" in names and "High Traverse #202" in names
        kinds = set(g["kind"].tolist())
        assert {graph_build.KIND_AGENCY, graph_build.KIND_TRACK, graph_build.KIND_PATH} <= kinds
        s = pmtiles_inspect.summarize(root / "out" / d["files"]["trails"]["path"].lstrip("/"))
        assert (s["header"]["min_zoom"], s["header"]["max_zoom"]) == (10, 14)
        assert set(s["metadata_layers"]) == {"trails", "ways"}

    def test_rerun_is_unchanged(self, built, tmp_path):
        root, storage, _ = built
        res = routing_scene.build(root / "out", tmp_path / "w2", storage)
        assert res["unchanged"] == ["{SYNTH-0001}"] and not res["built"]


@needs_tools
def test_nhd_trim_keeps_perennial_only(tmp_path):
    """A miniature HU8 GeoPackage with the real layer/field names
    (NHDFlowline.fcode, NHDWaterbody.ftype/fcode, NHDArea.ftype)."""
    import json as _json
    import zipfile

    from responder_worker import nhd

    def seq(name, feats):
        p = tmp_path / f"{name}.geojsonl"
        p.write_text("".join(_json.dumps({"type": "Feature", "properties": pr, "geometry": g}) + "\n"
                             for pr, g in feats))
        return p

    line = {"type": "LineString", "coordinates": [[-115, 44], [-114.99, 44.01]]}
    poly = {"type": "Polygon", "coordinates": [[[-115, 44], [-114.99, 44], [-114.99, 44.01], [-115, 44]]]}
    full = tmp_path / "NHD_H_17060201_HU8_GPKG.gpkg"
    for layer, feats in (
        ("NHDFlowline", [({"fcode": 46006, "ftype": 460}, line), ({"fcode": 46003, "ftype": 460}, line),
                         ({"fcode": 55800, "ftype": 558}, line)]),
        ("NHDWaterbody", [({"fcode": 39004, "ftype": 390}, poly), ({"fcode": 39001, "ftype": 390}, poly),
                          ({"fcode": 43600, "ftype": 436}, poly), ({"fcode": 46600, "ftype": 466}, poly)]),
        ("NHDArea", [({"fcode": 46006, "ftype": 460}, poly), ({"fcode": 33600, "ftype": 336}, poly)]),
    ):
        cmd = ["ogr2ogr", "-f", "GPKG", str(full), str(seq(layer, feats)), "-nln", layer]
        if full.exists():
            cmd[1:1] = ["-update"]
        gdal_cli.run(cmd)
    z = tmp_path / "NHD_H_17060201_HU8_GPKG.zip"
    with zipfile.ZipFile(z, "w") as zf:
        zf.write(full, full.name)
    out = nhd.trim_huc8(z, tmp_path / "trim.gpkg")
    inf = gdal_cli.run(["ogrinfo", "-so", "-al", str(out)]).stdout
    counts = dict(zip(__import__("re").findall(r"Layer name: (\w+)", inf),
                      map(int, __import__("re").findall(r"Feature Count: (\d+)", inf))))
    assert counts == {"streams": 1, "water": 3}  # 39004 + 43600 + the NHDArea river


def test_long_thin_fire_is_not_clipped():
    # ~85 km E-W, ~5 km N-S perimeter: fits the cell budget at 30 m
    a = rp.aoi_for([-120.0, 44.0], (-120.55, 43.98, -119.45, 44.02))
    g = a["grid"]
    assert not a["clipped"] and g["cell_m"] == 30
    assert g["width"] * g["height"] <= config.ROUTING_MAX_CELLS
    assert g["width"] * 30 > 85_000
