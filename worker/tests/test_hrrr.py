"""hrrr.py pure functions, pinned to a REAL captured HRRR idx sidecar.

Fixture hrrr_t12z_wrfsfcf02.grib2.idx: live idx of
hrrr.20260817/conus/hrrr.t12z.wrfsfcf02.grib2 (173 messages), captured
2026-08-17 — includes the APCP run-total/hourly-window pair (messages 84/90).
"""

import math
from datetime import datetime, timezone

import pytest

from responder_worker import frames
from responder_worker.hrrr import (
    PRODUCTS,
    RAMPS,
    apcp_window_fcst,
    annotate_run,
    byte_range,
    discover_runs,
    expected_fhour_count,
    grib_key,
    image_key,
    manifest_products,
    parse_idx,
    parse_listing_fhours,
    ramp_file_text,
    run_from_cycle,
    select_records,
    workspace_name,
)


@pytest.fixture(scope="module")
def records(fixtures):
    return parse_idx((fixtures / "hrrr_t12z_wrfsfcf02.grib2.idx").read_text())


def _by_msgnum(records, n):
    idx = [i for i, r in enumerate(records) if r.msgnum == n]
    assert len(idx) == 1
    return idx[0]


# ---------------------------------------------------------------------------
# idx parsing (real file)
# ---------------------------------------------------------------------------

class TestParseIdx:
    def test_full_parse(self, records):
        assert len(records) == 173
        first = records[0]
        assert (first.msgnum, first.offset, first.var, first.level, first.fcst) \
            == (1, 0, "REFC", "entire atmosphere", "2 hour fcst")

    def test_unnamed_var_line_parsed(self, records):
        # message 3 has the 'var discipline=... parm=201' form — still a record
        r = records[2]
        assert r.msgnum == 3 and r.offset == 465858
        assert r.var.startswith("var discipline=0")

    def test_known_offsets(self, records):
        assert records[_by_msgnum(records, 9)].offset == 2763140      # GUST
        assert records[_by_msgnum(records, 71)].offset == 40640438    # TMP
        assert records[_by_msgnum(records, 77)].offset == 48494556    # UGRD
        assert records[_by_msgnum(records, 78)].offset == 50638028    # VGRD

    def test_garbage_lines_skipped(self):
        assert parse_idx("") == []
        assert parse_idx("not:an:idx\n\nxx:yy:zz:a:b:c:") == []


# ---------------------------------------------------------------------------
# byte-range math (message size = next offset - offset; last open-ended)
# ---------------------------------------------------------------------------

class TestByteRange:
    def test_interior_message(self, records):
        i = _by_msgnum(records, 77)                    # UGRD, next is VGRD
        assert byte_range(records, i) == "bytes=48494556-50638027"
        assert byte_range(records, i + 1) == "bytes=50638028-52781499"

    def test_last_message_open_range(self, records):
        assert records[-1].offset == 152163330
        assert byte_range(records, len(records) - 1) == "bytes=152163330-"


# ---------------------------------------------------------------------------
# EXACT record selection (incl. the APCP window trap)
# ---------------------------------------------------------------------------

class TestSelectRecords:
    def test_single_message_products(self, records):
        assert [records[i].var for i in select_records(records, "tmpf", 2)] == ["TMP"]
        assert [records[i].var for i in select_records(records, "rh", 2)] == ["RH"]
        assert [records[i].var for i in select_records(records, "wg", 2)] == ["GUST"]
        assert [records[i].var for i in select_records(records, "smoke", 2)] \
            == ["MASSDEN"]
        assert records[select_records(records, "smoke", 2)[0]].level \
            == "8 m above ground"

    def test_ws_needs_ugrd_then_vgrd(self, records):
        sel = select_records(records, "ws", 2)
        assert [records[i].var for i in sel] == ["UGRD", "VGRD"]
        assert all(records[i].level == "10 m above ground" for i in sel)
        assert [records[i].msgnum for i in sel] == [77, 78]

    def test_apcp_window_not_run_total(self, records):
        # the f02 file has APCP:surface twice: 0-2 (run total, msg 84) and
        # 1-2 (hourly window, msg 90) — the window MUST win
        sel = select_records(records, "apcp01", 2)
        assert [records[i].msgnum for i in sel] == [90]
        assert records[sel[0]].fcst == "1-2 hour acc fcst"

    def test_apcp_window_strings(self):
        assert apcp_window_fcst(1) == "0-1 hour acc fcst"
        assert apcp_window_fcst(2) == "1-2 hour acc fcst"
        assert apcp_window_fcst(48) == "47-48 hour acc fcst"

    def test_apcp_missing_at_f00(self, records):
        # no '(-1)-0 hour acc fcst' record exists — f00 has no hourly window
        assert select_records(records, "apcp01", 0) is None

    def test_missing_var_returns_none(self, records):
        no_gust = [r for r in records if r.var != "GUST"]
        assert select_records(no_gust, "wg", 2) is None
        no_vgrd = [r for r in records if r.var != "VGRD"]
        assert select_records(no_vgrd, "ws", 2) is None


# ---------------------------------------------------------------------------
# ramp files == manifest legend_stops (single RAMPS source of truth)
# ---------------------------------------------------------------------------

class TestRamps:
    def test_every_product_has_a_ramp(self):
        assert set(RAMPS) == set(PRODUCTS)

    def test_ramp_file_matches_legend_stops(self):
        for product in PRODUCTS:
            stops = manifest_products()[product]["legend_stops"]
            lines = ramp_file_text(product).strip().splitlines()
            assert lines[-1] == "nv 0 0 0 0"          # nodata transparent
            body = lines[:-1]
            assert len(body) == len(stops)
            for line, (value, color) in zip(body, stops):
                v, r, g, b, a = line.split()
                assert float(v) == pytest.approx(value)
                assert a == "255"
                assert f"#{int(r):02x}{int(g):02x}{int(b):02x}" == color

    def test_manifest_products_shape(self):
        mp = manifest_products()
        assert set(mp) == {"ws", "wg", "tmpf", "rh", "smoke", "apcp01"}
        assert mp["ws"]["units"] == "mph"
        assert mp["ws"]["legend_stops"][0] == [0, "#78b4dc"]
        assert mp["ws"]["legend_stops"][-1] == [70, "#6e1450"]
        assert mp["wg"]["legend_stops"] == mp["ws"]["legend_stops"]
        assert mp["apcp01"]["legend_stops"][1] == [0.05, "#627cae"]
        # no wd/ffwi in v1 (deferred per spec)
        assert "wd" not in mp and "ffwi" not in mp


# ---------------------------------------------------------------------------
# valid-time / key derivation
# ---------------------------------------------------------------------------

class TestKeys:
    def test_run_from_cycle(self):
        cycle = datetime(2026, 8, 18, 0, tzinfo=timezone.utc)
        run = run_from_cycle(cycle, [0, 1, 2])
        assert run["workspace"] == "hrrr_20260818_00"
        assert run["run_time"] == "2026-08-18T00:00:00Z"
        assert run["hours"] == ["2026-08-18T00:00:00Z", "2026-08-18T01:00:00Z",
                                "2026-08-18T02:00:00Z"]

    def test_image_key_epoch_ms_is_valid_time(self):
        key = image_key("hrrr_20260818_00", "ws", "2026-08-18T02:00:00Z")
        assert key == "frames/weather/hrrr_20260818_00/ws/1787018400000.png"
        assert frames.epoch_ms("2026-08-18T02:00:00Z") == 1787018400000

    def test_workspace_and_grib_key(self):
        cycle = datetime(2026, 8, 17, 12, tzinfo=timezone.utc)
        assert workspace_name(cycle) == "hrrr_20260817_12"
        assert grib_key("20260817", 12, 2) \
            == "hrrr.20260817/conus/hrrr.t12z.wrfsfcf02.grib2"

    def test_expected_fhour_count(self):
        for h, n in ((0, 49), (6, 49), (12, 49), (18, 49), (1, 19), (17, 19)):
            assert expected_fhour_count(
                datetime(2026, 8, 17, h, tzinfo=timezone.utc)) == n


# ---------------------------------------------------------------------------
# unit-conversion formulas (the exact gdal_calc expressions)
# ---------------------------------------------------------------------------

def _calc(product: str, **vals) -> float:
    expr = PRODUCTS[product]["calc"]
    return eval(expr, {"sqrt": math.sqrt}, vals)  # noqa: S307 — our own consts


class TestUnitConversions:
    def test_ws_magnitude_and_mph(self):
        assert _calc("ws", A=3.0, B=4.0) == pytest.approx(5 * 2.23694)
        assert _calc("ws", A=0.0, B=0.0) == 0.0

    def test_wg_mph(self):
        assert _calc("wg", A=10.0) == pytest.approx(22.3694)

    def test_tmpf(self):
        assert _calc("tmpf", A=273.15) == pytest.approx(32.0)
        assert _calc("tmpf", A=310.9278) == pytest.approx(100.0, abs=1e-3)

    def test_smoke_ug_m3(self):
        assert _calc("smoke", A=2.5e-8) == pytest.approx(25.0)

    def test_apcp01_inches(self):
        assert _calc("apcp01", A=25.4) == pytest.approx(1.0)

    def test_rh_passthrough(self):
        assert PRODUCTS["rh"]["calc"] is None


# ---------------------------------------------------------------------------
# S3 listing parse + cycle discovery
# ---------------------------------------------------------------------------

_LISTING = b"""<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>noaa-hrrr-bdp-pds</Name><KeyCount>5</KeyCount>
  <Contents><Key>hrrr.20260817/conus/hrrr.t12z.wrfsfcf00.grib2</Key></Contents>
  <Contents><Key>hrrr.20260817/conus/hrrr.t12z.wrfsfcf00.grib2.idx</Key></Contents>
  <Contents><Key>hrrr.20260817/conus/hrrr.t12z.wrfsfcf01.grib2</Key></Contents>
  <Contents><Key>hrrr.20260817/conus/hrrr.t12z.wrfsfcf01.grib2.idx</Key></Contents>
  <Contents><Key>hrrr.20260817/conus/hrrr.t12z.wrfsfcf02.grib2</Key></Contents>
</ListBucketResult>
"""


class TestDiscovery:
    def test_parse_listing_needs_both_grib_and_idx(self):
        # f02 has no .idx yet (mid-upload) -> excluded
        assert parse_listing_fhours(_LISTING) == [0, 1]

    def test_discover_runs_newest_with_enough_hours(self, monkeypatch):
        from responder_worker import hrrr as hrrr_mod

        avail = {
            "hrrr_20260817_14": [],
            "hrrr_20260817_13": [0],            # only one hour: skipped
            "hrrr_20260817_12": list(range(49)),
            "hrrr_20260817_11": list(range(19)),
        }
        monkeypatch.setattr(
            hrrr_mod, "list_cycle_fhours",
            lambda client, cycle: avail.get(workspace_name(cycle), []))
        runs = discover_runs(None, datetime(2026, 8, 17, 14, 30,
                                            tzinfo=timezone.utc))
        assert [r["workspace"] for r in runs] \
            == ["hrrr_20260817_12", "hrrr_20260817_11"]
        assert len(runs[0]["hours"]) == 49
        assert runs[0]["hours"][0] == "2026-08-17T12:00:00Z"
        assert runs[0]["hours"][-1] == "2026-08-19T12:00:00Z"
        assert len(runs[1]["hours"]) == 19


class TestAnnotate:
    def test_annotate_run(self):
        run = {"workspace": "hrrr_20260817_12",
               "hours": ["2026-08-17T12:00:00Z", "2026-08-17T13:00:00Z"]}
        annotate_run(run, {})
        fr = run["frames"]
        assert fr["bounds"] == [-125.0, 24.5, -66.5, 49.5]
        assert fr["image_template"] == "/frames/weather/{ws}/{product}/{epoch_ms}.png"
        assert fr["hours"] == [] and fr["complete"] is False

        annotate_run(run, {"hrrr_20260817_12": {"done": True}})
        assert run["frames"]["hours"] == run["hours"]
        assert run["frames"]["complete"] is True
