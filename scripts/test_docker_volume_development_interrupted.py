"""Failure-only development recovery contract, without Docker or compiled tests."""
import copy
from contextlib import contextmanager, ExitStack
import io
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

    def starting_services_fixture(self):
        request = copy.deepcopy(self.request)
        original = copy.deepcopy(self.original)
        actual = copy.deepcopy(self.actual)
        original["state"] = "starting-services"
        started_at = {
            "backend": "2026-11-16T11:28:41.805481932Z",
            "frontend": "2026-11-16T11:28:42.396691227Z",
        }
        for service, row in actual.items():
            row["State"]["StartedAt"] = started_at[service]
            original[service + "_container"] = row["Id"]
            original[service + "_started_at"] = row["State"]["StartedAt"]
            request["containers"][service] = {
                "id": row["Id"], "image": row["Image"], "fingerprint": fingerprint(row),
                "state_sha256": digest(canonical(row["State"])),
            }
        return request, original, self.document, actual

    @contextmanager
    def interrupted_builder_mocks(self, *, observe_error=None):
        request, original, document, actual = self.starting_services_fixture()
        with tempfile.TemporaryDirectory() as source_dir:
            source = Path(source_dir)
            scripts = source / "scripts"
            scripts.mkdir()
            for name in recovery.CONTROLLERS:
                (scripts / name).write_text("# " + name + "\n")
            request["source_root"] = str(source)
            original["inputs"]["source_root"] = str(source)
            original["state_root"] = str(self.state_root)
            control = types.SimpleNamespace(project="own", volume="own-control", namespace="")
            root = "development/attempts/" + request["attempt"]
            receipt_raw = canonical(original)
            compose_raw = canonical(document)
            active_raw = (request["attempt"] + "\n").encode()
            attempt_documents = {name: canonical({"name": name}) for name in (
                "backend-cache.json", "group-ledger.json", "frontend-seed.json", "cache-maintenance-compose.json")}
            documents = {
                root + "/receipt.json": receipt_raw,
                root + "/compose.json": compose_raw,
                "active": active_raw,
                **{root + "/" + name: raw for name, raw in attempt_documents.items()},
            }
            cert_raw = b"pinned storage certificate\n"
            cert_path = self.state_root / "test-storage-certificate.json"
            cert_path.write_bytes(cert_raw)
            host = types.SimpleNamespace(read_owned_regular=mock.Mock(return_value=cert_raw))
            docker_module = types.SimpleNamespace(
                _certificate_path=mock.Mock(return_value=cert_path),
                _retained_certificate=mock.Mock(return_value={"state": "retained"}),
                _session_host=mock.Mock(return_value=host),
            )
            logs_raw = b"backend build stopped before handoff\n"

            def fake_read_raw(_control, path, optional=False):
                if path in documents:
                    return documents[path]
                if optional:
                    return None
                raise AssertionError("unexpected control-volume read: " + path)

            def fake_docker_capture(*args):
                if args[0] == "info":
                    output = b"pinned-engine\n"
                elif args[0] == "ps":
                    output = ("\n".join(row["Id"] for row in actual.values()) + "\n").encode()
                elif args[0] == "inspect":
                    output = json.dumps(list(actual.values())).encode()
                elif args[0] == "logs":
                    output = logs_raw
                else:
                    raise AssertionError("unexpected Docker observation: " + repr(args))
                return types.SimpleNamespace(stdout=output, stderr=b"", returncode=0)

            with ExitStack() as stack:
                stack.enter_context(mock.patch.dict(sys.modules, {"docker_volume_dev": docker_module}))
                stack.enter_context(mock.patch.object(recovery, "read_raw", side_effect=fake_read_raw))
                stack.enter_context(mock.patch.object(recovery, "docker_capture", side_effect=fake_docker_capture))
                stack.enter_context(mock.patch.object(recovery, "_probe_helper_absence", return_value="d" * 64))
                stack.enter_context(mock.patch.object(recovery.subprocess, "run",
                    return_value=types.SimpleNamespace(stdout=("c" * 40 + "\n").encode())))
                stack.enter_context(mock.patch.object(recovery.time, "time", return_value=1795000000.5))
                observe = stack.enter_context(mock.patch.object(
                    recovery, "observe", side_effect=observe_error if observe_error else None))
                write = stack.enter_context(mock.patch.object(recovery, "write_immutable"))
                reconcile = stack.enter_context(mock.patch.object(recovery, "reconcile"))
                yield {
                    "control": control, "source": source, "observe": observe, "write": write,
                    "reconcile": reconcile, "actual": actual, "original": original,
                    "certificate_sha256": digest(cert_raw), "logs_sha256": digest(logs_raw),
                }

    def test_valid_contract(self):
        recovery.validate_request(self.request)
        recovery.validate_original(self.original, self.document, self.request, self.control, self.source)
        for k, a in self.actual.items():
            recovery.validate_container(a, self.request["containers"][k], k, "own")

    def test_legacy_starting_checkpoint_keeps_its_original_guard(self):
        original = copy.deepcopy(self.original)
        original["backend_container"] = self.request["containers"]["backend"]["id"]
        original["frontend_container"] = self.request["containers"]["frontend"]["id"]
        recovery.validate_original(original, self.document, self.request, self.control, self.source)

    def test_starting_services_checkpoint_is_accepted_and_pins_both_instances(self):
        request, original, document, actual = self.starting_services_fixture()
        recovery.validate_request(request)
        recovery.validate_original(original, document, request, self.control, self.source)
        for service, row in actual.items():
            recovery.validate_container(row, request["containers"][service], service, "own")
            recovery.validate_service_started_at(row, service, original)

    def test_starting_services_checkpoint_rejects_instance_and_start_time_drift(self):
        request, original, document, actual = self.starting_services_fixture()
        for key in ("backend_container", "frontend_container"):
            changed = copy.deepcopy(original)
            changed[key] = "9" * 64
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                recovery.validate_original(changed, document, request, self.control, self.source)

        changed_times = {
            "backend": "2026-11-16T11:28:41.805481933Z",
            "frontend": "2026-11-16T11:28:42.396691228Z",
        }
        for service, started_at in changed_times.items():
            changed = copy.deepcopy(actual[service])
            changed["State"]["StartedAt"] = started_at
            changed_pin = copy.deepcopy(request["containers"][service])
            changed_pin["state_sha256"] = digest(canonical(changed["State"]))
            recovery.validate_container(changed, changed_pin, service, "own")
            with self.subTest(service=service), self.assertRaises(BuildControlError):
                recovery.validate_service_started_at(changed, service, original)

    def test_starting_services_checkpoint_requires_exact_state_and_both_start_times(self):
        request, original, document, _ = self.starting_services_fixture()
        for key, value in (("state", "starting"), ("state", "publishing"),
                           ("config_sha256", "0" * 64), ("frontend_started_at", None)):
            changed = copy.deepcopy(original)
            changed[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(BuildControlError):
                recovery.validate_original(changed, document, request, self.control, self.source)

    def test_interrupted_request_builder_pins_observations_before_immutable_publication(self):
        with self.interrupted_builder_mocks() as fixture:
            result = recovery.build_interrupted_request(
                fixture["control"], fixture["source"], self.request["attempt"])
            self.assertEqual(result["state"], "request-pinned")
            fixture["observe"].assert_called_once()
            fixture["write"].assert_called_once()
            fixture["reconcile"].assert_not_called()
            _, request_path, payload = fixture["write"].call_args.args
            request = json.loads(payload)
            recovery.validate_request(request)
            self.assertEqual(request["schema"], recovery.SCHEMA)
            self.assertEqual(request["storage_certificate_sha256"], fixture["certificate_sha256"])
            self.assertEqual(request["backend_log_sha256"], fixture["logs_sha256"])
            self.assertTrue(request_path.startswith("verification/development-interrupted/"))
            self.assertTrue(request_path.endswith("/request.json"))
            for service, row in fixture["actual"].items():
                self.assertEqual(request["containers"][service]["id"], row["Id"])
                self.assertEqual(request["containers"][service]["state_sha256"],
                                 digest(canonical(row["State"])))

    def test_interrupted_request_builder_does_not_publish_when_observation_fails(self):
        with self.interrupted_builder_mocks(observe_error=BuildControlError("guard rejected")) as fixture:
            with self.assertRaisesRegex(BuildControlError, "guard rejected"):
                recovery.build_interrupted_request(
                    fixture["control"], fixture["source"], self.request["attempt"])
            fixture["write"].assert_not_called()
            fixture["reconcile"].assert_not_called()

    def test_initial_interruption_rejects_handoff_and_api_logs(self):
        recovery.validate_no_handoff_or_api(b"build stopped before package handoff\n")
        for marker in (b"phase=start state=handoff", b"phase=api state=exec"):
            with self.subTest(marker=marker), self.assertRaises(BuildControlError):
                recovery.validate_no_handoff_or_api(b"backend-dev: " + marker + b"\n")

    def test_cli_rejects_mixed_request_builder_and_reconciliation_modes(self):
        argv = ["docker_volume_development_interrupted.py", "--source-root", str(self.source),
                "--build-interrupted-request", "--attempt", self.request["attempt"],
                "--request", "verification/request.json", "--request-sha256", "a" * 64]
        error = io.StringIO()
        with mock.patch.object(sys, "argv", argv), mock.patch("sys.stderr", error), self.assertRaises(SystemExit):
            recovery.main()
        self.assertIn("not allowed with argument", error.getvalue())
        self.assertNotIn("unrecognized arguments", error.getvalue())

        for extra in (("--apply",), ("--request-sha256", "a" * 64), ("--base-attempt", "a" * 32)):
            argv = ["docker_volume_development_interrupted.py", "--source-root", str(self.source),
                    "--build-interrupted-request", "--attempt", self.request["attempt"], *extra]
            with self.subTest(extra=extra), mock.patch.object(sys, "argv", argv), \
                    self.assertRaises(BuildControlError):
                recovery.main()

        argv = ["docker_volume_development_interrupted.py", "--source-root", str(self.source),
                "--build-interrupted-request", "--build-publication-request", "--attempt", self.request["attempt"],
                "--base-attempt", "a" * 32]
        error = io.StringIO()
        with mock.patch.object(sys, "argv", argv), mock.patch("sys.stderr", error), self.assertRaises(SystemExit):
            recovery.main()
        self.assertIn("not allowed with argument", error.getvalue())
        self.assertNotIn("unrecognized arguments", error.getvalue())

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
