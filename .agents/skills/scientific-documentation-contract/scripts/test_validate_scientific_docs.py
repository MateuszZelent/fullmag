from __future__ import annotations

import copy
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from validate_scientific_docs import validate_manifest


SECTIONS = [
    "problem-statement", "governing-equations", "symbols-and-si-units",
    "assumptions-and-validity", "discrete-realization", "implementation-mapping",
    "validation", "limitations", "scientific-bibliography", "source-code-index",
]


class ScientificDocumentationValidatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.repo = Path(self.tempdir.name)
        self._write("backends/fdm/cuda/demag.cu", "void fullmag_demag_field_cuda() {}\n")
        self._write("tests/test_demag.py", "def test_demag_cuda_matches_cpu_reference():\n    pass\n")
        page = "\n".join(f"({section})=\n## {section}" for section in SECTIONS)
        page += r"""

```{math}
:label: eq-demag
\mathbf H_d=-\nabla u
```

| Symbol | Definition | SI unit |
|---|---|---|
| `\mathbf H_d` | Demagnetizing field | A/m |
| `u` | Magnetic scalar potential | A |

Aharoni, Journal of Applied Physics 83, 3432 (1998), DOI 10.1063/1.367113.
Source `src-demag` realizes `eq-demag`.
"""
        self._write("docs/physics/fdm/gpu/demag.md", page)
        self._write("docs/physics/fdm/cpu/demag.md", "# FDM CPU demagnetization\n")
        self._git("init")
        self._git("config", "user.email", "test@example.invalid")
        self._git("config", "user.name", "Test")
        self._git("add", ".")
        self._git("commit", "-m", "fixture")
        self.revision = self._git("rev-parse", "HEAD").strip()
        self.manifest = {
            "schema_version": 1,
            "repository_url": "https://github.com/MateuszZelent/fullmag",
            "document": {
                "path": "docs/physics/fdm/gpu/demag.md",
                "kind": "terminal",
                "publication_scope": "internal",
                "revision": self.revision,
                "hierarchy": {"domain": "physical-interactions", "solver": "FDM", "lane": "GPU", "topic": "demagnetization"},
                "sections": SECTIONS,
                "bibliography": [{"id": "aharoni-1998", "citation": "Aharoni, Journal of Applied Physics 83, 3432 (1998)", "doi": "10.1063/1.367113"}],
                "source_index": [{"equation": "eq-demag", "source": "src-demag"}],
            },
            "symbols": [
                {"id": "H_d", "latex": r"\mathbf H_d", "definition": "Demagnetizing field", "si_unit": "A/m"},
                {"id": "u", "latex": "u", "definition": "Magnetic scalar potential", "si_unit": "A"},
            ],
            "equations": [{
                "id": "eq-demag", "latex": r"\mathbf H_d=-\nabla u", "symbols": ["H_d", "u"],
                "terms": [{"id": "field-gradient", "sources": ["src-demag"], "evidence": ["test-demag"]}],
                "semantic_review": {"status": "approved", "reviewer": "scientific-review", "revision": self.revision},
            }],
            "sources": [{
                "id": "src-demag", "path": "backends/fdm/cuda/demag.cu",
                "symbol": "void fullmag_demag_field_cuda() {}",
                "responsibility": "Evaluate the discrete demagnetizing field.",
                "solver": "FDM", "lane": "GPU", "revision": self.revision,
            }],
            "evidence": [{
                "id": "test-demag", "kind": "test", "path": "tests/test_demag.py",
                "symbol": "test_demag_cuda_matches_cpu_reference", "revision": self.revision,
                "status": "runtime-executed",
                "device_identity": "fixture-gpu",
            }],
            "backend_matrix": [
                {"solver": "FEM", "lane": "CPU", "status": "unsupported", "reason": "Not covered by this interaction page."},
                {"solver": "FEM", "lane": "GPU", "status": "unsupported", "reason": "Not covered by this interaction page."},
                {"solver": "FDM", "lane": "CPU", "status": "different", "chapter": "docs/physics/fdm/cpu/demag.md"},
                {"solver": "FDM", "lane": "GPU", "status": "different", "chapter": "docs/physics/fdm/gpu/demag.md"},
            ],
        }

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def _write(self, path: str, content: str) -> None:
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    def _git(self, *args: str) -> str:
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True, text=True, capture_output=True).stdout

    def errors(self, manifest: object | None = None) -> list[str]:
        candidate = self.manifest if manifest is None else manifest
        return validate_manifest(candidate, self.repo).errors

    def test_valid_manifest_reads_page_source_tests_and_revision(self) -> None:
        result = validate_manifest(self.manifest, self.repo)
        self.assertEqual([], result.errors)
        source = result.resolved_sources["src-demag"]
        self.assertEqual(1, source.start_line)
        self.assertIn(f"/blob/{self.revision}/backends/fdm/cuda/demag.cu#L1-L1", source.github_url)

        head_manifest = copy.deepcopy(self.manifest)
        head_manifest["document"]["revision"] = "HEAD"
        head_manifest["sources"][0]["revision"] = "HEAD"
        head_manifest["evidence"][0]["revision"] = "HEAD"
        head_manifest["equations"][0]["semantic_review"]["revision"] = "HEAD"
        head_result = validate_manifest(head_manifest, self.repo)
        self.assertEqual([], head_result.errors)
        self.assertIn(f"/blob/{self.revision}/", head_result.resolved_sources["src-demag"].github_url)

    def test_rejects_missing_page_draft_and_missing_actual_sections(self) -> None:
        missing = copy.deepcopy(self.manifest)
        missing["document"]["path"] = "docs/physics/missing.md"
        self.assertTrue(any("document does not exist" in e for e in self.errors(missing)))
        draft = copy.deepcopy(self.manifest)
        draft["document"]["kind"] = "draft"
        self.assertTrue(any("kind must be terminal" in e for e in self.errors(draft)))
        sections = copy.deepcopy(self.manifest)
        sections["document"]["sections"] = []
        self.assertTrue(any("manifest missing required section" in e for e in self.errors(sections)))
        page_path = self.repo / "docs/physics/fdm/gpu/demag.md"
        page_path.write_text(page_path.read_text(encoding="utf-8").replace("(validation)=", ""), encoding="utf-8")
        self._git("add", ".")
        self._git("commit", "-m", "remove section anchor")
        revision = self._git("rev-parse", "HEAD").strip()
        actual = copy.deepcopy(self.manifest)
        actual["document"]["revision"] = revision
        actual["sources"][0]["revision"] = revision
        actual["evidence"][0]["revision"] = revision
        actual["equations"][0]["semantic_review"]["revision"] = revision
        self.assertTrue(any("actual page missing section anchor: validation" in e for e in self.errors(actual)))

    def test_requires_exact_latex_equation_and_defined_symbols(self) -> None:
        equation = copy.deepcopy(self.manifest)
        equation["equations"][0]["latex"] = r"\mathbf H_d=+\nabla u"
        self.assertTrue(any("LaTeX does not match" in e for e in self.errors(equation)))
        symbol = copy.deepcopy(self.manifest)
        symbol["equations"][0]["symbols"].append("M_s")
        self.assertTrue(any("undefined symbol M_s" in e for e in self.errors(symbol)))
        unit = copy.deepcopy(self.manifest)
        unit["symbols"][0]["si_unit"] = ""
        self.assertTrue(any("si_unit is required" in e for e in self.errors(unit)))

    def test_resolves_source_and_test_at_declared_git_revision(self) -> None:
        bad_sha = copy.deepcopy(self.manifest)
        bad_sha["sources"][0]["revision"] = "c" * 40
        self.assertTrue(any("does not identify a commit" in e for e in self.errors(bad_sha)))
        bad_test = copy.deepcopy(self.manifest)
        bad_test["evidence"][0]["symbol"] = "missing_test"
        self.assertTrue(any("evidence test-demag" in e and "not found" in e for e in self.errors(bad_test)))
        mismatch = copy.deepcopy(self.manifest)
        self._write("README.md", "second commit\n")
        self._git("add", ".")
        self._git("commit", "-m", "second fixture commit")
        mismatch["document"]["revision"] = self._git("rev-parse", "HEAD").strip()
        self.assertTrue(any("revision must match document revision" in e for e in self.errors(mismatch)))

    def test_requires_complete_equation_mapping_and_semantic_review(self) -> None:
        mapping = copy.deepcopy(self.manifest)
        mapping["equations"][0]["terms"][0]["sources"] = []
        self.assertTrue(any("equation term" in e for e in self.errors(mapping)))
        review = copy.deepcopy(self.manifest)
        review["equations"][0]["semantic_review"]["status"] = "pending"
        self.assertTrue(any("approved semantic review" in e for e in self.errors(review)))

    def test_requires_all_four_backend_lanes_and_matching_sources(self) -> None:
        omitted = copy.deepcopy(self.manifest)
        omitted["backend_matrix"] = omitted["backend_matrix"][:3]
        self.assertTrue(any("backend_matrix must cover" in e for e in self.errors(omitted)))
        mismatch = copy.deepcopy(self.manifest)
        mismatch["sources"][0]["solver"] = "FEM"
        mismatch["sources"][0]["lane"] = "CPU"
        self.assertTrue(any("does not match document hierarchy" in e for e in self.errors(mismatch)))
        false_shared = copy.deepcopy(self.manifest)
        false_shared["backend_matrix"][2] = {"solver": "FDM", "lane": "CPU", "status": "shared-proven", "chapter": "docs/physics/fdm/gpu/demag.md"}
        self.assertTrue(any("parity_evidence" in e for e in self.errors(false_shared)))

    def test_rejects_path_traversal_absolute_paths_and_public_escape(self) -> None:
        traversal = copy.deepcopy(self.manifest)
        traversal["sources"][0]["path"] = "../../etc/hosts"
        self.assertTrue(any("safe repository-relative path" in e for e in self.errors(traversal)))
        absolute = copy.deepcopy(self.manifest)
        absolute["document"]["path"] = "/tmp/page.md"
        self.assertTrue(any("safe repository-relative path" in e for e in self.errors(absolute)))
        escape = copy.deepcopy(self.manifest)
        escape["document"]["publication_scope"] = "public"
        escape["document"]["path"] = "public_docs/site/../../docs/internal.md"
        self.assertTrue(any("safe repository-relative path" in e for e in self.errors(escape)))

    def test_rejects_malformed_types_duplicates_placeholders_and_partial_index(self) -> None:
        self.assertTrue(any("manifest must be an object" in e for e in self.errors([])))
        malformed = copy.deepcopy(self.manifest)
        malformed["sources"][0]["symbol"] = []
        self.assertTrue(any("symbol must be a string" in e for e in self.errors(malformed)))
        duplicate = copy.deepcopy(self.manifest)
        duplicate["sources"].append(copy.deepcopy(duplicate["sources"][0]))
        self.assertTrue(any("duplicate source id" in e for e in self.errors(duplicate)))
        placeholder = copy.deepcopy(self.manifest)
        placeholder["sources"][0]["responsibility"] = "TODO describe"
        self.assertTrue(any("placeholder" in e for e in self.errors(placeholder)))
        partial = copy.deepcopy(self.manifest)
        partial["document"]["source_index"] = []
        self.assertTrue(any("source-code index" in e for e in self.errors(partial)))


if __name__ == "__main__":
    unittest.main()
