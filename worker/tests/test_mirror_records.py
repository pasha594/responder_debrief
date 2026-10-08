"""The mirror on fire-ID records: every key from the record (unchanged
files where their bytes are, new revisions under the record's own storage
prefix), owner stamps carried over only with evidence, temp files per
incident, pruned files never fetched, and no write under another fire."""

import hashlib
import json

import pytest

from ftp_stub import BASE, FakeFTP
from incident_world import AUSTIN, GRASSHOPPER, sha16
from responder_worker import frames
from responder_worker.b2 import DryRunStorage
from responder_worker.fires import fire_key
from responder_worker.incident_ids import bound_info
from responder_worker.mirror import IncidentMirror

GH_KEY = "pacific_nw/2026/2026_Grasshopper"
GH_DIR = f"{BASE}/pacific_nw/2026_Incidents_Oregon/2026_Grasshopper/"
GH_FK, AU_FK = fire_key(GRASSHOPPER["cornea_id"]), fire_key(AUSTIN["cornea_id"])
DAY = "products/20261008"
OPS = "Ops_ArchE_Land_20261007_2037_Grasshopper_ORMHF000688_1008_Day.pdf"
AU_OPS = "Ops_ArchE_Port_20261007_2018_Austin_ORMHF000863_1008_Day.pdf"
PLAIN = "Transport_1008.pdf"
QR = "qr/Grasshopper_QR.pdf"


def _match(fire=GRASSHOPPER, method="unit_id"):
    return {"method": method, "confidence": 1.0, "token": fire["unique_fire_id"],
            "dir_url": GH_DIR, "cornea_id": fire["cornea_id"]}


def _meta(data: bytes, **extra) -> dict:
    meta = {"etag": '"old"', "lm": "Mon, 05 Oct 2026 05:00:00 GMT", "size": len(data),
            "sha16": sha16(data), "rev": 1, "kind": "product", "url": "u",
            "first_seen": "2026-10-05T05:10:00Z"}
    meta.update(extra)
    return meta


def _ftp(files: dict[str, bytes], *, qr: dict[str, bytes] | None = None) -> FakeFTP:
    ftp = FakeFTP()
    products = ftp.dir(GH_DIR, "Products", "2026-10-08 05:00")
    day = ftp.dir(products, "20261008", "2026-10-08 05:00")
    for name, data in files.items():
        ftp.file(day, name, data)
    if qr is not None:
        qdir = ftp.dir(GH_DIR, "QR", "2026-10-01 05:00")
        for name, data in qr.items():
            ftp.file(qdir, name, data)
    return ftp


def _mirror(tmp_path, state, **kw):
    frames.start_deadline(0)  # disarmed
    storage = DryRunStorage(tmp_path / "bucket")
    return IncidentMirror(None, storage, state, work_dir=tmp_path / "work",
                          since="20260801", **kw), storage


def _gh_record(**files) -> dict:
    """2026_Grasshopper after the split: its own prefix, bound to
    Grasshopper; early files still under austin/ (the folder showed on
    Austin), some stamped to Austin."""
    return {"fire_slug": "grasshopper", "storage_prefix": "grasshopper",
            "cornea_id": GRASSHOPPER["cornea_id"], "match": _match(),
            "bound": bound_info(GRASSHOPPER, "unit_id"), "dir_mtime": "2026-10-05 05:00",
            "children": {}, "files": dict(files)}


def _sync(m, state, key=GH_KEY, dir_url=GH_DIR, fire=GRASSHOPPER):
    return m.sync_incident(incident_key=key, dir_url=dir_url, match=_match(fire),
                           cornea_id=fire["cornea_id"], bound=bound_info(fire, "unit_id"),
                           dir_mtime="2026-10-08 05:00", region="pacific_nw_oregon")


def test_200_writes_under_storage_prefix_and_drops_file_prefix(tmp_path, monkeypatch):
    new_ops, au_ops, plain = b"%PDF ops rev 2", b"%PDF austin rev 2", b"%PDF transport"
    state = {"incidents": {GH_KEY: _gh_record(**{
        # a new revision of a sheet mirrored under austin/, placed on Austin
        # by location only: the new bytes follow the binding
        f"{DAY}/{OPS}": _meta(b"%PDF ops rev 1", prefix="austin", fk=AU_FK, fk_src="location",
                              missing="2026-10-07T00:00:00Z"),
        # Austin's own sheet (its token): the name still proves it, so the
        # stamp survives new bytes
        f"{DAY}/{AU_OPS}": _meta(b"%PDF austin rev 1", prefix="austin", fk=AU_FK, fk_src="token"),
        # the same bytes again (etag changed only): a placement survives
        f"{DAY}/{PLAIN}": _meta(plain, prefix="austin", fk=AU_FK, fk_src="prior"),
    })}}
    ftp = _ftp({OPS: new_ops, AU_OPS: au_ops, PLAIN: plain}).wire(monkeypatch)
    m, storage = _mirror(tmp_path, state)
    res = _sync(m, state)

    assert res.downloads == 3 and len(ftp.gets()) == 3
    files = state["incidents"][GH_KEY]["files"]
    for rel, data in ((f"{DAY}/{OPS}", new_ops), (f"{DAY}/{AU_OPS}", au_ops),
                      (f"{DAY}/{PLAIN}", plain)):
        assert storage.get_file(f"raw/incidents/grasshopper/{rel}", tmp_path / "x")
        assert (tmp_path / "x").read_bytes() == data
        assert "prefix" not in files[rel] and "missing" not in files[rel]
    assert not [k for k in storage.written if not k.startswith("raw/incidents/grasshopper/")]
    assert "fk" not in files[f"{DAY}/{OPS}"]
    assert (files[f"{DAY}/{OPS}"]["rev"], files[f"{DAY}/{OPS}"]["sha16"]) == (2, sha16(new_ops))
    assert files[f"{DAY}/{AU_OPS}"]["fk"] == AU_FK and files[f"{DAY}/{AU_OPS}"]["fk_src"] == "token"
    assert (files[f"{DAY}/{PLAIN}"]["fk"], files[f"{DAY}/{PLAIN}"]["rev"]) == (AU_FK, 1)
    assert files[f"{DAY}/{OPS}"]["first_seen"] == "2026-10-05T05:10:00Z"
    by_rel = {f"{f.rel_dir}/{f.filename}": f for f in res.files}
    assert by_rel[f"{DAY}/{OPS}"].key == f"raw/incidents/grasshopper/{DAY}/{OPS}"
    assert by_rel[f"{DAY}/{OPS}"].changed and not by_rel[f"{DAY}/{PLAIN}"].changed
    # the record's slug and prefix are never rewritten
    rec = state["incidents"][GH_KEY]
    assert (rec["fire_slug"], rec["storage_prefix"]) == ("grasshopper", "grasshopper")


def test_304_and_replay_use_stamped_location(tmp_path, monkeypatch):
    ops, qr = b"%PDF ops", b"%PDF qr"
    ftp = _ftp({OPS: ops}, qr={"Grasshopper_QR.pdf": qr})
    etag = '"' + hashlib.sha256(ops).hexdigest()[:12] + '"'
    state = {"incidents": {GH_KEY: _gh_record(**{
        f"{DAY}/{OPS}": _meta(ops, etag=etag, prefix="austin"),
        QR: _meta(qr, kind="qr", prefix="austin"),
    })}}
    state["incidents"][GH_KEY]["children"] = {"QR": "2026-10-01 05:00"}  # unchanged subtree
    ftp.wire(monkeypatch)
    m, storage = _mirror(tmp_path, state)
    res = _sync(m, state)

    assert res.downloads == 0 and storage.written == []
    assert ftp.gets() == [f"{GH_DIR}Products/20261008/{OPS}"]  # QR replayed, not requested
    keys = {f"{f.rel_dir}/{f.filename}": f.key for f in res.files}
    assert keys == {f"{DAY}/{OPS}": f"raw/incidents/austin/{DAY}/{OPS}",
                    QR: f"raw/incidents/austin/{QR}"}
    assert all(f.local_path is None for f in res.files)
    assert state["incidents"][GH_KEY]["files"][QR]["prefix"] == "austin"


def test_temp_path_keyed_by_incident(tmp_path, monkeypatch):
    # Two folders publishing the same file path with different bytes: each
    # download keeps its own temp copy (keyed by incident, not by slug or
    # fire), so tiling one never reads the other's bytes.
    ftp = _ftp({OPS: b"%PDF grasshopper's"})
    other_key = "pacific_nw/2026/2026_GrasshopperComplex"
    other_dir = f"{BASE}/pacific_nw/2026_Incidents_Oregon/2026_GrasshopperComplex/"
    products = ftp.dir(other_dir, "Products")
    ftp.file(ftp.dir(products, "20261008"), OPS, b"%PDF the complex's")
    ftp.wire(monkeypatch)
    state = {"incidents": {}}
    m, storage = _mirror(tmp_path, state)
    a = _sync(m, state)
    b = _sync(m, state, key=other_key, dir_url=other_dir)

    [fa], [fb] = a.files, b.files
    assert fa.local_path == (tmp_path / "work" / hashlib.sha1(GH_KEY.encode()).hexdigest()[:12]
                             / DAY / OPS)
    assert fb.local_path.parent.parent.parent.name == hashlib.sha1(
        other_key.encode()).hexdigest()[:12]
    assert fa.local_path.read_bytes() == b"%PDF grasshopper's"
    assert fb.local_path.read_bytes() == b"%PDF the complex's"
    # both are Grasshopper's folders: the second one gets a prefix of its own
    recs = state["incidents"]
    assert recs[GH_KEY]["storage_prefix"] == GH_FK
    assert recs[other_key]["storage_prefix"] == (
        f"{GH_FK}-{hashlib.sha1(other_key.encode()).hexdigest()[:6]}")
    assert all(r["fire_slug"] == r["storage_prefix"] for r in recs.values())
    assert fb.key == f"raw/incidents/{recs[other_key]['storage_prefix']}/{DAY}/{OPS}"


def test_pruned_file_never_requested(tmp_path, monkeypatch):
    ops, qr = b"%PDF ops", b"%PDF qr"
    ftp = _ftp({OPS: ops, PLAIN: b"%PDF new"}, qr={"Grasshopper_QR.pdf": qr})
    pruned = "2026-10-06T00:00:00Z"
    state = {"incidents": {GH_KEY: _gh_record(**{
        f"{DAY}/{OPS}": _meta(ops, pruned_at=pruned),
        QR: _meta(qr, kind="qr", pruned_at=pruned),
    })}}
    state["incidents"][GH_KEY]["children"] = {"QR": "2026-10-01 05:00"}
    ftp.wire(monkeypatch)
    m, storage = _mirror(tmp_path, state)
    res = _sync(m, state)

    assert ftp.gets() == [f"{GH_DIR}Products/20261008/{PLAIN}"]
    assert [f.filename for f in res.files] == [PLAIN]  # the pruned QR is not replayed
    files = state["incidents"][GH_KEY]["files"]
    assert files[f"{DAY}/{OPS}"]["pruned_at"] == pruned and files[QR]["pruned_at"] == pruned
    assert storage.written == [f"raw/incidents/grasshopper/{DAY}/{PLAIN}"]


def test_sync_incident_refuses_cornea_change(tmp_path, monkeypatch):
    ftp = _ftp({OPS: b"%PDF ops"}).wire(monkeypatch)
    state = {"incidents": {GH_KEY: _gh_record(**{f"{DAY}/{OPS}": _meta(b"%PDF ops")})}}
    before = json.dumps(state, sort_keys=True)
    m, storage = _mirror(tmp_path, state)
    # the caller rebinds (incident_ids.apply_bind) before mirroring under
    # another fire; the mirror never does it
    with pytest.raises(ValueError):
        _sync(m, state, fire=AUSTIN)
    with pytest.raises(ValueError):  # a new folder needs a fire
        m.sync_incident(incident_key="pacific_nw/2026/2026_Nope", dir_url=GH_DIR, match={},
                        cornea_id=None, bound=None, dir_mtime=None)
    assert json.dumps(state, sort_keys=True) == before
    assert ftp.requests == [] and storage.written == []
