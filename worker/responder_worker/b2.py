"""Storage backends: real B2 (S3-compatible via boto3) and dry-run local files.

Dry-run mirrors the exact B2 key layout under a local out/ directory, so the
whole worker runs end-to-end with zero secrets.
"""

from __future__ import annotations

import json
import shutil
import time
from collections.abc import Iterable, Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import config

#: S3 DeleteObjects takes at most this many keys per request.
DELETE_BATCH = 1000


def _dir_prefix(prefix: str) -> str:
    """A listing prefix for list_dirs: '' (the root) or ending in '/'."""
    return prefix if not prefix or prefix.endswith("/") else prefix + "/"


class Storage:
    """Interface: put_bytes/put_file/put_json/exists/exists_strict/get_json/
    get_file, list_keys/list_dirs, delete_prefix/delete_keys."""

    def put_bytes(self, key: str, data: bytes, *, content_type: str | None = None,
                  cache_control: str | None = None) -> None:
        raise NotImplementedError

    def put_file(self, key: str, path: Path, *, content_type: str | None = None,
                 cache_control: str | None = None) -> None:
        raise NotImplementedError

    def put_json(self, key: str, obj, *, cache_control: str | None = None) -> None:
        data = json.dumps(obj, indent=1, ensure_ascii=False).encode()
        self.put_bytes(key, data, content_type="application/json",
                       cache_control=cache_control)

    def get_json(self, key: str):
        raise NotImplementedError

    def exists(self, key: str) -> bool:
        raise NotImplementedError

    def exists_strict(self, key: str) -> bool:
        """exists(), but False only when the bucket says the key is not
        there; any other failure raises. Use it before a write that must
        never land on an existing object (exists() on B2 reads a 403 or a
        5xx as absent, which is fine for a cache check)."""
        return self.exists(key)

    def get_file(self, key: str, dest: Path) -> bool:
        """Download an object to `dest`. False when the key does not exist."""
        raise NotImplementedError

    def delete_prefix(self, prefix: str) -> int:
        raise NotImplementedError

    def list_keys(self, prefix: str) -> Iterator[tuple[str, int]]:
        """Every object whose key starts with `prefix`, as (key, size), in
        key order."""
        raise NotImplementedError

    def list_dirs(self, prefix: str) -> Iterator[str]:
        """Names of the "folders" directly under `prefix` (a '/' is added
        when missing): list_dirs('tiles/incidents/') -> 'austin', …"""
        raise NotImplementedError

    def delete_keys(self, keys: Iterable[str]) -> int:
        """Delete exactly these keys (never a prefix). Prune only."""
        raise NotImplementedError

    def put_tree(self, key_prefix: str, local_dir: Path, *, workers: int = 8) -> int:
        """Upload a directory tree (e.g. an XYZ tile pyramid). Returns file count."""
        files = [p for p in local_dir.rglob("*") if p.is_file()]

        def _one(p: Path) -> None:
            rel = p.relative_to(local_dir).as_posix()
            self.put_file(f"{key_prefix.rstrip('/')}/{rel}", p)

        with ThreadPoolExecutor(max_workers=workers) as ex:
            list(ex.map(_one, files))
        return len(files)


class DryRunStorage(Storage):
    """Writes objects to out_dir/<key>, mirroring the B2 layout."""

    def __init__(self, out_dir: Path):
        self.out_dir = Path(out_dir)
        self.written: list[str] = []

    def _path(self, key: str) -> Path:
        p = self.out_dir / key
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def put_bytes(self, key, data, *, content_type=None, cache_control=None):
        self._path(key).write_bytes(data)
        self.written.append(key)

    def put_file(self, key, path, *, content_type=None, cache_control=None):
        shutil.copyfile(path, self._path(key))
        self.written.append(key)

    def get_json(self, key):
        p = self.out_dir / key
        if not p.exists():
            return None
        return json.loads(p.read_text())

    def exists(self, key):
        return (self.out_dir / key).exists()

    def get_file(self, key, dest):
        p = self.out_dir / key
        if not p.exists():
            return False
        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(p, dest)
        return True

    def delete_prefix(self, prefix):
        root = self.out_dir / prefix
        n = 0
        if root.exists():
            n = sum(1 for p in root.rglob("*") if p.is_file())
            shutil.rmtree(root)
        return n

    def list_keys(self, prefix):
        # A key prefix need not end at a '/', so walk its parent directory
        # and filter, the way S3 matches prefixes.
        parent = prefix.rpartition("/")[0]
        root = self.out_dir / parent if parent else self.out_dir
        if not root.is_dir():
            return
        found = []
        for p in root.rglob("*"):
            if p.is_file():
                key = p.relative_to(self.out_dir).as_posix()
                if key.startswith(prefix):
                    found.append((key, p.stat().st_size))
        yield from sorted(found)

    def list_dirs(self, prefix):
        root = self.out_dir / _dir_prefix(prefix)
        if not root.is_dir():
            return
        # B2 has no empty folders: a name is listed only while it holds a
        # file (delete_keys leaves empty directories behind here).
        yield from sorted(p.name for p in root.iterdir()
                          if p.is_dir() and any(q.is_file() for q in p.rglob("*")))

    def delete_keys(self, keys):
        n = 0
        for key in dict.fromkeys(keys):
            p = self.out_dir / key
            if p.is_file():
                p.unlink()
                n += 1
        return n

    def put_tree(self, key_prefix: str, local_dir: Path, *, workers: int = 8) -> int:
        # local copy; no thread pool needed
        files = [p for p in Path(local_dir).rglob("*") if p.is_file()]
        for p in files:
            rel = p.relative_to(local_dir).as_posix()
            self.put_file(f"{key_prefix.rstrip('/')}/{rel}", p)
        return len(files)


class B2Storage(Storage):
    """boto3 S3-compatible client against the Backblaze B2 endpoint.

    Per-class CacheControl + ContentType set on every put (config rules).
    """

    def __init__(self, settings: dict[str, str] | None = None):
        import boto3  # deferred so dry-run needs no credentials

        s = settings or config.b2_settings_from_env()
        self.bucket = s["B2_BUCKET"]
        # Tolerate a scheme-less endpoint (boto3 requires a full URL).
        endpoint = s["B2_S3_ENDPOINT"].strip()
        if endpoint and "://" not in endpoint:
            endpoint = f"https://{endpoint}"
        self.client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=s["B2_KEY_ID"],
            aws_secret_access_key=s["B2_APP_KEY"],
        )

    def _extra(self, key: str, content_type: str | None, cache_control: str | None) -> dict:
        return {
            "ContentType": content_type or config.content_type_for_key(key),
            "CacheControl": cache_control or config.cache_control_for_key(key),
        }

    def put_bytes(self, key, data, *, content_type=None, cache_control=None):
        self.client.put_object(
            Bucket=self.bucket, Key=key, Body=data,
            **self._extra(key, content_type, cache_control),
        )

    def put_file(self, key, path, *, content_type=None, cache_control=None):
        self.client.upload_file(
            str(path), self.bucket, key,
            ExtraArgs=self._extra(key, content_type, cache_control),
        )

    def get_json(self, key):
        import botocore.exceptions

        try:
            resp = self.client.get_object(Bucket=self.bucket, Key=key)
        except botocore.exceptions.ClientError as exc:
            if exc.response["Error"]["Code"] in ("NoSuchKey", "404"):
                return None
            raise
        return json.loads(resp["Body"].read())

    def exists(self, key):
        import botocore.exceptions

        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
            return True
        except botocore.exceptions.ClientError:
            return False

    def exists_strict(self, key):
        import botocore.exceptions

        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
            return True
        except botocore.exceptions.ClientError as exc:
            if exc.response["Error"]["Code"] in ("NoSuchKey", "NotFound", "404"):
                return False
            raise

    def get_file(self, key, dest):
        import botocore.exceptions

        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        try:
            self.client.download_file(self.bucket, key, str(dest))
            return True
        except botocore.exceptions.ClientError as exc:
            if exc.response["Error"]["Code"] in ("NoSuchKey", "404"):
                return False
            raise

    def delete_prefix(self, prefix):
        n = 0
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            objs = [{"Key": o["Key"]} for o in page.get("Contents", [])]
            if objs:
                self.client.delete_objects(Bucket=self.bucket, Delete={"Objects": objs})
                n += len(objs)
        return n

    def list_keys(self, prefix):
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            for o in page.get("Contents", []):
                yield o["Key"], o["Size"]

    def list_dirs(self, prefix):
        prefix = _dir_prefix(prefix)
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix, Delimiter="/"):
            for cp in page.get("CommonPrefixes", []):
                yield cp["Prefix"][len(prefix):].rstrip("/")

    def delete_keys(self, keys):
        """Returns the number of keys requested; deleting a key that is
        already gone succeeds on B2. Any per-key error raises."""
        keys = list(dict.fromkeys(keys))
        for i in range(0, len(keys), DELETE_BATCH):
            batch = keys[i:i + DELETE_BATCH]
            resp = self.client.delete_objects(Bucket=self.bucket, Delete={
                "Objects": [{"Key": k} for k in batch], "Quiet": True})
            errors = resp.get("Errors") or []
            if errors:
                e = errors[0]
                raise RuntimeError(
                    f"delete_keys: {len(errors)} of {len(batch)} failed; first "
                    f"{e.get('Key')}: {e.get('Code')} {e.get('Message')}")
        return len(keys)


class StorageWriteRefused(RuntimeError):
    """A put or delete reached a storage wrapper that must not write."""


class ReadOnlyStorage(Storage):
    """Reads and listings pass through to `inner`; every put and delete
    raises. Report modes run over this, so a report can never write."""

    def __init__(self, inner: Storage):
        self.inner = inner

    def get_json(self, key):
        return self.inner.get_json(key)

    def exists(self, key):
        return self.inner.exists(key)

    def exists_strict(self, key):
        return self.inner.exists_strict(key)

    def get_file(self, key, dest):
        return self.inner.get_file(key, dest)

    def list_keys(self, prefix):
        return self.inner.list_keys(prefix)

    def list_dirs(self, prefix):
        return self.inner.list_dirs(prefix)

    def put_bytes(self, key, data, *, content_type=None, cache_control=None):
        raise StorageWriteRefused(f"read-only storage: put {key}")

    def put_file(self, key, path, *, content_type=None, cache_control=None):
        raise StorageWriteRefused(f"read-only storage: put {key}")

    def put_tree(self, key_prefix, local_dir, *, workers=8):
        raise StorageWriteRefused(f"read-only storage: put {key_prefix}")

    def delete_prefix(self, prefix):
        raise StorageWriteRefused(f"read-only storage: delete {prefix}")

    def delete_keys(self, keys):
        raise StorageWriteRefused("read-only storage: delete_keys")


class RecordingStorage(Storage):
    """Captures every put instead of sending it, so a run can be computed in
    full, checked, and only then written (flush) or thrown away.

    Reads see captured objects first (the newest capture of a key wins),
    then `inner`; listings show `inner` only. Deletes raise.
    """

    def __init__(self, inner: Storage):
        self.inner = inner
        #: (key, bytes, content_type, cache_control) in call order
        self.puts: list[tuple[str, bytes, str | None, str | None]] = []
        self._latest: dict[str, bytes] = {}

    def put_bytes(self, key, data, *, content_type=None, cache_control=None):
        data = bytes(data)
        self.puts.append((key, data, content_type, cache_control))
        self._latest[key] = data

    def put_file(self, key, path, *, content_type=None, cache_control=None):
        # read now: the caller's temp file is usually gone by flush time
        self.put_bytes(key, Path(path).read_bytes(), content_type=content_type,
                       cache_control=cache_control)

    def put_tree(self, key_prefix, local_dir, *, workers=8):
        # sequential and sorted, so the capture order never depends on threads
        files = sorted(p for p in Path(local_dir).rglob("*") if p.is_file())
        for p in files:
            self.put_file(f"{key_prefix.rstrip('/')}/{p.relative_to(local_dir).as_posix()}", p)
        return len(files)

    def get_json(self, key):
        if key in self._latest:
            return json.loads(self._latest[key])
        return self.inner.get_json(key)

    def exists(self, key):
        return key in self._latest or self.inner.exists(key)

    def exists_strict(self, key):
        return key in self._latest or self.inner.exists_strict(key)

    def get_file(self, key, dest):
        if key in self._latest:
            Path(dest).parent.mkdir(parents=True, exist_ok=True)
            Path(dest).write_bytes(self._latest[key])
            return True
        return self.inner.get_file(key, dest)

    def list_keys(self, prefix):
        return self.inner.list_keys(prefix)

    def list_dirs(self, prefix):
        return self.inner.list_dirs(prefix)

    def delete_prefix(self, prefix):
        raise StorageWriteRefused(f"recording storage: delete {prefix}")

    def delete_keys(self, keys):
        raise StorageWriteRefused("recording storage: delete_keys")

    def captured_keys(self) -> list[str]:
        """Every key put, in first-capture order, once each."""
        return list(dict.fromkeys(k for k, *_ in self.puts))

    def flush(self, target: Storage) -> int:
        """Replay every captured put, in capture order, onto `target`."""
        for key, data, content_type, cache_control in self.puts:
            target.put_bytes(key, data, content_type=content_type,
                             cache_control=cache_control)
        return len(self.puts)


def _retryable_read(exc: BaseException) -> bool:
    """B2 busy (503 too_busy and other 5xx) or a transport failure."""
    if isinstance(exc, (ConnectionError, TimeoutError)):
        return True
    try:
        import botocore.exceptions as bce
    except ImportError:  # pragma: no cover - boto3 is a dependency
        return False
    if isinstance(exc, (bce.ConnectionError, bce.HTTPClientError)):
        return True
    if isinstance(exc, getattr(bce, "IncompleteReadError", ())):
        return True
    if isinstance(exc, bce.ClientError):
        status = (exc.response.get("ResponseMetadata") or {}).get("HTTPStatusCode")
        code = (exc.response.get("Error") or {}).get("Code")
        return status in (500, 502, 503, 504) or code in (
            "ServiceUnavailable", "SlowDown", "InternalError", "RequestTimeout")
    return False


def get_json_retry(storage: Storage, key: str, tries: int = 4, *, sleep=time.sleep):
    """storage.get_json(key), retried with backoff (1 s, 2 s, 4 s …) when B2
    is busy or the connection fails. A missing key is still None; anything
    else, or the last failure, raises. Used by long read-heavy passes (the
    migration and the key audit), where one 503 must not abort the run."""
    tries = max(tries, 1)
    for attempt in range(tries):
        try:
            return storage.get_json(key)
        except Exception as exc:
            if attempt == tries - 1 or not _retryable_read(exc):
                raise
            sleep(min(2 ** attempt, 20))


def make_storage(dry_run: bool, out_dir: Path) -> Storage:
    if dry_run:
        return DryRunStorage(out_dir)
    return B2Storage()
