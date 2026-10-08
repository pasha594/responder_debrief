"""Incident manifests and catalog rows keyed by fire ID.

Each active fire fed by incident folders gets one manifest,
catalogs/incidents/id/{fire_key}.json, holding exactly the files it owns
(incident_ids.file_owner) from every folder feeding it, and one
state["incident_fires"] entry naming it; its catalog row points at that
path and nowhere else, so a fire is never handed a same-name fire's maps.

Every key comes from asset_keys: a raw file can sit under another prefix
(files[rel].prefix), a sheet's tiles and preview under the prefixes they
were first written to, and an IR flight's vectors under the key stamped for
its source file (ir_keys). Nothing here builds a key from a fire's slug.

sync-incidents and the incident-ID migration build manifests with the same
code, so the first mirror run after the migration reproduces its manifests.
The migration replays only (no tiling, previews, conversions or downloads);
the mirror passes its downloads in `mirrors` and converts IR flights owed a
conversion.
"""

from __future__ import annotations

import re
import shutil
import tempfile
from pathlib import Path

from . import catalogs as cat, config, frames, geopdf, hotspots, ir_vectors
from . import state as state_mod
from .asset_keys import (
    fetch_verified,
    ir_entry,
    new_ir_key,
    preview_key,
    preview_prefix,
    put_tiled,
    raw_key,
    record_prefix,
    replay_file,
    stamp_ir,
    tiles_prefix,
)
from .fires import fire_key
from .incident_ids import (
    choose_ir_source,
    contributors,
    file_owner,
    name_norm,
    names_fire,
    prior_owner,
)
from .matching import normalize_name

#: binding strength when ordering the folders that feed one fire
METHOD_RANK = {"override": 0, "unit_id": 1, "name_exact": 2, "name_fuzzy": 3}


def manifest_key(fk: str) -> str:
    return f"catalogs/incidents/id/{fk}.json"


def active_fire_names(fires_by_fk: dict) -> set[str]:
    """name_norm of every active fire whose name is long enough to be
    evidence (the mixed-IR-folder check)."""
    return {n for f in fires_by_fk.values()
            if (n := name_norm(f.get("post_title") or f.get("name")))}


def primary_rank(state: dict, fk: str):
    """Sort key over the folders feeding `fk`: folders bound to the fire
    first, then the stronger binding, then the folder holding more of the
    fire's files, then the key. The first is the manifest's primary."""
    def key(inc_key: str) -> tuple:
        rec = state["incidents"][inc_key]
        own = sum(1 for meta in (rec.get("files") or {}).values()
                  if file_owner(rec, meta) == fk)
        method = (rec.get("match") or {}).get("method")
        return (prior_owner(rec) != fk, METHOD_RANK.get(method, len(METHOD_RANK)),
                -own, inc_key)
    return key


def stem_name(title: str | None) -> str:
    """A fire name as the slug-keyed IR code compared it to file-name
    tokens: normalized, spaces dropped, any length."""
    return normalize_name(title or "").replace(" ", "")


def flight_stem_id(filename: str, fire_name: str, *suffixes: str) -> str:
    """A flight's id from a file name: the stem less a suffix and less any
    token spelling the fire's name (stem_name), as the slug-keyed manifests
    built it: '20260817_Austin_IR_11x17_Topo.pdf' on Austin is
    '20260817_IR_11x17_Topo'."""
    stem = filename.rsplit(".", 1)[0]
    for suf in suffixes:
        if stem.endswith(suf):
            stem = stem[: -len(suf)]
    return "_".join(t for t in stem.split("_")
                    if normalize_name(t).replace(" ", "") != fire_name)


def flight_id_of(zips: list[str], pdfs: list[str], kmzs: list[str], fire_name: str) -> str | None:
    """flight_stem_id of the folder's first shapefiles zip, else PDF, else
    KMZ (file names)."""
    if zips:
        return flight_stem_id(zips[0], fire_name, "_Shapefiles")
    if pdfs or kmzs:
        return flight_stem_id((pdfs or kmzs)[0], fire_name, "_All")
    return None


def stale_index_fks(state: dict, fires_by_fk: dict) -> set[str]:
    """Active fires fed by folders whose index entry is missing, older than
    INCIDENT_MANIFEST_V (reassign-files sets v=0), or lists other folders
    than the ones feeding the fire now."""
    idx = state.get("incident_fires") or {}
    out: set[str] = set()
    for fk, keys in contributors(state).items():
        if fk not in fires_by_fk:
            continue
        e = idx.get(fk)
        if (not e or (e.get("v") or 0) < cat.INCIDENT_MANIFEST_V
                or sorted(e.get("dirs") or ()) != sorted(keys)):
            out.add(fk)
    return out


# ---------------------------------------------------------------------------
# manifests
# ---------------------------------------------------------------------------

def _dir_url(rec: dict) -> str | None:
    return rec.get("dir_url") or (rec.get("match") or {}).get("dir_url")


def _region(rec: dict) -> str:
    if rec.get("region"):
        return rec["region"]
    parts = (_dir_url(rec) or "").split("/incident_specific_maps/", 1)
    return parts[1].split("/", 1)[0] if len(parts) == 2 else ""


def unit_incident(token: str | None) -> str | None:
    """'2026-ORMHF-000863' -> 'ORMHF000863' (any year)."""
    return re.sub(r"^\d{4}-", "", token).replace("-", "") if token else None


def _source(rec: dict, fk: str) -> dict:
    """One folder feeding a fire. Its binding's method and unit id belong to
    the fire it is bound to, so a folder that only lends stamped files
    names neither."""
    m = rec.get("match") or {}
    bound = prior_owner(rec) == fk
    return {"dir_url": _dir_url(rec), "region": _region(rec),
            "unit_incident": unit_incident(m.get("token")) if bound else None,
            "method": m.get("method") if bound else None}


def _record_files(rec: dict, bundle: dict | None) -> list[tuple]:
    """(rel, meta, MirroredFile) for every file of the record: this run's
    downloads (with local copies) first, then the rest replayed from state."""
    files = rec.get("files") or {}
    out, seen = [], set()
    for mf in (bundle["result"].files if bundle else ()):
        rel = f"{mf.rel_dir}/{mf.filename}"
        if rel in files and rel not in seen:
            out.append((rel, files[rel], mf))
            seen.add(rel)
    out += [(rel, meta, replay_file(rec, rel, meta))
            for rel, meta in files.items() if rel not in seen]
    return out


def _map_entry(state: dict, rec: dict, rel: str, mf) -> dict:
    sha = mf.sha16
    geo: dict = {"georeferenced": False, "preview": False}
    pending = False
    t = (state.get("tiled") or {}).get(sha) if sha else None
    if t:
        # tiler_version None = probed georeferenced, tiles still owed
        geo = t.get("geo", geo)
        pending = t.get("tiler_version") is None and bool(geo.get("georeferenced"))
    # a file with no sha has no geo, so these prefixes are never used
    tp = tiles_prefix(state, sha, rec) if sha else record_prefix(rec)
    pp = preview_prefix(state, sha, rec) if sha else record_prefix(rec)
    return cat.map_entry(
        parsed=cat.parse_product_filename(mf.filename), kind=mf.kind,
        sha_id=sha or "unknown", tiles_prefix=tp, preview_prefix=pp,
        pdf_key=raw_key(rec, rel), size_bytes=mf.size, geo=geo, rev=mf.rev,
        tiling_pending=pending, uploaded_lm=mf.lm, first_seen=mf.first_seen)


def _flight_rank(f: dict) -> tuple:
    # prefer the copy that actually converted, then the richer one
    return (f.get("geojson_url") is not None,
            sum(f.get(u) is not None for u in ("pdf_url", "kmz_url")))


def publish_fire_manifests(args, storage, state: dict, fires_by_fk: dict, rebuild,
                           mirrors: dict, *, replay_only: bool = False,
                           stats: dict | None = None, log=print) -> dict[str, dict]:
    """Rebuild and PUT the ID manifest of every active fire in `rebuild`,
    then record its state["incident_fires"] entry, and return {fk: manifest}.

    A fire no folder feeds any more loses its index entry (its manifest
    stays on the bucket, unreferenced). A PUT that raises propagates before
    that fire's entry is written, so the index never names a manifest that
    was not uploaded. `mirrors` holds this run's mirror bundles (files with
    local copies); every other file replays from state. `stats` collects
    ir_mixed_hidden and raw_sha_mismatch for health and reports.
    """
    stats = stats if stats is not None else {}
    contrib = contributors(state)
    idx = state.setdefault("incident_fires", {})
    names = active_fire_names(fires_by_fk)
    out: dict[str, dict] = {}
    for fk in sorted(set(rebuild) & fires_by_fk.keys()):
        keys = contrib.get(fk)
        if not keys:
            idx.pop(fk, None)
            continue
        fire = fires_by_fk[fk]
        recs = sorted(keys, key=primary_rank(state, fk))
        maps: dict[str, dict] = {}
        flights: dict[str, dict] = {}
        for inc_key in recs:
            rec = state["incidents"][inc_key]
            files = _record_files(rec, mirrors.get(inc_key))
            by_rel = {rel: mf for rel, _meta, mf in files}
            # the same sheet is often published twice (Current Maps and a
            # daily folder) and in two folders: list it once, first holder wins
            for rel, meta, mf in files:
                if (mf.kind == "ir" or file_owner(rec, meta) != fk
                        or not mf.filename.lower().endswith(".pdf")):
                    continue
                k = mf.sha16 or f"{inc_key}:{rel}"
                if k not in maps:
                    maps[k] = _map_entry(state, rec, rel, mf)
            groups: dict[str, list] = {}
            for rel, meta in (rec.get("files") or {}).items():  # state order
                mf = by_rel[rel]
                if mf.kind == "ir" and file_owner(rec, meta) == fk:
                    groups.setdefault(mf.rel_dir, []).append((rel, mf))
            for rel_dir, group in sorted(groups.items(), reverse=True):
                f = ir_flight(args, storage, state, fire, rec, inc_key, rel_dir, group,
                              replay_only=replay_only, fire_names=names, stats=stats, log=log)
                k = f.get("flight_id") or f.get("flight_date") or repr(f)
                if k not in flights or _flight_rank(f) > _flight_rank(flights[k]):
                    flights[k] = f
        merged_maps = list(maps.values())
        merged_ir = sorted(flights.values(), key=lambda f: f.get("flight_date") or "",
                           reverse=True)
        primary = state["incidents"][recs[0]]
        pm = primary.get("match") or {}
        manifest = cat.build_incident_manifest(
            fire=fire, region=_region(primary), source_dir=_dir_url(primary),
            unit_incident=(unit_incident(pm.get("token"))
                           if prior_owner(primary) == fk else None),
            maps=merged_maps, ir_flights=merged_ir,
            sources=[_source(state["incidents"][k], fk) for k in recs])
        path = manifest_key(fk)
        storage.put_json(path, manifest)
        log(f"[incidents] manifest written: {path} ({fire.get('fire_slug')}: "
            f"maps={len(merged_maps)}, ir_flights={len(merged_ir)}, dirs={len(recs)})")

        upload_dates = [m["op_date"] for m in merged_maps if cat.valid_day(m.get("op_date"))]
        upload_dates += [f["flight_date"] for f in merged_ir if cat.valid_day(f.get("flight_date"))]
        upload_ts = [m["uploaded_at"] for m in merged_maps if m.get("uploaded_at")]
        synced = [s for k in recs if (s := state["incidents"][k].get("synced_at"))]
        idx[fk] = {
            "v": cat.INCIDENT_MANIFEST_V,
            "cornea_id": fire.get("cornea_id"),
            "manifest": path,
            "dirs": sorted(keys),
            "primary": recs[0],
            "method": pm.get("method"),
            "confidence": pm.get("confidence"),
            "dir_url": _dir_url(primary),
            "synced_at": max(synced) if synced else None,
            "built_at": cat.now_iso(),
            "counts": {"maps": len(merged_maps), "ir": len(merged_ir),
                       "latest_upload": max(upload_dates) if upload_dates else None,
                       "latest_upload_ts": max(upload_ts) if upload_ts else None},
        }
        out[fk] = manifest
    for fk in [k for k in idx if k not in contrib]:
        idx.pop(fk)
    return out


# ---------------------------------------------------------------------------
# IR flights
# ---------------------------------------------------------------------------

def _stem(filename: str) -> str:
    return filename.rsplit(".", 1)[0]


def ir_flight(args, storage, state: dict, owner_fire: dict, rec: dict, inc_key: str,
              rel_dir: str, files: list[tuple], *, replay_only: bool, fire_names,
              stats: dict | None = None, log=print) -> dict:
    """One IR flight of `owner_fire` from the files it owns in one flight
    folder of one record (`files`: [(rel, MirroredFile)] in state order).

    The source is incident_ids.choose_ir_source: files naming the owner
    first, and none at all in a folder flown for several fires when nothing
    names the owner. Vectors come from the conversion stamped for that very
    source file (ir_keys); otherwise, unless replaying, the source is
    converted into a new content-addressed key, from bytes that hash to the
    source's sha.
    """
    stats = stats if stats is not None else {}
    owner_fk = fire_key(owner_fire.get("cornea_id"))
    title = owner_fire.get("post_title") or owner_fire.get("name")
    owner_name = name_norm(title)
    ordered = sorted(files, key=lambda f: not names_fire(_stem(f[1].filename), owner_name))
    zips = [f for f in ordered if f[1].filename.lower().endswith("shapefiles.zip")]
    pdfs = [f for f in ordered if f[1].filename.lower().endswith(".pdf")]
    kmzs = [f for f in ordered if f[1].filename.lower().endswith(".kmz")]
    readmes = [f for f in ordered if "read_me" in f[1].filename.lower()]

    src_rel, mixed = choose_ir_source(rec, rel_dir, owner_fk, owner_name, fire_names)
    if mixed:
        stats.setdefault("ir_mixed_hidden", []).append(
            {"key": inc_key, "rel_dir": rel_dir, "owner": owner_fk})
    src_meta = ((rec.get("files") or {}).get(src_rel) or {}) if src_rel else {}
    entry = ir_entry(rec, src_rel, src_meta) if src_rel else None
    flight_id = (entry["flight_id"] if entry else
                 flight_id_of([f[1].filename for f in zips], [f[1].filename for f in pdfs],
                              [f[1].filename for f in kmzs], stem_name(title)))

    ir_state = state.setdefault("ir", {})
    vkey, conv = None, {}
    stamped = ir_state.get(entry["key"]) if entry else None
    if stamped is not None and (
            replay_only or stamped.get("v") == ir_vectors.IR_CONVERTER_VERSION):
        vkey, conv = entry["key"], stamped
    elif not replay_only and src_rel and src_meta.get("sha16"):
        nkey = new_ir_key(rec, src_meta)
        cached = ir_state.get(nkey)
        if cached is not None and cached.get("v") == ir_vectors.IR_CONVERTER_VERSION:
            vkey, conv = nkey, cached
            stamp_ir(rec, src_rel, nkey, flight_id, src_meta["sha16"])
        elif frames.deadline_passed() or shutil.which("ogr2ogr") is None:
            # no conversion this run: the same source's older conversion
            # keeps serving until a later run redoes it
            if stamped is not None:
                vkey, conv = entry["key"], stamped
        else:
            src = next((f for f in ordered if f[0] == src_rel), None) or (
                src_rel, replay_file(rec, src_rel, src_meta))
            conv = _convert(storage, rec, src, kmzs[0] if kmzs else None, nkey, flight_id,
                            stats, log)
            ir_state[nkey] = conv
            stamp_ir(rec, src_rel, nkey, flight_id, src_meta["sha16"])
            vkey = nkey
    heat_types: list[str] = conv.get("heat_types") or []

    est_acres = None
    readme = readmes[0][1] if readmes else None
    if readme and readme.local_path and readme.local_path.exists():
        est_acres = ir_vectors.parse_estimated_acres(readme.local_path.read_text(errors="replace"))
    day = rel_dir.split("/")[-1]
    return {
        "flight_date": f"{day[:4]}-{day[4:6]}-{day[6:]}" if len(day) == 8 and day.isdigit() else None,
        # when the plane flew, per the KMZ (the UI falls back to flight_date)
        "flown_at": conv.get("flown_at"),
        "flown_date": conv.get("flown_date"),
        "flight_id": flight_id,
        "no_flight_reason": None,
        "geojson_url": f"/{vkey}" if heat_types else None,
        "heat_types": heat_types,
        "estimated_acres": est_acres,
        "pdf_url": f"/{raw_key(rec, pdfs[0][0])}" if pdfs else None,
        "preview_url": (ir_preview_url(storage, state, rec, pdfs[0][1], replay_only=replay_only,
                                       log=log) if pdfs else None),
        "kmz_url": f"/{raw_key(rec, kmzs[0][0])}" if kmzs else None,
        "readme_url": f"/{raw_key(rec, readmes[0][0])}" if readmes else None,
    }


def _convert(storage, rec: dict, src: tuple, kmz: tuple | None, key: str, flight_id: str,
             stats: dict, log) -> dict:
    """Convert one flight's source into `key` (a key never written before);
    the state["ir"] entry: heat_types | failed, flown_*, v."""
    conv: dict = {"v": ir_vectors.IR_CONVERTER_VERSION}
    try:
        with tempfile.TemporaryDirectory(prefix="irconv_") as td:
            tdp = Path(td)

            def local(f: tuple) -> Path:
                rel, mf = f
                if mf.local_path is not None:
                    return mf.local_path  # hashed by the mirror as it landed
                dest = tdp / Path(mf.filename).name
                if fetch_verified(storage, [raw_key(rec, rel)], mf.sha16, dest, log,
                                  mismatches=stats.setdefault("raw_sha_mismatch", [])) is None:
                    raise RuntimeError(f"no copy of {raw_key(rec, rel)} matches its sha")
                return dest

            # the flight time lives in the KMZ, even when shapefiles convert
            kmz_local = None
            if kmz:
                try:
                    kmz_local = local(kmz)
                    conv.update(ir_vectors.kmz_flight_time(kmz_local))
                except RuntimeError:
                    if src[0] == kmz[0]:
                        raise
            gj = tdp / "flight.geojson"
            if src[1].filename.lower().endswith("shapefiles.zip"):
                info = ir_vectors.process_ir_zip(local(src), gj, flight_id=flight_id)
            else:
                info = ir_vectors.process_ir_kmz(
                    kmz_local if kmz and src[0] == kmz[0] else local(src), gj,
                    flight_id=flight_id)
            storage.put_file(key, gj)
            conv["heat_types"] = info["heat_types"]
            log(f"[ir] {flight_id}: {info['feature_count']} features "
                f"({', '.join(info['heat_types'])})")
    except Exception as exc:
        conv["failed"] = True
        log(f"[ir] vectorization failed for {src[0]}: {exc}")
    return conv


def ir_preview_url(storage, state: dict, rec: dict, pdf, *, replay_only: bool,
                   log=print) -> str | None:
    """Card thumbnail for an IR flight: its PDF's first page, keyed like a
    map sheet's preview (preview_key). A PDF downloaded this run is
    rendered here; a replayed one waits for the probe backlog. IR PDFs are
    never tiled, so a new record is marked done for the tiler."""
    sha = pdf.sha16
    if not sha:
        return None
    t = state["tiled"].get(sha)
    key = preview_key(state, sha, rec)
    if t and (t.get("geo") or {}).get("preview"):
        return f"/{key}"
    if replay_only or t is not None or pdf.local_path is None or not geopdf.gdal_available():
        return None  # tried before, not here yet, or no GDAL this run
    ok = False
    try:
        with tempfile.TemporaryDirectory(prefix="irprev_") as td:
            png = Path(td) / "preview.png"
            geopdf.render_preview(pdf.local_path, png)
            storage.put_file(key, png)
            ok = True
    except Exception as exc:
        log(f"[ir] preview failed for {pdf.filename}: {exc}")
    now = state_mod.now_iso()
    put_tiled(state, sha, record_prefix(rec), {
        "tiler_version": config.TILER_VERSION,
        "at": now, "repair_at": now, "grat_at": now,
        "geo": {"georeferenced": False, "projection": None, "tiles": None, "preview": ok},
    })
    return f"/{key}" if ok else None


# ---------------------------------------------------------------------------
# catalog
# ---------------------------------------------------------------------------

def publish_catalog(storage, state: dict, fires: list[dict], *, log=print) -> dict:
    """catalog.json from the fire-ID index (migrated state only), keeping
    the forecast fields sync-catalogs owns from the published catalog.
    Upload order: state, then versions/catalog.{N}.json, then catalog.json."""
    incident_fires = cat.catalog_incident_index(state)
    if incident_fires is None:
        raise RuntimeError("publish_catalog needs state migrated to fire IDs")
    prev = storage.get_json("catalogs/catalog.json") or {}
    spread_index = {
        fire_key(f.get("cornea_id")): {"latest": f["spread_latest_run"],
                                       "count": f.get("spread_run_count")}
        for f in prev.get("fires", [])
        if f.get("has_spread_forecast") and f.get("spread_latest_run")
    }
    perimeter_counts = {fk: rec["count"]
                        for fk, rec in cat.migrate_perim_counts(state, fires).items()
                        if rec.get("count") is not None}
    version = int(state.get("catalog_version", 0)) + 1
    catalog = cat.build_catalog(fires, version=version, incident_fires=incident_fires,
                                spread_index=spread_index, perimeter_counts=perimeter_counts,
                                hotspot_archives=hotspots.advertised(state),
                                national_layers=prev.get("national_layers"))
    state["catalog_version"] = version
    state_mod.save_state(storage, state)
    storage.put_json(f"catalogs/versions/catalog.{version}.json", catalog)
    storage.put_json("catalogs/catalog.json", catalog)
    log(f"[catalogs] catalog_version={version}: "
        f"{sum(1 for f in catalog['fires'] if f['has_incident_maps'])} fires with incident maps")
    return catalog
