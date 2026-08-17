#!/usr/bin/env python3
"""Deploy worker.js to Cloudflare Workers — stdlib only, no npm, no wrangler.

Uploads worker.js as an ES-module Worker named 'responder-debrief-wms' via the
Cloudflare Workers Script Upload API, enables its workers.dev subdomain route,
and prints the resulting workers.dev URL.

Environment (required unless --dry-run):
  CLOUDFLARE_API_TOKEN    API token with the "Workers Scripts:Edit" permission
  CLOUDFLARE_ACCOUNT_ID   Cloudflare account id (dashboard sidebar)

Usage:
  python3 deploy.py             # upload + enable workers.dev + print URL
  python3 deploy.py --dry-run   # build the multipart body locally and print
                                # its size + metadata; no network, no creds
"""

import json
import os
import sys
import urllib.error
import urllib.request

SCRIPT_NAME = "responder-debrief-wms"
API_BASE = "https://api.cloudflare.com/client/v4"
WORKER_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "worker.js")

# Mirrors the old wrangler.toml: compatibility_date + observability enabled.
METADATA = {
    "main_module": "worker.js",
    "compatibility_date": "2026-08-01",
    "observability": {"enabled": True},
}

BOUNDARY = "----responder-debrief-deploy-3c9f1a7e2b"


def build_multipart(worker_source: bytes) -> tuple[bytes, str]:
    """Hand-rolled multipart/form-data body (stdlib has no multipart writer).

    Two parts: 'metadata' (application/json) and 'worker.js'
    (application/javascript+module — this content-type is what marks the part
    as an ES module for the Workers runtime).
    Returns (body, content_type_header_value).
    """
    crlf = b"\r\n"
    parts = []

    parts.append(b"--" + BOUNDARY.encode("ascii") + crlf)
    parts.append(b'Content-Disposition: form-data; name="metadata"' + crlf)
    parts.append(b"Content-Type: application/json" + crlf + crlf)
    parts.append(json.dumps(METADATA).encode("utf-8") + crlf)

    parts.append(b"--" + BOUNDARY.encode("ascii") + crlf)
    parts.append(
        b'Content-Disposition: form-data; name="worker.js"; filename="worker.js"' + crlf
    )
    parts.append(b"Content-Type: application/javascript+module" + crlf + crlf)
    parts.append(worker_source + crlf)

    parts.append(b"--" + BOUNDARY.encode("ascii") + b"--" + crlf)

    body = b"".join(parts)
    return body, f"multipart/form-data; boundary={BOUNDARY}"


def api_request(method: str, url: str, token: str, body: bytes | None = None,
                content_type: str | None = None) -> dict:
    """Perform one Cloudflare API call; return the parsed JSON envelope.

    Exits with a readable error report on HTTP or API-level failure.
    """
    headers = {"Authorization": f"Bearer {token}"}
    if content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        try:
            envelope = json.loads(detail)
            errors = envelope.get("errors") or [{"message": detail}]
            detail = "; ".join(
                f"[{err.get('code', '?')}] {err.get('message', '')}" for err in errors
            )
        except ValueError:
            pass
        print(f"error: {method} {url} -> HTTP {e.code}\n  {detail}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"error: {method} {url} -> {e.reason}", file=sys.stderr)
        sys.exit(1)

    if not payload.get("success", False):
        errors = payload.get("errors") or [{"message": "unknown API error"}]
        detail = "; ".join(
            f"[{err.get('code', '?')}] {err.get('message', '')}" for err in errors
        )
        print(f"error: {method} {url} reported failure\n  {detail}", file=sys.stderr)
        sys.exit(1)
    return payload


def main() -> None:
    dry_run = "--dry-run" in sys.argv[1:]

    try:
        with open(WORKER_FILE, "rb") as f:
            worker_source = f.read()
    except OSError as e:
        print(f"error: cannot read {WORKER_FILE}: {e}", file=sys.stderr)
        sys.exit(1)

    body, content_type = build_multipart(worker_source)

    if dry_run:
        print(f"[dry-run] worker file:      {WORKER_FILE} ({len(worker_source)} bytes)")
        print(f"[dry-run] metadata:         {json.dumps(METADATA)}")
        print(f"[dry-run] multipart body:   {len(body)} bytes")
        print(f"[dry-run] content-type:     {content_type}")
        print(f"[dry-run] would PUT to:     {API_BASE}/accounts/<account_id>"
              f"/workers/scripts/{SCRIPT_NAME}")
        print("[dry-run] no network calls made")
        return

    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    missing = [
        name for name, val in
        [("CLOUDFLARE_API_TOKEN", token), ("CLOUDFLARE_ACCOUNT_ID", account)]
        if not val
    ]
    if missing:
        print(f"error: missing environment variable(s): {', '.join(missing)}",
              file=sys.stderr)
        sys.exit(1)

    scripts_base = f"{API_BASE}/accounts/{account}/workers/scripts/{SCRIPT_NAME}"

    # 1. Upload the module worker.
    print(f"Uploading {SCRIPT_NAME} ({len(worker_source)} bytes of worker.js)...")
    api_request("PUT", scripts_base, token, body, content_type)
    print("  upload OK")

    # 2. Enable the workers.dev subdomain route for this script.
    print("Enabling workers.dev route...")
    api_request(
        "POST",
        f"{scripts_base}/subdomain",
        token,
        json.dumps({"enabled": True}).encode("utf-8"),
        "application/json",
    )
    print("  workers.dev route enabled")

    # 3. Look up the account's workers.dev subdomain and print the URL.
    sub = api_request(
        "GET", f"{API_BASE}/accounts/{account}/workers/subdomain", token
    )
    subdomain = (sub.get("result") or {}).get("subdomain")
    if subdomain:
        print(f"Deployed: https://{SCRIPT_NAME}.{subdomain}.workers.dev")
    else:
        print("Deployed, but could not determine the account's workers.dev "
              "subdomain — check the Cloudflare dashboard for the URL.")


if __name__ == "__main__":
    main()
