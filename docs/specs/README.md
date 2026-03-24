# Specs Directory

This directory contains **canonical, long-lived specifications** for Fullmag.

If you are looking for the main architecture document for the whole application, start here:

- **Primary application architecture:** `docs/specs/fullmag-application-architecture-v2.md`

## Reading order

When you need to understand Fullmag quickly, read in this order:

1. `docs/specs/fullmag-application-architecture-v2.md`
2. `docs/specs/session-run-api-v1.md`
3. `docs/1_project_scope.md`
4. `docs/2_repo_blueprint.md`
5. `docs/specs/problem-ir-v0.md`
6. `docs/specs/capability-matrix-v0.md`
7. the relevant `docs/physics/` notes
8. the relevant `docs/plans/active/` plan

## Document hierarchy

### 1. Canonical application architecture

- `docs/specs/fullmag-application-architecture-v2.md`

This is the highest-level, canonical description of the whole Fullmag application.

It defines:

- the product north star,
- the source-of-truth hierarchy,
- the role of Python, `ProblemIR`, Rust, native backends, CLI, API, frontend, artifacts, and docs,
- the main user workflow,
- implementation priorities.

If the core concept of the application changes, this file must be updated.

### 2. Solver architecture

- `docs/specs/exchange-only-full-solver-architecture-v1.md`

This is the architecture for the first physically meaningful solver slice.

It is subordinate to the application architecture and should be read as:

- how the first executable solver fits inside the whole app,
- not as the only architecture document for Fullmag.

### 3. Stable cross-cutting specs

- `docs/specs/session-run-api-v1.md`
- `docs/specs/problem-ir-v0.md`
- `docs/specs/capability-matrix-v0.md`
- `docs/specs/visualization-quantities-v1.md`

These define shared contracts used across multiple subsystems.

### 4. Policy specs

- `docs/specs/geometry-policy-v0.md`
- `docs/specs/material-assignment-and-spatial-fields-v0.md`
- `docs/specs/magnetization-init-policy-v0.md`
- `docs/specs/output-naming-policy-v0.md`
- `docs/specs/exchange-bc-policy-v0.md`

These define narrower but stable rules for specific concerns.

## How specs relate to plans

- `docs/specs/` contains long-lived truth.
- `docs/plans/active/` contains implementation work that is still in motion.
- `docs/plans/completed/` contains archived plans.

If a plan changes the long-term architecture or a stable policy, the corresponding file in
`docs/specs/` must also be updated.

## How specs relate to physics docs

`docs/physics/` is the canonical physics and numerics documentation layer.

Use it for:

- equations,
- units,
- discretization implications,
- validation strategy,
- scientific limitations.

Use `docs/specs/` for:

- application architecture,
- subsystem contracts,
- stable policy definitions,
- capability and IR semantics.

## Maintenance rule

Whenever one of these changes, update `docs/specs/fullmag-application-architecture-v2.md`:

- the main user workflow,
- the role of the frontend,
- the role of the CLI,
- the role of `ProblemIR`,
- backend ownership boundaries,
- the source-of-truth hierarchy,
- application-wide implementation priorities.

If those change and the canonical application architecture is not updated, the documentation is no
longer honest.
