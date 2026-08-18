"""frames.py pure functions: instant thinning, epoch_ms key derivation,
CONUS dims, and the national-layers catalog form. (Spread frame annotation
and dims are gone — spread is client-rendered from the public archive.)"""

from responder_worker import config, frames
from responder_worker.frames import (
    bounds4326_to_3857,
    dims_for_width,
    epoch_ms,
    national_layers_image_form,
    thin_instants,
)


def _hourly_instants() -> list[str]:
    """169-instant run: minute-precision first instant (11:25), then hourly
    from 12:00 for 7 days."""
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
        assert epoch_ms("2026-08-17T11:25:00.000Z") == 1786965900000

    def test_key_derivation_is_stable_across_forms(self):
        assert (epoch_ms("2026-08-17T12:00:00.000Z")
                == epoch_ms("2026-08-17T12:00:00Z"))


class TestDims:
    def test_conus_weather_dims(self):
        merc = bounds4326_to_3857(list(config.CONUS_BOUNDS))
        w, h = dims_for_width(merc, config.WEATHER_FRAME_WIDTH)
        assert w == 2560
        assert 1000 < h < 2560  # aspect-correct CONUS

    def test_degenerate_bbox(self):
        assert dims_for_width((0.0, 0.0, 0.0, 10.0), 2048) == (2048, 2048)

    def test_min_one_pixel(self):
        assert dims_for_width((0.0, 0.0, 1e9, 1e-9), 2048)[1] == 1


class TestHelpers:
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


# ---------------------------------------------------------------------------
# Wall-clock deadline (shared by the frames, mirror, and tiling phases).
# Regression: the first full mirror run was killed by the CI timeout mid-tiling
# and published nothing — every phase that can run long must be time-bounded.
# ---------------------------------------------------------------------------

def test_deadline_disabled_when_non_positive():
    frames.start_deadline(0)
    assert not frames.deadline_passed()
    frames.start_deadline(-5)
    assert not frames.deadline_passed()


def test_deadline_fires_after_elapsed(monkeypatch):
    clock = {"t": 1000.0}
    monkeypatch.setattr(frames.time, "monotonic", lambda: clock["t"])
    frames.start_deadline(60)
    assert not frames.deadline_passed()
    clock["t"] = 1059.0
    assert not frames.deadline_passed()
    clock["t"] = 1061.0
    assert frames.deadline_passed()


def test_deadline_is_rearmable(monkeypatch):
    """The tiling phase re-arms the clock after the download phase spends it."""
    clock = {"t": 0.0}
    monkeypatch.setattr(frames.time, "monotonic", lambda: clock["t"])
    frames.start_deadline(10)
    clock["t"] = 20.0
    assert frames.deadline_passed()
    frames.start_deadline(30)          # tiling phase gets its own budget
    assert not frames.deadline_passed()
    clock["t"] = 51.0
    assert frames.deadline_passed()
    frames.start_deadline(0)           # leave global state disabled for others


# ---------------------------------------------------------------------------
# Incident tree shapes (mirror._sync_* dispatch). Real incidents vary wildly;
# each of these shapes mirrored ZERO files at some point.
# ---------------------------------------------------------------------------

def test_daily_key_accepts_both_real_date_formats():
    from responder_worker.mirror import _daily_key
    # Coleman Creek's "Daily Products/" mixes these two in one folder
    assert _daily_key("20260730") == "20260730"
    assert _daily_key("07282026") == "20260728"
    assert _daily_key("12312026") == "20261231"


def test_daily_key_rejects_named_folders():
    from responder_worker.mirror import _daily_key
    for name in ("Current Maps", "DAILY IAP", "Daily Products", "2026", "99999999"):
        assert _daily_key(name) is None, name
