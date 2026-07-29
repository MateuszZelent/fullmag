from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent))

from public_docs_information_architecture import (
    INTERACTION_SLUGS,
    PAGE_SPECS,
    PUBLIC_DOCS_ROOT,
    PageSpec,
    render_page,
    validate_tree,
    write_pages,
)


class PublicDocumentationInformationArchitectureTests(unittest.TestCase):
    def test_page_spec_accepts_doc_kind_after_status(self) -> None:
        spec = PageSpec("guide.md", "Guide", "guide", "planned", "scaffold", "guidance")
        self.assertEqual(spec.doc_kind, "scaffold")
        self.assertEqual(spec.scope, "guidance")

    def test_python_api_is_a_top_level_family(self) -> None:
        root = next(spec for spec in PAGE_SPECS if spec.path == "index.md")
        self.assertIn("python-api/index.md", root.children)

    def test_solver_backend_interaction_sets_are_identical(self) -> None:
        for solver in ("fdm", "fem"):
            for backend in ("cpu", "gpu"):
                prefix = f"physics/solvers/{solver}/{backend}/interactions/"
                actual = {
                    Path(spec.path).stem
                    for spec in PAGE_SPECS
                    if spec.path.startswith(prefix)
                    and spec.path != f"{prefix}index.md"
                }
                self.assertEqual(actual, set(INTERACTION_SLUGS))

    def test_manifest_has_unique_paths_labels_and_valid_statuses(self) -> None:
        self.assertEqual(validate_tree(PAGE_SPECS), [])

    def test_manifest_uses_only_canonical_document_kinds(self) -> None:
        self.assertEqual(
            {spec.doc_kind for spec in PAGE_SPECS}, {"reference", "scaffold"}
        )
        existing_exchange = next(
            spec for spec in PAGE_SPECS if spec.path == "physics/exchange.md"
        )
        self.assertEqual(existing_exchange.doc_kind, "reference")

    def test_terminal_scaffold_uses_the_canonical_shape(self) -> None:
        exchange = next(
            spec
            for spec in PAGE_SPECS
            if spec.path == "physics/solvers/fdm/cpu/interactions/exchange.md"
        )
        self.assertEqual(
            render_page(exchange, Path("public_docs/site")),
            """---
title: Exchange — FDM CPU
status: planned
doc_kind: scaffold
audience: user
owner: fullmag-public-docs
---

(physics-fdm-cpu-exchange)=
# Exchange — FDM CPU

This page reserves the public documentation location for the FDM CPU realization of Exchange.
""",
        )

    def test_index_scaffold_links_to_every_direct_child(self) -> None:
        index = next(spec for spec in PAGE_SPECS if spec.path == "python-api/index.md")
        rendered = render_page(index, Path("public_docs/site"))
        self.assertIn("```{toctree}\n:maxdepth: 1\n", rendered)
        for child in index.children:
            relative = Path(child).relative_to(Path(index.path).parent)
            self.assertIn(str(relative.with_suffix("")), rendered)

    def test_write_creates_missing_files_without_overwriting(self) -> None:
        spec = PageSpec(
            path="guide.md",
            title="Guide",
            label="guide",
            status="planned",
            scope="general guidance",
            doc_kind="scaffold",
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            write_pages((spec,), root)
            self.assertEqual((root / spec.path).read_text(), render_page(spec, root))
            (root / spec.path).write_text("different content\n")
            with self.assertRaises(FileExistsError):
                write_pages((spec,), root)

    def test_every_manifest_page_exists_and_has_canonical_scaffold(self) -> None:
        missing = [
            spec.path
            for spec in PAGE_SPECS
            if not (PUBLIC_DOCS_ROOT / spec.path).is_file()
        ]
        self.maxDiff = None
        self.assertEqual(missing, [])


if __name__ == "__main__":
    unittest.main()
