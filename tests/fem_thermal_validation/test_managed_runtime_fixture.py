"""Focused checks for the managed FEM CPU thermal-runtime fixture validator."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.validate_fem_thermal_cpu_runtime import validate_result  # noqa: E402


def valid_result() -> dict[str, object]:
    return {
        "status": "completed",
        "total_steps": 8,
        "backend": "fem",
        "mode": "strict",
        "precision": "double",
        "requested_execution": {
            "backend": "fem",
            "device": "cpu",
            "precision": "double",
            "mode": "strict",
            "fallback_policy": "forbidden",
        },
    }


class ManagedThermalRuntimeFixtureTests(unittest.TestCase):
    def test_accepts_completed_strict_fem_cpu_run_with_nonzero_thermal_field(self) -> None:
        artifact = {
            "metadata": {
                "requested_execution": valid_result()["requested_execution"],
                "execution_provenance": {
                    "execution_engine": "fem_cpu_native",
                    "lossy_fallback_used": False,
                    "thermal_seed": 17,
                },
                "execution_plan": {
                    "backend_plan": {
                        "temperature": 300.0,
                        "thermal_seed_config": {"policy": "fixed", "seed": 17},
                    }
                },
            },
            "h_therm": {"values": [[1.0, 0.0, 0.0], [0.0, -2.0, 0.0]]},
        }

        validate_result(valid_result(), artifact, expected_seed=17, expected_steps=8)

    def test_rejects_zero_thermal_field(self) -> None:
        artifact = {
            "metadata": {
                "requested_execution": valid_result()["requested_execution"],
                "execution_provenance": {"execution_engine": "fem_cpu_native", "lossy_fallback_used": False},
                "execution_plan": {
                    "backend_plan": {
                        "temperature": 300.0,
                        "thermal_seed_config": {"policy": "fixed", "seed": 17},
                    }
                },
            },
            "h_therm": {"values": [[0.0, 0.0, 0.0]]},
        }

        with self.assertRaisesRegex(ValueError, "H_therm"):
            validate_result(valid_result(), artifact, expected_seed=17, expected_steps=8)

    def test_rejects_missing_fixed_seed_provenance(self) -> None:
        artifact = {
            "metadata": {
                "requested_execution": valid_result()["requested_execution"],
                "execution_provenance": {"execution_engine": "fem_cpu_native", "lossy_fallback_used": False},
                "execution_plan": {"backend_plan": {"temperature": 300.0}},
            },
            "h_therm": {"values": [[1.0, 0.0, 0.0]]},
        }

        with self.assertRaisesRegex(ValueError, "thermal seed provenance"):
            validate_result(valid_result(), artifact, expected_seed=17, expected_steps=8)

    def test_rejects_statistical_or_gpu_claims(self) -> None:
        artifact = {
            "metadata": {
                "requested_execution": valid_result()["requested_execution"],
                "execution_provenance": {
                    "execution_engine": "fem_cpu_native",
                    "lossy_fallback_used": False,
                    "validation_status": "statistically_validated",
                },
                "execution_plan": {
                    "backend_plan": {
                        "temperature": 300.0,
                        "thermal_seed_config": {"policy": "fixed", "seed": 17},
                    }
                },
            },
            "h_therm": {"values": [[1.0, 0.0, 0.0]]},
        }

        with self.assertRaisesRegex(ValueError, "statistically_validated"):
            validate_result(valid_result(), artifact, expected_seed=17, expected_steps=8)


if __name__ == "__main__":
    unittest.main()
