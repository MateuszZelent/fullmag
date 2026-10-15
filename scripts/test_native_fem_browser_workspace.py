"""Interpreted admission checks for the source-first native FEM browser workspace."""

from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import fullmag_storage as storage  # noqa: E402
from _native_fem_test_fixtures import native_fem_manifest  # noqa: E402
from windows import dispatch_native_fem_recipe as dispatcher  # noqa: E402


class NativeFemBrowserWorkspaceTests(unittest.TestCase):
    @staticmethod
    def _unlocked(*_args, **_kwargs):
        @contextmanager
        def scope():
            yield

        return scope()

    @staticmethod
    def _fake_git(_repo, *args):
        if args == ("rev-parse", "HEAD"):
            return "0" * 40
        if args == ("status", "--porcelain", "--untracked-files=normal"):
            return ""
        raise AssertionError(args)

    def _fixture_layout(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        project = Path(temporary.name).resolve()
        repo = project / "fullmag"
        repo.mkdir()
        subprocess.run(["git", "init", "--quiet", str(repo)], check=True)
        launcher = repo / "scripts/windows/run_fullmag.ps1"
        launcher.parent.mkdir(parents=True)
        launcher.write_text("# fixture native FEM launcher\n", encoding="utf-8")
        return storage.resolve_layout(repo, profile="windows-native-fem-gpu", environ={})

    @staticmethod
    def _browser_manifest(layout, child_env, frontend="dev"):
        manifest = native_fem_manifest(
            layout,
            child_env["FULLMAG_NATIVE_FEM_ATTEMPT_ID"],
            child_env["FULLMAG_FEM_REQUESTED_DEVICE"],
        )
        build = Path(layout["build_root"])
        workspace = build / "frontend-sources" / "fixture" / "workspace"
        cache = build / "frontend" / "workspace" / "fixture"
        app_root = workspace / "apps" / "control-room"
        app_root.mkdir(parents=True, exist_ok=True)
        cache.mkdir(parents=True, exist_ok=True)
        if frontend == "static":
            static_root = cache / "out"
            static_root.mkdir(parents=True, exist_ok=True)
            (static_root / "assets").mkdir()
            (static_root / "index.html").write_text(
                "<!doctype html><script src=assets/main.js></script>\n", encoding="utf-8"
            )
            (static_root / "assets" / "main.js").write_text(
                "console.log('fixture static browser workspace');\n", encoding="utf-8"
            )
            entry = static_root / "index.html"
            records = []
            for path in sorted(static_root.rglob("*"), key=lambda item: str(item).casefold()):
                if path.is_file():
                    relative = path.relative_to(static_root).as_posix()
                    digest = hashlib.sha256(path.read_bytes()).hexdigest()
                    records.append(f"{relative}|{digest}")
            static_hash = hashlib.sha256(("".join(record + "\n" for record in records)).encode("utf-8")).hexdigest()
        else:
            entry = app_root / "dev-server.mjs"
            entry.write_text("console.log('fixture browser workspace');\n", encoding="utf-8")
            static_hash = None
        source_manifest = build / "frontend-sources" / "fixture" / "frontend-source-manifest.json"
        source_manifest.write_text('{"schema":"fixture"}\n', encoding="utf-8")
        manifest.update(
            {
                "ui_host": "browser",
                "workspace_mode": "empty",
                "browser_workspace": True,
                "frontend_mode": frontend,
                "frontend_workspace_root": str(workspace),
                "frontend_cache_root": str(cache),
                "frontend_source_manifest": str(source_manifest),
                "frontend_source_manifest_sha256": hashlib.sha256(source_manifest.read_bytes()).hexdigest(),
                "frontend_entry_path": str(entry),
                "frontend_entry_sha256": hashlib.sha256(entry.read_bytes()).hexdigest(),
                "static_web_sha256": static_hash,
                "desktop_binary": None,
                "desktop_binary_sha256": None,
            }
        )
        return (json.dumps(manifest) + "\n").encode("utf-8")

    def test_build_then_runtime_uses_browser_cli_without_fdm_workspace_lease(self):
        layout = self._fixture_layout()
        manifest = Path(layout["build_root"]) / "windows-fem-runtime" / "build-manifest.json"
        calls = []
        heavy_calls = []
        manifest_sha = None

        @contextmanager
        def tracked_heavy(*_args, **kwargs):
            heavy_calls.append(kwargs.get("native_user_build"))
            yield

        def fake_build(command, _repo, child_env, _log, **_kwargs):
            nonlocal manifest_sha
            calls.append((command, child_env))
            if "-BuildOnly" in command:
                manifest.parent.mkdir(parents=True, exist_ok=True)
                raw = self._browser_manifest(layout, child_env)
                manifest.write_bytes(raw)
                manifest_sha = hashlib.sha256(raw).hexdigest()
            return subprocess.CompletedProcess(command, 0)

        with patch.object(storage, "_is_native_windows", return_value=True), \
             patch.object(storage, "file_lock", self._unlocked), \
             patch.object(storage, "managed_heavy_lock", tracked_heavy), \
             patch.object(storage, "git", side_effect=self._fake_git), \
             patch.object(storage, "_run_logged_command", side_effect=fake_build):
            result = storage.run_windows_fem_workspace(
                layout,
                frontend="dev",
                device="gpu",
                web_port=0,
                build_mode="true",
                build_only=False,
            )

        self.assertEqual(result, 0)
        self.assertEqual(len(calls), 2)
        self.assertEqual(heavy_calls, [True])
        build_command, _ = calls[0]
        runtime_command, _ = calls[1]
        self.assertIn("-Browser", build_command)
        self.assertIn("-Browser", runtime_command)
        self.assertIn("-BuildOnly", build_command)
        self.assertNotIn("-BuildOnly", runtime_command)
        self.assertNotIn("-ScriptPath", build_command)
        self.assertNotIn("-OutputDir", build_command)
        self.assertEqual(build_command[build_command.index("-WebPort") + 1], "0")
        self.assertEqual(
            runtime_command[runtime_command.index("-ExpectedBuildId") + 1], manifest_sha
        )
        receipt = json.loads(
            (Path(layout["runtime_root"]) / "native-fem-receipt.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(receipt["execution_mode"], "windows-fem-workspace")
        self.assertEqual(receipt["ui_host"], "browser")
        self.assertEqual(receipt["workspace_mode"], "empty")
        self.assertTrue(receipt["browser_workspace"])
        self.assertIsNone(receipt["script"])
        self.assertIsNone(receipt["output_dir"])
        self.assertEqual(receipt["web_port"], 0)
        self.assertEqual(receipt["state"], "completed")

    def test_browser_admission_rejects_old_headless_manifest(self):
        layout = self._fixture_layout()
        manifest = native_fem_manifest(layout, "a" * 32)
        with patch.object(storage, "_is_native_windows", return_value=True):
            with self.assertRaisesRegex(storage.StorageError, "browser workspace marker"):
                storage.validate_fem_terminal_manifest(
                    layout, manifest, "gpu", "gpu", "a" * 32,
                    browser_workspace=True, browser_frontend="dev"
                )

    def test_static_browser_admission_hashes_complete_tree(self):
        layout = self._fixture_layout()
        manifest = json.loads(self._browser_manifest(
            layout,
            {
                "FULLMAG_NATIVE_FEM_ATTEMPT_ID": "a" * 32,
                "FULLMAG_FEM_REQUESTED_DEVICE": "gpu",
            },
            frontend="static",
        ))
        with patch.object(storage, "_is_native_windows", return_value=True):
            storage.validate_fem_terminal_manifest(
                layout, manifest, "gpu", "gpu", "a" * 32,
                browser_workspace=True, browser_frontend="static",
            )

    def test_static_browser_admission_rejects_mutated_non_entry_asset(self):
        layout = self._fixture_layout()
        manifest = json.loads(self._browser_manifest(
            layout,
            {
                "FULLMAG_NATIVE_FEM_ATTEMPT_ID": "a" * 32,
                "FULLMAG_FEM_REQUESTED_DEVICE": "gpu",
            },
            frontend="static",
        ))
        static_root = Path(manifest["frontend_cache_root"]) / "out"
        (static_root / "assets" / "main.js").write_text(
            "console.log('mutated after receipt');\n", encoding="utf-8"
        )
        with patch.object(storage, "_is_native_windows", return_value=True):
            with self.assertRaisesRegex(storage.StorageError, "static frontend tree changed"):
                storage.validate_fem_terminal_manifest(
                    layout, manifest, "gpu", "gpu", "a" * 32,
                    browser_workspace=True, browser_frontend="static",
                )

    def test_browser_admission_uses_requested_frontend_mode(self):
        layout = self._fixture_layout()
        manifest = json.loads(self._browser_manifest(
            layout,
            {
                "FULLMAG_NATIVE_FEM_ATTEMPT_ID": "a" * 32,
                "FULLMAG_FEM_REQUESTED_DEVICE": "gpu",
            },
            frontend="dev",
        ))
        with patch.object(storage, "_is_native_windows", return_value=True):
            with self.assertRaisesRegex(storage.StorageError, "does not match the requested frontend mode"):
                storage.validate_fem_terminal_manifest(
                    layout, manifest, "gpu", "gpu", "a" * 32,
                    browser_workspace=True, browser_frontend="static",
                )

    def test_browser_build_rejects_headless_manifest_before_runtime_admission(self):
        layout = self._fixture_layout()
        manifest_path = Path(layout["build_root"]) / "windows-fem-runtime" / "build-manifest.json"
        calls = []

        def fake_build(command, _repo, child_env, _log, **_kwargs):
            calls.append(command)
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            manifest_path.write_text(
                json.dumps(native_fem_manifest(layout, child_env["FULLMAG_NATIVE_FEM_ATTEMPT_ID"])) + "\n",
                encoding="utf-8",
            )
            return subprocess.CompletedProcess(command, 0)

        with patch.object(storage, "_is_native_windows", return_value=True), \
             patch.object(storage, "file_lock", self._unlocked), \
             patch.object(storage, "git", side_effect=self._fake_git), \
             patch.object(storage, "_run_logged_command", side_effect=fake_build):
            result = storage.run_windows_fem_workspace(
                layout,
                frontend="dev",
                device="gpu",
                web_port=0,
                build_mode="true",
                build_only=False,
            )

        self.assertEqual(result, 1)
        self.assertEqual(len(calls), 1)
        self.assertIn("-BuildOnly", calls[0])
        receipt = json.loads(
            (Path(layout["runtime_root"]) / "native-fem-receipt.json").read_text(encoding="utf-8")
        )
        self.assertEqual(receipt["state"], "failed")
        self.assertIsNone(receipt["build_manifest_sha256"])

    def test_expected_build_id_mismatch_is_rejected_before_child_launch(self):
        layout = self._fixture_layout()
        manifest_path = Path(layout["build_root"]) / "windows-fem-runtime" / "build-manifest.json"
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_bytes(b'{"manifest":"current"}\n')
        calls = []

        def fake_child(*args, **_kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args[0], 0)

        with patch.object(storage, "_is_native_windows", return_value=True), \
             patch.object(storage, "file_lock", self._unlocked), \
             patch.object(storage, "git", side_effect=self._fake_git), \
             patch.object(storage, "_run_logged_command", side_effect=fake_child):
            with self.assertRaisesRegex(storage.StorageError, "does not match the native build manifest"):
                storage.run_windows_fem_workspace(
                    layout,
                    frontend="dev",
                    device="gpu",
                    web_port=0,
                    build_mode="false",
                    expected_build_id="f" * 64,
                )

        self.assertEqual(calls, [])

    def test_dispatcher_browser_requires_explicit_empty_workspace(self):
        repo = Path("/tmp/fullmag-browser-dispatch-fixture").resolve()
        accepted = dispatcher._parse_options(
            [
                "--build=true",
                "--windows=true",
                "--backend=fem",
                "--device=gpu",
                "--frontend=static",
                "--mode=workspace",
                "--web-port=0",
                "--browser",
            ],
            repo,
        )
        self.assertTrue(accepted.browser)
        self.assertEqual(accepted.run_mode, "workspace")
        self.assertIsNone(accepted.script)
        with self.assertRaisesRegex(dispatcher.DispatchError, "requires fem, workspace mode"):
            dispatcher._parse_options(
                ["--windows=true", "--backend=fem", "--device=gpu", "--mode=headless", "--browser", "examples/a.py"],
                repo,
            )


if __name__ == "__main__":
    unittest.main()
