from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import unittest
import warnings
from pathlib import Path
from unittest import mock

import fullmag as fm


REPO_ROOT = Path(__file__).resolve().parents[3]
EIGEN_EXAMPLE = REPO_ROOT / "examples/fem_periodic_antidot_relax_eigenmodes.py"
RESPONSE_EXAMPLE = (
    REPO_ROOT
    / "examples/fem_periodic_antidot_relax_exchange_coupled_frequency_driven.py"
)


class PeriodicAntidotEigenmodesExampleTests(unittest.TestCase):
    def load_example(self, environment: dict[str, str] | None = None):
        with mock.patch.dict(os.environ, environment or {}, clear=True):
            return fm.load_problem_from_script(EIGEN_EXAMPLE, lightweight_assets=True)

    @staticmethod
    def problem_ir(loaded):
        return loaded.problem.to_ir(
            requested_backend="fem",
            execution_mode="strict",
            execution_precision="double",
            script_source=loaded.script_source,
            source_root=loaded.source_path.parent,
            entrypoint_kind=loaded.entrypoint_kind,
            include_geometry_assets=False,
        )

    def export_run_config(self, environment: dict[str, str] | None = None):
        process_environment = os.environ.copy()
        for name in tuple(process_environment):
            if name.startswith("FULLMAG_PERIODIC_ANTIDOT_EIGEN_"):
                process_environment.pop(name)
        process_environment.update(environment or {})
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "fullmag.runtime.helper",
                "export-run-config",
                "--script",
                str(EIGEN_EXAMPLE),
                "--backend",
                "fem",
                "--mode",
                "strict",
                "--precision",
                "double",
                "--skip-geometry-assets",
            ],
            cwd=REPO_ROOT,
            env=process_environment,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_exchange_coupled_eigenmodes_scenario_relaxes_then_solves_k0_window(
        self,
    ) -> None:
        loaded = self.load_example(
            {
                "FULLMAG_PERIODIC_ANTIDOT_EIGEN_DEVICE": "cpu",
                "FULLMAG_PERIODIC_ANTIDOT_EIGEN_MODE_COUNT": "8",
                "FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMIN_GHZ": "0.5",
                "FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMAX_GHZ": "30.0",
                "FULLMAG_PERIODIC_ANTIDOT_EIGEN_SAVE_MODE_COUNT": "4",
            }
        )

        self.assertEqual(len(loaded.stages), 2)
        relax = loaded.stages[0].problem.study.to_ir()
        self.assertEqual(relax["kind"], "relaxation")
        self.assertEqual(relax["algorithm"], "nonlinear_cg")
        self.assertEqual(relax["stop"]["max_steps"], 16000)
        self.assertAlmostEqual(
            relax["stop"]["torque_tolerance_apm"],
            1.0e-6 / (4.0e-7 * math.pi),
            places=12,
        )

        eigen = loaded.stages[1].problem.study.to_ir()
        self.assertEqual(eigen["kind"], "eigenmodes")
        self.assertEqual(eigen["count"], 8)
        self.assertEqual(
            eigen["target"],
            {
                "kind": "frequency_window",
                "frequency_min_hz": 0.5e9,
                "frequency_max_hz": 30.0e9,
            },
        )
        self.assertEqual(
            eigen["operator"], {"kind": "full_2x2", "include_demag": True}
        )
        self.assertEqual(eigen["equilibrium"], {"kind": "relaxed_initial_state"})
        self.assertEqual(eigen["normalization"], "unit_l2")
        self.assertEqual(eigen["damping_policy"], "ignore")
        self.assertEqual(
            eigen["k_sampling"],
            {"kind": "single", "k_vector": [0.0, 0.0, 0.0]},
        )
        self.assertEqual(
            eigen["spin_wave_bc"],
            {"kind": "periodic", "pair_ids": ["x_faces", "y_faces"]},
        )
        self.assertEqual(eigen["magnetostatic_bc"], "periodic_airbox_k0")
        self.assertEqual(eigen["dynamics"]["fixed_timestep"], 1e-11)

        self.assertEqual(
            eigen["sampling"]["outputs"],
            [
                {
                    "kind": "eigen_spectrum",
                    "quantity": "eigenfrequency",
                    "scope": "per_sample",
                },
                {
                    "kind": "dispersion_curve",
                    "name": "dispersion",
                    "include_branch_table": True,
                },
                {"kind": "eigen_mode", "field": "mode", "indices": [0, 1, 2, 3]},
            ],
        )

        problem_ir = self.problem_ir(loaded)
        self.assertEqual(
            problem_ir["problem_meta"]["name"],
            "fem_periodic_antidot_relax_eigenmodes",
        )
        self.assertEqual(
            problem_ir["pbc"],
            {
                "axes": ["periodic", "periodic", "open"],
                "demag": "periodic_airbox_k0",
            },
        )
        geometry = problem_ir["geometry"]["entries"][0]
        self.assertEqual(geometry["kind"], "difference")
        self.assertEqual(geometry["base"]["size"], [200e-9, 200e-9, 10e-9])
        self.assertEqual(geometry["tool"]["kind"], "cylinder")
        self.assertEqual(geometry["tool"]["radius"], 25e-9)
        self.assertEqual(geometry["tool"]["height"], 10e-9)
        material = problem_ir["materials"][0]
        self.assertEqual(material["saturation_magnetisation"], 800e3)
        self.assertEqual(material["exchange_stiffness"], 13e-12)
        self.assertEqual(material["damping"], 0.02)
        self.assertEqual(
            problem_ir["energy_terms"],
            [
                {"kind": "exchange"},
                {"kind": "demag", "realization": "poisson_robin"},
                {"kind": "zeeman", "B": [10e-3, 0.0, 0.0]},
            ],
        )
        self.assertEqual(len(problem_ir["object_regions"]), 1)
        transition = problem_ir["object_regions"][0]
        self.assertEqual(transition["owner_object"], "periodic_antidot_film")
        self.assertEqual(transition["name"], "hole_transition_refinement")
        self.assertEqual(transition["realization_policy"], "conformal")
        self.assertEqual(transition["shape"]["radius"], 43e-9)
        self.assertEqual(
            transition["mesh_policy"],
            {
                "maximum_element_size": 20e-9,
                "minimum_element_size": 10e-9,
                "transition_distance": 20e-9,
                "order": 1,
            },
        )
        scenario = problem_ir["problem_meta"]["runtime_metadata"][
            "periodic_antidot_eigensolve"
        ]
        self.assertEqual(scenario["scenario"], "relax_then_eigenmodes_k0")
        self.assertEqual(scenario["periodic_pair_ids"], ["x_faces", "y_faces"])
        self.assertEqual(scenario["open_axis"], "z")
        self.assertEqual(scenario["mode_count"], 8)
        self.assertEqual(scenario["saved_mode_indices"], [0, 1, 2, 3])
        self.assertEqual(scenario["frequency_window_hz"], [0.5e9, 30.0e9])
        runtime_metadata = problem_ir["problem_meta"]["runtime_metadata"]
        self.assertEqual(
            runtime_metadata["study_universe"]["size"],
            [200e-9, 200e-9, 400e-9],
        )
        self.assertEqual(
            runtime_metadata["mesh_workflow"]["default_mesh"][
                "periodic_pair_ids"
            ],
            ["x_faces", "y_faces"],
        )

    def test_exchange_coupled_eigenmodes_gpu_adds_explicit_device_transition(
        self,
    ) -> None:
        loaded = self.load_example(
            {"FULLMAG_PERIODIC_ANTIDOT_EIGEN_DEVICE": "gpu"}
        )
        self.assertEqual(len(loaded.stages), 3)
        self.assertEqual(
            loaded.stages[0].problem.runtime.to_runtime_metadata(),
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
        self.assertEqual(loaded.stages[1].entrypoint_kind, "flat_change_device")
        self.assertEqual(
            loaded.stages[1].action,
            {"kind": "change_device", "device": "gpu"},
        )
        self.assertEqual(loaded.stages[2].problem.study.to_ir()["kind"], "eigenmodes")
        self.assertEqual(
            loaded.stages[2].problem.runtime_metadata[
                "periodic_antidot_eigensolve"
            ]["requested_modal_device"],
            "gpu",
        )

    def test_exchange_coupled_eigenmodes_supports_nearest_smoke_target(self) -> None:
        loaded = self.load_example(
            {
                "FULLMAG_PERIODIC_ANTIDOT_EIGEN_DEVICE": "cpu",
                "FULLMAG_PERIODIC_ANTIDOT_EIGEN_TARGET": "nearest",
                "FULLMAG_PERIODIC_ANTIDOT_EIGEN_TARGET_GHZ": "2.0",
                "FULLMAG_PERIODIC_ANTIDOT_EIGEN_MODE_COUNT": "1",
                "FULLMAG_PERIODIC_ANTIDOT_EIGEN_SAVE_MODE_COUNT": "1",
            }
        )
        eigen = loaded.stages[1].problem.study.to_ir()
        self.assertEqual(
            eigen["target"], {"kind": "nearest", "frequency_hz": 2.0e9}
        )
        scenario = loaded.stages[1].problem.runtime_metadata[
            "periodic_antidot_eigensolve"
        ]
        self.assertEqual(scenario["modal_target"], "nearest")
        self.assertEqual(scenario["target_frequency_hz"], 2.0e9)

    def test_canonical_ir_embeds_the_complete_cpu_study_pipeline(self) -> None:
        loaded = self.load_example()
        problem_ir = loaded.to_ir(
            requested_backend="fem",
            execution_mode="strict",
            execution_precision="double",
            include_geometry_assets=False,
        )
        pipeline = problem_ir["problem_meta"]["runtime_metadata"]["study_pipeline"]
        self.assertEqual(pipeline["version"], "study_pipeline.v1")
        self.assertEqual(
            [node["stage_kind"] for node in pipeline["nodes"]],
            ["relax", "eigenmodes"],
        )
        self.assertEqual(
            pipeline["nodes"][1]["payload"]["eigen_magnetostatic_bc"],
            "periodic_airbox_k0",
        )
        self.assertEqual(
            pipeline["nodes"][1]["payload"]["eigen_operator"],
            "full_2x2",
        )

    def test_public_run_config_propagates_strict_cpu_and_gpu_stage_devices(
        self,
    ) -> None:
        cpu = self.export_run_config()
        self.assertEqual(
            [stage["entrypoint_kind"] for stage in cpu["stages"]],
            ["flat_relax", "flat_eigenmodes"],
        )
        self.assertEqual(
            [
                stage["ir"]["problem_meta"]["runtime_metadata"][
                    "runtime_selection"
                ]["device"]
                for stage in cpu["stages"]
            ],
            ["cpu", "cpu"],
        )

        gpu = self.export_run_config(
            {"FULLMAG_PERIODIC_ANTIDOT_EIGEN_DEVICE": "gpu"}
        )
        self.assertEqual(
            [stage["entrypoint_kind"] for stage in gpu["stages"]],
            ["flat_relax", "flat_change_device", "flat_eigenmodes"],
        )
        self.assertEqual(
            gpu["stages"][1]["action"],
            {"kind": "change_device", "device": "gpu"},
        )
        selections = [
            stage["ir"]["problem_meta"]["runtime_metadata"]["runtime_selection"]
            for stage in gpu["stages"]
        ]
        self.assertEqual(
            [selection["device"] for selection in selections],
            ["cpu", "gpu", "gpu"],
        )
        for selection in selections:
            self.assertEqual(selection["execution_mode"], "strict")
            self.assertEqual(selection["execution_precision"], "double")

    def test_eigenmodes_and_frequency_response_examples_share_antidot_physics(
        self,
    ) -> None:
        eigen = self.load_example()
        with mock.patch.dict(
            os.environ,
            {"FULLMAG_PERIODIC_ANTIDOT_FREQUENCY_STAGE": "combined"},
            clear=True,
        ):
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                response = fm.load_problem_from_script(
                    RESPONSE_EXAMPLE,
                    lightweight_assets=True,
                )

        eigen_ir = self.problem_ir(eigen)
        response_ir = self.problem_ir(response)
        self.assertEqual(eigen_ir["geometry"], response_ir["geometry"])
        self.assertEqual(eigen_ir["materials"], response_ir["materials"])
        self.assertEqual(eigen_ir["pbc"], response_ir["pbc"])
        self.assertEqual(eigen_ir["energy_terms"], response_ir["energy_terms"])
        eigen_runtime = eigen_ir["problem_meta"]["runtime_metadata"]
        response_runtime = response_ir["problem_meta"]["runtime_metadata"]
        self.assertEqual(
            eigen_runtime["study_universe"],
            response_runtime["study_universe"],
        )
        self.assertEqual(
            eigen_runtime["mesh_workflow"]["per_geometry"],
            response_runtime["mesh_workflow"]["per_geometry"],
        )
        self.assertEqual(eigen_ir["object_regions"], response_ir["object_regions"])

    def test_eigenmodes_example_uses_current_fixed_timestep_api(self) -> None:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            loaded = self.load_example()

        deprecations = [
            str(item.message)
            for item in caught
            if issubclass(item.category, DeprecationWarning)
        ]
        self.assertEqual(deprecations, [])
        eigen = loaded.stages[-1].problem.study.to_ir()
        self.assertEqual(eigen["dynamics"]["fixed_timestep"], 1e-11)

    def test_relaxation_threshold_is_authored_by_the_script_user(self) -> None:
        loaded = self.load_example(
            {"FULLMAG_PERIODIC_ANTIDOT_RELAX_TOL_T": "2.5e-6"}
        )
        relax = loaded.stages[0].problem.study.to_ir()
        expected_apm = 2.5e-6 / (4.0e-7 * math.pi)
        self.assertAlmostEqual(
            relax["stop"]["torque_tolerance_apm"], expected_apm, places=12
        )
        scenario = self.problem_ir(loaded)["problem_meta"]["runtime_metadata"][
            "periodic_antidot_eigensolve"
        ]
        self.assertEqual(scenario["equilibrium_torque_tolerance_t"], 2.5e-6)

    def test_eigenmodes_example_rejects_invalid_environment(self) -> None:
        invalid_cases = [
            (
                {"FULLMAG_PERIODIC_ANTIDOT_EIGEN_DEVICE": "auto"},
                "must be 'cpu' or 'gpu'",
            ),
            (
                {"FULLMAG_PERIODIC_ANTIDOT_EIGEN_MODE_COUNT": "0"},
                "must be positive",
            ),
            (
                {"FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMIN_GHZ": "nan"},
                "must be finite",
            ),
            (
                {
                    "FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMIN_GHZ": "30",
                    "FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMAX_GHZ": "10",
                },
                "must be greater",
            ),
            (
                {
                    "FULLMAG_PERIODIC_ANTIDOT_EIGEN_MODE_COUNT": "2",
                    "FULLMAG_PERIODIC_ANTIDOT_EIGEN_SAVE_MODE_COUNT": "3",
                },
                "must not exceed",
            ),
            (
                {"FULLMAG_PERIODIC_ANTIDOT_RELAX_TOL_T": "0"},
                "must be positive",
            ),
        ]
        for environment, message in invalid_cases:
            with self.subTest(environment=environment):
                with mock.patch.dict(os.environ, environment, clear=True):
                    with self.assertRaisesRegex(ValueError, message):
                        fm.load_problem_from_script(
                            EIGEN_EXAMPLE,
                            lightweight_assets=True,
                        )
