"""Routing-bundle subcommands (registered from cli.build_parser):

  routing-plan   read our published catalog.json (zero fire-API index
                 traffic), refresh changed perimeters from the DEV fire API,
                 decide actions and AOIs, pack region-affine shards -> plan.json
  routing-build  one shard of a plan: download each Geofabrik region once,
                 extract every fire's OSM in one osmium pass, build bundles
  routing-one    plan + build for one fire (or an ad-hoc --aoi) in-process
  routing-index  catalogs/routing.json from the per-fire pointers, plus the
                 catalogs/health/routing.json heartbeat

Runs in the routing-bundles concurrency group; never writes state/state.json
or catalog.json. Nothing is deleted.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import traceback
from datetime import datetime, timezone
from pathlib import Path

import httpx

from . import config, frames, gdal_cli, health_docs, osm_extract, perimeters
from . import routing_bundle as rb
from . import routing_plan as rp
from .b2 import make_storage
from .http import get, make_client

BUILD_TOOLS = ["ogr2ogr", "gdalwarp", "gdal_translate", "gdal_rasterize", "gdaltransform",
               "gdalinfo", "osmium"]


def log(msg: str) -> None:
    print(msg, flush=True)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _public_json(client: httpx.Client, key: str):
    try:
        return get(client, f"{config.data_base()}/{key}", timeout=60).json()
    except httpx.HTTPError:
        return None


def _read_json(storage, client, key: str):
    """Our own published doc: the storage (dry-run out/ or B2) first, then
    the public bucket (a dry run still sees the live pointers)."""
    doc = storage.get_json(key)
    return doc if doc is not None else _public_json(client, key)


def _match(f: dict, needle: str) -> bool:
    n = needle.strip().lower()
    return n in {str(f.get("cornea_id") or "").lower(), str(f.get("fire_slug") or "").lower(),
                 str(f.get("name") or "").lower(), rp.fire_key(f.get("cornea_id") or "")}


def _pad(b, d=0.01):
    return (b[0] - d, b[1] - d, b[2] + d, b[3] + d)


def us_regions(client) -> list[dict]:
    """Geofabrik's US leaf regions, or a loud failure.

    A layout change in the index (it once re-parented every state) makes
    us_leaf_regions match few or no regions. Left to the per-fire guard in
    run_shard, every fire would then record 'osm region unavailable' and,
    after ROUTING_BACKOFF_FAILURES runs, sit in a 24 h backoff nationwide.
    Raising here fails the job once, before any fire records a failure."""
    regions = osm_extract.us_leaf_regions(osm_extract.load_index(client))
    if len(regions) < config.ROUTING_MIN_US_REGIONS:
        raise RuntimeError(
            f"Geofabrik index gave {len(regions)} US leaf regions "
            f"(expected >= {config.ROUTING_MIN_US_REGIONS}); its layout changed? "
            "See osm_extract.us_leaf_regions")
    return regions


def make_plan(client, storage, *, fires: list[dict], regions_all: list[dict] | None,
              shards: int, priority: list[str], force: bool, now: datetime,
              max_fires: int | None = None, deadline_passed=lambda: False,
              adhoc: dict | None = None) -> dict:
    entries, counts = [], {"skip": 0, "backoff": 0, "unsupported": 0, "deadline": 0}
    for f in fires:
        cid = f.get("cornea_id")
        if not cid:
            continue
        if deadline_passed():
            counts["deadline"] += 1
            continue
        fk = rp.fire_key(cid)
        point = f.get("coordinates")
        if not adhoc and not rp.in_conus(point):
            counts["unsupported"] += 1
            continue
        pointer = storage.get_json(rb.pointer_key(fk))
        fstate = storage.get_json(rb.state_key(fk)) or {}
        per = fstate.get("perimeter")
        if adhoc:
            per = {"bbox": adhoc["bbox"], "date": None, "path": None}
        elif force or not per or per.get("poly_last_updated") != f.get("poly_last_updated"):
            try:
                lp = perimeters.latest_perimeter(client, cid)
                new = ({"path": lp["path"], "date": lp["date"], "bbox": lp["bbox"],
                        "poly_last_updated": f.get("poly_last_updated")} if lp else
                       {"path": None, "date": None, "bbox": None,
                        "poly_last_updated": f.get("poly_last_updated")})
                if new != per:
                    per = new
                    storage.put_json(rb.state_key(fk), dict(fstate, schema=1, perimeter=per))
            except Exception as exc:  # noqa: BLE001 — keep the cached bbox
                log(f"[routing-plan] {f.get('fire_slug')}: perimeter fetch failed: {str(exc)[:160]}")
        pbbox = (per or {}).get("bbox")
        if not point and not pbbox:
            counts["unsupported"] += 1
            continue
        if not point:
            point = [(pbbox[0] + pbbox[2]) / 2, (pbbox[1] + pbbox[3]) / 2]
        aoi = rp.aoi_for(point, pbbox, (pointer or {}).get("aoi"))
        action, reason = rp.action_for(pointer, fstate, aoi, now, force)
        if action in ("skip", "backoff"):
            counts[action] += 1
            continue
        regions = (osm_extract.regions_for_bbox(regions_all, _pad(aoi["bbox4326"]))
                   if regions_all else [])
        entries.append({
            "cornea_id": cid, "fire_key": fk, "name": f.get("name"), "slug": f.get("fire_slug"),
            "acres": f.get("acres"), "point": point, "aoi": aoi, "action": action,
            "reason": reason, "regions": regions,
            "perimeter": {k: (per or {}).get(k) for k in ("path", "date", "bbox")},
            "prev_bundle_id": (pointer or {}).get("bundle_id"),
        })
    entries = rp.priority_order(entries, priority)
    if max_fires:
        entries = entries[:max_fires]
    packed = rp.assign_shards(entries, shards)
    return {"schema": "rd-routing-plan/1", "generated_at": _iso(now),
            "shards": [{"shard": i, "fires": fs} for i, fs in enumerate(packed)],
            "counts": dict(counts, planned=len(entries))}


def cmd_routing_plan(args) -> int:
    storage = make_storage(args.dry_run, args.out)
    frames.start_deadline(args.max_seconds)
    with make_client() as client:
        catalog = _public_json(client, "catalogs/catalog.json") or {}
        fires = catalog.get("fires") or []
        if args.fire:
            fires = [f for f in fires if _match(f, args.fire)]
        regions = us_regions(client)
        plan = make_plan(client, storage, fires=fires, regions_all=regions, shards=args.shards,
                         priority=args.priority_fires.split(","), force=args.force, now=_now(),
                         max_fires=args.max_fires, deadline_passed=frames.deadline_passed)
        plan["trails"] = _read_json(storage, client, "catalogs/trails.json")
    Path(args.plan_out).write_text(json.dumps(plan, indent=1))
    active = [s["shard"] for s in plan["shards"] if s["fires"]]
    log(f"[routing-plan] {plan['counts']} -> shards {active}")
    gh = os.environ.get("GITHUB_OUTPUT")
    if gh:
        with open(gh, "a") as f:
            f.write(f"matrix={json.dumps({'shard': active or [0]})}\n")
            f.write(f"work={'true' if active else 'false'}\n")
    return 0


def run_shard(client, storage, plan: dict, shard: int, *, workdir: Path, local_pbf: Path | None = None,
              trails_src: str | None = None, deadline_passed=lambda: False, log=log,
              build=rb.build_fire, keep_work: bool = False, **build_kw) -> dict:
    fires = next((s["fires"] for s in plan["shards"] if s["shard"] == shard), [])
    result = {"shard": shard, "built": [], "unchanged": [], "failed": [], "deferred": []}
    if not fires:
        return result
    tr = plan.get("trails") or {}
    if trails_src is None and tr.get("fgb"):
        trails_src = f"/vsicurl/{config.data_base()}{tr['fgb']}"
    # 1. OSM: each region downloaded once, every fire extracted in one pass
    extracts: dict[str, list[Path]] = {}
    osm_dates: dict[str, str | None] = {}
    if local_pbf:
        for e in fires:
            ex = osm_extract.extract_fires(local_pbf, {e["fire_key"]: _pad(e["aoi"]["bbox4326"])},
                                           workdir / f"osm_{e['fire_key']}", log=log)
            extracts[e["fire_key"]] = [ex[e["fire_key"]]]
    else:
        regions_needed: list[str] = []
        for e in fires:
            for r in e["regions"]:
                if r not in regions_needed:
                    regions_needed.append(r)
        # reloaded for today's PBF URLs; a short list raises before any fire
        # records a failure (us_regions)
        index = {r["id"]: r for r in us_regions(client)} if regions_needed else {}
        for rid in regions_needed:
            if deadline_passed():
                break
            reg = index.get(rid)
            if not reg:
                continue
            rdir = workdir / rid.replace("/", "_")
            rdir.mkdir(parents=True, exist_ok=True)
            try:
                pbf, date = osm_extract.download_region(client, reg, rdir, log=log)
                osm_dates[rid] = date
                mine = {e["fire_key"]: _pad(e["aoi"]["bbox4326"]) for e in fires if rid in e["regions"]}
                for fk, p in osm_extract.extract_fires(pbf, mine, rdir, log=log).items():
                    extracts.setdefault(fk, []).append(p)
                pbf.unlink(missing_ok=True)
            except Exception as exc:  # noqa: BLE001 — its fires fail below and retry
                log(f"[routing-build] region {rid} failed: {str(exc)[:200]}")
    # 2. fires, biggest first
    for e in fires:
        fk = e["fire_key"]
        if deadline_passed():
            result["deferred"].append(e["cornea_id"])
            continue
        parts = extracts.get(fk) or []
        # no region at all is a region-choice bug, never "a fire without roads"
        if not local_pbf and (not e["regions"] or len(parts) < len(e["regions"])):
            result["failed"].append({"cornea_id": e["cornea_id"], "slug": e.get("slug"),
                                     "error": "osm region unavailable"})
            rb.record_state(storage, fk, ok=False, now=_now(), error="osm region unavailable")
            continue
        fwd = workdir / f"fire_{fk}"
        try:
            pbf = parts[0] if parts else None
            if len(parts) > 1:
                pbf = fwd / "merged.osm.pbf"
                fwd.mkdir(parents=True, exist_ok=True)
                gdal_cli.run(["osmium", "merge", *map(str, parts), "-o", str(pbf), "--overwrite"],
                             timeout=900)
            dates = sorted(d for r, d in osm_dates.items() if r in e["regions"] and d)
            res = build(client, storage, e, workdir=fwd, osm_pbf=pbf,
                        osm_date=dates[0] if dates else None, osm_regions=e["regions"],
                        trails_src=trails_src, trails_build=tr.get("build_id"), log=log, **build_kw)
            rb.record_state(storage, fk, ok=True, now=_now(), extra={"bundle_id": res["bundle_id"]})
            result["built" if res["status"] == "built" else "unchanged"].append(e["cornea_id"])
        except Exception as exc:  # noqa: BLE001 — one fire never kills the shard
            msg = str(exc).strip().splitlines()[-1][:300] if str(exc).strip() else repr(exc)
            log(f"[routing-build] {e.get('slug') or fk} FAILED: {msg}")
            if os.environ.get("ROUTING_DEBUG"):
                traceback.print_exc()
            result["failed"].append({"cornea_id": e["cornea_id"], "slug": e.get("slug"), "error": msg})
            rb.record_state(storage, fk, ok=False, now=_now(), error=msg)
        finally:
            if not keep_work:
                shutil.rmtree(fwd, ignore_errors=True)
    return result


def cmd_routing_build(args) -> int:
    storage = make_storage(args.dry_run, args.out)
    plan = json.loads(Path(args.plan).read_text())
    frames.start_deadline(args.max_seconds)
    missing = gdal_cli.missing(BUILD_TOOLS)
    result: dict = {"shard": args.shard}
    if missing:
        log(f"[routing-build] GDAL/osmium unavailable (missing: {', '.join(missing)}) — nothing to do")
        result["note"] = f"tools missing: {', '.join(missing)}"
    else:
        log(f"[routing-build] shard {args.shard}: GDAL {gdal_cli.version()}")
        base = Path(args.workdir) if args.workdir else None
        with tempfile.TemporaryDirectory(prefix="routing_", dir=base) as td, make_client() as client:
            result = run_shard(client, storage, plan, args.shard, workdir=Path(td),
                               deadline_passed=frames.deadline_passed)
    if args.result_out:
        Path(args.result_out).write_text(json.dumps(result, indent=1))
    log(f"[routing-build] shard {args.shard}: built {len(result.get('built', []))}, "
        f"unchanged {len(result.get('unchanged', []))}, failed {len(result.get('failed', []))}, "
        f"deferred {len(result.get('deferred', []))}")
    return 0


def cmd_routing_one(args) -> int:
    storage = make_storage(args.dry_run, args.out)
    now = _now()
    with make_client() as client:
        if args.aoi:
            w, s, e, n = (float(v) for v in args.aoi.split(","))
            name = args.name or "adhoc"
            fires = [{"cornea_id": f"adhoc-{name}", "fire_slug": name, "name": name,
                      "coordinates": [(w + e) / 2, (s + n) / 2], "acres": 0}]
            adhoc = {"bbox": (w, s, e, n)}
        else:
            catalog = _public_json(client, "catalogs/catalog.json") or {}
            fires = [f for f in catalog.get("fires") or [] if _match(f, args.fire)]
            adhoc = None
            if not fires:
                log(f"[routing-one] no active fire matches {args.fire!r}")
                return 2
        regions = None if args.local_pbf else us_regions(client)
        plan = make_plan(client, storage, fires=fires[:1], regions_all=regions, shards=1,
                         priority=[], force=True, now=now, adhoc=adhoc)
        plan["trails"] = None if args.trails_src else _read_json(storage, client, "catalogs/trails.json")
        work = Path(args.keep_work) if args.keep_work else Path(tempfile.mkdtemp(prefix="routing1_"))
        work.mkdir(parents=True, exist_ok=True)
        res = run_shard(client, storage, plan, 0, workdir=work,
                        local_pbf=Path(args.local_pbf) if args.local_pbf else None,
                        trails_src=args.trails_src, keep_work=bool(args.keep_work))
        if not args.keep_work:
            shutil.rmtree(work, ignore_errors=True)
    log(f"[routing-one] {json.dumps(res)}")
    if res["built"] or res["unchanged"]:
        # Merge into the live index (never replace it with just this fire).
        idx = storage.get_json("catalogs/routing.json") or {}
        fresh = rb.index_doc({cid: storage.get_json(rb.pointer_key(rp.fire_key(cid)))
                              for cid in res["built"] + res["unchanged"]}, _now())
        if (idx.get("recipe") or config.ROUTING_RECIPE) == config.ROUTING_RECIPE:
            fresh["fires"] = {**(idx.get("fires") or {}), **fresh["fires"]}
        storage.put_json("catalogs/routing.json", fresh)
    return 0 if not res["failed"] else 1


def cmd_routing_index(args) -> int:
    storage = make_storage(args.dry_run, args.out)
    started = _now()
    results = []
    if args.results and Path(args.results).exists():
        for p in sorted(Path(args.results).rglob("*.json")):
            try:
                results.append(json.loads(p.read_text()))
            except ValueError:
                continue
    with make_client() as client:
        catalog = _public_json(client, "catalogs/catalog.json") or {}
    fires = [f for f in catalog.get("fires") or [] if f.get("cornea_id")]
    pointers, unsupported = {}, 0
    for f in fires:
        if not rp.in_conus(f.get("coordinates")):
            unsupported += 1
            continue
        p = storage.get_json(rb.pointer_key(rp.fire_key(f["cornea_id"])))
        if p:
            pointers[f["cornea_id"]] = p
    idx = rb.index_doc(pointers, _now())
    storage.put_json("catalogs/routing.json", idx)
    ages = []
    for p in idx["fires"].values():
        try:
            ages.append((_now() - datetime.fromisoformat(p["built_at"].replace("Z", "+00:00")))
                        .total_seconds() / 3600)
        except ValueError:
            pass
    failed = [f for r in results for f in r.get("failed", [])]
    entry = {
        "started_at": _iso(started), "finished_at": _iso(_now()), "ok": True,
        "fires_active": len(fires), "with_bundle": len(idx["fires"]), "unsupported": unsupported,
        "built": sum(len(r.get("built", [])) for r in results),
        "unchanged": sum(len(r.get("unchanged", [])) for r in results),
        "deferred": sum(len(r.get("deferred", [])) for r in results),
        "failed": failed[:40],
        "oldest_bundle_age_h": round(max(ages), 1) if ages else None,
        "recipe": config.ROUTING_RECIPE,
        "note": f"{len(idx['fires'])}/{len(fires) - unsupported} CONUS fires have a bundle"
                + (f"; {len(failed)} failed this run" if failed else ""),
    }
    health_docs.publish(storage, "routing", entry, log=log)
    log(f"[routing-index] {entry['note']}")
    return 0


def register(sub, common) -> None:
    sp = sub.add_parser("routing-plan", help="plan per-fire routing bundle builds")
    common(sp)
    sp.add_argument("--plan-out", default="plan.json")
    sp.add_argument("--shards", type=int,
                    default=int(os.environ.get("ROUTING_SHARDS", config.ROUTING_SHARDS_DEFAULT)))
    sp.add_argument("--priority-fires", default=os.environ.get("PRIORITY_FIRES", ""))
    sp.add_argument("--fire", help="restrict to one fire (cornea_id, slug or name)")
    sp.add_argument("--max-fires", type=int, default=None)
    sp.add_argument("--max-seconds", type=int,
                    default=int(os.environ.get("ROUTING_PLAN_MAX_SECONDS", "1500")))
    sp.set_defaults(func=cmd_routing_plan)

    sp = sub.add_parser("routing-build", help="build one shard of a routing plan")
    common(sp)
    sp.add_argument("--plan", required=True)
    sp.add_argument("--shard", type=int, default=0)
    sp.add_argument("--result-out", default=None)
    sp.add_argument("--workdir", default=os.environ.get("RUNNER_TEMP") or None)
    sp.add_argument("--max-seconds", type=int,
                    default=int(os.environ.get("ROUTING_MAX_SECONDS",
                                               config.ROUTING_MAX_SECONDS_DEFAULT)))
    sp.set_defaults(func=cmd_routing_build)

    sp = sub.add_parser("routing-one", help="plan + build one fire or an ad-hoc AOI (dev/verify)")
    common(sp)
    g = sp.add_mutually_exclusive_group(required=True)
    g.add_argument("--fire", help="cornea_id, slug or name of an active fire")
    g.add_argument("--aoi", help="W,S,E,N lon/lat for an ad-hoc area")
    sp.add_argument("--name", default=None)
    sp.add_argument("--local-pbf", default=None, help="use this OSM PBF instead of Geofabrik")
    sp.add_argument("--trails-src", default=None, help="local trails.fgb/gpkg instead of B2")
    sp.add_argument("--keep-work", default=None, help="keep intermediates in this dir")
    sp.set_defaults(func=cmd_routing_one)

    sp = sub.add_parser("routing-index", help="catalogs/routing.json + routing health")
    common(sp)
    sp.add_argument("--results", default=None, help="dir of routing-build --result-out files")
    sp.set_defaults(func=cmd_routing_index)
