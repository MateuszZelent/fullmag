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
import os
from pathlib import Path
import re
import secrets
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
from typing import Callable, Mapping
from urllib.parse import parse_qs, unquote, urlsplit


def _resolve_env_port(default: int = 48765) -> int:
    val = os.environ.get("FULLMAG_RUNNER_PORT")
    if not val or not str(val).strip():
        return default
    try:
        parsed = int(str(val).strip())
        if 0 <= parsed <= 65535:
            return parsed
    except (ValueError, TypeError):
        pass
    return default


DEFAULT_CONFIG_PATH = Path("/control/config.json")
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = _resolve_env_port(48765)
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

_MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
}


def _ui_dir() -> Path | None:
    """Find the pre-built or source UI directory."""
    # 1. Inside container / packaged alongside local_runner
    p1 = Path(__file__).resolve().parent / "ui_dist"
    if p1.is_dir() and (p1 / "index.html").is_file():
        return p1
    # 2. Workspace build dist
    p2 = Path(__file__).resolve().parents[2] / "apps" / "runner-console" / "dist"
    if p2.is_dir() and (p2 / "index.html").is_file():
        return p2
    # 3. Workspace source directory
    p3 = Path(__file__).resolve().parents[2] / "apps" / "runner-console"
    if p3.is_dir() and (p3 / "index.html").is_file():
        return p3
    return None


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
    overview: Callable[[], object] | None = None
    paginated_jobs: Callable[[dict], object] | None = None
    job_detail: Callable[[str], object] | None = None
    job_events: Callable[[str], object] | None = None
    job_metrics: Callable[[str], object] | None = None
    job_resources: Callable[[str], object] | None = None
    storage_volumes: Callable[[], object] | None = None
    storage_resources: Callable[[], object] | None = None
    processes: Callable[[], object] | None = None
    alerts: Callable[[], object] | None = None
    events: Callable[[dict], object] | None = None
    retention_plan_preview: Callable[[], object] | None = None
    retention_plan_apply: Callable[[str], object] | None = None
    get_retention_policy: Callable[[], object] | None = None
    put_retention_policy: Callable[[dict], object] | None = None
    pin_resource: Callable[[str, dict], object] | None = None

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
        for optional_name in (
            "overview",
            "paginated_jobs",
            "job_detail",
            "job_events",
            "job_metrics",
            "job_resources",
            "storage_volumes",
            "storage_resources",
            "processes",
            "alerts",
            "events",
            "retention_plan_preview",
            "retention_plan_apply",
            "get_retention_policy",
            "put_retention_policy",
            "pin_resource",
        ):
            val = getattr(self, optional_name, None)
            if val is not None and not callable(val):
                raise TypeError(f"API callback {optional_name} must be callable")


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

    def _serve_ui(self) -> None:
        raw_path = unquote(urlsplit(self.path).path)
        subpath = raw_path[len("/ui/") :].lstrip("/")
        ui_dir = _ui_dir()
        if ui_dir is None:
            body = b"<!DOCTYPE html><html><body><h1>Fullmag Build Runner</h1><p>UI bundle is not deployed.</p></body></html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(body)
            return

        if not subpath or subpath == "/":
            target_file = ui_dir / "index.html"
        else:
            target_file = (ui_dir / subpath).resolve()

        try:
            target_file.relative_to(ui_dir.resolve())
        except (ValueError, RuntimeError):
            self._error(404, "not_found")
            return

        if not target_file.exists() or target_file.is_dir():
            # SPA fallback: subroutes without dot extension serve index.html
            if not target_file.exists() and "." in Path(subpath).name:
                self._error(404, "not_found")
                return
            target_file = ui_dir / "index.html"

        if not target_file.is_file():
            self._error(404, "not_found")
            return

        try:
            content = target_file.read_bytes()
        except OSError:
            self._error(500, "file_read_error")
            return

        ext = target_file.suffix.lower()
        mime = _MIME_TYPES.get(ext, "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache" if ext == ".html" else "public, max-age=3600")
        self.end_headers()
        self.wfile.write(content)

    def _check_is_authenticated(self) -> bool:
        cookie_header = self.headers.get("Cookie", "")
        if cookie_header:
            for part in cookie_header.split(";"):
                part = part.strip()
                if part.startswith("runner_session="):
                    session_id = part.split("=", 1)[1].strip()
                    if self.server.is_valid_session(session_id):
                        return True
        authorization = self.headers.get("Authorization")
        if authorization and authorization.startswith("Bearer "):
            supplied = authorization[len("Bearer ") :]
            if supplied and hmac.compare_digest(supplied, self.server.api_token):
                return True
        return False

    def _authenticate(self) -> bool:
        origin = self.headers.get("Origin")
        if origin is not None:
            host = self.headers.get("Host", "")
            server_port = getattr(self.server, "server_port", DEFAULT_PORT)
            allowed_origins = {
                f"http://{host}",
                f"https://{host}",
                f"http://127.0.0.1:{server_port}",
                f"http://localhost:{server_port}",
            }
            if origin not in allowed_origins:
                self._error(403, "origin_not_allowed")
                return False

        if self._check_is_authenticated():
            return True

        self._error(401, "unauthorized", headers={"WWW-Authenticate": "Bearer"})
        return False

    def _query(self) -> dict[str, str]:
        parsed = urlsplit(self.path)
        raw_query = parse_qs(parsed.query)
        return {k: v[0] if v else "" for k, v in raw_query.items()}

    def _path(self) -> list[str] | None:
        parsed = urlsplit(self.path)
        raw = unquote(parsed.path)
        if not raw.startswith("/") or "\\" in raw:
            return None
        parts = raw.split("/")
        if parts and parts[0] == "":
            parts = parts[1:]
        if any(part in ("", ".", "..") for part in parts):
            return None
        if (parsed.query or parsed.fragment) and not (
            parts and (parts[0] == "ui" or (len(parts) >= 2 and parts[0] == "api" and parts[1] == "v1"))
        ):
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

    def _fallback_overview(self) -> dict[str, object]:
        jobs = self.server.callbacks.list()
        items = jobs if isinstance(jobs, list) else []
        active = [j for j in items if isinstance(j, dict) and j.get("state") == "running"]
        queued = [j for j in items if isinstance(j, dict) and j.get("state") == "queued"]
        health = self.server.callbacks.health() if self.server.callbacks.health else {"ok": True}
        health_dict = health if isinstance(health, Mapping) else {}
        return {
            "active_build": active[0] if active else None,
            "queued_count": len(queued),
            "worker": {
                "state": health_dict.get("worker_state", "running"),
                "alive": health_dict.get("worker_alive", True),
                "accepting_jobs": health_dict.get("accepting_jobs", True),
                "memory_mb": None,
                "limit_mb": None,
                "cpu_percent": None,
            },
            "storage": {
                "free_bytes": health_dict.get("storage_free_bytes"),
            },
            "trends": [],
            "incidents": [],
        }

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
        raw_path = unquote(urlsplit(self.path).path)
        if raw_path in ("/", "/ui"):
            self.send_response(301)
            self.send_header("Location", "/ui/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if raw_path.startswith("/ui/"):
            self._serve_ui()
            return

        parts = self._path()
        if parts is None:
            self._error(404, "not_found")
            return

        # Session auth probe does not require pre-existing authentication
        if parts == ["api", "v1", "auth", "session"]:
            is_auth = self._check_is_authenticated()
            self._send(200, {"authenticated": is_auth, "service": "fullmag-build-runner"})
            return

        if not self._authenticate():
            return

        if parts == ["health"]:
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
        # --- Versioned API v1 Endpoints ---
        elif parts == ["api", "v1", "overview"]:
            if self.server.callbacks.overview is not None:
                self._invoke(self.server.callbacks.overview)
            else:
                self._invoke(self._fallback_overview)
        elif parts == ["api", "v1", "jobs"]:
            query = self._query()
            if self.server.callbacks.paginated_jobs is not None:
                self._invoke(self.server.callbacks.paginated_jobs, query)
            else:
                self._invoke(self.server.callbacks.list)
        elif len(parts) == 4 and parts[:3] == ["api", "v1", "jobs"] and self._job_id(parts[3]):
            if self.server.callbacks.job_detail is not None:
                self._invoke(self.server.callbacks.job_detail, parts[3], none_is_not_found=True)
            else:
                self._invoke(self.server.callbacks.get, parts[3], none_is_not_found=True)
        elif len(parts) == 5 and parts[:3] == ["api", "v1", "jobs"] and parts[4] == "events" and self._job_id(parts[3]):
            if self.server.callbacks.job_events is not None:
                self._invoke(self.server.callbacks.job_events, parts[3])
            else:
                self._send(200, [])
        elif len(parts) == 5 and parts[:3] == ["api", "v1", "jobs"] and parts[4] == "logs" and self._job_id(parts[3]):
            if self.server.callbacks.logs is not None:
                self._invoke(self.server.callbacks.logs, parts[3], none_is_not_found=True)
            else:
                self._error(404, "job_not_found")
        elif len(parts) == 5 and parts[:3] == ["api", "v1", "jobs"] and parts[4] == "metrics" and self._job_id(parts[3]):
            if self.server.callbacks.job_metrics is not None:
                self._invoke(self.server.callbacks.job_metrics, parts[3])
            else:
                self._send(200, [])
        elif len(parts) == 5 and parts[:3] == ["api", "v1", "jobs"] and parts[4] == "resources" and self._job_id(parts[3]):
            if self.server.callbacks.job_resources is not None:
                self._invoke(self.server.callbacks.job_resources, parts[3])
            else:
                self._send(200, [])
        elif parts == ["api", "v1", "storage", "volumes"]:
            if self.server.callbacks.storage_volumes is not None:
                self._invoke(self.server.callbacks.storage_volumes)
            else:
                self._send(200, [])
        elif parts == ["api", "v1", "storage", "resources"]:
            if self.server.callbacks.storage_resources is not None:
                self._invoke(self.server.callbacks.storage_resources)
            else:
                self._send(200, {"categories": [], "resources": []})
        elif parts == ["api", "v1", "processes"]:
            if self.server.callbacks.processes is not None:
                self._invoke(self.server.callbacks.processes)
            else:
                self._send(200, [])
        elif parts == ["api", "v1", "alerts"]:
            if self.server.callbacks.alerts is not None:
                self._invoke(self.server.callbacks.alerts)
            else:
                self._send(200, [])
        elif parts == ["api", "v1", "events"]:
            query = self._query()
            if self.server.callbacks.events is not None:
                self._invoke(self.server.callbacks.events, query)
            else:
                self._send(200, [])
        elif parts == ["api", "v1", "retention", "policy"]:
            if self.server.callbacks.get_retention_policy is not None:
                self._invoke(self.server.callbacks.get_retention_policy)
            else:
                self._send(200, {})
        elif parts == ["api", "v1", "retention", "plans"]:
            if self.server.callbacks.retention_plan_preview is not None:
                self._invoke(self.server.callbacks.retention_plan_preview)
            elif self.server.callbacks.retention is not None:
                self._invoke(self.server.callbacks.retention)
            else:
                self._error(503, "retention_unavailable")
        else:
            self._error(404, "not_found")

    def do_POST(self) -> None:  # noqa: N802
        parts = self._path()
        if parts is None:
            self._error(404, "not_found")
            return

        # POST /api/v1/auth/session
        if parts == ["api", "v1", "auth", "session"]:
            payload = self._read_body(required=True)
            if payload is None or payload is _BODY_ERROR:
                return
            token = payload.get("token")
            if not isinstance(token, str) or not hmac.compare_digest(token, self.server.api_token):
                self._error(401, "invalid_token")
                return
            session_id = self.server.create_session(86400)
            cookie_hdr = f"runner_session={session_id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400"
            self._send(200, {"ok": True, "authenticated": True, "expires_in": 86400}, headers={"Set-Cookie": cookie_hdr})
            return

        # POST /api/v1/auth/logout
        if parts == ["api", "v1", "auth", "logout"]:
            cookie_header = self.headers.get("Cookie", "")
            for part in cookie_header.split(";"):
                if part.strip().startswith("runner_session="):
                    sid = part.strip().split("=", 1)[1].strip()
                    self.server.revoke_session(sid)
            clear_cookie = "runner_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
            self._send(200, {"ok": True, "authenticated": False}, headers={"Set-Cookie": clear_cookie})
            return

        if not self._authenticate():
            return

        if parts == ["jobs"]:
            payload = self._read_body(required=True)
            if payload is not None and payload is not _BODY_ERROR:
                self._invoke(self.server.callbacks.submit, payload, success=201)
        elif (
            len(parts) == 3
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
        elif parts == ["api", "v1", "retention", "plans"]:
            body = self._read_body(required=False)
            if body is _BODY_ERROR:
                return
            if self.server.callbacks.retention_plan_preview is not None:
                self._invoke(self.server.callbacks.retention_plan_preview)
            elif self.server.callbacks.retention is not None:
                self._invoke(self.server.callbacks.retention)
            else:
                self._error(503, "retention_unavailable")
        elif len(parts) == 6 and parts[:4] == ["api", "v1", "retention", "plans"] and parts[5] == "apply":
            body = self._read_body(required=False)
            if body is _BODY_ERROR:
                return
            plan_id = parts[4]
            if self.server.callbacks.retention_plan_apply is not None:
                self._invoke(self.server.callbacks.retention_plan_apply, plan_id)
            else:
                self._send(200, {"applied": True, "plan_id": plan_id, "simulated": True})
        elif len(parts) == 5 and parts[:3] == ["api", "v1", "resources"] and parts[4] == "pin":
            body = self._read_body(required=False)
            if body is _BODY_ERROR:
                return
            resource_id = parts[3]
            payload = body if isinstance(body, dict) else {}
            if self.server.callbacks.pin_resource is not None:
                self._invoke(self.server.callbacks.pin_resource, resource_id, payload)
            else:
                self._send(200, {"resource_id": resource_id, "pinned": payload.get("pinned", True)})
        else:
            self._error(404, "not_found")

    def do_HEAD(self) -> None:  # noqa: N802
        if not self._authenticate():
            return
        self._error(405, "method_not_allowed", headers={"Allow": "GET, POST"})

    def do_PUT(self) -> None:  # noqa: N802
        if not self._authenticate():
            return
        parts = self._path()
        if parts == ["api", "v1", "retention", "policy"]:
            payload = self._read_body(required=True)
            if payload is not None and payload is not _BODY_ERROR:
                if self.server.callbacks.put_retention_policy is not None:
                    self._invoke(self.server.callbacks.put_retention_policy, payload)
                else:
                    self._send(200, payload)
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
        self._sessions: dict[str, float] = {}
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

    def create_session(self, duration_seconds: int = 86400) -> str:
        with self._api_state_lock:
            session_id = secrets.token_hex(32)
            now = time.time()
            self._sessions[session_id] = now + duration_seconds
            # Purge expired
            self._sessions = {k: exp for k, exp in self._sessions.items() if exp > now}
            return session_id

    def is_valid_session(self, session_id: str) -> bool:
        if not isinstance(session_id, str) or len(session_id) != 64:
            return False
        with self._api_state_lock:
            expiry = self._sessions.get(session_id)
            if expiry is None:
                return False
            if expiry < time.time():
                del self._sessions[session_id]
                return False
            return True

    def revoke_session(self, session_id: str) -> None:
        with self._api_state_lock:
            self._sessions.pop(session_id, None)


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
                overview=callbacks.get("overview"),
                paginated_jobs=callbacks.get("paginated_jobs"),
                job_detail=callbacks.get("job_detail"),
                job_events=callbacks.get("job_events"),
                job_metrics=callbacks.get("job_metrics"),
                job_resources=callbacks.get("job_resources"),
                storage_volumes=callbacks.get("storage_volumes"),
                storage_resources=callbacks.get("storage_resources"),
                processes=callbacks.get("processes"),
                alerts=callbacks.get("alerts"),
                events=callbacks.get("events"),
                retention_plan_preview=callbacks.get("retention_plan_preview"),
                retention_plan_apply=callbacks.get("retention_plan_apply"),
                get_retention_policy=callbacks.get("get_retention_policy"),
                put_retention_policy=callbacks.get("put_retention_policy"),
                pin_resource=callbacks.get("pin_resource"),
            )
        except KeyError as error:
            raise APIError(f"Missing API callback: {error.args[0]}") from error
    raise TypeError("callbacks must be APICallbacks or a callback mapping")


def create_server(
    callbacks: APICallbacks | Mapping[str, Callable[..., object]],
    *,
    config_path: Path | str = DEFAULT_CONFIG_PATH,
    host: str = DEFAULT_HOST,
    port: int | None = None,
) -> RunnerAPIServer:
    """Create a configured server; the caller owns ``serve_forever``."""

    if port is None:
        val = os.environ.get("FULLMAG_RUNNER_PORT")
        if val is not None and str(val).strip():
            try:
                port = int(str(val).strip())
            except (ValueError, TypeError) as error:
                raise APIError("API port must be 0..65535") from error
        else:
            port = DEFAULT_PORT
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
    port: int | None = None,
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
