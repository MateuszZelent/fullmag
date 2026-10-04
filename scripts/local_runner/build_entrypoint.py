#!/usr/bin/env python3
"""Run one immutable Fullmag source capsule in a trusted build container.

The host coordinator owns scheduling and Docker isolation.  This entrypoint is
the small, trusted stage inside the pinned image: it verifies the capsule,
materializes it into a private execution directory, runs only the repository's
managed build recipes, and publishes an auditable receipt.  It deliberately
does not accept a shell command from the job request.
"""

from __future__ import annotations

import argparse
import ctypes
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import time
from typing import Any, Mapping

try:  # The trusted files are mounted together at /runner in production.
    from worker_entrypoint import verify_source
except ImportError:  # pragma: no cover - package import used by local tests.
    from .worker_entrypoint import verify_source


CAPSULE_SCHEMA = "fullmag.source-capsule.v1"
CONTEXT_SCHEMA = "fullmag.runner-execution.v1"
IDENTITY_SCHEMA = "fullmag.source-snapshot.v2"
RECEIPT_SCHEMA = "fullmag.local-runner.build-receipt.v1"

JOB_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")
SHA256_RE = re.compile(r"[a-f0-9]{64}\Z")
COMMIT_RE = re.compile(r"[a-f0-9]{40}(?:[a-f0-9]{24})?\Z")
IMAGE_RE = re.compile(r"sha256:[a-f0-9]{64}\Z")
STAGE_RE = re.compile(r"[a-z0-9][a-z0-9_.-]{0,63}\Z")

DEFAULT_JOBS = 2
MAX_JOBS = 64
MAX_CONTEXT_BYTES = 4 * 1024 * 1024
MAX_ERROR_LENGTH = 4096
SLEPC_PROBE_OUTPUT_LIMIT = 64 * 1024
SLEPC_PROBE_TIMEOUT_SECONDS = 120
SLEPC_PROBE_SCHEMA = "fullmag.fem.slepc_runtime.availability_probe.v1"
SLEPC_PROBE_TRUNCATION_MARKER = (
    "\n[fullmag] probe output truncated after "
    f"{SLEPC_PROBE_OUTPUT_LIMIT} bytes\n"
)
ALLOWED_WORKSPACE_MOUNTPOINTS = frozenset(
    {".fullmag-build", ".fullmag-cargo", ".fullmag-rustup"}
)

# CUDA-enabled FEM libraries can retain a transitive libcuda.so.1 dependency
# even when the selected runtime lane is CPU-only. The pinned CUDA image owns
# the compatibility driver, so the probe must expose that directory explicitly
# without requiring a host NVIDIA driver or a GPU device.
CUDA_DRIVER_COMPATIBILITY_PATHS = (Path("/usr/local/cuda/compat"),)

# Preserve declared toolchain discovery, not arbitrary command overrides or
# credentials embedded in an image/environment. Execution paths are set below.
TOOLCHAIN_ENVIRONMENT = frozenset({
    'PATH', 'LANG', 'LC_ALL', 'TZ', 'INSTALL_PREFIX', 'CMAKE_PREFIX_PATH',
    'LD_LIBRARY_PATH', 'LIBRARY_PATH', 'PKG_CONFIG_PATH', 'CPATH',
    'CUDA_HOME', 'CUDA_PATH', 'CUDA_VISIBLE_DEVICES', 'NVIDIA_VISIBLE_DEVICES',
    'NVIDIA_DRIVER_CAPABILITIES', 'PETSC_DIR', 'PETSC_ARCH', 'SLEPC_DIR',
    'FULLMAG_USE_MFEM_STACK', 'COREPACK_HOME', 'PNPM_HOME',
})


class BuildEntryPointError(ValueError):
    """A fail-closed build-entrypoint contract or execution error."""


def _cuda_driver_compatibility_paths(
    candidates: tuple[Path, ...] | None = None,
) -> tuple[str, ...]:
    """Return image-owned directories that provide a loadable libcuda SONAME."""

    paths = candidates if candidates is not None else CUDA_DRIVER_COMPATIBILITY_PATHS
    available: list[str] = []
    for candidate in paths:
        try:
            if (candidate / "libcuda.so.1").is_file():
                available.append(str(candidate))
        except OSError:
            continue
    return tuple(available)


def _preload_cuda_driver_compatibility_libraries(
    compatibility_paths: tuple[str, ...],
) -> tuple[str, ...]:
    """Load image-owned CUDA compatibility drivers before native ``dlopen``.

    Updating ``LD_LIBRARY_PATH`` in a running Python process does not reliably
    change glibc's search path for a later ``ctypes.CDLL`` call.  Preloading
    the absolute SONAME path makes the dependency available to the native FEM
    library while keeping the host driver and GPU out of the CPU lane.
    """

    loaded: list[str] = []
    for directory in compatibility_paths:
        # Keep the container's POSIX spelling even when the host-side tests
        # import this module on Windows.
        library_path = str(directory).rstrip("/\\") + "/libcuda.so.1"
        try:
            ctypes.CDLL(library_path, mode=ctypes.RTLD_GLOBAL)
        except OSError as error:
            raise BuildEntryPointError(
                "CUDA compatibility driver cannot be preloaded: "
                f"{library_path}: {error}"
            ) from error
        loaded.append(str(library_path))
    return tuple(loaded)


def _modal_driver_compatibility(cpu_abi_profile: bool) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """The complete CPU stack must never initialize an accelerator driver."""
    if cpu_abi_profile:
        return (), ()
    paths = _cuda_driver_compatibility_paths()
    return paths, _preload_cuda_driver_compatibility_libraries(paths)


@dataclass(frozen=True)
class Profile:
    name: str
    lane: str
    environment: Mapping[str, str]
    needs_cuda_toolchain: bool = False
    contract_scenarios: tuple[str, ...] = ()
    contract_script: str = "scripts/run_fem_cpu_only_contract.sh"
    contract_schema: str = "fullmag.fem.cpu_only_contract_result.v1"
    build_runtime: bool = False
    runtime_only: bool = False
    runtime_contract_schema: str | None = None


PROFILES: dict[str, Profile] = {
    "fem-cpu-release": Profile(
        name="fem-cpu-release",
        lane="fem-cpu",
        environment={
            "FULLMAG_BUILD_CPU_ONLY": "0",
            "FULLMAG_FORCE_LOCAL_FEM_CPU": "1",
            "FULLMAG_FORCE_LOCAL_FEM_GPU": "0",
            "FULLMAG_FEM_REQUIRE_GPU": "0",
            "FULLMAG_FEM_REQUIRE_CEED": "0",
            "FULLMAG_FEM_WITH_SLEPC": "OFF",
            # A forced CPU lane must never enter the managed GPU export path.
            "FULLMAG_SKIP_MANAGED_FEM_GPU_EXPORT": "1",
        },
    ),
    "fem-gpu-release": Profile(
        name="fem-gpu-release",
        lane="fem-gpu",
        environment={
            "FULLMAG_BUILD_CPU_ONLY": "0",
            "FULLMAG_FORCE_LOCAL_FEM_CPU": "0",
            "FULLMAG_FORCE_LOCAL_FEM_GPU": "1",
            "FULLMAG_FEM_REQUIRE_GPU": "1",
            "FULLMAG_FEM_REQUIRE_CEED": "1",
            "FULLMAG_SKIP_MANAGED_FEM_GPU_EXPORT": "1",
        },
        needs_cuda_toolchain=True,
    ),
    "fdm-cpu-release": Profile(
        name="fdm-cpu-release",
        lane="fdm-cpu",
        environment={
            "FULLMAG_BUILD_CPU_ONLY": "1",
            "FULLMAG_FORCE_LOCAL_FEM_CPU": "0",
            "FULLMAG_FORCE_LOCAL_FEM_GPU": "0",
            "FULLMAG_FEM_REQUIRE_GPU": "0",
            "FULLMAG_FEM_REQUIRE_CEED": "0",
            "FULLMAG_FEM_WITH_SLEPC": "OFF",
            "FULLMAG_SKIP_MANAGED_FEM_GPU_EXPORT": "1",
        },
    ),
}

# Contract profiles execute a trusted, fixed script and publish one result per
# scenario.  They intentionally keep the release profiles above unchanged.
PROFILES["fem-cpu-current-contracts-v1"] = Profile(
    name="fem-cpu-current-contracts-v1",
    lane="fem-cpu",
    environment=PROFILES["fem-cpu-release"].environment,
    contract_scenarios=("steady-transport", "steady-transport-rt0", "oersted-oet0"),
)
PROFILES["fem-gpu-current-contracts-v1"] = Profile(
    name="fem-gpu-current-contracts-v1",
    lane="fem-gpu",
    environment=PROFILES["fem-gpu-release"].environment,
    needs_cuda_toolchain=True,
    contract_scenarios=("gpu-current",),
    contract_script="scripts/run_current_gpu_contracts.sh",
    contract_schema="fullmag.current.gpu_contract_result.v1",
)
PROFILES["fem-cpu-slepc-modal-v1"] = Profile(
    name="fem-cpu-slepc-modal-v1",
    lane="fem-cpu",
    environment={
        "FULLMAG_BUILD_CPU_ONLY": "0",
        "FULLMAG_FORCE_LOCAL_FEM_CPU": "1",
        "FULLMAG_FORCE_LOCAL_FEM_GPU": "0",
        "FULLMAG_FEM_REQUIRE_GPU": "0",
        "FULLMAG_FEM_REQUIRE_CEED": "0",
        "FULLMAG_FEM_WITH_SLEPC": "ON",
        "FULLMAG_USE_MFEM_STACK": "ON",
        "FULLMAG_MANAGED_FEM_DEVICE": "cpu",
        "FULLMAG_FEM_MFEM_DEVICE": "cpu",
        "FULLMAG_SKIP_MANAGED_FEM_GPU_EXPORT": "1",
    },
    contract_scenarios=("slepc-modal",),
    contract_script="scripts/run_fem_cpu_slepc_modal_contract.sh",
    contract_schema="fullmag.fem.cpu.slepc_modal_contract_result.v1",
    build_runtime=True,
)
PROFILES["fem-cpu-slepc-runtime-v1"] = Profile(
    name="fem-cpu-slepc-runtime-v1",
    lane="fem-cpu",
    environment={
        "FULLMAG_BUILD_CPU_ONLY": "0",
        "FULLMAG_FORCE_LOCAL_FEM_CPU": "1",
        "FULLMAG_FORCE_LOCAL_FEM_GPU": "0",
        "FULLMAG_FEM_REQUIRE_GPU": "0",
        "FULLMAG_FEM_REQUIRE_CEED": "0",
        "FULLMAG_FEM_WITH_SLEPC": "ON",
        "FULLMAG_USE_MFEM_STACK": "ON",
        "FULLMAG_MANAGED_FEM_DEVICE": "cpu",
        "FULLMAG_FEM_MFEM_DEVICE": "cpu",
        "FULLMAG_SKIP_MANAGED_FEM_GPU_EXPORT": "1",
    },
    runtime_only=True,
    runtime_contract_schema="fullmag.fem.cpu.slepc_runtime_contract.v1",
)
PROFILES["fem-cpu-slepc-runtime-v2"] = Profile(
    name="fem-cpu-slepc-runtime-v2",
    lane="fem-cpu",
    environment={
        **PROFILES["fem-cpu-slepc-runtime-v1"].environment,
        "FULLMAG_FEM_NATIVE_CUDA": "0",
        "FULLMAG_FEM_ENABLE_CUDA": "0",
        "CMAKE_PREFIX_PATH": "/opt/fullmag-mfem-cpu",
        "LD_LIBRARY_PATH": "/opt/fullmag-mfem-cpu/lib",
        "PKG_CONFIG_PATH": "/opt/fullmag-mfem-cpu/lib/pkgconfig",
        "CPATH": "/opt/fullmag-mfem-cpu/include",
        "LIBRARY_PATH": "/opt/fullmag-mfem-cpu/lib",
        "PETSC_DIR": "/opt/fullmag-mfem-cpu",
        "PETSC_ARCH": "",
        "SLEPC_DIR": "/opt/fullmag-mfem-cpu",
    },
    runtime_only=True,
    runtime_contract_schema="fullmag.fem.cpu.slepc_runtime_contract.v2",
)


BASE_REQUIRED_OUTPUTS = (
    "bin/fullmag-bin",
    "bin/fullmag-api",
    "_fullmag_core.so",
    "launcher-build-mode",
    "web/index.html",
)
HEADLESS_REQUIRED_OUTPUTS = (
    "bin/fullmag-bin",
    "bin/fullmag-api",
    "_fullmag_core.so",
    "launcher-build-mode",
)
RELEASE_PROFILE_NAMES = frozenset(("fdm-cpu-release", "fem-cpu-release", "fem-gpu-release"))
REQUIRED_OUTPUTS = BASE_REQUIRED_OUTPUTS + (
    "bin/fullmag-api-accepted-worker",
    "bin/fullmag-api-accepted-supervisor",
    "bin/fullmag-api-accepted-scheduler",
    "bin/fullmag-runtime-service",
    "bin/fullmag-api-resource-pool",
    "bin/fullmag-api-accepted-fem-preparer",
    "bin/fullmag-api-accepted-fem-preparation-supervisor",
    "bin/fullmag-api-accepted-fem-preparation-scheduler",
    "bin/fullmag-api-preparation-resource-pool",
    "bin/fullmag-api-preparation-retry",
)
EXPECTED_BUILD_MARKER = {
    "fem-cpu-release": "fem-cpu",
    "fem-gpu-release": "cuda-fem-gpu",
    "fdm-cpu-release": "cpu",
    "fem-cpu-slepc-modal-v1": "fem-cpu",
    "fem-cpu-slepc-runtime-v1": "fem-cpu",
    "fem-cpu-slepc-runtime-v2": "fem-cpu",
}


def _runtime_contract(profile: Profile) -> dict[str, Any] | None:
    if not profile.runtime_only:
        return None
    if not profile.runtime_contract_schema:
        raise BuildEntryPointError(
            f"runtime-only profile has no contract schema: {profile.name}"
        )
    return {
        "schema": profile.runtime_contract_schema,
        "native_target": "fullmag_fem",
        "backend": "fem",
        "device": "cpu",
        "precision": "double",
        "slepc": profile.environment.get("FULLMAG_FEM_WITH_SLEPC") == "ON",
        "cmake_options": {
            "FULLMAG_ENABLE_CUDA": (
                "OFF" if profile.name == "fem-cpu-slepc-runtime-v2" else "ON"
            ),
            "FULLMAG_ENABLE_FEM_GPU": (
                "OFF" if profile.name == "fem-cpu-slepc-runtime-v2" else "ON"
            ),
            "FULLMAG_USE_MFEM_STACK": "ON",
            "FULLMAG_FEM_WITH_SLEPC": "ON",
        },
        "unit_test_targets": [],
        "frontend_stages": [],
    }


def canonical(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        + "\n"
    ).encode("utf-8")


def sha256_file(path: Path) -> tuple[int, str]:
    if path.is_symlink() or not path.is_file():
        raise BuildEntryPointError(f"artifact is not a regular file: {path}")
    digest = hashlib.sha256()
    size = 0
    try:
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
                size += len(chunk)
    except OSError as error:
        raise BuildEntryPointError(f"cannot hash {path}") from error
    return size, digest.hexdigest()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _error_text(error: BaseException) -> str:
    text = f"{type(error).__name__}: {error}"
    return text[:MAX_ERROR_LENGTH]


def _regular_directory(path: Path, label: str, *, create: bool = False) -> Path:
    if path.is_symlink():
        raise BuildEntryPointError(f"{label} must not be a symlink")
    if create:
        try:
            path.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise BuildEntryPointError(f"cannot create {label}: {path}") from error
    if not path.exists() or not path.is_dir():
        raise BuildEntryPointError(f"{label} must be a directory: {path}")
    return path


def _private_directory(path: Path, label: str, *, create: bool = False) -> Path:
    """Ensure a private execution directory is writable by its owner.

    This helper is intentionally never called for the persistent cache/build
    mount roots or for the read-only source capsule.  It only adjusts the
    directory passed by the caller (for example ``workspace`` or the private
    ``home``/``tmp`` directories below the build mount).
    """

    path = _regular_directory(path, label, create=create)
    try:
        mode = stat.S_IMODE(path.stat(follow_symlinks=False).st_mode)
        writable = mode | stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR
        if writable != mode:
            path.chmod(writable)
    except OSError as error:
        raise BuildEntryPointError(f"cannot make private {label} owner-writable: {path}") from error
    return path


def _validate_job_id(job_id: object) -> str:
    if not isinstance(job_id, str) or JOB_ID_RE.fullmatch(job_id) is None:
        raise BuildEntryPointError("job_id is not a Docker-safe identifier")
    return job_id


def _validate_digest(value: object, label: str) -> str:
    if not isinstance(value, str) or SHA256_RE.fullmatch(value) is None:
        raise BuildEntryPointError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _validate_image_digest(value: object, label: str = "image_digest") -> str:
    if not isinstance(value, str) or IMAGE_RE.fullmatch(value) is None:
        raise BuildEntryPointError(f"{label} must be an exact image digest")
    return value


def profile_for(name: str) -> Profile:
    try:
        return PROFILES[name]
    except KeyError as error:
        raise BuildEntryPointError(f"unsupported build profile: {name}") from error


def _validate_native_identity(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise BuildEntryPointError(
            "context.native_source_identity must be a source-snapshot.v2 object"
        )
    identity = dict(value)
    if identity.get("schema") != IDENTITY_SCHEMA:
        raise BuildEntryPointError(
            "context.native_source_identity must have schema fullmag.source-snapshot.v2"
        )
    if COMMIT_RE.fullmatch(str(identity.get("head_commit_full", ""))) is None:
        raise BuildEntryPointError("native source identity has an invalid HEAD commit")
    for key in ("head_tree_sha256", "source_snapshot_sha256", "dirty_content_sha256"):
        _validate_digest(identity.get(key), f"native source identity {key}")
    if not isinstance(identity.get("source_snapshot_dirty"), bool):
        raise BuildEntryPointError("native source identity dirty flag is invalid")
    if not isinstance(identity.get("git_status_porcelain_v1"), list):
        raise BuildEntryPointError("native source identity status is invalid")
    dirty_content = identity.get("dirty_path_content")
    if dirty_content is not None and not isinstance(dirty_content, list):
        raise BuildEntryPointError("native source identity dirty content is invalid")
    payload = dict(identity)
    for derived in ("source_snapshot_dirty", "dirty_content_sha256", "source_snapshot_sha256"):
        payload.pop(derived, None)
    expected_snapshot = hashlib.sha256(canonical(payload)).hexdigest()
    if identity["source_snapshot_sha256"] != expected_snapshot:
        raise BuildEntryPointError(
            "native source identity source_snapshot_sha256 does not match its payload"
        )
    return identity


def load_context(
    context_path: Path,
    *,
    job_id: str,
    source_digest: str,
    profile: str,
) -> dict[str, Any]:
    """Read the host-attested execution context and bind it to this request."""

    if context_path.is_symlink() or not context_path.is_file():
        raise BuildEntryPointError(f"trusted execution context is missing: {context_path}")
    try:
        if context_path.stat().st_size > MAX_CONTEXT_BYTES:
            raise BuildEntryPointError("trusted execution context is too large")
        context = json.loads(context_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise BuildEntryPointError("cannot read trusted execution context") from error
    if not isinstance(context, dict) or context.get("schema") != CONTEXT_SCHEMA:
        raise BuildEntryPointError("unsupported trusted execution context schema")
    expected = {
        "job_id": job_id,
        "source_digest": source_digest,
        "profile": profile,
    }
    for key, expected_value in expected.items():
        if context.get(key) != expected_value:
            raise BuildEntryPointError(f"trusted context {key} does not match request")
    _validate_image_digest(context.get("image_digest"))
    context["native_source_identity"] = _validate_native_identity(
        context.get("native_source_identity")
    )
    return context


def _is_git_entry(relative: str) -> bool:
    return relative == ".git" or relative.startswith(".git/")


def _check_capsule_has_no_git(manifest: Mapping[str, Any]) -> None:
    for entry in manifest.get("files", []):
        if isinstance(entry, dict) and _is_git_entry(str(entry.get("path", ""))):
            raise BuildEntryPointError("source capsule must not contain .git")


def _workspace_is_empty(workspace: Path) -> None:
    """Allow only directories occupied by explicitly mounted persistent paths."""

    # The workspace root is private execution state.  Do not recurse into or
    # chmod any of the three persistent mountpoints below it.
    _private_directory(workspace, "workspace")
    for child in workspace.iterdir():
        if child.name not in ALLOWED_WORKSPACE_MOUNTPOINTS:
            raise BuildEntryPointError(
                f"workspace must be empty before materialization: {child.name}"
            )
        if child.is_symlink() or not child.is_dir():
            raise BuildEntryPointError(f"workspace mountpoint is unsafe: {child}")


def materialize_capsule(manifest: Mapping[str, Any], source: Path, workspace: Path) -> None:
    """Copy the verified capsule tree into an empty execution workspace."""

    _check_capsule_has_no_git(manifest)
    tree = source / "tree"
    _workspace_is_empty(workspace)
    try:
        for child in tree.iterdir():
            if child.name == ".git":
                raise BuildEntryPointError("source capsule must not contain .git")
            if child.name in ALLOWED_WORKSPACE_MOUNTPOINTS:
                raise BuildEntryPointError(
                    f"source capsule attempts to replace a persistent mountpoint: {child.name}"
                )
            destination = workspace / child.name
            if child.is_symlink():
                raise BuildEntryPointError(f"source capsule contains a symlink: {child}")
            if child.is_dir():
                # Keep capsule bytes and timestamps immutable; the private copy gets fresh
                # mtimes so persistent build fingerprints observe the captured source revision.
                shutil.copytree(child, destination, copy_function=shutil.copy)
                # Only the private copy is writable. Never recurse into the
                # persistent mountpoints or change the readonly capsule.
                for current, _, _ in os.walk(destination, followlinks=False):
                    _private_directory(Path(current), 'materialized source directory')
            elif child.is_file():
                shutil.copy(child, destination)
            else:
                raise BuildEntryPointError(f"source capsule contains unsupported entry: {child}")
    except OSError as error:
        raise BuildEntryPointError("cannot materialize source capsule") from error
    if (workspace / ".git").exists() or (workspace / ".git").is_symlink():
        raise BuildEntryPointError("materialized workspace contains .git")
    expected_files = {
        str(entry["path"]): entry
        for entry in manifest.get("files", [])
        if isinstance(entry, Mapping)
    }
    for relative, entry in expected_files.items():
        destination = workspace.joinpath(*relative.split("/"))
        try:
            if entry.get("type") != "file" or destination.is_symlink() or not destination.is_file():
                raise BuildEntryPointError(
                    f"materialized source entry is not a regular file: {relative}"
                )
            expected_mode = 0o755 if entry["mode"] == "100755" else 0o644
            destination.chmod(expected_mode)
        except BuildEntryPointError:
            raise
        except (KeyError, OSError) as error:
            raise BuildEntryPointError(
                f"cannot restore source mode: {relative}"
            ) from error
        size, digest = sha256_file(destination)
        if size != entry["size"] or digest != entry["sha256"]:
            raise BuildEntryPointError(
                f"materialized source bytes do not match capsule: {relative}"
            )
        # Native Linux/container filesystems must represent the executable
        # bit. Windows host filesystems expose a synthetic 0666 mode through
        # Python even after chmod; the byte hash remains enforceable there,
        # while the managed Linux container performs the strict mode check.
        observed_mode = stat.S_IMODE(destination.stat(follow_symlinks=False).st_mode)
        if os.name != "nt" and observed_mode != expected_mode:
            raise BuildEntryPointError(
                f"materialized source mode does not match capsule: {relative}"
            )


def _validate_jobs(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_JOBS:
        raise BuildEntryPointError(f"jobs must be an integer between 1 and {MAX_JOBS}")
    return value


def build_environment(
    profile: Profile,
    *,
    workspace: Path,
    build: Path,
    jobs: int,
    native_identity: Mapping[str, Any],
) -> dict[str, str]:
    """Construct a clean, explicit environment for the managed Make stage."""

    jobs = _validate_jobs(jobs)
    target = build / "cargo-targets" / profile.lane
    _regular_directory(build, "build", create=False)
    for directory_name in ("home", "tmp"):
        _private_directory(build / directory_name, f"build {directory_name}", create=True)
    environment = {key: value for key, value in os.environ.items() if key in TOOLCHAIN_ENVIRONMENT}
    environment.update(profile.environment)
    environment.update(
        {
            "FULLMAG_WINDOWS_CONTAINER_MANAGED": "1",
            "FULLMAG_CARGO_TARGET_DIR": str(target),
            "CARGO_TARGET_DIR": str(target),
            "FULLMAG_CARGO_TARGET_ROOT": str(build / "cargo-targets"),
            "CARGO_TARGET_ROOT": str(build / "cargo-targets"),
            "CARGO_HOME": "/workspace/.fullmag-cargo",
            "RUSTUP_HOME": "/workspace/.fullmag-rustup",
            "RUSTUP_TOOLCHAIN": "nightly",
            "RUSTUP_AUTO_INSTALL": "0",
            "npm_config_store_dir": "/pnpm/store",
            "NPM_CONFIG_STORE_DIR": "/pnpm/store",
            "CARGO_BUILD_JOBS": str(jobs),
            "CMAKE_BUILD_PARALLEL_LEVEL": str(jobs),
            "FULLMAG_SOURCE_GIT_COMMIT": str(native_identity["head_commit_full"]),
            "FULLMAG_SOURCE_WORKTREE_STATE": (
                "dirty" if native_identity["source_snapshot_dirty"] else "clean"
            ),
            "FULLMAG_SOURCE_SNAPSHOT_SHA256": str(
                native_identity["source_snapshot_sha256"]
            ),
            "HOME": "/workspace/.fullmag-build/home",
            "TMPDIR": "/workspace/.fullmag-build/tmp",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
    )
    # The workspace argument is deliberately consumed by the subprocess cwd;
    # retaining it here is useful to scripts that record their execution root.
    environment["FULLMAG_RUNNER_WORKSPACE"] = str(workspace)
    return environment


def _offline_rustup_environment() -> dict[str, str]:
    # All managed profiles require a provisioned nightly.  A project override
    # must not make inventory/version probes sync or install another channel.
    return {**os.environ, "RUSTUP_TOOLCHAIN": "nightly", "RUSTUP_AUTO_INSTALL": "0"}


def _require_tool(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise BuildEntryPointError(f"required build tool is unavailable: {name}")
    return path


CPU_MODAL_LIBRARY_STEMS = {
    "mfem": "libmfem", "hypre": "libHYPRE", "ceed": "libceed",
    "petsc": "libpetsc", "slepc": "libslepc",
}


def observe_cpu_modal_linkage(output: str, prefix: Path) -> dict[str, dict[str, str]]:
    """Bind the complete resolved CPU dependency closure before loading native code."""
    libraries: dict[str, list[str]] = {name: [] for name in CPU_MODAL_LIBRARY_STEMS}
    forbidden = ("libcuda", "libcudart", "libcublas", "libcusparse", "libcusolver",
                 "libcurand", "libcufft", "libcupti", "libnccl", "libnvrtc", "libnvjitlink",
                 "libnvidia", "libhip", "libamdhip", "libsycl", "librocblas", "librocsolver")
    for line in output.splitlines():
        if "not found" in line or any(token in line.lower() for token in forbidden):
            raise BuildEntryPointError("CPU modal linkage contains missing or accelerator dependencies")
        name, separator, resolved = line.strip().partition(" => ")
        if not separator:
            continue
        for family, stem in CPU_MODAL_LIBRARY_STEMS.items():
            if re.fullmatch(re.escape(stem) + r"(?:_real|-[0-9.]+)?\.so(?:\.[0-9.]+)?", name):
                libraries[family].append(resolved.split(" (", 1)[0])
    result: dict[str, dict[str, str]] = {}
    for family, paths in libraries.items():
        if len(paths) != 1:
            raise BuildEntryPointError("CPU modal linkage is missing or ambiguous: " + family)
        path = Path(paths[0]).resolve(strict=True)
        if not path.is_relative_to(prefix.resolve(strict=True) / "lib"):
            raise BuildEntryPointError("CPU modal linkage escaped CPU prefix: " + family)
        _, digest = sha256_file(path)
        result[family] = {"path": str(path), "sha256": digest}
    return result


def bind_cpu_modal_resolution(
    dependency: dict[str, Any], libraries: Mapping[str, Mapping[str, str]],
    prefix: Path, workspace: Path,
) -> None:
    for family in ("petsc", "slepc"):
        path = Path(str(dependency.get(family + "_library_path", "")))
        if not path.is_absolute() or str(path.resolve(strict=True)) != libraries[family]["path"]:
            raise BuildEntryPointError("CPU modal configured/resolved library mismatch: " + family)
        directory = Path(str(dependency.get(family + "_pkgconfig_dir", "")))
        if not directory.is_absolute() or directory.resolve(strict=True) != (prefix / "lib/pkgconfig").resolve(strict=True):
            raise BuildEntryPointError("CPU modal pkg-config resolution escaped CPU prefix: " + family)
        module = Path(str(dependency.get(family + "_find_module_file", "")))
        expected = workspace / "backends/fem/cmake" / ("Find" + ("PETSc" if family == "petsc" else "SLEPc") + ".cmake")
        if not module.is_absolute() or module.resolve(strict=True) != expected.resolve(strict=True):
            raise BuildEntryPointError("CPU modal CMake module is not the captured project module: " + family)
        dependency[family + "_library_realpath"] = libraries[family]["path"]
        dependency[family + "_pkgconfig_dir"] = str(directory.resolve(strict=True))
        dependency[family + "_find_module_file"] = str(module.resolve(strict=True))


def require_cpu_modal_dependencies(prefix: Path) -> None:
    """Reject an older/mixed image before a production build; never load libraries."""
    expected = (
        "include/petscconf.h", "include/ceed.h", "include/slepceps.h",
        "lib/libpetsc.so", "lib/libslepc.so", "lib/libceed.so",
        "lib/libHYPRE.so", "lib/libmfem.so",
        "lib/pkgconfig/PETSc.pc", "lib/pkgconfig/SLEPc.pc",
    )
    resolved_prefix = prefix.resolve()
    for relative in expected:
        path = prefix / relative
        if not path.is_file() or not path.resolve().is_relative_to(resolved_prefix):
            raise BuildEntryPointError(
                "CPU modal dependency stack is missing or escapes its prefix: "
                + relative + "; provision the complete CPU stack in the pinned image"
            )
    config = (prefix / "include/petscconf.h").read_text(encoding="utf-8")
    for accelerator in ("CUDA", "HIP", "SYCL", "OPENCL"):
        matches = re.findall(
            r"^[ \t]*#[ \t]*define[ \t]+PETSC_HAVE_" + accelerator
            + r"\b([^\n]*)", config, re.MULTILINE
        )
        for raw in matches:
            value = re.sub(r"/\*.*?\*/", "", raw.split("//", 1)[0]).strip()
            if value == "0":
                continue
            if value not in ("", "1"):
                raise BuildEntryPointError("invalid PETSc accelerator macro: " + accelerator)
            raise BuildEntryPointError(
                "CPU modal PETSc advertises accelerator support: " + accelerator
            )
    if re.search(r"^\s*#\s*define\s+PETSC_USE_COMPLEX\b", config, re.MULTILINE):
        raise BuildEntryPointError("CPU modal PETSc must use real/double scalars")
    for macro in ("PETSC_USE_REAL_DOUBLE",):
        if not re.search(r"^\s*#\s*define\s+" + macro
                         + r"\s+1\b", config, re.MULTILINE):
            raise BuildEntryPointError("CPU modal PETSc must use real/double scalars")


def preflight(profile: Profile, *, release: bool = True) -> dict[str, str]:
    """Fail before Make if a forced lane would otherwise silently downgrade."""

    tools = {
        "make": _require_tool("make"),
        "cargo": _require_tool("cargo"),
        "rustc": _require_tool("rustc"),
        "rustup": _require_tool("rustup"),
    }
    try:
        rustup_result = subprocess.run(
            [tools["rustup"], "run", "nightly", "rustc", "--version"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            check=False,
            timeout=30,
            env=_offline_rustup_environment(),
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise BuildEntryPointError(
            f"cannot inspect installed Rust nightly: {_error_text(error)}"
        ) from error
    version_tokens = (rustup_result.stdout or "").strip().split()
    if (rustup_result.returncode != 0 or len(version_tokens) < 2
            or version_tokens[0] != "rustc"
            or not version_tokens[1].endswith("-nightly")):
        raise BuildEntryPointError(
            "required Rust nightly toolchain is not installed; provision it in the "
            "pinned image or mounted RUSTUP_HOME (fresh host: `rustup toolchain "
            "install nightly`). The runner never downloads toolchains automatically."
        )
    if release:
        if shutil.which("pnpm"):
            tools["pnpm"] = str(shutil.which("pnpm"))
        elif shutil.which("corepack"):
            tools["corepack"] = str(shutil.which("corepack"))
        else:
            raise BuildEntryPointError("release build requires pnpm or corepack")
    if profile.contract_scenarios:
        tools["bash"] = _require_tool("bash")
        tools["cmake"] = _require_tool("cmake")
        tools["ctest"] = _require_tool("ctest")
    if profile.needs_cuda_toolchain:
        tools["cmake"] = _require_tool("cmake")
        tools["nvcc"] = _require_tool("nvcc")
    if profile.name == "fem-cpu-slepc-runtime-v2":
        require_cpu_modal_dependencies(Path(profile.environment["PETSC_DIR"]))
    return tools


def _command_version(command: list[str]) -> dict[str, Any]:
    try:
        result = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            check=False,
            timeout=30,
            env=_offline_rustup_environment(),
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"command": command, "exit_code": None, "output": _error_text(error)}
    return {
        "command": command,
        "exit_code": result.returncode,
        "output": (result.stdout or "")[:MAX_ERROR_LENGTH],
    }


def toolchain_versions(tools: Mapping[str, str]) -> dict[str, Any]:
    versions: dict[str, Any] = {}
    for name, command in (
        ("python", ["python3", "--version"]),
        # Match Make's +nightly without allowing a source rust-toolchain.toml
        # to select or implicitly install another channel during observation.
        ("rustc", [tools["rustup"], "run", "nightly", "rustc", "--version"]),
        ("cargo", [tools["rustup"], "run", "nightly", "cargo", "--version"]),
        ("rustup", [tools["rustup"], "--version"]),
        ("make", [tools["make"], "--version"]),
    ):
        versions[name] = _command_version(command)
        if name in ("rustc", "cargo") and versions[name]["exit_code"] != 0:
            raise BuildEntryPointError(f"cannot observe installed nightly {name} version")
    if "pnpm" in tools:
        versions["pnpm"] = _command_version([tools["pnpm"], "--version"])
    elif "corepack" in tools:
        versions["corepack"] = _command_version([tools["corepack"], "pnpm", "--version"])
    if "cmake" in tools:
        versions["cmake"] = _command_version([tools["cmake"], "--version"])
    if "nvcc" in tools:
        versions["nvcc"] = _command_version([tools["nvcc"], "--version"])
    if "bash" in tools:
        versions["bash"] = _command_version([tools["bash"], "--version"])
    if "ctest" in tools:
        versions["ctest"] = _command_version([tools["ctest"], "--version"])
    return versions


def _pnpm_command(tools: Mapping[str, str]) -> list[str]:
    if "pnpm" in tools:
        return [tools["pnpm"]]
    if "corepack" in tools:
        return [tools["corepack"], "pnpm"]
    raise BuildEntryPointError("release build requires pnpm or corepack")


def _write_log(path: Path, data: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("x", encoding="utf-8", newline="") as stream:
            stream.write(data)
    except FileExistsError as error:
        raise BuildEntryPointError(f"refusing to replace existing stage log: {path}") from error


def _bounded_probe_output(value: object) -> tuple[bytes, int, bool]:
    """Bound the persisted representation of a subprocess stream."""

    if value is None:
        raw = b""
    elif isinstance(value, bytes):
        raw = value
    elif isinstance(value, str):
        raw = value.encode("utf-8", errors="replace")
    else:
        raw = str(value).encode("utf-8", errors="replace")
    original_size = len(raw)
    if original_size <= SLEPC_PROBE_OUTPUT_LIMIT:
        return raw, original_size, False
    marker = SLEPC_PROBE_TRUNCATION_MARKER.encode("utf-8")
    prefix_size = max(0, SLEPC_PROBE_OUTPUT_LIMIT - len(marker))
    bounded = raw[:prefix_size] + marker[:SLEPC_PROBE_OUTPUT_LIMIT - prefix_size]
    return bounded, original_size, True


def _write_probe_log(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError as error:
        raise BuildEntryPointError(f"refusing to replace stage log: {path}") from error
    except OSError as error:
        raise BuildEntryPointError(f"cannot publish stage log: {path}") from error


def _write_json_log(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError as error:
        raise BuildEntryPointError(f"refusing to replace probe evidence: {path}") from error
    except OSError as error:
        raise BuildEntryPointError(f"cannot publish probe evidence: {path}") from error


def _write_slepc_probe_evidence(
    artifacts: Path,
    *,
    status: str,
    return_code: int | None,
    stdout: object,
    stderr: object,
    error: BaseException | None,
    started_at: str,
    finished_at: str,
) -> None:
    """Persist bounded availability-probe output without serializing its environment."""

    log_root = artifacts / "logs"
    stdout_data, stdout_bytes, stdout_truncated = _bounded_probe_output(stdout)
    stderr_data, stderr_bytes, stderr_truncated = _bounded_probe_output(stderr)
    stdout_path = log_root / "slepc-runtime-availability.stdout.log"
    stderr_path = log_root / "slepc-runtime-availability.stderr.log"
    state_path = log_root / "slepc-runtime-availability.json"
    _write_probe_log(stdout_path, stdout_data)
    _write_probe_log(stderr_path, stderr_data)
    state: dict[str, Any] = {
        "schema": SLEPC_PROBE_SCHEMA,
        "status": status,
        "scope": "subprocess_execution",
        "validation": "not_assessed",
        "return_code": return_code,
        "timeout_seconds": SLEPC_PROBE_TIMEOUT_SECONDS,
        "started_at": started_at,
        "finished_at": finished_at,
        "stdout_log": stdout_path.relative_to(artifacts).as_posix(),
        "stderr_log": stderr_path.relative_to(artifacts).as_posix(),
        "stdout_bytes": stdout_bytes,
        "stderr_bytes": stderr_bytes,
        "stdout_truncated": stdout_truncated,
        "stderr_truncated": stderr_truncated,
    }
    if error is not None:
        state["error"] = _error_text(error)
    _write_json_log(state_path, state)


def _tail_text(path: Path, limit: int = 1024) -> str:
    """Read only a bounded byte window from the end of a stage log."""

    try:
        with path.open("rb") as stream:
            stream.seek(0, os.SEEK_END)
            end = stream.tell()
            stream.seek(max(0, end - limit), os.SEEK_SET)
            return stream.read(limit).decode("utf-8", errors="replace")[-limit:]
    except OSError as error:
        raise BuildEntryPointError(f"cannot read stage log tail: {path}") from error


def run_stage(
    name: str,
    command: list[str],
    *,
    workspace: Path,
    artifacts: Path,
    environment: Mapping[str, str],
) -> dict[str, Any]:
    """Run one fixed command and retain stdout/stderr as immutable logs."""

    if STAGE_RE.fullmatch(name) is None or not command:
        raise BuildEntryPointError("invalid managed build stage")
    log_root = artifacts / "logs"
    stdout_path = log_root / f"{name}.stdout.log"
    stderr_path = log_root / f"{name}.stderr.log"
    started = time.time()
    started_at = _utc_now()
    process: subprocess.Popen[str] | None = None
    stdout_text = ""
    stderr_text = ""
    exit_code: int | None = None
    print(
        f"[fullmag runner] stage {name} start command={json.dumps(command, ensure_ascii=False)}",
        flush=True,
    )
    try:
        log_root.mkdir(parents=True, exist_ok=True)
        with stdout_path.open("x", encoding="utf-8", newline="") as stdout, stderr_path.open(
            "x", encoding="utf-8", newline=""
        ) as stderr:
            process = subprocess.Popen(
                command,
                cwd=str(workspace),
                env=dict(environment),
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
                text=True,
            )
            exit_code = process.wait()
        # Keep a bounded preview in the receipt without loading the complete log.
        stdout_text = _tail_text(stdout_path)
        stderr_text = _tail_text(stderr_path)
    except OSError as error:
        exit_code = None
        stderr_text = _error_text(error)
        if not stdout_path.exists():
            _write_log(stdout_path, "")
        if not stderr_path.exists():
            _write_log(stderr_path, stderr_text)
    finished = time.time()
    print(
        f"[fullmag runner] stage {name} end exit_code={exit_code} duration_ms={round((finished - started) * 1000, 3)}",
        flush=True,
    )
    return {
        "name": name,
        "command": list(command),
        "started_at": started_at,
        "finished_at": _utc_now(),
        "duration_ms": round((finished - started) * 1000, 3),
        "exit_code": exit_code,
        "stdout_log": stdout_path.relative_to(artifacts).as_posix(),
        "stderr_log": stderr_path.relative_to(artifacts).as_posix(),
        "stdout_tail": stdout_text,
        "stderr_tail": stderr_text,
    }


def required_outputs_for_profile(profile_name: str) -> tuple[str, ...]:
    # Keep release qualification independent of specialized registry additions.
    return REQUIRED_OUTPUTS if profile_name in RELEASE_PROFILE_NAMES else BASE_REQUIRED_OUTPUTS


def _required_output_paths(
    output: Path, outputs: tuple[str, ...] = REQUIRED_OUTPUTS,
) -> tuple[Path, ...]:
    return tuple(output.joinpath(*relative.split("/")) for relative in outputs)


def _validate_required_outputs(
    output: Path,
    profile: Profile,
    *,
    required_outputs: tuple[str, ...] | None = None,
) -> None:
    outputs = (
        required_outputs
        if required_outputs is not None
        else required_outputs_for_profile(profile.name)
    )
    if not output.exists():
        missing = outputs[0] if outputs else "runtime output"
        raise BuildEntryPointError(f"required Fullmag output is missing: {missing}")
    if output.is_symlink() or not output.is_dir():
        raise BuildEntryPointError("Fullmag output directory is not a regular directory")
    for relative, path in zip(outputs, _required_output_paths(output, outputs)):
        if path.is_symlink() or not path.is_file():
            raise BuildEntryPointError(f"required Fullmag output is missing: {relative}")
        if path.stat().st_size == 0:
            raise BuildEntryPointError(f"required Fullmag output is empty: {relative}")
    marker = output / "launcher-build-mode"
    try:
        observed = marker.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError) as error:
        raise BuildEntryPointError("cannot read Fullmag launcher build marker") from error
    expected = EXPECTED_BUILD_MARKER[profile.name]
    if observed != expected:
        raise BuildEntryPointError(
            f"unexpected Fullmag launcher build mode: expected {expected}, got {observed}"
        )


def _validate_slepc_modal_outputs(output: Path, profile: Profile) -> None:
    """Require the headless native FEM runtime used by the modal contract."""

    _validate_required_outputs(
        output,
        profile,
        required_outputs=HEADLESS_REQUIRED_OUTPUTS,
    )
    library_directory = output / "lib"
    if library_directory.is_symlink() or not library_directory.is_dir():
        raise BuildEntryPointError("SLEPc modal runtime library directory is missing")
    libraries = tuple(
        path
        for path in library_directory.iterdir()
        if path.name.startswith("libfullmag_fem.so") and path.is_file()
    )
    if not libraries:
        raise BuildEntryPointError(
            "SLEPc modal runtime is missing a regular libfullmag_fem.so library"
        )

def _within(path: Path, roots: tuple[Path, ...]) -> bool:
    return any(path == root or root in path.parents for root in roots)


def _validate_internal_output_links(output: Path) -> None:
    """Permit only symlinks resolving into the selected output trees."""

    directory_roots: list[Path] = []
    for name in ("bin", "lib", "web"):
        candidate = output / name
        if candidate.is_symlink():
            raise BuildEntryPointError(f"selected output directory must not be a symlink: {candidate}")
        if candidate.exists():
            if not candidate.is_dir():
                raise BuildEntryPointError(f"selected output is not a directory: {candidate}")
            try:
                directory_roots.append(candidate.resolve(strict=True))
            except (OSError, RuntimeError) as error:
                raise BuildEntryPointError(f"cannot resolve selected output: {candidate}") from error
    file_roots: list[Path] = []
    for name in ("_fullmag_core.so", "launcher-build-mode"):
        candidate = output / name
        if candidate.exists() and not candidate.is_symlink():
            try:
                file_roots.append(candidate.resolve(strict=True))
            except (OSError, RuntimeError) as error:
                raise BuildEntryPointError(f"cannot resolve selected output: {candidate}") from error
    allowed = tuple(directory_roots + file_roots)
    for name in ("bin", "lib", "web"):
        root = output / name
        if not root.exists():
            continue
        for current, directories, files in os.walk(root, followlinks=False):
            current_path = Path(current)
            for name in (*directories, *files):
                candidate = current_path / name
                if not candidate.is_symlink():
                    continue
                try:
                    target = candidate.resolve(strict=True)
                except (OSError, RuntimeError) as error:
                    raise BuildEntryPointError(
                        f"cannot resolve selected output symlink: {candidate}"
                    ) from error
                if target in candidate.parents:
                    raise BuildEntryPointError(
                        f"selected output symlink creates a directory cycle: {candidate}"
                    )
                if not _within(target, allowed):
                    raise BuildEntryPointError(
                        f"selected output symlink escapes output trees: {candidate}"
                    )
    for candidate in (output / "_fullmag_core.so", output / "launcher-build-mode"):
        if not candidate.is_symlink():
            continue
        try:
            target = candidate.resolve(strict=True)
        except (OSError, RuntimeError) as error:
            raise BuildEntryPointError(
                f"cannot resolve selected output symlink: {candidate}"
            ) from error
        if not _within(target, allowed):
            raise BuildEntryPointError(
                f"selected output symlink escapes output trees: {candidate}"
            )


def _copy_outputs(workspace: Path, artifacts: Path) -> None:
    """Copy only runtime outputs, dereferencing links within those outputs."""

    output = workspace / ".fullmag" / "local"
    if not output.exists():
        return
    _validate_internal_output_links(output)
    destination = artifacts / "outputs" / ".fullmag" / "local"
    if destination.exists() or destination.is_symlink():
        raise BuildEntryPointError("refusing to replace existing Fullmag output artifacts")
    selected = ("bin", "lib", "_fullmag_core.so", "launcher-build-mode", "web")
    try:
        destination.mkdir(parents=True, exist_ok=False)
        for name in selected:
            source = output / name
            if not source.exists():
                continue
            target = destination / name
            if source.is_dir():
                shutil.copytree(source, target, symlinks=False, copy_function=shutil.copy2)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target, follow_symlinks=True)
    except OSError as error:
        raise BuildEntryPointError("cannot copy Fullmag runtime outputs to artifacts") from error


def _write_source_identity_artifact(artifacts: Path, identity: Mapping[str, Any]) -> None:
    """Publish the exact source identity alongside the modal runtime bundle."""

    target = artifacts / "source-identity.json"
    try:
        with target.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(identity, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError as error:
        raise BuildEntryPointError("refusing to replace source identity artifact") from error
    except OSError as error:
        raise BuildEntryPointError("cannot publish source identity artifact") from error


def _write_json_artifact(artifacts: Path, name: str, payload: Mapping[str, Any]) -> None:
    target = artifacts / name
    try:
        with target.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError as error:
        raise BuildEntryPointError(f"refusing to replace runtime attestation: {name}") from error
    except OSError as error:
        raise BuildEntryPointError(f"cannot publish runtime attestation: {name}") from error


def validate_native_source_snapshot(diagnostics: object, expected: object) -> str:
    """Reject unbound or stale native code, independently of Rust/cache stamps."""
    if not isinstance(expected, str) or not SHA256_RE.fullmatch(expected):
        raise BuildEntryPointError("expected native source snapshot is not lowercase SHA-256")
    if isinstance(diagnostics, str):
        try:
            diagnostics = json.loads(diagnostics)
        except (ValueError, TypeError) as error:
            raise BuildEntryPointError("native source diagnostics are not valid JSON") from error
    actual = diagnostics.get("native_source_snapshot_sha256") if isinstance(diagnostics, dict) else None
    if not isinstance(actual, str) or not SHA256_RE.fullmatch(actual):
        raise BuildEntryPointError("native library has no valid source snapshot binding")
    if actual != expected:
        raise BuildEntryPointError("native library source snapshot does not match capsule identity")
    return actual


_MFEM_VERSION_RE = re.compile(
    r"\A\s*(\d+)\.(\d+)(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?\s*\Z"
)
_MFEM_HEADER_COMPONENT_RE = re.compile(
    r"(?m)^\s*#\s*define\s+MFEM_VERSION_(MAJOR|MINOR|PATCH)\s+(\d+)\s*$"
)
_MFEM_HEADER_NUMBER_RE = re.compile(
    r"(?m)^\s*#\s*define\s+MFEM_VERSION\s+(\d+)\s*$"
)
_MFEM_HEADER_STRING_RE = re.compile(
    r'(?m)^\s*#\s*define\s+MFEM_VERSION(?:_STRING)?\s+"([^"]+)"\s*$'
)
_MFEM_HEADER_INCLUDE_RE = re.compile(
    r'(?m)^\s*#\s*include\s+"([^"]+)"\s*$'
)
_MFEM_CMAKE_VERSION_RE = re.compile(
    r"(?im)^\s*set\s*\(\s*(?:PACKAGE_VERSION|MFEM_VERSION)\s+\"?([^\"\s\)]+)\"?\s*\)"
)


def _parse_mfem_version(value: object, label: str) -> tuple[int, int, int | None]:
    if not isinstance(value, str):
        raise BuildEntryPointError(f"{label} MFEM version is missing")
    match = _MFEM_VERSION_RE.fullmatch(value)
    if match is None:
        raise BuildEntryPointError(f"{label} MFEM version is invalid: {value!r}")
    major, minor, patch = match.groups()
    return int(major), int(minor), int(patch) if patch is not None else None


def _version_text(version: tuple[int, int, int | None]) -> str:
    major, minor, patch = version
    return f"{major}.{minor}" if patch is None else f"{major}.{minor}.{patch}"


def _read_mfem_attestation_file(path: Path, label: str) -> str:
    try:
        if path.is_symlink() or not path.is_file():
            raise BuildEntryPointError(f"{label} is not a regular file: {path}")
        if path.stat().st_size > 1024 * 1024:
            raise BuildEntryPointError(f"{label} is unexpectedly large: {path}")
        return path.read_text(encoding="utf-8", errors="replace")
    except BuildEntryPointError:
        raise
    except OSError as error:
        raise BuildEntryPointError(f"cannot read {label}: {path}") from error


def _header_mfem_version(path: Path) -> str:
    text = _read_mfem_attestation_file(path, "MFEM installed header")
    sources: list[tuple[Path, str]] = [(path, text)]
    for include_name in _MFEM_HEADER_INCLUDE_RE.findall(text):
        included_path = path.parent / include_name
        if included_path.is_symlink():
            raise BuildEntryPointError("MFEM generated version header is a symlink")
        include_path = included_path.resolve()
        if not include_path.is_relative_to(path.parent.resolve()):
            raise BuildEntryPointError("MFEM installed header includes a path outside its directory")
        if include_path == path:
            raise BuildEntryPointError("MFEM installed header includes itself")
        sources.append(
            (
                include_path,
                _read_mfem_attestation_file(include_path, "MFEM generated version header"),
            )
        )
    combined_text = "\n".join(source_text for _, source_text in sources)
    components: dict[str, int] = {}
    for name, value in _MFEM_HEADER_COMPONENT_RE.findall(combined_text):
        parsed = int(value)
        if name in components and components[name] != parsed:
            raise BuildEntryPointError(f"MFEM installed header has conflicting {name} values")
        components[name] = parsed
    observed_versions: list[tuple[int, int, int | None]] = []
    if "MAJOR" in components and "MINOR" in components:
        observed_versions.append(
            (components["MAJOR"], components["MINOR"], components.get("PATCH"))
        )
    encoded_values = [int(value) for value in _MFEM_HEADER_NUMBER_RE.findall(combined_text)]
    if encoded_values and len(set(encoded_values)) != 1:
        raise BuildEntryPointError("MFEM installed header has conflicting MFEM_VERSION values")
    if encoded_values:
        encoded = encoded_values[0]
        observed_versions.append((encoded // 10000, (encoded // 100) % 100, encoded % 100))
    string_values = _MFEM_HEADER_STRING_RE.findall(combined_text)
    for value in string_values:
        observed_versions.append(_parse_mfem_version(value, "MFEM installed header"))
    if not observed_versions:
        raise BuildEntryPointError("MFEM installed header does not expose a version")
    major_minor = {version[:2] for version in observed_versions}
    patches = {version[2] for version in observed_versions if version[2] is not None}
    if len(major_minor) != 1 or len(patches) > 1:
        detail = ", ".join(_version_text(version) for version in observed_versions)
        raise BuildEntryPointError(f"MFEM installed header version sources disagree: {detail}")
    major, minor = next(iter(major_minor))
    patch = next(iter(patches), None)
    return _version_text((major, minor, patch))


def _cmake_mfem_version(path: Path) -> str:
    text = _read_mfem_attestation_file(path, "MFEM CMake version file")
    match = _MFEM_CMAKE_VERSION_RE.search(text)
    if match is None:
        raise BuildEntryPointError("MFEM CMake package does not expose a version")
    value = match.group(1)
    _parse_mfem_version(value, "MFEM CMake package")
    return value


def _observe_mfem_abi(
    mfem_abi: Mapping[str, Any],
    mfem_cmake_dir: str,
    loaded_version: str,
    *,
    prefix: Path,
) -> dict[str, Any]:
    """Bind MFEM ABI bytes to installed metadata and the loaded native library.

    The version is deliberately measured from the installed header, the CMake
    package and the loaded Fullmag FEM library.  Image tags and environment
    declarations are not inputs to this attestation.
    """

    if not isinstance(mfem_abi, Mapping):
        raise BuildEntryPointError("MFEM ABI attestation is missing")
    try:
        resolved_prefix = prefix.resolve(strict=True)
        resolved_cmake_dir = Path(mfem_cmake_dir).resolve(strict=True)
        resolved_library = Path(str(mfem_abi.get("path"))).resolve(strict=True)
    except (OSError, TypeError, ValueError) as error:
        raise BuildEntryPointError("MFEM ABI attestation paths are invalid") from error
    if not resolved_cmake_dir.is_relative_to(resolved_prefix):
        raise BuildEntryPointError("MFEM CMake package resolved outside the selected prefix")
    if not resolved_library.is_relative_to(resolved_prefix / "lib"):
        raise BuildEntryPointError("MFEM ABI library resolved outside the selected prefix")
    version_file = resolved_cmake_dir / "MFEMConfigVersion.cmake"
    if not version_file.is_file():
        version_file = resolved_cmake_dir / "mfem-config-version.cmake"
    header_path = resolved_prefix / "include" / "mfem" / "config" / "config.hpp"
    header_version = _header_mfem_version(header_path)
    cmake_version = _cmake_mfem_version(version_file)
    loaded_version = str(loaded_version)
    _parse_mfem_version(loaded_version, "loaded MFEM library")
    versions = {
        "header": (header_version, _parse_mfem_version(header_version, "MFEM installed header")),
        "cmake": (cmake_version, _parse_mfem_version(cmake_version, "MFEM CMake package")),
        "loaded_library": (loaded_version, _parse_mfem_version(loaded_version, "loaded MFEM library")),
    }
    major_minor = {value[1][:2] for value in versions.values()}
    patches = {value[1][2] for value in versions.values() if value[1][2] is not None}
    if len(major_minor) != 1 or len(patches) > 1:
        detail = ", ".join(f"{name}={value[0]}" for name, value in versions.items())
        raise BuildEntryPointError(f"MFEM version mismatch: {detail}")
    _, canonical_components = versions["loaded_library"]
    observed = dict(mfem_abi)
    _, library_sha256 = sha256_file(resolved_library)
    if observed.get("sha256") != library_sha256:
        raise BuildEntryPointError("MFEM ABI library changed during version attestation")
    observed["path"] = str(resolved_library)
    observed["sha256"] = library_sha256
    observed["version"] = _version_text((canonical_components[0], canonical_components[1], None))
    observed["version_sources"] = {
        "header": {"path": str(header_path), "version": header_version},
        "cmake": {"path": str(version_file), "version": cmake_version},
        "loaded_library": {"path": str(resolved_library), "version": loaded_version},
    }
    return observed


def _loaded_mfem_version(library: Any, c_text: Any) -> str:
    class RuntimeBuildInfoV2(ctypes.Structure):
        _fields_ = [
            ("abi_version", ctypes.c_uint32),
            ("struct_size", ctypes.c_uint32),
            ("mfem_version", ctypes.c_char * 32),
            ("hypre_version", ctypes.c_char * 32),
        ]

    try:
        query = library.fullmag_fem_get_runtime_build_info_v2
        query.argtypes = [ctypes.POINTER(RuntimeBuildInfoV2)]
        query.restype = ctypes.c_int
        info = RuntimeBuildInfoV2()
        return_code = int(query(ctypes.byref(info)))
    except (AttributeError, OSError) as error:
        raise BuildEntryPointError(
            f"MFEM runtime version query is unavailable: {error}"
        ) from error
    if return_code != 0 or info.abi_version != 2 or info.struct_size != ctypes.sizeof(info):
        raise BuildEntryPointError("MFEM runtime version query did not attest ABI v2")
    value = c_text(info.mfem_version)
    _parse_mfem_version(value, "loaded MFEM library")
    return value


_LEGACY_RUNTIME_STARTUP_STAMP_RE = re.compile(
    r"^\[fullmag\] build: (?P<build>\S(?:[^|\r\n]*\S)?) \| "
    r"source snapshot: (?P<snapshot>[a-f0-9]{64})$"
)
_LEGACY_IDENTITY_RUNTIME_STARTUP_STAMP_RE = re.compile(
    r"^\[fullmag\] build: "
    r"(?P<build_timestamp>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) \| "
    r"commit: (?P<commit>[a-f0-9]{40}) \| (?P<state>clean|dirty|unknown) \| "
    r"source snapshot: (?P<snapshot>[a-f0-9]{64})$"
)
_VERSION_RUNTIME_STARTUP_STAMP_RE = re.compile(
    r"^\[fullmag\] version: (?P<version>[^|\s\r\n]+) \| "
    r"build: (?P<build>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) \| "
    r"commit: (?P<commit>[a-f0-9]{40}) \| (?P<state>clean|dirty|unknown) \| "
    r"source snapshot: (?P<snapshot>[a-f0-9]{64})$"
)


def _validate_runtime_startup_stamp(stderr: object, expected_snapshot: object) -> str:
    """Require one producer-shaped runtime stamp bound to the requested source."""

    if not isinstance(stderr, str):
        raise BuildEntryPointError("runtime probe startup stamp is malformed")
    candidates = [
        line
        for line in stderr.splitlines()
        if line.startswith(("[fullmag] build:", "[fullmag] version:"))
    ]
    if not candidates:
        raise BuildEntryPointError("runtime probe startup stamp lacks source snapshot identity")
    if len(candidates) != 1:
        raise BuildEntryPointError("runtime probe startup stamp is ambiguous")

    startup_stamp = candidates[0]
    match = _LEGACY_RUNTIME_STARTUP_STAMP_RE.fullmatch(startup_stamp)
    if match is None:
        match = _LEGACY_IDENTITY_RUNTIME_STARTUP_STAMP_RE.fullmatch(startup_stamp)
    if match is None:
        match = _VERSION_RUNTIME_STARTUP_STAMP_RE.fullmatch(startup_stamp)
    if match is None:
        raise BuildEntryPointError("runtime probe startup stamp is malformed")
    timestamp = match.groupdict().get("build_timestamp")
    if "version" in match.groupdict():
        timestamp = match.group("build")
    if timestamp is not None:
        try:
            datetime.strptime(timestamp, "%Y-%m-%dT%H:%M:%SZ")
        except ValueError as error:
            raise BuildEntryPointError("runtime probe startup stamp is malformed") from error

    stamped_snapshot = match.group("snapshot")
    if (
        not isinstance(expected_snapshot, str)
        or not SHA256_RE.fullmatch(expected_snapshot)
        or stamped_snapshot != expected_snapshot
    ):
        raise BuildEntryPointError(
            "runtime probe startup stamp source snapshot does not match the native source identity"
        )
    return startup_stamp


def _attest_slepc_runtime(
    workspace: Path,
    artifacts: Path,
    environment: Mapping[str, str],
    native_identity: Mapping[str, Any],
    runtime_contract: Mapping[str, Any],
) -> None:
    if runtime_contract.get("schema") != "fullmag.fem.cpu.slepc_runtime_contract.v2":
        return _attest_slepc_runtime_in_process(
            workspace, artifacts, environment, native_identity, runtime_contract
        )
    # glibc captures LD_LIBRARY_PATH at process startup. A later os.environ
    # assignment cannot make the image-owned CPU stack visible to ctypes.
    child_environment = dict(environment)
    library_paths = [str(workspace / ".fullmag" / "local" / "lib")]
    if child_environment.get("LD_LIBRARY_PATH"):
        library_paths.append(child_environment["LD_LIBRARY_PATH"])
    child_environment["LD_LIBRARY_PATH"] = os.pathsep.join(library_paths)
    payload = {
        "workspace": str(workspace), "artifacts": str(artifacts),
        "native_identity": native_identity, "runtime_contract": runtime_contract,
    }
    command = [sys.executable, str(Path(__file__).resolve()), "--attest-slepc-runtime"]
    try:
        result = subprocess.run(
            command, cwd=str(workspace), env=child_environment, input=json.dumps(payload),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False,
            timeout=SLEPC_PROBE_TIMEOUT_SECONDS + 120,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        for name in ("stdout", "stderr"):
            data, _, _ = _bounded_probe_output(getattr(error, name, None))
            _write_probe_log(artifacts / "logs" / f"slepc-runtime-attestation.{name}.log", data)
        raise BuildEntryPointError(f"SLEPc runtime attestation subprocess unavailable: {error}") from error
    for name, output in (("stdout", result.stdout), ("stderr", result.stderr)):
        data, _, _ = _bounded_probe_output(output)
        _write_probe_log(artifacts / "logs" / f"slepc-runtime-attestation.{name}.log", data)
    if result.returncode != 0:
        details = (result.stderr or "").strip()[-MAX_ERROR_LENGTH:]
        raise BuildEntryPointError(
            f"SLEPc runtime attestation subprocess exited {result.returncode}: {details}"
        )


def _attest_slepc_runtime_in_process(
    workspace: Path,
    artifacts: Path,
    environment: Mapping[str, str],
    native_identity: Mapping[str, Any],
    runtime_contract: Mapping[str, Any],
) -> None:
    """Run production-only probes against the built CPU/SLEPc runtime.

    This is deliberately a post-build probe, not a CTest or contract-target
    stage.  It records the binary availability response and the dependency
    query exported by ``libfullmag_fem`` so the receipt cannot infer SLEPc
    support from the requested environment alone.
    """

    expected_cmake_options = runtime_contract.get("cmake_options")
    if not isinstance(expected_cmake_options, Mapping):
        raise BuildEntryPointError("SLEPc runtime contract lacks CMake options")
    cargo_target_text = environment.get("FULLMAG_CARGO_TARGET_DIR")
    if not cargo_target_text:
        raise BuildEntryPointError("SLEPc runtime probe lacks the Cargo target root")
    cargo_target = Path(cargo_target_text)
    output = workspace / ".fullmag" / "local"
    runtime_bin = output / "bin" / "fullmag-bin"
    library_directory = output / "lib"
    libraries = tuple(
        sorted(
            path
            for path in library_directory.iterdir()
            if path.name.startswith("libfullmag_fem.so")
            and path.is_file()
            and not path.is_symlink()
        )
    ) if library_directory.is_dir() else ()
    if not runtime_bin.is_file() or not os.access(runtime_bin, os.X_OK):
        raise BuildEntryPointError("SLEPc runtime probe requires an executable fullmag-bin")
    if not libraries:
        raise BuildEntryPointError("SLEPc runtime probe requires libfullmag_fem.so")
    runtime_library = libraries[0]
    _, runtime_library_sha256 = sha256_file(runtime_library)

    cache_candidates = tuple(
        sorted(
            (
                path
                for path in cargo_target.glob(
                    "release/build/fullmag-fem-sys*/**/out/native-build/CMakeCache.txt"
                )
                if path.is_file() and not path.is_symlink()
            ),
            # mtime is only a deterministic tie-breaker. The cache is accepted
            # below only when its corresponding native library has identical
            # bytes to the runtime library copied to the output bundle.
            key=lambda path: path.stat().st_mtime_ns,
            reverse=True,
        )
    )
    if not cache_candidates:
        raise BuildEntryPointError("SLEPc runtime build did not retain a CMake cache")
    bound_cache: tuple[Path, Path, str] | None = None
    for candidate in cache_candidates:
        native_library_directory = candidate.parent / "backends" / "fem"
        native_libraries = tuple(
            sorted(
                path
                for path in native_library_directory.glob("libfullmag_fem.so*")
                if path.is_file() and not path.is_symlink()
            )
        )
        for native_library in native_libraries:
            _, native_library_sha256 = sha256_file(native_library)
            if native_library_sha256 == runtime_library_sha256:
                bound_cache = (candidate, native_library, native_library_sha256)
                break
        if bound_cache is not None:
            break
    if bound_cache is None:
        raise BuildEntryPointError(
            "SLEPc runtime CMake cache is not bound to the runtime FEM library"
        )
    cache_path, native_library, native_library_sha256 = bound_cache
    observed_cmake_options: dict[str, dict[str, str]] = {}
    mfem_cmake_dir: str | None = None
    try:
        cache_lines = cache_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError as error:
        raise BuildEntryPointError("cannot read SLEPc runtime CMake cache") from error
    for line in cache_lines:
        if not line or line.startswith("//") or line.startswith("#") or ":" not in line or "=" not in line:
            continue
        name, remainder = line.split(":", 1)
        value_type, value = remainder.split("=", 1)
        if name in expected_cmake_options:
            observed_cmake_options[name] = {
                "type": value_type,
                "value": value,
            }
        if name == "MFEM_DIR":
            mfem_cmake_dir = value
    missing_options = sorted(set(expected_cmake_options) - set(observed_cmake_options))
    if missing_options:
        raise BuildEntryPointError(
            "SLEPc runtime CMake cache is missing: " + ", ".join(missing_options)
        )
    wrong_options = [
        name
        for name, expected in expected_cmake_options.items()
        if observed_cmake_options[name]["value"].upper() != str(expected).upper()
    ]
    if wrong_options:
        details = ", ".join(
            f"{name}={observed_cmake_options[name]['value']}"
            for name in wrong_options
        )
        raise BuildEntryPointError(
            "SLEPc runtime CMake options do not match the profile: " + details
        )

    probe_environment = dict(environment)
    probe_environment["FULLMAG_REPO_ROOT"] = str(workspace)
    cpu_abi_profile = (
        runtime_contract.get("schema") == "fullmag.fem.cpu.slepc_runtime_contract.v2"
    )
    if cpu_abi_profile and (
        mfem_cmake_dir is None
        or not Path(mfem_cmake_dir).resolve(strict=True).is_relative_to(
            Path("/opt/fullmag-mfem-cpu").resolve(strict=True)
        )
    ):
        raise BuildEntryPointError("MFEM CMake package did not resolve to CPU prefix")
    compatibility_paths, preloaded_compatibility_libraries = _modal_driver_compatibility(
        cpu_abi_profile
    )
    library_paths = [str(library_directory), *compatibility_paths]
    existing_library_path = probe_environment.get("LD_LIBRARY_PATH")
    if existing_library_path:
        library_paths.append(existing_library_path)
    probe_environment["LD_LIBRARY_PATH"] = os.pathsep.join(library_paths)
    mfem_abi: dict[str, Any] | None = None
    cpu_dependency_abi: dict[str, dict[str, str]] | None = None
    if cpu_abi_profile:
        try:
            linkage = subprocess.run(
                ["ldd", str(runtime_library)],
                env=probe_environment,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
                timeout=30,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise BuildEntryPointError(f"MFEM CPU linkage probe failed: {error}") from error
        if linkage.returncode != 0:
            raise BuildEntryPointError("MFEM CPU linkage probe did not complete")
        cpu_dependency_abi = observe_cpu_modal_linkage(
            linkage.stdout, Path("/opt/fullmag-mfem-cpu")
        )
        mfem_abi = cpu_dependency_abi["mfem"]
    probe_command = [str(runtime_bin), "runtime", "fem-availability", "--json"]
    probe_started_at = _utc_now()
    try:
        probe = subprocess.run(
            probe_command,
            cwd=str(workspace),
            env=probe_environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
            timeout=SLEPC_PROBE_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        _write_slepc_probe_evidence(
            artifacts,
            status="timeout",
            return_code=None,
            stdout=getattr(error, "stdout", None),
            stderr=getattr(error, "stderr", None),
            error=error,
            started_at=probe_started_at,
            finished_at=_utc_now(),
        )
        raise BuildEntryPointError(
            f"SLEPc runtime availability probe timed out after {SLEPC_PROBE_TIMEOUT_SECONDS}s"
        ) from error
    except OSError as error:
        _write_slepc_probe_evidence(
            artifacts,
            status="unavailable",
            return_code=None,
            stdout=None,
            stderr=None,
            error=error,
            started_at=probe_started_at,
            finished_at=_utc_now(),
        )
        raise BuildEntryPointError(f"SLEPc runtime availability probe unavailable: {error}") from error
    _write_slepc_probe_evidence(
        artifacts,
        status="exited_zero" if probe.returncode == 0 else "nonzero",
        return_code=probe.returncode,
        stdout=getattr(probe, "stdout", None),
        stderr=getattr(probe, "stderr", None),
        error=None,
        started_at=probe_started_at,
        finished_at=_utc_now(),
    )
    if probe.returncode != 0:
        stderr = (probe.stderr or "").strip()[-1024:]
        raise BuildEntryPointError(
            f"SLEPc runtime availability probe exited {probe.returncode}: {stderr}"
        )
    try:
        availability = json.loads(probe.stdout or "")
    except (UnicodeError, json.JSONDecodeError) as error:
        raise BuildEntryPointError("SLEPc runtime availability probe returned invalid JSON") from error
    if not isinstance(availability, dict) or availability.get("native_fem_cpu_available") is not True:
        raise BuildEntryPointError("runtime probe did not attest native FEM CPU availability")
    startup_stamp = _validate_runtime_startup_stamp(
        probe.stderr or "", native_identity.get("source_snapshot_sha256")
    )

    class DependencyInfo(ctypes.Structure):
        _fields_ = [
            ("petsc_available", ctypes.c_int),
            ("slepc_available", ctypes.c_int),
            ("modal_eigen_native_cpu_slepc_available", ctypes.c_int),
            ("petsc_version", ctypes.c_char * 64),
            ("slepc_version", ctypes.c_char * 64),
            ("petsc_pkgconfig_dir", ctypes.c_char * 256),
            ("slepc_pkgconfig_dir", ctypes.c_char * 256),
            ("petsc_find_module_file", ctypes.c_char * 256),
            ("slepc_find_module_file", ctypes.c_char * 256),
            ("petsc_library_path", ctypes.c_char * 256),
            ("slepc_library_path", ctypes.c_char * 256),
            ("reason", ctypes.c_char * 256),
            ("diagnostics_json", ctypes.c_char * 1024),
        ]

    def c_text(value: object) -> str:
        return bytes(value).split(b"\0", 1)[0].decode("utf-8", "replace")

    previous_library_path = os.environ.get("LD_LIBRARY_PATH")
    os.environ["LD_LIBRARY_PATH"] = probe_environment["LD_LIBRARY_PATH"]
    loaded_mfem_version: str | None = None
    try:
        try:
            library = ctypes.CDLL(str(runtime_library))
            if cpu_abi_profile:
                loaded_mfem_version = _loaded_mfem_version(library, c_text)
            query = library.fullmag_fem_get_frequency_domain_dependency_info
            query.argtypes = [ctypes.POINTER(DependencyInfo)]
            query.restype = ctypes.c_int
            info = DependencyInfo()
            return_code = int(query(ctypes.byref(info)))
        except (AttributeError, OSError) as error:
            raise BuildEntryPointError(
                f"SLEPc runtime dependency query is unavailable: {error}"
            ) from error
    finally:
        if previous_library_path is None:
            os.environ.pop("LD_LIBRARY_PATH", None)
        else:
            os.environ["LD_LIBRARY_PATH"] = previous_library_path
    if cpu_abi_profile:
        if loaded_mfem_version is None or mfem_abi is None or mfem_cmake_dir is None:
            raise BuildEntryPointError("MFEM CPU version attestation is incomplete")
        mfem_abi = _observe_mfem_abi(
            mfem_abi,
            mfem_cmake_dir,
            loaded_mfem_version,
            prefix=Path("/opt/fullmag-mfem-cpu"),
        )
    if return_code != 0:
        raise BuildEntryPointError(
            f"SLEPc runtime dependency query exited {return_code}"
        )
    dependency = {
        "petsc_available": int(info.petsc_available) == 1,
        "slepc_available": int(info.slepc_available) == 1,
        "modal_eigen_native_cpu_slepc_available": (
            int(info.modal_eigen_native_cpu_slepc_available) == 1
        ),
        "petsc_version": c_text(info.petsc_version),
        "slepc_version": c_text(info.slepc_version),
        "petsc_pkgconfig_dir": c_text(info.petsc_pkgconfig_dir),
        "slepc_pkgconfig_dir": c_text(info.slepc_pkgconfig_dir),
        "petsc_find_module_file": c_text(info.petsc_find_module_file),
        "slepc_find_module_file": c_text(info.slepc_find_module_file),
        "petsc_library_path": c_text(info.petsc_library_path),
        "slepc_library_path": c_text(info.slepc_library_path),
        "reason": c_text(info.reason),
        "diagnostics_json": c_text(info.diagnostics_json),
    }
    if not all(
        (
            dependency["petsc_available"],
            dependency["slepc_available"],
            dependency["modal_eigen_native_cpu_slepc_available"],
            dependency["petsc_version"],
            dependency["slepc_version"],
        )
    ):
        raise BuildEntryPointError(
            "runtime FEM dependency query did not attest PETSc/SLEPc CPU modal support"
        )
    if cpu_abi_profile:
        assert cpu_dependency_abi is not None
        bind_cpu_modal_resolution(
            dependency, cpu_dependency_abi, Path("/opt/fullmag-mfem-cpu"), workspace
        )
    dependency["native_source_snapshot_sha256"] = validate_native_source_snapshot(
        dependency["diagnostics_json"], native_identity.get("source_snapshot_sha256")
    )
    source = {
        "commit": native_identity.get("head_commit_full"),
        "snapshot_sha256": native_identity.get("source_snapshot_sha256"),
    }
    _write_json_artifact(
        artifacts,
        "cmake-attestation.json",
        {
            "schema": "fullmag.fem.slepc_runtime.cmake_attestation.v1",
            "status": "pass",
            "cache_path": str(cache_path),
            "native_library_path": str(native_library),
            "runtime_library_sha256": runtime_library_sha256,
            "native_library_sha256": native_library_sha256,
            "options": observed_cmake_options,
            "mfem_abi": mfem_abi,
            "cpu_dependency_abi": cpu_dependency_abi,
            "mfem_cmake_dir": mfem_cmake_dir,
            "source": source,
        },
    )
    _write_json_artifact(
        artifacts,
        "runtime-attestation.json",
        {
            "schema": "fullmag.fem.slepc_runtime.attestation.v1",
            "status": "pass",
            "binary": "outputs/.fullmag/local/bin/fullmag-bin",
            "availability": availability,
            "startup_stamp": startup_stamp,
            "cuda_driver_compatibility_paths": list(compatibility_paths),
            "cuda_driver_compatibility_libraries_preloaded": list(
                preloaded_compatibility_libraries
            ),
            "source": source,
        },
    )
    _write_json_artifact(
        artifacts,
        "dependency-attestation.json",
        {
            "schema": "fullmag.fem.slepc_runtime.dependency_attestation.v1",
            "status": "pass",
            "library": "outputs/.fullmag/local/lib/" + runtime_library.name,
            "dependency": dependency,
            "source": source,
        },
    )


def artifact_records(artifacts: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for path in sorted(artifacts.rglob("*")):
        if path.name == "build-receipt.json":
            continue
        if path.is_symlink():
            raise BuildEntryPointError(f"artifact tree contains a symlink: {path}")
        if path.is_dir():
            continue
        relative = path.relative_to(artifacts).as_posix()
        size, digest = sha256_file(path)
        records.append({"path": relative, "size": size, "sha256": digest})
    return records


def _write_receipt(artifacts: Path, receipt: Mapping[str, Any]) -> None:
    target = artifacts / "build-receipt.json"
    try:
        with target.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(receipt, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError as error:
        raise BuildEntryPointError("refusing to replace existing build receipt") from error
    except OSError as error:
        raise BuildEntryPointError("cannot publish build receipt") from error


def _base_receipt(
    *,
    job_id: str,
    profile: Profile,
    source_digest: str,
    context: Mapping[str, Any] | None,
) -> dict[str, Any]:
    identity = context.get("native_source_identity") if context else None
    receipt: dict[str, Any] = {
        "schema": RECEIPT_SCHEMA,
        "job_id": job_id,
        "profile": profile.name,
        "lane": profile.lane,
        "source_digest": source_digest,
        "source_digest_kind": "capsule",
        "native_source_identity": identity,
        "native_source_identity_sha256": (
            hashlib.sha256(canonical(identity)).hexdigest() if identity is not None else None
        ),
        "image_digest": context.get("image_digest") if context else None,
        "qualification": "NOT VERIFIED",
        "state": "failed",
        "stages": [],
        "toolchain": {},
        "contract_scenarios": list(profile.contract_scenarios),
        "contract_schema": profile.contract_schema if profile.contract_scenarios else None,
        "runtime_only": profile.runtime_only,
        "runtime_contract": _runtime_contract(profile),
        "artifacts": [],
        "created_at": _utc_now(),
    }
    return receipt


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--source-digest", required=True)
    parser.add_argument("--profile", choices=tuple(PROFILES))
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--build", type=Path, required=True)
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--context", type=Path, default=Path("/runner/context.json"))
    parser.add_argument("--jobs", type=int, default=DEFAULT_JOBS)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    if arguments == ["--attest-slepc-runtime"]:
        # This internal command is selected only by the trusted entrypoint.
        # It runs the unchanged attestation gates with the loader environment
        # supplied at exec time, never a command supplied by a build request.
        try:
            payload = json.loads(sys.stdin.read(MAX_CONTEXT_BYTES + 1))
            if (not isinstance(payload, dict)
                    or set(payload) != {"workspace", "artifacts", "native_identity", "runtime_contract"}
                    or not isinstance(payload["workspace"], str)
                    or not isinstance(payload["artifacts"], str)
                    or not isinstance(payload["native_identity"], dict)
                    or not isinstance(payload["runtime_contract"], dict)
                    or payload["runtime_contract"].get("schema")
                    != "fullmag.fem.cpu.slepc_runtime_contract.v2"):
                raise BuildEntryPointError("invalid CPU runtime attestation input")
            _attest_slepc_runtime_in_process(
                Path(payload["workspace"]), Path(payload["artifacts"]), dict(os.environ),
                payload["native_identity"], payload["runtime_contract"],
            )
            return 0
        except (BuildEntryPointError, OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
            print(f"build-entrypoint: {_error_text(error)}", file=sys.stderr)
            return 2
    args = _parse_args(arguments)
    profile = profile_for(args.profile)
    job_id = _validate_job_id(args.job_id)
    source_digest = _validate_digest(args.source_digest, "source_digest")
    jobs = _validate_jobs(args.jobs)
    artifacts = _private_directory(args.artifacts, "artifacts", create=True)
    receipt = _base_receipt(
        job_id=job_id,
        profile=profile,
        source_digest=source_digest,
        context=None,
    )
    try:
        context = load_context(
            args.context,
            job_id=job_id,
            source_digest=source_digest,
            profile=profile.name,
        )
        receipt = _base_receipt(
            job_id=job_id,
            profile=profile,
            source_digest=source_digest,
            context=context,
        )
        source = _regular_directory(args.source, "source capsule")
        manifest = verify_source(source, source_digest)
        _check_capsule_has_no_git(manifest)
        if (
            context["native_source_identity"]["head_commit_full"]
            != manifest["resolved_commit"]
        ):
            raise BuildEntryPointError(
                "native source identity commit does not match the source capsule"
            )
        workspace = _regular_directory(args.workspace, "workspace", create=True)
        build = _regular_directory(args.build, "build", create=True)
        _workspace_is_empty(workspace)
        materialize_capsule(manifest, source, workspace)
        _regular_directory(build / "cargo-targets", "cargo target root", create=True)
        tools = preflight(
            profile,
            release=not bool(profile.contract_scenarios or profile.runtime_only),
        )
        environment = build_environment(
            profile,
            workspace=workspace,
            build=build,
            jobs=jobs,
            native_identity=context["native_source_identity"],
        )
        receipt["toolchain"] = toolchain_versions(tools)
        receipt["source"] = {
            "capsule_digest": source_digest,
            "resolved_commit": manifest["resolved_commit"],
            "file_count": len(manifest["files"]),
        }
        # All commands are selected by the trusted profile, never by job data.
        make = tools["make"]
        stages = [
            (
                "native-build",
                [make, "install-cli-dev"],
            ),
        ]
        if profile.contract_scenarios:
            environment["FULLMAG_FEM_CPU_BUILD_ROOT"] = str(build / "current-contracts")
            environment["FULLMAG_FEM_CPU_REPORT_ROOT"] = str(artifacts / "contracts")
            environment["FULLMAG_CURRENT_GPU_BUILD_ROOT"] = str(build / "current-gpu-contracts")
            environment["FULLMAG_CURRENT_GPU_REPORT_ROOT"] = str(artifacts / "contracts")
            environment["FULLMAG_FEM_SLEPC_MODAL_BUILD_ROOT"] = str(build / "fem-slepc-modal")
            environment["FULLMAG_FEM_SLEPC_MODAL_REPORT_ROOT"] = str(artifacts / "contracts")
            contract_stages = [
                (
                    f"contract-{scenario}",
                    [tools["bash"], profile.contract_script, scenario],
                )
                for scenario in profile.contract_scenarios
            ]
            stages = ([*stages, *contract_stages] if profile.build_runtime else contract_stages)
        elif not profile.runtime_only:
            pnpm = _pnpm_command(tools)
            stages.extend(
                [
                    (
                        "frontend-dependencies",
                        [*pnpm, "install", "--dir", "apps/control-room", "--frozen-lockfile"],
                    ),
                    (
                        "frontend-build",
                        [make, "web-build-static"],
                    ),
                ]
            )
        for name, command in stages:
            stage = run_stage(
                name,
                command,
                workspace=workspace,
                artifacts=artifacts,
                environment=environment,
            )
            receipt["stages"].append(stage)
            if stage["exit_code"] != 0:
                raise BuildEntryPointError(
                    f"managed stage failed: {name} (exit={stage['exit_code']})"
                )
        if profile.contract_scenarios:
            for scenario in profile.contract_scenarios:
                result_path = artifacts / "contracts" / scenario / "result.json"
                if result_path.is_symlink() or not result_path.is_file():
                    raise BuildEntryPointError(f"missing contract receipt: {scenario}")
                try:
                    result = json.loads(result_path.read_text(encoding="utf-8"))
                except (OSError, UnicodeError, json.JSONDecodeError) as error:
                    raise BuildEntryPointError(
                        f"invalid contract receipt JSON: {scenario}"
                    ) from error
                if not isinstance(result, Mapping) or (
                    result.get("schema") != profile.contract_schema
                    or result.get("scenario") != scenario
                    or result.get("status") != "pass"
                ):
                    raise BuildEntryPointError(
                        f"invalid or failing contract receipt: {scenario}"
                    )
                if scenario == "slepc-modal":
                    attestations = result.get("attestation")
                    dependency = attestations.get("dependency") if isinstance(attestations, dict) else None
                    values = dependency.get("dependency") if isinstance(dependency, dict) else None
                    validate_native_source_snapshot(
                        values.get("diagnostics") if isinstance(values, dict) else None,
                        context["native_source_identity"]["source_snapshot_sha256"],
                    )
            if profile.build_runtime:
                output = workspace / ".fullmag" / "local"
                _validate_slepc_modal_outputs(output, profile)
                _copy_outputs(workspace, artifacts)
                _write_source_identity_artifact(
                    artifacts,
                    context["native_source_identity"],
                )
        elif profile.runtime_only:
            output = workspace / ".fullmag" / "local"
            _validate_slepc_modal_outputs(output, profile)
            _attest_slepc_runtime(
                workspace,
                artifacts,
                environment,
                context["native_source_identity"],
                _runtime_contract(profile) or {},
            )
            _copy_outputs(workspace, artifacts)
            _write_source_identity_artifact(
                artifacts,
                context["native_source_identity"],
            )
        else:
            output = workspace / ".fullmag" / "local"
            _validate_required_outputs(output, profile)
            _copy_outputs(workspace, artifacts)
        receipt["artifacts"] = artifact_records(artifacts)
        receipt["state"] = "succeeded"
        receipt["finished_at"] = _utc_now()
        _write_receipt(artifacts, receipt)
        print(json.dumps(receipt, ensure_ascii=False, sort_keys=True))
        return 0
    except (BuildEntryPointError, OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
        receipt["error"] = _error_text(error)
        receipt["finished_at"] = _utc_now()
        try:
            receipt["artifacts"] = artifact_records(artifacts)
            _write_receipt(artifacts, receipt)
        except BuildEntryPointError as publish_error:
            print(f"build-entrypoint: {_error_text(publish_error)}", file=sys.stderr)
        print(f"build-entrypoint: {_error_text(error)}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
