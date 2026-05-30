"""Unit checks for FEM DMI runtime-validation acceptance helpers."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from helpers import (  # noqa: E402
    ValidationFailure,
    require_boundary_tilt_signal,
    require_chirality_matches,
    require_spiral_pitch_matches_reference,
)
from artifact_validation import read_csv_rows, validate_runtime_artifact  # noqa: E402


class DmiValidationAcceptanceTests(unittest.TestCase):
    def test_chirality_acceptance_rejects_wrong_handedness(self) -> None:
        rows = [
            {
                "case": "interfacial-domain-wall",
                "expected_chirality": "left",
                "observed_chirality": "right",
            }
        ]

        with self.assertRaisesRegex(ValidationFailure, "interfacial-domain-wall.*chirality"):
            require_chirality_matches(rows, label_key="case")

    def test_chirality_acceptance_accepts_matching_bulk_and_interfacial_rows(self) -> None:
        rows = [
            {
                "case": "interfacial-domain-wall",
                "expected_chirality": "left",
                "observed_chirality": "left",
            },
            {
                "case": "bulk-spiral",
                "expected_chirality": "right",
                "observed_chirality": "right",
            },
        ]

        require_chirality_matches(rows, label_key="case")

    def test_spiral_pitch_acceptance_rejects_wrong_sign(self) -> None:
        row = {
            "case": "bulk-spiral",
            "spiral_pitch_m": -80e-9,
            "reference_spiral_pitch_m": 80e-9,
        }

        with self.assertRaisesRegex(ValidationFailure, "bulk-spiral.*sign"):
            require_spiral_pitch_matches_reference(
                row,
                pitch_key="spiral_pitch_m",
                reference_key="reference_spiral_pitch_m",
                relative_tolerance=0.15,
                label="bulk-spiral",
            )

    def test_spiral_pitch_acceptance_rejects_bad_scale(self) -> None:
        row = {
            "case": "interfacial-spiral",
            "spiral_pitch_m": 115e-9,
            "reference_spiral_pitch_m": 80e-9,
        }

        with self.assertRaisesRegex(ValidationFailure, "interfacial-spiral.*relative error"):
            require_spiral_pitch_matches_reference(
                row,
                pitch_key="spiral_pitch_m",
                reference_key="reference_spiral_pitch_m",
                relative_tolerance=0.15,
                label="interfacial-spiral",
            )

    def test_boundary_tilt_acceptance_rejects_missing_tilt_signal(self) -> None:
        row = {
            "case": "boundary-tilt",
            "tilted_boundary_derivative_J": 2.0e-24,
            "uniform_boundary_derivative_J": 0.0,
        }

        with self.assertRaisesRegex(ValidationFailure, "boundary-tilt.*tilted"):
            require_boundary_tilt_signal(
                row,
                tilted_key="tilted_boundary_derivative_J",
                baseline_key="uniform_boundary_derivative_J",
                min_tilt_abs=1.0e-21,
                baseline_abs_tolerance=1.0e-23,
                label="boundary-tilt",
            )

    def test_boundary_tilt_acceptance_rejects_nonzero_uniform_baseline(self) -> None:
        row = {
            "case": "boundary-tilt",
            "tilted_boundary_derivative_J": 1.0e-20,
            "uniform_boundary_derivative_J": 5.0e-22,
        }

        with self.assertRaisesRegex(ValidationFailure, "boundary-tilt.*baseline"):
            require_boundary_tilt_signal(
                row,
                tilted_key="tilted_boundary_derivative_J",
                baseline_key="uniform_boundary_derivative_J",
                min_tilt_abs=1.0e-21,
                baseline_abs_tolerance=1.0e-23,
                label="boundary-tilt",
            )

    def test_runtime_artifact_validator_requires_all_dmi_gates(self) -> None:
        rows = [
            {
                "gate": "chirality",
                "case": "interfacial-domain-wall",
                "expected_chirality": "left",
                "observed_chirality": "left",
            },
            {
                "gate": "spiral_pitch",
                "case": "bulk-spiral",
                "spiral_pitch_m": 80e-9,
                "reference_spiral_pitch_m": 78e-9,
            },
        ]

        with self.assertRaisesRegex(ValidationFailure, "boundary_tilt"):
            validate_runtime_artifact(rows)

    def test_runtime_artifact_validator_accepts_complete_rows(self) -> None:
        rows = [
            {
                "gate": "chirality",
                "case": "interfacial-domain-wall",
                "expected_chirality": "left",
                "observed_chirality": "left",
            },
            {
                "gate": "spiral_pitch",
                "case": "bulk-spiral",
                "spiral_pitch_m": 80e-9,
                "reference_spiral_pitch_m": 78e-9,
            },
            {
                "gate": "boundary_tilt",
                "case": "interfacial-boundary-tilt",
                "tilted_boundary_derivative_J": 2.0e-20,
                "uniform_boundary_derivative_J": 0.0,
            },
        ]

        validate_runtime_artifact(rows)

    def test_runtime_artifact_csv_loader_parses_numeric_columns(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "dmi_runtime.csv"
            path.write_text(
                "\n".join([
                    "gate,case,expected_chirality,observed_chirality,"
                    "spiral_pitch_m,reference_spiral_pitch_m,"
                    "tilted_boundary_derivative_J,uniform_boundary_derivative_J",
                    "chirality,interfacial-domain-wall,left,left,,,,",
                    "spiral_pitch,bulk-spiral,,,8e-8,7.8e-8,,",
                    "boundary_tilt,interfacial-boundary-tilt,,,,,2e-20,0",
                ])
                + "\n"
            )

            rows = read_csv_rows(path)

        self.assertIsInstance(rows[1]["spiral_pitch_m"], float)
        validate_runtime_artifact(rows)


if __name__ == "__main__":
    unittest.main()
