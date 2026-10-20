#!/usr/bin/env python3
"""Interpreted regression checks; no compiler, Docker or GPU required."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import os
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import docker_dev_defaults as defaults
import setup_docker as setup


class SetupDockerChecks(unittest.TestCase):
    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux filesystem validation")
    def test_linux_volume_accepts_local_filesystem_and_rejects_network_storage(self):
        with patch.object(setup.storage, "filesystem_type", return_value="ext4"):
            setup.validate_host_volume(Path("/home/operator/project-data"))
        with patch.object(setup.storage, "filesystem_type", return_value="cifs"):
            with self.assertRaisesRegex(setup.SetupError, "cifs"):
                setup.validate_host_volume(Path("/home/operator/project-data"))

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux filesystem validation")
    def test_linux_configuration_rejects_volatile_paths(self):
        with self.assertRaisesRegex(setup.SetupError, "trwałego"):
            setup.validate_host_volume(Path("/tmp/fullmag-config"))

    def test_windows_volume_admission_is_preserved(self):
        root = Path.cwd()
        with patch.object(setup.os, "name", "nt"), \
             patch.object(setup, "validate_windows_volume") as admit:
            setup.validate_host_volume(root)
        admit.assert_called_once_with(root)

    def test_wsl_wizard_can_save_configuration_without_windows_admission(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory).resolve()
            main = project / "repo"
            main.mkdir()
            subprocess.run(["git", "init", "--quiet", str(main)], check=True)
            original = b"POSTGRES_PASSWORD=keep\nMINIO_ROOT_USER=keep\nMINIO_ROOT_PASSWORD=keep\nEXTRA=preserved\n"
            (main / ".env").write_bytes(original)
            checks = {"platform": "wsl"}
            output = io.StringIO()
            with patch.object(setup, "host_checks", return_value=checks), \
                 patch.object(setup, "show_checks"), \
                 patch.object(setup, "validate_host_volume"), \
                 patch.object(setup.sys.stdin, "isatty", return_value=True), \
                 patch("builtins.input", side_effect=[str(project / "data"), "", "", "t"]), \
                 contextlib.redirect_stdout(output):
                self.assertEqual(setup.main(["--repo-root", str(main)]), 0)
            settings = json.loads((project / "data/index/docker-host-settings.json").read_text())
            self.assertEqual(settings["source_root"], str(main))
            self.assertFalse(settings["application_ready"])
            self.assertIn(b"EXTRA=preserved", (main / ".env").read_bytes())
            self.assertEqual(setup.dotenv_values((main / ".env").read_bytes())["POSTGRES_PASSWORD"], "keep")
            self.assertIn("just docker-dev ", output.getvalue())
            self.assertIn("just docker-dev-toolchain", output.getvalue())

    def test_linux_check_accepts_configured_host_without_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory).resolve()
            main = project / "repo"
            main.mkdir()
            subprocess.run(["git", "init", "--quiet", str(main)], check=True)
            (main / "compose.dev.yaml").touch()
            (main / ".env.example").write_text("POSTGRES_PASSWORD=\nMINIO_ROOT_USER=\nMINIO_ROOT_PASSWORD=\n")
            checks = {name: {"state": "available"} for name in ("git", "just", "docker", "compose")}
            checks.update(platform="wsl", docker_os={"value": "linux"})
            isolated = {key: value for key, value in os.environ.items()
                        if key not in setup.storage.MANAGED_VARIABLES and key not in {"GIT_DIR", "GIT_WORK_TREE"}}
            with patch.dict(os.environ, isolated, clear=True), patch.object(setup, "validate_host_volume"):
                setup.apply_configuration(setup.plan(main, str(project / "data"), str(main), 3197))
                original = (main / ".env").read_bytes()
                saved = (project / "data/index/docker-host-settings.json").read_bytes()
                with patch.object(setup, "host_checks", return_value=checks), \
                     patch.object(setup, "show_checks"), contextlib.redirect_stdout(io.StringIO()), \
                     contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(setup.main(["--repo-root", str(main), "--check"]), 0)
                    self.assertEqual(setup.main(["--repo-root", str(main), "--check",
                                                "--source-root", str(project / "foreign")]), 2)
            self.assertEqual((main / ".env").read_bytes(), original)
            self.assertEqual((project / "data/index/docker-host-settings.json").read_bytes(), saved)

    def test_apply_rechecks_source_before_writing_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory).resolve()
            main = project / "repo"
            main.mkdir()
            source = project / "source"
            source.mkdir()
            original = b"POSTGRES_PASSWORD=keep\n"
            (main / ".env").write_bytes(original)
            context = {"repo": main, "main": main, "project": project, "checkouts": [main, source]}
            with patch.object(setup, "checkout_context", return_value=context), \
                 patch.object(setup, "validate_host_volume"):
                prepared = setup.plan(main, str(project / "data"), str(source), 3197)
                source.rmdir()
                with self.assertRaisesRegex(setup.SetupError, "zarejestrowanym checkoutem"):
                    setup.apply_configuration(prepared)
            self.assertEqual((main / ".env").read_bytes(), original)
            self.assertFalse((project / "data").exists())

    def test_literal_paths_roundtrip_through_storage_parser(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            value = "C:/Fullmag data/$local/#storage"
            (root / ".env").write_bytes(setup.merge_dotenv(b"# preserve\r\nOTHER=secret\r\n",
                {"FULLMAG_PROJECT_STORAGE_ROOT": value}))
            self.assertEqual(setup.storage.storage_dotenv(root)["FULLMAG_PROJECT_STORAGE_ROOT"], value)
            self.assertIn(b"OTHER=secret\r\n", (root / ".env").read_bytes())

    def test_backslashes_are_literal_and_unsafe_values_rejected(self):
        value = "C:" + chr(92) + "storage"
        self.assertEqual(setup.dotenv_values(setup.merge_dotenv(b"", {"ROOT": value}))["ROOT"], value)
        for value in ("bad\npath", "bad'path", "bad\0path"):
            with self.assertRaises(setup.SetupError):
                setup.merge_dotenv(b"", {"ROOT": value})

    def test_duplicate_managed_keys_rejected(self):
        with self.assertRaises(setup.SetupError):
            setup.dotenv_values(b"FULLMAG_PROJECT_STORAGE_ROOT=/one\nFULLMAG_PROJECT_STORAGE_ROOT=/two\n")

    def test_partial_setup_retains_secrets_and_fills_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            main = base / "repo"
            main.mkdir()
            original = b"# operator\nPOSTGRES_PASSWORD='keep-this'\nMINIO_ROOT_PASSWORD=\nEXTRA=keep\n"
            (main / ".env").write_bytes(original)
            context = {"repo": main, "main": main, "project": base, "checkouts": [main]}
            with patch.object(setup, "checkout_context", return_value=context), patch.object(setup, "validate_host_volume"):
                prepared = setup.plan(main, str(base / "storage"), str(main), 3197)
            values = setup.dotenv_values(prepared["configured"])
            self.assertEqual(values["POSTGRES_PASSWORD"], "keep-this")
            self.assertTrue(values["MINIO_ROOT_PASSWORD"])
            self.assertEqual(values["MINIO_ROOT_USER"], "fullmag")
            self.assertIn(b"EXTRA=keep\n", prepared["configured"])
            self.assertEqual((main / ".env").read_bytes(), original)
            self.assertFalse((base / "storage").exists())

    def test_storage_rejects_checkout_unmarked_and_foreign_data(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            main = base / "repo"
            main.mkdir()
            context = {"project": base, "checkouts": [main]}
            with self.assertRaises(setup.SetupError):
                setup.validate_storage_root(str(main / "storage"), context)
            other = base / "data"
            other.mkdir()
            (other / "important").write_text("preserve")
            with self.assertRaises(setup.SetupError):
                setup.validate_storage_root(str(other), context)
            (other / ".fullmag-storage.json").write_text(json.dumps({"schema": "foreign"}))
            with self.assertRaises(setup.SetupError):
                setup.validate_storage_root(str(other), context)
            self.assertEqual((other / "important").read_text(), "preserve")

    def test_changed_configuration_and_symlink_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            target = base / "env"
            target.write_bytes(b"existing")
            with self.assertRaises(setup.SetupError):
                setup.write_exact(target, b"replacement", b"stale")
            self.assertEqual(target.read_bytes(), b"existing")
            link = base / "link"
            try:
                link.symlink_to(target)
            except OSError:
                self.skipTest("Symlink creation not permitted")
            with self.assertRaises(setup.storage.StorageError):
                setup.write_exact(link, b"replacement", b"existing")

    def test_new_file_publication_never_replaces_concurrent_creator(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "env"
            real_link = setup.os.link
            def race(source, destination):
                target.write_bytes(b"concurrent")
                return real_link(source, destination)
            with patch.object(setup.os, "link", side_effect=race):
                with self.assertRaises(FileExistsError):
                    setup.write_exact(target, b"replacement", None)
            self.assertEqual(target.read_bytes(), b"concurrent")
            self.assertEqual(list(Path(directory).iterdir()), [target])

    def test_check_is_readonly_and_rejects_invalid_storage(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            main = base / "repo"
            main.mkdir()
            original = setup.merge_dotenv(b"", {"FULLMAG_PROJECT_STORAGE_ROOT": str(main)})
            (main / ".env").write_bytes(original)
            context = {"repo": main, "main": main, "project": base, "checkouts": [main]}
            checks = {"platform": "windows", "docker_os": {"value": "linux"}}
            with patch.object(setup, "checkout_context", return_value=context), patch.object(setup, "host_checks", return_value=checks), patch.object(setup, "show_checks"), patch.object(setup, "runtime_defaults", return_value=SimpleNamespace(source_root=main, port=3197)), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(setup.main(["--check"]), 2)
            self.assertEqual((main / ".env").read_bytes(), original)
            self.assertEqual(sorted(p.name for p in main.iterdir()), [".env"])

    def test_unqualified_source_volume_is_rejected_before_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory).resolve()
            main = project / "repo"
            main.mkdir()
            context = {"repo": main, "main": main, "project": project, "checkouts": [main]}
            def admit(path):
                if path == main:
                    raise setup.SetupError("source volume is not local Windows")
            with patch.object(setup, "checkout_context", return_value=context), patch.object(setup, "validate_host_volume", side_effect=admit):
                with self.assertRaisesRegex(setup.SetupError, "source volume"):
                    setup.plan(main, str(project / "storage"), str(main), 3197)
            self.assertFalse((main / ".env").exists())
            self.assertFalse((project / "storage").exists())

    def test_new_clone_configuration_roundtrip_with_real_resolver(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory).resolve()
            main = project / "repo"
            main.mkdir()
            subprocess.run(["git", "init", "--quiet", str(main)], check=True)
            (main / ".env.example").write_text("POSTGRES_PASSWORD=change-me\nMINIO_ROOT_USER=fullmag\nMINIO_ROOT_PASSWORD=change-me\nFULLMAG_PROJECT_STORAGE_ROOT=\n")
            isolated = {key: value for key, value in os.environ.items()
                        if key not in setup.storage.MANAGED_VARIABLES and key not in {"GIT_DIR", "GIT_WORK_TREE"}}
            with patch.dict(os.environ, isolated, clear=True), patch.object(setup, "validate_host_volume"):
                prepared = setup.plan(main, str(project / "chosen-storage"), str(main), 3297)
                result = setup.apply_configuration(prepared)
                layout = setup.storage.resolve_layout(main, "docker-all-gpu", environ={})
            self.assertEqual(Path(layout["storage_root"]), project / "chosen-storage")
            saved = json.loads(Path(result["settings_path"]).read_text())
            self.assertEqual(saved["http_port"], 3297)
            self.assertEqual(saved["source_root"], str(main))
            self.assertFalse(saved["application_ready"])
            self.assertNotIn("PASSWORD", json.dumps(saved))
            self.assertNotEqual(setup.dotenv_values((main / ".env").read_bytes())["POSTGRES_PASSWORD"], "change-me")

    def test_resolver_failure_preserves_existing_env(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory).resolve()
            main = project / "repo"
            main.mkdir()
            original = b"POSTGRES_PASSWORD=keep\n"
            (main / ".env").write_bytes(original)
            context = {"repo": main, "main": main, "project": project, "checkouts": [main]}
            with patch.object(setup, "checkout_context", return_value=context), patch.object(setup, "validate_host_volume"):
                prepared = setup.plan(main, str(project / "storage"), str(main), 3197)
                with patch.object(setup.storage, "resolve_layout", side_effect=setup.storage.StorageError("invalid override")):
                    with self.assertRaises(setup.storage.StorageError):
                        setup.apply_configuration(prepared)
            self.assertEqual((main / ".env").read_bytes(), original)
            self.assertFalse((project / "storage" / "index").exists())

    def test_cancel_is_readonly(self):
        context = {"repo": Path("/repo"), "main": Path("/repo")}
        checks = {"platform": "windows"}
        with patch.object(setup, "checkout_context", return_value=context), patch.object(setup, "host_checks", return_value=checks), patch.object(setup, "show_checks"), patch.object(setup, "runtime_defaults", return_value=SimpleNamespace(source_root=Path("/repo"), port=3197)), patch.object(setup.sys.stdin, "isatty", return_value=True), patch.object(setup, "plan", return_value={"env_path": "/repo/.env", "storage_root": "/storage", "source_root": "/repo", "port": 3197}), patch("builtins.input", side_effect=["/storage", "", "", "n"]), patch.object(setup, "apply_configuration") as apply, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(setup.main([]), 0)
            apply.assert_not_called()

    def test_runtime_defaults_uses_shared_source_and_port_resolver(self):
        expected = SimpleNamespace(source_root=Path("/worktree"), port=4321)
        with patch.object(defaults, "resolve_defaults", return_value=expected) as resolver:
            self.assertIs(
                setup.runtime_defaults(Path("/repo"), source_root="/worktree", port=4321),
                expected,
            )
        resolver.assert_called_once_with(
            Path("/repo"), source_root="/worktree", port=4321,
        )

    def test_runtime_defaults_preserves_dotenv_then_legacy_host_settings_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            main, worktree = root / "main", root / "worktree"
            main.mkdir()
            worktree.mkdir()
            known = (main, worktree)
            with patch.object(defaults, "_known_checkouts", return_value=known), \
                    patch.object(defaults, "_read_dotenv", return_value={
                        "FULLMAG_SOURCE_ROOT": str(worktree), "FULLMAG_HTTP_PORT": "4321",
                    }), \
                    patch.object(defaults, "_read_host_settings", return_value={
                        "source_root": str(main), "http_port": 4999,
                    }):
                selected = setup.runtime_defaults(main)
            self.assertEqual(selected.source_root, worktree)
            self.assertEqual(selected.port, 4321)

            with patch.object(defaults, "_known_checkouts", return_value=known), \
                    patch.object(defaults, "_read_dotenv", return_value={}), \
                    patch.object(defaults, "_read_host_settings", return_value={
                        "source_root": str(worktree), "http_port": 4999,
                    }):
                fallback = setup.runtime_defaults(main)
            self.assertEqual(fallback.source_root, worktree)
            self.assertEqual(fallback.port, 4999)

            for invalid in (
                {"FULLMAG_SOURCE_ROOT": str(root / "missing")},
                {"FULLMAG_HTTP_PORT": "80"},
            ):
                with self.subTest(invalid=invalid), \
                        patch.object(defaults, "_known_checkouts", return_value=known), \
                        patch.object(defaults, "_read_dotenv", return_value=invalid), \
                        patch.object(defaults, "_read_host_settings", return_value={}):
                    with self.assertRaises(setup.SetupError):
                        setup.runtime_defaults(main)

    def test_second_configuration_preserves_resolved_source_and_port_defaults(self):
        context = {
            "repo": Path("/repo"), "main": Path("/repo"),
            "project": Path("/"), "checkouts": [Path("/repo"), Path("/worktree")],
        }
        checks = {"platform": "windows"}
        resolved = SimpleNamespace(source_root=Path("/worktree"), port=4321)
        prepared = {
            "env_path": "/repo/.env", "storage_root": "/storage",
            "source_root": "/worktree", "port": 4321,
        }
        with patch.object(setup, "checkout_context", return_value=context), \
                patch.object(setup, "host_checks", return_value=checks), \
                patch.object(setup, "show_checks"), \
                patch.object(setup, "runtime_defaults", return_value=resolved), \
                patch.object(setup.sys.stdin, "isatty", return_value=True), \
                patch.object(setup, "plan", return_value=prepared) as plan, \
                patch("builtins.input", side_effect=["/storage", "", "", "n"]), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(setup.main([]), 0)
        self.assertEqual(
            plan.call_args.args,
            (Path("/repo"), "/storage", str(Path("/worktree")), 4321),
        )

    def test_check_rejects_invalid_source_or_port_from_shared_resolver(self):
        context = {"repo": Path("/repo"), "main": Path("/repo")}
        checks = {"platform": "windows"}
        for option in (("--source-root", "/missing"), ("--port", "80")):
            with self.subTest(option=option), \
                    patch.object(setup, "checkout_context", return_value=context), \
                    patch.object(setup, "host_checks", return_value=checks), \
                    patch.object(setup, "show_checks"), \
                    patch.object(setup, "runtime_defaults", side_effect=setup.SetupError("invalid source/port")) as resolver, \
                    contextlib.redirect_stdout(io.StringIO()), \
                    contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(setup.main(["--check", *option]), 2)
                resolver.assert_called_once()


if __name__ == "__main__":
    unittest.main()
