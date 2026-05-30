"""Unit checks for FEM thermal runtime-validation acceptance helpers."""

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
    boltzmann_macrospin_parallel_mean,
    brown_variance,
    require_boltzmann_macrospin_mean,
    require_inverse_dt_variance_scaling,
    require_variance_matches_reference,
)
from artifact_validation import read_csv_rows, validate_runtime_artifact  # noqa: E402


class ThermalValidationAcceptanceTests(unittest.TestCase):
    def test_brown_variance_scales_inverse_dt(self) -> None:
        short_dt = brown_variance(
            temperature=300.0,
            damping=0.1,
            gamma_mu0=2.211e5,
            ms=800e3,
            volume=1.0e-27,
            dt=1.0e-12,
        )
        long_dt = brown_variance(
            temperature=300.0,
            damping=0.1,
            gamma_mu0=2.211e5,
            ms=800e3,
            volume=1.0e-27,
            dt=4.0e-12,
        )

        self.assertAlmostEqual(short_dt / long_dt, 4.0)

    def test_variance_acceptance_rejects_bad_sample_moment(self) -> None:
        rows = [
            {
                "case": "dt-short",
                "sample_variance_Apm2": 1.25,
                "reference_variance_Apm2": 1.0,
            }
        ]

        with self.assertRaisesRegex(ValidationFailure, "dt-short.*sample_variance"):
            require_variance_matches_reference(
                rows,
                variance_key="sample_variance_Apm2",
                reference_key="reference_variance_Apm2",
                relative_tolerance=0.10,
                label_key="case",
            )

    def test_inverse_dt_acceptance_rejects_bad_ratio(self) -> None:
        rows = [
            {"case": "short", "dt_s": 1.0e-12, "sample_variance_Apm2": 4.0},
            {"case": "long", "dt_s": 4.0e-12, "sample_variance_Apm2": 2.0},
        ]

        with self.assertRaisesRegex(ValidationFailure, "inverse-dt"):
            require_inverse_dt_variance_scaling(
                rows,
                dt_key="dt_s",
                variance_key="sample_variance_Apm2",
                relative_tolerance=0.10,
            )

    def test_boltzmann_macrospin_mean_uses_langevin_reference(self) -> None:
        mean = boltzmann_macrospin_parallel_mean(
            ms=800e3,
            volume=1.0e-24,
            field_Apm=4000.0,
            temperature=300.0,
        )

        self.assertGreater(mean, 0.0)
        self.assertLess(mean, 1.0)

    def test_boltzmann_macrospin_acceptance_rejects_wrong_mean(self) -> None:
        row = {
            "case": "macrospin",
            "m_parallel_mean": 0.0,
            "ms_Apm": 800e3,
            "volume_m3": 1.0e-24,
            "field_Apm": 4000.0,
            "temperature_K": 300.0,
        }

        with self.assertRaisesRegex(ValidationFailure, "macrospin.*Boltzmann"):
            require_boltzmann_macrospin_mean(
                row,
                mean_key="m_parallel_mean",
                ms_key="ms_Apm",
                volume_key="volume_m3",
                field_key="field_Apm",
                temperature_key="temperature_K",
                absolute_tolerance=0.10,
                label="macrospin",
            )

    def test_runtime_artifact_validator_requires_variance_and_boltzmann_rows(self) -> None:
        rows = [
            {
                "gate": "variance",
                "case": "short",
                "dt_s": 1.0e-12,
                "sample_variance_Apm2": 4.0,
                "reference_variance_Apm2": 4.0,
            },
            {
                "gate": "variance",
                "case": "long",
                "dt_s": 4.0e-12,
                "sample_variance_Apm2": 1.0,
                "reference_variance_Apm2": 1.0,
            },
        ]

        with self.assertRaisesRegex(ValidationFailure, "boltzmann"):
            validate_runtime_artifact(rows)

    def test_runtime_artifact_validator_accepts_complete_rows(self) -> None:
        rows = [
            {
                "gate": "variance",
                "case": "short",
                "dt_s": 1.0e-12,
                "sample_variance_Apm2": 4.0,
                "reference_variance_Apm2": 4.0,
            },
            {
                "gate": "variance",
                "case": "long",
                "dt_s": 4.0e-12,
                "sample_variance_Apm2": 1.0,
                "reference_variance_Apm2": 1.0,
            },
            {
                "gate": "boltzmann",
                "case": "macrospin",
                "m_parallel_mean": boltzmann_macrospin_parallel_mean(
                    ms=800e3,
                    volume=1.0e-24,
                    field_Apm=4000.0,
                    temperature=300.0,
                ),
                "ms_Apm": 800e3,
                "volume_m3": 1.0e-24,
                "field_Apm": 4000.0,
                "temperature_K": 300.0,
            },
        ]

        validate_runtime_artifact(rows)

    def test_runtime_artifact_csv_loader_parses_numeric_columns(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "thermal_runtime.csv"
            expected_mean = boltzmann_macrospin_parallel_mean(
                ms=800e3,
                volume=1.0e-24,
                field_Apm=4000.0,
                temperature=300.0,
            )
            path.write_text(
                "\n".join([
                    "gate,case,dt_s,sample_variance_Apm2,reference_variance_Apm2,"
                    "m_parallel_mean,ms_Apm,volume_m3,field_Apm,temperature_K",
                    "variance,short,1e-12,4.0,4.0,,,,,",
                    "variance,long,4e-12,1.0,1.0,,,,,",
                    f"boltzmann,macrospin,,,,{expected_mean},800000,1e-24,4000,300",
                ])
                + "\n"
            )

            rows = read_csv_rows(path)

        self.assertIsInstance(rows[0]["dt_s"], float)
        validate_runtime_artifact(rows)


if __name__ == "__main__":
    unittest.main()
