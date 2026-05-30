"""Shared helpers for FEM thermal runtime-validation acceptance gates."""

from __future__ import annotations

import math
from typing import Sequence

MU0 = 4.0e-7 * math.pi
KB = 1.380649e-23


class ValidationFailure(RuntimeError):
    """Raised when a thermal validation artifact misses acceptance criteria."""


def brown_sigma(
    *,
    temperature: float,
    damping: float,
    gamma_mu0: float,
    ms: float,
    volume: float,
    dt: float,
) -> float:
    """Return the Brown thermal-field standard deviation in A/m."""
    for name, value in {
        "temperature": temperature,
        "damping": damping,
        "gamma_mu0": gamma_mu0,
        "ms": ms,
        "volume": volume,
        "dt": dt,
    }.items():
        if not math.isfinite(float(value)) or float(value) <= 0.0:
            raise ValueError(f"{name} must be positive and finite, got {value}")

    gamma0 = float(gamma_mu0) * (1.0 + float(damping) * float(damping))
    return math.sqrt(
        2.0
        * float(damping)
        * KB
        * float(temperature)
        / (gamma0 * MU0 * float(ms) * float(volume) * float(dt))
    )


def brown_variance(
    *,
    temperature: float,
    damping: float,
    gamma_mu0: float,
    ms: float,
    volume: float,
    dt: float,
) -> float:
    """Return the Brown thermal-field variance in (A/m)^2."""
    sigma = brown_sigma(
        temperature=temperature,
        damping=damping,
        gamma_mu0=gamma_mu0,
        ms=ms,
        volume=volume,
        dt=dt,
    )
    return sigma * sigma


def _label(row: dict, label_key: str | None, index: int) -> str:
    if label_key and label_key in row:
        return str(row[label_key])
    return f"row {index}"


def _finite_number(row: dict, key: str, label: str) -> float:
    value = row.get(key)
    if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise ValidationFailure(f"{label}: {key} is not finite")
    return float(value)


def require_variance_matches_reference(
    rows: Sequence[dict],
    *,
    variance_key: str,
    reference_key: str,
    relative_tolerance: float,
    label_key: str | None = None,
) -> None:
    """Fail when sampled Brown variance misses the reference variance."""
    if not rows:
        raise ValidationFailure("validation produced no thermal variance rows")
    for index, row in enumerate(rows):
        label = _label(row, label_key, index)
        variance = _finite_number(row, variance_key, label)
        reference = _finite_number(row, reference_key, label)
        if reference <= 0.0:
            raise ValidationFailure(f"{label}: {reference_key} must be positive")
        relative_error = abs(variance - reference) / reference
        if relative_error > relative_tolerance:
            raise ValidationFailure(
                f"{label}: {variance_key} relative error {relative_error:.4f} "
                f"exceeds {relative_tolerance:.4f}"
            )


def require_inverse_dt_variance_scaling(
    rows: Sequence[dict],
    *,
    dt_key: str,
    variance_key: str,
    relative_tolerance: float,
) -> None:
    """Fail unless Brown variance scales inversely with accepted dt."""
    finite_rows = []
    for index, row in enumerate(rows):
        label = _label(row, "case", index)
        dt = _finite_number(row, dt_key, label)
        variance = _finite_number(row, variance_key, label)
        if dt <= 0.0 or variance <= 0.0:
            raise ValidationFailure(f"{label}: {dt_key} and {variance_key} must be positive")
        finite_rows.append((dt, variance))

    if len(finite_rows) < 2:
        raise ValidationFailure("inverse-dt variance scaling requires at least two rows")

    finite_rows.sort(key=lambda item: item[0])
    short_dt, short_variance = finite_rows[0]
    long_dt, long_variance = finite_rows[-1]
    observed_ratio = short_variance / long_variance
    expected_ratio = long_dt / short_dt
    relative_error = abs(observed_ratio - expected_ratio) / expected_ratio
    if relative_error > relative_tolerance:
        raise ValidationFailure(
            f"inverse-dt variance ratio {observed_ratio:.4f} differs from "
            f"{expected_ratio:.4f} by {relative_error:.4f}"
        )


def langevin(argument: float) -> float:
    """Return coth(x) - 1/x with a stable small-x expansion."""
    x = float(argument)
    if not math.isfinite(x):
        raise ValueError(f"langevin argument must be finite, got {argument}")
    if abs(x) < 1.0e-5:
        return x / 3.0 - (x**3) / 45.0 + 2.0 * (x**5) / 945.0
    return 1.0 / math.tanh(x) - 1.0 / x


def boltzmann_macrospin_parallel_mean(
    *,
    ms: float,
    volume: float,
    field_Apm: float,
    temperature: float,
) -> float:
    """Return the Langevin reference mean for a macrospin in a uniform field."""
    for name, value in {
        "ms": ms,
        "volume": volume,
        "temperature": temperature,
    }.items():
        if not math.isfinite(float(value)) or float(value) <= 0.0:
            raise ValueError(f"{name} must be positive and finite, got {value}")
    if not math.isfinite(float(field_Apm)):
        raise ValueError(f"field_Apm must be finite, got {field_Apm}")

    beta_energy = MU0 * float(ms) * float(volume) * float(field_Apm)
    return langevin(beta_energy / (KB * float(temperature)))


def require_boltzmann_macrospin_mean(
    row: dict,
    *,
    mean_key: str,
    ms_key: str,
    volume_key: str,
    field_key: str,
    temperature_key: str,
    absolute_tolerance: float,
    label: str,
) -> None:
    """Fail when a macrospin trajectory mean misses the Boltzmann reference."""
    observed = _finite_number(row, mean_key, label)
    expected = boltzmann_macrospin_parallel_mean(
        ms=_finite_number(row, ms_key, label),
        volume=_finite_number(row, volume_key, label),
        field_Apm=_finite_number(row, field_key, label),
        temperature=_finite_number(row, temperature_key, label),
    )
    if abs(observed - expected) > absolute_tolerance:
        raise ValidationFailure(
            f"{label}: Boltzmann macrospin mean {observed:.4f} differs from "
            f"{expected:.4f} by more than {absolute_tolerance:.4f}"
        )
