"""Build and publish one fire's offline routing bundle.

    routing/{fire_key}/b{bundle_id}/grid.tif        pace code + veg class (Byte x2)
                                     dem.tif         Int16 metres
                                     graph.bin.gz    RDG1 road + trail network
                                     trails.pmtiles  per-fire trails + OSM ways, z10-14
                                     bundle.json     descriptor (written after the four)
    catalogs/routing/fires/{fire_key}.json          pointer, written LAST

bundle_id = sha256(inputs)[:12], where the inputs are the grid, the recipe,
and content hashes of what the AOI actually contains (OSM ways, agency
trails, NHD HU8 list) plus a monthly LANDFIRE epoch (LF2025 rolls out by
GeoArea). A "check" run that finds the same id skips the expensive part
(LANDFIRE, warps, PMTiles) and only stamps the state doc.

The descriptor lists only files that exist; a missing optional input
becomes a `warnings` entry the app shows (nhd_unavailable,
trails_unavailable, ...), never a silent hole.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import httpx
import numpy as np

from . import config, cost_grid, gdal_cli, graph_build, landfire, nhd, osm_extract, utm
from . import pmtiles_inspect
from .b2 import Storage
from .routing_plan import grid_bounds

GRAPH_FORMAT = "RDG1"
FIRE_TRAILS_MINZOOM, FIRE_TRAILS_MAXZOOM = 10, 14
WAY_CLASS = {graph_build.KIND_PAVED: 1, graph_build.KIND_UNPAVED: 2, graph_build.KIND_TRACK: 3,
             graph_build.KIND_PATH: 4, graph_build.KIND_STEPS: 5}
ATTRIBUTION = ["© OpenStreetMap contributors (ODbL 1.0)", "USFS", "BLM", "NPS", "LANDFIRE",
               "USGS NHD"]
LICENSE = ("graph.bin.gz and the 'ways' layer of trails.pmtiles are Derivative Databases of "
           "OpenStreetMap, available under the Open Database License 1.0.")


def canonical(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def bundle_id_for(inputs: dict) -> str:
    return hashlib.sha256(canonical(inputs).encode()).hexdigest()[:12]


def pointer_key(fk: str) -> str:
    return f"catalogs/routing/fires/{fk}.json"


def state_key(fk: str) -> str:
    return f"state/routing/fires/{fk}.json"


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# inputs
# ---------------------------------------------------------------------------

def load_agency_trails(src: str | None, bbox4326, workdir: Path) -> list[tuple[dict, list]]:
    """Agency trails intersecting the AOI, lon/lat: [(props, [(lon, lat)...])].
    `src` is the national trails.fgb (a /vsicurl/ URL in CI — the FGB spatial
    index means only the AOI's byte ranges are read) or a local file."""
    if not src:
        return []
    out = workdir / "aoi_trails.geojsonl"
    out.unlink(missing_ok=True)
    w, s, e, n = bbox4326
    gdal_cli.run(["ogr2ogr", "-f", "GeoJSONSeq", str(out), src, "-spat", str(w), str(s),
                  str(e), str(n), "-spat_srs", "EPSG:4326", "-t_srs", "EPSG:4326",
                  "-lco", "COORDINATE_PRECISION=7"], timeout=900,
                 env={"CPL_VSIL_CURL_CHUNK_SIZE": "1048576", "GDAL_HTTP_MAX_RETRY": "4",
                      "GDAL_HTTP_RETRY_DELAY": "3", "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR"})
    feats = []
    with open(out, encoding="utf-8") as f:
        for line in f:
            line = line.strip().lstrip("\x1e")
            if not line:
                continue
            ft = json.loads(line)
            g = ft.get("geometry") or {}
            lines = g.get("coordinates") or []
            if g.get("type") == "LineString":
                lines = [lines]
            for ln in lines:
                if len(ln) >= 2:
                    feats.append((ft.get("properties") or {}, [(float(x), float(y)) for x, y, *_ in ln]))
    return feats


def project_trails(feats, *, zone, northern, rect) -> list[tuple[dict, list]]:
    out = []
    for props, ln in feats:
        a = np.asarray(ln)
        xs, ys = utm.fwd(a[:, 0], a[:, 1], zone, northern)
        for run in graph_build.clip_line(list(zip(np.atleast_1d(xs), np.atleast_1d(ys))), rect):
            out.append((props, run))
    return out


def bbox_5070(aoi: dict) -> tuple[float, float, float, float]:
    """Densified UTM grid outline -> EPSG:5070 box, snapped to LANDFIRE's grid."""
    x0, y0, x1, y1 = grid_bounds(aoi["grid"])
    ts = np.linspace(0, 1, 17)
    pts = ([(x0 + (x1 - x0) * t, y0) for t in ts] + [(x1, y0 + (y1 - y0) * t) for t in ts]
           + [(x0 + (x1 - x0) * t, y1) for t in ts] + [(x0, y0 + (y1 - y0) * t) for t in ts])
    pp = gdal_cli.transform_points(pts, aoi["epsg"], 5070)
    xs = [p[0] for p in pp]
    ys = [p[1] for p in pp]
    return landfire.snap_5070((min(xs), min(ys), max(xs), max(ys)))


def warp(src: Path, dst: Path, aoi: dict, *, categorical: bool, ot: str) -> np.ndarray:
    g = aoi["grid"]
    xmin, ymin, xmax, ymax = grid_bounds(g)
    cell = g["cell_m"]
    if categorical:
        r = "near" if cell <= 30 else "mode"
    else:
        r = "bilinear" if cell <= 30 else "average"
    gdal_cli.run(["gdalwarp", "-q", "-overwrite", "-t_srs", f"EPSG:{aoi['epsg']}",
                  "-te", str(xmin), str(ymin), str(xmax), str(ymax), "-tr", str(cell), str(cell),
                  "-r", r, "-ot", ot, "-dstnodata", "-9999", str(src), str(dst)], timeout=600)
    arr, geo, _ = gdal_cli.read_raster(dst, dst.parent / "envi")
    if (geo.width, geo.height) != (g["width"], g["height"]):
        raise RuntimeError(f"warp size {geo.width}x{geo.height} != grid")
    return arr[0]


def _lf_incomplete(paths25: dict) -> bool:
    for p in paths25.values():
        arr, _, _ = gdal_cli.read_raster(p, p.parent / "envi_chk")
        if not cost_grid.valid_lf(arr).all():
            return True
    return False


# ---------------------------------------------------------------------------
# per-fire trails PMTiles (agency trails + OSM ways, lon/lat)
# ---------------------------------------------------------------------------

def write_fire_trails(g: graph_build.Graph, agency_ll, aoi: dict, workdir: Path,
                      name: str) -> Path | None:
    zone, northern = aoi["zone"], aoi["northern"]
    # FeatureCollections, so src_date stays a string (gdal_cli.GEOJSON_AS_WRITTEN)
    trails_fc = workdir / "fire_trails.geojson"
    ways_fc = workdir / "fire_ways.geojson"
    with gdal_cli.FeatureCollectionWriter(trails_fc) as f:
        for props, ln in agency_ll:
            f.write({"type": "Feature", "properties": props,
                     "geometry": {"type": "LineString", "coordinates": ln}})
        n_tr = f.count
    with gdal_cli.FeatureCollectionWriter(ways_fc) as f:
        for e in g.edges:
            if e.src != graph_build.SRC_OSM:
                continue
            a = np.asarray(e.xy)
            lon, lat = utm.inv(a[:, 0], a[:, 1], zone, northern)
            coords = [[round(x, 7), round(y, 7)] for x, y in zip(np.atleast_1d(lon), np.atleast_1d(lat))]
            f.write({"type": "Feature",
                     "properties": {"cls": WAY_CLASS.get(e.kind, 4), "name": e.name, "ref": e.ref},
                     "geometry": {"type": "LineString", "coordinates": coords}})
        n_w = f.count
    if not n_tr and not n_w:
        return None
    gpkg = workdir / "fire_disp.gpkg"
    gpkg.unlink(missing_ok=True)
    layers = []
    for fc, lname, n in ((trails_fc, "trails", n_tr), (ways_fc, "ways", n_w)):
        if not n:
            continue
        cmd = ["ogr2ogr", "-f", "GPKG", str(gpkg), *gdal_cli.GEOJSON_AS_WRITTEN, str(fc),
               "-nln", lname, "-nlt", "MULTILINESTRING"]
        if gpkg.exists():
            cmd[1:1] = ["-update"]
        gdal_cli.run(cmd, timeout=600)
        layers.append(lname)
    pmt = workdir / "trails.pmtiles"
    pmt.unlink(missing_ok=True)
    gdal_cli.run(["ogr2ogr", "-f", "PMTiles", str(pmt), str(gpkg), *layers,
                  "-dsco", f"NAME={name}", "-dsco", "TYPE=overlay",
                  "-dsco", f"MINZOOM={FIRE_TRAILS_MINZOOM}", "-dsco", f"MAXZOOM={FIRE_TRAILS_MAXZOOM}",
                  "-dsco", "MAX_SIZE=500000"], timeout=1200, cwd=workdir)
    s = pmtiles_inspect.summarize(pmt)
    probs = pmtiles_inspect.check(s, min_zoom=FIRE_TRAILS_MINZOOM, max_zoom=FIRE_TRAILS_MAXZOOM,
                                  layer=layers[0])
    if probs:
        raise RuntimeError("fire trails pmtiles: " + "; ".join(probs))
    return pmt


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------

def build_fire(client: httpx.Client, storage: Storage, entry: dict, *, workdir: Path,
               osm_pbf: Path | None, osm_date: str | None, osm_regions: list[str],
               trails_src: str | None, trails_build: str | None, now: datetime | None = None,
               log=print, landfire_fetch=None, nhd_items=None, nhd_fetch=None) -> dict:
    """-> {"status": built|unchanged, "bundle_id", "pointer"}. Raises on failure.

    `landfire_fetch(bbox5070, workdir)` / `nhd_items` / `nhd_fetch(item)` let
    tests and `routing-one` substitute local rasters for the network."""
    now = now or datetime.now(timezone.utc)
    aoi = entry["aoi"]
    g = aoi["grid"]
    zone, northern, epsg = aoi["zone"], aoi["northern"], aoi["epsg"]
    rect = grid_bounds(g)
    fk = entry["fire_key"]
    warnings: list[str] = []
    workdir.mkdir(parents=True, exist_ok=True)

    # --- cheap inputs first: they decide the bundle id ---
    nodes_ll, ways = ({}, [])
    if osm_pbf is not None and osm_pbf.exists():
        nodes_ll, ways = osm_extract.read_opl(osm_extract.to_opl(osm_pbf, workdir / "aoi.opl"))
    agency_ll = []
    try:
        agency_ll = load_agency_trails(trails_src, aoi["bbox4326"], workdir)
    except gdal_cli.GdalError as exc:
        log(f"[routing] {fk}: agency trails unavailable: {exc}")
    if not trails_src or (not agency_ll and trails_build is None):
        warnings.append("trails_unavailable")
    agency = project_trails(agency_ll, zone=zone, northern=northern, rect=rect)
    try:
        items = nhd_items if nhd_items is not None else nhd.huc8_for_bbox(client, aoi["bbox4326"])
    except Exception as exc:  # noqa: BLE001
        log(f"[routing] {fk}: NHD lookup failed: {str(exc)[:200]}")
        items = None
    if not items:
        warnings.append("nhd_unavailable")
    inputs = {
        "recipe": config.ROUTING_RECIPE, "cost_model": "getv2-evc+sullivan2020/1",
        "graph_format": GRAPH_FORMAT, "epsg": epsg, "grid": g,
        "lf": "LF2025-else-LF2024/pixel", "lf_epoch": f"{now:%Y-%m}", "topo": "LF2020",
        "osm_hash": graph_build.osm_hash(nodes_ll, ways),
        "trails_hash": graph_build.trails_hash(agency),
        "nhd": sorted(i["huc8"] for i in (items or [])),
    }
    bid = bundle_id_for(inputs)
    prefix = f"routing/{fk}/b{bid}"
    prev = storage.get_json(pointer_key(fk))
    if prev and prev.get("bundle_id") == bid and storage.exists(f"{prefix}/bundle.json"):
        return {"status": "unchanged", "bundle_id": bid, "pointer": prev}

    # --- grid ---
    fetch = landfire_fetch or (lambda b, wd: landfire.fetch_all(
        client, b, wd, log=log, need_lf2024=_lf_incomplete))
    lf = fetch(bbox_5070(aoi), workdir / "lf")
    if "wcs" in (lf.get("via") or ()):
        warnings.append("landfire_wcs_fallback")
    wd = workdir / "warp"
    wd.mkdir(exist_ok=True)
    slope = warp(lf["topo"]["SlpD"], wd / "slope.tif", aoi, categorical=False, ot="Float32")
    elev = warp(lf["topo"]["Elev"], wd / "elev.tif", aoi, categorical=False, ot="Float32")
    vers = {}
    for ver in ("LF2025", "LF2024"):
        if lf.get(ver):
            vers[ver] = {k: warp(lf[ver][p], wd / f"{ver}_{p}.tif", aoi, categorical=True, ot="Int16")
                         for k, p in (("evt", "EVT"), ("evc", "EVC"), ("fbfm", "FBFM40"))}
    veg, lf_label = cost_grid.mosaic_versions(vers.get("LF2025"), vers.get("LF2024"))
    streams = water = None
    if items:
        try:
            gpk = [(nhd_fetch(i) if nhd_fetch else nhd.ensure_huc8(client, storage, i, workdir, log))
                   for i in items]
            st_tif, wa_tif = nhd.rasterize(gpk, epsg=epsg, bounds_utm=rect, cell=g["cell_m"],
                                           bbox4326=aoi["bbox4326"], workdir=workdir)
            if st_tif:
                streams = gdal_cli.read_raster(st_tif, workdir / "envi_nhd")[0][0]
            if wa_tif:
                water = gdal_cli.read_raster(wa_tif, workdir / "envi_nhd")[0][0]
        except Exception as exc:  # noqa: BLE001
            log(f"[routing] {fk}: NHD failed: {str(exc)[:200]}")
            warnings.append("nhd_unavailable")
    cg = cost_grid.compute(evt=veg["evt"], evc=veg["evc"], fbfm=veg["fbfm"], slope=slope,
                           elev=elev, streams=streams, water=water)
    if cg["stats"]["nodata_pct"] > 5:
        warnings.append("nodata_border")
    if aoi.get("clipped"):
        warnings.append("aoi_clipped")
    if g["cell_m"] > 30:
        warnings.append("coarse_grid_60m")
    geo = gdal_cli.Georef(epsg, g["x0"], g["y0"], g["cell_m"], g["cell_m"], g["width"], g["height"])
    out = workdir / "out"
    out.mkdir(exist_ok=True)
    grid_tif = gdal_cli.write_raster(
        np.stack([cg["pace"], cg["veg"]]), geo, out / "grid.tif", band_names=["pace", "veg"],
        creation=["COMPRESS=DEFLATE", "ZLEVEL=9", "PREDICTOR=1", "TILED=YES", "BLOCKXSIZE=512",
                  "BLOCKYSIZE=512", "INTERLEAVE=BAND"],
        metadata={"RD_RECIPE": str(config.ROUTING_RECIPE), "RD_PACE": "logpace-v1",
                  "RD_VEG": "veg-v1"})
    dem_tif = gdal_cli.write_raster(
        cg["dem"], geo, out / "dem.tif", nodata=-32768,
        creation=["COMPRESS=DEFLATE", "ZLEVEL=9", "PREDICTOR=2", "TILED=YES", "BLOCKXSIZE=512",
                  "BLOCKYSIZE=512"])

    # --- graph + per-fire trails ---
    graph = graph_build.osm_graph(nodes_ll, ways, zone=zone, northern=northern, rect=rect)
    conf = graph_build.conflate(graph, agency, log=log)
    gstats = graph_build.graph_stats(graph)
    graph_path = out / "graph.bin.gz"
    graph_path.write_bytes(graph_build.encode_rdg1(graph, epsg=epsg, x0=g["x0"], y0=g["y0"]))
    trails_pm = write_fire_trails(graph, agency_ll, aoi, workdir, f"{entry.get('name') or fk} trails")

    files = {"grid": grid_tif, "dem": dem_tif, "graph": graph_path}
    if trails_pm:
        files["trails"] = trails_pm
    desc_files = {}
    for k, p in files.items():
        desc_files[k] = {"path": f"/{prefix}/{p.name}", "bytes": p.stat().st_size,
                         "sha256": _sha256(p)}
    desc_files["graph"].update(nodes=gstats["nodes"], edges=gstats["edges"])
    if "trails" in desc_files:
        desc_files["trails"].update(minzoom=FIRE_TRAILS_MINZOOM, maxzoom=FIRE_TRAILS_MAXZOOM)
    built_at = _iso(datetime.now(timezone.utc))
    total = sum(f["bytes"] for f in desc_files.values())
    per = entry.get("perimeter") or {}
    descriptor = {
        "schema": "rd-routing-bundle/1", "recipe": config.ROUTING_RECIPE, "bundle_id": bid,
        "cornea_id": entry["cornea_id"], "fire_key": fk, "fire_name": entry.get("name"),
        "built_at": built_at,
        "crs": {"epsg": epsg, "zone": zone, "northern": northern},
        "grid": g, "bounds4326": aoi["bbox4326"],
        "aoi": {"source": aoi.get("source"), "perimeter_date": per.get("date"),
                "buffer_m": config.ROUTING_BUFFER_M, "clipped": bool(aoi.get("clipped"))},
        "files": desc_files,
        "sources": {"landfire": {"veg": lf_label, "topo": "LF2020",
                                 "via": "wcs" if "wcs" in (lf.get("via") or ()) else "exportImage"},
                    "osm": {"regions": osm_regions, "date": osm_date},
                    "trails": {"build_id": trails_build},
                    "nhd": {"huc8": inputs["nhd"]}},
        "stats": {**cg["stats"], "graph": gstats, "conflation": conf},
        "warnings": sorted(set(warnings)),
        "attribution": ATTRIBUTION, "license": LICENSE,
        "inputs": inputs,
    }
    for k in ("grid", "dem", "graph", "trails"):
        if k in files:
            storage.put_file(f"{prefix}/{files[k].name}", files[k])
    storage.put_json(f"{prefix}/bundle.json", descriptor)
    pointer = {
        "schema": "rd-routing-fire/1", "recipe": config.ROUTING_RECIPE,
        "cornea_id": entry["cornea_id"], "fire_key": fk, "bundle_id": bid,
        "descriptor": f"/{prefix}/bundle.json", "built_at": built_at,
        "bbox": aoi["bbox4326"], "cell_m": g["cell_m"], "bytes": total,
        "aoi": {"epsg": epsg, "zone": zone, "northern": northern, "grid": g,
                "bbox4326": aoi["bbox4326"], "clipped": bool(aoi.get("clipped"))},
    }
    storage.put_json(pointer_key(fk), pointer)  # LAST
    log(f"[routing] {fk} built b{bid}: {g['width']}x{g['height']}@{g['cell_m']}m, "
        f"{gstats['edges']} edges, {total / 1e6:.1f} MB, lf={lf_label}"
        + (f", warnings={descriptor['warnings']}" if descriptor["warnings"] else ""))
    return {"status": "built", "bundle_id": bid, "pointer": pointer, "descriptor": descriptor}


def record_state(storage: Storage, fk: str, *, ok: bool, now: datetime, error: str | None = None,
                 extra: dict | None = None) -> dict:
    st = dict(storage.get_json(state_key(fk)) or {})
    st["schema"] = 1
    st["last_attempt_at"] = _iso(now)
    if ok:
        st.update(failures=0, last_error=None, last_success_at=_iso(now), checked_at=_iso(now))
    else:
        st.update(failures=int(st.get("failures") or 0) + 1, last_error=(error or "")[:300])
    st.update(extra or {})
    storage.put_json(state_key(fk), st)
    return st


def index_doc(pointers: dict[str, dict], now: datetime) -> dict:
    """catalogs/routing.json from per-fire pointers only (a crashed shard
    can orphan bytes, never publish a pointer to missing ones)."""
    fires = {}
    for cid, p in sorted(pointers.items()):
        if not p or p.get("recipe") != config.ROUTING_RECIPE:
            continue
        fires[cid] = {"descriptor": p["descriptor"], "bundle_id": p["bundle_id"],
                      "built_at": p["built_at"], "bbox": p["bbox"], "cell_m": p["cell_m"],
                      "bytes": p["bytes"]}
    return {"schema": "rd-routing-index/1", "generated_at": _iso(now),
            "recipe": config.ROUTING_RECIPE, "fires": fires}
