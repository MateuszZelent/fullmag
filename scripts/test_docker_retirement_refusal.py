"""Focused interpreted checks for retirement refusal and finalizer fences."""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
WORKTREE_SCRIPTS = Path(
    "/mnt/c/git/fullmag/worktrees/docker-volume-only-implementation-20261018/scripts"
)
sys.path.insert(0, str(ROOT / "scripts"))
if WORKTREE_SCRIPTS.is_dir():
    sys.path.insert(1, str(WORKTREE_SCRIPTS))


def _load_activation():
    spec = importlib.util.spec_from_file_location(
        "retirement_refusal_activation",
        ROOT / "scripts/docker_volume_activate.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


activate = _load_activation()
import docker_volume_activation_reconcile as reconcile


def _docker_result(returncode: int, value: object) -> SimpleNamespace:
    return SimpleNamespace(
        returncode=returncode,
        stdout=json.dumps(value, sort_keys=True).encode("utf-8"),
        stderr=b"",
    )


def _refusal(operation_id: str) -> dict[str, str]:
    return {
        "schema": "fullmag.live-retirement-refusal.v1",
        "state": "refused",
        "operation_id": operation_id,
        "code": "live_retirement_runtime_not_terminal",
    }


def _run_with(result, *, operation_id: str = "a" * 32):
    with patch.object(activate, "docker_capture", return_value=result) as capture:
        try:
            value = activate._run_fixed_activation(
                "b" * 64,
                script_path=None,
                provenance_path=None,
                provenance_sha256=None,
                helper_sha256="c" * 64,
                activation_timeout_seconds=1,
                # Retirement-only calls intentionally omit startup receipt pins.
                retirement_operation_id=operation_id,
                retirement_inputs_sha256="d" * 64,
                retirement_only=True,
            )
        except BaseException as error:
            value = error
        finally:
            calls = capture.call_count
    return calls, value


class RetirementRefusalTests(unittest.TestCase):
    def test_exact_refusal_exit_is_confirmed_without_a_marker_probe(self):
        operation_id = "a" * 32
        calls, caught = _run_with(_docker_result(78, _refusal(operation_id)), operation_id=operation_id)
        self.assertIsInstance(caught, activate.BuildControlError)
        self.assertIn("live_retirement_runtime_not_terminal", str(caught))
        self.assertEqual(calls, 1)

    def test_wrong_operation_refusal_stays_unknown(self):
        operation_id = "a" * 32
        calls, caught = _run_with(_docker_result(78, _refusal("e" * 32)), operation_id=operation_id)
        self.assertIsInstance(caught, activate.ControlOutcomeUnknown)
        self.assertIn("malformed refusal diagnostic", str(caught))
        self.assertEqual(calls, 1)

    def test_refusal_on_another_exit_code_stays_unknown(self):
        operation_id = "a" * 32
        _calls, caught = _run_with(_docker_result(1, _refusal(operation_id)), operation_id=operation_id)
        self.assertIsInstance(caught, activate.ControlOutcomeUnknown)

    def test_fixed_wrapper_executes_typed_helper_refusal(self):
        operation_id = "a" * 32
        helper_source = """
class RetirementRefused(Exception):
    def __init__(self):
        self.diagnostic = {
            "schema": "fullmag.live-retirement-refusal.v1",
            "state": "refused",
            "operation_id": "a" * 32,
            "code": "live_retirement_busy",
        }

def retire_current_workspace(*_args, **_kwargs):
    raise RetirementRefused()
""".lstrip()
        with tempfile.TemporaryDirectory() as directory:
            helper_path = Path(directory) / "docker_startup_script.py"
            helper_path.write_text(helper_source, encoding="utf-8")
            source = activate.FIXED_ACTIVATION_SCRIPT.replace(
                '"/opt/fullmag/docker_startup_script.py"', repr(str(helper_path)), 1
            )
            environment = {
                "FULLMAG_STARTUP_HELPER_SHA256": hashlib.sha256(helper_source.encode()).hexdigest(),
                "FULLMAG_RETIREMENT_ONLY": "1",
                "FULLMAG_RETIREMENT_OPERATION_ID": operation_id,
                "FULLMAG_RETIREMENT_INPUTS_SHA256": "d" * 64,
                "FULLMAG_STARTUP_API": "http://127.0.0.1:8081",
            }
            completed = subprocess.run(
                [sys.executable, "-I", "-B", "-c", source],
                env=environment,
                capture_output=True,
                check=False,
            )
        self.assertEqual(completed.returncode, 78)
        self.assertEqual(
            json.loads(completed.stdout.decode("utf-8")),
            {
                "schema": "fullmag.live-retirement-refusal.v1",
                "state": "refused",
                "operation_id": operation_id,
                "code": "live_retirement_busy",
            },
        )

    def test_fixed_wrapper_preserves_pending_evidence_after_generic_helper_error(self):
        operation_id = "a" * 32
        helper_source = """
class StartupScriptError(Exception):
    pass

def retire_current_workspace(*_args, **_kwargs):
    raise StartupScriptError("the retirement API returned a noncanonical 400")

def retirement_receipt_evidence(operation_id, _inputs_sha256):
    return {
        "state": "pending",
        "operation_id": operation_id,
        "session_id": "session-1",
        "run_id": "run-1",
        "request_scope_epoch": "old-api:7",
        "api_request_scope_epoch": "old-api:7",
        "marker_sha256": "e" * 64,
    }
""".lstrip()
        with tempfile.TemporaryDirectory() as directory:
            helper_path = Path(directory) / "docker_startup_script.py"
            helper_path.write_text(helper_source, encoding="utf-8")
            source = activate.FIXED_ACTIVATION_SCRIPT.replace(
                '"/opt/fullmag/docker_startup_script.py"', repr(str(helper_path)), 1
            )
            environment = {
                "FULLMAG_STARTUP_HELPER_SHA256": hashlib.sha256(helper_source.encode()).hexdigest(),
                "FULLMAG_RETIREMENT_ONLY": "1",
                "FULLMAG_RETIREMENT_OPERATION_ID": operation_id,
                "FULLMAG_RETIREMENT_INPUTS_SHA256": "d" * 64,
                "FULLMAG_STARTUP_API": "http://127.0.0.1:8081",
            }
            completed = subprocess.run(
                [sys.executable, "-I", "-B", "-c", source],
                env=environment,
                capture_output=True,
                check=False,
            )
        self.assertEqual(completed.returncode, 75)
        diagnostic = json.loads(completed.stdout.decode("utf-8"))
        self.assertEqual(diagnostic["state"], "unknown")
        self.assertEqual(diagnostic["operation_id"], operation_id)
        self.assertEqual(diagnostic["retirement"]["state"], "pending")
        self.assertEqual(diagnostic["retirement"]["marker_sha256"], "e" * 64)

    def test_cas_rejects_dangling_active_and_hardlinks_on_already_finalized_records(self):
        script = activate._retirement_cas_script(
            operation_id="a" * 32,
            active_raw=b"a" * 32,
            receipt_raw=b"receipt",
            result_raw=b"result",
            terminal_raw=b"terminal",
            current_raw=b"current",
        )
        self.assertIn("if test ! -L /control/active && test ! -e /control/active; then", script)
        for path in (
            "/control/activation/attempts/" + "a" * 32 + "/result.json",
            "/control/activation/current.json",
            "/control/activation/attempts/" + "a" * 32 + "/terminal.json",
        ):
            self.assertIn(f'test "$(stat -c %h {path})" = 1;', script)

    def test_cas_rejects_a_foreign_active_operation_before_rendering(self):
        with self.assertRaises(activate.ControlOutcomeUnknown):
            activate._retirement_cas_script(
                operation_id="a" * 32,
                active_raw=b"e" * 32,
                receipt_raw=b"receipt",
                result_raw=b"result",
                terminal_raw=b"terminal",
                current_raw=b"current",
            )

    def test_finalizer_resolves_canonical_helper_absence_probe(self):
        operation_id = "a" * 32
        written = []
        active_raw = operation_id.encode("ascii") + b"\n"
        receipt_raw = b"receipt"

        class _Control:
            namespace = ""
            namespace_registry_sha256 = None

            def write_bytes(self, relative, payload):
                written.append((relative, payload))

        result = {"state": "retirement-only", "retirement": {"operation_id": operation_id}}
        terminal = {
            "schema": activate.OPERATION_SCHEMA,
            "phase": "activation",
            "state": "failed-confirmed",
            "attempt": operation_id,
            "activation_state": "retirement-replayed",
            "compose_project": "fullmag-worktree-demo",
            "control_volume": "fullmag-build-control-demo",
            "development_attempt": "c" * 32,
            "config_sha256": "d" * 64,
            "backend_container": "e" * 64,
            "image_id": "sha256:" + "f" * 64,
            "source_root": "C:/git/fullmag",
        }
        with patch.object(reconcile, "_probe_helper_absence", return_value=None), patch.object(
            activate,
            "_read_control_bytes",
            side_effect=[None, active_raw, receipt_raw, None, None, None],
        ), patch.object(activate, "_retirement_live_current_cas") as pointer_cas:
            activate._finalize_retained_retirement(
                _Control(),
                operation_id=operation_id,
                receipt_raw=receipt_raw,
                result=result,
                terminal=terminal,
            )
        pointer_cas.assert_called_once()
        self.assertEqual(pointer_cas.call_args.kwargs["active_raw"], active_raw)
        self.assertEqual(pointer_cas.call_args.kwargs["receipt_raw"], receipt_raw)
        self.assertIsNone(pointer_cas.call_args.kwargs["expected_previous_current_raw"])
        self.assertEqual(
            [relative for relative, _payload in written],
            [
                "activation/attempts/" + operation_id + "/result.json",
                "activation/attempts/" + operation_id + "/terminal.json",
            ],
        )


if __name__ == "__main__":
    unittest.main()
