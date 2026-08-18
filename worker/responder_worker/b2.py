"""Storage backends: real B2 (S3-compatible via boto3) and dry-run local files.

Dry-run mirrors the exact B2 key layout under a local out/ directory, so the
whole worker runs end-to-end with zero secrets.
"""

from __future__ import annotations

import json
import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import config


class Storage:
    """Interface: put_bytes/put_file/put_json/exists/delete_prefix."""

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

    def get_file(self, key: str, dest: Path) -> bool:
        """Download an object to `dest`. False when the key does not exist."""
        raise NotImplementedError

    def delete_prefix(self, prefix: str) -> int:
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


def make_storage(dry_run: bool, out_dir: Path) -> Storage:
    if dry_run:
        return DryRunStorage(out_dir)
    return B2Storage()
