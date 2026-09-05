# Publikacje naukowe i przykłady Fullmag

Wiążące rozwinięcie [AGENTS.md](../../AGENTS.md). Czytaj sekcje dotyczące zadania. Zachowano numerację kontraktów dla łatwego wyszukiwania; ścieżki w backtickach są względem repozytorium. Zasady procesu i uprawnień określa główny AGENTS.md.

## 6. Golden rule: physics before implementation

Before implementing any new physics or numerical feature, create or update a publication-style note in `docs/physics/`.

For every creation, modification, review, restructuring, or publication of physics,
solver, backend, interaction, numerical-method, Python-API, or `ProblemIR`
documentation, agents **MUST use `scientific-documentation-contract`**. Its
hierarchy, LaTeX/MathJax, complete parameter-table, Python-to-`ProblemIR`,
path-plus-symbol source mapping, backend separation, bibliography, source-index,
and automated validation gates are mandatory; publication documentation cannot
defer them to follow-up work.

Every such note must include:

1. physical problem statement,
2. governing equations,
3. symbols and **SI units**,
4. assumptions and validity limits,
5. FDM interpretation,
6. FEM interpretation,
7. CPU/GPU/backend interpretation where relevant,
8. public Python API impact,
9. `ProblemIR` impact,
10. planner/capability impact,
11. runtime/session impact,
12. artifact/provenance impact,
13. validation plan,
14. completeness checklist,
15. deferred work.

If the physics note is missing or incomplete, the task is **not implementation-ready**.

---

## 20. Reference-solver policy

`external_solvers/` is for **learning**, not copying.

Use them to study:

- workflow patterns,
- modular decomposition,
- performance architecture,
- validation style,
- packaging strategy.

### Learn specifically from

- **mumax3 / mumax+**
  - GPU-first FDM
  - lightweight scripting ergonomics
  - pragmatic relax/minimize semantics
  - FFT-centered operator layout
  - interaction files own parameters, field, energy, observables, and backend
    calls separately from run/relax workflow files

- **BORIS**
  - modular multiphysics
  - CUDA decomposition
  - large-scale GPU runtime patterns
  - CPU/CUDA implementations mirror each other by interaction and by ODE
    evaluator/integrator family

- **tetmag / tetrax**
  - FEM operator design
  - matrix-free ideas
  - frequency-domain architecture
  - demag/operator caching concepts
  - interactions are plugin-like units and experiments/workflows such as
    relaxation and eigen solve live above interactions

### Public-manual authoring pattern

Use the NeuralMag and TetraX manuals as presentation references for Fullmag's public
documentation:

- NeuralMag's `getting_started` progression is the model for executable onboarding:
  setup, geometry/material, state, interaction, stage, observables, output, and a
  complete script. Fullmag examples must be copyable `# %%` cells in execution order,
  with the public `fm.study(...).stages` workflow first.
- TetraX's interaction catalog is the model for discoverability: one canonical page or
  subtree per physical interaction, with API parameters, energy, effective field,
  observables, implementation lanes, qualification state, and references. Large
  interactions such as demagnetization may own focused subpages.
- Keep workflow guidance before exhaustive reference material, and link every
  parameter table, equation, backend section, and source map from the interaction's
  navigation path. Do not publish orphaned API tables or detached solver notes.
- Treat every documented code block as an executable contract: run it, verify its
  output or expected rejection, and state the exact status when the current builder
  cannot express the complete interaction graph.
- The canonical simulation-script pattern is the repository-owned stage scenario: start with
  `import fullmag as fm`, configure `fm.study(...)` with engine/device/mode, define the universe,
  geometry, material and magnetization, register interactions, append ordered
  `study.stages.add_*` stages, and configure autosave/outputs when relevant. Use
  `tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py` as the
  style reference and cite the exact scenario used.
- Never put `fm.Problem(...)` in `public_docs/site` documentation, tutorials, examples, or
  standard-problem snippets. Public scripts must use the stage-first `fm.study(...).stages`
  workflow. If a stage builder cannot express an interaction, document that boundary explicitly
  and show individual object-level `to_ir()` fragments or a repository scenario reference; do not
  fabricate a top-level snapshot or stage API.
- These manuals guide structure only. Never copy their code or infer Fullmag behavior
  from them; current Fullmag source, Python API, `ProblemIR`, planner, runtime, tests,
  and device evidence remain authoritative.

### Hard rule

Never paste code from external solvers into Fullmag.

---

## Reguły z korekt projektu

- Sphinx MathJax inline HTML legitimately serializes delimiters such as `\(...\)` inside `.math` elements; enforce MyST `$...$` in source, but never reject those delimiters globally in rendered HTML.
- Microwave antenna designs with a taper or constriction must use a full 3D conductor/current solve; never promote a translationally invariant 2.5D cross-section as the production model for width variation along current flow.
- FEM scenario scripts that mirror a standard-problem study must use a flat module-level `study` configuration; only small dedicated geometry helpers may be defined when they improve readability.
