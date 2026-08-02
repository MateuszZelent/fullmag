# M1 FEM review remediation implementation plan

> Execute each task with red-green-refactor discipline. Native FEM proof uses
> repository-owned container-backed `just` recipes.

**Goal:** Preserve the complete resolved transport contract, fail before every
native call on any invalid plan, and publish all M1 transport quantities through
the canonical revisioned field data plane.

**Architecture:** The planner owns canonical resolution. A split FEM runtime
validates/materializes the entire plan before an ABI call, then solves and
returns generic canonical field snapshots. Existing artifact and API resource
paths consume those snapshots.

**Tech stack:** Rust, serde, Fullmag ProblemIR/planner/runner/API, MFEM C ABI,
repo-managed `just` verification.

### Task 1: Preserve resolved semantics and evidence axes

- Add failing IR/planner tests for charge/spin masks, insulating marker sets,
  interface identity, optional torque target, and canonical evidence values.
- Extend the resolved descriptor and planner materialization minimally.
- Run focused `fullmag-ir` and `fullmag-plan` tests.

### Task 2: Enforce all-plan preflight

- Add failing runner tests for duplicate module/source bindings, mutated
  canonical current definitions, and a later invalid plan preventing all ABI
  calls.
- Split descriptor validation from the ABI solve and preflight all plans first.
- Run focused runner tests.

### Task 3: Generalize the canonical field snapshot

- Add failing tests for scalar, vector, and nine-component tensor snapshots,
  invalid shapes, typed metadata, and monotonic revisions.
- Generalize `FieldSnapshot` to flattened values and add `from_vec3`.
- Adapt existing producers and the field artifact writer without a second
  carrier.
- Run runner artifact tests.

### Task 4: Publish transport quantities canonically

- Add a failing dispatch/artifact test proving all five quantities enter
  `ExecutedRun.field_snapshots` and persisted field artifacts.
- Move transport field construction into a focused publication module and keep
  summary JSON supplementary.
- Verify the v2 field reader accepts component counts 1, 3, and 9 and returns
  revision-aware metadata; add API tests only where the existing generic path
  lacks coverage.

### Task 5: Make provenance truthful and typed

- Add failing serialization tests for runtime family, capability status,
  independent evidence axes, torque target, and absent typed fallback/
  degradation.
- Split provenance construction into its own module and update docs/specs.
- Remove the duplicate weak quantity test and only the task-introduced rustfmt
  churn.

### Task 6: Verify and report

- Run focused tests after each green step.
- Run formatting and relevant workspace checks.
- Run the task brief's managed container-backed `just` gate and read the full
  output.
- Update `/tmp/fullmag-spin-transport/.superpowers/sdd/m1-fem-report.md` with
  exact commands, results, warnings, and remaining gaps.
- Review the isolated diff, commit it, and report the commit hash.
