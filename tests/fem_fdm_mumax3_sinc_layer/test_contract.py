from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
PYTHON_PACKAGE = REPO_ROOT / "packages" / "fullmag-py" / "src"
if str(PYTHON_PACKAGE) not in sys.path:
    sys.path.insert(0, str(PYTHON_PACKAGE))

import fullmag as fm
from fullmag.model import BackendTarget, ExecutionMode, ExecutionPrecision


CASE = Path(__file__).with_name("fullmag_case.py")
FDM_CASE = Path(__file__).with_name("fdm_case.py")
FDM_GPU_CASE = Path(__file__).with_name("fdm_gpu_case.py")
FEM_CASE = Path(__file__).with_name("fem_case.py")
FEM_CPU_CASE = Path(__file__).with_name("fem_cpu_case.py")
FEM_GPU_CASE = Path(__file__).with_name("fem_gpu_case.py")
MUMAX_CASE = Path(__file__).with_name("mumax3_case.mx3")
FDM_RELAX_CASE = Path(__file__).with_name("fdm_relax_case.py")
MUMAX_RELAX_CASE = Path(__file__).with_name("mumax3_relax_case.mx3")
FDM_CUDA_CONTEXT = REPO_ROOT / "backends" / "fdm" / "gpu" / "cuda" / "runtime" / "context.cu"


class SincLayerContractTests(unittest.TestCase):
    def _load_ir(self, backend: str) -> dict[str, object]:
        previous = os.environ.get("FULLMAG_SINC_LAYER_BACKEND")
        os.environ["FULLMAG_SINC_LAYER_BACKEND"] = backend
        try:
            loaded = fm.load_problem_from_script(CASE, lightweight_assets=True)
            return loaded.to_ir(
                requested_backend=BackendTarget(backend),
                execution_mode=ExecutionMode.STRICT,
                execution_precision=ExecutionPrecision.DOUBLE,
                include_geometry_assets=False,
            )
        finally:
            if previous is None:
                os.environ.pop("FULLMAG_SINC_LAYER_BACKEND", None)
            else:
                os.environ["FULLMAG_SINC_LAYER_BACKEND"] = previous
            fm.reset()

    def test_case_sources_exist(self) -> None:
        self.assertTrue(CASE.is_file())
        self.assertTrue(FDM_CASE.is_file())
        self.assertTrue(FDM_GPU_CASE.is_file())
        self.assertTrue(FEM_CASE.is_file())
        self.assertTrue(FEM_CPU_CASE.is_file())
        self.assertTrue(FEM_GPU_CASE.is_file())
        self.assertTrue(MUMAX_CASE.is_file())
        self.assertTrue(FDM_RELAX_CASE.is_file())
        self.assertTrue(MUMAX_RELAX_CASE.is_file())

    def test_shared_fullmag_contract_is_exact_for_fdm_and_fem(self) -> None:
        for backend in ("fdm", "fem"):
            with self.subTest(backend=backend):
                ir = self._load_ir(backend)
                self.assertEqual(ir["geometry"]["entries"][0]["size"], [500e-9, 500e-9, 10e-9])
                self.assertEqual(
                    ir["magnets"][0]["initial_magnetization"]["preset_params"]["direction"],
                    [1.0, 0.0, 0.0],
                )
                self.assertEqual(ir["materials"][0]["saturation_magnetisation"], 800e3)
                self.assertEqual(ir["materials"][0]["exchange_stiffness"], 13e-12)
                self.assertEqual(ir["materials"][0]["damping"], 0.01)
                self.assertEqual(ir["study"]["dynamics"]["integrator"], "rk45")
                self.assertEqual(ir["study"]["dynamics"]["gyromagnetic_ratio"], 2.211e5)
                self.assertEqual(ir["study"]["dynamics"]["adaptive_timestep"]["atol"], 1e-7)
                self.assertEqual(ir["study"]["dynamics"]["adaptive_timestep"]["dt_initial"], 1e-12)
                self.assertEqual(ir["field_drives"][0]["target"], {"kind": "global"})
                self.assertEqual(ir["field_drives"][0]["direction"], [0.0, 1.0, 0.0])
                self.assertEqual(ir["field_drives"][0]["amplitude_B_T"], 1e-3)
                self.assertEqual(ir["field_drives"][0]["waveform"]["cutoff_hz"], 10e9)
                self.assertEqual(ir["field_drives"][0]["waveform"]["t0"], 2e-9)
                self.assertEqual(ir["field_drives"][0]["activation"]["stage_ids"], ["dynamic"])
                self.assertEqual(ir["energy_terms"][-1], {"kind": "zeeman", "B": [0.1, 0.0, 0.0]})
                self.assertNotIn("pbc", ir)
                pipeline = ir["problem_meta"]["runtime_metadata"]["study_pipeline"]
                table_node = next(
                    node for node in pipeline["nodes"] if node["stage_kind"] == "table_autosave"
                )
                table = table_node["payload"]["table_autosave"]
                self.assertEqual(table["sample_period_policy"], {
                    "kind": "auto_sinc_cutoff",
                    "nyquist_guard_factor": 1.3,
                })
                self.assertEqual(table["quantities"], [
                    "step",
                    "t",
                    "mx",
                    "my",
                    "mz",
                    "e_ex",
                    "e_demag",
                    "e_ext",
                    "e_drive",
                    "e_ani",
                    "e_dmi",
                    "e_total",
                ])
                self.assertEqual(
                    next(node for node in pipeline["nodes"] if node["id"] == "dynamic")["payload"]["until_seconds"],
                    "4e-09",
                )
                self.assertFalse(any(output.get("kind") == "field" for output in ir["study"].get("outputs", [])))
                self.assertEqual(
                    ir["backend_policy"]["discretization_hints"]["fdm"]["cell"]
                    if backend == "fdm"
                    else ir["backend_policy"]["discretization_hints"]["fem"]["hmax"],
                    [2.5e-9, 2.5e-9, 10e-9] if backend == "fdm" else 2.5e-9,
                )

    def test_dynamic_benchmark_starts_from_same_declared_uniform_state(self) -> None:
        for backend in ("fdm", "fem"):
            with self.subTest(backend=backend):
                ir = self._load_ir(backend)
                pipeline = ir["problem_meta"]["runtime_metadata"]["study_pipeline"]
                dynamic_stage_kinds = [
                    node["stage_kind"]
                    for node in pipeline["nodes"]
                    if node["stage_kind"] in {"relax", "run"}
                ]
                self.assertEqual(dynamic_stage_kinds, ["run"])
                metadata = ir["problem_meta"]["runtime_metadata"]["fdm_fem_mumax3_sinc_layer"]
                self.assertEqual(metadata["dynamic_initial_state"], "uniform_declared_m0")
                self.assertEqual(metadata["relaxation_policy"], "excluded_from_dynamic_benchmark")

    def test_fem_is_strict_single_layer_prismatic_mesh(self) -> None:
        ir = self._load_ir("fem")
        mesh_workflow = ir["problem_meta"]["runtime_metadata"]["mesh_workflow"]
        recipe = mesh_workflow["per_geometry"][0]
        self.assertEqual(recipe["mesh_strategy"], "swept_prism")
        self.assertEqual(recipe["topology"], "prismatic")
        self.assertEqual(recipe["element_family"], "prism")
        self.assertEqual(recipe["sweep_direction"], "auto")
        self.assertEqual(recipe["through_thickness_elements"], 1)
        self.assertEqual(recipe["through_thickness_distribution"], "fixed")
        self.assertEqual(recipe["transition_policy"], "pyramid_to_tetrahedra")
        self.assertTrue(recipe["exact_layer_count"])
        self.assertEqual(recipe["order"], 1)
        for key in (
            "interface_hmax",
            "interface_thickness",
            "transition_distance",
            "edge_hmax",
            "edge_thickness",
            "edge_transition_distance",
            "corner_hmax",
            "corner_extent",
            "corner_transition_distance",
        ):
            self.assertNotIn(key, recipe)

    def test_fem_launcher_environment_selects_fem_without_private_selector(self) -> None:
        previous_backend = os.environ.pop("FULLMAG_SINC_LAYER_BACKEND", None)
        previous_fem_execution = os.environ.get("FULLMAG_FEM_EXECUTION")
        os.environ["FULLMAG_FEM_EXECUTION"] = "gpu"
        try:
            loaded = fm.load_problem_from_script(CASE, lightweight_assets=True)
            ir = loaded.to_ir(
                requested_backend=BackendTarget("fem"),
                execution_mode=ExecutionMode.STRICT,
                execution_precision=ExecutionPrecision.DOUBLE,
                include_geometry_assets=False,
            )
            self.assertEqual(
                ir["problem_meta"]["runtime_metadata"]["fdm_fem_mumax3_sinc_layer"]["backend"],
                "fem",
            )
        finally:
            fm.reset()
            if previous_backend is not None:
                os.environ["FULLMAG_SINC_LAYER_BACKEND"] = previous_backend
            if previous_fem_execution is None:
                os.environ.pop("FULLMAG_FEM_EXECUTION", None)
            else:
                os.environ["FULLMAG_FEM_EXECUTION"] = previous_fem_execution

    def test_fdm_launcher_environment_selects_fdm_without_private_selector(self) -> None:
        previous_backend = os.environ.pop("FULLMAG_SINC_LAYER_BACKEND", None)
        previous_fdm_execution = os.environ.get("FULLMAG_FDM_EXECUTION")
        os.environ["FULLMAG_FDM_EXECUTION"] = "cpu"
        try:
            loaded = fm.load_problem_from_script(CASE, lightweight_assets=True)
            ir = loaded.to_ir(
                requested_backend=BackendTarget("fdm"),
                execution_mode=ExecutionMode.STRICT,
                execution_precision=ExecutionPrecision.DOUBLE,
                include_geometry_assets=False,
            )
            self.assertEqual(
                ir["problem_meta"]["runtime_metadata"]["fdm_fem_mumax3_sinc_layer"]["backend"],
                "fdm",
            )
        finally:
            fm.reset()
            if previous_backend is not None:
                os.environ["FULLMAG_SINC_LAYER_BACKEND"] = previous_backend
            if previous_fdm_execution is None:
                os.environ.pop("FULLMAG_FDM_EXECUTION", None)
            else:
                os.environ["FULLMAG_FDM_EXECUTION"] = previous_fdm_execution

    def test_fdm_gpu_launcher_environment_selects_cuda_runtime(self) -> None:
        previous_backend = os.environ.get("FULLMAG_SINC_LAYER_BACKEND")
        previous_fdm_execution = os.environ.get("FULLMAG_FDM_EXECUTION")
        os.environ["FULLMAG_SINC_LAYER_BACKEND"] = "fdm"
        os.environ["FULLMAG_FDM_EXECUTION"] = "cuda"
        try:
            loaded = fm.load_problem_from_script(CASE, lightweight_assets=True)
            ir = loaded.to_ir(
                requested_backend=BackendTarget("fdm"),
                execution_mode=ExecutionMode.STRICT,
                execution_precision=ExecutionPrecision.DOUBLE,
                include_geometry_assets=False,
            )
            runtime = ir["problem_meta"]["runtime_metadata"]["runtime_selection"]
            self.assertEqual(runtime["device"], "cuda")
            self.assertEqual(runtime["device_index"], 0)
        finally:
            fm.reset()
            if previous_backend is None:
                os.environ.pop("FULLMAG_SINC_LAYER_BACKEND", None)
            else:
                os.environ["FULLMAG_SINC_LAYER_BACKEND"] = previous_backend
            if previous_fdm_execution is None:
                os.environ.pop("FULLMAG_FDM_EXECUTION", None)
            else:
                os.environ["FULLMAG_FDM_EXECUTION"] = previous_fdm_execution

    def test_fdm_cuda_upload_preserves_regional_drive_waveform(self) -> None:
        source = FDM_CUDA_CONTEXT.read_text(encoding="utf-8")
        self.assertIn(
            "resolved.waveform = static_cast<int>(descriptor.waveform);",
            source,
        )

    def test_mumax_source_has_scalar_only_output_contract(self) -> None:
        source = MUMAX_CASE.read_text(encoding="utf-8")
        self.assertIn("SetGridSize(200, 200, 1)", source)
        self.assertIn("SetCellSize(2.5e-9, 2.5e-9, 10e-9)", source)
        self.assertIn("SetPBC(0, 0, 0)", source)
        self.assertIn("DemagAccuracy = 29", source)
        self.assertIn("sinc(2*pi*fcut*(t-t0))", source)
        self.assertIn("GammaLL = 2.211e5/(4*pi*1e-7)", source)
        self.assertIn("SetSolver(5)", source)
        self.assertIn("MaxDt = 2e-12", source)
        self.assertIn("MinDt = 1e-15", source)
        self.assertIn("tableautosave(1/(2*1.3*fcut))", source)
        self.assertNotRegex(source, r"(?im)^\s*relax\s*\(")
        self.assertNotRegex(source, r"(?im)^\s*(save|autosave)\s*\(\s*m\b")

    def test_relaxation_sources_use_static_bias_and_scalar_only_output(self) -> None:
        fdm_source = FDM_RELAX_CASE.read_text(encoding="utf-8")
        mumax_source = MUMAX_RELAX_CASE.read_text(encoding="utf-8")
        self.assertIn('algorithm="nonlinear_cg"', fdm_source)
        self.assertIn("tolT=1e-6", fdm_source)
        self.assertIn("every_steps=100", fdm_source)
        self.assertIn("B_EXT_T = (100e-3, 0.0, 0.0)", fdm_source)
        self.assertIn("DemagAccuracy = 29", mumax_source)
        self.assertIn("MinimizerStop = 1e-6", mumax_source)
        self.assertIn("MinimizeMaxSteps = 50000", mumax_source)
        self.assertIn("minimize()", mumax_source)
        self.assertNotIn("sinc(", mumax_source)
        self.assertNotRegex(mumax_source, r"(?im)^\s*(save|autosave)\s*\(\s*m\b")


if __name__ == "__main__":
    unittest.main()
