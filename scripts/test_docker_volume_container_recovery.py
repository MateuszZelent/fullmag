"""Interpreted regressions for controlled stopped-container recovery.

These checks are intentionally Docker-free.  They cover the authorization,
outcome-unknown journal and helper command boundaries without compiling Rust,
starting Compose, or touching a runtime volume.
"""
from __future__ import annotations

import hashlib
import copy
from contextlib import contextmanager, ExitStack
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

    @staticmethod
    def terminal_request(**overrides):
        pin={"run_id":"run-terminal", "run_intent_sha256":"1"*64,
             "run_catalog_sha256":"2"*64, "artifact_catalog_sha256":"3"*64}
        value={"schema_version":recovery.TERMINAL_REQUEST_SCHEMA,"retained_terminal_runs":[pin]}
        value.update(overrides)
        return value

    def test_terminal_history_version_and_every_digest_are_required(self):
        request=self.terminal_request()
        self.assertEqual(recovery.expected_recovery_outcome(request),"retained_terminal_runs_recovered")
        for schema in [recovery.REQUEST_SCHEMA,recovery.RETAINED_REQUEST_SCHEMA,"unknown"]:
            with self.subTest(schema=schema),self.assertRaises(recovery.ContainerRecoveryError):
                recovery.expected_recovery_outcome({**request,"schema_version":schema})
        for count in [0,129]:
            with self.subTest(count=count),self.assertRaises(recovery.ContainerRecoveryError):
                recovery.expected_recovery_outcome(self.terminal_request(retained_terminal_runs=request['retained_terminal_runs']*count))
        pin=request['retained_terminal_runs'][0]
        for key in ['run_intent_sha256','run_catalog_sha256','artifact_catalog_sha256']:
            for invalid in (["short","0"*64,"F"*64] if key == 'artifact_catalog_sha256' else [None,"short","0"*64,"F"*64]):
                with self.subTest(key=key,invalid=invalid),self.assertRaises(recovery.ContainerRecoveryError):
                    recovery.expected_recovery_outcome(self.terminal_request(retained_terminal_runs=[{**pin,key:invalid}]))
        with self.assertRaises(recovery.ContainerRecoveryError):
            recovery.expected_recovery_outcome(self.terminal_request(retained_cancelled_runs=[]))
        for pins in [[pin,pin],[{k:v for k,v in pin.items() if k!='artifact_catalog_sha256'}],[{**pin,'run_id':'../escape'}]]:
            with self.assertRaises(recovery.ContainerRecoveryError):
                recovery.expected_recovery_outcome(self.terminal_request(retained_terminal_runs=pins))

    def test_cancelled_only_contract_remains_v2(self):
        pin=self.terminal_request()['retained_terminal_runs'][0]
        cancelled={k:v for k,v in pin.items() if k!='artifact_catalog_sha256'}
        request={'schema_version':recovery.RETAINED_REQUEST_SCHEMA,'retained_cancelled_runs':[cancelled]}
        self.assertEqual(recovery.expected_recovery_outcome(request),'retained_cancelled_runs_recovered')
        with self.assertRaises(recovery.ContainerRecoveryError):
            recovery.expected_recovery_outcome({**request,'retained_cancelled_runs':[pin]})
        self.assertEqual(recovery.expected_recovery_outcome({'schema_version':recovery.REQUEST_SCHEMA}),'empty_namespace_recovered')








    def test_recover_accepts_control_relative_and_absolute_paths_on_host_python(self):
        relative = "verification/recovery/authorization.json"
        for reference in (relative, recovery.CONTROL_ROOT + "/" + relative):
            with self.subTest(reference=reference):
                with patch.object(recovery, "_relative_control_path", side_effect=RuntimeError("path reached")) as validate:
                    with self.assertRaisesRegex(RuntimeError, "path reached"):
                        recovery.recover(SimpleNamespace(recovery_authorization=reference))
                validate.assert_called_once_with(relative)

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

    def test_terminal_storage_probe_preserves_pins_and_checks_exact_input_inventory(self):
        pin=self.terminal_request()['retained_terminal_runs'][0]
        records=[pin]
        backend={'Image':'sha256:'+'f'*64,'Mounts':[
            {'Destination':'/state','Type':'bind','Source':'/state/source','RW':True},
            {'Destination':'/host-ledger','Type':'bind','Source':'/ledger/source','RW':True}]}
        value={'store_root_sha256':'1'*64,'ledger_root_sha256':'2'*64,
               'ledger_snapshot_sha256':'3'*64,'run_records':records}
        result=SimpleNamespace(returncode=0,stdout=json.dumps(value).encode(),stderr=b'')
        with patch.object(recovery,'bounded_capture',return_value=result) as capture:
            recovery._ledger_and_store_snapshot(SimpleNamespace(project='fullmag-test'),backend,retained_terminal_runs=[pin])
        observation=json.loads(capture.call_args.args[0][-1])
        self.assertEqual(observation['retained_terminal_runs'],[pin])
        self.assertEqual(observation['retained_cancelled_runs'],[pin])
        self.assertTrue(observation['terminal_mode'])
        result.stdout=json.dumps({**value,'run_records':[]}).encode()
        with patch.object(recovery,'bounded_capture',return_value=result):
            with self.assertRaises(recovery.ContainerRecoveryError):
                recovery._ledger_and_store_snapshot(SimpleNamespace(project='fullmag-test'),backend,retained_terminal_runs=[pin])
        with self.assertRaises(recovery.ContainerRecoveryError):
            recovery._ledger_and_store_snapshot(SimpleNamespace(project='fullmag-test'),backend,
                retained_terminal_runs=[pin],retained_cancelled_runs=[])

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
        observation = json.loads(argv[-1])
        self.assertEqual(observation["ledger_descriptor"], compose["services"]["backend"]["x-fullmag-host-ledger-volume"])
        # No retained cancelled runs are pinned for this recovery.
        self.assertIsNone(observation["retained_cancelled_runs"])
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

        pin=self.terminal_request()['retained_terminal_runs'][0]
        for retained in [{}, {'retained_cancelled_runs':[{k:v for k,v in pin.items() if k!='artifact_catalog_sha256'}]},
                         {'retained_terminal_runs':[pin]}]:
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
                    **retained,
                )
            self.assertEqual(request["application"], {"mode": "external_only", "raw_sha256": config_sha})
            if 'retained_terminal_runs' in retained:
                self.assertEqual(request['schema_version'],recovery.TERMINAL_REQUEST_SCHEMA)
                self.assertEqual(recovery.expected_recovery_outcome(request),'retained_terminal_runs_recovered')
                with self.assertRaisesRegex(recovery.ContainerRecoveryError,'unexpected fields'):
                    recovery.validate_attestation({'schema_version':recovery.ABSENCE_ATTESTATION_SCHEMA},request,'1'*64)

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

    def test_recovery_args_preserve_retained_native_contract_and_all_44_source_files(self):
        import docker_volume_dev as volume_dev

        retained_files = [f"untracked-inputs/input-{index:02d}.py" for index in range(44)]
        normalized_files = volume_dev.normalize_include_untracked_paths(retained_files)
        terminal = {"inputs": {"native_contracts": ["fem-demag-poisson"]}}
        compose = {"services": {"backend": {
            "command": ["start", "--native-contract", "fem-demag-poisson"],
            "environment": {volume_dev.INCLUDE_UNTRACKED_ENV: json.dumps(
                normalized_files, ensure_ascii=False, separators=(",", ":"))},
        }}}
        args = SimpleNamespace(source_root=Path("/old"), script=Path("old.py"),
                               native_contract=None, include_untracked=None)
        native_contracts, include_untracked = recovery._retained_start_selections(args, terminal, compose)

        result = recovery._recover_args(
            args, Path("/selected"), native_contracts=native_contracts,
            include_untracked=include_untracked)

        self.assertEqual(result.source_root, Path("/selected"))
        self.assertEqual(result.native_contract, ["fem-demag-poisson"])
        self.assertEqual(result.include_untracked, retained_files)
        self.assertEqual(len(result.include_untracked), 44)
        with self.assertRaisesRegex(recovery.ContainerRecoveryError, "source allowlist"):
            recovery._retained_start_selections(
                SimpleNamespace(native_contract=None, include_untracked=[]), terminal, compose)
        with self.assertRaisesRegex(recovery.ContainerRecoveryError, "native contracts"):
            recovery._retained_start_selections(
                SimpleNamespace(native_contract=["fem-cuda-activity-trace"], include_untracked=None),
                terminal, compose)

    def test_recovery_pins_layout_from_retained_terminal_and_refuses_legacy_fallback(self):
        import docker_volume_dev as volume_dev

        writes = []
        control = SimpleNamespace(write=lambda path, value: writes.append((path, copy.deepcopy(value))),
                                  read=lambda path, optional=False: None)
        operation = {"root": "development/attempts/" + "a" * 32,
                     "receipt": {"private_group_storage": None}}
        terminal = {"private_group_storage": "group-volume-v1"}

        self.assertTrue(recovery._pin_recovery_private_group_storage(control, operation, terminal))
        self.assertEqual(operation["receipt"]["private_group_storage"], "group-volume-v1")
        self.assertEqual(writes, [(operation["root"] + "/receipt.json", operation["receipt"])])

        legacy = {"root": "development/attempts/" + "b" * 32, "receipt": {}}
        self.assertFalse(recovery._pin_recovery_private_group_storage(control, legacy, {}))
        self.assertEqual(len(writes), 1)

        grouped_marker = {"schema": "fullmag.docker-group-storage-owner.v1"}
        foreign_control = SimpleNamespace(write=lambda *_args: None,
                                           read=lambda path, optional=False: grouped_marker)
        with self.assertRaisesRegex(volume_dev.BuildControlError, "cannot fall back"):
            recovery._pin_recovery_private_group_storage(foreign_control, legacy, {})

    def test_recovery_layout_pin_requires_same_retained_terminal_bytes_at_boundary(self):
        terminal = {"private_group_storage": "group-volume-v1", "inputs": {"native_contracts": []}}
        raw = recovery._canonical(terminal)
        self.assertIsNone(recovery._assert_retained_terminal_matches(terminal, raw, terminal, raw))
        with self.assertRaisesRegex(recovery.ContainerRecoveryError, "retained terminal changed"):
            recovery._assert_retained_terminal_matches(
                terminal, raw, {**terminal, "private_group_storage": "legacy"}, raw)
        with self.assertRaisesRegex(recovery.ContainerRecoveryError, "retained terminal changed"):
            recovery._assert_retained_terminal_matches(terminal, raw + b"\n", terminal, raw)

    def test_recovery_inherits_layout_before_removing_old_containers(self):
        import inspect

        source = inspect.getsource(recovery.recover)
        boundary = source.index("_revalidate_recovery_boundary(")
        pin = source.index("_pin_recovery_private_group_storage(control, operation, terminal)")
        remove = source.index('docker_capture("rm"')
        self.assertLess(boundary, pin)
        self.assertLess(pin, remove)



class ContainerRecoveryStorageLayoutTests(unittest.TestCase):
    """Exercise the real recovery controller with Docker/storage boundaries faked."""

    def run_recovery(self, *, previous_layout="group-volume-v1",
                     group_owner=True, absent=False, changed_authorization=False,
                     fresh_generation=False, invalid_archive=False,
                     helper_image=None):
        import docker_build_control as build
        import docker_dev as dev
        import docker_volume_dev as volume
        import docker_group_ledger as ledger

        source = Path(__file__).resolve().parents[1]
        project = "fullmag-test"
        compose = {"name": project, "services": {"backend": {"environment": {}}}}
        journal = {"state": "stopped"}
        operator = ContainerRecoveryTests.operator(
            source_root=str(source), compose_project=project,
            compose_config_sha256=recovery._sha256(recovery._canonical(compose)),
            prior_stop_journal_sha256=recovery._sha256(recovery._canonical(journal)),
        )
        authorization = recovery.validate_operator_authorization(operator)
        reference = "verification/operator.json"
        terminal = {"phase": "development", "attempt": "a" * 32,
                    "state_root": str(source / "fake-state"),
                    "inputs": {"gpu_access_requested": "disabled"}}
        if previous_layout is not None:
            terminal["private_group_storage"] = previous_layout

        class Control:
            def __init__(self):
                self.project = project
                self.image = "image@sha256:" + "5" * 64
                self.lease_image = None
                self.records = {}
                self.operation_record = None
                self.removed = []
                self.teardown_receipt = None
                self.start_receipt = None
                self.start_script = "not-started"

            def prepare(self):
                pass

            def read_bytes(self, relative, *, optional=False):
                if optional:
                    return self.records.get(relative)
                return self.records[relative]

            def read(self, relative, *, optional=False):
                raw = self.read_bytes(relative, optional=optional)
                return json.loads(raw) if raw is not None else None

            def write_bytes(self, relative, raw):
                self.records[relative] = bytes(raw)

            def write(self, relative, value):
                self.write_bytes(relative, recovery._canonical(value))

            @contextmanager
            def operation(self, phase, inputs):
                self.lease_image = self.image
                self.operation_record = {
                    "root": phase + "/attempts/" + "b" * 32,
                    "receipt": {"phase": phase, "attempt": "b" * 32, "inputs": inputs},
                }
                yield self.operation_record

        control = self.recovery_control = Control()
        control.write(reference, operator)
        control.write("development/attempts/" + "a" * 32 + "/terminal.json", terminal)
        control.write("development/attempts/" + "a" * 32 + "/compose.json", compose)
        control.write(authorization["stop_journal_path"], journal)
        if group_owner:
            control.write("private/.owner.json",
                          {"schema": "fullmag.docker-group-storage-owner.v1"})

        if fresh_generation:
            token = "e" * 32
            archive_path = ("recreate-services/attempts/" + token
                            + "/runtime-control-archive-terminal.json")
            archive = {"state": "succeeded", "operation_attempt": token,
                       "compose_project": project,
                       "preserved_group_ledger_volume": "archived-ledger"}
            control.write(archive_path, archive)
            generation = {
                "schema": "fullmag.docker-group-ledger-generation.v1",
                "compose_project": project, "generation": token,
                "archive_terminal_path": archive_path,
                "preserved_volume": "archived-ledger",
                "archive_terminal_sha256": recovery._sha256(recovery._canonical(archive)),
            }
            if invalid_archive:
                generation["archive_terminal_sha256"] = "0" * 64
            control.write("group-ledger-generation.json", generation)

        def container(service, identifier):
            return {
                "Id": identifier, "Image": authorization["old_image_id"],
                "Config": {"Labels": {"com.docker.compose.project": project,
                                      "com.docker.compose.service": service},
                           "Env": ["FULLMAG_DOCKER_DEVICE_ACCESS=cpu"]},
                "HostConfig": {"PidMode": "", "DeviceRequests": None},
                "State": {"Status": "exited", "Running": False, "Pid": 0,
                          "FinishedAt": "2026-11-11T00:00:00Z"},
            }

        backend = container("backend", authorization["backend_container_id"])
        frontend = container("frontend", authorization["frontend_container_id"])
        pins = [recovery._container_pin(item, role, project)
                for item, role in [(backend, "backend"), (frontend, "frontend")]]
        transition = {
            "backend": backend, "frontend": frontend, "pins": pins,
            "network_name": "fullmag-private", "manifest": {},
            "manifest_sha": "1" * 64, "request": {}, "request_raw": b"{}",
            "request_sha": "2" * 64, "prepared_sha": "3" * 64,
            "absence": {"state": "old-containers-absent"} if absent else None,
            "absence_sha": "4" * 64, "network_state": "absent",
            "present": {} if absent else {"backend": backend, "frontend": frontend},
        }
        proof = {"store_root_sha256": "a" * 64, "ledger_root_sha256": "b" * 64,
                 "ledger_snapshot_sha256": "c" * 64}
        fresh = {
            "backend": backend, "frontend": frontend, "network_name": "fullmag-private",
            "owner": {}, "launch_sha": authorization["launch_sha256"],
            "runtime_config": {"store_root": "/state/store"},
            "config_sha": authorization["config_sha256"], "old_access": "cpu",
            "device_release": {}, "device_mapping": {}, "engine_id": "engine",
            "engine_sha": "d" * 64, "pins": pins, "storage_proof": proof,
            "transition": transition,
        }
        identity = {"project_name": project, "project_id": "project",
                    "worktree_id": "worktree", "checkout_kind": "worktree"}
        configured = {"services": {"fem-gpu-toolchain": {"build": {
            "args": {"FULLMAG_CUDA_BASE_IMAGE": "image@sha256:" + "5" * 64}}}}}
        toolchain = {"inputs": {"build_args": {"FULLMAG_CUDA_BASE_IMAGE":
                                                "image@sha256:" + "5" * 64}}}

        def read(_control, relative, *, optional=False):
            raw = control.read_bytes(relative, optional=optional)
            if changed_authorization and relative == reference and control.operation_record:
                return b"changed"
            return raw

        def remove(*args, **kwargs):
            self.assertEqual(args[0], "rm")
            control.teardown_receipt = copy.deepcopy(control.operation_record["receipt"])
            control.removed.extend(args[1:])

        def start(args, *, operation, **kwargs):
            # Keep the existing allocation guard real, as it is in production.
            volume._uses_private_group_storage(control, operation)
            control.start_receipt = copy.deepcopy(operation["receipt"])
            control.start_script = args.script

        with ExitStack() as stack:
            values = [
                (recovery, "BuildControl", control),
                (recovery, "toolchain_configuration", configured),
                (recovery, "_load_recovery_transition", transition),
                (recovery, "_runtime_process_receipt", ({}, b"process", authorization["process_receipt_sha256"])),
                (recovery, "_runtime_owner", ({}, b"owner", authorization["owner_sha256"])),
                (recovery, "_runtime_launch", ({}, b"launch", authorization["launch_sha256"])),
                (recovery, "_runtime_config", ({"store_root": "/state/store"}, b"config", authorization["config_sha256"])),
                (recovery, "_device_release_from_config", ({}, {})),
                (recovery, "_docker_engine_sha", "d" * 64),
                (recovery, "_ledger_and_store_snapshot", proof),
                (recovery, "_revalidate_recovery_boundary", fresh),
                (recovery, "_validate_reused_session_before_removal",
                 {"state": "/state", "host_certificate": "/state/certificate",
                  "owner_marker": "/state/owner"}),
                (recovery, "_verify_network_after_removal", "absent"),
                (recovery, "_build_attestation", {}),
                (recovery, "_runtime_authorization", {}),
                (recovery, "_prepared_context", {}),
                (dev, "_select_source", (source, {})),
                (dev, "_compose_identity", identity),
                (dev, "_resolve_gpu_access", "cpu"),
                (dev, "_verify_docker_gpu_access", "cpu"),
                (volume, "_operator_probe_record_from_retained", {}),
                (ledger, "is_group_ledger_backend", True),
                (build, "build_volume_toolchain", toolchain),
                (build, "build_volume_runtime_images",
                 {"backend": {"image_id": "sha256:" + "6" * 64},
                  "dev": {"image_id": helper_image if helper_image is not None
                          else "sha256:" + "7" * 64}}),
            ]
            for module, name, value in values:
                stack.enter_context(patch.object(module, name, return_value=value))
            for name in ["_validate_pre_admission_stop_journal",
                         "_validate_process_receipt_owner", "_validate_owner_host",
                         "_assert_container_absent"]:
                stack.enter_context(patch.object(recovery, name))
            stack.enter_context(patch.object(recovery, "_control_bytes", side_effect=read))
            stack.enter_context(patch.object(recovery, "docker_capture", side_effect=remove))
            stack.enter_context(patch.object(recovery, "bounded_capture",
                                            side_effect=AssertionError("Unexpected Docker helper")))
            stack.enter_context(patch.object(volume, "start", side_effect=start))
            stack.enter_context(patch("fullmag_docker_runtime.assert_loopback_port_available"))
            recovery.recover(SimpleNamespace(
                recovery_authorization=reference, source_root=source, repo_root=source,
                port=3197, script="must-not-replay.py",
            ))
        return control

    def test_recovery_inherits_group_storage_before_teardown(self):
        control = self.run_recovery()
        self.assertEqual(control.teardown_receipt.get("private_group_storage"),
                         "group-volume-v1")
        self.assertEqual(control.start_receipt.get("private_group_storage"),
                         "group-volume-v1")
        self.assertEqual(control.removed, ["2" * 64, "3" * 64])
        self.assertIsNone(control.start_script)

    def test_recovery_keeps_legacy_storage_layout(self):
        control = self.run_recovery(previous_layout=None, group_owner=False)
        self.assertNotIn("private_group_storage", control.teardown_receipt)
        self.assertNotIn("private_group_storage", control.start_receipt)
        self.assertIsNone(control.start_script)

    def test_recovery_refuses_unpinned_group_storage_before_teardown(self):
        from docker_build_control import BuildControlError
        with self.assertRaisesRegex(BuildControlError, "cannot fall back"):
            self.run_recovery(previous_layout=None)
        self.assertEqual(self.recovery_control.removed, [])
        self.assertIsNone(self.recovery_control.start_receipt)

    def test_recovery_refuses_unknown_storage_layout_before_teardown(self):
        from docker_build_control import BuildControlError
        with self.assertRaisesRegex(BuildControlError, "Unknown previous"):
            self.run_recovery(previous_layout="unknown-v9")
        self.assertEqual(self.recovery_control.removed, [])
        self.assertIsNone(self.recovery_control.start_receipt)

    def test_recovery_refuses_changed_authorization_before_teardown(self):
        with self.assertRaisesRegex(recovery.ContainerRecoveryError,
                                    "authorization changed before"):
            self.run_recovery(changed_authorization=True)
        self.assertEqual(self.recovery_control.removed, [])
        self.assertIsNone(self.recovery_control.start_receipt)

    def test_recovery_absence_continuation_does_not_remove_containers_again(self):
        control = self.run_recovery(absent=True)
        self.assertEqual(control.removed, [])
        self.assertEqual(control.start_receipt.get("private_group_storage"),
                         "group-volume-v1")
        self.assertIsNone(control.start_script)


    def test_fresh_generation_selects_python_image_before_lease(self):
        control = self.run_recovery(fresh_generation=True)
        self.assertEqual(control.lease_image, "sha256:" + "7" * 64)
        self.assertEqual(control.start_receipt["private_group_storage"], "group-volume-v1")

    def test_no_fresh_generation_keeps_configured_helper_image(self):
        control = self.run_recovery()
        self.assertEqual(control.lease_image, "image@sha256:" + "5" * 64)

    def test_invalid_fresh_archive_refuses_before_lease(self):
        from docker_build_control import BuildControlError
        with self.assertRaisesRegex(BuildControlError, "exact completed runtime archive"):
            self.run_recovery(fresh_generation=True, invalid_archive=True)
        self.assertIsNone(self.recovery_control.operation_record)
        self.assertEqual(self.recovery_control.removed, [])
        self.assertIsNone(self.recovery_control.start_receipt)

    def test_mutable_fresh_helper_image_refuses_before_lease(self):
        with self.assertRaisesRegex(recovery.ContainerRecoveryError, "helper image"):
            self.run_recovery(fresh_generation=True, helper_image="fullmag-dev:latest")
        self.assertIsNone(self.recovery_control.operation_record)
        self.assertEqual(self.recovery_control.removed, [])
        self.assertIsNone(self.recovery_control.start_receipt)

    def test_fresh_absence_continuation_keeps_layout_without_remove_or_script(self):
        control = self.run_recovery(fresh_generation=True, absent=True)
        self.assertEqual(control.lease_image, "sha256:" + "7" * 64)
        self.assertEqual(control.start_receipt["private_group_storage"], "group-volume-v1")
        self.assertEqual(control.removed, [])
        self.assertIsNone(control.start_script)

    def test_fresh_generation_still_refuses_changed_authorization(self):
        with self.assertRaisesRegex(recovery.ContainerRecoveryError,
                                    "authorization changed before"):
            self.run_recovery(fresh_generation=True, changed_authorization=True)
        self.assertEqual(self.recovery_control.lease_image, "sha256:" + "7" * 64)
        self.assertEqual(self.recovery_control.removed, [])
        self.assertIsNone(self.recovery_control.start_receipt)


if __name__ == "__main__":
    unittest.main()
