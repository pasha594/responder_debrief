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
        assert len(fires.fetch_active_fires(client)) == 2  # meta is optional
