"""Runtime checks of request payloads against the generated OpenAPI tables."""
from __future__ import annotations

from typing import Any, Mapping

from ._generated.models import DISCRIMINATED_UNIONS, REQUIRED_FIELDS
from .errors import RequestValidationError

__all__ = ["validate_payload"]


def validate_payload(schema: str, payload: Any) -> None:
    """Check required fields and the ``kind`` discriminator of ``payload``.

    Only the top level is checked: nested documents (scene, geometry) come from
    the DSL's canonical converters and are validated by the server.
    """
    if not isinstance(payload, Mapping):
        raise RequestValidationError(f"{schema} payload must be a mapping, got {type(payload).__name__}")
    label = schema
    union = DISCRIMINATED_UNIONS.get(schema)
    if union is not None:
        field = union["field"]
        kind = payload.get(field)
        variants: Mapping[str, str] = union["variants"]
        if kind not in variants:
            allowed = ", ".join(sorted(variants))
            raise RequestValidationError(f"{schema}.{field} must be one of [{allowed}], got {kind!r}")
        label = f"{schema} ({field}={kind!r})"
        schema = variants[kind]
    required = REQUIRED_FIELDS.get(schema)
    if required is None:
        return
    missing = sorted(name for name in required if name not in payload)
    if missing:
        raise RequestValidationError(f"{label} is missing required field(s): {', '.join(missing)}")
