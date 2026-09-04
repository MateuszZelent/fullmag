from __future__ import annotations

import copy
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from validate_scientific_docs import validate_page


class ScientificDocumentationContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.repo = Path(self.tempdir.name)
        self.page_path = self.repo / "public_docs/site/physics/exchange.md"
        self.page_path.parent.mkdir(parents=True)
        self.source_path = self.repo / "src/exchange.py"
        self.source_path.parent.mkdir(parents=True)
        self.source_path.write_text("def lower_exchange():\n    return {'kind': 'exchange'}\n", encoding="utf-8")
        self.page_path.write_text(
            """# Exchange

(problem-statement)=
## Problem statement
(governing-equations)=
## Governing equations
```{math}
:label: eq-exchange
E_{\\mathrm{ex}}=A|\\nabla \\mathbf m|^2
```
(symbols-and-si-units)=
## Symbols and SI units
| Symbol | Meaning | SI unit |
|---|---|---|
| $A$ | exchange stiffness | $\\mathrm{J\\,m^{-1}}$ |
| $\\mathbf m$ | reduced magnetization | $1$ |
(assumptions-and-validity)=
## Assumptions and validity
(python-api)=
## Python API
| Parameter | Type | Default | SI unit | Validation | Meaning | Backend support |
|---|---|---|---|---|---|---|
| `Exchange.A` | `float` | required | $\\mathrm{J\\,m^{-1}}$ | $A>0$ | exchange stiffness | FEM/FDM CPU/GPU |
```python
# %% Imports
from fullmag import Exchange
# %% Model
exchange = Exchange(A=1.3e-11)
```
(problem-ir)=
## ProblemIR
```json
{"interactions": [{"kind": "exchange", "A": 1.3e-11}]}
```
| Python | ProblemIR | Normalization |
|---|---|---|
| `Exchange.A` | `interactions[].A` | SI value preserved |
(round-trip-and-failure-semantics)=
## Round-trip and failure semantics
Requested intent is preserved; planner-resolved execution is recorded. Validation errors reject unsupported combinations.
(discrete-realization)=
## Discrete realization
### FDM CPU
### FDM GPU
### FEM CPU
### FEM GPU
(implementation-mapping)=
## Implementation mapping
(validation)=
## Validation
(limitations)=
## Limitations
(scientific-bibliography)=
## Scientific bibliography
1. W. F. Brown, *Micromagnetics*, 1963.
(source-code-index)=
## Source-code index
| Equation | Path | Symbol | Responsibility |
|---|---|---|---|
| `eq-exchange` | `src/exchange.py` | `lower_exchange` | Lower Exchange to ProblemIR |
""",
            encoding="utf-8",
        )
        self.manifest = {
            "document": {"path": "public_docs/site/physics/exchange.md"},
            "backend_matrix": [
                {"solver": solver, "device": device, "status": "documented"}
                for solver in ("FEM", "FDM") for device in ("CPU", "GPU")
            ],
            "equations": [{"id": "eq-exchange", "symbols": ["A", "m"], "sources": ["exchange-lowering"]}],
            "symbols": [
                {"id": "A", "latex": "A", "meaning": "exchange stiffness", "si_unit": "\\mathrm{J\\,m^{-1}}"},
                {"id": "m", "latex": "\\mathbf m", "meaning": "reduced magnetization", "si_unit": "1"},
            ],
            "sources": [{"id": "exchange-lowering", "path": "src/exchange.py", "symbol": "lower_exchange", "responsibility": "Lower Exchange to ProblemIR"}],
            "public_api": {"parameters": [{
                "python": "Exchange.A", "type": "float", "default": "required",
                "si_unit": "\\mathrm{J\\,m^{-1}}", "validation": "A>0",
                "meaning": "exchange stiffness", "backend_support": "FEM/FDM CPU/GPU",
                "problem_ir": "interactions[].A",
            }]},
        }

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def errors(self, manifest: dict | None = None) -> list[str]:
        return validate_page(self.repo, self.manifest if manifest is None else manifest)

    def test_complete_publication_contract_passes(self) -> None:
        self.assertEqual([], self.errors())

    def test_rejects_raw_inline_latex_and_missing_symbol_unit(self) -> None:
        self.page_path.write_text(self.page_path.read_text().replace("$A$", r"\(A\)"), encoding="utf-8")
        self.assertTrue(any("raw inline LaTeX" in error for error in self.errors()))
        broken = copy.deepcopy(self.manifest)
        broken["symbols"][0]["si_unit"] = ""
        self.assertTrue(any("SI unit" in error for error in self.errors(broken)))

    def test_requires_all_backend_lanes_and_stable_source_symbols(self) -> None:
        broken = copy.deepcopy(self.manifest)
        broken["backend_matrix"].pop()
        self.assertTrue(any("four backend lanes" in error for error in self.errors(broken)))
        broken = copy.deepcopy(self.manifest)
        broken["sources"][0].pop("symbol")
        broken["sources"][0]["lines"] = "10-20"
        self.assertTrue(any("path + symbol" in error for error in self.errors(broken)))

    def test_source_symbol_must_resolve_to_one_declaration_not_a_comment(self) -> None:
        source = self.repo / "src/exchange.py"
        source.parent.mkdir(exist_ok=True)
        source.write_text(
            "# exchange_kernel is discussed here\n"
            "def exchange_kernel():\n"
            "    return None\n"
            "exchange_kernel()\n",
            encoding="utf-8",
        )
        manifest = copy.deepcopy(self.manifest)
        manifest["sources"][0]["path"] = "src/exchange.py"
        manifest["sources"][0]["symbol"] = "exchange_kernel"
        self.page_path.write_text(
            self.page_path.read_text(encoding="utf-8")
            + "\n| source | src/exchange.py | exchange_kernel |\n",
            encoding="utf-8",
        )
        self.assertEqual([], self.errors(manifest))

        source.write_text("# exchange_kernel only\n", encoding="utf-8")
        errors = self.errors(manifest)
        self.assertTrue(any("declaration not found" in error for error in errors))

    def test_python_module_constant_is_a_stable_source_symbol(self) -> None:
        source = self.repo / "src/policy.py"
        source.parent.mkdir(exist_ok=True)
        source.write_text(
            "# STRICT_POLICY is discussed here\n"
            "STRICT_POLICY = Policy(\n"
            "    method='Relocate3D',\n"
            ")\n"
            "use(STRICT_POLICY)\n",
            encoding="utf-8",
        )
        manifest = copy.deepcopy(self.manifest)
        manifest["sources"][0]["path"] = "src/policy.py"
        manifest["sources"][0]["symbol"] = "STRICT_POLICY"
        self.page_path.write_text(
            self.page_path.read_text(encoding="utf-8")
            + "\n| repair policy | src/policy.py | STRICT_POLICY |\n",
            encoding="utf-8",
        )

        self.assertEqual([], self.errors(manifest))

        source.write_text("# STRICT_POLICY only\nuse(STRICT_POLICY)\n", encoding="utf-8")
        errors = self.errors(manifest)
        self.assertTrue(any("declaration not found" in error for error in errors))

        source.write_text("STRICT_POLICY == other_policy\n", encoding="utf-8")
        errors = self.errors(manifest)
        self.assertTrue(any("declaration not found" in error for error in errors))

    def test_generic_rust_function_is_a_stable_source_symbol(self) -> None:
        source = self.repo / "src/integrator.rs"
        source.parent.mkdir(exist_ok=True)
        source.write_text(
            "pub fn heun_trial<F>(callback: F) where F: FnMut() {}\n",
            encoding="utf-8",
        )
        manifest = copy.deepcopy(self.manifest)
        manifest["sources"][0]["path"] = "src/integrator.rs"
        manifest["sources"][0]["symbol"] = "heun_trial"
        self.page_path.write_text(
            self.page_path.read_text(encoding="utf-8")
            + "\n| coupled trial | src/integrator.rs | heun_trial |\n",
            encoding="utf-8",
        )

        self.assertEqual([], self.errors(manifest))

    def test_existing_typed_and_multiline_cpp_symbol_formats_remain_supported(self) -> None:
        cases = (
            ("typed.cpp", "void typed_contract() {}\n", "void typed_contract"),
            ("multiline.cpp", "bool\nmultiline_contract() { return true; }\n", "multiline_contract"),
            ("contract.ts", "function typescript_contract() {}\n", "function typescript_contract"),
        )
        for filename, declaration, symbol in cases:
            with self.subTest(symbol=symbol):
                source = self.repo / f"src/{filename}"
                source.parent.mkdir(exist_ok=True)
                source.write_text(declaration, encoding="utf-8")
                manifest = copy.deepcopy(self.manifest)
                manifest["sources"][0]["path"] = f"src/{filename}"
                manifest["sources"][0]["symbol"] = symbol
                original = self.page_path.read_text(encoding="utf-8")
                self.page_path.write_text(
                    original + f"\n| source | src/{filename} | {symbol} |\n",
                    encoding="utf-8",
                )
                self.assertEqual([], self.errors(manifest))
                self.page_path.write_text(original, encoding="utf-8")

    def test_rendered_display_mathjax_is_allowed(self) -> None:
        rendered = self.repo / "exchange.html"
        rendered.write_text(
            '<html><span class="math notranslate nohighlight">\\[E=0\\]</span>'
            '<button class="copybutton">Copy</button></html>',
            encoding="utf-8",
        )
        self.assertEqual([], validate_page(self.repo, self.manifest, rendered))

    def test_rust_enum_is_a_stable_source_symbol(self) -> None:
        source = self.repo / "src/error.rs"
        source.parent.mkdir(exist_ok=True)
        source.write_text(
            "pub enum EngineErrorCode { NaNValue, InfiniteValue }\n",
            encoding="utf-8",
        )
        manifest = copy.deepcopy(self.manifest)
        manifest["sources"][0].update(
            {
                "path": "src/error.rs",
                "symbol": "EngineErrorCode",
                "evidence_status": "unit_integration_proof",
            }
        )
        self.page_path.write_text(
            self.page_path.read_text(encoding="utf-8")
            + "\n| typed engine error | src/error.rs | EngineErrorCode |\n",
            encoding="utf-8",
        )

        self.assertEqual([], self.errors(manifest))

    def test_justfile_recipe_is_a_stable_source_symbol(self) -> None:
        justfile = self.repo / "justfile"
        justfile.write_text("verify-managed-charge:\n    echo proof\n", encoding="utf-8")
        manifest = copy.deepcopy(self.manifest)
        manifest["sources"][0]["path"] = "justfile"
        manifest["sources"][0]["symbol"] = "verify-managed-charge"
        self.page_path.write_text(
            self.page_path.read_text(encoding="utf-8")
            + "\n| managed proof | justfile | verify-managed-charge |\n",
            encoding="utf-8",
        )

        self.assertEqual([], self.errors(manifest))

    def test_planned_source_may_resolve_to_a_unique_document_anchor(self) -> None:
        anchor = "planned-fdm-gpu-transport-owner"
        self.page_path.write_text(
            self.page_path.read_text(encoding="utf-8")
            + f"\n({anchor})=\n### Planned FDM GPU transport owner\n"
            + f"\n| planned owner | public_docs/site/physics/exchange.md | DOC-ANCHOR:{anchor} |\n",
            encoding="utf-8",
        )
        manifest = copy.deepcopy(self.manifest)
        manifest["sources"].append(
            {
                "id": "planned-fdm-gpu-owner",
                "path": "public_docs/site/physics/exchange.md",
                "symbol": f"DOC-ANCHOR:{anchor}",
                "responsibility": "Freeze a planned owner without claiming implemented code.",
                "evidence_status": "planned_contract",
            }
        )
        self.assertEqual([], self.errors(manifest))

        self.page_path.write_text(
            self.page_path.read_text(encoding="utf-8")
            + f"\n({anchor})=\n### Duplicate anchor\n",
            encoding="utf-8",
        )
        errors = self.errors(manifest)
        self.assertTrue(any("DOC-ANCHOR is not unique" in error for error in errors))

    def test_requires_parseable_cell_examples_and_exhaustive_api_to_ir_mapping(self) -> None:
        self.page_path.write_text(self.page_path.read_text().replace("# %%", "#"), encoding="utf-8")
        self.assertTrue(any("# %%" in error for error in self.errors()))
        broken = copy.deepcopy(self.manifest)
        broken["public_api"]["parameters"][0].pop("problem_ir")
        self.assertTrue(any("ProblemIR mapping" in error for error in self.errors(broken)))

    def test_direct_problem_is_forbidden_in_public_documentation(self) -> None:
        self.page_path.write_text(
            self.page_path.read_text(encoding="utf-8").replace(
                "from fullmag import Exchange\n# %% Model",
                "from fullmag import Exchange\n# %% Model\n",
            )
            + "\n```python\nproblem = fm.Problem(name='run')\n```\n",
            encoding="utf-8",
        )
        self.assertTrue(any("uses fm.Problem" in error for error in self.errors()))

    def test_rendered_html_requires_mathjax_and_copy_controls(self) -> None:
        rendered = self.repo / "exchange.html"
        rendered.write_text("<html><code>exchange = Exchange()</code></html>", encoding="utf-8")
        errors = validate_page(self.repo, self.manifest, rendered)
        self.assertTrue(any("MathJax" in error for error in errors))
        self.assertTrue(any("copy control" in error for error in errors))
        rendered.write_text(
            '<html><span class="math notranslate nohighlight">\\(A\\)</span>'
            '<button class="copybutton">Copy</button></html>',
            encoding="utf-8",
        )
        self.assertEqual([], validate_page(self.repo, self.manifest, rendered))

    def test_rejects_manifest_placeholders(self) -> None:
        broken = copy.deepcopy(self.manifest)
        broken["sources"][0]["responsibility"] = "TODO explain this mapping"
        self.assertTrue(any("placeholder" in error for error in self.errors(broken)))


class DefaultPlanarViewDocumentationContractTests(unittest.TestCase):
    def test_default_source_replaces_monitor_draft_and_empty_state_contract(self) -> None:
        root = Path(__file__).resolve().parents[4]
        viewport_spec = (root / "docs/specs/frontend-v2/15-viewport-2d-module.md").read_text(
            encoding="utf-8"
        )
        audit_plan = (
            root
            / "docs/plans/active/viewport-2d-refactor-2026-08-12/"
            / "viewport-2d-refactor-audit-and-implementation-plan.md"
        ).read_text(encoding="utf-8")

        stale_contracts = (
            (
                "2D opening creates an editable monitor draft",
                "opening 2D in a scene without monitors creates an editable monitor draft",
                viewport_spec,
            ),
            (
                "field-map uses an empty state without a monitor",
                "`field-map` pokazuje pusty stan",
                audit_plan,
            ),
        )
        violations = [
            label
            for label, stale_text, document in stale_contracts
            if stale_text in document
        ]
        self.assertEqual([], violations)


if __name__ == "__main__":
    unittest.main()
