"""µMAG Standard Problem #3 translated to Fullmag's study-root scripting API.

This follows the reduced-unit MuMax workshop formulation:
* N = 64 fixed cells per dimension
* L swept from 8.0 to 9.0 l_ex in 0.05 l_ex steps
* Ku = 0.1 K_m
* easy axis along x

Two branches are computed:
* flower-like branch (uniform initial state, slightly canted)
* vortex branch (analytic vortex preset)

Outputs
-------
* stdprob3_phase_diagram.csv
* stdprob3_summary.csv
"""

from __future__ import annotations

import math
from pathlib import Path

import fullmag as fm

from _stdprob_utils import MU0, build_fdm_box_study, interpolate_zero, relax_with_state, write_rows

SCRIPT_DIR = Path(__file__).resolve().parent

PHASE_CSV = SCRIPT_DIR / "stdprob3_phase_diagram.csv"
SUMMARY_CSV = SCRIPT_DIR / "stdprob3_summary.csv"

N = 64
L_VALUES = tuple(8.0 + 0.05 * index for index in range(21))

# Reduced-unit parameterization used in the MuMax workshop:
# Ms = sqrt(2 / mu0), A = 1, Ku = 0.1, so l_ex = 1 in the chosen units.
MS = math.sqrt(2.0 / MU0)
AEX = 1.0
KU1 = 0.1
ALPHA = 0.02
ANIS_U = (1.0, 0.0, 0.0)

RELAX_TOL = 1e-6
RELAX_MAX_STEPS = 50_000
RELAX_ALGORITHM = "llg_overdamped"


def _initial_state(branch: str):
    if branch == "flower":
        return fm.uniform(1.0, 0.0, 0.001)
    if branch == "vortex":
        return fm.texture.vortex(circulation=1, core_polarity=-1, plane="xy")
    raise ValueError(f"unknown branch: {branch}")


def run_branch(branch: str) -> list[dict[str, float | str]]:
    print(f"[SP3] Running {branch} branch...")
    rows: list[dict[str, float | str]] = []

    for l_value in L_VALUES:
        cell = (l_value / N, l_value / N, l_value / N)
        study, body = build_fdm_box_study(
            problem_name=f"stdprob3_{branch}_{str(l_value).replace('.', 'p')}",
            size=(l_value, l_value, l_value),
            cell=cell,
            ms=MS,
            aex=AEX,
            alpha=ALPHA,
            ku1=KU1,
            anis_u=ANIS_U,
            initial_m=_initial_state(branch),
            max_error=1e-6,
            integrator="rk45",
            geometry_name="cube",
        )

        state_path = SCRIPT_DIR / f"_stdprob3_{branch}_{str(l_value).replace('.', 'p')}.zarr.zip"
        _, avg_m, metrics = relax_with_state(
            study=study,
            body=body,
            field=(0.0, 0.0, 0.0),
            state_path=state_path,
            tolA=RELAX_TOL,
            max_steps=RELAX_MAX_STEPS,
            algorithm=RELAX_ALGORITHM,
            relax_alpha=1.0,
        )

        rows.append(
            {
                "branch": branch,
                "L_over_lex": l_value,
                "cell_over_lex": l_value / N,
                "mx": avg_m[0],
                "my": avg_m[1],
                "mz": avg_m[2],
                **metrics,
            }
        )

    return rows


def _estimate_transition(rows: list[dict[str, float | str]]) -> dict[str, float | str]:
    flower_rows = {float(row["L_over_lex"]): row for row in rows if row["branch"] == "flower"}
    vortex_rows = {float(row["L_over_lex"]): row for row in rows if row["branch"] == "vortex"}

    matched = []
    for l_value in L_VALUES:
        flower = flower_rows[l_value]
        vortex = vortex_rows[l_value]
        matched.append(
            (
                l_value,
                float(flower["e_total_J"]) - float(vortex["e_total_J"]),
                float(flower["e_total_J"]),
                float(vortex["e_total_J"]),
            )
        )

    crossing_estimate = float("nan")
    for (l0, d0, _, _), (l1, d1, _, _) in zip(matched, matched[1:]):
        if d0 == 0.0:
            crossing_estimate = l0
            break
        if d0 * d1 < 0.0:
            crossing_estimate = interpolate_zero(l0, d0, l1, d1)
            break

    min_abs = min(matched, key=lambda item: abs(item[1]))
    return {
        "transition_estimate_L_over_lex": crossing_estimate,
        "closest_sample_L_over_lex": min_abs[0],
        "closest_sample_delta_E_J": min_abs[1],
        "flower_energy_at_closest_sample_J": min_abs[2],
        "vortex_energy_at_closest_sample_J": min_abs[3],
    }


def main() -> None:
    rows = run_branch("flower") + run_branch("vortex")
    summary = [_estimate_transition(rows)]

    write_rows(PHASE_CSV, rows)
    write_rows(SUMMARY_CSV, summary)
    print(f"[SP3] Wrote {PHASE_CSV.name} and {SUMMARY_CSV.name}")


if __name__ == "__main__":
    main()
