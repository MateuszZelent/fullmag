"""Typed errors raised by :mod:`fullmag.client` (spec python-live-client-v1 §4.3)."""
from __future__ import annotations

from typing import Any, Mapping, Optional

__all__ = [
    "ApiError",
    "CommandFailedError",
    "CommandTimeoutError",
    "DevelopmentRestartError",
    "FullmagClientError",
    "FullmagConnectionError",
    "InputLockedError",
    "NotFoundError",
    "RequestValidationError",
    "SessionExistsError",
    "StaleRevisionError",
    "UnsupportedCapabilityError",
    "ValidationError",
    "error_from_response",
]

# Server message used before a dedicated code exists for this conflict.
_SESSION_EXISTS_MESSAGE = "an active local session already exists"


class FullmagClientError(Exception):
    """Base class for every error raised by the live client."""


class FullmagConnectionError(FullmagClientError, ConnectionError):
    """The API could not be reached (refused, reset, DNS, TLS or timeout)."""

    def __init__(self, url: str, reason: str) -> None:
        super().__init__(
            f"cannot reach Fullmag at {url}: {reason}. "
            "Start a Docker DEV group (`just docker-dev`) and pass its frontend origin "
            "to fm.connect(url=...) or FULLMAG_URL."
        )
        self.url = url
        self.reason = reason


class RequestValidationError(FullmagClientError, ValueError):
    """A request payload failed local validation before it was sent."""


class ApiError(FullmagClientError):
    """The API answered with a structured error (``ApiErrorResponse``)."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        method: str = "",
        path: str = "",
        request_id: Optional[str] = None,
        payload: Optional[Mapping[str, Any]] = None,
    ) -> None:
        location = f" ({method} {path})" if method or path else ""
        super().__init__(f"{status} {code}: {message}{location}")
        self.status = status
        self.code = code
        self.message = message
        self.method = method
        self.path = path
        self.request_id = request_id
        self.payload: Mapping[str, Any] = payload or {}

    @property
    def diagnostics(self) -> list[Any]:
        diagnostics = self.payload.get("diagnostics")
        return list(diagnostics) if isinstance(diagnostics, list) else []


class NotFoundError(ApiError):
    """404: the resource or the current session does not exist."""


class ValidationError(ApiError):
    """400: the server rejected the request payload."""


class UnsupportedCapabilityError(ApiError):
    """422: the request needs a capability the selected execution lane lacks."""


class StaleRevisionError(ApiError):
    """409 ``revision_conflict``: another client changed the scene first."""


class InputLockedError(ApiError):
    """409 ``accepted_execution_input_locked``: inputs are locked by an active run."""


class SessionExistsError(ApiError):
    """409: a current session exists and ``replace_current`` was not set."""


class DevelopmentRestartError(ApiError):
    """409 ``development_restart_in_progress`` persisted beyond the retry budget."""


class CommandFailedError(FullmagClientError):
    """A runtime command finished as rejected, failed or cancelled."""

    def __init__(self, command_id: str, kind: str, status: str, completion: Optional[str], reason: Optional[str]) -> None:
        detail = f": {reason}" if reason else ""
        super().__init__(f"command {kind} ({command_id}) ended as {completion or status}{detail}")
        self.command_id = command_id
        self.kind = kind
        self.status = status
        self.completion = completion
        self.reason = reason


class CommandTimeoutError(FullmagClientError, TimeoutError):
    """Waiting for a runtime command exceeded the caller's timeout."""

    def __init__(self, command_id: str, kind: str, status: str, timeout: float) -> None:
        super().__init__(f"command {kind} ({command_id}) still {status} after {timeout:g} s")
        self.command_id = command_id
        self.kind = kind
        self.status = status
        self.timeout = timeout


_BY_CODE: dict[str, type[ApiError]] = {
    "revision_conflict": StaleRevisionError,
    "accepted_execution_input_locked": InputLockedError,
    "session_already_active": SessionExistsError,
    "development_restart_in_progress": DevelopmentRestartError,
}


def error_from_response(
    status: int,
    body: Any,
    *,
    method: str = "",
    path: str = "",
) -> ApiError:
    """Build the most specific :class:`ApiError` for an error response body."""
    payload: Mapping[str, Any] = body if isinstance(body, Mapping) else {}
    code = str(payload.get("code") or _default_code(status))
    message = str(payload.get("message") or payload.get("error") or (body if isinstance(body, str) else "") or "")
    request_id = payload.get("request_id")
    cls = _BY_CODE.get(code)
    if cls is None:
        if status == 409 and message.startswith(_SESSION_EXISTS_MESSAGE):
            cls = SessionExistsError
        elif status == 404:
            cls = NotFoundError
        elif status == 400:
            cls = ValidationError
        elif status == 422:
            cls = UnsupportedCapabilityError
        else:
            cls = ApiError
    return cls(
        status,
        code,
        message or f"HTTP {status}",
        method=method,
        path=path,
        request_id=str(request_id) if request_id is not None else None,
        payload=payload,
    )


def _default_code(status: int) -> str:
    return {
        400: "bad_request",
        404: "not_found",
        409: "conflict",
        422: "unsupported_capability",
        429: "too_many_requests",
        503: "service_unavailable",
    }.get(status, "http_error")
