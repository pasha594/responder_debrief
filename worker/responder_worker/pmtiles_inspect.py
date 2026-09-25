"""PMTiles v3 reader for sanity checks (pure stdlib).

GDAL 3.8.4 -- the runner's version -- must never read a PMTiles back (it
rejects some valid archives; GDAL #9288, fixed in 3.8.5), so the trails build
and the per-fire bundles verify their archives here instead: header fields,
per-zoom tile counts and sizes, and the MVT layer names of a sampled tile.

    python -m responder_worker.pmtiles_inspect some.pmtiles
"""

from __future__ import annotations

import gzip
import json
import struct
import sys
from pathlib import Path

HEADER_LEN = 127
COMPRESSION = {0: "unknown", 1: "none", 2: "gzip", 3: "brotli", 4: "zstd"}
TILE_TYPE = {0: "unknown", 1: "mvt", 2: "png", 3: "jpeg", 4: "webp", 5: "avif"}


class PMTilesError(ValueError):
    pass


def _varint(buf: bytes, pos: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, pos
        shift += 7


def parse_header(b: bytes) -> dict:
    if len(b) < HEADER_LEN or b[:7] != b"PMTiles":
        raise PMTilesError("not a PMTiles archive (bad magic)")
    if b[7] != 3:
        raise PMTilesError(f"unsupported PMTiles version {b[7]}")
    q = struct.unpack_from("<11Q", b, 8)
    names = ["root_offset", "root_length", "metadata_offset", "metadata_length",
             "leaf_offset", "leaf_length", "data_offset", "data_length",
             "addressed_tiles", "tile_entries", "tile_contents"]
    h = dict(zip(names, q))
    h["clustered"] = b[96] == 1
    h["internal_compression"] = COMPRESSION.get(b[97], str(b[97]))
    h["tile_compression"] = COMPRESSION.get(b[98], str(b[98]))
    h["tile_type"] = TILE_TYPE.get(b[99], str(b[99]))
    h["min_zoom"], h["max_zoom"] = b[100], b[101]
    mnlon, mnlat, mxlon, mxlat = struct.unpack_from("<4i", b, 102)
    h["bounds"] = [mnlon / 1e7, mnlat / 1e7, mxlon / 1e7, mxlat / 1e7]
    h["center_zoom"] = b[118]
    clon, clat = struct.unpack_from("<2i", b, 119)
    h["center"] = [clon / 1e7, clat / 1e7]
    return h


def _decompress(data: bytes, how: str) -> bytes:
    if how == "gzip":
        return gzip.decompress(data)
    if how in ("none", "unknown"):
        return data
    raise PMTilesError(f"unsupported compression {how}")


def parse_directory(data: bytes) -> list[tuple[int, int, int, int]]:
    """-> [(tile_id, offset, length, run_length)], run_length 0 = leaf pointer."""
    pos = 0
    n, pos = _varint(data, pos)
    ids, runs, lens, offs = [], [], [], []
    last = 0
    for _ in range(n):
        d, pos = _varint(data, pos)
        last += d
        ids.append(last)
    for _ in range(n):
        v, pos = _varint(data, pos)
        runs.append(v)
    for _ in range(n):
        v, pos = _varint(data, pos)
        lens.append(v)
    for i in range(n):
        v, pos = _varint(data, pos)
        if v == 0 and i > 0:
            offs.append(offs[i - 1] + lens[i - 1])
        else:
            offs.append(v - 1)
    return list(zip(ids, offs, lens, runs))


def zoom_of_tile_id(tile_id: int) -> int:
    z, acc = 0, 0
    while True:
        n = 1 << (2 * z)
        if tile_id < acc + n:
            return z
        acc += n
        z += 1


def mvt_layer_names(tile: bytes) -> list[str]:
    """Names of the layers in an (uncompressed) MVT tile."""
    out: list[str] = []
    pos = 0
    while pos < len(tile):
        key, pos = _varint(tile, pos)
        field, wire = key >> 3, key & 7
        if wire == 2:
            ln, pos = _varint(tile, pos)
            body = tile[pos:pos + ln]
            pos += ln
            if field == 3:  # Tile.layers
                p = 0
                while p < len(body):
                    k, p = _varint(body, p)
                    if k & 7 == 2:
                        l2, p = _varint(body, p)
                        if k >> 3 == 1:
                            out.append(body[p:p + l2].decode("utf-8", "replace"))
                            break
                        p += l2
                    elif k & 7 == 0:
                        _, p = _varint(body, p)
                    elif k & 7 == 5:
                        p += 4
                    elif k & 7 == 1:
                        p += 8
                    else:
                        break
        elif wire == 0:
            _, pos = _varint(tile, pos)
        elif wire == 5:
            pos += 4
        elif wire == 1:
            pos += 8
        else:
            break
    return out


def summarize(path: Path) -> dict:
    """Header + per-zoom counts/max bytes + a sampled max-zoom tile's layers."""
    data = Path(path).read_bytes()
    h = parse_header(data)
    comp = h["internal_compression"]
    by_zoom: dict[int, dict] = {}
    sample: tuple[int, int] | None = None

    def walk(offset: int, length: int, depth: int) -> None:
        nonlocal sample
        if depth > 4:
            raise PMTilesError("directory nesting too deep")
        for tid, off, ln, run in parse_directory(_decompress(data[offset:offset + length], comp)):
            if run == 0:
                walk(h["leaf_offset"] + off, ln, depth + 1)
                continue
            for t in range(tid, tid + run):
                z = zoom_of_tile_id(t)
                zs = by_zoom.setdefault(z, {"tiles": 0, "max_bytes": 0})
                zs["tiles"] += 1
                zs["max_bytes"] = max(zs["max_bytes"], ln)
            if zoom_of_tile_id(tid) == h["max_zoom"] and sample is None:
                sample = (h["data_offset"] + off, ln)

    walk(h["root_offset"], h["root_length"], 0)
    layers: list[str] = []
    if sample and h["tile_type"] == "mvt":
        tile = _decompress(data[sample[0]:sample[0] + sample[1]], h["tile_compression"])
        layers = mvt_layer_names(tile)
    meta = {}
    if h["metadata_length"]:
        try:
            meta = json.loads(_decompress(
                data[h["metadata_offset"]:h["metadata_offset"] + h["metadata_length"]], comp))
        except ValueError:
            meta = {}
    return {
        "bytes": len(data),
        "header": h,
        "tiles": sum(z["tiles"] for z in by_zoom.values()),
        "by_zoom": {str(z): by_zoom[z] for z in sorted(by_zoom)},
        "max_tile_bytes": max((z["max_bytes"] for z in by_zoom.values()), default=0),
        "sample_layers": layers,
        "metadata_layers": [v.get("id") for v in meta.get("vector_layers", [])],
    }


def check(summary: dict, *, min_zoom: int, max_zoom: int, layer: str,
          min_tiles: int = 1) -> list[str]:
    """Problems that must stop a publish (empty list = OK)."""
    h = summary["header"]
    problems = []
    if not h["clustered"]:
        problems.append("archive not clustered")
    if h["tile_type"] != "mvt":
        problems.append(f"tile type {h['tile_type']}")
    if (h["min_zoom"], h["max_zoom"]) != (min_zoom, max_zoom):
        problems.append(f"zooms {h['min_zoom']}-{h['max_zoom']} != {min_zoom}-{max_zoom}")
    if summary["tiles"] < min_tiles:
        problems.append(f"only {summary['tiles']} tiles")
    if layer not in summary["sample_layers"] and layer not in summary["metadata_layers"]:
        problems.append(f"layer {layer!r} missing")
    return problems


if __name__ == "__main__":
    print(json.dumps(summarize(Path(sys.argv[1])), indent=1))
