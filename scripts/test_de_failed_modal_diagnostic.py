import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import de_failed_modal_diagnostic as failure
import run_de_100nm_pilot as pilot
from test_run_de_100nm_pilot import _schur_action_fixture


def fixture():
    terminal = {"index": 1, "stop_reason": "floquet_slepc_solve_failed",
                "floquet_schur_action_diagnostic": _schur_action_fixture(),
                "ksp_diagnostics_available": False,
                "ksp_converged_reason": None,
                "eps_converged_reason": None,
                "ksp_last_true_residual_available": False,
                "ksp_monitor_progress": monitor_progress()}
    return {"schema_version": "frequency_domain_modal_diagnostics.v1",
            "status": "solve_error", "complete": False,
            "accepted_mode_count_after_dedup": 0,
            "failure_reason": "floquet_slepc_solve_failed",
            "subwindows": [{"index": 0, "stop_reason": "window_exhausted",
                            "floquet_schur_action_diagnostic": _schur_action_fixture()},
                           terminal]}


def monitor_progress():
    return {"schema_version": "floquet_shifted_ksp_monitor_progress.v1",
            "phase": "during_eps_solve", "source": "petsc_ksp_monitor",
            "monitor_registered": True, "available": True,
            "observation_count": 4,
            "observation_count_scope": "all_shifted_ksp_monitor_callbacks_during_one_epsolve",
            "last_iteration_available": True, "last_iteration": 10,
            "recursive_residual_available": True,
            "recursive_residual_norm": 5.9689e-16,
            "recursive_residual_semantics": "petsc_monitor_recursive_norm_not_true_residual",
            "last_observed_reason_available": True, "last_observed_reason": 0,
            "last_observed_reason_is_final": False}


def log_line(payload):
    return "Error: RunError: native solve failed (diagnostics_json=" + json.dumps(payload) + ")\n"


class FailedDiagnosticTests(unittest.TestCase):
    def test_executor_preserves_failed_status_with_measured_observation(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = root / "de-smoke-k2"
            case.mkdir()
            (case / "runtime.log").write_text(log_line(fixture()), encoding="utf-8")
            context = SimpleNamespace(layout={"repo_root": str(root)}, image_digest="sha256:test")
            with patch.object(pilot.managed, "_run_request", return_value={"source": {}, "job": {}, "runtime": {}}), \
                 patch.object(pilot.managed, "_compose_environment", return_value={}), \
                 patch.object(pilot.subprocess, "run", return_value=SimpleNamespace(returncode=7)), \
                 patch.object(pilot.managed, "_cleanup_benchmark_container", return_value={"status": "absent"}), \
                 patch("builtins.print"):
                code = pilot.execute(context, root, ["docker"], "abc", pilot="de-smoke-k2",
                                     schur_action_diagnostic=True)
            result = json.loads((root / "run-result.json").read_text(encoding="utf-8"))
            self.assertEqual(code, 1)
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["return_code"], 7)
            diagnostic = result["artifacts"]["floquet_schur_action_diagnostic"]
            self.assertEqual(diagnostic["validation_status"], "pass")
            self.assertFalse(diagnostic["physical_certificate"])

    def test_failure_log_retains_failed_and_earlier_subwindows(self):
        with TemporaryDirectory() as tmp:
            case = Path(tmp)
            (case / "runtime.log").write_text(log_line(fixture()), encoding="utf-8")
            report = pilot.validate_schur_action_diagnostic(case)
            self.assertEqual(report["status"], "measured")
            self.assertEqual(report["validation_status"], "pass")
            self.assertEqual(report["source_kind"], "terminal_failure_log")
            self.assertEqual(len(report["native_subwindow_observations"]), 2)
            progress = report["ksp_monitor_progress"]
            self.assertEqual(progress["last_observed_reason"], 0)
            self.assertFalse(progress["last_observed_reason_is_final"])
            self.assertEqual(progress["recursive_residual_norm"], 5.9689e-16)
            self.assertEqual(report["native_subwindow_observations"][-1]["ksp_monitor_progress"],
                             progress)
            self.assertFalse(report["physical_certificate"])
            self.assertEqual(len(report["source_sha256"]), 64)

    def test_monitor_progress_preserves_known_zero_and_unavailable_values(self):
        with TemporaryDirectory() as tmp:
            case = Path(tmp)
            data = fixture()
            progress = data["subwindows"][-1]["ksp_monitor_progress"]
            progress.update(available=False, observation_count=0,
                            last_iteration_available=False, last_iteration=None,
                            recursive_residual_available=False,
                            recursive_residual_norm=None,
                            last_observed_reason_available=False,
                            last_observed_reason=None)
            (case / "runtime.log").write_text(log_line(data), encoding="utf-8")
            payload, evidence = failure.read_failed_schur_action(case)
            self.assertEqual(payload["ksp_monitor_progress"]["observation_count"], 0)
            self.assertFalse(payload["ksp_monitor_progress"]["available"])
            self.assertIsNone(payload["ksp_monitor_progress"]["last_iteration"])
            self.assertIsNone(payload["ksp_monitor_progress"]["recursive_residual_norm"])
            self.assertIsNone(payload["ksp_monitor_progress"]["last_observed_reason"])
            self.assertEqual(evidence["native_subwindow_observations"][-1]["ksp_monitor_progress"],
                             payload["ksp_monitor_progress"])

            data = fixture()
            progress = data["subwindows"][-1]["ksp_monitor_progress"]
            progress.update(observation_count=1, last_iteration_available=True,
                            last_iteration=0, recursive_residual_available=True,
                            recursive_residual_norm=0.0)
            (case / "runtime.log").write_text(log_line(data), encoding="utf-8")
            payload, _ = failure.read_failed_schur_action(case)
            self.assertEqual(payload["ksp_monitor_progress"]["last_iteration"], 0)
            self.assertEqual(payload["ksp_monitor_progress"]["recursive_residual_norm"], 0.0)
            self.assertEqual(payload["ksp_monitor_progress"]["last_observed_reason"], 0)

    def test_rejects_monitor_reason_as_final_or_final_query_after_hard_error(self):
        with TemporaryDirectory() as tmp:
            case = Path(tmp)
            mutations = [
                lambda window: window["ksp_monitor_progress"].update(
                    last_observed_reason_is_final=True),
                lambda window: window.update(ksp_converged_reason=0),
                lambda window: window.update(ksp_diagnostics_available=True),
                lambda window: window.update(ksp_monitor_progress=None),
                lambda window: window["ksp_monitor_progress"].update(
                    observation_count=0),
                lambda window: window["ksp_monitor_progress"].update(
                    recursive_residual_norm=-1.0),
                lambda window: window["ksp_monitor_progress"].update(
                    last_iteration_available=False),
            ]
            for mutate in mutations:
                data = fixture()
                mutate(data["subwindows"][-1])
                (case / "runtime.log").write_text(log_line(data), encoding="utf-8")
                with self.subTest(mutate=mutate):
                    with self.assertRaises(ValueError):
                        failure.read_failed_schur_action(case)

    def test_legacy_failure_log_without_monitor_snapshot_remains_usable(self):
        with TemporaryDirectory() as tmp:
            case = Path(tmp)
            data = fixture()
            terminal = data["subwindows"][-1]
            terminal.pop("ksp_monitor_progress")
            for name in ("ksp_diagnostics_available", "ksp_converged_reason",
                         "eps_converged_reason", "ksp_last_true_residual_available"):
                terminal.pop(name)
            (case / "runtime.log").write_text(log_line(data), encoding="utf-8")
            payload, evidence = failure.read_failed_schur_action(case)
            self.assertNotIn("ksp_monitor_progress", payload)
            self.assertNotIn("ksp_monitor_progress", evidence)
            self.assertNotIn("ksp_monitor_progress",
                             evidence["native_subwindow_observations"][-1])

    def test_rejects_ambiguous_records_duplicate_keys_and_nonfinite(self):
        with TemporaryDirectory() as tmp:
            case = Path(tmp)
            valid = log_line(fixture())
            records = [valid + valid,
                       valid.replace('"complete": false', '"complete": false, "complete": false'),
                       valid.replace('"complete": false', '"complete": false, "value": NaN'),
                       valid.replace('"complete": false', '"complete": false, "value": 1e999'),
                       valid.rstrip() + " extra\n"]
            for record in records:
                with self.subTest(record=record[:70]):
                    (case / "runtime.log").write_text(record, encoding="utf-8")
                    self.assertEqual(pilot.validate_schur_action_diagnostic(case)["status"], "unavailable")

    def test_completed_or_mismatched_record_cannot_be_failure_evidence(self):
        with TemporaryDirectory() as tmp:
            case = Path(tmp)
            for field, value in (("status", "completed"), ("complete", True),
                                 ("accepted_mode_count_after_dedup", 1),
                                 ("failure_reason", "other")):
                data = fixture()
                data[field] = value
                (case / "runtime.log").write_text(log_line(data), encoding="utf-8")
                with self.assertRaises(ValueError):
                    failure.read_failed_schur_action(case)

    def test_byte_budget_is_enforced(self):
        with TemporaryDirectory() as tmp, patch.object(failure, "MAX_LOG_BYTES", 16):
            case = Path(tmp)
            (case / "runtime.log").write_text(log_line(fixture()), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "bounded"):
                failure.read_failed_schur_action(case)

    def test_bad_native_probe_is_not_promoted(self):
        with TemporaryDirectory() as tmp:
            case = Path(tmp)
            data = fixture()
            data["subwindows"][-1]["floquet_schur_action_diagnostic"]["action_count"] = 99
            (case / "runtime.log").write_text(log_line(data), encoding="utf-8")
            report = pilot.validate_schur_action_diagnostic(case)
            self.assertEqual(report["validation_status"], "failed")
            self.assertIn("action_count", report["validation_errors"])


if __name__ == "__main__":
    unittest.main()
