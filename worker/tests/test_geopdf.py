"""GeoPDF detection/policy on the two real sampled incident-map PDFs.

owner_elk.pdf  — Elk (rocky_mtn) land-ownership map, UTM zone 13N
chute_ops.pdf  — Chute ops map

gdal-dependent tests skip when gdalinfo is not on PATH.
"""

import shutil

import pytest

from responder_worker.geopdf import (
    bounds_4326,
    dpi_for_sheet,
    gdalinfo_json,
    is_georeferenced,
    neatline_geojson,
    neatline_wkt,
    projection_name,
    sha16,
    zoom_range,
)

needs_gdal = pytest.mark.skipif(
    shutil.which("gdalinfo") is None, reason="gdalinfo not installed"
)


class TestDpiPolicy:
    def test_small_sheets_300(self):
        assert dpi_for_sheet("8x11") == 300
        assert dpi_for_sheet("85x11") == 300
        assert dpi_for_sheet("11x17") == 300

    def test_arch_cd_200(self):
        assert dpi_for_sheet("arch_c") == 200
        assert dpi_for_sheet("arch_d") == 200

    def test_arch_e_150(self):
        assert dpi_for_sheet("arch_e") == 150

    def test_unknown_default(self):
        assert dpi_for_sheet(None) == 200
        assert dpi_for_sheet("72x96") == 200


class TestZoomPolicy:
    def test_clamped(self):
        # ~2.4 m/px -> floor(log2(156543/2.4)) = 15
        assert zoom_range(2.4) == (9, 15)
        # very coarse -> clamps up to 10
        assert zoom_range(100000) == (4, 10)
        # very fine -> clamps down to 16
        assert zoom_range(0.01) == (10, 16)


class TestSha16:
    def test_content_addressed_id(self, fixtures):
        s = sha16(fixtures / "owner_elk.pdf")
        assert len(s) == 16
        assert all(c in "0123456789abcdef" for c in s)
        # deterministic
        assert s == sha16(fixtures / "owner_elk.pdf")
        assert s != sha16(fixtures / "chute_ops.pdf")


@needs_gdal
class TestGeorefDetection:
    def test_owner_elk_georeferenced(self, fixtures):
        info = gdalinfo_json(fixtures / "owner_elk.pdf")
        assert is_georeferenced(info)
        proj = projection_name(info) or ""
        assert "UTM" in proj or "Mercator" in proj or "Albers" in proj

    def test_chute_ops_georeferenced(self, fixtures):
        info = gdalinfo_json(fixtures / "chute_ops.pdf")
        assert is_georeferenced(info)

    def test_bounds_sane(self, fixtures):
        info = gdalinfo_json(fixtures / "owner_elk.pdf")
        b = bounds_4326(info)
        assert b is not None
        w, s, e, n = b
        assert w < e and s < n
        assert -180 <= w <= 180 and -90 <= s <= 90  # CONUS-ish
        assert -125 < w < -100 and 30 < s < 50


@needs_gdal
class TestNeatline:
    def test_neatline_extracted(self, fixtures):
        info = gdalinfo_json(fixtures / "owner_elk.pdf")
        wkt = neatline_wkt(info)
        assert wkt and wkt.strip().upper().startswith("POLYGON")

    def test_neatline_to_geojson(self, fixtures, tmp_path):
        info = gdalinfo_json(fixtures / "owner_elk.pdf")
        wkt = neatline_wkt(info)
        out = neatline_geojson(wkt, None, tmp_path / "neatline.json")
        import json

        fc = json.loads(out.read_text())
        ring = fc["features"][0]["geometry"]["coordinates"][0]
        assert len(ring) >= 4
        assert all(len(pt) == 2 for pt in ring)
