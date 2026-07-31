# Physics documentation standard

- Status: active
- Last updated: 2026-03-23

## Mission

Every note in `docs/physics/` should read like an internal publication note or the seed of a future scientific supplement.

## Required sections

Every new topic must contain at least:

1. **Problem statement**
   - What is being modeled?
   - Why is it needed?
   - What physical or numerical scope does it cover?

2. **Physical model**
   - governing equations,
   - symbol definitions,
   - SI units,
   - assumptions and approximations.

3. **Numerical interpretation**
   - FDM interpretation,
   - FEM interpretation,
   - hybrid interpretation,
   - semantic differences between backends.

4. **API and IR impact**
   - Python API objects,
   - `ProblemIR` fields,
   - planner impact,
   - capability-matrix impact.

5. **Validation strategy**
   - analytical checks,
   - cross-backend checks,
   - regression cases,
   - observables and tolerances.

6. **Completeness checklist**
   - Python API,
   - `ProblemIR`,
   - planner,
   - capability matrix,
   - FDM backend,
   - FEM backend,
   - hybrid backend,
   - outputs,
   - tests,
   - documentation.

7. **Known limits and deferred work**

## Quality bar

A note is complete only when it lets a reviewer answer:

- Are we implementing the right physics?
- Are we implementing it consistently across the stack?
- Do we know how to validate it?
- Do we understand what is intentionally out of scope?

## Public executable examples

Public simulation examples follow the repository-owned stage-scenario convention used by
`tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py`: configure
`fm.study(...)`, engine/device/mode, universe, geometry, material and magnetization, interactions,
ordered `study.stages.add_*` stages, and outputs/autosave where relevant. Do not present
`fm.Problem(...)` must not appear in any `public_docs/site` code block. If a stage registration is
not available, show individual object-level `to_ir()` fragments and state the limitation instead
of constructing a top-level snapshot.
