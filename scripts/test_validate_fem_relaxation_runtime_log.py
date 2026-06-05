#!/usr/bin/env python3
"""Unit tests for the FEM relaxation runtime log validator."""

from __future__ import annotations

import os
import importlib.util
import subprocess
import tempfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "validate_fem_relaxation_runtime_log.py"
VERIFY_RUNTIME = REPO_ROOT / "scripts" / "verify_fem_relaxation_runtime.sh"
JUSTFILE = REPO_ROOT / "justfile"
FEM_RELAXATION_NOTE = (
    REPO_ROOT / "docs" / "physics" / "0510-fem-relaxation-algorithms-mfem-gpu.md"
)
BENCHMARK = REPO_ROOT / "scripts" / "analysis" / "fem_gpu_benchmark.py"


def load_benchmark_module():
    spec = importlib.util.spec_from_file_location("fem_gpu_benchmark", BENCHMARK)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


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
        else "native_mfem_backend_relax_step"
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
            cpu_algorithm_policy = f""""algorithm_policy": {{
    "realization": "native_mfem_backend_relax_step",
    "metric": "fem_lumped_mass_inner_product",
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
            algorithm_policy = f""""realization": "native_mfem_backend_relax_step",
      "metric": "fem_lumped_mass_inner_product",
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
    return f"""
[fullmag-runner] live FEM engine: resolved_engine_id=fem_cpu_native fallback=None
info: native FEM backend active: engine=fem_cpu_native
{{
  "problem_name": "fem_relax_gpu_smoke_{algorithm}",
  "status": "completed",
  "backend": "fem",
  "mode": "strict",
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
        "- [ ] Broader interaction-matrix CPU/GPU benchmark pass for current LLG/PG-BB/NCG production lanes"
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


def test_stt_oersted_consistency_cases_exclude_direct_minimizers() -> None:
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

    assert [manifest["relaxation_algorithm"] for manifest in manifests] == [
        "llg_overdamped"
    ]


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


def test_stt_oersted_llg_consistency_allows_small_energy_noise_only() -> None:
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
    cpu_row = {
        "backend": "fem_cpu",
        "scenario": "box500_airbox_stt_oersted",
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
        "final_e_total_j": -2.251999e-19,
        "final_e_ex_j": 1.248527e-26,
        "final_e_ext_j": -2.251999e-19,
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
        "final_e_total_j": -2.252011e-19,
        "final_e_ex_j": 1.248245e-26,
        "final_e_ext_j": -2.252011e-19,
    }

    failures = benchmark.cpu_gpu_consistency_failures(
        [cpu_row, gpu_row],
        case_manifests=manifests,
        require_gpu_strict_residency=False,
    )
    assert failures == []

    gpu_row_with_torque_mismatch = {
        **gpu_row,
        "final_torque_apm": 1.0e3,
        "final_torque_t": 1.25e-3,
    }
    torque_failures = benchmark.cpu_gpu_consistency_failures(
        [cpu_row, gpu_row_with_torque_mismatch],
        case_manifests=manifests,
        require_gpu_strict_residency=False,
    )
    assert any("final_torque_apm mismatch" in failure for failure in torque_failures)


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
        test_stt_oersted_consistency_cases_exclude_direct_minimizers,
        test_direct_minimizer_consistency_requires_coverage_not_identical_trajectory,
        test_llg_consistency_still_rejects_numeric_mismatch,
        test_stt_oersted_llg_consistency_allows_small_energy_noise_only,
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
