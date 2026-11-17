---
title: Magnetoelastic Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Magnetoelastic interaction

(magnetoelastic-api-problem-statement)=
## Problem statement

The interaction links already-authored magnetic, mechanical, and law objects by stable identifiers.

This page covers the Python authoring contract: construction validates non-empty string identifiers linking an authored magnetic region/object, mechanical body, and magnetostriction law in Python, while `to_ir()` emits the canonical `ProblemIR` link record.

(python-api-interactions-magnetoelastic-governing-equations)=
## Governing equations

Magnetoelastic coupling computes an effective anisotropy-like field $\mathbf{H}_{\mathrm{mel}} = -\frac{1}{\mu_0 M_s}\frac{\partial w_{\mathrm{mel}}(\mathbf{m}, \boldsymbol{\varepsilon})}{\partial \mathbf{m}}$ connecting magnetization $\mathbf{m}$ on `magnet`, strain state on `body`, and constitutive constants defined by `law`. Energy densities and bounded prescribed-strain regimes are documented in {doc}`../../physics/interactions/magnetoelastic/index`, {doc}`../materials/elastic-materials`, and {doc}`../materials/magnetostriction-laws`.

(python-api-interactions-magnetoelastic-symbols-and-si-units)=
## Symbols and SI units

The link identifiers (`magnet`, `body`, `law`) are dimensionless string references ($1$). Physical magnetoelastic constants (`B1`, `B2` in $\mathrm{Pa}$) and elastic moduli (`C11`, `C12`, `C44` in $\mathrm{Pa}$) reside on the referenced law and elastic-material records.

(python-api-interactions-magnetoelastic-assumptions-and-validity)=
## Assumptions and validity

`magnet`, `body`, and `law` must each be non-empty string identifiers referencing valid study entities. Empty strings fail closed at construction, and unresolved link targets or unsupported mechanics regimes fail closed during planning.

(python-api-interactions-magnetoelastic-python-api)=
## Python API

### Constructor or function

`fm.Magnetoelastic(magnet, body, law)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `magnet` | `str` | `required` | $1$ | non-empty magnet link | magnetic object link | FEM CPU/GPU: IR; coupled mechanics runtime required | `magnet` |
| `body` | `str` | `required` | $1$ | non-empty body link | mechanical body link | FEM CPU/GPU: IR; coupled mechanics runtime required | `body` |
| `law` | `str` | `required` | $1$ | non-empty law link | magnetostriction law link | FEM CPU/GPU: IR; coupled mechanics runtime required | `law` |

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
value = fm.Magnetoelastic(magnet="film", body="substrate", law="cubic-law")
canonical_ir = value.to_ir()
```

In a complete simulation script, pair `fm.Magnetoelastic(...)` with matching `ElasticMaterial`, `ElasticBody`, `MagnetostrictionLaw`, and `MechanicalLoad` objects.

(python-api-interactions-magnetoelastic-problem-ir)=
## ProblemIR

`value.to_ir()` emits `{"kind": "magnetoelastic", "magnet": ..., "body": ..., "law": ...}` referencing the authored entities by stable identifier.

(python-api-interactions-magnetoelastic-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves the exact magnetic/mechanical/law identifier triples in `ProblemIR` independently of `resolved execution`. `Validation errors` reject empty link strings, while `unsupported combinations` (such as coupled elastodynamics or backends lacking magnetoelastic support) fail closed at planning.

(python-api-interactions-magnetoelastic-discrete-realization)=
## Discrete realization

The Python contract supplies typed reference identifiers in `ProblemIR` only; evaluating strain-coupled effective fields and magnetoelastic energy on FEM or FDM discretizations is owned by the solver backends.

(python-api-interactions-magnetoelastic-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/energy.py` (`class Magnetoelastic`). Validation checks and `to_ir()` keys come directly from that module.

(python-api-interactions-magnetoelastic-validation)=
## Validation

Focused repository unit tests covering magnetoelastic reference serialization include `test_magnetoelastic_links_round_trip`. Coupled runtime and Control Room behavior require separate qualification.

(python-api-interactions-magnetoelastic-limitations)=
## Limitations and Control Room

Control Room has no dedicated interactive editor for `fm.Magnetoelastic`; author magnetoelastic couplings in Python scripts. See {doc}`/frontend/capability-register`.

(python-api-interactions-magnetoelastic-scientific-bibliography)=
## Scientific bibliography

- C. Kittel, “Physical Theory of Ferromagnetic Domains,” *Reviews of Modern Physics* **21**(4), 541–583 (1949), [doi:10.1103/RevModPhys.21.541](https://doi.org/10.1103/RevModPhys.21.541).
- F. Vanderveken, J. Mulkers, J. Leliaert, B. Van Waeyenberge, B. Sorée, O. Zografos, F. Ciubotaru, and C. Adelmann, “Finite difference magnetoelastic simulator,” *Open Research Europe* **1**, 35 (2021), [doi:10.12688/openreseurope.13302.1](https://doi.org/10.12688/openreseurope.13302.1).
- L. D. Landau and E. M. Lifshitz, *Theory of Elasticity*, 3rd ed., Pergamon / Elsevier, [doi:10.1016/C2013-0-03754-0](https://doi.org/10.1016/C2013-0-03754-0).

(python-api-interactions-magnetoelastic-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Magnetoelastic` | public constructor and IR lowering |
