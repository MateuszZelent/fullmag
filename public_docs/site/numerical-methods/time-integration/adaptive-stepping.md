---
title: Adaptive Stepping
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-time-integration-adaptive-stepping)=
# Adaptive time stepping

Adaptive stepping changes $Δt$ from one accepted step to the next using an embedded error
estimate. It controls temporal truncation error; it does not estimate spatial error, certify
physical accuracy, or remove the stability restriction imposed by the fastest resolved field.

(time-integration-adaptive-stepping-problem-statement)=
## Numerical problem

For an embedded pair, two approximations of different order are computed from the same stage
right-hand sides. The difference controls acceptance and the next proposed step. Rejected steps
must not advance physical time or duplicate output artifacts.

(time-integration-adaptive-stepping-governing-equations)=
## Governing equations

The normalized error used by the adaptive policy is

```{math}
:label: eq-adaptive-normalized-error
\eta_i=\frac{\lVert e_i\rVert_2}
{a_{\mathrm{tol}}+r_{\mathrm{tol}}\max(\lVert m_i^n\rVert_2,\lVert m_i^{\mathrm{hi}}\rVert_2)}.
```

The global decision metric is

```{math}
:label: eq-adaptive-global-error
\eta=\max_i\eta_i,
\qquad \text{accept if }\eta\leq 1.
```

For estimator order $q$, the raw step ratio is

```{math}
:label: eq-adaptive-controller
r_{\mathrm{raw}}=
\begin{cases}
s\,\eta_n^{-1/(q+1)}, & \text{startup, reset, zero history, or rejected trial},\\
s\,\eta_n^{-0.7/(q+1)}\eta_{n-1}^{0.4/(q+1)}, & \text{accepted trial with positive history},
\end{cases}
\qquad
\Delta t_{\mathrm{new}}=\Delta t\,\operatorname{clamp}
(r_{\mathrm{raw}},\rho_{\mathrm{shrink}},\rho_{\mathrm{growth}}).
```

The ratio is clamped before the absolute `dt_min`/`dt_max` bounds. A rejected trial uses the
startup exponent and does not update $\eta_{n-1}$. Here $q=2$ for RK23 and $q=4$ for RK45.

(time-integration-adaptive-stepping-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $e_i$ | embedded error vector at active point i | $1$ |
| $a_{\mathrm{tol}}$ | absolute tolerance | $1$ |
| $r_{\mathrm{tol}}$ | relative tolerance | $1$ |
| $\eta_i$ | local normalized error | $1$ |
| $\eta$ | global normalized error metric | $1$ |
| $m_i^n,m_i^{\mathrm{hi}}$ | old and high-order candidate magnetization at active point i | $1$ |
| $\eta_{n-1}$ | previous accepted normalized error | $1$ |
| $r_{\mathrm{raw}}$ | unclamped proposed step ratio | $1$ |
| $s$ | controller safety factor | $1$ |
| $q$ | error-estimator order | $1$ |
| $\Delta t$ | current time step | $\mathrm{s}$ |
| $\rho_{\mathrm{shrink}}$ | lower step-ratio limit | $1$ |
| $\rho_{\mathrm{growth}}$ | upper step-ratio limit | $1$ |

(time-integration-adaptive-stepping-assumptions-and-validity)=
## Assumptions and validity

- The error estimate is a temporal estimator for the current spatial mesh and active physics.
- Both tolerances are dimensionless because the reduced magnetization state is dimensionless.
- `dt_min` is a hard lower bound. Hitting it while the error remains above one is a controlled
  failure, not silent acceptance.
- Rejected steps may evaluate fields, but they must not be reported as accepted physical states.

(time-integration-adaptive-stepping-python-api)=
## Python API

```python
# %% Configure an adaptive physical-time study
import fullmag as fm

nm = 1.0e-9
study = fm.study("adaptive_rk45")
study.engine("fdm")
study.device("gpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
body = study.geometry(fm.Box(80 * nm, 20 * nm, 5 * nm), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()

# %% Solver policy and ordered physical-time stage
study.solver(
    integrator="rk45",
    adaptive_timestep=fm.AdaptiveTimestep(
        atol=1.0e-7,
        rtol=1.0e-3,
        dt_min=1.0e-15,
        dt_max=1.0e-12,
    ),
    gamma=2.211e5,
)
study.stages.add_run(until=2.0e-9)
```

The `study.solver(...)` call is the only user-facing solver configuration shown in this
workflow. It lowers the adaptive policy into the canonical `llg` dynamics node; the resolved
integrator, bounds, tolerances, and device remain part of execution provenance.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `AdaptiveTimestep.atol` | `float` | `1e-6` | $1$ | non-negative; not both tolerances zero | absolute error component | RK23/RK45 lanes | `adaptive_timestep.atol` |
| `AdaptiveTimestep.rtol` | `float` | `1e-3` | $1$ | non-negative; not both tolerances zero | relative error component | RK23/RK45 lanes | `adaptive_timestep.rtol` |
| `AdaptiveTimestep.dt_initial` | `float \| None` | `None` | $\mathrm{s}$ | positive and within bounds when set | first proposed step | lane-dependent | `adaptive_timestep.dt_initial` |
| `AdaptiveTimestep.dt_min` | `float` | `1e-15` | $\mathrm{s}$ | positive | minimum allowed step | RK23/RK45 lanes | `adaptive_timestep.dt_min` |
| `AdaptiveTimestep.dt_max` | `float \| None` | `None` | $\mathrm{s}$ | positive and no smaller than dt_min when set | maximum allowed step | RK23/RK45 lanes | `adaptive_timestep.dt_max` |
| `AdaptiveTimestep.safety` | `float` | `0.9` | $1$ | finite and in (0,1] | conservative controller factor | RK23/RK45 lanes | `adaptive_timestep.safety` |
| `AdaptiveTimestep.growth_limit` | `float` | `2.0` | $1$ | finite and > 1 | maximum step growth ratio | RK23/RK45 lanes | `adaptive_timestep.growth_limit` |
| `AdaptiveTimestep.shrink_limit` | `float` | `0.2` | $1$ | finite and in (0,1) | minimum step ratio | RK23/RK45 lanes | `adaptive_timestep.shrink_limit` |

(time-integration-adaptive-stepping-problem-ir)=
## ProblemIR

The policy lowers to an `adaptive_timestep` object nested under the `llg` dynamics node. Defaults
are materialized by the Python constructor, while omitted `dt_max`, `dt_initial`, spin-rotation,
and norm controls remain `null`/absent according to the serializer. `rk23` and `rk45` are the
only explicit adaptive method names accepted by the current `LLG` validator.

(time-integration-adaptive-stepping-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Round-trip export preserves requested intent, requested tolerances, and bounds, then records resolved execution
separately. Validation errors cover both zero tolerances, invalid bounds, invalid safety or
growth/shrink ratios, and fixed/adaptive timestep conflicts. Unsupported combinations are
reported by the planner; the runtime must not silently downgrade an adaptive request to a fixed
step. A step that reaches `dt_min` without meeting the error policy is a failed execution state.

(time-integration-adaptive-stepping-discrete-realization)=
## FDM/FEM and CPU/GPU realization

| Lane | Realization | Status |
|---|---|---|
| FDM CPU | reference error decision over active structured-grid state | reference-executable |
| FDM GPU | device-side error reduction and controller inputs, avoiding host error vectors | source-visible; executed-device qualification remains pending |
| FEM CPU | error policy consumes FEM stage states and reusable RHS workspace | production-executable; registry qualification remains separate |
| FEM GPU | device reduction and native adaptive workspace | production-executable; registry qualification remains separate |

The GPU distinction is material: error reductions and stage data can remain device-resident,
whereas the CPU reference uses host-visible state. These are two realizations of the same
accept/reject semantics, not two different tolerance meanings.

(time-integration-adaptive-stepping-implementation-mapping)=
## Implementation mapping

`AdaptiveTimestep` owns public validation and IR serialization. FDM CUDA reductions provide the
device-side error scalar and the integrator consumes it. FEM integrator modules own stage
workspace and endpoint refresh policy.

(time-integration-adaptive-stepping-validation)=
## Validation

The relevant checks are Python constructor tests, FDM adaptive error-reduction contracts, and
FEM explicit-RK contracts. Runtime qualification must record accepted/rejected step counts,
resolved `dt`, tolerance values, field-refresh policy, device identity, and final observable
agreement. A green structural test is not a physical convergence proof.

(time-integration-adaptive-stepping-limitations)=
## Limitations

Adaptive time stepping does not adapt mesh size, demagnetization accuracy, linear-solver `rtol`,
or material parameters. The current policy does not expose a user-defined controller formula.
Tolerances are dimensionless state tolerances, not SI field tolerances.

(time-integration-adaptive-stepping-scientific-bibliography)=
## Scientific bibliography

- E. Hairer, S. P. Nørsett, G. Wanner, *Solving Ordinary Differential Equations I*, Springer, 1993, DOI: [10.1007/978-3-540-78862-1](https://doi.org/10.1007/978-3-540-78862-1).
- J. R. Dormand, P. J. Prince, “A family of embedded Runge-Kutta formulae,” *Journal of Computational and Applied Mathematics* 6 (1980), DOI: [10.1016/0771-050X(80)90013-3](https://doi.org/10.1016/0771-050X(80)90013-3).

(time-integration-adaptive-stepping-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Public adaptive policy | `packages/fullmag-py/src/fullmag/model/dynamics.py` | `class AdaptiveTimestep` | validates and serializes controller parameters | public lanes | Python tests |
| LLG compatibility checks | `packages/fullmag-py/src/fullmag/model/dynamics.py` | `class LLG` | rejects incompatible fixed/adaptive requests | public lanes | Python tests |
| FDM CPU PI controller | `crates/fullmag-engine/src/fdm/cpu/integrators.rs` | `decide_adaptive_step` | history-aware acceptance/retry and bounded next-step decision | FDM CPU | engine integrator tests |
| Shared native PI controller | `native/include/fullmag_adaptive_step_decision.hpp` | `decide_adaptive_step` | canonical history-aware PI exponents, rejection rule and clamping | FEM CPU/GPU | native adaptive contract tests |
| FEM CPU controller bridge | `backends/fem/cpu/mfem/integrators/adaptive_dt.cpp` | `cpu_adaptive_step_decision` | maps FEM policy/input into the shared native decision | FEM CPU | native FEM adaptive tests |
| FEM GPU controller bridge | `backends/fem/gpu/cuda/integrators/rk/rk_adaptive_runtime.cu` | `gpu_host_adaptive_step_decision` | maps device-lane metrics into the same shared decision | FEM GPU | CUDA adaptive contract tests |
| FDM CPU error norm | `crates/fullmag-engine/src/fdm/cpu/integrators.rs` | `max_error_norm_buf` / `max_error_norm_soa_buf` | AoS/SoA active-cell mixed error norm and maximum reduction | FDM CPU | engine integrator tests |
| FEM CPU error norm | `backends/fem/cpu/mfem/integrators/adaptive_dt.cpp` | `compute_adaptive_error_norm` | active-node mixed error norm and maximum reduction | FEM CPU | native FEM contract tests |
| FEM GPU error norm | `backends/fem/gpu/cuda/integrators/rk/adaptive_error_kernels.cu` | `fullmag_cuda_adaptive_error_norm_blocks` | device-block mixed error norm reduction | FEM GPU | CUDA contract tests |
| Device-side adaptive error policy | `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu` | `reduce_adaptive_error_policy` | computes the adaptive error decision input | FDM GPU | FDM CUDA contract tests |
| Scalar reduction implementation | `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu` | `reduce_max_scalar_sqrt` | reduces error/state scalars on the CUDA path | FDM GPU | FDM CUDA contract tests |
