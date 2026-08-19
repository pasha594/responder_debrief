"""catalogs/health.json — the ingestion heartbeat behind the site's /health
page. Each job (sync-catalogs, sync-incidents) publishes its own section at
the end of a run plus a rolling shared history; a crashed run simply doesn't
write, which the page surfaces as staleness (and the GitHub Actions API,
fetched client-side, shows the red run itself).
"""

from __future__ import annotations

from .b2 import Storage
from .catalogs import now_iso

SCHEMA_VERSION = 1
HISTORY_MAX = 40
KEY = "catalogs/health.json"


def merge_health(existing: dict | None, job: str, entry: dict) -> dict:
    """Fold one job's run entry into the shared doc (other sections kept)."""
    doc = dict(existing or {})
    doc["schema_version"] = SCHEMA_VERSION
    doc["updated_at"] = now_iso()
    doc[job] = entry
    history = list(doc.get("history") or [])
    history.append({
        "job": job,
        "at": entry.get("finished_at") or now_iso(),
        "ok": bool(entry.get("ok", True)),
        "note": entry.get("note"),
    })
    doc["history"] = history[-HISTORY_MAX:]
    return doc


def publish(storage: Storage, job: str, entry: dict, log=print) -> None:
    """Best-effort: a health hiccup must never fail the job itself."""
    try:
        doc = merge_health(storage.get_json(KEY), job, entry)
        storage.put_json(KEY, doc)
        log(f"[health] published {job} heartbeat")
    except Exception as exc:  # noqa: BLE001 — deliberately broad
        log(f"[health] publish failed (ignored): {exc}")
