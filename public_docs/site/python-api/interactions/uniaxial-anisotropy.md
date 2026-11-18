---
title: Uniaxial anisotropy Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Uniaxial anisotropy

(public-docs-python-api-interactions-uniaxial-anisotropy)=
(python-api-interactions-uniaxial-anisotropy-problem-statement)=
## Problem statement

The easy axis is normalized by the source constructor; constants remain signed finite values.

This page covers the Python authoring contract: construction validates signed uniaxial constants and normalizes the easy axis in Python, while `to_ir()` emits the canonical `ProblemIR` record before mesh discretization.

(python-api-interactions-uniaxial-anisotropy-governing-equations)=
## Governing equations

Uniaxial magnetocrystalline anisotropy along normalized easy axis $\mathbf{u}$ uses projection $q = \mathbf{m}\cdot\mathbf{u}$ with Fullmag's implemented energy density convention $w_u = -K_{u1} q^2 - K_{u2} q^4$ (which produces the same effective field as $K_{u1}(1 - q^2) + K_{u2}(1 - q^4)$ while shifting reported absolute energy by a constant). Full continuum definitions are documented in {doc}`../../physics/interactions/anisotropy/uniaxial` and {doc}`../../physics/interactions/anisotropy/index`.

(python-api-interactions-uniaxial-anisotropy-symbols-and-si-units)=
## Symbols and SI units

Anisotropy energy-density constants (`ku1`, `ku2`) use joules per cubic metre ($\mathrm{J\,m^{-3}}$). The normalized easy-axis vector `axis` is dimensionless ($1$).

(python-api-interactions-uniaxial-anisotropy-assumptions-and-validity)=
## Assumptions and validity

`ku1` and `ku2` must be finite real scalars (preserving sign), and `axis` must be a finite non-zero three-vector normalized during construction. Zero-norm vectors, malformed three-vector shapes, or non-finite constants fail closed at construction.

(python-api-interactions-uniaxial-anisotropy-python-api)=
## Python API

### Constructor or function

`fm.UniaxialAnisotropy(ku1, ku2=0.0, axis=(0,0,1))`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `fm.UniaxialAnisotropy.ku1` | `float` | `required` | $\mathrm{J\,m^{-3}}$ | finite | first anisotropy constant | FEM/FDM CPU/GPU: IR; resolved support required | `ku1` |
| `fm.UniaxialAnisotropy.ku2` | `float` | `0.0` | $\mathrm{J\,m^{-3}}$ | finite | second anisotropy constant | FEM/FDM CPU/GPU: IR; resolved support required | `ku2` |
| `fm.UniaxialAnisotropy.axis` | `tuple[float,float,float]` | `(0,0,1)` | $1$ | finite non-zero; normalized | easy axis | FEM/FDM CPU/GPU: IR; resolved support required | `axis` |

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
value = fm.UniaxialAnisotropy(ku1=5.0e4, axis=(0.0, 0.0, 1.0))
canonical_ir = value.to_ir()
```

In a complete simulation script, configure uniaxial anisotropy on the owning material or attach `fm.UniaxialAnisotropy(...)` via the study interaction API.

(python-api-interactions-uniaxial-anisotropy-problem-ir)=
## ProblemIR

`value.to_ir()` emits `{"kind": "uniaxial_anisotropy", "ku1": ..., "ku2": ..., "axis": [...]}` with the normalized unit easy axis.

(python-api-interactions-uniaxial-anisotropy-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves signed `ku1`/`ku2` constants and unit `axis` in `ProblemIR` independently of `resolved execution`. `Validation errors` reject zero-norm axes or non-finite constants, while `unsupported combinations` fail closed if a backend or material mode conflicts with the request.

(python-api-interactions-uniaxial-anisotropy-discrete-realization)=
## Discrete realization

The Python contract supplies physical constants and normalized axis in `ProblemIR` only; cell-local FDM and nodal/quadrature FEM evaluations of $\mathbf{H}_{\mathrm{uni}}$ and energy reductions are implemented by the solver backends.

(python-api-interactions-uniaxial-anisotropy-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/energy.py` (`class UniaxialAnisotropy`). Constructor parameters, axis normalization, defaults, and `to_ir()` keys come directly from that module.

(python-api-interactions-uniaxial-anisotropy-validation)=
## Validation

Focused repository unit tests covering uniaxial anisotropy IR lowering include `test_anisotropy_terms_serialize_canonical_ir`. Live solver runtime and Control Room browser behavior require separate qualification.

(python-api-interactions-uniaxial-anisotropy-limitations)=
## Limitations and Control Room

Control Room has no standalone form route for `fm.UniaxialAnisotropy`; uniaxial anisotropy constants and easy axes (`Ku1`, `Ku2`, `anisU`) are authored on owning object/region material panels when exposed or in Python scripts. See {doc}`/frontend/capability-register`.

(python-api-interactions-uniaxial-anisotropy-scientific-bibliography)=
## Scientific bibliography

- E. C. Stoner and E. P. Wohlfarth, “A mechanism of magnetic hysteresis in heterogeneous alloys,” *Philosophical Transactions of the Royal Society of London. Series A, Mathematical and Physical Sciences* **240**(826), 599–642 (1948), [doi:10.1098/rsta.1948.0007](https://doi.org/10.1098/rsta.1948.0007).
- J. B. Collings, R. Rama-Eiroa, R. M. Otxoa, R. F. L. Evans, and R. W. Chantrell, “Generalized form of the magnetic anisotropy field in micromagnetic and atomistic spin models,” *Physical Review B* **107**(6), 064413 (2023), [doi:10.1103/PhysRevB.107.064413](https://doi.org/10.1103/PhysRevB.107.064413) | [arXiv:2210.10916](https://arxiv.org/abs/2210.10916).
- W. F. Brown Jr., *Micromagnetics*, Interscience Publishers (Wiley), New York (1963).

(python-api-interactions-uniaxial-anisotropy-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class UniaxialAnisotropy` | public constructor and IR lowering |
