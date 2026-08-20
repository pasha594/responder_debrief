"""CLI: python -m responder_worker.cli
{sync-catalogs|sync-incidents|backfill|prune|cleanup-spread-frames}

--dry-run everywhere: no B2 needed; outputs land under ./out/ mirroring the B2
key layout, state at ./out/state/state.json.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
from collections import Counter
from datetime import datetime
from pathlib import Path

import httpx

from . import archives, catalogs as cat, health, imsr
from . import config, frames, geopdf, hrrr, ir_vectors, pyrecast, state as state_mod
from .b2 import make_storage
from .fires import fetch_active_fires
from .ftp_index import list_dir
from .http import get_optional, make_client
from .matching import (
    IncidentCandidate,
    candidate_dir_name,
    extract_unit_tokens,
    match_candidate,
    normalize_name,
)
from .mirror import IncidentMirror, MirroredFile

DEFAULT_OUT = Path(__file__).resolve().parent.parent / "out"


def log(msg: str) -> None:
    print(msg, flush=True)


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
        fires = fetch_active_fires(client)
        log(f"[catalogs] active wildfires: {len(fires)}")

        log("[catalogs] fetching forecast-archive manifest + fire matches ...")
        pyre = archives.sync(client, storage, state, fires,
                             force=args.force, log=log)

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
        slug: entry["runs"][0]["run_time"]
        for slug, entry in pyre["fires"].items()
        if entry["runs"]
    }

    # keep incident matches recorded by previous sync-incidents runs
    incident_matches: dict[str, dict] = {}
    healed = 0
    for inc_key, inc in state.get("incidents", {}).items():
        m = inc.get("match") or {}
        if inc.get("fire_slug") and m:
            # Self-heal directory counts: incidents mirrored before the counts
            # existed (or by a run that skipped them as unchanged) have no
            # map_count. Read the already-published manifest instead of
            # re-crawling the FTP — cheap, and it converges within the hour.
            if inc.get("map_count") is None:
                man = storage.get_json(
                    f"catalogs/incidents/{inc['fire_slug']}.json") or {}
                maps = man.get("maps") or []
                irs = man.get("ir_flights") or []
                if maps or irs:
                    dates = [x.get("op_date") for x in maps if x.get("op_date")]
                    dates += [x.get("flight_date") for x in irs if x.get("flight_date")]
                    inc["map_count"] = len(maps)
                    inc["ir_count"] = len(irs)
                    inc["latest_upload"] = max(dates) if dates else None
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
            }

    if healed:
        log(f"[catalogs] backfilled incident counts for {healed} fires from manifests")

    version = int(state.get("catalog_version", 0)) + 1
    catalog = cat.build_catalog(
        fires, version=version,
        incident_matches=incident_matches, spread_index=spread_index,
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


# ===========================================================================
# sync-incidents / backfill
# ===========================================================================

def _collect_candidates(client, args, fires) -> list[IncidentCandidate]:
    """Crawl region year-roots for candidate incident dirs."""
    year = args.year
    fire_filter = normalize_name(args.fire) if args.fire else None
    roots = config.region_year_roots(year)
    if args.region:
        roots = [(r, u) for r, u in roots if r.startswith(args.region)]

    cands: list[IncidentCandidate] = []
    for region, root_url in roots:
        resp = get_optional(client, root_url)
        if resp is None:
            continue
        from .ftp_index import parse_autoindex

        for e in parse_autoindex(resp.text, root_url):
            if not e.is_dir:
                continue
            rest = candidate_dir_name(e.name + "/", year)
            if rest is None:
                continue
            if fire_filter:
                dir_norm = normalize_name(e.name)
                if fire_filter not in dir_norm and dir_norm not in fire_filter:
                    continue
            cands.append(IncidentCandidate(
                region=region, year=year, dir_name=e.name,
                dir_url=e.url, dir_mtime=e.mtime,
            ))
    return cands


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
    """Unit-token evidence from newest daily Products|GIS dir + QR filenames."""
    tokens: Counter = Counter()
    children = list_dir(client, cand.dir_url)
    for child in children:
        if not child.is_dir:
            continue
        lname = child.name.lower()
        if lname in ("products", "gis"):
            entries = list_dir(client, child.url)
            dailies = sorted(
                (e for e in entries if e.is_dir and e.name.isdigit() and len(e.name) == 8),
                key=lambda e: e.name, reverse=True,
            )
            for daily in dailies[:2]:
                files = list_dir(client, daily.url)
                tokens += extract_unit_tokens([f.name for f in files if not f.is_dir],
                                              year=cand.year)
                if tokens:
                    break
        elif lname == "qr":
            files = list_dir(client, child.url)
            tokens += extract_unit_tokens([f.name for f in files if not f.is_dir],
                                          year=cand.year)
    return tokens


def _tile_and_manifest(args, storage, state, fires_by_slug, mirrors) -> None:
    """GeoPDF processing + IR vectors + incident manifests (upload order safe)."""
    tile_budget = args.tile_budget
    gdal_ok = geopdf.gdal_available()
    if not gdal_ok:
        log("[incidents] GDAL not available — skipping tiling (degrades to raw PDFs)")

    # Re-arm the wall-clock for the tiling phase: a single arch-E sheet can
    # take minutes, so the 40-sheet count budget alone let this phase blow past
    # the CI timeout (killing the job before ANY manifest was published).
    # Sheets past the deadline are flagged tiling_pending and picked up next run.
    frames.start_deadline(int(os.environ.get(
        "TILE_MAX_SECONDS", str(config.TILE_MAX_SECONDS_DEFAULT))))
    tiles_deferred = 0

    for inc_key, bundle in mirrors.items():
        fire = bundle["fire"]
        fire_slug = fire["fire_slug"]
        res = bundle["result"]
        maps: list[dict] = []
        ir_by_flight: dict[str, dict] = {}
        # The same sheet is often published in two places (e.g. "Current Maps/"
        # AND "Daily Products/{date}/"). Tiles are content-addressed so the work
        # dedupes itself, but the manifest must list each sheet once.
        seen_sha: set[str] = set()

        # Retention is "current period forward", but files already mirrored are
        # kept forever (user policy) — so the manifest replays every file this
        # incident has EVER mirrored, not just the ones this run touched.
        # Otherwise a fire's older sheets would silently vanish from the UI the
        # first time its folder changed.
        inc_files = (state["incidents"].get(inc_key) or {}).get("files", {})
        seen_rel = {f"{mf.rel_dir}/{mf.filename}" for mf in res.files}
        replayed = [
            MirroredFile(
                kind=meta.get("kind", "product"),
                filename=rel.rpartition("/")[2],
                key=f"raw/incidents/{fire_slug}/{rel}",
                url=meta.get("url", ""),
                size=meta.get("size"),
                sha16=meta.get("sha16"),
                rev=meta.get("rev", 1),
                local_path=None,          # never re-tiled; geo comes from state
                changed=False,
                rel_dir=rel.rpartition("/")[0],
                lm=meta.get("lm"),
            )
            for rel, meta in inc_files.items()
            if rel not in seen_rel
        ]

        for mf in [*res.files, *replayed]:
            if mf.kind == "ir":
                d = ir_by_flight.setdefault(mf.rel_dir, {"files": []})
                d["files"].append(mf)
                continue
            if not mf.filename.lower().endswith(".pdf"):
                continue
            if mf.sha16:
                if mf.sha16 in seen_sha:
                    continue
                seen_sha.add(mf.sha16)
            parsed = cat.parse_product_filename(mf.filename)
            sha_id = mf.sha16 or "unknown"
            geo: dict = {"georeferenced": False, "preview": False}
            tiled_state = state["tiled"].get(sha_id)
            already_tiled = bool(
                tiled_state and tiled_state.get("tiler_version") == config.TILER_VERSION
            )
            pending = False
            if mf.kind != "mobile" and gdal_ok and mf.local_path is not None:
                if already_tiled:
                    geo = tiled_state.get("geo", geo)
                elif tile_budget <= 0 or frames.deadline_passed():
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
                            storage.put_file(
                                f"previews/incidents/{fire_slug}/{sha_id}.png", preview)
                            geo["preview"] = True
                    except Exception as exc:
                        log(f"[geopdf] preview failed for {mf.filename}: {exc}")
                    # Only georeferenced sheets have tiling still owed.
                    pending = probe["georeferenced"]
                    if pending:
                        tiles_deferred += 1
                    state["tiled"][sha_id] = {
                        # A flat sheet is DONE — nothing to tile, so don't let
                        # it consume tiling budget on every future run. A
                        # georeferenced one keeps tiler_version None so the
                        # next run picks it up.
                        "tiler_version": None if probe["georeferenced"] else config.TILER_VERSION,
                        "at": state_mod.now_iso(),
                        "geo": geo,
                    }
                else:
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
                            n = storage.put_tree(
                                f"tiles/incidents/{fire_slug}/{sha_id}", tiles_dir
                            )
                            log(f"[geopdf] {mf.filename}: {n} tiles "
                                f"z{r['tiles']['minzoom']}-{r['tiles']['maxzoom']}")
                        try:
                            preview = Path(td) / "preview.png"
                            geopdf.render_preview(mf.local_path, preview)
                            storage.put_file(
                                f"previews/incidents/{fire_slug}/{sha_id}.png", preview
                            )
                            geo["preview"] = True
                        except Exception as exc:  # preview failure is never fatal
                            log(f"[geopdf] preview failed for {mf.filename}: {exc}")
                    tile_budget -= 1
                    state["tiled"][sha_id] = {
                        "tiler_version": config.TILER_VERSION,
                        "at": state_mod.now_iso(),
                        "geo": geo,
                    }
            elif tiled_state:
                # Replayed file (local_path None): reuse whatever the state
                # knows. tiler_version None = probed-georeferenced, tiles
                # still owed — keep it PENDING so the tile backlog (and the
                # UI) don't silently demote it to a flat sheet.
                geo = tiled_state.get("geo", geo)
                pending = (
                    tiled_state.get("tiler_version") is None
                    and bool(geo.get("georeferenced"))
                )

            maps.append(cat.map_entry(
                parsed=parsed, kind=mf.kind, sha_id=sha_id, fire_slug=fire_slug,
                pdf_key=mf.key, size_bytes=mf.size, geo=geo, rev=mf.rev,
                tiling_pending=pending, uploaded_lm=mf.lm,
            ))

        ir_flights = _ir_flights(args, storage, state, fire, ir_by_flight)

        manifest = cat.build_incident_manifest(
            fire=fire,
            region=bundle["candidate"].region,
            source_dir=bundle["candidate"].dir_url,
            unit_incident=(bundle["match"].token or "").replace("2026-", "", 1).replace("-", "")
            if bundle["match"].token else None,
            maps=maps,
            ir_flights=ir_flights,
        )
        storage.put_json(f"catalogs/incidents/{fire_slug}.json", manifest)
        log(f"[incidents] manifest written: catalogs/incidents/{fire_slug}.json "
            f"(maps={len(maps)}, ir_flights={len(ir_flights)})")

        # Directory-view summary in catalog.json, so the fire list can show
        # file counts without fetching every per-fire manifest.
        upload_dates = [m["op_date"] for m in maps if m.get("op_date")]
        upload_dates += [f["flight_date"] for f in ir_flights if f.get("flight_date")]
        inc_state = state["incidents"].setdefault(inc_key, {})
        inc_state["map_count"] = len(maps)
        inc_state["ir_count"] = len(ir_flights)
        inc_state["latest_upload"] = max(upload_dates) if upload_dates else None

    if tiles_deferred:
        log(f"[geopdf] {tiles_deferred} sheets deferred (tile budget/deadline) — "
            "flagged tiling_pending, picked up next run")


def _ir_flights(args, storage, state, fire, ir_by_flight: dict[str, dict]) -> list[dict]:
    out = []
    fire_slug = fire["fire_slug"]
    fire_name_norm = normalize_name(fire.get("post_title") or "").replace(" ", "")
    for rel_dir, d in sorted(ir_by_flight.items(), reverse=True):
        files = d["files"]
        flight_date = rel_dir.split("/")[-1]
        if len(flight_date) == 8 and flight_date.isdigit():
            flight_date_iso = f"{flight_date[:4]}-{flight_date[4:6]}-{flight_date[6:]}"
        else:
            flight_date_iso = None
        zips = [f for f in files if f.filename.lower().endswith("shapefiles.zip")]
        pdfs = [f for f in files if f.filename.lower().endswith(".pdf")]
        kmzs = [f for f in files if f.filename.lower().endswith(".kmz")]
        readmes = [f for f in files if "read_me" in f.filename.lower()]

        def _stem_id(filename: str, *suffixes: str) -> str:
            stem = filename.rsplit(".", 1)[0]
            for suf in suffixes:
                if stem.endswith(suf):
                    stem = stem[: -len(suf)]
            toks = [t for t in stem.split("_")
                    if normalize_name(t).replace(" ", "") != fire_name_norm]
            return "_".join(toks)

        flight_id = None
        if zips:
            flight_id = _stem_id(zips[0].filename, "_Shapefiles")
        elif pdfs:
            flight_id = _stem_id(pdfs[0].filename, "_All")
        elif kmzs:
            flight_id = _stem_id(kmzs[0].filename, "_All")

        est_acres = None
        if readmes and readmes[0].local_path and readmes[0].local_path.exists():
            est_acres = ir_vectors.parse_estimated_acres(
                readmes[0].local_path.read_text(errors="replace"))

        geojson_url = None
        heat_types: list[str] = []
        if flight_id and (zips or kmzs):
            key = f"vectors/ir/{fire_slug}/{flight_id}.geojson"
            cache = state.setdefault("ir", {}).get(key)
            if cache and cache.get("heat_types"):
                # converted on a previous rebuild — reuse, no re-download
                geojson_url = f"/{key}"
                heat_types = cache["heat_types"]
            elif cache and cache.get("failed"):
                pass  # attempted before; the source file won't change
            else:
                try:
                    with tempfile.TemporaryDirectory() as td:
                        tdp = Path(td)
                        # source: shapefiles preferred, KMZ fallback (some
                        # teams publish KMZ only); replayed files have no
                        # local copy but the bytes are in OUR bucket
                        src_mf = zips[0] if zips else kmzs[0]
                        local = src_mf.local_path
                        if local is None:
                            local = tdp / Path(src_mf.filename).name
                            if not storage.get_file(src_mf.key, local):
                                raise RuntimeError(f"missing raw object {src_mf.key}")
                        gj = tdp / f"{flight_id}.geojson"
                        if zips:
                            info = ir_vectors.process_ir_zip(local, gj, flight_id=flight_id)
                        else:
                            info = ir_vectors.process_ir_kmz(local, gj, flight_id=flight_id)
                        storage.put_file(key, gj)
                        geojson_url = f"/{key}"
                        heat_types = info["heat_types"]
                        state["ir"][key] = {"heat_types": heat_types}
                        log(f"[ir] {flight_id}: {info['feature_count']} features "
                            f"({', '.join(heat_types)})")
                except Exception as exc:
                    state["ir"][key] = {"failed": True}
                    log(f"[ir] vectorization failed for {rel_dir}: {exc}")

        out.append({
            "flight_date": flight_date_iso,
            "flight_id": flight_id,
            "no_flight_reason": None,
            "geojson_url": geojson_url,
            "heat_types": heat_types,
            "estimated_acres": est_acres,
            "pdf_url": f"/{pdfs[0].key}" if pdfs else None,
            "kmz_url": f"/{kmzs[0].key}" if kmzs else None,
            "readme_url": f"/{readmes[0].key}" if readmes else None,
        })
    return out


def tile_meta_key(fire_slug: str, sha: str) -> str:
    """Completion marker a stateless tile worker writes LAST: its existence
    means the full tile tree for this sheet is on the bucket."""
    return f"tiles/incidents/{fire_slug}/{sha}/meta.json"


def _sha_in_shard(sha: str, shard: int, shards: int) -> bool:
    try:
        return int(sha[:8], 16) % shards == shard
    except ValueError:
        return shard == 0


def _pending_sheets(state) -> list[tuple[str, str, str]]:
    """(sha, fire_slug, rel) for every probed-georeferenced sheet still owed
    tiles, deduped by sha (the same sheet can appear in several folders)."""
    out: list[tuple[str, str, str]] = []
    seen: set[str] = set()
    for inc in state.get("incidents", {}).values():
        fire_slug = inc.get("fire_slug")
        if not fire_slug:
            continue
        for rel, meta in (inc.get("files") or {}).items():
            sha = meta.get("sha16")
            if not sha or sha in seen:
                continue
            rec = state["tiled"].get(sha)
            if (not rec or rec.get("tiler_version") is not None
                    or not (rec.get("geo") or {}).get("georeferenced")):
                continue
            seen.add(sha)
            out.append((sha, fire_slug, rel))
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
    for sha, fire_slug, rel in todo:
        if frames.deadline_passed():
            log("[tilew] deadline — remaining sheets next run")
            break
        if storage.get_json(tile_meta_key(fire_slug, sha)):
            continue  # another worker already finished this one
        key = f"raw/incidents/{fire_slug}/{rel}"
        parsed = cat.parse_product_filename(rel.rpartition("/")[2])
        with tempfile.TemporaryDirectory(prefix="tilew_") as td:
            local = Path(td) / "sheet.pdf"
            if not storage.get_file(key, local):
                continue
            tiles_dir = Path(td) / "tiles"
            r = geopdf.process_pdf(local, tiles_dir,
                                   sheet=parsed.get("sheet"),
                                   zoom_cap=args.zoom_cap)
            if not r["tiles"]:
                log(f"[tilew] {rel}: not tileable ({r.get('error')})")
                continue
            n = storage.put_tree(f"tiles/incidents/{fire_slug}/{sha}", tiles_dir)
            storage.put_json(tile_meta_key(fire_slug, sha), {
                "tiler_version": config.TILER_VERSION,
                "georeferenced": True,
                "projection": r["projection"],
                "tiles": r["tiles"],
            })
            log(f"[tilew] {rel}: {n} tiles z{r['tiles']['minzoom']}-{r['tiles']['maxzoom']}")
            done += 1
    log(f"[tilew] shard {args.shard}/{args.shards}: tiled {done}")
    return 0


def _tile_backlog(storage, state, log, *, cap: int = 12,
                  zoom_cap: int | None = None) -> set[str]:
    """Tile sheets that were probed georeferenced but never got tiles.

    The mirror loop only tiles freshly-downloaded files; a sheet deferred by
    the budget is replayed on later runs WITHOUT a local file, so low-priority
    products (pio, transport) could stay "overlay rendering" forever. Their
    bytes are in our bucket: download up to `cap` per run, tile, upload, and
    return the incident keys whose manifests need a rebuild."""
    if not geopdf.gdal_available():
        return set()
    touched: set[str] = set()
    tiled = 0
    for inc_key, inc in state.get("incidents", {}).items():
        if tiled >= cap or frames.deadline_passed():
            break
        fire_slug = inc.get("fire_slug")
        if not fire_slug:
            continue
        for rel, meta in (inc.get("files") or {}).items():
            if tiled >= cap or frames.deadline_passed():
                break
            sha = meta.get("sha16")
            rec = state["tiled"].get(sha) if sha else None
            if (not rec or rec.get("tiler_version") is not None
                    or not (rec.get("geo") or {}).get("georeferenced")):
                continue
            # A stateless tile worker may already have finished this sheet —
            # adopt its marker (cheap) instead of re-tiling.
            marker = storage.get_json(tile_meta_key(fire_slug, sha))
            if marker and marker.get("tiles"):
                geo = dict(rec.get("geo") or {})
                geo["georeferenced"] = True
                geo["projection"] = marker.get("projection")
                geo["tiles"] = marker["tiles"]
                state["tiled"][sha] = {
                    "tiler_version": marker.get("tiler_version",
                                                config.TILER_VERSION),
                    "at": state_mod.now_iso(),
                    "geo": geo,
                }
                touched.add(inc_key)
                continue
            key = f"raw/incidents/{fire_slug}/{rel}"
            parsed = cat.parse_product_filename(rel.rpartition("/")[2])
            with tempfile.TemporaryDirectory(prefix="tilebk_") as td:
                local = Path(td) / "sheet.pdf"
                if not storage.get_file(key, local):
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
                    n = storage.put_tree(
                        f"tiles/incidents/{fire_slug}/{sha}", tiles_dir)
                    storage.put_json(tile_meta_key(fire_slug, sha), {
                        "tiler_version": config.TILER_VERSION,
                        "georeferenced": True,
                        "projection": r["projection"],
                        "tiles": r["tiles"],
                    })
                    log(f"[geopdf] backlog {rel}: {n} tiles "
                        f"z{r['tiles']['minzoom']}-{r['tiles']['maxzoom']}")
                state["tiled"][sha] = {
                    "tiler_version": config.TILER_VERSION,
                    "at": state_mod.now_iso(),
                    "geo": geo,
                }
                tiled += 1
                touched.add(inc_key)
    if tiled:
        log(f"[geopdf] tile backlog: {tiled} sheet(s) this run")
    return touched


def _probe_backlog(storage, state, log, *, cap: int = 40) -> set[str]:
    """Classify already-mirrored PDFs that predate georeference detection.

    Sheets mirrored by early runs (or replayed by retention) have no
    state["tiled"] record, so manifests could only guess georeferenced=False —
    Big Grass showed 45 real map sheets as "flat". Retention means they will
    never be re-fetched from the FTP, but the bytes are in OUR bucket: download
    up to `cap` per run, gdalinfo-probe + preview them, and return the incident
    keys that gained classifications (their manifests need a rebuild).
    Bounded by cap and the shared wall clock; converges in a few runs.
    """
    if not geopdf.gdal_available():
        return set()
    touched: set[str] = set()
    probed = 0
    for inc_key, inc in state.get("incidents", {}).items():
        if probed >= cap or frames.deadline_passed():
            break
        fire_slug = inc.get("fire_slug")
        if not fire_slug:
            continue
        for rel, meta in (inc.get("files") or {}).items():
            if probed >= cap or frames.deadline_passed():
                break
            sha = meta.get("sha16")
            if (not sha or not rel.lower().endswith(".pdf")
                    or meta.get("kind") == "mobile"):
                continue
            rec = state["tiled"].get(sha)
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
            key = f"raw/incidents/{fire_slug}/{rel}"
            with tempfile.TemporaryDirectory(prefix="probe_") as td:
                local = Path(td) / "sheet.pdf"
                if not storage.get_file(key, local):
                    continue  # raw object missing — nothing to classify
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
                    storage.put_file(
                        f"previews/incidents/{fire_slug}/{sha}.png", preview)
                    geo["preview"] = True
                except Exception as exc:
                    log(f"[probe] preview failed for {rel}: {exc}")
                state["tiled"][sha] = {
                    "repair_at": state_mod.now_iso(),
                    "grat_at": state_mod.now_iso(),
                    # georeferenced sheets keep tiler_version None -> the
                    # normal tiling budget picks them up from B2 next runs
                    "tiler_version": None if probe["georeferenced"] else config.TILER_VERSION,
                    "at": state_mod.now_iso(),
                    "geo": geo,
                }
                probed += 1
                touched.add(inc_key)
    if probed:
        log(f"[probe] classified {probed} previously-unprobed sheets "
            f"across {len(touched)} incidents")
    return touched


def cmd_sync_incidents(args) -> int:
    job_started = cat.now_iso()
    storage = make_storage(args.dry_run, args.out)
    state = state_mod.load_state(storage)
    overrides = config.load_match_overrides()

    with make_client() as client:
        log("[incidents] fetching active fires ...")
        fires = fetch_active_fires(client)
        fires_by_slug = {f["fire_slug"]: f for f in fires}
        log(f"[incidents] active wildfires: {len(fires)}")

        # Classify legacy sheets from B2 before crawling, so this run's
        # manifests already reflect the corrections.
        frames.start_deadline(int(os.environ.get(
            "MIRROR_MAX_SECONDS", str(config.MIRROR_MAX_SECONDS_DEFAULT))))
        backlog_touched = _probe_backlog(storage, state, log)
        backlog_touched |= _tile_backlog(storage, state, log,
                                         zoom_cap=args.zoom_cap)
        for inc_key in backlog_touched:
            # cleared mtime => the crawl re-syncs it (files replay from cache,
            # zero downloads) and rebuilds its manifest with the new geo state
            state["incidents"][inc_key]["dir_mtime"] = None

        log("[incidents] crawling FTP year roots for candidate dirs ...")
        cands = _collect_candidates(client, args, fires)
        priority = [x for x in (args.priority_fires or "").split(",") if x.strip()]
        cands = _rank_candidates(cands, fires, priority)
        unchanged_skips = 0
        failed_incidents: list[str] = []
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

        mirrors: dict[str, dict] = {}
        matched = 0
        deferred = 0
        for cand in cands:
            if frames.deadline_passed():
                deferred += 1
                continue
            # deterministic evidence (skip listing work when unchanged & known)
            prev = state["incidents"].get(cand.key)
            if (prev and not args.force and prev.get("dir_mtime") == cand.dir_mtime
                    and prev.get("match")):
                log(f"[incidents] {cand.key}: unchanged since last sync — skipping")
                unchanged_skips += 1
                continue

            cand.unit_tokens = _gather_unit_tokens(client, cand)
            m = match_candidate(cand, fires, overrides)
            if m is None:
                log(f"[incidents] {cand.key}: UNMATCHED "
                    f"(tokens={dict(cand.unit_tokens) or 'none'}) — see match_overrides.json")
                continue
            if args.fire and m.fire_slug != args.fire:
                continue
            fire = fires_by_slug.get(m.fire_slug)
            if fire is None:
                continue
            matched += 1
            log(f"[incidents] {cand.key} -> {m.fire_slug} "
                f"({m.method}, conf={m.confidence})")

            mirror = IncidentMirror(
                client, storage, state,
                max_file_mb=args.max_file_mb,
                max_files=args.max_pdfs,
                products_keep=args.products_keep,
                ir_keep=args.ir_keep,
                since=args.since,
                force=args.force,
            )
            match_record = {"method": m.method, "confidence": m.confidence,
                            "token": m.token, "dir_url": cand.dir_url}
            try:
                res = mirror.sync_incident(
                    incident_key=cand.key, fire_slug=m.fire_slug,
                    dir_url=cand.dir_url, match=match_record, dir_mtime=cand.dir_mtime,
                )
            except httpx.HTTPError as exc:
                # One incident's FTP flaking (retries exhausted) must not kill
                # the run — its checkpoint state is intact, next run resumes.
                log(f"[incidents] {cand.key}: FAILED mid-mirror ({exc}) — "
                    "skipping; will resume next run")
                failed_incidents.append(cand.key)
                continue
            state["incidents"][cand.key]["dir_url"] = cand.dir_url
            log(f"[incidents] {cand.key}: listings={res.listings} "
                f"downloads={res.downloads} ({res.bytes_downloaded/1e6:.1f} MB) "
                f"unchanged={res.skipped_unchanged} too_big={res.skipped_too_big}")
            mirrors[cand.key] = {
                "fire": fire, "candidate": cand, "match": m, "result": res,
            }
            # Checkpoint per incident: files are already on B2, so if this run
            # dies the next one must not re-download them. (The first full run
            # was killed mid-tiling and lost every download record.)
            if res.downloads:
                state_mod.save_state(storage, state)

        if deferred:
            log(f"[incidents] download deadline reached — {deferred} candidate dirs "
                "deferred to the next scheduled run")
        _tile_and_manifest(args, storage, state, fires_by_slug, mirrors)
        state_mod.save_state(storage, state)  # tiling records before manifests

        # master catalog rebuild (catalog.json LAST)
        incident_matches = {}
        for inc_key, inc in state["incidents"].items():
            mrec = inc.get("match") or {}
            if inc.get("fire_slug"):
                incident_matches[inc["fire_slug"]] = {
                    "method": mrec.get("method"),
                    "confidence": mrec.get("confidence"),
                    "dir_url": inc.get("dir_url") or mrec.get("dir_url"),
                    "synced_at": inc.get("synced_at"),
                    "map_count": inc.get("map_count"),
                    "ir_count": inc.get("ir_count"),
                    "latest_upload": inc.get("latest_upload"),
                }
        # Preserve forecast fields owned by sync-catalogs: rebuild them from the
        # previously published catalog so this job never blanks them.
        prev_catalog = storage.get_json("catalogs/catalog.json") or {}
        spread_index = {
            f["fire_slug"]: f["spread_latest_run"]
            for f in prev_catalog.get("fires", [])
            if f.get("has_spread_forecast") and f.get("spread_latest_run")
        }
        version = int(state.get("catalog_version", 0)) + 1
        catalog = cat.build_catalog(fires, version=version,
                                    incident_matches=incident_matches,
                                    spread_index=spread_index,
                                    national_layers=prev_catalog.get("national_layers"))
        storage.put_json(f"catalogs/versions/catalog.{version}.json", catalog)
        storage.put_json("catalogs/catalog.json", catalog)
        state["catalog_version"] = version
        state_mod.save_state(storage, state)

        log(f"[incidents] done: candidates={len(cands)} matched={matched} "
            f"mirrored_incidents={len(mirrors)} catalog_version={version}")

        downloads = sum(m["result"].downloads for m in mirrors.values())
        dl_bytes = sum(m["result"].bytes_downloaded for m in mirrors.values())
        health.publish(storage, "mirror", {
            "started_at": job_started,
            "finished_at": cat.now_iso(),
            "ok": True,
            "note": (f"{len(failed_incidents)} incident(s) skipped on FTP errors"
                     if failed_incidents else None),
            "catalog_version": version,
            "candidates": len(cands),
            "unchanged_skips": unchanged_skips,
            "mirrored_incidents": len(mirrors),
            "files_downloaded": downloads,
            "bytes_downloaded": dl_bytes,
            "failed_incidents": failed_incidents,
            "deadline_hit": frames.deadline_passed(),
            "gdal_available": geopdf.gdal_available(),
        }, log=log)
    return 0


# ===========================================================================
# prune
# ===========================================================================

def cmd_prune(args) -> int:
    """Manual-only, explicit-opt-in deletion. USER POLICY (2026-08-17): FTP-
    derived incident data is kept indefinitely — this command refuses to run
    without BOTH --days and --confirm, and is never invoked by CI."""
    from datetime import datetime, timedelta, timezone

    if args.days is None or not args.confirm:
        log("[prune] refused: incident data is kept indefinitely by policy. "
            "To delete anyway, pass BOTH --days N and --confirm.")
        return 2

    storage = make_storage(args.dry_run, args.out)
    state = state_mod.load_state(storage)

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
        sp.add_argument("--fire", help="restrict to one fire (fire_slug, e.g. 'elk')")
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
    sp.set_defaults(func=cmd_prune)

    sp = sub.add_parser("cleanup-spread-frames",
                        help="one-time: delete the dead pre-rendered spread "
                             "frame/legend objects (frames/spread/, frames/legends/)")
    common(sp)
    sp.add_argument("--confirm", action="store_true",
                    help="required flag to actually delete")
    sp.set_defaults(func=cmd_cleanup_spread_frames)
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
