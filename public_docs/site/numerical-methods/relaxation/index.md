---
title: Relaxation
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: llg-relaxation, projected-gradient, nonlinear-cg, stopping-criteria
---

(public-docs-numerical-methods-relaxation-root)=
# Relaxation

Relaxation is a zero-temperature constrained minimization stage. It seeks a stationary
magnetization on the product of unit spheres, rather than advancing a physical-time experiment.
The same physical energy and effective-field definitions are used by FDM and FEM; the numerical
realization, field refresh policy, precision, memory ownership, and qualification evidence are
separate.

The stage API exposes three primary executable relaxation algorithms. They are not three names for
one implementation: `llg_overdamped` advances a damping-only LLG equation, while the two direct
minimizers operate on the constrained energy landscape without a physical-time coordinate.

| Algorithm | Numerical role | Time-step controls | Current realization and qualification boundary |
|---|---|---|---|
| `llg_overdamped` | precession-disabled damping descent | fixed or adaptive explicit integrator; optional relaxation-time ceiling | FDM CPU/GPU and FEM CPU/GPU lanes implemented; benefits from FEM FSAL/predictor and short-range kernel fusion |
| `projected_gradient_bb` | tangent projected gradient with alternating BB1/BB2 step selection and Armijo backtracking | no physical or pseudo-time step | FDM CPU/reference, single-layer device-resident CUDA (`native_cuda_pgbb`), bounded multilayer FP64 `three_d` (incl. XY-periodic CUDA), FEM CPU, and FEM GPU with qualified default `bb_exchange_mass` preconditioning |
| `nonlinear_cg` | Polak–Ribière+ tangent-space conjugate minimization with Armijo backtracking and periodic restart | no physical or pseudo-time step | FDM CPU/reference, single-layer FDM CUDA, and native FEM CPU/GPU implementations exist; multilayer FDM rejects `nonlinear_cg` |

`tangent_plane_implicit` is also part of the public algorithm vocabulary and has a native FEM
CPU extended-mode development implementation ({doc}`../time-integration/tangent-plane-methods`); it
is rejected on FDM, forced GPU lanes, and `mode="strict"`.
The planner rejects any unsupported solver/device combination fail-closed instead of silently
replacing the requested algorithm.

For measured RTX 4080 SUPER speedups and A/B parity data for `native_cuda_pgbb` (`5.84×–9.65×` wall
speedup, zero hot-loop H2D/D2H) and FEM GPU `bb_exchange_mass` preconditioning (`6.18×–10.52×` fewer
steps, `2.82×–6.11×` faster), see {ref}`numerical-methods-performance-fdm-core` and
{ref}`numerical-methods-performance-fem-gpu-kernels`.

## LLG integrator vocabulary (only for `llg_overdamped`)

The `solver` keyword selects the integrator used by the damping-only LLG stage. It does not select
one of the three relaxation algorithms. The Python DSL canonicalizes `dp54` to `rk45` and both
`bs23` and `rk32` to `rk23`; the canonical name is written to `ProblemIR` and provenance. `None`
and `"auto"` resolve to `rk23` when the relaxation stage is lowered.

| Canonical name | Family | Step policy | Embedded/error order | FEM CPU | FEM GPU | FDM CPU | FDM GPU |
|---|---|---|---|---|---|---|---|
| `heun` | explicit RK2 | fixed | none | supported | supported | supported | supported |
| `rk4` | explicit RK4 | fixed | none | supported | supported | supported | supported |
| `rk23` (aliases `bs23`, `rk32`) | Bogacki–Shampine | fixed or adaptive | embedded lower-order estimate | supported | supported | supported | supported |
| `rk45` (alias `dp54`) | Dormand–Prince | fixed or adaptive | embedded lower-order estimate | supported | supported | supported | supported |
| `abm3` | Adams–Bashforth–Moulton 3 | fixed multistep | predictor/corrector history | reference path | rejected by native ABI | supported | supported |
| `coupled_imex_ark2` | coupled spin-transport IMEX | adaptive coupled transport only | full-step/two-half-step transport estimate | not a plain relaxation integrator | not a plain relaxation integrator | only with a transient spin-transport module | only with a transient spin-transport module |

`coupled_imex_ark2` is accepted by the shared dynamics vocabulary because it belongs to the
transient spin-transport contract. A standalone relaxation stage without a transient
`spin_transport` module is rejected by `ProblemIR` validation; it must not be presented as a fourth
relaxation algorithm. `abm3` is available on FDM CPU/GPU and reference FEM CPU paths, while the
native FEM GPU ABI deliberately rejects it. The exact resolved lane is part of execution provenance.

## What one relaxation iteration means

The three algorithms share the same accepted-state observation but differ in the state update:

1. Refresh the effective field and evaluate the accepted-state torque. The torque threshold is
   checked in $\mathrm{A\,m^{-1}}$ after converting a `tolT` request through $\mu_0$.
2. For `llg_overdamped`, advance the pure-damping ODE with the requested fixed/adaptive
   integrator. A rejected adaptive trial does not advance the relaxation clock or accepted-step
   counter.
3. For `projected_gradient_bb`, form a tangent gradient (optionally preconditioned by
   `bb_exchange_mass` on FEM GPU), transport secant vectors into the accepted tangent plane, choose
   the alternating BB1/BB2 step, retract $\mathbf m+\lambda\mathbf p$, and apply the 20-rejection
   Armijo limit.
4. For `nonlinear_cg`, transport the previous tangent vectors, form PR+, enforce a descent
   direction, retract $\mathbf m+\lambda\mathbf p$, and apply the 30-rejection Armijo limit.
5. Commit only an accepted state. Update the 50-sample energy window and the at-least-three-
   consecutive-sample torque confirmation, then resolve convergence or the applicable
   budget/failure reason.

Rejected trial states, failed field evaluations, non-finite metrics, and backend errors never
become accepted relaxation states and never satisfy the completion contract. Downstream eigenmode
stages require a converged relaxation state by default unless explicitly overridden via
`add_eigenmodes(..., equilibrium_acceptance="force")`, which attaches a certified residual-torque
handoff record ({doc}`stopping-criteria`).

## Shared physical contract

All three algorithms use the same normalized magnetization and effective-field convention. For
each active cell or finite-element node,

```{math}
:label: eq-relax-shared-effective-field
\mathbf m_i=\frac{\mathbf M_i}{M_{s,i}},\qquad
\mathbf H_{\mathrm{eff},i}=-\frac{1}{\mu_0M_{s,i}}
\frac{\delta E}{\delta\mathbf m_i},\qquad
\boldsymbol\tau_i=\mathbf m_i\times\mathbf H_{\mathrm{eff},i}.
```

The accepted state is constrained by $\lVert\mathbf m_i\rVert_2=1$. The public default
`tolT=1e-6` is a torque threshold in tesla; the runtime comparison is made against
$\varepsilon_{\tau,\mathrm{A/m}}=10^{-6}/\mu_0=0.7957747154594767\ \mathrm{A\,m^{-1}}$.
The energy criterion, when present, is conjunctive with torque. `max_steps` and the LLG-only
time ceiling are budgets, never proofs of equilibrium.

## Algorithm selection and exact internal policy

| Question | `llg_overdamped` | `projected_gradient_bb` | `nonlinear_cg` |
|---|---|---|---|
| Mathematical object | pure-damping LLG ODE | constrained energy minimizer | constrained energy minimizer |
| Physical/pseudo-time | relaxation coordinate $t$ in seconds | none | none |
| Trial state | RK stage | normalized $\mathbf m+\lambda\mathbf p$ ($\mathbf p=-\mathbf g$ or exchange-mass preconditioned on FEM GPU) | normalized $\mathbf m+\lambda\mathbf p$ |
| Acceptance | integrator error policy | Armijo, $c_1=10^{-4}$, representable chord/direct-energy check, at most 20 backtracks | Armijo, $c_1=10^{-4}$, at most 30 backtracks |
| Internal step policy | Heun/RK4 fixed, RK23/RK45 adaptive-capable, ABM3 multistep | alternating BB1/BB2 on tangent-transported secants, $10^{-15}\leq\lambda\leq10^{-3}\ \mathrm{m\,A^{-1}}$ | initial $\min(10^{-6},1/\lVert p\rVert)$; restart every 50 accepted steps |
| Public controls | solver, `dt*`, adaptive policy, damping override | stop criteria plus optional `study.fem_bb_preconditioner(...)` on FEM GPU | stop criteria only |

The line-search constants in the table are implementation policy, not public keyword arguments. They
are recorded as resolved provenance when a backend exposes them.

## Common stage API and IR boundary

The canonical authoring form is `study.stages.add_relax(...)`. The complete keyword surface is
`tol`, `tolA`, `tolT`, `max_steps`, `algorithm`, `energy_tolerance`,
`max_relaxation_time_s`, `max_pseudotime_s`, `max_physical_time_s`, `relax_alpha`, `solver`,
`dt`, `max_error`, `dt_min`, `dt_max`, `dt_initial`, `max_err`, `adaptive_timestep`,
`field_refresh`, and `stop`. `tol` is retained only as a rejected migration sentinel; use `tolT`
or `tolA`. The time aliases must agree and are valid only for `llg_overdamped`; all LLG controls
are rejected for the two direct minimizers. On FEM GPU, `study.fem_bb_preconditioner("auto" | "none" | "exchange_mass")`
explicitly selects the `projected_gradient_bb` direction preconditioner (`"auto"` resolves to
`"exchange_mass"` when exchange is active).

Every algorithm lowers to the same shape, with `dynamics` present only for overdamped LLG:

```json
{
  "kind": "relaxation",
  "algorithm": "nonlinear_cg",
  "stop": {"torque_tolerance_apm": 0.7957747154594767, "max_steps": 50000},
  "sampling": {"outputs": []}
}
```

This is an explanatory projection of `Relaxation.to_ir()`, not an alternative authoring format.
Planner resolution (solver family, FDM/FEM, CPU/GPU, precision, mesh/grid and field policy) and
runtime completion/provenance are separate records.

### Lower-level `fm.Relaxation` model

`study.stages.add_relax(...)` is the canonical user-facing construction path. The exported
`fm.Relaxation` model is the typed semantic object that receives the same validation and lowers to
the same `ProblemIR`; it is useful when inspecting or composing model data, not as a second
simulation authoring style.

| `fm.Relaxation` field | Type | Default | Contract | ProblemIR |
|---|---|---|---|---|
| `outputs` | sequence of `SaveField`/`SaveScalar`/`Snapshot` | empty in a stage | accepted-state sampling only; outputs do not create physical time for direct minimizers | `sampling.outputs` |
| `algorithm` | `str` | `"llg_overdamped"` | one of the supported algorithm identifiers (`llg_overdamped`, `projected_gradient_bb`, `nonlinear_cg`, `tangent_plane_implicit`) | `algorithm` |
| `stop` | `fm.RelaxStop` | torque default plus `max_steps=50_000` | grouped torque/energy/budget contract; at least one criterion required | `stop` |
| `dynamics` | `fm.LLG \| None` | auto-created for LLG; absent for direct minimizers | LLG-only integrator/timestep object; direct minimizers reject it | `dynamics` |
| `table_autosave` | `fm.TableAutosave \| None` | `None` | optional scalar table sampling; it does not alter accepted-state semantics | `sampling.table_autosave` |

Legacy constructor aliases (`torque_tolerance`, `energy_tolerance`, `max_steps` and the three
relaxation-time spellings) are normalized into `RelaxStop`; new scripts should use `tolT`/`tolA`
or an explicit `fm.RelaxStop` through the stage-first API. Private implementation fields are not
part of the public contract.

## Four implementation lanes

| Physics algorithm | FDM CPU/reference | FDM GPU/CUDA | FEM CPU/MFEM | FEM GPU/CUDA |
|---|---|---|---|---|
| `llg_overdamped` | reference grid LLG path | CUDA LLG path | native MFEM LLG path | native device LLG path (FSAL/predictor + fused short-range kernels) |
| `projected_gradient_bb` | reference cell loop (single-layer & bounded FP64 `three_d` multilayer) | device-resident `native_cuda_pgbb` (`single_layer_bb.cu`) & bounded FP64 `three_d` multilayer (incl. XY-periodic) | native MFEM step with direct-energy Armijo proof | native device step with qualified default `bb_exchange_mass` preconditioning & accepted endpoint potential reuse |
| `nonlinear_cg` | reference single-layer cell loop | single-layer CUDA direct-minimizer loop (rejected on multilayer FDM) | native MFEM step with recovery | native device-resident step |

These lane summaries do not override per-feature qualification records ({doc}`../../validation/qualification-status`).
In particular, the multilayer FDM planner admits `llg_overdamped` and the bounded FP64 `three_d`
`projected_gradient_bb` contract (equal native/convolution cells, uniform $M_s$ per object, no
frozen spins, identity/centered alignment), while rejecting `nonlinear_cg` and other direct
minimizers explicitly.

## What differs between FDM/FEM and CPU/GPU

The equations and public algorithm names are shared, but the discrete owners are not:

| Lane | State and metric owner | Field/energy evaluation | Relaxation-specific difference |
|---|---|---|---|
| FDM CPU | Cartesian cells; $\mu_0M_{s,i}V_i$ products | reference grid/FFT path | reference PG/NCG loops and CPU adaptive integrators |
| FDM GPU | CUDA cell arrays and reductions | native CUDA field/energy path (D2Z/R2C cuFFT) | device-resident single-layer `native_cuda_pgbb` (zero hot-loop H2D/D2H) and bounded FP64 `three_d` multilayer PG-BB (incl. XY-periodic); multilayer NCG rejected |
| FEM CPU | MFEM nodal vectors and mass/lumped-mass products | native MFEM operators | direct-energy Armijo proof, rollback and recovery state are CPU-native |
| FEM GPU | device-resident MFEM/CUDA state and reductions | native CUDA operators (`cuDSS` or `CG/AMG` demag, fused short-range kernels) | `bb_exchange_mass` default `auto` preconditioner, reduced host syncs (`-2..-3/step`), accepted endpoint demag reuse, Armijo comparison/rollback on device; ABM3 rejected by native ABI |

Consequently, “the same algorithm” means the same constrained continuum contract and acceptance
inequality, not bit-identical trajectories across discretizations. A CPU/GPU parity claim must
include mesh/grid identity, precision, interaction list, stop policy, field-refresh policy,
accepted-step metrics, and resolved device provenance.

## Workflow

The canonical user workflow is an executable `fm.study(...)` scenario. Geometry, material state,
interaction registration, solver policy, and the ordered relaxation stage are visible in one file:

```{toctree}
:maxdepth: 1

llg-relaxation
projected-gradient
nonlinear-cg
stopping-criteria
```

The three algorithm pages define their own equations, symbols and SI units, complete parameters,
`ProblemIR` mapping, failure semantics, realization matrix, and source-code index. The stopping
page defines the shared accepted-state completion contract, while the underlying energy functional
and LLG dissipation definitions live in {doc}`../../physics/foundations/micromagnetic-energy` and
{doc}`../../physics/foundations/llg-equation`.
