"""Stateless tile worker: shard partition + pending-sheet selection."""

from responder_worker.cli import _pending_sheets, _sha_in_shard


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
    assert got == [("aa", "big-grass", "products/a.pdf")]
