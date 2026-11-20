from __future__ import annotations

import copy
import subprocess
import json
import test_validate_scientific_docs as contract_fixture
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

    def _write_complete_publication(
        self, page_path: str | None = None
    ) -> tuple[Path, Path]:
        fixture = contract_fixture.ScientificDocumentationContractTests()
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        page_path = page_path or fixture.page_path.relative_to(fixture.repo).as_posix()
        page = self.repo / page_path
        source = self.repo / fixture.source_path.relative_to(fixture.repo)
        page.parent.mkdir(parents=True, exist_ok=True)
        source.parent.mkdir(parents=True, exist_ok=True)
        page.write_bytes(fixture.page_path.read_bytes())
        source.write_bytes(fixture.source_path.read_bytes())
        manifest = copy.deepcopy(fixture.manifest)
        manifest["document"]["path"] = page_path
        page.with_suffix(".source-map.json").write_text(json.dumps(manifest), encoding="utf-8")
        return page, source

    def test_revision_validation_ignores_dirty_page_and_source(self) -> None:
        page, source = self._write_complete_publication()
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "valid publication")
        page.write_text("# Dirty incomplete page\n", encoding="utf-8")
        source.write_text("# Dirty source without declarations\n", encoding="utf-8")
        self.assertEqual(validate_changed(self.repo, self.base, "HEAD"), [])

    def test_dirty_worktree_cannot_repair_a_broken_committed_page(self) -> None:
        page, _ = self._write_complete_publication()
        valid = page.read_text(encoding="utf-8")
        page.write_text("# Broken committed page\n", encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "broken publication")
        page.write_text(valid, encoding="utf-8")
        self.assertTrue(any("page missing required section" in error
                            for error in validate_changed(self.repo, self.base, "HEAD")))

    def test_dirty_worktree_cannot_repair_a_broken_committed_source(self) -> None:
        _, source = self._write_complete_publication()
        valid = source.read_text(encoding="utf-8")
        source.write_text("# Missing committed declaration\n", encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "broken source")
        source.write_text(valid, encoding="utf-8")
        self.assertTrue(any("declaration not found" in error
                            for error in validate_changed(self.repo, self.base, "HEAD")))

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

    def test_non_scientific_internal_audit_does_not_require_source_map(self) -> None:
        audit = self.repo / "docs/audits/dependency-security-remediation.md"
        audit.parent.mkdir(parents=True)
        audit.write_text("# Dependency remediation\n", encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "add audit")

        self.assertEqual(validate_changed(self.repo, self.base, "HEAD"), [])

    def test_solver_audit_requires_adjacent_source_map(self) -> None:
        audit = self.repo / "docs/audits/llg-solver/backend-audit.md"
        audit.parent.mkdir(parents=True)
        audit.write_text("# Backend audit\n", encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "add solver audit")

        errors = validate_changed(self.repo, self.base, "HEAD")

        self.assertIn(
            "changed scientific page requires sidecar manifest: "
            "docs/audits/llg-solver/backend-audit.source-map.json",
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

    def test_diff_selection_handles_multiple_nul_separated_paths(self) -> None:
        page_paths = (
            "public_docs/site/physics/exchange.md",
            "public_docs/site/physics/thermal-noise.md",
        )
        for page_path in page_paths:
            page = self.repo / page_path
            page.parent.mkdir(parents=True, exist_ok=True)
            page.write_text("# Scientific page\\n", encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "add two unmapped scientific pages")

        errors = validate_changed(self.repo, self.base, "HEAD")

        for page_path in page_paths:
            self.assertIn(
                "changed scientific page requires sidecar manifest: "
                + page_path.removesuffix(".md")
                + ".source-map.json",
                errors,
            )

    def test_unmapped_python_api_page_does_not_require_source_map(self) -> None:
        page = self.repo / "public_docs/site/python-api/runtime/overview.md"
        page.parent.mkdir(parents=True, exist_ok=True)
        page.write_text("# Runtime overview\\n", encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "add unmapped Python API category page")

        self.assertEqual([], validate_changed(self.repo, self.base, "HEAD"))

    def test_existing_public_page_pair_outside_science_is_validated(self) -> None:
        page_path = "public_docs/site/getting-started/example.md"
        page, _ = self._write_complete_publication(page_path)
        manifest = page.with_suffix(".source-map.json")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "add mapped getting-started page")
        base = _git(self.repo, "rev-parse", "HEAD")
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        payload["backend_matrix"] = []
        manifest.write_text(json.dumps(payload), encoding="utf-8")
        _git(self.repo, "add", str(manifest.relative_to(self.repo)))
        _git(self.repo, "commit", "-qm", "break mapped getting-started page")

        errors = validate_changed(self.repo, base, "HEAD")

        self.assertTrue(
            any("backend_matrix must cover all four backend lanes" in error for error in errors),
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
        page.write_text(
            """# Mesh example

## Scope and purpose
Mesh construction.

## Scientific and numerical model
```{math}
:label: eq-mesh
h = 1\\,\\mathrm{m}
```

## Parameters
| Python / IR key | ProblemIR destination |
| --- | --- |
| `mesh.cell` | `mesh.cell` |

## Python API
```python
study = build_mesh()  # %%
```

## Control Room workflow
Select the mesh policy.

## Diagnostics and failure semantics
Invalid mesh requests fail closed.

## Where this is implemented
`src/example.py` â€” `build_mesh`
""",
            encoding="utf-8",
        )
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
            '  "backend_matrix": [\n'
            '    {"solver": "FEM", "device": "CPU", "status": "source-backed"},\n'
            '    {"solver": "FEM", "device": "GPU", "status": "source-backed"},\n'
            '    {"solver": "FDM", "device": "CPU", "status": "not-applicable", "reason": "fixture"},\n'
            '    {"solver": "FDM", "device": "GPU", "status": "not-applicable", "reason": "fixture"}\n'
            '  ],\n'
            '  "sources": [{"id": "mesh", "path": "src/example.py", '
            '"symbol": "build_mesh", "responsibility": "mesh construction"}]\n'
            "}\n",
            encoding="utf-8",
        )
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "map numerical method source")
        manifest_base = _git(self.repo, "rev-parse", "HEAD")

        self.assertEqual(validate_changed(self.repo, self.base, "HEAD"), [])

        manifest.write_text(
            manifest.read_text(encoding="utf-8").replace(
                '"solver": "FEM"', '"solver": []', 1
            ),
            encoding="utf-8",
        )
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "reject malformed backend lane")
        errors = validate_changed(self.repo, manifest_base, "HEAD")

        self.assertTrue(
            any("backend_matrix lane solver/device must be strings" in error for error in errors),
            errors,
        )

    def test_numerical_method_source_map_rejects_blob_revision(self) -> None:
        page = self.repo / "public_docs/site/numerical-methods/meshing/example.md"
        page.parent.mkdir(parents=True)
        page.write_text(
            """# Mesh example

## Scope and purpose
## Scientific and numerical model
```{math}
:label: eq-mesh
h = 1\\,\\mathrm{m}
```
## Parameters
| Python / IR key | ProblemIR destination |
| --- | --- |
| `mesh.cell` | `mesh.cell` |
## Python API
```python
build_mesh()
```
## Control Room workflow
## Diagnostics and failure semantics
## Where this is implemented
`src/example.py` â€” `build_mesh`
""",
            encoding="utf-8",
        )
        source = self.repo / "src/example.py"
        source.parent.mkdir(exist_ok=True)
        source.write_text("def build_mesh():\n    return None\n", encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "add numerical method source")
        revision = _git(self.repo, "rev-parse", "HEAD")
        tree = _git(self.repo, "rev-parse", f"{revision}^{{tree}}")
        manifest = page.with_suffix(".source-map.json")
        manifest.write_text(
            "{\n"
            f'  "document": {{"path": "public_docs/site/numerical-methods/meshing/example.md", '
            f'"reviewed_revision": "{tree}"}},\n'
            '  "backend_matrix": [\n'
            '    {"solver": "FEM", "device": "CPU", "status": "source-backed"},\n'
            '    {"solver": "FEM", "device": "GPU", "status": "source-backed"},\n'
            '    {"solver": "FDM", "device": "CPU", "status": "not-applicable", "reason": "fixture"},\n'
            '    {"solver": "FDM", "device": "GPU", "status": "not-applicable", "reason": "fixture"}\n'
            '  ],\n'
            '  "sources": [{"id": "mesh", "path": "src/example.py", '
            '"symbol": "build_mesh", "responsibility": "mesh construction"}]\n'
            "}\n",
            encoding="utf-8",
        )
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "map tree revision")

        errors = validate_changed(self.repo, self.base, "HEAD")

        self.assertTrue(any("must name a commit" in error for error in errors), errors)

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

    def test_deleting_page_and_sidecar_together_is_allowed(self) -> None:
        page = self.repo / "public_docs/site/physics/exchange.md"
        manifest = self.repo / "public_docs/site/physics/exchange.source-map.json"
        page.write_text("# Exchange\n", encoding="utf-8")
        manifest.write_text('{}\n', encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "add mapped page")
        base = _git(self.repo, "rev-parse", "HEAD")
        page.unlink()
        manifest.unlink()
        _git(self.repo, "add", "-u")
        _git(self.repo, "commit", "-qm", "delete mapped page")

        self.assertEqual([], validate_changed(self.repo, base, "HEAD"))

    def test_renaming_page_and_sidecar_validates_the_new_pair(self) -> None:
        page, _ = self._write_complete_publication()
        manifest = page.with_suffix(".source-map.json")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "add mapped scientific page")
        base = _git(self.repo, "rev-parse", "HEAD")

        new_page_path = "public_docs/site/physics/interactions/exchange-renamed.md"
        new_page = self.repo / new_page_path
        new_page.parent.mkdir(parents=True, exist_ok=True)
        page.rename(new_page)
        new_manifest = new_page.with_suffix(".source-map.json")
        manifest.rename(new_manifest)
        payload = json.loads(new_manifest.read_text(encoding="utf-8"))
        payload["document"]["path"] = new_page_path
        new_manifest.write_text(json.dumps(payload), encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-qm", "rename mapped scientific page")

        self.assertEqual([], validate_changed(self.repo, base, "HEAD"))

        payload["backend_matrix"] = []
        new_manifest.write_text(json.dumps(payload), encoding="utf-8")
        _git(self.repo, "add", str(new_manifest.relative_to(self.repo)))
        _git(self.repo, "commit", "-qm", "break renamed page backend matrix")
        errors = validate_changed(self.repo, base, "HEAD")
        self.assertTrue(
            any("backend_matrix must cover all four backend lanes" in error for error in errors),
            errors,
        )

    def test_changed_markdown_page_selects_manifest_for_render_validation(self) -> None:
        page, _ = self._write_complete_publication()
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "add mapped scientific page")
        base = _git(self.repo, "rev-parse", "HEAD")
        page.write_text(page.read_text(encoding="utf-8") + "\nUpdated description.\n", encoding="utf-8")
        _git(self.repo, "add", str(page.relative_to(self.repo)))
        _git(self.repo, "commit", "-qm", "edit scientific page only")

        rendered_root = self.repo / "rendered"
        errors = validate_changed(
            self.repo, base, "HEAD", rendered_html_root=rendered_root
        )
        self.assertTrue(
            any("rendered HTML does not exist" in error for error in errors),
            errors,
        )
        rendered_page = rendered_root / "physics/exchange.html"
        rendered_page.parent.mkdir(parents=True)
        rendered_page.write_text(
            '<html><body><span class="math notranslate nohighlight">\\(A\\)</span>'
            '<button class="copybutton">Copy</button></body></html>',
            encoding="utf-8",
        )

        self.assertEqual(
            [],
            validate_changed(
                self.repo, base, "HEAD", rendered_html_root=rendered_root
            ),
        )

    def test_changed_sidecar_selects_manifest_for_render_validation(self) -> None:
        page, _ = self._write_complete_publication()
        manifest = page.with_suffix(".source-map.json")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "add mapped scientific page")
        base = _git(self.repo, "rev-parse", "HEAD")
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        payload["sources"][0]["responsibility"] += " Re-reviewed."
        manifest.write_text(json.dumps(payload), encoding="utf-8")
        _git(self.repo, "add", str(manifest.relative_to(self.repo)))
        _git(self.repo, "commit", "-qm", "edit source map only")

        rendered_root = self.repo / "rendered"
        errors = validate_changed(
            self.repo, base, "HEAD", rendered_html_root=rendered_root
        )
        self.assertTrue(
            any("rendered HTML does not exist" in error for error in errors),
            errors,
        )
        rendered_page = rendered_root / "physics/exchange.html"
        rendered_page.parent.mkdir(parents=True)
        rendered_page.write_text(
            '<html><body><span class="math notranslate nohighlight">\\(A\\)</span>'
            '<button class="copybutton">Copy</button></body></html>',
            encoding="utf-8",
        )

        self.assertEqual(
            [],
            validate_changed(
                self.repo, base, "HEAD", rendered_html_root=rendered_root
            ),
        )

    def test_changed_python_api_sidecar_is_validated(self) -> None:
        page_path = "public_docs/site/python-api/runtime/example.md"
        page, _ = self._write_complete_publication(page_path)
        manifest = page.with_suffix(".source-map.json")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "add Python API page and source map")
        base = _git(self.repo, "rev-parse", "HEAD")
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        payload["backend_matrix"] = []
        manifest.write_text(json.dumps(payload), encoding="utf-8")
        _git(self.repo, "add", str(manifest.relative_to(self.repo)))
        _git(self.repo, "commit", "-qm", "break Python API backend matrix")

        errors = validate_changed(self.repo, base, "HEAD")

        self.assertTrue(
            any("backend_matrix must cover all four backend lanes" in error for error in errors),
            errors,
        )

    def test_git_diff_error_is_reported(self) -> None:
        errors = validate_changed(self.repo, "missing-base-revision", "HEAD")

        self.assertTrue(any("cannot compare missing-base-revision...HEAD" in error for error in errors))


    def test_documentation_workflow_runs_for_validator_changes(self) -> None:
        repo_root = Path(__file__).resolve().parents[4]
        workflow = (repo_root / ".github/workflows/documentation.yml").read_text(
            encoding="utf-8"
        )

        self.assertGreaterEqual(
            workflow.count('".agents/skills/scientific-documentation-contract/**"'),
            1,
        )


if __name__ == "__main__":
    unittest.main()
