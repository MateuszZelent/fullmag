#!/usr/bin/env python3
"""Validate managed FEM relaxation runtime smoke output.

The runtime smoke is intentionally container-backed. This helper checks the
combined stdout/stderr log so a successful process exit is not mistaken for a
validated FEM GPU relaxation run.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from pathlib import Path
from typing import Any


SUPPORTED_ALGORITHMS = {
    "llg_overdamped",
    "projected_gradient_bb",
    "nonlinear_cg",
    "tangent_plane_implicit",
}
SUPPORTED_ENGINES = {"cpu", "gpu"}
DIRECT_MINIMIZERS = {"projected_gradient_bb", "nonlinear_cg"}
CPU_NATIVE_STEP_ALGORITHMS = {*DIRECT_MINIMIZERS, "tangent_plane_implicit"}
ENERGY_MONOTONE_RELAXATION_ALGORITHMS = {
    "llg_overdamped",
    *CPU_NATIVE_STEP_ALGORITHMS,
}
CPU_DIRECT_MINIMIZER_LINE_SEARCH = {
    "projected_gradient_bb": "native_armijo_backtracking_bb1_bb2",
    "nonlinear_cg": "native_armijo_backtracking_pr_plus_restart",
    "tangent_plane_implicit": "native_armijo_backtracking",
}
NATIVE_MINIMIZER_REALIZATIONS = {
    ("cpu", "projected_gradient_bb"): "native_mfem_pgbb",
    ("gpu", "projected_gradient_bb"): "native_cuda_pgbb",
    ("cpu", "nonlinear_cg"): "native_mfem_nonlinear_cg",
    ("gpu", "nonlinear_cg"): "native_cuda_nonlinear_cg",
    ("cpu", "tangent_plane_implicit"): "native_mfem_tpi",
}
LLG_OVERDAMPED_POLICY = {
    "realization": "native_llg_time_integrator",
    "precession_policy": "disabled_pure_damping",
    "rhs_policy": "llg_overdamped_rhs",
}
ENERGY_WEIGHTED_ARMIJO_CONTRACT = {
    "metric": "mu0_ms_fem_lumped_volume",
    "gradient_metric": "mu0_ms_fem_lumped_volume",
    "gradient_units": "A/m",
    "search_direction_units": "A/m",
    "line_search_step_units": "m/A",
    "armijo_slope_units": "J A/m",
    "armijo_decrement_units": "J",
    "armijo_derivative_units": "J",
}
MAX_MAGNETIZATION_NORM_DEFECT = 1.0e-9
MIN_RELATIVE_ENERGY_DECREASE = 1.0e-3
MAX_FINAL_TORQUE_GROWTH_FACTOR = 1.25
COMMON_FAILURE_MARKERS = [
    "MPI_INIT failed",
    "No network interfaces were found",
    "fallback=Some",
]
GPU_FAILURE_MARKERS = [
    "falling back to MFEM/libCEED/hypre CPU FEM",
    "resolved_engine_id=fem_cpu_native",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log_path", type=Path)
    parser.add_argument("--engine", required=True, choices=sorted(SUPPORTED_ENGINES))
    parser.add_argument("--algorithm", required=True, choices=sorted(SUPPORTED_ALGORITHMS))
    parser.add_argument(
        "--demag",
        choices=("enabled", "disabled"),
        default="enabled",
        help="Expected demag realization for this qualification case.",
    )
    parser.add_argument("--min-steps", type=int, default=2)
    parser.add_argument(
        "--min-relative-energy-decrease",
        type=float,
        default=MIN_RELATIVE_ENERGY_DECREASE,
        help="Minimum required relative decrease in E_total across the trajectory.",
    )
    parser.add_argument(
        "--max-final-torque-growth-factor",
        type=float,
        default=MAX_FINAL_TORQUE_GROWTH_FACTOR,
        help="Maximum allowed final max_torque_T divided by initial max_torque_T.",
    )
    args = parser.parse_args()
    if args.engine == "gpu" and args.algorithm == "tangent_plane_implicit":
        parser.error("tangent_plane_implicit is CPU/MFEM-only; GPU/libCEED TPI is under development")
    require(
        math.isfinite(args.min_relative_energy_decrease)
        and args.min_relative_energy_decrease >= 0.0,
        "--min-relative-energy-decrease must be a finite non-negative number",
    )
    require(
        math.isfinite(args.max_final_torque_growth_factor)
        and args.max_final_torque_growth_factor > 0.0,
        "--max-final-torque-growth-factor must be a finite positive number",
    )
    return args


def load_last_json_object(text: str) -> dict[str, Any]:
    decoder = json.JSONDecoder()
    last: dict[str, Any] | None = None
    for index, char in enumerate(text):
        if char != "{":
            continue
        try:
            value, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            last = value
    if last is None:
        raise ValueError("runtime log does not contain a JSON run summary")
    return last


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def require_json_object(value: Any, message: str) -> dict[str, Any]:
    require(isinstance(value, dict), message)
    return value


def validate_norm_defect(qualification: dict[str, Any], label: str) -> None:
    value = qualification.get("norm_defect")
    require(
        isinstance(value, (int, float)) and math.isfinite(float(value)),
        f"{label} must include finite norm_defect",
    )
    defect = float(value)
    require(defect >= 0.0, f"{label} norm_defect must be non-negative")
    require(
        defect <= MAX_MAGNETIZATION_NORM_DEFECT,
        f"{label} norm_defect exceeds {MAX_MAGNETIZATION_NORM_DEFECT:.1e}: {defect:.15e}",
    )


def validate_text_markers(text: str, engine: str) -> None:
    expected_engine = "fem_native_gpu" if engine == "gpu" else "fem_cpu_native"
    require(
        f"resolved_engine_id={expected_engine} fallback=None" in text,
        f"runtime log must show resolved_engine_id={expected_engine} fallback=None",
    )
    require(
        f"native FEM backend active: engine={expected_engine}" in text,
        f"runtime log must show the native FEM {engine.upper()} backend as active",
    )
    failure_markers = list(COMMON_FAILURE_MARKERS)
    if engine == "gpu":
        failure_markers.extend(GPU_FAILURE_MARKERS)
    for marker in failure_markers:
        require(marker not in text, f"runtime log contains failure/fallback marker: {marker}")


def validate_summary(summary: dict[str, Any], algorithm: str, min_steps: int) -> None:
    require(summary.get("status") == "completed", f"unexpected status: {summary.get('status')!r}")
    require(summary.get("backend") == "fem", f"unexpected backend: {summary.get('backend')!r}")
    expected_mode = "extended" if algorithm == "tangent_plane_implicit" else "strict"
    require(
        summary.get("mode") == expected_mode,
        f"unexpected mode for {algorithm}: expected {expected_mode!r}, got {summary.get('mode')!r}",
    )
    require(summary.get("precision") == "double", f"unexpected precision: {summary.get('precision')!r}")
    problem_name = summary.get("problem_name")
    require(
        isinstance(problem_name, str) and problem_name.endswith(f"_{algorithm}"),
        f"problem_name does not match algorithm {algorithm!r}: {problem_name!r}",
    )
    total_steps = summary.get("total_steps")
    require(
        isinstance(total_steps, int) and total_steps >= min_steps,
        f"total_steps must be >= {min_steps}, got {total_steps!r}",
    )
    final_energy = summary.get("final_e_total")
    require(
        isinstance(final_energy, (int, float)) and math.isfinite(float(final_energy)),
        f"final_e_total must be finite, got {final_energy!r}",
    )


def resolve_artifact_dir(summary: dict[str, Any], log_path: Path) -> Path:
    raw = summary.get("artifact_dir")
    require(isinstance(raw, str) and raw, "JSON run summary must include artifact_dir")
    path = Path(raw)
    if not path.is_absolute():
        path = (log_path.parent / path).resolve()
        if not path.exists():
            path = (Path.cwd() / raw).resolve()
    require(path.is_dir(), f"artifact_dir does not exist or is not a directory: {path}")
    return path


def load_metadata(artifact_dir: Path) -> dict[str, Any]:
    path = artifact_dir / "metadata.json"
    require(path.is_file(), f"missing metadata artifact: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), f"metadata artifact is not a JSON object: {path}")
    return value


def validate_cpu_relaxation_qualification(
    metadata: dict[str, Any],
    algorithm: str,
    min_steps: int,
) -> None:
    qualification = require_json_object(
        metadata.get("fem_cpu_relaxation_qualification"),
        "metadata must include fem_cpu_relaxation_qualification for native CPU FEM relaxation",
    )
    require(
        qualification.get("schema_version") == "fem_cpu_relaxation_qualification.v1",
        "fem_cpu_relaxation_qualification schema_version must be fem_cpu_relaxation_qualification.v1",
    )
    require(
        qualification.get("benchmark_gate_version") == "fem_cpu_no_pbc_adaptive.v1",
        "fem_cpu_relaxation_qualification benchmark_gate_version must be fem_cpu_no_pbc_adaptive.v1",
    )
    require(
        qualification.get("relaxation_algorithm") == algorithm,
        f"fem_cpu_relaxation_qualification relaxation_algorithm must be {algorithm}",
    )
    validate_norm_defect(qualification, "fem_cpu_relaxation_qualification")
    executed_steps = qualification.get("executed_steps")
    require(
        isinstance(executed_steps, int) and executed_steps >= min_steps,
        f"fem_cpu_relaxation_qualification executed_steps must be >= {min_steps}",
    )
    require(
        qualification.get("assembly_mode") == "legacy_sparse",
        "fem_cpu_relaxation_qualification assembly_mode must be legacy_sparse",
    )
    require(
        isinstance(qualification.get("stop_reason"), str) and qualification.get("stop_reason"),
        "fem_cpu_relaxation_qualification must include a stop_reason",
    )
    if algorithm == "llg_overdamped":
        policy = require_json_object(
            qualification.get("algorithm_policy"),
            "fem_cpu_relaxation_qualification must include algorithm_policy for llg_overdamped",
        )
        for key, expected in LLG_OVERDAMPED_POLICY.items():
            require(
                policy.get(key) == expected,
                f"CPU llg_overdamped algorithm_policy {key} must be {expected}",
            )
        integrator = policy.get("time_integrator")
        require(
            isinstance(integrator, str) and integrator,
            "CPU llg_overdamped algorithm_policy must include time_integrator",
        )
    if algorithm in CPU_NATIVE_STEP_ALGORITHMS:
        policy = require_json_object(
            qualification.get("algorithm_policy"),
            "fem_cpu_relaxation_qualification must include algorithm_policy for native FEM relaxation",
        )
        expected_realization = NATIVE_MINIMIZER_REALIZATIONS[("cpu", algorithm)]
        require(
            policy.get("realization") == expected_realization,
            f"CPU native-relaxation algorithm_policy realization must be {expected_realization}",
        )
        expected_metric = ENERGY_WEIGHTED_ARMIJO_CONTRACT["metric"]
        require(
            policy.get("metric") == expected_metric,
            f"CPU native-relaxation algorithm_policy metric must be {expected_metric}",
        )
        expected_line_search = CPU_DIRECT_MINIMIZER_LINE_SEARCH[algorithm]
        require(
            policy.get("line_search") == expected_line_search,
            "CPU native-relaxation algorithm_policy line_search must be "
            f"{expected_line_search}, got {policy.get('line_search')!r}",
        )
        for key, expected in ENERGY_WEIGHTED_ARMIJO_CONTRACT.items():
            require(
                policy.get(key) == expected,
                f"CPU energy-weighted Armijo algorithm_policy {key} must be {expected}",
            )
        if algorithm in DIRECT_MINIMIZERS:
            require(
                policy.get("preconditioner") == "exchange_plus_mass_tangent_gradient",
                "CPU direct-minimizer algorithm_policy preconditioner must be exchange_plus_mass_tangent_gradient",
            )
            linear_solver_policy = policy.get("linear_solver_policy")
            require(
                isinstance(linear_solver_policy, str)
                and "serial MFEM CG production default" in linear_solver_policy
                and "HyprePCG/BoomerAMG explicit opt-in" in linear_solver_policy,
                "CPU direct-minimizer algorithm_policy must publish the MFEM CG/Hypre opt-in linear solver policy",
            )
        if algorithm == "tangent_plane_implicit":
            require(
                policy.get("preconditioner")
                == "native_tangent_plane_linear_solve_preconditioner",
                "CPU TPI algorithm_policy preconditioner must be native_tangent_plane_linear_solve_preconditioner",
            )
            require(
                policy.get("tangent_operator")
                == "mass_exchange_local_anisotropy_zeeman_dmi_demag_linear_response",
                "CPU TPI algorithm_policy must publish the tangent-plane operator contract",
            )
            linear_solver_policy = policy.get("linear_solver_policy")
            require(
                isinstance(linear_solver_policy, str)
                and "MFEM/Hypre Krylov solver" in linear_solver_policy
                and "non-SPD fallback" in linear_solver_policy,
                "CPU TPI algorithm_policy must publish MFEM/Hypre Krylov and non-SPD fallback policy",
            )
            require(
                policy.get("gpu_status") == "unsupported",
                "CPU TPI algorithm_policy gpu_status must be unsupported",
            )
        if algorithm == "nonlinear_cg":
            require(
                policy.get("direction_update") == "polak_ribiere_plus_projected_restart",
                "CPU nonlinear-CG algorithm_policy direction_update must be "
                "polak_ribiere_plus_projected_restart",
            )
        if algorithm == "projected_gradient_bb":
            require(
                policy.get("step_update") == "alternating_bb1_bb2",
                "CPU projected-gradient BB algorithm_policy step_update must be alternating_bb1_bb2",
            )


def validate_gpu_relaxation_qualification(
    metadata: dict[str, Any],
    provenance: dict[str, Any],
    algorithm: str,
    min_steps: int,
    demag_enabled: bool,
) -> None:
    qualification = require_json_object(
        metadata.get("fem_gpu_relaxation_qualification"),
        "metadata must include fem_gpu_relaxation_qualification for native GPU FEM direct minimizers",
    )
    require(
        qualification.get("schema_version") == "fem_gpu_relaxation_qualification.v1",
        "fem_gpu_relaxation_qualification schema_version must be fem_gpu_relaxation_qualification.v1",
    )
    require(
        qualification.get("relaxation_algorithm") == algorithm,
        f"fem_gpu_relaxation_qualification relaxation_algorithm must be {algorithm}",
    )
    validate_norm_defect(qualification, "fem_gpu_relaxation_qualification")
    executed_steps = qualification.get("executed_steps")
    require(
        isinstance(executed_steps, int) and executed_steps >= min_steps,
        f"fem_gpu_relaxation_qualification executed_steps must be >= {min_steps}",
    )
    policy = require_json_object(
        qualification.get("algorithm_policy"),
        "fem_gpu_relaxation_qualification must include algorithm_policy",
    )
    if algorithm == "llg_overdamped":
        for key, expected in LLG_OVERDAMPED_POLICY.items():
            require(
                policy.get(key) == expected,
                f"GPU llg_overdamped algorithm_policy {key} must be {expected}",
            )
        integrator = policy.get("time_integrator")
        require(
            isinstance(integrator, str) and integrator,
            "GPU llg_overdamped algorithm_policy must include time_integrator",
        )
    else:
        expected_realization = NATIVE_MINIMIZER_REALIZATIONS[("gpu", algorithm)]
        require(
            policy.get("realization") == expected_realization,
            f"GPU direct-minimizer algorithm_policy realization must be {expected_realization}",
        )
        for key, expected in ENERGY_WEIGHTED_ARMIJO_CONTRACT.items():
            require(
                policy.get(key) == expected,
                f"GPU direct-minimizer algorithm_policy {key} must be {expected}",
            )
        require(
            policy.get("gradient_policy") == "device_tangent_gradient",
            "GPU direct-minimizer algorithm_policy gradient_policy must be device_tangent_gradient",
        )
        expected_line_search = CPU_DIRECT_MINIMIZER_LINE_SEARCH[algorithm]
        require(
            policy.get("line_search") == expected_line_search,
            "GPU direct-minimizer algorithm_policy line_search must be "
            f"{expected_line_search}, got {policy.get('line_search')!r}",
        )
        if algorithm == "nonlinear_cg":
            require(
                policy.get("direction_update") == "polak_ribiere_plus_projected_restart",
                "GPU nonlinear-CG algorithm_policy direction_update must be polak_ribiere_plus_projected_restart",
            )
        if algorithm == "projected_gradient_bb":
            require(
                policy.get("step_update") == "alternating_bb1_bb2",
                "GPU projected-gradient BB algorithm_policy step_update must be alternating_bb1_bb2",
            )
    require(
        provenance.get("llg_mode") != "precessional" or algorithm != "llg_overdamped",
        "llg_overdamped runtime provenance must not report precessional LLG mode",
    )

    device_policy = require_json_object(
        qualification.get("device_policy"),
        "fem_gpu_relaxation_qualification must include device_policy",
    )
    require(
        device_policy.get("execution_mode") == "all_in_gpu_legacy_sparse",
        "GPU direct-minimizer device_policy execution_mode must be all_in_gpu_legacy_sparse",
    )
    require(
        device_policy.get("qualification_status") == "production_executable",
        "GPU direct-minimizer device_policy qualification_status must be production_executable",
    )
    require(
        device_policy.get("data_residency") == "device_source_of_truth",
        "GPU direct-minimizer device_policy data_residency must be device_source_of_truth",
    )
    require(
        device_policy.get("exchange_operator_mode") == "legacy_sparse_gpu",
        "GPU direct-minimizer device_policy exchange_operator_mode must be legacy_sparse_gpu",
    )
    expected_demag_mode = "device_hypre_poisson" if demag_enabled else "none"
    require(
        device_policy.get("demag_operator_mode") == expected_demag_mode,
        "GPU direct-minimizer device_policy demag_operator_mode must be "
        f"{expected_demag_mode}",
    )
    require(
        device_policy.get("uses_cuda_kernels") is True,
        "GPU direct-minimizer device_policy must report uses_cuda_kernels=true",
    )
    require(
        device_policy.get("uses_gpu_poisson") is demag_enabled,
        "GPU direct-minimizer device_policy uses_gpu_poisson must match demag state",
    )
    require(
        device_policy.get("hot_loop_exchange_host_sync_count") == 0,
        "GPU direct-minimizer device_policy must report zero exchange hot-loop host syncs",
    )
    compute_syncs = device_policy.get("hot_loop_compute_host_sync_count")
    require(
        isinstance(compute_syncs, int) and compute_syncs >= 0,
        "GPU direct-minimizer device_policy must report compute hot-loop host sync count",
    )
    provenance_to_device_policy = {
        "fem_execution_mode": "execution_mode",
        "fem_gpu_qualification_status": "qualification_status",
        "fem_data_residency": "data_residency",
        "fem_exchange_operator_mode": "exchange_operator_mode",
        "fem_demag_operator_mode": "demag_operator_mode",
        "uses_cuda_kernels": "uses_cuda_kernels",
        "uses_gpu_poisson": "uses_gpu_poisson",
        "hot_loop_exchange_host_sync_count": "hot_loop_exchange_host_sync_count",
        "hot_loop_compute_host_sync_count": "hot_loop_compute_host_sync_count",
    }
    for provenance_key, device_policy_key in provenance_to_device_policy.items():
        require(
            provenance.get(provenance_key) == device_policy.get(device_policy_key),
            "GPU direct-minimizer qualification device_policy "
            f"{device_policy_key} must match execution_provenance {provenance_key}: "
            f"{device_policy.get(device_policy_key)!r} != {provenance.get(provenance_key)!r}",
        )


def validate_metadata(
    metadata: dict[str, Any],
    algorithm: str,
    engine: str,
    min_steps: int,
    demag_enabled: bool,
) -> None:
    require(metadata.get("status") == "completed", "metadata status must be completed")
    require(
        metadata.get("problem_name") == f"fem_relax_gpu_smoke_{algorithm}",
        f"metadata problem_name does not match algorithm {algorithm}",
    )
    scalar_rows = metadata.get("scalar_rows")
    require(
        isinstance(scalar_rows, int) and scalar_rows >= min_steps,
        f"metadata scalar_rows must be >= {min_steps}, got {scalar_rows!r}",
    )
    provenance = metadata.get("execution_provenance")
    require(isinstance(provenance, dict), "metadata must include execution_provenance")
    expected_engine = "fem_native_gpu" if engine == "gpu" else "fem_cpu_native"
    expected_mode = "all_in_gpu_legacy_sparse" if engine == "gpu" else "cpu_native"
    require(
        provenance.get("execution_engine") == expected_engine,
        f"metadata execution_engine must be {expected_engine}, got {provenance.get('execution_engine')!r}",
    )
    require(
        provenance.get("fem_execution_mode") == expected_mode,
        f"metadata fem_execution_mode must be {expected_mode}, got {provenance.get('fem_execution_mode')!r}",
    )
    if engine == "gpu":
        require(provenance.get("uses_cuda_kernels") is True, "metadata must report uses_cuda_kernels=true")
        require(
            provenance.get("uses_gpu_poisson") is demag_enabled,
            "metadata uses_gpu_poisson must match expected demag state",
        )
        require(
            provenance.get("hot_loop_exchange_host_sync_count") == 0,
            "metadata must report zero hot-loop exchange host syncs",
        )
    else:
        require(provenance.get("uses_cuda_kernels") is False, "metadata must report uses_cuda_kernels=false")
        require(provenance.get("uses_gpu_poisson") is False, "metadata must report uses_gpu_poisson=false")
        validate_cpu_relaxation_qualification(metadata, algorithm, min_steps)
    if algorithm in CPU_NATIVE_STEP_ALGORITHMS:
        require(
            provenance.get("requested_energy_minimizer") == algorithm,
            f"metadata requested_energy_minimizer must be {algorithm}",
        )
        require(
            provenance.get("resolved_energy_minimizer") == algorithm,
            f"metadata resolved_energy_minimizer must be {algorithm}",
        )
        expected_realization = NATIVE_MINIMIZER_REALIZATIONS[(engine, algorithm)]
        require(
            provenance.get("energy_minimizer_realization") == expected_realization,
            f"metadata energy_minimizer_realization must be {expected_realization}",
        )
        if engine == "gpu":
            require(
                provenance.get("fem_gpu_qualification_status") == "production_executable",
                "metadata fem_gpu_qualification_status must be production_executable",
            )
            validate_gpu_relaxation_qualification(
                metadata, provenance, algorithm, min_steps, demag_enabled
            )
    elif algorithm == "llg_overdamped":
        require(
            provenance.get("requested_energy_minimizer") == "llg_overdamped",
            "metadata requested_energy_minimizer must be llg_overdamped",
        )
        require(
            provenance.get("resolved_energy_minimizer") == "llg_overdamped",
            "metadata resolved_energy_minimizer must be llg_overdamped",
        )
        require(
            provenance.get("energy_minimizer_realization") == "native_llg_time_integrator",
            "metadata energy_minimizer_realization must be native_llg_time_integrator",
        )
        require(
            provenance.get("llg_mode") == "pure_damping",
            "metadata llg_mode must be pure_damping for llg_overdamped",
        )
        if engine == "gpu":
            require(
                provenance.get("fem_gpu_qualification_status") == "production_executable",
                "metadata fem_gpu_qualification_status must be production_executable",
            )
            validate_gpu_relaxation_qualification(
                metadata, provenance, algorithm, min_steps, demag_enabled
            )


def load_scalar_rows(artifact_dir: Path) -> list[dict[str, str]]:
    path = artifact_dir / "scalars.csv"
    require(path.is_file(), f"missing scalars artifact: {path}")
    with path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    require(rows, f"scalars artifact has no rows: {path}")
    return rows


def parse_float(row: dict[str, str], column: str, index: int) -> float:
    try:
        value = float(row[column])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"invalid {column} value in scalars row {index}: {row.get(column)!r}") from exc
    require(math.isfinite(value), f"{column} must be finite in scalars row {index}")
    return value


def parse_int(row: dict[str, str], column: str, index: int) -> int:
    try:
        value = int(row[column])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"invalid {column} value in scalars row {index}: {row.get(column)!r}") from exc
    return value


def validate_scalars(
    rows: list[dict[str, str]],
    summary: dict[str, Any],
    algorithm: str,
    min_steps: int,
    min_relative_energy_decrease: float,
    max_final_torque_growth_factor: float,
) -> None:
    require(len(rows) >= min_steps, f"scalars.csv must contain at least {min_steps} rows")
    steps = [parse_int(row, "step", index) for index, row in enumerate(rows, start=1)]
    for expected, actual in enumerate(steps, start=1):
        require(
            actual == expected,
            f"scalars.csv step sequence must be contiguous from 1; row {expected} has step={actual}",
        )
    energies = [parse_float(row, "E_total", index) for index, row in enumerate(rows, start=1)]
    torques = [parse_float(row, "max_torque_T", index) for index, row in enumerate(rows, start=1)]
    require(all(value >= 0.0 for value in torques), "max_torque_T values must be non-negative")
    initial_torque = torques[0]
    final_torque = torques[-1]
    torque_scale = max(initial_torque, 1.0e-300)
    torque_growth = final_torque / torque_scale
    require(
        torque_growth <= max_final_torque_growth_factor,
        "max_torque_T growth is too large for production relaxation smoke: "
        f"{torque_growth:.6e} > {max_final_torque_growth_factor:.6e} "
        f"(initial={initial_torque:.15e}, final={final_torque:.15e})",
    )
    summary_final_energy = summary.get("final_e_total")
    require(
        isinstance(summary_final_energy, (int, float)) and math.isfinite(float(summary_final_energy)),
        f"summary final_e_total must be finite, got {summary_final_energy!r}",
    )
    last_scalar_energy = energies[-1]
    energy_tolerance = max(1.0e-24, abs(last_scalar_energy) * 1.0e-9)
    require(
        abs(float(summary_final_energy) - last_scalar_energy) <= energy_tolerance,
        "summary final_e_total must match final scalars.csv E_total: "
        f"{float(summary_final_energy):.15e} != {last_scalar_energy:.15e}",
    )
    if algorithm in ENERGY_MONOTONE_RELAXATION_ALGORITHMS:
        tolerance = 1.0e-24
        for index, (previous, current) in enumerate(zip(energies, energies[1:]), start=2):
            require(
                current <= previous + tolerance,
                f"E_total increased at scalars row {index}: previous={previous:.15e} current={current:.15e}",
            )
        initial_energy = energies[0]
        final_energy = energies[-1]
        energy_scale = max(abs(initial_energy), abs(final_energy), 1.0e-300)
        relative_decrease = (initial_energy - final_energy) / energy_scale
        require(
            relative_decrease >= min_relative_energy_decrease,
            "E_total relative decrease is too small for production relaxation smoke: "
            f"{relative_decrease:.6e} < {min_relative_energy_decrease:.6e} "
            f"(initial={initial_energy:.15e}, final={final_energy:.15e})",
        )


def main() -> int:
    args = parse_args()
    text = args.log_path.read_text(encoding="utf-8", errors="replace")
    try:
        validate_text_markers(text, args.engine)
        summary = load_last_json_object(text)
        validate_summary(summary, args.algorithm, args.min_steps)
        artifact_dir = resolve_artifact_dir(summary, args.log_path)
        validate_metadata(
            load_metadata(artifact_dir),
            args.algorithm,
            args.engine,
            args.min_steps,
            args.demag == "enabled",
        )
        validate_scalars(
            load_scalar_rows(artifact_dir),
            summary,
            args.algorithm,
            args.min_steps,
            args.min_relative_energy_decrease,
            args.max_final_torque_growth_factor,
        )
    except ValueError as exc:
        print(f"[validate_fem_relaxation_runtime_log] {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1)
    print(
        "[validate_fem_relaxation_runtime_log] "
        f"validated {args.engine} {args.algorithm} runtime log ({args.log_path})",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
