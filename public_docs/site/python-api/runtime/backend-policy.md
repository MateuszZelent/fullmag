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
<!-- (problem-statement)= -->
## Contract
Backend policy fixes the meaning of the backend, device, precision, and execution-mode identifiers
used across the runtime and planner.

(python-api-runtime-backend-policy-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
No physical equation is owned here.

(python-api-runtime-backend-policy-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
All values are identifiers; no physical units are owned here.

(python-api-runtime-backend-policy-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
The stage-builder helpers lowercase string identifiers before the canonical descriptor is built;
direct enum construction uses the lowercase enum values shown below. `Simulation` requires hybrid
backend and hybrid mode together. `RuntimeSelection` itself stores the two enum fields but does not
enforce that pairing.

(python-api-runtime-backend-policy-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|
| `BackendTarget` | `str` enum | `"auto"` | `auto`, `fdm`, `fem`, `hybrid` | Solver backend family | `runtime.backend_target` |
| `DeviceTarget` | `str` enum | `"auto"` | `auto`, `cpu`, `cuda`, `gpu` | Execution device | `runtime.device_target` |
| `ExecutionMode` | `str` enum | `"strict"` | `strict`, `extended`, `hybrid` | Execution policy | `runtime.execution_mode` |
| `ExecutionPrecision` | `str` enum | `"double"` | `single`, `double` | Floating-point precision | `runtime.execution_precision` |

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
<!-- (problem-ir)= -->
## ProblemIR
The enum values serialize as their lowercase strings inside the `runtime` block.

(python-api-runtime-backend-policy-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested policy is normalized to canonical lowercase identifiers. Invalid enum identifiers fail
when the canonical descriptor is constructed; hybrid/non-hybrid mismatches fail when constructing
`Simulation` and at planner boundaries. Resolved execution is reported independently by the v2
session/run resource.

(python-api-runtime-backend-policy-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
This page owns terminology only.

(python-api-runtime-backend-policy-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchors: `packages/fullmag-py/src/fullmag/model/problem.py` (`BackendTarget`, `DeviceTarget`,
`ExecutionMode`, `ExecutionPrecision`).

(python-api-runtime-backend-policy-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live enum values.

(python-api-runtime-backend-policy-limitations)=
<!-- (limitations)= -->
## Limitations
Identifier support does not prove lane executability; planner capability resolution is
authoritative.

(python-api-runtime-backend-policy-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced.

(python-api-runtime-backend-policy-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Policy enums | `packages/fullmag-py/src/fullmag/model/problem.py` | `BackendTarget`, `DeviceTarget`, `ExecutionMode`, `ExecutionPrecision` | Canonical policy vocabulary | Ownership test |
