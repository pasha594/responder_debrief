"""Synthetic routing scene: a ridge, timber west / brush east, a meadow, a
lake, a slash patch, a cliff band, a perennial creek, an OSM forest road and
path, and two USFS trails (one duplicating the OSM path, one not in OSM).

Used by test_routing_bundle.py (a full bundle build through the real GDAL +
osmium CLIs) and by scripts/make_routing_fixture.py, which writes the same
bundle into frontend/src/routing/__fixtures__/ so the browser router is
tested against bytes the worker actually produces.

Everything is laid out in metres relative to the AOI centre in the fire's
UTM zone; LANDFIRE-like rasters are written directly on the UTM grid (the
bundle builder's warp is then an identity), which keeps the scene exact.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from responder_worker import gdal_cli, routing_plan, utm

CENTER = (-115.0, 44.2)
NAME = "synthetic-ridge"


def plan_entry() -> dict:
    aoi = routing_plan.aoi_for(list(CENTER), None, None)
    return {"cornea_id": "{SYNTH-0001}", "fire_key": routing_plan.fire_key("{SYNTH-0001}"),
            "name": "Synthetic Ridge", "slug": NAME, "acres": 1000, "point": list(CENTER),
            "aoi": aoi, "action": "build", "reason": "new", "regions": [],
            "perimeter": {"path": None, "date": None, "bbox": None}}


def _center_utm(aoi):
    return utm.fwd(*CENTER, aoi["zone"], aoi["northern"])


def _ll(aoi, dx, dy):
    cx, cy = _center_utm(aoi)
    lon, lat = utm.inv(cx + dx, cy + dy, aoi["zone"], aoi["northern"])
    return [round(lon, 7), round(lat, 7)]


def rasters(aoi: dict, out: Path) -> dict:
    g = aoi["grid"]
    cell, W, H = g["cell_m"], g["width"], g["height"]
    cx, cy = _center_utm(aoi)
    X = g["x0"] + (np.arange(W) + 0.5) * cell - cx
    Y = g["y0"] - (np.arange(H) + 0.5) * cell - cy
    dx, dy = np.meshgrid(X, Y)
    z = 1800 + 500 * np.exp(-(dx / 1500) ** 2) + 0.01 * dy
    gy, gx = np.gradient(z, cell)
    slope = np.degrees(np.arctan(np.hypot(gx, -gy)))
    cliff = (dx > -3000) & (dx < -2800) & (dy > 2000) & (dy < 4000)
    slope[cliff] = 60.0
    evc = np.where(dx < 0, 150, 240).astype(np.int16)
    fbfm = np.where(dx < 0, 165, 145).astype(np.int16)
    meadow = (dx - 2500) ** 2 + (dy + 2000) ** 2 < 800 ** 2
    lake = (dx + 2000) ** 2 + (dy + 2500) ** 2 < 500 ** 2
    slash = (dx > 3000) & (dx < 3600) & (dy > 2000) & (dy < 2600)
    evc[meadow], fbfm[meadow] = 320, 102
    evc[lake], fbfm[lake] = 11, 98
    fbfm[slash] = 202
    evt = np.full((H, W), 7011, np.int16)
    corner = (dx > 5000) & (dy > 5000)
    evc25, fbfm25, evt25 = evc.copy(), fbfm.copy(), evt.copy()
    for a in (evc25, fbfm25, evt25):
        a[corner] = -9999
    geo = gdal_cli.Georef(aoi["epsg"], g["x0"], g["y0"], cell, cell, W, H)
    out.mkdir(parents=True, exist_ok=True)

    def w(name, arr, dtype):
        return gdal_cli.write_raster(arr.astype(dtype), geo, out / f"{name}.tif", nodata=-9999)

    return {
        "topo": {"SlpD": w("slpd", slope, np.float32), "Elev": w("elev", z, np.float32)},
        "LF2025": {"EVT": w("evt25", evt25, np.int16), "EVC": w("evc25", evc25, np.int16),
                   "FBFM40": w("fbfm25", fbfm25, np.int16)},
        "LF2024": {"EVT": w("evt24", evt, np.int16), "EVC": w("evc24", evc, np.int16),
                   "FBFM40": w("fbfm24", fbfm, np.int16)},
        "via": {"exportImage"},
    }


def osm_pbf(aoi: dict, out: Path) -> Path:
    """Forest road 'FS 100' along the south, a path over the ridge sharing a
    node with the road, written as OPL and converted with osmium."""
    nodes, ways = [], []
    nid = 1
    road = []
    for i, x in enumerate(range(-7000, 7001, 500)):
        lon, lat = _ll(aoi, x, -4000)
        nodes.append(f"n{nid} v1 x{lon} y{lat}")
        road.append(nid)
        if x == -3000:
            shared = nid
        nid += 1
    path = [shared]
    for t in np.linspace(0, 1, 25)[1:]:
        lon, lat = _ll(aoi, -3000 + 6000 * t, -4000 + 8000 * t)
        nodes.append(f"n{nid} v1 x{lon} y{lat}")
        path.append(nid)
        nid += 1
    ways.append(f"w1 v1 Thighway=track,name=FS%20%100,surface=gravel N{','.join(f'n{n}' for n in road)}")
    ways.append(f"w2 v1 Thighway=path,sac_scale=mountain_hiking N{','.join(f'n{n}' for n in path)}")
    out.mkdir(parents=True, exist_ok=True)
    opl = out / "scene.opl"
    opl.write_text("\n".join(nodes + ways) + "\n")
    pbf = out / "scene.osm.pbf"
    gdal_cli.run(["osmium", "cat", str(opl), "-o", str(pbf), "--overwrite"])
    return pbf


def trails_fgb(aoi: dict, out: Path) -> Path:
    base = {"agency": "USFS", "cls": 3, "uses": "H,P", "foot": "yes", "season": None,
            "status": "open", "mgmt": None, "unit": None, "src_date": "2026-09-23"}
    dup = [_ll(aoi, -3000 + 6000 * t + 3, -4000 + 8000 * t - 3) for t in np.linspace(0, 1, 40)]
    trav = ([_ll(aoi, 3000 + 3500 * t, 4000 + 500 * t) for t in np.linspace(0, 1, 20)]
            + [_ll(aoi, 6500, 4500 - 8500 * t) for t in np.linspace(0, 1, 40)[1:]])
    trav[-1] = _ll(aoi, 6500, -3996)  # ends 4 m from the road
    feats = [
        dict(base, tid="usfs:1:0.000", name="Ridge Trail", num="101", restr=None),
        dict(base, tid="usfs:2:0.000", name="High Traverse", num="202",
             restr="Hiker restricted 01/01–12/31"),
    ]
    seq = out / "trails.geojsonl"
    with open(seq, "w") as f:
        for props, line in zip(feats, (dup, trav)):
            f.write(json.dumps({"type": "Feature", "properties": props,
                                "geometry": {"type": "MultiLineString", "coordinates": [line]}}) + "\n")
    fgb = out / "trails.fgb"
    fgb.unlink(missing_ok=True)
    gdal_cli.run(["ogr2ogr", "-f", "FlatGeobuf", str(fgb), str(seq), "-nln", "trails",
                  "-lco", "SPATIAL_INDEX=YES"])
    return fgb


def nhd_gpkg(aoi: dict, out: Path) -> Path:
    creek = [_ll(aoi, x, 1000 + 150 * np.sin(x / 1500)) for x in range(-8000, 8001, 250)]
    lake = [_ll(aoi, -2000 + 500 * np.cos(a), -2500 + 500 * np.sin(a))
            for a in np.linspace(0, 2 * np.pi, 33)]
    streams = out / "streams.geojsonl"
    streams.write_text(json.dumps({"type": "Feature", "properties": {"fcode": 46006},
                                   "geometry": {"type": "LineString", "coordinates": creek}}) + "\n")
    water = out / "water.geojsonl"
    water.write_text(json.dumps({"type": "Feature", "properties": {"fcode": 39004},
                                 "geometry": {"type": "Polygon", "coordinates": [lake]}}) + "\n")
    gp = out / "nhd_synth.gpkg"
    gp.unlink(missing_ok=True)
    gdal_cli.run(["ogr2ogr", "-f", "GPKG", str(gp), str(streams), "-nln", "streams",
                  "-nlt", "MULTILINESTRING"])
    gdal_cli.run(["ogr2ogr", "-update", "-f", "GPKG", str(gp), str(water), "-nln", "water",
                  "-nlt", "MULTIPOLYGON"])
    return gp


def build(out_dir: Path, work: Path, storage, *, log=lambda *_: None) -> dict:
    """Build the scene's bundle into `storage`. -> run_shard result."""
    from responder_worker import routing_cli

    entry = plan_entry()
    aoi = entry["aoi"]
    src = work / "scene"
    lf = rasters(aoi, src / "lf")
    pbf = osm_pbf(aoi, src)
    fgb = trails_fgb(aoi, src)
    gp = nhd_gpkg(aoi, src)
    plan = {"shards": [{"shard": 0, "fires": [entry]}],
            "trails": {"build_id": "20260925-synthetic", "fgb": None}}
    return routing_cli.run_shard(
        None, storage, plan, 0, workdir=work / "build", local_pbf=pbf, trails_src=str(fgb),
        log=log, landfire_fetch=lambda _b, _wd: lf,
        nhd_items=[{"huc8": "99999999", "url": "local"}], nhd_fetch=lambda _i: gp)
