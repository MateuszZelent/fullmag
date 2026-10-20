"""Exercise live Linux frontend input capture without writing build data."""
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import docker_development_inputs as inputs


@unittest.skipUnless(sys.platform.startswith("linux"), "native Linux host readers and paths")
class LinuxFrontendInputsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.source = Path(temporary.name) / "checkout"
        app = self.source / "apps/control-room"
        for name in inputs.DIRECTORIES:
            (app / name).mkdir(parents=True)
        (self.source / "package.json").write_text('{"name":"frontend-fixture"}')
        (self.source / "pnpm-workspace.yaml").write_text("packages:\n  - apps/*\n")
        (self.source / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\nimporters:\n  apps/control-room:\n    specifiers: {}\n")
        (app / "package.json").write_text('{"name":"control-room"}')
        (app / "next.config.ts").write_text("export default {};\n")
        subprocess.run(["git", "init", "--quiet", str(self.source)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(self.source), "-c", "user.name=Frontend Fixture",
                        "-c", "user.email=fixture@example.invalid", "commit", "--quiet",
                        "--allow-empty", "-m", "Create frontend fixture"], check=True, capture_output=True)

    def test_registered_linux_checkout_seeds_metadata_through_volume_writer(self):
        source = self.source
        self.assertEqual(inputs.select_checkout(source, source), source)
        captured = {}
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            # Temporary fixture storage stands in for the durable source mount;
            # exercise real Linux reads/Git/volume metadata, independent of the
            # managed backend's readonly host Git layout and current UID.
            with mock.patch("docker_dev_host.validate_host_path", side_effect=lambda path, label="host path": Path(path)), \
                    mock.patch.object(inputs.storage, "filesystem_type", return_value="ext4"):
                manifest = inputs.seed(source, state, 3197,
                                       write_file=lambda relative, payload: captured.setdefault(relative, payload))
            self.assertEqual(list(state.iterdir()), [])
        self.assertEqual(manifest["source_selection"], "live_linux_selected_checkout")
        self.assertEqual(manifest["source_volume"]["host_platform"], "linux")
        self.assertNotIn("host_volume_serial", manifest["source_volume"])
        self.assertEqual(captured["package.json"], (source / "package.json").read_bytes())
        self.assertEqual({entry["relative"]: entry["sha256"] for entry in manifest["files"]},
                         {name: hashlib.sha256(payload).hexdigest() for name, payload in captured.items()})
        self.assertEqual(len(manifest["live_directories"]), 4)
        self.assertEqual(inputs.describe(source, 3197)["source_selection"], "live_linux_selected_checkout")

    def test_symlink_checkout_is_rejected_before_resolution(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            source = state / "checkout"
            source.symlink_to(self.source, target_is_directory=True)
            with self.assertRaisesRegex((ValueError, RuntimeError), "symlink|reparse"):
                inputs.seed(source, state, 3197, write_file=lambda *_: self.fail("unexpected capture"))
            with self.assertRaisesRegex((ValueError, RuntimeError), "symlink|reparse"):
                inputs.select_checkout(self.source, source)

    def test_unregistered_checkout_is_still_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "registered checkout"):
                inputs.select_checkout(self.source, Path(directory))

    def test_guest_fallback_seeds_and_reuses_linux_metadata(self):
        source = self.source
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            arguments = {"host_source_root": "/home/user/fullmag", "worktree_id": "main",
                         "source_commit": "a" * 40}
            first = inputs.seed_guest(source, state, 3197, **arguments)
            second = inputs.seed_guest(source, state, 3197, **arguments)
            self.assertEqual(first, second)
            self.assertEqual(first["source_selection"], "live_linux_selected_checkout")
            self.assertEqual((state / "workspace/package.json").read_bytes(), (source / "package.json").read_bytes())

    def test_guest_fallback_preserves_windows_diagnostic_contract(self):
        source = self.source
        with tempfile.TemporaryDirectory() as directory:
            manifest = inputs.seed_guest(source, Path(directory), 3197,
                host_source_root=r"C:\git\fullmag", worktree_id="main", source_commit="a" * 40)
            self.assertEqual(manifest["source_selection"], "live_windows_selected_checkout")

    def test_linux_reader_refuses_symlink_dependency(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "checkout"
            for name in inputs.DIRECTORIES:
                (source / "apps/control-room" / name).mkdir(parents=True)
            actual = root / "actual-package.json"
            actual.write_text("{}")
            (source / "package.json").symlink_to(actual)
            with mock.patch.object(inputs, "local_volume", return_value={}), \
                    mock.patch.object(inputs.storage, "git", return_value="a" * 40):
                with self.assertRaisesRegex((OSError, ValueError, RuntimeError), "symlink|reparse|regular|symbolic"):
                    inputs.seed(source, root, 3197, write_file=lambda *_: self.fail("unexpected capture"))


if __name__ == "__main__":
    unittest.main()
