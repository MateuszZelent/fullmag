---
title: Cubic anisotropy Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Cubic anisotropy

(public-docs-python-api-interactions-cubic-anisotropy)=
(python-api-interactions-cubic-anisotropy-problem-statement)=
## Problem statement

Cubic anisotropy stores its two authored axes and signed finite constants.

This page covers the Python authoring contract: construction validates the crystal axes and cubic anisotropy constants in Python, while `to_ir()` emits the canonical `ProblemIR` record before mesh discretization.

(python-api-interactions-cubic-anisotropy-governing-equations)=
## Governing equations

Cubic magnetocrystalline anisotropy projects reduced magnetization $\mathbf{m}$ onto orthonormal crystal axes $\mathbf{c}_1$, $\mathbf{c}_2$, and $\mathbf{c}_3 = \mathbf{c}_1\times\mathbf{c}_2$ via direction cosines $\alpha_a = \mathbf{m}\cdot\mathbf{c}_a$ with constants $K_{c1}, K_{c2}, K_{c3}$. The full energy density and effective field equations are documented in {doc}`../../physics/interactions/anisotropy/cubic` and {doc}`../../physics/interactions/anisotropy/index`.

(python-api-interactions-cubic-anisotropy-symbols-and-si-units)=
## Symbols and SI units

Anisotropy energy-density constants (`kc1`, `kc2`, `kc3`) use joules per cubic metre ($\mathrm{J\,m^{-3}}$). Crystal axes (`axis1`, `axis2`) are normalized dimensionless Cartesian vectors ($1$).

(python-api-interactions-cubic-anisotropy-assumptions-and-validity)=
## Assumptions and validity

`kc1`, `kc2`, and `kc3` must be finite scalars (preserving sign), and `axis1` / `axis2` must be finite non-zero three-vectors normalized during construction or planning. FEM backends additionally require mutually orthogonal crystal axes (`axis1` perpendicular to `axis2`), failing closed otherwise.

(python-api-interactions-cubic-anisotropy-python-api)=
## Python API

### Constructor or function

`fm.CubicAnisotropy(kc1, kc2=0.0, kc3=0.0, axis1=(1,0,0), axis2=(0,1,0))`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `fm.CubicAnisotropy.kc1/kc2/kc3` | `float` | `kc1 required; others 0.0` | $\mathrm{J\,m^{-3}}$ | finite | cubic anisotropy constants | FEM/FDM CPU/GPU: IR; resolved support required | `kc1/kc2/kc3` |
| `fm.CubicAnisotropy.axis1` | `tuple[float,float,float]` | `(1,0,0)` | $1$ | finite non-zero; normalized | first cubic axis | FEM/FDM CPU/GPU: IR; resolved support required | `axis1` |
| `fm.CubicAnisotropy.axis2` | `tuple[float,float,float]` | `(0,1,0)` | $1$ | finite non-zero; normalized | second cubic axis | FEM/FDM CPU/GPU: IR; resolved support required | `axis2` |

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
value = fm.CubicAnisotropy(kc1=1.0e4, axis1=(1.0, 0.0, 0.0), axis2=(0.0, 1.0, 0.0))
canonical_ir = value.to_ir()
```

In a complete simulation script, configure cubic anisotropy on the owning material or attach it through the study material/energy API.

(python-api-interactions-cubic-anisotropy-problem-ir)=
## ProblemIR

`value.to_ir()` emits `{"kind": "cubic_anisotropy", "kc1": ..., "kc2": ..., "kc3": ..., "axis1": [...], "axis2": [...]}`, lowering normalized axes and signed constants into `ProblemIR`.

(python-api-interactions-cubic-anisotropy-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves signed `kc1`/`kc2`/`kc3` constants and normalized `axis1`/`axis2` vectors independently of `resolved execution`. `Validation errors` reject zero-norm axes or non-finite constants, while `unsupported combinations` (such as non-orthogonal crystal axes on strict FEM paths) fail closed at planning.

(python-api-interactions-cubic-anisotropy-discrete-realization)=
## Discrete realization

The Python contract supplies physical constants and crystal directions in `ProblemIR` only; cell-local FDM or nodal/quadrature FEM evaluations of $\mathbf{H}_{\mathrm{cubic}}$ and energy reductions are implemented by the solver backends.

(python-api-interactions-cubic-anisotropy-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/energy.py` (`class CubicAnisotropy`). Constructor defaults, axis normalization, validation branches, and `to_ir()` keys come directly from that module.

(python-api-interactions-cubic-anisotropy-validation)=
## Validation

Focused repository unit tests covering anisotropy IR lowering include `test_anisotropy_terms_serialize_canonical_ir`. Live solver runtime and Control Room browser behavior require separate qualification.

(python-api-interactions-cubic-anisotropy-limitations)=
## Limitations and Control Room

Control Room has no standalone route for `fm.CubicAnisotropy`; cubic constants and crystal axes are authored on materials/regions in Control Room when exposed or directly in Python scripts. See {doc}`/frontend/capability-register`.

(python-api-interactions-cubic-anisotropy-scientific-bibliography)=
## Scientific bibliography

- C. Kittel, “Physical Theory of Ferromagnetic Domains,” *Reviews of Modern Physics* **21**(4), 541–583 (1949), [doi:10.1103/RevModPhys.21.541](https://doi.org/10.1103/RevModPhys.21.541).
- J. B. Collings, R. Rama-Eiroa, R. M. Otxoa, R. F. L. Evans, and R. W. Chantrell, “Generalized form of the magnetic anisotropy field in micromagnetic and atomistic spin models,” *Physical Review B* **107**(6), 064413 (2023), [doi:10.1103/PhysRevB.107.064413](https://doi.org/10.1103/PhysRevB.107.064413) | [arXiv:2210.10916](https://arxiv.org/abs/2210.10916).
- W. F. Brown Jr., *Micromagnetics*, Interscience Publishers (Wiley), New York (1963).

(python-api-interactions-cubic-anisotropy-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class CubicAnisotropy` | public constructor and IR lowering |
