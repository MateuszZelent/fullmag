---
title: Explicit Runge Kutta
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-time-integration-explicit-runge-kutta)=
# Explicit Runge--Kutta integration

This page describes explicit Runge--Kutta (RK) stepping of the semi-discrete LLG
equation. The method is temporal only: exchange, demagnetization, anisotropy, and applied
fields still come from the selected spatial realization.

(time-integration-explicit-runge-kutta-problem-statement)=
## Physical and numerical problem

After FDM or FEM spatial discretization, the magnetization state is represented by a vector
$y(t)$ and the backend exposes a right-hand side $F(y,t)$. The integrator must advance this
state while preserving the LLG tangent-flow contract, reporting the actual field evaluations,
and leaving the requested output state reproducible.

(time-integration-explicit-runge-kutta-governing-equations)=
## Governing equations

The reduced-magnetization LLG right-hand side is

```{math}
:label: eq-time-llg-rhs
\frac{\mathrm d\mathbf m}{\mathrm dt}=F(\mathbf m,t)=
-\frac{\gamma}{1+\alpha^2}\left[\mathbf m\times\mathbf H_{\mathrm{eff}}
+\alpha\,\mathbf m\times(\mathbf m\times\mathbf H_{\mathrm{eff}})\right].
```

For an explicit $s$-stage RK method, stage $j$ and its right-hand side are

```{math}
:label: eq-rk-stage
Y_j=y_n+\Delta t\sum_{\ell=1}^{j-1}a_{j\ell}K_\ell,
\qquad K_j=F(Y_j,t_n+c_j\Delta t).
```

The accepted state is

```{math}
:label: eq-rk-update
y_{n+1}=y_n+\Delta t\sum_{j=1}^{s}b_jK_j.
```

For embedded adaptive pairs the companion estimate is

```{math}
:label: eq-rk-embedded-error
\widetilde y_{n+1}=y_n+\Delta t\sum_{j=1}^{s}\widetilde b_jK_j,
\qquad e_{n+1}=y_{n+1}-\widetilde y_{n+1}.
```

(time-integration-explicit-runge-kutta-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf m$ | reduced magnetization | $1$ |
| $y$ | assembled semi-discrete magnetization state | $1$ |
| $F$ | semi-discrete LLG right-hand side | $\mathrm{s^{-1}}$ |
| $\mathbf H_{\mathrm{eff}}$ | effective magnetic field | $\mathrm{A\,m^{-1}}$ |
| $\gamma$ | gyromagnetic ratio in the Fullmag convention | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $\alpha$ | Gilbert damping parameter | $1$ |
| $t_n$ | beginning of the accepted step | $\mathrm{s}$ |
| $\Delta t$ | proposed time step | $\mathrm{s}$ |
| $Y_j$ | state at RK stage j | $1$ |
| $K_j$ | right-hand side at RK stage j | $\mathrm{s^{-1}}$ |
| $a_{j\ell},b_j,c_j,\widetilde b_j$ | explicit RK stage coefficient; accepted RK output coefficient; RK stage time coefficient; embedded RK output coefficient | $1$ |
| $e_{n+1}$ | embedded local error estimate | $1$ |

(time-integration-explicit-runge-kutta-assumptions-and-validity)=
## Assumptions and validity

- The spatial operator returns the same physical effective field used by the LLG RHS; the
  integrator does not reinterpret field signs or units.
- Explicit RK stability remains conditional. A high-order method does not remove the exchange
  or demagnetization time-step restriction.
- `rk23` and `rk45` are embedded adaptive families. `heun` and `rk4` are fixed-step families
  in the current public `LLG` contract.
- The discrete stage state can deviate from $|\mathbf m|=1$ in finite precision. Norm control
  and diagnostics are backend policies, not a license to change the physical equation.

(time-integration-explicit-runge-kutta-python-api)=
## Python API

The stage-first workflow below is directly copyable into a notebook. It requests an FDM CPU
double-precision run; it does not claim that the local request itself proves device execution.

```python
# %% Imports and SI constants
import fullmag as fm

nm = 1.0e-9
study = fm.study("rk_time_integration")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.cell(2 * nm, 2 * nm, 5 * nm)

# %% Physical domain and interaction request
body = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()

# %% Solver policy and ordered physical-time stage
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
study.stages.add_run(until=1.0e-9)
```

`study.solver(...)` is the canonical user-facing solver-policy call in the stage workflow. It
lowers the requested method and adaptive policy into the canonical `llg` dynamics node. There
is no second object-constructor workflow in this page.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `LLG.gamma` | `float` | `2.211e5` | $\mathrm{m\,A^{-1}\,s^{-1}}$ | finite and $>0$ | gyromagnetic ratio | FEM/FDM CPU/GPU | `study.dynamics.gyromagnetic_ratio` |
| `LLG.integrator` | `str` | `"auto"` | $1$ | `heun`, `rk4`, `rk23`, `rk45`, `abm3`, `auto`; aliases `bs23`, `dp54` normalize | temporal method request | lane-dependent; planner resolves `auto` | `study.dynamics.integrator` |
| `LLG.fixed_timestep` | `float \| None` | `None` | $\mathrm{s}$ | finite and $>0$ when set; exclusive with adaptive policy | requested fixed step | FEM/FDM CPU/GPU subject to lane support | `study.dynamics.fixed_timestep` |
| `AdaptiveTimestep.atol` | `float` | `1e-6` | $1$ | non-negative; not both tolerances zero | absolute error tolerance | RK23/RK45 lanes | `study.dynamics.adaptive_timestep.atol` |
| `AdaptiveTimestep.rtol` | `float` | `1e-3` | $1$ | non-negative; not both tolerances zero | relative error tolerance | RK23/RK45 lanes | `study.dynamics.adaptive_timestep.rtol` |
| `AdaptiveTimestep.dt_min` | `float` | `1e-15` | $\mathrm{s}$ | positive; no larger than `dt_max` | lower step bound | RK23/RK45 lanes | `study.dynamics.adaptive_timestep.dt_min` |
| `AdaptiveTimestep.dt_max` | `float \| None` | `None` | $\mathrm{s}$ | positive and >= `dt_min` | upper step bound | RK23/RK45 lanes | `study.dynamics.adaptive_timestep.dt_max` |
| `StudyBuilder.solver(integrator=...)` | `str \| None` | `None` | $1$ | validated integrator name; aliases normalize | stage-workflow solver method request | FEM/FDM lanes according to planner | `study.dynamics.integrator` |
| `StudyBuilder.solver(adaptive_timestep=...)` | `AdaptiveTimestep \| None` | `None` | $1$ | mutually exclusive with fixed/convenience controls | stage-workflow adaptive policy | RK23/RK45 lanes | `study.dynamics.adaptive_timestep` |

(time-integration-explicit-runge-kutta-problem-ir)=
## ProblemIR and normalization

The `LLG.to_ir()` result for the object-level example is the canonical dynamics fragment:

```json
{
  "kind": "llg",
  "gyromagnetic_ratio": 221100.0,
  "integrator": "rk45",
  "fixed_timestep": null,
  "adaptive_timestep": {
    "tolerance_mode": "advanced",
    "atol": 1e-06,
    "rtol": 0.001,
    "dt_initial": null,
    "dt_min": 1e-15,
    "safety": 0.9,
    "growth_limit": 2.0,
    "shrink_limit": 0.2
  }
}
```

`study.solver(...)` normalizes the requested method into the canonical dynamics node. `dp54` normalizes to `rk45` and `bs23` normalizes to `rk23` before lowering. `auto` remains
requested intent until planner resolution; the resolved execution records the selected method,
device, precision, and field-refresh policy as provenance.

(time-integration-explicit-runge-kutta-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

The canonical export preserves requested intent separately from resolved execution. Validation errors
are raised before execution for unknown integrators, non-positive `gamma`, non-positive
step bounds, conflicting fixed and adaptive policies, or an adaptive policy attached to a
non-adaptive integrator. Unsupported combinations are planner failures, not silent fallback;
the error must identify the solver, device, precision, and requested method.

(time-integration-explicit-runge-kutta-discrete-realization)=
## Discrete realization by solver and device

| Lane | Realization | Current evidence and qualification |
|---|---|---|
| FDM CPU | Structured-grid RHS and temporal update in the reference lane | documented contract; numerical qualification is tracked by FDM time-step tests |
| FDM GPU | CUDA RK kernels with device-resident stage workspaces in supported precision paths | source-backed; executed-device parity must be proven separately for each precision |
| FEM CPU | MFEM stage RHS evaluation and reusable explicit-RK workspace | source-backed and covered by native contract tests; production qualification is scenario-specific |
| FEM GPU | CUDA/MFEM source-facade path with separate device workspace policy | source-backed; no claim of universal GPU qualification without managed executed-device evidence |

FSAL reuse is allowed only when the cached RHS belongs to the accepted endpoint and the source
state is unchanged between endpoint and next-stage evaluation. A thermal or time-dependent
source can disable reuse. A final field refresh is part of reported work when exact final-state
observables are requested.

(time-integration-explicit-runge-kutta-implementation-mapping)=
## Implementation mapping

The public model is lowered by `LLG.to_ir`; the stage builder captures ordered run stages. FEM
keeps RK workspace and stage RHS evaluation in integrator modules rather than embedding them in
the global context. FDM CUDA kernels own the lane-specific stage arithmetic and reductions.

(time-integration-explicit-runge-kutta-validation)=
## Validation

Validation is split into structural contract tests, numerical order tests, and executed-runtime
qualification. `backends/fem/tests/rk_explicit_contract.cpp` checks module ownership and RK
workspace boundaries. FDM adaptive/error-reduction tests check step-decision behavior. A passing
source or unit test does not by itself prove CPU/GPU physical parity; that requires a managed run
with recorded device identity, precision, tolerances, accepted/rejected steps, and observable
agreement.

(time-integration-explicit-runge-kutta-limitations)=
## Limitations and qualification boundary

Explicit RK is not an unconditional stiff solver. The public method names do not imply that all
four lanes support every method at every precision. `auto` is a request for planner resolution,
not a promise of a particular tableau. Tangent-plane and fully implicit methods are documented
separately and must not be inferred from the explicit RK page.

(time-integration-explicit-runge-kutta-scientific-bibliography)=
## Scientific bibliography

- J. C. Butcher, *Numerical Methods for Ordinary Differential Equations*, 3rd ed., Wiley, 2016, DOI: [10.1002/9781119121534](https://doi.org/10.1002/9781119121534).
- E. Hairer, S. P. Nørsett, G. Wanner, *Solving Ordinary Differential Equations I*, 2nd ed., Springer, 1993, DOI: [10.1007/978-3-540-78862-1](https://doi.org/10.1007/978-3-540-78862-1).
- W. F. Brown, Jr., *Micromagnetics*, Wiley, 1963.

(time-integration-explicit-runge-kutta-source-code-index)=
## Source-code index

| Claim or equation | Repository path | Stable symbol | Responsibility | Lane | Tests/evidence |
|---|---|---|---|---|---|
| Public LLG and integrator normalization | `packages/fullmag-py/src/fullmag/model/dynamics.py` | `class LLG` | validates and serializes dynamics | all public lanes | Python API tests |
| Adaptive controller parameters | `packages/fullmag-py/src/fullmag/model/dynamics.py` | `class AdaptiveTimestep` | validates and serializes adaptive policy | RK23/RK45 | Python API tests |
| Canonical stage-workflow solver call | `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` | exposes `study.solver(...)` and forwards to canonical world state | all public lanes | stage/API tests |
| FEM RK stage RHS | `backends/fem/cpu/mfem/integrators/rk_stage_rhs.cpp` | `evaluate_rk_stage_rhs` | evaluates one FEM stage RHS | FEM CPU | `rk_explicit_contract.cpp` |
| FEM explicit step | `backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp` | `context_step_explicit_rk_mfem` | advances one explicit RK step | FEM CPU | `rk_explicit_contract.cpp` |
| FEM RK workspace implementation | `backends/fem/cpu/mfem/integrators/rk_explicit.cpp` | `stepper_workspace_allocate` | allocates reusable explicit-RK workspace | FEM CPU | native contract test |
