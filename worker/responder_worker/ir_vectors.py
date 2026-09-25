"""IR flight products: Shapefiles.zip or KMZ -> merged 4326 GeoJSON tagged by
heat class, plus the flight time the KMZ states."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
import zipfile
from datetime import date, datetime, timedelta
from pathlib import Path

HEAT_CLASSES = ("Perimeter", "Intense", "Scattered", "Isolated", "Obscured")
# shapefile-name suffix where it isn't the class name ("..._Cloud_Cover.shp":
# imagery the sensor couldn't see through)
_SHP_SUFFIX = {"Obscured": "Cloud_Cover"}

_ACREAGE_RE = re.compile(r"Estimated\s+Acreage:?\s*([\d,\.]+)", re.I)


def parse_estimated_acres(readme_text: str) -> float | None:
    m = _ACREAGE_RE.search(readme_text)
    if not m:
        return None
    try:
        return float(m.group(1).replace(",", ""))
    except ValueError:
        return None


def _ogr2ogr_geojson(shp: Path, out: Path) -> None:
    subprocess.run(
        ["ogr2ogr", "-f", "GeoJSON", "-t_srs", "EPSG:4326", str(out), str(shp)],
        check=True, capture_output=True, text=True,
    )


def process_ir_zip(zip_path: Path, out_geojson: Path, *, flight_id: str) -> dict:
    """Unzip (ignoring *.lock), convert each heat-class shapefile to 4326,
    merge into one FeatureCollection tagged heat_type + flight_id.

    Returns {heat_types: [...], feature_count: int} — raises if ogr2ogr missing.
    """
    if shutil.which("ogr2ogr") is None:
        raise RuntimeError("ogr2ogr not on PATH")

    features: list[dict] = []
    heat_types: list[str] = []
    with tempfile.TemporaryDirectory(prefix="ir_") as tmp:
        tmpd = Path(tmp)
        with zipfile.ZipFile(zip_path) as zf:
            for zi in zf.infolist():
                if zi.filename.endswith(".lock") or ".lock" in Path(zi.filename).suffixes:
                    continue
                if ".sr.lock" in zi.filename:
                    continue
                zf.extract(zi, tmpd)

        for heat in HEAT_CLASSES:
            shps = sorted(tmpd.rglob(f"*_{_SHP_SUFFIX.get(heat, heat)}.shp"))
            if not shps:
                continue
            out_tmp = tmpd / f"{heat}.geojson"
            try:
                _ogr2ogr_geojson(shps[0], out_tmp)
            except subprocess.CalledProcessError:
                continue
            data = json.loads(out_tmp.read_text())
            feats = data.get("features", [])
            if not feats:
                continue
            heat_types.append(heat)
            for f in feats:
                f.setdefault("properties", {})
                f["properties"]["heat_type"] = heat
                f["properties"]["flight_id"] = flight_id
                features.append(f)

    out_geojson.parent.mkdir(parents=True, exist_ok=True)
    out_geojson.write_text(json.dumps(
        {"type": "FeatureCollection", "features": features}
    ))
    return {"heat_types": heat_types, "feature_count": len(features)}


# ---------------------------------------------------------------------------
# KMZ fallback: some teams publish IR heat as KMZ only (no Shapefiles.zip).
# GDAL reads KMZ natively. Two layouts are in the wild:
#   - ArcGIS exports: one KML folder (= OGR layer) per heat class, named
#     "Intense Heat", "Isolated Fires", ...
#   - NIROPS: no folders at all — one layer named after the file, holding
#     one named placemark per class ("Heat Perimeter", "Imagery Obscured").
# Layer names win when any carries a class; otherwise each placemark's name.
# ---------------------------------------------------------------------------

_KMZ_CLASS_RES = (
    (re.compile(r"intense", re.I), "Intense"),
    (re.compile(r"scatter", re.I), "Scattered"),
    (re.compile(r"isolat", re.I), "Isolated"),
    (re.compile(r"perimeter", re.I), "Perimeter"),
    # areas the sensor couldn't see (clouds, smoke, coverage gaps): heat
    # may be there unmapped. NIROPS calls it "Imagery Obscured", or splits
    # it into "Cloud AOI" + "NoData".
    (re.compile(r"obscur|cloud|\bno\s*data", re.I), "Obscured"),
    (re.compile(r"possible", re.I), "Possible"),
)


def _classify_kmz_layer(name: str) -> str | None:
    for rx, heat in _KMZ_CLASS_RES:
        if rx.search(name):
            return heat
    return None


# Bump to redo every flight's conversion: worker state caches each result
# (and each failure) keyed on this, so a bump re-converts from the raw files
# already in our bucket.
IR_CONVERTER_VERSION = 3


def _list_layers(path: Path) -> tuple[list[str], str | None]:
    """Layer names via `ogrinfo -q` ("N: Name (Geometry)" lines), plus the
    error text when GDAL can't open the file at all."""
    res = subprocess.run(["ogrinfo", "-q", str(path)],
                         capture_output=True, text=True, timeout=120)
    if res.returncode != 0:
        return [], (res.stderr or res.stdout).strip()[:300] or "ogrinfo failed"
    out = []
    for line in res.stdout.splitlines():
        m = re.match(r"^\d+:\s+(.*?)(?:\s+\([^)]*\))?\s*$", line.strip())
        if m and m.group(1):
            out.append(m.group(1))
    return out, None


def _kml_bytes(kmz_path: Path) -> bytes | None:
    """The .kml inside a KMZ (a zip around it), or None."""
    try:
        with zipfile.ZipFile(kmz_path) as zf:
            name = next((n for n in zf.namelist()
                         if n.lower().endswith(".kml")), None)
            return zf.read(name) if name else None
    except Exception:
        return None


_COORDS_RE = re.compile(rb"<coordinates>(.*?)</coordinates>", re.S)


def _regroup_flat_coords(m: re.Match) -> bytes:
    """NIROPS writes coordinates as one flat comma list ("x,y,0,x,y,0,...")
    instead of whitespace-separated tuples. LIBKML copes; the classic KML
    driver keeps only the first vertex. Regroup into tuples — only when the
    list is unambiguous: no whitespace, and every third value a zero altitude."""
    body = m.group(1).strip()
    vals = body.split(b",")
    if (re.search(rb"\s", body) or len(vals) <= 3 or len(vals) % 3
            or any(float(v or 1) != 0 for v in vals[2::3])):
        return m.group(0)
    tuples = (b",".join(vals[i:i + 3]) for i in range(0, len(vals), 3))
    return b"<coordinates>" + b" ".join(tuples) + b"</coordinates>"


def _extract_kml(kmz_path: Path, tmpd: Path) -> Path | None:
    """GDAL built without LIBKML (some CI images) can't open the archive but
    reads the inner file fine with the classic KML driver — so extract it
    with stdlib zipfile."""
    data = _kml_bytes(kmz_path)
    if data is None:
        return None
    try:
        data = _COORDS_RE.sub(_regroup_flat_coords, data)
    except ValueError:
        pass  # a non-numeric value: leave the file as published
    out = tmpd / "doc.kml"
    out.write_bytes(data)
    return out


def _has_coords(geom: dict | None) -> bool:
    """False for the empty placemarks NIROPS writes when a class has nothing
    (an "Imagery Obscured" with no obscured area is an empty collection)."""
    if not geom:
        return False
    if geom.get("type") == "GeometryCollection":
        return any(_has_coords(g) for g in geom.get("geometries") or [])
    return bool(geom.get("coordinates"))


def process_ir_kmz(kmz_path: Path, out_geojson: Path, *, flight_id: str) -> dict:
    """KMZ -> merged FeatureCollection tagged heat_type + flight_id, same
    contract as process_ir_zip. Features with no heat class (labels, flight
    lines, legends) and empty placemarks are skipped. Points are kept —
    isolated and possible heat arrive as point placemarks."""
    if shutil.which("ogr2ogr") is None:
        raise RuntimeError("ogr2ogr not on PATH")

    features: list[dict] = []
    heat_types: list[str] = []
    with tempfile.TemporaryDirectory(prefix="irkmz_") as tmp:
        tmpd = Path(tmp)
        src = kmz_path
        layers, err = _list_layers(src)
        if not any(_classify_kmz_layer(n) for n in layers):
            kml = _extract_kml(kmz_path, tmpd)
            if kml is not None:
                src = kml
                layers, err = _list_layers(src)
        by_layer = any(_classify_kmz_layer(n) for n in layers)
        for i, layer in enumerate(layers):
            layer_heat = _classify_kmz_layer(layer)
            if by_layer and layer_heat is None:
                continue
            out_tmp = tmpd / f"layer{i}.geojson"
            try:
                subprocess.run(
                    ["ogr2ogr", "-f", "GeoJSON", "-t_srs", "EPSG:4326",
                     "-lco", "COORDINATE_PRECISION=6",
                     str(out_tmp), str(src), layer],
                    capture_output=True, text=True, timeout=300, check=True)
            except subprocess.CalledProcessError:
                continue
            data = json.loads(out_tmp.read_text())
            for f in data.get("features", []):
                props = f.get("properties") or {}
                heat = layer_heat or _classify_kmz_layer(
                    str(props.get("Name") or props.get("name") or ""))
                if heat is None or not _has_coords(f.get("geometry")):
                    continue
                if heat not in heat_types:
                    heat_types.append(heat)
                f["properties"] = {"heat_type": heat, "flight_id": flight_id}
                features.append(f)

    if not features:
        raise RuntimeError(
            f"no heat-class features in KMZ (layers={layers[:12]!r}"
            + (f", gdal: {err}" if err else "") + ")")
    out_geojson.parent.mkdir(parents=True, exist_ok=True)
    out_geojson.write_text(json.dumps(
        {"type": "FeatureCollection", "features": features}
    ))
    return {"heat_types": heat_types, "feature_count": len(features)}


# ---------------------------------------------------------------------------
# Flight time, as the KMZ states it. NIROPS puts the local clock in the
# document description:
#   Image Acquisition Date: 20260923 <br/> Image Acquisition Time: 1925 (PDT)
# and sometimes leaves the time blank ("Image Acquisition Time: (PDT)").
# ArcGIS exports carry it on every placemark as attribute-table rows:
#   Production 9/4/2026 | Time_UTC 0445Z
# ---------------------------------------------------------------------------

_UTC_OFFSET_HOURS = {
    "UTC": 0, "GMT": 0, "Z": 0,
    "EDT": -4, "EST": -5, "CDT": -5, "CST": -6, "MDT": -6, "MST": -7,
    "PDT": -7, "PST": -8, "AKDT": -8, "AKST": -9, "HDT": -9, "HST": -10,
}
_NIROPS_DATE_RE = re.compile(r"Acquisition\s+Date:?\s*(\d{8})\b", re.I)
_NIROPS_TIME_RE = re.compile(
    r"Acquisition\s+Time:?\s*(\d{4})?\s*\(\s*([A-Za-z]{1,4})\s*\)", re.I)
_ARCGIS_RE = re.compile(
    r"Production\s+(\d{1,2})/(\d{1,2})/(\d{4})(?:\s+Time_UTC\s+(\d{4})\s*Z?)?", re.I)


def _utc_iso(year: int, month: int, day: int, hhmm: str, offset_h: int) -> str | None:
    try:
        local = datetime(year, month, day, int(hhmm[:2]), int(hhmm[2:]))
    except ValueError:
        return None
    return (local - timedelta(hours=offset_h)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _iso_date(year: int, month: int, day: int) -> str | None:
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return None


def parse_flight_time(kml_text: str) -> dict:
    """{"flown_at": UTC ISO instant, "flown_date": "YYYY-MM-DD"}, each None
    when unknown. flown_at needs a clock time in a known zone; failing that,
    flown_date carries the calendar date alone."""
    text = re.sub(r"<[^>]+>", " ", kml_text)  # descriptions are HTML
    out: dict = {"flown_at": None, "flown_date": None}
    m = _NIROPS_DATE_RE.search(text)
    if m:
        d = m.group(1)
        y, mo, dy = int(d[:4]), int(d[4:6]), int(d[6:])
        t = _NIROPS_TIME_RE.search(text)
        offset = _UTC_OFFSET_HOURS.get(t.group(2).upper()) if t else None
        if t and t.group(1) and offset is not None:
            out["flown_at"] = _utc_iso(y, mo, dy, t.group(1), offset)
        if out["flown_at"] is None:
            out["flown_date"] = _iso_date(y, mo, dy)
        return out
    m = _ARCGIS_RE.search(text)
    if m:
        mo, dy, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if m.group(4):
            out["flown_at"] = _utc_iso(y, mo, dy, m.group(4), 0)
        if out["flown_at"] is None:
            out["flown_date"] = _iso_date(y, mo, dy)
    return out


def kmz_flight_time(kmz_path: Path) -> dict:
    data = _kml_bytes(kmz_path)
    if data is None:
        return {"flown_at": None, "flown_date": None}
    return parse_flight_time(data.decode("utf-8-sig", errors="replace"))
