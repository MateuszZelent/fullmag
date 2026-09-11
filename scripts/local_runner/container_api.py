"""Small authenticated HTTP API exposed by the build-runner container.

The API is intentionally only a transport boundary.  Queue mutation,
ownership and execution remain injected callbacks supplied by the container
entrypoint.  No callback is run by a request handler in a process that owns
the build worker loop; ``ThreadingHTTPServer`` lets requests remain responsive
while the injected worker executes elsewhere.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hmac
import json
from pathlib import Path
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
from typing import Callable, Mapping
from urllib.parse import unquote, urlsplit


DEFAULT_CONFIG_PATH = Path("/control/config.json")
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8765
MAX_BODY_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 1024 * 1024
_BODY_ERROR = object()
_JOB_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z")
_SENSITIVE_KEYS = frozenset(
    {
        "authorization",
        "api_token",
        "bearer_token",
        "password",
        "secret",
        "token",
        "lease_token",
    }
)


class APIError(RuntimeError):
    """Invalid API configuration or an unrecoverable server setup error."""


class APIUnavailable(RuntimeError):
    """The trusted runner is paused or not ready to accept a job."""


class APINotFound(LookupError):
    """An injected callback could not find a requested job."""


@dataclass(frozen=True)
class APICallbacks:
    """Queue operations owned by the container's worker/control layer."""

    submit: Callable[[dict], object]
    list: Callable[[], object]
    get: Callable[[str], object]
    logs: Callable[[str], object]
    cancel: Callable[[str], object]
    stop: Callable[[], object]
    health: Callable[[], object] | None = None
    resume: Callable[[], object] | None = None
    retention: Callable[[], object] | None = None

    def __post_init__(self) -> None:
        for name in ("submit", "list", "get", "logs", "cancel", "stop"):
            if not callable(getattr(self, name)):
                raise TypeError(f"API callback {name} must be callable")
        if self.health is not None and not callable(self.health):
            raise TypeError("API callback health must be callable")
        if self.resume is not None and not callable(self.resume):
            raise TypeError("API callback resume must be callable")
        if self.retention is not None and not callable(self.retention):
            raise TypeError("API callback retention must be callable")


def _load_token(config_path: Path | str) -> str:
    path = Path(config_path)
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise APIError("API config must be an existing absolute regular file")
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise APIError("API config is not valid JSON") from error
    if not isinstance(config, dict):
        raise APIError("API config must contain an object")
    token = config.get("bearer_token")
    if token is None:
        token = config.get("token")
    if token is None:
        token = config.get("api_token")
    if (
        not isinstance(token, str)
        or not token
        or len(token) > 4096
        or any(char.isspace() for char in token)
    ):
        raise APIError("API config must contain a nonempty bearer token")
    return token


def _redact(value: object) -> object:
    """Remove credential-shaped fields before callback data reaches HTTP."""

    if isinstance(value, Mapping):
        return {
            str(key): _redact(item)
            for key, item in value.items()
            if str(key).casefold() not in _SENSITIVE_KEYS
        }
    if isinstance(value, (list, tuple)):
        return [_redact(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _json_bytes(value: object) -> bytes:
    try:
        encoded = json.dumps(
            _redact(value), ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise APIError("Callback returned a non-JSON value") from error
    if len(encoded) > MAX_RESPONSE_BYTES:
        raise APIError("Callback response exceeds the bounded response limit")
    return encoded


class _RunnerAPIHandler(BaseHTTPRequestHandler):
    server: "RunnerAPIServer"
    protocol_version = "HTTP/1.1"
    server_version = "FullmagBuildRunner"
    sys_version = ""

    # BaseHTTPRequestHandler logs request lines and exceptions by default.
    # The token must never enter a log sink, so both paths are deliberately
    # silent.  Callbacks also receive no request headers.
    def log_message(self, _format: str, *_args: object) -> None:
        return

    def log_error(self, _format: str, *_args: object) -> None:
        return

    def handle_one_request(self) -> None:  # noqa: N802
        self.server.touch_api()
        super().handle_one_request()

    def _send(self, status: int, payload: object, *, headers: Mapping[str, str] | None = None) -> None:
        try:
            body = _json_bytes(payload)
        except APIError:
            status = 500
            body = b'{"error":"response_too_large"}'
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if self.close_connection:
            self.send_header("Connection", "close")
        if headers:
            for key, value in headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, code: str, *, headers: Mapping[str, str] | None = None) -> None:
        self._send(status, {"error": code}, headers=headers)

    def _authenticate(self) -> bool:
        # An Origin header is never accepted: this service is a host-local
        # control plane, not a browser API, and it deliberately emits no CORS.
        if self.headers.get("Origin") is not None:
            self._error(403, "origin_not_allowed")
            return False
        authorization = self.headers.get("Authorization")
        prefix = "Bearer "
        if not authorization or not authorization.startswith(prefix):
            self._error(401, "unauthorized", headers={"WWW-Authenticate": "Bearer"})
            return False
        supplied = authorization[len(prefix) :]
        if not supplied or not hmac.compare_digest(supplied, self.server.api_token):
            self._error(401, "unauthorized", headers={"WWW-Authenticate": "Bearer"})
            return False
        return True

    def _path(self) -> list[str] | None:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            return None
        raw = unquote(parsed.path)
        if not raw.startswith("/") or "\\" in raw:
            return None
        parts = raw.split("/")
        if parts and parts[0] == "":
            parts = parts[1:]
        if any(part in ("", ".", "..") for part in parts):
            return None
        return parts

    def _job_id(self, value: str) -> str | None:
        return value if _JOB_ID.fullmatch(value) else None

    def _read_body(self, *, required: bool) -> object | None:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding:
            self._error(400, "transfer_encoding_not_supported")
            return _BODY_ERROR
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            if required:
                self._error(411, "content_length_required")
                return _BODY_ERROR
            return None
        try:
            length = int(length_header)
        except ValueError:
            self._error(400, "invalid_content_length")
            return _BODY_ERROR
        if length < 0:
            self._error(400, "invalid_content_length")
            return _BODY_ERROR
        if length > MAX_BODY_BYTES:
            # Drain small rejected bodies before closing so clients do not see
            # a reset connection on Windows.  Never wait indefinitely for an
            # unbounded advertised body.
            if length <= MAX_BODY_BYTES * 2:
                self.rfile.read(length)
            self.close_connection = True
            self._error(413, "request_body_too_large")
            return _BODY_ERROR
        if length == 0:
            if required:
                self._error(400, "json_body_required")
                return _BODY_ERROR
            return None
        content_type = self.headers.get("Content-Type", "")
        if content_type.split(";", 1)[0].strip().casefold() != "application/json":
            self._error(415, "application_json_required")
            return _BODY_ERROR
        body = self.rfile.read(length)
        if len(body) != length:
            self.close_connection = True
            self._error(400, "incomplete_request_body")
            return _BODY_ERROR
        try:
            value = json.loads(
                body.decode("utf-8"),
                parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
            )
        except (UnicodeDecodeError, ValueError):
            self._error(400, "invalid_json")
            return _BODY_ERROR
        if not isinstance(value, dict):
            self._error(400, "json_object_required")
            return _BODY_ERROR
        return value

    def _invoke(
        self,
        callback: Callable[..., object],
        *args: object,
        success: int = 200,
        none_is_not_found: bool = False,
        include_api_status: bool = False,
    ) -> None:
        try:
            result = callback(*args)
        except (APINotFound, LookupError):
            self._error(404, "job_not_found")
            return
        except APIUnavailable:
            self._error(503, "runner_unavailable")
            return
        except (ValueError, TypeError):
            self._error(400, "invalid_request")
            return
        except Exception:
            # The callback's exception and its message are intentionally not
            # returned or logged; queue implementations may carry credentials
            # or host paths in their exception text.
            self._error(500, "callback_failed")
            return
        if result is None and none_is_not_found:
            self._error(404, "job_not_found")
            return
        if include_api_status:
            if isinstance(result, Mapping):
                result = {**result, "api": self.server.api_status()}
            else:
                result = {"worker": result, "api": self.server.api_status()}
        self._send(success, result)

    def do_GET(self) -> None:  # noqa: N802
        if not self._authenticate():
            return
        parts = self._path()
        if parts is None:
            self._error(404, "not_found")
        elif parts == ["health"]:
            if self.server.callbacks.health is None:
                self._send(
                    200,
                    {
                        "ok": True,
                        "service": "fullmag-build-runner",
                        "api": self.server.api_status(),
                    },
                )
            else:
                self._invoke(self.server.callbacks.health, include_api_status=True)
        elif parts == ["retention"]:
            if self.server.callbacks.retention is None:
                self._error(503, "retention_unavailable")
            else:
                self._invoke(self.server.callbacks.retention)
        elif parts == ["jobs"]:
            self._invoke(self.server.callbacks.list)
        elif len(parts) == 2 and parts[0] == "jobs" and self._job_id(parts[1]):
            self._invoke(self.server.callbacks.get, parts[1], none_is_not_found=True)
        elif len(parts) == 3 and parts[0] == "jobs" and parts[2] == "logs" and self._job_id(parts[1]):
            def logs_callback(job_id: str) -> object:
                result = self.server.callbacks.logs(job_id)
                return {"job_id": job_id, "logs": result} if isinstance(result, str) else result

            self._invoke(logs_callback, parts[1], none_is_not_found=True)
        else:
            self._error(404, "not_found")

    def do_POST(self) -> None:  # noqa: N802
        if not self._authenticate():
            return
        parts = self._path()
        if parts == ["jobs"]:
            payload = self._read_body(required=True)
            if payload is not None and payload is not _BODY_ERROR:
                self._invoke(self.server.callbacks.submit, payload, success=201)
        elif (
            parts is not None
            and len(parts) == 3
            and parts[0] == "jobs"
            and parts[2] == "cancel"
            and self._job_id(parts[1])
        ):
            body = self._read_body(required=False)
            if body is _BODY_ERROR:
                return
            self._invoke(self.server.callbacks.cancel, parts[1])
        elif parts == ["stop"]:
            body = self._read_body(required=False)
            if body is _BODY_ERROR:
                return
            self._invoke(self.server.callbacks.stop)
        elif parts == ["resume"]:
            body = self._read_body(required=False)
            if body is _BODY_ERROR:
                return
            if self.server.callbacks.resume is None:
                self._error(503, "resume_unavailable")
            else:
                self._invoke(self.server.callbacks.resume)
        else:
            self._error(404, "not_found")

    def do_HEAD(self) -> None:  # noqa: N802
        if not self._authenticate():
            return
        self._error(405, "method_not_allowed", headers={"Allow": "GET, POST"})

    def do_PUT(self) -> None:  # noqa: N802
        if not self._authenticate():
            return
        self._error(405, "method_not_allowed", headers={"Allow": "GET, POST"})

    def do_DELETE(self) -> None:  # noqa: N802
        if not self._authenticate():
            return
        self._error(405, "method_not_allowed", headers={"Allow": "GET, POST"})


class RunnerAPIServer(ThreadingHTTPServer):
    """Threaded server carrying only the token and injected callbacks."""

    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 16

    def __init__(self, address, callbacks: APICallbacks, api_token: str):
        self.callbacks = callbacks
        self.api_token = api_token
        self._api_state_lock = threading.Lock()
        self.api_started_at = datetime.now(timezone.utc).isoformat()
        self.api_last_request_at: str | None = None
        super().__init__(address, _RunnerAPIHandler)

    def touch_api(self) -> None:
        with self._api_state_lock:
            self.api_last_request_at = datetime.now(timezone.utc).isoformat()

    def api_status(self) -> dict[str, str | None]:
        with self._api_state_lock:
            return {
                "started_at": self.api_started_at,
                "last_request_at": self.api_last_request_at,
            }
def _coerce_callbacks(callbacks: APICallbacks | Mapping[str, Callable[..., object]]) -> APICallbacks:
    if isinstance(callbacks, APICallbacks):
        return callbacks
    if isinstance(callbacks, Mapping):
        try:
            return APICallbacks(
                submit=callbacks["submit"],
                list=callbacks["list"],
                get=callbacks["get"],
                logs=callbacks["logs"],
                cancel=callbacks["cancel"],
                stop=callbacks["stop"],
                health=callbacks.get("health"),
                resume=callbacks.get("resume"),
                retention=callbacks.get("retention"),
            )
        except KeyError as error:
            raise APIError(f"Missing API callback: {error.args[0]}") from error
    raise TypeError("callbacks must be APICallbacks or a callback mapping")


def create_server(
    callbacks: APICallbacks | Mapping[str, Callable[..., object]],
    *,
    config_path: Path | str = DEFAULT_CONFIG_PATH,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
) -> RunnerAPIServer:
    """Create a configured server; the caller owns ``serve_forever``."""

    if not isinstance(host, str) or not host:
        raise APIError("API host must be nonempty text")
    if not isinstance(port, int) or not 0 <= port <= 65535:
        raise APIError("API port must be 0..65535")
    return RunnerAPIServer((host, port), _coerce_callbacks(callbacks), _load_token(config_path))


def serve(
    callbacks: APICallbacks | Mapping[str, Callable[..., object]],
    *,
    config_path: Path | str = DEFAULT_CONFIG_PATH,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
) -> None:
    """Run the API loop until the container supervisor stops the process."""

    server = create_server(callbacks, config_path=config_path, host=host, port=port)
    try:
        server.serve_forever()
    finally:
        server.server_close()


__all__ = [
    "APICallbacks",
    "APIError",
    "APIUnavailable",
    "APINotFound",
    "DEFAULT_CONFIG_PATH",
    "DEFAULT_HOST",
    "DEFAULT_PORT",
    "MAX_BODY_BYTES",
    "RunnerAPIServer",
    "create_server",
    "serve",
]
