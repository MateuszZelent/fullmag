"""Focused interpreted checks for retirement refusal and finalizer fences."""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import shutil
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

    @unittest.skipUnless(sys.platform.startswith("linux") and all(
        shutil.which(tool) for tool in ("bash", "flock", "sync", "sha256sum")
    ), "requires Linux shell CAS tools")
    def test_cas_rejects_dangling_active_and_hardlinks_on_already_finalized_records(self):
        operation = "a" * 32
        payloads = dict(active_raw=operation.encode(), receipt_raw=b"receipt",
                        result_raw=b"result", terminal_raw=b"terminal", current_raw=b"current")
        for case in ("dangling-active", "result", "current", "terminal"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                root = Path(directory) / "control"
                attempt = root / "activation/attempts" / operation
                attempt.mkdir(parents=True)
                paths = {name: attempt / (name + ".json") for name in ("receipt", "result", "terminal")}
                paths["current"] = root / "activation/current.json"
                for name, path in paths.items():
                    path.write_bytes(payloads[name + "_raw"])
                if case == "dangling-active":
                    (root / "active").symlink_to(root / "missing")
                else:
                    import os
                    os.link(paths[case], root / "retained-hardlink")
                script = activate._retirement_cas_script(operation_id=operation, **payloads)
                completed = subprocess.run(["bash", "-c", script.replace("/control", str(root))],
                                           capture_output=True, timeout=5)
                self.assertNotEqual(completed.returncode, 0)
                self.assertEqual(paths["terminal"].read_bytes(), payloads["terminal_raw"])
                if case == "dangling-active":
                    self.assertTrue((root / "active").is_symlink())

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
        operation = "a" * 32
        with patch.object(reconcile, "_probe_helper_absence", return_value={"state": "absent"}) as probe, \
             patch.object(activate, "_read_control_bytes", side_effect=activate.ControlOutcomeUnknown("read fence")):
            with self.assertRaisesRegex(activate.ControlOutcomeUnknown, "read fence"):
                activate._finalize_retained_retirement(
                    SimpleNamespace(), operation_id=operation, receipt_raw=b"receipt",
                    result={"state": "retired"}, terminal={"state": "failed-confirmed"})
        probe.assert_called_once_with("fullmag-control-" + operation)


if __name__ == "__main__":
    unittest.main()
