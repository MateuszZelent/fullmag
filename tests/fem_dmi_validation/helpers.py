"""Shared helpers for FEM DMI runtime-validation acceptance gates."""

from __future__ import annotations

import math
from typing import Sequence


class ValidationFailure(RuntimeError):
    """Raised when a DMI validation artifact misses acceptance criteria."""


def _label(row: dict, label_key: str | None, index: int) -> str:
    if label_key and label_key in row:
        return str(row[label_key])
    return f"row {index}"


def _finite_number(row: dict, key: str, label: str) -> float:
    value = row.get(key)
    if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise ValidationFailure(f"{label}: {key} is not finite")
    return float(value)


def _normalized_token(row: dict, key: str, label: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValidationFailure(f"{label}: {key} is not a nonempty string")
    return value.strip().casefold()


def require_chirality_matches(
    rows: Sequence[dict],
    *,
    expected_key: str = "expected_chirality",
    observed_key: str = "observed_chirality",
    label_key: str | None = None,
) -> None:
    """Fail unless each DMI runtime row reports the expected handedness."""
    if not rows:
        raise ValidationFailure("validation produced no DMI chirality rows")
    for index, row in enumerate(rows):
        label = _label(row, label_key, index)
        expected = _normalized_token(row, expected_key, label)
        observed = _normalized_token(row, observed_key, label)
        if observed != expected:
            raise ValidationFailure(
                f"{label}: chirality expected {expected!r} got {observed!r}"
            )


def require_spiral_pitch_matches_reference(
    row: dict,
    *,
    pitch_key: str,
    reference_key: str,
    relative_tolerance: float,
    label: str,
) -> None:
    """Fail unless signed DMI spiral pitch matches the reference sign and scale."""
    pitch = _finite_number(row, pitch_key, label)
    reference = _finite_number(row, reference_key, label)
    if reference == 0.0:
        raise ValidationFailure(f"{label}: {reference_key} must be nonzero")
    if pitch == 0.0 or math.copysign(1.0, pitch) != math.copysign(1.0, reference):
        raise ValidationFailure(
            f"{label}: spiral pitch sign differs from {reference_key}"
        )
    relative_error = abs(pitch - reference) / abs(reference)
    if relative_error > relative_tolerance:
        raise ValidationFailure(
            f"{label}: spiral pitch relative error {relative_error:.4f} "
            f"exceeds {relative_tolerance:.4f}"
        )


def require_boundary_tilt_signal(
    row: dict,
    *,
    tilted_key: str,
    baseline_key: str,
    min_tilt_abs: float,
    baseline_abs_tolerance: float,
    label: str,
) -> None:
    """Fail unless boundary tilt is nonzero while the uniform baseline is zero."""
    tilted = _finite_number(row, tilted_key, label)
    baseline = _finite_number(row, baseline_key, label)
    if abs(tilted) < min_tilt_abs:
        raise ValidationFailure(
            f"{label}: tilted boundary derivative {tilted:.6e} is below "
            f"{min_tilt_abs:.6e}"
        )
    if abs(baseline) > baseline_abs_tolerance:
        raise ValidationFailure(
            f"{label}: baseline boundary derivative {baseline:.6e} exceeds "
            f"{baseline_abs_tolerance:.6e}"
        )
