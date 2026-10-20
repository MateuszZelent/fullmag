"""Keep the storage guard job wired to the closed native FEM dispatcher tests."""

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "contract-guard.yml"


class ContractGuardWorkflowTests(unittest.TestCase):
    def test_storage_matrix_runs_both_native_fem_dispatch_regressions(self) -> None:
        content = WORKFLOW.read_text(encoding="utf-8")
        start = content.index("  storage-guards:\n")
        end = content.index("\n  canonicalization-guards:\n", start)
        storage_job = content[start:end]

        self.assertIn("os: [ubuntu-latest, windows-latest]", storage_job)
        for test_path in (
            "scripts/test_just_storage_shell_native_fem.py",
            "scripts/test_windows_native_fem_dispatch_authored_input.py",
        ):
            with self.subTest(test_path=test_path):
                self.assertIn(test_path, storage_job)
        self.assertIn("python -B -m pytest -q", storage_job)
        self.assertIn("-p no:cacheprovider", storage_job)

    def test_storage_guard_does_not_promote_a_heavy_fem_build(self) -> None:
        content = WORKFLOW.read_text(encoding="utf-8")
        start = content.index("  storage-guards:\n")
        end = content.index("\n  canonicalization-guards:\n", start)
        storage_job = content[start:end]
        self.assertNotIn("windows-fem-workspace-build", storage_job)
        self.assertNotIn("cargo build", storage_job)
        self.assertNotIn("cmake --build", storage_job)


if __name__ == "__main__":
    unittest.main()
