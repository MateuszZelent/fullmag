from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path
import unittest

from fullmag.runtime import helper as runtime_helper


FIXTURE = Path("examples/fem_reciprocal_m2_public.py")


class PublicFemReciprocalM2FixtureTests(unittest.TestCase):
    def export_run_config(self) -> dict[str, object]:
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            exit_code = runtime_helper.main(
                [
                    "export-run-config",
                    "--script",
                    str(FIXTURE),
                    "--backend",
                    "fem",
                    "--mode",
                    "strict",
                    "--precision",
                    "double",
                    "--skip-geometry-assets",
                ]
            )
        self.assertEqual(exit_code, 0)
        return json.loads(stdout.getvalue())

    def test_public_fixture_preserves_fem_m2_graph_without_demag(self) -> None:
        config = self.export_run_config()
        self.assertEqual(len(config["stages"]), 1)
        stage_ir = config["stages"][0]["ir"]

        self.assertEqual(
            stage_ir["energy_terms"],
            [
                {"kind": "exchange"},
                {
                    "id": "oersted:m2_charge",
                    "kind": "oersted_field",
                    "model": "from_current_solution",
                    "source": "m2_charge",
                },
            ],
        )
        self.assertEqual(stage_ir["current_modules"][0]["model"], "magnetoresistive_poisson")
        self.assertEqual(stage_ir["current_modules"][0]["coupling"], "bidirectional")
        self.assertEqual(
            stage_ir["current_modules"][0]["solver"]["operator_version"],
            "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1",
        )
        self.assertEqual(
            stage_ir["spin_transport_modules"][0]["solver"]["operator_version"],
            "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1",
        )
        self.assertEqual(stage_ir["spin_torque_modules"][0]["solve_id"], "m2_spin")
        self.assertEqual(
            stage_ir["physics_graph"]["edges"],
            [
                {
                    "kind": "current_to_oersted",
                    "source_id": "m2_charge",
                    "status": "active",
                    "target_id": "oersted:m2_charge",
                },
                {
                    "kind": "current_to_spin_transport",
                    "source_id": "m2_charge",
                    "status": "active",
                    "target_id": "m2_spin",
                },
                {
                    "kind": "current_to_torque",
                    "source_id": "m2_spin",
                    "status": "active",
                    "target_id": "m2_torque",
                },
            ],
        )

        runtime = stage_ir["problem_meta"]["runtime_metadata"]["runtime_selection"]
        self.assertEqual(
            runtime,
            {
                "backend": "fem",
                "device": "cpu",
                "gpu_count": 0,
                "device_index": None,
                "cpu_threads": None,
                "execution_mode": "strict",
                "execution_precision": "double",
            },
        )


if __name__ == "__main__":
    unittest.main()
