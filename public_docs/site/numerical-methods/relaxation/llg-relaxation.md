---
title: LLG Relaxation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
source_of_truth: /physics/foundations/llg-equation, /physics/foundations/micromagnetic-energy
---

(public-docs-numerical-methods-relaxation-llg-relaxation)=
# Overdamped LLG relaxation

(numerical-methods-relaxation-llg-problem-statement)=
## Scope and purpose

This page documents the overdamped Landau–Lifshitz–Gilbert relaxation stage (`llg_overdamped`),
its accepted-step integrators, its history-aware adaptive error controller, and its independent
accepted-state equilibrium stop contract. `llg_overdamped` reuses the LLG right-hand-side and
time-integration pipeline while disabling precession; its stage relaxation coordinate controls
convergence and is not carried into a subsequent `run` stage.

(numerical-methods-relaxation-llg-governing-equations)=
## Scientific and numerical model

For reduced magnetization $\mathbf m=\mathbf M/M_s$ and effective field
$\mathbf H_{\mathrm{eff}}$, the implemented pure-damping equation is

```{math}
:label: eq-relax-llg-damping
\frac{\partial \mathbf m}{\partial t}
=-\frac{\gamma_0\alpha}{1+\alpha^2}
\mathbf m\times\left(\mathbf m\times\mathbf H_{\mathrm{eff}}\right),
\qquad \lVert\mathbf m\rVert_2=1.
```

The effective field is assembled from all active energy terms:

```{math}
:label: eq-relax-llg-effective-field
\mathbf H_{\mathrm{eff}}
=-\frac{1}{\mu_0M_s}\frac{\delta E}{\delta\mathbf m},
\qquad
\boldsymbol\tau_i=\mathbf m_i\times\mathbf H_{\mathrm{eff},i}.
```

The stopping metric is the maximum accepted-state torque,

```{math}
:label: eq-relax-llg-stop-metric
\tau_{\max}=\max_i\lVert\boldsymbol\tau_i\rVert_2,
\qquad \tau_{\max}\leq\varepsilon_\tau.
```

The time integrator can be fixed-step, adaptive embedded `rk23`/`rk45`, or fixed-step `abm3` on
FDM/FEM-reference paths. Adaptive local error control governs step acceptance, whereas $\tau_{\max}$
(plus optional energy plateau) governs relaxation completion.

(numerical-methods-relaxation-llg-integrators)=
### Integrator families and exact step control

| Name | Canonicalization | Family and order | Adaptive? | Backend boundary |
|---|---|---|---|---|
| `heun` | unchanged | explicit RK2 | no | FEM CPU/GPU and FDM CPU/GPU fixed-step paths |
| `rk4` | unchanged | explicit RK4 | no | FEM CPU/GPU and FDM CPU/GPU fixed-step paths |
| `rk23` | `bs23`, `rk32` $\to$ `rk23` | Bogacki–Shampine embedded 3(2) | yes or fixed | FEM CPU/GPU and FDM CPU/GPU |
| `rk45` | `dp54` $\to$ `rk45` | Dormand–Prince embedded 5(4) | yes or fixed | FEM CPU/GPU and FDM CPU/GPU |
| `abm3` | unchanged | Adams–Bashforth–Moulton 3rd-order multistep | no | FDM CPU/GPU and FEM CPU reference; rejected by native FEM GPU ABI |
| `coupled_imex_ark2` | unchanged | coupled spin-transport IMEX scheme | coupled adaptive transport only | valid only with a transient spin-transport module; not a standalone relaxation method |

`solver=None` and `solver="auto"` resolve to `rk23` at the Python relaxation boundary. A fixed
step is selected with `dt=<positive seconds>`. Adaptive stepping is selected with `dt="auto"` or an
explicit `AdaptiveTimestep`; executable adaptive stages require an explicit positive `dt_min` and
`dt_max`. `dt="auto"`, `max_err`, and `max_error` reject fixed-only integrators.

For an embedded method with stage derivatives $\mathbf k_{s,i}$ and tableau weights
$b_s^{\mathrm{hi}}, b_s^{\mathrm{lo}}$, the local error vector, mixed scale, and active-set maximum
ratio are

```{math}
:label: eq-relax-llg-adaptive-error-norm
\mathbf e_i
=\Delta t\sum_{s=0}^{S-1}
\left(b_s^{\mathrm{hi}}-b_s^{\mathrm{lo}}\right)\mathbf k_{s,i},
\qquad
\sigma_i
=\mathrm{atol}+\mathrm{rtol}\,
\max\!\left(\lVert\mathbf m_i^{\mathrm{old}}\rVert_2,
\lVert\mathbf m_i^{\mathrm{high}}\rVert_2\right),
\qquad
\rho
=\max_{i\in\mathcal A}\frac{\lVert\mathbf e_i\rVert_2}{\sigma_i}.
```

$\mathcal A$ is the active magnetic-node/cell mask. A trial is accepted when $\rho\leq 1$ (and any
configured `norm_tolerance` / `max_spin_rotation` guards pass). With previous accepted non-zero
error ratio $\rho_{k-1}$ and embedded error order $p$, the shared history-aware PI controller sets

```{math}
:label: eq-relax-llg-adaptive-controller
\begin{aligned}
q_k&=
\begin{cases}
q_{\max}, & \rho_k=0,\\
s\,\rho_k^{-1/(p+1)}, & \rho_k>0\text{ and the trial is rejected, or no previous history exists},\\
s\,\rho_k^{-0.7/(p+1)}\rho_{k-1}^{0.4/(p+1)},
& \rho_k>0\text{ and the trial is accepted with previous history},
\end{cases}
\\
\widehat q_k&=\operatorname{clip}_{[q_{\min},q_{\max}]}(q_k),
\qquad
\Delta t_{k+1}=\operatorname{clip}_{[\Delta t_{\min},\Delta t_{\max}]}
\left(\Delta t_k\widehat q_k\right).
\end{aligned}
```

A rejected trial is restored atomically without advancing accepted-step or previous-error history.
If $\rho > 1$ at `dt_min`, the attempt fails closed with `dt_min_exhausted`.

On FEM GPU, `llg_overdamped` automatically shares the explicit-RK GPU optimizations: FSAL `k0`
reuse for `heun`/`rk4`/PBC, two-step linear potential prediction $\phi^{(0)}$, `cuDSS` direct
demagnetization (`19×–218×` open-airbox / `27×–36×` PBC), and fused short-range kernels (`1.80×`
RK4 E2E speedup). See {ref}`numerical-methods-performance-fem-gpu-demag` and
{ref}`numerical-methods-performance-fem-gpu-kernels`.

(numerical-methods-relaxation-llg-symbols-and-si-units)=
### Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf m$ | reduced magnetization | $1$ |
| $\mathbf M$ | dimensional magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{eff}}$ | total effective magnetic field | $\mathrm{A\,m^{-1}}$ |
| $E$ | total micromagnetic energy | $\mathrm{J}$ |
| $\gamma_0$ | FullMag reduced gyromagnetic ratio | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $\alpha$ | Gilbert damping parameter | $1$ |
| $t$ | relaxation integration coordinate | $\mathrm{s}$ |
| $\tau_{\max}$ | maximum accepted-state torque | $\mathrm{A\,m^{-1}}$ |
| $\boldsymbol\tau_i$ | local effective-field torque residual | $\mathrm{A\,m^{-1}}$ |
| $\varepsilon_\tau$ | canonical torque stopping threshold | $\mathrm{A\,m^{-1}}$ |
| $\Delta t_k$ | attempted or proposed adaptive integration step | $\mathrm{s}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $s$ | adaptive controller safety factor | $1$ |
| $\rho_k$ | normalized local-error ratio | $1$ |
| $\rho_{k-1}$ | previous accepted non-zero error ratio | $1$ |
| $p$ | order of the embedded error estimate | $1$ |
| $\Delta t_{\min}$ | adaptive lower timestep bound | $\mathrm{s}$ |
| $\Delta t_{\max}$ | adaptive upper timestep bound | $\mathrm{s}$ |
| $q_{\min}$ | minimum adaptive step-size factor | $1$ |
| $q_{\max}$ | maximum adaptive step-size factor | $1$ |
| $\mathbf e_i$ | embedded high-minus-low vector error | $1$ |
| $\mathbf k_{s,i}$ | stage right-hand side | $\mathrm{s^{-1}}$ |
| $b_s^{\mathrm{hi}}$ | high-order tableau weight | $1$ |
| $b_s^{\mathrm{lo}}$ | low-order tableau weight | $1$ |
| $S$ | number of stages in the embedded tableau | $1$ |
| $\mathbf m_i^{\mathrm{old}}$ | state at the beginning of the attempted step | $1$ |
| $\mathbf m_i^{\mathrm{high}}$ | high-order candidate state | $1$ |
| $\mathrm{atol}$ | absolute normalized-state error scale | $1$ |
| $\mathrm{rtol}$ | relative normalized-state error scale | $1$ |
| $\sigma_i$ | mixed absolute/relative local error scale | $1$ |
| $\mathcal A$ | active magnetic cell/node index set | $1$ |
| $q_k$ | raw adaptive step-size factor | $1$ |
| $\widehat q_k$ | clamped adaptive step-size factor | $1$ |

The stage default `relax_alpha=1.0` overrides damping only inside the pure-damping relaxation stage
without mutating the material's physical $\alpha$ for subsequent dynamic stages.

(numerical-methods-relaxation-llg-assumptions-and-validity)=
### Assumptions and validity

- The stage is deterministic with no thermal noise unless explicitly configured on a supported lane.
- `llg_overdamped` disables only precession; all active effective-field terms remain active.
- An adaptive error pass bounds single-step truncation error only; equilibrium certification relies
  exclusively on the accepted-state torque (and optional energy window) in {doc}`stopping-criteria`.
- `tolT` and `tolA` are mutually exclusive; `tolT` converts via $\tau_{\mathrm{A/m}}=\tau_{\mathrm T}/\mu_0$.

(numerical-methods-relaxation-llg-iteration)=
### One accepted LLG relaxation step

1. Assemble the complete effective field from the active interaction list on the current normalized
   magnetization.
2. Evaluate the pure-damping right-hand side using `relax_alpha` (when supplied) or material $\alpha$.
3. Advance one step with the resolved integrator (`heun`, `rk4`, `rk23`, `rk45`, or `abm3`),
   atomically rolling back and retrying rejected adaptive attempts.
4. Commit the normalized accepted state, refresh fields as required, and update torque confirmation,
   energy window, and work/time budgets.

(numerical-methods-relaxation-llg-discrete-realization)=
### Discrete realization

| Solver | Device | Status | Realization and evidence boundary |
|---|---|---|---|
| FDM | CPU | `implemented` | Reference Cartesian grid runner (`execute_reference_fdm_with_coupled_checkpoint`) and active-cell error reduction (`max_error_norm_buf`). |
| FDM | GPU | `implemented` | CUDA pure-damping execution path with device reductions (`reduce_adaptive_error_policy`) and Hermitian D2Z/R2C cuFFT demag. |
| FEM | CPU | `implemented` | Native MFEM LLG relaxation lane (`execute_llg_overdamped`) with active-node maximum mixed error norm (`compute_adaptive_error_norm`). |
| FEM | GPU | `implemented` | Native CUDA/MFEM device-resident LLG lane with `adaptive_error_norm_blocks_kernel`, `gpu_rk_adaptive_pi_step`, FSAL/predictor, `cuDSS`/`CG-AMG` demag, and fused short-range kernels; native ABI rejects `abm3`. |

(numerical-methods-relaxation-llg-implementation-mapping)=
### Implementation mapping

The Python stage builder calls `relax_stage`; `Relaxation` and `RelaxStop` validate and serialize
the shared contract. Backend runners resolve pure damping via `llg_overdamped_uses_pure_damping`
and delegate step integration to their lane-specific explicit RK/multistep implementations.

(numerical-methods-relaxation-llg-problem-ir)=
## Parameters

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `StudyStagesBuilder.add_relax(algorithm=...)` | `str` | `"llg_overdamped"` | $1$ | supported algorithm identifier | selects relaxation realization | FEM/FDM CPU/GPU | `study.algorithm` |
| `StudyStagesBuilder.add_relax(solver=...)` | `str \| None` | `None` $\to$ `rk23` | $1$ | `heun`, `rk4`, `rk23` (`bs23`/`rk32`), `rk45` (`dp54`), `abm3`; `coupled_imex_ark2` only with transient spin transport | selects LLG integrator | lane-dependent; native FEM GPU rejects `abm3` | `study.dynamics.integrator` |
| `StudyStagesBuilder.add_relax(dt=...)` | `float \| "auto" \| None` | `None` | $\mathrm{s}$ | fixed step or `"auto"`; cannot mix with adaptive fields | fixed or automatic step mode | RK23/RK45 for auto; fixed RK on all lanes | `dynamics.fixed_timestep` / resolved policy |
| `StudyStagesBuilder.add_relax(dt_initial=...)` | `float \| None` | `None` | $\mathrm{s}$ | positive; requires `dt_min`, `dt_max` in executable adaptive stage | first adaptive step | RK23/RK45 lanes | `study.dynamics.adaptive_timestep.dt_initial` |
| `StudyStagesBuilder.add_relax(dt_min=...)` | `float \| None` | required for adaptive stage | $\mathrm{s}$ | positive | adaptive lower bound | RK23/RK45 lanes | `study.dynamics.adaptive_timestep.dt_min` |
| `StudyStagesBuilder.add_relax(dt_max=...)` | `float \| None` | required for adaptive stage | $\mathrm{s}$ | positive and $\ge$ `dt_min` | adaptive upper bound | RK23/RK45 lanes | `study.dynamics.adaptive_timestep.dt_max` |
| `StudyStagesBuilder.add_relax(max_err=...)` | `float \| None` | `None` | $1$ | positive; adaptive RK only (`max_error` deprecated alias) | absolute embedded vector-error limit (`rtol=0`, `tolerance_mode="max_error"`) | RK23/RK45 lanes | `study.dynamics.adaptive_timestep.atol` |
| `StudyStagesBuilder.add_relax(adaptive_timestep=...)` | `AdaptiveTimestep \| None` | `None` | $1$ | `rk23`/`rk45` only for standalone relaxation | full adaptive policy | FEM/FDM CPU/GPU | `dynamics.adaptive_timestep` |
| `StudyStagesBuilder.add_relax(field_refresh=...)` | `FieldRefreshPolicy \| None` | `None` | $\mathrm{s}$ | positive cadence fields | expensive-field refresh cadence | backend-dependent | `dynamics.field_refresh` |
| `StudyStagesBuilder.add_relax(relax_alpha=...)` | `float \| None` | $1$ for overdamped LLG | $1$ | `llg_overdamped` only; `None` keeps material damping | stage-local damping override | FEM/FDM LLG relaxation | resolved LLG provenance |
| `StudyStagesBuilder.add_relax(tolT=...)` | `float` | $10^{-6}$ | $\mathrm{T}$ | finite and positive; exclusive with `tolA` | user torque threshold | FEM/FDM lanes | `study.stop.torque_tolerance_apm` |
| `StudyStagesBuilder.add_relax(tolA=...)` | `float` | canonical equivalent | $\mathrm{A\,m^{-1}}$ | finite and positive; exclusive with `tolT` | field-residual threshold | FEM/FDM lanes | `study.stop.torque_tolerance_apm` |
| `StudyStagesBuilder.add_relax(energy_tolerance=...)` | `float \| None` | `None` | $\mathrm{J}$ | positive when set | 50-sample accepted-energy plateau threshold | FEM/FDM lanes | `study.stop.energy_tolerance_j` |
| `StudyStagesBuilder.add_relax(max_steps=...)` | `int` | $50{,}000$ | $1$ | positive integer | hard accepted-step budget | FEM/FDM lanes | `study.stop.max_steps` |
| `StudyStagesBuilder.add_relax(max_relaxation_time_s=...)` | `float \| None` | `None` | $\mathrm{s}$ | positive; aliases `max_pseudotime_s`, `max_physical_time_s` must agree | relaxation-coordinate ceiling | `llg_overdamped` only | `study.stop.max_relaxation_time_s` |
| `StudyStagesBuilder.add_relax(stop=...)` | `RelaxStop \| None` | `None` | $1$ | grouped stop; scalar aliases cannot conflict | canonical stopping object | FEM/FDM lanes | `study.stop` |

(numerical-methods-relaxation-llg-python-api)=
## Python API

```python
# %% Configure an overdamped LLG FEM relaxation stage
import fullmag as fm

nm = 1.0e-9
study = fm.study("overdamped_llg_relaxation")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(700 * nm, 250 * nm, 250 * nm))

film = study.geometry(
    fm.Box(size=(500 * nm, 125 * nm, 3 * nm), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.1, 0.0)
study.exchange()
study.stages.add_relax(
    stage_id="relax",
    algorithm="llg_overdamped",
    solver="rk45",
    dt_initial=1.0e-15,
    dt_min=1.0e-17,
    dt_max=1.0e-14,
    max_err=1.0e-7,
    relax_alpha=1.0,
    tolT=1.0e-6,
    max_steps=50_000,
)
```

### `ProblemIR` excerpt

```json
{
  "kind": "relaxation",
  "algorithm": "llg_overdamped",
  "dynamics": {
    "integrator": "rk45",
    "fixed_timestep": null,
    "adaptive_timestep": {
      "atol": 1e-7,
      "rtol": 0.0,
      "dt_initial": 1e-15,
      "dt_min": 1e-17,
      "dt_max": 1e-14,
      "tolerance_mode": "max_error"
    }
  },
  "stop": {
    "torque_tolerance_apm": 0.7957747154594767,
    "max_steps": 50000
  }
}
```

## Control Room workflow

Use the relaxation stage inspector to select `llg_overdamped`, choose the integrator (`heun`,
`rk4`, `rk23`, `rk45`, `abm3`) and fixed/adaptive step controls, and monitor accepted steps,
rejected trials, $\Delta t$, and accepted-state torque convergence.

(numerical-methods-relaxation-llg-round-trip-and-failure-semantics)=
## Diagnostics and failure semantics

- **Round-trip preservation**: Script export emits `study.stages.add_relax(...)` preserving the
  algorithm, canonicalized integrator (`bs23`/`rk32` $\to$ `rk23`, `dp54` $\to$ `rk45`), stopping
  policy, and requested intent (`study.engine`/`study.device`) separately from resolved execution
  provenance.
- **Validation errors**: Unknown integrators, non-positive timestep bounds, mixed fixed/adaptive
  controls, missing adaptive bounds, simultaneous `tolT`/`tolA`, legacy `tol`, and LLG-only
  controls attached to direct minimizers raise validation errors.
- **Fail-closed execution**: Unsupported combinations (e.g., `abm3` on native FEM GPU) are rejected
  by the planner with zero silent fallback. Non-finite states, failed field solves, or
  `dt_min_exhausted` never publish as converged.

(numerical-methods-relaxation-llg-validation)=
## Validation

Required evidence spans four gates: pure-damping sign/unit contracts, stage-to-IR round-trip,
adaptive PI and torque/energy convergence contracts, and executed backend/device parity runs
({doc}`../../validation/cpu-gpu-parity`, {doc}`../../validation/qualification-status`).

(numerical-methods-relaxation-llg-limitations)=
## Limitations

This page does not claim a physical switching time, unconditional stability, or convergence to a
global energy minimum. The terminal state may be a local metastable equilibrium.

(numerical-methods-relaxation-llg-scientific-bibliography)=
## Scientific bibliography

- W. F. Brown, Jr., *Micromagnetics*, Wiley, 1963.
- T. L. Gilbert, “A phenomenological theory of damping in ferromagnetic materials,” *IEEE Transactions on Magnetics* **40**, 3443–3449 (2004), DOI: [10.1109/TMAG.2004.836740](https://doi.org/10.1109/TMAG.2004.836740).
- FullMag public physics contracts: {doc}`/physics/foundations/llg-equation` and {doc}`/physics/foundations/micromagnetic-energy`.

(numerical-methods-relaxation-llg-source-code-index)=
## Where this is implemented

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Stop defaults and validation | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L831) | [`class RelaxStop`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L831) | canonical torque/energy/step stop contract | public API | Python contract tests |
| Algorithm and IR validation | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L901) | [`class Relaxation`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L901) | supported algorithms and serialized relaxation payload | public API | Python contract tests |
| Stage lowering | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L3419) | [`relax_stage`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L3419) | maps stage arguments into `RelaxStageSpec` | public API | stage export tests |
| LLG object and adaptive policy | [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L159) | [`class LLG`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L159) / [`class AdaptiveTimestep`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L45) / [`class FieldRefreshPolicy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L142) | validates integrator names, aliases (`dp54`/`bs23`/`rk32`), timestep bounds and serialized dynamics | public API | Python dynamics tests |
| Adaptive FEM helper | [`crates/fullmag-runner/src/fem/integrators/adaptive.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fem/integrators/adaptive.rs#L74) | [`pi_controller_dt`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fem/integrators/adaptive.rs#L74) | stateless single-step reference proposal helper | FEM CPU/GPU | integrator unit tests |
| Fixed FEM validation | [`crates/fullmag-runner/src/fem/integrators/fixed.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fem/integrators/fixed.rs#L75) | [`validate_fixed_dt`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fem/integrators/fixed.rs#L75) | fixed-step Heun/RK4 validation | FEM CPU/GPU | integrator unit tests |
| Native FEM adaptive error norm | [`backends/fem/cpu/mfem/integrators/adaptive_dt.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/integrators/adaptive_dt.cpp#L123) | [`compute_adaptive_error_norm`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/integrators/adaptive_dt.cpp#L123) | active-node maximum mixed atol/rtol norm and fail-closed guards | FEM CPU | native FEM contract tests |
| Native FEM adaptive controller | [`backends/fem/cpu/mfem/integrators/adaptive_dt.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/integrators/adaptive_dt.cpp#L379) | [`adaptive_pi_step`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/integrators/adaptive_dt.cpp#L379) | history-aware PI decision and rejection accounting | FEM CPU | native FEM adaptive tests |
| Native FEM GPU adaptive error norm | [`backends/fem/gpu/cuda/integrators/rk/adaptive_error_kernels.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/adaptive_error_kernels.cu#L17) | [`adaptive_error_norm_blocks_kernel`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/adaptive_error_kernels.cu#L17) | device reduction of the active-node error metric | FEM GPU | CUDA contract tests |
| Native FEM GPU adaptive controller | [`backends/fem/gpu/cuda/integrators/rk/rk_adaptive_runtime.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/rk_adaptive_runtime.cu#L23) | [`gpu_rk_adaptive_pi_step`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/rk_adaptive_runtime.cu#L23) | device-lane PI decision and previous-error history | FEM GPU | CUDA contract tests |
| Shared adaptive scalar policy | [`native/include/fullmag_adaptive_step_decision.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/native/include/fullmag_adaptive_step_decision.hpp#L127) | [`decide_adaptive_step`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/native/include/fullmag_adaptive_step_decision.hpp#L127) | shared history-aware accept/retry/dt-min decision | FDM/FEM native | policy contract tests |
| FDM adaptive error norm | [`crates/fullmag-engine/src/fdm/cpu/integrators.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/integrators.rs#L4622) | [`max_error_norm_buf`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/integrators.rs#L4622) / [`decide_adaptive_step`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/integrators.rs#L22) | active-cell error norm and bounded PI proposal | FDM CPU | engine integrator tests |
| FDM GPU adaptive error reduction | [`backends/fdm/gpu/cuda/runtime/reductions_fp64.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/runtime/reductions_fp64.cu#L967) | [`reduce_adaptive_error_policy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/runtime/reductions_fp64.cu#L967) | CUDA reduction and typed dt-min failure | FDM GPU | CUDA policy contract tests |
| Rust FEM reference adaptive loop | [`crates/fullmag-engine/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fem.rs#L2085) | [`rk23_step_ws`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fem.rs#L2085) | legacy reference adaptive loop | FEM reference | engine tests |
| Native FDM integrator dispatch | [`crates/fullmag-runner/src/fdm/gpu/cuda/native/construction.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fdm/gpu/cuda/native/construction.rs#L45) | [`create_multilayer_v2`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fdm/gpu/cuda/native/construction.rs#L45) | maps canonical integrator to CUDA ABI | FDM GPU | device-gated tests |
| Shared pure-damping & completion | [`crates/fullmag-runner/src/relaxation/convergence.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/convergence.rs#L193) | [`llg_overdamped_uses_pure_damping`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/convergence.rs#L193) / [`relaxation_converged`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/convergence.rs#L63) / [`observe`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/convergence.rs#L113) | pure-damping selection, torque/energy conjunction, and 3-sample confirmation | shared orchestration | runner tests |
| FEM LLG execution | [`crates/fullmag-runner/src/fem/relax/llg_overdamped.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fem/relax/llg_overdamped.rs#L174) | [`execute_llg_overdamped`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fem/relax/llg_overdamped.rs#L174) / [`convergence_controller_policy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fem/relax/llg_overdamped.rs#L43) | native FEM loop, integrator, and completion provenance | FEM CPU/GPU | native runtime tests |
| FDM CPU/reference LLG | [`crates/fullmag-runner/src/fdm/cpu/reference.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fdm/cpu/reference.rs#L1608) | [`execute_reference_fdm_with_coupled_checkpoint`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fdm/cpu/reference.rs#L1608) | Cartesian reference relaxation dispatch | FDM CPU | runner tests |
