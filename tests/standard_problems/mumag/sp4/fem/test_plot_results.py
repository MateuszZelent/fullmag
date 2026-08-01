from __future__ import annotations

import csv
import importlib.util
from pathlib import Path

import pytest

from tests.standard_problems.mumag.sp4.fem.collect_results import FIELDNAMES
from tests.standard_problems.mumag.sp4.fem.plot_results import (
    DYNAMICS_PLOT_NAMES,
    PLOT_SPECS,
    RELAXATION_PLOT_NAMES,
    PlotError,
    plot_ledger,
)


HAS_MATPLOTLIB = importlib.util.find_spec("matplotlib") is not None


def _ledger(
    path: Path,
    *,
    status: str = "completed",
    include_dynamics: bool = True,
    include_relaxation: bool = False,
) -> None:
    base = {name: "" for name in FIELDNAMES}
    rows = []
    if include_dynamics:
        for attempt, scenario, device, crossing_ps, error, torque, wall in (
            ("a-cpu", "case_a_rk4_fixed", "cpu", 138.5, 0.02, 4e-6, 11.0),
            ("a-gpu", "case_a_rk4_fixed", "gpu", 138.2, 0.03, 5e-6, 4.0),
            ("b-cpu", "case_b_rk45_adaptive", "cpu", 137.1, 0.04, 6e-6, 13.0),
            ("b-gpu", "case_b_rk45_adaptive", "gpu", 136.9, 0.05, 7e-6, 5.0),
        ):
            case = scenario[:6]
            row = {
                **base,
                "attempt_id": attempt,
                "phase": "dynamics",
                "scenario": scenario,
                "case": case,
                "requested_device": device,
                "crossing_time_s": str(crossing_ps * 1e-12),
                "nist_crossing_min_s": str(
                    (137.9 if case == "case_a" else 136.2) * 1e-12
                ),
                "nist_crossing_max_s": str(
                    (139.9 if case == "case_a" else 138.3) * 1e-12
                ),
                "nist_envelope_rms_mx": str(error),
                "nist_envelope_rms_my": str(error * 1.2),
                "nist_envelope_rms_mz": str(error * 0.8),
                "final_max_torque_T": str(torque),
                "wall_time_s": str(wall),
                "status": status,
            }
            rows.append(row)
    if include_relaxation:
        for attempt, scenario, device, torque, drop in (
            ("r-rk23", "relax_llg_rk23_adaptive", "cpu", 8e-6, 2.2e-17),
            ("r-pgbb", "relax_projected_gradient_bb", "cpu", 0.0, 2.1e-17),
            ("r-ncg", "relax_nonlinear_cg", "gpu", 6e-6, 2.0e-17),
        ):
            rows.append(
                {
                    **base,
                    "attempt_id": attempt,
                    "phase": "relaxation",
                    "scenario": scenario,
                    "relaxation_algorithm": (
                        "llg_overdamped"
                        if "relax_llg" in scenario
                        else scenario.removeprefix("relax_")
                    ),
                    "requested_device": device,
                    "final_max_torque_T": str(torque),
                    "relaxation_torque_limit_T": "1e-5",
                    "energy_drop_J": str(drop),
                    "status": status,
                }
            )
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=FIELDNAMES, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def test_plot_specs_state_units_and_treat_nist_as_reference_band() -> None:
    assert PLOT_SPECS["crossing_time_ps.png"].y_label.endswith("(ps)")
    assert PLOT_SPECS["crossing_time_ps.png"].reference_label == "NIST reference envelope"
    assert PLOT_SPECS["trajectory_error.png"].y_label.endswith("(-)")
    assert PLOT_SPECS["final_torque_T.png"].y_label.endswith("(T)")
    assert PLOT_SPECS["wall_time_s.png"].y_label.endswith("(s)")
    assert PLOT_SPECS["relaxation_torque_vs_policy.png"].y_label.endswith("(T)")
    assert (
        PLOT_SPECS["relaxation_torque_vs_policy.png"].reference_label
        == "SP4 relaxation limit"
    )
    assert PLOT_SPECS["relaxation_energy_drop_J.png"].y_label.endswith("(J)")


@pytest.mark.skipif(not HAS_MATPLOTLIB, reason="managed Fullmag Python supplies matplotlib")
def test_plot_ledger_generates_deterministic_nonempty_png_set(tmp_path: Path) -> None:
    ledger = tmp_path / "results.csv"
    output = tmp_path / "plots"
    _ledger(ledger)

    paths = plot_ledger(ledger, output)

    assert [path.name for path in paths] == list(DYNAMICS_PLOT_NAMES)
    for path in paths:
        assert path.parent == output
        assert path.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
        assert path.stat().st_size > 5_000


@pytest.mark.skipif(not HAS_MATPLOTLIB, reason="managed Fullmag Python supplies matplotlib")
def test_plot_ledger_adds_relaxation_plots_without_requiring_dynamics(
    tmp_path: Path,
) -> None:
    ledger = tmp_path / "results.csv"
    output = tmp_path / "plots"
    _ledger(ledger, include_dynamics=False, include_relaxation=True)

    paths = plot_ledger(ledger, output)

    assert [path.name for path in paths] == list(RELAXATION_PLOT_NAMES)
    for path in paths:
        assert path.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
        assert path.stat().st_size > 5_000


@pytest.mark.skipif(not HAS_MATPLOTLIB, reason="managed Fullmag Python supplies matplotlib")
def test_plot_ledger_renders_both_phase_sets_from_one_append_only_ledger(
    tmp_path: Path,
) -> None:
    ledger = tmp_path / "results.csv"
    _ledger(ledger, include_relaxation=True)

    paths = plot_ledger(ledger, tmp_path / "plots")

    assert [path.name for path in paths] == list(PLOT_SPECS)


@pytest.mark.skipif(not HAS_MATPLOTLIB, reason="managed Fullmag Python supplies matplotlib")
def test_plot_ledger_fails_closed_for_wrong_schema_or_no_completed_rows(tmp_path: Path) -> None:
    wrong = tmp_path / "wrong.csv"
    wrong.write_text("attempt_id,status\na,completed\n", encoding="utf-8")
    with pytest.raises(PlotError, match="schema"):
        plot_ledger(wrong, tmp_path / "wrong-plots")

    ledger = tmp_path / "results.csv"
    _ledger(ledger, status="execution_failure")
    with pytest.raises(PlotError, match="completed attempts"):
        plot_ledger(ledger, tmp_path / "empty-plots")
