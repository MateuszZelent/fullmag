#!/usr/bin/env python3
"""Unit tests for the FEM relaxation runtime log validator."""

from __future__ import annotations

import json
import os
import importlib.util
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "validate_fem_relaxation_runtime_log.py"
VERIFY_RUNTIME = REPO_ROOT / "scripts" / "verify_fem_relaxation_runtime.sh"
JUSTFILE = REPO_ROOT / "justfile"
FEM_RELAXATION_NOTE = (
    REPO_ROOT / "docs" / "physics" / "0510-fem-relaxation-algorithms-mfem-gpu.md"
)
BENCHMARK = REPO_ROOT / "scripts" / "analysis" / "fem_gpu_benchmark.py"
BENCHMARK_CASE = REPO_ROOT / "examples" / "bench_fem_gpu_long.py"
FULLMAG_PYTHON_SRC = REPO_ROOT / "packages" / "fullmag-py" / "src"
ZHANG_LI_VALIDATOR = REPO_ROOT / "scripts" / "validate_fem_zhang_li_skew_tetra_runtime.py"
RUNTIME_RESTORE_VERIFIER = REPO_ROOT / "scripts" / "verify_fem_gpu_runtime_restore.py"


def load_benchmark_module():
    spec = importlib.util.spec_from_file_location("fem_gpu_benchmark", BENCHMARK)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_benchmark_case_module():
    sys.path.insert(0, str(FULLMAG_PYTHON_SRC))
    spec = importlib.util.spec_from_file_location("bench_fem_gpu_long", BENCHMARK_CASE)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_validator_module():
    spec = importlib.util.spec_from_file_location(
        "validate_fem_relaxation_runtime_log", VALIDATOR
    )
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def write_performance_fixture(
    tmp_path: Path,
    benchmark,
    **overrides,
) -> Path:
    mesh = tmp_path / "mesh.json"
    mesh.write_text(
        json.dumps(
            {
                "mesh_name": "fixture",
                "nodes": [[0.0, 0.0, 0.0]],
                "elements": [[0, 0, 0, 0]],
            }
        ),
        encoding="utf-8",
    )
    payload = {
        "schema": "fullmag.fem_gpu.performance_fixture.v1",
        "solver_mesh_path": "mesh.json",
        "solver_mesh_sha256": benchmark.hashlib.sha256(mesh.read_bytes()).hexdigest(),
        "solver_mesh_signature": "fixture-mesh",
        "problem_ir_sha256": "a" * 64,
        "scenario": "box500_airbox_exchange_demag",
        "relaxation_algorithm": "nonlinear_cg",
        "node_count": 1,
        "element_count": 1,
        "demag_policy": {
            "solver": "CG",
            "preconditioner": "AMG",
            "rtol": 1e-12,
            "amg_relax_type": 6,
            "amg_coarsening": 8,
            "amg_interpolation": 6,
            "amg_aggressive_coarsening": 1,
        },
        "stop_condition": {
            "kind": "torque_or_max_steps",
            "max_steps": 64,
            "benchmark_only_torque_target_apm": 1e-6,
        },
    }
    payload.update(overrides)
    manifest = tmp_path / "fixture.json"
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    return manifest


def test_benchmark_summary_reports_distribution() -> None:
    benchmark = load_benchmark_module()
    summary = benchmark.summarize_distribution([10.0, 11.0, 12.0, 20.0, 30.0])
    assert summary == {
        "count": 5,
        "p50": 12.0,
        "p95": 30.0,
        "stddev": pytest.approx(7.5789181286),
    }


def test_benchmark_csv_uses_repository_line_endings(tmp_path) -> None:
    benchmark = load_benchmark_module()
    output = tmp_path / "benchmark.csv"

    benchmark.write_csv([{"backend": "fem_gpu", "status": "ok"}], str(output))

    assert output.read_bytes() == b"backend,status\nfem_gpu,ok\n"


def test_fixture_identity_rejects_mesh_hash_drift(tmp_path) -> None:
    benchmark = load_benchmark_module()
    mesh = tmp_path / "mesh.json"
    mesh.write_text('{"nodes":[],"elements":[]}', encoding="utf-8")
    manifest = tmp_path / "fixture.json"
    manifest.write_text(
        json.dumps(
            {
                "schema": "fullmag.fem_gpu.performance_fixture.v1",
                "solver_mesh_path": "mesh.json",
                "solver_mesh_sha256": "0" * 64,
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="solver mesh sha256 mismatch"):
        benchmark.load_fixture_manifest(manifest)


def test_fixture_identity_rejects_row_drift(tmp_path) -> None:
    benchmark = load_benchmark_module()
    manifest = write_performance_fixture(tmp_path, benchmark)
    fixture = benchmark.load_fixture_manifest(manifest)

    assert benchmark.verify_fixture_row(
        {
            "solver_mesh_signature": "different-mesh",
            "executed_problem_ir_sha256": "different-ir",
            "reported_scenario": "box500_airbox_exchange_demag",
            "reported_relaxation_algorithm": "nonlinear_cg",
            "steps": 64,
            "executed_steps": 64,
            "requested_relax_torque_tolerance_apm": 1e-6,
            "requested_demag_solver": "CG",
            "requested_demag_preconditioner": "AMG",
            "requested_demag_relative_tolerance": 1e-12,
            "requested_demag_amg_relax_type": 6,
            "requested_demag_amg_coarsening": 8,
            "requested_demag_amg_interpolation": 6,
            "requested_demag_amg_aggressive_coarsening": 1,
            "demag_linear_solver": "CG",
            "demag_preconditioner": "AMG",
            "demag_relative_tolerance": 1e-12,
            "demag_amg_relax_type": 6,
            "demag_amg_coarsening": 8,
            "demag_amg_interpolation": 6,
            "demag_amg_aggressive_coarsening": 1,
            "node_count": 1,
            "element_count": 1,
        },
        fixture,
    ) == [
        "solver_mesh_signature differs from fixture",
        "executed_problem_ir_sha256 differs from fixture",
    ]


def test_fixture_manifest_sha_must_match_environment_pin(tmp_path) -> None:
    benchmark = load_benchmark_module()
    manifest = write_performance_fixture(tmp_path, benchmark)

    with pytest.raises(ValueError, match="fixture manifest sha256 mismatch"):
        benchmark.load_fixture_manifest(
            manifest,
            expected_manifest_sha256="0" * 64,
        )


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("reported_scenario", "other", "scenario differs from fixture"),
        (
            "reported_relaxation_algorithm",
            "projected_gradient_bb",
            "relaxation_algorithm differs from fixture",
        ),
        ("steps", 63, "steps differs from fixture stop condition"),
        ("executed_steps", 65, "executed_steps violates fixture stop condition"),
        ("requested_relax_torque_tolerance_apm", 2e-6, "torque target differs from fixture"),
        ("requested_demag_solver", "GMRES", "demag solver differs from fixture"),
        (
            "requested_demag_preconditioner",
            "JACOBI",
            "demag preconditioner differs from fixture",
        ),
        ("requested_demag_relative_tolerance", 1e-8, "demag rtol differs from fixture"),
        ("requested_demag_amg_relax_type", 18, "demag AMG relax type differs from fixture"),
        ("node_count", 2, "node_count differs from fixture"),
        ("element_count", 2, "element_count differs from fixture"),
    ],
)
def test_fixture_identity_rejects_full_contract_tamper(
    tmp_path,
    field,
    value,
    message,
) -> None:
    benchmark = load_benchmark_module()
    fixture = benchmark.load_fixture_manifest(
        write_performance_fixture(tmp_path, benchmark)
    )
    row = {
        "solver_mesh_signature": "fixture-mesh",
        "executed_problem_ir_sha256": "a" * 64,
        "reported_scenario": "box500_airbox_exchange_demag",
        "reported_relaxation_algorithm": "nonlinear_cg",
        "steps": 64,
        "executed_steps": 64,
        "requested_relax_torque_tolerance_apm": 1e-6,
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
        "requested_demag_relative_tolerance": 1e-12,
        "requested_demag_amg_relax_type": 6,
        "requested_demag_amg_coarsening": 8,
        "requested_demag_amg_interpolation": 6,
        "requested_demag_amg_aggressive_coarsening": 1,
        "demag_linear_solver": "CG",
        "demag_preconditioner": "AMG",
        "demag_relative_tolerance": 1e-12,
        "demag_amg_relax_type": 6,
        "demag_amg_coarsening": 8,
        "demag_amg_interpolation": 6,
        "demag_amg_aggressive_coarsening": 1,
        "node_count": 1,
        "element_count": 1,
    }
    row[field] = value

    assert message in benchmark.verify_fixture_row(row, fixture)


def test_fixture_identity_rejects_resolved_demag_policy_tamper(tmp_path) -> None:
    benchmark = load_benchmark_module()
    fixture = benchmark.load_fixture_manifest(
        write_performance_fixture(tmp_path, benchmark)
    )
    row = {
        "solver_mesh_signature": "fixture-mesh",
        "executed_problem_ir_sha256": "a" * 64,
        "reported_scenario": "box500_airbox_exchange_demag",
        "reported_relaxation_algorithm": "nonlinear_cg",
        "steps": 64,
        "executed_steps": 64,
        "requested_relax_torque_tolerance_apm": 1e-6,
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
        "requested_demag_relative_tolerance": 1e-12,
        "requested_demag_amg_relax_type": 6,
        "requested_demag_amg_coarsening": 8,
        "requested_demag_amg_interpolation": 6,
        "requested_demag_amg_aggressive_coarsening": 1,
        "demag_linear_solver": "CG",
        "demag_preconditioner": "JACOBI",
        "demag_relative_tolerance": 1e-12,
        "demag_amg_relax_type": 6,
        "demag_amg_coarsening": 8,
        "demag_amg_interpolation": 6,
        "demag_amg_aggressive_coarsening": 1,
        "node_count": 1,
        "element_count": 1,
    }

    assert "resolved demag preconditioner differs from fixture" in (
        benchmark.verify_fixture_row(row, fixture)
    )


def test_fixture_identity_requires_hash_observed_from_executed_ir(tmp_path) -> None:
    benchmark = load_benchmark_module()
    fixture = benchmark.load_fixture_manifest(
        write_performance_fixture(tmp_path, benchmark)
    )

    failures = benchmark.verify_fixture_row(
        {
            "solver_mesh_signature": "fixture-mesh",
            "problem_ir_sha256": fixture.problem_ir_sha256,
        },
        fixture,
    )

    assert "executed_problem_ir_sha256 differs from fixture" in failures


def test_fixture_execution_command_consumes_exact_canonical_ir() -> None:
    benchmark = load_benchmark_module()

    command = benchmark.problem_ir_execution_command(
        binary=Path("/runtime/fullmag"),
        problem_ir_path=Path("/tmp/canonical.problem-ir.json"),
        run_dir=Path("/tmp/run"),
        until_seconds=1e-12,
    )

    assert command == [
        "/runtime/fullmag",
        "run-json",
        "/tmp/canonical.problem-ir.json",
        "--until",
        "1e-12",
        "--output-dir",
        "/tmp/run",
    ]


def test_fixture_stop_identity_is_extracted_from_exact_problem_ir() -> None:
    benchmark = load_benchmark_module()

    stop = benchmark.problem_ir_stop_condition(
        {
            "study": {
                "stop": {
                    "max_steps": 64,
                    "torque_tolerance_apm": 1.0e-6,
                }
            }
        }
    )

    assert stop == {
        "kind": "torque_or_max_steps",
        "benchmark_only_torque_target_apm": 1.0e-6,
        "max_steps": 64,
    }


def test_run_json_artifacts_supply_authoritative_benchmark_payload(tmp_path) -> None:
    benchmark = load_benchmark_module()
    (tmp_path / "metadata.json").write_text(
        json.dumps(
            {
                "status": "completed",
                "scalar_rows": 2,
                "fem_gpu_relaxation_qualification": {
                    "executed_steps": 2,
                },
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "scalars.csv").write_text(
        "step,time,solver_dt,E_ex,E_demag,E_ext,E_ani,E_dmi,E_total,"
        "max_dm_dt,max_h_eff,max_h_demag,max_torque_Apm,max_torque_T\n"
        "2,2e-12,1e-12,1,2,3,4,5,15,6,7,8,9,10\n",
        encoding="utf-8",
    )
    (tmp_path / "solver_steps.csv").write_text(
        "step,rejected_attempts,rhs_evals,demag_solves\n"
        "1,1,2,3\n"
        "2,0,3,4\n",
        encoding="utf-8",
    )

    payload = benchmark.load_authoritative_benchmark_payload(tmp_path)

    assert payload == {
        "status": "completed",
        "executed_steps": 2,
        "artifact_dir": str(tmp_path),
        "final_time_s": "2e-12",
        "final_solver_dt_s": "1e-12",
        "final_e_ex_j": "1",
        "final_e_demag_j": "2",
        "final_e_ext_j": "3",
        "final_e_ani_j": "4",
        "final_e_dmi_j": "5",
        "final_e_total_j": "15",
        "max_dm_dt": "6",
        "max_h_eff": "7",
        "max_h_demag": "8",
        "max_torque_Apm": "9",
        "max_torque_T": "10",
        "rhs_evals": 3,
        "total_rhs_evals": 5,
        "demag_solves": 7,
        "rejected_attempts": 1,
    }


def test_fixture_generation_uses_runtime_realized_mesh_signature() -> None:
    benchmark = load_benchmark_module()

    assert benchmark.fixture_solver_mesh_signature(
        {
            "status": "ok",
            "solver_mesh_signature": "runtime-realized-signature",
        }
    ) == "runtime-realized-signature"
    with pytest.raises(ValueError, match="did not report solver_mesh_signature"):
        benchmark.fixture_solver_mesh_signature({"status": "ok"})


def test_fem_gpu_performance_regression_recipe_is_fail_closed() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    recipe = just_recipe_source(justfile, "verify-fem-gpu-performance-regression")

    for required in [
        "--fixture-manifest examples/assets/fem_performance/box500_airbox_exchange_demag_v1.fixture.json",
        "--require-fixture-identity",
        "--gpu-warmup",
        "--repeat 5",
        "--require-stable-solver-mesh",
        "--accepted-baseline benchmarks/fem-gpu/accepted/rtx4080-sm89/benchmark.csv",
        "--require-accepted-baseline",
        "--max-performance-regression-percent 5",
        "benchmarks/fem-gpu/accepted/rtx4080-sm89/environment.json",
        "--fixture-environment benchmarks/fem-gpu/accepted/rtx4080-sm89/environment.json",
        "FULLMAG_BENCH_DOMAIN_HMAX=50e-9",
        "FULLMAG_BENCH_AIRBOX_HMAX=100e-9",
    ]:
        assert required in recipe


def test_authoritative_demag_benchmark_preserves_pre_task0_gate() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    recipe = just_recipe_source(
        justfile, "verify-fem-gpu-demag-performance-benchmark"
    )

    assert "box500_airbox_exchange_demag,box500_airbox_exchange_demag_anis_uniaxial,box500_airbox_exchange_demag_anis_cubic" in recipe
    assert 'FULLMAG_BENCH_DEMAG_PRECONDITIONERS="${FULLMAG_BENCH_DEMAG_PRECONDITIONERS:-OMIT,AMG,JACOBI}"' in recipe
    assert 'FULLMAG_BENCH_MIN_GPU_DEMAG_TOTAL_SPEEDUP="${FULLMAG_BENCH_MIN_GPU_DEMAG_TOTAL_SPEEDUP:-2}"' in recipe
    assert "--require-best-demag-policy" in recipe
    assert '--min-gpu-demag-total-speedup "$FULLMAG_BENCH_MIN_GPU_DEMAG_TOTAL_SPEEDUP"' in recipe
    assert "--fixture-manifest" not in recipe
    assert "FULLMAG_BENCH_REPEAT" not in recipe


def test_pre_remediation_capture_has_narrow_task0_contract() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    recipe = just_recipe_source(
        justfile, "capture-fem-gpu-pre-remediation-performance-baseline"
    )

    for required in (
        "box500_airbox_exchange_demag",
        "--relax-algorithms nonlinear_cg",
        "--demag-preconditioners AMG",
        "--demag-amg-relax-types 6",
        "--steps 64",
        "--repeat 5",
        "--fixture-manifest examples/assets/fem_performance/box500_airbox_exchange_demag_v1.fixture.json",
        "--fixture-environment benchmarks/fem-gpu/accepted/rtx4080-sm89/environment.json",
        "--require-fixture-identity",
    ):
        assert required in recipe
    assert "--min-gpu-demag-total-speedup" not in recipe
    assert "--require-best-demag-policy" not in recipe


def test_benchmark_performance_summary_groups_repeat_distributions() -> None:
    benchmark = load_benchmark_module()
    base = {
        "status": "ok",
        "solver_mesh_signature": "mesh",
        "backend": "fem_gpu",
        "mesh_path": "mesh.json",
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "relaxation_algorithm": "nonlinear_cg",
        "timestep_policy": "fixed",
        "requested_cpu_thread_spec": "auto",
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
    }

    summary = benchmark.performance_distribution_summary(
        [
            {**base, "wall_time_ms": 10.0},
            {**base, "wall_time_ms": 12.0},
            {**base, "wall_time_ms": 20.0},
        ]
    )

    assert len(summary) == 1
    assert summary[0]["metrics"]["wall_time_ms"] == {
        "count": 3,
        "p50": 12.0,
        "p95": 20.0,
        "stddev": pytest.approx(4.3204937989),
    }


def test_performance_regression_compares_p95_distributions() -> None:
    benchmark = load_benchmark_module()
    base = {
        "status": "ok",
        "solver_mesh_signature": "mesh",
        "backend": "fem_gpu",
        "mesh_path": "mesh.json",
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "relaxation_algorithm": "nonlinear_cg",
        "timestep_policy": "fixed",
        "requested_cpu_thread_spec": "auto",
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
    }
    baseline = [
        {**base, "wall_time_ms": value} for value in [10.0, 20.0, 30.0, 40.0, 50.0]
    ]
    within_limit = [
        {**base, "wall_time_ms": value} for value in [10.0, 20.0, 30.0, 40.0, 52.0]
    ]
    regressed = [
        {**base, "wall_time_ms": value} for value in [10.0, 20.0, 30.0, 40.0, 53.0]
    ]

    assert benchmark.performance_regression_failures(
        within_limit,
        baseline,
        max_regression_percent=5.0,
    ) == []
    failures = benchmark.performance_regression_failures(
        regressed,
        baseline,
        max_regression_percent=5.0,
    )
    assert len(failures) == 1
    assert "p95" in failures[0]


def test_performance_regression_gates_only_objective_metrics() -> None:
    benchmark = load_benchmark_module()
    base = {
        "status": "ok",
        "solver_mesh_signature": "mesh",
        "backend": "fem_gpu",
        "mesh_path": "mesh.json",
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "relaxation_algorithm": "nonlinear_cg",
        "timestep_policy": "fixed",
        "requested_cpu_thread_spec": "auto",
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
    }
    baseline = [
        {**base, "wall_time_ms": 100.0, "demag_assemble_wall_time_ms": 10.0}
        for _ in range(5)
    ]
    current = [
        {**base, "wall_time_ms": 104.0, "demag_assemble_wall_time_ms": 100.0}
        for _ in range(5)
    ]

    assert benchmark.performance_regression_failures(
        current,
        baseline,
        max_regression_percent=5.0,
    ) == []


@pytest.mark.parametrize(
    ("side", "values", "reason"),
    [
        ("current", [None] * 5, "current wall_time_ms contains missing"),
        ("accepted", [None] * 5, "accepted wall_time_ms contains missing"),
        ("current", [10.0, 11.0, float("nan"), 13.0, 14.0], "current wall_time_ms contains non-finite"),
        ("accepted", [10.0, 11.0, float("inf"), 13.0, 14.0], "accepted wall_time_ms contains non-finite"),
        ("current", [10.0, 11.0, 0.0, 13.0, 14.0], "current wall_time_ms contains non-positive"),
        ("accepted", [10.0, 11.0, -1.0, 13.0, 14.0], "accepted wall_time_ms contains non-positive"),
        ("current", [10.0, 11.0, 12.0, 13.0], "current wall_time_ms requires at least 5 samples"),
        ("accepted", [10.0, 11.0, 12.0, 13.0], "accepted wall_time_ms requires at least 5 samples"),
    ],
)
def test_required_accepted_baseline_rejects_invalid_objective_samples(
    side,
    values,
    reason,
) -> None:
    benchmark = load_benchmark_module()
    base = {
        "status": "ok",
        "solver_mesh_signature": "mesh",
        "backend": "fem_gpu",
        "mesh_path": "mesh.json",
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "relaxation_algorithm": "nonlinear_cg",
        "timestep_policy": "fixed",
        "requested_cpu_thread_spec": "auto",
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
        "demag_solver_apply_wall_time_ms": 1.0,
    }
    valid = [{**base, "wall_time_ms": value} for value in [10, 11, 12, 13, 14]]
    invalid = [{**base, "wall_time_ms": value} for value in values]
    current = invalid if side == "current" else valid
    accepted = invalid if side == "accepted" else valid

    failures = benchmark.performance_regression_failures(
        current,
        accepted,
        max_regression_percent=5.0,
        require_complete_objectives=True,
        required_sample_count=5,
    )

    assert any(reason in failure for failure in failures)


def test_gpu_environment_identity_rejects_different_device() -> None:
    benchmark = load_benchmark_module()

    assert benchmark.gpu_environment_identity_failures(
        {
            "gpu": {
                "uuid": "GPU-expected",
                "name": "NVIDIA GeForce RTX 4080 SUPER",
                "compute_capability": "8.9",
            }
        },
        {
            "uuid": "GPU-other",
            "name": "NVIDIA GeForce RTX 4090",
            "compute_capability": "8.9",
        },
    ) == [
        "GPU uuid differs from accepted baseline",
        "GPU name differs from accepted baseline",
    ]


def test_fixture_generation_recipe_uses_managed_runtime() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    recipe = just_recipe_source(justfile, "generate-fem-gpu-performance-fixtures")

    assert "just ensure-managed-fem-runtime" in recipe
    assert "docker compose --profile fem-gpu run --rm" in recipe
    assert "PYTHONPATH=/workspace/packages/fullmag-py/src" in recipe
    assert "FULLMAG_GMSH_THREADS=1" in recipe
    assert "--steps 1" in recipe
    assert "--reuse-generated-domain-mesh" in recipe
    assert "--write-fixture-manifest examples/assets/fem_performance/box500_airbox_exchange_demag_v1.fixture.json" in recipe
    assert "--write-fixture-suite examples/assets/fem_performance/amg_qualification_suite_v1.json" in recipe


def test_runtime_restore_manifest_rejects_library_hash_drift(tmp_path) -> None:
    benchmark = load_benchmark_module()
    bundle = tmp_path / "bundle"
    (bundle / "lib").mkdir(parents=True)
    (bundle / "manifest.json").write_text("manifest", encoding="utf-8")
    (bundle / "snapshot.json").write_text("snapshot", encoding="utf-8")
    (bundle / "lib" / "libfullmag_fem.so").write_text("library", encoding="utf-8")
    restore_manifest = bundle / "restore-manifest-v2.json"
    restore_manifest.write_text(
        json.dumps(
            {
                "schema": "fullmag.fem_gpu.runtime_restore_manifest.v2",
                "bundle_root": str(bundle),
                "manifest_sha256": benchmark.hashlib.sha256(b"manifest").hexdigest(),
                "immutable_snapshot_json_sha256": benchmark.hashlib.sha256(
                    b"snapshot"
                ).hexdigest(),
                "libraries": {
                    "libfullmag_fem": {
                        "path": "lib/libfullmag_fem.so",
                        "sha256": "0" * 64,
                    }
                },
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="libfullmag_fem sha256 mismatch"):
        benchmark.validate_runtime_restore_manifest(restore_manifest)


def test_runtime_restore_recipe_proves_controlled_export_invariance() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    recipe = just_recipe_source(
        justfile, "verify-fem-gpu-pre-remediation-runtime-restore"
    )

    for required in (
        "scripts/verify_fem_gpu_runtime_restore.py capture",
        "benchmarks/fem-gpu/accepted/rtx4080-sm89/environment.json",
        "just rebuild-fem-runtime",
        "scripts/verify_fem_gpu_runtime_restore.py compare",
    ):
        assert required in recipe


def test_runtime_restore_verifier_fails_clearly_for_missing_external_bundle(
    tmp_path,
) -> None:
    environment = tmp_path / "environment.json"
    environment.write_text(
        json.dumps(
            {
                "runtime_bundle": {
                    "root": "missing/bundle",
                    "restore_manifest_path": "missing/bundle/restore-manifest-v2.json",
                    "restore_manifest_sha256": "0" * 64,
                }
            }
        ),
        encoding="utf-8",
    )

    completed = subprocess.run(
        [
            sys.executable,
            str(RUNTIME_RESTORE_VERIFIER),
            "capture",
            "--environment",
            str(environment),
            "--state",
            str(tmp_path / "state.json"),
        ],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode != 0
    assert "external immutable FEM GPU runtime bundle is missing" in completed.stderr


def test_resolves_container_workspace_artifact_path_on_host(monkeypatch) -> None:
    validator = load_validator_module()
    with tempfile.TemporaryDirectory() as directory:
        repo_root = Path(directory)
        artifact_dir = repo_root / "examples" / "case.zarr" / "artifacts"
        artifact_dir.mkdir(parents=True)
        monkeypatch.chdir(repo_root)

        resolved = validator.resolve_artifact_dir(
            {"artifact_dir": "/workspace/examples/case.zarr/artifacts"},
            repo_root / "runtime.log",
        )

        assert resolved == artifact_dir


def just_recipe_source(justfile: str, recipe_name: str) -> str:
    marker = f"{recipe_name}:"
    start = justfile.index(marker)
    following = justfile[start + len(marker) :].splitlines()
    recipe_lines = [marker]
    for line in following:
        if line and not line.startswith((" ", "\t", "#")) and ":" in line:
            break
        recipe_lines.append(line)
    return "\n".join(recipe_lines)


def expected_cpu_line_search(algorithm: str) -> str:
    if algorithm == "projected_gradient_bb":
        return "native_armijo_backtracking_bb1_bb2"
    if algorithm == "nonlinear_cg":
        return "native_armijo_backtracking_pr_plus_restart"
    return "native_armijo_backtracking"


def expected_realization(engine: str, algorithm: str) -> str:
    return {
        ("cpu", "projected_gradient_bb"): "native_mfem_pgbb",
        ("gpu", "projected_gradient_bb"): "native_cuda_pgbb",
        ("cpu", "nonlinear_cg"): "native_mfem_nonlinear_cg",
        ("gpu", "nonlinear_cg"): "native_cuda_nonlinear_cg",
        ("cpu", "tangent_plane_implicit"): "native_mfem_tpi",
    }[(engine, algorithm)]


def write_artifacts(
    artifact_dir: Path,
    algorithm: str = "nonlinear_cg",
    energies: list[float] | None = None,
    steps: list[int] | None = None,
    torques: list[float] | None = None,
    gpu_status: str = "production_executable",
    engine: str = "gpu",
    include_cpu_qualification: bool = True,
    include_cpu_algorithm_policy: bool = True,
    include_cpu_algorithm_update_policy: bool = True,
    include_gpu_qualification: bool = True,
    include_gpu_gradient_policy: bool = True,
    include_gpu_norm_defect: bool = True,
    cpu_norm_defect: float = 0.0,
    gpu_norm_defect: float = 0.0,
    cpu_line_search: str | None = None,
    gpu_provenance_exchange_operator_mode: str = "legacy_sparse_gpu",
) -> None:
    artifact_dir.mkdir(parents=True, exist_ok=True)
    energies = energies or [4.0e-17, 3.0e-17, 2.0e-17, 1.0e-17]
    steps = steps or list(range(1, len(energies) + 1))
    torques = torques or [1.0 for _ in energies]
    assert len(steps) == len(energies)
    assert len(torques) == len(energies)
    execution_engine = "fem_native_gpu" if engine == "gpu" else "fem_cpu_native"
    fem_execution_mode = "all_in_gpu_legacy_sparse" if engine == "gpu" else "cpu_native"
    uses_cuda_kernels = "true" if engine == "gpu" else "false"
    uses_gpu_poisson = "true" if engine == "gpu" else "false"
    energy_minimizer_realization = (
        "native_llg_time_integrator"
        if algorithm == "llg_overdamped"
        else expected_realization(engine, algorithm)
    )
    llg_provenance_policy = (
        """
    "requested_integrator": "heun",
    "resolved_integrator": "heun",
    "llg_mode": "pure_damping","""
        if algorithm == "llg_overdamped"
        else ""
    )
    qualification_key = (
        f'"fem_gpu_qualification_status": "{gpu_status}",'
        if engine == "gpu"
        else '"fem_gpu_qualification_status": null,'
    )
    gpu_provenance_policy = ""
    if engine == "gpu":
        gpu_provenance_policy = f"""
    "fem_data_residency": "device_source_of_truth",
    "fem_exchange_operator_mode": "{gpu_provenance_exchange_operator_mode}",
    "fem_demag_operator_mode": "device_hypre_poisson","""
    cpu_qualification = ""
    if engine == "cpu" and include_cpu_qualification:
        line_search = cpu_line_search or expected_cpu_line_search(algorithm)
        if algorithm == "llg_overdamped":
            cpu_algorithm_policy = (
                """"algorithm_policy": {
      "realization": "native_llg_time_integrator",
      "time_integrator": "heun",
      "precession_policy": "disabled_pure_damping",
      "rhs_policy": "llg_overdamped_rhs"
    }"""
                if include_cpu_algorithm_policy
                else '"algorithm_policy": null'
            )
        else:
            update_policy = ""
            preconditioner = "exchange_plus_mass_tangent_gradient"
            linear_solver_policy = (
                "serial MFEM CG production default; HyprePCG/BoomerAMG explicit opt-in"
            )
            tangent_operator_policy = ""
            if algorithm == "tangent_plane_implicit":
                preconditioner = "native_tangent_plane_linear_solve_preconditioner"
                linear_solver_policy = (
                    "MFEM/Hypre Krylov solver with non-SPD fallback for indefinite terms"
                )
                tangent_operator_policy = (
                    '"tangent_operator": '
                    '"mass_exchange_local_anisotropy_zeeman_dmi_demag_linear_response",'
                )
            elif include_cpu_algorithm_update_policy:
                update_policy = (
                    '"direction_update": "polak_ribiere_plus_projected_restart",'
                    if algorithm == "nonlinear_cg"
                    else '"step_update": "alternating_bb1_bb2",'
                )
            derivative_contract = (
                '"metric": "mu0_ms_fem_lumped_volume",\n'
                '      "gradient_metric": "mu0_ms_fem_lumped_volume",\n'
                '      "gradient_units": "A/m",\n'
                '      "search_direction_units": "A/m",\n'
                '      "line_search_step_units": "m/A",\n'
                '      "armijo_slope_units": "J A/m",\n'
                '      "armijo_decrement_units": "J",'
                '\n      "armijo_derivative_units": "J",'
            )
            cpu_algorithm_policy = f""""algorithm_policy": {{
    "realization": "{expected_realization("cpu", algorithm)}",
      {derivative_contract}
      "preconditioner": "{preconditioner}",
      "linear_solver_policy": "{linear_solver_policy}",
      "line_search": "{line_search}",
      {tangent_operator_policy}
      {update_policy}
      "gpu_status": "unsupported"
    }}"""
        cpu_qualification = f""",
  "fem_cpu_relaxation_qualification": {{
    "schema_version": "fem_cpu_relaxation_qualification.v1",
    "benchmark_gate_version": "fem_cpu_no_pbc_adaptive.v1",
    "relaxation_algorithm": "{algorithm}",
    "executed_steps": {len(energies)},
    "stop_reason": "max_steps",
    "stop_metric_name": "steps",
    "stop_metric_value": {float(len(energies)):.1f},
    "stop_threshold": {float(len(energies)):.1f},
    "assembly_mode": "legacy_sparse",
    "physics_terms": ["exchange", "demag"],
    "norm_defect": {cpu_norm_defect:.15e},
    {cpu_algorithm_policy}
  }}"""
    gpu_qualification = ""
    if engine == "gpu" and include_gpu_qualification:
        if algorithm == "llg_overdamped":
            algorithm_policy = """"realization": "native_llg_time_integrator",
      "time_integrator": "heun",
      "precession_policy": "disabled_pure_damping",
      "rhs_policy": "llg_overdamped_rhs"
"""
        elif algorithm in {"projected_gradient_bb", "nonlinear_cg"}:
            line_search = expected_cpu_line_search(algorithm)
            direction_policy = (
                '"direction_update": "polak_ribiere_plus_projected_restart"'
                if algorithm == "nonlinear_cg"
                else '"step_update": "alternating_bb1_bb2"'
            )
            gradient_policy = (
                '"gradient_policy": "device_tangent_gradient",'
                if include_gpu_gradient_policy
                else ""
            )
            algorithm_policy = f""""realization": "{expected_realization("gpu", algorithm)}",
      "metric": "mu0_ms_fem_lumped_volume",
      "gradient_metric": "mu0_ms_fem_lumped_volume",
      "gradient_units": "A/m",
      "search_direction_units": "A/m",
      "line_search_step_units": "m/A",
      "armijo_slope_units": "J A/m",
      "armijo_decrement_units": "J",
      "armijo_derivative_units": "J",
      {gradient_policy}
      "line_search": "{line_search}",
      {direction_policy}
"""
        else:
            algorithm_policy = ""
        gpu_norm_defect_field = (
            f'"norm_defect": {gpu_norm_defect:.15e},'
            if include_gpu_norm_defect
            else ""
        )
        gpu_qualification = f""",
  "fem_gpu_relaxation_qualification": {{
    "schema_version": "fem_gpu_relaxation_qualification.v1",
    "relaxation_algorithm": "{algorithm}",
    "algorithm_policy": {{
      {algorithm_policy}
    }},
    "device_policy": {{
      "execution_mode": "all_in_gpu_legacy_sparse",
      "qualification_status": "{gpu_status}",
      "data_residency": "device_source_of_truth",
      "exchange_operator_mode": "legacy_sparse_gpu",
      "demag_operator_mode": "device_hypre_poisson",
      "uses_cuda_kernels": true,
      "uses_gpu_poisson": true,
      "hot_loop_exchange_host_sync_count": 0,
      "hot_loop_compute_host_sync_count": 3
    }},
    {gpu_norm_defect_field}
    "executed_steps": {len(energies)}
  }}"""
    (artifact_dir / "metadata.json").write_text(
        f"""{{
  "status": "completed",
  "problem_name": "fem_relax_gpu_smoke_{algorithm}",
  "scalar_rows": {len(energies)},
  "execution_provenance": {{
    "execution_engine": "{execution_engine}",
    "requested_energy_minimizer": "{algorithm}",
    "resolved_energy_minimizer": "{algorithm}",
    "energy_minimizer_realization": "{energy_minimizer_realization}",
{llg_provenance_policy}
    {qualification_key}
    "fem_execution_mode": "{fem_execution_mode}",
{gpu_provenance_policy}
    "uses_cuda_kernels": {uses_cuda_kernels},
    "uses_gpu_poisson": {uses_gpu_poisson},
    "hot_loop_exchange_host_sync_count": 0,
    "hot_loop_compute_host_sync_count": 3
  }}{cpu_qualification}{gpu_qualification}
}}
""",
        encoding="utf-8",
    )
    rows = [
        "step,time,solver_dt,mx,my,mz,E_ex,E_demag,E_ext,E_ani,E_dmi,E_total,"
        "max_dm_dt,max_h_eff,max_h_demag,max_torque_Apm,max_torque_T"
    ]
    for index, energy, torque in zip(steps, energies, torques):
        rows.append(
            f"{index},0.0,1.0e-6,0.0,0.0,1.0,0.0,0.0,0.0,0.0,0.0,{energy:.15e},"
            f"0.0,1.0,0.0,{torque:.15e},{torque:.15e}"
        )
    (artifact_dir / "scalars.csv").write_text("\n".join(rows) + "\n", encoding="utf-8")


def run_validator(
    log_text: str,
    algorithm: str = "nonlinear_cg",
    energies: list[float] | None = None,
    steps: list[int] | None = None,
    torques: list[float] | None = None,
    gpu_status: str = "production_executable",
    engine: str = "gpu",
    include_cpu_qualification: bool = True,
    include_cpu_algorithm_policy: bool = True,
    include_cpu_algorithm_update_policy: bool = True,
    include_gpu_qualification: bool = True,
    include_gpu_gradient_policy: bool = True,
    include_gpu_norm_defect: bool = True,
    cpu_norm_defect: float = 0.0,
    gpu_norm_defect: float = 0.0,
    cpu_line_search: str | None = None,
    gpu_provenance_exchange_operator_mode: str = "legacy_sparse_gpu",
    validator_extra_args: list[str] | None = None,
) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as tmp:
        artifact_dir = Path(tmp) / "artifacts"
        write_artifacts(
            artifact_dir,
            algorithm=algorithm,
            energies=energies,
            steps=steps,
            torques=torques,
            gpu_status=gpu_status,
            engine=engine,
            include_cpu_qualification=include_cpu_qualification,
            include_cpu_algorithm_policy=include_cpu_algorithm_policy,
            include_cpu_algorithm_update_policy=include_cpu_algorithm_update_policy,
            include_gpu_qualification=include_gpu_qualification,
            include_gpu_gradient_policy=include_gpu_gradient_policy,
            include_gpu_norm_defect=include_gpu_norm_defect,
            cpu_norm_defect=cpu_norm_defect,
            gpu_norm_defect=gpu_norm_defect,
            cpu_line_search=cpu_line_search,
            gpu_provenance_exchange_operator_mode=gpu_provenance_exchange_operator_mode,
        )
        log_text = log_text.replace("__ARTIFACT_DIR__", str(artifact_dir))
        log_path = Path(tmp) / "runtime.log"
        log_path.write_text(log_text, encoding="utf-8")
        command = [
                "python3",
                str(VALIDATOR),
                "--engine",
                engine,
                "--algorithm",
                algorithm,
                "--min-steps",
                "4",
                str(log_path),
            ]
        if validator_extra_args:
            command[2:2] = validator_extra_args
        return subprocess.run(
            command,
            cwd=REPO_ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )


def valid_log() -> str:
    return """
[fullmag-runner] live FEM engine: resolved_engine_id=fem_native_gpu fallback=None
info: native FEM backend active: engine=fem_native_gpu device='NVIDIA GeForce RTX 4080 SUPER'
{
  "problem_name": "fem_relax_gpu_smoke_nonlinear_cg",
  "status": "completed",
  "backend": "fem",
  "mode": "strict",
  "precision": "double",
  "total_steps": 4,
  "final_time": 0.0,
  "final_e_total": 1.0e-17,
  "artifact_dir": "__ARTIFACT_DIR__"
}
"""


def valid_log_with_final_energy(final_energy: float) -> str:
    return valid_log().replace('"final_e_total": 1.0e-17', f'"final_e_total": {final_energy:.15e}')


def valid_gpu_log(algorithm: str = "nonlinear_cg") -> str:
    return valid_log().replace(
        "fem_relax_gpu_smoke_nonlinear_cg",
        f"fem_relax_gpu_smoke_{algorithm}",
    )


def valid_cpu_log(algorithm: str = "nonlinear_cg") -> str:
    mode = "extended" if algorithm == "tangent_plane_implicit" else "strict"
    return f"""
[fullmag-runner] live FEM engine: resolved_engine_id=fem_cpu_native fallback=None
info: native FEM backend active: engine=fem_cpu_native
{{
  "problem_name": "fem_relax_gpu_smoke_{algorithm}",
  "status": "completed",
  "backend": "fem",
  "mode": "{mode}",
  "precision": "double",
  "total_steps": 4,
  "final_time": 0.0,
  "final_e_total": 1.0e-17,
  "artifact_dir": "__ARTIFACT_DIR__"
}}
"""


def test_accepts_completed_native_gpu_log() -> None:
    result = run_validator(valid_log())
    assert result.returncode == 0, result.stderr
    assert "validated gpu nonlinear_cg" in result.stdout


def test_accepts_completed_native_cpu_log() -> None:
    result = run_validator(valid_cpu_log(), engine="cpu")
    assert result.returncode == 0, result.stderr
    assert "validated cpu nonlinear_cg" in result.stdout


def test_accepts_completed_native_cpu_tpi_log() -> None:
    result = run_validator(
        valid_cpu_log("tangent_plane_implicit"),
        algorithm="tangent_plane_implicit",
        engine="cpu",
    )
    assert result.returncode == 0, result.stderr
    assert "validated cpu tangent_plane_implicit" in result.stdout


def test_rejects_native_cpu_tpi_in_strict_mode() -> None:
    log_text = valid_cpu_log("tangent_plane_implicit").replace(
        '"mode": "extended"',
        '"mode": "strict"',
    )
    result = run_validator(
        log_text,
        algorithm="tangent_plane_implicit",
        engine="cpu",
    )
    assert result.returncode != 0
    assert "mode" in result.stderr


def test_rejects_production_relaxation_algorithms_in_extended_mode() -> None:
    for algorithm in ("llg_overdamped", "projected_gradient_bb", "nonlinear_cg"):
        log_text = valid_cpu_log(algorithm).replace(
            '"mode": "strict"',
            '"mode": "extended"',
        )
        result = run_validator(log_text, algorithm=algorithm, engine="cpu")
        assert result.returncode != 0, algorithm
        assert "mode" in result.stderr, (algorithm, result.stderr)


def test_rejects_failed_status() -> None:
    log_text = valid_log().replace('"status": "completed"', '"status": "failed"')
    result = run_validator(log_text)
    assert result.returncode != 0
    assert "status" in result.stderr


def test_rejects_cpu_fallback() -> None:
    log_text = valid_log().replace(
        "resolved_engine_id=fem_native_gpu fallback=None",
        "resolved_engine_id=fem_cpu_native fallback=Some(fem_gpu_relaxation_algorithm_cpu_only)",
    )
    result = run_validator(log_text)
    assert result.returncode != 0
    assert "fem_native_gpu" in result.stderr or "fallback" in result.stderr


def test_rejects_direct_minimizer_without_production_gpu_status() -> None:
    result = run_validator(valid_log(), gpu_status="source_visible")
    assert result.returncode != 0
    assert "production_executable" in result.stderr


def test_rejects_direct_minimizer_energy_increase() -> None:
    result = run_validator(valid_log(), energies=[4.0e-17, 3.0e-17, 3.5e-17, 1.0e-17])
    assert result.returncode != 0
    assert "E_total" in result.stderr


def test_rejects_llg_overdamped_energy_increase() -> None:
    result = run_validator(
        valid_gpu_log("llg_overdamped"),
        algorithm="llg_overdamped",
        energies=[4.0e-17, 3.0e-17, 3.5e-17, 1.0e-17],
    )
    assert result.returncode != 0
    assert "E_total" in result.stderr


def test_rejects_relaxation_without_meaningful_energy_decrease() -> None:
    final_energy = 3.99997e-17
    result = run_validator(
        valid_log_with_final_energy(final_energy),
        energies=[4.0e-17, 3.99999e-17, 3.99998e-17, final_energy],
    )
    assert result.returncode != 0
    assert "relative decrease" in result.stderr
    assert "E_total" in result.stderr


def test_stricter_convergence_threshold_rejects_weak_energy_decrease() -> None:
    final_energy = 3.4e-17
    result = run_validator(
        valid_log_with_final_energy(final_energy),
        energies=[4.0e-17, 3.8e-17, 3.6e-17, final_energy],
        validator_extra_args=["--min-relative-energy-decrease", "0.20"],
    )
    assert result.returncode != 0
    assert "relative decrease" in result.stderr
    assert "2.000000e-01" in result.stderr


def test_rejects_relaxation_with_large_final_torque_growth() -> None:
    result = run_validator(
        valid_log(),
        energies=[4.0e-17, 3.0e-17, 2.0e-17, 1.0e-17],
        torques=[1.0, 1.2, 1.6, 2.0],
    )
    assert result.returncode != 0
    assert "max_torque_T" in result.stderr
    assert "growth" in result.stderr


def test_rejects_scalars_with_noncontiguous_step_sequence() -> None:
    result = run_validator(valid_log(), steps=[1, 2, 2, 4])
    assert result.returncode != 0
    assert "step" in result.stderr


def test_accepts_runtime_with_more_scalar_rows_than_minimum() -> None:
    final_energy = 5.0e-18
    result = run_validator(
        valid_log_with_final_energy(final_energy),
        energies=[4.0e-17, 3.0e-17, 2.0e-17, 1.0e-17, final_energy],
    )
    assert result.returncode == 0, result.stderr


def test_rejects_summary_final_energy_that_disagrees_with_scalars() -> None:
    result = run_validator(valid_log_with_final_energy(9.0e-17))
    assert result.returncode != 0
    assert "final_e_total" in result.stderr
    assert "scalars.csv" in result.stderr


def test_rejects_native_cpu_log_without_relaxation_qualification() -> None:
    result = run_validator(valid_cpu_log(), engine="cpu", include_cpu_qualification=False)
    assert result.returncode != 0
    assert "fem_cpu_relaxation_qualification" in result.stderr


def test_rejects_cpu_llg_without_algorithm_policy() -> None:
    result = run_validator(
        valid_cpu_log("llg_overdamped"),
        algorithm="llg_overdamped",
        engine="cpu",
        include_cpu_algorithm_policy=False,
    )
    assert result.returncode != 0
    assert "algorithm_policy" in result.stderr
    assert "llg_overdamped" in result.stderr


def test_rejects_gpu_direct_minimizer_without_relaxation_qualification() -> None:
    result = run_validator(valid_log(), include_gpu_qualification=False)
    assert result.returncode != 0
    assert "fem_gpu_relaxation_qualification" in result.stderr


def test_rejects_gpu_llg_without_relaxation_qualification() -> None:
    result = run_validator(
        valid_gpu_log("llg_overdamped"),
        algorithm="llg_overdamped",
        include_gpu_qualification=False,
    )
    assert result.returncode != 0
    assert "fem_gpu_relaxation_qualification" in result.stderr


def test_rejects_gpu_direct_minimizer_without_gradient_policy() -> None:
    result = run_validator(valid_log(), include_gpu_gradient_policy=False)
    assert result.returncode != 0
    assert "gradient_policy" in result.stderr
    assert "device_tangent_gradient" in result.stderr


def test_rejects_gpu_qualification_that_disagrees_with_provenance() -> None:
    result = run_validator(
        valid_log(),
        gpu_provenance_exchange_operator_mode="legacy_sparse_cpu_shadow",
    )
    assert result.returncode != 0
    assert "fem_exchange_operator_mode" in result.stderr
    assert "legacy_sparse_gpu" in result.stderr


def test_rejects_cpu_projected_gradient_bb_with_nonlinear_cg_line_search() -> None:
    result = run_validator(
        valid_cpu_log("projected_gradient_bb"),
        algorithm="projected_gradient_bb",
        engine="cpu",
        cpu_line_search="native_armijo_backtracking_pr_plus_restart",
    )
    assert result.returncode != 0
    assert "line_search" in result.stderr
    assert "native_armijo_backtracking_bb1_bb2" in result.stderr


def test_rejects_cpu_projected_gradient_bb_without_step_update_policy() -> None:
    result = run_validator(
        valid_cpu_log("projected_gradient_bb"),
        algorithm="projected_gradient_bb",
        engine="cpu",
        include_cpu_algorithm_update_policy=False,
    )
    assert result.returncode != 0
    assert "step_update" in result.stderr
    assert "alternating_bb1_bb2" in result.stderr


def test_rejects_cpu_nonlinear_cg_without_direction_update_policy() -> None:
    result = run_validator(
        valid_cpu_log("nonlinear_cg"),
        algorithm="nonlinear_cg",
        engine="cpu",
        include_cpu_algorithm_update_policy=False,
    )
    assert result.returncode != 0
    assert "direction_update" in result.stderr
    assert "polak_ribiere_plus_projected_restart" in result.stderr


def test_rejects_cpu_relaxation_with_large_magnetization_norm_defect() -> None:
    result = run_validator(
        valid_cpu_log("nonlinear_cg"),
        algorithm="nonlinear_cg",
        engine="cpu",
        cpu_norm_defect=1.0e-2,
    )
    assert result.returncode != 0
    assert "norm_defect" in result.stderr


def test_rejects_gpu_relaxation_without_magnetization_norm_defect() -> None:
    result = run_validator(
        valid_gpu_log("nonlinear_cg"),
        algorithm="nonlinear_cg",
        engine="gpu",
        include_gpu_norm_defect=False,
    )
    assert result.returncode != 0
    assert "norm_defect" in result.stderr


def test_zhang_li_gate_preserves_each_run_in_a_distinct_explicit_bundle() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    validator = ZHANG_LI_VALIDATOR.read_text(encoding="utf-8")
    zhang_li_recipe = just_recipe_source(
        justfile,
        "verify-fem-zhang-li-skew-tetra-runtime",
    )

    assert 'fem-managed-headless fem_execution script output_dir="":' in justfile
    assert '--output-dir "$output_dir"' in justfile
    assert '--workspace-root "$output_dir/workspace-history"' in justfile
    assert zhang_li_recipe.count("mktemp -d") == 10
    assert zhang_li_recipe.count("just fem-managed-headless") == 10
    assert "zip(dt_runs, (32, 64, 128), strict=True)" in validator


def test_runtime_gate_and_physics_note_promote_cpu_tpi_without_gpu_claim() -> None:
    verify_source = VERIFY_RUNTIME.read_text(encoding="utf-8")
    justfile = JUSTFILE.read_text(encoding="utf-8")
    physics_note = FEM_RELAXATION_NOTE.read_text(encoding="utf-8")
    normalized_physics_note = " ".join(physics_note.split())

    assert (
        'algorithms="${FULLMAG_FEM_RELAXATION_ALGORITHMS:-llg_overdamped '
        'projected_gradient_bb nonlinear_cg tangent_plane_implicit}"'
    ) in verify_source
    assert (
        'min_relative_energy_decrease="${FULLMAG_FEM_RELAXATION_MIN_RELATIVE_ENERGY_DECREASE:-1e-3}"'
        in verify_source
    )
    assert (
        'max_torque_growth="${FULLMAG_FEM_RELAXATION_MAX_FINAL_TORQUE_GROWTH_FACTOR:-2.0}"'
        in verify_source
    )
    assert "--min-relative-energy-decrease" in verify_source
    assert "--max-final-torque-growth-factor" in verify_source
    assert "FULLMAG_FEM_RELAXATION_KEEP_LOGS" in verify_source
    assert "preserving runtime logs" in verify_source
    assert "just verify-fem-relaxation-source-contract" in verify_source
    assert 'just fem-managed-container-headless "$engine" "$script"' in verify_source
    assert 'just fem-managed-headless "$engine" "$script"' not in verify_source
    assert "just fem-gpu-headless" not in verify_source
    assert (
        "supported: llg_overdamped projected_gradient_bb nonlinear_cg tangent_plane_implicit"
        in verify_source
    )
    assert "skip unsupported FEM gpu smoke: tangent_plane_implicit" in verify_source

    assert "verify-fem-relaxation-source-contract:" in justfile
    assert "cmake --build native/build --target fem_relaxation_source_contract" in justfile
    assert "native/build/backends/fem/fem_relaxation_source_contract" in justfile
    assert "verify-fem-relaxation-convergence:" in justfile
    assert "verify-fem-relaxation-cpu-gpu-consistency-smoke:" in justfile
    assert "verify-fem-relaxation-production-benchmark:" in justfile
    assert "verify-fem-gpu-demag-performance-benchmark:" in justfile
    assert "bench-fem-gpu-demag-amg-profile-sweep:" in justfile
    consistency_recipe = just_recipe_source(
        justfile,
        "verify-fem-relaxation-cpu-gpu-consistency-smoke",
    )
    production_recipe = just_recipe_source(
        justfile,
        "verify-fem-relaxation-production-benchmark",
    )
    demag_performance_recipe = just_recipe_source(
        justfile,
        "verify-fem-gpu-demag-performance-benchmark",
    )
    amg_profile_sweep_recipe = just_recipe_source(
        justfile,
        "bench-fem-gpu-demag-amg-profile-sweep",
    )
    for recipe in [consistency_recipe, production_recipe, demag_performance_recipe]:
        assert "docker compose --profile fem-gpu run --rm" in recipe
        assert "cd /workspace" in recipe
        assert "python3 scripts/analysis/fem_gpu_benchmark.py" in recipe
        assert "PYTHONPATH=/workspace/packages/fullmag-py/src" in recipe
        assert ".fullmag/reports/" in recipe
    for env_name in [
        "FULLMAG_BENCH_INTEGRATORS",
        "FULLMAG_BENCH_RELAX_ALGORITHMS",
        "FULLMAG_BENCH_STEPS",
        "FULLMAG_BENCH_CASE_TIMEOUT_S",
        "FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL",
        "FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J",
        "FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL",
        "FULLMAG_BENCH_OUTPUT",
        "FULLMAG_BENCH_SUMMARY",
    ]:
        assert f"-e {env_name}=" in production_recipe
    assert "fem-managed-container-headless fem_execution script:" in justfile
    assert "docker compose --profile fem-gpu run --rm" in justfile
    assert ".fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu" in justfile
    assert "--box500-airbox-exchange-only-preset" in justfile
    assert "--box500-airbox-interaction-consistency-preset" in justfile
    assert "--require-cpu-gpu-consistency" in justfile
    assert "--require-gpu-phase-timings" in demag_performance_recipe
    assert "--require-min-solver-nodes" in demag_performance_recipe
    assert "--demag-convergence-max-iterations" in production_recipe
    assert "--demag-convergence-max-iterations" in demag_performance_recipe
    assert "--require-demag-setup-reused" in production_recipe
    assert "--require-demag-setup-reused" in demag_performance_recipe
    assert "--max-demag-solver-apply-ms" in production_recipe
    assert "--max-demag-solver-apply-ms" in demag_performance_recipe
    assert "FULLMAG_BENCH_DEMAG_CONVERGENCE_MAX_ITERATIONS" in production_recipe
    assert "FULLMAG_BENCH_DEMAG_CONVERGENCE_MAX_ITERATIONS" in demag_performance_recipe
    assert "FULLMAG_BENCH_MAX_DEMAG_SOLVER_APPLY_MS" in production_recipe
    assert "FULLMAG_BENCH_MAX_DEMAG_SOLVER_APPLY_MS" in demag_performance_recipe
    assert "FULLMAG_BENCH_BEST_DEMAG_POLICY_METRIC" in production_recipe
    assert "FULLMAG_BENCH_BEST_DEMAG_POLICY_METRIC" in demag_performance_recipe
    assert "--best-demag-policy-metric" in production_recipe
    assert "--best-demag-policy-metric" in demag_performance_recipe
    for env_name, cli_flag in [
        ("FULLMAG_BENCH_DEMAG_AMG_RELAX_TYPES", "--demag-amg-relax-types"),
        ("FULLMAG_BENCH_DEMAG_AMG_COARSENINGS", "--demag-amg-coarsenings"),
        ("FULLMAG_BENCH_DEMAG_AMG_INTERPOLATIONS", "--demag-amg-interpolations"),
        (
            "FULLMAG_BENCH_DEMAG_AMG_AGGRESSIVE_COARSENINGS",
            "--demag-amg-aggressive-coarsenings",
        ),
        (
            "FULLMAG_BENCH_DEMAG_AMG_STRENGTH_THRESHOLDS",
            "--demag-amg-strength-thresholds",
        ),
        ("FULLMAG_BENCH_DEMAG_AMG_MAX_LEVELS", "--demag-amg-max-levels"),
    ]:
        assert env_name in production_recipe
        assert env_name in demag_performance_recipe
        assert cli_flag in production_recipe
        assert cli_flag in demag_performance_recipe
        assert env_name in amg_profile_sweep_recipe
        assert cli_flag in amg_profile_sweep_recipe
    assert "docker compose --profile fem-gpu run --rm" in amg_profile_sweep_recipe
    assert "python3 scripts/analysis/fem_gpu_benchmark.py" in amg_profile_sweep_recipe
    assert "FULLMAG_BENCH_DEMAG_AMG_RELAX_TYPES:-18,6" in amg_profile_sweep_recipe
    assert "--emit-best-demag-policy" in amg_profile_sweep_recipe
    assert "--best-demag-policy-metric" in amg_profile_sweep_recipe
    assert "--human-report-output" in amg_profile_sweep_recipe
    assert "--require-best-demag-policy" not in amg_profile_sweep_recipe
    assert "--require-demag-converged" not in amg_profile_sweep_recipe
    assert "--require-demag-setup-reused" not in amg_profile_sweep_recipe
    assert "--require-cpu-gpu-consistency" not in amg_profile_sweep_recipe
    assert "--max-demag-solver-apply-ms" not in amg_profile_sweep_recipe
    assert "FULLMAG_BENCH_DEMAG_RTOLS" in demag_performance_recipe
    assert "--demag-rtols" in demag_performance_recipe
    assert "FULLMAG_BENCH_MESHES" in demag_performance_recipe
    assert "FULLMAG_BENCH_MESHES" in amg_profile_sweep_recipe
    assert '--meshes "$FULLMAG_BENCH_MESHES"' in demag_performance_recipe
    assert '--meshes "$FULLMAG_BENCH_MESHES"' in amg_profile_sweep_recipe
    assert "--reuse-generated-domain-mesh" in production_recipe
    assert "--reuse-generated-domain-mesh" in demag_performance_recipe
    assert "--reuse-generated-domain-mesh" in amg_profile_sweep_recipe
    assert "FULLMAG_BENCH_DOMAIN_MESH_CACHE_DIR" in production_recipe
    assert "FULLMAG_BENCH_DOMAIN_MESH_CACHE_DIR" in demag_performance_recipe
    assert "FULLMAG_BENCH_DOMAIN_MESH_CACHE_DIR" in amg_profile_sweep_recipe
    assert "--generated-domain-mesh-cache-dir" in production_recipe
    assert "--generated-domain-mesh-cache-dir" in demag_performance_recipe
    assert "--generated-domain-mesh-cache-dir" in amg_profile_sweep_recipe
    assert (
        'FULLMAG_BENCH_RELAX_ALGORITHMS:-llg_overdamped,projected_gradient_bb,nonlinear_cg'
        in demag_performance_recipe
    )
    assert "FULLMAG_BENCH_GPU_PGBB_CONTROL_READBACK_PER_STEP" in demag_performance_recipe
    assert "--gpu-pgbb-control-readback-per-step" in demag_performance_recipe
    assert "--max-performance-regression-percent" in demag_performance_recipe
    assert "--relax-algorithms" in justfile
    assert (
        'FULLMAG_BENCH_RELAX_ALGORITHMS:-llg_overdamped,projected_gradient_bb,nonlinear_cg'
        in justfile
    )
    assert ".fullmag/reports/fullmag_relaxation_production_benchmark.csv" in justfile
    assert ".fullmag/reports/fullmag_relaxation_production_benchmark_summary.json" in justfile
    assert 'FULLMAG_RELAX_MAX_STEPS="${FULLMAG_RELAX_MAX_STEPS:-16}"' in justfile
    assert '-e FULLMAG_RELAX_DEVICE="${FULLMAG_RELAX_DEVICE:-gpu}"' in justfile
    assert '-e FULLMAG_RELAX_MAX_STEPS="${FULLMAG_RELAX_MAX_STEPS:-4}"' in justfile
    assert '-e FULLMAG_RELAX_MAX_STEPS="${FULLMAG_RELAX_MAX_STEPS:-}"' not in justfile
    assert (
        'FULLMAG_FEM_RELAXATION_MIN_RELATIVE_ENERGY_DECREASE="${FULLMAG_FEM_RELAXATION_MIN_RELATIVE_ENERGY_DECREASE:-1e-2}"'
        in justfile
    )
    assert "`just verify-fem-relaxation-convergence`" in physics_note
    assert "`just verify-fem-relaxation-cpu-gpu-consistency-smoke`" in physics_note
    assert "`just verify-fem-relaxation-production-benchmark`" in physics_note
    assert "FULLMAG_FEM_RELAXATION_KEEP_LOGS=1" in physics_note

    assert "Current production-executable subset" in physics_note
    assert 'algorithm = "llg_overdamped"' in normalized_physics_note
    assert 'algorithm = "projected_gradient_bb"' in normalized_physics_note
    assert 'algorithm = "nonlinear_cg"' in normalized_physics_note
    assert (
        '`algorithm = "tangent_plane_implicit"` remains under development'
    ) in physics_note
    assert "four algorithms are public-executable" not in normalized_physics_note
    assert "- [x] FEM backend (`tangent_plane_implicit` native CPU/MFEM" in physics_note
    assert "- [ ] FEM backend (`tangent_plane_implicit` full GPU/libCEED" in physics_note
    assert (
        "- [x] Broader interaction-matrix CPU/GPU benchmark gate is wired for current LLG/PG-BB/NCG production lanes"
        in physics_note
    )
    assert (
        "- [x] Broader interaction-matrix CPU/GPU benchmark pass for current LLG/PG-BB/NCG production lanes"
        in physics_note
    )


def test_cpu_gpu_consistency_smoke_covers_active_relaxation_algorithms() -> None:
    benchmark_source = (
        REPO_ROOT / "scripts" / "analysis" / "fem_gpu_benchmark.py"
    ).read_text(encoding="utf-8")
    benchmark_case = (REPO_ROOT / "examples" / "bench_fem_gpu_long.py").read_text(
        encoding="utf-8"
    )
    justfile = JUSTFILE.read_text(encoding="utf-8")

    assert "--relax-algorithms" in benchmark_source
    assert "resolve_relaxation_algorithms(" in benchmark_source
    assert "FULLMAG_BENCH_RELAX_ALGORITHM" in benchmark_source
    assert "reported_relaxation_algorithm" in benchmark_source
    assert "relaxation_algorithm" in benchmark_source
    assert "row.get(\"reported_relaxation_algorithm\")" in benchmark_source

    assert "SUPPORTED_RELAXATION_ALGORITHMS" in benchmark_case
    assert "def env_relaxation_algorithm()" in benchmark_case
    assert "FULLMAG_BENCH_RELAX_ALGORITHM" in benchmark_case
    assert 'algorithm="llg_overdamped"' not in benchmark_case

    assert "--relax-algorithms" in justfile
    assert (
        'FULLMAG_BENCH_RELAX_ALGORITHMS:-llg_overdamped,projected_gradient_bb,nonlinear_cg'
        in justfile
    )


def test_cpu_gpu_consistency_coverage_is_per_relaxation_algorithm() -> None:
    benchmark = load_benchmark_module()
    algorithms = [
        "llg_overdamped",
        "projected_gradient_bb",
        "nonlinear_cg",
        "tangent_plane_implicit",
    ]
    manifests = benchmark.cpu_gpu_case_manifests(
        scenarios=[benchmark.BOX500_AIRBOX_SCENARIO],
        relaxation_algorithms=algorithms,
        steps=16,
        dt=1.0e-13,
        energy_rtol=1.0e-6,
        energy_atol=1.0e-30,
        torque_rtol=1.0e-6,
        torque_atol_apm=1.0e-9,
        torque_atol_t=1.0e-15,
        max_step_delta=0,
    )
    assert [manifest["relaxation_algorithm"] for manifest in manifests] == algorithms
    by_manifest_algorithm = {
        manifest["relaxation_algorithm"]: manifest for manifest in manifests
    }
    assert by_manifest_algorithm["tangent_plane_implicit"]["required_backends"] == [
        "fem_cpu"
    ]
    assert by_manifest_algorithm["nonlinear_cg"]["required_backends"] == [
        "fem_cpu",
        "fem_gpu",
    ]

    rows: list[dict[str, object]] = []
    for algorithm in algorithms:
        for backend in (
            ["fem_cpu"]
            if algorithm == "tangent_plane_implicit"
            else ["fem_cpu", "fem_gpu"]
        ):
            rows.append(
                {
                    "backend": backend,
                    "status": "ok",
                    "scenario": benchmark.BOX500_AIRBOX_SCENARIO,
                    "integrator": "heun",
                    "relaxation_algorithm": algorithm,
                    "reported_relaxation_algorithm": algorithm,
                    "timestep_policy": "fixed",
                    "dt_s": 1.0e-13,
                    "steps": 16,
                    "reported_precision": "double",
                    "solver_mesh_signature": "mesh-a",
                    "execution_engine": (
                        "fem_cpu_native" if backend == "fem_cpu" else "fem_native_gpu"
                    ),
                    "fem_execution_mode": (
                        "cpu_native" if backend == "fem_cpu" else "all_in_gpu_legacy_sparse"
                    ),
                    "mfem_device": "cpu" if backend == "fem_cpu" else "cuda",
                    "uses_cuda_kernels": backend == "fem_gpu",
                    "executed_steps": 0,
                    "final_e_total_j": -1.0,
                    "final_e_ex_j": -1.0,
                    "final_torque_apm": 0.0,
                    "final_torque_t": 0.0,
                }
            )

    coverage = benchmark.cpu_gpu_required_case_coverage(
        rows,
        case_manifests=manifests,
    )
    assert [(case["case_id"], case["relaxation_algorithm"]) for case in coverage] == [
        (benchmark.BOX500_AIRBOX_SCENARIO, algorithm) for algorithm in algorithms
    ]
    by_algorithm = {case["relaxation_algorithm"]: case for case in coverage}
    assert all(
        by_algorithm[algorithm]["status"] == "pass"
        and by_algorithm[algorithm]["pair_count"] == 1
        for algorithm in ["llg_overdamped", "projected_gradient_bb", "nonlinear_cg"]
    )
    assert by_algorithm["tangent_plane_implicit"]["status"] == "pass"
    assert by_algorithm["tangent_plane_implicit"]["required_backends"] == ["fem_cpu"]
    assert by_algorithm["tangent_plane_implicit"]["pair_count"] == 0
    assert by_algorithm["tangent_plane_implicit"]["gpu_ok_count"] == 0

    rows = [
        row
        for row in rows
        if not (
            row["backend"] == "fem_gpu"
            and row["relaxation_algorithm"] == "nonlinear_cg"
        )
    ]
    coverage = benchmark.cpu_gpu_required_case_coverage(
        rows,
        case_manifests=manifests,
    )
    by_algorithm = {case["relaxation_algorithm"]: case for case in coverage}
    assert by_algorithm["llg_overdamped"]["status"] == "pass"
    assert by_algorithm["projected_gradient_bb"]["status"] == "pass"
    assert by_algorithm["nonlinear_cg"]["status"] == "fail"
    assert by_algorithm["tangent_plane_implicit"]["status"] == "pass"
    assert "nonlinear_cg has no completed fem_gpu row" in " ".join(
        by_algorithm["nonlinear_cg"]["failures"]
    )


def test_demag_apply_budget_gate_flags_slow_single_solve_rows() -> None:
    benchmark = load_benchmark_module()
    rows = [
        {
            "backend": "fem_gpu",
            "scenario": "box500_airbox_exchange_demag",
            "status": "ok",
            "demag_solver_apply_wall_time_ms": 20_370.0,
        },
        {
            "backend": "fem_gpu",
            "scenario": "box500_airbox_exchange_only",
            "status": "ok",
            "demag_solver_apply_wall_time_ms": 99_000.0,
        },
    ]

    failures = benchmark.demag_solver_apply_budget_failures(
        rows,
        max_apply_ms=5_000.0,
    )

    assert len(failures) == 1
    assert "demag_solver_apply_wall_time_ms=20370" in failures[0]
    assert "exceeds 5000" in failures[0]


def test_demag_setup_reuse_gate_flags_multi_step_rebuilds() -> None:
    benchmark = load_benchmark_module()
    rows = [
        {
            "backend": "fem_gpu",
            "scenario": "box500_airbox_exchange_demag",
            "status": "ok",
            "steps": 2,
            "executed_steps": 2,
            "demag_solver_setup_reused": False,
        },
        {
            "backend": "fem_gpu",
            "scenario": "box500_airbox_exchange_demag",
            "status": "ok",
            "steps": 1,
            "executed_steps": 1,
            "demag_solver_setup_reused": False,
        },
        {
            "backend": "fem_gpu",
            "scenario": "box500_airbox_exchange_only",
            "status": "ok",
            "steps": 2,
            "executed_steps": 2,
            "demag_solver_setup_reused": False,
        },
    ]

    failures = benchmark.demag_setup_reuse_failures(rows)

    assert len(failures) == 1
    assert "demag_solver_setup_reused is not true" in failures[0]


def test_demag_setup_reuse_gate_requires_telemetry_for_multi_step_demag() -> None:
    benchmark = load_benchmark_module()
    rows = [
        {
            "backend": "fem_gpu",
            "scenario": "box500_airbox_exchange_demag",
            "status": "ok",
            "steps": 2,
            "executed_steps": 2,
        }
    ]

    failures = benchmark.demag_setup_reuse_failures(rows)

    assert len(failures) == 1
    assert "missing demag_solver_setup_reused" in failures[0]


def test_gpu_ncg_endpoint_reuse_gate_requires_one_steady_demag_solve() -> None:
    benchmark = load_benchmark_module()
    good = {
        "backend": "fem_gpu",
        "scenario": "box500_airbox_exchange_demag",
        "relaxation_algorithm": "nonlinear_cg",
        "status": "ok",
        "executed_steps": 32,
        "rhs_evals": 1,
        "demag_solves": 1,
    }

    assert benchmark.gpu_ncg_accepted_endpoint_reuse_failures([good]) == []
    failures = benchmark.gpu_ncg_accepted_endpoint_reuse_failures(
        [{**good, "demag_solves": 2}]
    )
    assert len(failures) == 1
    assert "steady accepted step requires demag_solves=1" in failures[0]
    assert benchmark.gpu_ncg_accepted_endpoint_reuse_failures(
        [{**good, "rhs_evals": 2, "demag_solves": 2}]
    ) == []


def test_gpu_demag_single_setup_gate_requires_zero_step_setup_and_derived_reuse() -> None:
    benchmark = load_benchmark_module()
    good = {
        "backend": "fem_gpu",
        "scenario": "box500_airbox_exchange_demag",
        "status": "ok",
        "executed_steps": 32,
        "demag_solver_setup_wall_time_ms": 0.0,
        "demag_solver_setup_reused": True,
    }

    assert benchmark.gpu_demag_single_setup_failures([good]) == []
    assert benchmark.gpu_demag_single_setup_failures(
        [{**good, "demag_solver_setup_wall_time_ms": 0.25}]
    )
    assert benchmark.gpu_demag_single_setup_failures(
        [{**good, "demag_solver_setup_reused": False}]
    )


def test_gpu_zero_global_sync_gate_uses_strict_compute_sync_audit() -> None:
    benchmark = load_benchmark_module()
    good = {
        "backend": "fem_gpu",
        "scenario": "box500_airbox_exchange_demag",
        "status": "ok",
        "hot_loop_compute_host_sync_count": 0,
    }

    assert benchmark.gpu_zero_global_sync_failures([good]) == []
    failures = benchmark.gpu_zero_global_sync_failures(
        [{**good, "hot_loop_compute_host_sync_count": 1}]
    )
    assert len(failures) == 1
    assert "requires hot_loop_compute_host_sync_count=0" in failures[0]


def test_demag_policy_selection_key_separates_relaxation_algorithms() -> None:
    benchmark = load_benchmark_module()
    base_row = {
        "backend": "fem_gpu",
        "mesh_path": "mesh.json",
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "timestep_policy": "fixed",
        "dt_s": 1e-13,
        "steps": 4,
        "requested_cpu_thread_spec": "auto",
        "requested_demag_relative_tolerance": 1e-8,
        "requested_demag_absolute_tolerance": None,
        "requested_demag_max_iterations": 500,
        "requested_demag_print_level": 0,
    }

    pgbb_key = benchmark.demag_policy_selection_case_key(
        {**base_row, "relaxation_algorithm": "projected_gradient_bb"}
    )
    ncg_key = benchmark.demag_policy_selection_case_key(
        {**base_row, "relaxation_algorithm": "nonlinear_cg"}
    )

    assert pgbb_key != ncg_key


def test_benchmark_shared_domain_reuse_classifies_demag_scenarios() -> None:
    benchmark = load_benchmark_module()

    assert benchmark.benchmark_scenario_requires_shared_domain(
        "box500_airbox_exchange_demag"
    )
    assert benchmark.benchmark_scenario_requires_shared_domain("exchange_demag")
    assert not benchmark.benchmark_scenario_requires_shared_domain("exchange_only")


def test_demag_rtol_sweep_parser_preserves_unique_positive_tolerances() -> None:
    benchmark = load_benchmark_module()

    assert benchmark.resolve_demag_rtols("1e-8,1e-6,1e-6", 1e-8) == [
        1e-8,
        1e-6,
    ]
    assert benchmark.resolve_demag_rtols(None, 1e-7) == [1e-7]


def test_demag_amg_profile_sweep_parser_and_policy_identity() -> None:
    benchmark = load_benchmark_module()

    profiles = [
        (relax_type, 8, 6, 1, None, None)
        for relax_type in benchmark.resolve_nonnegative_ints("18,18,6", 18)
    ]

    assert profiles == [(18, 8, 6, 1, None, None), (6, 8, 6, 1, None, None)]
    assert benchmark.demag_amg_profiles_for_preconditioner("AMG", profiles) == profiles
    assert benchmark.demag_amg_profiles_for_preconditioner("OMIT", profiles) == profiles
    assert benchmark.demag_amg_profiles_for_preconditioner("JACOBI", profiles) == [
        (
            benchmark.DEFAULT_DEMAG_AMG_RELAX_TYPE,
            benchmark.DEFAULT_DEMAG_AMG_COARSENING,
            benchmark.DEFAULT_DEMAG_AMG_INTERPOLATION,
            benchmark.DEFAULT_DEMAG_AMG_AGGRESSIVE_COARSENING,
            benchmark.DEFAULT_DEMAG_AMG_STRENGTH_THRESHOLD,
            benchmark.DEFAULT_DEMAG_AMG_MAX_LEVELS,
        )
    ]

    first = {
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
        "requested_demag_amg_relax_type": "18",
        "requested_demag_amg_coarsening": "8",
        "requested_demag_amg_interpolation": "6",
        "requested_demag_amg_aggressive_coarsening": "1",
        "requested_demag_amg_strength_threshold": "",
        "requested_demag_amg_max_levels": "",
    }
    second = {**first, "requested_demag_amg_relax_type": "6"}
    third = {**first, "requested_demag_amg_strength_threshold": "0.25"}

    assert benchmark.demag_policy_identity(first) != benchmark.demag_policy_identity(second)
    assert benchmark.demag_policy_identity(first) != benchmark.demag_policy_identity(third)


def test_optional_demag_amg_profile_parser_preserves_defaults_and_overrides() -> None:
    benchmark = load_benchmark_module()

    assert benchmark.resolve_optional_nonnegative_floats(None) == [None]
    assert benchmark.resolve_optional_nonnegative_floats("default,0.25") == [
        None,
        0.25,
    ]
    assert benchmark.resolve_optional_nonnegative_ints(None) == [None]
    assert benchmark.resolve_optional_nonnegative_ints("none,25") == [None, 25]


def test_demag_convergence_gate_uses_row_requested_rtol_by_default() -> None:
    benchmark = load_benchmark_module()
    rows = [
        {
            "backend": "fem_gpu",
            "scenario": "box500_airbox_exchange_demag",
            "status": "ok",
            "requested_demag_relative_tolerance": 1e-6,
            "demag_final_residual_norm": 8e-7,
            "demag_actual_iterations": 12,
        },
        {
            "backend": "fem_gpu",
            "scenario": "box500_airbox_exchange_demag",
            "status": "ok",
            "requested_demag_relative_tolerance": 1e-8,
            "demag_final_residual_norm": 8e-7,
            "demag_actual_iterations": 12,
        },
    ]

    failures = benchmark.demag_convergence_failures(
        rows,
        max_residual=None,
        max_iterations=100,
    )

    assert len(failures) == 1
    assert "exceeds 1e-08" in failures[0]


def test_demag_rtol_sweep_does_not_install_global_default_residual_gate() -> None:
    benchmark = load_benchmark_module()
    args = benchmark.parse_args(["--demag-rtols", "1e-8,1e-6"])

    assert args.demag_convergence_residual is None
    assert benchmark.resolve_demag_rtols(args.demag_rtols, args.demag_rtol) == [
        1e-8,
        1e-6,
    ]


def test_best_demag_policy_uses_row_requested_rtol_by_default() -> None:
    benchmark = load_benchmark_module()
    base_row = {
        "backend": "fem_gpu",
        "mesh_path": "mesh.json",
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "relaxation_algorithm": "projected_gradient_bb",
        "timestep_policy": "fixed",
        "dt_s": 1e-13,
        "steps": 2,
        "requested_cpu_thread_spec": "auto",
        "requested_demag_relative_tolerance": 1e-6,
        "requested_demag_absolute_tolerance": None,
        "requested_demag_max_iterations": 500,
        "requested_demag_print_level": 0,
        "status": "ok",
        "demag_actual_iterations": 10,
        "demag_final_residual_norm": 8e-7,
    }
    rows = [
        {
            **base_row,
            "requested_demag_solver": "CG",
            "requested_demag_preconditioner": "AMG",
            "demag_wall_time_ms": 20.0,
        },
        {
            **base_row,
            "requested_demag_solver": "CG",
            "requested_demag_preconditioner": "JACOBI",
            "demag_wall_time_ms": 10.0,
        },
    ]

    summaries = benchmark.best_demag_policy_rows(
        rows,
        max_residual=None,
        max_iterations=100,
    )

    assert len(summaries) == 1
    assert summaries[0]["demag_preconditioner"] == "JACOBI"
    assert summaries[0]["converged_policy_count"] == 2


def test_best_demag_policy_can_select_by_solver_apply_time() -> None:
    benchmark = load_benchmark_module()
    base_row = {
        "backend": "fem_gpu",
        "mesh_path": "mesh.json",
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "relaxation_algorithm": "projected_gradient_bb",
        "timestep_policy": "fixed",
        "dt_s": 1e-13,
        "steps": 2,
        "requested_cpu_thread_spec": "auto",
        "requested_demag_relative_tolerance": 1e-8,
        "requested_demag_absolute_tolerance": None,
        "requested_demag_max_iterations": 500,
        "requested_demag_print_level": 0,
        "status": "ok",
        "demag_actual_iterations": 20,
        "demag_final_residual_norm": 8e-9,
    }
    rows = [
        {
            **base_row,
            "requested_demag_solver": "CG",
            "requested_demag_preconditioner": "AMG",
            "demag_wall_time_ms": 100.0,
            "demag_solver_apply_wall_time_ms": 20.0,
        },
        {
            **base_row,
            "requested_demag_solver": "CG",
            "requested_demag_preconditioner": "JACOBI",
            "demag_wall_time_ms": 50.0,
            "demag_solver_apply_wall_time_ms": 30.0,
        },
    ]

    summaries = benchmark.best_demag_policy_rows(
        rows,
        max_residual=None,
        max_iterations=100,
        selection_metric="demag_solver_apply_wall_time_ms",
    )

    assert len(summaries) == 1
    assert summaries[0]["selection_timing_field"] == "demag_solver_apply_wall_time_ms"
    assert summaries[0]["demag_preconditioner"] == "AMG"


def test_best_demag_policy_rejects_unstable_solver_mesh() -> None:
    benchmark = load_benchmark_module()
    base_row = {
        "backend": "fem_gpu",
        "mesh_path": "mesh.json",
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "relaxation_algorithm": "projected_gradient_bb",
        "timestep_policy": "fixed",
        "dt_s": 1e-13,
        "steps": 2,
        "requested_cpu_thread_spec": "auto",
        "requested_demag_relative_tolerance": 1e-8,
        "requested_demag_absolute_tolerance": None,
        "requested_demag_max_iterations": 500,
        "requested_demag_print_level": 0,
        "status": "ok",
        "demag_actual_iterations": 20,
        "demag_final_residual_norm": 8e-9,
    }
    rows = [
        {
            **base_row,
            "solver_mesh_signature": "mesh-a",
            "requested_demag_solver": "CG",
            "requested_demag_preconditioner": "AMG",
            "demag_solver_apply_wall_time_ms": 20.0,
        },
        {
            **base_row,
            "solver_mesh_signature": "mesh-b",
            "requested_demag_solver": "CG",
            "requested_demag_preconditioner": "JACOBI",
            "demag_solver_apply_wall_time_ms": 10.0,
        },
    ]

    summaries = benchmark.best_demag_policy_rows(
        rows,
        max_residual=None,
        max_iterations=100,
        selection_metric="demag_solver_apply_wall_time_ms",
    )
    failures = benchmark.best_demag_policy_failures(
        rows,
        max_residual=None,
        max_iterations=100,
        selection_metric="demag_solver_apply_wall_time_ms",
    )

    assert summaries == []
    assert len(failures) == 1
    assert "cannot select a best demag policy" in failures[0]
    assert "2 solver_mesh_signature values" in failures[0]


def test_benchmark_report_renders_best_demag_policy_table() -> None:
    benchmark = load_benchmark_module()

    report = benchmark.render_cpu_gpu_benchmark_report(
        {
            "status": "pass",
            "row_count": 2,
            "ok_count": 2,
            "failed_count": 0,
            "failure_count": 0,
            "case_coverage": [],
            "pairs": [],
            "completed_pair_case_count": 0,
            "required_case_count": 0,
            "best_demag_policy": [
                {
                    "case_key": ["fem_gpu", "mesh.json"],
                    "demag_solver": "CG",
                    "demag_preconditioner": "JACOBI",
                    "solver_mesh_signature": "mesh-a",
                    "average_demag_solver_apply_wall_time_ms": 3.5,
                    "average_demag_wall_time_ms": 5.0,
                    "max_demag_final_residual_norm": 8e-9,
                    "max_demag_actual_iterations": 70,
                }
            ],
        },
        {
            "status": "pass",
            "gate_failure_count": 0,
            "group_failure_count": 0,
            "solver_mesh_groups": [],
            "failures": [],
        },
    )

    assert "## Best Demag Policy" in report
    assert "CG/JACOBI" in report
    assert "mesh-a" in report


def test_generated_domain_mesh_env_reuses_persistent_cache(
    monkeypatch,
    tmp_path: Path,
) -> None:
    benchmark = load_benchmark_module()
    calls: list[Path] = []

    def fake_export_generated_domain_mesh(**kwargs):
        output_path = kwargs["output_path"]
        calls.append(output_path)
        output_path.write_text('{"mesh": true}\n', encoding="utf-8")
        return output_path

    monkeypatch.setattr(
        benchmark,
        "export_generated_domain_mesh",
        fake_export_generated_domain_mesh,
    )
    thread_spec = benchmark.ThreadCountSpec(label="auto", env_value="auto")
    common = {
        "cache_dir": tmp_path,
        "mesh_path": Path("mesh.json"),
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "steps": 2,
        "dt": 1e-13,
        "timestep_policy": "fixed",
        "thread_spec": thread_spec,
        "extra_env": {
            "FULLMAG_BENCH_DOMAIN_HMAX": "50e-9",
            "FULLMAG_BENCH_AIRBOX_HMAX": "100e-9",
        },
        "timeout_s": 10.0,
    }

    first = benchmark.generated_domain_mesh_env(cache={}, **common)
    second = benchmark.generated_domain_mesh_env(cache={}, **common)

    assert first == second
    assert Path(first["FULLMAG_BENCH_DOMAIN_MESH"]).is_file()
    assert len(calls) == 1


def test_generated_domain_mesh_env_materializes_box500_airbox_alias(
    monkeypatch,
    tmp_path: Path,
) -> None:
    benchmark = load_benchmark_module()

    def fake_export_generated_domain_mesh(**kwargs):
        output_path = kwargs["output_path"]
        output_path.write_text('{"mesh": true}\n', encoding="utf-8")
        return output_path

    monkeypatch.setattr(
        benchmark,
        "export_generated_domain_mesh",
        fake_export_generated_domain_mesh,
    )
    result = benchmark.generated_domain_mesh_env(
        cache={},
        cache_dir=tmp_path,
        mesh_path=Path("mesh.json"),
        scenario="box500_airbox_exchange_zeeman",
        integrator="heun",
        steps=2,
        dt=1e-13,
        timestep_policy="fixed",
        thread_spec=benchmark.ThreadCountSpec(label="auto", env_value="auto"),
        extra_env={},
        timeout_s=10.0,
    )

    assert Path(result["FULLMAG_BENCH_DOMAIN_MESH"]).is_file()


def test_benchmark_mesh_env_forwards_requested_generated_mesh_sizes(monkeypatch) -> None:
    benchmark = load_benchmark_module()
    monkeypatch.setenv("FULLMAG_BENCH_DOMAIN_HMAX", "20e-9")
    monkeypatch.setenv("FULLMAG_BENCH_AIRBOX_HMAX", "100e-9")

    env = benchmark.benchmark_mesh_env(
        SimpleNamespace(
            gmsh_threads=None,
            require_stable_solver_mesh=True,
            require_cpu_gpu_consistency=True,
        )
    )

    assert env["FULLMAG_BENCH_DOMAIN_HMAX"] == "20e-9"
    assert env["FULLMAG_BENCH_AIRBOX_HMAX"] == "100e-9"
    assert env["FULLMAG_GMSH_THREADS"] == "1"


def test_benchmark_backend_runs_use_isolated_output_directory() -> None:
    source = BENCHMARK.read_text(encoding="utf-8")

    assert 'TemporaryDirectory(prefix=f"fullmag_{backend_label.lower()}_bench_")' in source
    assert '"--output-dir",' in source
    assert "str(run_dir)" in source


def test_box500_relaxation_uses_mesh_independent_nonuniform_initial_state() -> None:
    benchmark = load_benchmark_case_module()

    initial = benchmark.scenario_initial_magnetization(
        benchmark.BOX500_AIRBOX_SCENARIO
    ).to_ir()

    assert initial["kind"] == "preset_texture"
    assert initial["preset_kind"] == "helical"
    assert initial["preset_params"]["wavevector"][0] > 0.0


def test_box500_exchange_calibration_omits_airbox_but_demag_keeps_it() -> None:
    benchmark = load_benchmark_case_module()

    assert not benchmark.scenario_requires_shared_domain(
        benchmark.BOX500_EXCHANGE_SCENARIO
    )
    assert benchmark.scenario_requires_shared_domain("box500_airbox_exchange_demag")


def test_adaptive_benchmark_declares_executable_timestep_bounds() -> None:
    source = BENCHMARK_CASE.read_text(encoding="utf-8")

    assert "dt_min=dt * 1e-3" in source
    assert "dt_max=dt" in source


def test_performance_regression_case_key_normalizes_csv_values() -> None:
    benchmark = load_benchmark_module()
    baseline_row = {
        "solver_mesh_signature": "mesh-a",
        "backend": "fem_gpu",
        "mesh_path": "mesh.json",
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "relaxation_algorithm": "projected_gradient_bb",
        "timestep_policy": "fixed",
        "requested_cpu_thread_spec": "auto",
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
        "requested_demag_relative_tolerance": "1e-08",
        "requested_demag_absolute_tolerance": "",
        "requested_demag_max_iterations": "500",
        "requested_demag_print_level": "0",
        "requested_demag_amg_relax_type": "18",
        "requested_demag_amg_coarsening": "8",
        "requested_demag_amg_interpolation": "6",
        "requested_demag_amg_aggressive_coarsening": "1",
        "requested_demag_amg_strength_threshold": "",
        "requested_demag_amg_max_levels": "",
        "status": "ok",
        "wall_time_ms": "10.0",
    }
    current_row = {
        **baseline_row,
        "requested_demag_relative_tolerance": 1e-8,
        "requested_demag_absolute_tolerance": None,
        "requested_demag_max_iterations": 500,
        "requested_demag_print_level": 0,
        "requested_demag_amg_relax_type": 18,
        "requested_demag_amg_coarsening": 8,
        "requested_demag_amg_interpolation": 6,
        "requested_demag_amg_aggressive_coarsening": 1,
        "requested_demag_amg_strength_threshold": None,
        "requested_demag_amg_max_levels": None,
        "wall_time_ms": 9.0,
    }

    assert benchmark.performance_regression_case_key(current_row) == (
        benchmark.performance_regression_case_key(baseline_row)
    )
    assert benchmark.comparable_baseline_case_count(
        [current_row],
        [baseline_row],
    ) == 1


def test_pass_fail_summary_uses_row_requested_rtol_by_default() -> None:
    benchmark = load_benchmark_module()
    rows = [
        {
            "backend": "fem_gpu",
            "solver_mesh_signature": "mesh-a",
            "scenario": "box500_airbox_exchange_demag",
            "status": "ok",
            "requested_demag_relative_tolerance": 1e-6,
            "demag_final_residual_norm": 8e-7,
            "demag_actual_iterations": 12,
        }
    ]

    summary = benchmark.benchmark_pass_fail_summary(
        rows,
        gate_failures=[],
        max_residual=None,
        max_iterations=100,
    )

    assert summary["status"] == "pass"
    assert summary["solver_mesh_groups"][0]["status"] == "pass"
    assert summary["failures"] == []


def test_pass_fail_summary_includes_gate_and_group_failure_reasons() -> None:
    benchmark = load_benchmark_module()
    rows = [
        {
            "backend": "fem_gpu",
            "solver_mesh_signature": "mesh-a",
            "scenario": "box500_airbox_exchange_demag",
            "status": "ok",
            "requested_demag_relative_tolerance": 1e-8,
            "demag_final_residual_norm": 8e-7,
            "demag_actual_iterations": 12,
        }
    ]

    summary = benchmark.benchmark_pass_fail_summary(
        rows,
        gate_failures=["case=mesh-a demag_solver_setup_reused is not true"],
        max_residual=None,
        max_iterations=100,
    )

    assert summary["status"] == "fail"
    assert summary["gate_failure_count"] == 1
    assert summary["group_failure_count"] == 1
    assert "demag_solver_setup_reused is not true" in summary["failures"][0]
    assert "solver_mesh_signature=mesh-a failed 1 benchmark checks" in summary["failures"][1]


def test_stt_oersted_consistency_cases_exclude_all_relaxation_algorithms() -> None:
    benchmark = load_benchmark_module()
    algorithms = [
        "llg_overdamped",
        "projected_gradient_bb",
        "nonlinear_cg",
        "tangent_plane_implicit",
    ]
    manifests = benchmark.cpu_gpu_case_manifests(
        scenarios=["box500_airbox_stt_oersted"],
        relaxation_algorithms=algorithms,
        steps=32,
        dt=1.0e-13,
        energy_rtol=1.0e-6,
        energy_atol=1.0e-30,
        torque_rtol=1.0e-6,
        torque_atol_apm=1.0e-9,
        torque_atol_t=1.0e-15,
        max_step_delta=0,
    )

    assert benchmark.relaxation_algorithms_for_scenario(
        "box500_airbox_stt_oersted", algorithms
    ) == []
    assert manifests == []


def test_direct_minimizer_consistency_requires_coverage_not_identical_trajectory() -> None:
    benchmark = load_benchmark_module()
    manifests = benchmark.cpu_gpu_case_manifests(
        scenarios=["box500_airbox_exchange_demag"],
        relaxation_algorithms=["nonlinear_cg"],
        steps=32,
        dt=1.0e-13,
        energy_rtol=1.0e-6,
        energy_atol=1.0e-30,
        torque_rtol=1.0e-6,
        torque_atol_apm=1.0e-9,
        torque_atol_t=1.0e-15,
        max_step_delta=0,
    )
    base_row = {
        "scenario": "box500_airbox_exchange_demag",
        "reported_relaxation_algorithm": "nonlinear_cg",
        "relaxation_algorithm": "nonlinear_cg",
        "integrator": "heun",
        "timestep_policy": "fixed",
        "dt_s": 1.0e-13,
        "steps": 32,
        "status": "ok",
        "solver_mesh_signature": "mesh-a",
        "execution_engine": "fem_cpu_native",
        "fem_execution_mode": "cpu_native",
        "mfem_device": "cpu",
        "uses_cuda_kernels": False,
        "executed_steps": 32,
        "final_e_total_j": -1.0e-17,
        "final_e_ex_j": 1.0e-22,
        "final_e_demag_j": 2.0e-19,
        "final_e_ext_j": -1.02e-17,
        "final_torque_apm": 2.0e4,
        "final_torque_t": 2.5e-2,
    }
    gpu_row = {
        **base_row,
        "backend": "fem_gpu",
        "execution_engine": "fem_native_gpu",
        "fem_execution_mode": "all_in_gpu_legacy_sparse",
        "mfem_device": "cuda",
        "uses_cuda_kernels": True,
        "executed_steps": 24,
        "final_e_total_j": -9.5e-18,
        "final_e_ex_j": 1.4e-22,
        "final_e_demag_j": 2.4e-19,
        "final_e_ext_j": -9.74e-18,
        "final_torque_apm": 1.0e3,
        "final_torque_t": 1.25e-3,
    }
    cpu_row = {**base_row, "backend": "fem_cpu"}

    failures = benchmark.cpu_gpu_consistency_failures(
        [cpu_row, gpu_row],
        case_manifests=manifests,
        require_gpu_strict_residency=False,
    )

    assert failures == []


def test_llg_consistency_still_rejects_numeric_mismatch() -> None:
    benchmark = load_benchmark_module()
    manifests = benchmark.cpu_gpu_case_manifests(
        scenarios=["box500_airbox_exchange_demag"],
        relaxation_algorithms=["llg_overdamped"],
        steps=32,
        dt=1.0e-13,
        energy_rtol=1.0e-6,
        energy_atol=1.0e-30,
        torque_rtol=1.0e-6,
        torque_atol_apm=1.0e-9,
        torque_atol_t=1.0e-15,
        max_step_delta=0,
    )
    cpu_row = {
        "backend": "fem_cpu",
        "scenario": "box500_airbox_exchange_demag",
        "reported_relaxation_algorithm": "llg_overdamped",
        "relaxation_algorithm": "llg_overdamped",
        "integrator": "heun",
        "timestep_policy": "fixed",
        "dt_s": 1.0e-13,
        "steps": 32,
        "status": "ok",
        "solver_mesh_signature": "mesh-a",
        "execution_engine": "fem_cpu_native",
        "fem_execution_mode": "cpu_native",
        "mfem_device": "cpu",
        "uses_cuda_kernels": False,
        "executed_steps": 32,
        "final_e_total_j": -1.0e-17,
        "final_e_ex_j": 1.0e-22,
        "final_e_demag_j": 2.0e-19,
        "final_e_ext_j": -1.02e-17,
        "final_torque_apm": 2.0e4,
        "final_torque_t": 2.5e-2,
    }
    gpu_row = {
        **cpu_row,
        "backend": "fem_gpu",
        "execution_engine": "fem_native_gpu",
        "fem_execution_mode": "all_in_gpu_legacy_sparse",
        "mfem_device": "cuda",
        "uses_cuda_kernels": True,
        "final_torque_apm": 1.0e3,
        "final_torque_t": 1.25e-3,
    }

    failures = benchmark.cpu_gpu_consistency_failures(
        [cpu_row, gpu_row],
        case_manifests=manifests,
        require_gpu_strict_residency=False,
    )

    assert any("final_torque_apm mismatch" in failure for failure in failures)


def test_stt_oersted_has_no_relaxation_consistency_manifest() -> None:
    benchmark = load_benchmark_module()
    manifests = benchmark.cpu_gpu_case_manifests(
        scenarios=["box500_airbox_stt_oersted"],
        relaxation_algorithms=["llg_overdamped"],
        steps=32,
        dt=1.0e-13,
        energy_rtol=1.0e-6,
        energy_atol=1.0e-30,
        torque_rtol=1.0e-6,
        torque_atol_apm=1.0e-9,
        torque_atol_t=1.0e-15,
        max_step_delta=0,
    )
    assert manifests == []


def test_cpu_gpu_consistency_preflight_reports_unavailable_native_fem_gpu() -> None:
    benchmark = load_benchmark_module()
    with tempfile.TemporaryDirectory() as temp_dir:
        fake_runtime = Path(temp_dir) / "fullmag-fem-gpu"
        fake_runtime.write_text(
            """#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2 $3" = "runtime fem-availability --json" ]; then
  cat <<'JSON'
{
  "native_fem_cpu_available": true,
  "native_fem_gpu_available": false,
  "visible_cuda_device_count": 0,
  "reason_gpu": "cudaGetDeviceCount failed for fullmag_fem: CUDA driver version is insufficient for CUDA runtime version"
}
JSON
  exit 0
fi
exit 64
""",
            encoding="utf-8",
        )
        fake_runtime.chmod(0o755)

        failure = benchmark.runtime_gpu_availability_failure(fake_runtime)

    assert failure is not None
    assert "native FEM GPU backend is unavailable" in failure
    assert "cudaGetDeviceCount failed" in failure


def test_runtime_gate_can_preserve_logs_for_audit() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        fake_bin = temp_path / "bin"
        fake_bin.mkdir()
        audit_tmp = temp_path / "tmp"
        audit_tmp.mkdir()
        fake_just = fake_bin / "just"
        fake_python = fake_bin / "python3"
        fake_just.write_text(
            """#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "ensure-managed-fem-runtime" ]; then
  echo "[fake-just] managed runtime fresh"
  exit 0
fi
if [ "${1:-}" = "verify-fem-relaxation-source-contract" ]; then
  echo "[fake-just] source contract passed"
  exit 0
fi
echo "[fake-just] runtime smoke $*"
""",
            encoding="utf-8",
        )
        fake_python.write_text(
            """#!/usr/bin/env bash
set -euo pipefail
exit 0
""",
            encoding="utf-8",
        )
        fake_just.chmod(0o755)
        fake_python.chmod(0o755)
        env = os.environ.copy()
        env.update(
            {
                "PATH": f"{fake_bin}:{env['PATH']}",
                "TMPDIR": str(audit_tmp),
                "FULLMAG_FEM_RELAXATION_KEEP_LOGS": "1",
                "FULLMAG_FEM_RELAXATION_ALGORITHMS": "llg_overdamped",
                "FULLMAG_FEM_RELAXATION_ENGINES": "gpu",
            }
        )
        result = subprocess.run(
            ["bash", str(VERIFY_RUNTIME)],
            cwd=REPO_ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        marker = "[verify_fem_relaxation_runtime] preserving runtime logs: "
        assert marker in result.stdout
        log_dir_text = result.stdout.split(marker, 1)[1].splitlines()[0]
        preserved_log_dir = Path(log_dir_text)
        assert preserved_log_dir.exists()
        assert (preserved_log_dir / "gpu_llg_overdamped.log").exists()


def test_gpu_ncg_control_readback_budget_covers_conditional_direction_read() -> None:
    benchmark = load_benchmark_module()
    row = {
        "backend": "fem_gpu",
        "status": "ok",
        "scenario": "box500_airbox_exchange_demag_anis_uniaxial",
        "relaxation_algorithm": "nonlinear_cg",
        "executed_steps": 32,
        "total_rhs_evals": 63,
        "rejected_attempts": 0,
        "hot_loop_control_scalar_host_sync_count": 189,
    }
    common = {
        "base": 3,
        "per_step": 4,
        "llg_per_step": 0,
        "pgbb_per_step": 3,
        "per_rejected_attempt": 2,
    }

    assert benchmark.gpu_control_readback_budget_failures(
        [row], ncg_per_step=4, **common
    ) == []
    assert benchmark.gpu_control_readback_budget_failures(
        [{**row, "hot_loop_control_scalar_host_sync_count": 222}],
        ncg_per_step=4,
        **common,
    )


def test_gpu_pgbb_control_readback_budget_matches_direct_difference_sync_structure() -> None:
    benchmark = load_benchmark_module()
    row = {
        "backend": "fem_gpu",
        "status": "ok",
        "scenario": "box500_airbox_exchange_demag",
        "relaxation_algorithm": "projected_gradient_bb",
        "executed_steps": 1,
        "total_rhs_evals": 2,
        "rejected_attempts": 0,
        "hot_loop_control_scalar_host_sync_count": 11,
    }
    common = {
        "base": 0,
        "per_step": 4,
        "llg_per_step": 0,
        "ncg_per_step": 3,
        "per_rejected_attempt": 2,
    }

    assert benchmark.DEFAULT_GPU_PGBB_CONTROL_READBACK_PER_STEP == 11
    assert benchmark.gpu_control_readback_budget_failures(
        [row], pgbb_per_step=11, **common
    ) == []
    assert benchmark.gpu_control_readback_budget_failures(
        [row], pgbb_per_step=10, **common
    )
    assert benchmark.gpu_control_readback_budget_failures(
        [{**row, "hot_loop_control_scalar_host_sync_count": 12}],
        pgbb_per_step=11,
        **common,
    )


def test_direct_minimizer_benchmark_uses_qualified_demag_tolerance() -> None:
    benchmark = load_benchmark_module()
    for algorithm in (
        "projected_gradient_bb",
        "nonlinear_cg",
        "tangent_plane_implicit",
    ):
        assert benchmark.qualified_demag_rtol_for_relaxation_algorithm(
            algorithm, 1.0e-8
        ) == 1.0e-12
        assert benchmark.qualified_demag_rtol_for_relaxation_algorithm(
            algorithm, 1.0e-13
        ) == 1.0e-13
    assert benchmark.qualified_demag_rtol_for_relaxation_algorithm(
        "llg_overdamped", 1.0e-8
    ) == 1.0e-8


def test_fem_pgbb_demag_is_included_in_current_production_manifest() -> None:
    benchmark = load_benchmark_module()
    algorithms = ["llg_overdamped", "projected_gradient_bb", "nonlinear_cg"]
    assert benchmark.relaxation_algorithms_for_scenario(
        "box500_airbox_exchange_demag", algorithms
    ) == algorithms
    assert benchmark.relaxation_algorithms_for_scenario(
        "box500_airbox_exchange_zeeman", algorithms
    ) == algorithms


def main() -> int:
    failures = 0
    for test in [
        test_accepts_completed_native_gpu_log,
        test_accepts_completed_native_cpu_log,
        test_accepts_completed_native_cpu_tpi_log,
        test_rejects_failed_status,
        test_rejects_cpu_fallback,
        test_rejects_direct_minimizer_without_production_gpu_status,
        test_rejects_direct_minimizer_energy_increase,
        test_rejects_llg_overdamped_energy_increase,
        test_rejects_relaxation_without_meaningful_energy_decrease,
        test_stricter_convergence_threshold_rejects_weak_energy_decrease,
        test_rejects_relaxation_with_large_final_torque_growth,
        test_rejects_scalars_with_noncontiguous_step_sequence,
        test_accepts_runtime_with_more_scalar_rows_than_minimum,
        test_rejects_summary_final_energy_that_disagrees_with_scalars,
        test_rejects_native_cpu_log_without_relaxation_qualification,
        test_rejects_cpu_llg_without_algorithm_policy,
        test_rejects_gpu_direct_minimizer_without_relaxation_qualification,
        test_rejects_gpu_llg_without_relaxation_qualification,
        test_rejects_gpu_direct_minimizer_without_gradient_policy,
        test_rejects_gpu_qualification_that_disagrees_with_provenance,
        test_rejects_cpu_projected_gradient_bb_with_nonlinear_cg_line_search,
        test_rejects_cpu_projected_gradient_bb_without_step_update_policy,
        test_rejects_cpu_nonlinear_cg_without_direction_update_policy,
        test_rejects_cpu_relaxation_with_large_magnetization_norm_defect,
        test_rejects_gpu_relaxation_without_magnetization_norm_defect,
        test_runtime_gate_and_physics_note_promote_cpu_tpi_without_gpu_claim,
        test_cpu_gpu_consistency_smoke_covers_active_relaxation_algorithms,
        test_cpu_gpu_consistency_coverage_is_per_relaxation_algorithm,
        test_stt_oersted_consistency_cases_exclude_all_relaxation_algorithms,
        test_direct_minimizer_consistency_requires_coverage_not_identical_trajectory,
        test_llg_consistency_still_rejects_numeric_mismatch,
        test_stt_oersted_has_no_relaxation_consistency_manifest,
        test_gpu_ncg_control_readback_budget_covers_conditional_direction_read,
        test_gpu_pgbb_control_readback_budget_matches_direct_difference_sync_structure,
        test_direct_minimizer_benchmark_uses_qualified_demag_tolerance,
        test_fem_pgbb_demag_is_excluded_from_production_manifest,
        test_cpu_gpu_consistency_preflight_reports_unavailable_native_fem_gpu,
        test_runtime_gate_can_preserve_logs_for_audit,
    ]:
        try:
            test()
        except AssertionError as exc:
            failures += 1
            print(f"FAIL {test.__name__}: {exc}")
        else:
            print(f"ok {test.__name__}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
