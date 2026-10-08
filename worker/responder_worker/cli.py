"""CLI: python -m responder_worker.cli
{sync-catalogs|sync-incidents|tile-worker|backfill|prune|cleanup-spread-frames|
 migrate-incident-ids|audit-incident-keys|reassign-files|restore-state-backup|
 sync-trails|routing-plan|routing-build|routing-one|routing-index}

--dry-run everywhere: no B2 needed; outputs land under ./out/ mirroring the B2
key layout, state at ./out/state/state.json.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import re
import tempfile
import time
from collections import Counter
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import httpx

from . import archives, hotspots, catalogs as cat, fire_manifests, health, imsr, incident_ids
from . import config, frames, geopdf, hrrr, ir_vectors, pyrecast, state as state_mod
from .asset_keys import (
    fetch_verified,
    ir_entry,
    preview_key,
    put_tiled,
    raw_key,
    raw_key_candidates,
    record_prefix,
    sha16_file,
    tile_meta_key,
    tile_root,
    tiles_prefix,
)
from .b2 import make_storage
from .catalogs import migrate_perim_counts
from .fires import (
    ACTIVE_FIRES_LIMIT,
    fetch_active_fires,
    fetch_perimeter_count,
    fire_key,
    fire_list_suspect,
    is_fire_id,
)
from .ftp_index import list_dir
from .http import get_optional, make_client
from .matching import (
    IncidentCandidate,
    candidate_dir_name,
    extract_unit_tokens,
    match_candidate,
    normalize_name,
    resolve_override,
)
from .mirror import IncidentMirror

DEFAULT_OUT = Path(__file__).resolve().parent.parent / "out"

#: True: sync-incidents keys records by fire ID (and pauses until the
#: incident-ID migration has run), so the migration may apply.
INCIDENT_SYNC_BY_ID = True


def log(msg: str) -> None:
    print(msg, flush=True)


# Filenames occasionally parse into impossible dates ("2026-17-00"); only
# real calendar days may become a fire's latest_upload.
def _valid_day(s) -> bool:
    return cat.valid_day(s) is not None


def _valid_ts(s) -> bool:
    '''True for a plausible ISO timestamp (2026-08-31T02:48:40Z).'''
    if not s:
        return False
    try:
        datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


# ===========================================================================
# sync-catalogs
# ===========================================================================

def cmd_sync_catalogs(args) -> int:
    job_started = cat.now_iso()
    storage = make_storage(args.dry_run, args.out)
    state = state_mod.load_state(storage)

    frame_budget = int(os.environ.get("FRAME_BUDGET", config.FRAME_BUDGET_DEFAULT))
    products_filter = (set(s for s in args.frames_products.split(",") if s)
                       if args.frames_products else None)
    if args.frames_fires:
        # spread is client-rendered from the archive now; the manifest is
        # cheap so it always covers every matched fire.
        log("[catalogs] note: --frames-fires no longer limits anything "
            "(spread frames are gone; kept for CLI compatibility)")

    with make_client() as client:
        log("[catalogs] fetching active fires ...")
        fires_meta: dict = {}
        fires = fetch_active_fires(client, meta=fires_meta)
        log(f"[catalogs] active wildfires: {len(fires)}")

        # Perimeter version counts for the directory. One tiny index GET per
        # fire, but cached on poly_last_updated so steady-state syncs only
        # refetch fires whose perimeter actually changed. Wall-clock capped:
        # stragglers keep their cached count until a later run.
        log("[catalogs] refreshing perimeter version counts ...")
        pc_state = migrate_perim_counts(state, fires)
        perimeter_counts: dict[str, int] = {}
        pc_deadline = time.monotonic() + 240
        pc_fetched = 0
        for f in fires:
            fk = fire_key(f.get("cornea_id"))
            if fk is None:
                continue
            cached = pc_state.get(fk)
            poly = f.get("poly_last_updated")
            if cached and cached.get("poly") == poly and cached.get("count") is not None:
                perimeter_counts[fk] = cached["count"]
                continue
            if time.monotonic() > pc_deadline:
                if cached and cached.get("count") is not None:
                    perimeter_counts[fk] = cached["count"]
                continue
            n = fetch_perimeter_count(client, f.get("cornea_id") or "")
            pc_fetched += 1
            if n is not None:
                perimeter_counts[fk] = n
                pc_state[fk] = {"count": n, "poly": poly}
            elif cached and cached.get("count") is not None:
                perimeter_counts[fk] = cached["count"]
        log(f"[catalogs] perimeter counts: {len(perimeter_counts)} fires "
            f"({pc_fetched} fetched, rest cached)")

        log("[catalogs] fetching forecast-archive manifest + fire matches ...")
        pyre = archives.sync(client, storage, state, fires,
                             force=args.force, log=log)

        # Per-fire hotspot archives (daily chunks on B2, increments only).
        # Deadline-capped: big backfills advance a few pages per run and
        # converge across hourly syncs. Ordered stalest-first so no fire
        # starves behind the backfill of another.
        log("[hotspots] syncing per-fire archives ...")
        # Keyed by cornea_id (archives used to be keyed by name, and a new
        # fire adopted an older same-name fire's archive). The name-keyed
        # state is dropped; every fire re-backfills under its id.
        state.pop("hotspot_archive", None)
        hs_state = state.setdefault("hotspot_archive_by_id", {})
        hs_deadline = time.monotonic() + int(os.environ.get(
            "HOTSPOT_SYNC_MAX_SECONDS", "240"))
        hs_order = sorted(
            (f for f in fires if hotspots.archive_id(f)),
            key=lambda f: ((hs_state.get(hotspots.archive_id(f)) or {}).get("last_day") or "",
                           -(f.get("acres") or 0)),
        )
        hs_written = 0
        hs_deadline_passed = lambda: time.monotonic() > hs_deadline  # noqa: E731
        runs_by_fire = {fire_key(e.get("cornea_id")): e.get("runs") or []
                        for e in pyre["fires"].values()}
        for f in hs_order:
            if hs_deadline_passed():
                log("[hotspots] wall-clock reached — remaining fires next run")
                break
            slug = f["fire_slug"]
            runs = runs_by_fire.get(fire_key(f.get("cornea_id"))) or []
            # run records carry a centroid, never a bbox (that is decoded
            # client-side from the tif) — the box builder rects around it
            run_centroid = runs[0].get("centroid") if runs else None
            rec = hs_state.setdefault(hotspots.archive_id(f), {})
            try:
                if hotspots.sync_fire(client, storage, rec, f, run_centroid,
                                      log, deadline_passed=hs_deadline_passed):
                    hs_written += 1
            except Exception as exc:
                log(f"[hotspots] {slug}: sync failed ({exc}) — next run retries")
        log(f"[hotspots] archives updated for {hs_written} fires")

        log("[catalogs] discovering NOAA HRRR cycles (AWS S3 listing) ...")
        hrrr_runs = hrrr.discover_runs(client)
        log("[catalogs] hrrr cycles: "
            + (", ".join(f"{r['workspace']} ({len(r['hours'])}h)"
                         for r in hrrr_runs) or "none found"))

        log("[catalogs] probing gs01 national detection layers ...")
        national_probe = pyrecast.probe_gs01_national_layers(client)
        if national_probe:
            log(f"[catalogs] national perimeters layer: {national_probe['current_year_perimeters']['layer']}")
        else:
            log("[catalogs] national perimeters layer unavailable (frontend hides it)")

        weather = cat.build_weather_runs_hrrr(hrrr_runs, state.get("hrrr"))

        # ---- pre-render weather frames BEFORE uploading the manifests that
        # reference them (upload ordering = atomicity) ----------------------
        frames.start_deadline()  # FRAMES_MAX_SECONDS (default 720): the job
        # must always reach the manifest/catalog uploads below.
        log(f"[frames] budget={frame_budget} images"
            + (f" hours_limit={args.frames_hours}" if args.frames_hours else "")
            + (f" products_filter={sorted(products_filter)}" if products_filter else ""))
        budget_left = hrrr.sync_weather(
            client, storage, state, weather,
            budget=frame_budget, hours_limit=args.frames_hours,
            products_filter=products_filter, log=log)
        national_layers = frames.sync_national_frame(
            client, storage, national_probe, log=log)
        imsr_catalog = imsr.build_imsr_catalog(client, fires, log=log)
        log(f"[frames] images fetched this sync: {frame_budget - budget_left}")
        carried_forward = cat.retain_drawable_run(
            weather, storage.get_json("catalogs/weather_runs.json"))
        if carried_forward:
            log("[frames] no cycle rendered this sync — carried the previous "
                "drawable run forward so weather layers stay live")

    spread_index = {
        fire_key(entry.get("cornea_id")): {"latest": entry["runs"][0]["run_time"],
                                           "count": len(entry["runs"])}
        for entry in pyre["fires"].values()
        if entry["runs"]
    }

    # Incident maps: by fire ID once the incident-ID migration has run (the
    # mirror's index, no manifest reads or state repairs), else the legacy
    # slug-keyed matches.
    incident_fires = cat.catalog_incident_index(state)
    incident_matches = (_legacy_incident_matches(storage, state)
                        if incident_fires is None else None)
    _tick_prune_clock(state, fires, fires_meta,
                      storage.get_json("catalogs/catalog.json"))

    version = int(state.get("catalog_version", 0)) + 1
    hotspot_archives = hotspots.advertised(state)
    catalog = cat.build_catalog(
        fires, version=version,
        incident_matches=incident_matches, incident_fires=incident_fires,
        spread_index=spread_index,
        perimeter_counts=perimeter_counts,
        hotspot_archives=hotspot_archives,
        national_layers=national_layers,
    )

    # upload order: runs catalogs -> catalog.json LAST
    if imsr_catalog:
        storage.put_json("catalogs/imsr.json", imsr_catalog)
    storage.put_json("catalogs/pyrecast_runs.json", pyre)
    storage.put_json("catalogs/weather_runs.json", weather)
    storage.put_json(f"catalogs/versions/catalog.{version}.json", catalog)
    storage.put_json("catalogs/catalog.json", catalog)

    state["catalog_version"] = version
    state_mod.save_state(storage, state)

    weather_runs = weather["models"]["hrrr"]["runs"]
    gdal_ok = all(shutil.which(t) for t in ("gdalwarp", "gdaldem", "gdal_translate"))
    health.publish(storage, "catalogs", {
        "started_at": job_started,
        "finished_at": cat.now_iso(),
        "ok": True,
        "note": None if gdal_ok else "GDAL unavailable — weather frames skipped",
        "catalog_version": version,
        "fires": catalog["counts"]["active_fires"],
        "matched_incident_dirs": catalog["counts"]["matched_incident_dirs"],
        "spread_fires": catalog["counts"]["spread_forecast_fires"],
        "weather": {
            "gdal_available": gdal_ok,
            "images_fetched": frame_budget - budget_left,
            "carried_forward": carried_forward,
            "deadline_hit": frames.deadline_passed(),
            "runs": [
                {
                    "workspace": r["workspace"],
                    "rendered": len((r.get("frames") or {}).get("hours", [])),
                    "expected": len(r.get("hours") or []),
                }
                for r in weather_runs
            ],
        },
        "imsr": {
            "published": bool(imsr_catalog),
            "matched_fires": len((imsr_catalog or {}).get("fires", {})),
        },
    }, log=log)

    log(
        "[catalogs] done: "
        f"fires={catalog['counts']['active_fires']} "
        f"spread_fires={catalog['counts']['spread_forecast_fires']} "
        f"unmatched_slugs={len(pyre['unmatched_slugs'])} "
        f"weather_runs={len(weather_runs)} "
        f"weather_hours={[len(r['hours']) for r in weather_runs]} "
        f"catalog_version={version}"
    )
    return 0


def _legacy_incident_matches(storage, state: dict) -> dict[str, dict]:
    """Slug-keyed incident matches for build_catalog, from the records the
    pre-migration sync-incidents left (fire_slug -> match + counts). Heals
    missing counts from the published slug manifests and clears dir_mtime
    where a manifest never published. Only before the incident-ID migration:
    after it the catalog reads the fire-ID index instead."""
    # keep incident matches recorded by previous sync-incidents runs
    incident_matches: dict[str, dict] = {}
    healed = 0
    for inc_key, inc in state.get("incidents", {}).items():
        m = inc.get("match") or {}
        if inc.get("fire_slug") and m:
            # Self-heal directory counts: incidents mirrored before the counts
            # existed (or by a run that skipped them as unchanged) have no
            # map_count. Fires whose state carries a fossilized garbage date
            # (recorded before filename dates were validated) heal the same
            # way. Read the already-published manifest instead of re-crawling
            # the FTP — cheap, and it converges within the hour.
            bad_dates = (
                (inc.get("latest_upload") and not _valid_day(inc.get("latest_upload")))
                or (inc.get("latest_upload_ts") and not _valid_ts(inc.get("latest_upload_ts")))
            )
            if inc.get("map_count") is None or bad_dates:
                man = storage.get_json(
                    f"catalogs/incidents/{inc['fire_slug']}.json") or {}
                maps = man.get("maps") or []
                irs = man.get("ir_flights") or []
                if maps or irs:
                    # Manifests written before validation may carry garbage
                    # per-map dates too — resolve each through the same chain
                    # (validated filename date, else FTP upload time) and
                    # republish only if something actually changed.
                    changed = False
                    for x in maps:
                        if _valid_day(x.get("op_date")):
                            continue
                        reparsed = cat.parse_product_filename(x.get("filename") or "")
                        op = reparsed.get("op_date")
                        src = "filename" if op else None
                        if not op and x.get("uploaded_at"):
                            op, src = x["uploaded_at"][:10], "ftp"
                        if op != x.get("op_date") or src != x.get("date_source"):
                            x["op_date"] = op
                            x["date_source"] = src
                            if not cat.valid_local_minute(x.get("generated_at_local")):
                                x["generated_at_local"] = reparsed.get("generated_at_local")
                            changed = True
                    if changed:
                        storage.put_json(
                            f"catalogs/incidents/{inc['fire_slug']}.json", man)
                    dates = [x.get("op_date") for x in maps if _valid_day(x.get("op_date"))]
                    dates += [x.get("flight_date") for x in irs if _valid_day(x.get("flight_date"))]
                    ts = [x.get("uploaded_at") for x in maps if x.get("uploaded_at")]
                    inc["map_count"] = len(maps)
                    inc["ir_count"] = len(irs)
                    inc["latest_upload"] = max(dates) if dates else None
                    inc["latest_upload_ts"] = max(ts) if ts else None
                    healed += 1
                else:
                    # Matched+mirrored but its manifest never published (a
                    # deadline can land between mirroring and the manifest
                    # upload). Advertising the path would 404 (and B2 error
                    # responses carry no CORS headers, spamming the console).
                    # Clear the mtime so the next mirror run republishes from
                    # cache, and leave the fire un-advertised until then.
                    inc["dir_mtime"] = None
                    continue
            incident_matches[inc["fire_slug"]] = {
                "method": m.get("method"),
                "confidence": m.get("confidence"),
                "dir_url": inc.get("dir_url") or m.get("dir_url"),
                "synced_at": inc.get("synced_at"),
                "map_count": inc.get("map_count"),
                "ir_count": inc.get("ir_count"),
                "latest_upload": inc.get("latest_upload"),
                "latest_upload_ts": inc.get("latest_upload_ts"),
            }

    if healed:
        log(f"[catalogs] backfilled incident counts for {healed} fires from manifests")
    return incident_matches


# ===========================================================================
# sync-incidents / backfill
# ===========================================================================

def _collect_candidates(client, args, fires, *, target: dict | None = None,
                        state: dict | None = None) -> list[IncidentCandidate]:
    """Crawl region year-roots for candidate incident dirs.

    With a `target` fire (--fire) only its folders qualify: those named like
    it, and those already feeding it (bound to it, or lending it stamped
    files), whatever their name.
    """
    year = args.year
    fire_filter = None
    target_keys: set[str] = set()
    if target is not None:
        fire_filter = normalize_name(target.get("post_title") or target.get("fire_slug") or "")
        fk = fire_key(target.get("cornea_id"))
        st = state or {}
        target_keys = set(incident_ids.contributors(st).get(fk) or ())
        target_keys |= set(((st.get("incident_fires") or {}).get(fk) or {}).get("dirs") or ())
    roots = config.region_year_roots(year)
    if args.region:
        roots = [(r, u) for r, u in roots if r.startswith(args.region)]

    from .ftp_index import parse_autoindex

    def state_of(dir_name: str) -> str | None:
        name = dir_name.rstrip("/").replace("%20", " ").replace("_", " ").lower()
        return name if name in config.STATE_NAME_ABBR else None

    def wanted(cand: IncidentCandidate) -> bool:
        if target is None or cand.key in target_keys:
            return True
        dir_norm = normalize_name(cand.dir_name)
        return bool(fire_filter) and (fire_filter in dir_norm or dir_norm in fire_filter)

    cands: list[IncidentCandidate] = []
    extra_roots: list[tuple[str, str, bool]] = []  # (region_key, url, lenient)

    # The Southern/Eastern GACCs hide incidents in per-STATE subdirs at BOTH
    # placements: {gacc}/{State}/{year}/ (southern/Texas/2026/Ross_2026) and
    # {gacc}/{year}/{State}/ (southern/2026/Florida/...).
    for region in sorted(config.STATE_SUBDIR_REGIONS):
        if args.region and not region.startswith(args.region):
            continue
        gacc_root = f"{config.FTP_BASE}/{region}/"
        resp = get_optional(client, gacc_root)
        if resp is None:
            continue
        for e in parse_autoindex(resp.text, gacc_root):
            st_name = state_of(e.name) if e.is_dir else None
            if st_name:
                key = f"{region}_{st_name.replace(' ', '_')}"
                extra_roots.append((key, f"{e.url.rstrip('/')}/{year}/", True))

    for region, root_url in roots:
        resp = get_optional(client, root_url)
        if resp is None:
            continue

        for e in parse_autoindex(resp.text, root_url):
            if not e.is_dir:
                continue
            if region in config.STATE_SUBDIR_REGIONS:
                st_name = state_of(e.name)
                if st_name:
                    key = f"{region}_{st_name.replace(' ', '_')}"
                    extra_roots.append((key, e.url.rstrip('/') + '/', True))
                    continue
            rest = candidate_dir_name(e.name + "/", year)
            if rest is None:
                continue
            cand = IncidentCandidate(
                region=region, year=year, dir_name=e.name,
                dir_url=e.url, dir_mtime=e.mtime,
            )
            if wanted(cand):
                cands.append(cand)

    # Crawl the collected state subdirectory roots with lenient naming.
    seen_urls = {c.dir_url for c in cands}
    for region, root_url, lenient in extra_roots:
        resp = get_optional(client, root_url)
        if resp is None:
            continue
        for e in parse_autoindex(resp.text, root_url):
            if not e.is_dir:
                continue
            rest = candidate_dir_name(e.name + "/", year, lenient=lenient)
            if rest is None:
                continue
            if e.url in seen_urls:
                continue
            cand = IncidentCandidate(
                region=region, year=year, dir_name=e.name,
                dir_url=e.url, dir_mtime=e.mtime,
            )
            if wanted(cand):
                cands.append(cand)
                seen_urls.add(e.url)
    return cands


def _drop_key_collisions(cands: list[IncidentCandidate], state: dict | None = None
                         ) -> tuple[list[IncidentCandidate], list[dict]]:
    """One candidate per incident key. Two folders can map to one key (the
    state subdirectories fold into their GACC: southern/Texas/2026/Ross_2026
    and southern/2026/Florida/Ross_2026), and one record must never take in
    both folders' files: the folder the record was mirrored from keeps the
    key, else the first listed; the others are reported."""
    incidents = (state or {}).get("incidents") or {}
    by_key: dict[str, list[IncidentCandidate]] = {}
    for c in cands:
        by_key.setdefault(c.key, []).append(c)
    kept: dict[str, IncidentCandidate] = {}
    collisions: list[dict] = []
    for c in cands:
        group = by_key[c.key]
        own = (incidents.get(c.key) or {}).get("dir_url")
        keep = next((g for g in group if own and g.dir_url == own), group[0])
        if c is keep:
            kept.setdefault(c.key, c)
        elif c.dir_url != keep.dir_url:
            collisions.append({"key": c.key, "kept": keep.dir_url, "dropped": c.dir_url})
            log(f"[incidents] {c.key}: KEY COLLISION — {c.dir_url} dropped, "
                f"{keep.dir_url} keeps the key")
    return list(kept.values()), collisions


def _resolve_fire_arg(value: str, fires: list[dict]) -> dict | None:
    """--fire: the active fire with that fire key (any spelling of its
    cornea_id) or, failing that, that fire_slug."""
    fk = fire_key(value)
    by_id = next((f for f in fires if fk and fire_key(f.get("cornea_id")) == fk), None)
    return by_id or next((f for f in fires if f.get("fire_slug") == value), None)


def _override_key(value: str | None) -> str | None:
    """An override as compared between runs ('ignore', a fire key, or the
    raw value), so another spelling of the same GUID is no change."""
    if not value or value == "ignore":
        return value or None
    return fire_key(value) if is_fire_id(value) else value


def _rank_candidates(cands: list[IncidentCandidate], fires: list[dict],
                     priority: list[str]) -> list[IncidentCandidate]:
    """Order the crawl so the most useful incidents are mirrored first.

    Runs are wall-clock bounded, so ORDER decides what exists on the site after
    a partial sync. Ranking is name-only (no extra FTP requests): explicit
    --priority-fires first, then biggest acreage, then most recently updated.
    """
    prio = {normalize_name(p) for p in priority if p.strip()}
    prio |= {p.strip().replace("-", "").lower() for p in priority if p.strip()}

    by_norm: dict[str, dict] = {}
    for f in fires:
        by_norm.setdefault(normalize_name(f.get("post_title") or ""), f)
        by_norm.setdefault((f.get("fire_slug") or "").replace("-", ""), f)

    def _epoch(iso: str | None) -> float:
        if not iso:
            return 0.0
        try:
            return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return 0.0

    def sort_key(c: IncidentCandidate) -> tuple:
        rest = candidate_dir_name(c.dir_name + "/", c.year) or c.dir_name
        norm = normalize_name(rest)
        fire = by_norm.get(norm) or {}
        return (
            0 if norm in prio else 1,                 # explicit priority first
            -float(fire.get("acres") or 0),           # then biggest fires
            -_epoch(fire.get("last_updated")),        # then most recently updated
        )

    return sorted(cands, key=sort_key)


def _gather_unit_tokens(client, cand: IncidentCandidate) -> Counter:
    """Unit-token evidence from newest daily Products|GIS dir + QR filenames.

    The same listings also date the folder: the newest file (and, as a
    fallback, child-dir) mtimes land on the candidate for the matcher's date
    sanity check — no extra requests.
    """
    tokens: Counter = Counter()

    def see(entries) -> None:
        for e in entries:
            if not e.mtime:
                continue
            if e.is_dir:
                if not cand.newest_dir_mtime or e.mtime > cand.newest_dir_mtime:
                    cand.newest_dir_mtime = e.mtime
            elif not cand.newest_file_mtime or e.mtime > cand.newest_file_mtime:
                cand.newest_file_mtime = e.mtime

    children = list_dir(client, cand.dir_url)
    see(children)
    for child in children:
        if not child.is_dir:
            continue
        lname = child.name.lower()
        if lname in ("products", "gis"):
            entries = list_dir(client, child.url)
            see(entries)
            dailies = sorted(
                (e for e in entries if e.is_dir and e.name.isdigit() and len(e.name) == 8),
                key=lambda e: e.name, reverse=True,
            )
            for daily in dailies[:2]:
                files = list_dir(client, daily.url)
                see(files)
                tokens += extract_unit_tokens([f.name for f in files if not f.is_dir],
                                              year=cand.year)
                if tokens:
                    break
        elif lname == "qr":
            files = list_dir(client, child.url)
            see(files)
            tokens += extract_unit_tokens([f.name for f in files if not f.is_dir],
                                          year=cand.year)
    return tokens


def _cached_match_predates_fire(rec: dict, fires_by_fk: dict) -> str | None:
    """Reason when a cached NAME match fails the date sanity check, else None.

    Unchanged folders skip matching entirely, so a bad match made before the
    check existed would otherwise live forever. The fire is looked up by the
    record's cornea_id, never by slug (a slug can move to a newer same-name
    fire and detach a valid folder), and the folder is dated by its own
    newest upload, not by counts merged across the fire's folders.
    """
    m = rec.get("match") or {}
    if m.get("method") not in incident_ids.NAME_METHODS:
        return None
    fire = fires_by_fk.get(fire_key(rec.get("cornea_id")))
    if not fire:
        return None
    return incident_ids.record_predates_fire(rec, m.get("method"), fire.get("created_on"))


def _process_mirrored_assets(args, storage, state, mirrors) -> None:
    """GeoPDF tiles and previews for the sheets this run downloaded.

    Only files with a local copy that holds the bytes state names for the
    file: a rel downloaded twice in one run keeps only its last bytes, and
    an earlier copy is superseded. The local bytes are hashed once more
    before anything is written under their sha. Each sha is done once,
    under the prefix its tiles already have (or the first owning
    record's); files that show on no fire and files with no sha are
    skipped. Replayed sheets are the backlogs' job, and manifests are built
    afterwards from state (fire_manifests).
    """
    tile_budget = args.tile_budget
    # Re-arm the wall-clock for the tiling phase (and the IR conversions of
    # the manifest build after it): a single arch-E sheet can take minutes,
    # so the 40-sheet count budget alone let this phase blow past the CI
    # timeout (killing the job before ANY manifest was published). Sheets
    # past the deadline are flagged tiling_pending and picked up next run.
    frames.start_deadline(int(os.environ.get(
        "TILE_MAX_SECONDS", str(config.TILE_MAX_SECONDS_DEFAULT))))
    if not geopdf.gdal_available():
        log("[incidents] GDAL not available — skipping tiling (degrades to raw PDFs)")
        return
    tiles_deferred = 0
    # The same sheet is often published in two places (e.g. "Current Maps/"
    # AND "Daily Products/{date}/"), and in two folders: tile it once.
    seen_sha: set[str] = set()

    for inc_key, bundle in mirrors.items():
        rec = state["incidents"].get(inc_key) or {}
        files = rec.get("files") or {}
        for mf in bundle["result"].files:
            sha = mf.sha16
            if (mf.local_path is None or not sha or sha in seen_sha
                    or mf.kind in ("ir", "mobile")
                    or not mf.filename.lower().endswith(".pdf")):
                continue
            meta = files.get(f"{mf.rel_dir}/{mf.filename}")
            if (meta is None or meta.get("sha16") != sha
                    or incident_ids.file_owner(rec, meta) is None):
                continue  # superseded later this run, or shown on no fire
            seen_sha.add(sha)
            tiled_state = state["tiled"].get(sha)
            if tiled_state and tiled_state.get("tiler_version") == config.TILER_VERSION:
                continue  # already tiled
            if sha16_file(mf.local_path) != sha:
                # tiles and previews are keyed by this sha: never from
                # other bytes (another copy of the sheet may still verify)
                log(f"[geopdf] {mf.filename}: local copy does not hash to {sha} — skipped")
                seen_sha.discard(sha)
                continue
            parsed = cat.parse_product_filename(mf.filename)
            if tile_budget <= 0 or frames.deadline_passed():
                # Out of tiling budget, but detection is cheap: record
                # whether this sheet is EVEN overlayable plus a preview, so
                # the UI can offer a lightbox for flat sheets instead of an
                # indefinite "processing…".
                probe = geopdf.probe_pdf(mf.local_path)
                geo = {
                    "georeferenced": probe["georeferenced"],
                    "projection": probe.get("projection"),
                    "tiles": None,
                    "preview": False,
                }
                if probe.get("error"):
                    geo["error"] = probe["error"]
                try:
                    with tempfile.TemporaryDirectory() as td:
                        preview = Path(td) / "preview.png"
                        geopdf.render_preview(mf.local_path, preview)
                        storage.put_file(preview_key(state, sha, rec), preview)
                        geo["preview"] = True
                except Exception as exc:
                    log(f"[geopdf] preview failed for {mf.filename}: {exc}")
                # Only georeferenced sheets have tiling still owed.
                if probe["georeferenced"]:
                    tiles_deferred += 1
                put_tiled(state, sha, record_prefix(rec), {
                    # A flat sheet is DONE — nothing to tile, so don't let
                    # it consume tiling budget on every future run. A
                    # georeferenced one keeps tiler_version None so the
                    # next run picks it up.
                    "tiler_version": None if probe["georeferenced"] else config.TILER_VERSION,
                    "at": state_mod.now_iso(),
                    "geo": geo,
                })
                continue
            log(f"[geopdf] processing {mf.filename} ...")
            with tempfile.TemporaryDirectory() as td:
                tiles_dir = Path(td) / "tiles"
                r = geopdf.process_pdf(
                    mf.local_path, tiles_dir,
                    sheet=parsed.get("sheet"), zoom_cap=args.zoom_cap,
                )
                geo = {
                    "georeferenced": r["georeferenced"],
                    "projection": r["projection"],
                    "tiles": r["tiles"],
                    "preview": False,
                }
                if r.get("error"):
                    geo["error"] = r["error"]
                if r["tiles"]:
                    n = storage.put_tree(tile_root(tiles_prefix(state, sha, rec), sha), tiles_dir)
                    log(f"[geopdf] {mf.filename}: {n} tiles "
                        f"z{r['tiles']['minzoom']}-{r['tiles']['maxzoom']}")
                try:
                    preview = Path(td) / "preview.png"
                    geopdf.render_preview(mf.local_path, preview)
                    storage.put_file(preview_key(state, sha, rec), preview)
                    geo["preview"] = True
                except Exception as exc:  # preview failure is never fatal
                    log(f"[geopdf] preview failed for {mf.filename}: {exc}")
            tile_budget -= 1
            put_tiled(state, sha, record_prefix(rec), {
                "tiler_version": config.TILER_VERSION,
                "at": state_mod.now_iso(),
                "geo": geo,
            })

    if tiles_deferred:
        log(f"[geopdf] {tiles_deferred} sheets deferred (tile budget/deadline) — "
            "flagged tiling_pending, picked up next run")


def _sha_in_shard(sha: str, shard: int, shards: int) -> bool:
    try:
        return int(sha[:8], 16) % shards == shard
    except ValueError:
        return shard == 0


def _pending_sheets(state) -> list[tuple[str, str, list[str]]]:
    """(sha, tiles prefix, raw keys) for every probed-georeferenced sheet
    still owed tiles, deduped by sha (the same sheet can appear in several
    folders). The prefix is where the sha's tiles go (asset_keys.tiles_prefix
    of the first record holding it); the raw keys are every copy of its
    bytes, that record's first.

    Before the incident-ID migration nothing is stamped and no file has an
    owner, so this is exactly the old selection and keys: the first holder's
    fire_slug, its raw key first. After it, files that show on no fire
    (hidden, unresolved, ignored) and pruned files are skipped.
    """
    by_id = incident_ids.migrated(state)
    out: list[tuple[str, str, list[str]]] = []
    seen: set[str] = set()
    for inc in state.get("incidents", {}).values():
        if not (inc.get("storage_prefix") or inc.get("fire_slug")):
            continue
        for rel, meta in (inc.get("files") or {}).items():
            sha = meta.get("sha16")
            if (not sha or sha in seen or meta.get("kind") == "ir"
                    or meta.get("pruned_at")):
                continue
            if by_id and incident_ids.file_owner(inc, meta) is None:
                continue
            rec = state["tiled"].get(sha)
            if (not rec or rec.get("tiler_version") is not None
                    or not (rec.get("geo") or {}).get("georeferenced")):
                continue
            seen.add(sha)
            raw_keys = list(dict.fromkeys([raw_key(inc, rel),
                                           *raw_key_candidates(state, sha)]))
            out.append((sha, tiles_prefix(state, sha, inc), raw_keys))
    return out


def cmd_tile_worker(args) -> int:
    """Stateless parallel tiler (tile.yml matrix): tiles pending sheets from
    OUR bucket and uploads tree + meta.json. Never writes state or catalogs —
    the serialized mirror run adopts finished markers — so any number of
    shards run concurrently with everything else."""
    storage = make_storage(args.dry_run, args.out)
    state = state_mod.load_state(storage)  # read-only snapshot
    frames.start_deadline(args.max_seconds)
    if not geopdf.gdal_available():
        log("[tilew] GDAL unavailable — nothing to do this run")
        return 0

    todo = [t for t in _pending_sheets(state)
            if _sha_in_shard(t[0], args.shard, args.shards)]
    log(f"[tilew] shard {args.shard}/{args.shards}: {len(todo)} pending sheet(s)")
    done = 0
    for sha, prefix, raw_keys in todo:
        if frames.deadline_passed():
            log("[tilew] deadline — remaining sheets next run")
            break
        if storage.get_json(tile_meta_key(prefix, sha)):
            continue  # another worker already finished this one
        with tempfile.TemporaryDirectory(prefix="tilew_") as td:
            local = Path(td) / "sheet.pdf"
            # Tiles are keyed by the sheet's sha, so only bytes that hash to
            # it may be tiled: a shared prefix let one folder overwrite
            # another's raw key with different bytes.
            key = fetch_verified(storage, raw_keys, sha, local, log)
            if key is None:
                log(f"[tilew] {sha}: no raw copy matches its sha — skipped")
                continue
            parsed = cat.parse_product_filename(key.rpartition("/")[2])
            tiles_dir = Path(td) / "tiles"
            r = geopdf.process_pdf(local, tiles_dir,
                                   sheet=parsed.get("sheet"),
                                   zoom_cap=args.zoom_cap)
            if not r["tiles"]:
                log(f"[tilew] {key}: not tileable ({r.get('error')})")
                continue
            n = storage.put_tree(tile_root(prefix, sha), tiles_dir)
            storage.put_json(tile_meta_key(prefix, sha), {
                "tiler_version": config.TILER_VERSION,
                "georeferenced": True,
                "projection": r["projection"],
                "tiles": r["tiles"],
            })
            log(f"[tilew] {key}: {n} tiles z{r['tiles']['minzoom']}-{r['tiles']['maxzoom']}")
            done += 1
    log(f"[tilew] shard {args.shard}/{args.shards}: tiled {done}")
    return 0


def _sha_holders(state: dict, sha: str) -> set[str]:
    """Keys of every incident record holding a file with this sha: a sheet
    tiled or probed once shows in every folder that published it."""
    return {k for k, rec in state.get("incidents", {}).items()
            if any(m.get("sha16") == sha for m in (rec.get("files") or {}).values())}


def _tile_backlog(storage, state, log, *, cap: int = 12, zoom_cap: int | None = None,
                  mismatches: list[str] | None = None) -> set[str]:
    """Tile sheets that were probed georeferenced but never got tiles.

    The mirror loop only tiles freshly-downloaded files; a sheet deferred by
    the budget is replayed on later runs WITHOUT a local file, so low-priority
    products (pio, transport) could stay "overlay rendering" forever. Their
    bytes are in our bucket: download up to `cap` per run (only bytes that
    hash to the sheet's sha: asset_keys.fetch_verified), tile under the
    sha's tiles prefix, and return the incident keys whose manifests need a
    rebuild. Sheets that show on no fire, and pruned files, are skipped.
    `mismatches` collects raw keys whose bytes did not hash (health)."""
    if not geopdf.gdal_available():
        return set()
    touched: set[str] = set()
    tried: set[str] = set()
    tiled = 0
    for inc_key, inc in state.get("incidents", {}).items():
        if tiled >= cap or frames.deadline_passed():
            break
        if not (inc.get("storage_prefix") or inc.get("fire_slug")):
            continue
        for rel, meta in (inc.get("files") or {}).items():
            if tiled >= cap or frames.deadline_passed():
                break
            if meta.get("kind") == "ir":
                continue  # IR PDFs aren't map overlays; never tile them
            sha = meta.get("sha16")
            rec = state["tiled"].get(sha) if sha else None
            if (not rec or rec.get("tiler_version") is not None
                    or not (rec.get("geo") or {}).get("georeferenced")):
                continue
            if (sha in tried or meta.get("pruned_at")
                    or incident_ids.file_owner(inc, meta) is None):
                continue
            tried.add(sha)
            prefix = tiles_prefix(state, sha, inc)
            # A stateless tile worker may already have finished this sheet —
            # adopt its marker (cheap) instead of re-tiling.
            marker = storage.get_json(tile_meta_key(prefix, sha))
            if marker and marker.get("tiles"):
                geo = dict(rec.get("geo") or {})
                geo["georeferenced"] = True
                geo["projection"] = marker.get("projection")
                geo["tiles"] = marker["tiles"]
                put_tiled(state, sha, record_prefix(inc), {
                    "tiler_version": marker.get("tiler_version",
                                                config.TILER_VERSION),
                    "at": state_mod.now_iso(),
                    "geo": geo,
                })
                touched |= _sha_holders(state, sha)
                continue
            keys = list(dict.fromkeys([raw_key(inc, rel), *raw_key_candidates(state, sha)]))
            parsed = cat.parse_product_filename(rel.rpartition("/")[2])
            with tempfile.TemporaryDirectory(prefix="tilebk_") as td:
                local = Path(td) / "sheet.pdf"
                if fetch_verified(storage, keys, sha, local, log, mismatches=mismatches) is None:
                    continue
                log(f"[geopdf] backlog tiling {rel} ...")
                tiles_dir = Path(td) / "tiles"
                r = geopdf.process_pdf(local, tiles_dir,
                                       sheet=parsed.get("sheet"),
                                       zoom_cap=zoom_cap)
                geo = dict(rec.get("geo") or {})
                geo["georeferenced"] = r["georeferenced"]
                geo["projection"] = r["projection"]
                geo["tiles"] = r["tiles"]
                if r.get("error"):
                    geo["error"] = r["error"]
                if r["tiles"]:
                    n = storage.put_tree(tile_root(prefix, sha), tiles_dir)
                    storage.put_json(tile_meta_key(prefix, sha), {
                        "tiler_version": config.TILER_VERSION,
                        "georeferenced": True,
                        "projection": r["projection"],
                        "tiles": r["tiles"],
                    })
                    log(f"[geopdf] backlog {rel}: {n} tiles "
                        f"z{r['tiles']['minzoom']}-{r['tiles']['maxzoom']}")
                put_tiled(state, sha, record_prefix(inc), {
                    "tiler_version": config.TILER_VERSION,
                    "at": state_mod.now_iso(),
                    "geo": geo,
                })
                tiled += 1
                touched |= _sha_holders(state, sha)
    if tiled:
        log(f"[geopdf] tile backlog: {tiled} sheet(s) this run")
    return touched


def _probe_backlog(storage, state, log, *, cap: int = 40,
                   mismatches: list[str] | None = None) -> set[str]:
    """Classify already-mirrored PDFs that predate georeference detection.

    Sheets mirrored by early runs (or replayed by retention) have no
    state["tiled"] record, so manifests could only guess georeferenced=False —
    Big Grass showed 45 real map sheets as "flat". Retention means they will
    never be re-fetched from the FTP, but the bytes are in OUR bucket: download
    up to `cap` per run (verified against the sha, asset_keys.fetch_verified),
    gdalinfo-probe + preview them, and return the incident keys that gained
    classifications (their manifests need a rebuild). Sheets that show on no
    fire, and pruned files, are skipped.
    Bounded by cap and the shared wall clock; converges in a few runs.
    """
    if not geopdf.gdal_available():
        return set()
    touched: set[str] = set()
    tried: set[str] = set()
    probed = 0
    for inc_key, inc in state.get("incidents", {}).items():
        if probed >= cap or frames.deadline_passed():
            break
        if not (inc.get("storage_prefix") or inc.get("fire_slug")):
            continue
        for rel, meta in (inc.get("files") or {}).items():
            if probed >= cap or frames.deadline_passed():
                break
            sha = meta.get("sha16")
            if (not sha or not rel.lower().endswith(".pdf")
                    or meta.get("kind") == "mobile"):
                continue
            if (sha in tried or meta.get("pruned_at")
                    or incident_ids.file_owner(inc, meta) is None):
                continue
            is_ir = meta.get("kind") == "ir"
            rec = state["tiled"].get(sha)
            if rec is not None and is_ir:
                continue  # IR PDFs only ever need the card thumbnail
            if rec is not None:
                # Repair passes, each attempted once per sheet:
                #  - broken records (no preview, no tiles) from failed probes
                #  - flat records that predate graticule-text georeferencing
                #    (a re-probe may now pin them down and queue tiling)
                geo0 = rec.get("geo") or {}
                broken = (not geo0.get("preview") and not geo0.get("tiles")
                          and not rec.get("repair_at"))
                flat_regrat = (not geo0.get("georeferenced")
                               and not rec.get("grat_at"))
                if not broken and not flat_regrat:
                    continue
            tried.add(sha)
            keys = list(dict.fromkeys([raw_key(inc, rel), *raw_key_candidates(state, sha)]))
            with tempfile.TemporaryDirectory(prefix="probe_") as td:
                local = Path(td) / "sheet.pdf"
                if fetch_verified(storage, keys, sha, local, log, mismatches=mismatches) is None:
                    continue  # no copy of these bytes — nothing to classify
                probe = geopdf.probe_pdf(local)
                geo = {
                    "georeferenced": probe["georeferenced"],
                    "projection": probe.get("projection"),
                    "tiles": None,
                    "preview": False,
                }
                try:
                    preview = Path(td) / "preview.png"
                    geopdf.render_preview(local, preview)
                    storage.put_file(preview_key(state, sha, inc), preview)
                    geo["preview"] = True
                except Exception as exc:
                    log(f"[probe] preview failed for {rel}: {exc}")
                put_tiled(state, sha, record_prefix(inc), {
                    "repair_at": state_mod.now_iso(),
                    "grat_at": state_mod.now_iso(),
                    # georeferenced sheets keep tiler_version None -> the
                    # normal tiling budget picks them up from B2 next runs
                    # (IR PDFs never: they aren't map overlays)
                    "tiler_version": (None if probe["georeferenced"] and not is_ir
                                      else config.TILER_VERSION),
                    "at": state_mod.now_iso(),
                    "geo": geo,
                })
                probed += 1
                touched |= _sha_holders(state, sha)
    if probed:
        log(f"[probe] classified {probed} previously-unprobed sheets "
            f"across {len(touched)} incidents")
    return touched


def _ir_backlog(state: dict, fires_by_fk: dict, log) -> set[str]:
    """Active fires owed an IR conversion. State-only scan, zero network: for
    each record, IR flight folder and active fire owning files in it, the
    flight's source (incident_ids.choose_ir_source, as the manifest build
    picks it) has no conversion stamped for its current bytes, or one made
    by an older converter. Returns FIRE keys: rebuilding a fire's manifest
    runs the conversion. A failed attempt under the current converter counts
    as done (no retry loop); a converter bump converts every flight again,
    into new versioned keys, never over old ones. A mixed folder whose
    sources name other fires has no source for the owner, so it is never
    flagged."""
    names = fire_manifests.active_fire_names(fires_by_fk)
    ir_state = state.get("ir") or {}
    owed: set[str] = set()
    for rec in state.get("incidents", {}).values():
        files = rec.get("files") or {}
        flights: set[tuple[str, str]] = set()  # (flight folder, owner)
        for rel, meta in files.items():
            if meta.get("kind", rel.split("/", 1)[0]) != "ir":
                continue
            owner = incident_ids.file_owner(rec, meta)
            if owner in fires_by_fk:
                flights.add((rel.rpartition("/")[0], owner))
        for rel_dir, fk in sorted(flights):
            if fk in owed:
                continue
            fire = fires_by_fk[fk]
            src, _mixed = incident_ids.choose_ir_source(
                rec, rel_dir, fk,
                incident_ids.name_norm(fire.get("post_title") or fire.get("name")), names)
            if src is None:
                continue
            e = ir_entry(rec, src, files[src])
            conv = ir_state.get(e["key"]) if e else None
            if conv is None or conv.get("v") != ir_vectors.IR_CONVERTER_VERSION:
                owed.add(fk)
    if owed:
        log(f"[incidents] IR backlog: {len(owed)} fires have unconverted flights — "
            "queuing manifest rebuilds")
    return owed


def _ftp_outage_entry(job_started: str, exc: BaseException) -> dict:
    """Health failure record for a run that never reached the FTP host."""
    host = urlparse(config.FTP_BASE).netloc or config.FTP_BASE
    detail = f"{type(exc).__name__}: {exc}".strip().rstrip(":")
    return {
        "started_at": job_started,
        "finished_at": cat.now_iso(),
        "note": f"FTP unreachable ({host}): {detail}",
        "error": "ftp_unreachable",
    }


def _zero_mirror_entry() -> dict:
    """Shape of a mirror heartbeat with nothing done — seeds the section when
    the very first run in a deployment fails (the page needs the fields)."""
    return {
        "catalog_version": 0,
        "candidates": 0,
        "unchanged_skips": 0,
        "mirrored_incidents": 0,
        "files_downloaded": 0,
        "bytes_downloaded": 0,
        "failed_incidents": [],
        "date_rejected": [],
        "deadline_hit": False,
        "gdal_available": geopdf.gdal_available(),
        "unresolved": [],
        "rebinds": [],
        "rebind_refused": [],
        "override_errors": [],
        "key_collisions": [],
        "refreshed": 0,
        "rebuilt_fires": [],
        "raw_sha_mismatch": [],
        "ir_mixed_hidden": [],
    }


def cmd_sync_incidents(args) -> int:
    """Crawl the FTP, bind each incident folder to a fire by ID, mirror it,
    and publish the ID manifest of every fire whose folders changed.

    A folder's record is bound by cornea_id (incident_ids): a fresh match to
    another fire rebinds it with each file weighed by its own name
    (rebind_decision / apply_bind), and every fire it touched is rebuilt.
    A folder of an active fire whose root is unchanged is still re-listed
    under its binding, without matching, so new daily folders a level down
    are picked up; its fires are rebuilt only when something came in.
    Upload order: raw, tiles, previews; each fire's manifest, then its
    index entry; state; then the catalog (fire_manifests.publish_catalog).
    """
    job_started = cat.now_iso()
    storage = make_storage(args.dry_run, args.out)
    state = state_mod.load_state(storage)
    if not state["incidents"]:
        # A fresh deployment (no state/state.json, or no folder mirrored
        # yet) has nothing keyed by fire slug: it starts keyed by fire ID.
        state.setdefault("migrations", {})["incident_ids"] = cat.now_iso()
    if not incident_ids.migrated(state):
        # The records are still keyed by fire slug. Matching them by fire ID
        # would treat every folder as new and orphan its files, so the mirror
        # pauses until the incident-ID migration has run: visibly, as a
        # failure that keeps the last run's numbers, and with no FTP, state
        # or catalog writes.
        log("[incidents] state is not keyed by fire ID yet — paused until "
            "migrate-incident-ids is applied (maint.yml)")
        health.publish_failure(storage, "mirror", {
            "started_at": job_started,
            "finished_at": cat.now_iso(),
            "note": "paused: awaiting incident-ID migration (maint.yml)",
            "error": "paused_migration",
        }, defaults=_zero_mirror_entry(), log=log)
        return 0
    overrides = config.load_match_overrides()

    with make_client() as client:
        log("[incidents] fetching active fires ...")
        fires = fetch_active_fires(client)
        fires_by_fk = {fk: f for f in fires if (fk := fire_key(f.get("cornea_id")))}
        log(f"[incidents] active wildfires: {len(fires)}")
        target = None
        if args.fire:
            target = _resolve_fire_arg(args.fire, fires)
            if target is None:
                log(f"[incidents] --fire {args.fire}: no active fire has that fire key or slug")
                return 2
            log(f"[incidents] --fire {args.fire}: {target.get('post_title')} "
                f"({target.get('cornea_id')})")
        target_fk = fire_key(target.get("cornea_id")) if target else None

        # Fire keys whose manifests this run rebuilds.
        rebuild: set[str] = set()
        mismatches: list[str] = []  # raw keys whose bytes did not hash (health)

        # Classify legacy sheets from B2 before crawling, so this run's
        # manifests already reflect the corrections. The two sheet backlogs
        # return incident keys (every fire those folders show files on is
        # rebuilt), the IR backlog returns fire keys.
        frames.start_deadline(int(os.environ.get(
            "MIRROR_MAX_SECONDS", str(config.MIRROR_MAX_SECONDS_DEFAULT))))
        touched_inc = _probe_backlog(storage, state, log, mismatches=mismatches)
        touched_inc |= _tile_backlog(storage, state, log, zoom_cap=args.zoom_cap,
                                     mismatches=mismatches)
        for inc_key in touched_inc:
            rebuild |= incident_ids.owners_of(state["incidents"][inc_key])
        rebuild |= _ir_backlog(state, fires_by_fk, log)

        log("[incidents] crawling FTP year roots for candidate dirs ...")
        try:
            cands = _collect_candidates(client, args, fires, target=target, state=state)
        except httpx.TransportError as exc:
            # The FTP host itself is down: connect/read timeouts that outlive
            # the retry budget before a single listing arrives. There is
            # nothing to mirror, so fail the run — but record the outage on
            # the heartbeat first, so /health can say WHY the maps are stale
            # (a bare crash publishes nothing and looks like a scheduler gap).
            log(f"[incidents] FTP unreachable, aborting run: "
                f"{type(exc).__name__}: {exc}")
            health.publish_failure(storage, "mirror",
                                   _ftp_outage_entry(job_started, exc),
                                   defaults=_zero_mirror_entry(), log=log)
            return 1
        cands, key_collisions = _drop_key_collisions(cands, state)
        priority = [x for x in (args.priority_fires or "").split(",") if x.strip()]
        cands = _rank_candidates(cands, fires, priority)
        unchanged_skips = 0
        refreshed = 0  # unchanged folders of active fires that brought something new (3.9)
        failed_incidents: list[str] = []
        date_rejected: list[str] = []  # cached name matches dropped by the date check
        rebinds: list[dict] = []
        rebind_refused: list[dict] = []
        override_errors: list[dict] = []
        log(f"[incidents] candidate incident dirs: {len(cands)}"
            + (f" (priority: {', '.join(priority)})" if priority else "")
            + " — ordered priority, then acreage desc")

        # Wall-clock budget: the job must ALWAYS reach tiling + manifest +
        # catalog publication and state save below — a run killed by the CI
        # timeout publishes nothing and loses its checkpoints (observed on the
        # first full mirror). Remaining incidents defer to the next 6-hourly
        # run; per-file state means nothing re-downloads.
        frames.start_deadline(int(os.environ.get(
            "MIRROR_MAX_SECONDS", str(config.MIRROR_MAX_SECONDS_DEFAULT))))

        def new_mirror() -> IncidentMirror:
            return IncidentMirror(
                client, storage, state,
                max_file_mb=args.max_file_mb,
                max_files=args.max_pdfs,
                products_keep=args.products_keep,
                ir_keep=args.ir_keep,
                since=args.since,
                force=args.force,
            )

        def checkpoint() -> None:
            # Per-incident save: files already on B2 must not re-download if
            # this run dies. The rebuild set lives only in memory, so every
            # fire it names is first marked stale in the index (v=0, as
            # reassign-files does): a run killed before publication still
            # rebuilds them next time (fire_manifests.stale_index_fks).
            idx = state.get("incident_fires") or {}
            for fk in rebuild:
                if fk in idx:
                    idx[fk]["v"] = 0
            state_mod.save_state(storage, state)

        mirrors: dict[str, dict] = {}
        matched = 0
        deferred = 0
        for cand in cands:
            if frames.deadline_passed():
                deferred += 1
                continue
            key = cand.key
            prev = state["incidents"].get(key)
            ov = overrides.get(key)
            now = cat.now_iso()
            # Every fire the folder shows files on before this run touches
            # it. A rebind, an override or a new revision can take a file off
            # any of them, and a fire the folder still lends other files to
            # keeps its index entry's dirs, so stale_index_fks never sees it.
            before = incident_ids.owners_of(prev) if prev else set()

            # Re-validate a cached name match before trusting it: detach the
            # folder (its mirrored files stay — retention) and fall through
            # to a fresh match, which applies the same date check.
            stale = _cached_match_predates_fire(prev, fires_by_fk) if prev else None
            if stale:
                old = incident_ids.prior_owner(prev)
                log(f"[incidents] {key}: cached {prev['match'].get('method')} match to "
                    f"{prev.get('cornea_id')} REJECTED — {stale}")
                prev["match_rejected"] = {
                    "cornea_id": prev.get("cornea_id"),
                    "method": prev["match"].get("method"),
                    "reason": stale,
                    "at": now,
                }
                prev["match"] = None
                if old:
                    rebuild.add(old)
                date_rejected.append(key)

            # --since widens the mirror window, so an unchanged dir still
            # needs re-listing on a backfill run.
            if (prev and not args.force and not args.since
                    and prev.get("dir_mtime") == cand.dir_mtime
                    and _override_key(prev.get("override")) == _override_key(ov)):
                bound_fk = incident_ids.prior_owner(prev)
                if bound_fk in fires_by_fk and target_fk in (None, bound_fk):
                    # Nothing new at the folder's root, but a new daily
                    # folder lands a level down (Products/20261008) without
                    # touching it, and a child a deferral cut short is still
                    # unstamped. Re-list the folder under its binding, with
                    # no re-match: unchanged children replay from state, and
                    # the record's match, bound and region stay as they are
                    # (a region from the crawl would change the manifest's
                    # from the one the migration built).
                    try:
                        res = new_mirror().sync_incident(
                            incident_key=key, dir_url=cand.dir_url, match=prev["match"],
                            cornea_id=prev["cornea_id"], bound=prev.get("bound"),
                            dir_mtime=cand.dir_mtime, region=prev.get("region"),
                        )
                    except httpx.HTTPError as exc:
                        log(f"[incidents] {key}: FAILED mid-refresh ({exc}) — "
                            "skipping; will resume next run")
                        failed_incidents.append(key)
                        continue
                    if not (res.downloads or res.synced_children):
                        log(f"[incidents] {key}: unchanged since last sync — skipping")
                        unchanged_skips += 1
                        continue
                    log(f"[incidents] {key}: refreshed under {bound_fk}: "
                        f"listings={res.listings} children={res.synced_children} "
                        f"downloads={res.downloads} ({res.bytes_downloaded/1e6:.1f} MB)")
                    refreshed += 1
                    mirrors[key] = {"candidate": cand, "match": None, "result": res,
                                    "fk": bound_fk}
                    # every fire the folder showed files on, before and after
                    # (a new revision can drop a file's stamp)
                    rebuild |= before | incident_ids.owners_of(prev)
                    if res.downloads:
                        checkpoint()
                    continue
                if bound_fk:
                    # Bound to a fire that is no longer active (or, with
                    # --fire, to another fire), and nothing new at its root.
                    log(f"[incidents] {key}: unchanged since last sync — skipping")
                    unchanged_skips += 1
                    continue
                if prev.get("id_unresolved") or prev.get("ignored"):
                    log(f"[incidents] {key}: unchanged and "
                        f"{'ignored' if prev.get('ignored') else 'unresolved'} — skipping")
                    unchanged_skips += 1
                    continue
                # detached by the date check: a fresh match below

            kind, m, why = resolve_override(ov, fires)
            if kind == "ignore":
                if prev is not None:
                    old = incident_ids.prior_owner(prev)
                    prev.update(match=None, ignored=True, override="ignore",
                                dir_mtime=cand.dir_mtime)
                    if old:
                        rebuild.add(old)
                log(f"[incidents] {key}: ignored (match_overrides.json)")
                continue
            if kind in ("error", "inactive"):
                # An invalid override leaves the folder exactly as it was.
                log(f"[incidents] {key}: override NOT applied — {why}")
                override_errors.append({"key": key, "override": ov, "error": kind,
                                        "reason": why})
                continue
            if m is None:
                cand.unit_tokens = _gather_unit_tokens(client, cand)
                m = match_candidate(cand, fires, None,
                                    prefer_fk=fire_key((prev or {}).get("cornea_id")), log=log)
            if m is None:
                log(f"[incidents] {key}: UNMATCHED "
                    f"(tokens={dict(cand.unit_tokens) or 'none'}) — see match_overrides.json")
                continue
            fk = fire_key(m.cornea_id)
            if target_fk and fk != target_fk:
                continue
            fire = fires_by_fk.get(fk)
            if fire is None:
                log(f"[incidents] {key}: matched inactive fire {m.cornea_id} — skipping")
                continue

            decision = incident_ids.rebind_decision(prev, m)
            prev_method = ((prev or {}).get("match") or {}).get("method")
            if (prev is not None and decision in ("bind", "rebind", "fresh")
                    and m.method in incident_ids.NAME_METHODS):
                # match_candidate dates the folder by any file it listed (a
                # .txt, a sheet too big to mirror), the cached check by the
                # folder's own map uploads. A name match moving a record
                # onto a fire faces the cached check too: a folder detached
                # by it above would otherwise be bound again, its unproven
                # files hidden, and detached again next run.
                why = incident_ids.record_predates_fire(prev, m.method, fire.get("created_on"))
                if why:
                    log(f"[incidents] {key}: {m.method} match to {m.fire_slug} "
                        f"({m.cornea_id}) REJECTED — {why}")
                    if fire_key((prev.get("match_rejected") or {}).get("cornea_id")) != fk:
                        prev["match_rejected"] = {"cornea_id": m.cornea_id, "method": m.method,
                                                  "reason": why, "at": now}
                    if key not in date_rejected:
                        date_rejected.append(key)
                    continue
            if decision == "refuse":
                # A name never outranks an ID: keep the binding and mirror
                # under it.
                log(f"[incidents] {key}: {m.method} match to {m.fire_slug} ({m.cornea_id}) "
                    f"REFUSED — bound by unit_id to {prev.get('cornea_id')}")
                rebind_refused.append({"key": key, "cornea_id": prev.get("cornea_id"),
                                       "matched": m.cornea_id, "method": m.method})
                cornea_id, match_record, bound = (prev.get("cornea_id"), prev["match"],
                                                  prev.get("bound"))
                fk = fire_key(cornea_id)
            else:
                if decision != "new":
                    old = incident_ids.apply_bind(prev, m, fire, now, inc_key=key)
                    if old:
                        rebuild.add(old)
                    if decision != "same":
                        rebinds.append({"key": key, "decision": decision, "from": old,
                                        "to": fk, "method": m.method})
                        log(f"[incidents] {key}: {decision} {old or '-'} -> {fk} ({m.method})")
                cornea_id = m.cornea_id
                if decision == "same" and incident_ids.weakens(prev_method, m.method):
                    # Its own fire again, by a weaker method (an ID-bound
                    # folder whose newest dailies carry no token, matched by
                    # name): the binding keeps its match, so a later name
                    # match is still refused and no date check applies.
                    match_record, bound = prev["match"], prev.get("bound")
                else:
                    match_record = {"method": m.method, "confidence": m.confidence,
                                    "token": m.token, "dir_url": cand.dir_url,
                                    "cornea_id": m.cornea_id}
                    bound = incident_ids.bound_info(fire, m.method)
            matched += 1
            log(f"[incidents] {key} -> {fire_key(cornea_id)} "
                f"({m.fire_slug}, {m.method}, conf={m.confidence})")
            # apply_bind may have moved files off these fires, and the
            # mirror's new revisions can (also when it fails part-way)
            rebuild |= before

            try:
                res = new_mirror().sync_incident(
                    incident_key=key, dir_url=cand.dir_url, match=match_record,
                    cornea_id=cornea_id, bound=bound, dir_mtime=cand.dir_mtime,
                    region=cand.region,
                )
            except httpx.HTTPError as exc:
                # One incident's FTP flaking (retries exhausted) must not kill
                # the run — its checkpoint state is intact, next run resumes.
                log(f"[incidents] {key}: FAILED mid-mirror ({exc}) — "
                    "skipping; will resume next run")
                failed_incidents.append(key)
                continue
            rec = state["incidents"][key]
            rec["dir_url"] = cand.dir_url
            rec.pop("id_unresolved", None)
            rec.pop("match_rejected", None)
            if m.method == "override":
                rec["override"] = m.cornea_id
            else:
                rec.pop("override", None)
            log(f"[incidents] {key}: listings={res.listings} "
                f"downloads={res.downloads} ({res.bytes_downloaded/1e6:.1f} MB) "
                f"unchanged={res.skipped_unchanged} too_big={res.skipped_too_big}")
            mirrors[key] = {"candidate": cand, "match": m, "result": res, "fk": fk}
            # The fire the folder is bound to, and every fire it shows files
            # on now (`before` covers the ones it showed them on until now).
            rebuild.add(fk)
            rebuild |= incident_ids.owners_of(rec)
            # Checkpoint per incident: files are already on B2, so if this run
            # dies the next one must not re-download them. (The first full run
            # was killed mid-tiling and lost every download record.)
            if res.downloads:
                checkpoint()

        if deferred:
            log(f"[incidents] download deadline reached — {deferred} candidate dirs "
                "deferred to the next scheduled run")

        stats: dict = {"raw_sha_mismatch": mismatches}
        _process_mirrored_assets(args, storage, state, mirrors)
        # fires whose index entry is missing, outdated (reassign-files) or
        # names other folders than the ones feeding them now
        rebuild |= fire_manifests.stale_index_fks(state, fires_by_fk)
        built = fire_manifests.publish_fire_manifests(
            args, storage, state, fires_by_fk, rebuild, mirrors, stats=stats, log=log)
        state_mod.save_state(storage, state)  # tiling records and the index
        # master catalog rebuild (state, versions/catalog.N.json, catalog.json LAST)
        catalog = fire_manifests.publish_catalog(storage, state, fires, log=log)
        version = catalog["version"]

        log(f"[incidents] done: candidates={len(cands)} matched={matched} "
            f"mirrored_incidents={len(mirrors)} rebuilt_fires={len(built)} "
            f"catalog_version={version}")

        downloads = sum(m["result"].downloads for m in mirrors.values())
        dl_bytes = sum(m["result"].bytes_downloaded for m in mirrors.values())
        unresolved = sorted(k for k, r in state["incidents"].items()
                            if r.get("id_unresolved") and not r.get("ignored"))
        raw_sha_mismatch = sorted(set(stats.get("raw_sha_mismatch") or ()))
        health.publish(storage, "mirror", {
            "started_at": job_started,
            "finished_at": cat.now_iso(),
            "ok": True,
            "note": "; ".join(filter(None, [
                f"{len(failed_incidents)} incident(s) skipped on FTP errors"
                if failed_incidents else None,
                f"{len(date_rejected)} stale name match(es) dropped by the date check"
                if date_rejected else None,
                f"{len(rebinds)} folder(s) rebound to another fire" if rebinds else None,
                f"{len(rebind_refused)} name rebind(s) of ID-bound folders refused"
                if rebind_refused else None,
                f"{len(override_errors)} invalid override(s) in match_overrides.json"
                if override_errors else None,
                f"{len(key_collisions)} incident key collision(s)" if key_collisions else None,
                f"{len(raw_sha_mismatch)} raw object(s) failed their hash check"
                if raw_sha_mismatch else None,
            ])) or None,
            "catalog_version": version,
            "candidates": len(cands),
            "unchanged_skips": unchanged_skips,
            "mirrored_incidents": len(mirrors),
            "files_downloaded": downloads,
            "bytes_downloaded": dl_bytes,
            "failed_incidents": failed_incidents,
            "date_rejected": date_rejected,
            "deadline_hit": frames.deadline_passed(),
            "gdal_available": geopdf.gdal_available(),
            "unresolved": unresolved,
            "rebinds": rebinds,
            "rebind_refused": rebind_refused,
            "override_errors": override_errors,
            "key_collisions": key_collisions,
            "refreshed": refreshed,
            "rebuilt_fires": sorted(built),
            "raw_sha_mismatch": raw_sha_mismatch,
            "ir_mixed_hidden": stats.get("ir_mixed_hidden") or [],
        }, log=log)
    return 0


# ===========================================================================
# prune
# ===========================================================================

def _tick_prune_clock(state: dict, fires: list[dict], fires_meta: dict,
                      prev_catalog: dict | None) -> None:
    """Prune's inactivity clock, kept by fire ID (hourly, by sync-catalogs).

    Every active fire is stamped last seen now and any inactivity cleared;
    a fire that incident folders feed starts its clock the first run it is
    missing from the list. A list that may be partial (a full API page, or
    far shorter than the previous catalog's) is skipped for the run: a fire
    missing from it proves nothing.
    """
    prev_active = ((prev_catalog or {}).get("counts") or {}).get("active_fires")
    why = fire_list_suspect(fires_meta.get("raw_rows", ACTIVE_FIRES_LIMIT),
                            len(fires), prev_active)
    if why:
        log(f"[prune] inactivity clock not advanced this run: {why}")
        return
    now = state_mod.now_iso()
    clock = state.setdefault("prune", {})
    last_seen = clock.setdefault("last_seen_active", {})
    inactive_since = clock.setdefault("inactive_since_by_id", {})
    active = {fk for f in fires if (fk := fire_key(f.get("cornea_id")))}
    for fk in active:
        last_seen[fk] = now
        inactive_since.pop(fk, None)
    for fk in incident_ids.contributors(state):
        if fk not in active:
            inactive_since.setdefault(fk, now)


def cmd_prune(args) -> int:
    """Manual-only, explicit-opt-in deletion. USER POLICY (2026-08-17): FTP-
    derived incident data is kept indefinitely — this command refuses to run
    without BOTH --days and --confirm, and is never invoked by CI."""
    from datetime import datetime, timedelta, timezone

    from .maint import write_report

    if getattr(args, "report", False):
        # maint.yml runs prune in report mode only; the fire-ID prune
        # report comes with the key audit (spec 5.2)
        note = "prune report is not implemented yet (fire-ID prune, spec 5.2); nothing deleted"
        log(f"[prune] {note}")
        write_report(getattr(args, "report_out", None),
                     {"command": "prune", "mode": "report", "deleted": [], "note": note})
        return 2
    if args.days is None or not args.confirm:
        log("[prune] refused: incident data is kept indefinitely by policy. "
            "To delete anyway, pass BOTH --days N and --confirm.")
        return 2

    storage = make_storage(args.dry_run, args.out)
    state = state_mod.load_state(storage)
    if incident_ids.migrated(state):
        # Migrated prefixes hold other folders' stamped files (austin/ keeps
        # Grasshopper's sheets), so deleting a whole slug prefix here would
        # take another fire's maps with it.
        log("[prune] refused: state is keyed by fire ID; this slug-prefix "
            "prune would delete files other fires still show")
        return 2

    with make_client() as client:
        fires = fetch_active_fires(client)
    active_slugs = {f["fire_slug"] for f in fires}

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=args.days)
    inactive_since = state["prune"]["inactive_since"]

    removed = []
    for inc_key, inc in list(state["incidents"].items()):
        slug = inc.get("fire_slug")
        if slug in active_slugs:
            inactive_since.pop(slug, None)
            continue
        first_seen = inactive_since.get(slug)
        if first_seen is None:
            inactive_since[slug] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
            continue
        if datetime.strptime(first_seen, "%Y-%m-%dT%H:%M:%SZ").replace(
                tzinfo=timezone.utc) < cutoff:
            log(f"[prune] {slug}: inactive > {args.days}d — deleting")
            for prefix in (f"raw/incidents/{slug}/", f"tiles/incidents/{slug}/",
                           f"previews/incidents/{slug}/", f"vectors/ir/{slug}/",
                           f"catalogs/incidents/{slug}.json"):
                n = storage.delete_prefix(prefix)
                log(f"[prune]   {prefix}: {n} objects removed")
            del state["incidents"][inc_key]
            inactive_since.pop(slug, None)
            removed.append(slug)

    state_mod.save_state(storage, state)
    log(f"[prune] done: removed={removed or 'none'}")
    return 0


# ===========================================================================
# cleanup-spread-frames (one-time)
# ===========================================================================

def cmd_cleanup_spread_frames(args) -> int:
    """One-time cleanup after the client-side-rendering migration
    (docs/spec-archives.md): the pre-rendered spread frames and spread legend
    images on B2 are dead. Manual-only; requires --confirm."""
    if not args.confirm:
        log("[cleanup] refused: this permanently deletes frames/spread/ and "
            "frames/legends/ from the bucket. Pass --confirm to proceed.")
        return 2

    storage = make_storage(args.dry_run, args.out)
    total = 0
    for prefix in ("frames/spread/", "frames/legends/"):
        n = storage.delete_prefix(prefix)
        total += n
        log(f"[cleanup] {prefix}: {n} objects removed")
    log(f"[cleanup] done: {total} objects removed")
    return 0


# ===========================================================================
# incident-ID maintenance (maint.yml)
# ===========================================================================

def cmd_migrate_incident_ids(args) -> int:
    """Re-key incident state by fire ID (migrate_ids). --report computes
    everything and writes only the report; --apply needs the expected
    report and the fire-ID sync code, and writes only when every guard
    passes."""
    if args.apply and not args.expect:
        log("[migrate] refused: --apply needs --expect REPORT (the report run it must reproduce)")
        return 2
    if args.apply and not INCIDENT_SYNC_BY_ID:
        log("[migrate] refused: this sync-incidents still keys by fire slug and would pause "
            "on migrated state; apply once the fire-ID sync code is deployed")
        return 2
    from . import migrate_ids

    storage = make_storage(args.dry_run, args.out)
    with make_client() as client:
        return migrate_ids.run(
            storage, fetch_fires=lambda meta: fetch_active_fires(client, meta=meta),
            apply=args.apply, expect=args.expect, report_out=args.report_out, log=log)


def cmd_audit_incident_keys(args) -> int:
    log("[audit] audit-incident-keys is not yet implemented (spec 5.1)")
    return 2


def cmd_reassign_files(args) -> int:
    from . import maint

    return maint.reassign_files(make_storage(args.dry_run, args.out), key=args.key,
                                rel=args.rel, to=args.to, apply=args.apply,
                                report_out=args.report_out, log=log)


def cmd_restore_state_backup(args) -> int:
    from . import maint

    return maint.restore_state_backup(make_storage(args.dry_run, args.out), apply=args.apply,
                                      report_out=args.report_out, log=log)


# ===========================================================================
# argparse
# ===========================================================================

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="responder_worker",
                                description="Responder Debrief data-pipeline worker")
    sub = p.add_subparsers(dest="command", required=True)

    def common(sp):
        sp.add_argument("--dry-run", action="store_true",
                        help="no B2: write outputs under ./out/ mirroring B2 keys")
        sp.add_argument("--out", type=Path, default=DEFAULT_OUT,
                        help=f"dry-run output dir (default {DEFAULT_OUT})")
        sp.add_argument("--force", action="store_true",
                        help="ignore change-detection state")

    sp = sub.add_parser("sync-catalogs",
                        help="fire API + forecast archive + HRRR -> frames + catalogs")
    common(sp)
    sp.add_argument("--frames-fires",
                    help="no-op (spread frames removed — client-side archive "
                         "rendering); kept for CLI compatibility")
    sp.add_argument("--frames-hours", type=int, default=None,
                    help="limit weather frames to the first N forecast hours")
    sp.add_argument("--frames-products",
                    help="CSV of weather products to render (e.g. smoke,ws,rh)")
    sp.set_defaults(func=cmd_sync_catalogs)

    def incidents_args(sp):
        common(sp)
        sp.add_argument("--fire", help="restrict to one fire: its fire slug (e.g. 'elk') "
                                       "or fire key (its cornea_id, any spelling)")
        sp.add_argument("--region", help="restrict to one GACC region dir (e.g. rocky_mtn)")
        sp.add_argument("--year", type=int, default=2026)
        sp.add_argument("--since", help="backfill: include Products dailies >= YYYYMMDD")
        sp.add_argument("--max-file-mb", type=float, default=None,
                        help="skip files larger than this (dry-run politeness)")
        sp.add_argument("--max-pdfs", type=int, default=None,
                        help="cap number of downloads per run (dry-run politeness)")
        sp.add_argument("--products-keep", type=int, default=config.PRODUCTS_DAILY_KEEP)
        sp.add_argument("--ir-keep", type=int, default=config.IR_KEEP)
        sp.add_argument("--tile-budget", type=int, default=config.TILE_BUDGET)
        sp.add_argument("--priority-fires",
                        default=os.environ.get("PRIORITY_FIRES", ""),
                        help="comma-separated fire slugs/names mirrored first "
                             "(env PRIORITY_FIRES); others by acreage desc")
        sp.add_argument("--zoom-cap", type=int, default=None,
                        help="cap tile maxzoom (fast dry-run tiling)")

    sp = sub.add_parser("sync-incidents", help="FTP crawl + match + mirror + GeoPDF")
    incidents_args(sp)
    sp.set_defaults(func=cmd_sync_incidents)

    sp = sub.add_parser("tile-worker",
                        help="stateless parallel tiler (writes tiles + marker only)")
    common(sp)
    sp.add_argument("--shard", type=int, default=0)
    sp.add_argument("--shards", type=int, default=1)
    sp.add_argument("--max-seconds", type=int,
                    default=int(os.environ.get("TILEW_MAX_SECONDS", "2900")))
    sp.add_argument("--zoom-cap", type=int, default=None)
    sp.set_defaults(func=cmd_tile_worker)

    sp = sub.add_parser("backfill", help="sync-incidents for one fire with --since")
    incidents_args(sp)
    sp.set_defaults(func=cmd_backfill)

    sp = sub.add_parser("prune", help="drop fires inactive > 14 days")
    common(sp)
    sp.add_argument("--days", type=int, default=None,
                    help="inactivity threshold; required (policy: keep forever)")
    sp.add_argument("--confirm", action="store_true",
                    help="required second flag to actually delete")
    sp.add_argument("--report", action="store_true",
                    help="report only, never delete (maint.yml)")
    sp.add_argument("--report-out", type=Path, default=None, help="write a JSON report here")
    sp.set_defaults(func=cmd_prune)

    def mode_args(sp, report_flag="--report", apply_flag="--apply"):
        g = sp.add_mutually_exclusive_group()
        g.add_argument(report_flag, dest="report", action="store_true",
                       help="compute and report; write nothing (default)")
        g.add_argument(apply_flag, dest="apply", action="store_true")
        sp.add_argument("--report-out", type=Path, default=None,
                        help="write the JSON report here")

    sp = sub.add_parser("migrate-incident-ids",
                        help="one-off: key incident records by fire ID instead of slug")
    common(sp)
    mode_args(sp)
    sp.add_argument("--expect", type=Path, default=None,
                    help="with --apply: the report run whose results the apply must reproduce")
    sp.set_defaults(func=cmd_migrate_incident_ids)

    sp = sub.add_parser("audit-incident-keys",
                        help="check every incident key against the bucket (not yet implemented)")
    common(sp)
    mode_args(sp, apply_flag="--repair")
    sp.add_argument("--refetch-missing", action="store_true")
    sp.set_defaults(func=cmd_audit_incident_keys)

    sp = sub.add_parser("reassign-files",
                        help="state only: show files of one folder on another fire, "
                             "hide them, or return them to the folder's binding")
    common(sp)
    mode_args(sp)
    sp.add_argument("--key", required=True, help="incident key, e.g. pacific_nw/2026/2026_Grasshopper")
    sp.add_argument("--rel", required=True, help="regex over the folder's file paths")
    sp.add_argument("--to", required=True, help="a fire's cornea_id, 'binding' or 'hidden'")
    sp.set_defaults(func=cmd_reassign_files)

    sp = sub.add_parser("restore-state-backup",
                        help="rollback: put the pre-migration state backup back (apply only)")
    common(sp)
    mode_args(sp)
    sp.set_defaults(func=cmd_restore_state_backup)

    sp = sub.add_parser("cleanup-spread-frames",
                        help="one-time: delete the dead pre-rendered spread "
                             "frame/legend objects (frames/spread/, frames/legends/)")
    common(sp)
    sp.add_argument("--confirm", action="store_true",
                    help="required flag to actually delete")
    sp.set_defaults(func=cmd_cleanup_spread_frames)

    # Trails overlay + offline routing bundles live in their own modules.
    from . import routing_cli, trails_cli
    trails_cli.register(sub, common)
    routing_cli.register(sub, common)
    return p


def cmd_backfill(args) -> int:
    if not args.fire:
        log("backfill requires --fire")
        return 2
    if args.since:
        args.products_keep = 10_000  # keep everything >= since (filter below)
    args.force = True
    return cmd_sync_incidents(args)


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
