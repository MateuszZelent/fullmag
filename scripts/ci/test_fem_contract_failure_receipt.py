"""Synthetic failure-receipt observations; never native or qualification evidence."""
from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_fem_positive_mass_contract as contract


def _profile(test_count: int) -> dict[str, object]:
    return {
        "tests": [
            {
                "name": f"contract_{index:02}",
                "source_suffix": f"tests/contract_{index:02}.cpp",
                "compile_definitions": ["-DFULLMAG_HAS_MFEM_STACK=1"],
            }
            for index in range(1, test_count + 1)
        ]
    }


def _write_compile_commands(path: Path, profile: dict[str, object]) -> None:
    tests = profile["tests"]
    entries = [
        {
            "file": f"/workspace/native/{test['source_suffix']}",
            "command": "c++ -DFULLMAG_HAS_MFEM_STACK=1 -c source.cpp",
        }
        for test in tests
    ]
    path.write_text(json.dumps(entries), encoding="utf-8")


def _ctest_log(
    profile: dict[str, object], *, failed_tests: set[int] | frozenset[int] = frozenset()
) -> str:
    tests = profile["tests"]
    total = len(tests)
    failed_count = len(failed_tests)
    passed_percent = round((total - failed_count) * 100 / total)
    lines = ["Test project /build/backends/fem"]
    for ordinal, test in enumerate(tests, start=1):
        name = test["name"]
        status = "***Failed" if ordinal in failed_tests else "Passed"
        lines.extend(
            (
                f"Start {ordinal}: {name}",
                f"{ordinal}/{total} Test #{ordinal}: {name} .............. {status} 0.01 sec",
            )
        )
    lines.append(
        f"{passed_percent}% tests passed, {failed_count} tests failed out of {total}"
    )
    return "\n".join(lines) + "\n"


class FemContractFailureReceiptTests(unittest.TestCase):
    def test_completed_ctest_failure_records_twelve_of_fourteen_without_qualification(self):
        profile = _profile(14)
        first_error = "ContractRunError: Command failed with exit code 8; see ctest.log"
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            compile_commands = root / "compile_commands.json"
            ctest_log = root / "native-build-and-ctest.log"
            _write_compile_commands(compile_commands, profile)
            ctest_log.write_text(
                _ctest_log(profile, failed_tests={4, 12}), encoding="utf-8"
            )
            receipt = {"error": first_error, "observation_errors": []}

            contract._record_failure_observation(
                receipt,
                profile=profile,
                compile_commands=compile_commands,
                ctest_log=ctest_log,
                execution_status="returned_nonzero",
            )

        observation = receipt["failure_observation"]
        self.assertEqual(receipt["error"], first_error)
        self.assertEqual(observation["primary_error"], first_error)
        self.assertEqual(observation["execution"]["status"], "returned_nonzero")
        self.assertFalse(observation["qualification_claimed"])
        self.assertEqual(observation["compile_commands"]["status"], "observed")
        self.assertTrue(observation["compile_commands"]["all_required_gates_passed"])

        ctest = observation["ctest"]
        self.assertEqual(ctest["status"], "terminal_observation_complete")
        self.assertEqual(ctest["terminal_summary"]["reported_total_count"], 14)
        self.assertEqual(ctest["terminal_summary"]["reported_failed_count"], 2)
        self.assertEqual(ctest["observed_counts"]["passed_count"], 12)
        self.assertEqual(ctest["observed_counts"]["failed_count"], 2)
        self.assertEqual(len(ctest["test_results"]), 14)
        self.assertFalse(ctest["qualification_claimed"])
        self.assertEqual(receipt["observation_errors"], [])

    def test_compile_failure_without_ctest_keeps_test_status_unavailable(self):
        profile = _profile(2)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            compile_commands = root / "compile_commands.json"
            ctest_log = root / "native-build-and-ctest.log"
            _write_compile_commands(compile_commands, profile)
            ctest_log.write_text(
                "[ 50%] Building CXX object\nfatal error: missing dependency\n",
                encoding="utf-8",
            )
            receipt = {"error": "ContractRunError: compiler failed", "observation_errors": []}

            contract._record_failure_observation(
                receipt,
                profile=profile,
                compile_commands=compile_commands,
                ctest_log=ctest_log,
                execution_status="returned_nonzero",
            )

        observation = receipt["failure_observation"]
        self.assertEqual(observation["execution"]["status"], "returned_nonzero")
        self.assertEqual(observation["compile_commands"]["status"], "observed")
        self.assertIn("does not prove compilation completed", observation["compile_commands"]["scope"])
        self.assertEqual(observation["ctest"]["status"], "unavailable")
        self.assertIsNone(observation["ctest"]["terminal_summary"])
        self.assertIsNone(observation["ctest"]["test_results"])

    def test_truncated_log_is_partial_and_missing_log_is_explicitly_unavailable(self):
        profile = _profile(14)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            compile_commands = root / "compile_commands.json"
            missing_compile_commands = root / "missing_compile_commands.json"
            partial_log = root / "partial.log"
            missing_log = root / "missing.log"
            _write_compile_commands(compile_commands, profile)
            partial_log.write_text(
                "Test project /build/backends/fem\n"
                "Start 1: contract_01\n"
                "1/14 Test #1: contract_01 ............ Passed 0.01 sec\n",
                encoding="utf-8",
            )
            partial_receipt = {"error": "primary timeout", "observation_errors": []}
            contract._record_failure_observation(
                partial_receipt,
                profile=profile,
                compile_commands=compile_commands,
                ctest_log=partial_log,
                execution_status="timed_out_or_not_started",
            )
            missing_receipt = {"error": "primary compile failure", "observation_errors": []}
            contract._record_failure_observation(
                missing_receipt,
                profile=profile,
                compile_commands=missing_compile_commands,
                ctest_log=missing_log,
                execution_status="returned_nonzero",
            )

        partial = partial_receipt["failure_observation"]["ctest"]
        self.assertEqual(partial["status"], "partial")
        self.assertIsNone(partial["terminal_summary"])
        self.assertEqual(partial["observed_counts"]["passed_count"], 1)
        self.assertEqual(len(partial["test_results"]), 1)
        missing = missing_receipt["failure_observation"]["ctest"]
        self.assertEqual(missing["status"], "unavailable")
        self.assertIsNone(missing["test_results"])
        self.assertIsNone(missing["observed_counts"])
        missing_compile = missing_receipt["failure_observation"]["compile_commands"]
        self.assertEqual(missing_compile["status"], "unavailable")
        self.assertIsNone(missing_compile["compile_gates"])

    def test_observation_error_is_secondary_to_the_original_failure(self):
        profile = _profile(1)
        first_error = "ContractRunError: native command failed"
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            compile_commands = root / "compile_commands.json"
            compile_commands.write_text("{truncated", encoding="utf-8")
            receipt = {"error": first_error, "observation_errors": []}

            contract._record_failure_observation(
                receipt,
                profile=profile,
                compile_commands=compile_commands,
                ctest_log=root / "missing.log",
                execution_status="returned_nonzero",
            )

        self.assertEqual(receipt["error"], first_error)
        self.assertEqual(receipt["failure_observation"]["primary_error"], first_error)
        self.assertEqual(receipt["failure_observation"]["compile_commands"]["status"], "observation_error")
        self.assertEqual(receipt["failure_observation"]["ctest"]["status"], "unavailable")
        self.assertTrue(any(error.startswith("compile_commands:") for error in receipt["observation_errors"]))

    def test_duplicate_terminal_ordinals_or_ctest_ids_are_inconsistent(self):
        profile = _profile(2)
        cases = (
            (
                "duplicate ordinal",
                "1/2 Test #1: contract_01 .............. Passed 0.01 sec\n"
                "1/2 Test #2: contract_02 .............. Passed 0.01 sec\n",
                "duplicate ordinals",
            ),
            (
                "duplicate CTest ID",
                "1/2 Test #1: contract_01 .............. Passed 0.01 sec\n"
                "2/2 Test #1: contract_02 .............. Passed 0.01 sec\n",
                "duplicate test IDs",
            ),
        )
        for label, rows, expected_error in cases:
            with self.subTest(label=label):
                parsed = contract._parse_ctest_failure_log(
                    "Test project /build/backends/fem\n"
                    + rows
                    + "100% tests passed, 0 tests failed out of 2\n",
                    tests=profile["tests"],
                )
                self.assertEqual(parsed["status"], "inconsistent")
                self.assertIn(expected_error, parsed["observation_error"])

    def test_skipped_result_does_not_hide_failure_count_mismatch(self):
        profile = _profile(2)
        parsed = contract._parse_ctest_failure_log(
            "Test project /build/backends/fem\n"
            "1/2 Test #1: contract_01 .............. Skipped 0.01 sec\n"
            "2/2 Test #2: contract_02 .............. Passed 0.01 sec\n"
            "50% tests passed, 1 tests failed out of 2\n",
            tests=profile["tests"],
        )

        self.assertEqual(parsed["status"], "inconsistent")
        self.assertEqual(parsed["observed_counts"]["skipped_count"], 1)
        self.assertEqual(parsed["terminal_summary"]["reported_failed_count"], 1)
        self.assertIn("outcomes disagree", parsed["observation_error"])


if __name__ == "__main__":
    unittest.main()
