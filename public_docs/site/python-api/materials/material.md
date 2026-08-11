---
title: Material
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-materials-material)=
# Material

(python-api-materials-material-problem-statement)=
<!-- (problem-statement)= -->
## Contract
This page records the current public Python authoring contract and canonical lowering; it does not redefine solver physics.

(python-api-materials-material-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
This API page introduces no independent governing equation. Physical equations belong to interaction and solver-lane pages.

(python-api-materials-material-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Every owned input has its SI unit below; $1$ denotes dimensionless data.

(python-api-materials-material-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Constructor checks run immediately. Lowering and planning additionally check mesh cardinality, capability, and backend legality.

(python-api-materials-material-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Material.name` | `str` | `required` | $1$ | Non-empty material identity referenced by magnets. | Non-empty material identity referenced by magnets. | FEM/FDM CPU/GPU; planner checks combinations | `materials[].name` |
| `Material.Ms` | `float` | `required` | $\mathrm{A\,m^{-1}}$ | Finite and positive saturation magnetization. | Finite and positive saturation magnetization. | FEM/FDM CPU/GPU; planner checks combinations | `materials[].saturation_magnetisation` |
| `Material.A` | `float` | `required` | $\mathrm{J\,m^{-1}}$ | Finite and positive bulk exchange stiffness; unusual-SI values outside $[10^{-14},10^{-8}]$ warn. | Finite and positive bulk exchange stiffness; unusual-SI values outside $[10^{-14},10^{-8}]$ warn. | FEM/FDM CPU/GPU; planner checks combinations | `materials[].exchange_stiffness` |
| `Material.alpha` | `float` | `required` | $1$ | Finite non-negative Gilbert damping. | Finite non-negative Gilbert damping. | FEM/FDM CPU/GPU; planner checks combinations | `materials[].damping` |
| `Material.Ku1` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | Finite signed first-order uniaxial anisotropy. | Finite signed first-order uniaxial anisotropy. | FEM/FDM CPU/GPU; planner checks combinations | `materials[].uniaxial_anisotropy` |
| `Material.Ku2` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | Finite signed second-order uniaxial anisotropy. | Finite signed second-order uniaxial anisotropy. | FEM/FDM CPU/GPU; planner checks combinations | `materials[].uniaxial_anisotropy_k2` |
| `Material.anisU` | `three floats or None` | `None` | $1$ | Finite three-vector defining the uniaxial axis; normalization and legality are checked downstream. | Finite three-vector defining the uniaxial axis; normalization and legality are checked downstream. | FEM/FDM CPU/GPU; planner checks combinations | `materials[].anisotropy_axis` |
| `Material.Kc1` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | First cubic-anisotropy coefficient; suspicious-SI values warn. | First cubic-anisotropy coefficient; suspicious-SI values warn. | FEM/FDM CPU/GPU; planner checks combinations | `materials[].cubic_anisotropy_kc1` |
| `Material.Kc2` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | Second cubic-anisotropy coefficient; suspicious-SI values warn. | Second cubic-anisotropy coefficient; suspicious-SI values warn. | FEM/FDM CPU/GPU; planner checks combinations | `materials[].cubic_anisotropy_kc2` |
| `Material.Kc3` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | Third cubic-anisotropy coefficient; suspicious-SI values warn. | Third cubic-anisotropy coefficient; suspicious-SI values warn. | FEM/FDM CPU/GPU; planner checks combinations | `materials[].cubic_anisotropy_kc3` |
| `Material.anisC1` | `three floats or None` | `None` | $1$ | Finite first cubic-anisotropy axis. | Finite first cubic-anisotropy axis. | FEM/FDM CPU/GPU; planner checks combinations | `materials[].cubic_anisotropy_axis1` |
| `Material.anisC2` | `three floats or None` | `None` | $1$ | Finite second cubic-anisotropy axis. | Finite second cubic-anisotropy axis. | FEM/FDM CPU/GPU; planner checks combinations | `materials[].cubic_anisotropy_axis2` |
| `Material.Dind` | `float \| None` | `None` | $\mathrm{J\,m^{-2}}$ | Finite interfacial-DMI material coefficient; it does not enable DMI by itself. | Finite interfacial-DMI material coefficient; it does not enable DMI by itself. | FEM/FDM CPU/GPU; planner checks combinations | `materials[].interfacial_dmi` |
| `Material.Dbulk` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | Finite bulk-DMI material coefficient; it does not enable DMI by itself. | Finite bulk-DMI material coefficient; it does not enable DMI by itself. | FEM/FDM CPU/GPU; planner checks combinations | `materials[].bulk_dmi` |
| `Material.Ms_field` | `list[float] \| None` | `None` | $\mathrm{A\,m^{-1}}$ | Optional spatial values overriding scalar `Ms`; mesh cardinality and lane legality are checked downstream. | Optional spatial values overriding scalar `Ms`; mesh cardinality and lane legality are checked downstream. | FEM/FDM CPU/GPU; planner checks combinations | `materials[].ms_field` |
| `Material.A_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-1}}$ | Optional spatial values overriding scalar `A`; not an FDM pair-coefficient lookup table. | Optional spatial values overriding scalar `A`; not an FDM pair-coefficient lookup table. | FEM/FDM CPU/GPU; planner checks combinations | `materials[].a_field` |
| `Material.alpha_field` | `list[float] \| None` | `None` | $1$ | Optional mesh-aligned damping values; cardinality and lane support are checked downstream. | Optional mesh-aligned damping values; cardinality and lane support are checked downstream. | FEM/FDM CPU/GPU; planner checks combinations | `materials[].alpha_field` |
| `Material.Ku_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | Optional spatial `Ku1` values. | Optional spatial `Ku1` values. | FEM/FDM CPU/GPU; planner checks combinations | `materials[].ku_field` |
| `Material.Ku2_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | Optional spatial `Ku2` values. | Optional spatial `Ku2` values. | FEM/FDM CPU/GPU; planner checks combinations | `materials[].ku2_field` |
| `Material.Kc1_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | Optional spatial `Kc1` values. | Optional spatial `Kc1` values. | FEM/FDM CPU/GPU; planner checks combinations | `materials[].kc1_field` |
| `Material.Kc2_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | Optional spatial `Kc2` values. | Optional spatial `Kc2` values. | FEM/FDM CPU/GPU; planner checks combinations | `materials[].kc2_field` |
| `Material.Kc3_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | Optional spatial `Kc3` values. | Optional spatial `Kc3` values. | FEM/FDM CPU/GPU; planner checks combinations | `materials[].kc3_field` |
| `Material.Dind_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-2}}$ | Optional spatial interfacial-DMI values. | Optional spatial interfacial-DMI values. | FEM/FDM CPU/GPU; planner checks combinations | `materials[].dind_field` |
| `Material.Dbulk_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | Optional spatial bulk-DMI values. | Optional spatial bulk-DMI values. | FEM/FDM CPU/GPU; planner checks combinations | `materials[].dbulk_field` |


### Complete material stage scenario

Material parameters are assigned to the study-owned magnetic body. This is the public equivalent
of the material record used by the solver; a standalone `Material(...)` cell is not a simulation.

```python
# %% Material values in a complete stage-first study
import fullmag as fm

nm = 1.0e-9
study = fm.study("material_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
study.exchange()
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.Ku1 = 5.0e5
film.anisU = (0.0, 0.0, 1.0)
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.solver(integrator="rk45", fix_dt=1.0e-15, gamma=2.211e5)
study.stages.add_run(stage_id="run", until=1.0e-9)
```

(python-api-materials-material-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
The final column gives the serialized destination owned by the current lowering implementation.

(python-api-materials-material-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested intent is preserved in Python and IR. Resolved execution is selected by the planner. Validation errors reject malformed values; unsupported combinations fail capability checks without silent fallback.

(python-api-materials-material-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
This page owns authoring and lowering only; numerical realization belongs to solver-lane documentation.

(python-api-materials-material-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
The adjacent map anchors claims to `packages/fullmag-py/src/fullmag/model/structure.py` and `class Material`.

(python-api-materials-material-validation)=
<!-- (validation)= -->
## Validation
Tests compare this inventory with live signatures and validate its source map.

(python-api-materials-material-limitations)=
<!-- (limitations)= -->
## Limitations
Representability does not prove every backend combination executable; planner capabilities are authoritative.

(python-api-materials-material-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced. Primary references belong to consuming interaction pages.

(python-api-materials-material-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Constructor, validation, lowering | `packages/fullmag-py/src/fullmag/model/structure.py` | `class Material` | Canonical Python API behavior | Ownership test and source-map validator |
