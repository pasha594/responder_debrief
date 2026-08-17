"""IR flight products: Shapefiles.zip -> merged 4326 GeoJSON tagged by heat class."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

HEAT_CLASSES = ("Perimeter", "Intense", "Scattered", "Isolated")

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
            shps = sorted(tmpd.rglob(f"*_{heat}.shp"))
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
