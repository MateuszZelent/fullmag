"""Shared utilities for µMAG-style physical tests written with Fullmag's study API."""

from __future__ import annotations

import csv
import math
from pathlib import Path
from typing import Iterable, Sequence

import fullmag as fm

MU0 = 4.0e-7 * math.pi


def unit(vec: Sequence[float]) -> tuple[float, float, float]:
    x, y, z = (float(vec[0]), float(vec[1]), float(vec[2]))
    norm = math.sqrt(x * x + y * y + z * z)
    if norm <= 0.0:
        raise ValueError(f"cannot normalize zero-length vector: {vec!r}")
    return (x / norm, y / norm, z / norm)


def dot(a: Sequence[float], b: Sequence[float]) -> float:
    return float(a[0]) * float(b[0]) + float(a[1]) * float(b[1]) + float(a[2]) * float(b[2])


def linspace_step(start: float, stop: float, step: float) -> list[float]:
    """Inclusive float range for values known to be aligned to the step."""
    if step == 0.0:
        raise ValueError("step must be non-zero")
    delta = stop - start
    if delta == 0.0:
        return [float(start)]
    if delta * step < 0.0:
        raise ValueError(f"step={step} moves away from stop={stop}")
    count = int(round(delta / step))
    values = [start + i * step for i in range(count + 1)]
    values[-1] = float(stop)
    return [float(value) for value in values]


def interpolate_zero(x0: float, y0: float, x1: float, y1: float) -> float:
    if math.isclose(y0, y1):
        return 0.5 * (x0 + x1)
    return x0 + (0.0 - y0) * (x1 - x0) / (y1 - y0)


def vectors_from_state(state_or_values: object) -> list[tuple[float, float, float]]:
    values = getattr(state_or_values, "values", state_or_values)
    if values is None:
        raise RuntimeError("magnetization state is empty")
    resolved: list[tuple[float, float, float]] = []
    for value in values:
        resolved.append((float(value[0]), float(value[1]), float(value[2])))
    if not resolved:
        raise RuntimeError("magnetization state does not contain any samples")
    return resolved


def average_vector(state_or_values: object) -> tuple[float, float, float]:
    vectors = vectors_from_state(state_or_values)
    sx = sy = sz = 0.0
    for mx, my, mz in vectors:
        sx += mx
        sy += my
        sz += mz
    inv_n = 1.0 / float(len(vectors))
    return (sx * inv_n, sy * inv_n, sz * inv_n)


def ensure_final_state(result: object, context: str) -> list[tuple[float, float, float]]:
    final_state = getattr(result, "final_magnetization", None)
    if final_state is None:
        status = getattr(result, "status", None)
        notes = tuple(getattr(result, "notes", ()) or ())
        details = f"status={status!r}"
        if notes:
            details += f", notes={'; '.join(str(note) for note in notes)}"
        raise RuntimeError(f"{context}: simulation did not return final magnetization ({details})")
    return vectors_from_state(final_state)


def final_step_metrics(result: object) -> dict[str, float]:
    step = None
    steps = getattr(result, "steps", None)
    if steps:
        step = steps[-1]
    if step is None:
        nan = float("nan")
        return {
            "time_s": nan,
            "solver_dt_s": nan,
            "e_ex_J": nan,
            "e_demag_J": nan,
            "e_ext_J": nan,
            "e_ani_J": nan,
            "e_total_J": nan,
            "max_dm_dt": nan,
            "max_h_eff_Apm": nan,
        }
    return {
        "time_s": float(getattr(step, "time", float("nan"))),
        "solver_dt_s": float(getattr(step, "dt", float("nan"))),
        "e_ex_J": float(getattr(step, "e_ex", float("nan"))),
        "e_demag_J": float(getattr(step, "e_demag", float("nan"))),
        "e_ext_J": float(getattr(step, "e_ext", float("nan"))),
        "e_ani_J": float(getattr(step, "e_ani", float("nan"))),
        "e_total_J": float(getattr(step, "e_total", float("nan"))),
        "max_dm_dt": float(getattr(step, "max_dm_dt", float("nan"))),
        "max_h_eff_Apm": float(getattr(step, "max_h_eff", float("nan"))),
    }


def save_state(result: object, path: Path, *, format: str = "zarr") -> Path:
    save_method = getattr(result, "save_state", None)
    if save_method is None:
        raise RuntimeError(
            "The returned object does not expose save_state(). "
            "Run these scripts via direct Python execution against fullmag-py-core."
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    return Path(save_method(path, format=format))


def write_rows(path: Path, rows: Iterable[dict[str, object]], field_order: Sequence[str] | None = None) -> None:
    materialized = list(rows)
    if not materialized:
        raise ValueError(f"cannot write empty CSV: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    if field_order is None:
        field_order = list(materialized[0].keys())
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(field_order))
        writer.writeheader()
        writer.writerows(materialized)


def next_power_of_two(n: int) -> int:
    if n <= 1:
        return 1
    return 1 << (n - 1).bit_length()


def cells_for_max_cell(length: float, max_cell: float, *, minimum: int = 1) -> int:
    if length <= 0.0:
        raise ValueError("length must be positive")
    if max_cell <= 0.0:
        raise ValueError("max_cell must be positive")
    raw = max(minimum, int(math.ceil(length / max_cell)))
    return next_power_of_two(raw)


def build_fdm_box_study(
    *,
    problem_name: str,
    size: Sequence[float],
    cell: Sequence[float],
    ms: float,
    aex: float,
    alpha: float,
    initial_m: object,
    ku1: float | None = None,
    anis_u: Sequence[float] | None = None,
    dt: float | None = None,
    max_error: float | None = None,
    integrator: str | None = "rk45",
    geometry_name: str = "body",
    boundary_correction: str | None = None,
):
    """Create a fresh FDM study with one rectangular body and minimal output."""
    fm.reset()
    study = fm.study(problem_name)
    study.engine("fdm")
    study.device("cpu", precision="double")
    study.cell(float(cell[0]), float(cell[1]), float(cell[2]))
    if boundary_correction is not None:
        study.boundary_correction(boundary_correction)
    body = study.geometry(
        fm.Box(size=(float(size[0]), float(size[1]), float(size[2])), name=geometry_name),
        name=geometry_name,
    )
    body.Ms = float(ms)
    body.Aex = float(aex)
    body.alpha = float(alpha)
    if ku1 is not None:
        body.Ku1 = float(ku1)
    if anis_u is not None:
        body.anisU = (float(anis_u[0]), float(anis_u[1]), float(anis_u[2]))
    body.m = initial_m
    study.demag()
    solver_kwargs = {}
    if dt is not None:
        solver_kwargs["dt"] = float(dt)
    if max_error is not None:
        solver_kwargs["max_error"] = float(max_error)
    if integrator is not None:
        solver_kwargs["integrator"] = str(integrator)
    if solver_kwargs:
        study.solver(**solver_kwargs)
    # Register one slow scalar output so the runtime does not fall back to
    # the default m-field autosave on every sub-run.
    study.save("E_total", every=1.0)
    return study, body


def build_fem_box_study(
    *,
    problem_name: str,
    size: Sequence[float],
    hmax: float,
    ms: float,
    aex: float,
    alpha: float,
    initial_m: object,
    ku1: float | None = None,
    anis_u: Sequence[float] | None = None,
    order: int = 1,
    dt: float | None = None,
    max_error: float | None = None,
    integrator: str | None = "rk45",
    geometry_name: str = "body",
    demag_realization: str = "poisson_robin",
    universe_scale: float = 1.4,
    airbox_hmax: float | None = None,
):
    """Create a fresh FEM study with one box geometry and shared-domain mesh."""
    fm.reset()
    study = fm.study(problem_name)
    study.engine("fem")
    study.device("cpu", precision="double")

    sx = float(size[0])
    sy = float(size[1])
    sz = float(size[2])
    max_span = max(sx, sy, sz)
    study.universe(
        mode="auto",
        size=(sx * universe_scale, sy * universe_scale, max(max_span * universe_scale, sz * 4.0)),
        center=(0.0, 0.0, 0.0),
        padding=(0.0, 0.0, 0.0),
        airbox_hmax=float(airbox_hmax if airbox_hmax is not None else max(hmax * 4.0, max_span / 12.0)),
    )
    study.interactive(True)

    body = study.geometry(
        fm.Box(size=(sx, sy, sz), name=geometry_name),
        name=geometry_name,
    )
    body.Ms = float(ms)
    body.Aex = float(aex)
    body.alpha = float(alpha)
    if ku1 is not None:
        body.Ku1 = float(ku1)
    if anis_u is not None:
        body.anisU = (float(anis_u[0]), float(anis_u[1]), float(anis_u[2]))
    body.m = initial_m

    study.object_mesh_defaults(
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
        hmax=float(hmax),
        order=int(order),
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

    solver_kwargs = {}
    if dt is not None:
        solver_kwargs["dt"] = float(dt)
    if max_error is not None:
        solver_kwargs["max_error"] = float(max_error)
    if integrator is not None:
        solver_kwargs["integrator"] = str(integrator)
    if solver_kwargs:
        study.solver(**solver_kwargs)

    # Register one scalar output so repeated relax() calls do not trigger
    # expensive default field autosaves between hysteresis samples.
    study.save("E_total", every=1.0)
    return study, body


def relax_with_state(
    *,
    study,
    body,
    field: Sequence[float],
    state_path: Path,
    tol: float,
    max_steps: int,
    algorithm: str = "llg_overdamped",
    relax_alpha: float | None = 1.0,
) -> tuple[object, tuple[float, float, float], dict[str, float]]:
    study.b_ext(float(field[0]), float(field[1]), float(field[2]))
    result = study.relax(
        tolA=float(tol),
        max_steps=int(max_steps),
        algorithm=str(algorithm),
        relax_alpha=relax_alpha,
    )
    final_state = ensure_final_state(result, "relax")
    metrics = final_step_metrics(result)
    save_state(result, state_path, format="zarr")
    body.m = fm.load_magnetization(state_path, format="zarr")
    return result, average_vector(final_state), metrics


def run_with_state(
    *,
    study,
    body,
    field: Sequence[float],
    state_path: Path,
    until: float,
) -> tuple[object, tuple[float, float, float], dict[str, float]]:
    study.b_ext(float(field[0]), float(field[1]), float(field[2]))
    result = study.run(float(until))
    final_state = ensure_final_state(result, "run")
    metrics = final_step_metrics(result)
    save_state(result, state_path, format="zarr")
    body.m = fm.load_magnetization(state_path, format="zarr")
    return result, average_vector(final_state), metrics
