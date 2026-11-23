import copy
import unittest

from docker_build_control import BuildControlError
from docker_volume_idle_restart_interrupted import SCHEMA, validate_restart
from docker_volume_reconcile import commit_script


class InterruptedIdleRestartTests(unittest.TestCase):
    def setUp(self):
        self.token = "1" * 32
        backend = "a" * 64
        frontend = "b" * 64
        self.scope = dict(token=self.token, project="project", volume="control", source="/source")
        self.previous = dict(
            state="succeeded", attempt="2" * 32, compose_project="project", control_volume="control",
            config_sha256="c" * 64, state_root="/state", ledger_profile="group-ledger-v1",
            backend_container=backend, frontend_container=frontend,
            backend_started_at="2026-11-23T18:01:00Z", frontend_started_at="2026-11-23T18:01:01Z",
        )
        self.receipt = {
            **self.previous,
            "schema": "fullmag.docker-build-operation.v1", "phase": "iteration",
            "state": "restarting-idle-backend", "attempt": self.token,
            "helper_container": "fullmag-control-" + self.token,
            "inputs": {"attempt": self.previous["attempt"], "source_root": "/source", "config_sha256": "c" * 64},
            "backend_started_at": "2026-11-23T18:02:00Z", "frontend_started_at": "2026-11-23T18:02:01Z",
        }
        self.drain = {
            "schema": "fullmag.docker-idle-restart-drain.v1", "backend_container_id": backend,
            "process_receipt_sha256": "d" * 64,
            "process_receipt": {
                "schema": "fullmag.docker-process-tree.v1", "state": "drained", "api_exit_code": -15,
                "terminal_service_owner": {"state": "drained"},
            },
        }

    def test_requires_original_graceful_drain_and_two_new_service_incarnations(self):
        validate_restart(self.receipt, self.previous, self.drain, **self.scope)
        for key, value in {
            "frontend_started_at": self.previous["frontend_started_at"],
            "backend_container": "f" * 64,
            "saved_authoring_restore_required": True,
            "api_quiescence_intent_sha256": "e" * 64,
        }.items():
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                validate_restart({**self.receipt, key: value}, self.previous, self.drain, **self.scope)
        drain = copy.deepcopy(self.drain)
        drain["process_receipt"]["terminal_service_owner"]["state"] = "ready"
        with self.assertRaises(BuildControlError):
            validate_restart(self.receipt, self.previous, drain, **self.scope)

    def test_interruption_may_publish_failure_but_cannot_replace_verified_success(self):
        class Control:
            def path(self, name):
                return "/control/" + name

        request = {"schema": SCHEMA, "attempt": self.token, "unknown_receipt_sha256": "a" * 64}
        root = "iteration/attempts/" + self.token
        args = (Control(), root, request, root + "/reconciliation/result", "b" * 64, "a" * 64)
        script = commit_script(*args, publish_verified=False)
        self.assertIn("/terminal.json", script)
        self.assertNotIn("/verified.json", script)
        with self.assertRaises(BuildControlError):
            commit_script(*args, publish_verified=True)
