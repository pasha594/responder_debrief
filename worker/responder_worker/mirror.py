"""Incremental FTP mirror: crawl matched incident dirs, conditional downloads,
B2 raw/ uploads, per-incident checkpoints.

Change detection: listed child-dir mtimes vs state (skip unchanged subtrees
with zero requests); per-file etag/last-modified conditional GETs; QR in-place
overwrites bump `rev`.
"""

from __future__ import annotations

import hashlib
import re
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from . import config, frames
from .ftp_index import Entry, list_dir
from .http import get
from .state import now_iso

_DAILY_YMD_RE = re.compile(r"^(?P<y>\d{4})(?P<m>\d{2})(?P<d>\d{2})$")
_DAILY_MDY_RE = re.compile(r"^(?P<m>\d{2})(?P<d>\d{2})(?P<y>\d{4})$")

MAX_NAMED_SUBDIRS = 4  # politeness cap on the extra listing level


def _daily_key(name: str) -> str | None:
    """Sortable YYYYMMDD key for a dated dir name, else None.

    Accepts both YYYYMMDD (`20260730`) and MMDDYYYY (`07282026`) — real
    incidents mix them inside one folder. Month validity disambiguates: for
    `07282026` the YYYYMMDD read gives month 20, so it falls through to MMDDYYYY.
    """
    for rx in (_DAILY_YMD_RE, _DAILY_MDY_RE):
        m = rx.match(name)
        if not m:
            continue
        mm, dd = int(m.group("m")), int(m.group("d"))
        if 1 <= mm <= 12 and 1 <= dd <= 31:
            return f"{m.group('y')}{m.group('m')}{m.group('d')}"
    return None


def _safe_name(name: str) -> str:
    return name.replace(" ", "_")


def _sha16_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


@dataclass
class MirroredFile:
    kind: str            # product | qr | ir
    filename: str
    key: str             # B2 key (raw/incidents/...)
    url: str             # source URL
    size: int | None
    sha16: str | None
    rev: int
    local_path: Path | None   # None if skipped/unchanged and not re-downloaded
    changed: bool
    rel_dir: str         # 'products/20260817' | 'qr' | 'ir/20260817'


@dataclass
class MirrorResult:
    files: list[MirroredFile] = field(default_factory=list)
    listings: int = 0
    downloads: int = 0
    skipped_unchanged: int = 0
    skipped_too_big: int = 0
    bytes_downloaded: int = 0
    skipped_deferred: int = 0


class IncidentMirror:
    def __init__(self, client: httpx.Client, storage, state: dict, *,
                 work_dir: Path | None = None,
                 max_file_mb: float | None = None,
                 max_files: int | None = None,
                 products_keep: int = config.PRODUCTS_DAILY_KEEP,
                 ir_keep: int = config.IR_KEEP,
                 since: str | None = None,
                 force: bool = False):
        self.client = client
        self.storage = storage
        self.state = state
        self.work_dir = work_dir or Path(tempfile.mkdtemp(prefix="mirror_"))
        self.max_file_bytes = int(max_file_mb * 1024 * 1024) if max_file_mb else None
        self.max_files = max_files
        self.products_keep = products_keep
        self.ir_keep = ir_keep
        self.since = since  # YYYYMMDD: backfill floor for Products dailies
        self.force = force

    # ------------------------------------------------------------------
    def sync_incident(self, *, incident_key: str, fire_slug: str, dir_url: str,
                      match: dict, dir_mtime: str | None) -> MirrorResult:
        res = MirrorResult()
        inc_state = self.state["incidents"].setdefault(incident_key, {
            "fire_slug": fire_slug,
            "match": match,
            "dir_mtime": None,
            "children": {},
            "files": {},
        })
        inc_state["fire_slug"] = fire_slug
        inc_state["match"] = match

        children = list_dir(self.client, dir_url)
        res.listings += 1

        saw_known_child = False
        for child in children:
            if not child.is_dir:
                continue
            cname = child.name
            prev_mtime = inc_state["children"].get(cname)
            unchanged = (not self.force and prev_mtime and prev_mtime == child.mtime)
            if cname.lower() in ("products", "gis"):
                if unchanged:
                    res.skipped_unchanged += 1
                    self._replay_cached(inc_state, "products/", fire_slug, res)
                else:
                    self._sync_products(child, inc_state, fire_slug, res)
            elif cname.lower() == "qr":
                if unchanged:
                    res.skipped_unchanged += 1
                    self._replay_cached(inc_state, "qr/", fire_slug, res)
                else:
                    self._sync_flat(child, inc_state, fire_slug, "qr", "qr", res)
            elif cname.lower() == "ir":
                if unchanged:
                    res.skipped_unchanged += 1
                    self._replay_cached(inc_state, "ir/", fire_slug, res)
                else:
                    self._sync_ir(child, inc_state, fire_slug, res)
            else:
                continue  # unknown subfolder — not a known container
            saw_known_child = True
            inc_state["children"][cname] = child.mtime

        if not saw_known_child:
            # No Products/GIS/QR/IR at all: the incident dir IS the products
            # container, with dated dirs (and sometimes loose files) at its root
            # — e.g. 2026_BigGrass/20260817/. Without this the whole incident
            # mirrored as zero files.
            self._sync_dailies(children, inc_state, fire_slug, res)
            for e in children:
                if not e.is_dir:
                    self._file(e, inc_state, fire_slug, "products/current",
                               "product", res)

        inc_state["dir_mtime"] = dir_mtime
        inc_state["synced_at"] = now_iso()
        return res

    # ------------------------------------------------------------------
    def _replay_cached(self, inc_state: dict, rel_prefix: str, fire_slug: str,
                       res: MirrorResult) -> None:
        """Subtree unchanged: emit records from state without any requests."""
        for rel, meta in inc_state["files"].items():
            if not rel.startswith(rel_prefix):
                continue
            rel_dir, _, filename = rel.rpartition("/")
            kind = "mobile" if meta.get("kind") == "mobile" else rel_prefix.rstrip("/").split("/")[0]
            kind = {"products": "product"}.get(kind, kind)
            res.files.append(MirroredFile(
                kind=meta.get("kind", kind), filename=filename,
                key=f"raw/incidents/{fire_slug}/{rel}",
                url=meta.get("url", ""), size=meta.get("size"),
                sha16=meta.get("sha16"), rev=meta.get("rev", 1),
                local_path=None, changed=False, rel_dir=rel_dir,
            ))

    def _sync_products(self, child: Entry, inc_state: dict, fire_slug: str,
                       res: MirrorResult) -> None:
        """Products/GIS trees are GISS-operator-shaped and vary a lot.

        Observed layouts (all handled):
          Products/20260817/…                      daily dirs at the top
          Products/ops_….pdf                       files loose at the top
          Products/Current Maps/ops_….pdf          named subfolder of current maps
          Products/Daily Products/07282026/…       named subfolder of daily dirs,
                                                   with MMDDYYYY as well as YYYYMMDD
        Coleman Creek is the second+third+fourth case at once, and the
        daily-dirs-only crawler silently mirrored nothing for it.
        """
        entries = list_dir(self.client, child.url)
        res.listings += 1

        # (a) files sitting directly in Products/
        for e in entries:
            if not e.is_dir:
                self._file(e, inc_state, fire_slug, "products/current", "product", res)

        # (b) daily dirs directly in Products/
        self._sync_dailies(entries, inc_state, fire_slug, res)

        # (c) one level of named subfolders ("Current Maps", "Daily Products", …)
        named = [e for e in entries if e.is_dir and _daily_key(e.name) is None]
        for sub in named[:MAX_NAMED_SUBDIRS]:
            if frames.deadline_passed():
                break
            sub_entries = list_dir(self.client, sub.url)
            res.listings += 1
            rel = f"products/{_safe_name(sub.name).lower()}"
            for e in sub_entries:
                if not e.is_dir:
                    self._file(e, inc_state, fire_slug, rel, "product", res)
            self._sync_dailies(sub_entries, inc_state, fire_slug, res)

    def _sync_dailies(self, entries: list[Entry], inc_state: dict, fire_slug: str,
                      res: MirrorResult) -> None:
        """Newest N dated dirs from `entries`, keyed by normalized YYYYMMDD."""
        dailies: list[tuple[str, Entry]] = []
        for e in entries:
            if not e.is_dir:
                continue
            key = _daily_key(e.name)
            if key and (not self.since or key >= self.since):
                dailies.append((key, e))
        dailies.sort(key=lambda ke: ke[0], reverse=True)
        for key, daily in dailies[: self.products_keep]:
            # B2 path uses the NORMALIZED key so 07282026 and 20260728 land in
            # one place and manifest op_date parsing stays uniform.
            self._sync_flat(daily, inc_state, fire_slug, f"products/{key}", "product", res)

    def _sync_ir(self, child: Entry, inc_state: dict, fire_slug: str,
                 res: MirrorResult) -> None:
        entries = list_dir(self.client, child.url)
        res.listings += 1
        dirs = [e for e in entries if e.is_dir]
        dirs.sort(key=lambda e: e.name, reverse=True)
        for sub in dirs[: self.ir_keep]:
            self._sync_flat(sub, inc_state, fire_slug, f"ir/{sub.name}", "ir", res)
        if not dirs:
            # some incidents keep flight files directly under IR/
            for e in entries:
                if not e.is_dir:
                    self._file(e, inc_state, fire_slug, "ir", "ir", res)

    def _sync_flat(self, dir_entry: Entry, inc_state: dict, fire_slug: str,
                   rel_dir: str, kind: str, res: MirrorResult) -> None:
        entries = list_dir(self.client, dir_entry.url)
        res.listings += 1
        for e in entries:
            if e.is_dir:
                continue
            self._file(e, inc_state, fire_slug, rel_dir, kind, res)

    # ------------------------------------------------------------------
    def _file(self, e: Entry, inc_state: dict, fire_slug: str, rel_dir: str,
              kind: str, res: MirrorResult) -> None:
        if self.max_files is not None and res.downloads >= self.max_files:
            return
        filename = _safe_name(e.name)
        rel = f"{rel_dir}/{filename}"
        key = f"raw/incidents/{fire_slug}/{rel}"
        fkind = kind
        if filename.lower().startswith("mobile"):
            fkind = "mobile"

        cap = self.max_file_bytes
        if fkind == "mobile":
            mobile_cap = config.MOBILE_CAP_MB * 1024 * 1024
            cap = min(cap, mobile_cap) if cap else mobile_cap
        if cap and e.size_hint and e.size_hint > cap:
            res.skipped_too_big += 1
            return

        # Honor the mirror wall-clock mid-incident: a big fire's QR/daily sets
        # can take many minutes; deferred files re-enter next scheduled run.
        if frames.deadline_passed():
            res.skipped_deferred += 1
            return

        meta = inc_state["files"].get(rel, {})
        headers = {}
        if not self.force:
            if meta.get("etag"):
                headers["If-None-Match"] = meta["etag"]
            elif meta.get("lm"):
                headers["If-Modified-Since"] = meta["lm"]

        resp = get(self.client, e.url, headers=headers)
        if resp.status_code == 304:
            res.skipped_unchanged += 1
            res.files.append(MirroredFile(
                kind=meta.get("kind", fkind), filename=filename, key=key, url=e.url,
                size=meta.get("size"), sha16=meta.get("sha16"),
                rev=meta.get("rev", 1), local_path=None, changed=False,
                rel_dir=rel_dir,
            ))
            return

        body = resp.content
        if cap and len(body) > cap:
            res.skipped_too_big += 1
            return
        sha = _sha16_bytes(body)
        rev = meta.get("rev", 0)
        changed = sha != meta.get("sha16")
        if changed:
            rev += 1

        local = self.work_dir / fire_slug / rel
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_bytes(body)
        self.storage.put_file(key, local)

        inc_state["files"][rel] = {
            "etag": resp.headers.get("etag"),
            "lm": resp.headers.get("last-modified"),
            "size": len(body),
            "sha16": sha,
            "rev": max(rev, 1),
            "kind": fkind,
            "url": e.url,
        }
        res.downloads += 1
        res.bytes_downloaded += len(body)
        res.files.append(MirroredFile(
            kind=fkind, filename=filename, key=key, url=e.url, size=len(body),
            sha16=sha, rev=max(rev, 1), local_path=local, changed=changed,
            rel_dir=rel_dir,
        ))
