"""Public forecast-archive catalog merge (docs/spec-archives.md).

The browser renders spread forecasts DIRECTLY from the user's public
fire-forecast-archive bucket (ToA GeoTIFFs + hourly product tars), so the
worker's whole spread pipeline shrinks to a catalog merge: fetch the archive's
manifest.json + fire_matches.json over plain public HTTPS (no creds,
ETag-cached), match archive slugs to active fires, and emit pyrecast_runs.json
schema_version 2 — per-fire run availability, archive-relative URL templates,
and legend ramps. No GDAL, no frame pre-rendering, no percentile restriction.

fire_matches.json (produced by the archive's collector) is the PRIMARY
slug -> fire matcher (it maps slug -> cornea fire); matching.match_pyrecast_slug
is the fallback for slugs it does not cover.
"""

from __future__ import annotations

from datetime import datetime, timezone

import httpx

from . import config
from .b2 import Storage
from .http import get
from .matching import match_pyrecast_slug

# Cached copies of the archive docs (private; ETags live in state['archives'])
MANIFEST_CACHE_KEY = "state/archives/manifest.json"
FIRE_MATCHES_CACHE_KEY = "state/archives/fire_matches.json"

# Archive-base-relative URL templates (frontend prepends archive_base)
TOA_URL_TEMPLATE = "/forecast_archive/{slug}/{run_ts}/{pct}.tif"
PRODUCT_TAR_TEMPLATE = "/forecast_archive/{slug}/{run_ts}/{pct}_{product}.tar"

RUNS_PER_FIRE = 2  # newest complete non-expired run + one previous

# ToA tif values are hours since forecast start, max ~336 (spec-archives.md);
# horizon fallback when a run has no timed-product vars at all.
TOA_MAX_HOURS = 336

# Products carried into the manifest: units + gradient legend stops (crown-fire
# is categorical -> discrete legend_labels). Vector products (isochrones) and
# anything unknown are ignored for v1.
RAMPS: dict[str, dict] = {
    "spread-rate": {
        "units": "ch/hr",
        "stops": [[1, "#ffdc50"], [10, "#ff9628"], [25, "#e63c32"],
                  [50, "#aa2882"], [100, "#6e1450"]],
    },
    "flame-length": {
        "units": "ft",
        "stops": [[1, "#ffdc50"], [4, "#ff9628"], [8, "#e63c32"],
                  [11, "#aa2882"], [25, "#6e1450"]],
    },
    "hours-since-burned": {
        "units": "h",
        "stops": [[1, "#d4572e"], [24, "#c05de1"], [96, "#6e4bd0"],
                  [168, "#3f2d7d"]],
    },
    "crown-fire": {
        "units": None,
        "stops": [[1, "#ffdc50"], [2, "#ff9628"], [3, "#e63c32"]],
        "labels": ["surface", "passive crown", "active crown"],
    },
}

# ToA colorize hint: burned-area fill + bright leading edge for the last
# recent_hours before the scrub time (frontend toaRenderer).
TOA_RAMP: dict = {
    "recent_hours": 12,
    "stops": [["burned", "#7a1f1f"], ["recent", "#ff6a2b"]],
}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run_time_from_ts(run_ts: str) -> str | None:
    """'20260817_112500' -> '2026-08-17T11:25:00Z' (None if malformed)."""
    try:
        dt = datetime.strptime(run_ts, "%Y%m%d_%H%M%S")
    except (TypeError, ValueError):
        return None
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# ETag-cached public fetch
# ---------------------------------------------------------------------------

def fetch_archive_doc(client: httpx.Client, storage: Storage, arch_state: dict,
                      name: str, cache_key: str, *, force: bool = False,
                      log=print) -> dict:
    """GET {archive_base}/{name} with If-None-Match; 304 -> cached copy."""
    url = f"{config.archive_base()}/{name}"
    etag = None if force else arch_state.get(f"{name}_etag")
    resp = get(client, url, headers={"If-None-Match": etag} if etag else {})
    if resp.status_code == 304:
        cached = storage.get_json(cache_key)
        if cached is not None:
            log(f"[archives] {name} unchanged (etag {etag}) — using cached copy")
            return cached
        resp = get(client, url)  # cached copy lost — unconditional refetch
    doc = resp.json()
    new_etag = resp.headers.get("etag")
    if new_etag:
        arch_state[f"{name}_etag"] = new_etag
    storage.put_json(cache_key, doc, cache_control="private, no-store")
    return doc


# ---------------------------------------------------------------------------
# Pure builders (unit-tested against real captured excerpts)
# ---------------------------------------------------------------------------

def candidate_runs(manifest: dict) -> dict[str, list[dict]]:
    """slug -> complete, non-expired manifest run entries, newest first."""
    by_slug: dict[str, list[dict]] = {}
    for run_key, entry in (manifest.get("runs") or {}).items():
        if not entry.get("complete") or entry.get("expired"):
            continue
        slug = entry.get("slug") or run_key.split("/", 1)[0]
        by_slug.setdefault(slug, []).append(entry)
    for runs in by_slug.values():
        runs.sort(key=lambda e: e.get("run_ts") or "", reverse=True)
    return by_slug


def _norm_cornea(cid: str | None) -> str:
    """Cornea ids appear both as '{78D35D3B-…}' and 'ca6b8a6a-…' — normalize."""
    return (cid or "").strip().strip("{}").lower()


def match_slug(slug: str, matches: dict, fires: list[dict]
               ) -> tuple[dict | None, str, float]:
    """fire_matches.json first (slug -> cornea fire), fuzzy slug fallback."""
    m = (matches or {}).get(slug) or {}
    want = _norm_cornea(m.get("cornea_id"))
    if want:
        for f in fires:
            if _norm_cornea(f.get("cornea_id")) == want:
                return f, "fire_matches", 1.0
    return match_pyrecast_slug(slug, fires)


def build_run(entry: dict) -> dict:
    """One manifest run entry -> a schema_version-2 run object."""
    slug, run_ts = entry["slug"], entry["run_ts"]
    files = entry.get("files") or {}
    vars_ = entry.get("vars") or {}

    toa_pcts = sorted(int(p) for p, f in files.items() if (f or {}).get("ok"))

    products: dict[str, dict] = {}
    horizon = 0
    for name, ramp in RAMPS.items():
        pcts: list[int] = []
        for pct, prods in vars_.items():
            v = (prods or {}).get(name) or {}
            if v.get("ok"):
                pcts.append(int(pct))
                horizon = max(horizon, int(v.get("n") or 0))
        if not pcts:
            continue
        p_out = {
            "percentiles": sorted(pcts),
            "tar_template": PRODUCT_TAR_TEMPLATE,
            "units": ramp["units"],
            "legend_stops": [list(s) for s in ramp["stops"]],
        }
        if "labels" in ramp:
            p_out["legend_labels"] = list(ramp["labels"])
        products[name] = p_out

    return {
        "workspace": f"{slug}_{run_ts}",
        "slug": slug,
        "run_ts": run_ts,
        "run_time": run_time_from_ts(run_ts),
        "horizon_hours": horizon or TOA_MAX_HOURS,
        "centroid": entry.get("centroid"),
        "toa": {"percentiles": toa_pcts, "url_template": TOA_URL_TEMPLATE},
        "products": products,
        "toa_ramp": {"recent_hours": TOA_RAMP["recent_hours"],
                     "stops": [list(s) for s in TOA_RAMP["stops"]]},
    }


def build_pyrecast_runs(fires: list[dict], manifest: dict,
                        fire_matches: dict | None = None) -> dict:
    """pyrecast_runs.json schema_version 2 (filename kept for the frontend)."""
    matches = (fire_matches or {}).get("matches") or {}
    fires_out: dict[str, dict] = {}
    unmatched_slugs: list[str] = []
    for slug, runs in sorted(candidate_runs(manifest).items()):
        fire, method, conf = match_slug(slug, matches, fires)
        if fire is None:
            unmatched_slugs.append(slug)
            continue
        entry = fires_out.setdefault(fire["fire_slug"], {
            "pyrecast_slug": slug,
            "match_method": method,
            "match_confidence": conf,
            "runs": [],
        })
        for e in runs[:RUNS_PER_FIRE]:
            entry["runs"].append(build_run(e))
    return {
        "schema_version": 2,
        "generated_at": now_iso(),
        "source": "fire-forecast-archive",
        "archive_base": config.archive_base(),
        "fires": fires_out,
        "unmatched_slugs": unmatched_slugs,
    }


# ---------------------------------------------------------------------------
# Sync entry point (cli.sync-catalogs)
# ---------------------------------------------------------------------------

def sync(client: httpx.Client, storage: Storage, state: dict,
         fires: list[dict], *, force: bool = False, log=print) -> dict:
    """Fetch the archive docs and build pyrecast_runs.json v2."""
    arch_state = state.setdefault("archives", {})
    manifest = fetch_archive_doc(
        client, storage, arch_state, "manifest.json", MANIFEST_CACHE_KEY,
        force=force, log=log)
    fire_matches = fetch_archive_doc(
        client, storage, arch_state, "fire_matches.json", FIRE_MATCHES_CACHE_KEY,
        force=force, log=log)
    arch_state["fetched_at"] = now_iso()

    doc = build_pyrecast_runs(fires, manifest, fire_matches)
    n_runs = sum(len(e["runs"]) for e in doc["fires"].values())
    log(f"[archives] manifest runs={len(manifest.get('runs') or {})} -> "
        f"matched fires={len(doc['fires'])} ({n_runs} runs), "
        f"unmatched_slugs={len(doc['unmatched_slugs'])}")
    return doc
