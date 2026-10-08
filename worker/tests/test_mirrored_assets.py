"""GeoPDF tiles and previews that sync-incidents writes itself: this run's
downloads (_process_mirrored_assets). Keys come from the sha's stamps
(tile_root(tiles_prefix), preview_key), state["tiled"] is written only
through put_tiled, sheets that show on no fire are skipped, and only bytes
that hash to the sha are tiled or previewed."""

from pathlib import Path
from types import SimpleNamespace

import pytest

from incident_world import GRASSHOPPER, SpyStorage, sha16
from responder_worker import cli, fire_manifests, geopdf
from responder_worker.fires import fire_key
from responder_worker.incident_ids import bound_info
from responder_worker.mirror import MirroredFile, MirrorResult

GH_KEY = "pacific_nw/2026/2026_Grasshopper"
GH_FK = fire_key(GRASSHOPPER["cornea_id"])
ARGS = SimpleNamespace(tile_budget=40, zoom_cap=None)


@pytest.fixture
def gdal(monkeypatch):
    """GDAL present, its three entry points stubbed; each call records the
    bytes it was handed."""
    calls = {"process": [], "render": [], "probe": []}

    def process_pdf(pdf, tiles_dir, *, sheet=None, zoom_cap=None):
        calls["process"].append(Path(pdf).read_bytes())
        (Path(tiles_dir) / "8" / "1").mkdir(parents=True)
        (Path(tiles_dir) / "8" / "1" / "2.png").write_bytes(b"png")
        return {"georeferenced": True, "projection": "UTM 10N",
                "tiles": {"minzoom": 8, "maxzoom": 8, "bounds": [-122, 44, -121, 45]}}

    def render_preview(pdf, out_png, **kw):
        calls["render"].append(Path(pdf).read_bytes())
        Path(out_png).write_bytes(b"png")
        return out_png

    def probe_pdf(pdf):
        calls["probe"].append(Path(pdf).read_bytes())
        return {"georeferenced": True, "projection": "UTM 10N"}

    monkeypatch.setattr(geopdf, "gdal_available", lambda: True)
    monkeypatch.setattr(geopdf, "process_pdf", process_pdf)
    monkeypatch.setattr(geopdf, "render_preview", render_preview)
    monkeypatch.setattr(geopdf, "probe_pdf", probe_pdf)
    return calls


def _rec(prefix: str, files: dict, fire=GRASSHOPPER) -> dict:
    return {"fire_slug": prefix, "storage_prefix": prefix, "cornea_id": fire["cornea_id"],
            "match": {"method": "unit_id"}, "bound": bound_info(fire, "unit_id"),
            "files": files}


def _downloaded(tmp_path, rel: str, data: bytes) -> MirroredFile:
    """A file this run downloaded, its local copy (keyed like the mirror's)
    holding `data`."""
    local = tmp_path / "work" / sha16(data) / rel
    local.parent.mkdir(parents=True, exist_ok=True)
    local.write_bytes(data)
    rel_dir, _, name = rel.rpartition("/")
    return MirroredFile(kind="product", filename=name, key=f"raw/incidents/x/{rel}", url="",
                        size=len(data), sha16=sha16(data), rev=1, local_path=local,
                        changed=True, rel_dir=rel_dir)


def test_superseded_or_unverified_download_is_never_tiled(tmp_path, gdal):
    # products/20261008/Ops_X.pdf came twice this run (Products/20261008/ and
    # Products/Daily Products/20261008/): state ends with the second bytes.
    # Only those are tiled, and the manifest lists that copy.
    rel = "products/20261008/Ops_X.pdf"
    first, last = b"%PDF from Products", b"%PDF from Daily Products"
    rec = _rec(GH_FK, {rel: {"sha16": sha16(last), "kind": "product", "rev": 2}})
    state = {"incidents": {GH_KEY: rec}, "tiled": {}}
    storage = SpyStorage(tmp_path / "bucket")
    bundle = {"result": MirrorResult(files=[_downloaded(tmp_path, rel, first),
                                            _downloaded(tmp_path, rel, last)])}
    cli._process_mirrored_assets(ARGS, storage, state, {GH_KEY: bundle})
    assert gdal["process"] == [last] and gdal["render"] == [last]
    assert list(state["tiled"]) == [sha16(last)]
    assert not [k for k in storage.written if sha16(first) in k]
    [(_rel, _meta, mf)] = fire_manifests._record_files(rec, bundle)
    assert mf.sha16 == sha16(last) and mf.local_path.read_bytes() == last

    # a local copy that no longer holds the bytes its sha names
    other = "products/20261008/Ops_Y.pdf"
    rec["files"][other] = {"sha16": sha16(b"%PDF y"), "kind": "product"}
    changed = _downloaded(tmp_path, other, b"%PDF y")
    changed.local_path.write_bytes(b"%PDF not y")
    cli._process_mirrored_assets(ARGS, storage, state,
                                 {GH_KEY: {"result": MirrorResult(files=[changed])}})
    assert sha16(b"%PDF y") not in state["tiled"]
    assert len(gdal["process"]) == 1 and len(gdal["render"]) == 1
