---
title: Time Integration
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: explicit-runge-kutta, adaptive-stepping, tangent-plane-methods, their source maps, and source revision 88c7160080bc1e8519950df283d2dd02087cc3da
---

(public-docs-numerical-methods-time-integration-root)=
# Time integration

:::{admonition} Physical time versus relaxation
:class: important

A physical-time stage advances the semi-discrete Landau--Lifshitz--Gilbert equation. A relaxation
stage may reuse an LLG integrator, but its damping override, stopping contract, and interpretation
of time are different. Direct minimizers do not have a physical-time coordinate at all.
:::

## Numerical problem

After FDM or FEM spatial discretization, Fullmag exposes a state vector $y(t)$ and a right-hand side
$F(y,t)$. For reduced magnetization,

```{math}
:label: eq-time-root-llg
\frac{\mathrm d\mathbf m}{\mathrm dt}
=F(\mathbf m,t)
=-\frac{\gamma}{1+\alpha^2}
\left[
\mathbf m\times\mathbf H_{\mathrm{eff}}
+\alpha\,\mathbf m\times
\left(\mathbf m\times\mathbf H_{\mathrm{eff}}\right)
\right]
+\boldsymbol\tau_{\mathrm{nc}}.
```

The spatial backend owns $\mathbf H_{\mathrm{eff}}$ and any enabled torque. The temporal method owns
stage construction, field refreshes, acceptance/rejection, time advancement, and endpoint
publication. It must not change interaction signs, SI units, material coefficients, or boundary
conditions.

The exact continuum equation and conventions are documented under
{doc}`../../physics/foundations/llg-equation`. This section documents only the numerical temporal
realization.

## Required invariants and diagnostics

A correct time integrator must preserve the following execution semantics even when floating-point
trajectories differ between lanes:

- only accepted steps advance physical time and accepted-step counters;
- rejected adaptive trials do not publish outputs or continuation artifacts;
- requested output times are reached according to the documented endpoint/interpolation policy;
- non-finite stage states, fields, errors, or norms terminate with an explicit failure reason;
- the resolved integrator, step policy, field-refresh count, precision, and device are recorded;
- magnetization-norm drift is measured and controlled by an explicit backend policy rather than
  hidden state mutation.

The unit-length constraint is geometric. For the exact LLG flow,
$\mathbf m\cdot\dot{\mathbf m}=0$. Generic explicit Runge--Kutta stage states do not preserve this
identity exactly, so endpoint normalization and norm diagnostics, where present, are numerical
policies that must be reported.

## Public method vocabulary

| Canonical name | Method family | Step policy | Main use | Current realization boundary |
|---|---|---|---|---|
| `heun` | explicit RK2 / improved Euler | fixed | inexpensive reference and small stable steps | FDM/FEM CPU/GPU subject to lane qualification |
| `rk4` | classical explicit RK4 | fixed | accurate fixed-step transients | FDM/FEM CPU/GPU subject to lane qualification |
| `rk23` | Bogacki--Shampine 3(2) | fixed or adaptive | lower-cost adaptive integration | FDM/FEM CPU/GPU; alias `bs23` normalizes to `rk23` |
| `rk45` | Dormand--Prince 5(4) | fixed or adaptive | higher-order adaptive integration | FDM/FEM CPU/GPU; alias `dp54` normalizes to `rk45` |
| `abm3` | Adams--Bashforth--Moulton predictor/corrector | fixed multistep | history-based stepping | FDM and reference FEM paths; native FEM GPU rejects it |
| `tangent_plane_implicit` | linearly implicit tangent-plane family | implicit/FEM policy | constrained stiff integration/development relaxation | FEM contract; no FDM realization is claimed |
| `coupled_imex_ark2` | coupled implicit--explicit transport integrator | adaptive coupled solve | transient spin-transport coupling | valid only with the required transient transport module; not a plain LLG choice |
| `auto` | planner request | resolved | lets the planner choose a legal method | provenance must record the resolved canonical name |

A method name shared by CPU and GPU means the same Butcher tableau and acceptance semantics, not
bit-identical stage values. Field evaluation order, reduction order, fused kernels, host/device
ownership, and precision can change the last bits and eventually the trajectory of a nonlinear
system.

### Fixed-step ABM3 boundary

The public `abm3` contract is constant-step only. It uses two Heun startup steps, then the classical
AB3 predictor and AM3 corrector. After correction, the history stores the RHS evaluated at the
accepted corrected endpoint, never the predictor RHS. A timestep or solver-revision change clears
the multistep history and repeats startup; adaptive ABM3 is rejected rather than approximated with
constant-step coefficients.

The qualified reference scope is FDM CPU double precision with fixed `dt`. Brown thermal noise,
Frozen Spins, regional discontinuous field drives, staged multilayer execution, and unqualified
GPU/FEM combinations fail capability planning without integrator fallback. Accepted steps expose
versioned `solver.abm3` telemetry: startup/reset state, cumulative reset count, and RHS evaluation
count. Runs emit `solver/fdm_cpu_abm3_checkpoint.v1.json`; resume validates its schema, exact plan
identity, timestep policy, accepted state, RHS history and history timestamps before mutation.

## Explicit Runge--Kutta formulation

For an $s$-stage explicit method,

```{math}
:label: eq-time-root-rk-stage
Y_j=y_n+\Delta t\sum_{\ell=1}^{j-1}a_{j\ell}K_\ell,
\qquad
K_j=F(Y_j,t_n+c_j\Delta t),
```

and the accepted candidate is

```{math}
:label: eq-time-root-rk-update
y_{n+1}=y_n+\Delta t\sum_{j=1}^{s}b_jK_j.
```

For an embedded pair,

```{math}
:label: eq-time-root-rk-embedded
\widetilde y_{n+1}
=y_n+\Delta t\sum_{j=1}^{s}\widetilde b_jK_j,
\qquad
e_{n+1}=y_{n+1}-\widetilde y_{n+1}.
```

{doc}`explicit-runge-kutta` records the public parameters, exact source owners, lane matrix,
validation requirements, and the distinction between reusable FEM stage workspaces and FDM
structured-grid kernels.

## Adaptive acceptance and controller

For active point $i$, Fullmag's documented normalized error is

```{math}
:label: eq-time-root-adaptive-error
\eta_i=
\frac{\lVert e_i\rVert_2}
{a_{\mathrm{tol}}+r_{\mathrm{tol}}\max(\lVert m_i\rVert_2,1)},
\qquad
\eta=\max_i\eta_i.
```

The trial is accepted exactly when $\eta\leq1$. For estimator order $q$, the proposed next step is

```{math}
:label: eq-time-root-adaptive-controller
\Delta t_{\mathrm{new}}
=s\,\Delta t\,\eta^{-1/q},
\qquad
\rho_{\mathrm{shrink}}\Delta t
\leq\Delta t_{\mathrm{new}}
\leq\rho_{\mathrm{growth}}\Delta t,
```

followed by the absolute `dt_min` and optional `dt_max` bounds. The public defaults are
$a_{\mathrm{tol}}=10^{-6}$, $r_{\mathrm{tol}}=10^{-3}$,
$\Delta t_{\min}=10^{-15}\,\mathrm s$, safety $s=0.9$, growth limit $2.0$, and shrink limit
$0.2$. Hitting `dt_min` while $\eta>1$ is a controlled failure, not permission to accept an
inaccurate step.

Adaptive control estimates temporal local error for the **current** spatial discretization. It does
not estimate mesh error, demagnetization truncation, linear-solver error, material uncertainty, or
model-form error. See {doc}`adaptive-stepping`.

## Stiffness and step selection

The fastest resolved exchange modes usually grow as the inverse square of the smallest spatial
length. Consequently, explicit stability can become more restrictive approximately as

```{math}
:label: eq-time-root-exchange-scaling
\Delta t_{\mathrm{stable}}\propto
\frac{\mu_0M_s}{\gamma A}\,h_{\min}^{2},
```

up to stencil, damping, geometry, and method-dependent constants. This relation is a scaling guide,
not a Fullmag acceptance formula. A smaller mesh can therefore require both more spatial degrees of
freedom and more time steps.

Practical convergence requires two independent studies:

1. reduce the accepted time-step scale or tighten adaptive tolerances at fixed mesh;
2. refine the spatial discretization at a temporally converged setting.

Agreement under only one of these studies is insufficient.

## Tangent-plane methods

At a normalized state $\boldsymbol\mu_i$, the tangent projector is

```{math}
:label: eq-time-root-tangent-projector
P_i=I-\boldsymbol\mu_i\boldsymbol\mu_i^{\mathsf T},
\qquad
\mathbf H_i^{\perp}=P_i\mathbf H_{\mathrm{eff},i}.
```

A tangent-plane method solves for an increment in the plane orthogonal to
$\boldsymbol\mu_i$ and retracts or normalizes the updated state. This avoids treating the
unit-length constraint as three independent unconstrained scalar equations. Fullmag's public
`tangent_plane_implicit` vocabulary is FEM-only in the current contract. Its source-visible
presence must not be interpreted as FDM or universally qualified GPU support. See
{doc}`tangent-plane-methods`.

## Public Python contract

The normal authoring path configures the solver once and appends a physical-time stage:

```python
# %% Adaptive RK45 physical-time integration
import fullmag as fm

nm = 1.0e-9
study = fm.study("adaptive_time_integration")
study.engine("fdm")
study.device("gpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))

film = study.geometry(fm.Box(100 * nm, 30 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.demag()

study.solver(
    integrator="rk45",
    gamma=2.211e5,
    adaptive_timestep=fm.AdaptiveTimestep(
        atol=1.0e-7,
        rtol=1.0e-3,
        dt_initial=1.0e-14,
        dt_min=1.0e-15,
        dt_max=1.0e-12,
    ),
)
study.stages.add_run(stage_id="transient", until=2.0e-9)
```

Important public parameters are:

| Python field | Default | SI unit | Contract |
|---|---:|---:|---|
| `LLG.gamma` | `2.211e5` | $\mathrm{m\,A^{-1}\,s^{-1}}$ | finite and positive; serialized as the gyromagnetic ratio |
| `LLG.integrator` | `auto` | $1$ | canonical method or accepted alias; unsupported lane combinations fail |
| `LLG.fixed_timestep` | `None` | $\mathrm{s}$ | finite and positive; mutually constrained with adaptive policy |
| `AdaptiveTimestep.atol` | `1e-6` | $1$ | nonnegative; not simultaneously zero with `rtol` |
| `AdaptiveTimestep.rtol` | `1e-3` | $1$ | nonnegative; not simultaneously zero with `atol` |
| `AdaptiveTimestep.dt_initial` | `None` | $\mathrm{s}$ | positive and inside configured bounds when present |
| `AdaptiveTimestep.dt_min` | `1e-15` | $\mathrm{s}$ | strict positive lower bound |
| `AdaptiveTimestep.dt_max` | `None` | $\mathrm{s}$ | optional positive upper bound not below `dt_min` |
| `AdaptiveTimestep.safety` | `0.9` | $1$ | controller factor in $(0,1]$ |
| `AdaptiveTimestep.growth_limit` | `2.0` | $1$ | greater than one |
| `AdaptiveTimestep.shrink_limit` | `0.2` | $1$ | in $(0,1)$ |

The terminal pages own the exact `ProblemIR` paths and compatibility rules. In particular, a fixed
step and an incompatible adaptive object are rejected rather than silently reconciled.

## Realization matrix

| Lane | State/RHS ownership | Adaptive reduction | Qualification statement |
|---|---|---|---|
| FDM CPU | host structured-grid state and reference field path | host maximum over active cells | documented reference path |
| FDM GPU | device arrays, CUDA interaction kernels, device reductions | `reduce_adaptive_error_policy` produces the scalar decision input | source-backed; actual device execution requires provenance |
| FEM CPU | MFEM vectors, reusable RK stage workspace, native field assembly | host/native FEM stage policy | documented source contract |
| FEM GPU | device-resident/native GPU workspaces where supported | lane-specific device reduction | source-backed; not every method, interaction, or dependency is universally qualified |

`abm3`, tangent-plane, coupled spin-transport, mixed precision, multilayer FDM, and interaction-
specific GPU restrictions are capability dimensions. The planner must reject an illegal product of
these dimensions instead of falling back to a different algorithm.

## Implementation mapping

| Responsibility | Repository path | Stable symbol | Lane |
|---|---|---|---|
| Public LLG method and aliases | `packages/fullmag-py/src/fullmag/model/dynamics.py` | `class LLG` | Python/IR |
| Adaptive controller validation | `packages/fullmag-py/src/fullmag/model/dynamics.py` | `class AdaptiveTimestep` | Python/IR |
| Solver-policy authoring | `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` | Python/stage workflow |
| FEM RK stage RHS | `backends/fem/cpu/mfem/integrators/rk_stage_rhs.cpp` | `evaluate_rk_stage_rhs` | FEM CPU |
| FEM accepted explicit step | `backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp` | `context_step_explicit_rk_mfem` | FEM CPU |
| FEM RK workspace | `backends/fem/cpu/mfem/integrators/rk_explicit.cpp` | `stepper_workspace_allocate` | FEM CPU |
| FDM GPU normalized-error reduction | `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu` | `reduce_adaptive_error_policy` | FDM GPU FP64 |
| FDM GPU scalar maximum support | `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu` | `reduce_max_scalar_sqrt` | FDM GPU FP64 |
| Tangent-plane algorithm vocabulary | `packages/fullmag-py/src/fullmag/model/study.py` | `class Relaxation` | public FEM contract |
| Ordered relaxation capture | `packages/fullmag-py/src/fullmag/world.py` | `relax_stage` | Python/stage workflow |
| FDM CPU ABM3 recurrence | `crates/fullmag-engine/src/fdm/cpu/integrators.rs` | `ExchangeLlgProblem::abm3_step_soa_state_buf` | FDM CPU |
| FDM CPU ABM3 checkpoint | `crates/fullmag-engine/src/fdm/cpu/state.rs` | `FdmCpuSolverCheckpointV1` | FDM CPU |
| FDM CPU ABM3 resume | `crates/fullmag-runner/src/lib.rs` | `resume_reference_fdm_from_abm3_checkpoint` | public runner |

## Validation requirements

### Formal temporal order

Use a smooth problem with a highly accurate reference and compare the state error after a fixed
physical time. Successive step halving should approach the expected order before floating-point or
spatial error dominates. Norm projection, event alignment, and output interpolation must be held
fixed.

### Rejection and rollback

Force at least one rejected adaptive trial and verify that time, outputs, accepted-step counters,
multistep history, random-state counters, and continuation state remain unchanged until a trial is
accepted.

### Physical invariants

Track maximum norm error, energy evolution in an unforced damped problem, and precession frequency
for a macrospin with a known solution. Energy need not decrease under external driving or
nonconservative torque, so the benchmark must match the physical assumptions.

### CPU/GPU parity

Compare accepted-time grids, final state norms, selected observables, field evaluations, and failure
reason with the same mesh, precision, interactions, tolerances, and endpoint policy. Different
reduction order makes bitwise identity an inappropriate universal requirement.

## Limitations

- Explicit methods remain conditionally stable and may be inefficient for exchange-stiff systems.
- Adaptive state error is not a physical observable error estimator.
- `tangent_plane_implicit` is not an FDM method in the current public contract.
- `coupled_imex_ark2` requires the transient spin-transport module and must not be advertised as a
  standalone LLG fallback.
- Source-visible GPU kernels do not establish that a specific run remained device-resident.
- The documentation does not claim symplecticity, exact norm preservation, or unconditional energy
  stability for generic explicit RK trajectories.

## Scientific bibliography

1. J. L. Dormand and P. J. Prince, “A family of embedded Runge--Kutta formulae,” *Journal of
   Computational and Applied Mathematics* **6**, 19--26 (1980),
   [doi:10.1016/0771-050X(80)90013-3](https://doi.org/10.1016/0771-050X(80)90013-3).
2. P. Bogacki and L. F. Shampine, “A 3(2) pair of Runge--Kutta formulas,” *Applied Mathematics
   Letters* **2**, 321--325 (1989),
   [doi:10.1016/0893-9659(89)90079-7](https://doi.org/10.1016/0893-9659(89)90079-7).
3. E. Hairer, S. P. Nørsett, and G. Wanner, *Solving Ordinary Differential Equations I:
   Nonstiff Problems*, 2nd ed., Springer, 1993,
   [doi:10.1007/978-3-540-78862-1](https://doi.org/10.1007/978-3-540-78862-1).
4. S. Bartels and A. Prohl, “Convergence of an implicit finite element method for the
   Landau--Lifshitz--Gilbert equation,” *SIAM Journal on Numerical Analysis* **44**, 1405--1419
   (2006), [doi:10.1137/050631070](https://doi.org/10.1137/050631070).
5. L. Baňas, S. Bartels, and A. Prohl, “A convergent implicit finite element discretization of the
   Maxwell--Landau--Lifshitz--Gilbert equation,” *SIAM Journal on Numerical Analysis* **46**,
   1399--1422 (2008), [doi:10.1137/070683064](https://doi.org/10.1137/070683064).

```{toctree}
:maxdepth: 1

explicit-runge-kutta
adaptive-stepping
tangent-plane-methods
```
## Control Room crosswalk

This is a navigation page; use the terminal page named by the selected stage or solver. The category itself has no standalone editor. TODO: frontend support applies to numerical parameters without a matching control. Do not infer frontend support from Python or backend availability. See {doc}/frontend/capability-register for the current register and exact source owner.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
