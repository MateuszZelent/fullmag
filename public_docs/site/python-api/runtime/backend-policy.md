---
title: Backend Policy
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-runtime-backend-policy)=
# Backend Policy

(python-api-runtime-backend-policy-problem-statement)=
## Contract
Backend policy fixes the meaning of the backend, device, precision, and execution-mode identifiers
used across the runtime and planner.

(python-api-runtime-backend-policy-governing-equations)=
## Governing equations
No physical equation is owned here.

(python-api-runtime-backend-policy-symbols-and-si-units)=
## Symbols and SI units
All values are dimensionless policy identifiers ($1$); no physical units are owned here.

(python-api-runtime-backend-policy-assumptions-and-validity)=
## Assumptions and validity
Enum coercion is case-insensitive and fail-closed. Hybrid backend and hybrid mode must be selected
together; any other pairing is rejected.

(python-api-runtime-backend-policy-python-api)=
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `BackendTarget` | `str` enum | `"auto"` | $1$ | `auto`, `fdm`, `fem`, `hybrid` | Solver backend family | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `runtime.backend_target` |
| `DeviceTarget` | `str` enum | `"auto"` | $1$ | `auto`, `cpu`, `cuda`, `gpu` | Execution device | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `runtime.device_target` |
| `ExecutionMode` | `str` enum | `"strict"` | $1$ | `strict`, `extended`, `hybrid` | Execution policy | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `runtime.execution_mode` |
| `ExecutionPrecision` | `str` enum | `"double"` | $1$ | `single`, `double` | Floating-point precision | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `runtime.execution_precision` |

### Mode semantics

- `strict` — the requested combination must be exactly executable or planning fails.
- `extended` — permits documented transitional or compatibility lanes as resolved by the planner.
- `hybrid` — spans backend families and therefore requires `backend_target=hybrid`.

### Complete stage-first example

```python
# %% Backend policy via stage-first study
import fullmag as fm

nm = 1.0e-9

study = fm.study("backend_policy_api_example")
study.engine("fdm")
study.device("cuda:0", precision="double")
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

(python-api-runtime-backend-policy-problem-ir)=
## ProblemIR
The enum values serialize as their lowercase strings inside the `runtime` block.

(python-api-runtime-backend-policy-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in `ProblemIR`; resolved execution is the planner or realization result. Validation errors identify the violated domain rule, and unsupported combinations are rejected explicitly rather than silently substituted.

Requested policy is preserved verbatim. Resolution is reported independently. Invalid identifiers
and hybrid/non-hybrid mismatches fail immediately.

(python-api-runtime-backend-policy-discrete-realization)=
## Discrete realization
This page owns terminology only.

(python-api-runtime-backend-policy-implementation-mapping)=
## Implementation mapping
Anchors: `packages/fullmag-py/src/fullmag/model/problem.py` (`BackendTarget`, `DeviceTarget`,
`ExecutionMode`, `ExecutionPrecision`).

(python-api-runtime-backend-policy-validation)=
## Validation
Ownership tests compare this inventory with live enum values.

(python-api-runtime-backend-policy-limitations)=
## Limitations
Identifier support does not prove lane executability; planner capability resolution is
authoritative.

(python-api-runtime-backend-policy-scientific-bibliography)=
## Scientific bibliography
No physical model is introduced.

## Control Room support

Status: Runtime and provenance data are inspection-only; they are not standalone authoring controls.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Runtime` | `inspection-only` | No runtime-authoring transaction |
| Parameters without a named UI field | `Model Explorer -> Runtime` | `Python-only` | Authored in Python |

Runtime-selection parameters outside the workspace runtime panel remain Python-only.
See [Control Room capability register](/frontend/capability-register) for the UI support matrix.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/RuntimeExplorerInspectorPanels.tsx` (`RuntimeExplorerInspectorPanels`).

(python-api-runtime-backend-policy-source-code-index)=
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Backend-family policy vocabulary | [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/problem.py#L1560) | [`class BackendTarget`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/problem.py#L1560), `DeviceTarget`, `ExecutionMode`, `ExecutionPrecision` | Canonical policy enums and vocabulary | Ownership and API contract tests |
| Runtime policy state and lowering | [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/problem.py#L1764) | [`class RuntimeSelection`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/problem.py#L1764) | Runtime selection state and lowering | Ownership and API contract tests |
