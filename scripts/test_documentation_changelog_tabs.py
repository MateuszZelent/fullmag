"""Contract tests for the split GitHub/code and documentation changelog views."""

from __future__ import annotations

from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "public_docs/site/changelog/index.md"
EXTENSION = ROOT / "public_docs/site/_extensions/documentation_changelog.py"
WORKFLOW = ROOT / ".github/workflows/documentation.yml"


def _git_sha(*pathspecs: str) -> str:
    result = subprocess.run(
        [
            "git",
            "log",
            "--first-parent",
            "-1",
            "--format=%H",
            "--",
            *pathspecs,
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return result.stdout.strip()


class DocumentationChangelogTabsContractTests(unittest.TestCase):
    def test_page_declares_two_history_tabs(self) -> None:
        page = PAGE.read_text(encoding="utf-8")
        self.assertIn("documentation-changelog-tabs", page)
        self.assertIn(":documentation-limit: 80", page)
        self.assertIn(":code-limit: 40", page)
        self.assertIn("GitHub / code", page)

    def test_extension_declares_independent_scope_and_timestamp_contracts(self) -> None:
        extension = EXTENSION.read_text(encoding="utf-8")
        for required in (
            "documentation_code_changelog_pathspecs",
            "Latest documentation change",
            "Latest code change",
            "fm-changelog-summary__time",
            "documentation-changelog-tabs",
        ):
            self.assertIn(required, extension)
        self.assertIn(":(exclude)public_docs/site", extension)
        self.assertIn(":(exclude)**/*.md", extension)
        self.assertIn(":(exclude)**/*.rst", extension)

    def test_current_history_scopes_resolve_to_different_commits(self) -> None:
        documentation_sha = _git_sha("public_docs/site")
        code_sha = _git_sha(
            ".",
            ":(exclude)public_docs/site",
            ":(exclude)docs",
            ":(exclude)**/*.md",
            ":(exclude)**/*.rst",
            ":(exclude).github/workflows/documentation.yml",
            ":(exclude).agents/skills/scientific-documentation-contract",
            ":(exclude)packages/fullmag-py/tests/test_public_python_api_documentation.py",
            ":(exclude)packages/fullmag-py/tests/test_public_exchange_documentation.py",
            ":(exclude)packages/fullmag-py/tests/test_material_dmi_units.py",
            ":(exclude)scripts/public_docs_information_architecture.py",
            ":(exclude)scripts/check_public_docs_information_architecture.py",
            ":(exclude)scripts/check_public_doc_examples.py",
        )
        self.assertTrue(documentation_sha)
        self.assertTrue(code_sha)
        self.assertNotEqual(documentation_sha, code_sha)

    def test_workflow_verifies_both_panels_and_directory_report(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("VERSION_CHANGES_URL: https://fullmag.mzelent.pl/version-changes/index.html", workflow)
        for required in (
            "fm-changelog-tab-panel--documentation",
            "fm-changelog-tab-panel--code",
            "Latest documentation change",
            "Latest code change",
            "fm-changelog-summary__time",
            "Automatically generated list of changes",
        ):
            self.assertIn(required, workflow)


if __name__ == "__main__":
    unittest.main()
