# Implementation Status and Next Plans after the Phase 1 Audit

- Status: active
- Last updated: 2026-03-23
- Related architecture spec: `docs/specs/exchange-only-full-solver-architecture-v1.md`
- Related active plan: `docs/plans/active/phase-0-1-implementation-plan.md`
- Related physics notes:
  - `docs/physics/0150-exchange-only-geometry-and-magnetization-bootstrap.md`
  - `docs/physics/0200-llg-exchange-reference-engine.md`

## 1. Why this document exists

The repository now contains enough code that a plan written before implementation is no longer
sufficient by itself.

We need one document that does three things at once:

1. verifies the real current implementation state,
2. decides which plan documents stay active and which do not,
3. defines the next focused plans without creating a large number of parallel documents.

This file is that document.

## 2. Audit basis

The status below is based on direct inspection of:

- `packages/fullmag-py/src/fullmag/model/geometry.py`
- `packages/fullmag-py/src/fullmag/init/magnetization.py`
- `packages/fullmag-py/src/fullmag/runtime/simulation.py`
- `packages/fullmag-py/src/fullmag/_core.py`
- `crates/fullmag-ir/src/lib.rs`
- `crates/fullmag-plan/src/lib.rs`
- `crates/fullmag-runner/src/lib.rs`
- `crates/fullmag-py-core/src/lib.rs`
- current specs and physics notes in `docs/specs/` and `docs/physics/`

## 3. Verified current implementation state

### 3.1 What is genuinely implemented

The following are no longer just planned:

- shared embedded Python API for exchange-only problems,
- analytic geometries:
  - `Box`
  - `Cylinder`
- richer initial magnetization semantics:
  - `uniform`
  - `random(seed)`
  - deferred `from_function(...)` stub
- canonical `ProblemIR` with:
  - geometry entries,
  - `RandomSeeded`,
  - `SampledField`,
  - typed `ExecutionPlanIR`
- `fullmag-plan` crate for Box-to-FDM planning,
- `fullmag-engine` reference exchange-only CPU kernel,
- `fullmag-runner` crate,
- PyO3 bridge from Python to the Rust runner,
- public `Simulation.run(until=...)` path for the narrow FDM subset.

### 3.2 What is executable today

The current **public-executable** path is:

> `Box + Exchange + LLG(heun) + fdm/strict + one ferromagnet + Python Simulation.run()`

This is real progress.
It means the old assumption that Phase 1 was merely planning-only is now obsolete.

### 3.3 What remains semantic-only or partial

The following are still not fully executable:

- FEM execution,
- imported geometry execution,
- `Cylinder` execution beyond serialization/planning,
- `from_function(...)` magnetization sampling,
- backend-neutral comparison tooling,
- full field artifact publication according to the output policy.

## 4. Important implementation gaps found in the audit

These gaps are important enough that the old phase plan must remain **active**, not archived.

### 4.1 Material parameters are not yet fully carried by the FDM execution plan

`crates/fullmag-runner/src/lib.rs` still contains a hardcoded Phase 1 shortcut:

- the runner creates `MaterialParameters::new(800e3, 13e-12, 0.5)`
- a TODO explicitly states that the planner should embed material parameters in the plan

This means the public execution path is real, but not yet semantically honest for arbitrary
material values.

### 4.2 Artifact publication is not yet aligned with the output policy

The runner writes:

- `metadata.json`
- `scalars.csv`
- `m_final.json`

but it does **not** yet publish:

- scheduled `H_ex` field artifacts,
- scheduled `m` snapshots,
- a fully backend-neutral field artifact layout matching the output policy.

So the current system is executable, but still below the standard declared in
`docs/specs/output-naming-policy-v0.md`.

### 4.3 The phase plan is ahead of the code in a few places

The active phase plan and capability matrix currently imply a slightly cleaner state than the code
actually delivers.

That is not a disaster, but it must be corrected by implementation or by more precise status labels.

## 5. Decision on plan archival

### 5.1 `phase-0-1-implementation-plan.md`

This plan is **not moved to completed**.

Reason:

- Phase 0 is complete.
- Phase 1 is materially implemented.
- But Phase 1 closeout is not finished because of the material-parameter and artifact gaps above.

The plan therefore remains in:

- `docs/plans/active/phase-0-1-implementation-plan.md`

### 5.2 Completed-plans archive

The directory:

- `docs/plans/completed/`

is created now and stays empty until a plan is actually closed.

This is intentional.
An empty archive is better than archiving an unfinished plan and losing execution focus.

## 6. Next active plans

To avoid document sprawl, we keep the next work split into **three active planning streams** only.

## 6A. Plan A — Phase 1 closeout and honesty hardening

### Goal

Make the current public FDM execution path fully truthful with respect to its own semantics and
docs, then close the Phase 1 plan.

### Deliverables

1. Embed material parameters into `FdmPlanIR`.
2. Remove runner-side hardcoded material defaults.
3. Publish scheduled field artifacts for:
   - `m`
   - `H_ex`
4. Align artifact writing with output naming policy.
5. Guarantee provenance includes the real execution plan and material values actually used.
6. Re-audit the capability matrix so `public-executable` means exactly what the code does.

### Technical tasks

- Extend `crates/fullmag-ir/src/lib.rs`:
  - add FDM plan material payload
  - version/compatibility notes if needed
- Update `crates/fullmag-plan/src/lib.rs`:
  - material lookup from `ProblemIR`
  - embed material data into `FdmPlanIR`
- Update `crates/fullmag-runner/src/lib.rs`:
  - consume material payload from plan
  - write field snapshots on schedule
  - remove Phase 1 hardcoded material shortcut
- Update Python/runtime tests to assert real material propagation.

### Acceptance criteria

- no hardcoded material constants remain in the runner,
- `Simulation.run()` respects material values authored in Python,
- artifact set includes scheduled `m` and `H_ex`,
- Phase 1 plan can be moved to `docs/plans/completed/`.

## 6B. Plan B — Phase 2 FEM exchange execution

### Goal

Deliver the first honest FEM execution path for exchange-only LLG under the same public semantics.

### Scope

Keep the first FEM executable path intentionally narrow:

- one magnet,
- exchange only,
- `strict` mode,
- direct mesh import first,
- Box meshing second.

### Deliverables

1. `FemPlanIR` upgraded from placeholder to executable plan.
2. FEM runner path in `fullmag-runner`.
3. Imported-mesh execution path.
4. Shared artifacts using the same observable names as FDM.
5. Cross-backend comparison for at least one reference case.

### Recommended execution order

1. Freeze FEM imported-mesh policy.
2. Write physics note for FEM exchange weak form and LLG realization.
3. Extend planner with imported-mesh FEM path.
4. Build first reference CPU FEM execution path.
5. Add projection/comparison against FDM.

### Acceptance criteria

- one Python problem runs on FEM end-to-end,
- output names remain canonical,
- cross-backend comparison exists,
- backend differences are documented under physics notes.

## 6C. Plan C — Physics publication program

### Goal

Make `docs/physics/` evolve like a coherent internal paper series rather than ad hoc notes.

### Why this is necessary

The local papers show the standard we should aim for:

- `scientific_papers/s41524-025-01893-y.pdf`
  - strong software-design narrative tied to implemented physics,
  - architecture plus applications in one coherent story
- `scientific_papers/5_0024382 -- 4b879d2281db22323be109c1ac0ba334 -- Anna’s Archive.pdf`
  - explicit design-and-verification framing,
  - clear overview of scope, implementation choices, and validation

Our physics notes should borrow that shape:

1. overview / motivation,
2. physical model,
3. numerical method,
4. software-design implications,
5. verification strategy,
6. limitations and future work.

### Required next physics documents

Create or extend the following sequence:

1. `0300-exchange-fdm-discretization.md`
   - full discrete stencil derivation
   - cell-center sampling conventions
   - artifact semantics for `H_ex`

2. `0310-exchange-fem-weak-form.md`
   - weak form,
   - FE-space choice,
   - normalization strategy,
   - natural boundary conditions

3. `0320-fdm-vs-fem-exchange-validation.md`
   - comparison protocol,
   - projection strategy,
   - tolerances,
   - benchmark geometries

4. `0400-llg-integrators-and-stability.md`
   - Heun baseline,
   - timestep policy,
   - future semi-implicit path,
   - error metrics and convergence observables

### Acceptance criteria

- every new numerical feature lands with a paper-style physics note,
- notes cite the corresponding code modules and specs,
- notes are usable as seeds for future publication supplements.

## 7. Recommended order of work

To keep momentum and avoid rework, the recommended order is:

1. **Plan A** — Phase 1 closeout and honesty hardening
2. **Plan C** — Physics publication program for FDM/FEM exchange notes
3. **Plan B** — FEM executable path

Reason:

- closing Plan A gives us an honest and stable FDM baseline,
- Plan C prevents the FEM work from getting ahead of its physics notes,
- Plan B then builds on both a trustworthy reference path and a proper documentation discipline.

## 8. Final status summary

### What we can already say honestly

- Fullmag is no longer only a planner for exchange-only FDM.
- It has a real public execution path on the FDM side.
- The Python API, `ProblemIR`, planner, runner, and reference engine are now connected.

### What we must still not overclaim

- Phase 1 is not fully closed.
- Artifact publication is incomplete.
- Material semantics are not yet carried cleanly enough through the execution plan.
- FEM remains a future plan, not an implemented backend.

This is the correct point to reorganize plans:

- keep long-lived specs in `docs/specs/`,
- keep unfinished implementation work in `docs/plans/active/`,
- move only truly finished plans to `docs/plans/completed/`.
