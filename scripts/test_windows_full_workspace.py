#!/usr/bin/env python3
"""Interpreted contract checks for the closed all-realizations Windows route.

These checks construct only small metadata fixtures.  They do not invoke
PowerShell, a compiler, a browser, or an installer.
"""

from __future__ import annotations

import hashlib
import json
from contextlib import nullcontext
from pathlib import Path
import sys
import tempfile


sys.path.insert(0, str(Path(__file__).resolve().parent))
import fullmag_storage as storage  # noqa: E402
sys.path.insert(0, str(Path(__file__).resolve().parent / "windows"))
import runtime_bundle  # noqa: E402


RUNTIME_FAMILY_NAMES = tuple(
    name for name in runtime_bundle.BINARY_NAMES if name != "fullmag-ui.exe"
)


def _write(path: Path, content: str | bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = content.encode("utf-8") if isinstance(content, str) else content
    path.write_bytes(data)
    return path


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _layout(root: Path) -> dict[str, str]:
    build = root / "build"
    repo = root / "repo"
    build.mkdir()
    repo.mkdir()
    return {
        "repo_root": str(repo),
        "storage_root": str(root),
        "build_storage_root": str(root),
        "build_root": str(build),
        "worktree_id": "full-workspace-test-0123456789ab",
        "profile": storage.WINDOWS_FULL_WORKSPACE_STORAGE_PROFILE,
    }


def _artifact(path: Path) -> dict[str, object]:
    return {"path": str(path), "size_bytes": path.stat().st_size, "sha256": _sha(path)}


def _runtime_family_inventory_sha256(artifacts: list[dict[str, object]]) -> str:
    payload = "".join(
        f"{item['name']}|{item['size_bytes']}|{item['sha256']}\n"
        for item in artifacts
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _package(layout: dict[str, str], attempt: str) -> dict[str, object]:
    build = Path(layout["build_root"])
    family_root = build / "runtime-launch"
    stage_root = build / "windows-fem-runtime" / "bin"
    binary = _write(family_root / "fullmag.exe", b"fullmag-test-binary")
    api_binary = _write(family_root / "fullmag-api.exe", b"fullmag-test-api")
    fdm_dll = _write(family_root / "native_fdm.dll", b"fdm-runtime")
    fem_dll = _write(family_root / "native_fem.dll", b"fem-runtime")
    family_artifacts: list[dict[str, object]] = []
    for name in RUNTIME_FAMILY_NAMES:
        path = family_root / name
        if not path.exists():
            _write(path, name.encode("ascii"))
        family_artifacts.append(_artifact(path) | {"name": name})
    for artifact in family_artifacts:
        _write(stage_root / artifact["name"], Path(artifact["path"]).read_bytes())
    for path in (fdm_dll, fem_dll):
        _write(stage_root / path.name, path.read_bytes())

    commit = "a" * 40
    snapshot = "b" * 64
    source_root = build / "source-snapshots" / ("e" * 64) / "source"
    runtime_bundle_path = source_root / "scripts" / "windows" / "runtime_bundle.py"
    runtime_bundle_text = "BINARY_NAMES = (\n" + "".join(
        f"    {name!r},\n" for name in runtime_bundle.BINARY_NAMES
    ) + ")\n"
    _write(runtime_bundle_path, runtime_bundle_text)
    source_inventory = [{
        "path": "scripts/windows/runtime_bundle.py",
        "size": runtime_bundle_path.stat().st_size,
        "sha256": _sha(runtime_bundle_path),
    }]
    inventory_bytes = (
        json.dumps(source_inventory, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode("utf-8")
    inventory_sha256 = hashlib.sha256(inventory_bytes).hexdigest()
    record_path = source_root.parent / "record.json"
    _write(record_path, json.dumps({
        "schema": "fullmag.windows-build-snapshot.v1",
        "source_identity": {"source_snapshot_sha256": snapshot},
        "record_path": str(record_path),
        "source_root": str(source_root),
        "inventory_sha256": inventory_sha256,
        "inventory": source_inventory,
    }, sort_keys=True))
    frozen_source = {
        "record_path": str(record_path),
        "inventory_sha256": inventory_sha256,
        "source_root": str(source_root),
    }

    audit_images = []
    for path in sorted(stage_root.iterdir(), key=lambda item: item.name.casefold()):
        if path.suffix.casefold() in {".exe", ".dll"}:
            audit_images.append({"path": f"bin/{path.name}", "sha256": _sha(path)})
    audit = _write(build / "windows-fem-runtime" / "windows-pe-dependencies.json", json.dumps({
        "schema_version": 1,
        "target": "x86_64-pc-windows-msvc",
        "scope": "bin_pe_static_and_delay_imports",
        "images": audit_images,
        "limitations": [],
    }))
    family_inventory_sha256 = _runtime_family_inventory_sha256(family_artifacts)
    provider_config = _write(build / "fem-dependencies" / "installed" / "provider.json", "provider")
    provider_receipt = _write(build / "fem-dependencies" / "provider-receipt.json", "receipt")

    frontend = build / "frontend"
    cache = build / "frontend-cache"
    (frontend / "apps" / "control-room").mkdir(parents=True)
    _write(frontend / "source.json", "{\"source\":\"fixture\"}")
    entry = _write(cache / "out" / "index.html", "<!doctype html><title>fixture</title>")
    source_manifest = frontend / "source.json"

    origin_path = build / "windows-fem-runtime" / "build-manifest.json"
    origin = {
        "schema_version": 1,
        "state": "completed",
        "backend": "fem",
        "target_triple": "x86_64-pc-windows-msvc",
        "cuda": True,
        "binary": str(binary),
        "binary_sha256": _sha(binary),
        "api_binary": str(api_binary),
        "api_binary_sha256": _sha(api_binary),
        "native_fdm_dll": str(fdm_dll),
        "source_commit_after": commit,
        "source_worktree_state_after": "dirty",
        "source_snapshot_sha256_after": snapshot,
        "native_fem_attempt_id": attempt,
        "native_fem": {
            "device": "gpu",
            "requested_device": "auto",
            "strict_gpu": True,
            "runtime_dll": str(fem_dll),
            "runtime_dll_sha256": _sha(fem_dll),
            "dependency_audit_path": str(audit),
            "dependency_audit_sha256": _sha(audit),
            "provider_config": str(provider_config),
            "provider_config_sha256": _sha(provider_config),
            "provider_receipt_path": str(provider_receipt),
            "provider_receipt_sha256": _sha(provider_receipt),
            "runtime_bin": str(stage_root),
            "runtime_family_root": str(family_root),
            "runtime_family": family_artifacts,
            "runtime_family_inventory": list(RUNTIME_FAMILY_NAMES),
            "runtime_family_inventory_sha256": family_inventory_sha256,
            "runtime_family_dependency_audit_path": str(audit),
            "runtime_family_dependency_audit_sha256": _sha(audit),
        },
        "browser_workspace": True,
        "ui_host": "browser",
        "workspace_mode": "empty",
        "frontend_mode": "static",
        "desktop_binary": None,
        "desktop_binary_sha256": None,
        "frontend_workspace_root": str(frontend),
        "frontend_cache_root": str(cache),
        "frontend_source_manifest": str(source_manifest),
        "frontend_source_manifest_sha256": _sha(source_manifest),
        "frontend_entry_path": str(entry),
        "frontend_entry_sha256": _sha(entry),
        "static_web_sha256": storage._directory_sha256(cache / "out"),
        "build_source_snapshot": frozen_source,
    }
    _write(origin_path, json.dumps(origin, sort_keys=True))

    top = {
        "schema": "fullmag.windows-full-capability-package.v1",
        "state": "completed",
        "profile": storage.WINDOWS_FULL_WORKSPACE_STORAGE_PROFILE,
        "requested_backend": "auto",
        "requested_device": "auto",
        "runtime_selection": "ui",
        "attempt_id": attempt,
        "source_identity": {
            "head_commit_full": commit,
            "source_snapshot_sha256": snapshot,
            "source_worktree_state": "dirty",
        },
        "source_snapshot_sha256": snapshot,
        "origin_manifest_path": str(origin_path),
        "origin_manifest_sha256": _sha(origin_path),
        "binary": str(binary),
        "binary_sha256": _sha(binary),
        "api_binary": str(api_binary),
        "api_binary_sha256": _sha(api_binary),
        "native_fdm_dll": str(fdm_dll),
        "native_fdm_dll_sha256": _sha(fdm_dll),
        "native_fem_dll": str(fem_dll),
        "native_fem_dll_sha256": _sha(fem_dll),
        "native_fem": origin["native_fem"],
        "runtime_family_root": str(family_root),
        "runtime_family": family_artifacts,
        "runtime_family_inventory": list(RUNTIME_FAMILY_NAMES),
        "runtime_family_inventory_sha256": family_inventory_sha256,
        "runtime_family_dependency_audit_path": str(audit),
        "runtime_family_dependency_audit_sha256": _sha(audit),
        "build_source_snapshot": frozen_source,
        "runtime_environment": {
            "FULLMAG_FDM_EXECUTION": None,
            "FULLMAG_FEM_EXECUTION": None,
            "FULLMAG_RELAX_DEVICE": None,
        },
    }
    components = {}
    component_root = build / "windows-full-runtime" / "components" / attempt
    for component, (backend, device, needs_driver, artifact_field) in storage.WINDOWS_FULL_WORKSPACE_COMPONENTS.items():
        component_manifest_path = component_root / f"{component}.manifest.json"
        receipt_path = component_root / f"{component}.receipt.json"
        artifacts = [_artifact(binary), _artifact(api_binary), _artifact(fdm_dll if artifact_field == "native_fdm_dll" else fem_dll)]
        component_manifest = {
            "schema": "fullmag.windows-runtime-component.v1",
            "component": component,
            "backend": backend,
            "device": device,
            "installed_support": True,
            "requires_nvidia_driver": needs_driver,
            "origin_manifest_path": str(origin_path),
            "origin_manifest_sha256": _sha(origin_path),
            "source_identity": top["source_identity"],
            "source_snapshot_sha256": snapshot,
            "attempt_id": attempt,
            "receipt_path": str(receipt_path),
            "artifacts": artifacts,
        }
        _write(component_manifest_path, json.dumps(component_manifest, sort_keys=True))
        component_receipt = {
            "schema": "fullmag.windows-runtime-component-receipt.v1",
            "component": component,
            "backend": backend,
            "device": device,
            "installed_support": True,
            "requires_nvidia_driver": needs_driver,
            "component_manifest_path": str(component_manifest_path),
            "component_manifest_sha256": _sha(component_manifest_path),
            "origin_manifest_path": str(origin_path),
            "origin_manifest_sha256": _sha(origin_path),
            "source_snapshot_sha256": snapshot,
            "attempt_id": attempt,
        }
        _write(receipt_path, json.dumps(component_receipt, sort_keys=True))
        components[component] = {
            "backend": backend,
            "device": device,
            "installed_support": True,
            "requires_nvidia_driver": needs_driver,
            "component_manifest_path": str(component_manifest_path),
            "component_manifest_sha256": _sha(component_manifest_path),
            "receipt_path": str(receipt_path),
            "receipt_sha256": _sha(receipt_path),
            "artifacts": artifacts,
        }
    top["components"] = components
    manifest_path = build / "windows-full-runtime" / "build-manifest.json"
    _write(manifest_path, json.dumps(top, sort_keys=True))
    return top


def _write_receipt(layout: dict[str, str], manifest: dict[str, object]) -> None:
    storage._persist_full_workspace_receipt(
        layout,
        manifest,
        "windows-full-workspace-build",
        {"started_at": "2026-10-15T00:00:00+00:00"},
    )


def test_validator_and_handoff_reject_drift() -> None:
    with tempfile.TemporaryDirectory(prefix="fullmag-full-workspace-") as temporary:
        layout = _layout(Path(temporary))
        attempt = "c" * 32
        manifest = _package(layout, attempt)
        storage.validate_full_workspace_manifest(layout, manifest)
        _write_receipt(layout, manifest)
        manifest_path = Path(layout["build_root"]) / "windows-full-runtime" / "build-manifest.json"
        expected = _sha(manifest_path)
        storage.validate_full_workspace_handoff(layout, expected)

        scheduler = Path(manifest["runtime_family_root"]) / "fullmag-api-accepted-scheduler.exe"
        scheduler.write_bytes(b"tampered-scheduler")
        try:
            storage.validate_full_workspace_handoff(layout, expected)
        except storage.StorageError:
            pass
        else:
            raise AssertionError("tampered runtime-family scheduler was accepted")
        scheduler.unlink()
        try:
            storage.validate_full_workspace_handoff(layout, expected)
        except storage.StorageError:
            pass
        else:
            raise AssertionError("missing runtime-family scheduler was accepted")

        scheduler.write_bytes(b"fullmag-api-accepted-scheduler.exe")
        fem_stage_dll = (Path(manifest["native_fem"]["runtime_bin"])
                         / Path(manifest["native_fem"]["runtime_dll"]).name)
        assert fem_stage_dll.is_file()
        fem_stage_dll.write_bytes(b"tampered-fem-dll")
        try:
            storage.validate_full_workspace_handoff(layout, expected)
        except storage.StorageError:
            pass
        else:
            raise AssertionError("tampered runtime-family dependency was accepted")

        with tempfile.TemporaryDirectory(prefix="fullmag-full-origin-state-") as state_temporary:
            state_layout = _layout(Path(state_temporary))
            state_manifest = _package(state_layout, "e" * 32)
            state_origin_path = Path(state_manifest["origin_manifest_path"])
            state_origin = json.loads(state_origin_path.read_text(encoding="utf-8"))
            state_origin["source_worktree_state_after"] = "clean"
            state_origin_path.write_text(json.dumps(state_origin, sort_keys=True), encoding="utf-8")
            state_manifest["origin_manifest_sha256"] = _sha(state_origin_path)
            try:
                storage.validate_full_workspace_manifest(state_layout, state_manifest)
            except storage.StorageError:
                pass
            else:
                raise AssertionError("origin source worktree state drift was accepted")

        with tempfile.TemporaryDirectory(prefix="fullmag-full-origin-path-") as path_temporary:
            path_layout = _layout(Path(path_temporary))
            path_manifest = _package(path_layout, "f" * 32)
            original_origin_path = Path(path_manifest["origin_manifest_path"])
            moved_origin_path = Path(path_layout["build_root"]) / "windows-full-runtime" / "moved-origin.json"
            _write(moved_origin_path, original_origin_path.read_bytes())
            path_manifest["origin_manifest_path"] = str(moved_origin_path)
            path_manifest["origin_manifest_sha256"] = _sha(moved_origin_path)
            try:
                storage.validate_full_workspace_manifest(path_layout, path_manifest)
            except storage.StorageError:
                pass
            else:
                raise AssertionError("moved origin manifest was accepted")

        component_receipt = Path(manifest["components"]["fem_gpu"]["receipt_path"])
        original = json.loads(component_receipt.read_text(encoding="utf-8"))
        original["device"] = "cpu"
        component_receipt.write_text(json.dumps(original, sort_keys=True), encoding="utf-8")
        try:
            storage.validate_full_workspace_handoff(layout, expected)
        except storage.StorageError:
            pass
        else:
            raise AssertionError("component receipt drift was accepted")


def test_build_route_is_full_and_writes_immutable_receipt() -> None:
    with tempfile.TemporaryDirectory(prefix="fullmag-full-route-") as temporary:
        layout = _layout(Path(temporary))
        launcher = Path(layout["repo_root"]) / "scripts" / "windows" / "run_fullmag.ps1"
        _write(launcher, "param()")
        calls = []
        original_native = storage._is_native_windows
        original_run = storage._run_managed_command
        storage._is_native_windows = lambda: True

        def fake_run(call_layout, command, **kwargs):
            calls.append((command, kwargs))
            attempt = kwargs["attempt_id"]
            manifest = _package(call_layout, attempt)
            state = {"started_at": "2026-10-15T00:00:00+00:00"}
            _write_receipt(call_layout, manifest)
            result_record = kwargs["result_record"]
            result_record.update(state, state="completed", exit_code=0, build_manifest_sha256=_sha(
                Path(call_layout["build_root"]) / "windows-full-runtime" / "build-manifest.json"
            ))
            return 0

        storage._run_managed_command = fake_run
        try:
            assert storage.run_windows_full_workspace_build(layout, "static", 0) == 0
        finally:
            storage._is_native_windows = original_native
            storage._run_managed_command = original_run
        assert len(calls) == 1
        command, kwargs = calls[0]
        assert "-AllBackends" in command and "-Browser" in command
        assert command[command.index("-Backend") + 1] == "auto"
        assert command[command.index("-Device") + 1] == "auto"
        assert "-BuildOnly" in command
        assert kwargs["native_full_workspace_paths"] is True
        assert kwargs["execution_mode"] == "windows-full-workspace-build"
        receipt_root = Path(layout["build_root"]) / "windows-full-runtime" / "receipts"
        receipts = list(receipt_root.glob("*.json"))
        assert len(receipts) == 1
        assert not (Path(layout["build_root"]) / "native-fem-receipt.json").exists()


def test_stale_full_manifest_exit_zero_publishes_no_receipt() -> None:
    with tempfile.TemporaryDirectory(prefix="fullmag-full-stale-attempt-") as temporary:
        root = Path(temporary)
        layout = _layout(root)
        layout.update(
            runtime_root=str(root / "runtime"),
            frontend_root=str(root / "frontend"),
            env={"CARGO_TARGET_DIR": str(root / "target")},
        )
        launcher = Path(layout["repo_root"]) / "scripts" / "windows" / "run_fullmag.ps1"
        _write(launcher, "param()")
        legacy_state = _write(Path(layout["repo_root"]) / ".fullmag" / "existing-state.json", b"preserve-existing-state")
        stale_attempt = "1" * 32
        current_attempt = "2" * 32
        stale_manifest = _package(layout, stale_attempt)
        _write_receipt(layout, stale_manifest)
        command = [
            "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
            "-ExecutionPolicy", "Bypass", "-File", str(launcher),
            "-BuildMode", "true", "-Frontend", "static",
            "-BackendProfile", "release", "-Backend", "auto", "-Device", "auto",
            "-RunMode", "workspace", "-WebPort", "0", "-Browser", "-AllBackends", "-BuildOnly",
        ]
        original_native = storage._is_native_windows
        original_initialize = storage.initialize
        original_heavy_lock = storage.managed_heavy_lock
        original_build_lock = storage.build_lock
        original_git = storage.git
        original_logged = storage._run_logged_command
        storage._is_native_windows = lambda: True
        storage.initialize = lambda _layout: None
        storage.managed_heavy_lock = lambda *_args, **_kwargs: nullcontext()
        storage.build_lock = lambda *_args, **_kwargs: nullcontext()

        def fake_git(_repo, *args):
            return "a" * 40 if args == ("rev-parse", "HEAD") else ""

        def fake_logged(command_value, cwd, env, log_path, cancelled=None):
            return type("Result", (), {"returncode": 0})()

        storage.git = fake_git
        storage._run_logged_command = fake_logged
        result_record = {}
        try:
            result = storage._run_managed_command(
                layout,
                command,
                acquire_heavy_slot=True,
                native_user_build=True,
                native_full_workspace_paths=True,
                execution_mode="windows-full-workspace-build",
                native_manifest_relative="windows-full-runtime/build-manifest.json",
                result_record=result_record,
                attempt_id=current_attempt,
                full_origin_attempt_id=current_attempt,
            )
        finally:
            storage._is_native_windows = original_native
            storage.initialize = original_initialize
            storage.managed_heavy_lock = original_heavy_lock
            storage.build_lock = original_build_lock
            storage.git = original_git
            storage._run_logged_command = original_logged
        assert result == 1
        assert legacy_state.read_bytes() == b"preserve-existing-state"
        current_receipt = Path(layout["build_root"]) / "windows-full-runtime" / "receipts" / f"{current_attempt}.json"
        assert not current_receipt.exists()
        assert result_record.get("state") == "failed"
        assert result_record.get("exit_code") == 1


def test_runtime_auto_pins_current_build_under_lock() -> None:
    with tempfile.TemporaryDirectory(prefix="fullmag-full-runtime-") as temporary:
        layout = _layout(Path(temporary))
        launcher = Path(layout["repo_root"]) / "scripts" / "windows" / "run_fullmag.ps1"
        _write(launcher, "param()")
        attempt = "d" * 32
        manifest = _package(layout, attempt)
        _write_receipt(layout, manifest)
        seen = {}
        original_native = storage._is_native_windows
        original_run = storage._run_managed_command
        original_initialize = storage.initialize
        original_build_lock = storage.build_lock
        storage._is_native_windows = lambda: True
        storage.initialize = lambda _layout: None
        storage.build_lock = lambda _layout: nullcontext()

        def fake_run(_layout, command, **kwargs):
            seen["command"] = command
            kwargs["result_record"].update(state="completed", exit_code=0)
            return 0

        storage._run_managed_command = fake_run
        try:
            assert storage.run_windows_full_workspace(layout, "static", 0, "false") == 0
        finally:
            storage._is_native_windows = original_native
            storage._run_managed_command = original_run
            storage.initialize = original_initialize
            storage.build_lock = original_build_lock
        expected = _sha(Path(layout["build_root"]) / "windows-full-runtime" / "build-manifest.json")
        assert seen["command"][seen["command"].index("-ExpectedBuildId") + 1] == expected
        assert seen["command"][seen["command"].index("-BuildMode") + 1] == "false"


def test_recipe_contracts_are_closed() -> None:
    repo = Path(__file__).resolve().parents[1]
    justfile = (repo / "justfile").read_text(encoding="utf-8")
    shell = (repo / "scripts" / "just_storage_shell.sh").read_text(encoding="utf-8")
    for marker in ("windows-full-workspace-build", "windows-full-workspace", "-AllBackends", "-ExpectedBuildId"):
        assert marker in justfile
        assert marker in shell or marker == "-ExpectedBuildId"
    assert "windows-native-fem-gpu" in shell
    resolver = (repo / "scripts" / "fullmag_storage.py").read_text(encoding="utf-8")
    assert '"run-windows-full-workspace-build"' in resolver


def main() -> int:
    test_validator_and_handoff_reject_drift()
    test_build_route_is_full_and_writes_immutable_receipt()
    test_stale_full_manifest_exit_zero_publishes_no_receipt()
    test_runtime_auto_pins_current_build_under_lock()
    test_recipe_contracts_are_closed()
    print("windows full workspace source contract: PASS (5 checks)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
