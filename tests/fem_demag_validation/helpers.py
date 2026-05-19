"""Shared helpers for FEM demag validation scripts.

These utilities build FEM studies with sphere/ellipsoid/cylinder geometries
and produce CSV output for convergence analysis.
"""

from __future__ import annotations

import csv
import importlib
import math
from pathlib import Path
from typing import Sequence

MU0 = 4.0e-7 * math.pi


class ValidationFailure(RuntimeError):
    """Raised when a demag validation run does not meet acceptance criteria."""


def _row_label(row: dict, label_key: str | None, index: int) -> str:
    if label_key and label_key in row:
        return str(row[label_key])
    return f"row {index}"


def _fullmag():
    """Import fullmag only for runtime study builders."""
    return importlib.import_module("fullmag")


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


def require_grouped_error_improvement(
    rows: Sequence[dict],
    *,
    group_key: str,
    order_key: str,
    error_key: str,
) -> None:
    """Fail validation when each group does not improve from first to last row."""
    grouped: dict[str, list[dict]] = {}
    for row in rows:
        group = str(row.get(group_key, "unknown"))
        grouped.setdefault(group, []).append(row)

    if not grouped:
        raise ValidationFailure("validation produced no convergence groups")

    for group, group_rows in grouped.items():
        finite_rows = [
            row
            for row in group_rows
            if isinstance(row.get(order_key), (int, float))
            and isinstance(row.get(error_key), (int, float))
            and math.isfinite(float(row[order_key]))
            and math.isfinite(float(row[error_key]))
        ]
        finite_rows.sort(key=lambda row: float(row[order_key]))
        if len(finite_rows) < 2:
            raise ValidationFailure(f"{group}: not enough finite rows for convergence")

        first_error = float(finite_rows[0][error_key])
        last_error = float(finite_rows[-1][error_key])
        if last_error >= first_error:
            raise ValidationFailure(
                f"{group}: not convergent ({first_error * 100:.2f}% -> "
                f"{last_error * 100:.2f}%)"
            )


# ── Analytical references ───────────────────────────────────────────────


def effective_demag_factor_from_energy(
    *,
    e_demag: float,
    ms: float,
    volume: float,
) -> float:
    """Return the effective demag factor implied by uniform-state energy."""
    denominator = MU0 * float(ms) * float(ms) * float(volume)
    if denominator == 0.0 or not math.isfinite(denominator):
        return float("nan")
    return 2.0 * float(e_demag) / denominator


def sphere_demag_factor() -> float:
    """Exact demagnetizing factor for a sphere: N = 1/3."""
    return 1.0 / 3.0


def ellipsoid_demag_factors(
    a: float, b: float, c: float
) -> tuple[float, float, float]:
    """Osborn demagnetizing factors for a general ellipsoid (a >= b >= c).

    Uses the integral representation with Carlson elliptic integrals
    approximated via numerical quadrature (Simpson).

    Parameters
    ----------
    a, b, c : float
        Semi-axes in metres.  Order does not matter; they are sorted internally.

    Returns
    -------
    (Na, Nb, Nc) : tuple of float
        Demagnetizing factors along the sorted semi-axes (descending).
        Sum should be ~1.0.
    """
    axes = sorted([a, b, c], reverse=True)
    a_, b_, c_ = axes

    # Numerical integration of N_i = (abc/2) ∫₀^∞ ds / [(s+a²)·R(s)]
    # where R(s) = sqrt((s+a²)(s+b²)(s+c²))
    n_points = 2000
    s_max = 100.0 * a_ * a_  # upper limit for the integral
    ds = s_max / n_points

    na = nb = nc = 0.0
    for i in range(n_points + 1):
        s = i * ds
        w = 1.0 if (i == 0 or i == n_points) else (4.0 if i % 2 == 1 else 2.0)
        r = math.sqrt((s + a_ * a_) * (s + b_ * b_) * (s + c_ * c_))
        if r < 1e-300:
            continue
        na += w * ds / (3.0 * (s + a_ * a_) * r)
        nb += w * ds / (3.0 * (s + b_ * b_) * r)
        nc += w * ds / (3.0 * (s + c_ * c_) * r)

    factor = a_ * b_ * c_ / 2.0
    na *= factor
    nb *= factor
    nc *= factor
    return (na, nb, nc)


def analytical_demag_energy_sphere(ms: float, radius: float) -> float:
    """Analytical demag energy for a uniformly magnetized sphere.

    E_demag = (μ₀/2) · N · Ms² · V  where N = 1/3.
    """
    volume = (4.0 / 3.0) * math.pi * radius ** 3
    n = sphere_demag_factor()
    return 0.5 * MU0 * n * ms * ms * volume


def analytical_demag_field_sphere(ms: float) -> float:
    """Analytical internal H_demag for a uniformly magnetized sphere.

    H_demag = -N · Ms = -Ms/3.
    """
    return -sphere_demag_factor() * ms


# ── Study builders ──────────────────────────────────────────────────────


def build_fem_sphere_study(
    *,
    problem_name: str,
    radius: float,
    hmax: float,
    ms: float,
    aex: float,
    alpha: float = 0.5,
    demag_realization: str = "poisson_robin",
    universe_scale: float = 3.0,
    airbox_hmax_factor: float = 4.0,
    m_direction: tuple[float, float, float] = (0.0, 0.0, 1.0),
):
    """Create a FEM study with a sphere geometry for demag validation."""
    fm = _fullmag()
    fm.reset()
    study = fm.study(problem_name)
    study.engine("fem")
    study.device("cpu", precision="double")

    diameter = 2.0 * radius
    uni_span = diameter * universe_scale
    study.universe(
        mode="auto",
        size=(uni_span, uni_span, uni_span),
        center=(0.0, 0.0, 0.0),
        padding=(0.0, 0.0, 0.0),
    )
    study.universe.mesh(maximum_element_size=hmax * airbox_hmax_factor)
    study.interactive(True)

    body = study.geometry(
        fm.Sphere(radius=radius, name="sphere"),
        name="sphere",
    )
    body.Ms = float(ms)
    body.Aex = float(aex)
    body.alpha = float(alpha)
    body.m = fm.texture.uniform(m_direction)

    study.objects.mesh.defaults(
        algorithm_2d=6,
        algorithm_3d=1,
        size_factor=1,
        size_from_curvature=0,
        smoothing_steps=1,
        optimize_iterations=1,
        narrow_regions=0,
        compute_quality=False,
        per_element_quality=False,
    )
    body.mesh(
        maximum_element_size=float(hmax),
        order=1,
        algorithm_2d=1,
        algorithm_3d=1,
        size_factor=1,
        size_from_curvature=0,
        smoothing_steps=1,
        optimize_iterations=1,
        narrow_regions=0,
        compute_quality=False,
        per_element_quality=False,
    )
    study.build_domain_mesh()
    study.demag(realization=demag_realization)
    study.solver(max_error=1e-6, integrator="rk45")
    study.save("E_total", every=1.0)
    return study, body


def build_fem_ellipsoid_study(
    *,
    problem_name: str,
    rx: float,
    ry: float,
    rz: float,
    hmax: float,
    ms: float,
    aex: float,
    alpha: float = 0.5,
    demag_realization: str = "poisson_robin",
    universe_scale: float = 3.0,
    airbox_hmax_factor: float = 4.0,
    m_direction: tuple[float, float, float] = (0.0, 0.0, 1.0),
):
    """Create a FEM study with an ellipsoid geometry for demag validation."""
    fm = _fullmag()
    fm.reset()
    study = fm.study(problem_name)
    study.engine("fem")
    study.device("cpu", precision="double")

    max_dim = 2.0 * max(rx, ry, rz)
    uni_span = max_dim * universe_scale
    study.universe(
        mode="auto",
        size=(uni_span, uni_span, uni_span),
        center=(0.0, 0.0, 0.0),
        padding=(0.0, 0.0, 0.0),
    )
    study.universe.mesh(maximum_element_size=hmax * airbox_hmax_factor)
    study.interactive(True)

    body = study.geometry(
        fm.Ellipsoid(rx=rx, ry=ry, rz=rz, name="ellipsoid"),
        name="ellipsoid",
    )
    body.Ms = float(ms)
    body.Aex = float(aex)
    body.alpha = float(alpha)
    body.m = fm.texture.uniform(m_direction)

    study.objects.mesh.defaults(
        algorithm_2d=6,
        algorithm_3d=1,
        size_factor=1,
        size_from_curvature=0,
        smoothing_steps=1,
        optimize_iterations=1,
        narrow_regions=0,
        compute_quality=False,
        per_element_quality=False,
    )
    body.mesh(
        maximum_element_size=float(hmax),
        order=1,
        algorithm_2d=1,
        algorithm_3d=1,
        size_factor=1,
        size_from_curvature=0,
        smoothing_steps=1,
        optimize_iterations=1,
        narrow_regions=0,
        compute_quality=False,
        per_element_quality=False,
    )
    study.build_domain_mesh()
    study.demag(realization=demag_realization)
    study.solver(max_error=1e-6, integrator="rk45")
    study.save("E_total", every=1.0)
    return study, body


# ── Output helpers ──────────────────────────────────────────────────────


def write_csv(path: Path, rows: list[dict], field_order: Sequence[str] | None = None) -> None:
    """Write rows to CSV with consistent column ordering."""
    if not rows:
        raise ValueError(f"cannot write empty CSV: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    if field_order is None:
        field_order = list(rows[0].keys())
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(field_order))
        writer.writeheader()
        writer.writerows(rows)
    print(f"  Written: {path}")


def extract_demag_from_result(result) -> dict[str, float]:
    """Extract demag-relevant metrics from a relax/run result."""
    steps = getattr(result, "steps", None)
    if not steps:
        nan = float("nan")
        return {
            "e_demag_J": nan,
            "e_total_J": nan,
            "max_h_demag_Apm": nan,
            "demag_wall_time_ns": nan,
        }
    last = steps[-1]
    return {
        "e_demag_J": float(getattr(last, "e_demag", float("nan"))),
        "e_total_J": float(getattr(last, "e_total", float("nan"))),
        "max_h_demag_Apm": float(getattr(last, "max_h_demag", float("nan"))),
        "demag_wall_time_ns": float(getattr(last, "demag_wall_time_ns", 0)),
    }


def average_m(result) -> tuple[float, float, float]:
    """Average magnetization from final state."""
    final = getattr(result, "final_magnetization", None)
    if final is None:
        return (float("nan"), float("nan"), float("nan"))
    values = getattr(final, "values", final)
    if values is None:
        return (float("nan"), float("nan"), float("nan"))
    sx = sy = sz = 0.0
    n = 0
    for v in values:
        sx += float(v[0])
        sy += float(v[1])
        sz += float(v[2])
        n += 1
    if n == 0:
        return (float("nan"), float("nan"), float("nan"))
    return (sx / n, sy / n, sz / n)
