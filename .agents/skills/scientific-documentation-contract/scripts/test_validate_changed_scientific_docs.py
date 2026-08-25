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

    def _write_architecture_manifest(self) -> tuple[Path, str]:
        page_path = "public_docs/site/physics/solvers/fdm/cpu/exchange.md"
        scripts = self.repo / "scripts"
        scripts.mkdir()
        (scripts / "public_docs_information_architecture.py").write_text(
            """from dataclasses import dataclass
from pathlib import Path

@dataclass(frozen=True)
class PageSpec:
    path: str
    title: str
    label: str
    status: str
    doc_kind: str
    scope: str
    children: tuple[str, ...] = ()

PAGE_SPECS = (
    PageSpec(
        \"physics/solvers/fdm/cpu/exchange.md\",
        \"Exchange\",
        \"public-docs-physics-solvers-fdm-cpu-exchange\",
        \"planned\",
        \"scaffold\",
        \"FDM CPU exchange\",
    ),
)

def render_page(spec: PageSpec, root: Path) -> str:
    return (
        \"---\\n\"
        f\"title: {spec.title}\\n\"
        f\"status: {spec.status}\\n\"
        f\"doc_kind: {spec.doc_kind}\\n\"
        \"audience: user\\n\"
        \"owner: fullmag-public-docs\\n\"
        \"---\\n\\n\"
        f\"({spec.label})=\\n\"
        f\"# {spec.title}\\n\\n\"
        f\"This page reserves the public documentation location for {spec.scope}.\\n\"
    )
""",
            encoding="utf-8",
        )
        page = self.repo / page_path
        page.parent.mkdir(parents=True)
        return page, page_path

    def _render_registered_scaffold(self) -> tuple[Path, str]:
        page, page_path = self._write_architecture_manifest()
        page.write_text(
            """---
title: Exchange
status: planned
doc_kind: scaffold
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-solvers-fdm-cpu-exchange)=
# Exchange

This page reserves the public documentation location for FDM CPU exchange.
""",
            encoding="utf-8",
        )
        return page, page_path

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

    def test_registered_canonical_scaffold_does_not_require_source_map(self) -> None:
        self._render_registered_scaffold()
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "add canonical scaffold")

        self.assertEqual(validate_changed(self.repo, self.base, "HEAD"), [])

    def test_unregistered_planned_page_still_requires_source_map(self) -> None:
        self._write_architecture_manifest()
        page = self.repo / "public_docs/site/physics/unregistered.md"
        page.write_text("---\nstatus: planned\n---\n\n# Unregistered\n", encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "add unregistered planned page")

        errors = validate_changed(self.repo, self.base, "HEAD")

        self.assertIn(
            "changed scientific page requires sidecar manifest: "
            "public_docs/site/physics/unregistered.source-map.json",
            errors,
        )

    def test_registered_scaffold_with_scientific_content_requires_source_map(self) -> None:
        page, page_path = self._render_registered_scaffold()
        page.write_text(page.read_text(encoding="utf-8") + "\\[E = A |\\nabla m|^2\\]\n")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "modify scaffold content")

        errors = validate_changed(self.repo, self.base, "HEAD")

        self.assertIn(
            f"changed scientific page requires sidecar manifest: "
            f"{page_path.removesuffix('.md')}.source-map.json",
            errors,
        )

    def test_changed_generator_cannot_approve_arbitrary_scaffold_content(self) -> None:
        page, page_path = self._render_registered_scaffold()
        generator = self.repo / "scripts/public_docs_information_architecture.py"
        generator.write_text(
            generator.read_text(encoding="utf-8").replace(
                'f"This page reserves the public documentation location for {spec.scope}.\\n"',
                '"The exchange field is exactly H = 2 A laplacian(m).\\n"',
            ),
            encoding="utf-8",
        )
        page.write_text(
            page.read_text(encoding="utf-8").replace(
                "This page reserves the public documentation location for FDM CPU exchange.",
                "The exchange field is exactly H = 2 A laplacian(m).",
            ),
            encoding="utf-8",
        )
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "change generator and scaffold together")

        errors = validate_changed(self.repo, self.base, "HEAD")

        self.assertIn(
            f"changed scientific page requires sidecar manifest: "
            f"{page_path.removesuffix('.md')}.source-map.json",
            errors,
        )

    def test_registered_scaffold_with_changed_status_requires_source_map(self) -> None:
        page, page_path = self._render_registered_scaffold()
        page.write_text(page.read_text(encoding="utf-8").replace("status: planned", "status: implemented"))
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "change scaffold status")

        errors = validate_changed(self.repo, self.base, "HEAD")

        self.assertIn(
            f"changed scientific page requires sidecar manifest: "
            f"{page_path.removesuffix('.md')}.source-map.json",
            errors,
        )

    def test_index_page_is_exempt(self) -> None:
        index = self.repo / "public_docs/site/physics/index.md"
        index.write_text("# Updated physics\n", encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "update index")

        self.assertEqual(validate_changed(self.repo, self.base, "HEAD"), [])

    def test_changed_numerical_method_page_requires_adjacent_source_map(self) -> None:
        page = self.repo / "public_docs/site/numerical-methods/meshing/example.md"
        page.parent.mkdir(parents=True)
        page.write_text("# Mesh example\n", encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "add numerical method page")

        errors = validate_changed(self.repo, self.base, "HEAD")

        self.assertIn(
            "changed scientific page requires sidecar manifest: "
            "public_docs/site/numerical-methods/meshing/example.source-map.json",
            errors,
        )

    def test_numerical_method_source_map_checks_pinned_symbol(self) -> None:
        page = self.repo / "public_docs/site/numerical-methods/meshing/example.md"
        page.parent.mkdir(parents=True)
        page.write_text("# Mesh example\n", encoding="utf-8")
        source = self.repo / "src/example.py"
        source.parent.mkdir()
        source.write_text("def build_mesh():\n    return None\n", encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "add numerical method page and source")
        revision = _git(self.repo, "rev-parse", "HEAD")
        manifest = page.with_suffix(".source-map.json")
        manifest.write_text(
            "{\n"
            f'  "document": {{"path": "public_docs/site/numerical-methods/meshing/example.md", '
            f'"reviewed_revision": "{revision}"}},\n'
            '  "sources": [{"id": "mesh", "path": "src/example.py", '
            '"symbol": "build_mesh", "responsibility": "mesh construction"}]\n'
            "}\n",
            encoding="utf-8",
        )
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "map numerical method source")

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
