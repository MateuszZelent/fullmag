import configparser
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]


def _workflow_uses(workflow: str) -> list[str]:
    references: list[str] = []
    for line in workflow.splitlines():
        stripped = line.strip().removeprefix("-").strip()
        key, separator, value = stripped.partition(":")
        if not separator or key.strip().strip("'\"") != "uses":
            continue
        reference = value.strip().strip("'\"")
        if reference:
            references.append(reference)
    return references


def _assert_required_action_version(
    workflow: str,
    action: str,
    expected_reference: str,
) -> None:
    references = [
        reference
        for reference in _workflow_uses(workflow)
        if reference.partition("@")[0] == action
    ]
    if not references:
        raise AssertionError(f"workflow does not use required action {action}")
    stale = [reference for reference in references if reference != expected_reference]
    if stale:
        raise AssertionError(
            f"{action} must use {expected_reference}; found {stale}"
        )


def _submodule_urls_by_path(gitmodules: str) -> dict[str, str]:
    parser = configparser.ConfigParser(interpolation=None, strict=True)
    parser.read_string(gitmodules)
    records: dict[str, str] = {}
    for section in parser.sections():
        if not section.startswith('submodule "'):
            continue
        path = parser.get(section, "path", fallback="").strip()
        if not path:
            raise AssertionError(f"{section} must define a nonempty path")
        url = parser.get(section, "url", fallback="").strip()
        if not url:
            raise AssertionError(f"{path} must define a nonempty url")
        if path in records:
            raise AssertionError(f"duplicate submodule path {path}")
        records[path] = url
    return records


class BootstrapWorkflowContractTests(unittest.TestCase):
    def test_action_version_contract_reads_uses_instead_of_step_names(self) -> None:
        workflow = """
jobs:
  test:
    steps:
      - name: Clone sources
        uses: actions/checkout@v6
"""

        with self.assertRaisesRegex(
            AssertionError,
            r"actions/checkout.*actions/checkout@v7",
        ):
            _assert_required_action_version(
                workflow,
                "actions/checkout",
                "actions/checkout@v7",
            )

    def test_action_version_contract_reads_unnamed_action_steps(self) -> None:
        workflow = """
jobs:
  test:
    steps:
      - uses: actions/checkout@v7
      - uses: actions/checkout@v6
"""

        with self.assertRaisesRegex(
            AssertionError,
            r"actions/checkout.*actions/checkout@v7.*actions/checkout@v6",
        ):
            _assert_required_action_version(
                workflow,
                "actions/checkout",
                "actions/checkout@v7",
            )

    def test_action_version_contract_accepts_whitespace_before_yaml_separator(self) -> None:
        workflow = """
jobs:
  test:
    steps:
      - uses : actions/checkout@v6
"""

        with self.assertRaisesRegex(
            AssertionError,
            r"actions/checkout.*actions/checkout@v7.*actions/checkout@v6",
        ):
            _assert_required_action_version(
                workflow,
                "actions/checkout",
                "actions/checkout@v7",
            )

    def test_submodule_metadata_requires_nonempty_url(self) -> None:
        gitmodules = """
[submodule "external_solvers/example"]
    path = external_solvers/example
"""

        with self.assertRaisesRegex(
            AssertionError,
            r"external_solvers/example.*nonempty url",
        ):
            _submodule_urls_by_path(gitmodules)

    def test_submodule_metadata_rejects_duplicate_paths(self) -> None:
        gitmodules = """
[submodule "first"]
    path = external_solvers/example
    url = https://example.test/first
[submodule "second"]
    path = external_solvers/example
    url = https://example.test/second
"""

        with self.assertRaisesRegex(
            AssertionError,
            r"duplicate submodule path external_solvers/example",
        ):
            _submodule_urls_by_path(gitmodules)

    def test_ci_installs_native_tools_before_contract_checks(self) -> None:
        workflow = (ROOT / ".github/workflows/bootstrap.yml").read_text()

        self.assertEqual(workflow.count("sudo apt-get install -y ripgrep"), 1)
        self.assertIn("sudo apt-get install -y libglu1-mesa", workflow)
        self.assertIn('test "$(/usr/bin/rg --version | head -n 1)" = "ripgrep 13.0.0"', workflow)

    def test_ci_uses_node24_actions(self) -> None:
        workflow = (ROOT / ".github/workflows/bootstrap.yml").read_text()

        required = {
            "actions/checkout": "actions/checkout@v7",
            "actions/setup-node": "actions/setup-node@v7",
            "actions/setup-python": "actions/setup-python@v7",
            "actions/upload-artifact": "actions/upload-artifact@v7",
            "pnpm/action-setup": "pnpm/action-setup@v6",
        }
        for action, expected_reference in required.items():
            with self.subTest(action=action):
                _assert_required_action_version(workflow, action, expected_reference)

    def test_rust_contracts_install_python_runtime_dependencies(self) -> None:
        workflow = (ROOT / ".github/workflows/bootstrap.yml").read_text()
        rust_job = workflow.split("  rust-contracts:\n", 1)[1].split(
            "\n  generated-api-determinism:", 1
        )[0]

        self.assertIn("uses: actions/setup-python@v7", rust_job)
        install = "python -m pip install -e packages/fullmag-py"
        run = "./scripts/ci/run_frontend3d_required_gate.sh rust-quantity-api-cli-contracts"
        self.assertIn(install, rust_job)
        self.assertLess(rust_job.index(install), rust_job.index(run))

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
        metadata = _submodule_urls_by_path(gitmodules)
        self.assertEqual(
            set(metadata),
            set(gitlinks),
            "tracked gitlinks and complete .gitmodules records must match exactly",
        )


if __name__ == "__main__":
    unittest.main()
