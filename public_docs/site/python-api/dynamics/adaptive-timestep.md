---
title: Adaptive Timestep
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-dynamics-adaptive-timestep)=
# `AdaptiveTimestep` Contract

(python-api-dynamics-adaptive-timestep-problem-statement)=
<!-- (problem-statement)= -->
## 1. Physical problem and overview

`fm.AdaptiveTimestep` configures the embedded Runge–Kutta error tolerances, step-size bounds, proportional–integral (PI) controller gains/limits, and optional spin-rotation and norm-drift guards used by `rk23`, `rk45`, and `auto` time integration across FEM and FDM CPU/GPU realizations (`0960`: `LLG-TD-POLICY-V1` through `LLG-TD-ATOMIC-V1`).

(python-api-dynamics-adaptive-timestep-governing-equations)=
<!-- (governing-equations)= -->
## 2. Governing equations

For an attempted step $\Delta t_k$ on an embedded Runge–Kutta pair of error order $p$ ($p=2$ for `rk23`, $p=4$ for `rk45`), the active-node normalized error metric (`LLG-TD-MAX-ERR-V1`) is

```{math}
:label: eq-python-adaptive-error
\rho_k
=
\max_{i \in \mathcal{A}}
\frac{\|\mathbf{e}_i\|_2}{\mathrm{atol} + \mathrm{rtol}\,\max\!\left(\|\mathbf{m}_i^{\mathrm{old}}\|_2,\;\|\mathbf{m}_i^{\mathrm{high}}\|_2\right)},
```

and the history-aware PI step-size update (`LLG-TD-POLICY-V1`) is

```{math}
:label: eq-python-adaptive-pi
\Delta t_{k+1}
=
\mathrm{clip}\!\left(\Delta t_k\,\mathrm{clip}\!\left(q_k,\,q_{\min},\,q_{\max}\right),\;\Delta t_{\min},\;\Delta t_{\max}\right),
\qquad
q_k
=
\begin{cases}
q_{\max}, & \rho_k = 0, \\[4pt]
s\,\rho_k^{-1/(p+1)}, & \text{rejected attempt or no prior accepted }\rho_{k-1} > 0, \\[4pt]
s\,\rho_k^{-0.7/(p+1)}\,\rho_{k-1}^{0.4/(p+1)}, & \text{accepted step with prior accepted }\rho_{k-1} > 0.
\end{cases}
```

(python-api-dynamics-adaptive-timestep-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## 3. Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $\mathbf{e}_i$ | Embedded high-minus-low vector error at active point $i$ | $1$ |
| $\mathbf{m}_i^{\mathrm{old}}$ | Accepted magnetization state at the start of step $k$ | $1$ |
| $\mathbf{m}_i^{\mathrm{high}}$ | High-order candidate magnetization state before final normalization | $1$ |
| $\mathrm{atol}$ | Absolute normalized-state error tolerance | $1$ |
| $\mathrm{rtol}$ | Relative normalized-state error tolerance | $1$ |
| $\rho_k$ | Maximum normalized local error ratio at attempt $k$ | $1$ |
| $\rho_{k-1}$ | Previous accepted non-zero normalized error ratio | $1$ |
| $p$ | Embedded error-estimator order ($2$ for `rk23`, $4$ for `rk45`) | $1$ |
| $s$ | Controller safety factor (`safety`) | $1$ |
| $q_k$ | Raw adaptive step-size multiplier | $1$ |
| $q_{\min}$ | Minimum step-size shrink ratio (`shrink_limit`) | $1$ |
| $q_{\max}$ | Maximum step-size growth ratio (`growth_limit`) | $1$ |
| $\Delta t_k$ | Attempted time step | $\mathrm{s}$ |
| $\Delta t_{\min}$ | Minimum allowed time step (`dt_min`) | $\mathrm{s}$ |
| $\Delta t_{\max}$ | Maximum allowed time step (`dt_max`) | $\mathrm{s}$ |
| $\mathcal{A}$ | Active magnetic cell/node index set ($M_{s,i} > 0$) | $1$ |

(python-api-dynamics-adaptive-timestep-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## 4. Assumptions and limits of validity

- **Non-degenerate tolerance scale**: Both `atol` and `rtol` must be non-negative and at least one must be strictly positive so that the denominator in {eq}`eq-python-adaptive-error` is positive on active magnetic nodes.
- **Step-bound ordering**: When `dt_max` is supplied, $\Delta t_{\max} \ge \Delta t_{\min} > 0$; when `dt_initial` is supplied, $\Delta t_{\min} \le \Delta t_{\mathrm{initial}} \le \Delta t_{\max}$.
- **Atomic rejection and `dt_min` floor**: Rejected steps ($\rho_k > 1$ or violated `max_spin_rotation`/`norm_tolerance`) restore the pre-attempt state and retry with $\Delta t_{k+1}$. If $\rho_k > 1$ at $\Delta t_k = \Delta t_{\min}$, execution fails closed with a typed `dt_min` underflow error.

(python-api-dynamics-adaptive-timestep-python-api)=
<!-- (python-api)= -->
## 5. Python API and parameter contract

### Constructor signature

```text
fm.AdaptiveTimestep(
    *,
    atol: float = 1e-6,
    rtol: float = 1e-3,
    dt_initial: float | None = None,
    dt_min: float = 1e-15,
    dt_max: float | None = None,
    safety: float = 0.9,
    growth_limit: float = 2.0,
    shrink_limit: float = 0.2,
    max_spin_rotation: float | None = None,
    norm_tolerance: float | None = None,
)
```

### Parameter reference

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | `ProblemIR` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `AdaptiveTimestep.atol` | `float` | `1e-6` | $1$ | Non-negative; one of atol/rtol positive | Absolute tolerance | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `adaptive_timestep.atol` |
| `AdaptiveTimestep.rtol` | `float` | `1e-3` | $1$ | Non-negative | Relative tolerance | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `adaptive_timestep.rtol` |
| `AdaptiveTimestep.dt_initial` | `float \| None` | `None` | $\mathrm{s}$ | Within `[dt_min, dt_max]` | Initial step | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `adaptive_timestep.dt_initial` |
| `AdaptiveTimestep.dt_min` | `float` | `1e-15` | $\mathrm{s}$ | Positive | Minimum step | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `adaptive_timestep.dt_min` |
| `AdaptiveTimestep.dt_max` | `float \| None` | `None` | $\mathrm{s}$ | `>= dt_min` | Maximum step | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `adaptive_timestep.dt_max` |
| `AdaptiveTimestep.safety` | `float` | `0.9` | $1$ | `(0, 1]` | Step safety factor | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `adaptive_timestep.safety` |
| `AdaptiveTimestep.growth_limit` | `float` | `2.0` | $1$ | `> 1` | Growth limit | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `adaptive_timestep.growth_limit` |
| `AdaptiveTimestep.shrink_limit` | `float` | `0.2` | $1$ | `(0, 1)` | Shrink limit | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `adaptive_timestep.shrink_limit` |
| `AdaptiveTimestep.max_spin_rotation` | `float \| None` | `None` | $\mathrm{rad}$ | Positive | Spin-rotation cap | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `adaptive_timestep.max_spin_rotation` |
| `AdaptiveTimestep.norm_tolerance` | `float \| None` | `None` | $1$ | Positive | Norm tolerance | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `adaptive_timestep.norm_tolerance` |

### Executable Python example

```python
# %%
import fullmag as fm

adaptive = fm.AdaptiveTimestep(
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
)

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

study = fm.study(world, target="fdm", device="cpu", precision="fp64")
study.solver(integrator="rk45", adaptive_timestep=adaptive)
study.stages.add_time(name="pulse", duration=0.2e-9, By=5e-3, save_m_every=50e-12)

ir = study.to_problem_ir()
assert ir["study"]["dynamics"]["adaptive_timestep"]["atol"] == 1e-6
assert ir["study"]["dynamics"]["adaptive_timestep"]["max_spin_rotation"] == 0.35
```

(python-api-dynamics-adaptive-timestep-problem-ir)=
<!-- (problem-ir)= -->
## 6. `ProblemIR` and canonical script representation

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

(python-api-dynamics-adaptive-timestep-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## 7. Round-trip, provenance, and failure semantics

- **Requested intent vs. resolved execution**: `AdaptiveTimestep` fields serialize verbatim into `ProblemIR` (`requested intent`) and are recorded alongside the resolved integrator and step statistics in the execution receipt (`resolved execution`).
- **Validation errors**: Negative tolerances, `atol == 0` and `rtol == 0`, `dt_min <= 0`, `dt_max < dt_min`, `dt_initial` outside `[dt_min, dt_max]`, `safety` outside `(0, 1]`, `growth_limit <= 1`, or `shrink_limit` outside `(0, 1)` raise immediate `ValueError` validation errors.
- **Unsupported combinations**: Supplying `AdaptiveTimestep` alongside `fixed_timestep` or with a fixed-step integrator (`heun`, `rk4`, `abm3`, `coupled_imex_ark2`) is rejected as an unsupported combination.

(python-api-dynamics-adaptive-timestep-discrete-realization)=
<!-- (discrete-realization)= -->
## 8. Discrete realization and numerical operators

- **Shared PI decision header**: `decide_adaptive_step` in `native/include/fullmag_adaptive_step_decision.hpp`.
- **FEM CPU & GPU**: `compute_adaptive_error_norm` / `adaptive_pi_step` (CPU) and `adaptive_error_norm_blocks_kernel` / `gpu_rk_adaptive_pi_step` (GPU).
- **FDM CPU & GPU**: `max_error_norm_buf` / `decide_adaptive_step` (CPU) and `reduce_adaptive_error_policy` (GPU).

(python-api-dynamics-adaptive-timestep-implementation-mapping)=
<!-- (implementation-mapping)= -->
## 9. Backend and device implementation mapping

| Solver | Device | Status | Notes |
| --- | --- | --- | --- |
| FEM | CPU | `documented` | Nodewise mixed tolerance reduction and history PI controller in `adaptive_dt.cpp`. |
| FEM | GPU | `documented` | Device block reduction (`adaptive_error_kernels.cu`) and `rk_adaptive_runtime.cu`. |
| FDM | CPU | `documented` | Active-cell error reduction and history PI controller in `integrators.rs`. |
| FDM | GPU | `documented` | CUDA `reduce_adaptive_error_policy` in `reductions_fp64.cu`. |

(python-api-dynamics-adaptive-timestep-validation)=
<!-- (validation)= -->
## 10. Validation and benchmark gates

- Validated in `packages/fullmag-py/tests/test_llg_solver_contract.py`, `backends/fem/tests/adaptive_dt_contract.cpp`, and `backends/fem/tests/adaptive_error_policy_contract.cpp`.

(python-api-dynamics-adaptive-timestep-limitations)=
<!-- (limitations)= -->
## 11. Known limitations and operational constraints

- Local truncation error control bounds single-step error but does not by itself certify static equilibrium in `Relaxation` stages; equilibrium requires the independent torque and energy stopping criteria (`RelaxStop`).

(python-api-dynamics-adaptive-timestep-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## 12. Scientific bibliography

1. G. Söderlind, *Automatic control and adaptive time-stepping*, Numer. Algorithms **31**, 281–310 (2002).

(python-api-dynamics-adaptive-timestep-source-code-index)=
<!-- (source-code-index)= -->
## 13. Source-code index

| Layer | File | Symbol / entrypoint | Responsibility |
| --- | --- | --- | --- |
| Python DSL | [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/dynamics.py#L30) | [`class AdaptiveTimestep`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/dynamics.py#L30) | Adaptive-step parameters, validation, and IR lowering |
| Shared Native Header | [`native/include/fullmag_adaptive_step_decision.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/native/include/fullmag_adaptive_step_decision.hpp#L127) | [`decide_adaptive_step`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/native/include/fullmag_adaptive_step_decision.hpp#L127) | Backend-neutral order-aware history PI step decision |
| Native FEM CPU | [`backends/fem/cpu/mfem/integrators/adaptive_dt.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/mfem/integrators/adaptive_dt.cpp#L123) | [`compute_adaptive_error_norm`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/mfem/integrators/adaptive_dt.cpp#L123) | Native FEM nodewise mixed error norm and geometric guards |
| Native FEM GPU | [`backends/fem/gpu/cuda/integrators/rk/adaptive_error_kernels.cu`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/gpu/cuda/integrators/rk/adaptive_error_kernels.cu#L17) | [`adaptive_error_norm_blocks_kernel`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/gpu/cuda/integrators/rk/adaptive_error_kernels.cu#L17) | Native FEM GPU block reduction for the active-node error norm |
| FDM CPU Engine | [`crates/fullmag-engine/src/fdm/cpu/integrators.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-engine/src/fdm/cpu/integrators.rs#L20) | [`decide_adaptive_step`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-engine/src/fdm/cpu/integrators.rs#L20) | FDM CPU history-aware PI step decision |
| FDM GPU CUDA | [`backends/fdm/gpu/cuda/runtime/reductions_fp64.cu`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fdm/gpu/cuda/runtime/reductions_fp64.cu#L963) | [`reduce_adaptive_error_policy`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fdm/gpu/cuda/runtime/reductions_fp64.cu#L963) | FDM GPU adaptive error reduction and dt-min policy |
