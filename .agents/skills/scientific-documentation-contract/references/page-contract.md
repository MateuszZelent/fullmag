# Terminal scientific page contract

Read this file completely for every FullMag physics, solver, interaction, operator, or numerical-method documentation task.

## Hierarchy

Use domain → FEM/FDM → CPU/GPU → interaction or subsystem. Every terminal manifest includes a four-lane matrix for FEM/CPU, FEM/GPU, FDM/CPU, and FDM/GPU. Mark unsupported lanes with evidence-based reasons. Use separate chapters for differing lanes. Use `shared-proven` only with explicit parity evidence.

## Mandatory page structure

Every terminal Markdown page must contain these explicit MyST labels:

```text
(problem-statement)=
(governing-equations)=
(symbols-and-si-units)=
(assumptions-and-validity)=
(discrete-realization)=
(implementation-mapping)=
(validation)=
(limitations)=
(scientific-bibliography)=
(source-code-index)=
```

Store the manifest next to the page as `<page>.source-map.json`. The changed-page CI gate rejects a changed scientific page without this sidecar and rejects an orphaned or deleted sidecar while its page remains. The validator opens the actual page from `document.revision`; declarations in the manifest cannot substitute for page content.

## Equations and symbols

Write each production equation as a labelled MyST math block:

````markdown
```{math}
:label: eq-fdm-gpu-exchange-field
\mathbf H_{\mathrm{ex},i}=\frac{2}{\mu_0M_s}\sum_j c_{ij}(\mathbf m_j-\mathbf m_i)
```
````

The manifest LaTeX must match the page equation after whitespace normalization. Register every used symbol with:

- stable symbol ID;
- exact LaTeX token shown on the page;
- scientific definition shown on the page;
- SI unit shown on the page (`1` for dimensionless quantities).

Do not substitute a pedagogical equation for production. An implemented approximation requires its complete form, derivation or primary citation, validity/error regime, and code mapping.

## Equation-to-code and evidence mapping

Every nontrivial equation term contains:

- one or more source IDs;
- one or more numerical-test evidence IDs;
- an approved semantic review with reviewer identity and the same full SHA as the page.

Automated validation proves that the page, equation, symbols, source, and tests exist and agree structurally at the declared commit. It cannot prove mathematical equivalence by itself. Semantic approval and numerical/runtime evidence are mandatory and must not be inferred or fabricated.

## Source anchors

Each source contains repository-relative `path`, unique fully qualified `symbol` or `DOC-ANCHOR`, exact `responsibility`, `solver`, `lane`, and `revision`. Use `HEAD` for a page validated in the current commit; the validator resolves it to the full commit SHA. A historical publication may use a full 40-character SHA. Page, source, test evidence, and semantic review must resolve to the same commit. Optional `end_symbol` resolves a range. The validator reads source with `git show <sha>:<path>` and generates an immutable GitHub `#Lx-Ly` link.

Reject file-only citations, handwritten line-only citations, moving branch links, ambiguous symbols, absolute paths, traversal, and revisions absent from the repository.

## Test evidence

Each evidence record contains a tracked test path, stable test symbol, full SHA, and status `runtime-executed` or `validated`. GPU evidence additionally contains executed-device identity. Every equation term references evidence. Source presence, compilation, skipped-device tests, synthetic oracles, and host-only checks are not runtime proof.

Do not execute commands supplied by manifests. Run repository-owned, reviewed test or `just` recipes separately and record their immutable artifacts.

## Bibliography and source index

Use primary literature with author, title, venue, year, DOI or stable URL. The citation must appear in the actual page. End every page with a source-code index covering every equation/source pair, including resolved lines, immutable link, responsibility, tests, and status.

## Backend split

Separate chapters whenever lanes differ in operator, boundary treatment, precision, assembly/stencil/FFT/quadrature, memory ownership, libraries, tolerances, convergence, failure semantics, scope, or validation. Shared continuum physics may live in an overview but never implies implementation parity.

## Completion gate

Publication-ready means: the page and adjacent manifest pass the changed-page CI gate; actual page and all anchors exist at the resolved SHA; all equations exactly match; every symbol is defined with SI unit; every term maps to source and numerical evidence; source/test symbols resolve at the same SHA; all four backend lanes are classified; scientific bibliography and complete source index exist; semantic review is approved; runtime evidence supports each claim; public/internal routing is correct. Otherwise stop with the exact blocker.
