---
title: Nonlinear conjugate-gradient relaxation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
reviewed_revision: a1de38b4d7dad275dccbdbfd937b757d6ca7ee99
source_of_truth: docs/physics/0500-fdm-relaxation-algorithms.md, docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md, docs/physics/0580-canonical-relaxation-equilibrium-contract.md
---

(public-docs-numerical-methods-relaxation-nonlinear-cg)=
# Nonlinear conjugate-gradient relaxation

## Scope and purpose

This page documents the source-backed nonlinear conjugate-gradient direct minimizer for normalized
magnetization, including tangent directions, retraction, line search and completion semantics.

## Scientific and numerical model

The method minimizes the resolved micromagnetic energy on the unit-spin manifold; rejected trials
leave the accepted state and completion history unchanged.

(numerical-methods-relaxation-ncg-problem-statement)=
## Physical and numerical problem

`nonlinear_cg` is a direct constrained minimizer for the discrete micromagnetic energy. It
searches $(\mathbb S^2)^N$ instead of integrating a physical-time LLG trajectory. Each active
cell or finite-element node remains a unit vector. The tangent gradient is projected at the
current state, trial states are retracted to the sphere, and accepted steps use the
Polak–Ribière+ coefficient, an energy-metric product, periodic restart, and Armijo
sufficient-decrease backtracking.

`nonlinear_cg` has no damping parameter, RK solver, adaptive timestep, physical-time duration,
or LLG precession switch. Its line-search step is an internal numerical quantity, not a user
supplied timestep.

(numerical-methods-relaxation-ncg-governing-equations)=
## Governing equations

For reduced magnetization $\mathbf m_i$ and effective field $\mathbf H_{\mathrm{eff},i}$, the
tangent energy gradient is

```{math}
:label: eq-relax-ncg-tangent-gradient
\mathbf g_i=-\left[\mathbf H_{\mathrm{eff},i}
-\left(\mathbf m_i\cdot\mathbf H_{\mathrm{eff},i}\right)\mathbf m_i\right],
\qquad \mathbf m_i\cdot\mathbf g_i=0.
```

The normalized sphere retraction for a trial state is

```{math}
:label: eq-relax-ncg-retraction
\mathcal R_{\mathbf m_i}(\lambda\mathbf p_i)
=\frac{\mathbf m_i+\lambda\mathbf p_i}
{\left\lVert\mathbf m_i+\lambda\mathbf p_i\right\rVert_2}.
```

After an accepted step, the previous gradient and direction are transported into the new tangent
plane. With the discretization energy metric $\langle\cdot,\cdot\rangle_E$, the PR+ coefficient is

```{math}
:label: eq-relax-ncg-pr-plus
\widetilde{\mathbf g}_{k-1}=P_{\mathbf m_k}\mathbf g_{k-1},
\qquad
\beta_k^{\mathrm{PR+}}
=\max\left(0,
\frac{\left\langle\mathbf g_k,
\mathbf g_k-\widetilde{\mathbf g}_{k-1}\right\rangle_E}
{\left\langle\mathbf g_{k-1},\mathbf g_{k-1}\right\rangle_E}
\right).
```

The next search direction is

```{math}
:label: eq-relax-ncg-direction
\mathbf p_k=-\mathbf g_k+\beta_k^{\mathrm{PR+}}
P_{\mathbf m_k}\mathbf p_{k-1},
\qquad
\left\langle\mathbf p_k,\mathbf g_k\right\rangle_E<0.
```

If this is not a descent direction, the implementation restarts from the negative current
gradient. The shared FDM/reference policy forces a restart every 50 accepted steps. Native FEM
implementations maintain their own backend state and must report the resolved policy in provenance.

The Armijo acceptance condition is

```{math}
:label: eq-relax-ncg-armijo
E\!\left(\mathbf m(\lambda)\right)
\leq E(\mathbf m_k)+c_1\lambda
\left\langle\mathbf g_k,\mathbf p_k\right\rangle_E,
\qquad c_1=10^{-4}.
```

Rejected trials halve $\lambda$ and leave the accepted state unchanged. A lower energy or a
successful line search alone is not convergence; the shared accepted-state stop contract must
also be satisfied.

The implementation starts with $\mathbf p_0=-\mathbf g_0$ and
$\lambda_0=\min(10^{-6},1/\lVert\mathbf p_0\rVert)$, with $10^{-6}$ in
$\mathrm{m\,A^{-1}}$ and the norm computed by the unweighted vector product. Before each line
search, a non-descent direction ($\langle p,g\rangle_E\geq0$) is replaced by $-g$. The
Polak–Ribière+ numerator uses the trial tangent projection of the previous gradient. The
coefficient is clipped with $\max(0,\cdot)$; invalid or non-positive previous-gradient metric
norms give $\beta=0$. The next direction transports the previous direction to the new tangent
plane and is reset to $-g$ if it is not a descent direction. Every 50th accepted step sets
$\beta=0$. Backtracking multiplies $\lambda$ by $1/2$ and allows at most 30 rejected trials.

(numerical-methods-relaxation-ncg-iteration)=
## One nonlinear-CG iteration

The accepted-step loop is:

1. Assemble the current effective field, tangent gradient, energy and torque. Reject non-finite
   quantities and classify an exactly degenerate gradient as numerical stagnation.
2. Transport the previous gradient and direction into the current tangent plane. Compute PR+ with
   the energy metric, force $\beta=0$ on the 50-step restart boundary, and replace any
   non-descent direction by $-\mathbf g_k$.
3. Start the line search at the bounded initial proposal, retract
   $\mathcal R_{\mathbf m}(\lambda\mathbf p_k)$, and evaluate the complete trial energy. Apply
   the Armijo inequality; halve and retry on rejection. The FDM/shared loop permits 30 rejected
   trials. Native FEM recovery paths may consume additional restart trials, which are recorded as
   rejected attempts rather than accepted steps.
4. Commit only the accepted trial, preserve its field/energy snapshot for the next direction, and
   increment `accepted_step`. Rejected trials never modify the accepted state.
5. Feed the accepted torque and energy into the shared completion controller. The line search proves
   sufficient decrease for one step; it does not prove equilibrium or a global minimum.

Native FEM CPU and GPU implementations additionally evaluate a representable direct-energy
difference and its roundoff bound before accepting a step. This is an implementation-level
acceptance proof and must be reported separately from the shared torque/energy stop result.

(numerical-methods-relaxation-ncg-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf m_i$ | reduced magnetization at active cell/node $i$ | $1$ |
| $\mathcal R_{\mathbf m_i}$ | normalized sphere retraction | $1$ |
| $\mathbf H_{\mathrm{eff},i}$ | effective magnetic field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf g_i$ | tangent energy gradient | $\mathrm{A\,m^{-1}}$ |
| $\mathbf p_i$ | tangent search direction | $\mathrm{A\,m^{-1}}$ |
| $P_{\mathbf m_i}$ | tangent-plane projection | $1$ |
| $\widetilde{\mathbf g}_{k-1}$ | transported previous gradient | $\mathrm{A\,m^{-1}}$ |
| $\beta_k^{\mathrm{PR+}}$ | Polak–Ribière+ coefficient | $1$ |
| $\lambda$ | direct-minimizer line-search step | $\mathrm{m\,A^{-1}}$ |
| $E$ | total micromagnetic energy | $\mathrm{J}$ |
| $\langle\cdot,\cdot\rangle_E$ | energy-metric inner product | dimension-dependent metric |
| $c_1$ | Armijo constant | $1$ |
| $N$ | active cells or finite-element nodes | $1$ |
| $k$ | accepted minimizer iteration | $1$ |
| $\tau_{\max}$ | maximum accepted-state torque | $\mathrm{A\,m^{-1}}$ |
| $\varepsilon_\tau$ | canonical torque threshold | $\mathrm{A\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $M_{s,i}$ | local saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $V_i$ | cell or nodal volume weight | $\mathrm{m^3}$ |
| $a_i$ | first vector in the energy metric | $\mathrm{A\,m^{-1}}$ |
| $b_i$ | second vector in the energy metric | $\mathrm{A\,m^{-1}}$ |

The metric used by the FDM/shared implementation is

```{math}
:label: eq-relax-ncg-energy-metric
\langle a,b\rangle_E
=\sum_i \mu_0 M_{s,i}V_i\,a_i\cdot b_i,
\qquad
[\langle a,b\rangle_E]
=\mathrm{J\,A^{-1}}[a][b].
```

The metric weight $\mu_0M_{s,i}V_i$ is $\mathrm{J\,A^{-1}}$. Thus the Armijo slope
$\langle g,p\rangle_E$ is $\mathrm{J\,A\,m^{-1}}$ for field-valued $g$ and $p$, and
$\lambda\langle g,p\rangle_E$ is an energy. The displacement vectors $s$ are dimensionless,
so the BB/PR products have different operand-dependent units; they must not be treated as a
single unitless dot product.

For FEM the same physical metric is realized by the MFEM mass/lumped-mass operators rather than
Cartesian cell volumes. The line-search parameter has units $\mathrm{m\,A^{-1}}$ because it
multiplies a field-valued direction.

(numerical-methods-relaxation-ncg-assumptions-and-validity)=
## Assumptions and validity

- Every committed magnetization is normalized. A zero or non-finite retraction is a failure.
- Gradient norms, metric products and energy differences must be finite. Degenerate gradients
  produce numerical stagnation, not a false converged result.
- Armijo rejection rolls back the accepted magnetization and the backend field/energy state needed
  for the next trial.
- PR+ is clipped at zero. A non-descent direction is replaced with the negative tangent gradient.
- Direct minimizers have no physical time. `max_relaxation_time_s`, `solver`, `dt`,
  `max_error`, `max_err`, `dt_min`, `dt_max`, `dt_initial`, `adaptive_timestep`,
  `field_refresh`, and `relax_alpha` are invalid for `nonlinear_cg`.

(numerical-methods-relaxation-ncg-python-api)=
## Python API

This is the copyable stage-first pattern. It does not use `fm.Problem(...)`.

```python
# %% Configure nonlinear-CG relaxation
import fullmag as fm

nm = 1.0e-9
study = fm.study("nonlinear_cg_relaxation")
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
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
study.exchange()
study.stages.add_relax(
    stage_id="relax",
    algorithm="nonlinear_cg",
    tolT=1.0e-6,
    max_steps=50_000,
)
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---:|---|---|---|---|---|
| `StudyStagesBuilder.add_relax(algorithm="nonlinear_cg")` | str | "llg_overdamped" | $1$ | supported identifier | selects NCG | FDM reference; FEM CPU/GPU native lanes | `study.algorithm` |
| `StudyStagesBuilder.add_relax(tolT=...)` | float | $10^{-6}$ | $\mathrm{T}$ | finite, positive, exclusive with `tolA` | public torque threshold converted to A/m | FDM/FEM | `study.stop.torque_tolerance_apm` |
| `StudyStagesBuilder.add_relax(tolA=...)` | float | equivalent | $\mathrm{A\,m^{-1}}$ | finite, positive, exclusive with `tolT` | canonical torque threshold | FDM/FEM | `study.stop.torque_tolerance_apm` |
| `StudyStagesBuilder.add_relax(max_steps=...)` | int | $50{,}000$ | $1$ | positive integer | accepted-step budget | FDM/FEM | `study.stop.max_steps` |
| `StudyStagesBuilder.add_relax(energy_tolerance=...)` | float or None | None | $\mathrm{J}$ | positive when set | accepted-energy plateau threshold | FDM/FEM | `study.stop.energy_tolerance_j` |
| `StudyStagesBuilder.add_relax(max_relaxation_time_s=...)` | float or None | None | $\mathrm{s}$ | rejected for NCG | LLG-only time ceiling | none for NCG | `study.stop.max_relaxation_time_s` |
| `StudyStagesBuilder.add_relax(solver=...)` | str or None | None | $1$ | rejected for NCG | LLG integrator selector | none for NCG | `study.dynamics.integrator` |
| `StudyStagesBuilder.add_relax(dt=...)` | float or auto or None | None | $\mathrm{s}$ | rejected for NCG | LLG timestep | none for NCG | `study.dynamics` |
| `StudyStagesBuilder.add_relax(max_error=...)` | float or None | None | $1$ | rejected for NCG | LLG adaptive error control | none for NCG | `study.dynamics.adaptive_timestep.atol` |
| `StudyStagesBuilder.add_relax(max_err=...)` | float or None | None | $1$ | rejected for NCG | LLG error alias | none for NCG | `study.dynamics.adaptive_timestep.atol` |
| `StudyStagesBuilder.add_relax(dt_min=...)` | float or None | None | $\mathrm{s}$ | rejected for NCG | LLG lower timestep bound | none for NCG | `study.dynamics.adaptive_timestep.dt_min` |
| `StudyStagesBuilder.add_relax(dt_max=...)` | float or None | None | $\mathrm{s}$ | rejected for NCG | LLG upper timestep bound | none for NCG | `study.dynamics.adaptive_timestep.dt_max` |
| `StudyStagesBuilder.add_relax(dt_initial=...)` | float or None | None | $\mathrm{s}$ | rejected for NCG | LLG initial timestep | none for NCG | `study.dynamics.adaptive_timestep.dt_initial` |
| `StudyStagesBuilder.add_relax(adaptive_timestep=...)` | AdaptiveTimestep or None | None | mixed | rejected for NCG | LLG adaptive policy | none for NCG | `study.dynamics.adaptive_timestep` |
| `StudyStagesBuilder.add_relax(field_refresh=...)` | FieldRefreshPolicy or None | None | $1$ | rejected for NCG | LLG field-refresh policy | none for NCG | `study.dynamics.field_refresh` |
| `StudyStagesBuilder.add_relax(relax_alpha=...)` | float or None | None | $1$ | rejected for NCG | LLG damping override | none for NCG | resolved LLG provenance |
| legacy tol=... | float | unavailable | legacy | always rejected | use tolT or tolA | none | none |
| `StudyStagesBuilder.add_relax(max_pseudotime_s=...)` | float or None | None | $\mathrm{s}$ | rejected for NCG | LLG-only alias | none | none |
| `StudyStagesBuilder.add_relax(max_physical_time_s=...)` | float or None | None | $\mathrm{s}$ | rejected for NCG | LLG-only alias | none | none |
| `StudyStagesBuilder.add_relax(stop=...)` | `RelaxStop` or None | None | mixed | grouped stop; scalar conflicts rejected | canonical stopping object | FDM/FEM | `study.stop` |

Line-search constants, restart interval, curvature guards and backend recovery limits are
implementation policy, not user parameters. They must be included in resolved provenance when
they affect qualification.

(numerical-methods-relaxation-ncg-problem-ir)=
## Parameters

The executable controls are the algorithm identifier, torque and optional energy stop criteria, and
the accepted-step budget. LLG timestep, adaptive and damping controls are explicitly rejected for
this direct minimizer, as shown by the Python-to-ProblemIR table.

## ProblemIR

The request lowers to this direct-minimizer payload:

```json
{
  "kind": "relaxation",
  "algorithm": "nonlinear_cg",
  "stop": {
    "torque_tolerance_apm": 0.7957747154594767,
    "max_steps": 50000
  },
  "sampling": {
    "outputs": []
  }
}
```

This is an explanatory projection of the serializer, not a hand-written replacement for
`study.stages.add_relax(...)`). There is intentionally no `dynamics` object for NCG. The
planner adds the requested FEM/FDM lane, CPU/GPU device, precision, field realization and
resolved policy as execution/provenance data.

(numerical-methods-relaxation-ncg-round-trip-and-failure-semantics)=
## Diagnostics and failure semantics

Record tangent-gradient norms, direction updates, Armijo trials and backtracks, accepted-step
energy, torque completion, failure or cancellation status and resolved lane. A non-finite metric,
invalid curvature or failed line search is not convergence.

## Round-trip and failure semantics

The requested intent is preserved separately from the resolved execution record.

The exporter preserves the requested algorithm, stop fields, requested engine/device and absence of
LLG dynamics. `tolT` is retained as authored intent while the canonical stop field is A/m. The
resolved execution record separately identifies solver, device, precision, mesh and backend policy.
Validation errors include unknown algorithm, legacy tol, simultaneous `tolT` and `tolA`,
non-positive threshold or step budget, any LLG-only parameter, non-finite gradient or energy,
unrecoverable non-descent direction, exhausted line search, failed field/energy evaluation, and
an unnormalizable magnetization. Unsupported combinations are rejected by the planner; there is no
silent fallback to another algorithm or device.

(numerical-methods-relaxation-ncg-discrete-realization)=
## Discrete realization

| Solver | Device | Status | Realization and evidence boundary |
|---|---|---|---|
| FDM | CPU | source-backed | cellwise tangent gradient, energy-weighted products, retraction and reference Armijo loop |
| FDM | GPU | source-backed with planner boundary | native CUDA direct-minimizer dispatcher exists; public multilayer planner currently permits only `llg_overdamped` |
| FEM | CPU | source-backed | native MFEM nodal gradient, mass metric, direct-energy Armijo decision, rollback and persistent direction |
| FEM | GPU | source-backed | native CUDA device-resident gradients, reductions, retraction, rollback and persistent direction; executed-device qualification is separate |

The continuum algorithm is shared, but the discrete metric is not. FDM uses cell-volume/material
weights. FEM uses its finite-element mass/lumped-mass realization and native field operators.
CPU/GPU comparison requires the same problem, mesh, precision, stop contract and resolved
provenance.

FDM CPU calls the reference grid loop; FDM GPU calls the native CUDA direct-minimizer dispatcher
when the resolved plan permits direct minimization. The public multilayer FDM planner currently
rejects PG/NCG for that runner, so “CUDA source exists” and “this multilayer script executes NCG on
GPU” are different claims. FEM CPU performs native MFEM field/energy recovery and rollback; FEM
GPU keeps direction, accepted field and reduction workspaces device-resident. Runtime qualification
must identify the actual device and precision.

(numerical-methods-relaxation-ncg-implementation-mapping)=
## Implementation mapping

The Python stage is lowered by `relax_stage` and validated by `Relaxation`. The FDM reference
loop is `execute_nonlinear_cg`. Shared direction, transport, restart and line-search helpers
live in `direct_minimizer.rs`. Native FEM CPU and GPU are separate implementations: CPU owns
MFEM state and direct-energy recovery; GPU owns device-resident vectors, reductions and rollback.
Source presence and serialization do not prove executed GPU behavior.

(numerical-methods-relaxation-ncg-validation)=
## Validation

Validation covers tangent orthogonality, unit-norm retraction, PR+ and restart, Armijo halving and
rollback, line-search exhaustion, accepted-state torque/energy completion, stage-to-ProblemIR
round-trip, and separate FDM CPU, FDM GPU, FEM CPU and FEM GPU planner/runtime gates. Python
`to_ir()` proves authoring/lowering only; a source-map match proves traceability only.

(numerical-methods-relaxation-ncg-limitations)=
## Limitations

`nonlinear_cg` is a local constrained minimizer and may end in a metastable equilibrium. It does
not guarantee a global minimum, fixed iteration count, identical FDM/FEM trajectories, monotone
energy across every backend recovery policy, or universal GPU qualification. Its line-search step
has no physical-time interpretation.

(numerical-methods-relaxation-ncg-scientific-bibliography)=
## Scientific bibliography

- J. Nocedal and S. J. Wright, *Numerical Optimization*, 2nd ed., Springer, 2006, DOI: [10.1007/978-0-387-40065-5](https://doi.org/10.1007/978-0-387-40065-5).
- B. T. Polyak, “The conjugate gradient method in extremal problems,” *USSR Computational Mathematics and Mathematical Physics* 9 (1969), 94–112.
- Fullmag canonical contracts: 0500-fdm-relaxation-algorithms.md, 0510-fem-relaxation-algorithms-mfem-gpu.md, and 0580-canonical-relaxation-equilibrium-contract.md.

(numerical-methods-relaxation-ncg-source-code-index)=

## Control Room workflow

Use the stage editor to select `nonlinear_cg` and configure only direct-minimizer stop controls.
Inspect the resolved algorithm and completion telemetry; LLG integrator and physical-time controls
are not valid controls for this stage.

## Control Room crosswalk

Use `Model Explorer -> Stages -> Add stage -> <stage kind>` for stage-level controls when the terminal page identifies a matching field. The current editor is partial: only fields surfaced by the stage draft are authorable. Numerical parameters without a matching control are not implemented in the frontend. Do not infer frontend support from Python or backend availability. See {doc}/frontend/capability-register for the current register and exact source owner.

## Where this is implemented

The source-code index below records the Python contract, reference loop, direction and line-search
policy, native FEM lanes and completion policy used by this page.

## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Public algorithm contract | `packages/fullmag-py/src/fullmag/model/study.py` | `class Relaxation` | validates algorithms, rejects LLG dynamics for direct minimizers, serializes `ProblemIR` | public API | Python contract tests |
| Stop fields | `packages/fullmag-py/src/fullmag/model/study.py` | `class RelaxStop` | validates torque, energy and step/time criteria | public API | Python contract tests |
| Stage lowering | `packages/fullmag-py/src/fullmag/world.py` | `relax_stage` | maps stage arguments into the canonical payload | public API | stage export tests |
| NCG direction policy | `crates/fullmag-runner/src/relaxation/direct_minimizer.rs` | `nonlinear_cg_next_direction` | tangent transport, PR+, restart and descent recovery | shared/FDM policy | Rust unit tests |
| NCG line search | `crates/fullmag-runner/src/relaxation/direct_minimizer.rs` | `nonlinear_cg_armijo_accepts` | Armijo acceptance predicate | shared/FDM policy | Rust unit tests |
| FDM reference loop | `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs` | `execute_nonlinear_cg` | cellwise NCG implementation | FDM CPU/reference | Rust unit tests |
| FDM CUDA loop | `crates/fullmag-runner/src/fdm/gpu/cuda/direct_minimizer.rs` | `execute_direct_minimizer` | CUDA PG/NCG state, line search and metrics | FDM GPU | device-gated tests |
| FEM CPU step | `backends/fem/cpu/mfem/relaxation/nonlinear_cg.cpp` | `run_nonlinear_cg_step` | MFEM gradient, energy decision, recovery and state update | FEM CPU | native source contract tests |
| FEM GPU step | `backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp` | `gpu_relax_nonlinear_cg_step` | device-resident reductions, direction, retraction and rollback | FEM GPU | native source contract tests |
