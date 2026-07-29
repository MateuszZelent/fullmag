# Public Documentation Information Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete approved public-documentation skeleton, establish Python API as a separate section, and relocate general constructor reference material out of the Exchange page without losing it.

**Architecture:** A repository-owned Python manifest/generator defines every scaffold page, status, label, scope, and direct child. Focused contract tests prove tree symmetry and navigation. Existing authored pages are never overwritten by generation; general Python constructor material is moved manually to its canonical API owner while Exchange retains only Exchange-facing physics and mappings.

**Tech Stack:** Python 3.11, `unittest`, Sphinx 8, MyST Markdown, Sphinx Clarity Theme, existing scientific-documentation validators.

## Global Constraints

- Public Python API is a top-level documentation family, independent from terminal physics pages.
- Physics hierarchy is `domain → solver → backend → interaction`.
- FDM CPU, FDM GPU, FEM CPU, and FEM GPU contain the same canonical interaction filename set.
- Every scaffold page has one stable MyST label and status `implemented`, `partial`, `unsupported`, or `planned`.
- Planned scaffolds make no equations, defaults, backend-support, implementation, or validation claims.
- Existing authored pages and useful Exchange prose are preserved; generation never overwrites them.
- Exchange retains only `Exchange`, `A`, `A_field`, equation-required `Ms`/`Ms_field`, `H_ex`, `E_ex`, Exchange-specific T0/T1 controls, equations, lane realizations, validation, and sources.
- General geometry, study, output, discretization, and full-Problem parameter inventories must not remain on Exchange.
- Internal `docs/` plans and specifications are never included in the public Sphinx source tree.
- Every code or documentation behavior change follows RED/GREEN verification.

---

### Task 1: Canonical tree manifest and failing architecture tests

**Files:**
- Create: `scripts/public_docs_information_architecture.py`
- Create: `scripts/test_public_docs_information_architecture.py`

**Interfaces:**
- Produces: `PageSpec(path: str, title: str, label: str, status: str, scope: str, children: tuple[str, ...])`.
- Produces: `PAGE_SPECS: tuple[PageSpec, ...]`, containing every exact path approved in `docs/superpowers/specs/2026-07-29-public-documentation-information-architecture-design.md`.
- Produces: `INTERACTION_SLUGS: tuple[str, ...]` with the fourteen canonical interactions.
- Produces: CLI `python scripts/public_docs_information_architecture.py --check|--write --root public_docs/site`.
- Consumes: the approved design specification; it does not inspect internal `docs/physics` to invent pages.

- [ ] **Step 1: Write the failing tests**

Create `scripts/test_public_docs_information_architecture.py` with focused tests equivalent to:

```python
from pathlib import Path
import unittest

from public_docs_information_architecture import (
    INTERACTION_SLUGS,
    PAGE_SPECS,
    PUBLIC_DOCS_ROOT,
    validate_tree,
)


class PublicDocumentationInformationArchitectureTests(unittest.TestCase):
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
                    if spec.path.startswith(prefix) and spec.path != f"{prefix}index.md"
                }
                self.assertEqual(actual, set(INTERACTION_SLUGS))

    def test_manifest_has_unique_paths_labels_and_valid_statuses(self) -> None:
        errors = validate_tree(PAGE_SPECS)
        self.assertEqual(errors, [])

    def test_every_manifest_page_exists_and_has_canonical_scaffold(self) -> None:
        missing = [spec.path for spec in PAGE_SPECS if not (PUBLIC_DOCS_ROOT / spec.path).is_file()]
        self.assertEqual(missing, [])
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
python3 -m unittest scripts/test_public_docs_information_architecture.py -v
```

Expected: import failure because `scripts/public_docs_information_architecture.py` does not exist.

- [ ] **Step 3: Implement the manifest and renderer**

Implement a frozen `PageSpec` dataclass and an explicit `PAGE_SPECS` tuple. Transcribe every path from sections 5–11 of the approved specification. Expand all four interaction trees explicitly from `INTERACTION_SLUGS`; do not use the phrase “same as” in stored page data.

The renderer must emit this exact shape for a terminal scaffold:

```markdown
---
title: Exchange — FDM CPU
status: planned
doc_kind: scaffold
audience: user
owner: fullmag-public-docs
---

(physics-fdm-cpu-exchange)=
# Exchange — FDM CPU

This page reserves the public documentation location for the FDM CPU realization of Exchange.
```

For index scaffolds, append a MyST `toctree` containing every direct child as a path relative to the index directory. Implement `--write` so it creates missing files only and fails if a pre-existing file would need replacement. Implement `--check` so it reports missing pages, unrecognized metadata, labels, or child navigation and exits nonzero.

- [ ] **Step 4: Run structural unit tests**

Run:

```bash
python3 -m unittest scripts/test_public_docs_information_architecture.py -v
```

Expected: manifest-only tests pass; existence test fails with a complete list of missing scaffold pages.

- [ ] **Step 5: Commit Task 1**

Stage only the two script files, inspect `git diff --cached --name-only`, and commit:

```text
test(docs): define public information architecture contract
```

---

### Task 2: Generate the full public scaffold and navigation

**Files:**
- Create: every missing page declared by `PAGE_SPECS` under `public_docs/site/getting-started/`, `python-api/`, `physics/foundations/`, `physics/solvers/`, `numerical-methods/`, and `validation/`.
- Create: `public_docs/site/architecture/planner-and-capabilities.md`
- Create: `public_docs/site/architecture/provenance.md`
- Modify: `public_docs/site/index.md`
- Modify: `public_docs/site/physics/index.md`
- Modify: `public_docs/site/architecture/index.md`
- Test: `scripts/test_public_docs_information_architecture.py`

**Interfaces:**
- Consumes: `PAGE_SPECS` and `render_page(spec, root)` from Task 1.
- Produces: a complete navigable Sphinx tree; all generated files carry `doc_kind: scaffold`.

- [ ] **Step 1: Generate missing pages**

Run:

```bash
python3 scripts/public_docs_information_architecture.py --write --root public_docs/site
```

Expected: every missing scaffold is created; existing authored files are reported as preserved.

- [ ] **Step 2: Update existing root indexes without replacing authored prose**

Patch the root, physics, and architecture indexes so their toctrees list direct children exactly once. Preserve existing introductory prose. The root toctree order must be:

```text
getting-started/index
python-api/index
physics/index
numerical-methods/index
validation/index
architecture/index
```

The physics index must link `foundations/index` and `solvers/index` before legacy authored pages. The architecture index must include `planner-and-capabilities` and `provenance`.

- [ ] **Step 3: Run the architecture checker and tests**

Run:

```bash
python3 scripts/public_docs_information_architecture.py --check --root public_docs/site
python3 -m unittest scripts/test_public_docs_information_architecture.py -v
```

Expected: both commands pass with zero missing pages, duplicate labels, invalid statuses, asymmetric interaction sets, or navigation gaps.

- [ ] **Step 4: Run a strict Sphinx build**

Run:

```bash
sphinx-build -b html -W -n --keep-going public_docs/site /tmp/fullmag-public-docs-scaffold
```

Expected: build succeeds with no warnings; every scaffold is reachable from a toctree.

- [ ] **Step 5: Commit Task 2**

Stage only public scaffold and navigation files, inspect the staged list, and commit:

```text
docs: scaffold complete public documentation tree
```

---

### Task 3: Make planned-scaffold exemptions fail closed

**Files:**
- Modify: `.agents/skills/scientific-documentation-contract/scripts/validate_changed_scientific_docs.py`
- Modify: `.agents/skills/scientific-documentation-contract/scripts/test_validate_changed_scientific_docs.py`
- Modify: `.github/skills/scientific-documentation-contract/scripts/validate_changed_scientific_docs.py`
- Modify: `.github/skills/scientific-documentation-contract/scripts/test_validate_changed_scientific_docs.py`
- Modify: `.github/workflows/documentation.yml`

**Interfaces:**
- Consumes: canonical `PAGE_SPECS` and exact generated scaffold rendering from Task 1.
- Produces: `is_registered_scaffold(path: Path, repo_root: Path) -> bool`.
- Produces: changed-page validation that exempts only byte-for-byte canonical registered scaffolds, never arbitrary pages carrying `status: planned`.

- [ ] **Step 1: Add failing validator tests**

Add tests proving:

```python
def test_registered_canonical_scaffold_does_not_require_source_map(self): ...
def test_unregistered_planned_page_still_requires_source_map(self): ...
def test_registered_scaffold_with_scientific_content_requires_source_map(self): ...
def test_registered_scaffold_with_changed_status_requires_source_map(self): ...
```

The third case appends a governing equation to the generated body and must fail. The fourth changes `planned` to `implemented` and must fail.

- [ ] **Step 2: Run validator tests and verify RED**

Run:

```bash
python3 -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py' -v
```

Expected: the new registered-scaffold case fails because every changed physics page currently requires an adjacent source map.

- [ ] **Step 3: Implement fail-closed scaffold recognition**

Import the repository manifest by absolute file path without adding an install-time package dependency. A page is exempt only when all of these are true:

1. its repository-relative path is in `PAGE_SPECS`;
2. its manifest status is `planned`;
3. its manifest `doc_kind` is `scaffold`;
4. its current content equals `render_page(spec)` exactly.

Mirror the modified validator and test file byte-for-byte under `.github/skills/`. Add the information-architecture script and test path to the documentation workflow trigger and run the architecture checker before Sphinx.

- [ ] **Step 4: Run validator and architecture tests**

Run:

```bash
python3 -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py' -v
python3 -m unittest scripts/test_public_docs_information_architecture.py -v
```

Expected: all tests pass.

- [ ] **Step 5: Commit Task 3**

Stage only validator mirrors and workflow files, verify the mirrors with `cmp`, and commit:

```text
ci(docs): validate planned scaffolds fail closed
```

---

### Task 4: Relocate general Python API content out of Exchange

**Files:**
- Modify: `public_docs/site/physics/exchange.md`
- Modify: `public_docs/site/python-api/materials/material.md`
- Modify: `public_docs/site/python-api/materials/spatial-parameter-fields.md`
- Modify: `public_docs/site/python-api/geometry/primitives.md`
- Modify: `public_docs/site/python-api/magnets-and-textures/ferromagnet.md`
- Modify: `public_docs/site/python-api/magnets-and-textures/uniform-texture.md`
- Modify: `public_docs/site/python-api/studies/time-evolution.md`
- Modify: `public_docs/site/python-api/dynamics/llg.md`
- Modify: `public_docs/site/python-api/outputs/fields-and-scalars.md`
- Modify: `public_docs/site/python-api/discretization/discretization-hints.md`
- Modify: `public_docs/site/python-api/discretization/fdm.md`
- Modify: `public_docs/site/python-api/discretization/fem.md`
- Modify: `public_docs/site/python-api/problem/problem.md`
- Modify: `public_docs/site/python-api/problem/problem-ir.md`
- Modify: `packages/fullmag-py/tests/test_public_exchange_documentation.py`
- Create: `packages/fullmag-py/tests/test_public_python_api_documentation.py`

**Interfaces:**
- Produces: `API_PARAMETER_OWNERS: dict[str, Path]` in the new test, mapping each example constructor to exactly one canonical API page.
- Preserves: the executable Exchange Python block and `problem_ir` variable.
- Preserves: Exchange source-map labels and all governing/discrete equation labels.

- [ ] **Step 1: Write failing scope and ownership tests**

In `test_public_exchange_documentation.py`, replace the global constructor-completeness test with assertions that Exchange excludes these headings and unrelated rows:

```python
for forbidden in (
    "Geometry, magnet, study, and output parameters used above",
    "Discretization parameters used above",
    "`Material.Ku1`",
    "`Problem.elastic_materials`",
    "`LLG.integrator`",
):
    self.assertNotIn(forbidden, page)
```

Also assert that `Material.A`, `Material.A_field`, `Material.Ms`, `Material.Ms_field`, `H_ex`, `E_ex`, `FDM.boundary_correction`, `FDM.boundary_phi_floor`, and `FDM.boundary_delta_min` remain.

Create `test_public_python_api_documentation.py` with explicit ownership:

```python
API_PARAMETER_OWNERS = {
    "Material": Path("python-api/materials/material.md"),
    "Box": Path("python-api/geometry/primitives.md"),
    "Ferromagnet": Path("python-api/magnets-and-textures/ferromagnet.md"),
    "texture.uniform": Path("python-api/magnets-and-textures/uniform-texture.md"),
    "TimeEvolution": Path("python-api/studies/time-evolution.md"),
    "LLG": Path("python-api/dynamics/llg.md"),
    "SaveField": Path("python-api/outputs/fields-and-scalars.md"),
    "SaveScalar": Path("python-api/outputs/fields-and-scalars.md"),
    "Problem": Path("python-api/problem/problem.md"),
    "DiscretizationHints": Path("python-api/discretization/discretization-hints.md"),
    "FDM": Path("python-api/discretization/fdm.md"),
    "FEM": Path("python-api/discretization/fem.md"),
}
```

For each constructor, inspect its current signature and require every non-variadic parameter token on its owner page.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m unittest discover \
  -s packages/fullmag-py/tests -p 'test_public_*_documentation.py' -v
```

Expected: Exchange scope test fails because general tables remain; API ownership tests fail because scaffold pages contain no parameter inventories.

- [ ] **Step 3: Move, do not delete, constructor inventories**

Move each existing table according to section 12 of the approved specification. Split the `Material` inventory so scalar constructor parameters live in `material.md` and spatial field semantics are explained and cross-linked from `spatial-parameter-fields.md`; keep all signature tokens on `material.md` so ownership remains unique. Move `ProblemIR` general framing to `problem-ir.md`, but keep the minimal executable Exchange JSON subset on Exchange.

Each destination page changes from `doc_kind: scaffold` to `doc_kind: reference` and status `partial`. Add links from Exchange immediately after the executable example. Do not add new parameter values or backend claims beyond the prose already verified in Exchange.

- [ ] **Step 4: Reduce Exchange to its interaction contract**

Retain only:

- `Exchange()` no-argument contract;
- `Material.A`, `A_field`, `Ms`, and `Ms_field` rows;
- Exchange-specific observable legality for `H_ex` and `E_ex`;
- T0/T1 `boundary_correction`, `boundary_phi_floor`, and `boundary_delta_min` rows in their FDM lane;
- minimal Exchange-specific Python-to-ProblemIR mapping and failure semantics.

Replace removed general tables with one short “Supporting Python API” paragraph linking the canonical owner pages.

- [ ] **Step 5: Run focused Python and source-map tests**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m unittest discover \
  -s packages/fullmag-py/tests -p 'test_public_*_documentation.py' -v
python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  public_docs/site/physics/exchange.source-map.json --repo-root .
```

Expected: all tests and Exchange source validation pass.

- [ ] **Step 6: Commit Task 4**

Stage only Exchange, Python API owner pages, and focused tests. Inspect staged paths and commit:

```text
docs: separate Exchange from general Python API
```

---

### Task 5: Full publication verification and integration review

**Files:**
- Modify only files required by failures directly caused by Tasks 1–4.
- Verify all changed files from the branch merge base.

**Interfaces:**
- Consumes: complete scaffold, validators, relocated API references, and scoped Exchange page.
- Produces: strict HTML build and evidence that the rendered Exchange page still has MathJax and copy controls.

- [ ] **Step 1: Run all focused source checks**

Run:

```bash
python3 scripts/public_docs_information_architecture.py --check --root public_docs/site
python3 -m unittest scripts/test_public_docs_information_architecture.py -v
python3 -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py' -v
PYTHONPATH=packages/fullmag-py/src python3 -m unittest discover \
  -s packages/fullmag-py/tests -p 'test_public_*_documentation.py' -v
python3 scripts/check_public_docs_boundary.py
./scripts/ci/contract_guard.sh --strict
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 2: Build public documentation strictly**

Run in Python 3.11 with `public_docs/site/requirements.txt` installed:

```bash
sphinx-build -b html -W -n --keep-going \
  public_docs/site public_docs/site/_build/html
```

Expected: Sphinx builds every page with no warnings.

- [ ] **Step 3: Validate rendered Exchange HTML**

Run:

```bash
python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  public_docs/site/physics/exchange.source-map.json --repo-root . \
  --rendered-html public_docs/site/_build/html/physics/exchange.html
```

Expected: rendered MathJax symbols and copy controls pass validation.

- [ ] **Step 4: Review planned-page honesty and branch scope**

Confirm every generated planned page is byte-for-byte canonical, every non-scaffold page has meaningful relocated content, and no source or test outside documentation ownership changed. Run:

```bash
git diff --name-only "$(git merge-base origin/master HEAD)"...HEAD
git status --short
```

Expected: only specification, plan, public docs, documentation scripts/workflows/skills, and focused Python documentation tests appear; worktree is clean after commit.

- [ ] **Step 5: Commit any verification-only correction**

If Step 1–4 exposed a directly related correction, stage only that correction, inspect the staged list, and commit:

```text
test(docs): complete public documentation verification
```

If no correction is required, create no empty commit.

- [ ] **Step 6: Whole-branch review**

Generate a review package from the branch merge base and dispatch a final reviewer against the approved specification. Resolve every Critical or Important finding, rerun the covering checks, and repeat review until clean.
