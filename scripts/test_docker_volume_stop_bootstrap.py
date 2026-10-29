"""Source-only identity regressions; no Docker mutation or owner repair."""
from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_stop_bootstrap as stop
import docker_volume_stop_diagnostic as diagnostic
from docker_build_control import BuildControlError


def encoded(value):
    return json.dumps(value, sort_keys=True).encode()


class ContainerIterationPinsTests(unittest.TestCase):
    def setUp(self):
        self.control = SimpleNamespace(project="group", volume="volume", namespace=None)
        self.args = SimpleNamespace(attempt="a" * 32, iteration_attempt="b" * 32,
                                    resume_attempt="c" * 32, config_sha256="d" * 64)
        self.backend, self.frontend = "e" * 64, "f" * 64
        self.image = "sha256:" + "1" * 64
        self.previous = {
            "schema": "fullmag.docker-build-operation.v1", "phase": "development",
            "state": "failed-confirmed", "attempt": self.args.attempt,
            "compose_project": "group", "control_volume": "volume", "state_root": "/state",
            "inputs": {"image_id": self.image, "source_root": "/source"},
        }
        self.iteration = {
            "schema": "fullmag.docker-build-operation.v1", "phase": "iteration",
            "state": "succeeded", "attempt": self.args.iteration_attempt,
            "compose_project": "group", "control_volume": "volume", "state_root": "/state",
            "config_sha256": self.args.config_sha256,
            "inputs": {"attempt": self.args.attempt, "config_sha256": self.args.config_sha256,
                       "source_root": "/source", "image_id": self.image},
            "backend_container": self.backend, "frontend_container": self.frontend,
            "backend_started_at": "old-start",
            "source_commit": "2" * 40, "source_digest": "3" * 64,
            "source_snapshot_sha256": "4" * 64, "backend_build_receipt_sha256": "5" * 64,
            "worker_cgroup": {"schema": "fullmag.worker-cgroup-ready.v1", "state": "ready",
                              "compose_project": "group", "container_id": self.backend,
                              "image_id": self.image, "root": "/opt/fullmag/worker-cgroup"},
        }
        self.relative = f"iteration/attempts/{self.args.iteration_attempt}/terminal.json"
        self.files = {self.relative: encoded(self.iteration), "iteration/current.json": encoded(self.iteration)}
        self.resume = {
            **deepcopy(self.iteration), "phase": "resume", "state": "failed-confirmed",
            "attempt": self.args.resume_attempt, "backend_started_at": "current-start",
            "error": stop.TARGET_BUILD_ERROR_PREFIX + " test\n" + stop.TARGET_BUILD_ERROR_SUFFIX,
        }
        self.files[f"resume/attempts/{self.args.resume_attempt}/terminal.json"] = encoded(self.resume)
        reader = lambda control, relative, **kwargs: self.files[relative]
        self.addCleanup(patch.stopall)
        patch.object(stop, "_read_raw", side_effect=reader).start()
        patch.object(diagnostic, "_read_raw", side_effect=reader).start()

    def pin(self):
        return stop._container_iteration(self.control, self.args, self.previous)

    def validate_resume(self, previous):
        return stop._validate_resume(self.control, attempt=self.args.attempt,
            resume_attempt=self.args.resume_attempt, config_sha256=self.args.config_sha256,
            selected=Path("/source"), previous=previous, previous_inputs=self.previous["inputs"])

    def test_missing_ids_use_explicit_succeeded_iteration_but_resume_pins_current_start(self):
        original = deepcopy(self.previous)
        pin = self.pin()
        effective = {**self.previous, "backend_container": pin["backend_container"],
                     "frontend_container": pin["frontend_container"]}
        resume = self.validate_resume(effective)
        self.assertEqual(resume["backend_started_at"], "current-start")
        self.assertEqual(resume["backend_container"], self.backend)
        self.assertEqual(self.previous, original)
        stop._verify_container_iteration(self.control, pin)

    def test_no_iteration_does_not_infer_missing_ids_from_failed_resume(self):
        self.args.iteration_attempt = None
        self.assertIsNone(self.pin())
        with self.assertRaises(BuildControlError):
            self.validate_resume(self.previous)

    def test_complete_original_identity_keeps_existing_resume_contract(self):
        self.args.iteration_attempt = None
        self.previous.update(backend_container=self.backend, frontend_container=self.frontend)
        self.assertIsNone(self.pin())
        self.assertEqual(self.validate_resume(self.previous)["backend_started_at"], "current-start")

    def test_explicit_or_malformed_original_identity_is_not_replaced(self):
        for value in ("9" * 64, "", False, "e" * 63):
            with self.subTest(value=value):
                self.previous["backend_container"] = value
                with self.assertRaises(BuildControlError): self.pin()
        self.previous.update(backend_container=self.backend, frontend_container=self.frontend)
        with self.assertRaises(BuildControlError): self.pin()

    def test_iteration_binding_mismatches_fail_closed(self):
        cases = [
            ("schema", "unknown"), ("state", "failed-confirmed"), ("phase", "resume"),
            ("attempt", "9" * 32), ("compose_project", "other"), ("control_volume", "other"),
            ("state_root", "/other"), ("config_sha256", "9" * 64),
            ("backend_container", "short"), ("frontend_container", "short"),
            ("backend_started_at", ""), ("source_commit", "bad"),
            ("source_snapshot_sha256", "bad"), ("backend_build_receipt_sha256", "bad"),
            ("control_namespace", "other"), ("worker_cgroup", None),
            ("inputs.attempt", "9" * 32), ("inputs.config_sha256", "9" * 64),
            ("inputs.source_root", "/other"), ("inputs.image_id", "sha256:" + "9" * 64),
            ("worker_cgroup.container_id", "9" * 64), ("worker_cgroup.state", "failed"),
            ("worker_cgroup.image_id", "sha256:" + "9" * 64), ("worker_cgroup.root", "/other"),
        ]
        for path, value in cases:
            with self.subTest(path=path):
                changed = deepcopy(self.iteration)
                target = changed
                keys = path.split(".")
                for key in keys[:-1]: target = target[key]
                target[keys[-1]] = value
                self.files[self.relative] = self.files["iteration/current.json"] = encoded(changed)
                with self.assertRaises(BuildControlError): self.pin()

    def test_resume_conflicting_container_is_not_accepted(self):
        pin = self.pin()
        effective = {**self.previous, "backend_container": pin["backend_container"],
                     "frontend_container": pin["frontend_container"]}
        for key in ("backend_container", "frontend_container"):
            changed = {**self.resume, key: "9" * 64}
            self.files[f"resume/attempts/{self.args.resume_attempt}/terminal.json"] = encoded(changed)
            with self.assertRaises(BuildControlError): self.validate_resume(effective)

    def test_superseded_iteration_is_not_an_identity_authority(self):
        self.files["iteration/current.json"] = encoded({**self.iteration, "attempt": "9" * 32})
        with self.assertRaises(BuildControlError): self.pin()

    def test_post_stop_recheck_rejects_changed_terminal_or_current_pointer(self):
        pin = self.pin()
        for relative in (self.relative, "iteration/current.json"):
            original = self.files[relative]
            self.files[relative] += b" "
            with self.assertRaises(BuildControlError): stop._verify_container_iteration(self.control, pin)
            self.files[relative] = original

    def test_iteration_id_is_not_a_path(self):
        for value in ("../other", "b" * 31, "B" * 32, "b" * 32 + "\n"):
            self.args.iteration_attempt = value
            with self.assertRaises(BuildControlError): self.pin()


if __name__ == "__main__":
    unittest.main()
