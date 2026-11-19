---
title: Demagnetization
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Demagnetization

(public-docs-python-api-interactions-demagnetization)=
(python-api-interactions-demagnetization-problem-statement)=
## Problem statement

Demag records the requested realization and rejects ambiguous model/realization combinations.

This page covers the Python authoring contract: construction validates the requested demagnetization model, boundary variant, and realization policy in Python, while `to_ir()` emits the canonical `ProblemIR` record before solver planning.

(python-api-interactions-demagnetization-governing-equations)=
## Governing equations

Magnetostatics solves $\nabla\cdot\mathbf{B} = 0$ with $\mathbf{B} = \mu_0(\mathbf{H}_{\mathrm{d}} + \mathbf{M})$ via scalar potential $\mathbf{H}_{\mathrm{d}} = -\nabla\phi_m$ (FEM airbox or hybrid FEM/BEM) or tensor convolution over rectangular prisms (FDM FFT). The continuum equations, boundary closures, and energy integrals are documented in {doc}`../../physics/interactions/demagnetization/index`.

(python-api-interactions-demagnetization-symbols-and-si-units)=
## Symbols and SI units

The solver-policy selectors (`model`, `variant`, and `realization`) are dimensionless string tags ($1$). Physical magnetization $M_s$ and demagnetizing field $\mathbf{H}_{\mathrm{d}}$ evaluated by the backends use $\mathrm{A\,m^{-1}}$ and domain coordinates use $\mathrm{m}$.

(python-api-interactions-demagnetization-assumptions-and-validity)=
## Assumptions and validity

`model` (one of `"airbox"`, `"bem"`, `"fredkin_koehler"`, `"fmm"`) and `realization` are mutually exclusive; `variant` (`"auto"`, `"dirichlet"`, `"robin"`) is valid only with `model="airbox"`. Conflicting arguments, unknown selector strings, or periodic airbox combinations on FDM fail closed at authoring or lowering.

(python-api-interactions-demagnetization-python-api)=
## Python API

### Constructor or function

`fm.Demag(model=None, variant=None, realization=None)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `fm.Demag.model` | `str or None` | `None` | $1$ | airbox, bem, fredkin_koehler, or fmm when supplied | demagnetization model | FEM/FDM CPU/GPU: IR; resolved support required | `realization` |
| `fm.Demag.variant` | `str or None` | `None` | $1$ | airbox variant auto, dirichlet, or robin; only with model=airbox | airbox boundary variant | FEM/FDM CPU/GPU: IR; resolved support required | `realization.variant` |
| `fm.Demag.realization` | `str or None` | `None` | $1$ | mutually exclusive with model | pre-resolved realization label | FEM/FDM CPU/GPU: IR; resolved support required | `realization` |

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
value = fm.Demag(model="airbox", variant="auto")
canonical_ir = value.to_ir()
```

In a complete simulation script, attach demagnetization policy via the study's solver/physics configuration rather than relying on standalone object construction.

(python-api-interactions-demagnetization-problem-ir)=
## ProblemIR

`value.to_ir()` emits `{"kind": "demag", "realization": ...}` (for example, `"poisson_robin"` when `model="airbox"` and `variant="auto"` are normalized for airbox execution).

(python-api-interactions-demagnetization-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves explicit solver model/variant selection or `"auto"` resolution policy in `ProblemIR` independently of `resolved execution`. `Validation errors` reject conflicting `model` and `realization` inputs, while `unsupported combinations` (such as periodic `airbox` demag on FDM) fail closed at planning.

(python-api-interactions-demagnetization-discrete-realization)=
## Discrete realization

The Python contract supplies solver-policy intent in `ProblemIR` only; Newell/FFT convolution kernels, Poisson airbox assembly, Robin closures, and Fredkin–Koehler FEM/BEM coupling are implemented by the solver backends.

(python-api-interactions-demagnetization-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/energy.py` (`class Demag`). Constructor validation, normalization rules, defaults, and `to_ir()` keys come directly from that module.

(python-api-interactions-demagnetization-validation)=
## Validation

Focused repository unit tests covering `Demag` authoring and lowering include `test_demag_authoring_rejects_ambiguous_realization` and `test_problem_to_ir_rejects_periodic_airbox_demag_for_fdm`. Live solver runtime and Control Room browser behavior require separate qualification.

(python-api-interactions-demagnetization-limitations)=
## Limitations and Control Room

Control Room has no standalone object form for `fm.Demag`; demagnetization method selection is surfaced through study/discretization configuration or session capability panels when exposed, and otherwise authored in Python. See {doc}`/frontend/capability-register`.

(python-api-interactions-demagnetization-scientific-bibliography)=
## Scientific bibliography

- A. J. Newell, W. Williams, and D. J. Dunlop, “A generalization of the demagnetizing tensor for nonuniform magnetization,” *Journal of Geophysical Research: Solid Earth* **98**(B6), 9551–9555 (1993), [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).
- D. R. Fredkin and T. R. Koehler, “Hybrid method for computing demagnetizing fields,” *IEEE Transactions on Magnetics* **26**(2), 415–417 (1990), [doi:10.1109/20.106342](https://doi.org/10.1109/20.106342).
- W. F. Brown Jr., *Micromagnetics*, Interscience Publishers (Wiley), New York (1963).

(python-api-interactions-demagnetization-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Demag` | public constructor and IR lowering |
