"""Caps parsing pinned to real GeoServer capabilities excerpts.

gs02_caps_excerpt.xml: 3 complete workspaces (or-paradise, ar-dallas-500153,
sd-false-bottom-creek) with full Dimension time lists, from the live 5.4 MB caps.
ns_caps.xml: real namespace-filtered caps (single workspace).
gs01_hrrr_caps_excerpt.xml: two full HRRR cycles from the live 33 MB gs01 caps.
"""

from responder_worker.pyrecast import (
    deterministic_hrrr_workspaces,
    parse_gs01_caps,
    parse_gs02_caps,
    run_time_from_ws,
)


class TestGs02Excerpt:
    def _runs(self, fixtures):
        _, runs = parse_gs02_caps((fixtures / "gs02_caps_excerpt.xml").read_bytes())
        return runs

    def test_workspaces_enumerated(self, fixtures):
        runs = self._runs(fixtures)
        assert set(runs) == {
            "fire-spread-forecast_or-paradise_20260817_112500",
            "fire-spread-forecast_ar-dallas-500153_20260817_160300",
            "fire-spread-forecast_sd-false-bottom-creek_20260816_223300",
        }
        assert runs["fire-spread-forecast_or-paradise_20260817_112500"]["slug"] == "or-paradise"

    def test_run_time_from_workspace(self, fixtures):
        runs = self._runs(fixtures)
        assert (runs["fire-spread-forecast_or-paradise_20260817_112500"]["run_time"]
                == "2026-08-17T11:25:00Z")

    def test_time_instants_verbatim_minute_precision(self, fixtures):
        runs = self._runs(fixtures)
        inst = runs["fire-spread-forecast_or-paradise_20260817_112500"]["time_instants"]
        # first instant keeps its minute precision, verbatim string
        assert inst[0] == "2026-08-17T11:25:00.000Z"
        assert inst[1] == "2026-08-17T12:00:00.000Z"
        assert inst[-1] == "2026-08-24T11:00:00.000Z"
        assert len(inst) == 169

    def test_bbox_and_native_crs(self, fixtures):
        runs = self._runs(fixtures)
        r = runs["fire-spread-forecast_or-paradise_20260817_112500"]
        w, s, e, n = r["bbox"]
        assert (w, s, e, n) == (
            -118.42344587868021, 45.69706648593457,
            -117.53804607707525, 46.30738279313764,
        )
        assert w < e and s < n
        assert r["native_crs"] == "EPSG:32611"

    def test_products_enumerated(self, fixtures):
        runs = self._runs(fixtures)
        r = runs["fire-spread-forecast_or-paradise_20260817_112500"]
        assert set(r["products"]) == {
            "crown-fire", "flame-length", "hours-since-burned",
            "spread-rate", "time-of-arrival", "isochrones",
        }
        assert r["percentiles"] == [10, 30, 50, 70, 90]
        assert r["products"]["spread-rate"]["timed"] is True
        assert r["products"]["time-of-arrival"]["timed"] is False
        assert r["products"]["isochrones"].get("vector") is True
        tmpl = r["products"]["spread-rate"]["layer_template"]
        assert tmpl == "{ws}:elmfire_landfire_{pct}_spread-rate"

    def test_legend_urls_rewritten_to_proxy(self, fixtures):
        runs = self._runs(fixtures)
        r = runs["fire-spread-forecast_or-paradise_20260817_112500"]
        for p in r["products"].values():
            assert p["legend_url"].startswith("/wms02?")
            assert "geoserver-usw1.pyrecast.org" not in p["legend_url"]
            assert "GetLegendGraphic" in p["legend_url"]


class TestNsCaps:
    def test_namespace_filtered_caps_parse(self, fixtures):
        seq, runs = parse_gs02_caps((fixtures / "ns_caps.xml").read_bytes())
        assert seq == "270882"
        assert list(runs) == ["fire-spread-forecast_or-paradise_20260817_112500"]
        r = runs["fire-spread-forecast_or-paradise_20260817_112500"]
        assert len(r["time_instants"]) == 169
        assert r["time_instants"][0] == "2026-08-17T11:25:00.000Z"


class TestGs01Excerpt:
    def _runs(self, fixtures):
        return parse_gs01_caps((fixtures / "gs01_hrrr_caps_excerpt.xml").read_bytes())

    def test_workspaces(self, fixtures):
        runs = self._runs(fixtures)
        assert set(runs) == {
            "fire-weather-forecast_hrrr_20260817_06",
            "fire-weather-forecast_hrrr_20260817_12",
        }
        assert runs["fire-weather-forecast_hrrr_20260817_12"]["run_time"] == "2026-08-17T12:00:00Z"

    def test_products(self, fixtures):
        runs = self._runs(fixtures)
        products = runs["fire-weather-forecast_hrrr_20260817_12"]["products"]
        for p in ("tmpf", "rh", "ws", "wg", "wd", "ffwi", "smoke",
                  "tcdc", "pign", "meq", "apcp01", "apcptot"):
            assert p in products

    def test_hour_extraction_from_layer_names(self, fixtures):
        runs = self._runs(fixtures)
        hours = runs["fire-weather-forecast_hrrr_20260817_12"]["hours"]
        assert hours[0] == "2026-08-17T12:00:00Z"
        assert hours[1] == "2026-08-17T13:00:00Z"
        assert hours[-1] == "2026-08-19T12:00:00Z"
        assert len(hours) == 49  # long cycle: 49 hourly layers per product


class TestDeterministicCycles:
    def test_workspace_names(self):
        from datetime import datetime, timezone

        ws = deterministic_hrrr_workspaces(
            datetime(2026, 8, 17, 14, 30, tzinfo=timezone.utc), count=4)
        assert ws == [
            "fire-weather-forecast_hrrr_20260817_12",
            "fire-weather-forecast_hrrr_20260817_06",
            "fire-weather-forecast_hrrr_20260817_00",
            "fire-weather-forecast_hrrr_20260816_18",
        ]
        assert run_time_from_ws(ws[0]) == "2026-08-17T12:00:00Z"


# ---------------------------------------------------------------------------
# national detection layers (rotating timestamped snapshots)
# ---------------------------------------------------------------------------

NATIONAL_CAPS = b"""<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities xmlns="http://www.opengis.net/wms" version="1.3.0">
  <Capability><Layer>
    <Layer queryable="1"><Name>fire-detections_current-year-perimeters:current-year-perimeters_20260817_130700</Name></Layer>
    <Layer queryable="1"><Name>fire-detections_current-year-perimeters:current-year-perimeters_20260817_184800</Name></Layer>
    <Layer queryable="1"><Name>fire-detections_current-year-perimeters:current-year-perimeters_20260817_175600</Name></Layer>
    <Layer queryable="1"><Name>other-ws:not-a-perimeter_20260817_190000</Name></Layer>
  </Layer></Capability>
</WMS_Capabilities>
"""


def test_parse_gs01_national_layers_picks_newest():
    from responder_worker import pyrecast
    got = pyrecast.parse_gs01_national_layers(NATIONAL_CAPS)
    assert got is not None
    assert got["layer"] == (
        "fire-detections_current-year-perimeters:current-year-perimeters_20260817_184800"
    )
    assert got["as_of"] == "2026-08-17T18:48:00Z"


def test_parse_gs01_national_layers_empty():
    from responder_worker import pyrecast
    empty = b"""<?xml version="1.0"?><WMS_Capabilities xmlns="http://www.opengis.net/wms" version="1.3.0"><Capability><Layer/></Capability></WMS_Capabilities>"""
    assert pyrecast.parse_gs01_national_layers(empty) is None  # noqa
