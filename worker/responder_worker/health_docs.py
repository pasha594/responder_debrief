"""Single-writer health documents for the trails and routing jobs.

catalogs/health.json is read-modify-written by the jobs in the
worker-b2-writes concurrency group; the trails and routing workflows run in
their own groups, so they must not write it (a concurrent RMW would drop a
section). Each gets its own document instead:

  catalogs/health/trails.json    written only by sync-trails
  catalogs/health/routing.json   written only by routing-index

Shape: {schema_version, updated_at, last_run, last_failure, history[<=20]}.
A failed run keeps the previous last_run so the page can still say how old
the published data is; a success clears last_failure.
"""

from __future__ import annotations

from .b2 import Storage
from .catalogs import now_iso

SCHEMA_VERSION = 1
HISTORY_MAX = 20


def key_for(job: str) -> str:
    return f"catalogs/health/{job}.json"


def merge(existing: dict | None, entry: dict) -> dict:
    doc = dict(existing or {})
    doc["schema_version"] = SCHEMA_VERSION
    doc["updated_at"] = now_iso()
    ok = bool(entry.get("ok", True))
    if ok:
        doc["last_run"] = entry
        doc["last_failure"] = None
    else:
        doc.setdefault("last_run", None)
        doc["last_failure"] = entry
    hist = list(doc.get("history") or [])
    hist.append({"at": entry.get("finished_at") or now_iso(), "ok": ok,
                 "note": entry.get("note")})
    doc["history"] = hist[-HISTORY_MAX:]
    return doc


def publish(storage: Storage, job: str, entry: dict, log=print) -> None:
    """Best-effort, like health.publish: never fails the job."""
    try:
        key = key_for(job)
        storage.put_json(key, merge(storage.get_json(key), entry))
        log(f"[health] published {key}")
    except Exception as exc:  # noqa: BLE001 — deliberately broad
        log(f"[health] {job} publish failed (ignored): {exc}")
