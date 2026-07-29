from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from validate_changed_scientific_docs import validate_changed


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


class ChangedScientificDocumentationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.repo = Path(self.temporary.name)
        _git(self.repo, "init", "-q")
        _git(self.repo, "config", "user.name", "FullMag test")
        _git(self.repo, "config", "user.email", "test@fullmag.invalid")
        (self.repo / "public_docs/site/physics").mkdir(parents=True)
        (self.repo / "public_docs/site/physics/index.md").write_text(
            "# Physics\n", encoding="utf-8"
        )
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "base")
        self.base = _git(self.repo, "rev-parse", "HEAD")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_new_scientific_page_requires_adjacent_source_map(self) -> None:
        page = self.repo / "public_docs/site/physics/exchange.md"
        page.write_text("# Exchange\n", encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "add page")

        errors = validate_changed(self.repo, self.base, "HEAD")

        self.assertIn(
            "changed scientific page requires sidecar manifest: "
            "public_docs/site/physics/exchange.source-map.json",
            errors,
        )

    def test_index_page_is_exempt(self) -> None:
        index = self.repo / "public_docs/site/physics/index.md"
        index.write_text("# Updated physics\n", encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "update index")

        self.assertEqual(validate_changed(self.repo, self.base, "HEAD"), [])

    def test_deleted_sidecar_cannot_leave_a_scientific_page_unmapped(self) -> None:
        page = self.repo / "public_docs/site/physics/exchange.md"
        manifest = self.repo / "public_docs/site/physics/exchange.source-map.json"
        page.write_text("# Exchange\n", encoding="utf-8")
        manifest.write_text('{}\n', encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "add mapped page")
        base = _git(self.repo, "rev-parse", "HEAD")
        manifest.unlink()
        _git(self.repo, "add", "-u")
        _git(self.repo, "commit", "-qm", "delete sidecar")

        errors = validate_changed(self.repo, base, "HEAD")

        self.assertIn(
            "scientific page cannot retain a deleted sidecar manifest: "
            "public_docs/site/physics/exchange.source-map.json",
            errors,
        )

    def test_deleted_page_cannot_leave_an_orphan_sidecar(self) -> None:
        page = self.repo / "public_docs/site/physics/exchange.md"
        manifest = self.repo / "public_docs/site/physics/exchange.source-map.json"
        page.write_text("# Exchange\n", encoding="utf-8")
        manifest.write_text('{}\n', encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "add mapped page")
        base = _git(self.repo, "rev-parse", "HEAD")
        page.unlink()
        _git(self.repo, "add", "-u")
        _git(self.repo, "commit", "-qm", "delete page")

        errors = validate_changed(self.repo, base, "HEAD")

        self.assertIn(
            "deleted scientific page left an orphan sidecar manifest: "
            "public_docs/site/physics/exchange.source-map.json",
            errors,
        )


if __name__ == "__main__":
    unittest.main()
