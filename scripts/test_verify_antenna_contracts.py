from __future__ import annotations

import unittest
from unittest.mock import patch
import json
from pathlib import Path
import subprocess

from capture_source_snapshot_identity import SourceIdentityError
from verify_antenna_contracts import (
    AUTHORING_TESTS, BROWSER_VITEST_TESTS, GROUPS, MODEL_TESTS, main, node_test_counts,
    pytest_counts, vitest_counts,
)


class AntennaContractWrapperTests(unittest.TestCase):
    def test_groups_are_closed_and_include_every_plan_group(self) -> None:
        self.assertEqual(len(GROUPS), 16)
        self.assertEqual(len(set(GROUPS)), len(GROUPS))
        self.assertIn("authoring", GROUPS)
        self.assertIn("model", GROUPS)
        self.assertIn("all", GROUPS)
        self.assertIn("packages/fullmag-py/tests/test_antenna_layout.py", MODEL_TESTS)
        self.assertIn("packages/fullmag-py/tests/test_runtime_cli_state_transfer.py", AUTHORING_TESTS)

    def test_pytest_summary_requires_real_passed_tests(self) -> None:
        self.assertEqual(pytest_counts("66 passed, 2 subtests passed in 1.96s"), (66, 0, 0))
        self.assertEqual(pytest_counts("13 passed, 1 skipped"), (13, 0, 1))
        self.assertEqual(pytest_counts("no tests ran"), (0, 0, 0))

    def test_model_group_runs_only_the_declared_geometry_and_composition_contracts(self) -> None:
        snapshot = {
            "head_commit_full": "a" * 40,
            "source_snapshot_sha256": "b" * 64,
            "dirty_path_content": [],
        }
        reports: dict[str, str] = {}

        def record(path: Path, content: str, *, encoding: str) -> int:
            reports[path.name] = content
            return len(content)

        with (
            patch.dict("os.environ", {"FULLMAG_PROJECT_STORAGE_ROOT": "D:/storage"}),
            patch("verify_antenna_contracts.managed_path", side_effect=[Path("D:/storage/runs"), Path("D:/storage/builds")]),
            patch("verify_antenna_contracts.capture", return_value=snapshot),
            patch.object(Path, "mkdir"),
            patch.object(Path, "is_file", return_value=True),
            patch.object(Path, "write_text", autospec=True, side_effect=record),
            patch("verify_antenna_contracts.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "21 passed in 2.35s")) as run,
        ):
            self.assertEqual(main(["model"]), 0)

        self.assertEqual(run.call_args.args[0][-len(MODEL_TESTS):], list(MODEL_TESTS))
        result = json.loads(reports["result.json"])
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["passed_count"], 21)
        self.assertTrue(result["source_unchanged"])

    def test_browser_summaries_count_real_tests_and_skips(self) -> None:
        self.assertEqual(len(BROWSER_VITEST_TESTS), 16)
        self.assertIn(
            "apps/control-room/src/kernel/authoring/geometryLifecycleCommandContributions.test.ts",
            BROWSER_VITEST_TESTS,
        )
        self.assertIn(
            "apps/control-room/src/modules/inspector/panels/TransportAuthoringInspectorModel.test.ts",
            BROWSER_VITEST_TESTS,
        )
        self.assertIn(
            "apps/control-room/src/modules/inspector/panels/antenna/MicrostripGeometryEditorModel.test.ts",
            BROWSER_VITEST_TESTS,
        )
        self.assertIn(
            "apps/control-room/src/modules/inspector/panels/antenna/AntennaFieldBasisPreview.dom.test.tsx",
            BROWSER_VITEST_TESTS,
        )
        self.assertEqual(
            node_test_counts("# tests 5\n# pass 5\n# fail 0\n# skipped 0\n"),
            (5, 5, 0, 0),
        )
        self.assertEqual(
            vitest_counts(" Test Files  12 passed (12)\n      Tests  73 passed (73)\n"),
            (73, 0, 0),
        )
        self.assertEqual(
            vitest_counts(" Tests  1 failed | 66 passed | 2 skipped\n"),
            (66, 1, 2),
        )

    def test_interpreter_start_failure_still_records_failed_report(self) -> None:
        snapshot = {
            "head_commit_full": "a" * 40,
            "source_snapshot_sha256": "b" * 64,
            "dirty_path_content": [],
        }
        reports: dict[str, str] = {}

        def record(path: Path, content: str, *, encoding: str) -> int:
            reports[path.name] = content
            return len(content)

        with (
            patch.dict("os.environ", {"FULLMAG_PROJECT_STORAGE_ROOT": "D:/storage"}),
            patch("verify_antenna_contracts.managed_path", side_effect=[Path("D:/storage/runs"), Path("D:/storage/builds")]),
            patch("verify_antenna_contracts.capture", return_value=snapshot),
            patch.object(Path, "mkdir"),
            patch.object(Path, "is_file", return_value=True),
            patch.object(Path, "write_text", autospec=True, side_effect=record),
            patch("verify_antenna_contracts.subprocess.run", side_effect=OSError("interpreter unavailable")),
        ):
            self.assertEqual(main(["authoring"]), 3)

        result = json.loads(reports["result.json"])
        self.assertEqual(result["status"], "fail")
        self.assertEqual(result["wrapper_exit_code"], 3)
        self.assertIsNone(result["command_exit_code"])
        self.assertEqual(result["test_count"], 0)
        self.assertIn("interpreter unavailable", reports["test.log"])

    def test_browser_contract_passes_do_not_claim_e2e_qualification(self) -> None:
        snapshot = {
            "head_commit_full": "a" * 40,
            "source_snapshot_sha256": "b" * 64,
            "dirty_path_content": [],
        }
        reports: dict[str, str] = {}

        def record(path: Path, content: str, *, encoding: str) -> int:
            reports[path.name] = content
            return len(content)

        node_output = "# tests 5\n# pass 5\n# fail 0\n# skipped 0\n"
        vitest_output = " Test Files  12 passed (12)\n      Tests  73 passed (73)\n"
        with (
            patch.dict("os.environ", {"FULLMAG_PROJECT_STORAGE_ROOT": "D:/storage"}),
            patch("verify_antenna_contracts.managed_path", side_effect=[
                Path("D:/storage/runs"), Path("D:/storage/builds"), Path("D:/storage/frontend"),
            ]),
            patch("verify_antenna_contracts.capture", return_value=snapshot),
            patch("verify_antenna_contracts.shutil.which", return_value="node"),
            patch.object(Path, "is_relative_to", return_value=True),
            patch.object(Path, "is_file", return_value=True),
            patch.object(Path, "mkdir"),
            patch.object(Path, "write_text", autospec=True, side_effect=record),
            patch("verify_antenna_contracts.subprocess.run", side_effect=[
                subprocess.CompletedProcess([], 0, node_output),
                subprocess.CompletedProcess([], 0, vitest_output),
            ]),
        ):
            self.assertEqual(main(["browser"]), 3)

        result = json.loads(reports["result.json"])
        self.assertEqual(result["status"], "not_qualified")
        self.assertEqual(result["test_count"], 78)
        self.assertEqual(result["passed_count"], 78)
        self.assertEqual(result["command_exit_codes"], [0, 0])
        self.assertTrue(result["source_unchanged"])

    def test_source_recapture_failure_invalidates_a_passing_test(self) -> None:
        snapshot = {
            "head_commit_full": "a" * 40,
            "source_snapshot_sha256": "b" * 64,
            "dirty_path_content": [],
        }
        reports: dict[str, str] = {}

        def record(path: Path, content: str, *, encoding: str) -> int:
            reports[path.name] = content
            return len(content)

        with (
            patch.dict("os.environ", {"FULLMAG_PROJECT_STORAGE_ROOT": "D:/storage"}),
            patch("verify_antenna_contracts.managed_path", side_effect=[Path("D:/storage/runs"), Path("D:/storage/builds")]),
            patch("verify_antenna_contracts.capture", side_effect=[snapshot, SourceIdentityError("source changed")]),
            patch.object(Path, "mkdir"),
            patch.object(Path, "write_text", autospec=True, side_effect=record),
        ):
            self.assertEqual(main(["native-current"]), 3)

        result = json.loads(reports["result.json"])
        self.assertEqual(result["status"], "fail")
        self.assertFalse(result["source_unchanged"])
        self.assertIn("source changed", result["reason"])


if __name__ == "__main__":
    unittest.main()
