"""Graticule-text georeferencing: parsing, fitting, validation gates."""

from responder_worker.graticule import (
    fit_axis,
    parse_coord,
    solve_from_words,
)


class TestParseCoord:
    def test_dms_variants(self):
        assert parse_coord("42°55'N") == ("lat", 42 + 55 / 60)
        assert parse_coord("117°10'0\"W") == ("lon", -(117 + 10 / 60))
        assert parse_coord("117°13.5'W") == ("lon", -(117 + 13.5 / 60))
        assert parse_coord("1°30'S")[1] < 0

    def test_signed_and_bare_conus_heuristic(self):
        assert parse_coord("-116°59'") == ("lon", -(116 + 59 / 60))
        assert parse_coord("43°21'") == ("lat", 43 + 21 / 60)
        assert parse_coord("117°15'") == ("lon", -(117 + 15 / 60))

    def test_rejects_non_coordinates(self):
        assert parse_coord("1450") is None            # contour label
        assert parse_coord("Ops") is None
        assert parse_coord("42°75'N") is None         # minutes >= 60
        assert parse_coord("200°10'W") is None        # degrees > 180


class TestFitAxis:
    def test_rejects_outliers_from_inset_maps(self):
        pairs = [(100, 43.0), (300, 42.9), (500, 42.8), (700, 42.7),
                 (410, 45.0)]  # inset-map stray
        a, b, kept, rms = fit_axis(pairs)
        assert len(kept) == 4
        assert rms < 1e-6
        assert abs(a - (-0.0005)) < 1e-9


def _grid_words(n_lat=4, n_lon=4):
    """Synthetic north-up sheet: lon -117.5..-116.9 over x 50..750,
    lat 43.0..42.6 over y 40..760."""
    words = []
    for i in range(n_lon):
        x = 50 + i * 700 / max(1, n_lon - 1)
        lon = -117.5 + i * 0.6 / max(1, n_lon - 1)
        d = abs(lon)
        deg = int(d)
        mins = round((d - deg) * 60, 1)
        words.append((x, 30.0, f"{deg}°{mins}'W"))
    for i in range(n_lat):
        y = 40 + i * 720 / max(1, n_lat - 1)
        lat = 43.0 - i * 0.4 / max(1, n_lat - 1)
        deg = int(lat)
        mins = round((lat - deg) * 60, 1)
        words.append((20.0, y, f"{deg}°{mins}'N"))
    return words


class TestSolve:
    PAGE = (800.0, 800.0)

    def test_solves_a_clean_grid(self):
        fit = solve_from_words(_grid_words(), self.PAGE)
        assert fit is not None
        assert abs(fit.lon_of_x(50) - (-117.5)) < 0.005
        assert abs(fit.lat_of_y(760) - 42.6) < 0.005
        w, s, e, n = fit.frame_bounds_4326()
        assert w < -117.4 and e > -117.0 and s < 42.7 and n > 42.9

    def test_rejects_too_few_labels(self):
        assert solve_from_words(_grid_words(n_lat=2), self.PAGE) is None

    def test_rejects_noise_only(self):
        noise = [(100.0, 100.0, "Ops"), (200.0, 300.0, "1450"), (5.0, 5.0, "Map")]
        assert solve_from_words(noise, self.PAGE) is None

    def test_rejects_south_up(self):
        words = [(x, 800 - y, t) if t.endswith("N") else (x, y, t)
                 for x, y, t in _grid_words()]
        assert solve_from_words(words, self.PAGE) is None

    def test_rejects_implausible_location(self):
        words = [(x, y, t.replace("117", "17").replace("116", "16"))
                 for x, y, t in _grid_words()]
        # lons parse as lats under the heuristic / bounds fall outside CONUS
        assert solve_from_words(words, self.PAGE) is None
