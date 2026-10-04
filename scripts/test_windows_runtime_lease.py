"""Native lease transitions exercised with a launcher stub, no compilation."""
from contextlib import contextmanager
import json
import hashlib
import os
from pathlib import Path

import pytest
from fullmag_storage import StorageError
from windows import runtime_lease as lease


@pytest.fixture
def layout(tmp_path):
    (tmp_path / "locks").mkdir()
    (tmp_path / "runtime").mkdir()
    return {"storage_root": str(tmp_path), "runtime_root": str(tmp_path / "runtime"),
            "runs_root": str(tmp_path / "runs" / "fixture"),
            "repo_root": str(tmp_path), "worktree_id": "fixture", "profile": "windows-native-fdm-cpu-dev"}


@pytest.fixture(autouse=True)
def launch_view_stub(layout, monkeypatch):
    # These lease transition fixtures isolate publication behind its contract.
    from windows import stable_launch
    monkeypatch.setattr(stable_launch, "validate_launch_copy", lambda *args: {
        "launch_root": str(Path(layout["runtime_root"]) / "native-launch/dev")})


def test_ready_rejects_unverified_launch_path(layout, monkeypatch):
    path = Path(layout["runtime_root"]) / "ready.json"
    path.write_text(json.dumps({"schema": "fullmag.native-runtime-ready.v2",
        "nonce": "expected", "launcher_pid": 12, "bundle_root": "fixture",
        "launch_root": "foreign"}))
    monkeypatch.setattr(lease, "validate_bundle", lambda *args: ({"source": {}}, {}))
    with pytest.raises(StorageError, match="does not match"):
        lease.validate_ready(path, layout, "expected", 12, "dev")


def test_ready_rejects_wrong_launcher_before_bundle_validation(layout, monkeypatch):
    path = Path(layout["runtime_root"]) / "ready.json"
    path.write_text(json.dumps({"schema": "fullmag.native-runtime-ready.v2", "nonce": "other", "launcher_pid": 12}))
    monkeypatch.setattr(lease, "validate_bundle", lambda *args: pytest.fail("Unowned bundle inspected"))
    with pytest.raises(StorageError, match="does not belong"):
        lease.validate_ready(path, layout, "expected", 12, "dev")


def test_build_lock_released_only_after_validated_handshake(layout, monkeypatch):
    events = []
    @contextmanager
    def build_lock(_):
        events.append("build acquired")
        monkeypatch.setenv("FULLMAG_STORAGE_LOCK_TOKEN", "fixture")
        monkeypatch.setenv("FULLMAG_STORAGE_LOCK_KEY", "fixture")
        yield
        events.append("build released")
    class Child:
        pid = 12
        def __init__(self, command, cwd, env):
            events.append("launcher started")
            assert env["FULLMAG_NATIVE_RUNTIME_ACTIVE"] == "1"
            Path(env["FULLMAG_NATIVE_RUNTIME_READY_FILE"]).write_text(json.dumps({
                "schema": "fullmag.native-runtime-ready.v2",
                "nonce": env["FULLMAG_NATIVE_RUNTIME_NONCE"], "launcher_pid": self.pid,
                "launch_root": str(Path(layout["runtime_root"]) / "native-launch/dev"), "bundle_root": str(Path(layout["runtime_root"]) / "native-bundles" / "fixture")}))
        def poll(self):
            return None
        def wait(self):
            assert events[-1] == "build released"
            events.append("runtime finished")
            return 0
    def validate(*args):
        events.append("bundle validated")
        return {"source": {"git_commit": "fixture"}}, {}
    monkeypatch.setattr(lease, "build_lock", build_lock)
    monkeypatch.setattr(lease.subprocess, "Popen", Child)
    monkeypatch.setattr(lease, "validate_bundle", validate)
    assert lease.run_sealed_runtime(layout, ["stub", "-Frontend", "static"], {}, "dev") == 0
    assert events == ["build acquired", "launcher started", "bundle validated", "build released", "runtime finished"]
    status = json.loads((Path(layout["runtime_root"]) / "native-workspace-status.json").read_text())
    assert status["state"] == "completed"
    assert status["build_lease"] == "released_after_sealing"
    assert status["launcher_waited"] is True
    assert status["watcher_waited"] is True
    assert lease._is_terminal_runtime_receipt(status)


def test_no_success_receipt_when_launcher_does_not_seal(layout, monkeypatch):
    class Child:
        pid = 12
        def __init__(self, *args, **kwargs):
            pass
        def poll(self):
            return 0
        def wait(self):
            return 0
    monkeypatch.setattr(lease.subprocess, "Popen", Child)
    with pytest.raises(StorageError, match="without publishing"):
        lease.run_sealed_runtime(layout, ["stub"], {}, "dev")
    status = json.loads((Path(layout["runtime_root"]) / "native-workspace-status.json").read_text())
    assert status["state"] == "unknown"
    assert status["launcher_pid"] == 12
    assert status["launcher_waited"] is True
    assert not lease._is_terminal_runtime_receipt(status)


def test_active_dependency_change_is_rejected_before_build(layout, monkeypatch):
    monkeypatch.setattr(lease, "validate_bundle", lambda *args: ({"source": {"dependency_source_sha256": "old"}}, {}))
    monkeypatch.setattr(lease, "fingerprint", lambda *args: {"sha256": "changed"})
    active = {"source": {"compiler_profile": "backend-dev"}, "launch_root": str(Path(layout["runtime_root"]) / "native-launch/dev"), "bundle_root": "fixture"}
    with pytest.raises(StorageError, match="save and close"):
        lease.assert_frozen_dependencies(layout, active)
    monkeypatch.setattr(lease, "fingerprint", lambda *args: {"sha256": "old"})
    lease.assert_frozen_dependencies(layout, active)


def test_dev_starts_owned_watcher_after_sealing_and_requests_stop_on_exit(layout, monkeypatch):
    events = []
    class Child:
        pid = 12
        def __init__(self, command, cwd, env):
            self.is_watcher = "--stop-file" in command
            if self.is_watcher:
                assert "FULLMAG_NATIVE_RUNTIME_ACTIVE" not in env
                events.append("watcher")
                self.pid = 13
                self.stop = Path(command[command.index("--stop-file") + 1])
            else:
                Path(env["FULLMAG_NATIVE_RUNTIME_READY_FILE"]).write_text(json.dumps({
                    "schema": "fullmag.native-runtime-ready.v2", "nonce": env["FULLMAG_NATIVE_RUNTIME_NONCE"],
                    "launcher_pid": self.pid, "launch_root": str(Path(layout["runtime_root"]) / "native-launch/dev"), "bundle_root": "fixture"}))
        def poll(self):
            return None
        def wait(self):
            if self.is_watcher:
                assert self.stop.exists()
                events.append("watcher drained")
            else:
                events.append("ui exited")
            return 0
    real_atomic_json = lease.atomic_json
    def record_stop(path, value):
        if Path(path).name.startswith("native-watch-stop-"):
            events.append("stop requested")
        return real_atomic_json(path, value)
    monkeypatch.setattr(lease, "atomic_json", record_stop)
    monkeypatch.setattr(lease.subprocess, "Popen", Child)
    monkeypatch.setattr(lease, "validate_bundle", lambda *args: ({"source": {"backend_source_sha256": "a" * 64}}, {}))
    assert lease.run_sealed_runtime(layout, ["stub", "-Frontend", "dev", "-WebPort", "3197"], {}, "dev") == 0
    assert events == ["watcher", "ui exited", "stop requested", "watcher drained"]
    stops = list(Path(layout["runtime_root"]).glob("native-watch-stop-*.json"))
    assert len(stops) == 1
    assert json.loads(stops[0].read_text())["schema"] == "fullmag.native-watch-stop.v1"


def test_live_manager_in_nonrunning_state_fails_closed_for_new_build(layout, monkeypatch):
    status = Path(layout["runtime_root"]) / "native-workspace-status.json"
    status.write_text(json.dumps({
        "state": "unknown", "pid": 12, "manager_pid": 12, "worktree_id": layout["worktree_id"],
        "repo_root": layout["repo_root"],
    }))
    monkeypatch.setattr(lease, "process_alive", lambda pid: pid == 12)

    with pytest.raises(StorageError, match="still sealing or draining"):
        lease.active_runtime(layout)


def test_dead_manager_with_nonterminal_status_blocks_new_build(layout, monkeypatch):
    status = Path(layout["runtime_root"]) / "native-workspace-status.json"
    status.write_text(json.dumps({
        "state": "running", "pid": 12, "manager_pid": 12, "worktree_id": layout["worktree_id"],
        "repo_root": layout["repo_root"], "launch_root": str(Path(layout["runtime_root"]) / "native-launch/dev"), "bundle_root": "unknown", "launcher_pid": 13,
    }))
    monkeypatch.setattr(lease, "process_alive", lambda _pid: False)

    with pytest.raises(StorageError, match="uncertain owner outcome"):
        lease.active_runtime(layout)


def test_nonterminal_owner_record_blocks_relaunch_before_any_spawn(layout, monkeypatch):
    status = Path(layout["runtime_root"]) / "native-workspace-status.json"
    original = {
        "state": "starting", "pid": 12, "manager_pid": 12, "worktree_id": layout["worktree_id"],
        "repo_root": layout["repo_root"], "launcher_pid": None,
    }
    status.write_text(json.dumps(original))
    before = status.read_bytes()
    monkeypatch.setattr(lease.subprocess, "Popen", lambda *args, **kwargs: pytest.fail("Must not spawn"))

    with pytest.raises(StorageError, match="no verified terminal receipt"):
        lease.run_sealed_runtime(layout, ["stub"], {}, "dev")

    assert status.read_bytes() == before


def test_incomplete_terminal_receipt_is_not_treated_as_quiescent(layout, monkeypatch):
    status = Path(layout["runtime_root"]) / "native-workspace-status.json"
    status.write_text(json.dumps({
        "state": "completed", "pid": 12, "manager_pid": 12, "launcher_pid": 13,
        "launcher_waited": True, "watcher_waited": False, "exit_code": 0,
        "finished_at": "now", "worktree_id": layout["worktree_id"], "repo_root": layout["repo_root"],
    }))
    monkeypatch.setattr(lease, "process_alive", lambda _pid: False)

    with pytest.raises(StorageError, match="not a verified terminal receipt"):
        lease.active_runtime(layout)


def test_terminal_receipt_requires_successful_watcher_exit():
    receipt = {
        "state": "completed", "manager_pid": 10, "launcher_pid": 11,
        "launcher_waited": True, "watcher_waited": True, "watcher_pid": 12,
        "watcher_exit_code": 130, "exit_code": 0, "finished_at": "now",
    }

    assert not lease._is_terminal_runtime_receipt(receipt)


def test_nonzero_watcher_exit_keeps_runtime_unknown(layout, monkeypatch):
    class Child:
        pid = 12

        def __init__(self, command, cwd, env):
            self.is_watcher = "--stop-file" in command
            if self.is_watcher:
                self.pid = 13
                self.stop = Path(command[command.index("--stop-file") + 1])
            else:
                Path(env["FULLMAG_NATIVE_RUNTIME_READY_FILE"]).write_text(json.dumps({
                    "schema": "fullmag.native-runtime-ready.v2",
                    "nonce": env["FULLMAG_NATIVE_RUNTIME_NONCE"],
                    "launcher_pid": self.pid,
                    "launch_root": str(Path(layout["runtime_root"]) / "native-launch/dev"), "bundle_root": "fixture",
                }))

        def poll(self):
            return None

        def wait(self):
            if self.is_watcher:
                assert self.stop.exists()
                return 130
            return 0

    monkeypatch.setattr(lease.subprocess, "Popen", Child)
    monkeypatch.setattr(lease, "validate_bundle", lambda *args: (
        {"source": {"backend_source_sha256": "a" * 64}}, {}))
    monkeypatch.setattr(lease, "assert_no_independent_service", lambda *args, **kwargs: None)

    with pytest.raises(StorageError, match="watcher.*exit code 130"):
        lease.run_sealed_runtime(
            layout, ["stub", "-Frontend", "dev", "-WebPort", "3197"], {}, "dev")

    status = json.loads((Path(layout["runtime_root"]) / "native-workspace-status.json").read_text())
    assert status["state"] == "unknown"
    assert status["watcher_pid"] == 13
    assert status["watcher_exit_code"] == 130
    assert status["watcher_waited"] is True
    assert not lease._is_terminal_runtime_receipt(status)


def test_no_independent_service_passes_when_canonical_owner_files_are_absent(layout):
    assert lease.assert_no_independent_service(layout, environ={}) is None


@pytest.mark.parametrize("owner_name", ["OWNER.json", "OWNER.lock", "LAUNCH.json", "LAUNCH.lock"])
def test_any_canonical_service_owner_or_launch_file_blocks(layout, owner_name):
    service_root = Path(layout["runs_root"]) / "session-store" / "runtime-services"
    service_root.mkdir(parents=True)
    (service_root / owner_name).write_text('{"state":"Drained"}', encoding="utf-8")

    with pytest.raises(StorageError, match="controlled.*drain/recovery"):
        lease.assert_no_independent_service(layout, environ={})


def test_explicit_external_service_config_blocks_without_reading_it(layout, monkeypatch):
    external_config = str(Path(layout["storage_root"]).parent / "external-runtime.json")
    checked_paths = []
    real_validate_path = lease.validate_path

    def observe_validate_path(value, root, label="output path"):
        checked_paths.append(str(value))
        return real_validate_path(value, root, label)

    monkeypatch.setattr(lease, "validate_path", observe_validate_path)
    with pytest.raises(StorageError, match="external runtime-service config.*separate owner handshake"):
        lease.assert_no_independent_service(
            layout, environ={"FULLMAG_RUNTIME_SERVICE_CONFIG": external_config})

    assert all(external_config not in checked for checked in checked_paths)


def test_independent_service_path_validation_error_blocks_with_recovery_diagnostic(layout, monkeypatch):
    real_validate_path = lease.validate_path

    def reject_service_path(value, root, label="output path"):
        if label == "native runtime service owner directory":
            raise StorageError("contains a symlink or reparse point")
        return real_validate_path(value, root, label)

    monkeypatch.setattr(lease, "validate_path", reject_service_path)
    with pytest.raises(StorageError, match="controlled.*drain/recovery"):
        lease.assert_no_independent_service(layout, environ={})


def test_independent_service_stat_error_blocks_with_recovery_diagnostic(layout, monkeypatch):
    service_root = Path(layout["runs_root"]) / "session-store" / "runtime-services"
    service_root.mkdir(parents=True)
    owner_file = service_root / "OWNER.json"
    original_lstat = Path.lstat

    def denied_lstat(path):
        if path == owner_file:
            raise PermissionError("inspection denied")
        return original_lstat(path)

    monkeypatch.setattr(Path, "lstat", denied_lstat)
    with pytest.raises(StorageError, match="Cannot safely inspect.*controlled.*drain/recovery"):
        lease.assert_no_independent_service(layout, environ={})


def test_sealed_runtime_external_config_blocks_before_status_write(layout, monkeypatch):
    monkeypatch.setattr(lease.subprocess, "Popen", lambda *args, **kwargs: pytest.fail("Must not spawn"))

    with pytest.raises(StorageError, match="external runtime-service config"):
        lease.run_sealed_runtime(
            layout, ["stub", "-Frontend", "static"],
            {"FULLMAG_RUNTIME_SERVICE_CONFIG": "C:/outside/service.json"}, "dev")

    assert not (Path(layout["runtime_root"]) / "native-workspace-status.json").exists()


def test_sealed_runtime_rechecks_service_inside_build_lock(layout, monkeypatch):
    calls = []

    def reject_on_second_check(*args, **kwargs):
        calls.append("check")
        if len(calls) == 2:
            raise StorageError("independent service appeared before launch")

    @contextmanager
    def build_lock(_):
        yield

    monkeypatch.setattr(lease, "assert_no_independent_service", reject_on_second_check)
    monkeypatch.setattr(lease, "build_lock", build_lock)
    monkeypatch.setattr(lease.subprocess, "Popen", lambda *args, **kwargs: pytest.fail("Must not spawn"))

    with pytest.raises(StorageError, match="independent service appeared"):
        lease.run_sealed_runtime(layout, ["stub", "-Frontend", "static"], {}, "dev")

    status = json.loads((Path(layout["runtime_root"]) / "native-workspace-status.json").read_text())
    assert calls == ["check", "check"]
    assert status["state"] == "unknown"
    assert not lease._is_terminal_runtime_receipt(status)


def _write_recovery_receipt(layout, *, prior_state="failed", recovery_overrides=None, evidence_overrides=None):
    runtime = Path(layout["runtime_root"])
    prior = {
        "schema": "fullmag_storage_v1", "state": prior_state,
        "worktree_id": layout["worktree_id"], "repo_root": layout["repo_root"],
        "manager_pid": 234308, "exit_code": 1, "finished_at": "2026-10-03T12:16:19+00:00",
    }
    archive = runtime / ("native-runtime-prior-" + "a" * 32 + ".json")
    prior_bytes = json.dumps(prior, sort_keys=True).encode("utf-8")
    archive.write_bytes(prior_bytes)
    evidence = {
        "manager_pid": 234308,
        "manager_process_absent": True,
        "native_executables_absent": True,
        "watcher_processes_absent": True,
        "listener_port_closed": True,
    }
    if evidence_overrides:
        evidence.update(evidence_overrides)
    recovery = {
        "operator": "codex", "checked_at": "2026-10-03T12:30:00+00:00",
        "listener_port": 3197, "archived_status": archive.name,
        "previous_status_sha256": hashlib.sha256(prior_bytes).hexdigest(),
        "evidence": evidence,
    }
    if recovery_overrides:
        recovery.update(recovery_overrides)
    status = runtime / "native-workspace-status.json"
    status.write_text(json.dumps({
        "schema": "fullmag.native-runtime-recovery.v1", "state": "recovered",
        "worktree_id": layout["worktree_id"], "repo_root": layout["repo_root"],
        "recovery": recovery,
    }), encoding="utf-8")
    return status, archive


def test_explicit_recovery_receipt_is_terminal_without_fabricated_wait_proof(layout):
    status, _ = _write_recovery_receipt(layout)
    value = json.loads(status.read_text(encoding="utf-8"))

    assert lease._is_terminal_runtime_receipt(value, status)
    assert lease.active_runtime(layout) is None
    assert "launcher_pid" not in value
    assert "watcher_pid" not in value
    assert "launcher_waited" not in value
    assert "watcher_waited" not in value


@pytest.mark.parametrize("recovery_overrides,evidence_overrides", [
    ({"operator": ""}, None),
    ({"checked_at": "not-a-time"}, None),
    ({"listener_port": True}, None),
    ({"archived_status": "../native-runtime-prior-" + "a" * 32 + ".json"}, None),
    (None, {"manager_process_absent": False}),
    (None, {"native_executables_absent": False}),
    (None, {"watcher_processes_absent": False}),
    (None, {"listener_port_closed": False}),
    (None, {"manager_pid": 42}),
])
def test_malformed_recovery_receipts_do_not_clear_uncertain_status(
        layout, recovery_overrides, evidence_overrides):
    status, _ = _write_recovery_receipt(
        layout, recovery_overrides=recovery_overrides, evidence_overrides=evidence_overrides)
    value = json.loads(status.read_text(encoding="utf-8"))

    assert not lease._is_terminal_runtime_receipt(value, status)
    with pytest.raises(StorageError, match="not a verified terminal receipt"):
        lease.active_runtime(layout)


def test_recovery_receipt_requires_matching_preserved_prior_status(layout):
    status, archive = _write_recovery_receipt(layout)
    archive.write_text('{"changed":true}', encoding="utf-8")
    value = json.loads(status.read_text(encoding="utf-8"))

    assert not lease._is_terminal_runtime_receipt(value, status)


@pytest.mark.parametrize("prior_state", ["completed", ["failed"]])
def test_recovery_receipt_rejects_unexpected_prior_state(layout, prior_state):
    status, _ = _write_recovery_receipt(layout, prior_state=prior_state)
    value = json.loads(status.read_text(encoding="utf-8"))

    assert not lease._is_terminal_runtime_receipt(value, status)


def test_malformed_unhashable_runtime_state_fails_closed(layout):
    status = Path(layout["runtime_root"]) / "native-workspace-status.json"
    status.write_text(json.dumps({
        "schema": "fullmag_storage_v1", "state": [],
        "worktree_id": layout["worktree_id"], "repo_root": layout["repo_root"],
    }), encoding="utf-8")

    with pytest.raises(StorageError, match="not a verified terminal receipt"):
        lease.active_runtime(layout)


def test_controlled_exception_persists_unknown_owner_and_drains_watcher(layout, monkeypatch):
    events = []

    class Child:
        pid = 12
        def __init__(self, command, cwd, env):
            self.is_watcher = "--stop-file" in command
            if self.is_watcher:
                self.pid = 13
                self.stop = Path(command[command.index("--stop-file") + 1])
            else:
                Path(env["FULLMAG_NATIVE_RUNTIME_READY_FILE"]).write_text(json.dumps({
                    "schema": "fullmag.native-runtime-ready.v2", "nonce": env["FULLMAG_NATIVE_RUNTIME_NONCE"],
                    "launcher_pid": self.pid, "launch_root": str(Path(layout["runtime_root"]) / "native-launch/dev"), "bundle_root": "fixture"}))

        def poll(self):
            return None

        def wait(self):
            if self.is_watcher:
                assert self.stop.exists()
                events.append("watcher drained")
                return 0
            raise RuntimeError("launcher observation interrupted")

    monkeypatch.setattr(lease.subprocess, "Popen", Child)
    monkeypatch.setattr(lease, "validate_bundle", lambda *args: ({"source": {"backend_source_sha256": "a" * 64}}, {}))

    with pytest.raises(RuntimeError, match="observation interrupted"):
        lease.run_sealed_runtime(layout, ["stub", "-Frontend", "dev", "-WebPort", "3197"], {}, "dev")

    status = json.loads((Path(layout["runtime_root"]) / "native-workspace-status.json").read_text())
    assert status["state"] == "unknown"
    assert status["manager_pid"] == os.getpid()
    assert status["launcher_pid"] == 12
    assert status["watcher_pid"] == 13
    assert status["watcher_waited"] is True
    assert not lease._is_terminal_runtime_receipt(status)
    assert events == ["watcher drained"]
