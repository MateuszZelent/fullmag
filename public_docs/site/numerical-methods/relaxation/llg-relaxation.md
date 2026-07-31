---
title: LLG Relaxation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
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

For reduced magnetization $mathbf m=mathbf M/M_s$ and effective field
$mathbf H_{mathrm{eff}}$, the implemented pure-damping equation is

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

The time integrator can be fixed-step or adaptive embedded RK23/RK45. The adaptive error policy
is distinct from the physical torque criterion: the local vector error controls step acceptance,
while $	au_{\max}$ controls relaxation completion.

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
| $\varepsilon_\tau$ | torque stopping threshold | $\mathrm{A\,m^{-1}}$ or $\mathrm{T}$ before canonical conversion |
| $\Delta t$ | attempted integration step | $\mathrm{s}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |

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

(numerical-methods-relaxation-llg-python-api)=
## Python API

This is the repository-owned stage pattern. `study.solver(...)` is the canonical solver-policy
facade for a time-evolution stage; the relaxation stage exposes its own explicit LLG policy so
that the relaxation request is serialized with the stage that consumes it.

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
| `StudyStagesBuilder.add_relax(solver=...)` | `str \| None` | `None` → `rk23` | $1$ | `rk23` or `rk45` for adaptive policy | selects LLG integrator | FEM/FDM lane-dependent | `study.dynamics.integrator` |
| `StudyStagesBuilder.add_relax(dt_initial=...)` | `float \| None` | `None` | $\mathrm{s}$ | positive; requires `max_err`, `dt_min`, `dt_max` in executable adaptive stage | first adaptive step | RK23/RK45 lanes | `study.dynamics.adaptive_timestep.dt_initial` |
| `StudyStagesBuilder.add_relax(dt_min=...)` | `float \| None` | required for executable adaptive stage | $\mathrm{s}$ | positive and not fixed-step | adaptive lower bound | RK23/RK45 lanes | `study.dynamics.adaptive_timestep.dt_min` |
| `StudyStagesBuilder.add_relax(dt_max=...)` | `float \| None` | required for executable adaptive stage | $\mathrm{s}$ | positive and above `dt_min` | adaptive upper bound | RK23/RK45 lanes | `study.dynamics.adaptive_timestep.dt_max` |
| `StudyStagesBuilder.add_relax(max_err=...)` | `float \| None` | `None` | $1$ | positive; adaptive RK only | absolute embedded vector-error limit | RK23/RK45 lanes | `study.dynamics.adaptive_timestep.atol` with max-error intent preserved |
| `StudyStagesBuilder.add_relax(tolT=...)` | `float` | $10^{-6}$ | $\mathrm{T}$ | finite and positive; mutually exclusive with `tolA` | user torque threshold | FEM/FDM relaxation lanes | `study.stop.torque_tolerance_apm` after conversion |
| `StudyStagesBuilder.add_relax(tolA=...)` | `float` | canonical default equivalent | $\mathrm{A\,m^{-1}}$ | finite and positive; mutually exclusive with `tolT` | field-residual threshold | FEM/FDM relaxation lanes | `study.stop.torque_tolerance_apm` |
| `StudyStagesBuilder.add_relax(max_steps=...)` | `int` | $50,000$ | $1$ | positive integer | hard iteration budget | FEM/FDM relaxation lanes | `study.stop.max_steps` |
| `StudyStagesBuilder.add_relax(relax_alpha=...)` | `float \| None` | $1$ for overdamped LLG | $1$ | only `llg_overdamped`; `None` keeps material damping | stage-local damping override | FEM/FDM LLG relaxation | resolved LLG/material provenance |

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
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Stop defaults and validation | `packages/fullmag-py/src/fullmag/model/study.py` | `class RelaxStop` | canonical torque/energy/step stop contract | public API | Python contract tests |
| Algorithm and IR validation | `packages/fullmag-py/src/fullmag/model/study.py` | `class Relaxation` | supported algorithms and serialized relaxation payload | public API | Python contract tests |
| Stage lowering | `packages/fullmag-py/src/fullmag/world.py` | `relax_stage` | maps stage arguments into `RelaxStageSpec` | public API | stage export tests |
| FDM direct minimizer reference | `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs` | `execute_projected_gradient_bb` | FDM reference BB relaxation | FDM CPU/reference | Rust unit tests |
| FDM direct minimizer reference | `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs` | `execute_nonlinear_cg` | FDM reference NCG relaxation | FDM CPU/reference | Rust unit tests |
| FEM CPU pure-damping selection | `crates/fullmag-runner/src/relaxation/convergence.rs` | `llg_overdamped_uses_pure_damping` | selects precession-disabled relaxation mode | FEM/FDM orchestration | runner tests |
