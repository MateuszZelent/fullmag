"""µMAG Standard Problem #2 translated to Fullmag's study-root scripting API.

The script follows the µMAG specification:
* t / d = 0.1
* L / d = 5
* field applied along [1, 1, 1]
* zero crystalline anisotropy

It computes a sparse benchmark sweep over d / l_ex and writes:
* stdprob2_loop.csv
* stdprob2_summary.csv

The ratio list is intentionally moderate so the script stays usable as a
physical regression test. Increase D_OVER_LEX_VALUES if you want a denser
reproduction curve.
"""

from __future__ import annotations

import math
from pathlib import Path

import fullmag as fm

from _stdprob_utils import (
    MU0,
    build_fdm_box_study,
    cells_for_max_cell,
    dot,
    interpolate_zero,
    linspace_step,
    relax_with_state,
    unit,
    write_rows,
)

SCRIPT_DIR = Path(__file__).resolve().parent

LOOP_CSV = SCRIPT_DIR / "stdprob2_loop.csv"
SUMMARY_CSV = SCRIPT_DIR / "stdprob2_summary.csv"

MS = 1_000e3
AEX = 10e-12
ALPHA = 0.02

LEX = math.sqrt(AEX / (0.5 * MU0 * MS * MS))
D_OVER_LEX_VALUES = (0.1, 0.5, 1.0, 2.0, 4.0, 8.0, 15.0, 30.0)

THICKNESS_OVER_D = 0.1
LENGTH_OVER_D = 5.0
MAX_CELL = 0.75 * LEX

FIELD_DIR = unit((1.0, 1.0, 1.0))
B_M = MU0 * MS
B_MAX = 1.5 * B_M
B_STEP = 0.05 * B_M

RELAX_TOL = 2e-5
RELAX_MAX_STEPS = 20_000
RELAX_ALGORITHM = "llg_overdamped"


def _field_from_scalar(b_scalar: float) -> tuple[float, float, float]:
    return (b_scalar * FIELD_DIR[0], b_scalar * FIELD_DIR[1], b_scalar * FIELD_DIR[2])


def _record_row(
    *,
    ratio: float,
    sweep: str,
    b_scalar: float,
    avg_m: tuple[float, float, float],
    metrics: dict[str, float],
    nx: int,
    ny: int,
    cell: tuple[float, float, float],
) -> dict[str, float | str | int]:
    return {
        "d_over_lex": ratio,
        "sweep": sweep,
        "B_scalar_T": b_scalar,
        "B_over_Bm": b_scalar / B_M,
        "mx": avg_m[0],
        "my": avg_m[1],
        "mz": avg_m[2],
        "m_parallel_111": dot(avg_m, FIELD_DIR),
        "nx": nx,
        "ny": ny,
        "cell_x_m": cell[0],
        "cell_y_m": cell[1],
        "cell_z_m": cell[2],
        **metrics,
    }


def _estimate_summary(ratio: float, rows: list[dict[str, float | str | int]]) -> dict[str, float]:
    subset = [row for row in rows if float(row["d_over_lex"]) == ratio]
    descending = [row for row in subset if row["sweep"] == "descending"]

    zero_row = min(descending, key=lambda row: abs(float(row["B_scalar_T"])))

    coercive_b = float("nan")
    for left, right in zip(descending, descending[1:]):
        m0 = float(left["m_parallel_111"])
        m1 = float(right["m_parallel_111"])
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
        "d_over_lex": ratio,
        "remanence_mx": float(zero_row["mx"]),
        "remanence_my": float(zero_row["my"]),
        "remanence_mz": float(zero_row["mz"]),
        "remanence_parallel_111": float(zero_row["m_parallel_111"]),
        "coercive_field_T": coercive_b,
        "coercive_over_Hm": coercive_b / B_M,
    }


def run_ratio(ratio: float) -> tuple[list[dict[str, float | str | int]], dict[str, float]]:
    print(f"[SP2] Running d/l_ex = {ratio:g} ...")

    d = ratio * LEX
    size_x = LENGTH_OVER_D * d
    size_y = d
    size_z = THICKNESS_OVER_D * d

    nx = cells_for_max_cell(size_x, MAX_CELL, minimum=4)
    ny = cells_for_max_cell(size_y, MAX_CELL, minimum=4)
    cell = (size_x / nx, size_y / ny, size_z)

    study, body = build_fdm_box_study(
        problem_name=f"stdprob2_dlex_{str(ratio).replace('.', 'p')}",
        size=(size_x, size_y, size_z),
        cell=cell,
        ms=MS,
        aex=AEX,
        alpha=ALPHA,
        initial_m=fm.uniform(FIELD_DIR),
        max_error=1e-6,
        integrator="rk45",
        geometry_name="film",
    )

    state_path = SCRIPT_DIR / f"_stdprob2_dlex_{str(ratio).replace('.', 'p')}.zarr.zip"
    rows: list[dict[str, float | str | int]] = []

    initial_field = _field_from_scalar(B_MAX)
    _, avg_m, metrics = relax_with_state(
        study=study,
        body=body,
        field=initial_field,
        state_path=state_path,
        tol=RELAX_TOL,
        max_steps=RELAX_MAX_STEPS,
        algorithm=RELAX_ALGORITHM,
        relax_alpha=1.0,
    )
    rows.append(
        _record_row(
            ratio=ratio,
            sweep="descending",
            b_scalar=B_MAX,
            avg_m=avg_m,
            metrics=metrics,
            nx=nx,
            ny=ny,
            cell=cell,
        )
    )

    for b_scalar in linspace_step(B_MAX - B_STEP, -B_MAX, -B_STEP):
        _, avg_m, metrics = relax_with_state(
            study=study,
            body=body,
            field=_field_from_scalar(b_scalar),
            state_path=state_path,
            tol=RELAX_TOL,
            max_steps=RELAX_MAX_STEPS,
            algorithm=RELAX_ALGORITHM,
            relax_alpha=1.0,
        )
        rows.append(
            _record_row(
                ratio=ratio,
                sweep="descending",
                b_scalar=b_scalar,
                avg_m=avg_m,
                metrics=metrics,
                nx=nx,
                ny=ny,
                cell=cell,
            )
        )

    for b_scalar in linspace_step(-B_MAX + B_STEP, B_MAX, B_STEP):
        _, avg_m, metrics = relax_with_state(
            study=study,
            body=body,
            field=_field_from_scalar(b_scalar),
            state_path=state_path,
            tol=RELAX_TOL,
            max_steps=RELAX_MAX_STEPS,
            algorithm=RELAX_ALGORITHM,
            relax_alpha=1.0,
        )
        rows.append(
            _record_row(
                ratio=ratio,
                sweep="ascending",
                b_scalar=b_scalar,
                avg_m=avg_m,
                metrics=metrics,
                nx=nx,
                ny=ny,
                cell=cell,
            )
        )

    return rows, _estimate_summary(ratio, rows)


def main() -> None:
    all_rows: list[dict[str, float | str | int]] = []
    summaries: list[dict[str, float]] = []
    for ratio in D_OVER_LEX_VALUES:
        rows, summary = run_ratio(ratio)
        all_rows.extend(rows)
        summaries.append(summary)

    write_rows(LOOP_CSV, all_rows)
    write_rows(SUMMARY_CSV, summaries)
    print(f"[SP2] Wrote {LOOP_CSV.name} and {SUMMARY_CSV.name}")


if __name__ == "__main__":
    main()
