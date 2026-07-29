---
title: Uniform Texture
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-magnets-and-textures-uniform-texture)=
# Uniform Texture

(python-api-magnets-and-textures-uniform-texture-problem-statement)=
<!-- (problem-statement)= -->
## Contract
This page records the current public Python authoring contract and canonical lowering; it does not redefine solver physics.

(python-api-magnets-and-textures-uniform-texture-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
This API page introduces no independent governing equation. Physical equations belong to interaction and solver-lane pages.

(python-api-magnets-and-textures-uniform-texture-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Every owned input has its SI unit below; $1$ denotes dimensionless data.

(python-api-magnets-and-textures-uniform-texture-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Constructor checks run immediately. Lowering and planning additionally check mesh cardinality, capability, and backend legality.

(python-api-magnets-and-textures-uniform-texture-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `texture.uniform.direction_or_x` | `three floats or scalar` | `(1, 0, 0)` | $1$ | Direction tuple or first Cartesian component of uniform reduced magnetization. | Direction tuple or first Cartesian component of uniform reduced magnetization. | FEM/FDM CPU/GPU; planner checks combinations | `magnets[].initial_magnetization.params.direction` |
| `texture.uniform.y` | `float \| None` | `None` | $1$ | Second component for scalar-form authoring. | Second component for scalar-form authoring. | FEM/FDM CPU/GPU; planner checks combinations | `magnets[].initial_magnetization.params.direction` |
| `texture.uniform.z` | `float \| None` | `None` | $1$ | Third component for scalar-form authoring. | Third component for scalar-form authoring. | FEM/FDM CPU/GPU; planner checks combinations | `magnets[].initial_magnetization.params.direction` |

```python
# %%
import inspect
import fullmag as fm
# %%
print(inspect.signature(fm.texture.uniform))
```

(python-api-magnets-and-textures-uniform-texture-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
The final column gives the serialized destination owned by the current lowering implementation.

(python-api-magnets-and-textures-uniform-texture-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested intent is preserved in Python and IR. Resolved execution is selected by the planner. Validation errors reject malformed values; unsupported combinations fail capability checks without silent fallback.

(python-api-magnets-and-textures-uniform-texture-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
This page owns authoring and lowering only; numerical realization belongs to solver-lane documentation.

(python-api-magnets-and-textures-uniform-texture-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
The adjacent map anchors claims to `packages/fullmag-py/src/fullmag/init/textures.py` and `uniform`.

(python-api-magnets-and-textures-uniform-texture-validation)=
<!-- (validation)= -->
## Validation
Tests compare this inventory with live signatures and validate its source map.

(python-api-magnets-and-textures-uniform-texture-limitations)=
<!-- (limitations)= -->
## Limitations
Representability does not prove every backend combination executable; planner capabilities are authoritative.

(python-api-magnets-and-textures-uniform-texture-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced. Primary references belong to consuming interaction pages.

(python-api-magnets-and-textures-uniform-texture-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Constructor, validation, lowering | `packages/fullmag-py/src/fullmag/init/textures.py` | `uniform` | Canonical Python API behavior | Ownership test and source-map validator |
