"""routing_cli guards that need no GDAL/osmium.

A Geofabrik index whose layout changed (it once parented every state to
"north-america", so no US region matched) must fail the plan or shard once,
loudly, before any fire records a failure. Failing each fire instead puts
every fire in the country into a 24 h backoff after three runs.
"""

import argparse
import json

import pytest

from responder_worker import config, osm_extract, perimeters, routing_cli
from responder_worker import routing_bundle as rb
from responder_worker import routing_plan as rp
from responder_worker.b2 import DryRunStorage

# the SISI fire as our published catalog.json listed it on 2026-09-25
SISI = {"cornea_id": "{DC4342D9-B479-44F1-906C-8ABD42E1F59C}", "fire_slug": "sisi",
        "name": "SISI", "coordinates": [-120.830681826848, 48.3466728221515], "acres": 4275,
        "poly_last_updated": "2026-09-25T10:15:48Z"}


def _live_excerpt(fixtures) -> dict:
    # 12 verbatim features of the live index: only 5 of them are US leaves
    return json.loads((fixtures / "routing" / "geofabrik_index_excerpt.json").read_text())


def _full_index(n: int) -> dict:
    """The live shape with n state leaves under "north-america"."""
    feats = [{"type": "Feature", "properties": {"id": "north-america", "parent": None,
                                                "urls": {"pbf": "https://d/north-america.pbf"}},
              "geometry": {"type": "Polygon", "coordinates": [[[-170, 5], [-50, 5], [-50, 85],
                                                               [-170, 85], [-170, 5]]]}}]
    for i in range(n):
        w = -125 + i
        feats.append({"type": "Feature",
                      "properties": {"id": f"us/state-{i}", "parent": "north-america",
                                     "urls": {"pbf": f"https://d/state-{i}-latest.osm.pbf"}},
                      "geometry": {"type": "Polygon", "coordinates": [[[w, 30], [w + 1, 30],
                                                                       [w + 1, 49], [w, 49],
                                                                       [w, 30]]]}})
    return {"type": "FeatureCollection", "features": feats}


class TestUsRegions:
    def test_live_excerpt_is_too_few(self, fixtures, monkeypatch):
        monkeypatch.setattr(osm_extract, "load_index", lambda client: _live_excerpt(fixtures))
        with pytest.raises(RuntimeError, match="gave 5 US leaf regions"):
            routing_cli.us_regions(None)

    def test_a_full_index_passes(self, monkeypatch):
        monkeypatch.setattr(osm_extract, "load_index",
                            lambda client: _full_index(config.ROUTING_MIN_US_REGIONS))
        assert len(routing_cli.us_regions(None)) == config.ROUTING_MIN_US_REGIONS
        monkeypatch.setattr(osm_extract, "load_index",
                            lambda client: _full_index(config.ROUTING_MIN_US_REGIONS - 1))
        with pytest.raises(RuntimeError):
            routing_cli.us_regions(None)


class TestPlanFailsLoudly:
    def test_no_plan_and_no_fire_touched(self, tmp_path, monkeypatch):
        monkeypatch.setattr(routing_cli, "_public_json",
                            lambda client, key: {"fires": [SISI]}
                            if key == "catalogs/catalog.json" else None)
        monkeypatch.setattr(osm_extract, "load_index", lambda client: {"features": []})

        def no_perimeter(*a, **kw):
            raise AssertionError("no fire may be planned")
        monkeypatch.setattr(perimeters, "latest_perimeter", no_perimeter)
        args = argparse.Namespace(dry_run=True, out=tmp_path / "out", max_seconds=0, fire=None,
                                  shards=4, priority_fires="", force=False, max_fires=None,
                                  plan_out=str(tmp_path / "plan.json"))
        with pytest.raises(RuntimeError, match="US leaf regions"):
            routing_cli.cmd_routing_plan(args)
        assert not (tmp_path / "plan.json").exists()
        fk = rp.fire_key(SISI["cornea_id"])
        assert DryRunStorage(tmp_path / "out").get_json(rb.state_key(fk)) is None


class TestShardFailsLoudly:
    def test_index_reload_too_short(self, tmp_path, fixtures, monkeypatch):
        # planned against a good index; by build time the layout changed
        monkeypatch.setattr(osm_extract, "load_index", lambda client: _live_excerpt(fixtures))

        def no_download(*a, **kw):
            raise AssertionError("must not download")
        monkeypatch.setattr(osm_extract, "download_region", no_download)

        def no_build(*a, **kw):
            raise AssertionError("must not build")
        storage = DryRunStorage(tmp_path / "out")
        entry = {"cornea_id": SISI["cornea_id"], "fire_key": "sisi", "slug": "sisi",
                 "regions": ["us/washington"], "aoi": rp.aoi_for(SISI["coordinates"], None)}
        plan = {"shards": [{"shard": 0, "fires": [entry]}], "trails": None}
        with pytest.raises(RuntimeError, match="US leaf regions"):
            routing_cli.run_shard(None, storage, plan, 0, workdir=tmp_path / "w", build=no_build,
                                  log=lambda m: None)
        assert storage.get_json(rb.state_key("sisi")) is None  # no failure recorded
