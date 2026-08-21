---
title: Spin Hall drift-diffusion transport
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-drift-diffusion-stt)=
# Spin Hall drift-diffusion transport

This family solves charge-coupled spin transport and optionally transfers absorbed transverse
spin angular momentum to magnetization. It is a coupled transport subsystem, not merely a local
torque coefficient.

(physics-drift-diffusion-spin-torque-problem-statement)=
## Physical problem

This page is the public physical and authoring contract for the interaction. It separates authored semantics, planner resolution, executable backend lanes, and scientific qualification.

(physics-drift-diffusion-spin-torque-governing-equations)=
## Governing equations

### Variables and constitutive convention

Fullmag uses charge potential $V$, full spin-channel splitting
$\boldsymbol\mu_s$, conventional current $\mathbf J_c$, and rank-two
charge-equivalent spin current $Q_{ia}$:

```{math}
:label: eq-public-drift-diffusion-spin-torque-dd-gradients
E_i=-\partial_iV,
\qquad
G_{ia}=-\frac12\partial_i\mu_{s,a}.
```

The one-way M1 model is

```{math}
:label: eq-public-drift-diffusion-spin-torque-dd-m1
J_{c,i}=\sigma E_i,
\qquad
Q_{ia}
=
\sigma_sG_{ia}
+
P\sigma E_i m_a
+
\theta_{\mathrm{SH}}\sigma\epsilon_{ika}E_k .
```

M1 omits inverse-SHE and reciprocal charge feedback. The reciprocal M2 model augments charge with
magnetoresistive, polarized, and inverse-SHE terms and solves one coupled block. For the public
parameterization, its dissipative longitudinal block must satisfy

```{math}
:label: eq-public-drift-diffusion-spin-torque-dd-schur
\min(\sigma_\parallel,\sigma_\perp)\sigma_s-P^2\sigma^2>0 .
```

Spin-flip, exchange-rotation, and dephasing reactions are

```{math}
:label: eq-public-drift-diffusion-spin-torque-dd-reactions
\begin{aligned}
\mathbf R_{\mathrm{sf}}&=\frac{\sigma_s}{2\lambda_{\mathrm{sf}}^2}\boldsymbol\mu_s,\\
\mathbf R_J&=\frac{\sigma_s}{2\lambda_J^2}(\boldsymbol\mu_s\times\mathbf m),\\
\mathbf R_\phi&=\frac{\sigma_s}{2\lambda_\phi^2}
\mathbf m\times(\boldsymbol\mu_s\times\mathbf m).
\end{aligned}
```

Only $\mathbf R_J+\mathbf R_\phi$ transfers angular momentum to magnetization:

```{math}
:label: eq-public-drift-diffusion-spin-torque-dd-torque
\mathbf T_{\mathrm{tr},G}
=
-\frac{\gamma_e}{M_s}\frac{\hbar}{2e}
(\mathbf R_J+\mathbf R_\phi).
```

(physics-drift-diffusion-spin-torque-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $V$ | charge electrochemical potential | $\mathrm V$ |
| $\boldsymbol\mu_s$ | spin-channel splitting | $\mathrm V$ |
| $E_i$ | electric field | $\mathrm{V\,m^{-1}}$ |
| $G_{ia}$ | negative half-gradient of spin voltage | $\mathrm{V\,m^{-1}}$ |
| $J_{c,i}$ | conventional charge current | $\mathrm{A\,m^{-2}}$ |
| $Q_{ia}$ | charge-equivalent spin-current tensor | $\mathrm{A\,m^{-2}}$ |
| $\sigma,\sigma_s,\sigma_\parallel,\sigma_\perp$ | conductivities | $\mathrm{S\,m^{-1}}$ |
| $\lambda_{\mathrm{sf}},\lambda_J,\lambda_\phi$ | diffusion/reaction lengths | $\mathrm m$ |
| $\mathbf R_{\mathrm{sf}},\mathbf R_J,\mathbf R_\phi$ | spin reaction densities | $\mathrm{A\,m^{-3}}$ |
| $\mathbf T_{\mathrm{tr},G}$ | transport Gilbert-source torque | $\mathrm{s^{-1}}$ |

(physics-drift-diffusion-spin-torque-discrete-realization)=
## Capability matrix

| Solver | Device | Authoring / IR | Executable realization | Scientific qualification | Exact boundary |
|---|---|---|---|---|---|
| FDM | CPU | M1/M2 authoring and canonical torque | reference executable subsets | bounded—not production-qualified | strict FP64 structured-grid reference |
| FDM | GPU | IR vocabulary | semantic-only | none | no qualified CUDA coupled solve/device-residency proof |
| FEM | CPU | M1 and constrained M2 | reference executable subsets | bounded conforming H1/P1 evidence | M2 uniform/full-domain restrictions apply |
| FEM | GPU | IR vocabulary | semantic-only | none | strict GPU requests fail closed |

The general `DriftDiffusionSpinTorque` capability remains partial/semantic despite bounded CPU
workflows. A single test fixture must not promote the entire parameter space.

(physics-drift-diffusion-spin-torque-python-api)=
## Python API and stage-first example

```python
# %% Study, execution lane, and magnetic body
import fullmag as fm

nm = 1.0e-9
study = fm.study("spin_transport_authoring_boundary")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

region = fm.RegionRef("film")
spin = fm.SpinDriftDiffusion(
    id="spin",
    current_source_id="charge",
    domain=(region,),
    materials=(fm.SpinTransportMaterialAssignment(
        region,
        fm.SpinTransportMaterial(
            sigma_s_Spm=5.0e6,
            polarization_p=0.2,
            theta_sh=0.1,
            lambda_sf_m=2.0e-9,
            lambda_j_m=1.0e-9,
            lambda_phi_m=1.0e-9,
        ),
    ),),
)
study.spin_transport(spin)
study.spin_torque(fm.DriftDiffusionSpinTorque("transport_torque", spin.id, region))
study.stages.add_run(stage_id="authoring_boundary", until=1.0e-15)
```

The following is a compact M1 FEM CPU construction. It demonstrates the complete stage-first
graph, not a production benchmark.

A real geometry must also provide complete boundary ownership. The planner must reject unassigned
faces when the selected default policy requires explicit coverage.

(physics-drift-diffusion-spin-torque-problem-ir)=
## ProblemIR

`SpinDriftDiffusion` lowers under `spin_transport_modules[]`; the torque consumer lowers under
`spin_torque_modules[]` with `kind="drift_diffusion_spin_torque"`, its `solve_id`, target, and
formula version. Requested coupling mode and requested execution must be preserved separately
from the resolved M1/M2 operator and actual runtime lane.

## Public API and duplicate-class hazard

The canonical exported `DriftDiffusionSpinTorque` comes from
`packages/fullmag-py/src/fullmag/model/spin_transport.py`. A second placeholder class with the same
name exists in `spin_torque.py` but is hidden by import order. Remove or rename the duplicate so
documentation, static analysis, and future imports cannot bind the wrong semantic type.

`SpinDriftDiffusion(mode="transient")` requires physical spin-capacitance metadata for every
material. Steady and transient modes must not share one unsupported default.

(physics-drift-diffusion-spin-torque-validation)=
## Validation and failure semantics

Validation owns positive finite conductivities and diffusion lengths, explicit disabling of absent
reactions, charge gauge, domain/material coverage, oriented interfaces, boundary ownership,
positive M2 Schur complement, compatible operator version, and strict execution target. Unsupported
mixing conductance, SML, specified flux, periodic spin, or reciprocal options must fail at the
documented lane boundary.

## Required numerical validation

- charge conservation and gauge invariance;
- spin-balance residual including all reaction terms;
- direct-SHE and inverse-SHE Onsager sign tests for M2;
- positivity/entropy-production tests;
- one-dimensional spin-diffusion analytic solutions;
- interface transparency and mixing-conductance limits;
- torque equals absorbed transverse angular momentum;
- mesh and nonlinear-iteration convergence;
- M1 recovered when reciprocal terms are disabled;
- independent FDM/FEM CPU comparisons before any GPU promotion.

(physics-drift-diffusion-spin-torque-scientific-bibliography)=
## Scientific bibliography

1. S. Zhang, P. M. Levy, and A. Fert, *Physical Review Letters* **88**, 236601 (2002),
   DOI: 10.1103/PhysRevLett.88.236601.
2. C. Abert et al., *Scientific Reports* **5**, 14855 (2015),
   DOI: 10.1038/srep14855.
3. C. Abert et al., *Scientific Reports* **6**, 16 (2016),
   DOI: 10.1038/s41598-016-0019-y.

(physics-drift-diffusion-spin-torque-source-code-index)=
## Source-code index

| Repository path | Stable symbol / area | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/current_transport.py` | `CurrentTransport` | charge solve and conservative current |
| `packages/fullmag-py/src/fullmag/model/spin_transport.py` | `SpinDriftDiffusion` | canonical spin solve |
| `packages/fullmag-py/src/fullmag/model/spin_transport.py` | `DriftDiffusionSpinTorque` | canonical torque consumer |
| `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `duplicate placeholder` | maintenance hazard to remove |
| `crates/fullmag-plan/src/spin_transport.rs` | `transport planning` | M1/M2 capability and validation |
| `crates/fullmag-runner/src` | `steady transport` | CPU reference realizations |
| `scripts/run_fullmag_m2_nf_reference.py` | `M2 reference workflow` | bounded executable evidence |

(physics-drift-diffusion-spin-torque-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(physics-drift-diffusion-spin-torque-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum, discretization, boundary, and capability limits stated on this page.

(physics-drift-diffusion-spin-torque-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.

(physics-drift-diffusion-spin-torque-limitations)=
## Limitations

Capabilities not listed as executable must fail closed. Source presence alone is not runtime or scientific qualification.
