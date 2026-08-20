

def test_classify_kmz_layer():
    from responder_worker.ir_vectors import _classify_kmz_layer

    assert _classify_kmz_layer("Intense Heat") == "Intense"
    assert _classify_kmz_layer("Scattered Heat") == "Scattered"
    assert _classify_kmz_layer("Isolated Fires") == "Isolated"
    assert _classify_kmz_layer("Estimated Perimeter") == "Perimeter"
    assert _classify_kmz_layer("Fire Perimeter") == "Perimeter"
    assert _classify_kmz_layer("Cloud Cover") is None
    assert _classify_kmz_layer("Legend 1") is None
    assert _classify_kmz_layer("Layers for Google Earth KMZ") is None


def test_ir_backlog_flags_unconverted_flights():
    from responder_worker.cli import _ir_backlog

    state = {
        "ir": {"vectors/ir/big-grass/20260818_c0230_Aircraft1.geojson":
               {"heat_types": ["Intense"]}},
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
        "failed": True}
    assert _ir_backlog(state, lambda *_: None) == set()


def test_extract_kml_fallback(tmp_path):
    import zipfile

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
