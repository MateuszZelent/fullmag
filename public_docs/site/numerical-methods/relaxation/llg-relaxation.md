---
title: LLG Relaxation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0500-fdm-relaxation-algorithms.md, docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md, docs/physics/0580-canonical-relaxation-equilibrium-contract.md
---

(public-docs-numerical-methods-relaxation-llg-relaxation)=
# Overdamped LLG relaxation

(numerical-methods-relaxation-llg-problem-statement)=
## Physical problem

`llg_overdamped` reuses the LLG right-hand-side and time-integration pipeline while disabling
precession. It is a relaxation coordinate, not a physical switching experiment: its stage clock
controls convergence and is not carried into a later `run` stage. The magnetization remains
normalized pointwise, and the accepted state is tested using the effective-field torque.

(numerical-methods-relaxation-llg-governing-equations)=
## Governing equations

For reduced magnetization $\mathbf m=\mathbf M/M_s$ and effective field
$\mathbf H_{\mathrm{eff}}$, the implemented pure-damping equation is

```{math}
:label: eq-relax-llg-damping
\frac{\partial \mathbf m}{\partial t}
=-\frac{\gamma_0\alpha}{1+\alpha^2}
\mathbf m\times\left(\mathbf m\times\mathbf H_{\mathrm{eff}}\right),
\qquad \lVert\mathbf m\rVert_2=1.
```

The effective field is assembled from the active energy terms:

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

The time integrator can be fixed-step, adaptive embedded RK23/RK45, or the FDM/reference ABM3
multistep method. The adaptive error policy is distinct from the physical torque criterion: the
local vector error controls step acceptance, while $\tau_{\max}$ controls relaxation completion.

(numerical-methods-relaxation-llg-integrators)=
## Integrator families and exact step control

The following names are accepted by the Python `LLG` object and by the relaxation stage builder.
The table describes the numerical method, not merely a label stored in metadata.

| Name | Canonicalization | Family and order | Adaptive? | Backend boundary |
|---|---|---|---|---|
| `heun` | unchanged | explicit RK2 | no | FEM CPU/GPU and FDM CPU/GPU fixed-step paths |
| `rk4` | unchanged | explicit RK4 | no | FEM CPU/GPU and FDM CPU/GPU fixed-step paths |
| `rk23` | `bs23` → `rk23` | Bogacki–Shampine embedded method | yes or fixed | FEM CPU/GPU and FDM CPU/GPU; multilayer CUDA restrictions still apply |
| `rk45` | `dp54` → `rk45` | Dormand–Prince embedded method | yes or fixed | FEM CPU/GPU and FDM CPU/GPU; multilayer CUDA restrictions still apply |
| `abm3` | unchanged | Adams–Bashforth–Moulton third-order multistep | no | FDM and reference FEM; rejected by native FEM GPU ABI |
| `coupled_imex_ark2` | unchanged | coupled spin-transport IMEX scheme | coupled adaptive transport only | valid only with a transient spin-transport module; not a standalone relaxation method |

`solver=None` and `solver="auto"` resolve to `rk23` at the Python relaxation boundary. A fixed
step is selected with `dt=<positive seconds>`. Adaptive stepping is selected with `dt="auto"`
or with an explicit `AdaptiveTimestep`; executable adaptive stages require an explicit positive
`dt_min` and `dt_max`. `dt="auto"`, `max_err`, and `max_error` reject fixed-only integrators.
`coupled_imex_ark2` is not a fourth relaxation algorithm: ProblemIR rejects it for a plain
relaxation problem unless the transient spin-transport contract is also present.

For an embedded method the implementation first forms a vector error at every active magnetic
cell/node. If $k_{s,i}$ is the stage right-hand side at point $i$ and $b_s^{\mathrm{hi}}$ and
$b_s^{\mathrm{lo}}$ are the two tableau weights, the error vector and its mixed tolerance scale
are

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

$\mathcal A$ is the active magnetic-node/cell mask; air or inactive FEM nodes do not enter the
maximum. A trial is accepted exactly when $\rho\leq1$. When `rtol=0`, the scale is the absolute
`atol` value. The optional `norm_tolerance` and `max_spin_rotation` guards are folded into the
same acceptance metric by taking the maximum of their normalized defects. Non-finite vectors,
non-positive scales, zero active norms, or a non-finite combined metric fail closed.

The native FEM CPU/GPU and FDM CUDA controllers use the following shared scalar proposal. Let
$\rho_{k-1}$ be the previous accepted non-zero error ratio, when history exists, and let
$p$ be the embedded error-estimate order. The unclamped factor is

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
\Delta t_{k+1}&=\operatorname{clip}_{[\Delta t_{\min},\Delta t_{\max}]}
\left(\Delta t_k\widehat q_k\right).
\end{aligned}
```

Here $s$ is `safety`, $q_{\min}$ is `shrink_limit`, and $q_{\max}$ is `growth_limit`. A rejected
trial is restored and retried with the smaller proposal; it does not update accepted-state stop
history or previous-error history. If the error is still above one at `dt_min`, the attempt fails
with `dt_min_exhausted`. Native FEM receives a rejection budget of 50 from the runner; FDM lanes
use the shared typed `dt_min_exhausted` decision and do not expose a separate public rejection
counter. The older Rust FEM reference engine has an internal 128-attempt guard and is documented
as a reference path, not as the native FEM contract.

The Rust helper `pi_controller_dt` is a stateless reference helper: it evaluates only the
single-history-free branch. It is not a substitute for the native controller above. FDM CPU's
engine implementation and native FEM/CUDA both retain the previous accepted error and use the
history branch when available. FDM CPU's absolute-only mode compares the unscaled norm directly
with `max_error`; its mixed mode uses the normalized $\rho$ definition above. The vector norm and
reduction are lane-specific, but the resolved tolerance, controller branch, attempted/accepted
steps, and actual backend/device must be recorded together.

For the public stage builder, `solver=None` resolves to `rk23`; `solver="auto"` has the same
resolution. An executable adaptive stage must provide an explicit `dt_min` and `dt_max`. The
deprecated `max_error` spelling is accepted only as an alias for `max_err`, and neither may be
combined with `adaptive_timestep` or fixed `dt` controls.

(numerical-methods-relaxation-llg-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf m$ | reduced magnetization | $1$ |
| $\mathbf M$ | dimensional magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{eff}}$ | total effective magnetic field | $\mathrm{A\,m^{-1}}$ |
| $E$ | total micromagnetic energy | $\mathrm{J}$ |
| $\gamma_0$ | Fullmag reduced gyromagnetic ratio | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $\alpha$ | Gilbert damping parameter | $1$ |
| $t$ | relaxation integration coordinate | $\mathrm{s}$ |
| $\tau_{\max}$ | maximum accepted-state torque | $\mathrm{A\,m^{-1}}$ |
| $\boldsymbol\tau_i$ | local effective-field torque residual | $\mathrm{A\,m^{-1}}$ |
| $\varepsilon_\tau$ | canonical torque stopping threshold | $\mathrm{A\,m^{-1}}$; a public `tolT` request is converted from tesla |
| $\Delta t$ | attempted integration step | $\mathrm{s}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\Delta t_k$ | attempted or proposed adaptive integration step | $\mathrm{s}$ |
| $s$ | adaptive controller safety factor | $1$ |
| $\rho_k$ | normalized local-error ratio | $1$ |
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
| $\rho_{k-1}$ | previous accepted non-zero error ratio | $1$ |
| $q_k$ | raw adaptive step-size factor | $1$ |
| $\widehat q_k$ | clamped adaptive step-size factor | $1$ |

The reduced gyromagnetic ratio is `gamma` in the Python `LLG` object. The damping coefficient in
the equation is the resolved stage-local `relax_alpha` when supplied; otherwise the material
damping is used. The stage default is `relax_alpha=1.0`, which is a numerical pure-damping
choice, not a claim that the material's physical $\alpha$ has changed globally.

(numerical-methods-relaxation-llg-assumptions-and-validity)=
## Assumptions and validity

- The stage is deterministic and has no thermal noise unless another explicitly supported
  interaction changes the model.
- `llg_overdamped` disables only precession; it does not remove the effective-field terms.
- A fixed step is not unconditionally stable. An adaptive error pass is not a proof of physical
  convergence, so both adaptive acceptance and the torque stop contract are recorded.
- `tolT` and `tolA` are mutually exclusive. `tolT` is the public default in tesla and is converted
  to the canonical field residual in A/m using $\tau_{\mathrm{A/m}}=\tau_{\mathrm T}/\mu_0$.
- A failed step, exhausted adaptive floor, invalid field solve, or non-finite state is a failure;
  it must not be published as a converged relaxation.

(numerical-methods-relaxation-llg-iteration)=
## One accepted LLG relaxation step

For each attempt the backend follows this ownership sequence:

1. Read the current normalized magnetization and assemble the complete effective field from the
   interaction list. Relaxation does not remove demagnetization, exchange, anisotropy, DMI or
   applied-field terms.
2. Evaluate the pure-damping right-hand side. The precession term is disabled by the resolved
   relaxation mode; `relax_alpha` is a stage-local damping coefficient and does not mutate the
   material model stored for later stages.
3. Execute the selected tableau (Heun, RK4, RK23, RK45 or ABM3). For RK23/RK45, compare the
   embedded estimates, reject and retry when the normalized error exceeds one, and clamp the next
   step to `dt_min`/`dt_max`. For ABM3, retain the required history and use the FDM/reference path;
   native FEM GPU fails closed before dispatch.
4. Normalize the committed spin state, refresh the field required by the resolved field policy,
   and publish accepted-step observables. Only now are the torque confirmation counter, energy
   plateau and `max_steps`/time budgets advanced.

The adaptive error test controls local integration error. It cannot certify an equilibrium: the
accepted state must still pass the independent torque and optional energy criteria in
`stopping-criteria.md`.

(numerical-methods-relaxation-llg-python-api)=
## Python API

This is the repository-owned stage pattern. The `solver`, timestep and adaptive controls below
belong only to `llg_overdamped`. The direct minimizers do not accept an LLG dynamics object or
these timestep controls; they select their line-search policy internally.

```python
# %% Configure a FEM relaxation scenario
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
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
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

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `StudyStagesBuilder.add_relax(algorithm=...)` | `str` | `"llg_overdamped"` | $1$ | one supported algorithm identifier | selects relaxation realization | FEM/FDM; planner decides lane | `study.algorithm` |
| `StudyStagesBuilder.add_relax(solver=...)` | `str \| None` | `None` → `rk23` | $1$ | `heun`, `rk4`, `rk23`, `rk45`, `abm3`; `bs23`/`dp54` aliases; `coupled_imex_ark2` only with transient spin transport | selects LLG integrator | lane-dependent; native FEM GPU rejects `abm3` | `study.dynamics.integrator` |
| `StudyStagesBuilder.add_relax(dt_initial=...)` | `float \| None` | `None` | $\mathrm{s}$ | positive; requires `max_err`, `dt_min`, `dt_max` in executable adaptive stage | first adaptive step | RK23/RK45 lanes | `study.dynamics.adaptive_timestep.dt_initial` |
| `StudyStagesBuilder.add_relax(dt_min=...)` | `float \| None` | required for executable adaptive stage | $\mathrm{s}$ | positive and not fixed-step | adaptive lower bound | RK23/RK45 lanes | `study.dynamics.adaptive_timestep.dt_min` |
| `StudyStagesBuilder.add_relax(dt_max=...)` | `float \| None` | required for executable adaptive stage | $\mathrm{s}$ | positive and above `dt_min` | adaptive upper bound | RK23/RK45 lanes | `study.dynamics.adaptive_timestep.dt_max` |
| `StudyStagesBuilder.add_relax(max_err=...)` | `float \| None` | `None` | $1$ | positive; adaptive RK only | absolute embedded vector-error limit | RK23/RK45 lanes | `study.dynamics.adaptive_timestep.atol` with max-error intent preserved |
| `StudyStagesBuilder.add_relax(tolT=...)` | `float` | $10^{-6}$ | $\mathrm{T}$ | finite and positive; mutually exclusive with `tolA` | user torque threshold | FEM/FDM relaxation lanes | `study.stop.torque_tolerance_apm` after conversion |
| `StudyStagesBuilder.add_relax(tolA=...)` | `float` | canonical default equivalent | $\mathrm{A\,m^{-1}}$ | finite and positive; mutually exclusive with `tolT` | field-residual threshold | FEM/FDM relaxation lanes | `study.stop.torque_tolerance_apm` |
| `StudyStagesBuilder.add_relax(max_steps=...)` | `int` | $50,000$ | $1$ | positive integer | hard iteration budget | FEM/FDM relaxation lanes | `study.stop.max_steps` |
| `StudyStagesBuilder.add_relax(relax_alpha=...)` | `float \| None` | $1$ for overdamped LLG | $1$ | only `llg_overdamped`; `None` keeps material damping | stage-local damping override | FEM/FDM LLG relaxation | resolved LLG/material provenance |
| `StudyStagesBuilder.add_relax(tol=...)` | legacy object | unavailable | legacy | always rejected | removed tolerance spelling; use `tolT` or `tolA` | none | none |
| `StudyStagesBuilder.add_relax(energy_tolerance=...)` | `float \| None` | `None` | $\mathrm{J}$ | positive when set | 50-accepted-energy plateau threshold | FEM/FDM lanes | `study.stop.energy_tolerance_j` |
| `StudyStagesBuilder.add_relax(max_relaxation_time_s=...)` | `float \| None` | `None` | $\mathrm{s}$ | positive; LLG only | relaxation-coordinate ceiling | `llg_overdamped` only | `study.stop.max_relaxation_time_s` |
| `StudyStagesBuilder.add_relax(max_pseudotime_s=...)` | `float \| None` | `None` | $\mathrm{s}$ | alias; must agree with other time names | same LLG ceiling | `llg_overdamped` only | canonical relaxation time |
| `StudyStagesBuilder.add_relax(max_physical_time_s=...)` | `float \| None` | `None` | $\mathrm{s}$ | alias; must agree with other time names | same LLG ceiling; not a physical experiment clock | `llg_overdamped` only | canonical relaxation time |
| `StudyStagesBuilder.add_relax(dt=...)` | positive float, `"auto"`, or `None` | `None` | $\mathrm{s}$ | fixed step or `"auto"`; cannot mix with adaptive fields | fixed or automatic step mode | RK23/RK45 for auto; backend may support fixed RK | `dynamics.fixed_timestep` / resolved policy |
| `StudyStagesBuilder.add_relax(max_error=...)` | `float \| None` | `None` | $1$ | positive; deprecated alias for `max_err`; adaptive only | absolute embedded error bound | RK23/RK45 | adaptive `atol`, mode `max_error` |
| `StudyStagesBuilder.add_relax(max_err=...)` | `float \| None` | `None` | $1$ | positive; adaptive only | absolute embedded error bound | RK23/RK45 | adaptive `atol`, mode `max_error` |
| `StudyStagesBuilder.add_relax(adaptive_timestep=...)` | `AdaptiveTimestep \| None` | `None` | mixed | only `rk23`/`rk45` for standalone relaxation; explicit `dt_min` and `dt_max` required by executable stages | full adaptive policy | FEM/FDM lane-dependent | `dynamics.adaptive_timestep` |
| `StudyStagesBuilder.add_relax(field_refresh=...)` | `FieldRefreshPolicy \| None` | `None` | mixed | positive cadence fields | expensive-field refresh cadence | backend-dependent | `dynamics.field_refresh` |
| `StudyStagesBuilder.add_relax(stop=...)` | `RelaxStop \| None` | `None` | mixed | grouped stop; scalar aliases cannot conflict | canonical stopping object | FEM/FDM lanes | `study.stop` |

`AdaptiveTimestep` itself has the complete fields `atol`, `rtol`, `dt_initial`, `dt_min`, `dt_max`,
`safety`, `growth_limit`, `shrink_limit`, `max_spin_rotation`, and `norm_tolerance`. `atol` and
`rtol` are dimensionless normalized-state error limits; `dt_*` are seconds; safety and growth or
shrink limits are dimensionless; optional spin-rotation and norm limits are positive dimensionless
guards. `dt_max` may not be below `dt_min`, and `dt_initial` must lie in the interval when set.
`FieldRefreshPolicy.demag_interval_s` is a positive seconds cadence. These fields are not accepted
by direct minimizer algorithms.

### `fm.LLG`, `fm.AdaptiveTimestep`, and `fm.FieldRefreshPolicy`

The stage convenience keywords lower into these exported objects. The objects can also be
constructed directly for inspection or for a `Relaxation` model; they do not bypass stage or
ProblemIR validation.

| Object field | Type | Default | Unit | Contract |
|---|---|---:|---|---|
| `fm.LLG.gamma` | `float` | `2.211e5` | $\mathrm{m\,A^{-1}\,s^{-1}}$ | positive reduced gyromagnetic ratio |
| `fm.LLG.integrator` | `str` | `"auto"` | $1$ | canonical integrator name; `dp54`/`bs23` are normalized |
| `fm.LLG.fixed_timestep` | `float \| None` | `None` | $\mathrm{s}$ | positive fixed step; mutually exclusive with adaptive policy |
| `fm.LLG.adaptive_timestep` | `AdaptiveTimestep \| None` | `None` | mixed | only adaptive-capable integrators; mutually exclusive with fixed step |
| `fm.LLG.field_refresh` | `FieldRefreshPolicy \| None` | `None` | mixed | optional expensive-field cadence |
| `fm.AdaptiveTimestep.atol` | `float` | `1e-6` | $1$ | non-negative absolute error scale |
| `fm.AdaptiveTimestep.rtol` | `float` | `1e-3` | $1$ | non-negative relative error scale; not both zero with `atol` |
| `fm.AdaptiveTimestep.dt_initial` | `float \| None` | `None` | $\mathrm{s}$ | positive and inside `[dt_min,dt_max]` |
| `fm.AdaptiveTimestep.dt_min` | `float` | `1e-15` | $\mathrm{s}$ | positive lower bound; explicit for executable stages |
| `fm.AdaptiveTimestep.dt_max` | `float \| None` | `None` | $\mathrm{s}$ | positive upper bound; explicit for executable stages |
| `fm.AdaptiveTimestep.safety` | `float` | `0.9` | $1$ | in `(0,1]` |
| `fm.AdaptiveTimestep.growth_limit` | `float` | `2.0` | $1$ | strictly greater than one |
| `fm.AdaptiveTimestep.shrink_limit` | `float` | `0.2` | $1$ | in `(0,1)` |
| `fm.AdaptiveTimestep.max_spin_rotation` | `float \| None` | `None` | $1$ | optional positive rotation guard |
| `fm.AdaptiveTimestep.norm_tolerance` | `float \| None` | `None` | $1$ | optional positive norm guard |
| `fm.FieldRefreshPolicy.demag_interval_s` | `float \| None` | `None` | $\mathrm{s}$ | positive cadence when supplied |

The convenience `max_err`/`max_error` form creates an `AdaptiveTimestep` with `atol=max_err`,
`rtol=0`, and `tolerance_mode="max_error"`. It is not interchangeable with an advanced relative
policy. The serialized `tolerance_mode` preserves this distinction.

(numerical-methods-relaxation-llg-problem-ir)=
## ProblemIR

The stage request lowers to the existing relaxation payload. The numeric values below are
representative of the example and show the destination, not a hand-written substitute for the
serializer:

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

`tolT` is retained as requested intent and normalized to `torque_tolerance_apm` for execution.
The canonical `RelaxStop` payload also carries `energy_tolerance_j`, `max_steps`, and, only for
this algorithm, `max_relaxation_time_s`.
The resolved execution record additionally identifies FEM/FDM, CPU/GPU, precision, selected
integrator, adaptive policy, and actual device. The serialized request alone is not runtime proof.

(numerical-methods-relaxation-llg-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

The script exporter emits the stage-first `study.stages.add_relax(...)` call and preserves the
algorithm, integrator, stopping policy, and requested backend. Validation errors include unknown
integrators, non-positive timestep bounds, mixed fixed/adaptive controls, missing adaptive bounds,
both `tolT` and `tolA`, legacy `tol`, and LLG-only controls used with a direct minimizer.
Unsupported combinations are rejected by the planner; there is no silent fallback to `rk23`, CPU, or a different
algorithm after an explicit request. Requested intent, resolved execution, and provenance are three
different records.

(numerical-methods-relaxation-llg-discrete-realization)=
## Discrete realization

| Solver | Device | Status | Realization and evidence boundary |
|---|---|---|---|
| FDM | CPU | source-backed | reference grid runner and LLG relaxation path; numerical qualification is separate |
| FDM | GPU | source-backed | CUDA execution path carries pure-damping selection; device tests are conditional |
| FEM | CPU | source-backed | MFEM/native LLG relaxation lane; managed runtime evidence required for qualification |
| FEM | GPU | source-backed | native CUDA/MFEM lane; source presence and compilation do not prove executed-device parity |

FDM uses grid-local field evaluation. FEM uses the assembled finite-element field and the native
MFEM/CUDA operator path. The equation and stop metric are shared; interpolation, mass weighting,
field-solve refresh, precision, and runtime ownership are not.

The FDM CPU/reference lane evaluates the effective field on the Cartesian grid and advances the
same damping-only RHS through its grid integrator. The FDM CUDA lane keeps the state and field
updates in CUDA-owned buffers when the selected plan permits it. FEM CPU assembles/evaluates the
MFEM field on the magnetic-node space; FEM GPU uses the native device operator and records device
residency. None of these descriptions is a claim that all four lanes have identical tolerances,
reductions, or runtime qualification.

(numerical-methods-relaxation-llg-implementation-mapping)=
## Implementation mapping

The Python stage builder calls `relax_stage`; the public `Relaxation` and `RelaxStop` objects
validate and serialize the shared contract. Backend runners resolve pure damping through the
relaxation convergence module and use their own time-step and field-evaluation realizations.

(numerical-methods-relaxation-llg-validation)=
## Validation

Required evidence is split into four gates: equation/sign and unit tests; stage-to-IR round-trip;
algorithmic convergence and energy/torque metrics; and executed backend/device qualification. A
passing Python capture proves authoring and lowering only. It does not prove an FEM solve, GPU
execution, or parity.

(numerical-methods-relaxation-llg-limitations)=
## Limitations

This page does not claim a physical switching time, unconditional stability, universal GPU parity,
or convergence to a global minimum. The result may be a metastable equilibrium. Direct minimizers
and their line-search contracts are described separately.

(numerical-methods-relaxation-llg-scientific-bibliography)=
## Scientific bibliography

- W. F. Brown, Jr., *Micromagnetics*, Wiley, 1963.
- T. L. Gilbert, “A phenomenological theory of damping in ferromagnetic materials,” IEEE Transactions on Magnetics 40 (2004), DOI: [10.1109/TMAG.2004.836740](https://doi.org/10.1109/TMAG.2004.836740).
- Fullmag canonical contracts: [`0500-fdm-relaxation-algorithms.md`](https://github.com/MateuszZelent/fullmag/blob/master/docs/physics/0500-fdm-relaxation-algorithms.md), [`0510-fem-relaxation-algorithms-mfem-gpu.md`](https://github.com/MateuszZelent/fullmag/blob/master/docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md), [`0580-canonical-relaxation-equilibrium-contract.md`](https://github.com/MateuszZelent/fullmag/blob/master/docs/physics/0580-canonical-relaxation-equilibrium-contract.md).

(numerical-methods-relaxation-llg-source-code-index)=

## Control Room crosswalk

Use `Model Explorer -> Stages -> Add stage -> <stage kind>` for stage-level controls when the terminal page identifies a matching field. The current editor is partial: only fields surfaced by the stage draft are authorable. TODO: frontend support applies to numerical parameters without a matching control. Do not infer frontend support from Python or backend availability. See {doc}/frontend/capability-register for the current register and exact source owner.

## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Stop defaults and validation | `packages/fullmag-py/src/fullmag/model/study.py` | `class RelaxStop` | canonical torque/energy/step stop contract | public API | Python contract tests |
| Algorithm and IR validation | `packages/fullmag-py/src/fullmag/model/study.py` | `class Relaxation` | supported algorithms and serialized relaxation payload | public API | Python contract tests |
| Stage lowering | `packages/fullmag-py/src/fullmag/world.py` | `relax_stage` | maps stage arguments into `RelaxStageSpec` | public API | stage export tests |
| LLG object and adaptive policy | `packages/fullmag-py/src/fullmag/model/dynamics.py` | `class LLG` / `class AdaptiveTimestep` / `class FieldRefreshPolicy` | validates integrator names, aliases, timestep bounds and serialized dynamics | public API | Python dynamics contract tests |
| Adaptive FEM controller | `crates/fullmag-runner/src/fem/integrators/adaptive.rs` | `step_accepted` / `pi_controller_dt` | embedded-error acceptance and bounded next-step proposal | FEM CPU/GPU | integrator unit tests |
| Fixed FEM controller | `crates/fullmag-runner/src/fem/integrators/fixed.rs` | `validate_fixed_dt` | fixed-step Heun/RK4 validation | FEM CPU/GPU | integrator unit tests |
| Native FEM adaptive error norm | `backends/fem/cpu/mfem/integrators/adaptive_dt.cpp` | `compute_adaptive_error_norm` | active-node mixed atol/rtol norm and fail-closed guards | FEM CPU | native FEM contract tests |
| Native FEM adaptive controller | `backends/fem/cpu/mfem/integrators/adaptive_dt.cpp` | `adaptive_pi_step` | shared history-aware PI decision and rejection accounting | FEM CPU | native FEM adaptive tests |
| Native FEM GPU adaptive error norm | `backends/fem/gpu/cuda/integrators/rk/adaptive_error_kernels.cu` | `adaptive_error_norm_blocks_kernel` | device reduction of the same active-node error metric | FEM GPU | CUDA contract tests |
| Native FEM GPU adaptive controller | `backends/fem/gpu/cuda/integrators/rk/rk_adaptive_runtime.cu` | `gpu_rk_adaptive_pi_step` | device-lane decision and previous-error history | FEM GPU | CUDA contract tests |
| FDM adaptive scalar policy | `native/include/fullmag_adaptive_step_decision.hpp` | `decide` / `decide_adaptive_step` | shared history-aware accept/retry/dt-min decision | FDM CPU/GPU | FDM policy contract tests |
| FDM adaptive error norm | `crates/fullmag-engine/src/fdm/cpu/integrators.rs` | `max_error_norm_buf` / `max_error_norm_soa_buf` | AoS/SoA active-cell error norm, absolute or mixed mode | FDM CPU | engine integrator tests |
| FDM GPU adaptive error reduction | `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu` | `decide_adaptive_step` call site | CUDA reduction and typed dt-min failure | FDM GPU | CUDA policy contract tests |
| Rust FEM reference adaptive loop | `crates/fullmag-engine/src/fem.rs` | `rk23_step_ws` / `rk45_step_ws` | legacy absolute `max_error` loop with 128-attempt guard | FEM reference | engine tests |
| Native FDM integrator dispatch | `crates/fullmag-runner/src/fdm/gpu/cuda/native/construction.rs` | `build_native_fdm_plan` | maps canonical integrator to CUDA ABI | FDM GPU | device-gated tests |
| FDM direct minimizer reference | `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs` | `execute_projected_gradient_bb` | FDM reference BB relaxation | FDM CPU/reference | Rust unit tests |
| FDM direct minimizer reference | `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs` | `execute_nonlinear_cg` | FDM reference NCG relaxation | FDM CPU/reference | Rust unit tests |
| Shared pure-damping predicate | `crates/fullmag-runner/src/relaxation/convergence.rs` | `llg_overdamped_uses_pure_damping` | selects precession-disabled relaxation mode | FEM/FDM orchestration | runner tests |
| Accepted-state convergence | `crates/fullmag-runner/src/relaxation/convergence.rs` | `relaxation_converged` / `relaxation_stop_criteria_satisfied` | torque/energy conjunction | shared orchestration | runner tests |
| Torque confirmation | `crates/fullmag-runner/src/relaxation/convergence.rs` | `RelaxationTorqueConfirmation::observe` | requires at least three consecutive accepted samples satisfying the combined predicate | shared orchestration | runner tests |
| FEM LLG execution | `crates/fullmag-runner/src/fem/relax/llg_overdamped.rs` | `execute_llg_overdamped` | native FEM loop, integrator and completion metrics | FEM CPU/GPU | native runtime tests |
| FEM LLG policy | `crates/fullmag-runner/src/fem/relax/llg_overdamped.rs` | `convergence_controller_policy` / `fill_provenance` | records resolved controller and integrator | FEM | provenance tests |
| FDM CPU/reference LLG | `crates/fullmag-runner/src/fdm/cpu/reference.rs` | `execute_reference_fdm_with_coupled_checkpoint` | Cartesian reference relaxation dispatch | FDM CPU | runner tests |
