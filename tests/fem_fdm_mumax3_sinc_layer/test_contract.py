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
FEM_FK_CPU_CASE = Path(__file__).with_name("fem_fk_cpu_case.py")
FEM_FK_GPU_CASE = Path(__file__).with_name("fem_fk_gpu_case.py")
MUMAX_CASE = Path(__file__).with_name("mumax3_case.mx3")
FDM_RELAX_CASE = Path(__file__).with_name("fdm_relax_case.py")
MUMAX_RELAX_CASE = Path(__file__).with_name("mumax3_relax_case.mx3")
FDM_CUDA_CONTEXT = REPO_ROOT / "backends" / "fdm" / "gpu" / "cuda" / "runtime" / "context.cu"
TABLE_QUANTITIES = [
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
]


class SincLayerContractTests(unittest.TestCase):
    def _load_ir(
        self,
        backend: str,
        *,
        demag: str | None = None,
        fem_device: str | None = None,
    ) -> dict[str, object]:
        previous_backend = os.environ.get("FULLMAG_SINC_LAYER_BACKEND")
        previous_demag = os.environ.get("FULLMAG_SINC_LAYER_DEMAG")
        previous_fem_device = os.environ.get("FULLMAG_FEM_EXECUTION")
        os.environ["FULLMAG_SINC_LAYER_BACKEND"] = backend
        if demag is None:
            os.environ.pop("FULLMAG_SINC_LAYER_DEMAG", None)
        else:
            os.environ["FULLMAG_SINC_LAYER_DEMAG"] = demag
        if fem_device is not None:
            os.environ["FULLMAG_FEM_EXECUTION"] = fem_device
        try:
            loaded = fm.load_problem_from_script(CASE, lightweight_assets=True)
            return loaded.to_ir(
                requested_backend=BackendTarget(backend),
                execution_mode=ExecutionMode.STRICT,
                execution_precision=ExecutionPrecision.DOUBLE,
                include_geometry_assets=False,
            )
        finally:
            if previous_backend is None:
                os.environ.pop("FULLMAG_SINC_LAYER_BACKEND", None)
            else:
                os.environ["FULLMAG_SINC_LAYER_BACKEND"] = previous_backend
            if previous_demag is None:
                os.environ.pop("FULLMAG_SINC_LAYER_DEMAG", None)
            else:
                os.environ["FULLMAG_SINC_LAYER_DEMAG"] = previous_demag
            if previous_fem_device is None:
                os.environ.pop("FULLMAG_FEM_EXECUTION", None)
            else:
                os.environ["FULLMAG_FEM_EXECUTION"] = previous_fem_device
            fm.reset()

    def test_case_sources_exist(self) -> None:
        self.assertTrue(CASE.is_file())
        self.assertTrue(FDM_CASE.is_file())
        self.assertTrue(FDM_GPU_CASE.is_file())
        self.assertTrue(FEM_CASE.is_file())
        self.assertTrue(FEM_CPU_CASE.is_file())
        self.assertTrue(FEM_GPU_CASE.is_file())
        self.assertTrue(FEM_FK_CPU_CASE.is_file())
        self.assertTrue(FEM_FK_GPU_CASE.is_file())
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
                self.assertEqual(ir["study"]["dynamics"]["fixed_timestep"], 5e-14)
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

    def test_common_pipeline_relaxes_saves_state_then_runs_four_ns(self) -> None:
        for backend in ("fdm", "fem"):
            with self.subTest(backend=backend):
                ir = self._load_ir(backend)
                pipeline = ir["problem_meta"]["runtime_metadata"]["study_pipeline"]
                self.assertEqual(
                    [node["stage_kind"] for node in pipeline["nodes"]],
                    ["relax", "save_state", "table_autosave", "run"],
                )
                relax = next(node for node in pipeline["nodes"] if node["stage_kind"] == "relax")
                relax_payload = relax["payload"]
                self.assertEqual(relax_payload["relax_algorithm"], "llg_overdamped")
                self.assertEqual(relax_payload["integrator"], "heun")
                self.assertEqual(relax_payload["fixed_timestep"], "5e-14")
                self.assertAlmostEqual(
                    float(relax_payload["torque_tolerance"]),
                    1e-5 / (4.0 * 3.141592653589793e-7),
                    places=10,
                )
                self.assertEqual(relax_payload["max_steps"], "50000")
                self.assertEqual(
                    relax_payload["table_autosave"],
                    {
                        "kind": "table_autosave",
                        "table_id": "relaxation",
                        "every_steps": 1,
                        "quantities": list(TABLE_QUANTITIES),
                    },
                )
                save_state = next(
                    node for node in pipeline["nodes"] if node["stage_kind"] == "save_state"
                )
                self.assertEqual(save_state["payload"]["artifact_name"], "relaxed_state")
                self.assertEqual(save_state["payload"]["format"], "json")
                dynamic_table = next(
                    node for node in pipeline["nodes"] if node["stage_kind"] == "table_autosave"
                )
                self.assertEqual(
                    dynamic_table["payload"]["table_autosave"]["quantities"],
                    list(TABLE_QUANTITIES),
                )
                run = next(node for node in pipeline["nodes"] if node["stage_kind"] == "run")
                self.assertEqual(run["payload"]["until_seconds"], "4e-09")
                metadata = ir["problem_meta"]["runtime_metadata"]["fdm_fem_mumax3_sinc_layer"]
                self.assertEqual(
                    metadata["dynamic_initial_state"],
                    "relaxed_state_after_llg_overdamped",
                )
                self.assertEqual(
                    metadata["relaxation_policy"],
                    "same_script_pre_dynamic_llg_overdamped",
                )
                self.assertEqual(
                    metadata["relaxation"],
                    {
                        "algorithm": "llg_overdamped",
                        "solver": "heun",
                        "fixed_timestep_s": 5e-14,
                        "torque_tolerance_T": 1e-5,
                        "max_steps": 50000,
                        "state_artifact": "relaxed_state",
                        "field_drive_active": False,
                    },
                )
                self.assertEqual(metadata["dynamic_steps"], 80_000)
                self.assertEqual(metadata["dynamic_timestep_s"], 5e-14)

    def test_relaxation_and_dynamic_stage_contract_is_backend_invariant(self) -> None:
        signatures = []
        for backend in ("fdm", "fem"):
            ir = self._load_ir(backend)
            nodes = ir["problem_meta"]["runtime_metadata"]["study_pipeline"]["nodes"]
            signatures.append([
                (
                    node["stage_kind"],
                    node["payload"].get("relax_algorithm"),
                    node["payload"].get("integrator"),
                    node["payload"].get("fixed_timestep"),
                    node["payload"].get("max_steps"),
                    node["payload"].get("until_seconds"),
                    node["payload"].get("table_autosave"),
                    node["payload"].get("artifact_name"),
                    node["payload"].get("format"),
                )
                for node in nodes
            ])
        self.assertEqual(signatures[0], signatures[1])

    def test_fem_poisson_robin_uses_original_single_prism_layer_contract(self) -> None:
        ir = self._load_ir("fem", demag="poisson_robin")
        mesh_workflow = ir["problem_meta"]["runtime_metadata"]["mesh_workflow"]
        recipe = mesh_workflow["per_geometry"][0]
        self.assertEqual(recipe["mesh_strategy"], "swept_prism")
        self.assertEqual(recipe["topology"], "prismatic")
        self.assertEqual(recipe["element_family"], "prism")
        self.assertEqual(recipe["transition_policy"], "pyramid_to_tetrahedra")
        self.assertEqual(recipe["through_thickness_elements"], 1)
        self.assertEqual(recipe["through_thickness_distribution"], "fixed")
        self.assertEqual(recipe["sweep_face_meshing"], "triangular")
        self.assertEqual(recipe["sweep_direction"], "auto")
        self.assertTrue(recipe["exact_layer_count"])
        self.assertEqual(recipe["order"], 1)
        self.assertEqual(ir["energy_terms"][1]["realization"], "poisson_robin")

    def test_fem_fredkin_koehler_is_body_only_and_changes_only_mesh_and_demag(self) -> None:
        poisson = self._load_ir("fem", demag="poisson_robin")
        fredkin = self._load_ir("fem", demag="fredkin_koehler", fem_device="cpu")
        poisson_mesh = poisson["problem_meta"]["runtime_metadata"]["mesh_workflow"]
        fredkin_mesh = fredkin["problem_meta"]["runtime_metadata"]["mesh_workflow"]
        fredkin_recipe = fredkin_mesh["per_geometry"][0]
        self.assertEqual(fredkin_mesh["build_target"], "mesh")
        self.assertNotIn("domain_mesh_mode", fredkin_mesh)
        self.assertEqual(fredkin_recipe["mesh_strategy"], "free_tetrahedral")
        self.assertEqual(fredkin_recipe["order"], 1)
        self.assertEqual(fredkin["energy_terms"][1]["realization"], "fredkin_koehler")
        self.assertEqual(fredkin["geometry"], poisson["geometry"])
        self.assertEqual(fredkin["materials"], poisson["materials"])
        self.assertEqual(fredkin["field_drives"], poisson["field_drives"])
        self.assertEqual(fredkin["study"], poisson["study"])
        self.assertEqual(
            fredkin["problem_meta"]["runtime_metadata"]["study_pipeline"],
            poisson["problem_meta"]["runtime_metadata"]["study_pipeline"],
        )

    def test_fem_fredkin_gpu_wrapper_keeps_gpu_request_explicit(self) -> None:
        source = FEM_FK_GPU_CASE.read_text(encoding="utf-8")
        self.assertIn('FULLMAG_SINC_LAYER_DEMAG"] = "fredkin_koehler"', source)
        self.assertIn('FULLMAG_FEM_EXECUTION"] = "gpu"', source)
        self.assertNotIn('FULLMAG_FEM_EXECUTION"] = "cpu"', source)

    def test_fem_fredkin_gpu_projects_each_far_block_once(self) -> None:
        source = (
            REPO_ROOT
            / "backends"
            / "fem"
            / "gpu"
            / "cuda"
            / "demag_fem_bem"
            / "fem_bem_kernels.cu"
        ).read_text(encoding="utf-8")
        far_kernel = source.index("__global__ void fem_bem_far_apply_kernel")
        self.assertIn("extern __shared__ double projected[]", source[far_kernel:])
        self.assertIn("atomicAdd(u2_boundary + boundary_row, value)", source[far_kernel:])
        self.assertNotIn("far_v[", source[:far_kernel])

    def test_fem_fredkin_operator_provenance_uses_canonical_sha256(self) -> None:
        cpu_source = (
            REPO_ROOT
            / "backends"
            / "fem"
            / "cpu"
            / "mfem"
            / "interactions"
            / "demag_fem_bem_operator.cpp"
        ).read_text(encoding="utf-8")
        gpu_source = (
            REPO_ROOT
            / "backends"
            / "fem"
            / "gpu"
            / "cuda"
            / "demag_fem_bem"
            / "fem_bem.cpp"
        ).read_text(encoding="utf-8")
        self.assertIn("CanonicalDigestBuilder", cpu_source)
        self.assertIn('impl_->fingerprint = "sha256:" + digest.sha256_hex();', cpu_source)
        self.assertIn("CanonicalDigestBuilder", gpu_source)
        self.assertIn('workspace->operator_fingerprint = "sha256:" + digest.sha256_hex();', gpu_source)
        self.assertNotIn('"hierarchical_h2-" + std::to_string', cpu_source)

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
        self.assertIn("MinimizerStop = 1e-5", source)
        self.assertIn("MinimizeMaxSteps = 50000", source)
        self.assertIn("minimize()", source)
        self.assertIn("B_ext = vector(100e-3, 0, 0)", source)
        self.assertNotIn("FixDt = 8e-13", source)
        self.assertIn("tableautosave(1/(2*1.3*fcut))", source)
        self.assertNotRegex(source, r"(?im)^\s*(save|autosave)\s*\(\s*m\b")

    def test_mumax_dynamic_table_starts_after_relaxation(self) -> None:
        source = MUMAX_CASE.read_text(encoding="utf-8")
        self.assertEqual(source.count("tableSave()"), 1)
        self.assertLess(source.index("minimize()"), source.index("tableSave()"))

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
