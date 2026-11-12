"""Lifecycle tests for the managed Docker root-copy client."""

from contextlib import ExitStack, contextmanager
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from scripts import docker_data_volume_copy_job as job
from scripts import fullmag_storage as storage
from scripts import linux_data_volume_copy as linux_copy


TOKEN = "2" * 32
VOLUME_ID = "1" * 32
REQUEST_SHA256 = "e" * 64
SUCCESS_SHA256 = "a" * 64
FAILURE_SHA256 = "b" * 64
ARGV = [
    "/usr/bin/python3",
    "-B",
    "/opt/fullmag/source/scripts/linux_data_volume_copy.py",
    "/selected/linux-copy-request.json",
    REQUEST_SHA256,
]


def root_copy_request(*, token: str = TOKEN, volume_id: str = VOLUME_ID) -> dict:
    value = {
        "schema": linux_copy.SCHEMA,
        "volume_id": volume_id,
        "storage_root": "/srv/fullmag/storage",
        "token": token,
        "linux_request_sha256": "3" * 64,
        "provision_result_sha256": "4" * 64,
        "drain_sha256": "5" * 64,
        "fence_ready_sha256": "6" * 64,
        "components": {name: "7" * 64 for name in linux_copy.COMPONENTS},
    }
    return linux_copy.validate_request(value)


class FakeProcess:
    def __init__(self, events, polls):
        self.events = events
        self.polls = list(polls)
        self.pid = 42424
        self.returncode = None
        self.waited = False
        self.wait_errors = []
        self.terminated = False
        self.killed = False

    def poll(self):
        if not self.polls:
            if self.returncode is None:
                raise AssertionError("fake live child needs another scripted poll")
            value = self.returncode
        else:
            value = self.polls.pop(0)
        if callable(value):
            value = value()
        if isinstance(value, BaseException):
            self.events.append(("poll-error", type(value).__name__))
            raise value
        self.events.append(("poll", value))
        if value is not None:
            self.returncode = value
        return value

    def wait(self, *args, **kwargs):
        self.events.append(("wait", self.returncode))
        if self.returncode is None:
            raise AssertionError("wait must follow a terminal poll")
        if self.wait_errors:
            raise self.wait_errors.pop(0)
        self.waited = True
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.events.append(("terminate",))

    def kill(self):
        self.killed = True
        self.events.append(("kill",))


class FakeFence:
    def __init__(self, operation, events, *, token=TOKEN, volume_id=VOLUME_ID):
        self.operation = operation
        self.control = SimpleNamespace(_active_operation=operation, write=Mock())
        self.request = {"token": token, "volume_id": volume_id}
        self.events = events
        self.check_count = 0
        self.fail_on_check = None
        self.finish_calls = []

    def check(self):
        self.check_count += 1
        self.events.append(("check", self.check_count))
        if self.fail_on_check == self.check_count:
            raise RuntimeError("simulated fence observation error")

    def finish(self, receipt_sha256):
        self.events.append(("finish", receipt_sha256))
        self.finish_calls.append(receipt_sha256)
        self.operation["daemon_pending"] = False


class Scenario:
    def __init__(self, test_case: unittest.TestCase):
        self._temporary = tempfile.TemporaryDirectory(prefix="fullmag-copy-job-")
        test_case.addCleanup(self._temporary.cleanup)
        self.root = Path(self._temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.request_path = self.root / "linux-copy-request.json"
        request_bytes = b"fixture request bytes\n"
        self.request_path.write_bytes(request_bytes)
        self.request_sha256 = hashlib.sha256(request_bytes).hexdigest()
        self.operation_root = self.root / "operation"
        self.operation_root.mkdir()
        self.request = root_copy_request()
        self.argv = list(ARGV)
        self.argv[-2] = str(self.request_path)
        self.argv[-1] = self.request_sha256
        self.events = []
        self.operation = {
            "root": str(self.operation_root),
            "receipt": {
                "phase": "data-volume-migration",
                "attempt": TOKEN,
                "state": "started",
            },
            "daemon_pending": True,
        }
        self.fence = FakeFence(self.operation, self.events)
        self.distro = "Ubuntu"

    @contextmanager
    def patched_runtime(self, process, terminal_result=None, *, terminal_side_effect=None):
        popen_calls = []
        validation_calls = []

        def spawn(argv, **kwargs):
            self.events.append(("popen", list(argv)))
            popen_calls.append((list(argv), kwargs))
            return process

        def validate(*args, **kwargs):
            self.events.append(("validate", args[3] if len(args) > 3 else kwargs.get("exit_code")))
            validation_calls.append((args, kwargs))
            if terminal_side_effect is not None:
                return terminal_side_effect(*args, **kwargs)
            return terminal_result

        with ExitStack() as stack:
            stack.enter_context(
                patch.object(
                    job,
                    "prepare_command",
                    return_value=(self.argv, self.operation_root, self.request),
                )
            )
            validator = stack.enter_context(
                patch.object(job, "validate_terminal", side_effect=validate)
            )
            popen = Mock(side_effect=spawn)
            stack.enter_context(
                patch.object(
                    job,
                    "subprocess",
                    SimpleNamespace(DEVNULL=subprocess.DEVNULL, Popen=popen),
                )
            )
            stack.enter_context(
                patch.object(job, "print", lambda *_args, **_kwargs: None, create=True)
            )
            stack.enter_context(patch.object(job.time, "sleep", return_value=None))
            yield SimpleNamespace(
                popen=popen,
                validator=validator,
                popen_calls=popen_calls,
                validation_calls=validation_calls,
            )


def success_terminal(receipt_sha256=SUCCESS_SHA256):
    return {
        "state": "copied-and-verified-not-switched",
        "receipt_sha256": receipt_sha256,
        "result": {"schema": "fullmag.data-volume-linux-copy-result.v1"},
    }


def failed_terminal(receipt_sha256=FAILURE_SHA256):
    return {
        "state": "failed-confirmed",
        "receipt_sha256": receipt_sha256,
        "result": {"schema": "fullmag.data-volume-linux-copy-failure.v1"},
    }


class RootCopyLifecycleTests(unittest.TestCase):
    def scenario(self):
        return Scenario(self)

    def call(self, fixture):
        return job.run_root_copy(
            fixture.fence,
            fixture.source,
            fixture.distro,
            fixture.request_path,
            fixture.request_sha256,
            poll_interval=0.001,
        )

    def assert_error_released_only_after_verified_terminal(
        self, fixture, process, runtime, expected_error_type
    ):
        events = fixture.events
        terminal_poll = max(i for i, event in enumerate(events) if event == ("poll", 0))
        terminal_wait = max(i for i, event in enumerate(events) if event[0] == "wait")
        terminal_validation = max(i for i, event in enumerate(events) if event[0] == "validate")
        finish = next(i for i, event in enumerate(events) if event[0] == "finish")
        self.assertEqual(runtime.popen.call_count, 1)
        self.assertTrue(process.waited)
        self.assertLess(terminal_poll, terminal_wait)
        self.assertLess(terminal_wait, terminal_validation)
        self.assertLess(terminal_validation, finish)
        self.assertEqual(fixture.fence.finish_calls, [SUCCESS_SHA256])
        self.assertFalse(fixture.operation["daemon_pending"])
        self.assertEqual(fixture.operation["receipt"]["state"], "failed-confirmed")
        self.assertTrue(fixture.operation["receipt"]["root_copy_terminal_confirmed"])
        self.assertEqual(
            fixture.operation["receipt"]["root_copy_observation_error_type"],
            expected_error_type,
        )
        self.assertIs(fixture.operation["data_copy_root_process"], process)
        self.assertFalse(process.terminated or process.killed)

    def test_success_finishes_only_after_terminal_poll_wait_and_validation(self):
        fixture = self.scenario()
        process = FakeProcess(fixture.events, [None, None, 0])
        with fixture.patched_runtime(process, success_terminal()) as runtime:
            result = self.call(fixture)

        self.assertEqual(result["state"], "copied-and-verified-not-switched")
        self.assertIs(fixture.operation["data_copy_root_process"], process)
        self.assertIs(fixture.fence.control._active_operation, fixture.fence.operation)
        self.assertGreaterEqual(fixture.fence.check_count, 1 + 2)
        self.assertEqual(fixture.fence.finish_calls, [SUCCESS_SHA256])
        self.assertFalse(fixture.operation["daemon_pending"])
        self.assertTrue(process.waited)

        events = fixture.events
        popen_index = next(index for index, event in enumerate(events) if event[0] == "popen")
        terminal_poll_index = max(
            index for index, event in enumerate(events) if event == ("poll", 0)
        )
        wait_index = next(index for index, event in enumerate(events) if event[0] == "wait")
        validate_index = next(index for index, event in enumerate(events) if event[0] == "validate")
        finish_index = next(index for index, event in enumerate(events) if event[0] == "finish")
        self.assertTrue(any(event[0] == "check" for event in events[:popen_index]))
        self.assertLess(terminal_poll_index, wait_index)
        self.assertLess(wait_index, validate_index)
        self.assertLess(validate_index, finish_index)

        argv, kwargs = runtime.popen_calls[0]
        self.assertEqual(argv, fixture.argv)
        self.assertIs(kwargs["stdin"], job.subprocess.DEVNULL)
        self.assertTrue(kwargs["start_new_session"])
        self.assertIsNotNone(kwargs["stdout"])
        self.assertIsNotNone(kwargs["stderr"])
        self.assertIsNot(kwargs["stdout"], kwargs["stderr"])
        for name in ("linux-copy-client.stdout", "linux-copy-client.stderr"):
            self.assertTrue((fixture.operation_root / name).is_file())
        for name in ("linux-copy-client-intent.json", "linux-copy-client-started.json"):
            document = json.loads((fixture.operation_root / name).read_text(encoding="utf-8"))
            self.assertEqual(document["token"], TOKEN)
        started = json.loads(
            (fixture.operation_root / "linux-copy-client-started.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(started["client_pid"], process.pid)

    def test_confirmed_failure_releases_then_raises_without_restart(self):
        fixture = self.scenario()
        process = FakeProcess(fixture.events, [17])
        with fixture.patched_runtime(process, failed_terminal()) as runtime:
            with self.assertRaises((RuntimeError, ValueError)):
                self.call(fixture)

        self.assertTrue(process.waited)
        self.assertEqual(fixture.fence.finish_calls, [FAILURE_SHA256])
        self.assertFalse(fixture.operation["daemon_pending"])
        self.assertEqual(len(runtime.popen_calls), 1)
        self.assertFalse(process.terminated or process.killed)
        self.assertLess(
            next(i for i, event in enumerate(fixture.events) if event[0] == "validate"),
            next(i for i, event in enumerate(fixture.events) if event[0] == "finish"),
        )

    def test_bad_or_missing_terminal_retries_until_verified_terminal(self):
        rejections = {
            "missing receipt": "terminal result omitted its receipt",
            "bad receipt": "terminal receipt did not authenticate",
            "unknown terminal": "terminal state was unknown",
        }
        for invalid_terminal, message in rejections.items():
            with self.subTest(terminal=invalid_terminal):
                fixture = self.scenario()
                process = FakeProcess(fixture.events, [0])
                validator_calls = 0

                def reject_terminal(*_args, **_kwargs):
                    nonlocal validator_calls
                    validator_calls += 1
                    if validator_calls == 1:
                        raise ValueError(message)
                    return success_terminal()

                with fixture.patched_runtime(
                    process,
                    terminal_side_effect=reject_terminal,
                ) as runtime:
                    with self.assertRaisesRegex(ValueError, message):
                        self.call(fixture)
                self.assertEqual(runtime.validator.call_count, 2)
                self.assert_error_released_only_after_verified_terminal(
                    fixture, process, runtime, "ValueError"
                )

    def test_early_result_file_while_child_is_live_does_not_release_fence(self):
        fixture = self.scenario()
        early_result = fixture.operation_root / "linux-copy-result.json"
        early_result.write_text(json.dumps(success_terminal()), encoding="utf-8")

        first_observation_error = OSError("first poll observation fault")
        process = FakeProcess(
            fixture.events,
            [None, first_observation_error, RuntimeError("later poll observation fault"), None, 0],
        )
        with fixture.patched_runtime(process, success_terminal()) as runtime:
            with self.assertRaisesRegex(OSError, "first poll observation fault"):
                self.call(fixture)

        self.assertEqual(runtime.validator.call_count, 1)
        self.assertTrue(early_result.exists())
        events = fixture.events
        poll_errors = [event for event in events if event[0] == "poll-error"]
        self.assertEqual(poll_errors, [("poll-error", "OSError"), ("poll-error", "RuntimeError")])
        error_index = events.index(poll_errors[0])
        terminal_poll = max(i for i, event in enumerate(events) if event == ("poll", 0))
        self.assertLess(error_index, terminal_poll)
        self.assert_error_released_only_after_verified_terminal(
            fixture, process, runtime, "OSError"
        )

    def test_wait_observation_error_does_not_validate_or_release(self):
        fixture = self.scenario()
        process = FakeProcess(fixture.events, [0])
        process.wait_errors.append(OSError("simulated wait observation failure"))
        with fixture.patched_runtime(process, success_terminal()) as runtime:
            with self.assertRaisesRegex(OSError, "simulated wait observation failure"):
                self.call(fixture)

        self.assertEqual(runtime.validator.call_count, 1)
        self.assert_error_released_only_after_verified_terminal(
            fixture, process, runtime, "OSError"
        )

    def test_fence_observation_error_waits_for_verified_terminal_before_release(self):
        fixture = self.scenario()
        # Check 1 is before command preparation, check 2 is immediately
        # before spawn, and check 3 is the first live-child poll fence.
        fixture.fence.fail_on_check = 3
        process = FakeProcess(fixture.events, [None, None, 0])
        with fixture.patched_runtime(process, success_terminal()) as runtime:
            with self.assertRaisesRegex(RuntimeError, "simulated fence observation error"):
                self.call(fixture)

        self.assertEqual(runtime.validator.call_count, 1)
        self.assert_error_released_only_after_verified_terminal(
            fixture, process, runtime, "RuntimeError"
        )

    def test_keyboard_interrupt_waits_for_verified_terminal_before_release(self):
        fixture = self.scenario()
        process = FakeProcess(fixture.events, [KeyboardInterrupt(), None, 0])
        with fixture.patched_runtime(process, success_terminal()) as runtime:
            with self.assertRaises(KeyboardInterrupt):
                self.call(fixture)

        self.assertEqual(runtime.validator.call_count, 1)
        self.assert_error_released_only_after_verified_terminal(
            fixture, process, runtime, "KeyboardInterrupt"
        )

    def test_final_fence_error_after_root_terminal_preserves_native_guard(self):
        fixture = self.scenario()
        fixture.fence.fail_on_check = 3
        process = FakeProcess(fixture.events, [0])
        with fixture.patched_runtime(process, success_terminal()) as runtime:
            with self.assertRaisesRegex(RuntimeError, "simulated fence observation error"):
                self.call(fixture)

        self.assertEqual(runtime.popen.call_count, 1)
        self.assertEqual(runtime.validator.call_count, 1)
        self.assertTrue(process.waited)
        self.assertEqual(fixture.fence.finish_calls, [])
        self.assertTrue(fixture.operation["daemon_pending"])
        self.assertIs(fixture.operation["data_copy_root_process"], process)
        self.assertFalse(process.terminated or process.killed)
        terminal_poll = max(i for i, event in enumerate(fixture.events) if event == ("poll", 0))
        validation = next(i for i, event in enumerate(fixture.events) if event[0] == "validate")
        self.assertLess(terminal_poll, validation)

    def test_real_storage_flock_stays_held_through_observation_fault(self):
        fixture = self.scenario()
        lock_path = fixture.root / "host-copy.lock"
        fault_seen = threading.Event()
        allow_terminal = threading.Event()
        outcome = {}

        def return_terminal_after_probe():
            fault_seen.set()
            if not allow_terminal.wait(timeout=5):
                raise TimeoutError("test did not permit the fake root process to terminate")
            return 0

        process = FakeProcess(
            fixture.events,
            [None, OSError("simulated poll fault"), return_terminal_after_probe],
        )

        def supervise():
            try:
                with storage.file_lock(lock_path, "fixture root copy", blocking=True):
                    with fixture.patched_runtime(process, success_terminal()):
                        outcome["result"] = self.call(fixture)
            except BaseException as error:
                outcome["error"] = error

        supervisor = threading.Thread(target=supervise, name="fake-root-copy-supervisor")
        supervisor.start()
        try:
            self.assertTrue(fault_seen.wait(timeout=5), "supervisor did not recover from the poll fault")
            contender = self.try_external_lock(lock_path, wait_seconds=0.35)
            self.assertEqual(contender.returncode, 23, contender.stderr)
            self.assertIn("busy", contender.stdout)
            self.assertTrue(fixture.operation["daemon_pending"])
            self.assertEqual(fixture.fence.finish_calls, [])
            self.assertIs(fixture.operation["data_copy_root_process"], process)
            self.assertFalse(process.terminated or process.killed)
        finally:
            allow_terminal.set()
            supervisor.join(timeout=5)

        self.assertFalse(supervisor.is_alive(), "supervisor did not release its test lock")
        self.assertIsInstance(outcome.get("error"), OSError)
        self.assertEqual(fixture.fence.finish_calls, [SUCCESS_SHA256])
        self.assertFalse(fixture.operation["daemon_pending"])
        self.assertEqual(fixture.operation["receipt"]["state"], "failed-confirmed")
        self.assertEqual(len([event for event in fixture.events if event[0] == "popen"]), 1)
        after_terminal = self.try_external_lock(lock_path, wait_seconds=0.5)
        self.assertEqual(after_terminal.returncode, 0, after_terminal.stderr)
        self.assertIn("acquired", after_terminal.stdout)

    def try_external_lock(self, lock_path, *, wait_seconds):
        script = """
import sys
from pathlib import Path
import fullmag_storage as storage
try:
    with storage.file_lock(Path(sys.argv[1]), 'copy-job flock probe',
                           wait_timeout_seconds=float(sys.argv[2])):
        print('acquired', flush=True)
except storage.StorageError:
    print('busy', flush=True)
    raise SystemExit(23)
"""
        environment = os.environ.copy()
        existing = environment.get("PYTHONPATH", "")
        required = os.pathsep.join((str(Path(__file__).resolve().parents[1]),
                                    str(Path(__file__).resolve().parents[1] / "scripts")))
        environment["PYTHONPATH"] = required + (os.pathsep + existing if existing else "")
        return subprocess.run(
            [sys.executable, "-B", "-c", script, str(lock_path), str(wait_seconds)],
            cwd=Path(__file__).resolve().parents[1],
            env=environment,
            capture_output=True,
            text=True,
            timeout=5,
        )

    def test_wrong_operation_or_token_refuses_before_spawn(self):
        mutations = (
            "operation-identity",
            "receipt-phase",
            "receipt-attempt",
            "fence-token",
            "fence-volume",
            "request-token",
            "request-volume",
        )
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                fixture = self.scenario()
                if mutation == "operation-identity":
                    fixture.fence.operation = {
                        "receipt": dict(fixture.operation["receipt"]),
                        "daemon_pending": True,
                    }
                elif mutation == "receipt-phase":
                    fixture.operation["receipt"]["phase"] = "another-phase"
                elif mutation == "receipt-attempt":
                    fixture.operation["receipt"]["attempt"] = "3" * 32
                elif mutation == "fence-token":
                    fixture.fence.request["token"] = "3" * 32
                elif mutation == "fence-volume":
                    fixture.fence.request["volume_id"] = "4" * 32
                elif mutation == "request-token":
                    fixture.request = root_copy_request(token="3" * 32)
                else:
                    fixture.request = root_copy_request(volume_id="4" * 32)
                process = FakeProcess(fixture.events, [0])
                with fixture.patched_runtime(process, success_terminal()) as runtime:
                    with self.assertRaises((RuntimeError, ValueError)):
                        self.call(fixture)
                self.assertEqual(runtime.popen.call_count, 0)
                self.assertEqual(runtime.validator.call_count, 0)
                self.assertEqual(fixture.fence.finish_calls, [])
                self.assertTrue(fixture.operation["daemon_pending"])

    def test_existing_client_logs_are_never_overwritten_or_replayed(self):
        names = (
            "linux-copy-client-intent.json",
            "linux-copy-client-started.json",
            "linux-copy-client.stdout",
            "linux-copy-client.stderr",
        )
        for name in names:
            with self.subTest(name=name):
                fixture = self.scenario()
                existing = fixture.operation_root / name
                sentinel = b"retained prior attempt\n"
                existing.write_bytes(sentinel)
                process = FakeProcess(fixture.events, [0])
                with fixture.patched_runtime(process, success_terminal()) as runtime:
                    with self.assertRaises((OSError, RuntimeError, ValueError)):
                        self.call(fixture)
                self.assertEqual(runtime.popen.call_count, 0)
                self.assertEqual(existing.read_bytes(), sentinel)
                self.assertEqual(fixture.fence.finish_calls, [])
                self.assertTrue(fixture.operation["daemon_pending"])


if __name__ == "__main__":
    unittest.main()
