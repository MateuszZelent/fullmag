---
title: Exchange Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Exchange interaction

(public-docs-python-api-interactions-exchange)=
(python-api-interactions-exchange-problem-statement)=
## Problem statement

The exchange term is a typed zero-parameter interaction; material exchange constants are supplied by the owning material.

This page covers the Python authoring contract: `fm.Exchange()` takes no numerical arguments and lowers via `to_ir()` into `ProblemIR`, while material exchange stiffness $A$ is supplied by the owning `Material` or body assignment.

(python-api-interactions-exchange-governing-equations)=
## Governing equations

Isotropic micromagnetic exchange contributes energy density $w_{\mathrm{ex}} = A\lVert\nabla\mathbf{m}\rVert^2$ and effective field $\mathbf{H}_{\mathrm{ex}} = \frac{2A}{\mu_0 M_s}\nabla^2\mathbf{m}$ (with natural Neumann boundary condition $\partial_n\mathbf{m} = 0$ at exterior boundaries) where stiffness $A$ is owned by `Material`. The full formulation and cross-interface rules are documented in {doc}`../../physics/interactions/exchange/index` and {doc}`../materials/material`.

(python-api-interactions-exchange-symbols-and-si-units)=
## Symbols and SI units

`fm.Exchange()` is a zero-argument marker object ($1$). Exchange stiffness $A$ on `Material` is expressed in joules per metre ($\mathrm{J\,m^{-1}}$), saturation magnetization $M_s$ in $\mathrm{A\,m^{-1}}$, and spatial gradients in $\mathrm{m^{-1}}$.

(python-api-interactions-exchange-assumptions-and-validity)=
## Assumptions and validity

`fm.Exchange()` accepts no positional or keyword arguments and raises `TypeError` if unexpected arguments are passed. Non-negative/positive `A` validation and inter-region interface averaging are enforced by `Material`, `CouplingRegistry`, and downstream planners.

(python-api-interactions-exchange-python-api)=
## Python API

### Constructor or function

`fm.Exchange()`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `fm.Exchange` | `constructor` | `no arguments` | $1$ | no parameters | nearest-neighbour exchange term | FEM/FDM CPU/GPU: IR; runtime resolver-specific | `kind` |

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
value = fm.Exchange()
canonical_ir = value.to_ir()
```

In a complete simulation script, supply `Aex` / `A` on the owning body or `fm.Material`, or attach `fm.Exchange()` via the energy term registration API.

(python-api-interactions-exchange-problem-ir)=
## ProblemIR

`value.to_ir()` emits `{"kind": "exchange"}` as a canonical typed interaction marker in `ProblemIR`.

(python-api-interactions-exchange-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves the explicit exchange-term marker in `ProblemIR` independently of `resolved execution`. `Validation errors` reject unexpected constructor arguments, while `unsupported combinations` (such as missing material `A` when required by strict checks) fail closed at planning.

(python-api-interactions-exchange-discrete-realization)=
## Discrete realization

The Python contract supplies the canonical `"exchange"` IR marker only; 6-neighbor FDM stencils (with harmonic/arithmetic interface weights) and P1/nodal FEM stiffness assembly are implemented by the solver backends.

(python-api-interactions-exchange-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/energy.py` (`class Exchange`). Signature checks and `to_ir()` keys come directly from that module.

(python-api-interactions-exchange-validation)=
## Validation

Focused repository unit tests covering exchange authoring and lowering include `test_class_api_exchange_coupling_lowers_to_ir`. Live solver runtime and Control Room browser behavior require separate qualification.

(python-api-interactions-exchange-limitations)=
## Limitations and Control Room

Control Room has no standalone dialog for `fm.Exchange()`; intra-body exchange stiffness (`Aex`) is authored via `ObjectMaterialPanel` / region panels, and cross-region exchange couplings via `CouplingInspectorPanel`. See {doc}`/frontend/capability-register`.

(python-api-interactions-exchange-scientific-bibliography)=
## Scientific bibliography

- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *The European Physical Journal B* **92**(6), 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6) | [Open-access Springer PDF](https://link.springer.com/content/pdf/10.1140/epjb/e2019-90599-6.pdf).
- W. F. Brown Jr., *Micromagnetics*, Interscience Publishers (Wiley), New York (1963).

(python-api-interactions-exchange-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Exchange` | public constructor and IR lowering |
