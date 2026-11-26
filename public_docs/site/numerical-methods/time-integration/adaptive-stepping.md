---
title: Adaptive Stepping
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
source_of_truth: "AdaptiveTimestep and LLG validation, ProblemIR lowering, and lane-specific error reductions"
---

(public-docs-numerical-methods-time-integration-adaptive-stepping)=
# Adaptive Time-Stepping and History PI Controller

(numerical-methods-time-integration-adaptive-stepping-problem-statement)=
## Scope and purpose

This chapter specifies the canonical adaptive time-stepping contract (`LLG-TD-POLICY-V1` through `LLG-TD-ATOMIC-V1`) used by FullMag's embedded Runge–Kutta integrators (`rk23` with aliases `bs23`/`rk32`, and `rk45` with alias `dp54`) and notes how `coupled_imex_ark2` performs adaptive step-halving for coupled transient spin-transport. It defines the active-node maximum mixed error norm, the order-aware proportional–integral (PI) step-size controller with previous-accepted-error memory, optional spin-rotation and norm-drift guards, first-step selection, stiffness diagnostics, and atomic rollback on step rejection across FEM and FDM CPU/GPU realizations.

(numerical-methods-time-integration-adaptive-stepping-governing-equations)=
## Scientific and numerical model

For an embedded Runge–Kutta pair of error order $p$ ($p=2$ for Bogacki–Shampine `rk23`, $p=4$ for Dormand–Prince `rk45`), let $\mathbf{m}_i^{\mathrm{old}}$ denote the accepted state at the beginning of attempted step $k$, $\mathbf{m}_i^{\mathrm{high}}$ the high-order candidate state before final renormalization, and $e_i = \Delta t_k \sum_{s=1}^{S}(b_s^{\mathrm{hi}} - b_s^{\mathrm{lo}})\mathbf{k}_{s,i}$ the local embedded 3-vector error at active magnetic cell or node $i \in \mathcal{A}$ ($M_{s,i} > 0$).

Each active degree of freedom is scaled by the mixed absolute/relative tolerance (`LLG-TD-MAX-ERR-V1`):

```{math}
:label: eq-adaptive-normalized-error
\eta_i
=
\frac{\|e_i\|_2}{a_{\mathrm{tol}} + r_{\mathrm{tol}}\,\max\!\left(\|\mathbf{m}_i^{\mathrm{old}}\|_2,\;\|\mathbf{m}_i^{\mathrm{high}}\|_2\right)},
\qquad
i \in \mathcal{A}.
```

The global normalized error ratio for the attempted step is the active-set maximum norm (enforced consistently on both CPU and GPU lanes):

```{math}
:label: eq-adaptive-global-error
\eta = \max_{i \in \mathcal{A}} \eta_i.
```

An attempted step is accepted only when $\eta \le 1$, all stage states are finite, and any configured geometric guards (`max_spin_rotation` and `norm_tolerance`) are satisfied. Given the error-estimator order $p$ (so the local truncation error scales as $\mathcal{O}(\Delta t^q)$ with $q = p + 1$), safety factor $s \in (0, 1]$, current error ratio $\eta_k = \eta$, and previous accepted non-zero error ratio $\eta_{k-1}$, the backend-neutral decision policy (`decide_adaptive_step` in `native/include/fullmag_adaptive_step_decision.hpp`) proposes the next step size via the order-aware history PI controller (`LLG-TD-POLICY-V1`):

```{math}
:label: eq-adaptive-controller
\Delta t_{\mathrm{new}}
=
\mathrm{clip}\!\left(\Delta t\,\mathrm{clip}\!\left(q_{\mathrm{raw}},\,\rho_{\mathrm{shrink}},\,\rho_{\mathrm{growth}}\right),\;\Delta t_{\min},\;\Delta t_{\max}\right),
\qquad
q_{\mathrm{raw}}
=
\begin{cases}
\rho_{\mathrm{growth}}, & \eta_k = 0, \\[4pt]
s\,\eta_k^{-1/q}, & \text{rejected attempt or no prior accepted }\eta_{k-1} > 0, \\[4pt]
s\,\eta_k^{-0.7/q}\,\eta_{k-1}^{0.4/q}, & \text{accepted step with prior accepted }\eta_{k-1} > 0.
\end{cases}
```

For `coupled_imex_ark2` (only when a transient spin-transport module is active), adaptive error estimation compares one full coupled step against two half steps rather than an embedded RK tableau, while obeying the same `AdaptiveTimestep` bounds and atomic rollback rules.

(numerical-methods-time-integration-adaptive-stepping-symbols-and-si-units)=
### Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $e_i$ | embedded error vector at active point $i$ | $1$ |
| $a_{\mathrm{tol}}$ | absolute tolerance | $1$ |
| $r_{\mathrm{tol}}$ | relative tolerance | $1$ |
| $\eta_i$ | local normalized error | $1$ |
| $\eta$ | global normalized error metric | $1$ |
| $m_i$ | reduced magnetization at active point $i$ | $1$ |
| $\Delta t$ | current time step | $\mathrm{s}$ |
| $s$ | controller safety factor | $1$ |
| $q$ | error-estimator order | $1$ |
| $\rho_{\mathrm{shrink}}$ | lower step-ratio limit | $1$ |
| $\rho_{\mathrm{growth}}$ | upper step-ratio limit | $1$ |

(numerical-methods-time-integration-adaptive-stepping-assumptions-and-validity)=
### Canonical adaptive solver invariants

- **First-step selection (`LLG-TD-FIRST-DT-V1`)**: When `dt_initial` is explicitly supplied, it must lie within $[\Delta t_{\min}, \Delta t_{\max}]$ and seeds attempt $k=0$ directly; otherwise the runtime derives a conservative initial step from the initial torque scale $\|\mathbf{f}(\mathbf{m}_0, t_0)\|_{\infty}$ clamped to $[\Delta t_{\min}, \Delta t_{\max}]$.
- **Geometric and norm guards (`LLG-TD-MAX-ERR-V1`)**: When `max_spin_rotation` ($\theta_{\max}$, in radians) or `norm_tolerance` ($\varepsilon_{\mathrm{norm}}$) is set, the step is rejected if $\max_{i\in\mathcal{A}} \arccos(\mathbf{m}_i^{\mathrm{old}}\cdot\mathbf{m}_i^{\mathrm{new}}) > \theta_{\max}$ or $\max_{i\in\mathcal{A}} |\|\mathbf{m}_i^{\mathrm{high}}\|_2 - 1| > \varepsilon_{\mathrm{norm}}$, even if $\eta \le 1$.
- **Atomic step rollback (`LLG-TD-ATOMIC-V1`)**: A rejected attempt restores the magnetization state, effective-field buffers, FSAL derivative cache, and simulation clock to their exact pre-attempt values before retrying with $\Delta t_{\mathrm{new}}$. On FEM GPU, retry fast-path guards ensure rejected attempts invalidate any stale FSAL or predictor state cleanly.
- **Underflow and stiffness diagnostics (`LLG-TD-ATTEMPT-V1`, `LLG-TD-STIFF-V1`)**: If $\eta > 1$ at $\Delta t = \Delta t_{\min}$, the solver fails closed with a typed `dt_min` underflow diagnostic rather than accepting an inaccurate step. Persistent step rejections near the exchange stability ceiling are tracked in step statistics.
- **GPU execution performance**: On FDM CUDA FP64, adaptive `rk45` fuses local STT/SOT torques directly into the RHS kernel (`launch_dp45_step_fp64`); on FEM CUDA, adaptive `rk23`/`rk45` combine device block reductions (`adaptive_error_norm_blocks_kernel`) with `cuDSS` direct demag or $\phi^{(0)}$-predicted `CG/AMG` and fused short-range kernels. See {ref}`numerical-methods-performance-fdm-core`, {ref}`numerical-methods-performance-fem-gpu-demag`, and {ref}`numerical-methods-performance-fem-gpu-kernels`.

(numerical-methods-time-integration-adaptive-stepping-discrete-realization)=
(numerical-methods-time-integration-adaptive-stepping-implementation-mapping)=
### Discrete realization and backend support matrix

| Solver | Device | Status | Realization notes |
| --- | --- | --- | --- |
| FEM | CPU | `implemented` | Active-node maximum mixed error reduction (`compute_adaptive_error_norm`) and history PI step (`adaptive_pi_step`) in `backends/fem/cpu/mfem/integrators/adaptive_dt.cpp`. |
| FEM | GPU | `implemented` | Device block reduction (`adaptive_error_norm_blocks_kernel`), device PI controller (`gpu_rk_adaptive_pi_step`), and guarded retry/rollback loop (`gpu_rk_run_accepted_attempt_loop`). |
| FDM | CPU | `implemented` | Active-cell error reduction (`max_error_norm_buf`) and history PI controller (`decide_adaptive_step`) in `crates/fullmag-engine/src/fdm/cpu/integrators.rs`. |
| FDM | GPU | `implemented` | Device-side reductions (`reduce_adaptive_error_policy`, `reduce_max_scalar_sqrt`) and fused FP64 RK45 step driver (`launch_dp45_step_fp64`); RTX 4080 SUPER A/B verified. |

## Parameters

| Python surface | Type | Default | SI unit | Validation / constraints | Meaning | Backend support | `ProblemIR` path |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `AdaptiveTimestep.atol` | `float` | `1e-6` | $1$ | non-negative; not both tolerances zero | absolute error component | `rk23`, `rk45`, `coupled_imex_ark2` lanes | `adaptive_timestep.atol` |
| `AdaptiveTimestep.rtol` | `float` | `1e-3` | $1$ | non-negative; not both tolerances zero | relative error component | `rk23`, `rk45`, `coupled_imex_ark2` lanes | `adaptive_timestep.rtol` |
| `AdaptiveTimestep.dt_initial` | `float \| None` | `None` | $\mathrm{s}$ | positive and within bounds when set | first proposed step | lane-dependent | `adaptive_timestep.dt_initial` |
| `AdaptiveTimestep.dt_min` | `float` | `1e-15` | $\mathrm{s}$ | positive | minimum allowed step | `rk23`, `rk45`, `coupled_imex_ark2` lanes | `adaptive_timestep.dt_min` |
| `AdaptiveTimestep.dt_max` | `float \| None` | `None` | $\mathrm{s}$ | positive and $\ge \Delta t_{\min}$ | maximum allowed step | `rk23`, `rk45`, `coupled_imex_ark2` lanes | `adaptive_timestep.dt_max` |
| `AdaptiveTimestep.safety` | `float` | `0.9` | $1$ | safety factor in $(0, 1]$ | conservative controller factor | `rk23`, `rk45`, `coupled_imex_ark2` lanes | `adaptive_timestep.safety` |
| `AdaptiveTimestep.growth_limit` | `float` | `2.0` | $1$ | `growth_limit` $> 1$ | maximum step growth ratio | `rk23`, `rk45`, `coupled_imex_ark2` lanes | `adaptive_timestep.growth_limit` |
| `AdaptiveTimestep.shrink_limit` | `float` | `0.2` | $1$ | `shrink_limit` in $(0, 1)$ | minimum step ratio | `rk23`, `rk45`, `coupled_imex_ark2` lanes | `adaptive_timestep.shrink_limit` |
| `AdaptiveTimestep.max_spin_rotation` | `float \| None` | `None` | $\mathrm{rad}$ | positive when set | per-step maximum spin-angle rotation guard | `rk23`, `rk45`, `coupled_imex_ark2` lanes | `adaptive_timestep.max_spin_rotation` |
| `AdaptiveTimestep.norm_tolerance` | `float \| None` | `None` | $1$ | positive when set | pre-normalization unit-length drift guard | `rk23`, `rk45`, `coupled_imex_ark2` lanes | `adaptive_timestep.norm_tolerance` |

(numerical-methods-time-integration-adaptive-stepping-python-api)=
## Python API

```python
# %% Adaptive RK45 with explicit PI tolerances and geometric guards
import fullmag as fm

nm = 1.0e-9
study = fm.study("adaptive_pi_stepping")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(5 * nm, 5 * nm, 5 * nm))

strip = study.geometry(fm.Box(size=(80 * nm, 20 * nm, 5 * nm), name="strip"), name="strip")
strip.Ms = 8.0e5
strip.Aex = 1.3e-11
strip.alpha = 0.02
strip.m = fm.texture.uniform(1.0, 0.1, 0.0)

study.exchange()
study.demag()
study.B_ext = (0.0, 8.0e-3, 0.0)
study.solver(
    integrator="rk45",
    adaptive_timestep=fm.AdaptiveTimestep(
        atol=1e-6,
        rtol=1e-4,
        dt_initial=1e-13,
        dt_min=1e-15,
        dt_max=2e-12,
        safety=0.9,
        growth_limit=2.0,
        shrink_limit=0.2,
        max_spin_rotation=0.35,
        norm_tolerance=1e-3,
    ),
)
study.stages.add_run(until=0.2e-9, stage_id="adaptive_pulse")
```

(numerical-methods-time-integration-adaptive-stepping-problem-ir)=
### `ProblemIR` excerpt

```json
{
  "adaptive_timestep": {
    "atol": 1e-06,
    "rtol": 0.0001,
    "dt_initial": 1e-13,
    "dt_min": 1e-15,
    "dt_max": 2e-12,
    "safety": 0.9,
    "growth_limit": 2.0,
    "shrink_limit": 0.2,
    "max_spin_rotation": 0.35,
    "norm_tolerance": 0.001
  }
}
```

## Control Room workflow

- **Solver Inspector**: Exposes `atol`, `rtol`, `dt_initial`, `dt_min`, `dt_max`, `safety`, `growth_limit`, `shrink_limit`, `max_spin_rotation`, and `norm_tolerance` whenever an adaptive-capable integrator (`auto`, `rk45`, `rk23`, or coupled `coupled_imex_ark2`) is selected.
- **Diagnostics Panel**: Displays real-time $\Delta t_k$, normalized error $\eta_k$, accepted/rejected step counts, and stiffness indicators.

(numerical-methods-time-integration-adaptive-stepping-round-trip-and-failure-semantics)=
## Diagnostics and failure semantics

- **Requested intent and resolved execution**: `ProblemIR` records the full `AdaptiveTimestep` policy (`requested intent`), while runtime receipts record the resolved integrator, accepted/rejected attempt counts, and terminal $\Delta t$ (`resolved execution`).
- **Validation errors**: Setting both `atol == 0` and `rtol == 0`, inverted step bounds (`dt_max < dt_min` or `dt_initial` outside `[dt_min, dt_max]`), `safety` outside `(0, 1]`, `growth_limit <= 1`, or `shrink_limit` outside `(0, 1)` raises immediate `ValueError` validation errors.
- **Unsupported combinations**: Attaching `AdaptiveTimestep` to fixed-only integrators (`heun`, `rk4`, `abm3`) is rejected at both Python construction and Rust planning boundaries.

(numerical-methods-time-integration-adaptive-stepping-validation)=
## Validation

- **Shared decision contract**: `decide_adaptive_step` (C++ header and Rust mirror) is verified across zero-error growth, rejected shrink, history PI exponent selection, and `dt_min` underflow fail-closed contracts.
- **Cross-lane parity**: FEM CPU enforces the same active-node maximum mixed error norm as FEM GPU and FDM CPU/GPU; FDM CUDA adaptive `rk45` with fused STT/SOT torques matches CPU/reference baselines bit-identically across 5 RTX 4080 SUPER A/B transport cases. See {doc}`../../validation/cpu-gpu-parity`.

(numerical-methods-time-integration-adaptive-stepping-limitations)=
## Limitations

- Adaptive error control bounds local single-step truncation error; it does not eliminate global phase drift over long trajectories or replace independent equilibrium convergence checks in relaxation stages.
- Stochastic thermal noise (`H_therm`) is incompatible with adaptive stepping on FDM and fails closed at planning time.

(numerical-methods-time-integration-adaptive-stepping-scientific-bibliography)=
### Scientific bibliography

1. G. Söderlind, *Automatic control and adaptive time-stepping*, Numer. Algorithms **31**, 281–310 (2002), DOI: [10.1023/A:1021160023092](https://doi.org/10.1023/A:1021160023092).
2. E. Hairer, S. P. Nørsett, and G. Wanner, *Solving Ordinary Differential Equations I: Nonstiff Problems*, 2nd ed., Springer (1993), DOI: [10.1007/978-3-540-78862-1](https://doi.org/10.1007/978-3-540-78862-1).

(numerical-methods-time-integration-adaptive-stepping-source-code-index)=
## Where this is implemented

| Layer | File | Symbol | Responsibility |
| --- | --- | --- | --- |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L45) | [`class AdaptiveTimestep`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L45) | Public adaptive controller validation and IR |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L159) | [`class LLG`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L159) | Compatibility of integrator (`rk23`/`rk45`/`coupled_imex_ark2`, aliases) and adaptive policy |
| Shared Native Header | [`native/include/fullmag_adaptive_step_decision.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/native/include/fullmag_adaptive_step_decision.hpp#L127) | [`decide_adaptive_step`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/native/include/fullmag_adaptive_step_decision.hpp#L127) | Backend-neutral history-aware scalar accept/retry/dt-min policy |
| Native FEM CPU | [`backends/fem/cpu/mfem/integrators/adaptive_dt.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/integrators/adaptive_dt.cpp#L123) | [`compute_adaptive_error_norm`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/integrators/adaptive_dt.cpp#L123) | Native FEM active-node maximum mixed error norm and fail-closed guards |
| Native FEM CPU | [`backends/fem/cpu/mfem/integrators/adaptive_dt.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/integrators/adaptive_dt.cpp#L379) | [`adaptive_pi_step`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/integrators/adaptive_dt.cpp#L379) | Native FEM history-aware scalar controller and rejection accounting |
| Native FEM GPU | [`backends/fem/gpu/cuda/integrators/rk/adaptive_error_kernels.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/adaptive_error_kernels.cu#L17) | [`adaptive_error_norm_blocks_kernel`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/adaptive_error_kernels.cu#L17) | Native FEM GPU device reduction of the nodewise error norm |
| Native FEM GPU | [`backends/fem/gpu/cuda/integrators/rk/rk_adaptive_runtime.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/rk_adaptive_runtime.cu#L23) | [`gpu_rk_adaptive_pi_step`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/rk_adaptive_runtime.cu#L23) | Native FEM GPU device-lane PI decision and history tracking |
| FDM CPU Engine | [`crates/fullmag-engine/src/fdm/cpu/integrators.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/integrators.rs#L22) | [`decide_adaptive_step`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/integrators.rs#L22) | FDM CPU history-aware bounded proposal and dt-min decision |
| FDM GPU CUDA | [`backends/fdm/gpu/cuda/runtime/reductions_fp64.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/runtime/reductions_fp64.cu#L967) | [`reduce_adaptive_error_policy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/runtime/reductions_fp64.cu#L967) | FDM GPU device-side adaptive error policy |
| FDM GPU CUDA | [`backends/fdm/gpu/cuda/runtime/reductions_fp64.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/runtime/reductions_fp64.cu#L922) | [`reduce_max_scalar_sqrt`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/runtime/reductions_fp64.cu#L922) | FDM GPU scalar reduction implementation |
