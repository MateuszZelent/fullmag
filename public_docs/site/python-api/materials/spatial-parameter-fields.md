---
title: Spatial Parameter Fields
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-materials-spatial-parameter-fields)=
# Spatial Parameter Fields

(python-api-materials-spatial-parameter-fields-problem-statement)=
<!-- (problem-statement)= -->
## Contract
This page records the current public Python authoring contract and canonical lowering; it does not redefine solver physics.

(python-api-materials-spatial-parameter-fields-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
This API page introduces no independent governing equation. Physical equations belong to interaction and solver-lane pages.

(python-api-materials-spatial-parameter-fields-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Every owned input has its SI unit below; $1$ denotes dimensionless data.

(python-api-materials-spatial-parameter-fields-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Constructor checks run immediately. Lowering and planning additionally check mesh cardinality, capability, and backend legality.

(python-api-materials-spatial-parameter-fields-python-api)=
<!-- (python-api)= -->
## Python API
No constructor parameters are owned by this conceptual page.

### Spatial field authoring

```python
# %% Define a spatially varying material parameter through the stage-first body API
import fullmag as fm

nm = 1.0e-9

study = fm.study("spatial_param_study")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 50 * nm, 10 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))

film.set_material_field(
    "Ms",
    fm.MaterialParameterField.linear(
        base=8.0e5,
        gradient=(0.0, 0.0, 1.0e12),
        frame="object",
        unit="A/m",
    ),
)
study.exchange()
study.stages.add_run(stage_id="run", until=1.0e-12)
```


(python-api-materials-spatial-parameter-fields-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
The final column gives the serialized destination owned by the current lowering implementation.

(python-api-materials-spatial-parameter-fields-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested intent is preserved in Python and IR. Resolved execution is selected by the planner. Validation errors reject malformed values; unsupported combinations fail capability checks without silent fallback.

(python-api-materials-spatial-parameter-fields-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
This page owns authoring and lowering only; numerical realization belongs to solver-lane documentation.

(python-api-materials-spatial-parameter-fields-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
The adjacent map anchors claims to `packages/fullmag-py/src/fullmag/model/structure.py` and `class Material`.

(python-api-materials-spatial-parameter-fields-validation)=
<!-- (validation)= -->
## Validation
Tests compare this inventory with live signatures and validate its source map.

(python-api-materials-spatial-parameter-fields-limitations)=
<!-- (limitations)= -->
## Limitations
Representability does not prove every backend combination executable; planner capabilities are authoritative.

(python-api-materials-spatial-parameter-fields-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced. Primary references belong to consuming interaction pages.

(python-api-materials-spatial-parameter-fields-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Constructor, validation, lowering | `packages/fullmag-py/src/fullmag/model/structure.py` | `class Material` | Canonical Python API behavior | Ownership test and source-map validator |
