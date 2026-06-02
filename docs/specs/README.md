# Specs Directory

This directory contains **canonical, long-lived specifications** for Fullmag.

If you are looking for the main architecture document for the whole application, start here:

- **Primary application architecture:** `docs/specs/fullmag-application-architecture-v2.md`
- **Primary control-room API architecture:** `docs/specs/resource-first-control-room-api-v2.md`
- **Primary backend solver architecture:** `docs/architecture/backend-golden-masterplan.md`
- **Compatibility endpoint reference:** `docs/specs/control-room-api-endpoint-reference-v1.md`
- **Historical control-room API tree:** `docs/specs/control-room-api-tree-v1.md`

## Reading order

When you need to understand Fullmag quickly, read in this order:

1. `docs/specs/fullmag-application-architecture-v2.md`
2. `docs/specs/resource-first-control-room-api-v2.md`
3. `docs/architecture/backend-golden-masterplan.md`
4. `docs/specs/frontend-v2/README.md`
5. `docs/specs/session-run-api-v1.md`
6. `docs/specs/resource-first-control-room-api-v1.md`
7. `docs/specs/control-room-api-endpoint-reference-v1.md`
8. `docs/specs/control-room-api-tree-v1.md`
9. `docs/specs/command-lifecycle-v1.md`
10. `docs/specs/runtime-distribution-and-managed-backends-v1.md`
11. `docs/specs/hpc-cluster-execution-v1.md`
12. `docs/1_project_scope.md`
13. `docs/2_repo_blueprint.md`
14. `docs/specs/problem-ir-compatibility-v1.md`
15. `docs/specs/problem-ir-v0.md`
16. `docs/specs/capability-matrix-v0.md`
17. `docs/specs/native-fem-backend-architecture-v1.md` as historical migration input
18. `docs/specs/native-fem-magnetoelastic-patch-v1.md`
19. `docs/specs/mesh-roundtrip-semantics-v1.md`
20. `docs/specs/frequency-domain-artifacts-v2.md`
21. `docs/specs/viewport3d-contract-v1.md`
22. the relevant `docs/physics/` notes
23. the relevant `docs/plans/active/` plan

## Document hierarchy

### 1. Canonical application architecture

- `docs/specs/fullmag-application-architecture-v2.md`
- `docs/specs/resource-first-control-room-api-v2.md`
- `docs/specs/frontend-v2/README.md`
- `docs/specs/resource-first-control-room-api-v1.md`
- `docs/specs/control-room-api-endpoint-reference-v1.md`
- `docs/specs/control-room-api-tree-v1.md`

These are the highest-level descriptions of the whole Fullmag application and the
local control-room API lineage. The current browser API contract is v2; v1 files
are archived compatibility references for removed public `/v1/live/current/*`
routes and migration history.

It defines:

- the product north star,
- the source-of-truth hierarchy,
- the role of Python, `ProblemIR`, Rust, native backends, CLI, API, frontend, artifacts, and docs,
- the main user workflow and control-room transport,
- implementation priorities.

If the core concept of the application changes, these files must be updated.

The frontend v2 specs define the target modular control-room frontend, the
temporary `apps/legacy_web` legacy-reference policy, module-kernel boundaries, and
cutover acceptance. They do not override the resource-first API contract.

### 2. Solver architecture

- `docs/architecture/backend-golden-masterplan.md`
- `docs/specs/native-fem-backend-architecture-v1.md`
- `docs/specs/native-fem-magnetoelastic-patch-v1.md`
- `docs/specs/exchange-only-full-solver-architecture-v1.md`

`backend-golden-masterplan.md` is the accepted target architecture for backend
solver ownership, solver lanes, source layout, workflow ownership, runtime
selection, FEM demag model families, and production physics validation.

`native-fem-backend-architecture-v1.md` is a historical migration input from
the 2026-05-16 audit. Use it only where it helps preserve operator/module
lessons while moving FEM production work into the MFEM/hypre/libCEED-centered
architecture defined by the backend golden masterplan.

`native-fem-magnetoelastic-patch-v1.md` is the staged contract for moving from
the current prescribed-strain magnetoelastic slice to same-mesh quasistatic
two-way FEM magnetoelasticity.

`exchange-only-full-solver-architecture-v1.md` is the architecture for the
first physically meaningful solver slice.

The solver docs are subordinate to the application architecture and should be
read as:

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
- `docs/specs/frequency-domain-artifacts-v2.md`
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
`docs/specs/resource-first-control-room-api-v2.md`:

- the local `/v2/platform/*` and `/v2/sessions/current/*` API contract,
- control-plane vs data-plane boundaries,
- frontend API-client structure,
- revision or generation semantics,
- capability/adapters rules for FDM/FEM unification,
- OpenAPI and diagnostics requirements.

Whenever concrete current endpoint shapes, schemas, or transitional route
mapping change, also update:

- `docs/specs/resource-first-control-room-api-v2.md`

Whenever the route-family split or resource hierarchy changes, also update:

- `docs/specs/resource-first-control-room-api-v2.md`

Whenever the module kernel, browser shell, command registry, viewport lifecycle,
frontend cutover, or legacy `apps/web` status changes, also update:

- `docs/specs/frontend-v2/README.md`
- `docs/adr/0013-frontend-v2-module-kernel.md`
- `AGENTS.md`
- the relevant `.agents/skills/frontend-v2-*` skill when agent behavior must change

Whenever backend solver ownership, source layout, runtime selection, workflow
ownership, solver lane separation, FEM demag model family, or production
physics-validation policy changes, also update:

- `docs/architecture/backend-golden-masterplan.md`
- `.agents/skills/backend-golden-masterplan/SKILL.md` when agent behavior must
  change

For FEM/MFEM implementation details that touch `Context`, `mfem_bridge.cpp`,
CPU/GPU separation, operator extraction, demag strategy implementations, or FEM
solver qualification, also check:

- `.agents/skills/fem-native-backend-architecture/SKILL.md`
- `docs/specs/native-fem-backend-architecture-v1.md` as a historical migration
  input, not as the accepted target architecture
- `docs/adr/0014-native-fem-backend-modularization.md` when the long-lived
  decision changes
- `docs/physics/0900-native-fem-operator-contracts-and-validation.md`
