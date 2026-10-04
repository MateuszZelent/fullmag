"""Deterministic JSON encoding for authoring and ProblemIR identities."""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping
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


def _canonical_authoring_float(value: float) -> str:
    if not math.isfinite(value):
        raise ValueError("authoring model numbers must be finite")
    if value == 0.0:
        return "-0e0" if math.copysign(1.0, value) < 0.0 else "0e0"

    rendered = repr(value)
    sign = "-" if rendered.startswith("-") else ""
    unsigned = rendered[1:] if sign else rendered
    mantissa, separator, exponent_text = unsigned.partition("e")
    exponent = int(exponent_text) if separator else 0
    whole, _, fraction = mantissa.partition(".")
    digits = whole + fraction
    decimal_position = len(whole) + exponent

    leading_zeros = len(digits) - len(digits.lstrip("0"))
    digits = digits[leading_zeros:]
    decimal_position -= leading_zeros
    digits = digits.rstrip("0") or "0"

    coefficient = digits[0]
    if len(digits) > 1:
        coefficient += f".{digits[1:]}"
    return f"{sign}{coefficient}e{decimal_position - 1}"


def canonical_authoring_json_bytes(value: Any) -> bytes:
    """Encode authoring-model JSON with normalized shortest float notation.

    Every floating-point value uses a shortest-round-trip significand and an
    unpadded decimal exponent. This keeps the authoring wire digest stable
    between Python and Rust without changing the established ProblemIR JSON
    identity contract above.
    """

    def encode(item: Any) -> str:
        if item is None:
            return "null"
        if item is True:
            return "true"
        if item is False:
            return "false"
        if isinstance(item, int):
            return str(item)
        if isinstance(item, float):
            return _canonical_authoring_float(item)
        if isinstance(item, str):
            return json.dumps(item, ensure_ascii=True, separators=(",", ":"))
        if isinstance(item, (list, tuple)):
            return "[" + ",".join(encode(child) for child in item) + "]"
        if isinstance(item, Mapping):
            if not all(isinstance(key, str) for key in item):
                raise TypeError("authoring model JSON object keys must be strings")
            return "{" + ",".join(
                f"{encode(key)}:{encode(item[key])}" for key in sorted(item)
            ) + "}"
        raise TypeError(f"unsupported authoring JSON value: {type(item).__name__}")

    return encode(value).encode("ascii")


def canonical_authoring_json_sha256(value: Any) -> str:
    """Return the SHA-256 digest of canonical authoring-model JSON bytes."""

    return hashlib.sha256(canonical_authoring_json_bytes(value)).hexdigest()
