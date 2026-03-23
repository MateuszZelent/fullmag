from __future__ import annotations

from pathlib import Path
from typing import Iterable, Sequence


def require_non_empty(value: str, field_name: str) -> str:
    text = value.strip()
    if not text:
        raise ValueError(f"{field_name} must not be empty")
    return text


def require_positive(value: float, field_name: str) -> float:
    if value <= 0.0:
        raise ValueError(f"{field_name} must be positive")
    return value


def require_positive_int(value: int, field_name: str) -> int:
    if value <= 0:
        raise ValueError(f"{field_name} must be a positive integer")
    return int(value)


def require_non_negative(value: float, field_name: str) -> float:
    if value < 0.0:
        raise ValueError(f"{field_name} must be non-negative")
    return value


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
    return "unknown"


def ensure_unique_names(names: Iterable[str], field_name: str) -> None:
    seen: set[str] = set()
    duplicates = {name for name in names if name in seen or seen.add(name)}
    if duplicates:
        joined = ", ".join(sorted(duplicates))
        raise ValueError(f"{field_name} must be unique; duplicates: {joined}")
