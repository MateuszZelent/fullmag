#!/usr/bin/env python3
"""Run fixed, plain-Rust Fullmag package verification routes.

This entrypoint is deliberately separate from the generic storage shell. The
supported package routes do not need compatibility links, a FEM image, or the
generic heavy-build lease. The resolver still owns every mutable path and the
per-worktree lock. No caller-supplied Cargo command is accepted.
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
import subprocess
import sys
import tomllib
import uuid
from typing import Any, Mapping, Sequence


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import fullmag_storage as storage  # noqa: E402


RUN_ID_RE = re.compile(r"[0-9a-f]{32}\Z")
COMMON_SOURCE_PATHS = (
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "rust-toolchain",
    "scripts/verify_session_persistence.py",
)
SESSION_SOURCE_PATHS = COMMON_SOURCE_PATHS + (
    "crates/fullmag-session/Cargo.toml",
    "crates/fullmag-session/src",
    "crates/fullmag-session/tests",
    "crates/fullmag-ir/Cargo.toml",
    "crates/fullmag-ir/src",
    "crates/fullmag-quantities/Cargo.toml",
    "crates/fullmag-quantities/src",
)
APPLICATION_SOURCE_PATHS = COMMON_SOURCE_PATHS + (
    "crates/fullmag-application/Cargo.toml",
    "crates/fullmag-application/src",
    "crates/fullmag-application/tests",
)
PROJECT_ENTRYPOINT_SOURCE_PATHS = COMMON_SOURCE_PATHS + (
    "crates/fullmag-application/Cargo.toml",
    "crates/fullmag-application/src",
    "crates/fullmag-cli/Cargo.toml",
    "crates/fullmag-cli/src",
    "crates/fullmag-py-core/Cargo.toml",
    "crates/fullmag-py-core/src",
    "apps/desktop/src-tauri/Cargo.toml",
    "apps/desktop/src-tauri/src",
)
CAPABILITY_SOURCE_PATHS = COMMON_SOURCE_PATHS + (
    "crates/fullmag-runner/Cargo.toml",
    "crates/fullmag-runner/src",
    "crates/fullmag-ir/Cargo.toml",
    "crates/fullmag-ir/src",
    "crates/fullmag-plan/Cargo.toml",
    "crates/fullmag-plan/src",
    "docs/specs/capability-matrix-v0.md",
    "docs/specs/capability-matrix-v0.json",
    "scripts/validate_mixed_p1_capability_contract.py",
)
API_SOURCE_PATHS = COMMON_SOURCE_PATHS + (
    "crates/fullmag-authoring/Cargo.toml",
    "crates/fullmag-authoring/src",
    "crates/fullmag-ir/Cargo.toml",
    "crates/fullmag-ir/src",
    "crates/fullmag-plan/Cargo.toml",
    "crates/fullmag-plan/src",
    "crates/fullmag-runtime-control/Cargo.toml",
    "crates/fullmag-runtime-control/src",
    "crates/fullmag-api/Cargo.toml",
    "crates/fullmag-api/src",
    "crates/fullmag-application/Cargo.toml",
    "crates/fullmag-application/src",
    "crates/fullmag-session/Cargo.toml",
    "crates/fullmag-session/src",
)
API_PREPARATION_SOURCE_PATHS = API_SOURCE_PATHS + (
    "packages/fullmag-py/pyproject.toml",
    "packages/fullmag-py/uv.lock",
    "packages/fullmag-py/src",
)
AUTHORING_SOURCE_PATHS = COMMON_SOURCE_PATHS + (
    "crates/fullmag-authoring/Cargo.toml",
    "crates/fullmag-authoring/src",
    "crates/fullmag-authoring/tests",
)


@dataclass(frozen=True)
class RouteSpec:
    name: str
    profile: str
    receipt_schema: str
    command: tuple[str, ...]
    source_paths: tuple[str, ...]
    local_dependency_manifest: str | None = None
    requires_python: bool = False
    setup_commands: tuple[tuple[str, ...], ...] = ()
    binary_env: tuple[tuple[str, str], ...] = ()
    environment: tuple[tuple[str, str], ...] = ()


ROUTES = {
    "session-persistence": RouteSpec(
        name="session-persistence",
        profile="windows-session-check",
        receipt_schema="fullmag_session_persistence_v1",
        command=("cargo", "test", "--locked", "-p", "fullmag-session"),
        source_paths=SESSION_SOURCE_PATHS,
    ),
    "project-application-check": RouteSpec(
        name="project-application-check",
        profile="windows-application-check",
        receipt_schema="fullmag_project_application_check_v1",
        command=("cargo", "check", "--locked", "-p", "fullmag-application", "--lib"),
        source_paths=APPLICATION_SOURCE_PATHS,
        local_dependency_manifest="crates/fullmag-application/Cargo.toml",
    ),
    "project-application-test": RouteSpec(
        name="project-application-test",
        profile="windows-application-test",
        receipt_schema="fullmag_project_application_test_v1",
        command=("cargo", "test", "--locked", "-p", "fullmag-application"),
        source_paths=APPLICATION_SOURCE_PATHS,
        local_dependency_manifest="crates/fullmag-application/Cargo.toml",
    ),
    "project-entrypoint-check": RouteSpec(
        name="project-entrypoint-check",
        profile="windows-project-entrypoint-check",
        receipt_schema="fullmag_project_entrypoint_check_v1",
        command=(
            "cargo",
            "check",
            "--locked",
            "-p",
            "fullmag-cli",
            "-p",
            "fullmag-py-core",
            "-p",
            "fullmag-desktop",
        ),
        source_paths=PROJECT_ENTRYPOINT_SOURCE_PATHS,
    ),
    "api-source-check": RouteSpec(
        name="api-source-check",
        profile="windows-api-source-check",
        receipt_schema="fullmag_api_source_check_v1",
        command=("cargo", "check", "--locked", "-p", "fullmag-api", "--bin", "fullmag-api"),
        source_paths=API_SOURCE_PATHS,
        local_dependency_manifest="crates/fullmag-api/Cargo.toml",
    ),
    "runtime-control-tests": RouteSpec(
        name="runtime-control-tests",
        profile="windows-api-source-check",
        receipt_schema="fullmag_runtime_control_test_v1",
        command=("cargo", "test", "--locked", "-p", "fullmag-runtime-control"),
        source_paths=API_SOURCE_PATHS,
        local_dependency_manifest="crates/fullmag-runtime-control/Cargo.toml",
    ),
    "api-accepted-worker-check": RouteSpec(
        name="api-accepted-worker-check",
        profile="windows-api-source-check",
        receipt_schema="fullmag_api_accepted_worker_check_v1",
        command=(
            "cargo",
            "check",
            "--locked",
            "-p",
            "fullmag-api",
            "--bin",
            "fullmag-api-accepted-worker",
        ),
        source_paths=API_SOURCE_PATHS,
        local_dependency_manifest="crates/fullmag-api/Cargo.toml",
    ),
    "api-accepted-supervisor-tests": RouteSpec(
        name="api-accepted-supervisor-tests",
        profile="windows-api-source-check",
        receipt_schema="fullmag_api_accepted_supervisor_test_v1",
        command=(
            "cargo",
            "test",
            "--locked",
            "-p",
            "fullmag-api",
            "--bin",
            "fullmag-api-accepted-supervisor",
        ),
        source_paths=API_SOURCE_PATHS,
        local_dependency_manifest="crates/fullmag-api/Cargo.toml",
    ),
    "api-accepted-supervisor-e2e": RouteSpec(
        name="api-accepted-supervisor-e2e",
        profile="windows-api-source-check",
        receipt_schema="fullmag_api_accepted_supervisor_e2e_v1",
        command=(
            "cargo",
            "test",
            "--locked",
            "-p",
            "fullmag-api",
            "--bin",
            "fullmag-api",
            "router_v2::tests::project_documents::explicit_project_run_submit_is_durable_and_replays_without_live_session",
            "--",
            "--exact",
            "--nocapture",
        ),
        setup_commands=((
            "cargo",
            "build",
            "--locked",
            "-p",
            "fullmag-api",
            "--bin",
            "fullmag-api-accepted-supervisor",
            "--bin",
            "fullmag-api-accepted-worker",
        ),),
        binary_env=(
            ("FULLMAG_ACCEPTED_SUPERVISOR_E2E_BIN", "fullmag-api-accepted-supervisor"),
            ("FULLMAG_ACCEPTED_WORKER_E2E_BIN", "fullmag-api-accepted-worker"),
        ),
        source_paths=API_SOURCE_PATHS,
        local_dependency_manifest="crates/fullmag-api/Cargo.toml",
    ),
    "api-accepted-supervisor-cancel-e2e": RouteSpec(
        name="api-accepted-supervisor-cancel-e2e",
        profile="windows-api-source-check",
        receipt_schema="fullmag_api_accepted_supervisor_cancel_e2e_v1",
        command=(
            "cargo",
            "test",
            "--locked",
            "-p",
            "fullmag-api",
            "--bin",
            "fullmag-api",
            "router_v2::tests::project_documents::explicit_project_run_submit_is_durable_and_replays_without_live_session",
            "--",
            "--exact",
            "--nocapture",
        ),
        setup_commands=((
            "cargo",
            "build",
            "--locked",
            "-p",
            "fullmag-api",
            "--bin",
            "fullmag-api-accepted-supervisor",
            "--bin",
            "fullmag-api-accepted-worker",
        ),),
        binary_env=(
            ("FULLMAG_ACCEPTED_SUPERVISOR_E2E_BIN", "fullmag-api-accepted-supervisor"),
            ("FULLMAG_ACCEPTED_WORKER_E2E_BIN", "fullmag-api-accepted-worker"),
        ),
        environment=(
            ("FULLMAG_ACCEPTED_SUPERVISOR_CANCEL_E2E", "1"),
            ("FULLMAG_ENABLE_TEST_HOOKS", "1"),
            ("FULLMAG_TEST_ACCEPTED_WORKER_AFTER_STARTED_DELAY_MS", "3000"),
        ),
        source_paths=API_SOURCE_PATHS,
        local_dependency_manifest="crates/fullmag-api/Cargo.toml",
    ),
    "api-accepted-supervisor-prestart-cancel-e2e": RouteSpec(
        name="api-accepted-supervisor-prestart-cancel-e2e",
        profile="windows-api-source-check",
        receipt_schema="fullmag_api_accepted_supervisor_prestart_cancel_e2e_v1",
        command=(
            "cargo",
            "test",
            "--locked",
            "-p",
            "fullmag-api",
            "--bin",
            "fullmag-api",
            "router_v2::tests::project_documents::explicit_project_run_submit_is_durable_and_replays_without_live_session",
            "--",
            "--exact",
            "--nocapture",
        ),
        setup_commands=((
            "cargo",
            "build",
            "--locked",
            "-p",
            "fullmag-api",
            "--bin",
            "fullmag-api-accepted-supervisor",
            "--bin",
            "fullmag-api-accepted-worker",
        ),),
        binary_env=(
            ("FULLMAG_ACCEPTED_SUPERVISOR_E2E_BIN", "fullmag-api-accepted-supervisor"),
            ("FULLMAG_ACCEPTED_WORKER_E2E_BIN", "fullmag-api-accepted-worker"),
        ),
        environment=(("FULLMAG_ACCEPTED_SUPERVISOR_PRESTART_CANCEL_E2E", "1"),),
        source_paths=API_SOURCE_PATHS,
        local_dependency_manifest="crates/fullmag-api/Cargo.toml",
    ),
    "api-accepted-supervisor-automatic-retry-e2e": RouteSpec(
        name="api-accepted-supervisor-automatic-retry-e2e",
        profile="windows-api-source-check",
        receipt_schema="fullmag_api_accepted_supervisor_automatic_retry_e2e_v1",
        command=(
            "cargo",
            "test",
            "--locked",
            "-p",
            "fullmag-api",
            "--bin",
            "fullmag-api",
            "router_v2::tests::project_documents::explicit_project_run_submit_is_durable_and_replays_without_live_session",
            "--",
            "--exact",
            "--nocapture",
        ),
        setup_commands=((
            "cargo",
            "build",
            "--locked",
            "-p",
            "fullmag-api",
            "--bin",
            "fullmag-api-accepted-supervisor",
            "--bin",
            "fullmag-api-accepted-worker",
        ),),
        binary_env=(
            ("FULLMAG_ACCEPTED_SUPERVISOR_E2E_BIN", "fullmag-api-accepted-supervisor"),
            ("FULLMAG_ACCEPTED_WORKER_E2E_BIN", "fullmag-api-accepted-worker"),
        ),
        environment=(
            ("FULLMAG_ACCEPTED_SUPERVISOR_AUTOMATIC_RETRY_E2E", "1"),
            ("FULLMAG_ENABLE_TEST_HOOKS", "1"),
            ("FULLMAG_TEST_ACCEPTED_WORKER_FAIL_BEFORE_EFFECT", "1"),
        ),
        source_paths=API_SOURCE_PATHS,
        local_dependency_manifest="crates/fullmag-api/Cargo.toml",
    ),
    "api-preparation-tests": RouteSpec(
        name="api-preparation-tests",
        profile="windows-api-source-check",
        receipt_schema="fullmag_api_preparation_test_v1",
        command=(
            "cargo",
            "test",
            "--locked",
            "-p",
            "fullmag-api",
            "--bin",
            "fullmag-api",
            "preparation_materialization_route_tests::",
            "--",
            "--nocapture",
        ),
        source_paths=API_PREPARATION_SOURCE_PATHS,
        local_dependency_manifest="crates/fullmag-api/Cargo.toml",
        requires_python=True,
    ),
    "api-project-run-tests": RouteSpec(
        name="api-project-run-tests",
        profile="windows-api-source-check",
        receipt_schema="fullmag_api_project_run_test_v1",
        command=("cargo", "test", "--locked", "-p", "fullmag-api",
                 "--bin", "fullmag-api", "router_v2::tests::project_documents::"),
        source_paths=API_SOURCE_PATHS,
        local_dependency_manifest="crates/fullmag-api/Cargo.toml",
    ),
    "api-recovery-tests": RouteSpec(
        name="api-recovery-tests",
        profile="windows-api-source-check",
        receipt_schema="fullmag_api_recovery_test_v1",
        command=("cargo", "test", "--locked", "-p", "fullmag-api",
                 "--bin", "fullmag-api", "router_v2::tests::session_recovery_"),
        source_paths=API_SOURCE_PATHS,
        local_dependency_manifest="crates/fullmag-api/Cargo.toml",
    ),
    "api-scene-resource-tests": RouteSpec(
        name="api-scene-resource-tests",
        profile="windows-api-source-check",
        receipt_schema="fullmag_api_scene_resource_test_v1",
        command=(
            "cargo",
            "test",
            "--locked",
            "-p",
            "fullmag-api",
            "--bin",
            "fullmag-api",
            "router_v2::tests::scene_resource_preserves_selection_and_frozen_spins_authoring_state",
            "--",
            "--exact",
        ),
        source_paths=API_SOURCE_PATHS,
        local_dependency_manifest="crates/fullmag-api/Cargo.toml",
    ),
    "authoring-contract-tests": RouteSpec(
        name="authoring-contract-tests",
        profile="windows-api-source-check",
        receipt_schema="fullmag_authoring_contract_test_v1",
        command=("cargo", "test", "--locked", "-p", "fullmag-authoring", "--lib"),
        source_paths=AUTHORING_SOURCE_PATHS,
        local_dependency_manifest="crates/fullmag-authoring/Cargo.toml",
    ),
    "authoring-scene-adapter-tests": RouteSpec(
        name="authoring-scene-adapter-tests",
        profile="windows-api-source-check",
        receipt_schema="fullmag_authoring_scene_adapter_test_v1",
        command=(
            "cargo",
            "test",
            "--locked",
            "-p",
            "fullmag-authoring",
            "--lib",
            "scene_document",
            "--",
            "--nocapture",
        ),
        source_paths=AUTHORING_SOURCE_PATHS,
        local_dependency_manifest="crates/fullmag-authoring/Cargo.toml",
    ),
    "api-openapi-codegen": RouteSpec(
        name="api-openapi-codegen",
        profile="windows-api-source-check",
        receipt_schema="fullmag_api_openapi_codegen_v1",
        command=("cargo", "run", "--locked", "-p", "fullmag-api", "--features", "openapi-codegen", "--bin", "fullmag-api-openapi"),
        source_paths=COMMON_SOURCE_PATHS + (
            "crates/fullmag-api/Cargo.toml",
            "crates/fullmag-api/src",
            "crates/fullmag-application/src",
            "crates/fullmag-session/src",
        ),
        local_dependency_manifest="crates/fullmag-api/Cargo.toml",
    ),
    "fem-capability-contract": RouteSpec(
        name="fem-capability-contract",
        profile="windows-capability-contract",
        receipt_schema="fullmag_fem_capability_contract_v1",
        command=(
            "cargo",
            "test",
            "--locked",
            "-p",
            "fullmag-runner",
            "--no-default-features",
            "capabilities::tests::",
        ),
        source_paths=CAPABILITY_SOURCE_PATHS,
        local_dependency_manifest="crates/fullmag-runner/Cargo.toml",
    ),
}

# Stable aliases retain the P0 helper API and its receipt contract.
SESSION_ROUTE = ROUTES["session-persistence"]
PROFILE = SESSION_ROUTE.profile
ALLOWED_COMMAND = SESSION_ROUTE.command
RECEIPT_SCHEMA = SESSION_ROUTE.receipt_schema
SOURCE_PATHS = SESSION_ROUTE.source_paths


class SessionCheckError(storage.StorageError):
    """A preflight or provenance error for this one supported route."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def route_spec(route: str | RouteSpec = SESSION_ROUTE) -> RouteSpec:
    if isinstance(route, RouteSpec):
        if any(route is registered for registered in ROUTES.values()):
            return route
        raise SessionCheckError("RouteSpec must come from the immutable route registry")
    try:
        return ROUTES[route]
    except KeyError as error:
        raise SessionCheckError(f"Unsupported verification route: {route}") from error


def validate_command(
    command: Sequence[str], route: str | RouteSpec = SESSION_ROUTE
) -> tuple[str, ...]:
    """Accept no caller-supplied command or Cargo flags."""
    spec = route_spec(route)
    actual = tuple(command)
    if actual != spec.command:
        raise SessionCheckError(
            f"{spec.name} accepts only: " + " ".join(spec.command)
        )
    return actual


def _contained(path: Path, root: Path, label: str) -> Path:
    return storage.validate_path(path, root, label)


def build_run_paths(
    layout: Mapping[str, Any], run_id: str, route: str | RouteSpec = SESSION_ROUTE
) -> dict[str, Path]:
    """Derive all mutable paths below resolver-owned canonical namespaces."""
    spec = route_spec(route)
    if not RUN_ID_RE.fullmatch(run_id):
        raise SessionCheckError(f"Invalid session run id: {run_id!r}")
    build_storage = Path(layout["build_storage_root"])
    build_root = _contained(Path(layout["build_root"]), build_storage, "session build root")
    cache_root = _contained(Path(layout["cache_root"]), build_storage, "session cache root")
    temp_root = _contained(Path(layout["temp_root"]), build_storage, "session temp root")

    run_root = _contained(
        build_root / spec.name / run_id,
        build_storage,
        f"{spec.name} run root",
    )
    run_temp = _contained(
        temp_root / spec.name / run_id,
        build_storage,
        f"{spec.name} temporary root",
    )
    cargo_home = _contained(
        cache_root / spec.name / "cargo",
        build_storage,
        f"{spec.name} Cargo cache",
    )
    rustup_home = _contained(
        cache_root / spec.name / "rustup",
        build_storage,
        f"{spec.name} Rustup cache",
    )
    return {
        "run_root": run_root,
        # The target is stable for this profile so the lock protects reuse
        # instead of forcing a full dependency rebuild for every receipt.
        "target_dir": _contained(build_root / "cargo-target", build_storage, f"{spec.name} target"),
        "temp_dir": run_temp,
        "cargo_home": cargo_home,
        "rustup_home": rustup_home,
        "log": _contained(run_root / "cargo.log", build_storage, "session log"),
        "receipt": _contained(run_root / "receipt.json", build_storage, "session receipt"),
    }


def _write_atomic_json(path: Path, value: Mapping[str, Any]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _application_local_dependency_paths(repo_root: Path, manifest_relative: str) -> tuple[str, ...]:
    """Resolve Cargo path dependencies into source roots for provenance."""
    manifest = repo_root / manifest_relative
    if not manifest.is_file():
        return ()
    document = tomllib.loads(manifest.read_text(encoding="utf-8"))
    tables: list[Mapping[str, Any]] = []
    for name in ("dependencies", "dev-dependencies", "build-dependencies"):
        table = document.get(name)
        if isinstance(table, dict):
            tables.append(table)
    targets = document.get("target")
    if isinstance(targets, dict):
        for target in targets.values():
            if not isinstance(target, dict):
                continue
            for name in ("dependencies", "dev-dependencies", "build-dependencies"):
                table = target.get(name)
                if isinstance(table, dict):
                    tables.append(table)

    paths: list[str] = []
    repo_resolved = repo_root.resolve()
    for table in tables:
        for declaration in table.values():
            if not isinstance(declaration, dict) or not isinstance(declaration.get("path"), str):
                continue
            dependency = (manifest.parent / declaration["path"]).resolve()
            if not storage.inside(dependency, repo_resolved):
                raise SessionCheckError(
                    f"Application path dependency escapes checkout: {declaration['path']}"
                )
            paths.append(dependency.relative_to(repo_resolved).as_posix())
    return tuple(dict.fromkeys(paths))


def source_content_identity(
    repo_root: Path, source_paths: Sequence[str] = SOURCE_PATHS
) -> dict[str, Any]:
    """Hash the bytes that can affect this package test, including fixtures."""
    digest = hashlib.sha256()
    files: dict[str, str] = {}
    for relative in dict.fromkeys(source_paths):
        candidate = repo_root / relative
        candidates = [candidate] if candidate.is_file() else (
            sorted(path for path in candidate.rglob("*") if path.is_file() and not path.is_symlink())
            if candidate.is_dir()
            else []
        )
        for path in candidates:
            name = path.relative_to(repo_root).as_posix()
            content_hash = _sha256_file(path)
            if content_hash is None:
                continue
            files[name] = content_hash
            digest.update(name.encode("utf-8"))
            digest.update(b"\0")
            digest.update(path.read_bytes())
            digest.update(b"\0")
    return {"content_sha256": digest.hexdigest(), "files": files}


def source_identity(
    repo_root: Path, route: str | RouteSpec = SESSION_ROUTE
) -> dict[str, Any]:
    spec = route_spec(route)
    status = storage.git(repo_root, "status", "--porcelain=v1", "--untracked-files=all")
    source_paths = list(spec.source_paths)
    if spec.local_dependency_manifest:
        source_paths.extend(
            _application_local_dependency_paths(repo_root, spec.local_dependency_manifest)
        )
    return {
        "route": spec.name,
        "repo_root": str(repo_root),
        "head": storage.git(repo_root, "rev-parse", "HEAD"),
        "branch": storage.git(repo_root, "branch", "--show-current"),
        "dirty": bool(status),
        "status_sha256": hashlib.sha256(status.encode("utf-8")).hexdigest(),
        "source_paths": list(dict.fromkeys(source_paths)),
        **source_content_identity(repo_root, source_paths),
    }


def _probe_text(command: Sequence[str], env: Mapping[str, str]) -> tuple[int, str, str]:
    result = subprocess.run(
        list(command),
        env=dict(env),
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode, result.stdout.strip(), result.stderr.strip()


def _rustup_tool(rustup: str, tool: str, env: Mapping[str, str]) -> Path:
    code, stdout, stderr = _probe_text([rustup, "which", tool], env)
    candidate = next((line.strip() for line in reversed(stdout.splitlines()) if line.strip()), "")
    if code != 0 or not candidate:
        detail = stderr or stdout or "no path returned"
        raise SessionCheckError(f"rustup which {tool} failed: {detail}")
    path = Path(candidate).expanduser()
    if not path.is_absolute() or not path.is_file():
        raise SessionCheckError(f"rustup selected unusable {tool}: {candidate}")
    return path


def toolchain_identity() -> tuple[dict[str, Any], dict[str, Path]]:
    """Capture installed tools without installing or mutating a toolchain."""
    probe_env = dict(os.environ)
    rustup = shutil.which("rustup", path=probe_env.get("PATH"))
    if not rustup:
        raise SessionCheckError("rustup is required to select the installed session toolchain")
    cargo = _rustup_tool(rustup, "cargo", probe_env)
    rustc = _rustup_tool(rustup, "rustc", probe_env)
    versions: dict[str, Any] = {}
    for name, path in (("cargo", cargo), ("rustc", rustc)):
        code, stdout, stderr = _probe_text([str(path), "--version", "--verbose"], probe_env)
        if code != 0:
            raise SessionCheckError(f"{name} version probe failed: {stderr or stdout}")
        versions[name] = stdout
    active_code, active_stdout, active_stderr = _probe_text(
        [rustup, "show", "active-toolchain"], probe_env
    )
    versions["rustup_active_toolchain"] = active_stdout if active_code == 0 else None
    if active_code != 0:
        versions["rustup_active_toolchain_error"] = active_stderr or active_stdout
    versions["rustup"] = rustup
    versions["cargo_path"] = str(cargo)
    versions["rustc_path"] = str(rustc)
    return versions, {"cargo": cargo, "rustc": rustc}


def python_runtime_identity(route: str | RouteSpec) -> dict[str, str] | None:
    """Pin and identify Python only for routes that exercise the Python DSL."""
    spec = route_spec(route)
    if not spec.requires_python:
        return None

    requested = os.environ.get("FULLMAG_PYTHON")
    selected = requested or sys.executable
    resolved = shutil.which(selected) if not Path(selected).is_absolute() else selected
    executable = Path(resolved or selected).expanduser()
    if not executable.is_file():
        raise SessionCheckError(f"Selected Python interpreter is not a file: {selected}")
    result = subprocess.run(
        [str(executable), "-c", "import sys; print(sys.version.split()[0])"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        raise SessionCheckError(
            "Selected Python interpreter failed its version probe: "
            f"{result.stderr.strip() or result.stdout.strip() or result.returncode}"
        )
    return {
        "executable": str(executable.resolve()),
        "version": f"Python {result.stdout.strip()}",
    }


def child_environment(
    layout: Mapping[str, Any],
    paths: Mapping[str, Path],
    tools: Mapping[str, Path],
    route: str | RouteSpec = SESSION_ROUTE,
    python_runtime: Mapping[str, str] | None = None,
) -> dict[str, str]:
    spec = route_spec(route)
    env = {str(key): str(value) for key, value in os.environ.items()}
    env.pop("FULLMAG_PROJECT_RUN_FIXTURE_PATH", None)
    if spec.name == "api-project-run-tests":
        env["FULLMAG_PROJECT_RUN_FIXTURE_PATH"] = str(paths["run_root"] / "project-run-request.json")
    executable_suffix = ".exe" if os.name == "nt" else ""
    for variable, binary_name in spec.binary_env:
        env[variable] = str(paths["target_dir"] / "debug" / f"{binary_name}{executable_suffix}")
    env.update(dict(spec.environment))
    env.update({str(key): str(value) for key, value in layout["env"].items()})
    env.update(
        {
            "FULLMAG_STORAGE_PROFILE": spec.profile,
            "CARGO_TARGET_DIR": str(paths["target_dir"]),
            "FULLMAG_CARGO_TARGET_DIR": str(paths["target_dir"]),
            "FULLMAG_CARGO_TARGET_ROOT": str(paths["target_dir"]),
            "CARGO_HOME": str(paths["cargo_home"]),
            "RUSTUP_HOME": str(paths["rustup_home"]),
            "RUSTC": str(tools["rustc"]),
            "TMPDIR": str(paths["temp_dir"]),
            "TEMP": str(paths["temp_dir"]),
            "TMP": str(paths["temp_dir"]),
        }
    )
    if spec.requires_python:
        if not python_runtime or not python_runtime.get("executable"):
            raise SessionCheckError(
                f"Route {spec.name} requires a pinned Python interpreter"
            )
        env["FULLMAG_PYTHON"] = python_runtime["executable"]
    # Cargo is invoked by its selected absolute path and rustc is pinned too;
    # putting the same toolchain bin directories first protects build scripts
    # from finding a rustup shim after RUSTUP_HOME is redirected to storage.
    bins: list[str] = []
    for tool in (tools["cargo"], tools["rustc"]):
        parent = str(Path(tool).parent)
        if parent not in bins:
            bins.append(parent)
    old_path = env.get("PATH", "")
    env["PATH"] = os.pathsep.join(bins + ([old_path] if old_path else []))
    env.pop("RUSTUP_TOOLCHAIN", None)
    return env


def _test_summaries(log_path: Path) -> list[dict[str, Any]]:
    text = log_path.read_text(encoding="utf-8", errors="replace")
    pattern = re.compile(
        r"test result:\s+(?P<status>ok|FAILED)\.\s+"
        r"(?P<passed>\d+) passed;\s+(?P<failed>\d+) failed;\s+"
        r"(?P<ignored>\d+) ignored;\s+(?P<measured>\d+) measured;\s+"
        r"(?P<filtered>\d+) filtered out"
    )
    return [
        {
            "status": match.group("status"),
            **{name: int(match.group(name)) for name in ("passed", "failed", "ignored", "measured", "filtered")},
        }
        for match in pattern.finditer(text)
    ]


def run_route(repo_root: Path, route: str | RouteSpec = SESSION_ROUTE) -> int:
    spec = route_spec(route)
    validate_command(spec.command, spec)
    if os.name != "nt":
        raise SessionCheckError(f"{spec.profile} is supported only on Windows")

    layout = storage.resolve_layout(repo_root, spec.profile)
    storage.initialize(layout)
    with storage.build_lock(layout):
        run_id = uuid.uuid4().hex
        paths = build_run_paths(layout, run_id, spec)
        for key in ("run_root", "temp_dir", "target_dir", "cargo_home", "rustup_home"):
            paths[key].mkdir(parents=True, exist_ok=True)

        receipt: dict[str, Any] = {
            "schema": spec.receipt_schema,
            "route": spec.name,
            "profile": spec.profile,
            "run_id": run_id,
            "worktree_id": layout["worktree_id"],
            "repo_root": layout["repo_root"],
            "command": list(spec.command),
            "cwd": str(repo_root),
            "paths": {key: str(value) for key, value in paths.items()},
            "started_at": utc_now(),
            "state": "preflight",
        }
        source_error: str | None = None
        tool_error: str | None = None
        python_error: str | None = None
        python_runtime: dict[str, str] | None = None
        try:
            receipt["source"] = source_identity(repo_root, spec)
        except Exception as error:  # receipt must explain a preflight failure
            source_error = f"{type(error).__name__}: {error}"
            receipt["source"] = {"error": source_error}
        try:
            toolchain, tools = toolchain_identity()
            receipt["toolchain"] = toolchain
        except Exception as error:  # receipt must explain a preflight failure
            tool_error = f"{type(error).__name__}: {error}"
            receipt["toolchain"] = {"error": tool_error}
            tools = None

        if spec.requires_python:
            try:
                python_runtime = python_runtime_identity(spec)
                receipt["python_runtime"] = python_runtime
            except Exception as error:  # receipt must explain a preflight failure
                python_error = f"{type(error).__name__}: {error}"
                receipt["python_runtime"] = {"error": python_error}

        _write_atomic_json(paths["receipt"], receipt)
        return_code = 2
        try:
            if source_error or tool_error or python_error or tools is None:
                receipt["state"] = "not_run"
                receipt["error"] = source_error or tool_error or python_error
            else:
                env = child_environment(layout, paths, tools, spec, python_runtime)
                receipt["state"] = "running"
                receipt["execution_command"] = [str(tools["cargo"]), *spec.command[1:]]
                receipt["setup_commands"] = [
                    [str(tools["cargo"]), *command[1:]] for command in spec.setup_commands
                ]
                _write_atomic_json(paths["receipt"], receipt)
                result: subprocess.CompletedProcess[str] | None = None
                return_code = 0
                with paths["log"].open("w", encoding="utf-8", newline="\n") as log:
                    for command in spec.setup_commands:
                        log.write("setup command: " + " ".join(command) + "\n")
                        log.flush()
                        setup_result = subprocess.run(
                            [str(tools["cargo"]), *command[1:]],
                            cwd=repo_root,
                            env=env,
                            stdout=log,
                            stderr=subprocess.STDOUT,
                            text=True,
                            encoding="utf-8",
                            check=False,
                        )
                        return_code = setup_result.returncode
                        if return_code != 0:
                            break
                    if return_code == 0:
                        result = subprocess.run(
                            [str(tools["cargo"]), *spec.command[1:]],
                            cwd=repo_root,
                            env=env,
                            stdout=subprocess.PIPE if spec.name == "api-openapi-codegen" else log,
                            stderr=log if spec.name == "api-openapi-codegen" else subprocess.STDOUT,
                            text=True,
                            encoding="utf-8",
                            check=False,
                        )
                        return_code = result.returncode
                if return_code == 0 and spec.name == "api-openapi-codegen":
                    assert result is not None
                    document = json.loads(result.stdout)
                    if "/v2/sessions/current/status" not in document.get("paths", {}) or "/v2/persistence/projects/{project_id}/runs" not in document.get("paths", {}):
                        raise SessionCheckError("Generated OpenAPI omitted a required route")
                    identity = document.get("x-fullmag-build-identity")
                    if not isinstance(identity, dict) or any(not identity.get(field) for field in ("built_at_utc", "git_commit", "source_snapshot_sha256", "worktree_state")):
                        raise SessionCheckError("Generated OpenAPI has no complete build identity")
                    for field in ("built_at_utc", "git_commit", "source_snapshot_sha256", "worktree_state"):
                        identity[field] = "generated-artifact"
                    output = repo_root / "apps/control-room/src/kernel/api/generated/openapi-v2.json"
                    _write_atomic_json(output, document)
                    receipt["generated_artifact"] = {"path": str(output), "sha256": _sha256_file(output)}
                receipt["exit_code"] = return_code
                if return_code == 0 and spec.name == "api-project-run-tests":
                    fixture = paths["run_root"] / "project-run-request.json"
                    payload = json.loads(fixture.read_text(encoding="utf-8"))
                    if not all(key in payload for key in ("archive_base64", "run_intent", "study_plan", "study_problem_catalog")):
                        raise SessionCheckError("Project run fixture omitted required immutable inputs")
                    receipt["project_run_fixture"] = {"path": str(fixture), "sha256": _sha256_file(fixture)}
                receipt["test_summaries"] = _test_summaries(paths["log"])
                receipt["state"] = "passed" if return_code == 0 else "failed"
        except BaseException as error:
            receipt["state"] = "interrupted" if isinstance(error, (KeyboardInterrupt, SystemExit)) else "error"
            receipt["error"] = f"{type(error).__name__}: {error}"
            return_code = 2
        finally:
            try:
                source_after = source_identity(repo_root, spec)
                receipt["source_after"] = source_after
                source_before = receipt.get("source")
                source_changed = (
                    isinstance(source_before, dict)
                    and isinstance(source_after, dict)
                    and source_before.get("content_sha256") != source_after.get("content_sha256")
                )
                receipt["source_changed_during_run"] = source_changed
                if source_changed:
                    receipt["state"] = "source_changed"
                    if return_code == 0:
                        return_code = 3
            except Exception as error:
                receipt["source_after"] = {"error": f"{type(error).__name__}: {error}"}
                receipt["source_changed_during_run"] = None
                receipt["state"] = "source_provenance_error"
                return_code = 3
            if paths["log"].exists():
                receipt["log_sha256"] = _sha256_file(paths["log"])
            receipt["finished_at"] = utc_now()
            _write_atomic_json(paths["receipt"], receipt)
        print(json.dumps({"receipt": str(paths["receipt"]), "log": str(paths["log"]), "state": receipt["state"]}))
        return return_code


def run_session_persistence(repo_root: Path) -> int:
    """Preserve the original P0 entrypoint as a fixed route wrapper."""
    return run_route(repo_root, SESSION_ROUTE)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--route", choices=tuple(ROUTES), default="session-persistence")
    args = parser.parse_args(argv)
    try:
        return run_route(Path(args.repo_root).resolve(), args.route)
    except (storage.StorageError, OSError, ValueError) as error:
        print(f"[fullmag session persistence] {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
