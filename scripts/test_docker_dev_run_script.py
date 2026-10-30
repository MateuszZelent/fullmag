"""Interpreted regressions for managed DEV script execution and observation."""
from __future__ import annotations

from contextlib import ExitStack, redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlparse

import docker_dev_defaults as defaults
import docker_dev_run_script as run_script_module


API_INSTANCE = "12345678-1234-5678-1234-123456789abc"
SESSION_ID = "session-foreground-1"
RUN_ID = "run-foreground-1"
SESSION_EPOCH = "epoch-1"
REQUEST_SCOPE_EPOCH = API_INSTANCE + ":scope-1"
SOURCE_SHA256 = "c" * 64
BACKEND_ID = "d" * 64
FRONTEND_ID = "e" * 64
ATTEMPT = "a" * 32
CONFIG_SHA256 = "b" * 64


def _observation(status: str, **fields: object) -> dict[str, object]:
    return {
        "state": "observed",
        "api_instance_id": API_INSTANCE,
        "session_id": SESSION_ID,
        "run_id": RUN_ID,
        "session_epoch": SESSION_EPOCH,
        "request_scope_epoch": REQUEST_SCOPE_EPOCH,
        "run_status": status,
        **fields,
    }


class DockerDevRunScriptTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp.name)
        self.pins = defaults.ScriptPins(
            ATTEMPT, CONFIG_SHA256, self.repo, 3297,
            backend_container_id=BACKEND_ID,
            frontend_container_id=FRONTEND_ID,
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _activation(self, *, interactive: bool = True, wait_for_solve: bool = False):
        return {
            "state": "activated",
            "request_id": "foreground-request-1",
            "source_sha256": SOURCE_SHA256,
            "response": {
                "request_id": "foreground-request-1",
                "source_sha256": SOURCE_SHA256,
                "session_id": SESSION_ID,
                "run_id": RUN_ID,
                "status": "waiting_for_solve" if wait_for_solve else "accepted",
                "runtime_metadata": {
                    "interactive": interactive,
                    "wait_for_solve": wait_for_solve,
                },
            },
        }

    def _patch_admission(self, stack: ExitStack, *, pins=None):
        stack.enter_context(patch.object(
            defaults,
            "resolve_defaults",
            return_value=defaults.ScriptDefaults(self.repo, self.pins.port),
        ))
        return stack.enter_context(patch.object(
            defaults, "_discover_pins", return_value=pins or self.pins,
        ))

    def _patch_activation(self, stack: ExitStack, *, side_effect=None):
        return stack.enter_context(patch(
            "docker_volume_activate.activate",
            side_effect=side_effect,
            return_value=self._activation(),
        ))

    def test_partial_explicit_pin_pair_is_rejected_before_api_or_activation(self) -> None:
        for kwargs in ({"attempt": ATTEMPT}, {"config_sha256": CONFIG_SHA256}):
            with self.subTest(kwargs=kwargs), ExitStack() as stack:
                self._patch_admission(stack)
                activation = self._patch_activation(stack)
                with patch.object(run_script_module, "_probe_with_retry") as probe:
                    result = run_script_module.run_script(
                        self.repo, "examples/demo.py", **kwargs,
                    )
                self.assertEqual(result["state"], "rejected")
                self.assertEqual(result["status"], "not_started")
                self.assertEqual(result["exit_code"], 2)
                probe.assert_not_called()
                activation.assert_not_called()

    def test_discovered_pin_mismatches_are_rejected_before_api_or_activation(self) -> None:
        for kwargs in (
            {"attempt": "f" * 32, "config_sha256": CONFIG_SHA256},
            {"attempt": ATTEMPT, "config_sha256": "0" * 64},
        ):
            with self.subTest(kwargs=kwargs), ExitStack() as stack:
                self._patch_admission(stack)
                activation = self._patch_activation(stack)
                with patch.object(run_script_module, "_probe_with_retry") as probe:
                    result = run_script_module.run_script(
                        self.repo, "examples/demo.py", **kwargs,
                    )
                self.assertEqual(result["state"], "rejected")
                self.assertEqual(result["status"], "not_started")
                self.assertEqual(result["exit_code"], 2)
                probe.assert_not_called()
                activation.assert_not_called()

    def test_ordinary_interactive_run_waits_and_prints_frontend_url_before_activation(self) -> None:
        observations = iter((_observation("running"), _observation("completed")))
        stderr = io.StringIO()
        activation_namespaces = []

        def activate(namespace):
            activation_namespaces.append(namespace)
            self.assertIn("http://127.0.0.1:3297", stderr.getvalue())
            return self._activation(interactive=True, wait_for_solve=False)

        def observe(_backend, mode, **identity):
            if mode == "pin":
                return {"state": "observed", "api_instance_id": API_INSTANCE}
            self.assertEqual(mode, "run")
            self.assertEqual(identity["api_instance_id"], API_INSTANCE)
            self.assertEqual(identity["session_id"], SESSION_ID)
            self.assertEqual(identity["run_id"], RUN_ID)
            return next(observations)

        with ExitStack() as stack:
            self._patch_admission(stack)
            self._patch_activation(stack, side_effect=activate)
            stack.enter_context(patch.object(
                run_script_module, "_probe_with_retry", side_effect=observe,
            ))
            stack.enter_context(patch.object(run_script_module.time, "sleep"))
            with redirect_stderr(stderr):
                result = run_script_module.run_script(
                    self.repo, "examples/demo.py", attempt=ATTEMPT,
                    config_sha256=CONFIG_SHA256,
                )

        self.assertEqual(len(activation_namespaces), 1)
        self.assertEqual(activation_namespaces[0].attempt, ATTEMPT)
        self.assertEqual(activation_namespaces[0].config_sha256, CONFIG_SHA256)
        self.assertEqual(result["state"], "terminal")
        self.assertEqual(result["outcome"], "completed")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["exit_code"], 0)

    def test_wait_for_solve_remains_attached_until_run_completes(self) -> None:
        observations = iter((
            _observation("waiting_for_solve"),
            _observation("completed"),
        ))
        output: list[str] = []
        run_probe_count = 0

        def activate(_namespace):
            return self._activation(interactive=True, wait_for_solve=True)

        def observe(_backend, mode, **_identity):
            nonlocal run_probe_count
            if mode == "pin":
                return {"state": "observed", "api_instance_id": API_INSTANCE}
            self.assertEqual(mode, "run")
            run_probe_count += 1
            return next(observations)

        with ExitStack() as stack:
            self._patch_admission(stack)
            self._patch_activation(stack, side_effect=activate)
            stack.enter_context(patch.object(
                run_script_module, "_probe_with_retry", side_effect=observe,
            ))
            stack.enter_context(patch.object(run_script_module.time, "sleep"))
            result = run_script_module.run_script(
                self.repo, "examples/demo.py", output=output.append,
            )

        self.assertEqual(run_probe_count, 2)
        self.assertTrue(any("Waiting for Compute" in message for message in output))
        self.assertEqual(result["state"], "terminal")
        self.assertEqual(result["outcome"], "completed")

    def test_observation_deadline_returns_124_without_cancelling_the_run(self) -> None:
        def observe(_backend, mode, **_identity):
            if mode == "pin":
                return {"state": "observed", "api_instance_id": API_INSTANCE}
            return _observation("running")

        with ExitStack() as stack:
            self._patch_admission(stack)
            self._patch_activation(stack)
            stack.enter_context(patch.object(
                run_script_module, "_probe_with_retry", side_effect=observe,
            ))
            cancel_probe = stack.enter_context(patch.object(
                run_script_module, "_container_probe",
            ))
            stack.enter_context(patch.object(
                run_script_module.time, "monotonic", side_effect=[10.0, 10.6],
            ))
            sleep = stack.enter_context(patch.object(run_script_module.time, "sleep"))
            result = run_script_module.run_script(
                self.repo, "examples/demo.py", timeout_seconds=0.5,
            )

        self.assertEqual(result["state"], "unknown")
        self.assertEqual(result["outcome"], "observation_timeout")
        self.assertEqual(result["status"], "running")
        self.assertEqual(result["exit_code"], 124)
        cancel_probe.assert_not_called()
        sleep.assert_not_called()

    def test_observation_deadline_also_limits_log_backlog(self) -> None:
        with ExitStack() as stack:
            self._patch_admission(stack)
            self._patch_activation(stack)
            stack.enter_context(patch.object(
                run_script_module, "_probe_with_retry", side_effect=[
                    {"state": "observed", "api_instance_id": API_INSTANCE},
                    _observation("running", logs_next_offset=50, logs_total=100),
                ],
            ))
            cancel_probe = stack.enter_context(patch.object(run_script_module, "_container_probe"))
            stack.enter_context(patch.object(run_script_module.time, "monotonic", side_effect=[10.0, 10.6, 10.6]))
            result = run_script_module.run_script(
                self.repo, "examples/demo.py", timeout_seconds=0.5, output=lambda message: None,
            )
        self.assertEqual(result["outcome"], "observation_timeout")
        self.assertEqual(result["exit_code"], 124)
        cancel_probe.assert_not_called()

    def test_changed_api_session_or_run_identity_never_cancels_that_run(self) -> None:
        mutations = (
            ("api_instance_id", "fedcba98-7654-3210-fedc-ba9876543210"),
            ("session_id", "another-session"),
            ("run_id", "another-run"),
        )
        for field, value in mutations:
            with self.subTest(field=field), ExitStack() as stack:
                def observe(_backend, mode, **_identity):
                    if mode == "pin":
                        return {"state": "observed", "api_instance_id": API_INSTANCE}
                    observed = _observation("running")
                    observed[field] = value
                    return observed

                self._patch_admission(stack)
                self._patch_activation(stack)
                stack.enter_context(patch.object(
                    run_script_module, "_probe_with_retry", side_effect=observe,
                ))
                cancel_probe = stack.enter_context(patch.object(
                    run_script_module, "_container_probe",
                ))
                result = run_script_module.run_script(
                    self.repo, "examples/demo.py",
                )

                self.assertEqual(result["state"], "unknown")
                self.assertEqual(result["outcome"], "run_identity_changed")
                self.assertEqual(result["exit_code"], 75)
                cancel_probe.assert_not_called()

    def test_interrupt_during_run_progress_output_cancels_and_confirms_exact_run(self) -> None:
        observations = iter((_observation("running"), _observation("cancelled")))
        cancellation = {
            **_observation("running"),
            "cancellation_submitted": True,
        }
        output_messages: list[str] = []
        interrupted = False

        def observe(_backend, mode, **_identity):
            if mode == "pin":
                return {"state": "observed", "api_instance_id": API_INSTANCE}
            self.assertEqual(mode, "run")
            return next(observations)

        def output(message: str) -> None:
            nonlocal interrupted
            output_messages.append(message)
            if message == "Run " + RUN_ID + ": running" and not interrupted:
                interrupted = True
                raise KeyboardInterrupt

        with ExitStack() as stack:
            self._patch_admission(stack)
            self._patch_activation(stack)
            stack.enter_context(patch.object(
                run_script_module, "_probe_with_retry", side_effect=observe,
            ))
            cancel_probe = stack.enter_context(patch.object(
                run_script_module, "_container_probe", return_value=cancellation,
            ))
            stack.enter_context(patch.object(run_script_module.time, "sleep"))
            result = run_script_module.run_script(
                self.repo, "examples/demo.py", output=output,
            )

        cancel_probe.assert_called_once()
        args, kwargs = cancel_probe.call_args
        self.assertEqual(args[:2], (BACKEND_ID, "cancel"))
        self.assertEqual(kwargs["api_instance_id"], API_INSTANCE)
        self.assertEqual(kwargs["session_id"], SESSION_ID)
        self.assertEqual(kwargs["run_id"], RUN_ID)
        self.assertEqual(kwargs["session_epoch"], SESSION_EPOCH)
        self.assertEqual(kwargs["request_scope_epoch"], REQUEST_SCOPE_EPOCH)
        self.assertEqual(result["state"], "terminal")
        self.assertEqual(result["outcome"], "interrupted")
        self.assertEqual(result["status"], "cancelled")
        self.assertEqual(result["exit_code"], 130)

    def test_progress_and_duplicate_engine_logs_are_emitted_during_polling(self) -> None:
        log = {
            "id": "log-17",
            "timestamp_unix_ms": 1_800_000_000_000,
            "level": "info",
            "message": "solver entered relaxation",
        }
        observations = iter((
            _observation("running", progress={
                "solver_steps": 2, "solver_time": 0.25, "stage_label": "Relaxation",
            }, logs=[log]),
            _observation("running", progress={
                "solver_steps": 3, "solver_time": 0.5, "stage_label": "Relaxation",
            }, logs=[log]),
            _observation("completed", logs=[log]),
        ))
        events: list[tuple[str, str]] = []
        run_poll_count = 0

        def output(message: str) -> None:
            events.append(("output", str(message)))

        def observe(_backend, mode, **_identity):
            nonlocal run_poll_count
            if mode == "pin":
                return {"state": "observed", "api_instance_id": API_INSTANCE}
            run_poll_count += 1
            events.append(("probe", str(run_poll_count)))
            return next(observations)

        with ExitStack() as stack:
            self._patch_admission(stack)
            self._patch_activation(stack)
            stack.enter_context(patch.object(
                run_script_module, "_probe_with_retry", side_effect=observe,
            ))
            stack.enter_context(patch.object(run_script_module.time, "sleep"))
            result = run_script_module.run_script(
                self.repo, "examples/demo.py", output=output,
            )

        output_messages = [message for kind, message in events if kind == "output"]
        joined = "\n".join(output_messages)
        self.assertEqual(joined.count("solver entered relaxation"), 1)
        first_run_probe = events.index(("probe", "1"))
        second_run_probe = events.index(("probe", "2"))
        progress_events = [
            index for index, (kind, message) in enumerate(events)
            if kind == "output" and "Relaxation" in message
        ]
        self.assertTrue(progress_events, "observed solver progress should reach the output callback")
        self.assertLess(first_run_probe, progress_events[0])
        self.assertLess(progress_events[0], second_run_probe)
        self.assertEqual(result["outcome"], "completed")

    def test_distinct_log_sources_and_commands_with_same_text_are_emitted_twice(self) -> None:
        timestamp = 1_800_000_000_000
        log_a = {
            "timestamp_unix_ms": timestamp,
            "level": "info",
            "message": "solver checkpoint saved",
            "source": "solver",
            "phase_id": "relaxation",
            "command_id": "command-a",
        }
        log_b = {
            "timestamp_unix_ms": timestamp,
            "level": "info",
            "message": "solver checkpoint saved",
            "source": "scheduler",
            "phase_id": "relaxation",
            "command_id": "command-b",
        }

        class Headers:
            def get_all(self, name: str):
                return [API_INSTANCE] if name.lower() == "x-fullmag-api-instance" else []

        class Response:
            status = 200
            headers = Headers()

            def __init__(self, value):
                self._body = json.dumps(value).encode("utf-8")

            def __enter__(self):
                return self

            def __exit__(self, *_exc):
                return None

            def read(self, _size=-1):
                return self._body

        class Opener:
            def open(self, request, timeout=None):
                path = urlparse(request.full_url).path
                if path == "/v2/sessions/current/status":
                    return Response({
                        "session": {
                            "session_id": SESSION_ID,
                            "session_epoch": SESSION_EPOCH,
                            "request_scope_epoch": REQUEST_SCOPE_EPOCH,
                        },
                        "run": {
                            "run_id": RUN_ID,
                            "solver_steps": 8,
                            "solver_time": 0.75,
                            "stage_label": "Relaxation",
                        },
                    })
                if path.endswith("/simulation/runs/" + RUN_ID):
                    return Response({
                        "session_id": SESSION_ID,
                        "run_id": RUN_ID,
                        "status": "completed",
                    })
                if path == "/v2/sessions/current/diagnostics/engine-log":
                    return Response({
                        "revision": 2,
                        "total": 2,
                        "entries": [log_a, log_b],
                    })
                raise AssertionError((request.get_method(), path, timeout))

        environ = {
            "FULLMAG_RUN_OBSERVER_MODE": "run",
            "FULLMAG_RUN_OBSERVER_API_INSTANCE_ID": API_INSTANCE,
            "FULLMAG_RUN_OBSERVER_SESSION_ID": SESSION_ID,
            "FULLMAG_RUN_OBSERVER_RUN_ID": RUN_ID,
            "FULLMAG_RUN_OBSERVER_SESSION_EPOCH": SESSION_EPOCH,
            "FULLMAG_RUN_OBSERVER_REQUEST_SCOPE_EPOCH": REQUEST_SCOPE_EPOCH,
        }
        observer_stdout = io.StringIO()
        with patch("urllib.request.build_opener", return_value=Opener()), \
                patch.dict(os.environ, environ, clear=False), \
                redirect_stdout(observer_stdout):
            exec(run_script_module.API_OBSERVER_SCRIPT, {"__name__": "__main__"})
        observed = json.loads(observer_stdout.getvalue())
        self.assertEqual(observed["logs"][0]["source"], "solver")
        self.assertEqual(observed["logs"][0]["command_id"], "command-a")
        self.assertEqual(observed["logs"][1]["source"], "scheduler")
        self.assertEqual(observed["logs"][1]["command_id"], "command-b")

        output: list[str] = []
        with ExitStack() as stack:
            self._patch_admission(stack)
            self._patch_activation(stack)

            def observe(_backend, mode, **_identity):
                if mode == "pin":
                    return {"state": "observed", "api_instance_id": API_INSTANCE}
                return observed

            stack.enter_context(patch.object(
                run_script_module, "_probe_with_retry", side_effect=observe,
            ))
            result = run_script_module.run_script(
                self.repo, "examples/demo.py", output=output.append,
            )

        self.assertEqual(result["outcome"], "completed")
        self.assertEqual(
            sum("solver checkpoint saved" in message for message in output), 2,
        )

    def test_interrupt_drains_terminal_cancel_log_pages_with_the_current_offset(self) -> None:
        logs = [
            {
                "timestamp_unix_ms": 1_800_000_000_000 + index,
                "level": "info",
                "message": f"engine-log-{index:03d}",
                "source": "solver",
                "command_id": "command-run-1",
            }
            for index in range(101)
        ]
        initial = _observation(
            "running", logs=logs[:50], logs_next_offset=50, logs_total=len(logs),
        )
        terminal_cancel_snapshot = _observation(
            "cancelled", logs=logs[50:100], logs_next_offset=100,
            logs_total=len(logs),
        )
        terminal_final_page = _observation(
            "cancelled", logs=logs[100:], logs_next_offset=101,
            logs_total=len(logs),
        )
        output: list[str] = []
        interrupted = False
        run_offsets: list[int] = []

        def observe(_backend, mode, **identity):
            nonlocal interrupted
            if mode == "pin":
                return {"state": "observed", "api_instance_id": API_INSTANCE}
            self.assertEqual(mode, "run")
            run_offsets.append(identity["log_offset"])
            if len(run_offsets) == 1:
                return initial
            return terminal_final_page

        def output_message(message: str) -> None:
            nonlocal interrupted
            output.append(message)
            if message == "Run " + RUN_ID + ": running" and not interrupted:
                interrupted = True
                raise KeyboardInterrupt

        with ExitStack() as stack:
            self._patch_admission(stack)
            self._patch_activation(stack)
            stack.enter_context(patch.object(
                run_script_module, "_probe_with_retry", side_effect=observe,
            ))
            cancel_probe = stack.enter_context(patch.object(
                run_script_module, "_container_probe",
                return_value=terminal_cancel_snapshot,
            ))
            stack.enter_context(patch.object(run_script_module.time, "sleep"))
            result = run_script_module.run_script(
                self.repo, "examples/demo.py", output=output_message,
            )

        cancel_probe.assert_called_once()
        cancel_args, cancel_kwargs = cancel_probe.call_args
        self.assertEqual(cancel_args[:2], (BACKEND_ID, "cancel"))
        self.assertEqual(cancel_kwargs["log_offset"], 50)
        self.assertEqual(run_offsets, [0, 100])
        self.assertEqual(
            sum(message.startswith("[info] engine-log-") for message in output),
            101,
        )
        self.assertTrue(any("engine-log-099" in message for message in output))
        self.assertTrue(any("engine-log-100" in message for message in output))
        self.assertEqual(result["state"], "terminal")
        self.assertEqual(result["status"], "cancelled")
        self.assertEqual(result["exit_code"], 130)

    def test_interrupt_submits_one_exact_cancel_and_reports_confirmed_cancellation(self) -> None:
        observations = iter((_observation("running"), _observation("cancelled")))
        cancellation = {
            "state": "observed",
            "cancellation_submitted": True,
            "run_status": "running",
            "api_instance_id": API_INSTANCE,
            "session_epoch": SESSION_EPOCH,
            "request_scope_epoch": REQUEST_SCOPE_EPOCH,
            "session_id": SESSION_ID,
            "run_id": RUN_ID,
        }

        def observe(_backend, mode, **_identity):
            if mode == "pin":
                return {"state": "observed", "api_instance_id": API_INSTANCE}
            self.assertEqual(mode, "run")
            return next(observations)

        with ExitStack() as stack:
            self._patch_admission(stack)
            self._patch_activation(stack)
            stack.enter_context(patch.object(
                run_script_module, "_probe_with_retry", side_effect=observe,
            ))
            stack.enter_context(patch.object(
                run_script_module.time, "sleep", side_effect=[KeyboardInterrupt(), None],
            ))
            cancel_probe = stack.enter_context(patch.object(
                run_script_module, "_container_probe", return_value=cancellation,
            ))
            result = run_script_module.run_script(self.repo, "examples/demo.py")

        cancel_probe.assert_called_once()
        args, kwargs = cancel_probe.call_args
        self.assertEqual(args[:2], (BACKEND_ID, "cancel"))
        self.assertEqual(kwargs["api_instance_id"], API_INSTANCE)
        self.assertEqual(kwargs["session_id"], SESSION_ID)
        self.assertEqual(kwargs["run_id"], RUN_ID)
        self.assertEqual(kwargs["session_epoch"], SESSION_EPOCH)
        self.assertEqual(kwargs["request_scope_epoch"], REQUEST_SCOPE_EPOCH)
        self.assertEqual(result["state"], "terminal")
        self.assertEqual(result["outcome"], "interrupted")
        self.assertEqual(result["status"], "cancelled")
        self.assertEqual(result["exit_code"], 130)

    def test_interrupt_during_first_run_probe_establishes_scope_for_exact_cancel(self) -> None:
        run_probe_count = 0
        cancellation = {
            **_observation("running"),
            "cancellation_submitted": True,
        }

        def observe(_backend, mode, **_identity):
            nonlocal run_probe_count
            if mode == "pin":
                return {"state": "observed", "api_instance_id": API_INSTANCE}
            self.assertEqual(mode, "run")
            run_probe_count += 1
            if run_probe_count == 1:
                raise KeyboardInterrupt
            return _observation("cancelled")

        with ExitStack() as stack:
            self._patch_admission(stack)
            self._patch_activation(stack)
            stack.enter_context(patch.object(
                run_script_module, "_probe_with_retry", side_effect=observe,
            ))
            cancel_probe = stack.enter_context(patch.object(
                run_script_module, "_container_probe", return_value=cancellation,
            ))
            stack.enter_context(patch.object(run_script_module.time, "sleep"))
            result = run_script_module.run_script(self.repo, "examples/demo.py")

        cancel_probe.assert_called_once()
        args, kwargs = cancel_probe.call_args
        self.assertEqual(args[:2], (BACKEND_ID, "cancel"))
        self.assertEqual(kwargs["api_instance_id"], API_INSTANCE)
        self.assertEqual(kwargs["session_id"], SESSION_ID)
        self.assertEqual(kwargs["run_id"], RUN_ID)
        self.assertIsNone(kwargs["session_epoch"])
        self.assertIsNone(kwargs["request_scope_epoch"])
        self.assertEqual(run_probe_count, 2)
        self.assertEqual(result["state"], "terminal")
        self.assertEqual(result["outcome"], "interrupted")
        self.assertEqual(result["status"], "cancelled")
        self.assertEqual(result["exit_code"], 130)

    def test_unconfirmed_cancel_remains_unknown_and_warns_in_result(self) -> None:
        output: list[str] = []

        def observe(_backend, mode, **_identity):
            if mode == "pin":
                return {"state": "observed", "api_instance_id": API_INSTANCE}
            return _observation("running")

        with ExitStack() as stack:
            self._patch_admission(stack)
            self._patch_activation(stack)
            stack.enter_context(patch.object(
                run_script_module, "_probe_with_retry", side_effect=observe,
            ))
            cancel_probe = stack.enter_context(patch.object(
                run_script_module, "_container_probe",
                return_value={"state": "unknown", "reason": "request_scope_changed"},
            ))
            stack.enter_context(patch.object(
                run_script_module.time, "sleep", side_effect=KeyboardInterrupt,
            ))
            result = run_script_module.run_script(
                self.repo, "examples/demo.py", output=output.append,
            )

        cancel_probe.assert_called_once()
        self.assertEqual(result["state"], "unknown")
        self.assertEqual(result["exit_code"], 130)
        self.assertIn("could not be confirmed", str(result.get("message", "")).lower())
        self.assertTrue(any("could not be confirmed" in message.lower() for message in output))

    def test_interrupt_race_reports_actual_terminal_run_status(self) -> None:
        for terminal_status in ("completed", "failed"):
            with self.subTest(terminal_status=terminal_status), ExitStack() as stack:
                observations = iter((
                    _observation("running"),
                    _observation(terminal_status),
                ))

                def observe(_backend, mode, **_identity):
                    if mode == "pin":
                        return {"state": "observed", "api_instance_id": API_INSTANCE}
                    return next(observations)

                self._patch_admission(stack)
                self._patch_activation(stack)
                stack.enter_context(patch.object(
                    run_script_module, "_probe_with_retry", side_effect=observe,
                ))
                stack.enter_context(patch.object(
                    run_script_module, "_container_probe",
                    return_value={**_observation("running"), "cancellation_submitted": True},
                ))
                stack.enter_context(patch.object(
                    run_script_module.time, "sleep", side_effect=[KeyboardInterrupt(), None],
                ))
                result = run_script_module.run_script(
                    self.repo, "examples/demo.py",
                )
                self.assertEqual(result["state"], "terminal")
                self.assertEqual(result["outcome"], "interrupted")
                self.assertEqual(result["status"], terminal_status)
                self.assertEqual(result["exit_code"], 130)

if __name__ == "__main__":
    unittest.main()
