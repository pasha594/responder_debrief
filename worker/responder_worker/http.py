"""Shared polite HTTP client: UA, timeouts, tenacity retries."""

from __future__ import annotations

import httpx
from tenacity import (
    retry,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
)

from . import config


def make_client(**kwargs) -> httpx.Client:
    headers = {"User-Agent": config.USER_AGENT}
    headers.update(kwargs.pop("headers", {}))
    return httpx.Client(
        headers=headers,
        timeout=config.HTTP_TIMEOUT_S,
        follow_redirects=True,
        **kwargs,
    )


def _retryable(exc: BaseException) -> bool:
    if isinstance(exc, httpx.TransportError):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in (429, 500, 502, 503, 504)
    return False


@retry(
    retry=retry_if_exception(_retryable),
    stop=stop_after_attempt(config.RETRY_ATTEMPTS),
    wait=wait_exponential(multiplier=1, min=1, max=20),
    reraise=True,
)
def get(client: httpx.Client, url: str, **kwargs) -> httpx.Response:
    """GET with retries on transport errors / 429 / 5xx. Raises for 4xx/5xx.

    404 is NOT retried and raises HTTPStatusError — callers that tolerate
    missing dirs catch it.
    """
    resp = client.get(url, **kwargs)
    if resp.status_code in (304,):
        return resp
    resp.raise_for_status()
    return resp


def get_optional(client: httpx.Client, url: str, **kwargs) -> httpx.Response | None:
    """GET tolerating 404 (returns None)."""
    try:
        return get(client, url, **kwargs)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            return None
        raise
