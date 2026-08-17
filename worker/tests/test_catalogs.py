"""Catalog assembly against the data contracts: every field present,
spread flags fed by the archives doc, filename parsing on real names."""

import json

from responder_worker import archives
from responder_worker.catalogs import (
    build_catalog,
    build_weather_runs_hrrr,
    build_incident_manifest,
    map_entry,
    parse_product_filename,
    product_label,
)


def _fires():
    return [
        {
            "fire_slug": "sinlahekin", "post_title": "SINLAHEKIN", "state": "WA",
            "cornea_id": "{78D35D3B-F791-4961-AE36-C6D1A4DFF5A0}",
            "unique_fire_id": "2026-WANES-000391",
            "coordinates": [-119.68, 48.74], "acres": 1000, "containment": 10,
            "active": True, "last_updated": "2026-08-17T00:00:00Z",
            "poly_last_updated": None, "timezone": "America/Los_Angeles",
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
# weather_runs.json contract
# ---------------------------------------------------------------------------

def _hrrr_runs():
    """hrrr.discover_runs output shape (newest first)."""
    from datetime import datetime, timedelta, timezone

    def run(cycle_h, n_hours):
        cycle = datetime(2026, 8, 17, cycle_h, tzinfo=timezone.utc)
        return {
            "workspace": f"hrrr_20260817_{cycle_h:02d}",
            "run_time": cycle.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "hours": [(cycle + timedelta(hours=k)).strftime("%Y-%m-%dT%H:%M:%SZ")
                      for k in range(n_hours)],
        }

    return [run(12, 49), run(11, 19)]


class TestWeatherRunsContract:
    def test_contract_shape(self):
        doc = build_weather_runs_hrrr(_hrrr_runs())
        assert doc["source"] == "noaa-hrrr"
        hrrr = doc["models"]["hrrr"]
        assert hrrr["label"] == "HRRR (NOAA)"
        # v1 products (no wd/ffwi — deferred per spec-hrrr.md)
        assert set(hrrr["products"]) == {
            "ws", "wg", "tmpf", "rh", "smoke", "apcp01"}
        for name, p in hrrr["products"].items():
            assert p["label"] and p["units"]
            stops = p["legend_stops"]
            assert stops and all(
                isinstance(v, (int, float)) and c.startswith("#")
                for v, c in stops)
            assert [v for v, _ in stops] == sorted(v for v, _ in stops)
        assert hrrr["products"]["ws"]["units"] == "mph"
        assert hrrr["products"]["ws"]["legend_stops"][0] == [0, "#78b4dc"]
        # gradient legends replace legend images entirely
        assert "legend_template" not in hrrr

        assert len(hrrr["runs"]) == 2  # newest cycle + one previous
        newest = hrrr["runs"][0]
        assert newest["workspace"] == "hrrr_20260817_12"
        assert newest["run_time"] == "2026-08-17T12:00:00Z"
        assert newest["hours"][0] == "2026-08-17T12:00:00Z"
        assert len(newest["hours"]) == 49
        # frames block: same shape as spec-frames.md
        fr = newest["frames"]
        assert fr["bounds"] == [-125.0, 24.5, -66.5, 49.5]
        assert fr["image_template"] == "/frames/weather/{ws}/{product}/{epoch_ms}.png"
        assert fr["hours"] == [] and fr["complete"] is False  # nothing fetched yet

    def test_frames_complete_from_state(self):
        doc = build_weather_runs_hrrr(_hrrr_runs(), hrrr_state={
            "hrrr_20260817_12": {"done": True, "fetched": 292}})
        newest = doc["models"]["hrrr"]["runs"][0]
        assert newest["frames"]["complete"] is True
        assert newest["frames"]["hours"] == newest["hours"]

    def test_more_than_two_runs_trimmed(self):
        runs = _hrrr_runs() + [{"workspace": "hrrr_20260817_10",
                                "run_time": "2026-08-17T10:00:00Z",
                                "hours": ["2026-08-17T10:00:00Z"]}]
        doc = build_weather_runs_hrrr(runs)
        assert len(doc["models"]["hrrr"]["runs"]) == 2


# ---------------------------------------------------------------------------
# catalog.json contract
# ---------------------------------------------------------------------------

class TestCatalogContract:
    def test_contract_shape(self, fixtures):
        # spread_index now derives from the archives doc (schema_version 2)
        manifest = json.loads(
            (fixtures / "archive_manifest_excerpt.json").read_text())
        matches = json.loads(
            (fixtures / "archive_fire_matches_excerpt.json").read_text())
        pyre = archives.build_pyrecast_runs(_fires(), manifest, matches)
        spread_index = {slug: e["runs"][0]["run_time"]
                        for slug, e in pyre["fires"].items() if e["runs"]}
        matches = {"elk": {
            "method": "unit_id", "confidence": 1.0,
            "dir_url": "https://ftp.wildfire.gov/.../2026_Elk/",
            "synced_at": "2026-08-17T12:00:00Z",
        }}
        doc = build_catalog(_fires(), version=7,
                            incident_matches=matches, spread_index=spread_index,
                            national_layers={
                                "current_year_perimeters": {
                                    "image": "/frames/national/current-year-perimeters.png",
                                    "bounds": [-125.0, 24.5, -66.5, 49.5],
                                    "as_of": "2026-08-17T17:50:00Z",
                                }})

        assert doc["schema_version"] == 1 and doc["version"] == 7
        assert "wms_proxy" not in doc  # proxy removed (static frames)
        perims = doc["national_layers"]["current_year_perimeters"]
        assert perims["image"] == "/frames/national/current-year-perimeters.png"
        assert perims["bounds"] == [-125.0, 24.5, -66.5, 49.5]
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
        assert by_slug["sinlahekin"]["has_spread_forecast"] is True
        assert by_slug["sinlahekin"]["spread_latest_run"] == "2026-08-17T10:05:00Z"
        assert by_slug["elk"]["has_spread_forecast"] is False
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
