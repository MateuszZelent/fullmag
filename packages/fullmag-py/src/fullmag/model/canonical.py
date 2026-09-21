"""Deterministic JSON encoding for authoring and ProblemIR identities."""

from __future__ import annotations

import hashlib
import json
from typing import Any


def canonical_json_bytes(value: Any) -> bytes:
    """Encode JSON with the stable byte contract used by ProblemIR identities.

    The authoring model must not depend on mapping insertion order or optional
    whitespace. Non-finite numbers are rejected instead of being emitted as
    non-standard JSON tokens, so an identity digest is portable across
    Python/Rust consumers.
    """

    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")


def canonical_json_sha256(value: Any) -> str:
    """Return the SHA-256 digest of :func:`canonical_json_bytes`."""

    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()

