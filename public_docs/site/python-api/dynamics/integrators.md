---
title: Integrators
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-dynamics-integrators)=
# Integrators

(python-api-dynamics-integrators-problem-statement)=
<!-- (problem-statement)= -->
## Contract
This page records the public integrator identifiers carried by `LLG` and their fixed/adaptive
step semantics.

(python-api-dynamics-integrators-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
Integrator mathematics belongs to {doc}`../../numerical-methods/time-integration/index`.

(python-api-dynamics-integrators-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
`gamma` is the gyromagnetic ratio in $\mathrm{m\,A^{-1}\,s^{-1}}$ (LLG convention); step sizes are
in seconds.

(python-api-dynamics-integrators-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Integrator identifiers are validated against the supported set; adaptive step requests require an
adaptive integrator.

(python-api-dynamics-integrators-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|
| `LLG.integrator` | `str` | `"auto"` | One of `heun`, `rk4`, `rk23`, `rk45`, `abm3`, `coupled_imex_ark2`, `auto` | Time integration scheme | `dynamics.integrator` |
| `LLG.gamma` | `float` | `2.211e5` | Positive | Gyromagnetic ratio | `dynamics.gyromagnetic_ratio` |
| `LLG.fixed_timestep` | `float \| None` | `None` | Positive; exclusive with adaptive step | Fixed step size | `dynamics.fixed_timestep` |
| `LLG.adaptive_timestep` | `AdaptiveTimestep \| None` | `None` | Adaptive integrator required | Embedded error control | `dynamics.adaptive_timestep` |

### Integrator lanes

| Identifier | Family | Step mode |
|---|---|---|
| `heun` | Explicit RK2 | fixed |
| `rk4` | Explicit RK4 | fixed |
| `abm3` | Adams–Bashforth 3 | fixed |
| `rk23` | Bogacki–Shampine 3(2) | fixed or adaptive |
| `rk45` | Dormand–Prince 5(4) | fixed or adaptive |
| `coupled_imex_ark2` | Coupled IMEX ARK2 | fixed or adaptive |
| `auto` | Planner-selected | resolved at planning |

Aliases `dp54` and `bs23` normalize to `rk45` and `rk23` respectively.

### Complete stage-first example

```python
# %% Fixed-step Heun with explicit solver policy
import fullmag as fm

nm = 1.0e-9

study = fm.study("integrators_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.solver(integrator="heun", fix_dt=1.0e-13, gamma=2.211e5)
study.stages.add_run(stage_id="run", until=1.0e-12)
```

(python-api-dynamics-integrators-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`LLG.to_ir()` emits `{"kind": "llg", "gyromagnetic_ratio": ...,
"integrator": ..., "fixed_timestep": ...}` plus optional adaptive/field-refresh blocks.

(python-api-dynamics-integrators-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Aliases are normalized before validation. Fixed and adaptive timesteps are mutually exclusive.
Adaptive step requests with a non-adaptive integrator fail immediately.

(python-api-dynamics-integrators-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
Scheme details are documented in {doc}`../../numerical-methods/time-integration/index`.

(python-api-dynamics-integrators-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/dynamics.py` (`class LLG`, integrator constants).

(python-api-dynamics-integrators-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-dynamics-integrators-limitations)=
<!-- (limitations)= -->
## Limitations
Identifier support does not prove every integrator executes on every backend; planner capability
resolution is authoritative.

(python-api-dynamics-integrators-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
Scheme references belong to the time-integration numerical pages.

(python-api-dynamics-integrators-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| LLG dynamics | `packages/fullmag-py/src/fullmag/model/dynamics.py` | `class LLG` | Integrator/step policy | Ownership test |
| Integrator vocabulary | `packages/fullmag-py/src/fullmag/model/dynamics.py` | `SUPPORTED_INTEGRATORS`, `ADAPTIVE_INTEGRATORS` | Valid set | Ownership test |
