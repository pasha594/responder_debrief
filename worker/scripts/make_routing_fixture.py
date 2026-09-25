"""Write the synthetic scene's routing bundle (tests/routing_scene.py) into
frontend/src/routing/__fixtures__/synthetic/ so the browser router's tests
decode bytes the worker really produced (GDAL GeoTIFFs, RDG1, PMTiles).

    cd worker && uv run python scripts/make_routing_fixture.py
"""

from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "tests"))

import routing_scene  # noqa: E402

from responder_worker.b2 import DryRunStorage  # noqa: E402
from responder_worker import routing_bundle as rb  # noqa: E402

DEST = HERE.parent.parent / "frontend" / "src" / "routing" / "__fixtures__" / "synthetic"


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        storage = DryRunStorage(root / "out")
        res = routing_scene.build(root / "out", root / "work", storage, log=print)
        if not res["built"]:
            print(res)
            return 1
        fk = routing_scene.plan_entry()["fire_key"]
        ptr = storage.get_json(rb.pointer_key(fk))
        desc_key = ptr["descriptor"].lstrip("/")
        desc = storage.get_json(desc_key)
        DEST.mkdir(parents=True, exist_ok=True)
        for f in DEST.iterdir():
            f.unlink()
        shutil.copyfile(root / "out" / desc_key, DEST / "bundle.json")
        for f in desc["files"].values():
            src = root / "out" / f["path"].lstrip("/")
            shutil.copyfile(src, DEST / src.name)
        print(f"wrote {sorted(p.name for p in DEST.iterdir())} to {DEST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
