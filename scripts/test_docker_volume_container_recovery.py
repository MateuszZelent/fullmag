"""Interpreted regressions for controlled stopped-container recovery.

These checks are intentionally Docker-free.  They cover the authorization,
outcome-unknown journal and helper command boundaries without compiling Rust,
starting Compose, or touching a runtime volume.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
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

        host = {
            "profile": "windows-folder-v1",
            "selection": "windows-default",
            "context_name": "desktop-linux",
            "endpoint": "desktop-linux",
            "daemon_id": "windows-engine",
        }
        runtime = {"uid": 65532, "gid": 65532}
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
            "runtime_uid": runtime["uid"],
            "runtime_gid": runtime["gid"],
        }).encode()
        result = type("Result", (), {"returncode": 0, "stdout": output, "stderr": b""})()
        import docker_platform

        with patch.object(recovery, "_managed_host_context", return_value=(
                "windows-folder-v1", runtime, host)), \
                patch.object(recovery, "bounded_capture", return_value=result) as capture, \
                patch.object(docker_platform, "docker_cli_prefix", return_value=[
                    "docker", "--context", "desktop-linux",
                ]), \
                patch.object(docker_platform, "docker_environment", return_value={}):
            proof = recovery._ledger_and_store_snapshot(Control(), backend)
        self.assertEqual(proof["ledger_snapshot_sha256"], "3" * 64)
        argv = capture.call_args.args[0]
        self.assertIn("/usr/local/bin/python3", argv)
        self.assertIn("--context", argv)
        self.assertIn("desktop-linux", argv)
        self.assertIn("65532:65532", argv)
        self.assertIn("-B", argv)
        self.assertIn("-c", argv)
        self.assertIn("type=bind,src=/windows/state,dst=/state,readonly", argv)
        self.assertIn("type=bind,src=/windows/ledger,dst=/host-ledger,readonly", argv)
        self.assertIn("deadline=time.monotonic()+5", " ".join(argv))
        self.assertNotIn("bind-nonrecursive", " ".join(argv))

    def test_linux_storage_probe_pins_local_endpoint_and_runtime_identity(self):
        import docker_platform

        class Control:
            project = "fullmag-test"

        host = {
            "profile": "linux-native-v1",
            "selection": "context",
            "context_name": "local-user",
            "endpoint": "unix:///run/user/1001/docker.sock",
            "daemon_id": "linux-engine",
        }
        runtime = {"uid": 1001, "gid": 1002}
        backend = {
            "Image": "sha256:" + "f" * 64,
            "Mounts": [
                {"Destination": "/state", "Type": "bind", "Source": "/srv/fullmag/state", "RW": True},
                {"Destination": "/host-ledger", "Type": "bind", "Source": "/srv/fullmag/ledger", "RW": True},
            ],
        }
        output = json.dumps({
            "store_root_sha256": "1" * 64,
            "ledger_root_sha256": "2" * 64,
            "ledger_snapshot_sha256": "3" * 64,
            "run_records": [],
            "runtime_uid": runtime["uid"],
            "runtime_gid": runtime["gid"],
        }).encode()
        result = type("Result", (), {"returncode": 0, "stdout": output, "stderr": b""})()
        with patch.object(recovery, "_managed_host_context", return_value=(
                "linux-native-v1", runtime, host)), \
                patch.object(recovery, "bounded_capture", return_value=result) as capture, \
                patch.object(docker_platform, "docker_cli_prefix", return_value=[
                    "docker", "--host", host["endpoint"],
                ]), \
                patch.object(docker_platform, "docker_environment", return_value={
                    "PATH": "/usr/bin",
                }):
            proof = recovery._ledger_and_store_snapshot(
                Control(), backend, expected_docker_host=host
            )
        argv = capture.call_args.args[0]
        self.assertEqual(argv[:3], ["docker", "--host", host["endpoint"]])
        self.assertIn("1001:1002", argv)
        self.assertEqual(capture.call_args.kwargs["env"], {"PATH": "/usr/bin"})
        self.assertEqual(proof["runtime_uid"], 1001)
        self.assertEqual(proof["runtime_gid"], 1002)
        wrong_user_output = json.dumps({
            "store_root_sha256": "1" * 64,
            "ledger_root_sha256": "2" * 64,
            "ledger_snapshot_sha256": "3" * 64,
            "run_records": [],
            "runtime_uid": 0,
            "runtime_gid": 0,
        }).encode()
        wrong_user = type("Result", (), {
            "returncode": 0, "stdout": wrong_user_output, "stderr": b"",
        })()
        with patch.object(recovery, "_managed_host_context", return_value=(
                "linux-native-v1", runtime, host)), \
                patch.object(recovery, "bounded_capture", return_value=wrong_user), \
                patch.object(docker_platform, "docker_cli_prefix", return_value=[
                    "docker", "--host", host["endpoint"],
                ]), \
                patch.object(docker_platform, "docker_environment", return_value={
                    "PATH": "/usr/bin",
                }):
            with self.assertRaisesRegex(recovery.ContainerRecoveryError, "UID/GID"):
                recovery._ledger_and_store_snapshot(
                    Control(), backend, expected_docker_host=host
                )

    def test_linux_reused_session_requires_certificate_and_operation_identity(self):
        import docker_platform
        import docker_volume_dev

        host = {
            "profile": "linux-native-v1",
            "selection": "context",
            "context_name": "local-user",
            "endpoint": "unix:///run/user/1001/docker.sock",
            "daemon_id": "linux-engine",
        }
        identity = {"uid": 1001, "gid": 1002}
        certificate = {
            "schema": "fullmag.linux-native-host-certificate.v1",
            "storage_profile": "linux-native-v1",
            "image_id": "sha256:" + "a" * 64,
            "owner_token": "11111111-1111-4111-8111-111111111111",
            "restart_verified": True,
            "source_commit": "b" * 40,
            "binary_hashes": {"fullmag-api": "c" * 64},
            "artifact_receipt_sha256": "d" * 64,
            "development_build": {
                "schema": "fullmag.linux-native-development-build.v1",
            },
        }
        operation = {
            "state_root": "/runtime/state",
            "storage_profile": "linux-native-v1",
            "docker_host": host,
            "runtime_identity": identity,
            "owner_token": certificate["owner_token"],
            "host_certificate_sha256": "e" * 64,
            "linux_native_certificate_sha256": hashlib.sha256(
                recovery._canonical(certificate)
            ).hexdigest(),
            "inputs": {
                "storage_profile": "linux-native-v1",
                "runtime_identity": identity,
            },
        }
        loaded = (Path("/runtime/state"), Path("/runtime/certificate"),
                  Path("/runtime/owner"), certificate)
        with patch.object(docker_platform, "host_profile", return_value="linux-native-v1"), \
                patch.object(recovery, "_managed_host_context", return_value=(
                    "linux-native-v1", identity, host)), \
                patch.object(docker_volume_dev, "_load_retained_storage", return_value=loaded):
            proof = recovery._validate_reused_session_before_removal(
                {"runtime_root": Path("/runtime")}, "/runtime/state",
                operation["inputs"].get("image_id", certificate["image_id"]),
                "linux-engine", operation=operation, expected_docker_host=host,
            )
        self.assertEqual(proof["certificate"], certificate)

        operation["runtime_identity"] = {"uid": 1002, "gid": 1002}
        with patch.object(docker_platform, "host_profile", return_value="linux-native-v1"), \
                patch.object(recovery, "_managed_host_context", return_value=(
                    "linux-native-v1", identity, host)), \
                patch.object(docker_volume_dev, "_load_retained_storage", return_value=loaded):
            with self.assertRaisesRegex(recovery.ContainerRecoveryError, "runtime_identity"):
                recovery._validate_reused_session_before_removal(
                    {"runtime_root": Path("/runtime")}, "/runtime/state",
                    certificate["image_id"], "linux-engine", operation=operation,
                    expected_docker_host=host,
                )

        operation["runtime_identity"] = identity
        certificate["restart_verified"] = False
        operation["linux_native_certificate_sha256"] = hashlib.sha256(
            recovery._canonical(certificate)
        ).hexdigest()
        with patch.object(docker_platform, "host_profile", return_value="linux-native-v1"), \
                patch.object(recovery, "_managed_host_context", return_value=(
                    "linux-native-v1", identity, host)), \
                patch.object(docker_volume_dev, "_load_retained_storage", return_value=loaded):
            with self.assertRaisesRegex(recovery.ContainerRecoveryError, "verified build"):
                recovery._validate_reused_session_before_removal(
                    {"runtime_root": Path("/runtime")}, "/runtime/state",
                    certificate["image_id"], "linux-engine", operation=operation,
                    expected_docker_host=host,
                )

    def test_windows_reused_session_keeps_host_certificate_validation(self):
        import docker_platform
        import fullmag_docker_runtime as runtime
        import windows_folder_host

        state = Path("/runtime/state")
        native = {
            "host_root": str(state),
            "host_filesystem": "NTFS",
            "host_drive_type": "fixed",
            "host_volume_serial": "volume-1",
            "host_root_no_reparse": True,
        }
        owner = "11111111-1111-4111-8111-111111111111"
        certificate = {
            "schema": windows_folder_host.HOST_SCHEMA,
            "storage_profile": "windows-folder-v1",
            "role": "session",
            "owner_scope": "docker-desktop-linux",
            "owner_token": owner,
            **native,
            "image_id": "sha256:" + "a" * 64,
            "engine_id": "windows-engine",
        }

        def read_certificate(path, _label):
            return certificate if Path(path).name == "windows-folder-host.json" else dict(certificate)

        with patch.object(docker_platform, "host_profile", return_value="windows-folder-v1"), \
                patch.object(recovery.storage, "validate_path", return_value=state), \
                patch.object(runtime, "_read_reuse_json", side_effect=read_certificate), \
                patch.object(windows_folder_host, "local_volume", return_value=native):
            proof = recovery._validate_reused_session_before_removal(
                {"runtime_root": Path("/runtime")}, state,
                certificate["image_id"], "windows-engine",
            )
        self.assertEqual(proof["certificate"], certificate)

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
