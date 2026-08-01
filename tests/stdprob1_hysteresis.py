"""µMAG Standard Problem #1 translated to Fullmag's study-root scripting API.

Based on the µMAG geometry/material specification and the MuMax workshop
hysteresis schedule for the long-axis sweep. This script extends that schedule
with a second sweep approximately parallel to the short axis, which is also
requested by Standard Problem #1.

Outputs
-------
* stdprob1_loop.csv
* stdprob1_summary.csv
* stdprob1_*_h0_*.zarr.zip (zero-field states for visual inspection)

Notes
-----
This file remains the canonical FDM variant. The matching FEM benchmark lives
in ``stdprob1_hysteresis_fem.py`` and uses the same hysteresis schedule with
backend-specific output filenames.
"""

from __future__ import annotations

import math
from pathlib import Path

import fullmag as fm

from _stdprob_utils import (
    average_vector,
    build_fdm_box_study,
    dot,
    interpolate_zero,
    linspace_step,
    relax_with_state,
    save_state,
    unit,
    write_rows,
)

SCRIPT_DIR = Path(__file__).resolve().parent

LOOP_CSV = SCRIPT_DIR / "stdprob1_loop.csv"
SUMMARY_CSV = SCRIPT_DIR / "stdprob1_summary.csv"
TEMP_STATE = SCRIPT_DIR / "_stdprob1_current_state.zarr.zip"

SIZE_X = 1_000e-9
SIZE_Y = 2_000e-9
SIZE_Z = 20e-9
NX = 192
NY = 384
CELL = (SIZE_X / NX, SIZE_Y / NY, SIZE_Z)

MS = 800e3
AEX = 13e-12
ALPHA = 0.02
KU1 = 5e2
ANIS_U = (0.0, 1.0, 0.0)

ANGLE_DEG = 1.0
ANGLE_RAD = math.radians(ANGLE_DEG)
B_MIN = -0.05
B_MAX = 0.05
B_STEP = 0.0005

RELAX_TOL = 1e-5
RELAX_MAX_STEPS = 30_000
RELAX_ALGORITHM = "llg_overdamped"

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


def _build(axis_name: str):
    return build_fdm_box_study(
        problem_name=f"stdprob1_{axis_name}",
        size=(SIZE_X, SIZE_Y, SIZE_Z),
        cell=CELL,
        ms=MS,
        aex=AEX,
        alpha=ALPHA,
        ku1=KU1,
        anis_u=ANIS_U,
        initial_m=fm.uniform(AXES[axis_name]["initial_m"]),
        max_error=1e-6,
        integrator="rk45",
        geometry_name=f"film_{axis_name}",
    )


def _record_row(
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
        "backend": "fdm",
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


def _estimate_summary(axis_name: str, rows: list[dict[str, float | str]]) -> dict[str, float | str]:
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
        "backend": "fdm",
        "axis": axis_name,
        "remanence_mx": float(zero_row["mx"]),
        "remanence_my": float(zero_row["my"]),
        "remanence_mz": float(zero_row["mz"]),
        "remanence_parallel_axis": float(zero_row["m_parallel_axis"]),
        "coercive_field_T": coercive_b,
    }


def run_axis(axis_name: str) -> list[dict[str, float | str]]:
    print(f"[SP1] Running {axis_name} hysteresis loop...")
    study, body = _build(axis_name)
    state_path = TEMP_STATE
    rows: list[dict[str, float | str]] = []

    field_fn = AXES[axis_name]["field"]

    # Prepare a negative saturated starting state.
    initial_field = field_fn(B_MIN)
    initial_result, avg_m, metrics = relax_with_state(
        study=study,
        body=body,
        field=initial_field,
        state_path=state_path,
        tolA=RELAX_TOL,
        max_steps=RELAX_MAX_STEPS,
        algorithm=RELAX_ALGORITHM,
        relax_alpha=1.0,
    )
    rows.append(
        _record_row(
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
            state_path=state_path,
            tolA=RELAX_TOL,
            max_steps=RELAX_MAX_STEPS,
            algorithm=RELAX_ALGORITHM,
            relax_alpha=1.0,
        )
        rows.append(
            _record_row(
                axis_name=axis_name,
                sweep="up",
                b_scalar=b_scalar,
                field=field,
                avg_m=avg_m,
                metrics=metrics,
            )
        )
        if abs(b_scalar) <= 0.5 * B_STEP:
            save_state(result, SCRIPT_DIR / f"stdprob1_{axis_name}_h0_up.zarr.zip", format="zarr")

    for b_scalar in linspace_step(B_MAX - B_STEP, B_MIN, -B_STEP):
        field = field_fn(b_scalar)
        result, avg_m, metrics = relax_with_state(
            study=study,
            body=body,
            field=field,
            state_path=state_path,
            tolA=RELAX_TOL,
            max_steps=RELAX_MAX_STEPS,
            algorithm=RELAX_ALGORITHM,
            relax_alpha=1.0,
        )
        rows.append(
            _record_row(
                axis_name=axis_name,
                sweep="down",
                b_scalar=b_scalar,
                field=field,
                avg_m=avg_m,
                metrics=metrics,
            )
        )
        if abs(b_scalar) <= 0.5 * B_STEP:
            save_state(result, SCRIPT_DIR / f"stdprob1_{axis_name}_h0_down.zarr.zip", format="zarr")

    return rows


def main() -> None:
    all_rows: list[dict[str, float | str]] = []
    for axis_name in ("long_axis", "short_axis"):
        all_rows.extend(run_axis(axis_name))

    summaries = [_estimate_summary(axis_name, all_rows) for axis_name in ("long_axis", "short_axis")]
    write_rows(LOOP_CSV, all_rows)
    write_rows(SUMMARY_CSV, summaries)
    print(f"[SP1] Wrote {LOOP_CSV.name} and {SUMMARY_CSV.name}")


if __name__ == "__main__":
    main()
