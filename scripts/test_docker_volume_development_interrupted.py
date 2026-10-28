"""Failure-only development recovery contract, without Docker or compiled tests."""
import copy
import json
from pathlib import Path
import sys
import types
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_development_interrupted as recovery
from docker_build_control import BuildControlError, canonical
from docker_volume_reconcile import digest, fingerprint

class InterruptedDevelopmentTests(unittest.TestCase):
    def setUp(self):
        self.control = types.SimpleNamespace(project="own", volume="own-control")
        self.source = Path("/own/source")
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

    def test_valid_contract(self):
        recovery.validate_request(self.request)
        recovery.validate_original(self.original, self.document, self.request, self.control, self.source)
        for k, a in self.actual.items():
            recovery.validate_container(a, self.request["containers"][k], k, "own")

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
