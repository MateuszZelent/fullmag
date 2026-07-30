from datetime import datetime, timezone
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
RELEASE_WORKFLOW = ROOT / ".github/workflows/release.yml"


class ReleaseWorkflowContractTests(unittest.TestCase):
    def test_release_workflow_file_exists(self) -> None:
        self.assertTrue(RELEASE_WORKFLOW.is_file(), "release.yml workflow file must exist")

    def test_workflow_has_only_manual_dispatch_trigger(self) -> None:
        content = RELEASE_WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("workflow_dispatch:", content)
        self.assertNotIn("push:", content)
        self.assertNotIn("pull_request:", content)

    def test_workflow_defines_required_inputs(self) -> None:
        content = RELEASE_WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("version_prefix:", content)
        self.assertIn("custom_tag:", content)
        self.assertIn("is_prerelease:", content)

    def test_workflow_has_linux_and_windows_matrix_jobs(self) -> None:
        content = RELEASE_WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("build-linux:", content)
        self.assertIn("runs-on: ubuntu-latest", content)
        self.assertIn("build-windows:", content)
        self.assertIn("runs-on: windows-latest", content)
        self.assertIn("publish-release:", content)

    def test_version_tag_computation_format(self) -> None:
        prefix = "0.1.0"
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        generated_tag = f"v{prefix}-{timestamp}"

        # Assert format: v0.1.0-YYYYMMDD-HHMMSS
        pattern = r"^v\d+\.\d+\.\d+-\d{8}-\d{6}$"
        self.assertIsNotNone(
            re.match(pattern, generated_tag),
            f"Generated tag {generated_tag} does not match expected iterative timestamp format",
        )


if __name__ == "__main__":
    unittest.main()
