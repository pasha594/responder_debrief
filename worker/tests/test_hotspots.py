"""Hotspot archive: pagination, day chunking, resume points, cache headers,
generation bumps, stall handling — all under a frozen clock."""
from datetime import datetime, timezone

from responder_worker import hotspots

FROZEN = datetime(2026, 8, 21, 12, 0, tzinfo=timezone.utc)


class StubResp:
    def __init__(self, feats):
        self._f = feats
    def raise_for_status(self):
        pass
    def json(self):
        return {"type": "FeatureCollection", "features": self._f}


class StubClient:
    def __init__(self, pages):
        self.pages = list(pages)
        self.calls = []
    def get(self, url, params=None, timeout=None):
        self.calls.append(params)
        return StubResp(self.pages.pop(0) if self.pages else [])


class StubStorage:
    def __init__(self, index=None):
        self.puts = {}
        self._index = index
    def put_json(self, key, obj, *, cache_control=None):
        self.puts[key] = (obj, cache_control)
    def get_json(self, key):
        return self._index


def feat(i, day):
    return {"type": "Feature",
            "geometry": {"type": "Point", "coordinates": [-120 - i * 1e-3, 48.0]},
            "properties": {"source": "MODIS", "acq_date": day, "acq_time": "0400",
                           "frp": 2.5, "confidence": "n", "extra": "dropped"}}


FIRE = {"fire_slug": "testfire", "coordinates": [-120.5, 48.0],
        "created_on": "2026-08-01T00:00:00Z"}


def freeze(monkeypatch):
    monkeypatch.setattr(hotspots, "_now_utc", lambda: FROZEN)


def test_sync_fire_chunks_days_and_resumes(monkeypatch):
    freeze(monkeypatch)
    client = StubClient([[feat(1, "2026-08-18"), feat(2, "2026-08-19"),
                          feat(3, "2026-08-20"), feat(4, "2026-08-21")]])
    storage = StubStorage()
    rec = {"gen": 1, "bbox": hotspots.fire_bbox(FIRE, None), "days": []}
    assert hotspots.sync_fire(client, storage, rec, FIRE, None, lambda *_: None)
    lat_first = client.calls[0]["bbox"].split(",")
    assert float(lat_first[0]) < 60 and float(lat_first[1]) < -100
    # only days strictly behind the resume cursor AND before yesterday freeze
    assert storage.puts["hotspots/testfire/g1/2026-08-18.json"][1].endswith("immutable")
    assert storage.puts["hotspots/testfire/g1/2026-08-19.json"][1].endswith("immutable")
    assert "max-age=300" in storage.puts["hotspots/testfire/g1/2026-08-20.json"][1]
    assert "max-age=300" in storage.puts["hotspots/testfire/g1/2026-08-21.json"][1]
    idx = storage.puts["hotspots/testfire/index.json"][0]
    assert idx["gen"] == 1 and len(idx["days"]) == 4
    assert rec["last_day"] == "2026-08-20"  # yesterday
    f0 = storage.puts["hotspots/testfire/g1/2026-08-18.json"][0]["features"][0]
    assert "extra" not in f0["properties"]


def test_page_capped_backfill_never_marks_yesterday_immutable(monkeypatch):
    freeze(monkeypatch)
    monkeypatch.setattr(hotspots, "PAGE_LIMIT", 2)
    monkeypatch.setattr(hotspots, "MAX_PAGES_PER_FIRE", 2)
    # backfill whose LAST full page reaches today
    client = StubClient([
        [feat(1, "2026-08-19"), feat(2, "2026-08-20")],
        [feat(2, "2026-08-20"), feat(3, "2026-08-21")],
    ])
    storage = StubStorage()
    rec = {"gen": 1, "bbox": hotspots.fire_bbox(FIRE, None), "days": []}
    assert hotspots.sync_fire(client, storage, rec, FIRE, None, lambda *_: None)
    # resume clamps to yesterday even though days[-1] is today
    assert rec["last_day"] == "2026-08-20"
    for day in ("2026-08-20", "2026-08-21"):
        assert "max-age=300" in storage.puts[f"hotspots/testfire/g1/{day}.json"][1]


def test_over_cap_day_advances_instead_of_freezing(monkeypatch):
    freeze(monkeypatch)
    monkeypatch.setattr(hotspots, "PAGE_LIMIT", 2)
    # both pages full, all features from ONE day -> stall detected
    client = StubClient([
        [feat(1, "2026-08-05"), feat(2, "2026-08-05")],
        [feat(3, "2026-08-05"), feat(4, "2026-08-05")],
    ])
    storage = StubStorage()
    rec = {"gen": 1, "bbox": hotspots.fire_bbox(FIRE, None), "days": [],
           "last_day": "2026-08-05"}
    logs = []
    assert hotspots.sync_fire(client, storage, rec, FIRE, None, logs.append)
    assert rec["last_day"] == "2026-08-06"  # stepped past the monster day
    assert any("50k" in m for m in logs)
    # the partial day must stay revalidating, never immutable
    assert "max-age=300" in storage.puts["hotspots/testfire/g1/2026-08-05.json"][1]


def test_box_growth_bumps_generation(monkeypatch):
    freeze(monkeypatch)
    client = StubClient([[feat(1, "2026-08-18")]])
    storage = StubStorage()
    small = hotspots.fire_bbox(FIRE, None)
    rec = {"gen": 1, "bbox": small, "days": ["2026-08-15"], "last_day": "2026-08-15"}
    # a forecast-run centroid far from the fire point forces growth
    assert hotspots.sync_fire(client, storage, rec, FIRE, [-122.5, 47.0],
                              lambda *_: None)
    assert rec["gen"] == 2
    assert "hotspots/testfire/g2/2026-08-18.json" in storage.puts
    # fresh backfill: since falls back to fire discovery, not the old cursor
    assert client.calls[0]["since"] == "2026-08-01"
    assert storage.puts["hotspots/testfire/index.json"][0]["gen"] == 2


def test_state_loss_adopts_published_index(monkeypatch):
    freeze(monkeypatch)
    published = {"schema": 2, "gen": 3, "bbox": hotspots.fire_bbox(FIRE, None),
                 "days": ["2026-08-18"], "updated_at": "x"}
    client = StubClient([[feat(1, "2026-08-19")]])
    storage = StubStorage(index=published)
    rec = {}
    assert hotspots.sync_fire(client, storage, rec, FIRE, None, lambda *_: None)
    assert rec["gen"] == 3  # numbering continues; no immutable rewrite
    assert "hotspots/testfire/g3/2026-08-19.json" in storage.puts


def test_deadline_stops_between_pages(monkeypatch):
    freeze(monkeypatch)
    client = StubClient([[feat(1, "2026-08-18")]])
    storage = StubStorage()
    rec = {"gen": 1, "bbox": hotspots.fire_bbox(FIRE, None), "days": []}
    assert not hotspots.sync_fire(client, storage, rec, FIRE, None,
                                  lambda *_: None, deadline_passed=lambda: True)
    assert client.calls == []
    assert storage.puts == {}
