---
title: Demagnetization
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Demagnetization

(public-docs-python-api-interactions-demagnetization)=
(python-api-interactions-demagnetization-problem-statement)=
## Problem statement

`fm.Demag` and the stage-first helpers `study.demag(...)`, `study.disable_demag()`, and `fm.demag_quality(...)` configure magnetostatic demagnetization policy and reject ambiguous `model`/`realization` combinations.

This page covers the Python authoring contract: construction validates the requested demagnetization model, airbox boundary variant, and legacy realization aliases in Python, while `to_ir()` emits a flat canonical `ProblemIR` record before solver planning.

(python-api-interactions-demagnetization-governing-equations)=
## Governing equations

Magnetostatics solves $\nabla\cdot\mathbf{B} = 0$ with $\mathbf{B} = \mu_0(\mathbf{H}_{\mathrm{d}} + \mathbf{M})$ via scalar potential $\mathbf{H}_{\mathrm{d}} = -\nabla\phi_m$ (FEM airbox or hybrid FEM/BEM) or tensor convolution over rectangular prisms (FDM FFT). The continuum equations, boundary closures, and energy integrals are documented in {doc}`../../physics/interactions/demagnetization/index`.

(python-api-interactions-demagnetization-symbols-and-si-units)=
## Symbols and SI units

The solver-policy selectors (`model`, `variant`, `realization`, and `demag_quality` profile names) are dimensionless string tags ($1$). Physical magnetization $M_s$ and demagnetizing field $\mathbf{H}_{\mathrm{d}}$ evaluated by the backends use $\mathrm{A\,m^{-1}}$, refresh intervals (`demag_interval_s`) use $\mathrm{s}$, and domain coordinates use $\mathrm{m}$.

(python-api-interactions-demagnetization-assumptions-and-validity)=
## Assumptions and validity

- `model` (`"airbox"`, `"bem"`, `"fredkin_koehler"`, `"fmm"`) and legacy `realization` are mutually exclusive.
- `variant` (`"auto"`, `"dirichlet"`, `"robin"`) is valid **only** when `model="airbox"`; passing `variant` with `model=None` or with another model raises `ValueError`.
- Legacy `realization` accepts canonical IR tags (`"auto"`, `"bem"`, `"fmm"`, `"fredkin_koehler"`, `"poisson_dirichlet"`, `"poisson_robin"`) plus deprecated aliases normalized by `_DEMAG_LEGACY_ALIASES`: `"poisson_airbox"` $\to$ `"poisson_robin"`, `"airbox_robin"` $\to$ `"poisson_robin"`, and `"airbox_dirichlet"` $\to$ `"poisson_dirichlet"`.
- `fm.demag_quality(profile)` accepts `"exact"` (refresh every RHS evaluation, `demag_interval_s=None`), `"balanced"` (`5.0e-13` s), or `"fast"` (`2.0e-12` s).
- Conflicting arguments, unknown selector strings, or FEM-only periodic airbox combinations on FDM fail closed at authoring or lowering.

(python-api-interactions-demagnetization-python-api)=
## Python API

### Constructors and study helpers

- `fm.Demag(model=None, variant=None, realization=None)`
- `study.demag(*, enabled=True, model=None, variant=None, realization=None)` (also `fm.demag(...)`)
- `study.disable_demag()` (also `fm.disable_demag()`)
- `fm.demag_quality(profile)` (`"exact"`, `"balanced"`, `"fast"`)

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `fm.Demag.model` | `str \| None` | `None` | $1$ | `"airbox"`, `"bem"`, `"fredkin_koehler"`, or `"fmm"` when supplied; mutually exclusive with `realization` | canonical demagnetization model | FEM/FDM CPU/GPU: IR; planner resolves backend support | `realization` |
| `fm.Demag.variant` | `str \| None` | `None` | $1$ | `"auto"`, `"dirichlet"`, or `"robin"`; valid only with `model="airbox"` | airbox boundary variant flattened into `realization` | FEM CPU/GPU: airbox Robin/Dirichlet; FDM fails closed on FEM airbox options | `realization` |
| `fm.Demag.realization` | `str \| None` | `None` | $1$ | canonical tags or aliases (`poisson_airbox`, `airbox_robin`, `airbox_dirichlet`); mutually exclusive with `model` | legacy pre-resolved realization label | FEM/FDM CPU/GPU: IR; normalized to flat realization string | `realization` |
| `study.demag.enabled` | `bool` | `True` | $1$ | boolean; `enabled=False` or `study.disable_demag()` omits demag | enables or disables demagnetization on the study | FEM/FDM CPU/GPU: controls inclusion in `energy_terms` | `energy_terms` |
| `fm.demag_quality.profile` | `str` | `required` | $1$ | `"exact"`, `"balanced"`, or `"fast"` | sets demag refresh cadence (`None`, `5e-13` s, `2e-12` s) | FEM/FDM CPU/GPU: lowers to `field_refresh.demag_interval_s` | `field_refresh.demag_interval_s` |

### Stage-first example

```python
# %% Stage-first demagnetization configuration
import fullmag as fm

study = fm.study("demag_airbox_relaxation")
study.engine("fem")
study.device("cpu", precision="double")
study.objects.mesh.defaults(maximum_element_size=5.0e-9)

film = study.geometry(fm.Box(size=(100.0e-9, 20.0e-9, 5.0e-9)), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag(model="airbox", variant="robin")
fm.demag_quality("exact")
study.stages.add_relax(stage_id="relax_eq", dt=5.0e-13, max_steps=100)

# %% Canonical flat IR lowering (including legacy alias normalization)
airbox_ir = fm.Demag(model="airbox", variant="auto").to_ir()
alias_ir = fm.Demag(realization="airbox_dirichlet").to_ir()
assert airbox_ir == {"kind": "demag", "realization": "poisson_robin"}
assert alias_ir == {"kind": "demag", "realization": "poisson_dirichlet"}
```

To omit magnetostatics cleanly (for example in exchange-only analytical benchmarks), call `study.disable_demag()` or `study.demag(enabled=False)`.

(python-api-interactions-demagnetization-problem-ir)=
## ProblemIR

`fm.Demag.to_ir()` always emits a **flat** two-key record `{"kind": "demag", "realization": "<resolved>"}` (there is no nested `realization.variant` field):

| Python authoring | Flattened `ProblemIR` `realization` value |
|---|---|
| `fm.Demag()` | `"auto"` |
| `fm.Demag(model="airbox")` / `variant="auto"` / `variant="robin"` | `"poisson_robin"` |
| `fm.Demag(model="airbox", variant="dirichlet")` | `"poisson_dirichlet"` |
| `fm.Demag(model="fredkin_koehler")` | `"fredkin_koehler"` |
| `fm.Demag(model="bem")` / `fm.Demag(model="fmm")` | `"bem"` / `"fmm"` |
| `fm.Demag(realization="poisson_airbox")` / `"airbox_robin"` | `"poisson_robin"` |
| `fm.Demag(realization="airbox_dirichlet")` | `"poisson_dirichlet"` |

(python-api-interactions-demagnetization-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves explicit solver model/variant selection or `"auto"` resolution policy as the flattened `realization` string in `ProblemIR` independently of `resolved execution`. `Validation errors` reject mixing `model` and `realization`, using `variant` without `model="airbox"`, or passing unknown profile names to `fm.demag_quality`. `Unsupported combinations` (such as periodic `airbox` demag on FDM or requesting an unimplemented realization on a backend lane) fail closed at planning.

(python-api-interactions-demagnetization-discrete-realization)=
## Discrete realization

The Python contract supplies solver-policy intent in `ProblemIR` only; Newell/FFT convolution kernels, Poisson airbox assembly, Robin closures, and Fredkin–Koehler FEM/BEM coupling are implemented by the solver backends. For detailed acceleration algorithms, VRAM preflight, and verified speedups (batched single-layer `D2Z`/`Z2D` & `R2C`/`C2R` cuFFT on FDM GPU; auto-`cuDSS` direct Cholesky demag and `pure_prism_p2` on FEM GPU), see {ref}`numerical-methods-performance-fdm-core` and {ref}`numerical-methods-performance-fem-gpu-demag`.

| Solver | Device | Supported demagnetization realizations | Performance reference |
|---|---|---|---|
| `FDM` | `CPU` | 3D Newell-tensor R2C/C2R FFT convolution (`realization="auto"`) | {ref}`numerical-methods-performance-fdm-core` |
| `FDM` | `GPU` | Batched single-layer `D2Z`/`Z2D` & `R2C`/`C2R` cuFFT with exact workspace preflight | {ref}`numerical-methods-performance-fdm-core` |
| `FEM` | `CPU` | Airbox Poisson (`poisson_robin`, `poisson_dirichlet`) and hybrid FEM/BEM (`fredkin_koehler`) | {doc}`../../numerical-methods/demag-solvers/index` |
| `FEM` | `GPU` | Airbox Poisson and hybrid FEM/BEM via `cg_amg` or auto-`cuDSS` direct Cholesky (`pure_prism_p2` supported) | {ref}`numerical-methods-performance-fem-gpu-demag` |

(python-api-interactions-demagnetization-implementation-mapping)=
## Implementation mapping

- Typed interaction class and alias mapping: `packages/fullmag-py/src/fullmag/model/energy.py` (`class Demag`).
- Stage-first helpers and refresh profiles: `packages/fullmag-py/src/fullmag/world.py` (`demag`, `disable_demag`, `demag_quality`, `StudyBuilder.demag`, `StudyBuilder.disable_demag`).

(python-api-interactions-demagnetization-validation)=
## Validation

Focused repository unit tests covering `Demag` authoring and lowering include `test_demag_authoring_rejects_ambiguous_realization` and `test_problem_to_ir_rejects_periodic_airbox_demag_for_fdm`. Live solver runtime parity and Control Room browser behavior require separate qualification.

(python-api-interactions-demagnetization-limitations)=
## Limitations and Control Room

Control Room surfaces demagnetization method selection through `apps/control-room/src/modules/inspector/inspectors/objects/physics/ObjectPhysicsSpec.tsx` and `apps/control-room/src/modules/inspector/inspectors/objects/physics/PhysicsModuleSpec.tsx` (and airbox controls under `UniverseAndAirboxSpec.tsx`); low-level `fm.demag_quality(...)` cadence profiles are authored in Python scripts. See {doc}`/frontend/capability-register`.

(python-api-interactions-demagnetization-scientific-bibliography)=
## Scientific bibliography

- A. J. Newell, W. Williams, and D. J. Dunlop, “A generalization of the demagnetizing tensor for nonuniform magnetization,” *Journal of Geophysical Research: Solid Earth* **98**(B6), 9551–9555 (1993), [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).
- D. R. Fredkin and T. R. Koehler, “Hybrid method for computing demagnetizing fields,” *IEEE Transactions on Magnetics* **26**(2), 415–417 (1990), [doi:10.1109/20.106342](https://doi.org/10.1109/20.106342).
- W. F. Brown Jr., *Micromagnetics*, Interscience Publishers (Wiley), New York (1963).

(python-api-interactions-demagnetization-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L50) | `class Demag` | public constructor, alias normalization, and flat IR lowering |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L9546) | `demag_quality` | named refresh-cadence profiles (`exact`, `balanced`, `fast`) |
