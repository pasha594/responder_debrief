"""GeoPDF tiles and previews that sync-incidents writes itself: this run's
downloads (_process_mirrored_assets) and the sheet backlogs (_tile_backlog,
_probe_backlog). Keys come from the sha's stamps (tile_root(tiles_prefix),
tile_meta_key, preview_key), state["tiled"] is written only through
put_tiled, sheets that show on no fire are skipped, and only bytes that
hash to the sha are tiled or previewed."""

from pathlib import Path
from types import SimpleNamespace

import pytest

from incident_world import AUSTIN, GRASSHOPPER, SpyStorage, sha16
from responder_worker import cli, config, fire_manifests, frames, geopdf
from responder_worker.fires import fire_key
from responder_worker.incident_ids import bound_info
from responder_worker.mirror import MirroredFile, MirrorResult

GH_KEY = "pacific_nw/2026/2026_Grasshopper"
AU_KEY = "pacific_nw/2026/2026_Austin"
CHERRY_KEY = "great_basin/2026/2026_Cherry"
GH_FK = fire_key(GRASSHOPPER["cornea_id"])
ARGS = SimpleNamespace(tile_budget=40, zoom_cap=None)
TILES = {"minzoom": 8, "maxzoom": 8, "bounds": [-122, 44, -121, 45]}


class Bucket(SpyStorage):
    """The spy bucket, recording downloads too."""

    def __init__(self, out_dir):
        super().__init__(out_dir)
        self.fetched: list[str] = []

    def get_file(self, key, dest):
        self.fetched.append(key)
        return super().get_file(key, dest)


@pytest.fixture
def gdal(monkeypatch):
    """GDAL present, its three entry points stubbed; each call records the
    bytes it was handed."""
    calls = {"process": [], "render": [], "probe": []}

    def process_pdf(pdf, tiles_dir, *, sheet=None, zoom_cap=None):
        calls["process"].append(Path(pdf).read_bytes())
        (Path(tiles_dir) / "8" / "1").mkdir(parents=True)
        (Path(tiles_dir) / "8" / "1" / "2.png").write_bytes(b"png")
        return {"georeferenced": True, "projection": "UTM 10N", "tiles": TILES}

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


def test_download_tiles_and_previews_under_the_shas_stamps(tmp_path, gdal):
    # The sheet was first tiled while its folder showed on Austin, and its
    # preview written under grasshopper/ by another folder: this run's
    # download of it goes to those keys, and both stamps stay.
    sheet, hidden = "products/20261008/Ops_1008.pdf", "products/20261008/Junk_1008.pdf"
    data, junk = b"%PDF ops 1008", b"%PDF junk"
    rec = _rec(GH_FK, {sheet: {"sha16": sha16(data), "kind": "product"},
                       hidden: {"sha16": sha16(junk), "kind": "product",
                                "fk": None, "fk_src": "hidden"}})
    sha = sha16(data)
    state = {"incidents": {GH_KEY: rec}, "tiled": {sha: {
        "tiler_version": None, "prefix": "austin", "preview_prefix": "grasshopper",
        "geo": {"georeferenced": True, "preview": False, "tiles": None}}}}
    storage = SpyStorage(tmp_path / "bucket")
    res = MirrorResult(files=[_downloaded(tmp_path, hidden, junk),
                              _downloaded(tmp_path, sheet, data)])
    cli._process_mirrored_assets(ARGS, storage, state, {GH_KEY: {"result": res}})

    # the hidden sheet (shown on no fire) is neither tiled nor previewed
    assert gdal["process"] == [data] and gdal["render"] == [data]
    assert sorted(storage.written) == [f"previews/incidents/grasshopper/{sha}.png",
                                       f"tiles/incidents/austin/{sha}/8/1/2.png"]
    t = state["tiled"][sha]
    assert (t["prefix"], t["preview_prefix"], t["tiler_version"]) == (
        "austin", "grasshopper", config.TILER_VERSION)
    assert t["geo"]["tiles"] == TILES and t["geo"]["preview"] is True
    assert list(state["tiled"]) == [sha]

    # out of tiling budget: probed and previewed only, a new sha stamped
    # under the record's own prefix, tiles still owed
    new, new_data = "products/20261008/Briefing_1008.pdf", b"%PDF briefing"
    rec["files"][new] = {"sha16": sha16(new_data), "kind": "product"}
    storage.written.clear()
    res = MirrorResult(files=[_downloaded(tmp_path, new, new_data)])
    cli._process_mirrored_assets(SimpleNamespace(tile_budget=0, zoom_cap=None), storage,
                                 state, {GH_KEY: {"result": res}})
    assert gdal["probe"] == [new_data] and len(gdal["process"]) == 1
    assert storage.written == [f"previews/incidents/{GH_FK}/{sha16(new_data)}.png"]
    t = state["tiled"][sha16(new_data)]
    assert (t["prefix"], t["tiler_version"], t["geo"]["preview"]) == (GH_FK, None, True)
    assert "preview_prefix" not in t


# ---------------------------------------------------------------------------
# backlogs
# ---------------------------------------------------------------------------

def _holders(sha: str, *, bad: bytes, good: bytes, bucket) -> dict:
    """One sheet held by two folders: 2026_Grasshopper's copy (first in
    state order) whose raw key holds other bytes, and 2026_Austin's, right.
    An unresolved folder holds a sheet of its own, shown on no fire."""
    sheet = "products/20260925/Ops_0925.pdf"
    gh = _rec(GH_FK, {sheet: {"sha16": sha, "kind": "product"}})
    au = _rec("austin", {"qr/Ops_0925_QR.pdf": {"sha16": sha, "kind": "qr"}}, fire=AUSTIN)
    cherry = {"fire_slug": "cherry", "storage_prefix": "cherry", "cornea_id": None,
              "match": None, "id_unresolved": {"reason": "date"},
              "files": {"products/20260705/ops_0705.pdf": {"sha16": sha16(b"%PDF cherry"),
                                                           "kind": "product"}}}
    bucket.put_bytes(f"raw/incidents/{GH_FK}/{sheet}", bad)
    bucket.put_bytes("raw/incidents/austin/qr/Ops_0925_QR.pdf", good)
    bucket.put_bytes("raw/incidents/cherry/products/20260705/ops_0705.pdf", b"%PDF cherry")
    bucket.written.clear()
    return {"incidents": {CHERRY_KEY: cherry, GH_KEY: gh, AU_KEY: au}, "tiled": {}}


def test_tile_backlog_tiles_verified_bytes_under_the_stamped_prefix(tmp_path, gdal):
    frames.start_deadline(0)  # disarmed
    good = b"%PDF the sheet"
    sha = sha16(good)
    bucket = Bucket(tmp_path / "bucket")
    state = _holders(sha, bad=b"%PDF overwritten by another folder", good=good, bucket=bucket)
    pending = {"tiler_version": None, "geo": {"georeferenced": True, "preview": True}}
    state["tiled"] = {sha: dict(pending, prefix="austin"),
                      sha16(b"%PDF cherry"): dict(pending)}
    mismatches: list[str] = []
    touched = cli._tile_backlog(bucket, state, lambda *_: None, mismatches=mismatches)

    assert touched == {GH_KEY, AU_KEY}  # every folder showing the sheet
    assert gdal["process"] == [good]
    assert mismatches == [f"raw/incidents/{GH_FK}/products/20260925/Ops_0925.pdf"]
    assert sorted(bucket.written) == [f"tiles/incidents/austin/{sha}/8/1/2.png",
                                      f"tiles/incidents/austin/{sha}/meta.json"]
    assert "raw/incidents/cherry/products/20260705/ops_0705.pdf" not in bucket.fetched
    t = state["tiled"][sha]
    assert (t["prefix"], t["tiler_version"], t["geo"]["tiles"]) == (
        "austin", config.TILER_VERSION, TILES)
    assert state["tiled"][sha16(b"%PDF cherry")]["tiler_version"] is None

    # a tile worker already finished it: its marker is adopted, no download
    state["tiled"][sha] = dict(pending, prefix="austin")
    bucket.put_json(f"tiles/incidents/austin/{sha}/meta.json",
                    {"tiler_version": 7, "projection": "UTM 10N", "tiles": TILES})
    bucket.fetched.clear()
    bucket.written.clear()
    assert cli._tile_backlog(bucket, state, lambda *_: None) == {GH_KEY, AU_KEY}
    assert bucket.fetched == [] and bucket.written == [] and len(gdal["process"]) == 1
    t = state["tiled"][sha]
    assert (t["prefix"], t["tiler_version"], t["geo"]["tiles"]) == ("austin", 7, TILES)


def test_probe_backlog_previews_verified_bytes_under_the_stamped_prefix(tmp_path, gdal):
    frames.start_deadline(0)  # disarmed
    good = b"%PDF the sheet"
    sha = sha16(good)
    bucket = Bucket(tmp_path / "bucket")
    state = _holders(sha, bad=b"%PDF overwritten by another folder", good=good, bucket=bucket)
    # a failed earlier probe (no preview, no tiles), its keys stamped
    state["tiled"][sha] = {"tiler_version": 1, "prefix": "austin",
                           "preview_prefix": "grasshopper",
                           "geo": {"georeferenced": False, "preview": False, "tiles": None}}
    mismatches: list[str] = []
    touched = cli._probe_backlog(bucket, state, lambda *_: None, mismatches=mismatches)

    assert touched == {GH_KEY, AU_KEY}
    assert gdal["probe"] == [good] and gdal["render"] == [good]
    assert mismatches == [f"raw/incidents/{GH_FK}/products/20260925/Ops_0925.pdf"]
    assert bucket.written == [f"previews/incidents/grasshopper/{sha}.png"]
    # the unresolved folder's sheet shows on no fire: never fetched
    assert bucket.fetched == [f"raw/incidents/{GH_FK}/products/20260925/Ops_0925.pdf",
                              "raw/incidents/austin/qr/Ops_0925_QR.pdf"]
    assert sha16(b"%PDF cherry") not in state["tiled"]
    t = state["tiled"][sha]
    assert (t["prefix"], t["preview_prefix"], t["tiler_version"]) == (
        "austin", "grasshopper", None)  # georeferenced now: tiles owed
    assert t["geo"]["preview"] is True and t["repair_at"]
