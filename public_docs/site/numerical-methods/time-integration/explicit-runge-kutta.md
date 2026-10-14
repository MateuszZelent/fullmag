---
title: Explicit Runge Kutta
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: a1de38b4d7dad275dccbdbfd937b757d6ca7ee99
source_of_truth: "LLG and AdaptiveTimestep validation, ProblemIR lowering, and explicit RK lane implementations"
---

(public-docs-numerical-methods-time-integration-explicit-runge-kutta)=
# Explicit Runge–Kutta Methods

(numerical-methods-time-integration-explicit-runge-kutta-problem-statement)=
<!-- (problem-statement)= -->
## Scope and purpose

This chapter documents the explicit Runge–Kutta (`heun`, `rk4`, `rk23`, `rk45`) and fixed-step multistep (`abm3`, `coupled_imex_ark2`) time integrators used by Fullmag to advance the semi-discrete Landau–Lifshitz–Gilbert (LLG) equation. It covers the stage equations, embedded error estimators, First-Same-As-Last (FSAL) stage reuse policy, unit-sphere stage normalization, reusable workspace allocation, and cross-lane source mapping across FEM and FDM CPU/GPU realizations.

(numerical-methods-time-integration-explicit-runge-kutta-governing-equations)=
<!-- (governing-equations)= -->
## Scientific and numerical model

Let $y(t) = \{\mathbf{m}_i(t)\}_{i \in \mathcal{A}}$ denote the assembled semi-discrete magnetization state on active magnetic degrees of freedom $i \in \mathcal{A}$ ($M_{s,i} > 0$). The semi-discrete LLG right-hand side is

```{math}
:label: eq-time-llg-rhs
\frac{\mathrm{d}\mathbf{m}_i}{\mathrm{d}t}
=
F_i(\mathbf{m}, t)
=
-\frac{\gamma}{1 + \alpha_i^2}
\left[
s_{\mathrm{prec}}\,\mathbf{m}_i \times \mathbf{H}_{\mathrm{eff},i}(\mathbf{m}, t)
+
\alpha_i\,\mathbf{m}_i \times \left(\mathbf{m}_i \times \mathbf{H}_{\mathrm{eff},i}(\mathbf{m}, t)\right)
\right]
+
\boldsymbol{\tau}_{\mathrm{direct},i}(\mathbf{m}, t).
```

Given an accepted state $y_n$ at time $t_n$ and an attempted step size $\Delta t > 0$, an $S$-stage explicit Runge–Kutta method with Butcher tableau $(a_{j\ell}, b_j, \widetilde{b}_j, c_j)$ evaluates intermediate stage states $Y_j$ and stage derivatives $K_j$ for $j = 1, \dots, S$:

```{math}
:label: eq-rk-stage
Y_j = \mathcal{N}\!\left(y_n + \Delta t \sum_{\ell=1}^{j-1} a_{j\ell}\,K_\ell\right),
\qquad
K_j = F\!\left(t_n + c_j \Delta t,\, Y_j\right),
```

where $\mathcal{N}(\cdot)$ normalizes each active 3-vector $\mathbf{m}_i$ back onto the unit sphere $\mathbb{S}^2$ ($\|\mathbf{m}_i\|_2 = 1$) while keeping non-magnetic entries zero. The high-order candidate state at $t_n + \Delta t$ is formed and normalized as

```{math}
:label: eq-rk-update
y_{n+1} = \mathcal{N}\!\left(y_n + \Delta t \sum_{j=1}^{S} b_j\,K_j\right).
```

For embedded adaptive pairs (`rk23` Bogacki–Shampine 3(2) with $S=4, p=2$ and `rk45` Dormand–Prince 5(4) with $S=7, p=4$), the unnormalized local truncation error vector at each active point is the difference between the high-order ($b_j$) and embedded low-order ($\widetilde{b}_j$) stage combinations:

```{math}
:label: eq-rk-embedded-error
e_{n+1} = \Delta t \sum_{j=1}^{S} \left(b_j - \widetilde{b}_j\right) K_j.
```

(numerical-methods-time-integration-explicit-runge-kutta-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
### Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $\mathbf m$ | reduced magnetization | $1$ |
| $y$ | assembled semi-discrete magnetization state | $1$ |
| $F$ | semi-discrete LLG right-hand side | $\mathrm{s^{-1}}$ |
| $\mathbf H_{\mathrm{eff}}$ | effective magnetic field | $\mathrm{A\,m^{-1}}$ |
| $\gamma$ | gyromagnetic ratio | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $\alpha$ | Gilbert damping parameter | $1$ |
| $t_n$ | beginning of the accepted step | $\mathrm{s}$ |
| $\Delta t$ | proposed time step | $\mathrm{s}$ |
| $Y_j$ | state at RK stage j | $1$ |
| $K_j$ | right-hand side at RK stage j | $\mathrm{s^{-1}}$ |
| $a_{j\ell}$ | explicit RK stage coefficient | $1$ |
| $b_j$ | accepted RK output coefficient | $1$ |
| $c_j$ | RK stage time coefficient | $1$ |
| $\widetilde b_j$ | embedded RK output coefficient | $1$ |
| $e_{n+1}$ | embedded local error estimate | $1$ |

(numerical-methods-time-integration-explicit-runge-kutta-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
### Assumptions, FSAL reuse, and multistep checkpointing

- **First-Same-As-Last (FSAL) reuse (`rk23`, `rk45`)**: Both Bogacki–Shampine 3(2) and Dormand–Prince 5(4) satisfy $a_{S,\ell} = b_\ell$, so stage $S$ is evaluated at the candidate state prior to final endpoint normalization. On GPU (`gpu_rk_rhs_allows_fsal_reuse`), FSAL reuse is enabled only when operator signatures match and neither stochastic Brown thermal fields, stage callbacks, frozen-spin projections, nor unqualified periodic projections are active.
- **Three-step Adams–Bashforth–Moulton (`abm3` on FDM CPU)**: Bootstraps the first three steps with `rk4`, then advances via the 3-step predictor–corrector (`abm3_step_soa_state_buf`). Exact multistep history is serialized in `FdmCpuSolverCheckpointV1` and restored by `resume_reference_fdm_from_abm3_checkpoint`.
- **Stability limits (`LLG-TD-STIFF-V1`)**: Explicit Runge–Kutta schemes have bounded absolute stability regions along the imaginary and negative real axes; exchange stiffness scales as $\mathcal{O}(A_{\mathrm{ex}} / (M_s h_{\min}^2))$.

(numerical-methods-time-integration-explicit-runge-kutta-discrete-realization)=
<!-- (discrete-realization)= -->
(numerical-methods-time-integration-explicit-runge-kutta-implementation-mapping)=
<!-- (implementation-mapping)= -->
### Discrete realization and backend support matrix

| Solver | Device | Status | Realization notes |
| --- | --- | --- | --- |
| FEM | CPU | `documented` | Native MFEM explicit RK workspace (`stepper_workspace_allocate`), stage evaluator (`evaluate_rk_stage_rhs`), and step driver (`context_step_explicit_rk_mfem`). |
| FEM | GPU | `source-backed` | Device-resident CUDA RK driver (`gpu_rk_device_resident_step`) and attempt loop (`gpu_rk_run_accepted_attempt_loop`); executed-device qualification is reported in runtime receipts. |
| FDM | CPU | `documented` | SoA explicit RK (`heun`, `rk4`, `rk23`, `rk45`), `abm3` (`abm3_step_soa_state_buf`), and `coupled_imex_ark2` in `crates/fullmag-engine/src/fdm/cpu/integrators.rs`. |
| FDM | GPU | `source-backed` | CUDA explicit RK stage kernels and fp64/fp32 reductions; parity and qualification depend on precision and active interactions. |

## Parameters

| Python surface | Type | Default | SI unit | Validation / constraints | Meaning | Backend support | `ProblemIR` path |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `LLG.gamma` | `float` | `2.211e5` | $\mathrm{m\,A^{-1}\,s^{-1}}$ | finite and $> 0$ | gyromagnetic ratio | FEM/FDM CPU/GPU | `study.dynamics.gyromagnetic_ratio` |
| `LLG.integrator` | `str` | `auto` | $1$ | `heun`, `rk4`, `rk23`, `rk45`, `abm3`, `coupled_imex_ark2`, `auto` | temporal method request | lane-dependent | `study.dynamics.integrator` |
| `LLG.fixed_timestep` | `float \| None` | `None` | $\mathrm{s}$ | finite and $> 0$; incompatible with `rk23`/`rk45` | requested fixed step | FEM/FDM CPU/GPU subject to lane support | `study.dynamics.fixed_timestep` |
| `AdaptiveTimestep.atol` | `float` | `1e-6` | $1$ | non-negative; not both tolerances zero | absolute error tolerance | RK23/RK45 lanes | `study.dynamics.adaptive_timestep.atol` |
| `AdaptiveTimestep.rtol` | `float` | `1e-3` | $1$ | non-negative; not both tolerances zero | relative error tolerance | RK23/RK45 lanes | `study.dynamics.adaptive_timestep.rtol` |
| `AdaptiveTimestep.dt_min` | `float` | `1e-15` | $\mathrm{s}$ | positive | lower step bound | RK23/RK45 lanes | `study.dynamics.adaptive_timestep.dt_min` |
| `AdaptiveTimestep.dt_max` | `float \| None` | `None` | $\mathrm{s}$ | positive and $\ge \Delta t_{\min}$ | upper step bound | RK23/RK45 lanes | `study.dynamics.adaptive_timestep.dt_max` |
| `StudyBuilder.solver(integrator=...)` | `str \| None` | `None` | $1$ | validated integrator name; aliases normalize | stage-workflow solver method request | FEM/FDM lanes according to planner | `study.dynamics.integrator` |
| `StudyBuilder.solver(adaptive_timestep=...)` | `AdaptiveTimestep \| None` | `None` | $1$ | mutually exclusive with fixed/convenience controls | stage-workflow adaptive policy | RK23/RK45 lanes | `study.dynamics.adaptive_timestep` |

(numerical-methods-time-integration-explicit-runge-kutta-python-api)=
<!-- (python-api)= -->
## Python API

```python
# %%
import fullmag as fm

world = fm.World(
    dx=5e-9,
    dy=5e-9,
    dz=5e-9,
    nx=16,
    ny=4,
    nz=1,
    boundaries=fm.BoundaryConfig.open(method="fft"),
)
world.add_box(
    "strip",
    size=(80e-9, 20e-9, 5e-9),
    material=fm.Material.permalloy(Ms=8.0e5, Aex=1.3e-11, alpha=0.02),
    m_init=fm.VectorFieldSpec.uniform((1.0, 0.05, 0.0)),
    demag=True,
)

# Adaptive Dormand-Prince RK45 configuration
study = fm.study(world, target="fdm", device="cpu", precision="fp64")
study.solver(
    integrator="rk45",
    gamma=2.211e5,
    adaptive_timestep=fm.AdaptiveTimestep(
        atol=1e-6,
        rtol=1e-4,
        dt_initial=1e-13,
        dt_min=1e-15,
        dt_max=2e-12,
    ),
)
study.stages.add_time(name="ringdown", duration=0.2e-9, Bx=15e-3, save_m_every=50e-12)

# Fixed-step RK4 configuration
study_rk4 = fm.study(world, target="fdm", device="cpu", precision="fp64")
study_rk4.solver(integrator="rk4", gamma=2.211e5, fixed_timestep=1e-13)
study_rk4.stages.add_time(name="fixed_pulse", duration=0.1e-9, By=5e-3, save_m_every=25e-12)
```

(numerical-methods-time-integration-explicit-runge-kutta-problem-ir)=
<!-- (problem-ir)= -->
### `ProblemIR` excerpt

```json
{
  "study": {
    "kind": "stage_workflow",
    "dynamics": {
      "equation": "llg",
      "gyromagnetic_ratio": 221100.0,
      "integrator": "rk45",
      "fixed_timestep": null,
      "adaptive_timestep": {
        "atol": 1e-06,
        "rtol": 0.0001,
        "dt_initial": 1e-13,
        "dt_min": 1e-15,
        "dt_max": 2e-12,
        "safety": 0.9,
        "growth_limit": 2.0,
        "shrink_limit": 0.2,
        "max_spin_rotation": null,
        "norm_tolerance": null
      },
      "field_refresh": null
    }
  }
}
```

## Control Room workflow

- **Solver Inspector**: Selects `integrator` (`auto`, `rk45`, `rk23`, `rk4`, `heun`, `abm3`, `coupled_imex_ark2`) and switches between fixed-step (`fixed_timestep`) and adaptive (`AdaptiveTimestep`) controls.
- **Stage Execution Diagnostics**: Displays accepted steps, rejected step attempts, active $\Delta t$, total stage RHS evaluations, and FSAL reuse counters.

(numerical-methods-time-integration-explicit-runge-kutta-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
(numerical-methods-time-integration-explicit-runge-kutta-validation)=
<!-- (validation)= -->
(numerical-methods-time-integration-explicit-runge-kutta-limitations)=
<!-- (limitations)= -->
## Diagnostics and failure semantics

- **Requested intent and resolved execution**: `ProblemIR` preserves the user's `requested intent` (`integrator="auto"` or explicit scheme), while the planner and execution receipt record the concrete `resolved execution` method and device lane.
- **Validation errors**: Combining `fixed_timestep` with `rk23`/`rk45` or `adaptive_timestep` with `heun`/`rk4`/`abm3`/`coupled_imex_ark2` raises immediate `ValueError` validation errors in Python and planner rejection in Rust.
- **Unsupported combinations**: Requesting `abm3` on `target="fem"` or `coupled_imex_ark2` without coupled magnetoelastic dynamics is rejected as an unsupported combination before solver startup.
- **Atomic stage failure (`LLG-TD-ATOMIC-V1`)**: Non-finite stage fields or RHS evaluations immediately abort the attempted step and restore the pre-attempt magnetization and effective-field snapshot (`rk_step_transaction.hpp`).

(numerical-methods-time-integration-explicit-runge-kutta-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
### Scientific bibliography

1. J. R. Dormand and P. J. Prince, *A family of embedded Runge–Kutta formulae*, J. Comput. Appl. Math. **6**, 19–26 (1980).
2. P. Bogacki and L. F. Shampine, *A 3(2) pair of Runge–Kutta formulas*, Appl. Math. Lett. **2**, 321–325 (1989).

(numerical-methods-time-integration-explicit-runge-kutta-source-code-index)=
<!-- (source-code-index)= -->
## Where this is implemented

| Layer | File | Symbol | Responsibility |
| --- | --- | --- | --- |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/dynamics.py#L158) | [`class LLG`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/dynamics.py#L158) | Public LLG integrator contract and `ProblemIR` serialization |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/dynamics.py#L30) | [`class AdaptiveTimestep`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/dynamics.py#L30) | Adaptive tolerance and step-bound validation |
| Python DSL | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L5064) | [`class StudyBuilder`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L5064) | Canonical stage-workflow solver-policy facade |
| Native FEM CPU | [`backends/fem/cpu/mfem/integrators/rk_stage_rhs.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/mfem/integrators/rk_stage_rhs.cpp#L23) | [`evaluate_rk_stage_rhs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/mfem/integrators/rk_stage_rhs.cpp#L23) | FEM stage right-hand-side evaluation |
| Native FEM CPU | [`backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp#L126) | [`context_step_explicit_rk_mfem`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp#L126) | FEM explicit RK step execution |
| Native FEM CPU | [`backends/fem/cpu/mfem/integrators/rk_explicit.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/mfem/integrators/rk_explicit.cpp#L161) | [`stepper_workspace_allocate`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/mfem/integrators/rk_explicit.cpp#L161) | FEM reusable explicit-RK workspace implementation |
| Native FEM GPU | [`backends/fem/gpu/cuda/integrators/rk/rk_step.cu`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/gpu/cuda/integrators/rk/rk_step.cu#L24) | [`gpu_rk_device_resident_step`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/gpu/cuda/integrators/rk/rk_step.cu#L24) | Device-resident GPU RK step orchestration |
| Native FEM GPU | [`backends/fem/gpu/cuda/integrators/rk/rk_attempt_loop.cu`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/gpu/cuda/integrators/rk/rk_attempt_loop.cu#L102) | [`gpu_rk_run_accepted_attempt_loop`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/gpu/cuda/integrators/rk/rk_attempt_loop.cu#L102) | GPU RK accepted-attempt loop and atomic rollback |
| Native FEM GPU | [`backends/fem/gpu/cuda/integrators/rk/rk_fsal_policy.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/gpu/cuda/integrators/rk/rk_fsal_policy.cpp#L33) | [`gpu_rk_rhs_allows_fsal_reuse`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/gpu/cuda/integrators/rk/rk_fsal_policy.cpp#L33) | Host-side FSAL eligibility and operator-signature policy |
| FDM Engine | [`crates/fullmag-engine/src/fdm/cpu/state.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-engine/src/fdm/cpu/state.rs#L29) | [`FdmCpuSolverCheckpointV1`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-engine/src/fdm/cpu/state.rs#L29) | FDM CPU multistep (`abm3`) checkpoint state representation |
| FDM Runner | [`crates/fullmag-runner/src/lib.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/lib.rs#L6064) | [`resume_reference_fdm_from_abm3_checkpoint`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/lib.rs#L6064) | Resumes FDM CPU `abm3` execution from a saved multistep checkpoint |
