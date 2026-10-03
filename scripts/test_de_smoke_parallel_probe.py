"""Interpreted regressions for the closed serial/adaptive probe."""
from __future__ import annotations

import json
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
PYTHON_SOURCE_DIR = SCRIPT_DIR.parent / "packages" / "fullmag-py" / "src"
if str(PYTHON_SOURCE_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_SOURCE_DIR))

import run_de_100nm_pilot as pilot  # noqa: E402
import fullmag as fm  # noqa: E402
from validate_de_smoke_rows import (  # noqa: E402
    PARALLEL_PROBE_FREQUENCY_WINDOW_HZ,
    PARALLEL_PROBE_VECTORS_RAD_PER_M,
    SAMPLING,
    validate_parallel_probe_metadata,
    validate_parallel_probe_solver_artifacts,
    validate_rows,
)


def _public_model_source(mode):
    return f'''import fullmag as fm

study = fm.study("de-smoke-parallel-probe")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.parallel_execution(
    mode={mode!r}, max_cpu_percent=90.0, max_memory_percent=80.0,
    memory_reserve_bytes=1024**3, max_workers=2, threads_per_worker=1,
)
study.universe(mode="manual", size=(40e-9, 40e-9, 4.01e-6),
               center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
body = study.geometry(fm.Box(size=(40e-9, 40e-9, 10e-9), name="film"), name="film")
body.Ms = 800000.0
body.Aex = 13e-12
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.demag(model="airbox", variant="dirichlet")
study.solver(gamma=221100.0, fix_dt=5e-15)
study.runtime_metadata("de_smoke", {{
    "schema": "fullmag.de-smoke.v1",
    "sampling": "parallel-probe",
    "orientation": "M0=x,k=y,normal=z",
    "k_vectors_rad_per_m": [[0.0, -10000000.0, 0.0],
                             [0.0, 10000000.0, 0.0],
                             [0.0, -10000000.0, 0.0]],
    "dispersion_geometry": "damon_eshbach",
    "modal_target": "frequency_window",
    "selection_scope": "frequency_window",
    "frequency_window_hz": [10500000000.0, 11500000000.0],
    "requested_mode_count": 1,
    "mesh_level": "L2",
    "through_thickness_elements": 3,
    "outer_boundary_kind": "poisson_dirichlet",
}})
study.stages.add_eigenmodes(
    count=1, target="frequency_window", frequency_min=10.5e9,
    frequency_max=11.5e9, operator="full_2x2", include_demag=True,
    equilibrium_source="artifact",
    equilibrium_artifact="/workspace/benchmark-input/equilibrium_artifact.v7.json",
    magnetostatic_bc="floquet_airbox", k_vector=(0.0, 10000000.0, 0.0),
    bc=fm.FloquetBC(["x_faces", "y_faces"],
                    phase_convention="exp_minus_i_k_dot_delta_r"),
)
'''


def _metadata(mode="serial"):
    source = _public_model_source(mode)
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "model-input.py"
        path.write_text(source, encoding="utf-8")
        loaded = fm.load_problem_from_script(path, lightweight_assets=True)
        ir = loaded.stages[-1].problem.to_ir(
            script_source=source,
            source_root=path.parent,
            include_geometry_assets=False,
            entrypoint_kind=loaded.entrypoint_kind,
        )
    source_hash = hashlib.sha256(source.encode("utf-8")).hexdigest()
    assert ir["problem_meta"]["source_hash"] == source_hash
    return {"source_hash": source_hash, "problem_meta": ir["problem_meta"]}, source_hash


def _write_native_probe_artifacts(case):
    phase_hash = "sha256:" + "a" * 64

    def mode(sample_index):
        block = {
            "certified": True,
            "certification_tolerance": 1e-8,
            "eps_full": 2e-10,
            "eps_phi": 2e-14,
            "eps_q": 3e-14,
            "floquet_cartesian_magnetic_seam_relative_residual": 1e-14,
            "floquet_equilibrium_pair_relative_residual": 0.0,
            "floquet_full_magnetic_relative_residual": 2e-10,
            "floquet_full_potential_relative_residual": 3e-14,
            "floquet_gauge_policy_satisfied": True,
            "floquet_scalar_phase_seam_relative_residual": 0.0,
            "floquet_seam_frame_certified": True,
            "floquet_tangent_frame_seam_relative_residual": 0.0,
        }
        return {
            "sample_index": sample_index,
            "raw_mode_index": 0,
            "frequency_hz": 11.2e9,
            "residual_relative_l2": 2e-10,
            "phase_constraint_sha256": phase_hash if sample_index != 1 else "sha256:" + "b" * 64,
            "floquet_descriptor_certified": True,
            "floquet_full_descriptor_certified": True,
            "floquet_gauge_policy_satisfied": True,
            "floquet_seam_frame_certified": True,
            "block_residuals": block,
        }

    samples = []
    sample_diagnostics = []
    for index, vector in enumerate(PARALLEL_PROBE_VECTORS_RAD_PER_M):
        samples.append({
            "sample_index": index,
            "k_vector": list(vector),
            "modes": [mode(index)],
        })
        sample_diagnostics.append({
            "sample_index": index,
            "diagnostics": {
                "accepted_mode_count": 1,
                "accepted_mode_count_after_dedup": 1,
                "modal_solver_policy": {"requested_residual_tolerance": 1e-8},
                "ksp_rtol": 1e-11,
                "ksp_restart": 8,
                "subwindows": [{
                    "stop_reason": "converged",
                    "eps_normalized_absolute_tolerance": 1e-11,
                    "eps_normalized_absolute_residual_max": 1e-15,
                    "residual_max": 2e-10,
                    "ksp_final_residual": 1e-24,
                    "ksp_max_true_relative_residual": 2e-9,
                    "ksp_diagnostics_available": True,
                    "ksp_last_true_residual_available": True,
                    "ksp_true_residual_measurement_failure_count": 0,
                    "ksp_converged_reason": 2,
                    "eps_converged_reason": 1,
                    "eps_convergence_test": "absolute_true_residual",
                }],
            },
        })
    (case / "eigen/diagnostics").mkdir(parents=True)
    (case / "eigen/metadata").mkdir(parents=True)
    (case / "eigen/diagnostics/solver.v1.json").write_text(json.dumps({
        "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
        "sample_solver_diagnostics": sample_diagnostics,
    }), encoding="utf-8")
    summary = {
        "study_kind": "eigenmodes",
        "spin_wave_bc": "floquet",
        "boundary_config": {
            "kind": "floquet",
            "phase_convention": "exp_minus_i_k_dot_delta_r",
        },
        "modes": [mode(0)],
    }
    (case / "eigen/metadata/eigen_summary.json").write_text(
        json.dumps(summary), encoding="utf-8"
    )
    (case / "eigen/spectrum.v3.json").write_text(json.dumps({
        "schema_version": "eigen_spectrum.v3",
        "phase_convention": "exp_minus_i_k_dot_delta_r",
        "sample_count": 3,
        "samples": samples,
    }), encoding="utf-8")


class ParallelProbeTests(unittest.TestCase):
    def test_probe_accepts_new_verified_capsule_instead_of_old_job_number(self):
        from types import SimpleNamespace
        paths = [
            "crates/fullmag-ir/src/parallel_execution.rs",
            "crates/fullmag-runner/src/adaptive_resources.rs",
            "crates/fullmag-runner/src/adaptive_resources_linux.rs",
            "crates/fullmag-runner/src/eigen/k_process_pool.rs",
            "crates/fullmag-runner/src/fem/eigen_k_pool.rs",
            "crates/fullmag-runner/src/fem/eigen_k_worker.rs",
        ]
        context = SimpleNamespace(
            job={"job_id": "new-job", "source_digest": "a" * 64,
                 "profile": pilot.managed.CPU_ABI_RUNTIME_PROFILE},
            manifest={"files": [{"path": path} for path in paths]},
        )
        pilot._validate_parallel_probe_build(context, "a" * 64)
        with self.assertRaisesRegex(pilot.managed.BenchmarkError, "differs"):
            pilot._validate_parallel_probe_build(context, "b" * 64)
        for value in (None, True, "a" * 63, "A" * 64, "a" * 64 + "\n"):
            with self.subTest(value=value), self.assertRaises(pilot.managed.BenchmarkError):
                pilot._validate_parallel_probe_build(context, value)
        context.job["profile"] = pilot.managed.PROFILE
        with self.assertRaisesRegex(pilot.managed.BenchmarkError, "runtime-v2"):
            pilot._validate_parallel_probe_build(context, "a" * 64)
        context.job["profile"] = pilot.managed.CPU_ABI_RUNTIME_PROFILE
        context.manifest["files"].pop()
        with self.assertRaisesRegex(pilot.managed.BenchmarkError, "lacks adaptive"):
            pilot._validate_parallel_probe_build(context, "a" * 64)

    def test_probe_rejects_redirected_ancestor_before_reading_input(self):
        with tempfile.TemporaryDirectory() as directory:
            storage = Path(directory) / "storage"
            storage.mkdir()
            canonical = storage.joinpath(*pilot.PARALLEL_PROBE_INPUT_RELATIVE_ROOT.split("/"))
            outside = Path(directory) / "outside" / "campaign"
            original_resolve = Path.resolve
            def redirected_resolve(path, *args, **kwargs):
                if path == canonical:
                    return outside
                return original_resolve(path, *args, **kwargs)
            with patch.object(Path, "resolve", redirected_resolve):
                with self.assertRaisesRegex(pilot.managed.BenchmarkError, "traverses a link"):
                    pilot._parallel_probe_root({"storage_root": storage}, None)

    def test_solver_artifact_validation_has_the_runtime_vector_binding(self):
        self.assertEqual(pilot.PARALLEL_PROBE_VECTORS_RAD_PER_M, PARALLEL_PROBE_VECTORS_RAD_PER_M)

    def test_sampling_and_window_are_pinned(self):
        self.assertEqual(SAMPLING["parallel-probe"], (-10e6, 10e6, -10e6))
        self.assertEqual(PARALLEL_PROBE_FREQUENCY_WINDOW_HZ, (10.5e9, 11.5e9))

    def test_metadata_guard_accepts_both_policy_modes(self):
        for mode in ("serial", "adaptive"):
            with self.subTest(mode=mode):
                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "metadata.json"
                    metadata, source_hash = _metadata(mode)
                    path.write_text(json.dumps(metadata), encoding="utf-8")
                    result = validate_parallel_probe_metadata(
                        path,
                        model_sha256=source_hash,
                        parallel_mode=mode,
                    )
                    self.assertEqual(result["status"], "pass")
                    self.assertEqual(result["source_hash"], source_hash)

    def test_metadata_guard_rejects_boolean_count(self):
        value, source_hash = _metadata()
        value["problem_meta"]["runtime_metadata"]["model_builder"]["problem"]["study"]["count"] = True
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "metadata.json"
            path.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "exactly one mode"):
                validate_parallel_probe_metadata(path, model_sha256=source_hash, parallel_mode="serial")

    def test_metadata_guard_requires_both_source_hash_bindings(self):
        value, source_hash = _metadata()
        value["problem_meta"].pop("source_hash")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "metadata.json"
            path.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "source_hash fields"):
                validate_parallel_probe_metadata(path, model_sha256=source_hash, parallel_mode="serial")

    def test_solver_artifact_guard_checks_resolved_eps_ksp_and_floquet_phase(self):
        with tempfile.TemporaryDirectory() as directory:
            case = Path(directory)
            _write_native_probe_artifacts(case)
            report = validate_parallel_probe_solver_artifacts(
                case,
                requested_eps_prefilter="1e-9",
                requested_shifted_ksp_rtol="1e-9",
                requested_gmres_restart="8",
            )
            self.assertEqual(report["status"], "pass")
            self.assertEqual(report["sample_count"], 3)
            self.assertEqual(report["resolved_gmres_restart"], 8)
            self.assertEqual(report["resolved_eps_normalized_absolute_tolerance"], [1e-11] * 3)
            diagnostics_path = case / "eigen/diagnostics/solver.v1.json"
            diagnostics = json.loads(diagnostics_path.read_text(encoding="utf-8"))
            diagnostics["sample_solver_diagnostics"][1]["diagnostics"]["ksp_restart"] = 10
            diagnostics_path.write_text(json.dumps(diagnostics), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "GMRES restart"):
                validate_parallel_probe_solver_artifacts(
                    case,
                    requested_eps_prefilter="1e-9",
                    requested_shifted_ksp_rtol="1e-9",
                    requested_gmres_restart="8",
                )

    def test_phase_identity_is_bound_to_each_signed_sample(self):
        with tempfile.TemporaryDirectory() as directory:
            case = Path(directory)
            _write_native_probe_artifacts(case)
            report = validate_parallel_probe_solver_artifacts(
                case, requested_eps_prefilter="1e-9", requested_shifted_ksp_rtol="1e-9",
                requested_gmres_restart="8")
            bindings = report["phase_constraints_by_sample"]
            self.assertEqual([item["sample_index"] for item in bindings], [0, 1, 2])
            self.assertEqual([item["k_vector_rad_per_m"] for item in bindings],
                             [list(k) for k in PARALLEL_PROBE_VECTORS_RAD_PER_M])
            self.assertNotEqual(bindings[0]["phase_constraint_sha256"],
                                bindings[1]["phase_constraint_sha256"])
            self.assertEqual(bindings[0]["phase_constraint_sha256"],
                             bindings[2]["phase_constraint_sha256"])
            summary_path = case / "eigen/metadata/eigen_summary.json"
            summary = json.loads(summary_path.read_text(encoding="utf-8"))
            summary["modes"][0]["phase_constraint_sha256"] = bindings[1]["phase_constraint_sha256"]
            summary_path.write_text(json.dumps(summary), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "summary phase identity"):
                validate_parallel_probe_solver_artifacts(
                    case, requested_eps_prefilter="1e-9", requested_shifted_ksp_rtol="1e-9",
                    requested_gmres_restart="8")

    def test_unpinned_sample_count_rejects_nonfinite_k_vector(self):
        with tempfile.TemporaryDirectory() as directory:
            case = Path(directory)
            _write_native_probe_artifacts(case)
            path = case / "eigen/spectrum.v3.json"
            spectrum = json.loads(path.read_text(encoding="utf-8"))
            spectrum["samples"] = spectrum["samples"][:2]
            spectrum["samples"][0]["k_vector"] = [0.0, float("nan"), 0.0]
            path.write_text(json.dumps(spectrum), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "invalid k vector"):
                validate_parallel_probe_solver_artifacts(
                    case, expected_sample_count=2, requested_eps_prefilter="1e-9",
                    requested_shifted_ksp_rtol="1e-9", requested_gmres_restart="8")

    def test_selected_only_guard_rejects_boolean_mode_count(self):
        with tempfile.TemporaryDirectory() as directory:
            case = Path(directory)
            (case / "metadata.json").write_text(json.dumps({
                "problem_meta": {"runtime_metadata": {"de_smoke": {
                    "schema": "fullmag.de-smoke.v1",
                    "modal_target": "nearest",
                    "selection_scope": "selected_only",
                    "window_complete": False,
                    "target_frequency_hz": 10.0e9,
                    "sampling": "k2",
                    "requested_mode_count": True,
                    "k_vectors_rad_per_m": [[0.0, 2.0e6, 0.0]],
                }}}
            }), encoding="utf-8")
            with patch.object(pilot, "validate_selected_only_diagnostics", return_value={}):
                with self.assertRaisesRegex(pilot.managed.BenchmarkError, "more than one mode"):
                    pilot.validate_selected_only_metadata(case, 10.0e9, "k2")

    def test_row_guard_requires_one_native_mode_per_parallel_sample(self):
        def dynamic_probe():
            sample = {
                "attempted": True,
                "passed": True,
                "q_l2_norm": 1.0,
                "potential_relative_residual": 1e-12,
                "self_energy_j": 0.0,
                "potential_energy_j": 0.0,
                "energy_form_relative_defect": 0.0,
            }
            return {
                "schema_version": "floquet_dynamic_demag_operator_probe.v1",
                "status": "passed",
                "potential_equation": "P_phi_plus_A_phiq_q_equals_zero",
                "potential_coefficient_unit": "A",
                "energy_unit": "J",
                "relative_tolerance": 1e-8,
                "hermitian_relative_defect": 0.0,
                "global_y": dict(sample),
                "global_z": dict(sample),
            }

        with tempfile.TemporaryDirectory() as directory:
            case = Path(directory)
            rows = ["sample_index,raw_mode_index,branch_id,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,frequency_hz,residual_norm"]
            for sample_index, ky in enumerate((-10e6, 10e6, -10e6)):
                rows.append(f"{sample_index},0,0,0.0,{ky},0.0,11000000000.0,1e-10")
            (case / "dispersion.csv").write_text("\n".join(rows) + "\n", encoding="utf-8")
            metadata = {"problem_meta": {"runtime_metadata": {"de_smoke": {
                "schema": "fullmag.de-smoke.v1",
                "sampling": "parallel-probe",
                "orientation": "M0=x,k=y,normal=z",
                "k_vectors_rad_per_m": [[0.0, -10e6, 0.0], [0.0, 10e6, 0.0], [0.0, -10e6, 0.0]],
                "eigen_solver_rtol": 1e-8,
            }}}}
            (case / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
            diagnostics = {"sample_solver_diagnostics": [
                {"sample_index": index, "diagnostics": {
                    "dynamic_demag_operator_probe": dynamic_probe(),
                }} for index in range(3)
            ]}
            (case / "solver.v1.json").write_text(json.dumps(diagnostics), encoding="utf-8")
            mode = {
                "sample_index": 0,
                "raw_mode_index": 0,
                "frequency_hz": 11000000000.0,
                "residual_relative_l2": 1e-10,
                "block_residuals": {
                    "eps_q": 1e-10, "eps_phi": 1e-10, "eps_gauge": None,
                    "eps_full": None, "eps_reduced": 1e-10,
                    "certification_tolerance": 1e-8,
                    "scope": "reduced_original_blocks_only",
                    "certified": False,
                    "reduced_pencil_certified": True,
                    "full_descriptor_certified": False,
                },
            }
            spectrum = {
                "schema_version": "eigen_spectrum.v3",
                "sample_count": 3,
                "samples": [
                    {"sample_index": index, "sample_id": f"k-sample-{index:04}",
                     "modes": [{**mode, "sample_index": index}]}
                    for index in range(3)
                ],
            }
            spectrum_path = case / "spectrum.v3.json"
            spectrum_path.write_text(json.dumps(spectrum), encoding="utf-8")
            result = validate_rows(
                case / "dispersion.csv", "parallel-probe", case / "solver.v1.json",
                case / "metadata.json")
            self.assertEqual(result["sample_count"], 3)
            spectrum["samples"][0]["modes"].append({**mode, "sample_index": 0, "raw_mode_index": 1})
            spectrum_path.write_text(json.dumps(spectrum), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "exactly one mode"):
                validate_rows(
                    case / "dispersion.csv", "parallel-probe", case / "solver.v1.json",
                    case / "metadata.json")

    def test_input_manifest_guard_binds_exact_files_and_content(self):
        with tempfile.TemporaryDirectory() as directory:
            storage = Path(directory)
            root = storage.joinpath(*pilot.PARALLEL_PROBE_INPUT_RELATIVE_ROOT.split("/"))
            input_dir = root / "input"
            input_dir.mkdir(parents=True)
            model_data = b"value = 1\n"
            model_sha = hashlib.sha256(model_data).hexdigest()
            (root / "model-input.py").write_bytes(model_data)
            eq = {"schema_version": "equilibrium_artifact.v7", "content_sha256": "sha256:1111111111111111111111111111111111111111111111111111111111111111"}
            lin = {
                "schema_version": "LinearizationState.v6",
                "content_sha256": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
                "source_equilibrium_artifact": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            }
            eq_bytes = json.dumps(eq, separators=(",", ":")).encode()
            lin_bytes = json.dumps(lin, separators=(",", ":")).encode()
            (input_dir / "equilibrium_artifact.v7.json").write_bytes(eq_bytes)
            (input_dir / "linearization_state.v6.json").write_bytes(lin_bytes)
            manifest = {
                "schema": "fullmag.serial-adaptive-probe-input-manifest.v1",
                "source_run": "fixture",
                "files": [
                    {
                        "path": "equilibrium_artifact.v7.json",
                        "schema_version": "equilibrium_artifact.v7",
                        "sha256": hashlib.sha256(eq_bytes).hexdigest(),
                        "content_sha256": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
                        "equilibrium_id": "equilibrium_artifact.v7:1111111111111111111111111111111111111111111111111111111111111111",
                    },
                    {
                        "path": "linearization_state.v6.json",
                        "schema_version": "LinearizationState.v6",
                        "sha256": hashlib.sha256(lin_bytes).hexdigest(),
                        "content_sha256": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
                        "linearization_state_id": "LinearizationState.v6:2222222222222222222222222222222222222222222222222222222222222222",
                    },
                ],
                "copy_policy": "byte-exact copies of already validated metadata; immutable inputs for both policy runs",
            }
            manifest_bytes = json.dumps(manifest, indent=2).encode()
            (input_dir / "input-manifest.json").write_bytes(manifest_bytes)
            with patch.object(pilot, "PARALLEL_PROBE_MODEL_SHA256", model_sha), \
                    patch.object(pilot, "PARALLEL_PROBE_MANIFEST_SHA256", hashlib.sha256(manifest_bytes).hexdigest()), \
                    patch.object(pilot, "PARALLEL_PROBE_EQUILIBRIUM_SHA256", hashlib.sha256(eq_bytes).hexdigest()), \
                    patch.object(pilot, "PARALLEL_PROBE_LINEARIZATION_SHA256", hashlib.sha256(lin_bytes).hexdigest()):
                data, identity, mounted_input = pilot._validate_parallel_probe_inputs(
                    {"storage_root": storage}, None, "serial"
                )
                # Byte mutation fails the raw-file gate before content checks.
                eq_path = input_dir / "equilibrium_artifact.v7.json"
                eq_path.write_bytes(eq_bytes + b"\n")
                with self.assertRaisesRegex(pilot.managed.BenchmarkError, "input hash mismatch"):
                    pilot._validate_parallel_probe_inputs({"storage_root": storage}, None, "serial")
                eq_path.write_bytes(eq_bytes)
                # Even an independently rebound raw digest cannot change the
                # native identity recorded by the immutable manifest.
                changed = dict(eq, content_sha256="sha256:" + "3" * 64)
                changed_bytes = json.dumps(changed, separators=(",", ":")).encode()
                eq_path.write_bytes(changed_bytes)
                with patch.object(pilot, "PARALLEL_PROBE_EQUILIBRIUM_SHA256", hashlib.sha256(changed_bytes).hexdigest()):
                    altered = json.loads(manifest_bytes)
                    altered["files"][0]["sha256"] = hashlib.sha256(changed_bytes).hexdigest()
                    altered_bytes = json.dumps(altered, indent=2).encode()
                    (input_dir / "input-manifest.json").write_bytes(altered_bytes)
                    with patch.object(pilot, "PARALLEL_PROBE_MANIFEST_SHA256", hashlib.sha256(altered_bytes).hexdigest()):
                        with self.assertRaisesRegex(pilot.managed.BenchmarkError, "content hash binding"):
                            pilot._validate_parallel_probe_inputs({"storage_root": storage}, None, "serial")
                eq_path.write_bytes(eq_bytes)
                (input_dir / "input-manifest.json").write_bytes(manifest_bytes)

            self.assertEqual(data, model_data)
            self.assertEqual(identity["manifest_sha256"], hashlib.sha256(manifest_bytes).hexdigest())
            self.assertEqual(identity["equilibrium_artifact_role"], "solver_consumed")
            self.assertEqual(identity["equilibrium_artifact_content_sha256"], eq["content_sha256"])
            self.assertEqual(identity["linearization_state_content_sha256"], lin["content_sha256"])
            self.assertNotEqual(identity["equilibrium_artifact_sha256"], eq["content_sha256"].removeprefix("sha256:"))
            self.assertNotEqual(identity["linearization_state_sha256"], lin["content_sha256"].removeprefix("sha256:"))
            self.assertEqual(
                identity["linearization_state_role"],
                "reference_provenance_only_not_consumed_by_solver",
            )
            self.assertEqual(mounted_input, input_dir)

    def test_compose_probe_pins_mount_resources_and_safe_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            storage = Path(directory) / "storage"
            probe_root = storage.joinpath(*pilot.PARALLEL_PROBE_INPUT_RELATIVE_ROOT.split("/"))
            output = Path(directory) / "output"
            output.mkdir()
            input_dir = probe_root / "input"
            input_dir.mkdir(parents=True)
            (output / "compose.benchmark.override.yaml").write_text(
                "services:\n  fem-modal-cpu:\n    network_mode: none\n    volumes: !reset []\n",
                encoding="utf-8",
            )
            base = ["docker", "compose", "run", "--rm", "fem-modal-cpu", "timeout", "bash", "-lc", ""]
            with patch.object(pilot.managed, "_compose_command", return_value=base):
                command = pilot.compose_command(
                    type("Context", (), {"layout": {"storage_root": storage}})(), output,
                    pilot=pilot.PARALLEL_PROBE_PILOT,
                    external_model=True,
                    probe_input_dir=input_dir,
                    probe_manifest_sha256="b" * 64,
                    parallel_mode="adaptive",
                )
            override = (output / "compose.benchmark.override.yaml").read_text(encoding="utf-8")
            self.assertIn("cpus: 4.0", override)
            self.assertIn("mem_limit: 8g", override)
            self.assertTrue(any("/workspace/benchmark-input:ro" in item for item in command))
            shell = command[-1]
            self.assertIn("actual_manifest_sha", shell)
            self.assertIn("cpu.max", shell)
            self.assertNotIn("awk", shell)

    def test_cleanup_attestation_includes_both_external_read_only_mounts(self):
        with tempfile.TemporaryDirectory() as directory:
            storage = Path(directory) / "storage"
            probe_root = storage.joinpath(*pilot.PARALLEL_PROBE_INPUT_RELATIVE_ROOT.split("/"))
            input_dir = probe_root / "input"
            input_dir.mkdir(parents=True)
            output = Path(directory) / "output"
            output.mkdir()
            context = type(
                "Context",
                (),
                {
                    "layout": {"storage_root": storage},
                    "source_tree": storage / "source",
                    "runtime_root": storage / "runtime",
                },
            )()
            extras = pilot._cleanup_extra_mounts(
                output,
                model_identity={"sha256": "a" * 64},
                probe_input_dir=input_dir,
            )
            mounts = pilot.managed._expected_container_mounts(
                context, output, extra_mounts=extras
            )
            by_destination = {mount["destination"]: mount for mount in mounts}
            self.assertEqual(
                by_destination["/workspace/benchmark-model.py"]["source"],
                str((output / "model-input.py").resolve()),
            )
            self.assertEqual(
                by_destination["/workspace/benchmark-input"]["source"],
                str(input_dir.resolve()),
            )


if __name__ == "__main__":
    unittest.main()
