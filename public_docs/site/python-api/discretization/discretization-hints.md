---
title: Discretization Hints
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-discretization-discretization-hints)=
# Discretization Hints

(python-api-discretization-discretization-hints-problem-statement)=
<!-- (problem-statement)= -->
## Contract
This page records the current public Python authoring contract and canonical lowering; it does not redefine solver physics.

(python-api-discretization-discretization-hints-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
This API page introduces no independent governing equation. Physical equations belong to interaction and solver-lane pages.

(python-api-discretization-discretization-hints-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Every owned input has its SI unit below; $1$ denotes dimensionless data.

(python-api-discretization-discretization-hints-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Constructor checks run immediately. Lowering and planning additionally check mesh cardinality, capability, and backend legality.

(python-api-discretization-discretization-hints-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `DiscretizationHints.fdm` | `FDM | None` | `None` | $1$ | FDM-specific hint; it does not force FDM when backend selection remains `auto`. | FDM-specific hint; it does not force FDM when backend selection remains `auto`. | FEM/FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints.fdm` |
| `DiscretizationHints.fem` | `FEM | None` | `None` | $1$ | FEM-specific hint; it does not force FEM when backend selection remains `auto`. | FEM-specific hint; it does not force FEM when backend selection remains `auto`. | FEM/FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints.fem` |
| `DiscretizationHints.hybrid` | `Hybrid | None` | `None` | $1$ | Optional hybrid hint. | Optional hybrid hint. | FEM/FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints.hybrid` |

```python
# %%
import inspect
import fullmag as fm
# %%
print(inspect.signature(fm.DiscretizationHints))
```

(python-api-discretization-discretization-hints-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
The final column gives the serialized destination owned by the current lowering implementation.

(python-api-discretization-discretization-hints-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested intent is preserved in Python and IR. Resolved execution is selected by the planner. Validation errors reject malformed values; unsupported combinations fail capability checks without silent fallback.

(python-api-discretization-discretization-hints-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
This page owns authoring and lowering only; numerical realization belongs to solver-lane documentation.

(python-api-discretization-discretization-hints-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
The adjacent map anchors claims to `packages/fullmag-py/src/fullmag/model/discretization.py` and `class DiscretizationHints`.

(python-api-discretization-discretization-hints-validation)=
<!-- (validation)= -->
## Validation
Tests compare this inventory with live signatures and validate its source map.

(python-api-discretization-discretization-hints-limitations)=
<!-- (limitations)= -->
## Limitations
Representability does not prove every backend combination executable; planner capabilities are authoritative.

(python-api-discretization-discretization-hints-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced. Primary references belong to consuming interaction pages.

(python-api-discretization-discretization-hints-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Constructor, validation, lowering | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class DiscretizationHints` | Canonical Python API behavior | Ownership test and source-map validator |
