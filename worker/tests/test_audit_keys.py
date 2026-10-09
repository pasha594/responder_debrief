"""audit-incident-keys (Phase 4): every incident key state names, checked
against the bucket's listings. Report mode writes nothing; --repair edits
state only (hash-verified locations, missing marks, previews and tiles
queued again, IR conversions with no object dropped) and marks the fires it
touched for rebuild; --refetch-missing writes raw objects re-fetched from
the FTP, only where nothing is. Nothing is ever copied or deleted.

The bucket is modelled on the migrated state of 2026-10-08: 2026_Grasshopper
(its early sheets under austin/, stamped to Austin by token) and 2026_Austin.
"""

import contextlib
import hashlib
import json
from pathlib import Path

import httpx
import pytest

from ftp_stub import FakeFTP
from incident_world import (
    AU_FK, AU_KEY, AU_SHEET, AUSTIN, GH_FK, GH_KEY, GH_SHEET, GRASSHOPPER, NOW, SpyStorage,
    api_fire, freeze_clock, sha16,
)
from responder_worker import audit_keys, cli, config, frames, geopdf
from responder_worker.asset_keys import raw_key
from responder_worker.fire_manifests import manifest_key
from responder_worker.incident_ids import bound_info
from responder_worker.state import STATE_KEY

FLAG = "2026-10-08T21:53:17Z"
FTP_DIR = ("https://ftp.wildfire.gov/public/incident_specific_maps/pacific_nw/"
           "2026_Incidents_Oregon/2026_Grasshopper")
TILES = {"minzoom": 8, "maxzoom": 14, "bounds": [-122.2, 44.7, -121.7, 45.2]}
#: 2026_Grasshopper's sheet of 08-17, shown on Austin (its unit token)
AU_TOKEN_SHEET = "products/20260817/AirOps_ArchE_port_20260816_2155_Austin_ORMHF000863_0817_Day.pdf"
OWN_SHEET = "products/20261003/Ops_Grasshopper_1003.pdf"
EVAC = "qr/Evac_0820.pdf"
IR_KMZ = "ir/20260929/20260929_Grasshopper_IR.kmz"
FAILED_GONE = "vectors/ir/babylon/20260723_IR_11x17_Ortho.geojson"
FAILED_THERE = "vectors/ir/bug/20260819_IR_11x17_Ortho.geojson"
LOST = f"vectors/ir/grasshopper/{'e' * 16}.v3.geojson"


def _pdf(name: str) -> bytes:
    return f"%PDF {name}".encode()


class Scene:
    """A migrated bucket: state, raw objects, tiles, previews, vectors and
    the ID manifests the index names."""

    def __init__(self, tmp_path):
        self.bucket = SpyStorage(tmp_path / "bucket")  # deletes refused, writes recorded
        self.state = {
            "schema_version": 1, "updated_at": "2026-10-09T01:30:00Z",
            "incidents": {}, "tiled": {}, "ir": {}, "incident_fires": {},
            "migrations": {"incident_ids": FLAG,
                           "slugs_at_migration": {GH_KEY: "grasshopper", AU_KEY: "austin"}},
            "prune": {"inactive_since": {}},
        }
        self.fires = [api_fire(GRASSHOPPER, "grasshopper"), api_fire(AUSTIN, "austin")]
        for key, fire, prefix in ((GH_KEY, GRASSHOPPER, "grasshopper"), (AU_KEY, AUSTIN, "austin")):
            self.state["incidents"][key] = {
                "fire_slug": prefix, "storage_prefix": prefix, "cornea_id": fire["cornea_id"],
                "match": {"method": "unit_id", "token": fire["unique_fire_id"]},
                "bound": bound_info(fire, "unit_id"), "synced_at": "2026-10-09T01:00:00Z",
                "files": {}}

    def file(self, key, rel, data: bytes, *, at: str | None = None, put: bool | str = True,
             **meta) -> str:
        """A file of `key`, stamped `at` (its bytes' prefix in state); `put`
        False puts no bytes, a prefix puts them there instead."""
        rec = self.state["incidents"][key]
        entry = {"etag": '"x"', "lm": "Thu, 01 Oct 2026 05:05:56 GMT", "size": len(data),
                 "sha16": sha16(data), "rev": 1,
                 "kind": "ir" if rel.startswith("ir/") else "product",
                 "url": f"{FTP_DIR}/{rel}", **meta}
        if at:
            entry["prefix"] = at
        rec["files"][rel] = entry
        if put:
            where = put if isinstance(put, str) else (at or rec["storage_prefix"])
            self.bucket.put_bytes(f"raw/incidents/{where}/{rel}", data)
        return entry["sha16"]

    def tiled(self, sha, *, prefix=None, tiles_at=(), preview_at=(), **entry):
        t = {"tiler_version": config.TILER_VERSION, "at": "2026-10-01T00:00:00Z",
             "geo": {"georeferenced": True, "projection": "UTM 10N", "tiles": TILES,
                     "preview": True}, **entry}
        if prefix:
            t["prefix"] = prefix
        self.state["tiled"][sha] = t
        for p in tiles_at:
            self.bucket.put_bytes(f"tiles/incidents/{p}/{sha}/meta.json", b"{}")
            self.bucket.put_bytes(f"tiles/incidents/{p}/{sha}/8/1/2.png", b"png")
        for p in preview_at:
            self.bucket.put_bytes(f"previews/incidents/{p}/{sha}.png", b"png")
        return t

    def manifest(self, fk, fire, urls: list[str]):
        self.state["incident_fires"][fk] = {"v": 1, "cornea_id": fire["cornea_id"],
                                            "manifest": manifest_key(fk), "dirs": []}
        self.bucket.put_json(manifest_key(fk), {
            "schema_version": 1, "cornea_id": fire["cornea_id"], "fire_key": fk,
            "maps": [{"id": "x", "pdf_url": u} for u in urls], "ir_flights": []})

    def publish(self) -> "Scene":
        self.bucket.put_json(STATE_KEY, self.state)
        self.bucket.put_json("catalogs/catalog.json",
                             {"counts": {"active_fires": len(self.fires)}, "fires": []})
        self.bucket.written.clear()
        return self

    def state_on_bucket(self) -> dict:
        return json.loads((self.bucket.out_dir / STATE_KEY).read_text())


def _full(tmp_path) -> Scene:
    """Every finding at once: a sheet whose bytes are under another prefix,
    one missing everywhere, a preview and a tile tree missing everywhere,
    tiles under another prefix than stamped, failed and lost IR."""
    s = Scene(tmp_path)
    s.file(GH_KEY, AU_TOKEN_SHEET, _pdf("airops 0817"), at="austin", fk=AU_FK, fk_src="token")
    own = s.file(GH_KEY, OWN_SHEET, _pdf("ops 1003"))
    # mirrored under austin/ while the folder showed on Austin; state never knew
    s.file(GH_KEY, GH_SHEET, _pdf("ops 0925"), put="austin")
    s.file(GH_KEY, EVAC, _pdf("evac 0820"), put=False)
    kmz = s.file(GH_KEY, IR_KMZ, b"PK kmz 0929")
    au = s.file(AU_KEY, AU_SHEET, _pdf("au ops 0930"))
    s.tiled(own, prefix="grasshopper", tiles_at=["grasshopper"])            # preview gone
    s.tiled(au, prefix="austin", preview_at=["austin"])                      # tiles gone
    s.tiled(sha16(_pdf("airops 0817")), prefix="austin", tiles_at=["grasshopper"],
            preview_at=["austin"])                                           # tiles elsewhere
    s.state["ir"] = {FAILED_GONE: {"v": 3, "failed": True},
                     FAILED_THERE: {"v": 3, "failed": True},
                     LOST: {"v": 3, "heat_types": ["Perimeter"]}}
    s.bucket.put_json(FAILED_THERE, {"type": "FeatureCollection", "features": [
        {"properties": {"heat_type": "Perimeter"}}, {"properties": {"heat_type": "Isolated"}},
        {"properties": {"heat_type": "Perimeter"}}]})
    s.state["incidents"][GH_KEY]["ir_keys"] = {
        IR_KMZ: {"key": LOST, "flight_id": "20260929_IR", "src_sha16": kmz}}
    s.manifest(GH_FK, GRASSHOPPER, [f"/{raw_key(s.state['incidents'][GH_KEY], OWN_SHEET)}",
                                    f"/raw/incidents/grasshopper/{GH_SHEET}"])
    s.manifest(AU_FK, AUSTIN, [f"/raw/incidents/austin/{AU_SHEET}"])
    return s.publish()


def _wire(monkeypatch, scene: Scene) -> None:
    freeze_clock(monkeypatch)
    monkeypatch.setattr(cli, "make_storage", lambda dry_run, out: scene.bucket)
    monkeypatch.setattr(cli, "make_client", lambda: contextlib.nullcontext(None))

    def fetch_active_fires(client, meta=None):
        if meta is not None:
            meta["raw_rows"] = len(scene.fires)
        return [dict(f) for f in scene.fires]

    monkeypatch.setattr(cli, "fetch_active_fires", fetch_active_fires)


def _audit(tmp_path, *flags) -> dict:
    out = tmp_path / f"report{len(list(tmp_path.glob('report*.json')))}.json"
    assert cli.main(["audit-incident-keys", *flags, "--report-out", str(out)]) == 0
    return json.loads(out.read_text())


# ---------------------------------------------------------------------------
# report
# ---------------------------------------------------------------------------

def test_audit_report_writes_nothing(tmp_path, monkeypatch):
    scene = _full(tmp_path)
    before = (scene.bucket.out_dir / STATE_KEY).read_bytes()
    _wire(monkeypatch, scene)
    report = _audit(tmp_path, "--report")

    assert scene.bucket.written == [] and report["storage_writes"] == 0
    assert (scene.bucket.out_dir / STATE_KEY).read_bytes() == before
    assert report["mode"] == "report"
    # 1, 3: the sheet under austin/, the missing one, and the URL naming it
    assert report["raw"]["moves"] == [{"key": GH_KEY, "rel": GH_SHEET, "from": "grasshopper",
                                       "to": "austin"}]
    assert report["raw"]["missing"] == [{"key": GH_KEY, "rel": EVAC,
                                         "sha16": sha16(_pdf("evac 0820"))}]
    assert report["manifests"]["missing_urls"] == [
        {"fk": GH_FK, "url": f"/raw/incidents/grasshopper/{GH_SHEET}"}]
    # 2: copies away from their stamps, and copies nowhere
    shas = report["shas"]
    assert shas["tiles"]["moved"] == [{"sha": sha16(_pdf("airops 0817")), "from": "austin",
                                       "to": "grasshopper"}]
    assert shas["tiles"]["missing"] == [sha16(_pdf("au ops 0930"))]
    assert shas["previews"]["missing"] == [sha16(_pdf("ops 1003"))]
    # 4: IR
    ir = report["ir"]
    assert [(f["key"], f["object_exists"]) for f in ir["failed"]] == [
        (FAILED_GONE, False), (FAILED_THERE, True)]
    assert ir["missing_objects"] == [LOST]
    assert ir["ir_keys_missing"] == [{"key": GH_KEY, "src": IR_KMZ, "ir_key": LOST}]
    # 6, 7: no third fire named, no slug changed by older code
    assert report["slug_drift"] == [] and "id_suspect" in report


def test_audit_finds_misplaced_raw_by_hash(tmp_path, monkeypatch):
    scene = Scene(tmp_path)
    good = _pdf("the 09-25 sheet")
    scene.file(GH_KEY, GH_SHEET, good, put=False)
    # same rel and size under austin/ (first alphabetically) but other bytes;
    # the right bytes under sand-creek/; a longer copy is never fetched
    scene.bucket.put_bytes(f"raw/incidents/austin/{GH_SHEET}", _pdf("the 09-25 shee!"))
    scene.bucket.put_bytes(f"raw/incidents/sand-creek/{GH_SHEET}", good)
    scene.bucket.put_bytes(f"raw/incidents/bobcat-lakes/{GH_SHEET}", good + b" longer")
    scene.manifest(GH_FK, GRASSHOPPER, [f"/raw/incidents/grasshopper/{GH_SHEET}"])
    scene.manifest(AU_FK, AUSTIN, [])
    scene.publish()
    _wire(monkeypatch, scene)

    report = _audit(tmp_path, "--report")
    assert report["raw"]["moves"] == [{"key": GH_KEY, "rel": GH_SHEET, "from": "grasshopper",
                                       "to": "sand-creek"}]
    assert report["raw"]["sha_mismatch"] == [f"raw/incidents/austin/{GH_SHEET}"]
    assert "prefix" not in scene.state_on_bucket()["incidents"][GH_KEY]["files"][GH_SHEET]

    report = _audit(tmp_path, "--repair")
    state = scene.state_on_bucket()
    assert state["incidents"][GH_KEY]["files"][GH_SHEET]["prefix"] == "sand-creek"
    assert report["repair"]["raw_stamped"] == 1
    # the fire whose manifest links the sheet is rebuilt by the next mirror run
    assert {fk: e["v"] for fk, e in state["incident_fires"].items()} == {GH_FK: 0, AU_FK: 1}
    assert state["migrations"]["incident_keys_audit"] == NOW
    assert scene.bucket.written == [STATE_KEY]


# ---------------------------------------------------------------------------
# repair
# ---------------------------------------------------------------------------

@pytest.fixture
def gdal(monkeypatch):
    calls = {"render": [], "probe": []}

    def render_preview(pdf, out_png, **kw):
        calls["render"].append(Path(pdf).read_bytes())
        Path(out_png).write_bytes(b"png again")
        return out_png

    def probe_pdf(pdf):
        calls["probe"].append(Path(pdf).read_bytes())
        return {"georeferenced": True, "projection": "UTM 10N"}

    monkeypatch.setattr(geopdf, "gdal_available", lambda: True)
    monkeypatch.setattr(geopdf, "render_preview", render_preview)
    monkeypatch.setattr(geopdf, "probe_pdf", probe_pdf)
    frames.start_deadline(0)  # disarmed
    return calls


def test_audit_repair_needs_preview_keeps_tiles(tmp_path, monkeypatch, gdal):
    scene = _full(tmp_path)
    _wire(monkeypatch, scene)
    report = _audit(tmp_path, "--repair")
    sha = sha16(_pdf("ops 1003"))
    assert report["repair"]["needs_preview"] == [sha]
    state = scene.state_on_bucket()
    entry = state["tiled"][sha]
    assert entry["needs_preview"] is True
    assert (entry["tiler_version"], entry["geo"]["tiles"], entry["prefix"]) == (
        config.TILER_VERSION, TILES, "grasshopper")

    # the probe backlog's preview-only pass: verified bytes, a render, a PUT
    # where no preview is; tiles, tiler_version and prefix as they were
    scene.bucket.written.clear()
    touched = cli._probe_backlog(scene.bucket, state, lambda *_: None)
    # (the 09-25 sheet was never probed: the backlog's usual pass takes it)
    assert _pdf("ops 1003") in gdal["render"] and _pdf("ops 1003") not in gdal["probe"]
    assert f"previews/incidents/grasshopper/{sha}.png" in scene.bucket.written
    assert GH_KEY in touched
    entry = state["tiled"][sha]
    assert "needs_preview" not in entry and entry["geo"]["preview"] is True
    assert (entry["tiler_version"], entry["geo"]["tiles"], entry["prefix"]) == (
        config.TILER_VERSION, TILES, "grasshopper")

    # a preview someone wrote meanwhile is never overwritten
    entry["needs_preview"] = True
    scene.bucket.written.clear()
    gdal["render"].clear()
    cli._probe_backlog(scene.bucket, state, lambda *_: None)
    assert gdal["render"] == [] and scene.bucket.written == []
    assert "needs_preview" not in state["tiled"][sha]
    assert state["tiled"][sha]["geo"]["preview"] is True

    # the tile backlog re-tiling the sheet keeps the preview owed
    state["tiled"][sha].update(needs_preview=True, tiler_version=None)
    monkeypatch.setattr(geopdf, "process_pdf", lambda *a, **k: {
        "georeferenced": True, "projection": "UTM 10N", "tiles": None})
    cli._tile_backlog(scene.bucket, state, lambda *_: None)
    assert state["tiled"][sha]["needs_preview"] is True


def test_audit_repair_requeues_tiles(tmp_path, monkeypatch):
    scene = _full(tmp_path)
    _wire(monkeypatch, scene)
    report = _audit(tmp_path, "--repair")
    au, airops = sha16(_pdf("au ops 0930")), sha16(_pdf("airops 0817"))
    assert report["repair"]["tiles_requeued"] == [au]
    state = scene.state_on_bucket()
    entry = state["tiled"][au]
    # owed again, under the prefix it is stamped with; geo and preview kept
    assert entry["tiler_version"] is None and entry["prefix"] == "austin"
    assert entry["geo"]["tiles"] == TILES and "needs_preview" not in entry
    assert cli._pending_sheets(state) == [(au, "austin", [f"raw/incidents/austin/{AU_SHEET}"])]
    # tiles listed under another prefix than stamped: the stamp follows them,
    # the preview keeps its own
    assert (state["tiled"][airops]["prefix"], state["tiled"][airops]["preview_prefix"]) == (
        "grasshopper", "austin")
    assert state["tiled"][airops]["tiler_version"] == config.TILER_VERSION
    # every fire showing those sheets is rebuilt
    assert {fk: e["v"] for fk, e in state["incident_fires"].items()} == {GH_FK: 0, AU_FK: 0}


def test_audit_repair_drops_failed_ir_only_when_key_absent(tmp_path, monkeypatch):
    scene = _full(tmp_path)
    _wire(monkeypatch, scene)
    report = _audit(tmp_path, "--repair")
    state = scene.state_on_bucket()
    fix = report["repair"]
    # nothing was ever written under the failed key: dropped, so the next
    # mirror run converts again
    assert FAILED_GONE not in state["ir"] and fix["ir_failed_dropped"] == [FAILED_GONE]
    # the object exists: the conversion worked after all
    assert state["ir"][FAILED_THERE] == {"v": 3, "heat_types": ["Perimeter", "Isolated"]}
    assert fix["ir_heat_types_restored"] == [FAILED_THERE]
    # a recorded conversion whose object is gone, and the stamp naming it
    assert LOST not in state["ir"] and fix["ir_lost_dropped"] == [LOST]
    assert "ir_keys" not in state["incidents"][GH_KEY] or IR_KMZ not in (
        state["incidents"][GH_KEY]["ir_keys"])
    assert fix["ir_keys_dropped"] == [{"key": GH_KEY, "src": IR_KMZ}]
    # the IR backlog now owes Grasshopper that flight
    fires_by_fk = {GH_FK: GRASSHOPPER}
    assert cli._ir_backlog(state, fires_by_fk, lambda *_: None) == {GH_FK}


def test_audit_never_copies_or_deletes(tmp_path, monkeypatch):
    scene = _full(tmp_path)
    keys_before = {k for k, _s in scene.bucket.list_keys("")}
    _wire(monkeypatch, scene)
    report = _audit(tmp_path, "--repair")   # SpyStorage raises on any delete
    assert scene.bucket.written == [STATE_KEY] and report["storage_writes"] == 1
    assert {k for k, _s in scene.bucket.list_keys("")} == keys_before
    state = scene.state_on_bucket()
    # the missing sheet is marked, its stamp left; the misplaced one stamped
    files = state["incidents"][GH_KEY]["files"]
    assert files[EVAC]["missing"] == NOW and "prefix" not in files[EVAC]
    assert files[GH_SHEET]["prefix"] == "austin"
    assert report["repair"]["missing_marked"] == [{"key": GH_KEY, "rel": EVAC}]

    # a second repair changes nothing more: the mark keeps its first date
    scene.bucket.written.clear()
    report = _audit(tmp_path, "--repair")
    assert report["repair"]["missing_marked"] == [] and report["repair"]["raw_stamped"] == 0
    assert scene.state_on_bucket()["incidents"][GH_KEY]["files"][EVAC]["missing"] == NOW


# ---------------------------------------------------------------------------
# --refetch-missing
# ---------------------------------------------------------------------------

class FTP404(FakeFTP):
    """The fake FTP, answering 404 for a file it does not have."""

    def get(self, client, url, headers=None, **kw):
        if url not in self.files:
            self.requests.append(("get", url, dict(headers or {})))
            req = httpx.Request("GET", url)
            raise httpx.HTTPStatusError("404", request=req,
                                        response=httpx.Response(404, request=req))
        return super().get(client, url, headers=headers, **kw)


def test_refetch_missing_ignores_conditional_headers_and_existing_keys(tmp_path, monkeypatch):
    scene = Scene(tmp_path)
    ftp = FTP404()
    evac, ops, brief, gone = (_pdf("evac 0820"), _pdf("ops 0820"), _pdf("brief 0820"),
                              _pdf("gone 0820"))
    ftp_dir = ftp.dir(FTP_DIR.rsplit("/", 1)[0], "2026_Grasshopper")
    # the etag the FTP answers for these bytes: a conditional GET would get 304
    etag = '"' + hashlib.sha256(evac).hexdigest()[:12] + '"'
    for rel, data in ((EVAC, evac), ("products/20260820/Ops_0820.pdf", ops),
                      ("products/20260820/Brief_0820.pdf", b"%PDF brief 0820, revised")):
        ftp.file(ftp_dir, rel.replace("/", "_"), data)
    url = lambda rel: f"{ftp_dir}{rel.replace('/', '_')}"  # noqa: E731
    scene.file(GH_KEY, EVAC, evac, put=False, etag=etag, url=url(EVAC))
    # stamped under austin/, gone there; its new key holds other bytes
    scene.file(GH_KEY, "products/20260820/Ops_0820.pdf", ops, at="austin", put=False,
               url=url("products/20260820/Ops_0820.pdf"))
    scene.bucket.put_bytes("raw/incidents/grasshopper/products/20260820/Ops_0820.pdf",
                           b"%PDF another folder's bytes")
    scene.file(GH_KEY, "products/20260820/Brief_0820.pdf", brief, put=False,
               url=url("products/20260820/Brief_0820.pdf"))
    scene.file(GH_KEY, "products/20260820/Gone_0820.pdf", gone, put=False,
               url=f"{ftp_dir}Gone_0820.pdf")
    scene.manifest(GH_FK, GRASSHOPPER, [])
    scene.publish()
    _wire(monkeypatch, scene)
    monkeypatch.setattr(audit_keys, "get", ftp.get)

    # report mode never re-fetches
    out = tmp_path / "refused.json"
    assert cli.main(["audit-incident-keys", "--report", "--refetch-missing",
                     "--report-out", str(out)]) == 2
    assert ftp.requests == [] and scene.bucket.written == []

    report = _audit(tmp_path, "--repair", "--refetch-missing")
    # unconditional GETs, whatever the file's etag
    assert [(r[1], r[2]) for r in ftp.requests] == [
        (url(EVAC), {}), (url("products/20260820/Ops_0820.pdf"), {}),
        (url("products/20260820/Brief_0820.pdf"), {}), (f"{ftp_dir}Gone_0820.pdf", {})]
    ref = report["refetch"]
    assert [r["rel"] for r in ref["restored"]] == [EVAC]
    assert [r["rel"] for r in ref["key_occupied"]] == ["products/20260820/Ops_0820.pdf"]
    assert [r["rel"] for r in ref["revised_upstream"]] == ["products/20260820/Brief_0820.pdf"]
    assert [(r["rel"], r["reason"]) for r in ref["unrecoverable"]] == [
        ("products/20260820/Gone_0820.pdf", "FTP 404")]
    # one raw object written, to a key nothing was at; then state
    assert scene.bucket.written == [f"raw/incidents/grasshopper/{EVAC}", STATE_KEY]
    assert (scene.bucket.out_dir / f"raw/incidents/grasshopper/{EVAC}").read_bytes() == evac
    assert (scene.bucket.out_dir / "raw/incidents/grasshopper/products/20260820/Ops_0820.pdf"
            ).read_bytes() == b"%PDF another folder's bytes"
    files = scene.state_on_bucket()["incidents"][GH_KEY]["files"]
    assert "missing" not in files[EVAC] and "prefix" not in files[EVAC]
    ops_meta = files["products/20260820/Ops_0820.pdf"]
    assert ops_meta["prefix"] == "austin" and ops_meta["missing"] == NOW
    assert files["products/20260820/Brief_0820.pdf"]["sha16"] == sha16(brief)
