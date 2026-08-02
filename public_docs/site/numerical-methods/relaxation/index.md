---
title: Relaxation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0500-fdm-relaxation-algorithms.md, docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md, docs/physics/0580-canonical-relaxation-equilibrium-contract.md
---

(public-docs-numerical-methods-relaxation-root)=
# Relaxation

Relaxation is a zero-temperature constrained minimization stage. It seeks a stationary
magnetization on the product of unit spheres, rather than advancing a physical-time experiment.
The same physical energy and effective-field definitions are used by FDM and FEM; the numerical
realization, field refresh policy, precision, memory ownership, and qualification evidence are
separate.

The stage API exposes three executable relaxation algorithms. They are not three names for one
implementation: `llg_overdamped` advances a damping-only LLG equation, while the two direct
minimizers operate on the constrained energy landscape without a physical-time coordinate.

| Algorithm | Numerical role | Time-step controls | Current qualification boundary |
|---|---|---|---|
| `llg_overdamped` | precession-disabled damping descent | fixed or adaptive explicit integrator; optional relaxation-time ceiling | FDM and FEM lanes are implemented; runtime qualification is lane- and device-specific |
| `projected_gradient_bb` | tangent projected gradient with alternating BB1/BB2 step selection and Armijo backtracking | no physical or pseudo-time step | FDM reference and native FEM CPU/GPU implementations exist; planner/runtime evidence is separate |
| `nonlinear_cg` | Polak–Ribière+ tangent-space conjugate minimization with Armijo backtracking and periodic restart | no physical or pseudo-time step | FDM reference and native FEM CPU/GPU implementations exist; planner/runtime evidence is separate |

`tangent_plane_implicit` is represented in the public algorithm vocabulary and has a native FEM
CPU development implementation, but it is not one of the three algorithms documented as an
executable public relaxation choice here.
The planner must reject an unsupported solver/device combination instead of silently replacing the
requested algorithm.

## LLG integrator vocabulary (only for `llg_overdamped`)

The `solver` keyword selects the integrator used by the damping-only LLG stage. It does not select
one of the three relaxation algorithms. The Python DSL canonicalizes `dp54` to `rk45` and `bs23`
to `rk23`; the canonical name is what is written to `ProblemIR` and provenance. `None` and
`"auto"` resolve to `rk23` when the stage is lowered.

| Canonical name | Family | Step policy | Embedded/error order | FEM CPU | FEM GPU | FDM CPU | FDM GPU |
|---|---|---|---|---|---|---|---|
| `heun` | explicit RK2 | fixed | none | supported | supported | supported | supported |
| `rk4` | explicit RK4 | fixed | none | supported | supported | supported | supported |
| `rk23` (alias `bs23`) | Bogacki–Shampine | fixed or adaptive | embedded lower-order estimate | supported | supported | supported | supported |
| `rk45` (alias `dp54`) | Dormand–Prince | fixed or adaptive | embedded lower-order estimate | supported | supported | supported | supported |
| `abm3` | Adams–Bashforth–Moulton 3 | fixed multistep | predictor/corrector history | reference path | not native | supported | supported |
| `coupled_imex_ark2` | coupled spin-transport IMEX | adaptive coupled transport only | full-step/two-half-step transport estimate | not a plain relaxation integrator | not a plain relaxation integrator | only with a transient spin-transport module | only with a transient spin-transport module |

`coupled_imex_ark2` is accepted by the shared dynamics vocabulary because it belongs to the
transient spin-transport contract. A standalone relaxation stage without a transient
`spin_transport` module is rejected by ProblemIR validation; it must not be presented as a fourth
relaxation algorithm. `abm3` is available on FDM and reference FEM paths, but the native FEM GPU
ABI deliberately rejects it. The exact resolved lane is part of execution provenance.

## What one relaxation iteration means

The three algorithms share the same accepted-state observation but differ in the state update:

1. Refresh the effective field and evaluate the accepted-state torque. The torque threshold is
   checked in A/m after converting a `tolT` request through $\mu_0$.
2. For `llg_overdamped`, advance the pure-damping ODE with the requested fixed/adaptive
   integrator. A rejected adaptive trial does not advance the relaxation clock or accepted-step
   counter.
3. For `projected_gradient_bb`, form a tangent gradient, choose the alternating BB step, retract
   $\mathbf m-\lambda\mathbf g$, and apply the 20-rejection Armijo limit.
4. For `nonlinear_cg`, transport the previous tangent vectors, form PR+, enforce a descent
   direction, retract $\mathbf m+\lambda\mathbf p$, and apply the 30-rejection Armijo limit.
5. Commit only an accepted state. Update the 50-sample energy window and the at-least-three-
   consecutive-sample torque confirmation, then resolve convergence or the applicable
   budget/failure reason.

Rejected trial states, failed field evaluations, non-finite metrics, and backend errors never
become accepted relaxation states and never satisfy the completion contract.

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
| Trial state | RK stage | normalized $\mathbf m-\lambda\mathbf g$ | normalized $\mathbf m+\lambda\mathbf p$ |
| Acceptance | integrator error policy | Armijo, $c_1=10^{-4}$, at most 20 backtracks | Armijo, $c_1=10^{-4}$, at most 30 backtracks |
| Internal step policy | Heun/RK4 fixed, RK23/RK45 adaptive-capable, ABM3 reference multistep | BB1/BB2 alternation, $10^{-15}\leq\lambda\leq10^{-3}$ | initial $\min(10^{-6},1/\lVert p\rVert)$; restart every 50 accepted steps |
| Public controls | solver, `dt*`, adaptive policy, damping override | stop criteria only | stop criteria only |

The constants in the table are implementation policy, not public keyword arguments. They are
recorded as resolved provenance when a backend exposes them. `tangent_plane_implicit` remains a
reserved vocabulary value and is not included in this three-algorithm public contract.

## Common stage API and IR boundary

The canonical authoring form is `study.stages.add_relax(...)`. The complete keyword surface is
`tol`, `tolA`, `tolT`, `max_steps`, `algorithm`, `energy_tolerance`,
`max_relaxation_time_s`, `max_pseudotime_s`, `max_physical_time_s`, `relax_alpha`, `solver`,
`dt`, `max_error`, `dt_min`, `dt_max`, `dt_initial`, `max_err`, `adaptive_timestep`,
`field_refresh`, and `stop`. `tol` is retained only as a rejected migration sentinel; use `tolT`
or `tolA`. The time aliases must agree and are valid only for `llg_overdamped`; all LLG controls
are rejected for the two direct minimizers.

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
| `algorithm` | `str` | `"llg_overdamped"` | one of the supported algorithm identifiers; `tangent_plane_implicit` remains reserved | `algorithm` |
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
| `llg_overdamped` | reference grid LLG path | CUDA LLG path | native MFEM LLG path | native device LLG path |
| `projected_gradient_bb` | reference cell loop | CUDA direct-minimizer loop | native MFEM step | native device step |
| `nonlinear_cg` | reference cell loop | CUDA direct-minimizer loop | native MFEM step with recovery | native device-resident step |

These are source/architecture statements, not blanket qualification claims. In particular, the
public multilayer FDM planner currently allows only `llg_overdamped`; single-layer/native direct
minimizer paths and executed GPU evidence must be checked separately.

## What differs between FDM/FEM and CPU/GPU

The equations and public algorithm names are shared, but the discrete owners are not:

| Lane | State and metric owner | Field/energy evaluation | Relaxation-specific difference |
|---|---|---|---|
| FDM CPU | Cartesian cells; $\mu_0M_{s,i}V_i$ products | reference grid/FFT path | reference PG/NCG loops and CPU adaptive integrators |
| FDM GPU | CUDA cell arrays and reductions | native CUDA field/energy path | direct-minimizer dispatcher and device reductions; multilayer planner restrictions apply |
| FEM CPU | MFEM nodal vectors and mass/lumped-mass products | native MFEM operators | direct-energy Armijo proof, rollback and recovery state are CPU-native |
| FEM GPU | device-resident MFEM/CUDA state and reductions | native CUDA operators | Armijo comparison/refinement, rollback and direction state remain on the device; ABM3 is rejected by the native ABI |

Consequently, “the same algorithm” means the same constrained continuum contract and acceptance
inequality, not bit-identical trajectories. A CPU/GPU parity claim must include mesh/grid identity,
precision, interaction list, stop policy, field-refresh policy, accepted-step metrics and resolved
device provenance. A source file or `to_ir()` result alone is not evidence that a GPU execution
occurred.

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
page defines the shared accepted-state completion contract. The physical contract is
shared with [`docs/physics/0500-fdm-relaxation-algorithms.md`](https://github.com/MateuszZelent/fullmag/blob/master/docs/physics/0500-fdm-relaxation-algorithms.md),
[`docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md`](https://github.com/MateuszZelent/fullmag/blob/master/docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md),
and [`docs/physics/0580-canonical-relaxation-equilibrium-contract.md`](https://github.com/MateuszZelent/fullmag/blob/master/docs/physics/0580-canonical-relaxation-equilibrium-contract.md).
