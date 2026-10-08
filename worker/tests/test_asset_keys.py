"""Incident object keys: where a file's bytes are vs where new bytes go,
per-sha tile and preview locations, hash-verified downloads, IR keys."""

import hashlib

import pytest

from responder_worker import asset_keys as ak, ir_vectors
from responder_worker.b2 import DryRunStorage
from responder_worker.mirror import _sha16_bytes

AUSTIN_FK = "49d1fb0b-74d1-4a95-b8df-066dcc5f06e1"
SHEET = "products/20260817/Ops_ArchE_port_20260816_2155_Austin_ORMHF000863_0817_Day.pdf"


def _grasshopper(**files):
    """2026_Grasshopper after the migration: its own prefix, with the sheets
    mirrored while the folder was bound to Austin still under austin/."""
    return {"fire_slug": "grasshopper", "storage_prefix": "grasshopper",
            "files": files or {SHEET: {"sha16": "5b0d93088c8ddb6c", "prefix": "austin"}}}


def test_raw_key_defaults_to_storage_prefix():
    rec = {"fire_slug": "twin-sisters", "storage_prefix": "40432b79-397f-4c30-8667-2dce4a76a6fe",
           "files": {"products/20260617/brief.pdf": {"sha16": "aa"}}}
    rel = "products/20260617/brief.pdf"
    assert ak.record_prefix(rec) == "40432b79-397f-4c30-8667-2dce4a76a6fe"
    assert ak.raw_key(rec, rel) == f"raw/incidents/40432b79-397f-4c30-8667-2dce4a76a6fe/{rel}"
    assert ak.new_raw_key(rec, rel) == ak.raw_key(rec, rel)
    # a rel the record has never seen goes to the same place
    assert ak.raw_key(rec, "qr/new.pdf") == "raw/incidents/40432b79-397f-4c30-8667-2dce4a76a6fe/qr/new.pdf"


def test_raw_key_honours_file_prefix_stamp():
    rec = _grasshopper()
    assert ak.file_location(rec, SHEET) == "austin"
    assert ak.raw_key(rec, SHEET) == f"raw/incidents/austin/{SHEET}"
    # a new revision is written under the record's own prefix
    assert ak.new_raw_key(rec, SHEET) == f"raw/incidents/grasshopper/{SHEET}"


def test_record_prefix_falls_back_to_fire_slug_before_migration():
    rec = {"fire_slug": "grasshopper", "files": {SHEET: {"sha16": "5b0d93088c8ddb6c"}}}
    state = {"incidents": {"pacific_nw/2026/2026_Grasshopper": rec},
             "tiled": {"5b0d93088c8ddb6c": {"tiler_version": 2, "geo": {"preview": True}}}}
    sha = "5b0d93088c8ddb6c"
    # exactly the keys built from fire_slug today
    assert ak.record_prefix(rec) == "grasshopper"
    assert ak.raw_key(rec, SHEET) == f"raw/incidents/grasshopper/{SHEET}"
    assert ak.new_raw_key(rec, SHEET) == f"raw/incidents/grasshopper/{SHEET}"
    assert ak.tile_root(ak.tiles_prefix(state, sha, rec), sha) == f"tiles/incidents/grasshopper/{sha}"
    assert ak.tile_meta_key("grasshopper", sha) == f"tiles/incidents/grasshopper/{sha}/meta.json"
    assert ak.preview_key(state, sha, rec) == f"previews/incidents/grasshopper/{sha}.png"
    assert ak.raw_key_candidates(state, sha) == [f"raw/incidents/grasshopper/{SHEET}"]


def test_new_storage_prefix_hashes_when_fk_taken():
    key = "pacific_nw/2026/2026_AustinComplex"
    state = {"incidents": {"pacific_nw/2026/2026_Grasshopper": _grasshopper()}}
    assert ak.new_storage_prefix(state, AUSTIN_FK, key) == AUSTIN_FK
    # another folder of the same fire already writes under the fire key
    state["incidents"]["pacific_nw/2026/2026_Austin"] = {
        "fire_slug": AUSTIN_FK, "storage_prefix": AUSTIN_FK, "files": {}}
    want = f"{AUSTIN_FK}-{hashlib.sha1(key.encode()).hexdigest()[:6]}"
    assert ak.new_storage_prefix(state, AUSTIN_FK, key) == want
    assert ak.new_storage_prefix(state, AUSTIN_FK, key) == want  # deterministic
    # a prefix that only holds another record's stamped bytes is taken too
    assert ak.new_storage_prefix(state, "austin", key) == \
        f"austin-{hashlib.sha1(key.encode()).hexdigest()[:6]}"


def test_put_tiled_carries_prefix_and_preview_prefix():
    state = {"tiled": {"aa": {"tiler_version": None, "prefix": "austin",
                              "preview_prefix": "bobcat-lakes", "geo": {"preview": True}}}}
    entry = {"tiler_version": 2, "at": "2026-10-08T18:00:00Z",
             "geo": {"georeferenced": True, "tiles": {"minzoom": 10}, "preview": True}}
    ak.put_tiled(state, "aa", "grasshopper", entry)
    assert state["tiled"]["aa"] == {**entry, "prefix": "austin", "preview_prefix": "bobcat-lakes"}
    assert "prefix" not in entry  # the caller's dict is not touched
    # a sha seen for the first time is stamped with the writer's prefix
    ak.put_tiled(state, "bb", "grasshopper", {"tiler_version": 2})
    assert state["tiled"]["bb"] == {"tiler_version": 2, "prefix": "grasshopper"}
    ak.put_tiled({}, "cc", "grasshopper", {"tiler_version": 2})  # no tiled map yet: fine


def test_shared_sha_links_under_stamped_prefix():
    # Iron's sheet was first published in 2026_Cherry and tiled under cherry/;
    # Iron's own folder links the same tiles instead of re-tiling them.
    sha = "1df8fdc66157882a"
    cherry = {"fire_slug": "cherry", "storage_prefix": "cherry",
              "files": {"products/final/ops.pdf": {"sha16": sha}}}
    iron = {"fire_slug": "iron", "storage_prefix": "iron",
            "files": {"products/20260705/ops.pdf": {"sha16": sha}}}
    state = {"incidents": {"great_basin/2026/2026_Cherry": cherry,
                           "great_basin/2026/2026_Iron": iron},
             "tiled": {sha: {"tiler_version": 2, "prefix": "cherry", "geo": {"preview": True}}}}
    assert ak.tile_root(ak.tiles_prefix(state, sha, iron), sha) == f"tiles/incidents/cherry/{sha}"
    assert ak.preview_key(state, sha, iron) == f"previews/incidents/cherry/{sha}.png"
    assert ak.raw_key(iron, "products/20260705/ops.pdf") == "raw/incidents/iron/products/20260705/ops.pdf"
    assert ak.raw_key_candidates(state, sha) == [
        "raw/incidents/cherry/products/final/ops.pdf",
        "raw/incidents/iron/products/20260705/ops.pdf"]


def test_preview_prefix_overrides_tile_prefix():
    rec = _grasshopper()
    state = {"tiled": {"aa": {"prefix": "austin", "preview_prefix": "grasshopper"}}}
    assert ak.tile_root(ak.tiles_prefix(state, "aa", rec), "aa") == "tiles/incidents/austin/aa"
    assert ak.preview_key(state, "aa", rec) == "previews/incidents/grasshopper/aa.png"
    state["tiled"]["aa"].pop("preview_prefix")
    assert ak.preview_key(state, "aa", rec) == "previews/incidents/austin/aa.png"


def test_no_sha_never_gets_tile_or_preview_key(tmp_path):
    rec = _grasshopper()
    state = {"incidents": {"k": {"fire_slug": "x", "files": {"a.pdf": {"sha16": None}}}},
             "tiled": {}}
    for sha in (None, ""):
        with pytest.raises(ValueError):
            ak.tile_root("grasshopper", sha)
        with pytest.raises(ValueError):
            ak.tile_meta_key("grasshopper", sha)
        with pytest.raises(ValueError):
            ak.preview_key(state, sha, rec)
        with pytest.raises(ValueError):
            ak.put_tiled(state, sha, "grasshopper", {"tiler_version": 2})
        with pytest.raises(ValueError):
            ak.new_ir_key(rec, {"sha16": sha})
        assert ak.raw_key_candidates(state, sha) == []
    assert state["tiled"] == {}

    class NoReads:
        def get_file(self, key, dest):
            raise AssertionError("nothing to verify against, so nothing is fetched")

    assert ak.fetch_verified(NoReads(), ["raw/incidents/x/a.pdf"], None,
                             tmp_path / "a.pdf", log=lambda m: None) is None


def test_fetch_verified_skips_mismatched_bytes(tmp_path):
    # Twin Sisters MT and WA shared the twin-sisters/ prefix: the WA folder's
    # upload overwrote MT's sheet at the same key. MT's copy in its QR folder
    # still holds the bytes the state hashed.
    mt_bytes, wa_bytes = b"%PDF twin sisters MT", b"%PDF twin sisters WA"
    sha = _sha16_bytes(mt_bytes)
    rel = "products/20260805/ops_arch_e_port.pdf"
    storage = DryRunStorage(tmp_path / "out")
    storage.put_bytes(f"raw/incidents/twin-sisters/{rel}", wa_bytes)
    storage.put_bytes("raw/incidents/twin-sisters/qr/ops_arch_e_port.pdf", mt_bytes)
    mt = {"fire_slug": "twin-sisters", "storage_prefix": "twin-sisters", "files": {
        rel: {"sha16": sha}, "qr/ops_arch_e_port.pdf": {"sha16": sha},
        "products/20260806/gone.pdf": {"sha16": sha, "pruned_at": "2026-10-01T00:00:00Z"}}}
    state = {"incidents": {"n_rockies/2026/2026_TwinSisters": mt}, "tiled": {}}
    keys = ak.raw_key_candidates(state, sha)
    assert keys == [f"raw/incidents/twin-sisters/{rel}",
                    "raw/incidents/twin-sisters/qr/ops_arch_e_port.pdf"]  # pruned skipped

    logged, mismatches = [], []
    dest = tmp_path / "work" / "sheet.pdf"
    got = ak.fetch_verified(storage, ["raw/incidents/twin-sisters/missing.pdf", *keys], sha,
                            dest, log=logged.append, mismatches=mismatches)
    assert got == "raw/incidents/twin-sisters/qr/ops_arch_e_port.pdf"
    assert dest.read_bytes() == mt_bytes
    assert logged == [f"raw_sha_mismatch raw/incidents/twin-sisters/{rel}"]
    assert mismatches == [f"raw/incidents/twin-sisters/{rel}"]

    # no key verifies: nothing usable is left behind
    dest2 = tmp_path / "work" / "sheet2.pdf"
    assert ak.fetch_verified(storage, keys[:1], sha, dest2, log=logged.append) is None
    assert not dest2.exists()


def test_ir_entry_invalid_after_source_revision():
    src = "ir/20260817/20260817_Grasshopper_IR.kmz"
    rec = _grasshopper()
    ak.stamp_ir(rec, src, "vectors/ir/austin/20260817_IR_11x17_Topo.geojson",
                "20260817_IR_11x17_Topo", "c0ffee0000000001")
    entry = ak.ir_entry(rec, src, {"sha16": "c0ffee0000000001"})
    assert entry == {"key": "vectors/ir/austin/20260817_IR_11x17_Topo.geojson",
                     "flight_id": "20260817_IR_11x17_Topo", "src_sha16": "c0ffee0000000001"}
    assert ak.ir_entry(rec, src, {"sha16": "c0ffee0000000002"}) is None  # source revised
    assert ak.ir_entry(rec, src, {"sha16": None}) is None
    assert ak.ir_entry(rec, "ir/20260817/other.kmz", {"sha16": "c0ffee0000000001"}) is None
    assert ak.ir_entry({"fire_slug": "x"}, src, {"sha16": "c0ffee0000000001"}) is None


def test_new_ir_key_is_content_addressed_and_versioned(monkeypatch):
    rec = _grasshopper()
    v = ir_vectors.IR_CONVERTER_VERSION
    k1 = ak.new_ir_key(rec, {"sha16": "c0ffee0000000001"})
    assert k1 == f"vectors/ir/grasshopper/c0ffee0000000001.v{v}.geojson"
    assert ak.new_ir_key(rec, {"sha16": "c0ffee0000000002"}) != k1
    monkeypatch.setattr(ir_vectors, "IR_CONVERTER_VERSION", v + 1)
    assert ak.new_ir_key(rec, {"sha16": "c0ffee0000000001"}) == \
        f"vectors/ir/grasshopper/c0ffee0000000001.v{v + 1}.geojson"


def test_sha16_file_matches_the_mirror(tmp_path):
    p = tmp_path / "a.pdf"
    data = b"x" * (3 << 20)  # several read chunks
    p.write_bytes(data)
    assert ak.sha16_file(p) == _sha16_bytes(data)


def test_replay_file_is_keyed_where_the_bytes_are():
    meta = {"sha16": "5b0d93088c8ddb6c", "prefix": "austin", "kind": "product", "rev": 2,
            "size": 13123005, "url": "https://ftp/x.pdf",
            "lm": "Mon, 17 Aug 2026 05:05:56 GMT", "first_seen": "2026-08-17T06:00:00Z"}
    mf = ak.replay_file(_grasshopper(**{SHEET: meta}), SHEET, meta)
    assert mf.key == f"raw/incidents/austin/{SHEET}"
    assert (mf.kind, mf.rel_dir, mf.filename) == ("product", "products/20260817", SHEET.rpartition("/")[2])
    assert (mf.lm, mf.first_seen, mf.rev, mf.local_path, mf.changed) == (
        meta["lm"], meta["first_seen"], 2, None, False)
    ir = ak.replay_file({"fire_slug": "grasshopper"}, "ir/20260817/a.kmz", {"sha16": "ab"})
    assert (ir.kind, ir.key) == ("ir", "raw/incidents/grasshopper/ir/20260817/a.kmz")
