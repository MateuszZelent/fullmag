from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = sorted((ROOT / ".github" / "workflows").glob("*.yml"))


class WorkflowNode24ContractTests(unittest.TestCase):
    def test_workflows_use_node24_compatible_action_majors(self) -> None:
        text = "\n".join(path.read_text(encoding="utf-8") for path in WORKFLOWS)
        forbidden = (
            r"actions/checkout@v[45]",
            r"actions/setup-node@v[456]",
            r"actions/setup-python@v[56]",
            r"actions/upload-artifact@v[456]",
            r"actions/download-artifact@v[4567]",
            r"actions/configure-pages@v[1-5]",
            r"actions/upload-pages-artifact@v[1-3]",
            r"actions/deploy-pages@v[1-4]",
            r"pnpm/action-setup@v[45]",
            r"softprops/action-gh-release@v2",
        )
        for pattern in forbidden:
            self.assertIsNone(re.search(pattern, text), pattern)

    def test_documentation_workflow_uses_node24_pages_actions(self) -> None:
        workflow = (ROOT / ".github/workflows/documentation.yml").read_text(encoding="utf-8")
        self.assertIn("actions/configure-pages@v6", workflow)
        self.assertIn("actions/upload-pages-artifact@v5", workflow)
        self.assertIn("actions/deploy-pages@v5", workflow)


if __name__ == "__main__":
    unittest.main()
