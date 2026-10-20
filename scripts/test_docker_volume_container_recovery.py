"""Interpreted regressions for controlled stopped-container recovery.

These checks are intentionally Docker-free.  They cover the authorization,
outcome-unknown journal and helper command boundaries without compiling Rust,
starting Compose, or touching a runtime volume.
"""
from __future__ import annotations

import hashlib
import copy
import json
from pathlib import Path
import sys
import tempfile
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_container_recovery as recovery  # noqa: E402


class ContainerRecoveryTests(unittest.TestCase):
    @staticmethod
    def operator(**overrides):
        value = {
            "schema_version": recovery.OPERATOR_AUTHORIZATION_SCHEMA,
            "request_id": "1eccf696-733d-4506-bbd7-9fd79ea602fa",
            "source_root": "C:/git/fullmag/fullmag",
            "compose_project": "fullmag-worktree-docker-volume-only-implementatio-670653a9f4702651",
            "development_attempt": "a" * 32,
            "compose_config_sha256": "1" * 64,
            "backend_container_id": "2" * 64,
            "frontend_container_id": "3" * 64,
            "old_image_id": "sha256:" + "4" * 64,
            "prior_stop_journal": "verification/stop-unadmitted-" + "a" * 32 + ".json",
            "prior_stop_journal_sha256": "5" * 64,
            "process_receipt_sha256": "6" * 64,
            "config_sha256": "7" * 64,
            "owner_sha256": "8" * 64,
            "launch_sha256": "9" * 64,
        }
        value.update(overrides)
        return value

    def test_operator_authorization_binds_prior_journal_not_shutdown_receipt(self):
        value = recovery.validate_operator_authorization(self.operator())
        self.assertEqual(value["prior_ready_owner_proof_sha256"], "5" * 64)
        with self.assertRaisesRegex(recovery.ContainerRecoveryError, "fields"):
            recovery.validate_operator_authorization({**self.operator(), "unexpected": True})

    def test_outcome_unknown_journal_requires_empty_reprobe(self):
        authorization = recovery.validate_operator_authorization(self.operator())
        journal = {
            "schema": "fullmag.docker-unadmitted-stop.v1",
            "state": "outcome-unknown",
            "attempt": authorization["attempt"],
            "backend_container_id": authorization["backend_container_id"],
            "frontend_container_id": authorization["frontend_container_id"],
            "image_id": authorization["old_image_id"],
            "process_receipt_sha256": "a" * 64,
            "request_id": "docker-startup-" + "b" * 32,
            "session_id": "docker-startup-" + "c" * 32,
            "source_sha256": "d" * 64,
            "failure_marker_sha256": "e" * 64,
            "proof_recheck": {
                "schema": "fullmag.docker-unadmitted-stop-probe.v1",
                "request_id": "docker-startup-" + "b" * 32,
                "session_id": "docker-startup-" + "c" * 32,
                "source_sha256": "d" * 64,
                "activation_marker_sha256": "e" * 64,
                "process_receipt_sha256": "a" * 64,
                "current_session": {"status": "startup_failed"},
                "compute_queue": {"items": []},
                "current_run_status": 404,
                "accepted_store": {"run_records": []},
                "host_ledger": {"reservation_states": ["released"]},
                "runtime_service": {"configured": True, "state": "ready"},
            },
        }
        recovery._validate_pre_admission_stop_journal(
            journal, authorization, authorization["attempt"]
        )
        journal["proof_recheck"]["accepted_store"]["run_records"] = ["run_intent.json"]
        with self.assertRaisesRegex(recovery.ContainerRecoveryError, "run records"):
            recovery._validate_pre_admission_stop_journal(
                journal, authorization, authorization["attempt"]
            )

    def test_storage_probe_uses_old_backend_python_and_readonly_binds(self):
        class Control:
            project = "fullmag-test"

        backend = {
            "Image": "sha256:" + "f" * 64,
            "Mounts": [
                {"Destination": "/state", "Type": "bind", "Source": "/windows/state", "RW": True},
                {"Destination": "/host-ledger", "Type": "bind", "Source": "/windows/ledger", "RW": True},
            ],
        }
        output = json.dumps({
            "store_root_sha256": "1" * 64,
            "ledger_root_sha256": "2" * 64,
            "ledger_snapshot_sha256": "3" * 64,
            "run_records": [],
        }).encode()
        result = type("Result", (), {"returncode": 0, "stdout": output, "stderr": b""})()
        with patch.object(recovery, "bounded_capture", return_value=result) as capture:
            proof = recovery._ledger_and_store_snapshot(Control(), backend)
        self.assertEqual(proof["ledger_snapshot_sha256"], "3" * 64)
        argv = capture.call_args.args[0]
        self.assertIn("/usr/local/bin/python3", argv)
        self.assertIn("-B", argv)
        self.assertIn("-c", argv)
        self.assertIn("type=bind,src=/windows/state,dst=/state,readonly", argv)
        self.assertIn("type=bind,src=/windows/ledger,dst=/host-ledger,readonly", argv)
        self.assertIn("deadline=time.monotonic()+5", " ".join(argv))
        self.assertNotIn("bind-nonrecursive", " ".join(argv))

    def test_storage_probe_uses_selected_host_docker_adapter(self):
        backend = {"Image": "sha256:" + "f" * 64, "Mounts": [
            {"Destination": "/state", "Type": "bind", "Source": "/state/source", "RW": True},
            {"Destination": "/host-ledger", "Type": "bind", "Source": "/ledger/source", "RW": True}]}
        output = json.dumps({"store_root_sha256": "1" * 64,
            "ledger_root_sha256": "2" * 64, "ledger_snapshot_sha256": "3" * 64,
            "run_records": []}).encode()
        result = SimpleNamespace(returncode=0, stdout=output, stderr=b"")
        with patch.object(recovery, "docker_argv", return_value=["docker", "run"]) as adapter, \
             patch.object(recovery, "bounded_capture", return_value=result) as capture:
            recovery._ledger_and_store_snapshot(SimpleNamespace(project="fullmag-test"), backend)
        adapter.assert_called_once_with("run")
        self.assertEqual(capture.call_args.args[0][:2], ["docker", "run"])
        self.assertNotIn("desktop-linux", capture.call_args.args[0])

    @staticmethod
    def ledger_volume_fixture():
        import docker_host_ledger as ledger
        project = "fullmag-test"
        mount_root = "/mnt/fullmag-host-ledger-project-test"
        receipt = {"schema": ledger.HOST_RECEIPT_SCHEMA, "profile": ledger.PROFILE,
            "state": "ready", "project_id": "project-test", "mount_root": mount_root,
            "backing_image": "/canonical/storage/build-volumes/" + ledger.IMAGE_NAME,
            "ledger_root": mount_root + "/ledger", "mount_target": "/host-ledger",
            "filesystem": "ext4", "filesystem_uuid": "11111111-1111-4111-8111-111111111111",
            "loop_device": "/dev/loop7", "image_size_bytes": ledger.IMAGE_SIZE_BYTES,
            "mount_active": True}
        descriptor = ledger.host_volume_descriptor(project, "project-test", mount_root, receipt)
        mountpoint = "/var/lib/docker/volumes/" + descriptor["name"] + "/_data"
        volume = {"Name": descriptor["name"], "Driver": "local", "Scope": "local",
                  "Options": descriptor["options"], "Labels": descriptor["labels"], "Mountpoint": mountpoint}
        compose = {"name": project, "volumes": {"host-ledger": descriptor["compose_volume"]},
                   "services": {"backend": {"x-fullmag-host-ledger-volume": descriptor,
                       "volumes": [descriptor["mount"]], "environment": {
                           "FULLMAG_HOST_LEDGER_PROJECT_ID": descriptor["project_id"],
                           "FULLMAG_HOST_LEDGER_MOUNT_ROOT": descriptor["mount_root"],
                           "FULLMAG_HOST_LEDGER_BACKING_IMAGE": receipt["backing_image"]}}}}
        backend = {"Image": "sha256:" + "a" * 64, "Mounts": [
            {"Destination": "/state", "Type": "bind", "Source": "/host/state", "RW": True},
            {"Destination": "/host-ledger", "Type": "volume", "Name": descriptor["name"],
             "Driver": "local", "Source": mountpoint, "RW": True}]}
        return compose, backend, volume

    def test_storage_probe_mounts_exact_inspected_ledger_volume_readonly(self):
        compose, backend, volume = self.ledger_volume_fixture()
        output = json.dumps({"store_root_sha256": "1" * 64, "ledger_root_sha256": "2" * 64,
                             "ledger_snapshot_sha256": "3" * 64, "run_records": []}).encode()
        with patch.object(recovery, "docker_capture", return_value=SimpleNamespace(stdout=json.dumps([volume]).encode())) as inspect, \
                patch.object(recovery, "bounded_capture", return_value=SimpleNamespace(returncode=0, stdout=output, stderr=b"")) as helper:
            recovery._ledger_and_store_snapshot(SimpleNamespace(project=compose["name"]), backend, compose=compose)
        inspect.assert_called_once_with("volume", "inspect", volume["Name"], timeout=30)
        argv = helper.call_args.args[0]
        self.assertIn("type=volume,src=" + volume["Name"] + ",dst=/host-ledger,readonly,volume-nocopy", argv)
        self.assertFalse(any(volume["Mountpoint"] in argument for argument in argv))
        self.assertEqual(json.loads(argv[-1]), compose["services"]["backend"]["x-fullmag-host-ledger-volume"])
        self.assertEqual(volume["Options"]["device"],
                         compose["services"]["backend"]["x-fullmag-host-ledger-volume"]["device_alias"])

    def test_volume_proof_refusal_stops_helper_before_storage_snapshot(self):
        import docker_host_ledger as ledger
        compose, backend, volume = self.ledger_volume_fixture()
        output = json.dumps({"store_root_sha256": "1" * 64, "ledger_root_sha256": "2" * 64,
                             "ledger_snapshot_sha256": "3" * 64, "run_records": []}).encode()
        refusal = "def probe(descriptor):\n raise RuntimeError('volume-proof-refusal')\n"
        with patch.object(recovery, "docker_capture", return_value=SimpleNamespace(stdout=json.dumps([volume]).encode())), \
                patch.object(ledger, "HOST_VOLUME_PROBE_FUNCTIONS", refusal), \
                patch.object(recovery, "bounded_capture", return_value=SimpleNamespace(returncode=0, stdout=output, stderr=b"")) as helper:
            recovery._ledger_and_store_snapshot(SimpleNamespace(project=compose["name"]), backend, compose=compose)
        argv = helper.call_args.args[0]
        result = subprocess.run([sys.executable, "-B", "-c", argv[-2], argv[-1]], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("volume-proof-refusal", result.stderr)

    def test_ledger_volume_requires_canonical_cas_and_inspected_ownership(self):
        mutations = {
            "missing-descriptor": lambda c, b, v: c["services"]["backend"].pop("x-fullmag-host-ledger-volume"),
            "wrong-project": lambda c, b, v: c.update(name="another-project"),
            "nonexternal": lambda c, b, v: c["volumes"]["host-ledger"].update(external=False),
            "wrong-device": lambda c, b, v: v.update(Options={"type": "none", "o": "bind", "device": "/wrong-root"}),
            "wrong-label": lambda c, b, v: v.update(Labels={}),
            "wrong-driver": lambda c, b, v: v.update(Driver="nfs"),
            "wrong-scope": lambda c, b, v: v.update(Scope="global"),
            "wrong-name": lambda c, b, v: b["Mounts"][1].update(Name="foreign-volume"),
            "wrong-mountpoint": lambda c, b, v: b["Mounts"][1].update(Source="/foreign/_data"),
            "unexpected-bind": lambda c, b, v: b["Mounts"][1].update(Type="bind"),
            "readonly-owner": lambda c, b, v: b["Mounts"][1].update(RW=False),
            "wrong-descriptor": lambda c, b, v: c["services"]["backend"].update(**{"x-fullmag-host-ledger-volume": {}}),
            "wrong-backing": lambda c, b, v: c["services"]["backend"]["environment"].update(FULLMAG_HOST_LEDGER_BACKING_IMAGE="/wrong/backing.ext4"),
            "missing-receipt": lambda c, b, v: c["services"]["backend"]["x-fullmag-host-ledger-volume"].pop("host_receipt"),
            "raw-loop-alias": lambda c, b, v: c["services"]["backend"]["x-fullmag-host-ledger-volume"]["host_receipt"].update(device_alias="/dev/loop7"),
            "missing-nocopy": lambda c, b, v: c["services"]["backend"].update(volumes=[{
                "type": "volume", "source": "host-ledger", "target": "/host-ledger"}]),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                compose, backend, volume = copy.deepcopy(self.ledger_volume_fixture())
                mutate(compose, backend, volume)
                with patch.object(recovery, "docker_capture", return_value=SimpleNamespace(stdout=json.dumps([volume]).encode())), \
                        patch.object(recovery, "bounded_capture") as helper:
                    with self.assertRaises(recovery.ContainerRecoveryError):
                        recovery._ledger_and_store_snapshot(SimpleNamespace(project="fullmag-test"), backend, compose=compose)
                    helper.assert_not_called()

    def test_retained_storage_checks_both_explicit_host_profiles(self):
        import linux_native_host
        for windows in (False, True):
            with self.subTest(windows=windows), tempfile.TemporaryDirectory() as directory:
                state = Path(directory) / "session"
                state.mkdir()
                native = {"host_root": str(state), "host_filesystem": "NTFS" if windows else "ext4",
                          "host_root_no_reparse": True}
                native.update({"host_drive_type": "fixed", "host_volume_serial": "ABCD"} if windows
                              else {"host_device": state.stat().st_dev, "host_platform": "linux"})
                host = SimpleNamespace(
                    HOST_SCHEMA="fullmag.windows-folder-host.v1" if windows else linux_native_host.HOST_SCHEMA,
                    HOST_CERT_PATH="/run/fullmag/windows-folder-host.json" if windows else linux_native_host.HOST_CERT_PATH,
                    OWNER_NAME=".fullmag-windows-folder-owner.json" if windows else linux_native_host.OWNER_NAME,
                    local_volume=lambda path: native,
                    # Exercise real bounded nofollow reads for both fixtures.
                    read_owned_regular=linux_native_host.read_owned_regular)
                certificate = {"schema": host.HOST_SCHEMA, "storage_profile": "windows-folder-v1" if windows else "linux-native-v1",
                    "role": "session", "owner_scope": "docker-desktop-linux" if windows else "docker-linux",
                    "owner_token": "1eccf696-733d-4506-bbd7-9fd79ea602fa" if windows else "1eccf696733d4506bbd79fd79ea602fa",
                    "engine_id": "selected-engine", "image_id": "sha256:" + "a" * 64,
                    **native}
                if not windows:
                    certificate["host_inode"] = state.stat().st_ino
                certificate_path = state / Path(host.HOST_CERT_PATH).name
                owner_marker = state / host.OWNER_NAME
                def save(value):
                    data = json.dumps(value)
                    certificate_path.write_text(data)
                    owner_marker.write_text(data)
                save(certificate)
                layout = {"runtime_root": directory}
                with patch.object(recovery, "_reused_session_host", return_value=host):
                    proof = recovery._validate_reused_session_before_removal(
                        layout, str(state), certificate["image_id"], "selected-engine")
                    self.assertEqual(proof["host_certificate"], certificate_path)
                    changes = {"engine_id": "other-engine", "image_id": "sha256:" + "b" * 64,
                        "owner_scope": "foreign", "owner_token": "0" * 32,
                        "host_root": str(state / "other"), "host_filesystem": "foreign"}
                    if not windows:
                        changes.update(host_inode=state.stat().st_ino + 1, host_device=state.stat().st_dev + 1)
                    for key, value in changes.items():
                        with self.subTest(changed=key):
                            save({**certificate, key: value})
                            with self.assertRaises(recovery.ContainerRecoveryError):
                                recovery._validate_reused_session_before_removal(
                                    layout, state, certificate["image_id"], "selected-engine")
                    save(certificate)
                    owner_marker.write_text("{}")
                    with self.assertRaisesRegex(recovery.ContainerRecoveryError, "owner marker differ"):
                        recovery._validate_reused_session_before_removal(layout, state, certificate["image_id"], "selected-engine")

    def test_retained_linux_symlink_evidence_is_rejected(self):
        import linux_native_host
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "session"
            state.mkdir()
            actual = state / "actual"
            actual.write_text("{}")
            (state / linux_native_host.CERTIFICATE_NAME).symlink_to(actual)
            with patch.object(recovery, "_reused_session_host", return_value=linux_native_host), \
                 self.assertRaisesRegex(recovery.ContainerRecoveryError, "proof is unavailable"):
                recovery._validate_reused_session_before_removal(
                    {"runtime_root": directory}, state, "sha256:" + "a" * 64, "engine")

    def test_container_pin_normalizes_docker_null_device_requests(self):
        container = {
            "Id": "a" * 64,
            "Image": "sha256:" + "b" * 64,
            "Config": {
                "Labels": {
                    "com.docker.compose.project": "fullmag-test",
                    "com.docker.compose.service": "backend",
                },
            },
            "HostConfig": {"PidMode": None, "DeviceRequests": None},
        }
        pin = recovery._container_pin(container, "backend", "fullmag-test")
        self.assertEqual(pin["device_requests_sha256"], hashlib.sha256(b"[]").hexdigest())

    def test_request_uses_raw_config_sha_for_external_application(self):
        config_sha = "f" * 64
        owner = {
            "schema_version": "runtime_service_owner.v1",
            "state": "unknown",
            "owner_token": "owner-token",
            "process_start_token": "process-token",
            "target_id": "docker-all",
            "host": "backend-host",
            "protocol": "tcp",
            "pid": 100,
            "children": [{"role": "compute"}, {"role": "preparation"}],
        }
        device = {
            "resource_id": "runtime-cpu",
            "mapping_sha256": "1" * 64,
            "mapping_detached": True,
        }
        authorization = recovery.validate_operator_authorization(self.operator())
        class Control:
            @staticmethod
            def path(relative):
                return "/control/" + relative

        with patch.object(recovery, "_control_json", return_value=(None, None)):
            request = recovery._build_request(
                authorization,
                owner=owner,
                owner_sha256="2" * 64,
                launch_sha256="3" * 64,
                config={},
                control=Control(),
                device_release=device,
                config_sha256=config_sha,
                store_root_sha256="4" * 64,
                ledger_root_sha256="5" * 64,
                ledger_snapshot_sha256="6" * 64,
                docker_engine_id_sha256="7" * 64,
                manifest_sha256="8" * 64,
                containers=[
                    {
                        "container_id": "9" * 64,
                        "image_id": "sha256:" + "a" * 64,
                        "config_sha256": "b" * 64,
                        "service": "backend",
                        "compose_project": "fullmag-test",
                        "private_pid_namespace": True,
                        "host_pid": False,
                        "device_requests_sha256": "c" * 64,
                    },
                    {
                        "container_id": "d" * 64,
                        "image_id": "sha256:" + "a" * 64,
                        "config_sha256": "e" * 64,
                        "service": "frontend",
                        "compose_project": "fullmag-test",
                        "private_pid_namespace": True,
                        "host_pid": False,
                        "device_requests_sha256": "f" * 64,
                    },
                ],
            )
        self.assertEqual(request["application"], {"mode": "external_only", "raw_sha256": config_sha})

    def test_prepared_transition_is_resumable_before_absence_sidecar(self):
        """A crash between rm and absence publication remains recoverable."""
        authorization = recovery.validate_operator_authorization(self.operator())
        project = authorization["compose_project"]
        image = authorization["old_image_id"]
        backend_id = authorization["backend_container_id"]
        frontend_id = authorization["frontend_container_id"]

        def inspect(service, identifier):
            config = {
                "Labels": {
                    "com.docker.compose.project": project,
                    "com.docker.compose.service": service,
                },
            }
            return {
                "Id": identifier,
                "Image": image,
                "Config": config,
                "HostConfig": {"PidMode": None, "DeviceRequests": None},
                "State": {"Running": False, "Pid": 0, "FinishedAt": "2026-10-19T00:00:00Z"},
                "NetworkSettings": {"Networks": {"fullmag-private": {}}},
            }

        backend = inspect("backend", backend_id)
        frontend = inspect("frontend", frontend_id)
        backend_pin = recovery._container_pin(backend, "backend", project)
        frontend_pin = recovery._container_pin(frontend, "frontend", project)
        owner = {
            "schema_version": "runtime_service_owner.v1",
            "state": "unknown",
            "owner_token": "owner-token",
            "process_start_token": "process-token",
            "target_id": "docker-all",
            "host": "backend-host",
            "protocol": "tcp",
            "pid": 100,
            "children": [
                {"role": "compute", "pid": 101},
                {"role": "preparation", "pid": 102},
            ],
        }
        request = recovery.validate_request({
            "schema_version": recovery.REQUEST_SCHEMA,
            "request_id": authorization["request_id"],
            "config_sha256": "7" * 64,
            "owner_sha256": "8" * 64,
            "launch_sha256": "9" * 64,
            "expected_owner": owner,
            "store_root_sha256": "a" * 64,
            "application": {"mode": "external_only", "raw_sha256": "7" * 64},
            "ledger_root_sha256": "b" * 64,
            "ledger_snapshot_sha256": "c" * 64,
            "docker_engine_id_sha256": "d" * 64,
            "docker_manifest_sha256": "e" * 64,
            "prior_ready_owner_proof_sha256": authorization["prior_stop_journal_sha256"],
            "device_release_resource_id": "runtime-cpu",
            "device_release_mapping_sha256": "f" * 64,
            "containers": [backend_pin, frontend_pin],
        })
        request_raw = recovery._canonical(request)
        manifest = recovery._manifest(
            authorization,
            "1" * 64,
            backend,
            frontend,
            [backend_pin, frontend_pin],
            {"resource_id": "runtime-cpu", "mapping_sha256": "f" * 64, "mapping_detached": True},
            {"kind": "cpu"},
        )
        manifest_raw = recovery._canonical(manifest)
        request["docker_manifest_sha256"] = recovery._sha256(manifest_raw)
        request = recovery.validate_request(request)
        request_raw = recovery._canonical(request)
        prepared = {
            "schema": "fullmag.docker-container-recovery-transition.v1",
            "state": "prepared-before-removal",
            "request_id": authorization["request_id"],
            "old_container_ids": [backend_id, frontend_id],
            "old_image_id": image,
            "request_sha256": recovery._sha256(request_raw),
            "manifest_sha256": recovery._sha256(manifest_raw),
            "stop_journal_sha256": authorization["stop_journal_sha256"],
        }
        prepared_raw = recovery._canonical(prepared)
        records = {
            "prepared.json": (prepared, prepared_raw),
            "absence.json": (None, None),
            "request.json": (request, request_raw),
            "manifest.json": (manifest, manifest_raw),
        }

        class Control:
            pass

        Control.project = project

        def control_json(_control, relative, *, optional=False):
            item = records[relative.rsplit("/", 1)[-1]]
            return item

        def docker_inspect(*args, **kwargs):
            identifier = args[1]
            if identifier in {backend_id, frontend_id}:
                return SimpleNamespace(
                    returncode=1, stdout=b"", stderr=b"Error: no such object: " + identifier.encode()
                )
            raise AssertionError(f"unexpected Docker call: {args}")

        with patch.object(recovery, "_control_json", side_effect=control_json), patch.object(
            recovery, "docker_capture", side_effect=docker_inspect
        ) as capture:
            transition = recovery._load_recovery_transition(Control(), authorization, project)

        self.assertIsNotNone(transition)
        self.assertIsNone(transition["absence"])
        self.assertEqual(transition["present"], {})
        self.assertEqual(transition["network_name"], "fullmag-private")
        self.assertEqual(transition["prepared_sha"], recovery._sha256(prepared_raw))
        inspected = [call.args[0:3] for call in capture.call_args_list]
        self.assertEqual(len(inspected), 2)

    def test_teardown_after_requires_an_actual_exited_namespace(self):
        pin = {"device_requests_sha256": "a" * 64}
        container = {"HostConfig": {"PidMode": ""}, "State": {
            "Status": "exited", "Running": False, "Pid": 0,
            "FinishedAt": "2026-10-19T09:50:20Z"}}
        observed = recovery._container_observation(container, pin, after=True)
        self.assertEqual(observed["finished_at"], container["State"]["FinishedAt"])
        for status, pid in (("created", 0), ("exited", None), ("running", 42)):
            with self.subTest(status=status, pid=pid):
                container["State"].update(Status=status, Pid=pid)
                with self.assertRaises(recovery.ContainerRecoveryError):
                    recovery._container_observation(container, pin, after=True)


if __name__ == "__main__":
    unittest.main()
