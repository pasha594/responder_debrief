"""Storage listings, exact-key deletes, and the read-only / recording
wrappers the migration and key audit run over. B2 calls are stubbed
(botocore Stubber): nothing here touches the network."""

import json

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
from botocore.stub import Stubber

from responder_worker import b2
from responder_worker.b2 import (
    B2Storage,
    DryRunStorage,
    ReadOnlyStorage,
    RecordingStorage,
    StorageWriteRefused,
    get_json_retry,
)


def _b2():
    return B2Storage({"B2_BUCKET": "bkt", "B2_S3_ENDPOINT": "s3.us-west-000.backblazeb2.com",
                      "B2_KEY_ID": "test", "B2_APP_KEY": "test"})


def _seed(storage):
    for key in ("raw/incidents/austin/products/20260817/a.pdf",
                "raw/incidents/austin/ir/20260817/b.kmz",
                "raw/incidents/austin-3c1f0a/qr/c.pdf",
                "raw/incidents/grasshopper/products/20261003/d.pdf",
                "tiles/incidents/austin/1df8fdc66157882a/meta.json",
                "tiles/incidents/austin/1df8fdc66157882a/10/1/2.png",
                "tiles/incidents/grasshopper/5b0d93088c8ddb6c/meta.json"):
        storage.put_bytes(key, key.encode())


def test_dry_run_lists_keys_with_sizes_and_prefix_semantics(tmp_path):
    s = DryRunStorage(tmp_path)
    _seed(s)
    got = list(s.list_keys("raw/incidents/austin/"))
    assert got == [("raw/incidents/austin/ir/20260817/b.kmz", 38),
                   ("raw/incidents/austin/products/20260817/a.pdf", 44)]
    # like S3, a prefix need not end at a '/'
    assert [k for k, _ in s.list_keys("raw/incidents/austin")] == [
        "raw/incidents/austin-3c1f0a/qr/c.pdf",
        "raw/incidents/austin/ir/20260817/b.kmz",
        "raw/incidents/austin/products/20260817/a.pdf"]
    assert list(s.list_keys("raw/incidents/nope/")) == []
    assert len(list(s.list_keys(""))) == 7


def test_dry_run_lists_dirs_only_while_they_hold_files(tmp_path):
    s = DryRunStorage(tmp_path)
    _seed(s)
    assert list(s.list_dirs("raw/incidents/")) == ["austin", "austin-3c1f0a", "grasshopper"]
    assert list(s.list_dirs("tiles/incidents/austin")) == ["1df8fdc66157882a"]
    assert list(s.list_dirs("nope/")) == []
    s.delete_keys(["tiles/incidents/grasshopper/5b0d93088c8ddb6c/meta.json"])
    assert list(s.list_dirs("tiles/incidents/")) == ["austin"]


def test_dry_run_delete_keys_is_exact(tmp_path):
    s = DryRunStorage(tmp_path)
    _seed(s)
    n = s.delete_keys(["raw/incidents/austin/ir/20260817/b.kmz",
                       "raw/incidents/austin/ir/20260817/b.kmz",  # twice: once
                       "raw/incidents/austin/missing.pdf",
                       "raw/incidents/austin"])                  # a prefix is not a key
    assert n == 1
    assert not s.exists("raw/incidents/austin/ir/20260817/b.kmz")
    assert s.exists("raw/incidents/austin/products/20260817/a.pdf")
    assert s.exists("raw/incidents/austin-3c1f0a/qr/c.pdf")


def test_b2_list_keys_pages_and_list_dirs_common_prefixes():
    s = _b2()
    with Stubber(s.client) as st:
        st.add_response("list_objects_v2", {
            "Contents": [{"Key": "raw/incidents/austin/a.pdf", "Size": 3}],
            "IsTruncated": True, "NextContinuationToken": "t1"},
            {"Bucket": "bkt", "Prefix": "raw/incidents/austin/"})
        st.add_response("list_objects_v2", {
            "Contents": [{"Key": "raw/incidents/austin/b.pdf", "Size": 4}], "IsTruncated": False},
            {"Bucket": "bkt", "Prefix": "raw/incidents/austin/", "ContinuationToken": "t1"})
        assert list(s.list_keys("raw/incidents/austin/")) == [
            ("raw/incidents/austin/a.pdf", 3), ("raw/incidents/austin/b.pdf", 4)]

        st.add_response("list_objects_v2", {
            "CommonPrefixes": [{"Prefix": "tiles/incidents/austin/"},
                               {"Prefix": "tiles/incidents/bobcat-lakes/"}],
            "IsTruncated": False},
            {"Bucket": "bkt", "Prefix": "tiles/incidents/", "Delimiter": "/"})
        assert list(s.list_dirs("tiles/incidents")) == ["austin", "bobcat-lakes"]
        st.assert_no_pending_responses()


def test_b2_delete_keys_batches_of_1000_and_raises_on_errors():
    s = _b2()
    keys = [f"raw/incidents/old/{i:05d}.pdf" for i in range(b2.DELETE_BATCH + 1)]
    with Stubber(s.client) as st:
        st.add_response("delete_objects", {}, {"Bucket": "bkt", "Delete": {
            "Objects": [{"Key": k} for k in keys[:1000]], "Quiet": True}})
        st.add_response("delete_objects", {}, {"Bucket": "bkt", "Delete": {
            "Objects": [{"Key": keys[1000]}], "Quiet": True}})
        assert s.delete_keys(keys + keys[:5]) == 1001
        st.add_response("delete_objects", {"Errors": [
            {"Key": keys[0], "Code": "AccessDenied", "Message": "no"}]})
        with pytest.raises(RuntimeError, match="1 of 1 failed"):
            s.delete_keys(keys[:1])
        st.assert_no_pending_responses()


def test_read_only_storage_reads_through_and_refuses_writes(tmp_path):
    inner = DryRunStorage(tmp_path / "inner")
    inner.put_json("state/state.json", {"incidents": {}})
    ro = ReadOnlyStorage(inner)
    assert ro.get_json("state/state.json") == {"incidents": {}}
    assert ro.exists("state/state.json") and not ro.exists("nope")
    assert ro.get_file("state/state.json", tmp_path / "copy.json")
    assert [k for k, _ in ro.list_keys("state/")] == ["state/state.json"]
    assert list(ro.list_dirs("")) == ["state"]
    src = tmp_path / "f.bin"
    src.write_bytes(b"x")
    tree = tmp_path / "tree"
    (tree / "1").mkdir(parents=True)
    (tree / "1" / "2.png").write_bytes(b"png")
    for write in (lambda: ro.put_bytes("a", b"x"), lambda: ro.put_file("a", src),
                  lambda: ro.put_json("state/state.json", {}), lambda: ro.put_tree("t/", tree),
                  lambda: ro.delete_prefix("state/"), lambda: ro.delete_keys(["state/state.json"])):
        with pytest.raises(StorageWriteRefused):
            write()
    assert inner.written == ["state/state.json"]
    assert inner.get_json("state/state.json") == {"incidents": {}}


def test_recording_storage_captures_reads_back_and_flushes_in_order(tmp_path):
    inner = DryRunStorage(tmp_path / "inner")
    inner.put_json("state/state.json", {"v": 0})
    inner.put_bytes("catalogs/catalog.json", b'{"old": true}')
    inner.written.clear()
    rec = RecordingStorage(inner)

    rec.put_json("catalogs/incidents/id/49d1fb0b.json", {"maps": []}, cache_control="max-age=60")
    rec.put_json("state/state.json", {"v": 1}, cache_control="private, no-store")
    pdf = tmp_path / "a.pdf"
    pdf.write_bytes(b"%PDF")
    rec.put_file("raw/incidents/x/a.pdf", pdf)
    pdf.unlink()  # captured at put time, not at flush time
    rec.put_json("state/state.json", {"v": 2}, cache_control="private, no-store")
    tree = tmp_path / "tree"
    for rel in ("10/2/1.png", "10/1/1.png"):
        (tree / rel).parent.mkdir(parents=True, exist_ok=True)
        (tree / rel).write_bytes(rel.encode())
    assert rec.put_tree("tiles/incidents/x/ab", tree) == 2

    assert inner.written == []  # nothing forwarded
    assert inner.get_json("state/state.json") == {"v": 0}
    assert rec.get_json("state/state.json") == {"v": 2}  # newest capture wins
    assert rec.get_json("catalogs/catalog.json") == {"old": True}  # falls through
    assert rec.exists("raw/incidents/x/a.pdf") and not inner.exists("raw/incidents/x/a.pdf")
    assert rec.get_file("raw/incidents/x/a.pdf", tmp_path / "out" / "a.pdf")
    assert (tmp_path / "out" / "a.pdf").read_bytes() == b"%PDF"
    assert [k for k, _ in rec.list_keys("raw/")] == []  # listings show the inner storage
    assert rec.captured_keys() == [
        "catalogs/incidents/id/49d1fb0b.json", "state/state.json", "raw/incidents/x/a.pdf",
        "tiles/incidents/x/ab/10/1/1.png", "tiles/incidents/x/ab/10/2/1.png"]
    with pytest.raises(StorageWriteRefused):
        rec.delete_keys(["state/state.json"])
    with pytest.raises(StorageWriteRefused):
        rec.delete_prefix("raw/")

    class Spy(DryRunStorage):
        def __init__(self, out_dir):
            super().__init__(out_dir)
            self.calls = []

        def put_bytes(self, key, data, *, content_type=None, cache_control=None):
            self.calls.append((key, content_type, cache_control))
            super().put_bytes(key, data, content_type=content_type, cache_control=cache_control)

    target = Spy(tmp_path / "target")
    assert rec.flush(target) == 6
    assert target.calls == [
        ("catalogs/incidents/id/49d1fb0b.json", "application/json", "max-age=60"),
        ("state/state.json", "application/json", "private, no-store"),
        ("raw/incidents/x/a.pdf", None, None),
        ("state/state.json", "application/json", "private, no-store"),
        ("tiles/incidents/x/ab/10/1/1.png", None, None),
        ("tiles/incidents/x/ab/10/2/1.png", None, None)]
    assert target.get_json("state/state.json") == {"v": 2}
    assert json.loads((tmp_path / "target" / "catalogs/incidents/id/49d1fb0b.json").read_text()) \
        == {"maps": []}


def _busy():
    return ClientError({"Error": {"Code": "ServiceUnavailable", "Message": "too_busy"},
                        "ResponseMetadata": {"HTTPStatusCode": 503}}, "GetObject")


class _Flaky:
    def __init__(self, *outcomes):
        self.outcomes = list(outcomes)
        self.calls = 0

    def get_json(self, key):
        self.calls += 1
        out = self.outcomes.pop(0)
        if isinstance(out, BaseException):
            raise out
        return out


def test_get_json_retry_backs_off_on_busy_and_transport_errors():
    slept = []
    s = _Flaky(_busy(), EndpointConnectionError(endpoint_url="https://b2"), {"version": 412})
    assert get_json_retry(s, "catalogs/versions/catalog.412.json", sleep=slept.append) == \
        {"version": 412}
    assert slept == [1, 2] and s.calls == 3

    assert get_json_retry(_Flaky(None), "catalogs/versions/catalog.9.json", sleep=slept.append) is None

    denied = ClientError({"Error": {"Code": "AccessDenied", "Message": "no"},
                          "ResponseMetadata": {"HTTPStatusCode": 403}}, "GetObject")
    s = _Flaky(denied, {"never": True})
    with pytest.raises(ClientError):
        get_json_retry(s, "k", sleep=slept.append)
    assert s.calls == 1

    s = _Flaky(_busy(), _busy(), ConnectionError("reset"), _busy(), {"never": True})
    slept.clear()
    with pytest.raises(ClientError):
        get_json_retry(s, "k", tries=4, sleep=slept.append)
    assert s.calls == 4 and slept == [1, 2, 4]
