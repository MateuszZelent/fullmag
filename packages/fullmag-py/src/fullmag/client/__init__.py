"""Live-session client for a running Fullmag instance (ADR 0068).

``fullmag.client`` speaks the typed v2 API through the standard library only.
The live DSL mode (``fm.connect()``) uses it internally; it is also public for
advanced use.
"""
from __future__ import annotations

from .client import DEFAULT_URL, URL_ENV as URL_ENV_NAME, Client, resolve_url
from .commands import CommandHandle, Target, new_intent_id
from .errors import (
    ApiError,
    CommandFailedError,
    CommandTimeoutError,
    DevelopmentRestartError,
    FullmagClientError,
    FullmagConnectionError,
    InputLockedError,
    NotFoundError,
    RequestValidationError,
    SessionExistsError,
    StaleRevisionError,
    UnsupportedCapabilityError,
    ValidationError,
)

__all__ = [
    "ApiError",
    "Client",
    "CommandFailedError",
    "CommandHandle",
    "CommandTimeoutError",
    "DEFAULT_URL",
    "URL_ENV_NAME",
    "DevelopmentRestartError",
    "FullmagClientError",
    "FullmagConnectionError",
    "InputLockedError",
    "NotFoundError",
    "RequestValidationError",
    "SessionExistsError",
    "StaleRevisionError",
    "Target",
    "UnsupportedCapabilityError",
    "ValidationError",
    "new_intent_id",
    "resolve_url",
]
