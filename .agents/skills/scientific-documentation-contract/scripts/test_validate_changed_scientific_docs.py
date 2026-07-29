from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import test_validate_scientific_docs as fixture_module
from validate_changed_scientific_docs import validate_all, validate_changed


class ChangedScientificDocumentationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = fixture_module.ScientificDocumentationValidatorTests("runTest")
        self.fixture.setUp()
        self.repo = self.fixture.repo
        self.manifest = self.fixture.manifest
        self.base = self.fixture.revision

    def tearDown(self) -> None:
        self.fixture.tearDown()

    def _write(self, path: str, content: str) -> None:
        self.fixture._write(path, content)

    def _git(self, *args: str) -> str:
        return self.fixture._git(*args)

    def _commit(self, message: str) -> str:
        self._git("add", ".")
        self._git("commit", "-m", message)
        return self._git("rev-parse", "HEAD").strip()

    def test_changed_page_requires_sidecar_manifest(self) -> None:
        self._write("docs/physics/fdm/gpu/new-interaction.md", "# New interaction\n")
        head = self._commit("add scientific page")
        errors = validate_changed(self.repo, self.base, head)
        self.assertTrue(any("requires sidecar manifest" in error for error in errors))

    def test_changed_page_and_valid_sidecar_pass(self) -> None:
        self.manifest["document"]["revision"] = "HEAD"
        self.manifest["sources"][0]["revision"] = "HEAD"
        self.manifest["evidence"][0]["revision"] = "HEAD"
        self.manifest["equations"][0]["semantic_review"]["revision"] = "HEAD"
        self._write(
            "docs/physics/fdm/gpu/demag.source-map.json",
            json.dumps(self.manifest, indent=2) + "\n",
        )
        page = self.repo / "docs/physics/fdm/gpu/demag.md"
        page.write_text(page.read_text(encoding="utf-8") + "\nValidated update.\n", encoding="utf-8")
        head = self._commit("update scientific page with source map")
        self.assertEqual([], validate_changed(self.repo, self.base, head))
        self.assertEqual([], validate_all(self.repo, head))

    def test_sidecar_cannot_point_to_a_different_valid_page(self) -> None:
        self.manifest["document"]["revision"] = "HEAD"
        self.manifest["sources"][0]["revision"] = "HEAD"
        self.manifest["evidence"][0]["revision"] = "HEAD"
        self.manifest["equations"][0]["semantic_review"]["revision"] = "HEAD"
        self._write(
            "docs/physics/fdm/gpu/unrelated.source-map.json",
            json.dumps(self.manifest, indent=2) + "\n",
        )
        self._write("docs/physics/fdm/gpu/unrelated.md", "# Unrelated\n")
        head = self._commit("add mismatched sidecar")
        errors = validate_changed(self.repo, self.base, head)
        self.assertTrue(any("document.path must equal adjacent page" in error for error in errors))

    def test_deleted_sidecar_is_rejected_while_page_remains(self) -> None:
        self._write("docs/physics/fdm/gpu/demag.source-map.json", "{}\n")
        with_manifest = self._commit("add sidecar")
        (self.repo / "docs/physics/fdm/gpu/demag.source-map.json").unlink()
        head = self._commit("delete sidecar")
        errors = validate_changed(self.repo, with_manifest, head)
        self.assertTrue(any("cannot retain a deleted sidecar" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
