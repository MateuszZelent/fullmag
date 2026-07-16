from __future__ import annotations

import ast
import contextlib
import io
import json
import math
import unittest
from pathlib import Path

from fullmag.runtime import helper as runtime_helper


EXAMPLES = {
    "exchange_coupled": Path("examples/fem_periodic_antidot_relax_exchange_coupled.py"),
    "exchange_coupled_frequency_driven": Path(
        "examples/fem_periodic_antidot_relax_exchange_coupled_frequency_driven.py"
    ),
    "exchange_coupled_time_domain_k0": Path(
        "examples/fem_periodic_antidot_relax_exchange_coupled_time_domain_k0.py"
    ),
    "exchange_coupled_z_padding_reference": Path(
        "examples/fem_periodic_antidot_relax_exchange_coupled_z_padding_reference.py"
    ),
    "exchange_coupled_supercell_3x3": Path(
        "examples/fem_periodic_antidot_relax_exchange_coupled_supercell_3x3.py"
    ),
    "uniform_slab": Path("examples/fem_periodic_uniform_slab_relax_exchange_coupled.py"),
    "air_gap": Path("examples/fem_periodic_antidot_relax_air_gap.py"),
}
MU0_T_M_PER_A = 4.0e-7 * math.pi
FREQUENCY_DRIVEN_EQUILIBRIUM_TORQUE_TOLERANCE_T = 5.0e-3
FREQUENCY_DRIVEN_EQUILIBRIUM_TORQUE_TOLERANCE_A_PER_M = (
    FREQUENCY_DRIVEN_EQUILIBRIUM_TORQUE_TOLERANCE_T / MU0_T_M_PER_A
)


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
        universe_z: float = 9e-8,
        supercell_repeat: list[int] | None = None,
    ) -> None:
        scenario_metadata = metadata["periodic_antidot_relaxation"]
        self.assertEqual(
            metadata["study_universe"]["size"],
            scenario_metadata["universe_size_m"],
        )
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
        self.assertAlmostEqual(scenario_metadata["universe_size_m"][2], universe_z)
        self.assertAlmostEqual(scenario_metadata["lateral_air_gap_m"][0], lateral_gap_xy)
        self.assertAlmostEqual(scenario_metadata["lateral_air_gap_m"][1], lateral_gap_xy)
        if supercell_repeat is None:
            self.assertNotIn("supercell_repeat", scenario_metadata)
        else:
            self.assertEqual(scenario_metadata["supercell_repeat"], supercell_repeat)

    def assert_problem_ir_declares_xy_pbc(self, payload: dict[str, object]) -> None:
        self.assertEqual(
            payload["ir"]["pbc"],
            {
                "axes": ["periodic", "periodic", "open"],
                "demag": "periodic_airbox_k0",
            },
        )

    def assert_study_saves_equilibrium_and_demag_fields(self, study: dict[str, object]) -> None:
        outputs = study["sampling"]["outputs"]
        saved_fields = [
            output["name"]
            for output in outputs
            if output.get("kind") == "field"
        ]
        self.assertIn("m", saved_fields)
        self.assertIn("H_demag", saved_fields)
        self.assertIn("demag_phi", saved_fields)

    def assert_table_logs_pbc_sensitive_quantities(self, study: dict[str, object]) -> None:
        quantities = study["sampling"]["table_autosave"]["quantities"]
        self.assertIn("e_demag", quantities)
        self.assertIn("max_h_demag", quantities)
        self.assertIn("max_torque", quantities)

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
        self.assertEqual(study["stop"]["max_steps"], 500)
        self.assertEqual(study["stop"]["torque_tolerance_apm"], 5.0e2)
        self.assert_study_saves_equilibrium_and_demag_fields(study)
        self.assert_table_logs_pbc_sensitive_quantities(study)

        metadata = payload["ir"]["problem_meta"]["runtime_metadata"]
        self.assertEqual(metadata["runtime_selection"]["backend"], "fem")
        self.assertEqual(metadata["runtime_selection"]["device"], "cuda")
        self.assertEqual(metadata["mesh_workflow"]["domain_mesh_mode"], "generated_shared_domain_mesh")
        self.assertEqual(
            metadata["mesh_workflow"]["default_mesh"]["periodic_pair_ids"],
            ["x_faces", "y_faces"],
        )
        self.assertEqual(
            metadata["mesh_workflow"]["mesh_options"]["periodic_pair_ids"],
            ["x_faces", "y_faces"],
        )
        self.assert_scenario_metadata(
            metadata,
            scenario="exchange_coupled",
            exchange_coupled=True,
            universe_xy=2e-7,
            lateral_gap_xy=0.0,
        )

    def test_exchange_coupled_frequency_driven_scenario_relaxes_then_computes_driven_response(self) -> None:
        self.assert_example_is_plain_python("exchange_coupled_frequency_driven")
        payload = self.export_run_config("exchange_coupled_frequency_driven")
        self.assert_problem_ir_declares_xy_pbc(payload)

        self.assertEqual(
            payload["ir"]["problem_meta"]["name"],
            "fem_periodic_antidot_relax_exchange_coupled_frequency_driven",
        )
        self.assertEqual(len(payload["stages"]), 3)
        self.assertEqual(payload["stages"][0]["entrypoint_kind"], "flat_relax")
        self.assertEqual(payload["stages"][1]["entrypoint_kind"], "flat_change_device")
        self.assertEqual(
            payload["stages"][1]["action"],
            {"kind": "change_device", "device": "gpu"},
        )
        self.assertEqual(payload["stages"][2]["entrypoint_kind"], "flat_frequency_response")

        minimize = payload["stages"][0]["ir"]["study"]
        self.assertEqual(
            payload["stages"][0]["ir"]["problem_meta"]["runtime_metadata"][
                "runtime_selection"
            ]["device"],
            "cuda",
        )
        self.assertEqual(minimize["kind"], "relaxation")
        self.assertEqual(minimize["algorithm"], "projected_gradient_bb")
        self.assertEqual(minimize["stop"]["max_steps"], 4000)
        self.assertAlmostEqual(
            minimize["stop"]["torque_tolerance_apm"],
            FREQUENCY_DRIVEN_EQUILIBRIUM_TORQUE_TOLERANCE_A_PER_M,
        )

        self.assertEqual(
            payload["stages"][2]["ir"]["problem_meta"]["runtime_metadata"][
                "runtime_selection"
            ]["device"],
            "gpu",
        )
        frequency_response = payload["stages"][2]["ir"]["study"]
        self.assertEqual(frequency_response["kind"], "frequency_response")
        self.assertEqual(frequency_response["operator"]["include_demag"], True)
        self.assertEqual(frequency_response["magnetostatic_bc"], "periodic_airbox_k0")
        self.assertEqual(frequency_response["equilibrium"], {"kind": "relaxed_initial_state"})
        self.assertEqual(frequency_response["damping_policy"], "include")
        self.assertEqual(
            frequency_response["spin_wave_bc"],
            {"kind": "periodic", "pair_ids": ["x_faces", "y_faces"]},
        )
        self.assertEqual(
            frequency_response["frequencies_hz"],
            {"values_hz": [2.0e9]},
        )
        self.assertEqual(
            frequency_response["solver_policy"],
            {
                "method": "gpu_operator_host_krylov",
                "preconditioner": "block_jacobi",
                "max_iterations": 8192,
                "restart_iterations": 512,
            },
        )
        self.assertEqual(
            frequency_response["sampling"]["outputs"],
            [
                {
                    "kind": "frequency_response_output",
                    "observable": "susceptibility_tensor",
                },
            ],
        )

        metadata = payload["ir"]["problem_meta"]["runtime_metadata"]
        scenario_metadata = metadata["periodic_antidot_relaxation"]
        self.assertEqual(scenario_metadata["frequency_response_dynamic_demag"], True)
        self.assertAlmostEqual(
            scenario_metadata["equilibrium_torque_tolerance_t"],
            FREQUENCY_DRIVEN_EQUILIBRIUM_TORQUE_TOLERANCE_T,
        )
        self.assertAlmostEqual(
            scenario_metadata["equilibrium_torque_tolerance_a_per_m"],
            FREQUENCY_DRIVEN_EQUILIBRIUM_TORQUE_TOLERANCE_A_PER_M,
        )
        self.assertEqual(
            scenario_metadata["frequency_response_magnetostatic_bc"],
            "periodic_airbox_k0",
        )
        self.assertEqual(
            scenario_metadata["frequency_response_preconditioner"],
            "block_jacobi",
        )
        self.assert_scenario_metadata(
            metadata,
            scenario="exchange_coupled_frequency_driven",
            exchange_coupled=True,
            universe_xy=2e-7,
            universe_z=4e-7,
            lateral_gap_xy=0.0,
        )

    def test_exchange_coupled_time_domain_k0_relaxes_then_runs_uniform_sinc_excitation(self) -> None:
        scenario = "exchange_coupled_time_domain_k0"
        self.assert_example_is_plain_python(scenario)
        payload = self.export_run_config(scenario)
        self.assert_problem_ir_declares_xy_pbc(payload)

        self.assertEqual(
            payload["ir"]["problem_meta"]["name"],
            "fem_periodic_antidot_relax_exchange_coupled_time_domain_k0",
        )
        self.assertEqual(len(payload["stages"]), 6)
        self.assertEqual(payload["stages"][0]["entrypoint_kind"], "flat_relax")
        self.assertEqual(
            payload["stages"][1]["entrypoint_kind"],
            "flat_add_field_drive",
        )
        self.assertEqual(payload["stages"][2]["entrypoint_kind"], "flat_table_autosave")
        self.assertEqual(payload["stages"][4]["entrypoint_kind"], "flat_fft_response")
        self.assertEqual(payload["stages"][5]["entrypoint_kind"], "flat_run")
        self.assertEqual(payload["stages"][0]["ir"]["study"]["kind"], "relaxation")
        self.assertEqual(payload["stages"][5]["ir"]["study"]["kind"], "time_evolution")
        self.assertEqual(
            payload["stages"][0]["ir"]["problem_meta"]["runtime_metadata"]["active_stage_id"],
            "relax",
        )
        self.assertEqual(
            payload["stages"][1]["ir"]["problem_meta"]["runtime_metadata"]["active_stage_id"],
            "add-k0-antenna",
        )
        self.assertEqual(
            payload["stages"][5]["ir"]["problem_meta"]["runtime_metadata"]["active_stage_id"],
            "excite",
        )

        self.assertEqual(payload["ir"]["field_drives"], [])
        self.assertEqual(payload["stages"][0]["ir"]["field_drives"], [])
        self.assertEqual(payload["stages"][1]["ir"]["field_drives"], [])
        drive = payload["stages"][1]["action"]["drive"]
        self.assertEqual(drive["target"], {"kind": "global"})
        self.assertEqual(drive["spatial_profile"], {"kind": "uniform"})
        self.assertEqual(drive["waveform"]["kind"], "sinc_pulse")
        self.assertEqual(
            drive["activation"],
            {"kind": "stage_ids", "stage_ids": ["excite"]},
        )
        self.assertEqual(
            [drive["id"] for drive in payload["stages"][5]["ir"]["field_drives"]],
            ["k0-sinc-antenna"],
        )

        self.assertEqual(
            [payload["stages"][index]["action"]["kind"] for index in range(2, 5)],
            [
                "table_autosave",
                "autosave",
                "fft_response",
            ],
        )
        sampling = payload["stages"][5]["ir"]["study"]["sampling"]
        self.assertAlmostEqual(sampling["table_autosave"]["sample_period_s"], 5e-13)
        self.assertEqual(sampling["table_autosave"]["quantities"], ["t", "mx", "my", "mz"])
        self.assertEqual(
            sampling["outputs"],
            [{"kind": "field", "name": "m", "every_seconds": 5e-13}],
        )
        response = payload["stages"][5]["ir"]["problem_meta"]["runtime_metadata"][
            "spin_wave_response"
        ]
        self.assertEqual(response["analysis"], "gamma")
        self.assertEqual(response["schema_version"], "spin_wave_response.request.v1")

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

        study = payload["stages"][0]["ir"]["study"]
        self.assertEqual(study["algorithm"], "projected_gradient_bb")
        self.assertEqual(study["stop"]["max_steps"], 4000)
        self.assertEqual(study["stop"]["torque_tolerance_apm"], 5.0e2)
        self.assert_study_saves_equilibrium_and_demag_fields(study)
        self.assert_table_logs_pbc_sensitive_quantities(study)

        metadata = payload["ir"]["problem_meta"]["runtime_metadata"]
        self.assertEqual(
            metadata["mesh_workflow"]["default_mesh"]["periodic_pair_ids"],
            ["x_faces", "y_faces"],
        )
        self.assertEqual(
            metadata["mesh_workflow"]["mesh_options"]["periodic_pair_ids"],
            ["x_faces", "y_faces"],
        )
        self.assert_scenario_metadata(
            metadata,
            scenario="air_gap",
            exchange_coupled=False,
            universe_xy=3.2e-7,
            lateral_gap_xy=1.2e-7,
        )

    def test_uniform_slab_scenario_relaxes_minimal_periodic_pbc_demag_control(self) -> None:
        self.assert_example_is_plain_python("uniform_slab")
        payload = self.export_run_config("uniform_slab")
        self.assert_problem_ir_declares_xy_pbc(payload)

        self.assertEqual(
            payload["ir"]["problem_meta"]["name"],
            "fem_periodic_uniform_slab_relax",
        )
        self.assertEqual(len(payload["stages"]), 1)
        self.assertEqual(payload["stages"][0]["entrypoint_kind"], "flat_relax")

        study = payload["stages"][0]["ir"]["study"]
        self.assertEqual(study["algorithm"], "projected_gradient_bb")
        self.assertEqual(study["stop"]["max_steps"], 120)
        self.assertEqual(study["stop"]["torque_tolerance_apm"], 5.0e2)
        self.assert_study_saves_equilibrium_and_demag_fields(study)
        self.assert_table_logs_pbc_sensitive_quantities(study)

        metadata = payload["ir"]["problem_meta"]["runtime_metadata"]
        self.assertEqual(metadata["runtime_selection"]["backend"], "fem")
        self.assertEqual(metadata["runtime_selection"]["device"], "cuda")
        self.assert_scenario_metadata(
            metadata,
            scenario="uniform_slab",
            exchange_coupled=True,
            universe_xy=2e-7,
            lateral_gap_xy=0.0,
        )

    def test_exchange_coupled_z_padding_reference_uses_same_workload_with_larger_open_z_airbox(self) -> None:
        self.assert_example_is_plain_python("exchange_coupled_z_padding_reference")
        payload = self.export_run_config("exchange_coupled_z_padding_reference")
        self.assert_problem_ir_declares_xy_pbc(payload)

        self.assertEqual(
            payload["ir"]["problem_meta"]["name"],
            "fem_periodic_antidot_relax_exchange_coupled_z_padding_reference",
        )
        metadata = payload["ir"]["problem_meta"]["runtime_metadata"]
        self.assert_scenario_metadata(
            metadata,
            scenario="exchange_coupled",
            exchange_coupled=True,
            universe_xy=2e-7,
            lateral_gap_xy=0.0,
            universe_z=1.3e-7,
        )

    def test_exchange_coupled_supercell_3x3_uses_repeated_workload_with_scaled_universe(self) -> None:
        self.assert_example_is_plain_python("exchange_coupled_supercell_3x3")
        payload = self.export_run_config("exchange_coupled_supercell_3x3")
        self.assert_problem_ir_declares_xy_pbc(payload)

        self.assertEqual(
            payload["ir"]["problem_meta"]["name"],
            "fem_periodic_antidot_relax_exchange_coupled_supercell_3x3",
        )
        metadata = payload["ir"]["problem_meta"]["runtime_metadata"]
        self.assert_scenario_metadata(
            metadata,
            scenario="exchange_coupled",
            exchange_coupled=True,
            universe_xy=6e-7,
            lateral_gap_xy=0.0,
            universe_z=9e-8,
            supercell_repeat=[3, 3],
        )


if __name__ == "__main__":
    unittest.main()
