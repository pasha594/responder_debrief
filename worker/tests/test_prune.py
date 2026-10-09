"""prune (Phase 4), by fire key: report by default; --days N --confirm from
the CLI only, after both migration flags, on a sane active-fire list. A
file is doomed when the fire it shows on has been inactive past the cutoff
by sync-catalogs' clock and its own folder's newest upload and last sync
are older too. Exact keys only; nothing a surviving file needs; unresolved
folders and files shown on no fire are never touched; doomed files are
marked pruned_at and every later job skips them.

Austin's fire left the active list on 2026-09-01 (its 2026_Austin folder
last received a sheet in August); Grasshopper is active, and its folder
still holds sheets under austin/ from when it showed on Austin."""

import contextlib
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from incident_world import (
    AU_FK, AU_KEY, AUSTIN, CHERRY_KEY, GH_FK, GH_KEY, GH_SHEET, GRASSHOPPER,
    api_fire, sha16,
)
from responder_worker import asset_keys, cli, config, frames, geopdf, incident_ids, prune
from responder_worker.b2 import DryRunStorage
from responder_worker.fire_manifests import manifest_key
from responder_worker.state import STATE_KEY

FLAG = "2026-10-08T21:53:17Z"
NOW = datetime(2026, 10, 9, 2, 0, tzinfo=timezone.utc)
NOW_ISO = "2026-10-09T02:00:00Z"
OLD_LM = "Sat, 15 Aug 2026 05:00:00 GMT"
NEW_LM = "Thu, 08 Oct 2026 05:00:00 GMT"
OLD_SYNC = "2026-09-01T00:00:00Z"
NEW_SYNC = "2026-10-09T01:00:00Z"
TILES = {"minzoom": 8, "maxzoom": 8, "bounds": [-122, 44, -121, 45]}

AU_OPS = "products/20260815/Ops_Austin_0815.pdf"
SHARED = "products/20260815/Briefing_Austin_0815.pdf"   # also published in 2026_Grasshopper
AU_KMZ = "ir/20260814/20260814_Austin_IR.kmz"
AU_IR_PDF = "ir/20260814/20260814_Austin_IR_11x17_Topo.pdf"
LEGACY_KMZ = "ir/20260810/20260810_Austin_IR.kmz"
LEGACY_PDF = "ir/20260810/20260810_Austin_IR_Topo.pdf"
LEGACY_IR = "vectors/ir/austin/20260810_IR_Topo.geojson"
GH_OWN = "products/20261003/Ops_Grasshopper_1003.pdf"


def _pdf(name: str) -> bytes:
    return f"%PDF {name}".encode()


class Bucket(DryRunStorage):
    """The bucket: exact-key deletes recorded, prefix deletes refused."""

    def __init__(self, out_dir):
        super().__init__(out_dir)
        self.deleted: list[str] = []

    def delete_prefix(self, prefix):
        raise AssertionError(f"delete_prefix({prefix!r}): prune deletes exact keys only")

    def delete_keys(self, keys):
        keys = list(keys)
        self.deleted += keys
        return super().delete_keys(keys)


class Scene:
    def __init__(self, tmp_path):
        self.bucket = Bucket(tmp_path / "bucket")
        self.state = {
            "schema_version": 1, "updated_at": NEW_SYNC, "incidents": {}, "tiled": {}, "ir": {},
            "incident_fires": {},
            "migrations": {"incident_ids": FLAG, "incident_keys_audit": "2026-10-09T00:00:00Z",
                           "slugs_at_migration": {}},
            "prune": {"inactive_since": {},
                      "inactive_since_by_id": {AU_FK: OLD_SYNC},
                      "last_seen_active": {AU_FK: "2026-08-31T23:07:00Z", GH_FK: NEW_SYNC}},
        }
        self.fires = [api_fire(GRASSHOPPER, "grasshopper")]   # Austin is not active
        self.raw_rows = None
        self.prev_active = None

    def record(self, key, fire, prefix, *, synced=OLD_SYNC, **extra) -> dict:
        rec = {"fire_slug": prefix, "storage_prefix": prefix,
               "cornea_id": fire["cornea_id"] if fire else None,
               "match": {"method": "unit_id", "token": fire["unique_fire_id"]} if fire else None,
               "bound": incident_ids.bound_info(fire, "unit_id") if fire else None,
               "synced_at": synced, "dir_mtime": "2026-08-15 05:00", "children": {},
               "files": {}, **extra}
        self.state["incidents"][key] = rec
        return rec

    def file(self, key, rel, data: bytes, *, at=None, lm=OLD_LM, **meta) -> str:
        rec = self.state["incidents"][key]
        entry = {"lm": lm, "size": len(data), "sha16": sha16(data), "rev": 1,
                 "kind": "ir" if rel.startswith("ir/") else "product", **meta}
        if at:
            entry["prefix"] = at
        rec["files"][rel] = entry
        self.bucket.put_bytes(f"raw/incidents/{at or rec['storage_prefix']}/{rel}", data)
        return entry["sha16"]

    def tiled(self, sha, prefix, *, tiles=True, **entry):
        self.state["tiled"][sha] = {"tiler_version": config.TILER_VERSION, "at": OLD_SYNC,
                                    "prefix": prefix, **entry,
                                    "geo": {"georeferenced": tiles, "projection": "UTM",
                                            "tiles": TILES if tiles else None, "preview": True}}
        if tiles:
            self.bucket.put_bytes(f"tiles/incidents/{prefix}/{sha}/meta.json", b"{}")
            self.bucket.put_bytes(f"tiles/incidents/{prefix}/{sha}/8/1/2.png", b"png")
        self.bucket.put_bytes(f"previews/incidents/{prefix}/{sha}.png", b"png")

    def index(self, fk, fire, keys):
        self.state["incident_fires"][fk] = {"v": 1, "cornea_id": fire["cornea_id"],
                                            "manifest": manifest_key(fk), "dirs": keys}
        self.bucket.put_json(manifest_key(fk), {"cornea_id": fire["cornea_id"], "maps": []})

    def publish(self) -> "Scene":
        self.bucket.put_json(STATE_KEY, self.state)
        self.bucket.put_json("catalogs/catalog.json", {
            "fires": [], "counts": {"active_fires": self.prev_active or len(self.fires)}})
        self.bucket.written.clear()
        return self

    def fetch_fires(self, meta=None):
        if meta is not None:
            meta["raw_rows"] = self.raw_rows if self.raw_rows is not None else len(self.fires)
        return [dict(f) for f in self.fires]

    def run(self, tmp_path, *, days=14, confirm=False) -> tuple[int, dict]:
        out = tmp_path / f"prune{len(list(tmp_path.glob('prune*.json')))}.json"
        code = prune.run(self.bucket, fetch_fires=self.fetch_fires, days=days, confirm=confirm,
                         report_out=out, log=lambda *_: None, now=NOW)
        return code, json.loads(out.read_text())

    def state_on_bucket(self) -> dict:
        return json.loads((self.bucket.out_dir / STATE_KEY).read_text())

    def keys(self) -> set[str]:
        return {k for k, _s in self.bucket.list_keys("")}


def _austin_and_grasshopper(tmp_path) -> Scene:
    """2026_Austin (all August, last synced 09-01) with a tiled sheet, a
    sheet 2026_Grasshopper also published, a stamped IR flight and a legacy
    one; 2026_Grasshopper active, with a sheet still under austin/."""
    s = Scene(tmp_path)
    s.record(AU_KEY, AUSTIN, "austin")
    s.state["migrations"]["slugs_at_migration"] = {AU_KEY: "austin", GH_KEY: "grasshopper"}
    ops = s.file(AU_KEY, AU_OPS, _pdf("au ops 0815"))
    shared = s.file(AU_KEY, SHARED, _pdf("briefing 0815"))
    kmz = s.file(AU_KEY, AU_KMZ, b"PK austin 0814")
    s.file(AU_KEY, AU_IR_PDF, _pdf("au ir 0814"))
    s.file(AU_KEY, LEGACY_KMZ, b"PK austin 0810")
    s.file(AU_KEY, LEGACY_PDF, _pdf("au ir 0810"))
    s.tiled(ops, "austin")
    s.tiled(shared, "austin")
    s.tiled(sha16(_pdf("au ir 0814")), "austin", tiles=False)
    ir_key = f"vectors/ir/austin/{kmz}.v3.geojson"
    s.state["incidents"][AU_KEY]["ir_keys"] = {
        AU_KMZ: {"key": ir_key, "flight_id": "20260814_IR", "src_sha16": kmz}}
    s.state["ir"] = {ir_key: {"v": 3, "heat_types": ["Perimeter"]},
                     LEGACY_IR: {"v": 3, "heat_types": ["Perimeter"]}}
    for key in (ir_key, LEGACY_IR):
        s.bucket.put_json(key, {"type": "FeatureCollection", "features": []})
    s.index(AU_FK, AUSTIN, [AU_KEY])
    s.bucket.put_json("catalogs/incidents/austin.json",
                      {"cornea_id": AUSTIN["cornea_id"], "maps": []})

    s.record(GH_KEY, GRASSHOPPER, "grasshopper", synced=NEW_SYNC)
    s.file(GH_KEY, GH_OWN, _pdf("gh ops 1003"), lm=NEW_LM)
    s.file(GH_KEY, SHARED, _pdf("briefing 0815"))           # the same sheet, its own copy
    s.file(GH_KEY, GH_SHEET, _pdf("gh ops 0925"), at="austin")
    s.index(GH_FK, GRASSHOPPER, [GH_KEY])
    return s


# ---------------------------------------------------------------------------
# refusals
# ---------------------------------------------------------------------------

def _no_api(*a, **k):
    raise AssertionError("a refused prune must not reach the fire API")


def test_prune_refuses_without_both_flags_or_on_short_fire_list(tmp_path, monkeypatch):
    scene = _austin_and_grasshopper(tmp_path).publish()
    keys = scene.keys()
    monkeypatch.setattr(cli, "make_storage", lambda dry_run, out: scene.bucket)
    monkeypatch.setattr(cli, "make_client", _no_api)
    out = tmp_path / "r.json"

    def refused(*argv) -> str:
        assert cli.main(["prune", *argv, "--report-out", str(out)]) == 2
        assert scene.bucket.deleted == [] and scene.bucket.written == []
        assert scene.keys() == keys
        return json.loads(out.read_text())["error"]

    assert "BOTH --days N and --confirm" in refused("--confirm")
    assert "at least one day" in refused("--days", "0", "--confirm")
    assert "pick one" in refused("--report", "--days", "14", "--confirm")
    for migrations, why in (({}, "not keyed by fire ID"),
                            ({"incident_ids": FLAG}, "audit-incident-keys --repair")):
        scene.state["migrations"] = migrations
        scene.publish()
        assert why in refused("--days", "14", "--confirm")

    # both flags, but the active-fire list may be partial: a fire missing
    # from it proves nothing
    scene.state["migrations"] = {"incident_ids": FLAG, "incident_keys_audit": FLAG}
    for raw_rows, prev_active in ((500, None), (1, 262)):
        scene.raw_rows, scene.prev_active = raw_rows, prev_active
        scene.publish()
        code, report = scene.run(tmp_path, confirm=True)
        assert code == 2 and "active-fire list" in report["error"]
        assert scene.bucket.deleted == [] and scene.bucket.written == []
        # a report says so, and still deletes nothing
        code, report = scene.run(tmp_path)
        assert code == 0 and report["would_refuse"] and report["deleted"] == []
        assert scene.bucket.deleted == [] and scene.keys() == keys


def test_prune_requires_own_upload_older_than_cutoff(tmp_path):
    scene = Scene(tmp_path)
    # three folders shown on Austin, inactive since 09-01
    scene.record(AU_KEY, AUSTIN, "austin")
    scene.file(AU_KEY, AU_OPS, _pdf("au ops 0815"))
    # a GISS template file uploaded last week is not an upload of the fire's
    scene.file(AU_KEY, "products/yymmdd/Template.pdf", _pdf("template"), lm=NEW_LM)
    recent = scene.record("pacific_nw/2026/2026_AustinComplex", AUSTIN, "austin-c7e2a1")
    scene.file("pacific_nw/2026/2026_AustinComplex", "products/20261006/Ops_1006.pdf",
               _pdf("ops 1006"), lm="Tue, 06 Oct 2026 04:00:00 GMT")
    scene.record("pacific_nw/2026/2026_AustinRehab", AUSTIN, "austin-9b10f3", synced=NEW_SYNC)
    scene.file("pacific_nw/2026/2026_AustinRehab", "products/20260815/Rehab.pdf",
               _pdf("rehab 0815"))
    scene.publish()

    code, report = scene.run(tmp_path, days=14)
    assert code == 0 and report["fires"] == [AU_FK]
    # only the folder whose own uploads and last sync are both old
    assert report["files"] == {AU_KEY: 2}
    assert report["delete"]["raw"] == [f"raw/incidents/austin/{AU_OPS}",
                                       "raw/incidents/austin/products/yymmdd/Template.pdf"]
    assert recent["files"]  # untouched

    # the fire's clock must be past the cutoff too, and the fire not active
    code, report = scene.run(tmp_path, days=40)
    assert report["fires"] == [] and report["files"] == {}
    scene.fires.append(api_fire(AUSTIN, "austin"))
    scene.state["prune"]["inactive_since_by_id"][AU_FK] = "2026-08-01T00:00:00Z"
    scene.publish()
    code, report = scene.run(tmp_path, days=14)
    assert report["fires"] == [] and report["delete"]["raw"] == []


# ---------------------------------------------------------------------------
# what goes and what stays
# ---------------------------------------------------------------------------

def test_prune_keeps_shared_prefix_and_survivor_shas(tmp_path):
    scene = _austin_and_grasshopper(tmp_path).publish()
    ops, shared = sha16(_pdf("au ops 0815")), sha16(_pdf("briefing 0815"))
    code, report = scene.run(tmp_path, confirm=True)
    assert code == 0
    keys = scene.keys()
    # Austin's own raw keys go; 2026_Grasshopper's sheet under the same
    # austin/ prefix stays, and so does its copy of the shared sheet
    assert f"raw/incidents/austin/{AU_OPS}" not in keys
    assert f"raw/incidents/austin/{SHARED}" not in keys
    assert f"raw/incidents/austin/{GH_SHEET}" in keys
    assert f"raw/incidents/grasshopper/{SHARED}" in keys
    # a sha a surviving file holds keeps its tiles, preview and state entry
    assert f"tiles/incidents/austin/{shared}/8/1/2.png" in keys
    assert f"previews/incidents/austin/{shared}.png" in keys
    assert f"tiles/incidents/austin/{ops}/8/1/2.png" not in keys
    state = scene.state_on_bucket()
    assert shared in state["tiled"] and ops not in state["tiled"]
    # the IR conversions only the doomed flights used
    assert not any(k.startswith("vectors/") for k in keys)
    assert state["ir"] == {}
    # Austin has nothing left: its manifests and index entry go; Grasshopper's stay
    assert manifest_key(AU_FK) not in keys and manifest_key(GH_FK) in keys
    assert set(state["incident_fires"]) == {GH_FK}
    assert state["incidents"].keys() == {GH_KEY}   # 2026_Austin held only doomed files
    assert report["records_removed"] == [AU_KEY]


def test_prune_never_touches_unresolved_or_null_owner_files(tmp_path):
    scene = _austin_and_grasshopper(tmp_path)
    # a hidden file of 2026_Austin (shown on no fire), and an unresolved
    # folder whose candidate was Austin
    scene.file(AU_KEY, "products/20260815/Ops_TheNarrows_0815.pdf", _pdf("narrows"),
               fk=None, fk_src="hidden")
    scene.record(CHERRY_KEY, None, "cherry",
                 id_unresolved={"reason": "uncorroborated", "candidate": AUSTIN["cornea_id"]})
    scene.file(CHERRY_KEY, "products/20260705/ops_Cherry_0705.pdf", _pdf("cherry"))
    scene.publish()
    code, report = scene.run(tmp_path, confirm=True)
    assert code == 0
    keys = scene.keys()
    assert "raw/incidents/austin/products/20260815/Ops_TheNarrows_0815.pdf" in keys
    assert "raw/incidents/cherry/products/20260705/ops_Cherry_0705.pdf" in keys
    state = scene.state_on_bucket()
    au = state["incidents"][AU_KEY]   # it keeps a file, so it stays
    assert "pruned_at" not in au["files"]["products/20260815/Ops_TheNarrows_0815.pdf"]
    assert au["files"][AU_OPS]["pruned_at"] == NOW_ISO
    assert "pruned_at" not in json.dumps(state["incidents"][CHERRY_KEY])
    # 2026_Austin is still bound to Austin: its index entry is kept, stale
    assert state["incident_fires"][AU_FK]["v"] == 0
    assert manifest_key(AU_FK) in keys and "catalogs/incidents/austin.json" in keys
    assert report["records_removed"] == []


def test_prune_marks_pruned_at_and_backlogs_skip(tmp_path, monkeypatch):
    scene = _austin_and_grasshopper(tmp_path)
    # 2026_Austin keeps a file shown on no fire, so it stays in state; the
    # 0815 sheet is also in an unresolved folder, so its sha stays, still
    # owed tiles
    scene.file(AU_KEY, "products/20260815/Hidden.pdf", _pdf("hidden"), fk=None,
               fk_src="hidden")
    scene.record(CHERRY_KEY, None, "cherry", id_unresolved={"reason": "date"})
    scene.file(CHERRY_KEY, "products/x.pdf", _pdf("au ops 0815"))
    ops = sha16(_pdf("au ops 0815"))
    scene.state["tiled"][ops]["tiler_version"] = None
    scene.publish()
    assert scene.run(tmp_path, confirm=True)[0] == 0

    state = scene.state_on_bucket()
    au = state["incidents"][AU_KEY]
    doomed = (AU_OPS, SHARED, AU_KMZ, AU_IR_PDF, LEGACY_KMZ, LEGACY_PDF)
    # every doomed file is marked, its entry kept
    assert {rel: au["files"][rel].get("pruned_at") for rel in doomed} == dict.fromkeys(
        doomed, NOW_ISO)
    assert "ir_keys" not in au or au["ir_keys"] == {}
    # and from here on shows nowhere, is no copy of its bytes, is never tiled
    assert [rel for rel, m in au["files"].items() if incident_ids.file_owner(au, m)] == []
    assert state["tiled"][ops]["tiler_version"] is None
    assert asset_keys.raw_key_candidates(state, ops) == ["raw/incidents/cherry/products/x.pdf"]
    assert cli._pending_sheets(state) == []   # the other copy shows on no fire

    fetched: list[str] = []
    real_get_file = scene.bucket.get_file
    monkeypatch.setattr(scene.bucket, "get_file",
                        lambda key, dest: fetched.append(key) or real_get_file(key, dest))
    monkeypatch.setattr(geopdf, "gdal_available", lambda: True)
    monkeypatch.setattr(geopdf, "probe_pdf", lambda pdf: {"georeferenced": False})
    monkeypatch.setattr(geopdf, "render_preview",
                        lambda pdf, out, **kw: Path(out).write_bytes(b"png"))
    monkeypatch.setattr(geopdf, "process_pdf", lambda *a, **k: pytest.fail("nothing to tile"))
    frames.start_deadline(0)  # disarmed
    cli._probe_backlog(scene.bucket, state, lambda *_: None)
    cli._tile_backlog(scene.bucket, state, lambda *_: None)
    assert fetched  # the backlogs ran (Grasshopper's unprobed sheets)
    assert not set(fetched) & {f"raw/incidents/austin/{rel}" for rel in doomed}

    # run again: nothing more is doomed or deleted
    scene.bucket.deleted.clear()
    code, report = scene.run(tmp_path, confirm=True)
    assert code == 0 and report["files"] == {} and scene.bucket.deleted == []


def test_prune_deletes_exact_keys_only(tmp_path):
    scene = _austin_and_grasshopper(tmp_path)
    # another sheet's tiles under the same austin/ prefix, held by a survivor
    other = scene.file(GH_KEY, "products/20260925/Briefing_0925.pdf", _pdf("gh brief 0925"),
                       at="austin")
    scene.tiled(other, "austin")
    scene.publish()
    ops, ir_pdf = sha16(_pdf("au ops 0815")), sha16(_pdf("au ir 0814"))
    kmz = sha16(b"PK austin 0814")
    expected = sorted([
        manifest_key(AU_FK), "catalogs/incidents/austin.json",
        f"vectors/ir/austin/{kmz}.v3.geojson", LEGACY_IR,
        f"previews/incidents/austin/{ops}.png", f"previews/incidents/austin/{ir_pdf}.png",
        f"tiles/incidents/austin/{ops}/8/1/2.png", f"tiles/incidents/austin/{ops}/meta.json",
        *(f"raw/incidents/austin/{rel}" for rel in
          (AU_OPS, SHARED, AU_KMZ, AU_IR_PDF, LEGACY_KMZ, LEGACY_PDF)),
    ])

    # the report lists exactly what --confirm deletes, with byte totals
    before = scene.keys()
    code, report = scene.run(tmp_path)
    assert code == 0 and scene.bucket.deleted == [] and scene.keys() == before
    listed = [k for kind in ("raw", "previews", "vectors", "manifests", "legacy_manifests")
              for k in report["delete"][kind]]
    assert [t["root"] for t in report["delete"]["tiles"]] == [f"tiles/incidents/austin/{ops}"]
    assert report["keys"] == len(expected)
    assert sorted(listed + [f"tiles/incidents/austin/{ops}/8/1/2.png",
                            f"tiles/incidents/austin/{ops}/meta.json"]) == expected
    sizes = {k: s for k, s in scene.bucket.list_keys("")}
    assert report["bytes"]["total"] == sum(sizes[k] for k in expected)

    code, report = scene.run(tmp_path, confirm=True)
    assert code == 0
    assert sorted(scene.bucket.deleted) == expected      # never a prefix (Bucket refuses)
    assert scene.keys() == before - set(expected) | {STATE_KEY}
    assert f"tiles/incidents/austin/{other}/8/1/2.png" in scene.keys()
    assert scene.bucket.written == [STATE_KEY]


def test_prune_legacy_manifest_only_when_cornea_matches(tmp_path):
    scene = _austin_and_grasshopper(tmp_path)
    # 2026_Austin was shown under an older slug that now names another fire
    scene.state["migrations"]["slugs_at_migration"][AU_KEY] = "austin-or"
    scene.bucket.put_json("catalogs/incidents/austin-or.json",
                          {"cornea_id": GRASSHOPPER["cornea_id"], "maps": []})
    scene.publish()
    code, report = scene.run(tmp_path, confirm=True)
    assert code == 0
    assert report["delete"]["legacy_manifests"] == ["catalogs/incidents/austin.json"]
    keys = scene.keys()
    assert "catalogs/incidents/austin.json" not in keys
    assert "catalogs/incidents/austin-or.json" in keys
    assert "catalogs/incidents/austin-or.json" not in scene.bucket.deleted


@pytest.mark.parametrize("argv", [["prune"], ["prune", "--report", "--days", "14"]])
def test_prune_report_is_the_default(tmp_path, monkeypatch, argv):
    scene = _austin_and_grasshopper(tmp_path).publish()
    monkeypatch.setattr(cli, "make_storage", lambda dry_run, out: scene.bucket)
    monkeypatch.setattr(cli, "make_client", lambda: contextlib.nullcontext(None))
    monkeypatch.setattr(cli, "fetch_active_fires",
                        lambda client, meta=None: scene.fetch_fires(meta))
    out = tmp_path / "r.json"
    assert cli.main([*argv, "--report-out", str(out)]) == 0
    report = json.loads(out.read_text())
    assert scene.bucket.deleted == [] and scene.bucket.written == []
    assert report["mode"] == "report" and report["deleted"] == []
    assert [c["fk"] for c in report["clock"]] == [AU_FK]
    if "--days" in argv:
        assert report["fires"] == [AU_FK] and report["keys"] > 0
    else:
        assert "fires" not in report
