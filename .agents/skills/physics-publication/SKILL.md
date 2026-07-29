---
name: physics-publication
description: "Use when adding or modifying any Fullmag physics or numerics feature. Create or update a publication-style docs/physics note before code, then propagate semantics through Python DSL, ProblemIR, planner, runtime, OpenAPI, and unified workspace surfaces."
---

# Fullmag Physics Publication

## Goal

Enforce Fullmag's rule: physics first, implementation second. A solver patch without a canonical physical model, units, validation plan, and provenance impact is not implementation-ready.

**REQUIRED SUB-SKILL: use `scientific-documentation-contract`** for the note and
for every public physics, solver, backend, interaction, Python API, or
`ProblemIR` documentation page. The publication contract owns hierarchy,
MathJax/LaTeX, source mapping, API completeness, rendered-output checks, and the
terminal publication gate.

## When to trigger

- adding or changing an energy term, dynamics model, boundary condition, coupling, mesh interpretation, solver stage, observable, or numerical method,
- changing equations, units, assumptions, tolerances, stop criteria, or validation scope,
- changing backend interpretation, execution-selection semantics, capability coverage, or provenance,
- changing physics-facing UI authoring, script export, runtime resources, live quantities, or artifacts.

## Required outputs

1. A `docs/physics/<topic>.md` note based on `docs/physics/TEMPLATE.md`.
2. Physical problem statement, governing equations, symbols, SI units, assumptions, validity limits, and observables.
3. Explicit FDM and FEM interpretation, including CPU/GPU and precision implications where relevant.
4. Public Python DSL impact and UI script-export/round-trip impact.
5. `ProblemIR` lowering, validation, normalization, and migration impact.
6. Planner, capability matrix, execution selection, runtime stage lifecycle, and provenance impact.
7. OpenAPI/resource impact when domain, mesh, fields, quantities, scalars, commands, stages, artifacts, realtime events, or diagnostics change.
8. Unified workspace impact: ribbon commands, resource hooks, domain adapters, viewport layers, docks, and inspector panels.
9. Validation strategy, reference oracle, tolerances, artifacts, and regression tests.
10. Completeness checklist and deferred work.

For FEM/MFEM solver changes, also state the operator/subsystem boundary:
exchange, demag strategy, local interaction, direct torque, stepper,
runtime/residency, or observable. Production FEM means MFEM/hypre/libCEED for
CPU and GPU; do not describe new FEM physics as an implementation detail inside
`Context` or `mfem_bridge.cpp`.

For FEM/MFEM/CUDA/hypre/libCEED changes, runtime/build claims must be proven
through the container-backed repo `just` recipes (`just rebuild-fem-runtime`,
`just ensure-managed-fem-runtime`, `just fem-gpu-headless ...`,
`just verify-fem-relaxation-runtime`, or the matching managed run recipe).
Host `cargo`, `cmake`, or direct native binary checks are auxiliary smoke tests,
not publication-quality runtime evidence.
Do not start FEM build/debug work from host `cargo`, `cmake`, raw Docker, or a
direct binary when a managed/container `justfile` recipe covers the task. The
container-backed `just` route is the first build path, not just the final proof.

## Blocker policy

If the physics note is missing, incomplete, or vague about units/validity/backend interpretation, implementation is blocked. Do not hide this as "follow-up docs."

## Cascade

After the physics note is complete, apply the relevant skills in this order:

1. `scientific-documentation-contract`
2. `problem-ir-design`
3. `python-api-class`
4. `capability-matrix-check`
5. `backend-golden-masterplan` when backend ownership, solver lane, source layout, runtime selection, workflow ownership, FEM demag model family, or production validation is affected
6. `fem-native-backend-architecture` as the FEM/MFEM compatibility skill when `Context`, `mfem_bridge.cpp`, operator extraction, exchange, local terms, demag strategy implementations, stepper, CPU/GPU separation, or solver performance is affected
7. `resource-first-api-check` when browser/API/runtime resources, OpenAPI, generated types, realtime events, commands, codecs, or viewport data are affected
8. `adr-check` when the decision changes architecture or long-lived migration policy
