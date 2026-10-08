"""Where an incident folder's objects live on the bucket.

Every key used to be built from the record's fire_slug. A slug is only a
name, shared and swapped between fires, so one record's bytes can sit under
a prefix another record writes to, or under a slug the record no longer
carries. The fire-ID migration gives each record its own `storage_prefix`
(where NEW bytes go) and stamps the exceptions where they are:
`files[rel].prefix` for a raw file, `tiled[sha].prefix` / `preview_prefix`
for a sheet's tiles and preview, `ir_keys[src_rel]` for an IR conversion.

All incident keys are built here. With no stamps and no storage_prefix
(state before the migration) every function returns exactly the old key.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable
from pathlib import Path

from . import ir_vectors


def record_prefix(rec: dict) -> str:
    """Where this record writes new bytes."""
    return rec.get("storage_prefix") or rec["fire_slug"]


def file_location(rec: dict, rel: str) -> str:
    """The prefix that holds this file's bytes now."""
    return ((rec.get("files") or {}).get(rel) or {}).get("prefix") or record_prefix(rec)


def raw_key(rec: dict, rel: str) -> str:
    """Where the file's bytes ARE."""
    return f"raw/incidents/{file_location(rec, rel)}/{rel}"


def new_raw_key(rec: dict, rel: str) -> str:
    """Where a new revision of the file goes."""
    return f"raw/incidents/{record_prefix(rec)}/{rel}"


def new_storage_prefix(state: dict, fk: str, inc_key: str) -> str:
    """A prefix no other record uses: the fire key, or the fire key plus a
    hash of the folder's key when another folder of that fire has it.

    Prefixes that still hold stamped files count as taken too, so a new
    record never writes into a namespace where another record's bytes live.
    """
    taken: set[str] = set()
    for r in state["incidents"].values():
        if r.get("fire_slug") or r.get("storage_prefix"):
            taken.add(record_prefix(r))
        taken.update(m["prefix"] for m in (r.get("files") or {}).values()
                     if m.get("prefix"))
    if fk not in taken:
        return fk
    return f"{fk}-{hashlib.sha1(inc_key.encode()).hexdigest()[:6]}"


def tiles_prefix(state: dict, sha: str, rec: dict) -> str:
    return (state["tiled"].get(sha) or {}).get("prefix") or record_prefix(rec)


def preview_prefix(state: dict, sha: str, rec: dict) -> str:
    t = state["tiled"].get(sha) or {}
    return t.get("preview_prefix") or t.get("prefix") or record_prefix(rec)


def _require_sha(sha: str | None) -> str:
    # Tiles, previews and vectors are keyed by content; a file we never
    # hashed must not get (or overwrite) one.
    if not sha:
        raise ValueError("a file with no sha16 never gets a tile, preview or vector key")
    return sha


def tile_root(prefix: str, sha: str) -> str:
    return f"tiles/incidents/{prefix}/{_require_sha(sha)}"


def tile_meta_key(prefix: str, sha: str) -> str:
    """Completion marker a stateless tile worker writes LAST: its existence
    means the full tile tree for this sheet is on the bucket."""
    return f"{tile_root(prefix, sha)}/meta.json"


def preview_key(state: dict, sha: str, rec: dict) -> str:
    return f"previews/incidents/{preview_prefix(state, _require_sha(sha), rec)}/{sha}.png"


def put_tiled(state: dict, sha: str, prefix: str, entry: dict) -> None:
    """The only writer of state["tiled"][sha]. A sha's tiles stay where they
    were first written: an existing prefix (and preview_prefix) carries
    over, and `prefix` (the writing record's) is used only for a new sha."""
    tiled = state.setdefault("tiled", {})
    prev = tiled.get(_require_sha(sha)) or {}
    out = dict(entry)
    out["prefix"] = prev.get("prefix") or prefix
    if prev.get("preview_prefix"):
        out["preview_prefix"] = prev["preview_prefix"]
    tiled[sha] = out


def sha16_file(path: Path) -> str:
    """sha256 hex[:16] of a file, streamed (matches the mirror's sha16)."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def raw_key_candidates(state: dict, sha: str | None) -> list[str]:
    """raw_key of every file holding `sha`, in state order, once each.
    Pruned files are skipped (their bytes are gone)."""
    if not sha:
        return []
    out: list[str] = []
    for rec in state["incidents"].values():
        if not (rec.get("storage_prefix") or rec.get("fire_slug")):
            continue
        for rel, meta in (rec.get("files") or {}).items():
            if meta.get("sha16") == sha and not meta.get("pruned_at"):
                out.append(raw_key(rec, rel))
    return list(dict.fromkeys(out))


def fetch_verified(storage, keys: Iterable[str], sha16: str | None, dest: Path,
                   log=print, *, mismatches: list[str] | None = None) -> str | None:
    """Download into `dest` the first of `keys` whose bytes hash to `sha16`
    and return that key; None when no key verifies (dest is then removed).

    Two records could write one key with different bytes while prefixes
    were shared, so bytes are never trusted by key alone before tiles, a
    preview or vectors are written under their sha. A mismatch is logged,
    added to `mismatches` (the caller's health count) and the next key tried.
    """
    dest = Path(dest)
    if not sha16:
        return None
    for key in keys:
        if not storage.get_file(key, dest):
            continue
        if sha16_file(dest) == sha16:
            return key
        log(f"raw_sha_mismatch {key}")
        if mismatches is not None:
            mismatches.append(key)
        dest.unlink(missing_ok=True)
    dest.unlink(missing_ok=True)
    return None


def ir_entry(rec: dict, src_rel: str, src_meta: dict) -> dict | None:
    """The conversion stamped for this IR source file, valid only while the
    source still has the same bytes."""
    e = (rec.get("ir_keys") or {}).get(src_rel)
    sha = (src_meta or {}).get("sha16")
    return e if e and sha and e.get("src_sha16") == sha else None


def stamp_ir(rec: dict, src_rel: str, key: str, flight_id: str, src_sha16: str) -> None:
    rec.setdefault("ir_keys", {})[src_rel] = {
        "key": key, "flight_id": flight_id, "src_sha16": src_sha16}


def new_ir_key(rec: dict, src_meta: dict) -> str:
    """Content-addressed and versioned, so a key is never rewritten: a new
    source or a converter bump gets a new key."""
    sha = _require_sha((src_meta or {}).get("sha16"))
    return f"vectors/ir/{record_prefix(rec)}/{sha}.v{ir_vectors.IR_CONVERTER_VERSION}.geojson"


def replay_file(rec: dict, rel: str, meta: dict):
    """A MirroredFile for a file already in state (no request, no local
    copy), keyed where its bytes are."""
    from .mirror import MirroredFile  # mirror builds its keys through this module

    rel_dir, _, filename = rel.rpartition("/")
    top = rel.split("/", 1)[0]
    return MirroredFile(
        kind=meta.get("kind", {"products": "product"}.get(top, top)),
        filename=filename, key=raw_key(rec, rel), url=meta.get("url", ""),
        size=meta.get("size"), sha16=meta.get("sha16"), rev=meta.get("rev", 1),
        local_path=None, changed=False, rel_dir=rel_dir,
        lm=meta.get("lm"), first_seen=meta.get("first_seen"),
    )
