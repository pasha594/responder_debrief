"""Apache autoindex parser for ftp.wildfire.gov listing pages.

Listing pages are dynamic HTML (no validators) but expose child names,
last-modified stamps, and size hints — enough for change-driven descent.
"""

from __future__ import annotations

import re
import time
import urllib.parse
from dataclasses import dataclass, field

import httpx

from . import config
from .http import get

_ROW_RE = re.compile(
    r'<tr>.*?<a href="(?P<href>[^"]+)">.*?</a></td>'
    r'\s*<td[^>]*>\s*(?P<mtime>\d{4}-\d{2}-\d{2} \d{2}:\d{2}|&nbsp;|-)?\s*</td>'
    r'\s*<td[^>]*>\s*(?P<size>[^<]*?)\s*</td>',
    re.S,
)

_SIZE_MULT = {"": 1, "K": 1024, "M": 1024**2, "G": 1024**3, "T": 1024**4}


@dataclass
class Entry:
    name: str          # URL-decoded, no trailing slash
    href: str          # raw href as listed
    url: str           # absolute URL
    mtime: str | None  # "YYYY-MM-DD HH:MM" or None
    is_dir: bool
    size_hint: int | None = None
    extra: dict = field(default_factory=dict)


def parse_size_hint(text: str) -> int | None:
    text = text.strip()
    if not text or text in ("-", "&nbsp;"):
        return None
    m = re.fullmatch(r"([\d.]+)\s*([KMGT]?)", text)
    if not m:
        return None
    return int(float(m.group(1)) * _SIZE_MULT[m.group(2)])


def parse_autoindex(html: str, base_url: str) -> list[Entry]:
    if not base_url.endswith("/"):
        base_url += "/"
    entries: list[Entry] = []
    for m in _ROW_RE.finditer(html):
        href = m.group("href")
        # skip sort links (?C=N;O=D) and the parent-directory row
        if href.startswith("?") or href.startswith("/") or href.startswith(".."):
            continue
        is_dir = href.endswith("/")
        name = urllib.parse.unquote(href.rstrip("/"))
        mtime = m.group("mtime")
        if mtime in ("&nbsp;", "-", None):
            mtime = None
        entries.append(
            Entry(
                name=name,
                href=href,
                url=urllib.parse.urljoin(base_url, href),
                mtime=mtime,
                is_dir=is_dir,
                size_hint=parse_size_hint(m.group("size") or ""),
            )
        )
    return entries


def list_dir(client: httpx.Client, url: str, *, delay: float | None = None) -> list[Entry]:
    """Fetch and parse one autoindex page (politely rate-limited)."""
    time.sleep(config.LISTING_DELAY_S if delay is None else delay)
    resp = get(client, url)
    return parse_autoindex(resp.text, str(resp.url))
