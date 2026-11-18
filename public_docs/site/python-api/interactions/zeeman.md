---
title: Zeeman Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Zeeman field

(public-docs-python-api-interactions-zeeman)=
(python-api-interactions-zeeman-problem-statement)=
## Problem statement

The Zeeman vector is authored in tesla and serialized as a three-component value.

This page covers the Python authoring contract: construction validates the applied magnetic induction three-vector in tesla in Python, while `to_ir()` emits the canonical `ProblemIR` record before field evaluation.

(python-api-interactions-zeeman-governing-equations)=
## Governing equations

The Zeeman interaction couples magnetization $\mathbf{M} = M_s\mathbf{m}$ to an applied external magnetic flux density $\mathbf{B}$ with volumetric energy density $w_Z = -\mathbf{M}\cdot\mathbf{B}$ and effective field $\mathbf{H}_Z = \mathbf{B}/\mu_0$. Continuum definitions and energy sign conventions are documented in {doc}`../../physics/interactions/zeeman/index`.

(python-api-interactions-zeeman-symbols-and-si-units)=
## Symbols and SI units

`fm.Zeeman.B` is authored as Cartesian magnetic flux density in SI teslas ($\mathrm{T}$). The corresponding magnetic effective field $\mathbf{B}/\mu_0$ has units of $\mathrm{A\,m^{-1}}$.

(python-api-interactions-zeeman-assumptions-and-validity)=
## Assumptions and validity

`B` must be a finite real three-component vector (`(Bx, By, Bz)`). Non-finite components (`NaN`, `Inf`) or non-three-element sequences fail closed during construction.

(python-api-interactions-zeeman-python-api)=
## Python API

### Constructor or function

`fm.Zeeman(B)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `fm.Zeeman.B` | `tuple[float,float,float]` | `required` | $\mathrm{T}$ | finite three-vector | applied magnetic induction | FEM/FDM CPU/GPU: IR; resolved support required | `B` |

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
value = fm.Zeeman(B=(0.0, 0.0, 1.0e-3))
canonical_ir = value.to_ir()
```

In a complete simulation script, attach external fields on a stage (`stage.external_field(...)` / study Zeeman terms) or lower `fm.Zeeman(B)` directly.

(python-api-interactions-zeeman-problem-ir)=
## ProblemIR

`value.to_ir()` emits `{"kind": "zeeman", "B": [Bx, By, Bz]}` preserving all three Cartesian components in tesla.

(python-api-interactions-zeeman-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves the exact three-component induction vector in `ProblemIR` independently of `resolved execution`. `Validation errors` reject malformed or non-finite vectors, while `unsupported combinations` fail closed if a time-varying envelope or solver path conflicts with the stage definition.

(python-api-interactions-zeeman-discrete-realization)=
## Discrete realization

The Python contract supplies the uniform Cartesian flux density $\mathbf{B}$ in `ProblemIR` only; converting $\mathbf{B}/\mu_0$ across active cells/nodes and integrating Zeeman energy are handled by the solver backends.

(python-api-interactions-zeeman-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/energy.py` (`class Zeeman`). Constructor validation and `to_ir()` keys come directly from that module.

(python-api-interactions-zeeman-validation)=
## Validation

Focused repository unit tests covering `Zeeman` vector serialization include `test_zeeman_serializes_vector_to_ir`. Live solver runtime and Control Room browser behavior require separate qualification.

(python-api-interactions-zeeman-limitations)=
## Limitations and Control Room

Control Room edits stage external-field vectors on active study stages; this low-level `fm.Zeeman(B)` value object has no separate object-inspector route. See {doc}`/frontend/capability-register`.

(python-api-interactions-zeeman-scientific-bibliography)=
## Scientific bibliography

- W. F. Brown Jr., *Micromagnetics*, Interscience Publishers (Wiley), New York (1963).
- E. C. Stoner and E. P. Wohlfarth, “A mechanism of magnetic hysteresis in heterogeneous alloys,” *Philosophical Transactions of the Royal Society of London. Series A, Mathematical and Physical Sciences* **240**(826), 599–642 (1948), [doi:10.1098/rsta.1948.0007](https://doi.org/10.1098/rsta.1948.0007).
- A. Baker, M. Beg, G. Ashton, M. Albert, D. Chernyshenko, W. Wang, S. Zhang, M.-A. Bisotti, M. Franchin, C. L. Hu, R. Stamps, T. Hesjedal, and H. Fangohr, “Proposal of a micromagnetic standard problem for ferromagnetic resonance simulations,” *Journal of Magnetism and Magnetic Materials* **421**, 428–439 (2017), [doi:10.1016/j.jmmm.2016.08.009](https://doi.org/10.1016/j.jmmm.2016.08.009) | [arXiv:1603.05419](https://arxiv.org/abs/1603.05419).

(python-api-interactions-zeeman-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Zeeman` | public constructor and IR lowering |
