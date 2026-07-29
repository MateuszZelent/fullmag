---
title: LLG
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-dynamics-llg)=
# LLG

(python-api-dynamics-llg-problem-statement)=
<!-- (problem-statement)= -->
## Contract
This page records the current public Python authoring contract and canonical lowering; it does not redefine solver physics.

(python-api-dynamics-llg-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
This API page introduces no independent governing equation. Physical equations belong to interaction and solver-lane pages.

(python-api-dynamics-llg-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Every owned input has its SI unit below; $1$ denotes dimensionless data.

(python-api-dynamics-llg-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Constructor checks run immediately. Lowering and planning additionally check mesh cardinality, capability, and backend legality.

(python-api-dynamics-llg-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `LLG.gamma` | `float` | `221100.0` | $\mathrm{m\,A^{-1}\,s^{-1}}$ | Positive finite gyromagnetic ratio used by the H-field LLG convention. | Positive finite gyromagnetic ratio used by the H-field LLG convention. | FEM/FDM CPU/GPU; planner checks combinations | `study.dynamics.gamma` |
| `LLG.integrator` | `str` | `"auto"` | $1$ | Canonical supported integrator identifier or `auto`; planner and runtime legality are validated explicitly. | Canonical supported integrator identifier or `auto`; planner and runtime legality are validated explicitly. | FEM/FDM CPU/GPU; planner checks combinations | `study.dynamics.integrator` |
| `LLG.fixed_timestep` | `float \| None` | `None` | $\mathrm{s}$ | Positive fixed step when supplied; mutually constrained with adaptive stepping. | Positive fixed step when supplied; mutually constrained with adaptive stepping. | FEM/FDM CPU/GPU; planner checks combinations | `study.dynamics.fixed_timestep` |
| `LLG.adaptive_timestep` | `AdaptiveTimestep \| None` | `None` | $1$ | Optional adaptive-step contract. | Optional adaptive-step contract. | FEM/FDM CPU/GPU; planner checks combinations | `study.dynamics.adaptive_timestep` |
| `LLG.field_refresh` | `FieldRefreshPolicy \| None` | `None` | $1$ | Optional field-refresh policy. | Optional field-refresh policy. | FEM/FDM CPU/GPU; planner checks combinations | `study.dynamics.field_refresh` |

```python
# %%
import inspect
import fullmag as fm
# %%
print(inspect.signature(fm.LLG))
```

(python-api-dynamics-llg-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
The final column gives the serialized destination owned by the current lowering implementation.

(python-api-dynamics-llg-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested intent is preserved in Python and IR. Resolved execution is selected by the planner. Validation errors reject malformed values; unsupported combinations fail capability checks without silent fallback.

(python-api-dynamics-llg-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
This page owns authoring and lowering only; numerical realization belongs to solver-lane documentation.

(python-api-dynamics-llg-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
The adjacent map anchors claims to `packages/fullmag-py/src/fullmag/model/dynamics.py` and `class LLG`.

(python-api-dynamics-llg-validation)=
<!-- (validation)= -->
## Validation
Tests compare this inventory with live signatures and validate its source map.

(python-api-dynamics-llg-limitations)=
<!-- (limitations)= -->
## Limitations
Representability does not prove every backend combination executable; planner capabilities are authoritative.

(python-api-dynamics-llg-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced. Primary references belong to consuming interaction pages.

(python-api-dynamics-llg-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Constructor, validation, lowering | `packages/fullmag-py/src/fullmag/model/dynamics.py` | `class LLG` | Canonical Python API behavior | Ownership test and source-map validator |
