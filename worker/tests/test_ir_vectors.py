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


SISI = "{5151510A-0000-4000-8000-000000000001}"
BEAR_TRAP = "{1BB1F12F-DB68-40B0-8D7B-FA0E4FCEE2E4}"
THUMB = "{5E0A1B2C-0000-4000-8000-0000000000F1}"
SIOUX = "{51000000-0000-4000-8000-0000000000A2}"


def _fk(cornea_id):
    from responder_worker.fires import fire_key
    return fire_key(cornea_id)


def _bound(cornea_id, slug, **files):
    """A record bound by unit_id; files by rel, each with a sha16."""
    return {"fire_slug": slug, "storage_prefix": slug, "cornea_id": cornea_id,
            "match": {"method": "unit_id"},
            "files": {rel.replace("__", "/"): dict({"kind": "ir", "sha16": f"{i:016x}"}, **meta)
                      for i, (rel, meta) in enumerate(files.items(), 1)}}


def test_ir_backlog_counts_per_record_and_owner():
    from responder_worker.cli import _ir_backlog
    from responder_worker.ir_vectors import IR_CONVERTER_VERSION as V

    fires = {_fk(BEAR_TRAP): {"cornea_id": BEAR_TRAP, "post_title": "Bear Trap"},
             _fk(THUMB): {"cornea_id": THUMB, "post_title": "Thumb"},
             _fk(SISI): {"cornea_id": SISI, "post_title": "Sisi"}}
    kmz = "ir/20260819/20260819_c0800_Bear_Trap_Aircraft3_All.kmz"
    thumb_kmz = "ir/20260819/20260819_c0900_Thumb_Aircraft3_All.kmz"
    sisi_zip = "ir/20260818/20260818_Sisi_Shapefiles.zip"
    jle = _bound(BEAR_TRAP, "bear-trap", **{
        kmz: {}, "ir/20260819/20260819_c0800_Bear_Trap_Aircraft3_All.pdf": {},
        # the same flight folder carries Thumb's flight, stamped to Thumb
        thumb_kmz: {"fk": _fk(THUMB), "fk_src": "name"}})
    sisi = _bound(SISI, "sisi", **{sisi_zip: {}})
    state = {"incidents": {"eastern/2026/2026_JulyLightningEvent": jle,
                           "pacific_nw/2026/2026_Sisi": sisi,
                           "pacific_nw/2026/2026_NoIR": _bound(SISI, "no-ir", **{
                               "qr/ops.pdf": {"kind": "qr"}})},
             "ir": {}}
    sisi["ir_keys"] = {sisi_zip: {"key": "vectors/ir/sisi/a.geojson", "flight_id": "f",
                                  "src_sha16": sisi["files"][sisi_zip]["sha16"]}}
    state["ir"]["vectors/ir/sisi/a.geojson"] = {"heat_types": ["Intense"], "v": V}
    quiet = lambda *_: None  # noqa: E731

    # FIRE keys: each owner of a flight in the folder, on its own
    assert _ir_backlog(state, fires, quiet) == {_fk(BEAR_TRAP), _fk(THUMB)}

    # a conversion stamped for the source's bytes under the current
    # converter is done, failed or not (no retry loop)
    def stamp(rec, src, key, conv):
        rec.setdefault("ir_keys", {})[src] = {"key": key, "flight_id": "f",
                                              "src_sha16": rec["files"][src]["sha16"]}
        state["ir"][key] = conv
    stamp(jle, kmz, "vectors/ir/bear-trap/b.geojson", {"failed": True, "v": V})
    stamp(jle, thumb_kmz, "vectors/ir/bear-trap/t.geojson", {"heat_types": ["Isolated"], "v": V})
    assert _ir_backlog(state, fires, quiet) == set()

    # ... but only for those bytes, and only under the current converter
    jle["files"][kmz]["sha16"] = "ffff000000000001"   # a new revision of the KMZ
    state["ir"]["vectors/ir/sisi/a.geojson"]["v"] = V - 1
    assert _ir_backlog(state, fires, quiet) == {_fk(BEAR_TRAP), _fk(SISI)}

    # an inactive owner, an unresolved folder and a hidden file owe nothing
    del fires[_fk(SISI)]
    jle["files"][kmz]["fk"], jle["files"][kmz]["fk_src"] = None, "hidden"
    assert _ir_backlog(state, fires, quiet) == set()
    jle["files"][kmz].pop("fk")
    jle.update(id_unresolved={"reason": "date"}, match=None, cornea_id=None)
    jle["files"][thumb_kmz].pop("fk")
    assert _ir_backlog(state, fires, quiet) == set()


def test_ir_backlog_skips_mixed_folder_with_no_owner_source():
    # Bear Trap's IR folder holds only the KMZs of Sioux and Thumb, both
    # active: no source names Bear Trap, so the flight gets no vectors and
    # the backlog never queues a conversion for it.
    from responder_worker.cli import _ir_backlog

    fires = {_fk(f): {"cornea_id": f, "post_title": t}
             for f, t in ((BEAR_TRAP, "Bear Trap"), (THUMB, "Thumb"), (SIOUX, "Sioux"))}
    rec = _bound(BEAR_TRAP, "bear-trap", **{
        "ir/20260901/20260901_Sioux_IR.kmz": {},
        "ir/20260901/20260901_Thumb_IR.kmz": {},
        "ir/20260901/20260901_IR_Map.pdf": {}})
    state = {"incidents": {"eastern/2026/2026_BearTrap": rec}, "ir": {}}
    assert _ir_backlog(state, fires, lambda *_: None) == set()
    # with the owner's own KMZ in the folder, that one is the source
    rec["files"]["ir/20260901/20260901_Bear_Trap_IR.kmz"] = {"kind": "ir", "sha16": "b" * 16}
    assert _ir_backlog(state, fires, lambda *_: None) == {_fk(BEAR_TRAP)}


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


def _sisi_flight(local_kmz=None, kmz_bytes=b"kmz"):
    """Sisi's 09-24 flight in its own folder (bound, own prefix): an
    aerial PDF and the KMZ, as (rel, MirroredFile) in state order."""
    from responder_worker.asset_keys import replay_file

    pdf = "ir/20260924/20260924_Sisi_IR_11x17_Aerial.pdf"
    kmz = "ir/20260924/20260924_Sisi_IR.kmz"
    rec = _bound(SISI, "sisi", **{pdf: {}, kmz: {}})
    rec["files"][kmz]["sha16"] = __import__("hashlib").sha256(kmz_bytes).hexdigest()[:16]
    files = [(rel, replay_file(rec, rel, rec["files"][rel])) for rel in (pdf, kmz)]
    if local_kmz is not None:
        files[1][1].local_path = local_kmz
    return rec, kmz, files


@pytest.mark.skipif(shutil.which("ogr2ogr") is None, reason="ogr2ogr not installed")
def test_ir_flights_converts_kmz_and_caches_under_the_converter_version(tmp_path):
    from types import SimpleNamespace

    from responder_worker import fire_manifests as fm, frames, ir_vectors

    kmz_path = _write_kmz(tmp_path / "20260924_Sisi_IR.kmz", _nirops_kml())
    rec, kmz, files = _sisi_flight(kmz_path, kmz_path.read_bytes())
    put = {}
    storage = SimpleNamespace(
        put_file=lambda key, p, **kw: put.__setitem__(key, p.read_text()),
        get_file=lambda key, p: False)
    fire = {"cornea_id": SISI, "fire_slug": "sisi", "post_title": "Sisi"}
    key = (f"vectors/ir/sisi/{rec['files'][kmz]['sha16']}"
           f".v{ir_vectors.IR_CONVERTER_VERSION}.geojson")
    # a failure the old converter recorded for this source does not block it
    old = "vectors/ir/sisi/20260924_IR_11x17_Aerial.geojson"
    rec["ir_keys"] = {kmz: {"key": old, "flight_id": "20260924_IR_11x17_Aerial",
                            "src_sha16": rec["files"][kmz]["sha16"]}}
    state = {"ir": {old: {"failed": True, "v": ir_vectors.IR_CONVERTER_VERSION - 1}},
             "tiled": {}}
    frames.start_deadline(0)  # disarmed

    def flight():
        return fm.ir_flight(None, storage, state, fire, rec, "pacific_nw/2026/2026_Sisi",
                            "ir/20260924", files, replay_only=False, fire_names={"sisi"},
                            log=lambda *_: None)

    f = flight()
    assert f["flight_date"] == "2026-09-24"   # FTP folder
    assert f["flown_at"] == "2026-09-24T02:25:00Z"  # KMZ: 9/23 19:25 PDT
    assert f["flown_date"] is None
    assert f["geojson_url"] == f"/{key}" and f["flight_id"] == "20260924_IR_11x17_Aerial"
    assert "Possible" in f["heat_types"]
    assert list(put) == [key]
    assert state["ir"][key]["v"] == ir_vectors.IR_CONVERTER_VERSION
    assert rec["ir_keys"][kmz]["key"] == key

    # the next rebuild replays from cache: no local file, no download
    files[1][1].local_path = None
    put.clear()
    assert flight() == f and not put


def test_ir_flights_keeps_an_older_result_when_it_cannot_reconvert(monkeypatch):
    from types import SimpleNamespace

    from responder_worker import fire_manifests as fm, frames

    rec, kmz, files = _sisi_flight()
    key = "vectors/ir/sisi/20260924_IR_11x17_Aerial.geojson"
    rec["ir_keys"] = {kmz: {"key": key, "flight_id": "20260924_IR_11x17_Aerial",
                            "src_sha16": rec["files"][kmz]["sha16"]}}
    storage = SimpleNamespace(get_file=lambda *_: False, put_file=lambda *_, **kw: None)
    fire = {"cornea_id": SISI, "fire_slug": "sisi", "post_title": "Sisi"}

    # a run whose GDAL install failed: serve the pre-bump result of the same
    # source, record nothing
    monkeypatch.setattr(fm.shutil, "which", lambda _: None)
    frames.start_deadline(0)
    state = {"ir": {key: {"heat_types": ["Perimeter"]}}, "tiled": {}}
    f = fm.ir_flight(None, storage, state, fire, rec, "pacific_nw/2026/2026_Sisi",
                     "ir/20260924", files, replay_only=False, fire_names={"sisi"},
                     log=lambda *_: None)
    assert f["geojson_url"] == f"/{key}" and f["flown_at"] is None
    assert state["ir"] == {key: {"heat_types": ["Perimeter"]}}
    assert rec["ir_keys"][kmz]["key"] == key


def test_ir_preview_url_reuses_renders_and_never_queues_tiling(tmp_path, monkeypatch):
    import dataclasses
    from types import SimpleNamespace

    from responder_worker import config, fire_manifests as fm, geopdf

    rec, _kmz, files = _sisi_flight()
    pdf = files[0][1]
    sha = pdf.sha16
    put = {}
    storage = SimpleNamespace(put_file=lambda key, p, **kw: put.__setitem__(key, p.read_bytes()))
    rendered = []

    def fake_render(pdf_path, out):
        rendered.append(pdf_path)
        out.write_bytes(b"png")
        return out

    monkeypatch.setattr(geopdf, "render_preview", fake_render)
    monkeypatch.setattr(geopdf, "gdal_available", lambda: True)
    key = f"previews/incidents/sisi/{sha}.png"

    def url(mf, state):
        return fm.ir_preview_url(storage, state, rec, mf, replay_only=False, log=lambda *_: None)

    # a preview the probe backlog already made (same key as map sheets)
    assert url(pdf, {"tiled": {sha: {"geo": {"preview": True}}}}) == f"/{key}"
    assert not rendered

    # a PDF downloaded this run: rendered now, recorded as done for the tiler
    local = tmp_path / "ir.pdf"
    local.write_bytes(b"%PDF")
    state = {"tiled": {}}
    assert url(dataclasses.replace(pdf, local_path=local), state) == f"/{key}"
    assert rendered == [local] and put[key] == b"png"
    assert state["tiled"][sha]["tiler_version"] == config.TILER_VERSION
    assert state["tiled"][sha]["geo"]["preview"] is True

    # a replayed PDF with no preview yet: nothing now, the probe backlog does it
    state = {"tiled": {}}
    assert url(pdf, state) is None and state["tiled"] == {}


def test_tilers_skip_ir_pdfs():
    from responder_worker import cli

    state = {
        "incidents": {"pnw/2026_Sisi": {"fire_slug": "sisi", "files": {
            "ir/20260925/a.pdf": {"sha16": "aaaa", "kind": "ir"},
            "products/20260923/ops.pdf": {"sha16": "bbbb", "kind": "product"},
        }}},
        "tiled": {
            # an IR PDF an older probe queued for tiling, and a real map sheet
            "aaaa": {"tiler_version": None, "geo": {"georeferenced": True}},
            "bbbb": {"tiler_version": None, "geo": {"georeferenced": True}},
        },
    }
    assert [sha for sha, _, _ in cli._pending_sheets(state)] == ["bbbb"]


def test_probe_backlog_previews_ir_pdfs_without_queuing_tiles(monkeypatch):
    import hashlib
    from types import SimpleNamespace

    from responder_worker import cli, frames, geopdf

    raw = {"raw/incidents/sisi/ir/20260925/a.pdf": b"%PDF ir",
           "raw/incidents/sisi/products/20260923/ops.pdf": b"%PDF ops"}

    def get_file(key, local):
        if key not in raw:
            return False
        local.write_bytes(raw[key])
        return True

    put = {}
    storage = SimpleNamespace(get_file=get_file,
                              put_file=lambda key, p, **kw: put.__setitem__(key, True))
    monkeypatch.setattr(geopdf, "gdal_available", lambda: True)
    monkeypatch.setattr(geopdf, "probe_pdf",
                        lambda p: {"georeferenced": True, "projection": "UTM 10N"})
    monkeypatch.setattr(geopdf, "render_preview",
                        lambda pdf, out: out.write_bytes(b"png") or out)
    frames.start_deadline(0)
    ir_sha, ops_sha = (hashlib.sha256(raw[k]).hexdigest()[:16] for k in raw)
    rec = _bound(SISI, "sisi", **{
        "ir/20260925/a.pdf": {"sha16": ir_sha},
        "products/20260923/ops.pdf": {"sha16": ops_sha, "kind": "product"}})
    state = {"tiled": {}, "incidents": {"pnw/2026_Sisi": rec}}
    assert cli._probe_backlog(storage, state, lambda *_: None) == {"pnw/2026_Sisi"}
    assert f"previews/incidents/sisi/{ir_sha}.png" in put
    # georeferenced either way — only the map sheet is owed tiles
    assert state["tiled"][ir_sha]["tiler_version"] == cli.config.TILER_VERSION
    assert state["tiled"][ops_sha]["tiler_version"] is None
    assert state["tiled"][ir_sha]["prefix"] == "sisi"
    # and an IR record is never "repaired" into a tiling candidate later
    state["tiled"][ir_sha].pop("grat_at")
    put.clear()
    cli._probe_backlog(storage, state, lambda *_: None)
    assert f"previews/incidents/sisi/{ir_sha}.png" not in put
