---
title: Adaptive Stepping
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: a1de38b4d7dad275dccbdbfd937b757d6ca7ee99
source_of_truth: "AdaptiveTimestep and LLG validation, ProblemIR lowering, and lane-specific error reductions"
---

(public-docs-numerical-methods-time-integration-adaptive-stepping)=
# Adaptive Time-Stepping and History PI Controller

(numerical-methods-time-integration-adaptive-stepping-problem-statement)=
<!-- (problem-statement)= -->
## Scope and purpose

This chapter specifies the canonical adaptive time-stepping contract (`0960`: `LLG-TD-POLICY-V1` through `LLG-TD-ATOMIC-V1`) used by Fullmag's embedded Runge–Kutta integrators (`rk23` and `rk45`). It defines the active-node mixed error norm, the order-aware proportional–integral (PI) step-size controller with memory of the previous accepted error ratio, optional spin-rotation and norm-drift guards, first-step selection, stiffness diagnostics, and atomic rollback on step rejection across FEM and FDM CPU/GPU realizations.

(numerical-methods-time-integration-adaptive-stepping-governing-equations)=
<!-- (governing-equations)= -->
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

The global normalized error ratio for the attempted step is the active-set maximum norm:

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

(numerical-methods-time-integration-adaptive-stepping-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
### Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $e_i$ | embedded error vector at active point i | $1$ |
| $a_{\mathrm{tol}}$ | absolute tolerance | $1$ |
| $r_{\mathrm{tol}}$ | relative tolerance | $1$ |
| $\eta_i$ | local normalized error | $1$ |
| $\eta$ | global normalized error metric | $1$ |
| $m_i$ | reduced magnetization at active point i | $1$ |
| $\Delta t$ | current time step | $\mathrm{s}$ |
| $s$ | controller safety factor | $1$ |
| $q$ | error-estimator order | $1$ |
| $\rho_{\mathrm{shrink}}$ | lower step-ratio limit | $1$ |
| $\rho_{\mathrm{growth}}$ | upper step-ratio limit | $1$ |

(numerical-methods-time-integration-adaptive-stepping-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
### Canonical adaptive solver invariants (`0960`)

- **First-step selection (`LLG-TD-FIRST-DT-V1`)**: When `dt_initial` is explicitly supplied, it must lie within $[\Delta t_{\min}, \Delta t_{\max}]$ and seeds attempt $k=0$ directly; otherwise the runtime derives a conservative initial step from the initial torque scale $\|\mathbf{f}(\mathbf{m}_0, t_0)\|_{\infty}$ clamped to $[\Delta t_{\min}, \Delta t_{\max}]$.
- **Geometric and norm guards (`LLG-TD-MAX-ERR-V1`)**: When `max_spin_rotation` ($\theta_{\max}$, in radians) or `norm_tolerance` ($\varepsilon_{\mathrm{norm}}$) is set, the step is rejected if $\max_{i\in\mathcal{A}} \arccos(\mathbf{m}_i^{\mathrm{old}}\cdot\mathbf{m}_i^{\mathrm{new}}) > \theta_{\max}$ or $\max_{i\in\mathcal{A}} |\|\mathbf{m}_i^{\mathrm{high}}\|_2 - 1| > \varepsilon_{\mathrm{norm}}$, even if $\eta \le 1$.
- **Atomic step rollback (`LLG-TD-ATOMIC-V1`)**: A rejected attempt restores the magnetization state, effective-field buffers, FSAL derivative cache, and simulation clock to their exact pre-attempt values before retrying with $\Delta t_{\mathrm{new}}$.
- **Underflow and stiffness diagnostics (`LLG-TD-ATTEMPT-V1`, `LLG-TD-STIFF-V1`)**: If $\eta > 1$ at $\Delta t = \Delta t_{\min}$, the solver fails closed with a typed `dt_min` underflow diagnostic rather than accepting an inaccurate step. Persistent step rejections near the exchange stability ceiling are tracked in step statistics.

(numerical-methods-time-integration-adaptive-stepping-discrete-realization)=
<!-- (discrete-realization)= -->
(numerical-methods-time-integration-adaptive-stepping-implementation-mapping)=
<!-- (implementation-mapping)= -->
### Discrete realization and backend support matrix

| Solver | Device | Status | Realization notes |
| --- | --- | --- | --- |
| FEM | CPU | `documented` | Nodewise mixed error reduction (`compute_adaptive_error_norm`) and history PI step (`adaptive_pi_step`) in `backends/fem/cpu/mfem/integrators/adaptive_dt.cpp`. |
| FEM | GPU | `source-backed` | Device block reduction (`adaptive_error_norm_blocks_kernel`) and host/device attempt loop (`gpu_rk_run_accepted_attempt_loop`); FEM device-lane parity requires executed managed evidence. |
| FDM | CPU | `documented` | Active-cell error reduction (`max_error_norm_buf`) and history PI controller (`decide_adaptive_step`) in `crates/fullmag-engine/src/fdm/cpu/integrators.rs`. |
| FDM | GPU | `source-backed` | Device-side reductions (`reduce_adaptive_error_policy`, `reduce_max_scalar_sqrt`) are contract-tested, but runtime qualification is separate. |

## Parameters

| Python surface | Type | Default | SI unit | Validation / constraints | Meaning | Backend support | `ProblemIR` path |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `AdaptiveTimestep.atol` | `float` | `1e-6` | $1$ | non-negative; not both tolerances zero | absolute error component | RK23/RK45 lanes | `adaptive_timestep.atol` |
| `AdaptiveTimestep.rtol` | `float` | `1e-3` | $1$ | non-negative; not both tolerances zero | relative error component | RK23/RK45 lanes | `adaptive_timestep.rtol` |
| `AdaptiveTimestep.dt_initial` | `float \| None` | `None` | $\mathrm{s}$ | positive and within bounds when set | first proposed step | lane-dependent | `adaptive_timestep.dt_initial` |
| `AdaptiveTimestep.dt_min` | `float` | `1e-15` | $\mathrm{s}$ | positive | minimum allowed step | RK23/RK45 lanes | `adaptive_timestep.dt_min` |
| `AdaptiveTimestep.dt_max` | `float \| None` | `None` | $\mathrm{s}$ | positive and $\ge \Delta t_{\min}$ | maximum allowed step | RK23/RK45 lanes | `adaptive_timestep.dt_max` |
| `AdaptiveTimestep.safety` | `float` | `0.9` | $1$ | safety factor in $(0, 1]$ | conservative controller factor | RK23/RK45 lanes | `adaptive_timestep.safety` |
| `AdaptiveTimestep.growth_limit` | `float` | `2.0` | $1$ | `growth_limit` $> 1$ | maximum step growth ratio | RK23/RK45 lanes | `adaptive_timestep.growth_limit` |
| `AdaptiveTimestep.shrink_limit` | `float` | `0.2` | $1$ | `shrink_limit` in $(0, 1)$ | minimum step ratio | RK23/RK45 lanes | `adaptive_timestep.shrink_limit` |
| `AdaptiveTimestep.max_spin_rotation` | `float \| None` | `None` | $\mathrm{rad}$ | positive when set | per-step maximum spin-angle rotation guard | RK23/RK45 lanes | `adaptive_timestep.max_spin_rotation` |
| `AdaptiveTimestep.norm_tolerance` | `float \| None` | `None` | $1$ | positive when set | pre-normalization unit-length drift guard | RK23/RK45 lanes | `adaptive_timestep.norm_tolerance` |

(numerical-methods-time-integration-adaptive-stepping-python-api)=
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
    m_init=fm.VectorFieldSpec.uniform((1.0, 0.1, 0.0)),
    demag=True,
)

study = fm.study(world, target="fdm", device="cpu", precision="fp64")
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
study.stages.add_time(name="adaptive_pulse", duration=0.2e-9, By=8e-3, save_m_every=50e-12)
```

(numerical-methods-time-integration-adaptive-stepping-problem-ir)=
<!-- (problem-ir)= -->
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

- **Solver Inspector**: Exposes `atol`, `rtol`, `dt_initial`, `dt_min`, `dt_max`, `safety`, `growth_limit`, `shrink_limit`, `max_spin_rotation`, and `norm_tolerance` whenever an adaptive integrator (`auto`, `rk45`, `rk23`) is selected.
- **Diagnostics Panel**: Displays real-time $\Delta t_k$, normalized error $\eta_k$, accepted/rejected step counts, and stiffness indicators.

(numerical-methods-time-integration-adaptive-stepping-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
(numerical-methods-time-integration-adaptive-stepping-validation)=
<!-- (validation)= -->
(numerical-methods-time-integration-adaptive-stepping-limitations)=
<!-- (limitations)= -->
## Diagnostics and failure semantics

- **Requested intent and resolved execution**: `ProblemIR` records the full `AdaptiveTimestep` policy (`requested intent`), while runtime receipts record the resolved integrator, accepted/rejected attempt counts, and terminal $\Delta t$ (`resolved execution`).
- **Validation errors**: Setting both `atol == 0` and `rtol == 0`, inverted step bounds (`dt_max < dt_min` or `dt_initial` outside `[dt_min, dt_max]`), `safety` outside `(0, 1]`, `growth_limit <= 1`, or `shrink_limit` outside `(0, 1)` raises immediate `ValueError` validation errors.
- **Unsupported combinations**: Attaching `AdaptiveTimestep` to fixed-step integrators (`heun`, `rk4`, `abm3`, `coupled_imex_ark2`) is rejected as an unsupported combination at both Python construction and Rust planning boundaries.

(numerical-methods-time-integration-adaptive-stepping-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
### Scientific bibliography

1. G. Söderlind, *Automatic control and adaptive time-stepping*, Numer. Algorithms **31**, 281–310 (2002).
2. E. Hairer, S. P. Nørsett, and G. Wanner, *Solving Ordinary Differential Equations I: Nonstiff Problems*, 2nd ed., Springer (1993).

(numerical-methods-time-integration-adaptive-stepping-source-code-index)=
<!-- (source-code-index)= -->
## Where this is implemented

| Layer | File | Symbol | Responsibility |
| --- | --- | --- | --- |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/dynamics.py#L30) | [`class AdaptiveTimestep`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/dynamics.py#L30) | Public adaptive controller validation and IR |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/dynamics.py#L158) | [`class LLG`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/dynamics.py#L158) | Compatibility of integrator and adaptive policy |
| Shared Native Header | [`native/include/fullmag_adaptive_step_decision.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/native/include/fullmag_adaptive_step_decision.hpp#L127) | [`decide_adaptive_step`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/native/include/fullmag_adaptive_step_decision.hpp#L127) | Backend-neutral history-aware scalar accept/retry/dt-min policy |
| Native FEM CPU | [`backends/fem/cpu/mfem/integrators/adaptive_dt.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/mfem/integrators/adaptive_dt.cpp#L123) | [`compute_adaptive_error_norm`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/mfem/integrators/adaptive_dt.cpp#L123) | Native FEM nodewise mixed error norm and fail-closed guards |
| Native FEM CPU | [`backends/fem/cpu/mfem/integrators/adaptive_dt.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/mfem/integrators/adaptive_dt.cpp#L379) | [`adaptive_pi_step`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/mfem/integrators/adaptive_dt.cpp#L379) | Native FEM history-aware scalar controller and rejection accounting |
| Native FEM GPU | [`backends/fem/gpu/cuda/integrators/rk/adaptive_error_kernels.cu`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/gpu/cuda/integrators/rk/adaptive_error_kernels.cu#L17) | [`adaptive_error_norm_blocks_kernel`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/gpu/cuda/integrators/rk/adaptive_error_kernels.cu#L17) | Native FEM GPU device reduction of the nodewise error norm |
| FDM CPU Engine | [`crates/fullmag-engine/src/fdm/cpu/integrators.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-engine/src/fdm/cpu/integrators.rs#L20) | [`decide_adaptive_step`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-engine/src/fdm/cpu/integrators.rs#L20) | FDM CPU history-aware bounded proposal and dt-min decision |
| FDM GPU CUDA | [`backends/fdm/gpu/cuda/runtime/reductions_fp64.cu`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fdm/gpu/cuda/runtime/reductions_fp64.cu#L963) | [`reduce_adaptive_error_policy`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fdm/gpu/cuda/runtime/reductions_fp64.cu#L963) | FDM GPU device-side adaptive error policy |
| FDM GPU CUDA | [`backends/fdm/gpu/cuda/runtime/reductions_fp64.cu`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fdm/gpu/cuda/runtime/reductions_fp64.cu#L918) | [`reduce_max_scalar_sqrt`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fdm/gpu/cuda/runtime/reductions_fp64.cu#L918) | FDM GPU scalar reduction implementation |
