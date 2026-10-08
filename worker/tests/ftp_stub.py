"""A tiny FTP for the mirror tests: a tree of autoindex listings and files,
served through the functions sync-incidents and the mirror call
(get_optional for region roots, list_dir, get), with every request logged.
Files answer conditional GETs the way the real server does: 304 when the
etag or Last-Modified sent still match."""

from __future__ import annotations

import hashlib
from types import SimpleNamespace

from responder_worker import cli, mirror
from responder_worker.ftp_index import Entry

BASE = "https://ftp.wildfire.gov/public/incident_specific_maps"
LM = "Thu, 08 Oct 2026 05:00:00 GMT"


class FakeFTP:
    def __init__(self):
        self.dirs: dict[str, list[Entry]] = {}
        self.files: dict[str, tuple[bytes, str]] = {}   # url -> (bytes, Last-Modified)
        self.requests: list[tuple] = []

    # -- building ----------------------------------------------------------

    def dir(self, parent: str, name: str, mtime: str = "2026-10-08 05:00") -> str:
        """Add a subfolder to `parent` (created if new); returns its URL."""
        url = f"{parent.rstrip('/')}/{name}/"
        self.dirs.setdefault(parent, []).append(
            Entry(name=name, href=f"{name}/", url=url, mtime=mtime, is_dir=True))
        self.dirs.setdefault(url, [])
        return url

    def file(self, parent: str, name: str, data: bytes, lm: str = LM,
             mtime: str = "2026-10-08 05:00") -> str:
        url = f"{parent.rstrip('/')}/{name}"
        self.dirs.setdefault(parent, []).append(
            Entry(name=name, href=name, url=url, mtime=mtime, is_dir=False,
                  size_hint=len(data)))
        self.files[url] = (data, lm)
        return url

    # -- serving -------------------------------------------------------------

    def autoindex(self, url: str) -> str:
        rows = "".join(f'<tr><td><a href="{e.href}">{e.href}</a></td>'
                       f'<td align="right">{e.mtime or "-"}</td><td align="right">-</td></tr>'
                       for e in self.dirs[url])
        return f"<table>{rows}</table>"

    def get_optional(self, client, url, **kw):
        self.requests.append(("root", url))
        return SimpleNamespace(text=self.autoindex(url)) if url in self.dirs else None

    def list_dir(self, client, url, **kw):
        self.requests.append(("list", url))
        return list(self.dirs[url])

    def get(self, client, url, headers=None, **kw):
        headers = headers or {}
        self.requests.append(("get", url, dict(headers)))
        data, lm = self.files[url]
        etag = '"' + hashlib.sha256(data).hexdigest()[:12] + '"'
        if headers.get("If-None-Match") == etag or headers.get("If-Modified-Since") == lm:
            return SimpleNamespace(status_code=304, content=b"", headers={})
        return SimpleNamespace(status_code=200, content=data,
                               headers={"etag": etag, "last-modified": lm})

    def gets(self) -> list[str]:
        return [r[1] for r in self.requests if r[0] == "get"]

    def wire(self, monkeypatch) -> "FakeFTP":
        monkeypatch.setattr(cli, "get_optional", self.get_optional)
        monkeypatch.setattr(cli, "list_dir", self.list_dir)
        monkeypatch.setattr(mirror, "list_dir", self.list_dir)
        monkeypatch.setattr(mirror, "get", self.get)
        return self
