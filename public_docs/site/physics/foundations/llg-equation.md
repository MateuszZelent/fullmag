---
title: Landau–Lifshitz–Gilbert equation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
source_of_truth: packages/fullmag-py/src/fullmag/model/dynamics.py and backends/fem/cpu/mfem/integrators/llg_rhs.cpp
---

(public-docs-physics-foundations-llg-equation)=
(foundation-llg-problem-statement)=
# Landau–Lifshitz–Gilbert equation

Fullmag's dynamics object records gamma, integrator family, and timestep policy. The native
RHS consumes an already composed effective field. Pure damping disables precession rather
than substituting a large damping coefficient.

(foundation-llg-governing-equations)=
## Governing equations

```{math}
:label: eq-foundation-llg-gilbert
\frac{\mathrm{d}\mathbf{m}}{\mathrm{d}t}
=-\frac{\gamma_{\mu_0}}{1+\alpha^2}
\left[\mathbf{m}\times\mathbf{H}_{\mathrm{eff}}
+\alpha\,\mathbf{m}\times(\mathbf{m}\times\mathbf{H}_{\mathrm{eff}})\right].
```

```{math}
:label: eq-foundation-llg-pure-damping
\left.\frac{\mathrm{d}\mathbf{m}}{\mathrm{d}t}\right|_{\mathrm{damping}}
=-\frac{\gamma_{\mu_0}\alpha}{1+\alpha^2}
\mathbf{m}\times(\mathbf{m}\times\mathbf{H}_{\mathrm{eff}}).
```

```{math}
:label: eq-foundation-llg-normalization
\mathbf{m}_i\leftarrow\frac{\mathbf{m}_i}{|\mathbf{m}_i|}
\quad\text{when }|\mathbf{m}_i|>0.
```

Direct torque modules, when enabled, are added at their documented stage boundary and are
not folded into H_eff.

(foundation-llg-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $\mathbf{m}$ | reduced magnetization | $1$ |
| $\mathbf{H}_{\mathrm{eff}}$ | composed effective field | $\mathrm{A\,m^{-1}}$ |
| $\gamma_{\mu_0}$ | reduced gyromagnetic constant | $\mathrm{m\,(A\,s)^{-1}}$ |
| $\alpha$ | Gilbert damping parameter | $1$ |
| $\mathbf{m}_i$ | magnetization at discrete location i | $1$ |
| $t$ | physical time | $\mathrm{s}$ |
| $i$ | discrete location index | $1$ |

(foundation-llg-assumptions-and-validity)=
## Assumptions and validity

The equation uses reduced magnetization and the shared field convention. Native FEM accepts
uniform or per-node damping and gamma in m/(A s). Normalization leaves a zero vector
unchanged. Integrator truncation and precision are separate validity questions.

(foundation-llg-python-api)=
## Python API

The exact dynamics objects are in fullmag.model.dynamics.

```python
# %%
import fullmag as fm
from fullmag.model.dynamics import AdaptiveTimestep, LLG

study = fm.study("llg_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
dynamics = LLG(
    gamma=2.211e5,
    integrator="rk45",
    adaptive_timestep=AdaptiveTimestep(
        atol=1.0e-6,
        rtol=1.0e-3,
        dt_initial=1.0e-15,
        dt_min=1.0e-15,
        dt_max=1.0e-12,
    ),
)
dynamics_ir = dynamics.to_ir()
study.stages.add_relax(stage_id="equilibrium", dt=5.0e-13, max_steps=1)
```

| Python entry point | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| LLG.gamma | float | 2.211e5 | $\mathrm{m\,(A\,s)^{-1}}$ | finite and positive | reduced gyromagnetic constant | FDM/FEM CPU/GPU authoring; qualification is lane-specific | study.dynamics.gyromagnetic_ratio |
| LLG.integrator | str | auto | $1$ | one of heun, rk4, rk23, rk45, abm3, coupled_imex_ark2, auto or aliases | requested integration family | planner-gated per lane | study.dynamics.integrator |
| LLG.fixed_timestep | float | None | $\mathrm{s}$ | None or positive | fixed physical step | FDM/FEM lanes subject to planner policy | study.dynamics.fixed_timestep |
| LLG.adaptive_timestep | AdaptiveTimestep | None | $1$ | mutually exclusive with fixed_timestep | embedded-error policy | adaptive families only | study.dynamics.adaptive_timestep |
| AdaptiveTimestep.atol | float | 1e-6 | $1$ | non-negative; not both tolerances zero | absolute error tolerance | adaptive families only | study.dynamics.adaptive_timestep.atol |
| AdaptiveTimestep.rtol | float | 1e-3 | $1$ | non-negative; not both tolerances zero | relative error tolerance | adaptive families only | study.dynamics.adaptive_timestep.rtol |
| AdaptiveTimestep.dt_initial | float | None | $\mathrm{s}$ | None or positive and within bounds | first adaptive step | adaptive families only | study.dynamics.adaptive_timestep.dt_initial |
| AdaptiveTimestep.dt_min | float | 1e-15 | $\mathrm{s}$ | positive | minimum retry step | adaptive families only | study.dynamics.adaptive_timestep.dt_min |
| AdaptiveTimestep.dt_max | float | None | $\mathrm{s}$ | None or positive and at least dt_min | maximum adaptive step | adaptive families only | study.dynamics.adaptive_timestep.dt_max |
| FieldRefreshPolicy.demag_interval_s | float | None | $\mathrm{s}$ | None or positive | optional demag refresh cadence | lane-dependent | study.dynamics.field_refresh.demag_interval_s |

(foundation-llg-problem-ir)=
## ProblemIR

LLG.to_ir() is the normalization boundary. For gamma 2.211e5, integrator rk45, and fixed
timestep 1e-15, it produces the exact fragment
{"kind":"llg","gyromagnetic_ratio":221100.0,"integrator":"rk45","fixed_timestep":1e-15}.
The full ProblemIR adds geometry, materials, magnets, stages, and backend policy.

(foundation-llg-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent contains gamma, integrator, and fixed/adaptive controls. Resolved execution
contains accepted algorithm, precision, device, and step policy. Validation errors reject
unknown integrators, nonpositive steps, conflicting controls, and invalid adaptive bounds.
Unsupported combinations fail closed.

(foundation-llg-discrete-realization)=
## Discrete realization

| Lane | RHS and step realization | Status |
|---|---|---|
| FDM CPU | CPU cell-field integrator and adaptive controller | partial; qualification is separate |
| FDM GPU | CUDA RHS and device RK stages | partial; device evidence is required |
| FEM CPU | llg_rhs_aos plus CPU RK orchestration | partial; source is not parity proof |
| FEM GPU | fused CUDA RHS and CUDA RK orchestration | partial; precision evidence is required |

(foundation-llg-implementation-mapping)=
## Implementation mapping

LLG and adaptive policy classes own Python validation and IR. FEM CPU and FEM GPU kernels
implement the cross products and precession flag. FDM step decisions are separate code.

(foundation-llg-validation)=
## Validation

The source map checks Python classes and native kernel symbols. The example is parsed by the
public-example guard. Timestep convergence and executed CPU/GPU parity require separate
tests and runtime receipts.

(foundation-llg-limitations)=
## Limitations

This page does not claim qualification for every integrator on every lane and does not
define STT or SOT torque equations.

(foundation-llg-scientific-bibliography)=
## Scientific bibliography

1. L. D. Landau and E. M. Lifshitz, "On the theory of the dispersion of magnetic
   permeability in ferromagnetic bodies," *Phys. Z. Sowjetunion* 8, 153 (1935).
2. T. L. Gilbert, "A phenomenological theory of damping in ferromagnetic materials,"
   *IEEE Transactions on Magnetics* 40(6), 3443 (2004).
   [doi:10.1109/TMAG.2004.836740](https://doi.org/10.1109/TMAG.2004.836740).
3. C. Abert, "Micromagnetics and spintronics: models and numerical methods," *European
   Physical Journal B* 92, 120 (2019).
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

(foundation-llg-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence status |
|---|---|---|---|---|---|
| Python LLG | packages/fullmag-py/src/fullmag/model/dynamics.py | class LLG | validates dynamics and serializes IR | all authoring lanes | source-backed |
| adaptive policy | packages/fullmag-py/src/fullmag/model/dynamics.py | class AdaptiveTimestep | validates adaptive bounds | adaptive lanes | source-backed |
| refresh policy | packages/fullmag-py/src/fullmag/model/dynamics.py | class FieldRefreshPolicy | validates refresh cadence | lane-dependent | source-backed |
| FEM CPU RHS | backends/fem/cpu/mfem/integrators/llg_rhs.cpp | llg_rhs_aos | evaluates Gilbert RHS | FEM CPU | source-backed |
| FEM GPU RHS | backends/fem/gpu/cuda/integrators/llg/llg_rhs_kernels.cu | fullmag_cuda_llg_rhs_fused | evaluates fused RHS | FEM GPU | source-backed |

