---
name: scientific-documentation-contract
description: Use when creating, changing, reviewing, restructuring, or publishing Fullmag documentation about physics, numerical methods, FEM/FDM solvers, CPU/GPU realizations, interactions, Python APIs, ProblemIR, or scientific implementation claims.
---

# Scientific Documentation Contract

## Core rule

Make publication documentation mirror implementation ownership and prove every scientific and API claim from current code. Use the hierarchy **domain → solver → backend → interaction**. A page is incomplete when equations, symbols, SI units, backend distinctions, Python API, `ProblemIR`, source anchors, evidence, bibliography, or source-code index are missing.

For physics or numerics work, **REQUIRED SUB-SKILL:** use `physics-publication`. Read [references/page-contract.md](references/page-contract.md) completely before writing or reviewing a terminal page.

## Required workflow

1. Inspect the current public Python constructors, validators, lowering, `ProblemIR`, planner capabilities, solver sources, and tests. Never reconstruct behavior from memory.
2. Place the page in the implementation hierarchy and cover FEM CPU, FEM GPU, FDM CPU, and FDM GPU explicitly. Split chapters whenever implementation or support differs.
3. Write every production equation in complete LaTeX. Define every symbol, including SI unit, in a MathJax-rendered table. Do not replace implemented terms with pedagogical approximations.
4. Add a complete Python authoring chapter: every public parameter, a copyable executable `python` example organized with `# %%` cells, validation/failure behavior, and backend support.
5. Add the canonical `ProblemIR` representation, exhaustive Python-to-IR mapping, normalization, requested intent, planner-resolved execution, and unsupported-combination semantics.
6. Map equations and API claims to stable `path + symbol` identities. Generated line links may supplement them; handwritten line ranges never replace them.
7. End every terminal page with primary scientific references and a source-code index covering each equation and implementation claim.
8. Store an adjacent `<page>.source-map.json` based on [assets/source-map.example.json](assets/source-map.example.json).
9. Run the validator and focused tests:

```bash
python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  <page>.source-map.json --repo-root .
python3 -m unittest discover \
  -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
```

For a pull request or branch diff, require every changed scientific page to carry
its adjacent source map:

```bash
python3 .agents/skills/scientific-documentation-contract/scripts/validate_changed_scientific_docs.py \
  --base <base-sha> --head HEAD --repo-root .
```

The public-documentation workflow runs both validator test suites, the changed-page
gate, source validation, strict Sphinx, and rendered-HTML validation. The repository-wide
contract guard revalidates every published source map on code changes so a renamed or removed
implementation symbol cannot leave a silently stale scientific page.

10. Build Sphinx with warnings as errors. Then validate rendered HTML so inline symbols are MathJax nodes and code blocks expose copy controls:

```bash
python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  <page>.source-map.json --repo-root . --rendered-html <page>.html
```

## Non-negotiable gates

- Use `$...$` for inline math under MyST `dollarmath`; reject raw `\(...\)` delimiters.
- Use labelled `{math}` blocks for governing, weak-form, discrete, field, energy, torque, and update equations.
- Give every symbol an exact LaTeX token, scientific meaning, and SI unit rendered as LaTeX (`$1$` for dimensionless quantities).
- Keep CPU and GPU, and FEM and FDM, in separate chapters whenever algorithms, discretization, precision, memory ownership, libraries, boundaries, convergence, support, failure semantics, or validation differ.
- Document actual approximations completely: equation, derivation or citation, validity domain, error regime, and implementation.
- Provide complete parameter tables. Every row includes type, default, SI unit, validation domain, meaning, backend support, and `ProblemIR` destination.
- Preserve requested intent separately from resolved execution and provenance.
- Cite repository-relative path and unique symbol or `DOC-ANCHOR`; reject file-only and line-only citations.
- Require runtime/device evidence for GPU execution claims. Source presence, compilation, and skipped tests are not parity proof.
- Keep internal development plans in `docs/`; publish user-facing material only through `public_docs/site/`.

## Stop conditions

Stop and report the exact blocker when a public parameter cannot be mapped, an equation or symbol is incomplete, a source symbol is ambiguous, a backend difference is collapsed, or validation evidence does not support the claim. Never fill scientific gaps by inference and never publish with `TODO`, `TBD`, or “to be documented”.

## Common mistakes

| Mistake | Required correction |
|---|---|
| One “implementation” section for all lanes | Create explicit FEM/FDM and CPU/GPU realization chapters. |
| `demag.cu lines 500–600` | Cite repository path plus stable function/class/anchor; generate lines from the revision. |
| Plain-text units such as `J/m` | Render the unit as LaTeX, for example `$\mathrm{J\,m^{-1}}$`. |
| Minimal Python snippet | Provide complete `# %%` cells and every used constructor parameter. |
| JSON shown without provenance | Show canonical serialized `ProblemIR`, mapping, normalization, and requested/resolved semantics. |
| Structural validator treated as scientific proof | Require semantic review and numerical/runtime evidence as separate gates. |

When changing this skill or its validator, repeat the RED/GREEN scenarios in [references/validation-evidence.md](references/validation-evidence.md).
