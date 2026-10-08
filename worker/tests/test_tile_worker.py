"""Stateless tile worker: shard partition + pending-sheet selection, and
where it writes before and after the incident-ID migration."""

import json
from pathlib import Path
from types import SimpleNamespace

from responder_worker import cli
from responder_worker.b2 import DryRunStorage
from responder_worker.cli import _pending_sheets, _sha_in_shard
from responder_worker.mirror import _sha16_bytes
from responder_worker.state import STATE_KEY

MIGRATED = {"incident_ids": "2026-10-09T00:00:00Z"}
GH = "{7A1B2C3D-0000-4000-8000-000000000001}"
AU = "{49D1FB0B-0000-4000-8000-000000000002}"
SHEET = "products/20260817/Ops_ArchE_port_20260816_2155_Grasshopper_ORMHF000688_0817_Day.pdf"


def test_shards_partition_everything_exactly_once():
    shas = [f"{i:016x}" for i in range(0, 4000, 37)]
    for sha in shas:
        owners = [k for k in range(4) if _sha_in_shard(sha, k, 4)]
        assert len(owners) == 1


def test_pending_sheets_selects_probed_untiled_only():
    state = {
        "incidents": {
            "inc": {
                "fire_slug": "big-grass",
                "files": {
                    "products/a.pdf": {"sha16": "aa"},   # pending -> selected
                    "products/b.pdf": {"sha16": "bb"},   # already tiled
                    "products/c.pdf": {"sha16": "cc"},   # flat
                    "products/d.pdf": {"sha16": None},   # no sha
                    "qr/a2.pdf": {"sha16": "aa"},        # duplicate sha
                },
            },
        },
        "tiled": {
            "aa": {"tiler_version": None, "geo": {"georeferenced": True}},
            "bb": {"tiler_version": 1, "geo": {"georeferenced": True}},
            "cc": {"tiler_version": 1, "geo": {"georeferenced": False}},
        },
    }
    got = _pending_sheets(state)
    # the first holder's slug and raw key, as before the fire-ID keys; the
    # other copy of the same bytes is a fallback
    assert got == [("aa", "big-grass", ["raw/incidents/big-grass/products/a.pdf",
                                        "raw/incidents/big-grass/qr/a2.pdf"])]


def _two_holders(sha: str, **flags) -> dict:
    """One sheet held by two folders: a hidden copy in an unresolved folder
    (first in state order) and 2026_Grasshopper's copy, still stamped under
    austin/ where it was mirrored while the folder was bound to Austin."""
    return {
        "incidents": {
            "great_basin/2026/2026_Cherry": {
                "fire_slug": "cherry", "storage_prefix": "cherry",
                "id_unresolved": {"reason": "date"}, "cornea_id": None, "match": None,
                "files": {"products/x.pdf": {"sha16": sha}}},
            "pacific_nw/2026/2026_Grasshopper": {
                "fire_slug": "grasshopper", "storage_prefix": "grasshopper",
                "cornea_id": GH, "match": {"method": "unit_id"},
                "files": {
                    SHEET: {"sha16": sha, "prefix": "austin"},
                    "qr/gone.pdf": {"sha16": sha, "pruned_at": "2026-10-01T00:00:00Z"},
                }},
        },
        "tiled": {sha: {"tiler_version": None, "geo": {"georeferenced": True}}},
        "migrations": dict(flags),
    }


def test_pending_sheets_returns_prefix_and_all_raw_keys():
    sha = "5b0d93088c8ddb6c"
    state = _two_holders(sha, **MIGRATED)
    # the hidden copy does not choose the prefix, but its bytes are a copy
    # all the same; the pruned file's are gone
    assert _pending_sheets(state) == [(sha, "grasshopper", [
        f"raw/incidents/austin/{SHEET}", "raw/incidents/cherry/products/x.pdf"])]

    # tiles already stamped elsewhere stay there
    state["tiled"][sha]["prefix"] = "austin"
    assert _pending_sheets(state)[0][1] == "austin"

    # a file that shows on no fire is never tiled for its own sake
    del state["incidents"]["pacific_nw/2026/2026_Grasshopper"]
    assert _pending_sheets(state) == []


def test_pending_sheets_before_migration_ignores_owners():
    # Unmigrated records carry no cornea_id, so nothing has an owner yet:
    # every folder's sheets are selected under its slug, as before.
    sha = "5b0d93088c8ddb6c"
    state = {"incidents": {"pacific_nw/2026/2026_Grasshopper": {
                 "fire_slug": "austin", "match": {"method": "unit_id"},
                 "files": {SHEET: {"sha16": sha}}}},
             "tiled": {sha: {"tiler_version": None, "geo": {"georeferenced": True}}}}
    assert _pending_sheets(state) == [(sha, "austin", [f"raw/incidents/austin/{SHEET}"])]


def _run_tile_worker(tmp_path, monkeypatch, storage, state):
    storage.put_json(STATE_KEY, state)
    state_bytes = (Path(storage.out_dir) / STATE_KEY).read_bytes()
    tiled_from: list[bytes] = []

    def process_pdf(local, tiles_dir, *, sheet=None, zoom_cap=None):
        tiled_from.append(Path(local).read_bytes())
        (tiles_dir / "12" / "700").mkdir(parents=True)
        (tiles_dir / "12" / "700" / "1500.png").write_bytes(b"png")
        return {"tiles": {"minzoom": 9, "maxzoom": 12, "bounds": [-121, 44, -120, 45]},
                "projection": "NAD83 / UTM 10N", "georeferenced": True}

    monkeypatch.setattr(cli, "make_storage", lambda dry_run, out: storage)
    monkeypatch.setattr(cli.geopdf, "gdal_available", lambda: True)
    monkeypatch.setattr(cli.geopdf, "process_pdf", process_pdf)
    args = SimpleNamespace(dry_run=True, out=tmp_path, max_seconds=600,
                           shard=0, shards=1, zoom_cap=None)
    assert cli.cmd_tile_worker(args) == 0
    # stateless: the state document is never written
    assert (Path(storage.out_dir) / STATE_KEY).read_bytes() == state_bytes
    return tiled_from


def test_tile_worker_writes_under_stamped_prefix_verifies_bytes(tmp_path, monkeypatch):
    good, bad = b"%PDF Grasshopper 0817", b"%PDF Austin 0817 overwrote this key"
    sha = _sha16_bytes(good)
    storage = DryRunStorage(tmp_path / "out")
    # the unresolved folder's copy (tried second) holds the right bytes; the
    # stamped location was overwritten by another folder sharing austin/
    storage.put_bytes(f"raw/incidents/austin/{SHEET}", bad)
    storage.put_bytes("raw/incidents/cherry/products/x.pdf", good)
    state = _two_holders(sha, **MIGRATED)
    state["tiled"][sha]["prefix"] = "austin"

    tiled_from = _run_tile_worker(tmp_path, monkeypatch, storage, state)

    assert tiled_from == [good]
    meta = storage.get_json(f"tiles/incidents/austin/{sha}/meta.json")
    assert meta["tiles"]["maxzoom"] == 12 and meta["georeferenced"] is True
    written = [k for k in storage.written if k.startswith("tiles/")]
    assert written == [f"tiles/incidents/austin/{sha}/12/700/1500.png",
                       f"tiles/incidents/austin/{sha}/meta.json"]  # marker last


def test_tile_worker_skips_sheet_when_no_copy_verifies(tmp_path, monkeypatch):
    sha = _sha16_bytes(b"%PDF the bytes the mirror hashed")
    storage = DryRunStorage(tmp_path / "out")
    storage.put_bytes(f"raw/incidents/austin/{SHEET}", b"%PDF something else")
    state = _two_holders(sha, **MIGRATED)
    assert _run_tile_worker(tmp_path, monkeypatch, storage, state) == []
    assert not [k for k in storage.written if k.startswith("tiles/")]


def test_tile_worker_keys_unchanged_before_migration(tmp_path, monkeypatch):
    pdf = b"%PDF Grasshopper sheet mirrored while bound to Austin"
    sha = _sha16_bytes(pdf)
    storage = DryRunStorage(tmp_path / "out")
    storage.put_bytes(f"raw/incidents/austin/{SHEET}", pdf)
    state = {"incidents": {"pacific_nw/2026/2026_Grasshopper": {
                 "fire_slug": "austin", "match": {"method": "unit_id"},
                 "files": {SHEET: {"sha16": sha}}}},
             "tiled": {sha: {"tiler_version": None, "geo": {"georeferenced": True}}}}

    assert _run_tile_worker(tmp_path, monkeypatch, storage, state) == [pdf]
    assert [k for k in storage.written if k.startswith("tiles/")] == [
        f"tiles/incidents/austin/{sha}/12/700/1500.png",
        f"tiles/incidents/austin/{sha}/meta.json"]
    assert json.loads((tmp_path / "out" / f"tiles/incidents/austin/{sha}/meta.json")
                      .read_text())["projection"] == "NAD83 / UTM 10N"
