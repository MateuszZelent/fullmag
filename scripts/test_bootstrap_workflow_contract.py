from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]


class BootstrapWorkflowContractTests(unittest.TestCase):
    def test_ci_installs_native_tools_before_contract_checks(self) -> None:
        workflow = (ROOT / ".github/workflows/bootstrap.yml").read_text()

        self.assertEqual(workflow.count("sudo apt-get install -y ripgrep"), 1)
        self.assertIn("sudo apt-get install -y libglu1-mesa", workflow)
        self.assertIn('test "$(/usr/bin/rg --version | head -n 1)" = "ripgrep 13.0.0"', workflow)

    def test_ci_uses_node24_actions(self) -> None:
        workflow = (ROOT / ".github/workflows/bootstrap.yml").read_text()

        self.assertNotIn("actions/checkout@v4", workflow)
        self.assertEqual(
            workflow.count("actions/checkout@v7"),
            workflow.count("- name: Checkout"),
        )
        self.assertEqual(
            workflow.count("actions/setup-node@v7"),
            workflow.count("- name: Setup Node.js"),
        )
        self.assertIn("actions/setup-python@v7", workflow)
        self.assertIn("actions/upload-artifact@v7", workflow)
        self.assertIn("pnpm/action-setup@v6", workflow)

    def test_meshing_extra_provides_trimesh_boolean_backend(self) -> None:
        pyproject = (ROOT / "packages/fullmag-py/pyproject.toml").read_text()

        self.assertIn('"manifold3d>=3,<4"', pyproject)

    def test_viewport_audit_installs_playwright_from_control_room_workspace(self) -> None:
        workflow = (ROOT / ".github/workflows/bootstrap.yml").read_text()

        self.assertIn(
            "pnpm --dir apps/control-room exec playwright install --with-deps chromium",
            workflow,
        )
        self.assertNotIn("pnpm exec playwright install --with-deps chromium", workflow)

    def test_every_tracked_gitlink_has_submodule_metadata(self) -> None:
        gitmodules = (ROOT / ".gitmodules").read_text()
        index = subprocess.check_output(
            ["git", "ls-files", "--stage"], cwd=ROOT, text=True
        )
        gitlinks = [
            line.split("\t", 1)[1]
            for line in index.splitlines()
            if line.startswith("160000 ")
        ]

        self.assertTrue(gitlinks)
        for path in gitlinks:
            self.assertIn(f"path = {path}", gitmodules)


if __name__ == "__main__":
    unittest.main()
