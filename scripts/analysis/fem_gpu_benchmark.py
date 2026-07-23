#!/usr/bin/env python3
"""Run FEM CPU/GPU benchmark sweeps and write a CSV summary."""

from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import json
import math
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from collections.abc import Mapping
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BENCHMARK_DIR = REPO_ROOT / "docs" / "reports"
CSV_PATH = BENCHMARK_DIR / "fem_gpu_benchmark_results.csv"
MANAGED_FEM_RUNTIME_ROOT = Path(
    os.environ.get(
        "FULLMAG_FEM_RUNTIME_ROOT",
        str(REPO_ROOT / ".fullmag" / "runtimes" / "fem-gpu-host"),
    )
)
FULLMAG_GPU = Path(
    os.environ.get(
        "FULLMAG_BENCH_GPU_BIN",
        str(MANAGED_FEM_RUNTIME_ROOT / "bin" / "fullmag-fem-gpu"),
    )
)
FULLMAG_CPU = Path(os.environ.get("FULLMAG_BENCH_CPU_BIN", str(FULLMAG_GPU)))
BENCH_SCRIPT = REPO_ROOT / "examples" / "bench_fem_gpu_long.py"
FEM_CMAKE = REPO_ROOT / "backends" / "fem" / "CMakeLists.txt"
GPU_RK_CUDA_SOURCE = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_step.cu"
)
GPU_RK_CMAKE_SOURCE = "gpu/cuda/integrators/rk/rk_step.cu"
GPU_RK_ERROR_NORM_RUNTIME_SOURCE = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_error_norm_runtime.cu"
)
GPU_RK_ADAPTIVE_DECISION_READBACK_SOURCE = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_adaptive_decision_readback.cu"
)

PRESET_MESHES = {
    "coarse": REPO_ROOT / "examples" / "assets" / "box_40x20x10_coarse.mesh.json",
    "bench": REPO_ROOT / "examples" / "assets" / "bench_box_200x50x10nm.mesh.json",
    "medium": REPO_ROOT / "examples" / "assets" / "bench_box_200x50x10nm.mesh.json",
    "fine": REPO_ROOT / "examples" / "assets" / "bench_box_fine.mesh.json",
    "4985": REPO_ROOT / "examples" / "assets" / "bench_box_fine.mesh.json",
}
DEFAULT_MESHES = ["coarse", "medium", "fine"]
DEFAULT_SCENARIOS = ["exchange_only", "exchange_demag", "exchange_dmi", "stt_oersted"]
BOX500_AIRBOX_SCENARIO = "exchange_only_box500_airbox1um"
RELAXATION_SCENARIO_ALIASES = {
    "relax_exchange_only": "exchange_only",
    "relax_exchange_demag": "exchange_demag",
}
BOX500_AIRBOX_SCENARIO_ALIASES = {
    BOX500_AIRBOX_SCENARIO: "exchange_only",
    "box500_airbox_exchange_zeeman": "exchange_zeeman",
    "box500_airbox_exchange_demag": "exchange_demag",
    "box500_airbox_exchange_anis_uniaxial": "exchange_anis_uniaxial",
    "box500_airbox_exchange_anis_cubic": "exchange_anis_cubic",
    "box500_airbox_exchange_demag_anis_uniaxial": "exchange_demag_anis_uniaxial",
    "box500_airbox_exchange_demag_anis_cubic": "exchange_demag_anis_cubic",
    "box500_airbox_exchange_dmi": "exchange_dmi",
    "box500_airbox_stt_oersted": "stt_oersted",
}
BOX500_AIRBOX_CONSISTENCY_SCENARIOS = tuple(BOX500_AIRBOX_SCENARIO_ALIASES)
BOX500_AIRBOX_BODY_SIZE_M = [500e-9, 100e-9, 10e-9]
BOX500_AIRBOX_SIZE_M = [1e-6, 1e-6, 1e-6]
BOX500_AIRBOX_INITIAL_M = [1.0, 0.0, 0.0]
BASE_CPU_GPU_OBSERVABLES = [
    "final_e_total_j",
    "final_e_ex_j",
    "final_torque_apm",
    "final_torque_t",
    "executed_steps",
    "wall_time_ms",
    "step_wall_time_ms",
    "rhs_wall_time_ms",
    "exchange_wall_time_ms",
]
INTERACTION_CONTRACTS = {
    "exchange_only": {
        "interactions": ["exchange"],
        "energy_fields": [],
        "timing_fields": [],
    },
    "exchange_zeeman": {
        "interactions": ["exchange", "zeeman"],
        "energy_fields": ["final_e_ext_j"],
        "timing_fields": ["extra_energy_wall_time_ms"],
    },
    "exchange_demag": {
        "interactions": ["exchange", "demag", "zeeman"],
        "energy_fields": ["final_e_demag_j", "final_e_ext_j"],
        "timing_fields": [
            "demag_wall_time_ms",
            "demag_solver_apply_wall_time_ms",
        ],
    },
    "exchange_anis_uniaxial": {
        "interactions": ["exchange", "uniaxial_anisotropy"],
        "energy_fields": ["final_e_ani_j"],
        "timing_fields": ["extra_energy_wall_time_ms"],
    },
    "exchange_anis_cubic": {
        "interactions": ["exchange", "cubic_anisotropy"],
        "energy_fields": ["final_e_ani_j"],
        "timing_fields": ["extra_energy_wall_time_ms"],
    },
    "exchange_demag_anis_uniaxial": {
        "interactions": ["exchange", "demag", "zeeman", "uniaxial_anisotropy"],
        "energy_fields": ["final_e_demag_j", "final_e_ext_j", "final_e_ani_j"],
        "timing_fields": [
            "demag_wall_time_ms",
            "demag_solver_apply_wall_time_ms",
            "extra_energy_wall_time_ms",
        ],
    },
    "exchange_demag_anis_cubic": {
        "interactions": ["exchange", "demag", "zeeman", "cubic_anisotropy"],
        "energy_fields": ["final_e_demag_j", "final_e_ext_j", "final_e_ani_j"],
        "timing_fields": [
            "demag_wall_time_ms",
            "demag_solver_apply_wall_time_ms",
            "extra_energy_wall_time_ms",
        ],
    },
    "exchange_demag_anisotropy": {
        "interactions": ["exchange", "demag", "zeeman", "uniaxial_anisotropy"],
        "energy_fields": ["final_e_demag_j", "final_e_ext_j", "final_e_ani_j"],
        "timing_fields": [
            "demag_wall_time_ms",
            "demag_solver_apply_wall_time_ms",
            "extra_energy_wall_time_ms",
        ],
    },
    "exchange_dmi": {
        "interactions": ["exchange", "interfacial_dmi", "zeeman"],
        "energy_fields": ["final_e_dmi_j", "final_e_ext_j"],
        "timing_fields": ["extra_energy_wall_time_ms"],
    },
    "stt_oersted": {
        "interactions": ["exchange", "zeeman", "oersted", "zhang_li_stt"],
        "energy_fields": ["final_e_ext_j"],
        "timing_fields": ["rhs_wall_time_ms"],
    },
}
CPU_GPU_ENERGY_FIELDS = (
    "final_e_total_j",
    "final_e_ex_j",
    "final_e_ext_j",
    "final_e_demag_j",
    "final_e_ani_j",
    "final_e_dmi_j",
)
CPU_GPU_TIMING_FIELDS = {
    "wall_time_ms": "wall_time",
    "step_wall_time_ms": "step_wall_time",
    "rhs_wall_time_ms": "rhs_wall_time",
    "exchange_wall_time_ms": "exchange_wall_time",
    "extra_energy_wall_time_ms": "extra_energy_wall_time",
    "demag_wall_time_ms": "demag_wall_time",
    "demag_solver_apply_wall_time_ms": "demag_solver_apply_wall_time",
}
DEFAULT_INTEGRATORS = ["heun", "rk4", "rk23", "rk45"]
DEFAULT_TIMESTEP_POLICIES = ["fixed"]
SUPPORTED_RELAXATION_ALGORITHMS = (
    "llg_overdamped",
    "projected_gradient_bb",
    "nonlinear_cg",
    "tangent_plane_implicit",
)
CPU_ONLY_RELAXATION_ALGORITHMS = {"tangent_plane_implicit"}
NONCONSERVATIVE_RELAXATION_SCENARIOS = {"stt_oersted"}
ENERGY_MINIMIZER_RELAXATION_ALGORITHMS = {
    "projected_gradient_bb",
    "nonlinear_cg",
    "tangent_plane_implicit",
}
MAX_DIRECT_MINIMIZER_DEMAG_RTOL = 1.0e-12
DEFAULT_BACKENDS = ["cpu", "gpu"]
DEFAULT_MAX_PERFORMANCE_REGRESSION_PERCENT = 10.0
DEFAULT_CPU_GPU_ENERGY_RTOL = 1e-6
DEFAULT_CPU_GPU_ENERGY_ATOL_J = 1e-30
NONCONSERVATIVE_CPU_GPU_ENERGY_ATOL_J = 1e-23
DEFAULT_CPU_GPU_TORQUE_RTOL = 1e-6
DEFAULT_CPU_GPU_TORQUE_ATOL_APM = 1e-9
DEFAULT_CPU_GPU_TORQUE_ATOL_T = 1e-15
DEFAULT_CPU_GPU_MAX_STEP_DELTA = 0
MIN_CONVERGED_DEMAG_POLICIES_FOR_BEST = 2
DEFAULT_GPU_CONTROL_READBACK_BASE = 3
DEFAULT_GPU_CONTROL_READBACK_PER_STEP = 4
DEFAULT_GPU_LLG_CONTROL_READBACK_PER_STEP = 0
DEFAULT_GPU_PGBB_CONTROL_READBACK_PER_STEP = 4
DEFAULT_GPU_NCG_CONTROL_READBACK_PER_STEP = 3
DEFAULT_GPU_CONTROL_READBACK_PER_REJECTED_ATTEMPT = 2
DEFAULT_DEMAG_AMG_RELAX_TYPE = 18
DEFAULT_DEMAG_AMG_COARSENING = 8
DEFAULT_DEMAG_AMG_INTERPOLATION = 6
DEFAULT_DEMAG_AMG_AGGRESSIVE_COARSENING = 1
DEFAULT_DEMAG_AMG_STRENGTH_THRESHOLD = None
DEFAULT_DEMAG_AMG_MAX_LEVELS = None
DEFAULT_BEST_DEMAG_POLICY_METRIC = "demag_solver_apply_wall_time_ms"
BEST_DEMAG_POLICY_METRICS = (
    "demag_wall_time_ms",
    "demag_solve_wall_time_ms",
    "demag_solver_apply_wall_time_ms",
    "wall_time_ms",
)
MU0 = 4.0 * math.pi * 1e-7
RELAX_TORQUE_TOLERANCE_T = 1e-4
RELAX_TORQUE_TOLERANCE_APM = RELAX_TORQUE_TOLERANCE_T / MU0
FULL_RELAXATION_MAX_STEPS = 50_000
PERFORMANCE_REGRESSION_METRICS = (
    "wall_time_ms",
    "backend_create_wall_time_ms",
    "first_accepted_step_demag_solver_apply_wall_time_ms",
    "demag_solver_apply_wall_time_ms",
    "demag_solve_wall_time_ms",
    "demag_assemble_wall_time_ms",
    "demag_recover_wall_time_ms",
    "demag_energy_wall_time_ms",
)
PERFORMANCE_REGRESSION_OBJECTIVE_METRICS = ("wall_time_ms",)
FEM_CPU_NO_PBC_ADAPTIVE_SCENARIOS = {
    "exchange_demag_anis_uniaxial",
    "exchange_demag_anis_cubic",
    "exchange_demag_anisotropy",
}
FEM_CPU_NO_PBC_ADAPTIVE_INTEGRATORS = {"rk23", "rk45"}
BACKEND_ALIASES = {
    "cpu": "fem_cpu",
    "fem_cpu": "fem_cpu",
    "gpu": "fem_gpu",
    "fem_gpu": "fem_gpu",
}
NATIVE_FEM_LIBRARY_NAMES = (
    "libfullmag_fem.so",
    "libfullmag_fem.dylib",
    "fullmag_fem.dll",
)
PERFORMANCE_FIXTURE_SCHEMA = "fullmag.fem_gpu.performance_fixture.v1"
PERFORMANCE_FIXTURE_SUITE_SCHEMA = "fullmag.fem_gpu.performance_fixture_suite.v1"
PERFORMANCE_FIXTURE_SCENARIO = "box500_airbox_exchange_demag"
PERFORMANCE_FIXTURE_RELAXATION_ALGORITHM = "nonlinear_cg"
PERFORMANCE_FIXTURE_STEPS = 64
PERFORMANCE_FIXTURE_TORQUE_TARGET_APM = 1e-6
PERFORMANCE_FIXTURE_RESOLUTIONS = (
    ("coarse", 250e-9, 500e-9),
    ("medium", 100e-9, 250e-9),
    ("fine", 50e-9, 100e-9),
)


@dataclass(frozen=True)
class PerformanceFixture:
    manifest_path: Path
    manifest_sha256: str
    solver_mesh_path: Path
    solver_mesh_sha256: str
    solver_mesh_signature: str
    problem_ir_sha256: str
    scenario: str
    relaxation_algorithm: str
    node_count: int
    element_count: int
    demag_policy: dict[str, object]
    stop_condition: dict[str, object]


def summarize_distribution(values: Sequence[float]) -> dict[str, float | int]:
    ordered = sorted(float(value) for value in values)
    if not ordered:
        raise ValueError("performance distribution requires at least one value")
    p95_index = max(0, math.ceil(0.95 * len(ordered)) - 1)
    return {
        "count": len(ordered),
        "p50": statistics.median(ordered),
        "p95": ordered[p95_index],
        "stddev": statistics.pstdev(ordered),
    }


def load_fixture_manifest(
    path: Path,
    *,
    expected_manifest_sha256: str | None = None,
) -> PerformanceFixture:
    manifest_path = path.resolve()
    manifest_bytes = manifest_path.read_bytes()
    manifest_sha256 = hashlib.sha256(manifest_bytes).hexdigest()
    if (
        expected_manifest_sha256 is not None
        and manifest_sha256 != expected_manifest_sha256
    ):
        raise ValueError(
            "fixture manifest sha256 mismatch: "
            f"expected {expected_manifest_sha256}, got {manifest_sha256}"
        )
    payload = json.loads(manifest_bytes)
    if payload.get("schema") != PERFORMANCE_FIXTURE_SCHEMA:
        raise ValueError("unsupported FEM GPU performance fixture schema")
    mesh_path = (manifest_path.parent / str(payload["solver_mesh_path"])).resolve()
    actual_sha256 = hashlib.sha256(mesh_path.read_bytes()).hexdigest()
    expected_sha256 = str(payload["solver_mesh_sha256"])
    if actual_sha256 != expected_sha256:
        raise ValueError(
            f"solver mesh sha256 mismatch: expected {expected_sha256}, got {actual_sha256}"
        )
    return PerformanceFixture(
        manifest_path=manifest_path,
        manifest_sha256=manifest_sha256,
        solver_mesh_path=mesh_path,
        solver_mesh_sha256=expected_sha256,
        solver_mesh_signature=str(payload["solver_mesh_signature"]),
        problem_ir_sha256=str(payload["problem_ir_sha256"]),
        scenario=str(payload["scenario"]),
        relaxation_algorithm=str(payload["relaxation_algorithm"]),
        node_count=int(payload["node_count"]),
        element_count=int(payload["element_count"]),
        demag_policy=dict(payload["demag_policy"]),
        stop_condition=dict(payload["stop_condition"]),
    )


def verify_fixture_row(
    row: Mapping[str, object], fixture: PerformanceFixture
) -> list[str]:
    failures: list[str] = []
    if row.get("solver_mesh_signature") != fixture.solver_mesh_signature:
        failures.append("solver_mesh_signature differs from fixture")
    if row.get("executed_problem_ir_sha256") != fixture.problem_ir_sha256:
        failures.append("executed_problem_ir_sha256 differs from fixture")
    if row.get("reported_scenario") != fixture.scenario:
        failures.append("scenario differs from fixture")
    if row.get("reported_relaxation_algorithm") != fixture.relaxation_algorithm:
        failures.append("relaxation_algorithm differs from fixture")
    if int(row.get("steps") or -1) != int(fixture.stop_condition["max_steps"]):
        failures.append("steps differs from fixture stop condition")
    executed_steps = as_int(row.get("executed_steps"))
    if (
        executed_steps is None
        or executed_steps < 1
        or executed_steps > int(fixture.stop_condition["max_steps"])
    ):
        failures.append("executed_steps violates fixture stop condition")
    expected_torque = float(
        fixture.stop_condition["benchmark_only_torque_target_apm"]
    )
    actual_torque = as_float(row.get("requested_relax_torque_tolerance_apm"))
    if actual_torque is None or actual_torque != expected_torque:
        failures.append("torque target differs from fixture")
    policy_checks = (
        ("requested_demag_solver", "solver", "demag solver differs from fixture"),
        (
            "requested_demag_preconditioner",
            "preconditioner",
            "demag preconditioner differs from fixture",
        ),
        ("requested_demag_relative_tolerance", "rtol", "demag rtol differs from fixture"),
        (
            "requested_demag_amg_relax_type",
            "amg_relax_type",
            "demag AMG relax type differs from fixture",
        ),
        (
            "requested_demag_amg_coarsening",
            "amg_coarsening",
            "demag AMG coarsening differs from fixture",
        ),
        (
            "requested_demag_amg_interpolation",
            "amg_interpolation",
            "demag AMG interpolation differs from fixture",
        ),
        (
            "requested_demag_amg_aggressive_coarsening",
            "amg_aggressive_coarsening",
            "demag AMG aggressive coarsening differs from fixture",
        ),
    )
    for row_key, policy_key, message in policy_checks:
        actual = row.get(row_key)
        expected = fixture.demag_policy.get(policy_key)
        if policy_key == "rtol":
            actual = as_float(actual)
            expected = as_float(expected)
        elif policy_key not in {"solver", "preconditioner"}:
            actual = as_int(actual)
            expected = as_int(expected)
        if actual != expected:
            failures.append(message)
    resolved_policy_checks = (
        ("demag_linear_solver", "solver", "resolved demag solver differs from fixture"),
        (
            "demag_preconditioner",
            "preconditioner",
            "resolved demag preconditioner differs from fixture",
        ),
        (
            "demag_relative_tolerance",
            "rtol",
            "resolved demag rtol differs from fixture",
        ),
        (
            "demag_amg_relax_type",
            "amg_relax_type",
            "resolved demag AMG relax type differs from fixture",
        ),
        (
            "demag_amg_coarsening",
            "amg_coarsening",
            "resolved demag AMG coarsening differs from fixture",
        ),
        (
            "demag_amg_interpolation",
            "amg_interpolation",
            "resolved demag AMG interpolation differs from fixture",
        ),
        (
            "demag_amg_aggressive_coarsening",
            "amg_aggressive_coarsening",
            "resolved demag AMG aggressive coarsening differs from fixture",
        ),
    )
    for row_key, policy_key, message in resolved_policy_checks:
        actual = row.get(row_key)
        expected = fixture.demag_policy.get(policy_key)
        if policy_key == "rtol":
            actual = as_float(actual)
            expected = as_float(expected)
        elif policy_key not in {"solver", "preconditioner"}:
            actual = as_int(actual)
            expected = as_int(expected)
        if actual != expected:
            failures.append(message)
    if as_int(row.get("node_count")) != fixture.node_count:
        failures.append("node_count differs from fixture")
    if as_int(row.get("element_count")) != fixture.element_count:
        failures.append("element_count differs from fixture")
    return failures


def fixture_manifest_sha256_from_environment(
    environment_path: Path,
    fixture_manifest_path: Path,
) -> str:
    payload = json.loads(environment_path.read_text(encoding="utf-8"))
    fixture = payload.get("fixture")
    if not isinstance(fixture, Mapping):
        raise ValueError("fixture environment is missing fixture identity")
    configured_path = Path(str(fixture.get("manifest_path") or ""))
    resolved_configured_path = (
        configured_path.resolve()
        if configured_path.is_absolute()
        else (REPO_ROOT / configured_path).resolve()
    )
    if resolved_configured_path != fixture_manifest_path.resolve():
        raise ValueError(
            "fixture environment manifest path differs from --fixture-manifest"
        )
    expected_sha256 = str(fixture.get("manifest_sha256") or "")
    if len(expected_sha256) != 64:
        raise ValueError("fixture environment is missing manifest sha256")
    return expected_sha256


def runtime_fixture_mesh_path(fixture: PerformanceFixture) -> Path:
    try:
        return fixture.solver_mesh_path.relative_to(REPO_ROOT)
    except ValueError:
        return fixture.solver_mesh_path


def fixture_solver_mesh_signature(runtime_row: Mapping[str, object]) -> str:
    signature = runtime_row.get("solver_mesh_signature")
    if runtime_row.get("status") != "ok" or not isinstance(signature, str) or not signature:
        raise ValueError("fixture realization did not report solver_mesh_signature")
    return signature


def gpu_environment_identity_failures(
    expected_environment: Mapping[str, object],
    actual_gpu: Mapping[str, object],
) -> list[str]:
    expected_gpu = expected_environment.get("gpu")
    if not isinstance(expected_gpu, Mapping):
        return ["accepted baseline environment is missing GPU identity"]
    failures: list[str] = []
    for key, label in (
        ("uuid", "GPU uuid"),
        ("name", "GPU name"),
        ("compute_capability", "GPU compute capability"),
    ):
        if str(expected_gpu.get(key) or "") != str(actual_gpu.get(key) or ""):
            failures.append(f"{label} differs from accepted baseline")
    return failures


def validate_runtime_restore_manifest(path: Path) -> dict[str, object]:
    restore_manifest_path = path.resolve()
    payload = json.loads(restore_manifest_path.read_text(encoding="utf-8"))
    if payload.get("schema") != "fullmag.fem_gpu.runtime_restore_manifest.v2":
        raise ValueError("unsupported FEM GPU runtime restore manifest schema")
    configured_root = Path(str(payload["bundle_root"]))
    bundle_root = (
        configured_root.resolve()
        if configured_root.is_absolute()
        else (REPO_ROOT / configured_root).resolve()
    )
    for filename, expected_key, label in (
        ("manifest.json", "manifest_sha256", "manifest"),
        ("snapshot.json", "immutable_snapshot_json_sha256", "snapshot"),
    ):
        actual_sha256 = hashlib.sha256((bundle_root / filename).read_bytes()).hexdigest()
        expected_sha256 = str(payload[expected_key])
        if actual_sha256 != expected_sha256:
            raise ValueError(
                f"{label} sha256 mismatch: expected {expected_sha256}, got {actual_sha256}"
            )
    libraries = payload.get("libraries")
    if not isinstance(libraries, Mapping) or not libraries:
        raise ValueError("runtime restore manifest has no libraries")
    for name, raw_entry in libraries.items():
        if not isinstance(raw_entry, Mapping):
            raise ValueError(f"invalid runtime restore library entry: {name}")
        library_path = bundle_root / str(raw_entry["path"])
        actual_sha256 = hashlib.sha256(library_path.read_bytes()).hexdigest()
        expected_sha256 = str(raw_entry["sha256"])
        if actual_sha256 != expected_sha256:
            raise ValueError(
                f"{name} sha256 mismatch: expected {expected_sha256}, got {actual_sha256}"
            )
        expected_inode = raw_entry.get("inode_at_capture")
        if expected_inode is not None and library_path.stat().st_ino != int(expected_inode):
            raise ValueError(
                f"{name} inode mismatch: expected {expected_inode}, "
                f"got {library_path.stat().st_ino}"
            )
    return payload


def runtime_bundle_identity(runtime_root: Path) -> dict[str, str]:
    resolved_root = runtime_root.resolve()
    manifest_path = resolved_root / "manifest.json"
    return {
        "runtime_bundle_root": str(resolved_root),
        "runtime_manifest_sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
    }


class ThreadCountSpec:
    __slots__ = ("label", "env_value")

    label: str
    env_value: str

    def __init__(self, *, label: str, env_value: str) -> None:
        self.label = label
        self.env_value = env_value


def positive_int_arg(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("value must be >= 1")
    return parsed


def positive_float_arg(value: str) -> float:
    parsed = float(value)
    if parsed <= 0.0:
        raise argparse.ArgumentTypeError("value must be > 0")
    return parsed


def nonnegative_float_arg(value: str) -> float:
    parsed = float(value)
    if parsed < 0.0:
        raise argparse.ArgumentTypeError("value must be >= 0")
    return parsed


def nonnegative_int_arg(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("value must be >= 0")
    return parsed


def canonical_pgbb_control_readback_per_step_arg(value: str) -> int:
    parsed = nonnegative_int_arg(value)
    if parsed != DEFAULT_GPU_PGBB_CONTROL_READBACK_PER_STEP:
        raise argparse.ArgumentTypeError(
            "PG-BB control-readback budget must be 4"
        )
    return parsed


def canonical_ncg_control_readback_per_step_arg(value: str) -> int:
    parsed = nonnegative_int_arg(value)
    if parsed != DEFAULT_GPU_NCG_CONTROL_READBACK_PER_STEP:
        raise argparse.ArgumentTypeError(
            "NCG control-readback budget must be 3"
        )
    return parsed


def physical_core_count() -> int:
    cpuinfo = Path("/proc/cpuinfo")
    if cpuinfo.exists():
        physical_ids: set[tuple[str, str]] = set()
        physical_id: str | None = None
        core_id: str | None = None
        for line in cpuinfo.read_text(encoding="utf-8", errors="ignore").splitlines():
            if not line.strip():
                if physical_id is not None and core_id is not None:
                    physical_ids.add((physical_id, core_id))
                physical_id = None
                core_id = None
                continue
            key, _, value = line.partition(":")
            key = key.strip()
            value = value.strip()
            if key == "physical id":
                physical_id = value
            elif key == "core id":
                core_id = value
        if physical_id is not None and core_id is not None:
            physical_ids.add((physical_id, core_id))
        if physical_ids:
            return len(physical_ids)
    return max(1, os.cpu_count() or 1)


def resolve_thread_count_specs(
    thread_counts_arg: str,
    *,
    detected_physical_cores: int | None = None,
) -> list[ThreadCountSpec]:
    physical_cores = detected_physical_cores or physical_core_count()
    specs: list[ThreadCountSpec] = []
    for raw_token in thread_counts_arg.split(","):
        token = raw_token.strip().lower()
        if not token:
            continue
        if token == "auto":
            specs.append(ThreadCountSpec(label="auto", env_value="auto"))
        elif token == "physical_cores":
            specs.append(
                ThreadCountSpec(
                    label="physical_cores",
                    env_value=str(max(1, physical_cores)),
                )
            )
        elif token == "physical_cores/2":
            specs.append(
                ThreadCountSpec(
                    label="physical_cores/2",
                    env_value=str(max(1, physical_cores // 2)),
                )
            )
        else:
            parsed = positive_int_arg(token)
            specs.append(ThreadCountSpec(label=str(parsed), env_value=str(parsed)))
    if not specs:
        raise ValueError("at least one thread count is required")
    return specs


def demag_solver_arg(value: str) -> str:
    parsed = value.strip().upper()
    if parsed not in {"CG", "GMRES"}:
        raise argparse.ArgumentTypeError("value must be CG or GMRES")
    return parsed


def demag_preconditioner_arg(value: str) -> str:
    parsed = value.strip().upper()
    if parsed not in {"AMG", "JACOBI", "NONE", "OMIT"}:
        raise argparse.ArgumentTypeError("value must be AMG, JACOBI, NONE, or OMIT")
    return parsed


def resolve_demag_solvers(
    solvers_arg: str | None,
    default_solver: str,
) -> list[str]:
    raw = solvers_arg if solvers_arg is not None else default_solver
    solvers = [demag_solver_arg(part) for part in raw.split(",") if part.strip()]
    if not solvers:
        raise ValueError("at least one demag solver is required")
    return list(dict.fromkeys(solvers))


def resolve_demag_preconditioners(
    preconditioners_arg: str | None,
    default_preconditioner: str,
) -> list[str]:
    raw = preconditioners_arg if preconditioners_arg is not None else default_preconditioner
    preconditioners = [
        demag_preconditioner_arg(part) for part in raw.split(",") if part.strip()
    ]
    if not preconditioners:
        raise ValueError("at least one demag preconditioner is required")
    return list(dict.fromkeys(preconditioners))


def resolve_demag_rtols(rtols_arg: str | None, default_rtol: float) -> list[float]:
    raw = rtols_arg if rtols_arg is not None else repr(default_rtol)
    rtols = [positive_float_arg(part.strip()) for part in raw.split(",") if part.strip()]
    if not rtols:
        raise ValueError("at least one demag rtol is required")
    return list(dict.fromkeys(rtols))


def resolve_nonnegative_ints(raw_arg: str | None, default_value: int) -> list[int]:
    raw = raw_arg if raw_arg is not None else str(default_value)
    values = [nonnegative_int_arg(part.strip()) for part in raw.split(",") if part.strip()]
    if not values:
        raise ValueError("at least one integer value is required")
    return list(dict.fromkeys(values))


def resolve_optional_nonnegative_ints(raw_arg: str | None) -> list[int | None]:
    if raw_arg is None:
        return [None]
    values: list[int | None] = []
    for part in raw_arg.split(","):
        token = part.strip()
        if not token:
            continue
        if token.lower() in {"default", "none", "null", "-"}:
            values.append(None)
        else:
            values.append(nonnegative_int_arg(token))
    if not values:
        return [None]
    return list(dict.fromkeys(values))


def resolve_optional_nonnegative_floats(raw_arg: str | None) -> list[float | None]:
    if raw_arg is None:
        return [None]
    values: list[float | None] = []
    for part in raw_arg.split(","):
        token = part.strip()
        if not token:
            continue
        if token.lower() in {"default", "none", "null", "-"}:
            values.append(None)
        else:
            values.append(nonnegative_float_arg(token))
    if not values:
        return [None]
    return list(dict.fromkeys(values))


def demag_amg_profiles_for_preconditioner(
    preconditioner: str,
    profiles: list[tuple[int, int, int, int, float | None, int | None]],
) -> list[tuple[int, int, int, int, float | None, int | None]]:
    if preconditioner in {"AMG", "OMIT"}:
        return profiles
    return [
        (
            DEFAULT_DEMAG_AMG_RELAX_TYPE,
            DEFAULT_DEMAG_AMG_COARSENING,
            DEFAULT_DEMAG_AMG_INTERPOLATION,
            DEFAULT_DEMAG_AMG_AGGRESSIVE_COARSENING,
            DEFAULT_DEMAG_AMG_STRENGTH_THRESHOLD,
            DEFAULT_DEMAG_AMG_MAX_LEVELS,
        )
    ]


def demag_policy_pairs_for_scenario(
    scenario: str,
    solvers: list[str],
    preconditioners: list[str],
) -> list[tuple[str, str]]:
    if "demag" not in scenario:
        return [(solvers[0], preconditioners[0])]
    return [
        (solver, preconditioner)
        for solver in solvers
        for preconditioner in preconditioners
    ]


def demag_policy_env(
    demag_solver: str,
    demag_preconditioner: str,
    demag_rtol: float,
    demag_amg_profile: tuple[int, int, int, int, float | None, int | None],
    args: argparse.Namespace,
) -> dict[str, str]:
    (
        relax_type,
        coarsening,
        interpolation,
        aggressive_coarsening,
        strength_threshold,
        max_levels,
    ) = demag_amg_profile
    env = {
        "FULLMAG_BENCH_DEMAG_SOLVER": demag_solver,
        "FULLMAG_BENCH_DEMAG_PRECONDITIONER": demag_preconditioner,
        "FULLMAG_BENCH_DEMAG_RTOL": repr(demag_rtol),
        "FULLMAG_BENCH_DEMAG_MAX_ITERATIONS": str(args.demag_max_iterations),
        "FULLMAG_BENCH_DEMAG_PRINT_LEVEL": str(args.demag_print_level),
        "FULLMAG_FEM_DEMAG_AMG_RELAX_TYPE": str(relax_type),
        "FULLMAG_FEM_DEMAG_AMG_COARSENING": str(coarsening),
        "FULLMAG_FEM_DEMAG_AMG_INTERPOLATION": str(interpolation),
        "FULLMAG_FEM_DEMAG_AMG_AGGRESSIVE_COARSENING": str(aggressive_coarsening),
    }
    if strength_threshold is not None:
        env["FULLMAG_FEM_DEMAG_AMG_STRENGTH_THRESHOLD"] = repr(strength_threshold)
    if max_levels is not None:
        env["FULLMAG_FEM_DEMAG_AMG_MAX_LEVELS"] = str(max_levels)
    if args.demag_atol is not None:
        env["FULLMAG_BENCH_DEMAG_ATOL"] = repr(args.demag_atol)
    return env


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="FEM CPU/GPU benchmark sweep",
        allow_abbrev=False,
    )
    parser.add_argument(
        "--meshes",
        type=str,
        default=None,
        help="Comma-separated mesh presets or .mesh.json paths",
    )
    parser.add_argument(
        "--sizes",
        type=str,
        default=None,
        help="Legacy alias for --meshes",
    )
    parser.add_argument(
        "--steps",
        type=int,
        default=1000,
        help="Number of LLG steps per run",
    )
    parser.add_argument(
        "--min-qualified-steps",
        type=positive_int_arg,
        default=100,
        help="Minimum executed steps required by FEM CPU no-PBC adaptive readiness unless stop_reason=torque",
    )
    parser.add_argument(
        "--dt",
        type=float,
        default=1e-13,
        help="Fixed timestep in seconds",
    )
    parser.add_argument(
        "--repeat",
        type=int,
        default=1,
        help="Repeat each backend/mesh/scenario/integrator/timestep case",
    )
    parser.add_argument(
        "--thread-counts",
        type=str,
        default="auto",
        help="Comma-separated CPU thread counts: integers, physical_cores/2, physical_cores, auto",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=str(CSV_PATH),
        help="Output CSV path",
    )
    parser.add_argument(
        "--fixture-manifest",
        type=Path,
        default=None,
        help="Versioned FEM GPU performance fixture used to pin mesh and ProblemIR identity",
    )
    parser.add_argument(
        "--fixture-environment",
        type=Path,
        default=None,
        help="Accepted environment that pins the fixture manifest path and SHA-256",
    )
    parser.add_argument(
        "--require-fixture-identity",
        action="store_true",
        help="Fail unless every completed row matches --fixture-manifest",
    )
    parser.add_argument(
        "--write-fixture-manifest",
        type=Path,
        default=None,
        help="Generate the versioned primary FEM GPU performance fixture and exit",
    )
    parser.add_argument(
        "--write-fixture-suite",
        type=Path,
        default=None,
        help="Generate the three-resolution FEM GPU AMG qualification fixture suite and exit",
    )
    parser.add_argument(
        "--scenarios",
        type=str,
        default=",".join(DEFAULT_SCENARIOS),
        help="Comma-separated scenarios: exchange_only, exchange_only_box500_airbox1um, exchange_demag, exchange_anis_uniaxial, exchange_anis_cubic, exchange_demag_anis_uniaxial, exchange_demag_anis_cubic, exchange_demag_anisotropy, exchange_dmi, stt_oersted",
    )
    parser.add_argument(
        "--integrators",
        type=str,
        default=None,
        help="Comma-separated integrators: heun, rk4, rk23, rk45",
    )
    parser.add_argument(
        "--relax-algorithms",
        type=str,
        default="llg_overdamped",
        help="Comma-separated relaxation algorithms for relaxation scenarios: llg_overdamped, projected_gradient_bb, nonlinear_cg",
    )
    parser.add_argument(
        "--timestep-policies",
        type=str,
        default=",".join(DEFAULT_TIMESTEP_POLICIES),
        help="Comma-separated timestep policies: fixed, adaptive",
    )
    parser.add_argument(
        "--demag-solver",
        type=demag_solver_arg,
        default="CG",
        help="Native FEM demag linear solver: CG or GMRES",
    )
    parser.add_argument(
        "--demag-solvers",
        type=str,
        default=None,
        help="Comma-separated native FEM demag linear solvers for policy sweeps",
    )
    parser.add_argument(
        "--demag-preconditioner",
        type=demag_preconditioner_arg,
        default="AMG",
        help="Native FEM demag preconditioner: AMG, JACOBI, NONE, or OMIT to leave policy unspecified",
    )
    parser.add_argument(
        "--demag-preconditioners",
        type=str,
        default=None,
        help="Comma-separated native FEM demag preconditioners for policy sweeps; use OMIT to leave policy unspecified",
    )
    parser.add_argument(
        "--demag-rtol",
        type=float,
        default=1e-8,
        help="Native FEM demag linear-solver relative tolerance",
    )
    parser.add_argument(
        "--demag-rtols",
        type=str,
        default=None,
        help="Comma-separated native FEM demag relative tolerances for policy sweeps",
    )
    parser.add_argument(
        "--demag-amg-relax-types",
        type=str,
        default=None,
        help="Comma-separated Hypre BoomerAMG relax_type values for AMG policy sweeps",
    )
    parser.add_argument(
        "--demag-amg-coarsenings",
        type=str,
        default=None,
        help="Comma-separated Hypre BoomerAMG coarsening values for AMG policy sweeps",
    )
    parser.add_argument(
        "--demag-amg-interpolations",
        type=str,
        default=None,
        help="Comma-separated Hypre BoomerAMG interpolation values for AMG policy sweeps",
    )
    parser.add_argument(
        "--demag-amg-aggressive-coarsenings",
        type=str,
        default=None,
        help="Comma-separated Hypre BoomerAMG aggressive coarsening values for AMG policy sweeps",
    )
    parser.add_argument(
        "--demag-amg-strength-thresholds",
        type=str,
        default=None,
        help="Comma-separated optional Hypre BoomerAMG strong-threshold overrides; use default/none for the MFEM/Hypre default",
    )
    parser.add_argument(
        "--demag-amg-max-levels",
        type=str,
        default=None,
        help="Comma-separated optional Hypre BoomerAMG max-level overrides; use default/none for the MFEM/Hypre default",
    )
    parser.add_argument(
        "--demag-atol",
        type=float,
        default=None,
        help="Native FEM demag linear-solver absolute tolerance",
    )
    parser.add_argument(
        "--demag-max-iterations",
        type=int,
        default=500,
        help="Native FEM demag linear-solver iteration cap",
    )
    parser.add_argument(
        "--demag-print-level",
        type=nonnegative_int_arg,
        default=0,
        help="Native FEM demag Hypre print level",
    )
    parser.add_argument(
        "--require-demag-converged",
        action="store_true",
        help="Fail if demag rows are missing convergence telemetry or exceed convergence thresholds",
    )
    parser.add_argument(
        "--require-demag-setup-reused",
        action="store_true",
        help="Fail if multi-step demag rows do not report reused linear-solver setup",
    )
    parser.add_argument(
        "--require-ncg-accepted-endpoint-reuse",
        action="store_true",
        help="Fail unless steady FEM GPU NCG rows require exactly one demag solve per accepted step",
    )
    parser.add_argument(
        "--require-demag-single-setup",
        action="store_true",
        help="Fail unless multi-step FEM GPU demag rows report zero in-step setup and one compatible reused setup",
    )
    parser.add_argument(
        "--require-zero-strict-gpu-global-sync",
        action="store_true",
        help="Fail unless strict FEM GPU rows report zero audited compute-path host synchronizations",
    )
    parser.add_argument(
        "--require-fem-cpu-no-pbc-adaptive-ready",
        action="store_true",
        help="Fail unless results prove FEM CPU no-PBC exchange+demag+anisotropy adaptive readiness with demag timing telemetry",
    )
    parser.add_argument(
        "--require-cpu-gpu-consistency",
        action="store_true",
        help="Fail unless matching FEM CPU/GPU rows agree on final energy, max torque, and relaxation step count",
    )
    parser.add_argument(
        "--require-gpu-strict-residency",
        action="store_true",
        help="Fail unless completed FEM GPU rows report device source-of-truth and zero hot-loop compute host transfers/syncs",
    )
    parser.add_argument(
        "--require-gpu-control-readback-budget",
        action="store_true",
        help="Fail unless completed FEM GPU rows stay within the configured hot-loop control-scalar readback budget",
    )
    parser.add_argument(
        "--require-gpu-phase-timings",
        action="store_true",
        help=(
            "When FULLMAG_FEM_STEP_PROFILE is enabled, fail unless completed FEM GPU rows "
            "publish positive phase timings for the executed GPU work"
        ),
    )
    parser.add_argument(
        "--require-min-solver-nodes",
        type=positive_int_arg,
        default=None,
        help="Fail unless completed benchmark rows report at least this many solver mesh nodes",
    )
    parser.add_argument(
        "--gpu-control-readback-base",
        type=nonnegative_int_arg,
        default=DEFAULT_GPU_CONTROL_READBACK_BASE,
        help="Allowed fixed FEM GPU hot-loop control-scalar readbacks per row",
    )
    parser.add_argument(
        "--gpu-control-readback-per-step",
        type=nonnegative_int_arg,
        default=DEFAULT_GPU_CONTROL_READBACK_PER_STEP,
        help="Allowed FEM GPU hot-loop control-scalar readbacks per executed step",
    )
    parser.add_argument(
        "--gpu-llg-control-readback-per-step",
        type=nonnegative_int_arg,
        default=DEFAULT_GPU_LLG_CONTROL_READBACK_PER_STEP,
        help="Allowed FEM GPU hot-loop control-scalar readbacks per LLG executed step",
    )
    parser.add_argument(
        "--gpu-pgbb-control-readback-per-step",
        type=canonical_pgbb_control_readback_per_step_arg,
        default=DEFAULT_GPU_PGBB_CONTROL_READBACK_PER_STEP,
        help="Canonical FEM GPU PG-BB hot-loop control-scalar readbacks per executed step (must be 4)",
    )
    parser.add_argument(
        "--gpu-ncg-control-readback-per-step",
        type=canonical_ncg_control_readback_per_step_arg,
        default=DEFAULT_GPU_NCG_CONTROL_READBACK_PER_STEP,
        help="Canonical FEM GPU NCG hot-loop control-scalar readbacks per executed step (must be 3)",
    )
    parser.add_argument(
        "--gpu-control-readback-per-rejected-attempt",
        type=nonnegative_int_arg,
        default=DEFAULT_GPU_CONTROL_READBACK_PER_REJECTED_ATTEMPT,
        help=(
            "Allowed FEM GPU hot-loop control-scalar readbacks per rejected "
            "non-direct-minimizer attempt; direct minimizer trials are derived "
            "from cumulative rhs_evals"
        ),
    )
    parser.add_argument(
        "--cpu-gpu-summary-output",
        type=str,
        default=None,
        help="Optional JSON output path for paired FEM CPU/GPU consistency and timing summary",
    )
    parser.add_argument(
        "--human-report-output",
        type=str,
        default=None,
        help="Optional Markdown report path for a human-readable FEM CPU/GPU benchmark summary",
    )
    parser.add_argument(
        "--pdf-report-output",
        type=str,
        default=None,
        help="Optional PDF report path for a human-readable FEM CPU/GPU benchmark summary",
    )
    parser.add_argument(
        "--quiet-json-summary",
        action="store_true",
        help="Suppress large machine-readable JSON summary lines on stdout",
    )
    parser.add_argument(
        "--relax-torque-tolerance-t",
        type=positive_float_arg,
        default=None,
        help="Relaxation torque stop tolerance in tesla; converted to A/m for the benchmark script",
    )
    parser.add_argument(
        "--relax-torque-tolerance-apm",
        type=positive_float_arg,
        default=None,
        help="Relaxation torque stop tolerance in A/m for the benchmark script",
    )
    parser.add_argument(
        "--case-timeout-s",
        type=positive_float_arg,
        default=300.0,
        help="Maximum wall time in seconds for each backend/scenario/integrator case",
    )
    parser.add_argument(
        "--fem-cpu-no-pbc-adaptive-ready-preset",
        action="store_true",
        help="Preset the sweep and gates for FEM CPU no-PBC exchange+demag+anisotropy adaptive readiness",
    )
    parser.add_argument(
        "--box500-airbox-exchange-only-preset",
        action="store_true",
        help="Preset the first FEM CPU/GPU consistency case: 500x100x10 nm box, 1 um airbox, exchange only",
    )
    parser.add_argument(
        "--box500-airbox-interaction-consistency-preset",
        action="store_true",
        help="Preset the deterministic FEM CPU/GPU interaction consistency matrix on the 500x100x10 nm box with 1 um airbox",
    )
    parser.add_argument(
        "--demag-convergence-residual",
        type=positive_float_arg,
        default=None,
        help="Maximum accepted demag final residual norm when --require-demag-converged is set; defaults to --demag-rtol",
    )
    parser.add_argument(
        "--demag-convergence-max-iterations",
        type=positive_int_arg,
        default=None,
        help="Maximum accepted demag actual iterations when --require-demag-converged is set",
    )
    parser.add_argument(
        "--max-demag-solver-apply-ms",
        type=positive_float_arg,
        default=None,
        help="Maximum accepted demag_solver_apply_wall_time_ms for completed demag benchmark rows",
    )
    parser.add_argument(
        "--emit-best-demag-policy",
        action="store_true",
        help="Print FEM_BEST_DEMAG_POLICY JSON summaries for the fastest converged demag policy in each logical case",
    )
    parser.add_argument(
        "--best-demag-policy-metric",
        choices=BEST_DEMAG_POLICY_METRICS,
        default=DEFAULT_BEST_DEMAG_POLICY_METRIC,
        help="Timing field used to choose the fastest converged demag policy",
    )
    parser.add_argument(
        "--require-best-demag-policy",
        action="store_true",
        help="Fail if a demag policy sweep does not compare at least two converged policies per logical case",
    )
    parser.add_argument(
        "--accepted-baseline",
        type=str,
        default=None,
        help="CSV from the last accepted benchmark matrix used for performance regression checks",
    )
    parser.add_argument(
        "--require-accepted-baseline",
        action="store_true",
        help="Fail if no accepted baseline CSV is supplied or no rows are comparable",
    )
    parser.add_argument(
        "--max-performance-regression-percent",
        type=positive_float_arg,
        default=DEFAULT_MAX_PERFORMANCE_REGRESSION_PERCENT,
        help="Maximum accepted performance regression versus --accepted-baseline for identical solver_mesh_signature cases",
    )
    parser.add_argument(
        "--min-gpu-demag-total-speedup",
        type=positive_float_arg,
        default=None,
        help="Fail unless completed CPU/GPU demag pairs reach this CPU/GPU speedup on full demag_wall_time_ms",
    )
    parser.add_argument(
        "--cpu-gpu-energy-rtol",
        type=positive_float_arg,
        default=DEFAULT_CPU_GPU_ENERGY_RTOL,
        help="Relative tolerance for FEM CPU/GPU energy consistency checks",
    )
    parser.add_argument(
        "--cpu-gpu-energy-atol",
        type=positive_float_arg,
        default=DEFAULT_CPU_GPU_ENERGY_ATOL_J,
        help="Absolute tolerance in joules for FEM CPU/GPU energy consistency checks",
    )
    parser.add_argument(
        "--cpu-gpu-torque-rtol",
        type=positive_float_arg,
        default=DEFAULT_CPU_GPU_TORQUE_RTOL,
        help="Relative tolerance for FEM CPU/GPU max-torque consistency checks",
    )
    parser.add_argument(
        "--cpu-gpu-torque-atol-apm",
        type=positive_float_arg,
        default=DEFAULT_CPU_GPU_TORQUE_ATOL_APM,
        help="Absolute tolerance in A/m for FEM CPU/GPU max_torque_Apm consistency checks",
    )
    parser.add_argument(
        "--cpu-gpu-torque-atol-t",
        type=positive_float_arg,
        default=DEFAULT_CPU_GPU_TORQUE_ATOL_T,
        help="Absolute tolerance in T for FEM CPU/GPU max_torque_T consistency checks",
    )
    parser.add_argument(
        "--cpu-gpu-max-step-delta",
        type=nonnegative_int_arg,
        default=DEFAULT_CPU_GPU_MAX_STEP_DELTA,
        help="Maximum allowed FEM CPU/GPU executed-step count difference",
    )
    parser.add_argument(
        "--gmsh-threads",
        type=positive_int_arg,
        default=None,
        help="Set FULLMAG_GMSH_THREADS for generated shared-domain meshes",
    )
    parser.add_argument(
        "--backends",
        type=str,
        default=",".join(DEFAULT_BACKENDS),
        help="Comma-separated backends: cpu, gpu, or cpu,gpu",
    )
    parser.add_argument(
        "--preflight",
        "--preflight-only",
        dest="preflight_only",
        action="store_true",
        help="Check native FEM/MFEM benchmark readiness and exit without running benchmarks",
    )
    parser.add_argument(
        "--require-mfem-stack",
        action="store_true",
        help="Fail before benchmarking unless a prebuilt native FEM library or MFEM package config is available",
    )
    parser.add_argument(
        "--require-adaptive-gpu-rk-acceptance",
        action="store_true",
        help="Fail before benchmarking unless adaptive GPU RK acceptance preflight is ready",
    )
    parser.add_argument(
        "--skip-preflight",
        action="store_true",
        help="Do not print or enforce the native FEM/MFEM preflight report",
    )
    parser.add_argument(
        "--require-stable-solver-mesh",
        action="store_true",
        help="Fail if repeated rows for the same logical case produce different solver mesh signatures",
    )
    parser.add_argument(
        "--gpu-warmup",
        action="store_true",
        help="Run one unrecorded FEM GPU case before measured rows to remove CUDA/Hypre cold-start from policy timing",
    )
    parser.add_argument(
        "--reuse-generated-domain-mesh",
        action="store_true",
        help="Materialize each generated shared-domain benchmark mesh once and reuse it as an explicit domain mesh across policy/backend rows",
    )
    parser.add_argument(
        "--generated-domain-mesh-cache-dir",
        type=Path,
        default=None,
        help="Optional persistent cache directory for generated shared-domain meshes used by --reuse-generated-domain-mesh",
    )
    return parser.parse_args(argv)


def resolve_relax_torque_tolerance_apm(args: argparse.Namespace) -> float | None:
    tolerance_t = args.relax_torque_tolerance_t
    tolerance_apm = args.relax_torque_tolerance_apm
    if tolerance_t is None:
        return tolerance_apm
    converted_apm = tolerance_t / MU0
    if tolerance_apm is not None and not math.isclose(
        converted_apm,
        tolerance_apm,
        rel_tol=1e-12,
        abs_tol=1e-18,
    ):
        raise ValueError(
            "--relax-torque-tolerance-t conflicts with --relax-torque-tolerance-apm"
        )
    return converted_apm


def apply_fem_cpu_no_pbc_adaptive_ready_preset(args: argparse.Namespace) -> None:
    if not args.fem_cpu_no_pbc_adaptive_ready_preset:
        return
    args.backends = "cpu"
    args.scenarios = "exchange_demag_anis_uniaxial,exchange_demag_anis_cubic"
    if args.integrators is None:
        args.integrators = "rk23,rk45"
    args.timestep_policies = "adaptive"
    args.thread_counts = "1,physical_cores/2,physical_cores,auto"
    args.require_mfem_stack = True
    args.require_demag_converged = True
    args.require_fem_cpu_no_pbc_adaptive_ready = True
    args.require_stable_solver_mesh = True
    args.emit_best_demag_policy = True
    args.require_best_demag_policy = True


def apply_box500_airbox_exchange_only_preset(args: argparse.Namespace) -> None:
    if not args.box500_airbox_exchange_only_preset:
        return
    args.backends = "cpu,gpu"
    args.meshes = "coarse"
    args.scenarios = BOX500_AIRBOX_SCENARIO
    if args.integrators is None:
        args.integrators = "heun"
    if args.timestep_policies == ",".join(DEFAULT_TIMESTEP_POLICIES):
        args.timestep_policies = "fixed"
    args.thread_counts = "auto"
    args.require_mfem_stack = True
    args.require_stable_solver_mesh = True
    args.require_cpu_gpu_consistency = True


def apply_box500_airbox_interaction_consistency_preset(args: argparse.Namespace) -> None:
    if not args.box500_airbox_interaction_consistency_preset:
        return
    args.backends = "cpu,gpu"
    args.meshes = "coarse"
    args.scenarios = ",".join(BOX500_AIRBOX_CONSISTENCY_SCENARIOS)
    if args.integrators is None:
        args.integrators = "heun"
    if args.timestep_policies == ",".join(DEFAULT_TIMESTEP_POLICIES):
        args.timestep_policies = "fixed"
    args.thread_counts = "auto"
    args.require_mfem_stack = True
    args.require_stable_solver_mesh = True
    args.require_demag_converged = True
    args.require_cpu_gpu_consistency = True
    args.require_gpu_strict_residency = True


def canonical_consistency_scenario(scenario: str) -> str:
    return RELAXATION_SCENARIO_ALIASES.get(
        scenario,
        BOX500_AIRBOX_SCENARIO_ALIASES.get(scenario, scenario),
    )


def benchmark_scenario_uses_relaxation(scenario: str) -> bool:
    return (
        scenario in BOX500_AIRBOX_SCENARIO_ALIASES
        or scenario in RELAXATION_SCENARIO_ALIASES
    )


def interaction_contract_for_scenario(scenario: str) -> Mapping[str, object] | None:
    return INTERACTION_CONTRACTS.get(canonical_consistency_scenario(scenario))


def scenario_has_interaction(scenario: object, interaction: str) -> bool:
    if not isinstance(scenario, str):
        return False
    contract = interaction_contract_for_scenario(scenario)
    if contract is None:
        return False
    interactions = contract.get("interactions")
    return isinstance(interactions, list) and interaction in interactions


def requires_phase2_compute_hot_loop_gate(scenario: object) -> bool:
    return isinstance(scenario, str) and (
        canonical_consistency_scenario(scenario) == "exchange_only"
        or scenario_has_interaction(scenario, "demag")
    )


def scenario_energy_fields(scenario: str) -> list[str]:
    contract = interaction_contract_for_scenario(scenario)
    extra_fields = contract.get("energy_fields", []) if contract else []
    fields = ["final_e_total_j", "final_e_ex_j"]
    for field in extra_fields:
        if field not in fields:
            fields.append(str(field))
    return fields


def scenario_observables(scenario: str) -> list[str]:
    contract = interaction_contract_for_scenario(scenario)
    extra_timings = contract.get("timing_fields", []) if contract else []
    observables = list(BASE_CPU_GPU_OBSERVABLES)
    for field in scenario_energy_fields(scenario):
        if field not in observables:
            observables.append(field)
    for field in extra_timings:
        if field not in observables:
            observables.append(str(field))
    return observables


def relaxation_algorithms_for_scenario(
    scenario: str,
    relaxation_algorithms: list[str],
) -> list[str]:
    canonical_scenario = canonical_consistency_scenario(scenario)
    if canonical_scenario in NONCONSERVATIVE_RELAXATION_SCENARIOS:
        return []
    interactions = set(
        interaction_contract_for_scenario(canonical_scenario).get("interactions", [])
    )
    return relaxation_algorithms


def is_direct_minimizer_relaxation_algorithm(algorithm: object) -> bool:
    return str(algorithm or "") in ENERGY_MINIMIZER_RELAXATION_ALGORITHMS


def qualified_demag_rtol_for_relaxation_algorithm(
    algorithm: object,
    requested_rtol: float,
) -> float:
    if is_direct_minimizer_relaxation_algorithm(algorithm):
        return min(requested_rtol, MAX_DIRECT_MINIMIZER_DEMAG_RTOL)
    return requested_rtol


def required_backends_for_relaxation_algorithm(algorithm: str | None) -> list[str]:
    if algorithm in CPU_ONLY_RELAXATION_ALGORITHMS:
        return ["fem_cpu"]
    return ["fem_cpu", "fem_gpu"]


def relaxation_algorithm_supported_on_backend(
    algorithm: str | None,
    backend: str,
) -> bool:
    return backend in required_backends_for_relaxation_algorithm(algorithm)


def cpu_gpu_energy_atol_for_scenario(scenario: object, energy_atol: float) -> float:
    if canonical_consistency_scenario(str(scenario or "")) in NONCONSERVATIVE_RELAXATION_SCENARIOS:
        return max(energy_atol, NONCONSERVATIVE_CPU_GPU_ENERGY_ATOL_J)
    return energy_atol


def box500_airbox_interaction_manifest(
    scenario: str,
    *,
    steps: int,
    dt: float,
    relaxation_algorithm: str = "llg_overdamped",
    energy_rtol: float,
    energy_atol: float,
    torque_rtol: float,
    torque_atol_apm: float,
    torque_atol_t: float,
    max_step_delta: int,
    relax_torque_tolerance_apm: float | None = None,
    relax_torque_tolerance_t: float | None = None,
) -> dict[str, object]:
    contract = interaction_contract_for_scenario(scenario)
    if contract is None:
        raise ValueError(f"unsupported box500 airbox consistency scenario: {scenario}")
    interactions = [str(item) for item in contract["interactions"]]
    relaxation: dict[str, object] = {
        "algorithm": relaxation_algorithm,
        "max_steps": steps,
        "dt_s": dt,
    }
    if relax_torque_tolerance_apm is not None:
        relaxation["torque_tolerance_apm"] = relax_torque_tolerance_apm
    if relax_torque_tolerance_t is not None:
        relaxation["torque_tolerance_t"] = relax_torque_tolerance_t
    return {
        "case_id": scenario,
        "relaxation_algorithm": relaxation_algorithm,
        "required_backends": required_backends_for_relaxation_algorithm(relaxation_algorithm),
        "magnet_size_m": BOX500_AIRBOX_BODY_SIZE_M,
        "airbox_size_m": BOX500_AIRBOX_SIZE_M,
        "initial_magnetization": BOX500_AIRBOX_INITIAL_M,
        "interactions": interactions,
        "demag_enabled": "demag" in interactions,
        "relaxation": relaxation,
        "observables": scenario_observables(scenario),
        "cpu_gpu_tolerances": {
            "energy_rtol": energy_rtol,
            "energy_atol_j": energy_atol,
            "torque_rtol": torque_rtol,
            "torque_atol_apm": torque_atol_apm,
            "torque_atol_t": torque_atol_t,
            "max_step_delta": max_step_delta,
        },
    }


def box500_airbox_exchange_manifest(
    *,
    steps: int,
    dt: float,
    relaxation_algorithm: str = "llg_overdamped",
    energy_rtol: float,
    energy_atol: float,
    torque_rtol: float,
    torque_atol_apm: float,
    torque_atol_t: float,
    max_step_delta: int,
    relax_torque_tolerance_apm: float | None = None,
    relax_torque_tolerance_t: float | None = None,
) -> dict[str, object]:
    return box500_airbox_interaction_manifest(
        BOX500_AIRBOX_SCENARIO,
        steps=steps,
        dt=dt,
        relaxation_algorithm=relaxation_algorithm,
        energy_rtol=energy_rtol,
        energy_atol=energy_atol,
        torque_rtol=torque_rtol,
        torque_atol_apm=torque_atol_apm,
        torque_atol_t=torque_atol_t,
        max_step_delta=max_step_delta,
        relax_torque_tolerance_apm=relax_torque_tolerance_apm,
        relax_torque_tolerance_t=relax_torque_tolerance_t,
    )


def cpu_gpu_case_manifests(
    *,
    scenarios: list[str],
    steps: int,
    dt: float,
    energy_rtol: float,
    energy_atol: float,
    torque_rtol: float,
    torque_atol_apm: float,
    torque_atol_t: float,
    max_step_delta: int,
    relaxation_algorithms: list[str] | None = None,
    relax_torque_tolerance_apm: float | None = None,
    relax_torque_tolerance_t: float | None = None,
) -> list[dict[str, object]]:
    manifests: list[dict[str, object]] = []
    explicit_relaxation_algorithms = relaxation_algorithms is not None
    effective_algorithms = relaxation_algorithms or ["llg_overdamped"]
    for scenario in scenarios:
        if not benchmark_scenario_uses_relaxation(scenario):
            continue
        for relaxation_algorithm in relaxation_algorithms_for_scenario(
            scenario,
            effective_algorithms,
        ):
            manifest = box500_airbox_interaction_manifest(
                scenario,
                steps=steps,
                dt=dt,
                relaxation_algorithm=relaxation_algorithm,
                energy_rtol=energy_rtol,
                energy_atol=energy_atol,
                torque_rtol=torque_rtol,
                torque_atol_apm=torque_atol_apm,
                torque_atol_t=torque_atol_t,
                max_step_delta=max_step_delta,
                relax_torque_tolerance_apm=relax_torque_tolerance_apm,
                relax_torque_tolerance_t=relax_torque_tolerance_t,
            )
            if not explicit_relaxation_algorithms:
                manifest["relaxation_algorithm"] = None
                manifest["required_backends"] = ["fem_cpu", "fem_gpu"]
            manifests.append(manifest)
    return manifests


def benchmark_mesh_env(args: argparse.Namespace) -> dict[str, str]:
    env = {
        key: value
        for key in ("FULLMAG_BENCH_DOMAIN_HMAX", "FULLMAG_BENCH_AIRBOX_HMAX")
        if (value := os.environ.get(key))
    }
    if args.gmsh_threads is not None:
        env["FULLMAG_GMSH_THREADS"] = str(args.gmsh_threads)
    elif args.require_stable_solver_mesh or args.require_cpu_gpu_consistency:
        env["FULLMAG_GMSH_THREADS"] = "1"
    return env


def env_text(env: Mapping[str, str], key: str) -> str | None:
    value = env.get(key)
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def env_flag_enabled(value: str | None) -> bool:
    if value is None:
        return False
    return value.strip().lower() in {"1", "on", "true", "yes"}


def split_search_path(value: str | None) -> list[Path]:
    if value is None:
        return []
    return [Path(part) for part in value.split(os.pathsep) if part.strip()]


def candidate_mfem_config_paths(prefix: Path) -> list[Path]:
    return [
        prefix / "MFEMConfig.cmake",
        prefix / "mfem-config.cmake",
        prefix / "lib" / "cmake" / "mfem" / "MFEMConfig.cmake",
        prefix / "lib" / "cmake" / "mfem" / "mfem-config.cmake",
        prefix / "lib64" / "cmake" / "mfem" / "MFEMConfig.cmake",
        prefix / "lib64" / "cmake" / "mfem" / "mfem-config.cmake",
        prefix / "share" / "mfem" / "cmake" / "MFEMConfig.cmake",
        prefix / "share" / "mfem" / "cmake" / "mfem-config.cmake",
    ]


def search_mfem_prefixes(env: Mapping[str, str]) -> list[Path]:
    prefixes: list[Path] = []
    seen: set[str] = set()
    for key in ("MFEM_PREFIX", "MFEM_DIR"):
        value = env_text(env, key)
        if value is None:
            continue
        path = Path(value)
        text = str(path)
        if text not in seen:
            seen.add(text)
            prefixes.append(path)
    for path in split_search_path(env_text(env, "CMAKE_PREFIX_PATH")):
        text = str(path)
        if text not in seen:
            seen.add(text)
            prefixes.append(path)
    return prefixes


def find_mfem_config(env: Mapping[str, str]) -> Path | None:
    for prefix in search_mfem_prefixes(env):
        for candidate in candidate_mfem_config_paths(prefix):
            if candidate.is_file():
                return candidate
    return None


def find_prebuilt_native_fem_library(env: Mapping[str, str]) -> Path | None:
    lib_dir_text = env_text(env, "FULLMAG_FEM_LIB_DIR")
    if lib_dir_text is None:
        return None
    lib_dir = Path(lib_dir_text)
    if lib_dir.is_file() and lib_dir.name in NATIVE_FEM_LIBRARY_NAMES:
        return lib_dir
    for library_name in NATIVE_FEM_LIBRARY_NAMES:
        candidate = lib_dir / library_name
        if candidate.is_file():
            return candidate
    return None


def resolve_cuda_compiler(env: Mapping[str, str]) -> tuple[str | None, str | None]:
    for key in ("FULLMAG_CUDA_COMPILER", "CUDACXX"):
        value = env_text(env, key)
        if value is None:
            continue
        candidate = Path(value)
        if candidate.is_file():
            return str(candidate), key
        resolved = shutil.which(value)
        if resolved is not None:
            return resolved, key

    for key in ("CUDA_HOME", "CUDA_PATH"):
        value = env_text(env, key)
        if value is None:
            continue
        candidate = Path(value) / "bin" / "nvcc"
        if candidate.is_file():
            return str(candidate), key

    resolved = shutil.which("nvcc")
    if resolved is not None:
        return resolved, "PATH"
    return None, None


def preflight_remediation() -> list[str]:
    return [
        "Set FULLMAG_FEM_LIB_DIR to a directory containing libfullmag_fem.so, libfullmag_fem.dylib, or fullmag_fem.dll.",
        "Or set MFEM_DIR or MFEM_PREFIX to an MFEM install prefix containing MFEMConfig.cmake or mfem-config.cmake.",
        "Or add the MFEM install prefix to CMAKE_PREFIX_PATH using the platform path separator.",
        "For CUDA builds, expose nvcc through PATH, FULLMAG_CUDA_COMPILER, CUDACXX, CUDA_HOME, or CUDA_PATH.",
    ]


def build_preflight_report(
    env: Mapping[str, str] | None = None,
) -> dict[str, object]:
    actual_env = os.environ if env is None else env
    prebuilt_root = env_text(actual_env, "FULLMAG_FEM_LIB_DIR")
    use_mfem_stack = env_text(actual_env, "FULLMAG_USE_MFEM_STACK")
    mfem_prefix = env_text(actual_env, "MFEM_PREFIX")
    mfem_dir = env_text(actual_env, "MFEM_DIR")
    cmake_prefix_path = env_text(actual_env, "CMAKE_PREFIX_PATH")
    prebuilt_library = find_prebuilt_native_fem_library(actual_env)
    searched_prefixes = [str(path) for path in search_mfem_prefixes(actual_env)]
    cuda_compiler_path, cuda_compiler_source = resolve_cuda_compiler(actual_env)
    try:
        fem_cmake_text = FEM_CMAKE.read_text(encoding="utf-8")
    except OSError:
        fem_cmake_text = ""
    try:
        adaptive_decision_readback_text = GPU_RK_ADAPTIVE_DECISION_READBACK_SOURCE.read_text(
            encoding="utf-8"
        )
    except OSError:
        adaptive_decision_readback_text = ""

    assert_no_hot_loop_compute_sync = env_flag_enabled(
        env_text(actual_env, "FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC")
    )
    adaptive_hot_loop_compute_readback_free = (
        adaptive_decision_readback_text != ""
        and "gpu_rk_read_scalar_result(" not in adaptive_decision_readback_text
        and "cudaMemcpyAsync GPU RK adaptive decision scalar device->host"
        not in adaptive_decision_readback_text
    )
    adaptive_hot_loop_control_readback = (
        adaptive_decision_readback_text != ""
        and "gpu_rk_read_control_scalar_result(" in adaptive_decision_readback_text
        and "cudaMemcpyAsync GPU RK adaptive decision control scalar device->host"
        in adaptive_decision_readback_text
    )
    report: dict[str, object] = {
        "status": "missing",
        "fullmag_fem_lib_dir": prebuilt_root,
        "fullmag_use_mfem_stack": use_mfem_stack,
        "fullmag_use_mfem_stack_enabled": env_flag_enabled(use_mfem_stack),
        "mfem_prefix": mfem_prefix,
        "mfem_dir": mfem_dir,
        "cmake_prefix_path": cmake_prefix_path,
        "searched_mfem_prefixes": searched_prefixes,
        "prebuilt_library_path": None,
        "mfem_config_path": None,
        "cuda_compiler_available": cuda_compiler_path is not None,
        "cuda_compiler_path": cuda_compiler_path,
        "cuda_compiler_source": cuda_compiler_source,
        "assert_no_hot_loop_compute_sync": assert_no_hot_loop_compute_sync,
        "gpu_rk_cuda_source_path": str(GPU_RK_CUDA_SOURCE),
        "gpu_rk_cuda_source_present": GPU_RK_CUDA_SOURCE.is_file(),
        "gpu_rk_cmake_wired": GPU_RK_CMAKE_SOURCE in fem_cmake_text,
        "adaptive_gpu_rk_hot_loop_compute_readback_free": adaptive_hot_loop_compute_readback_free,
        "adaptive_gpu_rk_hot_loop_scalar_readback_free": adaptive_hot_loop_compute_readback_free,
        "adaptive_gpu_rk_hot_loop_control_readback": adaptive_hot_loop_control_readback,
        "adaptive_gpu_rk_hot_loop_scalar_readback_path": str(
            GPU_RK_ADAPTIVE_DECISION_READBACK_SOURCE
        ),
        "remediation": preflight_remediation(),
    }

    def finish_report() -> dict[str, object]:
        adaptive_blockers = adaptive_gpu_rk_acceptance_blockers(report)
        report["adaptive_gpu_rk_acceptance_ready"] = len(adaptive_blockers) == 0
        report["adaptive_gpu_rk_acceptance_blockers"] = adaptive_blockers
        return report

    if prebuilt_root is not None:
        if prebuilt_library is None:
            report["status"] = "invalid_prebuilt"
            return finish_report()
        report["status"] = "ok_prebuilt"
        report["prebuilt_library_path"] = str(prebuilt_library)
        return finish_report()

    mfem_config = find_mfem_config(actual_env)
    if mfem_config is not None:
        report["status"] = "ok_mfem_config"
        report["mfem_config_path"] = str(mfem_config)

    return finish_report()


def is_mfem_stack_ready(report: Mapping[str, object]) -> bool:
    return report.get("status") in {"ok_prebuilt", "ok_mfem_config"}


def adaptive_gpu_rk_acceptance_blockers(report: Mapping[str, object]) -> list[str]:
    blockers: list[str] = []
    if not is_mfem_stack_ready(report):
        blockers.append("MFEM stack or prebuilt native FEM library is required")
    if not report.get("cuda_compiler_available"):
        blockers.append(
            "nvcc (set PATH, FULLMAG_CUDA_COMPILER, CUDACXX, CUDA_HOME, or CUDA_PATH)"
        )
    if not report.get("gpu_rk_cuda_source_present"):
        blockers.append("backends/fem/gpu/cuda/integrators/rk/rk_step.cu is required")
    if not report.get("gpu_rk_cmake_wired"):
        blockers.append(
            "backends/fem/CMakeLists.txt must wire gpu/cuda/integrators/rk/rk_step.cu"
        )
    if not report.get("assert_no_hot_loop_compute_sync"):
        blockers.append("FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC=1")
    if not report.get("adaptive_gpu_rk_hot_loop_compute_readback_free"):
        blockers.append(
            "adaptive GPU RK still performs hot-loop compute readback for accept/reject"
        )
    return blockers


def preflight_failures(
    report: Mapping[str, object],
    *,
    require_mfem_stack: bool,
    require_adaptive_gpu_rk_acceptance: bool = False,
) -> list[str]:
    failures: list[str] = []
    if require_mfem_stack and not is_mfem_stack_ready(report):
        if report.get("status") == "invalid_prebuilt":
            failures.append(
                "FULLMAG_FEM_LIB_DIR is set but no expected native FEM library was found. "
                + " ".join(str(item) for item in report.get("remediation", []))
            )
        else:
            failures.append(
                "MFEM/prebuilt native FEM stack is required but was not found. "
                + " ".join(str(item) for item in report.get("remediation", []))
            )
    if (
        require_adaptive_gpu_rk_acceptance
        and report.get("adaptive_gpu_rk_acceptance_ready") is not True
    ):
        blockers = report.get("adaptive_gpu_rk_acceptance_blockers", [])
        blocker_text = ", ".join(str(item) for item in blockers)
        failures.append(
            "adaptive GPU RK acceptance is required but not ready"
            + (f": {blocker_text}" if blocker_text else "")
        )
    return failures


def resolve_mesh_token(token: str) -> Path:
    cleaned = token.strip()
    if not cleaned:
        raise ValueError("empty mesh token")
    if cleaned in PRESET_MESHES:
        return PRESET_MESHES[cleaned]
    candidate = Path(cleaned)
    if not candidate.is_absolute():
        candidate = REPO_ROOT / candidate
    return candidate


def resolve_meshes(meshes_arg: str | None, sizes_arg: str | None) -> list[Path]:
    raw = meshes_arg or sizes_arg
    tokens = DEFAULT_MESHES if raw is None else [part for part in raw.split(",") if part.strip()]
    meshes = [resolve_mesh_token(token) for token in tokens]
    return meshes


def resolve_scenarios(scenarios_arg: str) -> list[str]:
    scenarios = [part.strip().lower() for part in scenarios_arg.split(",") if part.strip()]
    if not scenarios:
        raise ValueError("at least one benchmark scenario is required")
    return scenarios


def resolve_integrators(integrators_arg: str) -> list[str]:
    integrators = [part.strip().lower() for part in integrators_arg.split(",") if part.strip()]
    if not integrators:
        raise ValueError("at least one benchmark integrator is required")
    supported = set(DEFAULT_INTEGRATORS)
    unsupported = sorted(set(integrators) - supported)
    if unsupported:
        supported_text = ", ".join(DEFAULT_INTEGRATORS)
        raise ValueError(
            f"unsupported benchmark integrator(s): {', '.join(unsupported)}; "
            f"supported: {supported_text}"
        )
    return integrators


def resolve_relaxation_algorithms(algorithms_arg: str) -> list[str]:
    algorithms = [
        part.strip().lower()
        for part in algorithms_arg.split(",")
        if part.strip()
    ]
    if not algorithms:
        raise ValueError("at least one relaxation algorithm is required")
    supported = set(SUPPORTED_RELAXATION_ALGORITHMS)
    unsupported = sorted(set(algorithms) - supported)
    if unsupported:
        supported_text = ", ".join(SUPPORTED_RELAXATION_ALGORITHMS)
        raise ValueError(
            f"unsupported relaxation algorithm(s): {', '.join(unsupported)}; "
            f"production-supported: {supported_text}"
        )
    return list(dict.fromkeys(algorithms))


def resolve_timestep_policies(policies_arg: str) -> list[str]:
    policies = [part.strip().lower() for part in policies_arg.split(",") if part.strip()]
    if not policies:
        raise ValueError("at least one benchmark timestep policy is required")
    supported = {"fixed", "adaptive"}
    unsupported = sorted(set(policies) - supported)
    if unsupported:
        raise ValueError(
            f"unsupported benchmark timestep policy/policies: {', '.join(unsupported)}; "
            "supported: fixed, adaptive"
        )
    return policies


def resolve_backends(backends_arg: str) -> list[str]:
    requested = [part.strip().lower() for part in backends_arg.split(",") if part.strip()]
    if not requested:
        raise ValueError("at least one benchmark backend is required")
    resolved: list[str] = []
    unsupported: list[str] = []
    for backend in requested:
        resolved_backend = BACKEND_ALIASES.get(backend)
        if resolved_backend is None:
            unsupported.append(backend)
            continue
        if resolved_backend not in resolved:
            resolved.append(resolved_backend)
    if unsupported:
        supported_text = ", ".join(DEFAULT_BACKENDS)
        raise ValueError(
            f"unsupported benchmark backend(s): {', '.join(sorted(set(unsupported)))}; "
            f"supported: {supported_text}"
        )
    return resolved


def load_mesh_stats(mesh_path: Path) -> dict[str, object]:
    payload = json.loads(mesh_path.read_text(encoding="utf-8"))
    return {
        "mesh_name": payload.get("mesh_name", mesh_path.stem),
        "mesh_path": str(mesh_path),
        "node_count": len(payload.get("nodes", [])),
        "element_count": len(payload.get("elements", [])),
        "boundary_face_count": len(payload.get("boundary_faces", [])),
        "periodic_boundary_pair_count": len(payload.get("periodic_boundary_pairs", [])),
        "periodic_node_pair_count": len(payload.get("periodic_node_pairs", [])),
    }


def input_mesh_summary(mesh_stats: Mapping[str, object]) -> str:
    return (
        f"input_mesh={mesh_stats['mesh_name']} "
        f"input_nodes={mesh_stats['node_count']} "
        f"input_elements={mesh_stats['element_count']} "
        "(solver mesh is reported per completed row)"
    )


def benchmark_scenario_requires_shared_domain(scenario: str) -> bool:
    canonical = canonical_consistency_scenario(scenario)
    return scenario in BOX500_AIRBOX_SCENARIO_ALIASES or "demag" in canonical


def mesh_signature(mesh: Mapping[str, object]) -> str:
    payload = {
        key: mesh.get(key)
        for key in (
            "nodes",
            "elements",
            "element_markers",
            "boundary_faces",
            "boundary_markers",
            "periodic_boundary_pairs",
            "periodic_node_pairs",
        )
        if key in mesh
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def execution_plan_mesh_stats(metadata: Mapping[str, object] | None) -> dict[str, object]:
    if metadata is None:
        return {}
    execution_plan = metadata.get("execution_plan")
    if not isinstance(execution_plan, Mapping):
        return {}
    backend_plan = execution_plan.get("backend_plan")
    if not isinstance(backend_plan, Mapping):
        return {}
    if str(backend_plan.get("kind", "")).lower() not in {"fem", "fem_eigen"}:
        return {}
    mesh = backend_plan.get("mesh")
    if not isinstance(mesh, Mapping):
        return {}

    stats: dict[str, object] = {}
    mesh_name = backend_plan.get("mesh_name") or mesh.get("mesh_name")
    if isinstance(mesh_name, str) and mesh_name:
        stats["mesh_name"] = mesh_name
    domain_mesh_mode = mesh.get("domain_mesh_mode")
    if isinstance(domain_mesh_mode, str) and domain_mesh_mode:
        stats["domain_mesh_mode"] = domain_mesh_mode
    element_markers = mesh.get("element_markers")
    if isinstance(element_markers, list):
        has_air = any(marker == 0 for marker in element_markers)
        has_magnetic = any(marker != 0 for marker in element_markers)
        stats["solver_mesh_has_air"] = has_air and has_magnetic
    stats["solver_mesh_signature"] = mesh_signature(mesh)
    for source_key, output_key in (
        ("nodes", "node_count"),
        ("elements", "element_count"),
        ("boundary_faces", "boundary_face_count"),
        ("periodic_boundary_pairs", "periodic_boundary_pair_count"),
        ("periodic_node_pairs", "periodic_node_pair_count"),
    ):
        value = mesh.get(source_key)
        if isinstance(value, list):
            stats[output_key] = len(value)
    return stats


def parse_benchmark_result(output: str) -> dict[str, object] | None:
    for line in reversed(output.splitlines()):
        if line.startswith("BENCHMARK_RESULT="):
            return json.loads(line.split("=", 1)[1])
    payload = parse_cli_json_summary(output)
    if payload is not None:
        return payload
    return parse_cli_workspace_summary(output)


def parse_cli_json_summary(output: str) -> dict[str, object] | None:
    decoder = json.JSONDecoder()
    for index in range(len(output) - 1, -1, -1):
        if output[index] != "{":
            continue
        candidate = output[index:].strip()
        try:
            payload, end = decoder.raw_decode(candidate)
        except json.JSONDecodeError:
            continue
        if (
            isinstance(payload, dict)
            and "status" in payload
            and (
                "artifact_dir" in payload
                or "session_id" in payload
                or "output_dir" in payload
            )
        ):
            normalized = dict(payload)
            if "executed_steps" not in normalized and "total_steps" in normalized:
                normalized["executed_steps"] = normalized["total_steps"]
            for source, target in (
                ("final_time", "final_time_s"),
                ("final_e_ex", "final_e_ex_j"),
                ("final_e_demag", "final_e_demag_j"),
                ("final_e_ext", "final_e_ext_j"),
                ("final_e_ani", "final_e_ani_j"),
                ("final_e_dmi", "final_e_dmi_j"),
                ("final_e_total", "final_e_total_j"),
            ):
                if target not in normalized and source in normalized:
                    normalized[target] = normalized[source]
            return normalized
    return None


def parse_float_prefix(value: str) -> float | None:
    token = value.strip().split(maxsplit=1)[0]
    try:
        return float(token)
    except (IndexError, ValueError):
        return None


def parse_int_prefix(value: str) -> int | None:
    token = value.strip().split(maxsplit=1)[0]
    try:
        return int(token)
    except (IndexError, ValueError):
        return None


def parse_cli_workspace_summary(output: str) -> dict[str, object] | None:
    if "fullmag workspace summary" not in output:
        return None
    payload: dict[str, object] = {}
    key_map = {
        "status": ("status", str),
        "total_steps": ("executed_steps", parse_int_prefix),
        "final_time": ("final_time_s", parse_float_prefix),
        "final_E_ex": ("final_e_ex_j", parse_float_prefix),
        "final_E_demag": ("final_e_demag_j", parse_float_prefix),
        "final_E_ext": ("final_e_ext_j", parse_float_prefix),
        "final_E_ani": ("final_e_ani_j", parse_float_prefix),
        "final_E_dmi": ("final_e_dmi_j", parse_float_prefix),
        "final_E_total": ("final_e_total_j", parse_float_prefix),
        "artifact_dir": ("artifact_dir", str),
    }
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if not line.startswith("- ") or ":" not in line:
            continue
        key, value = line[2:].split(":", 1)
        mapping = key_map.get(key.strip())
        if mapping is None:
            continue
        out_key, parser = mapping
        parsed = parser(value.strip()) if parser is not str else value.strip()
        if parsed is not None:
            payload[out_key] = parsed
    if not payload:
        return None
    return payload


def load_metadata_file(path: Path) -> dict[str, object] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def load_run_metadata(run_dir: str) -> dict[str, object] | None:
    candidates = sorted(Path(run_dir).rglob("metadata.json"))
    if not candidates:
        return None
    return load_metadata_file(candidates[-1])


def load_final_scalar_row(run_dir: str) -> dict[str, object]:
    candidates = sorted(Path(run_dir).rglob("scalars.csv"))
    if not candidates:
        return {}
    with candidates[-1].open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    if not rows:
        return {}
    return rows[-1]


def load_authoritative_benchmark_payload(run_dir: str | Path) -> dict[str, object] | None:
    artifact_dir = Path(run_dir)
    metadata = load_run_metadata(str(artifact_dir))
    final_scalar = load_final_scalar_row(str(artifact_dir))
    if metadata is None or metadata.get("status") != "completed" or not final_scalar:
        return None
    qualification = first_present(
        metadata.get("fem_gpu_relaxation_qualification"),
        metadata.get("fem_cpu_relaxation_qualification"),
    )
    if not isinstance(qualification, Mapping):
        qualification = {}
    executed_steps = first_present(
        qualification.get("executed_steps"), metadata.get("scalar_rows")
    )
    if as_int(executed_steps) is None:
        return None

    payload: dict[str, object] = {
        "status": "completed",
        "executed_steps": executed_steps,
        "artifact_dir": str(artifact_dir),
    }
    for source, target in (
        ("time", "final_time_s"),
        ("solver_dt", "final_solver_dt_s"),
        ("E_ex", "final_e_ex_j"),
        ("E_demag", "final_e_demag_j"),
        ("E_ext", "final_e_ext_j"),
        ("E_ani", "final_e_ani_j"),
        ("E_dmi", "final_e_dmi_j"),
        ("E_total", "final_e_total_j"),
        ("max_dm_dt", "max_dm_dt"),
        ("max_h_eff", "max_h_eff"),
        ("max_h_demag", "max_h_demag"),
        ("max_torque_Apm", "max_torque_Apm"),
        ("max_torque_T", "max_torque_T"),
    ):
        if source in final_scalar:
            payload[target] = final_scalar[source]

    step_files = sorted(artifact_dir.rglob("solver_steps.csv"))
    if step_files:
        with step_files[-1].open(newline="", encoding="utf-8") as handle:
            step_rows = list(csv.DictReader(handle))
        if step_rows:
            payload["rhs_evals"] = as_int(step_rows[-1].get("rhs_evals"))
            for source, target in (
                ("rhs_evals", "total_rhs_evals"),
                ("demag_solves", "demag_solves"),
                ("rejected_attempts", "rejected_attempts"),
            ):
                values = [as_int(row.get(source)) for row in step_rows]
                if all(value is not None for value in values):
                    payload[target] = sum(value for value in values if value is not None)
    return payload


def load_final_scalar_row_from_payload(payload: Mapping[str, object] | None) -> dict[str, object]:
    if payload is None:
        return {}
    artifact_dir = payload.get("artifact_dir")
    if not isinstance(artifact_dir, str) or not artifact_dir:
        return {}
    return load_final_scalar_row(artifact_dir)


def load_metadata_from_payload(payload: Mapping[str, object] | None) -> dict[str, object] | None:
    if payload is None:
        return None
    artifact_dir = payload.get("artifact_dir")
    if not isinstance(artifact_dir, str) or not artifact_dir:
        return None
    return load_metadata_file(Path(artifact_dir) / "metadata.json")


def export_generated_domain_mesh(
    *,
    mesh_path: Path,
    scenario: str,
    integrator: str,
    steps: int,
    dt: float,
    timestep_policy: str,
    thread_spec: ThreadCountSpec,
    extra_env: dict[str, str],
    output_path: Path,
    timeout_s: float | None,
) -> Path:
    env = os.environ.copy()
    env.update(extra_env)
    apply_bundled_openmpi_runtime_env(env)
    env["FULLMAG_BENCH_MESH"] = str(mesh_path)
    env["FULLMAG_BENCH_SCENARIO"] = scenario
    env["FULLMAG_BENCH_INTEGRATOR"] = integrator
    env["FULLMAG_BENCH_TIMESTEP_POLICY"] = timestep_policy
    env["FULLMAG_BENCH_STEPS"] = str(steps)
    env["FULLMAG_BENCH_DT"] = repr(dt)
    env["FULLMAG_CPU_THREADS"] = thread_spec.env_value
    env["FULLMAG_BENCH_EXPORT_DOMAIN_MESH"] = str(output_path)
    python = env_text(env, "FULLMAG_PYTHON") or sys.executable
    run_kwargs = {
        "cwd": REPO_ROOT,
        "env": env,
        "capture_output": True,
        "text": True,
        "check": False,
    }
    if timeout_s is not None:
        run_kwargs["timeout"] = timeout_s
    try:
        completed = subprocess.run(
            [python, str(BENCH_SCRIPT)],
            **run_kwargs,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"domain mesh export timed out after {timeout_s} s for scenario={scenario}"
        ) from exc
    if completed.returncode != 0 or not output_path.is_file():
        combined = "\n".join(
            part for part in [completed.stdout, completed.stderr] if part.strip()
        )
        tail = "\n".join(combined.splitlines()[-20:])
        raise RuntimeError(
            f"domain mesh export failed for scenario={scenario} "
            f"returncode={completed.returncode}: {tail}"
        )
    return output_path


def generated_domain_mesh_env(
    *,
    cache: dict[tuple[str, ...], Path],
    cache_dir: Path | None,
    mesh_path: Path,
    scenario: str,
    integrator: str,
    steps: int,
    dt: float,
    timestep_policy: str,
    thread_spec: ThreadCountSpec,
    extra_env: dict[str, str],
    timeout_s: float | None,
) -> dict[str, str]:
    if cache_dir is None or not benchmark_scenario_requires_shared_domain(scenario):
        return {}
    key = (
        str(mesh_path),
        scenario,
        extra_env.get("FULLMAG_BENCH_DOMAIN_HMAX", ""),
        extra_env.get("FULLMAG_BENCH_AIRBOX_HMAX", ""),
    )
    cached = cache.get(key)
    if cached is None:
        digest = hashlib.sha256("|".join(key).encode("utf-8")).hexdigest()[:12]
        output_path = cache_dir / f"{digest}.domain.mesh.json"
        if output_path.is_file():
            print(
                f"    reuse cached shared-domain mesh scenario={scenario} source={output_path}",
                flush=True,
            )
            cached = output_path
        else:
            print(
                f"    materialize shared-domain mesh once scenario={scenario} output={output_path}",
                flush=True,
            )
            cached = export_generated_domain_mesh(
                mesh_path=mesh_path,
                scenario=scenario,
                integrator=integrator,
                steps=steps,
                dt=dt,
                timestep_policy=timestep_policy,
                thread_spec=thread_spec,
                extra_env=extra_env,
                output_path=output_path,
                timeout_s=timeout_s,
            )
        cache[key] = cached
    return {"FULLMAG_BENCH_DOMAIN_MESH": str(cached)}


def canonical_problem_ir(
    *,
    mesh_path: Path,
    domain_mesh_path: Path,
    scenario: str,
    integrator: str,
    relaxation_algorithm: str,
    steps: int,
    dt: float,
    timestep_policy: str,
    extra_env: Mapping[str, str],
) -> dict[str, object]:
    previous_environment = os.environ.copy()
    try:
        os.environ.update(extra_env)
        os.environ["FULLMAG_BENCH_DOMAIN_MESH"] = str(domain_mesh_path)
        os.environ["FULLMAG_BENCH_RELAX_ALGORITHM"] = relaxation_algorithm
        spec = importlib.util.spec_from_file_location(
            "fullmag_fem_gpu_benchmark_fixture_case",
            BENCH_SCRIPT,
        )
        if spec is None or spec.loader is None:
            raise RuntimeError(f"cannot load benchmark case from {BENCH_SCRIPT}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        problem = module.build(
            mesh_path=mesh_path,
            dt=dt,
            steps=steps,
            scenario=scenario,
            integrator=integrator,
            timestep_policy=timestep_policy,
        )
        problem_ir = problem.to_ir(include_geometry_assets=True)
    finally:
        os.environ.clear()
        os.environ.update(previous_environment)

    return problem_ir


def canonical_problem_ir_bytes(problem_ir: Mapping[str, object]) -> bytes:
    return json.dumps(problem_ir, sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )


def problem_ir_stop_condition(problem_ir: Mapping[str, object]) -> dict[str, object]:
    study = problem_ir.get("study")
    if not isinstance(study, Mapping):
        raise ValueError("canonical ProblemIR is missing study")
    stop = study.get("stop")
    if not isinstance(stop, Mapping):
        raise ValueError("canonical ProblemIR is missing study.stop")
    max_steps = stop.get("max_steps")
    torque_target = stop.get("torque_tolerance_apm")
    if not isinstance(max_steps, int) or max_steps <= 0:
        raise ValueError("canonical ProblemIR study.stop.max_steps must be positive")
    if not isinstance(torque_target, (int, float)) or not math.isfinite(
        float(torque_target)
    ):
        raise ValueError(
            "canonical ProblemIR study.stop.torque_tolerance_apm must be finite"
        )
    return {
        "kind": "torque_or_max_steps",
        "benchmark_only_torque_target_apm": float(torque_target),
        "max_steps": max_steps,
    }


def canonical_problem_ir_sha256(**kwargs: object) -> str:
    return hashlib.sha256(
        canonical_problem_ir_bytes(canonical_problem_ir(**kwargs))
    ).hexdigest()


def problem_ir_execution_command(
    *,
    binary: Path,
    problem_ir_path: Path,
    run_dir: Path,
    until_seconds: float,
) -> list[str]:
    return [
        str(binary),
        "run-json",
        str(problem_ir_path),
        "--until",
        repr(until_seconds),
        "--output-dir",
        str(run_dir),
    ]


def script_execution_command(binary: Path, run_dir: Path) -> list[str]:
    return [
        str(binary),
        str(BENCH_SCRIPT),
        "--headless",
        "--json",
        "--output-dir",
        str(run_dir),
        "--workspace-root",
        str(run_dir / "workspace-history"),
    ]


def parse_script_run_summary(output: str) -> Mapping[str, object] | None:
    decoder = json.JSONDecoder()
    for offset, character in reversed(tuple(enumerate(output))):
        if character != "{":
            continue
        try:
            candidate, _ = decoder.raw_decode(output[offset:])
        except json.JSONDecodeError:
            continue
        if not isinstance(candidate, Mapping):
            continue
        if (
            "workspace_dir" in candidate or "output_dir" in candidate
        ) and "backend_create_wall_time_ns" in candidate:
            return candidate
    return None


def performance_fixture_mesh_path(manifest_path: Path, resolution: str) -> Path:
    if resolution == "fine":
        name = manifest_path.name.removesuffix(".fixture.json") + ".mesh.json"
    else:
        name = f"box500_airbox_exchange_demag_amg_{resolution}_v1.mesh.json"
    return manifest_path.parent / name


def write_performance_fixture_files(
    args: argparse.Namespace,
    *,
    input_mesh_path: Path,
) -> None:
    manifest_path = (
        Path(args.write_fixture_manifest)
        if args.write_fixture_manifest is not None
        else Path(args.write_fixture_suite).parent
        / "box500_airbox_exchange_demag_v1.fixture.json"
    )
    suite_path = (
        Path(args.write_fixture_suite)
        if args.write_fixture_suite is not None
        else None
    )
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    fixture_entries: list[dict[str, object]] = []
    primary_manifest: dict[str, object] | None = None
    for resolution, domain_hmax, airbox_hmax in PERFORMANCE_FIXTURE_RESOLUTIONS:
        mesh_path = performance_fixture_mesh_path(manifest_path, resolution)
        fixture_env = {
            "FULLMAG_GMSH_THREADS": "1",
            "FULLMAG_BENCH_DOMAIN_HMAX": repr(domain_hmax),
            "FULLMAG_BENCH_AIRBOX_HMAX": repr(airbox_hmax),
            "FULLMAG_BENCH_DEMAG_SOLVER": "CG",
            "FULLMAG_BENCH_DEMAG_PRECONDITIONER": "AMG",
            "FULLMAG_BENCH_DEMAG_RTOL": repr(MAX_DIRECT_MINIMIZER_DEMAG_RTOL),
            "FULLMAG_BENCH_DEMAG_MAX_ITERATIONS": str(args.demag_max_iterations),
            "FULLMAG_BENCH_DEMAG_PRINT_LEVEL": str(args.demag_print_level),
            "FULLMAG_FEM_DEMAG_AMG_RELAX_TYPE": "6",
            "FULLMAG_FEM_DEMAG_AMG_COARSENING": "8",
            "FULLMAG_FEM_DEMAG_AMG_INTERPOLATION": "6",
            "FULLMAG_FEM_DEMAG_AMG_AGGRESSIVE_COARSENING": "1",
            "FULLMAG_BENCH_RELAX_TORQUE_TOLERANCE": repr(
                PERFORMANCE_FIXTURE_TORQUE_TARGET_APM
            ),
        }
        export_generated_domain_mesh(
            mesh_path=input_mesh_path,
            scenario=PERFORMANCE_FIXTURE_SCENARIO,
            integrator="heun",
            steps=1,
            dt=args.dt,
            timestep_policy="fixed",
            thread_spec=ThreadCountSpec(label="auto", env_value="auto"),
            extra_env=fixture_env,
            output_path=mesh_path,
            timeout_s=args.case_timeout_s,
        )
        mesh_payload = json.loads(mesh_path.read_text(encoding="utf-8"))
        mesh_sha256 = hashlib.sha256(mesh_path.read_bytes()).hexdigest()
        realization_row = run_backend(
            backend_label="fem_cpu",
            binary=FULLMAG_CPU,
            mesh_path=input_mesh_path,
            scenario=PERFORMANCE_FIXTURE_SCENARIO,
            integrator="heun",
            relaxation_algorithm=PERFORMANCE_FIXTURE_RELAXATION_ALGORITHM,
            steps=1,
            dt=args.dt,
            timestep_policy="fixed",
            thread_spec=ThreadCountSpec(label="auto", env_value="auto"),
            timeout_s=args.case_timeout_s,
            extra_env={
                "FULLMAG_FEM_EXECUTION": "cpu",
                "FULLMAG_BENCH_DOMAIN_MESH": str(mesh_path),
                **fixture_env,
            },
        )
        fixture_problem_ir = canonical_problem_ir(
            mesh_path=input_mesh_path,
            domain_mesh_path=mesh_path,
            scenario=PERFORMANCE_FIXTURE_SCENARIO,
            integrator="heun",
            relaxation_algorithm=PERFORMANCE_FIXTURE_RELAXATION_ALGORITHM,
            steps=PERFORMANCE_FIXTURE_STEPS,
            dt=args.dt,
            timestep_policy="fixed",
            extra_env=fixture_env,
        )
        problem_ir_sha256 = hashlib.sha256(
            canonical_problem_ir_bytes(fixture_problem_ir)
        ).hexdigest()
        fixture_stop_condition = problem_ir_stop_condition(fixture_problem_ir)
        entry = {
            "resolution": resolution,
            "solver_mesh_path": os.path.relpath(mesh_path, manifest_path.parent),
            "solver_mesh_sha256": mesh_sha256,
            "solver_mesh_signature": fixture_solver_mesh_signature(realization_row),
            "problem_ir_sha256": problem_ir_sha256,
            "node_count": len(mesh_payload.get("nodes", [])),
            "element_count": len(mesh_payload.get("elements", [])),
            "domain_hmax_m": domain_hmax,
            "airbox_hmax_m": airbox_hmax,
        }
        fixture_entries.append(entry)
        if resolution == "fine":
            primary_manifest = {
                "schema": PERFORMANCE_FIXTURE_SCHEMA,
                **entry,
                "scenario": PERFORMANCE_FIXTURE_SCENARIO,
                "relaxation_algorithm": PERFORMANCE_FIXTURE_RELAXATION_ALGORITHM,
                "airbox_factor": BOX500_AIRBOX_SIZE_M[0]
                / BOX500_AIRBOX_BODY_SIZE_M[0],
                "demag_policy": {
                    "solver": "CG",
                    "preconditioner": "AMG",
                    "rtol": MAX_DIRECT_MINIMIZER_DEMAG_RTOL,
                    "amg_relax_type": 6,
                    "amg_coarsening": 8,
                    "amg_interpolation": 6,
                    "amg_aggressive_coarsening": 1,
                },
                "stop_condition": fixture_stop_condition,
            }
    if primary_manifest is None:
        raise RuntimeError("fine FEM GPU performance fixture was not generated")
    if args.write_fixture_manifest is not None:
        manifest_path.write_text(
            json.dumps(primary_manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(f"Fixture manifest written to {manifest_path}")
    if suite_path is not None:
        suite_path.parent.mkdir(parents=True, exist_ok=True)
        suite_path.write_text(
            json.dumps(
                {
                    "schema": PERFORMANCE_FIXTURE_SUITE_SCHEMA,
                    "scenario": PERFORMANCE_FIXTURE_SCENARIO,
                    "airbox_factor": BOX500_AIRBOX_SIZE_M[0]
                    / BOX500_AIRBOX_BODY_SIZE_M[0],
                    "fixtures": fixture_entries,
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"Fixture suite written to {suite_path}")


def run_backend(
    *,
    backend_label: str,
    binary: Path,
    mesh_path: Path,
    scenario: str,
    integrator: str,
    steps: int,
    dt: float,
    extra_env: dict[str, str],
    relaxation_algorithm: str | None = None,
    timestep_policy: str = "fixed",
    thread_spec: ThreadCountSpec = ThreadCountSpec(label="auto", env_value="auto"),
    timeout_s: float | None = None,
    problem_ir: Mapping[str, object] | None = None,
) -> dict[str, object]:
    row = {
        "backend": backend_label,
        "scenario": scenario,
        "integrator": integrator,
        "relaxation_algorithm": relaxation_algorithm,
        "timestep_policy": timestep_policy,
        "binary": str(binary),
        "steps": steps,
        "dt_s": dt,
        "requested_cpu_thread_spec": thread_spec.label,
        "case_timeout_s": timeout_s,
        **runtime_bundle_identity(MANAGED_FEM_RUNTIME_ROOT),
        **load_mesh_stats(mesh_path),
    }
    env = os.environ.copy()
    env.update(extra_env)
    if backend_label != "fem_gpu":
        env.pop("FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC", None)
        env.pop("FULLMAG_FEM_ASSERT_NO_HOT_LOOP_HOST_SYNC", None)
    apply_bundled_openmpi_runtime_env(env)
    if "FULLMAG_FEM_EXECUTION" not in extra_env:
        if backend_label == "fem_cpu":
            env["FULLMAG_FEM_EXECUTION"] = "cpu"
        elif backend_label == "fem_gpu":
            env["FULLMAG_FEM_EXECUTION"] = "gpu"
    env["FULLMAG_CPU_THREADS"] = thread_spec.env_value
    env.setdefault("FULLMAG_PYTHON", sys.executable)
    row["requested_fullmag_python"] = env_text(env, "FULLMAG_PYTHON")
    row["requested_fem_execution"] = env_text(env, "FULLMAG_FEM_EXECUTION")
    row["requested_cpu_threads"] = env_text(env, "FULLMAG_CPU_THREADS")
    row["requested_gmsh_threads"] = env_text(env, "FULLMAG_GMSH_THREADS")
    row["requested_demag_solver"] = env_text(env, "FULLMAG_BENCH_DEMAG_SOLVER")
    row["requested_demag_preconditioner"] = env_text(
        env,
        "FULLMAG_BENCH_DEMAG_PRECONDITIONER",
    )
    row["requested_demag_relative_tolerance"] = env_text(
        env,
        "FULLMAG_BENCH_DEMAG_RTOL",
    )
    row["requested_demag_absolute_tolerance"] = env_text(
        env,
        "FULLMAG_BENCH_DEMAG_ATOL",
    )
    row["requested_demag_max_iterations"] = env_text(
        env,
        "FULLMAG_BENCH_DEMAG_MAX_ITERATIONS",
    )
    row["requested_demag_print_level"] = env_text(
        env,
        "FULLMAG_BENCH_DEMAG_PRINT_LEVEL",
    )
    row["requested_demag_amg_relax_type"] = env_text(
        env,
        "FULLMAG_FEM_DEMAG_AMG_RELAX_TYPE",
    )
    row["requested_demag_amg_coarsening"] = env_text(
        env,
        "FULLMAG_FEM_DEMAG_AMG_COARSENING",
    )
    row["requested_demag_amg_interpolation"] = env_text(
        env,
        "FULLMAG_FEM_DEMAG_AMG_INTERPOLATION",
    )
    row["requested_demag_amg_aggressive_coarsening"] = env_text(
        env,
        "FULLMAG_FEM_DEMAG_AMG_AGGRESSIVE_COARSENING",
    )
    row["requested_demag_amg_strength_threshold"] = env_text(
        env,
        "FULLMAG_FEM_DEMAG_AMG_STRENGTH_THRESHOLD",
    )
    row["requested_demag_amg_max_levels"] = env_text(
        env,
        "FULLMAG_FEM_DEMAG_AMG_MAX_LEVELS",
    )
    row["requested_relax_torque_tolerance_apm"] = env_text(
        env,
        "FULLMAG_BENCH_RELAX_TORQUE_TOLERANCE",
    )
    if problem_ir is not None:
        authored_stop = problem_ir_stop_condition(problem_ir)
        row["requested_relax_torque_tolerance_apm"] = authored_stop[
            "benchmark_only_torque_target_apm"
        ]
    row["requested_relaxation_algorithm"] = relaxation_algorithm
    if (
        backend_label == "fem_gpu"
        and requires_phase2_compute_hot_loop_gate(scenario)
        and "FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC" not in extra_env
    ):
        env["FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC"] = "1"
    if backend_label == "fem_gpu" and requires_phase2_compute_hot_loop_gate(scenario):
        row["phase2_compute_assertion_enabled"] = env_flag_enabled(
            env_text(env, "FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC")
        )
    if backend_label == "fem_gpu":
        preflight = build_preflight_report(env)
        row["adaptive_gpu_rk_acceptance_ready"] = preflight.get(
            "adaptive_gpu_rk_acceptance_ready"
        )
        row["adaptive_gpu_rk_hot_loop_scalar_readback_free"] = preflight.get(
            "adaptive_gpu_rk_hot_loop_scalar_readback_free"
        )
        row["adaptive_gpu_rk_hot_loop_compute_readback_free"] = preflight.get(
            "adaptive_gpu_rk_hot_loop_compute_readback_free"
        )
        row["adaptive_gpu_rk_hot_loop_control_readback"] = preflight.get(
            "adaptive_gpu_rk_hot_loop_control_readback"
        )
        row["adaptive_gpu_rk_hot_loop_scalar_readback_path"] = preflight.get(
            "adaptive_gpu_rk_hot_loop_scalar_readback_path"
        )
        blockers = preflight.get("adaptive_gpu_rk_acceptance_blockers")
        row["adaptive_gpu_rk_acceptance_blockers"] = (
            ";".join(str(blocker) for blocker in blockers)
            if isinstance(blockers, list)
            else blockers
        )
    if not binary.is_file():
        row["status"] = "missing_binary"
        row["error"] = "GPU benchmark binary is missing" if backend_label == "fem_gpu" else "benchmark binary is missing"
        if backend_label == "fem_gpu" and requires_phase2_compute_hot_loop_gate(scenario):
            row["phase2_compute_hot_loop_sync_clean"] = False
            row["phase2_gate_reason"] = "gpu_binary=missing"
        return row
    env["FULLMAG_BENCH_MESH"] = str(mesh_path)
    env["FULLMAG_BENCH_SCENARIO"] = scenario
    env["FULLMAG_BENCH_INTEGRATOR"] = integrator
    if relaxation_algorithm is not None:
        env["FULLMAG_BENCH_RELAX_ALGORITHM"] = relaxation_algorithm
    env["FULLMAG_BENCH_TIMESTEP_POLICY"] = timestep_policy
    env["FULLMAG_BENCH_STEPS"] = str(steps)
    env["FULLMAG_BENCH_DT"] = repr(dt)

    with tempfile.TemporaryDirectory(prefix=f"fullmag_{backend_label.lower()}_bench_") as run_dir:
        env["FULLMAG_RUN_DIR"] = run_dir
        command = script_execution_command(binary, Path(run_dir))
        if problem_ir is not None:
            problem_ir_path = Path(run_dir) / "canonical.problem-ir.json"
            problem_ir_payload = canonical_problem_ir_bytes(problem_ir)
            problem_ir_path.write_bytes(problem_ir_payload)
            row["executed_problem_ir_sha256"] = hashlib.sha256(
                problem_ir_payload
            ).hexdigest()
            command = problem_ir_execution_command(
                binary=binary,
                problem_ir_path=problem_ir_path,
                run_dir=Path(run_dir),
                until_seconds=max(dt, steps * dt),
            )
        started = time.perf_counter_ns()
        run_kwargs = {
            "cwd": REPO_ROOT,
            "env": env,
            "capture_output": True,
            "text": True,
            "check": False,
        }
        if timeout_s is not None:
            run_kwargs["timeout"] = timeout_s
        try:
            completed = subprocess.run(command, **run_kwargs)
        except subprocess.TimeoutExpired as exc:
            wall_time_ms = (time.perf_counter_ns() - started) / 1_000_000.0
            stdout = exc.stdout or ""
            stderr = exc.stderr or ""
            row.update(execution_plan_mesh_stats(load_run_metadata(run_dir)))
            row.update(
                {
                    "status": "timeout",
                    "returncode": None,
                    "wall_time_ms": round(wall_time_ms, 3),
                    "stdout_lines": len(str(stdout).splitlines()),
                    "stderr_lines": len(str(stderr).splitlines()),
                    "error": f"benchmark case timed out after {timeout_s} s",
                }
            )
            return row
        wall_time_ms = (time.perf_counter_ns() - started) / 1_000_000.0
        metadata = load_run_metadata(run_dir)
        final_scalar_row = load_final_scalar_row(run_dir)
        artifact_payload = load_authoritative_benchmark_payload(run_dir)

    combined_output = "\n".join(
        part for part in [completed.stdout, completed.stderr] if part.strip()
    )
    raw_case_output = env.get("FULLMAG_BENCH_RAW_CASE_OUTPUT")
    if raw_case_output:
        raw_path = Path(raw_case_output)
        raw_path.parent.mkdir(parents=True, exist_ok=True)
        with raw_path.open("a", encoding="utf-8") as handle:
            handle.write(f"\n===== {backend_label} case =====\n")
            handle.write(combined_output)
            handle.write("\n")
    payload = parse_benchmark_result(combined_output)
    if payload is None:
        payload = artifact_payload
    script_summary = parse_script_run_summary(combined_output)
    if payload is not None and script_summary is not None:
        payload = dict(payload)
        for key in (
            "backend_create_wall_time_ns",
            "first_accepted_step_demag_solver_apply_wall_time_ns",
        ):
            if payload.get(key) is None:
                payload[key] = script_summary.get(key)
    if metadata is None:
        metadata = load_metadata_from_payload(payload)
    if not final_scalar_row:
        final_scalar_row = load_final_scalar_row_from_payload(payload)
    provenance = metadata.get("execution_provenance", {}) if metadata else {}
    if not isinstance(provenance, Mapping):
        provenance = {}
    demag_runtime = metadata.get("demag_runtime", {}) if metadata else {}
    if not isinstance(demag_runtime, Mapping):
        demag_runtime = {}
    demag_amg_profile = demag_runtime.get("amg_profile", {})
    if not isinstance(demag_amg_profile, Mapping):
        demag_amg_profile = {}
    qualification = first_present(
        metadata.get("fem_gpu_relaxation_qualification") if metadata else None,
        metadata.get("fem_cpu_relaxation_qualification") if metadata else None,
        {},
    )
    if not isinstance(qualification, Mapping):
        qualification = {}
    demag_timings = demag_runtime.get("timings_ns", {})
    if not isinstance(demag_timings, Mapping):
        demag_timings = {}
    row.update(execution_plan_mesh_stats(metadata))

    row.update(
        {
            "status": "ok" if completed.returncode == 0 and payload is not None else "failed",
            "returncode": completed.returncode,
            "wall_time_ms": round(wall_time_ms, 3),
            "stdout_lines": len(completed.stdout.splitlines()),
            "stderr_lines": len(completed.stderr.splitlines()),
        }
    )
    if payload is not None:
        row.update(
            {
                "executed_steps": first_present(
                    payload.get("executed_steps"), payload.get("total_steps")
                ),
                "reported_scenario": first_present(payload.get("scenario"), scenario),
                "reported_integrator": first_present(payload.get("integrator"), integrator),
                "reported_relaxation_algorithm": first_present(
                    payload.get("relaxation_algorithm"),
                    relaxation_algorithm,
                ),
                "reported_timestep_policy": first_present(
                    payload.get("timestep_policy"), timestep_policy
                ),
                "reported_precision": payload.get("precision"),
                "final_time_s": first_present(
                    payload.get("final_time_s"), final_scalar_row.get("time")
                ),
                "final_solver_dt_s": first_present(
                    payload.get("final_solver_dt_s"), final_scalar_row.get("solver_dt")
                ),
                "error_estimate": payload.get("error_estimate"),
                "dt_suggested_s": payload.get("dt_suggested_s"),
                "final_e_total_j": first_present(
                    payload.get("final_e_total_j"), final_scalar_row.get("E_total")
                ),
                "final_e_ex_j": first_present(
                    payload.get("final_e_ex_j"), final_scalar_row.get("E_ex")
                ),
                "final_e_ext_j": first_present(
                    payload.get("final_e_ext_j"),
                    payload.get("e_ext"),
                    final_scalar_row.get("E_ext"),
                ),
                "final_e_demag_j": first_present(
                    payload.get("final_e_demag_j"), final_scalar_row.get("E_demag")
                ),
                "final_e_ani_j": first_present(
                    payload.get("final_e_ani_j"),
                    payload.get("e_ani"),
                    final_scalar_row.get("E_ani"),
                ),
                "final_e_dmi_j": first_present(
                    payload.get("final_e_dmi_j"),
                    payload.get("e_dmi"),
                    final_scalar_row.get("E_dmi"),
                ),
                "stop_reason": qualification.get("stop_reason"),
                "final_torque_apm": first_present(
                    qualification.get("final_torque_apm"),
                    payload.get("max_torque_Apm"),
                    final_scalar_row.get("max_torque_Apm"),
                ),
                "final_torque_t": first_present(
                    qualification.get("final_torque_t"),
                    payload.get("max_torque_T"),
                    final_scalar_row.get("max_torque_T"),
                ),
                "norm_defect": qualification.get("norm_defect"),
                "step_wall_time_ms": ns_to_ms(payload.get("wall_time_ns")),
                "exchange_wall_time_ms": ns_to_ms(payload.get("exchange_wall_time_ns")),
                "demag_wall_time_ms": ns_to_ms(payload.get("demag_wall_time_ns")),
                "demag_assemble_wall_time_ms": ns_to_ms(
                    first_present(
                        payload.get("demag_assemble_wall_time_ns"),
                        demag_timings.get("assemble"),
                    )
                ),
                "demag_solve_wall_time_ms": ns_to_ms(
                    first_present(
                        payload.get("demag_solve_wall_time_ns"),
                        demag_timings.get("solve"),
                    )
                ),
                "demag_solver_setup_wall_time_ms": ns_to_ms(
                    first_present(
                        payload.get("demag_solver_setup_wall_time_ns"),
                        demag_timings.get("solver_setup"),
                    )
                ),
                "demag_solver_apply_wall_time_ms": ns_to_ms(
                    first_present(
                        payload.get("demag_solver_apply_wall_time_ns"),
                        demag_timings.get("solver_apply"),
                    )
                ),
                "demag_solver_setup_reused": first_present(
                    payload.get("demag_solver_setup_reused"),
                    demag_runtime.get("solver_setup_reused"),
                ),
                "demag_recover_wall_time_ms": ns_to_ms(
                    first_present(
                        payload.get("demag_recover_wall_time_ns"),
                        demag_timings.get("recover"),
                    )
                ),
                "demag_energy_wall_time_ms": ns_to_ms(
                    first_present(
                        payload.get("demag_energy_wall_time_ns"),
                        demag_timings.get("energy"),
                    )
                ),
                "rhs_wall_time_ms": ns_to_ms(payload.get("rhs_wall_time_ns")),
                "extra_energy_wall_time_ms": ns_to_ms(
                    payload.get("extra_energy_wall_time_ns")
                ),
                "snapshot_wall_time_ms": ns_to_ms(payload.get("snapshot_wall_time_ns")),
                "rhs_evals": payload.get("rhs_evals"),
                "total_rhs_evals": payload.get("total_rhs_evals"),
                "demag_solves": payload.get("demag_solves"),
                "execution_engine": provenance.get("execution_engine"),
                "fem_assembly_mode": provenance.get("fem_assembly_mode")
                or demag_runtime.get("fem_assembly_mode"),
                "fem_execution_mode": provenance.get("fem_execution_mode"),
                "fem_data_residency": provenance.get("fem_data_residency"),
                "uses_cuda_kernels": provenance.get("uses_cuda_kernels"),
                "uses_gpu_poisson": provenance.get("uses_gpu_poisson"),
                "demag_refresh_interval_s": provenance.get("demag_refresh_interval_s"),
                "hot_loop_host_sync_count": provenance.get("hot_loop_host_sync_count"),
                "hot_loop_exchange_h2d_bytes": provenance.get(
                    "hot_loop_exchange_h2d_bytes"
                ),
                "hot_loop_exchange_d2h_bytes": provenance.get(
                    "hot_loop_exchange_d2h_bytes"
                ),
                **startup_timing_fields(payload),
                "hot_loop_exchange_host_sync_count": provenance.get(
                    "hot_loop_exchange_host_sync_count"
                ),
                "hot_loop_compute_h2d_bytes": provenance.get(
                    "hot_loop_compute_h2d_bytes"
                ),
                "hot_loop_compute_d2h_bytes": provenance.get(
                    "hot_loop_compute_d2h_bytes"
                ),
                "hot_loop_compute_host_sync_count": provenance.get(
                    "hot_loop_compute_host_sync_count"
                ),
                "hot_loop_control_scalar_d2h_bytes": provenance.get(
                    "hot_loop_control_scalar_d2h_bytes"
                ),
                "hot_loop_control_scalar_host_sync_count": provenance.get(
                    "hot_loop_control_scalar_host_sync_count"
                ),
                "fem_gpu_state_allocated": provenance.get("fem_gpu_state_allocated"),
                "fem_gpu_state_node_count": provenance.get("fem_gpu_state_node_count"),
                "fem_gpu_state_dof_len": provenance.get("fem_gpu_state_dof_len"),
                "fem_gpu_state_stage_count": provenance.get("fem_gpu_state_stage_count"),
                "fem_gpu_state_device_bytes": provenance.get("fem_gpu_state_device_bytes"),
                "fem_gpu_state_reduction_workspace_bytes": provenance.get(
                    "fem_gpu_state_reduction_workspace_bytes"
                ),
                "fem_gpu_rk_exchange_only_enabled": provenance.get(
                    "fem_gpu_rk_exchange_only_enabled"
                ),
                "fem_gpu_qualification_status": provenance.get(
                    "fem_gpu_qualification_status"
                ),
                "fem_gpu_rk_stage_count": provenance.get("fem_gpu_rk_stage_count"),
                "fem_gpu_rk_uses_cuda_kernels": provenance.get(
                    "fem_gpu_rk_uses_cuda_kernels"
                ),
                "fem_gpu_rk_allows_exchange_host_sync": provenance.get(
                    "fem_gpu_rk_allows_exchange_host_sync"
                ),
                "fem_gpu_rk_stage_exchange_device_resident": provenance.get(
                    "fem_gpu_rk_stage_exchange_device_resident"
                ),
                "fem_exchange_operator_mode": provenance.get(
                    "fem_exchange_operator_mode"
                ),
                "fem_demag_operator_mode": provenance.get(
                    "fem_demag_operator_mode"
                ),
                "hypre_execution_policy": provenance.get("hypre_execution_policy"),
                "demag_residency": provenance.get("demag_residency"),
                "fem_gpu_rk_block_reason": provenance.get("fem_gpu_rk_block_reason"),
                "mfem_device": provenance.get("mfem_device"),
                "requested_fem_omp_threads": provenance.get("requested_fem_omp_threads"),
                "effective_fem_omp_threads": provenance.get("effective_fem_omp_threads"),
                "demag_linear_solver": demag_runtime.get("linear_solver"),
                "demag_model": demag_runtime.get("model"),
                "demag_boundary_variant": demag_runtime.get("boundary_variant"),
                "demag_airbox_factor": demag_runtime.get("airbox_factor"),
                "demag_robin_beta_mode": demag_runtime.get("robin_beta_mode"),
                "demag_robin_beta_factor": demag_runtime.get("robin_beta_factor"),
                "demag_preconditioner": demag_runtime.get("preconditioner"),
                "demag_amg_profile_provider": demag_amg_profile.get("provider"),
                "demag_amg_relax_type": demag_amg_profile.get("relax_type"),
                "demag_amg_coarsening": demag_amg_profile.get("coarsening"),
                "demag_amg_interpolation": demag_amg_profile.get("interpolation"),
                "demag_amg_aggressive_coarsening": demag_amg_profile.get(
                    "aggressive_coarsening"
                ),
                "demag_amg_strength_threshold": demag_amg_profile.get(
                    "strength_threshold"
                ),
                "demag_amg_max_levels": demag_amg_profile.get("max_levels"),
                "demag_relative_tolerance": demag_runtime.get("relative_tolerance"),
                "demag_absolute_tolerance": demag_runtime.get("absolute_tolerance"),
                "demag_max_iterations": demag_runtime.get("max_iterations"),
                "demag_print_level": demag_runtime.get("print_level"),
                "demag_policy_source": demag_runtime.get("policy_source"),
                "demag_requested_linear_solver": demag_runtime.get(
                    "requested_linear_solver"
                ),
                "demag_requested_preconditioner": demag_runtime.get(
                    "requested_preconditioner"
                ),
                "demag_requested_relative_tolerance": demag_runtime.get(
                    "requested_relative_tolerance"
                ),
                "demag_requested_absolute_tolerance": demag_runtime.get(
                    "requested_absolute_tolerance"
                ),
                "demag_requested_max_iterations": demag_runtime.get(
                    "requested_max_iterations"
                ),
                "demag_requested_print_level": demag_runtime.get(
                    "requested_print_level"
                ),
                "demag_actual_iterations": demag_runtime.get("actual_iterations"),
                "demag_final_residual_norm": demag_runtime.get("final_residual_norm"),
                "rejected_attempts": payload.get("rejected_attempts"),
                "relaxation_energy_rejected_attempts": payload.get(
                    "relaxation_energy_rejected_attempts"
                ),
                "relaxation_controller_tightenings": payload.get(
                    "relaxation_controller_tightenings"
                ),
                "relaxation_controller_at_floor": payload.get(
                    "relaxation_controller_at_floor"
                ),
                "relaxation_torque_confirmation_count": payload.get(
                    "relaxation_torque_confirmation_count"
                ),
                "fsal_reused": payload.get("fsal_reused"),
                "max_dm_dt": payload.get("max_dm_dt"),
                "max_h_eff": payload.get("max_h_eff"),
                "max_h_demag": payload.get("max_h_demag"),
                "e_ani": first_present(payload.get("e_ani"), payload.get("final_e_ani_j")),
                "e_dmi": first_present(payload.get("e_dmi"), payload.get("final_e_dmi_j")),
            }
        )
    else:
        row["error"] = "missing BENCHMARK_RESULT payload"
        row["error_kind"] = "missing_benchmark_result"

    if completed.returncode != 0:
        row["error"] = truncate_error(combined_output)
        error_kind = classify_benchmark_error(combined_output)
        if error_kind is not None:
            row["error_kind"] = error_kind

    attach_phase2_gate(row)

    return row


def prepend_env_path(value: str | None, prefix: Path) -> str:
    prefix_text = str(prefix)
    if not value:
        return prefix_text
    paths = value.split(os.pathsep)
    if prefix_text in paths:
        return value
    return os.pathsep.join([prefix_text, value])


def apply_bundled_openmpi_runtime_env(env: dict[str, str]) -> None:
    openmpi_root = MANAGED_FEM_RUNTIME_ROOT / "openmpi"
    if (openmpi_root / "share" / "openmpi").is_dir():
        env.setdefault("OPAL_PREFIX", str(openmpi_root))
        env["PATH"] = prepend_env_path(env.get("PATH"), openmpi_root / "bin")
        env.setdefault(
            "OMPI_MCA_mca_base_component_path",
            str(openmpi_root / "lib" / "openmpi3"),
        )
        env.setdefault(
            "OMPI_MCA_orte_launch_agent",
            str(openmpi_root / "bin" / "orted"),
        )
        env.setdefault("OMPI_MCA_reachable", "weighted")
        env.setdefault("OMPI_MCA_mca_base_component_show_load_errors", "0")

    pmix_root = MANAGED_FEM_RUNTIME_ROOT / "lib" / "pmix2"
    if (pmix_root / "share" / "pmix").is_dir():
        env.setdefault("PMIX_PREFIX", str(pmix_root))
        env.setdefault("PMIX_EXEC_PREFIX", str(pmix_root))
        env.setdefault("PMIX_MCA_pcompress_base_silence_warning", "1")


def as_int(value: object) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def as_float(value: object) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def as_bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "on", "true", "yes"}


def gpu_rk_block_reason_suffix(row: dict[str, object]) -> str:
    reason = row.get("fem_gpu_rk_block_reason")
    return f";gpu_rk_block_reason={reason}" if reason else ""


def attach_phase2_gate(row: dict[str, object]) -> None:
    if row.get("backend") != "fem_gpu" or not requires_phase2_compute_hot_loop_gate(
        row.get("scenario")
    ):
        return

    if row.get("phase2_compute_assertion_enabled") is not True:
        row["phase2_compute_hot_loop_sync_clean"] = False
        row["phase2_gate_reason"] = "compute_hot_loop_assertion=disabled"
        return

    exchange_only_enabled = row.get("fem_gpu_rk_exchange_only_enabled")
    stage_exchange_device_resident = row.get(
        "fem_gpu_rk_stage_exchange_device_resident"
    )
    exchange_operator_mode = row.get("fem_exchange_operator_mode")
    if exchange_only_enabled is True and stage_exchange_device_resident is not True:
        row["phase2_compute_hot_loop_sync_clean"] = False
        row["phase2_gate_reason"] = (
            "runtime_contract_violation="
            "exchange_only_enabled_without_stage_exchange_device_resident"
            f"{gpu_rk_block_reason_suffix(row)}"
        )
        return

    compute_sync = as_int(row.get("hot_loop_compute_host_sync_count"))
    if compute_sync is None:
        row["phase2_compute_hot_loop_sync_clean"] = False
        if row.get("status") == "failed":
            row["phase2_gate_reason"] = "run_failed_before_phase2_provenance"
            return
        row["phase2_gate_reason"] = (
            "compute_hot_loop_host_sync_count=missing"
            f"{gpu_rk_block_reason_suffix(row)}"
        )
        return

    if stage_exchange_device_resident is not True:
        row["phase2_compute_hot_loop_sync_clean"] = False
        row["phase2_gate_reason"] = (
            f"compute_hot_loop_host_sync_count={compute_sync};"
            f"stage_exchange_device_resident=false{gpu_rk_block_reason_suffix(row)}"
        )
        return

    if exchange_operator_mode not in {"legacy_sparse_gpu", "partial_assembly_gpu"}:
        row["phase2_compute_hot_loop_sync_clean"] = False
        row["phase2_gate_reason"] = (
            f"exchange_operator_mode={exchange_operator_mode or 'missing'}"
        )
        return

    if scenario_has_interaction(row.get("scenario"), "demag"):
        demag_operator_mode = row.get("fem_demag_operator_mode")
        hypre_execution_policy = row.get("hypre_execution_policy")
        demag_residency = row.get("demag_residency")
        if (
            demag_operator_mode != "device_hypre_poisson"
            or hypre_execution_policy != "device"
            or demag_residency != "device"
        ):
            row["phase2_compute_hot_loop_sync_clean"] = False
            row["phase2_gate_reason"] = (
                f"demag_device_residency={demag_operator_mode or 'missing'}/"
                f"{hypre_execution_policy or 'missing'}/"
                f"{demag_residency or 'missing'}"
            )
            return

    row["phase2_compute_hot_loop_sync_clean"] = compute_sync == 0
    row["phase2_gate_reason"] = (
        f"compute_hot_loop_host_sync_count={compute_sync};"
        "stage_exchange_device_resident=true"
    )


def ns_to_ms(value: object) -> float | None:
    if value is None:
        return None
    try:
        return round(float(value) / 1_000_000.0, 6)
    except (TypeError, ValueError):
        return None


def startup_timing_fields(payload: Mapping[str, object]) -> dict[str, float | None]:
    return {
        "backend_create_wall_time_ms": ns_to_ms(
            payload.get("backend_create_wall_time_ns")
        ),
        "first_accepted_step_demag_solver_apply_wall_time_ms": ns_to_ms(
            payload.get("first_accepted_step_demag_solver_apply_wall_time_ns")
        ),
    }


def first_present(*values: object) -> object | None:
    for value in values:
        if value is not None:
            return value
    return None


def truncate_error(output: str, limit: int = 400) -> str:
    compact = " | ".join(line.strip() for line in output.splitlines() if line.strip())
    if len(compact) <= limit:
        return compact
    marker = " ... "
    if limit <= len(marker):
        return compact[:limit]
    head_len = max(1, (limit - len(marker)) // 2)
    tail_len = limit - len(marker) - head_len
    return compact[:head_len] + marker + compact[-tail_len:]


def classify_benchmark_error(output: str) -> str | None:
    lowered = output.lower()
    if (
        "cudagetdevicecount" in lowered
        and "driver version is insufficient for cuda runtime version" in lowered
    ):
        return "cuda_driver_runtime_mismatch"
    if "mpi_init" in lowered or "pmix" in lowered:
        return "mpi_init_or_pmix_startup"
    if "modulenotfounderror" in lowered and "no module named" in lowered:
        return "missing_python_dependency"
    if "missing benchmark_result" in lowered:
        return "missing_benchmark_result"
    return None


def runtime_gpu_availability_failure(binary: Path, timeout_s: float = 10.0) -> str | None:
    if not binary.is_file():
        return f"native FEM GPU runtime binary is missing: {binary}"
    try:
        completed = subprocess.run(
            [str(binary), "runtime", "fem-availability", "--json"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        return f"native FEM GPU availability probe timed out after {timeout_s} s"
    if completed.returncode != 0:
        error = truncate_error("\n".join([completed.stdout, completed.stderr]))
        return f"native FEM GPU availability probe failed: {error}"
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        return f"native FEM GPU availability probe returned invalid JSON: {exc}"
    if payload.get("native_fem_gpu_available") is True:
        return None
    reason = str(payload.get("reason_gpu") or "no GPU availability reason reported")
    visible_devices = payload.get("visible_cuda_device_count")
    return (
        "native FEM GPU backend is unavailable before CPU/GPU consistency sweep: "
        f"visible_cuda_device_count={visible_devices}; reason={reason}"
    )


def write_csv(results: list[dict[str, object]], output_path: str) -> None:
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    if not results:
        return
    fieldnames: list[str] = []
    seen: set[str] = set()
    for row in results:
        for key in row:
            if key not in seen:
                seen.add(key)
                fieldnames.append(key)
    with open(output_path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, lineterminator="\n")
        writer.writeheader()
        for row in results:
            writer.writerow(row)
    print(f"Results written to {output_path}")


def load_csv_results(path: Path) -> list[dict[str, object]]:
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def repeated_case_key(row: Mapping[str, object]) -> tuple[object, ...]:
    return (
        row.get("backend"),
        row.get("mesh_path"),
        row.get("scenario"),
        row.get("integrator"),
        row.get("relaxation_algorithm"),
        row.get("timestep_policy"),
        row.get("dt_s"),
        row.get("steps"),
        row.get("requested_cpu_thread_spec"),
        row.get("requested_demag_solver"),
        row.get("requested_demag_preconditioner"),
        row.get("requested_demag_relative_tolerance"),
        row.get("requested_demag_absolute_tolerance"),
        row.get("requested_demag_max_iterations"),
        row.get("requested_demag_print_level"),
        row.get("requested_demag_amg_relax_type"),
        row.get("requested_demag_amg_coarsening"),
        row.get("requested_demag_amg_interpolation"),
        row.get("requested_demag_amg_aggressive_coarsening"),
        row.get("requested_demag_amg_strength_threshold"),
        row.get("requested_demag_amg_max_levels"),
        row.get("demag_relative_tolerance"),
        row.get("demag_absolute_tolerance"),
        row.get("demag_max_iterations"),
    )


def unstable_solver_mesh_groups(results: list[dict[str, object]]) -> list[str]:
    signatures_by_key: dict[tuple[object, ...], set[object]] = {}
    for row in results:
        signature = row.get("solver_mesh_signature")
        if not signature:
            continue
        signatures_by_key.setdefault(repeated_case_key(row), set()).add(signature)

    failures = []
    for key, signatures in signatures_by_key.items():
        if len(signatures) > 1:
            failures.append(
                f"case={key} produced {len(signatures)} solver_mesh_signature values"
            )
    return failures


def performance_regression_key_value(value: object) -> str:
    if value is None:
        return ""
    return str(value)


def performance_regression_case_key(row: Mapping[str, object]) -> tuple[str, ...] | None:
    signature = row.get("solver_mesh_signature")
    if not signature:
        return None
    return tuple(
        performance_regression_key_value(value)
        for value in (
            signature,
            row.get("backend"),
            row.get("mesh_path"),
            row.get("scenario"),
            row.get("integrator"),
            row.get("relaxation_algorithm"),
            row.get("timestep_policy"),
            row.get("requested_cpu_thread_spec"),
            row.get("requested_demag_solver"),
            row.get("requested_demag_preconditioner"),
            row.get("requested_demag_relative_tolerance"),
            row.get("requested_demag_absolute_tolerance"),
            row.get("requested_demag_max_iterations"),
            row.get("requested_demag_print_level"),
            row.get("requested_demag_amg_relax_type"),
            row.get("requested_demag_amg_coarsening"),
            row.get("requested_demag_amg_interpolation"),
            row.get("requested_demag_amg_aggressive_coarsening"),
            row.get("requested_demag_amg_strength_threshold"),
            row.get("requested_demag_amg_max_levels"),
        )
    )


def average_performance_metrics_by_case(
    rows: list[dict[str, object]],
) -> dict[tuple[object, ...], dict[str, float]]:
    sums: dict[tuple[object, ...], dict[str, float]] = {}
    counts: dict[tuple[object, ...], dict[str, int]] = {}
    for row in rows:
        key = performance_regression_case_key(row)
        if key is None or row.get("status") not in {None, "", "ok"}:
            continue
        for metric in PERFORMANCE_REGRESSION_METRICS:
            value = as_float(row.get(metric))
            if value is None or value <= 0.0:
                continue
            metric_sums = sums.setdefault(key, {})
            metric_counts = counts.setdefault(key, {})
            metric_sums[metric] = metric_sums.get(metric, 0.0) + value
            metric_counts[metric] = metric_counts.get(metric, 0) + 1

    averages: dict[tuple[object, ...], dict[str, float]] = {}
    for key, metric_sums in sums.items():
        averages[key] = {
            metric: metric_sum / counts[key][metric]
            for metric, metric_sum in metric_sums.items()
        }
    return averages


def performance_distribution_summary(
    rows: list[dict[str, object]],
) -> list[dict[str, object]]:
    grouped: dict[tuple[str, ...], dict[str, list[float]]] = {}
    for row in rows:
        key = performance_regression_case_key(row)
        if key is None or row.get("status") not in {None, "", "ok"}:
            continue
        metric_values = grouped.setdefault(key, {})
        for metric in PERFORMANCE_REGRESSION_METRICS:
            value = as_float(row.get(metric))
            if value is not None and math.isfinite(value) and value > 0.0:
                metric_values.setdefault(metric, []).append(value)
    return [
        {
            "case_key": list(key),
            "metrics": {
                metric: summarize_distribution(values)
                for metric, values in sorted(metric_values.items())
            },
        }
        for key, metric_values in sorted(grouped.items())
    ]


def performance_metric_distributions_by_case(
    rows: list[dict[str, object]],
) -> dict[tuple[str, ...], dict[str, dict[str, float | int]]]:
    grouped: dict[tuple[str, ...], dict[str, list[float]]] = {}
    for row in rows:
        key = performance_regression_case_key(row)
        if key is None or row.get("status") not in {None, "", "ok"}:
            continue
        metric_values = grouped.setdefault(key, {})
        for metric in PERFORMANCE_REGRESSION_METRICS:
            value = as_float(row.get(metric))
            if value is not None and math.isfinite(value) and value > 0.0:
                metric_values.setdefault(metric, []).append(value)
    return {
        key: {
            metric: summarize_distribution(values)
            for metric, values in metric_values.items()
        }
        for key, metric_values in grouped.items()
    }


def comparable_baseline_case_count(
    results: list[dict[str, object]],
    baseline_results: list[dict[str, object]],
) -> int:
    baseline_keys = set(average_performance_metrics_by_case(baseline_results))
    current_keys = {
        key
        for row in results
        if (key := performance_regression_case_key(row)) is not None
    }
    return len(current_keys & baseline_keys)


def performance_regression_failures(
    results: list[dict[str, object]],
    baseline_results: list[dict[str, object]],
    *,
    max_regression_percent: float,
    require_complete_objectives: bool = False,
    required_sample_count: int = 5,
) -> list[str]:
    baseline_metrics = performance_metric_distributions_by_case(baseline_results)
    current_metrics = performance_metric_distributions_by_case(results)
    allowed_ratio = 1.0 + max_regression_percent / 100.0
    failures: list[str] = []
    current_rows_by_key: dict[tuple[str, ...], list[dict[str, object]]] = {}
    accepted_rows_by_key: dict[tuple[str, ...], list[dict[str, object]]] = {}
    for rows, grouped in (
        (results, current_rows_by_key),
        (baseline_results, accepted_rows_by_key),
    ):
        for row in rows:
            key = performance_regression_case_key(row)
            if key is not None and row.get("status") in {None, "", "ok"}:
                grouped.setdefault(key, []).append(row)
    comparable_keys = sorted(
        set(current_rows_by_key) & set(accepted_rows_by_key),
        key=str,
    )
    for key in comparable_keys:
        metrics = current_metrics.get(key, {})
        accepted_metrics = baseline_metrics.get(key)
        for metric in PERFORMANCE_REGRESSION_OBJECTIVE_METRICS:
            if require_complete_objectives:
                for label, rows in (
                    ("current", current_rows_by_key[key]),
                    ("accepted", accepted_rows_by_key[key]),
                ):
                    raw_values = [row.get(metric) for row in rows]
                    if len(raw_values) < required_sample_count:
                        failures.append(
                            f"case={key} {label} {metric} requires at least "
                            f"{required_sample_count} samples; got {len(raw_values)}"
                        )
                        continue
                    if any(value is None or value == "" for value in raw_values):
                        failures.append(
                            f"case={key} {label} {metric} contains missing samples"
                        )
                        continue
                    numeric_values = [as_float(value) for value in raw_values]
                    if any(
                        value is None or not math.isfinite(value)
                        for value in numeric_values
                    ):
                        failures.append(
                            f"case={key} {label} {metric} contains non-finite samples"
                        )
                        continue
                    if any(value <= 0.0 for value in numeric_values if value is not None):
                        failures.append(
                            f"case={key} {label} {metric} contains non-positive samples"
                        )
            current_distribution = metrics.get(metric)
            if current_distribution is None:
                continue
            accepted_distribution = (
                accepted_metrics.get(metric) if accepted_metrics is not None else None
            )
            if accepted_distribution is None:
                continue
            current_value = float(current_distribution["p95"])
            accepted_value = float(accepted_distribution["p95"])
            if current_value <= accepted_value * allowed_ratio:
                continue
            regression_percent = ((current_value / accepted_value) - 1.0) * 100.0
            failures.append(
                f"case={key} {metric} p95={current_value:.6g} exceeds accepted baseline "
                f"p95={accepted_value:.6g} by {regression_percent:.2f}% "
                f"(limit {max_regression_percent:.2f}%)"
            )
    return failures


def cpu_gpu_consistency_case_key(row: Mapping[str, object]) -> tuple[object, ...]:
    signature = row.get("solver_mesh_signature")
    if not signature:
        return ()
    return (
        signature,
        row.get("scenario"),
        row.get("integrator"),
        row_relaxation_algorithm(row),
        row.get("timestep_policy"),
        row.get("dt_s"),
        row.get("steps"),
        row.get("reported_precision"),
    )


def numeric_values_close(
    left: float,
    right: float,
    *,
    rtol: float,
    atol: float,
) -> bool:
    return abs(left - right) <= atol + rtol * max(abs(left), abs(right))


def compare_cpu_gpu_numeric_field(
    cpu_row: Mapping[str, object],
    gpu_row: Mapping[str, object],
    field: str,
    *,
    rtol: float,
    atol: float,
    failures: list[str],
    case: tuple[object, ...],
) -> None:
    cpu_value = as_float(cpu_row.get(field))
    gpu_value = as_float(gpu_row.get(field))
    if cpu_value is None or gpu_value is None:
        failures.append(
            f"case={case} is missing numeric {field}: cpu={cpu_row.get(field)!r} gpu={gpu_row.get(field)!r}"
        )
        return
    if numeric_values_close(cpu_value, gpu_value, rtol=rtol, atol=atol):
        return
    diff = abs(cpu_value - gpu_value)
    failures.append(
        f"case={case} {field} mismatch: cpu={cpu_value:.16g} gpu={gpu_value:.16g} "
        f"diff={diff:.6g} tolerance={atol + rtol * max(abs(cpu_value), abs(gpu_value)):.6g}"
    )


def compare_cpu_gpu_step_count(
    cpu_row: Mapping[str, object],
    gpu_row: Mapping[str, object],
    *,
    max_step_delta: int,
    failures: list[str],
    case: tuple[object, ...],
) -> None:
    cpu_steps = as_int(cpu_row.get("executed_steps"))
    gpu_steps = as_int(gpu_row.get("executed_steps"))
    if cpu_steps is None or gpu_steps is None:
        failures.append(
            f"case={case} is missing executed_steps: cpu={cpu_row.get('executed_steps')!r} gpu={gpu_row.get('executed_steps')!r}"
        )
        return
    delta = abs(cpu_steps - gpu_steps)
    if delta > max_step_delta:
        failures.append(
            f"case={case} executed_steps mismatch: cpu={cpu_steps} gpu={gpu_steps} "
            f"delta={delta} limit={max_step_delta}"
        )


def row_has_resolved_cpu_execution(row: Mapping[str, object]) -> bool:
    return (
        row.get("execution_engine") == "fem_cpu_native"
        and row.get("fem_execution_mode") == "cpu_native"
        and row.get("mfem_device") == "cpu"
        and row.get("uses_cuda_kernels") is False
    )


def row_has_resolved_gpu_execution(row: Mapping[str, object]) -> bool:
    execution_engine = str(row.get("execution_engine") or "")
    execution_mode = str(row.get("fem_execution_mode") or "")
    mfem_device = str(row.get("mfem_device") or "").lower()
    return (
        execution_engine == "fem_native_gpu"
        or "gpu" in execution_mode
        or mfem_device.startswith("cuda")
        or row.get("uses_cuda_kernels") is True
    )


def resolved_execution_failure(row: Mapping[str, object]) -> str | None:
    backend = row.get("backend")
    if backend == "fem_cpu" and not row_has_resolved_cpu_execution(row):
        return (
            "fem_cpu resolved execution is not native CPU: "
            f"execution_engine={row.get('execution_engine')!r} "
            f"fem_execution_mode={row.get('fem_execution_mode')!r} "
            f"mfem_device={row.get('mfem_device')!r} "
            f"uses_cuda_kernels={row.get('uses_cuda_kernels')!r}"
        )
    if backend == "fem_gpu" and not row_has_resolved_gpu_execution(row):
        return (
            "fem_gpu resolved execution is not GPU: "
            f"execution_engine={row.get('execution_engine')!r} "
            f"fem_execution_mode={row.get('fem_execution_mode')!r} "
            f"mfem_device={row.get('mfem_device')!r} "
            f"uses_cuda_kernels={row.get('uses_cuda_kernels')!r}"
        )
    return None


def gpu_strict_residency_failures(results: list[dict[str, object]]) -> list[str]:
    failures: list[str] = []
    for row in results:
        if row.get("backend") != "fem_gpu" or row.get("status") != "ok":
            continue
        case = repeated_case_key(row)
        if row.get("fem_data_residency") != "device_source_of_truth":
            failures.append(
                f"case={case} fem_gpu strict residency requires "
                "fem_data_residency='device_source_of_truth' "
                f"got {row.get('fem_data_residency')!r}"
            )
        for key in (
            "hot_loop_compute_h2d_bytes",
            "hot_loop_compute_d2h_bytes",
            "hot_loop_compute_host_sync_count",
        ):
            value = as_int(row.get(key))
            if value is None:
                failures.append(f"case={case} fem_gpu strict residency missing {key}")
                continue
            if value != 0:
                failures.append(
                    f"case={case} fem_gpu strict residency requires {key}=0 got {value}"
                )
    return failures


def expected_control_sync_budget(
    algorithm: str,
    executed_steps: int,
    total_rhs_evals: int,
    initial_syncs: int,
) -> int:
    per_step = {
        "projected_gradient_bb": DEFAULT_GPU_PGBB_CONTROL_READBACK_PER_STEP,
        "nonlinear_cg": DEFAULT_GPU_NCG_CONTROL_READBACK_PER_STEP,
    }.get(algorithm)
    if per_step is None:
        raise ValueError(f"unsupported direct-minimizer algorithm: {algorithm}")
    return (
        initial_syncs
        + per_step * executed_steps
        + max(0, total_rhs_evals - 2 * executed_steps)
    )


def gpu_control_readback_budget_failures(
    results: list[dict[str, object]],
    *,
    base: int,
    per_step: int,
    llg_per_step: int,
    pgbb_per_step: int,
    ncg_per_step: int,
    per_rejected_attempt: int,
) -> list[str]:
    if pgbb_per_step != DEFAULT_GPU_PGBB_CONTROL_READBACK_PER_STEP:
        raise ValueError("PG-BB control-readback budget must be 4")
    if ncg_per_step != DEFAULT_GPU_NCG_CONTROL_READBACK_PER_STEP:
        raise ValueError("NCG control-readback budget must be 3")

    failures: list[str] = []
    for row in results:
        if row.get("backend") != "fem_gpu" or row.get("status") != "ok":
            continue
        case = repeated_case_key(row)
        control_sync = as_int(row.get("hot_loop_control_scalar_host_sync_count"))
        executed_steps = as_int(row.get("executed_steps"))
        if control_sync is None:
            failures.append(
                f"case={case} fem_gpu control-readback budget missing "
                "hot_loop_control_scalar_host_sync_count"
            )
            continue
        if executed_steps is None:
            failures.append(
                f"case={case} fem_gpu control-readback budget missing executed_steps"
            )
            continue
        rejected_attempts = as_int(row.get("rejected_attempts")) or 0
        algorithm = row.get("relaxation_algorithm")
        algorithm_base = base
        algorithm_per_step = per_step
        additional_attempt_budget = per_rejected_attempt * max(0, rejected_attempts)
        if algorithm == "llg_overdamped":
            algorithm_base = 0
            algorithm_per_step = llg_per_step
        elif algorithm == "projected_gradient_bb":
            algorithm_per_step = DEFAULT_GPU_PGBB_CONTROL_READBACK_PER_STEP
        elif algorithm == "nonlinear_cg":
            algorithm_per_step = DEFAULT_GPU_NCG_CONTROL_READBACK_PER_STEP
        if algorithm in {"projected_gradient_bb", "nonlinear_cg"}:
            total_rhs_evals = as_int(row.get("total_rhs_evals"))
            if total_rhs_evals is None:
                failures.append(
                    f"case={case} fem_gpu direct-minimizer control-readback budget "
                    "missing total_rhs_evals"
                )
                continue
            allowed = expected_control_sync_budget(
                str(algorithm),
                max(0, executed_steps),
                total_rhs_evals,
                algorithm_base,
            )
            additional_attempt_budget = max(
                0,
                allowed
                    - algorithm_base
                    - algorithm_per_step * max(0, executed_steps),
            )
        else:
            allowed = (
                algorithm_base
                + algorithm_per_step * max(0, executed_steps)
                + additional_attempt_budget
            )
        if control_sync > allowed:
            failures.append(
                f"case={case} fem_gpu control-readback budget exceeded: "
                f"hot_loop_control_scalar_host_sync_count={control_sync} > {allowed} "
                f"(relaxation_algorithm={algorithm or 'missing'}, "
                f"base={algorithm_base}, per_step={algorithm_per_step}, "
                f"executed_steps={executed_steps}, "
                f"additional_attempt_budget={additional_attempt_budget}, "
                f"total_rhs_evals={row.get('total_rhs_evals')!r}, "
                f"per_rejected_attempt={per_rejected_attempt}, rejected_attempts={rejected_attempts})"
            )
    return failures


def gpu_phase_timing_failures(results: list[dict[str, object]]) -> list[str]:
    failures: list[str] = []
    for row in results:
        if row.get("backend") != "fem_gpu" or row.get("status") != "ok":
            continue
        executed_steps = as_int(row.get("executed_steps"))
        if executed_steps is None or executed_steps <= 0:
            continue
        case = repeated_case_key(row)
        exchange_ms = as_float(row.get("exchange_wall_time_ms"))
        if exchange_ms is None or exchange_ms <= 0.0:
            failures.append(
                f"case={case} fem_gpu phase timing missing positive exchange_wall_time_ms"
            )
        if row.get("relaxation_algorithm") == "llg_overdamped":
            rhs_ms = as_float(row.get("rhs_wall_time_ms"))
            if rhs_ms is None or rhs_ms <= 0.0:
                failures.append(
                    f"case={case} fem_gpu phase timing missing positive rhs_wall_time_ms"
                )
        if as_bool(row.get("uses_gpu_poisson")):
            demag_ms = as_float(row.get("demag_wall_time_ms"))
            if demag_ms is None or demag_ms <= 0.0:
                failures.append(
                    f"case={case} fem_gpu phase timing missing positive demag_wall_time_ms"
                )
    return failures


def min_solver_node_failures(
    results: list[dict[str, object]],
    *,
    min_nodes: int,
) -> list[str]:
    failures: list[str] = []
    for row in results:
        if row.get("status") != "ok":
            continue
        case = repeated_case_key(row)
        node_count = as_int(row.get("node_count"))
        if node_count is None:
            failures.append(f"case={case} completed row is missing solver node_count")
        elif node_count < min_nodes:
            failures.append(
                f"case={case} solver node_count={node_count} is below required minimum {min_nodes}"
            )
    return failures


def numeric_abs_diff(left: object, right: object) -> float | None:
    left_value = as_float(left)
    right_value = as_float(right)
    if left_value is None or right_value is None:
        return None
    return abs(left_value - right_value)


def numeric_rel_diff(left: object, right: object) -> float | None:
    left_value = as_float(left)
    right_value = as_float(right)
    if left_value is None or right_value is None:
        return None
    denominator = max(abs(left_value), abs(right_value))
    if denominator == 0.0:
        return 0.0
    return abs(left_value - right_value) / denominator


def numeric_speedup(numerator: object, denominator: object) -> float | None:
    numerator_value = as_float(numerator)
    denominator_value = as_float(denominator)
    if numerator_value is None or denominator_value in {None, 0.0}:
        return None
    return numerator_value / denominator_value


def add_numeric_pair_summary(
    summary: dict[str, object],
    cpu_row: Mapping[str, object],
    gpu_row: Mapping[str, object],
    *,
    field: str,
    output_prefix: str,
) -> None:
    summary[f"cpu_{output_prefix}"] = as_float(cpu_row.get(field))
    summary[f"gpu_{output_prefix}"] = as_float(gpu_row.get(field))
    summary[f"{output_prefix}_abs_diff"] = numeric_abs_diff(
        cpu_row.get(field),
        gpu_row.get(field),
    )
    summary[f"{output_prefix}_rel_diff"] = numeric_rel_diff(
        cpu_row.get(field),
        gpu_row.get(field),
    )


def add_timing_pair_summary(
    summary: dict[str, object],
    cpu_row: Mapping[str, object],
    gpu_row: Mapping[str, object],
    *,
    field: str,
    output_prefix: str,
) -> None:
    summary[f"cpu_{output_prefix}_ms"] = as_float(cpu_row.get(field))
    summary[f"gpu_{output_prefix}_ms"] = as_float(gpu_row.get(field))
    summary[f"{output_prefix}_speedup_cpu_over_gpu"] = numeric_speedup(
        cpu_row.get(field),
        gpu_row.get(field),
    )


def cpu_gpu_consistency_pair_summary(
    case: tuple[object, ...],
    cpu_row: Mapping[str, object],
    gpu_row: Mapping[str, object],
) -> dict[str, object]:
    cpu_steps = as_int(cpu_row.get("executed_steps"))
    gpu_steps = as_int(gpu_row.get("executed_steps"))
    summary: dict[str, object] = {
        "case_key": list(case),
        "solver_mesh_signature": case[0],
        "scenario": case[1],
        "integrator": case[2],
        "relaxation_algorithm": case[3],
        "timestep_policy": case[4],
        "dt_s": case[5],
        "steps": case[6],
        "precision": case[7],
        "cpu_execution_engine": cpu_row.get("execution_engine"),
        "gpu_execution_engine": gpu_row.get("execution_engine"),
        "cpu_executed_steps": cpu_steps,
        "gpu_executed_steps": gpu_steps,
        "executed_step_delta": (
            abs(cpu_steps - gpu_steps)
            if cpu_steps is not None and gpu_steps is not None
            else None
        ),
    }
    add_numeric_pair_summary(
        summary, cpu_row, gpu_row, field="final_e_total_j", output_prefix="final_e_total_j"
    )
    for field in CPU_GPU_ENERGY_FIELDS:
        if field == "final_e_total_j":
            continue
        add_numeric_pair_summary(
            summary,
            cpu_row,
            gpu_row,
            field=field,
            output_prefix=field,
        )
    add_numeric_pair_summary(
        summary,
        cpu_row,
        gpu_row,
        field="final_torque_apm",
        output_prefix="final_torque_apm",
    )
    add_numeric_pair_summary(
        summary,
        cpu_row,
        gpu_row,
        field="final_torque_t",
        output_prefix="final_torque_t",
    )
    for field, output_prefix in CPU_GPU_TIMING_FIELDS.items():
        add_timing_pair_summary(
            summary,
            cpu_row,
            gpu_row,
            field=field,
            output_prefix=output_prefix,
        )
    return summary


def cpu_gpu_consistency_pair_summaries(
    results: list[dict[str, object]],
) -> list[dict[str, object]]:
    grouped: dict[tuple[object, ...], dict[str, list[dict[str, object]]]] = {}
    for row in results:
        backend = row.get("backend")
        if backend not in {"fem_cpu", "fem_gpu"}:
            continue
        if row.get("status") != "ok" or resolved_execution_failure(row) is not None:
            continue
        key = cpu_gpu_consistency_case_key(row)
        if not key:
            continue
        grouped.setdefault(key, {}).setdefault(str(backend), []).append(row)

    summaries: list[dict[str, object]] = []
    for key, by_backend in sorted(grouped.items(), key=lambda item: str(item[0])):
        for cpu_row in by_backend.get("fem_cpu", []):
            for gpu_row in by_backend.get("fem_gpu", []):
                summaries.append(cpu_gpu_consistency_pair_summary(key, cpu_row, gpu_row))
    return summaries


def manifest_case_ids(case_manifests: list[dict[str, object]] | None) -> list[str]:
    case_ids: list[str] = []
    for manifest in case_manifests or []:
        case_id = manifest.get("case_id")
        if isinstance(case_id, str) and case_id and case_id not in case_ids:
            case_ids.append(case_id)
    return case_ids


def manifest_case_requirements(
    case_manifests: list[dict[str, object]] | None,
) -> list[tuple[str, str | None, tuple[str, ...]]]:
    requirements: list[tuple[str, str | None, tuple[str, ...]]] = []
    for manifest in case_manifests or []:
        case_id = manifest.get("case_id")
        if not isinstance(case_id, str) or not case_id:
            continue
        relaxation_algorithm = manifest.get("relaxation_algorithm")
        required_backends_payload = manifest.get("required_backends")
        if isinstance(required_backends_payload, list):
            required_backends = tuple(
                str(backend)
                for backend in required_backends_payload
                if backend in {"fem_cpu", "fem_gpu"}
            )
        else:
            required_backends = tuple(
                required_backends_for_relaxation_algorithm(
                    relaxation_algorithm if isinstance(relaxation_algorithm, str) else None
                )
            )
        if not required_backends:
            required_backends = ("fem_cpu", "fem_gpu")
        requirement = (
            case_id,
            relaxation_algorithm if isinstance(relaxation_algorithm, str) else None,
            required_backends,
        )
        if requirement not in requirements:
            requirements.append(requirement)
    return requirements


def row_relaxation_algorithm(row: Mapping[str, object]) -> object:
    value = first_present(
        row.get("reported_relaxation_algorithm"),
        row.get("relaxation_algorithm"),
    )
    if value is not None:
        return value
    scenario = row.get("scenario")
    if isinstance(scenario, str) and benchmark_scenario_uses_relaxation(scenario):
        return "llg_overdamped"
    return None


def cpu_gpu_required_case_coverage(
    results: list[dict[str, object]],
    *,
    case_manifests: list[dict[str, object]] | None,
) -> list[dict[str, object]]:
    case_requirements = manifest_case_requirements(case_manifests)
    if not case_requirements:
        return []

    pair_counts_by_requirement: dict[tuple[str, str | None], int] = {}
    for pair in cpu_gpu_consistency_pair_summaries(results):
        scenario = pair.get("scenario")
        relaxation_algorithm = pair.get("relaxation_algorithm")
        if isinstance(scenario, str):
            key = (
                scenario,
                relaxation_algorithm if isinstance(relaxation_algorithm, str) else None,
            )
            pair_counts_by_requirement[key] = pair_counts_by_requirement.get(key, 0) + 1
            generic_key = (scenario, None)
            pair_counts_by_requirement[generic_key] = (
                pair_counts_by_requirement.get(generic_key, 0) + 1
            )

    coverage: list[dict[str, object]] = []
    for case_id, relaxation_algorithm, required_backends in case_requirements:
        rows = [
            row
            for row in results
            if row.get("scenario") == case_id
            and (
                relaxation_algorithm is None
                or row_relaxation_algorithm(row) == relaxation_algorithm
            )
        ]
        cpu_rows = [row for row in rows if row.get("backend") == "fem_cpu"]
        gpu_rows = [row for row in rows if row.get("backend") == "fem_gpu"]
        cpu_ok_count = sum(1 for row in cpu_rows if row.get("status") == "ok")
        gpu_ok_count = sum(1 for row in gpu_rows if row.get("status") == "ok")
        pair_count = pair_counts_by_requirement.get((case_id, relaxation_algorithm), 0)
        case_label = (
            f"case_id={case_id} relaxation_algorithm={relaxation_algorithm}"
            if relaxation_algorithm is not None
            else f"case_id={case_id}"
        )
        failures: list[str] = []
        if not rows:
            failures.append(f"required {case_label} produced no benchmark rows")
        requires_cpu = "fem_cpu" in required_backends
        requires_gpu = "fem_gpu" in required_backends
        if requires_cpu and rows and not cpu_ok_count:
            failures.append(f"required {case_label} has no completed fem_cpu row")
        if requires_gpu and rows and not gpu_ok_count:
            failures.append(f"required {case_label} has no completed fem_gpu row")
        if requires_cpu and requires_gpu and cpu_ok_count and gpu_ok_count and pair_count == 0:
            failures.append(
                f"required {case_label} has no completed CPU/GPU pair on the same solver_mesh_signature"
            )
        cpu_summary = backend_case_summary_fields(cpu_rows, case_id)
        gpu_summary = backend_case_summary_fields(gpu_rows, case_id)
        coverage.append(
            {
                "case_id": case_id,
                "relaxation_algorithm": relaxation_algorithm,
                "status": "pass" if not failures else "fail",
                "row_count": len(rows),
                "cpu_row_count": len(cpu_rows),
                "gpu_row_count": len(gpu_rows),
                "cpu_ok_count": cpu_ok_count,
                "gpu_ok_count": gpu_ok_count,
                "pair_count": pair_count,
                "required_backends": list(required_backends),
                "cpu_average_timing_ms": cpu_summary["average_timing_ms"],
                "gpu_average_timing_ms": gpu_summary["average_timing_ms"],
                "cpu_observable_summary": cpu_summary["observable_summary"],
                "gpu_observable_summary": gpu_summary["observable_summary"],
                "failures": failures,
            }
        )
    return coverage


def average_numeric_fields(
    rows: list[dict[str, object]],
    fields: list[str] | tuple[str, ...],
) -> dict[str, float]:
    averages: dict[str, float] = {}
    for field in fields:
        values = [
            value
            for row in rows
            if row.get("status") == "ok"
            if (value := as_float(row.get(field))) is not None
        ]
        if values:
            averages[field] = sum(values) / len(values)
    return averages


def backend_case_summary_fields(rows: list[dict[str, object]], scenario: str) -> dict[str, object]:
    observable_fields = [
        "executed_steps",
        "final_torque_apm",
        "final_torque_t",
        *scenario_energy_fields(scenario),
    ]
    return {
        "average_timing_ms": average_numeric_fields(
            rows,
            tuple(CPU_GPU_TIMING_FIELDS),
        ),
        "observable_summary": average_numeric_fields(rows, observable_fields),
    }


def cpu_gpu_required_case_failures(
    results: list[dict[str, object]],
    *,
    case_manifests: list[dict[str, object]] | None,
) -> list[str]:
    failures: list[str] = []
    for case in cpu_gpu_required_case_coverage(
        results,
        case_manifests=case_manifests,
    ):
            failures.extend(str(failure) for failure in case.get("failures", []))
    return failures


def case_coverage_pair_key(case: Mapping[str, object]) -> tuple[str, str | None]:
    case_id = str(case.get("case_id") or "")
    relaxation_algorithm = case.get("relaxation_algorithm")
    return (
        case_id,
        relaxation_algorithm if isinstance(relaxation_algorithm, str) else None,
    )


def consistency_failure_mentions_case(
    failure: str,
    case_id: str,
    relaxation_algorithm: str | None,
) -> bool:
    if relaxation_algorithm is not None:
        return (
            f"required case_id={case_id} relaxation_algorithm={relaxation_algorithm}"
            in failure
            or (
                f"'{case_id}'" in failure
                and f"'{relaxation_algorithm}'" in failure
            )
            or (
                f'"{case_id}"' in failure
                and f'"{relaxation_algorithm}"' in failure
            )
        )
    return (
        f"required case_id={case_id}" in failure
        or f"'{case_id}'" in failure
        or f'"{case_id}"' in failure
    )


def case_coverage_with_consistency_failures(
    case_coverage: list[dict[str, object]],
    failures: list[str],
) -> list[dict[str, object]]:
    coverage: list[dict[str, object]] = []
    for case in case_coverage:
        case_id, relaxation_algorithm = case_coverage_pair_key(case)
        case_failures = [str(failure) for failure in case.get("failures", [])]
        for failure in failures:
            if (
                case_id
                and consistency_failure_mentions_case(
                    failure,
                    case_id,
                    relaxation_algorithm,
                )
                and failure not in case_failures
            ):
                case_failures.append(failure)
        updated = dict(case)
        updated["failures"] = case_failures
        updated["status"] = "pass" if not case_failures else "fail"
        coverage.append(updated)
    return coverage


def cpu_gpu_consistency_summary(
    results: list[dict[str, object]],
    *,
    case_manifests: list[dict[str, object]] | None = None,
    require_gpu_strict_residency: bool = False,
    energy_rtol: float = DEFAULT_CPU_GPU_ENERGY_RTOL,
    energy_atol: float = DEFAULT_CPU_GPU_ENERGY_ATOL_J,
    torque_rtol: float = DEFAULT_CPU_GPU_TORQUE_RTOL,
    torque_atol_apm: float = DEFAULT_CPU_GPU_TORQUE_ATOL_APM,
    torque_atol_t: float = DEFAULT_CPU_GPU_TORQUE_ATOL_T,
    max_step_delta: int = DEFAULT_CPU_GPU_MAX_STEP_DELTA,
) -> dict[str, object]:
    pairs = cpu_gpu_consistency_pair_summaries(results)
    failures = cpu_gpu_consistency_failures(
        results,
        case_manifests=case_manifests,
        require_gpu_strict_residency=require_gpu_strict_residency,
        energy_rtol=energy_rtol,
        energy_atol=energy_atol,
        torque_rtol=torque_rtol,
        torque_atol_apm=torque_atol_apm,
        torque_atol_t=torque_atol_t,
        max_step_delta=max_step_delta,
    )
    case_coverage = case_coverage_with_consistency_failures(
        cpu_gpu_required_case_coverage(
            results,
            case_manifests=case_manifests,
        ),
        failures,
    )
    return {
        "case_manifests": case_manifests or [],
        "failed_count": sum(1 for row in results if row.get("status") != "ok"),
        "failure_count": len(failures),
        "failures": failures,
        "require_gpu_strict_residency": require_gpu_strict_residency,
        "ok_count": sum(1 for row in results if row.get("status") == "ok"),
        "pair_count": len(pairs),
        "pairs": pairs,
        "required_case_count": len(case_coverage),
        "covered_case_count": sum(1 for case in case_coverage if int(case["row_count"]) > 0),
        "completed_pair_case_count": sum(
            1 for case in case_coverage if int(case["pair_count"]) > 0
        ),
        "case_coverage": case_coverage,
        "row_count": len(results),
        "status": "pass" if not failures else "fail",
    }


def emit_cpu_gpu_consistency_summary(
    results: list[dict[str, object]],
    *,
    case_manifests: list[dict[str, object]] | None = None,
    require_gpu_strict_residency: bool = False,
    energy_rtol: float = DEFAULT_CPU_GPU_ENERGY_RTOL,
    energy_atol: float = DEFAULT_CPU_GPU_ENERGY_ATOL_J,
    torque_rtol: float = DEFAULT_CPU_GPU_TORQUE_RTOL,
    torque_atol_apm: float = DEFAULT_CPU_GPU_TORQUE_ATOL_APM,
    torque_atol_t: float = DEFAULT_CPU_GPU_TORQUE_ATOL_T,
    max_step_delta: int = DEFAULT_CPU_GPU_MAX_STEP_DELTA,
) -> None:
    print(
        "FEM_CPU_GPU_CONSISTENCY_SUMMARY="
        + json.dumps(
            cpu_gpu_consistency_summary(
                results,
                case_manifests=case_manifests,
                require_gpu_strict_residency=require_gpu_strict_residency,
                energy_rtol=energy_rtol,
                energy_atol=energy_atol,
                torque_rtol=torque_rtol,
                torque_atol_apm=torque_atol_apm,
                torque_atol_t=torque_atol_t,
                max_step_delta=max_step_delta,
            ),
            sort_keys=True,
        )
    )


def write_cpu_gpu_consistency_summary(
    results: list[dict[str, object]],
    output_path: str | Path,
    *,
    case_manifests: list[dict[str, object]] | None = None,
    require_gpu_strict_residency: bool = False,
    energy_rtol: float = DEFAULT_CPU_GPU_ENERGY_RTOL,
    energy_atol: float = DEFAULT_CPU_GPU_ENERGY_ATOL_J,
    torque_rtol: float = DEFAULT_CPU_GPU_TORQUE_RTOL,
    torque_atol_apm: float = DEFAULT_CPU_GPU_TORQUE_ATOL_APM,
    torque_atol_t: float = DEFAULT_CPU_GPU_TORQUE_ATOL_T,
    max_step_delta: int = DEFAULT_CPU_GPU_MAX_STEP_DELTA,
) -> dict[str, object]:
    summary = cpu_gpu_consistency_summary(
        results,
        case_manifests=case_manifests,
        require_gpu_strict_residency=require_gpu_strict_residency,
        energy_rtol=energy_rtol,
        energy_atol=energy_atol,
        torque_rtol=torque_rtol,
        torque_atol_apm=torque_atol_apm,
        torque_atol_t=torque_atol_t,
        max_step_delta=max_step_delta,
    )
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return summary


def gpu_demag_total_speedup_failures(
    cpu_gpu_summary: Mapping[str, object],
    *,
    min_speedup: float,
) -> list[str]:
    failures: list[str] = []
    pairs = cpu_gpu_summary.get("pairs")
    if not isinstance(pairs, list):
        return ["CPU/GPU demag total speedup gate has no pair summary"]
    demag_pair_count = 0
    for pair in pairs:
        if not isinstance(pair, Mapping):
            continue
        cpu_demag_ms = as_float(pair.get("cpu_demag_wall_time_ms"))
        gpu_demag_ms = as_float(pair.get("gpu_demag_wall_time_ms"))
        if cpu_demag_ms is None and gpu_demag_ms is None:
            continue
        demag_pair_count += 1
        case = summary_case_key(
            str(pair.get("scenario") or "-"),
            pair.get("relaxation_algorithm"),
        )
        speedup = as_float(pair.get("demag_wall_time_speedup_cpu_over_gpu"))
        if cpu_demag_ms is None or gpu_demag_ms is None or speedup is None:
            failures.append(
                f"{case} is missing CPU/GPU demag_wall_time_ms needed for GPU demag total speedup gate"
            )
            continue
        if speedup < min_speedup:
            failures.append(
                f"{case} demag_wall_time_speedup_cpu_over_gpu={speedup:.3g} below required minimum {min_speedup:.3g}"
            )
    if demag_pair_count == 0:
        failures.append("CPU/GPU demag total speedup gate found no demag-bearing pairs")
    return failures


def report_value(value: object, *, precision: int = 3, suffix: str = "") -> str:
    if value is None or value == "":
        return "-"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return f"{value}{suffix}"
    if isinstance(value, float):
        if suffix == "x":
            return f"{value:.3f}{suffix}"
        return f"{value:.{precision}g}{suffix}"
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return str(value)
    if suffix == "x":
        return f"{numeric:.3f}{suffix}"
    return f"{numeric:.{precision}g}{suffix}"


def report_ms(value: object) -> str:
    if value is None or value == "":
        return "-"
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return str(value)
    if numeric >= 100.0:
        return f"{numeric:.1f}"
    if numeric >= 10.0:
        return f"{numeric:.2f}"
    return f"{numeric:.3f}"


def _numeric_report_value(value: object) -> float | None:
    if value is None or value == "":
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if numeric != numeric:
        return None
    return numeric


def report_steps(value: object) -> str:
    numeric = _numeric_report_value(value)
    if numeric is None:
        return "-"
    if numeric.is_integer():
        return str(int(numeric))
    return report_value(numeric, precision=3)


def report_rate(value: object) -> str:
    numeric = _numeric_report_value(value)
    if numeric is None:
        return "-"
    return f"{numeric:.3f}"


def steps_per_minute(steps: object, wall_time_ms: object) -> float | None:
    step_count = _numeric_report_value(steps)
    wall_ms = _numeric_report_value(wall_time_ms)
    if step_count is None or wall_ms is None or wall_ms <= 0.0:
        return None
    return step_count * 60000.0 / wall_ms


def summary_case_key(case_id: str, relaxation_algorithm: object | None) -> str:
    if relaxation_algorithm is None or relaxation_algorithm == "":
        return case_id
    return f"{case_id}:{relaxation_algorithm}"


def report_case_label(case: Mapping[str, object]) -> str:
    explicit = case.get("label")
    if isinstance(explicit, str) and explicit:
        return explicit
    return summary_case_key(str(case.get("case_id", "-")), case.get("relaxation_algorithm"))


def _case_pairs_by_scenario(cpu_gpu_summary: Mapping[str, object]) -> dict[str, Mapping[str, object]]:
    pairs_by_scenario: dict[str, Mapping[str, object]] = {}
    for pair in cpu_gpu_summary.get("pairs", []):
        if isinstance(pair, Mapping):
            scenario = pair.get("scenario")
            if scenario is not None:
                pairs_by_scenario[
                    summary_case_key(str(scenario), pair.get("relaxation_algorithm"))
                ] = pair
    return pairs_by_scenario


def _mapping_value(value: object) -> Mapping[str, object]:
    if isinstance(value, Mapping):
        return value
    return {}


def _sum_case_wall_time_ms(cpu_gpu_summary: Mapping[str, object], timing_key: str) -> float | None:
    total = 0.0
    found = False
    for case in cpu_gpu_summary.get("case_coverage", []):
        if not isinstance(case, Mapping):
            continue
        timing = _mapping_value(case.get(timing_key))
        value = _numeric_report_value(timing.get("wall_time_ms"))
        if value is None:
            continue
        total += value
        found = True
    return total if found else None


def markdown_cell(value: object) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


def benchmark_report_needs_cpu_gpu_summary(
    backends: list[str],
    *,
    require_cpu_gpu_consistency: bool,
    cpu_gpu_summary_output: str | None,
) -> bool:
    if require_cpu_gpu_consistency or cpu_gpu_summary_output is not None:
        return True
    return {"fem_cpu", "fem_gpu"}.issubset(set(backends))


def single_backend_case_key(row: Mapping[str, object]) -> tuple[object, ...]:
    return (
        row.get("backend"),
        row.get("scenario"),
        row_relaxation_algorithm(row),
        row.get("integrator"),
        row.get("timestep_policy"),
        row.get("requested_cpu_thread_spec"),
        first_present(row.get("requested_demag_solver"), row.get("demag_linear_solver")),
        first_present(
            row.get("requested_demag_preconditioner"),
            row.get("demag_preconditioner"),
        ),
        first_present(
            row.get("requested_demag_amg_relax_type"),
            row.get("demag_amg_relax_type"),
        ),
        first_present(
            row.get("requested_demag_amg_coarsening"),
            row.get("demag_amg_coarsening"),
        ),
        first_present(
            row.get("requested_demag_amg_interpolation"),
            row.get("demag_amg_interpolation"),
        ),
        first_present(
            row.get("requested_demag_amg_aggressive_coarsening"),
            row.get("demag_amg_aggressive_coarsening"),
        ),
        first_present(
            row.get("requested_demag_amg_strength_threshold"),
            row.get("demag_amg_strength_threshold"),
        ),
        first_present(
            row.get("requested_demag_amg_max_levels"),
            row.get("demag_amg_max_levels"),
        ),
    )


def single_backend_case_label(row: Mapping[str, object]) -> str:
    scenario = str(row.get("scenario") or "-")
    relaxation_algorithm = row_relaxation_algorithm(row)
    parts = [summary_case_key(scenario, relaxation_algorithm), str(row.get("backend") or "-")]
    solver = first_present(row.get("requested_demag_solver"), row.get("demag_linear_solver"))
    preconditioner = first_present(
        row.get("requested_demag_preconditioner"),
        row.get("demag_preconditioner"),
    )
    if solver or preconditioner:
        parts.append(f"{solver or '-'}/{preconditioner or '-'}")
    if preconditioner in {"AMG", "OMIT"}:
        parts.append(
            "amg="
            f"{first_present(row.get('requested_demag_amg_relax_type'), row.get('demag_amg_relax_type')) or '-'}/"
            f"{first_present(row.get('requested_demag_amg_coarsening'), row.get('demag_amg_coarsening')) or '-'}/"
            f"{first_present(row.get('requested_demag_amg_interpolation'), row.get('demag_amg_interpolation')) or '-'}/"
            f"{first_present(row.get('requested_demag_amg_aggressive_coarsening'), row.get('demag_amg_aggressive_coarsening')) or '-'}/"
            f"{first_present(row.get('requested_demag_amg_strength_threshold'), row.get('demag_amg_strength_threshold')) or '-'}/"
            f"{first_present(row.get('requested_demag_amg_max_levels'), row.get('demag_amg_max_levels')) or '-'}"
        )
    return " ".join(parts)


def single_backend_case_coverage(results: list[dict[str, object]]) -> list[dict[str, object]]:
    grouped: dict[tuple[object, ...], list[dict[str, object]]] = {}
    for row in results:
        backend = row.get("backend")
        if backend not in {"fem_cpu", "fem_gpu"}:
            continue
        grouped.setdefault(single_backend_case_key(row), []).append(row)

    coverage: list[dict[str, object]] = []
    for _, rows in sorted(grouped.items(), key=lambda item: str(item[0])):
        first = rows[0]
        backend = str(first.get("backend") or "")
        scenario = str(first.get("scenario") or "")
        failures = [
            f"case={repeated_case_key(row)} backend={row.get('backend')} did not complete{runtime_error_suffix(row)}"
            for row in rows
            if row.get("status") != "ok"
        ]
        summary = backend_case_summary_fields(rows, scenario)
        case = {
            "case_id": scenario,
            "label": single_backend_case_label(first),
            "relaxation_algorithm": row_relaxation_algorithm(first),
            "status": "pass" if not failures else "fail",
            "row_count": len(rows),
            "cpu_row_count": len(rows) if backend == "fem_cpu" else 0,
            "gpu_row_count": len(rows) if backend == "fem_gpu" else 0,
            "cpu_ok_count": sum(1 for row in rows if backend == "fem_cpu" and row.get("status") == "ok"),
            "gpu_ok_count": sum(1 for row in rows if backend == "fem_gpu" and row.get("status") == "ok"),
            "pair_count": 0,
            "required_backends": [backend],
            "failures": failures,
        }
        if backend == "fem_cpu":
            case["cpu_average_timing_ms"] = summary["average_timing_ms"]
            case["cpu_observable_summary"] = summary["observable_summary"]
            case["gpu_average_timing_ms"] = {}
            case["gpu_observable_summary"] = {}
        else:
            case["cpu_average_timing_ms"] = {}
            case["cpu_observable_summary"] = {}
            case["gpu_average_timing_ms"] = summary["average_timing_ms"]
            case["gpu_observable_summary"] = summary["observable_summary"]
        coverage.append(case)
    return coverage


def cpu_gpu_not_requested_summary(results: list[dict[str, object]]) -> dict[str, object]:
    case_coverage = single_backend_case_coverage(results)
    return {
        "case_manifests": [],
        "case_coverage": case_coverage,
        "completed_pair_case_count": 0,
        "covered_case_count": sum(1 for case in case_coverage if int(case["row_count"]) > 0),
        "failed_count": sum(1 for row in results if row.get("status") != "ok"),
        "failure_count": 0,
        "failures": [],
        "ok_count": sum(1 for row in results if row.get("status") == "ok"),
        "pair_count": 0,
        "pairs": [],
        "required_case_count": len(case_coverage),
        "require_gpu_strict_residency": False,
        "row_count": len(results),
        "status": "not_requested",
    }


def benchmark_report_status(
    cpu_gpu_summary: Mapping[str, object],
    pass_fail_summary: Mapping[str, object],
) -> str:
    pass_fail_status = str(pass_fail_summary.get("status", "-"))
    if pass_fail_status in {"pass", "fail"}:
        return pass_fail_status
    return str(cpu_gpu_summary.get("status", "-"))


def benchmark_report_coverage_line(cpu_gpu_summary: Mapping[str, object]) -> str:
    if cpu_gpu_summary.get("status") == "not_requested":
        return (
            f"- cases: {cpu_gpu_summary.get('covered_case_count', 0)}/"
            f"{cpu_gpu_summary.get('required_case_count', 0)} covered"
        )
    return (
        f"- pairs: {cpu_gpu_summary.get('completed_pair_case_count', cpu_gpu_summary.get('pair_count', 0))}/"
        f"{cpu_gpu_summary.get('required_case_count', cpu_gpu_summary.get('pair_count', 0))} completed"
    )


def render_cpu_gpu_benchmark_report(
    cpu_gpu_summary: Mapping[str, object],
    pass_fail_summary: Mapping[str, object],
    *,
    csv_path: str | Path | None = None,
    summary_path: str | Path | None = None,
) -> str:
    pairs_by_scenario = _case_pairs_by_scenario(cpu_gpu_summary)
    cpu_total_ms = _sum_case_wall_time_ms(cpu_gpu_summary, "cpu_average_timing_ms")
    gpu_total_ms = _sum_case_wall_time_ms(cpu_gpu_summary, "gpu_average_timing_ms")

    lines = [
        "# Fullmag FEM CPU/GPU Benchmark Report",
        "",
        f"- status: {benchmark_report_status(cpu_gpu_summary, pass_fail_summary)}",
        f"- cpu/gpu consistency: {cpu_gpu_summary.get('status', '-')}",
        f"- rows: {cpu_gpu_summary.get('row_count', 0)} total, {cpu_gpu_summary.get('ok_count', 0)} ok, {cpu_gpu_summary.get('failed_count', 0)} failed",
        benchmark_report_coverage_line(cpu_gpu_summary),
        f"- failures: {cpu_gpu_summary.get('failure_count', 0)} consistency, {pass_fail_summary.get('gate_failure_count', 0)} gate, {pass_fail_summary.get('group_failure_count', 0)} group",
        f"- CPU compute total ms: {report_ms(cpu_total_ms)}",
        f"- GPU compute total ms: {report_ms(gpu_total_ms)}",
    ]
    if csv_path is not None:
        lines.append(f"- csv: {csv_path}")
    if summary_path is not None:
        lines.append(f"- json: {summary_path}")
    lines.extend(["", "## Case Matrix", ""])
    lines.append(
        "| Case | Status | CPU compute ms | GPU compute ms | Wall speedup | CPU steps | GPU steps | Step delta | CPU steps/min | GPU steps/min | CPU demag total ms | GPU demag total ms | Demag total speedup | CPU demag apply ms | GPU demag apply ms | Demag apply speedup | Demag energy diff J | Torque diff T |"
    )
    lines.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")

    for case in cpu_gpu_summary.get("case_coverage", []):
        if not isinstance(case, Mapping):
            continue
        case_label = report_case_label(case)
        pair = pairs_by_scenario.get(case_label, {})
        cpu_timing = _mapping_value(case.get("cpu_average_timing_ms"))
        gpu_timing = _mapping_value(case.get("gpu_average_timing_ms"))
        cpu_observables = _mapping_value(case.get("cpu_observable_summary"))
        gpu_observables = _mapping_value(case.get("gpu_observable_summary"))
        cpu_steps = cpu_observables.get("executed_steps")
        gpu_steps = gpu_observables.get("executed_steps")
        cpu_wall_ms = cpu_timing.get("wall_time_ms")
        gpu_wall_ms = gpu_timing.get("wall_time_ms")
        lines.append(
            "| "
            + " | ".join(
                markdown_cell(value)
                for value in [
                    case_label,
                    case.get("status", "-"),
                    report_ms(cpu_wall_ms),
                    report_ms(gpu_wall_ms),
                    report_value(pair.get("wall_time_speedup_cpu_over_gpu"), suffix="x"),
                    report_steps(cpu_steps),
                    report_steps(gpu_steps),
                    report_steps(pair.get("executed_step_delta")),
                    report_rate(steps_per_minute(cpu_steps, cpu_wall_ms)),
                    report_rate(steps_per_minute(gpu_steps, gpu_wall_ms)),
                    report_ms(cpu_timing.get("demag_wall_time_ms")),
                    report_ms(gpu_timing.get("demag_wall_time_ms")),
                    report_value(pair.get("demag_wall_time_speedup_cpu_over_gpu"), suffix="x"),
                    report_ms(cpu_timing.get("demag_solver_apply_wall_time_ms")),
                    report_ms(gpu_timing.get("demag_solver_apply_wall_time_ms")),
                    report_value(pair.get("demag_solver_apply_wall_time_speedup_cpu_over_gpu"), suffix="x"),
                    report_value(pair.get("final_e_demag_j_abs_diff"), precision=4),
                    report_value(pair.get("final_torque_t_abs_diff"), precision=4),
                ]
            )
            + " |"
        )

    groups = pass_fail_summary.get("solver_mesh_groups", [])
    if groups:
        lines.extend(["", "## Solver Mesh Groups", ""])
        lines.append(
            "| Solver mesh signature | Status | Rows | OK | Max demag residual | Max demag iterations |"
        )
        lines.append("|---|---:|---:|---:|---:|---:|")
        for group in groups:
            if not isinstance(group, Mapping):
                continue
            lines.append(
                "| "
                + " | ".join(
                    markdown_cell(value)
                    for value in [
                        group.get("solver_mesh_signature", "-"),
                        group.get("status", "-"),
                        group.get("row_count", "-"),
                        group.get("ok_count", "-"),
                        report_value(group.get("max_demag_final_residual_norm"), precision=4),
                        report_value(group.get("max_demag_actual_iterations")),
                    ]
                )
                + " |"
            )

    best_policies = cpu_gpu_summary.get("best_demag_policy", [])
    if best_policies:
        lines.extend(["", "## Best Demag Policy", ""])
        lines.append(
            "| Backend | Demag policy | Solver mesh signature | Avg apply ms | Avg total ms | Max residual | Max iterations |"
        )
        lines.append("|---|---|---|---:|---:|---:|---:|")
        for policy in best_policies:
            if not isinstance(policy, Mapping):
                continue
            case_key = policy.get("case_key", [])
            backend = case_key[0] if isinstance(case_key, list) and case_key else "-"
            lines.append(
                "| "
                + " | ".join(
                    markdown_cell(value)
                    for value in [
                        backend,
                        f"{policy.get('demag_solver', '-')}/{policy.get('demag_preconditioner', '-')}",
                        policy.get("solver_mesh_signature", "-"),
                        report_ms(policy.get("average_demag_solver_apply_wall_time_ms")),
                        report_ms(policy.get("average_demag_wall_time_ms")),
                        report_value(policy.get("max_demag_final_residual_norm"), precision=4),
                        report_value(policy.get("max_demag_actual_iterations")),
                    ]
                )
                + " |"
            )

    failures = list(cpu_gpu_summary.get("failures", [])) + list(pass_fail_summary.get("failures", []))
    if failures:
        lines.extend(["", "## Failures", ""])
        for failure in failures:
            lines.append(f"- {failure}")

    return "\n".join(lines) + "\n"


def print_cpu_gpu_benchmark_rich_report(
    cpu_gpu_summary: Mapping[str, object],
    pass_fail_summary: Mapping[str, object],
    *,
    csv_path: str | Path | None = None,
    summary_path: str | Path | None = None,
    human_report_path: str | Path | None = None,
    pdf_report_path: str | Path | None = None,
    console: object | None = None,
) -> bool:
    try:
        from rich import box
        from rich.console import Console
        from rich.table import Table
    except ModuleNotFoundError:
        return False

    rich_console = console if console is not None else Console(
        force_terminal=True,
        color_system="standard",
        no_color=False,
        width=180,
    )
    status = benchmark_report_status(cpu_gpu_summary, pass_fail_summary)
    status_style = "bold green" if status == "pass" else "bold red"
    rich_console.print(
        f"[bold]Fullmag FEM CPU/GPU Benchmark Report[/bold] "
        f"[{status_style}]status: {status}[/{status_style}]"
    )
    rich_console.print(
        "rows: "
        f"{cpu_gpu_summary.get('row_count', 0)} total, "
        f"{cpu_gpu_summary.get('ok_count', 0)} ok, "
        f"{cpu_gpu_summary.get('failed_count', 0)} failed | "
        f"{benchmark_report_coverage_line(cpu_gpu_summary).removeprefix('- ')} | "
        "failures: "
        f"{cpu_gpu_summary.get('failure_count', 0)} consistency, "
        f"{pass_fail_summary.get('gate_failure_count', 0)} gate, "
        f"{pass_fail_summary.get('group_failure_count', 0)} group"
    )
    rich_console.print(f"cpu/gpu consistency: {cpu_gpu_summary.get('status', '-')}")

    cpu_total_ms = _sum_case_wall_time_ms(cpu_gpu_summary, "cpu_average_timing_ms")
    gpu_total_ms = _sum_case_wall_time_ms(cpu_gpu_summary, "gpu_average_timing_ms")
    rich_console.print(
        f"CPU compute total: [cyan]{report_ms(cpu_total_ms)} ms[/cyan] | "
        f"GPU compute total: [cyan]{report_ms(gpu_total_ms)} ms[/cyan]"
    )
    if csv_path is not None:
        rich_console.print(f"CSV: [blue]{csv_path}[/blue]")
    if summary_path is not None:
        rich_console.print(f"JSON: [blue]{summary_path}[/blue]")
    if human_report_path is not None:
        rich_console.print(f"Markdown: [blue]{human_report_path}[/blue]")
    if pdf_report_path is not None:
        rich_console.print(f"PDF: [blue]{pdf_report_path}[/blue]")

    pairs_by_scenario = _case_pairs_by_scenario(cpu_gpu_summary)
    table = Table(
        title="Case Runtime And Step Rate",
        box=box.HEAVY_HEAD,
        show_lines=True,
        header_style="bold magenta",
    )
    table.add_column("Case", overflow="fold", style="white", max_width=48)
    table.add_column("Status", justify="center", no_wrap=True)
    table.add_column("CPU ms", justify="right", style="cyan", no_wrap=True)
    table.add_column("GPU ms", justify="right", style="cyan", no_wrap=True)
    table.add_column("Speedup", justify="right", style="green", no_wrap=True)
    table.add_column("CPU steps", justify="right", no_wrap=True)
    table.add_column("GPU steps", justify="right", no_wrap=True)
    table.add_column("Step delta", justify="right", no_wrap=True)
    table.add_column("CPU steps/min", justify="right", style="bright_cyan", no_wrap=True)
    table.add_column("GPU steps/min", justify="right", style="bright_cyan", no_wrap=True)

    detail_table = Table(
        title="Demag And Numerical Parity",
        box=box.HEAVY_HEAD,
        show_lines=True,
        header_style="bold magenta",
    )
    detail_table.add_column("Case", overflow="fold", style="white", max_width=48)
    detail_table.add_column("CPU demag total ms", justify="right", no_wrap=True)
    detail_table.add_column("GPU demag total ms", justify="right", no_wrap=True)
    detail_table.add_column("Demag total speedup", justify="right", style="green", no_wrap=True)
    detail_table.add_column("CPU demag apply ms", justify="right", no_wrap=True)
    detail_table.add_column("GPU demag apply ms", justify="right", no_wrap=True)
    detail_table.add_column("Demag apply speedup", justify="right", style="green", no_wrap=True)
    detail_table.add_column("Demag energy diff J", justify="right", no_wrap=True)
    detail_table.add_column("Torque diff T", justify="right", no_wrap=True)

    for case in cpu_gpu_summary.get("case_coverage", []):
        if not isinstance(case, Mapping):
            continue
        case_label = report_case_label(case)
        pair = pairs_by_scenario.get(case_label, {})
        cpu_timing = _mapping_value(case.get("cpu_average_timing_ms"))
        gpu_timing = _mapping_value(case.get("gpu_average_timing_ms"))
        cpu_observables = _mapping_value(case.get("cpu_observable_summary"))
        gpu_observables = _mapping_value(case.get("gpu_observable_summary"))
        cpu_steps = cpu_observables.get("executed_steps")
        gpu_steps = gpu_observables.get("executed_steps")
        cpu_wall_ms = cpu_timing.get("wall_time_ms")
        gpu_wall_ms = gpu_timing.get("wall_time_ms")
        case_status = str(case.get("status", "-"))
        table.add_row(
            case_label,
            f"[green]{case_status}[/green]" if case_status == "pass" else f"[red]{case_status}[/red]",
            report_ms(cpu_wall_ms),
            report_ms(gpu_wall_ms),
            report_value(pair.get("wall_time_speedup_cpu_over_gpu"), suffix="x"),
            report_steps(cpu_steps),
            report_steps(gpu_steps),
            report_steps(pair.get("executed_step_delta")),
            report_rate(steps_per_minute(cpu_steps, cpu_wall_ms)),
            report_rate(steps_per_minute(gpu_steps, gpu_wall_ms)),
        )
        detail_table.add_row(
            case_label,
            report_ms(cpu_timing.get("demag_wall_time_ms")),
            report_ms(gpu_timing.get("demag_wall_time_ms")),
            report_value(pair.get("demag_wall_time_speedup_cpu_over_gpu"), suffix="x"),
            report_ms(cpu_timing.get("demag_solver_apply_wall_time_ms")),
            report_ms(gpu_timing.get("demag_solver_apply_wall_time_ms")),
            report_value(pair.get("demag_solver_apply_wall_time_speedup_cpu_over_gpu"), suffix="x"),
            report_value(pair.get("final_e_demag_j_abs_diff"), precision=4),
            report_value(pair.get("final_torque_t_abs_diff"), precision=4),
        )

    rich_console.print(table)
    rich_console.print(detail_table)

    groups = pass_fail_summary.get("solver_mesh_groups", [])
    if groups:
        group_table = Table(
            title="Solver Mesh Groups",
            box=box.HEAVY_HEAD,
            show_lines=True,
            header_style="bold magenta",
        )
        group_table.add_column("Solver mesh signature", overflow="fold")
        group_table.add_column("Status", justify="center")
        group_table.add_column("Rows", justify="right")
        group_table.add_column("OK", justify="right")
        group_table.add_column("Max demag residual", justify="right")
        group_table.add_column("Max demag iterations", justify="right")
        for group in groups:
            if not isinstance(group, Mapping):
                continue
            group_status = str(group.get("status", "-"))
            group_table.add_row(
                str(group.get("solver_mesh_signature", "-")),
                f"[green]{group_status}[/green]" if group_status == "pass" else f"[red]{group_status}[/red]",
                str(group.get("row_count", "-")),
                str(group.get("ok_count", "-")),
                report_value(group.get("max_demag_final_residual_norm"), precision=4),
                report_value(group.get("max_demag_actual_iterations")),
            )
        rich_console.print(group_table)

    return True


def _pdf_text_literal(text: str) -> str:
    safe = text.encode("latin-1", "replace").decode("latin-1")
    return "(" + safe.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") + ")"


def _wrap_report_lines(report_text: str, width: int = 110) -> list[str]:
    wrapped: list[str] = []
    for raw_line in report_text.splitlines():
        line = raw_line.replace("\t", "    ")
        if not line:
            wrapped.append("")
            continue
        while len(line) > width:
            split_at = line.rfind(" ", 0, width)
            if split_at <= 0:
                split_at = width
            wrapped.append(line[:split_at])
            line = line[split_at:].lstrip()
        wrapped.append(line)
    return wrapped


def write_benchmark_pdf_report(output_path: str | Path, report_text: str) -> None:
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = _wrap_report_lines(report_text)
    lines_per_page = 58
    pages = [lines[i:i + lines_per_page] for i in range(0, len(lines), lines_per_page)] or [[]]

    objects: dict[int, bytes] = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        3: b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
    }
    page_ids: list[int] = []
    next_id = 4
    for page_lines in pages:
        content_id = next_id
        page_id = next_id + 1
        next_id += 2
        page_ids.append(page_id)
        content_lines = ["BT", "/F1 9 Tf", "40 800 Td", "12 TL"]
        for line in page_lines:
            content_lines.append(f"{_pdf_text_literal(line)} Tj")
            content_lines.append("T*")
        content_lines.append("ET")
        content = "\n".join(content_lines).encode("latin-1", "replace")
        objects[content_id] = (
            f"<< /Length {len(content)} >>\nstream\n".encode("ascii")
            + content
            + b"\nendstream"
        )
        objects[page_id] = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>"
        ).encode("ascii")

    kids = " ".join(f"{page_id} 0 R" for page_id in page_ids)
    objects[2] = f"<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>".encode("ascii")

    pdf = bytearray(b"%PDF-1.4\n")
    offsets = {0: 0}
    for object_id in sorted(objects):
        offsets[object_id] = len(pdf)
        pdf.extend(f"{object_id} 0 obj\n".encode("ascii"))
        pdf.extend(objects[object_id])
        pdf.extend(b"\nendobj\n")
    xref_offset = len(pdf)
    max_id = max(objects)
    pdf.extend(f"xref\n0 {max_id + 1}\n".encode("ascii"))
    pdf.extend(b"0000000000 65535 f \n")
    for object_id in range(1, max_id + 1):
        pdf.extend(f"{offsets[object_id]:010d} 00000 n \n".encode("ascii"))
    pdf.extend(
        f"trailer\n<< /Size {max_id + 1} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n".encode("ascii")
    )
    path.write_bytes(bytes(pdf))


def cpu_gpu_consistency_failures(
    results: list[dict[str, object]],
    *,
    case_manifests: list[dict[str, object]] | None = None,
    require_gpu_strict_residency: bool = False,
    energy_rtol: float = DEFAULT_CPU_GPU_ENERGY_RTOL,
    energy_atol: float = DEFAULT_CPU_GPU_ENERGY_ATOL_J,
    torque_rtol: float = DEFAULT_CPU_GPU_TORQUE_RTOL,
    torque_atol_apm: float = DEFAULT_CPU_GPU_TORQUE_ATOL_APM,
    torque_atol_t: float = DEFAULT_CPU_GPU_TORQUE_ATOL_T,
    max_step_delta: int = DEFAULT_CPU_GPU_MAX_STEP_DELTA,
) -> list[str]:
    failures = cpu_gpu_required_case_failures(
        results,
        case_manifests=case_manifests,
    )
    if require_gpu_strict_residency:
        failures.extend(gpu_strict_residency_failures(results))
    grouped: dict[tuple[object, ...], dict[str, list[dict[str, object]]]] = {}
    for row in results:
        backend = row.get("backend")
        if backend not in {"fem_cpu", "fem_gpu"}:
            continue
        case = repeated_case_key(row)
        if row.get("status") != "ok":
            failures.append(f"case={case} backend={backend} did not complete{runtime_error_suffix(row)}")
            continue
        execution_failure = resolved_execution_failure(row)
        if execution_failure is not None:
            failures.append(f"case={case} {execution_failure}")
            continue
        key = cpu_gpu_consistency_case_key(row)
        if not key:
            failures.append(f"case={case} backend={backend} is missing solver_mesh_signature")
            continue
        grouped.setdefault(key, {}).setdefault(str(backend), []).append(row)

    if not grouped:
        failures.append("no completed FEM CPU/GPU rows with solver_mesh_signature were produced")
        return failures

    for key, by_backend in sorted(grouped.items(), key=lambda item: str(item[0])):
        cpu_rows = by_backend.get("fem_cpu", [])
        gpu_rows = by_backend.get("fem_gpu", [])
        if not cpu_rows:
            failures.append(f"case={key} is missing a completed fem_cpu row")
            continue
        if not gpu_rows:
            failures.append(f"case={key} is missing a completed fem_gpu row")
            continue
        for cpu_row in cpu_rows:
            for gpu_row in gpu_rows:
                if is_direct_minimizer_relaxation_algorithm(key[3]):
                    continue
                scenario_energy_atol = cpu_gpu_energy_atol_for_scenario(
                    key[1],
                    energy_atol,
                )
                for field in scenario_energy_fields(str(key[1] or "")):
                    compare_cpu_gpu_numeric_field(
                        cpu_row,
                        gpu_row,
                        field,
                        rtol=energy_rtol,
                        atol=scenario_energy_atol,
                        failures=failures,
                        case=key,
                    )
                compare_cpu_gpu_numeric_field(
                    cpu_row,
                    gpu_row,
                    "final_torque_apm",
                    rtol=torque_rtol,
                    atol=torque_atol_apm,
                    failures=failures,
                    case=key,
                )
                compare_cpu_gpu_numeric_field(
                    cpu_row,
                    gpu_row,
                    "final_torque_t",
                    rtol=torque_rtol,
                    atol=torque_atol_t,
                    failures=failures,
                    case=key,
                )
                compare_cpu_gpu_step_count(
                    cpu_row,
                    gpu_row,
                    max_step_delta=max_step_delta,
                    failures=failures,
                    case=key,
                )
    return failures


def solver_mesh_pass_fail_summary_rows(
    results: list[dict[str, object]],
    *,
    max_residual: float | None,
    max_iterations: int | None,
) -> list[dict[str, object]]:
    groups: dict[str, dict[str, object]] = {}
    for row in results:
        signature = str(row.get("solver_mesh_signature") or "missing_solver_mesh_signature")
        group = groups.setdefault(
            signature,
            {
                "solver_mesh_signature": signature,
                "status": "pass",
                "row_count": 0,
                "ok_count": 0,
                "failed_count": 0,
                "failure_count": 0,
                "mesh_paths": set(),
                "scenarios": set(),
                "integrators": set(),
                "thread_specs": set(),
                "error_kinds": set(),
                "max_demag_final_residual_norm": None,
                "max_demag_actual_iterations": None,
            },
        )
        group["row_count"] = int(group["row_count"]) + 1
        if row.get("status") == "ok":
            group["ok_count"] = int(group["ok_count"]) + 1
        else:
            group["failed_count"] = int(group["failed_count"]) + 1
            group["failure_count"] = int(group["failure_count"]) + 1
            group["status"] = "fail"
        for field, set_key in (
            ("mesh_path", "mesh_paths"),
            ("scenario", "scenarios"),
            ("integrator", "integrators"),
            ("requested_cpu_thread_spec", "thread_specs"),
            ("error_kind", "error_kinds"),
        ):
            value = row.get(field)
            if value:
                group[set_key].add(str(value))

        if row_requires_demag_convergence(row):
            residual = as_float(row.get("demag_final_residual_norm"))
            iterations = as_int(row.get("demag_actual_iterations"))
            if residual is None:
                group["failure_count"] = int(group["failure_count"]) + 1
                group["status"] = "fail"
            else:
                current = as_float(group.get("max_demag_final_residual_norm"))
                group["max_demag_final_residual_norm"] = (
                    residual if current is None else max(current, residual)
                )
                residual_limit = demag_row_residual_limit(row, max_residual)
                if residual_limit is None or residual > residual_limit:
                    group["failure_count"] = int(group["failure_count"]) + 1
                    group["status"] = "fail"
            if iterations is None:
                group["failure_count"] = int(group["failure_count"]) + 1
                group["status"] = "fail"
            else:
                current_iterations = as_int(group.get("max_demag_actual_iterations"))
                group["max_demag_actual_iterations"] = (
                    iterations
                    if current_iterations is None
                    else max(current_iterations, iterations)
                )
                if max_iterations is not None and iterations > max_iterations:
                    group["failure_count"] = int(group["failure_count"]) + 1
                    group["status"] = "fail"

    summary_rows: list[dict[str, object]] = []
    for group in groups.values():
        normalized = dict(group)
        for key in ("mesh_paths", "scenarios", "integrators", "thread_specs", "error_kinds"):
            normalized[key] = sorted(normalized[key])
        summary_rows.append(normalized)
    return sorted(summary_rows, key=lambda item: str(item["solver_mesh_signature"]))


def benchmark_pass_fail_summary(
    results: list[dict[str, object]],
    *,
    gate_failures: list[str],
    max_residual: float | None,
    max_iterations: int | None,
) -> dict[str, object]:
    groups = solver_mesh_pass_fail_summary_rows(
        results,
        max_residual=max_residual,
        max_iterations=max_iterations,
    )
    group_failures = sum(int(group["failure_count"]) for group in groups)
    failures = list(gate_failures)
    failures.extend(
        f"solver_mesh_signature={group['solver_mesh_signature']} failed {group['failure_count']} benchmark checks"
        for group in groups
        if int(group["failure_count"]) > 0
    )
    return {
        "status": "pass" if not gate_failures and group_failures == 0 else "fail",
        "row_count": len(results),
        "ok_count": sum(1 for row in results if row.get("status") == "ok"),
        "failed_count": sum(1 for row in results if row.get("status") != "ok"),
        "gate_failure_count": len(gate_failures),
        "group_failure_count": group_failures,
        "failures": failures,
        "solver_mesh_groups": groups,
    }


def emit_pass_fail_summary(
    results: list[dict[str, object]],
    *,
    gate_failures: list[str],
    max_residual: float | None,
    max_iterations: int | None,
) -> None:
    summary = benchmark_pass_fail_summary(
        results,
        gate_failures=gate_failures,
        max_residual=max_residual,
        max_iterations=max_iterations,
    )
    print(f"FEM_PASS_FAIL_SUMMARY={json.dumps(summary, sort_keys=True)}")


def row_requires_demag_convergence(row: Mapping[str, object]) -> bool:
    scenario = str(row.get("scenario") or "")
    return "demag" in scenario


def demag_row_residual_limit(
    row: Mapping[str, object],
    explicit_max_residual: float | None,
) -> float | None:
    if explicit_max_residual is not None:
        return explicit_max_residual
    if (requested := as_float(row.get("requested_demag_relative_tolerance"))) is not None:
        return requested
    return as_float(row.get("demag_relative_tolerance"))


def demag_convergence_failures(
    results: list[dict[str, object]],
    *,
    max_residual: float | None,
    max_iterations: int | None,
) -> list[str]:
    failures: list[str] = []
    for row in results:
        if not row_requires_demag_convergence(row):
            continue
        if row.get("status") != "ok":
            failures.append(
                f"case={repeated_case_key(row)} did not complete before demag convergence check"
                f"{runtime_error_suffix(row)}"
            )
            continue
        residual = as_float(row.get("demag_final_residual_norm"))
        residual_limit = demag_row_residual_limit(row, max_residual)
        iterations = as_int(row.get("demag_actual_iterations"))
        if residual is None:
            failures.append(
                f"case={repeated_case_key(row)} is missing demag_final_residual_norm"
            )
        elif residual_limit is None:
            failures.append(f"case={repeated_case_key(row)} is missing demag rtol")
        elif residual > residual_limit:
            failures.append(
                f"case={repeated_case_key(row)} demag_final_residual_norm={residual} exceeds {residual_limit}"
            )
        if iterations is None:
            failures.append(
                f"case={repeated_case_key(row)} is missing demag_actual_iterations"
            )
        elif max_iterations is not None and iterations > max_iterations:
            failures.append(
                f"case={repeated_case_key(row)} demag_actual_iterations={iterations} exceeds {max_iterations}"
            )
    return failures


def demag_solver_apply_budget_failures(
    results: list[dict[str, object]],
    *,
    max_apply_ms: float,
) -> list[str]:
    failures: list[str] = []
    for row in results:
        if not row_requires_demag_convergence(row):
            continue
        case = repeated_case_key(row)
        if row.get("status") != "ok":
            failures.append(
                f"case={case} did not complete before demag solver apply budget check"
                f"{runtime_error_suffix(row)}"
            )
            continue
        apply_ms = as_float(row.get("demag_solver_apply_wall_time_ms"))
        if apply_ms is None:
            failures.append(
                f"case={case} is missing demag_solver_apply_wall_time_ms"
            )
        elif apply_ms > max_apply_ms:
            failures.append(
                f"case={case} demag_solver_apply_wall_time_ms={apply_ms:.6g} exceeds {max_apply_ms:.6g}"
            )
    return failures


def demag_setup_reuse_failures(results: list[dict[str, object]]) -> list[str]:
    failures: list[str] = []
    for row in results:
        if not row_requires_demag_convergence(row):
            continue
        case = repeated_case_key(row)
        if row.get("status") != "ok":
            failures.append(
                f"case={case} did not complete before demag setup-reuse check"
                f"{runtime_error_suffix(row)}"
            )
            continue
        requested_steps = as_int(row.get("steps")) or 0
        executed_steps = as_int(row.get("executed_steps")) or 0
        if max(requested_steps, executed_steps) <= 1:
            continue
        setup_reused = row.get("demag_solver_setup_reused")
        if setup_reused is None:
            failures.append(f"case={case} is missing demag_solver_setup_reused")
        elif setup_reused is not True:
            failures.append(
                f"case={case} demag_solver_setup_reused is not true for a multi-step demag run"
            )
    return failures


def gpu_ncg_accepted_endpoint_reuse_failures(
    results: list[dict[str, object]],
) -> list[str]:
    failures: list[str] = []
    for row in results:
        if (
            row.get("backend") != "fem_gpu"
            or row.get("relaxation_algorithm") != "nonlinear_cg"
            or not row_requires_demag_convergence(row)
        ):
            continue
        case = repeated_case_key(row)
        if row.get("status") != "ok":
            failures.append(
                f"case={case} did not complete before NCG accepted-endpoint reuse check"
                f"{runtime_error_suffix(row)}"
            )
            continue
        if (as_int(row.get("executed_steps")) or 0) <= 1:
            continue
        rhs_evals = as_int(row.get("rhs_evals"))
        if rhs_evals is None:
            failures.append(f"case={case} is missing rhs_evals")
            continue
        if rhs_evals != 1:
            continue
        demag_solves = as_int(row.get("demag_solves"))
        if demag_solves is None:
            failures.append(f"case={case} is missing demag_solves")
        elif demag_solves != 1:
            failures.append(
                f"case={case} steady accepted step requires demag_solves=1; got {demag_solves}"
            )
    return failures


def gpu_demag_single_setup_failures(
    results: list[dict[str, object]],
) -> list[str]:
    failures: list[str] = []
    for row in results:
        if row.get("backend") != "fem_gpu" or not row_requires_demag_convergence(row):
            continue
        case = repeated_case_key(row)
        if row.get("status") != "ok":
            failures.append(
                f"case={case} did not complete before GPU demag single-setup check"
                f"{runtime_error_suffix(row)}"
            )
            continue
        if (as_int(row.get("executed_steps")) or 0) <= 1:
            continue
        setup_ms = as_float(row.get("demag_solver_setup_wall_time_ms"))
        if setup_ms is None:
            failures.append(
                f"case={case} is missing demag_solver_setup_wall_time_ms"
            )
        elif setup_ms != 0.0:
            failures.append(
                f"case={case} repeated demag setup inside measured steps: {setup_ms:.6g} ms"
            )
        if row.get("demag_solver_setup_reused") is not True:
            failures.append(
                f"case={case} persistent demag setup was not truthfully reported as reused"
            )
    return failures


def gpu_zero_global_sync_failures(
    results: list[dict[str, object]],
) -> list[str]:
    failures: list[str] = []
    for row in results:
        if row.get("backend") != "fem_gpu" or row.get("status") != "ok":
            continue
        case = repeated_case_key(row)
        sync_count = as_int(row.get("hot_loop_compute_host_sync_count"))
        if sync_count is None:
            failures.append(
                f"case={case} is missing hot_loop_compute_host_sync_count"
            )
        elif sync_count != 0:
            failures.append(
                f"case={case} strict GPU path requires hot_loop_compute_host_sync_count=0; got {sync_count}"
            )
    return failures


def runtime_error_suffix(row: Mapping[str, object]) -> str:
    error_kind = row.get("error_kind")
    return f"; error_kind={error_kind}" if error_kind else ""


def row_is_fem_cpu_no_pbc_adaptive_scope(row: Mapping[str, object]) -> bool:
    return (
        row.get("backend") == "fem_cpu"
        and row.get("scenario") in FEM_CPU_NO_PBC_ADAPTIVE_SCENARIOS
        and row.get("timestep_policy") == "adaptive"
        and row.get("integrator") in FEM_CPU_NO_PBC_ADAPTIVE_INTEGRATORS
    )


def require_positive_field(
    row: Mapping[str, object],
    field: str,
    failures: list[str],
    case: tuple[object, ...],
) -> None:
    value = as_float(row.get(field))
    if value is None or value <= 0.0:
        failures.append(f"case={case} is missing positive {field}")


def require_nonnegative_field(
    row: Mapping[str, object],
    field: str,
    failures: list[str],
    case: tuple[object, ...],
) -> None:
    value = as_float(row.get(field))
    if value is None or value < 0.0:
        failures.append(f"case={case} is missing nonnegative {field}")


def require_numeric_field(
    row: Mapping[str, object],
    field: str,
    failures: list[str],
    case: tuple[object, ...],
) -> None:
    if as_float(row.get(field)) is None:
        failures.append(f"case={case} is missing numeric {field}")


def require_executed_steps_cover_request(
    row: Mapping[str, object],
    failures: list[str],
    case: tuple[object, ...],
) -> None:
    executed_steps = as_int(row.get("executed_steps"))
    requested_steps = as_int(row.get("steps"))
    if executed_steps is None or requested_steps is None:
        return
    if executed_steps < requested_steps:
        failures.append(
            f"case={case} executed_steps={executed_steps} is less than requested steps={requested_steps}"
        )


def require_exact_field(
    row: Mapping[str, object],
    field: str,
    expected: object,
    failures: list[str],
    case: tuple[object, ...],
) -> None:
    actual = row.get(field)
    if actual != expected:
        failures.append(f"case={case} {field}={actual!r} is not {expected!r}")


def require_field_in(
    row: Mapping[str, object],
    field: str,
    expected_values: set[object],
    failures: list[str],
    case: tuple[object, ...],
) -> None:
    actual = row.get(field)
    if actual not in expected_values:
        expected = ", ".join(str(value) for value in sorted(expected_values))
        failures.append(f"case={case} {field}={actual!r} is not one of {expected}")


def fem_cpu_no_pbc_adaptive_readiness_failures(
    results: list[dict[str, object]],
    *,
    max_residual: float,
    max_iterations: int | None,
    min_qualified_steps: int = 1,
    required_mesh_paths: set[str] | None = None,
    required_scenarios: set[str] | None = None,
    required_integrators: set[str] | None = None,
    required_thread_specs: set[str] | None = None,
) -> list[str]:
    scoped_rows = [row for row in results if row_is_fem_cpu_no_pbc_adaptive_scope(row)]
    if not scoped_rows:
        return [
            "no FEM CPU exchange_demag_anis_* adaptive rk23/rk45 benchmark row was produced"
        ]

    failures: list[str] = []
    if (
        required_mesh_paths is not None
        or required_scenarios is not None
        or required_integrators is not None
        or required_thread_specs is not None
    ):
        mesh_paths = required_mesh_paths or {str(row.get("mesh_path")) for row in scoped_rows}
        scenarios = (required_scenarios or set()) & FEM_CPU_NO_PBC_ADAPTIVE_SCENARIOS
        integrators = (required_integrators or set()) & FEM_CPU_NO_PBC_ADAPTIVE_INTEGRATORS
        thread_specs = required_thread_specs or {
            str(row.get("requested_cpu_thread_spec")) for row in scoped_rows
        }
        expected_cases = {
            (mesh_path, scenario, integrator, thread_spec)
            for mesh_path in mesh_paths
            for scenario in scenarios
            for integrator in integrators
            for thread_spec in thread_specs
        }
        present_cases = {
            (
                str(row.get("mesh_path")),
                str(row.get("scenario")),
                str(row.get("integrator")),
                str(row.get("requested_cpu_thread_spec")),
            )
            for row in scoped_rows
        }
        for mesh_path, scenario, integrator, thread_spec in sorted(expected_cases):
            if (mesh_path, scenario, integrator, thread_spec) not in present_cases:
                failures.append(
                    f"missing FEM CPU no-PBC adaptive readiness row for mesh_path={mesh_path} scenario={scenario} integrator={integrator} thread_count={thread_spec}"
                )
    for row in scoped_rows:
        case = repeated_case_key(row)
        if row.get("status") != "ok":
            failures.append(f"case={case} did not complete{runtime_error_suffix(row)}")
            continue
        if row.get("reported_precision") != "double":
            failures.append(f"case={case} reported_precision is not double")
        require_field_in(
            row,
            "reported_scenario",
            {
                "exchange_demag_anis_uniaxial",
                "exchange_demag_anis_cubic",
                "exchange_demag_anisotropy",
            },
            failures,
            case,
        )
        reported_integrator = row.get("reported_integrator")
        if reported_integrator not in {"rk23", "rk45"}:
            failures.append(
                f"case={case} reported_integrator={reported_integrator!r} is not rk23/rk45"
            )
        require_exact_field(
            row,
            "reported_timestep_policy",
            "adaptive",
            failures,
            case,
        )
        require_exact_field(row, "execution_engine", "fem_cpu_native", failures, case)
        require_exact_field(row, "fem_execution_mode", "cpu_native", failures, case)
        require_exact_field(row, "mfem_device", "cpu", failures, case)
        require_exact_field(
            row,
            "fem_data_residency",
            "host_source_of_truth",
            failures,
            case,
        )
        require_exact_field(row, "uses_cuda_kernels", False, failures, case)
        require_exact_field(row, "uses_gpu_poisson", False, failures, case)
        refresh_interval = as_float(row.get("demag_refresh_interval_s"))
        if refresh_interval is not None and refresh_interval > 0.0:
            failures.append(
                f"case={case} demag_refresh_interval_s={refresh_interval} enables frozen demag refresh"
            )
        require_exact_field(row, "demag_model", "airbox", failures, case)
        require_exact_field(row, "demag_boundary_variant", "robin", failures, case)
        require_exact_field(
            row,
            "domain_mesh_mode",
            "shared_domain_mesh_with_air",
            failures,
            case,
        )
        require_exact_field(row, "solver_mesh_has_air", True, failures, case)
        if as_int(row.get("periodic_boundary_pair_count")) != 0:
            failures.append(f"case={case} periodic_boundary_pair_count is not zero")
        if as_int(row.get("periodic_node_pair_count")) != 0:
            failures.append(f"case={case} periodic_node_pair_count is not zero")

        require_positive_field(row, "executed_steps", failures, case)
        require_executed_steps_cover_request(row, failures, case)
        executed_steps = as_int(row.get("executed_steps"))
        if (
            executed_steps is not None
            and executed_steps < min_qualified_steps
            and row.get("stop_reason") != "torque"
        ):
            failures.append(
                f"case={case} executed_steps={executed_steps} is less than minimum qualified steps={min_qualified_steps} without stop_reason=torque"
            )
        require_positive_field(row, "final_solver_dt_s", failures, case)
        require_nonnegative_field(row, "error_estimate", failures, case)
        require_positive_field(row, "dt_suggested_s", failures, case)
        require_positive_field(row, "demag_solves", failures, case)
        require_positive_field(row, "rhs_evals", failures, case)
        for energy_field in ("final_e_ex_j", "final_e_demag_j", "final_e_ani_j"):
            require_numeric_field(row, energy_field, failures, case)
        for timing_field in (
            "demag_assemble_wall_time_ms",
            "demag_solve_wall_time_ms",
            "demag_solver_setup_wall_time_ms",
            "demag_solver_apply_wall_time_ms",
            "demag_recover_wall_time_ms",
            "demag_energy_wall_time_ms",
        ):
            require_nonnegative_field(row, timing_field, failures, case)
        if row.get("demag_solver_setup_reused") is None:
            failures.append(f"case={case} is missing demag_solver_setup_reused")
        elif as_int(row.get("steps")) and as_int(row.get("steps")) > 1:
            if row.get("demag_solver_setup_reused") is not True:
                failures.append(
                    f"case={case} demag_solver_setup_reused is not true after the first step"
                )

        residual = as_float(row.get("demag_final_residual_norm"))
        iterations = as_int(row.get("demag_actual_iterations"))
        if residual is None:
            failures.append(f"case={case} is missing demag_final_residual_norm")
        elif residual > max_residual:
            failures.append(
                f"case={case} demag_final_residual_norm={residual} exceeds {max_residual}"
            )
        if iterations is None:
            failures.append(f"case={case} is missing demag_actual_iterations")
        elif max_iterations is not None and iterations > max_iterations:
            failures.append(
                f"case={case} demag_actual_iterations={iterations} exceeds {max_iterations}"
            )
    return failures


def demag_policy_selection_case_key(row: Mapping[str, object]) -> tuple[object, ...]:
    return (
        row.get("backend"),
        row.get("mesh_path"),
        row.get("scenario"),
        row.get("integrator"),
        row.get("relaxation_algorithm"),
        row.get("timestep_policy"),
        row.get("dt_s"),
        row.get("steps"),
        row.get("requested_cpu_thread_spec"),
        row.get("requested_demag_relative_tolerance"),
        row.get("requested_demag_absolute_tolerance"),
        row.get("requested_demag_max_iterations"),
        row.get("requested_demag_print_level"),
    )


def demag_policy_identity(row: Mapping[str, object]) -> tuple[object, ...]:
    return (
        first_present(row.get("requested_demag_solver"), row.get("demag_linear_solver")),
        first_present(
            row.get("requested_demag_preconditioner"),
            row.get("demag_preconditioner"),
        ),
        first_present(
            row.get("requested_demag_amg_relax_type"),
            row.get("demag_amg_relax_type"),
        ),
        first_present(
            row.get("requested_demag_amg_coarsening"),
            row.get("demag_amg_coarsening"),
        ),
        first_present(
            row.get("requested_demag_amg_interpolation"),
            row.get("demag_amg_interpolation"),
        ),
        first_present(
            row.get("requested_demag_amg_aggressive_coarsening"),
            row.get("demag_amg_aggressive_coarsening"),
        ),
        first_present(
            row.get("requested_demag_amg_strength_threshold"),
            row.get("demag_amg_strength_threshold"),
        ),
        first_present(
            row.get("requested_demag_amg_max_levels"),
            row.get("demag_amg_max_levels"),
        ),
    )


def demag_policy_timing_ms(
    row: Mapping[str, object],
    selection_metric: str = DEFAULT_BEST_DEMAG_POLICY_METRIC,
) -> float | None:
    timing = demag_policy_timing(row, selection_metric)
    return timing[0] if timing is not None else None


def demag_policy_timing(
    row: Mapping[str, object],
    selection_metric: str = DEFAULT_BEST_DEMAG_POLICY_METRIC,
) -> tuple[float, str] | None:
    for field in (selection_metric, *BEST_DEMAG_POLICY_METRICS):
        value = as_float(row.get(field))
        if value is not None:
            return value, field
    return None


def average_demag_policy_metric(
    rows: list[dict[str, object]],
    field: str,
) -> float | None:
    values = [
        value
        for row in rows
        if (value := as_float(row.get(field))) is not None
    ]
    if not values:
        return None
    return sum(values) / len(values)


def best_demag_policy_rows(
    results: list[dict[str, object]],
    *,
    max_residual: float | None,
    max_iterations: int | None,
    selection_metric: str = DEFAULT_BEST_DEMAG_POLICY_METRIC,
) -> list[dict[str, object]]:
    grouped: dict[tuple[object, ...], dict[tuple[object, ...], list[dict[str, object]]]] = {}
    for row in results:
        if not row_requires_demag_convergence(row) or row.get("status") != "ok":
            continue
        residual = as_float(row.get("demag_final_residual_norm"))
        iterations = as_int(row.get("demag_actual_iterations"))
        residual_limit = demag_row_residual_limit(row, max_residual)
        if (
            residual is None
            or residual_limit is None
            or iterations is None
            or residual > residual_limit
        ):
            continue
        if max_iterations is not None and iterations > max_iterations:
            continue
        if demag_policy_timing_ms(row, selection_metric) is None:
            continue
        grouped.setdefault(demag_policy_selection_case_key(row), {}).setdefault(
            demag_policy_identity(row),
            [],
        ).append(row)

    summaries: list[dict[str, object]] = []
    for case_key, rows_by_policy in grouped.items():
        mesh_signatures = stable_demag_policy_case_mesh_signatures(rows_by_policy)
        if len(mesh_signatures) > 1:
            continue
        best_summary: dict[str, object] | None = None
        best_sort_key: tuple[float, float, int] | None = None
        for policy, rows in rows_by_policy.items():
            timing_pairs = [
                timing
                for row in rows
                if (timing := demag_policy_timing(row, selection_metric)) is not None
            ]
            timings = [timing for timing, _ in timing_pairs]
            residuals = [
                residual
                for row in rows
                if (residual := as_float(row.get("demag_final_residual_norm"))) is not None
            ]
            iterations = [
                iteration
                for row in rows
                if (iteration := as_int(row.get("demag_actual_iterations"))) is not None
            ]
            if not timings or not residuals or not iterations:
                continue
            average_timing = sum(timings) / len(timings)
            selection_timing_fields = sorted({field for _, field in timing_pairs})
            selection_timing_field = (
                selection_timing_fields[0]
                if len(selection_timing_fields) == 1
                else ",".join(selection_timing_fields)
            )
            wall_timing = average_demag_policy_metric(rows, "demag_wall_time_ms")
            apply_timing = average_demag_policy_metric(
                rows,
                "demag_solver_apply_wall_time_ms",
            )
            max_residual_seen = max(residuals)
            max_iterations_seen = max(iterations)
            sort_key = (average_timing, max_residual_seen, max_iterations_seen)
            candidate = {
                "case_key": list(case_key),
                "demag_solver": policy[0],
                "demag_preconditioner": policy[1],
                "demag_amg_relax_type": policy[2],
                "demag_amg_coarsening": policy[3],
                "demag_amg_interpolation": policy[4],
                "demag_amg_aggressive_coarsening": policy[5],
                "demag_amg_strength_threshold": policy[6],
                "demag_amg_max_levels": policy[7],
                "row_count": len(rows),
                "selection_timing_field": selection_timing_field,
                "average_demag_timing_ms": round(average_timing, 6),
                "average_demag_wall_time_ms": (
                    round(wall_timing, 6) if wall_timing is not None
                    else None
                ),
                "average_demag_solver_apply_wall_time_ms": (
                    round(apply_timing, 6) if apply_timing is not None
                    else None
                ),
                "max_demag_final_residual_norm": max_residual_seen,
                "max_demag_actual_iterations": max_iterations_seen,
            }
            if best_sort_key is None or sort_key < best_sort_key:
                best_sort_key = sort_key
                best_summary = candidate
        if best_summary is not None:
            best_summary["converged_policy_count"] = len(rows_by_policy)
            if len(mesh_signatures) == 1:
                best_summary["solver_mesh_signature"] = mesh_signatures[0]
            summaries.append(best_summary)
    return summaries


def stable_demag_policy_case_mesh_signatures(
    rows_by_policy: Mapping[tuple[object, ...], list[dict[str, object]]],
) -> list[str]:
    signatures = {
        str(signature)
        for rows in rows_by_policy.values()
        for row in rows
        if (signature := row.get("solver_mesh_signature"))
    }
    return sorted(signatures)


def demag_policy_unstable_solver_mesh_failures(
    results: list[dict[str, object]],
) -> list[str]:
    grouped: dict[
        tuple[object, ...],
        dict[tuple[object, ...], list[dict[str, object]]],
    ] = {}
    for row in results:
        if not row_requires_demag_convergence(row) or row.get("status") != "ok":
            continue
        grouped.setdefault(demag_policy_selection_case_key(row), {}).setdefault(
            demag_policy_identity(row),
            [],
        ).append(row)

    failures: list[str] = []
    for case, rows_by_policy in grouped.items():
        signatures = stable_demag_policy_case_mesh_signatures(rows_by_policy)
        if len(signatures) <= 1:
            continue
        failures.append(
            f"case={case} cannot select a best demag policy because policy rows "
            f"used {len(signatures)} solver_mesh_signature values"
        )
    return failures


def best_demag_policy_failures(
    results: list[dict[str, object]],
    *,
    max_residual: float | None,
    max_iterations: int | None,
    selection_metric: str = DEFAULT_BEST_DEMAG_POLICY_METRIC,
) -> list[str]:
    candidate_cases = {
        demag_policy_selection_case_key(row)
        for row in results
        if row_requires_demag_convergence(row)
    }
    if not candidate_cases:
        return ["no demag benchmark case was produced for policy selection"]

    error_kinds_by_case: dict[tuple[object, ...], set[object]] = {}
    for row in results:
        if not row_requires_demag_convergence(row):
            continue
        error_kind = row.get("error_kind")
        if error_kind:
            error_kinds_by_case.setdefault(demag_policy_selection_case_key(row), set()).add(
                error_kind
            )

    selected_summaries = {
        tuple(summary["case_key"]): summary
        for summary in best_demag_policy_rows(
            results,
            max_residual=max_residual,
            max_iterations=max_iterations,
            selection_metric=selection_metric,
        )
    }
    failures: list[str] = demag_policy_unstable_solver_mesh_failures(results)
    for case in sorted(candidate_cases, key=str):
        if any(
            f"case={case} cannot select a best demag policy" in failure
            for failure in failures
        ):
            continue
        summary = selected_summaries.get(case)
        if summary is None:
            error_kinds = sorted(str(kind) for kind in error_kinds_by_case.get(case, set()))
            suffix = f"; error_kind={','.join(error_kinds)}" if error_kinds else ""
            failures.append(f"no converged demag policy for case={case}{suffix}")
            continue
        converged_policy_count = as_int(summary.get("converged_policy_count")) or 0
        if converged_policy_count < MIN_CONVERGED_DEMAG_POLICIES_FOR_BEST:
            failures.append(
                f"case={case} has {converged_policy_count} converged demag policy; "
                f"at least {MIN_CONVERGED_DEMAG_POLICIES_FOR_BEST} are required to select a best policy"
            )
    return failures


def main() -> None:
    args = parse_args()
    apply_fem_cpu_no_pbc_adaptive_ready_preset(args)
    apply_box500_airbox_exchange_only_preset(args)
    apply_box500_airbox_interaction_consistency_preset(args)
    if not args.skip_preflight:
        preflight_env: Mapping[str, str] | None = None
        if args.require_adaptive_gpu_rk_acceptance:
            required_env = dict(os.environ)
            required_env.setdefault("FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC", "1")
            preflight_env = required_env
        preflight = build_preflight_report(preflight_env)
        print(f"FEM_PREFLIGHT={json.dumps(preflight, sort_keys=True)}", flush=True)
        require_mfem_stack = args.require_mfem_stack or bool(
            preflight.get("fullmag_use_mfem_stack_enabled")
        )
        failures = preflight_failures(
            preflight,
            require_mfem_stack=require_mfem_stack,
            require_adaptive_gpu_rk_acceptance=args.require_adaptive_gpu_rk_acceptance,
        )
        if failures:
            for failure in failures:
                print(f"FEM_PREFLIGHT_ERROR={failure}", file=sys.stderr)
            raise SystemExit(2)
    if args.preflight_only:
        return
    if args.write_fixture_manifest is not None or args.write_fixture_suite is not None:
        fixture_input_meshes = resolve_meshes(args.meshes, args.sizes)
        if len(fixture_input_meshes) != 1:
            raise SystemExit("fixture generation requires exactly one input mesh preset")
        write_performance_fixture_files(
            args,
            input_mesh_path=fixture_input_meshes[0],
        )
        return
    fixture_expected_sha256 = None
    if args.fixture_environment is not None:
        if args.fixture_manifest is None:
            raise SystemExit("--fixture-environment needs --fixture-manifest")
        fixture_expected_sha256 = fixture_manifest_sha256_from_environment(
            args.fixture_environment,
            args.fixture_manifest,
        )
    fixture = (
        load_fixture_manifest(
            args.fixture_manifest,
            expected_manifest_sha256=fixture_expected_sha256,
        )
        if args.fixture_manifest is not None
        else None
    )
    if args.require_fixture_identity and fixture is None:
        raise SystemExit("--require-fixture-identity needs --fixture-manifest")
    if args.require_fixture_identity and args.fixture_environment is None:
        raise SystemExit("--require-fixture-identity needs --fixture-environment")
    repeat_count = max(1, args.repeat)

    meshes = resolve_meshes(args.meshes, args.sizes)
    scenarios = resolve_scenarios(args.scenarios)
    integrators = resolve_integrators(args.integrators or ",".join(DEFAULT_INTEGRATORS))
    relaxation_algorithms = resolve_relaxation_algorithms(args.relax_algorithms)
    timestep_policies = resolve_timestep_policies(args.timestep_policies)
    backends = resolve_backends(args.backends)
    if args.require_cpu_gpu_consistency and "fem_gpu" in backends:
        gpu_failure = runtime_gpu_availability_failure(FULLMAG_GPU)
        if gpu_failure is not None:
            print(f"FEM_PREFLIGHT_ERROR={gpu_failure}", file=sys.stderr)
            raise SystemExit(2)
    thread_specs = resolve_thread_count_specs(args.thread_counts)
    demag_solvers = resolve_demag_solvers(args.demag_solvers, args.demag_solver)
    demag_preconditioners = resolve_demag_preconditioners(
        args.demag_preconditioners,
        args.demag_preconditioner,
    )
    demag_rtols = resolve_demag_rtols(args.demag_rtols, args.demag_rtol)
    demag_amg_profiles = [
        (
            relax_type,
            coarsening,
            interpolation,
            aggressive_coarsening,
            strength_threshold,
            max_levels,
        )
        for relax_type in resolve_nonnegative_ints(
            args.demag_amg_relax_types,
            DEFAULT_DEMAG_AMG_RELAX_TYPE,
        )
        for coarsening in resolve_nonnegative_ints(
            args.demag_amg_coarsenings,
            DEFAULT_DEMAG_AMG_COARSENING,
        )
        for interpolation in resolve_nonnegative_ints(
            args.demag_amg_interpolations,
            DEFAULT_DEMAG_AMG_INTERPOLATION,
        )
        for aggressive_coarsening in resolve_nonnegative_ints(
            args.demag_amg_aggressive_coarsenings,
            DEFAULT_DEMAG_AMG_AGGRESSIVE_COARSENING,
        )
        for strength_threshold in resolve_optional_nonnegative_floats(
            args.demag_amg_strength_thresholds,
        )
        for max_levels in resolve_optional_nonnegative_ints(
            args.demag_amg_max_levels,
        )
    ]
    try:
        relax_torque_tolerance_apm = resolve_relax_torque_tolerance_apm(args)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    relax_env = {}
    if relax_torque_tolerance_apm is not None:
        relax_env["FULLMAG_BENCH_RELAX_TORQUE_TOLERANCE"] = repr(
            relax_torque_tolerance_apm
        )
    cpu_gpu_manifests = cpu_gpu_case_manifests(
        scenarios=scenarios,
        relaxation_algorithms=relaxation_algorithms,
        steps=args.steps,
        dt=args.dt,
        energy_rtol=args.cpu_gpu_energy_rtol,
        energy_atol=args.cpu_gpu_energy_atol,
        torque_rtol=args.cpu_gpu_torque_rtol,
        torque_atol_apm=args.cpu_gpu_torque_atol_apm,
        torque_atol_t=args.cpu_gpu_torque_atol_t,
        max_step_delta=args.cpu_gpu_max_step_delta,
        relax_torque_tolerance_apm=relax_torque_tolerance_apm,
        relax_torque_tolerance_t=args.relax_torque_tolerance_t,
    )
    mesh_env = benchmark_mesh_env(args)
    results: list[dict[str, object]] = []
    persistent_domain_mesh_cache_dir = args.generated_domain_mesh_cache_dir
    if args.reuse_generated_domain_mesh and persistent_domain_mesh_cache_dir is not None:
        persistent_domain_mesh_cache_dir.mkdir(parents=True, exist_ok=True)
    domain_mesh_tmp = (
        tempfile.TemporaryDirectory(prefix="fullmag_domain_mesh_cache_")
        if args.reuse_generated_domain_mesh and persistent_domain_mesh_cache_dir is None
        else None
    )
    domain_mesh_cache_dir = (
        persistent_domain_mesh_cache_dir
        if persistent_domain_mesh_cache_dir is not None
        else Path(domain_mesh_tmp.name) if domain_mesh_tmp is not None else None
    )
    domain_mesh_cache: dict[tuple[str, ...], Path] = {}

    print(
        f"FEM benchmark sweep: backends={','.join(backends)} meshes={len(meshes)} scenarios={len(scenarios)} integrators={len(integrators)} relaxation_algorithms={','.join(relaxation_algorithms)} timestep_policies={','.join(timestep_policies)} demag_solvers={','.join(demag_solvers)} demag_preconditioners={','.join(demag_preconditioners)} demag_rtols={','.join(repr(value) for value in demag_rtols)} demag_amg_profiles={len(demag_amg_profiles)} repeat={repeat_count} steps={args.steps} dt={args.dt:.3e} s"
    )
    if args.gpu_warmup and "fem_gpu" in backends:
        warmup_mesh = meshes[0]
        warmup_scenario = scenarios[0]
        warmup_relaxation_algorithms = (
            relaxation_algorithms_for_scenario(warmup_scenario, relaxation_algorithms)
            if benchmark_scenario_uses_relaxation(warmup_scenario)
            else [None]
        )
        warmup_relaxation_algorithm = (
            warmup_relaxation_algorithms[0]
            if warmup_relaxation_algorithms
            else None
        )
        if warmup_relaxation_algorithms and relaxation_algorithm_supported_on_backend(
            warmup_relaxation_algorithm,
            "fem_gpu",
        ):
            warmup_solver, warmup_preconditioner = demag_policy_pairs_for_scenario(
                warmup_scenario,
                demag_solvers,
                demag_preconditioners,
            )[0]
            warmup_rtol = qualified_demag_rtol_for_relaxation_algorithm(
                warmup_relaxation_algorithm,
                demag_rtols[0],
            )
            warmup_amg_profile = demag_amg_profiles_for_preconditioner(
                warmup_preconditioner,
                demag_amg_profiles,
            )[0]
            warmup_domain_mesh_env = generated_domain_mesh_env(
                cache=domain_mesh_cache,
                cache_dir=domain_mesh_cache_dir,
                mesh_path=warmup_mesh,
                scenario=warmup_scenario,
                integrator=integrators[0],
                steps=args.steps,
                dt=args.dt,
                timestep_policy=timestep_policies[0],
                thread_spec=thread_specs[0],
                extra_env={
                    **mesh_env,
                    **relax_env,
                },
                timeout_s=args.case_timeout_s,
            )
            if fixture is not None:
                warmup_domain_mesh_env = {
                    "FULLMAG_BENCH_DOMAIN_MESH": str(runtime_fixture_mesh_path(fixture))
                }
            print(
                f"  gpu_warmup scenario={warmup_scenario} relaxation_algorithm={warmup_relaxation_algorithm or 'none'} demag_policy={warmup_solver}/{warmup_preconditioner} demag_rtol={warmup_rtol!r} demag_amg_profile={warmup_amg_profile}",
                flush=True,
            )
            warmup_row = run_backend(
                backend_label="fem_gpu",
                binary=FULLMAG_GPU,
                mesh_path=warmup_mesh,
                scenario=warmup_scenario,
                integrator=integrators[0],
                relaxation_algorithm=warmup_relaxation_algorithm,
                steps=args.steps,
                dt=args.dt,
                timestep_policy=timestep_policies[0],
                thread_spec=thread_specs[0],
                timeout_s=args.case_timeout_s,
                extra_env={
                    **mesh_env,
                    **relax_env,
                    **warmup_domain_mesh_env,
                    **demag_policy_env(
                        warmup_solver,
                        warmup_preconditioner,
                        warmup_rtol,
                        warmup_amg_profile,
                        args,
                    ),
                },
            )
            if warmup_row.get("status") != "ok":
                print(
                    f"FEM_GPU_WARMUP_ERROR={warmup_row.get('status')}: {warmup_row.get('error')}",
                    file=sys.stderr,
                )
                raise SystemExit(2)
    for mesh_path in meshes:
        mesh_stats = load_mesh_stats(mesh_path)
        print(f"  {input_mesh_summary(mesh_stats)}")
        for scenario in scenarios:
            scenario_relaxation_algorithms: list[str | None] = (
                relaxation_algorithms_for_scenario(scenario, relaxation_algorithms)
                if benchmark_scenario_uses_relaxation(scenario)
                else [None]
            )
            for relaxation_algorithm in scenario_relaxation_algorithms:
                for integrator in integrators:
                    for timestep_policy in timestep_policies:
                        for thread_spec in thread_specs:
                            domain_mesh_env = generated_domain_mesh_env(
                                cache=domain_mesh_cache,
                                cache_dir=domain_mesh_cache_dir,
                                mesh_path=mesh_path,
                                scenario=scenario,
                                integrator=integrator,
                                steps=args.steps,
                                dt=args.dt,
                                timestep_policy=timestep_policy,
                                thread_spec=thread_spec,
                                extra_env={
                                    **mesh_env,
                                    **relax_env,
                                },
                                timeout_s=args.case_timeout_s,
                            )
                            if fixture is not None:
                                domain_mesh_env = {
                                    "FULLMAG_BENCH_DOMAIN_MESH": str(
                                        runtime_fixture_mesh_path(fixture)
                                    )
                                }
                            demag_policy_pairs = demag_policy_pairs_for_scenario(
                                scenario,
                                demag_solvers,
                                demag_preconditioners,
                            )
                            for demag_rtol in demag_rtols:
                                qualified_demag_rtol = (
                                    qualified_demag_rtol_for_relaxation_algorithm(
                                        relaxation_algorithm,
                                        demag_rtol,
                                    )
                                )
                                for demag_solver, demag_preconditioner in demag_policy_pairs:
                                    for demag_amg_profile in demag_amg_profiles_for_preconditioner(
                                        demag_preconditioner,
                                        demag_amg_profiles,
                                    ):
                                        demag_env = demag_policy_env(
                                            demag_solver,
                                            demag_preconditioner,
                                            qualified_demag_rtol,
                                            demag_amg_profile,
                                            args,
                                        )
                                        executed_problem_ir = None
                                        if fixture is not None:
                                            executed_problem_ir = canonical_problem_ir(
                                                mesh_path=mesh_path,
                                                domain_mesh_path=Path(
                                                    domain_mesh_env.get(
                                                        "FULLMAG_BENCH_DOMAIN_MESH",
                                                        str(mesh_path),
                                                    )
                                                ),
                                                scenario=scenario,
                                                integrator=integrator,
                                                relaxation_algorithm=(
                                                    relaxation_algorithm
                                                    or "llg_overdamped"
                                                ),
                                                steps=args.steps,
                                                dt=args.dt,
                                                timestep_policy=timestep_policy,
                                                extra_env={
                                                    **mesh_env,
                                                    **relax_env,
                                                    **demag_env,
                                                },
                                            )
                                        relaxation_label = relaxation_algorithm or "none"
                                        print(
                                            f"    scenario={scenario} relaxation_algorithm={relaxation_label} integrator={integrator} timestep_policy={timestep_policy} thread_count={thread_spec.label}:{thread_spec.env_value} demag_policy={demag_solver}/{demag_preconditioner} demag_rtol={qualified_demag_rtol!r} demag_amg_profile={demag_amg_profile}"
                                        )
                                        for repeat_index in range(repeat_count):
                                            for backend in backends:
                                                if not relaxation_algorithm_supported_on_backend(
                                                    relaxation_algorithm,
                                                    backend,
                                                ):
                                                    print(
                                                        f"      skip backend={backend} relaxation_algorithm={relaxation_label}: unsupported lane"
                                                    )
                                                    continue
                                                if backend == "fem_cpu":
                                                    row = run_backend(
                                                        backend_label="fem_cpu",
                                                        binary=FULLMAG_CPU,
                                                        mesh_path=mesh_path,
                                                        scenario=scenario,
                                                        integrator=integrator,
                                                        relaxation_algorithm=relaxation_algorithm,
                                                        steps=args.steps,
                                                        dt=args.dt,
                                                        timestep_policy=timestep_policy,
                                                        thread_spec=thread_spec,
                                                        timeout_s=args.case_timeout_s,
                                                        problem_ir=executed_problem_ir,
                                                        extra_env={
                                                            "FULLMAG_FEM_EXECUTION": "cpu",
                                                            **demag_env,
                                                            **mesh_env,
                                                            **relax_env,
                                                            **domain_mesh_env,
                                                        },
                                                    )
                                                elif backend == "fem_gpu":
                                                    row = run_backend(
                                                        backend_label="fem_gpu",
                                                        binary=FULLMAG_GPU,
                                                        mesh_path=mesh_path,
                                                        scenario=scenario,
                                                        integrator=integrator,
                                                        relaxation_algorithm=relaxation_algorithm,
                                                        steps=args.steps,
                                                        dt=args.dt,
                                                        timestep_policy=timestep_policy,
                                                        thread_spec=thread_spec,
                                                        timeout_s=args.case_timeout_s,
                                                        problem_ir=executed_problem_ir,
                                                        extra_env={
                                                            "FULLMAG_FEM_GPU_INDEX": "0",
                                                            **demag_env,
                                                            **mesh_env,
                                                            **relax_env,
                                                            **domain_mesh_env,
                                                        },
                                                    )
                                                else:
                                                    continue
                                                row["repeat_index"] = repeat_index
                                                results.append(row)

    write_csv(results, args.output)
    demag_residual_threshold = args.demag_convergence_residual
    best_policy_rows: list[dict[str, object]] = []
    if args.emit_best_demag_policy or args.require_best_demag_policy:
        best_policy_rows = best_demag_policy_rows(
            results,
            max_residual=demag_residual_threshold,
            max_iterations=args.demag_convergence_max_iterations,
            selection_metric=args.best_demag_policy_metric,
        )
    cpu_gpu_summary_for_report: dict[str, object] | None = None
    if args.cpu_gpu_summary_output:
        cpu_gpu_summary_for_report = write_cpu_gpu_consistency_summary(
            results,
            args.cpu_gpu_summary_output,
            case_manifests=cpu_gpu_manifests,
            require_gpu_strict_residency=args.require_gpu_strict_residency,
            energy_rtol=args.cpu_gpu_energy_rtol,
            energy_atol=args.cpu_gpu_energy_atol,
            torque_rtol=args.cpu_gpu_torque_rtol,
            torque_atol_apm=args.cpu_gpu_torque_atol_apm,
            torque_atol_t=args.cpu_gpu_torque_atol_t,
            max_step_delta=args.cpu_gpu_max_step_delta,
        )
        cpu_gpu_summary_for_report["performance_distributions"] = (
            performance_distribution_summary(results)
        )
        if best_policy_rows:
            cpu_gpu_summary_for_report["best_demag_policy"] = best_policy_rows
        summary_path = Path(args.cpu_gpu_summary_output)
        summary_path.write_text(
            json.dumps(cpu_gpu_summary_for_report, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    gate_failures: list[str] = []
    gate_exit_code = 0
    if args.require_fixture_identity and fixture is not None:
        for row in results:
            failures = verify_fixture_row(row, fixture)
            if failures:
                gate_failures.extend(
                    f"case={repeated_case_key(row)} {failure}" for failure in failures
                )
        if gate_failures:
            gate_exit_code = gate_exit_code or 18
    if args.require_stable_solver_mesh:
        failures = unstable_solver_mesh_groups(results)
        if failures:
            gate_failures.extend(failures)
            gate_exit_code = gate_exit_code or 3
    if args.require_demag_converged:
        failures = demag_convergence_failures(
            results,
            max_residual=demag_residual_threshold,
            max_iterations=args.demag_convergence_max_iterations,
        )
        if failures:
            gate_failures.extend(failures)
            gate_exit_code = gate_exit_code or 4
    if args.max_demag_solver_apply_ms is not None:
        failures = demag_solver_apply_budget_failures(
            results,
            max_apply_ms=args.max_demag_solver_apply_ms,
        )
        if failures:
            gate_failures.extend(failures)
            gate_exit_code = gate_exit_code or 13
    if args.require_demag_setup_reused:
        failures = demag_setup_reuse_failures(results)
        if failures:
            gate_failures.extend(failures)
            gate_exit_code = gate_exit_code or 14
    if args.require_ncg_accepted_endpoint_reuse:
        failures = gpu_ncg_accepted_endpoint_reuse_failures(results)
        if failures:
            gate_failures.extend(failures)
            gate_exit_code = gate_exit_code or 15
    if args.require_demag_single_setup:
        failures = gpu_demag_single_setup_failures(results)
        if failures:
            gate_failures.extend(failures)
            gate_exit_code = gate_exit_code or 16
    if args.require_zero_strict_gpu_global_sync:
        failures = gpu_zero_global_sync_failures(results)
        if failures:
            gate_failures.extend(failures)
            gate_exit_code = gate_exit_code or 17
    if args.require_fem_cpu_no_pbc_adaptive_ready:
        failures = fem_cpu_no_pbc_adaptive_readiness_failures(
            results,
            max_residual=demag_residual_threshold,
            max_iterations=args.demag_convergence_max_iterations,
            min_qualified_steps=args.min_qualified_steps,
            required_mesh_paths={str(mesh_path) for mesh_path in meshes},
            required_scenarios=set(scenarios),
            required_integrators=set(integrators),
            required_thread_specs={spec.label for spec in thread_specs},
        )
        if failures:
            gate_failures.extend(failures)
            gate_exit_code = gate_exit_code or 5
    if args.require_cpu_gpu_consistency:
        if cpu_gpu_summary_for_report is None:
            cpu_gpu_summary_for_report = cpu_gpu_consistency_summary(
                results,
                case_manifests=cpu_gpu_manifests,
                require_gpu_strict_residency=args.require_gpu_strict_residency,
                energy_rtol=args.cpu_gpu_energy_rtol,
                energy_atol=args.cpu_gpu_energy_atol,
                torque_rtol=args.cpu_gpu_torque_rtol,
                torque_atol_apm=args.cpu_gpu_torque_atol_apm,
                torque_atol_t=args.cpu_gpu_torque_atol_t,
                max_step_delta=args.cpu_gpu_max_step_delta,
            )
        if not args.quiet_json_summary:
            print(
                "FEM_CPU_GPU_CONSISTENCY_SUMMARY="
                + json.dumps(cpu_gpu_summary_for_report, sort_keys=True)
            )
        failures = list(cpu_gpu_summary_for_report.get("failures", []))
        if failures:
            gate_failures.extend(failures)
            gate_exit_code = gate_exit_code or 8
    if args.emit_best_demag_policy:
        for summary in best_policy_rows:
            print(f"FEM_BEST_DEMAG_POLICY={json.dumps(summary, sort_keys=True)}")
    if args.require_best_demag_policy:
        failures = best_demag_policy_failures(
            results,
            max_residual=demag_residual_threshold,
            max_iterations=args.demag_convergence_max_iterations,
            selection_metric=args.best_demag_policy_metric,
        )
        if failures:
            gate_failures.extend(failures)
            gate_exit_code = gate_exit_code or 6
    if args.require_gpu_control_readback_budget:
        failures = gpu_control_readback_budget_failures(
            results,
            base=args.gpu_control_readback_base,
            per_step=args.gpu_control_readback_per_step,
            llg_per_step=args.gpu_llg_control_readback_per_step,
            pgbb_per_step=args.gpu_pgbb_control_readback_per_step,
            ncg_per_step=args.gpu_ncg_control_readback_per_step,
            per_rejected_attempt=args.gpu_control_readback_per_rejected_attempt,
        )
        if failures:
            gate_failures.extend(failures)
            gate_exit_code = gate_exit_code or 9
    if args.require_gpu_phase_timings and env_flag_enabled(
        os.environ.get("FULLMAG_FEM_STEP_PROFILE")
    ):
        failures = gpu_phase_timing_failures(results)
        if failures:
            gate_failures.extend(failures)
            gate_exit_code = gate_exit_code or 10
    if args.require_min_solver_nodes is not None:
        failures = min_solver_node_failures(
            results,
            min_nodes=args.require_min_solver_nodes,
        )
        if failures:
            gate_failures.extend(failures)
            gate_exit_code = gate_exit_code or 11
    if args.min_gpu_demag_total_speedup is not None:
        if cpu_gpu_summary_for_report is None:
            cpu_gpu_summary_for_report = cpu_gpu_consistency_summary(
                results,
                case_manifests=cpu_gpu_manifests,
                require_gpu_strict_residency=args.require_gpu_strict_residency,
                energy_rtol=args.cpu_gpu_energy_rtol,
                energy_atol=args.cpu_gpu_energy_atol,
                torque_rtol=args.cpu_gpu_torque_rtol,
                torque_atol_apm=args.cpu_gpu_torque_atol_apm,
                torque_atol_t=args.cpu_gpu_torque_atol_t,
                max_step_delta=args.cpu_gpu_max_step_delta,
            )
        failures = gpu_demag_total_speedup_failures(
            cpu_gpu_summary_for_report,
            min_speedup=args.min_gpu_demag_total_speedup,
        )
        if failures:
            gate_failures.extend(failures)
            gate_exit_code = gate_exit_code or 12
    if args.accepted_baseline:
        baseline_path = Path(args.accepted_baseline)
        if not baseline_path.is_file():
            gate_failures.append(f"accepted baseline CSV is missing: {baseline_path}")
            gate_exit_code = gate_exit_code or 7
        else:
            baseline_results = load_csv_results(baseline_path)
            comparable_cases = comparable_baseline_case_count(results, baseline_results)
            print(
                "FEM_ACCEPTED_BASELINE="
                + json.dumps(
                    {
                        "path": str(baseline_path),
                        "row_count": len(baseline_results),
                        "comparable_case_count": comparable_cases,
                        "max_performance_regression_percent": args.max_performance_regression_percent,
                    },
                    sort_keys=True,
                )
            )
            if args.require_accepted_baseline and comparable_cases == 0:
                gate_failures.append(
                    f"accepted baseline CSV has no comparable solver_mesh_signature cases: {baseline_path}"
                )
                gate_exit_code = gate_exit_code or 7
            failures = performance_regression_failures(
                results,
                baseline_results,
                max_regression_percent=args.max_performance_regression_percent,
                require_complete_objectives=args.require_accepted_baseline,
                required_sample_count=5,
            )
            if failures:
                gate_failures.extend(failures)
                gate_exit_code = gate_exit_code or 7
    elif args.require_accepted_baseline:
        gate_failures.append("--require-accepted-baseline needs --accepted-baseline")
        gate_exit_code = gate_exit_code or 7
    pass_fail_summary = benchmark_pass_fail_summary(
        results,
        gate_failures=gate_failures,
        max_residual=demag_residual_threshold,
        max_iterations=args.demag_convergence_max_iterations,
    )
    if not args.quiet_json_summary:
        print(f"FEM_PASS_FAIL_SUMMARY={json.dumps(pass_fail_summary, sort_keys=True)}")
    if (
        args.human_report_output
        or args.pdf_report_output
        or args.quiet_json_summary
    ):
        if cpu_gpu_summary_for_report is None:
            if benchmark_report_needs_cpu_gpu_summary(
                backends,
                require_cpu_gpu_consistency=args.require_cpu_gpu_consistency,
                cpu_gpu_summary_output=args.cpu_gpu_summary_output,
            ):
                cpu_gpu_summary_for_report = cpu_gpu_consistency_summary(
                    results,
                    case_manifests=cpu_gpu_manifests,
                    require_gpu_strict_residency=args.require_gpu_strict_residency,
                    energy_rtol=args.cpu_gpu_energy_rtol,
                    energy_atol=args.cpu_gpu_energy_atol,
                    torque_rtol=args.cpu_gpu_torque_rtol,
                    torque_atol_apm=args.cpu_gpu_torque_atol_apm,
                    torque_atol_t=args.cpu_gpu_torque_atol_t,
                    max_step_delta=args.cpu_gpu_max_step_delta,
                )
            else:
                cpu_gpu_summary_for_report = cpu_gpu_not_requested_summary(results)
        if best_policy_rows:
            cpu_gpu_summary_for_report["best_demag_policy"] = best_policy_rows
        report_text = render_cpu_gpu_benchmark_report(
            cpu_gpu_summary_for_report,
            pass_fail_summary,
            csv_path=args.output,
            summary_path=args.cpu_gpu_summary_output,
        )
        if args.human_report_output:
            human_report_path = Path(args.human_report_output)
            human_report_path.parent.mkdir(parents=True, exist_ok=True)
            human_report_path.write_text(report_text, encoding="utf-8")
            print(f"Human report written to {human_report_path}")
        if args.pdf_report_output:
            write_benchmark_pdf_report(args.pdf_report_output, report_text)
            print(f"PDF report written to {args.pdf_report_output}")
        if args.quiet_json_summary:
            rich_rendered = print_cpu_gpu_benchmark_rich_report(
                cpu_gpu_summary_for_report,
                pass_fail_summary,
                csv_path=args.output,
                summary_path=args.cpu_gpu_summary_output,
                human_report_path=args.human_report_output,
                pdf_report_path=args.pdf_report_output,
            )
            if not rich_rendered:
                print(report_text.rstrip())
    if gate_failures:
        for failure in gate_failures:
            print(f"FEM_BENCHMARK_ERROR={failure}", file=sys.stderr)
        raise SystemExit(gate_exit_code or 1)


if __name__ == "__main__":
    main()
