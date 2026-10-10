#!/usr/bin/env python3
"""Run bounded CPU MFEM source-contract profiles in GitHub Actions.

This is a bounded CI container route for explicitly selected CTest targets. It does not build or
publish a Fullmag runtime and is not production FEM qualification.
"""

from __future__ import annotations

import atexit
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
STORAGE_CLI = REPO_ROOT / "scripts" / "fullmag_storage.py"
DOCKERFILE = REPO_ROOT / "docker" / "fem-cpu" / "Dockerfile"
DOCKERIGNORE = REPO_ROOT / ".dockerignore"
STORAGE_PROFILE = "linux-host"
DOCKER_BUILD_JOBS = 2
NATIVE_BUILD_JOBS = 2
WORKFLOW_TIMEOUT_MINUTES = 180
ORCHESTRATION_TIMEOUT_MINUTES = 160
BUILD_EXECUTION_TIMEOUT_MINUTES = 150
METADATA_TIMEOUT_SECONDS = 120
DOCKER_PULL_TIMEOUT_SECONDS = 600
DEPENDENCY_BUILD_TIMEOUT_SECONDS = 5400
NATIVE_BUILD_TEST_TIMEOUT_SECONDS = 3600
IMAGE_BASE = "ubuntu:22.04"
INSTALL_PREFIX = "/opt/fullmag-deps"
IMAGE_BUILD_INPUTS = "/opt/fullmag-deps/share/fullmag/fem-cpu-build-inputs.json"
SLEPC_IMAGE_BUILD_INPUTS = "/opt/fullmag-deps/share/fullmag/fem-cpu-slepc-build-inputs.json"
COMMON_CACHE_OPTIONS = {
    "CMAKE_BUILD_TYPE": "Release",
    "CMAKE_GENERATOR": "Unix Makefiles",
    "CMAKE_EXPORT_COMPILE_COMMANDS": "ON",
    "FULLMAG_ENABLE_CUDA": "OFF",
    "FULLMAG_ENABLE_FEM_GPU": "OFF",
    "FULLMAG_USE_MFEM_STACK": "ON",
}
CONTRACT_PROFILES: dict[str, dict[str, Any]] = {
    "positive-mass": {
        "slug": "fem-positive-mass-contract",
        "schema": "fullmag.ci.fem.positive_tangent_mass_contract.v1",
        "preflight_schema": "fullmag.ci.fem.positive_tangent_mass_preflight.v1",
        "qualification_scope": "mfem_cpu_assembly_source_contract_only",
        "route_kind": "github_hosted_cpu_mfem_container_contract",
        "tests": [
            {
                "name": "fem_poisson_airbox_shared_domain_contract",
                "source_suffix": "backends/fem/tests/frequency_domain/poisson_airbox_shared_domain_test.cpp",
                "marker": "PASS: floquet_positive_tangent_mass_matches_independent_phase_reduction",
                "compile_definitions": ["-DFULLMAG_HAS_MFEM_STACK=1"],
            },
        ],
        "uses_slepc": False,
        "timeout": {
            "workflow_minutes": WORKFLOW_TIMEOUT_MINUTES,
            "orchestration_minutes": ORCHESTRATION_TIMEOUT_MINUTES,
            "execution_minutes": BUILD_EXECUTION_TIMEOUT_MINUTES,
            "dependency_build_seconds": DEPENDENCY_BUILD_TIMEOUT_SECONDS,
            "native_build_test_seconds": NATIVE_BUILD_TEST_TIMEOUT_SECONDS,
        },
    },
    "floquet-modal-slepc": {
        "slug": "fem-floquet-modal-slepc-contract",
        "schema": "fullmag.ci.fem.floquet_modal_slepc_contract.v1",
        "preflight_schema": "fullmag.ci.fem.floquet_modal_slepc_preflight.v1",
        "qualification_scope": "mfem_cpu_slepc_modal_solver_source_contract_only",
        "route_kind": "github_hosted_cpu_mfem_slepc_container_contract",
        "tests": [
            {
                "name": "fem_modal_eigen_contract",
                "source_suffix": "backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp",
                "marker": "PASS: native_floquet_production_window_positive_mass_merge",
                "compile_definitions": [
                    "-DFULLMAG_HAS_MFEM_STACK=1",
                    "-DFULLMAG_FEM_WITH_SLEPC=1",
                    "-DFULLMAG_HAS_CUDA_RUNTIME=0",
                ],
            },
            {
                "name": "fem_modal_eigen_gamma_admission_contract",
                "source_suffix": "backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp",
                "marker": "PASS: native_floquet_gamma_admission_cabi_contract",
                "compile_definitions": [
                    "-DFULLMAG_HAS_MFEM_STACK=1",
                    "-DFULLMAG_FEM_WITH_SLEPC=1",
                    "-DFULLMAG_HAS_CUDA_RUNTIME=0",
                ],
            },
            {
                "name": "fem_modal_eigen_mixed_dense_contract",
                "source_suffix": "backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp",
                "marker": "PASS: modal_shared_domain_floquet_mixed_dense_real_split_contract",
                "compile_definitions": [
                    "-DFULLMAG_HAS_MFEM_STACK=1",
                    "-DFULLMAG_FEM_WITH_SLEPC=1",
                    "-DFULLMAG_HAS_CUDA_RUNTIME=0",
                ],
            },
            {
                "name": "fem_floquet_modal_solver_contract",
                "source_suffix": "backends/fem/tests/frequency_domain/floquet_modal_solver_test.cpp",
                "marker": "PASS: fem_floquet_modal_solver_contract",
                "compile_definitions": [
                    "-DFULLMAG_HAS_MFEM_STACK=1",
                    "-DFULLMAG_FEM_WITH_SLEPC=1",
                    "-DFULLMAG_HAS_CUDA_RUNTIME=0",
                ],
            },
            {
                "name": "fem_shifted_ksp_true_convergence_contract",
                "source_suffix": "backends/fem/tests/frequency_domain/shifted_ksp_true_convergence_test.cpp",
                "marker": "PASS: shifted KSP true-convergence regression",
                "compile_definitions": [
                    "-DFULLMAG_HAS_MFEM_STACK=1",
                    "-DFULLMAG_FEM_WITH_SLEPC=1",
                    "-DFULLMAG_HAS_CUDA_RUNTIME=0",
                ],
            },
            {
                "name": "fem_petsc_process_runtime_concurrency_contract",
                "source_suffix": "backends/fem/tests/frequency_domain/petsc_process_runtime_concurrency_test.cpp",
                "marker": "PASS: PETSc process runtime Gamma/Floquet concurrency contract",
                "compile_definitions": [
                    "-DFULLMAG_HAS_MFEM_STACK=1",
                    "-DFULLMAG_FEM_WITH_SLEPC=1",
                    "-DFULLMAG_HAS_CUDA_RUNTIME=0",
                ],
            },
            {
                "name": "fem_petsc_process_runtime_quarantine_contract",
                "source_suffix": "backends/fem/tests/frequency_domain/petsc_process_runtime_concurrency_test.cpp",
                "marker": "PASS: PETSc process runtime quarantine admission contract",
                "compile_definitions": [
                    "-DFULLMAG_HAS_MFEM_STACK=1",
                    "-DFULLMAG_FEM_WITH_SLEPC=1",
                    "-DFULLMAG_HAS_CUDA_RUNTIME=0",
                ],
            },
            {
                "name": "modal_eigen_live_pc_apply_fault_quarantine",
                "source_suffix": "backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp",
                "marker": "PASS: Floquet live PC apply fault quarantine contract",
                "compile_definitions": [
                    "-DFULLMAG_HAS_MFEM_STACK=1",
                    "-DFULLMAG_FEM_WITH_SLEPC=1",
                    "-DFULLMAG_HAS_CUDA_RUNTIME=0",
                ],
            },
            {
                "name": "modal_eigen_borrowed_pmat_row_restore_fault_quarantine",
                "source_suffix": "backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp",
                "marker": "PASS: modal_eigen_borrowed_pmat_row_restore_fault_quarantine_probe",
                "compile_definitions": [
                    "-DFULLMAG_HAS_MFEM_STACK=1",
                    "-DFULLMAG_FEM_WITH_SLEPC=1",
                    "-DFULLMAG_HAS_CUDA_RUNTIME=0",
                ],
            },
            {
                "name": "modal_eigen_borrowed_pmat_row_primary_cleanup_fault_quarantine",
                "source_suffix": "backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp",
                "marker": "PASS: modal_eigen_borrowed_pmat_row_primary_cleanup_fault_quarantine_probe",
                "compile_definitions": [
                    "-DFULLMAG_HAS_MFEM_STACK=1",
                    "-DFULLMAG_FEM_WITH_SLEPC=1",
                    "-DFULLMAG_HAS_CUDA_RUNTIME=0",
                ],
            },
            {
                "name": "modal_eigen_borrowed_pmat_pattern_mismatch_fixture",
                "source_suffix": "backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp",
                "marker": "PASS: modal_eigen_borrowed_pmat_pattern_mismatch_fixture_probe",
                "compile_definitions": [
                    "-DFULLMAG_HAS_MFEM_STACK=1",
                    "-DFULLMAG_FEM_WITH_SLEPC=1",
                    "-DFULLMAG_HAS_CUDA_RUNTIME=0",
                ],
            },
            {
                "name": "fem_floquet_forced_inner_failure_contract",
                "source_suffix": "backends/fem/tests/frequency_domain/floquet_modal_solver_test.cpp",
                "marker": "PASS: fem_floquet_forced_inner_failure_contract",
                "compile_definitions": [
                    "-DFULLMAG_HAS_MFEM_STACK=1",
                    "-DFULLMAG_FEM_WITH_SLEPC=1",
                    "-DFULLMAG_HAS_CUDA_RUNTIME=0",
                ],
            },
        ],
        "uses_slepc": True,
        "timeout": {
            "workflow_minutes": 240,
            "orchestration_minutes": 220,
            "execution_minutes": 210,
            "dependency_build_seconds": 7200,
            "native_build_test_seconds": 3600,
        },
    },
}

CONTRACT_PROFILES["generic-modal-slepc"] = {
    "slug": "fem-generic-modal-slepc-contract",
    "schema": "fullmag.ci.fem.generic_modal_slepc_contract.v1",
    "preflight_schema": "fullmag.ci.fem.generic_modal_slepc_preflight.v1",
    "qualification_scope": "mfem_cpu_generic_mass_dedup_refill_source_contract_only",
    "route_kind": "github_hosted_cpu_mfem_slepc_container_contract",
    "tests": [
        {
            "name": "fem_mode_deduplication_contract",
            "source_suffix": "backends/fem/tests/frequency_domain/mode_deduplication_test.cpp",
            "marker": "PASS: generic_slepc_mass_action_finalizer_contract",
            "compile_definitions": ["-DFULLMAG_FEM_WITH_SLEPC=1"],
        },
        {
            "name": "fem_modal_eigen_generic_mass_refill_contract",
            "source_suffix": "backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp",
            "marker": "PASS: generic_modal_mass_refill_contract",
            "compile_definitions": ["-DFULLMAG_HAS_MFEM_STACK=1", "-DFULLMAG_FEM_WITH_SLEPC=1",
                                    "-DFULLMAG_HAS_CUDA_RUNTIME=0"],
        },
    ],
    "uses_slepc": True,
    "timeout": dict(CONTRACT_PROFILES["floquet-modal-slepc"]["timeout"]),
}

CONTRACT_PROFILES["modal-phase-slepc"] = {
    **CONTRACT_PROFILES["generic-modal-slepc"],
    "slug": "fem-modal-phase-slepc-contract",
    "schema": "fullmag.ci.fem.modal_phase_slepc_contract.v1",
    "preflight_schema": "fullmag.ci.fem.modal_phase_slepc_preflight.v1",
    "qualification_scope": "mfem_cpu_slepc_modal_phase_convention_source_contract_only",
    "tests": [{
        "name": "fem_modal_eigen_phase_convention_contract",
        "source_suffix": "backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp",
        "marker": "PASS: modal_slepc_phase_convention_contract",
        "compile_definitions": [
            "-DFULLMAG_HAS_MFEM_STACK=1",
            "-DFULLMAG_FEM_WITH_SLEPC=1",
            "-DFULLMAG_HAS_CUDA_RUNTIME=0",
        ],
    }],
}

CONTRACT_PROFILES["floquet-count-slepc"] = {
    **CONTRACT_PROFILES["generic-modal-slepc"],
    "slug": "fem-floquet-count-slepc-contract",
    "schema": "fullmag.ci.fem.floquet_count_slepc_contract.v1",
    "preflight_schema": "fullmag.ci.fem.floquet_count_slepc_preflight.v1",
    "qualification_scope": "mfem_cpu_floquet_count_certificate_admission_source_contract_only",
    "tests": [{
        "name": "fem_modal_eigen_floquet_count_contract",
        "source_suffix": "backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp",
        "marker": "PASS: public_native_floquet_certified_count_requires_count_certificate",
        "compile_definitions": ["-DFULLMAG_HAS_MFEM_STACK=1", "-DFULLMAG_FEM_WITH_SLEPC=1",
                                "-DFULLMAG_HAS_CUDA_RUNTIME=0"],
    }],
}

_ORCHESTRATION_DEADLINE: float | None = None


def _contract_profile(profile_id: str) -> dict[str, Any]:
    try:
        return CONTRACT_PROFILES[profile_id]
    except KeyError as error:
        raise ContractRunError(f"Unsupported CPU FEM source-contract profile: {profile_id}") from error


def _ctest_regex(profile: dict[str, Any]) -> str:
    names = [test["name"] for test in profile["tests"]]
    if len(names) == 1:
        return f"^{names[0]}$"
    return "^(" + "|".join(names) + ")$"


def _test_targets(profile: dict[str, Any]) -> list[str]:
    return [test["name"] for test in profile["tests"]]


def _timeout_receipt(profile: dict[str, Any]) -> dict[str, int]:
    timeout = profile["timeout"]
    orchestration = timeout["orchestration_minutes"]
    execution = timeout["execution_minutes"]
    workflow = timeout["workflow_minutes"]
    return {
        "dependency_build_seconds": timeout["dependency_build_seconds"],
        "native_build_test_seconds": timeout["native_build_test_seconds"],
        "build_execution_minutes": execution,
        "finalization_reserve_minutes": orchestration - execution,
        "orchestration_minutes": orchestration,
        "receipt_reserve_minutes": workflow - orchestration,
        "workflow_minutes": workflow,
    }


class ContractRunError(RuntimeError):
    pass


class CommandTimeout(ContractRunError):
    def __init__(self, command: str, timeout_seconds: float, log_path: Path | None = None):
        self.command = command
        self.timeout_seconds = timeout_seconds
        self.log_path = log_path
        suffix = f"; see {log_path}" if log_path is not None else ""
        super().__init__(f"Command timed out after {timeout_seconds:.1f}s: {command}{suffix}")


def _bounded_timeout(command: list[str], requested_seconds: float) -> float:
    if _ORCHESTRATION_DEADLINE is None:
        return requested_seconds
    remaining = _ORCHESTRATION_DEADLINE - time.monotonic()
    if remaining <= 0:
        raise CommandTimeout(command[0], 0.0)
    return min(requested_seconds, remaining)


def _capture(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    timeout_seconds: float = METADATA_TIMEOUT_SECONDS,
) -> str:
    effective_timeout = _bounded_timeout(command, timeout_seconds)
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            env=env,
            check=False,
            capture_output=True,
            text=True,
            timeout=effective_timeout,
        )
    except subprocess.TimeoutExpired as error:
        raise CommandTimeout(command[0], effective_timeout) from error
    if result.returncode != 0:
        detail = (result.stderr or result.stdout)[-3000:]
        raise ContractRunError(
            f"Command failed with exit code {result.returncode}: {command[0]}\n{detail}"
        )
    return result.stdout.strip()


def _run_logged(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    log_path: Path,
    timeout_seconds: float,
) -> None:
    effective_timeout = _bounded_timeout(command, timeout_seconds)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with log_path.open("xb") as log:
            result = subprocess.run(
                command,
                cwd=cwd,
                env=env,
                check=False,
                stdout=log,
                stderr=subprocess.STDOUT,
                timeout=effective_timeout,
            )
    except subprocess.TimeoutExpired as error:
        raise CommandTimeout(command[0], effective_timeout, log_path) from error
    if result.returncode != 0:
        raise ContractRunError(
            f"Command failed with exit code {result.returncode}; see {log_path}"
        )


def _storage_command(
    action: str,
    arguments: list[str],
    *,
    env: dict[str, str],
    capture: bool = True,
) -> str:
    command = [
        sys.executable,
        str(STORAGE_CLI),
        action,
        "--repo-root",
        str(REPO_ROOT),
        "--profile",
        STORAGE_PROFILE,
        *arguments,
    ]
    return _capture(command, cwd=REPO_ROOT, env=env) if capture else ""


def _resolve_layout(*, env: dict[str, str], create: bool = False) -> dict[str, Any]:
    arguments = ["--format", "json"]
    if create:
        arguments.append("--create")
    raw = _storage_command("resolve", arguments, env=env)
    try:
        layout = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ContractRunError("Storage resolver returned invalid JSON") from error
    if not isinstance(layout, dict):
        raise ContractRunError("Storage resolver returned a non-object layout")
    return layout


def _append_github_file(path_variable: str, line: str) -> None:
    path_text = os.environ.get(path_variable)
    if not path_text:
        raise ContractRunError(f"GitHub Actions did not provide {path_variable}")
    if "\n" in line or "\r" in line:
        raise ContractRunError("Refusing a multiline GitHub Actions environment value")
    with Path(path_text).open("a", encoding="utf-8", newline="\n") as stream:
        stream.write(line + "\n")


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(payload, stream, indent=2, sort_keys=True)
        stream.write("\n")
    os.replace(temporary, path)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _git(*arguments: str) -> str:
    return _capture(["git", *arguments], cwd=REPO_ROOT, env=os.environ.copy())


def _assert_source_identity(
    expected_head: str, github_sha: str, *, env: dict[str, str], stage: str
) -> None:
    observed_head = _capture(
        ["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"], cwd=REPO_ROOT, env=env
    )
    dirty = _capture(
        [
            "git",
            "-C",
            str(REPO_ROOT),
            "status",
            "--porcelain",
            "--untracked-files=all",
        ],
        cwd=REPO_ROOT,
        env=env,
    )
    if observed_head != expected_head or observed_head != github_sha or dirty:
        raise ContractRunError(
            f"Source identity changed {stage}: HEAD={observed_head}, clean={not bool(dirty)}"
        )


def _dockerfile_values() -> dict[str, str]:
    text = DOCKERFILE.read_text(encoding="utf-8")
    values: dict[str, str] = {}
    for name in (
        "MFEM_REF",
        "MFEM_SOURCE_COMMIT",
        "HYPRE_REF",
        "CMAKE_VERSION",
        "PETSC_REF",
        "PETSC_SOURCE_COMMIT",
        "SLEPC_REF",
        "SLEPC_SOURCE_COMMIT",
    ):
        match = re.search(rf"(?m)^ENV\s+{re.escape(name)}=([^\s]+)\s*$", text)
        if match is None:
            raise ContractRunError(f"CPU FEM Dockerfile no longer declares {name}")
        values[name] = match.group(1)
    if not re.fullmatch(r"[0-9a-f]{40}", values["MFEM_SOURCE_COMMIT"]):
        raise ContractRunError("MFEM_SOURCE_COMMIT is not a full lowercase Git SHA")
    if not values["MFEM_REF"].startswith("v"):
        raise ContractRunError("MFEM_REF must remain an explicit version tag")
    if not values["PETSC_REF"].startswith("v") or not values["SLEPC_REF"].startswith("v"):
        raise ContractRunError("PETSc and SLEPc refs must remain explicit version tags")
    for name in ("PETSC_SOURCE_COMMIT", "SLEPC_SOURCE_COMMIT"):
        if not re.fullmatch(r"[0-9a-f]{40}", values[name]):
            raise ContractRunError(f"{name} is not a full lowercase Git SHA")
    return values


def _require_github_host() -> dict[str, str]:
    env = os.environ.copy()
    if env.get("GITHUB_ACTIONS") != "true":
        raise ContractRunError("This route may run only inside GitHub Actions")
    if env.get("RUNNER_OS") != "Linux" or env.get("RUNNER_ARCH") != "X64":
        raise ContractRunError("The source contract requires the ubuntu-latest x64 worker")
    workspace = Path(env.get("GITHUB_WORKSPACE", "")).resolve()
    if workspace != REPO_ROOT.resolve():
        raise ContractRunError("GitHub checkout path differs from this script's repository root")
    run_id = env.get("GITHUB_RUN_ID", "")
    attempt = env.get("GITHUB_RUN_ATTEMPT", "")
    if not run_id.isdigit() or not attempt.isdigit():
        raise ContractRunError("GitHub run id and attempt must be positive decimal values")
    if "FULLMAG_PROJECT_STORAGE_ROOT" in env and env["FULLMAG_PROJECT_STORAGE_ROOT"]:
        # The current step has not resolved the root yet; a job-level override
        # would bypass the canonical project/storage location.
        raise ContractRunError(
            "FULLMAG_PROJECT_STORAGE_ROOT must be resolved by this workflow, not pre-set"
        )
    profile = env.get("FULLMAG_STORAGE_PROFILE")
    if profile and profile != STORAGE_PROFILE:
        raise ContractRunError("The CI route requires the existing linux-host storage profile")
    env["FULLMAG_STORAGE_PROFILE"] = STORAGE_PROFILE
    return env


def _prepare_storage(env: dict[str, str]) -> tuple[dict[str, Any], dict[str, str]]:
    initial = _resolve_layout(env=env)
    if Path(str(initial.get("repo_root", ""))).resolve() != REPO_ROOT.resolve():
        raise ContractRunError("Storage resolver selected a different source checkout")
    project_root = Path(str(initial.get("project_root", ""))).resolve()
    storage_root = Path(str(initial.get("storage_root", ""))).resolve()
    expected_default = project_root / "storage"
    if storage_root != expected_default:
        raise ContractRunError(
            "The CI route accepts only the resolver-derived default project/storage root"
        )
    if initial.get("profile") != STORAGE_PROFILE:
        raise ContractRunError("Storage resolver returned a non-canonical Linux profile")
    if initial.get("managed_ext4") is not False or Path(
        str(initial.get("build_storage_root", ""))
    ).resolve() != storage_root:
        raise ContractRunError(
            "GitHub-hosted CI did not resolve to the ordinary canonical storage view"
        )

    # The root is derived by Git and the resolver above, then explicitly
    # supplied for all subsequent preflight and execution calls.
    env["FULLMAG_PROJECT_STORAGE_ROOT"] = str(storage_root)
    env["FULLMAG_STORAGE_PROFILE"] = STORAGE_PROFILE
    _append_github_file(
        "GITHUB_ENV", f"FULLMAG_PROJECT_STORAGE_ROOT={storage_root}"
    )
    _append_github_file(
        "GITHUB_ENV", f"FULLMAG_STORAGE_PROFILE={STORAGE_PROFILE}"
    )
    layout = _resolve_layout(env=env, create=True)
    if (
        Path(str(layout.get("storage_root", ""))).resolve() != storage_root
        or Path(str(layout.get("project_root", ""))).resolve() != project_root
        or Path(str(layout.get("build_storage_root", ""))).resolve() != storage_root
        or layout.get("managed_ext4") is not False
        or layout.get("profile") != STORAGE_PROFILE
    ):
        raise ContractRunError("Storage changed between resolver preflight and initialization")
    return layout, env


def _validated_path(path: Path, *, env: dict[str, str]) -> None:
    _storage_command("validate", ["--path", str(path)], env=env)


def _owner_action(
    action: str,
    *,
    env: dict[str, str],
    task_id: str,
    owner: str,
    purpose: str,
    state: str | None = None,
) -> None:
    arguments = ["--task-id", task_id, "--owner", owner, "--purpose", purpose]
    if state is not None:
        arguments.extend(["--state", state])
    _storage_command(action, arguments, env=env)


def _parse_cache(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line or line.startswith(("//", "#")) or ":" not in line or "=" not in line:
            continue
        name, remainder = line.split(":", 1)
        value_type, value = remainder.split("=", 1)
        values[name] = value
    return values


def _parse_petscconf_macros(contents: str) -> dict[str, list[str]]:
    names = (
        "PETSC_USE_REAL_DOUBLE",
        "PETSC_USE_COMPLEX",
        "PETSC_HAVE_CUDA",
        "PETSC_HAVE_HIP",
        "PETSC_HAVE_SYCL",
        "PETSC_HAVE_OPENCL",
    )
    parsed: dict[str, list[str]] = {name: [] for name in names}
    for match in re.finditer(
        r"^[ \t]*#[ \t]*define[ \t]+([A-Za-z_][A-Za-z0-9_]*)\b([^\n]*)",
        contents,
        re.MULTILINE,
    ):
        name = match.group(1)
        if name not in parsed:
            continue
        value = re.sub(r"/\*.*?\*/", "", match.group(2).split("//", 1)[0]).strip()
        parsed[name].append(value)
    if parsed["PETSC_USE_REAL_DOUBLE"] != ["1"]:
        raise ContractRunError("PETSc config header does not declare real double precision")
    if parsed["PETSC_USE_COMPLEX"]:
        raise ContractRunError("PETSc config header declares complex scalar support")
    for name in ("PETSC_HAVE_CUDA", "PETSC_HAVE_HIP", "PETSC_HAVE_SYCL", "PETSC_HAVE_OPENCL"):
        if any(value != "0" for value in parsed[name]):
            raise ContractRunError(f"CPU PETSc config header advertises accelerator support: {name}")
    return parsed


def _verify_compile_gates(
    compile_commands: Path,
    *,
    tests: list[dict[str, Any]],
) -> dict[str, bool]:
    try:
        commands = json.loads(compile_commands.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ContractRunError("CMake compile_commands.json is unavailable or invalid") from error
    results: dict[str, bool] = {}
    for test in tests:
        source_suffix = test["source_suffix"]
        matches = []
        for entry in commands:
            file_name = str(entry.get("file", "")).replace("\\", "/")
            if file_name.endswith(source_suffix):
                command = entry.get("command", "")
                if not command and isinstance(entry.get("arguments"), list):
                    command = " ".join(str(part) for part in entry["arguments"])
                command_text = str(command)
                matches.append(
                    all(definition in command_text for definition in test["compile_definitions"])
                )
        if not matches:
            raise ContractRunError(f"Compile database has no command for {source_suffix}")
        results[test["name"]] = all(matches)
    return results


def _disk_observation(
    *,
    stage: str,
    storage_root: Path,
    env: dict[str, str],
) -> dict[str, str]:
    docker_root = _capture(
        ["docker", "info", "--format", "{{.DockerRootDir}}"],
        cwd=REPO_ROOT,
        env=env,
    )
    usage = _capture(
        ["df", "-P", "-B1", str(storage_root), docker_root],
        cwd=REPO_ROOT,
        env=env,
    )
    return {
        "stage": stage,
        "storage_root": str(storage_root),
        "docker_root": docker_root,
        "df_p_b1_output": usage,
    }


def _execute_contract(args: Any) -> int:
    profile = _contract_profile(args.contract_profile)
    timeouts = profile["timeout"]
    reserve = _timeout_receipt(profile)
    run_dir = Path(args.run_dir)
    build_dir = Path(args.build_dir)
    temp_dir = Path(args.temp_dir)
    storage_root = Path(args.storage_root)
    receipt_path = run_dir / "receipt.json"
    receipt: dict[str, Any] = {
        "schema": profile["schema"],
        "contract_profile": args.contract_profile,
        "status": "running",
        "qualification_scope": profile["qualification_scope"],
        "qualification_claimed": False,
        "source": {
            "git_head": args.git_head,
            "github_sha": args.github_sha,
            "github_ref": args.github_ref,
            "repository": args.repository,
            "clean_checkout": True,
        },
        "storage": {
            "profile": STORAGE_PROFILE,
            "project_root": args.project_root,
            "storage_root": str(storage_root),
            "worktree_id": args.worktree_id,
            "build_dir": str(build_dir),
            "run_dir": str(run_dir),
            "temp_dir": str(temp_dir),
        },
        "route": {
            "kind": profile["route_kind"],
            "managed_runtime": False,
            "cpu_only": True,
            "cuda": False,
            "slepc": profile["uses_slepc"],
            "docker_dependency_build_jobs": DOCKER_BUILD_JOBS,
            "native_build_jobs": NATIVE_BUILD_JOBS,
            "metadata_timeout_seconds": METADATA_TIMEOUT_SECONDS,
            "docker_pull_timeout_seconds": DOCKER_PULL_TIMEOUT_SECONDS,
            "dependency_build_timeout_seconds": timeouts["dependency_build_seconds"],
            "native_build_test_timeout_seconds": timeouts["native_build_test_seconds"],
            "build_execution_timeout_minutes": timeouts["execution_minutes"],
            "finalization_reserve_minutes": reserve["finalization_reserve_minutes"],
            "orchestration_timeout_minutes": timeouts["orchestration_minutes"],
            "receipt_reserve_minutes": reserve["receipt_reserve_minutes"],
            "workflow_timeout_minutes": timeouts["workflow_minutes"],
        },
        "test": {
            "target": _test_targets(profile)[0]
            if len(profile["tests"]) == 1
            else _test_targets(profile),
            "ctest_regex": _ctest_regex(profile),
            "assertion_marker": profile["tests"][0]["marker"]
            if len(profile["tests"]) == 1
            else None,
            "assertion_markers": [test["marker"] for test in profile["tests"]],
            "expected_test_count": len(profile["tests"]),
            "assertion_marker_observed": False,
            "mfem_compile_gate_observed": False,
            "slepc_compile_gate_observed": False,
            "compile_gates_observed": {},
        },
        "disk_observations": [],
    }
    _write_json(receipt_path, receipt)

    status = "failed"
    failure: str | None = None
    try:
        env = os.environ.copy()
        global _ORCHESTRATION_DEADLINE
        _ORCHESTRATION_DEADLINE = args.deadline_monotonic
        if env.get("GITHUB_ACTIONS") != "true":
            raise ContractRunError("Inner contract executor is not running in GitHub Actions")
        _storage_command("assert-lock", [], env=env)
        receipt["disk_observations"].append(
            _disk_observation(stage="before_image_build", storage_root=storage_root, env=env)
        )
        _write_json(receipt_path, receipt)
        for path in (build_dir, temp_dir):
            _validated_path(path, env=env)
        if build_dir.exists():
            raise ContractRunError(f"Refusing to reuse a CI build directory: {build_dir}")
        build_dir.mkdir(parents=True, exist_ok=False)
        temp_dir.mkdir(parents=True, exist_ok=False)
        _assert_source_identity(
            args.git_head, args.github_sha, env=env, stage="before Docker execution"
        )
        receipt["source"]["identity_verified_before_docker"] = True

        dockerfile_pins = _dockerfile_values()
        run_id = env["GITHUB_RUN_ID"]
        attempt = env["GITHUB_RUN_ATTEMPT"]
        image_tag = f"fullmag/fem-cpu-ci:{run_id}-{attempt}"
        slepc_build_arg = "ON" if profile["uses_slepc"] else "OFF"
        image_iid_path = build_dir / "image.iid"
        image_input_path = run_dir / "fem-cpu-image-build-inputs.json"
        slepc_image_input_path = run_dir / "fem-cpu-slepc-build-inputs.json"
        base_image_path = run_dir / "base-image.json"
        library_hash_path = run_dir / "dependency-library-hashes.txt"
        dockerfile_hash = _sha256_file(DOCKERFILE)
        dockerignore_hash = _sha256_file(DOCKERIGNORE)

        _run_logged(
            ["docker", "pull", "--platform", "linux/amd64", IMAGE_BASE],
            cwd=REPO_ROOT,
            env=env,
            log_path=run_dir / "base-image-pull.log",
            timeout_seconds=DOCKER_PULL_TIMEOUT_SECONDS,
        )
        base_image_text = _capture(
            ["docker", "image", "inspect", "--format", "{{json .RepoDigests}}", IMAGE_BASE],
            cwd=REPO_ROOT,
            env=env,
        )
        base_digests = json.loads(base_image_text)
        base_digest = next(
            (
                value
                for value in base_digests
                if isinstance(value, str)
                and re.search(r"(?:^|/)ubuntu@sha256:[0-9a-f]{64}$", value)
            ),
            None,
        )
        if base_digest is None:
            raise ContractRunError("Could not record the pulled Ubuntu base-image digest")
        _write_json(
            base_image_path,
            {"requested_tag": IMAGE_BASE, "observed_repo_digests": base_digests, "selected_digest": base_digest},
        )

        _run_logged(
            [
                "docker",
                "build",
                "--platform=linux/amd64",
                "--build-arg",
                f"FULLMAG_FEM_CPU_BUILD_JOBS={DOCKER_BUILD_JOBS}",
                "--build-arg",
                f"FULLMAG_FEM_CPU_WITH_SLEPC={slepc_build_arg}",
                "--iidfile",
                str(image_iid_path),
                "--file",
                str(DOCKERFILE),
                "--tag",
                image_tag,
                str(REPO_ROOT),
            ],
            cwd=REPO_ROOT,
            env=env,
            log_path=run_dir / "docker-image-build.log",
            timeout_seconds=timeouts["dependency_build_seconds"],
        )
        receipt["disk_observations"].append(
            _disk_observation(stage="after_image_build", storage_root=storage_root, env=env)
        )
        _write_json(receipt_path, receipt)
        image_id = image_iid_path.read_text(encoding="utf-8").strip()
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
            raise ContractRunError("Docker did not produce a canonical image ID")

        image_inputs_raw = _capture(
            [
                "docker",
                "run",
                "--rm",
                "--platform",
                "linux/amd64",
                "--entrypoint",
                "cat",
                image_tag,
                IMAGE_BUILD_INPUTS,
            ],
            cwd=REPO_ROOT,
            env=env,
        )
        image_inputs = json.loads(image_inputs_raw)
        _write_json(image_input_path, image_inputs)
        if (
            image_inputs.get("schema") != "fullmag.fem.cpu_image_build_inputs.v1"
            or image_inputs.get("mfem_ref") != dockerfile_pins["MFEM_REF"]
            or image_inputs.get("mfem_source_commit_expected")
            != dockerfile_pins["MFEM_SOURCE_COMMIT"]
            or image_inputs.get("mfem_source_commit_observed")
            != dockerfile_pins["MFEM_SOURCE_COMMIT"]
            or image_inputs.get("hypre_ref") != dockerfile_pins["HYPRE_REF"]
            or image_inputs.get("cmake_version") != dockerfile_pins["CMAKE_VERSION"]
            or image_inputs.get("dependency_build_jobs") != DOCKER_BUILD_JOBS
        ):
            raise ContractRunError("Built CPU image dependency receipt does not match its declared pins")

        slepc_inputs: dict[str, Any] | None = None
        if profile["uses_slepc"]:
            slepc_inputs_raw = _capture(
                [
                    "docker",
                    "run",
                    "--rm",
                    "--platform",
                    "linux/amd64",
                    "--entrypoint",
                    "cat",
                    image_tag,
                    SLEPC_IMAGE_BUILD_INPUTS,
                ],
                cwd=REPO_ROOT,
                env=env,
            )
            try:
                slepc_inputs = json.loads(slepc_inputs_raw)
            except json.JSONDecodeError as error:
                raise ContractRunError("CPU PETSc/SLEPc image receipt is invalid JSON") from error
            _write_json(slepc_image_input_path, slepc_inputs)
            expected_petsc_flags = [
                "--with-cc=mpicc",
                "--with-cxx=mpicxx",
                "--with-fc=mpifort",
                "COPTFLAGS=-O3",
                "CXXOPTFLAGS=-O3",
                "FOPTFLAGS=-O3",
                "--with-debugging=0",
                "--with-shared-libraries=1",
                "--with-scalar-type=real",
                "--with-precision=double",
                "--with-cuda=0",
                "--with-hip=0",
                "--with-sycl=0",
                "--with-opencl=0",
                "--with-blaslapack-lib=-llapack -lblas",
                "--with-hypre=1",
                f"--with-hypre-dir={INSTALL_PREFIX}",
            ]
            expected_accelerators = {"cuda": False, "hip": False, "sycl": False, "opencl": False}
            if (
                slepc_inputs.get("schema") != "fullmag.fem.cpu_slepc_build_inputs.v1"
                or slepc_inputs.get("petsc_ref") != dockerfile_pins["PETSC_REF"]
                or slepc_inputs.get("petsc_source_commit_expected")
                != dockerfile_pins["PETSC_SOURCE_COMMIT"]
                or slepc_inputs.get("petsc_source_commit_observed")
                != dockerfile_pins["PETSC_SOURCE_COMMIT"]
                or slepc_inputs.get("petsc_version") != dockerfile_pins["PETSC_REF"][1:]
                or slepc_inputs.get("petsc_arch") != "arch-linux-cpu"
                or slepc_inputs.get("petsc_prefix") != INSTALL_PREFIX
                or slepc_inputs.get("petsc_configure_flags") != expected_petsc_flags
                or slepc_inputs.get("petsc_scalar_type") != "real"
                or slepc_inputs.get("petsc_precision") != "double"
                or slepc_inputs.get("petsc_accelerators") != expected_accelerators
                or slepc_inputs.get("petsc_use_real_double_macro") is not True
                or slepc_inputs.get("petsc_use_complex_macro") is not False
                or not re.fullmatch(r"[0-9a-f]{64}", str(slepc_inputs.get("petscconf_sha256", "")))
                or not str(slepc_inputs.get("petsc_pkgconfig_dir", "")).startswith(INSTALL_PREFIX + "/")
                or slepc_inputs.get("slepc_ref") != dockerfile_pins["SLEPC_REF"]
                or slepc_inputs.get("slepc_source_commit_expected")
                != dockerfile_pins["SLEPC_SOURCE_COMMIT"]
                or slepc_inputs.get("slepc_source_commit_observed")
                != dockerfile_pins["SLEPC_SOURCE_COMMIT"]
                or slepc_inputs.get("slepc_version") != dockerfile_pins["SLEPC_REF"][1:]
                or slepc_inputs.get("slepc_prefix") != INSTALL_PREFIX
                or slepc_inputs.get("slepc_petsc_dir") != INSTALL_PREFIX
                or slepc_inputs.get("slepc_petsc_arch_environment_set") is not False
                or slepc_inputs.get("slepc_petsc_arch_environment_value") is not None
                or not re.fullmatch(
                    r"installed-arch-[a-zA-Z0-9_-]+",
                    str(slepc_inputs.get("slepc_resolved_build_arch", "")),
                )
                or slepc_inputs.get("slepc_resolved_build_arch_directory_verified") is not True
                or slepc_inputs.get("slepc_configure_flags") != [f"--prefix={INSTALL_PREFIX}"]
                or not str(slepc_inputs.get("slepc_pkgconfig_dir", "")).startswith(INSTALL_PREFIX + "/")
                or slepc_inputs.get("hypre_ref") != dockerfile_pins["HYPRE_REF"]
                or slepc_inputs.get("hypre_source_commit_observed")
                != image_inputs.get("hypre_source_commit_observed")
                or slepc_inputs.get("dependency_build_jobs") != DOCKER_BUILD_JOBS
            ):
                raise ContractRunError("CPU PETSc/SLEPc receipt differs from the pinned real-scalar profile")
            petscconf_text = _capture(
                [
                    "docker",
                    "run",
                    "--rm",
                    "--platform",
                    "linux/amd64",
                    "--entrypoint",
                    "cat",
                    image_tag,
                    f"{INSTALL_PREFIX}/include/petscconf.h",
                ],
                cwd=REPO_ROOT,
                env=env,
            )
            petscconf_macros = _parse_petscconf_macros(petscconf_text)

        library_paths = [
            "/opt/fullmag-deps/lib/libmfem.so",
            "/opt/fullmag-deps/lib/libHYPRE.so",
        ]
        if profile["uses_slepc"]:
            library_paths.extend(
                [
                    "/opt/fullmag-deps/lib/libpetsc.so",
                    "/opt/fullmag-deps/lib/libslepc.so",
                    "/opt/fullmag-deps/include/petscconf.h",
                ]
            )
        library_hashes = _capture(
            [
                "docker",
                "run",
                "--rm",
                "--platform",
                "linux/amd64",
                "--entrypoint",
                "sha256sum",
                image_tag,
                *library_paths,
            ],
            cwd=REPO_ROOT,
            env=env,
        )
        library_hash_path.write_text(library_hashes + "\n", encoding="utf-8")
        if not re.search(r"(?m)^[0-9a-f]{64}\s+.+libmfem\.so$", library_hashes):
            raise ContractRunError("MFEM library SHA-256 was not observed")
        if not re.search(r"(?m)^[0-9a-f]{64}\s+.+libHYPRE\.so$", library_hashes):
            raise ContractRunError("HYPRE library SHA-256 was not observed")
        if profile["uses_slepc"]:
            for library_name in ("libpetsc.so", "libslepc.so"):
                if not re.search(rf"(?m)^[0-9a-f]{{64}}\s+.+{re.escape(library_name)}$", library_hashes):
                    raise ContractRunError(f"{library_name} SHA-256 was not observed")
            petscconf_sha = next(
                line.split()[0]
                for line in library_hashes.splitlines()
                if line.rstrip().endswith("petscconf.h")
            )
            if petscconf_sha != slepc_inputs["petscconf_sha256"]:
                raise ContractRunError("PETSc config-header hash differs from the image build receipt")

        receipt["container"] = {
            "image_tag": image_tag,
            "image_id": image_id,
            "base_image_tag": IMAGE_BASE,
            "base_image_digest_observed": base_digest,
            "base_image_digest_mode": "observed_tag_resolution; Dockerfile base remains ubuntu:22.04",
            "dockerfile_sha256": dockerfile_hash,
            "dockerignore_sha256": dockerignore_hash,
            "mfem_ref": dockerfile_pins["MFEM_REF"],
            "mfem_source_commit_expected": dockerfile_pins["MFEM_SOURCE_COMMIT"],
            "mfem_source_commit_observed": image_inputs["mfem_source_commit_observed"],
            "mfem_library_sha256": next(
                line.split()[0]
                for line in library_hashes.splitlines()
                if line.rstrip().endswith("libmfem.so")
            ),
            "hypre_ref": dockerfile_pins["HYPRE_REF"],
            "hypre_source_commit_observed": image_inputs["hypre_source_commit_observed"],
            "hypre_library_sha256": next(
                line.split()[0]
                for line in library_hashes.splitlines()
                if line.rstrip().endswith("libHYPRE.so")
            ),
            "cmake_version": dockerfile_pins["CMAKE_VERSION"],
            "dependency_build_jobs": DOCKER_BUILD_JOBS,
            "image_build_output": "Image ID and dependency hashes are recorded in canonical Fullmag storage",
        }
        if profile["uses_slepc"]:
            if slepc_inputs is None:
                raise ContractRunError("CPU PETSc/SLEPc provider receipt was not captured")
            receipt["container"]["cpu_modal_provider"] = {
                **slepc_inputs,
                "petsc_config_macros": petscconf_macros,
                "library_sha256": {
                    library_name: next(
                        line.split()[0]
                        for line in library_hashes.splitlines()
                        if line.rstrip().endswith(library_name)
                    )
                    for library_name in ("libpetsc.so", "libslepc.so")
                },
            }
        _write_json(receipt_path, receipt)

        storage_relative_build = build_dir.relative_to(storage_root).as_posix()
        storage_relative_temp = temp_dir.relative_to(storage_root).as_posix()
        container_build_dir = f"/fullmag-storage/{storage_relative_build}/native"
        container_temp_dir = f"/fullmag-storage/{storage_relative_temp}"
        native_build_dir = build_dir / "native"
        slepc_enabled = "ON" if profile["uses_slepc"] else "OFF"
        cmake_flags = [
            "-DCMAKE_BUILD_TYPE=Release",
            "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
            "-DFULLMAG_ENABLE_CUDA=OFF",
            "-DFULLMAG_ENABLE_FEM_GPU=OFF",
            "-DFULLMAG_USE_MFEM_STACK=ON",
            f"-DFULLMAG_FEM_WITH_SLEPC={slepc_enabled}",
        ]
        if profile["uses_slepc"]:
            cmake_flags.append(f"-DCMAKE_PREFIX_PATH={INSTALL_PREFIX}")
        test_targets = _test_targets(profile)
        test_regex = _ctest_regex(profile)
        target_arguments = " ".join(shlex.quote(target) for target in test_targets)
        cmake_command = "cmake -S /workspace/native -B \"$FM_BUILD_DIR\" -G \"Unix Makefiles\" \\\n" + " \\\n".join(
            f"  {shlex.quote(flag)}" for flag in cmake_flags
        )
        provider_environment: list[str] = []
        container_environment = [
            ("FM_BUILD_DIR", container_build_dir),
            ("FM_TEMP_DIR", container_temp_dir),
            ("CMAKE_BUILD_PARALLEL_LEVEL", str(NATIVE_BUILD_JOBS)),
            ("FULLMAG_USE_MFEM_STACK", "ON"),
            ("FULLMAG_MANAGED_FEM_DEVICE", "cpu"),
            ("FULLMAG_FEM_REQUIRE_GPU", "0"),
            ("FULLMAG_FEM_REQUIRE_CEED", "0"),
            ("FULLMAG_FEM_WITH_SLEPC", slepc_enabled),
        ]
        dense_oracle_enabled = args.contract_profile == "floquet-modal-slepc"
        receipt["diagnostic_configuration"] = {
            "floquet_dense_oracle_enabled": dense_oracle_enabled,
            "scope": "bounded native fixture diagnosis; not production qualification",
        }
        if dense_oracle_enabled:
            container_environment.append(("FULLMAG_FLOQUET_DENSE_ORACLE", "1"))
        _write_json(receipt_path, receipt)
        library_dir = f"{INSTALL_PREFIX}/lib"
        if profile["uses_slepc"]:
            provider_environment = [
                f"export PETSC_DIR={INSTALL_PREFIX} SLEPC_DIR={INSTALL_PREFIX}",
                f"export PKG_CONFIG_PATH={INSTALL_PREFIX}/lib/pkgconfig:{INSTALL_PREFIX}/lib64/pkgconfig",
            ]
            container_environment.extend(
                [
                    ("PETSC_DIR", INSTALL_PREFIX),
                    ("SLEPC_DIR", INSTALL_PREFIX),
                    ("PKG_CONFIG_PATH", f"{INSTALL_PREFIX}/lib/pkgconfig:{INSTALL_PREFIX}/lib64/pkgconfig"),
                ]
            )
            library_dir += f":{INSTALL_PREFIX}/lib64"
        inner_script = "\n".join(
            [
                "set -euo pipefail",
                'mkdir -p "$FM_BUILD_DIR" "$FM_TEMP_DIR"',
                'export TMPDIR="$FM_TEMP_DIR" TEMP="$FM_TEMP_DIR" TMP="$FM_TEMP_DIR"',
                *provider_environment,
                cmake_command,
                f'cmake --build "$FM_BUILD_DIR" --target {target_arguments} --parallel {NATIVE_BUILD_JOBS}',
                f'export LD_LIBRARY_PATH="$FM_BUILD_DIR/backends/fem:{library_dir}${{LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}}"',
                f'ctest --test-dir "$FM_BUILD_DIR/backends/fem" --output-on-failure --verbose --no-tests=error -R {shlex.quote(test_regex)}',
                "",
            ]
        )
        docker_run_command = [
            "docker",
            "run",
            "--rm",
            "--platform",
            "linux/amd64",
            "--cpus=2",
            "--mount",
            f"type=bind,source={REPO_ROOT},target=/workspace,readonly",
            "--mount",
            f"type=bind,source={storage_root},target=/fullmag-storage",
            "--workdir",
            "/workspace",
        ]
        for name, value in container_environment:
            docker_run_command.extend(["--env", f"{name}={value}"])
        docker_run_command.extend([image_tag, "bash", "-lc", inner_script])
        _run_logged(
            docker_run_command,
            cwd=REPO_ROOT,
            env=env,
            log_path=run_dir / "native-build-and-ctest.log",
            timeout_seconds=timeouts["native_build_test_seconds"],
        )
        receipt["disk_observations"].append(
            _disk_observation(stage="after_native_build_and_ctest", storage_root=storage_root, env=env)
        )
        _write_json(receipt_path, receipt)

        cache = _parse_cache(native_build_dir / "CMakeCache.txt")
        expected_cache = dict(COMMON_CACHE_OPTIONS)
        expected_cache["FULLMAG_FEM_WITH_SLEPC"] = slepc_enabled
        if profile["uses_slepc"]:
            expected_cache["CMAKE_PREFIX_PATH"] = INSTALL_PREFIX
        observed_cache = {name: cache.get(name) for name in expected_cache}
        if observed_cache != expected_cache:
            raise ContractRunError(f"CMake cache differs from {args.contract_profile}: {observed_cache}")
        compile_gates = _verify_compile_gates(
            native_build_dir / "compile_commands.json",
            tests=profile["tests"],
        )
        if not all(compile_gates.values()):
            raise ContractRunError("Contract test source lacks required CPU MFEM/SLEPc compile definitions")
        test_log = (run_dir / "native-build-and-ctest.log").read_text(
            encoding="utf-8", errors="replace"
        )
        missing_markers = [
            test["marker"]
            for test in profile["tests"]
            if test["marker"] not in test_log
        ]
        if missing_markers:
            raise ContractRunError(
                "CTest passed without all post-assertion markers: " + ", ".join(missing_markers)
            )
        expected_test_count = len(profile["tests"])
        if not re.search(
            rf"(?m)100% tests passed, 0 tests failed out of {expected_test_count}",
            test_log,
        ):
            raise ContractRunError(
                f"CTest output does not report exactly {expected_test_count} passing contracts"
            )
        _assert_source_identity(
            args.git_head, args.github_sha, env=env, stage="after native build and CTest"
        )
        receipt["source"]["identity_verified_after_test"] = True

        _write_json(
            run_dir / "cmake-configuration.json",
            {
                "cache_options": observed_cache,
                "compile_definitions_observed": compile_gates,
                "targets": test_targets,
                "native_build_jobs": NATIVE_BUILD_JOBS,
                "ctest_regex": test_regex,
                "assertion_markers_observed": [test["marker"] for test in profile["tests"]],
                "slepc_provider_profile": profile["uses_slepc"],
            },
        )
        receipt["test"].update(
            status="passed",
            assertion_marker_observed=True,
            mfem_compile_gate_observed=True,
            slepc_compile_gate_observed=profile["uses_slepc"],
            compile_gates_observed=compile_gates,
            assertion_markers_observed=[test["marker"] for test in profile["tests"]],
            ctest_exit_code=0,
            ctest_passed_count=expected_test_count,
            cmake_options=observed_cache,
        )
        status = "passed"
    except Exception as error:  # Preserve failure receipt and original logs.
        failure = f"{type(error).__name__}: {error}"
        receipt["error"] = failure
        receipt["test"].setdefault("status", "failed")
        if isinstance(error, CommandTimeout):
            receipt["timeout"] = {
                "command": error.command,
                "timeout_seconds": error.timeout_seconds,
                "log_path": str(error.log_path) if error.log_path else None,
            }
        print(f"[{profile['slug']}] {failure}", file=sys.stderr, flush=True)
    finally:
        receipt["status"] = status
        if failure:
            receipt["error"] = failure
        _write_json(receipt_path, receipt)
    return 0 if status == "passed" else 1


def _orchestrate(contract_profile: str) -> int:
    global _ORCHESTRATION_DEADLINE
    profile = _contract_profile(contract_profile)
    timeouts = profile["timeout"]
    reserve = _timeout_receipt(profile)
    slug = profile["slug"]
    started_at = time.monotonic()
    _ORCHESTRATION_DEADLINE = started_at + timeouts["orchestration_minutes"] * 60
    execution_deadline = started_at + timeouts["execution_minutes"] * 60
    env = _require_github_host()
    head = _git("-C", str(REPO_ROOT), "rev-parse", "HEAD")
    github_sha = env.get("GITHUB_SHA", "")
    _assert_source_identity(head, github_sha, env=env, stage="before storage preflight")
    repository = env.get("GITHUB_REPOSITORY", "")
    run_id = env["GITHUB_RUN_ID"]
    attempt = env["GITHUB_RUN_ATTEMPT"]
    task_id = f"{slug}-{run_id}-{attempt}"
    owner = f"github-actions:{repository}:{run_id}.{attempt}"
    layout, env = _prepare_storage(env)
    storage_root = Path(layout["storage_root"])
    build_dir = Path(layout["build_root"]) / f"{slug}-{run_id}-{attempt}"
    run_dir = Path(layout["runs_root"]) / slug / f"{run_id}-{attempt}"
    temp_dir = Path(layout["temp_root"]) / f"{slug}-{run_id}-{attempt}"
    for path in (build_dir, run_dir, temp_dir):
        _validated_path(path, env=env)

    _owner_action(
        "register",
        env=env,
        task_id=task_id,
        owner=owner,
        purpose=(
            f"Run the GitHub-hosted {contract_profile} source contract; "
            "next step: upload the receipt and review the single-target result."
        ),
    )
    owner_finished = [False]

    def finish_interrupted_owner() -> None:
        if not owner_finished[0]:
            try:
                _owner_action(
                    "finish",
                    env=env,
                    task_id=task_id,
                    owner=owner,
                    purpose=(
                        "GitHub Actions contract orchestration exited before its terminal receipt; "
                        "next step: inspect the workflow logs and reconcile the receipt."
                    ),
                    state="review",
                )
                owner_finished[0] = True
            except Exception as error:
                print(
                    f"[{slug}] could not finish storage owner: {error}",
                    file=sys.stderr,
                    flush=True,
                )
                if isinstance(error, CommandTimeout) and run_dir is not None:
                    receipt_path = run_dir / "receipt.json"
                    if receipt_path.is_file():
                        try:
                            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
                            receipt["timeout"] = {
                                "command": error.command,
                                "timeout_seconds": error.timeout_seconds,
                                "log_path": str(error.log_path) if error.log_path else None,
                            }
                            receipt.setdefault("storage", {})["owner_finish_recorded"] = False
                            _write_json(receipt_path, receipt)
                        except Exception:
                            pass
        if run_dir is not None and run_dir.is_dir():
            receipt_path = run_dir / "receipt.json"
            if receipt_path.is_file():
                try:
                    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
                    receipt.setdefault("storage", {}).update(
                        owner_state="completed" if owner_finished[0] and receipt.get("status") == "passed" else "review",
                        owner_finish_recorded=owner_finished[0],
                    )
                    if receipt.get("status") == "queued":
                        receipt["status"] = "failed"
                        receipt["error"] = "Orchestration exited before the managed test command completed"
                    _write_json(receipt_path, receipt)
                except Exception as error:
                    print(
                        f"[{slug}] could not finalize receipt: {error}",
                        file=sys.stderr,
                        flush=True,
                    )

    atexit.register(finish_interrupted_owner)
    run_dir.mkdir(parents=True, exist_ok=False)
    _append_github_file("GITHUB_OUTPUT", f"evidence_dir={run_dir}")
    output = {
        "schema": profile["schema"],
        "contract_profile": contract_profile,
        "status": "queued",
        "qualification_scope": profile["qualification_scope"],
        "qualification_claimed": False,
        "source": {
            "git_head": head,
            "github_sha": github_sha,
            "github_ref": env.get("GITHUB_REF"),
            "repository": repository,
            "clean_checkout": True,
            "identity_verified_before_storage": True,
        },
        "timeouts": {
            "orchestration_started_monotonic": started_at,
            "orchestration_deadline_monotonic": _ORCHESTRATION_DEADLINE,
            "orchestration_timeout_minutes": timeouts["orchestration_minutes"],
            "execution_timeout_minutes": timeouts["execution_minutes"],
            "finalization_reserve_minutes": reserve["finalization_reserve_minutes"],
            "receipt_reserve_minutes": reserve["receipt_reserve_minutes"],
            "workflow_timeout_minutes": timeouts["workflow_minutes"],
        },
        "storage": {
            "profile": STORAGE_PROFILE,
            "project_root": layout["project_root"],
            "storage_root": str(storage_root),
            "worktree_id": layout["worktree_id"],
            "build_dir": str(build_dir),
            "run_dir": str(run_dir),
            "temp_dir": str(temp_dir),
            "task_id": task_id,
            "owner": owner,
        },
    }
    _write_json(run_dir / "receipt.json", output)
    _write_json(
        run_dir / "preflight.json",
        {
            "schema": profile["preflight_schema"],
            "contract_profile": contract_profile,
            "resolver_profile": layout["profile"],
            "project_root": layout["project_root"],
            "storage_root": layout["storage_root"],
            "build_storage_root": layout["build_storage_root"],
            "managed_ext4": layout["managed_ext4"],
            "worktree_id": layout["worktree_id"],
        },
    )
    command = [
        sys.executable,
        str(STORAGE_CLI),
        "run",
        "--repo-root",
        str(REPO_ROOT),
        "--profile",
        STORAGE_PROFILE,
        "--",
        sys.executable,
        str(Path(__file__).resolve()),
        "--execute",
        "--contract-profile",
        contract_profile,
        "--run-dir",
        str(run_dir),
        "--build-dir",
        str(build_dir),
        "--temp-dir",
        str(temp_dir),
        "--storage-root",
        str(storage_root),
        "--worktree-id",
        str(layout["worktree_id"]),
        "--project-root",
        str(layout["project_root"]),
        "--git-head",
        head,
        "--github-sha",
        github_sha,
        "--github-ref",
        env.get("GITHUB_REF", ""),
        "--repository",
        repository,
        "--deadline-monotonic",
        f"{execution_deadline:.9f}",
    ]
    run_log = run_dir / "managed-storage-run.log"
    run_status = 1
    orchestration_timeout: CommandTimeout | None = None
    try:
        outer_timeout = execution_deadline - time.monotonic()
        if outer_timeout <= 0:
            raise CommandTimeout("managed-storage-run", 0.0, run_log)
        with run_log.open("xb") as log:
            result = subprocess.run(
                command,
                cwd=REPO_ROOT,
                env=env,
                check=False,
                stdout=log,
                stderr=subprocess.STDOUT,
                timeout=outer_timeout,
            )
        run_status = result.returncode
    except CommandTimeout as error:
        orchestration_timeout = error
        output["error"] = str(error)
        output["timeout"] = {
            "command": error.command,
            "timeout_seconds": error.timeout_seconds,
            "log_path": str(error.log_path) if error.log_path else None,
        }
        run_status = 124
    except subprocess.TimeoutExpired as error:
        orchestration_timeout = CommandTimeout(
            "managed-storage-run", float(error.timeout or 0.0), run_log
        )
        output["error"] = str(orchestration_timeout)
        output["timeout"] = {
            "command": orchestration_timeout.command,
            "timeout_seconds": orchestration_timeout.timeout_seconds,
            "log_path": str(run_log),
        }
        run_status = 124
    except Exception as error:
        output["error"] = f"{type(error).__name__}: {error}"
        run_status = 1

    receipt_path = run_dir / "receipt.json"
    if receipt_path.is_file():
        try:
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            receipt = output
            receipt["error"] = "Inner executor left an unreadable receipt"
    else:
        receipt = output
        receipt["error"] = "Managed storage runner did not produce an execution receipt"
    if orchestration_timeout is not None:
        receipt["status"] = "failed"
        receipt["timeout"] = {
            "command": orchestration_timeout.command,
            "timeout_seconds": orchestration_timeout.timeout_seconds,
            "log_path": str(orchestration_timeout.log_path) if orchestration_timeout.log_path else None,
        }
    post_run_identity_error = None
    try:
        _assert_source_identity(head, github_sha, env=env, stage="after managed test execution")
        receipt.setdefault("source", {})["identity_verified_after_managed_run"] = True
    except Exception as error:
        post_run_identity_error = f"{type(error).__name__}: {error}"
        receipt.setdefault("source", {})["identity_verified_after_managed_run"] = False
        receipt["source"]["identity_error"] = post_run_identity_error
        if isinstance(error, CommandTimeout):
            receipt["timeout"] = {
                "command": error.command,
                "timeout_seconds": error.timeout_seconds,
                "log_path": str(error.log_path) if error.log_path else None,
            }
    passed = (
        run_status == 0
        and receipt.get("status") == "passed"
        and post_run_identity_error is None
    )
    owner_state = "completed" if passed else "review"
    owner_finish_recorded = False
    finish_error = None
    finish_exception: Exception | None = None
    try:
        _owner_action(
            "finish",
            env=env,
            task_id=task_id,
            owner=owner,
            purpose=(
                f"GitHub Actions source-contract status={receipt.get('status', 'failed')}; "
                "next step: retain the uploaded receipt and act on its test result."
            ),
            state=owner_state,
        )
        owner_finish_recorded = True
        owner_finished[0] = True
    except Exception as error:
        finish_exception = error
        finish_error = f"{type(error).__name__}: {error}"
        passed = False
        owner_state = "review"
    receipt.setdefault("storage", {}).update(
        owner_state=owner_state,
        owner_finish_recorded=owner_finish_recorded,
    )
    if finish_error:
        receipt["storage"]["owner_finish_error"] = finish_error
    if isinstance(finish_exception, CommandTimeout):
        receipt["timeout"] = {
            "command": finish_exception.command,
            "timeout_seconds": finish_exception.timeout_seconds,
            "log_path": str(finish_exception.log_path) if finish_exception.log_path else None,
        }
    if not passed:
        receipt["status"] = "failed"
    if not passed and "error" not in receipt:
        receipt["error"] = finish_error or post_run_identity_error or "Contract execution did not pass"
    receipt.setdefault("timeouts", {}).update(
        elapsed_seconds=time.monotonic() - started_at,
        build_execution_timeout_minutes=timeouts["execution_minutes"],
        finalization_reserve_minutes=reserve["finalization_reserve_minutes"],
        orchestration_deadline_monotonic=_ORCHESTRATION_DEADLINE,
        receipt_reserve_minutes=reserve["receipt_reserve_minutes"],
    )
    _write_json(receipt_path, receipt)
    print(f"MFEM CPU {contract_profile} contract evidence: {run_dir}", flush=True)
    return 0 if passed else 1


def _parse_args(argv: list[str] | None = None) -> Any:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument(
        "--contract-profile",
        choices=tuple(CONTRACT_PROFILES),
        default="positive-mass",
    )
    parser.add_argument("--run-dir")
    parser.add_argument("--build-dir")
    parser.add_argument("--temp-dir")
    parser.add_argument("--storage-root")
    parser.add_argument("--worktree-id")
    parser.add_argument("--project-root")
    parser.add_argument("--git-head")
    parser.add_argument("--github-sha")
    parser.add_argument("--github-ref")
    parser.add_argument("--repository")
    parser.add_argument("--deadline-monotonic", type=float)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    if args.execute:
        required = (
            "run_dir",
            "build_dir",
            "temp_dir",
            "storage_root",
            "worktree_id",
            "project_root",
            "git_head",
            "github_sha",
            "github_ref",
            "repository",
        )
        if any(not getattr(args, name) for name in required) or args.deadline_monotonic is None:
            print(f"[{_contract_profile(args.contract_profile)['slug']}] incomplete managed execution context", file=sys.stderr)
            return 2
        return _execute_contract(args)
    try:
        return _orchestrate(args.contract_profile)
    except Exception as error:
        print(f"[{_contract_profile(args.contract_profile)['slug']}] {type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
