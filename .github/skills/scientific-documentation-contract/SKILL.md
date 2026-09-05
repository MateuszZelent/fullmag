---
name: scientific-documentation-contract
description: "Use when creating, changing, reviewing, restructuring, or publishing Fullmag documentation about physics, numerical methods, FEM/FDM solvers, CPU/GPU realizations, interactions, Python APIs, ProblemIR, or scientific implementation claims."
---

# Scientific Documentation Contract

Use this skill for a terminal physics, solver, backend, interaction, numerical-method, Python API, ProblemIR, or scientific implementation page. It is the canonical documentation contract and does not require `physics-publication` back.

The user instruction and root `AGENTS.md` take precedence. Reuse already loaded skills and do not reread them unless a file changed or a required reference is missing.

## Core rule

Use one canonical scientific owner per physical interaction. Common physics, equations, symbols, SI units, Python API, and `ProblemIR` semantics belong there once; solver/device pages contain only material realization differences. A terminal page is incomplete when equations, symbols, SI units, realization distinctions, Python API, `ProblemIR`, source anchors, evidence, bibliography, or source-code index are missing.

Read `references/page-contract.md` completely before writing or reviewing a terminal page. Read `assets/source-map.example.json` when creating a source map.

## Authoring standard

- Use public manuals as presentation references, never as implementation truth.
- Make the first example executable and workflow-oriented, using `# %%` cells in execution order.
- The canonical Fullmag example starts with `fm.study(...)`, explicit engine/device/mode, geometry/material state, interaction registration, ordered `study.stages.add_*`, and relevant output/autosave.
- Use `tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py` as the style reference.
- Treat every code block as a contract: execute it or record the exact failure, expected output, and support state.
- Never put `fm.Problem(...)` in `public_docs/site`. Use object-level `to_ir()` fragments only when a public stage builder cannot represent the interaction graph.
- Do not copy external manual code or claims.

## Required workflow

1. Inspect current constructors, validators, lowering, `ProblemIR`, planner capabilities, solver sources, and tests.
2. Place the page under one canonical interaction owner and provide a support and qualification matrix with one row for FDM CPU, FDM GPU, FEM CPU, and FEM GPU.
3. Write production equations in complete LaTeX and define every symbol, exact token, scientific meaning, and SI unit in a MathJax-rendered table.
4. Add a complete Python authoring chapter with public parameters, defaults, validation/failure behavior, executable `# %%` example, and backend support.
5. Add canonical `ProblemIR`, exhaustive Python-to-IR mapping, normalization, requested intent, resolved execution, provenance, and unsupported-combination semantics.
6. Map every equation and nontrivial API/IR claim to a stable `path + symbol` or `DOC-ANCHOR`.
7. End the page with primary scientific references and a source-code index.
8. Store an adjacent `<page>.source-map.json` based on the example.

## Required validation

For a changed terminal page, run the focused validator and contract tests:

~~~powershell
python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py <page>.source-map.json --repo-root .
python3 -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p "test_*.py"
~~~

For changed-page review, also run:

~~~powershell
python3 .agents/skills/scientific-documentation-contract/scripts/validate_changed_scientific_docs.py --base <base-sha> --head HEAD --repo-root .
~~~

The public-documentation workflow additionally runs the public-example guard, strict Sphinx, and rendered-HTML checks. Use those when publishing or when the changed page requires rendered proof; do not rerun the repository-wide suite after an unchanged green result.

## Non-negotiable gates

- Use `$...$` for inline MathJax and labelled `{math}` blocks for governing, weak-form, discrete, field, energy, torque, and update equations.
- Give every symbol an exact LaTeX token, scientific meaning, and SI unit rendered as LaTeX; use `$1$` for dimensionless quantities.
- Keep shared physics in the canonical interaction page and include material implementation differences in explicit realization sections.
- Cover FDM CPU, FDM GPU, FEM CPU, and FEM GPU in the support and qualification matrix, including unsupported, planned, and unqualified states with reasons.
- Add separate realization sections only for material implementation differences such as algorithms, discretization, precision, memory, libraries, boundaries, convergence, failure semantics, or validation.
- Give scientifically large topics focused subtrees organized by independently useful physical or numerical boundaries.
- Document approximations with equation, derivation or citation, validity domain, error regime, and implementation mapping.
- Give every parameter type, default, SI unit, validation domain, meaning, backend support, and `ProblemIR` destination.
- Preserve requested intent separately from resolved execution and provenance.
- Cite repository-relative `path + symbol` or `DOC-ANCHOR`; file-only and line-only citations are insufficient.
- Require runtime/device evidence for GPU claims; source presence, compilation, and skipped tests are not parity proof.
- Publish user-facing material only through `public_docs/site/`; keep internal plans in `docs/`.

## Stop conditions

Stop and report the exact blocker for publication when a public parameter cannot be mapped, an equation or symbol is incomplete, a source symbol is ambiguous, a backend difference is collapsed, or validation evidence does not support the claim. For read-only audits and planning, report the gap and continue without claiming publication readiness.

## Common mistakes

- Four backend-owned copies of one interaction: keep one canonical owner and a realization matrix.
- One implementation section hiding lane differences: add explicit realization sections.
- `demag.cu lines 500–600`: cite path plus stable symbol or anchor.
- Plain-text units: render SI units as LaTeX.
- Minimal Python snippet: use complete `# %%` cells and every used parameter.
- JSON without provenance: show canonical serialized `ProblemIR`, mapping, normalization, and requested/resolved semantics.
- Structural validation as scientific proof: keep semantic review and numerical/runtime evidence separate.

When changing this skill or its validator, rerun the RED/GREEN scenarios in `references/validation-evidence.md`.
