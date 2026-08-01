# Terminal scientific page contract

Read this file completely for every terminal physics, solver, backend, interaction, operator, or numerical-method page.

## Mandatory structure

Use this hierarchy and preserve it in navigation and headings:

1. physical domain;
2. solver family: FEM or FDM;
3. execution backend: CPU or GPU;
4. interaction or numerical subsystem.

A backend-neutral overview may state only genuinely shared physics. Each of FEM CPU, FEM GPU, FDM CPU, and FDM GPU must have a documented, unsupported-with-reason, or not-applicable-with-reason lane. A different operator, discretization, precision, library, boundary treatment, memory model, convergence rule, capability, failure mode, or validation requires a separate chapter.

Every terminal page has these MyST labels:

```text
(problem-statement)=
(governing-equations)=
(symbols-and-si-units)=
(assumptions-and-validity)=
(python-api)=
(problem-ir)=
(round-trip-and-failure-semantics)=
(discrete-realization)=
(implementation-mapping)=
(validation)=
(limitations)=
(scientific-bibliography)=
(source-code-index)=
```

## Mathematics

Use `$...$` for inline MathJax and labelled `{math}` directives for display equations. The table of symbols must contain the exact LaTeX token used by equations, its unambiguous meaning, and an SI unit expressed in LaTeX. Use `$1$` for dimensionless quantities. Define indices, operators, domains, measures, constants, material fields, and derived quantities—not only headline variables.

Document the equation implemented in code. If code intentionally approximates the model, include the exact approximation, derivation or primary citation, applicability and error regime, and mapping to implementation and validation.

## Python API and ProblemIR

Use ordinary MyST `python` blocks with copy controls enabled by Sphinx. A complete example must be directly copyable and parse as Python; divide it into notebook-compatible `# %%` cells without prompts or hidden state.

For every public constructor/object/parameter used or exposed by the interaction, document:

- public qualified name;
- type;
- default or `required`;
- SI unit in LaTeX;
- complete validation domain and errors;
- physical meaning;
- FEM/FDM CPU/GPU support;
- canonical `ProblemIR` destination and normalization.

Show canonical serialized `ProblemIR` produced from the example, not a hand-shaped lookalike. Explain Python-to-IR mapping, round-trip behavior, validation rejection, requested intent, resolved backend/runtime, provenance, and unsupported combinations. Verify parsing automatically and execute current lowering through a repository-owned test whenever it is runtime-independent.

## Source and evidence mapping

Use repository-relative `path + symbol` or `path + DOC-ANCHOR` as stable identity. Resolve line links from a full commit SHA when publishing. A moving branch URL, bare file, or handwritten line range is not an anchor.

Every equation and nontrivial API/IR claim maps to source and test evidence. Runtime claims require executed-runtime evidence; GPU claims require device identity. Automated structure checks do not prove mathematical equivalence, so publication also requires semantic scientific review and appropriate numerical validation.

## Terminal sections

The bibliography uses primary literature with DOI or stable URL where available. The final source-code index lists equation/claim, path, symbol, responsibility, solver/backend lane, tests, evidence status, and generated immutable link. The adjacent `.source-map.json` is part of the page, not optional metadata.
