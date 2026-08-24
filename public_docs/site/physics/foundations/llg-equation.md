---
title: Landau–Lifshitz–Gilbert equation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/llg_conventions.md
---

(public-docs-physics-foundations-llg-equation)=
# Landau–Lifshitz–Gilbert equation

(llg-foundation-problem-statement)=
<!-- (problem-statement)= -->
## Problem statement

FullMag evolves reduced magnetization $\mathbf m=\mathbf M/M_s$ with an explicit Gilbert-form
right-hand side. Field-form interactions and already-converted direct torques remain separate.

(llg-foundation-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations

```{math}
:label: eq-llg-full
\frac{\mathrm d\mathbf m}{\mathrm dt}=
-\frac{\gamma_{\mu_0}}{1+\alpha^2}
\left[\mathbf m\times\mathbf H_{\mathrm{eff}}+
\alpha\,\mathbf m\times(\mathbf m\times\mathbf H_{\mathrm{eff}})\right]
+\boldsymbol\tau_{\mathrm{direct}}.
```

The runtime flag `precession_enabled = false` removes the first cross-product term:

```{math}
:label: eq-llg-relaxation
\left.\frac{\mathrm d\mathbf m}{\mathrm dt}\right|_{\mathrm{pure\ damping}}=
-\frac{\gamma_{\mu_0}\alpha}{1+\alpha^2}
\mathbf m\times(\mathbf m\times\mathbf H_{\mathrm{eff}})
+\boldsymbol\tau_{\mathrm{direct}}.
```

This targets energy descent without precessional oscillation; discrete monotonicity is an
algorithm- and acceptance-policy-specific validation obligation. After every accepted explicit
step, magnetic degrees of freedom are normalized:

```{math}
:label: eq-llg-normalization
\mathbf m_i\leftarrow\frac{\mathbf m_i}{|\mathbf m_i|}.
```

The core explicit family includes Heun (order 2), classical RK4, Bogacki–Shampine RK23 (3(2)),
and Dormand–Prince RK45 (5(4)). Availability, fixed/adaptive use, precision, and multilayer support
are planner-dependent rather than universal consequences of the tableau existing.

(llg-foundation-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf m$ | reduced magnetization | $1$ |
| $\mathbf H_{\mathrm{eff}}$ | effective field | $\mathrm{A\,m^{-1}}$ |
| $\alpha$ | Gilbert damping | $1$ |
| $\gamma_{\mu_0}$ | reduced gyromagnetic constant | $\mathrm{m\,(A\,s)^{-1}}$ |
| $\boldsymbol\tau_{\mathrm{direct}}$ | direct RHS torque | $\mathrm{s^{-1}}$ |
| $t$ | physical time | $\mathrm{s}$ |

(llg-foundation-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity

- $M_s>0$ on magnetic degrees of freedom; non-magnetic airbox support contributes no magnetic RHS.
- $\gamma_{\mu_0}$ already includes $\mu_0$ and must not be replaced with the electron ratio in
  $\mathrm{rad\,(T\,s)^{-1}}$.
- Direct torques are post-conversion RHS terms in $\mathrm{s^{-1}}$.
- Rejected adaptive attempts do not commit state; failure at `dt_min` is typed and fail-closed.

(llg-foundation-python-api)=
<!-- (python-api)= -->
## Python API

```python
# %% LLG policy in a stage-first study
import fullmag as fm

nm = 1.0e-9
study = fm.study("llg-foundation")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.solver(
    integrator="rk45",
    adaptive_timestep=fm.AdaptiveTimestep(
        atol=1.0e-6, rtol=1.0e-3, dt_min=1.0e-15, dt_max=1.0e-12
    ),
    gamma=2.211e5,
)
study.stages.add_run(stage_id="run", until=1.0e-9)
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `LLG.gamma` | `float` | `221100.0` | $\mathrm{m\,(A\,s)^{-1}}$ | positive finite | reduced gyromagnetic constant | FDM/FEM CPU/GPU subject to planner capability | `study.dynamics.gyromagnetic_ratio` |
| `LLG.integrator` | `str` | `"auto"` | $1$ | supported canonical name or alias | requested time integrator | lane-dependent; planner checks combinations | `study.dynamics.integrator` |
| `LLG.fixed_timestep` | `float \| None` | `None` | $\mathrm{s}$ | positive and mutually exclusive with adaptive stepping | fixed physical timestep | lane-dependent | `study.dynamics.fixed_timestep` |
| `LLG.adaptive_timestep` | `AdaptiveTimestep \| None` | `None` | $1$ | requires an embedded-error integrator | adaptive attempt policy | lane-dependent | `study.dynamics.adaptive_timestep` |

(llg-foundation-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR

`study.dynamics` preserves the requested gyromagnetic ratio, integrator, fixed/adaptive policy,
and field-refresh policy. Stage intent remains separate. Planner/runtime provenance records the
resolved integrator, timestep mode, LLG mode, backend, device, and precision.

(llg-foundation-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics

Requested intent survives Python-to-IR lowering and script export. Resolved execution is
planner-owned. Validation errors reject invalid gamma, timestep, and adaptive combinations;
unsupported combinations fail without accepting a rejected step or silently selecting another
backend or integrator.

(llg-foundation-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization

| Solver | Device | Status | Qualification boundary |
|---|---|---|---|
| FDM | CPU | reference | FP64 explicit-step oracle and norm/error contracts |
| FDM | GPU | implemented | explicit CUDA paths subject to integrator/device qualification |
| FEM | CPU | implemented | native MFEM explicit RHS and tableaus |
| FEM | GPU | implemented | same native contract; executed-device evidence is required |

(llg-foundation-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping

`LLG` owns public validation/lowering. FDM and native FEM modules own the explicit Gilbert RHS;
native tableau dispatch owns Heun/RK4/RK23/RK45 selection without a silent fallback.

(llg-foundation-validation)=
<!-- (validation)= -->
## Validation

Validate macrospin precession, damping sign, norm preservation, direct-torque units, tableau order,
fixed/adaptive acceptance and rollback, `dt_min` exhaustion, and executed CPU/GPU parity.

(llg-foundation-limitations)=
<!-- (limitations)= -->
## Limitations

Representability of an integrator does not make it executable on every solver/device or multilayer
path. Planner capabilities and lane-specific qualification remain authoritative.

(llg-foundation-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography

1. L. D. Landau and E. M. Lifshitz, "On the theory of the dispersion of magnetic permeability in
   ferromagnetic bodies," *Phys. Z. Sowjetunion* **8**, 153 (1935).
2. T. L. Gilbert, "A phenomenological theory of damping in ferromagnetic materials," *IEEE
   Transactions on Magnetics* **40**, 3443 (2004).
   [doi:10.1109/TMAG.2004.836740](https://doi.org/10.1109/TMAG.2004.836740).
3. C. Abert, "Micromagnetics and spintronics: models and numerical methods," *European Physical
   Journal B* **92**, 120 (2019).
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

(llg-foundation-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Public dynamics policy | `packages/fullmag-py/src/fullmag/model/dynamics.py` | `class LLG` | validation and lowering | Python API tests |
| FDM explicit Gilbert RHS | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `llg_rhs_from_field` | field-to-RHS conversion | FDM integrator tests |
| Native FEM explicit Gilbert RHS | `backends/fem/cpu/mfem/integrators/llg_rhs.cpp` | `llg_rhs_aos` | field/direct-torque RHS and precession flag | native LLG contract tests |
| Native explicit tableau selection | `backends/fem/cpu/mfem/integrators/rk_explicit.cpp` | `tableau_for_integrator` | resolves Heun/RK4/RK23/RK45 tableaus | native integrator tests |
