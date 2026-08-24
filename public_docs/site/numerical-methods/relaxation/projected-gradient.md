---
title: Projected Gradient
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0500-fdm-relaxation-algorithms.md, docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md
---

(public-docs-numerical-methods-relaxation-projected-gradient)=
# Projected gradient with Barzilai–Borwein steps

(numerical-methods-relaxation-pgbb-problem-statement)=
## Physical and numerical problem

`projected_gradient_bb` minimizes the discrete micromagnetic energy on the product manifold
$(\mathbb S^2)^N$. It is a direct minimizer: it has no physical time, LLG integrator, or damping
override. Every trial magnetization is retracted to the unit sphere, and an Armijo line search
accepts only a sufficient energy decrease.

(numerical-methods-relaxation-pgbb-governing-equations)=
## Governing equations

The effective-field tangent gradient and residual are

```{math}
:label: eq-pgbb-tangent-gradient
\mathbf g_i=-\left[\mathbf H_{\mathrm{eff},i}
-\left(\mathbf m_i\cdot\mathbf H_{\mathrm{eff},i}\right)\mathbf m_i\right],
\qquad
\boldsymbol\tau_i=\mathbf m_i\times\mathbf H_{\mathrm{eff},i}.
```

The normalized retraction is

```{math}
:label: eq-pgbb-retraction
\mathcal R_{\mathbf m_i}(\lambda\mathbf p_i)
=\frac{\mathbf m_i+\lambda\mathbf p_i}
{\lVert\mathbf m_i+\lambda\mathbf p_i\rVert_2}.
```

Let $\mathbf s_k=\mathbf m_k-\mathbf m_{k-1}$ and
$\mathbf y_k=\mathbf g_k-\mathbf g_{k-1}$. The implementation alternates BB1 and BB2 step
selection, then bounds and backtracks the candidate:

```{math}
:label: eq-pgbb-step-selection
\lambda_{k}^{\mathrm{BB1}}
=\frac{\langle\mathbf s_k,\mathbf s_k\rangle_E}
{\langle\mathbf s_k,\mathbf y_k\rangle_E},
\qquad
\lambda_{k}^{\mathrm{BB2}}
=\frac{\langle\mathbf s_k,\mathbf y_k\rangle_E}
{\langle\mathbf y_k,\mathbf y_k\rangle_E}.
```

The weighted product $\langle\cdot,\cdot\rangle_E$ is the energy metric of the selected
discretization. The Armijo acceptance condition is

```{math}
:label: eq-pgbb-armijo
E(\mathbf m_{k+1})
\leq E(\mathbf m_k)+c_1\lambda_kD_k,
\qquad D_k<0,
\qquad c_1=10^{-4}.
```

The direct minimizer stops only after the accepted state satisfies the canonical torque criterion;
an energy decrease by itself is not convergence.

The implementation policy is exact and bounded. The initial step is
$\lambda_0=10^{-6}\ \mathrm{m\,A^{-1}}$. After an accepted step, `use_bb1=true` computes BB1
when $\langle s,y\rangle_E$ is finite and positive; the next accepted update toggles to BB2.
BB2 is $\langle s,y\rangle_E/\langle y,y\rangle_E$ when both denominators are finite and
positive. Every accepted BB value is clamped to
$[10^{-15},10^{-3}]\ \mathrm{m\,A^{-1}}$. If the selected curvature is invalid, the fallback is
$10^{-6}/(r+1)$ clamped to the same interval, where $r$ is the consecutive fallback count. The
source contains a defensive BB2 branch in the BB1 arm, but its repeated positive-curvature guard
means it is unreachable when the first BB1 guard is false; the observable policy is BB1/BB2
alternation with the fallback above. A trial is retracted as $\mathcal R_m(-\lambda g)$, its field
and energy are recomputed, and $\lambda$ is halved after each rejection. At most 20 backtracks
are attempted; exhaustion leaves the accepted state unchanged.

(numerical-methods-relaxation-pgbb-iteration)=
## One projected-gradient iteration

The reference/shared loop performs these operations in order:

1. Evaluate $\mathbf H_{\mathrm{eff}}(\mathbf m_k)$, the tangent gradient $\mathbf g_k$, the
   current energy and the maximum accepted-state torque. A torque threshold hit can terminate
   before an accepted minimizer step is attempted.
2. Set $D_k=-\langle\mathbf g_k,\mathbf g_k\rangle_E$. A non-finite or negative metric product
   is a numerical error; an exactly zero product is numerical stagnation.
3. Retract $\mathcal R_{\mathbf m}(-\lambda\mathbf g_k)$ and evaluate its full energy. Accept it
   only when the Armijo inequality is true. Rejected trials halve $\lambda$; after 20 rejections
   the accepted state and its field remain unchanged.
4. On acceptance, evaluate the trial field and gradient, form $\mathbf s_k$ and $\mathbf y_k$,
   update alternating BB1/BB2, then commit the trial state and increment the accepted-step
   counter. The BB value is not a user-visible timestep.
5. Record accepted energy and torque in the shared completion controller. A successful Armijo
   step is not itself convergence.

Native FEM additionally retains direct-energy difference and roundoff-proof telemetry for the
accepted Armijo inequality. That proof instrumentation does not change the public stop rule, but
it is required evidence when qualifying CPU/GPU parity.

(numerical-methods-relaxation-pgbb-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf m_i$ | reduced magnetization at active cell/node $i$ | $1$ |
| $\mathbf H_{\mathrm{eff},i}$ | effective magnetic field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf g_i$ | tangent-space energy gradient | $\mathrm{A\,m^{-1}}$ |
| $\boldsymbol\tau_i$ | torque residual | $\mathrm{A\,m^{-1}}$ |
| $E$ | total micromagnetic energy | $\mathrm{J}$ |
| $\mathbf s_k$ | magnetization difference | $1$ |
| $\mathbf y_k$ | gradient difference | $\mathrm{A\,m^{-1}}$ |
| $\mathbf p_i$ | tangent search direction | $\mathrm{A\,m^{-1}}$ |
| $\lambda_k$ | minimizer step size | $\mathrm{m\,A^{-1}}$ |
| $\mathcal R_{\mathbf m_i}$ | sphere retraction | $1$ |
| $D_k$ | energy directional derivative with respect to $\lambda$ | $\mathrm{J\,A\,m^{-1}}$ |
| $c_1$ | Armijo sufficient-decrease constant | $1$ |
| $N$ | number of active cells or finite-element nodes | $1$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $M_{s,i}$ | local saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $V_i$ | cell or nodal volume weight | $\mathrm{m^3}$ |
| $a_i$ | first vector in the energy metric | $\mathrm{A\,m^{-1}}$ |
| $b_i$ | second vector in the energy metric | $\mathrm{A\,m^{-1}}$ |

The energy metric used by the FDM/shared policy is

```{math}
:label: eq-pgbb-energy-metric
\langle a,b\rangle_E
=\sum_i \mu_0 M_{s,i}V_i\,a_i\cdot b_i,
\qquad
[\langle a,b\rangle_E]
=\mathrm{J\,A^{-1}}[a][b].
```

The weight $\mu_0M_{s,i}V_i$ has units $\mathrm{J\,A^{-1}}$. Therefore
$\langle g,p\rangle_E$ has units $\mathrm{J\,A\,m^{-1}}$ when both operands are fields in
$\mathrm{A\,m^{-1}}$, while $\langle s,s\rangle_E$ has units $\mathrm{J\,A^{-1}}$ because
$s$ is dimensionless. This is why $\lambda$ has units $\mathrm{m\,A^{-1}}$ and why
$\lambda D_k$ is an energy. Treating the metric as joules for every operand type is dimensionally
incorrect.

For FEM, $V_i$ is replaced by the backend's mass/lumped-mass realization; the public equation is
the same metric contract, but assembled weights and node ownership are backend-specific.

(numerical-methods-relaxation-pgbb-assumptions-and-validity)=
## Assumptions and validity

- The input magnetization is normalized before the first field evaluation.
- The normalization retraction is first-order; it is not a Cayley rotation and does not establish
  a global error bound by itself.
- BB curvature denominators are guarded. Invalid or non-positive curvature falls back to a bounded
  step; it is not silently accepted as a valid curvature estimate.
- Armijo backtracking is the acceptance contract. A trial that fails the line search must leave the
  accepted state unchanged.
- The stopping torque is evaluated on the accepted effective field. Trial-field diagnostics do not
  replace the accepted-state residual.
- `solver`, `dt`, `max_err`, `dt_min`, `dt_max`, `dt_initial`, `adaptive_timestep`, and
  `relax_alpha` are invalid for this algorithm and must be rejected.

(numerical-methods-relaxation-pgbb-python-api)=
## Python API

```python
# %% Configure a direct FEM minimization stage
import fullmag as fm

nm = 1.0e-9
study = fm.study("projected_gradient_bb_relaxation")
study.engine("fem")
study.device("auto", precision="double")
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
    algorithm="projected_gradient_bb",
    tolT=1.0e-6,
    max_steps=50_000,
)
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `StudyStagesBuilder.add_relax(algorithm="projected_gradient_bb")` | `str` | required for this page | $1$ | supported algorithm identifier | selects BB projected minimizer | FDM reference; FEM CPU/GPU native lanes | `study.algorithm` |
| `StudyStagesBuilder.add_relax(tolT=...)` | `float` | $10^{-6}$ | $\mathrm{T}$ | finite and positive; exclusive with `tolA` | requested torque threshold | FDM/FEM lanes | `study.stop.torque_tolerance_apm` |
| `StudyStagesBuilder.add_relax(tolA=...)` | `float` | canonical default equivalent | $\mathrm{A\,m^{-1}}$ | finite and positive; exclusive with `tolT` | field-residual threshold | FDM/FEM lanes | `study.stop.torque_tolerance_apm` |
| `StudyStagesBuilder.add_relax(max_steps=...)` | `int` | $50,000$ | $1$ | positive integer | iteration budget | FDM/FEM lanes | `study.stop.max_steps` |
| `RelaxStop.energy_tolerance_j` | `float \| None` | `None` | $\mathrm{J}$ | positive when configured | optional energy plateau criterion | FDM/FEM lanes | `study.stop.energy_tolerance_j` |
| `StudyStagesBuilder.add_relax(tol=...)` | legacy object | unavailable | legacy | always rejected | removed tolerance spelling | none | none |
| `StudyStagesBuilder.add_relax(energy_tolerance=...)` | `float \| None` | `None` | $\mathrm{J}$ | positive when set | accepted-energy plateau threshold | FDM/FEM lanes | `study.stop.energy_tolerance_j` |
| `StudyStagesBuilder.add_relax(max_relaxation_time_s=...)` | `float \| None` | `None` | $\mathrm{s}$ | rejected for direct minimizers | LLG-only relaxation-time ceiling | none | none |
| `StudyStagesBuilder.add_relax(max_pseudotime_s=...)` | `float \| None` | `None` | $\mathrm{s}$ | rejected for direct minimizers | alias of LLG-only time ceiling | none | none |
| `StudyStagesBuilder.add_relax(max_physical_time_s=...)` | `float \| None` | `None` | $\mathrm{s}$ | rejected for direct minimizers | alias of LLG-only time ceiling | none | none |
| `StudyStagesBuilder.add_relax(relax_alpha=...)` | `float \| None` | `None` | $1$ | rejected for direct minimizers | LLG damping override | none | none |
| `StudyStagesBuilder.add_relax(solver=...)` | `str \| None` | `None` | $1$ | rejected for direct minimizers | LLG integrator selector | none | none |
| `StudyStagesBuilder.add_relax(dt=...)` | positive float, `"auto"`, or `None` | `None` | $\mathrm{s}$ | rejected for direct minimizers | LLG timestep | none | none |
| `StudyStagesBuilder.add_relax(max_error=...)` | `float \| None` | `None` | $1$ | rejected for direct minimizers | LLG adaptive error alias | none | none |
| `StudyStagesBuilder.add_relax(max_err=...)` | `float \| None` | `None` | $1$ | rejected for direct minimizers | LLG adaptive error | none | none |
| `StudyStagesBuilder.add_relax(dt_min=...)` | `float \| None` | `None` | $\mathrm{s}$ | rejected for direct minimizers | LLG lower step bound | none | none |
| `StudyStagesBuilder.add_relax(dt_max=...)` | `float \| None` | `None` | $\mathrm{s}$ | rejected for direct minimizers | LLG upper step bound | none | none |
| `StudyStagesBuilder.add_relax(dt_initial=...)` | `float \| None` | `None` | $\mathrm{s}$ | rejected for direct minimizers | LLG initial step | none | none |
| `StudyStagesBuilder.add_relax(adaptive_timestep=...)` | `AdaptiveTimestep \| None` | `None` | mixed | rejected for direct minimizers | LLG adaptive policy | none | none |
| `StudyStagesBuilder.add_relax(field_refresh=...)` | `FieldRefreshPolicy \| None` | `None` | mixed | rejected for direct minimizers | LLG field cadence | none | none |
| `StudyStagesBuilder.add_relax(stop=...)` | `RelaxStop \| None` | `None` | mixed | grouped stop; scalar conflicts rejected | canonical stop object | FDM/FEM lanes | `study.stop` |

No public parameter controls $c_1$, the BB bounds, or the maximum number of Armijo backtracks yet;
those are implementation policy constants and must not be presented as user controls.

(numerical-methods-relaxation-pgbb-problem-ir)=
## ProblemIR

The stage lowers to a relaxation study without a `dynamics` object:

```json
{
  "kind": "relaxation",
  "algorithm": "projected_gradient_bb",
  "stop": {
    "torque_tolerance_apm": 0.7957747154594767,
    "max_steps": 50000
  }
}
```

The absence of `dynamics` is semantic: a direct minimizer has no RK solver or physical time. The
planner adds the resolved FDM/FEM execution lane, precision, field realization, and provenance
outside this shared study payload.

`sampling.outputs` is present even when it is empty. If output or table autosave is configured,
those entries are serialized under `sampling`; they do not turn a direct minimizer into a
physical-time stage. The resolved runtime publishes `accepted_step_m_per_A`, `time=0`, `dt=0`,
`pseudo_time_s=null`, torque in A/m and T, and final energy/plateau metrics.

(numerical-methods-relaxation-pgbb-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Script export preserves the algorithm and stop fields in `study.stages.add_relax(...)`. Validation errors
include an unknown algorithm, non-positive thresholds, non-positive `max_steps`, a legacy
`tol`, simultaneous `tolT` and `tolA`, and any LLG timestep/dynamics control. Unsupported combinations
must fail closed: selecting FEM GPU without a resolved executable capability cannot silently fall back
to FEM CPU or `llg_overdamped`. Requested intent is stored separately from resolved execution.

(numerical-methods-relaxation-pgbb-discrete-realization)=
## Discrete realization

| Solver | Device | Status | Realization and evidence boundary |
|---|---|---|---|
| FDM | CPU | reference-executable | cellwise tangent projection, normalized retraction, energy-metric Armijo reference path |
| FDM | GPU | development-executable | CUDA direct-minimizer path; multilayer FDM requests remain unsupported |
| FEM | CPU | development-executable | MFEM nodal tangent gradient, lumped-mass products and native Armijo loop |
| FEM | GPU | development-executable | CUDA tangent-gradient, mass-metric reduction and device relaxation state |

FDM uses cell volumes and Cartesian fields. FEM uses finite-element node values and the selected
mass metric. These are different discrete inner products even though the continuum minimization
problem is shared.

FDM CPU uses the reference SoA/AoS grid loop. FDM GPU has a native CUDA direct-minimizer loop, but
the public multilayer planner currently rejects direct minimizers with the explicit policy that
only `llg_overdamped` is supported for that multilayer runner. FEM CPU owns MFEM vectors and native
energy/field evaluation; FEM GPU owns device-resident state and reduction workspaces. Source
presence is not executed-device qualification.

(numerical-methods-relaxation-pgbb-implementation-mapping)=
## Implementation mapping

The Python objects and stage lowering are shared. The FDM reference implementation owns the
cellwise direct-minimizer loop. Native FEM CPU and GPU have separate operator and residency owners;
the CPU implementation is not a proof of GPU execution or parity.

(numerical-methods-relaxation-pgbb-validation)=
## Validation

The minimum validation set checks tangent orthogonality, normalized retraction, BB1/BB2 selection,
Armijo rejection and rollback, monotone accepted energy within the documented numerical budget,
accepted-state torque completion, and stage-to-IR round-trip. Native FEM CPU/GPU qualification must
also report mesh, precision, field-solve policy, executed device, and artifact identity.

(numerical-methods-relaxation-pgbb-limitations)=
## Limitations

The method is a local minimizer and may terminate at a metastable state. The public API does not
promise a fixed iteration count, identical trajectories across discretizations, or universal GPU
qualification. It has no physical-time interpretation.

(numerical-methods-relaxation-pgbb-scientific-bibliography)=
## Scientific bibliography

- J. Barzilai and J. M. Borwein, “Two-point step size gradient methods,” *IMA Journal of Numerical Analysis* 8 (1988), DOI: [10.1093/imanum/8.1.141](https://doi.org/10.1093/imanum/8.1.141).
- J. Nocedal and S. J. Wright, *Numerical Optimization*, 2nd ed., Springer, 2006, DOI: [10.1007/978-0-387-40065-5](https://doi.org/10.1007/978-0-387-40065-5).
- Fullmag: [`0500-fdm-relaxation-algorithms.md`](https://github.com/MateuszZelent/fullmag/blob/master/docs/physics/0500-fdm-relaxation-algorithms.md) and [`0510-fem-relaxation-algorithms-mfem-gpu.md`](https://github.com/MateuszZelent/fullmag/blob/master/docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md).

(numerical-methods-relaxation-pgbb-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Public algorithm vocabulary | `packages/fullmag-py/src/fullmag/model/study.py` | `class Relaxation` | validates direct-minimizer selection and forbids dynamics | public API | Python contract tests |
| Stage lowering | `packages/fullmag-py/src/fullmag/world.py` | `relax_stage` | captures direct-minimizer stage | public API | stage export tests |
| FDM BB loop | `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs` | `execute_projected_gradient_bb` | reference cellwise BB/Armijo implementation | FDM CPU/reference | Rust unit tests |
| FEM CPU BB loop | `backends/fem/cpu/mfem/relaxation/projected_gradient_bb.cpp` | `run_projected_gradient_bb_step` | native FEM tangent/Armijo step | FEM CPU | source contract tests |
| FEM GPU BB loop | `backends/fem/gpu/cuda/relaxation/pgbb.cpp` | `gpu_relax_projected_gradient_bb_step` | device-resident FEM BB step | FEM GPU | source contract tests |
| Shared metric and BB policy | `crates/fullmag-runner/src/relaxation/direct_minimizer.rs` | `energy_metric_dot` / `projected_gradient_step_size_update` | weighted products, bounds and fallback | FDM CPU/GPU shared policy | Rust unit tests |
| Shared line search | `crates/fullmag-runner/src/relaxation/direct_minimizer.rs` | `projected_gradient_line_search` | normalized trial, Armijo and 20-backtrack limit | FDM CPU/GPU shared policy | Rust unit tests |
| FDM CUDA loop | `crates/fullmag-runner/src/fdm/gpu/cuda/direct_minimizer.rs` | `execute_direct_minimizer` | native CUDA PG/NCG dispatch | FDM GPU | device-gated tests |
| Completion policy | `crates/fullmag-runner/src/relaxation/convergence.rs` | `resolve_stage_completion` | torque confirmation, energy plateau and budget reasons | shared orchestration | runner tests |
