---
title: Simulation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-runtime-simulation)=
# Simulation

(python-api-runtime-simulation-problem-statement)=
<!-- (problem-statement)= -->
## Contract
`Simulation` wraps a canonical `Problem` with an explicit backend, mode, and precision, and exposes
plan and execute entrypoints.

(python-api-runtime-simulation-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
This page introduces no physical equation; it owns the execution lifecycle.

(python-api-runtime-simulation-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
The stop time `until` is in seconds. Other fields are identifiers.

(python-api-runtime-simulation-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Hybrid backend/mode coupling is validated on construction. `run(until=...)` requires a positive
stop time.

(python-api-runtime-simulation-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| --- | --- | --- | $1$ | --- | --- | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | --- |
| `Simulation.problem` | `Problem` | `required` | $1$ | Canonical problem | Problem to execute | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | problem body |
| `Simulation.backend` | `BackendTarget \| str \| None` | problem runtime | $1$ | Auto/cpu/gpu as enum | Resolved backend | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `requested_backend` |
| `Simulation.mode` | `ExecutionMode \| str \| None` | problem runtime | $1$ | strict/extended/hybrid | Execution policy | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `execution_mode` |
| `Simulation.precision` | `ExecutionPrecision \| str \| None` | problem runtime | $1$ | single/double | Floating-point precision | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `execution_precision` |

### Complete stage-first example

```python
# %% Stage-first authoring lowers to the canonical problem
import fullmag as fm

nm = 1.0e-9

study = fm.study("simulation_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.stages.add_run(stage_id="run", until=1.0e-9)
```

The normal public path does not construct `Simulation` directly; the study builder lowers to
`Problem` and the runtime executes it.

(python-api-runtime-simulation-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`Simulation.to_ir()` delegates to `Problem.to_ir()` and injects `requested_backend`,
`execution_mode`, and `execution_precision`.

(python-api-runtime-simulation-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in ProblemIR; resolved execution is the planner or realization result. Validation errors identify the violated domain rule, and unsupported combinations are rejected explicitly rather than silently substituted.

`run(until=None)` and `plan()` return a `Result` with `status="planned"` and do not execute. A
missing native core returns `status="not-executable"` with an explanatory note rather than
fabricating results.

(python-api-runtime-simulation-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
Execution goes through the native runner (`run_problem_json`) and current-device lanes; see the
backend pages for solver detail.

(python-api-runtime-simulation-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/runtime/simulation.py` (`class Simulation`).

(python-api-runtime-simulation-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-runtime-simulation-limitations)=
<!-- (limitations)= -->
## Limitations
The executable public subset is narrower than the authoring surface; anything outside it returns
an honest not-executable error instead of a silent fallback.

(python-api-runtime-simulation-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced.

(python-api-runtime-simulation-source-code-index)=
<!-- (source-code-index)= -->

## Control Room crosswalk

Status: Runtime and provenance data are inspection-only; they are not standalone authoring controls.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Runtime` | `inspection-only` | No runtime-authoring transaction |
| Parameters without a named UI field | `Model Explorer -> Runtime` | `not implemented` | Python-only until implemented |

not implemented: frontend support for runtime-selection and artifact-publication parameters.
See [Control Room capability register](/frontend/capability-register) for the support matrix and not implemented policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/RuntimeExplorerInspectorPanels.tsx (RuntimeExplorerInspectorPanels)`.

## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Execution lifecycle | `packages/fullmag-py/src/fullmag/runtime/simulation.py` | `class Simulation` | Plan/execute entrypoints | Ownership test |

### Source-map coverage

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Plan, IR export, and execution lifecycle. | `packages/fullmag-py/src/fullmag/runtime/simulation.py` | `class Simulation` | Plan, IR export, and execution lifecycle. | Source-map validator and focused API tests |
