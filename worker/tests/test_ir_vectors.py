import shutil
import zipfile

import pytest



def test_classify_kmz_layer():
    from responder_worker.ir_vectors import _classify_kmz_layer

    assert _classify_kmz_layer("Intense Heat") == "Intense"
    assert _classify_kmz_layer("Scattered Heat") == "Scattered"
    assert _classify_kmz_layer("Isolated Fires") == "Isolated"
    assert _classify_kmz_layer("Estimated Perimeter") == "Perimeter"
    assert _classify_kmz_layer("Fire Perimeter") == "Perimeter"
    assert _classify_kmz_layer("Heat Perimeter") == "Perimeter"
    # NIROPS placemark names
    assert _classify_kmz_layer("Imagery Obscured") == "Obscured"
    assert _classify_kmz_layer("Cloud AOI") == "Obscured"
    assert _classify_kmz_layer("NoData") == "Obscured"
    assert _classify_kmz_layer("Cloud Cover") == "Obscured"
    assert _classify_kmz_layer("Possible Heat") == "Possible"
    assert _classify_kmz_layer("Legend 1") is None
    assert _classify_kmz_layer("Layers for Google Earth KMZ") is None
    assert _classify_kmz_layer("20260924_Sisi_IR") is None
    assert _classify_kmz_layer("None") is None


def test_ir_backlog_flags_unconverted_flights():
    from responder_worker.cli import _ir_backlog
    from responder_worker.ir_vectors import IR_CONVERTER_VERSION as V

    state = {
        "ir": {"vectors/ir/big-grass/20260818_c0230_Aircraft1.geojson":
               {"heat_types": ["Intense"], "v": V}},
        "incidents": {
            "gb/2026_Bear_Trap": {
                "fire_slug": "bear-trap",
                "files": {
                    "ir/20260819/20260819_c0800_Bear_Trap_Aircraft3_All.kmz": {},
                    "ir/20260819/20260819_c0800_Bear_Trap_Aircraft3_All.pdf": {},
                },
            },
            "gb/2026_Big_Grass": {
                "fire_slug": "big-grass",
                "files": {"ir/20260818/x_Shapefiles.zip": {}},
            },
            "gb/2026_No_IR": {"fire_slug": "no-ir", "files": {"qr/ops.pdf": {}}},
        },
    }
    assert _ir_backlog(state, lambda *_: None) == {"gb/2026_Bear_Trap"}

    # failed attempts count as attempted — no retry loop
    state["ir"]["vectors/ir/bear-trap/20260819_c0800_Aircraft3.geojson"] = {
        "failed": True, "v": V}
    assert _ir_backlog(state, lambda *_: None) == set()

    # ...but only under the current converter: a bump redoes every flight,
    # successes included (they pick up the new classes + flight time)
    state["ir"]["vectors/ir/bear-trap/20260819_c0800_Aircraft3.geojson"] = {
        "failed": True, "v": V - 1}
    state["ir"]["vectors/ir/big-grass/20260818_c0230_Aircraft1.geojson"] = {
        "heat_types": ["Intense"]}
    assert _ir_backlog(state, lambda *_: None) == {
        "gb/2026_Bear_Trap", "gb/2026_Big_Grass"}


def test_regroup_flat_coords():
    from responder_worker.ir_vectors import _COORDS_RE, _regroup_flat_coords

    def fix(body):
        return _COORDS_RE.sub(_regroup_flat_coords, body)

    assert fix(b"<coordinates>1.5,2.5,0,3.5,4.5,0</coordinates>") == \
        b"<coordinates>1.5,2.5,0 3.5,4.5,0</coordinates>"
    # already standard, a single tuple, or ambiguous (2D / nonzero every 3rd)
    for body in (b"<coordinates>1,2,0 3,4,0</coordinates>",
                 b"<coordinates>1,2,0</coordinates>",
                 b"<coordinates>1,2,3,4,5,6</coordinates>"):
        assert fix(body) == body


def test_extract_kml_fallback(tmp_path):
    from responder_worker import ir_vectors

    kml = ('<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2">'
           '<Document><Folder><name>Isolated Fires</name></Folder></Document></kml>')
    kmz = tmp_path / "flight.kmz"
    with zipfile.ZipFile(kmz, "w") as zf:
        zf.writestr("files/legend.png", b"png")
        zf.writestr("doc.kml", kml)
    out = ir_vectors._extract_kml(kmz, tmp_path)
    assert out is not None and out.read_text() == kml

    assert ir_vectors._extract_kml(tmp_path / "flight.kmz", tmp_path) is not None
    bad = tmp_path / "not.kmz"
    bad.write_bytes(b"not a zip")
    assert ir_vectors._extract_kml(bad, tmp_path) is None


# NIROPS layout: no folders — one layer named after the file, one named
# placemark per heat class, empty placemarks for classes with nothing.
# The comma-only coordinate lists are NIROPS's too.
def _nirops_kml(time_line="1925 (PDT)"):
    def ring(x0, y0, d):
        # NIROPS writes one flat comma list, not whitespace-separated tuples
        pts = [(x0, y0), (x0 + d, y0), (x0 + d, y0 + d), (x0, y0 + d), (x0, y0)]
        return ("<Polygon><outerBoundaryIs><LinearRing><coordinates>"
                + ",".join(f"{x},{y},0" for x, y in pts)
                + "</coordinates></LinearRing></outerBoundaryIs></Polygon>")

    def placemark(name, geoms):
        return (f"<Placemark><name>{name}</name><styleUrl>#s</styleUrl>"
                f"<MultiGeometry>{geoms}</MultiGeometry></Placemark>")

    pt = "<Point><coordinates>{},{},0</coordinates></Point>".format
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
        "<name>20260924_Sisi_IR</name><description><![CDATA["
        "<b> Image Acquisition Date: </b> 20260923 <br/>"
        f"<b> Image Acquisition Time: </b> {time_line} <br/> <br/>]]>"
        "</description>"
        + placemark("Heat Perimeter", ring(-120.84, 48.34, 0.02))
        + placemark("Intense Heat", ring(-120.835, 48.345, 0.005))
        + placemark("Isolated Heat", pt(-120.81, 48.36) + pt(-120.80, 48.37))
        + placemark("Scattered Heat", ring(-120.83, 48.35, 0.004))
        + placemark("Imagery Obscured", "")
        + placemark("Possible Heat", pt(-120.815, 48.381))
        + "</Document></kml>")


@pytest.mark.skipif(shutil.which("ogr2ogr") is None, reason="ogr2ogr not installed")
def test_process_ir_zip_reads_cloud_cover_as_obscured(tmp_path):
    from pathlib import Path

    from responder_worker import ir_vectors

    # the Elk flight's shapefiles, plus a Cloud_Cover set (as Timber's zip
    # carries) cloned from its Scattered polygons
    src = Path(__file__).parent / "fixtures" / "elk_ir_shp.zip"
    zp = tmp_path / "flight_Shapefiles.zip"
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(zp, "w") as zout:
        for zi in zin.infolist():
            data = zin.read(zi)
            zout.writestr(zi, data)
            if "_Scattered." in zi.filename and ".lock" not in zi.filename:
                zout.writestr(zi.filename.replace("_Scattered.", "_Cloud_Cover."), data)
    info = ir_vectors.process_ir_zip(zp, tmp_path / "out.geojson", flight_id="f")
    assert info["heat_types"][-1] == "Obscured"
    assert set(info["heat_types"]) >= {"Perimeter", "Isolated", "Obscured"}

def test_parse_flight_time():
    from responder_worker.ir_vectors import parse_flight_time

    # NIROPS: local clock + zone -> UTC instant
    assert parse_flight_time(_nirops_kml()) == {
        "flown_at": "2026-09-24T02:25:00Z", "flown_date": None}
    assert parse_flight_time(_nirops_kml("0126 (MDT)"))["flown_at"] == \
        "2026-09-23T07:26:00Z"
    # blank time, or a zone we can't place: the date alone
    for line in ("(PDT)", "1925 (XYZ)"):
        assert parse_flight_time(_nirops_kml(line)) == {
            "flown_at": None, "flown_date": "2026-09-23"}
    # ArcGIS export: attribute rows, already UTC
    arc = ("<description><![CDATA[<table><tr><td>Production</td>"
           "<td>9/4/2026</td></tr><tr><td>Time_UTC</td><td>0445Z</td>"
           "</tr></table>]]></description>")
    assert parse_flight_time(arc) == {
        "flown_at": "2026-09-04T04:45:00Z", "flown_date": None}
    assert parse_flight_time(arc.replace("0445Z", "")) == {
        "flown_at": None, "flown_date": "2026-09-04"}
    assert parse_flight_time("<kml><Document/></kml>") == {
        "flown_at": None, "flown_date": None}


def _write_kmz(path, kml):
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("doc.kml", kml)
        zf.writestr("legend.png", b"png")
    return path


@pytest.mark.skipif(shutil.which("ogr2ogr") is None, reason="ogr2ogr not installed")
@pytest.mark.parametrize("gdal_skip", ["", "LIBKML"])  # CI GDAL may lack LIBKML
def test_process_ir_kmz_classifies_nirops_placemarks(tmp_path, monkeypatch, gdal_skip):
    import json

    from responder_worker import ir_vectors

    monkeypatch.setenv("GDAL_SKIP", gdal_skip)
    kmz = _write_kmz(tmp_path / "20260924_Sisi_IR.kmz", _nirops_kml())
    out = tmp_path / "out.geojson"
    info = ir_vectors.process_ir_kmz(kmz, out, flight_id="f1")
    # the empty "Imagery Obscured" placemark is dropped, not a class
    assert info["heat_types"] == [
        "Perimeter", "Intense", "Isolated", "Scattered", "Possible"]
    fc = json.loads(out.read_text())
    by_heat = {}
    for f in fc["features"]:
        assert set(f["properties"]) == {"heat_type", "flight_id"}
        by_heat.setdefault(f["properties"]["heat_type"], []).append(
            f["geometry"]["type"])
    assert by_heat["Isolated"] in (["MultiPoint"], ["Point", "Point"])
    assert by_heat["Possible"] in (["Point"], ["MultiPoint"])
    assert "Polygon" in by_heat["Intense"][0]
    assert info["feature_count"] == len(fc["features"])
    # every ring keeps all 5 vertices (the classic KML driver reads only the
    # first vertex of a flat list unless it is regrouped)
    for f in fc["features"]:
        g = f["geometry"]
        polys = ([g["coordinates"]] if g["type"] == "Polygon"
                 else g["coordinates"] if g["type"] == "MultiPolygon" else [])
        for poly in polys:
            assert [len(r) for r in poly] == [5]
    # 6-decimal coordinates keep the file small
    assert "-120.84," in out.read_text() or "-120.84]" in out.read_text()


@pytest.mark.skipif(shutil.which("ogr2ogr") is None, reason="ogr2ogr not installed")
def test_ir_flights_converts_kmz_and_caches_under_the_converter_version(tmp_path):
    from types import SimpleNamespace

    from responder_worker import cli, frames, ir_vectors
    from responder_worker.mirror import MirroredFile

    kmz = _write_kmz(tmp_path / "20260924_Sisi_IR.kmz", _nirops_kml())
    put = {}
    storage = SimpleNamespace(
        put_file=lambda key, p: put.__setitem__(key, p.read_text()),
        get_file=lambda key, p: False)

    def mf(name, local):
        return MirroredFile(
            kind="ir", filename=name, key=f"raw/incidents/sisi/ir/20260924/{name}",
            url="", size=1, sha16=None, rev=1, local_path=local, changed=True,
            rel_dir="ir/20260924")

    by_flight = {"ir/20260924": {"files": [
        mf("20260924_Sisi_IR_11x17_Aerial.pdf", None),
        mf("20260924_Sisi_IR.kmz", kmz),
    ]}}
    fire = {"fire_slug": "sisi", "post_title": "Sisi"}
    key = "vectors/ir/sisi/20260924_IR_11x17_Aerial.geojson"
    # a failure recorded by the old converter must not block the retry
    state = {"ir": {key: {"failed": True, "v": ir_vectors.IR_CONVERTER_VERSION - 1}}}
    frames.start_deadline(0)  # disarmed

    [flight] = cli._ir_flights(None, storage, state, fire, by_flight)
    assert flight["flight_date"] == "2026-09-24"   # FTP folder
    assert flight["flown_at"] == "2026-09-24T02:25:00Z"  # KMZ: 9/23 19:25 PDT
    assert flight["flown_date"] is None
    assert flight["geojson_url"] == f"/{key}"
    assert "Possible" in flight["heat_types"]
    assert key in put
    assert state["ir"][key]["v"] == ir_vectors.IR_CONVERTER_VERSION

    # the next rebuild replays from cache: no local file, no download
    by_flight["ir/20260924"]["files"][1].local_path = None
    put.clear()
    [again] = cli._ir_flights(None, storage, state, fire, by_flight)
    assert again == flight and not put


def test_ir_flights_keeps_an_older_result_when_it_cannot_reconvert(monkeypatch):
    from types import SimpleNamespace

    from responder_worker import cli, frames
    from responder_worker.mirror import MirroredFile

    by_flight = {"ir/20260818": {"files": [MirroredFile(
        kind="ir", filename="20260818_c0800_Elk_Aircraft3_Shapefiles.zip",
        key="raw/incidents/elk/ir/20260818/x.zip", url="", size=1, sha16=None,
        rev=1, local_path=None, changed=False, rel_dir="ir/20260818")]}}
    key = "vectors/ir/elk/20260818_c0800_Aircraft3.geojson"
    fire = {"fire_slug": "elk", "post_title": "Elk"}
    storage = SimpleNamespace(get_file=lambda *_: False, put_file=lambda *_: None)

    # a run whose GDAL install failed: serve the pre-bump result, record nothing
    monkeypatch.setattr(cli.shutil, "which", lambda _: None)
    frames.start_deadline(0)
    state = {"ir": {key: {"heat_types": ["Perimeter"]}}}
    [flight] = cli._ir_flights(None, storage, state, fire, by_flight)
    assert flight["geojson_url"] == f"/{key}"
    assert flight["flown_at"] is None
    assert state["ir"][key] == {"heat_types": ["Perimeter"]}
