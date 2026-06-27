"""Shared helpers for FEM exchange runtime-validation scripts."""

from __future__ import annotations

import csv
import math
from pathlib import Path
from typing import Sequence

MU0 = 4.0e-7 * math.pi


class ValidationFailure(RuntimeError):
    """Raised when an exchange validation run does not meet acceptance criteria."""


def require_native_runtime_core() -> None:
    """Fail fast when the direct Python runtime bridge is unavailable."""
    try:
        from fullmag import _core
    except ImportError as exc:  # pragma: no cover - import wiring failure
        raise ValidationFailure(
            "runtime validation requires the fullmag Python package and PyO3 "
            "_fullmag_core bridge"
        ) from exc
    if getattr(_core, "_native_core", None) is None:
        raise ValidationFailure(
            "runtime validation requires PyO3 _fullmag_core built with the "
            "MFEM/libCEED runtime stack; use the managed CLI only for "
            "capture-stage smoke checks"
        )


def exchange_field_scale(*, aex: float, ms: float) -> float:
    """Return the exchange field prefactor 2A/(mu0 Ms) in A/m per Laplacian."""
    if aex <= 0.0:
        raise ValueError(f"aex must be positive, got {aex}")
    if ms <= 0.0:
        raise ValueError(f"ms must be positive, got {ms}")
    return 2.0 * float(aex) / (MU0 * float(ms))


def analytical_helical_exchange_amplitude(
    *,
    aex: float,
    ms: float,
    wavelength: float,
) -> float:
    """Analytical |H_ex| for m=(0, cos(kx), sin(kx)) on an exchange-only mesh."""
    if wavelength <= 0.0:
        raise ValueError(f"wavelength must be positive, got {wavelength}")
    k = 2.0 * math.pi / float(wavelength)
    return exchange_field_scale(aex=aex, ms=ms) * k * k


def analytical_helical_exchange_energy(
    *,
    aex: float,
    wavelength: float,
    volume: float,
) -> float:
    """Analytical E_ex = A k^2 V for a unit-amplitude helical state."""
    if aex <= 0.0:
        raise ValueError(f"aex must be positive, got {aex}")
    if wavelength <= 0.0:
        raise ValueError(f"wavelength must be positive, got {wavelength}")
    if volume <= 0.0:
        raise ValueError(f"volume must be positive, got {volume}")
    k = 2.0 * math.pi / float(wavelength)
    return float(aex) * k * k * float(volume)


def exchange_amplitude_from_energy(*, exchange_energy: float, ms: float, volume: float) -> float:
    """Return helical |H_ex| implied by exchange energy for E=A k^2 V."""
    if ms <= 0.0:
        raise ValueError(f"ms must be positive, got {ms}")
    if volume <= 0.0:
        raise ValueError(f"volume must be positive, got {volume}")
    return 2.0 * float(exchange_energy) / (MU0 * float(ms) * float(volume))


def relative_error(value: float, reference: float) -> float:
    """Return a finite relative error against a nonzero reference value."""
    if not math.isfinite(value):
        return float("nan")
    if not math.isfinite(reference) or abs(reference) <= 1e-300:
        return float("nan")
    return abs(float(value) - float(reference)) / abs(float(reference))


def _row_label(row: dict, label_key: str | None, index: int) -> str:
    if label_key and label_key in row:
        return str(row[label_key])
    return f"row {index}"


def require_finite_metrics(
    rows: Sequence[dict],
    metric_keys: Sequence[str],
    *,
    label_key: str | None = None,
) -> None:
    """Fail validation when any required metric is missing, nonnumeric, or NaN."""
    if not rows:
        raise ValidationFailure("validation produced no rows")
    for index, row in enumerate(rows):
        label = _row_label(row, label_key, index)
        for key in metric_keys:
            value = row.get(key)
            if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
                raise ValidationFailure(f"{label}: {key} is not finite")


def require_relative_error_below(
    row: dict,
    *,
    error_key: str,
    threshold: float,
    label: str,
) -> None:
    """Fail validation when one selected relative-error metric exceeds a bound."""
    value = row.get(error_key)
    if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise ValidationFailure(f"{label}: {error_key} is not finite")
    if float(value) >= threshold:
        raise ValidationFailure(
            f"{label}: {error_key}={float(value) * 100:.2f}% exceeds "
            f"{threshold * 100:.2f}%"
        )


def require_error_decreases_with_refinement(
    rows: Sequence[dict],
    *,
    hmax_key: str,
    error_key: str,
) -> None:
    """Fail validation unless the finest mesh improves over the coarsest mesh."""
    finite_rows = [
        row
        for row in rows
        if isinstance(row.get(hmax_key), (int, float))
        and isinstance(row.get(error_key), (int, float))
        and math.isfinite(float(row[hmax_key]))
        and math.isfinite(float(row[error_key]))
    ]
    finite_rows.sort(key=lambda row: float(row[hmax_key]), reverse=True)
    if len(finite_rows) < 2:
        raise ValidationFailure("not enough finite rows for refinement check")

    coarse = finite_rows[0]
    fine = finite_rows[-1]
    coarse_error = float(coarse[error_key])
    fine_error = float(fine[error_key])
    if fine_error >= coarse_error:
        raise ValidationFailure(
            f"not convergent ({coarse_error * 100:.2f}% -> {fine_error * 100:.2f}%)"
        )


def write_csv(path: Path, rows: list[dict], field_order: Sequence[str] | None = None) -> None:
    """Write validation rows to CSV with stable column ordering."""
    if not rows:
        raise ValueError(f"cannot write empty CSV: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    if field_order is None:
        field_order = list(rows[0].keys())
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(field_order))
        writer.writeheader()
        writer.writerows(rows)
    print(f"Written: {path}")
