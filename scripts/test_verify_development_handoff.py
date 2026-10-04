"""Regression checks for the managed handoff-check receipt boundary."""

from contextlib import nullcontext, redirect_stdout
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import verify_development_handoff as checks


class ManagedHandoffCheckReceiptTests(unittest.TestCase):
    def exercise(self, output, identities=("a", "a"), child_code=0):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            repo = root / "repo"
            repo.mkdir()
            store = root / "storage"
            index = store / "index"
            index.mkdir(parents=True)
            (index / "worktree.json").write_text(json.dumps({
                "repo_root": str(repo), "task_id": "fixture", "owner": "test", "state": "wip",
            }), encoding="utf-8")
            layout = {"repo_root": str(repo), "storage_root": str(store),
                      "build_storage_root": str(store / "builds"),
                      "build_root": str(store / "builds" / "worktree" / "checks"),
                      "worktree_id": "worktree", "profile": "development-handoff-checks",
                      "env": {}}

            def child(command, **kwargs):
                self.assertEqual(command[-2:], ["test_*development_*.py", "-v"])
                kwargs["stdout"].write(output)
                return type("Result", (), {"returncode": child_code})()

            failure = None
            with patch.object(checks.storage, "resolve_layout", return_value=layout), \
                    patch.object(checks.storage, "initialize"), \
                    patch.object(checks.storage, "build_lock", return_value=nullcontext()), \
                    patch.object(checks.storage, "git", return_value="b" * 40), \
                    patch.object(checks, "source_identity", side_effect=identities), \
                    patch.object(checks.subprocess, "run", side_effect=child), \
                    redirect_stdout(io.StringIO()):
                try:
                    result = checks.run(str(repo))
                except Exception as error:
                    result, failure = None, error
            receipts = list(Path(layout["build_root"]).glob("checks/*/receipt.json"))
            self.assertEqual(len(receipts), 1)
            receipt = json.loads(receipts[0].read_text(encoding="utf-8"))
            return result, failure, receipt

    def test_records_nonempty_success(self):
        result, error, receipt = self.exercise("Ran 4 tests in 0.01s\n\nOK\n")
        self.assertEqual(result, 0)
        self.assertIsNone(error)
        self.assertEqual(receipt["state"], "completed")
        self.assertEqual(receipt["tests_run"], 4)

    def test_zero_checks_or_all_skipped_is_not_success(self):
        for output in ("Ran 0 tests in 0.01s\n\nOK\n",
                       "Ran 4 tests in 0.01s\n\nOK (skipped=4)\n"):
            with self.subTest(output=output):
                result, _, receipt = self.exercise(output)
                self.assertNotEqual(result, 0)
                self.assertEqual(receipt["state"], "failed")
                self.assertEqual(receipt["reason"], "no_checks_executed")

    def test_source_change_or_failed_child_is_not_success(self):
        result, _, receipt = self.exercise("Ran 4 tests in 0.01s\n\nOK\n", identities=("a", "b"))
        self.assertNotEqual(result, 0)
        self.assertEqual(receipt["reason"], "source_changed_during_checks")
        result, _, receipt = self.exercise("Ran 4 tests in 0.01s\n\nFAILED\n", child_code=7)
        self.assertEqual(result, 7)
        self.assertEqual(receipt["exit_code"], 7)
        self.assertEqual(receipt["state"], "failed")

    def test_exception_after_successful_child_records_failure(self):
        _, error, receipt = self.exercise("Ran 4 tests in 0.01s\n\nOK\n",
                                          identities=("a", OSError("source unreadable")))
        self.assertIsInstance(error, OSError)
        self.assertNotEqual(receipt["exit_code"], 0)
        self.assertEqual(receipt["state"], "failed")

    def test_shell_rejects_composite_or_extra_arguments_before_preflight(self):
        bash = shutil.which("bash")
        if bash is None:
            self.skipTest("Bash is unavailable")
        repo = Path(__file__).resolve().parent.parent
        helper = (repo / "scripts/verify_development_handoff.py").as_posix()
        valid = f'python "{helper}" --repo-root "{repo.as_posix()}"'
        for recipe in (valid + ' && echo "just --list"', valid + " --route arbitrary"):
            with self.subTest(recipe=recipe):
                result = subprocess.run([bash, str(repo / "scripts/just_storage_shell.sh"), recipe],
                                        capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, 2)
                self.assertIn("invalid development handoff check recipe", result.stderr)


if __name__ == "__main__":
    unittest.main()
