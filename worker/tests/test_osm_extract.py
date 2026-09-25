"""osm_extract.extract_fires: one tags-filter pass, then `osmium extract` in
batches of config.OSM_EXTRACT_BATCH (54 Oregon fires in one pass killed a
16 GB runner on 2026-09-25). The real-osmium test skips without the CLI.
"""

import json
import shutil
from pathlib import Path

import pytest

from responder_worker import config, gdal_cli, osm_extract


def _boxes(n):
    """n small, disjoint boxes along 44°N from -120°."""
    return {f"f{i}": (-120 + i * 0.1, 44.0, -120 + i * 0.1 + 0.05, 44.05) for i in range(n)}


class TestBatches:
    def test_nine_fires_make_three_extract_passes(self, tmp_path, monkeypatch):
        calls = []

        def fake_run(cmd, **kw):
            # the config file is rewritten per batch: read it as the call sees it
            cfg = json.loads(Path(cmd[cmd.index("-c") + 1]).read_text()) if "-c" in cmd else None
            calls.append((cmd, cfg))

        monkeypatch.setattr(gdal_cli, "run", fake_run)
        pbf = tmp_path / "us_oregon.osm.pbf"
        fires = _boxes(9)
        out = osm_extract.extract_fires(pbf, fires, tmp_path / "work", log=lambda m: None)

        assert config.OSM_EXTRACT_BATCH == 4
        assert [c[0][1] for c in calls] == ["tags-filter", "extract", "extract", "extract"]
        hw = calls[0][0][calls[0][0].index("-o") + 1]
        keys = []
        for cmd, cfg in calls[1:]:
            assert hw in cmd                              # the filtered file, not the region
            assert "complete_ways" in cmd
            assert len(cfg["extracts"]) <= 4
            assert cfg["directory"] == str(tmp_path / "work" / "osm_extracts")
            for x in cfg["extracts"]:
                k = x["output"].removesuffix(".osm.pbf")
                assert x["bbox"] == list(fires[k])
                keys.append(k)
        assert sorted(keys) == sorted(fires) and len(keys) == 9
        assert out == {k: tmp_path / "work" / "osm_extracts" / f"{k}.osm.pbf" for k in fires}

    def test_few_fires_one_pass(self, tmp_path, monkeypatch):
        calls = []
        monkeypatch.setattr(gdal_cli, "run", lambda cmd, **kw: calls.append(cmd[1]))
        osm_extract.extract_fires(tmp_path / "r.osm.pbf", _boxes(3), tmp_path, log=lambda m: None)
        assert calls == ["tags-filter", "extract"]


def _synthetic_pbf(tmp_path, fires):
    """A track inside each box, one road running through the first three
    boxes (and out of them), and a building the tags filter drops."""
    nodes, ways = [], []
    nid = 1
    for i, (w, s, e, n) in enumerate(fires.values()):
        refs = []
        for t in (0.2, 0.5, 0.8):
            nodes.append(f"n{nid} v1 x{w + t * (e - w):.7f} y{s + t * (n - s):.7f}")
            refs.append(nid)
            nid += 1
        ways.append(f"w{100 + i} v1 Thighway=track N{','.join(f'n{r}' for r in refs)}")
    road = []
    for k in range(13):
        nodes.append(f"n{nid} v1 x{-120.05 + k * 0.025:.7f} y44.0250000")
        road.append(nid)
        nid += 1
    ways.append(f"w900 v1 Thighway=unclassified N{','.join(f'n{r}' for r in road)}")
    nodes.append(f"n{nid} v1 x-119.9900000 y44.0100000")
    ways.append(f"w901 v1 Tbuilding=yes Nn{nid},n1")
    opl = tmp_path / "region.opl"
    opl.write_text("\n".join(nodes + ways) + "\n")
    pbf = tmp_path / "region.osm.pbf"
    gdal_cli.run(["osmium", "cat", str(opl), "-o", str(pbf), "--overwrite"])
    return pbf


@pytest.mark.skipif(shutil.which("osmium") is None, reason="osmium not installed")
def test_batched_outputs_match_one_pass(tmp_path, monkeypatch):
    fires = _boxes(5)
    pbf = _synthetic_pbf(tmp_path, fires)
    monkeypatch.setattr(config, "OSM_EXTRACT_BATCH", 100)
    whole = osm_extract.extract_fires(pbf, fires, tmp_path / "whole", log=lambda m: None)
    monkeypatch.setattr(config, "OSM_EXTRACT_BATCH", 2)
    batched = osm_extract.extract_fires(pbf, fires, tmp_path / "batched", log=lambda m: None)

    def parsed(p):
        return osm_extract.read_opl(osm_extract.to_opl(p, p.with_suffix(".opl")))

    for k in fires:
        assert batched[k].read_bytes() == whole[k].read_bytes()
        nodes, ways = parsed(batched[k])
        ids = {w["id"] for w in ways}
        assert 100 + int(k[1:]) in ids and 901 not in ids
        if int(k[1:]) < 3:
            # complete_ways: the road through the box comes whole
            road = next(w for w in ways if w["id"] == 900)
            assert len(road["nodes"]) == 13 and all(r in nodes for r in road["nodes"])
        else:
            assert 900 not in ids
