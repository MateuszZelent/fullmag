---
title: Nonlinear conjugate-gradient relaxation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
source_of_truth: /physics/foundations/micromagnetic-energy, /physics/foundations/effective-field
---

(public-docs-numerical-methods-relaxation-nonlinear-cg)=
# Nonlinear conjugate-gradient relaxation

(numerical-methods-relaxation-ncg-problem-statement)=
## Scope and purpose

This page documents the nonlinear conjugate-gradient direct minimizer (`nonlinear_cg`) for
normalized magnetization on $(\mathbb S^2)^N$, including tangent-plane transport, Polak–Ribière+
conjugate direction updates, normalized sphere retraction, periodic restarts, Armijo backtracking,
and accepted-state completion semantics. `nonlinear_cg` has no damping parameter, RK solver,
adaptive timestep, or physical-time coordinate.

(numerical-methods-relaxation-ncg-governing-equations)=
## Scientific and numerical model

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

If this is not a descent direction, the implementation restarts from $-\mathbf g_k$. The shared
FDM/reference policy forces a restart every 50 accepted steps. The Armijo acceptance condition is

```{math}
:label: eq-relax-ncg-armijo
E\!\left(\mathbf m(\lambda)\right)
\leq E(\mathbf m_k)+c_1\lambda
\left\langle\mathbf g_k,\mathbf p_k\right\rangle_E,
\qquad c_1=10^{-4}.
```

The energy metric used by the FDM/shared implementation is

```{math}
:label: eq-relax-ncg-energy-metric
\langle a,b\rangle_E
=\sum_i \mu_0 M_{s,i}V_i\,a_i\cdot b_i,
\qquad
[\langle a,b\rangle_E]
=\mathrm{J\,A^{-1}}[a][b].
```

The implementation starts with $\mathbf p_0=-\mathbf g_0$ and
$\lambda_0=\min(10^{-6},1/\lVert\mathbf p_0\rVert)$, with $10^{-6}$ in $\mathrm{m\,A^{-1}}$.
Backtracking halves $\lambda$ and permits up to 30 rejected trials on the FDM/shared loop. For FEM,
$V_i$ is replaced by the MFEM mass/lumped-mass realization, and both FEM CPU and GPU evaluate a
representable direct-energy difference and roundoff bound before accepting a step. On FEM GPU,
stiff-exchange workloads generally prefer `projected_gradient_bb` with the qualified
`bb_exchange_mass` preconditioner ({doc}`projected-gradient`,
{ref}`numerical-methods-performance-fem-gpu-kernels`).

(numerical-methods-relaxation-ncg-iteration)=
### One nonlinear-CG iteration

1. Assemble the current effective field, tangent gradient, energy, and torque; reject non-finite
   quantities and classify an exactly zero gradient as numerical stagnation.
2. Transport the previous gradient and direction into the current tangent plane, compute PR+, force
   $\beta=0$ on the 50-step restart boundary, and replace any non-descent direction with $-\mathbf g_k$.
3. Retract $\mathcal R_{\mathbf m}(\lambda\mathbf p_k)$, evaluate the complete trial energy, and
   apply the Armijo inequality (halving $\lambda$ on rejection, up to 30 retries on the shared loop).
4. Commit only the accepted trial, preserve its field/energy snapshot, and increment `accepted_step`.
5. Feed accepted torque and energy into the shared completion controller ({doc}`stopping-criteria`).

(numerical-methods-relaxation-ncg-symbols-and-si-units)=
### Symbols and SI units

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
| $\langle\cdot,\cdot\rangle_E$ | energy-metric inner product | $\mathrm{J\,A^{-1}}[a][b]$ |
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

(numerical-methods-relaxation-ncg-assumptions-and-validity)=
### Assumptions and validity

- Every committed magnetization is normalized; a zero or non-finite retraction is a failure.
- Armijo rejection rolls back the accepted magnetization and field/energy state cleanly.
- PR+ is clipped at zero; non-descent directions reset to $-\mathbf g_k$.
- Direct minimizers have no physical time: `max_relaxation_time_s`, `solver`, `dt`, `max_error`,
  `max_err`, `dt_min`, `dt_max`, `dt_initial`, `adaptive_timestep`, `field_refresh`, and
  `relax_alpha` are rejected for `nonlinear_cg`.

(numerical-methods-relaxation-ncg-discrete-realization)=
### Discrete realization

| Solver | Device | Status | Realization and evidence boundary |
|---|---|---|---|
| FDM | CPU | `source-backed` | Single-layer cellwise tangent gradient, energy-weighted products, retraction, and reference Armijo loop (`execute_nonlinear_cg`). |
| FDM | GPU | `source-backed` | Single-layer CUDA direct-minimizer dispatcher (`execute_direct_minimizer`); multilayer FDM admits `llg_overdamped` and bounded FP64 `three_d` `projected_gradient_bb`, while rejecting `nonlinear_cg`. |
| FEM | CPU | `source-backed` | Native MFEM nodal gradient, mass metric, direct-energy Armijo decision, rollback, and persistent direction (`run_nonlinear_cg_step`). |
| FEM | GPU | `source-backed` | Native CUDA device-resident gradients, reductions, retraction, rollback, and persistent direction (`gpu_relax_nonlinear_cg_step`); executed-device qualification is tracked separately ({doc}`../../validation/qualification-status`). |

(numerical-methods-relaxation-ncg-implementation-mapping)=
### Implementation mapping

The Python stage is lowered by `relax_stage` and validated by `Relaxation`. The FDM reference loop
is `execute_nonlinear_cg`, sharing direction, transport, restart, and line-search helpers in
`direct_minimizer.rs`. Native FEM CPU (`run_nonlinear_cg_step`) and GPU
(`gpu_relax_nonlinear_cg_step`) own separate state and recovery implementations.

(numerical-methods-relaxation-ncg-problem-ir)=
## Parameters

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---:|---|---|---|---|---|
| `StudyStagesBuilder.add_relax(algorithm="nonlinear_cg")` | `str` | `"llg_overdamped"` | $1$ | supported identifier | selects NCG | single-layer FDM; FEM CPU/GPU | `study.algorithm` |
| `StudyStagesBuilder.add_relax(tolT=...)` | `float` | $10^{-6}$ | $\mathrm{T}$ | finite, positive, exclusive with `tolA` | public torque threshold converted to $\mathrm{A\,m^{-1}}$ | FDM/FEM | `study.stop.torque_tolerance_apm` |
| `StudyStagesBuilder.add_relax(tolA=...)` | `float` | equivalent | $\mathrm{A\,m^{-1}}$ | finite, positive, exclusive with `tolT` | canonical torque threshold | FDM/FEM | `study.stop.torque_tolerance_apm` |
| `StudyStagesBuilder.add_relax(max_steps=...)` | `int` | $50{,}000$ | $1$ | positive integer | accepted-step budget | FDM/FEM | `study.stop.max_steps` |
| `StudyStagesBuilder.add_relax(energy_tolerance=...)` | `float \| None` | `None` | $\mathrm{J}$ | positive when set | accepted-energy plateau threshold | FDM/FEM | `study.stop.energy_tolerance_j` |
| `StudyStagesBuilder.add_relax(stop=...)` | `RelaxStop \| None` | `None` | $1$ | grouped stop; scalar conflicts rejected | canonical stopping object | FDM/FEM | `study.stop` |
| LLG-only keywords (`solver`, `dt`, `max_err`, `max_error`, `dt_min`, `dt_max`, `dt_initial`, `adaptive_timestep`, `field_refresh`, `relax_alpha`, `max_relaxation_time_s`, `max_pseudotime_s`, `max_physical_time_s`) | various | `None` | $1$ | rejected for NCG | LLG dynamics and time controls | none for NCG | none |
| legacy `tol=...` | `float` | unavailable | $1$ | always rejected | removed tolerance spelling; use `tolT` or `tolA` | none | none |

(numerical-methods-relaxation-ncg-python-api)=
## Python API

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
film.m = fm.texture.uniform(1.0, 0.1, 0.0)
study.exchange()
study.stages.add_relax(
    stage_id="relax",
    algorithm="nonlinear_cg",
    tolT=1.0e-6,
    max_steps=50_000,
)
```

### `ProblemIR` excerpt

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

## Control Room workflow

Use the stage editor to select `nonlinear_cg` and configure only direct-minimizer stop controls.
Inspect the resolved algorithm and completion telemetry; LLG integrator and physical-time controls
are not valid controls for this stage.

(numerical-methods-relaxation-ncg-round-trip-and-failure-semantics)=
## Diagnostics and failure semantics

- **Requested intent vs resolved execution**: Script export preserves `algorithm="nonlinear_cg"`,
  stop fields, requested intent, and absence of LLG dynamics separately from resolved execution
  provenance.
- **Validation errors and unsupported combinations**: Validation errors include unknown algorithm,
  legacy `tol`, simultaneous `tolT`/`tolA`, non-positive thresholds/budgets, and any LLG-only
  parameter. Unsupported combinations such as requesting `nonlinear_cg` on multilayer FDM fail
  closed with zero silent fallback.
- **Runtime failure semantics**: Non-finite gradients/energies, unrecoverable non-descent
  directions, exhausted line searches, or failed field solves report failure rather than
  convergence.

(numerical-methods-relaxation-ncg-validation)=
## Validation

Validation covers tangent orthogonality, unit-norm retraction, PR+ and periodic restarts, Armijo
halving and rollback, line-search exhaustion, accepted-state torque/energy completion,
stage-to-`ProblemIR` round-trip, and lane-specific planner/runtime gates.

(numerical-methods-relaxation-ncg-limitations)=
## Limitations

`nonlinear_cg` is a local constrained minimizer and may terminate in a metastable equilibrium. It is
unsupported on multilayer FDM (use `projected_gradient_bb` or `llg_overdamped`) and has no
physical-time interpretation.

(numerical-methods-relaxation-ncg-scientific-bibliography)=
## Scientific bibliography

- J. Nocedal and S. J. Wright, *Numerical Optimization*, 2nd ed., Springer, 2006, DOI: [10.1007/978-0-387-40065-5](https://doi.org/10.1007/978-0-387-40065-5).
- B. T. Polyak, “The conjugate gradient method in extremal problems,” *USSR Computational Mathematics and Mathematical Physics* **9**, 94–112 (1969), DOI: [10.1016/0041-5553(69)90035-4](https://doi.org/10.1016/0041-5553(69)90035-4).
- FullMag public physics contracts: {doc}`/physics/foundations/micromagnetic-energy`, {doc}`/physics/foundations/effective-field`, and {doc}`stopping-criteria`.

(numerical-methods-relaxation-ncg-source-code-index)=
## Where this is implemented

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Public algorithm contract | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L901) | [`class Relaxation`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L901) | validates algorithms, rejects LLG dynamics for direct minimizers, serializes `ProblemIR` | public API | Python contract tests |
| Stop fields | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L831) | [`class RelaxStop`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L831) | validates torque, energy and step/time criteria | public API | Python contract tests |
| Stage lowering | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L3419) | [`relax_stage`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L3419) | maps stage arguments into the canonical payload | public API | stage export tests |
| NCG direction policy | [`crates/fullmag-runner/src/relaxation/direct_minimizer.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/direct_minimizer.rs#L717) | [`nonlinear_cg_next_direction`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/direct_minimizer.rs#L717) | tangent transport, PR+, restart and descent recovery | shared/FDM policy | Rust unit tests |
| NCG line search | [`crates/fullmag-runner/src/relaxation/direct_minimizer.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/direct_minimizer.rs#L363) | [`nonlinear_cg_armijo_accepts`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/direct_minimizer.rs#L363) | Armijo acceptance predicate | shared/FDM policy | Rust unit tests |
| FDM reference loop | [`crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs#L1146) | [`execute_nonlinear_cg`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs#L1146) | cellwise NCG implementation | FDM CPU/reference | Rust unit tests |
| FDM CUDA loop | [`crates/fullmag-runner/src/fdm/gpu/cuda/direct_minimizer.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fdm/gpu/cuda/direct_minimizer.rs#L729) | [`execute_direct_minimizer`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fdm/gpu/cuda/direct_minimizer.rs#L729) | single-layer CUDA PG/NCG state, line search and metrics | FDM GPU | device-gated tests |
| FEM CPU step | [`backends/fem/cpu/mfem/relaxation/nonlinear_cg.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/relaxation/nonlinear_cg.cpp#L420) | [`run_nonlinear_cg_step`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/relaxation/nonlinear_cg.cpp#L420) | MFEM gradient, energy decision, recovery and state update | FEM CPU | native source contract tests |
| FEM GPU step | [`backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp#L1248) | [`gpu_relax_nonlinear_cg_step`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp#L1248) | device-resident reductions, direction, retraction and rollback | FEM GPU | native source contract tests |
