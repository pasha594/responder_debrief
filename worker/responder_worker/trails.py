"""National trails build: USFS + BLM + NPS -> one normalized layer ->
trails.fgb (routing input, spatially indexed) + trails.pmtiles (map overlay).

Run by `sync-trails` (.github/workflows/trails.yml, its own concurrency group;
never touches state/state.json or catalog.json). Steps:

1. probe  — cheap change signals: USFS zip ETag/Last-Modified (HEAD), BLM
            dataLastEditDate + count, NPS max(EDITDATE) + count.
2. decide — build when a source changed and the last build is >= 6 days old,
            when the last build is >= 30 days old, or with --force.
3. fetch  — USFS weekly FGDB zip (atomic, unlike the REST service that was
            caught mid-reload); BLM/NPS via GDAL's ESRIJSON auto-paging, with
            the returned count checked against returnCountOnly.
4. normalize (trails_normalize, streamed GeoJSONSeq) + a count sanity gate.
5. build  — GPKG with trails_lo/trails_hi, FlatGeobuf, and PMTiles z7-13
            through the GDAL 3.8.4 PMTiles writer with a two-layer CONF.
            CPL_DEBUG=MVT lines count tiles GDAL silently degraded.
6. publish — trails/b{build_id}/{trails.pmtiles, trails.fgb, build.json},
            then catalogs/trails.json (the pointer) LAST, then
            state/trails.json and catalogs/health/trails.json.

Nothing is ever deleted: old builds stay until a manual prune.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import quote

import httpx

from . import config, gdal_cli, health_docs, pmtiles_inspect
from . import trails_normalize as tn
from .b2 import Storage
from .http import download_to, get

STATE_KEY = "state/trails.json"
POINTER_KEY = "catalogs/trails.json"
SOURCES = ("usfs", "blm_managed", "blm_not_assessed", "nps")
PMTILES_MINZOOM, PMTILES_MAXZOOM = 7, 13
# Header bounds: GDAL takes the data extent; NPS reaches Guam and Samoa,
# which makes the header centre meaningless. AK/HI/PR stay in.
PMTILES_SPAT = (-179.9, 17.5, -64.0, 71.5)

USFS_SELECT = ("TRAIL_CN,BMP,TRAIL_NO,TRAIL_NAME,TRAIL_CLASS,ALLOWED_TERRA_USE,"
               "HIKER_PEDESTRIAN_MANAGED,HIKER_PEDESTRIAN_RESTRICTED,"
               "SPECIAL_MGMT_AREA,NATIONAL_TRAIL_DESIGNATION")
BLM_FIELDS = ("OBJECTID,ROUTE_PRMRY_NM,ADMIN_ST,PLAN_ALLOW_MODE_TRNSPRT,"
              "PLAN_ACCESS_RSTRCT,PLAN_SEASON_RSTRCT_CODE,OBSRVE_ROUTE_USE_CLASS,"
              "ROUTE_SPCL_DSGNTN_TYPE")
NPS_FIELDS = ("OBJECTID,TRLNAME,TRLALTNAME,MAPLABEL,TRLSTATUS,TRLTYPE,TRLCLASS,"
              "TRLUSE,TRLFEATTYPE,SEASONAL,SEASDESC,UNITNAME,EDITDATE,"
              "PUBLICDISPLAY,DATAACCESS")
NPS_WHERE = "PUBLICDISPLAY='Public Map Display' AND DATAACCESS='Unrestricted'"

_DEGRADED = re.compile(r"tile size is \d+ > \d+")


def canonical(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _ms_date(ms) -> str | None:
    try:
        return datetime.fromtimestamp(float(ms) / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# probe + decide (pure where possible)
# ---------------------------------------------------------------------------

def _arcgis_count(client: httpx.Client, layer_url: str, where: str = "1=1") -> int:
    r = get(client, f"{layer_url}/query", params={"where": where,
                                                   "returnCountOnly": "true", "f": "json"})
    return int(r.json()["count"])


def _arcgis_max(client: httpx.Client, layer_url: str, field: str) -> int | None:
    stats = json.dumps([{"statisticType": "max", "onStatisticField": field,
                         "outStatisticFieldName": "m"}])
    r = get(client, f"{layer_url}/query", params={"where": "1=1", "outStatistics": stats,
                                                   "f": "json"})
    feats = r.json().get("features") or []
    if not feats:
        return None
    v = (feats[0].get("attributes") or {}).get("m")
    return int(v) if v is not None else None


def probe(client: httpx.Client) -> dict:
    """Current change signals for every source (a few small requests)."""
    sig: dict = {}
    r = client.head(config.USFS_TRAILS_ZIP, timeout=60)
    r.raise_for_status()
    sig["usfs"] = {"etag": r.headers.get("etag"),
                   "last_modified": r.headers.get("last-modified"),
                   "bytes": int(r.headers.get("content-length") or 0)}
    for name, url in (("blm_managed", config.BLM_MANAGED_TRAILS),
                      ("blm_not_assessed", config.BLM_NOT_ASSESSED_TRAILS)):
        meta = get(client, url, params={"f": "json"}).json()
        sig[name] = {"count": _arcgis_count(client, url),
                     "max_edit": (meta.get("editingInfo") or {}).get("dataLastEditDate")}
    sig["nps"] = {"count": _arcgis_count(client, config.NPS_TRAILS, NPS_WHERE),
                  "max_edit": _arcgis_max(client, config.NPS_TRAILS, "EDITDATE")}
    return sig


def build_id_for(sig: dict, now: datetime) -> str:
    h = hashlib.sha256(canonical({"recipe": config.TRAILS_RECIPE, "sources": sig}).encode())
    return f"{now:%Y%m%d}-{h.hexdigest()[:8]}"


def decide(sig: dict, prev: dict | None, now: datetime, force: bool) -> tuple[bool, str]:
    if force:
        return True, "forced"
    if not prev or not prev.get("build_id"):
        return True, "first_build"
    try:
        age_d = (now - datetime.fromisoformat(prev["built_at"].replace("Z", "+00:00"))).total_seconds() / 86400
    except (KeyError, ValueError):
        age_d = 1e9
    changed = canonical(sig) != canonical(prev.get("signature") or {})
    if age_d >= config.TRAILS_MAX_DAYS:
        return True, "max_age"
    if changed and age_d >= config.TRAILS_MIN_DAYS:
        return True, "changed"
    return False, "deferred_weekly" if changed else "unchanged"


def source_dates(sig: dict) -> dict:
    out = {}
    lm = (sig.get("usfs") or {}).get("last_modified")
    try:
        out["usfs"] = parsedate_to_datetime(lm).strftime("%Y-%m-%d") if lm else None
    except (TypeError, ValueError):
        out["usfs"] = None
    for k in ("blm_managed", "blm_not_assessed", "nps"):
        out[k] = _ms_date((sig.get(k) or {}).get("max_edit"))
    return out


def sanity(counts: dict, prev_counts: dict | None) -> list[str]:
    """Problems that keep the previous build live (empty = OK)."""
    problems = []
    for src, floor in config.TRAILS_COUNT_FLOORS.items():
        n = counts.get(src, 0)
        prev = (prev_counts or {}).get(src)
        need = floor
        if prev:
            need = max(floor, int(prev * (1 - config.TRAILS_MAX_DROP)))
        if n < need:
            problems.append(f"{src} count {n} < {need}"
                            + (f" (last build {prev}; partial refresh?)" if prev else ""))
    return problems


# ---------------------------------------------------------------------------
# fetch
# ---------------------------------------------------------------------------

def _esri_url(layer_url: str, fields: str, where: str = "1=1") -> str:
    # No resultOffset: GDAL's ESRIJSON driver then pages automatically
    # (orderByFields keeps pages stable).
    return (f"ESRIJSON:{layer_url}/query?where={quote(where)}&outFields={fields}"
            "&outSR=4326&orderByFields=OBJECTID&f=json")


def _count_lines(path: Path) -> int:
    with open(path, "rb") as f:
        return sum(1 for ln in f if ln.strip())


def fetch_usfs(client: httpx.Client, workdir: Path, log=print) -> Path:
    z = workdir / "usfs.gdb.zip"
    download_to(client, config.USFS_TRAILS_ZIP, z, timeout=900)
    out = workdir / "usfs.geojsonl"
    gdal_cli.run(["ogr2ogr", "-f", "GeoJSONSeq", str(out),
                  f"/vsizip/{z}/{config.USFS_TRAILS_LAYER}.gdb", config.USFS_TRAILS_LAYER,
                  "-where", "TRAIL_TYPE='TERRA'", "-select", USFS_SELECT,
                  "-t_srs", "EPSG:4326", "-nlt", "MULTILINESTRING",
                  "-lco", "COORDINATE_PRECISION=6"], timeout=1800)
    z.unlink(missing_ok=True)
    log(f"[trails] usfs: {_count_lines(out)} TERRA segments")
    return out


def fetch_arcgis(client: httpx.Client, name: str, layer_url: str, fields: str,
                 workdir: Path, where: str = "1=1", log=print) -> Path:
    """Pull one ArcGIS layer; the feature count must match returnCountOnly
    before and after (one retry), so a service mid-reload can't slip through."""
    out = workdir / f"{name}.geojsonl"
    for attempt in (1, 2):
        before = _arcgis_count(client, layer_url, where)
        out.unlink(missing_ok=True)
        gdal_cli.run(["ogr2ogr", "-f", "GeoJSONSeq", str(out), _esri_url(layer_url, fields, where),
                      "-nlt", "MULTILINESTRING", "-lco", "COORDINATE_PRECISION=6"],
                     timeout=1800, env={"GDAL_HTTP_MAX_RETRY": "4", "GDAL_HTTP_RETRY_DELAY": "5"})
        got = _count_lines(out)
        after = _arcgis_count(client, layer_url, where)
        if got == before == after:
            log(f"[trails] {name}: {got} features")
            return out
        log(f"[trails] {name}: count mismatch got={got} before={before} after={after} "
            f"(attempt {attempt})")
    raise RuntimeError(f"{name}: feature count never settled")


# ---------------------------------------------------------------------------
# normalize (streamed; geometry passes through untouched)
# ---------------------------------------------------------------------------

def _first_lon(geom: dict) -> float | None:
    c = geom.get("coordinates")
    while isinstance(c, list) and c and isinstance(c[0], list):
        c = c[0]
    return c[0] if isinstance(c, list) and c else None


def normalize_file(kind: str, src: Path, out_fh, *, src_date: str | None) -> dict:
    """Stream one source's GeoJSONSeq through its normalizer. -> counts."""
    kept = dropped_geom = dropped_rule = 0
    with open(src, encoding="utf-8") as f:
        for line in f:
            line = line.strip().lstrip("\x1e")
            if not line:
                continue
            feat = json.loads(line)
            geom = feat.get("geometry")
            if not geom or not geom.get("coordinates"):
                dropped_geom += 1
                continue
            lon = _first_lon(geom)
            if lon is None or lon > 0:  # Guam/CNMI; null-island junk
                dropped_rule += 1
                continue
            p = feat.get("properties") or {}
            if kind == "usfs":
                rec = tn.normalize_usfs(p, src_date or "")
            elif kind == "blm_managed":
                rec = tn.normalize_blm(p, "managed", src_date or "")
            elif kind == "blm_not_assessed":
                rec = tn.normalize_blm(p, "not_assessed", src_date or "")
            else:
                rec = tn.normalize_nps(p, src_date or "")
            if rec is None:
                dropped_rule += 1
                continue
            out_fh.write(json.dumps({"type": "Feature", "properties": rec, "geometry": geom},
                                    ensure_ascii=False, separators=(",", ":")) + "\n")
            kept += 1
    return {"kept": kept, "dropped_null_geometry": dropped_geom, "dropped_rules": dropped_rule}


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------

def build_outputs(norm: Path, workdir: Path, *, name: str, log=print,
                  minzoom: int = PMTILES_MINZOOM, maxzoom: int = PMTILES_MAXZOOM) -> dict:
    """norm.geojsonl -> trails.gpkg (trails_hi + trails_lo), trails.fgb,
    trails.pmtiles; returns paths + the PMTiles summary."""
    gpkg = workdir / "trails.gpkg"
    fgb = workdir / "trails.fgb"
    pmt = workdir / "trails.pmtiles"
    for p in (gpkg, fgb, pmt):
        p.unlink(missing_ok=True)
    gdal_cli.run(["ogr2ogr", "-f", "GPKG", str(gpkg), str(norm), "-nln", "trails_hi",
                  "-nlt", "MULTILINESTRING", "-lco", "SPATIAL_INDEX=YES"], timeout=1800)
    gdal_cli.run(["ogr2ogr", "-update", str(gpkg), str(gpkg), "-nln", "trails_lo",
                  "-sql", f"SELECT geom, {', '.join(tn.LO_FIELDS)} FROM trails_hi"], timeout=1800)
    gdal_cli.run(["ogr2ogr", "-f", "FlatGeobuf", str(fgb), str(gpkg), "trails_hi",
                  "-nln", "trails", "-lco", "SPATIAL_INDEX=YES"], timeout=1800)
    conf = workdir / "pmtiles_conf.json"
    split = min(maxzoom, 10)
    conf.write_text(json.dumps({
        "trails_lo": {"target_name": "trails", "minzoom": minzoom, "maxzoom": split},
        "trails_hi": {"target_name": "trails", "minzoom": split + 1, "maxzoom": maxzoom},
    }))
    w, s, e, n = PMTILES_SPAT
    proc = gdal_cli.run(
        ["ogr2ogr", "-f", "PMTiles", str(pmt), str(gpkg), "trails_lo", "trails_hi",
         "-spat", str(w), str(s), str(e), str(n),
         "-dsco", f"NAME={name}", "-dsco", "TYPE=overlay",
         "-dsco", f"MINZOOM={minzoom}", "-dsco", f"MAXZOOM={maxzoom}",
         "-dsco", f"CONF={conf}", "-dsco", "SIMPLIFICATION=1",
         "-dsco", "SIMPLIFICATION_MAX_ZOOM=0.5", "-dsco", "MAX_SIZE=500000",
         "-dsco", "MAX_FEATURES=200000"],
        timeout=3600, env={"CPL_DEBUG": "MVT", "GDAL_NUM_THREADS": "4"}, cwd=workdir)
    degraded = len(_DEGRADED.findall(proc.stderr or ""))
    summary = pmtiles_inspect.summarize(pmt)
    problems = pmtiles_inspect.check(summary, min_zoom=minzoom, max_zoom=maxzoom,
                                     layer="trails")
    log(f"[trails] pmtiles {summary['bytes'] / 1e6:.1f} MB, {summary['tiles']} tiles, "
        f"max tile {summary['max_tile_bytes']} B, degraded {degraded}")
    return {"gpkg": gpkg, "fgb": fgb, "pmtiles": pmt, "summary": summary,
            "problems": problems, "degraded_tiles": degraded}


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def s3_url(key: str) -> str | None:
    """Range reads from the S3 endpoint carry ETag/Last-Modified, which Chrome
    HTTP-caches; the native f005 URL's 206s are not cached (measured)."""
    ep = (os.environ.get("B2_S3_ENDPOINT") or "").strip().rstrip("/")
    bucket = os.environ.get("B2_BUCKET")
    if not ep or not bucket:
        return None
    if "://" not in ep:
        ep = f"https://{ep}"
    return f"{ep}/{bucket}/{key}"


def pointer_doc(build_id: str, built_at: str, out: dict, counts: dict, dates: dict) -> dict:
    h = out["summary"]["header"]
    pm_key = f"trails/b{build_id}/trails.pmtiles"
    return {
        "schema": "rd-trails/1",
        "build_id": build_id,
        "built_at": built_at,
        "pmtiles": f"/{pm_key}",
        "pmtiles_url_s3": s3_url(pm_key),
        "pmtiles_bytes": out["summary"]["bytes"],
        "fgb": f"/trails/b{build_id}/trails.fgb",
        "fgb_bytes": out["fgb"].stat().st_size,
        "layer": "trails",
        "minzoom": h["min_zoom"],
        "maxzoom": h["max_zoom"],
        "bounds": h["bounds"],
        "counts": counts,
        "source_dates": dates,
        "degraded_tiles": out["degraded_tiles"],
        "attribution": "Trails: USFS · BLM · NPS",
    }


def publish(storage: Storage, build_id: str, pointer: dict, build: dict, out: dict,
            state: dict, log=print) -> None:
    prefix = f"trails/b{build_id}"
    storage.put_file(f"{prefix}/trails.pmtiles", out["pmtiles"])
    storage.put_file(f"{prefix}/trails.fgb", out["fgb"])
    storage.put_json(f"{prefix}/build.json", build)
    storage.put_json(POINTER_KEY, pointer)  # LAST public write
    storage.put_json(STATE_KEY, state)
    log(f"[trails] published {prefix}")


# ---------------------------------------------------------------------------
# job
# ---------------------------------------------------------------------------

def sync(client: httpx.Client, storage: Storage, *, workdir: Path, force: bool = False,
         log=print, deadline_passed=lambda: False, now: datetime | None = None,
         fetchers: dict | None = None, sig: dict | None = None) -> dict:
    """One sync-trails run. Returns the health entry it published.

    `fetchers` / `sig` let tests inject local sources (name -> callable
    returning a GeoJSONSeq path) and a probe result."""
    now = now or _now()
    started = _iso(now)
    prev = storage.get_json(STATE_KEY) or {}
    entry = {"started_at": started, "ok": True, "built": False}
    try:
        sig = sig if sig is not None else probe(client)
    except Exception as exc:  # noqa: BLE001
        entry.update(ok=False, note=f"probe failed: {str(exc)[:200]}", finished_at=_iso(_now()))
        health_docs.publish(storage, "trails", entry, log=log)
        return entry
    build, reason = decide(sig, prev, now, force)
    entry["reason"] = reason
    if not build:
        log(f"[trails] {reason} — nothing to build")
        entry.update(note=reason, finished_at=_iso(_now()))
        health_docs.publish(storage, "trails", entry, log=log)
        return entry

    build_id = build_id_for(sig, now)
    if storage.exists(f"trails/b{build_id}/build.json") and prev.get("build_id") == build_id:
        log(f"[trails] build {build_id} already published")
        entry.update(note="already_published", finished_at=_iso(_now()))
        health_docs.publish(storage, "trails", entry, log=log)
        return entry

    missing = gdal_cli.missing(["ogr2ogr", "ogrinfo"])
    drivers = gdal_cli.drivers("vector")
    need = {"PMTiles", "FlatGeobuf", "GPKG", "OpenFileGDB", "ESRIJSON", "GeoJSONSeq"}
    if missing or not need <= drivers:
        note = f"GDAL unavailable (missing: {', '.join(missing or sorted(need - drivers))})"
        log(f"[trails] {note}")
        entry.update(ok=False, note=note, finished_at=_iso(_now()))
        health_docs.publish(storage, "trails", entry, log=log)
        return entry

    workdir.mkdir(parents=True, exist_ok=True)
    dates = source_dates(sig)
    fetchers = fetchers or {
        "usfs": lambda: fetch_usfs(client, workdir, log),
        "blm_managed": lambda: fetch_arcgis(client, "blm_managed", config.BLM_MANAGED_TRAILS,
                                            BLM_FIELDS, workdir, log=log),
        "blm_not_assessed": lambda: fetch_arcgis(client, "blm_not_assessed",
                                                 config.BLM_NOT_ASSESSED_TRAILS, "*",
                                                 workdir, log=log),
        "nps": lambda: fetch_arcgis(client, "nps", config.NPS_TRAILS, NPS_FIELDS, workdir,
                                    where=NPS_WHERE, log=log),
    }
    try:
        norm = workdir / "norm.geojsonl"
        counts, norm_stats = {}, {}
        with open(norm, "w", encoding="utf-8") as fh:
            for src in SOURCES:
                if deadline_passed():
                    raise RuntimeError("deadline passed while fetching")
                path = fetchers[src]()
                st = normalize_file(src, path, fh, src_date=dates.get(src))
                counts[src], norm_stats[src] = st["kept"], st
                path.unlink(missing_ok=True)
                log(f"[trails] {src}: kept {st['kept']}, dropped "
                    f"{st['dropped_null_geometry']} null-geometry + {st['dropped_rules']} by rule")
        problems = sanity(counts, prev.get("counts"))
        if problems:
            raise RuntimeError("sanity: " + "; ".join(problems))
        out = build_outputs(norm, workdir, name=f"Responder Debrief trails {build_id}", log=log)
        if out["problems"]:
            raise RuntimeError("pmtiles check: " + "; ".join(out["problems"]))
        built_at = _iso(_now())
        pointer = pointer_doc(build_id, built_at, out, counts, dates)
        build_doc = dict(pointer, signature=sig, normalize=norm_stats,
                         gdal_version=gdal_cli.version(),
                         sha256={"pmtiles": _sha256(out["pmtiles"]), "fgb": _sha256(out["fgb"])},
                         tiles={"by_zoom": out["summary"]["by_zoom"],
                                "max_tile_bytes": out["summary"]["max_tile_bytes"]})
        state = {"schema": 1, "build_id": build_id, "built_at": built_at, "signature": sig,
                 "counts": counts}
        publish(storage, build_id, pointer, build_doc, out, state, log=log)
        entry.update(built=True, build_id=build_id, counts=counts,
                     pmtiles_bytes=pointer["pmtiles_bytes"], fgb_bytes=pointer["fgb_bytes"],
                     degraded_tiles=out["degraded_tiles"],
                     max_tile_bytes=out["summary"]["max_tile_bytes"],
                     gdal_version=build_doc["gdal_version"],
                     note=f"built {build_id}" + (f"; {out['degraded_tiles']} tiles degraded by "
                                                 "GDAL MAX_SIZE" if out["degraded_tiles"] else ""))
    except Exception as exc:  # noqa: BLE001 — the previous build stays live
        log(f"[trails] FAILED: {exc}")
        entry.update(ok=False, note=str(exc)[:300])
    finally:
        shutil.rmtree(workdir / "_scratch", ignore_errors=True)
    entry["finished_at"] = _iso(_now())
    health_docs.publish(storage, "trails", entry, log=log)
    return entry
