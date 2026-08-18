---
title: Adaptive Timestep
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-dynamics-adaptive-timestep)=
# Adaptive Timestep

(python-api-dynamics-adaptive-timestep-problem-statement)=
<!-- (problem-statement)= -->
## Contract
This page records the embedded-error and step-doubling controls exposed by `AdaptiveTimestep`.

(python-api-dynamics-adaptive-timestep-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
Error control mathematics belongs to {doc}`../../numerical-methods/time-integration/adaptive-stepping`.

(python-api-dynamics-adaptive-timestep-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Tolerances are relative/absolute dimensionless mixed-error bounds; `dt_initial`, `dt_min`, and
`dt_max` are in seconds.

(python-api-dynamics-adaptive-timestep-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
At least one of `atol`/`rtol` must be positive; step bounds must satisfy
`dt_min <= dt_initial <= dt_max`.

(python-api-dynamics-adaptive-timestep-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|
| `AdaptiveTimestep.atol` | `float` | `1e-6` | Non-negative; one of atol/rtol positive | Absolute tolerance | `adaptive_timestep.atol` |
| `AdaptiveTimestep.rtol` | `float` | `1e-3` | Non-negative | Relative tolerance | `adaptive_timestep.rtol` |
| `AdaptiveTimestep.dt_initial` | `float \| None` | `None` | Within `[dt_min, dt_max]` | Initial step | `adaptive_timestep.dt_initial` |
| `AdaptiveTimestep.dt_min` | `float` | `1e-15` | Positive | Minimum step | `adaptive_timestep.dt_min` |
| `AdaptiveTimestep.dt_max` | `float \| None` | `None` | `>= dt_min` | Maximum step | `adaptive_timestep.dt_max` |
| `AdaptiveTimestep.safety` | `float` | `0.9` | `(0, 1]` | Step safety factor | `adaptive_timestep.safety` |
| `AdaptiveTimestep.growth_limit` | `float` | `2.0` | `> 1` | Growth limit | `adaptive_timestep.growth_limit` |
| `AdaptiveTimestep.shrink_limit` | `float` | `0.2` | `(0, 1)` | Shrink limit | `adaptive_timestep.shrink_limit` |
| `AdaptiveTimestep.max_spin_rotation` | `float \| None` | `None` | Positive | Spin-rotation cap | `adaptive_timestep.max_spin_rotation` |
| `AdaptiveTimestep.norm_tolerance` | `float \| None` | `None` | Positive | Norm tolerance | `adaptive_timestep.norm_tolerance` |

A `max_error` convenience mode sets `rtol=0` and records `tolerance_mode="max_error"`.

### Complete stage-first example

```python
# %% Adaptive RK45 with embedded error control
import fullmag as fm

nm = 1.0e-9

study = fm.study("adaptive_timestep_api_example")
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
study.solver(
    integrator="rk45",
    adaptive_timestep=fm.AdaptiveTimestep(
        atol=1.0e-6,
        rtol=1.0e-3,
        dt_min=1.0e-15,
        dt_max=1.0e-12,
    ),
    gamma=2.211e5,
)
study.stages.add_run(stage_id="run", until=1.0e-9)
```

(python-api-dynamics-adaptive-timestep-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`AdaptiveTimestep.to_ir()` emits `tolerance_mode`, `atol`, `rtol`, `dt_initial`, `dt_min`,
`safety`, `growth_limit`, `shrink_limit`, and optional `dt_max`, `max_spin_rotation`,
`norm_tolerance`.

(python-api-dynamics-adaptive-timestep-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Bound violations and zero tolerance pairs fail immediately. A `_from_max_error` policy is a
compatibility normalization, not a distinct physics.

(python-api-dynamics-adaptive-timestep-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
Step selection is realized by the embedded RK estimators and the coupled IMEX step-doubling lane.

(python-api-dynamics-adaptive-timestep-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/dynamics.py` (`class AdaptiveTimestep`).

(python-api-dynamics-adaptive-timestep-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-dynamics-adaptive-timestep-limitations)=
<!-- (limitations)= -->
## Limitations
Adaptive stepping requires an adaptive integrator; fixed-step schemes reject the policy.

(python-api-dynamics-adaptive-timestep-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
Error-control references belong to the time-integration numerical pages.

(python-api-dynamics-adaptive-timestep-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Adaptive policy | `packages/fullmag-py/src/fullmag/model/dynamics.py` | `class AdaptiveTimestep` | Step control lowering | Ownership test |
