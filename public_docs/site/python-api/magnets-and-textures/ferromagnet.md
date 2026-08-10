---
title: Ferromagnet
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-magnets-and-textures-ferromagnet)=
# Ferromagnet

(python-api-magnets-and-textures-ferromagnet-problem-statement)=
<!-- (problem-statement)= -->
## Contract
This page records the current public Python authoring contract and canonical lowering; it does not redefine solver physics.

(python-api-magnets-and-textures-ferromagnet-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
This API page introduces no independent governing equation. Physical equations belong to interaction and solver-lane pages.

(python-api-magnets-and-textures-ferromagnet-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Every owned input has its SI unit below; $1$ denotes dimensionless data.

(python-api-magnets-and-textures-ferromagnet-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Constructor checks run immediately. Lowering and planning additionally check mesh cardinality, capability, and backend legality.

(python-api-magnets-and-textures-ferromagnet-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Ferromagnet.name` | `str` | `required` | $1$ | Non-empty object identity. | Non-empty object identity. | FEM/FDM CPU/GPU; planner checks combinations | `magnets[].name` |
| `Ferromagnet.geometry` | `Geometry` | `required` | $1$ | Geometry occupied by the magnetic body. | Geometry occupied by the magnetic body. | FEM/FDM CPU/GPU; planner checks combinations | `magnets[].geometry` |
| `Ferromagnet.material` | `Material` | `required` | $1$ | Material supplying magnetic coefficients. | Material supplying magnetic coefficients. | FEM/FDM CPU/GPU; planner checks combinations | `magnets[].material` |
| `Ferromagnet.region` | `Region \| None` | `None` | $1$ | Optional named region; when absent, the geometry name becomes the magnet region. | Optional named region; when absent, the geometry name becomes the magnet region. | FEM/FDM CPU/GPU; planner checks combinations | `magnets[].region` |
| `Ferromagnet.m0` | `InitialMagnetization \| None` | `None` | $1$ | Initial reduced magnetization. | Initial reduced magnetization. | FEM/FDM CPU/GPU; planner checks combinations | `magnets[].initial_magnetization` |
| `Ferromagnet.mesh` | `PerObjectMeshRecipe \| None` | `None` | $1$ | Optional object-local mesh recipe. | Optional object-local mesh recipe. | FEM/FDM CPU/GPU; planner checks combinations | `magnets[].mesh` |
| `Ferromagnet.object_regions` | `tuple` | `()` | $1$ | Authored object-local regions lowered into `object_regions`; names and ownership are validated. | Authored object-local regions lowered into `object_regions`; names and ownership are validated. | FEM/FDM CPU/GPU; planner checks combinations | `magnets[].object_regions` |
| `Ferromagnet.allocated_region_ids` | `tuple of strings` | `()` | $1$ | Reserved region identities used by builder and round-trip ownership. | Reserved region identities used by builder and round-trip ownership. | FEM/FDM CPU/GPU; planner checks combinations | `magnets[].allocated_region_ids` |
| `Ferromagnet.material_parameter_fields` | `tuple` | `()` | $1$ | Object-owned spatial material assignments lowered into `material_parameter_fields`. | Object-owned spatial material assignments lowered into `material_parameter_fields`. | FEM/FDM CPU/GPU; planner checks combinations | `magnets[].material_parameter_fields` |
| `Ferromagnet.absorbing_boundary` | `AbsorbingBoundaryLayer \| None` | `None` | $1$ | Optional per-object additive Gilbert-damping layer; `AbsorbingBoundaryLayer` validates widths, faces, profile, and frame. | Object-scoped damping ramp at selected boundary faces. | FEM/FDM CPU/GPU authoring; planner and runtime capability-gate the resolved lane. | `magnets[].absorbing_boundary` |


### Complete ferromagnet stage scenario

The stage builder owns the public workflow. Material values, geometry, and initial magnetization
are assigned to the returned magnetic body before the solver and stages are declared.

```python
# %% Ferromagnet authoring in a complete stage-first study
import fullmag as fm

nm = 1.0e-9
study = fm.study("ferromagnet_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.cell(2 * nm, 2 * nm, 5 * nm)
study.exchange()
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.solver(integrator="rk45", fix_dt=1.0e-15, gamma=2.211e5)
study.stages.add_run(stage_id="run", until=1.0e-9)
```

(python-api-magnets-and-textures-ferromagnet-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
The final column gives the serialized destination owned by the current lowering implementation.

(python-api-magnets-and-textures-ferromagnet-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested intent is preserved in Python and IR. Resolved execution is selected by the planner. Validation errors reject malformed values; unsupported combinations fail capability checks without silent fallback.

(python-api-magnets-and-textures-ferromagnet-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
This page owns authoring and lowering only; numerical realization belongs to solver-lane documentation.

(python-api-magnets-and-textures-ferromagnet-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
The adjacent map anchors claims to `packages/fullmag-py/src/fullmag/model/structure.py` and `class Ferromagnet`.

(python-api-magnets-and-textures-ferromagnet-validation)=
<!-- (validation)= -->
## Validation
Tests compare this inventory with live signatures and validate its source map.

(python-api-magnets-and-textures-ferromagnet-limitations)=
<!-- (limitations)= -->
## Limitations
Representability does not prove every backend combination executable; planner capabilities are authoritative.

(python-api-magnets-and-textures-ferromagnet-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced. Primary references belong to consuming interaction pages.

(python-api-magnets-and-textures-ferromagnet-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Constructor, validation, lowering | `packages/fullmag-py/src/fullmag/model/structure.py` | `class Ferromagnet` | Canonical Python API behavior | Ownership test and source-map validator |
