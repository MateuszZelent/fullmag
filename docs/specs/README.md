# Specs Directory

This directory contains **canonical, long-lived specifications** for Fullmag.

If you are looking for the main architecture document for the whole application, start here:

- **Primary application architecture:** `docs/specs/fullmag-application-architecture-v2.md`
- **Primary control-room API architecture:** `docs/specs/resource-first-control-room-api-v2.md`
- **Compatibility endpoint reference:** `docs/specs/control-room-api-endpoint-reference-v1.md`
- **Primary control-room API tree:** `docs/specs/control-room-api-tree-v1.md`

## Reading order

When you need to understand Fullmag quickly, read in this order:

1. `docs/specs/fullmag-application-architecture-v2.md`
2. `docs/specs/resource-first-control-room-api-v2.md`
3. `docs/specs/resource-first-control-room-api-v1.md`
4. `docs/specs/control-room-api-endpoint-reference-v1.md`
5. `docs/specs/control-room-api-tree-v1.md`
6. `docs/specs/session-run-api-v1.md`
7. `docs/specs/command-lifecycle-v1.md`
8. `docs/specs/runtime-distribution-and-managed-backends-v1.md`
9. `docs/specs/hpc-cluster-execution-v1.md`
10. `docs/1_project_scope.md`
11. `docs/2_repo_blueprint.md`
12. `docs/specs/problem-ir-compatibility-v1.md`
13. `docs/specs/problem-ir-v0.md`
14. `docs/specs/capability-matrix-v0.md`
15. `docs/specs/mesh-roundtrip-semantics-v1.md`
16. `docs/specs/viewport3d-contract-v1.md`
17. the relevant `docs/physics/` notes
18. the relevant `docs/plans/active/` plan

## Document hierarchy

### 1. Canonical application architecture

- `docs/specs/fullmag-application-architecture-v2.md`
- `docs/specs/resource-first-control-room-api-v2.md`
- `docs/specs/resource-first-control-room-api-v1.md`
- `docs/specs/control-room-api-endpoint-reference-v1.md`
- `docs/specs/control-room-api-tree-v1.md`

These are the highest-level, canonical descriptions of the whole Fullmag application and the
current local control-room API contract.

It defines:

- the product north star,
- the source-of-truth hierarchy,
- the role of Python, `ProblemIR`, Rust, native backends, CLI, API, frontend, artifacts, and docs,
- the main user workflow and control-room transport,
- implementation priorities.

If the core concept of the application changes, these files must be updated.

### 2. Solver architecture

- `docs/specs/exchange-only-full-solver-architecture-v1.md`

This is the architecture for the first physically meaningful solver slice.

It is subordinate to the application architecture and should be read as:

- how the first executable solver fits inside the whole app,
- not as the only architecture document for Fullmag.

### 3. Stable cross-cutting specs

- `docs/specs/resource-first-control-room-api-v2.md`
- `docs/specs/session-run-api-v1.md`
- `docs/specs/control-room-api-endpoint-reference-v1.md`
- `docs/specs/control-room-api-tree-v1.md`
- `docs/specs/resource-first-control-room-api-v1.md`
- `docs/specs/command-lifecycle-v1.md`
- `docs/specs/runtime-distribution-and-managed-backends-v1.md`
- `docs/specs/hpc-cluster-execution-v1.md`
- `docs/specs/problem-ir-compatibility-v1.md`
- `docs/specs/problem-ir-v0.md`
- `docs/specs/capability-matrix-v0.md`
- `docs/specs/visualization-quantities-v1.md`
- `docs/specs/mesh-roundtrip-semantics-v1.md`
- `docs/specs/viewport3d-contract-v1.md`

These define shared contracts used across multiple subsystems.

New control-room API work starts from `resource-first-control-room-api-v2.md` and the generated
OpenAPI v2 document. The v1 specs are archived historical references; public v1 browser routes have
been removed.

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

Whenever one of these changes, also update
`docs/specs/resource-first-control-room-api-v1.md`:

- the local `/v1/live/current/*` API contract,
- control-plane vs data-plane boundaries,
- frontend API-client structure,
- revision or generation semantics,
- capability/adapters rules for FDM/FEM unification,
- OpenAPI and diagnostics requirements.

Whenever concrete current endpoint shapes, schemas, or transitional route
mapping change, also update:

- `docs/specs/control-room-api-endpoint-reference-v1.md`

Whenever the route-family split or resource hierarchy changes, also update:

- `docs/specs/control-room-api-tree-v1.md`
