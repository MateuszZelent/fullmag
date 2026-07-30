from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parents[1] / "public_docs/site/_extensions"))

import public_docs_information_architecture as information_architecture
import legacy_redirects

from public_docs_information_architecture import (
    INTERACTION_SLUGS,
    PAGE_SPECS,
    PUBLIC_DOCS_ROOT,
    PageSpec,
    check_pages,
    render_page,
    validate_tree,
    write_pages,
)


class PublicDocumentationInformationArchitectureTests(unittest.TestCase):
    DEMAGNETIZATION_SUBPAGES = (
        "mathematical-formulation",
        "boundary-conditions",
        "fdm-convolution",
        "fem-poisson-airbox",
        "fem-bem",
        "periodic-demag",
        "validation",
    )
    DMI_SUBPAGES = (
        "interfacial",
        "bulk",
        "boundary-conditions",
        "validation",
    )

    def test_page_spec_accepts_doc_kind_after_status(self) -> None:
        spec = PageSpec("guide.md", "Guide", "guide", "planned", "scaffold", "guidance")
        self.assertEqual(spec.doc_kind, "scaffold")
        self.assertEqual(spec.scope, "guidance")

    def test_python_api_is_a_top_level_family(self) -> None:
        root = next(spec for spec in PAGE_SPECS if spec.path == "index.md")
        self.assertIn("python-api/index.md", root.children)

    def test_each_approved_interaction_has_one_canonical_owner(self) -> None:
        specs_by_path = {spec.path: spec for spec in PAGE_SPECS}
        self.assertIn("physics/interactions/index.md", specs_by_path)
        interactions = specs_by_path["physics/interactions/index.md"]
        self.assertEqual(
            interactions.children,
            tuple(f"physics/interactions/{slug}/index.md" for slug in INTERACTION_SLUGS),
        )
        for child in interactions.children:
            self.assertEqual(sum(spec.path == child for spec in PAGE_SPECS), 1)

    def test_demagnetization_and_dmi_have_approved_subtrees(self) -> None:
        for slug, subpages in (
            ("demagnetization", self.DEMAGNETIZATION_SUBPAGES),
            ("dmi", self.DMI_SUBPAGES),
        ):
            path = f"physics/interactions/{slug}/index.md"
            specs_by_path = {spec.path: spec for spec in PAGE_SPECS}
            self.assertIn(path, specs_by_path)
            index = specs_by_path[path]
            self.assertEqual(
                index.children,
                tuple(
                    f"physics/interactions/{slug}/{subpage}.md"
                    for subpage in subpages
                ),
            )

    def test_backend_specific_paths_do_not_own_interactions(self) -> None:
        backend_interaction_paths = [
            spec.path
            for spec in PAGE_SPECS
            if spec.path.startswith("physics/solvers/")
            and "/interactions/" in spec.path
        ]
        self.assertEqual(backend_interaction_paths, [])

    def test_every_legacy_backend_interaction_url_has_a_canonical_redirect(self) -> None:
        self.assertTrue(hasattr(information_architecture, "LEGACY_INTERACTION_REDIRECTS"))
        redirects = information_architecture.LEGACY_INTERACTION_REDIRECTS
        self.assertEqual(len(redirects), 4 * 14)
        for source, target in redirects.items():
            self.assertRegex(
                source,
                r"^physics/solvers/(fdm|fem)/(cpu|gpu)/interactions/.+\.md$",
            )
            self.assertTrue(target.startswith("physics/interactions/"))
            self.assertIn(target, {spec.path for spec in PAGE_SPECS})

    def test_deployed_redirects_match_manifest_and_cover_retired_indexes(self) -> None:
        expected = {
            source.removesuffix(".md") + ".html":
                target.removesuffix(".md") + ".html"
            for source, target in information_architecture.LEGACY_REDIRECTS.items()
        }
        expected["physics/exchange.html"] = (
            "physics/interactions/exchange/index.html"
        )
        self.assertEqual(legacy_redirects._redirects(), expected)
        self.assertEqual(len(expected), 68)
        for path in (
            "physics/solvers/index.html",
            "physics/solvers/fdm/index.html",
            "physics/solvers/fdm/cpu/index.html",
            "physics/solvers/fdm/cpu/interactions/index.html",
        ):
            self.assertEqual(expected[path], "physics/interactions/index.html")

    def test_root_navigation_depth_exposes_interaction_subtrees(self) -> None:
        root = next(spec for spec in PAGE_SPECS if spec.path == "index.md")
        self.assertTrue(hasattr(root, "navigation_maxdepth"))
        self.assertGreaterEqual(root.navigation_maxdepth, 4)

    def test_manifest_has_unique_paths_labels_and_valid_statuses(self) -> None:
        self.assertEqual(validate_tree(PAGE_SPECS), [])

    def test_manifest_uses_only_canonical_document_kinds(self) -> None:
        self.assertEqual(
            {spec.doc_kind for spec in PAGE_SPECS}, {"reference", "scaffold"}
        )
        existing_exchange = next(
            spec
            for spec in PAGE_SPECS
            if spec.path == "physics/interactions/exchange/index.md"
        )
        self.assertEqual(existing_exchange.doc_kind, "reference")
        self.assertEqual(existing_exchange.label, "public-docs-physics-exchange")

    def test_terminal_interaction_scaffold_uses_the_canonical_shape(self) -> None:
        exchange = next(
            spec
            for spec in PAGE_SPECS
            if spec.path == "physics/interactions/zeeman/index.md"
        )
        self.assertEqual(
            render_page(exchange, Path("public_docs/site")),
            """---
title: Zeeman
status: planned
doc_kind: scaffold
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-zeeman-root)=
# Zeeman

This page reserves the public documentation location for the canonical Zeeman interaction reference.
""",
        )

    def test_index_scaffold_links_to_every_direct_child(self) -> None:
        index = next(spec for spec in PAGE_SPECS if spec.path == "python-api/index.md")
        rendered = render_page(index, Path("public_docs/site"))
        self.assertIn("```{toctree}\n:maxdepth: 1\n", rendered)
        for child in index.children:
            relative = Path(child).relative_to(Path(index.path).parent)
            self.assertIn(str(relative.with_suffix("")), rendered)

    def test_scaffold_renders_declared_navigation_depth(self) -> None:
        index = PageSpec(
            "index.md",
            "Root",
            "root",
            "planned",
            "scaffold",
            "the documentation root",
            ("physics/index.md",),
            4,
        )
        rendered = render_page(index, Path("public_docs/site"))
        self.assertIn("```{toctree}\n:maxdepth: 4\n", rendered)

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

    def test_reference_navigation_requires_a_myst_toctree(self) -> None:
        child = PageSpec("child.md", "Child", "child", "partial", "reference", "child")
        parent = PageSpec(
            "index.md", "Parent", "parent", "partial", "reference", "parent", ("child.md",)
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            (root / "child.md").write_text(
                "---\ntitle: Child\nstatus: partial\ndoc_kind: reference\n---\n\n(child)=\n# Child\n"
            )
            (root / "index.md").write_text(
                "---\ntitle: Parent\nstatus: partial\ndoc_kind: reference\n---\n\n(parent)=\n"
                "# Parent\n\nThe child.md page is discussed here.\n"
            )
            self.assertIn(
                "reference navigation does not match manifest: index.md",
                check_pages((parent, child), root),
            )

    def test_reference_navigation_accepts_declared_toctree_entries(self) -> None:
        child = PageSpec("child.md", "Child", "child", "partial", "reference", "child")
        parent = PageSpec(
            "index.md", "Parent", "parent", "partial", "reference", "parent", ("child.md",)
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            (root / "child.md").write_text(
                "---\ntitle: Child\nstatus: partial\ndoc_kind: reference\n---\n\n(child)=\n# Child\n"
            )
            (root / "index.md").write_text(
                "---\ntitle: Parent\nstatus: partial\ndoc_kind: reference\n---\n\n(parent)=\n# Parent\n\n"
                "```{toctree}\n:maxdepth: 1\n\nchild\n```\n"
            )
            self.assertEqual(check_pages((parent, child), root), [])

    def test_reference_navigation_rejects_extra_entries(self) -> None:
        child = PageSpec("child.md", "Child", "child", "partial", "reference", "child")
        parent = PageSpec(
            "index.md", "Parent", "parent", "partial", "reference", "parent", ("child.md",)
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            (root / "child.md").write_text(
                "---\ntitle: Child\nstatus: partial\ndoc_kind: reference\n---\n\n(child)=\n# Child\n"
            )
            (root / "index.md").write_text(
                "---\ntitle: Parent\nstatus: partial\ndoc_kind: reference\n---\n\n(parent)=\n# Parent\n\n"
                "```{toctree}\n:maxdepth: 1\n\nchild\nextra\n```\n"
            )
            self.assertIn(
                "reference navigation does not match manifest: index.md",
                check_pages((parent, child), root),
            )

    def test_reference_navigation_rejects_duplicates_and_wrong_order(self) -> None:
        first = PageSpec("first.md", "First", "first", "partial", "reference", "first")
        second = PageSpec("second.md", "Second", "second", "partial", "reference", "second")
        parent = PageSpec(
            "index.md",
            "Parent",
            "parent",
            "partial",
            "reference",
            "parent",
            ("first.md", "second.md"),
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            for spec in (first, second):
                (root / spec.path).write_text(
                    f"---\ntitle: {spec.title}\nstatus: partial\ndoc_kind: reference\n---\n\n"
                    f"({spec.label})=\n# {spec.title}\n"
                )
            (root / "index.md").write_text(
                "---\ntitle: Parent\nstatus: partial\ndoc_kind: reference\n---\n\n(parent)=\n# Parent\n\n"
                "```{toctree}\n:maxdepth: 1\n\nsecond\nfirst\nfirst\n```\n"
            )
            self.assertIn(
                "reference navigation does not match manifest: index.md",
                check_pages((parent, first, second), root),
            )

    def test_reference_requires_complete_canonical_front_matter(self) -> None:
        spec = PageSpec("guide.md", "Guide", "guide", "partial", "reference", "guide")
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            (root / "guide.md").write_text(
                "---\ntitle: Guide\nstatus: partial\n---\n\n(guide)=\n# Guide\n"
            )
            self.assertIn(
                "reference metadata 'doc_kind' does not match manifest: guide.md",
                check_pages((spec,), root),
            )

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
