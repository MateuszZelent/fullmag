---
title: Elastic Materials
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Elastic materials

(public-docs-python-api-materials-elastic-materials)=
(python-api-materials-elastic-materials-problem-statement)=
## Problem statement

`ElasticMaterial` defines cubic linear elastic constants, mass density, and optional mechanical
damping in SI units, and `ElasticBody` binds an `ElasticMaterial` to a geometric solid for
magnetoelastic coupling. Both serialize with lower-case IR field names (`c11`, `c12`, `c44`,
`density`, `mechanical_damping`, `geometry`, `elastic_material`).

(python-api-materials-elastic-materials-governing-equations)=
## Governing equations

Linear cubic elasticity defines symmetric Voigt stiffness components $C_{11}, C_{12}, C_{44}$
relating linear strain $\boldsymbol{\varepsilon}$ and stress $\boldsymbol{\sigma}$ with elastic
energy density $w_{\mathrm{el}} = \frac{1}{2}\boldsymbol{\varepsilon}:\mathbb{C}:\boldsymbol{\varepsilon}$
over mass density $\rho$. Coupled magnetoelastic formulations and prescribed-strain limits are
documented in {doc}`../../physics/interactions/magnetoelastic/index` and
{doc}`../../physics/geometry-and-materials`.

(python-api-materials-elastic-materials-symbols-and-si-units)=
## Symbols and SI units

Cubic elastic constants (`C11`, `C12`, `C44`) use pascals ($\mathrm{Pa}$), mass density `rho` uses
$\mathrm{kg\,m^{-3}}$, optional mechanical damping `eta_mech` uses $\mathrm{Pa\,s}$, and `name`,
`geometry`, and `elastic_material` bindings are dimensionless ($1$).

(python-api-materials-elastic-materials-assumptions-and-validity)=
## Assumptions and validity

`name` must be non-empty, `C11`, `C12`, `C44`, and `rho` must be strictly positive finite scalars,
and `eta_mech` must be non-negative and finite when supplied. `ElasticBody` requires a non-empty
`name`, a typed `geometry` object, and an `ElasticMaterial` instance. Dynamic elastodynamics and
mechanical damping remain capability-gated outside bounded prescribed-strain regimes.

(python-api-materials-elastic-materials-python-api)=
## Python API

### Constructors

- `fm.ElasticMaterial(name, C11, C12, C44, rho, eta_mech=None)`
- `fm.ElasticBody(name, geometry, elastic_material)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `ElasticMaterial.name` | `str` | `required` | $1$ | non-empty | elastic material identifier | FEM CPU/GPU: IR; FDM not currently resolved | `elastic_materials[].name` |
| `ElasticMaterial.C11` | `float` | `required` | $\mathrm{Pa}$ | finite and positive | cubic Voigt stiffness $C_{11}$ | FEM CPU/GPU: IR; FDM not currently resolved | `elastic_materials[].c11` |
| `ElasticMaterial.C12` | `float` | `required` | $\mathrm{Pa}$ | finite and positive | cubic Voigt stiffness $C_{12}$ | FEM CPU/GPU: IR; FDM not currently resolved | `elastic_materials[].c12` |
| `ElasticMaterial.C44` | `float` | `required` | $\mathrm{Pa}$ | finite and positive | cubic Voigt shear stiffness $C_{44}$ | FEM CPU/GPU: IR; FDM not currently resolved | `elastic_materials[].c44` |
| `ElasticMaterial.rho` | `float` | `required` | $\mathrm{kg\,m^{-3}}$ | finite and positive | mass density | FEM CPU/GPU: IR; FDM not currently resolved | `elastic_materials[].density` |
| `ElasticMaterial.eta_mech` | `float \| None` | `None` | $\mathrm{Pa\,s}$ | finite and non-negative when supplied | mechanical damping coefficient | FEM CPU/GPU: IR; FDM not currently resolved | `elastic_materials[].mechanical_damping` |
| `ElasticBody.name` | `str` | `required` | $1$ | non-empty | elastic body identifier | FEM CPU/GPU: IR; FDM not currently resolved | `elastic_bodies[].name` |
| `ElasticBody.geometry` | `Geometry` | `required` | $1$ | typed geometry object | geometric solid of the elastic body | FEM CPU/GPU: IR; FDM not currently resolved | `elastic_bodies[].geometry` |
| `ElasticBody.elastic_material` | `ElasticMaterial` | `required` | $1$ | `ElasticMaterial` instance | elastic material assigned to the body | FEM CPU/GPU: IR; FDM not currently resolved | `elastic_bodies[].elastic_material` |

### Stage-first example

```python
# %% Stage-first authoring with ElasticMaterial and ElasticBody
import fullmag as fm

study = fm.study("elastic_material_api_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(maximum_element_size=5e-9)

film_geom = fm.Box(size=(100e-9, 20e-9, 5e-9), name="film")
body = study.geometry(film_geom, name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.stages.add_relax(stage_id="api-example", dt=5e-13, max_steps=1)

# Construct ElasticMaterial and ElasticBody and verify canonical IR:
substrate_mat = fm.ElasticMaterial(
    name="ggg_substrate",
    C11=2.85e11,
    C12=1.15e11,
    C44=9.0e10,
    rho=7080.0,
)
substrate_body = fm.ElasticBody(
    name="substrate_body",
    geometry=fm.Box(size=(100e-9, 20e-9, 20e-9), name="substrate"),
    elastic_material=substrate_mat,
)
assert substrate_mat.to_ir()["c11"] == 2.85e11
assert substrate_body.to_ir()["elastic_material"] == "ggg_substrate"
```

In a complete magnetoelastic study, reference `ElasticBody` together with a `MagnetostrictionLaw`
from `fm.Magnetoelastic(magnet, body, law)`.

(python-api-materials-elastic-materials-problem-ir)=
## ProblemIR

- `ElasticMaterial.to_ir()` emits `{"name": ..., "c11": ..., "c12": ..., "c44": ..., "density": ...}` (plus `"mechanical_damping"` when `eta_mech` is set) under `elastic_materials[]`.
- `ElasticBody.to_ir()` emits `{"name": ..., "geometry": <geometry_name>, "elastic_material": <material_name>}` under `elastic_bodies[]`.

(python-api-materials-elastic-materials-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves cubic elastic constants, density, optional damping, and `ElasticBody`
geometry/material bindings in `ProblemIR` independently of `resolved execution`. `Validation errors`
reject non-positive moduli/density, negative damping, or untyped body operands, while
`unsupported combinations` (such as unimplemented elastodynamic displacement solves or FDM mechanics
plans) fail closed at planning.

(python-api-materials-elastic-materials-discrete-realization)=
## Discrete realization

| Solver | Device | Elastic material & body support | Qualification boundary |
| --- | --- | --- | --- |
| FDM | CPU | Not currently resolved for elastic displacement solves (fails closed at planner) | Authoring/IR only |
| FDM | GPU | Not currently resolved for elastic displacement solves (fails closed at planner) | Authoring/IR only |
| FEM | CPU | Consumed by bounded prescribed-strain and magnetoelastic FEM paths | See {doc}`../../physics/interactions/magnetoelastic/index` |
| FEM | GPU | Planner-gated for bounded magnetoelastic FEM regimes | Executed-device GPU qualification remains separate |

(python-api-materials-elastic-materials-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/mechanics.py`
(`class ElasticMaterial` and `class ElasticBody`).

(python-api-materials-elastic-materials-validation)=
## Validation

Focused repository unit tests covering `ElasticMaterial` and `ElasticBody` IR lowering include
`test_elastic_material_serializes_canonical_ir`. Coupled mechanical solver runtime and Control Room
behavior require separate qualification.

(python-api-materials-elastic-materials-limitations)=
## Limitations and Control Room

Control Room has no dedicated form editor for `fm.ElasticMaterial` or `fm.ElasticBody`; author
elastic substrate and film materials in Python scripts. See {doc}`/frontend/capability-register`.

(python-api-materials-elastic-materials-scientific-bibliography)=
## Scientific bibliography

- L. D. Landau and E. M. Lifshitz, *Theory of Elasticity*, 3rd ed., Pergamon / Elsevier, [doi:10.1016/C2013-0-03754-0](https://doi.org/10.1016/C2013-0-03754-0).
- C. Kittel, “Physical Theory of Ferromagnetic Domains,” *Reviews of Modern Physics* **21**(4), 541–583 (1949), [doi:10.1103/RevModPhys.21.541](https://doi.org/10.1103/RevModPhys.21.541).

(python-api-materials-elastic-materials-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/mechanics.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/mechanics.py#L13) | [`class ElasticMaterial`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/mechanics.py#L13) | cubic elastic material constructor and IR lowering |
| [`packages/fullmag-py/src/fullmag/model/mechanics.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/mechanics.py#L61) | [`class ElasticBody`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/mechanics.py#L61) | elastic body binding geometry and `ElasticMaterial` |
