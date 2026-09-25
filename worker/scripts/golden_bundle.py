"""Copy one routing bundle, and the perimeter its golden routes are checked
against, into a directory for the frontend's golden-route test
(frontend/src/routing/golden.test.ts, routes in golden.ts):

    cd worker && uv run python scripts/golden_bundle.py <bundle dir> <golden dir> [--perimeter FILE]
    cd frontend && ROUTING_GOLDEN_DIR=<golden dir> npx vitest run src/routing/golden.test.ts

<bundle dir> holds bundle.json and the files it lists, e.g. a dry run's
<out>/routing/<fire_key>/b<bundle_id>/ from `routing-one --dry-run`. Each
file is checked against the sha256 in bundle.json. The golden dir gets
bundle.json, grid.tif, dem.tif, graph.bin.gz and perimeter.json; keep it out
of the repository (real bundles are not committed).

--perimeter takes a {path, date, geometry} JSON (perimeters.latest_perimeter's
shape). Without it the fire's latest perimeter comes from the DEV fire API
(two requests). Golden routes say where their pins sit on the perimeter, so
one newer than the routes were written against fails as a changed
precondition, not as a routing bug.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

from responder_worker import perimeters
from responder_worker.http import make_client

FILES = ("grid", "dem", "graph")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("bundle_dir", type=Path)
    ap.add_argument("golden_dir", type=Path)
    ap.add_argument("--perimeter", type=Path, default=None,
                    help="perimeter JSON {path, date, geometry}; default: latest from the DEV fire API")
    args = ap.parse_args()

    desc = json.loads((args.bundle_dir / "bundle.json").read_text())
    args.golden_dir.mkdir(parents=True, exist_ok=True)
    for key in FILES:
        f = desc["files"][key]
        src = args.bundle_dir / Path(f["path"]).name
        if f.get("sha256") and sha256(src) != f["sha256"]:
            print(f"{src}: sha256 does not match bundle.json", file=sys.stderr)
            return 1
        shutil.copyfile(src, args.golden_dir / src.name)
    shutil.copyfile(args.bundle_dir / "bundle.json", args.golden_dir / "bundle.json")

    if args.perimeter:
        per = json.loads(args.perimeter.read_text())
    else:
        with make_client() as client:
            per = perimeters.latest_perimeter(client, desc["cornea_id"])
        if per is None:
            print(f"no perimeter for {desc['cornea_id']} on the DEV fire API", file=sys.stderr)
            return 1
    if not per.get("geometry") or not per.get("date"):
        print("perimeter JSON needs 'geometry' and 'date'", file=sys.stderr)
        return 1
    (args.golden_dir / "perimeter.json").write_text(json.dumps(
        {"path": per.get("path"), "date": per["date"], "geometry": per["geometry"]}))
    print(f"bundle {desc['bundle_id']} ({desc.get('fire_name') or desc['fire_key']}), "
          f"perimeter {per['date']} -> {args.golden_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
