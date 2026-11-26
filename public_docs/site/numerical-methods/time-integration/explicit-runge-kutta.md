---
title: Explicit Runge Kutta
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
source_of_truth: "LLG and AdaptiveTimestep validation, ProblemIR lowering, and explicit RK/ABM3 lane implementations"
---

(public-docs-numerical-methods-time-integration-explicit-runge-kutta)=
# Explicit Runge–Kutta Methods

(numerical-methods-time-integration-explicit-runge-kutta-problem-statement)=
## Scope and purpose

This chapter documents the explicit Runge–Kutta (`heun`, `rk4`, `rk23`, `rk45`) and fixed-step multistep (`abm3`) time integrators used by FullMag to advance the semi-discrete Landau–Lifshitz–Gilbert (LLG) equation, together with their relationship to the adaptive coupled spin-transport scheme (`coupled_imex_ark2`). It covers stage equations, embedded error estimators, First-Same-As-Last (FSAL) stage reuse, unit-sphere stage normalization, GPU kernel fusion and potential prediction, reusable workspace allocation, and cross-lane implementation mapping across FEM and FDM CPU/GPU realizations.

(numerical-methods-time-integration-explicit-runge-kutta-governing-equations)=
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

For embedded adaptive pairs (`rk23` Bogacki–Shampine 3(2) with aliases `bs23`/`rk32`, $S=4, p=2$, and `rk45` Dormand–Prince 5(4) with alias `dp54`, $S=7, p=4$), the unnormalized local truncation error vector at each active point is the difference between the high-order ($b_j$) and embedded low-order ($\widetilde{b}_j$) stage combinations:

```{math}
:label: eq-rk-embedded-error
e_{n+1} = \Delta t \sum_{j=1}^{S} \left(b_j - \widetilde{b}_j\right) K_j.
```

For fixed-step `abm3` (Adams–Bashforth–Moulton 3rd-order predictor–corrector on FDM CPU/GPU and FEM CPU reference), the first three steps are bootstrapped with `rk4`, after which each step advances from the accepted endpoint history $(F_n, F_{n-1}, F_{n-2})$ via the projected AB3 predictor and AM3 corrector with history refresh at the accepted endpoint state $y_{n+1}$.

(numerical-methods-time-integration-explicit-runge-kutta-symbols-and-si-units)=
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
| $Y_j$ | state at RK stage $j$ | $1$ |
| $K_j$ | right-hand side at RK stage $j$ | $\mathrm{s^{-1}}$ |
| $a_{j\ell}$ | explicit RK stage coefficient | $1$ |
| $b_j$ | accepted RK output coefficient | $1$ |
| $c_j$ | RK stage time coefficient | $1$ |
| $\widetilde b_j$ | embedded RK output coefficient | $1$ |
| $e_{n+1}$ | embedded local error estimate | $1$ |

(numerical-methods-time-integration-explicit-runge-kutta-assumptions-and-validity)=
### Assumptions, FSAL reuse, GPU optimizations, and multistep checkpointing

- **First-Same-As-Last (FSAL) reuse (`rk23`, `rk45`, and FEM GPU `heun`/`rk4`/PBC)**: Both Bogacki–Shampine 3(2) and Dormand–Prince 5(4) satisfy $a_{S,\ell} = b_\ell$, enabling stage-derivative reuse across accepted steps. On FEM GPU (`gpu_rk_rhs_allows_fsal_reuse`), FSAL `k0` reuse also applies to fixed-step `heun` ($3 \to 2$ RHS/step) and `rk4` ($5 \to 4$ RHS/step), including periodic (PBC-reduced) Poisson airboxes, whenever operator signatures match and neither stochastic thermal fields, stage callbacks, nor incompatible constraints invalidate the cached endpoint derivative. Combined with the two-step linear demagnetizing potential predictor $\phi^{(0)}$ (with equal-stage-time guard `last_solved_stage_time_s`), FEM GPU reduces `cg_amg` Krylov iterations by 48.0% (`heun`) to 53.9% (`rk4`) while preserving $\max\|\Delta\mathbf{m}\|_\infty \le 2.85 \times 10^{-11}$. See {ref}`numerical-methods-performance-fem-gpu-demag`.
- **FEM GPU short-range RK kernel optimizations**: Intermediate RK stages omit energy reductions (`energy_out = nullptr`) in unified CSR DMI (`2.54×` faster than legacy `atomicAdd`), use non-compensated FMA Exchange CSR (`8.02×` faster than compensated double-double while relaxation preserves `Compensated=true`), fuse up to 28 short-range $H_{\mathrm{eff}}$ launches into a single kernel (`17.5×` faster), and use packed AoS$\leftrightarrow$SoA transfers (`13.93×` faster `state_io`), yielding `1.80×` end-to-end RK4 speedup at $\max_{\mathrm{rel}}(\mathbf{m}) = 4.53 \times 10^{-16}$. See {ref}`numerical-methods-performance-fem-gpu-kernels`.
- **FDM GPU fused FP64 RK45 spin torques**: On FDM CUDA FP64 (`launch_dp45_step_fp64`, `add_prescribed_spin_torques_fp64`), prescribed local spin-transfer and spin-orbit torques are fused directly into the CUDA field/RHS evaluation with zero separate torque kernel launches and bit-identical final magnetization. See {ref}`numerical-methods-performance-fdm-core` and {ref}`numerical-methods-performance-fdm-transport`.
- **Three-step Adams–Bashforth–Moulton (`abm3`)**: Supported on FDM CPU (`abm3_step_soa_state_buf`), FDM CUDA FP64/FP32 (`launch_abm3_step_fp64`), and FEM CPU reference, with exact multistep checkpointing in `FdmCpuSolverCheckpointV1` and resume via `resume_reference_fdm_from_abm3_checkpoint`. The native FEM GPU ABI rejects `abm3` fail-closed.
- **Stability limits (`LLG-TD-STIFF-V1`)**: Explicit Runge–Kutta schemes have bounded absolute stability regions along the imaginary and negative real axes; exchange stiffness scales as $\mathcal{O}(A_{\mathrm{ex}} / (M_s h_{\min}^2))$.

(numerical-methods-time-integration-explicit-runge-kutta-discrete-realization)=
(numerical-methods-time-integration-explicit-runge-kutta-implementation-mapping)=
### Discrete realization and backend support matrix

| Solver | Device | Status | Realization notes |
| --- | --- | --- | --- |
| FEM | CPU | `implemented` | Native MFEM explicit RK workspace (`stepper_workspace_allocate`), stage evaluator (`evaluate_rk_stage_rhs`), and step driver (`context_step_explicit_rk_mfem`); `abm3` available on Rust FEM reference path only. |
| FEM | GPU | `implemented` | Device-resident CUDA RK driver (`gpu_rk_device_resident_step`) and attempt loop (`gpu_rk_run_accepted_attempt_loop`) with FSAL `k0` reuse, $\phi^{(0)}$ predictor, fused short-range kernels, and `cuDSS` / `CG/AMG` demag (RTX 4080 SUPER A/B verified); `abm3` rejected fail-closed. |
| FDM | CPU | `implemented` | SoA explicit RK (`heun`, `rk4`, `rk23`, `rk45`), fixed-step `abm3` (`abm3_step_soa_state_buf`), and adaptive `coupled_imex_ark2` (with transient spin transport) in `crates/fullmag-engine/src/fdm/cpu/integrators.rs`. |
| FDM | GPU | `implemented` | CUDA FP64/FP32 explicit RK (`heun`, `rk4`, `rk23`, `rk45` with fused FP64 RK45 prescribed spin torques in `launch_dp45_step_fp64`) and `abm3` (`launch_abm3_step_fp64`); RTX 4080 SUPER A/B verified across 34 LLG cases (`rel dE <= 2.63e-14` in FP64). |

## Parameters

| Python surface | Type | Default | SI unit | Validation / constraints | Meaning | Backend support | `ProblemIR` path |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `LLG.gamma` | `float` | `2.211e5` | $\mathrm{m\,A^{-1}\,s^{-1}}$ | finite and $> 0$ | gyromagnetic ratio | FEM/FDM CPU/GPU | `study.dynamics.gyromagnetic_ratio` |
| `LLG.integrator` | `str` | `auto` | $1$ | `heun`, `rk4`, `rk23` (aliases `bs23`, `rk32`), `rk45` (alias `dp54`), `abm3`, `coupled_imex_ark2`, `auto` | temporal method request | lane-dependent | `study.dynamics.integrator` |
| `LLG.fixed_timestep` | `float \| None` | `None` | $\mathrm{s}$ | finite and $> 0$; mutually exclusive with `adaptive_timestep` (allowed with `heun`, `rk4`, `rk23`, `rk45`, `abm3`, `coupled_imex_ark2`) | requested fixed step | FEM/FDM CPU/GPU subject to lane support | `study.dynamics.fixed_timestep` |
| `AdaptiveTimestep.atol` | `float` | `1e-6` | $1$ | non-negative; not both tolerances zero | absolute error tolerance | `rk23`, `rk45`, `coupled_imex_ark2` lanes | `study.dynamics.adaptive_timestep.atol` |
| `AdaptiveTimestep.rtol` | `float` | `1e-3` | $1$ | non-negative; not both tolerances zero | relative error tolerance | `rk23`, `rk45`, `coupled_imex_ark2` lanes | `study.dynamics.adaptive_timestep.rtol` |
| `AdaptiveTimestep.dt_min` | `float` | `1e-15` | $\mathrm{s}$ | positive | lower step bound | `rk23`, `rk45`, `coupled_imex_ark2` lanes | `study.dynamics.adaptive_timestep.dt_min` |
| `AdaptiveTimestep.dt_max` | `float \| None` | `None` | $\mathrm{s}$ | positive and $\ge \Delta t_{\min}$ | upper step bound | `rk23`, `rk45`, `coupled_imex_ark2` lanes | `study.dynamics.adaptive_timestep.dt_max` |
| `StudyBuilder.solver(integrator=...)` | `str \| None` | `None` | $1$ | validated integrator name; aliases (`dp54`, `bs23`, `rk32`) normalize | stage-workflow solver method request | FEM/FDM lanes according to planner | `study.dynamics.integrator` |
| `StudyBuilder.solver(adaptive_timestep=...)` | `AdaptiveTimestep \| None` | `None` | $1$ | mutually exclusive with fixed/convenience controls (`fix_dt`/`dt`) | stage-workflow adaptive policy | `rk23`, `rk45`, `coupled_imex_ark2` lanes | `study.dynamics.adaptive_timestep` |

(numerical-methods-time-integration-explicit-runge-kutta-python-api)=
## Python API

```python
# %% Adaptive Dormand-Prince RK45 configuration on FDM
import fullmag as fm

nm = 1.0e-9
study = fm.study("explicit_rk45_ringdown")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(5 * nm, 5 * nm, 5 * nm))

strip = study.geometry(fm.Box(size=(80 * nm, 20 * nm, 5 * nm), name="strip"), name="strip")
strip.Ms = 8.0e5
strip.Aex = 1.3e-11
strip.alpha = 0.02
strip.m = fm.texture.uniform(1.0, 0.05, 0.0)

study.exchange()
study.demag()
study.B_ext = (15.0e-3, 0.0, 0.0)
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
study.stages.add_run(until=0.2e-9, stage_id="ringdown")
```

```python
# %% Fixed-step RK4 configuration on FDM
import fullmag as fm

nm = 1.0e-9
study = fm.study("explicit_rk4_fixed_pulse")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(5 * nm, 5 * nm, 5 * nm))

strip = study.geometry(fm.Box(size=(80 * nm, 20 * nm, 5 * nm), name="strip"), name="strip")
strip.Ms = 8.0e5
strip.Aex = 1.3e-11
strip.alpha = 0.02
strip.m = fm.texture.uniform(1.0, 0.05, 0.0)

study.exchange()
study.demag()
study.B_ext = (0.0, 5.0e-3, 0.0)
study.solver(integrator="rk4", gamma=2.211e5, fix_dt=1e-13)
study.stages.add_run(until=0.1e-9, stage_id="fixed_pulse")
```

(numerical-methods-time-integration-explicit-runge-kutta-problem-ir)=
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

- **Solver Inspector**: Selects `integrator` (`auto`, `rk45`, `rk23`, `rk4`, `heun`, `abm3`, `coupled_imex_ark2`) and switches between fixed-step (`fix_dt`/`fixed_timestep`) and adaptive (`AdaptiveTimestep`) controls.
- **Stage Execution Diagnostics**: Displays accepted steps, rejected step attempts, active $\Delta t$, total stage RHS evaluations, and FSAL reuse counters.

(numerical-methods-time-integration-explicit-runge-kutta-round-trip-and-failure-semantics)=
## Diagnostics and failure semantics

- **Requested intent and resolved execution**: `ProblemIR` preserves the user's `requested intent` (`integrator="auto"` or explicit scheme; canonicalized from `dp54`/`bs23`/`rk32`), while the planner and execution receipt record the concrete `resolved execution` method and device lane.
- **Validation errors**: Combining `fixed_timestep` and `adaptive_timestep` simultaneously, or attaching `adaptive_timestep` to fixed-only integrators (`heun`, `rk4`, `abm3`), raises immediate `ValueError` validation errors in Python and planner rejection in Rust. Fixed-step execution with `rk23`/`rk45` is valid when `adaptive_timestep` is unset.
- **Unsupported combinations**: Requesting `abm3` on native FEM GPU or `coupled_imex_ark2` without a transient spin-transport module is rejected fail-closed before solver startup.
- **Atomic stage failure (`LLG-TD-ATOMIC-V1`)**: Non-finite stage fields or RHS evaluations immediately abort the attempted step and restore the pre-attempt magnetization and effective-field snapshot (`rk_step_transaction.hpp`).

(numerical-methods-time-integration-explicit-runge-kutta-validation)=
## Validation

- **FEM GPU RTX 4080 SUPER A/B contracts**: `fem_cuda_rk_heun_rk4_fsal_predictor_contract`, `fem_rk_explicit_contract`, and `fem_cuda_shortrange_kernels_contract` verify FSAL `k0` reuse (`heun` $3\to 2$ and `rk4` $5\to 4$ RHS/step), 2-step $\phi^{(0)}$ prediction, fused short-range kernels (`1.80×` E2E RK4 speedup), and trajectory parity ($\max\|\Delta\mathbf{m}\|_\infty \le 2.85 \times 10^{-11}$ on Poisson/PBC airboxes and $4.53 \times 10^{-16}$ on short-range RK4).
- **FDM CPU/GPU parity & multistep contracts**: 34 RTX 4080 SUPER LLG A/B cases verify FP64 D2Z/Z2D cuFFT parity ($\mathrm{rel}\,\Delta E_{\mathrm{total}} \le 2.63 \times 10^{-14}$), 5 STT/SHE/M1 CUDA pairs verify bit-identical `m_final` under fused FP64 RK45 spin torques, and `fdm_abm3_cpu` + CUDA `llg_abm3_fp64` verify `abm3` multistep accuracy and checkpoint resume. See {doc}`../../validation/cpu-gpu-parity`.

(numerical-methods-time-integration-explicit-runge-kutta-limitations)=
## Limitations

- Explicit RK and `abm3` schemes are conditionally stable under stiff exchange ($\Delta t \propto h_{\min}^2$); ultra-fine meshes require small time steps or direct minimization for equilibrium studies.
- `abm3` is not supported on native FEM GPU and is rejected with thermal noise (`H_therm`) on FDM.
- `coupled_imex_ark2` applies exclusively to coupled transient spin-transport studies and is rejected for standalone LLG stages.

(numerical-methods-time-integration-explicit-runge-kutta-scientific-bibliography)=
### Scientific bibliography

1. J. R. Dormand and P. J. Prince, *A family of embedded Runge–Kutta formulae*, J. Comput. Appl. Math. **6**, 19–26 (1980), DOI: [10.1016/0771-050X(80)90013-3](https://doi.org/10.1016/0771-050X(80)90013-3).
2. P. Bogacki and L. F. Shampine, *A 3(2) pair of Runge–Kutta formulas*, Appl. Math. Lett. **2**, 321–325 (1989), DOI: [10.1016/0893-9659(89)90079-7](https://doi.org/10.1016/0893-9659(89)90079-7).
3. E. Hairer, S. P. Nørsett, and G. Wanner, *Solving Ordinary Differential Equations I: Nonstiff Problems*, 2nd ed., Springer (1993), DOI: [10.1007/978-3-540-78862-1](https://doi.org/10.1007/978-3-540-78862-1).

(numerical-methods-time-integration-explicit-runge-kutta-source-code-index)=
## Where this is implemented

| Layer | File | Symbol | Responsibility |
| --- | --- | --- | --- |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L159) | [`class LLG`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L159) | Public LLG integrator contract, aliases (`dp54`, `bs23`, `rk32`), and `ProblemIR` serialization |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L45) | [`class AdaptiveTimestep`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L45) | Adaptive tolerance and step-bound validation |
| Python DSL | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6439) | [`class StudyBuilder`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6439) | Canonical stage-workflow solver-policy facade |
| Native FEM CPU | [`backends/fem/cpu/mfem/integrators/rk_stage_rhs.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/integrators/rk_stage_rhs.cpp#L24) | [`evaluate_rk_stage_rhs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/integrators/rk_stage_rhs.cpp#L24) | FEM stage right-hand-side evaluation |
| Native FEM CPU | [`backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp#L126) | [`context_step_explicit_rk_mfem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp#L126) | FEM explicit RK step execution |
| Native FEM CPU | [`backends/fem/cpu/mfem/integrators/rk_explicit.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/integrators/rk_explicit.cpp#L161) | [`stepper_workspace_allocate`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/integrators/rk_explicit.cpp#L161) | FEM reusable explicit-RK workspace implementation |
| Native FEM GPU | [`backends/fem/gpu/cuda/integrators/rk/rk_step.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/rk_step.cu#L24) | [`gpu_rk_device_resident_step`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/rk_step.cu#L24) | Device-resident GPU RK step orchestration (FSAL + $\phi^{(0)}$ predictor) |
| Native FEM GPU | [`backends/fem/gpu/cuda/integrators/rk/rk_attempt_loop.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/rk_attempt_loop.cu#L103) | [`gpu_rk_run_accepted_attempt_loop`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/rk_attempt_loop.cu#L103) | GPU RK accepted-attempt loop and atomic rollback |
| Native FEM GPU | [`backends/fem/gpu/cuda/integrators/rk/rk_fsal_policy.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/rk_fsal_policy.cpp#L98) | [`gpu_rk_rhs_allows_fsal_reuse`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/rk_fsal_policy.cpp#L98) | Host-side FSAL eligibility and operator-signature policy |
| Native FDM GPU | [`backends/fdm/gpu/cuda/integrators/llg_dp45_fp64.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/integrators/llg_dp45_fp64.cu#L773) | [`launch_dp45_step_fp64`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/integrators/llg_dp45_fp64.cu#L773) | CUDA FP64 RK45 step driver with fused prescribed spin torques |
| Native FDM GPU | [`backends/fdm/gpu/cuda/integrators/prescribed_spin_torques_fp64.cuh`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/integrators/prescribed_spin_torques_fp64.cuh#L7) | [`add_prescribed_spin_torques_fp64`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/integrators/prescribed_spin_torques_fp64.cuh#L7) | Fused local STT/SOT torque evaluation inside CUDA FP64 RK45 RHS |
| Native FDM GPU | [`backends/fdm/gpu/cuda/integrators/llg_abm3_fp64.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/integrators/llg_abm3_fp64.cu#L240) | [`launch_abm3_step_fp64`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/integrators/llg_abm3_fp64.cu#L240) | CUDA FP64 Adams–Bashforth–Moulton 3rd-order step driver |
| FDM Engine | [`crates/fullmag-engine/src/fdm/cpu/integrators.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/integrators.rs#L4322) | [`abm3_step_soa_state_buf`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/integrators.rs#L4322) | FDM CPU SoA `abm3` predictor–corrector step |
| FDM Engine | [`crates/fullmag-engine/src/fdm/cpu/state.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/state.rs#L29) | [`FdmCpuSolverCheckpointV1`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/state.rs#L29) | FDM CPU multistep (`abm3`) checkpoint state representation |
| FDM Runner | [`crates/fullmag-runner/src/lib.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/lib.rs#L7288) | [`resume_reference_fdm_from_abm3_checkpoint`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/lib.rs#L7288) | Resumes FDM CPU `abm3` execution from a saved multistep checkpoint |
