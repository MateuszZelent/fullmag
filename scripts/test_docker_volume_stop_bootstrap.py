"""Exact historical failed-start recovery pins; no Docker calls in these tests."""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import json
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_dev as dev
import docker_volume_stop_bootstrap as stop
from docker_build_control import BuildControlError, canonical

BACKEND = "1" * 64
FRONTEND = "2" * 64
IMAGE = "sha256:" + "3" * 64
CONFIG = "4" * 64
DEVELOPMENT = "5" * 32
RESUME = "6" * 32
START = "2026-10-29T11:13:16.581353245Z"


class StopBootstrapPinsTests(unittest.TestCase):
    def setUp(self):
        self.control = SimpleNamespace(project="fullmag-fixture", volume="control-fixture", namespace="")
        cgroup = {"schema": "fullmag.worker-cgroup-ready.v1", "state": "ready",
                  "compose_project": self.control.project, "container_id": BACKEND, "image_id": IMAGE}
        self.previous = {"state": "succeeded", "state_root": "/state",
                         "backend_container": BACKEND, "frontend_container": FRONTEND,
                         "backend_started_at": START, "worker_cgroup": deepcopy(cgroup)}
        self.inputs = {"image_id": IMAGE}
        self.receipt = {
            "schema": "fullmag.docker-build-operation.v1", "phase": "resume", "state": "failed-confirmed",
            "attempt": RESUME, "compose_project": self.control.project, "control_volume": self.control.volume,
            "config_sha256": CONFIG, "state_root": "/state", "backend_started_at": START,
            "backend_container": BACKEND, "frontend_container": FRONTEND, "worker_cgroup": cgroup,
            "inputs": {"attempt": DEVELOPMENT, "config_sha256": CONFIG, "source_root": "/source"},
            "error": stop.TARGET_BUILD_ERROR,
        }

    def validate(self):
        with patch.object(stop, "_read_raw", return_value=canonical(self.receipt)):
            return stop._validate_resume(self.control, attempt=DEVELOPMENT, resume_attempt=RESUME,
                                         config_sha256=CONFIG, selected=Path("/source"),
                                         previous=self.previous, previous_inputs=self.inputs)

    def historical_failed_start(self):
        self.previous["state"] = "failed-confirmed"
        self.previous.pop("backend_container")
        self.previous.pop("frontend_container")

    def test_retains_normal_exact_development_binding(self):
        result = self.validate()
        self.assertEqual(result["backend_container"], BACKEND)
        self.assertIn("development terminal", result["pin_sources"]["backend_container"])

    def test_historical_failed_start_requires_fresh_ids_and_unchanged_cgroup(self):
        self.historical_failed_start()
        before = canonical(self.previous)
        result = self.validate()
        self.assertEqual(result["backend_container"], BACKEND)
        self.assertEqual(result["frontend_container"], FRONTEND)
        self.assertEqual(canonical(self.previous), before)
        self.assertIn("failed resume container ID", result["pin_sources"]["frontend_container"])

    def test_succeeded_terminal_cannot_use_missing_identity_recovery(self):
        self.previous.pop("frontend_container")
        with self.assertRaises(BuildControlError):
            self.validate()

    def test_historical_recovery_rejects_missing_or_malformed_fresh_ids(self):
        self.historical_failed_start()
        for key in ("backend_container", "frontend_container"):
            original = self.receipt.pop(key)
            with self.subTest(key=key, value="missing"), self.assertRaises(BuildControlError):
                self.validate()
            self.receipt[key] = "invalid"
            with self.subTest(key=key, value="malformed"), self.assertRaises(BuildControlError):
                self.validate()
            self.receipt[key] = original

    def test_historical_recovery_rejects_changed_backend_incarnation(self):
        self.historical_failed_start()
        self.receipt["backend_started_at"] = "2026-10-29T12:00:00Z"
        with self.assertRaises(BuildControlError):
            self.validate()

    def test_historical_recovery_rejects_changed_cgroup_or_backend_id(self):
        self.historical_failed_start()
        self.receipt["worker_cgroup"]["container_id"] = "7" * 64
        self.receipt["backend_container"] = "7" * 64
        with self.assertRaises(BuildControlError):
            self.validate()

    def test_present_development_identity_cannot_be_overridden(self):
        self.previous["state"] = "failed-confirmed"
        self.previous.pop("frontend_container")
        self.previous["backend_container"] = "8" * 64
        with self.assertRaises(BuildControlError):
            self.validate()

    def test_historical_recovery_keeps_config_and_source_binding(self):
        self.historical_failed_start()
        for key, value in (("config_sha256", "9" * 64), ("source_root", "/another-source")):
            original = self.receipt["inputs"][key]
            self.receipt["inputs"][key] = value
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                self.validate()
            self.receipt["inputs"][key] = original

    def test_finish_publishes_ids_before_any_readiness_failure(self):
        operation = {"receipt": {"attempt": DEVELOPMENT}}
        with patch.dict(sys.modules, {"fullmag_docker_runtime": SimpleNamespace()}), \
             patch.object(dev, "_operator_probe_record_from_retained", return_value={}), \
             patch.object(dev, "_wait_for_publication", side_effect=BuildControlError("fixture failure")):
            with self.assertRaises(BuildControlError):
                dev._finish(None, operation, {}, BACKEND, FRONTEND, Path("/source"), Path("/state"),
                            None, {}, None, {"image_id": IMAGE}, IMAGE, Path("/git"), {}, 3217)
        self.assertEqual(operation["receipt"]["backend_container"], BACKEND)
        self.assertEqual(operation["receipt"]["frontend_container"], FRONTEND)
        json.dumps(operation["receipt"])


if __name__ == "__main__":
    unittest.main()
