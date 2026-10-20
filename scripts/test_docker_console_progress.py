"""Interpreted regressions for detached diagnostic stdout handling."""
from __future__ import annotations

import errno
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import docker_build_control as build_control
import docker_volume_dev as volume_dev


class _BrokenStream:
    def write(self, _payload):
        raise BrokenPipeError(errno.EPIPE, "stdout is detached")

    def flush(self):
        raise AssertionError("flush must not be reached after a failed write")


class _BrokenBinaryStream(_BrokenStream):
    @property
    def buffer(self):
        return self


class _ErrnoStream:
    def __init__(self, error_number):
        self.error_number = error_number

    def write(self, _payload):
        raise OSError(self.error_number, "stdout is detached")

    def flush(self):
        raise AssertionError("flush must not be reached after a failed write")


class _LoggerStdin:
    closed = True


class _Logger:
    stdin = _LoggerStdin()

    def wait(self, timeout):
        self.wait_timeout = timeout
        return 0


class _ComposeProcess:
    class _Stdin:
        def write(self, _payload):
            return None

        def close(self):
            return None

    class _Stdout:
        def __init__(self):
            self.chunks = iter((b"compose output\n", b""))

        def read1(self, _size):
            return next(self.chunks)

    def __init__(self):
        self.stdin = self._Stdin()
        self.stdout = self._Stdout()

    def wait(self):
        return 0


class _FailingLoggerStdin:
    closed = True

    def write(self, _payload):
        raise OSError(errno.EIO, "control-volume logger failed")

    def flush(self):
        raise AssertionError("logger flush must not be reached after write failure")


class ConsoleProgressTests(unittest.TestCase):
    def test_detached_console_errors_are_ignored(self):
        with patch.object(build_control.sys, "stdout", _BrokenBinaryStream()):
            self.assertFalse(build_control.mirror_console(b"progress\n"))
            sink = build_control.sys.stdout
        sink.close()
        for error_number in (errno.EINVAL, errno.EBADF):
            with self.subTest(error_number=error_number), patch.object(
                build_control.sys, "stdout", _ErrnoStream(error_number)
            ):
                self.assertFalse(build_control.mirror_console("progress\n"))
                sink = build_control.sys.stdout
            sink.close()

    def test_unrelated_console_errors_propagate(self):
        with patch.object(build_control.sys, "stdout", _ErrnoStream(errno.EIO)):
            with self.assertRaisesRegex(OSError, "stdout is detached"):
                build_control.mirror_console("progress\n")

    def test_real_child_quarantines_binary_console_before_atexit(self):
        module_root = str(Path(__file__).resolve().parent)
        child = """
import errno
import sys
sys.path.insert(0, {module_root!r})
import docker_build_control

class DetachedBinary:
    @property
    def buffer(self):
        return self

    def write(self, _payload):
        raise OSError({error_number}, "detached stdout")

    def flush(self):
        raise OSError({error_number}, "detached stdout")

stream = DetachedBinary()
sys.stdout = stream
sys.__stdout__ = stream
assert docker_build_control.mirror_console(b"progress\\n") is False
"""
        for error_number in (errno.EINVAL, errno.EBADF):
            with self.subTest(error_number=error_number):
                result = subprocess.run(
                    [sys.executable, "-B", "-c", child.format(
                        module_root=module_root, error_number=error_number
                    )],
                    env={**os.environ, "PYTHONPATH": module_root},
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stderr, "")

    def test_operation_terminal_receipts_survive_detached_console(self):
        control = build_control.BuildControl.__new__(build_control.BuildControl)
        control.project = "fullmag-test"
        control.volume = "fullmag-build-control-test"
        control.helper_args = lambda *args, **kwargs: ["fake-control-helper"]
        control.space = lambda: {"available_bytes": 64 * 1024**3}
        control._line = Mock(side_effect=("READY", "LOGGED"))
        written = []
        control.write = lambda path, value: written.append((path, value))
        logger = _Logger()
        with patch.object(build_control.subprocess, "Popen", return_value=logger), patch.object(
            build_control.sys, "stdout", _BrokenStream()
        ):
            with control.operation("development", {"source_root": "/checkout"}) as operation:
                operation["receipt"]["state"] = "succeeded"
            sink = build_control.sys.stdout
        sink.close()

        paths = [path for path, _value in written]
        self.assertTrue(any(path.endswith("/terminal.json") for path in paths))
        self.assertTrue(any(path == "development/current.json" for path in paths))
        self.assertTrue(any(path == "development/verified.json" for path in paths))

    def test_publication_progress_loss_does_not_hide_backend_failure_receipt(self):
        observations = iter(
            (
                json.dumps([{"State": {"Running": True, "StartedAt": "first"}}]),
                json.dumps([{"State": {"Running": False, "StartedAt": "first"}}]),
            )
        )
        control = Mock()
        operation = {"receipt": {}, "root": "development/attempts/test"}

        def docker_text(*args, **kwargs):
            if args == ("inspect", "backend"):
                return next(observations)
            if args[:2] == ("logs", "--since"):
                return "phase=start state=building"
            if args[:2] == ("logs", "--tail"):
                return "backend failure"
            raise AssertionError(args)

        with patch.object(volume_dev, "docker_text", side_effect=docker_text), patch.object(
            volume_dev.time, "monotonic", side_effect=(0.0, 1.0, 46.0, 46.0, 50.0)
        ), patch.object(volume_dev.time, "sleep"), patch.object(
            build_control.sys, "stdout", _BrokenStream()
        ):
            with self.assertRaisesRegex(build_control.BuildControlError, "Backend exited"):
                volume_dev._wait_for_publication(control, operation, "backend", timeout=60)
            sink = build_control.sys.stdout
        sink.close()

        control.write.assert_called_once_with(
            "development/attempts/test/backend-failure-log.json", {"log": "backend failure"}
        )

    def test_control_volume_logger_errors_remain_fatal(self):
        control = build_control.BuildControl.__new__(build_control.BuildControl)
        control.project = "fullmag-test"
        operation = {"logger": SimpleNamespace(stdin=_FailingLoggerStdin()), "receipt": {}}
        process = _ComposeProcess()
        with patch.object(build_control.subprocess, "Popen", return_value=process):
            with self.assertRaisesRegex(OSError, "control-volume logger failed"):
                control.build(operation, {}, "backend")
        self.assertTrue(operation["daemon_pending"])


if __name__ == "__main__":
    unittest.main()
