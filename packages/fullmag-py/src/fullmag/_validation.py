from __future__ import annotations

import math
import numbers
from pathlib import Path
from typing import Iterable, Sequence


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
