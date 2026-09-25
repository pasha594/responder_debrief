"""Pure routing-bundle builders: cost grid, LANDFIRE request math, NHD
product parsing, Geofabrik region choice, OPL parsing, graph build +
conflation + RDG1.

fixtures/routing/tnm_products_excerpt.json mirrors the TNM Access API's
product listing shape recorded on 2026-09-24 (national, state and HU4
products listed before HU8, titles "...Hydrological Unit (HU) 8 - 17060201...").
"""

import json
import math

import numpy as np
import pytest

from responder_worker import cost_grid as cg
from responder_worker import graph_build as gb
from responder_worker import landfire, nhd, osm_extract


class TestPaceCode:
    def test_round_trip_and_range(self):
        p = np.array([0.8, 0.87, 2.0, 10.0, 100.0, 800.0])
        c = cg.pace_encode(p)
        back = cg.pace_decode(c)
        assert np.all(np.abs(back / p - 1) < 0.015)
        assert c[0] == 1 and c[-1] <= 254
        assert cg.pace_encode([5000.0])[0] == 254
        assert cg.pace_decode(254) == pytest.approx(819.2, rel=1e-3)

    def test_r_get_values(self):
        # GET v2: flat 1.149 m/s, 30° 0.441, 45° 0.265
        assert cg.r_get(0) == pytest.approx(1.1492, abs=1e-3)
        assert cg.r_get(30) == pytest.approx(0.441, abs=2e-3)
        assert cg.r_get(45) == pytest.approx(0.265, abs=2e-3)


def _grid(**over):
    shape = (3, 4)
    base = {"evt": np.full(shape, 7011), "evc": np.full(shape, 320),
            "fbfm": np.full(shape, 102), "slope": np.zeros(shape), "elev": np.full(shape, 1800.0)}
    base.update(over)
    return base


class TestCostGrid:
    def test_multipliers_by_class(self):
        evc = np.array([[320, 150, 210, 290], [100, 12, 11, 250], [31, 65, 15, 320]])
        fb = np.full((3, 4), 102)
        fb[0, 1] = 185          # timber + TL5 litter
        fb[2, 3] = 202          # slash
        r = cg.compute(**_grid(evc=evc, fbfm=fb))
        P = cg.pace_decode(r["pace"].astype(float))
        flat = 1 / cg.r_get(0)
        m = P / flat
        assert m[0, 0] == pytest.approx(1.0, rel=0.02)        # herb
        assert m[0, 1] == pytest.approx(8.0, rel=0.02)        # tree x litter
        assert m[0, 2] == pytest.approx(1.3, rel=0.02)        # shrub 10 %
        assert m[0, 3] == pytest.approx(3.7, rel=0.02)        # shrub 90 %
        assert m[1, 1] == pytest.approx(3.0, rel=0.02)        # snow
        assert r["pace"][1, 2] == cg.IMPASSABLE                # open water
        assert m[2, 3] == pytest.approx(5.0, rel=0.02)        # herb x slash
        v = r["veg"] & 0x0F
        assert v[0, 0] == cg.VEG_GRASS and v[0, 1] == cg.VEG_TIMBER_LITTER
        assert v[0, 2] == cg.VEG_SHRUB_LIGHT and v[0, 3] == cg.VEG_SHRUB_DENSE
        assert v[1, 2] == cg.VEG_WATER and v[2, 3] == cg.VEG_SLASH
        assert v[1, 0] == cg.VEG_SPARSE and v[2, 1] == cg.VEG_DEVELOPED

    def test_terrain_slope_and_impassable(self):
        slope = np.array([[0, 20, 30, 44], [46, 60, -9999, 10], [0, 0, 0, 0]], dtype=float)
        r = cg.compute(**_grid(slope=slope))
        P = cg.pace_decode(r["pace"].astype(float))
        assert P[0, 2] == pytest.approx(1 / cg.r_get(30), rel=0.02)
        assert r["pace"][1, 0] == cg.IMPASSABLE and r["pace"][1, 1] == cg.IMPASSABLE
        assert (r["veg"][1, 0] & 0x0F) == cg.VEG_STEEP
        assert r["pace"][1, 2] == cg.IMPASSABLE                # topo nodata
        assert r["dem"][1, 2] == -32768 and r["dem"][0, 0] == 1800

    def test_streams_and_water_masks(self):
        streams = np.zeros((3, 4), np.uint8)
        streams[0, 0] = 1
        water = np.zeros((3, 4), np.uint8)
        water[2, 2] = 1
        r = cg.compute(**_grid(streams=streams, water=water))
        assert r["veg"][0, 0] & cg.STREAM_BIT
        assert cg.pace_decode(float(r["pace"][0, 0])) == pytest.approx(5 / cg.r_get(0), rel=0.02)
        assert r["pace"][2, 2] == cg.IMPASSABLE and (r["veg"][2, 2] & 0x0F) == cg.VEG_WATER

    def test_rivers_are_impassable_water(self):
        # a river line blocks like open water and is no crossable "stream";
        # a creek beside it keeps GET's x5 and the stream bit
        streams = np.zeros((3, 4), np.uint8)
        streams[:, 1] = streams[:, 2] = 1
        rivers = np.zeros((3, 4), np.uint8)
        rivers[:, 2] = 1
        r = cg.compute(**_grid(streams=streams, rivers=rivers))
        assert (r["pace"][:, 2] == cg.IMPASSABLE).all()
        assert ((r["veg"][:, 2] & 0x0F) == cg.VEG_WATER).all()
        assert not (r["veg"][:, 2] & cg.STREAM_BIT).any()
        assert (r["veg"][:, 1] & cg.STREAM_BIT).all()
        assert cg.pace_decode(float(r["pace"][0, 1])) == pytest.approx(5 / cg.r_get(0), rel=0.02)
        assert r["stats"]["river_cells"] == 3 and r["stats"]["stream_cells"] == 3

    def test_fbfm_fallback_when_evc_nodata(self):
        evc = np.full((3, 4), -9999)
        fb = np.array([[102, 122, 145, 165], [99, 91, 92, 93], [183, 201, -9999, 102]])
        r = cg.compute(**_grid(evc=evc, fbfm=fb, evt=np.full((3, 4), -9999)))
        v = r["veg"] & 0x0F
        assert v[0, 0] == cg.VEG_GRASS and v[0, 1] == cg.VEG_SHRUB_LIGHT
        assert v[0, 2] == cg.VEG_SHRUB_DENSE and v[0, 3] == cg.VEG_TIMBER
        assert v[1, 0] == cg.VEG_SPARSE and v[1, 2] == cg.VEG_SNOW
        assert r["pace"][2, 2] == cg.IMPASSABLE  # all three veg layers nodata

    def test_mosaic_per_pixel(self):
        a25 = {k: np.array([[1, -9999], [3, 4]]) for k in ("evt", "evc", "fbfm")}
        a24 = {k: np.array([[10, 20], [30, 40]]) for k in ("evt", "evc", "fbfm")}
        a25["fbfm"] = np.array([[1, 2], [32767, 4]])
        out, label = cg.mosaic_versions(a25, a24)
        assert label == "LF2025+LF2024"
        assert out["evc"].tolist() == [[1, 20], [30, 4]]
        assert out["evt"].tolist() == [[1, 20], [30, 4]]  # consistent across products
        full = {k: np.ones((2, 2), int) for k in ("evt", "evc", "fbfm")}
        assert cg.mosaic_versions(full, a24)[1] == "LF2025"
        assert cg.mosaic_versions(None, a24)[1] == "LF2024"


class TestLandfireRequests:
    def test_snap_to_conus_grid(self):
        b = landfire.snap_5070((-1529010.0, 2474000.0, -1479020.0, 2524000.0), pad_m=0)
        assert (b[0] + 2362425) % 30 == 0 and (b[2] + 2362425) % 30 == 0
        assert (3267405 - b[3]) % 30 == 0 and (3267405 - b[1]) % 30 == 0
        assert b[0] <= -1529010 and b[2] >= -1479020 and b[1] <= 2474000 and b[3] >= 2524000
        assert landfire.size_of(b) == ((b[2] - b[0]) / 30, (b[3] - b[1]) / 30)

    def test_urls(self):
        b = (-1529025, 2473995, -1479015, 2524005)
        url, params = landfire.export_image_url("EVT", "LF2025", b)
        assert url.endswith("/Landfire_LF2025/LF2025_EVT_CONUS/ImageServer/exportImage")
        assert params["size"] == "1667,1667" and params["bboxSR"] == "5070"
        assert params["interpolation"] == "RSP_NearestNeighbor"
        url, _ = landfire.export_image_url("SlpD", "LF2025", b)
        assert "/Landfire_Topo/LF2020_SlpD_CONUS/" in url
        wurl, _ = landfire.wcs_url("FBFM40", "LF2024", b)
        assert "/conus_2024/wcs?" in wurl and "coverageId=landfire_wcs__LF2024_FBFM40_CONUS" in wurl
        assert "subset=X(-1529025,-1479015)" in wurl
        assert "/conus_topo/wcs?" in landfire.wcs_url("Elev", "LF2024", b)[0]


class TestNhdProducts:
    def test_hu8_filter(self, fixtures):
        doc = json.loads((fixtures / "routing" / "tnm_products_excerpt.json").read_text())
        items = nhd.parse_products(doc)
        assert [i["huc8"] for i in items] == ["17060201", "17060205"]
        assert all(i["url"].endswith("_HU8_GPKG.zip") for i in items)


def _connected(cells: set, a, b, n8: bool) -> bool:
    """Is cell b reachable from a through `cells` (4- or 8-neighbour)?"""
    steps = [(-1, 0), (1, 0), (0, -1), (0, 1)] + ([(-1, -1), (-1, 1), (1, -1), (1, 1)] if n8 else [])
    seen, todo = {a}, [a]
    while todo:
        r, c = todo.pop()
        for dr, dc in steps:
            n = (r + dr, c + dc)
            if n in cells and n not in seen:
                seen.add(n)
                todo.append(n)
    return b in seen


class TestHydro:
    GRID = {"x0": 0.0, "y0": 3000.0, "cell_m": 30, "width": 100, "height": 100}

    def test_river_by_order_name_or_osm(self):
        assert nhd.is_river({"name": "Agnes Creek", "order": 5})
        assert not nhd.is_river({"name": "Company Creek", "order": 4})
        assert nhd.is_river({"name": "Stehekin River", "order": 4})  # the upper reach
        assert not nhd.is_river({"name": "Rivers Creek", "order": None})
        assert not nhd.is_river({"name": None, "order": None})

    def test_lines_burn_4_connected(self):
        # a 45° line passes cell corners; sampling alone would leave a
        # diagonal-only chain that 8-neighbour moves could slip through
        # (A* forbids only moves that cut a blocked corner)
        xy = np.array([[15.0, 2985.0], [2385.0, 615.0]])
        r, c = nhd._line_cells(xy, self.GRID)
        cells = set(zip(r.tolist(), c.tolist()))
        assert (0, 0) in cells and (79, 79) in cells
        assert _connected(cells, (0, 0), (79, 79), n8=False)

    def test_names_rivers_first_and_truncated(self, monkeypatch):
        def line(y, x1):
            return np.array([[0.0, y], [x1, y]])
        lines = [({"name": "Long Creek", "river": False}, line(2900, 2900)),
                 ({"name": "Short River", "river": True}, line(2000, 600)),
                 ({"name": None, "river": True}, line(1500, 2900)),
                 ({"name": "Long Creek", "river": False}, line(1000, 300)),
                 ({"name": "Tiny Creek", "river": False}, line(500, 100))]
        out = nhd.burn_lines(lines, self.GRID)
        assert out["names"] == ["Short River", "Long Creek", "Tiny Creek"] and not out["truncated"]
        assert out["rivers"].sum() == out["rivers"][[33, 50]].sum() > 0  # only the two river rows
        assert out["streams"][[3, 33, 50, 66, 83]].any(axis=1).all()
        assert set(np.unique(out["stream_id"][3])) == {0, 2}
        # a river crossing a creek keeps its own name at the shared cell
        cross = nhd.burn_lines([({"name": "Long Creek", "river": False}, line(1515, 2900)),
                                ({"name": "Short River", "river": True},
                                 np.array([[1515.0, 2900.0], [1515.0, 100.0]]))], self.GRID)
        assert cross["stream_id"][49, 50] == 1
        monkeypatch.setattr(nhd, "MAX_NAMES", 2)
        out = nhd.burn_lines(lines, self.GRID)
        assert out["names"] == ["Short River", "Long Creek"] and out["truncated"]
        assert out["stream_id"][83].max() == 0 and out["streams"][83].any()  # nameless, still a creek

    def test_sisi_fords_are_blocked(self, fixtures):
        # Real SISI inputs around the two fords the first real-data review
        # found. The Stehekin (order 6; also an OSM river) and Agnes Creek
        # (order 5; an OSM *stream*, so only NHD's order catches it) must be
        # walls, and the cross-country leg the router drew across the
        # Stehekin from Company Creek Road must hit one.
        doc = json.loads((fixtures / "routing" / "sisi_river_fords.json").read_text())
        for box in ("stehekin", "agnes"):
            w, s, e, n = doc["boxes"][box]
            x0, y1 = gb.utm.fwd(w, s, 10)
            x1, y0 = gb.utm.fwd(e, n, 10)
            grid = {"x0": x0 // 30 * 30, "y0": (y0 // 30 + 1) * 30, "cell_m": 30,
                    "width": int((x1 - x0) // 30) + 2, "height": int((y0 - y1) // 30) + 2}
            lines = []
            for f in doc["nhd"] + doc["osm"]:
                if f["box"] == box:
                    p = f["props"]
                    river = nhd.is_river(p) if "order" in p else True
                    xs, ys = gb.utm.fwd(*np.asarray(f["coords"]).T, 10)
                    lines.append(({"name": p["name"], "river": river}, np.column_stack([xs, ys])))
            out = nhd.burn_lines(lines, grid)

            def cell(lon, lat):
                x, y = gb.utm.fwd(lon, lat, 10)
                return int((grid["y0"] - y) // 30), int((x - grid["x0"]) // 30)

            if box == "stehekin":
                assert out["names"][0] == "Stehekin River"
                leg = np.column_stack(gb.utm.fwd(np.array([-120.747356, -120.743095]),
                                                 np.array([48.363017, 48.365709]), 10))
                r, c = nhd._line_cells(leg, grid)
                hit = out["rivers"][r, c]
                assert hit.any() and out["stream_id"][r, c][hit].max() == 1
            else:
                assert out["names"][0] == "Agnes Creek"
                # the crossing cell's river runs edge to edge across the box
                r0, c0 = cell(-120.86918, 48.36366)
                riv = {(int(r), int(c)) for r, c in zip(*np.nonzero(out["rivers"]))}
                start = min(riv, key=lambda rc: abs(rc[0] - r0) + abs(rc[1] - c0))
                assert abs(start[0] - r0) + abs(start[1] - c0) <= 2
                comp = {rc for rc in riv if _connected(riv, start, rc, n8=True)}
                h, w = out["rivers"].shape
                edges = {"n" for r, _ in comp if r == 0} | {"s" for r, _ in comp if r == h - 1} \
                    | {"w" for _, c in comp if c == 0} | {"e" for _, c in comp if c == w - 1}
                assert len(edges) >= 2, edges
            # small perennial creeks stay crossable
            assert (out["streams"] & ~out["rivers"]).sum() > 0


class TestOsmWater:
    NODES = {i: (-120.0 + 0.001 * i, 48.0) for i in range(1, 12)}

    def test_waterways(self):
        ways = [
            {"id": 1, "nodes": [1, 2, 3], "tags": {"waterway": "river", "name": "Stehekin River"}},
            {"id": 2, "nodes": [3, 4], "tags": {"waterway": "river", "intermittent": "yes"}},
            {"id": 3, "nodes": [4, 5], "tags": {"waterway": "river", "tunnel": "culvert"}},
            {"id": 4, "nodes": [5, 6], "tags": {"waterway": "stream", "name": "Agnes Creek"}},
            {"id": 5, "nodes": [6, 7, 8, 6], "tags": {"natural": "water", "water": "river"}},
            {"id": 6, "nodes": [8, 9, 10], "tags": {"waterway": "riverbank"}},  # a relation's piece
            {"id": 7, "nodes": [9, 10], "tags": {"waterway": "canal"}},
            {"id": 8, "nodes": [1, 11], "tags": {"highway": "path"}},
        ]
        lines, areas = osm_extract.waterways(self.NODES, ways)
        assert [p["id"] for p, _ in lines] == [1, 7] and lines[0][0]["name"] == "Stehekin River"
        assert [p["id"] for p, _ in areas] == [5] and len(areas[0][1]) == 4
        h = osm_extract.water_hash(lines, areas)
        assert h == osm_extract.water_hash(list(reversed(lines)), areas)
        moved = [(lines[0][0], [(x, y + 1e-4) for x, y in lines[0][1]]), lines[1]]
        assert h != osm_extract.water_hash(moved, areas)

    def test_filter_keeps_water(self):
        assert "w/highway" in osm_extract.TAGS_FILTER
        assert any("waterway=river" in f for f in osm_extract.TAGS_FILTER)


class TestGeofabrik:
    INDEX = {"features": [
        {"properties": {"id": "north-america", "urls": {"pbf": "x"}},
         "geometry": {"type": "Polygon", "coordinates": [[[-170, 10], [-50, 10], [-50, 80], [-170, 80], [-170, 10]]]}},
        {"properties": {"id": "us", "parent": "north-america", "urls": {"pbf": "x"}},
         "geometry": {"type": "Polygon", "coordinates": [[[-125, 24], [-66, 24], [-66, 50], [-125, 50], [-125, 24]]]}},
        {"properties": {"id": "us/idaho", "parent": "us", "urls": {"pbf": "https://d/idaho-latest.osm.pbf"}},
         "geometry": {"type": "Polygon", "coordinates": [[[-117.3, 42], [-111, 42], [-111, 49], [-117.3, 49], [-117.3, 42]]]}},
        {"properties": {"id": "us/montana", "parent": "us", "urls": {"pbf": "https://d/montana-latest.osm.pbf"}},
         "geometry": {"type": "Polygon", "coordinates": [[[-116, 44.4], [-104, 44.4], [-104, 49], [-116, 49], [-116, 44.4]]]}},
        {"properties": {"id": "us/california", "parent": "us", "urls": {"pbf": "https://d/ca.pbf"}},
         "geometry": {"type": "Polygon", "coordinates": [[[-124.5, 32.5], [-114, 32.5], [-114, 42], [-124.5, 42], [-124.5, 32.5]]]}},
        {"properties": {"id": "us/california/norcal", "parent": "us/california", "urls": {"pbf": "https://d/norcal.pbf"}},
         "geometry": {"type": "Polygon", "coordinates": [[[-124.5, 35.8], [-114, 35.8], [-114, 42], [-124.5, 42], [-124.5, 35.8]]]}},
        {"properties": {"id": "us/california/socal", "parent": "us/california", "urls": {"pbf": "https://d/socal.pbf"}},
         "geometry": {"type": "Polygon", "coordinates": [[[-121, 32.5], [-114, 32.5], [-114, 35.8], [-121, 35.8], [-121, 32.5]]]}},
    ]}

    def test_leaves_and_state_line(self):
        regions = osm_extract.us_leaf_regions(self.INDEX)
        ids = sorted(r["id"] for r in regions)
        assert ids == ["us/california/norcal", "us/california/socal", "us/idaho", "us/montana"]
        assert osm_extract.regions_for_bbox(regions, (-115.3, 44.0, -114.6, 44.3)) == ["us/idaho"]
        assert osm_extract.regions_for_bbox(regions, (-115.3, 44.2, -114.6, 44.6)) == [
            "us/idaho", "us/montana"]
        assert osm_extract.regions_for_bbox(regions, (-119, 35.5, -118, 36.2)) == [
            "us/california/norcal", "us/california/socal"]
        # a box entirely inside one polygon (no edge crossings)
        assert osm_extract.regions_for_bbox(regions, (-112, 46, -111.9, 46.1)) == [
            "us/idaho", "us/montana"]
        assert osm_extract.regions_for_bbox(regions, (-108, 46, -107.9, 46.1)) == ["us/montana"]

    def test_live_index_shape(self, fixtures):
        # 12 features of index-v1.json as served 2026-09-25, verbatim: states
        # are parented to "north-america" (not "us"), California's children
        # are "norcal"/"socal", and "us", "us-west", "us-pacific" are leaves.
        index = json.loads((fixtures / "routing" / "geofabrik_index_excerpt.json").read_text())
        regions = osm_extract.us_leaf_regions(index)
        assert sorted(r["id"] for r in regions) == [
            "norcal", "socal", "us/idaho", "us/oregon", "us/washington"]
        wa = next(r for r in regions if r["id"] == "us/washington")
        assert wa["pbf"] == "https://download.geofabrik.de/north-america/us/washington-latest.osm.pbf"
        # the SISI fire's AOI (North Cascades, 2026-09-25)
        sisi = (-120.984579, 48.238661, -120.661058, 48.464635)
        assert osm_extract.regions_for_bbox(regions, sisi) == ["us/washington"]
        # on the BC line: Canada is never picked
        assert osm_extract.regions_for_bbox(regions, (-120.2, 48.9, -120.0, 49.1)) == ["us/washington"]
        assert osm_extract.regions_for_bbox(regions, (-119, 35.5, -118, 36.2)) == ["norcal", "socal"]

    def test_osm_date(self):
        assert osm_extract.osm_date_from_url(
            "https://download.geofabrik.de/north-america/us/idaho-260923.osm.pbf") == "2026-09-23"
        assert osm_extract.osm_date_from_url("https://x/idaho-latest.osm.pbf") is None


class TestOpl:
    def test_parse(self):
        lines = [
            "n1 x-115.0000000 y44.0000000\n", "n2 x-115.0010000 y44.0000000\n",
            "n3 T x-115.0020000 y44.0010000\n",
            "w10 Thighway=path,name=Iron%20%Creek%2c%%20%Upper,sac_scale=hiking Nn1,n2,n3\n",
            "w11 T Nn3\n",
        ]
        nodes, ways = osm_extract.parse_opl(lines)
        assert nodes[3] == (-115.002, 44.001)
        assert ways[0]["tags"]["name"] == "Iron Creek, Upper"
        assert ways[0]["nodes"] == [1, 2, 3] and ways[1]["tags"] == {}


def _ll(i, j):
    """grid-ish lon/lat near (-115, 44)."""
    return (-115.0 + i * 0.001, 44.0 + j * 0.001)


class TestGraphBuild:
    def _osm(self):
        nodes = {k: _ll(*v) for k, v in {
            1: (0, 0), 2: (5, 0), 3: (10, 0), 4: (5, 5), 5: (5, -5),
            6: (0, 3), 7: (10, 3), 8: (20, 0), 9: (5, 10)}.items()}
        ways = [
            {"id": 100, "nodes": [1, 2, 3], "tags": {"highway": "track", "name": "FS 619"}},
            {"id": 101, "nodes": [5, 2, 4], "tags": {"highway": "path"}},  # crosses at shared node 2
            # a bridge over the track without a shared node: must NOT connect
            {"id": 102, "nodes": [6, 7], "tags": {"highway": "path", "bridge": "yes"}},
            {"id": 103, "nodes": [3, 8], "tags": {"highway": "motorway"}},  # excluded
            {"id": 104, "nodes": [4, 9], "tags": {"highway": "path", "sac_scale": "difficult_alpine_hiking"}},
            {"id": 105, "nodes": [1, 6], "tags": {"highway": "footway", "access": "private"}},
        ]
        return nodes, ways

    def test_topology_by_node_id(self):
        nodes, ways = self._osm()
        x0, y0 = gb.utm.fwd(-115.01, 44.02, 11)
        x1, y1 = gb.utm.fwd(-114.97, 43.99, 11)
        g = gb.osm_graph(nodes, ways, zone=11, northern=True, rect=(x0, y1, x1, y0))
        # 100 splits at 2 into two edges; 101 splits at 2; 102 whole; 105 whole
        assert len(g.edges) == 6
        deg = {}
        for e in g.edges:
            deg[e.a] = deg.get(e.a, 0) + 1
            deg[e.b] = deg.get(e.b, 0) + 1
        assert sorted(deg.values()).count(4) == 1  # only node 2 is a 4-way junction
        bridge = [e for e in g.edges if e.flags & gb.F_BRIDGE][0]
        assert bridge.kind == gb.KIND_PATH
        assert any(e.flags & gb.F_RESTRICTED for e in g.edges)  # private kept, flagged
        assert not any(e.sac >= 5 for e in g.edges)

    def test_clip_splits_runs(self):
        nodes, ways = self._osm()
        x0, _ = gb.utm.fwd(-115.0005, 44.0, 11)
        xa, ya = gb.utm.fwd(-114.9925, 44.02, 11)
        _, yb = gb.utm.fwd(-115.0, 43.99, 11)
        g = gb.osm_graph(nodes, [ways[0]], zone=11, northern=True, rect=(x0 + 30, yb, xa, ya))
        # node 1 is outside -> the track starts at node 2
        assert len(g.edges) == 1 and len(g.edges[0].xy) == 2

    def _line(self, lons, lat):
        pts = [gb.utm.fwd(lo, lat, 11) for lo in lons]
        return [(float(x), float(y)) for x, y in pts]

    def test_conflation_names_covered_osm_and_adds_uncovered(self):
        nodes, ways = self._osm()
        rect = (*gb.utm.fwd(-115.01, 43.99, 11), *gb.utm.fwd(-114.97, 44.02, 11))
        g = gb.osm_graph(nodes, [ways[0]], zone=11, northern=True, rect=rect)
        # agency trail duplicating the track, 3 m off
        dup = [(x, y + 3) for x, y in self._line(np.linspace(-115.0, -114.99, 30), 44.0)]
        # agency trail away from everything, ending 6 m from the track's end node 3
        ex, ey = gb.utm.fwd(-114.99, 44.0, 11)
        far = [(ex + 6, ey + 6), (ex + 300, ey + 400), (ex + 600, ey + 900)]
        props = {"tid": "usfs:1", "agency": "USFS", "name": "Iron Creek", "num": "640",
                 "restr": "Hiker restricted 01/01–12/31", "season": None, "mgmt": "Wilderness",
                 "status": "open"}
        st = gb.conflate(g, [(props, dup), (dict(props, tid="usfs:2", name="Alpine Way",
                                                 num="528", restr=None), far)], log=lambda *_: None)
        assert st["agency_dropped_covered"] == 1 and st["agency_runs_added"] == 1
        named = [e for e in g.edges if e.flags & gb.F_AGENCY_NAMED]
        assert named and all(e.name == "FS 619" for e in named)  # OSM name wins
        assert all(e.ref == "640" and e.note.startswith("Hiker") for e in named)
        added = [e for e in g.edges if e.kind == gb.KIND_AGENCY][0]
        assert added.name == "Alpine Way #528" and added.src == gb.SRC_USFS
        # snapped onto the OSM track's end node (within 10 m) -> connected
        track_nodes = {e.a for e in g.edges if e.src == gb.SRC_OSM} | {
            e.b for e in g.edges if e.src == gb.SRC_OSM}
        assert added.a in track_nodes

    def test_offset_agency_copy_is_not_braided_in(self, fixtures, monkeypatch):
        # Real SISI inputs: NPS "Agnes Creek Trail (PCT)" runs 10-50 m off
        # the OSM PCT for long stretches. Only runs that stray well beyond
        # that (>= 60 m of them past 40 m) are trails OSM lacks.
        from responder_worker import routing_bundle as rb
        doc = json.loads((fixtures / "routing" / "sisi_agnes_conflation.json").read_text())
        rect = gb.utm.bbox_lonlat_to_utm(tuple(doc["bbox"]), 10, True)

        def run():
            nodes = {int(k): tuple(v) for k, v in doc["nodes"].items()}
            g = gb.osm_graph(nodes, doc["ways"], zone=10, northern=True, rect=rect)
            ag = rb.project_trails([(f["props"], [tuple(c) for c in f["coords"]])
                                    for f in doc["agency"]], zone=10, northern=True, rect=rect)
            return g, gb.conflate(g, ag, log=lambda *_: None)

        g, st = run()
        assert st["agency_runs_added"] == 2 and st["agency_runs_parallel"] == 3
        osm = np.concatenate([gb.densify(e.xy, 5.0)[0] for e in g.edges if e.src == gb.SRC_OSM])
        for e in (e for e in g.edges if e.kind == gb.KIND_AGENCY):
            p, _ = gb.densify(e.xy, 10.0)
            d = np.array([np.hypot(osm[:, 0] - x, osm[:, 1] - y).min() for x, y in p.tolist()])
            assert (d > gb.SAME_TRAIL_M).sum() * 10 >= gb.MIN_AGENCY_RUN_M
        # the old single 20 m tolerance braided all five uncovered runs in
        monkeypatch.setattr(gb, "SAME_TRAIL_M", gb.COVER_M)
        assert run()[1]["agency_runs_added"] == 5

    def test_snap_splits_segment(self):
        g = gb.Graph()
        a, b = g.add_node(0, 0), g.add_node(1000, 0)
        g.edges.append(gb.Edge(a, b, [(0, 0), (1000, 0)], gb.KIND_TRACK))
        props = {"tid": "t", "agency": "BLM", "name": None, "num": None, "status": "not_assessed"}
        st = gb.conflate(g, [(props, [(400, 20), (400, 300), (400, 600)])], log=lambda *_: None)
        assert st["snapped"] == 1 and len(g.edges) == 3
        mid = [n for n in range(len(g.nodes)) if g.nodes[n] == (400.0, 0.0)]
        assert mid, g.nodes
        ag = [e for e in g.edges if e.kind == gb.KIND_AGENCY][0]
        assert ag.a == mid[0] and ag.flags & gb.F_NOT_ASSESSED

    def test_rdg1_round_trip(self):
        nodes, ways = self._osm()
        rect = (*gb.utm.fwd(-115.01, 43.99, 11), *gb.utm.fwd(-114.97, 44.02, 11))
        g = gb.osm_graph(nodes, ways, zone=11, northern=True, rect=rect)
        x0, y0 = rect[0], rect[3]
        blob = gb.encode_rdg1(g, epsg=32611, x0=x0, y0=y0)
        assert blob == gb.encode_rdg1(g, epsg=32611, x0=x0, y0=y0)  # deterministic
        d = gb.decode_rdg1(blob)
        assert d["epsg"] == 32611 and len(d["from"]) == len(g.edges)
        for ei, e in enumerate(g.edges):
            start = d["nodes"][d["from"][ei]].astype(np.int64)
            path = start + np.cumsum(d["deltas"][d["dstart"][ei]:d["dstart"][ei + 1]], axis=0)
            assert tuple(path[-1]) == tuple(d["nodes"][d["to"][ei]])
            ex = (e.xy[-1][0] - x0) * 10
            assert abs(path[-1][0] - ex) <= 1
        names = {d["strings"][i] for i in d["name"] if i != gb.NONE}
        assert "FS 619" in names

    def test_long_segments_split_to_int16(self):
        g = gb.Graph()
        a, b = g.add_node(0, 0), g.add_node(8000, -5000)
        g.edges.append(gb.Edge(a, b, [(0, 0), (8000, -5000)], gb.KIND_PAVED))
        d = gb.decode_rdg1(gb.encode_rdg1(g, epsg=32611, x0=0, y0=0))
        assert len(d["deltas"]) >= 3
        assert np.abs(d["deltas"]).max() <= gb.MAX_DELTA_DM
        assert d["deltas"].sum(axis=0).tolist() == [80000, 50000]

    def test_stats_and_hashes(self):
        nodes, ways = self._osm()
        rect = (*gb.utm.fwd(-115.01, 43.99, 11), *gb.utm.fwd(-114.97, 44.02, 11))
        g = gb.osm_graph(nodes, ways, zone=11, northern=True, rect=rect)
        s = gb.graph_stats(g)
        # the bridge path joins the rest only through the private footway (105)
        assert s["edges"] == 6 and s["components"] == 1
        g2 = gb.osm_graph(nodes, ways[:-1], zone=11, northern=True, rect=rect)
        assert gb.graph_stats(g2)["components"] == 2
        h1 = gb.osm_hash(nodes, ways)
        assert h1 == gb.osm_hash(nodes, list(reversed(ways)))
        assert h1 != gb.osm_hash(nodes, ways[:-1])
