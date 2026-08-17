"""Worker state: single JSON document at state/state.json (B2 or out/ in dry-run)."""

from __future__ import annotations

from datetime import datetime, timezone

from .b2 import Storage

STATE_KEY = "state/state.json"
SCHEMA_VERSION = 1


def empty_state() -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "updated_at": None,
        "incidents": {},
        "tiled": {},
        # NOAA HRRR weather frames: {workspace: {"done": bool, "fetched": N}}
        "hrrr": {},
        # forecast-archive doc ETags: {"manifest.json_etag", "fire_matches.json_etag", "fetched_at"}
        "archives": {},
        "prune": {"inactive_since": {}},
        "catalog_version": 0,
    }


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_state(storage: Storage) -> dict:
    data = storage.get_json(STATE_KEY)
    if not data:
        return empty_state()
    base = empty_state()
    base.update(data)
    return base


def save_state(storage: Storage, state: dict) -> None:
    state["updated_at"] = now_iso()
    storage.put_json(STATE_KEY, state, cache_control="private, no-store")
