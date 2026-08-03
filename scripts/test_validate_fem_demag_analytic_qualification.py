#!/usr/bin/env python3
"""RED/acceptance checks for the FEM analytic-demag qualification gate."""

from __future__ import annotations

import importlib.util
import json
import math
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("validate_fem_demag_analytic_qualification.py")
SPEC = importlib.util.spec_from_file_location("analytic_demag_validator", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import wiring guard
    raise RuntimeError(f"cannot load analytic-demag validator: {SCRIPT_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FemDemagAnalyticQualificationRedTests(unittest.TestCase):
    def test_rejects_missing_complete_managed_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, "missing complete managed artifact"):
                MODULE.validate_qualification(Path(temporary) / "absent.json")

    def test_rejects_relaxed_box_artifact_as_analytic_qualification(self) -> None:
        """A relaxation-derived box row cannot be promoted as a field oracle."""
        with tempfile.TemporaryDirectory() as temporary:
            artifact = Path(temporary) / "relaxed-box.json"
            artifact.write_text(
                json.dumps(
                    {
                        "schema_version": "fullmag.fem_demag_analytic_qualification.v1",
                        "runtime": {"managed": True},
                        "physics_rows": [
                            {
                                "case_id": "box500_airbox_exchange_demag",
                                "initial_state_kind": "relaxed",
                                "demag_evaluation_count": 64,
                                "relaxation_algorithm": "nonlinear_cg",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "prescribed_uniform"):
                MODULE.validate_qualification(artifact)

    def test_rejects_self_certified_sphere_factor(self) -> None:
        ms = 800_000.0
        volume = 1.0e-21
        snapshot = "a" * 64
        row = {
            "case_id": "sphere_uniform",
            "axis": "z",
            "mesh_refinement": "fine",
            "airbox_scale": 3.0,
            "backend": "fem_cpu",
            "initial_state_kind": "prescribed_uniform",
            "demag_evaluation_count": 1,
            "relaxation_algorithm": "none",
            "solver_mesh_signature": "b" * 64,
            "source_provenance": {
                "source_snapshot_sha256": snapshot,
                "serialized_typed_mesh_sha256": "c" * 64,
                "problem_ir_sha256": "d" * 64,
            },
            "ms_Apm": ms,
            "magnetic_volume_m3": volume,
            "h_demag_mean_magnetic_Apm": [0.0, 0.0, -ms / 3.0],
            "e_demag_J": 0.5 * 4.0e-7 * math.pi * (1.0 / 3.0) * ms * ms * volume,
            "e_demag_analytic_J": 0.5 * 4.0e-7 * math.pi * (1.0 / 3.0) * ms * ms * volume,
            "n_analytic": 0.5,
            "demag_linear_residual": 1.0e-13,
            "demag_linear_iterations": 4,
        }
        sphere = {
            "case_id": "sphere_uniform",
            "kind": "sphere",
            "semi_axes_m": [50e-9, 50e-9, 50e-9],
        }

        with self.assertRaisesRegex(ValueError, "geometry-derived sphere/Osborn oracle"):
            MODULE._validate_row(row, 0, sphere, snapshot)

    def test_rejects_incomplete_cpu_gpu_pair_without_key_error(self) -> None:
        rows = [
            {
                "case_id": "sphere_uniform",
                "axis": "z",
                "mesh_refinement": "fine",
                "airbox_scale": 3.0,
                "backend": "fem_cpu",
            }
        ]

        with self.assertRaisesRegex(ValueError, "CPU/GPU pair is incomplete"):
            MODULE._validate_cpu_gpu_parity(rows)


if __name__ == "__main__":
    unittest.main()
