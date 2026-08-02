import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
VALIDATOR = REPO_ROOT / "scripts/validate_fem_solver_optimization_ledger.py"


def ledger_row(task_id: str, status: str = "pending", **overrides: str) -> str:
    row = {
        "status": status,
        "source_commit": "",
        "runtime_manifest_sha256": "",
        "evidence": "",
        "decision": "",
        "commit": "",
        "notes": "",
    }
    row.update(overrides)
    return "| {task_id} | {status} | {source_commit} | {runtime_manifest_sha256} | {evidence} | {decision} | {commit} | {notes} |".format(
        task_id=task_id, **row
    )


def ledger_text(rows: list[str]) -> str:
    return "\n".join(
        [
            "# FEM solver optimization remediation ledger",
            "",
            "| Task | status | source_commit | runtime_manifest_sha256 | evidence | decision | commit | notes |",
            "| --- | --- | --- | --- | --- | --- | --- | --- |",
            *rows,
            "",
        ]
    )


class FemSolverOptimizationLedgerTest(unittest.TestCase):
    def _run(self, root: Path, ledger: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(VALIDATOR), str(ledger), "--repo-root", str(root)],
            check=False,
            capture_output=True,
            text=True,
        )

    def test_rejects_missing_task_row(self) -> None:
        rows = [ledger_row(f"T{task_id}") for task_id in range(24) if task_id != 17]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ledger = root / "ledger.md"
            ledger.write_text(ledger_text(rows), encoding="utf-8")

            result = self._run(root, ledger)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing task row: T17", result.stderr)

    def test_rejects_completed_task_without_evidence(self) -> None:
        rows = [ledger_row(f"T{task_id}") for task_id in range(24)]
        rows[4] = ledger_row(
            "T4",
            "completed",
            source_commit="a" * 40,
            decision="promote",
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ledger = root / "ledger.md"
            ledger.write_text(ledger_text(rows), encoding="utf-8")

            result = self._run(root, ledger)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("completed task T4 requires at least one evidence path", result.stderr)

    def test_rejects_duplicate_task_row(self) -> None:
        rows = [ledger_row(f"T{task_id}") for task_id in range(24)]
        rows.append(ledger_row("T17"))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ledger = root / "ledger.md"
            ledger.write_text(ledger_text(rows), encoding="utf-8")

            result = self._run(root, ledger)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("duplicate task row: T17", result.stderr)


if __name__ == "__main__":
    unittest.main()
