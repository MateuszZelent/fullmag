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
COMMIT_RE = re.compile(r"[a-f0-9]{40}\Z")
IMAGE_RE = re.compile(r"sha256:[a-f0-9]{64}\Z")
STAGE_RE = re.compile(r"[a-z0-9][a-z0-9_.-]{0,63}\Z")

DEFAULT_JOBS = 2
MAX_JOBS = 64
MAX_CONTEXT_BYTES = 4 * 1024 * 1024
MAX_ERROR_LENGTH = 4096
ALLOWED_WORKSPACE_MOUNTPOINTS = frozenset(
    {".fullmag-build", ".fullmag-cargo", ".fullmag-rustup"}
)


class BuildEntryPointError(ValueError):
    """A fail-closed build-entrypoint contract or execution error."""


@dataclass(frozen=True)
class Profile:
    name: str
    lane: str
    environment: Mapping[str, str]
    needs_cuda_toolchain: bool = False


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

REQUIRED_OUTPUTS = (
    "bin/fullmag-bin",
    "bin/fullmag-api",
    "_fullmag_core.so",
    "launcher-build-mode",
    "web/index.html",
)
EXPECTED_BUILD_MARKER = {
    "fem-cpu-release": "fem-cpu",
    "fem-gpu-release": "cuda-fem-gpu",
    "fdm-cpu-release": "cpu",
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
                shutil.copytree(child, destination, copy_function=shutil.copy2)
                # Only the private copy is writable. Never recurse into the
                # persistent mountpoints or change the readonly capsule.
                for current, _, _ in os.walk(destination, followlinks=False):
                    _private_directory(Path(current), 'materialized source directory')
            elif child.is_file():
                shutil.copy2(child, destination)
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
    environment = {str(key): str(value) for key, value in os.environ.items()}
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


def _require_tool(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise BuildEntryPointError(f"required build tool is unavailable: {name}")
    return path


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
            [tools["rustup"], "toolchain", "list"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise BuildEntryPointError(
            f"cannot inspect installed Rust toolchains: {_error_text(error)}"
        ) from error
    installed_toolchains = rustup_result.stdout or ""
    if rustup_result.returncode != 0 or not any(
        line.strip().split()[0].startswith("nightly")
        for line in installed_toolchains.splitlines()
        if line.strip()
    ):
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
    if profile.needs_cuda_toolchain:
        tools["cmake"] = _require_tool("cmake")
        tools["nvcc"] = _require_tool("nvcc")
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
        ("rustc", [tools["rustc"], "--version"]),
        ("cargo", [tools["cargo"], "--version"]),
        ("rustup", [tools["rustup"], "--version"]),
        ("make", [tools["make"], "--version"]),
    ):
        versions[name] = _command_version(command)
    if "pnpm" in tools:
        versions["pnpm"] = _command_version([tools["pnpm"], "--version"])
    elif "corepack" in tools:
        versions["corepack"] = _command_version([tools["corepack"], "pnpm", "--version"])
    if "cmake" in tools:
        versions["cmake"] = _command_version([tools["cmake"], "--version"])
    if "nvcc" in tools:
        versions["nvcc"] = _command_version([tools["nvcc"], "--version"])
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


def _required_output_paths(output: Path) -> tuple[Path, ...]:
    return tuple(output.joinpath(*relative.split("/")) for relative in REQUIRED_OUTPUTS)


def _validate_required_outputs(output: Path, profile: Profile) -> None:
    if not output.exists():
        raise BuildEntryPointError(f"required Fullmag output is missing: {REQUIRED_OUTPUTS[0]}")
    if output.is_symlink() or not output.is_dir():
        raise BuildEntryPointError("Fullmag output directory is not a regular directory")
    for relative, path in zip(REQUIRED_OUTPUTS, _required_output_paths(output)):
        if path.is_symlink() or not path.is_file():
            raise BuildEntryPointError(f"required Fullmag output is missing: {relative}")
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
    args = _parse_args(argv)
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
        tools = preflight(profile, release=True)
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
        # The first stage is the only native build entrypoint admitted here.
        make = tools["make"]
        stages = [
            (
                "native-build",
                [make, "install-cli-dev"],
            ),
        ]
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
