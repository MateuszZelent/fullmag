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
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| --- | --- | --- | $1$ | --- | --- | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | --- |
| `LLG.integrator` | `str` | `"auto"` | $1$ | One of `heun`, `rk4`, `rk23`, `rk45`, `abm3`, `coupled_imex_ark2`, `auto` | Time integration scheme | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `dynamics.integrator` |
| `LLG.gamma` | `float` | `2.211e5` | $\mathrm{m\,A^{-1}\,s^{-1}}$ | Positive | Gyromagnetic ratio | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `dynamics.gyromagnetic_ratio` |
| `LLG.fixed_timestep` | `float \| None` | `None` | $\mathrm{m}$ | Positive; exclusive with adaptive step | Fixed step size | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `dynamics.fixed_timestep` |
| `LLG.adaptive_timestep` | `AdaptiveTimestep \| None` | `None` | $\mathrm{s}$ | Adaptive integrator required | Embedded error control | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `dynamics.adaptive_timestep` |

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

Requested intent is the value authored by Python and preserved in ProblemIR; resolved execution is the planner or realization result. Validation errors identify the violated domain rule, and unsupported combinations are rejected explicitly rather than silently substituted.

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

## Control Room crosswalk

Status: Common solver/stage fields are partial; backend-specific options without editor fields remain not implemented.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Stages -> <stage> -> Solver` | `partial` | Apply stage draft; solver request and result resources become stale |
| Parameters without a named UI field | `Model Explorer -> Stages -> <stage> -> Solver` | `not implemented` | Python-only until implemented |

not implemented: frontend support for dynamics parameters not rendered by the stage editor.
See [Control Room capability register](/frontend/capability-register) for the support matrix and not implemented policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/StudyStageDraftEditor.tsx (StudyStageDraftEditor)`.

## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| LLG dynamics | `packages/fullmag-py/src/fullmag/model/dynamics.py` | `class LLG` | Integrator/step policy | Ownership test |
| Integrator vocabulary | `packages/fullmag-py/src/fullmag/model/dynamics.py` | `SUPPORTED_INTEGRATORS`, `ADAPTIVE_INTEGRATORS` | Valid set | Ownership test |

### Source-map coverage

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Integrator selection, validation, and dynamics IR lowering. | `packages/fullmag-py/src/fullmag/model/dynamics.py` | `class LLG` | Integrator selection, validation, and dynamics IR lowering. | Source-map validator and focused API tests |
