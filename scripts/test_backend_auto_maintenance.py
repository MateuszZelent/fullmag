import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("backend_auto_maintenance", ROOT / "docker/all-in-one/backend_auto_maintenance.py")
maintenance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(maintenance)
SUCCESS = {"schema": "fullmag.package-maintenance.v1", "state": "succeeded", "retained": ["current", "direct-rollback"]}


class AutomaticMaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.receipts = []
        self.env = mock.patch.dict(os.environ, {
            "FULLMAG_AUTO_CACHE_MAINTENANCE": "1", "FULLMAG_DOCKER_ROLE": "backend",
            "FULLMAG_BACKEND_CACHE_UNIT_KEY": "a" * 64,
        })
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def make(self):
        return maintenance.Maintenance(Path(self.tmp.name) / "process-tree.json",
            lambda path, value, name: self.receipts.append(json.loads(json.dumps(value))),
            {"state": "ready", "api_pid": 42})

    def child(self, handle, code):
        handle.process = subprocess.Popen([sys.executable, "-B", "-c", code],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        os.set_blocking(handle.process.stdout.fileno(), False)
        self.addCleanup(lambda: handle.stop() if not handle.done else None)

    def await_done(self, handle):
        until = time.monotonic() + 5
        while not handle.done and time.monotonic() < until:
            handle.poll()
            time.sleep(.01)
        self.assertTrue(handle.done)

    def test_only_ready_managed_backend_can_start(self):
        with self.assertRaisesRegex(RuntimeError, "ready API"):
            maintenance.Maintenance(Path(self.tmp.name), mock.Mock(), {"state": "starting"})
        with mock.patch.dict(os.environ, {"FULLMAG_DOCKER_ROLE": "frontend"}), mock.patch.object(maintenance.subprocess, "Popen") as spawn:
            self.assertIsNone(maintenance.start(Path(self.tmp.name), mock.Mock(), {}))
            spawn.assert_not_called()

    def test_success_receipt_is_bound_to_this_start(self):
        handle = self.make()
        self.child(handle, "import json; print(json.dumps(" + repr(SUCCESS) + "))")
        self.await_done(handle)
        self.assertEqual(self.receipts[-1]["state"], "succeeded")
        self.assertEqual(self.receipts[-1]["api_pid"], 42)
        self.assertEqual(self.receipts[-1]["result"], SUCCESS)
        self.assertNotEqual(self.make().receipt["attempt"], handle.receipt["attempt"])

    def test_build_lock_contention_is_deferred(self):
        handle = self.make()
        self.child(handle, "raise SystemExit(75)")
        self.await_done(handle)
        self.assertEqual(self.receipts[-1]["state"], "deferred-busy")

    def test_nonzero_or_invalid_receipt_is_never_success(self):
        for code in ("print('broken'); raise SystemExit(2)", "print('{}')"):
            with self.subTest(code=code):
                handle = self.make()
                self.child(handle, code)
                self.await_done(handle)
                self.assertEqual(self.receipts[-1]["state"], "failed")

    def test_large_output_is_drained_and_bounded(self):
        handle = self.make()
        self.child(handle, "import json; print('x' * 2000000); print(json.dumps(" + repr(SUCCESS) + "))")
        self.await_done(handle)
        self.assertLessEqual(len(handle.tail), maintenance.MAX_OUTPUT)
        self.assertEqual(self.receipts[-1]["state"], "succeeded")

    def test_shutdown_reaps_worker_without_waiting_for_maintenance(self):
        handle = self.make()
        self.child(handle, "import time; time.sleep(60)")
        before = time.monotonic()
        handle.stop()
        self.assertLess(time.monotonic() - before, 4)
        self.assertIsNotNone(handle.process.poll())
        self.assertEqual(self.receipts[-1]["state"], "interrupted")

    def test_pipe_failure_cannot_prevent_shutdown(self):
        handle = self.make()
        self.child(handle, "import time; time.sleep(60)")
        with mock.patch.object(handle, "read_output", side_effect=OSError("pipe failed")):
            with self.assertRaises(OSError):
                handle.stop()
        self.assertIsNotNone(handle.process.poll())
        self.assertEqual(self.receipts[-1]["state"], "interrupted")

    def test_receipt_failure_after_spawn_still_reaps_child(self):
        handle = self.make()
        actual = subprocess.Popen([sys.executable, "-B", "-c", "import time; time.sleep(60)"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        writes = 0
        def fail_running(*args):
            nonlocal writes
            writes += 1
            if writes > 1:
                raise OSError("receipt write failed")
        handle.writer = fail_running
        try:
            with mock.patch.object(maintenance.subprocess, "Popen", return_value=actual):
                with self.assertRaises(OSError):
                    handle.start()
            self.assertIsNotNone(actual.poll())
        finally:
            if actual.poll() is None:
                actual.kill()
                actual.wait()
            actual.stdout.close()


if __name__ == "__main__":
    unittest.main()
