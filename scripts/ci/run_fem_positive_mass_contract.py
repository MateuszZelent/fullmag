#!/usr/bin/env python3
"""Run the MFEM CPU positive tangent-mass source contract in GitHub Actions.

This is a bounded CI container route for one CTest target. It does not build or
publish a Fullmag runtime and is not production FEM qualification.
"""

from __future__ import annotations

import atexit
import hashlib
import json
import os
from pathlib import Path
import re
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
FINALIZATION_RESERVE_MINUTES = ORCHESTRATION_TIMEOUT_MINUTES - BUILD_EXECUTION_TIMEOUT_MINUTES
RECEIPT_RESERVE_MINUTES = WORKFLOW_TIMEOUT_MINUTES - ORCHESTRATION_TIMEOUT_MINUTES
METADATA_TIMEOUT_SECONDS = 120
DOCKER_PULL_TIMEOUT_SECONDS = 600
DEPENDENCY_BUILD_TIMEOUT_SECONDS = 5400
NATIVE_BUILD_TEST_TIMEOUT_SECONDS = 3600
IMAGE_BASE = "ubuntu:22.04"
IMAGE_BUILD_INPUTS = "/opt/fullmag-deps/share/fullmag/fem-cpu-build-inputs.json"
TEST_SOURCE_SUFFIX = "backends/fem/tests/frequency_domain/poisson_airbox_shared_domain_test.cpp"
TEST_MARKER = "PASS: floquet_positive_tangent_mass_matches_independent_phase_reduction"
TEST_NAME = "fem_poisson_airbox_shared_domain_contract"
SCHEMA = "fullmag.ci.fem.positive_tangent_mass_contract.v1"
_ORCHESTRATION_DEADLINE: float | None = None


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
    for name in ("MFEM_REF", "MFEM_SOURCE_COMMIT", "HYPRE_REF", "CMAKE_VERSION"):
        match = re.search(rf"(?m)^ENV\s+{re.escape(name)}=([^\s]+)\s*$", text)
        if match is None:
            raise ContractRunError(f"CPU FEM Dockerfile no longer declares {name}")
        values[name] = match.group(1)
    if not re.fullmatch(r"[0-9a-f]{40}", values["MFEM_SOURCE_COMMIT"]):
        raise ContractRunError("MFEM_SOURCE_COMMIT is not a full lowercase Git SHA")
    if not values["MFEM_REF"].startswith("v"):
        raise ContractRunError("MFEM_REF must remain an explicit version tag")
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


def _verify_mfem_compile_gate(compile_commands: Path) -> bool:
    try:
        commands = json.loads(compile_commands.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ContractRunError("CMake compile_commands.json is unavailable or invalid") from error
    matches = []
    for entry in commands:
        file_name = str(entry.get("file", "")).replace("\\", "/")
        if file_name.endswith(TEST_SOURCE_SUFFIX):
            command = entry.get("command", "")
            if not command and isinstance(entry.get("arguments"), list):
                command = " ".join(str(part) for part in entry["arguments"])
            matches.append("-DFULLMAG_HAS_MFEM_STACK=1" in str(command))
    if not matches:
        raise ContractRunError("Compile database has no command for the MFEM assembly test source")
    return all(matches)


def _execute_contract(args: Any) -> int:
    run_dir = Path(args.run_dir)
    build_dir = Path(args.build_dir)
    temp_dir = Path(args.temp_dir)
    storage_root = Path(args.storage_root)
    receipt_path = run_dir / "receipt.json"
    receipt: dict[str, Any] = {
        "schema": SCHEMA,
        "status": "running",
        "qualification_scope": "mfem_cpu_assembly_source_contract_only",
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
            "kind": "github_hosted_cpu_mfem_container_contract",
            "managed_runtime": False,
            "cuda": False,
            "slepc": False,
            "docker_dependency_build_jobs": DOCKER_BUILD_JOBS,
            "native_build_jobs": NATIVE_BUILD_JOBS,
            "metadata_timeout_seconds": METADATA_TIMEOUT_SECONDS,
            "docker_pull_timeout_seconds": DOCKER_PULL_TIMEOUT_SECONDS,
            "dependency_build_timeout_seconds": DEPENDENCY_BUILD_TIMEOUT_SECONDS,
            "native_build_test_timeout_seconds": NATIVE_BUILD_TEST_TIMEOUT_SECONDS,
            "build_execution_timeout_minutes": BUILD_EXECUTION_TIMEOUT_MINUTES,
            "finalization_reserve_minutes": FINALIZATION_RESERVE_MINUTES,
            "orchestration_timeout_minutes": ORCHESTRATION_TIMEOUT_MINUTES,
            "receipt_reserve_minutes": RECEIPT_RESERVE_MINUTES,
            "workflow_timeout_minutes": WORKFLOW_TIMEOUT_MINUTES,
        },
        "test": {
            "target": TEST_NAME,
            "ctest_regex": f"^{TEST_NAME}$",
            "assertion_marker": TEST_MARKER,
            "assertion_marker_observed": False,
            "mfem_compile_gate_observed": False,
        },
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
        image_iid_path = build_dir / "image.iid"
        image_input_path = run_dir / "fem-cpu-image-build-inputs.json"
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
                timeout_seconds=DEPENDENCY_BUILD_TIMEOUT_SECONDS,
        )
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
                "/opt/fullmag-deps/lib/libmfem.so",
                "/opt/fullmag-deps/lib/libHYPRE.so",
            ],
            cwd=REPO_ROOT,
            env=env,
        )
        library_hash_path.write_text(library_hashes + "\n", encoding="utf-8")
        if not re.search(r"(?m)^[0-9a-f]{64}\s+.+libmfem\.so$", library_hashes):
            raise ContractRunError("MFEM library SHA-256 was not observed")
        if not re.search(r"(?m)^[0-9a-f]{64}\s+.+libHYPRE\.so$", library_hashes):
            raise ContractRunError("HYPRE library SHA-256 was not observed")

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
        _write_json(receipt_path, receipt)

        storage_relative_build = build_dir.relative_to(storage_root).as_posix()
        storage_relative_temp = temp_dir.relative_to(storage_root).as_posix()
        container_build_dir = f"/fullmag-storage/{storage_relative_build}/native"
        container_temp_dir = f"/fullmag-storage/{storage_relative_temp}"
        native_build_dir = build_dir / "native"
        inner_script = r"""set -euo pipefail
mkdir -p "$FM_BUILD_DIR" "$FM_TEMP_DIR"
export TMPDIR="$FM_TEMP_DIR" TEMP="$FM_TEMP_DIR" TMP="$FM_TEMP_DIR"
cmake -S /workspace/native -B "$FM_BUILD_DIR" -G "Unix Makefiles" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  -DFULLMAG_ENABLE_CUDA=OFF \
  -DFULLMAG_ENABLE_FEM_GPU=OFF \
  -DFULLMAG_USE_MFEM_STACK=ON \
  -DFULLMAG_FEM_WITH_SLEPC=OFF
cmake --build "$FM_BUILD_DIR" \
  --target fem_poisson_airbox_shared_domain_contract \
  --parallel 2
export LD_LIBRARY_PATH="$FM_BUILD_DIR/backends/fem:/opt/fullmag-deps/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
ctest --test-dir "$FM_BUILD_DIR/backends/fem" \
  --output-on-failure --verbose --no-tests=error \
  -R '^fem_poisson_airbox_shared_domain_contract$'
"""
        _run_logged(
            [
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
                "--env",
                f"FM_BUILD_DIR={container_build_dir}",
                "--env",
                f"FM_TEMP_DIR={container_temp_dir}",
                "--env",
                "CMAKE_BUILD_PARALLEL_LEVEL=2",
                "--env",
                "FULLMAG_USE_MFEM_STACK=ON",
                "--env",
                "FULLMAG_FEM_WITH_SLEPC=OFF",
                image_tag,
                "bash",
                "-lc",
                inner_script,
            ],
            cwd=REPO_ROOT,
            env=env,
            log_path=run_dir / "native-build-and-ctest.log",
            timeout_seconds=NATIVE_BUILD_TEST_TIMEOUT_SECONDS,
        )

        cache = _parse_cache(native_build_dir / "CMakeCache.txt")
        expected_cache = {
            "CMAKE_BUILD_TYPE": "Release",
            "CMAKE_GENERATOR": "Unix Makefiles",
            "CMAKE_EXPORT_COMPILE_COMMANDS": "ON",
            "FULLMAG_ENABLE_CUDA": "OFF",
            "FULLMAG_ENABLE_FEM_GPU": "OFF",
            "FULLMAG_USE_MFEM_STACK": "ON",
            "FULLMAG_FEM_WITH_SLEPC": "OFF",
        }
        observed_cache = {name: cache.get(name) for name in expected_cache}
        if observed_cache != expected_cache:
            raise ContractRunError(f"CMake cache differs from the CPU test contract: {observed_cache}")
        compile_gate = _verify_mfem_compile_gate(
            native_build_dir / "compile_commands.json"
        )
        if not compile_gate:
            raise ContractRunError("MFEM-only test source was compiled without FULLMAG_HAS_MFEM_STACK=1")
        test_log = (run_dir / "native-build-and-ctest.log").read_text(
            encoding="utf-8", errors="replace"
        )
        if TEST_MARKER not in test_log:
            raise ContractRunError("CTest passed without the positive tangent-mass assertion marker")
        if not re.search(r"(?m)100% tests passed, 0 tests failed out of 1", test_log):
            raise ContractRunError("CTest output does not report exactly one passing contract")
        _assert_source_identity(
            args.git_head, args.github_sha, env=env, stage="after native build and CTest"
        )
        receipt["source"]["identity_verified_after_test"] = True

        _write_json(
            run_dir / "cmake-configuration.json",
            {
                "cache_options": observed_cache,
                "fullmag_has_mfem_stack_compile_definition": True,
                "target": TEST_NAME,
                "native_build_jobs": NATIVE_BUILD_JOBS,
                "ctest_regex": f"^{TEST_NAME}$",
                "assertion_marker_observed": True,
            },
        )
        receipt["test"].update(
            status="passed",
            assertion_marker_observed=True,
            mfem_compile_gate_observed=True,
            ctest_exit_code=0,
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
        print(f"[fem-positive-mass-contract] {failure}", file=sys.stderr, flush=True)
    finally:
        receipt["status"] = status
        if failure:
            receipt["error"] = failure
        _write_json(receipt_path, receipt)
    return 0 if status == "passed" else 1


def _orchestrate() -> int:
    global _ORCHESTRATION_DEADLINE
    started_at = time.monotonic()
    _ORCHESTRATION_DEADLINE = started_at + ORCHESTRATION_TIMEOUT_MINUTES * 60
    execution_deadline = started_at + BUILD_EXECUTION_TIMEOUT_MINUTES * 60
    env = _require_github_host()
    head = _git("-C", str(REPO_ROOT), "rev-parse", "HEAD")
    github_sha = env.get("GITHUB_SHA", "")
    _assert_source_identity(head, github_sha, env=env, stage="before storage preflight")
    repository = env.get("GITHUB_REPOSITORY", "")
    run_id = env["GITHUB_RUN_ID"]
    attempt = env["GITHUB_RUN_ATTEMPT"]
    task_id = f"fem-positive-mass-contract-{run_id}-{attempt}"
    owner = f"github-actions:{repository}:{run_id}.{attempt}"
    layout, env = _prepare_storage(env)
    storage_root = Path(layout["storage_root"])
    build_dir = Path(layout["build_root"]) / f"fem-positive-mass-contract-{run_id}-{attempt}"
    run_dir = Path(layout["runs_root"]) / "fem-positive-mass-contract" / f"{run_id}-{attempt}"
    temp_dir = Path(layout["temp_root"]) / f"fem-positive-mass-contract-{run_id}-{attempt}"
    for path in (build_dir, run_dir, temp_dir):
        _validated_path(path, env=env)

    _owner_action(
        "register",
        env=env,
        task_id=task_id,
        owner=owner,
        purpose=(
            "Run the GitHub-hosted MFEM CPU positive tangent-mass source contract; "
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
                    f"[fem-positive-mass-contract] could not finish storage owner: {error}",
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
                        f"[fem-positive-mass-contract] could not finalize receipt: {error}",
                        file=sys.stderr,
                        flush=True,
                    )

    atexit.register(finish_interrupted_owner)
    run_dir.mkdir(parents=True, exist_ok=False)
    _append_github_file("GITHUB_OUTPUT", f"evidence_dir={run_dir}")
    output = {
        "schema": SCHEMA,
        "status": "queued",
        "qualification_scope": "mfem_cpu_assembly_source_contract_only",
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
            "orchestration_timeout_minutes": ORCHESTRATION_TIMEOUT_MINUTES,
            "receipt_reserve_minutes": RECEIPT_RESERVE_MINUTES,
            "workflow_timeout_minutes": WORKFLOW_TIMEOUT_MINUTES,
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
            "schema": "fullmag.ci.fem.positive_tangent_mass_preflight.v1",
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
        build_execution_timeout_minutes=BUILD_EXECUTION_TIMEOUT_MINUTES,
        finalization_reserve_minutes=FINALIZATION_RESERVE_MINUTES,
        orchestration_deadline_monotonic=_ORCHESTRATION_DEADLINE,
        receipt_reserve_minutes=RECEIPT_RESERVE_MINUTES,
    )
    _write_json(receipt_path, receipt)
    print(f"MFEM CPU assembly contract evidence: {run_dir}", flush=True)
    return 0 if passed else 1


def _parse_args(argv: list[str] | None = None) -> Any:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true", help=argparse.SUPPRESS)
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
            print("[fem-positive-mass-contract] incomplete managed execution context", file=sys.stderr)
            return 2
        return _execute_contract(args)
    try:
        return _orchestrate()
    except Exception as error:
        print(f"[fem-positive-mass-contract] {type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
