---
title: Magnetostriction Laws
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Magnetostriction laws

(public-docs-python-api-materials-magnetostriction-laws)=
(python-api-materials-magnetostriction-laws-problem-statement)=
## Problem statement

Family-specific parameters are required explicitly; cubic and isotropic laws are not inferred.

This page covers the Python authoring contract: construction validates explicit family-specific
magnetostriction parameters (`B1` and `B2` for `"cubic"`, or `lambda_s` for `"isotropic"`) in
Python, while `to_ir()` emits the canonical `ProblemIR` law record with lowercase keys (`b1`, `b2`,
or `lambda_s`).

(python-api-materials-magnetostriction-laws-governing-equations)=
## Governing equations

Magnetostriction laws specify the strain-magnetization coupling density
$w_{\mathrm{mel}}(\mathbf{m}, \boldsymbol{\varepsilon})$ either in cubic crystal symmetry
($w_{\mathrm{mel}} = B_1\sum_i \varepsilon_{ii} m_i^2 + B_2\sum_{i\neq j}\varepsilon_{ij} m_i m_j$)
or isotropic saturation form parameterized by $\lambda_s$. Continuum equations and bounded FEM
regimes are documented in {doc}`../../physics/interactions/magnetoelastic/index`.

(python-api-materials-magnetostriction-laws-symbols-and-si-units)=
## Symbols and SI units

Cubic magnetoelastic coupling coefficients (`B1`, `B2`) use pascals ($\mathrm{Pa}$). The law
`name`, `kind`, and isotropic saturation magnetostriction strain `lambda_s` are dimensionless ($1$).

(python-api-materials-magnetostriction-laws-assumptions-and-validity)=
## Assumptions and validity

`name` must be non-empty, `kind` must be `"cubic"` or `"isotropic"`, `"cubic"` requires both `B1`
and `B2`, and `"isotropic"` requires `lambda_s`; missing family parameters fail closed at
construction, and finiteness is enforced at lowering/planning.

(python-api-materials-magnetostriction-laws-python-api)=
## Python API

### Constructor or function

`fm.MagnetostrictionLaw(name, kind="cubic", B1=None, B2=None, lambda_s=None)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `MagnetostrictionLaw.name` | `str` | `required` | $1$ | non-empty | law identifier | FEM CPU/GPU: IR; FDM not currently resolved | `name` |
| `MagnetostrictionLaw.kind` | `str` | `"cubic"` | $1$ | `"cubic"` or `"isotropic"` | law family | FEM CPU/GPU: IR; FDM not currently resolved | `kind` |
| `MagnetostrictionLaw.B1` | `float \| None` | `None` | $\mathrm{Pa}$ | required and finite for `"cubic"` | first cubic magnetoelastic coefficient | FEM CPU/GPU: IR; FDM not currently resolved | `b1` |
| `MagnetostrictionLaw.B2` | `float \| None` | `None` | $\mathrm{Pa}$ | required and finite for `"cubic"` | second cubic magnetoelastic coefficient | FEM CPU/GPU: IR; FDM not currently resolved | `b2` |
| `MagnetostrictionLaw.lambda_s` | `float \| None` | `None` | $1$ | required and finite for `"isotropic"` | isotropic saturation magnetostriction | FEM CPU/GPU: IR; FDM not currently resolved | `lambda_s` |

### Stage-first example

```python
# %% Stage-first authoring and verification of cubic/isotropic MagnetostrictionLaw IR
import fullmag as fm

study = fm.study("magnetostriction_api_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(maximum_element_size=5e-9)

body = study.geometry(fm.Box(size=(100e-9, 20e-9, 5e-9)), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.stages.add_relax(stage_id="api-example", dt=5e-13, max_steps=1)

# Verify lowercase b1/b2 and lambda_s IR serialization:
cubic = fm.MagnetostrictionLaw(name="cubic-law", kind="cubic", B1=-1.0e6, B2=2.0e5)
iso = fm.MagnetostrictionLaw(name="iso-law", kind="isotropic", lambda_s=2.0e-5)
assert cubic.to_ir() == {"kind": "cubic", "name": "cubic-law", "b1": -1.0e6, "b2": 2.0e5}
assert iso.to_ir() == {"kind": "isotropic", "name": "iso-law", "lambda_s": 2.0e-5}
```

In a complete simulation script, reference the authored `MagnetostrictionLaw` by name from
`fm.Magnetoelastic(magnet, body, law)`.

(python-api-materials-magnetostriction-laws-problem-ir)=
## ProblemIR

`value.to_ir()` emits `{"kind": "cubic", "name": ..., "b1": ..., "b2": ...}` for cubic laws or
`{"kind": "isotropic", "name": ..., "lambda_s": ...}` for isotropic laws.

(python-api-materials-magnetostriction-laws-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves law family and explicit coupling coefficients in `ProblemIR`
independently of `resolved execution`. `Validation errors` reject unknown `kind` names, non-finite
values, or omitted required family coefficients, while `unsupported combinations` fail closed at
planning.

(python-api-materials-magnetostriction-laws-discrete-realization)=
## Discrete realization

| Solver | Device | Magnetostriction law support | Qualification boundary |
| --- | --- | --- | --- |
| FDM | CPU | Not currently resolved for magnetoelastic coupling (fails closed at planner) | Authoring/IR only |
| FDM | GPU | Not currently resolved for magnetoelastic coupling (fails closed at planner) | Authoring/IR only |
| FEM | CPU | Evaluates cubic/isotropic magnetoelastic effective fields in bounded prescribed-strain regimes | See {doc}`../../physics/interactions/magnetoelastic/index` |
| FEM | GPU | Planner-gated for bounded magnetoelastic FEM regimes | Executed-device GPU qualification remains separate |

(python-api-materials-magnetostriction-laws-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/mechanics.py`
(`class MagnetostrictionLaw`). Constructor checks, defaults, and lower-case `to_ir()` keys (`b1`,
`b2`, `lambda_s`) come directly from that module.

(python-api-materials-magnetostriction-laws-validation)=
## Validation

Focused repository unit tests covering `MagnetostrictionLaw` family validation and IR lowering
include `test_magnetostriction_law_requires_family_parameters`. Live solver runtime and Control
Room behavior require separate qualification.

(python-api-materials-magnetostriction-laws-limitations)=
## Limitations and Control Room

Control Room has no dedicated form editor for `fm.MagnetostrictionLaw`; author magnetostriction
laws in Python scripts. See {doc}`/frontend/capability-register`.

(python-api-materials-magnetostriction-laws-scientific-bibliography)=
## Scientific bibliography

- L. D. Landau and E. M. Lifshitz, *Theory of Elasticity*, 3rd ed., Pergamon / Elsevier, [doi:10.1016/C2013-0-03754-0](https://doi.org/10.1016/C2013-0-03754-0).
- C. Kittel, “Physical Theory of Ferromagnetic Domains,” *Reviews of Modern Physics* **21**(4), 541–583 (1949), [doi:10.1103/RevModPhys.21.541](https://doi.org/10.1103/RevModPhys.21.541).
- F. Vanderveken, J. Mulkers, J. Leliaert, B. Van Waeyenberge, B. Sorée, O. Zografos, F. Ciubotaru, and C. Adelmann, “Finite difference magnetoelastic simulator,” *Open Research Europe* **1**, 35 (2021), [doi:10.12688/openreseurope.13302.1](https://doi.org/10.12688/openreseurope.13302.1).

(python-api-materials-magnetostriction-laws-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/mechanics.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/mechanics.py#L93) | [`class MagnetostrictionLaw`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/mechanics.py#L93) | public constructor and lowercase `b1`/`b2`/`lambda_s` IR lowering |
