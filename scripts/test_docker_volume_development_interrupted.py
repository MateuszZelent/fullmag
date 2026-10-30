"""Failure-only development recovery contract, without Docker or compiled tests."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_development_interrupted as recovery
from docker_build_control import BuildControlError, canonical
from docker_volume_reconcile import digest, fingerprint

class InterruptedDevelopmentTests(unittest.TestCase):
    def setUp(self):
        self.control = types.SimpleNamespace(project="own", volume="own-control")
        self.source = Path("/own/source")
        self._state_temp = tempfile.TemporaryDirectory()
        self.state_root = Path(self._state_temp.name)
        self.actual = {}
        for index, service in enumerate(("backend", "frontend")):
            self.actual[service] = {"Id": str(index + 1) * 64, "Image": "sha256:" + "a" * 64,
                "Config": {"Labels": {"com.docker.compose.project": "own", "com.docker.compose.service": service}},
                "HostConfig": {}, "Mounts": [], "State": {"Status": "exited", "Pid": 0, "ExitCode": 255,
                "Running": False, "Paused": False, "Restarting": False, "Dead": False, "OOMKilled": False,
                "Error": "", "StartedAt": "2026-10-23T20:33:35Z", "FinishedAt": "2026-10-23T21:00:24Z"}}
        pins = {name: {"id": a["Id"], "image": a["Image"], "fingerprint": fingerprint(a),
            "state_sha256": digest(canonical(a["State"]))} for name, a in self.actual.items()}
        self.request = {"schema": recovery.SCHEMA, "attempt": "b" * 32, "source_root": str(self.source),
            "source_revision": "c" * 40, "compose_project": "own", "engine_id": "pinned-engine", "observed_at": 1792789000,
            **{key: "d" * 64 for key in ("receipt_sha256", "compose_sha256", "active_sha256", "helper_absence_sha256",
                "backend_log_sha256", "controller_sha256", "storage_certificate_sha256")},
            "current_sha256": None, "verified_sha256": None, "containers": pins,
            "controller_inputs": {k: "e" * 64 for k in recovery.CONTROLLERS},
            "attempt_documents": {k: "f" * 64 for k in ("backend-cache.json", "group-ledger.json", "frontend-seed.json", "cache-maintenance-compose.json")}}
        self.original = {"schema": "fullmag.docker-build-operation.v1", "phase": "development", "state": "starting",
            "attempt": self.request["attempt"], "compose_project": "own", "control_volume": "own-control",
            "helper_container": "fullmag-control-" + self.request["attempt"],
            "inputs": {"source_root": str(self.source), "image_id": self.actual["backend"]["Image"]}}
        self.document = {"name": "own", "services": {k: {"image": a["Image"], "environment": {}} for k, a in self.actual.items()}}

    def tearDown(self):
        self._state_temp.cleanup()

    def gate_fixture(self):
        request = copy.deepcopy(self.request)
        request["schema"] = recovery.GATE_FAILURE_SCHEMA
        request["gate_failure"] = {
            "backend_started_at": "2026-10-28T17:47:25Z",
            "backend_exit_code": 2,
            "frontend_exit_code": 255,
            "build_source_commit": "4" * 40,
            "package_receipt_sha256": "1" * 64,
            "provenance_sha256": "2" * 64,
            "owner_marker_sha256": "d" * 64,
            "sentinel_sha256": "5" * 64,
            "storage_identity": {"root_inode": 4257304, "retained_device": 2096, "observed_device": 2096},
        }
        self.actual["backend"]["State"]["ExitCode"] = 2
        self.actual["backend"]["State"]["StartedAt"] = request["gate_failure"]["backend_started_at"]
        self.actual["frontend"]["State"]["ExitCode"] = 255
        for service, actual in self.actual.items():
            request["containers"][service] = {
                "id": actual["Id"], "image": actual["Image"],
                "fingerprint": fingerprint(actual), "state_sha256": digest(canonical(actual["State"])),
            }
        original = copy.deepcopy(self.original)
        original["backend_started_at"] = request["gate_failure"]["backend_started_at"]
        original["state_root"] = str(self.state_root)
        original["backend_volumes"] = {
            "build": "own-build", "package": "fullmag-shared-packages-v1-4881-global", "control": "own-control"}
        original["frontend_volume"] = "own-frontend"
        document = copy.deepcopy(self.document)
        document["services"]["backend"]["environment"]["FULLMAG_SESSION_STORAGE_PROFILE"] = "linux-native-v1"
        document["volumes"] = {
            "backend-build": {"name": "own-build"},
            "backend-package": {"name": "fullmag-shared-packages-v1-4881-global"},
            "backend-control": {"name": "own-control"}, "frontend-state": {"name": "own-frontend"},
        }
        document["services"]["backend"]["volumes"] = [
            {"type": "bind", "source": str(self.state_root), "target": "/state"},
            {"type": "volume", "source": "backend-build", "target": "/build"},
            {"type": "volume", "source": "backend-package", "target": "/opt/fullmag/package"},
            {"type": "volume", "source": "backend-control", "target": "/opt/fullmag/control"},
            {"type": "volume", "source": "backend-control", "target": "/opt/fullmag/runtime-control"},
            {"type": "volume", "source": "backend-control",
             "target": "/state/runs/docker-all/session-store/runtime-services"},
        ]
        document["services"]["frontend"]["volumes"] = [
            {"type": "volume", "source": "frontend-state", "target": "/state/development"},
            {"type": "volume", "source": "backend-control", "target": "/opt/fullmag/control", "read_only": True},
        ]
        self.actual["backend"]["Mounts"] = [
            {"Type": "bind", "Source": str(self.state_root), "Destination": "/state", "RW": True},
            {"Type": "volume", "Name": "own-build", "Destination": "/build", "RW": True},
            {"Type": "volume", "Name": "fullmag-shared-packages-v1-4881-global",
             "Destination": "/opt/fullmag/package", "RW": True},
            {"Type": "volume", "Name": "own-control", "Destination": "/opt/fullmag/control", "RW": True},
            {"Type": "volume", "Name": "own-control", "Destination": "/opt/fullmag/runtime-control", "RW": True},
            {"Type": "volume", "Name": "own-control",
             "Destination": "/state/runs/docker-all/session-store/runtime-services", "RW": True},
        ]
        self.actual["frontend"]["Mounts"] = [
            {"Type": "volume", "Name": "own-frontend", "Destination": "/state/development", "RW": True},
            {"Type": "volume", "Name": "own-control", "Destination": "/opt/fullmag/control", "RW": False},
        ]
        for service, actual in self.actual.items():
            request["containers"][service] = {
                "id": actual["Id"], "image": actual["Image"],
                "fingerprint": fingerprint(actual), "state_sha256": digest(canonical(actual["State"])),
            }
        return request, original, document

    def test_valid_contract(self):
        recovery.validate_request(self.request)
        recovery.validate_original(self.original, self.document, self.request, self.control, self.source)
        for k, a in self.actual.items():
            recovery.validate_container(a, self.request["containers"][k], k, "own")

    def test_only_fail_only_gate_recovery_is_independent_of_foreign_host_clients(self):
        with mock.patch.object(recovery,'host_clients',side_effect=BuildControlError('foreign builder')) as scanner:
            recovery._observe_host_clients(self.source,{'schema':recovery.GATE_FAILURE_SCHEMA},None)
            scanner.assert_not_called()
            for schema in (recovery.SCHEMA,recovery.RESUME_SCHEMA):
                with self.subTest(schema=schema),self.assertRaises(BuildControlError):
                    recovery._observe_host_clients(self.source,{'schema':schema},None)
            self.assertEqual(scanner.call_count,2)

    def test_existing_schema_keeps_its_original_shape_and_exit_contract(self):
        recovery.validate_request(self.request)
        changed = copy.deepcopy(self.request); changed["gate_failure"] = {}
        with self.assertRaises(BuildControlError): recovery.validate_request(changed)
        backend = copy.deepcopy(self.actual["backend"]); backend["State"]["ExitCode"] = 2
        pin = {"id": backend["Id"], "image": backend["Image"], "fingerprint": fingerprint(backend),
               "state_sha256": digest(canonical(backend["State"]))}
        with self.assertRaises(BuildControlError): recovery.validate_container(backend, pin, "backend", "own")

    def test_gate_failure_contract_is_independent_and_exact(self):
        request, original, document = self.gate_fixture()
        recovery.validate_request(request)
        recovery.validate_original(original, document, request, self.control, self.source)
        for service, actual in self.actual.items():
            recovery.validate_container(actual, request["containers"][service], service, "own", gate_failure=True)
            recovery.validate_gate_container_mounts(actual, service, document, self.state_root)

    def test_gate_failure_rejects_wrong_exit_codes_and_request_shape(self):
        request, _, _ = self.gate_fixture()
        for field, value in (("backend_exit_code", 255), ("frontend_exit_code", 2)):
            changed = copy.deepcopy(request); changed["gate_failure"][field] = value
            with self.subTest(field=field), self.assertRaises(BuildControlError): recovery.validate_request(changed)
        changed = copy.deepcopy(request); changed["gate_failure"]["extra"] = True
        with self.assertRaises(BuildControlError): recovery.validate_request(changed)
        changed = copy.deepcopy(request); changed["gate_failure"]["storage_identity"]["root_inode"] = 0
        with self.assertRaises(BuildControlError): recovery.validate_request(changed)
        backend = copy.deepcopy(self.actual["backend"]); backend["State"]["ExitCode"] = 255
        pin = {"id": backend["Id"], "image": backend["Image"], "fingerprint": fingerprint(backend),
               "state_sha256": digest(canonical(backend["State"]))}
        with self.assertRaises(BuildControlError): recovery.validate_container(backend, pin, "backend", "own", gate_failure=True)

    def test_gate_failure_log_requires_exact_order_and_terminal(self):
        good = (b"backend-dev: phase=make state=complete exit_code=0\n"
                b"backend-dev: phase=start state=handoff\n"
                b"backend-dev: phase=package state=verify-complete\n"
                b"backend-dev: phase=gate state=start profile=linux-native-v1\n"
                b"backend-dev: Linux native host admission did not become ready\n")
        recovery.validate_gate_log(good)
        for bad in (
            good.replace(b"phase=make state=complete", b"phase=make state=failed"),
            good.replace(b"phase=package state=verify-complete", b"phase=package state=failed"),
            good.replace(b"profile=linux-native-v1", b"profile=worker-cgroup"),
            good.replace(b"phase=start state=handoff\n", b""),
            good.replace(b"Linux native host admission did not become ready", b"another failure"),
            good + b"backend-dev: phase=api state=exec mode=backend\n",
            good.replace(b"phase=gate state=start", b"phase=gate state=complete"),
        ):
            with self.subTest(log=bad[-80:]), self.assertRaises(BuildControlError): recovery.validate_gate_log(bad)
        with self.assertRaises(BuildControlError): recovery.validate_gate_log(good * 400000)

    def test_gate_package_and_provenance_are_exactly_bound(self):
        request, _, _ = self.gate_fixture()
        receipt = {"schema": "fullmag.direct-compose.backend-build-receipt.v1", "state": "succeeded",
                   "operation": "direct-compose-build",
                   "source": {"resolved_commit": request["gate_failure"]["build_source_commit"]}}
        receipt_raw = canonical(receipt)
        provenance = {"schema": "fullmag.docker-all-image.v1", "state": "succeeded",
                      "image_id": self.actual["backend"]["Image"], "commit": receipt["source"]["resolved_commit"],
                      "package_root": "/opt/fullmag/package",
                      "backend_build_receipt": "/opt/fullmag/package/backend-build-receipt.json",
                      "backend_build_receipt_schema": receipt["schema"], "build_receipt_sha256": digest(receipt_raw)}
        provenance_raw = canonical(provenance)
        request["gate_failure"]["package_receipt_sha256"] = digest(receipt_raw)
        request["gate_failure"]["provenance_sha256"] = digest(provenance_raw)
        self.assertEqual(recovery.validate_gate_package_documents(receipt_raw, provenance_raw, request, self.actual["backend"]["Image"]),
                         {"receipt_sha256": digest(receipt_raw), "provenance_sha256": digest(provenance_raw)})
        for bad_receipt, bad_provenance in (
            (canonical({**receipt, "state": "failed"}), provenance_raw),
            (receipt_raw, canonical({**provenance, "image_id": "sha256:" + "f" * 64})),
            (receipt_raw, canonical({**provenance, "build_receipt_sha256": "0" * 64})),
        ):
            with self.subTest(receipt=bad_receipt, provenance=bad_provenance), self.assertRaises(BuildControlError):
                recovery.validate_gate_package_documents(bad_receipt, bad_provenance, request, self.actual["backend"]["Image"])
        changed = copy.deepcopy(request); changed["gate_failure"]["build_source_commit"] = "9" * 40
        with self.assertRaises(BuildControlError):
            recovery.validate_gate_package_documents(receipt_raw, provenance_raw, changed, self.actual["backend"]["Image"])

    def test_gate_certificate_owner_sentinel_and_storage_identity_are_pinned(self):
        request, _, _ = self.gate_fixture()
        identity = {"host_root": "/own/state", "host_filesystem": "ext4", "host_platform": "linux",
                    "host_device": 2096, "host_root_no_reparse": True}
        token = "6" * 32
        image = self.actual["backend"]["Image"]
        sentinel = (token + ":" + image).encode("ascii")
        certificate = {"schema": "fullmag.linux-native-host.v1", "storage_profile": "linux-native-v1",
                      "role": "session", "owner_scope": "docker-linux", **identity,
                      "host_inode": 4257304, "owner_token": token, "engine_id": "pinned-engine",
                      "image_id": image, "restart_expected_sha256": digest(sentinel), "restart_verified": False}
        raw = canonical(certificate)
        gate = request["gate_failure"]
        gate["owner_marker_sha256"] = digest(raw); gate["sentinel_sha256"] = digest(sentinel)
        request["storage_certificate_sha256"] = digest(raw)
        self.assertEqual(recovery.validate_gate_host_documents(raw, raw, sentinel, request, image,
                                                               "pinned-engine", identity), certificate)
        for bad_certificate, bad_owner, bad_sentinel, bad_identity in (
            (canonical({**certificate, "restart_verified": True}), raw, sentinel, identity),
            (raw, canonical({**certificate, "owner_token": "7" * 32}), sentinel, identity),
            (raw, raw, b"other", identity),
            (raw, raw, sentinel, {**identity, "host_device": 2097}),
        ):
            with self.subTest(certificate=bad_certificate), self.assertRaises(BuildControlError):
                recovery.validate_gate_host_documents(bad_certificate, bad_owner, bad_sentinel,
                                                       request, image, "pinned-engine", bad_identity)

    def test_gate_failure_requires_absent_runtime_records_and_empty_runstore(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            store = state / "runs/docker-all/session-store"
            (store / "runtime-services").mkdir(parents=True)
            records = {path: None for path in recovery.GATE_RUNTIME_ABSENT_PATHS}
            recovery.validate_gate_runtime_absence(state, records)
            for name in (".linux-native-restart", ".linux-native-probe.json"):
                path = state / name; path.write_bytes(b"probe")
                with self.subTest(path=name), self.assertRaises(BuildControlError):
                    recovery.validate_gate_runtime_absence(state, records)
                path.unlink()
            scratch = state / ".linux-native-probe-partial"; scratch.mkdir()
            with self.assertRaises(BuildControlError): recovery.validate_gate_runtime_absence(state, records)
            scratch.rmdir()
            records[recovery.GATE_RUNTIME_ABSENT_PATHS[0]] = b"{}"
            with self.assertRaises(BuildControlError): recovery.validate_gate_runtime_absence(state, records)
            records[recovery.GATE_RUNTIME_ABSENT_PATHS[0]] = None
            (store / "runs").mkdir()
            (store / "runs" / "nativeRunIntent.json").write_text("{}")
            with self.assertRaises(BuildControlError): recovery.validate_gate_runtime_absence(state, records)

    def test_gate_failure_result_reports_confirmed_service_exit_codes_without_native_mutation(self):
        request, _, document = self.gate_fixture()
        result = json.loads(recovery.failure_result(canonical(self.original), document, request, "a" * 64))
        self.assertEqual(result["state"], "failed-confirmed")
        self.assertEqual(result["error"], "Linux native host admission did not become ready")
        self.assertEqual(result["build_data_qualification"], "NOT VERIFIED")
        self.assertEqual(result["reconciliation"]["service_exit_codes"], {"backend": 2, "frontend": 255})
        self.assertFalse(result["reconciliation"]["native_state_changed"])

    def test_gate_failure_result_derives_missing_inventory_from_compose_and_gate_pins(self):
        request, original, document = self.gate_fixture()
        for key in ("state_root", "backend_volumes", "frontend_volume", "backend_started_at"):
            original.pop(key)
        result = json.loads(recovery.failure_result(canonical(original), document, request, "a" * 64))
        self.assertEqual(result["state_root"], str(self.state_root))
        self.assertEqual(result["backend_volumes"], {
            "build": "own-build", "package": "fullmag-shared-packages-v1-4881-global", "control": "own-control"})
        self.assertEqual(result["frontend_volume"], "own-frontend")
        self.assertEqual(result["backend_started_at"], request["gate_failure"]["backend_started_at"])
        self.assertEqual(result["inputs"]["source_root"], str(self.source))
        self.assertEqual(result["attempt"], request["attempt"])

    def test_gate_failure_live_mount_scan_ignores_only_shared_package_volume(self):
        request, original, document = self.gate_fixture()
        for key in ("state_root", "backend_volumes", "frontend_volume", "backend_started_at"):
            original.pop(key)
        retained, state_root = recovery._protected_retained_mounts(original, document, request)
        shared_package = recovery._compose_volume_name(document, "backend", "/opt/fullmag/package")
        self.assertNotIn(shared_package, retained)
        foreign_package_consumer = {"Mounts": [{"Name": shared_package, "RW": True}]}
        self.assertFalse(recovery._live_mount_consumes(foreign_package_consumer, retained, state_root))

        own_control = recovery._compose_volume_name(document, "backend", "/opt/fullmag/control")
        control_consumer = {"Mounts": [{"Name": own_control, "RW": True}]}
        state_consumer = {"Mounts": [{"Source": str(self.state_root), "RW": True}]}
        self.assertTrue(recovery._live_mount_consumes(control_consumer, retained, state_root))
        self.assertTrue(recovery._live_mount_consumes(state_consumer, retained, state_root))
        self.assertEqual(state_root, str(self.state_root))

    def test_gate_mount_accepts_only_the_exact_retained_wsl_alias(self):
        _, _, document = self.gate_fixture()
        alias='/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu2/pinned'
        self.actual['backend']['Mounts'][0]['Source']=alias
        with self.assertRaises(BuildControlError):
            recovery.validate_gate_container_mounts(self.actual['backend'],'backend',document,self.state_root)
        document['services']['backend']['x-fullmag-daemon-binds']={'/state':alias}
        recovery.validate_gate_container_mounts(self.actual['backend'],'backend',document,self.state_root)
        consumer={'Mounts':[{'Source':alias,'RW':True}]}
        self.assertTrue(recovery._live_mount_consumes(consumer,set(),str(self.state_root),state_alias=alias))
        self.actual['backend']['Mounts'][0]['Source']=alias+'-different'
        with self.assertRaises(BuildControlError):
            recovery.validate_gate_container_mounts(self.actual['backend'],'backend',document,self.state_root)

    def test_existing_live_mount_protection_still_includes_package_volume(self):
        original = {"backend_volumes": {"build": "build", "package": "global-package", "control": "control"},
                    "frontend_volume": "frontend", "state_root": "/own/state"}
        retained, state_root = recovery._protected_retained_mounts(
            original, {}, {"schema": recovery.SCHEMA})
        self.assertIn("global-package", retained)
        self.assertTrue(recovery._live_mount_consumes(
            {"Mounts": [{"Name": "global-package", "RW": True}]}, retained, state_root))

    def test_request_missing_extra_and_bad_pins(self):
        for key in self.request:
            r = copy.deepcopy(self.request); r.pop(key)
            with self.subTest(missing=key), self.assertRaises(BuildControlError): recovery.validate_request(r)
        for key in ("receipt_sha256", "compose_sha256", "active_sha256", "backend_log_sha256", "source_revision", "storage_certificate_sha256"):
            r = copy.deepcopy(self.request); r[key] = "invalid"
            with self.subTest(pin=key), self.assertRaises(BuildControlError): recovery.validate_request(r)
        r = copy.deepcopy(self.request); r["extra"] = True
        with self.assertRaises(BuildControlError): recovery.validate_request(r)
        r = copy.deepcopy(self.request); r["containers"]["frontend"] = r["containers"]["backend"]
        with self.assertRaises(BuildControlError): recovery.validate_request(r)

    def test_foreign_or_published_attempt_rejected(self):
        for key, value in (("phase", "toolchain"), ("state", "succeeded"), ("attempt", "0" * 32),
                ("compose_project", "other"), ("control_volume", "other"), ("helper_container", "other"),
                ("config_sha256", "0" * 64), ("backend_started_at", "observed")):
            changed = copy.deepcopy(self.original); changed[key] = value
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                recovery.validate_original(changed, self.document, self.request, self.control, self.source)
        document = copy.deepcopy(self.document); document["services"]["backend"]["environment"]["FULLMAG_STARTUP_ENABLED"] = "1"
        with self.assertRaises(BuildControlError): recovery.validate_original(self.original, document, self.request, self.control, self.source)

    def test_live_or_changed_container_rejected(self):
        for key, value in (("Running", True), ("Paused", True), ("Restarting", True), ("Dead", True), ("OOMKilled", True),
                ("Pid", 42), ("ExitCode", 0), ("Status", "running"), ("Error", "unknown")):
            actual = copy.deepcopy(self.actual["backend"]); actual["State"][key] = value
            pin = copy.deepcopy(self.request["containers"]["backend"]); pin["state_sha256"] = digest(canonical(actual["State"]))
            with self.subTest(key=key), self.assertRaises(BuildControlError): recovery.validate_container(actual, pin, "backend", "own")
        actual = copy.deepcopy(self.actual["backend"]); actual["State"]["StartedAt"] = "changed"
        with self.assertRaises(BuildControlError): recovery.validate_container(actual, self.request["containers"]["backend"], "backend", "own")

    def test_failure_is_deterministic_and_binds_resume_services(self):
        raw = canonical(self.original)
        a = recovery.failure_result(raw, self.document, self.request, "a" * 64)
        self.assertEqual(a, recovery.failure_result(raw, self.document, self.request, "a" * 64))
        result = json.loads(a)
        self.assertNotIn("exit_code", result)
        self.assertIsNone(result["reconciliation"]["producer_exit_code"])
        self.assertEqual(result["state"], "failed-confirmed")
        self.assertEqual(result["build_data_qualification"], "NOT VERIFIED")
        self.assertEqual(result["config_sha256"], digest(canonical(self.document)))
        for k in ("backend", "frontend"):
            self.assertEqual(result[k + "_container"], self.request["containers"][k]["id"])
        self.assertEqual(result["reconciliation"]["containers"], self.request["containers"])

if __name__ == "__main__":
    unittest.main()
