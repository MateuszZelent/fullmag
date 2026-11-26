---
title: Magnetoelastic Python API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Magnetoelastic interaction

(magnetoelastic-api-problem-statement)=
## Problem statement

`fm.Magnetoelastic` links already-authored magnetic, mechanical, and magnetostriction law objects by stable identifiers, while `fm.ElasticBody` binds an elastic geometry to an `fm.ElasticMaterial` and the mechanical dynamics mode descriptors (`fm.PrescribedStrain`, `fm.QuasistaticElasticity`, `fm.Elastodynamics`) declare the intended mechanical coupling regime.

This page covers the Python authoring contract: construction validates non-empty identifier triples, elastic body links, and mechanical dynamics policy parameters in Python, while `to_ir()` emits canonical `ProblemIR` records.

(python-api-interactions-magnetoelastic-governing-equations)=
## Governing equations

Magnetoelastic coupling computes an effective anisotropy-like field $\mathbf{H}_{\mathrm{mel}} = -\frac{1}{\mu_0 M_s}\frac{\partial w_{\mathrm{mel}}(\mathbf{m}, \boldsymbol{\varepsilon})}{\partial \mathbf{m}}$ connecting magnetization $\mathbf{m}$ on `magnet`, strain state $\boldsymbol{\varepsilon}$ on `body`, and constitutive constants defined by `law`. Energy densities and bounded prescribed-strain, quasistatic, and elastodynamic regimes are documented in {doc}`../../physics/interactions/magnetoelastic/index`, {doc}`../materials/elastic-materials`, {doc}`../materials/magnetostriction-laws`, and {doc}`../boundary-conditions/mechanical-boundary-conditions`.

(python-api-interactions-magnetoelastic-symbols-and-si-units)=
## Symbols and SI units

- `fm.Magnetoelastic` link identifiers (`magnet`, `body`, `law`) and `fm.ElasticBody` fields (`name`, `geometry`, `elastic_material`) are dimensionless identifiers or typed references ($1$).
- Mechanical mode parameters: `QuasistaticElasticity.max_picard_iterations` ($1$), `QuasistaticElasticity.picard_tolerance` ($1$), and `Elastodynamics.mechanical_dt` in $\mathrm{s}$.
- Physical magnetoelastic constants (`B1`, `B2` in $\mathrm{Pa}$, or dimensionless $\lambda_s$) and elastic moduli (`C11`, `C12`, `C44` in $\mathrm{Pa}$, density `rho` in $\mathrm{kg\,m^{-3}}$) reside on the referenced `fm.MagnetostrictionLaw` and `fm.ElasticMaterial` records.

(python-api-interactions-magnetoelastic-assumptions-and-validity)=
## Assumptions and validity

- `magnet`, `body`, and `law` on `fm.Magnetoelastic`, as well as `ElasticBody.name`, must be non-empty strings.
- `fm.QuasistaticElasticity` requires `max_picard_iterations >= 1` and finite `picard_tolerance > 0`.
- `fm.Elastodynamics` requires finite `mechanical_dt > 0` whenever supplied (when `None`, the mechanical step matches the LLG timestep).
- Unresolved entity links or unsupported coupled mechanics regimes fail closed during planning.

(python-api-interactions-magnetoelastic-python-api)=
## Python API

### Constructor or function

`fm.Magnetoelastic(magnet, body, law)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `magnet` | `str` | `required` | $1$ | non-empty magnet link | magnetic object link | FEM/FDM CPU/GPU: IR; coupled mechanics runtime required | `magnet` |
| `body` | `str` | `required` | $1$ | non-empty body link | mechanical body link | FEM/FDM CPU/GPU: IR; coupled mechanics runtime required | `body` |
| `law` | `str` | `required` | $1$ | non-empty law link | magnetostriction law link | FEM/FDM CPU/GPU: IR; coupled mechanics runtime required | `law` |

### Companion elastic body and mechanical dynamics modes

| Type | Parameters & defaults | Validation & SI units | ProblemIR output (`to_ir()`) |
|---|---|---|---|
| `fm.ElasticBody` | `name: str`, `geometry: Geometry`, `elastic_material: ElasticMaterial` | `name` non-empty; binds geometry (`geometry.geometry_name`) and material (`elastic_material.name`) | `{"name", "geometry", "elastic_material"}` |
| `fm.PrescribedStrain` | *(no parameters)* | no mechanical solve; reads strain/stress from `fm.MechanicalLoad` | `{"kind": "prescribed_strain"}` |
| `fm.QuasistaticElasticity` | `max_picard_iterations: int = 3`, `picard_tolerance: float = 1e-6` | `max_picard_iterations >= 1`, `picard_tolerance > 0` ($1$) | `{"kind": "quasistatic_elasticity", "max_picard_iterations", "picard_tolerance"}` |
| `fm.Elastodynamics` | `mechanical_dt: float \| None = None` | `mechanical_dt > 0` ($\mathrm{s}$) when supplied | `{"kind": "elastodynamics", ...}` |

### Stage-first example

```python
# %%
import fullmag as fm

study = fm.study("magnetoelastic-example")
study.objects.mesh.defaults(maximum_element_size=5e-9)
film_box = fm.Box(size=(100e-9, 20e-9, 5e-9))
film = study.geometry(film_box, name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.stages.add_relax(stage_id="mel-relax", dt=5e-13, max_steps=1)

# %%
elastic_mat = fm.ElasticMaterial(
    name="ni-elastic",
    C11=250.0e9,
    C12=160.0e9,
    C44=118.0e9,
    rho=8908.0,
)
elastic_body = fm.ElasticBody(
    name="substrate",
    geometry=film_box,
    elastic_material=elastic_mat,
)
law = fm.MagnetostrictionLaw(
    name="cubic-law",
    kind="cubic",
    B1=6.2e6,
    B2=4.3e6,
)
strain_load = fm.MechanicalLoad(
    kind="prescribed_strain",
    strain=(1.0e-4, 0.0, 0.0, 0.0, 0.0, 0.0),
)
mechanics_mode = fm.PrescribedStrain()
value = fm.Magnetoelastic(magnet="film", body="substrate", law="cubic-law")
canonical_ir = value.to_ir()
```

(python-api-interactions-magnetoelastic-problem-ir)=
## ProblemIR

`value.to_ir()` emits `{"kind": "magnetoelastic", "magnet": ..., "body": ..., "law": ...}` referencing the authored entities by stable identifier. `fm.ElasticBody.to_ir()` emits `{"name": ..., "geometry": ..., "elastic_material": ...}`, and the mechanical dynamics mode classes emit `{"kind": "prescribed_strain"}`, `{"kind": "quasistatic_elasticity", ...}`, or `{"kind": "elastodynamics", ...}`.

(python-api-interactions-magnetoelastic-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves the exact magnetic/mechanical/law identifier triples, elastic body bindings, and mechanical dynamics policy in `ProblemIR` independently of `resolved execution`. `Validation errors` reject empty link strings, non-positive Picard tolerances, or non-positive mechanical timesteps, while `unsupported combinations` (such as coupled `fm.QuasistaticElasticity` or `fm.Elastodynamics` on backends lacking coupled mechanics runtime support) fail closed at planning.

(python-api-interactions-magnetoelastic-discrete-realization)=
## Discrete realization

The Python contract supplies typed reference identifiers and mechanical regime policies in `ProblemIR`; evaluating strain-coupled effective fields and magnetoelastic energy on FEM or FDM discretizations is owned by the solver backends across the four execution lanes:

| Backend lane | Authoring & IR | Runtime status & discretization notes |
|---|---|---|
| FEM CPU | Supported | IR lowering supported; prescribed-strain magnetoelastic field evaluation and coupled elasticity follow FEM mechanics runtime qualification and fail closed where unimplemented. |
| FEM GPU | Supported | IR lowering supported; unsupported coupled mechanics regimes fail closed at planning. |
| FDM CPU | Supported | IR lowering supported; prescribed-strain magnetoelastic effective field evaluation where enabled, with coupled elastodynamics failing closed unless supported. |
| FDM GPU | Supported | IR lowering supported; unsupported coupled mechanics regimes fail closed at planning. |

(python-api-interactions-magnetoelastic-implementation-mapping)=
## Implementation mapping

The authoritative Python implementations are `packages/fullmag-py/src/fullmag/model/energy.py` (`class Magnetoelastic`), `packages/fullmag-py/src/fullmag/model/mechanics.py` (`class ElasticBody`, `class ElasticMaterial`, `class MagnetostrictionLaw`, `class MechanicalLoad`), and `packages/fullmag-py/src/fullmag/model/dynamics.py` (`class PrescribedStrain`, `class QuasistaticElasticity`, `class Elastodynamics`).

(python-api-interactions-magnetoelastic-validation)=
## Validation

Focused repository unit tests covering magnetoelastic reference serialization include `test_magnetoelastic_links_round_trip`. Coupled runtime and Control Room behavior require separate qualification.

(python-api-interactions-magnetoelastic-limitations)=
## Limitations and Control Room

Control Room has no dedicated interactive editor for `fm.Magnetoelastic`, `fm.ElasticBody`, or the mechanical dynamics mode classes; author magnetoelastic couplings in Python scripts. See {doc}`/frontend/capability-register`.

(python-api-interactions-magnetoelastic-scientific-bibliography)=
## Scientific bibliography

- C. Kittel, “Physical Theory of Ferromagnetic Domains,” *Reviews of Modern Physics* **21**(4), 541–583 (1949), [doi:10.1103/RevModPhys.21.541](https://doi.org/10.1103/RevModPhys.21.541).
- F. Vanderveken, J. Mulkers, J. Leliaert, B. Van Waeyenberge, B. Sorée, O. Zografos, F. Ciubotaru, and C. Adelmann, “Finite difference magnetoelastic simulator,” *Open Research Europe* **1**, 35 (2021), [doi:10.12688/openreseurope.13302.1](https://doi.org/10.12688/openreseurope.13302.1).
- L. D. Landau and E. M. Lifshitz, *Theory of Elasticity*, 3rd ed., Pergamon / Elsevier, [doi:10.1016/C2013-0-03754-0](https://doi.org/10.1016/C2013-0-03754-0).

(python-api-interactions-magnetoelastic-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L477) | `class Magnetoelastic` | public magnetoelastic link constructor and IR lowering |
| [`packages/fullmag-py/src/fullmag/model/mechanics.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/mechanics.py#L60) | `class ElasticBody` | elastic domain binding geometry and elastic material |
| [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L208) | `class PrescribedStrain` | prescribed strain/stress mechanical regime |
| [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L220) | `class QuasistaticElasticity` | quasistatic bidirectional Picard elasticity mode |
| [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L251) | `class Elastodynamics` | full coupled elastodynamics mode descriptor |
