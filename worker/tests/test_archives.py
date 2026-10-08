"""archives.py against REAL captured excerpts of the public forecast archive.

archive_manifest_excerpt.json: 6 verbatim runs from the live manifest.json —
wa-sinlahekin 20260817_112500 (incomplete, in progress), 20260817_100500
(complete, newest), 20260816_215300 (expired incomplete), 20260816_205500
(complete, previous), 20260815_104100 (complete, third), and
ca-talbot 20260813_110300 (complete).
archive_fire_matches_excerpt.json: matches for wa-sinlahekin + ca-bug and two
unmatched entries — ca-talbot deliberately absent to exercise the fuzzy
slug fallback.
"""

import json

import httpx
import pytest

from responder_worker import archives, config
from responder_worker.b2 import DryRunStorage


@pytest.fixture()
def manifest(fixtures):
    return json.loads((fixtures / "archive_manifest_excerpt.json").read_text())


@pytest.fixture()
def fire_matches(fixtures):
    return json.loads((fixtures / "archive_fire_matches_excerpt.json").read_text())


SINLAHEKIN_CORNEA = "{78D35D3B-F791-4961-AE36-C6D1A4DFF5A0}"


def _fires(include_talbot: bool = True):
    fires = [
        {
            "fire_slug": "sinlahekin", "post_title": "SINLAHEKIN", "state": "WA",
            "cornea_id": SINLAHEKIN_CORNEA, "unique_fire_id": "2026-WANES-000391",
            "coordinates": [-119.68, 48.74],
        },
    ]
    if include_talbot:
        fires.append({
            "fire_slug": "talbot", "post_title": "Talbot", "state": "CA",
            "cornea_id": "{CCCC1111-2222-3333-4444-555566667777}",
            "unique_fire_id": "2026-CATNF-001234",
            "coordinates": [-120.38, 39.18],
        })
    return fires


# ---------------------------------------------------------------------------
# manifest parsing / run selection
# ---------------------------------------------------------------------------

class TestCandidateRuns:
    def test_complete_non_expired_only_newest_first(self, manifest):
        by_slug = archives.candidate_runs(manifest)
        assert set(by_slug) == {"wa-sinlahekin", "ca-talbot"}
        # incomplete (20260817_112500) and expired (20260816_215300) skipped
        assert [e["run_ts"] for e in by_slug["wa-sinlahekin"]] == [
            "20260817_100500", "20260816_205500", "20260815_104100"]
        assert [e["run_ts"] for e in by_slug["ca-talbot"]] == ["20260813_110300"]

    def test_newest_run_plus_one_previous(self, manifest, fire_matches):
        doc = archives.build_pyrecast_runs(_fires(), manifest, fire_matches)
        runs = doc["fires"]["sinlahekin"]["runs"]
        assert [r["run_ts"] for r in runs] == ["20260817_100500", "20260816_205500"]
        assert runs[0]["run_time"] == "2026-08-17T10:05:00Z"


def test_run_time_from_ts():
    assert archives.run_time_from_ts("20260817_112500") == "2026-08-17T11:25:00Z"
    assert archives.run_time_from_ts("garbage") is None
    assert archives.run_time_from_ts("") is None


# ---------------------------------------------------------------------------
# availability extraction (files -> toa pcts, vars -> product pcts)
# ---------------------------------------------------------------------------

class TestAvailability:
    def test_toa_percentiles_from_files_ok(self, manifest, fire_matches):
        doc = archives.build_pyrecast_runs(_fires(), manifest, fire_matches)
        run = doc["fires"]["sinlahekin"]["runs"][0]
        assert run["toa"]["percentiles"] == [10, 30, 50, 70, 90]

    def test_product_percentiles_from_vars_ok(self, manifest, fire_matches):
        doc = archives.build_pyrecast_runs(_fires(), manifest, fire_matches)
        run = doc["fires"]["sinlahekin"]["runs"][0]  # 20260817_100500 (real data)
        pcts = {name: p["percentiles"] for name, p in run["products"].items()}
        assert pcts == {
            "crown-fire": [10, 50, 90],
            "flame-length": [10, 70, 90],
            "hours-since-burned": [10, 30, 70, 90],
            "spread-rate": [10, 30, 70],
        }
        # isochrones (vector) never surfaces as a product
        assert "isochrones" not in run["products"]

    def test_horizon_hours_from_vars_n(self, manifest, fire_matches):
        doc = archives.build_pyrecast_runs(_fires(), manifest, fire_matches)
        for entry in doc["fires"].values():
            for run in entry["runs"]:
                assert run["horizon_hours"] == 169  # max vars[*][*].n

    def test_partial_products_at_previous_run(self, manifest, fire_matches):
        doc = archives.build_pyrecast_runs(_fires(), manifest, fire_matches)
        prev = doc["fires"]["sinlahekin"]["runs"][1]  # 20260816_205500
        assert prev["products"]["crown-fire"]["percentiles"] == [10, 30, 50, 70, 90]
        assert prev["products"]["flame-length"]["percentiles"] == [10, 30, 50, 70]


# ---------------------------------------------------------------------------
# matching: fire_matches.json primary, match_pyrecast_slug fallback
# ---------------------------------------------------------------------------

class TestMatching:
    def test_fire_matches_is_primary(self, manifest, fire_matches):
        doc = archives.build_pyrecast_runs(_fires(), manifest, fire_matches)
        entry = doc["fires"]["sinlahekin"]
        assert entry["pyrecast_slug"] == "wa-sinlahekin"
        assert entry["match_method"] == "fire_matches"
        assert entry["match_confidence"] == 1.0

    def test_cornea_id_matching_tolerates_braces_and_case(self, manifest, fire_matches):
        fires = _fires()
        fires[0]["cornea_id"] = "78d35d3b-f791-4961-ae36-c6d1a4dff5a0"  # no braces, lc
        doc = archives.build_pyrecast_runs(fires, manifest, fire_matches)
        assert doc["fires"]["sinlahekin"]["match_method"] == "fire_matches"

    def test_fallback_to_slug_matching(self, manifest, fire_matches):
        # ca-talbot is not in the (trimmed) fire_matches -> fuzzy slug fallback
        doc = archives.build_pyrecast_runs(_fires(), manifest, fire_matches)
        entry = doc["fires"]["talbot"]
        assert entry["pyrecast_slug"] == "ca-talbot"
        assert entry["match_method"] == "name_exact"

    def test_unmatched_slugs_surfaced(self, manifest, fire_matches):
        doc = archives.build_pyrecast_runs(
            _fires(include_talbot=False), manifest, fire_matches)
        assert doc["unmatched_slugs"] == ["ca-talbot"]
        assert set(doc["fires"]) == {"sinlahekin"}


# ---------------------------------------------------------------------------
# schema_version 2 contract (docs/spec-archives.md)
# ---------------------------------------------------------------------------

class TestSchemaV2Contract:
    def test_document_shape(self, manifest, fire_matches):
        doc = archives.build_pyrecast_runs(_fires(), manifest, fire_matches)
        assert doc["schema_version"] == 2
        assert doc["source"] == "fire-forecast-archive"
        assert doc["archive_base"] == config.archive_base()
        assert doc["archive_base"].startswith("https://")
        assert not doc["archive_base"].endswith("/")
        assert "generated_at" in doc
        assert isinstance(doc["unmatched_slugs"], list)

    def test_run_shape(self, manifest, fire_matches):
        doc = archives.build_pyrecast_runs(_fires(), manifest, fire_matches)
        run = doc["fires"]["sinlahekin"]["runs"][0]
        for field in ("workspace", "slug", "run_ts", "run_time", "horizon_hours",
                      "centroid", "toa", "products", "toa_ramp"):
            assert field in run
        assert run["workspace"] == "wa-sinlahekin_20260817_100500"
        assert run["slug"] == "wa-sinlahekin"
        # centroid passthrough, [lon, lat]
        lon, lat = run["centroid"]
        assert -125 < lon < -66 and 24 < lat < 50

    def test_url_templates(self, manifest, fire_matches):
        doc = archives.build_pyrecast_runs(_fires(), manifest, fire_matches)
        run = doc["fires"]["sinlahekin"]["runs"][0]
        assert run["toa"]["url_template"] == \
            "/forecast_archive/{slug}/{run_ts}/{pct}.tif"
        for p in run["products"].values():
            assert p["tar_template"] == \
                "/forecast_archive/{slug}/{run_ts}/{pct}_{product}.tar"
        # archive-base-relative: template + real values resolve to a bucket key
        resolved = run["toa"]["url_template"].format(
            slug=run["slug"], run_ts=run["run_ts"], pct=50)
        assert resolved == "/forecast_archive/wa-sinlahekin/20260817_100500/50.tif"

    def test_units_and_legend_stops(self, manifest, fire_matches):
        doc = archives.build_pyrecast_runs(_fires(), manifest, fire_matches)
        products = doc["fires"]["sinlahekin"]["runs"][0]["products"]
        assert products["spread-rate"]["units"] == "ch/hr"
        assert products["flame-length"]["units"] == "ft"
        assert products["hours-since-burned"]["units"] == "h"
        assert products["crown-fire"]["units"] is None
        for name, p in products.items():
            stops = p["legend_stops"]
            assert stops and all(
                isinstance(v, (int, float)) and c.startswith("#")
                for v, c in stops)
            assert [v for v, _ in stops] == sorted(v for v, _ in stops)
        # crown-fire is categorical: discrete labels alongside the stops
        assert products["crown-fire"]["legend_labels"] == \
            ["surface", "passive crown", "active crown"]
        assert "legend_labels" not in products["spread-rate"]

    def test_toa_ramp_block(self, manifest, fire_matches):
        doc = archives.build_pyrecast_runs(_fires(), manifest, fire_matches)
        for entry in doc["fires"].values():
            for run in entry["runs"]:
                ramp = run["toa_ramp"]
                assert ramp["recent_hours"] == 12
                assert ramp["stops"] == [["burned", "#7a1f1f"],
                                         ["recent", "#ff6a2b"]]


# ---------------------------------------------------------------------------
# ETag-cached public fetch
# ---------------------------------------------------------------------------

class TestEtagCaching:
    def _client(self, body: bytes, etag: str, calls: list):
        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request.headers.get("If-None-Match"))
            if request.headers.get("If-None-Match") == etag:
                return httpx.Response(304)
            return httpx.Response(200, content=body,
                                  headers={"ETag": etag,
                                           "Content-Type": "application/json"})
        return httpx.Client(transport=httpx.MockTransport(handler))

    def test_fetch_stores_and_reuses_etag(self, tmp_path, fixtures):
        body = (fixtures / "archive_manifest_excerpt.json").read_bytes()
        calls: list = []
        client = self._client(body, 'W/"abc123"', calls)
        storage = DryRunStorage(tmp_path)
        arch_state: dict = {}
        log = lambda *_: None  # noqa: E731

        doc1 = archives.fetch_archive_doc(
            client, storage, arch_state, "manifest.json",
            archives.MANIFEST_CACHE_KEY, log=log)
        assert "runs" in doc1
        assert arch_state["manifest.json_etag"] == 'W/"abc123"'
        assert storage.get_json(archives.MANIFEST_CACHE_KEY) == doc1

        # second fetch: conditional, 304 -> served from the cached copy
        doc2 = archives.fetch_archive_doc(
            client, storage, arch_state, "manifest.json",
            archives.MANIFEST_CACHE_KEY, log=log)
        assert doc2 == doc1
        assert calls == [None, 'W/"abc123"']

        # --force ignores the stored etag
        archives.fetch_archive_doc(
            client, storage, arch_state, "manifest.json",
            archives.MANIFEST_CACHE_KEY, force=True, log=log)
        assert calls[-1] is None

    def test_304_with_lost_cache_refetches(self, tmp_path, fixtures):
        body = (fixtures / "archive_fire_matches_excerpt.json").read_bytes()
        calls: list = []
        client = self._client(body, '"e2"', calls)
        storage = DryRunStorage(tmp_path)
        arch_state = {"fire_matches.json_etag": '"e2"'}  # etag known, no cached copy

        doc = archives.fetch_archive_doc(
            client, storage, arch_state, "fire_matches.json",
            archives.FIRE_MATCHES_CACHE_KEY, log=lambda *_: None)
        assert "matches" in doc
        assert calls == ['"e2"', None]  # 304 -> unconditional refetch


# ---------------------------------------------------------------------------
# same-name fires: runs never move to a different fire (live cases 2026-10-08)
# ---------------------------------------------------------------------------

def _run(slug, run_ts, centroid):
    return {"slug": slug, "run_ts": run_ts, "complete": True, "centroid": centroid,
            "files": {"50": {"ok": True}}, "vars": {}}


def _manifest(*runs):
    return {"runs": {f"{r['slug']}/{r['run_ts']}": r for r in runs}}


CALHOUN_292 = {"fire_slug": "calhoun-292", "post_title": "Calhoun 292", "state": "AR",
               "cornea_id": "{99999999-0000-4000-8000-000000000292}",
               "coordinates": [-92.676, 33.595], "created_on": "2026-10-08T01:17:24Z"}


class TestSameNameFires:
    def test_slug_tied_to_an_inactive_fire_skips_a_newer_same_name_fire(self):
        """ar-calhoun-259 is Calhoun 259's (by fire ID); its runs predate
        Calhoun 292, so the name fallback must not hand them over."""
        manifest = _manifest(_run("ar-calhoun-259", "20260922_075800", [-92.68, 33.60]))
        matches = {"matches": {"ar-calhoun-259": {
            "cornea_id": "{74E4BF13-BC6E-4015-A25F-D7C77C4ABFA8}", "post_title": "Calhoun 259"}}}
        doc = archives.build_pyrecast_runs([CALHOUN_292], manifest, matches)
        assert doc["fires"] == {}
        assert doc["unmatched_slugs"] == ["ar-calhoun-259"]

    def test_name_match_from_before_the_fire_existed_is_dropped(self):
        manifest = _manifest(_run("ar-calhoun", "20260922_075800", [-92.68, 33.60]))
        doc = archives.build_pyrecast_runs([CALHOUN_292], manifest, {"matches": {}})
        assert doc["fires"] == {}

    def test_name_match_far_from_the_fire_is_dropped(self):
        """wa-1924's run sat 160 km from the 1924 fire; the archive had
        refused the match, the exact-name fallback took it."""
        fire = {"fire_slug": "1924", "post_title": "1924", "state": "WA",
                "cornea_id": "{19241924-0000-4000-8000-000000001924}",
                "coordinates": [-119.09, 46.14], "created_on": "2026-09-29T20:42:48Z"}
        manifest = _manifest(_run("wa-1924", "20260929_210600", [-121.13, 45.86]))
        doc = archives.build_pyrecast_runs([fire], manifest, {"matches": {}})
        assert doc["fires"] == {}
        near = _manifest(_run("wa-1924", "20260929_210600", [-119.10, 46.15]))
        assert archives.build_pyrecast_runs([fire], near, {"matches": {}})["fires"]["1924"]

    def test_runs_from_several_slugs_are_newest_first(self):
        """Sand Creek has runs under mt-san-creek and mt-sand-creek; slug
        order put the older pair first and the frontend reads runs[0]."""
        cornea = "{84FD3D7E-6B04-49CD-A729-ED3178A49C42}"
        fire = {"fire_slug": "sand-creek", "post_title": "Sand Creek", "state": "MT",
                "cornea_id": cornea, "coordinates": [-113.33, 45.55]}
        manifest = _manifest(
            _run("mt-san-creek", "20260828_025500", [-113.30, 45.51]),
            _run("mt-san-creek", "20260827_101700", [-113.30, 45.51]),
            _run("mt-sand-creek", "20260903_014500", [-113.21, 45.52]),
            _run("mt-sand-creek", "20260901_194900", [-113.21, 45.52]),
        )
        matches = {"matches": {s: {"cornea_id": cornea} for s in ("mt-san-creek", "mt-sand-creek")}}
        entry = archives.build_pyrecast_runs([fire], manifest, matches)["fires"]["sand-creek"]
        assert [r["run_ts"] for r in entry["runs"]] == ["20260903_014500", "20260901_194900"]
        assert entry["pyrecast_slug"] == "mt-sand-creek"

    def test_inactive_id_match_falls_back_to_the_real_fire(self):
        """fire_matches tied id-silver to an 8-acre duplicate record
        ("Silver Dollar 2", inactive) beside the active Silver."""
        silver = {"fire_slug": "silver", "post_title": "Silver", "state": "ID",
                  "cornea_id": "{68A6E77D-AC4A-4E0B-A7FB-2CB72D7ED142}",
                  "coordinates": [-116.660, 48.629], "created_on": "2026-08-23T18:02:53Z"}
        manifest = _manifest(_run("id-silver", "20260829_195600", [-116.67, 48.62]))
        matches = {"matches": {"id-silver": {
            "cornea_id": "{39CDB521-FAFC-4C0A-B011-C8ADFAA56CC5}", "post_title": "Silver Dollar 2"}}}
        entry = archives.build_pyrecast_runs([silver], manifest, matches)["fires"]["silver"]
        assert entry["match_method"] == "name_exact"
