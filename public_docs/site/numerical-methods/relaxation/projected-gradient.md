---
title: Projected Gradient
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
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
| $D_k$ | energy directional derivative | $\mathrm{J}$ |
| $c_1$ | Armijo sufficient-decrease constant | $1$ |
| $N$ | number of active cells or finite-element nodes | $1$ |

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
| FDM | CPU | source-backed | cellwise tangent projection, normalized retraction, energy-metric Armijo reference path |
| FDM | GPU | source-backed | CUDA direct-minimizer path; runtime/device qualification is separate |
| FEM | CPU | source-backed | MFEM nodal tangent gradient, lumped-mass products and native Armijo loop |
| FEM | GPU | source-backed | CUDA tangent-gradient, mass-metric reduction and device relaxation state |

FDM uses cell volumes and Cartesian fields. FEM uses finite-element node values and the selected
mass metric. These are different discrete inner products even though the continuum minimization
problem is shared.

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
