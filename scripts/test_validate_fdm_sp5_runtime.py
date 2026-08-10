from __future__ import annotations

import json
import struct
import tempfile
import unittest
from pathlib import Path

from scripts.validate_fdm_sp5_runtime import (
    MUMAX3_REFERENCE_MEAN,
    load_converged_reference,
    validate_runs,
)


def write_run(root: Path, *, engine: str, values: list[list[float]], dt: float = 1e-13) -> None:
    root.mkdir(parents=True)
    (root / "solver").mkdir()
    (root / "physics").mkdir()
    device = "cpu" if engine == "cpu_reference" else "gpu"
    step_count = round(1e-9 / dt)
    (root / "metadata.json").write_text(
        json.dumps(
            {
                "accepted_solver_steps": step_count,
                "problem_name": "mumax_standard_problem_5_fdm",
                "requested_execution": {
                    "backend": "fdm",
                    "device": device,
                    "precision": "double",
                    "fallback_policy": "forbidden",
                },
                "execution_provenance": {
                    "execution_engine": engine,
                    "lossy_fallback_used": False,
                    "precision": "double",
                },
            }
        ),
        encoding="utf-8",
    )
    (root / "m_final.json").write_text(
        json.dumps(
            {
                "observable": "m",
                "unit": "1",
                "step": step_count,
                "time": 1e-9,
                "values": values,
                "layout": {
                    "grid_cells": [32, 32, 4],
                    "cell_size": [3.125e-9, 3.125e-9, 2.5e-9],
                },
                "provenance": {
                    "problem_name": "mumax_standard_problem_5_fdm",
                    "execution_engine": engine,
                    "precision": "double",
                    "lossy_fallback_used": False,
                    "timestep_policy": {
                        "resolved": {"kind": "fixed", "timestep_s": dt}
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    (root / "solver" / "accepted_steps.v1.json").write_text(
        json.dumps(
            {
                "schema_version": "LLG-TD-ACCEPTED-TRACE-V1",
                "steps": [
                    {"step": index, "time": index * dt, "dt": dt}
                    for index in range(1, step_count + 1)
                ],
            }
        ),
        encoding="utf-8",
    )
    (root / "physics" / "physics_graph_provenance.v1.json").write_text(
        json.dumps(
            {
                "realization": {
                    "executed_module_ids": ["sp5_zhang_li"],
                    "modules": [
                        {
                            "module_id": "sp5_zhang_li",
                            "state": "executed",
                            "realized_cell_count": 4096,
                        }
                    ],
                }
            }
        ),
        encoding="utf-8",
    )


class ValidateFdmSp5RuntimeTests(unittest.TestCase):
    def test_rejects_converged_reference_with_wrong_grid(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "wrong-grid.ovf"
            path.write_bytes(
                b"# OOMMF OVF 2.0\n"
                b"# xnodes: 1\n# ynodes: 1\n# znodes: 1\n"
                b"# Begin: Data Binary 4\n"
                + struct.pack("<4f", 1234567.0, 1.0, 0.0, 0.0)
            )

            with self.assertRaisesRegex(ValueError, "grid"):
                load_converged_reference(path)

    def test_separates_internal_parity_from_external_reference(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            values = [
                [
                    MUMAX3_REFERENCE_MEAN[0] + 2.0e-4,
                    MUMAX3_REFERENCE_MEAN[1],
                    MUMAX3_REFERENCE_MEAN[2],
                ]
            ] * 4096
            write_run(root / "cpu", engine="cpu_reference", values=values)
            write_run(root / "gpu", engine="cuda_fdm", values=values)

            report = validate_runs(root / "cpu", root / "gpu")

            self.assertEqual(report["cpu_cuda_parity"]["status"], "pass")
            self.assertEqual(report["mumax3_reference"]["status"], "fail")
            self.assertEqual(report["qualification_status"], "not_qualified")

    def test_rejects_wrong_grid_before_comparison(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            values = [list(MUMAX3_REFERENCE_MEAN)] * 4096
            write_run(root / "cpu", engine="cpu_reference", values=values)
            write_run(root / "gpu", engine="cuda_fdm", values=values)
            payload = json.loads((root / "gpu" / "m_final.json").read_text())
            payload["layout"]["grid_cells"] = [16, 16, 4]
            (root / "gpu" / "m_final.json").write_text(json.dumps(payload))

            with self.assertRaisesRegex(ValueError, "grid_cells"):
                validate_runs(root / "cpu", root / "gpu")

    def test_accepts_a_finer_fixed_timestep_with_derived_step_count(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            values = [list(MUMAX3_REFERENCE_MEAN)] * 4096
            write_run(root / "cpu", engine="cpu_reference", values=values, dt=5e-14)
            write_run(root / "gpu", engine="cuda_fdm", values=values, dt=5e-14)

            report = validate_runs(root / "cpu", root / "gpu")

            self.assertEqual(report["cpu"]["accepted_steps"], 20000)
            self.assertEqual(report["gpu"]["accepted_steps"], 20000)
            self.assertEqual(report["qualification_status"], "qualified")

    def test_can_select_full_field_converged_demag_reference_without_hiding_literal_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            values = [
                [
                    MUMAX3_REFERENCE_MEAN[0] + 2.0e-4,
                    MUMAX3_REFERENCE_MEAN[1],
                    MUMAX3_REFERENCE_MEAN[2],
                ]
            ] * 4096
            write_run(root / "cpu", engine="cpu_reference", values=values)
            write_run(root / "gpu", engine="cuda_fdm", values=values)

            report = validate_runs(
                root / "cpu",
                root / "gpu",
                converged_reference_values=[tuple(vector) for vector in values],
                qualification_reference="converged_demag",
            )

            self.assertEqual(report["mumax3_reference"]["status"], "fail")
            self.assertEqual(
                report["mumax3_converged_demag_reference"]["status"], "pass"
            )
            self.assertEqual(report["qualification_reference"], "converged_demag")
            self.assertEqual(report["qualification_status"], "qualified")


if __name__ == "__main__":
    unittest.main()
