"""CLI: python -m responder_worker.cli {sync-catalogs|sync-incidents|backfill|prune}

--dry-run everywhere: no B2 needed; outputs land under ./out/ mirroring the B2
key layout, state at ./out/state/state.json.
"""

from __future__ import annotations

import argparse
import sys
import tempfile
from collections import Counter
from pathlib import Path

from . import catalogs as cat
from . import config, geopdf, ir_vectors, pyrecast, state as state_mod
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
from .mirror import IncidentMirror

DEFAULT_OUT = Path(__file__).resolve().parent.parent / "out"


def log(msg: str) -> None:
    print(msg, flush=True)


# ===========================================================================
# sync-catalogs
# ===========================================================================

def cmd_sync_catalogs(args) -> int:
    storage = make_storage(args.dry_run, args.out)
    state = state_mod.load_state(storage)

    with make_client() as client:
        log("[catalogs] fetching active fires ...")
        fires = fetch_active_fires(client)
        log(f"[catalogs] active wildfires: {len(fires)}")

        log("[catalogs] fetching gs02 capabilities ...")
        last_seq = None if args.force else state["pyrecast"].get("gs02_update_sequence")
        seq, gs02_runs = pyrecast.fetch_gs02_runs(client, last_seq)
        if gs02_runs is None:
            log(f"[catalogs] gs02 unchanged (updateSequence={seq}) — keeping previous runs catalog")
        else:
            log(f"[catalogs] gs02 updateSequence={seq}, runs={len(gs02_runs)}")

        log("[catalogs] probing gs01 HRRR cycles (namespace-filtered caps) ...")
        gs01_runs = pyrecast.probe_gs01_runs(client)
        log(f"[catalogs] gs01 hrrr workspaces found: {sorted(gs01_runs)}")

        log("[catalogs] probing gs01 national detection layers ...")
        national_layers = pyrecast.probe_gs01_national_layers(client)
        if national_layers:
            log(f"[catalogs] national perimeters layer: {national_layers['current_year_perimeters']['layer']}")
        else:
            log("[catalogs] national perimeters layer unavailable (frontend hides it)")

    if gs02_runs is None:
        # updatesequence short-circuit: keep the previously published runs catalog
        pyre = storage.get_json("catalogs/pyrecast_runs.json") or cat.build_pyrecast_runs(fires, {})
        gs02_runs = {}
    else:
        pyre = cat.build_pyrecast_runs(fires, gs02_runs)
    weather = cat.build_weather_runs(gs01_runs)

    spread_index = {
        slug: entry["runs"][0]["run_time"]
        for slug, entry in pyre["fires"].items()
        if entry["runs"]
    }

    # keep incident matches recorded by previous sync-incidents runs
    incident_matches: dict[str, dict] = {}
    for inc_key, inc in state.get("incidents", {}).items():
        m = inc.get("match") or {}
        if inc.get("fire_slug") and m:
            incident_matches[inc["fire_slug"]] = {
                "method": m.get("method"),
                "confidence": m.get("confidence"),
                "dir_url": inc.get("dir_url") or m.get("dir_url"),
                "synced_at": inc.get("synced_at"),
            }

    version = int(state.get("catalog_version", 0)) + 1
    catalog = cat.build_catalog(
        fires, version=version,
        incident_matches=incident_matches, spread_index=spread_index,
        national_layers=national_layers,
    )

    # upload order: runs catalogs -> catalog.json LAST
    storage.put_json("catalogs/pyrecast_runs.json", pyre)
    storage.put_json("catalogs/weather_runs.json", weather)
    storage.put_json(f"catalogs/versions/catalog.{version}.json", catalog)
    storage.put_json("catalogs/catalog.json", catalog)

    state["pyrecast"]["gs02_update_sequence"] = seq
    state["catalog_version"] = version
    state_mod.save_state(storage, state)

    weather_runs = weather["models"]["hrrr"]["runs"]
    log(
        "[catalogs] done: "
        f"fires={catalog['counts']['active_fires']} "
        f"spread_fires={catalog['counts']['spread_forecast_fires']} "
        f"spread_workspaces={len(gs02_runs)} "
        f"unmatched_workspaces={len(pyre['unmatched_workspaces'])} "
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

    for inc_key, bundle in mirrors.items():
        fire = bundle["fire"]
        fire_slug = fire["fire_slug"]
        res = bundle["result"]
        maps: list[dict] = []
        ir_by_flight: dict[str, dict] = {}

        for mf in res.files:
            if mf.kind == "ir":
                d = ir_by_flight.setdefault(mf.rel_dir, {"files": []})
                d["files"].append(mf)
                continue
            if not mf.filename.lower().endswith(".pdf"):
                continue
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
                elif tile_budget > 0:
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
                else:
                    pending = True
            elif already_tiled:
                geo = tiled_state.get("geo", geo)

            maps.append(cat.map_entry(
                parsed=parsed, kind=mf.kind, sha_id=sha_id, fire_slug=fire_slug,
                pdf_key=mf.key, size_bytes=mf.size, geo=geo, rev=mf.rev,
                tiling_pending=pending,
            ))

        ir_flights = _ir_flights(args, storage, fire, ir_by_flight)

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


def _ir_flights(args, storage, fire, ir_by_flight: dict[str, dict]) -> list[dict]:
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

        flight_id = None
        if zips:
            stem = zips[0].filename.rsplit(".", 1)[0]
            stem = stem[: -len("_Shapefiles")] if stem.endswith("_Shapefiles") else stem
            toks = [t for t in stem.split("_")
                    if normalize_name(t).replace(" ", "") != fire_name_norm]
            flight_id = "_".join(toks)

        est_acres = None
        if readmes and readmes[0].local_path and readmes[0].local_path.exists():
            est_acres = ir_vectors.parse_estimated_acres(
                readmes[0].local_path.read_text(errors="replace"))

        geojson_url = None
        heat_types: list[str] = []
        if zips and flight_id and zips[0].local_path:
            try:
                with tempfile.TemporaryDirectory() as td:
                    gj = Path(td) / f"{flight_id}.geojson"
                    info = ir_vectors.process_ir_zip(
                        zips[0].local_path, gj, flight_id=flight_id)
                    key = f"vectors/ir/{fire_slug}/{flight_id}.geojson"
                    storage.put_file(key, gj)
                    geojson_url = f"/{key}"
                    heat_types = info["heat_types"]
                    log(f"[ir] {flight_id}: {info['feature_count']} features "
                        f"({', '.join(heat_types)})")
            except Exception as exc:
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


def cmd_sync_incidents(args) -> int:
    storage = make_storage(args.dry_run, args.out)
    state = state_mod.load_state(storage)
    overrides = config.load_match_overrides()

    with make_client() as client:
        log("[incidents] fetching active fires ...")
        fires = fetch_active_fires(client)
        fires_by_slug = {f["fire_slug"]: f for f in fires}
        log(f"[incidents] active wildfires: {len(fires)}")

        log("[incidents] crawling FTP year roots for candidate dirs ...")
        cands = _collect_candidates(client, args, fires)
        log(f"[incidents] candidate incident dirs: {len(cands)}")

        mirrors: dict[str, dict] = {}
        matched = 0
        for cand in cands:
            # deterministic evidence (skip listing work when unchanged & known)
            prev = state["incidents"].get(cand.key)
            if (prev and not args.force and prev.get("dir_mtime") == cand.dir_mtime
                    and prev.get("match")):
                log(f"[incidents] {cand.key}: unchanged since last sync — skipping")
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
            res = mirror.sync_incident(
                incident_key=cand.key, fire_slug=m.fire_slug,
                dir_url=cand.dir_url, match=match_record, dir_mtime=cand.dir_mtime,
            )
            state["incidents"][cand.key]["dir_url"] = cand.dir_url
            log(f"[incidents] {cand.key}: listings={res.listings} "
                f"downloads={res.downloads} ({res.bytes_downloaded/1e6:.1f} MB) "
                f"unchanged={res.skipped_unchanged} too_big={res.skipped_too_big}")
            mirrors[cand.key] = {
                "fire": fire, "candidate": cand, "match": m, "result": res,
            }

        _tile_and_manifest(args, storage, state, fires_by_slug, mirrors)

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
    return 0


# ===========================================================================
# prune
# ===========================================================================

def cmd_prune(args) -> int:
    from datetime import datetime, timedelta, timezone

    storage = make_storage(args.dry_run, args.out)
    state = state_mod.load_state(storage)

    with make_client() as client:
        fires = fetch_active_fires(client)
    active_slugs = {f["fire_slug"] for f in fires}

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=config.PRUNE_INACTIVE_DAYS)
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
            log(f"[prune] {slug}: inactive > {config.PRUNE_INACTIVE_DAYS}d — deleting")
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

    sp = sub.add_parser("sync-catalogs", help="fire API + pyrecast caps -> catalogs")
    common(sp)
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
        sp.add_argument("--zoom-cap", type=int, default=None,
                        help="cap tile maxzoom (fast dry-run tiling)")

    sp = sub.add_parser("sync-incidents", help="FTP crawl + match + mirror + GeoPDF")
    incidents_args(sp)
    sp.set_defaults(func=cmd_sync_incidents)

    sp = sub.add_parser("backfill", help="sync-incidents for one fire with --since")
    incidents_args(sp)
    sp.set_defaults(func=cmd_backfill)

    sp = sub.add_parser("prune", help="drop fires inactive > 14 days")
    common(sp)
    sp.set_defaults(func=cmd_prune)
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
