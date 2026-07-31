# Skill validation evidence

## RED baseline

The automated contract tests were created while the skill and validator were absent. They failed because `validate_scientific_docs` could not be imported and because `AGENTS.md` and `physics-publication` did not require the contract. This proved that the tests detect the missing behavior rather than passing against existing implementation.

Earlier pressure scenarios also exposed recurring failures: flattening FEM/FDM and CPU/GPU, replacing stable symbols with line ranges, accepting incomplete equations, omitting API-to-IR mapping, and treating structural checks as scientific proof.

The public-example guard adds a regression boundary for the authoring workflow: a normal
simulation-shaped Python block must use `fm.study(...)` and `study.stages.add_*`; direct
`fm.Problem(...)` is accepted only as a labelled non-running `ProblemIR`/schema inspection fixture.

## Regression scenarios

Repeat after material changes:

1. An urgent demagnetization publication whose four solver/backend lanes differ.
2. A DMI page with raw inline delimiters, incomplete symbol units, shared CPU/GPU prose, and file-only citations.
3. An Exchange page with a copyable Python example but one undocumented constructor parameter and a hand-written `ProblemIR` shape.
4. A GPU page whose code compiles but has no executed-device evidence.

Passing behavior blocks publication, demands the hierarchy, preserves full equations, requires every symbol/unit and public parameter, maps Python to canonical `ProblemIR`, uses path plus symbol, and separates structural validation from semantic/runtime proof.
