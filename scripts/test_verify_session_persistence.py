"""Source-level contract tests for the dedicated session persistence route."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import os
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "verify_session_persistence.py"
SPEC = importlib.util.spec_from_file_location("verify_session_persistence", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def test_unknown_explicit_route_is_not_silently_replaced_with_session_tests() -> None:
    git_bash = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe"
    bash = str(git_bash) if git_bash.is_file() else shutil.which("bash")
    if not bash:
        pytest.skip("Bash is required to exercise the just shell adapter")
    result = subprocess.run(
        [bash, "scripts/just_storage_shell.sh",
         "python scripts/verify_session_persistence.py --route unknown-recovery-route --repo-root ."],
        cwd=ROOT, capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 2
    assert "Unsupported explicit verification route" in result.stderr
    assert '"receipt"' not in result.stdout


def test_command_scope_is_fixed_to_session_package() -> None:
    expected = ("cargo", "test", "--locked", "-p", "fullmag-session")
    assert MODULE.ALLOWED_COMMAND == expected
    assert MODULE.validate_command(expected) == expected
    with pytest.raises(MODULE.SessionCheckError):
        MODULE.validate_command(("cargo", "test", "--workspace"))


def test_application_routes_have_separate_fixed_commands_and_profiles() -> None:
    check = MODULE.ROUTES["project-application-check"]
    test = MODULE.ROUTES["project-application-test"]
    assert check.command == (
        "cargo", "check", "--locked", "-p", "fullmag-application", "--lib"
    )
    assert test.command == ("cargo", "test", "--locked", "-p", "fullmag-application")
    assert check.profile != test.profile
    assert check.receipt_schema != test.receipt_schema
    with pytest.raises(MODULE.SessionCheckError):
        MODULE.validate_command(("cargo", "check", "--locked", "-p", "other"), check)


def test_fem_capability_route_is_fixed_and_separate() -> None:
    route = MODULE.ROUTES["fem-capability-contract"]
    assert route.command == (
        "cargo",
        "test",
        "--locked",
        "-p",
        "fullmag-runner",
        "--no-default-features",
        "capabilities::tests::",
    )
    assert route.profile == "windows-capability-contract"
    assert route.receipt_schema == "fullmag_fem_capability_contract_v1"
    with pytest.raises(MODULE.SessionCheckError):
        MODULE.validate_command(("cargo", "test", "--workspace"), route)


def test_project_entrypoint_route_covers_cli_python_and_desktop() -> None:
    route = MODULE.ROUTES["project-entrypoint-check"]
    assert route.command == (
        "cargo",
        "check",
        "--locked",
        "-p",
        "fullmag-cli",
        "-p",
        "fullmag-py-core",
        "-p",
        "fullmag-desktop",
    )
    assert route.receipt_schema == "fullmag_project_entrypoint_check_v1"
    assert "crates/fullmag-cli/src" in route.source_paths
    assert "crates/fullmag-py-core/src" in route.source_paths
    assert "apps/desktop/src-tauri/src" in route.source_paths


def test_api_preparation_route_is_fixed_and_tracks_api_sources() -> None:
    route = MODULE.ROUTES["api-preparation-tests"]
    assert route.command == (
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
    )
    assert route.profile == "windows-api-source-check"
    assert route.receipt_schema == "fullmag_api_preparation_test_v1"
    assert route.requires_python is True
    assert "crates/fullmag-api/src" in route.source_paths
    assert "crates/fullmag-application/src" in route.source_paths
    assert "packages/fullmag-py/pyproject.toml" in route.source_paths
    assert "packages/fullmag-py/uv.lock" in route.source_paths
    assert "packages/fullmag-py/src" in route.source_paths
    with pytest.raises(MODULE.SessionCheckError):
        MODULE.validate_command(("cargo", "test", "--workspace"), route)


def test_api_accepted_worker_route_is_fixed_and_tracks_api_sources() -> None:
    route = MODULE.ROUTES["api-accepted-worker-check"]
    assert route.command == (
        "cargo",
        "check",
        "--locked",
        "-p",
        "fullmag-api",
        "--bin",
        "fullmag-api-accepted-worker",
    )
    assert route.profile == "windows-api-source-check"
    assert route.receipt_schema == "fullmag_api_accepted_worker_check_v1"
    assert "crates/fullmag-api/src" in route.source_paths
    assert "crates/fullmag-api/Cargo.toml" in route.source_paths


def test_api_accepted_supervisor_route_is_fixed_and_tracks_api_sources() -> None:
    route = MODULE.ROUTES["api-accepted-supervisor-tests"]
    assert route.command == (
        "cargo",
        "test",
        "--locked",
        "-p",
        "fullmag-api",
        "--bin",
        "fullmag-api-accepted-supervisor",
    )
    assert route.profile == "windows-api-source-check"
    assert route.receipt_schema == "fullmag_api_accepted_supervisor_test_v1"
    assert "crates/fullmag-api/src" in route.source_paths
    assert "crates/fullmag-api/Cargo.toml" in route.source_paths
    with pytest.raises(MODULE.SessionCheckError):
        MODULE.validate_command(("cargo", "check", "--workspace"), route)


def test_api_accepted_supervisor_e2e_route_builds_both_processes() -> None:
    route = MODULE.ROUTES["api-accepted-supervisor-e2e"]
    assert route.command == (
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
    )
    assert route.setup_commands == ((
        "cargo",
        "build",
        "--locked",
        "-p",
        "fullmag-api",
        "--bin",
        "fullmag-api-accepted-supervisor",
        "--bin",
        "fullmag-api-accepted-worker",
    ),)
    assert route.binary_env == (
        ("FULLMAG_ACCEPTED_SUPERVISOR_E2E_BIN", "fullmag-api-accepted-supervisor"),
        ("FULLMAG_ACCEPTED_WORKER_E2E_BIN", "fullmag-api-accepted-worker"),
    )
    assert route.receipt_schema == "fullmag_api_accepted_supervisor_e2e_v1"


def test_api_accepted_supervisor_cancel_e2e_route_builds_both_processes() -> None:
    route = MODULE.ROUTES["api-accepted-supervisor-cancel-e2e"]
    assert route.setup_commands == MODULE.ROUTES["api-accepted-supervisor-e2e"].setup_commands
    assert route.binary_env == MODULE.ROUTES["api-accepted-supervisor-e2e"].binary_env
    assert dict(route.environment) == {
        "FULLMAG_ACCEPTED_SUPERVISOR_CANCEL_E2E": "1",
        "FULLMAG_ENABLE_TEST_HOOKS": "1",
        "FULLMAG_TEST_ACCEPTED_WORKER_AFTER_STARTED_DELAY_MS": "3000",
    }
    assert route.receipt_schema == "fullmag_api_accepted_supervisor_cancel_e2e_v1"
    with pytest.raises(MODULE.SessionCheckError):
        MODULE.validate_command(("cargo", "test", "--workspace"), route)


def test_api_accepted_supervisor_prestart_cancel_e2e_route_builds_both_processes() -> None:
    route = MODULE.ROUTES["api-accepted-supervisor-prestart-cancel-e2e"]
    assert route.setup_commands == MODULE.ROUTES["api-accepted-supervisor-e2e"].setup_commands
    assert route.binary_env == MODULE.ROUTES["api-accepted-supervisor-e2e"].binary_env
    assert dict(route.environment) == {
        "FULLMAG_ACCEPTED_SUPERVISOR_PRESTART_CANCEL_E2E": "1",
    }
    assert route.receipt_schema == "fullmag_api_accepted_supervisor_prestart_cancel_e2e_v1"
    with pytest.raises(MODULE.SessionCheckError):
        MODULE.validate_command(("cargo", "test", "--workspace"), route)


def test_api_accepted_supervisor_automatic_retry_e2e_route_builds_both_processes() -> None:
    route = MODULE.ROUTES["api-accepted-supervisor-automatic-retry-e2e"]
    assert route.setup_commands == MODULE.ROUTES["api-accepted-supervisor-e2e"].setup_commands
    assert route.binary_env == MODULE.ROUTES["api-accepted-supervisor-e2e"].binary_env
    assert dict(route.environment) == {
        "FULLMAG_ACCEPTED_SUPERVISOR_AUTOMATIC_RETRY_E2E": "1",
        "FULLMAG_ENABLE_TEST_HOOKS": "1",
        "FULLMAG_TEST_ACCEPTED_WORKER_FAIL_BEFORE_EFFECT": "1",
    }
    assert route.receipt_schema == "fullmag_api_accepted_supervisor_automatic_retry_e2e_v1"
    with pytest.raises(MODULE.SessionCheckError):
        MODULE.validate_command(("cargo", "test", "--workspace"), route)


def test_api_accepted_supervisor_retry_recovery_e2e_route_builds_both_processes() -> None:
    route = MODULE.ROUTES["api-accepted-supervisor-retry-recovery-e2e"]
    assert route.setup_commands == MODULE.ROUTES["api-accepted-supervisor-e2e"].setup_commands
    assert route.binary_env == MODULE.ROUTES["api-accepted-supervisor-e2e"].binary_env
    assert dict(route.environment) == {
        "FULLMAG_ACCEPTED_SUPERVISOR_RETRY_RECOVERY_E2E": "1",
        "FULLMAG_ENABLE_TEST_HOOKS": "1",
        "FULLMAG_TEST_ACCEPTED_WORKER_FAIL_BEFORE_EFFECT": "1",
        "FULLMAG_TEST_ACCEPTED_SUPERVISOR_FAIL_AFTER_RETRY_DECISION": "1",
    }
    assert route.receipt_schema == "fullmag_api_accepted_supervisor_retry_recovery_e2e_v1"
    with pytest.raises(MODULE.SessionCheckError):
        MODULE.validate_command(("cargo", "test", "--workspace"), route)


def test_api_accepted_scheduler_e2e_route_builds_scheduler_and_worker() -> None:
    route = MODULE.ROUTES["api-accepted-scheduler-e2e"]
    assert route.setup_commands == ((
        "cargo",
        "build",
        "--locked",
        "-p",
        "fullmag-api",
        "--bin",
        "fullmag-api-accepted-scheduler",
        "--bin",
        "fullmag-api-accepted-worker",
    ),)
    assert dict(route.binary_env) == {
        "FULLMAG_ACCEPTED_SCHEDULER_E2E_BIN": "fullmag-api-accepted-scheduler",
        "FULLMAG_ACCEPTED_WORKER_E2E_BIN": "fullmag-api-accepted-worker",
    }
    assert dict(route.environment) == {"FULLMAG_ACCEPTED_SCHEDULER_E2E": "1"}
    assert route.receipt_schema == "fullmag_api_accepted_scheduler_e2e_v1"
    with pytest.raises(MODULE.SessionCheckError):
        MODULE.validate_command(("cargo", "test", "--workspace"), route)


def test_api_accepted_scheduler_retry_e2e_route_builds_all_processes() -> None:
    route = MODULE.ROUTES["api-accepted-scheduler-retry-e2e"]
    assert route.setup_commands == ((
        "cargo",
        "build",
        "--locked",
        "-p",
        "fullmag-api",
        "--bin",
        "fullmag-api-accepted-scheduler",
        "--bin",
        "fullmag-api-accepted-supervisor",
        "--bin",
        "fullmag-api-accepted-worker",
    ),)
    assert dict(route.binary_env) == {
        "FULLMAG_ACCEPTED_SCHEDULER_E2E_BIN": "fullmag-api-accepted-scheduler",
        "FULLMAG_ACCEPTED_SUPERVISOR_E2E_BIN": "fullmag-api-accepted-supervisor",
        "FULLMAG_ACCEPTED_WORKER_E2E_BIN": "fullmag-api-accepted-worker",
    }
    assert dict(route.environment) == {
        "FULLMAG_ACCEPTED_SCHEDULER_RETRY_E2E": "1",
        "FULLMAG_ENABLE_TEST_HOOKS": "1",
        "FULLMAG_TEST_ACCEPTED_WORKER_FAIL_BEFORE_EFFECT": "1",
    }
    assert route.receipt_schema == "fullmag_api_accepted_scheduler_retry_e2e_v1"
    with pytest.raises(MODULE.SessionCheckError):
        MODULE.validate_command(("cargo", "test", "--workspace"), route)


def test_api_scene_resource_route_is_fixed_and_tracks_api_sources() -> None:
    route = MODULE.ROUTES["api-scene-resource-tests"]
    assert route.command == (
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
    )
    assert route.profile == "windows-api-source-check"
    assert route.receipt_schema == "fullmag_api_scene_resource_test_v1"
    assert "crates/fullmag-api/src" in route.source_paths
    with pytest.raises(MODULE.SessionCheckError):
        MODULE.validate_command(("cargo", "test", "--workspace"), route)


def test_authoring_scene_adapter_route_is_fixed_and_tracks_authoring_sources() -> None:
    route = MODULE.ROUTES["authoring-scene-adapter-tests"]
    assert route.command == (
        "cargo",
        "test",
        "--locked",
        "-p",
        "fullmag-authoring",
        "--lib",
        "scene_document",
        "--",
        "--nocapture",
    )
    assert route.profile == "windows-api-source-check"
    assert route.receipt_schema == "fullmag_authoring_scene_adapter_test_v1"
    assert "crates/fullmag-authoring/src" in route.source_paths
    with pytest.raises(MODULE.SessionCheckError):
        MODULE.validate_command(("cargo", "test", "--workspace"), route)


def test_api_preparation_route_pins_python_for_the_child_process(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    route = MODULE.ROUTES["api-preparation-tests"]
    monkeypatch.delenv("FULLMAG_PYTHON", raising=False)
    runtime = MODULE.python_runtime_identity(route)
    assert runtime is not None
    assert runtime["executable"] == str(Path(sys.executable).resolve())
    assert runtime["version"].startswith("Python ")

    paths = {
        name: tmp_path / name
        for name in ("target_dir", "cargo_home", "rustup_home", "temp_dir")
    }
    tools = {"cargo": Path(sys.executable), "rustc": Path(sys.executable)}
    child = MODULE.child_environment({"env": {}}, paths, tools, route, runtime)
    assert child["FULLMAG_PYTHON"] == runtime["executable"]


def test_run_paths_are_contained_by_canonical_storage(tmp_path: Path) -> None:
    storage_root = tmp_path / "storage"
    layout = {
        "build_storage_root": str(storage_root),
        "build_root": str(storage_root / "builds" / "worktree" / MODULE.PROFILE),
        "cache_root": str(storage_root / "cache" / "windows"),
        "temp_root": str(storage_root / "tmp" / "worktree" / MODULE.PROFILE),
    }
    paths = MODULE.build_run_paths(layout, "a" * 32)
    for path in paths.values():
        assert storage_root in path.parents or path == storage_root
    assert paths["target_dir"] == Path(layout["build_root"]) / "cargo-target"
    assert paths["run_root"] in paths["log"].parents
    assert "session-persistence" in paths["cargo_home"].parts


def test_run_paths_reject_path_traversal_id(tmp_path: Path) -> None:
    root = tmp_path / "storage"
    layout = {
        "build_storage_root": str(root),
        "build_root": str(root / "builds"),
        "cache_root": str(root / "cache"),
        "temp_root": str(root / "tmp"),
    }
    with pytest.raises(MODULE.SessionCheckError):
        MODULE.build_run_paths(layout, "../escape")


def test_receipt_finalization_is_atomic_and_complete(tmp_path: Path) -> None:
    receipt_path = tmp_path / "run" / "receipt.json"
    initial = {"schema": MODULE.RECEIPT_SCHEMA, "state": "running"}
    final = {**initial, "state": "passed", "exit_code": 0, "finished_at": "now"}
    MODULE._write_atomic_json(receipt_path, initial)
    MODULE._write_atomic_json(receipt_path, final)
    assert json.loads(receipt_path.read_text(encoding="utf-8")) == final
    assert not list(receipt_path.parent.glob(".*.tmp"))


def test_source_digest_changes_when_bytes_change_without_git_identity_change(tmp_path: Path) -> None:
    source = tmp_path / "crates" / "fullmag-session" / "src"
    source.mkdir(parents=True)
    (tmp_path / "Cargo.toml").write_text("workspace\n", encoding="utf-8")
    (tmp_path / "crates" / "fullmag-session" / "Cargo.toml").write_text(
        "name = 'fullmag-session'\n", encoding="utf-8"
    )
    fixture = source / "fixture.rs"
    fixture.write_bytes(b"before")
    before = MODULE.source_content_identity(tmp_path)
    fixture.write_bytes(b"after")
    after = MODULE.source_content_identity(tmp_path)
    assert before["content_sha256"] != after["content_sha256"]
    assert before["files"]["crates/fullmag-session/src/fixture.rs"] != after["files"]["crates/fullmag-session/src/fixture.rs"]


def test_just_route_precedes_generic_prepare_links() -> None:
    justfile = (ROOT / "justfile").read_text(encoding="utf-8")
    shell = (ROOT / "scripts" / "just_storage_shell.sh").read_text(encoding="utf-8")
    assert 'scripts/verify_session_persistence.py" --repo-root' in justfile
    assert '--route project-application-check --repo-root' in justfile
    assert '--route project-application-test --repo-root' in justfile
    assert '--route project-entrypoint-check --repo-root' in justfile
    assert '--route fem-capability-contract --repo-root' in justfile
    assert '--route api-accepted-worker-check --repo-root' in justfile
    assert '--route runtime-control-tests --repo-root' in justfile
    assert '--route api-accepted-supervisor-tests --repo-root' in justfile
    assert '--route api-accepted-supervisor-e2e --repo-root' in justfile
    assert '--route api-accepted-supervisor-cancel-e2e --repo-root' in justfile
    assert '--route api-accepted-supervisor-prestart-cancel-e2e --repo-root' in justfile
    assert '--route api-accepted-supervisor-automatic-retry-e2e --repo-root' in justfile
    assert '--route api-accepted-supervisor-retry-recovery-e2e --repo-root' in justfile
    assert '--route api-accepted-scheduler-e2e --repo-root' in justfile
    assert '--route api-accepted-scheduler-retry-e2e --repo-root' in justfile
    assert '--route api-preparation-tests --repo-root' in justfile
    assert '--route api-scene-resource-tests --repo-root' in justfile
    assert '--route authoring-scene-adapter-tests --repo-root' in justfile
    assert 'exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route project-application-check' in shell
    assert 'exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route project-application-test' in shell
    assert 'exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route project-entrypoint-check' in shell
    assert 'exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route fem-capability-contract' in shell
    assert 'exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-worker-check' in shell
    assert 'exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route runtime-control-tests' in shell
    assert 'exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-supervisor-tests' in shell
    assert 'exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-supervisor-e2e' in shell
    assert 'exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-supervisor-cancel-e2e' in shell
    assert 'exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-supervisor-prestart-cancel-e2e' in shell
    assert 'exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-supervisor-automatic-retry-e2e' in shell
    assert 'exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-supervisor-retry-recovery-e2e' in shell
    assert 'exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-scheduler-e2e' in shell
    assert 'exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-scheduler-retry-e2e' in shell
    assert 'exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-preparation-tests' in shell
    assert 'exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-scene-resource-tests' in shell
    assert 'exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route authoring-scene-adapter-tests' in shell
    dedicated = shell.index('exec "${python_cmd}" "${script_dir}/verify_session_persistence.py"')
    generic = shell.index('"${python_cmd}" "${resolver}" prepare-links')
    assert dedicated < generic
