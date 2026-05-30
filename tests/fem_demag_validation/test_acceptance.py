"""Unit checks for FEM demag runtime-validation acceptance helpers."""

from __future__ import annotations

import math
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from helpers import (  # noqa: E402
    ValidationFailure,
    effective_demag_factor_from_energy,
    require_finite_metrics,
    require_grouped_error_improvement,
    require_grouped_sum_close,
    require_solver_telemetry,
    require_relative_error_below,
)
from telemetry_validation import read_csv_rows, validate_runtime_artifact  # noqa: E402


class DemagValidationAcceptanceTests(unittest.TestCase):
    def test_effective_demag_factor_from_energy_inverts_uniform_energy(self) -> None:
        mu0 = 4.0e-7 * math.pi
        ms = 800e3
        volume = 4.0e-21
        expected_n = 1.0 / 3.0
        e_demag = 0.5 * mu0 * expected_n * ms * ms * volume

        n_eff = effective_demag_factor_from_energy(
            e_demag=e_demag,
            ms=ms,
            volume=volume,
        )

        self.assertAlmostEqual(n_eff, expected_n, places=14)

    def test_finite_metrics_reject_nan_rows(self) -> None:
        rows = [{"case": "bad", "n_rel_error": math.nan}]

        with self.assertRaisesRegex(ValidationFailure, "bad.*n_rel_error"):
            require_finite_metrics(rows, ["n_rel_error"], label_key="case")

    def test_relative_error_threshold_rejects_failure(self) -> None:
        row = {"case": "sphere", "n_rel_error": 0.051}

        with self.assertRaisesRegex(ValidationFailure, "sphere.*5.00%"):
            require_relative_error_below(
                row,
                error_key="n_rel_error",
                threshold=0.05,
                label="sphere",
            )

    def test_grouped_error_improvement_rejects_non_convergent_group(self) -> None:
        rows = [
            {"bc": "poisson_robin", "scale": 1.2, "n_rel_error": 0.08},
            {"bc": "poisson_robin", "scale": 4.0, "n_rel_error": 0.09},
        ]

        with self.assertRaisesRegex(ValidationFailure, "poisson_robin.*not convergent"):
            require_grouped_error_improvement(
                rows,
                group_key="bc",
                order_key="scale",
                error_key="n_rel_error",
            )

    def test_grouped_sum_close_rejects_missing_group_axes(self) -> None:
        rows = [
            {"shape": "prolate", "m_axis": "x", "n_effective": 0.20},
            {"shape": "prolate", "m_axis": "z", "n_effective": 0.60},
        ]

        with self.assertRaisesRegex(ValidationFailure, "prolate.*expected axes"):
            require_grouped_sum_close(
                rows,
                group_key="shape",
                value_key="n_effective",
                expected_sum=1.0,
                tolerance=0.15,
                required_axis_key="m_axis",
                required_axes=("x", "y", "z"),
            )

    def test_grouped_sum_close_rejects_bad_demag_factor_sum(self) -> None:
        rows = [
            {"shape": "oblate", "m_axis": "x", "n_effective": 0.20},
            {"shape": "oblate", "m_axis": "y", "n_effective": 0.20},
            {"shape": "oblate", "m_axis": "z", "n_effective": 0.30},
        ]

        with self.assertRaisesRegex(ValidationFailure, "oblate.*sum"):
            require_grouped_sum_close(
                rows,
                group_key="shape",
                value_key="n_effective",
                expected_sum=1.0,
                tolerance=0.15,
                required_axis_key="m_axis",
                required_axes=("x", "y", "z"),
            )

    def test_grouped_sum_close_accepts_complete_demag_factor_group(self) -> None:
        rows = [
            {"shape": "general", "m_axis": "x", "n_effective": 0.20},
            {"shape": "general", "m_axis": "y", "n_effective": 0.30},
            {"shape": "general", "m_axis": "z", "n_effective": 0.49},
        ]

        require_grouped_sum_close(
            rows,
            group_key="shape",
            value_key="n_effective",
            expected_sum=1.0,
            tolerance=0.15,
            required_axis_key="m_axis",
            required_axes=("x", "y", "z"),
        )

    def test_solver_telemetry_rejects_missing_residual(self) -> None:
        rows = [
            {
                "case": "poisson",
                "demag_linear_iterations": 4,
                "demag_linear_residual": math.nan,
                "demag_wall_time_ns": 10,
                "demag_assemble_wall_time_ns": 2,
                "demag_solve_wall_time_ns": 4,
                "demag_recover_wall_time_ns": 3,
                "demag_energy_wall_time_ns": 1,
            }
        ]

        with self.assertRaisesRegex(ValidationFailure, "poisson.*demag_linear_residual"):
            require_solver_telemetry(rows, label_key="case")

    def test_solver_telemetry_rejects_negative_iterations(self) -> None:
        rows = [
            {
                "case": "poisson",
                "demag_linear_iterations": -1,
                "demag_linear_residual": 1.0e-8,
                "demag_wall_time_ns": 10,
                "demag_assemble_wall_time_ns": 2,
                "demag_solve_wall_time_ns": 4,
                "demag_recover_wall_time_ns": 3,
                "demag_energy_wall_time_ns": 1,
            }
        ]

        with self.assertRaisesRegex(ValidationFailure, "poisson.*iterations"):
            require_solver_telemetry(rows, label_key="case")

    def test_solver_telemetry_accepts_complete_phase_timings(self) -> None:
        rows = [
            {
                "case": "poisson",
                "demag_linear_iterations": 4,
                "demag_linear_residual": 1.0e-8,
                "demag_wall_time_ns": 10,
                "demag_assemble_wall_time_ns": 2,
                "demag_solve_wall_time_ns": 4,
                "demag_recover_wall_time_ns": 3,
                "demag_energy_wall_time_ns": 1,
            }
        ]

        require_solver_telemetry(rows, label_key="case")

    def test_telemetry_artifact_validator_rejects_missing_rows(self) -> None:
        with self.assertRaisesRegex(ValidationFailure, "no demag telemetry rows"):
            validate_runtime_artifact([])

    def test_telemetry_artifact_validator_accepts_complete_rows(self) -> None:
        rows = [
            {
                "case": "poisson-robin",
                "demag_linear_iterations": 4,
                "demag_linear_residual": 1.0e-8,
                "demag_wall_time_ns": 10,
                "demag_assemble_wall_time_ns": 2,
                "demag_solve_wall_time_ns": 4,
                "demag_recover_wall_time_ns": 3,
                "demag_energy_wall_time_ns": 1,
            }
        ]

        validate_runtime_artifact(rows)

    def test_telemetry_csv_loader_parses_numeric_columns(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "demag_telemetry.csv"
            path.write_text(
                "\n".join([
                    "case,demag_linear_iterations,demag_linear_residual,"
                    "demag_wall_time_ns,demag_assemble_wall_time_ns,"
                    "demag_solve_wall_time_ns,demag_recover_wall_time_ns,"
                    "demag_energy_wall_time_ns",
                    "poisson-robin,4,1e-8,10,2,4,3,1",
                ])
                + "\n"
            )

            rows = read_csv_rows(path)

        self.assertIsInstance(rows[0]["demag_linear_iterations"], float)
        validate_runtime_artifact(rows)


if __name__ == "__main__":
    unittest.main()
