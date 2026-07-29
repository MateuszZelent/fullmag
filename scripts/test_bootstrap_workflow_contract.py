from pathlib import Path
import json
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
        self.assertIn(
            "pnpm --dir apps/control-room exec playwright install --with-deps chromium",
            workflow,
        )

    def test_meshing_extra_provides_trimesh_boolean_backend(self) -> None:
        pyproject = (ROOT / "packages/fullmag-py/pyproject.toml").read_text()

        self.assertIn('"manifold3d>=3,<4"', pyproject)

    def test_control_room_declares_playwright_for_browser_audits(self) -> None:
        package = json.loads((ROOT / "apps/control-room/package.json").read_text())

        self.assertEqual(package["devDependencies"]["playwright"], "1.62.0")

    def test_fem_browser_fixture_honors_chunked_topology_ranges(self) -> None:
        audit = (
            ROOT
            / "apps/control-room/scripts/audit-viewport-3d-fem-topology-uploads.mjs"
        ).read_text()

        self.assertIn('route.request().headers().range', audit)
        self.assertIn('"content-range": `bytes ${start}-${end}/${body.byteLength}`', audit)
        self.assertIn('etag: \'"fem-topology-fixture"\'', audit)
        self.assertIn('status: 206', audit)
        self.assertNotIn(
            'const expectedNodeIds = new Set([\n    "model:airbox",',
            audit,
        )
        self.assertIn(r"/carrier:mesh-parts\/[1-9]\d*/", audit)

    def test_every_tracked_gitlink_has_submodule_metadata(self) -> None:
        gitmodules = (ROOT / ".gitmodules").read_text()

        self.assertIn('[submodule "Codex-Usage"]', gitmodules)
        self.assertIn("path = Codex-Usage", gitmodules)
        self.assertIn("url = https://github.com/MacSteini/Codex-Usage", gitmodules)


if __name__ == "__main__":
    unittest.main()
