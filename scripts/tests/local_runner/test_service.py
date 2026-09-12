"""Behavioral tests for the host-local runner service loop."""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path


SCRIPT_ROOT = Path(__file__).resolve().parents[2]
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

from local_runner.service import (  # noqa: E402
    RunnerService,
    ServiceBusy,
    ServicePaths,
    request_stop,
)
from fullmag_storage import file_lock  # noqa: E402


class RunnerServiceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.paths = ServicePaths.from_storage(self.root)

    def service(self, **kwargs):
        return RunnerService(paths=self.paths, interval_seconds=0.001, **kwargs)

    def test_executes_one_callback_per_iteration_and_stops_gracefully(self):
        executed = []
        sleeps = []
        stop = threading.Event()

        def execute():
            executed.append(len(executed) + 1)
            if len(executed) == 2:
                stop.set()
            return {"job_id": "job-a", "state": "succeeded", "lease_token": "secret"}

        def sleep(interval):
            sleeps.append(interval)

        result = self.service(execute=execute, active=lambda: [], reconcile=lambda jobs: None,
                              sleep=sleep).run(stop_event=stop)

        self.assertEqual([1, 2], executed)
        self.assertEqual("stopped", result["state"])
        self.assertGreaterEqual(len(sleeps), 1)
        status = json.loads(self.paths.state_path.read_text(encoding="utf-8"))
        self.assertEqual(result["instance_id"], status["instance_id"])
        self.assertEqual("succeeded", status["last_result"]["state"])
        self.assertNotIn("lease_token", status["last_result"])
        self.assertTrue(status["started_at"])
        self.assertTrue(status["heartbeat_at"])

    def test_stop_request_is_durable_and_waits_for_current_callback(self):
        executed = []

        def execute():
            executed.append("job")
            request_stop(self.paths, reason="operator requested a graceful stop")
            return {"job_id": "job-a", "state": "succeeded"}

        result = self.service(execute=execute, active=lambda: [], reconcile=lambda jobs: None,
                              sleep=lambda _: self.fail("stop request should avoid another sleep")).run()

        self.assertEqual(["job"], executed)
        self.assertEqual("stopped", result["state"])
        self.assertTrue(result["stop_requested"])
        request = json.loads(self.paths.stop_request_path.read_text(encoding="utf-8"))
        self.assertTrue(request["requested"])
        self.assertEqual("operator requested a graceful stop", request["reason"])

    def test_restart_with_active_lease_reconciles_and_never_duplicates(self):
        active = [{"job_id": "job-a", "state": "running", "lease_token": "secret"}]
        reconciled = []
        executed = []
        stop = threading.Event()

        def reconcile(jobs):
            reconciled.append([job["job_id"] for job in jobs])
            active.clear()
            stop.set()

        result = self.service(execute=lambda: executed.append("unexpected"), active=lambda: list(active),
                              reconcile=reconcile, sleep=lambda _: self.fail("cleared lease should stop")).run(
                                  stop_event=stop)

        self.assertEqual([["job-a"]], reconciled)
        self.assertEqual([], executed)
        self.assertEqual("stopped", result["state"])

    def test_active_lease_that_survives_reconcile_is_not_replaced(self):
        active = [{"job_id": "job-a", "state": "running"}]
        calls = []
        stop = threading.Event()

        def sleep(_):
            calls.append("sleep")
            if len(calls) == 2:
                active.clear()
                stop.set()

        def reconcile(jobs):
            calls.append("reconcile")
            if len(calls) > 3:
                stop.set()

        result = self.service(execute=lambda: calls.append("execute"), active=lambda: list(active),
                              reconcile=reconcile, sleep=sleep).run(stop_event=stop)

        self.assertNotIn("execute", calls)
        self.assertGreaterEqual(calls.count("reconcile"), 1)
        self.assertEqual("stopped", result["state"])

    def test_callback_error_is_recorded_and_interval_is_observed(self):
        calls = []
        stop = threading.Event()

        def execute():
            calls.append("execute")
            stop.set()
            raise RuntimeError("worker unavailable")

        def sleep(interval):
            calls.append(("sleep", interval))

        result = self.service(execute=execute, active=lambda: [], reconcile=lambda jobs: None,
                              sleep=sleep).run(stop_event=stop)

        self.assertEqual(["execute"], calls)
        self.assertEqual("stopped", result["state"])
        self.assertIn("worker unavailable", result["last_error"])
        self.assertEqual(1, result["error_count"])

    def test_second_service_cannot_acquire_process_lock(self):
        self.paths.lock_path.parent.mkdir(parents=True, exist_ok=True)
        with file_lock(self.paths.lock_path, "test lock"):
            service = self.service(execute=lambda: None, active=lambda: [], reconcile=lambda jobs: None)
            with self.assertRaises(ServiceBusy):
                service.run(stop_event=threading.Event())

    def test_stop_request_can_be_cleared_without_deleting_control_file(self):
        request_stop(self.paths, reason="temporary operator stop")
        self.assertTrue(self.paths.stop_request_path.exists())
        RunnerService.clear_stop_request(self.paths, reason="operator resumed service")
        request = json.loads(self.paths.stop_request_path.read_text(encoding="utf-8"))
        self.assertFalse(request["requested"])
        self.assertEqual("operator resumed service", request["reason"])

    def test_heartbeat_advances_while_execute_callback_is_running(self):
        started = threading.Event()
        release = threading.Event()
        finished = threading.Event()
        result = []

        def execute():
            started.set()
            self.assertTrue(release.wait(2))
            return {"job_id": "job-a", "state": "succeeded"}

        service = self.service(
            execute=execute,
            active=lambda: [],
            reconcile=lambda jobs: None,
            heartbeat_interval_seconds=0.01,
        )

        def run():
            result.append(service.run(max_iterations=1))
            finished.set()

        thread = threading.Thread(target=run)
        thread.start()
        self.assertTrue(started.wait(2))
        first = json.loads(self.paths.state_path.read_text(encoding="utf-8"))["heartbeat_at"]
        time.sleep(0.05)
        second = json.loads(self.paths.state_path.read_text(encoding="utf-8"))["heartbeat_at"]
        self.assertNotEqual(first, second)
        release.set()
        self.assertTrue(finished.wait(2))
        thread.join(timeout=2)
        self.assertEqual("stopped", result[0]["state"])


if __name__ == "__main__":
    unittest.main()
