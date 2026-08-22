from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parents[1] / "public_docs/site/_extensions"))

import public_docs_information_architecture_v2 as information_architecture
import legacy_redirects

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
    DEMAGNETIZATION_SUBPAGES = (
        "mathematical-formulation",
        "boundary-conditions",
        "fdm-convolution",
        "multilayer-convolution",
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

    @staticmethod
    def pages() -> dict[str, PageSpec]:
        return {spec.path: spec for spec in PAGE_SPECS}

    def test_page_spec_accepts_doc_kind_after_status(self) -> None:
        spec = PageSpec("guide.md", "Guide", "guide", "planned", "scaffold", "guidance")
        self.assertEqual(spec.doc_kind, "scaffold")
        self.assertEqual(spec.scope, "guidance")

    def test_root_has_three_owner_oriented_documentation_families(self) -> None:
        root = self.pages()["index.md"]
        self.assertEqual(root.children[:4], (
            "getting-started/index.md",
            "frontend/index.md",
            "python-api/index.md",
            "backend/index.md",
        ))
        self.assertIn("physics/index.md", root.children)
        self.assertIn("validation/index.md", root.children)
        self.assertNotIn("architecture/index.md", root.children)
        self.assertNotIn("numerical-methods/index.md", root.children)

    def test_backend_owns_numerical_methods_and_architecture(self) -> None:
        backend = self.pages()["backend/index.md"]
        self.assertEqual(backend.children, (
            "backend/meshing/index.md",
            "numerical-methods/index.md",
            "architecture/index.md",
        ))

    def test_python_api_has_a_first_class_meshing_branch(self) -> None:
        python_api = self.pages()["python-api/index.md"]
        self.assertIn("python-api/meshing/index.md", python_api.children)
        self.assertLess(
            python_api.children.index("python-api/meshing/index.md"),
            python_api.children.index("python-api/discretization/index.md"),
        )
        meshing = self.pages()["python-api/meshing/index.md"]
        self.assertEqual(meshing.children, (
            "python-api/meshing/fdm/index.md",
            "python-api/meshing/fem/index.md",
            "python-api/meshing/shared-controls.md",
        ))

    def test_python_fem_meshing_separates_ferromagnet_and_airbox(self) -> None:
        fem = self.pages()["python-api/meshing/fem/index.md"]
        self.assertIn("python-api/meshing/fem/ferromagnet/index.md", fem.children)
        self.assertIn("python-api/meshing/fem/airbox/index.md", fem.children)
        ferromagnet = self.pages()["python-api/meshing/fem/ferromagnet/index.md"]
        self.assertEqual(ferromagnet.children, (
            "python-api/meshing/fem/ferromagnet/tetrahedral.md",
            "python-api/meshing/fem/ferromagnet/thin-film.md",
            "python-api/meshing/fem/ferromagnet/swept-prism.md",
            "python-api/meshing/fem/ferromagnet/swept-hex.md",
            "python-api/meshing/fem/ferromagnet/boundary-layers.md",
            "python-api/meshing/fem/ferromagnet/imported-mesh.md",
            "python-api/meshing/fem/ferromagnet/refinement.md",
        ))

    def test_backend_fem_meshing_separates_shared_domain_body_and_airbox(self) -> None:
        fem = self.pages()["backend/meshing/fem/index.md"]
        self.assertEqual(fem.children, (
            "backend/meshing/fem/shared-domain/index.md",
            "backend/meshing/fem/ferromagnet/index.md",
            "backend/meshing/fem/airbox/index.md",
            "backend/meshing/fem/quality-and-provenance.md",
        ))

    def test_frontend_control_room_has_lane_specific_meshing_pages(self) -> None:
        meshing = self.pages()["frontend/control-room/meshing/index.md"]
        self.assertEqual(meshing.children, (
            "frontend/control-room/meshing/fdm.md",
            "frontend/control-room/meshing/fem/index.md",
        ))
        fem = self.pages()["frontend/control-room/meshing/fem/index.md"]
        self.assertEqual(fem.children, (
            "frontend/control-room/meshing/fem/object-mesh.md",
            "frontend/control-room/meshing/fem/airbox-mesh.md",
            "frontend/control-room/meshing/fem/region-mesh.md",
            "frontend/control-room/meshing/fem/build-and-quality.md",
        ))

    def test_each_approved_interaction_has_one_canonical_owner(self) -> None:
        pages = self.pages()
        interactions = pages["physics/interactions/index.md"]
        self.assertEqual(
            interactions.children,
            tuple(f"physics/interactions/{slug}/index.md" for slug in INTERACTION_SLUGS),
        )
        for child in interactions.children:
            self.assertEqual(sum(spec.path == child for spec in PAGE_SPECS), 1)

    def test_demagnetization_and_dmi_keep_their_scientific_subtrees(self) -> None:
        pages = self.pages()
        for slug, subpages in (
            ("demagnetization", self.DEMAGNETIZATION_SUBPAGES),
            ("dmi", self.DMI_SUBPAGES),
        ):
            path = f"physics/interactions/{slug}/index.md"
            self.assertEqual(
                pages[path].children,
                tuple(f"physics/interactions/{slug}/{page}.md" for page in subpages),
            )

    def test_backend_specific_paths_do_not_own_physical_interactions(self) -> None:
        backend_interaction_paths = [
            spec.path
            for spec in PAGE_SPECS
            if spec.path.startswith("physics/solvers/") and "/interactions/" in spec.path
        ]
        self.assertEqual(backend_interaction_paths, [])

    def test_deployed_legacy_redirects_remain_stable(self) -> None:
        expected = {
            source.removesuffix(".md") + ".html": target.removesuffix(".md") + ".html"
            for source, target in information_architecture.LEGACY_REDIRECTS.items()
        }
        expected["physics/exchange.html"] = "physics/interactions/exchange/index.html"
        self.assertEqual(legacy_redirects._redirects(), expected)
        self.assertEqual(len(expected), 69)

    def test_root_navigation_depth_exposes_deep_meshing_modules(self) -> None:
        self.assertGreaterEqual(self.pages()["index.md"].navigation_maxdepth, 5)

    def test_manifest_has_unique_paths_labels_and_valid_statuses(self) -> None:
        self.assertEqual(validate_tree(PAGE_SPECS), [])

    def test_index_navigation_links_to_every_direct_python_child(self) -> None:
        index = self.pages()["python-api/index.md"]
        text = (PUBLIC_DOCS_ROOT / index.path).read_text(encoding="utf-8")
        for child in index.children:
            relative = Path(child).relative_to(Path(index.path).parent)
            self.assertIn(str(relative.with_suffix("")), text)

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

    def test_write_creates_missing_scaffolds_without_overwriting(self) -> None:
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

    def test_reference_navigation_is_exact(self) -> None:
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
            (root / "index.md").write_text(
                "---\ntitle: Parent\nstatus: partial\ndoc_kind: reference\n---\n\n(parent)=\n# Parent\n\n"
                "```{toctree}\n:maxdepth: 1\n\nchild\nextra\n```\n"
            )
            self.assertIn(
                "reference navigation does not match manifest: index.md",
                check_pages((parent, child), root),
            )

    def test_every_manifest_page_exists(self) -> None:
        missing = [spec.path for spec in PAGE_SPECS if not (PUBLIC_DOCS_ROOT / spec.path).is_file()]
        self.maxDiff = None
        self.assertEqual(missing, [])


if __name__ == "__main__":
    unittest.main()
