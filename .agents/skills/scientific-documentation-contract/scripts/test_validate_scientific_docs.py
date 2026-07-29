from __future__ import annotations

import copy
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from validate_scientific_docs import validate_manifest


class ScientificDocumentationValidatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.repo = Path(self.tempdir.name)
        source = self.repo / "backends/fdm/cuda/demag.cu"
        source.parent.mkdir(parents=True)
        source.write_text("void fullmag_demag_field_cuda() {}\n", encoding="utf-8")
        self.manifest = {
            "schema_version": 1,
            "repository_url": "https://github.com/MateuszZelent/fullmag",
            "document": {
                "path": "public_docs/site/physics/interactions/fdm/gpu/demag.md",
                "kind": "terminal",
                "publication_scope": "public",
                "hierarchy": {
                    "domain": "physical-interactions",
                    "solver": "FDM",
                    "lane": "GPU",
                    "topic": "demagnetization",
                },
                "sections": [
                    "problem-statement", "governing-equations", "symbols-and-si-units",
                    "assumptions-and-validity", "discrete-realization",
                    "implementation-mapping", "validation", "limitations",
                    "scientific-bibliography", "source-code-index",
                ],
                "bibliography": [{"id": "aharoni-1998", "citation": "Aharoni, 1998"}],
                "source_index": [{"equation": "eq-demag", "source": "src-demag"}],
            },
            "equations": [{
                "id": "eq-demag", "latex": r"\\mathbf H_d=-\\nabla u",
                "terms": [{"id": "field-gradient", "sources": ["src-demag"]}],
            }],
            "sources": [{
                "id": "src-demag", "path": "backends/fdm/cuda/demag.cu",
                "symbol": "fullmag_demag_field_cuda",
                "responsibility": "Evaluate the discrete demagnetizing field.",
                "solver": "FDM", "lane": "GPU", "revision": "a" * 40,
                "tests": ["demag_cuda_matches_cpu_reference"],
            }],
            "backend_differences": [{
                "dimension": "CPU/GPU", "different": True,
                "chapters": {"CPU": "physics/interactions/fdm/cpu/demag", "GPU": "physics/interactions/fdm/gpu/demag"},
            }],
        }

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def errors(self, manifest: dict | None = None) -> list[str]:
        return validate_manifest(manifest or self.manifest, self.repo).errors

    def test_valid_manifest_resolves_source_symbol(self) -> None:
        result = validate_manifest(self.manifest, self.repo)
        self.assertEqual([], result.errors)
        self.assertEqual(1, result.resolved_sources["src-demag"].start_line)
        self.assertEqual(
            "https://github.com/MateuszZelent/fullmag/blob/"
            + "a" * 40
            + "/backends/fdm/cuda/demag.cu#L1-L1",
            result.resolved_sources["src-demag"].github_url,
        )

    def test_requires_complete_hierarchy(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        del manifest["document"]["hierarchy"]["lane"]
        self.assertTrue(any("hierarchy.lane" in error for error in self.errors(manifest)))

    def test_requires_existing_file_and_symbol(self) -> None:
        missing_file = copy.deepcopy(self.manifest)
        missing_file["sources"][0]["path"] = "missing.cu"
        self.assertTrue(any("does not exist" in error for error in self.errors(missing_file)))
        missing_symbol = copy.deepcopy(self.manifest)
        missing_symbol["sources"][0]["symbol"] = "absent_kernel"
        self.assertTrue(any("symbol or DOC-ANCHOR" in error for error in self.errors(missing_symbol)))

    def test_requires_every_equation_term_to_map_to_source(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["equations"][0]["terms"][0]["sources"] = []
        self.assertTrue(any("equation term" in error for error in self.errors(manifest)))

    def test_requires_separate_chapters_for_backend_difference(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["backend_differences"][0]["chapters"] = {"GPU": "gpu/demag"}
        self.assertTrue(any("separate chapters" in error for error in self.errors(manifest)))

    def test_requires_bibliography_and_source_index(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["document"]["bibliography"] = []
        manifest["document"]["source_index"] = []
        errors = self.errors(manifest)
        self.assertTrue(any("bibliography" in error for error in errors))
        self.assertTrue(any("source-code index" in error for error in errors))

    def test_rejects_placeholders_and_invalid_revision(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["sources"][0]["responsibility"] = "TODO describe this"
        manifest["sources"][0]["revision"] = "deadbeef"
        errors = self.errors(manifest)
        self.assertTrue(any("placeholder" in error for error in errors))
        self.assertTrue(any("40-character" in error for error in errors))

    def test_enforces_public_internal_boundary(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["document"]["path"] = "docs/physics/demag.md"
        self.assertTrue(any("public document" in error for error in self.errors(manifest)))


if __name__ == "__main__":
    unittest.main()
