"""µMAG Standard Problem #4 translated to Fullmag's study-root scripting API.

The script prepares the zero-field relaxed state from the standard initial
magnetization m = (1, 0.1, 0), then applies the two official switching fields
from the µMAG specification and records the spatially averaged magnetization as
a function of time.

Outputs
-------
* stdprob4_case1_mavg.csv
* stdprob4_case2_mavg.csv
* stdprob4_summary.csv
* stdprob4_case*_mx_zero.zarr.zip  (first sampled state after <mx> crosses zero)
* stdprob4_relaxed_m.zarr.zip
"""

from __future__ import annotations

from pathlib import Path

import fullmag as fm

from _stdprob_utils import (
    average_vector,
    build_fdm_box_study,
    run_with_state,
    save_state,
    write_rows,
)

SCRIPT_DIR = Path(__file__).resolve().parent

RELAXED_STATE = SCRIPT_DIR / "stdprob4_relaxed_m.zarr.zip"
SUMMARY_CSV = SCRIPT_DIR / "stdprob4_summary.csv"

SIZE_X = 500e-9
SIZE_Y = 125e-9
SIZE_Z = 3e-9
NX = 128
NY = 32
CELL = (SIZE_X / NX, SIZE_Y / NY, SIZE_Z)

MS = 800e3
AEX = 13e-12
ALPHA = 0.02

RELAX_TOL = 1e-6
RELAX_MAX_STEPS = 100_000
RELAX_ALGORITHM = "llg_overdamped"

SAMPLE_DT = 10e-12
TOTAL_TIME = 1e-9
NUM_SAMPLES = int(round(TOTAL_TIME / SAMPLE_DT))

FIELD_CASES = {
    "case1": (-24.6e-3, 4.3e-3, 0.0),
    "case2": (-35.5e-3, -6.3e-3, 0.0),
}


def _build(problem_name: str, initial_state):
    return build_fdm_box_study(
        problem_name=problem_name,
        size=(SIZE_X, SIZE_Y, SIZE_Z),
        cell=CELL,
        ms=MS,
        aex=AEX,
        alpha=ALPHA,
        initial_m=initial_state,
        max_error=1e-6,
        integrator="rk45",
        geometry_name="film",
    )


def prepare_relaxed_state() -> tuple[tuple[float, float, float], Path]:
    if RELAXED_STATE.exists():
        loaded = fm.load_magnetization(RELAXED_STATE, format="zarr")
        return average_vector(loaded), RELAXED_STATE

    print("[SP4] Relaxing the standard initial state...")
    study, body = _build("stdprob4_relax", fm.uniform(1.0, 0.1, 0.0))
    result = study.relax(
        tol=RELAX_TOL,
        max_steps=RELAX_MAX_STEPS,
        algorithm=RELAX_ALGORITHM,
        relax_alpha=1.0,
    )
    save_state(result, RELAXED_STATE, format="zarr")
    return average_vector(getattr(result, "final_magnetization")), RELAXED_STATE


def run_case(case_name: str, field: tuple[float, float, float]) -> tuple[list[dict[str, float | str]], dict[str, float | str]]:
    print(f"[SP4] Running {case_name} with field {field} T ...")

    relaxed_avg, relaxed_path = prepare_relaxed_state()
    study, body = _build(f"stdprob4_{case_name}", fm.load_magnetization(relaxed_path, format="zarr"))

    current_state = SCRIPT_DIR / f"_stdprob4_{case_name}_current.zarr.zip"
    rows: list[dict[str, float | str]] = [
        {
            "case": case_name,
            "time_s": 0.0,
            "B_x_T": field[0],
            "B_y_T": field[1],
            "B_z_T": field[2],
            "mx": relaxed_avg[0],
            "my": relaxed_avg[1],
            "mz": relaxed_avg[2],
        }
    ]

    mx_zero_path = SCRIPT_DIR / f"stdprob4_{case_name}_mx_zero.zarr.zip"
    mx_zero_time = float("nan")
    prev_mx = relaxed_avg[0]

    for sample_index in range(1, NUM_SAMPLES + 1):
        result, avg_m, _ = run_with_state(
            study=study,
            body=body,
            field=field,
            state_path=current_state,
            until=SAMPLE_DT,
        )
        sample_time = sample_index * SAMPLE_DT
        rows.append(
            {
                "case": case_name,
                "time_s": sample_time,
                "B_x_T": field[0],
                "B_y_T": field[1],
                "B_z_T": field[2],
                "mx": avg_m[0],
                "my": avg_m[1],
                "mz": avg_m[2],
            }
        )
        if prev_mx > 0.0 and avg_m[0] <= 0.0 and not mx_zero_path.exists():
            save_state(result, mx_zero_path, format="zarr")
            mx_zero_time = sample_time
        prev_mx = avg_m[0]

    final_row = rows[-1]
    summary = {
        "case": case_name,
        "B_x_T": field[0],
        "B_y_T": field[1],
        "B_z_T": field[2],
        "mx_zero_cross_sample_time_s": mx_zero_time,
        "mx_zero_cross_state": mx_zero_path.name if mx_zero_path.exists() else "",
        "final_mx": float(final_row["mx"]),
        "final_my": float(final_row["my"]),
        "final_mz": float(final_row["mz"]),
    }
    return rows, summary


def main() -> None:
    prepare_relaxed_state()
    summaries: list[dict[str, float | str]] = []

    for case_name, field in FIELD_CASES.items():
        rows, summary = run_case(case_name, field)
        write_rows(SCRIPT_DIR / f"stdprob4_{case_name}_mavg.csv", rows)
        summaries.append(summary)

    write_rows(SUMMARY_CSV, summaries)
    print(f"[SP4] Wrote {SUMMARY_CSV.name}")


if __name__ == "__main__":
    main()
