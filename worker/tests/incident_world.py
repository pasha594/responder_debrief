"""A small bucket for the incident-ID migration tests, modelled on the real
records (state snapshot 2026-10-08, catalog 844):

- 2026_Grasshopper, first bound to Austin by token (its early sheets and
  the 08-17 IR flight still under austin/), now bound to Grasshopper;
- 2026_Austin, Austin's own folder;
- the two TwinSisters folders (MT by token, WA by name) sharing the
  twin-sisters slug, WA first;
- 2026_Cherry, a name match to a Cherry created weeks after its last sheet.

Catalog versions 6..40 are hourly from 2026-10-01T00:00Z: until v25 the
austin slug showed the Grasshopper folder, from v26 each folder shows on its
own fire; twin-sisters showed WA until v12 and MT after.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
from datetime import datetime, timedelta, timezone

from responder_worker import catalogs as cat, cli, health, ir_vectors, mirror, state as state_mod
from responder_worker.b2 import DryRunStorage
from responder_worker.fires import fire_key
from responder_worker.state import STATE_KEY

NOW = "2026-10-09T02:00:00Z"
FTP = "https://ftp.wildfire.gov/public/incident_specific_maps"
LATEST = 40
_BASE = datetime(2026, 10, 1, tzinfo=timezone.utc)

AUSTIN = {"cornea_id": "{49D1FB0B-74D1-4A95-B8DF-066DCC5F06E1}", "post_title": "AUSTIN",
          "unique_fire_id": "2026-ORMHF-000863", "state": "OR",
          "created_on": "2026-08-09T18:30:24Z"}
GRASSHOPPER = {"cornea_id": "{6AA4C355-AD18-472F-AAAB-78BAA9DE31B1}", "post_title": "GRASSHOPPER",
               "unique_fire_id": "2026-ORMHF-000688", "state": "OR",
               "created_on": "2026-07-24T03:39:58Z"}
TWIN_MT = {"cornea_id": "{BD729423-8D4D-4FA3-BB9A-B738F6C71B88}", "post_title": "Twin Sisters",
           "unique_fire_id": "2026-MTHLF-000497", "state": "MT", "created_on": "2026-07-20T00:00:00Z"}
TWIN_WA = {"cornea_id": "{40432B79-397F-4C30-8667-2DCE4A76A6FE}", "post_title": "TWIN SISTERS",
           "unique_fire_id": "2026-WAWFS-260222", "state": "WA", "created_on": "2026-06-10T00:00:00Z"}
CHERRY_ID = {"cornea_id": "{4ED33892-8440-4997-A22B-DA0D36632ED1}", "post_title": "Cherry",
             "unique_fire_id": "2026-IDLEX-260156", "state": "ID",
             "created_on": "2026-08-27T21:23:44Z"}
BOBCAT_LAKES = {"cornea_id": "{801A448C-B5B4-4DCC-BAE2-CEF8FEDBB2A6}", "post_title": "Bobcat Lakes",
                "unique_fire_id": "2026-MTBDF-266313", "state": "MT"}
SAND_CREEK = {"cornea_id": "{84FD3D7E-6B04-49CD-A729-ED3178A49C42}", "post_title": "Sand Creek",
              "unique_fire_id": "2026-MTBDF-266319", "state": "MT"}

GH_KEY = "pacific_nw/2026/2026_Grasshopper"
AU_KEY = "pacific_nw/2026/2026_Austin"
MT_KEY = "n_rockies/2026/2026_TwinSisters"
WA_KEY = "pacific_nw/2026/2026_TwinSisters"
CHERRY_KEY = "great_basin/2026/2026_Cherry"

GH_FK, AU_FK = fire_key(GRASSHOPPER["cornea_id"]), fire_key(AUSTIN["cornea_id"])
MT_FK, WA_FK = fire_key(TWIN_MT["cornea_id"]), fire_key(TWIN_WA["cornea_id"])

#: 2026_Grasshopper's files mirrored while it showed on Austin (under austin/)
GH_AT_AUSTIN = [
    "products/20260817/Ops_ArchE_port_20260816_2155_Austin_ORMHF000863_0817_Day.pdf",
    "products/20260925/Ops_ArchE_Land_20260924_2037_Grasshopper_ORMHF000688_0925_Day.pdf",
    "products/20260820/Ops_Austin_0820.pdf",
    "ir/20260817/20260817_Austin_IR_11x17_Topo.pdf",
    "ir/20260817/20260817_Grasshopper_IR.kmz",
    "ir/20260817/20260817_Grasshopper_IR_11x17_Topo.pdf",
    "ir/20260817/20260817_Mitchell_IR_11x17_Topo.pdf",
]
#: ... and since (under grasshopper/)
GH_OWN = [
    "products/20261003/Ops_Grasshopper_1003.pdf",
    "products/20260925/Briefing_Austin_ArchE_Land_20260924_2023_Austin_ORMHF000863_0925_Day.pdf",
    "ir/20260929/20260929_Austin_IR.kmz",
    "ir/20260929/20260929_Austin_IR_11x17_Aerial.pdf",
    "ir/20260929/20260929_Grasshopper_IR.kmz",
    "ir/20260929/20260929_Grasshopper_IR_11x17_Aerial.pdf",
]
GH_SHEET = GH_AT_AUSTIN[1]
AU_SHEET = "products/20260930/Ops_ArchE_Port_20260929_2018_Austin_ORMHF000863_0930_Day.pdf"
MT_SHEET = "products/20260805/ops_twin_sisters_0805.pdf"
WA_SHEET = "products/20260617/brief_twin_0617.pdf"
CHERRY_SHEET = "products/20260705/ops_Cherry_0705.pdf"

IR_AUSTIN_0817 = "vectors/ir/austin/20260817_IR_11x17_Topo.geojson"
IR_GH_0817 = "vectors/ir/grasshopper/20260817_Austin_IR_11x17_Topo.geojson"
IR_GH_0929 = "vectors/ir/grasshopper/20260929_Austin_IR_11x17_Aerial.geojson"


def at(n: int, minutes: int = 0) -> str:
    """When catalog version n was generated (plus minutes)."""
    return (_BASE + timedelta(hours=n - 6, minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")


def dir_of(key: str) -> str:
    region, _year, name = key.split("/")
    return f"{FTP}/{region}/{name}/"


def sha16(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


def body(key: str, rel: str) -> bytes:
    return f"%PDF {key} {rel}".encode()


def api_fire(fire: dict, slug: str) -> dict:
    return dict(fire, fire_slug=slug, active=True)


def row(fire: dict, slug: str, dir_key: str | None = None, method: str = "unit_id") -> dict:
    """A catalog.json fire row (a folder matched, or none)."""
    return {"fire_slug": slug, "cornea_id": fire["cornea_id"],
            "unique_fire_id": fire["unique_fire_id"], "name": fire["post_title"],
            "created_on": fire.get("created_on"), "has_incident_maps": dir_key is not None,
            "incident_manifest": f"/catalogs/incidents/{slug}.json" if dir_key else None,
            "incident_map_count": 1 if dir_key else None,
            "ftp_match": ({"method": method, "confidence": 1.0, "dir_url": dir_of(dir_key)}
                          if dir_key else None)}


def default_rows(n: int) -> list[dict]:
    rows = []
    if n <= 25:
        rows += [row(AUSTIN, "austin", GH_KEY), row(GRASSHOPPER, "grasshopper")]
    else:
        rows += [row(AUSTIN, "austin", AU_KEY), row(GRASSHOPPER, "grasshopper", GH_KEY)]
    if n <= 12:
        rows.append(row(TWIN_WA, "twin-sisters", WA_KEY, "name_exact"))
    else:
        rows += [row(TWIN_MT, "twin-sisters", MT_KEY), row(TWIN_WA, "twin-sisters-wa")]
    if n < 35:
        rows.append(row(CHERRY_ID, "cherry", CHERRY_KEY, "name_exact"))
    return rows


class SpyStorage(DryRunStorage):
    """The bucket: writes recorded (`written`), deletes refused."""

    def delete_prefix(self, prefix):
        raise AssertionError(f"delete_prefix({prefix!r}) during a migration test")

    def delete_keys(self, keys):
        raise AssertionError("delete_keys during a migration test")


class World:
    def __init__(self, tmp_path, *, rows=default_rows, holes=()):
        self.storage = SpyStorage(tmp_path / "bucket")
        self.rows, self.holes = rows, set(holes)
        self.fires = [api_fire(GRASSHOPPER, "grasshopper"), api_fire(AUSTIN, "austin"),
                      api_fire(TWIN_MT, "twin-sisters"), api_fire(TWIN_WA, "twin-sisters-wa")]
        self.state = {"schema_version": 1, "updated_at": "2026-10-08T17:00:02Z",
                      "incidents": {}, "tiled": {}, "ir": {}, "prune": {"inactive_since": {}},
                      "catalog_version": LATEST}
        self.manifests: dict[str, dict] = {}

        self.record(GH_KEY, "grasshopper", "unit_id", GRASSHOPPER, synced=at(30, -5))
        for rel in GH_AT_AUSTIN:
            self.file(GH_KEY, rel, at_prefix="austin")
        for rel in GH_OWN:
            self.file(GH_KEY, rel)
        self.record(AU_KEY, "austin", "unit_id", AUSTIN, synced=at(28, -3))
        self.file(AU_KEY, AU_SHEET)
        self.record(MT_KEY, "twin-sisters", "unit_id", TWIN_MT, synced=at(20, -10))
        self.file(MT_KEY, MT_SHEET)
        self.record(WA_KEY, "twin-sisters", "name_exact", TWIN_WA, synced=at(10, -2))
        self.file(WA_KEY, WA_SHEET, lm="Wed, 17 Jun 2026 04:59:39 GMT")
        self.record(CHERRY_KEY, "cherry", "name_exact", CHERRY_ID, synced=at(8, -1))
        self.file(CHERRY_KEY, CHERRY_SHEET, lm="Sun, 05 Jul 2026 15:42:24 GMT")

        # the Grasshopper sheet was tiled while the folder showed on Austin
        gh_sha = self.sha(GH_KEY, GH_SHEET)
        self.state["tiled"][gh_sha] = {"tiler_version": 1, "at": at(10), "geo": {
            "georeferenced": True, "projection": "NAD83 / UTM zone 10N",
            "tiles": {"minzoom": 8, "maxzoom": 14, "bounds": [-122.2, 44.7, -121.7, 45.2]},
            "preview": True}}
        self.storage.put_bytes(f"tiles/incidents/austin/{gh_sha}/meta.json", b"{}")
        self.storage.put_bytes(f"tiles/incidents/austin/{gh_sha}/8/1/2.png", b"png")
        self.storage.put_bytes(f"previews/incidents/austin/{gh_sha}.png", b"png")
        au_sha = self.sha(AU_KEY, AU_SHEET)
        self.state["tiled"][au_sha] = {"tiler_version": 1, "at": at(28), "geo": {
            "georeferenced": False, "projection": None, "tiles": None, "preview": True}}
        self.storage.put_bytes(f"previews/incidents/austin/{au_sha}.png", b"png")

        # IR conversions of the slug-keyed manifests: 08-17 was converted from
        # Grasshopper's KMZ under austin/, 09-29 from Austin's under grasshopper/
        v = ir_vectors.IR_CONVERTER_VERSION
        self.state["ir"] = {
            IR_AUSTIN_0817: {"v": v, "flown_at": "2026-08-17T06:00:00Z", "flown_date": None,
                             "heat_types": ["Perimeter", "Isolated"]},
            IR_GH_0817: {"v": v, "failed": True},
            IR_GH_0929: {"v": v, "flown_at": None, "flown_date": "2026-09-29",
                         "heat_types": ["Perimeter", "Intense"]},
        }
        for key in (IR_AUSTIN_0817, IR_GH_0929):
            self.storage.put_bytes(key, b'{"type": "FeatureCollection", "features": []}')

        # today's slug manifests (Grasshopper's still names every file of its
        # folder under grasshopper/, as the slug-keyed build did)
        self.manifests["grasshopper"] = self.legacy_manifest(GRASSHOPPER, GH_KEY, "grasshopper")
        self.manifests["austin"] = self.legacy_manifest(AUSTIN, AU_KEY, "austin", preview=True)
        self.manifests["twin-sisters"] = self.legacy_manifest(TWIN_MT, MT_KEY, "twin-sisters")
        self.manifests["cherry"] = self.legacy_manifest(CHERRY_ID, CHERRY_KEY, "cherry")

    # -- building ----------------------------------------------------------

    def record(self, key, slug, method, fire, *, synced, match=True, **extra) -> dict:
        rec = {"fire_slug": slug, "dir_mtime": "2026-10-02 19:15", "children": {},
               "synced_at": synced, "dir_url": dir_of(key), "files": {},
               "match": ({"method": method, "confidence": 1.0 if method == "unit_id" else 0.95,
                          "token": fire["unique_fire_id"] if method == "unit_id" else None,
                          "dir_url": dir_of(key)} if match else None)}
        rec.update(extra)
        self.state["incidents"][key] = rec
        return rec

    def file(self, key, rel, *, at_prefix=None, data=None, **meta) -> dict:
        rec = self.state["incidents"][key]
        data = data if data is not None else body(key, rel)
        entry = {"etag": '"x"', "lm": "Thu, 01 Oct 2026 05:05:56 GMT", "size": len(data),
                 "sha16": sha16(data), "rev": 1,
                 "kind": "ir" if rel.startswith("ir/") else "product",
                 "url": f"{dir_of(key)}{rel}"}
        entry.update(meta)
        rec["files"][rel] = entry
        self.storage.put_bytes(f"raw/incidents/{at_prefix or rec['fire_slug']}/{rel}", data)
        return entry

    def sha(self, key, rel) -> str:
        return self.state["incidents"][key]["files"][rel]["sha16"]

    def legacy_manifest(self, fire, key, slug, *, preview=False) -> dict:
        rec = self.state["incidents"][key]
        maps = []
        for rel, meta in rec["files"].items():
            if meta["kind"] == "ir":
                continue
            sha = meta["sha16"]
            t = self.state["tiled"].get(sha) or {}
            maps.append({
                "id": sha, "filename": rel.rpartition("/")[2],
                "pdf_url": f"/raw/incidents/{slug}/{rel}",
                "preview_url": (f"/previews/incidents/{slug}/{sha}.png"
                                if preview or (t.get("geo") or {}).get("preview") else None),
                "tiles": ({"url_template": f"/tiles/incidents/{slug}/{sha}/{{z}}/{{x}}/{{y}}.png"}
                          if (t.get("geo") or {}).get("tiles") else None)})
        return {"schema_version": 1, "fire_slug": slug, "cornea_id": fire["cornea_id"],
                "source_dir": dir_of(key), "region": key.split("/")[0], "maps": maps,
                "ir_flights": []}

    def publish(self) -> "World":
        """Write state, manifests and catalog versions to the bucket, then
        forget the setup writes."""
        for n in range(6, LATEST + 1):
            if n in self.holes:
                continue
            fires = self.rows(n)
            self.storage.put_json(f"catalogs/versions/catalog.{n}.json", {
                "schema_version": 1, "version": n, "generated_at": at(n), "fires": fires,
                "counts": {"active_fires": len(fires)}})
        latest = self.rows(LATEST)
        self.storage.put_json("catalogs/catalog.json", {
            "schema_version": 1, "version": LATEST, "generated_at": at(LATEST), "fires": latest,
            "counts": {"active_fires": len(latest)}})
        for slug, man in self.manifests.items():
            self.storage.put_json(f"catalogs/incidents/{slug}.json", man)
        self.storage.put_json(STATE_KEY, self.state)
        self.storage.written.clear()
        return self

    # -- running -------------------------------------------------------------

    def state_on_bucket(self) -> dict:
        return json.loads((self.storage.out_dir / STATE_KEY).read_text())

    def fetch_fires(self, meta=None):
        if meta is not None:
            meta["raw_rows"] = len(self.fires)
        return [dict(f) for f in self.fires]


def freeze_clock(monkeypatch, now: str = NOW) -> None:
    """One clock for every module that stamps times, so two runs capture
    identical bytes."""
    monkeypatch.setattr(cat, "now_iso", lambda: now)
    monkeypatch.setattr(health, "now_iso", lambda: now)
    monkeypatch.setattr(state_mod, "now_iso", lambda: now)
    monkeypatch.setattr(mirror, "now_iso", lambda: now)  # a record's synced_at


def wire_cli(monkeypatch, world: World, *, sync_by_id: bool = True) -> None:
    """cli.main against the world's bucket, with no network."""
    monkeypatch.setattr(cli, "make_storage", lambda dry_run, out: world.storage)
    monkeypatch.setattr(cli, "make_client", lambda: contextlib.nullcontext(None))
    monkeypatch.setattr(cli, "fetch_active_fires",
                        lambda client, meta=None: world.fetch_fires(meta))
    monkeypatch.setattr(cli, "INCIDENT_SYNC_BY_ID", sync_by_id)
