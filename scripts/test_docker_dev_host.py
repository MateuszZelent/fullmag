"""Interpreted host admission and Docker command regressions; no builds."""
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import docker_dev_host as host
import docker_build_control as control
import bootstrap_docker_toolchain as bootstrap


class DockerDevHostTests(unittest.TestCase):
    def test_linux_keeps_configured_docker_endpoint(self):
        with mock.patch.object(host, "os", SimpleNamespace(name="posix")), \
                mock.patch.object(host.sys, "platform", "linux"):
            self.assertEqual(host.docker_argv("info"), ["docker", "info"])

    def test_windows_keeps_desktop_linux_context(self):
        with mock.patch.object(host, "os", SimpleNamespace(name="nt")):
            self.assertEqual(host.docker_argv("info"),
                             ["docker", "--context", "desktop-linux", "info"])

    def test_unsupported_host_is_rejected(self):
        with mock.patch.object(host, "os", SimpleNamespace(name="posix")), \
                mock.patch.object(host.sys, "platform", "darwin"):
            with self.assertRaisesRegex(ValueError, "Windows and Linux"):
                host.require_host()

    def test_linux_local_filesystems_are_admitted(self):
        for filesystem in ("ext4", "xfs", "btrfs"):
            with self.subTest(filesystem=filesystem), \
                    mock.patch.object(host.storage, "filesystem_type", return_value=filesystem):
                self.assertEqual(host.validate_host_path(Path("/home/fullmag")),
                                 Path("/home/fullmag"))

    def test_linux_remote_windows_and_unknown_filesystems_are_rejected(self):
        for filesystem in ("cifs", "nfs", "9p", "drvfs", "tmpfs", "overlay", ""):
            with self.subTest(filesystem=filesystem), \
                    mock.patch.object(host.storage, "filesystem_type", return_value=filesystem):
                with self.assertRaisesRegex(ValueError, "local ext4"):
                    host.validate_host_path(Path("/home/fullmag"))

    def test_ephemeral_paths_are_rejected_even_on_ext4(self):
        with mock.patch.object(host.storage, "filesystem_type", return_value="ext4"):
            for root in ("/tmp/test", "/var/tmp/test", "/run/test", "/dev/test", "/proc/test", "/sys/test"):
                with self.subTest(root=root), self.assertRaisesRegex(ValueError, "durable"):
                    host.validate_host_path(Path(root))

    def test_symlink_cannot_disappear_during_path_resolution(self):
        with tempfile.TemporaryDirectory() as directory:
            link = Path(directory) / "link"
            link.symlink_to(Path.cwd(), target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "symlink"):
                host.validate_host_path(link / "scripts")

    def test_linux_storage_description_is_not_windows_attestation(self):
        with mock.patch.object(host.storage, "filesystem_type", return_value="ext4"):
            description = host.local_volume(Path(__file__).resolve().parent)
        self.assertEqual(description["host_platform"], "linux")
        self.assertNotIn("host_volume_serial", description)
        self.assertNotIn("host_drive_type", description)

    def test_control_and_bootstrap_commands_use_host_adapter(self):
        with mock.patch.object(control, "bounded_capture", return_value=subprocess.CompletedProcess([], 0, b"", b"")) as capture:
            control.docker_capture("info")
            self.assertEqual(capture.call_args.args[0], host.docker_argv("info"))
        with mock.patch.object(bootstrap, "bounded_command", return_value="") as command:
            bootstrap.docker("info")
            self.assertEqual(command.call_args.args[0], host.docker_argv("info"))

    def test_control_helpers_use_host_adapter_and_keep_project(self):
        with mock.patch("docker_control_namespace.resolve_namespace") as namespace:
            instance = control.BuildControl({"project_name": "fullmag-master", "worktree_id": "main",
                                             "project_id": "fullmag", "checkout_kind": "main"}, "sha256:" + "a" * 64)
            namespace.assert_called_once_with(instance)
        args = instance.helper_args("true")
        self.assertEqual(args[:len(host.docker_argv("run"))], host.docker_argv("run"))
        self.assertIn("com.docker.compose.project=fullmag-master", args)

    def test_linux_toolchain_reaches_compose_validation(self):
        repo = Path(__file__).resolve().parents[1]
        with mock.patch.object(host.storage,
                               "resolve_layout", return_value={}), \
                mock.patch("docker_compose_identity.compose_project_identity", return_value={"project_name": "fullmag-master"}), \
                mock.patch.object(control, "local_volume"), \
                mock.patch.object(control, "toolchain_configuration", side_effect=RuntimeError("compose reached")), \
                mock.patch.object(host.storage, "filesystem_type", return_value="ext4"):
            with self.assertRaisesRegex(RuntimeError, "compose reached"):
                control.build_volume_toolchain(repo)

    def test_daily_cli_and_toolchain_resolve_defaults_on_linux(self):
        import docker_dev
        selected = SimpleNamespace(source_root=Path("/home/fullmag"), port=3197)
        with mock.patch("docker_dev_defaults.resolve_defaults", return_value=selected) as defaults, \
                mock.patch.object(docker_dev, "_require_native_windows", side_effect=AssertionError("legacy Windows gate")), \
                mock.patch.object(docker_dev, "up") as start:
            self.assertEqual(docker_dev.main(["up"]), 0)
            self.assertEqual(start.call_args.args[0].source_root, selected.source_root)
            self.assertEqual(start.call_args.args[0].port, selected.port)
            defaults.assert_called_once()
        with mock.patch("docker_dev_defaults.resolve_defaults", return_value=selected) as defaults, \
                mock.patch.object(docker_dev, "_require_native_windows", side_effect=AssertionError("legacy Windows gate")), \
                mock.patch.object(bootstrap, "build") as build:
            self.assertEqual(bootstrap.main(["--direct-development"]), 0)
            build.assert_called_once_with(selected.source_root, direct_development=True)
            defaults.assert_called_once()

    def test_recreate_cli_retains_opaque_recovery_authorization(self):
        import docker_dev
        authorization = "/control/recovery/token.json"
        args = docker_dev._parser().parse_args([
            "recreate-volume", "--attempt", "a" * 32, "--config-sha256", "b" * 64,
            "--source-root", "/home/fullmag", "--port", "3197",
            "--recovery-authorization", authorization])
        self.assertEqual(args.recovery_authorization, authorization)


if __name__ == "__main__":
    unittest.main()
