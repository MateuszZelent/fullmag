---
name: physics-publication
description: "Use when adding or modifying Fullmag physics, numerics, solver semantics, interactions, boundary conditions, observables, or physics-facing authoring."
---

# Fullmag Physics Publication

Use this skill before implementing or publishing a semantic physics/numerics change. The user instruction and root `AGENTS.md` take precedence. Reuse skills already loaded in the current turn.

**REQUIRED SUB-SKILL: use `scientific-documentation-contract`** for the publication note and for public physics, solver, backend, interaction, Python API, or `ProblemIR` documentation. This is a one-way dependency: `scientific-documentation-contract` does not require this skill back.

## Trigger scope

Use for changes to energy terms, dynamics, boundary conditions, couplings, mesh interpretation, solver stages, observables, numerical methods, equations, units, tolerances, stop criteria, backend interpretation, execution selection, capability coverage, provenance, physics-facing UI authoring, script export, runtime quantities, or scientific artifacts.

Do not require a new publication note for a typo or an implementation-only change that preserves an already documented semantic contract; cite the existing note and update it only when the contract changes.

## Required outputs

When semantics change, update the relevant `docs/physics/<topic>.md` page from `docs/physics/TEMPLATE.md` with:

1. physical problem, equations, symbols, SI units, assumptions, validity limits, and observables;
2. explicit FDM/FEM and CPU/GPU interpretation where relevant;
3. Python DSL and UI script-export/round-trip impact;
4. `ProblemIR` lowering, validation, normalization, and migration;
5. planner, capability, execution-selection, runtime-stage, and provenance impact;
6. OpenAPI/resource impact when browser-visible;
7. unified workspace impact when commands, docks, inspectors, or viewport layers change;
8. validation oracle, tolerances, artifacts, regression tests, and completeness/deferred-work status.

Public examples use the repository stage-scenario shape: `fm.study(...)`, explicit engine/device/mode, universe/geometry/material/magnetization, interaction registration, ordered `study.stages.add_*`, and outputs/autosave where relevant. Use `tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py` as the style reference. Do not put `fm.Problem(...)` in any `public_docs/site` code block; use object-level `to_ir()` fragments only when stage registration is not exposed.

For FEM/MFEM work, state the operator boundary: exchange, demag strategy, local interaction, direct torque, stepper, runtime/residency, or observable. Production FEM means MFEM/hypre/libCEED for CPU and GPU. Do not place new physics in `Context` or `mfem_bridge.cpp`.

For FEM/MFEM/CUDA/hypre/libCEED claims, inspect the `justfile` and use the matching managed/container build/runtime recipe first. Host checks are auxiliary diagnostics, not publication-quality runtime evidence.

## Conditional cascade

After the publication note, apply only the relevant skills:

1. `scientific-documentation-contract` for the page and source-map contract;
2. `problem-ir-design` for `ProblemIR` semantics;
3. `python-api-class` for a public DSL construct;
4. `capability-matrix-check` for legality/planner/capability changes;
5. `backend-golden-masterplan` for backend ownership, lanes, runtime, workflows, demag families, or production validation;
6. `fem-native-backend-architecture` for MFEM/operator/Context/bridge/CPU-GPU/performance changes;
7. `resource-first-api-check` for browser resources, OpenAPI, events, commands, codecs, or viewport data;
8. `adr-check` for a durable architecture or migration decision.

If a required skill is already loaded in the current turn, reuse it and do not read it again unless the file changed or a referenced requirement is missing.

## Blocker policy

Block implementation or publication claims when the note lacks units, validity, backend interpretation, source evidence, or validation support. For read-only audits or planning, report the gap and continue; do not turn a missing future artifact into an unnecessary approval pause.
