"""Source-level contract tests for the dedicated session persistence route."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "verify_session_persistence.py"
SPEC = importlib.util.spec_from_file_location("verify_session_persistence", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


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
    assert 'exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route project-application-check' in shell
    assert 'exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route project-application-test' in shell
    assert 'exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route project-entrypoint-check' in shell
    assert 'exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route fem-capability-contract' in shell
    dedicated = shell.index('exec "${python_cmd}" "${script_dir}/verify_session_persistence.py"')
    generic = shell.index('"${python_cmd}" "${resolver}" prepare-links')
    assert dedicated < generic
