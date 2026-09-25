"""Foundations shared by the trails build and the routing bundles: UTM math,
the stdlib PMTiles reader, GDAL-CLI raster round trips, B2 key rules and the
streamed download.

fixtures/trails/tiny.pmtiles — 60 synthetic trail lines built once with
ogr2ogr -f PMTiles (GDAL 3.8.4, z9–11, layer 'trails').
GDAL-dependent tests skip when the CLI tools are not on PATH.
"""

import shutil

import httpx
import numpy as np
import pytest

from responder_worker import config, gdal_cli, http, pmtiles_inspect, utm

needs_gdal = pytest.mark.skipif(
    shutil.which("gdal_translate") is None or shutil.which("gdaltransform") is None,
    reason="GDAL CLI not installed")


class TestUtm:
    def test_known_point_matches_proj(self):
        # gdaltransform -s_srs EPSG:4326 -t_srs EPSG:32611 <<< "-115 44"
        e, n = utm.fwd(-115.0, 44.0, 11)
        assert e == pytest.approx(660349.410578446, abs=1e-3)
        assert n == pytest.approx(4873817.33344036, abs=1e-3)

    def test_round_trip_arrays_across_zones(self):
        rng = np.random.default_rng(3)
        for zone in (10, 11, 12, 13, 17, 19):
            cm = utm.central_meridian(zone)
            lon = cm + rng.uniform(-3.2, 3.2, 200)
            lat = rng.uniform(25, 49, 200)
            e, n = utm.fwd(lon, lat, zone)
            lon2, lat2 = utm.inv(e, n, zone)
            assert np.max(np.abs(lon2 - lon)) < 1e-9
            assert np.max(np.abs(lat2 - lat)) < 1e-9

    def test_southern_hemisphere(self):
        e, n = utm.fwd(-170.7, -14.3, 2, northern=False)
        assert utm.inv(e, n, 2, northern=False) == pytest.approx((-170.7, -14.3), abs=1e-9)

    def test_zone_and_epsg(self):
        assert utm.zone_for(-115.2) == 11
        assert utm.epsg_for(-115.2, 44) == 32611
        assert utm.epsg_for(-170.7, -14.3) == 32702
        assert utm.zone_of_epsg(32610) == (10, True)
        with pytest.raises(ValueError):
            utm.zone_of_epsg(5070)

    def test_bbox_round_trip_encloses(self):
        box = (-115.25, 43.95, -114.63, 44.40)
        u = utm.bbox_lonlat_to_utm(box, 11)
        back = utm.bbox_utm_to_lonlat(u, 11)
        assert back[0] <= box[0] and back[1] <= box[1]
        assert back[2] >= box[2] and back[3] >= box[3]

    @needs_gdal
    def test_agrees_with_gdaltransform(self):
        pts = [(-121.5, 44.2), (-119.3, 45.1), (-120.0, 40.0)]
        want = gdal_cli.transform_points(pts, 4326, 32610)
        for (lon, lat), (we, wn) in zip(pts, want):
            e, n = utm.fwd(lon, lat, 10)
            assert (e, n) == pytest.approx((we, wn), abs=0.01)


class TestPmtilesInspect:
    def test_summary_of_gdal_archive(self, fixtures):
        s = pmtiles_inspect.summarize(fixtures / "trails" / "tiny.pmtiles")
        h = s["header"]
        assert h["clustered"] and h["tile_type"] == "mvt"
        assert h["tile_compression"] == "gzip"
        assert (h["min_zoom"], h["max_zoom"]) == (9, 11)
        assert s["tiles"] == h["addressed_tiles"] == sum(
            z["tiles"] for z in s["by_zoom"].values())
        assert set(s["by_zoom"]) == {"9", "10", "11"}
        assert s["sample_layers"] == ["trails"]
        assert pmtiles_inspect.check(s, min_zoom=9, max_zoom=11, layer="trails") == []

    def test_check_reports_problems(self, fixtures):
        s = pmtiles_inspect.summarize(fixtures / "trails" / "tiny.pmtiles")
        probs = pmtiles_inspect.check(s, min_zoom=7, max_zoom=13, layer="ways",
                                      min_tiles=10_000)
        assert len(probs) == 3

    def test_bad_magic(self, tmp_path):
        p = tmp_path / "x.pmtiles"
        p.write_bytes(b"\0" * 200)
        with pytest.raises(pmtiles_inspect.PMTilesError):
            pmtiles_inspect.summarize(p)

    def test_zoom_of_tile_id(self):
        assert pmtiles_inspect.zoom_of_tile_id(0) == 0
        assert pmtiles_inspect.zoom_of_tile_id(1) == 1
        assert pmtiles_inspect.zoom_of_tile_id(4) == 1
        assert pmtiles_inspect.zoom_of_tile_id(5) == 2
        assert pmtiles_inspect.zoom_of_tile_id(20) == 2
        assert pmtiles_inspect.zoom_of_tile_id(21) == 3


@needs_gdal
class TestGdalRasterIo:
    def test_round_trip_two_bands_and_int16(self, tmp_path):
        geo = gdal_cli.Georef(32611, 612330.0, 4912830.0, 30.0, 30.0, 7, 5)
        a = np.arange(70, dtype=np.uint8).reshape(2, 5, 7)
        p = gdal_cli.write_raster(a, geo, tmp_path / "g.tif",
                                  creation=["COMPRESS=DEFLATE", "PREDICTOR=1"],
                                  band_names=["pace", "veg"], metadata={"RD_RECIPE": "1"})
        back, geo2, nodata = gdal_cli.read_raster(p, tmp_path / "w")
        assert back.dtype == np.uint8 and np.array_equal(back, a)
        assert geo2 == geo
        dem = (np.arange(35, dtype=np.int16).reshape(5, 7) - 10) * 100
        p2 = gdal_cli.write_raster(dem, geo, tmp_path / "d.tif", nodata=-32768,
                                   creation=["COMPRESS=DEFLATE", "PREDICTOR=2"])
        back2, _, nd2 = gdal_cli.read_raster(p2, tmp_path / "w")
        assert back2.dtype == np.int16 and np.array_equal(back2[0], dem)
        assert nd2 == [-32768]
        inf = gdal_cli.info(p)
        assert inf["metadata"][""]["RD_RECIPE"] == "1"

    def test_error_carries_last_stderr_line(self, tmp_path):
        with pytest.raises(gdal_cli.GdalError, match="gdalinfo failed"):
            gdal_cli.run(["gdalinfo", str(tmp_path / "missing.tif")])

    def test_drivers(self):
        assert {"PMTiles", "GPKG", "FlatGeobuf"} <= gdal_cli.drivers("vector")


class TestKeyRules:
    @pytest.mark.parametrize("key,cc", [
        ("trails/b20260925-3f9a1c2e/trails.pmtiles", "public, max-age=31536000, immutable"),
        ("routing/abc/b0123456789ab/grid.tif", "public, max-age=31536000, immutable"),
        ("catalogs/trails.json", "public, max-age=60, must-revalidate"),
        ("catalogs/routing.json", "public, max-age=60, must-revalidate"),
        ("catalogs/routing/fires/abc.json", "public, max-age=60, must-revalidate"),
        ("catalogs/health/routing.json", "public, max-age=60, must-revalidate"),
        ("work/nhd/17060201.gpkg", "private, no-store"),
        ("state/trails.json", "private, no-store"),
    ])
    def test_cache_control(self, key, cc):
        assert config.cache_control_for_key(key) == cc

    @pytest.mark.parametrize("key,ct", [
        ("x/trails.pmtiles", "application/octet-stream"),
        ("x/trails.fgb", "application/octet-stream"),
        ("x/grid.tif", "image/tiff"),
        ("x/graph.bin.gz", "application/gzip"),
        ("work/nhd/1.gpkg", "application/geopackage+sqlite3"),
    ])
    def test_content_type(self, key, ct):
        assert config.content_type_for_key(key) == ct


class TestDownloadTo:
    def test_streams_and_renames(self, tmp_path):
        body = b"x" * 3_000_000
        client = httpx.Client(transport=httpx.MockTransport(
            lambda r: httpx.Response(200, content=body)))
        dest = tmp_path / "a" / "f.zip"
        resp = http.download_to(client, "https://example.test/f.zip", dest)
        assert resp.status_code == 200
        assert dest.read_bytes() == body
        assert not (tmp_path / "a" / "f.zip.part").exists()

    def test_304_writes_nothing(self, tmp_path):
        client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(304)))
        dest = tmp_path / "f.zip"
        assert http.download_to(client, "https://example.test/f.zip", dest,
                                headers={"If-None-Match": '"e"'}).status_code == 304
        assert not dest.exists()

    def test_404_raises(self, tmp_path):
        client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(404)))
        with pytest.raises(httpx.HTTPStatusError):
            http.download_to(client, "https://example.test/f.zip", tmp_path / "f")
