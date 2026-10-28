"""Focused tests for explicitly pinned runtime helper checkouts."""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import docker_helper_source as helper_source
from docker_build_control import BuildControlError


class HelperSourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "helper"
        self.root.mkdir()
        self._git("init", "-q")
        self._git("config", "user.email", "test@example.invalid")
        self._git("config", "user.name", "Test")
        for relative, data in self._files().items():
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        self._git("add", "--all")
        self._git("commit", "-qm", "helper source fixture")
        self.commit = self._git("rev-parse", "HEAD").strip()
        self.app = Path(self.temporary.name) / "app-worktree"
        self._git("worktree", "add", "-q", "--detach", str(self.app), self.commit)
        self.addCleanup(lambda: self._git("worktree", "remove", "--force", str(self.app)))

    def _git(self, *arguments):
        return subprocess.run(
            ["git", "-C", str(self.root), *arguments],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            env={**__import__("os").environ, "GIT_OPTIONAL_LOCKS": "0"},
        ).stdout

    @staticmethod
    def _files():
        return {
            "compose.dev.yaml": b"services: {}\n",
            "scripts/docker_dev.py": b"# launcher\n",
            "scripts/docker_volume_dev.py": b"# volume launcher\n",
            "scripts/docker_build_control.py": b"# build control\n",
            "scripts/docker_helper_source.py": b"# helper source\n",
            "scripts/docker_dev_host.py": b"# host adapter\n",
            "scripts/docker_volume_stop_unadmitted.py": b"# retained stop gate\n",
            "scripts/docker_startup_script.py": (
                b"import fullmag_storage\n"
                b"class StartupScriptError(Exception): pass\n"
                b"MAX_PROVENANCE_BYTES = 1024\n"
                b"STARTUP_ACTIVATION_TIMEOUT_SECONDS = 7.0\n"
                b"def prepare(*args, **kwargs): return 'pinned-helper' if fullmag_storage.PINNED_STORAGE else 'wrong'\n"
            ),
            "scripts/fullmag_storage.py": b"PINNED_STORAGE = True\n",
            "docker/all-in-one/Dockerfile.backend": b"FROM scratch\n",
        }

    def _binding(self):
        launcher_paths = (
            "scripts/docker_dev.py",
            "scripts/docker_volume_dev.py",
            "scripts/docker_build_control.py",
            "scripts/docker_helper_source.py",
            "scripts/docker_dev_host.py",
            "scripts/docker_startup_script.py",
            "scripts/fullmag_storage.py",
        )
        executed = {relative: self.root / relative for relative in launcher_paths[:5]}
        with patch.object(helper_source, "validate_host_path", side_effect=lambda path, label: Path(path)):
            return helper_source.capture_binding(
                self.root,
                self.commit,
                self.app,
                context_files=("docker/all-in-one/Dockerfile.backend",),
                launcher_files=launcher_paths,
                executed_files=executed,
            )

    def _complete_script_binding(self):
        launcher_paths = (
            "scripts/docker_dev.py",
            "scripts/docker_volume_dev.py",
            "scripts/docker_build_control.py",
            "scripts/docker_helper_source.py",
            "scripts/docker_dev_host.py",
            "scripts/docker_startup_script.py",
            "scripts/fullmag_storage.py",
        )
        executed = {relative: self.root / relative for relative in launcher_paths[:5]}
        with patch.object(helper_source, "validate_host_path", side_effect=lambda path, label: Path(path)):
            return helper_source.capture_binding(
                self.root,
                self.commit,
                self.app,
                context_files=("docker/all-in-one/Dockerfile.backend",),
                launcher_files=launcher_paths,
                executed_files=executed,
                include_script_python=True,
            )

    def test_recursive_git_queries_fit_windows_command_line_with_large_script_inventory(self):
        paths = [f"scripts/nested/package_{i:04d}/" + "long_name_" * 8 + ".py" for i in range(1000)]
        paths += ["compose.dev.yaml", "docker/all-in-one/Dockerfile.backend", "scripts-extra/keep.py"]
        original_git = helper_source._git
        calls = []

        def bounded_git(root, *arguments, **kwargs):
            command = ["git", "-C", str(root), *arguments]
            self.assertLess(len(subprocess.list2cmdline(command)), 32767)
            self.assertIn(":(literal)scripts-extra/keep.py", arguments)
            calls.append(arguments)
            return original_git(root, *arguments, **kwargs)

        with patch.object(helper_source, "_git", side_effect=bounded_git):
            tree = helper_source._read_tree(self.root, self.commit, paths, recursive_scripts=True)
            index = helper_source._read_index(self.root, paths, recursive_scripts=True)
        self.assertEqual(len(calls), 2)
        self.assertEqual(set(tree), set(self._files()))
        self.assertEqual(set(index), set(self._files()))

    def test_nonrecursive_git_queries_keep_explicit_script_pathspecs(self):
        paths = ["scripts/docker_dev.py", "compose.dev.yaml"]
        with patch.object(helper_source, "_git", return_value=b"") as query:
            helper_source._read_index(self.root, paths)
        self.assertIn(":(literal)scripts/docker_dev.py", query.call_args.args)
        self.assertNotIn("scripts", query.call_args.args)

    def test_clean_pinned_helper_can_be_separate_from_app_worktree(self):
        binding = self._binding()
        self.assertEqual(binding["root"], str(self.root.resolve()))
        self.assertEqual(binding["commit"], self.commit)
        self.assertIn("compose.dev.yaml", {entry["path"] for entry in binding["files"]})
        self.assertEqual(helper_source.validate_binding_record(binding), binding)
        labels = helper_source.image_labels(binding)
        self.assertEqual(helper_source.startup_hashes_from_image_labels(labels, binding), binding["startup_helper_hashes"])

    def test_requires_both_helper_options_and_full_commit(self):
        with self.assertRaisesRegex(helper_source.HelperSourceError, "together"):
            helper_source.validate_option_pair(self.root, None)
        with self.assertRaisesRegex(helper_source.HelperSourceError, "full lowercase SHA-1"):
            helper_source.validate_option_pair(self.root, "a" * 12)
        with self.assertRaisesRegex(helper_source.HelperSourceError, "lowercase"):
            helper_source.validate_option_pair(self.root, "A" * 40)

    def test_rejects_wrong_commit(self):
        with patch.object(helper_source, "validate_host_path", side_effect=lambda path, label: Path(path)):
            with self.assertRaisesRegex(helper_source.HelperSourceError, "HEAD differs"):
                helper_source.capture_binding(
                    self.root, "0" * 40, self.app,
                    context_files=("docker/all-in-one/Dockerfile.backend",),
                    launcher_files=("scripts/docker_dev.py",),
                    executed_files={"scripts/docker_dev.py": self.root / "scripts/docker_dev.py"},
                )

    def test_rejects_dirty_tracked_file(self):
        (self.root / "compose.dev.yaml").write_bytes(b"services: changed\n")
        with self.assertRaisesRegex(helper_source.HelperSourceError, "differs from pinned commit"):
            self._binding()

    def test_rejects_dirty_transitive_retained_gate(self):
        path = self.root / "scripts/docker_volume_stop_unadmitted.py"
        path.write_bytes(b"# changed retained stop gate\n")
        with self.assertRaisesRegex(helper_source.HelperSourceError, "differs from pinned commit"):
            self._complete_script_binding()

    def test_rejects_untracked_python_shadow_module(self):
        (self.root / "scripts/docker_volume_shadow.py").write_text("# untracked shadow\n")
        with self.assertRaisesRegex(helper_source.HelperSourceError, "untracked or shadow"):
            self._complete_script_binding()

    def test_rejects_required_symlink(self):
        path = self.root / "compose.dev.yaml"
        path.unlink()
        path.symlink_to(self.root / "scripts/docker_dev.py")
        with self.assertRaisesRegex(helper_source.HelperSourceError, "symlink"):
            self._binding()

    def test_rejects_untracked_required_launcher(self):
        path = self.root / "scripts/untracked.py"
        path.write_text("# untracked\n")
        with self.assertRaisesRegex(helper_source.HelperSourceError, "not tracked"):
            with patch.object(helper_source, "validate_host_path", side_effect=lambda path, label: Path(path)):
                helper_source.capture_binding(
                    self.root, self.commit, self.app,
                    context_files=(), launcher_files=("scripts/docker_dev.py", "scripts/untracked.py"),
                    executed_files={"scripts/docker_dev.py": self.root / "scripts/docker_dev.py"},
                )

    def test_rejects_app_from_another_git_repository(self):
        other = Path(self.temporary.name) / "other"
        other.mkdir()
        subprocess.run(["git", "-C", str(other), "init", "-q"], check=True)
        with patch.object(helper_source, "validate_host_path", side_effect=lambda path, label: Path(path)):
            with self.assertRaisesRegex(helper_source.HelperSourceError, "same Git repository"):
                helper_source.capture_binding(
                    self.root, self.commit, other,
                    context_files=(), launcher_files=("scripts/docker_dev.py",),
                    executed_files={"scripts/docker_dev.py": self.root / "scripts/docker_dev.py"},
                )

    def test_resume_requires_exact_stored_helper_binding(self):
        binding = self._binding()
        self.assertEqual(helper_source.compare_operation_binding({"helper_source": binding}, binding), binding)
        with self.assertRaisesRegex(helper_source.HelperSourceError, "required to resume"):
            helper_source.compare_operation_binding({"helper_source": binding}, None)
        with self.assertRaisesRegex(helper_source.HelperSourceError, "was not pinned"):
            helper_source.compare_operation_binding({}, binding)
        changed = dict(binding, commit="1" * 40)
        with self.assertRaisesRegex(helper_source.HelperSourceError, "differs"):
            helper_source.compare_operation_binding({"helper_source": binding}, changed)

    def test_recreate_parser_accepts_optional_root_commit_pair(self):
        import docker_dev

        parsed = docker_dev._parser().parse_args([
            "recreate-volume", "--attempt", "a" * 32,
            "--config-sha256", "b" * 64,
            "--source-root", str(self.app), "--port", "3197",
            "--helper-source-root", str(self.root),
            "--helper-source-commit", self.commit,
        ])
        self.assertEqual(parsed.helper_source_root, self.root)
        self.assertEqual(parsed.helper_source_commit, self.commit)

    def test_legacy_startup_helper_still_requires_source_bytes_to_match_image(self):
        import docker_volume_dev

        selected = Path(self.temporary.name) / "old-app"
        (selected / "scripts").mkdir(parents=True)
        (selected / "scripts/docker_startup_script.py").write_bytes(b"different startup\n")
        (selected / "scripts/fullmag_storage.py").write_bytes(b"different storage\n")
        helper_script = self.root / "scripts/docker_startup_script.py"
        helper_storage = self.root / "scripts/fullmag_storage.py"
        hashes = [hashlib.sha256(path.read_bytes()).hexdigest() for path in (helper_script, helper_storage)]

        class Control:
            image = "helper-image"

            def helper_args(self, command):
                return ["helper-image", command]

        output = "\n".join(
            f"{digest}  /opt/fullmag/{name}"
            for digest, name in zip(hashes, ("docker_startup_script.py", "fullmag_storage.py"))
        ).encode()
        with patch("docker_volume_dev.bounded_capture", return_value=subprocess.CompletedProcess([], 0, output, b"")):
            with self.assertRaisesRegex(BuildControlError, "changed since image preparation"):
                docker_volume_dev._startup_helper(Control(), selected, "sha256:" + "a" * 64)

    def test_pinned_startup_helper_executes_exact_image_bytes_without_checkout(self):
        import docker_volume_dev

        binding = self._binding()
        labels = helper_source.image_labels(binding)
        image = "sha256:" + "a" * 64
        image_info = json.dumps([{"Id": image, "Config": {"Labels": labels}}]).encode()

        class Control:
            image = "helper-image"

            def helper_args(self, command):
                return ["helper-image", command]

        files = [
            (self.root / "scripts/docker_startup_script.py").read_bytes(),
            (self.root / "scripts/fullmag_storage.py").read_bytes(),
        ]
        results = [
            subprocess.CompletedProcess([], 0, base64.b64encode(data) + b"\n", b"")
            for data in files
        ]
        with patch("docker_volume_dev.docker_capture", return_value=subprocess.CompletedProcess([], 0, image_info, b"")), \
             patch("docker_volume_dev.bounded_capture", side_effect=results):
            helper, hashes = docker_volume_dev._startup_helper(
                Control(), Path(self.temporary.name) / "missing-selected-checkout", image,
                helper_source_binding=binding,
            )
        self.assertEqual(helper.prepare(), "pinned-helper")
        self.assertEqual(hashes, binding["startup_helper_hashes"])


if __name__ == "__main__":
    unittest.main()
