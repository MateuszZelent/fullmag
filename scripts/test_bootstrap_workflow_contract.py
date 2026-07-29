from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class BootstrapWorkflowContractTests(unittest.TestCase):
    def test_ci_installs_native_tools_before_contract_checks(self) -> None:
        workflow = (ROOT / ".github/workflows/bootstrap.yml").read_text()

        self.assertEqual(workflow.count("sudo apt-get install -y ripgrep"), 2)
        self.assertIn("sudo apt-get install -y libglu1-mesa", workflow)
        self.assertIn('test "$(/usr/bin/rg --version | head -n 1)" = "ripgrep 13.0.0"', workflow)

    def test_ci_uses_node24_actions(self) -> None:
        workflow = (ROOT / ".github/workflows/bootstrap.yml").read_text()

        self.assertNotIn("actions/checkout@v4", workflow)
        self.assertEqual(workflow.count("actions/checkout@v7"), 4)
        self.assertEqual(workflow.count("actions/setup-node@v7"), 2)
        self.assertIn("actions/setup-python@v7", workflow)
        self.assertIn("actions/upload-artifact@v7", workflow)
        self.assertIn("pnpm/action-setup@v6", workflow)

    def test_meshing_extra_provides_trimesh_boolean_backend(self) -> None:
        pyproject = (ROOT / "packages/fullmag-py/pyproject.toml").read_text()

        self.assertIn('"manifold3d>=3,<4"', pyproject)

    def test_every_tracked_gitlink_has_submodule_metadata(self) -> None:
        gitmodules = (ROOT / ".gitmodules").read_text()

        self.assertIn('[submodule "Codex-Usage"]', gitmodules)
        self.assertIn("path = Codex-Usage", gitmodules)
        self.assertIn("url = https://github.com/MacSteini/Codex-Usage", gitmodules)


if __name__ == "__main__":
    unittest.main()
