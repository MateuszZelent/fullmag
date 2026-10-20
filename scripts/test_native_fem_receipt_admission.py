"""Regression checks for native FEM receipt admission correlation."""

import json
from contextlib import contextmanager
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import fullmag_storage as storage  # noqa: E402
from _native_fem_test_fixtures import manifest_bytes, native_fem_manifest


class NativeFemReceiptAdmissionTests(unittest.TestCase):
    def test_lock_admission_failure_cannot_reuse_previous_completed_status(self):
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary).resolve()
            repo = project / "fullmag"
            repo.mkdir()
            subprocess.run(["git", "init", "--quiet", str(repo)], check=True)
            launcher = repo / "scripts/windows/run_fullmag.ps1"
            launcher.parent.mkdir(parents=True)
            launcher.write_text("# fixture native FEM launcher\n", encoding="utf-8")
            script = repo / "examples/problem.py"
            script.parent.mkdir()
            script.write_text("print('fixture')\n", encoding="utf-8")
            layout = storage.resolve_layout(
                repo, profile="windows-native-fem-gpu", environ={}
            )
            storage.initialize(layout)
            status_path = Path(layout["build_root"]) / "build-status.json"
            status_path.write_text(json.dumps({
                "schema": storage.SCHEMA,
                "worktree_id": layout["worktree_id"],
                "profile": layout["profile"],
                "repo_root": layout["repo_root"],
                "execution_mode": "windows-fem-build",
                "attempt_id": "previous-attempt",
                "state": "completed",
                "exit_code": 0,
                "build_manifest_sha256": "a" * 64,
                "started_at": "previous-start",
                "finished_at": "previous-finish",
            }), encoding="utf-8")

            @contextmanager
            def reject_admission(*_args, **_kwargs):
                raise storage.StorageError("busy before admission")
                yield

            with patch.object(storage, "_is_native_windows", return_value=True), \
                 patch.object(storage, "managed_heavy_lock", reject_admission), \
                 patch.object(storage, "_run_logged_command") as build:
                with self.assertRaisesRegex(storage.StorageError, "busy before admission"):
                    storage.run_windows_fem(
                        layout,
                        frontend="dev",
                        device="gpu",
                        run_mode="headless",
                        script_path="examples/problem.py",
                        build_mode="true",
                        build_only=True,
                    )

            build.assert_not_called()
            evidence = sorted(Path(layout["runtime_root"]).glob("native-fem-receipt-*.json"))
            self.assertEqual(len(evidence), 1)
            receipt = json.loads(evidence[0].read_text(encoding="utf-8"))
            self.assertEqual(receipt["state"], "interrupted")
            self.assertNotEqual(receipt["attempt_id"], "previous-attempt")
            self.assertIsNone(receipt["build_manifest_sha256"])
            self.assertNotEqual(receipt["started_at"], "previous-start")
            self.assertNotEqual(receipt["finished_at"], "previous-finish")
            self.assertFalse((Path(layout["runtime_root"]) / "native-fem-receipt.json").exists())

    def _new_fixture(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        project = Path(temporary.name).resolve()
        repo = project / "fullmag"
        repo.mkdir()
        subprocess.run(["git", "init", "--quiet", str(repo)], check=True)
        launcher = repo / "scripts/windows/run_fullmag.ps1"
        launcher.parent.mkdir(parents=True)
        launcher.write_text("# fixture native FEM launcher\n", encoding="utf-8")
        script = repo / "examples/problem.py"
        script.parent.mkdir()
        script.write_text("print('fixture')\n", encoding="utf-8")
        return storage.resolve_layout(repo, profile="windows-native-fem-gpu", environ={})

    @staticmethod
    def _fake_git(_repo, *args):
        if args == ("rev-parse", "HEAD"):
            return "0" * 40
        if args == ("status", "--porcelain", "--untracked-files=normal"):
            return ""
        raise AssertionError(args)

    @staticmethod
    def _unlocked(*_args, **_kwargs):
        @contextmanager
        def scope():
            yield
        return scope()

    def test_build_then_runtime_pins_manifest_and_releases_heavy_slot(self):
        layout = self._new_fixture()
        manifest = Path(layout["build_root"]) / "windows-fem-runtime" / "build-manifest.json"
        manifest_raw = None
        manifest_sha = None
        calls = []
        heavy_calls = []

        @contextmanager
        def tracked_heavy(*_args, **kwargs):
            heavy_calls.append(kwargs.get("native_user_build"))
            yield

        def fake_build(command, _repo, child_env, _log, **_kwargs):
            nonlocal manifest_raw, manifest_sha
            calls.append((command, child_env))
            if "-BuildOnly" in command:
                self.assertEqual(command[command.index("-BuildMode") + 1], "true")
                manifest.parent.mkdir(parents=True, exist_ok=True)
                manifest_raw = manifest_bytes(layout, child_env)
                manifest_sha = hashlib.sha256(manifest_raw).hexdigest()
                manifest.write_bytes(manifest_raw)
            else:
                self.assertEqual(command[command.index("-BuildMode") + 1], "false")
                self.assertNotIn("-BuildOnly", command)
                self.assertEqual(
                    command[command.index("-ExpectedBuildId") + 1], manifest_sha
                )
                self.assertEqual(child_env["FULLMAG_STORAGE_MANAGED_ENTRY"], "1")
            return subprocess.CompletedProcess(command, 0)

        with patch.object(storage, "_is_native_windows", return_value=True), \
             patch.object(storage, "file_lock", self._unlocked), \
             patch.object(storage, "managed_heavy_lock", tracked_heavy), \
             patch.object(storage, "git", side_effect=self._fake_git), \
             patch.object(storage, "_run_logged_command", side_effect=fake_build):
            result = storage.run_windows_fem(
                layout,
                frontend="dev",
                device="gpu",
                run_mode="headless",
                script_path="examples/problem.py",
                build_mode="true",
                build_only=False,
            )

        self.assertEqual(result, 0)
        self.assertEqual(len(calls), 2)
        self.assertEqual(heavy_calls, [True])
        receipt = json.loads(
            (Path(layout["runtime_root"]) / "native-fem-receipt.json")
            .read_text(encoding="utf-8")
        )
        self.assertEqual(receipt["state"], "completed")
        self.assertEqual(receipt["build_mode"], "true")
        self.assertFalse(receipt["build_only"])
        self.assertEqual(receipt["execution_mode"], "windows-fem")
        self.assertEqual(receipt["build_manifest_sha256"], manifest_sha)

    def test_runtime_admission_failure_does_not_launch_after_build_phase(self):
        layout = self._new_fixture()
        manifest = Path(layout["build_root"]) / "windows-fem-runtime" / "build-manifest.json"

        calls = []
        heavy_calls = []
        build_lock_calls = []

        @contextmanager
        def tracked_heavy(*_args, **kwargs):
            heavy_calls.append(kwargs.get("native_user_build"))
            yield

        @contextmanager
        def reject_runtime_lock(*_args, **_kwargs):
            build_lock_calls.append(True)
            if len(build_lock_calls) == 2:
                raise storage.StorageError("runtime busy before admission")
            yield

        def fake_build(command, _repo, child_env, _log, **_kwargs):
            calls.append(command)
            manifest.parent.mkdir(parents=True, exist_ok=True)
            manifest.write_bytes(manifest_bytes(layout, child_env))
            return subprocess.CompletedProcess(command, 0)

        with patch.object(storage, "_is_native_windows", return_value=True), \
             patch.object(storage, "file_lock", self._unlocked), \
             patch.object(storage, "managed_heavy_lock", tracked_heavy), \
             patch.object(storage, "build_lock", reject_runtime_lock), \
             patch.object(storage, "git", side_effect=self._fake_git), \
             patch.object(storage, "_run_logged_command", side_effect=fake_build):
            with self.assertRaisesRegex(storage.StorageError, "runtime busy before admission"):
                storage.run_windows_fem(
                    layout,
                    frontend="dev",
                    device="gpu",
                    run_mode="headless",
                    script_path="examples/problem.py",
                    build_mode="true",
                    build_only=False,
                )

        # Build phase, rejected runtime admission, and receipt publication each
        # enter the shared lock; publication must not reuse the build receipt.
        self.assertEqual(len(build_lock_calls), 3)
        self.assertEqual(len(calls), 1)
        self.assertEqual(heavy_calls, [True])
        status = json.loads(
            (Path(layout["build_root"]) / "build-status.json")
            .read_text(encoding="utf-8")
        )
        evidence = sorted(Path(layout["runtime_root"]).glob("native-fem-receipt-*.json"))
        self.assertEqual(len(evidence), 1)
        receipt = json.loads(evidence[0].read_text(encoding="utf-8"))
        self.assertEqual(status["state"], "completed")
        self.assertEqual(receipt["state"], "interrupted")
        self.assertNotEqual(receipt["attempt_id"], status["attempt_id"])
        self.assertIsNone(receipt["build_manifest_sha256"])
        self.assertFalse((Path(layout["runtime_root"]) / "native-fem-receipt.json").exists())

    def test_existing_runtime_never_acquires_native_heavy_slot(self):
        layout = self._new_fixture()
        storage.initialize(layout)
        manifest = Path(layout["build_root"]) / "windows-fem-runtime" / "build-manifest.json"
        manifest_raw = (json.dumps(native_fem_manifest(layout, "e" * 32)) + "\n").encode()
        manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest.write_bytes(manifest_raw)
        calls = []
        heavy_calls = []

        @contextmanager
        def tracked_heavy(*_args, **kwargs):
            heavy_calls.append(kwargs.get("native_user_build"))
            yield

        def fake_runtime(command, _repo, child_env, _log, **_kwargs):
            calls.append((command, child_env))
            self.assertEqual(command[command.index("-BuildMode") + 1], "false")
            self.assertNotIn("-BuildOnly", command)
            self.assertEqual(child_env["FULLMAG_STORAGE_MANAGED_ENTRY"], "1")
            return subprocess.CompletedProcess(command, 0)

        with patch.object(storage, "_is_native_windows", return_value=True), \
             patch.object(storage, "file_lock", self._unlocked), \
             patch.object(storage, "managed_heavy_lock", tracked_heavy), \
             patch.object(storage, "git", side_effect=self._fake_git), \
             patch.object(storage, "_run_logged_command", side_effect=fake_runtime):
            result = storage.run_windows_fem(
                layout,
                frontend="dev",
                device="gpu",
                run_mode="headless",
                script_path="examples/problem.py",
                build_mode="false",
                build_only=False,
            )

        self.assertEqual(result, 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(heavy_calls, [])
        receipt = json.loads(
            (Path(layout["runtime_root"]) / "native-fem-receipt.json")
            .read_text(encoding="utf-8")
        )
        self.assertEqual(receipt["state"], "completed")
        self.assertEqual(receipt["build_manifest_sha256"], hashlib.sha256(manifest_raw).hexdigest())


if __name__ == "__main__":
    unittest.main()
