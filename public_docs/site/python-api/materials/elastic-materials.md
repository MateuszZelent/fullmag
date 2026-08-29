---
title: Elastic Materials
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-materials-elastic-materials)=
# Elastic Materials

(python-api-materials-elastic-materials-problem-statement)=
<!-- (problem-statement)= -->
## Contract
Elastic materials define linear elastic constitutive behavior for magnetoelastic bodies.

(python-api-materials-elastic-materials-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
Constitutive equations belong to {doc}`../../physics/interactions/magnetoelastic/index`.

(python-api-materials-elastic-materials-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Elastic constants are in pascals; mass density in $\mathrm{kg\,m^{-3}}$; damping is dimensionless.

(python-api-materials-elastic-materials-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Elastic constants and density must be positive; damping must be non-negative.

(python-api-materials-elastic-materials-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|---|
| `ElasticMaterial.name` | `str` | `required` | $1$ | Non-empty | Material name | `name` |
| `ElasticMaterial.C11` / `C12` / `C44` | `float` | `required` | $\mathrm{Pa}$ | Positive | Cubic elastic constants | `c11`, `c12`, `c44` |
| `ElasticMaterial.rho` | `float` | `required` | $\mathrm{kg\,m^{-3}}$ | Positive | Mass density | `density` |
| `ElasticMaterial.eta_mech` | `float \| None` | `None` | $1$ | Non-negative | Mechanical damping | `mechanical_damping` |

### Complete stage-first context

Elastic materials are attached to elastic bodies rather than constructed in isolation.

```python
# %% Declare a cubic elastic material
import fullmag as fm

nm = 1.0e-9

study = fm.study("elastic_materials_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

nm = 1.0e-9

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()

elastic = fm.ElasticMaterial(name="py_elastic", C11=2.0e11, C12=1.0e11, C44=1.0e11, rho=8.0e3)
study.stages.add_run(stage_id="run", until=1.0e-12)
```

(python-api-materials-elastic-materials-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`ElasticMaterial.to_ir()` emits `name`, `c11`, `c12`, `c44`, `density`, and optional
`mechanical_damping`.

(python-api-materials-elastic-materials-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Non-positive constants/density and negative damping fail immediately.

(python-api-materials-elastic-materials-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
Elastic coefficients feed the mechanics operator; realization belongs to the magnetoelastic lane.

(python-api-materials-elastic-materials-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/mechanics.py` (`class ElasticMaterial`).

(python-api-materials-elastic-materials-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-materials-elastic-materials-limitations)=
<!-- (limitations)= -->
## Limitations
Elastic material alone does not create a coupled problem; it must be assigned to an elastic body.

(python-api-materials-elastic-materials-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
Constitutive references belong to the magnetoelastic page.

(python-api-materials-elastic-materials-source-code-index)=
<!-- (source-code-index)= -->

## Control Room crosswalk

Status: Scalar magnetic fields are partial; spatial fields and material-law-specific parameters remain TODO.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Objects -> <object> -> Material` | `partial` | Apply material draft; dependent physics and mesh resources become stale |
| Parameters without a named UI field | `Model Explorer -> Objects -> <object> -> Material` | `TODO` | Python-only until implemented |

TODO: frontend support for spatial material fields and every parameter not rendered by ObjectMaterialPanel.
See [Control Room capability register](/frontend/capability-register) for the support matrix and TODO policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/ObjectMaterialPanel.tsx (ObjectMaterialPanel)`.

## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Elastic material | `packages/fullmag-py/src/fullmag/model/mechanics.py` | `class ElasticMaterial` | Constitutive lowering | Ownership test |
