"""Regression checks for the bounded native recovery writer-busy retry."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest
from unittest import mock


RUNTIME_PATH = Path(__file__).resolve().parents[1] / "docker" / "all-in-one" / "runtime_service.py"
SPEC = importlib.util.spec_from_file_location("runtime_service_busy_retry_target", RUNTIME_PATH)
assert SPEC is not None and SPEC.loader is not None
runtime_service = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runtime_service
SPEC.loader.exec_module(runtime_service)


class _Clock:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


class RuntimeServiceRecoveryBusyRetryTests(unittest.TestCase):
    def test_retries_same_cli_arguments_until_native_writer_is_free(self) -> None:
        clock = _Clock()
        paths = object()
        arguments = ("runtime", "service-recover-container", "--request-sha256", "a" * 64)
        result = {"schema": "runtime_service_container_recovery.v1"}
        busy = runtime_service.RuntimeServiceError(
            runtime_service.CONTAINER_RECOVERY_WRITER_BUSY_MESSAGE
        )
        run_cli = mock.Mock(side_effect=[busy, result])
        with mock.patch.object(runtime_service, "_run_cli", run_cli), mock.patch.object(
            runtime_service.time, "monotonic", side_effect=clock.monotonic
        ), mock.patch.object(runtime_service.time, "sleep", side_effect=clock.sleep):
            actual = runtime_service._run_container_recovery_cli(
                paths, arguments, timeout=90.0, cli=None
            )

        self.assertIs(actual, result)
        self.assertEqual(
            run_cli.call_args_list,
            [
                mock.call(paths, arguments, timeout=90.0, cli=None),
                mock.call(paths, arguments, timeout=90.0, cli=None),
            ],
        )
        self.assertEqual(clock.sleeps, [0.1])

    def test_actual_version_preamble_and_native_cause_are_retried(self) -> None:
        clock = _Clock()
        busy = runtime_service.RuntimeServiceError(
            "runtime CLI failed: [fullmag] version: 0.1.0-dev | clean\n"
            "Error: " + runtime_service.CONTAINER_RECOVERY_WRITER_BUSY_NATIVE_MESSAGE
            + "\n\nCaused by:\n    session store writer is busy\n"
        )
        run_cli = mock.Mock(side_effect=[busy, {"recovered": True}])
        with mock.patch.object(runtime_service, "_run_cli", run_cli), mock.patch.object(
            runtime_service.time, "monotonic", side_effect=clock.monotonic
        ), mock.patch.object(runtime_service.time, "sleep", side_effect=clock.sleep):
            result = runtime_service._run_container_recovery_cli(
                object(), ("runtime", "service-recover-container"), timeout=90.0, cli=None
            )
        self.assertEqual(result, {"recovered": True})
        self.assertEqual(run_cli.call_count, 2)

    def test_noncanonical_error_is_not_retried(self) -> None:
        clock = _Clock()
        error = runtime_service.RuntimeServiceError(
            "session store writer is busy root=/host-ledger/ledger conflict=other"
        )
        run_cli = mock.Mock(side_effect=error)
        with mock.patch.object(runtime_service, "_run_cli", run_cli), mock.patch.object(
            runtime_service.time, "monotonic", side_effect=clock.monotonic
        ), mock.patch.object(runtime_service.time, "sleep", side_effect=clock.sleep):
            with self.assertRaises(runtime_service.RuntimeServiceError) as caught:
                runtime_service._run_container_recovery_cli(
                    object(), ("runtime", "service-recover-container"), timeout=90.0, cli=None
                )

        self.assertIs(caught.exception, error)
        self.assertEqual(run_cli.call_count, 1)
        self.assertEqual(clock.sleeps, [])

    def test_persistent_canonical_busy_fails_at_monotonic_deadline(self) -> None:
        clock = _Clock()
        busy = runtime_service.RuntimeServiceError(
            "runtime CLI failed: Error: "
            + runtime_service.CONTAINER_RECOVERY_WRITER_BUSY_NATIVE_MESSAGE
        )
        run_cli = mock.Mock(side_effect=busy)
        with mock.patch.object(runtime_service, "_run_cli", run_cli), mock.patch.object(
            runtime_service.time, "monotonic", side_effect=clock.monotonic
        ), mock.patch.object(runtime_service.time, "sleep", side_effect=clock.sleep):
            with self.assertRaises(runtime_service.RuntimeServiceError) as caught:
                runtime_service._run_container_recovery_cli(
                    object(), ("runtime", "service-recover-container"), timeout=90.0, cli=None
                )

        self.assertIs(caught.exception, busy)
        self.assertEqual(clock.now, runtime_service.CONTAINER_RECOVERY_WRITER_BUSY_RETRY_SECONDS)
        self.assertAlmostEqual(sum(clock.sleeps), runtime_service.CONTAINER_RECOVERY_WRITER_BUSY_RETRY_SECONDS, places=12)
        self.assertGreater(run_cli.call_count, 1)


if __name__ == "__main__":
    unittest.main()
