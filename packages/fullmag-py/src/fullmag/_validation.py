from __future__ import annotations

import math
import numbers
from pathlib import Path
from typing import Any, Iterable, Literal, Sequence


SamplingPeriod = float | Literal["auto"]
AUTO_SINC_NYQUIST_GUARD_FACTOR = 1.3


class TypedValidationError(ValueError):
    """Value error carrying a stable machine-readable field path."""

    def __init__(
        self,
        *,
        code: str,
        pointer: str,
        message: str,
        value: Any = None,
    ) -> None:
        self.code = str(code)
        self.pointer = str(pointer)
        self.value = value
        super().__init__(f"{self.code} at {self.pointer}: {message}")


def parse_finite_float(
    value: object,
    pointer: str,
    *,
    positive: bool = False,
    non_negative: bool = False,
    allow_none: bool = False,
    allow_numeric_string: bool = False,
) -> float | None:
    """Parse a finite scalar without bool or fractional coercion surprises."""
    if value is None and allow_none:
        return None
    if isinstance(value, bool):
        raise TypedValidationError(
            code="numeric_type_error",
            pointer=pointer,
            message="boolean is not a numeric mesh value",
            value=value,
        )
    if isinstance(value, str):
        if not allow_numeric_string:
            raise TypedValidationError(
                code="numeric_type_error",
                pointer=pointer,
                message="numeric strings are not accepted by the typed contract",
                value=value,
            )
        candidate_text = value.strip()
        if not candidate_text:
            raise TypedValidationError(
                code="numeric_value_error",
                pointer=pointer,
                message="value must not be empty",
                value=value,
            )
        try:
            candidate = float(candidate_text)
        except (TypeError, ValueError, OverflowError) as exc:
            raise TypedValidationError(
                code="numeric_value_error",
                pointer=pointer,
                message="value must be a finite number",
                value=value,
            ) from exc
    elif isinstance(value, numbers.Real):
        try:
            candidate = float(value)
        except (TypeError, ValueError, OverflowError) as exc:
            raise TypedValidationError(
                code="numeric_type_error",
                pointer=pointer,
                message="value cannot be converted to a float",
                value=type(value).__name__,
            ) from exc
    else:
        raise TypedValidationError(
            code="numeric_type_error",
            pointer=pointer,
            message="value must be a real number",
            value=type(value).__name__,
        )
    if not math.isfinite(candidate):
        raise TypedValidationError(
            code="numeric_nonfinite",
            pointer=pointer,
            message="value must be finite",
            value=candidate,
        )
    if positive and candidate <= 0.0:
        raise TypedValidationError(
            code="numeric_range_error",
            pointer=pointer,
            message="value must be strictly positive",
            value=candidate,
        )
    if non_negative and candidate < 0.0:
        raise TypedValidationError(
            code="numeric_range_error",
            pointer=pointer,
            message="value must be non-negative",
            value=candidate,
        )
    return candidate


def parse_integer(
    value: object,
    pointer: str,
    *,
    minimum: int | None = None,
    allow_none: bool = False,
    allow_numeric_string: bool = False,
) -> int | None:
    """Parse an integer while rejecting bools and fractional values."""
    if value is None and allow_none:
        return None
    if isinstance(value, bool):
        raise TypedValidationError(
            code="integer_type_error",
            pointer=pointer,
            message="boolean is not an integer mesh value",
            value=value,
        )
    candidate: int
    if isinstance(value, str):
        if not allow_numeric_string:
            raise TypedValidationError(
                code="integer_type_error",
                pointer=pointer,
                message="numeric strings are not accepted by the typed contract",
                value=value,
            )
        text = value.strip()
        try:
            candidate = int(text)
        except (TypeError, ValueError, OverflowError) as exc:
            raise TypedValidationError(
                code="integer_value_error",
                pointer=pointer,
                message="value must be an integer without a fractional part",
                value=value,
            ) from exc
    elif isinstance(value, numbers.Integral):
        candidate = int(value)
    elif isinstance(value, numbers.Real):
        numeric = float(value)
        if not math.isfinite(numeric) or not numeric.is_integer():
            raise TypedValidationError(
                code="integer_value_error",
                pointer=pointer,
                message="value must be a finite integer without truncation",
                value=value,
            )
        candidate = int(numeric)
    else:
        raise TypedValidationError(
            code="integer_type_error",
            pointer=pointer,
            message="value must be an integer",
            value=type(value).__name__,
        )
    if minimum is not None and candidate < minimum:
        raise TypedValidationError(
            code="integer_range_error",
            pointer=pointer,
            message=f"value must be >= {minimum}",
            value=candidate,
        )
    return candidate


def parse_bool(value: object, pointer: str, *, allow_none: bool = False) -> bool | None:
    """Parse a strict JSON/Python boolean."""
    if value is None and allow_none:
        return None
    if not isinstance(value, bool):
        raise TypedValidationError(
            code="boolean_type_error",
            pointer=pointer,
            message="value must be boolean",
            value=type(value).__name__,
        )
    return value


def parse_vector3(
    value: object,
    pointer: str,
    *,
    allow_numeric_string: bool = False,
) -> tuple[float, float, float]:
    """Parse exactly three finite scalar components."""
    if isinstance(value, (str, bytes)):
        raise TypedValidationError(
            code="vector_type_error",
            pointer=pointer,
            message="value must be a sequence of exactly three numbers",
            value=type(value).__name__,
        )
    try:
        components = list(value)  # type: ignore[arg-type]
    except TypeError as exc:
        raise TypedValidationError(
            code="vector_type_error",
            pointer=pointer,
            message="value must be a sequence of exactly three numbers",
            value=type(value).__name__,
        ) from exc
    if len(components) != 3:
        raise TypedValidationError(
            code="vector_length_error",
            pointer=pointer,
            message="value must contain exactly three components",
            value=len(components),
        )
    parsed = tuple(
        parse_finite_float(
            component,
            f"{pointer}/{index}",
            allow_numeric_string=allow_numeric_string,
        )
        for index, component in enumerate(components)
    )
    return parsed  # type: ignore[return-value]


def auto_sinc_sampling_policy_ir() -> dict[str, object]:
    return {
        "kind": "auto_sinc_cutoff",
        "nyquist_guard_factor": AUTO_SINC_NYQUIST_GUARD_FACTOR,
    }


def normalize_sampling_period(value: object, name: str) -> SamplingPeriod:
    if isinstance(value, str) and value == "auto":
        return "auto"
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f'{name} must be positive finite number or "auto"')
    period = float(value)
    if not math.isfinite(period) or period <= 0.0:
        raise ValueError(f'{name} must be positive finite number or "auto"')
    return period


def require_non_empty(value: str, field_name: str) -> str:
    text = value.strip()
    if not text:
        raise ValueError(f"{field_name} must not be empty")
    return text


def require_positive(value: float, field_name: str) -> float:
    numeric = float(value)
    if not math.isfinite(numeric):
        raise ValueError(f"{field_name} must be finite and positive")
    if numeric <= 0.0:
        raise ValueError(f"{field_name} must be positive")
    return numeric


def require_finite(value: float, field_name: str) -> float:
    numeric = float(value)
    if not math.isfinite(numeric):
        raise ValueError(f"{field_name} must be finite")
    return numeric


def require_positive_int(value: int, field_name: str) -> int:
    import numbers

    if isinstance(value, bool) or not isinstance(value, numbers.Integral):
        raise TypeError(f"{field_name} must be an integer, got {type(value).__name__}")
    if value <= 0:
        raise ValueError(f"{field_name} must be a positive integer")
    return int(value)


def require_non_negative(value: float, field_name: str) -> float:
    numeric = float(value)
    if not math.isfinite(numeric) or numeric < 0.0:
        raise ValueError(f"{field_name} must be finite and non-negative")
    return numeric


def as_vector3(value: Sequence[float], field_name: str) -> tuple[float, float, float]:
    if len(value) != 3:
        raise ValueError(f"{field_name} must contain exactly 3 values")
    return (float(value[0]), float(value[1]), float(value[2]))


def infer_geometry_format(source: str) -> str:
    suffix = Path(source).suffix.lower()
    if suffix == ".step" or suffix == ".stp":
        return "step"
    if suffix == ".stl":
        return "stl"
    if suffix == ".msh":
        return "msh"
    if suffix == ".npz":
        return "npz_asset"
    return "unknown"


def ensure_unique_names(names: Iterable[str], field_name: str) -> None:
    seen: set[str] = set()
    duplicates = {name for name in names if name in seen or seen.add(name)}
    if duplicates:
        joined = ", ".join(sorted(duplicates))
        raise ValueError(f"{field_name} must be unique; duplicates: {joined}")
