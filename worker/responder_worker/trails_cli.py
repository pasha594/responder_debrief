"""`sync-trails` subcommand (registered from cli.build_parser so the new job
stays out of the 1,600-line cli.py)."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from . import config, frames, trails
from .b2 import make_storage
from .http import make_client


def log(msg: str) -> None:
    print(msg, flush=True)


def cmd_sync_trails(args) -> int:
    storage = make_storage(args.dry_run, args.out)
    frames.start_deadline(args.max_seconds)
    base = Path(args.workdir) if args.workdir else None
    with tempfile.TemporaryDirectory(prefix="trails_", dir=base) as td, make_client() as client:
        entry = trails.sync(client, storage, workdir=Path(td), force=args.force, log=log,
                            deadline_passed=frames.deadline_passed)
    # A failed build keeps the previous one live; the red exit makes the
    # workflow run visible without the page having to notice first.
    return 0 if entry.get("ok") else 3


def register(sub, common) -> None:
    sp = sub.add_parser("sync-trails",
                        help="national USFS/BLM/NPS trails -> trails.fgb + trails.pmtiles")
    common(sp)
    sp.add_argument("--max-seconds", type=int,
                    default=int(os.environ.get("TRAILS_MAX_SECONDS",
                                               config.TRAILS_MAX_SECONDS_DEFAULT)))
    sp.add_argument("--workdir", default=os.environ.get("RUNNER_TEMP") or None,
                    help="scratch parent dir (GBs of temp; default system tmp)")
    sp.set_defaults(func=cmd_sync_trails)
