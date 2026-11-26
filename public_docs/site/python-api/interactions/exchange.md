---
title: Exchange Python API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Exchange interaction

(public-docs-python-api-interactions-exchange)=
(python-api-interactions-exchange-problem-statement)=
## Problem statement

The exchange term (`fm.Exchange()`) is a typed zero-parameter interaction enabled or disabled on a study via `study.exchange(enabled=True)` and `study.disable_exchange()`, while exchange stiffness $A$ is supplied by the owning `MagnetHandle` (`film.Aex`) or `fm.Material`.

This page covers the Python authoring contract: `fm.Exchange()` takes no numerical arguments and lowers via `to_ir()` into `ProblemIR`, while `study.exchange()` and `study.disable_exchange()` control whether the exchange interaction is active in stage-first scripts.

(python-api-interactions-exchange-governing-equations)=
## Governing equations

Isotropic micromagnetic exchange contributes energy density $w_{\mathrm{ex}} = A\lVert\nabla\mathbf{m}\rVert^2$ and effective field $\mathbf{H}_{\mathrm{ex}} = \frac{2A}{\mu_0 M_s}\nabla^2\mathbf{m}$ (with natural Neumann boundary condition $\partial_n\mathbf{m} = 0$ at exterior boundaries) where stiffness $A$ is owned by `Material`. The full formulation and cross-interface rules are documented in {doc}`../../physics/interactions/exchange/index` and {doc}`../materials/material`.

(python-api-interactions-exchange-symbols-and-si-units)=
## Symbols and SI units

`fm.Exchange()` is a zero-argument marker object ($1$), and `study.exchange.enabled` is a dimensionless boolean ($1$). Exchange stiffness $A$ on `Material` / `MagnetHandle.Aex` is expressed in joules per metre ($\mathrm{J\,m^{-1}}$), saturation magnetization $M_s$ in $\mathrm{A\,m^{-1}}$, and spatial gradients in $\mathrm{m^{-1}}$.

(python-api-interactions-exchange-assumptions-and-validity)=
## Assumptions and validity

`fm.Exchange()` accepts no positional or keyword arguments and raises `TypeError` if unexpected arguments are passed. `study.exchange(enabled=False)` and `study.disable_exchange()` explicitly omit exchange from `energy_terms` (for example in macrospin or demag-only verification tests). Non-negative/positive `A` validation and inter-region interface averaging are enforced by `Material`, `CouplingRegistry`, and downstream planners.

(python-api-interactions-exchange-python-api)=
## Python API

### Constructor and study helpers

- `fm.Exchange()`
- `study.exchange(*, enabled=True)` (also flat `fm.exchange(*, enabled=True)`)
- `study.disable_exchange()` (also flat `fm.disable_exchange()`)

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `fm.Exchange` | `constructor` | `no arguments` | $1$ | no parameters | nearest-neighbour exchange term | FEM/FDM CPU/GPU: IR and exchange field/energy kernels | `kind` |
| `study.exchange.enabled` | `bool` | `True` | $1$ | boolean; `enabled=False` or `study.disable_exchange()` omits exchange | enables or disables isotropic exchange on the study | FEM/FDM CPU/GPU: controls inclusion in `energy_terms` | `energy_terms` |

### Stage-first example

```python
# %% Stage-first exchange relaxation and dynamics
import fullmag as fm

study = fm.study("exchange_spin_wave_bar")
study.engine("fdm")
study.device("cpu", precision="double")
study.objects.mesh.defaults(cell_size=(2.5e-9, 2.5e-9, 5.0e-9))

film = study.geometry(fm.Box(size=(100.0e-9, 20.0e-9, 5.0e-9)), name="permalloy")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag()
study.stages.add_relax(stage_id="relax_ground", dt=5.0e-13, max_steps=100)
study.stages.add_run(stage_id="ringdown", until=1.0e-11)

# %% Canonical Exchange term IR inspection
exchange_ir = fm.Exchange().to_ir()
assert exchange_ir == {"kind": "exchange"}
```

To omit exchange intentionally (for instance in single-spin macrospin or demagnetization-only tests), call `study.disable_exchange()` or `study.exchange(enabled=False)`.

(python-api-interactions-exchange-problem-ir)=
## ProblemIR

`fm.Exchange().to_ir()` emits `{"kind": "exchange"}` as a canonical typed interaction marker in `ProblemIR.energy_terms`.

(python-api-interactions-exchange-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves the explicit exchange-term marker (or explicit omission via `study.disable_exchange()`) in `ProblemIR` independently of `resolved execution`. `Validation errors` reject unexpected constructor arguments on `fm.Exchange()`, while `unsupported combinations` (such as missing material `A` when required by strict checks) fail closed at planning.

(python-api-interactions-exchange-discrete-realization)=
## Discrete realization

The Python contract supplies the canonical `"exchange"` IR marker only; 6-neighbor FDM stencils (with harmonic/arithmetic interface weights, uniform fast path, and precomputed face weights) and FEM CSR stiffness assembly (dual-path FMA / double-double CSR exchange on GPU) are implemented by the solver backends. See {ref}`numerical-methods-performance-fdm-core` and {ref}`numerical-methods-performance-fem-gpu-kernels`.

| Solver | Device | Exchange operator realization | Performance reference |
|---|---|---|---|
| `FDM` | `CPU` | Rayon-parallel persistent SoA row-wise 6-neighbor stencil | {ref}`numerical-methods-performance-fdm-core` |
| `FDM` | `GPU` | Unbounded precomputed face-exchange weights and uniform-material CUDA fast path | {ref}`numerical-methods-performance-fdm-core` |
| `FEM` | `CPU` | Assembled P1/nodal stiffness matrix CSR SpMV | {doc}`../../physics/interactions/exchange/index` |
| `FEM` | `GPU` | Dual-path FMA / double-double CSR GPU exchange and `bb_exchange_mass` preconditioning | {ref}`numerical-methods-performance-fem-gpu-kernels` |

(python-api-interactions-exchange-implementation-mapping)=
## Implementation mapping

- Typed interaction class: `packages/fullmag-py/src/fullmag/model/energy.py` (`class Exchange`).
- Stage-first enable/disable helpers: `packages/fullmag-py/src/fullmag/world.py` (`class StudyBuilder` methods `exchange`, `disable_exchange`).

(python-api-interactions-exchange-validation)=
## Validation

Focused repository unit tests covering exchange authoring and lowering include `test_class_api_exchange_coupling_lowers_to_ir` and `test_stage_workflow_and_exchange_fragment_are_current`. Live solver runtime parity and Control Room browser behavior require separate qualification.

(python-api-interactions-exchange-limitations)=
## Limitations and Control Room

Control Room has no standalone dialog for `fm.Exchange()`; intra-body exchange stiffness (`Aex`) is authored via `apps/control-room/src/modules/inspector/inspectors/objects/material/ObjectMaterialSpec.tsx` and region panels, interaction toggles via `apps/control-room/src/modules/inspector/inspectors/objects/physics/ObjectPhysicsSpec.tsx` / `PhysicsModuleSpec.tsx`, and cross-region exchange couplings via `CouplingInspectorPanel`. See {doc}`/frontend/capability-register`.

(python-api-interactions-exchange-scientific-bibliography)=
## Scientific bibliography

- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *The European Physical Journal B* **92**(6), 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6) | [Open-access Springer PDF](https://link.springer.com/content/pdf/10.1140/epjb/e2019-90599-6.pdf).
- W. F. Brown Jr., *Micromagnetics*, Interscience Publishers (Wiley), New York (1963).

(python-api-interactions-exchange-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L10) | `class Exchange` | public constructor and IR lowering |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6439) | `class StudyBuilder` | `study.exchange(...)` and `study.disable_exchange()` study controls |
