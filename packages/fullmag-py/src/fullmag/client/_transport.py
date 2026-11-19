"""Standard-library HTTP transport for the live client (spec §4.1).

The transport keeps one persistent HTTP/1.1 connection per thread, so the
per-call synchronisation of the live DSL mode does not pay a TCP handshake for
every transaction.  It retries only where the request provably did not take
effect: connection establishment failures, a stale keep-alive connection, a
proxy that could not reach the API (502) and the API's development handoff
gate (409 ``development_restart_in_progress``).
"""
from __future__ import annotations

import http.client
import json
import socket
import ssl
import threading
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Optional

from .errors import ApiError, DevelopmentRestartError, FullmagConnectionError, error_from_response

__all__ = ["HttpResponse", "HttpTransport", "normalize_base_url"]

_USER_AGENT = "fullmag-python-live-client/1"
_RETRY_INITIAL_S = 0.1
_RETRY_MAX_S = 2.0
_MUTATING = frozenset({"POST", "PUT", "PATCH", "DELETE"})


@dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes
    method: str = ""
    path: str = ""

    @property
    def content_type(self) -> str:
        return self.headers.get("content-type", "").split(";", 1)[0].strip().lower()

    def json(self) -> Any:
        if not self.body:
            return None
        return json.loads(self.body.decode("utf-8"))

    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")


def normalize_base_url(url: str) -> str:
    """Validate an ``http(s)://host[:port][/prefix]`` origin and drop the trailing slash."""
    parsed = urllib.parse.urlsplit(url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError(f"Fullmag URL must be http(s)://host[:port], got {url!r}")
    if parsed.query or parsed.fragment:
        raise ValueError(f"Fullmag URL must not carry a query or fragment, got {url!r}")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


@dataclass
class _ConnectionSlot:
    connection: Optional[http.client.HTTPConnection] = None
    used: bool = False


@dataclass
class HttpTransport:
    """Blocking JSON/binary HTTP transport bound to one Fullmag origin."""

    base_url: str
    timeout: float = 30.0
    token: Optional[str] = None
    retry_budget_s: float = 60.0
    sleep: Callable[[float], None] = time.sleep
    _local: threading.local = field(default_factory=threading.local, repr=False)

    def __post_init__(self) -> None:
        self.base_url = normalize_base_url(self.base_url)
        parsed = urllib.parse.urlsplit(self.base_url)
        self._scheme = parsed.scheme
        self._host = parsed.hostname or "127.0.0.1"
        self._port = parsed.port or (443 if parsed.scheme == "https" else 80)
        self._prefix = parsed.path

    # ---- public API ------------------------------------------------------

    def request(
        self,
        method: str,
        path: str,
        *,
        query: Optional[Mapping[str, Any]] = None,
        json_body: Any = None,
        headers: Optional[Mapping[str, str]] = None,
        accept: str = "application/json",
        timeout: Optional[float] = None,
        ok_statuses: tuple[int, ...] = (),
    ) -> HttpResponse:
        """Send one request and return the response; raise :class:`ApiError` on 4xx/5xx.

        Statuses listed in ``ok_statuses`` (e.g. 304) are returned instead of raised.
        """
        method = method.upper()
        target = self._prefix + path + _encode_query(query)
        body = None if json_body is None else json.dumps(json_body, separators=(",", ":")).encode("utf-8")
        request_headers = {"Accept": accept, "User-Agent": _USER_AGENT}
        if body is not None:
            request_headers["Content-Type"] = "application/json"
        if self.token:
            request_headers["Authorization"] = f"Bearer {self.token}"
        if headers:
            request_headers.update(headers)
        deadline = time.monotonic() + self.retry_budget_s
        delay = _RETRY_INITIAL_S
        while True:
            response = self._send_once(method, target, body, request_headers, timeout, deadline)
            if response is not None:
                if response.status < 400 or response.status in ok_statuses:
                    return response
                error = error_from_response(response.status, _json_or_text(response), method=method, path=path)
                if _retryable_status(method, response.status, error) and time.monotonic() < deadline:
                    self.sleep(delay)
                    delay = min(delay * 2, _RETRY_MAX_S)
                    continue
                raise error
            # Connection could not be established: nothing was sent.
            self.sleep(delay)
            delay = min(delay * 2, _RETRY_MAX_S)

    def get_json(self, path: str, *, query: Optional[Mapping[str, Any]] = None, headers: Optional[Mapping[str, str]] = None) -> Any:
        return self.request("GET", path, query=query, headers=headers).json()

    def close(self) -> None:
        slot = getattr(self._local, "slot", None)
        if slot is not None and slot.connection is not None:
            slot.connection.close()
            slot.connection = None

    # ---- internals -------------------------------------------------------

    def _slot(self) -> _ConnectionSlot:
        slot = getattr(self._local, "slot", None)
        if slot is None:
            slot = _ConnectionSlot()
            self._local.slot = slot
        return slot

    def _connect(self, timeout: float) -> http.client.HTTPConnection:
        if self._scheme == "https":
            return http.client.HTTPSConnection(self._host, self._port, timeout=timeout, context=ssl.create_default_context())
        return http.client.HTTPConnection(self._host, self._port, timeout=timeout)

    def _send_once(
        self,
        method: str,
        target: str,
        body: Optional[bytes],
        headers: Mapping[str, str],
        timeout: Optional[float],
        deadline: float,
    ) -> Optional[HttpResponse]:
        """Return a response, or ``None`` when connecting failed and a retry is allowed."""
        slot = self._slot()
        effective_timeout = self.timeout if timeout is None else timeout
        for attempt in range(2):
            reused = slot.connection is not None and slot.used
            if slot.connection is None:
                slot.connection = self._connect(effective_timeout)
                slot.used = False
            connection = slot.connection
            connection.timeout = effective_timeout
            if connection.sock is not None:
                connection.sock.settimeout(effective_timeout)
            try:
                connection.request(method, target, body=body, headers=dict(headers))
                raw = connection.getresponse()
                payload = raw.read()
            except (ConnectionRefusedError, socket.gaierror) as error:
                self._drop(slot)
                if time.monotonic() >= deadline:
                    raise FullmagConnectionError(self.base_url, str(error)) from error
                return None
            except (http.client.RemoteDisconnected, BrokenPipeError, ConnectionResetError, ConnectionAbortedError) as error:
                self._drop(slot)
                if reused and attempt == 0:
                    # The server closed an idle keep-alive connection; the request was not processed.
                    continue
                raise FullmagConnectionError(self.base_url, f"{type(error).__name__}: {error}") from error
            except socket.timeout as error:
                self._drop(slot)
                raise FullmagConnectionError(self.base_url, f"timed out after {effective_timeout:g} s") from error
            except OSError as error:
                self._drop(slot)
                if not reused and time.monotonic() < deadline and _connect_failure(error):
                    return None
                raise FullmagConnectionError(self.base_url, f"{type(error).__name__}: {error}") from error
            slot.used = True
            if raw.will_close:
                self._drop(slot)
            response_headers = {key.lower(): value for key, value in raw.getheaders()}
            return HttpResponse(raw.status, response_headers, payload, method, target)
        raise AssertionError("unreachable")

    @staticmethod
    def _drop(slot: _ConnectionSlot) -> None:
        if slot.connection is not None:
            slot.connection.close()
        slot.connection = None
        slot.used = False


def _encode_query(query: Optional[Mapping[str, Any]]) -> str:
    if not query:
        return ""
    pairs = []
    for key, value in query.items():
        if value is None:
            continue
        if isinstance(value, bool):
            value = "true" if value else "false"
        elif isinstance(value, (list, tuple)):
            value = ",".join(str(item) for item in value)
        pairs.append((key, str(value)))
    return "?" + urllib.parse.urlencode(pairs) if pairs else ""


def _json_or_text(response: HttpResponse) -> Any:
    try:
        return response.json()
    except (ValueError, UnicodeDecodeError):
        return response.text()


def _retryable_status(method: str, status: int, error: ApiError) -> bool:
    if isinstance(error, DevelopmentRestartError):
        return True
    if status == 502:
        # The DEV frontend proxy could not reach the API, so nothing was applied.
        return True
    return method not in _MUTATING and status in {503, 504}


def _connect_failure(error: OSError) -> bool:
    return isinstance(error, (ConnectionRefusedError, socket.gaierror)) or getattr(error, "errno", None) in {
        61,  # ECONNREFUSED (macOS)
        111,  # ECONNREFUSED (Linux)
        10061,  # WSAECONNREFUSED
    }
