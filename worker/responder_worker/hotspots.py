"""Per-fire hotspot archive: daily GeoJSON chunks on B2.

The fire API caps /hotspots responses at 50k features, serves them oldest
first, and re-serves the whole history to every client. Mirroring detections
into per-day chunks fixes both costs at once:

  hotspots/{fire_slug}/g{N}/{YYYY-MM-DD}.json   day chunk (FeatureCollection)
  hotspots/{fire_slug}/index.json               {"bbox","gen","days","updated_at"}

Cache semantics: a chunk may ship immutable headers ONLY if this pipeline
will provably never rewrite that URL. Two rules make that true:
  - the resume cursor never passes yesterday (detections for day D keep
    arriving during D+1, so the last two days are re-pulled every sync);
  - when the query box GROWS (fire spread, a forecast-run centroid far from
    the fire point), history behind the cursor would be incomplete for the
    new area — so the archive bumps its GENERATION: a fresh backfill under
    new g{N}/ URLs, never rewrites of already-immutable ones.

A pathological single day with >50k in-box detections cannot be paged past
(the API has no sub-day cursor); the archive keeps that day's first 50k,
logs loudly, and advances — a frozen archive that looks healthy is worse.

State loss is survivable: with no state record, the published index is
adopted (gen/days/bbox) instead of restarting generation numbering, which
would rewrite immutable URLs with different content.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

from . import config

PAGE_LIMIT = 50000
# One run advances a backfill by at most this many pages per fire; a mega
# fire's history converges across hourly runs instead of blowing the budget.
MAX_PAGES_PER_FIRE = 4
HISTORY_MAX_DAYS = 45
SNAP_DEG = 0.25
CHUNK_CC = "public, max-age=31536000, immutable"
LIVE_CC = "public, max-age=300"

KEEP_PROPS = ("source", "acq_date", "acq_time", "frp", "confidence")


def _now_utc() -> datetime:
    """Injectable clock (tests freeze it)."""
    return datetime.now(timezone.utc)


def _today() -> str:
    return _now_utc().strftime("%Y-%m-%d")


def _yesterday() -> str:
    return (_now_utc() - timedelta(days=1)).strftime("%Y-%m-%d")


def _day_after(day: str) -> str:
    d = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return (d + timedelta(days=1)).strftime("%Y-%m-%d")


def _snap_box(w: float, s: float, e: float, n: float) -> list[float]:
    return [
        math.floor(w / SNAP_DEG) * SNAP_DEG,
        math.floor(s / SNAP_DEG) * SNAP_DEG,
        math.ceil(e / SNAP_DEG) * SNAP_DEG,
        math.ceil(n / SNAP_DEG) * SNAP_DEG,
    ]


def _rect(lon: float, lat: float) -> list[float]:
    # Slightly wider than the frontend's ±0.5/±0.4 fallback rectangle so the
    # archive is a superset of what the direct path would have covered.
    return [lon - 0.6, lat - 0.5, lon + 0.6, lat + 0.5]


def fire_bbox(fire: dict, run_centroid: list[float] | None) -> list[float] | None:
    """[w, s, e, n] — rectangles around the fire point AND the forecast-run
    centroid (the model domain can sit off the fire point), padded 20% and
    grid-snapped. NOT unioned with the previous box: growth is handled by a
    generation bump, never by silently widening the current one."""
    boxes: list[list[float]] = []
    coords = fire.get("coordinates")
    if coords and len(coords) == 2:
        boxes.append(_rect(coords[0], coords[1]))
    if run_centroid and len(run_centroid) == 2:
        boxes.append(_rect(run_centroid[0], run_centroid[1]))
    if not boxes:
        return None
    w = min(b[0] for b in boxes)
    s = min(b[1] for b in boxes)
    e = max(b[2] for b in boxes)
    n = max(b[3] for b in boxes)
    pw, ph = (e - w) * 0.2, (n - s) * 0.2
    return _snap_box(w - pw, s - ph, e + pw, n + ph)


def _contains(outer: list[float], inner: list[float]) -> bool:
    return (outer[0] <= inner[0] and outer[1] <= inner[1]
            and outer[2] >= inner[2] and outer[3] >= inner[3])


def _feature_key(f: dict) -> tuple:
    g = (f.get("geometry") or {}).get("coordinates") or (None, None)
    p = f.get("properties") or {}
    return (g[0], g[1], p.get("acq_date"), p.get("acq_time"), p.get("source"))


def _slim(f: dict) -> dict:
    p = f.get("properties") or {}
    return {
        "type": "Feature",
        "geometry": f.get("geometry"),
        "properties": {k: p.get(k) for k in KEEP_PROPS},
    }


def default_since(fire: dict) -> str:
    """First archive pull: fire discovery date, capped at HISTORY_MAX_DAYS."""
    floor = (_now_utc() - timedelta(days=HISTORY_MAX_DAYS)).strftime("%Y-%m-%d")
    created = fire.get("created_on") or ""
    day = created[:10] if len(created) >= 10 else ""
    return max(day, floor) if day else floor


def sync_fire(client, storage, rec: dict, fire: dict,
              run_centroid: list[float] | None, log,
              deadline_passed=lambda: False) -> bool:
    """Pull the increment for one fire and (re)write its changed day chunks +
    index. `rec` is this fire's slot in state and is mutated with the resume
    point. Returns True when anything was written."""
    slug = fire["fire_slug"]

    # Survive state loss: adopt the published index rather than restarting
    # generation numbering over already-immutable URLs.
    if not rec and storage is not None:
        published = None
        try:
            published = storage.get_json(f"hotspots/{slug}/index.json")
        except Exception:
            published = None
        if published:
            rec.update({
                "gen": published.get("gen", 1),
                "bbox": published.get("bbox"),
                "days": published.get("days") or [],
                "last_day": (published.get("days") or [None])[-1],
            })

    want_box = fire_bbox(fire, run_centroid)
    if want_box is None:
        return False
    gen = rec.get("gen") or 1
    box = rec.get("bbox")
    if box is None:
        box = want_box
    elif not _contains(box, want_box):
        # Box must grow → new generation, full re-backfill under new URLs.
        gen += 1
        box = [min(box[0], want_box[0]), min(box[1], want_box[1]),
               max(box[2], want_box[2]), max(box[3], want_box[3])]
        rec.update({"gen": gen, "bbox": box, "days": [], "last_day": None})
        log(f"[hotspots] {slug}: box grew — starting generation g{gen}")

    since = rec.get("last_day") or default_since(fire)
    w, s, e, n = box

    seen: set[tuple] = set()
    by_day: dict[str, list[dict]] = {}
    complete = False
    stalled_day: str | None = None
    cursor = since
    for _ in range(MAX_PAGES_PER_FIRE):
        if deadline_passed():
            break
        r = client.get(
            f"{config.FIRE_API_DEV}/hotspots",
            params={"bbox": f"{s},{w},{n},{e}",  # LAT-FIRST
                    "since": cursor, "limit": PAGE_LIMIT},
            timeout=60,
        )
        r.raise_for_status()
        feats = (r.json() or {}).get("features") or []
        newest = None
        for f in feats:
            k = _feature_key(f)
            if k in seen:
                continue
            seen.add(k)
            day = (f.get("properties") or {}).get("acq_date")
            if not day:
                continue
            by_day.setdefault(day, []).append(_slim(f))
            if newest is None or day > newest:
                newest = day
        if len(feats) < PAGE_LIMIT:
            complete = True
            break
        if not newest or newest == cursor:
            # One UTC day exceeds the page cap — impossible to page past
            # (the API has no sub-day cursor). Keep the first 50k, step
            # over it, and say so loudly rather than freezing forever.
            stalled_day = cursor
            log(f"[hotspots] {slug}: day {cursor} exceeds the 50k page cap — "
                "archiving its first page and advancing (partial day)")
            break
        cursor = newest

    yesterday = _yesterday()
    days = sorted(by_day)
    if stalled_day is not None:
        resume = _day_after(stalled_day)
    elif complete:
        resume = max(since, yesterday)
    else:
        # Page/deadline-capped backfill resumes where it stopped, but the
        # cursor never passes yesterday (late-arriving detections).
        resume = min(days[-1], yesterday) if days else since

    if not by_day:
        if complete:
            rec.update({"last_day": resume, "gen": gen, "bbox": box})
        return False

    prev_days = set(rec.get("days") or [])
    for day in days:
        fc = {"type": "FeatureCollection", "features": by_day[day]}
        # Immutable ONLY when no future sync can rewrite this URL: the day is
        # behind the resume cursor AND fully in the past. A stalled (partial)
        # day always stays revalidating.
        immutable = day < resume and day < yesterday and day != stalled_day
        storage.put_json(f"hotspots/{slug}/g{gen}/{day}.json", fc,
                         cache_control=CHUNK_CC if immutable else LIVE_CC)
    all_days = sorted(prev_days | set(days))
    storage.put_json(
        f"hotspots/{slug}/index.json",
        {"schema": 2, "gen": gen, "bbox": box, "days": all_days,
         "updated_at": _now_utc().isoformat(timespec="seconds")},
        cache_control=LIVE_CC,
    )
    rec.update({"last_day": resume, "gen": gen, "bbox": box, "days": all_days})
    log(f"[hotspots] {slug}: +{sum(len(v) for v in by_day.values())} features "
        f"across {len(days)} days (g{gen})"
        + ("" if complete else " (capped, resumes)"))
    return True
