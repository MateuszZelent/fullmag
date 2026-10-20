"""Lightweight regression checks; no Docker containers or compilation."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import docker_wsl_bind as bind
from docker_build_control import BuildControlError, ControlOutcomeUnknown


class DaemonBindTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / bind.MARKER).write_text(json.dumps(
            {"schema": "fullmag_storage_v1", "project_root": "/home/user/project"}))
        self.image = "sha256:" + "a" * 64
        self.container_id = "b" * 64
        self.daemon_root = "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/token"
        self.control = Mock(project="fullmag-master")
        self.operation = {"root": "development/attempt"}
        self.calls = []

    def docker(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if args[0] == "create":
            self.labels = dict(args[index + 1].split("=", 1)
                               for index, value in enumerate(args) if value == "--label")
            return subprocess.CompletedProcess(args, 0, self.container_id.encode(), b"")
        if args[0] == "inspect":
            document = {"Id": self.container_id, "Image": self.image,
                "Config": {"Labels": self.labels},
                "Mounts": [{"Type": "bind", "Source": self.daemon_root,
                            "Destination": bind.TARGET, "RW": False}],
                "State": {"Running": False, "ExitCode": 0, "Status": "exited"}}
            return subprocess.CompletedProcess(args, 0, json.dumps([document]).encode(), b"")
        if args[0] == "start":
            request = json.loads(kwargs["data"])
            receipt = {"schema": bind.SCHEMA, "daemon_root": request["daemon_root"],
                "marker": {key: request[key] for key in ("sha256", "size")},
                "mountinfo": {"path": request["daemon_root"]},
                "candidate_count": 1, "matching_count": 1}
            return subprocess.CompletedProcess(args, 0, json.dumps(receipt).encode(), b"")
        if args[0] == "rm":
            return subprocess.CompletedProcess(args, 0, b"", b"")
        self.fail(args)

    def test_uses_inspected_desktop_path_and_records_volume_evidence(self):
        with patch.object(bind, "docker_capture", side_effect=self.docker):
            actual = bind.resolve_daemon_bind(self.control, self.operation, self.root, self.image)
        self.assertEqual(actual, self.daemon_root)
        self.assertEqual(self.control.write.call_count, 3)
        receipt = self.control.write.call_args.args[1]
        self.assertEqual(receipt["local_root"], str(self.root))
        self.assertEqual(receipt["daemon_root"], self.daemon_root)
        self.assertEqual(self.calls[-1][0], ("rm", self.container_id))
        create = self.calls[0][0]
        self.assertIn("none", create)
        self.assertIn("--read-only", create)
        self.assertIn("type=bind,src=" + str(self.root) + ",dst=" + bind.TARGET + ",readonly", create)

    def test_observation_timeout_preserves_container(self):
        def docker(*args, **kwargs):
            if args[0] == "start":
                raise ControlOutcomeUnknown("observation timed out")
            return self.docker(*args, **kwargs)
        with patch.object(bind, "docker_capture", side_effect=docker):
            with self.assertRaises(ControlOutcomeUnknown):
                bind.resolve_daemon_bind(self.control, self.operation, self.root, self.image)
        self.assertFalse(any(args[0] == "rm" for args, _ in self.calls))
        self.assertEqual(self.control.write.call_args.args[1]["status"], "observing")

    def test_unsafe_daemon_source_preserves_container(self):
        self.daemon_root = "/run/desktop/../etc"
        with patch.object(bind, "docker_capture", side_effect=self.docker):
            with self.assertRaises(BuildControlError):
                bind.resolve_daemon_bind(self.control, self.operation, self.root, self.image)
        self.assertFalse(any(args[0] in {"start", "rm"} for args, _ in self.calls))

    def test_changed_marker_preserves_container(self):
        def docker(*args, **kwargs):
            result = self.docker(*args, **kwargs)
            if args[0] == "start":
                (self.root / bind.MARKER).write_text('{"schema":"changed"}')
            return result
        with patch.object(bind, "docker_capture", side_effect=docker):
            with self.assertRaises(BuildControlError):
                bind.resolve_daemon_bind(self.control, self.operation, self.root, self.image)
        self.assertFalse(any(args[0] == "rm" for args, _ in self.calls))

    def test_symlink_marker_is_rejected_before_docker(self):
        marker = self.root / bind.MARKER
        marker.rename(self.root / "original")
        marker.symlink_to(self.root / "original")
        with patch.object(bind, "docker_capture") as docker:
            with self.assertRaises(BuildControlError):
                bind.resolve_daemon_bind(self.control, self.operation, self.root, self.image)
        docker.assert_not_called()

    def test_rejects_mutable_image_before_docker(self):
        with patch.object(bind, "docker_capture") as docker:
            with self.assertRaises(BuildControlError):
                bind.resolve_daemon_bind(self.control, self.operation, self.root, "backend:latest")
        docker.assert_not_called()

    def test_failed_terminal_probe_records_diagnostics_and_retains_container(self):
        def docker(*args, **kwargs):
            result = self.docker(*args, **kwargs)
            if args[0] == "start":
                return subprocess.CompletedProcess(args, 2, b"", b"host path invisible")
            if args[0] == "inspect" and len(self.calls) > 3:
                value = json.loads(result.stdout)
                value[0]["State"]["ExitCode"] = 2
                result.stdout = json.dumps(value).encode()
            return result
        with patch.object(bind, "docker_capture", side_effect=docker):
            with self.assertRaises(BuildControlError):
                bind.resolve_daemon_bind(self.control, self.operation, self.root, self.image)
        receipt = self.control.write.call_args.args[1]
        self.assertEqual(receipt["status"], "failed")
        self.assertIn("host path invisible", receipt["stderr"])
        self.assertFalse(any(args[0] == "rm" for args, _ in self.calls))

    def test_returned_path_can_differ_from_inspect_source(self):
        resolved = "/run/desktop/mnt/host/wsl/Ubuntu/home/user/storage"
        def docker(*args, **kwargs):
            result = self.docker(*args, **kwargs)
            if args[0] == "start":
                value = json.loads(result.stdout)
                value["daemon_root"] = resolved
                value["mountinfo"]["path"] = resolved
                result.stdout = json.dumps(value).encode()
            return result
        with patch.object(bind, "docker_capture", side_effect=docker):
            self.assertEqual(bind.resolve_daemon_bind(self.control, self.operation, self.root, self.image), resolved)


class MountinfoTests(unittest.TestCase):
    def record(self, root, target, device="8:32", mount_id="42"):
        return f"{mount_id} 1 {device} {root} {target} rw - ext4 /dev/sdc rw\n"

    def test_derives_wsl_daemon_path_from_device_and_root(self):
        bound = self.record("/home/user/storage", bind.TARGET)
        host = self.record("/", "/run/desktop/mnt/host/wsl/Ubuntu")
        result = bind.mount_candidates(bound, host)
        self.assertEqual(result[0]["path"], "/run/desktop/mnt/host/wsl/Ubuntu/home/user/storage")
        self.assertEqual(result[0]["bind_mount"]["device"], "8:32")

    def test_matches_submount_root_and_decodes_spaces(self):
        bound = self.record(r"/home/user/my\040storage", bind.TARGET)
        host = self.record("/home/user", r"/run/desktop/with\040space")
        self.assertEqual(bind.mount_candidates(bound, host)[0]["path"], "/run/desktop/with space/my storage")

    def test_device_mismatch_or_nonancestor_is_rejected(self):
        bound = self.record("/home/user/storage", bind.TARGET)
        for host in (self.record("/", "/host", device="9:99"),
                     self.record("/home/use", "/host")):
            with self.subTest(host=host), self.assertRaises(ValueError):
                bind.mount_candidates(bound, host)

    def test_candidate_budget(self):
        bound = self.record("/home/user/storage", bind.TARGET)
        host = "".join(self.record("/", "/host" + str(index), mount_id=str(index)) for index in range(65))
        with self.assertRaises(ValueError):
            bind.mount_candidates(bound, host)

    def test_unsafe_mountinfo_is_rejected(self):
        bound = self.record("/home/user/storage", bind.TARGET)
        for target in ("/host/../etc", r"/host\012injected", "//host"):
            with self.subTest(target=target), self.assertRaises(ValueError):
                bind.mount_candidates(bound, self.record("/", target))

    def test_unrelated_windows_and_wsl_roots_do_not_block_discovery(self):
        unrelated = self.record(r"C:\\Users\\user", "/desktop/windows", device="0:99")
        unrelated += self.record("//wsl.localhost/Ubuntu", "/desktop/wsl", device="0:100")
        bound = unrelated + self.record("/home/user/storage", bind.TARGET)
        host = unrelated + self.record("/", "/run/desktop/mnt/host/wsl/Ubuntu")
        self.assertEqual(bind.mount_candidates(bound, host)[0]["path"],
                         "/run/desktop/mnt/host/wsl/Ubuntu/home/user/storage")

    def test_relevant_unsafe_root_reports_bounded_evidence(self):
        bound = self.record("/home/user/storage", bind.TARGET)
        with self.assertRaisesRegex(ValueError, "unsafe relevant mountinfo record.*8:32"):
            bind.mount_candidates(bound, self.record(r"C:\\Users", "/host"))


if __name__ == "__main__":
    unittest.main()
