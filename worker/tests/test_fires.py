"""Active-fires index fetch (stubbed transport, no network)."""

import httpx

from responder_worker import fires


def test_fetch_active_fires_reports_raw_row_count():
    rows = [
        {"cornea_id": "{A}", "post_title": "Austin", "firetype": "Wildfire", "state": "OR",
         "fire_coordinates": "44.1, -119.2"},
        {"cornea_id": "{B}", "post_title": "Austin", "firetype": "Wildfire", "state": "NV"},
        {"cornea_id": "{C}", "post_title": "Pile Burn", "firetype": "Prescribed Fire"},
    ]
    seen = {}

    def handler(request):
        seen.update(request.url.params)
        return httpx.Response(200, json={"fires": rows})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        meta = {}
        got = fires.fetch_active_fires(client, meta=meta)
        assert meta == {"raw_rows": 3}  # before the wildfire filter
        assert [f["fire_slug"] for f in got] == ["austin", "austin-nv"]
        assert got[0]["coordinates"] == [-119.2, 44.1]
        assert seen["limit"] == str(fires.ACTIVE_FIRES_LIMIT)
        # prescribed burns must not fill the page and push wildfires off it
        assert seen["fire_type"] == "Wildfire"
        assert len(fires.fetch_active_fires(client)) == 2  # meta is optional


def _detail_client(details, calls):
    """Answers only the exact id spelling `details` is keyed by, as the API
    does (a braced id written bare or lowercased 404s)."""
    def handler(request):
        from urllib.parse import unquote
        cid = unquote(request.url.path.rsplit("/", 1)[-1])
        calls.append(fires.fire_key(cid))
        assert request.url.host == "fire-api-dev.web.app"  # never prod
        d = details.get(cid)
        return httpx.Response(200, json=d) if d else httpx.Response(404, json={})
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_fetch_fire_facts_shapes_an_index_row():
    fk = "4883092e-485f-429d-878d-819f01172840"
    detail = {"cornea_id": fk, "post_title": "Dome", "state": "CA", "acres": 6788,
              "containment": 100, "active": False, "firetype": "Wildfire",
              "fire_coordinates": "37.57, -119.61", "county": "Mariposa"}
    calls = []
    with _detail_client({fk: detail}, calls) as client:
        f = fires.fetch_fire_facts(client, fk)
        assert f["fire_slug"] == "dome" and f["coordinates"] == [-119.61, 37.57]
        assert f["active"] is False and f["acres"] == 6788
        assert "county" not in f and set(fires.FIRE_FIELDS) <= set(f)
        assert fires.fetch_fire_facts(client, "ffff0000-0000-4000-8000-000000000000") is None


def test_refresh_fire_facts_fetches_missing_and_stale_and_drops_the_rest():
    fresh, stale, new, back_on, gone_404 = (f"{c * 8}-0000-4000-8000-000000000000" for c in "abcde")
    now = 10 * fires.FACTS_REFRESH_S
    cache = {
        fresh: {"at": now - 60, "fire": {"post_title": "Fresh"}},
        stale: {"at": now - fires.FACTS_REFRESH_S - 1, "fire": {"post_title": "Old"}},
        back_on: {"at": now - 60, "fire": {"post_title": "Back on the active list"}},
        gone_404: {"at": 0, "fire": {"post_title": "Kept on a failed fetch"}},
    }
    details = {"{" + k.upper() + "}": {"cornea_id": "{" + k.upper() + "}",
                                       "post_title": k[:1].upper(), "active": False}
               for k in (stale, new)}
    calls = []
    with _detail_client(details, calls) as client:
        want = {k: "{" + k.upper() + "}" for k in (fresh, stale, new, gone_404)}
        n = fires.refresh_fire_facts(client, cache, want, now_s=now, log=lambda *_: None)
    assert n == 2
    assert calls == [new, gone_404, stale]  # never fetched first, then stalest
    assert cache[new]["fire"]["cornea_id"] == "{" + new.upper() + "}"  # by the API's spelling
    assert back_on not in cache
    assert cache[fresh]["fire"] == {"post_title": "Fresh"}
    assert cache[stale]["fire"]["post_title"] == "B" and cache[stale]["at"] == now
    assert cache[new]["fire"]["fire_slug"] == "c"
    assert cache[gone_404]["fire"]["post_title"] == "Kept on a failed fetch"


def test_refresh_fire_facts_stops_at_the_deadline_and_the_cap(monkeypatch):
    monkeypatch.setattr(fires, "FACTS_MAX_FETCHES", 2)
    keys = {k: k for k in (f"{i:08x}-0000-4000-8000-000000000000" for i in range(5))}
    details = {k: {"cornea_id": k, "post_title": "X", "active": False} for k in keys}
    calls = []
    with _detail_client(details, calls) as client:
        cache = {}
        assert fires.refresh_fire_facts(client, cache, keys, now_s=0, log=lambda *_: None) == 2
        calls.clear()
        assert fires.refresh_fire_facts(client, cache, keys, now_s=0, log=lambda *_: None,
                                        deadline_passed=lambda: True) == 0
        assert calls == []
