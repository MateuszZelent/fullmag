"""Source-only contract tests for the managed claimed-worker Rust checks."""

from __future__ import annotations

import ast
import hashlib
import inspect
import unittest

from docker_build_control import BuildControlError, ControlOutcomeUnknown
import docker_claimed_runtime_checks as checks


class ClaimedRuntimeChecksTests(unittest.TestCase):
    def test_cargo_argv_is_two_fixed_commands(self) -> None:
        self.assertEqual(
            checks.CARGO_TEST_COMMANDS,
            (
                (
                    "cargo", "test", "--locked", "--profile", "backend-dev",
                    "-p", "fullmag-session", "--lib", "claimed_interruption",
                    "--", "--test-threads=1",
                ),
                (
                    "cargo", "test", "--locked", "--profile", "backend-dev",
                    "-p", "fullmag-api", "--bin", "fullmag-runtime-service",
                    "claimed_worker_interruption::tests", "--", "--test-threads=1",
                ),
            ),
        )

    def test_generated_python_parses_and_calls_only_focused_entrypoint(self) -> None:
        generated = checks.inside_code()
        tree = ast.parse(generated)
        top_level_calls = [
            node.func.id
            for node in tree.body
            if isinstance(node, ast.Raise)
            and isinstance(node.exc, ast.Call)
            and node.exc.func.id == "SystemExit"
            for node in ast.walk(node.exc)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            and node.func.id == "run_claimed_runtime_checks"
        ]
        self.assertEqual(top_level_calls, ["run_claimed_runtime_checks"])

        runtime = next(
            node for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "run_claimed_runtime_checks"
        )
        called_names = {
            node.func.id for node in ast.walk(runtime)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        }
        self.assertTrue({"runtime_locks", "claimed_build_locks", "pinned_evidence"} <= called_names)
        self.assertIn("pinned_evidence", called_names)
        called_attributes = {
            node.func.attr for node in ast.walk(runtime)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        }
        self.assertIn("_build_environment", called_attributes)
        self.assertNotIn("_prepare_locked", called_attributes)
        self.assertNotIn("_capture_start_manifest", called_attributes)
        self.assertIn("_verify_shadow_source", checks.inside_code())
        self.assertIn("FULLMAG_SESSION_STORAGE_PROFILE", checks.inside_code())
        self.assertIn("environment.pop(name, None)", checks.inside_code())

    def test_bounded_harness_parser_requires_fixed_filter_counts_and_names(self) -> None:
        session = b"".join(
            f"test claimed_interruption::case_{index} ... ok\n".encode()
            for index in range(6)
        ) + b"test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 12 filtered out; finished in 0.01s\n"
        parsed = checks.parse_test_harness_tail(session, 0)
        self.assertIsNone(parsed["gate_error"])
        self.assertEqual(parsed["test_summary"]["passed"], 6)
        api = checks.parse_test_harness_tail(
            b"test claimed_worker_interruption::tests::one ... ok\n"
            b"test claimed_worker_interruption::tests::two ... ok\n"
            b"test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 4 filtered out; finished in 0.01s\n",
            1,
        )
        self.assertIsNone(api["gate_error"])

        too_few = checks.parse_test_harness_tail(
            b"test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 18 filtered out; finished in 0.00s\n",
            0,
        )
        self.assertIn("at least 6", too_few["gate_error"])

        missing = checks.parse_test_harness_tail(b"cargo finished successfully\n", 1)
        self.assertIsNone(missing["test_summary"])
        self.assertIn("exactly one", missing["gate_error"])

        unexpected = checks.parse_test_harness_tail(
            b"test unrelated::name ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out; finished in 0.00s\n",
            1,
        )
        self.assertGreater(unexpected["unexpected_test_line_count"], 0)
        self.assertIn("outside the fixed filter", unexpected["gate_error"])

    def _expected(self) -> dict[str, str]:
        return {
            "source_root": "/opt/fullmag/source",
            "compose_project": "fullmag-master",
            "backend_container_id": "b" * 64,
            "image_id": "sha256:" + "a" * 64,
            "candidate_basename": ".backend-package-candidate-claimed-checks",
            "candidate_receipt_sha256": "c" * 64,
        }

    def _report(self, state: str, codes: tuple[int, ...]) -> dict[str, object]:
        artifacts = [{"path": "bin/fullmag-api", "sha256": "a" * 64}]
        source_manifest_sha256 = "f" * 64
        commands = []
        for index, (command, code) in enumerate(zip(checks.CARGO_TEST_COMMANDS, codes)):
            marker, minimum = checks.TEST_COMMAND_REQUIREMENTS[index]
            passed = minimum if code == 0 else 0
            names = [
                {"name": f"{marker}::case_{test_index}", "status": "ok"}
                for test_index in range(passed)
            ]
            commands.append({
                "argv": list(command),
                "exit_code": code,
                "process_started": True,
                "wait_observed": True,
                "test_summary": ({
                    "passed": passed, "failed": 0, "ignored": 0,
                    "measured": 0, "filtered_out": 12,
                } if code == 0 else None),
                "test_output_counts": {"passed": passed, "failed": 0, "ignored": 0},
                "test_line_count": passed,
                "unexpected_test_line_count": 0,
                "test_records": names,
                "gate_error": (None if code == 0 else "expected exactly one Rust test harness summary"),
            })
        return {
            "schema": checks.RESULT_SCHEMA,
            "state": state,
            "identity": self._expected(),
            "runtime_evidence_before_sha256": "d" * 64,
            "runtime_evidence_after_sha256": "d" * 64,
            "workspace_source_before_sha256": "e" * 64,
            "workspace_source_after_sha256": "e" * 64,
            "source_manifest_sha256": source_manifest_sha256,
            "source_manifest_live_sha256": "9" * 64,
            "workspace_source_file_count": 3,
            "workspace_source_directory_count": 1,
            "candidate_native_source_identity_sha256": "8" * 64,
            "candidate_inventory_sha256": checks.candidate_inventory_sha256(artifacts),
            "candidate_artifact_count": len(artifacts),
            "candidate_source": {"manifest_sha256": source_manifest_sha256},
            "candidate_artifacts": artifacts,
            "commands": commands,
            "runtime_qualification": "NOT VERIFIED",
        }

    def test_two_passed_waits_are_reported_as_focused_checks_only(self) -> None:
        report = self._report("passed", (0, 0))
        self.assertIs(checks.validate_execution_result(0, report, self._expected()), report)

    def test_known_nonzero_cargo_exit_is_not_relabelled_unknown_runtime(self) -> None:
        report = self._report("tests-failed-known", (101, 0))
        self.assertIs(checks.validate_execution_result(44, report, self._expected()), report)

    def test_refusal_before_test_processes_is_a_known_result(self) -> None:
        report = self._report("refused-before-tests", ())
        report["source_manifest_sha256"] = None
        report["source_manifest_live_sha256"] = None
        report["workspace_source_file_count"] = 0
        report["workspace_source_directory_count"] = 0
        report["candidate_native_source_identity_sha256"] = None
        report["candidate_inventory_sha256"] = None
        report["candidate_artifact_count"] = 0
        report["candidate_source"] = None
        report["candidate_artifacts"] = []
        report["refusal_reason"] = "test fixture refusal"
        report["workspace_source_before_sha256"] = None
        report["workspace_source_after_sha256"] = None
        report["commands"] = []
        self.assertIs(checks.validate_execution_result(42, report, self._expected()), report)

    def test_transport_or_unknown_process_exit_retains_managed_lease(self) -> None:
        report = self._report("passed", (0, 0))
        with self.assertRaises(ControlOutcomeUnknown):
            checks.validate_execution_result(125, report, self._expected())

    def test_mismatched_known_exit_and_report_are_rejected(self) -> None:
        report = self._report("passed", (101, 0))
        with self.assertRaises(BuildControlError):
            checks.validate_execution_result(0, report, self._expected())

    def test_exit_zero_with_zero_or_missing_test_summary_cannot_pass(self) -> None:
        for summary in (None, {
            "passed": 0, "failed": 0, "ignored": 0,
            "measured": 0, "filtered_out": 18,
        }):
            report = self._report("passed", (0, 0))
            first = report["commands"][0]
            first["test_summary"] = summary
            first["test_output_counts"] = {"passed": 0, "failed": 0, "ignored": 0}
            first["test_line_count"] = 0
            first["test_records"] = []
            first["gate_error"] = "expected test summary with at least six matching tests"
            with self.assertRaises(BuildControlError):
                checks.validate_execution_result(0, report, self._expected())

    def test_exit_zero_with_unexpected_test_name_cannot_pass(self) -> None:
        report = self._report("passed", (0, 0))
        first = report["commands"][0]
        first["test_records"][0] = {"name": "unrelated::test", "status": "ok"}
        first["unexpected_test_line_count"] = 1
        first["gate_error"] = "Rust test output contains a name outside the fixed filter"
        with self.assertRaises(BuildControlError):
            checks.validate_execution_result(0, report, self._expected())

    def test_known_zero_exit_with_failed_count_gate_is_recorded_as_known_failure(self) -> None:
        report = self._report("tests-failed-known", (0, 0))
        first = report["commands"][0]
        first["test_summary"] = {
            "passed": 0, "failed": 0, "ignored": 0,
            "measured": 0, "filtered_out": 18,
        }
        first["test_output_counts"] = {"passed": 0, "failed": 0, "ignored": 0}
        first["test_line_count"] = 0
        first["test_records"] = []
        first["gate_error"] = "expected at least 6 passing tests for fixed filter"
        self.assertIs(checks.validate_execution_result(44, report, self._expected()), report)

    def test_changed_runtime_or_source_evidence_is_never_accepted(self) -> None:
        report = self._report("passed", (0, 0))
        report["workspace_source_after_sha256"] = "f" * 64
        with self.assertRaises(ControlOutcomeUnknown):
            checks.validate_execution_result(0, report, self._expected())

    def test_candidate_inventory_digest_requires_backend_canonical_newline(self) -> None:
        report = self._report("passed", (0, 0))
        report["candidate_inventory_sha256"] = hashlib.sha256(
            checks.canonical(report["candidate_artifacts"])
        ).hexdigest()
        with self.assertRaises(BuildControlError):
            checks.validate_execution_result(0, report, self._expected())

    def test_host_run_reuses_recovery_authority_and_canonical_cache_guards(self) -> None:
        source = inspect.getsource(checks.run)
        for anchor in (
            "recovery_authority",
            "cache.cache_key",
            "cache.validate_container",
            "validate_other_cache_consumers",
            'control.operation("claimed-runtime-checks"',
        ):
            self.assertIn(anchor, source)
        self.assertIn("pinned_evidence", checks.inside_code())


if __name__ == "__main__":
    unittest.main()
