from __future__ import annotations

import ast
import contextlib
import io
import json
import unittest
from pathlib import Path

from fullmag.runtime import helper as runtime_helper


EXAMPLES = {
    "exchange_coupled": Path("examples/fem_periodic_antidot_relax_exchange_coupled.py"),
    "air_gap": Path("examples/fem_periodic_antidot_relax_air_gap.py"),
}


class PeriodicAntidotRelaxationExampleTests(unittest.TestCase):
    def export_run_config(self, scenario: str) -> dict[str, object]:
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            exit_code = runtime_helper.main(
                [
                    "export-run-config",
                    "--script",
                    str(EXAMPLES[scenario]),
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

    def assert_example_is_plain_python(self, scenario: str) -> None:
        source = EXAMPLES[scenario].read_text(encoding="utf-8")
        tree = ast.parse(source)
        forbidden_fragments = [
            "os.environ",
            "FULLMAG_PBC_RELAX",
            "def env_",
            "env_bool",
            "env_float",
            "env_int",
            "env_str",
            "FAST_RUNTIME_MESH",
        ]
        for fragment in forbidden_fragments:
            with self.subTest(fragment=fragment):
                self.assertNotIn(
                    fragment,
                    source,
                    f"{EXAMPLES[scenario]} should declare parameters directly",
                )
        for node in tree.body:
            with self.subTest(node=type(node).__name__):
                self.assertNotIsInstance(
                    node,
                    ast.FunctionDef,
                    f"{EXAMPLES[scenario]} should keep geometry inline",
                )
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id.isupper():
                        self.fail(
                            f"{EXAMPLES[scenario]} should not hide parameters in "
                            f"a top-level constant: {target.id}"
                        )

    def assert_scenario_metadata(
        self,
        metadata: dict[str, object],
        *,
        scenario: str,
        exchange_coupled: bool,
        universe_xy: float,
        lateral_gap_xy: float,
    ) -> None:
        scenario_metadata = metadata["periodic_antidot_relaxation"]
        self.assertEqual(scenario_metadata["scenario"], scenario)
        self.assertEqual(
            scenario_metadata["exchange_coupled_across_periods"],
            exchange_coupled,
        )
        self.assertEqual(scenario_metadata["magnetostatic_pbc"], "periodic_airbox_k0")
        self.assertEqual(scenario_metadata["periodic_pair_ids"], ["x_faces", "y_faces"])
        self.assertEqual(len(scenario_metadata["film_size_m"]), 3)
        self.assertEqual(len(scenario_metadata["universe_size_m"]), 3)
        self.assertEqual(len(scenario_metadata["lateral_air_gap_m"]), 2)
        self.assertAlmostEqual(scenario_metadata["film_size_m"][0], 2e-7)
        self.assertAlmostEqual(scenario_metadata["film_size_m"][1], 2e-7)
        self.assertAlmostEqual(scenario_metadata["film_size_m"][2], 1e-8)
        self.assertAlmostEqual(scenario_metadata["universe_size_m"][0], universe_xy)
        self.assertAlmostEqual(scenario_metadata["universe_size_m"][1], universe_xy)
        self.assertAlmostEqual(scenario_metadata["universe_size_m"][2], 9e-8)
        self.assertAlmostEqual(scenario_metadata["lateral_air_gap_m"][0], lateral_gap_xy)
        self.assertAlmostEqual(scenario_metadata["lateral_air_gap_m"][1], lateral_gap_xy)

    def assert_problem_ir_declares_xy_pbc(self, payload: dict[str, object]) -> None:
        self.assertEqual(
            payload["ir"]["pbc"],
            {
                "axes": ["periodic", "periodic", "open"],
                "demag": "open",
            },
        )

    def test_exchange_coupled_scenario_relaxes_periodic_antidot_unit_cell(self) -> None:
        self.assert_example_is_plain_python("exchange_coupled")
        payload = self.export_run_config("exchange_coupled")
        self.assert_problem_ir_declares_xy_pbc(payload)

        self.assertEqual(
            payload["ir"]["problem_meta"]["name"],
            "fem_periodic_antidot_relax_exchange_coupled",
        )
        self.assertEqual(len(payload["stages"]), 1)
        self.assertEqual(payload["stages"][0]["entrypoint_kind"], "flat_relax")

        study = payload["stages"][0]["ir"]["study"]
        self.assertEqual(study["kind"], "relaxation")
        self.assertEqual(study["algorithm"], "projected_gradient_bb")
        self.assertEqual(study["stop"]["max_steps"], 4)

        metadata = payload["ir"]["problem_meta"]["runtime_metadata"]
        self.assertEqual(metadata["runtime_selection"]["backend"], "fem")
        self.assertEqual(metadata["runtime_selection"]["device"], "cpu")
        self.assertEqual(metadata["mesh_workflow"]["domain_mesh_mode"], "generated_shared_domain_mesh")
        self.assertEqual(
            metadata["mesh_workflow"]["default_mesh"]["periodic_pair_ids"],
            ["x_faces", "y_faces"],
        )
        self.assert_scenario_metadata(
            metadata,
            scenario="exchange_coupled",
            exchange_coupled=True,
            universe_xy=2e-7,
            lateral_gap_xy=0.0,
        )

    def test_air_gap_scenario_relaxes_centered_periodic_antidot_without_exchange_coupling(self) -> None:
        self.assert_example_is_plain_python("air_gap")
        payload = self.export_run_config("air_gap")
        self.assert_problem_ir_declares_xy_pbc(payload)

        self.assertEqual(
            payload["ir"]["problem_meta"]["name"],
            "fem_periodic_antidot_relax_air_gap",
        )
        self.assertEqual(len(payload["stages"]), 1)
        self.assertEqual(payload["stages"][0]["entrypoint_kind"], "flat_relax")

        metadata = payload["ir"]["problem_meta"]["runtime_metadata"]
        self.assertEqual(
            metadata["mesh_workflow"]["default_mesh"]["periodic_pair_ids"],
            ["x_faces", "y_faces"],
        )
        self.assert_scenario_metadata(
            metadata,
            scenario="air_gap",
            exchange_coupled=False,
            universe_xy=3.2e-7,
            lateral_gap_xy=1.2e-7,
        )


if __name__ == "__main__":
    unittest.main()
