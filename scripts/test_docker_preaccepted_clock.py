"""A failed-preparation wall-clock step must not replace lifecycle evidence."""
from copy import deepcopy
import hashlib
import subprocess
import unittest
from unittest.mock import patch

import docker_volume_dev as dev


class PreacceptedClockTests(unittest.TestCase):
    def setUp(self):
        with patch.object(dev, "docker_capture", return_value=subprocess.CompletedProcess([], 0, b"null\n", b"")) as capture:
            dev._terminal_session_restart_probe("e" * 64)
        script = capture.call_args.args[-1]
        self.code = script[script.index("def require_empty_queue"):script.index("def held_run_proofs")]
        self.identity = ("session", "epoch", "scope")
        self.status = {"session": dict(zip(("session_id", "session_epoch", "request_scope_epoch"), self.identity)),
            "run": None, "solver": {"state": "startup_failed"},
            "lifecycle": {"solver": "startup_failed", "session_resource": "active", "commandability": "forbidden"},
            "resources": {"simulation_preparation_revision": 4}}
        self.status["session"]["script"] = {"path": "/source/case.py"}
        self.preparation = {"status": "failed", "active_stage_id": None,
            "started_at_unix_ms": 1000, "completed_at_unix_ms": 1100,
            "failure": {"error_code": "bad_request", "summary": "rejected before acceptance", "stage_id": "materialization"},
            "stages": [{"id": "materialization", "status": "failed"}]}
        self.queue = {"schema_version": "compute_queue.v1", "next_cursor": None, "items": []}
        self.commands = {"commands": [], "can_accept_commands": False,
            **{key + "_count": 0 for key in ("pending", "accepted", "dispatched", "running", "completed", "rejected", "failed")}}
        self.runtime = {"configured": True, "state": "ready"}
        self.activation = {"key": "activation", "raw": b"original-rejected-receipt",
            "marker": {"authorization": {"container_script_path": "/source/case.py"}},
            "request_id": "request", "source_sha256": "b" * 64, "source_relative": "case.py",
            "rejection": {"http_status": 400, "code": "bad_request", "message": "rejected before acceptance"}}

    def probe(self, *, mutate_second=None):
        calls = {}
        values = {"/v2/sessions/current/simulation/preparation": self.preparation,
            "/v2/platform/compute/queue": self.queue,
            "/v2/sessions/current/simulation/commands": self.commands,
            "/v2/platform/runtime-service": self.runtime,
            "/v2/sessions/current/status": self.status,
            "/v2/sessions/current/simulation/runs/current": None}
        def get(path, **kwargs):
            calls[path] = calls.get(path, 0) + 1
            value = deepcopy(values[path])
            if mutate_second is not None and path.endswith("/preparation") and calls[path] == 2:
                mutate_second(value)
            return value
        env = {"hashlib": hashlib, "instance": "api-instance", "get": get,
            "last_current_run_not_found": {"status": 404, "code": "not_found", "message": "no active run"},
            "rejected_startup_marker": lambda *_: deepcopy(self.activation),
            "read_startup_marker": lambda _: (self.activation["raw"], deepcopy(self.activation["marker"]))}
        exec(compile(self.code, "<real-preacceptance-probe>", "exec"), env)
        return env["startup_failed_preacceptance"](deepcopy(self.status), None, self.identity)

    def test_clock_step_preserves_raw_times_and_admits_only_graceful_drain(self):
        self.preparation["completed_at_unix_ms"] = 900
        result = self.probe()
        self.assertEqual(result["preparation"], self.preparation)
        self.assertEqual(result["preparation_wall_clock_order"], "reversed")
        self.assertEqual(result["startup_activation"]["receipt_sha256"], hashlib.sha256(self.activation["raw"]).hexdigest())

    def test_ordered_times_are_reported_and_invalid_types_are_rejected(self):
        self.assertEqual(self.probe()["preparation_wall_clock_order"], "ordered")
        for value in (None, True, "900", -1):
            with self.subTest(value=value):
                self.preparation["completed_at_unix_ms"] = value
                with self.assertRaises(RuntimeError):
                    self.probe()

    def test_reversed_clock_never_admits_active_or_changed_resources(self):
        self.preparation["completed_at_unix_ms"] = 900
        with self.assertRaisesRegex(RuntimeError, "changed"):
            self.probe(mutate_second=lambda p: p.update(completed_at_unix_ms=901))
        self.queue["items"] = [{"run_id": "active"}]
        with self.assertRaisesRegex(RuntimeError, "queue"):
            self.probe()
        self.queue["items"] = []
        self.commands["accepted_count"] = 1
        with self.assertRaisesRegex(RuntimeError, "command ledger"):
            self.probe()
        self.commands["accepted_count"] = 0
        self.runtime["state"] = "running"
        with self.assertRaisesRegex(RuntimeError, "ready native runtime"):
            self.probe()


if __name__ == "__main__":
    unittest.main()
