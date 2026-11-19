"""Retained WSL service ownership regressions; no Docker calls or builds."""
import copy
from contextlib import ExitStack, redirect_stderr
import io
import json
from pathlib import Path
import tempfile
from subprocess import CompletedProcess
import unittest
from unittest.mock import Mock, patch

import docker_volume_dev as dev
import linux_native_host as host
from docker_build_control import BuildControlError


class VolumeWslTests(unittest.TestCase):
    def test_ledger_probe_requires_readonly_mount_and_archives_before_retirement(self):
        import docker_host_ledger as ledger
        descriptor = {"name": "owned-ledger", "filesystem_uuid": "owned-filesystem"}
        image = "sha256:" + "a" * 64
        operation = {"root": "verification/owned", "receipt": {"attempt": "a" * 32}}
        proof = {"schema": "fullmag.host-ledger-volume-probe.v1", "state": "verified",
                 "volume_name": descriptor["name"], "filesystem_uuid": descriptor["filesystem_uuid"]}
        actual = {"Id": "owned-probe", "Image": image, "State": {"Running": False, "ExitCode": 0},
                  "Config": {"User": "65532:65532", "Labels": {"com.docker.compose.project": "fullmag-master",
                    "com.docker.compose.service": "host-ledger-volume-probe"}},
                  "HostConfig": {"Privileged": False, "ReadonlyRootfs": True, "NetworkMode": "none"},
                  "Mounts": [{"Destination": "/host-ledger", "Type": "volume", "Name": descriptor["name"], "RW": False}]}
        for writable in (False, True):
            with self.subTest(writable=writable):
                actual["Mounts"][0]["RW"] = writable
                saved = {}
                control = Mock(project="fullmag-master")
                control.write.side_effect = lambda path, value: saved.__setitem__(path, value)
                def retire(*args):
                    self.assertIn(operation["root"] + "/host-ledger-volume-probe.json", saved)
                    self.assertIn(operation["root"] + "/host-ledger-volume-probe-log.json", saved)
                    self.assertEqual(args, ("rm", "owned-probe"))
                with patch.object(ledger, "host_volume_probe_spec", return_value={"name": control.project}), \
                     patch.object(dev, "compose_capture", return_value=json.dumps(proof).encode()), \
                     patch.object(dev, "docker_text", side_effect=lambda *args, **kwargs:
                                  json.dumps([actual]) if args[0] == "inspect" else "verified log"), \
                     patch.object(dev, "docker_capture", side_effect=retire) as remove:
                    if writable:
                        with self.assertRaisesRegex(BuildControlError, "isolation/identity/outcome"):
                            dev._verify_host_ledger_volume(control, operation, descriptor, image)
                        remove.assert_not_called()
                    else:
                        dev._verify_host_ledger_volume(control, operation, descriptor, image)
                        remove.assert_called_once()

    def test_resume_reports_host_admission_errors_without_a_traceback(self):
        import docker_dev
        import fullmag_storage as storage
        arguments = ["resume-volume", "--attempt", "a" * 32,
                     "--config-sha256", "b" * 64,
                     "--source-root", "/home/operator/source", "--port", "3197"]
        for error in (ValueError("unsupported host filesystem"),
                      OSError("host path unavailable"), storage.StorageError("storage marker differs")):
            with self.subTest(error=type(error).__name__), \
                 patch.object(dev, "resume", side_effect=error), redirect_stderr(io.StringIO()) as output:
                self.assertEqual(docker_dev.main(arguments), 2)
                self.assertIn(str(error), output.getvalue())
                self.assertNotIn("Traceback", output.getvalue())

    def test_ledger_reads_the_same_host_helper_before_and_after_maintenance(self):
        import docker_host_ledger as ledger
        image = "sha256:" + "a" * 64
        helper = b"versioned host-ledger helper"
        inspected = [{"Id": "verified-container", "Image": image,
                      "State": {"ExitCode": 0, "Running": False},
                      "Config": {"Labels": {"com.docker.compose.project": "fullmag-master"}}}]
        rendered = {"services": {"host-ledger-maintenance": {"volumes": []},
                                 "backend": {"environment": {}, "volumes": []}}}
        from test_docker_host_ledger import FakeDocker
        receipt = FakeDocker({"project_id": "project", "mount_root": "/mnt/fullmag-host-ledger-project",
                              "backing_image": "/daemon/storage/build-volumes/" + ledger.IMAGE_NAME})._receipt("ensure")
        descriptor = ledger.host_volume_descriptor("fullmag-master", "project", "/mnt/fullmag-host-ledger-project", receipt)
        for changed in (False, True):
            with self.subTest(changed_during_maintenance=changed), ExitStack() as stack:
                adapter = Mock()
                adapter.read_owned_regular.side_effect = [helper, b"changed" if changed else helper]
                stack.enter_context(patch.object(dev, "_session_host", return_value=adapter))
                stack.enter_context(patch.object(ledger, "_daemon_info", return_value={"id_sha256": "engine"}))
                stack.enter_context(patch.object(ledger, "_image_attestation"))
                stack.enter_context(patch.object(ledger, "_validate_host_receipt"))
                prepare_volume = stack.enter_context(patch.object(ledger, "prepare_host_volume", return_value=descriptor))
                stack.enter_context(patch.object(dev, "_verify_host_ledger_volume"))
                stack.enter_context(patch("docker_wsl_bind.resolve_daemon_bind", return_value="/daemon/storage"))
                stack.enter_context(patch.object(dev, "bounded_capture", return_value=
                    CompletedProcess([], 0, json.dumps(rendered).encode(), b"")))
                stack.enter_context(patch.object(dev, "compose_capture", return_value=
                    json.dumps({"schema": ledger.HOST_RECEIPT_SCHEMA}).encode()))
                stack.enter_context(patch.object(dev, "docker_text", side_effect=
                    lambda *args, **kwargs: json.dumps(inspected) if args[0] == "inspect" else "maintenance logs"))
                remove = stack.enter_context(patch.object(dev, "docker_capture"))
                control = Mock(project="fullmag-master", volume="control", namespace="")
                control.subpath.side_effect = lambda relative="": relative
                control.read.return_value = None  # No retained optional capacity/Compose records in this fixture.
                operation = {"root": "test", "receipt": {"attempt": "owned-attempt"}}
                layout = {"storage_root": "/home/operator/storage", "project_id": "project"}
                if changed:
                    with self.assertRaisesRegex(BuildControlError, "helper changed"):
                        dev._host_ledger(control, operation, layout, Path("/home/operator/source"), image)
                    remove.assert_not_called()
                else:
                    backend, profile = dev._host_ledger(control, operation, layout, Path("/home/operator/source"), image)
                    self.assertEqual(profile["backing_image"], "/daemon/storage/build-volumes/" + ledger.IMAGE_NAME)
                    self.assertEqual(backend["volumes"], [descriptor["mount"]])
                    self.assertEqual(backend["x-fullmag-host-ledger-volume"], descriptor)
                    self.assertEqual(profile["daemon_volume"], descriptor)
                    prepare_volume.assert_called_once()
                    remove.assert_called_once_with("rm", "verified-container")
                self.assertEqual(adapter.read_owned_regular.call_count, 2)

    def test_retained_daemon_bind_is_pinned_across_client_path_translation(self):
        source = "/mnt/host/wsl/docker-desktop-bind-mounts/distribution/verified"
        service = {"volumes": [{"type": "bind", "source": "/home/user/checkout", "target": "/source",
                                "read_only": True}], "x-fullmag-daemon-binds": {"/source": source}}
        document = {"services": {"backend": service}}
        actual = {"Config": {}, "HostConfig": {"ReadonlyRootfs": True, "Privileged": False, "Tmpfs": {}},
                  "Mounts": [{"Destination": "/source", "Source": source, "Type": "bind", "RW": False}]}
        dev._validate_retained_service(document, actual, "backend", {})
        changed = copy.deepcopy(actual)
        changed["Mounts"][0]["Source"] = source + "-another-checkout"
        with self.assertRaisesRegex(BuildControlError, "bind differs"):
            dev._validate_retained_service(document, changed, "backend", {})

    def test_retained_linux_directory_and_engine_must_match_host_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            document = {"services": {"backend": {"environment": {"FULLMAG_SESSION_STORAGE_PROFILE": host.PROFILE}}}}
            certificate = {"schema": host.HOST_SCHEMA, "storage_profile": host.PROFILE,
                           "host_inode": state.stat().st_ino, "engine_id": "engine"}
            def save(value):
                host.publish_evidence(state / host.CERTIFICATE_NAME, value)
                host.publish_evidence(state / host.OWNER_NAME, value)
            save(certificate)
            with patch.object(dev, "_session_host", return_value=host), \
                 patch.object(dev, "local_volume", return_value={}), \
                 patch.object(dev, "docker_text", return_value="engine"):
                self.assertEqual(dev._retained_certificate(state, document), certificate)
                save({**certificate, "host_inode": certificate["host_inode"] + 1})
                with self.assertRaisesRegex(BuildControlError, "identity differs"):
                    dev._retained_certificate(state, document)
                save({**certificate, "engine_id": "another-engine"})
                with self.assertRaisesRegex(BuildControlError, "identity differs"):
                    dev._retained_certificate(state, document)


if __name__ == "__main__":
    unittest.main()
