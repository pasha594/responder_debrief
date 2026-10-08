"""Where incident objects really are on the bucket: one LIST pass over
raw/, previews/, tiles/ and vectors/, and the locate rules on top of it.
Shared by the incident-ID migration (step C) and the key audit.

Before fire IDs every key was built from a record's current fire_slug, but
bytes stayed where they were first written: a folder re-bound to another
fire keeps its earlier files under the earlier slug, and a sheet held by
two folders was tiled once, under whichever came first. Locating stamps the
real location in state (files[rel].prefix, tiled[sha].prefix and
preview_prefix). A raw file found under another prefix counts only when its
bytes hash to the file's sha16.
"""

from __future__ import annotations

import re
import tempfile
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

from .asset_keys import fetch_verified, file_location, raw_key, record_prefix

RAW = "raw/incidents/"
PREVIEWS = "previews/incidents/"
TILES = "tiles/incidents/"
VECTORS = "vectors/ir/"

_TILE_URL = re.compile(r"^/tiles/incidents/([^/]+)/([^/]+)/")
_PREVIEW_URL = re.compile(r"^/previews/incidents/([^/]+)/([^/]+)\.png$")


@dataclass
class Listings:
    raw: dict[str, int] = field(default_factory=dict)                     # key -> size
    raw_by_rel: dict[str, list[tuple[str, int]]] = field(default_factory=dict)  # rel -> [(prefix, size)]
    previews: dict[str, set[str]] = field(default_factory=dict)           # sha -> prefixes
    tiles: dict[str, set[str]] = field(default_factory=dict)              # sha -> prefixes
    vectors: set[str] = field(default_factory=set)

    def url_exists(self, url: str) -> bool:
        """Whether a manifest URL ('/raw/…', '/previews/…', a tiles
        url_template, '/vectors/…') names an object these listings hold."""
        key = url.lstrip("/")
        if key.startswith(RAW):
            return key in self.raw
        if m := _TILE_URL.match(url):
            return m[1] in self.tiles.get(m[2], ())
        if m := _PREVIEW_URL.match(url):
            return m[1] in self.previews.get(m[2], ())
        if key.startswith(VECTORS):
            return key in self.vectors
        return False


def list_assets(storage, log=print) -> Listings:
    """LIST every incident object once (tiles by folder: a sheet's tile
    tree is thousands of keys)."""
    out = Listings()
    for key, size in storage.list_keys(RAW):
        prefix, _, rel = key[len(RAW):].partition("/")
        if rel:
            out.raw[key] = size
            out.raw_by_rel.setdefault(rel, []).append((prefix, size))
    for key, _size in storage.list_keys(PREVIEWS):
        prefix, _, name = key[len(PREVIEWS):].partition("/")
        if name.endswith(".png") and "/" not in name:
            out.previews.setdefault(name[:-4], set()).add(prefix)
    for prefix in storage.list_dirs(TILES):
        for sha in storage.list_dirs(f"{TILES}{prefix}/"):
            out.tiles.setdefault(sha, set()).add(prefix)
    out.vectors = {key for key, _size in storage.list_keys(VECTORS)}
    log(f"[locate] listed {len(out.raw)} raw, {len(out.previews)} previewed and "
        f"{len(out.tiles)} tiled shas, {len(out.vectors)} vectors")
    return out


def _records(state: dict):
    for inc_key, rec in (state.get("incidents") or {}).items():
        if rec.get("storage_prefix") or rec.get("fire_slug"):
            yield inc_key, rec


def raw_candidates(listings: Listings, rel: str, size: int | None, *, exclude: str,
                   prefer: Iterable[str] = ()) -> list[str]:
    """Other prefixes holding `rel` with the expected size: `prefer` (in its
    order) first, then alphabetical."""
    found = {p for p, s in listings.raw_by_rel.get(rel, ())
             if p != exclude and (size is None or s == size)}
    return [p for p in dict.fromkeys(prefer) if p in found] + sorted(found - set(prefer))


def set_file_location(rec: dict, rel: str, prefix: str) -> None:
    meta = rec["files"][rel]
    if prefix == record_prefix(rec):
        meta.pop("prefix", None)
    else:
        meta["prefix"] = prefix


def locate_raw(storage, state: dict, listings: Listings, *, prefer: dict | None = None,
               stamp: bool = True, log=print) -> dict:
    """Check every file's raw key against the listing. A file absent there
    is looked for under every other prefix with the same rel and size
    (`prefer[inc_key]` first): each candidate is downloaded and hashed, and
    the first whose bytes hash to the file's sha16 is its location
    (stamped unless `stamp` is False). Pruned files are skipped.

    Returns {ok, relocated: {prefix: n}, missing: [...], raw_size_mismatch:
    [...], sha_mismatch: [keys]}; a file at its key with another size is
    only reported."""
    prefer = prefer or {}
    rep: dict = {"ok": 0, "relocated": {}, "missing": [], "raw_size_mismatch": [],
                 "sha_mismatch": []}
    with tempfile.TemporaryDirectory(prefix="locate_") as td:
        dest = Path(td) / "raw"
        for inc_key, rec in _records(state):
            for rel, meta in (rec.get("files") or {}).items():
                if meta.get("pruned_at"):
                    continue
                key = raw_key(rec, rel)
                size = listings.raw.get(key)
                if size is not None:
                    if meta.get("size") is not None and size != meta["size"]:
                        rep["raw_size_mismatch"].append({"key": inc_key, "rel": rel, "at": key,
                                                         "size": size, "expected": meta["size"]})
                    else:
                        rep["ok"] += 1
                    continue
                found = None
                for q in raw_candidates(listings, rel, meta.get("size"),
                                        exclude=file_location(rec, rel),
                                        prefer=prefer.get(inc_key, ())):
                    if fetch_verified(storage, [f"{RAW}{q}/{rel}"], meta.get("sha16"), dest,
                                      log, mismatches=rep["sha_mismatch"]):
                        found = q
                        break
                if found is None:
                    rep["missing"].append({"key": inc_key, "rel": rel, "sha16": meta.get("sha16")})
                    continue
                rep["relocated"][found] = rep["relocated"].get(found, 0) + 1
                if stamp:
                    set_file_location(rec, rel, found)
    return rep


def sha_holders(state: dict) -> dict[str, list[tuple[str, str]]]:
    """sha16 -> (incident key, file location) of every file holding it, in
    state order. Pruned files hold nothing."""
    out: dict[str, list[tuple[str, str]]] = {}
    for key, rec in _records(state):
        for rel, meta in (rec.get("files") or {}).items():
            if meta.get("sha16") and not meta.get("pruned_at"):
                out.setdefault(meta["sha16"], []).append((key, file_location(rec, rel)))
    return out


def choose_copy(found: set[str], live: set[str], holders: Iterable[str]) -> list[str]:
    """The copies of one sha's tiles (or preview) in preference order: the
    ones today's manifests already link, else the ones under a holder's
    location, else all, alphabetically. Any copy is the same content."""
    if hit := sorted(found & live):
        return hit
    if hit := [p for p in dict.fromkeys(holders) if p in found]:
        return hit
    return sorted(found)


def live_copies(manifests: Iterable[dict]) -> tuple[dict[str, set[str]], dict[str, set[str]]]:
    """(tiles, previews): sha -> the prefixes published manifests link."""
    tiles: dict[str, set[str]] = {}
    previews: dict[str, set[str]] = {}
    for man in manifests:
        for m in man.get("maps") or []:
            if t := _TILE_URL.match(((m.get("tiles") or {}).get("url_template")) or ""):
                tiles.setdefault(t[2], set()).add(t[1])
            if p := _PREVIEW_URL.match(m.get("preview_url") or ""):
                previews.setdefault(p[2], set()).add(p[1])
        for f in man.get("ir_flights") or []:
            if p := _PREVIEW_URL.match(f.get("preview_url") or ""):
                previews.setdefault(p[2], set()).add(p[1])
    return tiles, previews


def locate_shas(state: dict, listings: Listings, live_tiles: dict, live_previews: dict,
                *, baseline: dict[str, str] | None = None, stamp: bool = True) -> dict:
    """Stamp tiled[sha].prefix (and preview_prefix when the preview is
    elsewhere) for every sha a file holds and no stamp places yet, from the
    copies the listings hold (choose_copy). A sha with no copy anywhere is
    left unstamped; one whose geo claims a copy is reported missing.
    `relocated` counts copies away from where the first holder's URLs
    pointed: `baseline[inc_key]` (the migration passes the legacy slugs),
    else its record prefix."""
    holders = sha_holders(state)
    incidents = state.get("incidents") or {}
    rep = {kind: {"found": 0, "relocated": {}, "missing": []} for kind in ("tiles", "previews")}
    for sha, entry in (state.get("tiled") or {}).items():
        if sha not in holders or entry.get("prefix"):
            continue
        locs = [loc for _key, loc in holders[sha]]
        first = holders[sha][0][0]
        fallback = (baseline or {}).get(first) or record_prefix(incidents[first])
        geo = entry.get("geo") or {}
        t = choose_copy(listings.tiles.get(sha, set()), live_tiles.get(sha, set()), locs)
        v = choose_copy(listings.previews.get(sha, set()), live_previews.get(sha, set()), locs)
        for kind, copies, claimed in (("tiles", t, geo.get("tiles")),
                                      ("previews", v, geo.get("preview"))):
            if copies:
                rep[kind]["found"] += 1
                if copies[0] != fallback:
                    rep[kind]["relocated"][copies[0]] = rep[kind]["relocated"].get(copies[0], 0) + 1
            elif claimed:
                rep[kind]["missing"].append(sha)
        prefix = (t or v or [None])[0]
        if stamp and prefix:
            entry["prefix"] = prefix
            if v and v[0] != prefix:
                entry["preview_prefix"] = v[0]
    return rep


def ir_objects(state: dict, listings: Listings) -> dict:
    """IR conversions recorded as failed, and recorded conversions (or
    stamped keys) whose object is not on the bucket. Report only."""
    ir = state.get("ir") or {}
    failed = sorted(k for k, e in ir.items() if (e or {}).get("failed"))
    keys = {k for k, e in ir.items() if (e or {}).get("heat_types")}
    for _key, rec in _records(state):
        keys.update(e["key"] for e in (rec.get("ir_keys") or {}).values() if e.get("key"))
    return {"failed": failed, "missing_objects": sorted(k for k in keys if k not in listings.vectors)}
