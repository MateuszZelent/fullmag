"""Fail-closed interpreted checks for native Windows runtime recovery."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import fullmag_storage as storage
from windows import runtime_lease
import windows.recover_runtime as recovery


class NativeRuntimeRecoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name).resolve()
        repo = root / "project" / "fullmag"
        repo.mkdir(parents=True)
        worktree_id = storage.identifier(repo)
        store = root / "managed-storage"
        (store / "locks").mkdir(parents=True)
        (store / "index").mkdir()
        build_storage = store / "builds"
        build_root = build_storage / worktree_id / recovery.PROFILE
        build_root.mkdir(parents=True)
        runtime_root = store / "runtimes" / worktree_id
        runtime_root.mkdir(parents=True)
        project_root = repo.parent
        (store / ".fullmag-storage.json").write_text(json.dumps({
            "schema": storage.SCHEMA,
            "project_root": str(project_root),
        }), encoding="utf-8")
        (store / "index" / f"{worktree_id}.json").write_text(json.dumps({
            "schema": storage.SCHEMA,
            "worktree_id": worktree_id,
            "repo_root": str(repo),
            "task_id": "fixture-recovery",
            "owner": "test-owner",
            "state": "wip",
        }), encoding="utf-8")
        self.layout = {
            "repo_root": str(repo),
            "project_root": str(project_root),
            "storage_root": str(store),
            "build_storage_root": str(build_storage),
            "build_root": str(build_root),
            "runtime_root": str(runtime_root),
            "worktree_id": worktree_id,
            "profile": recovery.PROFILE,
            "runs_root": str(store / "runs" / worktree_id),
            "managed_ext4": False,
            "env": {},
        }
        self.status = runtime_root / recovery.STATUS_NAME
        self.prior_bytes = (
            '{\n'
            '  "schema": "fullmag_storage_v1",\n'
            f'  "worktree_id": "{worktree_id}",\n'
            f'  "profile": "{recovery.PROFILE}",\n'
            f'  "repo_root": {json.dumps(str(repo))},\n'
            '  "execution_mode": "windows-workspace",\n'
            '  "state": "unknown",\n'
            '  "manager_pid": 20100,\n'
            '  "pid": 20100,\n'
            '  "launcher_pid": 20101,\n'
            '  "watcher_pid": 20102\n'
            '}\n'
        ).encode("utf-8")
        self.status.write_bytes(self.prior_bytes)
        self.snapshot = {
            "schema": recovery.INSPECTION_SCHEMA,
            "processes_complete": True,
            "connections_complete": True,
            "processes": [],
            "connections": [],
        }

    def run_recovery(self, snapshot=None, *, port=3197, environ=None):
        captured = self.snapshot if snapshot is None else snapshot
        return recovery.recover(
            self.layout,
            port,
            snapshot_provider=lambda _layout, _port: captured,
            environ=environ,
        )

    def test_success_archives_exact_prior_bytes_and_publishes_validator_accepted_receipt(self):
        owner_path = Path(self.layout["storage_root"]) / "index" / f"{self.layout['worktree_id']}.json"
        owner_digest = hashlib.sha256(owner_path.read_bytes()).hexdigest()
        result = self.run_recovery()

        archive = Path(result["archive"])
        self.assertEqual(archive.parent, self.status.parent)
        self.assertEqual(archive.read_bytes(), self.prior_bytes)
        value = json.loads(self.status.read_text(encoding="utf-8"))
        self.assertTrue(runtime_lease._is_terminal_runtime_receipt(value, self.status))
        self.assertEqual(value["recovery"]["previous_status_sha256"], result["previous_status_sha256"])
        self.assertEqual(value["recovery"]["evidence"]["recorded_processes_absent"], True)
        self.assertEqual(value["recovery"]["owner_registry"]["sha256"], owner_digest)
        self.assertEqual(value["recovery"]["owner_registry"]["state"], "wip")
        self.assertIsNone(runtime_lease.active_runtime(self.layout))

    def test_known_system_idle_process_pid_zero_is_the_only_accepted_zero_pid_row(self):
        snapshot = {**self.snapshot, "processes": [{
            "process_id": 0,
            "name": "System Idle Process",
            "executable_path": None,
            "command_line": None,
        }]}

        self.assertEqual(self.run_recovery(snapshot)["state"], "recovered")

    def test_registry_must_be_active_or_wip_for_the_exact_repository_and_worktree(self):
        registry = Path(self.layout["storage_root"]) / "index" / f"{self.layout['worktree_id']}.json"
        original = registry.read_bytes()
        for field, invalid in (("state", "completed"),
                               ("repo_root", str(registry.parent)),
                               ("worktree_id", "foreign-worktree")):
            with self.subTest(field=field):
                value = json.loads(original)
                value[field] = invalid
                registry.write_text(json.dumps(value), encoding="utf-8")
                with self.assertRaisesRegex(recovery.RecoveryError, "active/wip owner"):
                    self.run_recovery()
                self.assertEqual(self.status.read_bytes(), self.prior_bytes)
                self.assertEqual(list(self.status.parent.glob("native-runtime-prior-*.json")), [])
        registry.write_bytes(original)

    def test_any_recorded_pid_blocks_even_when_the_pid_is_reused_by_an_unrelated_process(self):
        snapshot = {**self.snapshot, "processes": [{
            "process_id": 20101,
            "name": "notepad.exe",
            "executable_path": "C:\\Windows\\System32\\notepad.exe",
            "command_line": "notepad.exe",
        }]}

        with self.assertRaisesRegex(recovery.RecoveryError, "reused"):
            self.run_recovery(snapshot)
        self.assertEqual(self.status.read_bytes(), self.prior_bytes)
        self.assertEqual(list(self.status.parent.glob("native-runtime-prior-*.json")), [])

    def test_fullmag_native_executable_for_this_build_profile_blocks_recovery(self):
        executable = Path(self.layout["build_root"]) / "cargo-target" / "x86_64-pc-windows-msvc" / "backend-dev" / "fullmag-api.exe"
        snapshot = {**self.snapshot, "processes": [{
            "process_id": 30500,
            "name": "fullmag-api.exe",
            "executable_path": str(executable),
            "command_line": str(executable),
        }]}

        with self.assertRaisesRegex(recovery.RecoveryError, "Fullmag executable is still running"):
            self.run_recovery(snapshot)
        self.assertEqual(self.status.read_bytes(), self.prior_bytes)

    def test_python_watcher_for_this_checkout_blocks_recovery(self):
        repo = Path(self.layout["repo_root"])
        watcher = repo / "scripts" / "windows" / "watch_backend.py"
        snapshot = {**self.snapshot, "processes": [{
            "process_id": 30600,
            "name": "python.exe",
            "executable_path": "C:\\Python\\python.exe",
            "command_line": f'python.exe "{watcher}" --repo-root "{repo}" --web-port 3197',
        }]}

        with self.assertRaisesRegex(recovery.RecoveryError, "watcher is still running"):
            self.run_recovery(snapshot)
        self.assertEqual(self.status.read_bytes(), self.prior_bytes)

    def test_unreadable_candidate_identity_fails_closed(self):
        snapshot = {**self.snapshot, "processes": [{
            "process_id": 30700,
            "name": "fullmag-ui.exe",
            "executable_path": None,
            "command_line": None,
        }]}

        with self.assertRaisesRegex(recovery.RecoveryError, "Cannot inspect the executable path"):
            self.run_recovery(snapshot)
        self.assertEqual(self.status.read_bytes(), self.prior_bytes)

    def test_unreadable_python_command_line_does_not_prove_watcher_absence(self):
        snapshot = {**self.snapshot, "processes": [{
            "process_id": 30800,
            "name": "python3.13.exe",
            "executable_path": "C:\\Python\\python3.13.exe",
            "command_line": None,
        }]}

        with self.assertRaisesRegex(recovery.RecoveryError, "watcher absence is unproven"):
            self.run_recovery(snapshot)
        self.assertEqual(self.status.read_bytes(), self.prior_bytes)

    def test_requested_port_listener_blocks_but_unrelated_foreign_port_is_preserved(self):
        snapshot = {**self.snapshot, "connections": [{
            "local_port": 3197, "state": "Listen", "process_id": 40000,
        }]}
        with self.assertRaisesRegex(recovery.RecoveryError, "port 3197 is not closed"):
            self.run_recovery(snapshot)
        self.assertEqual(self.status.read_bytes(), self.prior_bytes)

        foreign = {**self.snapshot,
                   "processes": [{
                       "process_id": 40908, "name": "foreign-service.exe",
                       "executable_path": "C:\\Tools\\foreign-service.exe",
                       "command_line": "foreign-service.exe",
                   }],
                   "connections": [{
                       "local_port": 3104, "state": "Listen", "process_id": 40908,
                   }]}
        result = self.run_recovery(foreign)
        self.assertEqual(result["state"], "recovered")
        self.assertEqual(foreign["connections"][0]["local_port"], 3104)

    def test_incomplete_or_failed_inspection_retains_status_without_archive(self):
        incomplete = {**self.snapshot, "processes_complete": False}
        with self.assertRaisesRegex(recovery.RecoveryError, "inspection was incomplete"):
            self.run_recovery(incomplete)
        with self.assertRaisesRegex(recovery.RecoveryError, "no absence was inferred"):
            recovery.recover(
                self.layout, 3197,
                snapshot_provider=lambda _layout, _port: (_ for _ in ()).throw(OSError("CIM denied")),
            )
        self.assertEqual(self.status.read_bytes(), self.prior_bytes)
        self.assertEqual(list(self.status.parent.glob("native-runtime-prior-*.json")), [])

    def test_status_owner_mismatch_external_service_and_concurrent_change_block(self):
        original = self.status.read_bytes()
        value = json.loads(original)
        value["profile"] = "windows-native-fdm-cpu"
        self.status.write_text(json.dumps(value), encoding="utf-8")
        with self.assertRaisesRegex(recovery.RecoveryError, "different storage profile"):
            self.run_recovery()

        self.status.write_bytes(original)
        with self.assertRaisesRegex(storage.StorageError, "external runtime-service config"):
            self.run_recovery(environ={"FULLMAG_RUNTIME_SERVICE_CONFIG": "configured"})

        def mutate_status(_layout, _port):
            self.status.write_bytes(original + b" ")
            return self.snapshot

        with self.assertRaisesRegex(recovery.RecoveryError, "changed during inspection"):
            recovery.recover(self.layout, 3197, snapshot_provider=mutate_status)
        self.assertEqual(self.status.read_bytes(), original + b" ")
        self.assertEqual(list(self.status.parent.glob("native-runtime-prior-*.json")), [])

    def test_status_reparse_path_is_rejected(self):
        target = self.status.with_name("status-target.json")
        target.write_bytes(self.prior_bytes)
        self.status.unlink()
        try:
            self.status.symlink_to(target)
        except OSError as error:
            self.skipTest(f"File symlinks are unavailable: {error}")

        with self.assertRaises(storage.StorageError):
            self.run_recovery()
        self.assertEqual(target.read_bytes(), self.prior_bytes)

    def test_archive_publication_is_exclusive(self):
        target = self.status.parent / "native-runtime-prior-" / "archive.json"
        target.parent.mkdir()
        target.write_bytes(b"preserve")

        with self.assertRaisesRegex(recovery.RecoveryError, "already exists"):
            recovery._write_atomic_exclusive(target, b"replacement")
        self.assertEqual(target.read_bytes(), b"preserve")


if __name__ == "__main__":
    unittest.main()
