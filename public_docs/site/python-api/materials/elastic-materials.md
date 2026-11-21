---
title: Elastic Materials
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Elastic materials

(public-docs-python-api-materials-elastic-materials)=
(python-api-materials-elastic-materials-problem-statement)=
## Problem statement

Elastic constants are authored in SI and serialized with the lower-case IR field names used by the source.

This page covers the Python authoring contract: construction validates cubic elastic stiffness constants, mass density, and optional mechanical damping in SI units, while `to_ir()` emits the canonical `ProblemIR` record with lower-case IR keys (`c11`, `c12`, `c44`, `density`, `mechanical_damping`).

(python-api-materials-elastic-materials-governing-equations)=
## Governing equations

Linear cubic elasticity defines symmetric Voigt stiffness components $C_{11}, C_{12}, C_{44}$ relating linear strain $\boldsymbol{\varepsilon}$ and stress $\boldsymbol{\sigma}$ with elastic energy density $w_{\mathrm{el}} = \frac{1}{2}\boldsymbol{\varepsilon}:\mathbb{C}:\boldsymbol{\varepsilon}$ over mass density $\rho$. Coupled magnetoelastic formulations and prescribed-strain limits are documented in {doc}`../../physics/interactions/magnetoelastic/index` and {doc}`../../physics/geometry-and-materials`.

(python-api-materials-elastic-materials-symbols-and-si-units)=
## Symbols and SI units

Cubic elastic constants (`C11`, `C12`, `C44`) use pascals ($\mathrm{Pa}$), mass density `rho` uses $\mathrm{kg\,m^{-3}}$, optional mechanical damping `eta_mech` uses $\mathrm{Pa\,s}$, and `name` is dimensionless ($1$).

(python-api-materials-elastic-materials-assumptions-and-validity)=
## Assumptions and validity

`name` must be non-empty, `C11`, `C12`, `C44`, and `rho` must be strictly positive finite scalars, and `eta_mech` must be non-negative and finite when supplied. Note that dynamic elastodynamics and mechanical damping remain schema vocabulary outside bounded prescribed-strain regimes.

(python-api-materials-elastic-materials-python-api)=
## Python API

### Constructor or function

`fm.ElasticMaterial(name, C11, C12, C44, rho, eta_mech=None)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `name` | `str` | `required` | $1$ | non-empty | material identifier | FEM CPU/GPU: IR; FDM not currently resolved | `name` |
| `C11/C12/C44` | `float` | `required` | $\mathrm{Pa}$ | positive | cubic elastic constants | FEM CPU/GPU: IR; FDM not currently resolved | `c11/c12/c44` |
| `rho` | `float` | `required` | $\mathrm{kg\,m^{-3}}$ | positive | mass density | FEM CPU/GPU: IR; FDM not currently resolved | `density` |
| `eta_mech` | `float or None` | `None` | $\mathrm{Pa\,s}$ | non-negative when supplied | mechanical damping | FEM CPU/GPU: IR; FDM not currently resolved | `mechanical_damping` |

### Stage-first example

```python
# %%
import fullmag as fm

study = fm.study("public-api-example")
study.objects.mesh.defaults(maximum_element_size=5e-9)
body = study.geometry(fm.Box(size=(100e-9, 20e-9, 5e-9)), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.stages.add_relax(stage_id="api-example", dt=5e-13, max_steps=1)
# Author the documented object after the stage exists.
value = fm.ElasticMaterial(name="substrate", C11=2.0e11, C12=1.0e11, C44=8.0e10, rho=7800.0)
canonical_ir = value.to_ir()
```

In a complete simulation script, attach `ElasticMaterial` to an `ElasticBody` referenced by `fm.Magnetoelastic(magnet, body, law)`.

(python-api-materials-elastic-materials-problem-ir)=
## ProblemIR

`value.to_ir()` emits `{"name": ..., "c11": ..., "c12": ..., "c44": ..., "density": ...}` (plus `"mechanical_damping"` if supplied), using the lower-case IR keys documented above.

(python-api-materials-elastic-materials-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves cubic elastic constants, density, and optional damping in `ProblemIR` independently of `resolved execution`. `Validation errors` reject non-positive moduli/density or negative damping, while `unsupported combinations` (such as elastodynamic displacement solves or FDM mechanics plans) fail closed at planning.

(python-api-materials-elastic-materials-discrete-realization)=
## Discrete realization

The Python contract supplies mechanical material parameters in `ProblemIR` only; evaluating strain/stress compatibility and magnetoelastic effective fields on discretized meshes belongs to the solver backends.

(python-api-materials-elastic-materials-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/mechanics.py` (`class ElasticMaterial`). Constructor validation, defaults, and lower-case `to_ir()` field mapping come directly from that module.

(python-api-materials-elastic-materials-validation)=
## Validation

Focused repository unit tests covering `ElasticMaterial` IR lowering include `test_elastic_material_serializes_canonical_ir`. Coupled mechanical solver runtime and Control Room behavior require separate qualification.

(python-api-materials-elastic-materials-limitations)=
## Limitations and Control Room

Control Room has no dedicated form editor for `fm.ElasticMaterial`; author elastic substrate and film materials in Python scripts. See {doc}`/frontend/capability-register`.

(python-api-materials-elastic-materials-scientific-bibliography)=
## Scientific bibliography

- L. D. Landau and E. M. Lifshitz, *Theory of Elasticity*, 3rd ed., Pergamon / Elsevier, [doi:10.1016/C2013-0-03754-0](https://doi.org/10.1016/C2013-0-03754-0).
- C. Kittel, “Physical Theory of Ferromagnetic Domains,” *Reviews of Modern Physics* **21**(4), 541–583 (1949), [doi:10.1103/RevModPhys.21.541](https://doi.org/10.1103/RevModPhys.21.541).

(python-api-materials-elastic-materials-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/mechanics.py` | `class ElasticMaterial` | public constructor and IR lowering |
