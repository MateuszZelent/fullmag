"""Canonical Fullmag FEM script for µMAG Standard Problem #1 hysteresis.

Source: stdprob1_hysteresis_fem.py
Entrypoint: flat_workspace

This file is intentionally self-contained and follows the same study-root
pattern as ``examples/nanoflower_fem.py``.
"""

from __future__ import annotations

import csv
import math
from pathlib import Path

import fullmag as fm

SCRIPT_DIR = Path(__file__).resolve().parent

# ── Outputs ──────────────────────────────────────────────────────────────
LOOP_CSV = SCRIPT_DIR / "stdprob1_fem_loop.csv"
SUMMARY_CSV = SCRIPT_DIR / "stdprob1_fem_summary.csv"
CURRENT_STATE_ZARR = SCRIPT_DIR / "_stdprob1_fem_current_state.zarr.zip"

# ── Geometry ─────────────────────────────────────────────────────────────
SIZE_X = 1000e-9
SIZE_Y = 2000e-9
SIZE_Z = 20e-9
HMAX = 20e-9

# ── Material ─────────────────────────────────────────────────────────────
MS = 800e3
AEX = 13e-12
ALPHA = 0.02
KU1 = 5e2
ANIS_U = (0.0, 1.0, 0.0)

# ── Field Sweep ──────────────────────────────────────────────────────────
ANGLE_DEG = 1.0
ANGLE_RAD = math.radians(ANGLE_DEG)
B_MIN = -0.05
B_MAX = 0.05
B_STEP = 0.0005

# ── Relaxation ───────────────────────────────────────────────────────────
RELAX_TOL = 1e-5
RELAX_MAX_STEPS = 30_000
RELAX_ALGORITHM = "projected_gradient_bb"

AXES = {
    "long_axis": {
        "initial_m": (-0.1, -1.0, 0.0),
        "axis_unit": (0.0, 1.0, 0.0),
        "field": lambda b: (b * math.sin(ANGLE_RAD), b * math.cos(ANGLE_RAD), 0.0),
    },
    "short_axis": {
        "initial_m": (-1.0, -0.1, 0.0),
        "axis_unit": (1.0, 0.0, 0.0),
        "field": lambda b: (b * math.cos(ANGLE_RAD), b * math.sin(ANGLE_RAD), 0.0),
    },
}


def linspace_step(start: float, stop: float, step: float) -> list[float]:
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


def dot(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    return float(a[0]) * float(b[0]) + float(a[1]) * float(b[1]) + float(a[2]) * float(b[2])


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
            "Run this script through the Fullmag launcher."
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    return Path(save_method(path, format=format))


def can_save_state(result: object) -> bool:
    return hasattr(result, "save_state")


def write_rows(path: Path, rows: list[dict[str, object]]) -> None:
    if not rows:
        raise ValueError(f"cannot write empty CSV: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def build_study(axis_name: str):
    study = fm.study(f"stdprob1_fem_{axis_name}")

    # ── Engine ──────────────────────────────────────────────────────────
    study.engine("fem")
    study.device("cpu", precision="double")
    study.universe(
        mode="auto",
        size=(1.4 * SIZE_X, 1.4 * SIZE_Y, 8.0 * SIZE_Z),
        center=(0.0, 0.0, 0.0),
        padding=(0.0, 0.0, 0.0),
        airbox_hmax=max(4.0 * HMAX, SIZE_Y / 12.0),
    )
    study.interactive(True)

    # ── Geometry & Material ─────────────────────────────────────────────
    body = study.geometry(
        fm.Box(size=(SIZE_X, SIZE_Y, SIZE_Z), name=f"film_{axis_name}"),
        name=f"film_{axis_name}",
    )
    body.Ms = MS
    body.Aex = AEX
    body.alpha = ALPHA
    body.Ku1 = KU1
    body.anisU = ANIS_U
    body.m = fm.uniform(AXES[axis_name]["initial_m"])

    # ── Mesh ────────────────────────────────────────────────────────────
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
        hmax=HMAX,
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

    # ── Fields & Solver ─────────────────────────────────────────────────
    study.demag(realization="poisson_robin")
    study.solver(max_error=1e-6, integrator="rk45", g=2.115)

    # Register one very sparse scalar output so repeated relax() stages do not
    # fall back to dense default field autosaves. `every=1.0` means 1 second
    # of simulation time, so for nanosecond-scale problems it is effectively
    # "save almost never", not "save every practical step".
    study.save("E_total", every=1.0)

    return study, body


def relax_with_state(
    *,
    study,
    body,
    field: tuple[float, float, float],
    state_path: Path,
) -> tuple[object, tuple[float, float, float], dict[str, float]]:
    study.b_ext(float(field[0]), float(field[1]), float(field[2]))
    result = study.relax(
        tol=RELAX_TOL,
        max_steps=RELAX_MAX_STEPS,
        algorithm=RELAX_ALGORITHM,
    )
    final_state = getattr(result, "final_magnetization", None)
    if final_state is None:
        # During Fullmag's flat-script materialization, relax() returns a staged
        # Problem instead of a runtime Result. The CLI later stitches stages
        # together with final_magnetization continuation automatically.
        nan = float("nan")
        return result, (nan, nan, nan), final_step_metrics(result)
    metrics = final_step_metrics(result)
    save_state(result, state_path, format="zarr")
    body.m = fm.load_magnetization(state_path, format="zarr")
    return result, average_vector(final_state), metrics


def record_row(
    *,
    axis_name: str,
    sweep: str,
    b_scalar: float,
    field: tuple[float, float, float],
    avg_m: tuple[float, float, float],
    metrics: dict[str, float],
) -> dict[str, float | str]:
    axis_unit = AXES[axis_name]["axis_unit"]
    return {
        "backend": "fem",
        "axis": axis_name,
        "sweep": sweep,
        "B_scalar_T": b_scalar,
        "B_x_T": field[0],
        "B_y_T": field[1],
        "B_z_T": field[2],
        "mx": avg_m[0],
        "my": avg_m[1],
        "mz": avg_m[2],
        "m_parallel_axis": dot(avg_m, axis_unit),
        **metrics,
    }


def estimate_summary(axis_name: str, rows: list[dict[str, float | str]]) -> dict[str, float | str]:
    axis_rows = [row for row in rows if row["axis"] == axis_name]
    descending = [row for row in axis_rows if row["sweep"] == "down"]

    zero_row = min(descending, key=lambda row: abs(float(row["B_scalar_T"])))
    coercive_b = float("nan")
    for left, right in zip(descending, descending[1:]):
        m0 = float(left["m_parallel_axis"])
        m1 = float(right["m_parallel_axis"])
        if m0 == 0.0:
            coercive_b = abs(float(left["B_scalar_T"]))
            break
        if m0 * m1 < 0.0:
            coercive_b = abs(
                interpolate_zero(
                    float(left["B_scalar_T"]),
                    m0,
                    float(right["B_scalar_T"]),
                    m1,
                )
            )
            break

    return {
        "backend": "fem",
        "axis": axis_name,
        "remanence_mx": float(zero_row["mx"]),
        "remanence_my": float(zero_row["my"]),
        "remanence_mz": float(zero_row["mz"]),
        "remanence_parallel_axis": float(zero_row["m_parallel_axis"]),
        "coercive_field_T": coercive_b,
    }


def run_axis(axis_name: str) -> list[dict[str, float | str]]:
    print(f"[SP1:FEM] Running {axis_name} hysteresis loop...")
    study, body = build_study(axis_name)
    rows: list[dict[str, float | str]] = []
    field_fn = AXES[axis_name]["field"]

    initial_field = field_fn(B_MIN)
    _, avg_m, metrics = relax_with_state(
        study=study,
        body=body,
        field=initial_field,
        state_path=CURRENT_STATE_ZARR,
    )
    rows.append(
        record_row(
            axis_name=axis_name,
            sweep="up",
            b_scalar=B_MIN,
            field=initial_field,
            avg_m=avg_m,
            metrics=metrics,
        )
    )

    for b_scalar in linspace_step(B_MIN + B_STEP, B_MAX, B_STEP):
        field = field_fn(b_scalar)
        result, avg_m, metrics = relax_with_state(
            study=study,
            body=body,
            field=field,
            state_path=CURRENT_STATE_ZARR,
        )
        rows.append(
            record_row(
                axis_name=axis_name,
                sweep="up",
                b_scalar=b_scalar,
                field=field,
                avg_m=avg_m,
                metrics=metrics,
            )
        )
        if abs(b_scalar) <= 0.5 * B_STEP and can_save_state(result):
            save_state(result, SCRIPT_DIR / f"stdprob1_fem_{axis_name}_h0_up.zarr.zip", format="zarr")

    for b_scalar in linspace_step(B_MAX - B_STEP, B_MIN, -B_STEP):
        field = field_fn(b_scalar)
        result, avg_m, metrics = relax_with_state(
            study=study,
            body=body,
            field=field,
            state_path=CURRENT_STATE_ZARR,
        )
        rows.append(
            record_row(
                axis_name=axis_name,
                sweep="down",
                b_scalar=b_scalar,
                field=field,
                avg_m=avg_m,
                metrics=metrics,
            )
        )
        if abs(b_scalar) <= 0.5 * B_STEP and can_save_state(result):
            save_state(result, SCRIPT_DIR / f"stdprob1_fem_{axis_name}_h0_down.zarr.zip", format="zarr")

    return rows


def main() -> None:
    all_rows: list[dict[str, float | str]] = []
    for axis_name in ("long_axis", "short_axis"):
        all_rows.extend(run_axis(axis_name))

    if any(math.isnan(float(row["mx"])) for row in all_rows):
        print("[SP1:FEM] Materialization mode detected; skipping CSV export until runtime execution.")
        return

    summaries = [estimate_summary(axis_name, all_rows) for axis_name in ("long_axis", "short_axis")]
    write_rows(LOOP_CSV, all_rows)
    write_rows(SUMMARY_CSV, summaries)
    print(f"[SP1:FEM] Wrote {LOOP_CSV.name} and {SUMMARY_CSV.name}")


# Execute at module import time so Fullmag's flat-script loader can capture the
# study stages during materialization, just like in canonical example scripts.
main()
