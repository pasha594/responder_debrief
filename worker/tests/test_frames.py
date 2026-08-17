"""frames.py pure functions: instant thinning, epoch_ms key derivation, and
the frameDims port from frontend/src/api/geo.ts."""

from responder_worker import config
from responder_worker.frames import (
    annotate_spread_run,
    annotate_weather_run,
    bounds4326_to_3857,
    dims_for_width,
    epoch_ms,
    frame_dims,
    hour_layer_suffix,
    national_layers_image_form,
    thin_instants,
)


def _hourly_instants() -> list[str]:
    """169-instant run: minute-precision first instant (11:25), then hourly
    from 12:00 for 7 days — the shape gs02 publishes verbatim."""
    from datetime import datetime, timedelta, timezone

    first = "2026-08-17T11:25:00.000Z"
    base = datetime(2026, 8, 17, 12, 0, tzinfo=timezone.utc)
    hourly = [
        (base + timedelta(hours=k)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        for k in range(168)
    ]
    return [first] + hourly


class TestThinInstants:
    def test_169_instant_run(self):
        instants = _hourly_instants()
        assert len(instants) == 169
        thinned = thin_instants(instants)

        # verbatim subset, order preserved
        assert set(thinned) <= set(instants)
        assert thinned == [s for s in instants if s in set(thinned)]

        # the very first (minute-precision) instant is always included
        assert thinned[0] == "2026-08-17T11:25:00.000Z"

        # every instant in the first 24 h after run start
        hourly = instants[1:]
        assert thinned[1:25] == hourly[:24]  # 12:00 .. next-day 11:00

        # then 3-hourly to 72 h: next-day 12:00, 15:00, ... (k % 3 == 0)
        assert thinned[25] == "2026-08-18T12:00:00.000Z"
        assert thinned[26] == "2026-08-18T15:00:00.000Z"
        assert "2026-08-18T13:00:00.000Z" not in thinned
        assert "2026-08-20T09:00:00.000Z" in thinned   # k=69, last 3-hourly
        assert "2026-08-20T11:00:00.000Z" not in thinned  # k=71

        # then 6-hourly beyond 72 h
        assert "2026-08-20T12:00:00.000Z" in thinned   # k=72
        assert "2026-08-20T15:00:00.000Z" not in thinned  # k=75 (3- but not 6-hourly)
        assert "2026-08-20T18:00:00.000Z" in thinned   # k=78
        assert "2026-08-24T06:00:00.000Z" in thinned   # k=162, last kept

        # ~56 frames per product per percentile
        assert len(thinned) == 1 + 24 + 16 + 16 == 57

    def test_empty_and_single(self):
        assert thin_instants([]) == []
        assert thin_instants(["2026-08-17T11:25:00.000Z"]) == [
            "2026-08-17T11:25:00.000Z"]


class TestEpochMs:
    def test_matches_js_date_parse(self):
        # JS: Date.parse('1970-01-02T00:00:00.000Z') === 86400000
        assert epoch_ms("1970-01-02T00:00:00.000Z") == 86_400_000
        # minute-precision first instant
        assert epoch_ms("1970-01-01T01:25:00.000Z") == 5_100_000
        # bare-Z form used by weather hours
        assert epoch_ms("1970-01-01T06:00:00Z") == 21_600_000
        # a real gs02 instant (matches JS Date.parse)
        assert epoch_ms("2026-08-17T11:25:00.000Z") == 1786965900000

    def test_key_derivation_is_stable_across_forms(self):
        assert (epoch_ms("2026-08-17T12:00:00.000Z")
                == epoch_ms("2026-08-17T12:00:00Z"))


class TestFrameDims:
    """Port of frontend/src/api/geo.ts frameDims — must match JS behavior."""

    def test_landscape(self):
        assert frame_dims((0.0, 0.0, 100.0, 50.0), 1536) == (1536, 768)

    def test_portrait(self):
        assert frame_dims((0.0, 0.0, 50.0, 100.0), 1536) == (768, 1536)

    def test_square(self):
        assert frame_dims((0.0, 0.0, 10.0, 10.0), 1536) == (1536, 1536)

    def test_degenerate_bbox(self):
        assert frame_dims((0.0, 0.0, 0.0, 10.0), 1536) == (1536, 1536)

    def test_js_half_up_rounding(self):
        # 1536 * 2.5 / 1536 = 2.5 → JS Math.round gives 3 (Python round() gives 2)
        assert frame_dims((0.0, 0.0, 1536.0, 2.5), 1536) == (1536, 3)

    def test_min_one_pixel(self):
        assert frame_dims((0.0, 0.0, 1e9, 1e-9), 1536)[1] == 1

    def test_conus_weather_dims(self):
        merc = bounds4326_to_3857(list(config.CONUS_BOUNDS))
        w, h = dims_for_width(merc, config.WEATHER_FRAME_WIDTH)
        assert w == 2560
        assert 1000 < h < 2560  # aspect-correct CONUS


class TestHelpers:
    def test_hour_layer_suffix(self):
        assert hour_layer_suffix("2026-08-17T12:00:00Z") == ("20260817", "120000")

    def test_annotate_spread_run(self):
        run = {
            "workspace": "fire-spread-forecast_or-x_20260817_112500",
            "percentiles": [10, 30, 50, 70, 90],
            "time_instants": _hourly_instants(),
            "products": {"spread-rate": {"timed": True,
                                         "layer_template": "{ws}:elmfire_landfire_{pct}_spread-rate"}},
        }
        annotate_spread_run(run, {})
        fr = run["frames"]
        assert fr["percentiles"] == [10, 50]
        assert len(fr["instants"]) == 57
        assert fr["complete"] is False
        assert run["products"]["spread-rate"]["legend"] == \
            "/frames/legends/spread-spread-rate.png"

        annotate_spread_run(run, {run["workspace"]: {"done": True}})
        assert run["frames"]["complete"] is True

    def test_annotate_weather_run(self):
        run = {"workspace": "fire-weather-forecast_hrrr_20260817_12",
               "hours": ["2026-08-17T12:00:00Z", "2026-08-17T13:00:00Z"],
               "products": ["smoke", "ws"]}
        annotate_weather_run(run, {})
        assert run["frames"]["bounds"] == [-125.0, 24.5, -66.5, 49.5]
        assert run["frames"]["hours"] == []
        assert run["frames"]["complete"] is False

        annotate_weather_run(run, {run["workspace"]: {"done": True}})
        assert run["frames"]["hours"] == run["hours"]
        assert run["frames"]["complete"] is True

    def test_national_layers_image_form(self):
        probe = {"current_year_perimeters": {
            "layer": "fire-detections_current-year-perimeters:current-year-perimeters_20260817_175000",
            "as_of": "2026-08-17T17:50:00Z"}}
        out = national_layers_image_form(probe)
        perims = out["current_year_perimeters"]
        assert perims["image"] == "/frames/national/current-year-perimeters.png"
        assert perims["bounds"] == [-125.0, 24.5, -66.5, 49.5]
        assert perims["as_of"] == "2026-08-17T17:50:00Z"
        assert national_layers_image_form({}) == {}
