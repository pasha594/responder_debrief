"""A whole routing bundle built from the synthetic scene (tests/routing_scene.py)
through the real GDAL 3.8.4 + osmium CLIs, plus plan/index logic.

GDAL/osmium-dependent tests skip when the tools are absent.
"""

import math
import shutil
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from responder_worker import config, cost_grid, gdal_cli, graph_build, nhd, osm_extract
from responder_worker import pmtiles_inspect
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


class TestRunShard:
    def test_no_osm_region_fails_instead_of_building_without_roads(self, tmp_path, monkeypatch):
        # A region-choice bug (the live Geofabrik index once matched no
        # region for SISI) must fail the fire, never build it without OSM.
        from responder_worker import osm_extract, routing_cli
        monkeypatch.setattr(osm_extract, "load_index", lambda client: {"features": []})
        storage = DryRunStorage(tmp_path / "out")
        entry = {"cornea_id": "{X}", "fire_key": "x", "slug": "x", "regions": [],
                 "aoi": rp.aoi_for([-115.0, 44.2], None)}
        plan = {"shards": [{"shard": 0, "fires": [entry]}], "trails": None}

        def build(*a, **kw):
            raise AssertionError("must not build")
        res = routing_cli.run_shard(None, storage, plan, 0, workdir=tmp_path / "w", build=build,
                                    log=lambda m: None)
        assert res["failed"] == [{"cornea_id": "{X}", "slug": "x", "error": "osm region unavailable"}]
        assert storage.get_json(rb.state_key("x"))["failures"] == 1


class TestLandfireBox:
    """bbox_5070 refuses a projected box that cannot be the grid's: the
    np.float64 bug made gdaltransform return a 26,708 x 172,455 px box for
    SISI's 729 x 743 grid, caught only by LANDFIRE's size limit."""
    THIN = rp.aoi_for([-120.0, 44.0], (-120.55, 43.98, -119.45, 44.02))  # ~87 x 16 km

    @staticmethod
    def _fake(angle_deg: float, scale: float = 1.0, wild: bool = False):
        th = math.radians(angle_deg)

        def transform(points, src, dst):
            a = np.asarray(points, dtype=np.float64)
            c = a - a.mean(axis=0)
            r = np.column_stack([c[:, 0] * math.cos(th) - c[:, 1] * math.sin(th),
                                 c[:, 0] * math.sin(th) + c[:, 1] * math.cos(th)])
            r = r * scale + (-1.8e6, 3.0e6)
            if wild:
                r[5] += (4.0e5, -2.0e6)
            return [tuple(p) for p in r.tolist()]
        return transform

    @pytest.mark.parametrize("angle, scale", [(0, 1.0), (19, 1.01), (-19, 0.99)])
    def test_rotated_long_thin_grid_passes(self, monkeypatch, angle, scale):
        # far from Albers' central meridian the two grids turn ~17-19° apart;
        # the long thin grid's box is then 2.5x its short side
        monkeypatch.setattr(gdal_cli, "transform_points", self._fake(angle, scale))
        b = rb.bbox_5070(self.THIN)
        assert b[2] - b[0] > 0 and b[3] - b[1] > 0

    @pytest.mark.parametrize("fake", [_fake(0, 30.0), _fake(0, 0.001), _fake(5, 1.0, wild=True)])
    def test_garbage_is_refused(self, monkeypatch, fake):
        monkeypatch.setattr(gdal_cli, "transform_points", fake)
        with pytest.raises(RuntimeError, match="projected LANDFIRE box implausible"):
            rb.bbox_5070(self.THIN)

    @needs_tools
    def test_real_projection(self):
        sisi = rp.aoi_for([-120.83, 48.35], (-120.87, 48.32, -120.79, 48.38))
        for aoi in (sisi, self.THIN, rp.aoi_for([-124.1, 41.9], None)):
            b = rb.bbox_5070(aoi)
            g = aoi["grid"]
            assert (b[2] - b[0]) / 30 < 1.3 * (g["width"] + g["height"]) * g["cell_m"] / 30


class TestCodeVersions:
    """Bundles are immutable and a rerun with the same id is "unchanged", so
    every piece of code that turns inputs into bytes needs a version in the
    id; the graph builder alone had one, and the SISI conflation fix first
    came back "unchanged"."""

    @pytest.mark.parametrize("module, attr", [
        (graph_build, "BUILD_VERSION"), (cost_grid, "COST_GRID_VERSION"),
        (nhd, "NHD_TRIM_VERSION"), (osm_extract, "FILTER_VERSION")])
    def test_bumping_a_version_changes_the_bundle_id(self, module, attr, monkeypatch):
        aoi = rp.aoi_for([-120.8, 48.35], None)
        args = {"osm_hash": "o", "trails_hash": "t", "huc8": ["17020009", "17020008"]}
        before = rb.bundle_id_for(rb.bundle_inputs(aoi, NOW, **args))
        assert rb.bundle_id_for(rb.bundle_inputs(aoi, NOW, **args)) == before
        monkeypatch.setattr(module, attr, getattr(module, attr) + 1)
        assert rb.bundle_id_for(rb.bundle_inputs(aoi, NOW, **args)) != before

    def test_nhd_cache_is_keyed_by_trim_version(self, tmp_path, monkeypatch):
        # An HU8 trimmed by older code (in B2 or in a --keep-work dir) must
        # not stand in for the current trim.
        storage = DryRunStorage(tmp_path / "out")
        old = tmp_path / "old.gpkg"
        old.write_bytes(b"old trim")
        storage.put_file("work/nhd/17020009.gpkg", old)  # the unversioned layout
        downloads = []

        def download(client, url, dest, timeout):
            downloads.append(url)
            dest.write_bytes(b"zip")

        monkeypatch.setattr(nhd, "download_to", download)
        monkeypatch.setattr(nhd, "trim_huc8", lambda z, dest: dest.write_bytes(b"new trim") and dest)
        item = {"huc8": "17020009", "url": "https://x/NHD_H_17020009_HU8_GPKG.zip"}
        quiet = {"log": lambda *_: None}
        for d in ("w1", "w2", "w3"):
            (tmp_path / d).mkdir()
        (tmp_path / "w2" / "nhd_17020009.gpkg").write_bytes(b"old trim")

        assert nhd.ensure_huc8(None, storage, item, tmp_path / "w1", **quiet).read_bytes() == b"new trim"
        assert len(downloads) == 1
        assert storage.exists(f"work/nhd/v{nhd.NHD_TRIM_VERSION}/17020009.gpkg")
        # a fresh run reads the versioned cache, never the stale local file
        assert nhd.ensure_huc8(None, storage, item, tmp_path / "w2", **quiet).read_bytes() == b"new trim"
        assert len(downloads) == 1
        # a new trim version misses the cache and trims again
        monkeypatch.setattr(nhd, "NHD_TRIM_VERSION", nhd.NHD_TRIM_VERSION + 1)
        nhd.ensure_huc8(None, storage, item, tmp_path / "w3", **quiet)
        assert len(downloads) == 2


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
        # pace, veg, then the additive stream-name band (never RGB)
        assert [b["type"] for b in inf["bands"]] == ["Byte", "Byte", "Byte"]
        assert [b.get("colorInterpretation") for b in inf["bands"]] == ["Gray", "Undefined", "Undefined"]
        assert inf["metadata"]["IMAGE_STRUCTURE"]["COMPRESSION"] == "DEFLATE"
        arr, geo, _ = gdal_cli.read_raster(grid, root / "chk")
        assert (geo.x0, geo.y0, geo.epsg) == (d["grid"]["x0"], d["grid"]["y0"], 32611)
        veg = arr[1] & 0x0F
        assert {1, 3, 4, 6, 10, 11} <= set(np.unique(veg).tolist())
        assert ((arr[1] & 0x10) > 0).sum() > 100  # creek cells
        dem, _, nd = gdal_cli.read_raster(root / "out" / d["files"]["dem"]["path"].lstrip("/"),
                                          root / "chk")
        assert nd == [-32768] and 1700 < dem.mean() < 2400

    def test_rivers_are_walls_and_streams_are_named(self, built):
        root, storage, _ = built
        fk = routing_scene.plan_entry()["fire_key"]
        d = storage.get_json(storage.get_json(rb.pointer_key(fk))["descriptor"].lstrip("/"))
        (pace, veg, sid), _, _ = gdal_cli.read_raster(
            root / "out" / d["files"]["grid"]["path"].lstrip("/"), root / "chk3")
        g = d["grid"]
        aoi = routing_scene.plan_entry()["aoi"]
        cx, cy = routing_scene._center_utm(aoi)

        def at(dx, dy):
            return int((g["y0"] - (cy + dy)) // g["cell_m"]), int((cx + dx - g["x0"]) // g["cell_m"])

        # rivers first (longest first), then creeks; the dry wash is no stream
        assert d["streams"] == {"band": 3, "names": ["Big Creek", "Wild River", "Ridge Creek"],
                                "truncated": False}
        big, wild, ridge = 1, 2, 3
        # NHD order 5 and OSM waterway=river: impassable water, named
        for (dx, dy), nid in (((routing_scene.RIVER_X + 40 * np.sin(3000 / 700), 3000), big),
                              ((6500, -6400), wild)):
            r, c = at(dx, dy)
            assert pace[r, c] == 255 and (veg[r, c] & 0x0F) == 10 and not veg[r, c] & 0x10
            assert sid[r, c] == nid
        assert pace[at(5300, -6600)] == 255  # the OSM riverbank area
        # a crossable creek keeps its x5 and stream bit, and now its name
        r, c = at(-4500, 1000 + 150 * np.sin(-4500 / 1500))
        assert veg[r, c] & 0x10 and pace[r, c] < 255 and sid[r, c] == ridge
        # the intermittent OSM river is not a barrier
        assert pace[at(-6500, -6500)] < 255 and sid[at(-6500, -6500)] == 0
        # Big Creek is a wall: its cells chain 8-connected from the top row
        # to the bottom, and A* never cuts the corner of a blocked cell
        wall = (sid == big) & (pace == 255)
        seen = {(0, c) for c in np.flatnonzero(wall[0])}
        todo = list(seen)
        while todo:
            r, c = todo.pop()
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    n = (r + dr, c + dc)
                    if 0 <= n[0] < g["height"] and 0 <= n[1] < g["width"] and wall[n] and n not in seen:
                        seen.add(n)
                        todo.append(n)
        assert any(r == g["height"] - 1 for r, _ in seen)
        assert d["stats"]["river_cells"] > 500

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

    def test_graph_builder_change_rebuilds(self, built, tmp_path, monkeypatch):
        # the SISI conflation fix first came back "unchanged": the bundle id
        # hashed the inputs but not the code that turns them into a graph
        root, _, _ = built
        storage = DryRunStorage(tmp_path / "out")
        for p in (root / "out").rglob("*"):
            if p.is_file():
                dest = tmp_path / "out" / p.relative_to(root / "out")
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(p, dest)
        old = storage.get_json(rb.pointer_key("synth-0001"))["bundle_id"]
        monkeypatch.setattr(graph_build, "BUILD_VERSION", graph_build.BUILD_VERSION + 1)
        res = routing_scene.build(tmp_path / "out", tmp_path / "w3", storage)
        assert res["built"] == ["{SYNTH-0001}"]
        assert storage.get_json(rb.pointer_key("synth-0001"))["bundle_id"] != old


@needs_tools
@pytest.mark.parametrize("with_vaa", [True, False])
def test_nhd_trim_keeps_perennial_only(tmp_path, with_vaa):
    """A miniature HU8 GeoPackage with the real layer/field names
    (NHDFlowline.fcode/gnis_name/permanent_identifier, NHDFlowlineVAA
    .streamorder, NHDWaterbody.ftype/fcode, NHDArea.ftype). Streams keep the
    name and the VAA stream order that decide rivers vs creeks; an HU8
    without a VAA table keeps a null order."""
    import json as _json
    import re
    import zipfile

    def seq(name, feats):
        p = tmp_path / f"{name}.geojsonl"
        p.write_text("".join(_json.dumps({"type": "Feature", "properties": pr, "geometry": g}) + "\n"
                             for pr, g in feats))
        return p

    line = {"type": "LineString", "coordinates": [[-115, 44], [-114.99, 44.01]]}
    poly = {"type": "Polygon", "coordinates": [[[-115, 44], [-114.99, 44], [-114.99, 44.01], [-115, 44]]]}
    fl = {"ftype": 460, "gnis_name": None, "wbarea_permanent_identifier": None}
    ap = dict(fl, fcode=55800, ftype=558, gnis_name="Agnes Creek")  # artificial path
    full = tmp_path / "NHD_H_17060201_HU8_GPKG.gpkg"
    layers = [
        ("NHDFlowline", [(dict(fl, fcode=46006, permanent_identifier="A", gnis_name="Agnes Creek"), line),
                         (dict(fl, fcode=46006, permanent_identifier="B"), line),
                         (dict(fl, fcode=46003, permanent_identifier="C"), line),
                         # through a perennial pool (kept) / a dry playa / a lake with no path
                         (dict(ap, permanent_identifier="D", wbarea_permanent_identifier="P"), line),
                         (dict(ap, permanent_identifier="E", wbarea_permanent_identifier="Y"), line),
                         (dict(ap, permanent_identifier="F", wbarea_permanent_identifier="X"), line)]),
        ("NHDWaterbody", [({"fcode": 39004, "ftype": 390, "permanent_identifier": "P"}, poly),
                          ({"fcode": 39001, "ftype": 390, "permanent_identifier": "Y"}, poly),
                          ({"fcode": 43600, "ftype": 436, "permanent_identifier": "R"}, poly),
                          ({"fcode": 46600, "ftype": 466, "permanent_identifier": "S"}, poly)]),
        ("NHDArea", [({"fcode": 46006, "ftype": 460, "permanent_identifier": "Q"}, poly),
                     ({"fcode": 33600, "ftype": 336, "permanent_identifier": "X"}, poly)]),
    ]
    if with_vaa:  # B has no VAA row
        layers.append(("NHDFlowlineVAA", [({"permanent_identifier": "A", "streamorder": 5}, None),
                                          ({"permanent_identifier": "C", "streamorder": 1}, None),
                                          ({"permanent_identifier": "D", "streamorder": 5}, None)]))
    for layer, feats in layers:
        cmd = ["ogr2ogr", "-f", "GPKG", str(full), str(seq(layer, feats)), "-nln", layer]
        if layer == "NHDFlowlineVAA":
            cmd += ["-nlt", "NONE"]
        if full.exists():
            cmd[1:1] = ["-update"]
        gdal_cli.run(cmd)
    z = tmp_path / "NHD_H_17060201_HU8_GPKG.zip"
    with zipfile.ZipFile(z, "w") as zf:
        zf.write(full, full.name)
    out = nhd.trim_huc8(z, tmp_path / "trim.gpkg")
    inf = gdal_cli.run(["ogrinfo", "-so", "-al", str(out)]).stdout
    counts = dict(zip(re.findall(r"Layer name: (\w+)", inf),
                      map(int, re.findall(r"Feature Count: (\d+)", inf))))
    assert counts == {"streams": 3, "water": 3}  # 39004 + 43600 + the NHDArea river
    lines = nhd.load_streams([out], (-115.1, 43.9, -114.9, 44.1), tmp_path)
    got = sorted(((p["name"] or ""), p["order"] or 0) for p, _ in lines)
    assert got == ([("", 0), ("Agnes Creek", 5), ("Agnes Creek", 5)] if with_vaa
                   else [("", 0), ("Agnes Creek", 0), ("Agnes Creek", 0)])


def test_long_thin_fire_is_not_clipped():
    # ~85 km E-W, ~5 km N-S perimeter: fits the cell budget at 30 m
    a = rp.aoi_for([-120.0, 44.0], (-120.55, 43.98, -119.45, 44.02))
    g = a["grid"]
    assert not a["clipped"] and g["cell_m"] == 30
    assert g["width"] * g["height"] <= config.ROUTING_MAX_CELLS
    assert g["width"] * 30 > 85_000
