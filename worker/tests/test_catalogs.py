"""Catalog assembly against the data contracts: every field present,
bbox [w,s,e,n], time_instants verbatim strings, filename parsing on real names."""

from responder_worker.catalogs import (
    build_catalog,
    build_pyrecast_runs,
    build_weather_runs,
    build_incident_manifest,
    map_entry,
    parse_product_filename,
    product_label,
)
from responder_worker.pyrecast import parse_gs01_caps, parse_gs02_caps


def _fires():
    return [
        {
            "fire_slug": "paradise", "post_title": "Paradise", "state": "OR",
            "cornea_id": "{AAA}", "unique_fire_id": "2026-ORVAD-000123",
            "coordinates": [-117.9, 46.0], "acres": 1000, "containment": 10,
            "active": True, "last_updated": "2026-08-17T00:00:00Z",
            "poly_last_updated": None, "timezone": "America/Boise",
        },
        {
            "fire_slug": "elk", "post_title": "Elk", "state": "CO",
            "cornea_id": "{BBB}", "unique_fire_id": "2026-COGMF-000114",
            "coordinates": [-107.3, 38.1], "acres": 7000, "containment": 40,
            "active": True, "last_updated": "2026-08-17T00:00:00Z",
            "poly_last_updated": "2026-08-16T00:00:00Z", "timezone": "America/Denver",
        },
    ]


# ---------------------------------------------------------------------------
# filename parsing (real observed names)
# ---------------------------------------------------------------------------

class TestFilenameParsing:
    def test_ops_arch_e(self):
        p = parse_product_filename(
            "ops_arch_e_port_20260816_2100_Elk_COGMF000114_817day.pdf")
        assert p["product"] == "ops"
        assert p["sheet"] == "arch_e"
        assert p["orientation"] == "port"
        assert p["generated_at_local"] == "2026-08-16T21:00"
        assert p["op_date"] == "2026-08-17"
        assert p["period"] == "day"
        assert p["fire_name"] == "Elk"
        assert p["unit_incident"] == "COGMF000114"
        assert product_label(p) == "Operations Map"

    def test_ops_zoom_variant(self):
        p = parse_product_filename(
            "ops_zoom_ortho_arch_e_port_20260816_2054_Elk_COGMF000114_0817day.pdf")
        assert p["product"] == "ops_zoom_ortho"
        assert p["product_base"] == "ops"
        assert p["op_date"] == "2026-08-17"
        assert "Operations Map" in product_label(p)

    def test_pio_85x11(self):
        p = parse_product_filename(
            "pio_85x11_port_20260816_2056_Elk_COGMF000114_817.pdf")
        assert p["product"] == "pio"
        assert p["sheet"] == "85x11"
        assert p["period"] is None
        assert p["op_date"] == "2026-08-17"

    def test_mobile(self):
        p = parse_product_filename(
            "mobile_72x96_land_20260816_2056_Elk_COGMF000114_817.pdf")
        assert p["product_base"] == "mobile"
        assert p["sheet"] == "72x96"

    def test_suppression_repair(self):
        p = parse_product_filename(
            "suppression_repair_arch_e_port_20260816_2053_Elk_COGMF000114_0817day.pdf")
        assert p["product"] == "suppression_repair"
        assert product_label(p) == "Suppression Repair Map"

    def test_multiword_fire_name(self):
        p = parse_product_filename(
            "iap_11x17_land_20260810_0600_Rail_Ridge_ORPRD000511_0810day.pdf")
        assert p["fire_name"] == "Rail_Ridge"
        assert p["unit_incident"] == "ORPRD000511"
        assert p["sheet"] == "11x17"

    def test_unparseable_degrades_to_other(self):
        p = parse_product_filename("Read_Me.txt")
        assert p["product"] == "other"


# ---------------------------------------------------------------------------
# pyrecast_runs.json contract
# ---------------------------------------------------------------------------

class TestPyrecastRunsContract:
    def test_contract_shape(self, fixtures):
        _, gs02 = parse_gs02_caps((fixtures / "gs02_caps_excerpt.xml").read_bytes())
        doc = build_pyrecast_runs(_fires(), gs02)

        assert doc["schema_version"] == 1
        assert doc["source"] == "geoserver02"
        assert doc["wms_proxy_path"] == "/wms02"
        assert "generated_at" in doc

        assert "paradise" in doc["fires"]
        entry = doc["fires"]["paradise"]
        assert entry["pyrecast_slug"] == "or-paradise"
        run = entry["runs"][0]
        for field in ("workspace", "run_time", "bbox", "native_crs",
                      "percentiles", "time_instants", "products"):
            assert field in run
        w, s, e, n = run["bbox"]
        assert w < e and s < n
        # verbatim ISO strings, minute-precision first instant
        assert run["time_instants"][0] == "2026-08-17T11:25:00.000Z"
        assert all(isinstance(t, str) and t.endswith("Z") for t in run["time_instants"])
        for name, p in run["products"].items():
            assert "timed" in p and "layer_template" in p and "legend_url" in p

    def test_unmatched_workspaces_surfaced(self, fixtures):
        _, gs02 = parse_gs02_caps((fixtures / "gs02_caps_excerpt.xml").read_bytes())
        doc = build_pyrecast_runs(_fires(), gs02)
        # ar-dallas + sd-false-bottom-creek have no matching fire in _fires()
        slugs = {u["slug"] for u in doc["unmatched_workspaces"]}
        assert "ar-dallas-500153" in slugs
        assert "sd-false-bottom-creek" in slugs
        for u in doc["unmatched_workspaces"]:
            assert "workspace" in u and "run_time" in u and "bbox" in u


# ---------------------------------------------------------------------------
# weather_runs.json contract
# ---------------------------------------------------------------------------

class TestWeatherRunsContract:
    def test_contract_shape(self, fixtures):
        gs01 = parse_gs01_caps((fixtures / "gs01_hrrr_caps_excerpt.xml").read_bytes())
        doc = build_weather_runs(gs01)
        hrrr = doc["models"]["hrrr"]
        assert hrrr["label"] == "HRRR"
        assert "tmpf" in hrrr["products"] and "label" in hrrr["products"]["tmpf"]
        assert len(hrrr["runs"]) == 2  # newest complete + one previous
        newest = hrrr["runs"][0]
        assert newest["workspace"] == "fire-weather-forecast_hrrr_20260817_12"
        assert newest["run_time"] == "2026-08-17T12:00:00Z"
        assert newest["hours"][0] == "2026-08-17T12:00:00Z"
        assert len(newest["hours"]) == 49
        assert newest["layer_template"] == "{ws}:{product}_{YYYYMMDD}_{HHMMSS}"
        assert newest["default_layer_template"] == "{ws}:{product}"
        assert newest["legend_url_template"].startswith("/wms01?")


# ---------------------------------------------------------------------------
# catalog.json contract
# ---------------------------------------------------------------------------

class TestCatalogContract:
    def test_contract_shape(self, fixtures):
        _, gs02 = parse_gs02_caps((fixtures / "gs02_caps_excerpt.xml").read_bytes())
        pyre = build_pyrecast_runs(_fires(), gs02)
        spread_index = {slug: e["runs"][0]["run_time"]
                        for slug, e in pyre["fires"].items()}
        matches = {"elk": {
            "method": "unit_id", "confidence": 1.0,
            "dir_url": "https://ftp.wildfire.gov/.../2026_Elk/",
            "synced_at": "2026-08-17T12:00:00Z",
        }}
        doc = build_catalog(_fires(), version=7,
                            incident_matches=matches, spread_index=spread_index)

        assert doc["schema_version"] == 1 and doc["version"] == 7
        assert doc["wms_proxy"] == {"gs01": "/wms01", "gs02": "/wms02"}
        assert doc["counts"]["active_fires"] == 2
        assert doc["counts"]["matched_incident_dirs"] == 1
        assert doc["counts"]["spread_forecast_fires"] == 1

        by_slug = {f["fire_slug"]: f for f in doc["fires"]}
        elk = by_slug["elk"]
        for field in ("cornea_id", "unique_fire_id", "name", "coordinates", "state",
                      "acres", "containment", "active", "last_updated",
                      "poly_last_updated", "timezone", "has_incident_maps",
                      "incident_manifest", "ftp_match", "has_spread_forecast",
                      "spread_latest_run"):
            assert field in elk
        assert elk["has_incident_maps"] is True
        assert elk["incident_manifest"] == "/catalogs/incidents/elk.json"
        assert elk["ftp_match"]["method"] == "unit_id"
        assert by_slug["paradise"]["has_spread_forecast"] is True
        assert by_slug["paradise"]["spread_latest_run"] == "2026-08-17T11:25:00Z"
        # coordinates are [lon, lat]
        lon, lat = elk["coordinates"]
        assert -125 < lon < -66 and 24 < lat < 50


# ---------------------------------------------------------------------------
# incident manifest contract
# ---------------------------------------------------------------------------

class TestIncidentManifestContract:
    def test_map_entry_shape(self):
        parsed = parse_product_filename(
            "ops_arch_e_port_20260816_2100_Elk_COGMF000114_817day.pdf")
        entry = map_entry(
            parsed=parsed, kind="product", sha_id="a1b2c3d4e5f6a7b8",
            fire_slug="elk",
            pdf_key="raw/incidents/elk/products/20260817/ops_arch_e_port_20260816_2100_Elk_COGMF000114_817day.pdf",
            size_bytes=10485760,
            geo={
                "georeferenced": True, "projection": "NAD_1983_UTM_Zone_13N",
                "preview": True,
                "tiles": {"minzoom": 9, "maxzoom": 15,
                          "bounds": [-107.4018, 37.9984, -107.2424, 38.1621]},
            },
        )
        for field in ("id", "kind", "product", "product_label", "sheet",
                      "orientation", "op_date", "period", "filename", "pdf_url",
                      "size_bytes", "georeferenced", "projection", "preview_url",
                      "tiles", "tiling_pending", "rev"):
            assert field in entry
        assert entry["pdf_url"].startswith("/raw/incidents/elk/")
        assert entry["preview_url"] == "/previews/incidents/elk/a1b2c3d4e5f6a7b8.png"
        t = entry["tiles"]
        assert t["url_template"] == "/tiles/incidents/elk/a1b2c3d4e5f6a7b8/{z}/{x}/{y}.png"
        w, s, e, n = t["bounds"]
        assert w < e and s < n

    def test_non_geo_entry(self):
        parsed = parse_product_filename(
            "mobile_72x96_land_20260816_2056_Elk_COGMF000114_817.pdf")
        entry = map_entry(
            parsed=parsed, kind="mobile", sha_id="ffff000011112222",
            fire_slug="elk", pdf_key="raw/incidents/elk/products/20260817/x.pdf",
            size_bytes=26_000_000, geo=None,
        )
        assert entry["georeferenced"] is False
        assert entry["tiles"] is None
        assert entry["preview_url"] is None

    def test_manifest_shape(self):
        fire = _fires()[1]
        doc = build_incident_manifest(
            fire=fire, region="rocky_mtn",
            source_dir="https://ftp.wildfire.gov/public/incident_specific_maps/rocky_mtn/2026/2026_Elk/",
            unit_incident="COGMF000114",
            maps=[], ir_flights=[{
                "flight_date": "2026-08-17",
                "flight_id": "20260817_c0730_Aircraft3",
                "no_flight_reason": None,
                "geojson_url": "/vectors/ir/elk/20260817_c0730_Aircraft3.geojson",
                "heat_types": ["Perimeter", "Intense", "Scattered", "Isolated"],
                "estimated_acres": 7373,
                "pdf_url": None, "kmz_url": None, "readme_url": None,
            }],
        )
        for field in ("schema_version", "fire_slug", "cornea_id", "generated_at",
                      "source_dir", "region", "unit_incident", "maps", "ir_flights"):
            assert field in doc
        assert doc["fire_slug"] == "elk"
        assert doc["ir_flights"][0]["heat_types"] == [
            "Perimeter", "Intense", "Scattered", "Isolated"]
