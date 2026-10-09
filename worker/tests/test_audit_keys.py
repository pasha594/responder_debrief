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
    AU_FK, AU_KEY, AU_SHEET, AUSTIN, GH_FK, GH_KEY, GH_SHEET, GRASSHOPPER, MT_FK, NOW, TWIN_MT,
    TWIN_WA, WA_FK, SpyStorage, api_fire, freeze_clock, sha16,
)
from responder_worker import audit_keys, cli, config, frames, geopdf, ir_vectors
from responder_worker.b2 import DryRunStorage
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
#: 2026_Austin's flat sheet (no tiles claimed) and one never previewed
AU_FLAT = "products/20260930/Transport_Austin_0930.pdf"
AU_NOPREV = "products/20260930/Div_Austin_0930.pdf"


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
    tiles under another prefix than stamped, failed and lost IR. Two sheets
    owe nothing: a flat one with no tiles anywhere and one whose preview
    was never rendered (their geo claims neither)."""
    s = Scene(tmp_path)
    s.file(GH_KEY, AU_TOKEN_SHEET, _pdf("airops 0817"), at="austin", fk=AU_FK, fk_src="token")
    own = s.file(GH_KEY, OWN_SHEET, _pdf("ops 1003"))
    # mirrored under austin/ while the folder showed on Austin; state never knew
    s.file(GH_KEY, GH_SHEET, _pdf("ops 0925"), put="austin")
    s.file(GH_KEY, EVAC, _pdf("evac 0820"), put=False)
    kmz = s.file(GH_KEY, IR_KMZ, b"PK kmz 0929")
    au = s.file(AU_KEY, AU_SHEET, _pdf("au ops 0930"))
    flat = s.file(AU_KEY, AU_FLAT, _pdf("au transport 0930"))
    noprev = s.file(AU_KEY, AU_NOPREV, _pdf("au div 0930"))
    s.tiled(flat, prefix="austin", preview_at=["austin"], grat_at="2026-10-01T00:00:00Z",
            geo={"georeferenced": False, "projection": None, "tiles": None, "preview": True})
    s.tiled(noprev, prefix="austin", tiles_at=["austin"],
            geo={"georeferenced": True, "projection": "UTM 10N", "tiles": TILES,
                 "preview": False})
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
    # (the flat sheet's tiles and the other's preview were never claimed)
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

    # ... and so does adopting a tile worker's finished marker
    state["tiled"][sha].update(needs_preview=True, tiler_version=None)
    scene.bucket.put_json(f"tiles/incidents/grasshopper/{sha}/meta.json", {
        "tiler_version": config.TILER_VERSION, "projection": "UTM 10N", "tiles": TILES})
    monkeypatch.setattr(geopdf, "process_pdf",
                        lambda *a, **k: pytest.fail("a finished marker is adopted"))
    cli._tile_backlog(scene.bucket, state, lambda *_: None)
    entry = state["tiled"][sha]
    assert (entry["tiler_version"], entry["geo"]["tiles"]) == (config.TILER_VERSION, TILES)
    assert entry["needs_preview"] is True


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
    # a sheet whose geo claims no tiles, or no preview, is owed neither
    for sha in (sha16(_pdf("au transport 0930")), sha16(_pdf("au div 0930"))):
        e = state["tiled"][sha]
        assert e["tiler_version"] == config.TILER_VERSION and "needs_preview" not in e
        assert sha not in report["repair"]["needs_preview"]
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


class FailingHead(SpyStorage):
    """The bucket as B2Storage.exists sees it when HEADs fail (a 403, a 5xx
    past botocore's retries): every key absent. exists_strict raises for
    the `failing` keys and answers truly for the rest."""

    def __init__(self, out_dir, failing=()):
        super().__init__(out_dir)
        self.failing = set(failing)

    def exists(self, key):
        return False

    def exists_strict(self, key):
        if key in self.failing:
            raise RuntimeError("HEAD 403 AccessDenied")
        return DryRunStorage.exists(self, key)


def test_refetch_never_writes_on_a_failed_head_or_over_another_records_file(tmp_path,
                                                                           monkeypatch):
    ops, brief, plan = ("products/20260820/Ops_0820.pdf", "products/20260820/Brief_0820.pdf",
                        "products/20260820/Plan_0820.pdf")
    evac_key = f"raw/incidents/grasshopper/{EVAC}"
    scene = Scene(tmp_path)
    scene.bucket = FailingHead(tmp_path / "bucket", failing=[evac_key])
    ftp = FTP404()
    ftp_dir = ftp.dir(FTP_DIR.rsplit("/", 1)[0], "2026_Grasshopper")
    data = {EVAC: _pdf("evac 0820"), ops: _pdf("ops 0820"), brief: _pdf("brief 0820"),
            plan: _pdf("plan 0820")}
    for rel, d in data.items():
        url = ftp.file(ftp_dir, rel.replace("/", "_"), d)
        scene.file(GH_KEY, rel, d, put=False, url=url, **({"at": "austin"} if rel == ops else {}))
    # Ops_0820's new key holds another folder's bytes, which the audit lists
    scene.bucket.put_bytes(f"raw/incidents/grasshopper/{ops}", b"%PDF another folder's bytes")
    # 2026_Austin's files stamped under grasshopper/ (a split prefix), gone
    # too: its brief has other bytes (that key is its file's), its plan the same
    scene.file(AU_KEY, brief, _pdf("au brief 0820"), at="grasshopper", put=False,
               url=f"{ftp_dir}AU_Brief_0820.pdf")
    scene.file(AU_KEY, plan, data[plan], at="grasshopper", put=False,
               url=f"{ftp_dir}AU_Plan_0820.pdf")
    scene.manifest(GH_FK, GRASSHOPPER, [])
    scene.manifest(AU_FK, AUSTIN, [])
    scene.publish()
    _wire(monkeypatch, scene)
    monkeypatch.setattr(audit_keys, "get", ftp.get)

    ref = _audit(tmp_path, "--repair", "--refetch-missing")["refetch"]
    # the HEAD on EVAC's key failed: an error, never a write
    assert [(r["rel"], r.get("raw_key")) for r in ref["errors"]] == [(EVAC, evac_key)]
    # listed by the audit, whatever the HEAD says
    assert [r["rel"] for r in ref["key_occupied"]] == [ops]
    # another record's file with other bytes is stamped at the brief's key
    assert [(r["rel"], [(h["key"], h["sha16"]) for h in r["holders"]])
            for r in ref["key_claimed"]] == [(brief, [(AU_KEY, sha16(_pdf("au brief 0820")))])]
    # the same bytes as the other record's file: writing makes both whole
    assert [r["rel"] for r in ref["restored"]] == [plan]
    assert [r["key"] for r in ref["unrecoverable"]] == [AU_KEY, AU_KEY]
    assert scene.bucket.written == [f"raw/incidents/grasshopper/{plan}", STATE_KEY]
    out = scene.bucket.out_dir / "raw/incidents/grasshopper"
    assert (out / ops).read_bytes() == b"%PDF another folder's bytes"
    assert not (out / EVAC).exists() and not (out / brief).exists()
    files = scene.state_on_bucket()["incidents"][GH_KEY]["files"]
    assert files[EVAC]["missing"] == NOW and files[brief]["missing"] == NOW
    assert files[ops]["missing"] == NOW and files[ops]["prefix"] == "austin"
    assert "missing" not in files[plan]


def test_refetch_restores_a_stamped_file_home_and_marks_its_fire(tmp_path, monkeypatch):
    rel = "products/20260820/Ops_0820.pdf"
    ops = _pdf("ops 0820")
    scene = Scene(tmp_path)
    ftp = FTP404()
    url = ftp.file(ftp.dir(FTP_DIR.rsplit("/", 1)[0], "2026_Grasshopper"), "Ops_0820.pdf", ops)
    # stamped under austin/ and gone there, marked by an earlier audit (so
    # this one marks nothing); its key under the folder's own prefix is free
    scene.file(GH_KEY, rel, ops, at="austin", put=False, url=url,
               missing="2026-10-09T01:00:00Z")
    # manifests that link nothing gone: only the restore can mark a fire
    scene.manifest(GH_FK, GRASSHOPPER, [])
    scene.manifest(AU_FK, AUSTIN, [])
    scene.publish()
    _wire(monkeypatch, scene)
    monkeypatch.setattr(audit_keys, "get", ftp.get)

    report = _audit(tmp_path, "--repair", "--refetch-missing")
    assert [r["raw_key"] for r in report["refetch"]["restored"]] == [
        f"raw/incidents/grasshopper/{rel}"]
    assert report["repair"]["missing_marked"] == []
    state = scene.state_on_bucket()
    rec = state["incidents"][GH_KEY]
    # home under the folder's own prefix: the stamp is gone with the mark
    assert "prefix" not in rec["files"][rel] and "missing" not in rec["files"][rel]
    assert raw_key(rec, rel) == f"raw/incidents/grasshopper/{rel}"
    assert (scene.bucket.out_dir / raw_key(rec, rel)).read_bytes() == ops
    # Grasshopper's manifest shows the file again: rebuilt by the next mirror run
    assert {fk: e["v"] for fk, e in state["incident_fires"].items()} == {GH_FK: 0, AU_FK: 1}


def test_preview_only_pass_renders_verified_bytes_only(tmp_path, monkeypatch, gdal):
    scene = _full(tmp_path)
    _wire(monkeypatch, scene)
    _audit(tmp_path, "--repair")
    sha, true = sha16(_pdf("ops 1003")), _pdf("ops 1003")
    own_key = f"raw/incidents/grasshopper/{OWN_SHEET}"
    preview = f"previews/incidents/grasshopper/{sha}.png"
    # the folder's own copy now holds other bytes of the same size; a
    # second holder of the sha has the right ones
    wrong = _pdf("ops 1004")
    assert len(wrong) == len(true)
    scene.bucket.put_bytes(own_key, wrong)
    state = scene.state_on_bucket()
    assert state["tiled"][sha]["needs_preview"] is True
    copy = "products/20261003/Ops_Grasshopper_1003_copy.pdf"
    state["incidents"][AU_KEY]["files"][copy] = dict(state["incidents"][GH_KEY]["files"][OWN_SHEET])
    scene.bucket.put_bytes(f"raw/incidents/austin/{copy}", true)
    scene.bucket.written.clear()
    mismatches: list[str] = []
    cli._probe_backlog(scene.bucket, state, lambda *_: None, mismatches=mismatches)
    assert mismatches == [own_key]
    assert true in gdal["render"] and wrong not in gdal["render"]
    assert preview in scene.bucket.written and "needs_preview" not in state["tiled"][sha]

    # the only copy is wrong: no render, no PUT, the flag stays
    (scene.bucket.out_dir / preview).unlink()
    state = scene.state_on_bucket()
    scene.bucket.written.clear()
    gdal["render"].clear()
    mismatches.clear()
    cli._probe_backlog(scene.bucket, state, lambda *_: None, mismatches=mismatches)
    assert mismatches == [own_key]
    assert true not in gdal["render"] and wrong not in gdal["render"]
    assert preview not in scene.bucket.written and state["tiled"][sha]["needs_preview"] is True

    # the right bytes, but the HEAD on the preview key fails: that is never
    # read as "no preview there"; the one there is kept, the flag stays
    scene.bucket.put_bytes(own_key, true)
    scene.bucket.put_bytes(preview, b"a preview written meanwhile")

    def head(key):
        if key == preview:
            raise RuntimeError("HEAD 503 SlowDown")
        return DryRunStorage.exists(scene.bucket, key)

    monkeypatch.setattr(scene.bucket, "exists", lambda key: False)
    monkeypatch.setattr(scene.bucket, "exists_strict", head)
    state = scene.state_on_bucket()
    scene.bucket.written.clear()
    gdal["render"].clear()
    cli._probe_backlog(scene.bucket, state, lambda *_: None)
    assert true not in gdal["render"] and preview not in scene.bucket.written
    assert (scene.bucket.out_dir / preview).read_bytes() == b"a preview written meanwhile"
    assert state["tiled"][sha]["needs_preview"] is True


def test_audit_failed_ir_sources(tmp_path, monkeypatch):
    v = ir_vectors.IR_CONVERTER_VERSION
    gone_kmz = "ir/20260930/20260930_Grasshopper_IR.kmz"
    scene = Scene(tmp_path)
    # the 09-29 KMZ's bytes are under austin/ (state says grasshopper/); the
    # 09-30 KMZ is nowhere
    moved = scene.file(GH_KEY, IR_KMZ, b"PK kmz 0929", put="austin")
    gone = scene.file(GH_KEY, gone_kmz, b"PK kmz 0930", put=False)
    stamped_moved = f"vectors/ir/grasshopper/{moved}.v{v}.geojson"
    stamped_gone = f"vectors/ir/grasshopper/{gone}.v{v}.geojson"
    scene.state["incidents"][GH_KEY]["ir_keys"] = {
        IR_KMZ: {"key": stamped_moved, "flight_id": "20260929_IR", "src_sha16": moved},
        gone_kmz: {"key": stamped_gone, "flight_id": "20260930_IR", "src_sha16": gone}}
    # failed slug-keyed conversions: no stamp names them (the migration
    # never kept a failed one), the build's own picks name their sources
    legacy_moved = "vectors/ir/grasshopper/20260929_IR.geojson"
    legacy_gone = "vectors/ir/grasshopper/20260930_IR.geojson"
    scene.state["ir"] = {k: {"v": v, "failed": True} for k in (
        stamped_moved, stamped_gone, legacy_moved, legacy_gone, FAILED_GONE)}
    scene.manifest(GH_FK, GRASSHOPPER, [])
    scene.manifest(AU_FK, AUSTIN, [])
    scene.publish()
    _wire(monkeypatch, scene)

    report = _audit(tmp_path, "--report")
    failed = {f["key"]: f for f in report["ir"]["failed"]}
    sources = {k: [(s["src"], s["via"], s["resolves"]) for s in f["sources"]]
               for k, f in failed.items()}
    assert sources == {
        stamped_moved: [(IR_KMZ, "ir_keys", True)],      # relocated, hash-verified
        stamped_gone: [(gone_kmz, "ir_keys", False)],
        legacy_moved: [(IR_KMZ, "legacy", True)],
        legacy_gone: [(gone_kmz, "legacy", False)],
        FAILED_GONE: [],                                  # no folder was ever shown there
    }
    assert sorted(report["ir"]["failed_source_resolves"]) == sorted([stamped_moved, legacy_moved])


def test_audit_repair_rebuilds_broken_manifests(tmp_path, monkeypatch):
    scene = Scene(tmp_path)
    scene.file(GH_KEY, OWN_SHEET, _pdf("ops 1003"))
    scene.file(AU_KEY, AU_SHEET, _pdf("au ops 0930"))
    # Grasshopper's manifest is gone; Austin's names Grasshopper; Twin
    # Sisters MT's links a sheet that is gone; Twin Sisters WA's is garbage
    scene.manifest(GH_FK, GRASSHOPPER, [f"/raw/incidents/grasshopper/{OWN_SHEET}"])
    (scene.bucket.out_dir / manifest_key(GH_FK)).unlink()
    scene.manifest(AU_FK, GRASSHOPPER, [f"/raw/incidents/austin/{AU_SHEET}"])
    scene.state["incident_fires"][AU_FK]["cornea_id"] = AUSTIN["cornea_id"]
    dead = "/raw/incidents/twin-sisters/products/20260805/ops_twin_sisters_0805.pdf"
    scene.manifest(MT_FK, TWIN_MT, [dead])
    scene.manifest(WA_FK, TWIN_WA, [])
    scene.bucket.put_bytes(manifest_key(WA_FK), b"{not json")
    scene.publish()
    _wire(monkeypatch, scene)

    report = _audit(tmp_path, "--repair")
    problems = {p["fk"]: p["problem"] for p in report["manifests"]["problems"]}
    assert problems.keys() == {GH_FK, AU_FK, WA_FK}
    assert problems[AU_FK] == f"cornea_id {GRASSHOPPER['cornea_id']}"
    assert report["manifests"]["missing_urls"] == [{"fk": MT_FK, "url": dead}]
    # state needed nothing else; every broken manifest is rebuilt anyway
    fix = report["repair"]
    assert (fix["raw_stamped"], fix["missing_marked"], fix["shas_stamped"]) == (0, [], 0)
    assert fix["marked_stale"] == sorted([GH_FK, AU_FK, MT_FK, WA_FK])
    assert {e["v"] for e in scene.state_on_bucket()["incident_fires"].values()} == {0}


def test_audit_reports_shared_keys_slug_drift_and_sizes(tmp_path, monkeypatch):
    brief = "products/20260925/Briefing_0925.pdf"
    au_bytes, gh_bytes = _pdf("au briefing 0925"), _pdf("gh briefing 0925, longer")
    scene = Scene(tmp_path)
    scene.file(AU_KEY, brief, au_bytes)
    # 2026_Grasshopper's own brief of that name, stamped to the same key
    # with other bytes: a conflict, and a size mismatch for its file
    scene.file(GH_KEY, brief, gh_bytes, at="austin", put=False)
    # 2026_Austin's slug, changed by older code
    scene.state["incidents"][AU_KEY]["fire_slug"] = "austin-or"
    # a file an earlier audit marked missing, whose bytes are back
    scene.file(GH_KEY, OWN_SHEET, _pdf("ops 1003"), missing="2026-10-09T01:00:00Z")
    # a sha no stamp places, its tiles under two prefixes no holder uses:
    # the one the live manifest links wins over the first alphabetically
    sha = scene.file(GH_KEY, GH_SHEET, _pdf("ops 0925"))
    scene.tiled(sha, tiles_at=["bobcat-lakes", "sand-creek"], preview_at=["sand-creek"])
    scene.manifest(GH_FK, GRASSHOPPER, [])
    tiles_url = f"/tiles/incidents/sand-creek/{sha}/{{z}}/{{x}}/{{y}}.png"
    scene.bucket.put_json(manifest_key(GH_FK), {
        "schema_version": 1, "cornea_id": GRASSHOPPER["cornea_id"], "fire_key": GH_FK,
        "maps": [{"id": "x", "pdf_url": f"/raw/incidents/grasshopper/{GH_SHEET}",
                  "tiles": {"url_template": tiles_url},
                  "preview_url": f"/previews/incidents/sand-creek/{sha}.png"}],
        "ir_flights": []})
    scene.manifest(AU_FK, AUSTIN, [f"/raw/incidents/austin/{brief}"])
    scene.publish()
    _wire(monkeypatch, scene)

    report = _audit(tmp_path, "--report")
    at = f"raw/incidents/austin/{brief}"
    assert report["shared_rel_conflicts"] == [{"raw_key": at, "holders": [
        {"key": GH_KEY, "rel": brief, "size": len(gh_bytes), "sha16": sha16(gh_bytes)},
        {"key": AU_KEY, "rel": brief, "size": len(au_bytes), "sha16": sha16(au_bytes)}]}]
    assert report["raw_size_mismatch"] == [{"key": GH_KEY, "rel": brief, "at": at,
                                            "size": len(au_bytes), "expected": len(gh_bytes)}]
    assert report["slug_drift"] == [{"key": AU_KEY, "fire_slug": "austin-or",
                                     "storage_prefix": "austin"}]
    assert report["manifests"]["problems"] == [] and report["manifests"]["missing_urls"] == []
    assert report["shas"]["unstamped"]["tiles"]["relocated"] == {"sand-creek": 1}

    report = _audit(tmp_path, "--repair")
    state = scene.state_on_bucket()
    assert state["tiled"][sha]["prefix"] == "sand-creek"
    assert "preview_prefix" not in state["tiled"][sha]
    assert report["repair"]["missing_cleared"] == [{"key": GH_KEY, "rel": OWN_SHEET}]
    assert "missing" not in state["incidents"][GH_KEY]["files"][OWN_SHEET]
    # reported only: a shared key, a drifted slug and a size are left as they are
    assert state["incidents"][AU_KEY]["fire_slug"] == "austin-or"
    assert state["incidents"][GH_KEY]["files"][brief]["prefix"] == "austin"
    assert "missing" not in state["incidents"][GH_KEY]["files"][brief]
