"""Incremental FTP mirror: crawl matched incident dirs, conditional downloads,
B2 raw/ uploads, per-incident checkpoints.

Change detection: listed child-dir mtimes vs state (skip unchanged subtrees
with zero requests); per-file etag/last-modified conditional GETs; QR in-place
overwrites bump `rev`.

Records are bound to a fire by cornea_id (incident_ids.bind_record) and every
key comes from the record (asset_keys): an unchanged file is where its bytes
are, a new revision goes under the record's own storage prefix.
"""

from __future__ import annotations

import hashlib
import re
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import httpx

from . import config, frames
from .asset_keys import new_raw_key, raw_key, replay_file
from .ftp_index import Entry, list_dir
from .incident_ids import bind_record, revision_stamp


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
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


def select_current_period(dated: list, floor: str, cap: int) -> list:
    """Pure retention rule: (date_key, item) pairs -> the current period's.

    Keeps keys >= floor (today by default), newest first, capped. When nothing
    qualifies, returns the single newest so a fire with maps is never empty.
    """
    ordered = sorted(dated, key=lambda ke: ke[0], reverse=True)
    current = [ke for ke in ordered if ke[0] >= floor]
    return current[:cap] if current else ordered[:1]


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
    lm: str | None = None     # upstream FTP Last-Modified (RFC 1123) = upload time
    first_seen: str | None = None  # ISO of our first successful mirror of this file


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
        self._tmp = self.work_dir  # per incident, set by sync_incident
        self.max_file_bytes = int(max_file_mb * 1024 * 1024) if max_file_mb else None
        self.max_files = max_files
        self.products_keep = products_keep
        self.ir_keep = ir_keep
        self.since = since  # YYYYMMDD: backfill floor for Products dailies
        self.force = force

    # ------------------------------------------------------------------
    def sync_incident(self, *, incident_key: str, dir_url: str, match: dict,
                      cornea_id: str | None, bound: dict | None,
                      dir_mtime: str | None, region: str | None = None) -> MirrorResult:
        """Mirror one incident folder under the record bound to `cornea_id`.

        A new record gets its own storage prefix; an existing one must
        already be bound to this fire (the caller rebinds first) and keeps
        its fire_slug and storage_prefix.
        """
        res = MirrorResult()
        inc_state = bind_record(self.state, incident_key, cornea_id=cornea_id,
                                match=match, bound=bound, region=region)
        # downloads land in a folder of their own per incident, so two
        # folders sharing a file path never share a temp file
        self._tmp = self.work_dir / hashlib.sha1(incident_key.encode()).hexdigest()[:12]

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
                    self._replay_cached(inc_state, "products/", res)
                else:
                    self._sync_products(child, inc_state, res)
            elif cname.lower() == "qr":
                if unchanged:
                    res.skipped_unchanged += 1
                    self._replay_cached(inc_state, "qr/", res)
                else:
                    self._sync_flat(child, inc_state, "qr", "qr", res)
            elif cname.lower() == "ir":
                if unchanged:
                    res.skipped_unchanged += 1
                    self._replay_cached(inc_state, "ir/", res)
                else:
                    self._sync_ir(child, inc_state, res)
            else:
                continue  # unknown subfolder — not a known container
            saw_known_child = True
            inc_state["children"][cname] = child.mtime

        if not saw_known_child:
            # No Products/GIS/QR/IR at all: the incident dir IS the products
            # container, with dated dirs (and sometimes loose files) at its root
            # — e.g. 2026_BigGrass/20260817/. Without this the whole incident
            # mirrored as zero files.
            self._sync_dailies(children, inc_state, res)
            for e in children:
                if not e.is_dir:
                    self._file(e, inc_state, "products/current", "product", res)

        inc_state["dir_mtime"] = dir_mtime
        inc_state["synced_at"] = now_iso()
        return res

    # ------------------------------------------------------------------
    def _replay_cached(self, inc_state: dict, rel_prefix: str, res: MirrorResult) -> None:
        """Subtree unchanged: emit records from state without any requests,
        keyed where each file's bytes are."""
        for rel, meta in inc_state["files"].items():
            if rel.startswith(rel_prefix) and not meta.get("pruned_at"):
                res.files.append(replay_file(inc_state, rel, meta))

    def _sync_products(self, child: Entry, inc_state: dict, res: MirrorResult) -> None:
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
                self._file(e, inc_state, "products/current", "product", res)

        # (b) daily dirs directly in Products/
        self._sync_dailies(entries, inc_state, res)

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
                    self._file(e, inc_state, rel, "product", res)
            self._sync_dailies(sub_entries, inc_state, res)

    def _dated_floor(self) -> str:
        """Oldest dated folder worth mirroring: today, unless --since overrides."""
        return self.since or datetime.now(timezone.utc).strftime("%Y%m%d")

    def _select_current(self, dated: list[tuple[str, Entry]], cap: int
                        ) -> list[tuple[str, Entry]]:
        """Dated entries at or after the floor, newest first, capped.

        Everything older is skipped — history is not backfilled. Folders dated
        in the FUTURE qualify: an evening publish for tomorrow's operational
        period is precisely what a responder deploying tomorrow needs.
        Fallback: if NOTHING is dated today-or-later (a quiet fire, or a period
        that has not published yet) take the single newest, so an incident with
        maps never presents an empty list. That is one folder, not a backfill.
        """
        return select_current_period(dated, self._dated_floor(), cap)

    def _select_dated(self, entries: list[Entry], cap: int) -> list[tuple[str, Entry]]:
        keyed = [(_daily_key(e.name), e) for e in entries if e.is_dir]
        return self._select_current([(k, e) for k, e in keyed if k], cap)

    def _sync_dailies(self, entries: list[Entry], inc_state: dict, res: MirrorResult) -> None:
        """Current-period dated dirs, keyed by normalized YYYYMMDD."""
        for key, daily in self._select_dated(entries, self.products_keep):
            # B2 path uses the NORMALIZED key so 07282026 and 20260728 land in
            # one place and manifest op_date parsing stays uniform.
            self._sync_flat(daily, inc_state, f"products/{key}", "product", res)

    def _sync_ir(self, child: Entry, inc_state: dict, res: MirrorResult) -> None:
        entries = list_dir(self.client, child.url)
        res.listings += 1
        # IR flight dirs carry suffixes (20260817_UTF_Weather), so key on the
        # leading date rather than the whole name.
        keyed = [(_daily_key(e.name[:8]), e) for e in entries if e.is_dir]
        for _, sub in self._select_current(
                [(k, e) for k, e in keyed if k], self.ir_keep):
            self._sync_flat(sub, inc_state, f"ir/{sub.name}", "ir", res)
        if not any(e.is_dir for e in entries):
            # some incidents keep flight files directly under IR/
            for e in entries:
                if not e.is_dir:
                    self._file(e, inc_state, "ir", "ir", res)

    def _sync_flat(self, dir_entry: Entry, inc_state: dict, rel_dir: str, kind: str,
                   res: MirrorResult) -> None:
        entries = list_dir(self.client, dir_entry.url)
        res.listings += 1
        for e in entries:
            if e.is_dir:
                continue
            self._file(e, inc_state, rel_dir, kind, res)

    # ------------------------------------------------------------------
    def _file(self, e: Entry, inc_state: dict, rel_dir: str, kind: str,
              res: MirrorResult) -> None:
        if self.max_files is not None and res.downloads >= self.max_files:
            return
        filename = _safe_name(e.name)
        rel = f"{rel_dir}/{filename}"
        meta = inc_state["files"].get(rel, {})
        if meta.get("pruned_at"):
            return  # deleted by prune: never fetched again
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
                kind=meta.get("kind", fkind), filename=filename,
                key=raw_key(inc_state, rel), url=e.url,
                size=meta.get("size"), sha16=meta.get("sha16"),
                rev=meta.get("rev", 1), local_path=None, changed=False,
                rel_dir=rel_dir, lm=meta.get("lm"), first_seen=meta.get("first_seen"),
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

        # New bytes always go under the record's own prefix: a file stamped
        # elsewhere (files[rel].prefix) moves home and loses the stamp.
        key = new_raw_key(inc_state, rel)
        local = self._tmp / rel
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_bytes(body)
        self.storage.put_file(key, local)

        first_seen = meta.get("first_seen") or _now_iso()
        inc_state["files"][rel] = {
            "etag": resp.headers.get("etag"),
            "lm": resp.headers.get("last-modified"),
            "size": len(body),
            "sha16": sha,
            "rev": max(rev, 1),
            "kind": fkind,
            "url": e.url,
            "first_seen": first_seen,
            # an owner stamp carries over for the same bytes, or when the
            # file name itself (or an operator) proved the owner
            **revision_stamp(meta, sha),
        }
        res.downloads += 1
        res.bytes_downloaded += len(body)
        res.files.append(MirroredFile(
            kind=fkind, filename=filename, key=key, url=e.url, size=len(body),
            sha16=sha, rev=max(rev, 1), local_path=local, changed=changed,
            rel_dir=rel_dir, lm=resp.headers.get("last-modified"),
            first_seen=first_seen,
        ))
