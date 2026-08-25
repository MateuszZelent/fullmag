from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parents[1] / "public_docs/site/_extensions"))

import public_docs_information_architecture_v2 as information_architecture
import legacy_redirects
from check_public_docs_information_architecture import _front_matter_status

from public_docs_information_architecture_v2 import (
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
    def test_top_level_is_ownership_oriented(self) -> None:
        root = next(spec for spec in PAGE_SPECS if spec.path == "index.md")
        self.assertEqual(
            root.children,
            (
                "getting-started/index.md",
                "frontend/index.md",
                "backend/index.md",
                "python-api/index.md",
                "validation/index.md",
            ),
        )
        self.assertGreaterEqual(root.navigation_maxdepth, 4)

    def test_frontend_backend_and_python_are_distinct_families(self) -> None:
        pages = {spec.path: spec for spec in PAGE_SPECS}
        self.assertIn("frontend/index.md", pages)
        self.assertIn("backend/index.md", pages)
        self.assertIn("python-api/index.md", pages)
        self.assertNotIn("physics/index.md", pages["index.md"].children)
        self.assertIn("physics/index.md", pages["backend/index.md"].children)
        self.assertIn("numerical-methods/meshing/index.md", pages["backend/index.md"].children)

    def test_python_meshing_splits_fdm_and_fem(self) -> None:
        pages = {spec.path: spec for spec in PAGE_SPECS}
        self.assertEqual(
            pages["python-api/meshing/index.md"].children,
            (
                "python-api/meshing/fdm/index.md",
                "python-api/meshing/fem/index.md",
            ),
        )
        fem = pages["python-api/meshing/fem/index.md"]
        self.assertIn("python-api/meshing/fem/ferromagnet/index.md", fem.children)
        self.assertIn("python-api/meshing/fem/airbox/index.md", fem.children)

    def test_fem_modes_are_individual_modules(self) -> None:
        pages = {spec.path: spec for spec in PAGE_SPECS}
        backend_modes = pages[
            "numerical-methods/meshing/fem/ferromagnet/index.md"
        ].children
        for suffix in (
            "free-tetrahedral.md",
            "thin-film-tetrahedral.md",
            "swept-prism.md",
            "swept-hex.md",
            "boundary-layers.md",
            "imported-mesh.md",
            "mixed-elements.md",
        ):
            self.assertTrue(any(path.endswith(suffix) for path in backend_modes), suffix)

    def test_airbox_and_ferromagnet_are_separate_backend_branches(self) -> None:
        pages = {spec.path: spec for spec in PAGE_SPECS}
        fem = pages["numerical-methods/meshing/fem/index.md"]
        self.assertEqual(
            fem.children,
            (
                "numerical-methods/meshing/fem/shared-domain/index.md",
                "numerical-methods/meshing/fem/ferromagnet/index.md",
                "numerical-methods/meshing/fem/airbox/index.md",
            ),
        )

    def test_each_approved_interaction_has_one_canonical_owner(self) -> None:
        pages = {spec.path: spec for spec in PAGE_SPECS}
        interactions = pages["physics/interactions/index.md"]
        self.assertEqual(
            interactions.children,
            tuple(f"physics/interactions/{slug}/index.md" for slug in INTERACTION_SLUGS),
        )
        for child in interactions.children:
            self.assertEqual(sum(spec.path == child for spec in PAGE_SPECS), 1)

    def test_backend_specific_paths_do_not_own_interactions(self) -> None:
        backend_interaction_paths = [
            spec.path
            for spec in PAGE_SPECS
            if spec.path.startswith("physics/solvers/")
            and "/interactions/" in spec.path
        ]
        self.assertEqual(backend_interaction_paths, [])

    def test_deployed_redirects_match_manifest(self) -> None:
        expected = {
            source.removesuffix(".md") + ".html":
                target.removesuffix(".md") + ".html"
            for source, target in information_architecture.LEGACY_REDIRECTS.items()
        }
        expected["physics/exchange.html"] = (
            "physics/interactions/exchange/index.html"
        )
        self.assertEqual(legacy_redirects._redirects(), expected)

    def test_manifest_has_unique_paths_labels_and_valid_statuses(self) -> None:
        self.assertEqual(validate_tree(PAGE_SPECS), [])

    def test_index_navigation_links_to_every_direct_child(self) -> None:
        for index_path in (
            "index.md",
            "frontend/index.md",
            "backend/index.md",
            "python-api/index.md",
            "python-api/meshing/index.md",
            "numerical-methods/meshing/index.md",
        ):
            index = next(spec for spec in PAGE_SPECS if spec.path == index_path)
            text = (PUBLIC_DOCS_ROOT / index.path).read_text(encoding="utf-8")
            for child in index.children:
                relative = Path(child).relative_to(Path(index.path).parent) if Path(child).is_relative_to(Path(index.path).parent) else Path(
                    __import__("os").path.relpath(Path(child), Path(index.path).parent)
                )
                self.assertIn(relative.with_suffix("").as_posix(), text)

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

    def test_reference_front_matter_accepts_quoted_yaml_scalars(self) -> None:
        spec = PageSpec(
            path="guide.md",
            title="Quoted guide",
            label="quoted-guide",
            status="implemented",
            doc_kind="reference",
            scope="quoted YAML metadata",
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            (root / spec.path).write_text(
                '---\ntitle: "Quoted guide"\nstatus: implemented\n'
                'doc_kind: reference\n---\n\n(quoted-guide)=\n# Quoted guide\n',
                encoding="utf-8",
            )
            self.assertEqual(check_pages((spec,), root), [])

    def test_effective_status_normalizes_quoted_yaml_scalar(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "guide.md"
            path.write_text('---\nstatus: "implemented"\n---\n', encoding="utf-8")
            self.assertEqual(_front_matter_status(path), "implemented")

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

    def test_every_manifest_page_exists(self) -> None:
        missing = [
            spec.path
            for spec in PAGE_SPECS
            if not (PUBLIC_DOCS_ROOT / spec.path).is_file()
        ]
        self.maxDiff = None
        self.assertEqual(missing, [])

if __name__ == "__main__":
    unittest.main()
