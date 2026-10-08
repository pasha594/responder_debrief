"""Catalog assembly against the data contracts: every field present,
spread flags fed by the archives doc, filename parsing on real names."""

import json

from responder_worker import archives, catalogs
from responder_worker.fires import fire_key
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
        # no wd/ffwi rasters (direction ships as wind_uv arrow grids)
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
        spread_index = {fire_key(e["cornea_id"]): e["runs"][0]["run_time"]
                        for e in pyre["fires"].values() if e["runs"]}
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
            tiles_prefix="elk", preview_prefix="elk",
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

    def test_garbage_op_date_rejected(self):
        # "8018day" reads as month 80 — the Gold Mountain case
        p = parse_product_filename(
            "ops_arch_e_port_20260818_2100_GoldMountain_CANOD000123_8018day.pdf")
        assert p["op_date"] is None
        assert p["generated_at_local"] == "2026-08-18T21:00"
        assert p["product"] == "ops"  # the rest of the name still parses

    def test_garbage_anchor_date_rejected(self):
        # month 17 in the generation stamp itself — the MP18 case
        p = parse_product_filename(
            "ops_arch_e_port_20261700_2100_MP18_NVEKD000456_1700day.pdf")
        assert p["generated_at_local"] is None
        assert p["op_date"] is None

    def test_date_outside_sane_window_rejected(self):
        p = parse_product_filename(
            "ops_arch_e_port_19990816_2100_Elk_COGMF000114_817day.pdf")
        assert p["generated_at_local"] is None
        assert p["op_date"] is None

    def test_date_source_filename(self):
        parsed = parse_product_filename(
            "ops_arch_e_port_20260816_2100_Elk_COGMF000114_817day.pdf")
        entry = map_entry(
            parsed=parsed, kind="product", sha_id="a" * 16,
            tiles_prefix="elk", preview_prefix="elk",
            pdf_key="raw/incidents/elk/x.pdf", size_bytes=1, geo=None,
            uploaded_lm="Sun, 16 Aug 2026 03:18:07 GMT",
        )
        assert entry["op_date"] == "2026-08-17"
        assert entry["date_source"] == "filename"

    def test_date_source_ftp_fallback(self):
        parsed = parse_product_filename(
            "ops_arch_e_port_20260818_2100_GoldMountain_CANOD000123_8018day.pdf")
        entry = map_entry(
            parsed=parsed, kind="product", sha_id="b" * 16,
            tiles_prefix="gold", preview_prefix="gold",
            pdf_key="raw/incidents/gold/x.pdf", size_bytes=1, geo=None,
            uploaded_lm="Tue, 18 Aug 2026 03:18:07 GMT",
            first_seen="2026-08-19T00:00:00Z",
        )
        assert entry["op_date"] == "2026-08-18"
        assert entry["date_source"] == "ftp"
        assert entry["uploaded_at"] == "2026-08-18T03:18:07Z"

    def test_date_source_ingested_fallback(self):
        parsed = parse_product_filename("SomethingUnparseable.pdf")
        entry = map_entry(
            parsed=parsed, kind="product", sha_id="c" * 16,
            tiles_prefix="x", preview_prefix="x",
            pdf_key="raw/incidents/x/x.pdf", size_bytes=1, geo=None,
            first_seen="2026-08-19T12:34:56Z",
        )
        assert entry["op_date"] == "2026-08-19"
        assert entry["date_source"] == "ingested"

    def test_date_source_none_when_nothing_known(self):
        parsed = parse_product_filename("SomethingUnparseable.pdf")
        entry = map_entry(
            parsed=parsed, kind="product", sha_id="d" * 16,
            tiles_prefix="x", preview_prefix="x",
            pdf_key="raw/incidents/x/x.pdf", size_bytes=1, geo=None,
        )
        assert entry["op_date"] is None
        assert entry["date_source"] is None

    def test_non_geo_entry(self):
        parsed = parse_product_filename(
            "mobile_72x96_land_20260816_2056_Elk_COGMF000114_817.pdf")
        entry = map_entry(
            parsed=parsed, kind="mobile", sha_id="ffff000011112222",
            tiles_prefix="elk", preview_prefix="elk",
            pdf_key="raw/incidents/elk/products/20260817/x.pdf",
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


class TestRetainDrawableRun:
    @staticmethod
    def _weather(runs):
        return {"models": {"hrrr": {"runs": runs}}}

    @staticmethod
    def _run(ws, hours):
        return {"workspace": ws,
                "frames": {"hours": hours, "complete": bool(hours)}}

    def test_noop_when_a_discovered_run_is_drawable(self):
        w = self._weather([self._run("hrrr_18", []), self._run("hrrr_17", ["h"])])
        assert catalogs.retain_drawable_run(w, self._weather([self._run("hrrr_16", ["h"])])) is False
        assert len(w["models"]["hrrr"]["runs"]) == 2

    def test_carries_newest_drawable_from_previous_manifest(self):
        w = self._weather([self._run("hrrr_18", []), self._run("hrrr_17", [])])
        prev = self._weather([self._run("hrrr_17", []), self._run("hrrr_16", ["h"])])
        assert catalogs.retain_drawable_run(w, prev) is True
        runs = w["models"]["hrrr"]["runs"]
        assert [r["workspace"] for r in runs] == ["hrrr_18", "hrrr_17", "hrrr_16"]

    def test_never_duplicates_a_workspace(self):
        w = self._weather([self._run("hrrr_17", [])])
        prev = self._weather([self._run("hrrr_17", ["h"])])
        # same workspace, previous copy drawable — but appending it would
        # duplicate the id, so nothing is carried
        assert catalogs.retain_drawable_run(w, prev) is False

    def test_handles_missing_previous_manifest(self):
        w = self._weather([self._run("hrrr_18", [])])
        assert catalogs.retain_drawable_run(w, None) is False

    def test_legacy_runs_without_frames_block_count_as_drawable(self):
        w = self._weather([{"workspace": "hrrr_18"}])
        assert catalogs.retain_drawable_run(w, self._weather([])) is False


def test_valid_day_filters_garbage_dates():
    from responder_worker.cli import _valid_day

    assert _valid_day("2026-08-20")
    assert _valid_day("2026-12-31")
    assert not _valid_day("2026-17-00")
    assert not _valid_day("2026-00-01")
    assert not _valid_day(None)
    assert not _valid_day("20260820")


def test_build_catalog_counts_and_legacy_spread_index():
    from responder_worker import catalogs as cat

    fires = [{"fire_slug": "a", "cornea_id": "{X}", "post_title": "A"}]
    out = cat.build_catalog(
        fires, version=1,
        spread_index={"x": {"latest": "2026-08-20T00:00:00Z", "count": 4}},
        perimeter_counts={"x": 79},
        incident_matches={"a": {"method": "unit_id", "confidence": 1.0,
                                "dir_url": "u", "synced_at": None,
                                "map_count": 86, "ir_count": 2,
                                "latest_upload": "2026-08-20",
                                "latest_upload_ts": "2026-08-20T21:48:00Z"}},
    )
    f = out["fires"][0]
    assert f["perimeter_count"] == 79
    assert f["spread_run_count"] == 4
    assert f["spread_latest_run"] == "2026-08-20T00:00:00Z"
    assert f["incident_latest_upload_ts"] == "2026-08-20T21:48:00Z"

    legacy = cat.build_catalog(fires, version=2,
                               spread_index={"x": "2026-08-19T00:00:00Z"})
    g = legacy["fires"][0]
    assert g["spread_latest_run"] == "2026-08-19T00:00:00Z"
    assert g["spread_run_count"] is None


# ---------------------------------------------------------------------------
# identity by fire ID: two active fires named Chipmunk swap the bare slug
# whenever the other one updates (live 2026-10-08)
# ---------------------------------------------------------------------------

FL = {"fire_slug": "chipmunk", "post_title": "Chipmunk", "state": "FL",
      "cornea_id": "{961F6E41-0000-4000-8000-00000000000F}",
      "poly_last_updated": "2026-09-01T00:00:00Z"}
WI = {"fire_slug": "chipmunk-wi", "post_title": "Chipmunk", "state": "WI",
      "cornea_id": "{0C1D2E3F-0000-4000-8000-0000000000A1}",
      "poly_last_updated": None}


def test_slug_swap_keeps_each_fires_forecast_and_count():
    spread_index = {fire_key(FL["cornea_id"]): {"latest": "2026-08-24T15:41:00Z", "count": 2}}
    counts = {fire_key(FL["cornea_id"]): 3, fire_key(WI["cornea_id"]): 0}
    swapped = [{**WI, "fire_slug": "chipmunk"}, {**FL, "fire_slug": "chipmunk-fl"}]
    doc = catalogs.build_catalog(swapped, version=1, spread_index=spread_index,
                                 perimeter_counts=counts)
    by_state = {f["state"]: f for f in doc["fires"]}
    assert by_state["FL"]["spread_latest_run"] == "2026-08-24T15:41:00Z"
    assert by_state["FL"]["perimeter_count"] == 3
    assert not by_state["WI"]["has_spread_forecast"]
    assert by_state["WI"]["perimeter_count"] == 0


def test_perim_counts_migrate_only_when_the_perimeter_matches():
    from responder_worker.cli import migrate_perim_counts
    state = {"perim_counts": {
        # FL held "chipmunk" when cached; WI holds it now, with no perimeter
        "chipmunk": {"count": 3, "poly": "2026-09-01T00:00:00Z"},
        "chipmunk-fl": {"count": 9, "poly": "2026-08-01T00:00:00Z"},  # stale
    }}
    fires = [{**WI, "fire_slug": "chipmunk"}, {**FL, "fire_slug": "chipmunk-fl"}]
    by_id = migrate_perim_counts(state, fires)
    assert "perim_counts" not in state
    assert by_id == {}  # WI's poly differs; FL's slug-keyed record is stale
    fires = [{**FL, "fire_slug": "chipmunk"}]
    state = {"perim_counts": {"chipmunk": {"count": 3, "poly": "2026-09-01T00:00:00Z"}}}
    assert migrate_perim_counts(state, fires) == {
        fire_key(FL["cornea_id"]): {"count": 3, "poly": "2026-09-01T00:00:00Z"}}


def test_fire_keys_agree_across_id_spellings():
    from responder_worker import hotspots, routing_plan
    braced = "{51528708-A49A-42FA-8855-C13CE748EC08}"
    for spelling in (braced, braced.strip("{}"), braced.lower(), braced.strip("{}").lower()):
        assert fire_key(spelling) == "51528708-a49a-42fa-8855-c13ce748ec08"
        assert hotspots.archive_id({"cornea_id": spelling}) == fire_key(spelling)
        assert routing_plan.fire_key(spelling) == fire_key(spelling)
    assert fire_key("") is None and fire_key(None) is None


# ---------------------------------------------------------------------------
# incident maps by fire ID (catalog_incident_index, after the migration)
# ---------------------------------------------------------------------------

FL_FK, WI_FK = fire_key(FL["cornea_id"]), fire_key(WI["cornea_id"])


def _index_entry(fk, dirs, *, maps, method="unit_id", synced="2026-10-08T16:00:00Z"):
    """A state["incident_fires"] entry, as the mirror writes it."""
    return {"v": 1, "cornea_id": "{" + fk.upper() + "}",
            "manifest": f"catalogs/incidents/id/{fk}.json", "dirs": dirs,
            "primary": dirs[0], "method": method, "confidence": 1.0,
            "dir_url": f"https://ftp.wildfire.gov/{dirs[0]}/", "synced_at": synced,
            "built_at": "2026-10-08T16:05:00Z",
            "counts": {"maps": maps, "ir": 2, "latest_upload": "2026-10-07",
                       "latest_upload_ts": "2026-10-07T21:00:00Z"}}


def test_legacy_path_identical_when_index_none(fixtures, monkeypatch):
    # Golden output of build_catalog before incident_fires existed: the
    # slug-keyed path must stay byte for byte the same until the migration.
    golden = json.loads((fixtures / "catalog_legacy_golden.json").read_text())
    inp = golden["input"]
    monkeypatch.setattr(catalogs, "now_iso", lambda: golden["expected"]["generated_at"])
    out = build_catalog(
        inp["fires"], version=inp["version"], incident_matches=inp["incident_matches"],
        incident_fires=None, spread_index=inp["spread_index"],
        perimeter_counts=inp["perimeter_counts"],
        hotspot_archives=set(inp["hotspot_archives"]),
        national_layers=inp["national_layers"])
    assert json.dumps(out, indent=1, ensure_ascii=False) == json.dumps(
        golden["expected"], indent=1, ensure_ascii=False)


def test_build_catalog_by_fire_id_with_swapped_slugs():
    # WI took the bare "chipmunk" slug; FL's folder was matched (and its
    # legacy record keyed) while FL held it. By ID, FL keeps its maps and
    # WI is handed nothing.
    fires = [{**WI, "fire_slug": "chipmunk"}, {**FL, "fire_slug": "chipmunk-fl"}]
    legacy = {"chipmunk": {"method": "name_exact", "confidence": 0.95, "dir_url": "u",
                           "synced_at": None, "map_count": 9, "ir_count": 0,
                           "latest_upload": None, "latest_upload_ts": None}}
    index = {FL_FK: _index_entry(FL_FK, ["southern/2026/2026_Chipmunk",
                                         "southern/2026/2026_ChipmunkComplex"], maps=14),
             # an entry whose manifest was never written is not advertised
             WI_FK: {**_index_entry(WI_FK, ["great_lakes/2026/2026_Chipmunk"], maps=1),
                     "manifest": None}}
    doc = build_catalog(fires, version=9, incident_matches=legacy, incident_fires=index)
    by_state = {f["state"]: f for f in doc["fires"]}
    fl, wi = by_state["FL"], by_state["WI"]
    assert fl["has_incident_maps"] is True
    assert fl["incident_manifest"] == f"/catalogs/incidents/id/{FL_FK}.json"
    assert fl["incident_last_synced"] == "2026-10-08T16:00:00Z"
    assert (fl["incident_map_count"], fl["incident_ir_count"]) == (14, 2)
    assert fl["incident_latest_upload"] == "2026-10-07"
    assert fl["incident_latest_upload_ts"] == "2026-10-07T21:00:00Z"
    assert fl["ftp_match"] == {"method": "unit_id", "confidence": 1.0,
                               "dir_url": "https://ftp.wildfire.gov/southern/2026/2026_Chipmunk/"}
    assert wi["has_incident_maps"] is False
    assert wi["incident_manifest"] is None and wi["ftp_match"] is None
    assert wi["incident_map_count"] is None
    # every folder feeding an advertised fire
    assert doc["counts"]["matched_incident_dirs"] == 2


def test_inactive_fire_record_not_advertised_on_same_name_fire():
    # 2026_Wildhorse belongs to Wildhorse ID, no longer active; the
    # "wildhorse" slug now names WILDHORSE OK, which has no maps.
    id_fk = "177292f2-0000-4000-8000-000000000003"
    ok = {"fire_slug": "wildhorse", "post_title": "WILDHORSE", "state": "OK",
          "cornea_id": "{8C318F2C-0000-4000-8000-000000000004}"}
    index = {id_fk: _index_entry(id_fk, ["great_basin/2026/2026_Wildhorse"], maps=3)}
    doc = build_catalog([ok], version=1, incident_fires=index)
    row = doc["fires"][0]
    assert row["has_incident_maps"] is False and row["incident_manifest"] is None
    assert doc["counts"]["matched_incident_dirs"] == 0


def test_map_entry_split_tile_and_preview_prefixes():
    # A Grasshopper sheet tiled under austin/ while the folder was bound to
    # Austin, previewed under grasshopper/, its PDF re-mirrored to the
    # folder's own prefix: each URL names where its object is.
    sha = "5b0d93088c8ddb6c"
    pdf = "raw/incidents/grasshopper/products/20260817/ops.pdf"
    parsed = parse_product_filename(
        "ops_arch_e_port_20260816_2155_Grasshopper_ORMHF000688_0817day.pdf")
    entry = map_entry(
        parsed=parsed, kind="product", sha_id=sha, tiles_prefix="austin", preview_prefix="grasshopper",
        pdf_key=pdf, size_bytes=1,
        geo={"georeferenced": True, "preview": True,
             "tiles": {"minzoom": 9, "maxzoom": 15, "bounds": [-121, 44, -120, 45]}})
    assert entry["tiles"]["url_template"] == f"/tiles/incidents/austin/{sha}/{{z}}/{{x}}/{{y}}.png"
    assert entry["preview_url"] == f"/previews/incidents/grasshopper/{sha}.png"
    assert entry["pdf_url"] == f"/{pdf}"


def test_manifest_has_fire_key_and_sources():
    fire = {**FL, "fire_slug": "chipmunk-fl"}
    sources = [{"dir_url": "https://ftp.wildfire.gov/southern/2026/2026_Chipmunk/",
                "region": "southern", "unit_incident": "FLFNF000123", "method": "unit_id"}]
    doc = build_incident_manifest(fire=fire, region="southern",
                                  source_dir=sources[0]["dir_url"],
                                  unit_incident="FLFNF000123", maps=[], ir_flights=[],
                                  sources=sources)
    assert doc["schema_version"] == 1
    assert doc["fire_key"] == FL_FK and doc["cornea_id"] == FL["cornea_id"]
    assert doc["sources"] == sources
    # a legacy slug manifest is unchanged
    legacy = build_incident_manifest(fire=fire, region="southern", source_dir="u",
                                     unit_incident=None, maps=[], ir_flights=[])
    assert "fire_key" not in legacy and "sources" not in legacy


def test_catalog_incident_index_none_before_migration():
    index = {FL_FK: _index_entry(FL_FK, ["southern/2026/2026_Chipmunk"], maps=1)}
    assert catalogs.catalog_incident_index({"incident_fires": index}) is None
    assert catalogs.catalog_incident_index(
        {"incident_fires": index, "migrations": {}}) is None
    migrated = {"incident_fires": index,
                "migrations": {"incident_ids": "2026-10-09T00:00:00Z"}}
    assert catalogs.catalog_incident_index(migrated) == index
    # migrated with nothing built yet: advertise nothing, never fall back
    assert catalogs.catalog_incident_index(
        {"migrations": {"incident_ids": "2026-10-09T00:00:00Z"}}) == {}
